import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.API_PROXY_TARGET || "http://127.0.0.1:4000";
  return { plugins: [react()], server: { host: "127.0.0.1", strictPort: true, proxy: { "/api": apiTarget } } };
});
