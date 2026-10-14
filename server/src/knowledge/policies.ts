import type { Policy, PolicyEvidence } from "../types.js";
import { activePolicyDocuments, chunkPolicy, loadPolicyDocuments } from "./rag.js";

// Sample policy records exposed to the existing UI/API are derived from the canonical Markdown files.
export const policySeed: Policy[] = activePolicyDocuments().map(doc => ({ id: doc.id, title: doc.title, category: doc.category, body: doc.body, updatedAt: `${doc.effectiveDate}T00:00:00.000Z`, version: doc.version, source: doc.source, synthetic: true }));

// Kept as a synchronous keyword-only helper for simple callers and legacy tests.
// Investigations and the search API use retrievePolicyChunks for semantic vectors when indexed.
export function retrievePolicies(query: string, policies: Policy[] = policySeed, limit = 4): PolicyEvidence[] {
  const words = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 2));
  return policies.map(policy => {
    const body = policy.body.toLowerCase();
    const score = [...words].filter(word => body.includes(word)).length;
    return { policyId: policy.id, title: policy.title, excerpt: policy.body, score };
  }).filter(result => result.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

export function getActivePolicyChunks() { return activePolicyDocuments(loadPolicyDocuments()).flatMap(chunkPolicy); }
