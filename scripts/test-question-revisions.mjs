import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyRevisionBatch, prepareRevisionBatch, SOURCE_DOCUMENT, TARGET_QIDS } from "./apply-question-revisions.mjs";
import { publicQuestionSnapshot, publicQuestionSnapshotSha256 } from "../src/lib/server/question-public-content.ts";
import { questionContentVersion } from "../src/lib/question-version.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, SOURCE_DOCUMENT);
const sourceBytes = fs.readFileSync(sourcePath);
const source = JSON.parse(sourceBytes.toString("utf8"));
const contentDir = path.join(root, "src/content");
const baselineFixture = JSON.parse(fs.readFileSync(path.join(root, "scripts/fixtures/question-revisions-baseline.json"), "utf8"));
function baselineContent(name) {
  const current = JSON.parse(fs.readFileSync(path.join(contentDir, name), "utf8"));
  if (name === "knowledge-map.source.json") {
    const baselineQuestions = new Map(baselineFixture.questions.map((question) => [question.qid, question]));
    current.master_questions = current.master_questions.map((question) => baselineQuestions.get(question.qid) ?? question);
  } else if (name === "knowledge-chapters.source.json") {
    const baselineReferences = new Map(baselineFixture.references.map((reference) => [reference.qid, reference]));
    for (const chapter of current.chapters) chapter.question_references = chapter.question_references?.map((reference) => baselineReferences.get(reference.qid) ?? reference);
  }
  return JSON.stringify(current, null, 2) + "\n";
}
const inputHash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
const hashQuestion = (question) => inputHash(JSON.stringify(canonical(question)));
const fileNames = [
  "knowledge-map.source.json",
  "knowledge-chapters.source.json",
  "question-index.generated.json",
  "topic-index.generated.json",
  "content-manifest.generated.json",
];
const expectedCheckpointCounts = { A17: 8, A16: 10, A15: 10, A19: 12, B17: 12, A09: 12, B18: 12, A20: 9, B07: 9 };

function snapshotContentFiles(repo) {
  return new Map(fileNames.map((name) => [name, inputHash(fs.readFileSync(path.join(repo, "src/content", name)))]));
}

function copyFixture(destination) {
  fs.mkdirSync(path.join(destination, "src"), { recursive: true });
  fs.cpSync(contentDir, path.join(destination, "src/content"), { recursive: true });
  fs.writeFileSync(path.join(destination, "src/content/knowledge-map.source.json"), baselineContent("knowledge-map.source.json"));
  fs.writeFileSync(path.join(destination, "src/content/knowledge-chapters.source.json"), baselineContent("knowledge-chapters.source.json"));
  fs.mkdirSync(path.join(destination, "scripts"), { recursive: true });
  for (const name of ["generate-content-index.mjs", "content-validation.mjs"]) {
    fs.copyFileSync(path.join(root, "scripts", name), path.join(destination, "scripts", name));
  }
  fs.mkdirSync(path.join(destination, "docs/research"), { recursive: true });
  fs.copyFileSync(sourcePath, path.join(destination, SOURCE_DOCUMENT));
}

