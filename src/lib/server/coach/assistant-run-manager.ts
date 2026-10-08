import type { CoachAssistantRunStatus } from "../../db/schema.ts";
import type { ConversationService } from "./conversation-service.ts";
import type { AssistantProvider } from "./assistant-provider.ts";

type TerminalRunStatus = "complete" | "interrupted" | "failed" | "cancelled";
type AbortStatus = "interrupted" | "cancelled";
type RunCompletion = {
  status: TerminalRunStatus;
  contentPersisted: boolean;
  terminalStatusPersisted: boolean;
  error?: string;
};
type ObservedIteratorNext<T> =
  | { kind: "result"; result: IteratorResult<T> }
  | { kind: "error"; error: unknown };

export type AssistantRunEvent =
  | { type: "started"; runId: string; userMessage: unknown; assistantMessage: unknown; duplicate: false }
  | { type: "delta"; runId: string; text: string }
  | ({ type: "terminal"; runId: string } & RunCompletion);

type IteratorResultEvent<T> = IteratorResult<T>;

class EventQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<(result: IteratorResultEvent<T>) => void> = [];
  private ended = false;

  push(value: T) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close() {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

type ActiveRun = {
  ownerUserId: string;
  conversationId: string;
  controller: AbortController;
  channel: EventQueue<AssistantRunEvent>;
  abortStatus: AbortStatus | null;
  completion: Promise<RunCompletion>;
};

function observeIteratorNext<T>(iterator: AsyncIterator<T>): Promise<ObservedIteratorNext<T>> {
  // Attach both handlers immediately. A later DB failure can leave this prefetched next() unawaited.
  return Promise.resolve().then(() => iterator.next()).then(
    (result) => ({ kind: "result", result }),
    (error: unknown) => ({ kind: "error", error }),
  );
}

function nextWithTimeout<T>(
  pending: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ kind: "item"; value: T } | { kind: "timeout" } | { kind: "aborted" }> {
  if (signal.aborted) return Promise.resolve({ kind: "aborted" });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
    const onAbort = () => settle({ kind: "aborted" });
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (value: { kind: "timeout" } | { kind: "aborted" } | { kind: "item"; value: T }) => {
      cleanup();
      resolve(value);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then((value) => settle({ kind: "item", value }), (error) => {
      cleanup();
      reject(error);
    });
  });
}

export class AssistantRunManager {
  private readonly service: ConversationService;
  private readonly active = new Map<string, ActiveRun>();

  constructor(service: ConversationService) {
    this.service = service;
  }

  start(input: {
    runId: string;
    ownerUserId: string;
    conversationId: string;
    userContent: string;
    userMessage: unknown;
    assistantMessage: unknown;
    provider: AssistantProvider;
  }) {
    const controller = new AbortController();
    const channel = new EventQueue<AssistantRunEvent>();
    const activeRun: ActiveRun = {
      ownerUserId: input.ownerUserId,
      conversationId: input.conversationId,
      controller,
      channel,
      abortStatus: null,
      completion: Promise.resolve({ status: "failed", contentPersisted: true, terminalStatusPersisted: false }),
    };
    this.active.set(input.runId, activeRun);
    channel.push({
      type: "started",
      runId: input.runId,
      userMessage: input.userMessage,
      assistantMessage: input.assistantMessage,
      duplicate: false,
    });
    activeRun.completion = this.execute(input, activeRun).finally(() => {
      channel.close();
      if (this.active.get(input.runId) === activeRun) this.active.delete(input.runId);
    });
    return {
      events: channel as AsyncIterable<AssistantRunEvent>,
      abort: (status: AbortStatus) => this.abort(input.runId, input.ownerUserId, status),
      completion: activeRun.completion,
    };
  }

  async abort(runId: string, ownerUserId: string, status: AbortStatus): Promise<RunCompletion | null> {
    const activeRun = this.active.get(runId);
    if (!activeRun || activeRun.ownerUserId !== ownerUserId) return null;
    if (!activeRun.abortStatus || status === "cancelled") activeRun.abortStatus = status;
    if (!activeRun.controller.signal.aborted) activeRun.controller.abort(activeRun.abortStatus);
    return activeRun.completion;
  }

