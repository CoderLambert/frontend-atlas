import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { and, eq, isNull } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.ts";
import { questionChangeProposals, questionProposalReviews, questionPublications, siteRoleGrants } from "../db/schema.ts";
import { publicQuestionSnapshot, publicQuestionSnapshotSha256 } from "./question-public-content.ts";

type Database = BetterSQLite3Database<typeof schema>;
type StoredProposal = typeof questionChangeProposals.$inferSelect;
type StoredPublication = typeof questionPublications.$inferSelect;

const CONTENT_FILES = {
  map: "src/content/knowledge-map.source.json",
  chapters: "src/content/knowledge-chapters.source.json",
  questionIndex: "src/content/question-index.generated.json",
  topicIndex: "src/content/topic-index.generated.json",
  manifest: "src/content/content-manifest.generated.json",
} as const;

const ALLOWED_PUBLICATION_FILES = new Set<string>(Object.values(CONTENT_FILES));

type JsonObject = Record<string, unknown>;

function parseJsonFile(path: string) {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Expected a JSON object in ${path}.`);
  return parsed as JsonObject;
}

function writeJsonFile(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function arrayField(value: JsonObject, field: string) {
  const result = value[field];
  if (!Array.isArray(result)) throw new Error(`Expected ${field} to be an array.`);
  return result as JsonObject[];
}

function stringField(value: JsonObject, field: string) {
  const result = value[field];
  if (typeof result !== "string" || !result) throw new Error(`Expected ${field} to be a non-empty string.`);
  return result;
}

function checkpoints(proposal: StoredProposal) {
  const value: unknown = JSON.parse(proposal.checkpointsJson);
  if (!Array.isArray(value) || !value.length || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new Error("Approved proposal checkpoints are invalid.");
  }
  return value as string[];
}

function safeProposalToken(proposalId: string) {
  const token = proposalId.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 32);
  if (!token) throw new Error("Proposal ID cannot form a safe publication branch name.");
  return token;
}

function publicationVersion(baseVersion: string, proposalId: string) {
  return `${baseVersion}.proposal-${safeProposalToken(proposalId).slice(0, 12)}`;
}

function run(command: string, args: string[], cwd: string, options: { allowFailure?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = `${result.stderr || result.stdout}`.trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : "."}`);
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout.replace(/[\r\n]+$/u, ""),
    stderr: result.stderr.replace(/[\r\n]+$/u, ""),
  };
}

function git(repoPath: string, args: string[], options?: { allowFailure?: boolean; env?: NodeJS.ProcessEnv }) {
  return run("git", args, repoPath, options);
}

function assertRepository(repoPath: string, baseRef: string) {
  const resolved = realpathSync(repoPath);
  const topLevel = realpathSync(git(resolved, ["rev-parse", "--show-toplevel"]).stdout);
  if (topLevel !== resolved) throw new Error("Publication repository path must be the Git top level.");
  const packageJson = parseJsonFile(join(resolved, "package.json"));
  if (packageJson.name !== "frontend-atlas") throw new Error("Wrong repository: package.json is not frontend-atlas.");
  for (const relativePath of [CONTENT_FILES.map, CONTENT_FILES.chapters, "scripts/generate-content-index.mjs"]) {
    if (!existsSync(join(resolved, relativePath))) throw new Error(`Wrong repository: missing ${relativePath}.`);
  }
  if (git(resolved, ["status", "--porcelain", "--untracked-files=all"]).stdout) {
    throw new Error("Refusing publication because the Git worktree is dirty.");
  }
  const baseSha = git(resolved, ["rev-parse", "--verify", `${baseRef}^{commit}`]).stdout;
  const headSha = git(resolved, ["rev-parse", "HEAD"]).stdout;
  if (baseSha !== headSha) throw new Error(`Wrong publication base: HEAD ${headSha} does not equal ${baseRef} ${baseSha}.`);
  return { resolved, baseSha };
}

function findQuestion(map: JsonObject, qid: string) {
  const master = arrayField(map, "master_questions").find((item) => item.qid === qid);
  if (master) return { question: master, kind: "master" as const };
  const company = arrayField(map, "company_questions").find((item) => item.qid === qid);
  return company ? { question: company, kind: "company" as const } : null;
}

