"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { GitPullRequest, LoaderCircle, LockKeyhole, Maximize2, Minimize2, PencilLine, RotateCcw, Save } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { QuestionPrivateOverride } from "@/lib/question-private-overrides";

const CoachMarkdown = dynamic(() => import("@/components/site/coach-markdown").then((module) => module.CoachMarkdown), {
  loading: () => <p className="markdown-preview-loading" aria-live="polite">正在加载 Markdown 预览…</p>,
});

type SiteAccount = { id: string; name: string; email: string };
type AccountStatus = { account: SiteAccount | null };
export type QuestionPrivateSelection = { ownerUserId: string; override: QuestionPrivateOverride | null } | null;

const requestHeaderName = "x-frontend-atlas-request";
const expectedAccountHeaderName = "x-frontend-atlas-account-id";

async function readJson(response: Response) {
  return response.json().catch(() => null) as Promise<Record<string, unknown> | null>;
}

function errorMessage(data: Record<string, unknown> | null, fallback: string) {
  if (data?.error === "account_changed") return "站点账号已变化，已停止保存。请重新打开编辑器。";
  if (data?.error === "version_conflict") return "另一个标签页已经更新这份私人版本。已载入较新版本，请核对后再保存。";
  return typeof data?.message === "string" ? data.message : fallback;
}

