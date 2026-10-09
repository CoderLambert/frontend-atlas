import { toNextJsHandler } from "better-auth/next-js";
import { auth, configuredSocialProviders } from "@/lib/auth";
import { authSessionReader, verifiedAuthSessionReader } from "@/lib/server/auth-session";
import { createAuthPostRouteHandler } from "@/lib/server/auth-post-route-handler";

export const runtime = "nodejs";
const handlers = auth ? toNextJsHandler(auth) : null;
const handlePost = handlers ? createAuthPostRouteHandler({
  delegate: handlers.POST,
  sessions: authSessionReader,
  verifiedSessions: verifiedAuthSessionReader,
  configuredProviders: configuredSocialProviders,
}) : null;

function authNotConfigured() {
  return Response.json({ error: "authentication_not_configured" }, {
    status: 503,
    headers: { "cache-control": "no-store" },
  });
}

export function GET(request: Request) {
  return handlers ? handlers.GET(request) : authNotConfigured();
}

export function POST(request: Request) {
  return handlePost ? handlePost(request) : authNotConfigured();
}
