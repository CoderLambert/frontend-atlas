import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { openSqliteDatabase } from "../src/lib/db/sqlite.ts";
import { isSiteRole, SiteRoleRepository, validateAuditActor } from "../src/lib/server/site-roles.ts";

const args = process.argv.slice(2);
const command = args.shift();
const configuredDatabasePath = process.env.FRONTEND_ATLAS_DB_PATH ?? "./.local-data/coach.sqlite";
const databasePath = isAbsolute(configuredDatabasePath) ? configuredDatabasePath : resolve(process.cwd(), configuredDatabasePath);

function argument(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function usage() {
  process.stderr.write([
    "Trusted local role administration:",
    "  npm run site:roles -- list [--user-id <better-auth-user-id>]",
    "  npm run site:roles -- grant --user-id <id> --role <reviewer|operator> --created-by <local-admin>",
    "  npm run site:roles -- revoke --user-id <id> --role <reviewer|operator> --revoked-by <local-admin>",
    "",
    "This command prints role audit metadata only. It never reads or prints account/session tokens.",
  ].join("\n") + "\n");
}

let opened;
try {
  if (!new Set(["list", "grant", "revoke"]).has(command)) {
    usage();
    process.exitCode = 2;
  } else {
    if (!existsSync(databasePath)) throw new Error(`Refusing to create an empty SQLite database at ${databasePath}.`);
    opened = openSqliteDatabase(databasePath);
    const table = opened.client.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'site_role_grants'").get();
    if (!table) throw new Error("site_role_grants is missing; apply the reviewed migration before changing roles.");
    const roles = new SiteRoleRepository(opened.db);
    const userId = argument("--user-id");
    if (command === "list") {
      const rows = roles.list(userId ?? undefined).map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        revokedAt: row.revokedAt?.toISOString() ?? null,
      }));
      process.stdout.write(JSON.stringify({ databasePath, grants: rows }, null, 2) + "\n");
    } else {
      const role = argument("--role");
      const actor = validateAuditActor(argument(command === "grant" ? "--created-by" : "--revoked-by"));
      if (!userId || !isSiteRole(role) || !actor) {
        usage();
        process.exitCode = 2;
      } else {
        const result = command === "grant" ? roles.grant(userId, role, actor) : roles.revoke(userId, role, actor);
        if (result.kind === "user-not-found") throw new Error("The requested Better Auth user does not exist in this database.");
        process.stdout.write(`${result.kind}: ${role} for Better Auth user ${userId}.\n`);
      }
    }
  }
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
} finally {
  opened?.client.close();
}
