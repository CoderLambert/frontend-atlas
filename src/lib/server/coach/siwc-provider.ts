import type { AssistantProvider } from "./assistant-provider.ts";

const SIWC_ORIGIN = "http://127.0.0.1:4317";
const UI_ORIGIN = "http://127.0.0.1:3000";
const SESSION_COOKIE = "atlas_siwc_session";
const SERVICE_TOKEN_HEADER = "x-frontend-atlas-service-token";

export type SiwcSessionProfile = {
  authenticated: boolean;
  account: {
    clientId: string;
    email: string | null;
    name: string | null;
    planUsageEnabled: boolean;
  } | null;
  allowedModelsAvailable: boolean;
};

export type SiwcModelChoice = { slug: string; displayName: string };

export function getSiwcSessionCookie(request: Request) {
  const values = new Map<string, string | null>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (values.has(name)) values.set(name, null);
    else values.set(name, value);
  }
  const value = values.get(SESSION_COOKIE);
  return typeof value === "string" && /^[A-Za-z0-9_-]{40,64}$/u.test(value) ? value : null;
}

function cookieHeader(value: string) {
  return SESSION_COOKIE + "=" + value;
}

function serviceToken(value = process.env.FRONTEND_ATLAS_SIWC_SERVICE_TOKEN) {
  if (typeof value !== "string" || value.length < 32) {
    throw new Error("本机服务间鉴权尚未配置；请通过 local:dev 或 local:start 同时启动 3000 与 4317。");
  }
  return value;
}

function internalHeaders(cookie: string, token: string, accept: string) {
  return {
    cookie: cookieHeader(cookie),
    origin: UI_ORIGIN,
    accept,
    [SERVICE_TOKEN_HEADER]: token,
  };
}

function optionalInternalHeaders(cookie: string | null, token: string, accept: string) {
  return {
    ...(cookie ? { cookie: cookieHeader(cookie) } : {}),
    origin: UI_ORIGIN,
    accept,
    [SERVICE_TOKEN_HEADER]: token,
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json().catch(() => null);
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function getSiwcSessionProfile(
  request: Request,
  fetchImpl: typeof fetch = fetch,
  configuredServiceToken?: string,
): Promise<SiwcSessionProfile> {
  const cookie = getSiwcSessionCookie(request);
  if (!cookie) return { authenticated: false, account: null, allowedModelsAvailable: false };
  const token = serviceToken(configuredServiceToken);
  let response: Response;
  try {
    response = await fetchImpl(SIWC_ORIGIN + "/api/provider/session", {
      method: "GET",
      headers: internalHeaders(cookie, token, "application/json"),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]),
    });
  } catch {
    throw new Error("本机 ChatGPT 连接服务暂不可达，请确认 4317 服务正在运行。");
  }
  if (!response.ok) throw new Error("本机 ChatGPT 连接状态检查失败。");
  const data = await readJson(response);
  const rawAccount = data.account;
  const account = rawAccount && typeof rawAccount === "object" && !Array.isArray(rawAccount)
    ? rawAccount as Record<string, unknown>
    : null;
  if (data.authenticated !== true || !account
    || typeof account.clientId !== "string"
    || typeof account.planUsageEnabled !== "boolean") {
    return { authenticated: false, account: null, allowedModelsAvailable: false };
  }
  return {
    authenticated: true,
    account: {
      clientId: account.clientId,
      email: typeof account.email === "string" ? account.email : null,
      name: typeof account.name === "string" ? account.name : null,
      planUsageEnabled: account.planUsageEnabled,
    },
    allowedModelsAvailable: data.allowedModelsAvailable === true,
  };
}

export async function getSiwcModels(
  request: Request,
  fetchImpl: typeof fetch = fetch,
  configuredServiceToken?: string,
): Promise<SiwcModelChoice[]> {
  const cookie = getSiwcSessionCookie(request);
  if (!cookie) throw new Error("请先在本机连接 ChatGPT 账号。");
  const token = serviceToken(configuredServiceToken);
  let response: Response;
  try {
    response = await fetchImpl(SIWC_ORIGIN + "/api/provider/models", {
      method: "GET",
      headers: internalHeaders(cookie, token, "application/json"),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
    });
  } catch {
    throw new Error("无法读取当前 ChatGPT 账号的可用模型，请确认本机连接服务运行正常。");
  }
  const data = await readJson(response);
  if (!response.ok) {
    throw new Error(typeof data.message === "string" ? data.message : "无法读取当前 ChatGPT 账号的可用模型。");
  }
  if (!Array.isArray(data.models)) throw new Error("本机连接服务返回的模型列表格式无效。");
  return data.models.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .filter((item) => typeof item.slug === "string" && item.slug.length <= 160
      && typeof item.displayName === "string" && item.displayName.length <= 200)
    .map((item) => ({ slug: item.slug as string, displayName: item.displayName as string }));
}

export async function resumeAuthorizedSiwcProfile(
  request: Request,
  clientId: string,
  fetchImpl: typeof fetch = fetch,
  configuredServiceToken?: string,
): Promise<{ setCookie: string }> {
  if (!clientId || clientId.length > 256) throw new TypeError("A validated SIWC profile id is required.");
  const token = serviceToken(configuredServiceToken);
  const cookie = getSiwcSessionCookie(request);
  let response: Response;
  try {
    response = await fetchImpl(SIWC_ORIGIN + "/api/provider/select", {
      method: "POST",
      headers: {
        ...optionalInternalHeaders(cookie, token, "application/json"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientId }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
    });
  } catch {
    throw new Error("无法恢复已授权的 ChatGPT 连接，请确认 4317 服务正在运行。");
  }
  if (!response.ok) {
    const data = await readJson(response);
    throw new Error(typeof data.message === "string" ? data.message : "已授权的 ChatGPT 连接无法恢复。");
  }
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie || !/^atlas_siwc_session=[A-Za-z0-9_-]{40,64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/u.test(setCookie)) {
    throw new Error("本机连接服务没有返回有效的会话凭据。");
  }
  return { setCookie };
}

function parseEventBlock(block: string) {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/u)) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const name = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /u, "");
    if (name === "event") event = value;
    else if (name === "data") data.push(value);
  }
  if (!data.length) return null;
  return { event, data: data.join("\n") };
}

