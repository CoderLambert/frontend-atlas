import type { SessionReader } from "../auth-session.ts";
import type { AssistantRunManager } from "./assistant-run-manager.ts";
import type { AssistantProvider } from "./assistant-provider.ts";
import type { ConversationService } from "./conversation-service.ts";
import { getAssistantProvider } from "./assistant-provider.ts";
import { createWriteRequestGuard } from "./write-request-guard.ts";

type RouteParameters = { conversationId: string };
type HandlerContext = { params: Promise<RouteParameters> };
type RunHandlerContext = { params: Promise<{ conversationId: string; runId: string }> };

function json(payload: unknown, status = 200) {
  return Response.json(payload, {
    status,
    headers: { "cache-control": "no-store" },
  });
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
  const expectedAccountId = request.headers.get("x-frontend-atlas-account-id");
  // This is only a stale-tab consistency check; the authenticated session above remains the owner authority.
  return expectedAccountId === authenticatedUserId;
}

function accountChanged() {
  return json({ error: "account_changed" }, 409);
}

export function createCoachConversationHandlers(
  service: ConversationService,
  sessions: SessionReader,
  options: { trustedOriginUrl?: string | null } = {},
) {
  const trustedOriginUrl = options.trustedOriginUrl === undefined
    ? process.env.BETTER_AUTH_URL
    : options.trustedOriginUrl;
  const guardWriteRequest = createWriteRequestGuard(trustedOriginUrl);

  async function userId(request: Request) {
    return sessions.getUserId(request);
  }

  return {
    async list(request: Request) {
      const ownerUserId = await userId(request);
      if (!ownerUserId) return json({ error: "unauthorized" }, 401);
      if (!expectedAccountMatches(request, ownerUserId)) return accountChanged();
      return json({ conversations: await service.list(ownerUserId) });
    },

    async create(request: Request) {
      const blocked = guardWriteRequest(request);
      if (blocked) return blocked;
      const ownerUserId = await userId(request);
      if (!ownerUserId) return json({ error: "unauthorized" }, 401);
      if (!expectedAccountMatches(request, ownerUserId)) return accountChanged();
      const body = await readObject(request);
      if (!body) return json({ error: "invalid_request" }, 400);
      const result = await service.create(ownerUserId, body);
      return result.kind === "invalid"
        ? json({ error: "invalid_conversation" }, 400)
        : json({ conversation: result.conversation }, 201);
    },

    async read(request: Request, context: HandlerContext) {
      const ownerUserId = await userId(request);
      if (!ownerUserId) return json({ error: "unauthorized" }, 401);
      if (!expectedAccountMatches(request, ownerUserId)) return accountChanged();
      const { conversationId } = await context.params;
      const conversation = await service.find(ownerUserId, conversationId);
      return conversation ? json({ conversation }) : json({ error: "not_found" }, 404);
    },

    async delete(request: Request, context: HandlerContext) {
      const blocked = guardWriteRequest(request);
      if (blocked) return blocked;
      const ownerUserId = await userId(request);
      if (!ownerUserId) return json({ error: "unauthorized" }, 401);
      if (!expectedAccountMatches(request, ownerUserId)) return accountChanged();
      const { conversationId } = await context.params;
      const deleted = await service.delete(ownerUserId, conversationId);
      return deleted ? json({ deleted: true }) : json({ error: "not_found" }, 404);
    },

    async appendMessage(request: Request, context: HandlerContext) {
      const blocked = guardWriteRequest(request);
      if (blocked) return blocked;
      const ownerUserId = await userId(request);
      if (!ownerUserId) return json({ error: "unauthorized" }, 401);
      if (!expectedAccountMatches(request, ownerUserId)) return accountChanged();
      const { conversationId } = await context.params;
      const body = await readObject(request);
      if (!body) return json({ error: "invalid_request" }, 400);
      const result = await service.appendUserMessage(ownerUserId, conversationId, body);
      if (result.kind === "invalid") return json({ error: "invalid_message" }, 400);
      if (result.kind === "not-found") return json({ error: "not_found" }, 404);
      if (result.kind === "conflict") return json({ error: "idempotency_conflict" }, 409);
      return json({ message: result.message, duplicate: result.duplicate }, result.duplicate ? 200 : 201);
    },
  };
}

