import { createSignal, onCleanup } from "solid-js";
import { createWorkspaceStorage } from "../../lib/storage/workspace-storage";
import type { ModelProvider, NewModelProvider } from "./types";

function makeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Provider configuration state backed by the workspace's IndexedDB database. */
export function createModelStore() {
  const storage = createWorkspaceStorage();
  const [providers, setProviders] = createSignal<readonly ModelProvider[]>([]);
  const [ready, setReady] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let disposed = false;

  const initialization = (async () => {
    try {
      const restored = await storage.listProviders();
      if (!disposed) setProviders(restored);
    } catch (caught) {
      if (!disposed) {
        setError(caught instanceof Error ? caught.message : "Model providers could not be loaded.");
      }
    } finally {
      if (!disposed) setReady(true);
    }
  })();

  onCleanup(() => {
    disposed = true;
  });

  const add = async (
    input: NewModelProvider,
  ): Promise<ModelProvider> => {
    await initialization;
    const provider = { ...input, id: makeId(), createdAt: Date.now() } as ModelProvider;
    await storage.putProvider(provider);
    setProviders((current) => [...current, provider]);
    setError(null);
    return provider;
  };

  const update = async (updated: ModelProvider): Promise<ModelProvider> => {
    await initialization;
    await storage.putProvider(updated);
    setProviders((current) => current.map((provider) => (provider.id === updated.id ? updated : provider)));
    setError(null);
    return updated;
  };

  const updateModels = async (
    id: string,
    models: readonly string[],
    reasoningModels: readonly string[] = [],
  ): Promise<ModelProvider> => {
    await initialization;
    const existing = providers().find((provider) => provider.id === id);
    if (!existing) throw new Error("The provider is no longer available.");
    const { reasoningModels: _, ...withoutReasoning } = existing;
    void _;
    // Refreshed from the catalog, not merged: a model that stopped advertising reasoning is a
    // model whose reasoning_effort should stop being sent.
    const updated: ModelProvider = {
      ...withoutReasoning,
      models: [...models],
      ...(reasoningModels.length > 0 ? { reasoningModels: [...reasoningModels] } : {}),
    };
    await storage.putProvider(updated);
    setProviders((current) => current.map((provider) => (provider.id === id ? updated : provider)));
    setError(null);
    return updated;
  };

  const remove = async (id: string): Promise<void> => {
    await initialization;
    await storage.deleteProvider(id);
    setProviders((current) => current.filter((provider) => provider.id !== id));
    setError(null);
  };

  return {
    providers,
    ready,
    error,
    add,
    update,
    updateModels,
    remove,
    whenReady: () => initialization,
  };
}
