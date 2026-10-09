import { eq } from "drizzle-orm";
import { authServerConfigured, configuredSocialProviders } from "@/lib/auth";
import { db } from "@/lib/db";
import { account as authAccount, user } from "@/lib/db/schema";
import { authSessionReader } from "@/lib/server/auth-session";
import { isMockAuthUser, isMockAuthEnabled } from "@/lib/server/mock-auth";
import { isMockAssistantEnabled } from "@/lib/server/coach/assistant-provider";

export const runtime = "nodejs";

function json(payload: unknown) {
  return Response.json(payload, { headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request) {
  const userId = await authSessionReader.getUserId(request);
  const siteAccount = userId
    ? db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(eq(user.id, userId)).limit(1).all()[0] ?? null
    : null;
  const linkedProviders = userId
    ? db.select({ providerId: authAccount.providerId }).from(authAccount).where(eq(authAccount.userId, userId)).all()
      .map(({ providerId }) => providerId)
      .filter((providerId): providerId is "github" | "google" => providerId === "github" || providerId === "google")
    : [];

  return json({
    authConfigured: authServerConfigured,
    providers: configuredSocialProviders,
    linkedProviders,
    account: siteAccount ? { ...siteAccount, authMethod: isMockAuthUser(request, siteAccount.id) ? "mock" : "oauth" } : null,
    mockAuthEnabled: isMockAuthEnabled(request),
    assistantProvider: isMockAssistantEnabled(request) ? "local-mock" : "unavailable",
  });
}
