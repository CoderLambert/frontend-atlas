import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { coachAssistantRuns, coachConversations, coachMessages } from "../../db/schema.ts";
import type * as schema from "../../db/schema.ts";
import type { CoachAssistantRunStatus } from "../../db/schema.ts";

export type CoachDatabase = BetterSQLite3Database<typeof schema>;

export class ConversationRepository {
  private readonly database: CoachDatabase;

  constructor(database: CoachDatabase) {
    this.database = database;
  }

  listForOwner(ownerUserId: string) {
    return this.database.select().from(coachConversations)
      .where(eq(coachConversations.ownerUserId, ownerUserId))
      .orderBy(desc(coachConversations.updatedAt))
      .all();
  }

  createForOwner(ownerUserId: string, input: { title: string; qid: string | null; contentVersion: string | null }) {
    const now = new Date();
    const [conversation] = this.database.insert(coachConversations).values({
      id: randomUUID(),
      ownerUserId,
      title: input.title,
      qid: input.qid,
      contentVersion: input.contentVersion,
      createdAt: now,
      updatedAt: now,
    }).returning().all();
    return conversation;
  }

  findForOwner(ownerUserId: string, conversationId: string) {
    const [conversation] = this.database.select().from(coachConversations)
      .where(and(eq(coachConversations.ownerUserId, ownerUserId), eq(coachConversations.id, conversationId)))
      .limit(1)
      .all();
    if (!conversation) return null;

    const messages = this.database.select().from(coachMessages)
      .where(and(eq(coachMessages.ownerUserId, ownerUserId), eq(coachMessages.conversationId, conversationId)))
      .orderBy(coachMessages.createdAt)
      .all();
    return { ...conversation, messages };
  }

  deleteForOwner(ownerUserId: string, conversationId: string) {
    const deleted = this.database.delete(coachConversations)
      .where(and(eq(coachConversations.ownerUserId, ownerUserId), eq(coachConversations.id, conversationId)))
      .returning({ id: coachConversations.id })
      .all();
    return deleted.length > 0;
  }

  appendUserMessage(ownerUserId: string, conversationId: string, input: { clientMessageId: string; content: string }) {
    return this.database.transaction((transaction) => {
      const [conversation] = transaction.select({ id: coachConversations.id })
        .from(coachConversations)
        .where(and(eq(coachConversations.ownerUserId, ownerUserId), eq(coachConversations.id, conversationId)))
        .limit(1)
        .all();
      if (!conversation) return { kind: "not-found" as const };

      const now = new Date();
      const [inserted] = transaction.insert(coachMessages).values({
        id: randomUUID(),
        conversationId,
        ownerUserId,
        clientMessageId: input.clientMessageId,
        role: "user",
        content: input.content,
        status: "complete",
        createdAt: now,
      }).onConflictDoNothing({
        target: [coachMessages.ownerUserId, coachMessages.clientMessageId],
      }).returning().all();

      if (!inserted) {
        const [existing] = transaction.select().from(coachMessages)
          .where(and(
            eq(coachMessages.ownerUserId, ownerUserId),
            eq(coachMessages.clientMessageId, input.clientMessageId),
          )).limit(1).all();
        if (existing?.conversationId === conversationId && existing.content === input.content) {
          return { kind: "created" as const, message: existing, duplicate: true };
        }
        return { kind: "conflict" as const };
      }

      transaction.update(coachConversations).set({ updatedAt: now })
        .where(and(eq(coachConversations.ownerUserId, ownerUserId), eq(coachConversations.id, conversationId)))
        .run();
      return { kind: "created" as const, message: inserted, duplicate: false };
    });
  }

  createAssistantRun(ownerUserId: string, conversationId: string, input: { clientRunId: string; content: string }) {
    return this.database.transaction((transaction) => {
      const [conversation] = transaction.select({ id: coachConversations.id })
        .from(coachConversations)
        .where(and(eq(coachConversations.ownerUserId, ownerUserId), eq(coachConversations.id, conversationId)))
        .limit(1)
        .all();
      if (!conversation) return { kind: "not-found" as const };

      const [existingRun] = transaction.select().from(coachAssistantRuns)
        .where(and(
          eq(coachAssistantRuns.ownerUserId, ownerUserId),
          eq(coachAssistantRuns.clientRunId, input.clientRunId),
        )).limit(1).all();
      if (existingRun) {
        const [userMessage] = transaction.select().from(coachMessages)
          .where(and(eq(coachMessages.ownerUserId, ownerUserId), eq(coachMessages.id, existingRun.userMessageId)))
          .limit(1).all();
        const [assistantMessage] = transaction.select().from(coachMessages)
          .where(and(eq(coachMessages.ownerUserId, ownerUserId), eq(coachMessages.id, existingRun.assistantMessageId)))
          .limit(1).all();
        if (existingRun.conversationId === conversationId && userMessage?.content === input.content && assistantMessage) {
          return { kind: "existing" as const, run: existingRun, userMessage, assistantMessage };
        }
        return { kind: "conflict" as const };
      }

      const now = new Date();
      const userMessageId = randomUUID();
      const assistantMessageId = randomUUID();
      const runId = randomUUID();
      const [userMessage] = transaction.insert(coachMessages).values({
        id: userMessageId,
        conversationId,
        ownerUserId,
        clientMessageId: `${runId}:user`,
        role: "user",
        content: input.content,
        status: "complete",
        createdAt: now,
      }).returning().all();
      const [assistantMessage] = transaction.insert(coachMessages).values({
        id: assistantMessageId,
        conversationId,
        ownerUserId,
        clientMessageId: `${runId}:assistant`,
        role: "assistant",
        content: "",
        status: "pending",
        createdAt: now,
      }).returning().all();
      const [run] = transaction.insert(coachAssistantRuns).values({
        id: runId,
        ownerUserId,
        conversationId,
        clientRunId: input.clientRunId,
        userMessageId,
        assistantMessageId,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      }).returning().all();
      transaction.update(coachConversations).set({ updatedAt: now })
        .where(and(eq(coachConversations.ownerUserId, ownerUserId), eq(coachConversations.id, conversationId)))
        .run();
      return { kind: "created" as const, run, userMessage, assistantMessage };
    });
  }

