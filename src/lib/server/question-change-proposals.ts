import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.ts";
import { questionChangeProposals, questionChangeProposalSources, questionPrivateOverrides, questionProposalReviews } from "../db/schema.ts";
import type { SessionReader } from "./auth-session.ts";
import { createWriteRequestGuard } from "./coach/write-request-guard.ts";

type Database = BetterSQLite3Database<typeof schema>;
type StoredProposal = typeof questionChangeProposals.$inferSelect;
type StoredOverride = typeof questionPrivateOverrides.$inferSelect;
type HandlerContext = { params: Promise<{ qid: string }> };

type SubmitRequestInput = {
  expectedGenerationId: string;
  expectedVersion: number;
  summary: string;
};

type SubmitInput = SubmitRequestInput & {
  publicContentVersion: string;
  publicContentSha256: string;
};

function isSourceClaimUniqueViolation(cause: unknown) {
  if (!cause || typeof cause !== "object") return false;
  const error = cause as { code?: unknown; message?: unknown };
  return (error.code === "SQLITE_CONSTRAINT_UNIQUE" || error.code === "SQLITE_CONSTRAINT_PRIMARYKEY")
    && typeof error.message === "string"
    && error.message.includes("question_change_proposal_sources.owner_user_id")
    && error.message.includes("question_change_proposal_sources.qid")
    && error.message.includes("question_change_proposal_sources.source_generation_id")
    && error.message.includes("question_change_proposal_sources.source_override_version");
}

function isSqliteBusy(cause: unknown) {
  if (!cause || typeof cause !== "object") return false;
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" && (code === "SQLITE_BUSY" || code === "SQLITE_BUSY_SNAPSHOT");
}

export class QuestionChangeProposalRepository {
  private readonly database: Database;

  constructor(database: Database) {
    this.database = database;
  }

  findActive(ownerUserId: string, qid: string) {
    return this.database.select().from(questionChangeProposals).where(and(
      eq(questionChangeProposals.ownerUserId, ownerUserId),
      eq(questionChangeProposals.qid, qid),
      eq(questionChangeProposals.status, "submitted"),
    )).orderBy(desc(questionChangeProposals.createdAt)).limit(1).all()[0] ?? null;
  }

  listHistory(ownerUserId: string, qid: string) {
    return this.database.select({ proposal: questionChangeProposals, review: questionProposalReviews }).from(questionChangeProposals)
      .leftJoin(questionProposalReviews, eq(questionProposalReviews.proposalId, questionChangeProposals.id)).where(and(
      eq(questionChangeProposals.ownerUserId, ownerUserId),
      eq(questionChangeProposals.qid, qid),
    )).orderBy(desc(questionChangeProposals.createdAt)).limit(20).all();
  }

  submit(ownerUserId: string, qid: string, input: SubmitInput) {
    const readClaimedProposal = () => {
      const claim = this.database.select().from(questionChangeProposalSources).where(and(
        eq(questionChangeProposalSources.ownerUserId, ownerUserId),
        eq(questionChangeProposalSources.qid, qid),
        eq(questionChangeProposalSources.sourceGenerationId, input.expectedGenerationId),
        eq(questionChangeProposalSources.sourceOverrideVersion, input.expectedVersion),
      )).limit(1).all()[0] ?? null;
      if (!claim) return null;
      return this.database.select().from(questionChangeProposals).where(
        eq(questionChangeProposals.id, claim.proposalId),
      ).limit(1).all()[0] ?? null;
    };

    const retryLimit = 3;
    for (let attempt = 0; attempt < retryLimit; attempt += 1) {
      try {
        return this.database.transaction((transaction) => {
          const claim = transaction.select().from(questionChangeProposalSources).where(and(
            eq(questionChangeProposalSources.ownerUserId, ownerUserId),
            eq(questionChangeProposalSources.qid, qid),
            eq(questionChangeProposalSources.sourceGenerationId, input.expectedGenerationId),
            eq(questionChangeProposalSources.sourceOverrideVersion, input.expectedVersion),
          )).limit(1).all()[0] ?? null;
          if (claim) {
            const priorSource = transaction.select().from(questionChangeProposals).where(
              eq(questionChangeProposals.id, claim.proposalId),
            ).limit(1).all()[0];
            if (!priorSource) throw new Error(`Proposal source claim ${claim.proposalId} has no audit row.`);
            if (priorSource.status === "submitted") return { kind: "already-submitted" as const, value: priorSource };
            return priorSource.status === "withdrawn"
              ? { kind: "withdrawn-source" as const, value: priorSource }
              : { kind: "decided-source" as const, value: priorSource };
          }

          const active = transaction.select().from(questionChangeProposals).where(and(
            eq(questionChangeProposals.ownerUserId, ownerUserId),
            eq(questionChangeProposals.qid, qid),
            eq(questionChangeProposals.status, "submitted"),
          )).orderBy(desc(questionChangeProposals.createdAt)).limit(1).all()[0] ?? null;
          if (active) return { kind: "active-conflict" as const, current: active };

          const source = transaction.select().from(questionPrivateOverrides).where(and(
            eq(questionPrivateOverrides.ownerUserId, ownerUserId),
            eq(questionPrivateOverrides.qid, qid),
          )).limit(1).all()[0] ?? null;
          if (!source) return { kind: "override-required" as const };
          if (source.generationId !== input.expectedGenerationId || source.version !== input.expectedVersion) {
            return { kind: "override-conflict" as const, current: source };
          }
          if (source.baseContentVersion !== input.publicContentVersion
            || !source.baseContentSha256
            || source.baseContentSha256 !== input.publicContentSha256) {
            return { kind: "public-base-conflict" as const, current: source };
          }

          const now = new Date();
          const created = transaction.insert(questionChangeProposals).values({
            id: randomUUID(),
            ownerUserId,
            qid,
            sourceGenerationId: source.generationId,
            sourceOverrideVersion: source.version,
            baseContentVersion: source.baseContentVersion,
            baseContentSha256: source.baseContentSha256,
            title: source.title,
            explanationMarkdown: source.explanationMarkdown,
            checkpointsJson: source.checkpointsJson,
            summary: input.summary,
            status: "submitted",
            createdAt: now,
            updatedAt: now,
          }).returning().get();
          transaction.insert(questionChangeProposalSources).values({
            ownerUserId,
            qid,
            sourceGenerationId: source.generationId,
            sourceOverrideVersion: source.version,
            proposalId: created.id,
            claimedAt: now,
          }).run();
          return { kind: "submitted" as const, value: created };
        }, { behavior: "immediate" });
      } catch (cause) {
        if (!isSourceClaimUniqueViolation(cause) && !isSqliteBusy(cause)) throw cause;
        const priorSource = readClaimedProposal();
        if (priorSource) {
          if (priorSource.status === "submitted") return { kind: "already-submitted" as const, value: priorSource };
          return priorSource.status === "withdrawn"
            ? { kind: "withdrawn-source" as const, value: priorSource }
            : { kind: "decided-source" as const, value: priorSource };
        }
        if (attempt === retryLimit - 1) throw cause;
      }
    }
    throw new Error("Proposal submission retry loop ended unexpectedly.");
  }

