export type SelfRating = "not_yet" | "incomplete" | "clear";
export type Revision = { revisionId: string; text: string; savedAt: string };
export type Assessment = {
  assessmentId: string;
  savedAt: string;
  scores: Record<string, SelfRating>;
  missingNote: string;
  nextReviewOn: string | null;
  timeZone: string;
  revokedAt?: string | null;
  queueDismissedAt?: string | null;
};
export type Attempt = {
  attemptId: string;
  qid: string;
  contentVersion: string;
  startedAt: string;
  originalAnswer: string;
  revisions: Revision[];
  revealedAt: string | null;
  skipped: boolean;
  assessments: Assessment[];
  updatedAt: string;
};
export type Draft = {
  qid: string;
  attemptId: string;
  contentVersion: string;
  kind: "answer" | "revision";
  text: string;
  savedAt: string;
};
export type Preferences = { key: string; value: unknown; updatedAt: string };
export type CoachMode = "hint" | "explain" | "critique";
export type CoachConversationStatus = "pending" | "streaming" | "complete" | "interrupted" | "failed" | "cancelled";
export type CoachConversation = {
  conversationId: string;
  qid: string;
  attemptId: string | null;
  contentVersion: string;
  mode: CoachMode;
  model: string;
  userInput: string;
  assistantOutput: string;
  status: CoachConversationStatus;
  startedAt: string;
  updatedAt: string;
};
export type StudySnapshot = { attempts: Attempt[]; drafts: Draft[]; preferences: Preferences[]; coachConversations: CoachConversation[] };
export type BackupFile = {
  schemaVersion: 2;
  exportedAt: string;
  contentSetVersion: string;
  attempts: Attempt[];
  drafts: Draft[];
  preferences: Preferences[];
  coachConversations: CoachConversation[];
};

const DATABASE_NAME = "zhixu-study";
const DATABASE_VERSION = 2;
const ATTEMPTS = "attempts";
const DRAFTS = "drafts";
const PREFERENCES = "preferences";
const COACH_CONVERSATIONS = "coachConversations";
let databasePromise: Promise<IDBDatabase> | null = null;
const conversationWrites = new Map<string, Promise<void>>();

function openDatabase(): Promise<IDBDatabase> {
  if (typeof window === "undefined" || !window.indexedDB) {
    return Promise.reject(new Error("此浏览器无法使用本设备数据库。"));
  }
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ATTEMPTS)) db.createObjectStore(ATTEMPTS, { keyPath: "attemptId" });
      if (!db.objectStoreNames.contains(DRAFTS)) db.createObjectStore(DRAFTS, { keyPath: "qid" });
      if (!db.objectStoreNames.contains(PREFERENCES)) db.createObjectStore(PREFERENCES, { keyPath: "key" });
      if (!db.objectStoreNames.contains(COACH_CONVERSATIONS)) db.createObjectStore(COACH_CONVERSATIONS, { keyPath: "conversationId" });
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error("无法打开本设备数据库。"));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new Error("数据库正在被另一个标签页占用。关闭旧标签页后再试。"));
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
  return databasePromise;
}

function transact<T>(
  storeNames: string[],
  mode: IDBTransactionMode,
  operation: (transaction: IDBTransaction, setResult: (value: T) => void, fail: (error: Error) => void) => void,
): Promise<T> {
  return openDatabase().then((db) => new Promise<T>((resolve, reject) => {
    let result: T;
    let hasResult = false;
    let rejected = false;
    const tx = db.transaction(storeNames, mode);
    const setResult = (value: T) => { result = value; hasResult = true; };
    const fail = (error: Error) => {
      if (rejected) return;
      rejected = true;
      try { tx.abort(); } catch {}
      reject(error);
    };
    tx.oncomplete = () => {
      if (rejected) return;
      if (hasResult) resolve(result);
      else resolve(undefined as T);
    };
    tx.onerror = () => fail(tx.error instanceof Error ? tx.error : new Error("本设备保存失败。"));
    tx.onabort = () => fail(tx.error instanceof Error ? tx.error : new Error("本设备保存已中断。"));
    try {
      operation(tx, setResult, fail);
    } catch (error) {
      fail(error instanceof Error ? error : new Error("本设备操作失败。"));
    }
  }));
}

export function getStudySnapshot(): Promise<StudySnapshot> {
  return transact([ATTEMPTS, DRAFTS, PREFERENCES, COACH_CONVERSATIONS], "readonly", (tx, setResult, fail) => {
    const attemptsRequest = tx.objectStore(ATTEMPTS).getAll();
    const draftsRequest = tx.objectStore(DRAFTS).getAll();
    const preferencesRequest = tx.objectStore(PREFERENCES).getAll();
    const coachConversationsRequest = tx.objectStore(COACH_CONVERSATIONS).getAll();
    let attempts: Attempt[] | undefined;
    let drafts: Draft[] | undefined;
    let preferences: Preferences[] | undefined;
    let coachConversations: CoachConversation[] | undefined;
    const finish = () => {
      if (attempts && drafts && preferences && coachConversations) setResult({ attempts, drafts, preferences, coachConversations });
    };
    attemptsRequest.onsuccess = () => { attempts = attemptsRequest.result as Attempt[]; finish(); };
    draftsRequest.onsuccess = () => { drafts = draftsRequest.result as Draft[]; finish(); };
    preferencesRequest.onsuccess = () => { preferences = preferencesRequest.result as Preferences[]; finish(); };
    coachConversationsRequest.onsuccess = () => { coachConversations = coachConversationsRequest.result as CoachConversation[]; finish(); };
    for (const request of [attemptsRequest, draftsRequest, preferencesRequest, coachConversationsRequest]) {
      request.onerror = () => fail(request.error instanceof Error ? request.error : new Error("无法读取本设备学习记录。"));
    }
  });
}

