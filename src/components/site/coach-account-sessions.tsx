"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowUpRight, CheckCircle2, Clock3, LoaderCircle, LogIn, LogOut, MessageSquareText, Plus, RefreshCw, Send, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type SocialProvider = "github" | "google";
type SiteAccount = { id: string; name: string; email: string; authMethod: "mock" | "oauth" };
type SiteAccountStatus = {
  authConfigured: boolean;
  providers: Record<SocialProvider, boolean>;
  account: SiteAccount | null;
  mockAuthEnabled: boolean;
};
type ConversationSummary = {
  id: string;
  title: string;
  qid: string | null;
  contentVersion: string | null;
  createdAt: string;
  updatedAt: string;
};
type ConversationMessage = {
  id: string;
  conversationId: string;
  clientMessageId: string;
  role: "user" | "assistant";
  content: string;
  status: string;
  createdAt: string;
};
type ConversationDetail = ConversationSummary & { messages: ConversationMessage[] };
type PendingSubmission = { id: string; conversationId: string; content: string };
type LoadSessionOptions = { broadcastChange?: boolean };

const requestHeaderName = "x-frontend-atlas-request";
const requestHeaderValue = "1";
const expectedAccountHeaderName = "x-frontend-atlas-account-id";
const accountChangeChannelName = "frontend-atlas-site-account";

class AccountApiError extends Error {
  status: number;
  code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function requestJson<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; accountId?: string } = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers = new Headers();
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (["POST", "PATCH", "DELETE"].includes(method)) headers.set(requestHeaderName, requestHeaderValue);
  if (options.accountId) headers.set(expectedAccountHeaderName, options.accountId);
  const response = await fetch(path, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    credentials: "same-origin",
    cache: "no-store",
    signal: options.signal,
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const payload = data && typeof data === "object" ? data as Record<string, unknown> : {};
    const code = typeof payload.error === "string" ? payload.error : null;
    const message = code === "account_changed"
      ? "站点账号已在其他标签页发生变化。"
      : typeof payload.message === "string" ? payload.message : code ?? "账号会话请求没有完成。";
    throw new AccountApiError(message, response.status, code);
  }
  return data as T;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

