import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { request as nodeRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { createCredentialStore } from "./storage.mjs";
import { createSiwcRuntime, SIWC, verifyOpenAiIdentity } from "./siwc.mjs";
import { createLocalHttpServer, LOCAL_SERVER, parseCookies } from "./http.mjs";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

const requiredScopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const redirectUri = LOCAL_SERVER.callbackUrl;
function providerMock(overrides = {}) {
  const calls = [];
  const responses = overrides.responses ?? "event: response.output_text.delta\ndata: {\"delta\":\"反馈片段\"}\n\nevent: response.completed\ndata: {}\n\n";
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === SIWC.discoveryUrl) {
      return new Response(JSON.stringify({
        issuer: SIWC.issuer,
        authorization_endpoint: SIWC.authorizationEndpoint,
        token_endpoint: SIWC.tokenEndpoint,
        jwks_uri: SIWC.jwksUrl,
        revocation_endpoint: "https://auth.openai.com/api/accounts/oauth/revoke",
      }), { headers: { "content-type": "application/json" } });
    }
    if (url === SIWC.tokenEndpoint) {
      const body = init.body instanceof URLSearchParams ? init.body : new URLSearchParams(String(init.body));
      const payloadValue = body.get("grant_type") === "refresh_token"
        ? overrides.refreshResponse?.(body, calls) ?? { access_token: "access-refreshed", refresh_token: "refresh-rotated", id_token: "id-token-refreshed", token_type: "Bearer", expires_in: 3600, scope: requiredScopes }
        : overrides.tokenResponse?.(body, calls) ?? { access_token: "access-initial", refresh_token: "refresh-initial", id_token: "id-token", token_type: "Bearer", expires_in: 3600, scope: requiredScopes };
      const payload = await Promise.resolve(payloadValue);
      const statusValue = typeof overrides.tokenStatus === "function" ? overrides.tokenStatus(body, calls) : overrides.tokenStatus;
      const status = statusValue ?? 200;
      return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    }
    if (url === "https://auth.openai.com/api/accounts/oauth/revoke") {
      return new Response(null, { status: overrides.revokeStatus ?? 200 });
    }
    if (url === SIWC.modelsUrl) {
      return new Response(JSON.stringify({ models: [
        { slug: "model-a", display_name: "Model A", visibility: "list" },
        { slug: "model-hidden", display_name: "Hidden", visibility: "internal" },
        { slug: "model-b", display_name: "Model B", visibility: "list" },
      ] }), { headers: { "content-type": "application/json" } });
    }
    if (url === SIWC.responsesUrl) {
      if (overrides.responsesStatus && overrides.responsesStatus !== 200) {
        return new Response(JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded" } }), {
          status: overrides.responsesStatus,
          headers: { "content-type": "application/json", "openai-request-id": "req-test" },
        });
      }
      const eventBody = typeof responses === "function" ? await responses(init, calls) : responses;
      return new Response(eventBody, { headers: { "content-type": "text/event-stream" } });
    }
    throw new Error(`Unexpected mocked provider URL: ${url}`);
  };
  return { fetchImpl, calls };
}

async function makeFixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "frontend-atlas-siwc-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createCredentialStore({ directory });
  const mock = providerMock(overrides);
  let subject = "verified-subject-1";
  let currentTime = Date.now();
  const runtime = createSiwcRuntime({
    store,
    fetchImpl: mock.fetchImpl,
    now: () => currentTime,
    verifyIdentity: async (_token, clientId, nonce) => ({
      subject,
      email: "learner@example.test",
      name: "Learner",
      clientId,
      nonce,
    }),
  });
  return {
    directory, store, runtime, mock,
    setSubject: (next) => { subject = next; },
    advance: (milliseconds) => { currentTime += milliseconds; },
  };
}

