import assert from "node:assert/strict";

class FakeRequest {
  result = undefined;
  error = null;
  onsuccess = null;
  onerror = null;
}

class FakeStoreNames {
  constructor(database) { this.database = database; }
  contains(name) { return this.database.stores.has(name); }
}

class FakeObjectStore {
  constructor(transaction, name) {
    this.transaction = transaction;
    this.store = transaction.database.stores.get(name);
  }
  getAll() {
    return this.transaction.enqueue(() => [...this.store.records.values()].map((value) => structuredClone(value)));
  }
  put(value) {
    return this.transaction.enqueue(() => {
      if (this.transaction.mode === "readonly") throw new Error("readonly transaction");
      const key = value[this.store.keyPath];
      if (key === undefined) throw new Error("missing key");
      this.store.records.set(key, structuredClone(value));
      return key;
    });
  }
  clear() {
    return this.transaction.enqueue(() => {
      if (this.transaction.mode === "readonly") throw new Error("readonly transaction");
      this.store.records.clear();
      return undefined;
    });
  }
  delete(key) {
    return this.transaction.enqueue(() => {
      if (this.transaction.mode === "readonly") throw new Error("readonly transaction");
      this.store.records.delete(key);
      return undefined;
    });
  }
}

class FakeTransaction {
  pending = 0;
  aborted = false;
  completed = false;
  oncomplete = null;
  onerror = null;
  onabort = null;
  error = null;
  constructor(database, mode) {
    this.database = database;
    this.mode = mode;
  }
  objectStore(name) {
    if (!this.database.stores.has(name)) throw new Error(`missing object store: ${name}`);
    return new FakeObjectStore(this, name);
  }
  enqueue(operation) {
    const request = new FakeRequest();
    this.pending += 1;
    queueMicrotask(() => {
      if (this.aborted) return;
      try {
        request.result = operation();
        request.onsuccess?.({ target: request });
      } catch (error) {
        request.error = error;
        request.onerror?.({ target: request });
        this.error = error;
        this.onerror?.({ target: this });
      }
      this.pending -= 1;
      if (this.pending === 0) queueMicrotask(() => {
        if (this.pending !== 0 || this.aborted || this.completed) return;
        this.completed = true;
        this.oncomplete?.({ target: this });
      });
    });
    return request;
  }
  abort() {
    if (this.completed || this.aborted) return;
    this.aborted = true;
    queueMicrotask(() => this.onabort?.({ target: this }));
  }
}

class FakeDatabase {
  constructor(name, version) {
    this.name = name;
    this.version = version;
    this.stores = new Map();
    this.objectStoreNames = new FakeStoreNames(this);
    this.onversionchange = null;
  }
  createObjectStore(name, { keyPath }) {
    if (this.stores.has(name)) throw new Error(`store already exists: ${name}`);
    this.stores.set(name, { keyPath, records: new Map() });
    return new FakeObjectStore(new FakeTransaction(this, "readwrite"), name);
  }
  transaction(_names, mode) { return new FakeTransaction(this, mode); }
  close() {}
}

class FakeIndexedDB {
  databases = new Map();
  seed(database) { this.databases.set(database.name, database); }
  open(name, version) {
    const request = new FakeRequest();
    request.onupgradeneeded = null;
    request.onblocked = null;
    queueMicrotask(() => {
      let database = this.databases.get(name);
      const oldVersion = database?.version ?? 0;
      if (!database) {
        database = new FakeDatabase(name, 0);
        this.databases.set(name, database);
      }
      if (version > database.version) {
        database.version = version;
        request.result = database;
        request.onupgradeneeded?.({ oldVersion, newVersion: version, target: request });
      }
      request.result = database;
      queueMicrotask(() => request.onsuccess?.({ target: request }));
    });
    return request;
  }
}

const indexedDB = new FakeIndexedDB();
const prior = new FakeDatabase("zhixu-study", 1);
const attempt = { attemptId: "synthetic-attempt", qid: "D13", originalAnswer: "local answer" };
const draft = { qid: "D13", attemptId: "synthetic-attempt", text: "synthetic draft" };
const preference = { key: "synthetic-preference", value: true };
for (const [name, keyPath, record] of [
  ["attempts", "attemptId", attempt],
  ["drafts", "qid", draft],
  ["preferences", "key", preference],
]) {
  prior.stores.set(name, { keyPath, records: new Map([[record[keyPath], structuredClone(record)]]) });
}
indexedDB.seed(prior);
globalThis.window = { indexedDB };

