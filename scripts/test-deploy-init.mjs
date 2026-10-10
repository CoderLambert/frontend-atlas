import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-deploy-init-"));
const helper = path.join(fixture, "deploy.sh");
const secret = "test-only-deployment-secret-0123456789abcdef";
await fs.copyFile(new URL("../deploy.sh", import.meta.url), helper);
await fs.chmod(helper, 0o700);

function runInit(input) {
  return spawnSync("bash", [helper, "init"], {
    input,
    encoding: "utf8",
    env: { ...process.env, HOME: fixture },
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
    const run = runInit(inputs(mode, location));
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
test -d "$DEPLOY_TEST_ROOT/.local-data/deploy"
test -d "$DEPLOY_TEST_ROOT/.local-data/backups"
test "$(stat -c '%u:%g' "$DEPLOY_TEST_ROOT/.local-data/deploy")" = "${process.getuid()}:${process.getgid()}"
test "$(stat -c '%u:%g' "$DEPLOY_TEST_ROOT/.local-data/backups")" = "${process.getuid()}:${process.getgid()}"
touch "$DEPLOY_TEST_ROOT/first-compose-called"
if [[ "$1" == compose && "$2" == version ]]; then exit 0; fi
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

  const lockPath = path.join(storage, ".deploy.lock");
  const lockHolder = spawn("flock", ["-n", lockPath, "sleep", "1"], { stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const concurrent = spawnSync("bash", [storageHelper, "init"], { input: inputs("local", "3010"), encoding: "utf8" });
  assert.notEqual(concurrent.status, 0, "a second deployment mutation must not enter while another process holds the lock");
  assert.match(concurrent.stderr, /Another deployment operation is active/u);
  const lockReleased = new Promise((resolve) => lockHolder.once("exit", resolve));
  // Let flock and its child finish naturally: killing only the flock parent can leave
  // the child holding the inherited advisory-lock file descriptor until it exits.
  await lockReleased;

  await fs.writeFile(path.join(storage, ".env.deploy"), localConfig, { mode: 0o600 });
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
  process.stdout.write("One-click local/public initialization, URL validation, secret handling, and hostile input checks passed.\n");
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
}
