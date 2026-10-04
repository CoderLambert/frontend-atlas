"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Clock3 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getStudySnapshot, saveAttempt, type Assessment, type Attempt } from "@/lib/study-store";

type QuestionLabel = { qid: string; title: string; topicId: string };

function localToday() {
  const now = new Date();
  return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
}

function activeAssessment(attempt: Attempt) {
  return [...attempt.assessments].reverse().find((item) => !item.revokedAt) ?? null;
}

function RatingSummary({ assessment }: { assessment: Assessment }) {
  const values = Object.values(assessment.scores);
  const clear = values.filter((value) => value === "clear").length;
  const incomplete = values.filter((value) => value === "incomplete").length;
  const notYet = values.filter((value) => value === "not_yet").length;
  return <p className="review-rating-summary">自评：能讲清 {clear} · 不完整 {incomplete} · 还不会 {notYet}</p>;
}

export function ReviewQueue({ questions, contentVersion }: { questions: QuestionLabel[]; contentVersion: string }) {
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState("due");
  const [draftDates, setDraftDates] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const questionLookup = useMemo(() => new Map(questions.map((question) => [question.qid, question])), [questions]);

  useEffect(() => {
    let active = true;
    getStudySnapshot().then((snapshot) => {
      if (!active) return;
      setAttempts(snapshot.attempts);
      setLoading(false);
    }).catch((reason: unknown) => {
      if (!active) return;
      setError(reason instanceof Error ? reason.message : "无法读取本设备的复习记录。");
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const records = useMemo(() => {
    return attempts.flatMap((attempt) => {
      const assessment = activeAssessment(attempt);
      if (!assessment) return [];
      return [{ attempt, assessment, updated: attempt.contentVersion !== contentVersion }];
    }).sort((a, b) => {
      const dateA = a.assessment.nextReviewOn ?? "9999-12-31";
      const dateB = b.assessment.nextReviewOn ?? "9999-12-31";
      return dateA.localeCompare(dateB);
    });
  }, [attempts, contentVersion]);
  const today = localToday();
  const due = records.filter((item) => item.assessment.nextReviewOn && item.assessment.nextReviewOn <= today && !item.assessment.queueDismissedAt);
  const upcoming = records.filter((item) => item.assessment.nextReviewOn && item.assessment.nextReviewOn > today && !item.assessment.queueDismissedAt);
  const unscheduled = records.filter((item) => !item.assessment.nextReviewOn && !item.assessment.queueDismissedAt);
  const dismissed = records.filter((item) => item.assessment.queueDismissedAt);
  const tabs = [{ value: "due", label: "待复习", count: due.length }, { value: "upcoming", label: "已安排", count: upcoming.length }, { value: "unscheduled", label: "未安排", count: unscheduled.length }, { value: "dismissed", label: "暂时移出", count: dismissed.length }];
  const shown = activeTab === "due" ? due : activeTab === "upcoming" ? upcoming : activeTab === "unscheduled" ? unscheduled : dismissed;

  async function updateAssessment(attempt: Attempt, assessment: Assessment, patch: Partial<Assessment>, successMessage: string) {
    const updatedAssessment = { ...assessment, ...patch };
    const next: Attempt = {
      ...attempt,
      assessments: attempt.assessments.map((item) => item.assessmentId === assessment.assessmentId ? updatedAssessment : item),
      updatedAt: new Date().toISOString(),
    };
    try {
      await saveAttempt(next);
      setAttempts((current) => current.map((item) => item.attemptId === next.attemptId ? next : item));
      setMessage(successMessage);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "复习安排未能保存。");
    }
  }

  return (
    <div className="content-page review-page">
      <header className="content-page-header">
        <div><div className="eyebrow">REVIEW · 由你安排节奏</div><h1>复习</h1><p>按你自评时选的日期查看遗漏点。这里不预测记忆效果，也不发送通知。</p></div>
        <div className="bank-counts"><span><strong>{due.length}</strong> 项待复习</span><span><strong>{records.length}</strong> 条有效自评</span></div>
      </header>
      {error && <p className="assessment-error" role="alert">{error}</p>}
      {message && <p className="assessment-success" role="status">{message}</p>}
      {loading ? <Card className="empty-state"><Clock3 size={24} aria-hidden="true" /><p>正在读取本设备复习记录…</p></Card> : (
        <Tabs value={activeTab} onValueChange={setActiveTab} className="review-tabs">
          <TabsList className="review-tab-grid" aria-label="复习队列">
            {tabs.map((tab) => <TabsTrigger key={tab.value} value={tab.value}>{tab.label}<span>{tab.count}</span></TabsTrigger>)}
          </TabsList>
          {tabs.map((tab) => (
            <TabsContent key={tab.value} value={tab.value} className="review-tab-content">
              {shown.length === 0 ? <Card className="empty-state"><CalendarClock size={25} aria-hidden="true" /><h2>{tab.value === "due" ? "今天没有安排复习" : tab.value === "unscheduled" ? "没有未安排的自评" : tab.value === "dismissed" ? "没有暂时移出的记录" : "还没有未来安排"}</h2><p>你可以继续答题，或在题目自评后手动选择日期。</p><Button asChild variant="outline"><Link href="/questions/">打开题库</Link></Button></Card> : (
                <div className="review-list">
                  {shown.map(({ attempt, assessment, updated }) => {
                    const question = questionLookup.get(attempt.qid);
                    const selectedDate = draftDates[assessment.assessmentId] ?? assessment.nextReviewOn ?? "";
                    return (
                      <Card className="review-item" key={attempt.attemptId}>
                        <div className="review-item-header">
                          <div><div className="question-result-meta"><span className="question-id">{attempt.qid}</span>{updated && <Badge variant="outline">内容已更新</Badge>}</div><h2>{question?.title ?? attempt.qid}</h2><p>{question?.topicId ?? "题目"} · 自评于 {new Date(assessment.savedAt).toLocaleDateString()}</p></div>
                          {assessment.nextReviewOn && <Badge variant={assessment.nextReviewOn <= today && !assessment.queueDismissedAt ? "default" : "subtle"}>{assessment.nextReviewOn <= today ? "待复习" : "已安排"}</Badge>}
                        </div>
                        <RatingSummary assessment={assessment} />
                        {assessment.missingNote && <div className="review-missing-note"><strong>还要补练</strong><p>{assessment.missingNote}</p></div>}
                        {updated && <p className="content-version-warning">资料已更新；旧自评保留在原版本。本题新检查点不会继承旧勾选。</p>}
                        <div className="review-item-footer">
                          <Link className="review-open-link" href={"/questions/" + attempt.qid + "/"}>打开题目重新盲答</Link>
                          {activeTab !== "dismissed" && (
                            <div className="review-reschedule">
                              <Label htmlFor={"schedule-" + assessment.assessmentId}>改期</Label>
                              <Input id={"schedule-" + assessment.assessmentId} type="date" min={today} value={selectedDate} onChange={(event) => setDraftDates((current) => ({ ...current, [assessment.assessmentId]: event.target.value }))} />
                              <Button size="sm" variant="outline" onClick={() => selectedDate ? void updateAssessment(attempt, assessment, { nextReviewOn: selectedDate, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown", queueDismissedAt: null }, "复习日期已更新。") : setError("请选择有效的复习日期。")}>保存日期</Button>
                            </div>
                          )}
                          <Button size="sm" variant="ghost" onClick={() => void updateAssessment(attempt, assessment, { queueDismissedAt: assessment.queueDismissedAt ? null : new Date().toISOString() }, assessment.queueDismissedAt ? "记录已放回复习队列。" : "记录已暂时移出队列。")}>{assessment.queueDismissedAt ? "恢复到队列" : "暂时移出"}</Button>
                        </div>
                      </Card>
                    );
                  })}
                </div>
              )}
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}