export function createCoachAssistantRunHandlers(
  service: ConversationService,
  sessions: SessionReader,
  runManager: AssistantRunManager,
  options: { trustedOriginUrl?: string | null; getProvider?: (request: Request) => AssistantProvider | null } = {},
) {
  const trustedOriginUrl = options.trustedOriginUrl === undefined
    ? process.env.BETTER_AUTH_URL
    : options.trustedOriginUrl;
  const guardWriteRequest = createWriteRequestGuard(trustedOriginUrl);
  const resolveProvider = options.getProvider ?? getAssistantProvider;

  return {
    async create(request: Request, context: HandlerContext) {
      const blocked = guardWriteRequest(request);
      if (blocked) return blocked;
      const ownerUserId = await sessions.getUserId(request);
      if (!ownerUserId) return json({ error: "unauthorized" }, 401);
      if (!expectedAccountMatches(request, ownerUserId)) return accountChanged();
      const provider = resolveProvider(request);
      if (!provider) return json({ error: "assistant_not_connected" }, 503);
      const { conversationId } = await context.params;
      const body = await readObject(request);
      if (!body) return json({ error: "invalid_request" }, 400);
      const result = service.createAssistantRun(ownerUserId, conversationId, body);
      if (result.kind === "invalid") return json({ error: "invalid_run" }, 400);
      if (result.kind === "not-found") return json({ error: "not_found" }, 404);
      if (result.kind === "conflict") return json({ error: "idempotency_conflict" }, 409);
      if (result.kind === "existing") {
        return json({
          duplicate: true,
          run: result.run,
          userMessage: result.userMessage,
          assistantMessage: result.assistantMessage,
        });
      }

      if (request.signal.aborted) {
        service.finishAssistantRun(result.run.id, "interrupted");
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }

      const handle = runManager.start({
        runId: result.run.id,
        ownerUserId,
        conversationId,
        userContent: result.userMessage.content,
        userMessage: result.userMessage,
        assistantMessage: result.assistantMessage,
        provider,
      });
      const abortForDisconnect = () => { void handle.abort("interrupted"); };
      if (request.signal.aborted) abortForDisconnect();
      else request.signal.addEventListener("abort", abortForDisconnect, { once: true });
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        request.signal.removeEventListener("abort", abortForDisconnect);
      };
      const iterator = handle.events[Symbol.asyncIterator]();
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await iterator.next();
            if (next.done) {
              cleanup();
              controller.close();
              return;
            }
            controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
          } catch {
            cleanup();
            controller.error(new Error("assistant_stream_failed"));
          }
        },
        cancel() {
          cleanup();
          void handle.abort("interrupted");
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "cache-control": "no-store, no-transform",
          "content-type": "application/x-ndjson; charset=utf-8",
          "x-accel-buffering": "no",
          "x-content-type-options": "nosniff",
        },
      });
    },

    async cancel(request: Request, context: RunHandlerContext) {
      const blocked = guardWriteRequest(request);
      if (blocked) return blocked;
      const ownerUserId = await sessions.getUserId(request);
      if (!ownerUserId) return json({ error: "unauthorized" }, 401);
      if (!expectedAccountMatches(request, ownerUserId)) return accountChanged();
      const { conversationId, runId } = await context.params;
      const existing = service.getAssistantRun(ownerUserId, conversationId, runId);
      if (!existing) return json({ error: "not_found" }, 404);
      let completion: Awaited<ReturnType<AssistantRunManager["abort"]>> = null;
      if (["pending", "streaming", "interrupted"].includes(existing.run.status)) {
        completion = await runManager.abort(runId, ownerUserId, "cancelled");
        if (!completion) {
          try {
            service.cancelAssistantRun(runId);
          } catch {
            // Return the current persisted state; the client keeps any visible unsaved tail.
          }
        }
      }
      const current = service.getAssistantRun(ownerUserId, conversationId, runId);
      const terminalStatusPersisted = completion
        ? completion.terminalStatusPersisted
        : Boolean(current && !["pending", "streaming", "interrupted"].includes(current.run.status));
      return json({
        run: current
          ? { ...current.run, ...(completion ? { status: completion.status } : {}) }
          : existing.run,
        assistantMessage: current
          ? { ...current.assistantMessage, ...(completion ? { status: completion.status } : {}) }
          : existing.assistantMessage,
        ...(completion ? {
          contentPersisted: completion.contentPersisted,
          ...(completion.error ? { error: completion.error } : {}),
        } : {}),
        terminalStatusPersisted,
      });
    },
  };
}
