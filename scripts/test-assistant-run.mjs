import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openSqliteDatabase } from "../src/lib/db/sqlite.ts";
import { AssistantRunManager } from "../src/lib/server/coach/assistant-run-manager.ts";
import { ConversationRepository } from "../src/lib/server/coach/conversation-repository.ts";
import { ConversationService } from "../src/lib/server/coach/conversation-service.ts";
import { createCoachAssistantRunHandlers } from "../src/lib/server/coach/route-handlers.ts";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempRoot = mkdtempSync(join(tmpdir(), "frontend-atlas-assistant-run-"));
const databasePath = join(tempRoot, "assistant.sqlite");
const migrationPath = join(projectRoot, "src/lib/db/migrations");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeRequest(userId, method, path, payload) {
  const headers = new Headers({
    cookie: `session=${userId}`,
    origin: "http://localhost",
    "x-frontend-atlas-account-id": userId,
    "x-frontend-atlas-request": "1",
  });
  if (payload !== undefined) headers.set("content-type", "application/json");
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

function context(conversationId, runId) {
  return { params: Promise.resolve({ conversationId, ...(runId ? { runId } : {}) }) };
}

function makeHandlers(service, provider, manager) {
  return createCoachAssistantRunHandlers(service, {
    async getUserId(request) {
      const match = /^session=(user-[ab])$/u.exec(request.headers.get("cookie") ?? "");
      return match?.[1] ?? null;
    },
  }, manager, {
    trustedOriginUrl: "http://localhost",
    getProvider: () => provider,
  });
}

const readerState = new WeakMap();

async function readEvent(reader) {
  const state = readerState.get(reader) ?? { decoder: new TextDecoder(), buffer: "" };
  readerState.set(reader, state);
  while (true) {
    const { value, done } = await reader.read();
    state.buffer += state.decoder.decode(value, { stream: !done });
    const newline = state.buffer.indexOf("\n");
    if (newline >= 0) {
      const line = state.buffer.slice(0, newline);
      state.buffer = state.buffer.slice(newline + 1);
      return JSON.parse(line);
    }
    if (done) throw new Error("Assistant event stream ended early.");
  }
}

async function readAllEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      events.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  return events;
}

function createProvider(stream, onStart = () => {}) {
  return {
    name: "local-mock",
    stream(input) {
      onStart(input);
      return stream(input);
    },
  };
}

function conversation(service, id, owner = "user-a", qid = "UNKNOWN-QID-KEEP") {
  const result = service.create(owner, { title: `Test ${id}`, qid });
  assert.equal(result.kind, "created");
  return result.conversation;
}

