import { authSessionReader } from "@/lib/server/auth-session";
import { assistantRunManager, conversationService } from "@/lib/server/coach/conversation-runtime";
import { createCoachAssistantRunHandlers } from "@/lib/server/coach/route-handlers";

export const runtime = "nodejs";
const handlers = createCoachAssistantRunHandlers(conversationService, authSessionReader, assistantRunManager);

export async function POST(request: Request, context: { params: Promise<{ conversationId: string; runId: string }> }) {
  return handlers.cancel(request, context);
}