function questionSearchText(question: JsonObject) {
  const tags = Array.isArray(question.tags) ? question.tags : [];
  const checkpoints = Array.isArray(question.checkpoints) ? question.checkpoints : [];
  const content = Array.isArray(question.content) ? question.content as JsonObject[] : [];
  return [
    question.qid,
    question.title,
    question.primary,
    question.subtopic,
    question.company,
    ...tags,
    question.explanation_markdown,
    ...checkpoints,
    ...content.filter((block) => block.kind !== "code").map((block) => block.text),
  ].filter(Boolean).join(" ").toLocaleLowerCase("zh-CN");
}

function updateQuestionSources(root: string, proposal: StoredProposal, targetVersion: string) {
  const mapPath = join(root, CONTENT_FILES.map);
  const chaptersPath = join(root, CONTENT_FILES.chapters);
  const map = parseJsonFile(mapPath);
  const chapterSet = parseJsonFile(chaptersPath);
  const located = findQuestion(map, proposal.qid);
  if (!located) throw new Error(`Public question ${proposal.qid} does not exist.`);
  const expectedHash = publicQuestionSnapshotSha256(publicQuestionSnapshot(located.question as never));
  if (!proposal.baseContentSha256 || proposal.baseContentSha256 !== expectedHash) {
    throw new Error(`Public question ${proposal.qid} no longer matches the approved base hash.`);
  }
  const currentVersion = stringField(chapterSet, "content_version");
  if (currentVersion !== proposal.baseContentVersion) {
    throw new Error(`Public content version ${currentVersion} does not match approved base ${proposal.baseContentVersion}.`);
  }

  const proposedCheckpoints = checkpoints(proposal);
  located.question.title = proposal.title;
  located.question.explanation_markdown = proposal.explanationMarkdown;
  located.question.checkpoints = proposedCheckpoints;
  // Keep a complete answer for older readers while the explicit Markdown field
  // is the canonical published representation used by current clients.
  located.question.content = [{ kind: "paragraph", text: proposal.explanationMarkdown }];

  for (const chapter of arrayField(chapterSet, "chapters")) {
    for (const field of ["question_references", "company_references"]) {
      const references = chapter[field];
      if (!Array.isArray(references)) continue;
      for (const reference of references as JsonObject[]) {
        if (reference.qid === proposal.qid) reference.title = proposal.title;
      }
    }
  }
  chapterSet.content_version = targetVersion;
  writeJsonFile(mapPath, map);
  writeJsonFile(chaptersPath, chapterSet);
}

function verifyPublishedTree(repoPath: string, commitSha: string, proposal: StoredProposal, targetVersion: string) {
  const readAtCommit = (relativePath: string) => {
    const raw = git(repoPath, ["show", `${commitSha}:${relativePath}`]).stdout;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error(`Invalid JSON at ${commitSha}:${relativePath}.`);
    return parsed as JsonObject;
  };
  const map = readAtCommit(CONTENT_FILES.map);
  const chapterSet = readAtCommit(CONTENT_FILES.chapters);
  const manifest = readAtCommit(CONTENT_FILES.manifest);
  const index = readAtCommit(CONTENT_FILES.questionIndex);
  const located = findQuestion(map, proposal.qid);
  if (!located) throw new Error("Published Git tree does not contain the proposal question.");
  const snapshot = publicQuestionSnapshot(located.question as never);
  if (snapshot.title !== proposal.title
    || snapshot.explanationMarkdown !== proposal.explanationMarkdown
    || JSON.stringify(snapshot.checkpoints) !== JSON.stringify(checkpoints(proposal))) {
    throw new Error("Published Git tree does not match the approved immutable snapshot.");
  }
  if (chapterSet.content_version !== targetVersion || manifest.contentVersion !== targetVersion) {
    throw new Error("Published Git tree has the wrong target content version.");
  }
  const indexEntry = Array.isArray(index) ? (index as JsonObject[]).find((item) => item.qid === proposal.qid) : null;
  if (!indexEntry || indexEntry.title !== proposal.title || indexEntry.searchText !== questionSearchText(located.question)) {
    throw new Error("Published Git tree has no matching generated question index entry.");
  }
}

