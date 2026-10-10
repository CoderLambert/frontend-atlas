import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openSqliteDatabase } from "../src/lib/db/sqlite.ts";
import { questionChangeProposals, questionProposalReviews, user } from "../src/lib/db/schema.ts";
import { publicQuestionSnapshot, publicQuestionSnapshotSha256 } from "../src/lib/server/question-public-content.ts";
import { prepareQuestionPublication, QuestionPublicationRepository, reconcileQuestionPublication } from "../src/lib/server/question-publication.ts";
import { SiteRoleRepository } from "../src/lib/server/site-roles.ts";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempRoot = mkdtempSync(join(tmpdir(), "frontend-atlas-publication-test-"));
const repoPath = join(tempRoot, "fixture-repo");
const databasePath = join(tempRoot, "publication.sqlite");

function run(command, args, cwd = repoPath, options = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...options.env } });
  if (result.status !== 0 && !options.allowFailure) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function git(...args) {
  return run("git", args).stdout;
}

function setupRepository() {
  mkdirSync(join(repoPath, "src/content"), { recursive: true });
  mkdirSync(join(repoPath, "scripts"), { recursive: true });
  cpSync(join(projectRoot, "src/content"), join(repoPath, "src/content"), { recursive: true });
  cpSync(join(projectRoot, "scripts/generate-content-index.mjs"), join(repoPath, "scripts/generate-content-index.mjs"));
  cpSync(join(projectRoot, "scripts/content-validation.mjs"), join(repoPath, "scripts/content-validation.mjs"));
  writeFileSync(join(repoPath, "package.json"), JSON.stringify({ name: "frontend-atlas", private: true }, null, 2) + "\n");
  run("git", ["init", "-b", "main"]);
  run("git", ["config", "user.name", "Fixture"]);
  run("git", ["config", "user.email", "fixture@localhost.invalid"]);
  run("git", ["add", "."]);
  run("git", ["commit", "-m", "Fixture baseline"]);
}

setupRepository();
const originalBaseCommit = git("rev-parse", "HEAD");
run("git", ["commit", "--allow-empty", "-m", "Fixture main tip"]);
const cleanHead = git("rev-parse", "HEAD");
const originalMapBytes = readFileSync(join(repoPath, "src/content/knowledge-map.source.json"), "utf8");
const map = JSON.parse(originalMapBytes);
const chapters = JSON.parse(readFileSync(join(repoPath, "src/content/knowledge-chapters.source.json"), "utf8"));
const publicQuestion = map.master_questions[0];
const qid = publicQuestion.qid;
const baseline = publicQuestionSnapshot(publicQuestion);
const baselineHash = publicQuestionSnapshotSha256(baseline);
const contentVersion = chapters.content_version;

function currentPublicState() {
  const currentMap = JSON.parse(readFileSync(join(repoPath, "src/content/knowledge-map.source.json"), "utf8"));
  const currentChapters = JSON.parse(readFileSync(join(repoPath, "src/content/knowledge-chapters.source.json"), "utf8"));
  const question = currentMap.master_questions.find((item) => item.qid === qid)
    ?? currentMap.company_questions.find((item) => item.qid === qid);
  const snapshot = publicQuestionSnapshot(question);
  return {
    snapshot,
    hash: publicQuestionSnapshotSha256(snapshot),
    contentVersion: currentChapters.content_version,
  };
}

