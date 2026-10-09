import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.ts";
import {
  questionChangeProposals,
  questionProposalReviews,
  siteRoleGrants,
  user,
  type QuestionReviewDecision,
} from "../db/schema.ts";
import type { SessionReader } from "./auth-session.ts";
import { createWriteRequestGuard } from "./coach/write-request-guard.ts";
import type { PublicQuestionSnapshot } from "./question-public-content.ts";
import { publicQuestionSnapshotSha256 } from "./question-public-content.ts";

type Database = BetterSQLite3Database<typeof schema>;
type StoredProposal = typeof questionChangeProposals.$inferSelect;
type StoredReview = typeof questionProposalReviews.$inferSelect;
type PublicCatalog = ReadonlyMap<string, PublicQuestionSnapshot>;

type DecisionInput = {
  decision: QuestionReviewDecision;
  comment: string;
  expectedSourceGenerationId: string;
  expectedSourceOverrideVersion: number;
};

type Cursor = { createdAt: number; id: string };
export const QUESTION_PROPOSAL_REVIEW_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

function encodeCursor(value: Cursor) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(value: string | null): Cursor | null | "invalid" {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "invalid";
    const item = parsed as Record<string, unknown>;
    if (!Number.isSafeInteger(item.createdAt) || typeof item.id !== "string" || !item.id || item.id.length > 128) return "invalid";
    return { createdAt: item.createdAt as number, id: item.id };
  } catch {
    return "invalid";
  }
}

function parseCheckpoints(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function presentReview(review: StoredReview | null) {
  return review ? {
    decision: review.decision,
    comment: review.comment,
    reviewerUserId: review.reviewerUserId,
    sourceGenerationId: review.sourceGenerationId,
    sourceOverrideVersion: review.sourceOverrideVersion,
    baseContentVersion: review.baseContentVersion,
    baseContentSha256: review.baseContentSha256,
    decidedAt: review.decidedAt.toISOString(),
  } : null;
}

function presentProposal(proposal: StoredProposal) {
  return {
    id: proposal.id,
    qid: proposal.qid,
    ownerUserId: proposal.ownerUserId,
    sourceGenerationId: proposal.sourceGenerationId,
    sourceOverrideVersion: proposal.sourceOverrideVersion,
    baseContentVersion: proposal.baseContentVersion,
    baseContentSha256: proposal.baseContentSha256,
    title: proposal.title,
    explanationMarkdown: proposal.explanationMarkdown,
    checkpoints: parseCheckpoints(proposal.checkpointsJson),
    summary: proposal.summary,
    status: proposal.status,
    createdAt: proposal.createdAt.toISOString(),
    updatedAt: proposal.updatedAt.toISOString(),
    withdrawnAt: proposal.withdrawnAt?.toISOString() ?? null,
  };
}

function markdownDiff(before: string, after: string) {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix
    && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) suffix += 1;
  const lines = [
    ...beforeLines.slice(0, prefix).map((text) => ({ kind: "context" as const, text })),
    ...beforeLines.slice(prefix, beforeLines.length - suffix).map((text) => ({ kind: "remove" as const, text })),
    ...afterLines.slice(prefix, afterLines.length - suffix).map((text) => ({ kind: "add" as const, text })),
    ...(suffix ? beforeLines.slice(beforeLines.length - suffix).map((text) => ({ kind: "context" as const, text })) : []),
  ];
  return { changed: before !== after, lines };
}

function buildTrustedDiff(baseline: PublicQuestionSnapshot, proposal: StoredProposal) {
  const checkpoints = parseCheckpoints(proposal.checkpointsJson);
  return {
    title: { changed: baseline.title !== proposal.title, before: baseline.title, after: proposal.title },
    explanationMarkdown: markdownDiff(baseline.explanationMarkdown, proposal.explanationMarkdown),
    checkpoints: {
      changed: JSON.stringify(baseline.checkpoints) !== JSON.stringify(checkpoints),
      before: baseline.checkpoints,
      after: checkpoints,
    },
  };
}

export class QuestionReviewRepository {
  private readonly database: Database;

  constructor(database: Database) {
    this.database = database;
  }

