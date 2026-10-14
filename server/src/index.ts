import "dotenv/config";
import { createApp } from "./app.js";
import { initializeDatabase } from "./database.js";

const requestedPort = Number(process.env.PORT || 4000);
if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) throw new Error("PORT must be a valid TCP port between 1 and 65535.");
if (process.env.NODE_ENV === "production" && (!process.env.DEMO_AGENT_TOKEN || !process.env.DEMO_ADMIN_TOKEN)) throw new Error("Set DEMO_AGENT_TOKEN and DEMO_ADMIN_TOKEN before starting in production.");
const db = await initializeDatabase();
const server = createApp(db).listen(requestedPort, "127.0.0.1", () => console.info(`ResolveAI API listening at http://127.0.0.1:${requestedPort} (${db.mode})`));
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") console.error(`Port ${requestedPort} is already in use. Close the other ResolveAI terminal with Ctrl+C, or set a different PORT and update the frontend proxy.`);
  else console.error("Could not start ResolveAI API:", error.message);
  process.exitCode = 1;
});
process.on("SIGINT", () => { server.close(() => { console.info("ResolveAI API stopped."); process.exit(0); }); });
