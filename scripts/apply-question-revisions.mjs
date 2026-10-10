import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateContentArtifacts } from "./generate-content-index.mjs";

export const BASE_COMMIT = "0322bfaac404c6dee7abc28ade7cdb0c40fe63f9";
export const SOURCE_DOCUMENT = "docs/research/question-revisions-20261010.json";
export const SOURCE_DOCUMENT_SHA256 = "55911860b8119523dd4778d1724a2e9faf70a49c03e66843bfbb6c7a45dd55c2";
export const CONTENT_REVISION = "2026-10-10.1";
export const TARGET_QIDS = ["A17", "A16", "A15", "A19", "B17", "A09", "B18", "A20", "B07"];
export const BASELINE_QUESTION_HASHES = {
  A17: "1a7cd3cff8795cdbdf6b690d83b238e1dbf587ec788b2235ea768716211d972e",
  A16: "5de980942687a4d1510ec6c05e3e674c5ef5e93db388bc421d15bb7b9020ed5b",
  A15: "6b373bfea542a89fccfea371e66b8aaea6dc76191fc8fac7be03a0b85b101e0e",
  A19: "3ed0096153f7bbecd1892d27936d03f85154ee5ccd55ab8a196dd292512d77ec",
  B17: "96f0b67fad13dce3da1c644873f41ec10250b937e2d1468c085a17f7b62a8da2",
  A09: "5ef69615f834775126f3cb9590a81d6e299b041af0eec4196d75e8fb3bc31ce1",
  B18: "aa5950cb071adfe129e696c71efcf4eed41fb82d55f852b58efb0a20252d8898",
  A20: "4b0b4a62f69898ad30797c5144bd4263acad6eb26e451d995829f9d461073f1f",
  B07: "1ee0aba60cafab5d727fc73dc1e719fe6038d59c6cd039ca87ca6f19f5fcf35d",
};

const MAP_FILE = "src/content/knowledge-map.source.json";
const CHAPTER_FILE = "src/content/knowledge-chapters.source.json";
const GENERATED_FILES = [
  MAP_FILE,
  CHAPTER_FILE,
  "src/content/question-index.generated.json",
  "src/content/topic-index.generated.json",
  "src/content/content-manifest.generated.json",
];
const ROOT_KEYS = [
  "schemaVersion", "revisionDate", "title", "repositoryBaseline", "originalQuestionSourceCommit",
  "purpose", "previousExportRelationship", "contentReviewStatus", "validationStatus", "boundaries", "records",
];
const RECORD_KEYS = [
  "qid", "title", "fullMarkdown", "revisionDate", "publishedAt", "validationStatus",
  "originalThreadPermalink", "revisionPermalink", "sourceQuestionPermalink", "referenceUrls",
  "contentReviewStatus", "provenance", "fullMarkdownSha256",
];
const PROVENANCE_KEYS = [
  "channelId", "threadTimestamp", "revisionTimestamp", "source", "verifiedAt", "laterReplacementFound",
  "threadReplyCount", "migrationDate", "migrationNotice", "migrationChanges", "originalDraftByteIdentityClaimed",
  "parentContentReviewPassed", "repairReviewDate", "examplesExecuted", "normalization",
];
const MIGRATION_CHANGE_KEYS = ["id", "before", "after", "kind", "reason", "sources", "originalRestoredExactly"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertKeys(value, expected, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), label + " must be an object");
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  assert(JSON.stringify(actual) === JSON.stringify(allowed), label + " contains missing or unexpected fields");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function questionHash(question) {
  return sha256(JSON.stringify(stable(question)));
}

export function normalizeMarkdown(record) {
  const lines = record.fullMarkdown.replace(/\r\n/gu, "\n").split("\n");
  const processOnly = /^修订版（2026-10-09）.*(?:尚未修改题库|全文已复核).*$/u;
  const output = [];
  let removedOpeningTitle = false;
  for (const line of lines) {
    if (!removedOpeningTitle && line.startsWith(record.qid + "｜")) {
      removedOpeningTitle = true;
      continue;
    }
    if (processOnly.test(line)) continue;
    if (/^原讨论线程：/u.test(line)) continue;
    if (/尚未替换 Slack 修订/u.test(line)) continue;
    if (line.endsWith("，也没有修改已交付导出包或导入工具。")) {
      output.push(line.slice(0, -"，也没有修改已交付导出包或导入工具。".length) + "。");
      continue;
    }
    if (line.endsWith("本次没有修改题库、既有导出包或导入工具。")) {
      output.push(line.slice(0, -"本次没有修改题库、既有导出包或导入工具。".length).trimEnd());
      continue;
    }
    if (line.endsWith("未配置网站、运行样例、启动浏览器测试或修改题库。")) {
      output.push(line.slice(0, -"未配置网站、运行样例、启动浏览器测试或修改题库。".length).trimEnd());
      continue;
    }
    if (line.endsWith("未运行浏览器、执行样例、迁移实际数据或修改题库。")) {
      output.push(line.slice(0, -"未运行浏览器、执行样例、迁移实际数据或修改题库。".length).trimEnd());
      continue;
    }
    output.push(line);
  }
  const markdown = output.join("\n").replace(/^\n+|\n+$/gu, "");
  assert(removedOpeningTitle, record.qid + " Markdown has no qid title line to normalize");
  assert(markdown.trim(), record.qid + " Markdown is empty after normalization");
  assert(/NOT_RUN/u.test(markdown), record.qid + " must retain its NOT_RUN statement");
  return markdown;
}

