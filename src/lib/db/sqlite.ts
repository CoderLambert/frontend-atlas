import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.ts";

export function openSqliteDatabase(path: string) {
  if (path !== ":memory:") {
    const resolvedPath = isAbsolute(path) ? path : resolve(process.cwd(), path);
    mkdirSync(dirname(resolvedPath), { recursive: true });
    path = resolvedPath;
  }

  const client = new BetterSqlite3(path);
  client.pragma("foreign_keys = ON");
  client.pragma("busy_timeout = 5000");
  client.pragma("journal_mode = WAL");

  return { client, db: drizzle({ client, schema }) };
}
