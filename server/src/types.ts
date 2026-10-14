export type Role = "agent" | "admin";
export type CaseStatus = "new" | "investigating" | "reviewed" | "escalated" | "approved" | "rejected" | "resolved";
export type OrderStatus = "delivered" | "in_transit" | "lost" | "cancelled";
export type IssueType = "damaged_item" | "late_delivery" | "missing_order" | "duplicate_charge" | "subscription_refund" | "refund_request" | "other";

export interface Customer { id: string; name: string; email: string; createdAt: string }
export interface Order { id: string; customerId: string; item: string; amount: number; currency: string; status: OrderStatus; orderedAt: string; deliveredAt?: string; promisedAt?: string; category: "physical" | "digital"; usagePercent?: number }
export interface Policy { id: string; title: string; category: string; body: string; updatedAt: string; version?: string; source?: string; synthetic?: boolean }
export interface CaseRecord { id: string; customerId: string; customerName: string; email: string; subject: string; message: string; orderId?: string; status: CaseStatus; issueType?: IssueType; createdAt: string; updatedAt: string; assignedTo?: string; investigationId?: string; refundId?: string }
export interface PolicyEvidence { policyId: string; title: string; excerpt: string; score: number; chunkId?: string; citationId?: string; version?: string; source?: string; section?: string; retrievalMode?: "semantic" | "keyword_fallback" }
export interface Investigation { id: string; caseId: string; orderId?: string; issueType: IssueType; recommendation: "refund_recommended" | "more_information" | "escalate" | "not_eligible"; eligible: boolean; requiresHumanApproval: boolean; confidence: number; explanation: string; evidence: PolicyEvidence[]; validatedCitations: string[]; citationStatus: "validated" | "rejected" | "not_applicable"; orderEvidence: string[]; aiMode: "demo" | "openai" | "rules"; retrievalMode: "semantic" | "keyword_fallback" | "none"; createdAt: string }
export interface Refund { id: string; caseId: string; orderId: string; customerId: string; amount: number; currency: string; status: "pending_approval" | "approved" | "rejected" | "simulated"; requestedBy: string; reviewedBy?: string; reviewedAt?: string; createdAt: string }
export interface AuditEvent { id: string; actor: string; role: Role | "system"; action: string; entityType: string; entityId: string; details: string; createdAt: string }
export interface Analytics { totalCases: number; openCases: number; escalatedCases: number; resolvedCases: number; approvedRefunds: number; simulatedRefunds: number; resolutionRate: number; casesByStatus: Record<string, number>; casesByIssue: Record<string, number> }

export interface DatabaseState {
  mode: "memory" | "mongodb";
  customers: Customer[];
  orders: Order[];
  policies: Policy[];
  cases: CaseRecord[];
  investigations: Investigation[];
  refunds: Refund[];
  audit: AuditEvent[];
  persist: (collection: "customers" | "orders" | "policies" | "cases" | "investigations" | "refunds" | "audit", record: Record<string, unknown>) => Promise<void>;
}
