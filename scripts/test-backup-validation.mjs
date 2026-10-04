import assert from "node:assert/strict";
import { hasMeaningfulDifference, parseBackupText } from "../src/lib/backup.ts";

const knownQids = new Set(["D13"]);
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
assert.equal(valid.backup.attempts.length, 1);
assert.equal(valid.backup.drafts.length, 1);
assert.equal(valid.backup.preferences.length, 1);
assert.deepEqual(valid.unknownQids, []);

const unknownQuestion = { ...attempt, attemptId: "attempt_unknown", qid: "OLD-404" };
const withUnknown = parseBackupText(JSON.stringify(makeBackup({ attempts: [attempt, unknownQuestion] })), knownQids);
assert.equal(withUnknown.backup.attempts.length, 1);
assert.deepEqual(withUnknown.unknownQids, ["OLD-404"]);

assert.throws(() => parseBackupText("not JSON", knownQids), /JSON/);
assert.throws(() => parseBackupText(JSON.stringify(makeBackup({ schemaVersion: 2 })), knownQids), /版本/);
assert.throws(() => parseBackupText(JSON.stringify(makeBackup({ attempts: [attempt, attempt] })), knownQids), /重复/);
assert.throws(() => parseBackupText(JSON.stringify(makeBackup({ attempts: [{ ...attempt, assessments: [{ ...attempt.assessments[0], scores: { point_01: "maybe" } }] }] })), knownQids), /无法识别/);
assert.throws(() => parseBackupText(JSON.stringify(makeBackup({ attempts: [{ ...attempt, assessments: [{ ...attempt.assessments[0], nextReviewOn: "2026-02-31" }] }] })), knownQids), /日期无效/);
assert.throws(() => parseBackupText(JSON.stringify(makeBackup({ attempts: [{ ...attempt, updatedAt: "tomorrow" }] })), knownQids), /时间信息无效/);

assert.equal(hasMeaningfulDifference({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 }), false);
assert.equal(hasMeaningfulDifference({ a: [1, 2] }, { a: [2, 1] }), true);
assert.equal(hasMeaningfulDifference({ a: 1 }, { a: 2 }), true);

console.log("backup validation: 15 assertions passed");