async function connectFixture(fixture, { browserSessionId = "B".repeat(43), scopes = requiredScopes } = {}) {
  const start = await fixture.runtime.beginAuth({ mode: "new", browserSessionId, redirectUri });
  const authorization = new URL(start.url);
  const callback = new URL(redirectUri);
  callback.searchParams.set("state", authorization.searchParams.get("state"));
  callback.searchParams.set("code", "mock-auth-code");
  callback.searchParams.set("client_id", "oaiapp_test123");
  const profile = await fixture.runtime.finishAuth(callback, browserSessionId);
  const sessionId = fixture.runtime.createSession(profile.clientId);
  return { start, authorization, callback, profile, sessionId, scopes };
}

test("dynamic public-client OAuth uses loopback, PKCE, state, nonce and the issued client id", async (t) => {
  const fixture = await makeFixture(t);
  const connected = await connectFixture(fixture);
  const params = connected.authorization.searchParams;
  assert.equal(connected.authorization.origin, "https://auth.openai.com");
  assert.equal(connected.authorization.pathname, "/api/accounts/authorize");
  assert.equal(params.get("client_id"), "dynamic_agent_client");
  assert.equal(params.get("agent_name_hint"), "知序 · 前端面试学习站");
  assert.match(params.get("ext_agent_host_id") ?? "", /^urn:uuid:/u);
  assert.equal(params.get("redirect_uri"), "http://127.0.0.1:4317/oauth/callback");
  assert.equal(params.get("resource"), SIWC.resource);
  assert.equal(params.get("code_challenge_method"), "S256");
  assert.equal(params.get("scope"), requiredScopes);
  assert.equal(params.has("client_secret"), false);

  const exchange = fixture.mock.calls.find((call) => call.url === SIWC.tokenEndpoint);
  const form = exchange.init.body;
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("client_id"), "oaiapp_test123");
  assert.equal(form.get("redirect_uri"), redirectUri);
  assert.equal(form.get("resource"), SIWC.resource);
  const computed = (await import("node:crypto")).createHash("sha256").update(form.get("code_verifier")).digest("base64url");
  assert.equal(computed, params.get("code_challenge"));
  assert.equal(connected.profile.profile.clientId, "oaiapp_test123");
  assert.equal(connected.profile.profile.planUsageEnabled, true);
  assert.equal((await fixture.runtime.status(connected.sessionId)).authenticated, true);
});

test("state is one-use, account callback errors stop before exchange, and identity mismatch preserves prior tokens", async (t) => {
  const fixture = await makeFixture(t);
  const browserSessionId = "C".repeat(43);
  const denied = await fixture.runtime.beginAuth({ mode: "new", browserSessionId, redirectUri });
  const deniedCallback = new URL(redirectUri);
  deniedCallback.searchParams.set("state", new URL(denied.url).searchParams.get("state"));
  deniedCallback.searchParams.set("error", "access_denied");
  await assert.rejects(fixture.runtime.finishAuth(deniedCallback, browserSessionId), { code: "authorization_denied" });
  assert.equal(fixture.mock.calls.filter((call) => call.url === SIWC.tokenEndpoint).length, 0);

  await fixture.runtime.beginAuth({ mode: "new", browserSessionId, redirectUri });
  const wrongCallback = new URL(redirectUri);
  wrongCallback.searchParams.set("state", "wrong-state");
  wrongCallback.searchParams.set("code", "never-exchange");
  await assert.rejects(fixture.runtime.finishAuth(wrongCallback, browserSessionId), { code: "oauth_state_mismatch" });
  assert.equal(fixture.mock.calls.filter((call) => call.url === SIWC.tokenEndpoint).length, 0);

  const first = await connectFixture(fixture, { browserSessionId });
  const stateBefore = await fixture.store.getState();
  const previous = stateBefore.profiles[0];
  fixture.setSubject("different-subject");
  const retry = await fixture.runtime.beginAuth({ mode: "saved", clientId: previous.clientId, browserSessionId, redirectUri });
  const retryUrl = new URL(retry.url);
  assert.equal(retryUrl.searchParams.get("client_id"), previous.clientId);
  assert.equal(retryUrl.searchParams.has("agent_name_hint"), false);
  const retryCallback = new URL(redirectUri);
  retryCallback.searchParams.set("state", retryUrl.searchParams.get("state"));
  retryCallback.searchParams.set("code", "other-user-code");
  await assert.rejects(fixture.runtime.finishAuth(retryCallback, browserSessionId), { code: "account_identity_mismatch" });
  const after = await fixture.store.getState();
  assert.equal(after.profiles[0].subject, previous.subject);
  assert.equal(after.profiles[0].accessToken, previous.accessToken);
  assert.ok(first.sessionId);
});