/** Read only the legacy conversation store without upgrading or writing to the old database. */
export function getLegacyCoachConversationsSnapshot(): Promise<CoachConversation[]> {
  if (typeof window === "undefined" || !window.indexedDB) {
    return Promise.reject(new Error("此浏览器无法读取本设备数据库。"));
  }

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME);
    let abortedEmptyDatabaseUpgrade = false;
    request.onupgradeneeded = () => {
      abortedEmptyDatabaseUpgrade = true;
      try { request.transaction?.abort(); } catch {}
    };
    request.onerror = () => {
      if (abortedEmptyDatabaseUpgrade && request.error?.name === "AbortError") {
        resolve([]);
        return;
      }
      reject(request.error instanceof Error ? request.error : new Error("无法读取本设备 AI 对话。"));
    };
    request.onblocked = () => reject(new Error("本设备数据库正在被另一个标签页占用。关闭旧标签页后再试。"));
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      if (!database.objectStoreNames.contains(COACH_CONVERSATIONS)) {
        database.close();
        resolve([]);
        return;
      }

      let transaction: IDBTransaction;
      try {
        transaction = database.transaction([COACH_CONVERSATIONS], "readonly");
      } catch (cause) {
        database.close();
        reject(cause instanceof Error ? cause : new Error("无法读取本设备 AI 对话。"));
        return;
      }
      const read = transaction.objectStore(COACH_CONVERSATIONS).getAll();
      let records: CoachConversation[] = [];
      let hasResult = false;
      read.onsuccess = () => {
        records = read.result as CoachConversation[];
        hasResult = true;
      };
      read.onerror = () => {
        try { transaction.abort(); } catch {}
      };
      transaction.oncomplete = () => {
        database.close();
        if (hasResult) resolve(records);
        else reject(new Error("无法读取本设备 AI 对话。"));
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error instanceof Error ? transaction.error : new Error("无法读取本设备 AI 对话。"));
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error instanceof Error ? transaction.error : new Error("无法读取本设备 AI 对话。"));
      };
    };
  });
}

export function saveCoachConversation(conversation: CoachConversation): Promise<void> {
  const previous = conversationWrites.get(conversation.conversationId) ?? Promise.resolve();
  const write: Promise<void> = previous.catch(() => {}).then(() => transact<void>([COACH_CONVERSATIONS], "readwrite", (tx, setResult, fail) => {
    const request = tx.objectStore(COACH_CONVERSATIONS).put(conversation);
    request.onsuccess = () => setResult(undefined);
    request.onerror = () => fail(request.error instanceof Error ? request.error : new Error("AI 对话未能保存到本设备。"));
  }));
  const tracked = write.finally(() => {
    if (conversationWrites.get(conversation.conversationId) === tracked) conversationWrites.delete(conversation.conversationId);
  });
  conversationWrites.set(conversation.conversationId, tracked);
  return tracked;
}

export function saveAttempt(attempt: Attempt): Promise<void> {
  return transact([ATTEMPTS], "readwrite", (tx, setResult, fail) => {
    const request = tx.objectStore(ATTEMPTS).put(attempt);
    request.onsuccess = () => setResult(undefined);
    request.onerror = () => fail(request.error instanceof Error ? request.error : new Error("本题记录未能保存。"));
  });
}

export function saveDraft(draft: Draft): Promise<void> {
  return transact([DRAFTS], "readwrite", (tx, setResult, fail) => {
    const request = tx.objectStore(DRAFTS).put(draft);
    request.onsuccess = () => setResult(undefined);
    request.onerror = () => fail(request.error instanceof Error ? request.error : new Error("草稿未能保存。"));
  });
}

export function deleteDraft(qid: string): Promise<void> {
  return transact([DRAFTS], "readwrite", (tx, setResult, fail) => {
    const request = tx.objectStore(DRAFTS).delete(qid);
    request.onsuccess = () => setResult(undefined);
    request.onerror = () => fail(request.error instanceof Error ? request.error : new Error("草稿清理失败。"));
  });
}

export function savePreference(preference: Preferences): Promise<void> {
  return transact([PREFERENCES], "readwrite", (tx, setResult, fail) => {
    const request = tx.objectStore(PREFERENCES).put(preference);
    request.onsuccess = () => setResult(undefined);
    request.onerror = () => fail(request.error instanceof Error ? request.error : new Error("偏好设置未能保存。"));
  });
}

