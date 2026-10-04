import type { Assessment, Attempt, BackupFile, Draft, Preferences, SelfRating } from "@/lib/study-store";

export const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
const ratings = new Set<SelfRating>(["not_yet", "incomplete", "clear"]);
const validId = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const validDate = (value: unknown) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00.000Z");
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
};
const validTimestamp = (value: unknown) => {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
};
const invalid = (message: string): never => { throw new Error(message); };

function parseAssessment(value: unknown): Assessment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("自评记录的格式无效。");
  const item = value as Record<string, unknown>;
  if (!validId(item.assessmentId) || !validTimestamp(item.savedAt)) return invalid("自评记录缺少有效编号或时间。");
  if (!item.scores || typeof item.scores !== "object" || Array.isArray(item.scores)) return invalid("自评选项的格式无效。");
  const scores: Record<string, SelfRating> = {};
  for (const [key, rating] of Object.entries(item.scores as Record<string, unknown>)) {
    if (!validId(key) || !ratings.has(rating as SelfRating)) return invalid("自评选项包含无法识别的值。");
    scores[key] = rating as SelfRating;
  }
  if (typeof item.missingNote !== "string" || item.missingNote.length > 20000) return invalid("遗漏说明的格式无效。");
  if (item.nextReviewOn !== null && item.nextReviewOn !== undefined && !validDate(item.nextReviewOn)) return invalid("复习日期无效。");
  if (typeof item.timeZone !== "string" || item.timeZone.length > 80) return invalid("日期时区信息无效。");
  if (item.revokedAt !== undefined && item.revokedAt !== null && !validTimestamp(item.revokedAt)) return invalid("撤销时间无效。");
  if (item.queueDismissedAt !== undefined && item.queueDismissedAt !== null && !validTimestamp(item.queueDismissedAt)) return invalid("复习队列时间无效。");
  return {
    assessmentId: item.assessmentId as string,
    savedAt: item.savedAt as string,
    scores,
    missingNote: item.missingNote,
    nextReviewOn: (item.nextReviewOn as string | null | undefined) ?? null,
    timeZone: item.timeZone,
    revokedAt: (item.revokedAt as string | null | undefined) ?? null,
    queueDismissedAt: (item.queueDismissedAt as string | null | undefined) ?? null,
  };
}

function parseAttempt(value: unknown, knownQids: Set<string>): { record: Attempt | null; unknownQid: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("练习记录的格式无效。");
  const item = value as Record<string, unknown>;
  if (!validId(item.attemptId) || typeof item.qid !== "string" || !item.qid.trim()) return invalid("练习记录缺少有效编号。");
  if (!knownQids.has(item.qid)) return { record: null, unknownQid: item.qid };
  const qid = item.qid;
  if (typeof item.contentVersion !== "string" || item.contentVersion.length > 100 || !validTimestamp(item.startedAt) || !validTimestamp(item.updatedAt)) return invalid("练习记录的版本或时间信息无效。");
  if (typeof item.originalAnswer !== "string" || item.originalAnswer.length > 100000) return invalid("练习回答内容超出允许范围。");
  if (!Array.isArray(item.revisions) || item.revisions.length > 1000) return invalid("修订记录格式无效。");
  const revisions = item.revisions.map((revision) => {
    if (!revision || typeof revision !== "object" || Array.isArray(revision)) return invalid("修订记录格式无效。");
    const row = revision as Record<string, unknown>;
    if (!validId(row.revisionId) || typeof row.text !== "string" || row.text.length > 100000 || !validTimestamp(row.savedAt)) return invalid("修订记录包含无效字段。");
    return { revisionId: row.revisionId as string, text: row.text, savedAt: row.savedAt as string };
  });
  if (item.revealedAt !== null && item.revealedAt !== undefined && !validTimestamp(item.revealedAt)) return invalid("答案揭晓时间无效。");
  if (typeof item.skipped !== "boolean") return invalid("跳过状态无效。");
  if (!Array.isArray(item.assessments) || item.assessments.length > 1000) return invalid("自评记录格式无效。");
  return {
    record: {
      attemptId: item.attemptId as string,
      qid,
      contentVersion: item.contentVersion as string,
      startedAt: item.startedAt as string,
      originalAnswer: item.originalAnswer as string,
      revisions,
      revealedAt: (item.revealedAt as string | null | undefined) ?? null,
      skipped: item.skipped,
      assessments: item.assessments.map(parseAssessment),
      updatedAt: item.updatedAt as string,
    },
    unknownQid: null,
  };
}