test("an issued new client id survives an expired code exchange and is reused to complete registration", async (t) => {
  let firstCodeExchange = true;
  const fixture = await makeFixture(t, {
    tokenStatus(body) {
      if (body.get("grant_type") === "authorization_code" && firstCodeExchange) {
        firstCodeExchange = false;
        return 400;
      }
      return 200;
    },
    tokenResponse(body) {
      if (body.get("code") === "expired-code") return { error: "invalid_grant" };
      return { access_token: "access-initial", refresh_token: "refresh-initial", id_token: "id-token", token_type: "Bearer", expires_in: 3600, scope: requiredScopes };
    },
  });
  const browserSessionId = "P".repeat(43);
  const first = await fixture.runtime.beginAuth({ mode: "new", browserSessionId, redirectUri });
  const firstCallback = new URL(redirectUri);
  firstCallback.searchParams.set("state", new URL(first.url).searchParams.get("state"));
  firstCallback.searchParams.set("code", "expired-code");
  firstCallback.searchParams.set("client_id", "oaiapp_pending123");
  await assert.rejects(fixture.runtime.finishAuth(firstCallback, browserSessionId), { code: "invalid_grant" });
  const afterFailure = await fixture.store.getState();
  assert.equal(afterFailure.profiles.length, 0);
  assert.equal(afterFailure.pendingRegistrations[0].clientId, "oaiapp_pending123");
  assert.equal(JSON.stringify(afterFailure.pendingRegistrations).includes("access-initial"), false);

  const retry = await fixture.runtime.beginAuth({ mode: "pending", clientId: "oaiapp_pending123", browserSessionId, redirectUri });
  const retryUrl = new URL(retry.url);
  assert.equal(retryUrl.searchParams.get("client_id"), "oaiapp_pending123");
  assert.equal(retryUrl.searchParams.has("agent_name_hint"), false);
  const retryCallback = new URL(redirectUri);
  retryCallback.searchParams.set("state", retryUrl.searchParams.get("state"));
  retryCallback.searchParams.set("code", "fresh-code");
  const completed = await fixture.runtime.finishAuth(retryCallback, browserSessionId);
  assert.equal(completed.profile.clientId, "oaiapp_pending123");
  const finalState = await fixture.store.getState();
  assert.equal(finalState.pendingRegistrations.length, 0);
  assert.equal(finalState.profiles[0].clientId, "oaiapp_pending123");
});

test("cross-browser completion is one-use and returns only an app-session handle, never provider tokens", async (t) => {
  const fixture = await makeFixture(t);
  const start = await fixture.runtime.beginAuth({ mode: "new", redirectUri });
  const callback = new URL(redirectUri);
  callback.searchParams.set("state", new URL(start.url).searchParams.get("state"));
  callback.searchParams.set("code", "mock-code");
  callback.searchParams.set("client_id", "oaiapp_polltest");
  const result = await fixture.runtime.finishAuth(callback);
  const callbackBrowserSession = fixture.runtime.createSession(result.clientId);
  assert.equal(fixture.runtime.completeAuthFlow(result.flowId, { clientId: result.clientId, sessionId: callbackBrowserSession }), true);
  const completion = await fixture.runtime.consumeAuthFlow(start.flowId);
  assert.equal(completion.state, "connected");
  assert.equal(completion.sessionId, callbackBrowserSession);
  assert.doesNotMatch(JSON.stringify(completion), /access-initial|refresh-initial|id-token/u);
  assert.equal((await fixture.runtime.consumeAuthFlow(start.flowId)).state, "expired");
});

