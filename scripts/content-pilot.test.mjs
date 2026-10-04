import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertUniqueIds } from "./content-validation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentDir = path.join(root, "src", "content");
const generatedFiles = ["question-index.generated.json", "topic-index.generated.json", "content-manifest.generated.json"];
const readGenerated = () => Object.fromEntries(generatedFiles.map((name) => [name, readFileSync(path.join(contentDir, name), "utf8")]));

test("repeated index generation after the React pilot is deterministic and keeps each new ID once", () => {
  const generator = path.join(root, "scripts", "generate-content-index.mjs");
  const runGenerator = () => {
    const result = spawnSync(process.execPath, [generator], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  };

  runGenerator();
  const first = readGenerated();
  runGenerator();
  assert.deepEqual(readGenerated(), first);

  const questionMap = JSON.parse(readFileSync(path.join(contentDir, "knowledge-map.source.json"), "utf8"));
  const chapterSet = JSON.parse(readFileSync(path.join(contentDir, "knowledge-chapters.source.json"), "utf8"));
  const index = JSON.parse(first["question-index.generated.json"]);
  const topic = questionMap.topics.find((item) => item.topic_id === "K18");
  const chapter = chapterSet.chapters.find((item) => item.topic_id === "K18");
  for (const qid of ["F31", "F32", "F33"]) {
    assert.equal(questionMap.master_questions.filter((item) => item.qid === qid).length, 1);
    assert.equal(index.filter((item) => item.qid === qid && item.kind === "master").length, 1);
    assert.equal(topic.question_ids.filter((item) => item === qid).length, 1);
    assert.equal(chapter.question_ids.filter((item) => item === qid).length, 1);
  }
  assert.equal(questionMap.master_count, questionMap.master_questions.length);
  assert.equal(questionMap.master_count, 214);
  assert.equal(questionMap.company_question_count, 47);
  assert.equal(questionMap.topic_count, 35);
  assert.equal(chapter.exercises.length, 2);
  assert.equal(chapterSet.content_version, "2026-10-04.2");
});

test("a conflicting duplicate question ID is rejected by the content validator", () => {
  assert.throws(
    () => assertUniqueIds([{ qid: "F31" }, { qid: "F31" }], "qid", "master question"),
    /master question IDs must be unique/u,
  );
});
