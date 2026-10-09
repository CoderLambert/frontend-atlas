import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openSqliteDatabase } from "../src/lib/db/sqlite.ts";
import { AssistantRunManager } from "../src/lib/server/coach/assistant-run-manager.ts";
import { ConversationRepository } from "../src/lib/server/coach/conversation-repository.ts";
import { ConversationService } from "../src/lib/server/coach/conversation-service.ts";
import { ProviderBindingRepository } from "../src/lib/server/coach/provider-binding-repository.ts";
import { createProviderConnectionHandlers } from "../src/lib/server/coach/provider-connection-route-handler.ts";
import { createCoachAssistantRunHandlers } from "../src/lib/server/coach/route-handlers.ts";
import { createSiwcAssistantProvider, resumeAuthorizedSiwcProfile } from "../src/lib/server/coach/siwc-provider.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "frontend-atlas-provider-connection-"));
const databasePath = join(tempRoot, "provider.sqlite");
const migrationPath = new URL("../src/lib/db/migrations", import.meta.url).pathname;
const serverOnlyLoaderPath = join(tempRoot, "server-only-loader.mjs");
writeFileSync(serverOnlyLoaderPath, `export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
  return nextResolve(specifier, context);
}\n`);
register(pathToFileURL(serverOnlyLoaderPath), import.meta.url);
const { createSiwcAssistantProviderResolver } = await import("../src/lib/server/coach/siwc-provider-resolver.ts");

