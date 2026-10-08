import "server-only";

import { getAssistantProvider, type AssistantProvider } from "./assistant-provider.ts";
import type { ProviderBindingRepository } from "./provider-binding-repository.ts";
import {
  createSiwcAssistantProvider,
  getSiwcModels,
  getSiwcSessionCookie,
  getSiwcSessionProfile,
} from "./siwc-provider.ts";

export class AssistantProviderConnectionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "AssistantProviderConnectionError";
    this.code = code;
    this.status = status;
  }
}

export function createSiwcAssistantProviderResolver(bindings: ProviderBindingRepository) {
  return async function resolveProvider(request: Request, ownerUserId: string): Promise<AssistantProvider | null> {
    const mock = getAssistantProvider(request);
    if (mock) return mock;

    const binding = bindings.findForOwner(ownerUserId);
    if (!binding) {
      throw new AssistantProviderConnectionError(
        "provider_binding_required",
        "此站点账号尚未获本机操作员分配 ChatGPT 连接。",
        403,
      );
    }
    if (!binding.selectedModel) {
      throw new AssistantProviderConnectionError(
        "provider_model_required",
        "请先为已授权的 ChatGPT 连接选择模型。",
        409,
      );
    }

    const sessionCookie = getSiwcSessionCookie(request);
    if (!sessionCookie) {
      throw new AssistantProviderConnectionError(
        "provider_session_required",
        "已授权的 ChatGPT 连接需要在此浏览器重新登录。",
        409,
      );
    }

    let profile;
    let models;
    try {
      [profile, models] = await Promise.all([
        getSiwcSessionProfile(request),
        getSiwcModels(request),
      ]);
    } catch (error) {
      throw new AssistantProviderConnectionError(
        "provider_unavailable",
        error instanceof Error ? error.message : "本机 ChatGPT 连接服务暂不可达。",
        503,
      );
    }
    if (!profile.authenticated || !profile.account) {
      throw new AssistantProviderConnectionError(
        "provider_session_required",
        "已授权的 ChatGPT 连接需要在此浏览器重新登录。",
        409,
      );
    }
    if (profile.account.clientId !== binding.siwcClientId) {
      throw new AssistantProviderConnectionError(
        "provider_profile_mismatch",
        "当前浏览器连接的 ChatGPT 账号不是此站点账号获授权的连接。",
        403,
      );
    }
    if (!profile.allowedModelsAvailable || !profile.account.planUsageEnabled) {
      throw new AssistantProviderConnectionError(
        "provider_plan_permission_required",
        "当前 ChatGPT 连接没有可用的计划用量权限。",
        409,
      );
    }
    if (!models.some((model) => model.slug === binding.selectedModel)) {
      throw new AssistantProviderConnectionError(
        "provider_model_unavailable",
        "已选择的模型不再可用，请刷新连接后重新选择。",
        409,
      );
    }

    return createSiwcAssistantProvider({
      sessionCookie,
      expectedClientId: binding.siwcClientId,
      model: binding.selectedModel,
      bindingVersion: binding.version,
      bindingIsCurrent: () => {
        const current = bindings.findForOwner(ownerUserId);
        return current?.siwcClientId === binding.siwcClientId
          && current.selectedModel === binding.selectedModel
          && current.version === binding.version;
      },
    });
  };
}