function isAncestor(repoPath: string, ancestor: string, descendant: string) {
  return git(repoPath, ["merge-base", "--is-ancestor", ancestor, descendant], { allowFailure: true }).status === 0;
}

function firstTargetCommitWithPublishedTree(
  repoPath: string,
  targetSha: string,
  publicationCommitSha: string,
  proposal: StoredProposal,
  targetContentVersion: string,
) {
  const firstParentHistory = git(repoPath, ["rev-list", "--first-parent", "--reverse", targetSha]).stdout
    .split("\n").filter(Boolean);
  let lower = 0;
  let upper = firstParentHistory.length - 1;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (isAncestor(repoPath, publicationCommitSha, firstParentHistory[middle])) upper = middle;
    else lower = middle + 1;
  }
  const integrationIndex = lower;
  let lastMismatch: unknown = null;
  for (const commitSha of firstParentHistory.slice(integrationIndex)) {
    try {
      verifyPublishedTree(repoPath, commitSha, proposal, targetContentVersion);
      return commitSha;
    } catch (cause) {
      lastMismatch = cause;
    }
  }
  const detail = lastMismatch instanceof Error ? ` Last mismatch: ${lastMismatch.message}` : "";
  throw new Error(`Target first-parent history contains the prepared commit but does not introduce the approved public snapshot.${detail}`);
}

export class QuestionPublicationRepository {
  private readonly database: Database;

  constructor(database: Database) {
    this.database = database;
  }

  hasOperatorRole(userId: string) {
    return Boolean(this.database.select({ id: siteRoleGrants.id }).from(siteRoleGrants).where(and(
      eq(siteRoleGrants.userId, userId),
      eq(siteRoleGrants.role, "operator"),
      isNull(siteRoleGrants.revokedAt),
    )).limit(1).all()[0]);
  }

  find(proposalId: string) {
    const proposal = this.database.select().from(questionChangeProposals)
      .where(eq(questionChangeProposals.id, proposalId)).limit(1).all()[0] ?? null;
    if (!proposal) return null;
    const review = this.database.select().from(questionProposalReviews)
      .where(eq(questionProposalReviews.proposalId, proposalId)).limit(1).all()[0] ?? null;
    const publication = this.database.select().from(questionPublications)
      .where(eq(questionPublications.proposalId, proposalId)).limit(1).all()[0] ?? null;
    return { proposal, review, publication };
  }

  recordPrepared(operatorUserId: string, proposalId: string, prepared: Omit<typeof questionPublications.$inferInsert, "id" | "proposalId" | "operatorUserId" | "status" | "preparedAt">) {
    return this.database.transaction((transaction) => {
      const role = transaction.select({ id: siteRoleGrants.id }).from(siteRoleGrants).where(and(
        eq(siteRoleGrants.userId, operatorUserId), eq(siteRoleGrants.role, "operator"), isNull(siteRoleGrants.revokedAt),
      )).limit(1).all()[0];
      if (!role) return { kind: "forbidden" as const };
      const proposal = transaction.select().from(questionChangeProposals)
        .where(eq(questionChangeProposals.id, proposalId)).limit(1).all()[0] ?? null;
      if (!proposal || proposal.status !== "approved") return { kind: "not-approved" as const };
      const existing = transaction.select().from(questionPublications)
        .where(eq(questionPublications.proposalId, proposalId)).limit(1).all()[0] ?? null;
      if (existing) return { kind: "already-prepared" as const, value: existing };
      const value = transaction.insert(questionPublications).values({
        id: randomUUID(), proposalId, operatorUserId, ...prepared, status: "prepared", preparedAt: new Date(),
      }).returning().get();
      return { kind: "prepared" as const, value };
    }, { behavior: "immediate" });
  }