function request(userId, method, body) {
  const headers = new Headers({
    cookie: `site=${userId}; atlas_siwc_session=${"S".repeat(43)}`,
    origin: "http://localhost",
    "x-frontend-atlas-account-id": userId,
    "x-frontend-atlas-request": "1",
  });
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request("http://localhost/api/coach/provider-connection", {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

let opened;
try {
  opened = openSqliteDatabase(databasePath);
  migrate(opened.db, { migrationsFolder: migrationPath });
  const now = Date.now();
  const insertUser = opened.client.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
  insertUser.run("user-a", "User A", "a@example.test", 0, now, now);
  insertUser.run("user-b", "User B", "b@example.test", 0, now, now);

  const bindings = new ProviderBindingRepository(opened.db);
  bindings.createForOwner("user-a", "oaiapp_profile_a");
  const firstBinding = bindings.findForOwner("user-a");
  bindings.updateSelectedModel("user-a", firstBinding.version, "model-a");

  const conversations = new ConversationService(new ConversationRepository(opened.db));
  const history = conversations.create("user-a", { title: "History survives unbind" });
  assert.equal(history.kind, "created");
  conversations.appendUserMessage("user-a", history.conversation.id, { clientMessageId: "history-message", content: "keep me" });
  const runManager = new AssistantRunManager(conversations);
  let profileChecks = 0;
  let modelChecks = 0;
  let abortCalls = 0;
  const resumedProfileIds = [];
  let sessionProfile = {
    authenticated: true,
    account: { clientId: "oaiapp_profile_a", email: "chatgpt@example.test", name: "ChatGPT A", planUsageEnabled: true },
    allowedModelsAvailable: true,
  };
  const originalAbortBinding = runManager.abortBinding.bind(runManager);
  runManager.abortBinding = async (...args) => {
    abortCalls += 1;
    return originalAbortBinding(...args);
  };
  const handlers = createProviderConnectionHandlers(bindings, {
    async getUserId(incoming) {
      const match = /(?:^|; )site=(user-[ab])(?:;|$)/u.exec(incoming.headers.get("cookie") ?? "");
      return match?.[1] ?? null;
    },
  }, runManager, {
    trustedOriginUrl: "http://localhost",
    getSessionProfile: async () => {
      profileChecks += 1;
      return sessionProfile;
    },
    getModels: async () => {
      modelChecks += 1;
      return [{ slug: "model-a", displayName: "Model A" }, { slug: "model-b", displayName: "Model B" }];
    },
    resumeProfile: async (_request, clientId) => {
      resumedProfileIds.push(clientId);
      return { setCookie: `atlas_siwc_session=${"R".repeat(43)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200` };
    },
  });

  const connectedResponse = await handlers.get(request("user-a", "GET"));
  assert.equal(connectedResponse.status, 200);
  const connected = await connectedResponse.json();
  assert.equal(connected.connected, true);
  assert.equal(connected.selectedModel, "model-a");
  assert.deepEqual(connected.account, { name: "ChatGPT A", email: "chatgpt@example.test" });
  assert.equal("clientId" in connected.account, false, "the site DTO never exposes the SIWC profile id");

  sessionProfile = { authenticated: false, account: null, allowedModelsAvailable: false };
  assert.equal((await (await handlers.get(request("user-a", "GET"))).json()).reason, "session_required");
  sessionProfile = {
    authenticated: true,
    account: { clientId: "oaiapp_profile_other", email: null, name: null, planUsageEnabled: true },
    allowedModelsAvailable: true,
  };
  assert.equal((await (await handlers.get(request("user-a", "GET"))).json()).reason, "profile_mismatch");
  sessionProfile = {
    authenticated: true,
    account: { clientId: "oaiapp_profile_a", email: "chatgpt@example.test", name: "ChatGPT A", planUsageEnabled: false },
    allowedModelsAvailable: false,
  };
  assert.equal((await (await handlers.get(request("user-a", "GET"))).json()).reason, "plan_permission_required");
  sessionProfile = {
    authenticated: true,
    account: { clientId: "oaiapp_profile_a", email: "chatgpt@example.test", name: "ChatGPT A", planUsageEnabled: true },
    allowedModelsAvailable: true,
  };
  assert.equal((await (await handlers.get(request("user-a", "GET"))).json()).connected, true, "connection status recovers after the authorized session and permission are restored");

  profileChecks = 0;
  modelChecks = 0;
  const guessed = await handlers.updateModel(request("user-b", "PATCH", { model: "model-b", profileId: "oaiapp_profile_a" }));
  assert.equal(guessed.status, 403, "an unbound user cannot claim a guessed profile id");
  assert.equal(profileChecks, 0, "a guessed profile is rejected before touching the SIWC session service");
  assert.equal(modelChecks, 0, "a guessed profile is rejected before listing models");
  assert.equal(abortCalls, 0);

  const guessedResume = await handlers.resume(request("user-b", "POST", { profileId: "oaiapp_profile_a" }));
  assert.equal(guessedResume.status, 403, "an unbound user cannot resume a guessed profile id");
  assert.deepEqual(resumedProfileIds, [], "an unbound resume performs zero calls to the local profile service");

  const resumed = await handlers.resume(request("user-a", "POST", { profileId: "oaiapp_profile_other" }));
  assert.equal(resumed.status, 200);
  assert.deepEqual(resumedProfileIds, ["oaiapp_profile_a"], "resume uses only the server-side assigned profile id");
  assert.match(resumed.headers.get("set-cookie") ?? "", /^atlas_siwc_session=R+/u);

  const modelList = await handlers.models(request("user-a", "POST", {}));
  assert.equal(modelList.status, 200);
  assert.equal((await modelList.json()).models.length, 2);
  const updatedResponse = await handlers.updateModel(request("user-a", "PATCH", { model: "model-b" }));
  assert.equal(updatedResponse.status, 200);
  const updated = await updatedResponse.json();
  assert.equal(updated.selectedModel, "model-b");
  assert.equal(updated.bindingVersion, 3);
  assert.equal(abortCalls, 1, "changing the selected model cancels runs tied to the previous binding version");

  assert.throws(() => bindings.createForOwner("user-b", "oaiapp_profile_a"), /UNIQUE|unique/u, "one local profile cannot be assigned to two site users");

  const activeBinding = bindings.findForOwner("user-a");
  const activeRun = conversations.createAssistantRun("user-a", history.conversation.id, {
    clientRunId: "unbind-active-run",
    content: "keep the partial reply when the connection is removed",
    providerModel: activeBinding.selectedModel,
    providerBindingVersion: activeBinding.version,
  });
  assert.equal(activeRun.kind, "created");
  const activeHandle = runManager.start({
    runId: activeRun.run.id,
    ownerUserId: "user-a",
    conversationId: history.conversation.id,
    userContent: activeRun.userMessage.content,
    userMessage: activeRun.userMessage,
    assistantMessage: activeRun.assistantMessage,
    provider: {
      name: "siwc-chatgpt",
      model: activeBinding.selectedModel,
      bindingVersion: activeBinding.version,
      async *stream({ signal }) {
        yield "partial reply saved before unbind";
        await new Promise((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", resolve, { once: true });
        });
      },
    },
  });
  const activeEvents = activeHandle.events[Symbol.asyncIterator]();
  assert.equal((await activeEvents.next()).value.type, "started");
  assert.equal((await activeEvents.next()).value.type, "delta");

  const removedResponse = await handlers.remove(request("user-a", "DELETE", {}));
  assert.deepEqual(await removedResponse.json(), { unbound: true, historyPreserved: true });
  const removedRun = await activeHandle.completion;
  assert.equal(removedRun.status, "cancelled", "unbinding cancels an active run tied to that binding version");
  assert.equal(
    conversations.getAssistantRun("user-a", history.conversation.id, activeRun.run.id).assistantMessage.content,
    "partial reply saved before unbind",
    "unbinding preserves the streamed tail already received",
  );
  assert.equal(abortCalls, 2);
  assert.equal(conversations.find("user-a", history.conversation.id).messages[0].content, "keep me", "unbinding preserves conversation history");

  let internalFetches = 0;
  const staleProvider = createSiwcAssistantProvider({
    sessionCookie: "S".repeat(43),
    expectedClientId: "oaiapp_profile_a",
    model: "model-a",
    bindingVersion: 1,
    serviceToken: "service-token-for-tests-only-000000000000",
    bindingIsCurrent: () => false,
    fetchImpl: async () => {
      internalFetches += 1;
      throw new Error("must not fetch");
    },
  });
  await assert.rejects(async () => {
    for await (const chunk of staleProvider.stream({ content: "blocked", messages: [{ role: "user", content: "blocked" }], model: "model-a", signal: new AbortController().signal })) {
      assert.fail(`a stale provider unexpectedly yielded: ${chunk}`);
    }
  }, /连接已变更/u);
  assert.equal(internalFetches, 0, "a stale binding version performs zero calls to the local provider service");

  let step = 0;
  const partialProvider = createSiwcAssistantProvider({
    sessionCookie: "S".repeat(43),
    expectedClientId: "oaiapp_profile_a",
    model: "model-a",
    bindingVersion: 1,
    serviceToken: "service-token-for-tests-only-000000000000",
    fetchImpl: async (_url, init) => {
      assert.equal(new Headers(init.headers).get("x-frontend-atlas-service-token"), "service-token-for-tests-only-000000000000");
      step += 1;
      if (step === 1) return Response.json({ authenticated: true, account: { clientId: "oaiapp_profile_a", planUsageEnabled: true }, allowedModelsAvailable: true });
      return new Response("event: delta\ndata: \"saved tail\"\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  });
  let partial = "";
  await assert.rejects(async () => {
    for await (const chunk of partialProvider.stream({ content: "partial", messages: [{ role: "user", content: "partial" }], model: "model-a", signal: new AbortController().signal })) partial += chunk;
  }, /流提前结束/u);
  assert.equal(partial, "saved tail", "abnormal EOF keeps the yielded tail available for the run manager to persist before failing");

  let resumeRequest;
  const resumedCookie = await resumeAuthorizedSiwcProfile(
    request("user-a", "POST", {}),
    "oaiapp_profile_a",
    async (url, init) => {
      resumeRequest = { url: String(url), init };
      return new Response(null, {
        status: 204,
        headers: { "set-cookie": `atlas_siwc_session=${"N".repeat(43)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200` },
      });
    },
    "service-token-for-tests-only-000000000000",
  );
  assert.equal(resumeRequest.url, "http://127.0.0.1:4317/api/provider/select");
  assert.equal(new Headers(resumeRequest.init.headers).get("x-frontend-atlas-service-token"), "service-token-for-tests-only-000000000000");
  assert.deepEqual(JSON.parse(resumeRequest.init.body), { clientId: "oaiapp_profile_a" });
  assert.match(resumedCookie.setCookie, /^atlas_siwc_session=N+/u);

  bindings.createForOwner("user-a", "oaiapp_profile_a");
  const pipelineBinding = bindings.findForOwner("user-a");
  bindings.updateSelectedModel("user-a", pipelineBinding.version, "model-a");
  const pipelineConversation = conversations.create("user-a", { title: "Real provider pipeline" });
  assert.equal(pipelineConversation.kind, "created");
  const isolatedConversation = conversations.create("user-b", { title: "Must stay isolated" });
  assert.equal(isolatedConversation.kind, "created");
  const previousFetch = globalThis.fetch;
  const previousServiceToken = process.env.FRONTEND_ATLAS_SIWC_SERVICE_TOKEN;
  let upstreamAssistantCalls = 0;
  let internalPipelineCalls = 0;
  const upstreamMessageBatches = [];
  try {
    process.env.FRONTEND_ATLAS_SIWC_SERVICE_TOKEN = "service-token-for-tests-only-000000000000";
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      internalPipelineCalls += 1;
      assert.equal(new Headers(init.headers).get("x-frontend-atlas-service-token"), process.env.FRONTEND_ATLAS_SIWC_SERVICE_TOKEN);
      if (url.endsWith("/api/provider/session")) {
        return Response.json({
          authenticated: true,
          account: { clientId: "oaiapp_profile_a", email: "chatgpt@example.test", name: "ChatGPT A", planUsageEnabled: true },
          allowedModelsAvailable: true,
        });
      }
      if (url.endsWith("/api/provider/models")) {
        return Response.json({ models: [{ slug: "model-a", displayName: "Model A" }] });
      }
      if (url.endsWith("/api/assistant/chat")) {
        upstreamAssistantCalls += 1;
        const payload = JSON.parse(init.body);
        upstreamMessageBatches.push(payload.messages);
        assert.equal(payload.model, "model-a");
        const latestContent = payload.messages.at(-1).content;
        const reply = latestContent === "follow up with saved context"
          ? "Second SQLite reply"
          : "SQLite real pipeline reply";
        return new Response(`event: delta\ndata: ${JSON.stringify(reply)}\n\nevent: done\ndata: {"completed":true}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error(`unexpected internal URL: ${url}`);
    };
    const pipelineHandlers = createCoachAssistantRunHandlers(
      conversations,
      {
        async getUserId(incoming) {
          const match = /(?:^|; )site=(user-[ab])(?:;|$)/u.exec(incoming.headers.get("cookie") ?? "");
          return match?.[1] ?? null;
        },
      },
      runManager,
      {
        trustedOriginUrl: "http://localhost",
        getProvider: createSiwcAssistantProviderResolver(bindings),
      },
    );
    const pipelinePayload = { clientRunId: "real-pipeline-run", content: "persist this real pipeline reply" };
    const pipelineResponse = await pipelineHandlers.create(
      request("user-a", "POST", pipelinePayload),
      { params: Promise.resolve({ conversationId: pipelineConversation.conversation.id }) },
    );
    assert.equal(pipelineResponse.status, 200);
    assert.match(await pipelineResponse.text(), /"status":"complete"/u);
    const persistedPipeline = conversations.find("user-a", pipelineConversation.conversation.id);
    assert.equal(persistedPipeline.messages.at(-1).content, "SQLite real pipeline reply");
    assert.equal(persistedPipeline.messages.at(-1).status, "complete");
    const savedPipelineRun = opened.client.prepare("SELECT provider_model, provider_binding_version, status FROM coach_assistant_runs WHERE owner_user_id = ? AND client_run_id = ?").get("user-a", pipelinePayload.clientRunId);
    assert.deepEqual(savedPipelineRun, { provider_model: "model-a", provider_binding_version: 2, status: "complete" });

    const duplicatePipeline = await pipelineHandlers.create(
      request("user-a", "POST", pipelinePayload),
      { params: Promise.resolve({ conversationId: pipelineConversation.conversation.id }) },
    );
    assert.equal((await duplicatePipeline.json()).duplicate, true);
    assert.equal(upstreamAssistantCalls, 1, "an idempotent duplicate does not invoke the upstream assistant twice");

    const followUpPayload = { clientRunId: "real-pipeline-follow-up", content: "follow up with saved context" };
    const followUpResponse = await pipelineHandlers.create(
      request("user-a", "POST", followUpPayload),
      { params: Promise.resolve({ conversationId: pipelineConversation.conversation.id }) },
    );
    assert.equal(followUpResponse.status, 200);
    assert.match(await followUpResponse.text(), /"status":"complete"/u);
    assert.equal(upstreamAssistantCalls, 2, "a distinct follow-up starts exactly one new provider request");
    assert.deepEqual(upstreamMessageBatches[1], [
      { role: "user", content: "persist this real pipeline reply" },
      { role: "assistant", content: "SQLite real pipeline reply" },
      { role: "user", content: "follow up with saved context" },
    ], "a follow-up receives the saved user/assistant context in order");
    const persistedMultiTurn = conversations.find("user-a", pipelineConversation.conversation.id);
    assert.deepEqual(
      persistedMultiTurn.messages.map((message) => [message.role, message.content, message.status]),
      [
        ["user", "persist this real pipeline reply", "complete"],
        ["assistant", "SQLite real pipeline reply", "complete"],
        ["user", "follow up with saved context", "complete"],
        ["assistant", "Second SQLite reply", "complete"],
      ],
      "both turns persist in one SQLite conversation",
    );
    const restartedConversations = new ConversationService(new ConversationRepository(opened.db));
    assert.equal(restartedConversations.find("user-a", pipelineConversation.conversation.id).messages.length, 4, "multi-turn history reloads after a fresh service instance");
    assert.equal(restartedConversations.find("user-b", pipelineConversation.conversation.id), null, "another owner cannot read the multi-turn conversation");

    const callsBeforeGuess = internalPipelineCalls;
    const guessedPipeline = await pipelineHandlers.create(
      request("user-b", "POST", { clientRunId: "guessed-pipeline-run", content: "must not call upstream", profileId: "oaiapp_profile_a" }),
      { params: Promise.resolve({ conversationId: isolatedConversation.conversation.id }) },
    );
    assert.equal(guessedPipeline.status, 403);
    assert.equal(internalPipelineCalls, callsBeforeGuess, "an unbound site user is rejected before every SIWC or upstream call");
    assert.equal(conversations.find("user-b", isolatedConversation.conversation.id).messages.length, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousServiceToken === undefined) delete process.env.FRONTEND_ATLAS_SIWC_SERVICE_TOKEN;
    else process.env.FRONTEND_ATLAS_SIWC_SERVICE_TOKEN = previousServiceToken;
  }

  process.stdout.write("provider connection: controlled mapping and resume, DTO minimization, owner isolation, guessed-id zero-call rejection, real provider-to-SQLite persistence/idempotency/multi-turn recovery, model versioning, streaming unbind/tail preservation, stale binding rejection, service token forwarding, and abnormal EOF passed\n");
} finally {
  opened?.client.close();
  rmSync(tempRoot, { recursive: true, force: true });
}
