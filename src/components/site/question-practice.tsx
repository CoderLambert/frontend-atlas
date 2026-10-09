"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, CheckCircle2, Clock3, Eye, FileQuestion, RotateCcw, Save, WandSparkles } from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { CodeBlock } from "@/components/ui/code-block";
import { QuestionPrivateEditor, type QuestionPrivateSelection } from "@/components/site/question-private-editor";
import { checkpointsFor, type CompanyQuestion, type ContentBlock, type MasterQuestion } from "@/lib/content";
import { contentBlocksToMarkdown } from "@/lib/question-private-overrides";
import { deleteDraft, getStudySnapshot, saveAttempt, saveDraft, type Assessment, type Attempt, type SelfRating } from "@/lib/study-store";

type PracticeQuestion = MasterQuestion | CompanyQuestion;
type SaveState = "loading" | "ready" | "saving" | "saved" | "error";
type ReviewOption = "none" | "tomorrow" | "3days" | "7days" | "custom";
type AnswerViewMode = "edit" | "preview" | "split";
const CoachMarkdown = dynamic(() => import("@/components/site/coach-markdown").then((module) => module.CoachMarkdown), {
  loading: () => <p className="markdown-preview-loading" aria-live="polite">正在加载 Markdown 预览…</p>,
});

const ratingOptions: Array<{ value: SelfRating; label: string }> = [
  { value: "not_yet", label: "还不会" },
  { value: "incomplete", label: "不完整" },
  { value: "clear", label: "能讲清" },
];

function newId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function newAttempt(qid: string, contentVersion: string, answer = ""): Attempt {
  const now = new Date().toISOString();
  return { attemptId: newId(), qid, contentVersion, startedAt: now, originalAnswer: answer, revisions: [], revealedAt: null, skipped: false, assessments: [], updatedAt: now };
}