const opened = openSqliteDatabase(databasePath);
try {
  migrate(opened.db, { migrationsFolder: join(projectRoot, "src/lib/db/migrations") });
  const now = new Date("2026-10-09T12:00:00.000Z");
  opened.db.insert(user).values([
    { id: "owner", name: "Owner", email: "owner@example.test", createdAt: now, updatedAt: now },
    { id: "reviewer", name: "Reviewer", email: "reviewer@example.test", createdAt: now, updatedAt: now },
    { id: "operator", name: "Operator", email: "operator@example.test", createdAt: now, updatedAt: now },
    { id: "other", name: "Other", email: "other@example.test", createdAt: now, updatedAt: now },
  ]).run();
  const roles = new SiteRoleRepository(opened.db);
  assert.equal(roles.grant("operator", "operator", "fixture-admin").kind, "granted");
  const publications = new QuestionPublicationRepository(opened.db);
  let sequence = 0;
  const createProposal = ({
    status = "approved",
    hash = baselineHash,
    ownerUserId = "owner",
    baseVersion = contentVersion,
    title,
    explanationMarkdown,
    checkpoints,
  } = {}) => {
    sequence += 1;
    const id = `publication-proposal-${sequence}`;
    const proposal = opened.db.insert(questionChangeProposals).values({
      id,
      ownerUserId,
      qid,
      sourceGenerationId: `generation-${sequence}`,
      sourceOverrideVersion: sequence,
      baseContentVersion: baseVersion,
      baseContentSha256: hash,
      title: title ?? `发布后的题干 ${sequence}`,
      explanationMarkdown: explanationMarkdown ?? `## 发布后的讲解 ${sequence}\n\n仅来自不可变快照。`,
      checkpointsJson: JSON.stringify(checkpoints ?? [`发布检查点 ${sequence}`, "保持审计一致"]),
      summary: `发布申请 ${sequence}`,
      status,
      createdAt: new Date(now.getTime() + sequence * 1_000),
      updatedAt: new Date(now.getTime() + sequence * 1_000),
    }).returning().get();
    if (status === "approved") {
      opened.db.insert(questionProposalReviews).values({
        proposalId: id,
        reviewerUserId: "reviewer",
        sourceGenerationId: proposal.sourceGenerationId,
        sourceOverrideVersion: proposal.sourceOverrideVersion,
        baseContentVersion: proposal.baseContentVersion,
        baseContentSha256: proposal.baseContentSha256,
        decision: "approved",
        comment: "fixture approval",
        decidedAt: proposal.updatedAt,
      }).run();
    }
    return proposal;
  };

  const rejected = createProposal({ status: "rejected" });
  assert.equal(prepareQuestionPublication(publications, { repoPath, baseRef: "HEAD", operatorUserId: "operator", proposalId: rejected.id }).kind, "not-approved");
  const withdrawn = createProposal({ status: "withdrawn" });
  assert.equal(prepareQuestionPublication(publications, { repoPath, baseRef: "HEAD", operatorUserId: "operator", proposalId: withdrawn.id }).kind, "not-approved");

  const stale = createProposal({ hash: "stale-public-hash" });
  assert.throws(() => prepareQuestionPublication(publications, { repoPath, baseRef: "HEAD", operatorUserId: "operator", proposalId: stale.id }), /no longer matches the approved base hash/u);
  assert.equal(opened.client.prepare("SELECT count(*) AS n FROM question_publications").get().n, 0);
  assert.equal(readFileSync(join(repoPath, "src/content/knowledge-map.source.json"), "utf8"), originalMapBytes);

  const success = createProposal({ explanationMarkdown: "## HTTP 发布后的讲解\n\n仅来自不可变快照。" });
  writeFileSync(join(repoPath, "dirty-file.txt"), "do not overwrite\n");
  assert.throws(() => prepareQuestionPublication(publications, { repoPath, baseRef: "HEAD", operatorUserId: "operator", proposalId: success.id }), /worktree is dirty/u);
  assert.equal(readFileSync(join(repoPath, "dirty-file.txt"), "utf8"), "do not overwrite\n");
  rmSync(join(repoPath, "dirty-file.txt"));

  assert.throws(() => prepareQuestionPublication(publications, { repoPath, baseRef: originalBaseCommit, operatorUserId: "operator", proposalId: success.id }), /Wrong publication base/u);
  assert.equal(git("rev-parse", "HEAD"), cleanHead);

  const wrongRepo = join(tempRoot, "wrong-repo");
  mkdirSync(join(wrongRepo, "scripts"), { recursive: true });
  mkdirSync(join(wrongRepo, "src/content"), { recursive: true });
  writeFileSync(join(wrongRepo, "package.json"), '{"name":"not-frontend-atlas"}\n');
  run("git", ["init", "-b", "main"], wrongRepo);
  run("git", ["config", "user.name", "Fixture"], wrongRepo);
  run("git", ["config", "user.email", "fixture@localhost.invalid"], wrongRepo);
  run("git", ["add", "."], wrongRepo);
  run("git", ["commit", "-m", "wrong"], wrongRepo);
  assert.throws(() => prepareQuestionPublication(publications, { repoPath: wrongRepo, baseRef: "HEAD", operatorUserId: "operator", proposalId: success.id }), /Wrong repository/u);

  assert.throws(() => prepareQuestionPublication(publications, {
    repoPath,
    baseRef: "HEAD",
    operatorUserId: "operator",
    proposalId: success.id,
    generatorCommand: { command: process.execPath, args: ["-e", "process.exit(7)"] },
  }), /failed/u);
  assert.equal(readFileSync(join(repoPath, "src/content/knowledge-map.source.json"), "utf8"), originalMapBytes, "validation failure leaves canonical source untouched");
  assert.equal(git("branch", "--list", `codex/public-question-${success.id}`), "");
  assert.equal(opened.client.prepare("SELECT count(*) AS n FROM question_publications").get().n, 0);

  let result = prepareQuestionPublication(publications, { repoPath, baseRef: "HEAD", operatorUserId: "operator", proposalId: success.id });
  assert.equal(result.kind, "prepared");
  const publication = result.publication;
  assert.equal(publication.status, "prepared");
  assert.equal(git("rev-parse", publication.branchName), publication.commitSha);
  assert.match(git("log", "-1", "--format=%s", publication.commitSha), new RegExp(success.id, "u"));
  assert.equal(git("rev-parse", "HEAD"), cleanHead, "prepare never checks out or changes the operator worktree");
  assert.equal(git("status", "--porcelain"), "");
  const publishedMap = JSON.parse(git("show", `${publication.commitSha}:src/content/knowledge-map.source.json`));
  const publishedQuestion = publishedMap.master_questions.find((question) => question.qid === qid);
  assert.equal(publishedQuestion.title, success.title);
  assert.equal(publishedQuestion.explanation_markdown, success.explanationMarkdown);
  assert.deepEqual(publishedQuestion.checkpoints, JSON.parse(success.checkpointsJson));
  const publishedIndex = JSON.parse(git("show", `${publication.commitSha}:src/content/question-index.generated.json`));
  assert.equal(publishedIndex.find((item) => item.qid === qid).title, success.title);

  result = prepareQuestionPublication(publications, { repoPath, baseRef: "HEAD", operatorUserId: "operator", proposalId: success.id });
  assert.equal(result.kind, "already-prepared");
  assert.equal(result.publication.commitSha, publication.commitSha);
  assert.equal(opened.client.prepare("SELECT count(*) AS n FROM question_publications").get().n, 1, "repeat prepare creates no second publication");
  assert.equal(git("branch", "--list", publication.branchName).split("\n").filter(Boolean).length, 1);

  result = reconcileQuestionPublication(publications, { repoPath, targetRef: "HEAD", operatorUserId: "operator", proposalId: success.id });
  assert.equal(result.kind, "not-merged");
  run("git", ["merge", "--no-ff", publication.branchName, "-m", `Merge ${publication.branchName}`]);
  const mergeCommit = git("rev-parse", "HEAD");
  result = reconcileQuestionPublication(publications, { repoPath, targetRef: "HEAD", operatorUserId: "operator", proposalId: success.id });
  assert.equal(result.kind, "published");
  assert.equal(result.publication.mergeCommitSha, mergeCommit);
  assert.equal(opened.client.prepare("SELECT status FROM question_change_proposals WHERE id = ?").get(success.id).status, "published");
  result = reconcileQuestionPublication(publications, { repoPath, targetRef: "HEAD", operatorUserId: "operator", proposalId: success.id });
  assert.equal(result.kind, "already-published");
  run("git", ["commit", "--allow-empty", "-m", "Unrelated main commit after publication"]);
  result = reconcileQuestionPublication(publications, { repoPath, targetRef: "HEAD", operatorUserId: "operator", proposalId: success.id });
  assert.equal(result.kind, "already-published");
  assert.equal(result.publication.mergeCommitSha, mergeCommit, "later target commits never rewrite the historical publication audit");

  const caseBase = currentPublicState();
  const caseOnly = createProposal({
    hash: caseBase.hash,
    baseVersion: caseBase.contentVersion,
    title: caseBase.snapshot.title,
    explanationMarkdown: caseBase.snapshot.explanationMarkdown.replace("HTTP", "http"),
    checkpoints: caseBase.snapshot.checkpoints,
  });
  result = prepareQuestionPublication(publications, { repoPath, baseRef: "HEAD", operatorUserId: "operator", proposalId: caseOnly.id });
  assert.equal(result.kind, "prepared", "case-only source changes remain publishable when the lower-cased search index is byte-identical");
  const casePublication = result.publication;
  const caseFiles = git("diff-tree", "--no-commit-id", "--name-only", "-r", casePublication.commitSha).split("\n").filter(Boolean);
  assert.equal(caseFiles.includes("src/content/question-index.generated.json"), false, "unchanged generated files are not required to appear in the commit");
  run("git", ["merge", "--ff-only", casePublication.branchName]);
  const fastForwardCommit = git("rev-parse", "HEAD");
  assert.equal(fastForwardCommit, casePublication.commitSha);
  result = reconcileQuestionPublication(publications, { repoPath, targetRef: "HEAD", operatorUserId: "operator", proposalId: caseOnly.id });
  assert.equal(result.kind, "published");
  assert.equal(result.publication.mergeCommitSha, fastForwardCommit);
  run("git", ["commit", "--allow-empty", "-m", "Post fast-forward target commit"]);
  result = reconcileQuestionPublication(publications, { repoPath, targetRef: "HEAD", operatorUserId: "operator", proposalId: caseOnly.id });
  assert.equal(result.kind, "already-published");
  assert.equal(result.publication.mergeCommitSha, fastForwardCommit, "fast-forward reconciliation stays idempotent after the target advances");

  const conflictBase = currentPublicState();
  const conflictProposal = createProposal({
    hash: conflictBase.hash,
    baseVersion: conflictBase.contentVersion,
    title: `${conflictBase.snapshot.title}（批准版本）`,
    explanationMarkdown: "## 批准版本\n\n合并冲突不得静默丢弃。",
    checkpoints: ["批准版本检查点"],
  });
  result = prepareQuestionPublication(publications, { repoPath, baseRef: "HEAD", operatorUserId: "operator", proposalId: conflictProposal.id });
  assert.equal(result.kind, "prepared");
  const conflictPublication = result.publication;
  run("git", ["switch", conflictPublication.branchName]);
  run("git", ["commit", "--allow-empty", "-m", "Publication branch intermediate commit"]);
  const publicationIntermediate = git("rev-parse", "HEAD");
  run("git", ["switch", "main"]);
  const competingMap = JSON.parse(readFileSync(join(repoPath, "src/content/knowledge-map.source.json"), "utf8"));
  const competingQuestion = competingMap.master_questions.find((item) => item.qid === qid);
  competingQuestion.title = `${conflictBase.snapshot.title}（主线冲突版本）`;
  competingQuestion.explanation_markdown = "## 主线冲突版本\n\n保留主线内容。";
  competingQuestion.checkpoints = ["主线冲突检查点"];
  competingQuestion.content = [{ kind: "paragraph", text: competingQuestion.explanation_markdown }];
  writeFileSync(join(repoPath, "src/content/knowledge-map.source.json"), `${JSON.stringify(competingMap, null, 2)}\n`);
  const competingChapters = JSON.parse(readFileSync(join(repoPath, "src/content/knowledge-chapters.source.json"), "utf8"));
  competingChapters.content_version = `${conflictBase.contentVersion}.main-conflict`;
  writeFileSync(join(repoPath, "src/content/knowledge-chapters.source.json"), `${JSON.stringify(competingChapters, null, 2)}\n`);
  run(process.execPath, ["scripts/generate-content-index.mjs"]);
  run("git", ["add", "src/content"]);
  run("git", ["commit", "-m", "Create a conflicting mainline question version"]);
  run("git", ["merge", "--no-ff", "-X", "ours", conflictPublication.branchName, "-m", "Merge publication while keeping conflicting mainline content"]);
  assert.equal(git("rev-list", "--ancestry-path", "--reverse", `${conflictPublication.commitSha}..HEAD`).split("\n")[0], publicationIntermediate, "the old descendant heuristic would inspect the publication branch intermediate");
  assert.throws(
    () => reconcileQuestionPublication(publications, { repoPath, targetRef: "HEAD", operatorUserId: "operator", proposalId: conflictProposal.id }),
    /does not introduce the approved public snapshot/u,
  );
  assert.deepEqual(opened.client.prepare("SELECT status, merge_commit_sha FROM question_publications WHERE proposal_id = ?").get(conflictProposal.id), {
    status: "prepared",
    merge_commit_sha: null,
  }, "discarding the approved snapshot during conflict resolution never marks it published");
  assert.throws(() => opened.client.prepare("UPDATE question_publications SET merge_commit_sha = ? WHERE proposal_id = ?").run("forged-merge", success.id), /invalid question publication status transition/u);
  assert.throws(() => opened.client.prepare("DELETE FROM question_publications WHERE proposal_id = ?").run(success.id), /audit cannot be deleted/u);

  assert.equal(roles.revoke("operator", "operator", "fixture-admin").kind, "revoked");
  const afterRevoke = createProposal();
  assert.equal(prepareQuestionPublication(publications, { repoPath, baseRef: "HEAD", operatorUserId: "operator", proposalId: afterRevoke.id }).kind, "forbidden");
  assert.equal(opened.client.prepare("SELECT count(*) AS n FROM question_publications WHERE proposal_id = ?").get(afterRevoke.id).n, 0);

  const auditBackupPath = join(tempRoot, "publication-audit-backup.sqlite");
  await opened.client.backup(auditBackupPath);
  chmodSync(auditBackupPath, 0o600);
  const restored = openSqliteDatabase(auditBackupPath);
  try {
    assert.equal(restored.client.prepare("PRAGMA quick_check").pluck().get(), "ok");
    assert.equal(restored.client.prepare("SELECT count(*) AS n FROM question_proposal_reviews").get().n, 5);
    assert.equal(restored.client.prepare("SELECT count(*) AS n FROM question_publications").get().n, 3);
    assert.equal(restored.client.prepare("SELECT count(*) AS n FROM site_role_grants").get().n, 1);
  } finally {
    restored.client.close();
  }

  opened.client.close();
  const reopened = openSqliteDatabase(databasePath);
  try {
    assert.equal(reopened.client.prepare("PRAGMA quick_check").pluck().get(), "ok");
    assert.deepEqual(reopened.client.prepare("SELECT status, commit_sha, merge_commit_sha FROM question_publications WHERE proposal_id = ?").get(success.id), {
      status: "published", commit_sha: publication.commitSha, merge_commit_sha: mergeCommit,
    });
  } finally {
    reopened.client.close();
  }
  process.stdout.write("Question publication Git and reconcile tests passed.\n");
} finally {
  try { opened.client.close(); } catch {}
  rmSync(tempRoot, { recursive: true, force: true });
}
