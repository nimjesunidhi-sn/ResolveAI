import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { z } from "zod";
import { getDatabase } from "./database.js";
import type { CaseRecord, DatabaseState, Role } from "./types.js";
import { policyRagStatus, retrievePolicyChunks } from "./knowledge/rag.js";
import { investigateCase } from "./services/investigation.js";

const caseSchema = z.object({ customerId: z.string().optional(), customerName: z.string().min(1).max(120), email: z.string().email().or(z.literal("")).optional(), subject: z.string().min(3).max(180), message: z.string().min(10).max(6000), orderId: z.string().max(80).optional() });
const validStatus = z.enum(["new", "investigating", "reviewed", "escalated", "resolved"]);
type Actor = { role: Role; token: string };
const tokens = () => ({ agent: process.env.DEMO_AGENT_TOKEN || "resolveai-agent-demo", admin: process.env.DEMO_ADMIN_TOKEN || "resolveai-admin-demo" });

function actorFor(req: Request): Actor | undefined {
  const bearer = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!bearer) return undefined;
  const known = tokens();
  if (bearer === known.admin) return { role: "admin", token: bearer };
  if (bearer === known.agent) return { role: "agent", token: bearer };
  return undefined;
}
function protect(roles: Role[] = ["agent", "admin"]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const actor = actorFor(req);
    if (!actor) return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Sign in with a configured demo agent token." } });
    if (!roles.includes(actor.role)) return res.status(403).json({ error: { code: "FORBIDDEN", message: "Administrator approval is required for this action." } });
    (req as Request & { actor: Actor }).actor = actor;
    next();
  };
}
function actor(req: Request) { return (req as Request & { actor: Actor }).actor; }
function audit(db: DatabaseState, req: Request, action: string, type: string, id: string, details: string) {
  const user = actor(req);
  const event = { id: randomUUID(), actor: user ? user.role : "system" as const, role: user?.role ?? "system" as const, action, entityType: type, entityId: id, details, createdAt: new Date().toISOString() };
  db.audit.unshift(event); void db.persist("audit", event as unknown as Record<string, unknown>);
}
function asyncRoute(fn: (req: Request, res: Response) => Promise<unknown>) { return (req: Request, res: Response, next: NextFunction) => { Promise.resolve(fn(req, res)).catch(next); }; }
function findCase(db: DatabaseState, id: string) {
  const record = db.cases.find(item => item.id === id);
  if (!record) console.error(`[case.lookup] Case ${id} not found in ${db.mode} store (${db.cases.length} cases currently loaded). A backend restart resets demo memory.`);
  return record;
}
function caseNotFound(id: string, mode: DatabaseState["mode"]) {
  return { error: { code: "CASE_NOT_FOUND", message: `Case ${id} was not found in the active ${mode} store. Refresh the inbox; demo cases are cleared when the backend restarts.` } };
}

