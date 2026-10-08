"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { AlertCircle, ArrowUpRight, CheckCircle2, CircleHelp, LoaderCircle, LogOut, RotateCw, Sparkles, Square, WandSparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getStudySnapshot, saveAttempt, saveCoachConversation, saveDraft, type Attempt, type CoachConversation, type CoachConversationStatus, type CoachMode } from "@/lib/study-store";
import { afterPreparation, createRequestLifecycle, discardRequestBuffer, flushRequestBuffer, takeRequestBuffer } from "@/lib/request-epoch.mjs";

const API_ORIGIN = "http://127.0.0.1:4317";
const LOCAL_MODE = process.env.NEXT_PUBLIC_FRONTEND_ATLAS_LOCAL_MODE === "1";
const CoachMarkdown = dynamic(() => import("@/components/site/coach-markdown").then((module) => module.CoachMarkdown), {
  loading: () => <p className="coach-note">正在准备回复排版…</p>,
});

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
type Mode = CoachMode;
type ConversationSaveState = "idle" | "saving" | "saved" | "error";

function conversationStatusLabel(status: CoachConversationStatus) {
  switch (status) {
    case "pending": return "生成中或未完成";
    case "complete": return "完整反馈";
    case "interrupted": return "已中断，保留部分回复";
    case "failed": return "请求失败";
    case "cancelled": return "已取消";
  }
}

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
  const [connectionIssue, setConnectionIssue] = useState<"wrong-origin" | "unavailable" | null>(null);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const modelsRef = useRef<ModelChoice[]>([]);
  const [model, setModel] = useState("");
  const [modelsLoading, setModelsLoading] = useState(false);
  const [result, setResult] = useState("");
  const [conversation, setConversation] = useState<CoachConversation | null>(null);
  const [conversationSaveState, setConversationSaveState] = useState<ConversationSaveState>("idle");
  const [conversationSaveMessage, setConversationSaveMessage] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [retryAvailable, setRetryAvailable] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authWaiting, setAuthWaiting] = useState(false);
  const [fallbackAuthorizeUrl, setFallbackAuthorizeUrl] = useState("");
  const [logoutBusy, setLogoutBusy] = useState(false);
  const requestLifecycleRef = useRef(createRequestLifecycle());
  const lastRequestRef = useRef<{ questionId: string; mode: Mode; model: string; answer: string } | null>(null);
  const resultScrollRef = useRef<HTMLDivElement | null>(null);
  const followResultRef = useRef(true);
  const [showLatestButton, setShowLatestButton] = useState(false);
  const authPollRef = useRef<AbortController | null>(null);
  const attemptRef = useRef<Attempt | null>(null);
  const currentQidRef = useRef(selectedId);
  const pendingDraftRef = useRef<{ qid: string; text: string } | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushDraftRef = useRef<() => Promise<void>>(async () => {});
  const conversationRef = useRef<CoachConversation | null>(null);
  const activeConversationIdRef = useRef<string | null>(null);
  const conversationSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushConversationSaveRef = useRef<(record?: CoachConversation) => Promise<boolean>>(async () => true);

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

  const flushConversationSave = useCallback(async (record?: CoachConversation) => {
    const target = record ?? conversationRef.current;
    if (!target) return true;
    if (conversationSaveTimerRef.current) clearTimeout(conversationSaveTimerRef.current);
    conversationSaveTimerRef.current = null;
    if (conversationRef.current?.conversationId === target.conversationId && conversationRef.current.updatedAt === target.updatedAt) {
      setConversationSaveState("saving");
      setConversationSaveMessage("AI 对话正在保存在本设备…");
    }
    try {
      await saveCoachConversation(target);
      if (conversationRef.current?.conversationId === target.conversationId && conversationRef.current.updatedAt === target.updatedAt) {
        setConversationSaveState("saved");
        setConversationSaveMessage("AI 对话已保存在本设备。可在“本设备数据”中导出或清除。");
      }
      return true;
    } catch {
      if (conversationRef.current?.conversationId === target.conversationId && conversationRef.current.updatedAt === target.updatedAt) {
        setConversationSaveState("error");
        setConversationSaveMessage("AI 对话保存失败；当前内容仍留在页面内。重试保存不会再次调用模型。");
      }
      return false;
    }
  }, []);
  useEffect(() => {
    flushConversationSaveRef.current = flushConversationSave;
  }, [flushConversationSave]);

  function updateConversation(record: CoachConversation) {
    conversationRef.current = record;
    setConversation(record);
    setConversationSaveState("saving");
    setConversationSaveMessage("AI 对话正在保存在本设备…");
    if (conversationSaveTimerRef.current === null) {
      conversationSaveTimerRef.current = setTimeout(() => {
        conversationSaveTimerRef.current = null;
        void flushConversationSaveRef.current();
      }, 500);
    }
  }

  useEffect(() => {
    currentQidRef.current = selectedId;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setAnswerLoading(true);
      setLocalSaveState("loading");
    });
    attemptRef.current = null;
    conversationRef.current = null;
    activeConversationIdRef.current = null;
    lastRequestRef.current = null;
    Promise.resolve().then(getStudySnapshot).then((snapshot) => {
      if (!active) return;
      const latest = snapshot.attempts
        .filter((item) => item.qid === selectedId)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] ?? null;
      const latestConversation = snapshot.coachConversations
        .filter((item) => item.qid === selectedId)
        .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0] ?? null;
      let visibleConversation = latestConversation;
      if (visibleConversation?.status === "pending") {
        const recoveredConversation: CoachConversation = { ...visibleConversation, status: "interrupted", updatedAt: new Date().toISOString() };
        visibleConversation = recoveredConversation;
        conversationRef.current = recoveredConversation;
        setConversation(recoveredConversation);
        setConversationSaveState("saving");
        setConversationSaveMessage("上次会话未确认完成，已标记为中断并尝试保存。");
        void saveCoachConversation(recoveredConversation).then(() => {
          const current = conversationRef.current;
          if (current?.conversationId === recoveredConversation.conversationId && current.updatedAt === recoveredConversation.updatedAt) {
            setConversationSaveState("saved");
            setConversationSaveMessage("上次会话未确认完成；已保留部分回复。");
          }
        }).catch(() => {
          if (conversationRef.current?.conversationId === recoveredConversation.conversationId) {
            setConversationSaveState("error");
            setConversationSaveMessage("上次会话未确认完成，且中断状态保存失败。可以重试保存。");
          }
        });
      } else if (visibleConversation) {
        conversationRef.current = visibleConversation;
        setConversation(visibleConversation);
        setConversationSaveState("saved");
        setConversationSaveMessage("AI 对话已保存在本设备。可在“本设备数据”中导出或清除。");
      }
      if (visibleConversation) {
        setResult(visibleConversation.assistantOutput);
        lastRequestRef.current = {
          questionId: visibleConversation.qid,
          mode: visibleConversation.mode,
          model: visibleConversation.model,
          answer: visibleConversation.userInput,
        };
        setRetryAvailable(visibleConversation.contentVersion === contentVersion && (visibleConversation.status === "interrupted" || visibleConversation.status === "failed"));
        setMode(visibleConversation.mode);
        if (modelsRef.current.some((item) => item.slug === visibleConversation.model)) setModel(visibleConversation.model);
      } else {
        setRetryAvailable(false);
      }
      if (latest && latest.contentVersion === contentVersion) {
        attemptRef.current = latest;
        const revision = snapshot.drafts.find((item) => item.qid === selectedId && item.attemptId === latest.attemptId && item.kind === "revision");
        setAnswer(latest.revealedAt && revision ? revision.text : latest.originalAnswer);
        setLocalSaveState("saved");
        setLocalSaveMessage("回答草稿已保存在本设备的学习记录中。");
      } else {
        const restoredInput = visibleConversation?.contentVersion === contentVersion ? visibleConversation.userInput : "";
        setAnswer(restoredInput);
        setLocalSaveState("ready");
        setLocalSaveMessage(restoredInput ? "已恢复上次发送的回答；编辑后才会保存为新的练习草稿。" : latest ? "发现较早版本的练习记录；为避免混用内容版本，本页不会自动载入它。" : "回答草稿会保存在本设备的学习记录中。");
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
    const activeRequest = requestLifecycleRef.current.invalidate();
    const pendingOutput = activeRequest ? takeRequestBuffer(activeRequest) : "";
    const wasStreaming = activeRequest?.phase === "streaming";
    activeRequest?.controller?.abort();
    if (activeRequest && pendingOutput) discardRequestBuffer(activeRequest);
    const activeConversation = conversationRef.current;
    if (activeConversation && activeConversation.status === "pending") {
      void saveCoachConversation({
        ...activeConversation,
        assistantOutput: activeConversation.assistantOutput + pendingOutput,
        status: wasStreaming ? "interrupted" : "cancelled",
        updatedAt: new Date().toISOString(),
      }).catch(() => {});
    }
    if (conversationSaveTimerRef.current) clearTimeout(conversationSaveTimerRef.current);
    conversationSaveTimerRef.current = null;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    void flushDraftRef.current();
  }, []);

  useEffect(() => {
    if (!followResultRef.current) return;
    const container = resultScrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [result]);

  const refreshSession = useCallback(async () => {
    if (!LOCAL_MODE) return;
    setStatusLoading(true);
    try {
      const data = await requestJson("/api/session");
      setStatus(data as SessionStatus);
      setBackendAvailable(true);
      setConnectionIssue(null);
      setError("");
    } catch (cause) {
      const wrongOrigin = window.location.hostname === "localhost";
      setBackendAvailable(false);
      setConnectionIssue(wrongOrigin ? "wrong-origin" : "unavailable");
      setStatus(initialStatus);
      if (wrongOrigin || !(cause instanceof Error) || cause.message === "Failed to fetch" || cause.message.includes("本地服务")) setError("");
      else setError(cause.message);
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
      modelsRef.current = available;
      setModels(available);
      setModel((current) => {
        const restoredModel = conversationRef.current?.model;
        if (restoredModel && available.some((item) => item.slug === restoredModel)) return restoredModel;
        return available.some((item) => item.slug === current) ? current : (available[0]?.slug ?? "");
      });
      setError("");
    } catch (cause) {
      modelsRef.current = [];
      setModels([]);
      setModel("");
      setError(cause instanceof Error ? cause.message : "无法读取模型列表。");
    } finally {
      setModelsLoading(false);
    }
  }, [status.authenticated, status.allowedModelsAvailable]);

  useEffect(() => {
    queueMicrotask(() => {
      modelsRef.current = [];
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
    await stopGeneration();
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

  function appendConversationOutput(conversationId: string | null, text: string) {
    if (!text) return;
    setResult((current) => current + text);
    const current = conversationRef.current;
    if (!conversationId || !current || current.conversationId !== conversationId) return;
    updateConversation({
      ...current,
      assistantOutput: current.assistantOutput + text,
      updatedAt: new Date().toISOString(),
    });
  }

  async function selectQuestion(value: string) {
    await stopGeneration();
    const currentConversation = conversationRef.current;
    if (currentConversation && !(await flushConversationSaveRef.current(currentConversation))) {
      setError("本段 AI 对话仍未保存在本设备，已留在当前题目中。请先重试保存，再切换题目。");
      return;
    }
    await flushDraftRef.current();
    conversationRef.current = null;
    activeConversationIdRef.current = null;
    setConversation(null);
    setConversationSaveState("idle");
    setConversationSaveMessage("");
    setSelectedId(value);
    setQuery("");
    setResult("");
    lastRequestRef.current = null;
    setRetryAvailable(false);
    setError("");
  }

  async function submitFeedback(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedQuestion || !status.authenticated || !status.allowedModelsAvailable || !model) return;
    if (mode === "critique" && answer.trim().length === 0) {
      setError("先写下你的回答，再请教练逐项点评。");
      return;
    }
    const request = { questionId: selectedQuestion.qid, mode, model, answer };
    await runFeedback(request, false);
  }

  async function stopGeneration(message = "已停止生成；部分回复已保留，当前回答草稿仍在输入框中。") {
    const activeRequest = requestLifecycleRef.current.invalidate();
    if (!activeRequest) return;
    const wasStreaming = activeRequest.phase === "streaming";
    activeRequest.controller?.abort();
    const pending = takeRequestBuffer(activeRequest);
    const conversationId = activeConversationIdRef.current;
    if (pending) appendConversationOutput(conversationId, pending);
    const current = conversationRef.current;
    let finalConversation: CoachConversation | null = null;
    if (current && current.conversationId === conversationId && current.status === "pending") {
      finalConversation = {
        ...current,
        status: wasStreaming ? "interrupted" : "cancelled",
        updatedAt: new Date().toISOString(),
      };
      updateConversation(finalConversation);
    }
    activeConversationIdRef.current = null;
    setPreparing(false);
    setStreaming(false);
    setRetryAvailable(wasStreaming && Boolean(finalConversation));
    setInfo(wasStreaming ? message : "已取消待发送的反馈；尚未发出模型请求。");
    if (finalConversation) await flushConversationSaveRef.current(finalConversation);
  }

  async function runFeedback(request: { questionId: string; mode: Mode; model: string; answer: string }, retry: boolean) {
    if (conversationSaveState === "error" && conversationRef.current) {
      const saved = await flushConversationSaveRef.current(conversationRef.current);
      if (!saved) {
        setError("上次 AI 对话仍未保存在本设备，暂未发送新的模型请求。请先重试保存。");
        return;
      }
    }
    if (!retry) lastRequestRef.current = request;
    const { request: activeRequest, previous } = requestLifecycleRef.current.begin();
    if (previous) {
      const previousConversationId = activeConversationIdRef.current;
      previous.controller?.abort();
      const pending = takeRequestBuffer(previous);
      if (pending) appendConversationOutput(previousConversationId, pending);
      const previousConversation = conversationRef.current;
      if (previousConversation && previousConversation.conversationId === previousConversationId && previousConversation.status === "pending") {
        const interrupted = {
          ...previousConversation,
          status: previous.phase === "streaming" ? "interrupted" as const : "cancelled" as const,
          updatedAt: new Date().toISOString(),
        };
        updateConversation(interrupted);
        void flushConversationSaveRef.current(interrupted);
      }
      activeConversationIdRef.current = null;
      discardRequestBuffer(previous);
    }
    followResultRef.current = true;
    setShowLatestButton(false);
    setResult("");
    setError("");
    setInfo("");
    setPreparing(true);
    setStreaming(false);
    setRetryAvailable(false);
    const isCurrent = () => requestLifecycleRef.current.isCurrent(activeRequest);
    let conversationId: string | null = null;
    const queueResult = (text: string) => {
      if (!isCurrent()) return;
      activeRequest.buffer += text;
      if (activeRequest.timer !== null) return;
      activeRequest.timer = setTimeout(() => {
        flushRequestBuffer(activeRequest, isCurrent, (next) => appendConversationOutput(conversationId, next));
      }, 48);
    };
    const flushQueuedResult = () => {
      flushRequestBuffer(activeRequest, isCurrent, (pending) => appendConversationOutput(conversationId, pending));
    };
    const finalizeConversation = async (finalStatus: CoachConversationStatus) => {
      const current = conversationRef.current;
      if (!current || current.conversationId !== conversationId) return;
      const finalRecord = { ...current, status: finalStatus, updatedAt: new Date().toISOString() };
      updateConversation(finalRecord);
      requestLifecycleRef.current.finish(activeRequest);
      if (activeConversationIdRef.current === conversationId) activeConversationIdRef.current = null;
      setPreparing(false);
      setStreaming(false);
      await flushConversationSaveRef.current(finalRecord);
    };
    try {
      const started = await afterPreparation(activeRequest, isCurrent, async () => {
        await flushDraftRef.current();
        if (!isCurrent()) return;
        const now = new Date().toISOString();
        const pendingConversation: CoachConversation = {
          conversationId: crypto.randomUUID(),
          qid: request.questionId,
          attemptId: attemptRef.current?.qid === request.questionId && attemptRef.current.contentVersion === contentVersion ? attemptRef.current.attemptId : null,
          contentVersion,
          mode: request.mode,
          model: request.model,
          userInput: request.answer,
          assistantOutput: "",
          status: "pending",
          startedAt: now,
          updatedAt: now,
        };
        conversationId = pendingConversation.conversationId;
        activeConversationIdRef.current = conversationId;
        conversationRef.current = pendingConversation;
        setConversation(pendingConversation);
        setConversationSaveState("saving");
        setConversationSaveMessage("正在先保存本次发送内容，再发起模型请求…");
        try {
          await saveCoachConversation(pendingConversation);
        } catch {
          setConversationSaveState("error");
          setConversationSaveMessage("本次发送内容无法保存在本设备，因此没有发起模型请求。可以重试保存后再发送。");
          throw new Error("无法保存本次 AI 对话；模型请求尚未发送。");
        }
        if (conversationRef.current?.conversationId === pendingConversation.conversationId) {
          setConversationSaveState("saved");
          setConversationSaveMessage("本次发送内容已先保存在本设备。");
        }
      }, () => {
        activeRequest.controller = new AbortController();
        activeRequest.phase = "streaming";
        setPreparing(false);
        setStreaming(true);
      });
      if (!started || !isCurrent() || !activeRequest.controller) return;
      const controller = activeRequest.controller;
      const response = await fetch(`${API_ORIGIN}/api/coaching`, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        if (!isCurrent()) return;
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
          if (event === "delta" && typeof data === "string") queueResult(data);
          if (event === "done") completed = data.completed === true;
          if (event === "error") streamError = typeof data.message === "string" ? data.message : "模型响应没有完整结束。";
        } catch {
          streamError = "模型响应格式无法读取。";
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (!isCurrent()) {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
          return;
        }
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
      await reader.cancel().catch(() => {});
      if (!isCurrent()) {
        reader.releaseLock();
        return;
      }
      reader.releaseLock();
      flushQueuedResult();
      if (!isCurrent()) return;
      if (streamError) {
        setError(streamError);
        setRetryAvailable(true);
        const current = conversationRef.current;
        await finalizeConversation(current?.assistantOutput ? "interrupted" : "failed");
      } else if (completed) {
        setInfo("反馈已完整生成。模型意见只是练习建议，不是招聘结论或权威评分。");
        setRetryAvailable(false);
        await finalizeConversation("complete");
      } else {
        setError("响应没有确认完整结束；请检查后再决定是否重新发送。");
        setRetryAvailable(true);
        const current = conversationRef.current;
        await finalizeConversation(current?.assistantOutput ? "interrupted" : "failed");
      }
    } catch (cause) {
      if (!isCurrent()) return;
      flushQueuedResult();
      const current = conversationRef.current;
      const requestWasSent = activeRequest.phase === "streaming";
      const finalStatus: CoachConversationStatus = requestWasSent
        ? current?.assistantOutput ? "interrupted" : "failed"
        : "failed";
      if (!requestWasSent) {
        setError(cause instanceof Error ? cause.message : "本次 AI 对话无法保存，因此没有发送模型请求。");
        setRetryAvailable(false);
      } else {
        setError(cause instanceof Error ? cause.message : "模型请求没有完成。没有切换到其他计费方式。");
        setRetryAvailable(true);
      }
      await finalizeConversation(finalStatus);
    } finally {
      if (isCurrent()) {
        requestLifecycleRef.current.finish(activeRequest);
        if (activeConversationIdRef.current === conversationId) activeConversationIdRef.current = null;
        setPreparing(false);
        setStreaming(false);
      }
    }
  }

  function retryLastFeedback() {
    const previous = lastRequestRef.current;
    if (!previous || !status.authenticated || !status.allowedModelsAvailable) return;
    void runFeedback(previous, true);
  }

  function retryConversationSave() {
    const current = conversationRef.current;
    if (current) void flushConversationSaveRef.current(current);
  }

  function returnResultToLatest() {
    const container = resultScrollRef.current;
    if (!container) return;
    followResultRef.current = true;
    container.scrollTop = container.scrollHeight;
    setShowLatestButton(false);
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
            <div>
              {connectionIssue === "wrong-origin" ? (
                <>
                  <strong>当前地址与本机服务不一致</strong>
                  <p>本机连接只接受 127.0.0.1；当前使用 localhost。切换会保留当前路径和题目参数。如果切换后仍不可达，请确认 npm run local:dev 正在运行。</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const target = new URL(window.location.href);
                      target.protocol = "http:";
                      target.host = "127.0.0.1:3000";
                      window.location.assign(target.toString());
                    }}
                  >
                    <ArrowUpRight size={14} aria-hidden="true" />
                    打开 127.0.0.1:3000
                  </Button>
                </>
              ) : (
                <>
                  <strong>{connectionIssue === "unavailable" ? "本机服务暂不可达" : "正在检查本机服务…"}</strong>
                  <p>请确认本机服务已启动：在项目文件夹中运行 npm run local:dev，再打开 http://127.0.0.1:3000。</p>
                </>
              )}
            </div>
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
                    <Select value={mode} onValueChange={(value) => { setMode(value as Mode); setRetryAvailable(false); }}>
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
                    <Select value={model} onValueChange={(value) => { setModel(value); setRetryAvailable(false); }} disabled={modelsLoading || models.length === 0}>
                      <SelectTrigger id="coach-model"><SelectValue placeholder={modelsLoading ? "读取模型中…" : "选择模型"} /></SelectTrigger>
                      <SelectContent>
                        {models.map((item) => <SelectItem key={item.slug} value={item.slug}>{item.displayName}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="coach-submit-row">
                  <div className="coach-privacy-copy">发送后，本题、参考内容和你的回答会发往 OpenAI Responses API。请求使用 store:false；本次输入与反馈会保存在本机 IndexedDB，可在“本设备数据”中导出或清除。</div>
                  {streaming || preparing ? (
                    <Button type="button" variant="outline" onClick={() => stopGeneration()}><Square size={15} aria-hidden="true" />{preparing ? "取消等待" : "停止生成"}</Button>
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
                <div><CardTitle className="coach-card-title"><Sparkles size={18} aria-hidden="true" />练习反馈</CardTitle><p>{preparing ? "正在保存本机草稿…" : streaming ? "正在接收模型回复…" : "完成一次练习后，反馈会显示在这里。"}</p></div>
                {(preparing || streaming) && <LoaderCircle className="animate-spin" size={18} aria-hidden="true" />}
              </CardHeader>
              <CardContent>
                {error && <ErrorNote>{error}</ErrorNote>}
                {info && <p className="coach-note coach-note-info" role="status"><CheckCircle2 size={16} aria-hidden="true" />{info}</p>}
                {conversation && (
                  <div className="coach-conversation-meta" aria-label="本题最近一次 AI 对话">
                    <div className="coach-conversation-meta-heading">
                      <Badge variant={conversation.status === "complete" ? "secondary" : "outline"}>{conversationStatusLabel(conversation.status)}</Badge>
                      <span>{conversation.mode} · {conversation.model}</span>
                    </div>
                    <p className={conversationSaveState === "error" ? "coach-note coach-note-error" : "coach-note"} role={conversationSaveState === "error" ? "alert" : "status"}>
                      {conversationSaveMessage || "AI 对话保存在本设备。"}
                    </p>
                    {conversation.contentVersion !== contentVersion && <p className="coach-note">这段对话来自较早的题库版本，只作为历史记录显示，不会替换当前回答。</p>}
                    <details className="coach-conversation-input">
                      <summary>查看本次发送内容</summary>
                      <pre>{conversation.userInput || "（本次没有发送回答文本）"}</pre>
                    </details>
                    {conversationSaveState === "error" && <Button type="button" variant="outline" size="sm" onClick={retryConversationSave}><RotateCw size={14} aria-hidden="true" />重试保存对话</Button>}
                  </div>
                )}
                {modelsLoading && <p className="coach-note"><LoaderCircle size={15} className="animate-spin" aria-hidden="true" />正在读取账号可用模型。</p>}
                {!modelsLoading && models.length === 0 && <Button type="button" variant="outline" size="sm" onClick={() => void loadModels()} disabled={!status.allowedModelsAvailable}><RotateCw size={14} aria-hidden="true" />刷新模型列表</Button>}
                <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{preparing ? "正在保存本机回答草稿。" : streaming ? "正在接收教练回复。" : ""}</p>
                <div
                  className="coach-result-text"
                  ref={resultScrollRef}
                  onScroll={(event) => {
                    const element = event.currentTarget;
                    const atLatest = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
                    followResultRef.current = atLatest;
                    setShowLatestButton(!atLatest && element.scrollHeight > element.clientHeight);
                  }}
                  aria-label="教练回复内容"
                >
                  {result ? <CoachMarkdown source={result} streaming={streaming} /> : !streaming && !preparing && !error && <p className="coach-empty-result">这里会显示提示、原理讲解或逐项点评。回答未完成时可以停止；需要时可重试上次发送内容。</p>}
                </div>
                {showLatestButton && <Button type="button" variant="outline" size="sm" className="coach-latest-button" onClick={returnResultToLatest}>回到最新回复</Button>}
                {retryAvailable && lastRequestRef.current?.questionId === selectedQuestion?.qid && lastRequestRef.current.mode === mode && lastRequestRef.current.model === model && <Button type="button" variant="outline" size="sm" onClick={retryLastFeedback}><RotateCw size={14} aria-hidden="true" />重试上次发送内容</Button>}
                {status.authenticated && !status.allowedModelsAvailable && <ErrorNote>此账号没有授予 ChatGPT 计划用量；不会改用 API Key 或其他计费方式。</ErrorNote>}
              </CardContent>
            </Card>

            <Card className="coach-guide-card">
              <CardHeader className="coach-card-header"><div><CardTitle className="coach-card-title"><CircleHelp size={18} aria-hidden="true" />使用边界</CardTitle><p>本地学习工具的说明</p></div></CardHeader>
              <CardContent className="coach-guide-list">
                <p><strong>建议，不打分。</strong>模型不会给数字分数，也不能替代你在原题页的自评。</p>
                <p><strong>只在本机提供服务。</strong>OAuth 回调、会话和模型请求由本地 Node 服务处理；静态网站不会携带登录凭据。</p>
                <p><strong>没有自动回退。</strong>如果账号无权限或用量不可用，页面会提示原因，不切换 API Key 计费。</p>
                <p><strong>记录留在设备上。</strong>练习草稿、发送内容和 AI 反馈保存在本机 IndexedDB；请求使用 store:false，不会同步到账号或其他设备。</p>
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
