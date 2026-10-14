import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const policyDirectory = resolve(here, "../../policies");
const indexPath = resolve(process.env.RAG_INDEX_PATH || join(here, "../../.resolveai/policy-vectors.json"));
const modelName = process.env.RAG_EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2";
const canLoadTransformers = () => { try { const require = createRequire(import.meta.url); require.resolve("@huggingface/transformers"); require.resolve("onnxruntime-node"); return true; } catch { return false; } };
const chunkSize = Math.max(200, Number(process.env.RAG_CHUNK_SIZE || 480));
const chunkOverlap = Math.max(0, Math.min(chunkSize - 1, Number(process.env.RAG_CHUNK_OVERLAP || 80)));

export interface PolicyDocument { id: string; title: string; category: string; version: string; effectiveDate: string; status: "active" | "superseded"; synthetic: true; source: string; body: string; }
export interface PolicyChunk { id: string; policyId: string; title: string; category: string; version: string; effectiveDate: string; source: string; section: string; text: string; contentHash: string; }
interface VectorRecord { chunk: PolicyChunk; vector: number[] }
interface VectorIndex { schemaVersion: 1; model: string; corpusHash: string; dimensions: number; createdAt: string; records: VectorRecord[] }
type Extractor = (text: string, options: { pooling: "mean"; normalize: true }) => Promise<{ tolist(): number[][] }>;
type PipelineModule = { pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<Extractor> };

let loadedIndex: VectorIndex | undefined;
let extractorPromise: Promise<Extractor> | undefined;
let lastError: string | undefined;
let retrievalMode: "unindexed" | "semantic" | "keyword_fallback" = "unindexed";

function hash(text: string) { return createHash("sha256").update(text).digest("hex"); }
function parseDocument(source: string, raw: string): PolicyDocument {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error(`${source}: expected a YAML-style frontmatter block.`);
  const meta = Object.fromEntries(match[1].split(/\r?\n/).map(line => {
    const split = line.indexOf(":");
    if (split < 1) throw new Error(`${source}: invalid frontmatter line.`);
    return [line.slice(0, split).trim(), line.slice(split + 1).trim()];
  })) as Record<string, string>;
  const body = match[2].trim();
  const id = meta.id || ""; const version = meta.version || ""; const effectiveDate = meta.effectiveDate || "";
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) throw new Error(`${source}: id must contain lowercase letters, numbers, and dashes.`);
  if (!meta.title || !meta.category || !/^\d+\.\d+$/.test(version) || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) throw new Error(`${source}: title, category, version, or effectiveDate is invalid.`);
  if (!["active", "superseded"].includes(meta.status)) throw new Error(`${source}: status must be active or superseded.`);
  if (meta.synthetic !== "true") throw new Error(`${source}: policy must be explicitly marked synthetic: true.`);
  if (!body || body.length > 50_000) throw new Error(`${source}: policy text must be between 1 and 50000 characters.`);
  return { id, title: meta.title, category: meta.category, version, effectiveDate, status: meta.status as PolicyDocument["status"], synthetic: true, source, body };
}

export function loadPolicyDocuments(): PolicyDocument[] {
  if (!existsSync(policyDirectory)) throw new Error(`Policy directory does not exist: ${policyDirectory}`);
  const documents = readdirSync(policyDirectory).filter(name => name.toLowerCase().endsWith(".md")).sort().map(source => parseDocument(source, readFileSync(join(policyDirectory, source), "utf8")));
  const ids = new Set<string>();
  for (const doc of documents) {
    const key = `${doc.id}@${doc.version}`;
    if (ids.has(key)) throw new Error(`Duplicate policy version ${key}.`);
    ids.add(key);
  }
  return documents;
}

export function activePolicyDocuments(documents = loadPolicyDocuments()): PolicyDocument[] {
  const latest = new Map<string, PolicyDocument>();
  for (const doc of documents) {
    const existing = latest.get(doc.id);
    if (!existing || doc.effectiveDate > existing.effectiveDate || (doc.effectiveDate === existing.effectiveDate && Number(doc.version) > Number(existing.version))) latest.set(doc.id, doc);
  }
  return [...latest.values()].filter(doc => doc.status === "active");
}

