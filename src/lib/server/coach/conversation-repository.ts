import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { coachConversations, coachMessages } from "../../db/schema.ts";
import type * as schema from "../../db/schema.ts";

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
}
