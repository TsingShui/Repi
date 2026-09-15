import type { Conversation } from "../../features/chat/types";
import type { ModelProvider } from "../../features/models/types";

const DATABASE_NAME = "repi-workspace";
const DATABASE_VERSION = 3;
const CONVERSATIONS = "conversations";
const FILES = "files";
const FILE_BLOBS = "file-blobs";
const PROVIDERS = "providers";
const OPFS_FILES = "binaries";

const LEGACY_CONVERSATIONS_KEY = "repi.conversations.v1";

export interface StoredFile {
  readonly id: string;
  readonly conversationId: string;
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly lastModified: number;
  readonly createdAt: number;
  readonly backend: "opfs" | "indexeddb";
}

export interface StorageUsage {
  readonly usage: number | null;
  readonly quota: number | null;
  readonly persisted: boolean;
  readonly backend: "opfs" | "indexeddb";
}

/**
 * File metadata as it is stored.
 *
 * Bytes are never part of this record. OPFS holds them when it is available and the
 * `FILE_BLOBS` store holds them when it is not, which is what keeps listing what is
 * cached cheap: a listing would otherwise pull every stored binary through memory.
 *
 * `blob` is only ever read. It is the shape version 2 wrote, and `migrateInlineBlobs`
 * moves those values into `FILE_BLOBS` on the next open.
 */
interface FileRecord extends StoredFile {
  readonly blob?: Blob;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed.")), {
      once: true,
    });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted.")),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new Error("IndexedDB transaction failed.")),
      { once: true },
    );
  });
}

/**
 * Opens the workspace database, tolerating one a newer build has already upgraded.
 *
 * IndexedDB refuses an `open` whose version is lower than the one on disk, with a
 * `VersionError` that would otherwise fail every read: a tab left open across a
 * deployment, an older build running beside a newer one on the same origin, or a
 * browser restoring last week's cached bundle. There is nothing to migrate downwards
 * — a newer version's stores are extra, not different — so the way back in is to ask
 * for no version at all, which returns whatever is there. Asking for a version first
 * is still what creates and upgrades a database this build owns.
 */
async function openDatabase(): Promise<IDBDatabase> {
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.addEventListener("upgradeneeded", () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(CONVERSATIONS)) {
      database.createObjectStore(CONVERSATIONS, { keyPath: "id" });
    }
    if (!database.objectStoreNames.contains(FILES)) {
      const files = database.createObjectStore(FILES, { keyPath: "id" });
      files.createIndex("conversationId", "conversationId", { unique: false });
    }
    if (!database.objectStoreNames.contains(PROVIDERS)) {
      database.createObjectStore(PROVIDERS, { keyPath: "id" });
    }
    if (!database.objectStoreNames.contains(FILE_BLOBS)) {
      database.createObjectStore(FILE_BLOBS, { keyPath: "id" });
    }
  });
  try {
    return await requestResult(request);
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "VersionError") throw error;
    return await requestResult(indexedDB.open(DATABASE_NAME));
  }
}

/**
 * Moves pre-version-3 inline blobs into their own store.
 *
 * Version 2 kept a browser without OPFS honest by putting the bytes inside the
 * metadata record, which made a plain listing of the cache read every binary. This
 * runs once, touches only records that still carry the old field, and leaves the old
 * shape readable if it fails.
 */
async function migrateInlineBlobs(db: IDBDatabase): Promise<void> {
  const read = db.transaction(FILES, "readonly");
  const records = await requestResult(
    read.objectStore(FILES).getAll() as IDBRequest<FileRecord[]>,
  );
  await transactionDone(read);

  const legacy = records.filter((record) => record.blob instanceof Blob);
  if (legacy.length === 0) return;

  const write = db.transaction([FILES, FILE_BLOBS], "readwrite");
  const completed = transactionDone(write);
  const files = write.objectStore(FILES);
  const blobs = write.objectStore(FILE_BLOBS);
  for (const record of legacy) {
    const { blob, ...metadata } = record;
    blobs.put({ id: record.id, blob });
    files.put(metadata);
  }
  await completed;
}

function makeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function opfsAvailable(): boolean {
  return typeof navigator.storage?.getDirectory === "function";
}

async function binaryDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_FILES, { create: true });
}

async function removeOpfsFile(id: string): Promise<void> {
  if (!opfsAvailable()) return;
  try {
    const directory = await binaryDirectory();
    await directory.removeEntry(id);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
  }
}

function isConversation(value: unknown): value is Conversation {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.title !== "string" ||
    typeof record.updatedAt !== "number" ||
    !Array.isArray(record.lines)
  ) {
    return false;
  }

  return (
    record.lines.every((line) => {
      if (!line || typeof line !== "object") return false;
      const item = line as Record<string, unknown>;
      if (item.kind === "you" || item.kind === "note") return typeof item.text === "string";
      return (
        (item.kind === "file" &&
          typeof item.name === "string" &&
          typeof item.size === "number" &&
          typeof item.format === "string" &&
          typeof item.detail === "string" &&
          (item.engine === null || item.engine === "kuna" || item.engine === "rasc") &&
          (item.storedFileId === undefined || typeof item.storedFileId === "string")) ||
        (item.kind === "assistant" &&
          typeof item.id === "string" &&
          typeof item.text === "string" &&
          (item.state === "streaming" || item.state === "complete" || item.state === "error") &&
          (item.activity === undefined || typeof item.activity === "string"))
      );
    }) &&
    (record.selectedModelKey === undefined || typeof record.selectedModelKey === "string") &&
    (record.agentMessages === undefined || Array.isArray(record.agentMessages))
  );
}

function legacyConversations(): readonly Conversation[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(LEGACY_CONVERSATIONS_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter(isConversation) : [];
  } catch {
    return [];
  }
}

/**
 * Persistent workspace storage.
 *
 * IndexedDB owns queryable records and transactions. Large byte streams live in
 * OPFS; IndexedDB stores their names and ownership. Browsers without OPFS fall
 * back to a Blob record, preserving functionality with a weaker large-file path.
 */
