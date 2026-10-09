import { createHash } from "node:crypto";
import type { CompanyQuestion, MasterQuestion } from "../content.ts";

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

function snapshotCheckpoints(question: MasterQuestion | CompanyQuestion) {
  if (Array.isArray(question.checkpoints) && question.checkpoints.length > 0) return question.checkpoints;
  if (question.qid === "D13") return d13Checkpoints;
  const auxiliaryParagraph = /^(?:面经依据|官方参考|官方核验|来源|版本与阅读边界|版本边界|常见误区|递进追问|整理者追问与检查点|题干|原题与延伸|已有主练题|真新增主练题|相关基础|技术核验)(?:\s|[:：]|$)/u;
  const paragraphs = question.content
    .filter((block) => block.kind === "paragraph")
    .map((block) => block.text.trim())
    .map((text) => ({ original: text, point: text.replace(/^\s*\d{1,2}[.、）)]\s*/u, "").trim() }))
    .filter(({ point }) => point.length > 24 && !auxiliaryParagraph.test(point));
  const numbered = paragraphs.filter(({ original }) => /^\s*\d{1,2}[.、）)]\s*/u.test(original));
  const sourcePoints = numbered.length >= 3 ? numbered : paragraphs;
  const seen = new Set<string>();
  return sourcePoints.map(({ point }) => point).filter((text) => {
    const key = firstSentence(text);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}

function snapshotExplanation(question: MasterQuestion | CompanyQuestion) {
  if (typeof question.explanation_markdown === "string" && question.explanation_markdown.trim()) return question.explanation_markdown;
  return question.content.map((block) => {
    if (block.kind === "heading") return `### ${block.text}`;
    if (block.kind === "code") return `\`\`\`${block.language ?? "text"}\n${block.text}\n\`\`\``;
    const links = block.links?.map((link) => `[${link.label}](${link.target})`).join(" · ");
    return links ? `${block.text}\n\n${links}` : block.text;
  }).join("\n\n");
}

export type PublicQuestionSnapshot = {
  qid: string;
  title: string;
  explanationMarkdown: string;
  checkpoints: string[];
};

export function publicQuestionSnapshot(question: MasterQuestion | CompanyQuestion): PublicQuestionSnapshot {
  return {
    qid: question.qid,
    title: question.title,
    explanationMarkdown: snapshotExplanation(question),
    checkpoints: snapshotCheckpoints(question),
  };
}

export function publicQuestionSnapshotSha256(snapshot: PublicQuestionSnapshot) {
  return createHash("sha256").update(JSON.stringify({
    qid: snapshot.qid,
    title: snapshot.title,
    explanationMarkdown: snapshot.explanationMarkdown,
    checkpoints: snapshot.checkpoints,
  })).digest("hex");
}
