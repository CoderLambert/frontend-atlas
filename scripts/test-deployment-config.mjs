import assert from "node:assert/strict";
import { validateDeploymentConfig } from "./validate-deployment-config.mjs";
import { createWriteRequestGuard } from "../src/lib/server/coach/write-request-guard.ts";

const base = {
  FRONTEND_ATLAS_DEPLOYMENT_MODE: "hosted",
  DEPLOYMENT_MODE: "local",
  PUBLIC_URL: "http://127.0.0.1:31873",
  FRONTEND_ATLAS_PUBLIC_URL: "http://127.0.0.1:31873",
  BETTER_AUTH_URL: "http://127.0.0.1:31873",
  BETTER_AUTH_SECRET: "deployment-test-secret-that-is-at-least-32-chars",
  APP_UID: "1000",
  APP_GID: "1000",
  APP_PORT: "31873",
  PUBLIC_HOST: "",
};
assert.equal(validateDeploymentConfig(base).ok, true);
assert.equal(validateDeploymentConfig({ ...base, PUBLIC_URL: "http://0.0.0.0:31873", FRONTEND_ATLAS_PUBLIC_URL: "http://0.0.0.0:31873", BETTER_AUTH_URL: "http://0.0.0.0:31873" }).ok, false);
assert.equal(validateDeploymentConfig({ ...base, PUBLIC_URL: "https://example.com/path", FRONTEND_ATLAS_PUBLIC_URL: "https://example.com/path", BETTER_AUTH_URL: "https://example.com/path" }).ok, false);
assert.equal(validateDeploymentConfig({ ...base, BETTER_AUTH_URL: "https://other.example" }).ok, false);
assert.equal(validateDeploymentConfig({ ...base, BETTER_AUTH_SECRET: "short" }).ok, false);
assert.equal(validateDeploymentConfig({ ...base, GITHUB_CLIENT_ID: "client" }).ok, false);

const publicConfig = {
  ...base,
  DEPLOYMENT_MODE: "public",
  PUBLIC_URL: "https://study.example.org",
  FRONTEND_ATLAS_PUBLIC_URL: "https://study.example.org",
  BETTER_AUTH_URL: "https://study.example.org",
  PUBLIC_HOST: "study.example.org",
  APP_PORT: "",
};
assert.equal(validateDeploymentConfig(publicConfig).ok, true);
assert.equal(validateDeploymentConfig({ ...publicConfig, PUBLIC_HOST: "attacker.example" }).ok, false);
assert.equal(validateDeploymentConfig({ ...publicConfig, PUBLIC_URL: "http://study.example.org", FRONTEND_ATLAS_PUBLIC_URL: "http://study.example.org", BETTER_AUTH_URL: "http://study.example.org" }).ok, false);

const guard = createWriteRequestGuard(publicConfig.BETTER_AUTH_URL);
const validWrite = new Request("https://study.example.org/api/questions/A01/private-override", {
  method: "POST",
  headers: { origin: publicConfig.BETTER_AUTH_URL, "sec-fetch-site": "same-origin", "x-frontend-atlas-request": "1", "content-type": "application/json" },
  body: "{}",
});
assert.equal(guard(validWrite), null);
const invalidOrigin = new Request("https://study.example.org/api/questions/A01/private-override", {
  method: "POST",
  headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site", "x-frontend-atlas-request": "1", "content-type": "application/json" },
  body: "{}",
});
assert.equal(guard(invalidOrigin)?.status, 403);

assert.equal(`${publicConfig.PUBLIC_URL}/api/auth/callback/github`, "https://study.example.org/api/auth/callback/github");
assert.equal(`${publicConfig.PUBLIC_URL}/api/auth/callback/google`, "https://study.example.org/api/auth/callback/google");
process.stdout.write("Deployment URL, local/public mode, origin guard, and OAuth callback checks passed.\n");