test("JWT signature, issuer, audience, nonce and expiry are checked with JOSE", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048 });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "local-test-key";
  publicJwk.alg = "RS256";
  const jwks = createLocalJWKSet({ keys: [publicJwk] });
  const now = Date.now();
  const sign = (claims = {}) => new SignJWT({ nonce: "nonce-1", email: "a@example.test", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "local-test-key" })
    .setIssuer(SIWC.issuer)
    .setAudience("oaiapp_test123")
    .setSubject("subject-1")
    .setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(Math.floor(now / 1000) + 60)
    .sign(privateKey);
  const valid = await sign();
  const identity = await verifyOpenAiIdentity(valid, "oaiapp_test123", "nonce-1", { jwks, now });
  assert.equal(identity.subject, "subject-1");
  assert.equal(identity.email, "a@example.test");
  await assert.rejects(verifyOpenAiIdentity(valid, "oaiapp_other", "nonce-1", { jwks, now }), { code: "identity_token_invalid" });
  await assert.rejects(verifyOpenAiIdentity(valid, "oaiapp_test123", "wrong-nonce", { jwks, now }), { code: "identity_token_invalid" });
  const expired = await new SignJWT({ nonce: "nonce-1" })
    .setProtectedHeader({ alg: "RS256", kid: "local-test-key" })
    .setIssuer(SIWC.issuer)
    .setAudience("oaiapp_test123")
    .setSubject("subject-1")
    .setIssuedAt(Math.floor(now / 1000) - 100)
    .setExpirationTime(Math.floor(now / 1000) - 10)
    .sign(privateKey);
  await assert.rejects(verifyOpenAiIdentity(expired, "oaiapp_test123", "nonce-1", { jwks, now }), { code: "identity_token_invalid" });
});

test("credential data is written outside the repo with private directory and atomic 0600 file permissions", async (t) => {
  const fixture = await makeFixture(t);
  await connectFixture(fixture);
  const stored = await fixture.store.getState();
  const location = path.join(fixture.directory, "siwc-profiles.json");
  const info = await stat(location);
  if (process.platform !== "win32") assert.equal(info.mode & 0o777, 0o600);
  assert.equal(stored.profiles[0].accessToken, "access-initial");
  assert.equal(stored.profiles[0].refreshToken, "refresh-initial");
  assert.equal(stored.profiles[0].idToken, "id-token");
  assert.equal(await readFile(location, "utf8").then((text) => text.includes("access-initial")), true);
});

test("concurrent updates to separate profiles are serialized without losing either change", async (t) => {
  const fixture = await makeFixture(t);
  await fixture.store.getState();
  const base = { subject: "subject", email: "e@example.test", name: null, idToken: null, accessToken: null, refreshToken: null, expiresAt: 0, scopes: [], signedOutAt: null };
  await Promise.all([
    fixture.store.saveProfile({ ...base, clientId: "oaiapp_first" }),
    fixture.store.saveProfile({ ...base, clientId: "oaiapp_second" }),
  ]);
  await Promise.all([
    fixture.store.updateProfile("oaiapp_first", { accessToken: "first-token" }),
    fixture.store.updateProfile("oaiapp_second", { localSignoutPending: true }),
  ]);
  const stored = await fixture.store.getState();
  assert.equal(stored.profiles.length, 2);
  assert.equal(stored.profiles.find((item) => item.clientId === "oaiapp_first").accessToken, "first-token");
  assert.equal(stored.profiles.find((item) => item.clientId === "oaiapp_second").localSignoutPending, true);
});

