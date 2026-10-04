import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertUniqueIds } from "./content-validation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const contentDir = path.join(projectRoot, "src", "content");
const map = JSON.parse(fs.readFileSync(path.join(contentDir, "knowledge-map.source.json"), "utf8"));
const chapters = JSON.parse(fs.readFileSync(path.join(contentDir, "knowledge-chapters.source.json"), "utf8"));

function assert(condition, message) {
  if (!condition) throw new Error(`Content validation failed: ${message}`);
}

const actualCounts = {
  master: map.master_questions.length,
  company: map.company_questions.length,
  topics: map.topics.length,
  chapters: chapters.chapters.length,
};
assert(map.master_count === actualCounts.master && chapters.master_count === actualCounts.master, "declared master counts must match both content manifests");
assert(map.company_question_count === actualCounts.company && chapters.company_question_count === actualCounts.company, "declared company counts must match both content manifests");
assert(map.topic_count === actualCounts.topics && chapters.topic_count === actualCounts.topics && actualCounts.chapters === actualCounts.topics, "topic and chapter counts must match both content manifests");
assert(chapters.chapters.every((chapter) => Array.isArray(chapter.exercises) && chapter.exercises.length === 2), "every chapter must keep the two-exercise contract");
const exerciseCount = chapters.chapters.reduce((sum, chapter) => sum + chapter.exercises.length, 0);
assert(exerciseCount === actualCounts.chapters * 2, "exercise count must match the two-exercise chapter contract");
assertUniqueIds(map.master_questions, "qid", "master question");
assertUniqueIds(map.company_questions, "qid", "company question");
assertUniqueIds(map.topics, "topic_id", "topic");
assertUniqueIds(chapters.chapters, "topic_id", "chapter");

const masterIds = new Set(map.master_questions.map((question) => question.qid));
const companyIds = new Set(map.company_questions.map((question) => question.qid));
const topicIds = new Set(map.topics.map((topic) => topic.topic_id));
const chapterIds = new Set(chapters.chapters.map((chapter) => chapter.topic_id));
assert([...topicIds].every((id) => chapterIds.has(id)), "topic and chapter IDs must match");
assert(map.master_questions.every((question) => topicIds.has(question.topic_id)), "every master question must map to an existing K chapter");
assert(map.company_questions.every((question) => question.topic_ids.length > 0 && question.topic_ids.every((id) => topicIds.has(id))), "every company variant must map to existing K chapters");
assert(map.company_questions.every((question) => question.master_ids.length > 0 && question.master_ids.every((id) => masterIds.has(id))), "every company variant must map to existing master questions");
assert(map.topics.every((topic) => topic.question_ids.every((id) => masterIds.has(id) || companyIds.has(id))), "topic question references must resolve");
assert(map.master_questions.every((question) => Array.isArray(question.content) && question.content.length > 0), "every master question must retain full answer content");
assert(map.company_questions.every((question) => Array.isArray(question.content) && question.content.length > 0), "every company variant must retain full content");
assert(chapters.chapters.every((chapter) => chapter.mechanisms.length > 0 && chapter.exercises.length === 2), "every chapter needs core content and two exercises");

const d13 = map.master_questions.find((question) => question.qid === "D13");
const k12 = chapters.chapters.find((chapter) => chapter.topic_id === "K12");
assert(d13?.topic_id === "K27", "D13 must remain in K27");
assert(k12?.title === "页面生命周期与调度", "K12's actual title must be retained");

const stripInternalSourceFields = (source = {}) => {
  const safeSource = { ...source };
  delete safeSource.library_file_id;
  return safeSource;
};
const searchText = (question) => [
  question.qid,
  question.title,
  question.primary,
  question.subtopic,
  question.company,
  ...(question.tags ?? []),
  ...(question.content ?? []).filter((block) => block.kind !== "code").map((block) => block.text),
].filter(Boolean).join(" ").toLocaleLowerCase("zh-CN");