  withdraw(ownerUserId: string, qid: string, proposalId: string) {
    return this.database.transaction((transaction) => {
      const proposal = transaction.select().from(questionChangeProposals).where(and(
        eq(questionChangeProposals.id, proposalId),
        eq(questionChangeProposals.ownerUserId, ownerUserId),
        eq(questionChangeProposals.qid, qid),
      )).limit(1).all()[0] ?? null;
      if (!proposal) return { kind: "not-found" as const };
      if (proposal.status === "withdrawn") return { kind: "already-withdrawn" as const, value: proposal };
      if (proposal.status !== "submitted") return { kind: "terminal-conflict" as const, value: proposal };
      const now = new Date();
      const withdrawn = transaction.update(questionChangeProposals).set({
        status: "withdrawn",
        updatedAt: now,
        withdrawnAt: now,
      }).where(and(
        eq(questionChangeProposals.id, proposalId),
        eq(questionChangeProposals.status, "submitted"),
      )).returning().get();
      return withdrawn
        ? { kind: "withdrawn" as const, value: withdrawn }
        : { kind: "terminal-conflict" as const, value: proposal };
    }, { behavior: "immediate" });
  }
}

export class QuestionChangeProposalService {
  private readonly repository: QuestionChangeProposalRepository;
  private readonly knownQids: ReadonlySet<string>;
  private readonly publicContentVersion: string;
  private readonly publicContentHashes: ReadonlyMap<string, string>;

  constructor(
    repository: QuestionChangeProposalRepository,
    knownQids: ReadonlySet<string>,
    publicContentVersion: string,
    publicContentHashes: ReadonlyMap<string, string>,
  ) {
    this.repository = repository;
    this.knownQids = knownQids;
    this.publicContentVersion = publicContentVersion;
    this.publicContentHashes = publicContentHashes;
  }

  findActive(ownerUserId: string, qid: string) {
    if (!this.knownQids.has(qid)) return { kind: "not-found" as const };
    const value = this.repository.findActive(ownerUserId, qid);
    const history = this.repository.listHistory(ownerUserId, qid).map(({ proposal, review }) => ({
      ...presentProposal(proposal),
      review: review ? {
        decision: review.decision,
        comment: review.comment,
        decidedAt: review.decidedAt.toISOString(),
      } : null,
    }));
    return { kind: "found" as const, value: value ? presentProposal(value) : null, history };
  }

  submit(ownerUserId: string, qid: string, body: Record<string, unknown>) {
    if (!this.knownQids.has(qid)) return { kind: "not-found" as const };
    const input = validateSubmitInput(body);
    if (!input) return { kind: "invalid" as const };
    const publicContentSha256 = this.publicContentHashes.get(qid);
    if (!publicContentSha256) return { kind: "not-found" as const };
    const result = this.repository.submit(ownerUserId, qid, {
      ...input,
      publicContentVersion: this.publicContentVersion,
      publicContentSha256,
    });
    if (result.kind === "submitted" || result.kind === "already-submitted") {
      return { kind: result.kind, value: presentProposal(result.value) } as const;
    }
    if (result.kind === "withdrawn-source" || result.kind === "decided-source") {
      return { kind: result.kind, value: presentProposal(result.value) } as const;
    }
    if (result.kind === "active-conflict") {
      return { kind: result.kind, current: presentProposal(result.current) } as const;
    }
    if (result.kind === "override-conflict") {
      return { kind: result.kind, current: presentOverride(result.current) } as const;
    }
    return result;
  }

