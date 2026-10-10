import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const databasePath = path.resolve(process.env.FRONTEND_ATLAS_DB_PATH ?? "/data/coach.sqlite");
const destination = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!destination || destination === databasePath) {
  process.stderr.write("Usage: node scripts/backup-sqlite.mjs /data/backups/NAME.sqlite\n");
  process.exit(2);
}
await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
try {
  await fs.access(destination);
  process.stderr.write("Refusing to overwrite an existing backup file.\n");
  process.exit(1);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const source = new Database(databasePath, { readonly: true, fileMustExist: true });
try {
  await source.backup(destination);
} finally {
  source.close();
}
const check = new Database(destination, { readonly: true, fileMustExist: true });
try {
  if (check.pragma("quick_check", { simple: true }) !== "ok") throw new Error("Backup failed SQLite quick_check.");
} finally {
  check.close();
}
process.stdout.write(`Consistent SQLite backup created at ${destination}.\n`);
