import { relations, sql } from "drizzle-orm";
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";
import { account, session, user, verification } from "./auth-schema.ts";

export { account, session, user, verification };

export type CoachMessageStatus = "pending" | "streaming" | "complete" | "interrupted" | "failed" | "cancelled";
export type CoachMessageRole = "user" | "assistant";
export type CoachAssistantRunStatus = CoachMessageStatus;
export type QuestionChangeProposalStatus = "submitted" | "withdrawn" | "approved" | "rejected" | "published";
export type QuestionReviewDecision = "approved" | "rejected";
export type SiteRole = "reviewer" | "operator";
export type QuestionPublicationStatus = "prepared" | "published";

export const coachConversations = sqliteTable("coach_conversations", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  title: text("title").notNull().default("新对话"),
  qid: text("qid"),
  contentVersion: text("content_version"),
  legacyMetadataJson: text("legacy_metadata_json"),
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
  unique("coach_messages_owner_conversation_id_unique").on(table.ownerUserId, table.conversationId, table.id),
  index("coach_messages_owner_conversation_created_idx").on(table.ownerUserId, table.conversationId, table.createdAt),
]);

export const coachAssistantRuns = sqliteTable("coach_assistant_runs", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  clientRunId: text("client_run_id").notNull(),
  userMessageId: text("user_message_id").notNull(),
  assistantMessageId: text("assistant_message_id").notNull(),
  providerModel: text("provider_model"),
  providerBindingVersion: integer("provider_binding_version"),
  status: text("status").$type<CoachAssistantRunStatus>().notNull().default("pending"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  foreignKey({
    name: "coach_assistant_runs_owner_conversation_fk",
    columns: [table.ownerUserId, table.conversationId],
    foreignColumns: [coachConversations.ownerUserId, coachConversations.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "coach_assistant_runs_user_message_fk",
    columns: [table.ownerUserId, table.conversationId, table.userMessageId],
    foreignColumns: [coachMessages.ownerUserId, coachMessages.conversationId, coachMessages.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "coach_assistant_runs_assistant_message_fk",
    columns: [table.ownerUserId, table.conversationId, table.assistantMessageId],
    foreignColumns: [coachMessages.ownerUserId, coachMessages.conversationId, coachMessages.id],
  }).onDelete("cascade"),
  unique("coach_assistant_runs_owner_client_id_unique").on(table.ownerUserId, table.clientRunId),
  index("coach_assistant_runs_owner_conversation_created_idx").on(table.ownerUserId, table.conversationId, table.createdAt),
  check("coach_assistant_runs_status_check", sql`${table.status} in ('pending', 'streaming', 'complete', 'interrupted', 'failed', 'cancelled')`),
]);

export const coachProviderBindings = sqliteTable("coach_provider_bindings", {
  ownerUserId: text("owner_user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  siwcClientId: text("siwc_client_id").notNull().unique(),
  selectedModel: text("selected_model"),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const questionPrivateOverrides = sqliteTable("question_private_overrides", {
  ownerUserId: text("owner_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  qid: text("qid").notNull(),
  baseContentVersion: text("base_content_version").notNull(),
  baseContentSha256: text("base_content_sha256").notNull().default(""),
  title: text("title").notNull(),
  explanationMarkdown: text("explanation_markdown").notNull(),
  checkpointsJson: text("checkpoints_json").notNull(),
  generationId: text("generation_id").notNull().default(""),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  primaryKey({ name: "question_private_overrides_owner_qid_pk", columns: [table.ownerUserId, table.qid] }),
  index("question_private_overrides_owner_updated_idx").on(table.ownerUserId, table.updatedAt),
]);

export const questionChangeProposals = sqliteTable("question_change_proposals", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  qid: text("qid").notNull(),
  sourceGenerationId: text("source_generation_id").notNull(),
  sourceOverrideVersion: integer("source_override_version").notNull(),
  baseContentVersion: text("base_content_version").notNull(),
  baseContentSha256: text("base_content_sha256").notNull().default(""),
  title: text("title").notNull(),
  explanationMarkdown: text("explanation_markdown").notNull(),
  checkpointsJson: text("checkpoints_json").notNull(),
  summary: text("summary").notNull(),
  status: text("status").$type<QuestionChangeProposalStatus>().notNull().default("submitted"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  withdrawnAt: integer("withdrawn_at", { mode: "timestamp_ms" }),
}, (table) => [
  index("question_change_proposals_owner_qid_created_idx").on(table.ownerUserId, table.qid, table.createdAt),
  uniqueIndex("question_change_proposals_owner_qid_active_unique")
    .on(table.ownerUserId, table.qid)
    .where(sql`${table.status} = 'submitted'`),
  check("question_change_proposals_status_check", sql`${table.status} in ('submitted', 'withdrawn', 'approved', 'rejected', 'published')`),
]);

export const questionChangeProposalSources = sqliteTable("question_change_proposal_sources", {
  ownerUserId: text("owner_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  qid: text("qid").notNull(),
  sourceGenerationId: text("source_generation_id").notNull(),
  sourceOverrideVersion: integer("source_override_version").notNull(),
  proposalId: text("proposal_id").notNull().references(() => questionChangeProposals.id, { onDelete: "cascade" }),
  claimedAt: integer("claimed_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  primaryKey({
    name: "question_change_proposal_sources_pk",
    columns: [table.ownerUserId, table.qid, table.sourceGenerationId, table.sourceOverrideVersion],
  }),
  uniqueIndex("question_change_proposal_sources_proposal_unique").on(table.proposalId),
]);

export const siteRoleGrants = sqliteTable("site_role_grants", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  role: text("role").$type<SiteRole>().notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  revokedBy: text("revoked_by"),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
}, (table) => [
  index("site_role_grants_user_role_created_idx").on(table.userId, table.role, table.createdAt),
  uniqueIndex("site_role_grants_user_role_active_unique")
    .on(table.userId, table.role)
    .where(sql`${table.revokedAt} is null`),
  check("site_role_grants_role_check", sql`${table.role} in ('reviewer', 'operator')`),
  check("site_role_grants_revocation_check", sql`(${table.revokedAt} is null and ${table.revokedBy} is null) or (${table.revokedAt} is not null and ${table.revokedBy} is not null)`),
]);

export const questionProposalReviews = sqliteTable("question_proposal_reviews", {
  proposalId: text("proposal_id").primaryKey().references(() => questionChangeProposals.id),
  reviewerUserId: text("reviewer_user_id").notNull().references(() => user.id),
  sourceGenerationId: text("source_generation_id").notNull(),
  sourceOverrideVersion: integer("source_override_version").notNull(),
  baseContentVersion: text("base_content_version").notNull(),
  baseContentSha256: text("base_content_sha256").notNull(),
  decision: text("decision").$type<QuestionReviewDecision>().notNull(),
  comment: text("comment").notNull(),
  decidedAt: integer("decided_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  index("question_proposal_reviews_reviewer_decided_idx").on(table.reviewerUserId, table.decidedAt),
  check("question_proposal_reviews_decision_check", sql`${table.decision} in ('approved', 'rejected')`),
]);

export const questionPublications = sqliteTable("question_publications", {
  id: text("id").primaryKey(),
  proposalId: text("proposal_id").notNull().unique().references(() => questionChangeProposals.id),
  operatorUserId: text("operator_user_id").notNull().references(() => user.id),
  sourceContentVersion: text("source_content_version").notNull(),
  targetContentVersion: text("target_content_version").notNull(),
  branchName: text("branch_name").notNull(),
  commitSha: text("commit_sha").notNull().unique(),
  status: text("status").$type<QuestionPublicationStatus>().notNull().default("prepared"),
  preparedAt: integer("prepared_at", { mode: "timestamp_ms" }).notNull(),
  publishedAt: integer("published_at", { mode: "timestamp_ms" }),
  mergeCommitSha: text("merge_commit_sha"),
}, (table) => [
  index("question_publications_operator_prepared_idx").on(table.operatorUserId, table.preparedAt),
  check("question_publications_status_check", sql`${table.status} in ('prepared', 'published')`),
  check("question_publications_published_check", sql`(${table.status} = 'prepared' and ${table.publishedAt} is null and ${table.mergeCommitSha} is null) or (${table.status} = 'published' and ${table.publishedAt} is not null and ${table.mergeCommitSha} is not null)`),
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
