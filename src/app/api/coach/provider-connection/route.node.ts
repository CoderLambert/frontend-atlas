import { db } from "@/lib/db";
import { authSessionReader } from "@/lib/server/auth-session";
import { assistantRunManager } from "@/lib/server/coach/conversation-runtime";
import { ProviderBindingRepository } from "@/lib/server/coach/provider-binding-repository";
import { createProviderConnectionHandlers } from "@/lib/server/coach/provider-connection-route-handler";

export const runtime = "nodejs";
const handlers = createProviderConnectionHandlers(
  new ProviderBindingRepository(db),
  authSessionReader,
  assistantRunManager,
);

export async function GET(request: Request) {
  return handlers.get(request);
}

export async function POST(request: Request) {
  return handlers.models(request);
}

export async function PATCH(request: Request) {
  return handlers.updateModel(request);
}

export async function DELETE(request: Request) {
  return handlers.remove(request);
}
