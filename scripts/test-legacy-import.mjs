import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openSqliteDatabase } from "../src/lib/db/sqlite.ts";
import { LegacyConversationImportService } from "../src/lib/server/coach/legacy-import.ts";
import { createLegacyConversationImportHandler } from "../src/lib/server/coach/legacy-import-route-handler.ts";
import { coachWriteRequestHeader } from "../src/lib/server/coach/write-request-guard.ts";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempRoot = mkdtempSync(join(tmpdir(), "frontend-atlas-legacy-import-"));
const databasePath = join(tempRoot, "coach.sqlite");
const backupPath = join(tempRoot, "coach-backup.sqlite");
const restorePath = join(tempRoot, "coach-restore.sqlite");

function request(userId, payload, options = {}) {
  const headers = new Headers({
    origin: options.origin ?? "http://localhost",
    "content-type": options.contentType ?? "application/json",
    [coachWriteRequestHeader.name]: options.requestHeader ?? coachWriteRequestHeader.value,
  });
  if (userId) headers.set("x-test-user", userId);
  if (options.expectedAccountId !== null) headers.set("x-frontend-atlas-account-id", options.expectedAccountId ?? userId ?? "");
  return new Request("http://localhost/api/coach/conversations/legacy-import", {
    method: "POST",
    headers,
    ...(options.rawBody === undefined ? { body: JSON.stringify(payload) } : { body: options.rawBody }),
  });
}

function makeRecord(sourceId, values = {}) {
  return {
    sourceId,
    qid: "QUESTION/UNKNOWN-17 ",
    attemptId: "attempt-legacy-1",
    contentVersion: "old-content-v4",
    mode: "explain",
    model: "local-history-model",
    userInput: "Explain this carefully.",
    assistantOutput: "A saved historical answer.",
    status: "complete",
    startedAt: "2024-01-02T03:04:05.000Z",
    updatedAt: "2024-01-02T03:04:09.000Z",
    ...values,
  };
}

