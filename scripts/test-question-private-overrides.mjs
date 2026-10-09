import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
  const makeHandlers = () => createQuestionPrivateOverrideHandlers(
    new QuestionPrivateOverrideService(new QuestionPrivateOverrideRepository(opened.db), new Set(["Q1"]), "content-v1"),
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
  assert.equal(new QuestionPrivateOverrideRepository(opened.db).find("user-b", "Q1"), null, "owner comes only from the verified session");

  response = await handlers.read(request("user-b", "GET", "Q1"), context("Q1"));
  assert.equal((await response.json()).override, null, "another user cannot see A's override");
  response = await handlers.save(request("user-b", "PATCH", "Q1", input(null, "B 的题干")), context("Q1"));
  assert.equal(response.status, 201);
  assert.equal((await response.json()).override.title, "B 的题干");

  response = await handlers.save(request("user-a", "PATCH", "Q1", input(null, "错误覆盖")), context("Q1"));
  assert.equal(response.status, 409, "create cannot overwrite an existing private version");
  response = await handlers.save(request("user-a", "PATCH", "Q1", input(1, "A 的第二版", first.generationId)), context("Q1"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).override.version, 2);
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
  assert.equal(recovered.version, 2);
  assert.equal(recovered.generationId, first.generationId, "generation survives restart");

  response = await handlers.delete(request("user-a", "DELETE", "Q1", { expectedVersion: 1, expectedGenerationId: first.generationId }), context("Q1"));
  assert.equal(response.status, 409, "stale delete is rejected");
  response = await handlers.delete(request("user-a", "DELETE", "Q1", { expectedVersion: 2, expectedGenerationId: first.generationId }), context("Q1"));
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

  process.stdout.write("Question private override tests passed.\n");
} finally {
  try { opened.client.close(); } catch {}
  rmSync(tempRoot, { recursive: true, force: true });
}
