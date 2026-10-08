import "server-only";

export const mockAuthCookieName = "frontend-atlas-mock-user";

const mockUserIds = new Set(["mock-user-a", "mock-user-b"]);

export function isLocalRequest(request: Request) {
  try {
    const hostname = new URL(request.url).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
  } catch {
    return false;
  }
}

export function isMockAuthEnabled(request: Request) {
  return process.env.NODE_ENV === "development"
    && process.env.FRONTEND_ATLAS_MOCK_AUTH === "1"
    && isLocalRequest(request);
}

export function readMockAuthUserId(request: Request): string | null {
  if (!isMockAuthEnabled(request)) return null;
  const cookie = request.headers.get("cookie") ?? "";
  const prefix = `${mockAuthCookieName}=`;
  const value = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length);
  return value && mockUserIds.has(value) ? value : null;
}

export function isMockAuthUser(request: Request, userId: string) {
  return readMockAuthUserId(request) === userId;
}

export function isAllowedMockAuthUser(userId: unknown): userId is "mock-user-a" | "mock-user-b" {
  return typeof userId === "string" && mockUserIds.has(userId);
}
