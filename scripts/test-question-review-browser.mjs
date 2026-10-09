import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openSqliteDatabase } from "../src/lib/db/sqlite.ts";
import { publicQuestionSnapshot, publicQuestionSnapshotSha256 } from "../src/lib/server/question-public-content.ts";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempRoot = mkdtempSync(join(tmpdir(), "frontend-atlas-question-review-browser-"));
const databasePath = join(tempRoot, "review-browser.sqlite");
const browserProfilePath = join(tempRoot, "chromium-profile");
const chromiumPath = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const authSecret = "review-browser-secret-at-least-thirty-two-bytes";
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
    const timeout = setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 3_000);
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
  await browser.command("Network.enable");
  await browser.command("Page.navigate", { url });
  return browser;
}

function signedSessionCookie(token) {
  const signature = createHmac("sha256", authSecret).update(token).digest("base64");
  return encodeURIComponent(`${token}.${signature}`);
}

async function setSessionCookie(browser, origin, token) {
  const result = await browser.command("Network.setCookie", {
    name: "better-auth.session_token",
    value: signedSessionCookie(token),
    url: origin,
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  });
  assert.equal(result.success, true);
}

function setValue(selector, value) {
  return `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('missing ${selector}'); const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set; setter.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
}

function auditRow() {
  const opened = openSqliteDatabase(databasePath);
  try {
    return {
      proposal: opened.client.prepare("SELECT status FROM question_change_proposals WHERE id = 'browser-proposal'").get(),
      review: opened.client.prepare("SELECT reviewer_user_id, decision, comment FROM question_proposal_reviews WHERE proposal_id = 'browser-proposal'").get(),
    };
  } finally {
    opened.client.close();
  }
}

try {
  assert.ok(existsSync(chromiumPath));
  const map = JSON.parse(readFileSync(join(projectRoot, "src/content/knowledge-map.source.json"), "utf8"));
  const chapters = JSON.parse(readFileSync(join(projectRoot, "src/content/knowledge-chapters.source.json"), "utf8"));
  const question = map.master_questions.find((item) => item.qid === "D13");
  const baseline = publicQuestionSnapshot(question);
  const baselineHash = publicQuestionSnapshotSha256(baseline);
  const opened = openSqliteDatabase(databasePath);
  migrate(opened.db, { migrationsFolder: join(projectRoot, "src/lib/db/migrations") });
  const now = Date.now();
  const insertUser = opened.client.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)");
  insertUser.run("browser-owner", "Browser Owner", "owner@example.test", now, now);
  insertUser.run("browser-reviewer", "Browser Reviewer", "reviewer@example.test", now, now);
  insertUser.run("browser-normal", "Browser Normal", "normal@example.test", now, now);
  const insertSession = opened.client.prepare("INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)");
  insertSession.run("session-owner", now + 86_400_000, "owner-token", now, now, "browser-owner");
  insertSession.run("session-reviewer", now + 86_400_000, "reviewer-token", now, now, "browser-reviewer");
  insertSession.run("session-normal", now + 86_400_000, "normal-token", now, now, "browser-normal");
  opened.client.prepare("INSERT INTO site_role_grants (id, user_id, role, created_by, created_at) VALUES (?, ?, 'reviewer', ?, ?)")
    .run("browser-role", "browser-reviewer", "browser-test-admin", now);
  opened.client.prepare(`INSERT INTO question_change_proposals (
    id, owner_user_id, qid, source_generation_id, source_override_version, base_content_version,
    base_content_sha256, title, explanation_markdown, checkpoints_json, summary, status, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?)`)
    .run(
      "browser-proposal", "browser-owner", "D13", "browser-generation", 4, chapters.content_version,
      baselineHash, "Browser 审核后的 D13 题干", "## Browser 提案讲解\n\n包含长 Markdown 与 `code`。", '["Browser 检查点一","Browser 检查点二"]',
      "Browser 端到端审核摘要", now, now,
    );
  opened.client.close();

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  nextProcess = spawn(process.execPath, [join(projectRoot, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "development",
      NEXT_TELEMETRY_DISABLED: "1",
      FRONTEND_ATLAS_LOCAL_MODE: "1",
      NEXT_PUBLIC_FRONTEND_ATLAS_LOCAL_MODE: "1",
      FRONTEND_ATLAS_MOCK_AUTH: "0",
      FRONTEND_ATLAS_DB_PATH: databasePath,
      BETTER_AUTH_URL: origin,
      BETTER_AUTH_SECRET: authSecret,
      GITHUB_CLIENT_ID: "",
      GITHUB_CLIENT_SECRET: "",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [nextProcess.stdout, nextProcess.stderr]) stream.on("data", (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-16_000); });
  await waitFor(async () => (await fetch(`${origin}/api/reviewer/access`).catch(() => null))?.status === 401, "review API");
  const browser = await openBrowser(`${origin}/`);

  await setSessionCookie(browser, origin, "normal-token");
  assert.equal(await browser.evaluate("fetch('/api/reviewer/proposals', { cache: 'no-store' }).then((response) => response.status)"), 403);
  await browser.command("Page.navigate", { url: `${origin}/moderation/questions/` });
  await waitFor(() => browser.evaluate("document.body.innerText.includes('没有题库审核权限')"), "normal-user forbidden page");
  assert.equal(await browser.evaluate("document.body.innerText.includes('Browser 审核后的 D13 题干')"), false, "forbidden page leaks no proposal data");
  assert.equal(await browser.evaluate("document.querySelector('[data-testid=reviewer-navigation]') === null"), true);

  await setSessionCookie(browser, origin, "reviewer-token");
  await browser.command("Page.reload", { ignoreCache: true });
  await waitFor(() => browser.evaluate("document.querySelector('.reviewer-dashboard') !== null"), "reviewer dashboard");
  await waitFor(() => browser.evaluate("document.body.innerText.includes('Browser 审核后的 D13 题干') && document.body.innerText.includes('Browser 端到端审核摘要')"), "trusted proposal detail");
  assert.equal(await browser.evaluate("document.body.innerText.includes('owner@example.test')"), false, "reviewer UI omits owner email");
  assert.equal(await browser.evaluate("document.querySelector('.reviewer-line-diff')?.getAttribute('tabindex')"), "0", "long diff is keyboard-scrollable");
  await waitFor(() => browser.evaluate("document.querySelectorAll('.reviewer-markdown-pair .coach-markdown').length === 2"), "on-demand Markdown snapshots");
  await browser.evaluate("Array.from(document.querySelectorAll('.reviewer-actions button')).find((button) => button.textContent.includes('批准')).click()");
  await waitFor(() => browser.evaluate("document.querySelector('#review-comment') !== null"), "approve confirmation");
  await browser.evaluate(setValue("#review-comment", "Browser reviewer 已核对题干、Markdown 与检查点。"));
  await browser.evaluate("document.querySelector('[data-slot=alert-dialog-action]').click()");
  await waitFor(() => auditRow().proposal.status === "approved", "approval audit");
  assert.deepEqual(auditRow(), {
    proposal: { status: "approved" },
    review: { reviewer_user_id: "browser-reviewer", decision: "approved", comment: "Browser reviewer 已核对题干、Markdown 与检查点。" },
  });
  await waitFor(() => browser.evaluate("document.body.innerText.includes('当前没有待审核提案')"), "approved proposal leaves queue");

  await setSessionCookie(browser, origin, "owner-token");
  await browser.command("Page.navigate", { url: `${origin}/questions/D13/` });
  await waitFor(() => browser.evaluate("document.querySelector('.question-proposal-history')?.innerText.includes('Browser reviewer 已核对题干、Markdown 与检查点。')"), "owner review history");
  assert.equal(await browser.evaluate("document.querySelector('[data-testid=reviewer-navigation]') === null"), true, "reviewer link disappears after account switch");
  assert.equal(await browser.evaluate("fetch('/api/reviewer/proposals', { cache: 'no-store' }).then((response) => response.status)"), 403);

  process.stdout.write("Question reviewer browser flow passed with verified Better Auth sessions and no Mock authorization.\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  for (const socket of sockets) if (socket.readyState < WebSocket.CLOSING) socket.close();
  await stopProcess(chromeProcess);
  await stopProcess(nextProcess);
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
}