  withdraw(ownerUserId: string, qid: string, body: Record<string, unknown>) {
    if (!this.knownQids.has(qid)) return { kind: "not-found" as const };
    if (!validId(body.proposalId)) return { kind: "invalid" as const };
    const result = this.repository.withdraw(ownerUserId, qid, body.proposalId);
    return result.kind === "withdrawn" || result.kind === "already-withdrawn" || result.kind === "terminal-conflict"
      ? { kind: result.kind, value: presentProposal(result.value) } as const
      : result;
  }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function validateSubmitInput(body: Record<string, unknown>): SubmitRequestInput | null {
  if (!validId(body.expectedGenerationId)) return null;
  if (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1) return null;
  if (typeof body.summary !== "string") return null;
  const summary = body.summary.trim();
  if (!summary || summary.length > 4_000) return null;
  return {
    expectedGenerationId: body.expectedGenerationId,
    expectedVersion: body.expectedVersion as number,
    summary,
  };
}

function parseCheckpoints(checkpointsJson: string) {
  try {
    const value: unknown = JSON.parse(checkpointsJson);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function presentProposal(value: StoredProposal) {
  return {
    id: value.id,
    qid: value.qid,
    sourceGenerationId: value.sourceGenerationId,
    sourceOverrideVersion: value.sourceOverrideVersion,
    baseContentVersion: value.baseContentVersion,
    baseContentSha256: value.baseContentSha256,
    title: value.title,
    explanationMarkdown: value.explanationMarkdown,
    checkpoints: parseCheckpoints(value.checkpointsJson),
    summary: value.summary,
    status: value.status,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
    withdrawnAt: value.withdrawnAt?.toISOString() ?? null,
  };
}

function presentOverride(value: StoredOverride) {
  return {
    qid: value.qid,
    generationId: value.generationId,
    baseContentVersion: value.baseContentVersion,
    title: value.title,
    explanationMarkdown: value.explanationMarkdown,
    checkpoints: parseCheckpoints(value.checkpointsJson),
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

export function createQuestionChangeProposalHandlers(
  service: QuestionChangeProposalService,
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
      const result = service.findActive(ownerUserId, qid);
      return result.kind === "not-found" ? json({ error: "not_found" }, 404) : json({ proposal: result.value, history: result.history });
    },

    async submit(request: Request, context: HandlerContext) {
      const blocked = guardWriteRequest(request);
      if (blocked) return blocked;
      const ownerUserId = await sessions.getUserId(request);
      if (!ownerUserId) return json({ error: "unauthorized" }, 401);
      if (!expectedAccountMatches(request, ownerUserId)) return json({ error: "account_changed" }, 409);
      const body = await readObject(request);
      if (!body) return json({ error: "invalid_request" }, 400);
      const { qid } = await context.params;
      const result = service.submit(ownerUserId, qid, body);
      if (result.kind === "not-found") return json({ error: "not_found" }, 404);
      if (result.kind === "invalid") return json({ error: "invalid_proposal" }, 400);
      if (result.kind === "override-required") return json({ error: "private_override_required" }, 409);
      if (result.kind === "override-conflict") return json({ error: "private_version_conflict", override: result.current }, 409);
      if (result.kind === "public-base-conflict") return json({ error: "public_base_conflict", override: presentOverride(result.current) }, 409);
      if (result.kind === "active-conflict") return json({ error: "active_proposal_exists", proposal: result.current }, 409);
      if (result.kind === "withdrawn-source") return json({ error: "proposal_withdrawn", proposal: result.value }, 409);
      if (result.kind === "decided-source") return json({ error: "proposal_source_processed", proposal: result.value }, 409);
      return json({ proposal: result.value }, result.kind === "submitted" ? 201 : 200);
    },

    async withdraw(request: Request, context: HandlerContext) {
      const blocked = guardWriteRequest(request);
      if (blocked) return blocked;
      const ownerUserId = await sessions.getUserId(request);
      if (!ownerUserId) return json({ error: "unauthorized" }, 401);
      if (!expectedAccountMatches(request, ownerUserId)) return json({ error: "account_changed" }, 409);
      const body = await readObject(request);
      if (!body) return json({ error: "invalid_request" }, 400);
      const { qid } = await context.params;
      const result = service.withdraw(ownerUserId, qid, body);
      if (result.kind === "not-found") return json({ error: "not_found" }, 404);
      if (result.kind === "invalid") return json({ error: "invalid_proposal" }, 400);
      if (result.kind === "terminal-conflict") return json({ error: "proposal_already_processed", proposal: result.value }, 409);
      return json({ proposal: result.value });
    },
  };
}
