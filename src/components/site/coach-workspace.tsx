"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowUpRight, CheckCircle2, CircleHelp, LoaderCircle, LogOut, RotateCw, Sparkles, Square, WandSparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getStudySnapshot, saveAttempt, saveDraft, type Attempt } from "@/lib/study-store";

const API_ORIGIN = "http://127.0.0.1:4317";
const LOCAL_MODE = process.env.NEXT_PUBLIC_FRONTEND_ATLAS_LOCAL_MODE === "1";

export type CoachQuestion = {
  qid: string;
  title: string;
  primary: string;
  subtopic: string;
  kind: "master" | "company";
};

type AccountSummary = {
  clientId: string;
  email: string | null;
  name: string | null;
  active: boolean;
  resumable: boolean;
  planUsageEnabled: boolean;
  expiresAt: number | null;
  pendingLocalClear: boolean;
};

type SessionStatus = {
  authenticated: boolean;
  account: AccountSummary | null;
  profiles: AccountSummary[];
  pendingRegistrations: Array<{ clientId: string; createdAt: string }>;
  allowedModelsAvailable: boolean;
};

type ModelChoice = { slug: string; displayName: string };
type Mode = "hint" | "explain" | "critique";

const initialStatus: SessionStatus = { authenticated: false, account: null, profiles: [], pendingRegistrations: [], allowedModelsAvailable: false };

async function requestJson(path: string, init: RequestInit = {}) {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    ...init,
    credentials: "include",
    cache: "no-store",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.message === "string" ? data.message : "本地服务请求失败。");
  }
  return data;
}

function makeAttempt(qid: string, contentVersion: string): Attempt {
  const now = new Date().toISOString();
  return {
    attemptId: crypto.randomUUID(),
    qid,
    contentVersion,
    startedAt: now,
    originalAnswer: "",
    revisions: [],
    revealedAt: null,
    skipped: false,
    assessments: [],
    updatedAt: now,
  };
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return <p className="coach-note coach-note-error" role="alert"><AlertCircle size={16} aria-hidden="true" />{children}</p>;
}

