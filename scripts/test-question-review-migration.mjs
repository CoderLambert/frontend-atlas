import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openSqliteDatabase } from "../src/lib/db/sqlite.ts";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const migrations = join(projectRoot, "src/lib/db/migrations");
const tempRoot = mkdtempSync(join(tmpdir(), "frontend-atlas-review-migration-"));
const oldMigrations = join(tempRoot, "migrations-0008");
const databasePath = join(tempRoot, "from-0008.sqlite");

try {
  mkdirSync(join(oldMigrations, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8"));
  const oldJournal = { ...journal, entries: journal.entries.filter((entry) => entry.idx <= 8) };
  assert.equal(oldJournal.entries.at(-1).tag.startsWith("0008_"), true);
  writeFileSync(join(oldMigrations, "meta/_journal.json"), JSON.stringify(oldJournal));
  for (const entry of oldJournal.entries) copyFileSync(join(migrations, `${entry.tag}.sql`), join(oldMigrations, `${entry.tag}.sql`));

  const old = openSqliteDatabase(databasePath);
  const timestamp = Date.parse("2026-10-08T10:00:00.000Z");
  try {
    migrate(old.db, { migrationsFolder: oldMigrations });
    old.client.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)")
      .run("legacy-owner", "Legacy Owner", "legacy-owner@example.test", timestamp, timestamp);
    old.client.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)")
      .run("legacy-reviewer", "Legacy Reviewer", "legacy-reviewer@example.test", timestamp, timestamp);
    old.client.prepare("INSERT INTO account (id, account_id, provider_id, user_id, access_token, refresh_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("legacy-account", "provider-account", "github", "legacy-owner", "preserve-access", "preserve-refresh", timestamp, timestamp);
    old.client.prepare("INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run("legacy-session", timestamp + 86_400_000, "preserve-session", timestamp, timestamp, "legacy-owner");
    old.client.prepare("INSERT INTO coach_conversations (id, owner_user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("legacy-conversation", "legacy-owner", "Legacy conversation", timestamp, timestamp);
    old.client.prepare("INSERT INTO coach_messages (id, conversation_id, owner_user_id, client_message_id, role, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("legacy-message", "legacy-conversation", "legacy-owner", "legacy-client", "assistant", "Legacy response", "complete", timestamp);
    old.client.prepare("INSERT INTO coach_provider_bindings (owner_user_id, siwc_client_id, selected_model, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("legacy-owner", "legacy-profile", "gpt-6-luna", 2, timestamp, timestamp);
    old.client.prepare("INSERT INTO question_private_overrides (owner_user_id, qid, base_content_version, title, explanation_markdown, checkpoints_json, generation_id, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("legacy-owner", "Q1", "legacy-content", "Legacy private", "# Legacy", '["Legacy checkpoint"]', "legacy-generation", 3, timestamp, timestamp);
    for (const [id, revision, status, offset] of [["legacy-withdrawn", 2, "withdrawn", 100], ["legacy-submitted", 3, "submitted", 200]]) {
      old.client.prepare(`INSERT INTO question_change_proposals (
        id, owner_user_id, qid, source_generation_id, source_override_version, base_content_version,
        title, explanation_markdown, checkpoints_json, summary, status, created_at, updated_at, withdrawn_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, "legacy-owner", "Q1", "legacy-generation", revision, "legacy-content", `Legacy ${revision}`, "# Legacy", '["Legacy checkpoint"]', `History ${revision}`, status, timestamp + offset, timestamp + offset, status === "withdrawn" ? timestamp + offset : null);
      old.client.prepare("INSERT INTO question_change_proposal_sources (owner_user_id, qid, source_generation_id, source_override_version, proposal_id, claimed_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("legacy-owner", "Q1", "legacy-generation", revision, id, timestamp + offset);
    }
  } finally {
    old.client.close();
  }

  const upgraded = openSqliteDatabase(databasePath);
  try {
    migrate(upgraded.db, { migrationsFolder: migrations });
    migrate(upgraded.db, { migrationsFolder: migrations });
    assert.equal(upgraded.client.prepare("PRAGMA quick_check").pluck().get(), "ok");
    assert.equal(upgraded.client.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.equal(upgraded.client.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get().n, 11);
    assert.equal(upgraded.client.prepare("SELECT count(*) AS n FROM question_change_proposals").get().n, 2);
    assert.equal(upgraded.client.prepare("SELECT count(*) AS n FROM question_change_proposal_sources").get().n, 2, "0009 preserves the source-claim ledger while rebuilding proposals");
    assert.deepEqual(upgraded.client.prepare("SELECT id, status, base_content_sha256 FROM question_change_proposals ORDER BY created_at").all(), [
      { id: "legacy-withdrawn", status: "withdrawn", base_content_sha256: "" },
      { id: "legacy-submitted", status: "submitted", base_content_sha256: "" },
    ], "legacy audit rows remain but are deliberately not trusted as hashed bases");
    assert.deepEqual(upgraded.client.prepare("SELECT title, generation_id, version, base_content_sha256 FROM question_private_overrides").get(), {
      title: "Legacy private", generation_id: "legacy-generation", version: 3, base_content_sha256: "",
    });
    for (const table of ["user", "account", "session", "coach_conversations", "coach_messages", "coach_provider_bindings"]) {
      assert.ok(upgraded.client.prepare(`SELECT count(*) AS n FROM ${table}`).get().n >= 1, `${table} survives the 0008 -> 0009 migration`);
    }
    for (const table of ["site_role_grants", "question_proposal_reviews", "question_publications"]) {
      assert.equal(upgraded.client.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).n, 1);
    }
    assert.throws(() => upgraded.client.prepare("UPDATE question_change_proposals SET title = 'mutated' WHERE id = 'legacy-submitted'").run(), /snapshot is immutable/u);
  } finally {
    upgraded.client.close();
  }
  process.stdout.write("Question review migration fixture passed.\n");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