const questionIndex = [
  ...map.master_questions.map((question) => ({
    qid: question.qid,
    kind: "master",
    title: question.title,
    topicIds: [question.topic_id],
    primary: question.primary,
    subtopic: question.subtopic,
    tags: question.tags,
    mode: question.mode,
    priority: /P[0-2]/.exec(question.original_metadata ?? "")?.[0] ?? null,
    masterIds: [],
    company: null,
    source: stripInternalSourceFields(question.source),
    searchText: searchText(question),
  })),
  ...map.company_questions.map((question) => ({
    qid: question.qid,
    kind: "company",
    title: question.title,
    topicIds: question.topic_ids,
    primary: map.topics.find((topic) => topic.topic_id === question.topic_ids[0])?.primary ?? "",
    subtopic: map.topics.find((topic) => topic.topic_id === question.topic_ids[0])?.subtopic ?? "",
    tags: [],
    mode: "company-variant",
    priority: null,
    masterIds: question.master_ids,
    company: question.company,
    source: stripInternalSourceFields(question.source),
    searchText: searchText(question),
  })),
].sort((a, b) => a.qid.localeCompare(b.qid, "en"));

const topicIndex = map.topics.map((topic) => ({
  topicId: topic.topic_id,
  primary: topic.primary,
  subtopic: topic.subtopic,
  masterQuestionIds: topic.question_ids,
  companyQuestionIds: map.company_questions.filter((question) => question.topic_ids.includes(topic.topic_id)).map((question) => question.qid),
  prerequisites: chapters.chapters.find((chapter) => chapter.topic_id === topic.topic_id)?.prerequisites ?? [],
  searchText: (() => {
    const chapter = chapters.chapters.find((item) => item.topic_id === topic.topic_id);
    if (!chapter) return (topic.topic_id + " " + topic.primary + " " + topic.subtopic).toLocaleLowerCase("zh-CN");
    const pieces = [topic.topic_id, topic.primary, topic.subtopic, chapter.mental_model, chapter.oral_summary];
    pieces.push(...chapter.mechanisms.flatMap((item) => [item.title, item.text]));
    pieces.push(chapter.example.code, chapter.example.explanation);
    pieces.push(...chapter.boundaries.map((item) => typeof item === "string" ? item : [item.title, item.text].join(" ")));
    pieces.push(...chapter.tradeoffs.map((item) => typeof item === "string" ? item : [item.title, item.text].join(" ")));
    pieces.push(...chapter.exercises.flatMap((item) => [item.prompt, ...item.checkpoints]));
    pieces.push(...chapter.sources.map((item) => [item.title, item.url].filter(Boolean).join(" ")));
    return pieces.filter(Boolean).join(" ").toLocaleLowerCase("zh-CN");
  })(),
}));

fs.writeFileSync(path.join(contentDir, "question-index.generated.json"), `${JSON.stringify(questionIndex)}\n`);
fs.writeFileSync(path.join(contentDir, "topic-index.generated.json"), `${JSON.stringify(topicIndex)}\n`);
fs.writeFileSync(path.join(contentDir, "content-manifest.generated.json"), `${JSON.stringify({
  schemaVersion: 1,
  contentVersion: chapters.content_version,
  masterQuestionCount: map.master_questions.length,
  companyQuestionCount: map.company_questions.length,
  chapterCount: chapters.chapters.length,
  exerciseCount,
  domainCount: new Set(map.topics.map((topic) => topic.primary)).size,
}, null, 2)}\n`);

console.log(JSON.stringify({
  status: "ok",
  masterQuestions: map.master_questions.length,
  companyVariants: map.company_questions.length,
  chapters: chapters.chapters.length,
  exercises: exerciseCount,
  domains: new Set(map.topics.map((topic) => topic.primary)).size,
  contentVersion: chapters.content_version,
  generated: ["question-index.generated.json", "topic-index.generated.json", "content-manifest.generated.json"],
}));
