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
const tempRoot = mkdtempSync(join(tmpdir(), "frontend-atlas-assistant-browser-"));
const databasePath = join(tempRoot, "assistant.sqlite");
const browserProfilePath = join(tempRoot, "chromium-profile");
const chromiumPath = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const desktopScreenshot = process.env.FRONTEND_ATLAS_ASSISTANT_DESKTOP_SCREENSHOT || join(tmpdir(), "frontend-atlas-coach-assistant-mock-desktop.png");
const mobileScreenshot = process.env.FRONTEND_ATLAS_ASSISTANT_MOBILE_SCREENSHOT || join(tmpdir(), "frontend-atlas-coach-assistant-mock-mobile.png");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
  if (!address || typeof address === "string") throw new Error("Could not reserve a temporary local port.");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function seedDatabase() {
  const opened = openSqliteDatabase(databasePath);
  migrate(opened.db, { migrationsFolder: join(projectRoot, "src/lib/db/migrations") });
  const now = Date.now();
  opened.client.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("mock-user-a", "Mock User A", "mock-a@example.test", 0, now, now);
  opened.client.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("mock-user-b", "Mock User B", "mock-b@example.test", 0, now, now);
  opened.client.close();
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
    await delay(40);
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
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  browserSockets.add(socket);
  socket.addEventListener("close", () => browserSockets.delete(socket), { once: true });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const current = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) current.reject(new Error(message.error.message));
    else current.resolve(message.result ?? {});
  });
  function command(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
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
  return { command, evaluate, close: () => { if (socket.readyState < WebSocket.CLOSING) socket.close(); } };
}