export function extractCheckpoints(markdown, qid, { includeA15AssessmentPostscript = false } = {}) {
  const lines = markdown.split("\n");
  const headingIndex = lines.findIndex((line) =>
    /^[一二三四五六七八九十]+、/u.test(line) && /自评|检查点|判定标准/u.test(line));
  assert(headingIndex >= 0, qid + " has no explicit self-assessment section");
  let end = headingIndex + 1;
  const a15Postscript = includeA15AssessmentPostscript ? "" : "|评估时也要分开看：";
  const postscript = new RegExp("^(?:实际核读的一手资料|实际核对的一手资料|实际核查的一手资料|参考资料(?:来源)?|参考文献|Sources|References|能够说清每个条件|本题的掌握标准|自评合格的核心|本次(?:修订|保留原稿)" + a15Postscript + ")", "iu");
  while (end < lines.length && !/^[一二三四五六七八九十]+、/u.test(lines[end]) && !postscript.test(lines[end])) end += 1;
  const checkpoints = [];
  for (let index = headingIndex + 1; index < end; index += 1) {
    const item = lines[index].match(/^\s*(\d+)[.、）)]\s*(.*)$/u);
    if (item) checkpoints.push(item[2]);
    else if (checkpoints.length) checkpoints[checkpoints.length - 1] += "\n" + lines[index];
  }
  const cleaned = checkpoints.map((text) => text.trim()).filter(Boolean);
  assert(cleaned.length > 0 && cleaned.length <= 20, qid + " self-assessment must contain 1–20 complete checks");
  assert(cleaned.every((text) => text.length <= 2_000), qid + " contains a self-assessment check over 2,000 characters");
  return cleaned;
}

function markdownToBlocks(markdown) {
  const blocks = [];
  let paragraph = [];
  let code = null;
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join("\n").trim() });
    paragraph = [];
  };
  for (const line of markdown.split("\n")) {
    const fence = line.match(/^\s*\x60\x60\x60([^\s\x60]*)\s*$/u);
    if (fence && code === null) {
      flushParagraph();
      code = { language: fence[1] || "text", lines: [] };
      continue;
    }
    if (fence && code) {
      blocks.push({ kind: "code", language: code.language, text: code.lines.join("\n") });
      code = null;
      continue;
    }
    if (code) {
      code.lines.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/u);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", text: heading[2] });
    } else if (!line.trim()) {
      flushParagraph();
    } else {
      paragraph.push(line);
    }
  }
  assert(code === null, "source Markdown contains an unclosed fenced code block");
  flushParagraph();
  return blocks;
}

function cleanMigrationNotice(notice) {
  if (!notice) return null;
  return notice
    .replace(/本次迁移修正已通过完整内容复核，尚未替换 Slack 修订。/gu, "迁移修正通过完整内容复核。")
    .replace(/迁移说明（2026-10-10）：/u, "")
    .trim();
}

function buildProvenance(record) {
  return {
    document: SOURCE_DOCUMENT,
    documentSha256: SOURCE_DOCUMENT_SHA256,
    recordMarkdownSha256: record.fullMarkdownSha256,
    revisionDate: record.revisionDate,
    contentReviewStatus: record.contentReviewStatus,
    validationStatus: record.validationStatus,
    parentContentReviewPassed: record.provenance.parentContentReviewPassed,
    originalDraftByteIdentityClaimed: record.provenance.originalDraftByteIdentityClaimed,
    examplesExecuted: record.provenance.examplesExecuted,
    migration: {
      date: record.provenance.migrationDate,
      notice: cleanMigrationNotice(record.provenance.migrationNotice),
      changes: record.provenance.migrationChanges.map(({ id, kind, reason, originalRestoredExactly }) => ({
        id, kind, reason, originalRestoredExactly,
      })),
      repairReviewDate: record.provenance.repairReviewDate,
    },
  };
}

