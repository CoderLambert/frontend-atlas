import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hasMeaningfulDifference, parseBackupText } from "../src/lib/backup.ts";

const questionIndex = JSON.parse(readFileSync(new URL("../src/content/question-index.generated.json", import.meta.url), "utf8"));
const knownQids = new Set(questionIndex.map((question) => question.qid));
const timestamp = "2026-10-04T16:00:00.000Z";
const attempt = {
  attemptId: "attempt_01",
  qid: "D13",
  contentVersion: "2026-10-04.v1",
  startedAt: timestamp,
  originalAnswer: "先说明任务队列，再说明渲染机会。",
  revisions: [{ revisionId: "revision_01", text: "加入边界条件。", savedAt: timestamp }],
  revealedAt: timestamp,
  skipped: false,
  assessments: [{
    assessmentId: "assessment_01",
    savedAt: timestamp,
    scores: { "point_01": "clear" },
    missingNote: "",
    nextReviewOn: "2026-10-11",
    timeZone: "Etc/UTC",
    revokedAt: null,
    queueDismissedAt: null,
  }],
  updatedAt: timestamp,
};
const draft = { qid: "D13", attemptId: "attempt_01", contentVersion: "2026-10-04.v1", kind: "answer", text: "正在组织回答", savedAt: timestamp };
const preference = { key: "question-bank-density", value: { mode: "comfortable", enabled: true }, updatedAt: timestamp };
const coachConversation = {
  conversationId: "conversation_01",
  qid: "D13",
  attemptId: "attempt_01",
  contentVersion: "2026-10-04.v1",
  mode: "critique",
  model: "synthetic-model",
  userInput: "用事件循环说明这段代码。",
  assistantOutput: "先说明任务队列。",
  status: "complete",
  startedAt: timestamp,
  updatedAt: timestamp,
};
const makeBackup = (overrides = {}) => ({
  schemaVersion: 1,
  exportedAt: timestamp,
  contentSetVersion: "2026-10-04.v1",
  attempts: [attempt],
  drafts: [draft],
  preferences: [preference],
  ...overrides,
});

const valid = parseBackupText(JSON.stringify(makeBackup()), knownQids);
assert.equal(valid.backup.schemaVersion, 2);
assert.equal(valid.backup.attempts.length, 1);
assert.equal(valid.backup.drafts.length, 1);
assert.equal(valid.backup.preferences.length, 1);
assert.deepEqual(valid.backup.coachConversations, []);
assert.deepEqual(valid.unknownQids, []);

const validV2 = parseBackupText(JSON.stringify(makeBackup({ schemaVersion: 2, coachConversations: [coachConversation] })), knownQids);
assert.equal(validV2.backup.coachConversations.length, 1);
assert.equal(validV2.backup.coachConversations[0].assistantOutput, coachConversation.assistantOutput);

const ownedAttempt = { ...attempt, attemptId: "attempt_owner_b", ownerUserId: "user-b", contentVersion: "private-".repeat(20) };
const ownedDraft = { ...draft, ownerUserId: "user-b", attemptId: ownedAttempt.attemptId, contentVersion: ownedAttempt.contentVersion };
const owned = parseBackupText(JSON.stringify(makeBackup({ attempts: [attempt, ownedAttempt], drafts: [draft, ownedDraft] })), knownQids);
assert.equal(owned.backup.attempts[1].ownerUserId, "user-b", "backup preserves verified owner scope");
assert.equal(owned.backup.drafts[1].ownerUserId, "user-b", "same qid in a second account is not a conflict");
assert.throws(() => parseBackupText(JSON.stringify(makeBackup({ attempts: [{ ...attempt, ownerUserId: {} }] })), knownQids), /账号标识/);
assert.throws(() => parseBackupText(JSON.stringify(makeBackup({ drafts: [{ ...draft, ownerUserId: "*bad" }] })), knownQids), /账号标识/);

const legacyAttempt = { ...attempt, attemptId: "attempt_legacy_f01", qid: "F01", contentVersion: "2026-10-04.1" };
const legacyDraft = { ...draft, qid: "F01", attemptId: "attempt_legacy_f01", contentVersion: "2026-10-04.1" };
const legacyImport = parseBackupText(JSON.stringify(makeBackup({
  contentSetVersion: "2026-10-04.1",
  attempts: [legacyAttempt],
  drafts: [legacyDraft],
})), knownQids);
assert.equal(legacyImport.backup.attempts[0].qid, "F01");
assert.equal(legacyImport.backup.attempts[0].contentVersion, "2026-10-04.1");
assert.equal(legacyImport.backup.drafts[0].contentVersion, "2026-10-04.1");
assert.deepEqual(legacyImport.unknownQids, []);

const unknownQuestion = { ...attempt, attemptId: "attempt_unknown", qid: "OLD-404" };
const withUnknown = parseBackupText(JSON.stringify(makeBackup({ attempts: [attempt, unknownQuestion] })), knownQids);
assert.equal(withUnknown.backup.attempts.length, 1);
assert.deepEqual(withUnknown.unknownQids, ["OLD-404"]);

assert.throws(() => parseBackupText("not JSON", knownQids), /JSON/);
assert.throws(() => parseBackupText(JSON.stringify(makeBackup({ schemaVersion: 3 })), knownQids), /版本/);
assert.throws(() => parseBackupText(JSON.stringify(makeBackup({ schemaVersion: 2 })), knownQids), /AI 对话/);
assert.throws(() => parseBackupText(JSON.stringify(makeBackup({ schemaVersion: 2, coachConversations: [{ ...coachConversation, mode: "unknown" }] })), knownQids), /模式/);
assert.throws(() => parseBackupText(JSON.stringify(makeBackup({ schemaVersion: 2, coachConversations: [{ ...coachConversation, userInput: "x".repeat(12_001) }] })), knownQids), /超出允许范围/);
assert.throws(() => parseBackupText(JSON.stringify(makeBackup({ schemaVersion: 2, coachConversations: [coachConversation, coachConversation] })), knownQids), /重复/);
const unknownConversation = { ...coachConversation, conversationId: "conversation_unknown", qid: "OLD-404" };
const conversationWithUnknown = parseBackupText(JSON.stringify(makeBackup({ schemaVersion: 2, coachConversations: [coachConversation, unknownConversation] })), knownQids);
assert.equal(conversationWithUnknown.backup.coachConversations.length, 1);
assert.deepEqual(conversationWithUnknown.unknownQids, ["OLD-404"]);
assert.throws(() => parseBackupText(JSON.stringify(makeBackup({ attempts: [attempt, attempt] })), knownQids), /重复/);
assert.throws(() => parseBackupText(JSON.stringify(makeBackup({ attempts: [{ ...attempt, assessments: [{ ...attempt.assessments[0], scores: { point_01: "maybe" } }] }] })), knownQids), /无法识别/);
assert.throws(() => parseBackupText(JSON.stringify(makeBackup({ attempts: [{ ...attempt, assessments: [{ ...attempt.assessments[0], nextReviewOn: "2026-02-31" }] }] })), knownQids), /日期无效/);
assert.throws(() => parseBackupText(JSON.stringify(makeBackup({ attempts: [{ ...attempt, updatedAt: "tomorrow" }] })), knownQids), /时间信息无效/);

assert.equal(hasMeaningfulDifference({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 }), false);
assert.equal(hasMeaningfulDifference({ a: [1, 2] }, { a: [2, 1] }), true);
assert.equal(hasMeaningfulDifference({ a: 1 }, { a: 2 }), true);

console.log("backup validation: v1 migration and v2 AI conversation records passed; legacy F01 records remain importable");