let opened;
try {
  opened = openSqliteDatabase(databasePath);
  migrate(opened.db, { migrationsFolder: migrationPath });
  const now = Date.now();
  opened.client.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("user-a", "User A", "a@example.test", 0, now, now);
  opened.client.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("user-b", "User B", "b@example.test", 0, now, now);

  let service = new ConversationService(new ConversationRepository(opened.db));
  let streamCalls = 0;
  const provider = createProvider(async function* () {
    yield "x".repeat(300);
    await delay(20);
    yield "final";
  }, () => { streamCalls += 1; });
  let manager = new AssistantRunManager(service);
  let handlers = makeHandlers(service, provider, manager);

  const unavailableConversation = conversation(service, "unavailable");
  const beforeUnavailable = opened.client.prepare("SELECT count(*) AS count FROM coach_assistant_runs").get().count;
  const unavailableHandlers = makeHandlers(service, null, manager);
  const unavailableResponse = await unavailableHandlers.create(
    makeRequest("user-a", "POST", "/runs", { clientRunId: "unavailable-key", content: "no fake reply" }),
    context(unavailableConversation.id),
  );
  assert.equal(unavailableResponse.status, 503, "an unconfigured provider fails closed before creating messages");
  assert.equal(opened.client.prepare("SELECT count(*) AS count FROM coach_assistant_runs").get().count, beforeUnavailable);

  const doubleSubmitConversation = conversation(service, "double-submit");
  assert.equal(doubleSubmitConversation.qid, "UNKNOWN-QID-KEEP", "unknown question ids remain unchanged");
  const runPayload = { clientRunId: "double-submit-key", content: "Persist before starting one mock run." };
  const firstResponse = await handlers.create(makeRequest("user-a", "POST", "/runs", runPayload), context(doubleSubmitConversation.id));
  assert.equal(firstResponse.status, 200);
  assert.match(firstResponse.headers.get("content-type"), /application\/x-ndjson/u);
  const duplicateResponse = await handlers.create(makeRequest("user-a", "POST", "/runs", runPayload), context(doubleSubmitConversation.id));
  assert.equal(duplicateResponse.status, 200);
  const duplicate = await duplicateResponse.json();
  assert.equal(duplicate.duplicate, true, "a duplicate HTTP request returns its persisted run snapshot");
  assert.equal(streamCalls, 1, "same idempotency key never starts a second provider request");
  const completeEvents = await readAllEvents(firstResponse);
  assert.equal(completeEvents[0].type, "started");
  assert.equal(completeEvents.at(-1).status, "complete");
  assert.equal(service.getAssistantRun("user-a", doubleSubmitConversation.id, duplicate.run.id).run.status, "complete");
  assert.equal(service.find("user-a", doubleSubmitConversation.id).messages.length, 2, "one atomic user/assistant message pair is persisted");
  assert.equal(service.getAssistantRun("user-b", doubleSubmitConversation.id, duplicate.run.id), null, "another account cannot read the run");

  const disconnectConversation = conversation(service, "disconnect");
  const partial = "saved-partial-".repeat(30);
  const disconnectProvider = createProvider(async function* ({ signal }) {
    yield partial;
    await delay(500);
    if (!signal.aborted) yield "must-not-arrive";
  });
  const disconnectManager = new AssistantRunManager(service);
  const disconnectHandlers = makeHandlers(service, disconnectProvider, disconnectManager);
  const disconnectResponse = await disconnectHandlers.create(
    makeRequest("user-a", "POST", "/runs", { clientRunId: "disconnect-key", content: "Disconnect mid-stream." }),
    context(disconnectConversation.id),
  );
  const disconnectReader = disconnectResponse.body.getReader();
  const disconnectStart = await readEvent(disconnectReader);
  assert.equal(disconnectStart.type, "started");
  const disconnectDelta = await readEvent(disconnectReader);
  assert.equal(disconnectDelta.type, "delta");
  await disconnectReader.cancel();
  await delay(20);
  const interrupted = service.getAssistantRun("user-a", disconnectConversation.id, disconnectStart.runId);
  assert.equal(interrupted.run.status, "interrupted", "stream disconnect persists an interrupted terminal state");
  assert.ok(interrupted.assistantMessage.content.startsWith("saved-partial-"), "disconnect preserves committed partial output");
  const acknowledgedStop = await disconnectHandlers.cancel(
    makeRequest("user-a", "POST", "/cancel", {}),
    context(disconnectConversation.id, disconnectStart.runId),
  );
  assert.equal((await acknowledgedStop.json()).run.status, "cancelled", "an explicit stop wins if a disconnect terminal races its response");

  const cancelConversation = conversation(service, "cancel");
  const cancelProvider = createProvider(async function* ({ signal }) {
    yield "user-visible-partial-".repeat(24);
    await delay(500);
    if (!signal.aborted) yield "must-not-arrive";
  });
  const cancelManager = new AssistantRunManager(service);
  const cancelHandlers = makeHandlers(service, cancelProvider, cancelManager);
  const cancelResponse = await cancelHandlers.create(
    makeRequest("user-a", "POST", "/runs", { clientRunId: "cancel-key", content: "Stop this run." }),
    context(cancelConversation.id),
  );
  const cancelReader = cancelResponse.body.getReader();
  const cancelStart = await readEvent(cancelReader);
  await readEvent(cancelReader);
  const cancelResult = await cancelHandlers.cancel(
    makeRequest("user-a", "POST", "/cancel", {}),
    context(cancelConversation.id, cancelStart.runId),
  );
  const cancelledBody = await cancelResult.json();
  assert.equal(cancelledBody.run.status, "cancelled", "explicit stop records a cancelled terminal state");
  assert.ok(cancelledBody.assistantMessage.content.startsWith("user-visible-partial-"), "stop preserves the partial answer");
  const cancelTerminal = await readEvent(cancelReader);
  assert.equal(cancelTerminal.status, "cancelled");

  const cancelWriteFailureConversation = conversation(service, "cancel-terminal-write-failure");
  opened.client.exec(`
    CREATE TRIGGER reject_assistant_cancelled_state
    BEFORE UPDATE OF status ON coach_messages
    WHEN NEW.role = 'assistant' AND NEW.status = 'cancelled'
    BEGIN SELECT RAISE(ABORT, 'test cancel terminal state failure'); END;
  `);
  const cancelTail = "cancelled reply tail is preserved";
  const cancelWriteFailureProvider = createProvider(async function* ({ signal }) {
    yield cancelTail;
    await delay(500);
    if (!signal.aborted) yield "must-not-arrive";
  });
  const cancelWriteFailureManager = new AssistantRunManager(service);
  const cancelWriteFailureHandlers = makeHandlers(service, cancelWriteFailureProvider, cancelWriteFailureManager);
  const cancelWriteFailureResponse = await cancelWriteFailureHandlers.create(
    makeRequest("user-a", "POST", "/runs", { clientRunId: "cancel-terminal-failure-key", content: "Fail the cancelled terminal write." }),
    context(cancelWriteFailureConversation.id),
  );
  const cancelWriteFailureReader = cancelWriteFailureResponse.body.getReader();
  const cancelWriteFailureStart = await readEvent(cancelWriteFailureReader);
  await readEvent(cancelWriteFailureReader);
  const cancelWriteFailureResult = await cancelWriteFailureHandlers.cancel(
    makeRequest("user-a", "POST", "/cancel", {}),
    context(cancelWriteFailureConversation.id, cancelWriteFailureStart.runId),
  );
  const cancelWriteFailureBody = await cancelWriteFailureResult.json();
  assert.equal(cancelWriteFailureBody.run.status, "cancelled", "a failed cancel write preserves the user's stop intent in the response");
  assert.equal(cancelWriteFailureBody.contentPersisted, true, "the separate content append preserves the visible tail");
  assert.equal(cancelWriteFailureBody.terminalStatusPersisted, false, "the response clearly reports the failed terminal write");
  assert.equal(cancelWriteFailureBody.assistantMessage.content, cancelTail);
  const cancelWriteFailureEvent = await readEvent(cancelWriteFailureReader);
  assert.equal(cancelWriteFailureEvent.status, "cancelled");
  assert.equal(cancelWriteFailureEvent.terminalStatusPersisted, false);
  const cancelWriteFailureRun = service.getAssistantRun("user-a", cancelWriteFailureConversation.id, cancelWriteFailureStart.runId);
  assert.equal(cancelWriteFailureRun.run.status, "streaming", "the database is not falsely changed to failed when cancellation could not persist");
  assert.equal(cancelWriteFailureRun.assistantMessage.content, cancelTail);
  opened.client.exec("DROP TRIGGER reject_assistant_cancelled_state");

  const appendFailureConversation = conversation(service, "append-write-failure");
  opened.client.exec(`
    CREATE TRIGGER reject_assistant_stream_content
    BEFORE UPDATE OF content ON coach_messages
    WHEN NEW.role = 'assistant' AND NEW.status = 'streaming' AND length(NEW.content) > 0
    BEGIN SELECT RAISE(ABORT, 'test append write failure'); END;
  `);
  const unhandledRejections = [];
  const recordUnhandledRejection = (reason) => { unhandledRejections.push(reason); };
  process.on("unhandledRejection", recordUnhandledRejection);
  const prefetchedTail = "persist through terminal fallback-".repeat(12);
  const appendFailureProvider = createProvider(async function* () {
    yield prefetchedTail;
    await delay(20);
    throw new Error("prefetched provider rejection");
  });
  const appendFailureManager = new AssistantRunManager(service);
  const appendFailureHandlers = makeHandlers(service, appendFailureProvider, appendFailureManager);
  const appendFailureResponse = await appendFailureHandlers.create(
    makeRequest("user-a", "POST", "/runs", { clientRunId: "append-failure-key", content: "Fail one streaming write." }),
    context(appendFailureConversation.id),
  );
  const appendFailureEvents = await readAllEvents(appendFailureResponse);
  await delay(60);
  process.off("unhandledRejection", recordUnhandledRejection);
  assert.deepEqual(unhandledRejections, [], "a prefetched iterator rejection is observed after the DB write exits early");
  const appendFailureTerminal = appendFailureEvents.at(-1);
  assert.equal(appendFailureTerminal.status, "failed");
  assert.equal(appendFailureTerminal.error, "assistant_content_write_failed");
  assert.equal(appendFailureTerminal.contentPersisted, true, "the failed terminal transition saves its pending tail");
  assert.equal(appendFailureTerminal.terminalStatusPersisted, true);
  const appendFailedRun = service.getAssistantRun("user-a", appendFailureConversation.id, appendFailureEvents[0].runId);
  assert.equal(appendFailedRun.run.status, "failed");
  assert.equal(appendFailedRun.assistantMessage.content, prefetchedTail);
  opened.client.exec("DROP TRIGGER reject_assistant_stream_content");

  const terminalWriteFailureConversation = conversation(service, "terminal-write-failure");
  opened.client.exec(`
    CREATE TRIGGER reject_assistant_terminal_states
    BEFORE UPDATE OF status ON coach_messages
    WHEN NEW.role = 'assistant' AND NEW.status IN ('complete', 'failed')
    BEGIN SELECT RAISE(ABORT, 'test terminal state failure'); END;
  `);
  const terminalTail = "visible tail recovered by append";
  const terminalFailureProvider = createProvider(async function* () {
    yield terminalTail;
  });
  const terminalFailureManager = new AssistantRunManager(service);
  const terminalFailureHandlers = makeHandlers(service, terminalFailureProvider, terminalFailureManager);
  const terminalFailureResponse = await terminalFailureHandlers.create(
    makeRequest("user-a", "POST", "/runs", { clientRunId: "terminal-failure-key", content: "Fail final state writes." }),
    context(terminalWriteFailureConversation.id),
  );
  const terminalFailureEvents = await readAllEvents(terminalFailureResponse);
  const terminalFailureEvent = terminalFailureEvents.at(-1);
  assert.equal(terminalFailureEvent.status, "failed", "a rejected completion never reports complete");
  assert.equal(terminalFailureEvent.error, "assistant_terminal_state_not_saved");
  assert.equal(terminalFailureEvent.contentPersisted, true, "the pending tail is retried as a content append");
  assert.equal(terminalFailureEvent.terminalStatusPersisted, false, "the event distinguishes an unsaved terminal status");
  const terminalFailedRun = service.getAssistantRun("user-a", terminalWriteFailureConversation.id, terminalFailureEvents[0].runId);
  assert.equal(terminalFailedRun.run.status, "streaming", "the persisted row is not mislabeled as failed when its terminal write failed");
  assert.equal(terminalFailedRun.assistantMessage.content, terminalTail);
  opened.client.exec("DROP TRIGGER reject_assistant_terminal_states");

  const unsavedTailConversation = conversation(service, "unsaved-tail");
  opened.client.exec(`
    CREATE TRIGGER reject_assistant_content_writes
    BEFORE UPDATE OF content ON coach_messages
    WHEN NEW.role = 'assistant' AND length(NEW.content) > 0
    BEGIN SELECT RAISE(ABORT, 'test content write failure'); END;
  `);
  const unsavedTailText = "still visible in the client";
  const unsavedTailProvider = createProvider(async function* () {
    yield unsavedTailText;
  });
  const unsavedTailManager = new AssistantRunManager(service);
  const unsavedTailHandlers = makeHandlers(service, unsavedTailProvider, unsavedTailManager);
  const unsavedTailResponse = await unsavedTailHandlers.create(
    makeRequest("user-a", "POST", "/runs", { clientRunId: "unsaved-tail-key", content: "Fail all reply writes." }),
    context(unsavedTailConversation.id),
  );
  const unsavedTailEvents = await readAllEvents(unsavedTailResponse);
  const unsavedTailEvent = unsavedTailEvents.at(-1);
  assert.equal(unsavedTailEvent.status, "failed");
  assert.equal(unsavedTailEvent.error, "assistant_content_not_saved");
  assert.equal(unsavedTailEvent.contentPersisted, false, "the client is told to recover the visible unsaved reply");
  assert.equal(unsavedTailEvent.terminalStatusPersisted, false);
  const unsavedTailRun = service.getAssistantRun("user-a", unsavedTailConversation.id, unsavedTailEvents[0].runId);
  assert.equal(unsavedTailRun.run.status, "streaming");
  assert.equal(unsavedTailRun.assistantMessage.content, "");
  opened.client.exec("DROP TRIGGER reject_assistant_content_writes");

  const failedConversation = conversation(service, "final-write-failure");
  opened.client.exec(`
    CREATE TRIGGER reject_assistant_complete
    BEFORE UPDATE OF status ON coach_messages
    WHEN NEW.role = 'assistant' AND NEW.status = 'complete'
    BEGIN SELECT RAISE(ABORT, 'test final write failure'); END;
  `);
  const failingProvider = createProvider(async function* () {
    yield "persisted before final transition";
  });
  const failedManager = new AssistantRunManager(service);
  const failedHandlers = makeHandlers(service, failingProvider, failedManager);
  const failedResponse = await failedHandlers.create(
    makeRequest("user-a", "POST", "/runs", { clientRunId: "final-failure-key", content: "Force final DB write failure." }),
    context(failedConversation.id),
  );
  const failedEvents = await readAllEvents(failedResponse);
  assert.equal(failedEvents.at(-1).status, "failed", "a failed final write never reports completion");
  assert.equal(failedEvents.at(-1).contentPersisted, true);
  assert.equal(failedEvents.at(-1).terminalStatusPersisted, true);
  const failedRun = service.getAssistantRun("user-a", failedConversation.id, failedEvents[0].runId);
  assert.equal(failedRun.run.status, "failed");
  assert.equal(failedRun.assistantMessage.status, "failed");
  assert.equal(failedRun.assistantMessage.content, "persisted before final transition", "partial output survives the failed complete transition");
  opened.client.exec("DROP TRIGGER reject_assistant_complete");

  const providerFailureConversation = conversation(service, "provider-failure");
  const failingProviderStream = createProvider(async function* () {
    yield "partial before provider error";
    throw new Error("mock provider failure");
  });
  const providerFailureManager = new AssistantRunManager(service);
  const providerFailureHandlers = makeHandlers(service, failingProviderStream, providerFailureManager);
  const providerFailureResponse = await providerFailureHandlers.create(
    makeRequest("user-a", "POST", "/runs", { clientRunId: "provider-failure-key", content: "Fail the mock stream." }),
    context(providerFailureConversation.id),
  );
  const providerFailureEvents = await readAllEvents(providerFailureResponse);
  assert.equal(providerFailureEvents.at(-1).status, "failed");
  const providerFailureRun = service.getAssistantRun("user-a", providerFailureConversation.id, providerFailureEvents[0].runId);
  assert.equal(providerFailureRun.run.status, "failed");
  assert.equal(providerFailureRun.assistantMessage.content, "partial before provider error");

  const restartConversation = conversation(service, "restart");
  const restartCreated = service.createAssistantRun("user-a", restartConversation.id, { clientRunId: "restart-key", content: "Interrupted before shutdown." });
  assert.equal(restartCreated.kind, "created");
  service.beginAssistantRun(restartCreated.run.id);
  service.appendAssistantRunContent(restartCreated.run.id, "persist this partial reply");
  opened.client.close();
  opened = openSqliteDatabase(databasePath);
  migrate(opened.db, { migrationsFolder: migrationPath });
  service = new ConversationService(new ConversationRepository(opened.db));
  const restored = service.getAssistantRun("user-a", restartConversation.id, restartCreated.run.id);
  assert.equal(restored.run.status, "interrupted", "startup recovery marks unfinished persisted runs interrupted");
  assert.equal(restored.assistantMessage.status, "interrupted");
  assert.equal(restored.assistantMessage.content, "persist this partial reply", "restart recovery preserves the last committed partial content");

  process.stdout.write("assistant run: fail-closed provider, atomic/idempotent creation, disconnect/cancel, cancel-write failure, content-tail recovery, terminal persistence signals, prefetched rejection handling, owner isolation, unknown qid preservation, and restart recovery passed\n");
} finally {
  try { opened?.client.close(); } catch { /* already closed during restart check */ }
  rmSync(tempRoot, { recursive: true, force: true });
}
