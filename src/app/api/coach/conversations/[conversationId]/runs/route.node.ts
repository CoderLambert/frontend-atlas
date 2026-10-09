import { authSessionReader } from "@/lib/server/auth-session";
import { db } from "@/lib/db";
import { assistantRunManager, conversationService } from "@/lib/server/coach/conversation-runtime";
import { ProviderBindingRepository } from "@/lib/server/coach/provider-binding-repository";
import { createCoachAssistantRunHandlers } from "@/lib/server/coach/route-handlers";
import { createSiwcAssistantProviderResolver } from "@/lib/server/coach/siwc-provider-resolver";

export const runtime = "nodejs";
const handlers = createCoachAssistantRunHandlers(conversationService, authSessionReader, assistantRunManager, {
  getProvider: createSiwcAssistantProviderResolver(new ProviderBindingRepository(db)),
});

export async function POST(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  return handlers.create(request, context);
}
