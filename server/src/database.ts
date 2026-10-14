import mongoose from "mongoose";
import type { DatabaseState } from "./types.js";
import { caseSeed, customerSeed, orderSeed, policySeed } from "./seed.js";
import { SupportCase } from "./models/Case.js";
import { AuditModel, CustomerModel, InvestigationModel, OrderModel, PolicyModel, RefundModel } from "./models/Records.js";

const memory: DatabaseState = {
  mode: "memory", customers: structuredClone(customerSeed), orders: structuredClone(orderSeed), policies: structuredClone(policySeed), cases: structuredClone(caseSeed), investigations: [], refunds: [], audit: [],
  async persist(collection, record) {
    if (this.mode !== "mongodb") return;
    const id = String(record.id);
    const data = { ...record };
    delete data.id;
    const model: any = ({ customers: CustomerModel, orders: OrderModel, policies: PolicyModel, cases: SupportCase, investigations: InvestigationModel, refunds: RefundModel, audit: AuditModel } as const)[collection];
    await model.findByIdAndUpdate(id, { $set: data, $setOnInsert: { _id: id } }, { upsert: true, new: true, runValidators: true });
  }
};

function clean(items: any[]): any[] { return items.map(({ _id, ...item }) => ({ ...item, id: String(_id) })); }
export async function initializeDatabase(uri = process.env.MONGODB_URI) {
  if (!uri?.trim()) return memory;
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 2500, connectTimeoutMS: 2500 });
    memory.mode = "mongodb";
    const [customers, orders, policies, cases, investigations, refunds, audit] = await Promise.all([
      CustomerModel.find().lean(), OrderModel.find().lean(), PolicyModel.find().lean(), SupportCase.find().lean(), InvestigationModel.find().lean(), RefundModel.find().lean(), AuditModel.find().sort({ createdAt: -1 }).limit(500).lean()
    ]);
    if (!customers.length) await CustomerModel.insertMany(customerSeed.map(({ id, ...item }) => ({ _id: id, ...item })));
    if (!orders.length) await OrderModel.insertMany(orderSeed.map(({ id, ...item }) => ({ _id: id, ...item })));
    if (!policies.length) await PolicyModel.insertMany(policySeed.map(({ id, ...item }) => ({ _id: id, ...item })));
    memory.customers = customers.length ? clean(customers as any) : structuredClone(customerSeed);
    memory.orders = orders.length ? clean(orders as any) : structuredClone(orderSeed);
    memory.policies = policies.length ? clean(policies as any) : structuredClone(policySeed);
    memory.cases = cases.length ? clean(cases as any) : structuredClone(caseSeed);
    memory.investigations = clean(investigations as any) as any;
    memory.refunds = clean(refunds as any) as any;
    memory.audit = clean(audit as any) as any;
    if (!cases.length) for (const item of memory.cases) await memory.persist("cases", item as any);
    await RefundModel.collection.createIndex({ orderId: 1 }, { unique: true });
  } catch (error) {
    memory.mode = "memory";
    try { await mongoose.disconnect(); } catch { /* connection already failed */ }
    console.warn("MongoDB unavailable; ResolveAI is using non-persistent demo memory.", error instanceof Error ? error.message : "connection error");
  }
  return memory;
}
export function getDatabase() { return memory; }