  hasReviewerRole(userId: string) {
    return Boolean(this.database.select({ id: siteRoleGrants.id }).from(siteRoleGrants).where(and(
      eq(siteRoleGrants.userId, userId),
      eq(siteRoleGrants.role, "reviewer"),
      isNull(siteRoleGrants.revokedAt),
    )).limit(1).all()[0]);
  }

  listSubmitted(cursor: Cursor | null, limit: number) {
    const cursorCondition = cursor ? or(
      lt(questionChangeProposals.createdAt, new Date(cursor.createdAt)),
      and(eq(questionChangeProposals.createdAt, new Date(cursor.createdAt)), lt(questionChangeProposals.id, cursor.id)),
    ) : undefined;
    return this.database.select({
      proposal: questionChangeProposals,
      authorName: user.name,
    }).from(questionChangeProposals).innerJoin(user, eq(questionChangeProposals.ownerUserId, user.id)).where(and(
      eq(questionChangeProposals.status, "submitted"),
      cursorCondition,
    )).orderBy(desc(questionChangeProposals.createdAt), desc(questionChangeProposals.id)).limit(limit + 1).all();
  }

  find(proposalId: string) {
    const row = this.database.select({ proposal: questionChangeProposals, authorName: user.name })
      .from(questionChangeProposals)
      .innerJoin(user, eq(questionChangeProposals.ownerUserId, user.id))
      .where(eq(questionChangeProposals.id, proposalId)).limit(1).all()[0] ?? null;
    if (!row) return null;
    const review = this.database.select().from(questionProposalReviews)
      .where(eq(questionProposalReviews.proposalId, proposalId)).limit(1).all()[0] ?? null;
    return { ...row, review };
  }

  decide(reviewerUserId: string, proposalId: string, input: DecisionInput, currentVersion: string, currentHash: string) {
    return this.database.transaction((transaction) => {
      const role = transaction.select({ id: siteRoleGrants.id }).from(siteRoleGrants).where(and(
        eq(siteRoleGrants.userId, reviewerUserId),
        eq(siteRoleGrants.role, "reviewer"),
        isNull(siteRoleGrants.revokedAt),
      )).limit(1).all()[0];
      if (!role) return { kind: "forbidden" as const };
      const proposal = transaction.select().from(questionChangeProposals)
        .where(eq(questionChangeProposals.id, proposalId)).limit(1).all()[0] ?? null;
      if (!proposal) return { kind: "not-found" as const };
      const priorReview = transaction.select().from(questionProposalReviews)
        .where(eq(questionProposalReviews.proposalId, proposalId)).limit(1).all()[0] ?? null;
      if (priorReview) {
        const idempotent = priorReview.reviewerUserId === reviewerUserId
          && priorReview.decision === input.decision
          && priorReview.comment === input.comment
          && priorReview.sourceGenerationId === input.expectedSourceGenerationId
          && priorReview.sourceOverrideVersion === input.expectedSourceOverrideVersion;
        return idempotent
          ? { kind: "already-decided" as const, proposal, review: priorReview }
          : { kind: "terminal-conflict" as const, proposal, review: priorReview };
      }
      if (proposal.ownerUserId === reviewerUserId) return { kind: "self-review" as const, proposal };
      if (proposal.status !== "submitted") return { kind: "terminal-conflict" as const, proposal, review: null };
      if (proposal.createdAt.getTime() + QUESTION_PROPOSAL_REVIEW_TTL_MS <= Date.now()) {
        return { kind: "expired" as const, proposal };
      }
      if (proposal.sourceGenerationId !== input.expectedSourceGenerationId
        || proposal.sourceOverrideVersion !== input.expectedSourceOverrideVersion) {
        return { kind: "proposal-version-conflict" as const, proposal };
      }
      if (!proposal.baseContentSha256
        || proposal.baseContentVersion !== currentVersion
        || proposal.baseContentSha256 !== currentHash) {
        return { kind: "public-base-conflict" as const, proposal };
      }
      const now = new Date();
      const status = input.decision === "approved" ? "approved" : "rejected";
      const updated = transaction.update(questionChangeProposals).set({ status, updatedAt: now }).where(and(
        eq(questionChangeProposals.id, proposalId),
        eq(questionChangeProposals.status, "submitted"),
      )).returning().get();
      if (!updated) return { kind: "terminal-conflict" as const, proposal, review: null };
      const review = transaction.insert(questionProposalReviews).values({
        proposalId,
        reviewerUserId,
        sourceGenerationId: proposal.sourceGenerationId,
        sourceOverrideVersion: proposal.sourceOverrideVersion,
        baseContentVersion: proposal.baseContentVersion,
        baseContentSha256: proposal.baseContentSha256,
        decision: input.decision,
        comment: input.comment,
        decidedAt: now,
      }).returning().get();
      return { kind: "decided" as const, proposal: updated, review };
    }, { behavior: "immediate" });
  }
}

