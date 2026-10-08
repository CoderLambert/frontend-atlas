import { authSessionReader } from "@/lib/server/auth-session";
import { conversationService } from "@/lib/server/coach/conversation-runtime";
import { createCoachConversationHandlers } from "@/lib/server/coach/route-handlers";

export const runtime = "nodejs";
const handlers = createCoachConversationHandlers(conversationService, authSessionReader);

export async function POST(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  return handlers.appendMessage(request, context);
}
