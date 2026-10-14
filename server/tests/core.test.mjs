import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../dist/app.js";
import { customerSeed, orderSeed, caseSeed, policySeed } from "../dist/seed.js";
import { classifyIssue, checkRefundEligibility, validateCitationReferences } from "../dist/services/investigation.js";
import { retrievePolicies } from "../dist/knowledge/policies.js";

const agent = "resolveai-agent-demo";
const admin = "resolveai-admin-demo";
const db = {
  mode: "memory", customers: structuredClone(customerSeed), orders: structuredClone(orderSeed),
  policies: structuredClone(policySeed), cases: structuredClone(caseSeed), investigations: [], refunds: [], audit: [],
  async persist() {}
};
let server, sharedServer, base, sharedBase;
const request = (path, options = {}, token = agent) => fetch(`${base}${path}`, { ...options, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
const sharedRequest = (path, options = {}, token = agent) => fetch(`${sharedBase}${path}`, { ...options, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
const json = data => JSON.stringify(data);

before(async () => {
  delete process.env.OPENAI_API_KEY;
  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  sharedServer = createApp().listen(0, "127.0.0.1");
  await new Promise(resolve => sharedServer.once("listening", resolve));
  sharedBase = `http://127.0.0.1:${sharedServer.address().port}`;
});
after(async () => Promise.all([server, sharedServer].map(instance => new Promise(resolve => instance.close(resolve)))));

test("classifies complaint types and retrieves traceable relevant policy passages", () => {
  assert.equal(classifyIssue("My headphones arrived broken"), "damaged_item");
  const results = retrievePolicies("My headphones arrived broken", policySeed);
  assert.ok(results.some(item => item.policyId === "physical-returns"));
  assert.ok(results[0].excerpt.length > 20);
});

test("refund rules cover missing orders and high value approval", () => {
  const missing = checkRefundEligibility({ issueType: "damaged_item", policies: [], hasPriorRefund: false, message: "broken" });
  assert.equal(missing.eligible, false); assert.equal(missing.requiresHumanApproval, true);
  const expensive = { ...orderSeed.find(item => item.id === "ORD-7704"), amount: 245 };
  const highValue = checkRefundEligibility({ issueType: "damaged_item", order: expensive, policies: [], hasPriorRefund: false, message: "damaged, photo evidence attached" });
  assert.equal(highValue.eligible, true); assert.equal(highValue.requiresHumanApproval, true);
});

test("citation validator accepts only retrieved chunk IDs and rejects missing or fabricated citations", () => {
  const evidence = [{ policyId: "physical-returns", chunkId: "physical-returns@2.0#1" }];
  assert.deepEqual(validateCitationReferences("The window is 30 days [physical-returns@2.0#1].", evidence), { valid: true, citationIds: ["physical-returns@2.0#1"], unsupported: [] });
  assert.equal(validateCitationReferences("The policy allows it [invented@9.9#99].", evidence).valid, false);
  assert.equal(validateCitationReferences("The policy says this: physical-returns@2.0#1", evidence).valid, false);
  assert.equal(validateCitationReferences("A policy answer with no source.", evidence).valid, false);
  assert.deepEqual(validateCitationReferences("Supported [physical-returns@2.0#1] twice [physical-returns@2.0#1].", evidence).citationIds, ["physical-returns@2.0#1"]);
  assert.equal(validateCitationReferences("Not retrieved [duplicate-charges@1.0#1].", evidence).valid, false);
});

test("health, authentication, and invalid complaint payloads are explicit", async () => {
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.database, "memory"); assert.equal(health.ai.configured, false);
  assert.equal(health.rag.syntheticPolicies, true);
  const policyMatches = await (await request("/api/policies/search?q=broken%20headphones%20photo")).json();
  assert.ok(policyMatches.some(item => item.policyId === "physical-returns" && item.chunkId && item.version === "2.0"));
  assert.equal((await request("/api/cases", {}, "bad-token")).status, 401);
  const invalid = await request("/api/cases", { method: "POST", body: json({ customerName: "", subject: "x", message: "no" }) });
  assert.equal(invalid.status, 400);
});

test("case creation and missing order investigation escalate without inventing order evidence", async () => {
  const createdResponse = await request("/api/cases", { method: "POST", body: json({ customerName: "Taylor Test", email: "taylor@test.local", subject: "Where is my refund?", message: "I do not recognize this order and need help with the refund.", orderId: "ORDER-NOT-REAL" }) });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const resultResponse = await request(`/api/cases/${created.id}/investigate`, { method: "POST", body: "{}" });
  assert.equal(resultResponse.status, 200);
  const result = await resultResponse.json();
  assert.equal(result.recommendation, "escalate"); assert.equal(result.aiMode, "demo");
  assert.match(result.orderEvidence[0], /could not be found/);
  assert.ok(result.evidence.length > 0);
  assert.ok(result.evidence[0].chunkId); assert.ok(result.evidence[0].source); assert.ok(["semantic", "keyword_fallback"].includes(result.retrievalMode));
  assert.ok(result.evidence.every(item => item.citationId === item.chunkId));
  assert.ok(result.evidence.every(item => item.source && item.version && item.excerpt));
});

test("shared demo store keeps a created case available for detail, investigation, and human review", async () => {
  const createdResponse = await sharedRequest("/api/cases", { method: "POST", body: json({ customerId: "cus-lana", customerName: "Lana Steiner", subject: "Broken headphones refund", message: "The headphones arrived broken. I attached photo evidence and would like a refund.", orderId: "ORD-7742" }) });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(typeof created.id, "string");

  const listed = await (await sharedRequest("/api/cases")).json();
  assert.ok(listed.some(item => item.id === created.id));
  const detailResponse = await sharedRequest(`/api/cases/${created.id}`);
  assert.equal(detailResponse.status, 200);
  assert.equal((await detailResponse.json()).id, created.id);

  const investigationResponse = await sharedRequest(`/api/cases/${created.id}/investigate`, { method: "POST", body: "{}" });
  assert.equal(investigationResponse.status, 200);
  const investigation = await investigationResponse.json();
  assert.equal(investigation.caseId, created.id);
  assert.equal(investigation.aiMode, "demo");
  assert.equal(investigation.recommendation, "refund_recommended");

  const escalatedResponse = await sharedRequest(`/api/cases/${created.id}/status`, { method: "PATCH", body: json({ status: "escalated" }) });
  assert.equal(escalatedResponse.status, 200);
  assert.equal((await escalatedResponse.json()).id, created.id);
  const reviewQueue = await (await sharedRequest("/api/reviews")).json();
  assert.ok(reviewQueue.some(item => item.id === created.id));
});

test("complaint with no order ID is routed for human review", async () => {
  const createdResponse = await request("/api/cases", { method: "POST", body: json({ customerName: "Jordan Example", subject: "I need a refund", message: "I need a refund but cannot find my order reference." }) });
  const created = await createdResponse.json();
  const result = await (await request(`/api/cases/${created.id}/investigate`, { method: "POST", body: "{}" })).json();
  assert.equal(result.eligible, false); assert.equal(result.recommendation, "escalate");
  assert.match(result.orderEvidence[0], /No order ID was provided/);
});

test("refunds are deduplicated and high-value refunds require administrator approval", async () => {
  const createdResponse = await request("/api/cases", { method: "POST", body: json({ customerId: "cus-candice", customerName: "Candice Wu", subject: "Damaged vase refund", message: "The vase arrived shattered. I have photos and evidence of the damage.", orderId: "ORD-7704" }) });
  const created = await createdResponse.json();
  const investigation = await (await request(`/api/cases/${created.id}/investigate`, { method: "POST", body: "{}" })).json();
  assert.equal(investigation.eligible, true); assert.equal(investigation.requiresHumanApproval, true);
  const refundResponse = await request("/api/refunds", { method: "POST", body: json({ caseId: created.id }) });
  assert.equal(refundResponse.status, 201);
  const refund = await refundResponse.json(); assert.equal(refund.status, "pending_approval");
  assert.equal((await request(`/api/refunds/${refund.id}/approve`, { method: "POST", body: "{}" })).status, 403);
  assert.equal((await request(`/api/refunds/${refund.id}/approve`, { method: "POST", body: "{}" }, admin)).status, 200);
  const approvedAnalytics = await (await request("/api/analytics")).json();
  assert.equal(approvedAnalytics.resolvedCases, db.cases.filter(item => item.status === "resolved").length);
  assert.equal(db.cases.find(item => item.id === created.id).status, "approved");
  const simulated = await request(`/api/refunds/${refund.id}/simulate`, { method: "POST", body: "{}" }, admin);
  assert.equal(simulated.status, 200); assert.match((await simulated.json()).message, /No payment was moved/);
  assert.equal(db.cases.find(item => item.id === created.id).status, "resolved");
  const duplicate = await request("/api/refunds", { method: "POST", body: json({ caseId: created.id }) });
  assert.equal(duplicate.status, 409);
  assert.ok(db.audit.some(item => item.action === "refund.approved"));
});

test("non-eligible complaint cannot create a refund", async () => {
  const createdResponse = await request("/api/cases", { method: "POST", body: json({ customerId: "cus-alex", customerName: "Alex Morgan", subject: "Refund for old lamp", message: "The lamp works fine, but I want a refund after six weeks.", orderId: "ORD-7699" }) });
  const created = await createdResponse.json();
  const result = await (await request(`/api/cases/${created.id}/investigate`, { method: "POST", body: "{}" })).json();
  assert.equal(result.eligible, false);
  assert.equal((await request("/api/refunds", { method: "POST", body: json({ caseId: created.id }) })).status, 409);
});

test("administrator can reject a pending simulated refund and it cannot be simulated afterward", async () => {
  const previousLimit = process.env.REFUND_APPROVAL_LIMIT;
  process.env.REFUND_APPROVAL_LIMIT = "100";
  try {
    const createdResponse = await request("/api/cases", { method: "POST", body: json({ customerId: "cus-lana", customerName: "Lana Steiner", subject: "Damaged headphones review", message: "The headphones arrived broken and I have photos of the damage.", orderId: "ORD-7742" }) });
    const created = await createdResponse.json();
    await request(`/api/cases/${created.id}/investigate`, { method: "POST", body: "{}" });
    const refundResponse = await request("/api/refunds", { method: "POST", body: json({ caseId: created.id }) });
    const refund = await refundResponse.json();
    assert.equal(refund.status, "pending_approval");
    assert.equal((await request(`/api/refunds/${refund.id}/reject`, { method: "POST", body: "{}" })).status, 403);
    const rejectedResponse = await request(`/api/refunds/${refund.id}/reject`, { method: "POST", body: "{}" }, admin);
    assert.equal(rejectedResponse.status, 200);
    assert.equal((await rejectedResponse.json()).status, "rejected");
    assert.equal((await request(`/api/refunds/${refund.id}/simulate`, { method: "POST", body: "{}" }, admin)).status, 409);
    assert.equal(db.cases.find(item => item.id === created.id).status, "rejected");
    assert.ok(db.audit.some(item => item.action === "refund.rejected"));
  } finally {
    if (previousLimit === undefined) delete process.env.REFUND_APPROVAL_LIMIT;
    else process.env.REFUND_APPROVAL_LIMIT = previousLimit;
  }
});
