import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { startFrontendAfterBackendReady } from "./local-runner-utils.mjs";

test("backend is stopped if its readiness wait fails before the UI starts", async () => {
  const backend = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(backend, "spawn");
  let uiStarted = false;

  await assert.rejects(startFrontendAfterBackendReady({
    backend,
    waitForBackend: async () => { throw new Error("local backend health timeout"); },
    startFrontend: () => { uiStarted = true; return null; },
  }), /local backend health timeout/u);

  assert.equal(uiStarted, false);
  assert.equal(backend.signalCode, "SIGTERM");
});
