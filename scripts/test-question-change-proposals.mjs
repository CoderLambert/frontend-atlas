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
    assert.equal(upgraded.client.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get().n, 7);
  } finally {
    upgraded.client.close();
  }

  process.stdout.write("Question change proposal tests passed.\n");
} finally {
  try { opened.client.close(); } catch {}
  rmSync(tempRoot, { recursive: true, force: true });
}
