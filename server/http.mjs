import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createSiwcRuntime, readBoundedJson, SiwcError } from "./siwc.mjs";
import { createCredentialStore } from "./storage.mjs";

export const LOCAL_SERVER = Object.freeze({
  host: "127.0.0.1",
  port: 4317,
  hostHeader: "127.0.0.1:4317",
  uiOrigin: "http://127.0.0.1:3000",
  apiOrigin: "http://127.0.0.1:4317",
  callbackUrl: "http://127.0.0.1:4317/oauth/callback",
});

const SESSION_COOKIE = "atlas_siwc_session";
const SESSION_MAX_AGE = 12 * 60 * 60;
const MAX_JSON_BYTES = 32 * 1024;
const MAX_OUTPUT_CHARS = 48_000;

function safeHeaders(res) {
  res.setHeader("cache-control", "no-store, max-age=0");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("cross-origin-resource-policy", "same-site");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
}

function cookieHeader(name, value, maxAge, sameSite = "Lax") {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}`;
}

function expiredCookie(name, sameSite = "Lax") {
  return `${name}=; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=0`;
}

export function parseCookies(header = "") {
  const result = new Map();
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (result.has(key)) result.set(key, null);
    else result.set(key, value);
  }
  return result;
}

function requestSessionId(req) {
  const cookies = parseCookies(req.headers.cookie);
  const value = cookies.get(SESSION_COOKIE);
  return typeof value === "string" && /^[A-Za-z0-9_-]{40,64}$/u.test(value) ? value : null;
}

function sendJson(req, res, status, body) {
  safeHeaders(res);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function setCors(req, res, origin) {
  if (req.headers.origin !== origin) {
    throw new SiwcError("origin_not_allowed", "此本地服务只接受来自本地学习站的请求。", 403);
  }
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-credentials", "true");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("vary", "Origin");
}

function assertLocalHost(req, expectedHost = LOCAL_SERVER.hostHeader) {
  const remote = req.socket.remoteAddress;
  const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (!isLoopback || req.headers.host !== expectedHost) {
    throw new SiwcError("local_host_required", "本地服务拒绝了非本机请求。", 403);
  }
}

async function readJson(req, maxBytes = MAX_JSON_BYTES) {
  const type = (req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (type !== "application/json") throw new SiwcError("json_required", "请求格式无效。", 415);
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new SiwcError("request_too_large", "请求内容过大。", 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new SiwcError("request_too_large", "请求内容过大。", 413);
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return parsed;
  } catch {
    throw new SiwcError("invalid_json", "请求内容不是有效的 JSON。", 400);
  }
}

function mapProviderError(code) {
  const known = {
    subscription_sharing_user_not_eligible: "这个 ChatGPT 账号或工作区当前无法使用计划用量。",
    subscription_sharing_usage_limit_exceeded: "这个 ChatGPT 账号的应用用量已达到限制。请在 ChatGPT 设置的“用量”页面查看。",
    subscription_sharing_usage_unavailable: "ChatGPT 计划用量暂时不可用，请稍后重试。",
    subscription_sharing_unsupported_capability: "当前模型或请求功能不受此计划用量预览支持。",
    subscription_sharing_route_not_supported: "当前请求方式不受支持。",
    subscription_sharing_invalid_user: "ChatGPT 登录状态已失效，请重新连接账号。",
    chatpass_v2_scope_not_authorized: "ChatGPT 账号尚未授权此操作。",
    chatpass_v2_invalid_authorization_context: "ChatGPT 账号尚未授权此操作。",
  };
  return known[code] ?? "模型请求没有完成，请检查登录状态后重试。";
}

function parseEventChunk(buffer, dispatch) {
  const lines = buffer.split(/\r?\n/u);
  let event = "message";
  const data = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /u, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (!data.length) return;
  dispatch(event, data.join("\n"));
}

async function relayResponseStream(upstream, res, controller) {
  const { signal } = controller;
  safeHeaders(res);
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  if (!upstream.body) {
    res.end(`event: error\ndata: ${JSON.stringify({ code: "empty_stream", message: "模型没有返回可读取的内容。" })}\n\n`);
    return;
  }
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  let sentChars = 0;
  let terminalError = null;
  const writeEvent = (event, payload) => {
    if (res.destroyed || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  const dispatch = (event, data) => {
    if (event === "response.output_text.delta") {
      let parsed;
      try { parsed = JSON.parse(data); } catch { return; }
      if (typeof parsed.delta !== "string") return;
      sentChars += parsed.delta.length;
      if (sentChars > MAX_OUTPUT_CHARS) {
        terminalError = { code: "response_too_long", message: "模型输出超过本地显示上限，已停止读取。" };
        controller.abort();
        return;
      }
      writeEvent("delta", parsed.delta);
    } else if (event === "response.failed" || event === "error") {
      let code = "provider_error";
      try {
        const parsed = JSON.parse(data);
        code = parsed?.response?.error?.code ?? parsed?.error?.code ?? parsed?.error ?? code;
      } catch { /* The detailed provider message is intentionally not sent to the browser. */ }
      terminalError = { code: String(code).slice(0, 120), message: mapProviderError(code) };
    } else if (event === "response.incomplete") {
      terminalError = { code: "response_incomplete", message: "模型响应没有完整结束；请检查后再决定是否重试。" };
    } else if (event === "response.completed") {
      completed = true;
    }
  };
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.search(/\r?\n\r?\n/u)) >= 0) {
        const block = buffer.slice(0, boundary);
        const delimiter = buffer.slice(boundary).match(/^\r?\n\r?\n/u)?.[0] ?? "\n\n";
        buffer = buffer.slice(boundary + delimiter.length);
        parseEventChunk(block, dispatch);
        if (terminalError || completed) break;
      }
      if (terminalError || completed) break;
    }
    buffer += decoder.decode();
    if (buffer.trim() && !terminalError && !completed) parseEventChunk(buffer, dispatch);
    if (terminalError) writeEvent("error", terminalError);
    else if (completed) writeEvent("done", { completed: true });
    else if (!signal.aborted) writeEvent("error", { code: "stream_interrupted", message: "模型响应未完整结束；请检查后再决定是否重试。" });
  } catch {
    if (!signal.aborted) writeEvent("error", { code: "stream_interrupted", message: "模型连接中断；请检查后再决定是否重试。" });
  } finally {
    try { await reader.cancel(); } catch { /* Stream may already have closed. */ }
    reader.releaseLock();
    if (!res.destroyed && !res.writableEnded) res.end();
  }
}

function safeError(error) {
  if (error instanceof SiwcError) return { status: error.status, body: { error: error.code, message: error.message } };
  return { status: 500, body: { error: "local_server_error", message: "本地服务处理失败。" } };
}

function openSystemBrowser(url) {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true, shell: false });
    } catch {
      resolve(false);
      return;
    }
    const timeout = setTimeout(() => resolve(true), 350);
    child.once("error", () => { clearTimeout(timeout); resolve(false); });
    child.once("spawn", () => {
      child.unref();
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

export function createLocalHttpServer({
  runtime = createSiwcRuntime({ store: createCredentialStore() }),
  openBrowser = openSystemBrowser,
  uiOrigin = LOCAL_SERVER.uiOrigin,
  hostHeader = LOCAL_SERVER.hostHeader,
} = {}) {
  const server = createServer(async (req, res) => {
    safeHeaders(res);
    try {
      assertLocalHost(req, hostHeader);
      const requestUrl = new URL(req.url ?? "/", `http://${LOCAL_SERVER.hostHeader}`);
      if (req.method === "GET" && requestUrl.pathname === "/health") {
        sendJson(req, res, 200, { ok: true, localOnly: true });
        return;
      }
      if (req.method === "GET" && requestUrl.pathname === LOCAL_SERVER.callbackUrl.replace(LOCAL_SERVER.apiOrigin, "")) {
        safeHeaders(res);
        try {
          const result = await runtime.finishAuth(requestUrl);
          const sessionId = runtime.createSession(result.clientId);
          runtime.completeAuthFlow(result.flowId, { clientId: result.clientId, sessionId });
          res.statusCode = 303;
          res.setHeader("location", `${uiOrigin}/coach?signin=connected`);
          res.setHeader("set-cookie", [
            cookieHeader(SESSION_COOKIE, sessionId, SESSION_MAX_AGE),
          ]);
          res.end();
        } catch (error) {
          const { body } = safeError(error);
          if (typeof error?.flowId === "string") runtime.completeAuthFlow(error.flowId, { errorCode: body.error });
          const denied = body.error === "authorization_denied";
          res.statusCode = 303;
          res.setHeader("location", `${uiOrigin}/coach?signin=${denied ? "cancelled" : "failed"}`);
          res.end();
        }
        return;
      }
      if (requestUrl.pathname.startsWith("/api/")) setCors(req, res, uiOrigin);
      if (req.method === "OPTIONS" && requestUrl.pathname.startsWith("/api/")) {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.method === "GET" && requestUrl.pathname === "/api/session") {
        const sessionId = requestSessionId(req);
        sendJson(req, res, 200, await runtime.status(sessionId));
        return;
      }
      if (req.method === "POST" && requestUrl.pathname === "/api/auth/start") {
        const body = await readJson(req, 4 * 1024);
        const result = await runtime.beginAuth({
          mode: body.mode,
          clientId: ["saved", "pending"].includes(body.mode) && typeof body.clientId === "string" ? body.clientId : null,
          redirectUri: LOCAL_SERVER.callbackUrl,
        });
        safeHeaders(res);
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.flushHeaders();
        const launched = await openBrowser(result.url);
        res.end(JSON.stringify({ opened: launched, fallbackUrl: launched ? null : result.url, flowId: result.flowId }));
        return;
      }
      if (req.method === "POST" && requestUrl.pathname === "/api/auth/complete") {
        const body = await readJson(req, 4 * 1024);
        const completion = await runtime.consumeAuthFlow(body.flowId);
        if (completion.state === "pending") {
          sendJson(req, res, 202, { state: "pending" });
          return;
        }
        if (completion.state === "expired") {
          sendJson(req, res, 410, { state: "expired", message: "登录流程已过期；可以重新开始。" });
          return;
        }
        if (completion.state === "failed") {
          sendJson(req, res, 400, { state: "failed", message: completion.message });
          return;
        }
        safeHeaders(res);
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("set-cookie", cookieHeader(SESSION_COOKIE, completion.sessionId, SESSION_MAX_AGE));
        res.end(JSON.stringify({ state: "connected", session: await runtime.status(completion.sessionId) }));
        return;
      }
      if (req.method === "POST" && requestUrl.pathname === "/api/auth/select") {
        const body = await readJson(req, 4 * 1024);
        if (typeof body.clientId !== "string") throw new SiwcError("profile_required", "请选择一个已保存的账号。", 400);
        const sessionId = await runtime.selectProfile(body.clientId);
        safeHeaders(res);
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("set-cookie", cookieHeader(SESSION_COOKIE, sessionId, SESSION_MAX_AGE));
        res.end(JSON.stringify(await runtime.status(sessionId)));
        return;
      }
      if (req.method === "POST" && requestUrl.pathname === "/api/auth/logout") {
        const sessionId = requestSessionId(req);
        const result = await runtime.signOut(sessionId);
        safeHeaders(res);
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("set-cookie", expiredCookie(SESSION_COOKIE));
        res.end(JSON.stringify({ localTokensCleared: result.localTokensCleared, revocationConfirmed: result.revoked }));
        return;
      }
      if (req.method === "GET" && requestUrl.pathname === "/api/models") {
        const sessionId = requestSessionId(req);
        sendJson(req, res, 200, { models: await runtime.listModels(sessionId) });
        return;
      }
      if (req.method === "POST" && requestUrl.pathname === "/api/coaching") {
        const sessionId = requestSessionId(req);
        const input = await readJson(req);
        const controller = new AbortController();
        req.once("aborted", () => { controller.abort(); });
        res.once("close", () => {
          if (!res.writableEnded) {
            controller.abort();
          }
        });
        const upstream = await runtime.openFeedbackResponse(sessionId, input, controller.signal);
        try {
          if (!upstream.ok) {
            const data = await (async () => {
              try { return await readBoundedJson(upstream, 64 * 1024); }
              catch { return {}; }
            })();
            const code = data?.error?.code ?? data?.error ?? data?.detail ?? "provider_error";
            const requestId = upstream.headers.get("openai-request-id") ?? upstream.headers.get("x-request-id") ?? null;
            if (upstream.status === 401) {
              sendJson(req, res, 401, { error: "reauthentication_required", message: "ChatGPT 登录状态已失效，请重新连接账号。", requestId });
            } else {
              sendJson(req, res, upstream.status >= 500 ? 503 : upstream.status, {
                error: String(code).slice(0, 120),
                message: mapProviderError(String(code)),
                requestId,
              });
            }
            return;
          }
          await relayResponseStream(upstream, res, controller);
        } finally {
          runtime.completeFeedbackResponse?.(upstream);
        }
        return;
      }
      if (requestUrl.pathname.startsWith("/api/")) throw new SiwcError("route_not_found", "本地接口不存在。", 404);
      throw new SiwcError("route_not_found", "本地服务路径不存在。", 404);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const result = safeError(error);
      sendJson(req, res, result.status, result.body);
    }
  });
  server.maxHeadersCount = 40;
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
