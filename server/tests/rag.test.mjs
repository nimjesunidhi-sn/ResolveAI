import test from "node:test";
import assert from "node:assert/strict";
import { activePolicyDocuments, chunkPolicy, embedText, loadPolicyDocuments, policyRagStatus, retrievePolicyChunks } from "../dist/knowledge/rag.js";

test("ingests synthetic Markdown policies and selects only each latest active version", () => {
  const docs = loadPolicyDocuments();
  assert.ok(docs.length >= 5);
  assert.ok(docs.every(doc => doc.synthetic === true && doc.body.length > 0));
  const physical = activePolicyDocuments(docs).find(doc => doc.id === "physical-returns");
  assert.equal(physical.version, "2.0");
  assert.ok(!activePolicyDocuments(docs).some(doc => doc.version === "1.0" && doc.id === "physical-returns"));
});

test("chunks retain source/version identifiers and stable content hashes", () => {
  const doc = activePolicyDocuments().find(item => item.id === "physical-returns");
  const chunks = chunkPolicy(doc);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.policyId === doc.id && chunk.version === doc.version && chunk.source === doc.source));
  assert.ok(chunks.every(chunk => typeof chunk.section === "string" && chunk.section.length > 0));
  assert.ok(chunks.every(chunk => chunk.id.startsWith("physical-returns@2.0#") && chunk.contentHash.length === 64));
});

test("policy search returns traceable chunks and labels the unavailable-index fallback", async () => {
  const matches = await retrievePolicyChunks("my broken headphones arrived damaged and I have a photo");
  assert.ok(matches.some(item => item.policyId === "physical-returns"));
  assert.ok(matches.every(item => item.chunkId && item.source && item.version && item.excerpt));
  assert.ok(matches.every(item => item.retrievalMode === "keyword_fallback" || item.retrievalMode === "semantic"));
  assert.equal(typeof policyRagStatus().ready, "boolean");
});

test("retrieval can return no evidence instead of fabricating a passage", async () => {
  const matches = await retrievePolicyChunks("qzxv blorf unrelated", undefined, { forceKeyword: true });
  assert.deepEqual(matches, []);
});

test("short informal damage queries retrieve relevant evidence and unrelated queries stay empty", async () => {
  const matches = await retrievePolicyChunks("broken headphones photo");
  assert.ok(matches.some(item => item.policyId === "physical-returns" && item.version === "2.0"));
  assert.equal(matches[0]?.policyId, "physical-returns");
  assert.deepEqual(await retrievePolicyChunks("qzxv blorf unrelated"), []);
  assert.deepEqual(await retrievePolicyChunks("I have a question about my order"), []);
  assert.deepEqual(await retrievePolicyChunks("   "), []);
});

test("retrieval covers paraphrases across every active policy category", async () => {
  const examples = [
    ["A defective item arrived; I have a picture", "physical-returns"],
    ["The parcel is delayed well past the promised delivery", "delivery-refunds"],
    ["I was billed twice for the same transaction", "duplicate-charges"],
    ["Unused digital plan first charge refund within seven days", "subscription-refunds"],
    ["A high value request is above the configured approval limit", "risk-review"]
  ];
  for (const [query, policyId] of examples) {
    const matches = await retrievePolicyChunks(query);
    assert.ok(matches.some(item => item.policyId === policyId), `${query} should retrieve ${policyId}`);
  }
});

test("keyword fallback handles a minor typo and reports its actual retrieval mode", async () => {
  const matches = await retrievePolicyChunks("brokn item photp evidence complaint", undefined, { forceKeyword: true });
  assert.ok(matches.some(item => item.policyId === "physical-returns"));
  assert.ok(matches.every(item => item.retrievalMode === "keyword_fallback"));
});

test("semantic retrieval and persisted index work when the optional local model is enabled", { skip: process.env.RESOLVEAI_TEST_REAL_EMBEDDINGS !== "1" }, async () => {
  const { buildPolicyIndex } = await import("../dist/knowledge/rag.js");
  const indexed = await buildPolicyIndex();
  assert.ok(indexed.chunks > 0);
  assert.equal(indexed.dimensions, 384);
  const shortMatches = await retrievePolicyChunks("broken headphones photo");
  assert.equal(shortMatches[0]?.policyId, "physical-returns");
  assert.equal(shortMatches[0]?.section, "Damage evidence");
  assert.ok(shortMatches.every(item => item.retrievalMode === "semantic"));
  const matches = await retrievePolicyChunks("The headphones arrived broken and I have attached a damage photo.");
  assert.equal(matches[0]?.retrievalMode, "semantic");
  assert.ok(matches.some(item => item.policyId === "physical-returns" && item.version === "2.0"));
});

test("real local embedding and semantic retrieval smoke test (opt-in)", { skip: process.env.RESOLVEAI_TEST_REAL_EMBEDDINGS !== "1" }, async () => {
  const vector = await embedText("refund for a damaged product");
  assert.equal(vector.length, 384);
  assert.ok(Math.abs(Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) - 1) < 0.02);
});