export function createApp(db: DatabaseState = getDatabase()) {
  const app = express();
  const allowed = (process.env.CLIENT_ORIGIN || "http://localhost:5173").split(",").map(value => value.trim());
  app.disable("x-powered-by");
  app.use(cors({ origin: allowed, credentials: false }));
  app.use(express.json({ limit: "256kb" }));
  app.use((req, res, next) => { const mayEmbed = req.path === "/api/policies/search" || /^\/api\/cases\/[^/]+\/investigate$/.test(req.path); const configuredTimeout = Number(process.env.RAG_REQUEST_TIMEOUT_MS); const timeoutMs = mayEmbed ? (Number.isInteger(configuredTimeout) && configuredTimeout >= 1000 && configuredTimeout <= 600_000 ? configuredTimeout : 120_000) : 15_000; res.setTimeout(timeoutMs, () => { if (!res.headersSent) res.status(408).json({ error: { code: "REQUEST_TIMEOUT", message: mayEmbed ? "Policy retrieval took too long. Check local model status and retry." : "The request took too long. Please try again." } }); }); next(); });
  app.use((req, _res, next) => { console.info(`${new Date().toISOString()} ${req.method} ${req.path}`); next(); });

  app.get("/api/health", (_req, res) => res.json({ ok: true, server: "ok", database: db.mode, persistence: db.mode === "mongodb" ? "persistent" : "in-memory; resets when server stops", ai: { provider: process.env.OPENAI_API_KEY ? "openai" : "demo", configured: Boolean(process.env.OPENAI_API_KEY) }, rag: policyRagStatus(), auth: { demoCredentials: db.mode === "memory" && process.env.NODE_ENV !== "production" } }));
  app.get("/api/cases", protect(), (req, res) => {
    const status = req.query.status ? String(req.query.status) : "";
    const search = String(req.query.search ?? "").toLowerCase();
    const results = db.cases.filter(item => (!status || item.status === status) && (!search || `${item.customerName} ${item.subject} ${item.message} ${item.orderId ?? ""}`.toLowerCase().includes(search))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json(results);
  });
  app.get("/api/cases/:id", protect(), (req, res) => {
    const caseId = String(req.params.id);
    const record = findCase(db, caseId);
    if (!record) return res.status(404).json(caseNotFound(caseId, db.mode));
    res.json({ ...record, customer: db.customers.find(item => item.id === record.customerId), order: db.orders.find(item => item.id === record.orderId), investigation: db.investigations.find(item => item.id === record.investigationId), audit: db.audit.filter(item => item.entityId === record.id || item.entityId === record.investigationId).slice(0, 30) });
  });
  app.post("/api/cases", protect(), asyncRoute(async (req, res) => {
    const parsed = caseSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: "INVALID_CASE", message: "Enter a customer name, valid email, subject, and complaint of at least 10 characters.", details: parsed.error.flatten() } });
    const input = parsed.data;
    let customer = input.customerId ? db.customers.find(item => item.id === input.customerId) : db.customers.find(item => item.email.toLowerCase() === (input.email || "").toLowerCase());
    if (!customer) {
      customer = { id: randomUUID(), name: input.customerName, email: input.email || "", createdAt: new Date().toISOString() };
      db.customers.unshift(customer); await db.persist("customers", customer as unknown as Record<string, unknown>);
    }
    const record: CaseRecord = { id: randomUUID(), customerId: customer.id, customerName: customer.name, email: customer.email, subject: input.subject, message: input.message, orderId: input.orderId?.trim(), status: "new", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    db.cases.unshift(record); await db.persist("cases", record as unknown as Record<string, unknown>);
    audit(db, req, "case.created", "case", record.id, `Case created for ${customer.name}.`);
    res.status(201).json(record);
  }));
  app.post("/api/cases/:id/investigate", protect(), asyncRoute(async (req, res) => {
    const caseId = String(req.params.id);
    const record = findCase(db, caseId);
    if (!record) return res.status(404).json(caseNotFound(caseId, db.mode));
    const result = await investigateCase(record, db);
    audit(db, req, "case.investigated", "case", record.id, `${result.issueType}: ${result.recommendation}; ${result.aiMode} analysis; ${result.retrievalMode} policy retrieval.`);
    res.json(result);
  }));
  app.patch("/api/cases/:id/status", protect(), asyncRoute(async (req, res) => {
    const parsed = validStatus.safeParse(req.body.status);
    if (!parsed.success) return res.status(400).json({ error: { code: "INVALID_STATUS", message: "Choose a supported case status." } });
    const caseId = String(req.params.id);
    const record = findCase(db, caseId);
    if (!record) return res.status(404).json(caseNotFound(caseId, db.mode));
    record.status = parsed.data; record.updatedAt = new Date().toISOString();
    await db.persist("cases", record as unknown as Record<string, unknown>);
    audit(db, req, "case.status_changed", "case", record.id, `Case marked ${record.status}.`);
    res.json(record);
  }));

  app.get("/api/customers", protect(), (_req, res) => res.json(db.customers.map(customer => ({ ...customer, orders: db.orders.filter(order => order.customerId === customer.id).length, cases: db.cases.filter(record => record.customerId === customer.id).length }))));
  app.get("/api/customers/:id", protect(), (req, res) => { const customer = db.customers.find(item => item.id === req.params.id); return customer ? res.json({ ...customer, orders: db.orders.filter(item => item.customerId === customer.id), cases: db.cases.filter(item => item.customerId === customer.id) }) : res.status(404).json({ error: { code: "CUSTOMER_NOT_FOUND", message: "Customer not found." } }); });
  app.get("/api/orders", protect(), (_req, res) => res.json(db.orders.map(order => ({ ...order, customerName: db.customers.find(customer => customer.id === order.customerId)?.name ?? "Unknown" }))));
  app.get("/api/orders/:id", protect(), (req, res) => { const orderId = String(req.params.id); const order = db.orders.find(item => item.id.toLowerCase() === orderId.toLowerCase()); return order ? res.json({ ...order, customer: db.customers.find(customer => customer.id === order.customerId), refunds: db.refunds.filter(refund => refund.orderId === order.id) }) : res.status(404).json({ error: { code: "ORDER_NOT_FOUND", message: "Order not found." } }); });
  app.get("/api/policies", protect(), (_req, res) => res.json(db.policies));
  app.get("/api/policies/search", protect(), asyncRoute(async (req, res) => res.json(await retrievePolicyChunks(String(req.query.q ?? "")))));
  app.get("/api/policies/rag-status", protect(), (_req, res) => res.json(policyRagStatus()));
  app.get("/api/investigations", protect(), (req, res) => { const caseId = String(req.query.caseId ?? ""); res.json(db.investigations.filter(item => !caseId || item.caseId === caseId)); });
  app.get("/api/reviews", protect(), (_req, res) => res.json(db.cases.filter(item => item.status === "escalated").map(record => ({ ...record, investigation: db.investigations.find(item => item.id === record.investigationId) }))));
  app.get("/api/analytics", protect(), (_req, res) => {
    const casesByStatus = Object.fromEntries(["new", "investigating", "reviewed", "escalated", "approved", "rejected", "resolved"].map(status => [status, db.cases.filter(item => item.status === status).length]));
    const casesByIssue = Object.fromEntries([...new Set(db.cases.map(item => item.issueType).filter(Boolean))].map(issue => [issue!, db.cases.filter(item => item.issueType === issue).length]));
    const totalCases = db.cases.length; const resolvedCases = db.cases.filter(item => item.status === "resolved").length;
    res.json({ totalCases, openCases: db.cases.filter(item => ["new", "investigating", "escalated"].includes(item.status)).length, escalatedCases: casesByStatus.escalated, resolvedCases, approvedRefunds: db.refunds.filter(item => item.status === "approved" || item.status === "simulated").length, simulatedRefunds: db.refunds.filter(item => item.status === "simulated").length, resolutionRate: totalCases ? Math.round(resolvedCases / totalCases * 100) : 0, casesByStatus, casesByIssue });
  });
  app.get("/api/audit", protect(), (_req, res) => res.json(db.audit.slice(0, 200)));

  app.post("/api/refunds", protect(), asyncRoute(async (req, res) => {
    const parsed = z.object({ caseId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: "INVALID_REFUND", message: "A case ID is required." } });
    const record = db.cases.find(item => item.id === parsed.data.caseId);
    const result = record && db.investigations.find(item => item.id === record.investigationId);
    if (!record || !result) return res.status(409).json({ error: { code: "INVESTIGATION_REQUIRED", message: "Investigate the case before requesting a refund." } });
    const order = db.orders.find(item => item.id === result.orderId);
    if (!order || order.customerId !== record.customerId) return res.status(409).json({ error: { code: "ORDER_NOT_VALID", message: "A valid order belonging to this customer is required." } });
    if (!result.eligible) return res.status(409).json({ error: { code: "NOT_ELIGIBLE", message: "The investigation does not recommend a refund. No refund was created." } });
    if (db.refunds.some(item => item.orderId === order.id)) return res.status(409).json({ error: { code: "DUPLICATE_REFUND", message: "A refund request already exists for this order." } });
    const requiresApproval = result.requiresHumanApproval || order.amount > Number(process.env.REFUND_APPROVAL_LIMIT || 200);
    const refund = { id: randomUUID(), caseId: record.id, orderId: order.id, customerId: record.customerId, amount: order.amount, currency: order.currency, status: requiresApproval ? "pending_approval" as const : "simulated" as const, requestedBy: actor(req).role, createdAt: new Date().toISOString() };
    db.refunds.unshift(refund); await db.persist("refunds", refund as unknown as Record<string, unknown>);
    record.refundId = refund.id; record.status = refund.status === "simulated" ? "resolved" : "escalated"; await db.persist("cases", record as unknown as Record<string, unknown>);
    audit(db, req, refund.status === "simulated" ? "refund.simulated" : "refund.requested", "refund", refund.id, `$${refund.amount.toFixed(2)} ${refund.currency}; ${refund.status}.`);
    res.status(201).json({ ...refund, simulated: refund.status === "simulated", message: refund.status === "simulated" ? "Demo refund simulated. No payment was moved." : "Refund is waiting for administrator approval." });
  }));
  app.get("/api/refunds", protect(), (_req, res) => res.json(db.refunds));
  app.post("/api/refunds/:id/approve", protect(["admin"]), asyncRoute(async (req, res) => {
    const refund = db.refunds.find(item => item.id === req.params.id);
    if (!refund || refund.status !== "pending_approval") return res.status(404).json({ error: { code: "REFUND_NOT_PENDING", message: "No pending refund request was found." } });
    refund.status = "approved"; refund.reviewedBy = actor(req).role; refund.reviewedAt = new Date().toISOString();
    await db.persist("refunds", refund as unknown as Record<string, unknown>);
    const record = db.cases.find(item => item.id === refund.caseId); if (record) { record.status = "approved"; record.updatedAt = refund.reviewedAt; await db.persist("cases", record as unknown as Record<string, unknown>); }
    audit(db, req, "refund.approved", "refund", refund.id, "Administrator approved the simulated refund request.");
    res.json({ ...refund, message: "Approved for demo simulation. No funds have moved." });
  }));
  app.post("/api/refunds/:id/reject", protect(["admin"]), asyncRoute(async (req, res) => {
    const refund = db.refunds.find(item => item.id === req.params.id);
    if (!refund || refund.status !== "pending_approval") return res.status(404).json({ error: { code: "REFUND_NOT_PENDING", message: "No pending refund request was found." } });
    refund.status = "rejected"; refund.reviewedBy = actor(req).role; refund.reviewedAt = new Date().toISOString();
    await db.persist("refunds", refund as unknown as Record<string, unknown>);
    const record = db.cases.find(item => item.id === refund.caseId); if (record) { record.status = "rejected"; record.updatedAt = refund.reviewedAt; await db.persist("cases", record as unknown as Record<string, unknown>); }
    audit(db, req, "refund.rejected", "refund", refund.id, "Administrator rejected the refund request.");
    res.json(refund);
  }));
  app.post("/api/refunds/:id/simulate", protect(["admin"]), asyncRoute(async (req, res) => {
    const refund = db.refunds.find(item => item.id === req.params.id);
    if (!refund || refund.status !== "approved") return res.status(409).json({ error: { code: "APPROVAL_REQUIRED", message: "A pending refund must be approved before simulation." } });
    refund.status = "simulated"; await db.persist("refunds", refund as unknown as Record<string, unknown>);
    const record = db.cases.find(item => item.id === refund.caseId); if (record) { record.status = "resolved"; record.updatedAt = new Date().toISOString(); await db.persist("cases", record as unknown as Record<string, unknown>); }
    audit(db, req, "refund.simulated", "refund", refund.id, `$${refund.amount.toFixed(2)} ${refund.currency}; demo simulation only, no funds moved.`);
    res.json({ ...refund, message: "Refund simulated in demo mode. No payment was moved." });
  }));
  app.get("/api/settings", protect(["admin"]), (_req, res) => res.json({ database: db.mode, persistence: db.mode === "mongodb" ? "persistent" : "in-memory", aiProvider: process.env.OPENAI_API_KEY ? "OpenAI" : "Deterministic demo", aiConfigured: Boolean(process.env.OPENAI_API_KEY), approvalLimit: Number(process.env.REFUND_APPROVAL_LIMIT || 200), port: Number(process.env.PORT || 4000), role: "admin" }));

  app.use((req, res, next) => { if (req.path.startsWith("/api/")) return res.status(404).json({ error: { code: "NOT_FOUND", message: "API endpoint not found." } }); next(); });
  const frontendDirectory = [resolve(process.cwd(), "client", "dist"), resolve(process.cwd(), "..", "client", "dist")].find(existsSync);
  if (frontendDirectory) {
    app.use(express.static(frontendDirectory, { index: false, maxAge: process.env.NODE_ENV === "production" ? "1h" : 0 }));
    app.get("*", (_req, res) => res.sendFile(resolve(frontendDirectory, "index.html")));
  }
  app.use((_req, res) => res.status(404).json({ error: { code: "NOT_FOUND", message: "API endpoint not found." } }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void _next;
    console.error("API request failed:", error instanceof Error ? error.message : error);
    const status = error instanceof z.ZodError || (typeof error === "object" && error !== null && "status" in error && (error as { status: number }).status === 400) ? 400 : 500;
    res.status(status).json({ error: { code: status === 400 ? "INVALID_REQUEST" : "INTERNAL_ERROR", message: status === 400 ? "Request validation failed." : "The server could not complete this request." } });
  });
  return app;
}
