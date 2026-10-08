import type { SessionReader } from "../auth-session.ts";
import type { ConversationService } from "./conversation-service.ts";
import { createWriteRequestGuard } from "./write-request-guard.ts";

type RouteParameters = { conversationId: string };
type HandlerContext = { params: Promise<RouteParameters> };

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
      return json({ conversations: await service.list(ownerUserId) });
    },

    async create(request: Request) {
      const blocked = guardWriteRequest(request);
      if (blocked) return blocked;
      const ownerUserId = await userId(request);
      if (!ownerUserId) return json({ error: "unauthorized" }, 401);
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
      const { conversationId } = await context.params;
      const conversation = await service.find(ownerUserId, conversationId);
      return conversation ? json({ conversation }) : json({ error: "not_found" }, 404);
    },

    async delete(request: Request, context: HandlerContext) {
      const blocked = guardWriteRequest(request);
      if (blocked) return blocked;
      const ownerUserId = await userId(request);
      if (!ownerUserId) return json({ error: "unauthorized" }, 401);
      const { conversationId } = await context.params;
      const deleted = await service.delete(ownerUserId, conversationId);
      return deleted ? json({ deleted: true }) : json({ error: "not_found" }, 404);
    },

    async appendMessage(request: Request, context: HandlerContext) {
      const blocked = guardWriteRequest(request);
      if (blocked) return blocked;
      const ownerUserId = await userId(request);
      if (!ownerUserId) return json({ error: "unauthorized" }, 401);
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