export function chunkPolicy(doc: PolicyDocument): PolicyChunk[] {
  const sections: { title: string; text: string[] }[] = [];
  let current = { title: "Policy", text: [] as string[] };
  for (const rawLine of doc.body.split(/\r?\n/)) {
    const heading = rawLine.match(/^#{1,3}\s+(.+)$/);
    if (heading) { if (current.text.length) sections.push(current); current = { title: heading[1].trim(), text: [] }; }
    else if (rawLine.trim()) current.text.push(rawLine.trim());
  }
  if (current.text.length) sections.push(current);
  const dedupe = new Set<string>();
  const chunks: PolicyChunk[] = [];
  for (const section of sections) {
    const text = section.text.join(" ").replace(/\s+/g, " "); let start = 0;
    while (start < text.length) {
      let end = Math.min(text.length, start + chunkSize);
      if (end < text.length) { const boundary = text.lastIndexOf(" ", end); if (boundary > start + chunkSize * 0.65) end = boundary; }
      const excerpt = text.slice(start, end).trim(); const contentHash = hash(excerpt);
      if (!dedupe.has(contentHash)) {
        dedupe.add(contentHash);
        chunks.push({ id: `${doc.id}@${doc.version}#${chunks.length + 1}`, policyId: doc.id, title: doc.title, category: doc.category, version: doc.version, effectiveDate: doc.effectiveDate, source: doc.source, section: section.title, text: excerpt, contentHash });
      }
      if (end === text.length) break;
      start = Math.max(start + 1, end - chunkOverlap);
    }
  }
  return chunks;
}

function corpus() {
  const docs = activePolicyDocuments();
  const chunks = docs.flatMap(chunkPolicy);
  return { docs, chunks, digest: hash(JSON.stringify(chunks.map(({ id, contentHash }) => [id, contentHash]))) };
}

async function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) extractorPromise = (async () => {
    const moduleName = "@huggingface/transformers";
    const library = await import(moduleName) as PipelineModule;
    return library.pipeline("feature-extraction", modelName, { dtype: "q8" });
  })().catch(error => { extractorPromise = undefined; throw error; });
  return extractorPromise;
}

export async function embedText(text: string): Promise<number[]> {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  const vector = output.tolist()[0];
  if (!vector?.length || vector.some(value => !Number.isFinite(value))) throw new Error("Embedding model returned an invalid vector.");
  return vector;
}

