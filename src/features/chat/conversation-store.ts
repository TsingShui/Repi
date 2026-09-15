import { createSignal, onCleanup } from "solid-js";
import type { Message, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createWorkspaceStorage, type StorageUsage, type StoredFile } from "../../lib/storage/workspace-storage";
import type { ChatLine, Conversation } from "./types";

const ACTIVE_KEY = "repi.active-conversation.v1";
const UNTITLED = "New conversation";

function makeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function makeConversation(fields: Partial<Conversation> = {}): Conversation {
  return {
    id: makeId(),
    title: UNTITLED,
    updatedAt: Date.now(),
    lines: [],
    ...fields,
  };
}

function readActiveId(conversations: readonly Conversation[]): string {
  try {
    const saved = window.localStorage.getItem(ACTIVE_KEY);
    if (saved && conversations.some((conversation) => conversation.id === saved)) return saved;
  } catch {
    // Use the newest conversation when local settings are unavailable.
  }
  return conversations[0]!.id;
}

function rememberActiveId(id: string): void {
  try {
    window.localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    // Selection still works for the lifetime of this page.
  }
}

function titleFrom(lines: readonly ChatLine[]): string | null {
  const first = lines.find((line) => line.kind === "you" || line.kind === "file");
  if (!first) return null;

  const source = first.kind === "you" ? first.text : first.name;
  const compact = source.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  return compact.length > 42 ? `${compact.slice(0, 41)}…` : compact;
}

/**
 * Conversation state in front of persistent workspace storage.
 *
 * Updates appear synchronously in the UI, then enter one ordered persistence
 * queue. That ordering matters: two quick sends must not let the older IndexedDB
 * transaction finish last and replace the newer transcript.
 */
