import type { SessionReader } from "../auth-session.ts";
import { createWriteRequestGuard } from "./write-request-guard.ts";
import { LEGACY_IMPORT_BODY_LIMIT_BYTES, type LegacyConversationImportService, validateLegacyImportBatch } from "./legacy-import.ts";

function json(payload: unknown, status = 200) {
  return Response.json(payload, { status, headers: { "cache-control": "no-store" } });
}

async function readJsonLimited(request: Request): Promise<{ value?: unknown; error?: "invalid_json" | "payload_too_large" }> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > LEGACY_IMPORT_BODY_LIMIT_BYTES) return { error: "payload_too_large" };
  if (!request.body) return { error: "invalid_json" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > LEGACY_IMPORT_BODY_LIMIT_BYTES) {
        await reader.cancel();
        return { error: "payload_too_large" };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown };
  } catch {
    return { error: "invalid_json" };
  } finally {
    reader.releaseLock();
  }
}

export function createLegacyConversationImportHandler(
  service: LegacyConversationImportService,
  sessions: SessionReader,
  options: { trustedOriginUrl?: string | null } = {},
) {
  const trustedOriginUrl = options.trustedOriginUrl === undefined
    ? process.env.BETTER_AUTH_URL
    : options.trustedOriginUrl;
  const guardWriteRequest = createWriteRequestGuard(trustedOriginUrl);

  return async function POST(request: Request) {
    const blocked = guardWriteRequest(request);
    if (blocked) return blocked;
    const ownerUserId = await sessions.getUserId(request);
    if (!ownerUserId) return json({ error: "unauthorized" }, 401);
    if (request.headers.get("x-frontend-atlas-account-id") !== ownerUserId) {
      return json({ error: "account_changed" }, 409);
    }

    const payload = await readJsonLimited(request);
    if (payload.error === "payload_too_large") return json({ error: "payload_too_large" }, 413);
    if (payload.error) return json({ error: "invalid_request" }, 400);
    const batch = validateLegacyImportBatch(payload.value);
    if (!batch) return json({ error: "invalid_batch" }, 400);

    return json({ results: service.importBatch(ownerUserId, batch.records) });
  };
}
