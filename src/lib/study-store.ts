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
export type StudySnapshot = { attempts: Attempt[]; drafts: Draft[]; preferences: Preferences[] };
export type BackupFile = {
  schemaVersion: 1;
  exportedAt: string;
  contentSetVersion: string;
  attempts: Attempt[];
  drafts: Draft[];
  preferences: Preferences[];
};

const DATABASE_NAME = "zhixu-study";
const DATABASE_VERSION = 1;
const ATTEMPTS = "attempts";
const DRAFTS = "drafts";
const PREFERENCES = "preferences";
let databasePromise: Promise<IDBDatabase> | null = null;

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
  return transact([ATTEMPTS, DRAFTS, PREFERENCES], "readonly", (tx, setResult, fail) => {
    const attemptsRequest = tx.objectStore(ATTEMPTS).getAll();
    const draftsRequest = tx.objectStore(DRAFTS).getAll();
    const preferencesRequest = tx.objectStore(PREFERENCES).getAll();
    let attempts: Attempt[] | undefined;
    let drafts: Draft[] | undefined;
    let preferences: Preferences[] | undefined;
    const finish = () => {
      if (attempts && drafts && preferences) setResult({ attempts, drafts, preferences });
    };
    attemptsRequest.onsuccess = () => { attempts = attemptsRequest.result as Attempt[]; finish(); };
    draftsRequest.onsuccess = () => { drafts = draftsRequest.result as Draft[]; finish(); };
    preferencesRequest.onsuccess = () => { preferences = preferencesRequest.result as Preferences[]; finish(); };
    for (const request of [attemptsRequest, draftsRequest, preferencesRequest]) {
      request.onerror = () => fail(request.error instanceof Error ? request.error : new Error("无法读取本设备学习记录。"));
    }
  });
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
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    contentSetVersion,
    attempts: snapshot.attempts,
    drafts: snapshot.drafts,
    preferences: snapshot.preferences,
  };
}

export function replaceAllStudyData(backup: BackupFile): Promise<void> {
  return transact([ATTEMPTS, DRAFTS, PREFERENCES], "readwrite", (tx, setResult, fail) => {
    const attemptsStore = tx.objectStore(ATTEMPTS);
    const draftsStore = tx.objectStore(DRAFTS);
    const preferencesStore = tx.objectStore(PREFERENCES);
    for (const request of [attemptsStore.clear(), draftsStore.clear(), preferencesStore.clear()]) {
      request.onerror = () => fail(request.error instanceof Error ? request.error : new Error("清理现有数据失败。"));
    }
    for (const record of backup.attempts) attemptsStore.put(record);
    for (const record of backup.drafts) draftsStore.put(record);
    for (const record of backup.preferences) preferencesStore.put(record);
    setResult(undefined);
  });
}

export function mergeStudyData(
  backup: BackupFile,
  replaceConflictingAttemptIds: Set<string>,
  replaceConflictingDraftQids: Set<string>,
  replaceConflictingPreferenceKeys: Set<string>,
): Promise<void> {
  return transact([ATTEMPTS, DRAFTS, PREFERENCES], "readwrite", (tx, setResult, fail) => {
    const attemptsStore = tx.objectStore(ATTEMPTS);
    const draftsStore = tx.objectStore(DRAFTS);
    const preferencesStore = tx.objectStore(PREFERENCES);
    const existingAttemptsRequest = attemptsStore.getAll();
    const existingDraftsRequest = draftsStore.getAll();
    const existingPreferencesRequest = preferencesStore.getAll();
    let completed = 0;
    let existingAttempts: Attempt[] = [];
    let existingDrafts: Draft[] = [];
    let existingPreferences: Preferences[] = [];
    const apply = () => {
      if (++completed !== 3) return;
      const existingAttemptIds = new Set(existingAttempts.map((item) => item.attemptId));
      for (const attempt of backup.attempts) {
        if (!existingAttemptIds.has(attempt.attemptId) || replaceConflictingAttemptIds.has(attempt.attemptId)) attemptsStore.put(attempt);
      }
      const existingDraftIds = new Set(existingDrafts.map((item) => item.qid));
      for (const draft of backup.drafts) if (!existingDraftIds.has(draft.qid) || replaceConflictingDraftQids.has(draft.qid)) draftsStore.put(draft);
      const existingPreferenceIds = new Set(existingPreferences.map((item) => item.key));
      for (const preference of backup.preferences) if (!existingPreferenceIds.has(preference.key) || replaceConflictingPreferenceKeys.has(preference.key)) preferencesStore.put(preference);
      setResult(undefined);
    };
    existingAttemptsRequest.onsuccess = () => { existingAttempts = existingAttemptsRequest.result as Attempt[]; apply(); };
    existingDraftsRequest.onsuccess = () => { existingDrafts = existingDraftsRequest.result as Draft[]; apply(); };
    existingPreferencesRequest.onsuccess = () => { existingPreferences = existingPreferencesRequest.result as Preferences[]; apply(); };
    for (const request of [existingAttemptsRequest, existingDraftsRequest, existingPreferencesRequest]) {
      request.onerror = () => fail(request.error instanceof Error ? request.error : new Error("无法校验本设备已有数据。"));
    }
  });
}

export function clearAllStudyData(): Promise<void> {
  return transact([ATTEMPTS, DRAFTS, PREFERENCES], "readwrite", (tx, setResult, fail) => {
    const requests = [tx.objectStore(ATTEMPTS).clear(), tx.objectStore(DRAFTS).clear(), tx.objectStore(PREFERENCES).clear()];
    for (const request of requests) request.onerror = () => fail(request.error instanceof Error ? request.error : new Error("清除本设备数据失败。"));
    setResult(undefined);
  });
}
