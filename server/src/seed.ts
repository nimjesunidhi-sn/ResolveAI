import type { CaseRecord, Customer, Order } from "./types.js";
import { policySeed } from "./knowledge/policies.js";

const day = 86_400_000;
const ago = (n: number) => new Date(Date.now() - n * day).toISOString();
export const customerSeed: Customer[] = [
  { id: "cus-olivia", name: "Olivia Rhye", email: "olivia.rhye@email.com", createdAt: ago(120) },
  { id: "cus-phoenix", name: "Phoenix Baker", email: "phoenix@email.com", createdAt: ago(90) },
  { id: "cus-lana", name: "Lana Steiner", email: "lana@email.com", createdAt: ago(64) },
  { id: "cus-demi", name: "Demi Wilkinson", email: "demi@email.com", createdAt: ago(50) },
  { id: "cus-candice", name: "Candice Wu", email: "candice@email.com", createdAt: ago(32) },
  { id: "cus-alex", name: "Alex Morgan", email: "alex.morgan@email.com", createdAt: ago(12) }
];
export const orderSeed: Order[] = [
  { id: "ORD-7821", customerId: "cus-olivia", item: "Everyday Backpack", amount: 89, currency: "USD", status: "in_transit", orderedAt: ago(21), promisedAt: ago(14), category: "physical" },
  { id: "SUB-0293", customerId: "cus-phoenix", item: "Resolve Plus monthly subscription", amount: 24, currency: "USD", status: "delivered", orderedAt: ago(2), deliveredAt: ago(2), category: "digital", usagePercent: 35 },
  { id: "ORD-7742", customerId: "cus-lana", item: "Studio Headphones", amount: 149, currency: "USD", status: "delivered", orderedAt: ago(10), deliveredAt: ago(10), category: "physical" },
  { id: "SUB-0282", customerId: "cus-demi", item: "Resolve Pro annual subscription", amount: 180, currency: "USD", status: "delivered", orderedAt: ago(1), deliveredAt: ago(1), category: "digital", usagePercent: 4 },
  { id: "ORD-7704", customerId: "cus-candice", item: "Handblown Glass Vase", amount: 245, currency: "USD", status: "delivered", orderedAt: ago(4), deliveredAt: ago(3), category: "physical" },
  { id: "ORD-7699", customerId: "cus-alex", item: "Desk Lamp", amount: 72, currency: "USD", status: "delivered", orderedAt: ago(45), deliveredAt: ago(43), category: "physical" },
  { id: "ORD-7680", customerId: "cus-olivia", item: "Travel Organizer", amount: 42, currency: "USD", status: "lost", orderedAt: ago(30), promisedAt: ago(20), category: "physical" }
];
export const caseSeed: CaseRecord[] = [
  { id: "case-1048", customerId: "cus-olivia", customerName: "Olivia Rhye", email: "olivia.rhye@email.com", subject: "Package has not arrived", message: "My order was supposed to arrive last week and tracking has not updated. Can you help?", orderId: "ORD-7821", status: "new", createdAt: ago(0.2), updatedAt: ago(0.2) },
  { id: "case-1047", customerId: "cus-phoenix", customerName: "Phoenix Baker", email: "phoenix@email.com", subject: "Charged twice for subscription", message: "I noticed two charges for my monthly plan on my card. Please take a look.", orderId: "SUB-0293", status: "escalated", createdAt: ago(0.4), updatedAt: ago(0.4) },
  { id: "case-1046", customerId: "cus-lana", customerName: "Lana Steiner", email: "lana@email.com", subject: "Refund for defective headphones", message: "The headphones arrived with a broken left speaker. I purchased them 10 days ago and would like a refund.", orderId: "ORD-7742", status: "reviewed", createdAt: ago(1), updatedAt: ago(1) },
  { id: "case-1045", customerId: "cus-demi", customerName: "Demi Wilkinson", email: "demi@email.com", subject: "Cancel my annual plan", message: "I signed up yesterday and would like to cancel and get my payment back.", orderId: "SUB-0282", status: "reviewed", createdAt: ago(1.2), updatedAt: ago(1.2) },
  { id: "case-1044", customerId: "cus-candice", customerName: "Candice Wu", email: "candice@email.com", subject: "Order arrived damaged", message: "The glass item arrived shattered. I have photos if you need them.", orderId: "ORD-7704", status: "new", createdAt: ago(2), updatedAt: ago(2) },
  { id: "case-1043", customerId: "cus-alex", customerName: "Alex Morgan", email: "alex.morgan@email.com", subject: "Refund outside return window", message: "I bought this lamp about six weeks ago and want a refund. It works fine, but I no longer need it.", orderId: "ORD-7699", status: "resolved", createdAt: ago(4), updatedAt: ago(3) }
];
export { policySeed };