try {
  let opened = openSqliteDatabase(databasePath);
  migrate(opened.db, { migrationsFolder: join(projectRoot, "src/lib/db/migrations") });
  const now = Date.now();
  const insertUser = opened.client.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
  insertUser.run("user-a", "User A", "a@example.test", 0, now, now);
  insertUser.run("user-b", "User B", "b@example.test", 0, now, now);
  const service = new LegacyConversationImportService(opened.db);
  const sessions = { async getUserId(requestValue) { return requestValue.headers.get("x-test-user"); } };
  const handler = createLegacyConversationImportHandler(service, sessions, { trustedOriginUrl: "http://localhost" });

  const unauthenticated = await handler(request(null, { records: [makeRecord("no-session")] }));
  assert.equal(unauthenticated.status, 401, "anonymous imports are rejected");
  const accountMismatch = await handler(request("user-a", { records: [makeRecord("stale-account")] }, { expectedAccountId: "user-b" }));
  assert.equal(accountMismatch.status, 409, "a stale account cannot import after an account switch");
  const deniedOrigin = await handler(request("user-a", { records: [makeRecord("csrf")] }, { origin: "https://evil.example" }));
  assert.equal(deniedOrigin.status, 403, "the existing same-origin write guard protects imports");

  const pending = makeRecord("legacy-pending", { status: "pending", assistantOutput: "Partial pending output." });
  const streaming = makeRecord("legacy-streaming", { status: "streaming", assistantOutput: "Partial streaming output." });
  const invalidExtra = { ...makeRecord("invalid-extra"), arbitraryJson: { shouldNeverPersist: true } };
  const importResponse = await handler(request("user-a", { records: [pending, streaming, invalidExtra] }));
  assert.equal(importResponse.status, 200);
  assert.deepEqual((await importResponse.json()).results, [
    { index: 0, status: "imported" },
    { index: 1, status: "imported" },
    { index: 2, status: "invalid" },
  ], "each legacy item has an independent, non-leaking result");

  const pendingTargetId = `legacy_${createHash("sha256").update("user-a").update("\0").update(pending.sourceId).digest("hex")}`;
  const pendingConversation = opened.client.prepare("SELECT id, owner_user_id, qid, content_version, legacy_metadata_json FROM coach_conversations WHERE id = ? AND owner_user_id = ?").get(pendingTargetId, "user-a");
  assert.ok(pendingConversation, "the exact unknown qid is retained in SQLite");
  assert.equal(pendingConversation.qid, pending.qid, "unknown qids preserve their exact value");
  const pendingMetadata = JSON.parse(pendingConversation.legacy_metadata_json);
  assert.deepEqual(Object.keys(pendingMetadata).sort(), ["attemptId", "mode", "model", "originalStatus", "source", "sourceId", "version"]);
  assert.equal(pendingMetadata.sourceId, "legacy-pending");
  assert.equal(pendingMetadata.originalStatus, "pending");
  const pendingMessages = opened.client.prepare("SELECT role, content, status FROM coach_messages WHERE conversation_id = ? ORDER BY role").all(pendingConversation.id);
  assert.deepEqual(pendingMessages, [
    { role: "assistant", content: "Partial pending output.", status: "interrupted" },
    { role: "user", content: "Explain this carefully.", status: "complete" },
  ], "old pending content remains historical and is marked interrupted");
  const streamingTargetId = `legacy_${createHash("sha256").update("user-a").update("\0").update(streaming.sourceId).digest("hex")}`;
  const streamingConversation = opened.client.prepare("SELECT id, legacy_metadata_json FROM coach_conversations WHERE id = ? AND owner_user_id = ?").get(streamingTargetId, "user-a");
  assert.equal(opened.client.prepare("SELECT status FROM coach_messages WHERE conversation_id = ? AND role = 'assistant'").get(streamingConversation.id).status, "interrupted", "old streaming output is never resumed");
  assert.equal(JSON.parse(streamingConversation.legacy_metadata_json).originalStatus, "streaming", "the old stream state is preserved as metadata");
  assert.equal(opened.client.prepare("SELECT count(*) AS count FROM coach_assistant_runs WHERE conversation_id IN (?, ?)").get(pendingConversation.id, streamingConversation.id).count, 0, "imports create no assistant runs or recovery work");
  assert.equal(opened.client.prepare("SELECT count(*) AS count FROM coach_conversations WHERE owner_user_id = ? AND qid = ?").get("user-a", "QUESTION/UNKNOWN-17 ").count, 2, "unknown question IDs remain stored without question-bank mapping");

  const duplicate = await handler(request("user-a", { records: [pending] }));
  assert.deepEqual((await duplicate.json()).results, [{ index: 0, status: "already_imported" }], "identical imports are idempotent");
  const changed = await handler(request("user-a", { records: [makeRecord("legacy-pending", { userInput: "Changed user input." })] }));
  assert.deepEqual((await changed.json()).results, [{ index: 0, status: "conflict" }], "an existing target is never overwritten");
  assert.equal(opened.client.prepare("SELECT content FROM coach_messages WHERE conversation_id = ? AND role = 'user'").get(pendingConversation.id).content, pending.userInput, "conflicts leave saved messages unchanged");

  const sameSourceOtherOwner = await handler(request("user-b", { records: [pending] }));
  assert.deepEqual((await sameSourceOtherOwner.json()).results, [{ index: 0, status: "imported" }], "the same legacy source ID is isolated by owner");
  assert.equal(opened.client.prepare("SELECT count(*) AS count FROM coach_conversations WHERE owner_user_id = ?").get("user-b").count, 1);
  assert.equal(opened.client.prepare("SELECT count(*) AS count FROM coach_conversations WHERE owner_user_id = ?").get("user-a").count, 2);

  const collisionSourceId = "collision-fixture";
  const collidingId = `legacy_${createHash("sha256").update("user-a").update("\0").update(collisionSourceId).digest("hex")}`;
  opened.client.prepare(`INSERT INTO coach_conversations (id, owner_user_id, title, qid, content_version, legacy_metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(collidingId, "user-b", "private existing row", "PRIVATE-QID", "private-version", null, now, now);
  const collision = await handler(request("user-a", { records: [makeRecord(collisionSourceId)] }));
  const collisionBody = await collision.json();
  assert.deepEqual(collisionBody, { results: [{ index: 0, status: "conflict" }] }, "an ID collision cannot disclose another owner's data");
  assert.equal(JSON.stringify(collisionBody).includes("PRIVATE-QID"), false);

  const oversizedRecord = makeRecord("too-long", { userInput: "x".repeat(12_001) });
  const invalidSize = await handler(request("user-a", { records: [oversizedRecord] }));
  assert.deepEqual((await invalidSize.json()).results, [{ index: 0, status: "invalid" }], "per-field text limits are enforced");
  const ownerClaim = await handler(request("user-a", { records: [{ ...makeRecord("forged-owner"), ownerUserId: "user-b" }] }));
  assert.deepEqual((await ownerClaim.json()).results, [{ index: 0, status: "invalid" }], "payload owner fields are not accepted");
  const oversizedBatch = await handler(request("user-a", { records: Array.from({ length: 21 }, (_, index) => makeRecord(`batch-${index}`)) }));
  assert.equal(oversizedBatch.status, 400, "the 20-conversation batch cap is enforced");
  const oversizedBody = await handler(request("user-a", undefined, { rawBody: `{"records":["${"x".repeat(16 * 1024 * 1024)}"]}` }));
  assert.equal(oversizedBody.status, 413, "the streaming JSON parser enforces the 16 MiB request cap");

  const integrityBeforeBackup = opened.client.pragma("integrity_check", { simple: true });
  assert.equal(integrityBeforeBackup, "ok");
  await opened.client.backup(backupPath);
  opened.client.close();
  copyFileSync(backupPath, restorePath);
  const restored = new BetterSqlite3(restorePath);
  assert.equal(restored.pragma("integrity_check", { simple: true }), "ok", "a temporary SQLite backup restores cleanly");
  assert.equal(restored.prepare("SELECT count(*) AS count FROM coach_conversations WHERE owner_user_id = 'user-a'").get().count, 2);
  assert.equal(restored.prepare("SELECT count(*) AS count FROM coach_messages WHERE status = 'interrupted'").get().count, 3, "the backup retains interrupted historical replies for both owners");
  assert.equal(restored.prepare("SELECT count(*) AS count FROM coach_assistant_runs").get().count, 0);
  restored.close();

  process.stdout.write("legacy import: same-origin guard, account binding, whitelist metadata, unknown qids, interrupted history, idempotency, owner isolation, size limits, and temp SQLite backup/restore passed\n");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
