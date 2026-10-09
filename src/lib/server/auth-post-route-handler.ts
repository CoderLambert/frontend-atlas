import type { SessionReader } from "./auth-session.ts";

export type AuthSocialProvider = "github" | "google";

type AuthPostRouteOptions = {
  delegate: (request: Request) => Response | Promise<Response>;
  sessions: SessionReader;
  verifiedSessions: SessionReader;
  configuredProviders: Readonly<Record<AuthSocialProvider, boolean>>;
};

const expectedAccountHeaderName = "x-frontend-atlas-account-id";
const socialProviders = new Set<AuthSocialProvider>(["github", "google"]);

function json(payload: unknown, status: number) {
  return Response.json(payload, { status, headers: { "cache-control": "no-store" } });
}

function isSocialProvider(value: unknown): value is AuthSocialProvider {
  return typeof value === "string" && socialProviders.has(value as AuthSocialProvider);
}

async function readLinkProvider(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return null;
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== "provider") return null;
    const provider = (value as Record<string, unknown>).provider;
    return isSocialProvider(provider) ? provider : null;
  } catch {
    return null;
  }
}

export function accountLinkCallbackPath(provider: AuthSocialProvider, result: "success" | "failed") {
  return `/coach/sessions/?accountLink=${result}&accountLinkProvider=${provider}`;
}

export function createAuthPostRouteHandler(options: AuthPostRouteOptions) {
  return async function handleAuthPost(request: Request) {
    const pathname = new URL(request.url).pathname.replace(/\/+$/u, "");
    if (pathname === "/api/auth/link-social") {
      const expectedAccountId = request.headers.get(expectedAccountHeaderName);
      const verifiedAccountId = await options.verifiedSessions.getUserId(request);
      if (!expectedAccountId || expectedAccountId !== verifiedAccountId) {
        return json({ error: "account_changed" }, 409);
      }

      const provider = await readLinkProvider(request);
      if (!provider || !options.configuredProviders[provider]) {
        return json({ error: "invalid_link_request" }, 400);
      }

      const headers = new Headers(request.headers);
      headers.set("content-type", "application/json");
      headers.delete("content-length");
      const sanitizedRequest = new Request(request.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          provider,
          callbackURL: accountLinkCallbackPath(provider, "success"),
          errorCallbackURL: accountLinkCallbackPath(provider, "failed"),
          disableRedirect: true,
        }),
        signal: request.signal,
      });
      return options.delegate(sanitizedRequest);
    }

    if (pathname === "/api/auth/sign-out") {
      const expectedAccountId = request.headers.get(expectedAccountHeaderName);
      if (!expectedAccountId || expectedAccountId !== await options.sessions.getUserId(request)) {
        return json({ error: "account_changed" }, 409);
      }
    }

    return options.delegate(request);
  };
}
