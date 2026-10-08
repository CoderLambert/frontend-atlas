"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { AlertCircle, ArrowUpRight, CheckCircle2, Clock3, Copy, DatabaseBackup, LoaderCircle, LogIn, LogOut, MessageSquareText, Plus, RefreshCw, Send, Square, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { copyCodeText } from "@/lib/copy-code.mjs";
import { getLegacyCoachConversationsSnapshot, type CoachConversation } from "@/lib/study-store";

const CoachMarkdown = dynamic(() => import("@/components/site/coach-markdown").then((module) => module.CoachMarkdown), {
  loading: () => <p className="coach-markdown-loading">正在准备回复排版…</p>,
});

type SocialProvider = "github" | "google";
type SiteAccount = { id: string; name: string; email: string; authMethod: "mock" | "oauth" };
type SiteAccountStatus = {
  authConfigured: boolean;
  providers: Record<SocialProvider, boolean>;
  account: SiteAccount | null;
  mockAuthEnabled: boolean;
  assistantProvider: "local-mock" | "unavailable";
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
  status: "pending" | "streaming" | "complete" | "interrupted" | "failed" | "cancelled";
  contentPersisted?: boolean;
  createdAt: string;
};
type ConversationDetail = ConversationSummary & { messages: ConversationMessage[] };
type PendingSubmission = { id: string; conversationId: string; content: string };
type LoadSessionOptions = { broadcastChange?: boolean };
type UnsavedAssistantRecovery = {
  version: 1;
  accountId: string;
  conversationId: string;
  messageId: string;
  clientMessageId: string;
  userContent: string;
  content: string;
  status: ConversationMessage["status"];
  retryMode: "same" | "new";
  createdAt: string;
};
type DepartureAction =
  | { kind: "select-conversation"; conversationId: string }
  | { kind: "create-conversation"; title: string }
  | { kind: "sign-out" };
type PendingDeparture = { action: DepartureAction; recoveries: UnsavedAssistantRecovery[] };
type LegacyPreviewRecord = Omit<CoachConversation, "status"> & { status: string };
type LegacyImportResult = { index: number; status: "imported" | "already_imported" | "conflict" | "invalid" | "failed" };
type LegacyImportPreview = { accountId: string; records: LegacyPreviewRecord[] };

const unsavedRecoveryPrefix = "frontend-atlas:coach-unsaved-assistant:v1:";
const conversationMessageStatuses = new Set<ConversationMessage["status"]>(["pending", "streaming", "complete", "interrupted", "failed", "cancelled"]);

function unsavedRecoveryKey(accountId: string, conversationId: string, messageId: string) {
  return unsavedRecoveryPrefix + encodeURIComponent(accountId) + ":" + encodeURIComponent(conversationId) + ":" + encodeURIComponent(messageId);
}

function readUnsavedRecovery(accountId: string, conversationId: string, messageId: string): UnsavedAssistantRecovery | null {
  if (typeof window === "undefined") return null;
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(unsavedRecoveryKey(accountId, conversationId, messageId)) ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.version !== 1
      || record.accountId !== accountId
      || record.conversationId !== conversationId
      || record.messageId !== messageId
      || typeof record.clientMessageId !== "string"
      || typeof record.userContent !== "string"
      || typeof record.content !== "string"
      || typeof record.status !== "string"
      || !conversationMessageStatuses.has(record.status as ConversationMessage["status"])
      || (record.retryMode !== "same" && record.retryMode !== "new")
      || typeof record.createdAt !== "string") return null;
    return record as UnsavedAssistantRecovery;
  } catch {
    return null;
  }
}

