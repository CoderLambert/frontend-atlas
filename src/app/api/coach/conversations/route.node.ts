import { authSessionReader } from "@/lib/server/auth-session";
import { conversationService } from "@/lib/server/coach/conversation-runtime";
import { createCoachConversationHandlers } from "@/lib/server/coach/route-handlers";

export const runtime = "nodejs";
const handlers = createCoachConversationHandlers(conversationService, authSessionReader);

export async function GET(request: Request) {
  return handlers.list(request);
}

export async function POST(request: Request) {
  return handlers.create(request);
}
