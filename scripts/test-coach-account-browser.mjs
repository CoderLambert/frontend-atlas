import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openSqliteDatabase } from "../src/lib/db/sqlite.ts";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempRoot = mkdtempSync(join(tmpdir(), "frontend-atlas-account-browser-"));
const databasePath = join(tempRoot, "account.sqlite");
const browserProfilePath = join(tempRoot, "chromium-profile");
const migrationPath = join(projectRoot, "src/lib/db/migrations");
const chromiumPath = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const screenshotPath = join(tempRoot, "coach-account-mock-browser.png");
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

let nextProcess = null;
let chromeProcess = null;
let browserDebugPort = null;
const browserSockets = new Set();
let serverOutput = "";

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a local test port.");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function seedDatabase() {
  const opened = openSqliteDatabase(databasePath);
  migrate(opened.db, { migrationsFolder: migrationPath });
  const now = Date.now();
  const insertUser = opened.client.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
  insertUser.run("mock-user-a", "Mock User A", "mock-a@example.test", 0, now, now);
  insertUser.run("mock-user-b", "Mock User B", "mock-b@example.test", 0, now, now);
  opened.client.close();
}

function databaseCounts() {
  const opened = openSqliteDatabase(databasePath);
  try {
    return {
      conversations: opened.client.prepare("SELECT count(*) AS count FROM coach_conversations").get().count,
      messages: opened.client.prepare("SELECT count(*) AS count FROM coach_messages").get().count,
      userAMessages: opened.client.prepare("SELECT count(*) AS count FROM coach_messages WHERE owner_user_id = ?").get("mock-user-a").count,
      userBMessages: opened.client.prepare("SELECT count(*) AS count FROM coach_messages WHERE owner_user_id = ?").get("mock-user-b").count,
    };
  } finally {
    opened.client.close();
  }
}

function messagesForConversation(conversationId) {
  const opened = openSqliteDatabase(databasePath);
  try {
    return opened.client.prepare("SELECT owner_user_id, conversation_id, role, content FROM coach_messages WHERE conversation_id = ? ORDER BY created_at").all(conversationId)
      .map((row) => ({ ownerUserId: row.owner_user_id, conversationId: row.conversation_id, role: row.role, content: row.content }));
  } finally {
    opened.client.close();
  }
}

async function waitFor(check, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (nextProcess?.exitCode !== null && nextProcess?.exitCode !== undefined) {
      throw new Error(`Next dev server exited early (${nextProcess.exitCode}).\n${serverOutput.slice(-5000)}`);
    }
    await delay(120);
  }
  throw new Error(`Timed out waiting for ${label}.${lastError ? ` Last error: ${lastError.message}` : ""}\n${serverOutput.slice(-5000)}`);
}

function stopProcess(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 3000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
    child.kill("SIGTERM");
  });
}

function shellReadyExpression(expression) {
  return `(() => (${expression}))()`;
}

const setValueExpression = (selector, value) => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) throw new Error("Missing input ${selector}");
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
  if (setter) setter.call(element, ${JSON.stringify(value)});
  else element.value = ${JSON.stringify(value)};
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return element.value;
})()`;

async function connectBrowserTarget(target) {
  const browserSocket = new WebSocket(target.webSocketDebuggerUrl);
  browserSockets.add(browserSocket);
  browserSocket.addEventListener("close", () => browserSockets.delete(browserSocket), { once: true });
  await new Promise((resolve, reject) => {
    browserSocket.addEventListener("open", resolve, { once: true });
    browserSocket.addEventListener("error", reject, { once: true });
  });

  let nextCommandId = 0;
  const pending = new Map();
  browserSocket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const current = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) current.reject(new Error(message.error.message));
    else current.resolve(message.result ?? {});
  });

  function command(method, params = {}) {
    const id = ++nextCommandId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      browserSocket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        const current = pending.get(id);
        if (current) {
          pending.delete(id);
          reject(new Error(`Chromium command timed out: ${method}`));
        }
      }, 15_000);
    });
  }

  async function evaluate(expression) {
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "Browser expression failed.");
    return result.result?.value;
  }

  function close() {
    if (browserSocket.readyState < WebSocket.CLOSING) browserSocket.close();
  }

  return { command, evaluate, close };
}

async function createBrowserPage(startUrl) {
  mkdirSync(browserProfilePath, { recursive: true, mode: 0o700 });
  chromeProcess = spawn(chromiumPath, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--remote-debugging-port=0",
    `--user-data-dir=${browserProfilePath}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  let chromeOutput = "";
  chromeProcess.stderr.on("data", (chunk) => { chromeOutput = `${chromeOutput}${chunk}`.slice(-4000); });
  const activePortPath = join(browserProfilePath, "DevToolsActivePort");
  const portContents = await waitFor(() => existsSync(activePortPath) ? readFileSync(activePortPath, "utf8") : "", "Chromium DevTools", 15_000).catch((error) => {
    throw new Error(`${error.message}\n${chromeOutput}`);
  });
  [browserDebugPort] = portContents.trim().split("\n");
  const newPage = await fetch(`http://127.0.0.1:${browserDebugPort}/json/new?about%3Ablank`, { method: "PUT" });
  assert.equal(newPage.status, 200, "Chromium opens a fresh isolated test tab");
  const target = await newPage.json();
  const browser = await connectBrowserTarget(target);
  await browser.command("Page.enable");
  await browser.command("Runtime.enable");
  await browser.command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
  await browser.command("Page.navigate", { url: startUrl });
  return browser;
}