  getAssistantRunForOwner(ownerUserId: string, conversationId: string, runId: string) {
    const [run] = this.database.select().from(coachAssistantRuns)
      .where(and(
        eq(coachAssistantRuns.ownerUserId, ownerUserId),
        eq(coachAssistantRuns.conversationId, conversationId),
        eq(coachAssistantRuns.id, runId),
      )).limit(1).all();
    if (!run) return null;
    const [userMessage] = this.database.select().from(coachMessages)
      .where(and(eq(coachMessages.ownerUserId, ownerUserId), eq(coachMessages.id, run.userMessageId)))
      .limit(1).all();
    const [assistantMessage] = this.database.select().from(coachMessages)
      .where(and(eq(coachMessages.ownerUserId, ownerUserId), eq(coachMessages.id, run.assistantMessageId)))
      .limit(1).all();
    if (!userMessage || !assistantMessage) return null;
    return { run, userMessage, assistantMessage };
  }

  beginAssistantRun(runId: string) {
    return this.database.transaction((transaction) => {
      const [run] = transaction.select().from(coachAssistantRuns)
        .where(eq(coachAssistantRuns.id, runId)).limit(1).all();
      if (!run || !["pending", "streaming"].includes(run.status)) return false;
      const now = new Date();
      transaction.update(coachMessages).set({ status: "streaming" })
        .where(eq(coachMessages.id, run.assistantMessageId)).run();
      transaction.update(coachAssistantRuns).set({ status: "streaming", updatedAt: now })
        .where(eq(coachAssistantRuns.id, runId)).run();
      return true;
    });
  }

  appendAssistantRunContent(runId: string, content: string) {
    if (!content) return true;
    return this.database.transaction((transaction) => {
      const [run] = transaction.select().from(coachAssistantRuns)
        .where(eq(coachAssistantRuns.id, runId)).limit(1).all();
      if (!run || !["pending", "streaming"].includes(run.status)) return false;
      const [message] = transaction.select({ content: coachMessages.content })
        .from(coachMessages).where(eq(coachMessages.id, run.assistantMessageId)).limit(1).all();
      if (!message) return false;
      const now = new Date();
      transaction.update(coachMessages).set({ content: message.content + content, status: "streaming" })
        .where(eq(coachMessages.id, run.assistantMessageId)).run();
      transaction.update(coachAssistantRuns).set({ status: "streaming", updatedAt: now })
        .where(eq(coachAssistantRuns.id, runId)).run();
      return true;
    });
  }

  finishAssistantRun(runId: string, status: Exclude<CoachAssistantRunStatus, "pending" | "streaming">, tail = "") {
    return this.database.transaction((transaction) => {
      const [run] = transaction.select().from(coachAssistantRuns)
        .where(eq(coachAssistantRuns.id, runId)).limit(1).all();
      if (!run) return false;
      if (!["pending", "streaming"].includes(run.status)) return run.status === status;
      const [message] = transaction.select({ content: coachMessages.content })
        .from(coachMessages).where(eq(coachMessages.id, run.assistantMessageId)).limit(1).all();
      if (!message) return false;
      const now = new Date();
      transaction.update(coachMessages).set({ content: message.content + tail, status })
        .where(eq(coachMessages.id, run.assistantMessageId)).run();
      transaction.update(coachAssistantRuns).set({ status, updatedAt: now })
        .where(eq(coachAssistantRuns.id, runId)).run();
      return true;
    });
  }

  cancelAssistantRun(runId: string) {
    return this.database.transaction((transaction) => {
      const [run] = transaction.select().from(coachAssistantRuns)
        .where(eq(coachAssistantRuns.id, runId)).limit(1).all();
      if (!run) return false;
      if (!["pending", "streaming", "interrupted"].includes(run.status)) return run.status === "cancelled";
      const now = new Date();
      transaction.update(coachMessages).set({ status: "cancelled" })
        .where(eq(coachMessages.id, run.assistantMessageId)).run();
      transaction.update(coachAssistantRuns).set({ status: "cancelled", updatedAt: now })
        .where(eq(coachAssistantRuns.id, runId)).run();
      return true;
    });
  }

  interruptUnfinishedAssistantRuns() {
    return this.database.transaction((transaction) => {
      const unfinished = transaction.select().from(coachAssistantRuns)
        .where(inArray(coachAssistantRuns.status, ["pending", "streaming"]))
        .all();
      const now = new Date();
      for (const run of unfinished) {
        transaction.update(coachMessages).set({ status: "interrupted" })
          .where(eq(coachMessages.id, run.assistantMessageId)).run();
        transaction.update(coachAssistantRuns).set({ status: "interrupted", updatedAt: now })
          .where(eq(coachAssistantRuns.id, run.id)).run();
      }
      return unfinished.length;
    });
  }
}
