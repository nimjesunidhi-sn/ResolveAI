import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const serverDirectory = resolve(root, "server");
const clientDirectory = resolve(root, "client");
const typescriptCli = resolve(root, "node_modules/typescript/bin/tsc");
const viteCli = resolve(root, "node_modules/vite/bin/vite.js");

function runNode(args, cwd) {
  return spawn(process.execPath, args, { cwd, env: process.env, stdio: "inherit", windowsHide: true });
}

async function portIsAvailable(port) {
  return new Promise(resolveAvailable => {
    const probe = createServer();
    probe.once("error", () => resolveAvailable(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolveAvailable(true)));
  });
}

const backendPort = Number(process.env.PORT || 4000);
for (const [name, port] of [["backend", backendPort], ["frontend", 5173]]) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Cannot start ResolveAI: ${name} port must be a valid TCP port.`);
    process.exit(1);
  }
  if (!await portIsAvailable(port)) {
    console.error(`Cannot start ResolveAI: port ${port} for the ${name} is already in use. Reuse the running ResolveAI service or close its own terminal with Ctrl+C. This runner will not stop a process it did not start.`);
    process.exit(1);
  }
}

const compile = runNode([typescriptCli, "-p", "tsconfig.json"], serverDirectory);
const compileCode = await new Promise((resolveExit, reject) => {
  compile.once("error", reject);
  compile.once("close", code => resolveExit(code ?? 1));
});
if (compileCode !== 0) process.exit(compileCode);

const children = [
  { name: "backend", process: runNode(["dist/index.js"], serverDirectory) },
  { name: "frontend", process: runNode([viteCli, "--host", "127.0.0.1", "--strictPort"], clientDirectory) }
];
let stopping = false;
let exitStatus = 0;
let resolveChildren;
const allClosed = new Promise(resolveDone => { resolveChildren = resolveDone; });
let remaining = children.length;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  exitStatus = code;
  for (const child of children) {
    if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill();
  }
}

for (const child of children) {
  child.process.once("error", error => {
    console.error(`Could not start ResolveAI ${child.name}: ${error.message}`);
    stop(1);
  });
  child.process.once("close", (code, signal) => {
    remaining -= 1;
    if (!stopping) {
      const result = signal ? `signal ${signal}` : `exit code ${code ?? 1}`;
      console.error(`ResolveAI ${child.name} stopped with ${result}; stopping the other service.`);
      stop(code ?? 1);
    }
    if (remaining === 0) resolveChildren();
  });
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
await allClosed;
process.exitCode = exitStatus;
