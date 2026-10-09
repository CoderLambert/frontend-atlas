import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openSqliteDatabase } from "../src/lib/db/sqlite.ts";
import { questionChangeProposals, user } from "../src/lib/db/schema.ts";
import { createQuestionChangeProposalHandlers, QuestionChangeProposalRepository, QuestionChangeProposalService } from "../src/lib/server/question-change-proposals.ts";
import { publicQuestionSnapshotSha256 } from "../src/lib/server/question-public-content.ts";
import { createQuestionReviewHandlers, QuestionReviewRepository, QuestionReviewService } from "../src/lib/server/question-review.ts";
import { SiteRoleRepository } from "../src/lib/server/site-roles.ts";
import { coachWriteRequestHeader } from "../src/lib/server/coach/write-request-guard.ts";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempRoot = mkdtempSync(join(tmpdir(), "frontend-atlas-question-review-"));
const databasePath = join(tempRoot, "review.sqlite");
const baseline = { qid: "Q1", title: "公共题干", explanationMarkdown: "## 公共讲解\n\n原始内容。", checkpoints: ["公共检查点"] };
const contentVersion = "content-v1";
const baselineHash = publicQuestionSnapshotSha256(baseline);

function request(userId, method, proposalId = "", body) {
  const headers = new Headers();
  if (userId) headers.set("cookie", `session=${userId}`);
  if (method !== "GET") {
    headers.set("origin", "http://localhost");
    headers.set("content-type", "application/json");
    headers.set(coachWriteRequestHeader.name, coachWriteRequestHeader.value);
  }
  return new Request(`http://localhost/api/reviewer/proposals/${proposalId}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function decisionBody(proposal, decision = "approved", comment = "核对通过。") {
  return {
    decision,
    comment,
    expectedSourceGenerationId: proposal.sourceGenerationId,
    expectedSourceOverrideVersion: proposal.sourceOverrideVersion,
  };
}

function worker(data) {
  const instance = new Worker(new URL("./question-review-worker.mjs", import.meta.url), { workerData: { databasePath, contentVersion, baseline, ...data } });
  let readyResolve;
  let resultResolve;
  let reject;
  const ready = new Promise((resolvePromise, rejectPromise) => { readyResolve = resolvePromise; reject = rejectPromise; });
  const result = new Promise((resolvePromise, rejectPromise) => { resultResolve = resolvePromise; reject = rejectPromise; });
  instance.on("message", (message) => {
    if (message.type === "ready") readyResolve();
    if (message.type === "result") resultResolve(message);
  });
  instance.on("error", reject);
  return { instance, ready, result };
}

const opened = openSqliteDatabase(databasePath);
try {
  migrate(opened.db, { migrationsFolder: join(projectRoot, "src/lib/db/migrations") });
  const now = new Date();
  opened.db.insert(user).values([
    { id: "owner-a", name: "Owner A", email: "owner-a@example.test", createdAt: now, updatedAt: now },
    { id: "owner-b", name: "Owner B", email: "owner-b@example.test", createdAt: now, updatedAt: now },
    { id: "reviewer-a", name: "Reviewer A", email: "reviewer-a@example.test", createdAt: now, updatedAt: now },
    { id: "reviewer-b", name: "Reviewer B", email: "reviewer-b@example.test", createdAt: now, updatedAt: now },
    { id: "normal-user", name: "Normal", email: "normal@example.test", createdAt: now, updatedAt: now },
  ]).run();
  const roles = new SiteRoleRepository(opened.db);
  assert.equal(roles.grant("reviewer-a", "reviewer", "test-admin").kind, "granted");
  assert.equal(roles.grant("reviewer-b", "reviewer", "test-admin").kind, "granted");
  assert.equal(roles.grant("reviewer-a", "reviewer", "test-admin").kind, "already-active");

  let sequence = 0;
  const createProposal = (ownerUserId, overrides = {}) => {
    const id = `proposal-${++sequence}`;
    return opened.db.insert(questionChangeProposals).values({
      id,
      ownerUserId,
      qid: "Q1",
      sourceGenerationId: `generation-${sequence}`,
      sourceOverrideVersion: 1,
      baseContentVersion: contentVersion,
      baseContentSha256: baselineHash,
      title: `改进题干 ${sequence}`,
      explanationMarkdown: `## 改进讲解 ${sequence}\n\n新内容。`,
      checkpointsJson: JSON.stringify([`检查点 ${sequence}`]),
      summary: `申请摘要 ${sequence}`,
      status: "submitted",
      createdAt: new Date(now.getTime() + sequence),
      updatedAt: new Date(now.getTime() + sequence),
      ...overrides,
    }).returning().get();
  };
  const proposal = createProposal("owner-a");

  const sessions = { async getUserId(incoming) { return incoming.headers.get("cookie")?.match(/session=([^;]+)/u)?.[1] ?? null; } };
  const reviewService = new QuestionReviewService(new QuestionReviewRepository(opened.db), contentVersion, new Map([["Q1", baseline]]));
  const handlers = createQuestionReviewHandlers(reviewService, sessions, { trustedOriginUrl: "http://localhost" });

  let response = await handlers.access(request(null, "GET"));
  assert.equal(response.status, 401);
  response = await handlers.list(request("normal-user", "GET"));
  assert.equal(response.status, 403);
  response = await handlers.detail(request("normal-user", "GET", proposal.id), proposal.id);
  assert.equal(response.status, 403);
  response = await handlers.detail(request("normal-user", "GET", "guessed-missing"), "guessed-missing");
  assert.equal(response.status, 403, "unauthorized guessed IDs do not reveal existence");
  response = await handlers.decide(request("normal-user", "POST", proposal.id, { ...decisionBody(proposal), reviewerId: "reviewer-a", operatorId: "reviewer-a", ownerId: "owner-b" }), proposal.id);
  assert.equal(response.status, 403);
  assert.equal(opened.client.prepare("SELECT count(*) AS n FROM question_proposal_reviews").get().n, 0);
  assert.equal(opened.client.prepare("SELECT status FROM question_change_proposals WHERE id = ?").get(proposal.id).status, "submitted");

  response = await handlers.list(request("reviewer-a", "GET"));
  assert.equal(response.status, 200);
  const listBody = await response.json();
  assert.equal(listBody.proposals.length, 1);
  assert.equal(JSON.stringify(listBody).includes("@example.test"), false, "review queue omits email and credential data");
  response = await handlers.detail(request("reviewer-a", "GET", proposal.id), proposal.id);
  assert.equal(response.status, 200);
  const detail = await response.json();
  assert.equal(detail.baseline.sha256, baselineHash);
  assert.equal(detail.diff.title.before, baseline.title);
  assert.equal(detail.diff.title.after, proposal.title);
  assert.equal(detail.diff.explanationMarkdown.changed, true);

  response = await handlers.decide(request("reviewer-a", "POST", proposal.id, { ...decisionBody(proposal), reviewerId: "reviewer-b" }), proposal.id);
  assert.equal(response.status, 400, "forged identity fields are rejected");
  assert.equal(opened.client.prepare("SELECT count(*) AS n FROM question_proposal_reviews").get().n, 0);
  response = await handlers.decide(request("reviewer-a", "POST", proposal.id, decisionBody(proposal)), proposal.id);
  assert.equal(response.status, 201);

  const selfProposal = createProposal("reviewer-a");
  response = await handlers.decide(request("reviewer-a", "POST", selfProposal.id, decisionBody(selfProposal)), selfProposal.id);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "self_review_forbidden");

  const staleProposal = createProposal("owner-a", { baseContentSha256: "stale-hash" });
  response = await handlers.decide(request("reviewer-a", "POST", staleProposal.id, decisionBody(staleProposal)), staleProposal.id);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "public_base_conflict");
  assert.equal(new QuestionChangeProposalRepository(opened.db).withdraw("owner-a", "Q1", staleProposal.id).kind, "withdrawn");

  const expiredAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
  const expiredProposal = createProposal("owner-a", { createdAt: expiredAt, updatedAt: expiredAt });
  response = await handlers.decide(request("reviewer-a", "POST", expiredProposal.id, decisionBody(expiredProposal)), expiredProposal.id);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "proposal_expired");
  assert.equal(new QuestionChangeProposalRepository(opened.db).withdraw("owner-a", "Q1", expiredProposal.id).kind, "withdrawn");

  const concurrentProposal = createProposal("owner-a");
  const reviewers = [
    worker({ mode: "review", userId: "reviewer-a", proposalId: concurrentProposal.id, body: decisionBody(concurrentProposal, "approved", "A decision") }),
    worker({ mode: "review", userId: "reviewer-b", proposalId: concurrentProposal.id, body: decisionBody(concurrentProposal, "rejected", "B decision") }),
  ];
  await Promise.all(reviewers.map((item) => item.ready));
  reviewers.forEach((item) => item.instance.postMessage("start"));
  const concurrent = await Promise.all(reviewers.map((item) => item.result));
  assert.deepEqual(concurrent.map((item) => item.kind).sort(), ["decided", "terminal-conflict"]);
  assert.equal(opened.client.prepare("SELECT count(*) AS n FROM question_proposal_reviews WHERE proposal_id = ?").get(concurrentProposal.id).n, 1);
  const storedReview = opened.client.prepare("SELECT reviewer_user_id, decision, comment FROM question_proposal_reviews WHERE proposal_id = ?").get(concurrentProposal.id);
  response = await handlers.decide(
    request(storedReview.reviewer_user_id, "POST", concurrentProposal.id, decisionBody(concurrentProposal, storedReview.decision, storedReview.comment)),
    concurrentProposal.id,
  );
  assert.equal(response.status, 200, "an exact repeated decision is idempotent");
  assert.equal(opened.client.prepare("SELECT count(*) AS n FROM question_proposal_reviews WHERE proposal_id = ?").get(concurrentProposal.id).n, 1);

  assert.throws(() => opened.client.prepare("UPDATE question_change_proposals SET title = 'tampered' WHERE id = ?").run(concurrentProposal.id), /snapshot is immutable/u);
  assert.throws(() => opened.client.prepare("UPDATE question_proposal_reviews SET comment = 'tampered' WHERE proposal_id = ?").run(concurrentProposal.id), /review is immutable/u);

  const raceProposal = createProposal("owner-a");
  const racers = [
    worker({ mode: "review", userId: "reviewer-a", proposalId: raceProposal.id, body: decisionBody(raceProposal, "approved", "race review") }),
    worker({ mode: "withdraw", userId: "owner-a", proposalId: raceProposal.id }),
  ];
  await Promise.all(racers.map((item) => item.ready));
  racers.forEach((item) => item.instance.postMessage("start"));
  const race = await Promise.all(racers.map((item) => item.result));
  assert.equal(race.filter((item) => item.kind === "decided" || item.kind === "withdrawn").length, 1, "withdrawal and approval produce exactly one terminal winner");
  assert.equal(["approved", "withdrawn"].includes(opened.client.prepare("SELECT status FROM question_change_proposals WHERE id = ?").get(raceProposal.id).status), true);

  const ownerHandlers = createQuestionChangeProposalHandlers(
    new QuestionChangeProposalService(new QuestionChangeProposalRepository(opened.db), new Set(["Q1"]), contentVersion, new Map([["Q1", baselineHash]])),
    sessions,
    { trustedOriginUrl: "http://localhost" },
  );
  response = await ownerHandlers.read(new Request("http://localhost", { headers: { cookie: "session=owner-b", "x-frontend-atlas-account-id": "owner-b" } }), { params: Promise.resolve({ qid: "Q1" }) });
  assert.equal((await response.json()).history.every((item) => item.id !== proposal.id), true, "owner B cannot see owner A history");

  assert.equal(roles.revoke("reviewer-a", "reviewer", "test-admin").kind, "revoked");
  const postRevoke = createProposal("owner-a");
  response = await handlers.decide(request("reviewer-a", "POST", postRevoke.id, decisionBody(postRevoke)), postRevoke.id);
  assert.equal(response.status, 403);
  assert.equal(opened.client.prepare("SELECT status FROM question_change_proposals WHERE id = ?").get(postRevoke.id).status, "submitted");
  assert.equal(roles.list("reviewer-a").length, 1, "revocation preserves role audit history");

  opened.client.close();
  const reopened = openSqliteDatabase(databasePath);
  try {
    assert.equal(reopened.client.prepare("PRAGMA quick_check").pluck().get(), "ok");
    assert.ok(reopened.client.prepare("SELECT count(*) AS n FROM question_proposal_reviews").get().n >= 1, "review audit survives restart");
  } finally {
    reopened.client.close();
  }
  process.stdout.write("Question review and role tests passed.\n");
} finally {
  try { opened.client.close(); } catch {}
  rmSync(tempRoot, { recursive: true, force: true });
}