function localDatePlus(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

function RichAnswer({ blocks }: { blocks: ContentBlock[] }) {
  return (
    <div className="rich-answer">
      {blocks.map((block, index) => {
        if (block.kind === "code") return <CodeBlock code={block.text} language={block.language ?? "typescript"} key={index} />;
        if (block.kind === "heading") return <h3 className="answer-heading" key={index}>{block.text}</h3>;
        return (
          <div className="answer-paragraph" key={index}>
            <p>{block.text}</p>
            {block.links?.map((link) => {
              const safeUrl = (() => {
                try {
                  const url = new URL(link.target);
                  return url.protocol === "https:" ? url.href : null;
                } catch {
                  return null;
                }
              })();
              return safeUrl ? <a href={safeUrl} key={safeUrl} target="_blank" rel="noreferrer">{link.label}</a> : null;
            })}
          </div>
        );
      })}
    </div>
  );
}

function currentAssessment(attempt: Attempt | null): Assessment | null {
  if (!attempt) return null;
  return [...attempt.assessments].reverse().find((assessment) => !assessment.revokedAt) ?? null;
}

export function QuestionPractice({
  question,
  topicTitle,
  topicId,
  relatedQuestionIds,
  contentVersion,
}: {
  question: PracticeQuestion;
  topicTitle: string;
  topicId: string;
  relatedQuestionIds: string[];
  contentVersion: string;
}) {
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [answer, setAnswer] = useState("");
  const [answerViewSelection, setAnswerViewSelection] = useState<{ qid: string; mode: AnswerViewMode }>(() => ({ qid: question.qid, mode: "edit" }));
  const [revision, setRevision] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [saveError, setSaveError] = useState("");
  const [scores, setScores] = useState<Record<string, SelfRating>>({});
  const [missingNote, setMissingNote] = useState("");
  const [reviewOption, setReviewOption] = useState<ReviewOption>("none");
  const [customReviewDate, setCustomReviewDate] = useState("");
  const [assessmentError, setAssessmentError] = useState("");
  const [assessedMessage, setAssessedMessage] = useState("");
  const [storedSnapshot, setStoredSnapshot] = useState(false);
  const [privateSelection, setPrivateSelection] = useState<QuestionPrivateSelection>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revisionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const answerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const previousAnswerViewMode = useRef<AnswerViewMode>("edit");
  const previousPreviewQuestionId = useRef(question.qid);
  const publicCheckpoints = checkpointsFor(question);
  const publicExplanationMarkdown = contentBlocksToMarkdown(question.content);
  const privateOverride = privateSelection?.override ?? null;
  const checkpoints = privateOverride
    ? privateOverride.checkpoints.map((text, index) => ({ id: `${question.qid}-private-${index + 1}`, label: text, text }))
    : publicCheckpoints;
  const effectiveContentVersion = privateSelection && privateOverride
    ? `${contentVersion}:private:${encodeURIComponent(privateSelection.ownerUserId)}:${privateOverride.version}`
    : contentVersion;
  const effectiveTitle = privateOverride?.title ?? question.title;
  const isMaster = "topic_id" in question;
  const sourceLabel = isMaster ? question.primary : question.company;
  const relatedActiveAssessment = currentAssessment(attempt);
  const hasContentUpdate = Boolean(attempt && attempt.contentVersion !== effectiveContentVersion);
  const hasAnswer = answer.trim().length > 0;
  const answerViewMode = answerViewSelection.qid === question.qid ? answerViewSelection.mode : "edit";

  function setAnswerViewMode(mode: AnswerViewMode) {
    setAnswerViewSelection({ qid: question.qid, mode });
  }

  const handlePrivateSelectionChange = useCallback((selection: QuestionPrivateSelection) => {
    setPrivateSelection(selection);
  }, []);

  useEffect(() => {
    const questionChanged = previousPreviewQuestionId.current !== question.qid;
    if (!questionChanged && previousAnswerViewMode.current === "preview" && answerViewMode !== "preview" && !revealed) {
      answerTextareaRef.current?.focus();
    }
    previousAnswerViewMode.current = answerViewMode;
    previousPreviewQuestionId.current = question.qid;
  }, [answerViewMode, question.qid, revealed]);

  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => {
      if (active) {
        setSaveState("loading");
        setScores({});
        setMissingNote("");
        setReviewOption("none");
        setCustomReviewDate("");
        setAssessmentError("");
        setAssessedMessage("");
      }
      return getStudySnapshot();
    }).then((snapshot) => {
      if (!active) return;
      const latest = snapshot.attempts
        .filter((item) => item.qid === question.qid)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] ?? null;
      const draft = latest ? snapshot.drafts.find((item) => item.qid === question.qid && item.attemptId === latest.attemptId) : null;
      if (latest) {
        setStoredSnapshot(true);
        setAttempt(latest);
        setRevealed(Boolean(latest.revealedAt));
        setAnswer(latest.originalAnswer);
        if (draft?.kind === "revision") setRevision(draft.text);
        const assessment = [...latest.assessments].reverse().find((item) => !item.revokedAt) ?? null;
        if (assessment && latest.contentVersion === effectiveContentVersion) {
          setScores(assessment.scores);
          setMissingNote(assessment.missingNote);
          if (assessment.nextReviewOn) {
            const today = localDatePlus(0);
            setReviewOption(assessment.nextReviewOn === localDatePlus(1) ? "tomorrow" : assessment.nextReviewOn === localDatePlus(3) ? "3days" : assessment.nextReviewOn === localDatePlus(7) ? "7days" : assessment.nextReviewOn === today ? "none" : "custom");
            setCustomReviewDate(assessment.nextReviewOn);
          }
        }
      } else {
        setStoredSnapshot(true);
        setSaveState("ready");
      }
      if (latest) setSaveState("saved");
    }).catch((error: unknown) => {
      if (!active) return;
      setSaveState("error");
      setSaveError(error instanceof Error ? error.message : "本设备保存不可用。");
    });
    return () => {
      active = false;
    };
  }, [question.qid, effectiveContentVersion]);

  async function persistAttempt(next: Attempt): Promise<boolean> {
    setAttempt(next);
    setSaveState("saving");
    setSaveError("");
    try {
      await saveAttempt(next);
      setSaveState("saved");
      setStoredSnapshot(true);
      return true;
    } catch (error) {
      setSaveState("error");
      setSaveError(error instanceof Error ? error.message : "本设备保存失败。");
      return false;
    }
  }

  function handleAnswerChange(value: string) {
    setAnswer(value);
    if (revealed) return;
    const base = attempt && attempt.contentVersion === effectiveContentVersion && !attempt.revealedAt ? attempt : newAttempt(question.qid, effectiveContentVersion);
    const next = { ...base, originalAnswer: value, skipped: false, updatedAt: new Date().toISOString() };
    setAttempt(next);
    setSaveState("saving");
    setSaveError("");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void persistAttempt(next); }, 450);
  }

  async function handleReveal(skip: boolean) {
    const base = attempt && attempt.contentVersion === effectiveContentVersion && !attempt.revealedAt ? attempt : newAttempt(question.qid, effectiveContentVersion, answer);
    const now = new Date().toISOString();
    const next = { ...base, originalAnswer: answer, skipped: skip, revealedAt: now, updatedAt: now };
    setRevealed(true);
    setAnswer(next.originalAnswer);
    await persistAttempt(next);
  }

  function handleNewAttempt() {
    const next = newAttempt(question.qid, effectiveContentVersion);
    setAttempt(next);
    setAnswer("");
    setRevision("");
    setScores({});
    setMissingNote("");
    setReviewOption("none");
    setCustomReviewDate("");
    setRevealed(false);
    setAssessmentError("");
    setAssessedMessage("");
    void persistAttempt(next);
  }

  function handleRevisionChange(value: string) {
    setRevision(value);
    if (!attempt) return;
    if (revisionTimer.current) clearTimeout(revisionTimer.current);
    const draft = { qid: question.qid, attemptId: attempt.attemptId, contentVersion: attempt.contentVersion, kind: "revision" as const, text: value, savedAt: new Date().toISOString() };
    setSaveState("saving");
    revisionTimer.current = setTimeout(() => {
      saveDraft(draft).then(() => setSaveState("saved")).catch((error: unknown) => {
        setSaveState("error");
        setSaveError(error instanceof Error ? error.message : "补充草稿保存失败。");
      });
    }, 450);
  }

  async function saveRevision() {
    if (!attempt || !revision.trim()) return;
    const now = new Date().toISOString();
    const next: Attempt = {
      ...attempt,
      revisions: [...attempt.revisions, { revisionId: newId(), text: revision, savedAt: now }],
      updatedAt: now,
    };
    setAttempt(next);
    setSaveState("saving");
    setSaveError("");
    try {
      await saveAttempt(next);
      await deleteDraft(question.qid);
      setSaveState("saved");
      setRevision("");
      setAssessedMessage("补充修订已保存，原始盲答仍保留。");
    } catch (error) {
      setSaveState("error");
      setSaveError(error instanceof Error ? error.message : "补充修订未能保存。");
    }
  }

  async function saveAssessment() {
    if (!attempt || !revealed) return;
    const missingRatings = checkpoints.some((checkpoint) => !scores[checkpoint.id]);
    if (missingRatings) {
      setAssessmentError("请为每个检查点选一项，再保存自评。");
      return;
    }
    const hasMissingPoints = checkpoints.some((checkpoint) => scores[checkpoint.id] !== "clear");
    if (hasMissingPoints && !missingNote.trim()) {
      setAssessmentError("写一句还要补练的内容，再保存自评。");
      return;
    }
    let nextReviewOn: string | null = null;
    if (reviewOption === "tomorrow") nextReviewOn = localDatePlus(1);
    if (reviewOption === "3days") nextReviewOn = localDatePlus(3);
    if (reviewOption === "7days") nextReviewOn = localDatePlus(7);
    if (reviewOption === "custom") {
      if (!customReviewDate || customReviewDate < localDatePlus(0)) {
        setAssessmentError("请选择今天或之后的日期。");
        return;
      }
      nextReviewOn = customReviewDate;
    }
    const now = new Date().toISOString();
    const assessment: Assessment = {
      assessmentId: newId(),
      savedAt: now,
      scores,
      missingNote: missingNote.trim(),
      nextReviewOn,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown",
    };
    const next = { ...attempt, assessments: [...attempt.assessments, assessment], updatedAt: now };
    setAssessmentError("");
    if (await persistAttempt(next)) setAssessedMessage("自评已保存。本设备记录不会自动同步。");
  }

  async function undoAssessment() {
    if (!attempt || !relatedActiveAssessment) return;
    const now = new Date().toISOString();
    const next: Attempt = {
      ...attempt,
      assessments: attempt.assessments.map((assessment) => assessment.assessmentId === relatedActiveAssessment.assessmentId ? { ...assessment, revokedAt: now } : assessment),
      updatedAt: now,
    };
    if (await persistAttempt(next)) setAssessedMessage("本次自评已撤销，答案和历史记录仍保留。");
  }

  const saveText = saveState === "loading" ? "正在读取本设备记录…" :
    saveState === "saving" ? "正在保存…" :
    saveState === "saved" ? "已保存至本设备" :
    saveState === "ready" ? "本设备存储可用，输入后自动保存" :
    saveState === "error" ? "保存失败" : "准备开始";
  const dueLabel = relatedActiveAssessment?.nextReviewOn
    ? "下次安排：" + relatedActiveAssessment.nextReviewOn + " · " + relatedActiveAssessment.timeZone
    : "尚未安排下次练习";

  return (
    <div className="question-page">
      <div className="question-breadcrumb"><Link href="/questions/">题库</Link><span aria-hidden="true">/</span><span>{question.qid}</span><span aria-hidden="true">/</span><Link href={"/knowledge/" + topicId + "/"}>{topicTitle}</Link></div>
      <header className="question-heading">
        <div className="eyebrow">PRACTICE · 先作答，再对照</div>
        <h1>{effectiveTitle}</h1>
        <div className="question-tags">
          <Badge variant="outline">{question.qid}</Badge>
          <Badge variant="secondary">{sourceLabel}</Badge>
          <Badge variant="subtle">{topicId} · {topicTitle}</Badge>
          {privateOverride && <Badge variant="secondary">我的私人版本 v{privateOverride.version}</Badge>}
          {isMaster && question.original_metadata?.includes("P0") && <Badge variant="outline">P0 · 优先练习</Badge>}
        </div>
      </header>

      <div className="question-grid">
        <div className="question-main-column">
          {hasContentUpdate && <div className="content-version-warning" role="status">资料内容已更新。本次记录仍按 {attempt?.contentVersion} 保存；旧自评不会套用到新检查点。</div>}
          <Card className="answer-card">
            <div className="answer-card-header">
              <div><h2>我的回答</h2><p>先试着说出关键思路，再查看参考内容。</p></div>
              {revealed && <Badge variant="subtle">参考已揭晓</Badge>}
            </div>
            <div className="answer-entry-toolbar">
              <Label id="answer-content-label" className="field-label" htmlFor={answerViewMode === "preview" ? undefined : "answer-draft"}>
                {answerViewMode === "preview" ? "作答预览" : "写下你的思路，或记录口述提纲（支持 Markdown）"}
              </Label>
              <div className="answer-mode-toggle" role="group" aria-label="作答显示模式">
                <Button type="button" size="sm" variant={answerViewMode === "edit" ? "secondary" : "ghost"} aria-pressed={answerViewMode === "edit"} aria-controls="answer-editor-content" onClick={() => setAnswerViewMode("edit")}>编辑</Button>
                <Button type="button" size="sm" variant={answerViewMode === "preview" ? "secondary" : "ghost"} aria-pressed={answerViewMode === "preview"} aria-controls="answer-editor-content" onClick={() => setAnswerViewMode("preview")}>预览</Button>
                <Button type="button" size="sm" variant={answerViewMode === "split" ? "secondary" : "ghost"} aria-pressed={answerViewMode === "split"} aria-controls="answer-editor-content" onClick={() => setAnswerViewMode("split")}>并排</Button>
              </div>
            </div>
            <p id="answer-format-hint" className="answer-format-hint">预览只切换显示，不会提交作答。</p>
            <div id="answer-editor-content" className={`answer-editor-content answer-view-${answerViewMode}`}>
              {answerViewMode !== "preview" && (
                <section className="answer-editor-panel" aria-label="编辑作答">
                  {answerViewMode === "split" && <h3 className="answer-panel-title">编辑</h3>}
                  <Textarea
                    ref={answerTextareaRef}
                    id="answer-draft"
                    className="answer-input"
                    value={answer}
                    onChange={(event) => handleAnswerChange(event.target.value)}
                    placeholder="从问题的边界开始，再说明核心机制……"
                    rows={12}
                    disabled={revealed}
                    aria-describedby="answer-hint answer-format-hint"
                  />
                </section>
              )}
              {answerViewMode !== "edit" && (
                <section className="answer-preview-panel" aria-label="Markdown 预览">
                  {answerViewMode === "split" && <h3 className="answer-panel-title">预览</h3>}
                  <div id="answer-preview" className="answer-markdown-preview" role="region" aria-labelledby="answer-content-label" tabIndex={0}>
                    {answer.trim()
                      ? <CoachMarkdown source={answer} streaming={false} />
                      : <p className="answer-preview-empty">还没有作答内容。输入后会在这里实时预览 Markdown。</p>}
                  </div>
                </section>
              )}
            </div>
            <div className="answer-controls">
              <p id="answer-hint" className={saveState === "error" ? "local-save-note is-error" : "local-save-note"}>
                <Save size={15} aria-hidden="true" /> {saveText}
                {saveState === "error" && <span> · 文字仍在当前页面：{saveError}</span>}
              </p>
              {!revealed ? (
                <div className="answer-actions">
                  <Button onClick={() => void handleReveal(true)} variant="ghost" disabled={saveState === "loading"}>跳过作答</Button>
                  <Button onClick={() => void handleReveal(false)} disabled={!hasAnswer || saveState === "loading"} size="lg">查看参考答案 <Eye size={16} aria-hidden="true" /></Button>
                </div>
              ) : (
                <Button onClick={handleNewAttempt} variant="outline" size="lg"><RotateCcw size={16} aria-hidden="true" />重新盲答</Button>
              )}
            </div>
              {saveState === "error" && <Button variant="outline" size="sm" onClick={async () => {
                try {
                  if (!navigator.clipboard) throw new Error("clipboard");
                  await navigator.clipboard.writeText(answer);
                  setAssessedMessage("回答已复制。");
                } catch {
                  setAssessedMessage("复制失败，请手动选中文字。");
                }
              }}>复制当前回答</Button>}
          </Card>

          {revealed && (
            <>
              <Card className="reference-card">
                <div className="answer-card-header">
                  <div><h2>口述提纲</h2><p>从这道题自己的参考要点出发，用自己的话组织回答。</p></div>
                  <Badge variant="secondary">{privateOverride ? `私人版本 v${privateOverride.version}` : attempt?.contentVersion}</Badge>
                </div>
                {question.qid === "D13" && !privateOverride ? (
                  <p className="oral-outline">同步逐项遍历有限 iterable，每取到一项立即用 Promise.resolve 注册处理器，按输入索引保存结果。计数哨兵处理空输入；任一拒绝使聚合拒绝，但不会取消其他工作。迭代中途抛错也要转成拒绝，并避免先展开再注册导致早先拒绝无人处理。它只组合结果，限制启动并发是 D02 的职责。</p>
                ) : (
                  <ol className="oral-outline-list">{checkpoints.slice(0, 3).map((checkpoint) => <li key={checkpoint.id}>{checkpoint.label}</li>)}</ol>
                )}
                <Accordion type="single" collapsible className="full-answer-accordion">
                  <AccordionItem value="answer">
                    <AccordionTrigger>展开完整参考答案、代码、边界与来源</AccordionTrigger>
                    <AccordionContent>
                      {privateOverride
                        ? <CoachMarkdown source={privateOverride.explanationMarkdown} streaming={false} />
                        : <RichAnswer blocks={question.content} />}
                      {question.source.filename && <p className="source-note">{privateOverride ? "公共底稿来源：" : "来源："}{question.source.filename}{question.source.version ? " · 版本 " + question.source.version : ""}{question.source.bookmark ? " · " + question.source.bookmark : ""}</p>}
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
                {question.qid === "D13" && <div className="assessment-title"><CheckCircle2 size={19} aria-hidden="true" /><div><strong>这道题的 6 项检查点</strong><p>每项都对应 D13 的原答案与边界。</p></div></div>}
              </Card>

              <Card className="assessment-card">
                <div className="answer-card-header">
                  <div><h2>自评检查</h2><p>按你能否讲清每个要点选择状态，不会生成自动分数。</p></div>
                  {relatedActiveAssessment && !hasContentUpdate && <Badge variant="secondary">已自评</Badge>}
                </div>
                {checkpoints.length === 0 && <p className="assessment-error" role="alert">这道题暂时没有可自评的检查点。</p>}
                <div className="checkpoint-list">
                  {checkpoints.map((checkpoint, index) => (
                    <div className="checkpoint-row" key={checkpoint.id}>
                      <div className="checkpoint-copy">
                        <span className="checkpoint-number">{String(index + 1).padStart(2, "0")}</span>
                        <div><strong>{checkpoint.label}</strong>{checkpoint.text !== checkpoint.label && <details><summary>展开检查点全文</summary><p>{checkpoint.text}</p></details>}</div>
                      </div>
                      <RadioGroup
                        className="rating-group"
                        aria-label={"自评检查点 " + (index + 1)}
                        value={hasContentUpdate ? undefined : scores[checkpoint.id]}
                        onValueChange={(value) => { setScores((current) => ({ ...current, [checkpoint.id]: value as SelfRating })); setAssessmentError(""); }}
                      >
                        {ratingOptions.map((option) => {
                          const radioId = checkpoint.id + "-" + option.value;
                          return <Label className="rating-choice" key={option.value} htmlFor={radioId}><RadioGroupItem id={radioId} value={option.value} disabled={hasContentUpdate} /><span>{option.label}</span></Label>;
                        })}
                      </RadioGroup>
                    </div>
                  ))}
                </div>
                <div className="assessment-fields">
                  <div>
                    <Label className="field-label" htmlFor="missing-note">还要补练什么</Label>
                    <Textarea id="missing-note" value={missingNote} onChange={(event) => setMissingNote(event.target.value)} rows={3} placeholder="记下遗漏点，之后复习时会一并显示。" disabled={hasContentUpdate} />
                  </div>
                  <div className="schedule-field">
                    <Label className="field-label" htmlFor="review-schedule">安排下次练习</Label>
                    <Select value={reviewOption} onValueChange={(value) => setReviewOption(value as ReviewOption)} disabled={hasContentUpdate}>
                      <SelectTrigger id="review-schedule" aria-label="下次复习时间"><SelectValue placeholder="选择复习时间" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">暂不安排</SelectItem>
                        <SelectItem value="tomorrow">明天</SelectItem>
                        <SelectItem value="3days">3 天后</SelectItem>
                        <SelectItem value="7days">7 天后</SelectItem>
                        <SelectItem value="custom">自选日期</SelectItem>
                      </SelectContent>
                    </Select>
                    {reviewOption === "custom" && <Input id="custom-review-date" aria-label="自选复习日期" type="date" value={customReviewDate} min={localDatePlus(0)} onChange={(event) => setCustomReviewDate(event.target.value)} className="custom-date-input" />}
                    <p className="schedule-note">这是你手动安排的日期，不是记忆算法预测。</p>
                  </div>
                </div>
                {assessmentError && <p className="assessment-error" role="alert">{assessmentError}</p>}
                {assessedMessage && <p className="assessment-success" role="status">{assessedMessage}</p>}
                <div className="assessment-footer">
                  <p>{relatedActiveAssessment && !hasContentUpdate ? dueLabel : "状态仅记录自评事实，不代表已掌握。"}</p>
                  <div className="assessment-actions">
                    {relatedActiveAssessment && !hasContentUpdate && <Button variant="ghost" onClick={() => void undoAssessment()}>撤销本次自评</Button>}
                    <Button onClick={() => void saveAssessment()} disabled={checkpoints.length === 0 || hasContentUpdate}>{relatedActiveAssessment && !hasContentUpdate ? "保存新自评" : "保存自评"}</Button>
                  </div>
                </div>
              </Card>
              {(
                <Card className="revision-card">
                  <Label className="field-label" htmlFor="revision-draft">补充修订（不覆盖原始盲答）</Label>
                  <Textarea id="revision-draft" value={revision} onChange={(event) => handleRevisionChange(event.target.value)} rows={4} placeholder="写下看完参考后的修正或遗漏。" />
                  <div className="answer-controls"><p className="local-save-note">{saveText}</p><Button onClick={() => void saveRevision()} disabled={!revision.trim()}>保存补充修订</Button></div>
                </Card>
              )}
              {attempt?.revisions.length ? <Card className="revision-history"><h2>补充修订历史</h2>{attempt.revisions.map((item) => <details key={item.revisionId}><summary>{new Date(item.savedAt).toLocaleString()}</summary>{typeof item.text === "string" && item.text.trim() ? <CoachMarkdown source={item.text} streaming={false} /> : <p className="revision-empty">（这条补充修订为空）</p>}</details>)}</Card> : null}
            </>
          )}
        </div>

        <aside className="question-aside" aria-label="题目关联信息">
          <QuestionPrivateEditor
            qid={question.qid}
            contentVersion={contentVersion}
            publicTitle={question.title}
            publicExplanationMarkdown={publicExplanationMarkdown}
            publicCheckpoints={publicCheckpoints.map((checkpoint) => checkpoint.text)}
            onSelectionChange={handlePrivateSelectionChange}
          />
          <Card className="related-card">
            <div className="card-heading"><BookOpen size={18} aria-hidden="true" /><span>关联知识</span></div>
            <Link className="related-topic" href={"/knowledge/" + topicId + "/"}><span>{topicTitle}</span><small>{topicId} · {sourceLabel}</small></Link>
            <p>先读核心模型与边界，再回来练习表达。</p>
            <Link className="related-return" href={"/knowledge/" + topicId + "/"}><BookOpen size={15} aria-hidden="true" />回到知识章节</Link>
          </Card>
          <Card className="related-card ai-assist-entry">
            <div className="card-heading"><WandSparkles size={18} aria-hidden="true" /><span>AI 辅助本题</span></div>
            <p>可使用本机 ChatGPT 教练获取提示、原理讲解或参考点评；建议仍由你自己完成。</p>
            <Link className="related-return" href={(process.env.NEXT_PUBLIC_FRONTEND_ATLAS_LOCAL_MODE === "1" ? "/coach/" : "/ai-assist/") + "?qid=" + encodeURIComponent(question.qid)}>
              {process.env.NEXT_PUBLIC_FRONTEND_ATLAS_LOCAL_MODE === "1" ? "打开本机教练" : "查看本机设置步骤"}
              <WandSparkles size={15} aria-hidden="true" />
            </Link>
          </Card>
          <Card className="session-card">
            <div className="card-heading"><FileQuestion size={18} aria-hidden="true" /><span>本题记录</span></div>
            <p>{attempt?.skipped ? "已标记为跳过作答" : relatedActiveAssessment ? "已保存个人自评" : revealed ? "已查看参考答案" : attempt ? "作答中" : "尚未开始"}</p>
            <small>内容版本 {attempt?.contentVersion ?? effectiveContentVersion}</small>
            {relatedActiveAssessment?.nextReviewOn && <small><Clock3 size={13} aria-hidden="true" /> {dueLabel}</small>}
            {storedSnapshot && <small>数据只保存在这个浏览器中。</small>}
          </Card>
          <Card className="session-card">
            <div className="card-heading"><BookOpen size={18} aria-hidden="true" /><span>相关题目</span></div>
            <ul className="related-question-list">{relatedQuestionIds.slice(0, 5).map((id) => <li key={id}><Link href={"/questions/" + id + "/"}>{id}</Link></li>)}</ul>
            {relatedQuestionIds.length > 5 && <Link className="section-card-link" href={"/questions/?topic=" + topicId}>在题库查看本章全部题目</Link>}
          </Card>
        </aside>
      </div>
    </div>
  );
}
