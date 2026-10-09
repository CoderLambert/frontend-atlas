"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { FilterX, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getVisibleStudySnapshot, subscribeToStudyAccountChanges, type Attempt } from "@/lib/study-store";
import type { QuestionIndexItem, TopicIndexItem } from "@/lib/content";

type Tab = "master" | "company";
type Status = "all" | "not_started" | "in_progress" | "revealed" | "assessed" | "due";
type FilterState = { tab: Tab; query: string; domain: string; topicId: string; mode: string; priority: string; company: string; status: Status; scrollY: number };
const FILTER_KEY = "zhixu-question-bank-state-v1";
const PAGE_SIZE = 30;

function latestAttemptsByQuestion(attempts: Attempt[]) {
  const result = new Map<string, Attempt>();
  for (const attempt of [...attempts].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))) {
    if (!result.has(attempt.qid)) result.set(attempt.qid, attempt);
  }
  return result;
}

function localToday() {
  const today = new Date();
  return today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
}

export function QuestionBank({ questions, topics }: { questions: QuestionIndexItem[]; topics: TopicIndexItem[] }) {
  const masterQuestionCount = questions.filter((item) => item.kind === "master").length;
  const companyVariantCount = questions.filter((item) => item.kind === "company").length;
  const [tab, setTab] = useState<Tab>("master");
  const [query, setQuery] = useState("");
  const [domain, setDomain] = useState("all");
  const [topicId, setTopicId] = useState("all");
  const [mode, setMode] = useState("all");
  const [priority, setPriority] = useState("all");
  const [company, setCompany] = useState("all");
  const [status, setStatus] = useState<Status>("all");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [attemptsByQid, setAttemptsByQid] = useState<Map<string, Attempt>>(new Map());
  const [progressState, setProgressState] = useState<"loading" | "ready" | "error">("loading");
  const restoreRef = useRef(false);
  const [accountEpoch, setAccountEpoch] = useState(0);
  const accountEpochRef = useRef(0);

  useEffect(() => subscribeToStudyAccountChanges(() => {
    accountEpochRef.current += 1;
    setAttemptsByQid(new Map());
    setProgressState("loading");
    setAccountEpoch((epoch) => epoch + 1);
  }), []);

  useEffect(() => {
    let active = true;
    const epoch = accountEpochRef.current;
    getVisibleStudySnapshot().then((snapshot) => {
      if (!active || epoch !== accountEpochRef.current) return;
      setAttemptsByQid(latestAttemptsByQuestion(snapshot.attempts));
      setProgressState("ready");
    }).catch(() => { if (active && epoch === accountEpochRef.current) setProgressState("error"); });
    return () => { active = false; };
  }, [accountEpoch]);

  // Static export cannot read query strings on the server; restore these URL/session filters once after hydration.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (restoreRef.current) return;
    restoreRef.current = true;
    try {
      const params = new URLSearchParams(window.location.search);
      const queryTopic = params.get("topic");
      const saved = sessionStorage.getItem(FILTER_KEY);
      if (saved) {
        const state = JSON.parse(saved) as Partial<FilterState>;
        if (state.tab === "master" || state.tab === "company") setTab(state.tab);
        if (typeof state.query === "string") setQuery(state.query);
        if (typeof state.domain === "string") setDomain(state.domain);
        if (typeof state.topicId === "string") setTopicId(state.topicId);
        if (typeof state.mode === "string") setMode(state.mode);
        if (typeof state.priority === "string") setPriority(state.priority);
        if (typeof state.company === "string") setCompany(state.company);
        if (typeof state.status === "string") setStatus(state.status as Status);
        sessionStorage.removeItem(FILTER_KEY);
        if (typeof state.scrollY === "number") setTimeout(() => window.scrollTo({ top: state.scrollY }), 0);
      }
      // A chapter link in the URL expresses the current navigation intent; it wins over old filter restoration.
      if (queryTopic) {
        const item = topics.find((topic) => topic.topicId === queryTopic);
        if (item) {
          setDomain(item.primary);
          setTopicId(item.topicId);
        }
      }
    } catch {
      sessionStorage.removeItem(FILTER_KEY);
    }
  }, [topics]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const domains = useMemo(() => Array.from(new Set(topics.map((item) => item.primary))), [topics]);
  const topicOptions = useMemo(() => topics.filter((item) => domain === "all" || item.primary === domain), [topics, domain]);
  const companies = useMemo(() => Array.from(new Set(questions.filter((item) => item.kind === "company").map((item) => item.company).filter((item): item is string => Boolean(item)))).sort((a, b) => a.localeCompare(b, "zh-CN")), [questions]);
  const filteredQuestions = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    const selected = questions.filter((item) => {
      if (item.kind !== tab) return false;
      if (normalized && !item.searchText.includes(normalized)) return false;
      if (domain !== "all" && !item.topicIds.some((id) => topics.find((topic) => topic.topicId === id)?.primary === domain)) return false;
      if (topicId !== "all" && !item.topicIds.includes(topicId)) return false;
      if (tab === "master" && mode !== "all" && item.mode !== mode) return false;
      if (tab === "master" && priority !== "all" && (priority === "none" ? Boolean(item.priority) : item.priority !== priority)) return false;
      if (tab === "company" && company !== "all" && item.company !== company) return false;
      if (status !== "all") {
        if (progressState !== "ready") return false;
        const attempt = attemptsByQid.get(item.qid);
        const assessment = attempt ? [...attempt.assessments].reverse().find((entry) => !entry.revokedAt) : null;
        const isDue = Boolean(assessment?.nextReviewOn && assessment.nextReviewOn <= localToday() && !assessment.queueDismissedAt);
        if (status === "not_started" && attempt) return false;
        if (status === "in_progress" && (!attempt || attempt.revealedAt || assessment)) return false;
        if (status === "revealed" && (!attempt?.revealedAt || assessment)) return false;
        if (status === "assessed" && (!assessment || isDue)) return false;
        if (status === "due" && !isDue) return false;
      }
      return true;
    });
    if (normalized) selected.sort((a, b) => (a.qid.toLowerCase() === normalized ? -1 : b.qid.toLowerCase() === normalized ? 1 : a.qid.localeCompare(b.qid, "en")));
    return selected;
  }, [questions, topics, tab, query, domain, topicId, mode, priority, company, status, progressState, attemptsByQid]);

  const resetFilters = () => { setQuery(""); setDomain("all"); setTopicId("all"); setMode("all"); setPriority("all"); setCompany("all"); setStatus("all"); setVisibleCount(PAGE_SIZE); };
  const preserveFilters = () => {
    try { sessionStorage.setItem(FILTER_KEY, JSON.stringify({ tab, query, domain, topicId, mode, priority, company, status, scrollY: window.scrollY } satisfies FilterState)); } catch {}
  };
  const setTabValue = (value: string) => { setTab(value as Tab); setVisibleCount(PAGE_SIZE); };
  const hasFilters = Boolean(query || domain !== "all" || topicId !== "all" || mode !== "all" || priority !== "all" || company !== "all" || status !== "all");

  return (
    <div className="content-page question-bank-page">
      <header className="content-page-header">
        <div><div className="eyebrow">QUESTION BANK · 先选一题</div><h1>题库</h1><p>主练题与企业问法分开浏览，企业变体沿用原 ID 并关联主练题。</p></div>
        <div className="bank-counts"><span><strong>{masterQuestionCount}</strong> 道主练题</span><span><strong>{companyVariantCount}</strong> 道企业扩展题</span></div>
      </header>
      <Card className="question-bank-filters">
        <div className="question-search-row">
          <Search size={18} aria-hidden="true" />
          <Input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setVisibleCount(PAGE_SIZE); }} placeholder="搜索题号、题名或关键词" aria-label="搜索题号、题名或关键词" />
        </div>
        <Tabs value={tab} onValueChange={setTabValue} className="bank-tabs">
          <TabsList aria-label="选择题库类型">
            <TabsTrigger value="master">主练题 <span>{masterQuestionCount}</span></TabsTrigger>
            <TabsTrigger value="company">企业扩展 <span>{companyVariantCount}</span></TabsTrigger>
          </TabsList>
          <TabsContent value={tab} className="bank-tab-content">
            <div className="filter-grid">
              <div><Label className="filter-label" htmlFor="domain-filter">知识领域</Label><Select value={domain} onValueChange={(value) => { setDomain(value); setTopicId("all"); setVisibleCount(PAGE_SIZE); }}><SelectTrigger id="domain-filter"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部领域</SelectItem>{domains.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></div>
              <div><Label className="filter-label" htmlFor="topic-filter">知识章节</Label><Select value={topicId} onValueChange={(value) => { setTopicId(value); setVisibleCount(PAGE_SIZE); }}><SelectTrigger id="topic-filter"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部章节</SelectItem>{topicOptions.map((item) => <SelectItem key={item.topicId} value={item.topicId}>{item.topicId} · {item.subtopic}</SelectItem>)}</SelectContent></Select></div>
              {tab === "master" ? <>
                <div><Label className="filter-label" htmlFor="mode-filter">题型</Label><Select value={mode} onValueChange={(value) => { setMode(value); setVisibleCount(PAGE_SIZE); }}><SelectTrigger id="mode-filter"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部题型</SelectItem>{Array.from(new Set(questions.filter((item) => item.kind === "master").map((item) => item.mode))).sort().map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></div>
                <div><Label className="filter-label" htmlFor="priority-filter">优先级</Label><Select value={priority} onValueChange={(value) => { setPriority(value); setVisibleCount(PAGE_SIZE); }}><SelectTrigger id="priority-filter"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部优先级</SelectItem><SelectItem value="P0">P0</SelectItem><SelectItem value="P1">P1</SelectItem><SelectItem value="P2">P2</SelectItem><SelectItem value="none">未标注</SelectItem></SelectContent></Select></div>
              </> : <div><Label className="filter-label" htmlFor="company-filter">企业</Label><Select value={company} onValueChange={(value) => { setCompany(value); setVisibleCount(PAGE_SIZE); }}><SelectTrigger id="company-filter"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部企业</SelectItem>{companies.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></div>}
              <div><Label className="filter-label" htmlFor="status-filter">练习状态</Label><Select value={status} onValueChange={(value) => { setStatus(value as Status); setVisibleCount(PAGE_SIZE); }}><SelectTrigger id="status-filter"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部状态</SelectItem><SelectItem value="not_started">未开始</SelectItem><SelectItem value="in_progress">作答中</SelectItem><SelectItem value="revealed">已揭晓</SelectItem><SelectItem value="assessed">已自评</SelectItem><SelectItem value="due">待复习</SelectItem></SelectContent></Select></div>
            </div>
          </TabsContent>
        </Tabs>
        <div className="filter-summary"><span>{progressState === "error" ? "本设备进度暂时不可读取，状态筛选不可用。" : "显示 " + filteredQuestions.length + " 道题"}</span>{hasFilters && <Button variant="ghost" size="sm" onClick={resetFilters}><FilterX size={15} aria-hidden="true" />清除筛选</Button>}</div>
      </Card>
      <div className="question-results" aria-live="polite">
        {filteredQuestions.length === 0 ? <Card className="empty-state"><Search size={26} aria-hidden="true" /><h2>没有找到符合条件的题目</h2><p>试试其他题号或关键词，也可以清除筛选重新开始。</p><Button variant="outline" onClick={resetFilters}>清除筛选</Button></Card> : filteredQuestions.slice(0, visibleCount).map((item) => {
          const attempt = attemptsByQid.get(item.qid);
          const assessment = attempt ? [...attempt.assessments].reverse().find((entry) => !entry.revokedAt) : null;
          const isDue = Boolean(assessment?.nextReviewOn && assessment.nextReviewOn <= localToday() && !assessment.queueDismissedAt);
          const stateLabel = isDue ? "待复习" : assessment ? "已自评" : attempt?.revealedAt ? "已揭晓" : attempt ? "作答中" : "未开始";
          return (
            <Card className="question-result-card" key={item.qid}>
              <Link className="question-result-link" href={"/questions/" + item.qid + "/"} onClick={preserveFilters}>
                <span className="question-result-meta"><span className="question-id">{item.qid}</span>{item.priority && <Badge variant={item.priority === "P0" ? "default" : "outline"}>{item.priority}</Badge>}{item.kind === "company" && <Badge variant="secondary">{item.company} · 扩展问法</Badge>}</span>
                <strong className="question-result-title">{item.title}</strong>
                <span className="question-result-detail">{item.topicIds.map((id) => { const topic = topics.find((entry) => entry.topicId === id); return topic ? id + " · " + topic.subtopic : id; }).join(" / ")}</span>
                <span className="question-result-tags">{item.tags.slice(0, 4).map((tag) => <Badge key={tag} variant="subtle">{tag}</Badge>)}</span>
                {item.kind === "company" && <span className="question-source-note">{item.source.filename} · 来源年份与核验边界按原资料显示</span>}
              </Link>
              {progressState === "ready" && <Badge className="question-state-badge" variant={isDue ? "default" : "outline"}>{stateLabel}</Badge>}
            </Card>
          );
        })}
      </div>
      {filteredQuestions.length > visibleCount && <div className="load-more-row"><Button variant="outline" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>再显示 {Math.min(PAGE_SIZE, filteredQuestions.length - visibleCount)} 道</Button></div>}
    </div>
  );
}
