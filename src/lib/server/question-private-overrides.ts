import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.ts";
import { questionPrivateOverrides } from "../db/schema.ts";
import type { SessionReader } from "./auth-session.ts";
import { createWriteRequestGuard } from "./coach/write-request-guard.ts";

type Database = BetterSQLite3Database<typeof schema>;
type StoredOverride = typeof questionPrivateOverrides.$inferSelect;
type HandlerContext = { params: Promise<{ qid: string }> };

export class QuestionPrivateOverrideRepository {
  private readonly database: Database;

  constructor(database: Database) {
    this.database = database;
  }

  find(ownerUserId: string, qid: string) {
    return this.database.select().from(questionPrivateOverrides)
      .where(and(eq(questionPrivateOverrides.ownerUserId, ownerUserId), eq(questionPrivateOverrides.qid, qid)))
      .limit(1).all()[0] ?? null;
  }

  save(ownerUserId: string, qid: string, input: ValidatedOverrideInput) {
    return this.database.transaction((transaction) => {
      const existing = transaction.select().from(questionPrivateOverrides)
        .where(and(eq(questionPrivateOverrides.ownerUserId, ownerUserId), eq(questionPrivateOverrides.qid, qid)))
        .limit(1).all()[0] ?? null;
      if ((existing?.version ?? null) !== input.expectedVersion) return { kind: "conflict" as const, current: existing };

      const now = new Date();
      if (!existing) {
        const created = transaction.insert(questionPrivateOverrides).values({
          ownerUserId,
          qid,
          baseContentVersion: input.baseContentVersion,
          title: input.title,
          explanationMarkdown: input.explanationMarkdown,
          checkpointsJson: JSON.stringify(input.checkpoints),
          version: 1,
          createdAt: now,
          updatedAt: now,
        }).returning().get();
        return { kind: "saved" as const, value: created };
      }

      const updated = transaction.update(questionPrivateOverrides).set({
        baseContentVersion: input.baseContentVersion,
        title: input.title,
        explanationMarkdown: input.explanationMarkdown,
        checkpointsJson: JSON.stringify(input.checkpoints),
        version: existing.version + 1,
        updatedAt: now,
      }).where(and(
        eq(questionPrivateOverrides.ownerUserId, ownerUserId),
        eq(questionPrivateOverrides.qid, qid),
        eq(questionPrivateOverrides.version, existing.version),
      )).returning().get();
      return updated ? { kind: "saved" as const, value: updated } : { kind: "conflict" as const, current: this.find(ownerUserId, qid) };
    });
  }

  delete(ownerUserId: string, qid: string, expectedVersion: number) {
    return this.database.transaction((transaction) => {
      const existing = transaction.select().from(questionPrivateOverrides)
        .where(and(eq(questionPrivateOverrides.ownerUserId, ownerUserId), eq(questionPrivateOverrides.qid, qid)))
        .limit(1).all()[0] ?? null;
      if (!existing) return { kind: "not-found" as const };
      if (existing.version !== expectedVersion) return { kind: "conflict" as const, current: existing };
      transaction.delete(questionPrivateOverrides).where(and(
        eq(questionPrivateOverrides.ownerUserId, ownerUserId),
        eq(questionPrivateOverrides.qid, qid),
        eq(questionPrivateOverrides.version, expectedVersion),
      )).run();
      return { kind: "deleted" as const };
    });
  }
}

type ValidatedOverrideInput = {
  expectedVersion: number | null;
  baseContentVersion: string;
  title: string;
  explanationMarkdown: string;
  checkpoints: string[];
};

export class QuestionPrivateOverrideService {
  private readonly repository: QuestionPrivateOverrideRepository;
  private readonly knownQids: ReadonlySet<string>;
  private readonly publicContentVersion: string;

  constructor(
    repository: QuestionPrivateOverrideRepository,
    knownQids: ReadonlySet<string>,
    publicContentVersion: string,
  ) {
    this.repository = repository;
    this.knownQids = knownQids;
    this.publicContentVersion = publicContentVersion;
  }

  find(ownerUserId: string, qid: string) {
    if (!this.knownQids.has(qid)) return { kind: "not-found" as const };
    const value = this.repository.find(ownerUserId, qid);
    return { kind: "found" as const, value: value ? present(value) : null };
  }

  save(ownerUserId: string, qid: string, body: Record<string, unknown>) {
    if (!this.knownQids.has(qid)) return { kind: "not-found" as const };
    const input = validateInput(body);
    if (!input) return { kind: "invalid" as const };
    const result = this.repository.save(ownerUserId, qid, { ...input, baseContentVersion: this.publicContentVersion });
    return result.kind === "saved"
      ? { kind: "saved" as const, value: present(result.value) }
      : { kind: "conflict" as const, current: result.current ? present(result.current) : null };
  }

