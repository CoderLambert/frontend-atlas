import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openSqliteDatabase } from "../src/lib/db/sqlite.ts";
import { user } from "../src/lib/db/schema.ts";
import { createQuestionChangeProposalHandlers, QuestionChangeProposalRepository, QuestionChangeProposalService } from "../src/lib/server/question-change-proposals.ts";
import { createQuestionPrivateOverrideHandlers, QuestionPrivateOverrideRepository, QuestionPrivateOverrideService } from "../src/lib/server/question-private-overrides.ts";
import { coachWriteRequestHeader } from "../src/lib/server/coach/write-request-guard.ts";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempRoot = mkdtempSync(join(tmpdir(), "frontend-atlas-question-proposals-"));
const databasePath = join(tempRoot, "proposals.sqlite");

function request(ownerUserId, method, qid, body, options = {}) {
  const headers = new Headers();
  if (ownerUserId) headers.set("cookie", `session=${ownerUserId}`);
  const expectedAccountId = options.expectedAccountId === undefined ? ownerUserId : options.expectedAccountId;
  if (expectedAccountId) headers.set("x-frontend-atlas-account-id", expectedAccountId);
  if (method !== "GET") {
    headers.set("origin", options.origin ?? "http://localhost");
    headers.set("content-type", "application/json");
    headers.set(coachWriteRequestHeader.name, coachWriteRequestHeader.value);
  }
  return new Request(`http://localhost/api/questions/${qid}/change-proposal`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function context(qid) {
  return { params: Promise.resolve({ qid }) };
}

function overrideInput(expectedVersion, expectedGenerationId, title) {
  return {
    expectedVersion,
    expectedGenerationId,
    title,
    explanationMarkdown: `## ${title}\n\n完整讲解。`,
    checkpoints: [`${title} 检查点一`, `${title} 检查点二`],
  };
}

function submitInput(source, summary = "修正题干并补充边界说明。") {
  return {
    expectedVersion: source.version,
    expectedGenerationId: source.generationId,
    summary,
    ownerUserId: "user-b",
    title: "客户端伪造题干",
  };
}

let opened = openSqliteDatabase(databasePath);
try {
  migrate(opened.db, { migrationsFolder: join(projectRoot, "src/lib/db/migrations") });
  const now = new Date();
  opened.db.insert(user).values([
    { id: "user-a", name: "A", email: "a@example.test", createdAt: now, updatedAt: now },
    { id: "user-b", name: "B", email: "b@example.test", createdAt: now, updatedAt: now },
    { id: "user-c", name: "C", email: "c@example.test", createdAt: now, updatedAt: now },
  ]).run();

  const sessions = {
    async getUserId(incoming) {
      return incoming.headers.get("cookie")?.match(/session=([^;]+)/u)?.[1] ?? null;
    },
  };
  const makePrivateHandlers = () => createQuestionPrivateOverrideHandlers(
    new QuestionPrivateOverrideService(new QuestionPrivateOverrideRepository(opened.db), new Set(["Q1"]), "content-v1"),
    sessions,
    { trustedOriginUrl: "http://localhost" },
  );
  const makeProposalHandlers = () => createQuestionChangeProposalHandlers(
    new QuestionChangeProposalService(new QuestionChangeProposalRepository(opened.db), new Set(["Q1"])),
    sessions,
    { trustedOriginUrl: "http://localhost" },
  );
  let privateHandlers = makePrivateHandlers();
  let proposalHandlers = makeProposalHandlers();

  let response = await proposalHandlers.read(request(null, "GET", "Q1"), context("Q1"));
  assert.equal(response.status, 401);
  response = await proposalHandlers.read(request("user-a", "GET", "Q1", undefined, { expectedAccountId: "user-b" }), context("Q1"));
  assert.equal(response.status, 409, "stale account UI cannot read the prior account's proposal");
  response = await proposalHandlers.submit(request("user-a", "POST", "Q1", { expectedVersion: 1, expectedGenerationId: "guess", summary: "test" }, { origin: "https://evil.example" }), context("Q1"));
  assert.equal(response.status, 403);
  response = await proposalHandlers.submit(request("user-a", "POST", "Q1", { expectedVersion: 1, expectedGenerationId: "guess", summary: "test" }), context("Q1"));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "private_override_required");

  response = await privateHandlers.save(request("user-a", "PATCH", "Q1", overrideInput(null, null, "A 私人题干")), context("Q1"));
  assert.equal(response.status, 201);
  const sourceA = (await response.json()).override;
  response = await privateHandlers.save(request("user-b", "PATCH", "Q1", overrideInput(null, null, "B 私人题干")), context("Q1"));
  assert.equal(response.status, 201);
  const sourceB = (await response.json()).override;
  response = await privateHandlers.save(request("user-c", "PATCH", "Q1", overrideInput(null, null, "C 私人题干")), context("Q1"));
  assert.equal(response.status, 201);
  const sourceC = (await response.json()).override;

  const concurrentResponses = await Promise.all([
    proposalHandlers.submit(request("user-c", "POST", "Q1", submitInput(sourceC, "C 并发申请一")), context("Q1")),
    proposalHandlers.submit(request("user-c", "POST", "Q1", submitInput(sourceC, "C 并发申请二")), context("Q1")),
  ]);
  assert.deepEqual(concurrentResponses.map((candidate) => candidate.status).sort(), [200, 201], "concurrent same-source API retries create one proposal");
  const concurrentProposals = await Promise.all(concurrentResponses.map((candidate) => candidate.json()));
  assert.equal(concurrentProposals[0].proposal.id, concurrentProposals[1].proposal.id);
  assert.equal(opened.client.prepare("SELECT count(*) AS n FROM question_change_proposals WHERE owner_user_id = ?").get("user-c").n, 1);

  response = await proposalHandlers.submit(request("user-a", "POST", "Q1", { ...submitInput(sourceA), expectedVersion: 99 }), context("Q1"));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "private_version_conflict");

  response = await proposalHandlers.submit(request("user-a", "POST", "Q1", submitInput(sourceA)), context("Q1"));
  assert.equal(response.status, 201);
  const proposalA = (await response.json()).proposal;
  assert.equal(proposalA.title, "A 私人题干", "proposal snapshots server-owned private content rather than client fields");
  assert.equal(proposalA.baseContentVersion, "content-v1");
  assert.equal(proposalA.sourceGenerationId, sourceA.generationId);
  assert.equal(proposalA.sourceOverrideVersion, 1);
  assert.equal(proposalA.status, "submitted");

  response = await proposalHandlers.submit(request("user-a", "POST", "Q1", submitInput(sourceA, "retry body is ignored")), context("Q1"));
  assert.equal(response.status, 200, "retrying the same source snapshot is idempotent");
  assert.equal((await response.json()).proposal.id, proposalA.id);
  assert.equal(opened.client.prepare("SELECT count(*) AS n FROM question_change_proposals WHERE owner_user_id = ?").get("user-a").n, 1);

  response = await proposalHandlers.read(request("user-b", "GET", "Q1"), context("Q1"));
  assert.equal((await response.json()).proposal, null, "B cannot see A's submitted proposal");
  response = await proposalHandlers.submit(request("user-b", "POST", "Q1", submitInput(sourceB, "B 的独立申请")), context("Q1"));
  assert.equal(response.status, 201);
  const proposalB = (await response.json()).proposal;
  assert.notEqual(proposalB.id, proposalA.id);

  response = await privateHandlers.save(request("user-a", "PATCH", "Q1", overrideInput(1, sourceA.generationId, "A 私人题干第二版")), context("Q1"));
  assert.equal(response.status, 200);
  const sourceA2 = (await response.json()).override;
  response = await proposalHandlers.submit(request("user-a", "POST", "Q1", submitInput(sourceA2)), context("Q1"));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "active_proposal_exists", "a changed private revision cannot replace an active snapshot");
  const storedSnapshot = opened.client.prepare("SELECT title, source_override_version FROM question_change_proposals WHERE id = ?").get(proposalA.id);
  assert.deepEqual(storedSnapshot, { title: "A 私人题干", source_override_version: 1 }, "later private edits do not mutate the submitted snapshot");

  response = await proposalHandlers.withdraw(request("user-a", "DELETE", "Q1", { proposalId: proposalB.id }), context("Q1"));
  assert.equal(response.status, 404, "guessing B's proposal id cannot withdraw it");
  assert.equal(opened.client.prepare("SELECT status FROM question_change_proposals WHERE id = ?").get(proposalB.id).status, "submitted");
  response = await proposalHandlers.withdraw(request("user-a", "DELETE", "Q1", { proposalId: proposalA.id }), context("Q1"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).proposal.status, "withdrawn");

  response = await proposalHandlers.submit(request("user-a", "POST", "Q1", submitInput(sourceA, "撤回后的延迟重放")), context("Q1"));
  assert.equal(response.status, 409, "an exact replay cannot reactivate a withdrawn source snapshot");
  const withdrawnReplay = await response.json();
  assert.equal(withdrawnReplay.error, "proposal_withdrawn");
  assert.equal(withdrawnReplay.proposal.id, proposalA.id, "the original audit row is returned rather than replaced");
  assert.equal(opened.client.prepare("SELECT count(*) AS n FROM question_change_proposals WHERE owner_user_id = ? AND status = 'submitted'").get("user-a").n, 0);
  assert.equal(opened.client.prepare("SELECT count(*) AS n FROM question_change_proposals WHERE owner_user_id = ?").get("user-a").n, 1);
  assert.throws(() => opened.client.prepare(`
    INSERT INTO question_change_proposals (
      id, owner_user_id, qid, source_generation_id, source_override_version,
      base_content_version, title, explanation_markdown, checkpoints_json,
      summary, status, created_at, updated_at, withdrawn_at
    )
    SELECT 'forced-source-replay', owner_user_id, qid, source_generation_id, source_override_version,
      base_content_version, title, explanation_markdown, checkpoints_json,
      'forced replay', 'submitted', created_at, updated_at, NULL
    FROM question_change_proposals WHERE id = ?
  `).run(proposalA.id), /UNIQUE constraint failed: question_change_proposals\.owner_user_id.+source_override_version/u, "the database constraint closes concurrent bypasses across all statuses");

  response = await proposalHandlers.submit(request("user-a", "POST", "Q1", submitInput(sourceA2, "第二版重新提交")), context("Q1"));
  assert.equal(response.status, 201);
  const replacement = (await response.json()).proposal;
  assert.notEqual(replacement.id, proposalA.id);
  assert.equal(replacement.sourceOverrideVersion, 2);
  assert.equal(opened.client.prepare("SELECT count(*) AS n FROM question_change_proposals WHERE owner_user_id = ?").get("user-a").n, 2, "withdrawn history is retained");

  response = await privateHandlers.delete(request("user-a", "DELETE", "Q1", { expectedVersion: sourceA2.version, expectedGenerationId: sourceA2.generationId }), context("Q1"));
  assert.equal(response.status, 200);
  response = await proposalHandlers.read(request("user-a", "GET", "Q1"), context("Q1"));
  assert.equal((await response.json()).proposal.id, replacement.id, "deleting the private override does not delete its submitted snapshot");

  opened.client.close();
  opened = openSqliteDatabase(databasePath);
  privateHandlers = makePrivateHandlers();
  proposalHandlers = makeProposalHandlers();
  response = await proposalHandlers.read(request("user-a", "GET", "Q1"), context("Q1"));
  assert.equal((await response.json()).proposal.id, replacement.id, "active proposal survives a database restart");
  response = await proposalHandlers.read(request("user-b", "GET", "Q1"), context("Q1"));
  assert.equal((await response.json()).proposal.id, proposalB.id, "B's proposal remains isolated after restart");

  const oldPath = join(tempRoot, "pre-proposals.sqlite");
  const oldMigrations = join(tempRoot, "old-migrations");
  const migrations = join(projectRoot, "src/lib/db/migrations");
  mkdirSync(join(oldMigrations, "meta"), { recursive: true });
  const oldJournal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8"));
  oldJournal.entries = oldJournal.entries.filter((entry) => entry.idx <= 5);
  writeFileSync(join(oldMigrations, "meta/_journal.json"), JSON.stringify(oldJournal));
  for (const entry of oldJournal.entries) copyFileSync(join(migrations, entry.tag + ".sql"), join(oldMigrations, entry.tag + ".sql"));
  const oldDb = openSqliteDatabase(oldPath);
  const oldTimestamp = Date.now();
  try {
    migrate(oldDb.db, { migrationsFolder: oldMigrations });
    oldDb.client.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)")
      .run("upgrade-user", "Upgrade", "upgrade@example.test", oldTimestamp, oldTimestamp);
    oldDb.client.prepare("INSERT INTO account (id, account_id, provider_id, user_id, access_token, refresh_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("upgrade-account", "provider-account", "github", "upgrade-user", "fake-access-token", "fake-refresh-token", oldTimestamp, oldTimestamp);
    oldDb.client.prepare("INSERT INTO session (id, expires_at, token, created_at, updated_at, ip_address, user_agent, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("upgrade-session", oldTimestamp + 86_400_000, "fake-session-token", oldTimestamp, oldTimestamp, "127.0.0.1", "migration-test", "upgrade-user");
    oldDb.client.prepare("INSERT INTO coach_conversations (id, owner_user_id, title, qid, content_version, legacy_metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("upgrade-conversation", "upgrade-user", "迁移前会话", "Q1", "old-base", '{"source":"migration-test"}', oldTimestamp, oldTimestamp);
    oldDb.client.prepare("INSERT INTO coach_messages (id, conversation_id, owner_user_id, client_message_id, role, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("upgrade-message", "upgrade-conversation", "upgrade-user", "upgrade-client-message", "assistant", "迁移前回复", "complete", oldTimestamp);
    oldDb.client.prepare("INSERT INTO question_private_overrides (owner_user_id, qid, base_content_version, title, explanation_markdown, checkpoints_json, generation_id, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("upgrade-user", "Q1", "old-base", "迁移前题干", "# 迁移前讲解", '["迁移前检查点"]', "old-generation", 4, oldTimestamp, oldTimestamp);
  } finally {
    oldDb.client.close();
  }
  const upgraded = openSqliteDatabase(oldPath);
  try {
    migrate(upgraded.db, { migrationsFolder: migrations });
    migrate(upgraded.db, { migrationsFolder: migrations });
    assert.deepEqual(
      upgraded.client.prepare("SELECT title, generation_id, version FROM question_private_overrides WHERE owner_user_id = ?").get("upgrade-user"),
      { title: "迁移前题干", generation_id: "old-generation", version: 4 },
      "0006 preserves existing private override data",
    );
    assert.equal(upgraded.client.prepare("SELECT count(*) AS n FROM question_change_proposals").get().n, 0);
    assert.deepEqual(upgraded.client.prepare("SELECT id, name, email FROM user WHERE id = ?").get("upgrade-user"), {
      id: "upgrade-user", name: "Upgrade", email: "upgrade@example.test",
    });
    assert.deepEqual(upgraded.client.prepare("SELECT id, account_id, provider_id, user_id, access_token, refresh_token FROM account WHERE id = ?").get("upgrade-account"), {
      id: "upgrade-account", account_id: "provider-account", provider_id: "github", user_id: "upgrade-user",
      access_token: "fake-access-token", refresh_token: "fake-refresh-token",
    });
    assert.deepEqual(upgraded.client.prepare("SELECT id, token, user_id, ip_address, user_agent FROM session WHERE id = ?").get("upgrade-session"), {
      id: "upgrade-session", token: "fake-session-token", user_id: "upgrade-user", ip_address: "127.0.0.1", user_agent: "migration-test",
    });
    assert.deepEqual(upgraded.client.prepare("SELECT id, owner_user_id, title, qid, content_version, legacy_metadata_json FROM coach_conversations WHERE id = ?").get("upgrade-conversation"), {
      id: "upgrade-conversation", owner_user_id: "upgrade-user", title: "迁移前会话", qid: "Q1", content_version: "old-base", legacy_metadata_json: '{"source":"migration-test"}',
    });
    assert.deepEqual(upgraded.client.prepare("SELECT id, conversation_id, owner_user_id, client_message_id, role, content, status FROM coach_messages WHERE id = ?").get("upgrade-message"), {
      id: "upgrade-message", conversation_id: "upgrade-conversation", owner_user_id: "upgrade-user", client_message_id: "upgrade-client-message", role: "assistant", content: "迁移前回复", status: "complete",
    });
    assert.equal(upgraded.client.prepare("PRAGMA quick_check").pluck().get(), "ok");
    assert.equal(upgraded.client.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get().n, 8);
  } finally {
    upgraded.client.close();
  }

  process.stdout.write("Question change proposal tests passed.\n");
} finally {
  try { opened.client.close(); } catch {}
  rmSync(tempRoot, { recursive: true, force: true });
}