export async function buildPolicyIndex() {
  const { chunks, digest } = corpus();
  const records: VectorRecord[] = [];
  for (let i = 0; i < chunks.length; i++) {
    records.push({ chunk: chunks[i], vector: await embedText(chunks[i].text) });
    if ((i + 1) % 10 === 0) console.info(`[rag.index] embedded ${i + 1}/${chunks.length} chunks`);
  }
  const index: VectorIndex = { schemaVersion: 1, model: modelName, corpusHash: digest, dimensions: records[0]?.vector.length || 0, createdAt: new Date().toISOString(), records };
  mkdirSync(dirname(indexPath), { recursive: true });
  const temporaryPath = `${indexPath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(index), "utf8");
  const { renameSync } = await import("node:fs"); renameSync(temporaryPath, indexPath);
  loadedIndex = index; retrievalMode = "semantic"; lastError = undefined;
  console.info(`[rag.index] wrote ${records.length} vectors (${index.dimensions} dimensions) to ${indexPath}`);
  return { documents: activePolicyDocuments().length, chunks: records.length, dimensions: index.dimensions, model: modelName, path: indexPath };
}

export function policyRagStatus() {
  const current = corpus();
  if (!loadedIndex && existsSync(indexPath)) {
    try {
      if (statSync(indexPath).size > 25_000_000) throw new Error("Policy vector index is too large; rebuild it from the canonical Markdown files.");
      const candidate = JSON.parse(readFileSync(indexPath, "utf8")) as VectorIndex;
      if (candidate.schemaVersion !== 1 || candidate.model !== modelName || !Array.isArray(candidate.records) || candidate.records.length > 5000 || !Number.isInteger(candidate.dimensions) || candidate.dimensions < 1 || candidate.dimensions > 4096) throw new Error("Policy vector index metadata is invalid or incompatible; rebuild it.");
      const canonical = new Map(current.chunks.map(chunk => [chunk.id, chunk]));
      if (candidate.records.length !== canonical.size) throw new Error("Policy vector index is incomplete for the active policy versions; rebuild it.");
      const seen = new Set<string>();
      const records = candidate.records.map(record => {
        const source = record?.chunk;
        const chunk = source && canonical.get(source.id);
        if (!chunk || seen.has(chunk.id) || source.contentHash !== chunk.contentHash || !Array.isArray(record.vector) || record.vector.length !== candidate.dimensions || record.vector.some(value => !Number.isFinite(value) || Math.abs(value) > 1.001)) throw new Error("Policy vector index contains an invalid or mismatched record; rebuild it.");
        const norm = Math.sqrt(record.vector.reduce((sum, value) => sum + value * value, 0));
        if (Math.abs(norm - 1) > 0.03) throw new Error("Policy vectors are not normalized; rebuild the index with the configured embedding model.");
        seen.add(chunk.id);
        return { chunk, vector: record.vector };
      });
      if (seen.size !== canonical.size) throw new Error("Policy vector index does not include every active policy chunk; rebuild it.");
      loadedIndex = { ...candidate, records };
    } catch (error) { loadedIndex = undefined; lastError = error instanceof Error ? error.message : "Index file is unreadable"; }
  }
  const indexed = Boolean(loadedIndex && loadedIndex.corpusHash === current.digest && loadedIndex.model === modelName && loadedIndex.records.length > 0);
  const dependencyInstalled = canLoadTransformers();
  const ready = indexed && dependencyInstalled && !lastError;
  if (!ready && retrievalMode === "semantic") retrievalMode = "unindexed";
  if (indexed && !dependencyInstalled) lastError = "Transformers.js or its ONNX Runtime dependency is missing. Run npm.cmd install @huggingface/transformers --workspace server.";
  else if (!indexed && !lastError) lastError = "The policy vector index is not built. Run npm.cmd run rag:index after installing Transformers.js.";
  return { mode: ready ? (retrievalMode === "unindexed" ? "semantic" : retrievalMode) : indexed ? "keyword_fallback" : "unindexed", ready, indexed, model: modelName, dependencyInstalled, documents: current.docs.length, chunks: current.chunks.length, indexedChunks: indexed ? loadedIndex!.records.length : 0, indexPath, error: lastError, syntheticPolicies: true };
}

export interface RetrievedChunk { policyId: string; chunkId: string; title: string; excerpt: string; score: number; version: string; source: string; section: string; retrievalMode: "semantic" | "keyword_fallback"; }

function cosine(a: number[], b: number[]) { let score = 0; for (let i = 0; i < a.length; i++) score += a[i] * b[i]; return score; }
// Small, general language variants help short customer phrases align with policy wording.
// They expand concepts; they do not map a query to a particular policy or answer.
const queryVariants: Record<string, string[]> = {
  broken: ["damaged", "defective"], damaged: ["broken", "defective"], defective: ["broken", "damaged"],
  photo: ["photograph", "image", "evidence"], picture: ["photograph", "image", "evidence"],
  late: ["delayed", "shipment"], delayed: ["late", "shipment"], missing: ["lost", "undelivered"],
  duplicate: ["twice", "double", "charged"], twice: ["duplicate", "double charge"],
  subscription: ["digital", "usage", "charge"], cancel: ["cancellation", "refund"],
  fraud: ["unauthorized", "stolen", "risk"], unauthorized: ["fraud", "stolen", "risk"],
  refund: ["reimbursement", "money back"], reimbursement: ["refund", "money back"]
};
const genericTerms = new Set(["order", "orders", "item", "items", "product", "products", "customer", "help", "support", "issue", "issues", "case", "cases", "question", "questions", "assistance", "please", "need", "needs", "want", "wanted", "about", "with", "have", "can", "you", "your", "the", "for", "from", "was", "were", "does", "did", "when", "where", "what"]);
function queryTokens(query: string) { return query.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 2 && !genericTerms.has(word)); }
function queryTerms(query: string) {
  const terms = queryTokens(query);
  return [...new Set([...terms, ...terms.flatMap(term => queryVariants[term] ?? [])])];
}
function isNearWord(a: string, b: string) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 4) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (i < a.length || j < b.length ? 1 : 0) <= 1;
}
export async function retrievePolicyChunks(query: string, limit = Number(process.env.RAG_TOP_K || 4), options: { forceKeyword?: boolean } = {}): Promise<RetrievedChunk[]> {
  if (!query.trim()) { retrievalMode = "unindexed"; return []; }
  if (!queryTokens(query).length) { retrievalMode = "unindexed"; return []; }
  const status = policyRagStatus();
  if (status.ready && !options.forceKeyword) {
    try {
      const terms = queryTerms(query);
      const enrichedQuery = terms.length === query.split(/\s+/).length ? query : `${query}. Related terms: ${terms.join(" ")}.`;
      const queryVector = await embedText(enrichedQuery);
      const records = loadedIndex!.records;
      if (records.some(record => record.vector.length !== queryVector.length)) throw new Error("Embedding dimensions do not match the policy index; rebuild it with the configured model.");
      const configuredThreshold = Number(process.env.RAG_MIN_SCORE || 0.18);
      const shortQuery = query.split(/\s+/).filter(Boolean).length <= 4;
      const threshold = shortQuery ? Math.min(configuredThreshold, 0.13) : configuredThreshold;
      const originalTerms = new Set(queryTokens(query));
      const ranked = records.map(({ chunk, vector }) => {
        const termsInChunk = chunk.text.toLowerCase().split(/[^a-z0-9]+/);
        const directMatches = [...originalTerms].filter(word => termsInChunk.includes(word)).length;
        const expandedMatches = terms.filter(word => !originalTerms.has(word) && termsInChunk.includes(word)).length;
        const score = cosine(queryVector, vector);
        const relevantEnough = directMatches > 0 || expandedMatches >= 2 || score >= Math.max(configuredThreshold, 0.3);
        return { chunk, score, directMatches, relevantEnough };
      }).filter(item => item.score >= threshold && item.relevantEnough).sort((a, b) => b.score - a.score);
      if (ranked.length) {
        retrievalMode = "semantic"; lastError = undefined;
        return ranked.slice(0, Math.max(1, Math.min(10, limit))).map(({ chunk, score }) => ({ policyId: chunk.policyId, chunkId: chunk.id, title: chunk.title, excerpt: chunk.text, score: Number(score.toFixed(4)), version: chunk.version, source: chunk.source, section: chunk.section, retrievalMode: "semantic" as const }));
      }
      lastError = "Semantic matches were below the confidence threshold; using labeled keyword fallback.";
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Local embedding model unavailable";
      console.error(`[rag.retrieve] semantic retrieval unavailable: ${lastError}`);
    }
  }
  const { chunks } = corpus(); const queryWords = new Set(queryTerms(query));
  retrievalMode = "keyword_fallback";
  return chunks.map(chunk => { const terms = chunk.text.toLowerCase().split(/[^a-z0-9]+/); const matches = [...queryWords].filter(word => terms.some(term => isNearWord(word, term))).length; return { chunk, matches, score: queryWords.size ? matches / queryWords.size : 0 }; }).filter(item => item.matches >= 2).sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(10, limit))).map(({ chunk, score }) => ({ policyId: chunk.policyId, chunkId: chunk.id, title: chunk.title, excerpt: chunk.text, score: Number(score.toFixed(4)), version: chunk.version, source: chunk.source, section: chunk.section, retrievalMode: "keyword_fallback" as const }));
}