function parseDraft(value: unknown, knownQids: Set<string>): { record: Draft | null; unknownQid: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("草稿记录的格式无效。");
  const item = value as Record<string, unknown>;
  if (typeof item.qid !== "string" || !item.qid.trim() || !validId(item.attemptId)) return invalid("草稿记录缺少有效编号。");
  if (!knownQids.has(item.qid)) return { record: null, unknownQid: item.qid };
  if (typeof item.contentVersion !== "string" || item.contentVersion.length > 100 || !validTimestamp(item.savedAt)) return invalid("草稿版本或保存时间无效。");
  if (item.kind !== "answer" && item.kind !== "revision") return invalid("草稿类型无效。");
  if (typeof item.text !== "string" || item.text.length > 100000) return invalid("草稿内容超出允许范围。");
  return { record: { qid: item.qid, attemptId: item.attemptId as string, contentVersion: item.contentVersion as string, kind: item.kind, text: item.text, savedAt: item.savedAt as string }, unknownQid: null };
}

function parsePreference(value: unknown): Preferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("偏好设置的格式无效。");
  const item = value as Record<string, unknown>;
  if (!validId(item.key) || !validTimestamp(item.updatedAt)) return invalid("偏好设置编号或时间无效。");
  return { key: item.key as string, value: item.value, updatedAt: item.updatedAt as string };
}

export function parseBackupText(text: string, knownQids: Set<string>): { backup: BackupFile; unknownQids: string[] } {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return invalid("这不是可识别的 JSON 备份文件。"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return invalid("备份文件的顶层结构无效。");
  const value = parsed as Record<string, unknown>;
  if (value.schemaVersion !== 1) return invalid("这个备份版本暂不兼容。");
  if (!validTimestamp(value.exportedAt) || typeof value.contentSetVersion !== "string" || value.contentSetVersion.length > 100) return invalid("备份版本或导出时间无效。");
  if (!Array.isArray(value.attempts) || !Array.isArray(value.drafts) || !Array.isArray(value.preferences)) return invalid("备份文件缺少练习、草稿或偏好数据。");

  const unknownQids = new Set<string>();
  const attempts = value.attempts.map((raw) => {
    const result = parseAttempt(raw, knownQids);
    if (result.unknownQid) unknownQids.add(result.unknownQid);
    return result.record;
  }).filter((item): item is Attempt => item !== null);
  const drafts = value.drafts.map((raw) => {
    const result = parseDraft(raw, knownQids);
    if (result.unknownQid) unknownQids.add(result.unknownQid);
    return result.record;
  }).filter((item): item is Draft => item !== null);
  const preferences = value.preferences.map(parsePreference);

  const attemptIds = attempts.map((attempt) => attempt.attemptId);
  const draftIds = drafts.map((draft) => draft.qid);
  const preferenceIds = preferences.map((preference) => preference.key);
  if (new Set(attemptIds).size !== attemptIds.length || new Set(draftIds).size !== draftIds.length || new Set(preferenceIds).size !== preferenceIds.length) return invalid("备份文件中包含重复记录编号。");

  return {
    backup: {
      schemaVersion: 1,
      exportedAt: value.exportedAt as string,
      contentSetVersion: value.contentSetVersion,
      attempts,
      drafts,
      preferences,
    },
    unknownQids: [...unknownQids].sort(),
  };
}

function stableJson(value: unknown): string | undefined {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => item === undefined ? null : JSON.parse(stableJson(item) ?? "null")));
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey, "en"));
    return "{" + entries.map(([key, item]) => JSON.stringify(key) + ":" + (stableJson(item) ?? "null")).join(",") + "}";
  }
  return JSON.stringify(value);
}

export function hasMeaningfulDifference(left: unknown, right: unknown) {
  return stableJson(left) !== stableJson(right);
}