export class QuestionReviewService {
  private readonly repository: QuestionReviewRepository;
  private readonly publicContentVersion: string;
  private readonly catalog: PublicCatalog;

  constructor(
    repository: QuestionReviewRepository,
    publicContentVersion: string,
    catalog: PublicCatalog,
  ) {
    this.repository = repository;
    this.publicContentVersion = publicContentVersion;
    this.catalog = catalog;
  }

  access(reviewerUserId: string) {
    return this.repository.hasReviewerRole(reviewerUserId) ? { kind: "allowed" as const } : { kind: "forbidden" as const };
  }

  list(reviewerUserId: string, cursorValue: string | null, requestedLimit: number | null) {
    if (!this.repository.hasReviewerRole(reviewerUserId)) return { kind: "forbidden" as const };
    const cursor = decodeCursor(cursorValue);
    if (cursor === "invalid") return { kind: "invalid" as const };
    const limit = requestedLimit === null ? 20 : requestedLimit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) return { kind: "invalid" as const };
    const rows = this.repository.listSubmitted(cursor, limit);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      kind: "listed" as const,
      proposals: page.map(({ proposal, authorName }) => ({
        id: proposal.id,
        qid: proposal.qid,
        title: proposal.title,
        summary: proposal.summary,
        sourceOverrideVersion: proposal.sourceOverrideVersion,
        baseContentVersion: proposal.baseContentVersion,
        createdAt: proposal.createdAt.toISOString(),
        author: { id: proposal.ownerUserId, name: authorName },
        expired: proposal.createdAt.getTime() + QUESTION_PROPOSAL_REVIEW_TTL_MS <= Date.now(),
      })),
      nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: last.proposal.createdAt.getTime(), id: last.proposal.id }) : null,
    };
  }

  detail(reviewerUserId: string, proposalId: string) {
    if (!this.repository.hasReviewerRole(reviewerUserId)) return { kind: "forbidden" as const };
    if (!proposalId || proposalId.length > 128) return { kind: "not-found" as const };
    const row = this.repository.find(proposalId);
    if (!row) return { kind: "not-found" as const };
    const baseline = this.catalog.get(row.proposal.qid);
    if (!baseline) return { kind: "public-question-missing" as const };
    const currentHash = publicQuestionSnapshotSha256(baseline);
    return {
      kind: "found" as const,
      proposal: presentProposal(row.proposal),
      author: { id: row.proposal.ownerUserId, name: row.authorName },
      baseline: { ...baseline, contentVersion: this.publicContentVersion, sha256: currentHash },
      diff: buildTrustedDiff(baseline, row.proposal),
      review: presentReview(row.review),
      conflict: !row.proposal.baseContentSha256
        ? "legacy_base_unverifiable"
        : row.proposal.createdAt.getTime() + QUESTION_PROPOSAL_REVIEW_TTL_MS <= Date.now()
          ? "proposal_expired"
        : row.proposal.baseContentVersion !== this.publicContentVersion || row.proposal.baseContentSha256 !== currentHash
          ? "public_base_changed"
          : null,
    };
  }

  decide(reviewerUserId: string, proposalId: string, body: Record<string, unknown>) {
    // Authorization is deliberately checked before looking up the proposal so an
    // unprivileged caller cannot use guessed IDs as an existence oracle.
    if (!this.repository.hasReviewerRole(reviewerUserId)) return { kind: "forbidden" as const };
    const input = validateDecisionInput(body);
    if (!input) return { kind: "invalid" as const };
    const baselineRow = this.repository.find(proposalId);
    if (!baselineRow) return { kind: "not-found" as const };
    const baseline = this.catalog.get(baselineRow.proposal.qid);
    if (!baseline) return { kind: "public-question-missing" as const };
    const result = this.repository.decide(
      reviewerUserId,
      proposalId,
      input,
      this.publicContentVersion,
      publicQuestionSnapshotSha256(baseline),
    );
    if (result.kind === "decided" || result.kind === "already-decided") {
      return { kind: result.kind, proposal: presentProposal(result.proposal), review: presentReview(result.review) } as const;
    }
    return result;
  }
}

