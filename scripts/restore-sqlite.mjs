import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const args = process.argv.slice(2);
function option(name) {
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}
const sourcePath = option("--source");
const targetPath = option("--target");
const confirmedTarget = option("--confirm-target");
const replaceExisting = args.includes("--replace-existing");
if (!sourcePath || !targetPath || !confirmedTarget || path.resolve(targetPath) !== path.resolve(confirmedTarget)) {
  process.stderr.write("Usage: node scripts/restore-sqlite.mjs --source=/data/backups/NAME.sqlite --target=/data/coach.sqlite --confirm-target=/data/coach.sqlite [--replace-existing]\n");
  process.exit(2);
}
const source = path.resolve(sourcePath);
const target = path.resolve(targetPath);
if (source === target) throw new Error("Backup source and restore target must be different files.");
await fs.access(source);
const sourceDb = new Database(source, { readonly: true, fileMustExist: true });
try {
  if (sourceDb.pragma("quick_check", { simple: true }) !== "ok") throw new Error("Restore source failed SQLite quick_check.");
} finally {
  sourceDb.close();
}

let existing = true;
try { await fs.access(target); } catch (error) {
  if (error?.code !== "ENOENT") throw error;
  existing = false;
}
if (existing && !replaceExisting) throw new Error("Target exists. Stop the app and pass --replace-existing after reviewing the target path.");
for (const suffix of ["-wal", "-shm"]) {
  try {
    await fs.access(target + suffix);
    throw new Error("SQLite target has live WAL sidecar files. Stop the app cleanly before restoring.");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("SQLite target")) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
}
const directory = path.dirname(target);
await fs.mkdir(directory, { recursive: true, mode: 0o700 });
const stage = `${target}.restore-${process.pid}`;
const backupSource = new Database(source, { readonly: true, fileMustExist: true });
try {
  await backupSource.backup(stage);
} finally {
  backupSource.close();
}
const stageDb = new Database(stage, { readonly: true, fileMustExist: true });
try {
  if (stageDb.pragma("quick_check", { simple: true }) !== "ok") throw new Error("Staged restore failed SQLite quick_check.");
} finally {
  stageDb.close();
}
if (existing) {
  const rollbackPath = `${target}.pre-restore-${new Date().toISOString().replace(/[:.]/gu, "-")}.sqlite`;
  const oldDb = new Database(target, { readonly: true, fileMustExist: true });
  try { await oldDb.backup(rollbackPath); } finally { oldDb.close(); }
}
await fs.rename(stage, target);
process.stdout.write("SQLite restore installed and passed quick_check. The app was not started.\n");
