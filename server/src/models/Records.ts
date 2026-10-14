import mongoose, { Schema } from "mongoose";

const makeSchema = (extra: Record<string, unknown> = {}) => new Schema({ _id: { type: String }, ...extra }, { strict: false, timestamps: false, versionKey: false });
export const CustomerModel = mongoose.models.Customer || mongoose.model("Customer", makeSchema(), "customers");
export const OrderModel = mongoose.models.Order || mongoose.model("Order", makeSchema(), "orders");
export const PolicyModel = mongoose.models.Policy || mongoose.model("Policy", makeSchema(), "policies");
export const InvestigationModel = mongoose.models.Investigation || mongoose.model("Investigation", makeSchema(), "investigations");
export const RefundModel = mongoose.models.Refund || mongoose.model("Refund", makeSchema({ orderId: { type: String, unique: true, index: true } }), "refunds");
export const AuditModel = mongoose.models.AuditEvent || mongoose.model("AuditEvent", makeSchema(), "audit_events");