function validateDecisionInput(body: Record<string, unknown>): DecisionInput | null {
  const allowed = new Set(["decision", "comment", "expectedSourceGenerationId", "expectedSourceOverrideVersion"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return null;
  if (body.decision !== "approved" && body.decision !== "rejected") return null;
  if (typeof body.comment !== "string") return null;
  const comment = body.comment.trim();
  if (!comment || comment.length > 4_000) return null;
  if (typeof body.expectedSourceGenerationId !== "string" || !body.expectedSourceGenerationId || body.expectedSourceGenerationId.length > 128) return null;
  if (!Number.isSafeInteger(body.expectedSourceOverrideVersion) || (body.expectedSourceOverrideVersion as number) < 1) return null;
  return {
    decision: body.decision,
    comment,
    expectedSourceGenerationId: body.expectedSourceGenerationId,
    expectedSourceOverrideVersion: body.expectedSourceOverrideVersion as number,
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

export function createQuestionReviewHandlers(
  service: QuestionReviewService,
  sessions: SessionReader,
  options: { trustedOriginUrl?: string | null } = {},
) {
  const guardWriteRequest = createWriteRequestGuard(options.trustedOriginUrl === undefined ? process.env.BETTER_AUTH_URL : options.trustedOriginUrl);
  const authenticate = async (request: Request) => {
    const userId = await sessions.getUserId(request);
    return userId ? { userId } : null;
  };
  return {
    async access(request: Request) {
      const identity = await authenticate(request);
      if (!identity) return json({ error: "unauthorized" }, 401);
      return service.access(identity.userId).kind === "allowed"
        ? json({ reviewer: true })
        : json({ error: "forbidden" }, 403);
    },
    async list(request: Request) {
      const identity = await authenticate(request);
      if (!identity) return json({ error: "unauthorized" }, 401);
      const url = new URL(request.url);
      const limitValue = url.searchParams.get("limit");
      const result = service.list(identity.userId, url.searchParams.get("cursor"), limitValue === null ? null : Number(limitValue));
      if (result.kind === "forbidden") return json({ error: "forbidden" }, 403);
      if (result.kind === "invalid") return json({ error: "invalid_pagination" }, 400);
      return json({ proposals: result.proposals, nextCursor: result.nextCursor });
    },
    async detail(request: Request, proposalId: string) {
      const identity = await authenticate(request);
      if (!identity) return json({ error: "unauthorized" }, 401);
      const result = service.detail(identity.userId, proposalId);
      if (result.kind === "forbidden") return json({ error: "forbidden" }, 403);
      if (result.kind === "not-found") return json({ error: "not_found" }, 404);
      if (result.kind === "public-question-missing") return json({ error: "public_question_missing" }, 409);
      return json(result);
    },
    async decide(request: Request, proposalId: string) {
      const blocked = guardWriteRequest(request);
      if (blocked) return blocked;
      const identity = await authenticate(request);
      if (!identity) return json({ error: "unauthorized" }, 401);
      const body = await readObject(request);
      if (!body) return json({ error: "invalid_request" }, 400);
      const result = service.decide(identity.userId, proposalId, body);
      if (result.kind === "invalid") return json({ error: "invalid_review" }, 400);
      if (result.kind === "forbidden" || result.kind === "self-review") return json({ error: result.kind === "self-review" ? "self_review_forbidden" : "forbidden" }, 403);
      if (result.kind === "not-found") return json({ error: "not_found" }, 404);
      if (result.kind === "public-question-missing") return json({ error: "public_question_missing" }, 409);
      if (result.kind === "public-base-conflict") return json({ error: "public_base_conflict" }, 409);
      if (result.kind === "expired") return json({ error: "proposal_expired" }, 409);
      if (result.kind === "proposal-version-conflict") return json({ error: "proposal_version_conflict" }, 409);
      if (result.kind === "terminal-conflict") return json({ error: "proposal_already_processed" }, 409);
      return json({ proposal: result.proposal, review: result.review }, result.kind === "decided" ? 201 : 200);
    },
  };
}