async function createBrowserTab(startUrl) {
  const newPage = await fetch(`http://127.0.0.1:${browserDebugPort}/json/new?about%3Ablank`, { method: "PUT" });
  assert.equal(newPage.status, 200, "Chromium opens a second tab in the same cookie profile");
  const tab = await connectBrowserTarget(await newPage.json());
  await tab.command("Page.enable");
  await tab.command("Runtime.enable");
  await tab.command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
  await tab.command("Page.navigate", { url: startUrl });
  return tab;
}

async function databaseLegacyRecord(browser) {
  return browser.evaluate(`new Promise((resolve, reject) => {
    const request = indexedDB.open("zhixu-study", 2);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("attempts", "readonly");
      const get = transaction.objectStore("attempts").get("legacy-preserve");
      get.onsuccess = () => resolve(get.result ?? null);
      get.onerror = () => reject(get.error);
      transaction.oncomplete = () => database.close();
    };
  })`);
}

async function databaseLegacyCoachConversation(browser) {
  return browser.evaluate(`new Promise((resolve, reject) => {
    const request = indexedDB.open("zhixu-study");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("coachConversations", "readonly");
      const get = transaction.objectStore("coachConversations").get("legacy-chat-preview");
      get.onsuccess = () => resolve(get.result ?? null);
      get.onerror = () => reject(get.error);
      transaction.oncomplete = () => database.close();
    };
  })`);
}