export function CoachWorkspace({ questions, contentVersion, initialQuestionId }: { questions: CoachQuestion[]; contentVersion: string; initialQuestionId: string }) {
  const [selectedId, setSelectedId] = useState(initialQuestionId);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("critique");
  const [answer, setAnswer] = useState("");
  const [answerLoading, setAnswerLoading] = useState(false);
  const [localSaveState, setLocalSaveState] = useState<"loading" | "ready" | "saved" | "error">("loading");
  const [localSaveMessage, setLocalSaveMessage] = useState("");
  const [status, setStatus] = useState<SessionStatus>(initialStatus);
  const [statusLoading, setStatusLoading] = useState(true);
  const [backendAvailable, setBackendAvailable] = useState<boolean | null>(null);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [model, setModel] = useState("");
  const [modelsLoading, setModelsLoading] = useState(false);
  const [result, setResult] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authWaiting, setAuthWaiting] = useState(false);
  const [fallbackAuthorizeUrl, setFallbackAuthorizeUrl] = useState("");
  const [logoutBusy, setLogoutBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const authPollRef = useRef<AbortController | null>(null);
  const attemptRef = useRef<Attempt | null>(null);
  const currentQidRef = useRef(selectedId);
  const pendingDraftRef = useRef<{ qid: string; text: string } | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushDraftRef = useRef<() => Promise<void>>(async () => {});

  const selectedQuestion = useMemo(() => questions.find((question) => question.qid === selectedId) ?? questions[0], [questions, selectedId]);
  const masterQuestionCount = useMemo(() => questions.filter((question) => question.kind === "master").length, [questions]);
  const companyVariantCount = useMemo(() => questions.filter((question) => question.kind === "company").length, [questions]);
  const filteredQuestions = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    const matches = normalized
      ? questions.filter((question) => `${question.qid} ${question.title} ${question.primary} ${question.subtopic}`.toLocaleLowerCase("zh-CN").includes(normalized))
      : questions;
    return matches.slice(0, 80);
  }, [query, questions]);

  useEffect(() => {
    currentQidRef.current = selectedId;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setAnswerLoading(true);
      setLocalSaveState("loading");
    });
    attemptRef.current = null;
    Promise.resolve().then(getStudySnapshot).then((snapshot) => {
      if (!active) return;
      const latest = snapshot.attempts
        .filter((item) => item.qid === selectedId)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] ?? null;
      if (latest && latest.contentVersion === contentVersion) {
        attemptRef.current = latest;
        const revision = snapshot.drafts.find((item) => item.qid === selectedId && item.attemptId === latest.attemptId && item.kind === "revision");
        setAnswer(latest.revealedAt && revision ? revision.text : latest.originalAnswer);
        setLocalSaveState("saved");
        setLocalSaveMessage("回答草稿已保存在本设备的学习记录中。");
      } else {
        setAnswer("");
        setLocalSaveState("ready");
        setLocalSaveMessage(latest ? "发现较早版本的练习记录；为避免混用内容版本，本页不会自动载入它。" : "回答草稿会保存在本设备的学习记录中。");
      }
    }).catch(() => {
      if (!active) return;
      setAnswer("");
      setLocalSaveState("error");
      setLocalSaveMessage("无法读取本设备练习记录。你仍可使用提示；这次输入不会保存到学习记录。");
    }).finally(() => {
      if (active) setAnswerLoading(false);
    });
    return () => {
      active = false;
    };
  }, [selectedId, contentVersion]);

  const flushDraft = useCallback(async () => {
    const pending = pendingDraftRef.current;
    if (!pending) return;
    pendingDraftRef.current = null;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    try {
      let attempt = attemptRef.current;
      if (!attempt || attempt.qid !== pending.qid || attempt.contentVersion !== contentVersion) {
        attempt = makeAttempt(pending.qid, contentVersion);
      }
      const updatedAt = new Date().toISOString();
      if (attempt.revealedAt) {
        await saveDraft({
          qid: attempt.qid,
          attemptId: attempt.attemptId,
          contentVersion: attempt.contentVersion,
          kind: "revision",
          text: pending.text,
          savedAt: updatedAt,
        });
      } else {
        attempt = { ...attempt, originalAnswer: pending.text, updatedAt };
        await saveAttempt(attempt);
        attemptRef.current = attempt;
      }
      if (currentQidRef.current === pending.qid) {
        setLocalSaveState("saved");
        setLocalSaveMessage("回答草稿已保存在本设备的学习记录中。");
      }
    } catch {
      if (currentQidRef.current === pending.qid) {
        setLocalSaveState("error");
        setLocalSaveMessage("本设备保存失败；复制回答后再离开页面。");
      }
    }
  }, [contentVersion]);
  useEffect(() => {
    flushDraftRef.current = flushDraft;
  }, [flushDraft]);

  useEffect(() => () => {
    authPollRef.current?.abort();
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    void flushDraftRef.current();
  }, []);

  const refreshSession = useCallback(async () => {
    if (!LOCAL_MODE) return;
    setStatusLoading(true);
    try {
      const data = await requestJson("/api/session");
      setStatus(data as SessionStatus);
      setBackendAvailable(true);
      setError("");
    } catch (cause) {
      setBackendAvailable(false);
      setStatus(initialStatus);
      if (cause instanceof Error && !cause.message.includes("本地服务")) setError(cause.message);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => { void refreshSession(); });
    const onFocus = () => { void refreshSession(); };
    window.addEventListener("focus", onFocus);
    const params = new URLSearchParams(window.location.search);
    if (params.get("signin") === "connected") {
      queueMicrotask(() => setInfo("ChatGPT 账号已连接。你可以在本机使用可用模型生成练习反馈。"));
      window.history.replaceState(null, "", window.location.pathname);
    }
    if (params.get("signin") === "failed") {
      queueMicrotask(() => setError("ChatGPT 登录没有完成；已验证的账号凭据保持不变。如果有待完成注册，可在下方继续。"));
      window.history.replaceState(null, "", window.location.pathname);
    }
    if (params.get("signin") === "cancelled") {
      queueMicrotask(() => setInfo("你取消了 ChatGPT 授权。没有交换登录码，也没有发起模型请求。"));
      window.history.replaceState(null, "", window.location.pathname);
    }
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshSession]);

  const loadModels = useCallback(async () => {
    if (!status.authenticated || !status.allowedModelsAvailable) return;
    setModelsLoading(true);
    try {
      const data = await requestJson("/api/models");
      const available = Array.isArray(data.models) ? data.models as ModelChoice[] : [];
      setModels(available);
      setModel((current) => available.some((item) => item.slug === current) ? current : (available[0]?.slug ?? ""));
      setError("");
    } catch (cause) {
      setModels([]);
      setModel("");
      setError(cause instanceof Error ? cause.message : "无法读取模型列表。");
    } finally {
      setModelsLoading(false);
    }
  }, [status.authenticated, status.allowedModelsAvailable]);

  useEffect(() => {
    queueMicrotask(() => {
      setModels([]);
      setModel("");
      if (status.authenticated && status.allowedModelsAvailable) void loadModels();
    });
  }, [loadModels, status.authenticated, status.allowedModelsAvailable, status.account?.clientId]);

  async function startSignIn(modeValue: "new" | "saved" | "pending", clientId?: string) {
    setAuthBusy(true);
    setError("");
    setInfo("");
    setFallbackAuthorizeUrl("");
    try {
      const data = await requestJson("/api/auth/start", {
        method: "POST",
        body: JSON.stringify({ mode: modeValue, ...(clientId ? { clientId } : {}) }),
      });
      if (data.opened) {
        setInfo("已在系统浏览器中打开 ChatGPT。完成或取消授权后，返回此页继续。");
      } else if (typeof data.fallbackUrl === "string") {
        setInfo("系统浏览器未能自动打开。请使用下面的按钮继续到 OpenAI 官方登录页面。");
        setFallbackAuthorizeUrl(data.fallbackUrl);
      }
      if (typeof data.flowId === "string") void waitForAuthFlow(data.flowId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法开始 ChatGPT 登录。");
    } finally {
      setAuthBusy(false);
    }
  }

  async function waitForAuthFlow(flowId: string) {
    authPollRef.current?.abort();
    const controller = new AbortController();
    authPollRef.current = controller;
    setAuthWaiting(true);
    const deadline = Date.now() + 10 * 60 * 1000;
    let delay = 750;
    try {
      while (!controller.signal.aborted && Date.now() < deadline) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delay);
          controller.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Auth polling stopped", "AbortError"));
          }, { once: true });
        });
        const data = await requestJson("/api/auth/complete", {
          method: "POST",
          body: JSON.stringify({ flowId }),
          signal: controller.signal,
        });
        if (data.state === "connected" && data.session) {
          setStatus(data.session as SessionStatus);
          setBackendAvailable(true);
          setFallbackAuthorizeUrl("");
          setInfo("ChatGPT 账号已连接。你可以在本机使用可用模型生成练习反馈。");
          return;
        }
        if (data.state === "expired") {
          setError(typeof data.message === "string" ? data.message : "登录流程已过期；可以重新开始。");
          await refreshSession();
          return;
        }
        delay = Math.min(2_000, delay + 250);
      }
      if (!controller.signal.aborted) {
        setError("登录等待超时。若账号已连接，可以刷新连接状态或从已保存账号继续。");
        await refreshSession();
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : "无法确认 ChatGPT 登录状态。你可以从已保存账号继续。");
      await refreshSession();
    } finally {
      if (authPollRef.current === controller) authPollRef.current = null;
      setAuthWaiting(false);
    }
  }

  async function resumeProfile(clientId: string) {
    setAuthBusy(true);
    setError("");
    try {
      const data = await requestJson("/api/auth/select", { method: "POST", body: JSON.stringify({ clientId }) });
      setStatus(data as SessionStatus);
      setBackendAvailable(true);
      setInfo("已在本机继续使用这个保存的 ChatGPT 账号。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法继续使用已保存的账号。");
    } finally {
      setAuthBusy(false);
    }
  }

  async function retryLocalCleanup() {
    setAuthBusy(true);
    setError("");
    try {
      await requestJson("/api/auth/logout", { method: "POST", body: JSON.stringify({}) });
      await refreshSession();
      setInfo("本机待清理的登录凭据已清除；远端撤销状态无法确认，请检查 ChatGPT 设置中的应用访问权限。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "本机凭据仍待清理，请稍后重试。");
    } finally {
      setAuthBusy(false);
    }
  }

  async function logOut() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setResult("");
    setLogoutBusy(true);
    setError("");
    setInfo("");
    try {
      const data = await requestJson("/api/auth/logout", { method: "POST", body: JSON.stringify({}) });
      await refreshSession();
      setInfo(data.revocationConfirmed
        ? "已退出，并确认 OpenAI 撤销了这个续期会话。账号注册信息仍保留在本机。"
        : "已清除本机登录凭据；远端撤销未确认。你也可以在 ChatGPT 设置中检查应用访问权限。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "退出登录没有完成。");
    } finally {
      setLogoutBusy(false);
    }
  }

  function handleAnswerChange(value: string) {
    setAnswer(value);
    if (localSaveState === "error") return;
    setLocalSaveState("ready");
    setLocalSaveMessage("正在保存到本设备学习记录…");
    pendingDraftRef.current = { qid: selectedId, text: value };
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => { void flushDraftRef.current(); }, 450);
  }

  async function selectQuestion(value: string) {
    await flushDraftRef.current();
    setSelectedId(value);
    setQuery("");
    setResult("");
    setError("");
  }

  async function submitFeedback(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedQuestion || !status.authenticated || !status.allowedModelsAvailable || !model) return;
    if (mode === "critique" && answer.trim().length === 0) {
      setError("先写下你的回答，再请教练逐项点评。");
      return;
    }
    await flushDraftRef.current();
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setResult("");
    setError("");
    setInfo("");
    setStreaming(true);
    try {
      const response = await fetch(`${API_ORIGIN}/api/coaching`, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questionId: selectedQuestion.qid, mode, model, answer }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(typeof data.message === "string" ? data.message : "模型请求没有完成。");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("没有收到模型响应内容。");
      const decoder = new TextDecoder();
      let buffer = "";
      let completed = false;
      let streamError = "";
      const processEvent = (block: string) => {
        let event = "message";
        const dataLines: string[] = [];
        for (const line of block.split(/\r?\n/u)) {
          if (!line || line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const name = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /u, "");
          if (name === "event") event = value;
          else if (name === "data") dataLines.push(value);
        }
        if (!dataLines.length) return;
        try {
          const data = JSON.parse(dataLines.join("\n"));
          if (event === "delta" && typeof data === "string") setResult((current) => current + data);
          if (event === "done") completed = data.completed === true;
          if (event === "error") streamError = typeof data.message === "string" ? data.message : "模型响应没有完整结束。";
        } catch {
          streamError = "模型响应格式无法读取。";
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.search(/\r?\n\r?\n/u)) >= 0) {
          const block = buffer.slice(0, boundary);
          const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/u)?.[0] ?? "\n\n";
          buffer = buffer.slice(boundary + separator.length);
          processEvent(block);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) processEvent(buffer);
      await reader.cancel();
      reader.releaseLock();
      if (streamError) setError(streamError);
      else if (completed) setInfo("反馈已完整生成。模型意见只是练习建议，不是招聘结论或权威评分。");
      else setError("响应没有确认完整结束；请检查后再决定是否重新发送。");
    } catch (cause) {
      if (controller.signal.aborted) setInfo("已停止生成；这次反馈未确认完整结束。");
      else setError(cause instanceof Error ? cause.message : "模型请求没有完成。没有切换到其他计费方式。");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setStreaming(false);
    }
  }

  if (!LOCAL_MODE) return null;

  return (
    <div className="coach-page">
      <section className="page-intro" aria-labelledby="coach-title">
        <div className="eyebrow">LOCAL PRACTICE · CHATGPT PLAN</div>
        <div className="intro-row">
          <div>
            <h1 id="coach-title">AI 答题教练</h1>
            <p>先自己作答，再选择提示、讲解或逐项点评。模型建议不代替自评，也不代表招聘结论。</p>
          </div>
          <Badge variant="outline">仅本机运行</Badge>
        </div>
      </section>

      {!backendAvailable && (
        <Card className="coach-account-card">
          <CardContent className="coach-offline">
            <AlertCircle size={20} aria-hidden="true" />
            <div><strong>本地服务尚未连接</strong><p>在项目文件夹中运行 npm run local:dev，再打开 http://127.0.0.1:3000。</p></div>
          </CardContent>
        </Card>
      )}

      {backendAvailable && (
        <Card className="coach-account-card">
          <CardContent className="coach-account-row">
            <div className="coach-account-main">
              <span className={`coach-account-icon ${status.authenticated ? "is-connected" : ""}`} aria-hidden="true">
                {status.authenticated ? <CheckCircle2 size={20} /> : <CircleHelp size={20} />}
              </span>
              <div>
                <strong>{statusLoading ? "正在检查本机连接…" : status.authenticated ? (status.account?.name || status.account?.email || "ChatGPT 已连接") : "连接你的 ChatGPT 账号"}</strong>
                <p>{status.authenticated
                  ? status.allowedModelsAvailable ? "使用此账号允许的 ChatGPT 计划用量；不会回退到 API Key 计费。" : "已完成身份登录，但没有 ChatGPT 计划用量权限，模型请求已关闭。"
                  : "账号信息和登录凭据只保存在这台设备；使用官方授权页面登录。"}</p>
              </div>
            </div>
            <div className="coach-account-actions">
              {status.authenticated ? (
                <>
                  {!status.allowedModelsAvailable && status.account && (
                    <Button variant="outline" onClick={() => void startSignIn("saved", status.account!.clientId)} disabled={authBusy || authWaiting}>
                      {authBusy ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <RotateCw aria-hidden="true" />}
                      重新授权用量
                    </Button>
                  )}
                  <Button variant="outline" onClick={() => void startSignIn("new")} disabled={authBusy || authWaiting}>
                    <Sparkles aria-hidden="true" />添加账号
                  </Button>
                  <Button variant="outline" onClick={() => void logOut()} disabled={logoutBusy}>
                    {logoutBusy ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <LogOut aria-hidden="true" />}
                    退出此设备
                  </Button>
                </>
              ) : (
                <Button onClick={() => void startSignIn("new")} disabled={authBusy || authWaiting || statusLoading}>
                  {authBusy ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
                  Continue with ChatGPT
                </Button>
              )}
            </div>
            {status.profiles.length > 0 && !status.authenticated && (
              <div className="coach-saved-profiles">
                <p>本机已保存的账号</p>
                {status.profiles.map((profile) => (
                  <div key={profile.clientId} className="coach-profile-line">
                    <span>{profile.name || profile.email || "已保存的 ChatGPT 账号"}</span>
                    {profile.pendingLocalClear ? (
                      <Button variant="outline" size="sm" disabled={authBusy || authWaiting} onClick={() => void retryLocalCleanup()}>重试清除凭据</Button>
                    ) : profile.resumable ? (
                      <Button variant="secondary" size="sm" disabled={authBusy || authWaiting} onClick={() => void resumeProfile(profile.clientId)}>继续使用</Button>
                    ) : (
                      <Button variant="outline" size="sm" disabled={authBusy || authWaiting} onClick={() => void startSignIn("saved", profile.clientId)}>重新登录</Button>
                    )}
                  </div>
                ))}
                <Button variant="ghost" size="sm" disabled={authBusy || authWaiting} onClick={() => void startSignIn("new")}>
                  添加另一个 ChatGPT 账号
                </Button>
              </div>
            )}
            {status.pendingRegistrations.length > 0 && (
              <div className="coach-saved-profiles">
                <p>待完成的 OpenAI 注册</p>
                {status.pendingRegistrations.map((pending) => (
                  <div key={pending.clientId} className="coach-profile-line">
                    <span>ChatGPT 注册尚未完成</span>
                    <Button variant="secondary" size="sm" disabled={authBusy || authWaiting} onClick={() => void startSignIn("pending", pending.clientId)}>继续完成注册</Button>
                  </div>
                ))}
              </div>
            )}
            {status.authenticated && status.profiles.length > 1 && (
              <div className="coach-saved-profiles">
                <Label htmlFor="coach-account-select">切换已保存的账号</Label>
                <Select value={status.account?.clientId ?? ""} onValueChange={(value) => void resumeProfile(value)}>
                  <SelectTrigger id="coach-account-select"><SelectValue placeholder="选择账号" /></SelectTrigger>
                  <SelectContent>
                    {status.profiles.filter((profile) => profile.resumable).map((profile) => (
                      <SelectItem key={profile.clientId} value={profile.clientId}>{profile.name || profile.email || profile.clientId}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {!status.authenticated && error && <ErrorNote>{error}</ErrorNote>}
      {!status.authenticated && info && (
        <p className="coach-note coach-note-info" role="status">
          <CheckCircle2 size={16} aria-hidden="true" />{info}
          {fallbackAuthorizeUrl && <a href={fallbackAuthorizeUrl} target="_blank" rel="noreferrer">手动打开 OpenAI 授权页面</a>}
        </p>
      )}

      {status.authenticated && status.allowedModelsAvailable && (
        <form className="coach-workspace-grid" onSubmit={(event) => void submitFeedback(event)}>
          <div className="coach-main-column">
            <Card className="coach-question-card">
              <CardHeader className="coach-card-header">
                <div><CardTitle className="coach-card-title"><WandSparkles size={18} aria-hidden="true" />选择练习题</CardTitle><p>可按题目 ID、标题或主题搜索。</p></div>
                <Badge variant="outline">{masterQuestionCount} 主练题 · {companyVariantCount} 企业问法</Badge>
              </CardHeader>
              <CardContent className="coach-form-stack">
                <div className="coach-field">
                  <Label htmlFor="coach-question-search">搜索题目</Label>
                  <Input id="coach-question-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：D13、事件循环、Promise" />
                </div>
                <div className="coach-field">
                  <Label htmlFor="coach-question">题目</Label>
                  <Select value={selectedQuestion?.qid ?? ""} onValueChange={(value) => void selectQuestion(value)}>
                    <SelectTrigger id="coach-question"><SelectValue placeholder="选择一道题" /></SelectTrigger>
                    <SelectContent position="popper">
                      {filteredQuestions.map((question) => (
                        <SelectItem key={question.qid} value={question.qid}>{question.qid} · {question.title}</SelectItem>
                      ))}
                      {filteredQuestions.length === 0 && <SelectItem value="__none" disabled>没有匹配题目</SelectItem>}
                    </SelectContent>
                  </Select>
                </div>
                {selectedQuestion && (
                  <div className="coach-selected-question">
                    <div><Badge variant="subtle">{selectedQuestion.qid}</Badge><Badge variant="outline">{selectedQuestion.kind === "company" ? "企业问法" : "主练题"}</Badge></div>
                    <h2>{selectedQuestion.title}</h2>
                    <p>{selectedQuestion.primary} <span aria-hidden="true">·</span> {selectedQuestion.subtopic}</p>
                    <Link href={`/questions/${selectedQuestion.qid}/`}><span>打开原题与本地自评</span><ArrowUpRight size={14} aria-hidden="true" /></Link>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="coach-answer-card">
              <CardHeader className="coach-card-header">
                <div><CardTitle className="coach-card-title">先写下你的回答</CardTitle><p>尽量按面试口述表达；最多 12,000 个字符。</p></div>
                <Badge variant={localSaveState === "saved" ? "secondary" : localSaveState === "error" ? "destructive" : "outline"}>
                  {localSaveState === "saved" ? "本机已保存" : localSaveState === "error" ? "保存失败" : localSaveState === "loading" ? "读取中" : "草稿"}
                </Badge>
              </CardHeader>
              <CardContent className="coach-form-stack">
                <div className="coach-field">
                  <Label htmlFor="coach-answer">我的回答</Label>
                  <Textarea id="coach-answer" className="coach-answer-input" value={answer} maxLength={12_000} onChange={(event) => handleAnswerChange(event.target.value)} disabled={answerLoading} placeholder="先自己写下思路、关键机制和边界……" />
                  <div className="coach-answer-meta"><span className={localSaveState === "error" ? "is-error" : ""}>{localSaveMessage}</span><span>{answer.length.toLocaleString("zh-CN")} / 12,000</span></div>
                </div>
                <div className="coach-controls">
                  <div className="coach-field">
                    <Label htmlFor="coach-mode">练习方式</Label>
                    <Select value={mode} onValueChange={(value) => setMode(value as Mode)}>
                      <SelectTrigger id="coach-mode"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="hint">给我一条提示</SelectItem>
                        <SelectItem value="explain">讲解核心原理</SelectItem>
                        <SelectItem value="critique">对照参考内容点评回答</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="coach-field">
                    <Label htmlFor="coach-model">可用模型</Label>
                    <Select value={model} onValueChange={setModel} disabled={modelsLoading || models.length === 0}>
                      <SelectTrigger id="coach-model"><SelectValue placeholder={modelsLoading ? "读取模型中…" : "选择模型"} /></SelectTrigger>
                      <SelectContent>
                        {models.map((item) => <SelectItem key={item.slug} value={item.slug}>{item.displayName}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="coach-submit-row">
                  <div className="coach-privacy-copy">发送后，本题、参考内容和你的回答会发往 OpenAI Responses API 生成反馈。请求使用 store:false；本地页面不保存 AI 对话。</div>
                  {streaming ? (
                    <Button type="button" variant="outline" onClick={() => abortRef.current?.abort()}><Square size={15} aria-hidden="true" />停止生成</Button>
                  ) : (
                    <Button type="submit" disabled={!model || !selectedQuestion || modelsLoading || localSaveState === "error"}>
                      {modelsLoading ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
                      发送并生成反馈
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          <aside className="coach-aside-column" aria-label="教练反馈与说明">
            <Card className="coach-result-card">
              <CardHeader className="coach-card-header">
                <div><CardTitle className="coach-card-title"><Sparkles size={18} aria-hidden="true" />练习反馈</CardTitle><p>{streaming ? "正在接收模型回复…" : "完成一次练习后，反馈会显示在这里。"}</p></div>
                {streaming && <LoaderCircle className="animate-spin" size={18} aria-label="正在生成" />}
              </CardHeader>
              <CardContent>
                {error && <ErrorNote>{error}</ErrorNote>}
                {info && <p className="coach-note coach-note-info" role="status"><CheckCircle2 size={16} aria-hidden="true" />{info}</p>}
                {modelsLoading && <p className="coach-note"><LoaderCircle size={15} className="animate-spin" aria-hidden="true" />正在读取账号可用模型。</p>}
                {!modelsLoading && models.length === 0 && <Button type="button" variant="outline" size="sm" onClick={() => void loadModels()} disabled={!status.allowedModelsAvailable}><RotateCw size={14} aria-hidden="true" />刷新模型列表</Button>}
                {result && <div className="coach-result-text" aria-live="polite" aria-atomic="false">{result}</div>}
                {!result && !streaming && !error && <p className="coach-empty-result">这里会显示提示、原理讲解或逐项点评。若生成中断，请检查完整性后再决定是否重新发送。</p>}
                {status.authenticated && !status.allowedModelsAvailable && <ErrorNote>此账号没有授予 ChatGPT 计划用量；不会改用 API Key 或其他计费方式。</ErrorNote>}
              </CardContent>
            </Card>

            <Card className="coach-guide-card">
              <CardHeader className="coach-card-header"><div><CardTitle className="coach-card-title"><CircleHelp size={18} aria-hidden="true" />使用边界</CardTitle><p>本地学习工具的说明</p></div></CardHeader>
              <CardContent className="coach-guide-list">
                <p><strong>建议，不打分。</strong>模型不会给数字分数，也不能替代你在原题页的自评。</p>
                <p><strong>只在本机提供服务。</strong>OAuth 回调、会话和模型请求由本地 Node 服务处理；静态网站不会携带登录凭据。</p>
                <p><strong>没有自动回退。</strong>如果账号无权限或用量不可用，页面会提示原因，不切换 API Key 计费。</p>
                <p><strong>草稿留在设备上。</strong>练习回答保存在本机 IndexedDB；点击发送时才把当前问题与回答发给 OpenAI。</p>
                <Link href="/ai-assist/">查看本机设置步骤与功能状态 <ArrowUpRight size={14} aria-hidden="true" /></Link>
              </CardContent>
            </Card>

            {backendAvailable && status.authenticated && (
              <div className="coach-foot-actions">
                <Link href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">查看 ChatGPT 用量设置 <ArrowUpRight size={13} aria-hidden="true" /></Link>
                <Button variant="ghost" size="sm" onClick={() => void refreshSession()} disabled={statusLoading}><RotateCw size={14} aria-hidden="true" />刷新连接状态</Button>
              </div>
            )}
          </aside>
        </form>
      )}

      {!status.authenticated && backendAvailable && (
        <Card className="coach-setup-card">
          <CardContent className="coach-setup-copy">
            <div className="coach-setup-icon"><WandSparkles size={19} aria-hidden="true" /></div>
            <div><h2>把一道题讲清楚，再听反馈</h2><p>先连接账号，页面会从你的 ChatGPT 账号读取可用模型。注册或授权由你在 OpenAI 官方页面确认。</p></div>
            {status.profiles.length === 0 && <Button variant="outline" onClick={() => void refreshSession()} disabled={statusLoading}><RotateCw size={14} aria-hidden="true" />刷新连接</Button>}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
