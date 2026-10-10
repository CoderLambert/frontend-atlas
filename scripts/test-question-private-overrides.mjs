import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openSqliteDatabase } from "../src/lib/db/sqlite.ts";
import { user } from "../src/lib/db/schema.ts";
import { createQuestionPrivateOverrideHandlers, QuestionPrivateOverrideRepository, QuestionPrivateOverrideService } from "../src/lib/server/question-private-overrides.ts";
import { coachWriteRequestHeader } from "../src/lib/server/coach/write-request-guard.ts";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempRoot = mkdtempSync(join(tmpdir(), "frontend-atlas-question-overrides-"));
const databasePath = join(tempRoot, "overrides.sqlite");

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
  return new Request(`http://localhost/api/questions/${qid}/private-override`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function context(qid) {
  return { params: Promise.resolve({ qid }) };
}

function input(expectedVersion, title = "我的题干", expectedGenerationId = null) {
  return {
    expectedVersion,
    expectedGenerationId,
    baseContentVersion: "client-forged-version",
    title,
    explanationMarkdown: "## 私人讲解\n\n只属于当前账号。",
    checkpoints: ["讲清第一点", "讲清第二点"],
    ownerUserId: "user-b",
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
  const publicHashes = new Map([["Q1", "hash-v1"], ["Q2", "hash-q2"]]);
  const makeHandlers = () => createQuestionPrivateOverrideHandlers(
    new QuestionPrivateOverrideService(new QuestionPrivateOverrideRepository(opened.db), new Set(["Q1", "Q2"]), "content-v1", publicHashes),
    sessions,
    { trustedOriginUrl: "http://localhost" },
  );
  let handlers = makeHandlers();

  let response = await handlers.read(request(null, "GET", "Q1"), context("Q1"));
  assert.equal(response.status, 401);
  response = await handlers.read(request("user-a", "GET", "Q1", undefined, { expectedAccountId: "user-b" }), context("Q1"));
  assert.equal(response.status, 409, "stale account UI cannot read another account's private layer");
  response = await handlers.read(request("user-a", "GET", "Q1"), context("Q1"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).override, null);

  response = await handlers.save(request("user-a", "PATCH", "Q1", input(null), { origin: "https://evil.example" }), context("Q1"));
  assert.equal(response.status, 403);
  assert.equal(new QuestionPrivateOverrideRepository(opened.db).find("user-a", "Q1"), null, "rejected origin has no side effect");

  response = await handlers.save(request("user-a", "PATCH", "Q1", input(null)), context("Q1"));
  assert.equal(response.status, 201);
  const first = (await response.json()).override;
  assert.equal(first.version, 1);
  assert.ok(first.generationId, "server assigns the private record generation");
  assert.equal(first.title, "我的题干");
  assert.equal(first.baseContentVersion, "content-v1", "the server records the trusted public content version, not a client claim");
  assert.equal(first.baseContentSha256, "hash-v1", "the server records the trusted public content hash");
  assert.equal(first.publicBaseOutdated, false, "new override is based on the current public snapshot");
  assert.equal(new QuestionPrivateOverrideRepository(opened.db).find("user-b", "Q1"), null, "owner comes only from the verified session");

  publicHashes.set("Q1", "hash-v2");
  response = await handlers.read(request("user-a", "GET", "Q1"), context("Q1"));
  let staleA = (await response.json()).override;
  assert.equal(staleA.publicBaseOutdated, true, "same global content version still detects changed public question snapshot");
  assert.equal(staleA.title, "我的题干");
  assert.equal(staleA.baseContentSha256, "hash-v1");
  response = await handlers.read(request("user-b", "GET", "Q1"), context("Q1"));
  assert.equal((await response.json()).override, null, "stale-state DTO does not leak A's private content to B");
  response = await handlers.save(request("user-a", "PATCH", "Q1", input(1, "按最新公共底稿重定基线", first.generationId)), context("Q1"));
  assert.equal(response.status, 200);
  staleA = (await response.json()).override;
  assert.equal(staleA.publicBaseOutdated, false, "saving against the current public snapshot clears the stale signal");
  assert.equal(staleA.baseContentSha256, "hash-v2");

  response = await handlers.save(request("user-a", "PATCH", "Q2", input(null, "Q2 私人题干")), context("Q2"));
  assert.equal(response.status, 201);
  assert.equal((await response.json()).override.publicBaseOutdated, false);
  response = await handlers.read(request("user-a", "GET", "Q2"), context("Q2"));
  assert.equal((await response.json()).override.publicBaseOutdated, false, "unrelated public question hash remains current");

  response = await handlers.read(request("user-b", "GET", "Q1"), context("Q1"));
  assert.equal((await response.json()).override, null, "another user cannot see A's override");
  response = await handlers.save(request("user-b", "PATCH", "Q1", input(null, "B 的题干")), context("Q1"));
  assert.equal(response.status, 201);
  assert.equal((await response.json()).override.title, "B 的题干");

  response = await handlers.save(request("user-a", "PATCH", "Q1", input(null, "错误覆盖")), context("Q1"));
  assert.equal(response.status, 409, "create cannot overwrite an existing private version");
  response = await handlers.save(request("user-a", "PATCH", "Q1", input(2, "A 的第二版", first.generationId)), context("Q1"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).override.version, 3);
  response = await handlers.save(request("user-a", "PATCH", "Q1", input(1, "过期标签页", first.generationId)), context("Q1"));
  assert.equal(response.status, 409, "stale edits do not overwrite the latest private version");

  response = await handlers.save(request("user-a", "PATCH", "UNKNOWN", input(null)), context("UNKNOWN"));
  assert.equal(response.status, 404);

  opened.client.close();
  opened = openSqliteDatabase(databasePath);
  handlers = makeHandlers();
  response = await handlers.read(request("user-a", "GET", "Q1"), context("Q1"));
  const recovered = (await response.json()).override;
  assert.equal(recovered.title, "A 的第二版", "private override survives a database restart");
  assert.equal(recovered.version, 3);
  assert.equal(recovered.generationId, first.generationId, "generation survives restart");

  response = await handlers.delete(request("user-a", "DELETE", "Q1", { expectedVersion: 1, expectedGenerationId: first.generationId }), context("Q1"));
  assert.equal(response.status, 409, "stale delete is rejected");
  response = await handlers.delete(request("user-a", "DELETE", "Q1", { expectedVersion: 3, expectedGenerationId: first.generationId }), context("Q1"));
  assert.equal(response.status, 200);
  response = await handlers.read(request("user-a", "GET", "Q1"), context("Q1"));
  assert.equal((await response.json()).override, null);
  response = await handlers.read(request("user-b", "GET", "Q1"), context("Q1"));
  assert.equal((await response.json()).override.title, "B 的题干", "removing A's override does not affect B");

  response = await handlers.save(request("user-a", "PATCH", "Q1", input(null, "重建的私人版本")), context("Q1"));
  assert.equal(response.status, 201);
  const recreated = (await response.json()).override;
  assert.equal(recreated.version, 1);
  assert.notEqual(recreated.generationId, first.generationId, "recreation uses a new generation even when revision restarts");
  response = await handlers.save(request("user-a", "PATCH", "Q1", input(1, "旧标签页误写入", first.generationId)), context("Q1"));
  assert.equal(response.status, 409, "old generation cannot overwrite newly-created revision one");
  response = await handlers.delete(request("user-a", "DELETE", "Q1", { expectedVersion: 1, expectedGenerationId: first.generationId }), context("Q1"));
  assert.equal(response.status, 409, "old generation cannot delete newly-created revision one");
  response = await handlers.save(request("user-a", "PATCH", "Q1", input(1, "伪造世代", "not-a-real-generation")), context("Q1"));
  assert.equal(response.status, 409);
  response = await handlers.read(request("user-a", "GET", "Q1"), context("Q1"));
  assert.equal((await response.json()).override.title, "重建的私人版本");


  // Exercise the real 0004 -> 0005 upgrade on a disposable SQLite database.
  const oldPath = join(tempRoot, "pre-generation.sqlite");
  const oldMigrations = join(tempRoot, "old-migrations");
  const migrations = join(projectRoot, "src/lib/db/migrations");
  mkdirSync(join(oldMigrations, "meta"), { recursive: true });
  const oldJournal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8"));
  oldJournal.entries = oldJournal.entries.filter((entry) => entry.idx <= 4);
  writeFileSync(join(oldMigrations, "meta/_journal.json"), JSON.stringify(oldJournal));
  for (const entry of oldJournal.entries) {
    copyFileSync(join(migrations, entry.tag + ".sql"), join(oldMigrations, entry.tag + ".sql"));
  }
  const oldDb = openSqliteDatabase(oldPath);
  const oldTimestamp = Date.now();
  try {
    migrate(oldDb.db, { migrationsFolder: oldMigrations });
    oldDb.client.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)")
      .run("legacy-user", "Legacy", "legacy@example.test", oldTimestamp, oldTimestamp);
    oldDb.client.prepare("INSERT INTO question_private_overrides (owner_user_id, qid, base_content_version, title, explanation_markdown, checkpoints_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("legacy-user", "Q1", "old-base", "旧题干", "# 原有内容", '["A"]', 7, oldTimestamp, oldTimestamp);
    oldDb.client.prepare("INSERT INTO coach_conversations (id, owner_user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("legacy-conv", "legacy-user", "旧聊天", oldTimestamp, oldTimestamp);
    oldDb.client.prepare("INSERT INTO coach_provider_bindings (owner_user_id, siwc_client_id, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("legacy-user", "legacy-binding", 3, oldTimestamp, oldTimestamp);
  } finally {
    oldDb.client.close();
  }
  const upgraded = openSqliteDatabase(oldPath);
  try {
    migrate(upgraded.db, { migrationsFolder: migrations });
    migrate(upgraded.db, { migrationsFolder: migrations });
    const stored = upgraded.client.prepare("SELECT title, version, base_content_version, generation_id FROM question_private_overrides WHERE owner_user_id = ?").get("legacy-user");
    assert.equal(stored.title, "旧题干");
    assert.equal(stored.version, 7);
    assert.equal(stored.base_content_version, "old-base");
    assert.match(stored.generation_id, /^[0-9a-f]{32}$/u, "0005 fills an existing row with a unique generation");
    for (const [table, expected] of [["user", 1], ["coach_conversations", 1], ["coach_provider_bindings", 1]]) {
      assert.equal(upgraded.client.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, expected, `${table} records survive 0005`);
    }
  } finally {
    upgraded.client.close();
  }

  process.stdout.write("Question private override tests passed.\n");
} finally {
  try { opened.client.close(); } catch {}
  rmSync(tempRoot, { recursive: true, force: true });
}
