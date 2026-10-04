import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(homedir(), ".config", "frontend-atlas");
const STORE_FILE = "siwc-profiles.json";
const MAX_STORE_BYTES = 256 * 1024;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("The local credential directory is not a private directory.");
  }
  await chmod(directory, 0o700);
}

async function readStoreFile(directory) {
  const filePath = path.join(directory, STORE_FILE);
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("The local credential file is not a regular file.");
    }
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new Error("The local credential file permissions are too broad.");
    }
    if (info.size > MAX_STORE_BYTES) throw new Error("The local credential file is too large.");
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (!isPlainObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.profiles)) {
      throw new Error("The local credential file has an unsupported format.");
    }
    if (parsed.pendingRegistrations !== undefined && !Array.isArray(parsed.pendingRegistrations)) {
      throw new Error("The local pending-registration list is invalid.");
    }
    parsed.pendingRegistrations ??= [];
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeStoreFile(directory, value) {
  await ensurePrivateDirectory(directory);
  const targetPath = path.join(directory, STORE_FILE);
  const tempPath = path.join(directory, `.${STORE_FILE}.${randomUUID()}.tmp`);
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(tempPath, 0o600);
  await rename(tempPath, targetPath);
  await chmod(targetPath, 0o600);
}

function makeHostId() {
  return `urn:uuid:${randomUUID()}`;
}

export function createCredentialStore({ directory = APP_DIR } = {}) {
  let mutationQueue = Promise.resolve();
  function serializeMutation(operation) {
    const current = mutationQueue.then(operation, operation);
    mutationQueue = current.then(() => undefined, () => undefined);
    return current;
  }

  async function load() {
    await ensurePrivateDirectory(directory);
    const stored = await readStoreFile(directory);
    if (!stored) return { version: 1, hostId: makeHostId(), profiles: [] };
    if (typeof stored.hostId !== "string" || !/^urn:uuid:[0-9a-f-]{36}$/iu.test(stored.hostId)) {
      throw new Error("The local host identifier is invalid.");
    }
    const seen = new Set();
    for (const profile of stored.profiles) {
      if (!isPlainObject(profile) || typeof profile.clientId !== "string" || !/^oaiapp_[A-Za-z0-9_-]{1,180}$/u.test(profile.clientId) || seen.has(profile.clientId)) {
        throw new Error("The local profile list is invalid.");
      }
      seen.add(profile.clientId);
      if (!Array.isArray(profile.scopes) || typeof profile.subject !== "string") {
        throw new Error("A local profile is incomplete.");
      }
      if (profile.accessToken !== null && typeof profile.accessToken !== "string") {
        throw new Error("A local access-token entry is invalid.");
      }
      if (profile.refreshToken !== null && typeof profile.refreshToken !== "string") {
        throw new Error("A local refresh-token entry is invalid.");
      }
    }
    for (const registration of stored.pendingRegistrations) {
      if (!isPlainObject(registration) || typeof registration.clientId !== "string" ||
        !/^oaiapp_[A-Za-z0-9_-]{1,180}$/u.test(registration.clientId) || registration.hostId !== stored.hostId || seen.has(registration.clientId)) {
        throw new Error("A local pending registration is invalid.");
      }
      seen.add(registration.clientId);
    }
    return stored;
  }

  return {
    directory,
    async getState() {
      return serializeMutation(async () => {
        const stored = await load();
        // Persist the stable host ID before first authorization, as required by SIWC.
        if (!(await readStoreFile(directory))) await writeStoreFile(directory, stored);
        return stored;
      });
    },
    async saveProfile(profile) {
      return serializeMutation(async () => {
        const stored = await load() ?? { version: 1, hostId: makeHostId(), profiles: [], pendingRegistrations: [] };
        const index = stored.profiles.findIndex((item) => item.clientId === profile.clientId);
        const profiles = [...stored.profiles];
        if (index === -1) profiles.push(profile);
        else profiles[index] = profile;
        const pendingRegistrations = stored.pendingRegistrations.filter((item) => item.clientId !== profile.clientId);
        await writeStoreFile(directory, { ...stored, version: 1, profiles, pendingRegistrations });
        return profile;
      });
    },
    async savePendingRegistration(clientId, hostId) {
      return serializeMutation(async () => {
        const stored = await load();
        if (!stored) throw new Error("The stable host identifier must exist before registration can be saved.");
        if (stored.hostId !== hostId) throw new Error("The pending registration does not match this host.");
        if (stored.profiles.some((item) => item.clientId === clientId)) return;
        const pending = stored.pendingRegistrations.filter((item) => item.clientId !== clientId);
        pending.push({ clientId, hostId, createdAt: new Date().toISOString() });
        await writeStoreFile(directory, { ...stored, pendingRegistrations: pending });
      });
    },
    async removePendingRegistration(clientId) {
      return serializeMutation(async () => {
        const stored = await load();
        if (!stored) return;
        const pendingRegistrations = stored.pendingRegistrations.filter((item) => item.clientId !== clientId);
        await writeStoreFile(directory, { ...stored, pendingRegistrations });
      });
    },
    async updateProfile(clientId, update) {
      return serializeMutation(async () => {
        const stored = await load();
        if (!stored) throw new Error("No saved ChatGPT profile was found.");
        const index = stored.profiles.findIndex((item) => item.clientId === clientId);
        if (index === -1) throw new Error("The selected ChatGPT profile was not found.");
        const profile = { ...stored.profiles[index], ...update };
        const profiles = [...stored.profiles];
        profiles[index] = profile;
        await writeStoreFile(directory, { ...stored, profiles });
        return profile;
      });
    },
    async removeProfile(clientId) {
      return serializeMutation(async () => {
        const stored = await load();
        if (!stored) return;
        const profiles = stored.profiles.filter((item) => item.clientId !== clientId);
        await writeStoreFile(directory, { ...stored, profiles });
      });
    },
    async clearProfileTokens(clientId) {
      return this.updateProfile(clientId, {
        idToken: null,
        accessToken: null,
        refreshToken: null,
        expiresAt: 0,
        scopes: [],
        signedOutAt: new Date().toISOString(),
        localSignoutPending: false,
      });
    },
    async deleteStoreForTests() {
      return serializeMutation(async () => {
        try {
          await unlink(path.join(directory, STORE_FILE));
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      });
    },
  };
}

export const credentialStorePath = path.join(APP_DIR, STORE_FILE);
