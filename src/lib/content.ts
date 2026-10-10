import questionMapJson from "@/content/knowledge-map.source.json";
import chapterJson from "@/content/knowledge-chapters.source.json";
import questionIndexJson from "@/content/question-index.generated.json";
import topicIndexJson from "@/content/topic-index.generated.json";

export type ContentLink = { label: string; target: string };
export type ContentBlock = { kind: "paragraph" | "heading" | "code"; text: string; language?: string; links?: ContentLink[] };
export type QuestionSource = { filename?: string; version?: number; sha256?: string; bookmark?: string; interview_year?: number; evidence_level?: string; limitations?: string[]; [key: string]: unknown };
export type MasterQuestion = {
  qid: string; title: string; primary: string; subtopic: string; tags: string[]; mode: string;
  prerequisites: string[]; topic_id: string; source: QuestionSource; original_metadata?: string;
  content: ContentBlock[]; explanation_markdown?: string; checkpoints?: string[]; index_anchor: string;
};
export type CompanyQuestion = {
  qid: string; company: string; title: string; master_ids: string[]; topic_ids: string[];
  source_ids: string[]; source: QuestionSource; content: ContentBlock[]; explanation_markdown?: string; checkpoints?: string[]; index_anchor: string;
};
export type Topic = { topic_id: string; primary: string; subtopic: string; question_ids: string[]; index_anchor: string; display_order: number[] };
export type Checkpoint = { id: string; label: string; text: string };
export type QuestionIndexItem = {
  qid: string; kind: "master" | "company"; title: string; topicIds: string[];
  primary: string; subtopic: string; tags: string[]; mode: string; priority: string | null;
  masterIds: string[]; company: string | null; source: QuestionSource; searchText: string;
};
export type TopicIndexItem = { topicId: string; primary: string; subtopic: string; masterQuestionIds: string[]; companyQuestionIds: string[]; prerequisites: string[]; searchText: string };
export type ChapterNote = string | { title: string; text: string };
export type ChapterExample = { language: string; code: string; explanation: string; environment?: string; verification?: string; [key: string]: unknown };
export type ChapterExercise = { prompt: string; checkpoints: string[]; question_ids: string[] };
export type ChapterSource = { title: string; url?: string; verified_date?: string; limitations?: string; [key: string]: unknown };
export type ChapterQuestionReference = { qid: string; title: string; source?: QuestionSource; company?: string; master_ids?: string[] };
export type KnowledgeChapter = {
  topic_id: string; title: string; prerequisites: string[]; mental_model: string;
  mechanisms: Array<{ title: string; text: string }>; example: ChapterExample;
  boundaries: ChapterNote[]; tradeoffs: ChapterNote[];
  oral_summary: string; exercises: ChapterExercise[]; question_ids: string[];
  sources: ChapterSource[]; version_notes: string; primary: string; display_order: number[];
  index_anchor: string; question_references: ChapterQuestionReference[]; company_references: ChapterQuestionReference[];
};

type QuestionMap = {
  schema_version: number; date: string; master_count: number; company_question_count: number; topic_count: number;
  topics: Topic[]; master_questions: MasterQuestion[]; company_questions: CompanyQuestion[];
  company_evidence: Array<{ [key: string]: unknown }>; boundaries: unknown[];
};
type ChapterSet = {
  schema_version: number; content_version: string; title: string; source_map: string;
  master_count: number; company_question_count: number; topic_count: number;
  chapters: KnowledgeChapter[]; learning_paths: Array<{ [key: string]: unknown }>; execution_note: string;
};

export const questionMap = questionMapJson as unknown as QuestionMap;
export const chapterSet = chapterJson as unknown as ChapterSet;
export const masterQuestions = questionMap.master_questions;
export const companyQuestions = questionMap.company_questions;
export const topics = questionMap.topics;
export const chapters = chapterSet.chapters;
export const questionIndex = questionIndexJson as QuestionIndexItem[];
export const topicIndex = topicIndexJson as TopicIndexItem[];
export const questionIds = new Set(questionIndex.map((question) => question.qid));