  markPublished(operatorUserId: string, proposalId: string, mergeCommitSha: string) {
    return this.database.transaction((transaction) => {
      const role = transaction.select({ id: siteRoleGrants.id }).from(siteRoleGrants).where(and(
        eq(siteRoleGrants.userId, operatorUserId), eq(siteRoleGrants.role, "operator"), isNull(siteRoleGrants.revokedAt),
      )).limit(1).all()[0];
      if (!role) return { kind: "forbidden" as const };
      const publication = transaction.select().from(questionPublications)
        .where(eq(questionPublications.proposalId, proposalId)).limit(1).all()[0] ?? null;
      if (!publication) return { kind: "not-prepared" as const };
      if (publication.status === "published") {
        return publication.mergeCommitSha === mergeCommitSha
          ? { kind: "already-published" as const, value: publication }
          : { kind: "merge-conflict" as const, value: publication };
      }
      const now = new Date();
      const updated = transaction.update(questionPublications).set({ status: "published", publishedAt: now, mergeCommitSha })
        .where(and(eq(questionPublications.id, publication.id), eq(questionPublications.status, "prepared"))).returning().get();
      if (!updated) return { kind: "merge-conflict" as const, value: publication };
      const proposal = transaction.update(questionChangeProposals).set({ status: "published", updatedAt: now })
        .where(and(eq(questionChangeProposals.id, proposalId), eq(questionChangeProposals.status, "approved"))).returning().get();
      if (!proposal) throw new Error("Approved proposal changed while publication was reconciled.");
      return { kind: "published" as const, value: updated };
    }, { behavior: "immediate" });
  }
}

export type PreparePublicationOptions = {
  repoPath: string;
  baseRef: string;
  operatorUserId: string;
  proposalId: string;
  generatorCommand?: { command: string; args: string[] };
};

