import { createEffect, createSignal, lazy, Match, onCleanup, Show, Switch } from "solid-js";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createFinePointer } from "./lib/pointer";
import { detectFormat } from "./lib/detect-format";
import { createRepiAgentRuntime } from "./lib/agent/repi-agent";
import { AboutScreen } from "./features/about/about-screen";
import { ChatScreen, type ChatLine } from "./features/chat/chat-screen";
import { ConversationSidebar } from "./features/chat/conversation-sidebar";
import { createConversationStore } from "./features/chat/conversation-store";
import { DeviceDialog } from "./features/devices/device-dialog";
import { createDeviceStore } from "./features/devices/device-store";
import { ProviderDialog } from "./features/models/provider-dialog";
import { createModelStore } from "./features/models/model-store";
import { thinkingOptions } from "./features/models/thinking";
import { StorageDialog } from "./features/storage/storage-dialog";
import { modelKey, type ModelProvider } from "./features/models/types";
import "./app.css";

/**
 * The conversation is the home page and has no route of its own. About — which
 * carries the licence list — is reached from it, and is a hash route because the
 * deployment is a static host with no rewrite rules.
 */
function route(): "about" | null {
  if (typeof window === "undefined") return null;
  return window.location.hash.replace(/^#\/?/, "") === "about" ? "about" : null;
}

/**
 * `?probe` is a development-only screen for the one path a Node check cannot reach: a module
 * Worker, `FileReaderSync` over a real file, and `fetch` for the engine and its specs. It is
 * created through `lazy()` inside the guard, so a production bundle has none of it.
 */
export function App() {
  const probing =
    import.meta.env.DEV && new URLSearchParams(window.location.search).has("probe");
  if (probing) {
    const ProbeScreen = lazy(() =>
      import("./features/probe/probe-screen").then((module) => ({ default: module.ProbeScreen })),
    );
    return <ProbeScreen />;
  }
  return <MainApp />;
}

function MainApp() {
  const [page, setPage] = createSignal(route());
  const [dragging, setDragging] = createSignal(false);
  const [sidebarOpen, setSidebarOpen] = createSignal(false);
  const [providerDialogOpen, setProviderDialogOpen] = createSignal(false);
  const [deviceDialogOpen, setDeviceDialogOpen] = createSignal(false);
  const [storageDialogOpen, setStorageDialogOpen] = createSignal(false);
  const [agentWorking, setAgentWorking] = createSignal(false);
  const [fileWrite, setFileWrite] = createSignal<{ readonly name: string; readonly progress: number } | null>(
    null,
  );
  const conversations = createConversationStore();
  const models = createModelStore();
  const devices = createDeviceStore();
  const agentRuntime = createRepiAgentRuntime({
    openFile: conversations.openFile,
    vfs: {
      list: () => conversations.listVirtualFiles(),
      save: (path, bytes, conversationId) =>
        conversations.saveVirtualFile(path, bytes, conversationId),
    },
    // The agent drives the same session the dialog shows; see the store's `bridge`.
    device: devices.bridge,
  });
  const finePointer = createFinePointer();

  /** `provider-id:model-id` resolved against the configured providers. */
  const selection = (providers: readonly ModelProvider[], key: string) => {
    for (const provider of providers) {
      const model = provider.models.find((candidate) => modelKey(provider.id, candidate) === key);
      if (model) return { provider, model };
    }
    return null;
  };

  /**
   * The thinking levels the selected model accepts.
   *
   * Asked per selection rather than computed from the provider list, because answering it means
   * reading pi's catalog for a built-in provider — and the answer belongs to the *model*, not to
   * the app: what is offered here is exactly what will be accepted on the wire.
   */
  const [thinkingLevels, setThinkingLevels] = createSignal<readonly ModelThinkingLevel[]>(["off"]);
  const [effectiveThinkingLevel, setEffectiveThinkingLevel] =
    createSignal<ModelThinkingLevel>("off");
  createEffect(
    () =>
      [
        // Providers are part of the question, not a constant in it: on a refresh the conversation
        // is restored from storage before the provider list is, and an answer computed while the
        // list is still empty is "this model has no levels" — a fact about the load order.
        models.providers(),
        conversations.active().selectedModelKey,
        conversations.active().thinkingLevel,
      ] as const,
    ([providers, key, requested]) => {
      const choice = key === undefined ? null : selection(providers, key);
      if (!choice) {
        setThinkingLevels(["off"]);
        setEffectiveThinkingLevel("off");
        return;
      }
      let current = true;
      void thinkingOptions(choice.provider, choice.model, requested).then((options) => {
        if (!current) return;
        setThinkingLevels(options.levels);
        // Shown, not stored: the conversation keeps the level it asked for, so switching to a
        // model that lacks it and back again does not quietly rewrite the choice.
        setEffectiveThinkingLevel(options.effective);
      });
      onCleanup(() => {
        current = false;
      });
    },
  );

  const onHashChange = () => {
    setPage(route());
    setSidebarOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") setSidebarOpen(false);
  };
  window.addEventListener("hashchange", onHashChange);
  window.addEventListener("keydown", onKeyDown);
  onCleanup(() => {
    window.removeEventListener("hashchange", onHashChange);
    window.removeEventListener("keydown", onKeyDown);
  });

  /*
   * Opening a file lives here rather than in a page, because three things open one:
   * the entry block on About, the attach control in the composer, and a drop, which
   * is accepted anywhere in the window. One entry point means the three cannot
   * drift apart in what they accept or in what they say.
   */
  let acceptingFile = false;
  async function accept(file: File | undefined) {
    if (!file || acceptingFile) return;
    acceptingFile = true;

    // A picker can be used immediately after load. Wait for IndexedDB restoration
    // before choosing the owner so the file cannot land in the temporary shell row.
    await conversations.whenReady();

    // Bind an asynchronous format read to the conversation it began in. Switching
    // history while it runs must not move the resulting card to another thread.
    const conversationId = conversations.activeId();

    // Whatever surface it came from, it belongs in the conversation. Going there
    // first means the file card appears where the user is already looking.
    window.location.hash = "";

    try {
      let format;
      try {
        format = await detectFormat(file);
      } catch {
        conversations.appendTo(conversationId, [{
          kind: "note",
          text: "The browser could not read this file. It may have been moved or removed.",
        }]);
        return;
      }

      try {
        setFileWrite({ name: file.name, progress: 0 });
        const storedFileId = await conversations.saveFile(conversationId, file, (written) => {
          const progress = file.size === 0 ? 1 : Math.min(1, written / file.size);
          setFileWrite({ name: file.name, progress });
        });
        conversations.appendTo(conversationId, [{
          kind: "file",
          name: file.name,
          size: file.size,
          format: format.label,
          detail: format.detail,
          engine: format.engine,
          storedFileId,
        }]);
      } catch {
        conversations.appendTo(conversationId, [{
          kind: "note",
          text: `Repi recognised ${file.name}, but could not save it locally. Check the available browser storage and try again.`,
        }]);
      }
    } finally {
      acceptingFile = false;
      setFileWrite(null);
    }
  }

  const agentErrorMessage = (raw: string) =>
    raw.startsWith("Connection error")
      ? "Could not reach the model provider. Check its Base URL, API key, and browser CORS settings."
      : raw;

  async function send(text: string) {
    if (agentWorking()) return;
    setAgentWorking(true);
    let runIds: { readonly conversationId: string; readonly lineId: string } | null = null;

    try {
      await Promise.all([conversations.whenReady(), models.whenReady()]);
      const conversation = conversations.active();
      const lineId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
      runIds = { conversationId: conversation.id, lineId };
      const added: ChatLine[] = [
        { kind: "you", text },
        { kind: "assistant", id: lineId, text: "", state: "streaming" },
      ];
      conversations.appendTo(conversation.id, added);
      const result = await agentRuntime.run(conversation, models.providers(), text, {
        onText: (answer) => {
          conversations.updateAssistant(conversation.id, lineId, { text: answer });
        },
        onActivity: (activity) => {
          conversations.updateAssistant(conversation.id, lineId, { activity: activity ?? "" });
        },
      });
      conversations.updateAssistant(conversation.id, lineId, {
        text: result.error
          ? agentErrorMessage(result.error)
          : (result.text || "The model returned no text."),
        state: result.error ? "error" : "complete",
        activity: "",
      });
      conversations.setAgentMessages(conversation.id, result.messages);
    } catch (error) {
      const raw = error instanceof Error ? error.message : "The agent could not start.";
      const message = agentErrorMessage(raw);
      if (runIds) {
        const finalConversation = conversations.updateAssistant(runIds.conversationId, runIds.lineId, {
          text: message,
          state: "error",
          activity: "",
        });
        if (finalConversation) conversations.persistConversation(finalConversation);
      }
    } finally {
      setAgentWorking(false);
    }
  }

  // Depth counter, because dragenter fires again for every child the pointer
  // crosses; the leaves only balance out if they are counted.
  let dragDepth = 0;
  const isFileDrag = (event: DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes("Files");

  const onDragEnter = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepth += 1;
    setDragging(true);
  };

  const onDragOver = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    // Without this the browser refuses the drop and navigates to the file instead.
    event.preventDefault();
  };

  const onDragLeave = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDragging(false);
  };

  const onDrop = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepth = 0;
    setDragging(false);
    void accept(event.dataTransfer?.files?.[0]);
  };

  // The component body is the setup: Solid 2 has no `onMount`.
  window.addEventListener("dragenter", onDragEnter);
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("dragleave", onDragLeave);
  window.addEventListener("drop", onDrop);

  onCleanup(() => {
    window.removeEventListener("dragenter", onDragEnter);
    window.removeEventListener("dragover", onDragOver);
    window.removeEventListener("dragleave", onDragLeave);
    window.removeEventListener("drop", onDrop);
  });

  return (
    <div
      class="app"
      data-page={page() === "about" ? "about" : "chat"}
      data-pointer={finePointer() ? "fine" : "coarse"}
    >
      <Show when={page() !== "about"}>
        <ConversationSidebar
          conversations={conversations.conversations()}
          activeId={conversations.activeId()}
          open={sidebarOpen()}
          ready={conversations.ready()}
          storageError={conversations.storageError()}
          usage={conversations.usage()}
          device={devices.sidebar()}
          onNew={() => {
            conversations.start();
            setSidebarOpen(false);
          }}
          onSelect={(id) => {
            conversations.select(id);
            setSidebarOpen(false);
          }}
          onDelete={(id) => {
            const conversation = conversations.conversations().find((item) => item.id === id);
            if (conversation) agentRuntime.disposeConversation(conversation);
            conversations.remove(id);
          }}
          onAddProvider={() => {
            setSidebarOpen(false);
            setProviderDialogOpen(true);
          }}
          onOpenDevice={() => {
            setSidebarOpen(false);
            setDeviceDialogOpen(true);
          }}
          onOpenStorage={() => {
            setSidebarOpen(false);
            setStorageDialogOpen(true);
            void conversations.refreshStorage();
          }}
          onClose={() => setSidebarOpen(false)}
        />
      </Show>

      <div class="app-main">
        <Switch>
          <Match when={page() === "about"}>
            <AboutScreen onClose={() => (window.location.hash = "")} />
          </Match>
          <Match when={true}>
            <ChatScreen
              conversationId={conversations.activeId()}
              lines={conversations.active().lines}
              onSend={(text) => void send(text)}
              working={agentWorking()}
              onStop={agentRuntime.abort}
              onPick={(file) => void accept(file)}
              fileWrite={fileWrite()}
              providers={models.providers()}
              selectedModelKey={conversations.active().selectedModelKey ?? null}
              onSelectModel={conversations.selectModel}
              thinkingLevels={thinkingLevels()}
              thinkingLevel={effectiveThinkingLevel()}
              onSelectThinkingLevel={conversations.selectThinkingLevel}
              onAddProvider={() => setProviderDialogOpen(true)}
              onOpenSidebar={() => setSidebarOpen(true)}
            />
          </Match>
        </Switch>
      </div>

      <DeviceDialog
        open={deviceDialogOpen()}
        status={devices.status()}
        available={devices.available()}
        device={devices.device()}
        error={devices.error()}
        notice={devices.notice()}
        onClose={() => setDeviceDialogOpen(false)}
        onRefresh={() => devices.refresh()}
        onConnect={(id) => devices.connect(id)}
        onRequestDevice={() => devices.requestAndConnect()}
        onDisconnect={() => devices.disconnect()}
      />

      <StorageDialog
        open={storageDialogOpen()}
        usage={conversations.usage()}
        files={conversations.files()}
        conversations={conversations.conversations()}
        error={conversations.storageError()}
        onClose={() => setStorageDialogOpen(false)}
        onDeleteFile={(id) => conversations.removeFile(id)}
        onDeleteAll={() => conversations.removeAllFiles()}
      />

      <ProviderDialog
        open={providerDialogOpen()}
        providers={models.providers()}
        onClose={() => setProviderDialogOpen(false)}
        onSave={async (provider) => {
          const added = await models.add(provider);
          await conversations.whenReady();
          conversations.selectModel(modelKey(added.id, added.models[0]!));
        }}
        onRefresh={async (id, availableModels, reasoningModels) => {
          const updated = await models.updateModels(id, availableModels, reasoningModels);
          const selected = conversations.active().selectedModelKey;
          if (!selected || !availableModels.some((model) => modelKey(id, model) === selected)) {
            conversations.selectModel(modelKey(updated.id, updated.models[0]!));
          }
        }}
        onDelete={async (id) => {
          await models.remove(id);
          conversations.clearProviderSelection(id);
        }}
      />

      {/* Covers the whole screen, because the drop is accepted anywhere on it. */}
      <div class="drop-glow" data-active={dragging() ? "true" : "false"} aria-hidden="true" />
    </div>
  );
}