async function startBrowser(startUrl) {
  mkdirSync(browserProfilePath, { recursive: true, mode: 0o700 });
  chromeProcess = spawn(chromiumPath, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-background-networking",
    "--remote-debugging-port=0", `--user-data-dir=${browserProfilePath}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeOutput = "";
  chromeProcess.stderr.on("data", (chunk) => { chromeOutput = `${chromeOutput}${chunk}`.slice(-4000); });
  const activePortPath = join(browserProfilePath, "DevToolsActivePort");
  const portContents = await waitFor(() => existsSync(activePortPath) ? readFileSync(activePortPath, "utf8") : "", "Chromium DevTools", 15_000).catch((error) => {
    throw new Error(`${error.message}\n${chromeOutput}`);
  });
  [browserDebugPort] = portContents.trim().split("\n");
  const response = await fetch(`http://127.0.0.1:${browserDebugPort}/json/new?about%3Ablank`, { method: "PUT" });
  assert.equal(response.status, 200, "Chromium opens an isolated temporary tab");
  const browser = await connectBrowserTarget(await response.json());
  await browser.command("Page.enable");
  await browser.command("Runtime.enable");
  await browser.command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await browser.command("Page.navigate", { url: startUrl });
  return browser;
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
    FRONTEND_ATLAS_MOCK_ASSISTANT: "1",
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
  for (const stream of [nextProcess.stdout, nextProcess.stderr]) stream.on("data", (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-10_000); });

  await waitFor(async () => {
    const response = await fetch(`${origin}/api/site-account`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
    return response?.status === 200;
  }, "temporary Next.js account endpoint");
  process.stdout.write("assistant browser: temporary server ready\n");
  const statusResponse = await fetch(`${origin}/api/site-account`, { cache: "no-store" });
  assert.equal((await statusResponse.json()).assistantProvider, "local-mock", "the local test server explicitly reports Mock mode");

  const browser = await startBrowser(`${origin}/coach/sessions/`);
  await waitFor(() => browser.evaluate(shellReadyExpression("document.querySelector('[data-testid=mock-login-a]') !== null")), "Mock login UI");
  await browser.evaluate("document.querySelector('[data-testid=mock-login-a]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.body.innerText.includes('mock-a@example.test')")), "Mock account A login");
  await browser.evaluate(setValueExpression("#account-session-title", "Mock assistant showcase"));
  await browser.evaluate("document.querySelector('[data-testid=create-conversation]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.querySelector('[data-testid=conversation-messages]') !== null")), "new conversation detail");
  await browser.evaluate(`(() => {
    const nativeSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith("frontend-atlas:coach-unsaved-assistant:v1:")) {
        window.__lastAssistantRecovery = JSON.parse(value);
      }
      return nativeSetItem.call(this, key, value);
    };
  })()`);
  await browser.evaluate(`(() => {
    const nativeFetch = window.fetch.bind(window);
    window.__raceNativeFetch = nativeFetch;
    window.__holdFirstAssistantDelta = true;
    window.__raceAssistantMessageId = null;
    window.__raceHeldDeltaCount = 0;
    window.__raceTerminalDelivered = false;
    window.__releaseRaceDelta = null;
    window.fetch = async (input, init = {}) => {
      const response = await nativeFetch(input, init);
      const url = typeof input === "string" ? new URL(input, location.origin) : new URL(input.url);
      if (!window.__holdFirstAssistantDelta || init.method !== "POST" || !url.pathname.endsWith("/runs") || !response.body) return response;
      window.__holdFirstAssistantDelta = false;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffered = "";
      let deltaCount = 0;
      const body = new ReadableStream({
        async pull(controller) {
          try {
            while (true) {
              const newline = buffered.indexOf("\\n");
              if (newline < 0) {
                const { value, done } = await reader.read();
                buffered += decoder.decode(value ?? new Uint8Array(), { stream: !done });
                if (done && !buffered) { controller.close(); return; }
                if (done && buffered.indexOf("\\n") < 0) {
                  const line = buffered;
                  buffered = "";
                  if (!line) { controller.close(); return; }
                  const event = JSON.parse(line);
                  if (event.type === "started") window.__raceAssistantMessageId = event.assistantMessage.id;
                  if (event.type === "terminal") window.__raceTerminalDelivered = true;
                  controller.enqueue(encoder.encode(line + "\\n"));
                  controller.close();
                  return;
                }
                continue;
              }
              const line = buffered.slice(0, newline);
              buffered = buffered.slice(newline + 1);
              if (!line) continue;
              const event = JSON.parse(line);
              if (event.type === "started") window.__raceAssistantMessageId = event.assistantMessage.id;
              if (event.type === "delta" && ++deltaCount === 5) {
                window.__raceHeldDeltaCount = deltaCount;
                await new Promise((resolve) => { window.__releaseRaceDelta = resolve; });
                window.__releaseRaceDelta = null;
              }
              if (event.type === "terminal") window.__raceTerminalDelivered = true;
              controller.enqueue(encoder.encode(line + "\\n"));
              return;
            }
          } catch (error) {
            controller.error(error);
          }
        },
        cancel(reason) { void reader.cancel(reason); },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
  })()`);
  await browser.evaluate(setValueExpression("#account-message", "请演示一次本机助手流式传输。"));
  await browser.evaluate("document.querySelector('[data-testid=send-message]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.querySelector('[data-message-status=streaming]') !== null")), "streaming assistant message");
  await waitFor(() => browser.evaluate(shellReadyExpression("window.__raceHeldDeltaCount === 5 && window.__raceAssistantMessageId !== null")), "pause one assistant delta while the server continues persisting");
  const raceAssistantMessageId = await browser.evaluate("window.__raceAssistantMessageId");
  const raceDatabase = openSqliteDatabase(databasePath);
  let raceSnapshot;
  try {
    await waitFor(() => {
      raceSnapshot = raceDatabase.client.prepare("SELECT content, status FROM coach_messages WHERE id = ?").get(raceAssistantMessageId);
      return raceSnapshot?.status === "complete" && raceSnapshot.content.length > 64;
    }, "SQLite advances beyond the held stream offset", 15_000);
  } finally {
    raceDatabase.client.close();
  }
  await browser.evaluate("window.dispatchEvent(new Event('focus'))");
  const raceSnapshotText = await waitFor(() => browser.evaluate(`(() => {
    const message = document.querySelector('[data-message-id=${JSON.stringify(raceAssistantMessageId)}] .coach-markdown');
    return message?.innerText.includes("Mock 运行结束后") ? message.innerText : null;
  })()`), "focus refresh renders the newer SQLite snapshot", 15_000);
  await browser.evaluate("window.__releaseRaceDelta?.()");
  await waitFor(() => browser.evaluate(shellReadyExpression("window.__raceTerminalDelivered === true && document.querySelector('[data-testid=cancel-assistant-run]') === null")), "the delayed stream catches up and reaches terminal state", 15_000);
  const raceFinalText = await browser.evaluate(`document.querySelector('[data-message-id=${JSON.stringify(raceAssistantMessageId)}] .coach-markdown')?.innerText ?? null`);
  assert.equal(raceFinalText, raceSnapshotText, "deltas already represented by the same SQLite message snapshot are not appended again");
  assert.equal(raceSnapshot.status, "complete", "the database snapshot belongs to the completed run whose stream events were delayed");
  await browser.evaluate("window.fetch = window.__raceNativeFetch ?? window.fetch");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.querySelector('.coach-account-messages li[data-message-status=complete] .coach-markdown') !== null")), "completed assistant message");
  const initialRecoveryRecord = await browser.evaluate("window.__lastAssistantRecovery");
  assert.ok(initialRecoveryRecord?.content.includes("Mock 运行结束后"), "the real streamed assistant content was captured in the local recovery buffer");
  const firstConversationId = initialRecoveryRecord.conversationId;
  await browser.evaluate(setValueExpression("#account-session-title", "A separate conversation"));
  await browser.evaluate("document.querySelector('[data-testid=create-conversation]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.querySelector('[data-testid=conversation-messages]') !== null && document.querySelectorAll('[data-testid=saved-message]').length === 0")), "a new conversation starts with no messages from the first conversation");
  assert.equal(await browser.evaluate("document.querySelector('[data-testid=conversation-messages]')?.innerText.includes('本机 Mock 流式演示') ?? false"), false, "the focused SQLite snapshot remains scoped to its original conversation");
  await browser.evaluate(`document.querySelector('[data-testid="conversation-${firstConversationId}"]').click()`);
  await waitFor(() => browser.evaluate(shellReadyExpression("document.querySelector('[data-testid=conversation-messages]')?.innerText.includes('Mock 运行结束后')")), "switching back restores the first conversation without duplication");
  process.stdout.write("assistant browser: first streaming response completed\n");
  const acceptedUi = await browser.evaluate(`(() => ({
    mockLabel: document.body.innerText.includes("本机 Mock 体验"),
    explicitMockReply: document.body.innerText.includes("本机 Mock 流式演示"),
    noRealAnswerClaim: document.body.innerText.includes("不会连接真实模型"),
    codeBlock: !!document.querySelector("[data-streamdown=code-block] pre code"),
    codeCopy: !!document.querySelector("[data-streamdown=code-block-copy-button]"),
    bothMessages: document.querySelectorAll('[data-testid="saved-message"]').length === 2,
    honestDetailLabel: document.body.innerText.includes("用户消息、助手回复和运行状态会一并保存。"),
  }))()`);
  assert.deepEqual(acceptedUi, {
    mockLabel: true,
    explicitMockReply: true,
    noRealAnswerClaim: true,
    codeBlock: true,
    codeCopy: true,
    bothMessages: true,
    honestDetailLabel: true,
  }, "the UI labels Mock clearly and renders its saved Markdown code block with copy control");

  await browser.evaluate("(() => { const style = document.createElement('style'); style.textContent = 'nextjs-portal { display: none !important }'; document.head.append(style); })()");
  const desktop = await browser.command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, fromSurface: true });
  writeFileSync(desktopScreenshot, Buffer.from(desktop.data, "base64"));
  process.stdout.write("assistant browser: desktop screenshot saved\n");
  await browser.command("Page.reload", { ignoreCache: true });
  await waitFor(() => browser.evaluate(shellReadyExpression("document.querySelector('.coach-account-messages li[data-message-status=complete] .coach-markdown')?.innerText.includes('本机 Mock 流式演示')")), "assistant Markdown restored after refresh");
  await browser.command("Emulation.setDeviceMetricsOverride", { width: 390, height: 1800, deviceScaleFactor: 1, mobile: true });
  await delay(300);
  const mobile = await browser.command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
  writeFileSync(mobileScreenshot, Buffer.from(mobile.data, "base64"));
  process.stdout.write("assistant browser: mobile screenshot saved\n");

  const stoppedInput = "停止后保留这条输入。";
  await browser.evaluate(setValueExpression("#account-message", stoppedInput));
  await browser.evaluate("document.querySelector('[data-testid=send-message]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression(`document.querySelector('[data-testid=cancel-assistant-run]') !== null
    && (document.querySelector('.coach-account-messages li[data-message-status=streaming] .coach-markdown')?.innerText.trim().length ?? 0) > 0`)), "assistant has rendered a partial delta and is stoppable before completion");
  await browser.evaluate(`(() => {
    const nativeFetch = window.fetch.bind(window);
    window.__cancelRunResult = null;
    window.fetch = async (input, init = {}) => {
      const response = await nativeFetch(input, init);
      const url = typeof input === "string" ? new URL(input, location.origin) : new URL(input.url);
      if (url.pathname.replace(/\\/$/u, "").endsWith("/cancel")) {
        window.__cancelRunResult = { httpStatus: response.status, body: await response.clone().json() };
      }
      return response;
    };
  })()`);
  await browser.evaluate("document.querySelector('[data-testid=cancel-assistant-run]').click()");
  process.stdout.write("assistant browser: stop request sent\n");
  await waitFor(() => browser.evaluate(shellReadyExpression("window.__cancelRunResult !== null")), "stop endpoint response", 15_000);
  const cancelRunResult = await browser.evaluate("window.__cancelRunResult");
  assert.equal(cancelRunResult.httpStatus, 200, "stop endpoint responds successfully");
  assert.equal(cancelRunResult.body.run.status, "cancelled", `stop is terminal before UI reconciliation (received ${cancelRunResult.body.run.status})`);
  await waitFor(() => browser.evaluate(shellReadyExpression("document.querySelector('.coach-account-messages li[data-message-status=cancelled] .coach-markdown') !== null")), "cancelled assistant message", 10_000);
  assert.equal(await browser.evaluate("document.querySelector('[data-testid=message-draft]').value"), stoppedInput, "stopping a run keeps the unsent draft available");

  const unsavedInput = "请演示一次本机助手流式传输。";
  await browser.evaluate(`(() => {
    const clipboard = { writeText: async (text) => { window.__copiedAssistantText = text; } };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
  })()`);

  let fullUnsavedAssistantContent = "";
  let recoveryRecord = initialRecoveryRecord;
  assert.ok(recoveryRecord, "streaming assistant chunks wrote an account-scoped recovery buffer");
  const unsavedAssistantMessageId = recoveryRecord.messageId;
  const openedForRecovery = openSqliteDatabase(databasePath);
  try {
    const assistant = openedForRecovery.client.prepare("SELECT id, conversation_id, content FROM coach_messages WHERE id = ?").get(unsavedAssistantMessageId);
    fullUnsavedAssistantContent = assistant.content;
    assert.ok(fullUnsavedAssistantContent.includes("Mock 运行结束后"), "the test run completed with the full Mock tail in SQLite before simulating a stale prefix");
    assert.equal(recoveryRecord.content, fullUnsavedAssistantContent, "the actual stream buffer captured the full generated content");
    recoveryRecord = { ...recoveryRecord, status: "failed", retryMode: "new" };
    const storageKey = "frontend-atlas:coach-unsaved-assistant:v1:"
      + encodeURIComponent(recoveryRecord.accountId)
      + ":" + encodeURIComponent(recoveryRecord.conversationId)
      + ":" + encodeURIComponent(recoveryRecord.messageId);
    await browser.evaluate("sessionStorage.setItem(" + JSON.stringify(storageKey) + "," + JSON.stringify(JSON.stringify(recoveryRecord)) + ")");
    openedForRecovery.client.prepare("UPDATE coach_messages SET content = ? WHERE id = ?").run(fullUnsavedAssistantContent.slice(0, 48), assistant.id);
  } finally {
    openedForRecovery.client.close();
  }

  await browser.evaluate(`(() => {
    const nativeFetch = window.fetch.bind(window);
    window.__seenStaleAssistantPrefix = false;
    window.fetch = async (input, init = {}) => {
      const response = await nativeFetch(input, init);
      const url = typeof input === "string" ? new URL(input, location.origin) : new URL(input.url);
      if (url.pathname.startsWith("/api/coach/conversations/") && url.pathname !== "/api/coach/conversations/") {
        const payload = await response.clone().json().catch(() => null);
        const assistant = payload?.conversation?.messages?.find((message) => message.id === ${JSON.stringify(unsavedAssistantMessageId)});
        if (assistant?.content.length === 48) window.__seenStaleAssistantPrefix = true;
      }
      return response;
    };
    window.dispatchEvent(new Event("focus"));
  })()`);
  await waitFor(() => browser.evaluate(shellReadyExpression("window.__seenStaleAssistantPrefix === true")), "focus refresh reads the old SQLite prefix");
  await waitFor(() => browser.evaluate(`(() => {
    const userMessage = Array.from(document.querySelectorAll('[data-testid=saved-message]'))
      .find((message) => message.innerText.includes(${JSON.stringify(unsavedInput)}));
    const assistantMessage = userMessage?.nextElementSibling;
    return Boolean(assistantMessage?.querySelector('[data-testid=copy-unsaved-assistant-reply]'))
      && assistantMessage?.innerText.includes("Mock 运行结束后")
      && document.querySelector('[data-testid=retry-message]') !== null;
  })()`), "focus refresh merges the full unsaved tail over the old SQLite prefix");
  const recoveredContent = await browser.evaluate(`(() => {
    const prefix = "frontend-atlas:coach-unsaved-assistant:v1:";
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const record = JSON.parse(sessionStorage.getItem(key));
      if (record.accountId === "mock-user-a" && record.messageId === ${JSON.stringify(unsavedAssistantMessageId)} && record.userContent === ${JSON.stringify(unsavedInput)}) return record.content;
    }
    return null;
  })()`);
  assert.equal(recoveredContent, fullUnsavedAssistantContent, "recovery buffer is scoped to the owner, conversation, and assistant message and keeps the full tail");
  await browser.evaluate(`(() => {
    const userMessage = Array.from(document.querySelectorAll('[data-testid=saved-message]'))
      .find((message) => message.innerText.includes(${JSON.stringify(unsavedInput)}));
    userMessage?.nextElementSibling?.querySelector('[data-testid=copy-unsaved-assistant-reply]')?.click();
  })()`);
  await waitFor(() => browser.evaluate(shellReadyExpression("window.__copiedAssistantText !== undefined")), "recovered reply copy");
  assert.equal(await browser.evaluate("window.__copiedAssistantText"), fullUnsavedAssistantContent, "the recovered full tail remains copyable");

  await browser.evaluate("document.querySelector('[data-testid=site-account-sign-out]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.querySelector('[data-testid=copy-backup-and-leave]') !== null")), "explicit unsaved departure choice");
  await browser.evaluate("document.querySelector('[data-testid=copy-backup-and-leave]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.querySelector('[data-testid=mock-login-b]') !== null")), "account A signs out after explicit backup");
  await browser.evaluate("document.querySelector('[data-testid=mock-login-b]').click()");
  await waitFor(() => browser.evaluate(shellReadyExpression("document.body.innerText.includes('mock-b@example.test')")), "account B signs in");
  assert.equal(await browser.evaluate("document.body.innerText.includes(" + JSON.stringify(fullUnsavedAssistantContent) + ")"), false, "another account never sees account A's recovery text");

  const opened = openSqliteDatabase(databasePath);
  try {
    const persisted = opened.client.prepare("SELECT role, status, content FROM coach_messages ORDER BY created_at").all();
    assert.equal(persisted.length, 4);
    assert.deepEqual(persisted.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
    assert.equal(persisted[1].status, "complete");
    assert.equal(persisted[3].status, "cancelled");
    assert.equal(persisted[1].content.length, 48, "the database remains at the simulated old prefix while the UI recovers the complete tail locally");
    assert.ok(fullUnsavedAssistantContent.includes('const provider = "未连接";'), "the captured full assistant content keeps the Mock code sample");
    assert.ok(persisted[3].content.length > 0, "cancelled stream preserves its partial answer");
  } finally {
    opened.client.close();
  }

  browser.close();
  process.stdout.write(`coach assistant browser: Mock label, visible streaming, Markdown code/copy, refresh restoration, stop/draft preservation, persisted partial output, desktop and mobile screenshots passed\nDesktop: ${desktopScreenshot}\nMobile: ${mobileScreenshot}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n${serverOutput.slice(-5000)}\n`);
  process.exitCode = 1;
} finally {
  for (const socket of browserSockets) if (socket.readyState < WebSocket.CLOSING) socket.close();
  browserSockets.clear();
  await stopProcess(chromeProcess);
  await stopProcess(nextProcess);
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
}