  private async execute(
    input: {
      runId: string;
      ownerUserId: string;
      conversationId: string;
      userContent: string;
      provider: AssistantProvider;
    },
    activeRun: ActiveRun,
  ): Promise<RunCompletion> {
    let pendingContent = "";
    let generatedContent = "";
    let status: TerminalRunStatus = "failed";
    let terminalError: string | undefined;
    let contentPersisted = true;
    let terminalStatusPersisted = false;
    let storageWriteFailed = false;
    let iterator: AsyncIterator<string> | null = null;
    let providerEnded = false;

    const currentRun = () => {
      try {
        return this.service.getAssistantRun(input.ownerUserId, input.conversationId, input.runId);
      } catch {
        return null;
      }
    };
    const acceptExistingTerminal = () => {
      const current = currentRun();
      if (!current || !["complete", "interrupted", "failed", "cancelled"].includes(current.run.status)) return false;
      status = current.run.status as TerminalRunStatus;
      terminalStatusPersisted = true;
      contentPersisted = current.assistantMessage.content === generatedContent;
      if (contentPersisted) pendingContent = "";
      return true;
    };

    try {
      if (!this.service.beginAssistantRun(input.runId)) throw new Error("Run is no longer active.");
      iterator = input.provider.stream({ content: input.userContent, signal: activeRun.controller.signal })[Symbol.asyncIterator]();
      let next = observeIteratorNext(iterator);
      let totalLength = 0;
      let lastPersistAt = Date.now();
      const persistPendingContent = () => {
        if (!pendingContent) return;
        try {
          if (!this.service.appendAssistantRunContent(input.runId, pendingContent)) {
            storageWriteFailed = true;
            throw new Error("Run ended before the content could be saved.");
          }
        } catch (error) {
          storageWriteFailed = true;
          throw error;
        }
        pendingContent = "";
        contentPersisted = true;
        lastPersistAt = Date.now();
      };

      while (true) {
        const result = await nextWithTimeout(next, activeRun.controller.signal, 100);
        if (result.kind === "aborted") break;
        if (result.kind === "timeout") {
          persistPendingContent();
          continue;
        }
        if (result.value.kind === "error") throw result.value.error;
        if (result.value.result.done) {
          providerEnded = true;
          break;
        }

        const text = result.value.result.value;
        next = observeIteratorNext(iterator);
        if (typeof text !== "string" || !text) continue;
        totalLength += text.length;
        if (totalLength > 500_000) throw new Error("Assistant output exceeded the local limit.");
        generatedContent += text;
        pendingContent += text;
        contentPersisted = false;
        activeRun.channel.push({ type: "delta", runId: input.runId, text });
        if (pendingContent.length >= 256 || Date.now() - lastPersistAt >= 100) persistPendingContent();
      }

      status = activeRun.abortStatus ?? "complete";
    } catch {
      status = activeRun.abortStatus ?? "failed";
      terminalError = status === "failed"
        ? (storageWriteFailed ? "assistant_content_write_failed" : "assistant_run_failed")
        : undefined;
    } finally {
      try {
        const written = this.service.finishAssistantRun(input.runId, status, pendingContent, generatedContent);
        if (written) {
          pendingContent = "";
          contentPersisted = true;
          terminalStatusPersisted = true;
        } else if (!acceptExistingTerminal() || !contentPersisted) {
          throw new Error("Assistant run terminal state or tail could not be saved.");
        }
      } catch {
        if (status === "complete") status = "failed";
        const fallbackStatus = status;
        if (!terminalError) {
          terminalError = storageWriteFailed
            ? "assistant_content_write_failed"
            : status === "failed" ? "assistant_final_write_failed" : "assistant_terminal_write_failed";
        }

        if (!terminalStatusPersisted) {
          try {
            if (this.service.finishAssistantRun(input.runId, fallbackStatus, pendingContent, generatedContent)) {
              status = fallbackStatus;
              pendingContent = "";
              contentPersisted = true;
              terminalStatusPersisted = true;
            } else {
              acceptExistingTerminal();
            }
          } catch {
            // Keep pendingContent for the separate append attempt below.
          }
        }

        if (!terminalStatusPersisted && pendingContent) {
          try {
            if (this.service.appendAssistantRunContent(input.runId, pendingContent)) {
              pendingContent = "";
              contentPersisted = true;
            }
          } catch {
            storageWriteFailed = true;
          }
        }

        if (!terminalStatusPersisted && !pendingContent) {
          try {
            if (this.service.finishAssistantRun(input.runId, fallbackStatus, "", generatedContent)) {
              status = fallbackStatus;
              terminalStatusPersisted = true;
            } else {
              acceptExistingTerminal();
            }
          } catch {
            // The terminal event below reports that the DB did not confirm this state.
          }
        }

        contentPersisted = pendingContent.length === 0;
        if (!contentPersisted) terminalError = "assistant_content_not_saved";
        else if (!terminalStatusPersisted) terminalError = "assistant_terminal_state_not_saved";
      }

      if (iterator && !providerEnded) {
        if (!activeRun.controller.signal.aborted) activeRun.controller.abort(activeRun.abortStatus ?? status);
        try {
          const closing = iterator.return?.();
          if (closing) void Promise.resolve(closing).catch(() => {});
        } catch {
          // Cleanup is best-effort and must not replace the primary run or persistence error.
        }
      }
    }

    const completion: RunCompletion = {
      status,
      contentPersisted,
      terminalStatusPersisted,
      ...(terminalError ? { error: terminalError } : {}),
    };
    activeRun.channel.push({ type: "terminal", runId: input.runId, ...completion });
    return completion;
  }
}

export type AssistantRunTerminalStatus = Exclude<CoachAssistantRunStatus, "pending" | "streaming">;
