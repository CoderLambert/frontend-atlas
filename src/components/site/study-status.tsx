"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { BookOpen, Clock3, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getStudySnapshot, type Attempt, type StudySnapshot } from "@/lib/study-store";

type LoadState = "loading" | "ready" | "error";

function todayLocal() {
  const now = new Date();
  return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
}

function activeAssessment(attempt: Attempt) {
  return [...attempt.assessments].reverse().find((item) => !item.revokedAt) ?? null;
}

function latestAttempts(snapshot: StudySnapshot) {
  return [...snapshot.attempts].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function StudyStatusContent({ kind, contentVersion }: { kind: "progress" | "review"; contentVersion: string }) {
  const [state, setState] = useState<LoadState>("loading");
  const [snapshot, setSnapshot] = useState<StudySnapshot | null>(null);
  const [attemptNo, setAttemptNo] = useState(0);

  useEffect(() => {
    let active = true;
    getStudySnapshot().then((value) => {
      if (!active) return;
      setSnapshot(value);
      setState("ready");
    }).catch(() => { if (active) setState("error"); });
    return () => { active = false; };
  }, [attemptNo]);

  const newest = useMemo(() => snapshot ? latestAttempts(snapshot) : [], [snapshot]);
  const latestByQuestion = useMemo(() => {
    const result = new Map<string, Attempt>();
    for (const attempt of newest) if (!result.has(attempt.qid)) result.set(attempt.qid, attempt);
    return result;
  }, [newest]);
  const attemptedCount = latestByQuestion.size;
  const latest = newest[0] ?? null;
  const reviews = useMemo(() => {
    if (!snapshot) return { due: [] as Array<{ attempt: Attempt; date: string; updated: boolean }>, upcoming: [] as Array<{ attempt: Attempt; date: string; updated: boolean }> };
    const due: Array<{ attempt: Attempt; date: string; updated: boolean }> = [];
    const upcoming: Array<{ attempt: Attempt; date: string; updated: boolean }> = [];
    for (const attempt of snapshot.attempts) {
      const assessment = activeAssessment(attempt);
      if (!assessment?.nextReviewOn || assessment.queueDismissedAt) continue;
      const entry = { attempt, date: assessment.nextReviewOn, updated: attempt.contentVersion !== contentVersion };
      if (assessment.nextReviewOn <= todayLocal()) due.push(entry);
      else upcoming.push(entry);
    }
    due.sort((a, b) => a.date.localeCompare(b.date));
    upcoming.sort((a, b) => a.date.localeCompare(b.date));
    return { due, upcoming };
  }, [snapshot, contentVersion]);

  if (state === "loading") {
    return <div className="study-status-body"><p className="status-title">正在读取</p><p className="status-copy">检查本设备的学习记录。</p></div>;
  }
  if (state === "error") {
    return <div className="study-status-body"><p className="status-title">记录暂不可用</p><p className="status-copy">没有成功读取本设备数据库；不会把它显示成空进度。</p><Button variant="outline" size="sm" onClick={() => { setState("loading"); setAttemptNo((value) => value + 1); }}><RotateCcw size={14} aria-hidden="true" />重新读取</Button></div>;
  }

  if (kind === "progress") {
    const latestActiveAssessment = latest ? activeAssessment(latest) : null;
    const ctaHref = latest ? "/questions/" + latest.qid + "/" : "/questions/";
    const ctaLabel = !latest ? "从题库开始" : !latest.revealedAt ? "继续回答 " + latest.qid : !latestActiveAssessment ? "继续自评 " + latest.qid : "查看 " + latest.qid + " 的记录";
    const heading = !latest ? "尚未开始" : !latest.revealedAt ? "正在练习 " + latest.qid : !latestActiveAssessment ? "待完成自评 " + latest.qid : "已保存个人自评";
    const detail = !latest ? "完成练习后，这里会显示本设备的记录。" :
      latestActiveAssessment ? attemptedCount + " 道题有练习记录；自评不等同于掌握。" :
      latest.revealedAt ? "参考答案已揭晓，还没有保存这道题的自评。" :
      "你的回答会在输入后自动保存到本设备。";
    return (
      <div className="study-status-body">
        <p className="status-title">{heading}</p>
        <p className="status-copy">{detail}</p>
        <div className="status-actions"><span>{attemptedCount} 道题有记录</span><Button asChild size="sm" variant="outline"><Link href={ctaHref}>{ctaLabel}</Link></Button></div>
      </div>
    );
  }

  if (reviews.due.length) {
    const next = reviews.due[0];
    return (
      <div className="study-status-body">
        <p className="review-empty">{reviews.due.length} 道待复习</p>
        <p className="review-copy">{next.attempt.qid} · 安排于 {next.date}{next.updated ? " · 资料已更新，需重新检查" : ""}</p>
        <div className="status-actions"><span>按你选择的日期提醒自己</span><Button asChild size="sm" variant="outline"><Link href="/review/">开始复习</Link></Button></div>
      </div>
    );
  }
  if (reviews.upcoming.length) {
    const next = reviews.upcoming[0];
    return (
      <div className="study-status-body">
        <p className="review-empty">暂无到期任务</p>
        <p className="review-copy">下一次安排：{next.date} · {next.attempt.qid}</p>
        <div className="status-actions"><span>{reviews.upcoming.length} 道已手动安排</span><Button asChild size="sm" variant="outline"><Link href="/review/">查看复习</Link></Button></div>
      </div>
    );
  }
  return (
    <div className="study-status-body">
      <p className="review-empty">暂无复习安排</p>
      <p className="review-copy">完成自评后，可以手动安排下次练习日期。</p>
      <div className="status-actions"><span><Clock3 size={14} aria-hidden="true" /> 按自己的节奏复习</span><Button asChild size="sm" variant="outline"><Link href="/review/"><BookOpen size={14} aria-hidden="true" />浏览记录</Link></Button></div>
    </div>
  );
}
