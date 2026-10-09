import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openSqliteDatabase } from "../src/lib/db/sqlite.ts";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempRoot = mkdtempSync(join(tmpdir(), "frontend-atlas-question-overrides-browser-"));
const databasePath = join(tempRoot, "overrides.sqlite");
const browserProfilePath = join(tempRoot, "chromium-profile");
const chromiumPath = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let nextProcess = null;
let chromeProcess = null;
let serverOutput = "";
const sockets = new Set();

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a port.");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitFor(check, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    if (nextProcess?.exitCode !== null && nextProcess?.exitCode !== undefined) throw new Error(`Next exited (${nextProcess.exitCode}).\n${serverOutput}`);
    await delay(120);
  }
  throw new Error(`Timed out waiting for ${label}.${lastError ? ` ${lastError.message}` : ""}\n${serverOutput}`);
}

function stopProcess(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 3000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
    child.kill("SIGTERM");
  });
}

async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  sockets.add(socket);
  socket.addEventListener("close", () => sockets.delete(socket), { once: true });
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const item = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result ?? {});
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`Chromium command timed out: ${method}`)); }, 15_000);
  });
  const evaluate = async (expression) => {
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "Browser expression failed.");
    return result.result?.value;
  };
  return { command, evaluate };
}

async function openBrowser(url) {
  mkdirSync(browserProfilePath, { recursive: true, mode: 0o700 });
  chromeProcess = spawn(chromiumPath, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-background-networking", "--remote-debugging-port=0", `--user-data-dir=${browserProfilePath}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const activePortPath = join(browserProfilePath, "DevToolsActivePort");
  const portContents = await waitFor(() => existsSync(activePortPath) ? readFileSync(activePortPath, "utf8") : "", "Chromium DevTools", 15_000);
  const [debugPort] = portContents.trim().split("\n");
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?about%3Ablank`, { method: "PUT" });
  const browser = await connect(await response.json());
  await browser.command("Page.enable");
  await browser.command("Runtime.enable");
  await browser.command("Page.navigate", { url });
  return browser;
}

function setValue(selector, value) {
  return `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('missing ${selector}'); const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set; setter.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`;
}

function rows() {
  const opened = openSqliteDatabase(databasePath);
  try { return opened.client.prepare("SELECT owner_user_id, qid, title, explanation_markdown, checkpoints_json, generation_id, version FROM question_private_overrides ORDER BY owner_user_id").all(); }
  finally { opened.client.close(); }
}

function proposalRows() {
  const opened = openSqliteDatabase(databasePath);
  try { return opened.client.prepare("SELECT id, owner_user_id, qid, source_generation_id, source_override_version, title, summary, status FROM question_change_proposals ORDER BY created_at").all(); }
  finally { opened.client.close(); }
}

try {
  assert.ok(existsSync(chromiumPath));
  let opened = openSqliteDatabase(databasePath);
  migrate(opened.db, { migrationsFolder: join(projectRoot, "src/lib/db/migrations") });
  const now = Date.now();
  const insert = opened.client.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)");
  insert.run("mock-user-a", "Mock A", "mock-a@example.test", now, now);
  insert.run("mock-user-b", "Mock B", "mock-b@example.test", now, now);
  opened.client.close();

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  nextProcess = spawn(process.execPath, [join(projectRoot, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: projectRoot,
    env: { ...process.env, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", FRONTEND_ATLAS_LOCAL_MODE: "1", NEXT_PUBLIC_FRONTEND_ATLAS_LOCAL_MODE: "1", FRONTEND_ATLAS_MOCK_AUTH: "1", FRONTEND_ATLAS_DB_PATH: databasePath, BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: "", GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "", GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [nextProcess.stdout, nextProcess.stderr]) stream.on("data", (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-12_000); });
  await waitFor(async () => (await fetch(`${origin}/api/site-account`).catch(() => null))?.status === 200, "Next test server");
  const browser = await openBrowser(`${origin}/questions/D13/`);
  await waitFor(() => browser.evaluate("document.querySelector('[data-testid=question-private-editor]')?.innerText.includes('登录站点账号')"), "signed-out private editor");

  const login = (userId) => browser.evaluate(`fetch('/api/dev/mock-auth', { method: 'POST', headers: { 'content-type': 'application/json', 'x-frontend-atlas-request': '1' }, body: JSON.stringify({ userId: ${JSON.stringify(userId)} }) }).then((response) => response.status)`);
  assert.equal(await login("mock-user-a"), 200);
  await browser.command("Page.reload", { ignoreCache: true });
  await waitFor(() => browser.evaluate("document.querySelector('[data-testid=question-private-open]')?.innerText.includes('创建私人版本')"), "A private editor");
  await browser.evaluate("document.querySelector('[data-testid=question-private-open]').click()");
  await browser.evaluate("document.querySelector('[data-testid=question-private-fullscreen]').click()");
  assert.equal(await browser.evaluate("document.querySelector('.question-private-dialog')?.classList.contains('is-fullscreen')"), true, "the Markdown editor has an explicit full-screen mode");
  await browser.evaluate(setValue("#private-question-title", "A 的私人 D13 题干"));
  await browser.evaluate(setValue("#private-question-explanation", "## A 的讲解\n\n刷新后仍应存在。"));
  await browser.evaluate(setValue("#private-question-checkpoints", "A 检查点一\nA 检查点二"));
  await browser.evaluate("document.querySelector('[data-testid=question-private-save]').click()");
  await waitFor(() => browser.evaluate("document.querySelector('.question-heading h1')?.textContent === 'A 的私人 D13 题干'"), "A override applied");
  assert.deepEqual(rows().map((row) => ({ owner: row.owner_user_id, title: row.title, version: row.version })), [{ owner: "mock-user-a", title: "A 的私人 D13 题干", version: 1 }]);
  await browser.evaluate("document.querySelector('[data-testid=question-proposal-open]').click()");
  await browser.evaluate(setValue("#question-proposal-summary", "A 提交公共题库审核：补充边界和检查点。"));
  await browser.evaluate("document.querySelector('[data-testid=question-proposal-submit]').click()");
  await waitFor(() => proposalRows().length === 1, "A proposal SQLite snapshot");
  assert.deepEqual(proposalRows().map((row) => ({ owner: row.owner_user_id, title: row.title, version: row.source_override_version, status: row.status })), [{ owner: "mock-user-a", title: "A 的私人 D13 题干", version: 1, status: "submitted" }]);
  await waitFor(() => browser.evaluate("document.querySelector('[data-testid=question-proposal-status]')?.innerText.includes('变更申请待审核')"), "A proposal status");
  await waitFor(() => browser.evaluate("document.querySelector('#answer-draft') !== null"), "A study record ready");
  await browser.evaluate(setValue("#answer-draft", "只有 A 的私人作答"));
  await waitFor(() => browser.evaluate("document.querySelector('.local-save-note')?.textContent.includes('已保存至本设备')"), "A practice saved");

  await browser.command("Page.reload", { ignoreCache: true });
  await waitFor(() => browser.evaluate("document.querySelector('.question-heading h1')?.textContent === 'A 的私人 D13 题干'"), "A override after refresh");
  await waitFor(() => browser.evaluate("document.querySelector('[data-testid=question-proposal-status]')?.innerText.includes('私人版本 v1')"), "A proposal after refresh");
  await browser.evaluate("document.querySelector('[data-testid=question-private-open]').click()");
  await waitFor(() => browser.evaluate("document.querySelector('#private-question-title') !== null"), "A editor before account switch");
  assert.equal(await login("mock-user-b"), 200);
  await browser.evaluate("(() => { const channel = new BroadcastChannel('frontend-atlas-site-account'); channel.postMessage({ type: 'account-changed' }); channel.close(); return true; })()");
  await waitFor(() => browser.evaluate("document.querySelector('[data-testid=question-private-open]')?.innerText.includes('创建私人版本') && document.querySelector('#private-question-title') === null"), "B sees public version and A's editor closes");
  assert.notEqual(await browser.evaluate("document.querySelector('.question-heading h1')?.textContent"), "A 的私人 D13 题干", "B cannot see A's private title");
  assert.equal(await browser.evaluate("document.querySelector('[data-testid=question-proposal-status]') === null"), true, "B cannot see A's proposal");
  await waitFor(() => browser.evaluate("document.querySelector('#answer-draft')?.value === ''"), "B never sees A's private answer");
  await browser.evaluate(setValue("#answer-draft", "只有 B 的作答"));
  await waitFor(() => browser.evaluate("document.querySelector('.local-save-note')?.textContent.includes('已保存至本设备')"), "B practice saved");

  await browser.evaluate("document.querySelector('[data-testid=question-private-open]').click()");
  await browser.evaluate(setValue("#private-question-title", "B 的私人 D13 题干"));
  await browser.evaluate(setValue("#private-question-explanation", "## B 的讲解"));
  await browser.evaluate(setValue("#private-question-checkpoints", "B 检查点"));
  await browser.evaluate("document.querySelector('[data-testid=question-private-save]').click()");
  await waitFor(() => rows().length === 2, "B SQLite row");

  assert.equal(await login("mock-user-a"), 200);
  await browser.evaluate("(() => { const channel = new BroadcastChannel('frontend-atlas-site-account'); channel.postMessage({ type: 'account-changed' }); channel.close(); return true; })()");
  await waitFor(() => browser.evaluate("document.querySelector('.question-heading h1')?.textContent === 'A 的私人 D13 题干'"), "A restored after account switch");
  await waitFor(() => browser.evaluate("document.querySelector('#answer-draft')?.value === '只有 A 的私人作答'"), "A gets only A's answer again");
  await waitFor(() => browser.evaluate("document.querySelector('[data-testid=question-proposal-status]') !== null"), "A proposal restored after account switch");
  const previousGeneration = rows().find((row) => row.owner_user_id === "mock-user-a").generation_id;
  await browser.evaluate("document.querySelector('[data-testid=question-private-reset]').click()");
  await waitFor(() => browser.evaluate("document.querySelector('[data-testid=question-private-reset-confirm]') !== null"), "reset confirmation");
  await browser.evaluate("document.querySelector('[data-testid=question-private-reset-confirm]').click()");
  await waitFor(() => rows().length === 1, "A row removed");
  assert.equal(rows()[0].owner_user_id, "mock-user-b", "reset removes only A's private override");
  assert.equal(proposalRows().find((row) => row.owner_user_id === "mock-user-a").status, "submitted", "reset keeps the submitted snapshot");
  await waitFor(() => browser.evaluate("document.querySelector('[data-testid=question-private-open]')?.innerText.includes('创建私人版本')"), "public version restored for A");
  await browser.evaluate("document.querySelector('[data-testid=question-proposal-withdraw]').click()");
  await waitFor(() => browser.evaluate("document.querySelector('[data-testid=question-proposal-withdraw-confirm]') !== null"), "withdraw confirmation");
  await browser.evaluate("document.querySelector('[data-testid=question-proposal-withdraw-confirm]').click()");
  await waitFor(() => proposalRows().find((row) => row.owner_user_id === "mock-user-a")?.status === "withdrawn", "A proposal withdrawn");
  await waitFor(() => browser.evaluate("document.querySelector('[data-testid=question-proposal-status]') === null && document.querySelector('[data-testid=question-proposal-withdraw-confirm]') === null"), "withdrawal reflected in the UI");
  await browser.evaluate("document.querySelector('[data-testid=question-private-open]').click()");
  await browser.evaluate(setValue("#private-question-title", "A 再次创建"));
  await browser.evaluate("document.querySelector('[data-testid=question-private-save]').click()");
  await waitFor(() => rows().length === 2 && rows().some((row) => row.title === "A 再次创建"), "A recreated after reset");
  const recreated = rows().find((row) => row.owner_user_id === "mock-user-a");
  assert.notEqual(recreated.generation_id, previousGeneration, "reset and recreation change the generation");
  await waitFor(() => browser.evaluate("document.querySelector('[data-testid=question-proposal-open]') !== null"), "replacement proposal action");
  await browser.evaluate("document.querySelector('[data-testid=question-proposal-open]').click()");
  await browser.evaluate(setValue("#question-proposal-summary", "基于重新创建的私人版本再次申请。"));
  await browser.evaluate("document.querySelector('[data-testid=question-proposal-submit]').click()");
  await waitFor(() => proposalRows().filter((row) => row.owner_user_id === "mock-user-a").length === 2, "A replacement proposal");
  const activeReplacement = proposalRows().find((row) => row.owner_user_id === "mock-user-a" && row.status === "submitted");
  assert.equal(activeReplacement.source_generation_id, recreated.generation_id, "replacement proposal snapshots the new generation");
  const staleResponse = await browser.evaluate(`fetch('/api/questions/D13/private-override', { method: 'DELETE', headers: { 'content-type': 'application/json', 'x-frontend-atlas-request': '1', 'x-frontend-atlas-account-id': 'mock-user-a' }, body: JSON.stringify({ expectedVersion: 1, expectedGenerationId: ${JSON.stringify(previousGeneration)} }) }).then((res) => res.status)`);
  assert.equal(staleResponse, 409, "old page cannot delete recreated private version");
  assert.equal(rows().find((row) => row.owner_user_id === "mock-user-a").title, "A 再次创建");

  process.stdout.write("Question private override browser flow passed: login, private save, proposal snapshot, refresh recovery, account isolation, withdrawal, and reset.\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  for (const socket of sockets) if (socket.readyState < WebSocket.CLOSING) socket.close();
  await stopProcess(chromeProcess);
  await stopProcess(nextProcess);
  // Browser and Next subprocesses may finish flushing profile files just after exit.
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
}
