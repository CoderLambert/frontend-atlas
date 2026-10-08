const requestHeaderName = "x-frontend-atlas-request";
const requestHeaderValue = "1";

function jsonError(error: string, status: number) {
  return Response.json({ error }, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function configuredOrigin(configuredUrl: string | null | undefined): string | null {
  if (!configuredUrl) return null;

  try {
    const url = new URL(configuredUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function createWriteRequestGuard(configuredUrl: string | null | undefined) {
  const trustedOrigin = configuredOrigin(configuredUrl);

  return function guardWriteRequest(request: Request): Response | null {
    if (!trustedOrigin) return jsonError("write_origin_not_configured", 503);

    const origin = request.headers.get("origin");
    if (!origin || origin === "null" || origin !== trustedOrigin) {
      return jsonError("invalid_origin", 403);
    }

    if (request.headers.get("sec-fetch-site") === "cross-site") {
      return jsonError("cross_site_request_rejected", 403);
    }

    // This non-simple header makes browser cross-origin requests require a CORS preflight.
    // The app does not grant cross-origin access, and Origin is still checked independently.
    if (request.headers.get(requestHeaderName) !== requestHeaderValue) {
      return jsonError("missing_request_header", 403);
    }

    const method = request.method.toUpperCase();
    if (method !== "POST" && method !== "PATCH" && method !== "DELETE") {
      return jsonError("unsupported_write_method", 405);
    }

    const contentType = request.headers.get("content-type");
    const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
    if (method === "POST" || method === "PATCH") {
      if (mediaType !== "application/json") return jsonError("json_content_type_required", 415);
    } else if (contentType && mediaType !== "application/json") {
      return jsonError("json_content_type_required", 415);
    }

    return null;
  };
}

export const coachWriteRequestHeader = {
  name: requestHeaderName,
  value: requestHeaderValue,
} as const;
