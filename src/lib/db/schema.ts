import { relations, sql } from "drizzle-orm";
import { check, foreignKey, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { account, session, user, verification } from "./auth-schema.ts";

export { account, session, user, verification };

export type CoachMessageStatus = "pending" | "streaming" | "complete" | "interrupted" | "failed" | "cancelled";
export type CoachMessageRole = "user" | "assistant";

export const coachConversations = sqliteTable("coach_conversations", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  title: text("title").notNull().default("新对话"),
  qid: text("qid"),
  contentVersion: text("content_version"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  unique("coach_conversations_owner_id_id_unique").on(table.ownerUserId, table.id),
  index("coach_conversations_owner_updated_idx").on(table.ownerUserId, table.updatedAt),
]);

export const coachMessages = sqliteTable("coach_messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  ownerUserId: text("owner_user_id").notNull(),
  clientMessageId: text("client_message_id").notNull(),
  role: text("role").$type<CoachMessageRole>().notNull(),
  content: text("content").notNull(),
  status: text("status").$type<CoachMessageStatus>().notNull().default("complete"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  foreignKey({
    name: "coach_messages_owner_conversation_fk",
    columns: [table.ownerUserId, table.conversationId],
    foreignColumns: [coachConversations.ownerUserId, coachConversations.id],
  }).onDelete("cascade"),
  unique("coach_messages_owner_client_id_unique").on(table.ownerUserId, table.clientMessageId),
  check("coach_messages_role_check", sql`${table.role} in ('user', 'assistant')`),
  check("coach_messages_status_check", sql`${table.status} in ('pending', 'streaming', 'complete', 'interrupted', 'failed', 'cancelled')`),
  index("coach_messages_owner_conversation_created_idx").on(table.ownerUserId, table.conversationId, table.createdAt),
]);

export const coachConversationsRelations = relations(coachConversations, ({ many, one }) => ({
  owner: one(user, {
    fields: [coachConversations.ownerUserId],
    references: [user.id],
  }),
  messages: many(coachMessages),
}));

export const coachMessagesRelations = relations(coachMessages, ({ one }) => ({
  conversation: one(coachConversations, {
    fields: [coachMessages.ownerUserId, coachMessages.conversationId],
    references: [coachConversations.ownerUserId, coachConversations.id],
  }),
}));