function alteredSource(mutator) {
  const copy = structuredClone(source);
  mutator(copy);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-atlas-revisions-input-"));
  const inputPath = path.join(temp, "source.json");
  fs.writeFileSync(inputPath, JSON.stringify(copy));
  return { temp, inputPath };
}

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-atlas-revisions-test-"));
try {
  const baseMap = JSON.parse(baselineContent("knowledge-map.source.json"));
  const baseChapters = JSON.parse(baselineContent("knowledge-chapters.source.json"));
  const baseById = new Map(baseMap.master_questions.map((question) => [question.qid, question]));
  const baseSnapshots = new Map([...baseById].map(([qid, question]) => [qid, publicQuestionSnapshotSha256(publicQuestionSnapshot(question))]));

  const dryRunRepo = path.join(fixtureDir, "dry-run");
  copyFixture(dryRunRepo);
  const dryBefore = snapshotContentFiles(dryRunRepo);
  const dry = prepareRevisionBatch({ rootDir: dryRunRepo });
  assert.equal(dry.allAlreadyApplied, false);
  assert.equal(dry.plan.length, 9);
  assert.deepEqual(snapshotContentFiles(dryRunRepo), dryBefore, "default dry-run must not write canonical or generated files");
  assert.equal(fs.existsSync(path.join(dryRunRepo, ".question-revisions.lock")), false, "dry-run does not claim the apply lock");

  const failedRepo = path.join(fixtureDir, "rollback");
  copyFixture(failedRepo);
  const failedBefore = snapshotContentFiles(failedRepo);
  assert.throws(() => applyRevisionBatch({ rootDir: failedRepo, failAfterRenamesForTest: 2 }), /simulated atomic install failure/u);
  assert.deepEqual(snapshotContentFiles(failedRepo), failedBefore, "failed multi-file install must roll back every file");
  assert.equal(fs.readdirSync(failedRepo).some((name) => name.startsWith(".question-revisions-stage-")), false);

  const lockedRepo = path.join(fixtureDir, "locked");
  copyFixture(lockedRepo);
  fs.writeFileSync(path.join(lockedRepo, ".question-revisions.lock"), "another apply\n");
  const lockedBefore = snapshotContentFiles(lockedRepo);
  assert.throws(() => applyRevisionBatch({ rootDir: lockedRepo }), /lock exists/u);
  assert.deepEqual(snapshotContentFiles(lockedRepo), lockedBefore, "competing apply must fail before writing");

  const racedRepo = path.join(fixtureDir, "concurrent-edit");
  copyFixture(racedRepo);
  const racedMapPath = path.join(racedRepo, "src/content/knowledge-map.source.json");
  const untouchedQid = JSON.parse(fs.readFileSync(racedMapPath, "utf8")).master_questions.find((question) => !TARGET_QIDS.includes(question.qid)).qid;
  assert.throws(() => applyRevisionBatch({
    rootDir: racedRepo,
    beforeInstallForTest: () => {
      const changed = JSON.parse(fs.readFileSync(racedMapPath, "utf8"));
      changed.master_questions.find((question) => question.qid === untouchedQid).title = "concurrent unrelated edit";
      fs.writeFileSync(racedMapPath, JSON.stringify(changed, null, 2) + "\n");
    },
  }), /changed after revision preparation/u);
  const racedMap = JSON.parse(fs.readFileSync(racedMapPath, "utf8"));
  assert.equal(racedMap.master_questions.find((question) => question.qid === untouchedQid).title, "concurrent unrelated edit", "concurrent unrelated change is preserved");
  assert.equal(racedMap.master_questions.find((question) => question.qid === "A17").content_revision, undefined, "no revision writes occur after a detected race");

  const repo = path.join(fixtureDir, "apply");
  copyFixture(repo);
  const applied = applyRevisionBatch({ rootDir: repo });
  assert.equal(applied.status, "applied");
  assert.deepEqual(applied.qids, TARGET_QIDS);
  assert.equal(fs.existsSync(path.join(repo, ".question-revisions.lock")), false, "successful apply releases its lock");
  const appliedMap = JSON.parse(fs.readFileSync(path.join(repo, "src/content/knowledge-map.source.json"), "utf8"));
  const appliedChapters = JSON.parse(fs.readFileSync(path.join(repo, "src/content/knowledge-chapters.source.json"), "utf8"));
  const appliedIndex = JSON.parse(fs.readFileSync(path.join(repo, "src/content/question-index.generated.json"), "utf8"));
  const appliedManifest = JSON.parse(fs.readFileSync(path.join(repo, "src/content/content-manifest.generated.json"), "utf8"));
  const appliedById = new Map(appliedMap.master_questions.map((question) => [question.qid, question]));
  const changedIds = baseMap.master_questions.filter((question) => hashQuestion(question) !== hashQuestion(appliedById.get(question.qid))).map((question) => question.qid);
  assert.deepEqual(changedIds.sort(), [...TARGET_QIDS].sort(), "only the nine approved master questions may change");
  assert.deepEqual(appliedMap.company_questions, baseMap.company_questions, "company variants must remain unchanged");
  assert.deepEqual(appliedMap.topics, baseMap.topics);
  assert.deepEqual(appliedMap.company_evidence, baseMap.company_evidence);
  assert.deepEqual(appliedMap.boundaries, baseMap.boundaries);
  assert.equal(appliedMap.master_count, baseMap.master_count);
  assert.equal(appliedChapters.content_version, baseChapters.content_version, "global version must not invalidate unrelated attempts");
  assert.equal(appliedManifest.contentVersion, baseChapters.content_version);

  for (const qid of TARGET_QIDS) {
    const question = appliedById.get(qid);
    assert.equal(question.content_revision, "2026-10-10.1");
    assert.ok(question.explanation_markdown.length > 8_000, qid + " complete article was truncated");
    assert.equal(question.checkpoints.length, expectedCheckpointCounts[qid], qid + " self-assessment count matches the reviewed rubric");
    assert.ok(question.checkpoints.every((checkpoint) => checkpoint.length > 0 && checkpoint.length <= 2_000));
    assert.ok(!question.checkpoints.some((checkpoint) => /实际核读的一手资料|实际核对的一手资料|能够说清每个条件|本题的掌握标准|本次修订保留|本次保留原稿/iu.test(checkpoint)), qid + " checkpoints must exclude postscript and source notes");
    assert.equal(question.source.revisionProvenance.documentSha256, "55911860b8119523dd4778d1724a2e9faf70a49c03e66843bfbb6c7a45dd55c2");
    assert.equal(question.source.revisionProvenance.validationStatus, "NOT_RUN");
    assert.equal(question.source.revisionProvenance.parentContentReviewPassed, true);
    assert.ok(!/尚未修改题库|没有修改题库|或修改题库/u.test(question.explanation_markdown), qid + " display body excludes stale import-process notes");
    const changedHash = publicQuestionSnapshotSha256(publicQuestionSnapshot(question));
    assert.notEqual(changedHash, baseSnapshots.get(qid), qid + " snapshot must invalidate stale private/proposal bases");
    const indexEntry = appliedIndex.find((entry) => entry.qid === qid);
    assert.equal(indexEntry.title, question.title);
    assert.ok(indexEntry.searchText.includes(question.checkpoints[0].slice(0, 24).toLocaleLowerCase("zh-CN")));
    const chapterReferences = appliedChapters.chapters.flatMap((chapter) => chapter.question_references).filter((reference) => reference.qid === qid);
    assert.equal(chapterReferences.length, 1);
    assert.equal(chapterReferences[0].title, question.title);
  }

  for (const question of baseMap.master_questions.filter((item) => !TARGET_QIDS.includes(item.qid))) {
    const updated = appliedById.get(question.qid);
    assert.deepEqual(updated, question, question.qid + " fields must remain unchanged");
    assert.equal(publicQuestionSnapshotSha256(publicQuestionSnapshot(updated)), baseSnapshots.get(question.qid));
    assert.equal(questionContentVersion(updated, baseChapters.content_version), baseChapters.content_version);
  }
  for (const qid of TARGET_QIDS) {
    assert.equal(questionContentVersion(appliedById.get(qid), baseChapters.content_version), "2026-10-04.2:2026-10-10.1");
  }

  const b07 = appliedById.get("B07");
  assert.ok(b07.explanation_markdown.includes("你好<strong>林</strong><img src=\"data:,\" onerror=\"window.__xssProbe=1\"><a href=\"https://docs.example.test/guide\">资料</a>"));
  assert.ok(b07.explanation_markdown.includes(String.fromCharCode(96) + "&lt;" + String.fromCharCode(96)));
  assert.ok(b07.explanation_markdown.includes("https://docs.example.test@evil.example.test/guide"));
  assert.ok(b07.explanation_markdown.includes("用户输入 Q"));
  assert.ok(b07.content.some((block) => block.kind === "code" && block.language === "html" && block.text.includes("onerror=\"window.__xssProbe=1\"")));
  assert.ok(b07.source.revisionProvenance.migration.notice.includes("重新编写"));
  assert.equal(b07.source.revisionProvenance.migration.changes[0].originalRestoredExactly, false);
  assert.ok(b07.explanation_markdown.includes("固定原始输入 P（2026-10-10 迁移重写的完整教学样例"));
  assert.ok(b07.explanation_markdown.includes("另设用户输入 Q："));
  assert.ok(b07.explanation_markdown.includes("https://docs.example.test/guide"));

  const b17 = appliedById.get("B17");
  assert.ok(b17.explanation_markdown.includes("Cross-Origin-Opener-Policy: same-origin"));
  assert.ok(b17.explanation_markdown.includes("Cross-Origin-Embedder-Policy: require-corp"));
  assert.ok(b17.explanation_markdown.includes("NOT_RUN"));
  assert.ok(b17.content.some((block) => block.text.includes("Cross-Origin-Opener-Policy: same-origin")));
  const a17 = appliedById.get("A17");
  assert.ok(a17.explanation_markdown.includes("相邻题分工：A01 负责流解码与事件边界"));
  assert.ok(!a17.explanation_markdown.includes("也没有修改已交付导出包或导入工具"));
  assert.ok(a17.explanation_markdown.includes("能够说清每个条件由哪一层判断"));
  const a16 = appliedById.get("A16");
  assert.ok(a16.explanation_markdown.includes("这些资料支持协议、组件与框架的具体边界"));
  assert.ok(a16.explanation_markdown.includes("原稿有关历史不可错配、草稿保留、摘要来源、权限与外部副作用的提醒均保留。"));
  assert.ok(!a16.explanation_markdown.includes("本次没有修改题库"));
  assert.ok(a17.explanation_markdown.includes("实际核读的一手资料，2026-10-09"), "source notes remain in the full article");
  assert.ok(a16.explanation_markdown.includes("实际核读的一手资料，2026-10-09"), "source notes remain in the full article");
  const aiLong = appliedById.get("A20");
  assert.ok(aiLong.explanation_markdown.length > 10_000);
  assert.ok(aiLong.explanation_markdown.includes("AP17"));
  assert.ok(aiLong.explanation_markdown.includes("十、常见追问与完整参考答案"));
  assert.ok(aiLong.explanation_markdown.includes("十一、可手推自评与判定标准"));

  const secondApply = applyRevisionBatch({ rootDir: repo });
  assert.equal(secondApply.status, "already-applied", "repeat apply must not overwrite");
  const allApplied = prepareRevisionBatch({ rootDir: repo });
  assert.equal(allApplied.allAlreadyApplied, true);

  for (const [label, mutate, expected] of [
    ["unknown qid", (doc) => { doc.records[0].qid = "Z99"; }, /unknown qid/u],
    ["duplicate qid", (doc) => { doc.records[1].qid = doc.records[0].qid; }, /duplicate qid/u],
    ["empty body", (doc) => { doc.records[0].fullMarkdown = "  "; }, /Markdown is empty/u],
    ["unexpected field", (doc) => { doc.records[0].rawSlackText = "must not be consumed"; }, /unexpected fields/u],
  ]) {
    const altered = alteredSource(mutate);
    try {
      assert.throws(() => prepareRevisionBatch({ rootDir: dryRunRepo, sourcePath: altered.inputPath }), expected, label + " must be rejected");
    } finally {
      fs.rmSync(altered.temp, { recursive: true, force: true });
    }
  }

  const mismatchRepo = path.join(fixtureDir, "mismatch");
  copyFixture(mismatchRepo);
  const mismatchPath = path.join(mismatchRepo, "src/content/knowledge-map.source.json");
  const mismatchMap = JSON.parse(fs.readFileSync(mismatchPath, "utf8"));
  mismatchMap.master_questions.find((question) => question.qid === "B07").title += " unexpected change";
  fs.writeFileSync(mismatchPath, JSON.stringify(mismatchMap));
  const mismatchBefore = snapshotContentFiles(mismatchRepo);
  assert.throws(() => prepareRevisionBatch({ rootDir: mismatchRepo }), /baseline mismatch/u);
  assert.deepEqual(snapshotContentFiles(mismatchRepo), mismatchBefore, "baseline mismatch must not write files");

  console.log("question revision import tests passed");
} finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}