export function backupFromSnapshot(snapshot: StudySnapshot, contentSetVersion: string): BackupFile {
  return {
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    contentSetVersion,
    attempts: snapshot.attempts,
    drafts: snapshot.drafts,
    preferences: snapshot.preferences,
    coachConversations: snapshot.coachConversations,
  };
}

export function replaceAllStudyData(backup: BackupFile): Promise<void> {
  return transact([ATTEMPTS, DRAFTS, PREFERENCES, COACH_CONVERSATIONS], "readwrite", (tx, setResult, fail) => {
    const attemptsStore = tx.objectStore(ATTEMPTS);
    const draftsStore = tx.objectStore(DRAFTS);
    const preferencesStore = tx.objectStore(PREFERENCES);
    const conversationsStore = tx.objectStore(COACH_CONVERSATIONS);
    for (const request of [attemptsStore.clear(), draftsStore.clear(), preferencesStore.clear(), conversationsStore.clear()]) {
      request.onerror = () => fail(request.error instanceof Error ? request.error : new Error("清理现有数据失败。"));
    }
    for (const record of backup.attempts) attemptsStore.put(record);
    for (const record of backup.drafts) draftsStore.put(record);
    for (const record of backup.preferences) preferencesStore.put(record);
    for (const record of backup.coachConversations) conversationsStore.put(record);
    setResult(undefined);
  });
}

export function mergeStudyData(
  backup: BackupFile,
  replaceConflictingAttemptIds: Set<string>,
  replaceConflictingDraftQids: Set<string>,
  replaceConflictingPreferenceKeys: Set<string>,
  replaceConflictingConversationIds: Set<string>,
): Promise<void> {
  return transact([ATTEMPTS, DRAFTS, PREFERENCES, COACH_CONVERSATIONS], "readwrite", (tx, setResult, fail) => {
    const attemptsStore = tx.objectStore(ATTEMPTS);
    const draftsStore = tx.objectStore(DRAFTS);
    const preferencesStore = tx.objectStore(PREFERENCES);
    const conversationsStore = tx.objectStore(COACH_CONVERSATIONS);
    const existingAttemptsRequest = attemptsStore.getAll();
    const existingDraftsRequest = draftsStore.getAll();
    const existingPreferencesRequest = preferencesStore.getAll();
    const existingConversationsRequest = conversationsStore.getAll();
    let completed = 0;
    let existingAttempts: Attempt[] = [];
    let existingDrafts: Draft[] = [];
    let existingPreferences: Preferences[] = [];
    let existingConversations: CoachConversation[] = [];
    const apply = () => {
      if (++completed !== 4) return;
      const existingAttemptIds = new Set(existingAttempts.map((item) => item.attemptId));
      for (const attempt of backup.attempts) {
        if (!existingAttemptIds.has(attempt.attemptId) || replaceConflictingAttemptIds.has(attempt.attemptId)) attemptsStore.put(attempt);
      }
      const existingDraftIds = new Set(existingDrafts.map((item) => item.qid));
      for (const draft of backup.drafts) if (!existingDraftIds.has(draft.qid) || replaceConflictingDraftQids.has(draft.qid)) draftsStore.put(draft);
      const existingPreferenceIds = new Set(existingPreferences.map((item) => item.key));
      for (const preference of backup.preferences) if (!existingPreferenceIds.has(preference.key) || replaceConflictingPreferenceKeys.has(preference.key)) preferencesStore.put(preference);
      const existingConversationIds = new Set(existingConversations.map((item) => item.conversationId));
      for (const conversation of backup.coachConversations) {
        if (!existingConversationIds.has(conversation.conversationId) || replaceConflictingConversationIds.has(conversation.conversationId)) conversationsStore.put(conversation);
      }
      setResult(undefined);
    };
    existingAttemptsRequest.onsuccess = () => { existingAttempts = existingAttemptsRequest.result as Attempt[]; apply(); };
    existingDraftsRequest.onsuccess = () => { existingDrafts = existingDraftsRequest.result as Draft[]; apply(); };
    existingPreferencesRequest.onsuccess = () => { existingPreferences = existingPreferencesRequest.result as Preferences[]; apply(); };
    existingConversationsRequest.onsuccess = () => { existingConversations = existingConversationsRequest.result as CoachConversation[]; apply(); };
    for (const request of [existingAttemptsRequest, existingDraftsRequest, existingPreferencesRequest, existingConversationsRequest]) {
      request.onerror = () => fail(request.error instanceof Error ? request.error : new Error("无法校验本设备已有数据。"));
    }
  });
}

export function clearAllStudyData(): Promise<void> {
  return transact([ATTEMPTS, DRAFTS, PREFERENCES, COACH_CONVERSATIONS], "readwrite", (tx, setResult, fail) => {
    const requests = [tx.objectStore(ATTEMPTS).clear(), tx.objectStore(DRAFTS).clear(), tx.objectStore(PREFERENCES).clear(), tx.objectStore(COACH_CONVERSATIONS).clear()];
    for (const request of requests) request.onerror = () => fail(request.error instanceof Error ? request.error : new Error("清除本设备数据失败。"));
    setResult(undefined);
  });
}
