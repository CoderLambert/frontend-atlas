import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

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

export function POST(request: Request) {
  return handlers ? handlers.POST(request) : authNotConfigured();
}