test("refreshes serialize, model catalog is account-filtered, and inference uses supported preview fields", async (t) => {
  const fixture = await makeFixture(t);
  const connected = await connectFixture(fixture);
  await fixture.store.updateProfile("oaiapp_test123", { expiresAt: Date.now() - 1 });
  const [modelsA, modelsB] = await Promise.all([
    fixture.runtime.listModels(connected.sessionId),
    fixture.runtime.listModels(connected.sessionId),
  ]);
  assert.deepEqual(modelsA.map((item) => item.slug), ["model-a", "model-b"]);
  assert.deepEqual(modelsB, modelsA);
  assert.equal(fixture.mock.calls.filter((call) => call.url === SIWC.tokenEndpoint && call.init.body.get("grant_type") === "refresh_token").length, 1);
  const rotated = (await fixture.store.getState()).profiles[0];
  assert.equal(rotated.accessToken, "access-refreshed");
  assert.equal(rotated.refreshToken, "refresh-rotated");

  const response = await fixture.runtime.openFeedbackResponse(connected.sessionId, {
    questionId: "D13", mode: "critique", model: "model-a", answer: "我会解释顺序与拒绝传播。",
  }, new AbortController().signal);
  assert.equal(response.ok, true);
  const request = fixture.mock.calls.find((call) => call.url === SIWC.responsesUrl);
  const payload = JSON.parse(request.init.body);
  assert.equal(payload.store, false);
  assert.equal(payload.stream, true);
  assert.equal(payload.model, "model-a");
  assert.equal("previous_response_id" in payload, false);
  assert.equal("max_output_tokens" in payload, false);
  assert.equal(payload.input[0].role, "user");
  assert.match(payload.input[0].content, /D13/u);
  assert.match(payload.input[0].content, /Promise/u);
});

test("a missing ChatGPT plan scope blocks models and never falls back to another key", async (t) => {
  const fixture = await makeFixture(t, {
    tokenResponse: () => ({ access_token: "access-without-scope", refresh_token: "refresh-without-scope", id_token: "id-token", token_type: "Bearer", expires_in: 3600, scope: "openid profile email offline_access" }),
  });
  const connected = await connectFixture(fixture);
  const status = await fixture.runtime.status(connected.sessionId);
  assert.equal(status.authenticated, true);
  assert.equal(status.allowedModelsAvailable, false);
  await assert.rejects(fixture.runtime.listModels(connected.sessionId), { code: "plan_permission_required" });
  assert.equal(fixture.mock.calls.some((call) => call.url === SIWC.modelsUrl), false);
  assert.equal(fixture.mock.calls.some((call) => call.url === SIWC.responsesUrl), false);
});

test("logout attempts official refresh-token revocation, clears tokens and retains account registration", async (t) => {
  const fixture = await makeFixture(t);
  const connected = await connectFixture(fixture);
  const result = await fixture.runtime.signOut(connected.sessionId);
  assert.deepEqual(result, { revoked: true, localTokensCleared: true });
  const state = await fixture.store.getState();
  assert.equal(state.profiles.length, 1);
  assert.equal(state.profiles[0].clientId, "oaiapp_test123");
  assert.equal(state.profiles[0].subject, "verified-subject-1");
  assert.equal(state.profiles[0].accessToken, null);
  assert.equal(state.profiles[0].refreshToken, null);
  assert.equal(state.profiles[0].idToken, null);
  const revoke = fixture.mock.calls.find((call) => call.url.endsWith("/oauth/revoke"));
  assert.equal(revoke.init.body.get("token"), "refresh-initial");
  assert.equal(revoke.init.body.get("client_id"), "oaiapp_test123");
  assert.equal((await fixture.runtime.status(connected.sessionId)).authenticated, false);
});

