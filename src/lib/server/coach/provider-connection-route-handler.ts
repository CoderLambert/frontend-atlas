import type { SessionReader } from "../auth-session.ts";
import type { AssistantRunManager } from "./assistant-run-manager.ts";
import type { ProviderBindingRepository } from "./provider-binding-repository.ts";
import { getSiwcModels, getSiwcSessionProfile, resumeAuthorizedSiwcProfile, type SiwcModelChoice, type SiwcSessionProfile } from "./siwc-provider.ts";
import { createWriteRequestGuard } from "./write-request-guard.ts";

function json(payload: unknown, status = 200) {
  return Response.json(payload, { status, headers: { "cache-control": "no-store" } });
}

async function readObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function expectedAccountMatches(request: Request, authenticatedUserId: string) {
  return request.headers.get("x-frontend-atlas-account-id") === authenticatedUserId;
}

function accountChanged() {
  return json({ error: "account_changed" }, 409);
}

type ConnectionResult =
  | { kind: "unbound" }
  | { kind: "session-required"; binding: NonNullable<ReturnType<ProviderBindingRepository["findForOwner"]>> }
  | { kind: "profile-mismatch"; binding: NonNullable<ReturnType<ProviderBindingRepository["findForOwner"]>> }
  | { kind: "plan-required"; binding: NonNullable<ReturnType<ProviderBindingRepository["findForOwner"]>>; profile: NonNullable<SiwcSessionProfile["account"]> }
  | { kind: "connected"; binding: NonNullable<ReturnType<ProviderBindingRepository["findForOwner"]>>; profile: NonNullable<SiwcSessionProfile["account"]> };

