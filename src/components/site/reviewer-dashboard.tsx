"use client";

import dynamic from "next/dynamic";
import { Check, ChevronRight, GitCompareArrows, LoaderCircle, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/cn";

const CoachMarkdown = dynamic(() => import("@/components/site/coach-markdown").then((module) => module.CoachMarkdown), {
  loading: () => <p className="markdown-preview-loading" aria-live="polite">正在加载 Markdown 预览…</p>,
});
const expectedAccountHeaderName = "x-frontend-atlas-account-id";

type ReviewListItem = {
  id: string;
  qid: string;
  title: string;
  summary: string;
  sourceOverrideVersion: number;
  baseContentVersion: string;
  createdAt: string;
  author: { id: string; name: string };
  expired: boolean;
};

type ProposalDetail = {
  kind: "found";
  proposal: ReviewListItem & {
    ownerUserId: string;
    sourceGenerationId: string;
    checkpoints: string[];
    explanationMarkdown: string;
    status: "submitted" | "withdrawn" | "approved" | "rejected" | "published";
  };
  author: { id: string; name: string };
  baseline: { qid: string; title: string; explanationMarkdown: string; checkpoints: string[]; contentVersion: string; sha256: string };
  diff: {
    title: { changed: boolean; before: string; after: string };
    explanationMarkdown: { changed: boolean; lines: Array<{ kind: "context" | "remove" | "add"; text: string }> };
    checkpoints: { changed: boolean; before: string[]; after: string[] };
  };
  review: { decision: "approved" | "rejected"; comment: string; decidedAt: string } | null;
  conflict: "legacy_base_unverifiable" | "proposal_expired" | "public_base_changed" | null;
};

type Decision = "approved" | "rejected";

async function readJson(response: Response) {
  return response.json().catch(() => null) as Promise<Record<string, unknown> | null>;
}

function FieldHeader({ children, changed }: { children: React.ReactNode; changed: boolean }) {
  return <h3>{children}<Badge variant={changed ? "default" : "secondary"}>{changed ? "有变更" : "无变更"}</Badge></h3>;
}

function TextPair({ before, after }: { before: string; after: string }) {
  return (
    <div className="reviewer-text-pair">
      <section aria-label="当前公共内容"><small>当前公共基线</small><p>{before}</p></section>
      <section aria-label="提案快照"><small>提案冻结快照</small><p>{after}</p></section>
    </div>
  );
}

function CheckpointList({ title, values }: { title: string; values: string[] }) {
  return <section><small>{title}</small><ol>{values.map((value, index) => <li key={`${index}-${value}`}>{value}</li>)}</ol></section>;
}

function statusError(data: Record<string, unknown> | null) {
  if (data?.error === "self_review_forbidden") return "不能审核自己提交的提案。";
  if (data?.error === "public_base_conflict") return "公共题库基线已变化；本提案必须基于新的私人 revision 重新提交。";
  if (data?.error === "proposal_expired") return "提案已超过 30 天审核期限，不能再作出决定。";
  if (data?.error === "proposal_already_processed") return "该提案已被撤回或由另一位 reviewer 完成处理。";
  if (data?.error === "proposal_version_conflict") return "提案版本核对失败，未写入审核决定。";
  if (data?.error === "forbidden") return "reviewer 权限已撤销，本次操作未执行。";
  if (data?.error === "account_changed") return "账号已切换；旧页面请求已拒绝，请重新加载后再审核。";
  return "审核操作失败，请刷新后核对当前状态。";
}

export function ReviewerDashboard({ reviewerUserId }: { reviewerUserId: string }) {
  const [items, setItems] = useState<ReviewListItem[]>([]);
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const selectedIdRef = useRef<string | null>(null);
  const listEpoch = useRef(0);
  const detailEpoch = useRef(0);
  const mutationEpoch = useRef(0);
  const listRequest = useRef<AbortController | null>(null);
  const detailRequest = useRef<AbortController | null>(null);
  const mutationRequest = useRef<AbortController | null>(null);

  const loadDetail = useCallback(async (proposalId: string) => {
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    const epoch = ++detailEpoch.current;
    setDetailLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/reviewer/proposals/${encodeURIComponent(proposalId)}`, {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        headers: { [expectedAccountHeaderName]: reviewerUserId },
      });
      const data = await readJson(response);
      if (controller.signal.aborted || detailEpoch.current !== epoch) return;
      if (!response.ok) throw new Error(statusError(data));
      setDetail(data as unknown as ProposalDetail);
    } catch (cause) {
      if (!controller.signal.aborted && detailEpoch.current === epoch) setError(cause instanceof Error ? cause.message : "无法读取提案详情。");
    } finally {
      if (!controller.signal.aborted && detailEpoch.current === epoch) setDetailLoading(false);
    }
  }, [reviewerUserId]);

  const loadList = useCallback(async (append: boolean, cursor?: string | null) => {
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    const epoch = ++listEpoch.current;
    setLoading(true);
    setError("");
    try {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const response = await fetch(`/api/reviewer/proposals${query}`, {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        headers: { [expectedAccountHeaderName]: reviewerUserId },
      });
      const data = await readJson(response);
      if (!response.ok) throw new Error(statusError(data));
      if (controller.signal.aborted || listEpoch.current !== epoch) return;
      const proposals = (data?.proposals ?? []) as ReviewListItem[];
      setItems((current) => append ? [...current, ...proposals] : proposals);
      setNextCursor((data?.nextCursor as string | null | undefined) ?? null);
      if (!append) {
        const retainedId = selectedIdRef.current && proposals.some((proposal) => proposal.id === selectedIdRef.current)
          ? selectedIdRef.current
          : null;
        const initialId = retainedId ?? proposals[0]?.id ?? null;
        selectedIdRef.current = initialId;
        setSelectedId(initialId);
        setDetail(null);
        if (initialId) void loadDetail(initialId);
        else {
          detailRequest.current?.abort();
          detailEpoch.current += 1;
          setDetailLoading(false);
        }
      }
    } catch (cause) {
      if (!controller.signal.aborted && listEpoch.current === epoch) setError(cause instanceof Error ? cause.message : "无法读取待审核提案。");
    } finally {
      if (!controller.signal.aborted && listEpoch.current === epoch) setLoading(false);
    }
  }, [loadDetail, reviewerUserId]);

  useEffect(() => {
    void Promise.resolve().then(() => loadList(false));
    if (typeof BroadcastChannel === "undefined") {
      return () => {
        listEpoch.current += 1;
        detailEpoch.current += 1;
        mutationEpoch.current += 1;
        listRequest.current?.abort();
        detailRequest.current?.abort();
        mutationRequest.current?.abort();
      };
    }
    const channel = new BroadcastChannel("frontend-atlas-site-account");
    channel.onmessage = () => {
      listEpoch.current += 1;
      detailEpoch.current += 1;
      mutationEpoch.current += 1;
      listRequest.current?.abort();
      detailRequest.current?.abort();
      mutationRequest.current?.abort();
      selectedIdRef.current = null;
      setItems([]);
      setDetail(null);
      setSelectedId(null);
      setNextCursor(null);
      setDecision(null);
      setSaving(false);
      setDetailLoading(false);
      void loadList(false);
    };
    return () => {
      listEpoch.current += 1;
      detailEpoch.current += 1;
      mutationEpoch.current += 1;
      listRequest.current?.abort();
      detailRequest.current?.abort();
      mutationRequest.current?.abort();
      channel.close();
    };
  }, [loadList]);

  function selectProposal(proposalId: string) {
    selectedIdRef.current = proposalId;
    setSelectedId(proposalId);
    setDetail(null);
    void loadDetail(proposalId);
  }

  async function submitDecision() {
    if (!detail || !decision || saving) return;
    const trimmed = comment.trim();
    if (!trimmed) {
      setError("请填写审核说明，作为不可变审核记录的一部分。");
      return;
    }
    mutationRequest.current?.abort();
    const controller = new AbortController();
    mutationRequest.current = controller;
    const epoch = ++mutationEpoch.current;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/reviewer/proposals/${encodeURIComponent(detail.proposal.id)}`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-frontend-atlas-request": "1",
          [expectedAccountHeaderName]: reviewerUserId,
        },
        body: JSON.stringify({
          decision,
          comment: trimmed,
          expectedSourceGenerationId: detail.proposal.sourceGenerationId,
          expectedSourceOverrideVersion: detail.proposal.sourceOverrideVersion,
        }),
      });
      const data = await readJson(response);
      if (controller.signal.aborted || mutationEpoch.current !== epoch) return;
      if (!response.ok) throw new Error(statusError(data));
      setDecision(null);
      setComment("");
      setSaving(false);
      await loadList(false);
    } catch (cause) {
      if (!controller.signal.aborted && mutationEpoch.current === epoch && !(cause instanceof Error && cause.name === "AbortError")) {
        setError(cause instanceof Error ? cause.message : "审核操作失败。");
      }
    } finally {
      if (!controller.signal.aborted && mutationEpoch.current === epoch) setSaving(false);
    }
  }

  const canDecide = detail?.proposal.status === "submitted" && !detail.conflict;

  return (
    <div className="reviewer-dashboard">
      <header className="page-intro">
        <span className="eyebrow">TRUSTED REVIEW</span>
        <div className="intro-row">
          <div><h1>公共题库变更审核</h1><p>基于服务端公共基线和不可变私人快照作出决定；批准不等于发布。</p></div>
          <Button type="button" variant="outline" onClick={() => void loadList(false)} disabled={loading}><RefreshCw aria-hidden="true" />刷新</Button>
        </div>
      </header>

      {error && <p className="assessment-error" role="alert">{error}</p>}
      <div className="reviewer-layout">
        <Card className="reviewer-queue" aria-label="待审核提案">
          <div className="card-heading"><ShieldCheck aria-hidden="true" /><span>待审核队列</span><Badge variant="secondary">{items.length}</Badge></div>
          {loading && items.length === 0 ? <p aria-live="polite"><LoaderCircle className="animate-spin" aria-hidden="true" />正在读取…</p> : items.length === 0 ? <p>当前没有待审核提案。</p> : (
            <ul>{items.map((item) => (
              <li key={item.id}>
                <button type="button" className={cn(selectedId === item.id && "is-active")} onClick={() => void selectProposal(item.id)} aria-pressed={selectedId === item.id}>
                  <span><strong>{item.qid} · {item.title}</strong><small>{item.author.name} · 私人 v{item.sourceOverrideVersion}{item.expired ? " · 已过期" : ""}</small></span>
                  <ChevronRight aria-hidden="true" />
                </button>
              </li>
            ))}</ul>
          )}
          {nextCursor && <Button type="button" variant="ghost" onClick={() => void loadList(true, nextCursor)} disabled={loading}>加载更多</Button>}
        </Card>

        <div className="reviewer-detail" aria-live="polite">
          {detailLoading ? <Card className="reviewer-empty"><LoaderCircle className="animate-spin" aria-hidden="true" /><p>正在生成可信 diff…</p></Card> : !detail ? <Card className="reviewer-empty"><GitCompareArrows aria-hidden="true" /><p>选择一份提案查看字段级差异。</p></Card> : (
            <>
              <Card className="reviewer-summary">
                <div className="reviewer-summary-heading"><div><span className="eyebrow">{detail.proposal.qid}</span><h2>{detail.proposal.title}</h2></div><Badge>{detail.proposal.status}</Badge></div>
                <dl>
                  <div><dt>申请人</dt><dd>{detail.author.name}（{detail.author.id}）</dd></div>
                  <div><dt>私人源版本</dt><dd>{detail.proposal.sourceGenerationId} / v{detail.proposal.sourceOverrideVersion}</dd></div>
                  <div><dt>公共基线</dt><dd>{detail.proposal.baseContentVersion}</dd></div>
                  <div><dt>提交时间</dt><dd>{new Date(detail.proposal.createdAt).toLocaleString("zh-CN")}</dd></div>
                </dl>
                <section><h3>申请人摘要</h3><p>{detail.proposal.summary}</p></section>
                {detail.conflict && <p className="assessment-error" role="status">{detail.conflict === "legacy_base_unverifiable" ? "历史提案缺少可信基线哈希，禁止审批。" : detail.conflict === "proposal_expired" ? "提案已超过 30 天审核期限，禁止审批。请申请人基于新的私人 revision 重新提交。" : "公共题库已偏离提案基线，禁止审批。"}</p>}
              </Card>

              <Card className="reviewer-diff-card">
                <FieldHeader changed={detail.diff.title.changed}>题干</FieldHeader>
                <TextPair before={detail.diff.title.before} after={detail.diff.title.after} />
              </Card>
              <Card className="reviewer-diff-card">
                <FieldHeader changed={detail.diff.explanationMarkdown.changed}>Markdown 讲解 diff</FieldHeader>
                <div className="reviewer-line-diff" role="region" aria-label="Markdown 行级差异" tabIndex={0}>
                  {detail.diff.explanationMarkdown.lines.map((line, index) => <div key={index} className={`is-${line.kind}`}><span aria-hidden="true">{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}</span><code>{line.text || " "}</code></div>)}
                </div>
                <div className="reviewer-markdown-pair">
                  <section><small>当前公共基线预览</small><CoachMarkdown source={detail.baseline.explanationMarkdown} streaming={false} /></section>
                  <section><small>提案冻结快照预览</small><CoachMarkdown source={detail.proposal.explanationMarkdown} streaming={false} /></section>
                </div>
              </Card>
              <Card className="reviewer-diff-card">
                <FieldHeader changed={detail.diff.checkpoints.changed}>检查点</FieldHeader>
                <div className="reviewer-text-pair"><CheckpointList title="当前公共基线" values={detail.diff.checkpoints.before} /><CheckpointList title="提案冻结快照" values={detail.diff.checkpoints.after} /></div>
              </Card>
              <Card className="reviewer-actions">
                <p>批准只写入审核审计；公共题库仍需 operator CLI 生成独立 Git commit，并在合并后 reconcile。</p>
                <div><Button type="button" onClick={() => { setComment(""); setDecision("approved"); }} disabled={!canDecide}><Check aria-hidden="true" />批准</Button><Button type="button" variant="destructive" onClick={() => { setComment(""); setDecision("rejected"); }} disabled={!canDecide}><X aria-hidden="true" />拒绝</Button></div>
              </Card>
            </>
          )}
        </div>
      </div>

      <AlertDialog open={decision !== null} onOpenChange={(open) => { if (!open && !saving) setDecision(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>{decision === "approved" ? "批准这份提案？" : "拒绝这份提案？"}</AlertDialogTitle><AlertDialogDescription>决定会绑定当前 reviewer、提案源版本、公共基线哈希和时间，写入后不可更改。</AlertDialogDescription></AlertDialogHeader>
          <div><Label className="field-label" htmlFor="review-comment">审核说明</Label><Textarea id="review-comment" value={comment} onChange={(event) => setComment(event.target.value)} maxLength={4_000} rows={6} /></div>
          <AlertDialogFooter><AlertDialogCancel disabled={saving}>取消</AlertDialogCancel><AlertDialogAction variant={decision === "rejected" ? "destructive" : "default"} disabled={saving} onClick={(event) => { event.preventDefault(); void submitDecision(); }}>{saving ? "正在写入…" : "确认并写入审计"}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
