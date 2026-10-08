import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSqliteDatabase } from "../src/lib/db/sqlite.ts";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { ConversationRepository } from "../src/lib/server/coach/conversation-repository.ts";
import { ConversationService } from "../src/lib/server/coach/conversation-service.ts";
import { createCoachConversationHandlers } from "../src/lib/server/coach/route-handlers.ts";
import { coachWriteRequestHeader, createWriteRequestGuard } from "../src/lib/server/coach/write-request-guard.ts";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempRoot = mkdtempSync(join(tmpdir(), "frontend-atlas-server-chat-"));
const databasePath = join(tempRoot, "coach.sqlite");

function request(user, method, path, payload, options = {}) {
  const headers = new Headers();
  if (user) headers.set("cookie", `session=${user}`);
  if (options.origin !== null) headers.set("origin", options.origin ?? "http://localhost");
  if (payload !== undefined && options.contentType !== null) {
    headers.set("content-type", options.contentType ?? "application/json");
  }
  if (options.requestHeader !== null) {
    headers.set(coachWriteRequestHeader.name, options.requestHeader ?? coachWriteRequestHeader.value);
  }
  if (options.fetchSite) headers.set("sec-fetch-site", options.fetchSite);
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: options.rawBody ?? JSON.stringify(payload) }),
  });
}

function routeContext(conversationId) {
  return { params: Promise.resolve({ conversationId }) };
}

