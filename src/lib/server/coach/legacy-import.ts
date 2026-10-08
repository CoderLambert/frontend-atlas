import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { coachConversations, coachMessages } from "../../db/schema.ts";
import type * as schema from "../../db/schema.ts";
import type { CoachMessageStatus } from "../../db/schema.ts";

export const LEGACY_IMPORT_BATCH_SIZE = 20;
export const LEGACY_IMPORT_BODY_LIMIT_BYTES = 16 * 1024 * 1024;
export const LEGACY_IMPORT_USER_TEXT_LIMIT = 12_000;
export const LEGACY_IMPORT_ASSISTANT_TEXT_LIMIT = 100_000;
export const LEGACY_IMPORT_METADATA_LIMIT_BYTES = 1_024;

const legacyModes = new Set(["hint", "explain", "critique"]);
const legacyStatuses = new Set(["pending", "streaming", "complete", "interrupted", "failed", "cancelled"]);
const legacyRecordKeys = new Set([
  "sourceId", "qid", "attemptId", "contentVersion", "mode", "model",
  "userInput", "assistantOutput", "status", "startedAt", "updatedAt",
]);

type LegacyRecord = {
  sourceId: string;
  qid: string;
  attemptId: string | null;
  contentVersion: string;
  mode: "hint" | "explain" | "critique";
  model: string;
  userInput: string;
  assistantOutput: string;
  status: "pending" | "streaming" | "complete" | "interrupted" | "failed" | "cancelled";
  startedAt: Date;
  updatedAt: Date;
};

type ImportItemResult = {
  index: number;
  status: "imported" | "already_imported" | "conflict" | "invalid" | "failed";
};

type CoachDatabase = BetterSQLite3Database<typeof schema>;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength: number, allowEmpty = true): value is string {
  return typeof value === "string" && value.length <= maxLength && (allowEmpty || value.length > 0);
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length > 32) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  return date.toISOString() === value ? date : null;
}

function validateLegacyRecord(value: unknown): LegacyRecord | null {
  if (!isObject(value) || Object.keys(value).some((key) => !legacyRecordKeys.has(key))) return null;
  if (!boundedText(value.sourceId, 160, false)
    || !boundedText(value.qid, 200)
    || !(value.attemptId === null || boundedText(value.attemptId, 160))
    || !boundedText(value.contentVersion, 200)
    || typeof value.mode !== "string"
    || !legacyModes.has(value.mode)
    || !boundedText(value.model, 200)
    || !boundedText(value.userInput, LEGACY_IMPORT_USER_TEXT_LIMIT)
    || !boundedText(value.assistantOutput, LEGACY_IMPORT_ASSISTANT_TEXT_LIMIT)
    || typeof value.status !== "string"
    || !legacyStatuses.has(value.status)) return null;

  const startedAt = parseDate(value.startedAt);
  const updatedAt = parseDate(value.updatedAt);
  if (!startedAt || !updatedAt) return null;

  return {
    sourceId: value.sourceId,
    qid: value.qid,
    attemptId: value.attemptId,
    contentVersion: value.contentVersion,
    mode: value.mode as LegacyRecord["mode"],
    model: value.model,
    userInput: value.userInput,
    assistantOutput: value.assistantOutput,
    status: value.status as LegacyRecord["status"],
    startedAt,
    updatedAt,
  };
}

function targetConversationId(ownerUserId: string, sourceId: string) {
  const digest = createHash("sha256").update(ownerUserId).update("\0").update(sourceId).digest("hex");
  return `legacy_${digest}`;
}

function metadataFor(record: LegacyRecord) {
  return JSON.stringify({
    version: 1,
    source: "zhixu-study",
    sourceId: record.sourceId,
    attemptId: record.attemptId,
    mode: record.mode,
    model: record.model,
    originalStatus: record.status,
  });
}

function isSameImport(
  existingConversation: typeof coachConversations.$inferSelect,
  existingMessages: (typeof coachMessages.$inferSelect)[],
  expected: {
    id: string;
    ownerUserId: string;
    title: string;
    qid: string;
    contentVersion: string;
    metadata: string;
    messages: { id: string; clientMessageId: string; role: "user" | "assistant"; content: string; status: string; createdAt: Date }[];
    startedAt: Date;
    updatedAt: Date;
  },
) {
  if (existingConversation.ownerUserId !== expected.ownerUserId
    || existingConversation.id !== expected.id
    || existingConversation.title !== expected.title
    || existingConversation.qid !== expected.qid
    || existingConversation.contentVersion !== expected.contentVersion
    || existingConversation.legacyMetadataJson !== expected.metadata
    || existingConversation.createdAt.getTime() !== expected.startedAt.getTime()
    || existingConversation.updatedAt.getTime() !== expected.updatedAt.getTime()
    || existingMessages.length !== expected.messages.length) return false;

  const byId = new Map(existingMessages.map((message) => [message.id, message]));
  return expected.messages.every((message) => {
    const actual = byId.get(message.id);
    return actual?.ownerUserId === expected.ownerUserId
      && actual.conversationId === expected.id
      && actual.clientMessageId === message.clientMessageId
      && actual.role === message.role
      && actual.content === message.content
      && actual.status === message.status
      && actual.createdAt.getTime() === message.createdAt.getTime();
  });
}

