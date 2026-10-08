import { eq } from "drizzle-orm";
import { authServerConfigured, configuredSocialProviders } from "@/lib/auth";
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { authSessionReader } from "@/lib/server/auth-session";
import { isMockAuthUser, isMockAuthEnabled } from "@/lib/server/mock-auth";

export const runtime = "nodejs";

function json(payload: unknown) {
  return Response.json(payload, { headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request) {
  const userId = await authSessionReader.getUserId(request);
  const account = userId
    ? db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(eq(user.id, userId)).limit(1).all()[0] ?? null
    : null;

  return json({
    authConfigured: authServerConfigured,
    providers: configuredSocialProviders,
    account: account ? { ...account, authMethod: isMockAuthUser(request, account.id) ? "mock" : "oauth" } : null,
    mockAuthEnabled: isMockAuthEnabled(request),
  });
}