function parseEventPayload(data: string) {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw new Error("ChatGPT 流式响应格式无效。");
  }
}

export function createSiwcAssistantProvider(input: {
  sessionCookie: string;
  expectedClientId: string;
  model: string;
  bindingVersion: number;
  fetchImpl?: typeof fetch;
  serviceToken?: string;
  bindingIsCurrent?: () => boolean | Promise<boolean>;
}): AssistantProvider {
  const fetchImpl = input.fetchImpl ?? fetch;
  if (!/^[A-Za-z0-9_-]{40,64}$/u.test(input.sessionCookie)
    || !input.expectedClientId
    || !input.model
    || !Number.isSafeInteger(input.bindingVersion)
    || input.bindingVersion < 1) {
    throw new TypeError("A validated SIWC session, owner binding, model, and version are required.");
  }
  const cookie = cookieHeader(input.sessionCookie);
  const token = serviceToken(input.serviceToken);

  return {
    name: "siwc-chatgpt",
    model: input.model,
    bindingVersion: input.bindingVersion,
    async *stream({ messages, signal }) {
      if (input.bindingIsCurrent && !await input.bindingIsCurrent()) {
        throw new Error("ChatGPT 授权连接已变更，本次运行没有调用模型。");
      }
      const profileResponse = await fetchImpl(SIWC_ORIGIN + "/api/provider/session", {
        method: "GET",
        headers: { cookie, origin: UI_ORIGIN, accept: "application/json", [SERVICE_TOKEN_HEADER]: token },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      });
      const profileData = await readJson(profileResponse);
      const profile = profileData.account && typeof profileData.account === "object" && !Array.isArray(profileData.account)
        ? profileData.account as Record<string, unknown>
        : null;
      if (!profileResponse.ok || profileData.authenticated !== true || profile?.clientId !== input.expectedClientId
        || profile.planUsageEnabled !== true || profileData.allowedModelsAvailable !== true) {
        throw new Error("当前 ChatGPT 连接与已授权账号不一致，请重新检查账号连接。");
      }

      if (input.bindingIsCurrent && !await input.bindingIsCurrent()) {
        throw new Error("ChatGPT 授权连接已变更，本次运行没有调用模型。");
      }

      let response: Response;
      try {
        response = await fetchImpl(SIWC_ORIGIN + "/api/assistant/chat", {
          method: "POST",
          headers: {
            cookie,
            origin: UI_ORIGIN,
            accept: "text/event-stream",
            "content-type": "application/json",
            [SERVICE_TOKEN_HEADER]: token,
          },
          body: JSON.stringify({ model: input.model, messages }),
          cache: "no-store",
          redirect: "error",
          signal,
        });
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      if (!response.ok) {
        const data = await readJson(response);
        throw new Error(typeof data.message === "string" ? data.message : "ChatGPT 请求没有启动。");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("ChatGPT 没有返回可读取的流式响应。");
      const decoder = new TextDecoder();
      let buffer = "";
      let completed = false;
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.search(/\r?\n\r?\n/u);
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            const delimiter = buffer.slice(boundary).match(/^\r?\n\r?\n/u)?.[0] ?? "\n\n";
            buffer = buffer.slice(boundary + delimiter.length);
            const parsed = parseEventBlock(block);
            if (parsed?.event === "delta") {
              const payload = parseEventPayload(parsed.data);
              if (typeof payload !== "string") throw new Error("ChatGPT 流式响应内容格式无效。");
              if (payload) yield payload;
            } else if (parsed?.event === "done") {
              const payload = parseEventPayload(parsed.data);
              if (!payload || typeof payload !== "object" || (payload as Record<string, unknown>).completed !== true) {
                throw new Error("ChatGPT 响应没有报告完整结束。");
              }
              completed = true;
              break;
            } else if (parsed?.event === "error") {
              const payload = parseEventPayload(parsed.data);
              const message = payload && typeof payload === "object" ? (payload as Record<string, unknown>).message : null;
              throw new Error(typeof message === "string" ? message : "ChatGPT 响应失败。");
            }
            boundary = buffer.search(/\r?\n\r?\n/u);
          }
          if (completed) break;
        }
        buffer += decoder.decode();
        if (!completed && buffer.trim() && !signal.aborted) {
          const parsed = parseEventBlock(buffer);
          if (parsed?.event === "done") {
            const payload = parseEventPayload(parsed.data);
            completed = Boolean(payload && typeof payload === "object" && (payload as Record<string, unknown>).completed === true);
          } else if (parsed?.event === "error") {
            const payload = parseEventPayload(parsed.data);
            const message = payload && typeof payload === "object" ? (payload as Record<string, unknown>).message : null;
            throw new Error(typeof message === "string" ? message : "ChatGPT 响应失败。");
          } else if (parsed?.event === "delta") {
            const payload = parseEventPayload(parsed.data);
            if (typeof payload !== "string") throw new Error("ChatGPT 流式响应内容格式无效。");
            if (payload) yield payload;
          }
        }
        if (!completed && !signal.aborted) throw new Error("ChatGPT 流提前结束，回复未确认完整。");
      } finally {
        try { await reader.cancel(); } catch { /* The stream may have ended or been aborted. */ }
        reader.releaseLock();
      }
    },
  };
}