try {
  let opened = openSqliteDatabase(databasePath);
  migrate(opened.db, { migrationsFolder: join(projectRoot, "src/lib/db/migrations") });
  const { client } = opened;
  client.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("user-a", "User A", "a@example.test", 0, Date.now(), Date.now());
  client.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("user-b", "User B", "b@example.test", 0, Date.now(), Date.now());

  const sessions = {
    async getUserId(request) {
      const match = /^session=(user-[ab])$/u.exec(request.headers.get("cookie") ?? "");
      return match?.[1] ?? null;
    },
  };
  const makeHandlers = (database) => createCoachConversationHandlers(
    new ConversationService(new ConversationRepository(database)),
    sessions,
    { trustedOriginUrl: "http://localhost" },
  );
  let handlers = makeHandlers(opened.db);

  assert.equal((await handlers.list(request(null, "GET", "/api/coach/conversations"))).status, 401, "unauthenticated requests are rejected");

  const conversationCountBeforeGuardChecks = client.prepare("SELECT count(*) AS count FROM coach_conversations").get().count;
  const deniedWrites = [
    [request("user-a", "POST", "/api/coach/conversations", { title: "blocked" }, { origin: "https://evil.example", contentType: "text/plain" }), 403, "external Origin with text/plain is rejected"],
    [request("user-a", "POST", "/api/coach/conversations", { title: "blocked" }, { origin: "https://evil.example" }), 403, "malicious Origin is rejected"],
    [request("user-a", "POST", "/api/coach/conversations", { title: "blocked" }, { origin: "null" }), 403, "null Origin is rejected"],
    [request("user-a", "POST", "/api/coach/conversations", { title: "blocked" }, { origin: null }), 403, "missing Origin is rejected"],
    [request("user-a", "POST", "/api/coach/conversations", { title: "blocked" }, { contentType: "text/plain" }), 415, "text/plain is rejected on same-origin JSON writes"],
    [request("user-a", "POST", "/api/coach/conversations", { title: "blocked" }, { requestHeader: null }), 403, "missing custom request header is rejected"],
    [request("user-a", "POST", "/api/coach/conversations", { title: "blocked" }, { fetchSite: "cross-site" }), 403, "cross-site Fetch Metadata is rejected"],
  ];
  for (const [blockedRequest, expectedStatus, description] of deniedWrites) {
    assert.equal((await handlers.create(blockedRequest)).status, expectedStatus, description);
  }
  assert.equal(
    client.prepare("SELECT count(*) AS count FROM coach_conversations").get().count,
    conversationCountBeforeGuardChecks,
    "rejected writes have no database side effects",
  );

  assert.equal(
    (await handlers.create(request(null, "POST", "/api/coach/conversations", { title: "no session" }))).status,
    401,
    "a same-origin JSON write without a session is rejected before persistence",
  );

  const missingOriginGuard = createWriteRequestGuard(null);
  assert.equal(
    missingOriginGuard(request("user-a", "PATCH", "/api/coach/conversations", { title: "blocked" }))?.status,
    503,
    "writes fail closed when the trusted origin is not configured",
  );
  assert.equal(
    createWriteRequestGuard("http://localhost")(request("user-a", "PATCH", "/api/coach/conversations", { title: "patch" })),
    null,
    "the shared guard accepts a valid PATCH request for future write endpoints",
  );

  const createResponse = await handlers.create(request("user-a", "POST", "/api/coach/conversations", {
    ownerUserId: "user-b",
    title: "TypeScript",
    qid: "UNLISTED-QUESTION-24",
    contentVersion: "future-content-set-v9",
  }));
  assert.equal(createResponse.status, 201);
  const { conversation } = await createResponse.json();
  assert.equal(conversation.ownerUserId, "user-a", "the authenticated session owns the row even when the payload supplies another owner");
  assert.equal(conversation.qid, "UNLISTED-QUESTION-24", "unknown question IDs are preserved as text");
  assert.equal(conversation.contentVersion, "future-content-set-v9", "unknown content versions are preserved as text");

  const messageCountBeforeGuardChecks = client.prepare("SELECT count(*) AS count FROM coach_messages").get().count;
  assert.equal(
    (await handlers.delete(request("user-a", "DELETE", "/api/coach/conversations", undefined, { origin: "https://evil.example" }), routeContext(conversation.id))).status,
    403,
    "the delete handler rejects an external Origin before persistence",
  );
  assert.equal(
    (await handlers.appendMessage(request("user-a", "POST", "/api/coach/conversations", { clientMessageId: "blocked", content: "no" }, { origin: "https://evil.example" }), routeContext(conversation.id))).status,
    403,
    "the append handler rejects an external Origin before persistence",
  );
  assert.equal(client.prepare("SELECT count(*) AS count FROM coach_conversations WHERE id = ?").get(conversation.id).count, 1);
  assert.equal(client.prepare("SELECT count(*) AS count FROM coach_messages").get().count, messageCountBeforeGuardChecks);

  const otherUserList = await handlers.list(request("user-b", "GET", "/api/coach/conversations"));
  assert.deepEqual((await otherUserList.json()).conversations, [], "one user cannot list another user's conversations");
  assert.equal((await handlers.read(request("user-b", "GET", "/api/coach/conversations"), routeContext(conversation.id))).status, 404);
  assert.equal((await handlers.delete(request("user-b", "DELETE", "/api/coach/conversations"), routeContext(conversation.id))).status, 404);
  assert.equal((await handlers.appendMessage(request("user-b", "POST", "/api/coach/conversations", { clientMessageId: "forged", content: "no" }), routeContext(conversation.id))).status, 404);

  const firstMessageResponse = await handlers.appendMessage(request("user-a", "POST", "/api/coach/conversations", {
    ownerUserId: "user-b",
    clientMessageId: "message-a-1",
    content: "Explain type narrowing.",
  }), routeContext(conversation.id));
  assert.equal(firstMessageResponse.status, 201);
  const firstMessage = await firstMessageResponse.json();

  const duplicateResponse = await handlers.appendMessage(request("user-a", "POST", "/api/coach/conversations", {
    clientMessageId: "message-a-1",
    content: "Explain type narrowing.",
  }), routeContext(conversation.id));
  assert.equal(duplicateResponse.status, 200, "repeating the same client id is idempotent");
  const duplicate = await duplicateResponse.json();
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.message.id, firstMessage.message.id);

  const conflictResponse = await handlers.appendMessage(request("user-a", "POST", "/api/coach/conversations", {
    clientMessageId: "message-a-1",
    content: "Different content with the same id.",
  }), routeContext(conversation.id));
  assert.equal(conflictResponse.status, 409, "a reused id with different content is rejected");

  const userBConversationResponse = await handlers.create(request("user-b", "POST", "/api/coach/conversations", { title: "Own conversation" }));
  const { conversation: userBConversation } = await userBConversationResponse.json();
  const userBMessageResponse = await handlers.appendMessage(request("user-b", "POST", "/api/coach/conversations", {
    clientMessageId: "message-a-1",
    content: "Same client key is independent for another user.",
  }), routeContext(userBConversation.id));
  assert.equal(userBMessageResponse.status, 201, "message keys are unique within each owner, not globally");

  assert.throws(() => client.prepare(`
    INSERT INTO coach_messages (id, conversation_id, owner_user_id, client_message_id, role, content, status, created_at)
    VALUES ('cross-owner', ?, 'user-b', 'cross-owner-key', 'user', 'bad owner', 'complete', ?)
  `).run(conversation.id, Date.now()), /FOREIGN KEY/u, "the composite foreign key prevents a message from claiming another user's conversation");

  client.exec(`
    CREATE TRIGGER force_conversation_update_failure
    BEFORE UPDATE ON coach_conversations
    BEGIN
      SELECT RAISE(ABORT, 'test transaction rollback');
    END;
  `);
  await assert.rejects(handlers.appendMessage(request("user-a", "POST", "/api/coach/conversations", {
    clientMessageId: "message-rollback",
    content: "This insert must roll back.",
  }), routeContext(conversation.id)), /test transaction rollback/u);
  const rolledBackCount = client.prepare("SELECT count(*) AS count FROM coach_messages WHERE client_message_id = ?").get("message-rollback").count;
  assert.equal(rolledBackCount, 0, "message insert rolls back if the conversation update fails");
  client.exec("DROP TRIGGER force_conversation_update_failure");

  assert.equal((await handlers.read(request("user-a", "GET", "/api/coach/conversations"), routeContext(conversation.id))).status, 200);
  client.close();
  opened = openSqliteDatabase(databasePath);
  handlers = makeHandlers(opened.db);
  const afterRestartResponse = await handlers.read(request("user-a", "GET", "/api/coach/conversations"), routeContext(conversation.id));
  const afterRestart = await afterRestartResponse.json();
  assert.equal(afterRestartResponse.status, 200);
  assert.equal(afterRestart.conversation.messages.length, 1, "committed messages persist after closing and reopening SQLite");
  assert.equal(afterRestart.conversation.messages[0].content, "Explain type narrowing.");
  assert.equal((await handlers.delete(request("user-b", "DELETE", "/api/coach/conversations"), routeContext(conversation.id))).status, 404);
  assert.equal((await handlers.delete(request("user-a", "DELETE", "/api/coach/conversations"), routeContext(conversation.id))).status, 200);
  assert.equal(opened.client.prepare("SELECT count(*) AS count FROM coach_messages WHERE conversation_id = ?").get(conversation.id).count, 0, "owned conversation deletion cascades only its messages");
  opened.client.close();

  process.stdout.write("server chat: CSRF request guards, owner isolation, idempotency, constraints, rollback, and restart persistence passed\n");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
