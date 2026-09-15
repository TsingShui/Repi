import { createEffect, createSignal, For, Show } from "solid-js";
import { discoverOpenAIModels } from "../../lib/agent/discover-models";
import {
  PI_API_KEY_PROVIDERS,
  piApiKeySetup,
  type PiApiKeyProviderId,
} from "./pi-providers";
import type { ModelProvider, NewModelProvider } from "./types";
import "./provider-dialog.css";

type AuthMode = "api-key" | "custom";

export interface ProviderDialogProps {
  readonly open: boolean;
  readonly providers: readonly ModelProvider[];
  readonly onClose: () => void;
  readonly onSave: (provider: NewModelProvider) => Promise<void>;
  readonly onRefresh: (id: string, models: readonly string[]) => Promise<void>;
  readonly onDelete: (id: string) => Promise<void>;
}

export function ProviderDialog(props: ProviderDialogProps) {
  const [mode, setMode] = createSignal<AuthMode>("api-key");
  const [apiProviderId, setApiProviderId] = createSignal<PiApiKeyProviderId>("openai");
  const [name, setName] = createSignal("");
  const [baseUrl, setBaseUrl] = createSignal("http://127.0.0.1:11434/v1");
  const [apiKey, setApiKey] = createSignal("");
  const [models, setModels] = createSignal("");
  const [discovered, setDiscovered] = createSignal<readonly string[]>([]);
  const [manual, setManual] = createSignal(false);
  const [discovering, setDiscovering] = createSignal(false);
  const [refreshingId, setRefreshingId] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let dialog: HTMLDialogElement | undefined;
  let nameInput: HTMLInputElement | undefined;
  let discoveryController: AbortController | undefined;

  createEffect(
    () => props.open,
    (open) => {
      if (!dialog) return;
      if (open && !dialog.open) dialog.showModal();
      else if (!open && dialog.open) dialog.close();
    },
  );

  const resetTransient = () => {
    setApiKey("");
    setModels("");
    setDiscovered([]);
    setManual(false);
    setDiscovering(false);
    setSaving(false);
    discoveryController?.abort();
    discoveryController = undefined;
    setError(null);
  };

  const reset = () => {
    resetTransient();
    setMode("api-key");
    setApiProviderId("openai");
    setName("");
    setBaseUrl("http://127.0.0.1:11434/v1");
  };

  const switchMode = (next: AuthMode) => {
    if (saving()) return;
    resetTransient();
    setMode(next);
    if (next === "custom") queueMicrotask(() => nameInput?.focus());
  };

  const close = () => {
    reset();
    props.onClose();
  };

  const manualModelIds = () =>
    [...new Set(models().split(/[\n,]/).map((model) => model.trim()).filter(Boolean))];

  const discover = async (): Promise<readonly string[]> => {
    if (!baseUrl().trim()) {
      setError("Add a Base URL before discovering models.");
      return [];
    }
    discoveryController?.abort();
    discoveryController = new AbortController();
    setDiscovering(true);
    setError(null);
    try {
      const found = await discoverOpenAIModels(baseUrl(), apiKey(), discoveryController.signal);
      setDiscovered(found);
      setManual(false);
      return found;
    } catch (caught) {
      setManual(true);
      setError(caught instanceof Error ? caught.message : "Models could not be discovered.");
      return [];
    } finally {
      setDiscovering(false);
      discoveryController = undefined;
    }
  };

  const save = async (provider: NewModelProvider) => {
    setSaving(true);
    setError(null);
    try {
      await props.onSave(provider);
      reset();
      props.onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The provider could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const submitApiKey = async () => {
    if (!apiKey().trim()) {
      setError("Enter an API key.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const provider = await piApiKeySetup(apiProviderId());
      await props.onSave({
        kind: "api-key",
        builtinId: apiProviderId(),
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiKey: apiKey().trim(),
        models: provider.models,
      });
      reset();
      props.onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The API key provider could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const submitCustom = async () => {
    let modelIds = discovered().length > 0 ? discovered() : manualModelIds();
    if (!name().trim() || !baseUrl().trim()) {
      setError("Add a provider name and Base URL.");
      return;
    }
    if (modelIds.length === 0 && !manual()) modelIds = await discover();
    if (modelIds.length === 0) {
      setManual(true);
      setError((current) => current ?? "Discover models or enter at least one model ID manually.");
      return;
    }
    await save({
      kind: "custom",
      name: name().trim(),
      baseUrl: baseUrl().trim().replace(/\/$/, ""),
      apiKey: apiKey().trim(),
      models: modelIds,
    });
  };

  const refresh = async (provider: ModelProvider) => {
    if (provider.kind !== "custom") return;
    setRefreshingId(provider.id);
    setError(null);
    try {
      const found = await discoverOpenAIModels(provider.baseUrl, provider.apiKey);
      await props.onRefresh(provider.id, found);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Models could not be refreshed.");
    } finally {
      setRefreshingId(null);
    }
  };

  return (
    <dialog
      class="provider-dialog"
      ref={(node) => (dialog = node)}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClose={() => {
        if (props.open) props.onClose();
      }}
    >
      <div class="provider-dialog-head">
        <div>
          <h2>Add a model</h2>
          <p>Use a supported API key or your own endpoint.</p>
        </div>
        <button type="button" class="provider-dialog-close" aria-label="Close" onClick={close}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>

      <div class="provider-mode-tabs provider-mode-tabs-two" role="tablist" aria-label="Provider mode">
        <button
          type="button"
          role="tab"
          aria-selected={mode() === "api-key" ? "true" : "false"}
          onClick={() => switchMode("api-key")}
        >
          API Key
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode() === "custom" ? "true" : "false"}
          onClick={() => switchMode("custom")}
        >
          Custom
        </button>
      </div>

      <Show when={mode() === "api-key"}>
        <form
          class="provider-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitApiKey();
          }}
        >
          <label class="provider-field">
            <span>Provider</span>
            <select
              value={apiProviderId()}
              onChange={(event) => setApiProviderId(event.currentTarget.value as PiApiKeyProviderId)}
            >
              <For each={PI_API_KEY_PROVIDERS}>
                {(provider) => <option value={provider.id}>{provider.name} — {provider.description}</option>}
              </For>
            </select>
          </label>
          <label class="provider-field">
            <span>API key</span>
            <input
              type="password"
              value={apiKey()}
              placeholder="Paste API key"
              autocomplete="off"
              spellcheck={false}
              onInput={(event) => setApiKey(event.currentTarget.value)}
            />
          </label>
          <p class="provider-mode-note">
            Model IDs, protocols, context limits and compatibility metadata come from Pi's built-in catalog.
          </p>
          <Show when={error()}>{(message) => <p class="provider-error">{message()}</p>}</Show>
          <div class="provider-actions">
            <button type="button" class="provider-cancel" disabled={saving()} onClick={close}>Cancel</button>
            <button type="submit" class="provider-save" disabled={saving()}>
              {saving() ? "Saving…" : "Save API key"}
            </button>
          </div>
        </form>
      </Show>

      <Show when={mode() === "custom"}>
        <form
          class="provider-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitCustom();
          }}
        >
          <label class="provider-field">
            <span>Provider name</span>
            <input
              ref={(node) => (nameInput = node)}
              value={name()}
              placeholder="Ollama"
              autocomplete="off"
              onInput={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <label class="provider-field">
            <span>Base URL</span>
            <input
              type="url"
              value={baseUrl()}
              placeholder="http://127.0.0.1:11434/v1"
              spellcheck={false}
              onInput={(event) => setBaseUrl(event.currentTarget.value)}
            />
          </label>
          <label class="provider-field">
            <span>API key <small>(optional for local endpoints)</small></span>
            <input
              type="password"
              value={apiKey()}
              placeholder="Optional"
              autocomplete="off"
              spellcheck={false}
              onInput={(event) => setApiKey(event.currentTarget.value)}
            />
          </label>
          <div class="provider-model-discovery">
            <div class="provider-model-head">
              <span>Models</span>
              <button
                type="button"
                class="provider-discover"
                disabled={discovering() || saving()}
                onClick={() => void discover()}
              >
                {discovering() ? "Discovering…" : discovered().length > 0 ? "Refresh" : "Discover models"}
              </button>
            </div>
            <Show when={discovered().length > 0}>
              <div class="discovered-models" role="status">
                <p>{discovered().length} models found</p>
                <div>
                  <For each={discovered().slice(0, 8)}>{(model) => <span>{model}</span>}</For>
                  <Show when={discovered().length > 8}><span>+{discovered().length - 8} more</span></Show>
                </div>
              </div>
            </Show>
            <Show when={manual()}>
              <label class="provider-field provider-manual-models">
                <span>Manual model IDs</span>
                <textarea
                  rows={3}
                  value={models()}
                  placeholder={"llama3.1:8b\nqwen2.5-coder:7b"}
                  spellcheck={false}
                  onInput={(event) => setModels(event.currentTarget.value)}
                />
                <small>Fallback when the endpoint does not expose `/models`.</small>
              </label>
            </Show>
          </div>
          <Show when={error()}>{(message) => <p class="provider-error">{message()}</p>}</Show>
          <div class="provider-actions">
            <button type="button" class="provider-cancel" disabled={saving()} onClick={close}>Cancel</button>
            <button type="submit" class="provider-save" disabled={saving() || discovering()}>
              {saving() ? "Saving…" : "Save custom provider"}
            </button>
          </div>
        </form>
      </Show>

      <Show when={props.providers.length > 0}>
        <div class="provider-existing">
          <p class="provider-existing-label">Connected providers</p>
          <For each={props.providers}>
            {(provider) => (
              <div class="provider-row">
                <div>
                  <strong>{provider.name}</strong>
                  <span>{provider.kind === "api-key" ? "API key" : "Custom"} · {provider.models.length} model{provider.models.length === 1 ? "" : "s"}</span>
                </div>
                <div class="provider-row-actions">
                  <Show when={provider.kind === "custom"}>
                    <button
                      type="button"
                      disabled={refreshingId() === provider.id}
                      onClick={() => void refresh(provider)}
                    >
                      {refreshingId() === provider.id ? "Syncing…" : "Sync models"}
                    </button>
                  </Show>
                  <button type="button" aria-label={`Remove ${provider.name}`} onClick={() => void props.onDelete(provider.id)}>
                    Remove
                  </button>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>

      <p class="provider-privacy">
        Credentials stay in this browser's IndexedDB and are sent only to their provider.
      </p>
    </dialog>
  );
}