export function createConversationStore() {
  const storage = createWorkspaceStorage();
  const initial = makeConversation();
  const [conversations, setConversations] = createSignal<readonly Conversation[]>([initial]);
  const [activeId, setActiveIdSignal] = createSignal(initial.id);
  const [ready, setReady] = createSignal(false);
  const [storageError, setStorageError] = createSignal<string | null>(null);
  const [usage, setUsage] = createSignal<StorageUsage | null>(null);
  const [files, setFiles] = createSignal<readonly StoredFile[]>([]);
  let disposed = false;
  let writeQueue = Promise.resolve();

  const reportError = (error: unknown) => {
    const message = error instanceof Error ? error.message : "Local storage failed.";
    setStorageError(message);
  };

  const enqueue = (operation: () => Promise<void>) => {
    writeQueue = writeQueue.then(operation).catch(reportError);
  };

  const refreshUsage = async () => {
    try {
      const current = await storage.getUsage();
      if (!disposed) setUsage(current);
    } catch {
      // Usage reporting is optional; reads and writes can still work without it.
    }
  };

  /*
   * What is cached belongs here rather than in its own store: a file is owned by the
   * conversation that accepted it, deleting one deletes the other, and two modules
   * keeping the same bookkeeping is how they drift.
   */
  const refreshFiles = async () => {
    try {
      const stored = await storage.listFiles();
      if (!disposed) setFiles(stored);
    } catch (error) {
      reportError(error);
    }
  };

  const refreshStorage = async () => {
    await Promise.all([refreshUsage(), refreshFiles()]);
  };

  const initialization = (async () => {
    try {
      const restored = await storage.listConversations();
      if (disposed) return;
      const loaded = restored.length > 0 ? restored : [initial];
      setConversations(loaded);
      const selected = readActiveId(loaded);
      setActiveIdSignal(selected);
      rememberActiveId(selected);
    } catch (error) {
      if (!disposed) reportError(error);
    } finally {
      if (!disposed) setReady(true);
    }
    await refreshStorage();
  })();

  onCleanup(() => {
    disposed = true;
  });

  const active = (): Conversation =>
    conversations().find((conversation) => conversation.id === activeId()) ?? conversations()[0]!;

  const appendTo = (id: string, added: readonly ChatLine[]): boolean => {
    if (added.length === 0) return false;

    let updated: Conversation | undefined;
    setConversations((current) => {
      const existing = current.find((conversation) => conversation.id === id);
      if (!existing) return current;

      const lines = [...existing.lines, ...added];
      updated = {
        ...existing,
        title: existing.title === UNTITLED ? (titleFrom(lines) ?? UNTITLED) : existing.title,
        updatedAt: Date.now(),
        lines,
      };
      return [updated, ...current.filter((conversation) => conversation.id !== id)];
    });

    if (!updated) return false;
    const record = updated;
    enqueue(() => storage.putConversation(record));
    return true;
  };

  const updateAssistant = (
    conversationId: string,
    lineId: string,
    patch: Partial<Extract<ChatLine, { kind: "assistant" }>>,
  ) => {
    let updated: Conversation | undefined;
    setConversations((current) =>
      current.map((conversation) => {
        if (conversation.id !== conversationId) return conversation;
        updated = {
          ...conversation,
          updatedAt: Date.now(),
          lines: conversation.lines.map((line) =>
            line.kind === "assistant" && line.id === lineId ? { ...line, ...patch } : line,
          ),
        };
        return updated;
      }),
    );
    return updated;
  };

  const persistConversation = (conversation: Conversation) => {
    enqueue(() => storage.putConversation(conversation));
  };

  const setAgentMessages = (conversationId: string, messages: readonly Message[]) => {
    let updated: Conversation | undefined;
    setConversations((current) =>
      current.map((conversation) => {
        if (conversation.id !== conversationId) return conversation;
        updated = { ...conversation, agentMessages: [...messages] };
        return updated;
      }),
    );
    if (updated) persistConversation(updated);
  };

  const start = () => {
    const previousId = activeId();
    const previous = conversations().find((item) => item.id === previousId);
    /*
     * A new conversation starts where the last one left off: same model, same thinking level.
     * Both are decisions about the work rather than about this conversation, and re-deciding
     * them on every "+" is how a setting ends up living in the user's memory instead of here.
     */
    const conversation = makeConversation({
      ...(previous?.selectedModelKey ? { selectedModelKey: previous.selectedModelKey } : {}),
      ...(previous?.thinkingLevel ? { thinkingLevel: previous.thinkingLevel } : {}),
    });
    setConversations((all) => [
      conversation,
      ...all.filter(
        (item) =>
          item.id !== previousId || item.lines.length > 0 || item.title !== UNTITLED,
      ),
    ]);
    setActiveIdSignal(conversation.id);
    rememberActiveId(conversation.id);
    enqueue(async () => {
      if (previous && previous.lines.length === 0 && previous.title === UNTITLED) {
        await storage.deleteConversation(previous.id);
      }
      await storage.putConversation(conversation);
    });
    return conversation.id;
  };

  const select = (id: string) => {
    if (!conversations().some((conversation) => conversation.id === id)) return;
    setActiveIdSignal(id);
    rememberActiveId(id);
  };

  /**
   * How much the model may think in this conversation.
   *
   * Kept per conversation because the two go together: a quick question and a deep dive on the
   * same model want different answers, and the model cannot know which one this is.
   */
  const selectThinkingLevel = (level: ModelThinkingLevel | undefined) => {
    let updated: Conversation | undefined;
    setConversations((current) =>
      current.map((conversation) => {
        if (conversation.id !== activeId()) return conversation;
        if (level === undefined) {
          const { thinkingLevel: _, ...rest } = conversation;
          void _;
          updated = rest;
          return updated;
        }
        updated = { ...conversation, thinkingLevel: level };
        return updated;
      }),
    );
    if (updated) persistConversation(updated);
  };

  const selectModel = (key: string) => {
    let updated: Conversation | undefined;
    setConversations((current) =>
      current.map((conversation) => {
        if (conversation.id !== activeId()) return conversation;
        updated = { ...conversation, selectedModelKey: key };
        return updated;
      }),
    );
    if (updated) {
      const record = updated;
      enqueue(() => storage.putConversation(record));
    }
  };

  const clearProviderSelection = (providerId: string) => {
    const prefix = `${providerId}:`;
    const changed: Conversation[] = [];
    setConversations((current) =>
      current.map((conversation) => {
        if (!conversation.selectedModelKey?.startsWith(prefix)) return conversation;
        const { selectedModelKey: _, ...withoutSelection } = conversation;
        void _;
        const updated: Conversation = withoutSelection;
        changed.push(updated);
        return updated;
      }),
    );
    for (const conversation of changed) {
      enqueue(() => storage.putConversation(conversation));
    }
  };

  const remove = (id: string) => {
    const remaining = conversations().filter((conversation) => conversation.id !== id);
    const replacement = remaining.length > 0 ? undefined : makeConversation();
    const next = replacement ? [replacement] : remaining;
    setConversations(next);

    if (activeId() === id) {
      setActiveIdSignal(next[0]!.id);
      rememberActiveId(next[0]!.id);
    }

    enqueue(async () => {
      await storage.deleteConversation(id);
      if (replacement) await storage.putConversation(replacement);
      await refreshStorage();
    });
  };

  const saveFile = async (
    conversationId: string,
    file: File,
    onProgress?: (written: number) => void,
  ): Promise<string> => {
    setStorageError(null);
    try {
      await storage.requestPersistence();
      const stored = await storage.saveFile(conversationId, file, onProgress);

      // A large write may finish after its conversation was deleted. Clean it up
      // rather than leaving bytes that no history row can reach.
      if (!conversations().some((conversation) => conversation.id === conversationId)) {
        await storage.deleteFile(stored.id);
        throw new Error("The conversation was deleted before the file finished saving.");
      }

      await refreshStorage();
      return stored.id;
    } catch (error) {
      reportError(error);
      throw error;
    }
  };

  /*
   * A card that said "Saved locally" must stop saying it once the bytes are gone, so
   * the id is cleared from any file line that carries it. The line itself stays: what
   * was opened is part of what happened in the conversation.
   */
  const forgetStoredFile = (storedFileId: string) => {
    const changed: Conversation[] = [];
    setConversations((current) =>
      current.map((conversation) => {
        const owns = conversation.lines.some(
          (line) => line.kind === "file" && line.storedFileId === storedFileId,
        );
        if (!owns) return conversation;

        const updated: Conversation = {
          ...conversation,
          updatedAt: Date.now(),
          lines: conversation.lines.map((line) => {
            if (line.kind !== "file" || line.storedFileId !== storedFileId) return line;
            const { storedFileId: _removed, ...withoutFile } = line;
            void _removed;
            return withoutFile;
          }),
        };
        changed.push(updated);
        return updated;
      }),
    );
    for (const conversation of changed) enqueue(() => storage.putConversation(conversation));
  };

  const removeFile = async (id: string) => {
    setStorageError(null);
    await storage.deleteFile(id);
    forgetStoredFile(id);
    await refreshStorage();
  };

  const removeAllFiles = async () => {
    setStorageError(null);
    const ids = files().map((file) => file.id);
    await Promise.all(ids.map((id) => storage.deleteFile(id)));
    for (const id of ids) forgetStoredFile(id);
    await refreshStorage();
  };

  return {
    conversations,
    active,
    activeId,
    ready,
    storageError,
    usage,
    files,
    appendTo,
    updateAssistant,
    persistConversation,
    setAgentMessages,
    start,
    select,
    selectModel,
    selectThinkingLevel,
    clearProviderSelection,
    remove,
    saveFile,
    removeFile,
    removeAllFiles,
    openFile: storage.openFile,

    /**
     * The shared virtual filesystem, as bytes.
     *
     * Read through the store because it owns the storage: the sandbox asks for what earlier
     * sessions produced, and gets contents rather than handles — a `File` from one storage
     * backend is not something a Worker can be handed portably.
     */
    listVirtualFiles: async (): Promise<readonly { path: string; bytes: Uint8Array }[]> => {
      const derived = await storage.listDerived();
      const loaded = await Promise.all(
        derived
          .filter((record): record is typeof record & { path: string } => record.path !== undefined)
          .map(async (record) => {
            const file = await storage.openFile(record.id);
            return { path: record.path, bytes: new Uint8Array(await file.arrayBuffer()) };
          }),
      );
      return loaded;
    },
    /** Keeps a file a program produced, under the path the sandbox knows it by. */
    saveVirtualFile: async (path: string, bytes: Uint8Array, conversationId: string) => {
      await storage.saveDerived(path, bytes, conversationId);
      await refreshUsage();
    },
    refreshStorage,
    whenReady: () => initialization,
  };
}

export type { ChatLine, Conversation } from "./types";