const { backupFromSnapshot, clearAllStudyData, deleteDraft, filterStudySnapshotForAccount, getStudySnapshot, mergeStudyData, replaceAllStudyData, saveAttempt, saveCoachConversation, saveDraft } = await import("../src/lib/study-store.ts");
const migrated = await getStudySnapshot();
assert.equal(prior.version, 3, "the existing study database upgrades in place");
assert.deepEqual([...prior.stores.keys()], ["attempts", "drafts", "preferences", "accountDrafts", "coachConversations"], "upgrade adds account drafts without changing legacy store keys");
assert.deepEqual(migrated.attempts, [attempt], "existing attempts survive the upgrade");
assert.deepEqual(migrated.drafts, [draft], "existing drafts survive the upgrade");
assert.deepEqual(migrated.preferences, [preference], "existing preferences survive the upgrade");
assert.deepEqual(migrated.coachConversations, []);

const ownerA = { ...attempt, attemptId: "account-attempt-a", ownerUserId: "user-a", updatedAt: "2026-10-08T00:00:01.000Z" };
const ownerB = { ...attempt, attemptId: "account-attempt-b", ownerUserId: "user-b", originalAnswer: "B answer", updatedAt: "2026-10-08T00:00:02.000Z" };
await saveAttempt(ownerA);
await saveAttempt(ownerB);
await saveDraft({ ...draft, ownerUserId: "user-a", attemptId: ownerA.attemptId, text: "private draft A" });
await saveDraft({ ...draft, ownerUserId: "user-b", attemptId: ownerB.attemptId, text: "private draft B" });
let profiles = await getStudySnapshot();
assert.deepEqual(filterStudySnapshotForAccount(profiles, "user-a").attempts, [ownerA]);
assert.deepEqual(filterStudySnapshotForAccount(profiles, "user-b").attempts, [ownerB]);
assert.deepEqual(filterStudySnapshotForAccount(profiles, null).attempts, [attempt], "legacy records stay unclaimed");
assert.equal(filterStudySnapshotForAccount(profiles, "user-a").drafts[0].text, "private draft A");
assert.equal(filterStudySnapshotForAccount(profiles, "user-b").drafts[0].text, "private draft B");
assert.deepEqual(filterStudySnapshotForAccount(profiles, null).drafts, [draft], "legacy drafts remain");
await deleteDraft("D13", "user-a");
profiles = await getStudySnapshot();
assert.equal(filterStudySnapshotForAccount(profiles, "user-a").drafts.length, 0, "deleting A draft does not delete B");
assert.equal(filterStudySnapshotForAccount(profiles, "user-b").drafts[0].text, "private draft B");
assert.deepEqual(filterStudySnapshotForAccount(profiles, null).drafts, [draft]);

const timestamp = "2026-10-08T00:00:00.000Z";
const pending = {
  conversationId: "synthetic-conversation",
  qid: "D13",
  attemptId: "synthetic-attempt",
  contentVersion: "synthetic-v1",
  mode: "critique",
  model: "synthetic-model",
  userInput: "synthetic input",
  assistantOutput: "",
  status: "pending",
  startedAt: timestamp,
  updatedAt: timestamp,
};
const complete = { ...pending, assistantOutput: "synthetic partial reply", status: "complete", updatedAt: "2026-10-08T00:00:01.000Z" };
await Promise.all([saveCoachConversation(pending), saveCoachConversation(complete)]);
const persisted = await getStudySnapshot();
assert.deepEqual(persisted.coachConversations, [complete], "same-conversation writes are serialized in order");
assert.deepEqual(backupFromSnapshot(persisted, "synthetic-v1").coachConversations, [complete], "backups include saved conversations");

const mergedConversation = { ...complete, conversationId: "synthetic-import", assistantOutput: "imported reply" };
const mergeBackup = { ...backupFromSnapshot(persisted, "synthetic-v1"), coachConversations: [complete, mergedConversation] };
await mergeStudyData(mergeBackup, new Set(), new Set(), new Set(), new Set());
assert.equal((await getStudySnapshot()).coachConversations.length, 2, "merge import preserves both conversation records");

const replacement = { ...backupFromSnapshot(persisted, "synthetic-v1"), coachConversations: [mergedConversation] };
await replaceAllStudyData(replacement);
assert.deepEqual((await getStudySnapshot()).coachConversations, [mergedConversation], "replacement includes the conversation store");
assert.equal(filterStudySnapshotForAccount(await getStudySnapshot(), "user-b").drafts[0].text, "private draft B", "replacement restores account drafts");
await clearAllStudyData();
assert.deepEqual(await getStudySnapshot(), { attempts: [], drafts: [], preferences: [], coachConversations: [] }, "clear removes all local stores");

console.log("study store: v1-to-v3 additive migration, A/B scoped drafts, conversation persistence, merge, replacement, and clear passed");
