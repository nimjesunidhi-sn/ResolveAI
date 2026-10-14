import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import type { CaseRecord, DatabaseState, Investigation, IssueType, Order, PolicyEvidence } from "../types.js";
import { retrievePolicyChunks } from "../knowledge/rag.js";

export function validateCitationReferences(explanation: string, evidence: PolicyEvidence[]) {
  const allowed = new Set(evidence.map(item => item.chunkId).filter((id): id is string => Boolean(id)));
  const references = [...explanation.matchAll(/\[([^\]]+)\]/g)].map(match => match[1].trim());
  const unbracketed = [...explanation.matchAll(/[a-z0-9-]+@\d+\.\d+#\d+/gi)]
    .filter(match => explanation[match.index! - 1] !== "[" || explanation[match.index! + match[0].length] !== "]")
    .map(match => match[0]);
  const unsupported = [...references.filter(reference => !allowed.has(reference)), ...unbracketed];
  const citationIds = [...new Set(references.filter(reference => allowed.has(reference)))];
  return { valid: references.length > 0 && unsupported.length === 0, citationIds, unsupported };
}

export function classifyIssue(text: string): IssueType {
  const value = text.toLowerCase();
  if (/fraud|unauthori[sz]ed|stolen card|chargeback/.test(value)) return "other";
  if (/duplicate|twice|double charge|charged two times/.test(value)) return "duplicate_charge";
  if (/subscription|digital|trial|annual plan|monthly plan/.test(value)) return "subscription_refund";
  if (/damaged|broken|defective|shattered/.test(value)) return "damaged_item";
  if (/never arrived|missing order|lost package|not delivered|missing package/.test(value)) return "missing_order";
  if (/late|delay|tracking|arriv|shipment/.test(value)) return "late_delivery";
  if (/refund|return|money back|cancel/.test(value)) return "refund_request";
  return "other";
}

export function checkRefundEligibility(input: { issueType: IssueType; order?: Order; policies: PolicyEvidence[]; hasPriorRefund: boolean; message: string; now?: Date }) {
  const { issueType, order, hasPriorRefund, message } = input;
  const now = input.now ?? new Date();
  if (!order) return { eligible: false, requiresHumanApproval: true, reason: "No matching order was found. Confirm the order ID before considering a refund." };
  if (hasPriorRefund) return { eligible: false, requiresHumanApproval: true, reason: "A refund already exists for this order. Duplicate refund requests are blocked." };
  if (/fraud|unauthori[sz]ed|stolen|chargeback/.test(message.toLowerCase())) return { eligible: false, requiresHumanApproval: true, reason: "A risk signal requires specialist review." };
  let eligible = false;
  let reason = "The request does not meet the sample refund policy based on current order data.";
  if (issueType === "damaged_item") {
    const age = order.deliveredAt ? (now.getTime() - Date.parse(order.deliveredAt)) / 86_400_000 : Infinity;
    const hasEvidence = /photo|image|receipt|evidence|attached|upload/i.test(message);
    eligible = order.category === "physical" && order.status === "delivered" && age <= 30 && hasEvidence && /damaged|broken|defective|shattered/i.test(message);
    reason = eligible ? "A defective physical item was reported within 30 days and the complaint references supporting evidence." : "Verify delivered status, the 30-day window, and customer-provided damage evidence.";
  } else if (issueType === "late_delivery" || issueType === "missing_order") {
    const daysPastPromise = order.promisedAt ? (now.getTime() - Date.parse(order.promisedAt)) / 86_400_000 : 0;
    eligible = order.status === "lost" || (order.status === "in_transit" && daysPastPromise > 14);
    reason = eligible ? "Carrier status or the 14-day delay threshold supports a refund." : "Delivery remains uncertain; verify tracking or carrier loss confirmation.";
  } else if (issueType === "subscription_refund") {
    const days = (now.getTime() - Date.parse(order.orderedAt)) / 86_400_000;
    eligible = order.category === "digital" && days <= 7 && (order.usagePercent ?? 100) < 20;
    reason = eligible ? "The subscription is within 7 days and account usage is below 20%." : "Verify the first charge date and usage; both policy requirements must be met.";
  } else if (issueType === "duplicate_charge") reason = "An agent must verify both transactions before deciding on a duplicate-charge refund.";
  const highValue = order.amount > Number(process.env.REFUND_APPROVAL_LIMIT || 200);
  const requiresHumanApproval = highValue || issueType === "duplicate_charge" || !eligible;
  if (highValue && eligible) reason += " The amount exceeds the configured approval limit, so an administrator must approve it.";
  return { eligible, requiresHumanApproval, reason };
}

export async function investigateCase(record: CaseRecord, db: DatabaseState): Promise<Investigation> {
  const text = `${record.subject} ${record.message}`;
  const issueType = classifyIssue(text);
  const policies = (await retrievePolicyChunks(text)).map(policy => ({ ...policy, citationId: policy.chunkId }));
  const order = record.orderId ? db.orders.find(item => item.id.toLowerCase() === record.orderId!.toLowerCase()) : undefined;
  const matches = !order || order.customerId === record.customerId;
  const priorRefund = Boolean(order && db.refunds.some(refund => refund.orderId === order.id && refund.status !== "rejected"));
  const eligibility = !matches ? { eligible: false, requiresHumanApproval: true, reason: "The supplied order belongs to a different customer. Verify ownership before taking action." } : checkRefundEligibility({ issueType, order, policies, hasPriorRefund: priorRefund, message: text });
  const risk = /fraud|unauthori[sz]ed|stolen|chargeback/.test(text.toLowerCase());
  let recommendation: Investigation["recommendation"] = eligibility.eligible ? "refund_recommended" : issueType === "duplicate_charge" || !order || !matches || risk || eligibility.requiresHumanApproval ? "escalate" : "not_eligible";
  if (eligibility.requiresHumanApproval) recommendation = "escalate";
  const orderEvidence = order ? [
    `Order ${order.id} belongs to ${matches ? "this customer" : "a different customer"}.`, `${order.item}: ${order.status.replace("_", " ")}, $${order.amount.toFixed(2)} ${order.currency}.`,
    order.deliveredAt ? `Delivered ${new Date(order.deliveredAt).toLocaleDateString("en-US")}.` : order.promisedAt ? `Promised delivery ${new Date(order.promisedAt).toLocaleDateString("en-US")}.` : "No delivery date recorded.",
    order.category === "digital" ? `Digital account usage: ${order.usagePercent ?? "unknown"}%.` : "Physical product order."
  ] : [record.orderId ? `Order ID ${record.orderId} could not be found.` : "No order ID was provided."];
  let aiMode: Investigation["aiMode"] = process.env.OPENAI_API_KEY ? "openai" : "demo";
  let explanation = process.env.OPENAI_API_KEY ? eligibility.reason : `Demo analysis: ${eligibility.reason}`;
  let citationStatus: Investigation["citationStatus"] = "not_applicable";
  let validatedCitations: string[] = [];
  if (process.env.OPENAI_API_KEY && policies.length === 0) {
    aiMode = "rules";
    explanation = `No relevant policy passage was retrieved; no grounded AI explanation was generated. ${eligibility.reason}`;
  } else if (process.env.OPENAI_API_KEY) {
    try {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 12_000, maxRetries: 0 });
      const result = await client.chat.completions.create({ model: process.env.OPENAI_MODEL || "gpt-4o-mini", temperature: 0.1, response_format: { type: "json_object" }, messages: [
        { role: "system", content: "Write a concise case explanation using only supplied facts and retrieved policy snippets. Cite every policy-based claim inline using the exact supplied citationId in square brackets, for example [physical-returns@2.0#1]. Return JSON {\"explanation\":string}. Do not decide eligibility, claim a refund was issued, or invent evidence." },
        { role: "user", content: JSON.stringify({ complaint: text, orderEvidence, retrievedPolicies: policies.map(policy => ({ citationId: policy.citationId, policyId: policy.policyId, chunkId: policy.chunkId, version: policy.version, source: policy.source, section: policy.section, title: policy.title, excerpt: policy.excerpt })), deterministicEligibility: eligibility.reason }) }
      ] });
      const value = JSON.parse(result.choices[0]?.message.content || "{}").explanation;
      if (typeof value === "string" && value.length < 1200) {
        const citations = validateCitationReferences(value, policies);
        if (citations.valid) { explanation = value; validatedCitations = citations.citationIds; citationStatus = "validated"; }
        else { aiMode = "rules"; citationStatus = "rejected"; explanation = `AI explanation rejected because its citations were missing or did not match retrieved policy evidence. ${eligibility.reason}`; }
      }
    } catch (error) {
      aiMode = "rules";
      explanation = `AI provider unavailable; using deterministic rule result. ${eligibility.reason}`;
      console.error("OpenAI investigation failed:", error instanceof Error ? error.message : "unknown provider error");
    }
  }
  const investigation: Investigation = { id: randomUUID(), caseId: record.id, orderId: order?.id, issueType, recommendation, eligible: eligibility.eligible, requiresHumanApproval: eligibility.requiresHumanApproval, confidence: recommendation === "escalate" ? 54 : eligibility.eligible ? 91 : 82, explanation, evidence: policies, validatedCitations, citationStatus, orderEvidence, aiMode, retrievalMode: policies[0]?.retrievalMode ?? "none", createdAt: new Date().toISOString() };
  db.investigations.unshift(investigation);
  await db.persist("investigations", investigation as unknown as Record<string, unknown>);
  record.issueType = issueType; record.investigationId = investigation.id; record.status = recommendation === "escalate" ? "escalated" : "reviewed"; record.updatedAt = investigation.createdAt;
  await db.persist("cases", record as unknown as Record<string, unknown>);
  return investigation;
}
