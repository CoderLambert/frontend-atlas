import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const origin = process.env.FRONTEND_ATLAS_TEST_URL;
const chromiumPath = process.env.CHROMIUM_PATH;
assert.ok(origin, "FRONTEND_ATLAS_TEST_URL is required");
assert.ok(chromiumPath, "CHROMIUM_PATH is required for the hosted account browser regression");
await fs.access(chromiumPath);
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-hosted-browser-"));
let chrome = null;
let socket = null;
const pending = new Map();
let nextId = 0;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch {}
    if (chrome?.exitCode !== null && chrome?.exitCode !== undefined) throw new Error(`Chromium exited while waiting for ${label}.`);
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
function command(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      const call = pending.get(id);
      if (call) {
        pending.delete(id);
        reject(new Error(`Chromium command timed out: ${method}`));
      }
    }, 10_000);
  });
}
async function evaluate(expression) {
  const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "Browser evaluation failed.");
  return result.result?.value;
}

try {
  chrome = spawn(chromiumPath, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--disable-background-networking", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeOutput = "";
  chrome.stderr.on("data", (chunk) => { chromeOutput = `${chromeOutput}${chunk}`.slice(-4000); });
  const activePortFile = path.join(profile, "DevToolsActivePort");
  const portContents = await waitFor(() => fs.readFile(activePortFile, "utf8").catch(() => ""), "Chromium DevTools endpoint").catch((error) => {
    throw new Error(`${error.message}\n${chromeOutput}`);
  });
  const [debugPort] = portContents.trim().split("\n");
  const newTab = await fetch(`http://127.0.0.1:${debugPort}/json/new?about%3Ablank`, { method: "PUT" });
  assert.equal(newTab.status, 200);
  const target = await newTab.json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const current = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) current.reject(new Error(message.error.message));
    else current.resolve(message.result ?? {});
  });
  await command("Page.enable");
  await command("Runtime.enable");
  await command("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === "string" ? input : input.url, location.origin);
      const accountTest = localStorage.getItem("__hostedAccountTest");
      if (url.pathname === "/api/site-account" && accountTest) {
        let account = null;
        if (accountTest === "signout-success") account = { id: "deployment-account-a", name: "Account A", email: "a@example.test" };
        if (accountTest === "signout-switch") account = { id: "deployment-account-a", name: "Account A", email: "a@example.test" };
        if (accountTest === "signout-switched") account = { id: "deployment-account-b", name: "Account B", email: "b@example.test" };
        return new Response(JSON.stringify({ authConfigured: true, providers: { github: true, google: false }, account }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/api/auth/sign-out" && ["signout-success", "signout-switch"].includes(accountTest)) {
        const headers = new Headers(init.headers);
        window.__siteSignoutProbe = { accountId: headers.get("x-frontend-atlas-account-id") };
        if (accountTest === "signout-success") {
          localStorage.setItem("__hostedAccountTest", "signout-empty");
          return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } });
        }
        localStorage.setItem("__hostedAccountTest", "signout-switched");
        return new Response(JSON.stringify({ error: "account_changed" }), { status: 409, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/api/site-account" && accountTest === "signout-empty") {
        return new Response(JSON.stringify({ authConfigured: true, providers: { github: true, google: false }, account: null }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname !== "/api/auth/sign-in/social") return nativeFetch(input, init);
      const response = await nativeFetch(input, init);
      const payload = await response.clone().json();
      const requestBody = JSON.parse(init.body || "{}");
      const authorization = payload.url ? new URL(payload.url) : null;
      window.__siteLoginProbe = { status: response.status, body: requestBody, authorization: payload.url || null };
      if (!response.ok || !authorization) return response;
      const state = authorization.searchParams.get("state");
      const callback = new URL("/api/auth/callback/github", location.origin);
      callback.searchParams.set("error", "access_denied");
      if (state) callback.searchParams.set("state", state);
      return new Response(JSON.stringify({ url: callback.toString() }), { status: 200, headers: { "content-type": "application/json" } });
    };
  })();` });

  await command("Page.navigate", { url: `${origin}/account/` });
  await waitFor(async () => evaluate("document.querySelector('[data-testid=hosted-sign-in-github]') !== null"), "hosted site-account login entry");
  await evaluate("document.querySelector('[data-testid=hosted-sign-in-github]').click()");
  await waitFor(async () => evaluate("Boolean(window.__siteLoginProbe?.authorization)"), "site OAuth request configuration");
  const flow = await evaluate("window.__siteLoginProbe");
  assert.equal(flow.status, 200, "hosted site OAuth request should create the provider authorization URL");
  assert.deepEqual(flow.body, { provider: "github", callbackURL: "/account/", disableRedirect: true }, "browser requests an authorization URL for its same-domain callback without following an external OAuth redirect inside fetch");
  const authorization = new URL(flow.authorization);
  assert.equal(authorization.hostname, "github.com");
  assert.equal(authorization.searchParams.get("redirect_uri"), `${origin}/api/auth/callback/github`);
  await waitFor(async () => evaluate("location.pathname === '/account/'"), "local simulated OAuth cancellation callback");

  await command("Page.navigate", { url: `${origin}/questions/A01/` });
  await waitFor(async () => evaluate("document.querySelector('[data-testid=private-question-login-link]') !== null"), "private question login link");
  const loginHref = await evaluate("document.querySelector('[data-testid=private-question-login-link]').getAttribute('href')");
  assert.equal(loginHref, "/account/", "hosted private-question editor must link to the site-account login page");
  await evaluate("document.querySelector('[data-testid=private-question-login-link]').click()");
  await waitFor(async () => evaluate("location.pathname === '/account/' && document.querySelector('[data-testid=hosted-sign-in-github]') !== null"), "private-question-to-account-login navigation");
  await evaluate("localStorage.setItem('__hostedAccountTest', 'signout-success')");
  await command("Page.reload", { ignoreCache: true });
  await waitFor(async () => evaluate("document.querySelector('[data-testid=hosted-account-sign-out]') !== null"), "hosted site-account session");
  await evaluate("document.querySelector('[data-testid=hosted-account-sign-out]').click()");
  await waitFor(async () => evaluate("window.__siteSignoutProbe !== undefined && document.querySelector('[data-testid=hosted-sign-in-github]') !== null"), "successful account sign-out");
  const successfulSignOut = await evaluate("window.__siteSignoutProbe");
  assert.equal(successfulSignOut.accountId, "deployment-account-a", "sign-out sends the server-verified account ID");

  await evaluate("localStorage.setItem('__hostedAccountTest', 'signout-switch')");
  await command("Page.reload", { ignoreCache: true });
  await waitFor(async () => evaluate("document.querySelector('[data-testid=hosted-account-sign-out]') !== null"), "account A before simulated account switch");
  await evaluate("document.querySelector('[data-testid=hosted-account-sign-out]').click()");
  await waitFor(async () => evaluate("document.querySelector('[data-testid=hosted-account-email]')?.textContent.includes('b@example.test')"), "account state refresh after server account-change rejection");
  const switchedSignOut = await evaluate("window.__siteSignoutProbe");
  assert.equal(switchedSignOut.accountId, "deployment-account-a", "in-flight sign-out retains the identity it was initiated for");
  process.stdout.write("Hosted browser account entry, same-domain OAuth callback, private-question navigation, verified sign-out, and account-switch rejection passed without contacting an OAuth provider.\n");
} finally {
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  if (chrome && chrome.exitCode === null) {
    chrome.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), delay(3000)]);
    if (chrome.exitCode === null) chrome.kill("SIGKILL");
  }
  await fs.rm(profile, { recursive: true, force: true });
}