export function QuestionPrivateEditor({
  qid,
  contentVersion,
  publicTitle,
  publicExplanationMarkdown,
  publicCheckpoints,
  onSelectionChange,
}: {
  qid: string;
  contentVersion: string;
  publicTitle: string;
  publicExplanationMarkdown: string;
  publicCheckpoints: string[];
  onSelectionChange: (selection: QuestionPrivateSelection) => void;
}) {
  const [account, setAccount] = useState<SiteAccount | null>(null);
  const [override, setOverride] = useState<QuestionPrivateOverride | null>(null);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [title, setTitle] = useState(publicTitle);
  const [explanation, setExplanation] = useState(publicExplanationMarkdown);
  const [checkpointText, setCheckpointText] = useState(publicCheckpoints.join("\n"));
  const [preview, setPreview] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const requestEpoch = useRef(0);
  const pendingWrite = useRef<AbortController | null>(null);

  const applyOverride = useCallback((owner: SiteAccount, value: QuestionPrivateOverride | null) => {
    setAccount(owner);
    setOverride(value);
    onSelectionChange({ ownerUserId: owner.id, override: value });
  }, [onSelectionChange]);

  useEffect(() => {
    const controller = new AbortController();
    const epoch = ++requestEpoch.current;
    Promise.resolve().then(() => {
      if (controller.signal.aborted || requestEpoch.current !== epoch) return null;
      pendingWrite.current?.abort();
      pendingWrite.current = null;
      setSaving(false);
      setLoading(true);
      setError("");
      setNotice("");
      setAccount(null);
      setOverride(null);
      setEditorOpen(false);
      setFullscreen(false);
      setResetOpen(false);
      onSelectionChange(null);
      return fetch("/api/site-account", { credentials: "same-origin", cache: "no-store", signal: controller.signal });
    })
      .then(async (response) => {
        if (!response || controller.signal.aborted || requestEpoch.current !== epoch) return null;
        const data = await readJson(response) as AccountStatus | null;
        if (controller.signal.aborted || requestEpoch.current !== epoch) return null;
        if (!response.ok || !data) throw new Error("无法读取站点账号。 ");
        if (!data.account) {
          setAccount(null);
          setOverride(null);
          onSelectionChange({ ownerUserId: "", override: null });
          return null;
        }
        const privateResponse = await fetch(`/api/questions/${encodeURIComponent(qid)}/private-override`, {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
          headers: { [expectedAccountHeaderName]: data.account.id },
        });
        const privateData = await readJson(privateResponse);
        if (controller.signal.aborted || requestEpoch.current !== epoch) return null;
        if (!privateResponse.ok) throw new Error(errorMessage(privateData, "无法读取私人版本。"));
        applyOverride(data.account, (privateData?.override ?? null) as QuestionPrivateOverride | null);
        return null;
      })
      .catch((cause: unknown) => {
        if (requestEpoch.current !== epoch || (cause instanceof Error && cause.name === "AbortError")) return;
        setAccount(null);
        setOverride(null);
        onSelectionChange(null);
        setError(cause instanceof Error ? cause.message : "无法读取私人版本。");
      })
      .finally(() => {
        if (!controller.signal.aborted && requestEpoch.current === epoch) setLoading(false);
      });
    return () => {
      controller.abort();
      pendingWrite.current?.abort();
    };
  }, [applyOverride, onSelectionChange, qid, reloadKey]);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("frontend-atlas-site-account");
    channel.onmessage = () => {
      // Hide stale private content synchronously, before the next account read begins.
      requestEpoch.current += 1;
      pendingWrite.current?.abort();
      setAccount(null);
      setOverride(null);
      setEditorOpen(false);
      setResetOpen(false);
      setFullscreen(false);
      setSaving(false);
      setLoading(true);
      onSelectionChange(null);
      setReloadKey((value) => value + 1);
    };
    return () => channel.close();
  }, [onSelectionChange]);

  function openEditor() {
    setTitle(override?.title ?? publicTitle);
    setExplanation(override?.explanationMarkdown ?? publicExplanationMarkdown);
    setCheckpointText((override?.checkpoints ?? publicCheckpoints).join("\n"));
    setNotice("");
    setError("");
    setPreview(false);
    setFullscreen(false);
    setEditorOpen(true);
  }

  function loadOverrideIntoEditor(value: QuestionPrivateOverride) {
    setTitle(value.title);
    setExplanation(value.explanationMarkdown);
    setCheckpointText(value.checkpoints.join("\n"));
  }

  async function save() {
    if (!account || saving) return;
    const epoch = requestEpoch.current;
    const checkpoints = checkpointText.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    if (!title.trim() || !explanation.trim() || checkpoints.length === 0) {
      setError("题干、参考讲解和至少一个自评检查点都不能为空。");
      return;
    }
    if (checkpoints.length > 20 || checkpoints.some((value) => value.length > 2_000)) {
      setError("自评检查点最多 20 项，每项最多 2000 个字符。");
      return;
    }
    const controller = new AbortController();
    pendingWrite.current = controller;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/questions/${encodeURIComponent(qid)}/private-override`, {
        method: "PATCH",
        signal: controller.signal,
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          [requestHeaderName]: "1",
          [expectedAccountHeaderName]: account.id,
        },
        body: JSON.stringify({
          expectedVersion: override?.version ?? null,
          expectedGenerationId: override?.generationId ?? null,
          title,
          explanationMarkdown: explanation,
          checkpoints,
        }),
      });
      const data = await readJson(response);
      if (requestEpoch.current !== epoch) return;
      if (!response.ok) {
        if (data?.error === "version_conflict" && data.override) {
          const current = data.override as QuestionPrivateOverride;
          applyOverride(account, current);
          loadOverrideIntoEditor(current);
        }
        throw new Error(errorMessage(data, "私人版本未能保存。"));
      }
      const saved = data?.override as QuestionPrivateOverride;
      applyOverride(account, saved);
      setNotice(`私人版本 v${saved.version} 已保存到此站点账号。`);
      setEditorOpen(false);
    } catch (cause) {
      if (requestEpoch.current === epoch && !(cause instanceof Error && cause.name === "AbortError")) {
        setError(cause instanceof Error ? cause.message : "私人版本未能保存。");
      }
    } finally {
      if (pendingWrite.current === controller) pendingWrite.current = null;
      if (requestEpoch.current === epoch) setSaving(false);
    }
  }

  async function reset() {
    if (!account || !override || saving) return;
    const epoch = requestEpoch.current;
    const controller = new AbortController();
    pendingWrite.current = controller;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/questions/${encodeURIComponent(qid)}/private-override`, {
        method: "DELETE",
        signal: controller.signal,
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          [requestHeaderName]: "1",
          [expectedAccountHeaderName]: account.id,
        },
        body: JSON.stringify({ expectedVersion: override.version, expectedGenerationId: override.generationId }),
      });
      const data = await readJson(response);
      if (requestEpoch.current !== epoch) return;
      if (!response.ok) {
        if (data?.error === "version_conflict" && data.override) applyOverride(account, data.override as QuestionPrivateOverride);
        throw new Error(errorMessage(data, "无法恢复公共版本。"));
      }
      applyOverride(account, null);
      setNotice("已移除私人覆盖，当前重新显示公共题库版本。历史练习记录未删除。");
      setResetOpen(false);
    } catch (cause) {
      if (requestEpoch.current === epoch && !(cause instanceof Error && cause.name === "AbortError")) {
        setError(cause instanceof Error ? cause.message : "无法恢复公共版本。");
      }
    } finally {
      if (pendingWrite.current === controller) pendingWrite.current = null;
      if (requestEpoch.current === epoch) setSaving(false);
    }
  }

  return (
    <>
      <Card className="question-private-card" data-testid="question-private-editor">
        <div className="card-heading"><LockKeyhole size={18} aria-hidden="true" /><span>我的私人版本</span></div>
        {loading ? <p><LoaderCircle className="animate-spin" aria-hidden="true" /> 正在读取站点账号…</p> : account ? (
          <>
            <p>{override ? `已应用 v${override.version}，仅 ${account.email} 可见。` : "当前使用公共题库内容；可为这个账号保存私人覆盖。"}</p>
            {override && <small>基于公共内容 {override.baseContentVersion} · {new Date(override.updatedAt).toLocaleString("zh-CN")}</small>}
            {override && override.baseContentVersion !== contentVersion && <p className="content-version-warning" role="status">公共题库已更新；这份私人版本仍保留原基线。再次保存会以当前公共版本作为新基线。</p>}
            <div className="private-editor-actions">
              <Button type="button" variant="outline" size="sm" onClick={openEditor} data-testid="question-private-open"><PencilLine aria-hidden="true" />{override ? "编辑私人版本" : "创建私人版本"}</Button>
              {override && <Button type="button" variant="ghost" size="sm" onClick={() => setResetOpen(true)} data-testid="question-private-reset"><RotateCcw aria-hidden="true" />恢复公共版本</Button>}
            </div>
          </>
        ) : (
          <p>登录站点账号后，才能跨刷新与重启保存自己的题干、讲解和检查点。<Link href="/coach/sessions/">前往登录</Link></p>
        )}
        <div className="private-proposal-note"><GitPullRequest size={16} aria-hidden="true" /><span>私人保存不会修改公共题库。以后同步公共内容需另行提交变更申请并经过审核。</span></div>
        {notice && <p className="assessment-success" role="status">{notice}</p>}
        {error && !editorOpen && <p className="assessment-error" role="alert">{error}</p>}
      </Card>

      <Dialog open={editorOpen} onOpenChange={(open) => { if (!saving) { setEditorOpen(open); if (!open) setFullscreen(false); } }}>
        <DialogContent className={`question-private-dialog${fullscreen ? " is-fullscreen" : ""}`}>
          <div className="private-dialog-heading">
            <DialogHeader>
              <DialogTitle>编辑 {qid} 的私人版本</DialogTitle>
              <DialogDescription>保存到当前登录账号的 SQLite 覆盖层。公共题库保持不变；不会自动提交公开申请。</DialogDescription>
            </DialogHeader>
            <Button type="button" variant="outline" size="sm" onClick={() => setFullscreen((value) => !value)} aria-pressed={fullscreen} data-testid="question-private-fullscreen">
              {fullscreen ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}{fullscreen ? "退出全屏" : "全屏编辑"}
            </Button>
          </div>
          <div className="private-editor-fields">
            <div>
              <Label className="field-label" htmlFor="private-question-title">题干</Label>
              <Input id="private-question-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={500} />
            </div>
            <div>
              <div className="answer-entry-toolbar">
                <Label className="field-label" htmlFor={preview ? undefined : "private-question-explanation"}>参考讲解（Markdown）</Label>
                <div className="answer-mode-toggle" role="group" aria-label="参考讲解显示模式">
                  <Button type="button" size="sm" variant={!preview ? "secondary" : "ghost"} aria-pressed={!preview} onClick={() => setPreview(false)}>编辑</Button>
                  <Button type="button" size="sm" variant={preview ? "secondary" : "ghost"} aria-pressed={preview} onClick={() => setPreview(true)}>预览</Button>
                </div>
              </div>
              {preview ? (
                <div className="private-explanation-preview" role="region" aria-label="私人参考讲解预览" tabIndex={0}>
                  <CoachMarkdown source={explanation} streaming={false} />
                </div>
              ) : (
                <Textarea id="private-question-explanation" className="private-explanation-input" value={explanation} onChange={(event) => setExplanation(event.target.value)} rows={18} maxLength={200_000} />
              )}
            </div>
            <div>
              <Label className="field-label" htmlFor="private-question-checkpoints">自评检查点（每行一项）</Label>
              <Textarea id="private-question-checkpoints" value={checkpointText} onChange={(event) => setCheckpointText(event.target.value)} rows={7} />
            </div>
          </div>
          {error && <p className="assessment-error" role="alert">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditorOpen(false)} disabled={saving}>取消</Button>
            <Button type="button" onClick={() => void save()} disabled={saving} data-testid="question-private-save">{saving ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Save aria-hidden="true" />}保存私人版本</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={resetOpen} onOpenChange={(open) => { if (!saving) setResetOpen(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>恢复公共题库版本？</AlertDialogTitle>
            <AlertDialogDescription>这会删除当前账号对 {qid} 的私人覆盖，但不会删除作答、自评或修订历史，也不会修改公共题库。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={saving} onClick={(event) => { event.preventDefault(); void reset(); }} data-testid="question-private-reset-confirm">确认移除私人覆盖</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