function validateDocument(document, rawBytes) {
  assertKeys(document, ROOT_KEYS, "research document");
  assert(document.schemaVersion === "frontend-atlas-question-revision-research/v1", "unsupported research document schema");
  assert(document.repositoryBaseline === BASE_COMMIT, "research document targets a different repository baseline");
  assert(document.contentReviewStatus === "PARENT_CONTENT_REVIEW_PASSED", "parent full-content review is not recorded");
  assert(document.validationStatus === "NOT_RUN", "research validation status changed unexpectedly");
  assert(Array.isArray(document.records) && document.records.length === TARGET_QIDS.length, "research document must contain exactly nine records");
  const seen = new Set();
  for (const record of document.records) {
    assertKeys(record, RECORD_KEYS, "record " + (record.qid || "unknown"));
    assert(TARGET_QIDS.includes(record.qid), "unknown qid in research document: " + record.qid);
    assert(!seen.has(record.qid), "duplicate qid in research document: " + record.qid);
    seen.add(record.qid);
    assert(typeof record.fullMarkdown === "string" && record.fullMarkdown.trim(), record.qid + " Markdown is empty");
    assert(sha256(Buffer.from(record.fullMarkdown, "utf8")) === record.fullMarkdownSha256, record.qid + " Markdown SHA-256 mismatch");
    assert(record.validationStatus === "NOT_RUN", record.qid + " has unexpected execution status");
    assert(record.contentReviewStatus === "PARENT_CONTENT_REVIEW_PASSED", record.qid + " is not fully reviewed");
    assertKeys(record.provenance, PROVENANCE_KEYS, record.qid + " provenance");
    assert(Array.isArray(record.provenance.migrationChanges), record.qid + " migrationChanges must be an array");
    assert(record.provenance.parentContentReviewPassed === true, record.qid + " is not recorded as fully reviewed");
    assert(record.provenance.originalDraftByteIdentityClaimed === false, record.qid + " must not claim original-byte recovery");
    assert(record.provenance.examplesExecuted === false, record.qid + " examples must remain NOT_RUN");
    for (const change of record.provenance.migrationChanges) assertKeys(change, MIGRATION_CHANGE_KEYS, record.qid + " migration change");
    if (record.qid === "B07" || record.qid === "B17") {
      assert(record.provenance.parentContentReviewPassed === true, record.qid + " requires parent full-content review");
    }
  }
  assert([...seen].sort().join(",") === [...TARGET_QIDS].sort().join(","), "research document qid set does not match the approved nine");
  assert(sha256(rawBytes) === SOURCE_DOCUMENT_SHA256, "research document SHA-256 mismatch");
}

function locateQuestion(map, qid) {
  const matches = map.master_questions.filter((question) => question.qid === qid);
  assert(matches.length === 1, qid + " must identify exactly one canonical master question");
  return matches[0];
}

function recordIsApplied(question, record, markdown, checkpoints, title) {
  return question.content_revision === CONTENT_REVISION
    && question.title === title
    && JSON.stringify(question.content) === JSON.stringify(markdownToBlocks(markdown))
    && question.explanation_markdown === markdown
    && JSON.stringify(question.checkpoints) === JSON.stringify(checkpoints)
    && JSON.stringify(question.source?.revisionProvenance) === JSON.stringify(buildProvenance(record));
}

function recordIsLegacyA15Applied(question, record, markdown, title) {
  return record.qid === "A15"
    && question.content_revision === CONTENT_REVISION
    && question.title === title
    && JSON.stringify(question.content) === JSON.stringify(markdownToBlocks(markdown))
    && question.explanation_markdown === markdown
    && JSON.stringify(question.checkpoints) === JSON.stringify(extractCheckpoints(markdown, record.qid, { includeA15AssessmentPostscript: true }))
    && JSON.stringify(question.source?.revisionProvenance) === JSON.stringify(buildProvenance(record));
}

