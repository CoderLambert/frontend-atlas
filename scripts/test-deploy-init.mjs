import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-deploy-init-"));
const helper = path.join(fixture, "deploy.sh");
const secret = "test-only-deployment-secret-0123456789abcdef";
const minimalBin = path.join(fixture, "minimal-bin");
await fs.copyFile(new URL("../deploy.sh", import.meta.url), helper);
await fs.chmod(helper, 0o700);
await fs.mkdir(minimalBin);
for (const command of ["bash", "chmod", "dirname", "flock", "id"]) {
  const source = spawnSync("which", [command], { encoding: "utf8" }).stdout.trim();
  assert.ok(source, `${command} is available for the minimal host setup fixture`);
  await fs.symlink(source, path.join(minimalBin, command));
}

function runInit(input, pathValue = process.env.PATH) {
  return spawnSync("bash", [helper, "init"], {
    input,
    encoding: "utf8",
    env: { ...process.env, HOME: fixture, PATH: pathValue },
  });
}

function inputs(mode, location) {
  return `${mode}\n${location}\n${secret}\n\n\n\n\n`;
}

try {
  assert.notEqual(process.getuid?.(), 0, "deployment initialization must be tested as an unprivileged user");
  for (const [mode, location, expectedUrl, expectedHost] of [
    ["local", "3010", "http://127.0.0.1:3010", ""],
    ["public", "Learn.Example.org", "https://learn.example.org", "learn.example.org"],
  ]) {
    const run = runInit(inputs(mode, location), minimalBin);
    assert.equal(run.status, 0, `${mode} init failed: ${run.stderr}`);
    assert.ok(!run.stdout.includes(secret) && !run.stderr.includes(secret), "initializer must not echo the Better Auth secret");
    const content = await fs.readFile(path.join(fixture, ".env.deploy"), "utf8");
    assert.match(content, new RegExp(`^PUBLIC_URL=${expectedUrl.replaceAll(".", "\\.")}$`, "mu"));
    assert.match(content, new RegExp(`^PUBLIC_HOST=${expectedHost.replaceAll(".", "\\.")}$`, "mu"));
    assert.match(content, new RegExp(`^APP_UID=${process.getuid()}$`, "mu"));
    assert.match(content, new RegExp(`^APP_GID=${process.getgid()}$`, "mu"));
    assert.match(content, new RegExp(`^BETTER_AUTH_SECRET=${secret}$`, "mu"));
    const configStat = await fs.stat(path.join(fixture, ".env.deploy"));
    assert.equal(configStat.mode & 0o777, 0o600, "deployment secrets must be private to the operator");
    await fs.rm(path.join(fixture, ".env.deploy"));
  }

  for (const hostname of [
    "https://evil.example", "evil.example:443", "user@evil.example", "evil.example/path",
    "evil.example?x=1", "evil..example", "127.0.0.1", `$(touch ${path.join(fixture, "pwned")}).example`,
    "evil.example\nBETTER_AUTH_SECRET=attacker",
  ]) {
    const run = runInit(inputs("public", hostname));
    assert.notEqual(run.status, 0, `invalid public host was accepted: ${JSON.stringify(hostname)}`);
    assert.ok(!run.stdout.includes(secret) && !run.stderr.includes(secret), "invalid config failure must not echo secrets");
    await fs.rm(path.join(fixture, ".env.deploy"), { force: true });
  }

  const invalidPort = runInit(inputs("local", "0"));
  assert.notEqual(invalidPort.status, 0, "port zero must be rejected");
  await fs.rm(path.join(fixture, ".env.deploy"), { force: true });

  const mismatchedCredentials = runInit(`public\nvalid.example\n${secret}\nclient-id\n\n\n\n`);
  assert.notEqual(mismatchedCredentials.status, 0, "OAuth client ID without its secret must be rejected");
  await fs.rm(path.join(fixture, ".env.deploy"), { force: true });

  const marker = path.join(fixture, "pwned");
  assert.equal(await fs.access(marker).then(() => true, () => false), false, "untrusted input must never execute shell commands");

  const storage = path.join(fixture, "storage-check");
  const fakeBin = path.join(storage, "bin");
  const storageHelper = path.join(storage, "deploy.sh");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.copyFile(helper, storageHelper);
  await fs.chmod(storageHelper, 0o700);
  const composeMarker = path.join(storage, "first-compose-called");
  await fs.writeFile(path.join(fakeBin, "docker"), `#!/usr/bin/env bash
set -euo pipefail
test -d "$DEPLOY_TEST_ROOT/.local-data/deploy"
test -d "$DEPLOY_TEST_ROOT/.local-data/backups"
test "$(stat -c '%u:%g' "$DEPLOY_TEST_ROOT/.local-data/deploy")" = "${process.getuid()}:${process.getgid()}"
test "$(stat -c '%u:%g' "$DEPLOY_TEST_ROOT/.local-data/backups")" = "${process.getuid()}:${process.getgid()}"
touch "$DEPLOY_TEST_ROOT/first-compose-called"
if [[ "$1" == compose && "$2" == version ]]; then exit 0; fi
if [[ "$*" == *" ps"* || "$*" == *" logs"* ]]; then exit 0; fi
exit 87
`);
  await fs.chmod(path.join(fakeBin, "docker"), 0o700);
  const localConfig = `DEPLOYMENT_MODE=local
PUBLIC_URL=http://127.0.0.1:3010
PUBLIC_HOST=
APP_PORT=3010
APP_UID=${process.getuid()}
APP_GID=${process.getgid()}
BETTER_AUTH_SECRET=${secret}
`;
  await fs.writeFile(path.join(storage, ".env.deploy"), localConfig, { mode: 0o600 });
  const storageRun = spawnSync("bash", [storageHelper, "up"], {
    encoding: "utf8",
    env: { ...process.env, HOME: fixture, PATH: `${fakeBin}:${process.env.PATH}`, DEPLOY_TEST_ROOT: storage },
  });
  assert.equal(storageRun.status, 87, `the first Docker invocation should be reached only after storage is ready: ${storageRun.stderr}`);
  assert.equal(await fs.access(composeMarker).then(() => true, () => false), true);
  await fs.rm(path.join(storage, ".local-data"), { recursive: true, force: true });
  await fs.rm(composeMarker, { force: true });
  await fs.writeFile(path.join(storage, ".env.deploy"), localConfig.replace(`APP_UID=${process.getuid()}`, `APP_UID=${process.getuid() + 10000}`), { mode: 0o600 });
  const uidMismatch = spawnSync("bash", [storageHelper, "up"], {
    encoding: "utf8",
    env: { ...process.env, HOME: fixture, PATH: `${fakeBin}:${process.env.PATH}`, DEPLOY_TEST_ROOT: storage },
  });
  assert.notEqual(uidMismatch.status, 0, "mismatched APP_UID must fail closed");
  assert.match(uidMismatch.stderr, /APP_UID\/APP_GID must match/u);
  assert.equal(await fs.access(composeMarker).then(() => true, () => false), false, "mismatched operator ownership must fail before any Docker call");
  assert.equal(await fs.access(path.join(storage, ".local-data")).then(() => true, () => false), false, "mismatched ownership must not create data directories");

  await fs.mkdir(path.join(storage, ".local-data", "deploy"), { recursive: true });
  await fs.mkdir(path.join(storage, ".local-data", "backups"), { recursive: true });
  const lockPath = path.join(storage, ".deploy.lock");
  const lockHolder = spawn("flock", ["-n", lockPath, "sleep", "1"], { stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const concurrent = spawnSync("bash", [storageHelper, "init"], { input: inputs("local", "3010"), encoding: "utf8" });
  assert.notEqual(concurrent.status, 0, "a second deployment mutation must not enter while another process holds the lock");
  assert.match(concurrent.stderr, /Another deployment operation is active/u);
  const lockedEnv = { ...process.env, HOME: fixture, PATH: `${fakeBin}:${process.env.PATH}`, DEPLOY_TEST_ROOT: storage };
  const statusWhileLocked = spawnSync("bash", [storageHelper, "status"], { encoding: "utf8", env: lockedEnv });
  assert.equal(statusWhileLocked.status, 0, `read-only status must not wait for a long-running deploy lock: ${statusWhileLocked.stderr}`);
  const logsWhileLocked = spawnSync("bash", [storageHelper, "logs"], { encoding: "utf8", env: lockedEnv });
  assert.equal(logsWhileLocked.status, 0, `streaming logs must not wait for a deployment mutation lock: ${logsWhileLocked.stderr}`);
  const lockReleased = new Promise((resolve) => lockHolder.once("exit", resolve));
  // Let flock and its child finish naturally: killing only the flock parent can leave
  // the child holding the inherited advisory-lock file descriptor until it exits.
  await lockReleased;

  await fs.writeFile(path.join(storage, ".env.deploy"), localConfig, { mode: 0o600 });
  const deploymentData = path.join(storage, ".local-data", "deploy");
  await fs.mkdir(deploymentData, { recursive: true });
  const protectedMarker = path.join(deploymentData, "existing.sqlite");
  await fs.writeFile(protectedMarker, "keep existing data");
  const originalMode = (await fs.stat(deploymentData)).mode & 0o777;
  const realStat = spawnSync("which", ["stat"], { encoding: "utf8" }).stdout.trim();
  const fakeStat = path.join(fakeBin, "stat");
  await fs.writeFile(fakeStat, `#!/usr/bin/env bash
if [[ "${"$4"}" == "$DEPLOY_TEST_ROOT/.local-data/deploy" && "$2" == '%u' ]]; then printf '999\n'; exit 0; fi
exec "${realStat}" "$@"
`);
  await fs.chmod(fakeStat, 0o700);
  await fs.rm(composeMarker, { force: true });
  const wrongOwner = spawnSync("bash", [storageHelper, "up"], {
    encoding: "utf8",
    env: { ...process.env, HOME: fixture, PATH: `${fakeBin}:${process.env.PATH}`, DEPLOY_TEST_ROOT: storage },
  });
  assert.notEqual(wrongOwner.status, 0, "existing deployment data with a different owner must fail closed");
  assert.match(wrongOwner.stderr, /belongs to UID:GID/u);
  assert.equal(await fs.access(composeMarker).then(() => true, () => false), false, "ownership refusal must happen before any Docker call");
  assert.equal((await fs.stat(deploymentData)).mode & 0o777, originalMode, "ownership refusal must not chmod an existing data directory");
  assert.equal(await fs.readFile(protectedMarker, "utf8"), "keep existing data", "ownership refusal must not alter existing data");
  await fs.rm(fakeStat);

  const fakeStateDocker = path.join(fakeBin, "docker");
  await fs.writeFile(fakeStateDocker, `#!/usr/bin/env bash
if [[ "$*" == *" ps -a -q app" ]]; then printf 'test-container-id\\n'; exit 0; fi
if [[ "$*" == *"inspect --format"* ]]; then printf '%s\\n' "$DEPLOY_FAKE_STATE"; exit 0; fi
exit 86
`);
  await fs.chmod(fakeStateDocker, 0o700);
  const backup = path.join(storage, "snapshot.sqlite");
  await fs.writeFile(backup, "isolated test fixture");
  for (const state of ["running", "restarting", "created", "paused"]) {
    const restore = spawnSync("bash", [storageHelper, "restore", backup, "/data/coach.sqlite"], {
      input: "",
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, DEPLOY_TEST_ROOT: storage, DEPLOY_FAKE_STATE: state },
    });
    assert.notEqual(restore.status, 0, `restore must reject an app in ${state} state`);
    assert.match(restore.stderr, new RegExp(`App container state is '${state}'`, "u"));
    assert.equal(await fs.readFile(backup, "utf8"), "isolated test fixture", "refused restore must preserve its source backup");
  }
  process.stdout.write("One-click local/public initialization, Node-free host requirements, URL validation, secret handling, operator ownership, mutation locking, and hostile input checks passed.\n");
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
}