export function createWorkspaceStorage() {
  const database = openDatabase().then(async (db) => {
    // Best effort: if the move fails, the records still read through their old field.
    await migrateInlineBlobs(db).catch(() => undefined);
    return db;
  });

  const listConversations = async (): Promise<readonly Conversation[]> => {
    const db = await database;
    const transaction = db.transaction(CONVERSATIONS, "readonly");
    const completed = transactionDone(transaction);
    const records = await requestResult(
      transaction.objectStore(CONVERSATIONS).getAll() as IDBRequest<Conversation[]>,
    );
    await completed;

    const validRecords = records.filter(isConversation).map((conversation) => ({
      ...conversation,
      lines: conversation.lines.map((line) =>
        line.kind === "assistant" && line.state === "streaming"
          ? {
              ...line,
              state: "error" as const,
              activity: "",
              text: line.text || "This response was interrupted when the page closed.",
            }
          : line,
      ),
    }));
    if (validRecords.length > 0) {
      return validRecords.sort((left, right) => right.updatedAt - left.updatedAt);
    }

    const legacy = legacyConversations();
    if (legacy.length > 0) {
      const migration = db.transaction(CONVERSATIONS, "readwrite");
      const completed = transactionDone(migration);
      for (const conversation of legacy) migration.objectStore(CONVERSATIONS).put(conversation);
      await completed;
      localStorage.removeItem(LEGACY_CONVERSATIONS_KEY);
    }
    return [...legacy].sort((left, right) => right.updatedAt - left.updatedAt);
  };

  const putConversation = async (conversation: Conversation): Promise<void> => {
    const db = await database;
    const transaction = db.transaction(CONVERSATIONS, "readwrite");
    const completed = transactionDone(transaction);
    transaction.objectStore(CONVERSATIONS).put(conversation);
    await completed;
  };

  const saveFile = async (
    conversationId: string,
    file: File,
    onProgress?: (written: number) => void,
  ): Promise<StoredFile> => {
    const estimate = await navigator.storage?.estimate?.();
    if (
      estimate?.quota !== undefined &&
      estimate.usage !== undefined &&
      estimate.quota - estimate.usage < file.size
    ) {
      throw new Error("There is not enough browser storage available for this file.");
    }

    const id = makeId();
    const common = {
      id,
      conversationId,
      name: file.name,
      type: file.type,
      size: file.size,
      lastModified: file.lastModified,
      createdAt: Date.now(),
    } as const;

    let record: FileRecord;
    let bytes: Blob | undefined;
    if (opfsAvailable()) {
      const directory = await binaryDirectory();
      const handle = await directory.getFileHandle(id, { create: true });
      const writable = await handle.createWritable();
      let written = 0;
      try {
        const progress = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            written += chunk.byteLength;
            onProgress?.(written);
            controller.enqueue(chunk);
          },
        });
        await file.stream().pipeThrough(progress).pipeTo(writable);
      } catch (error) {
        await writable.abort().catch(() => undefined);
        await removeOpfsFile(id).catch(() => undefined);
        throw error;
      }
      record = { ...common, backend: "opfs" };
    } else {
      record = { ...common, backend: "indexeddb" };
      bytes = file;
      onProgress?.(file.size);
    }

    try {
      const db = await database;
      const transaction = db.transaction(bytes ? [FILES, FILE_BLOBS] : FILES, "readwrite");
      const completed = transactionDone(transaction);
      transaction.objectStore(FILES).put(record);
      if (bytes) transaction.objectStore(FILE_BLOBS).put({ id, blob: bytes });
      await completed;
      return record;
    } catch (error) {
      if (record.backend === "opfs") await removeOpfsFile(id).catch(() => undefined);
      throw error;
    }
  };

  const listFiles = async (): Promise<readonly StoredFile[]> => {
    const db = await database;
    const transaction = db.transaction(FILES, "readonly");
    const completed = transactionDone(transaction);
    const records = await requestResult(
      transaction.objectStore(FILES).getAll() as IDBRequest<FileRecord[]>,
    );
    await completed;
    return records
      .map((record) => {
        const { blob: _blob, ...metadata } = record;
        void _blob;
        return metadata;
      })
      .sort((left, right) => right.createdAt - left.createdAt);
  };

  const readStoredBlob = async (id: string): Promise<Blob | undefined> => {
    const db = await database;
    const transaction = db.transaction(FILE_BLOBS, "readonly");
    const completed = transactionDone(transaction);
    const record = await requestResult(
      transaction.objectStore(FILE_BLOBS).get(id) as IDBRequest<{ blob: Blob } | undefined>,
    );
    await completed;
    return record?.blob;
  };

  const openFile = async (id: string): Promise<File> => {
    const db = await database;
    const transaction = db.transaction(FILES, "readonly");
    const completed = transactionDone(transaction);
    const record = await requestResult(
      transaction.objectStore(FILES).get(id) as IDBRequest<FileRecord | undefined>,
    );
    await completed;
    if (!record) throw new Error("The stored file no longer exists.");

    let blob: Blob;
    if (record.backend === "opfs") {
      const directory = await binaryDirectory();
      const handle = await directory.getFileHandle(id);
      blob = await handle.getFile();
    } else {
      blob = record.blob ?? (await readStoredBlob(id))!;
      if (!blob) throw new Error("The stored file contents are missing.");
    }

    return new File([blob], record.name, {
      type: record.type,
      lastModified: record.lastModified,
    });
  };

  const deleteFile = async (id: string): Promise<void> => {
    const db = await database;
    const read = db.transaction(FILES, "readonly");
    const readCompleted = transactionDone(read);
    const record = await requestResult(
      read.objectStore(FILES).get(id) as IDBRequest<FileRecord | undefined>,
    );
    await readCompleted;
    if (record?.backend === "opfs") await removeOpfsFile(id);

    const write = db.transaction([FILES, FILE_BLOBS], "readwrite");
    const writeCompleted = transactionDone(write);
    write.objectStore(FILES).delete(id);
    write.objectStore(FILE_BLOBS).delete(id);
    await writeCompleted;
  };

  const deleteConversation = async (id: string): Promise<void> => {
    const db = await database;
    const read = db.transaction(FILES, "readonly");
    const readCompleted = transactionDone(read);
    const records = await requestResult(
      read.objectStore(FILES).index("conversationId").getAll(id) as IDBRequest<FileRecord[]>,
    );
    await readCompleted;

    await Promise.all(
      records
        .filter((record) => record.backend === "opfs")
        .map((record) => removeOpfsFile(record.id)),
    );

    const write = db.transaction([CONVERSATIONS, FILES, FILE_BLOBS], "readwrite");
    const writeCompleted = transactionDone(write);
    write.objectStore(CONVERSATIONS).delete(id);
    const files = write.objectStore(FILES);
    const blobs = write.objectStore(FILE_BLOBS);
    for (const record of records) {
      files.delete(record.id);
      blobs.delete(record.id);
    }
    await writeCompleted;
  };

  const listProviders = async (): Promise<readonly ModelProvider[]> => {
    const db = await database;
    const transaction = db.transaction(PROVIDERS, "readonly");
    const completed = transactionDone(transaction);
    const records = await requestResult(
      transaction.objectStore(PROVIDERS).getAll() as IDBRequest<Record<string, unknown>[]>,
    );
    await completed;
    return records
      .flatMap((provider): ModelProvider[] => {
        const validCommon =
          typeof provider.id === "string" &&
          typeof provider.name === "string" &&
          typeof provider.baseUrl === "string" &&
          Array.isArray(provider.models) &&
          provider.models.every((model) => typeof model === "string") &&
          typeof provider.createdAt === "number";
        if (!validCommon) return [];

        // Records from the first Provider UI predate explicit auth modes and are
        // custom OpenAI-compatible providers.
        if (provider.kind === undefined && typeof provider.apiKey === "string") {
          return [{ ...provider, kind: "custom" } as ModelProvider];
        }
        if (provider.kind === "custom" && typeof provider.apiKey === "string") {
          return [provider as ModelProvider];
        }
        if (
          provider.kind === "api-key" &&
          typeof provider.builtinId === "string" &&
          typeof provider.apiKey === "string"
        ) {
          return [provider as ModelProvider];
        }
        return [];
      })
      .sort((left, right) => left.createdAt - right.createdAt);
  };

  const putProvider = async (provider: ModelProvider): Promise<void> => {
    const db = await database;
    const transaction = db.transaction(PROVIDERS, "readwrite");
    const completed = transactionDone(transaction);
    transaction.objectStore(PROVIDERS).put(provider);
    await completed;
  };

  const deleteProvider = async (id: string): Promise<void> => {
    const db = await database;
    const transaction = db.transaction(PROVIDERS, "readwrite");
    const completed = transactionDone(transaction);
    transaction.objectStore(PROVIDERS).delete(id);
    await completed;
  };

  const getUsage = async (): Promise<StorageUsage> => {
    const [estimate, persisted] = await Promise.all([
      navigator.storage?.estimate?.() ?? Promise.resolve({}),
      navigator.storage?.persisted?.() ?? Promise.resolve(false),
    ]);
    return {
      usage: estimate.usage ?? null,
      quota: estimate.quota ?? null,
      persisted,
      backend: opfsAvailable() ? "opfs" : "indexeddb",
    };
  };

  const requestPersistence = async (): Promise<boolean> =>
    navigator.storage?.persist?.() ?? Promise.resolve(false);

  return {
    listConversations,
    putConversation,
    saveFile,
    listFiles,
    openFile,
    deleteFile,
    deleteConversation,
    listProviders,
    putProvider,
    deleteProvider,
    getUsage,
    requestPersistence,
  };
}

export type WorkspaceStorage = ReturnType<typeof createWorkspaceStorage>;
