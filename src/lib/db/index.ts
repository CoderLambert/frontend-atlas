import "server-only";

import { openSqliteDatabase } from "./sqlite.ts";

export { openSqliteDatabase } from "./sqlite.ts";

type OpenDatabase = ReturnType<typeof openSqliteDatabase>;
type DatabaseGlobal = typeof globalThis & {
  __frontendAtlasDatabase?: OpenDatabase;
  __frontendAtlasDatabaseExitCleanup?: boolean;
};

const globalDatabase = globalThis as DatabaseGlobal;
const databasePath = process.env.FRONTEND_ATLAS_DB_PATH ?? "./.local-data/coach.sqlite";

export const database = globalDatabase.__frontendAtlasDatabase ?? openSqliteDatabase(databasePath);
globalDatabase.__frontendAtlasDatabase = database;
if (!globalDatabase.__frontendAtlasDatabaseExitCleanup) {
  globalDatabase.__frontendAtlasDatabaseExitCleanup = true;
  process.once("exit", () => {
    try { database.client.close(); } catch { /* It may already be closed during shutdown. */ }
  });
}

export const db = database.db;