export function createProviderConnectionHandlers(
  bindings: ProviderBindingRepository,
  sessions: SessionReader,
  runManager: AssistantRunManager,
  options: {
    trustedOriginUrl?: string | null;
    getSessionProfile?: (request: Request) => Promise<SiwcSessionProfile>;
    getModels?: (request: Request) => Promise<SiwcModelChoice[]>;
    resumeProfile?: (request: Request, clientId: string) => Promise<{ setCookie: string }>;
  } = {},
) {
  const trustedOriginUrl = options.trustedOriginUrl === undefined ? process.env.BETTER_AUTH_URL : options.trustedOriginUrl;
  const guardWriteRequest = createWriteRequestGuard(trustedOriginUrl);
  const readSession = options.getSessionProfile ?? getSiwcSessionProfile;
  const listModels = options.getModels ?? getSiwcModels;
  const resumeProfile = options.resumeProfile ?? resumeAuthorizedSiwcProfile;

  async function userId(request: Request) {
    return sessions.getUserId(request);
  }

  async function resolveConnection(request: Request, ownerUserId: string): Promise<ConnectionResult> {
    const binding = bindings.findForOwner(ownerUserId);
    if (!binding) return { kind: "unbound" };
    const session = await readSession(request);
    if (!session.authenticated || !session.account) return { kind: "session-required", binding };
    if (session.account.clientId !== binding.siwcClientId) return { kind: "profile-mismatch", binding };
    if (!session.allowedModelsAvailable || !session.account.planUsageEnabled) {
      return { kind: "plan-required", binding, profile: session.account };
    }
    return { kind: "connected", binding, profile: session.account };
  }

  function publicConnection(result: ConnectionResult) {
    if (result.kind === "unbound") {
      return { authorization: "operator_required", connected: false, selectedModel: null, bindingVersion: null };
    }
    if (result.kind === "session-required") {
      return { authorization: "authorized", connected: false, reason: "session_required", selectedModel: result.binding.selectedModel, bindingVersion: result.binding.version };
    }
    if (result.kind === "profile-mismatch") {
      return { authorization: "authorized", connected: false, reason: "profile_mismatch", selectedModel: result.binding.selectedModel, bindingVersion: result.binding.version };
    }
    if (result.kind === "plan-required") {
      return {
        authorization: "authorized",
        connected: false,
        reason: "plan_permission_required",
        account: { name: result.profile.name, email: result.profile.email },
        selectedModel: result.binding.selectedModel,
        bindingVersion: result.binding.version,
      };
    }
    return {
      authorization: "authorized",
      connected: true,
      account: { name: result.profile.name, email: result.profile.email },
      selectedModel: result.binding.selectedModel,
      bindingVersion: result.binding.version,
    };
  }

  return {
    async get(request: Request) {
      const ownerUserId = await userId(request);
      if (!ownerUserId) return json({ error: "unauthorized" }, 401);
      if (!expectedAccountMatches(request, ownerUserId)) return accountChanged();
      try {
        return json(publicConnection(await resolveConnection(request, ownerUserId)));
      } catch {
        return json({ error: "provider_unavailable", message: "本机 ChatGPT 连接服务暂不可达。" }, 503);
      }
    },

    async models(request: Request) {
      const blocked = guardWriteRequest(request);
      if (blocked) return blocked;
      const ownerUserId = await userId(request);
      if (!ownerUserId) return json({ error: "unauthorized" }, 401);
      if (!expectedAccountMatches(request, ownerUserId)) return accountChanged();
      try {
        const connection = await resolveConnection(request, ownerUserId);
        if (connection.kind === "unbound") return json({ error: "operator_authorization_required" }, 403);
        if (connection.kind !== "connected") return json({ error: connection.kind }, 409);
        return json({ models: await listModels(request), selectedModel: connection.binding.selectedModel });
      } catch (error) {
        return json({ error: "provider_unavailable", message: error instanceof Error ? error.message : "无法读取 ChatGPT 模型。" }, 503);
      }
    },

    async resume(request: Request) {
      const blocked = guardWriteRequest(request);
      if (blocked) return blocked;
      const ownerUserId = await userId(request);
      if (!ownerUserId) return json({ error: "unauthorized" }, 401);
      if (!expectedAccountMatches(request, ownerUserId)) return accountChanged();
      const binding = bindings.findForOwner(ownerUserId);
      if (!binding) return json({ error: "operator_authorization_required" }, 403);
      try {
        const resumed = await resumeProfile(request, binding.siwcClientId);
        return new Response(JSON.stringify({ resumed: true }), {
          status: 200,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
            "set-cookie": resumed.setCookie,
          },
        });
      } catch (error) {
        return json({ error: "provider_resume_failed", message: error instanceof Error ? error.message : "已授权的 ChatGPT 连接无法恢复。" }, 409);
      }
    },

    async updateModel(request: Request) {
      const blocked = guardWriteRequest(request);
      if (blocked) return blocked;
      const ownerUserId = await userId(request);
      if (!ownerUserId) return json({ error: "unauthorized" }, 401);
      if (!expectedAccountMatches(request, ownerUserId)) return accountChanged();
      const body = await readObject(request);
      if (!body || typeof body.model !== "string" || !body.model.trim() || body.model.length > 160) {
        return json({ error: "invalid_model" }, 400);
      }
      try {
        const connection = await resolveConnection(request, ownerUserId);
        if (connection.kind === "unbound") return json({ error: "operator_authorization_required" }, 403);
        if (connection.kind !== "connected") return json({ error: connection.kind }, 409);
        const models = await listModels(request);
        if (!models.some((model) => model.slug === body.model)) return json({ error: "model_not_available" }, 400);
        const updated = bindings.updateSelectedModel(ownerUserId, connection.binding.version, body.model);
        if (!updated) return json({ error: "binding_changed" }, 409);
        await runManager.abortBinding(ownerUserId, connection.binding.version);
        return json({ selectedModel: updated.selectedModel, bindingVersion: updated.version });
      } catch (error) {
        return json({ error: "provider_unavailable", message: error instanceof Error ? error.message : "无法更新 ChatGPT 模型。" }, 503);
      }
    },

    async remove(request: Request) {
      const blocked = guardWriteRequest(request);
      if (blocked) return blocked;
      const ownerUserId = await userId(request);
      if (!ownerUserId) return json({ error: "unauthorized" }, 401);
      if (!expectedAccountMatches(request, ownerUserId)) return accountChanged();
      const removed = bindings.deleteForOwner(ownerUserId);
      if (removed) await runManager.abortBinding(ownerUserId, removed.version);
      return json({ unbound: Boolean(removed), historyPreserved: true });
    },
  };
}
