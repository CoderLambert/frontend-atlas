import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";
import { authSessionReader } from "@/lib/server/auth-session";

export const runtime = "nodejs";
const handlers = auth ? toNextJsHandler(auth) : null;

function authNotConfigured() {
  return Response.json({ error: "authentication_not_configured" }, {
    status: 503,
    headers: { "cache-control": "no-store" },
  });
}

export function GET(request: Request) {
  return handlers ? handlers.GET(request) : authNotConfigured();
}

export async function POST(request: Request) {
  if (handlers && new URL(request.url).pathname.replace(/\/+$/u, "") === "/api/auth/sign-out") {
    const expectedAccountId = request.headers.get("x-frontend-atlas-account-id");
    if (!expectedAccountId || expectedAccountId !== await authSessionReader.getUserId(request)) {
      return Response.json({ error: "account_changed" }, { status: 409, headers: { "cache-control": "no-store" } });
    }
  }
  return handlers ? handlers.POST(request) : authNotConfigured();
}
