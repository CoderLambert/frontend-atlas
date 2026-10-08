import { authSessionReader, verifiedAuthSessionReader } from "@/lib/server/auth-session";
import { db } from "@/lib/db";
import { LegacyConversationImportService } from "@/lib/server/coach/legacy-import";
import { createLegacyConversationImportHandler } from "@/lib/server/coach/legacy-import-route-handler";
import { conversationService } from "@/lib/server/coach/conversation-runtime";
import { createCoachConversationHandlers } from "@/lib/server/coach/route-handlers";

export const runtime = "nodejs";
const handlers = createCoachConversationHandlers(conversationService, authSessionReader);
const legacyImport = createLegacyConversationImportHandler(
  new LegacyConversationImportService(db),
  verifiedAuthSessionReader,
);

export async function GET(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  return handlers.read(request, context);
}

export async function DELETE(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  return handlers.delete(request, context);
}

export async function POST(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await context.params;
  if (conversationId !== "legacy-import") return Response.json({ error: "not_found" }, { status: 404 });
  return legacyImport(request);
}
