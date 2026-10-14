import mongoose, { Schema } from "mongoose";

const caseSchema = new Schema({
  _id: { type: String },
  customer: { type: String, default: "" },
  email: { type: String, default: "" },
  subject: { type: String, required: true },
  message: { type: String, required: true },
  orderId: { type: String, default: "" },
  status: { type: String, enum: ["new", "investigating", "reviewed", "escalated", "approved", "rejected", "resolved"], default: "new" },
  decision: { type: String, default: "" },
  confidence: { type: Number, default: 0 },
  reasoning: { type: String, default: "" },
  policyFindings: { type: [String], default: [] }
}, { timestamps: true, strict: false, versionKey: false });

export const SupportCase = mongoose.model("SupportCase", caseSchema);
