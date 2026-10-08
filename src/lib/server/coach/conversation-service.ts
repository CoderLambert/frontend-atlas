import type { ConversationRepository } from "./conversation-repository.ts";
import type { CoachAssistantRunStatus } from "../../db/schema.ts";

export type ConversationInput = {
  title?: unknown;
  qid?: unknown;
  contentVersion?: unknown;
};

export type UserMessageInput = {
  clientMessageId?: unknown;
  content?: unknown;
};

export class ConversationService {
  private readonly repository: ConversationRepository;

  constructor(repository: ConversationRepository) {
    this.repository = repository;
  }

  recoverUnfinishedAssistantRuns() {
    return this.repository.interruptUnfinishedAssistantRuns();
  }

  list(ownerUserId: string) {
    return this.repository.listForOwner(ownerUserId);
  }

  create(ownerUserId: string, input: ConversationInput) {
    const title = typeof input.title === "string" ? input.title.trim() : "新对话";
    const qid = optionalText(input.qid, 200);
    const contentVersion = optionalText(input.contentVersion, 200);
    if (!title || title.length > 120) return { kind: "invalid" as const };

    const conversation = this.repository.createForOwner(ownerUserId, { title, qid, contentVersion });
    return {
      kind: "created" as const,
      conversation,
    };
  }

  find(ownerUserId: string, conversationId: string) {
    return this.repository.findForOwner(ownerUserId, conversationId);
  }

  delete(ownerUserId: string, conversationId: string) {
    return this.repository.deleteForOwner(ownerUserId, conversationId);
  }

  appendUserMessage(ownerUserId: string, conversationId: string, input: UserMessageInput) {
    if (typeof input.clientMessageId !== "string" || !input.clientMessageId.trim() || input.clientMessageId.length > 160) {
      return { kind: "invalid" as const };
    }
    if (typeof input.content !== "string" || !input.content.trim() || input.content.length > 500_000) {
      return { kind: "invalid" as const };
    }
    return this.repository.appendUserMessage(ownerUserId, conversationId, {
      clientMessageId: input.clientMessageId,
      content: input.content,
    });
  }

  createAssistantRun(ownerUserId: string, conversationId: string, input: {
    clientRunId?: unknown;
    content?: unknown;
    providerModel?: unknown;
    providerBindingVersion?: unknown;
  }) {
    if (typeof input.clientRunId !== "string" || !input.clientRunId.trim() || input.clientRunId.length > 128) {
      return { kind: "invalid" as const };
    }
    if (typeof input.content !== "string" || !input.content.trim() || input.content.length > 500_000) {
      return { kind: "invalid" as const };
    }
    const providerModel = typeof input.providerModel === "string" ? input.providerModel : null;
    const providerBindingVersion = typeof input.providerBindingVersion === "number" ? input.providerBindingVersion : null;
    if ((providerModel !== null && (!providerModel.trim() || providerModel.length > 160))
      || (providerBindingVersion !== null && (!Number.isSafeInteger(providerBindingVersion) || providerBindingVersion < 1))
      || ((providerModel === null) !== (providerBindingVersion === null))) {
      return { kind: "invalid" as const };
    }
    return this.repository.createAssistantRun(ownerUserId, conversationId, {
      clientRunId: input.clientRunId,
      content: input.content,
      providerModel,
      providerBindingVersion,
    });
  }

  findAssistantRunByClientId(ownerUserId: string, conversationId: string, input: {
    clientRunId?: unknown;
    content?: unknown;
  }) {
    if (typeof input.clientRunId !== "string" || !input.clientRunId.trim() || input.clientRunId.length > 128
      || typeof input.content !== "string" || !input.content.trim() || input.content.length > 500_000) {
      return { kind: "invalid" as const };
    }
    const existing = this.repository.findAssistantRunByClientId(ownerUserId, input.clientRunId);
    if (!existing) return { kind: "missing" as const };
    if (existing.run.conversationId !== conversationId || existing.userMessage.content !== input.content) {
      return { kind: "conflict" as const };
    }
    return { kind: "existing" as const, ...existing };
  }

  getAssistantRun(ownerUserId: string, conversationId: string, runId: string) {
    return this.repository.getAssistantRunForOwner(ownerUserId, conversationId, runId);
  }

  beginAssistantRun(runId: string) {
    return this.repository.beginAssistantRun(runId);
  }

  appendAssistantRunContent(runId: string, content: string) {
    return this.repository.appendAssistantRunContent(runId, content);
  }

  finishAssistantRun(runId: string, status: Exclude<CoachAssistantRunStatus, "pending" | "streaming">, tail = "", expectedContent?: string) {
    return this.repository.finishAssistantRun(runId, status, tail, expectedContent);
  }

  cancelAssistantRun(runId: string) {
    return this.repository.cancelAssistantRun(runId);
  }
}

function optionalText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}
