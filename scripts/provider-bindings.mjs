import { createCredentialStore } from "../server/storage.mjs";
import { openSqliteDatabase } from "../src/lib/db/sqlite.ts";
import { ProviderBindingRepository } from "../src/lib/server/coach/provider-binding-repository.ts";

const args = process.argv.slice(2);
const command = args.shift();
const databasePath = process.env.FRONTEND_ATLAS_DB_PATH ?? "./.local-data/coach.sqlite";

function argument(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function usage() {
  process.stderr.write([
    "Trusted local operator commands:",
    "  npm run provider:bindings -- list",
    "  npm run provider:bindings -- assign --user <better-auth-user-id> --profile <siwc-client-id>",
    "",
    "The list output contains only account metadata. It never prints tokens or credentials.",
  ].join("\n") + "\n");
}

let opened;
try {
  if (command !== "list" && command !== "assign") {
    usage();
    process.exitCode = 2;
  } else {
    opened = openSqliteDatabase(databasePath);
    const table = opened.client.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coach_provider_bindings'").get();
    if (!table) throw new Error("coach_provider_bindings is missing; inspect the database backup, then run the reviewed migration before assigning a connection.");
    const bindings = new ProviderBindingRepository(opened.db);
    const profiles = (await createCredentialStore().getState()).profiles;

    if (command === "list") {
      const users = opened.client.prepare("SELECT id, name, email FROM user ORDER BY created_at, id").all();
      const assigned = opened.client.prepare("SELECT owner_user_id, siwc_client_id, selected_model, version FROM coach_provider_bindings ORDER BY owner_user_id").all();
      const safeProfiles = profiles.map((profile) => ({
        clientId: profile.clientId,
        name: typeof profile.name === "string" ? profile.name : null,
        email: typeof profile.email === "string" ? profile.email : null,
        resumable: !profile.localSignoutPending && Boolean(profile.accessToken || profile.refreshToken),
        planUsageEnabled: Array.isArray(profile.scopes) && profile.scopes.includes("chatgpt.tokens.use.direct"),
      }));
      process.stdout.write(JSON.stringify({ databasePath, users, profiles: safeProfiles, bindings: assigned }, null, 2) + "\n");
    } else {
      const ownerUserId = argument("--user");
      const siwcClientId = argument("--profile");
      if (!ownerUserId || !siwcClientId) {
        usage();
        process.exitCode = 2;
      } else {
        const user = opened.client.prepare("SELECT id FROM user WHERE id = ?").get(ownerUserId);
        if (!user) throw new Error("The requested Better Auth user does not exist in this database.");
        const profile = profiles.find((candidate) => candidate.clientId === siwcClientId);
        if (!profile || profile.localSignoutPending || (!profile.accessToken && !profile.refreshToken)) {
          throw new Error("The requested SIWC profile is missing or not resumable.");
        }
        const ownerBinding = bindings.findForOwner(ownerUserId);
        const profileBinding = bindings.findForProfile(siwcClientId);
        if (ownerBinding || profileBinding) {
          if (ownerBinding?.siwcClientId === siwcClientId && profileBinding?.ownerUserId === ownerUserId) {
            process.stdout.write("This explicit user/profile authorization already exists; nothing changed.\n");
          } else {
            throw new Error("The user or SIWC profile already has a different authorization. Remove it explicitly before assigning a replacement.");
          }
        } else {
          bindings.createForOwner(ownerUserId, siwcClientId);
          process.stdout.write("Authorized the selected SIWC profile for the selected Better Auth user. No credentials were created or copied.\n");
        }
      }
    }
  }
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
} finally {
  opened?.client.close();
}