export function prepareRevisionBatch({ rootDir, sourcePath } = {}) {
  const root = path.resolve(rootDir || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const inputPath = path.resolve(sourcePath || path.join(root, SOURCE_DOCUMENT));
  const raw = fs.readFileSync(inputPath);
  const document = JSON.parse(raw.toString("utf8"));
  validateDocument(document, raw);
  const fileBytes = new Map(GENERATED_FILES.map((file) => [file, fs.readFileSync(path.join(root, file))]));
  const fileHashes = new Map([...fileBytes].map(([file, bytes]) => [file, sha256(bytes)]));
  const map = JSON.parse(fileBytes.get(MAP_FILE).toString("utf8"));
  const chapters = JSON.parse(fileBytes.get(CHAPTER_FILE).toString("utf8"));
  const plan = [];
  for (const record of document.records) {
    const question = locateQuestion(map, record.qid);
    const markdown = normalizeMarkdown(record);
    const checkpoints = extractCheckpoints(markdown, record.qid);
    const title = record.title.replace(new RegExp("^" + record.qid + "[｜|]\\s*"), "");
    assert(title, record.qid + " title is empty");
    const currentlyApplied = recordIsApplied(question, record, markdown, checkpoints, title);
    const legacyA15Applied = !currentlyApplied && recordIsLegacyA15Applied(question, record, markdown, title);
    const currentHash = questionHash(question);
    if (!currentlyApplied && !legacyA15Applied && currentHash !== BASELINE_QUESTION_HASHES[record.qid]) {
      throw new Error(record.qid + " baseline mismatch; refusing to overwrite a newer or divergent question");
    }
    if (!currentlyApplied && !legacyA15Applied) {
      assert(question.content_revision === undefined, record.qid + " has an unexpected content revision");
      assert(Array.isArray(question.content) && question.content.length > 0, record.qid + " baseline content is missing");
    }
    plan.push({ record, question, markdown, checkpoints, title, currentHash, alreadyApplied: currentlyApplied, legacyA15Applied });
  }
  for (const item of plan) {
    const references = chapters.chapters.flatMap((chapter) => chapter.question_references || []).filter((reference) => reference.qid === item.record.qid);
    assert(references.length === 1, item.record.qid + " must have exactly one chapter question reference");
    if (item.alreadyApplied || item.legacyA15Applied) assert(references[0].title === item.title, item.record.qid + " chapter reference differs from the applied title");
  }
  return { root, map, chapters, plan, fileHashes, allAlreadyApplied: plan.every((item) => item.alreadyApplied) };
}

function applyPlan(prepared) {
  const { chapters, plan } = prepared;
  if (prepared.allAlreadyApplied) return prepared;
  for (const item of plan) {
    if (item.alreadyApplied) continue;
    const { question, record, markdown, checkpoints, title } = item;
    question.title = title;
    question.content = markdownToBlocks(markdown);
    question.explanation_markdown = markdown;
    question.checkpoints = checkpoints;
    question.content_revision = CONTENT_REVISION;
    question.source = {
      ...question.source,
      revisionProvenance: buildProvenance(record),
    };
    let references = 0;
    for (const chapter of chapters.chapters) {
      for (const reference of chapter.question_references || []) {
        if (reference.qid === record.qid) {
          reference.title = title;
          references += 1;
        }
      }
    }
    assert(references === 1, record.qid + " must have exactly one chapter question reference");
  }
  return prepared;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function installArtifacts(root, stageDir, candidateDir, expectedHashes, failAfterRenames = null, afterInstallForTest = null) {
  const installHashes = new Map(expectedHashes);
  const candidateHashes = new Map(GENERATED_FILES.map((file) => [
    file,
    sha256(fs.readFileSync(path.join(candidateDir, path.basename(file)))),
  ]));
  assertGeneratedFilesUnchanged(root, expectedHashes);
  const backupDir = path.join(stageDir, "backup");
  fs.mkdirSync(backupDir);
  for (const file of GENERATED_FILES) {
    const original = path.join(root, file);
    fs.copyFileSync(original, path.join(backupDir, path.basename(file)));
  }
  const moved = [];
  try {
    for (const [index, file] of GENERATED_FILES.entries()) {
      assertGeneratedFilesUnchanged(root, installHashes);
      const destination = path.join(root, file);
      const backup = path.join(backupDir, path.basename(file));
      const candidate = path.join(candidateDir, path.basename(file));
      fs.renameSync(destination, path.join(backupDir, "installed-" + index));
      moved.push({ file, destination, backup, candidateHash: candidateHashes.get(file), candidateInstalled: false });
      fs.renameSync(candidate, destination);
      moved[moved.length - 1].candidateInstalled = true;
      installHashes.set(file, candidateHashes.get(file));
      afterInstallForTest?.({ root, file, index });
      if (failAfterRenames === index + 1) throw new Error("simulated atomic install failure");
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of moved.reverse()) {
      try {
        if (fs.existsSync(item.destination)) {
          const currentHash = sha256(fs.readFileSync(item.destination));
          if (currentHash !== item.candidateHash) {
            rollbackErrors.push(item.file + " changed during rollback; preserved current destination and backup");
            continue;
          }
          fs.rmSync(item.destination);
        } else if (item.candidateInstalled) {
          rollbackErrors.push(item.file + " disappeared during rollback; preserved absence and backup");
          continue;
        }
        if (fs.existsSync(item.backup)) fs.renameSync(item.backup, item.destination);
      } catch (rollbackError) {
        rollbackErrors.push(item.file + ": " + (rollbackError instanceof Error ? rollbackError.message : String(rollbackError)));
      }
    }
    if (rollbackErrors.length) {
      throw new Error("install failed and rollback was incomplete; manual recovery required. Conflicting destinations were preserved. Recovery stage retained at " + stageDir + " (backups at " + backupDir + "). Details: " + rollbackErrors.join("; ") + ". Original error: " + (error instanceof Error ? error.message : String(error)));
    }
    throw error;
  }
}

function assertGeneratedFilesUnchanged(root, expectedHashes) {
  for (const file of GENERATED_FILES) {
    const currentHash = sha256(fs.readFileSync(path.join(root, file)));
    assert(currentHash === expectedHashes.get(file), file + " changed after revision preparation; refusing to overwrite concurrent edits");
  }
}

function acquireRevisionLock(root) {
  const lockPath = path.join(root, ".question-revisions.lock");
  let descriptor;
  try {
    descriptor = fs.openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("question revision import lock exists; another apply may be running or a stale lock needs manual recovery: " + lockPath);
    throw error;
  }
  fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n");
  return () => {
    fs.closeSync(descriptor);
    fs.rmSync(lockPath, { force: true });
  };
}

export function applyRevisionBatch({ rootDir, sourcePath, failAfterRenamesForTest = null, beforeInstallForTest = null, afterInstallForTest = null } = {}) {
  const root = path.resolve(rootDir || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const releaseLock = acquireRevisionLock(root);
  try {
    return applyRevisionBatchLocked({ rootDir: root, sourcePath, failAfterRenamesForTest, beforeInstallForTest, afterInstallForTest });
  } finally {
    releaseLock();
  }
}

function applyRevisionBatchLocked({ rootDir, sourcePath, failAfterRenamesForTest, beforeInstallForTest, afterInstallForTest }) {
  const prepared = prepareRevisionBatch({ rootDir, sourcePath });
  if (prepared.allAlreadyApplied) return { status: "already-applied", qids: TARGET_QIDS, writtenFiles: [] };
  applyPlan(prepared);
  const { root, map, chapters } = prepared;
  const stageDir = fs.mkdtempSync(path.join(root, ".question-revisions-stage-"));
  try {
    const candidateDir = path.join(stageDir, "content");
    fs.cpSync(path.join(root, "src/content"), candidateDir, { recursive: true });
    writeJson(path.join(candidateDir, "knowledge-map.source.json"), map);
    writeJson(path.join(candidateDir, "knowledge-chapters.source.json"), chapters);
    generateContentArtifacts({ contentDir: candidateDir, writeFiles: true });
    for (const file of GENERATED_FILES) {
      const candidate = path.join(candidateDir, path.basename(file));
      assert(fs.existsSync(candidate), "candidate generation omitted " + file);
    }
    beforeInstallForTest?.(root);
    installArtifacts(root, stageDir, candidateDir, prepared.fileHashes, failAfterRenamesForTest, afterInstallForTest);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("rollback was incomplete")) {
      fs.rmSync(stageDir, { recursive: true, force: true });
    }
    throw error;
  }
  fs.rmSync(stageDir, { recursive: true, force: true });
  return { status: "applied", qids: TARGET_QIDS, writtenFiles: GENERATED_FILES };
}

function parseArgs(args) {
  const options = { apply: false, rootDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), sourcePath: null };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--apply") options.apply = true;
    else if (args[index] === "--root" && args[index + 1]) options.rootDir = path.resolve(args[++index]);
    else if (args[index] === "--source" && args[index + 1]) options.sourcePath = path.resolve(args[++index]);
    else throw new Error("usage: node scripts/apply-question-revisions.mjs [--apply] [--root DIR] [--source FILE]");
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.apply) {
    const prepared = prepareRevisionBatch(options);
    if (prepared.allAlreadyApplied) {
      console.log(JSON.stringify({ mode: "dry-run", status: "already-applied", qids: TARGET_QIDS }));
      return;
    }
    console.log(JSON.stringify({ mode: "dry-run", status: "validated", qids: TARGET_QIDS, plannedFiles: GENERATED_FILES }));
    return;
  }
  const result = applyRevisionBatch(options);
  console.log(JSON.stringify({ mode: "apply", ...result }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "question revision import failed");
    process.exitCode = 1;
  }
}
