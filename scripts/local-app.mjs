import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFrontendAfterBackendReady, terminateChild } from "./local-runner-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
const hostedDeployment = process.env.FRONTEND_ATLAS_DEPLOYMENT_MODE === "hosted";
const appHost = process.env.FRONTEND_ATLAS_BIND_HOST ?? "127.0.0.1";
const appPort = Number(process.env.FRONTEND_ATLAS_APP_PORT ?? 3000);
const allowedModes = new Set(["dev", "build", "start"]);
if (!allowedModes.has(mode)) {
  process.stderr.write("Use one of: dev, build, start.\n");
  process.exit(2);
}

const env = {
  ...process.env,
  FRONTEND_ATLAS_LOCAL_MODE: "1",
  FRONTEND_ATLAS_SIWC_SERVICE_TOKEN: process.env.FRONTEND_ATLAS_SIWC_SERVICE_TOKEN ?? randomBytes(32).toString("base64url"),
  NEXT_PUBLIC_FRONTEND_ATLAS_LOCAL_MODE: "1",
  NEXT_TELEMETRY_DISABLED: "1",
};
if (mode === "dev" && process.env.FRONTEND_ATLAS_MOCK_ASSISTANT === "1") {
  env.FRONTEND_ATLAS_MOCK_ASSISTANT = "1";
} else {
  delete env.FRONTEND_ATLAS_MOCK_ASSISTANT;
}
const node = process.execPath;
const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const localServer = path.join(root, "server", "index.mjs");

function runSync(scriptPath) {
  const result = spawnSync(node, [scriptPath], { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error) => {
      if (error?.code === "EADDRINUSE") reject(new Error(`Port ${port} is already in use; the local app will not switch to another port.`));
      else reject(error);
    });
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
}

async function waitForLocalService(child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("The local SIWC service exited before it became ready.");
    try {
      const response = await fetch("http://127.0.0.1:4317/health", { signal: AbortSignal.timeout(500) });
      const data = await response.json();
      if (response.ok && data?.ok === true && data?.localOnly === true) return;
    } catch { /* The local service is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("The local SIWC service did not become ready.");
}

async function main() {
  if (!Number.isInteger(appPort) || appPort < 1 || appPort > 65_535) throw new Error("FRONTEND_ATLAS_APP_PORT must be a valid TCP port.");
  if (mode === "build" || mode === "dev") runSync(path.join(root, "scripts", "generate-content-index.mjs"));
  if (mode === "build") {
    const result = spawnSync(node, [nextBin, "build"], { cwd: root, env, stdio: "inherit" });
    if (result.error) throw result.error;
    process.exit(result.status ?? 1);
  }

  await assertPortFree(appPort);
  if (!hostedDeployment) await assertPortFree(4317);
  const backend = hostedDeployment ? null : spawn(node, [localServer], { cwd: root, env, stdio: "inherit" });
  let next = null;
  const stopAll = async (exitCode = 0) => {
    await Promise.all([terminateChild(next), ...(backend ? [terminateChild(backend)] : [])]);
    process.exit(exitCode);
  };
  process.once("SIGINT", () => { void stopAll(0); });
  process.once("SIGTERM", () => { void stopAll(0); });
  backend?.once("exit", (code) => {
    if (next && next.exitCode === null) void stopAll(code ?? 1);
  });
  const command = mode === "dev" ? "dev" : "start";
  next = hostedDeployment
    ? spawn(node, [nextBin, command, "--hostname", appHost, "--port", String(appPort)], { cwd: root, env, stdio: "inherit" })
    : await startFrontendAfterBackendReady({
      backend,
      waitForBackend: waitForLocalService,
      startFrontend: () => spawn(node, [nextBin, command, "--hostname", appHost, "--port", String(appPort)], { cwd: root, env, stdio: "inherit" }),
    });
  next.once("exit", (code) => { void stopAll(code ?? 0); });
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
