import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openSqliteDatabase } from "../src/lib/db/sqlite.ts";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const configuredPath = process.env.FRONTEND_ATLAS_DB_PATH ?? "./.local-data/coach.sqlite";
const databasePath = configuredPath === ":memory:"
  ? configuredPath
  : isAbsolute(configuredPath) ? configuredPath : resolve(projectRoot, configuredPath);
const allowInitialize = process.env.FRONTEND_ATLAS_ALLOW_DB_INITIALIZE === "1";

if (databasePath !== ":memory:" && !existsSync(databasePath) && !allowInitialize) {
  process.stderr.write(
    `Refusing to create an empty SQLite database at ${databasePath}. ` +
    "Mount the intended database or set FRONTEND_ATLAS_ALLOW_DB_INITIALIZE=1 for an explicit first initialization.\n",
  );
  process.exit(1);
}

const opened = openSqliteDatabase(databasePath);
try {
  migrate(opened.db, { migrationsFolder: resolve(projectRoot, "src/lib/db/migrations") });
  const integrity = opened.client.pragma("quick_check", { simple: true });
  if (integrity !== "ok") throw new Error(`SQLite quick_check failed: ${String(integrity)}`);
  process.stdout.write(`SQLite migrations verified at ${databasePath}.\n`);
} finally {
  opened.client.close();
}
