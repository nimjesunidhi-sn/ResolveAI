import "dotenv/config";
import mongoose from "mongoose";
import { initializeDatabase } from "./database.js";

const db = await initializeDatabase();
if (db.mode === "memory") console.info("Demo seed data is ready in memory. Set MONGODB_URI to seed persistent MongoDB data.");
else console.info(`MongoDB seeded and ready: ${db.customers.length} customers, ${db.orders.length} orders, ${db.policies.length} policies, ${db.cases.length} cases.`);
await mongoose.disconnect();
