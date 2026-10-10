import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-deploy-db-"));
const source = path.join(directory, "coach.sqlite");
const backup = path.join(directory, "backup.sqlite");
const restored = path.join(directory, "restored.sqlite");
const db = new Database(source);
db.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO sample (value) VALUES ('before');");
db.close();

const run = (script, args, expectedStatus, frontEndDbPath = source) => {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, FRONTEND_ATLAS_DB_PATH: frontEndDbPath },
    encoding: "utf8",
  });
  assert.equal(result.status, expectedStatus, `${script}: ${result.stderr}`);
  return result;
};
run("scripts/backup-sqlite.mjs", [backup], 0);
const original = new Database(source);
original.prepare("UPDATE sample SET value='after' WHERE id=1").run();
original.close();
const snapshot = new Database(backup, { readonly: true });
assert.equal(snapshot.prepare("SELECT value FROM sample WHERE id=1").get().value, "before");
snapshot.close();
run("scripts/restore-sqlite.mjs", [`--source=${backup}`, `--target=${restored}`, `--confirm-target=${restored}`], 0);
const restoredDb = new Database(restored, { readonly: true });
assert.equal(restoredDb.prepare("SELECT value FROM sample WHERE id=1").get().value, "before");
restoredDb.close();
const target = new Database(source);
target.prepare("UPDATE sample SET value='current' WHERE id=1").run();
target.close();
run("scripts/restore-sqlite.mjs", [`--source=${backup}`, `--target=${source}`, `--confirm-target=${source}`], 1);
run("scripts/restore-sqlite.mjs", [`--source=${backup}`, `--target=${source}`, `--confirm-target=${source}`, "--replace-existing"], 0);
assert.ok((await fs.readdir(directory)).some((name) => name.startsWith("coach.sqlite.pre-restore-") && name.endsWith(".sqlite")));
await fs.rm(directory, { recursive: true, force: true });
process.stdout.write("Consistent SQLite backup and explicitly confirmed restore checks passed.\n");