test("logout waits for an in-flight refresh, revokes the rotated token, invalidates later saves and cancels active inference", async (t) => {
  let resolveRefresh;
  let responseSignal;
  const fixture = await makeFixture(t, {
    refreshResponse: () => new Promise((resolve) => { resolveRefresh = resolve; }),
    responses: (init) => {
      responseSignal = init.signal;
      return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("event: response.output_text.delta\\ndata: {\\\"delta\\\":\\\"partial\\\"}\\n\\n")); } });
    },
  });
  const connected = await connectFixture(fixture);
  await fixture.runtime.listModels(connected.sessionId);
  const streamResponse = await fixture.runtime.openFeedbackResponse(connected.sessionId, {
    questionId: "D13", mode: "hint", model: "model-a", answer: "",
  }, new AbortController().signal);
  assert.equal(streamResponse.ok, true);
  fixture.advance(11 * 60 * 1000);
  await fixture.store.updateProfile("oaiapp_test123", { expiresAt: Date.now() - 1 });
  const refreshRequest = fixture.runtime.listModels(connected.sessionId);
  while (!resolveRefresh) await new Promise((resolve) => setTimeout(resolve, 1));
  const logoutRequest = fixture.runtime.signOut(connected.sessionId);
  for (let attempt = 0; attempt < 100 && !responseSignal.aborted; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(responseSignal.aborted, true);
  resolveRefresh({ access_token: "access-rotated", refresh_token: "refresh-rotated", id_token: "id-token", expires_in: 3600, scope: requiredScopes });
  await Promise.allSettled([refreshRequest, logoutRequest]);
  const final = await fixture.store.getState();
  assert.equal(final.profiles[0].accessToken, null);
  assert.equal(final.profiles[0].refreshToken, null);
  const revoke = fixture.mock.calls.find((call) => call.url.endsWith("/oauth/revoke"));
  assert.equal(revoke.init.body.get("token"), "refresh-rotated");
});

test("failed local token clearing leaves a retry marker and never reports a false logout success", async (t) => {
  const fixture = await makeFixture(t);
  const originalClear = fixture.store.clearProfileTokens.bind(fixture.store);
  let failOnce = true;
  const store = {
    ...fixture.store,
    async clearProfileTokens(clientId) {
      if (failOnce) {
        failOnce = false;
        throw new Error("simulated disk error");
      }
      return originalClear(clientId);
    },
  };
  const runtime = createSiwcRuntime({
    store,
    fetchImpl: fixture.mock.fetchImpl,
    verifyIdentity: async () => ({ subject: "verified-subject-1", email: "learner@example.test", name: "Learner" }),
  });
  const connected = await connectFixture({ ...fixture, runtime });
  await assert.rejects(runtime.signOut(connected.sessionId), { code: "local_signout_failed" });
  const pending = await store.getState();
  assert.equal(pending.profiles[0].localSignoutPending, true);
  assert.equal((await runtime.status(connected.sessionId)).authenticated, false);
  assert.deepEqual(await runtime.signOut(null), { revoked: false, localTokensCleared: true });
  const cleared = await store.getState();
  assert.equal(cleared.profiles[0].localSignoutPending, false);
  assert.equal(cleared.profiles[0].accessToken, null);
  assert.equal(cleared.profiles[0].refreshToken, null);
});