export function prepareQuestionPublication(repository: QuestionPublicationRepository, options: PreparePublicationOptions) {
  if (!repository.hasOperatorRole(options.operatorUserId)) return { kind: "forbidden" as const };
  const candidate = repository.find(options.proposalId);
  if (!candidate) return { kind: "not-found" as const };
  if (candidate.publication) return { kind: "already-prepared" as const, publication: candidate.publication };
  if (candidate.proposal.status !== "approved" || candidate.review?.decision !== "approved") return { kind: "not-approved" as const };

  const { resolved: repoPath, baseSha } = assertRepository(options.repoPath, options.baseRef);
  const branchName = `codex/public-question-${safeProposalToken(options.proposalId)}`;
  if (git(repoPath, ["show-ref", "--verify", `refs/heads/${branchName}`], { allowFailure: true }).status === 0) {
    throw new Error(`Publication branch ${branchName} already exists without a matching audit record.`);
  }
  const targetContentVersion = publicationVersion(candidate.proposal.baseContentVersion, options.proposalId);
  const temporaryRoot = mkdtempSync(join(tmpdir(), "frontend-atlas-publication-"));
  const worktreePath = join(temporaryRoot, "worktree");
  let worktreeAdded = false;
  let branchCreated = false;
  let auditRecorded = false;
  try {
    git(repoPath, ["worktree", "add", "--detach", worktreePath, baseSha]);
    worktreeAdded = true;
    updateQuestionSources(worktreePath, candidate.proposal, targetContentVersion);
    const generator = options.generatorCommand ?? { command: process.execPath, args: ["scripts/generate-content-index.mjs"] };
    run(generator.command, generator.args, worktreePath);
    const changedFiles = git(worktreePath, ["status", "--porcelain", "--untracked-files=all"]).stdout
      .split("\n").filter(Boolean).map((line) => line.slice(3));
    if (changedFiles.some((path) => !ALLOWED_PUBLICATION_FILES.has(path))) {
      throw new Error(`Publication changed an unexpected file set: ${changedFiles.join(", ") || "none"}.`);
    }
    git(worktreePath, ["add", "--", ...Object.values(CONTENT_FILES)]);
    const commitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "Frontend Atlas Operator",
      GIT_AUTHOR_EMAIL: "operator@localhost.invalid",
      GIT_COMMITTER_NAME: "Frontend Atlas Operator",
      GIT_COMMITTER_EMAIL: "operator@localhost.invalid",
      GIT_AUTHOR_DATE: candidate.proposal.updatedAt.toISOString(),
      GIT_COMMITTER_DATE: candidate.proposal.updatedAt.toISOString(),
    };
    git(worktreePath, ["commit", "-m", `Publish question proposal ${options.proposalId}`], { env: commitEnv });
    const commitSha = git(worktreePath, ["rev-parse", "HEAD"]).stdout;
    const committedFiles = git(worktreePath, ["diff-tree", "--no-commit-id", "--name-only", "-r", commitSha]).stdout.split("\n").filter(Boolean);
    if (committedFiles.some((path) => !ALLOWED_PUBLICATION_FILES.has(path))) throw new Error("Publication commit contains unexpected files.");
    verifyPublishedTree(worktreePath, commitSha, candidate.proposal, targetContentVersion);
    git(repoPath, ["branch", branchName, commitSha]);
    branchCreated = true;
    const recorded = repository.recordPrepared(options.operatorUserId, options.proposalId, {
      sourceContentVersion: candidate.proposal.baseContentVersion,
      targetContentVersion,
      branchName,
      commitSha,
    });
    if (recorded.kind !== "prepared" && recorded.kind !== "already-prepared") return recorded;
    if (recorded.value.branchName !== branchName || recorded.value.commitSha !== commitSha) {
      throw new Error("A concurrent publication audit points to a different Git result.");
    }
    auditRecorded = true;
    return { kind: recorded.kind, publication: recorded.value } as const;
  } finally {
    if (worktreeAdded) git(repoPath, ["worktree", "remove", "--force", worktreePath], { allowFailure: true });
    if (branchCreated && !auditRecorded) git(repoPath, ["branch", "-D", branchName], { allowFailure: true });
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export type ReconcilePublicationOptions = {
  repoPath: string;
  targetRef: string;
  operatorUserId: string;
  proposalId: string;
};

export function reconcileQuestionPublication(repository: QuestionPublicationRepository, options: ReconcilePublicationOptions) {
  if (!repository.hasOperatorRole(options.operatorUserId)) return { kind: "forbidden" as const };
  const candidate = repository.find(options.proposalId);
  if (!candidate) return { kind: "not-found" as const };
  if (!candidate.publication) return { kind: "not-prepared" as const };
  const repoPath = realpathSync(options.repoPath);
  const targetSha = git(repoPath, ["rev-parse", "--verify", `${options.targetRef}^{commit}`]).stdout;
  if (!isAncestor(repoPath, candidate.publication.commitSha, targetSha)) {
    return { kind: "not-merged" as const };
  }
  if (candidate.publication.status === "published") {
    const recordedCommitSha = candidate.publication.mergeCommitSha;
    if (!recordedCommitSha) throw new Error("Published audit is missing its immutable target commit.");
    if (!isAncestor(repoPath, recordedCommitSha, targetSha)) return { kind: "not-merged" as const };
    verifyPublishedTree(repoPath, recordedCommitSha, candidate.proposal, candidate.publication.targetContentVersion);
    return { kind: "already-published" as const, publication: candidate.publication };
  }
  const mergeCommitSha = firstTargetCommitWithPublishedTree(
    repoPath,
    targetSha,
    candidate.publication.commitSha,
    candidate.proposal,
    candidate.publication.targetContentVersion,
  );
  const result = repository.markPublished(options.operatorUserId, options.proposalId, mergeCommitSha);
  return result.kind === "published" || result.kind === "already-published"
    ? { kind: result.kind, publication: result.value } as const
    : result;
}

export function presentPublication(value: StoredPublication) {
  return {
    id: value.id,
    proposalId: value.proposalId,
    operatorUserId: value.operatorUserId,
    sourceContentVersion: value.sourceContentVersion,
    targetContentVersion: value.targetContentVersion,
    branchName: value.branchName,
    commitSha: value.commitSha,
    status: value.status,
    preparedAt: value.preparedAt.toISOString(),
    publishedAt: value.publishedAt?.toISOString() ?? null,
    mergeCommitSha: value.mergeCommitSha,
  };
}