  delete(ownerUserId: string, qid: string, body: Record<string, unknown>) {
    if (!this.knownQids.has(qid)) return { kind: "not-found" as const };
    if (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1) return { kind: "invalid" as const };
    const result = this.repository.delete(ownerUserId, qid, body.expectedVersion as number);
    return result.kind === "conflict"
      ? { kind: "conflict" as const, current: present(result.current) }
      : result;
  }
}

function validateInput(body: Record<string, unknown>): Omit<ValidatedOverrideInput, "baseContentVersion"> | null {
  const expectedVersion = body.expectedVersion;
  if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 1)) return null;
  if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 500) return null;
  if (typeof body.explanationMarkdown !== "string" || !body.explanationMarkdown.trim() || body.explanationMarkdown.length > 200_000) return null;
  if (!Array.isArray(body.checkpoints) || body.checkpoints.length < 1 || body.checkpoints.length > 20) return null;
  const checkpoints = body.checkpoints.map((value) => typeof value === "string" ? value.trim() : "");
  if (checkpoints.some((value) => !value || value.length > 2_000)) return null;
  return {
    expectedVersion: expectedVersion as number | null,
    title: body.title.trim(),
    explanationMarkdown: body.explanationMarkdown.trim(),
    checkpoints,
  };
}

function present(value: StoredOverride) {
  let checkpoints: unknown;
  try {
    checkpoints = JSON.parse(value.checkpointsJson);
  } catch {
    checkpoints = [];
  }
  return {
    qid: value.qid,
    baseContentVersion: value.baseContentVersion,
    title: value.title,
    explanationMarkdown: value.explanationMarkdown,
    checkpoints: Array.isArray(checkpoints) ? checkpoints.filter((item): item is string => typeof item === "string") : [],
    version: value.version,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
}

function json(payload: unknown, status = 200) {
  return Response.json(payload, { status, headers: { "cache-control": "no-store" } });
}

async function readObject(request: Request) {
  try {
    const value: unknown = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function expectedAccountMatches(request: Request, ownerUserId: string) {
  return request.headers.get("x-frontend-atlas-account-id") === ownerUserId;
}

export function createQuestionPrivateOverrideHandlers(
  service: QuestionPrivateOverrideService,
  sessions: SessionReader,
  options: { trustedOriginUrl?: string | null } = {},
) {
  const guardWriteRequest = createWriteRequestGuard(options.trustedOriginUrl === undefined ? process.env.BETTER_AUTH_URL : options.trustedOriginUrl);
  return {
    async read(request: Request, context: HandlerContext) {
      const ownerUserId = await sessions.getUserId(request);
      if (!ownerUserId) return json({ error: "unauthorized" }, 401);
      if (!expectedAccountMatches(request, ownerUserId)) return json({ error: "account_changed" }, 409);
      const { qid } = await context.params;
      const result = service.find(ownerUserId, qid);
      return result.kind === "not-found" ? json({ error: "not_found" }, 404) : json({ override: result.value });
    },

    async save(request: Request, context: HandlerContext) {
      const blocked = guardWriteRequest(request);
      if (blocked) return blocked;
      const ownerUserId = await sessions.getUserId(request);
      if (!ownerUserId) return json({ error: "unauthorized" }, 401);
      if (!expectedAccountMatches(request, ownerUserId)) return json({ error: "account_changed" }, 409);
      const body = await readObject(request);
      if (!body) return json({ error: "invalid_request" }, 400);
      const { qid } = await context.params;
      const result = service.save(ownerUserId, qid, body);
      if (result.kind === "not-found") return json({ error: "not_found" }, 404);
      if (result.kind === "invalid") return json({ error: "invalid_override" }, 400);
      if (result.kind === "conflict") return json({ error: "version_conflict", override: result.current }, 409);
      return json({ override: result.value }, result.value.version === 1 ? 201 : 200);
    },

    async delete(request: Request, context: HandlerContext) {
      const blocked = guardWriteRequest(request);
      if (blocked) return blocked;
      const ownerUserId = await sessions.getUserId(request);
      if (!ownerUserId) return json({ error: "unauthorized" }, 401);
      if (!expectedAccountMatches(request, ownerUserId)) return json({ error: "account_changed" }, 409);
      const body = await readObject(request);
      if (!body) return json({ error: "invalid_request" }, 400);
      const { qid } = await context.params;
      const result = service.delete(ownerUserId, qid, body);
      if (result.kind === "not-found") return json({ error: "not_found" }, 404);
      if (result.kind === "invalid") return json({ error: "invalid_override" }, 400);
      if (result.kind === "conflict") return json({ error: "version_conflict", override: result.current }, 409);
      return json({ deleted: true });
    },
  };
}