async function reserveLoopbackPort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test("loopback API enforces exact Host/Origin and the streamed result only succeeds at completed", async (t) => {
  let responseCount = 0;
  let sourceCancelled = false;
  const fixture = await makeFixture(t, {
    responses: () => {
      responseCount += 1;
      if (responseCount === 1) return "event: response.output_text.delta\ndata: {\"delta\":\"first\"}\n\nevent: response.incomplete\ndata: {}\n\n";
      return new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event: response.output_text.delta\ndata: {\"delta\":\"done text\"}\n\nevent: response.completed\ndata: {}\n\nevent: response.output_text.delta\ndata: {\"delta\":\"after completion\"}\n\n"));
        },
        cancel() { sourceCancelled = true; },
      });
    },
  });
  const connected = await connectFixture(fixture);
  await fixture.runtime.listModels(connected.sessionId);
  const port = await reserveLoopbackPort();
  const serviceToken = "service-token-for-tests-only-000000000000";
  let providerSelectCalls = 0;
  const serverRuntime = {
    ...fixture.runtime,
    async selectProfile(...args) {
      providerSelectCalls += 1;
      return fixture.runtime.selectProfile(...args);
    },
  };
  const server = createLocalHttpServer({
    runtime: serverRuntime,
    openBrowser: async () => true,
    hostHeader: `127.0.0.1:${port}`,
    serviceToken,
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${port}`;
  const badHost = await new Promise((resolve, reject) => {
    const request = nodeRequest({
      host: "127.0.0.1",
      port,
      path: "/api/session",
      headers: { host: "evil.example", origin: LOCAL_SERVER.uiOrigin },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response));
    });
    request.once("error", reject);
    request.end();
  });
  assert.equal(badHost.statusCode, 403);
  const badOrigin = await fetch(`${base}/api/session`, { headers: { host: `127.0.0.1:${port}`, origin: "https://attacker.example" } });
  assert.equal(badOrigin.status, 403);
  assert.equal(badOrigin.headers.get("access-control-allow-origin"), null);

  const session = await fixture.runtime.createSession(connected.profile.clientId);
  const unauthorizedSelect = await fetch(`${base}/api/provider/select`, {
    method: "POST",
    headers: {
      host: `127.0.0.1:${port}`,
      origin: LOCAL_SERVER.uiOrigin,
      "content-type": "application/json",
    },
    body: JSON.stringify({ clientId: connected.profile.clientId }),
  });
  assert.equal(unauthorizedSelect.status, 403);
  assert.equal(providerSelectCalls, 0, "an unauthorized profile resume does not touch stored profiles");
  const authorizedSelect = await fetch(`${base}/api/provider/select`, {
    method: "POST",
    headers: {
      host: `127.0.0.1:${port}`,
      origin: LOCAL_SERVER.uiOrigin,
      "content-type": "application/json",
      "x-frontend-atlas-service-token": serviceToken,
    },
    body: JSON.stringify({ clientId: connected.profile.clientId }),
  });
  assert.equal(authorizedSelect.status, 204);
  assert.equal(providerSelectCalls, 1);
  assert.match(authorizedSelect.headers.get("set-cookie") ?? "", /^atlas_siwc_session=/u);
  const providerCallsBeforeUnauthorizedRequest = fixture.mock.calls.filter((call) => call.url === SIWC.responsesUrl).length;
  const unauthorizedAssistant = await fetch(`${base}/api/assistant/chat`, {
    method: "POST",
    headers: {
      host: `127.0.0.1:${port}`,
      origin: LOCAL_SERVER.uiOrigin,
      "content-type": "application/json",
      cookie: `atlas_siwc_session=${session}`,
    },
    body: JSON.stringify({ model: "model-a", messages: [{ role: "user", content: "must not reach provider" }] }),
  });
  assert.equal(unauthorizedAssistant.status, 403, "a browser-origin request without the service credential cannot invoke ChatGPT");
  assert.equal(
    fixture.mock.calls.filter((call) => call.url === SIWC.responsesUrl).length,
    providerCallsBeforeUnauthorizedRequest,
    "a rejected internal request performs zero upstream model calls",
  );
  const authorizedSession = await fetch(`${base}/api/provider/session`, {
    headers: {
      host: `127.0.0.1:${port}`,
      origin: LOCAL_SERVER.uiOrigin,
      cookie: `atlas_siwc_session=${session}`,
      "x-frontend-atlas-service-token": serviceToken,
    },
  });
  assert.equal(authorizedSession.status, 200);
  const authorizedSessionBody = await authorizedSession.json();
  assert.equal(authorizedSessionBody.account.clientId, connected.profile.clientId);
  assert.equal("profiles" in authorizedSessionBody, false, "the server-to-server status never returns the local profile list");

  const response = await fetch(`${base}/api/coaching`, {
    method: "POST",
    headers: {
      host: `127.0.0.1:${port}`,
      origin: LOCAL_SERVER.uiOrigin,
      "content-type": "application/json",
      cookie: `atlas_siwc_session=${session}`,
    },
    body: JSON.stringify({ questionId: "D13", mode: "critique", model: "model-a", answer: "顺序由位置决定。" }),
  });
  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.match(stream, /event: delta/u);
  assert.match(stream, /first/u);
  assert.match(stream, /event: error/u);
  assert.match(stream, /response_incomplete/u);
  assert.doesNotMatch(stream, /event: done/u);

  const completedResponse = await fetch(`${base}/api/coaching`, {
    method: "POST",
    signal: AbortSignal.timeout(2_000),
    headers: {
      host: `127.0.0.1:${port}`,
      origin: LOCAL_SERVER.uiOrigin,
      "content-type": "application/json",
      cookie: `atlas_siwc_session=${session}`,
    },
    body: JSON.stringify({ questionId: "D13", mode: "hint", model: "model-a", answer: "" }),
  });
  const completedStream = await completedResponse.text();
  assert.equal(completedResponse.status, 200);
  assert.match(completedStream, /done text/u);
  assert.doesNotMatch(completedStream, /after completion/u);
  assert.match(completedStream, /event: done/u);
  assert.equal(sourceCancelled, true, "The server must stop reading when response.completed arrives, even before upstream EOF.");

  const authStart = await fixture.runtime.beginAuth({ mode: "new", redirectUri });
  const authCallback = new URL(redirectUri);
  authCallback.searchParams.set("state", new URL(authStart.url).searchParams.get("state"));
  authCallback.searchParams.set("code", "mock-code-for-other-browser");
  authCallback.searchParams.set("client_id", "oaiapp_test123");
  const authResult = await fixture.runtime.finishAuth(authCallback);
  const callbackBrowserSession = fixture.runtime.createSession(authResult.clientId);
  fixture.runtime.completeAuthFlow(authResult.flowId, { clientId: authResult.clientId, sessionId: callbackBrowserSession });
  const blockedPoll = await fetch(`${base}/api/auth/complete`, {
    method: "POST",
    headers: { host: `127.0.0.1:${port}`, origin: "https://attacker.example", "content-type": "application/json" },
    body: JSON.stringify({ flowId: authStart.flowId }),
  });
  assert.equal(blockedPoll.status, 403);
  const poll = await fetch(`${base}/api/auth/complete`, {
    method: "POST",
    headers: { host: `127.0.0.1:${port}`, origin: LOCAL_SERVER.uiOrigin, "content-type": "application/json" },
    body: JSON.stringify({ flowId: authStart.flowId }),
  });
  assert.equal(poll.status, 200);
  assert.match(poll.headers.get("set-cookie") ?? "", /HttpOnly/u);
  const pollData = await poll.json();
  assert.equal(pollData.state, "connected");
  assert.equal(pollData.session.authenticated, true);
  assert.doesNotMatch(JSON.stringify(pollData), /access-initial|refresh-initial|id-token/u);
  const secondPoll = await fetch(`${base}/api/auth/complete`, {
    method: "POST",
    headers: { host: `127.0.0.1:${port}`, origin: LOCAL_SERVER.uiOrigin, "content-type": "application/json" },
    body: JSON.stringify({ flowId: authStart.flowId }),
  });
  assert.equal(secondPoll.status, 410);
});

test("429 provider errors preserve the bounded usage-limit code and friendly message", async (t) => {
  const fixture = await makeFixture(t, { responsesStatus: 429 });
  const connected = await connectFixture(fixture);
  await fixture.runtime.listModels(connected.sessionId);
  const port = await reserveLoopbackPort();
  const server = createLocalHttpServer({
    runtime: fixture.runtime,
    openBrowser: async () => true,
    hostHeader: `127.0.0.1:${port}`,
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));

  const response = await fetch(`http://127.0.0.1:${port}/api/coaching`, {
    method: "POST",
    headers: {
      host: `127.0.0.1:${port}`,
      origin: LOCAL_SERVER.uiOrigin,
      "content-type": "application/json",
      cookie: `atlas_siwc_session=${connected.sessionId}`,
    },
    body: JSON.stringify({ questionId: "D13", mode: "critique", model: "model-a", answer: "简要作答。" }),
  });
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), {
    error: "subscription_sharing_usage_limit_exceeded",
    message: "这个 ChatGPT 账号的应用用量已达到限制。请在 ChatGPT 设置的“用量”页面查看。",
    requestId: "req-test",
  });
});

test("cookie parser rejects duplicate names rather than choosing an attacker-controlled value", () => {
  const cookies = parseCookies("atlas_siwc_session=first; other=value; atlas_siwc_session=second");
  assert.equal(cookies.get("atlas_siwc_session"), null);
  assert.equal(cookies.get("other"), "value");
});
