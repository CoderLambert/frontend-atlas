import { spawn } from "node:child_process";
import { validateDeploymentConfig } from "./validate-deployment-config.mjs";

process.umask(0o077);
const validation = validateDeploymentConfig();
if (!validation.ok) {
  process.stderr.write(`Deployment configuration is invalid: ${validation.errors.join("; ")}\n`);
  process.exit(1);
}

const migration = spawn(process.execPath, [
  "--conditions=react-server",
  "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
  "--experimental-strip-types",
  "scripts/migrate-sqlite.mjs",
], { stdio: "inherit", env: process.env });
migration.once("error", (error) => {
  process.stderr.write(`Database migration could not start: ${error.message}\n`);
  process.exit(1);
});
migration.once("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  const app = spawn(process.execPath, ["scripts/local-app.mjs", "start"], { stdio: "inherit", env: process.env });
  const forward = (signal) => { if (app.exitCode === null) app.kill(signal); };
  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));
  app.once("error", (error) => {
    process.stderr.write(`Web server could not start: ${error.message}\n`);
    process.exit(1);
  });
  app.once("exit", (appCode) => process.exit(appCode ?? 1));
});
