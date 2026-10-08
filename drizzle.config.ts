import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./src/lib/db/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.FRONTEND_ATLAS_DB_PATH ?? "./.local-data/coach.sqlite",
  },
});