export function verifyContentCounts() {
  const unique = (values: string[]) => new Set(values).size === values.length;
  return questionMap.master_count === masterQuestions.length && chapterSet.master_count === masterQuestions.length && unique(masterQuestions.map((question) => question.qid)) &&
    questionMap.company_question_count === companyQuestions.length && chapterSet.company_question_count === companyQuestions.length && unique(companyQuestions.map((question) => question.qid)) &&
    questionMap.topic_count === topics.length && chapterSet.topic_count === topics.length && unique(topics.map((topic) => topic.topic_id)) &&
    chapterSet.chapters.length === topics.length && chapterSet.chapters.every((chapter) => Array.isArray(chapter.exercises) && chapter.exercises.length === 2);
}

export function questionById(qid: string) {
  return masterQuestions.find((question) => question.qid.toLowerCase() === qid.toLowerCase()) ??
    companyQuestions.find((question) => question.qid.toLowerCase() === qid.toLowerCase());
}

export function topicById(topicId: string) {
  return topics.find((topic) => topic.topic_id.toLowerCase() === topicId.toLowerCase());
}

export function chapterById(topicId: string) {
  return chapters.find((chapter) => chapter.topic_id.toLowerCase() === topicId.toLowerCase());
}

export function questionWithPublicSource<T extends MasterQuestion | CompanyQuestion>(question: T): T {
  const source = { ...question.source };
  delete source.library_file_id;
  return { ...question, source } as T;
}

const d13Checkpoints = [
  "能解释有限同步 iterable 的契约，以及普通值、Promise、thenable 的统一处理。",
  "结果按输入次序保存，而非按完成次序 push。",
  "空输入得到空数组，且后续 then 回调仍异步执行。",
  "任一拒绝不等于取消其他任务，能区分聚合、限流和取消。",
  "能解释逐项注册与迭代异常，覆盖先 yield 拒绝 Promise 再抛错的情况。",
  "能说清 O(n) 结果空间，以及教学版不覆盖子类、篡改内建方法等全部规范细节。",
];

function firstSentence(text: string) {
  return text.split(/(?<=[。！？；;])/u)[0]?.trim() || text.trim();
}

export function checkpointsFor(question: MasterQuestion | CompanyQuestion): Checkpoint[] {
  if (Array.isArray(question.checkpoints) && question.checkpoints.length > 0) {
    return question.checkpoints.map((text, index) => ({ id: `${question.qid}-${index + 1}`, label: firstSentence(text), text }));
  }
  if (question.qid === "D13") {
    return d13Checkpoints.map((text, index) => ({ id: "D13-" + (index + 1), label: firstSentence(text), text }));
  }
  const auxiliaryParagraph = /^(?:面经依据|官方参考|官方核验|来源|版本与阅读边界|版本边界|常见误区|递进追问|整理者追问与检查点|题干|原题与延伸|已有主练题|真新增主练题|相关基础|技术核验)(?:\s|[:：]|$)/u;
  const paragraphs = question.content
    .filter((block) => block.kind === "paragraph")
    .map((block) => block.text.trim())
    .map((text) => ({ original: text, point: text.replace(/^\s*\d{1,2}[.、）)]\s*/u, "").trim() }))
    .filter(({ point }) => point.length > 24 && !auxiliaryParagraph.test(point));
  const numbered = paragraphs.filter(({ original }) => /^\s*\d{1,2}[.、）)]\s*/u.test(original));
  const sourcePoints = numbered.length >= 3 ? numbered : paragraphs;
  const seen = new Set<string>();
  const statements = sourcePoints
    .map(({ point }) => point)
    .filter((text) => {
      const key = firstSentence(text);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 6);
  return statements.map((text, index) => {
    const sentence = firstSentence(text);
    const label = sentence.length > 130 ? sentence.slice(0, 127) + "…" : sentence;
    return { id: question.qid + "-" + (index + 1), label, text };
  });
}

export function explanationMarkdownFor(question: MasterQuestion | CompanyQuestion) {
  if (typeof question.explanation_markdown === "string" && question.explanation_markdown.trim()) {
    return question.explanation_markdown;
  }
  return question.content.map((block) => {
    if (block.kind === "heading") return `### ${block.text}`;
    if (block.kind === "code") return `\`\`\`${block.language ?? "text"}\n${block.text}\n\`\`\``;
    const links = block.links?.map((link) => `[${link.label}](${link.target})`).join(" · ");
    return links ? `${block.text}\n\n${links}` : block.text;
  }).join("\n\n");
}