try {
  assert.ok(existsSync(chromiumPath), `Chromium binary exists at ${chromiumPath}`);
  seedDatabase();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const nextBin = join(projectRoot, "node_modules/next/dist/bin/next");
  const testEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    NODE_ENV: "development",
    NEXT_TELEMETRY_DISABLED: "1",
    FRONTEND_ATLAS_LOCAL_MODE: "1",
    NEXT_PUBLIC_FRONTEND_ATLAS_LOCAL_MODE: "1",
    FRONTEND_ATLAS_MOCK_AUTH: "1",
    FRONTEND_ATLAS_DB_PATH: databasePath,
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: "",
    GITHUB_CLIENT_ID: "",
    GITHUB_CLIENT_SECRET: "",
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
  };
  nextProcess = spawn(process.execPath, [nextBin, "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: projectRoot,
    env: testEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [nextProcess.stdout, nextProcess.stderr]) {
    stream.on("data", (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-10_000); });
  }

  await waitFor(async () => {
    const response = await fetch(`${origin}/api/site-account`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
    return response?.status === 200;
  }, "temporary Next.js account endpoint");
  const initialStatusResponse = await fetch(`${origin}/api/site-account`, { cache: "no-store" });
  const initialStatus = await initialStatusResponse.json();
  assert.deepEqual(initialStatus.providers, { github: false, google: false }, "unconfigured OAuth providers stay disabled");
  assert.equal(initialStatus.authConfigured, false, "real OAuth is not configured for this fixture");
  assert.equal(initialStatus.account, null, "the temporary browser starts signed out");
  assert.equal(initialStatus.mockAuthEnabled, true, "mock login is available only for this local test server");
  assert.equal(initialStatus.assistantProvider, "unavailable", "an unconfigured provider reports unavailable instead of returning a fake reply");

  const browser = await createBrowserPage(`${origin}/coach/sessions/`);
  await waitFor(() => browser.evaluate(shellReadyExpression("document.querySelector('[data-testid=mock-login-a]') !== null")), "mock login UI");
  const initialUi = await browser.evaluate(`(() => ({
    github: document.body.innerText.includes("GitHub") && document.body.innerText.includes("尚未配置"),
    google: document.body.innerText.includes("Google") && document.body.innerText.includes("尚未配置"),
    aiUnavailable: document.body.innerText.includes("AI 未连接"),
    noModelApiUrl: !document.body.innerText.includes("127.0.0.1:4317"),
  }))()`);
  assert.deepEqual(initialUi, { github: true, google: true, aiUnavailable: true, noModelApiUrl: true }, "the page distinguishes site login from an unavailable model");

  await browser.evaluate(`new Promise((resolve, reject) => {
    const request = indexedDB.open("zhixu-study", 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const [name, keyPath] of [["attempts", "attemptId"], ["drafts", "qid"], ["preferences", "key"], ["coachConversations", "conversationId"]]) {
        if (!database.objectStoreNames.contains(name)) database.createObjectStore(name, { keyPath });
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(["attempts", "coachConversations"], "readwrite");
      transaction.objectStore("attempts").put({ attemptId: "legacy-preserve", qid: "D13", originalAnswer: "legacy-only" });
      transaction.objectStore("coachConversations").put({
        conversationId: "legacy-chat-preview",
        qid: "UNLISTED-QID-EXACT",
        attemptId: "legacy-attempt-4",
        contentVersion: "legacy-content-v4",
        mode: "explain",
        model: "local-history-model",
        userInput: "Keep this old prompt.",
        assistantOutput: "Keep this partial old reply.",
        status: "streaming",
        startedAt: "2024-01-02T03:04:05.000Z",
        updatedAt: "2024-01-02T03:04:09.000Z",
      });
      transaction.oncomplete = () => { database.close(); resolve(true); };
      transaction.onerror = () => reject(transaction.error);
    };
  })`);
  assert.equal(databaseCounts().conversations, 0, "legacy IndexedDB records are not auto-imported on the signed-out page");

  await browser.evaluate("document.querySelector('[data-testid=mock-login-a]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.body.innerText.includes('mock-a@example.test')")), "mock account A login");
  assert.equal(databaseCounts().conversations, 0, "signing in does not import old local IndexedDB records");
  assert.equal(await browser.evaluate("document.querySelector('[data-testid=legacy-import]') === null"), true, "local Mock accounts do not show the authenticated legacy-import UI");
  const mockImportAttempt = await browser.evaluate(`fetch('/api/coach/conversations/legacy-import', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-frontend-atlas-request': '1', 'x-frontend-atlas-account-id': 'mock-user-a' },
    body: JSON.stringify({ records: [{ sourceId: 'mock-must-not-import', qid: 'D13', attemptId: null, contentVersion: 'v1', mode: 'explain', model: 'mock', userInput: 'x', assistantOutput: 'y', status: 'complete', startedAt: '2024-01-02T03:04:05.000Z', updatedAt: '2024-01-02T03:04:06.000Z' }] }),
  }).then(async (response) => ({ status: response.status, body: await response.json() }))`);
  assert.equal(mockImportAttempt.status, 401, "the real import route rejects a valid local Mock cookie");

  await browser.evaluate(`(() => {
    window.__legacyNativeFetch = window.fetch.bind(window);
    window.__legacyFakeAccountId = 'mock-user-a';
    window.__legacyFakeOAuth = true;
    window.__legacyImportCalls = 0;
    window.__legacyImportExpectedAccount = null;
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.origin);
      const method = init.method ?? 'GET';
      if (url.pathname === '/api/site-account' && method === 'GET') {
        const response = await window.__legacyNativeFetch(input, init);
        const data = await response.json();
        if (data.account && window.__legacyFakeOAuth) {
          data.account = { ...data.account, id: window.__legacyFakeAccountId, authMethod: 'oauth', email: window.__legacyFakeAccountId === 'mock-user-a' ? 'preview-a@example.test' : 'preview-b@example.test' };
        }
        return new Response(JSON.stringify(data), { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
      }
      if (url.pathname === '/api/coach/conversations/legacy-import' && method === 'POST') {
        window.__legacyImportCalls += 1;
        window.__legacyImportExpectedAccount = new Headers(init.headers).get('x-frontend-atlas-account-id');
      }
      return window.__legacyNativeFetch(input, init);
    };
  })()`);
  await browser.evaluate("document.querySelector('[data-testid=refresh-session-list]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.querySelector('[data-testid=legacy-import-preview-button]') !== null")), "the OAuth-only import panel for local-preview testing");
  await browser.evaluate("document.querySelector('[data-testid=legacy-import-preview-button]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.querySelector('[data-testid=legacy-import-preview]')?.innerText.includes('UNLISTED-QID-EXACT')")), "a local-only preview of the old conversation");
  const localPreviewText = await browser.evaluate("document.querySelector('[data-testid=legacy-import-preview]').innerText");
  assert.match(localPreviewText, /未关联题号 UNLISTED-QID-EXACT/u, "an unknown qid is shown as unlinked and remains exact");
  assert.match(localPreviewText, /原状态 streaming · 导入后标记中断/u, "the preview explains that old streaming output will stay historical");
  assert.equal(await browser.evaluate("window.__legacyImportCalls"), 0, "preview performs no network upload");
  await browser.evaluate("document.querySelector('[data-testid=legacy-import-confirm-open]').click()");
  await browser.evaluate("document.querySelector('[data-testid=legacy-import-cancel]').click()");
  assert.equal(await browser.evaluate("window.__legacyImportCalls"), 0, "closing the confirmation dialog performs no upload");
  await browser.evaluate("document.querySelector('[data-testid=legacy-import-confirm-open]').click()");
  await browser.evaluate("window.__legacyFakeOAuth = false; document.querySelector('[data-testid=refresh-session-list]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.body.innerText.includes('mock-a@example.test') && document.querySelector('[data-testid=legacy-import]') === null")), "the test returns to the real local Mock account before switching sessions");
  await browser.evaluate("document.querySelector('[data-testid=site-account-sign-out]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.querySelector('[data-testid=mock-login-b]') !== null")), "account A signs out");
  await browser.evaluate("window.__legacyFakeAccountId = 'mock-user-b'; window.__legacyFakeOAuth = true; document.querySelector('[data-testid=mock-login-b]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.body.innerText.includes('preview-b@example.test') && document.querySelector('[data-testid=legacy-import-preview]') === null")), "account B login clears the old local preview and confirmation");
  assert.equal(await browser.evaluate("document.querySelector('[data-testid=legacy-import-confirm]') === null"), true, "account switch requires a fresh preview and confirmation");
  assert.equal(await browser.evaluate("window.__legacyImportCalls"), 0, "a stale confirmation cannot upload after the account changes");
  await browser.evaluate("document.querySelector('[data-testid=legacy-import-preview-button]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.querySelector('[data-testid=legacy-import-preview]') !== null")), "fresh preview for the new account");
  await browser.evaluate("document.querySelector('[data-testid=legacy-import-confirm-open]').click()");
  await browser.evaluate("document.querySelector('[data-testid=legacy-import-confirm]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.querySelector('[data-testid=legacy-import-error]') !== null")), "server rejection for the injected OAuth display identity without a Better Auth session");
  assert.equal(await browser.evaluate("window.__legacyImportCalls"), 1, "upload begins only after the user explicitly confirms");
  assert.equal(await browser.evaluate("window.__legacyImportExpectedAccount"), "mock-user-b", "the upload is bound to the previewed account id");
  assert.deepEqual(await databaseLegacyCoachConversation(browser), {
    conversationId: "legacy-chat-preview",
    qid: "UNLISTED-QID-EXACT",
    attemptId: "legacy-attempt-4",
    contentVersion: "legacy-content-v4",
    mode: "explain",
    model: "local-history-model",
    userInput: "Keep this old prompt.",
    assistantOutput: "Keep this partial old reply.",
    status: "streaming",
    startedAt: "2024-01-02T03:04:05.000Z",
    updatedAt: "2024-01-02T03:04:09.000Z",
  }, "even a declined server import leaves the legacy IndexedDB record untouched");
  assert.equal(databaseCounts().conversations, 0, "the temporary Mock session created no server-side imports");
  await browser.evaluate("window.fetch = window.__legacyNativeFetch; document.querySelector('[data-testid=refresh-session-list]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.body.innerText.includes('mock-b@example.test') && document.querySelector('[data-testid=legacy-import]') === null")), "restore real local Mock account B after testing OAuth-only UI");
  await browser.evaluate("document.querySelector('[data-testid=site-account-sign-out]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.querySelector('[data-testid=mock-login-a]') !== null")), "account B signs out");
  await browser.evaluate("document.querySelector('[data-testid=mock-login-a]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.body.innerText.includes('mock-a@example.test') && document.querySelector('[data-testid=legacy-import]') === null")), "restore the real local Mock account A before the remaining account regressions");

  const titleA = "A browser session";
  await browser.evaluate(setValueExpression("#account-session-title", titleA));
  await browser.evaluate("document.querySelector('[data-testid=create-conversation]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression(`Array.from(document.querySelectorAll('[data-testid^="conversation-"]')).some((item) => item.innerText.includes(${JSON.stringify(titleA)}))`)), "A's new session");
  const conversationTestId = await browser.evaluate(`document.querySelector('[data-testid^="conversation-"]').getAttribute('data-testid')`);
  const conversationId = conversationTestId.slice("conversation-".length);
  assert.ok(conversationId, "conversation id is present in the account UI");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.querySelector('#account-message') !== null")), "composer for the newly created conversation");

  const messageA = "只保存用户消息，不生成助手回复。";
  await browser.evaluate(`(() => {
    const nativeFetch = window.fetch.bind(window);
    window.__failNextCoachMessageResponse = true;
    window.fetch = async (input, init = {}) => {
      const url = typeof input === "string" ? input : input.url;
      const method = init.method ?? "GET";
      if (window.__failNextCoachMessageResponse && url.includes("/messages") && method === "POST") {
        window.__failNextCoachMessageResponse = false;
        const response = await nativeFetch(input, init);
        window.__lostCoachResponseStatus = response.status;
        throw new TypeError("test-only: response lost after server commit");
      }
      return nativeFetch(input, init);
    };
  })()`);
  await browser.evaluate(setValueExpression("#account-message", messageA));
  await browser.evaluate("document.querySelector('[data-testid=send-message]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.querySelector('[data-testid=retry-message]') !== null")), "retry button after simulated lost response");
  assert.equal(await browser.evaluate("document.querySelector('[data-testid=message-draft]').value"), messageA, "the message draft remains available after a lost response");
  assert.equal(await browser.evaluate("window.__lostCoachResponseStatus"), 201, "the first request committed before the browser simulated losing its response");
  assert.equal(databaseCounts().userAMessages, 1, "the first message is durable in the temporary SQLite database");

  await browser.evaluate("document.querySelector('[data-testid=retry-message]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.querySelectorAll('[data-testid=saved-message]').length === 1 && document.body.innerText.includes('没有重复新增')")), "idempotent same-id retry");
  assert.equal(databaseCounts().userAMessages, 1, "retry with the same idempotency key creates no second row");

  await browser.command("Page.reload", { ignoreCache: true });
  await waitFor(() => browser.evaluate(shellReadyExpression("document.querySelector('[data-testid=saved-message]')?.innerText.includes('只保存用户消息')")), "message restore after browser refresh");
  assert.match(await browser.evaluate("location.search"), new RegExp(`conversation=${conversationId}`), "refresh restores the selected conversation URL");
  const screenshot = await browser.command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, fromSurface: true });
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
  process.stdout.write(`Screenshot saved from the refreshed Mock A account page: ${screenshotPath}\n`);

  const titleCreatedDuringPendingReads = "B created while A detail was pending";
  const messageCreatedDuringPendingReads = "创建B后保存的消息必须只出现在B。";
  await browser.evaluate(`(() => {
    const nativeFetch = window.fetch.bind(window);
    window.__holdAConversationDetailOnce = true;
    window.__heldAConversationDetailStarted = false;
    window.__releaseHeldAConversationDetail = null;
    window.__holdNextConversationListSnapshot = false;
    window.__heldConversationListSnapshotStarted = false;
    window.__releaseHeldConversationListSnapshot = null;
    window.fetch = async (input, init = {}) => {
      const url = typeof input === "string" ? new URL(input, location.origin) : new URL(input.url);
      const method = init.method ?? "GET";
      if (window.__holdAConversationDetailOnce && (url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname) === ${JSON.stringify(`/api/coach/conversations/${conversationId}`)} && method === "GET") {
        window.__holdAConversationDetailOnce = false;
        window.__heldAConversationDetailStarted = true;
        return new Promise((resolve, reject) => {
          window.__releaseHeldAConversationDetail = async () => {
            try {
              const uncancelled = { ...init, signal: undefined };
              const response = await nativeFetch(input, uncancelled);
              resolve(response);
              return response.status;
            } catch (error) { reject(error); throw error; }
          };
        });
      }
      if (window.__holdNextConversationListSnapshot && (url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname) === "/api/coach/conversations" && method === "GET") {
        window.__holdNextConversationListSnapshot = false;
        const response = await nativeFetch(input, init);
        window.__heldConversationListSnapshotStarted = true;
        return new Promise((resolve) => {
          window.__releaseHeldConversationListSnapshot = () => { resolve(response); return response.status; };
        });
      }
      return nativeFetch(input, init);
    };
  })()`);
  await browser.evaluate("document.querySelector('[data-testid=refresh-session-list]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("window.__heldAConversationDetailStarted")), "A's delayed detail request");
  await browser.evaluate("window.__holdNextConversationListSnapshot = true; document.querySelector('[data-testid=refresh-session-list]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("window.__heldConversationListSnapshotStarted")), "a pre-create conversation-list snapshot");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.querySelector('[data-testid=create-conversation]')?.disabled === false")), "account refresh to finish before creating B");
  await browser.evaluate(setValueExpression("#account-session-title", titleCreatedDuringPendingReads));
  await browser.evaluate("document.querySelector('[data-testid=create-conversation]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression(`Array.from(document.querySelectorAll('[data-testid^="conversation-"]')).some((item) => item.innerText.includes(${JSON.stringify(titleCreatedDuringPendingReads)}))`)), "B created while A reads are held");
  const createdDuringPendingReadsId = await browser.evaluate(`document.querySelector('[data-testid^="conversation-"].is-active')?.getAttribute('data-testid')?.slice('conversation-'.length)`);
  assert.ok(createdDuringPendingReadsId, "new conversation B is selected before the delayed reads return");
  await browser.evaluate("window.__releaseHeldAConversationDetail()");
  await browser.evaluate("window.__releaseHeldConversationListSnapshot()");
  await delay(250);
  const detailAfterStaleResponses = await browser.evaluate("document.querySelector('.coach-account-session-detail')?.innerText ?? ''");
  assert.ok(detailAfterStaleResponses.includes(titleCreatedDuringPendingReads), "late A detail and old list response cannot replace the newly selected B detail");
  assert.equal(detailAfterStaleResponses.includes(messageA), false, "A's message never appears in B's detail");
  assert.equal(await browser.evaluate("location.search"), `?conversation=${createdDuringPendingReadsId}`, "the URL continues to identify B after stale responses arrive");
  assert.deepEqual(messagesForConversation(conversationId).map((message) => message.content), [messageA], "A retains only its original message");

  await browser.evaluate(`(() => {
    const nativeFetch = window.fetch.bind(window);
    window.__holdBMessageResponse = true;
    window.__heldBMessageStatus = null;
    window.__releaseBMessageResponse = null;
    window.fetch = async (input, init = {}) => {
      const url = typeof input === "string" ? new URL(input, location.origin) : new URL(input.url);
      if (window.__holdBMessageResponse && url.pathname === ${JSON.stringify(`/api/coach/conversations/${createdDuringPendingReadsId}/messages`)} && (init.method ?? "GET") === "POST") {
        window.__holdBMessageResponse = false;
        const response = await nativeFetch(input, init);
        window.__heldBMessageStatus = response.status;
        return new Promise((resolve) => {
          window.__releaseBMessageResponse = () => { resolve(response); return response.status; };
        });
      }
      return nativeFetch(input, init);
    };
  })()`);
  await browser.evaluate(setValueExpression("#account-message", messageCreatedDuringPendingReads));
  await browser.evaluate("document.querySelector('[data-testid=send-message]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("window.__heldBMessageStatus === 201")), "B message committed before its response is held");
  assert.deepEqual(messagesForConversation(createdDuringPendingReadsId).map((message) => message.content), [messageCreatedDuringPendingReads], "the in-flight submission is stored against B's real conversation id");
  await browser.evaluate(`document.querySelector('[data-testid="conversation-${conversationId}"]').click()`);
  await waitFor(() => browser.evaluate(shellReadyExpression(`document.querySelector('.coach-account-session-detail')?.innerText.includes(${JSON.stringify(titleA)}) && document.querySelector('.coach-account-session-detail')?.innerText.includes(${JSON.stringify(messageA)})`)), "A detail loads while B's save response is still held");
  assert.equal(await browser.evaluate(`document.querySelector('.coach-account-session-detail')?.innerText.includes(${JSON.stringify(messageCreatedDuringPendingReads)})`), false, "A does not show B's message while B's save is in flight");
  await browser.evaluate("window.__releaseBMessageResponse()");
  await delay(200);
  assert.equal(await browser.evaluate(`document.querySelector('.coach-account-session-detail')?.innerText.includes(${JSON.stringify(messageCreatedDuringPendingReads)})`), false, "B's late save callback cannot append into A's open detail");
  await browser.evaluate(`document.querySelector('[data-testid="conversation-${createdDuringPendingReadsId}"]').click()`);
  await waitFor(() => browser.evaluate(shellReadyExpression(`Array.from(document.querySelectorAll('[data-testid=saved-message]')).some((item) => item.innerText.includes(${JSON.stringify(messageCreatedDuringPendingReads)}))`)), "B reloads its persisted message after returning from A");
  assert.deepEqual(messagesForConversation(createdDuringPendingReadsId), [{ ownerUserId: "mock-user-a", conversationId: createdDuringPendingReadsId, role: "user", content: messageCreatedDuringPendingReads }], "only B contains the new user message in temporary SQLite");
  assert.deepEqual(databaseCounts(), { conversations: 2, messages: 2, userAMessages: 2, userBMessages: 0 }, "message submitted after stale responses is persisted once to B in temporary SQLite");

  await browser.evaluate(`(() => {
    const nativeFetch = window.fetch.bind(window);
    window.__heldListAborted = false;
    window.__holdNextCoachList = true;
    window.fetch = async (input, init = {}) => {
      const url = typeof input === "string" ? new URL(input, location.origin) : new URL(input.url);
      if (window.__holdNextCoachList && url.pathname === "/api/coach/conversations" && (init.method ?? "GET") === "GET") {
        window.__holdNextCoachList = false;
        return new Promise((resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            window.__heldListAborted = true;
            reject(new DOMException("Account changed", "AbortError"));
          }, { once: true });
        });
      }
      return nativeFetch(input, init);
    };
  })()`);
  await browser.evaluate("document.querySelector('[data-testid=refresh-session-list]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("window.__holdNextCoachList === false && document.querySelector('[data-testid=site-account-sign-out]') !== null")), "held A list request");
  await browser.evaluate("document.querySelector('[data-testid=site-account-sign-out]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.querySelector('[data-testid=mock-login-a]') !== null")), "account A logout");
  assert.equal(await browser.evaluate("window.__heldListAborted"), true, "logout aborts the old account's pending list request");
  assert.equal(await browser.evaluate(`document.body.innerText.includes(${JSON.stringify(titleA)})`), false, "logout clears the old account's conversation from the UI");

  await browser.evaluate("document.querySelector('[data-testid=mock-login-b]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.body.innerText.includes('mock-b@example.test')")), "mock account B login");
  assert.equal(await browser.evaluate(`document.body.innerText.includes(${JSON.stringify(titleA)})`), false, "account B never sees account A's list entry");
  assert.deepEqual(databaseCounts(), { conversations: 2, messages: 2, userAMessages: 2, userBMessages: 0 }, "account B login leaves A's stored records isolated");

  const privateRead = await browser.evaluate(`fetch(${JSON.stringify(`/api/coach/conversations/${conversationId}`)}, { cache: "no-store", headers: { "x-frontend-atlas-account-id": "mock-user-b" } }).then(async (response) => ({ status: response.status, body: await response.json() }))`);
  assert.equal(privateRead.status, 404, "account B cannot read account A's conversation by id");
  const privateWrite = await browser.evaluate(`fetch(${JSON.stringify(`/api/coach/conversations/${conversationId}/messages`)}, {
    method: "POST",
    headers: { "content-type": "application/json", "x-frontend-atlas-request": "1", "x-frontend-atlas-account-id": "mock-user-b" },
    body: JSON.stringify({ clientMessageId: "cross-owner-attempt", content: "must not persist", ownerUserId: "mock-user-a" }),
  }).then(async (response) => ({ status: response.status, body: await response.json() }))`);
  assert.equal(privateWrite.status, 404, "owner identity is derived from B's server session, not a forged body field");
  assert.deepEqual(databaseCounts(), { conversations: 2, messages: 2, userAMessages: 2, userBMessages: 0 }, "cross-owner read and write attempts have no side effects");

  const titleB = "B private session";
  await browser.evaluate(setValueExpression("#account-session-title", titleB));
  await browser.evaluate("document.querySelector('[data-testid=create-conversation]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression(`Array.from(document.querySelectorAll('[data-testid^="conversation-"]')).some((item) => item.innerText.includes(${JSON.stringify(titleB)}))`)), "B's private session");

  await browser.evaluate(`(() => {
    const nativeFetch = window.fetch.bind(window);
    window.__heldListAborted = false;
    window.__holdNextCoachList = true;
    window.fetch = async (input, init = {}) => {
      const url = typeof input === "string" ? new URL(input, location.origin) : new URL(input.url);
      if (window.__holdNextCoachList && url.pathname === "/api/coach/conversations" && (init.method ?? "GET") === "GET") {
        window.__holdNextCoachList = false;
        return new Promise((resolve, reject) => init.signal?.addEventListener("abort", () => {
          window.__heldListAborted = true;
          reject(new DOMException("Account changed", "AbortError"));
        }, { once: true }));
      }
      return nativeFetch(input, init);
    };
  })()`);
  await browser.evaluate("document.querySelector('[data-testid=refresh-session-list]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("window.__holdNextCoachList === false")), "held B list request");
  await browser.evaluate("document.querySelector('[data-testid=site-account-sign-out]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.querySelector('[data-testid=mock-login-a]') !== null")), "account B logout");
  assert.equal(await browser.evaluate("window.__heldListAborted"), true, "logout cancels B's pending account data request");
  assert.equal(await browser.evaluate(`document.body.innerText.includes(${JSON.stringify(titleB)})`), false, "logout clears B's list and detail cache from the page");

  const secondTab = await createBrowserTab(`${origin}/coach/sessions/`);
  await waitFor(() => secondTab.evaluate(shellReadyExpression("document.querySelector('[data-testid=mock-login-a]') !== null")), "second tab loads signed-out account state");
  await browser.evaluate("document.querySelector('[data-testid=mock-login-a]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.body.innerText.includes('mock-a@example.test')")), "account A login in the first tab");
  await waitFor(() => secondTab.evaluate(shellReadyExpression("document.body.innerText.includes('mock-a@example.test')")), "account A state synchronized to the second tab");

  await secondTab.evaluate("document.querySelector('[data-testid=site-account-sign-out]').click()");
  await waitFor(() => secondTab.evaluate(shellReadyExpression("document.querySelector('[data-testid=mock-login-a]') !== null")), "account A logout in the second tab");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.querySelector('[data-testid=mock-login-a]') !== null")), "logout notification clears the first tab");
  await secondTab.evaluate("document.querySelector('[data-testid=mock-login-b]').click()");
  await waitFor(() => secondTab.evaluate(shellReadyExpression("document.body.innerText.includes('mock-b@example.test')")), "account B login in the second tab");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.body.innerText.includes('mock-b@example.test')")), "login notification refreshes the first tab");
  assert.equal(await browser.evaluate(`document.body.innerText.includes(${JSON.stringify(titleA)})`), false, "cross-tab login clears account A's sessions from the first tab");

  const countsBeforeAccountMismatch = databaseCounts();
  const changedCookieStatus = await secondTab.evaluate(`fetch('/api/dev/mock-auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-frontend-atlas-request': '1' },
    body: JSON.stringify({ userId: 'mock-user-a' }),
  }).then((response) => response.status)`);
  assert.equal(changedCookieStatus, 200, "the second tab changes the shared mock identity cookie through the real endpoint");
  const mismatchedTitle = "must not save under another tab's account";
  await browser.evaluate(setValueExpression("#account-session-title", mismatchedTitle));
  await browser.evaluate("document.querySelector('[data-testid=create-conversation]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.body.innerText.includes('mock-a@example.test')")), "stale first-tab write refreshes to cookie owner A");
  await waitFor(() => secondTab.evaluate(shellReadyExpression("document.body.innerText.includes('mock-a@example.test')")), "account mismatch refresh propagates to the second tab");
  assert.equal(await browser.evaluate(`document.body.innerText.includes(${JSON.stringify(mismatchedTitle)})`), false, "an expected-account mismatch never creates a session");
  assert.deepEqual(databaseCounts(), countsBeforeAccountMismatch, "the real SQLite database is unchanged when the displayed account differs from the session cookie");

  const countsBeforeAccountMismatchAToB = databaseCounts();
  const changedCookieToBStatus = await secondTab.evaluate(`fetch('/api/dev/mock-auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-frontend-atlas-request': '1' },
    body: JSON.stringify({ userId: 'mock-user-b' }),
  }).then((response) => response.status)`);
  assert.equal(changedCookieToBStatus, 200, "the second tab silently changes the shared Mock identity cookie from A to B");
  const mismatchedTitleAToB = "A tab must not create under B's session";
  await browser.evaluate(setValueExpression("#account-session-title", mismatchedTitleAToB));
  await browser.evaluate("document.querySelector('[data-testid=create-conversation]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.body.innerText.includes('mock-b@example.test')")), "stale account A write refreshes to cookie owner B");
  await waitFor(() => secondTab.evaluate(shellReadyExpression("document.body.innerText.includes('mock-b@example.test')")), "account A-to-B mismatch refresh propagates to the second tab");
  assert.equal(await browser.evaluate(`document.body.innerText.includes(${JSON.stringify(mismatchedTitleAToB)})`), false, "an A UI write is rejected when the shared session has changed to B");
  assert.deepEqual(databaseCounts(), countsBeforeAccountMismatchAToB, "the real SQLite database is unchanged for the A UI to B session mismatch");

  const legacyRecord = await databaseLegacyRecord(browser);
  assert.equal(legacyRecord?.originalAnswer, "legacy-only", "the old IndexedDB learning record remains on the device");
  assert.equal((await databaseLegacyCoachConversation(browser))?.status, "streaming", "the old IndexedDB chat remains unchanged after preview, account switches, and declined upload");
  assert.equal(databaseCounts().conversations, 3, "old IndexedDB data was not automatically imported into SQLite");

  browser.close();
  process.stdout.write("coach account browser: local-only legacy preview, explicit confirmation, account-switch reset, Mock-auth import rejection, IndexedDB preservation, delayed response invalidation, SQLite owner isolation, and idempotent retry passed\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  for (const browserSocket of browserSockets) {
    if (browserSocket.readyState < WebSocket.CLOSING) browserSocket.close();
  }
  browserSockets.clear();
  await stopProcess(chromeProcess);
  await stopProcess(nextProcess);
  rmSync(tempRoot, { recursive: true, force: true });
}