export function CoachAccountSessions() {
  const [status, setStatus] = useState<SiteAccountStatus | null>(null);
  const [account, setAccount] = useState<SiteAccount | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [messageDraft, setMessageDraft] = useState("");
  const [messageBusy, setMessageBusy] = useState(false);
  const [pendingRetry, setPendingRetry] = useState(false);
  const [busyAction, setBusyAction] = useState<"login" | "logout" | "create" | null>(null);
  const [error, setError] = useState("");
  const [messageError, setMessageError] = useState("");
  const [notice, setNotice] = useState("");
  const epochRef = useRef(0);
  const conversationEpochRef = useRef(0);
  const conversationListEpochRef = useRef(0);
  const sessionRequestEpochRef = useRef(0);
  const accountRef = useRef<SiteAccount | null>(null);
  const activeConversationIdRef = useRef<string | null>(null);
  const requestsRef = useRef(new Set<AbortController>());
  const detailRequestRef = useRef<AbortController | null>(null);
  const messageRequestRef = useRef<AbortController | null>(null);
  const messageBusyRef = useRef(false);
  const pendingSubmissionRef = useRef<PendingSubmission | null>(null);
  const accountChangeChannelRef = useRef<BroadcastChannel | null>(null);
  const loadSessionRef = useRef<((options?: LoadSessionOptions) => Promise<void>) | null>(null);

  const registerRequest = useCallback(() => {
    const controller = new AbortController();
    requestsRef.current.add(controller);
    return controller;
  }, []);

  const releaseRequest = useCallback((controller: AbortController) => {
    requestsRef.current.delete(controller);
    if (detailRequestRef.current === controller) detailRequestRef.current = null;
    if (messageRequestRef.current === controller) messageRequestRef.current = null;
  }, []);

  const activateConversation = useCallback((conversationId: string | null) => {
    conversationEpochRef.current += 1;
    detailRequestRef.current?.abort();
    detailRequestRef.current = null;
    activeConversationIdRef.current = conversationId;
    setActiveConversationId(conversationId);
    return conversationEpochRef.current;
  }, []);

  const notifyAccountChange = useCallback(() => {
    accountChangeChannelRef.current?.postMessage({ type: "account-changed" });
  }, []);

  const updateConversationQuery = useCallback((conversationId: string | null) => {
    const url = new URL(window.location.href);
    if (conversationId) url.searchParams.set("conversation", conversationId);
    else url.searchParams.delete("conversation");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const clearAccountData = useCallback(() => {
    epochRef.current += 1;
    sessionRequestEpochRef.current += 1;
    conversationListEpochRef.current += 1;
    activateConversation(null);
    for (const controller of requestsRef.current) controller.abort();
    requestsRef.current.clear();
    detailRequestRef.current = null;
    messageRequestRef.current = null;
    accountRef.current = null;
    messageBusyRef.current = false;
    pendingSubmissionRef.current = null;
    setAccount(null);
    setConversations([]);
    setConversation(null);
    setDetailLoading(false);
    setMessageDraft("");
    setMessageBusy(false);
    setPendingRetry(false);
    setMessageError("");
    setTitleDraft("");
    setError("");
    setNotice("");
    setBusyAction(null);
    updateConversationQuery(null);
    return epochRef.current;
  }, [activateConversation, updateConversationQuery]);

  const expireAccount = useCallback(() => {
    clearAccountData();
    setSessionLoading(false);
    setError("站点账号会话已失效。请重新连接账号后查看会话。");
  }, [clearAccountData]);

  const refreshAfterAccountMismatch = useCallback(() => {
    clearAccountData();
    setSessionLoading(true);
    setNotice("检测到站点账号在其他标签页发生变化，正在刷新当前账号。");
    void Promise.resolve().then(() => loadSessionRef.current?.({ broadcastChange: true }));
  }, [clearAccountData]);

  const reportError = useCallback((cause: unknown, epoch: number) => {
    if (epoch !== epochRef.current || isAbortError(cause)) return;
    if (cause instanceof AccountApiError && cause.status === 409 && cause.code === "account_changed") {
      refreshAfterAccountMismatch();
      return;
    }
    if (cause instanceof AccountApiError && cause.status === 401) {
      expireAccount();
      return;
    }
    setError(cause instanceof Error ? cause.message : "账号会话请求没有完成。");
  }, [expireAccount, refreshAfterAccountMismatch]);

  const loadConversation = useCallback(async (conversationId: string, epoch: number, accountId: string, conversationEpoch: number) => {
    const isCurrentRequest = () => epoch === epochRef.current
      && accountRef.current?.id === accountId
      && conversationEpoch === conversationEpochRef.current
      && activeConversationIdRef.current === conversationId;
    if (!isCurrentRequest()) return;
    detailRequestRef.current?.abort();
    const controller = registerRequest();
    detailRequestRef.current = controller;
    setConversation(null);
    setDetailLoading(true);
    setMessageError("");
    try {
      const response = await requestJson<{ conversation: ConversationDetail }>(
        `/api/coach/conversations/${encodeURIComponent(conversationId)}`,
        { signal: controller.signal, accountId },
      );
      if (!isCurrentRequest() || controller.signal.aborted || response.conversation.id !== conversationId) return;
      setConversation(response.conversation);
    } catch (cause) {
      if (isCurrentRequest() || (epoch === epochRef.current && accountRef.current?.id === accountId && cause instanceof AccountApiError && cause.status === 401)) {
        reportError(cause, epoch);
      }
    } finally {
      releaseRequest(controller);
      if (isCurrentRequest()) setDetailLoading(false);
    }
  }, [registerRequest, releaseRequest, reportError]);

  const loadConversations = useCallback(async (epoch: number, accountId: string) => {
    const listEpoch = ++conversationListEpochRef.current;
    const controller = registerRequest();
    try {
      const response = await requestJson<{ conversations: ConversationSummary[] }>("/api/coach/conversations", { signal: controller.signal, accountId });
      if (epoch !== epochRef.current || listEpoch !== conversationListEpochRef.current || accountRef.current?.id !== accountId || controller.signal.aborted) return;
      setConversations(response.conversations);
      const requestedId = new URLSearchParams(window.location.search).get("conversation");
      const selectedId = response.conversations.find((item) => item.id === requestedId)?.id ?? response.conversations[0]?.id ?? null;
      const conversationEpoch = activateConversation(selectedId);
      updateConversationQuery(selectedId);
      if (selectedId) void loadConversation(selectedId, epoch, accountId, conversationEpoch);
      else {
        setConversation(null);
        setDetailLoading(false);
      }
    } catch (cause) {
      reportError(cause, epoch);
    } finally {
      releaseRequest(controller);
    }
  }, [activateConversation, loadConversation, registerRequest, releaseRequest, reportError, updateConversationQuery]);

  const loadSession = useCallback(async (options: LoadSessionOptions = {}) => {
    const requestEpoch = ++sessionRequestEpochRef.current;
    const epoch = epochRef.current;
    const previousAccountId = accountRef.current?.id ?? null;
    const controller = registerRequest();
    setSessionLoading(true);
    try {
      const nextStatus = await requestJson<SiteAccountStatus>("/api/site-account", { signal: controller.signal });
      if (epoch !== epochRef.current || requestEpoch !== sessionRequestEpochRef.current || controller.signal.aborted) return;
      setStatus(nextStatus);
      let activeEpoch = epoch;
      if (accountRef.current && accountRef.current.id !== nextStatus.account?.id) {
        activeEpoch = clearAccountData();
      }
      accountRef.current = nextStatus.account;
      setAccount(nextStatus.account);
      setSessionLoading(false);
      setError("");
      if (options.broadcastChange !== false && previousAccountId !== (nextStatus.account?.id ?? null)) notifyAccountChange();
      if (nextStatus.account) await loadConversations(activeEpoch, nextStatus.account.id);
      else {
        setConversations([]);
        activateConversation(null);
        setConversation(null);
        updateConversationQuery(null);
      }
    } catch (cause) {
      reportError(cause, epoch);
    } finally {
      releaseRequest(controller);
      if (epoch === epochRef.current) setSessionLoading(false);
    }
  }, [activateConversation, clearAccountData, loadConversations, notifyAccountChange, registerRequest, releaseRequest, reportError, updateConversationQuery]);

  useEffect(() => {
    loadSessionRef.current = loadSession;
  }, [loadSession]);

  useEffect(() => {
    let active = true;
    const requests = requestsRef.current;
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(accountChangeChannelName);
    accountChangeChannelRef.current = channel;
    const refreshAccount = () => { void loadSession({ broadcastChange: false }); };
    const handleChannelMessage = (event: MessageEvent<unknown>) => {
      if (event.data && typeof event.data === "object" && "type" in event.data && event.data.type === "account-changed") refreshAccount();
    };
    const handleFocus = () => {
      if (document.visibilityState === "visible") void loadSession({ broadcastChange: true });
    };
    channel?.addEventListener("message", handleChannelMessage);
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleFocus);
    void Promise.resolve().then(() => {
      if (active) void loadSession();
    });
    return () => {
      active = false;
      epochRef.current += 1;
      sessionRequestEpochRef.current += 1;
      for (const controller of requests) controller.abort();
      requests.clear();
      channel?.removeEventListener("message", handleChannelMessage);
      channel?.close();
      if (accountChangeChannelRef.current === channel) accountChangeChannelRef.current = null;
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleFocus);
    };
  }, [loadSession]);

  async function signInWithProvider(provider: SocialProvider) {
    if (!status?.providers[provider] || busyAction) return;
    const epoch = clearAccountData();
    setSessionLoading(true);
    setBusyAction("login");
    const controller = registerRequest();
    try {
      const response = await requestJson<{ url?: string; redirect?: boolean }>("/api/auth/sign-in/social", {
        method: "POST",
        body: { provider, callbackURL: "/coach/sessions/" },
        signal: controller.signal,
      });
      if (epoch !== epochRef.current) return;
      if (response.url) window.location.assign(response.url);
      else throw new Error("认证服务没有返回授权地址。");
    } catch (cause) {
      reportError(cause, epoch);
      if (epoch === epochRef.current) setSessionLoading(false);
    } finally {
      releaseRequest(controller);
      if (epoch === epochRef.current) setBusyAction(null);
    }
  }

  async function signInMock(userId: "mock-user-a" | "mock-user-b") {
    if (!status?.mockAuthEnabled || busyAction) return;
    const epoch = clearAccountData();
    setSessionLoading(true);
    setBusyAction("login");
    const controller = registerRequest();
    try {
      await requestJson<{ ok: true }>("/api/dev/mock-auth", { method: "POST", body: { userId }, signal: controller.signal });
      if (epoch !== epochRef.current) return;
      setBusyAction(null);
      await loadSession();
      setNotice("已通过本机 Mock 登录；此状态不代表 GitHub 或 Google OAuth 已验收。");
    } catch (cause) {
      reportError(cause, epoch);
      if (epoch === epochRef.current) setSessionLoading(false);
    } finally {
      releaseRequest(controller);
      if (epoch === epochRef.current) setBusyAction(null);
    }
  }

  async function signOut() {
    if (!account || busyAction) return;
    const authMethod = account.authMethod;
    const epoch = clearAccountData();
    setSessionLoading(true);
    setBusyAction("logout");
    const controller = registerRequest();
    try {
      if (authMethod === "mock") {
        await requestJson<{ ok: true }>("/api/dev/mock-auth", { method: "DELETE", signal: controller.signal, accountId: account.id });
      } else {
        await requestJson<{ success: boolean }>("/api/auth/sign-out", { method: "POST", body: {}, signal: controller.signal, accountId: account.id });
      }
      if (epoch !== epochRef.current) return;
      setBusyAction(null);
      notifyAccountChange();
      await loadSession({ broadcastChange: false });
    } catch (cause) {
      reportError(cause, epoch);
      if (epoch === epochRef.current) setSessionLoading(false);
    } finally {
      releaseRequest(controller);
      if (epoch === epochRef.current) setBusyAction(null);
    }
  }

  async function createConversation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!account || busyAction) return;
    const epoch = epochRef.current;
    const accountId = account.id;
    const previousConversationId = activeConversationIdRef.current;
    const selectionEpoch = activateConversation(null);
    conversationListEpochRef.current += 1;
    setConversation(null);
    setDetailLoading(false);
    updateConversationQuery(null);
    setBusyAction("create");
    setError("");
    const controller = registerRequest();
    try {
      const response = await requestJson<{ conversation: ConversationSummary }>("/api/coach/conversations", {
        method: "POST",
        body: { title: titleDraft.trim() || "新对话" },
        signal: controller.signal,
        accountId,
      });
      if (epoch !== epochRef.current || accountRef.current?.id !== accountId) return;
      const created = response.conversation;
      setConversations((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setTitleDraft("");
      if (selectionEpoch === conversationEpochRef.current && activeConversationIdRef.current === null) {
        activateConversation(created.id);
        setConversation({ ...created, messages: [] });
        setDetailLoading(false);
        setMessageDraft("");
        pendingSubmissionRef.current = null;
        setPendingRetry(false);
        setMessageError("");
        updateConversationQuery(created.id);
      }
      setNotice("会话已保存到站点账号，可刷新后继续查看。");
    } catch (cause) {
      reportError(cause, epoch);
      if (epoch === epochRef.current
        && accountRef.current?.id === accountId
        && selectionEpoch === conversationEpochRef.current
        && activeConversationIdRef.current === null
        && previousConversationId) {
        const restoreEpoch = activateConversation(previousConversationId);
        updateConversationQuery(previousConversationId);
        void loadConversation(previousConversationId, epoch, accountId, restoreEpoch);
      }
    } finally {
      releaseRequest(controller);
      if (epoch === epochRef.current) setBusyAction(null);
    }
  }

  async function selectConversation(conversationId: string) {
    if (!account) return;
    const epoch = epochRef.current;
    const conversationEpoch = activateConversation(conversationId);
    setMessageDraft("");
    setMessageError("");
    pendingSubmissionRef.current = null;
    setPendingRetry(false);
    updateConversationQuery(conversationId);
    await loadConversation(conversationId, epoch, account.id, conversationEpoch);
  }

  async function sendMessage(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const conversationId = activeConversationIdRef.current;
    if (!account || !conversationId || conversation?.id !== conversationId || messageBusyRef.current || !messageDraft.trim()) return;
    const epoch = epochRef.current;
    const conversationEpoch = conversationEpochRef.current;
    const isCurrentSubmission = () => epoch === epochRef.current
      && accountRef.current?.id === account.id
      && conversationEpoch === conversationEpochRef.current
      && activeConversationIdRef.current === conversationId;
    const pending = pendingSubmissionRef.current;
    const submission = pending?.conversationId === conversationId && pending.content === messageDraft
      ? pending
      : { id: crypto.randomUUID(), conversationId, content: messageDraft };
    pendingSubmissionRef.current = submission;
    messageBusyRef.current = true;
    setMessageBusy(true);
    setPendingRetry(false);
    setMessageError("");
    const controller = registerRequest();
    messageRequestRef.current?.abort();
    messageRequestRef.current = controller;
    try {
      const response = await requestJson<{ message: ConversationMessage; duplicate: boolean }>(
        `/api/coach/conversations/${encodeURIComponent(conversationId)}/messages`,
        { method: "POST", body: { clientMessageId: submission.id, content: submission.content }, signal: controller.signal, accountId: account.id },
      );
      if (!isCurrentSubmission() || controller.signal.aborted || response.message.conversationId !== conversationId) return;
      setConversation((current) => {
        if (!current || current.id !== conversationId || current.messages.some((message) => message.id === response.message.id)) return current;
        return { ...current, messages: [...current.messages, response.message], updatedAt: response.message.createdAt };
      });
      setConversations((current) => current.map((item) => item.id === conversationId ? { ...item, updatedAt: response.message.createdAt } : item)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)));
      setMessageDraft((current) => current === submission.content ? "" : current);
      pendingSubmissionRef.current = null;
      setPendingRetry(false);
      setMessageError("");
      setNotice(response.duplicate ? "已确认保存；服务器识别到这是同一条重试消息，没有重复新增。" : "你的消息已保存到站点账号。");
    } catch (cause) {
      if (epoch === epochRef.current && accountRef.current?.id === account.id && !isAbortError(cause)) {
        if (cause instanceof AccountApiError && cause.status === 401) expireAccount();
        else if (cause instanceof AccountApiError && cause.status === 409 && cause.code === "account_changed") refreshAfterAccountMismatch();
        else if (isCurrentSubmission()) {
          setPendingRetry(true);
          setMessageError("暂时没有收到保存确认。再次重试会沿用同一请求 ID，避免重复保存。");
        }
      }
    } finally {
      const isCurrentMessageRequest = messageRequestRef.current === controller;
      releaseRequest(controller);
      if (isCurrentMessageRequest) {
        messageBusyRef.current = false;
        if (epoch === epochRef.current) setMessageBusy(false);
      }
    }
  }

  const providerLabels: Record<SocialProvider, string> = { github: "GitHub", google: "Google" };
  const activeConversation = conversations.find((item) => item.id === activeConversationId) ?? null;

  return (
    <div className="coach-account-page">
      <section className="page-intro" aria-labelledby="account-page-title">
        <div className="eyebrow">SITE ACCOUNT · SERVER-SAVED MESSAGES</div>
        <div className="intro-row">
          <div>
            <h1 id="account-page-title">账号会话</h1>
            <p>连接知序站点账号，跨刷新查看会话并保存你发送的文本消息。</p>
          </div>
          <Badge variant="outline">模型连接：待接入</Badge>
        </div>
      </section>

      <Card className="coach-account-model-notice">
        <CardContent>
          <div><strong>站点账号与模型连接是两件事</strong><p>当前切片只提供账号会话和用户消息持久化，不会调用模型，也不会连接本机共享模型服务。助手流式回复尚未接入服务器保存。</p></div>
          <Badge variant="outline">无模型请求</Badge>
        </CardContent>
      </Card>

      {sessionLoading && !account ? (
        <Card><CardContent className="coach-account-loading"><LoaderCircle className="animate-spin" aria-hidden="true" />正在检查站点账号…</CardContent></Card>
      ) : account ? (
        <section className="coach-account-signed-in" aria-label="已连接站点账号">
          <Card className="coach-account-identity">
            <CardContent>
              <div className="coach-account-identity-icon"><UserRound size={19} aria-hidden="true" /></div>
              <div className="coach-account-identity-copy">
                <Badge variant="secondary"><CheckCircle2 size={13} aria-hidden="true" />站点账号已连接</Badge>
                <strong>{account.name || account.email}</strong>
                <span>{account.email}{account.authMethod === "mock" ? " · 本机 Mock" : " · OAuth"}</span>
              </div>
            <Button variant="outline" onClick={() => void signOut()} disabled={busyAction !== null || sessionLoading} data-testid="site-account-sign-out">
                {busyAction === "logout" ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <LogOut aria-hidden="true" />}
                退出并清空页面会话
              </Button>
            </CardContent>
          </Card>

          <div className="coach-account-session-layout">
            <Card className="coach-account-session-list-card">
              <CardHeader><CardTitle><MessageSquareText size={17} aria-hidden="true" />我的会话</CardTitle><p>只显示当前站点账号拥有的会话。</p></CardHeader>
              <CardContent>
                <form className="coach-account-new-session" onSubmit={(event) => void createConversation(event)}>
                  <Label htmlFor="account-session-title">新会话标题</Label>
                  <div><Input id="account-session-title" value={titleDraft} maxLength={120} onChange={(event) => setTitleDraft(event.target.value)} placeholder="例如：React 渲染与状态" disabled={busyAction !== null || sessionLoading} /><Button type="submit" size="sm" disabled={busyAction !== null || sessionLoading} data-testid="create-conversation"><Plus size={15} aria-hidden="true" />{busyAction === "create" ? "创建中" : "新建"}</Button></div>
                </form>
                {sessionLoading && conversations.length === 0 && <p className="coach-account-muted" role="status">正在读取会话列表…</p>}
                {!sessionLoading && conversations.length === 0 && <p className="coach-account-empty">还没有账号会话。新建后，刷新页面仍可继续查看。</p>}
                <ul className="coach-account-session-list" data-testid="session-list">
                  {conversations.map((item) => (
                    <li key={item.id}>
                      <button type="button" className={activeConversationId === item.id ? "is-active" : ""} onClick={() => void selectConversation(item.id)} data-testid={`conversation-${item.id}`}>
                        <span><strong>{item.title}</strong><small><Clock3 size={12} aria-hidden="true" />{formatDate(item.updatedAt)}</small></span>
                        <ArrowUpRight size={15} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
                <Button variant="ghost" size="sm" onClick={() => void loadSession()} disabled={sessionLoading || busyAction !== null} data-testid="refresh-session-list"><RefreshCw size={14} aria-hidden="true" />刷新账号与会话</Button>
              </CardContent>
            </Card>

            <Card className="coach-account-session-detail">
              <CardHeader>
                <div><CardTitle>{conversation?.title ?? activeConversation?.title ?? "会话详情"}</CardTitle><p>消息仅包含你发送并已保存的文本。</p></div>
                {detailLoading && <LoaderCircle className="animate-spin" size={17} aria-label="正在读取会话详情" />}
              </CardHeader>
              <CardContent>
                {!activeConversationId && <p className="coach-account-empty">新建或选择左侧会话后，可以保存文本消息。</p>}
                {activeConversationId && detailLoading && !conversation && <p className="coach-account-muted" role="status">正在读取会话详情…</p>}
                {conversation && (
                  <>
                    <ol className="coach-account-messages" data-testid="conversation-messages">
                      {conversation.messages.map((message) => (
                        <li key={message.id} data-testid="saved-message" data-message-id={message.id}>
                          <span>{message.role === "user" ? "我" : "助手"}</span>
                          <p>{message.content}</p>
                          <time dateTime={message.createdAt}>{formatDate(message.createdAt)}</time>
                        </li>
                      ))}
                      {conversation.messages.length === 0 && <li className="coach-account-empty-message">这个会话还没有消息。这里不会自动生成助手回复。</li>}
                    </ol>
                    <form className="coach-account-composer" onSubmit={(event) => void sendMessage(event)}>
                      <Label htmlFor="account-message">发送一条用户消息</Label>
                      <Textarea id="account-message" value={messageDraft} maxLength={500_000} onChange={(event) => {
                        const nextValue = event.target.value;
                        setMessageDraft(nextValue);
                        if (pendingSubmissionRef.current && pendingSubmissionRef.current.content !== nextValue) {
                          pendingSubmissionRef.current = null;
                          setPendingRetry(false);
                        }
                      }} placeholder="输入会保存到当前站点账号的消息……" disabled={messageBusy || busyAction !== null || sessionLoading} data-testid="message-draft" />
                      <div className="coach-account-composer-footer"><span>{messageDraft.length.toLocaleString("zh-CN")} / 500,000</span><Button type="submit" disabled={messageBusy || busyAction !== null || sessionLoading || !messageDraft.trim()} data-testid="send-message">{messageBusy ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Send size={15} aria-hidden="true" />}{messageBusy ? "保存中" : "保存消息"}</Button></div>
                      {messageError && <p className="coach-account-inline-error" role="alert"><AlertCircle size={15} aria-hidden="true" />{messageError}</p>}
                      {pendingRetry && !messageBusy && <Button type="button" variant="outline" size="sm" onClick={() => void sendMessage()} data-testid="retry-message">重试保存同一条消息</Button>}
                    </form>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </section>
      ) : (
        <Card className="coach-account-login-card">
          <CardHeader><CardTitle><LogIn size={18} aria-hidden="true" />连接知序站点账号</CardTitle><p>登录后可保存并读取此账号的用户消息。站点账号不会自动授权模型用量。</p></CardHeader>
          <CardContent>
            <div className="coach-account-provider-grid">
              {(["github", "google"] as const).map((provider) => (
                <div key={provider} className="coach-account-provider-row">
                  <div><strong>{providerLabels[provider]}</strong><span>{status?.providers[provider] ? "已配置，可连接" : "尚未配置"}</span></div>
                  {status?.providers[provider]
                    ? <Button onClick={() => void signInWithProvider(provider)} disabled={busyAction !== null || sessionLoading} data-testid={`sign-in-${provider}`}>{busyAction === "login" ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <LogIn size={15} aria-hidden="true" />}使用 {providerLabels[provider]} 登录</Button>
                    : <Badge variant="outline">未启用</Badge>}
                </div>
              ))}
            </div>
            {!status?.authConfigured && <p className="coach-account-setup-note">站点 OAuth 尚未就绪。先为站点配置认证地址、认证密钥和所选提供方凭据；本页不会发起未配置的授权流程。</p>}
            {status?.mockAuthEnabled && <div className="coach-account-mock-tools" aria-label="本机测试账号">
              <p>仅本机开发测试账号，不是正式登录方式。</p>
              <Button variant="outline" onClick={() => void signInMock("mock-user-a")} disabled={busyAction !== null} data-testid="mock-login-a">以测试账号 A 登录</Button>
              <Button variant="outline" onClick={() => void signInMock("mock-user-b")} disabled={busyAction !== null} data-testid="mock-login-b">以测试账号 B 登录</Button>
            </div>}
          </CardContent>
        </Card>
      )}

      {error && <p className="coach-account-inline-error" role="alert"><AlertCircle size={15} aria-hidden="true" />{error}</p>}
      {notice && <p className="coach-account-inline-notice" role="status"><CheckCircle2 size={15} aria-hidden="true" />{notice}</p>}
      {status && <p className="coach-account-storage-note">旧版 IndexedDB 学习记录仍保留在本设备，本页不读取、导入或删除它。</p>}
    </div>
  );
}
