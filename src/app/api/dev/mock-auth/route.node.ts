import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { createWriteRequestGuard } from "@/lib/server/coach/write-request-guard";
import { isAllowedMockAuthUser, isMockAuthEnabled, mockAuthCookieName, readMockAuthUserId } from "@/lib/server/mock-auth";

export const runtime = "nodejs";
const guardWriteRequest = createWriteRequestGuard(process.env.BETTER_AUTH_URL);

function unavailable() {
  return Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
}

function withCookie(request: Request, userId: string | null) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const value = userId ? `${mockAuthCookieName}=${encodeURIComponent(userId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600${secure}`
    : `${mockAuthCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json", "cache-control": "no-store", "set-cookie": value },
  });
}

export async function POST(request: Request) {
  if (!isMockAuthEnabled(request)) return unavailable();
  const blocked = guardWriteRequest(request);
  if (blocked) return blocked;

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid_request" }, { status: 400 }); }
  const userId = body && typeof body === "object" && "userId" in body ? body.userId : null;
  if (!isAllowedMockAuthUser(userId)) return Response.json({ error: "invalid_mock_user" }, { status: 400 });
  const exists = db.select({ id: user.id }).from(user).where(eq(user.id, userId)).limit(1).all()[0];
  if (!exists) return Response.json({ error: "mock_user_not_seeded" }, { status: 404 });
  return withCookie(request, userId);
}

export async function DELETE(request: Request) {
  if (!isMockAuthEnabled(request)) return unavailable();
  const blocked = guardWriteRequest(request);
  if (blocked) return blocked;
  const expectedAccountId = request.headers.get("x-frontend-atlas-account-id");
  if (!expectedAccountId || expectedAccountId !== readMockAuthUserId(request)) {
    return Response.json({ error: "account_changed" }, { status: 409, headers: { "cache-control": "no-store" } });
  }
  return withCookie(request, null);
}
