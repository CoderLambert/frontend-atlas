import "server-only";

import { openSqliteDatabase } from "./sqlite.ts";

export { openSqliteDatabase } from "./sqlite.ts";

type OpenDatabase = ReturnType<typeof openSqliteDatabase>;
type DatabaseGlobal = typeof globalThis & { __frontendAtlasDatabase?: OpenDatabase };

const globalDatabase = globalThis as DatabaseGlobal;
const databasePath = process.env.FRONTEND_ATLAS_DB_PATH ?? "./.local-data/coach.sqlite";

export const database = globalDatabase.__frontendAtlasDatabase ?? openSqliteDatabase(databasePath);
globalDatabase.__frontendAtlasDatabase = database;

export const db = database.db;