export class LegacyConversationImportService {
  private readonly database: CoachDatabase;

  constructor(database: CoachDatabase) {
    this.database = database;
  }

  importBatch(ownerUserId: string, values: unknown[]): ImportItemResult[] {
    return values.map((value, index) => {
      const record = validateLegacyRecord(value);
      if (!record) return { index, status: "invalid" };

      try {
        return { index, status: this.importOne(ownerUserId, record) };
      } catch {
        // Per-record failures are intentionally generic and do not return stored data.
        return { index, status: "failed" };
      }
    });
  }

  private importOne(ownerUserId: string, record: LegacyRecord): ImportItemResult["status"] {
    const id = targetConversationId(ownerUserId, record.sourceId);
    const title = record.qid ? `旧版助手对话 · ${record.qid}` : "旧版助手对话";
    const metadata = metadataFor(record);
    if (Buffer.byteLength(metadata, "utf8") > LEGACY_IMPORT_METADATA_LIMIT_BYTES) return "invalid";

    const assistantStatus: CoachMessageStatus = record.status === "pending" || record.status === "streaming"
      ? "interrupted"
      : record.status;
    const expectedMessages: {
      id: string;
      clientMessageId: string;
      role: "user" | "assistant";
      content: string;
      status: CoachMessageStatus;
      createdAt: Date;
    }[] = [
      {
        id: `${id}:user`,
        clientMessageId: `${id}:user`,
        role: "user" as const,
        content: record.userInput,
        status: "complete",
        createdAt: record.startedAt,
      },
      {
        id: `${id}:assistant`,
        clientMessageId: `${id}:assistant`,
        role: "assistant" as const,
        content: record.assistantOutput,
        status: assistantStatus,
        createdAt: record.updatedAt,
      },
    ];

    return this.database.transaction((transaction) => {
      const [existing] = transaction.select().from(coachConversations)
        .where(eq(coachConversations.id, id)).limit(1).all();
      if (existing) {
        if (existing.ownerUserId !== ownerUserId) return "conflict" as const;
        const existingMessages = transaction.select().from(coachMessages)
          .where(and(eq(coachMessages.ownerUserId, ownerUserId), eq(coachMessages.conversationId, id)))
          .orderBy(asc(coachMessages.createdAt), asc(coachMessages.id))
          .all();
        return isSameImport(existing, existingMessages, {
          id,
          ownerUserId,
          title,
          qid: record.qid,
          contentVersion: record.contentVersion,
          metadata,
          messages: expectedMessages,
          startedAt: record.startedAt,
          updatedAt: record.updatedAt,
        }) ? "already_imported" as const : "conflict" as const;
      }

      const [existingMessageKey] = transaction.select({ id: coachMessages.id })
        .from(coachMessages)
        .where(and(
          eq(coachMessages.ownerUserId, ownerUserId),
          inArray(coachMessages.clientMessageId, [`${id}:user`, `${id}:assistant`]),
        )).limit(1).all();
      if (existingMessageKey) return "conflict" as const;

      transaction.insert(coachConversations).values({
        id,
        ownerUserId,
        title,
        qid: record.qid,
        contentVersion: record.contentVersion,
        legacyMetadataJson: metadata,
        createdAt: record.startedAt,
        updatedAt: record.updatedAt,
      }).run();
      transaction.insert(coachMessages).values(expectedMessages.map((message) => ({
        ...message,
        conversationId: id,
        ownerUserId,
      }))).run();

      // No assistant-run row is created, so interrupted legacy history cannot recover or generate.
      return "imported" as const;
    });
  }
}

export function validateLegacyImportBatch(value: unknown): { records: unknown[] } | null {
  if (!isObject(value) || Object.keys(value).some((key) => key !== "records")) return null;
  if (!Array.isArray(value.records)
    || value.records.length === 0
    || value.records.length > LEGACY_IMPORT_BATCH_SIZE) return null;
  return { records: value.records };
}