function writeUnsavedRecovery(record: UnsavedAssistantRecovery) {
  if (typeof window === "undefined") return false;
  try {
    window.sessionStorage.setItem(unsavedRecoveryKey(record.accountId, record.conversationId, record.messageId), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

function removeUnsavedRecovery(accountId: string, conversationId: string, messageId: string) {
  if (typeof window === "undefined") return false;
  try {
    window.sessionStorage.removeItem(unsavedRecoveryKey(accountId, conversationId, messageId));
    return true;
  } catch {
    return false;
  }
}

function restoreUnsavedAssistantMessages(
  conversation: ConversationDetail,
  accountId: string,
  recoveryCache: Map<string, UnsavedAssistantRecovery>,
) {
  const recoveries: UnsavedAssistantRecovery[] = [];
  const messages = conversation.messages.map((message) => {
    if (message.role !== "assistant") return message;
    const key = unsavedRecoveryKey(accountId, conversation.id, message.id);
    const recovery = recoveryCache.get(key) ?? readUnsavedRecovery(accountId, conversation.id, message.id);
    if (!recovery) return message;
    recoveryCache.set(key, recovery);

    if (recovery.content.startsWith(message.content)) {
      if (recovery.content === message.content) {
        recoveryCache.delete(key);
        removeUnsavedRecovery(accountId, conversation.id, message.id);
        return message;
      }
      recoveries.push(recovery);
      return { ...message, content: recovery.content, status: recovery.status, contentPersisted: false };
    }

    if (message.content.startsWith(recovery.content)) {
      recoveryCache.delete(key);
      removeUnsavedRecovery(accountId, conversation.id, message.id);
    }
    return message;
  });
  return { conversation: { ...conversation, messages }, recoveries };
}

function upsertConversationMessages(current: ConversationDetail | null, conversationId: string, incoming: ConversationMessage[]) {
  if (!current || current.id !== conversationId) return current;
  const messages = [...current.messages];
  for (const message of incoming) {
    const index = messages.findIndex((candidate) => candidate.id === message.id);
    if (index < 0) messages.push(message);
    else messages[index] = { ...messages[index], ...message };
  }
  return { ...current, messages };
}

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

function legacyTextLength(value: unknown) {
  return typeof value === "string" ? value.length.toLocaleString("zh-CN") : "字段无效";
}

function legacyTextPreview(value: unknown) {
  return typeof value === "string" ? value : "（此字段格式无效；确认后会跳过该记录）";
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function messageStatusLabel(message: ConversationMessage) {
  if (message.role === "user") return "我";
  if (message.contentPersisted === false) return "助手 · 回复尚未保存";
  if (message.status === "pending" || message.status === "streaming") return "助手 · 正在生成";
  if (message.status === "interrupted") return "助手 · 已中断，保留部分内容";
  if (message.status === "failed") return "助手 · 运行失败，保留已保存内容";
  if (message.status === "cancelled") return "助手 · 已停止，保留部分内容";
  return "助手";
}

async function readAssistantStream(response: Response, onEvent: (event: Record<string, unknown>) => void) {
  if (!response.body) throw new Error("助手流没有返回可读取的数据。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parseLine = (line: string) => {
    const normalized = line.trim();
    if (!normalized) return;
    const event: unknown = JSON.parse(normalized);
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("助手流返回了无效事件。");
    onEvent(event as Record<string, unknown>);
  };
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      parseLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  parseLine(buffer);
}

export function CoachAccountSessions({ knownQids }: { knownQids: string[] }) {
  const knownQuestionIds = useMemo(() => new Set(knownQids), [knownQids]);
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
  const [retryMode, setRetryMode] = useState<"same" | "new">("same");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"login" | "logout" | "create" | null>(null);
  const [error, setError] = useState("");
  const [messageError, setMessageError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingDeparture, setPendingDeparture] = useState<PendingDeparture | null>(null);
  const [departureBusy, setDepartureBusy] = useState(false);
  const [recoveryStorageError, setRecoveryStorageError] = useState(false);
  const [legacyPreview, setLegacyPreview] = useState<LegacyImportPreview | null>(null);
  const [legacyImportResults, setLegacyImportResults] = useState<LegacyImportResult[]>([]);
  const [legacyImportBusy, setLegacyImportBusy] = useState(false);
  const [legacyImportError, setLegacyImportError] = useState("");
  const [legacyImportConfirmOpen, setLegacyImportConfirmOpen] = useState(false);
  const epochRef = useRef(0);
  const conversationEpochRef = useRef(0);
  const conversationListEpochRef = useRef(0);
  const sessionRequestEpochRef = useRef(0);
  const accountRef = useRef<SiteAccount | null>(null);
  const activeConversationIdRef = useRef<string | null>(null);
  const requestsRef = useRef(new Set<AbortController>());
  const detailRequestRef = useRef<AbortController | null>(null);
  const messageRequestRef = useRef<AbortController | null>(null);
  const activeRunRef = useRef<{
    runId: string;
    assistantMessageId: string;
    conversationId: string;
    accountId: string;
    clientMessageId: string;
    userContent: string;
    content: string;
    createdAt: string;
  } | null>(null);
  const recoveryBufferRef = useRef(new Map<string, UnsavedAssistantRecovery>());
  const discardedRecoveryKeysRef = useRef(new Set<string>());
  const messageBusyRef = useRef(false);
  const pendingSubmissionRef = useRef<PendingSubmission | null>(null);
  const accountChangeChannelRef = useRef<BroadcastChannel | null>(null);
  const loadSessionRef = useRef<((options?: LoadSessionOptions) => Promise<void>) | null>(null);

  const storeRecovery = useCallback((record: UnsavedAssistantRecovery) => {
    const key = unsavedRecoveryKey(record.accountId, record.conversationId, record.messageId);
    if (discardedRecoveryKeysRef.current.has(key)) return false;
    recoveryBufferRef.current.set(key, record);
    const stored = writeUnsavedRecovery(record);
    setRecoveryStorageError(!stored);
    return stored;
  }, []);

  const clearRecovery = useCallback((record: Pick<UnsavedAssistantRecovery, "accountId" | "conversationId" | "messageId">) => {
    const key = unsavedRecoveryKey(record.accountId, record.conversationId, record.messageId);
    recoveryBufferRef.current.delete(key);
    const removed = removeUnsavedRecovery(record.accountId, record.conversationId, record.messageId);
    if (!removed) setRecoveryStorageError(true);
  }, []);

  const persistActiveRunRecovery = useCallback((
    status: ConversationMessage["status"],
    retryMode: "same" | "new",
  ) => {
    const activeRun = activeRunRef.current;
    if (!activeRun?.content) return;
    storeRecovery({
      version: 1,
      accountId: activeRun.accountId,
      conversationId: activeRun.conversationId,
      messageId: activeRun.assistantMessageId,
      clientMessageId: activeRun.clientMessageId,
      userContent: activeRun.userContent,
      content: activeRun.content,
      status,
      retryMode,
      createdAt: activeRun.createdAt,
    });
  }, [storeRecovery]);

  const collectCurrentRecoveries = useCallback(() => {
    const accountId = accountRef.current?.id;
    const conversationId = activeConversationIdRef.current;
    if (!accountId || !conversationId) return [];

    const activeRun = activeRunRef.current;
    if (activeRun?.accountId === accountId && activeRun.conversationId === conversationId && activeRun.content) {
      persistActiveRunRecovery("streaming", "same");
    }

    const recoveries = new Map<string, UnsavedAssistantRecovery>();
    for (const [key, recovery] of recoveryBufferRef.current) {
      if (recovery.accountId === accountId && recovery.conversationId === conversationId) recoveries.set(key, recovery);
    }
    if (conversation?.id === conversationId) {
      for (const [index, message] of conversation.messages.entries()) {
        if (message.role !== "assistant" || message.contentPersisted !== false) continue;
        const key = unsavedRecoveryKey(accountId, conversationId, message.id);
        if (recoveries.has(key)) continue;
        const userMessage = conversation.messages.slice(0, index).reverse().find((candidate) => candidate.role === "user");
        const recovery = readUnsavedRecovery(accountId, conversationId, message.id) ?? {
          version: 1 as const,
          accountId,
          conversationId,
          messageId: message.id,
          clientMessageId: message.clientMessageId,
          userContent: userMessage?.content ?? "",
          content: message.content,
          status: message.status,
          retryMode: "new" as const,
          createdAt: message.createdAt,
        };
        storeRecovery(recovery);
        recoveries.set(key, recovery);
      }
    }
    return [...recoveries.values()].filter((recovery) => recovery.content.length > 0);
  }, [conversation, persistActiveRunRecovery, storeRecovery]);

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
    if (activeConversationIdRef.current !== conversationId && messageRequestRef.current) {
      persistActiveRunRecovery("interrupted", "new");
      messageRequestRef.current.abort();
      messageRequestRef.current = null;
      messageBusyRef.current = false;
      activeRunRef.current = null;
      setMessageBusy(false);
      setActiveRunId(null);
    }
    conversationEpochRef.current += 1;
    detailRequestRef.current?.abort();
    detailRequestRef.current = null;
    activeConversationIdRef.current = conversationId;
    setActiveConversationId(conversationId);
    return conversationEpochRef.current;
  }, [persistActiveRunRecovery]);

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
    activeRunRef.current = null;
    recoveryBufferRef.current.clear();
    accountRef.current = null;
    messageBusyRef.current = false;
    pendingSubmissionRef.current = null;
    setAccount(null);
    setConversations([]);
    setConversation(null);
    setDetailLoading(false);
    setMessageDraft("");
    setMessageBusy(false);
    setActiveRunId(null);
    setPendingRetry(false);
    setRetryMode("same");
    setMessageError("");
    setTitleDraft("");
    setError("");
    setNotice("");
    setPendingDeparture(null);
    setDepartureBusy(false);
    setBusyAction(null);
    setLegacyPreview(null);
    setLegacyImportResults([]);
    setLegacyImportBusy(false);
    setLegacyImportError("");
    setLegacyImportConfirmOpen(false);
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
    setConversation((current) => current?.id === conversationId ? current : null);
    setDetailLoading(true);
    setMessageError("");
    try {
      const response = await requestJson<{ conversation: ConversationDetail }>(
        `/api/coach/conversations/${encodeURIComponent(conversationId)}`,
        { signal: controller.signal, accountId },
      );
      if (!isCurrentRequest() || controller.signal.aborted || response.conversation.id !== conversationId) return;
      const restored = restoreUnsavedAssistantMessages(response.conversation, accountId, recoveryBufferRef.current);
      const activeRun = activeRunRef.current;
      if (activeRun?.accountId === accountId && activeRun.conversationId === conversationId) {
        const snapshotAssistant = restored.conversation.messages.find((message) => message.id === activeRun.assistantMessageId);
        if (snapshotAssistant?.role === "assistant"
          && snapshotAssistant.content.length > activeRun.content.length
          && snapshotAssistant.content.startsWith(activeRun.content)) {
          activeRun.content = snapshotAssistant.content;
          storeRecovery({
            version: 1,
            accountId: activeRun.accountId,
            conversationId: activeRun.conversationId,
            messageId: activeRun.assistantMessageId,
            clientMessageId: activeRun.clientMessageId,
            userContent: activeRun.userContent,
            content: activeRun.content,
            status: "streaming",
            retryMode: "same",
            createdAt: activeRun.createdAt,
          });
        }
      }
      setConversation((current) => {
        if (current?.id !== conversationId) return restored.conversation;
        const currentMessages = new Map(current.messages.map((message) => [message.id, message]));
        return {
          ...restored.conversation,
          messages: restored.conversation.messages.map((message) => {
            const localMessage = currentMessages.get(message.id);
            const isCurrentRun = activeRun?.assistantMessageId === message.id
              && activeRun.accountId === accountId
              && activeRun.conversationId === conversationId;
            if (message.role === "assistant"
              && localMessage?.role === "assistant"
              && localMessage.content.length > message.content.length
              && localMessage.content.startsWith(message.content)
              && (localMessage.contentPersisted === false || isCurrentRun)) {
              return { ...message, content: localMessage.content, status: localMessage.status, contentPersisted: false };
            }
            return message;
          }),
        };
      });
      if (restored.recoveries.length > 0 && !restored.recoveries.some((recovery) => activeRun?.assistantMessageId === recovery.messageId)) {
        const recovery = restored.recoveries.at(-1);
        if (recovery) {
          const restoredRetryMode: "same" | "new" = recovery.retryMode === "same"
            && recovery.status !== "streaming"
            && recovery.status !== "pending"
            ? "same"
            : recovery.retryMode === "same" ? "new" : recovery.retryMode;
          setMessageDraft((current) => current || recovery.userContent);
          pendingSubmissionRef.current = restoredRetryMode === "same"
            ? { id: recovery.clientMessageId, conversationId, content: recovery.userContent }
            : null;
          setPendingRetry(true);
          setRetryMode(restoredRetryMode);
          setMessageError("已恢复本标签页中尚未确认写入 SQLite 的回复；你可以复制备份或重新发起助手运行。");
        }
      }
    } catch (cause) {
      if (isCurrentRequest() || (epoch === epochRef.current && accountRef.current?.id === accountId && cause instanceof AccountApiError && cause.status === 401)) {
        reportError(cause, epoch);
      }
    } finally {
      releaseRequest(controller);
      if (isCurrentRequest()) setDetailLoading(false);
    }
  }, [registerRequest, releaseRequest, reportError, storeRecovery]);

  const loadConversations = useCallback(async (epoch: number, accountId: string) => {
    const listEpoch = ++conversationListEpochRef.current;
    const controller = registerRequest();
    try {
      const response = await requestJson<{ conversations: ConversationSummary[] }>("/api/coach/conversations", { signal: controller.signal, accountId });
      if (epoch !== epochRef.current || listEpoch !== conversationListEpochRef.current || accountRef.current?.id !== accountId || controller.signal.aborted) return;
      setConversations(response.conversations);
      const requestedId = new URLSearchParams(window.location.search).get("conversation");
      const selectedId = response.conversations.find((item) => item.id === requestedId)?.id ?? response.conversations[0]?.id ?? null;
      const conversationEpoch = activeConversationIdRef.current === selectedId
        ? conversationEpochRef.current
        : activateConversation(selectedId);
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
    const handlePageHide = () => persistActiveRunRecovery("interrupted", "new");
    channel?.addEventListener("message", handleChannelMessage);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("pagehide", handlePageHide);
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
      window.removeEventListener("pagehide", handlePageHide);
      document.removeEventListener("visibilitychange", handleFocus);
    };
  }, [loadSession, persistActiveRunRecovery]);

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

  async function previewLegacyImport() {
    const targetAccount = accountRef.current;
    if (!targetAccount || targetAccount.authMethod !== "oauth" || legacyImportBusy) return;
    const epoch = epochRef.current;
    setLegacyImportBusy(true);
    setLegacyImportError("");
    setLegacyImportResults([]);
    try {
      const records = await getLegacyCoachConversationsSnapshot();
      if (epoch !== epochRef.current || accountRef.current?.id !== targetAccount.id || accountRef.current.authMethod !== "oauth") return;
      setLegacyPreview({
        accountId: targetAccount.id,
        records: records as LegacyPreviewRecord[],
      });
    } catch (cause) {
      if (epoch === epochRef.current && accountRef.current?.id === targetAccount.id) {
        setLegacyImportError(cause instanceof Error ? cause.message : "无法读取本设备旧版 AI 对话。");
      }
    } finally {
      if (epoch === epochRef.current) setLegacyImportBusy(false);
    }
  }

  async function confirmLegacyImport() {
    const preview = legacyPreview;
    if (!preview || legacyImportBusy || accountRef.current?.id !== preview.accountId || accountRef.current.authMethod !== "oauth") {
      setLegacyPreview(null);
      setLegacyImportConfirmOpen(false);
      return;
    }
    setLegacyImportConfirmOpen(false);
    setLegacyImportBusy(true);
    setLegacyImportError("");
    setLegacyImportResults([]);
    const epoch = epochRef.current;
    const controller = registerRequest();
    const combinedResults: LegacyImportResult[] = [];
    try {
      for (let offset = 0; offset < preview.records.length; offset += 20) {
        if (epoch !== epochRef.current || accountRef.current?.id !== preview.accountId || controller.signal.aborted) {
          setLegacyPreview(null);
          break;
        }
        const batch = preview.records.slice(offset, offset + 20);
        const records = batch.map((record) => ({
          sourceId: record.conversationId,
          qid: record.qid,
          attemptId: record.attemptId,
          contentVersion: record.contentVersion,
          mode: record.mode,
          model: record.model,
          userInput: record.userInput,
          assistantOutput: record.assistantOutput,
          status: record.status,
          startedAt: record.startedAt,
          updatedAt: record.updatedAt,
        }));
        const response = await requestJson<{ results: LegacyImportResult[] }>(
          "/api/coach/conversations/legacy-import",
          { method: "POST", body: { records }, signal: controller.signal, accountId: preview.accountId },
        );
        if (!Array.isArray(response.results) || response.results.length !== batch.length) {
          throw new Error("服务器没有返回完整的逐条导入结果。");
        }
        for (const result of response.results) {
          if (!result || !Number.isInteger(result.index) || result.index < 0 || result.index >= batch.length
            || !["imported", "already_imported", "conflict", "invalid", "failed"].includes(result.status)) {
            throw new Error("服务器返回了无法识别的逐条导入结果。");
          }
          combinedResults.push({ index: offset + result.index, status: result.status });
        }
        setLegacyImportResults([...combinedResults]);
      }
      if (epoch === epochRef.current && accountRef.current?.id === preview.accountId) {
        setNotice("旧版对话导入已完成；本设备 IndexedDB 原记录仍保留。");
      }
    } catch (cause) {
      if (isAbortError(cause)) return;
      if (cause instanceof AccountApiError && cause.status === 409 && cause.code === "account_changed") {
        setLegacyPreview(null);
        reportError(cause, epoch);
        return;
      }
      if (epoch === epochRef.current && accountRef.current?.id === preview.accountId) {
        setLegacyImportError(cause instanceof Error ? cause.message : "旧版对话导入没有完成。可重新确认，已保存项目会安全识别为重复项。");
      }
    } finally {
      releaseRequest(controller);
      if (epoch === epochRef.current) setLegacyImportBusy(false);
    }
  }

  function requestDeparture(action: DepartureAction) {
    const recoveries = collectCurrentRecoveries();
    if (recoveries.length > 0) {
      setPendingDeparture({ action, recoveries });
      return;
    }
    continueDeparture(action);
  }

  function continueDeparture(action: DepartureAction) {
    setPendingDeparture(null);
    if (action.kind === "select-conversation") void selectConversationNow(action.conversationId);
    else if (action.kind === "create-conversation") void createConversationNow(action.title);
    else void performSignOut();
  }

  async function copyBackupAndContinue() {
    const departure = pendingDeparture;
    if (!departure || departureBusy) return;
    setDepartureBusy(true);
    try {
      const recoveries = collectCurrentRecoveries();
      const backup = recoveries.map((recovery) => recovery.content).join("\n\n---\n\n");
      if (!backup || !await copyCodeText(backup)) {
        setNotice("自动复制不可用；请先复制未保存回复，再选择放弃或留在当前会话。");
        return;
      }
      setNotice("未保存回复已复制到剪贴板；此标签页仍保留按账号隔离的恢复缓冲。");
      continueDeparture(departure.action);
    } finally {
      setDepartureBusy(false);
    }
  }

  function abandonAndContinue() {
    const departure = pendingDeparture;
    if (!departure) return;
    for (const recovery of collectCurrentRecoveries()) {
      const key = unsavedRecoveryKey(recovery.accountId, recovery.conversationId, recovery.messageId);
      discardedRecoveryKeysRef.current.add(key);
      clearRecovery(recovery);
    }
    continueDeparture(departure.action);
  }

  async function performSignOut() {
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

  function signOut() {
    if (!account || busyAction) return;
    requestDeparture({ kind: "sign-out" });
  }

  function createConversation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!account || busyAction) return;
    requestDeparture({ kind: "create-conversation", title: titleDraft.trim() || "新对话" });
  }

  async function createConversationNow(title: string) {
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
        body: { title },
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
        setRetryMode("same");
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

  function selectConversation(conversationId: string) {
    if (!account || conversationId === activeConversationIdRef.current) return;
    requestDeparture({ kind: "select-conversation", conversationId });
  }

  async function selectConversationNow(conversationId: string) {
    if (!account || conversationId === activeConversationIdRef.current) return;
    const epoch = epochRef.current;
    const conversationEpoch = activateConversation(conversationId);
    setMessageDraft("");
    setMessageError("");
    pendingSubmissionRef.current = null;
    setPendingRetry(false);
    setRetryMode("same");
    updateConversationQuery(conversationId);
    await loadConversation(conversationId, epoch, account.id, conversationEpoch);
  }

  async function copyUnsavedAssistantReply(content: string) {
    const copied = await copyCodeText(content);
    setNotice(copied
      ? "未保存回复已复制；SQLite 尚未确认保存这段完整内容。"
      : "自动复制不可用；请选中当前回复手动备份，SQLite 尚未确认保存这段完整内容。");
  }

  async function sendMessage(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const conversationId = activeConversationIdRef.current;
    if (!account || !status || !conversationId || conversation?.id !== conversationId || messageBusyRef.current || !messageDraft.trim()) return;
    const usesMockAssistant = status.assistantProvider === "local-mock";
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
    setActiveRunId(null);
    activeRunRef.current = null;
    setPendingRetry(false);
    setMessageError("");
    const controller = registerRequest();
    messageRequestRef.current?.abort();
    messageRequestRef.current = controller;
    try {
      if (!usesMockAssistant) {
        const saved = await requestJson<{ message: ConversationMessage; duplicate: boolean }>(
          `/api/coach/conversations/${encodeURIComponent(conversationId)}/messages`,
          { method: "POST", body: { clientMessageId: submission.id, content: submission.content }, signal: controller.signal, accountId: account.id },
        );
        if (!isCurrentSubmission() || controller.signal.aborted || saved.message.conversationId !== conversationId) return;
        setConversation((current) => upsertConversationMessages(current, conversationId, [saved.message]));
        setConversations((current) => current.map((item) => item.id === conversationId ? { ...item, updatedAt: saved.message.createdAt } : item)
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)));
        setMessageDraft((current) => current === submission.content ? "" : current);
        pendingSubmissionRef.current = null;
        setPendingRetry(false);
        setRetryMode("same");
        setMessageError("");
        setNotice(saved.duplicate ? "已确认保存；服务器识别到这是同一条重试消息，没有重复新增。" : "你的文本消息已保存；AI 未连接，因此没有助手回复。");
        return;
      }
      const response = await fetch(`/api/coach/conversations/${encodeURIComponent(conversationId)}/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [requestHeaderName]: requestHeaderValue,
          [expectedAccountHeaderName]: account.id,
        },
        body: JSON.stringify({ clientRunId: submission.id, content: submission.content }),
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const data = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
        const code = typeof data.error === "string" ? data.error : null;
        const message = code === "assistant_not_connected"
          ? "AI 未连接。当前页面不会为未配置的模型伪造回复。"
          : code === "account_changed" ? "站点账号已在其他标签页发生变化。" : code ?? "助手运行没有启动。";
        throw new AccountApiError(message, response.status, code);
      }
      if (response.headers.get("content-type")?.includes("application/json")) {
        const duplicate = await response.json() as {
          duplicate: boolean;
          run: { id: string; status: ConversationMessage["status"] };
          userMessage: ConversationMessage;
          assistantMessage: ConversationMessage;
        };
        if (!isCurrentSubmission() || controller.signal.aborted) return;
        setConversation((current) => upsertConversationMessages(current, conversationId, [duplicate.userMessage, duplicate.assistantMessage]));
        if (duplicate.run.status === "complete") {
          setMessageDraft((current) => current === submission.content ? "" : current);
          pendingSubmissionRef.current = null;
          setPendingRetry(false);
          setRetryMode("same");
          setNotice("服务器识别到这是同一运行键，没有重复调用助手；已恢复已保存结果。");
        } else if (duplicate.run.status === "pending" || duplicate.run.status === "streaming") {
          setPendingRetry(true);
          setRetryMode("same");
          setNotice("服务器识别到同一运行仍在进行，没有再次调用助手；重试同一运行键只会读取当前保存进度。");
        } else {
          pendingSubmissionRef.current = null;
          setPendingRetry(true);
          setRetryMode("new");
          setNotice("服务器识别到同一运行已结束，没有再次调用助手；可以明确发起一个新运行。");
        }
        return;
      }

      let sawTerminalEvent = false;
      await readAssistantStream(response, (event) => {
        if (!isCurrentSubmission() || controller.signal.aborted) return;
        if (event.type === "started") {
          const runId = typeof event.runId === "string" ? event.runId : "";
          const userMessage = event.userMessage as ConversationMessage;
          const assistantMessage = event.assistantMessage as ConversationMessage;
          if (!runId || userMessage?.conversationId !== conversationId || assistantMessage?.conversationId !== conversationId) return;
          activeRunRef.current = {
            runId,
            assistantMessageId: assistantMessage.id,
            conversationId,
            accountId: account.id,
            clientMessageId: submission.id,
            userContent: submission.content,
            content: assistantMessage.content,
            createdAt: assistantMessage.createdAt,
          };
          setActiveRunId(runId);
          setConversation((current) => upsertConversationMessages(current, conversationId, [userMessage, assistantMessage]));
          setConversations((current) => current.map((item) => item.id === conversationId ? { ...item, updatedAt: userMessage.createdAt } : item)
            .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)));
          setMessageError("");
          setNotice("消息已原子保存，正在接收本机 Mock 流式演示回复。");
        } else if (event.type === "delta" && typeof event.text === "string" && typeof event.runId === "string") {
          const activeRun = activeRunRef.current;
          if (!activeRun || activeRun.runId !== event.runId || activeRun.conversationId !== conversationId) return;
          const offset = event.offset;
          if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(offset + event.text.length)) {
            setMessageError("助手流缺少有效内容位置；当前回复仍已保留，请刷新会话后重试。");
            return;
          }
          if (offset > activeRun.content.length) {
            setMessageError("助手流内容出现缺口；当前回复仍已保留，请刷新会话后重试。");
            return;
          }
          const overlapLength = Math.min(event.text.length, activeRun.content.length - offset);
          if (overlapLength > 0
            && activeRun.content.slice(offset, offset + overlapLength) !== event.text.slice(0, overlapLength)) {
            setMessageError("助手流与已恢复的回复快照不一致；当前快照仍已保留。");
            return;
          }
          const unseenText = event.text.slice(overlapLength);
          if (!unseenText) return;
          activeRun.content += unseenText;
          storeRecovery({
            version: 1,
            accountId: activeRun.accountId,
            conversationId: activeRun.conversationId,
            messageId: activeRun.assistantMessageId,
            clientMessageId: activeRun.clientMessageId,
            userContent: activeRun.userContent,
            content: activeRun.content,
            status: "streaming",
            retryMode: "same",
            createdAt: activeRun.createdAt,
          });
          setConversation((current) => {
            if (!current || current.id !== conversationId) return current;
            return {
              ...current,
              messages: current.messages.map((message) => message.id === activeRun.assistantMessageId
                ? { ...message, content: activeRun.content, status: "streaming" }
                : message),
            };
          });
        } else if (event.type === "terminal" && typeof event.runId === "string") {
          const activeRun = activeRunRef.current;
          if (!activeRun || activeRun.runId !== event.runId || activeRun.conversationId !== conversationId) return;
          const streamedStatus = event.status;
          if (streamedStatus !== "complete" && streamedStatus !== "interrupted" && streamedStatus !== "failed" && streamedStatus !== "cancelled") return;
          const contentPersisted = event.contentPersisted !== false;
          const terminalStatusPersisted = event.terminalStatusPersisted !== false;
          const terminalStatus: ConversationMessage["status"] = streamedStatus === "complete" && (!contentPersisted || !terminalStatusPersisted)
            ? "failed"
            : streamedStatus;
          sawTerminalEvent = true;
          if (contentPersisted) {
            clearRecovery({
              accountId: activeRun.accountId,
              conversationId: activeRun.conversationId,
              messageId: activeRun.assistantMessageId,
            });
          } else {
            storeRecovery({
              version: 1,
              accountId: activeRun.accountId,
              conversationId: activeRun.conversationId,
              messageId: activeRun.assistantMessageId,
              clientMessageId: activeRun.clientMessageId,
              userContent: activeRun.userContent,
              content: activeRun.content,
              status: terminalStatus,
              retryMode: "new",
              createdAt: activeRun.createdAt,
            });
          }
          setConversation((current) => {
            if (!current || current.id !== conversationId) return current;
            return {
              ...current,
              messages: current.messages.map((message) => message.id === activeRun.assistantMessageId
                ? { ...message, status: terminalStatus, contentPersisted }
                : message),
            };
          });
          activeRunRef.current = null;
          setActiveRunId(null);
          messageBusyRef.current = false;
          setMessageBusy(false);
          if (terminalStatus === "complete") {
            setMessageDraft((current) => current === submission.content ? "" : current);
            pendingSubmissionRef.current = null;
            setPendingRetry(false);
            setRetryMode("same");
          setMessageError("");
            setNotice("本机 Mock 演示已完成，用户消息和助手回复均已保存。");
          } else {
            pendingSubmissionRef.current = null;
            setPendingRetry(true);
            setRetryMode("new");
            const errorMessage = !contentPersisted
              ? "回复尚未保存；完整内容仍在当前页面。请复制未保存回复备份，离开或刷新前先保存。"
              : !terminalStatusPersisted
                ? "回复文字已保存，但运行终态未写入数据库；刷新后可能显示为中断。"
                : terminalStatus === "failed"
                  ? "助手运行失败；数据库已保留成功保存的部分回复。"
                  : "助手运行已停止；你的输入和已保存的部分回复都已保留。";
            setMessageError(errorMessage);
          }
        }
      });
      if (!sawTerminalEvent && isCurrentSubmission() && !controller.signal.aborted) {
        throw new Error("流式连接提前结束；已保存进度可刷新恢复，重试不会重复启动同一运行。");
      }
    } catch (cause) {
      if (epoch === epochRef.current && accountRef.current?.id === account.id && !isAbortError(cause)) {
        if (cause instanceof AccountApiError && cause.status === 401) expireAccount();
        else if (cause instanceof AccountApiError && cause.status === 409 && cause.code === "account_changed") refreshAfterAccountMismatch();
        else if (isCurrentSubmission()) {
          persistActiveRunRecovery("interrupted", "same");
          setPendingRetry(true);
          setRetryMode("same");
          setMessageError(cause instanceof Error ? cause.message : "暂时没有收到运行确认。重试会沿用同一运行键，避免重复调用助手。");
        }
      }
    } finally {
      const isCurrentMessageRequest = messageRequestRef.current === controller;
      releaseRequest(controller);
      if (isCurrentMessageRequest) {
        messageBusyRef.current = false;
        if (epoch === epochRef.current && isCurrentSubmission()) setMessageBusy(false);
      }
    }
  }

  async function cancelAssistantRun() {
    const activeRun = activeRunRef.current;
    if (!account || !activeRun || activeRun.accountId !== account.id || activeRun.conversationId !== activeConversationIdRef.current) return;
    const epoch = epochRef.current;
    try {
      const result = await requestJson<{
        run: { status: ConversationMessage["status"] };
        assistantMessage: ConversationMessage;
        contentPersisted?: boolean;
        terminalStatusPersisted?: boolean;
      }>(
        `/api/coach/conversations/${encodeURIComponent(activeRun.conversationId)}/runs/${encodeURIComponent(activeRun.runId)}/cancel`,
        { method: "POST", body: {}, accountId: account.id },
      );
      if ((activeRunRef.current && activeRunRef.current.runId !== activeRun.runId)
        || epoch !== epochRef.current
        || accountRef.current?.id !== activeRun.accountId
        || activeConversationIdRef.current !== activeRun.conversationId) return;
      const submission = pendingSubmissionRef.current;
      const contentPersisted = result.contentPersisted ?? result.assistantMessage.content.startsWith(activeRun.content);
      const assistantMessage = {
        ...result.assistantMessage,
        content: contentPersisted ? result.assistantMessage.content : activeRun.content,
        contentPersisted,
      };
      if (contentPersisted) {
        clearRecovery({
          accountId: activeRun.accountId,
          conversationId: activeRun.conversationId,
          messageId: activeRun.assistantMessageId,
        });
      } else {
        storeRecovery({
          version: 1,
          accountId: activeRun.accountId,
          conversationId: activeRun.conversationId,
          messageId: activeRun.assistantMessageId,
          clientMessageId: activeRun.clientMessageId,
          userContent: activeRun.userContent,
          content: activeRun.content,
          status: result.run.status,
          retryMode: "new",
          createdAt: activeRun.createdAt,
        });
      }
      setConversation((current) => upsertConversationMessages(current, activeRun.conversationId, [assistantMessage]));
      activeRunRef.current = null;
      setActiveRunId(null);
      messageBusyRef.current = false;
      setMessageBusy(false);
      if (!contentPersisted || result.terminalStatusPersisted === false) {
        pendingSubmissionRef.current = null;
        setPendingRetry(true);
        setRetryMode("new");
        setMessageError(!contentPersisted
          ? "回复尚未保存；完整内容仍在当前页面。请复制未保存回复备份，离开或刷新前先保存。"
          : "回复文字已保存，但运行终态未写入数据库；刷新后可能显示为中断。");
      } else if (result.run.status === "cancelled" || result.run.status === "interrupted" || result.run.status === "failed") {
        pendingSubmissionRef.current = null;
        setPendingRetry(true);
        setRetryMode("new");
        setMessageError(result.run.status === "failed"
          ? "助手运行失败；数据库已保留成功保存的部分回复。"
          : "助手运行已停止；你的输入和已保存的部分回复都已保留。");
      } else if (result.run.status === "complete") {
        setMessageDraft((current) => current === submission?.content ? "" : current);
        pendingSubmissionRef.current = null;
        setPendingRetry(false);
        setMessageError("");
        setNotice("助手回复在停止请求到达前已经完成，结果已保存。");
      }
    } catch (cause) {
      if (!isAbortError(cause)) setMessageError(cause instanceof Error ? cause.message : "停止请求没有完成。");
    }
  }

  const providerLabels: Record<SocialProvider, string> = { github: "GitHub", google: "Google" };
  const activeConversation = conversations.find((item) => item.id === activeConversationId) ?? null;
  const currentLegacyPreview = account?.authMethod === "oauth" && legacyPreview?.accountId === account.id ? legacyPreview : null;
  const legacyPreviewRecords = currentLegacyPreview?.records ?? [];
  const unknownLegacyQids = [...new Set(legacyPreviewRecords.filter((record) => !knownQuestionIds.has(record.qid)).map((record) => typeof record.qid === "string" ? record.qid : ""))];
  const legacyDates = legacyPreviewRecords.map((record) => Date.parse(record.startedAt)).filter(Number.isFinite);
  const legacyDateRange = legacyDates.length > 0
    ? `${formatDate(new Date(legacyDates.reduce((minimum, value) => Math.min(minimum, value), Infinity)).toISOString())} – ${formatDate(new Date(legacyDates.reduce((maximum, value) => Math.max(maximum, value), -Infinity)).toISOString())}`
    : "时间未知";
  const legacyImportCounts = legacyImportResults.reduce<Record<LegacyImportResult["status"], number>>((counts, result) => {
    counts[result.status] += 1;
    return counts;
  }, { imported: 0, already_imported: 0, conflict: 0, invalid: 0, failed: 0 });

  return (
    <div className="coach-account-page">
      <section className="page-intro" aria-labelledby="account-page-title">
        <div className="eyebrow">SITE ACCOUNT · SERVER-SAVED MESSAGES</div>
        <div className="intro-row">
          <div>
            <h1 id="account-page-title">账号会话</h1>
            <p>连接知序站点账号，跨刷新查看你的消息与助手运行记录。</p>
          </div>
          <Badge variant="outline">{status?.assistantProvider === "local-mock" ? "本机 Mock 体验" : status?.assistantProvider === "unavailable" ? "AI 未连接" : "正在检查 AI 连接"}</Badge>
        </div>
      </section>

      <Card className="coach-account-model-notice">
        <CardContent>
          <div><strong>站点账号与模型连接是两件事</strong><p>{status?.assistantProvider === "local-mock"
            ? "仅 local:dev 本机启用 Mock 流式演示；它不会连接真实模型，也不会复用本机 SIWC 凭据。"
            : "AI 未连接。此页面不会伪造助手回复；你仍可保存纯文本消息，但不会收到助手回复。"}</p></div>
          <Badge variant="outline">{status?.assistantProvider === "local-mock" ? "明确标记的 Mock 回复" : "未连接"}</Badge>
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

          {account.authMethod === "oauth" && (
            <Card className="coach-account-legacy-import" data-testid="legacy-import">
              <CardHeader>
                <CardTitle><DatabaseBackup size={17} aria-hidden="true" />导入本设备旧版 AI 对话</CardTitle>
                <p>先在浏览器本地读取预览；只有再次确认后才会发送到当前站点账号。原 IndexedDB 记录不会修改或删除。</p>
              </CardHeader>
              <CardContent>
                <Button type="button" variant="outline" onClick={() => void previewLegacyImport()} disabled={legacyImportBusy || sessionLoading} data-testid="legacy-import-preview-button">
                  {legacyImportBusy ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
                  读取本地预览
                </Button>
                {currentLegacyPreview && (
                  <div className="coach-account-legacy-preview" data-testid="legacy-import-preview">
                    <p>共 {legacyPreviewRecords.length.toLocaleString("zh-CN")} 条；题号未关联 {unknownLegacyQids.length.toLocaleString("zh-CN")} 种；日期范围 {legacyDateRange}。每批最多 20 条；用户输入最多 12,000 字，助手内容最多 100,000 字。</p>
                    {legacyPreviewRecords.some((record) => record.status === "pending" || record.status === "streaming") && (
                      <p>其中 {legacyPreviewRecords.filter((record) => record.status === "pending" || record.status === "streaming").length} 条旧待处理/流式记录会作为历史中断内容导入，不会恢复或生成。</p>
                    )}
                    {unknownLegacyQids.length > 0 && <p>未关联题号会原样保留：{unknownLegacyQids.slice(0, 12).map((qid) => qid || "（空题号）").join("、")}{unknownLegacyQids.length > 12 ? " 等" : ""}</p>}
                    {legacyPreviewRecords.length === 0 ? <p>本设备没有旧版 AI 对话。</p> : (
                      <ul className="coach-account-legacy-preview-list">
                        {legacyPreviewRecords.slice(0, 30).map((record) => (
                          <li key={record.conversationId}>
                            <strong>{knownQuestionIds.has(record.qid) ? `题号 ${record.qid}` : `未关联题号 ${record.qid || "（空题号）"}`}</strong>
                            <span>{record.status === "pending" || record.status === "streaming" ? `原状态 ${record.status} · 导入后标记中断` : `历史状态 ${record.status}`}</span>
                            <small>{formatDate(record.startedAt)} · 用户 {legacyTextLength(record.userInput)} 字 · 助手 {legacyTextLength(record.assistantOutput)} 字</small>
                            <details className="coach-account-legacy-record-content">
                              <summary>展开本地文本预览</summary>
                              <div><strong>用户输入</strong><pre>{legacyTextPreview(record.userInput)}</pre></div>
                              <div><strong>助手回复</strong><pre>{legacyTextPreview(record.assistantOutput)}</pre></div>
                            </details>
                          </li>
                        ))}
                      </ul>
                    )}
                    {legacyPreviewRecords.length > 30 && <p>列表显示前 30 条，确认后会按 20 条一批导入全部 {legacyPreviewRecords.length} 条。</p>}
                    {legacyPreviewRecords.length > 0 && (
                      <Button type="button" onClick={() => setLegacyImportConfirmOpen(true)} disabled={legacyImportBusy} data-testid="legacy-import-confirm-open">
                        确认导入 {legacyPreviewRecords.length} 条
                      </Button>
                    )}
                    {legacyImportResults.length > 0 && (
                      <div className="coach-account-legacy-results" role="status" data-testid="legacy-import-results">
                        <p>已导入 {legacyImportCounts.imported} 条；已存在 {legacyImportCounts.already_imported} 条；冲突 {legacyImportCounts.conflict} 条；无效 {legacyImportCounts.invalid} 条；失败 {legacyImportCounts.failed} 条。</p>
                        {legacyImportResults.filter((result) => result.status === "conflict" || result.status === "invalid" || result.status === "failed").slice(0, 10).map((result) => (
                          <p key={result.index}>第 {result.index + 1} 条：{result.status === "conflict" ? "目标内容冲突，未覆盖" : result.status === "invalid" ? "字段不符合导入限制" : "保存失败，可重新确认安全重试"}</p>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {legacyImportError && <p className="coach-account-inline-error" role="alert" data-testid="legacy-import-error"><AlertCircle size={15} aria-hidden="true" />{legacyImportError}</p>}
              </CardContent>
            </Card>
          )}

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
                <div><CardTitle>{conversation?.title ?? activeConversation?.title ?? "会话详情"}</CardTitle><p>用户消息、助手回复和运行状态会一并保存。</p></div>
                {detailLoading && <LoaderCircle className="animate-spin" size={17} aria-label="正在读取会话详情" />}
              </CardHeader>
              <CardContent>
                {!activeConversationId && <p className="coach-account-empty">新建或选择左侧会话后，可以保存文本消息。</p>}
                {activeConversationId && detailLoading && !conversation && <p className="coach-account-muted" role="status">正在读取会话详情…</p>}
                {conversation && (
                  <>
                    <ol className="coach-account-messages" data-testid="conversation-messages">
                      {conversation.messages.map((message) => (
                        <li key={message.id} data-testid="saved-message" data-message-id={message.id} data-message-status={message.status}>
                          <span>{messageStatusLabel(message)}</span>
                          {message.role === "assistant"
                            ? <CoachMarkdown source={message.content} streaming={message.status === "pending" || message.status === "streaming"} />
                            : <p className="coach-account-message-content">{message.content}</p>}
                          {message.role === "assistant" && message.contentPersisted === false && (
                            <Button type="button" variant="outline" size="sm" onClick={() => void copyUnsavedAssistantReply(message.content)} data-testid="copy-unsaved-assistant-reply">
                              <Copy size={14} aria-hidden="true" />复制未保存回复
                            </Button>
                          )}
                          <time dateTime={message.createdAt}>{formatDate(message.createdAt)}</time>
                        </li>
                      ))}
                      {conversation.messages.length === 0 && <li className="coach-account-empty-message">向本机 Mock 助手发送一条消息后，会在这里显示并保存双方内容。</li>}
                    </ol>
                    <form className="coach-account-composer" onSubmit={(event) => void sendMessage(event)}>
                      <Label htmlFor="account-message">{status?.assistantProvider === "local-mock" ? "发送给本机 Mock 助手" : "保存纯文本消息（AI 未连接）"}</Label>
                      <Textarea id="account-message" value={messageDraft} maxLength={500_000} onChange={(event) => {
                        const nextValue = event.target.value;
                        setMessageDraft(nextValue);
                        if (pendingSubmissionRef.current && pendingSubmissionRef.current.content !== nextValue) {
                          pendingSubmissionRef.current = null;
                          setPendingRetry(false);
                        }
                      }} placeholder={status?.assistantProvider === "local-mock" ? "输入内容，观察本机 Mock 流式演示……" : "AI 未连接；保存后不会生成助手回复。"} disabled={messageBusy || busyAction !== null || sessionLoading || !status} data-testid="message-draft" />
                      <div className="coach-account-composer-footer"><span>{messageDraft.length.toLocaleString("zh-CN")} / 500,000</span><div className="coach-account-composer-actions">{messageBusy && activeRunId && <Button type="button" variant="outline" onClick={() => void cancelAssistantRun()} data-testid="cancel-assistant-run"><Square size={14} aria-hidden="true" />停止</Button>}<Button type="submit" disabled={messageBusy || busyAction !== null || sessionLoading || !status || !messageDraft.trim()} data-testid="send-message">{messageBusy ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Send size={15} aria-hidden="true" />}{messageBusy ? "生成中" : status?.assistantProvider === "local-mock" ? "发送" : "保存消息"}</Button></div></div>
                      {messageError && <p className="coach-account-inline-error" role="alert"><AlertCircle size={15} aria-hidden="true" />{messageError}</p>}
                      {pendingRetry && !messageBusy && <Button type="button" variant="outline" size="sm" onClick={() => void sendMessage()} data-testid="retry-message">{retryMode === "same" ? "重试同一运行键" : "重新发起新运行"}</Button>}
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

      {account && recoveryStorageError && (
        <p className="coach-account-inline-error" role="alert" data-testid="recovery-storage-warning">
          <AlertCircle size={15} aria-hidden="true" />
          浏览器无法写入此标签页的恢复缓冲；请复制尚未保存的助手回复，或在离开前明确备份。
        </p>
      )}
      <AlertDialog
        open={pendingDeparture !== null}
        onOpenChange={(open) => {
          if (!open && !departureBusy) setPendingDeparture(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>助手回复尚未完整写入 SQLite</AlertDialogTitle>
            <AlertDialogDescription>
              当前会话有 {pendingDeparture?.recoveries.length ?? 0} 条未确认保存的助手回复。离开前可复制备份，或明确放弃；恢复缓冲按账号、会话和消息隔离。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button type="button" variant="outline" onClick={() => void copyBackupAndContinue()} disabled={departureBusy} data-testid="copy-backup-and-leave">
              <Copy size={14} aria-hidden="true" />复制备份并继续
            </Button>
            <Button type="button" variant="destructive" onClick={abandonAndContinue} disabled={departureBusy} data-testid="abandon-unsaved-and-leave">
              放弃未保存回复并继续
            </Button>
            <Button type="button" variant="ghost" onClick={() => setPendingDeparture(null)} disabled={departureBusy} data-testid="stay-in-conversation">
              留在当前会话
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={legacyImportConfirmOpen && currentLegacyPreview !== null}
        onOpenChange={(open) => {
          if (!legacyImportBusy) setLegacyImportConfirmOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认导入旧版 AI 对话？</AlertDialogTitle>
            <AlertDialogDescription>
              将把本设备预览的 {legacyPreviewRecords.length} 条对话写入账号 {account?.email}（账号 ID：{currentLegacyPreview?.accountId}）。每批最多 20 条；超出字段限制的记录会标为无效，目标冲突不会覆盖。旧 IndexedDB 原记录会保留。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button type="button" variant="outline" onClick={() => setLegacyImportConfirmOpen(false)} disabled={legacyImportBusy} data-testid="legacy-import-cancel">返回预览</Button>
            <Button type="button" onClick={() => void confirmLegacyImport()} disabled={legacyImportBusy || !currentLegacyPreview} data-testid="legacy-import-confirm">
              {legacyImportBusy ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <DatabaseBackup size={14} aria-hidden="true" />}
              确认并上传到此账号
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {error && <p className="coach-account-inline-error" role="alert"><AlertCircle size={15} aria-hidden="true" />{error}</p>}
      {notice && <p className="coach-account-inline-notice" role="status"><CheckCircle2 size={15} aria-hidden="true" />{notice}</p>}
      {status && <p className="coach-account-storage-note">旧版 IndexedDB 学习记录仍保留在本设备；账号迁移需要手动预览并单独确认。</p>}
    </div>
  );
}
