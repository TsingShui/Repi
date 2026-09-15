import { createSignal, For, onCleanup, Show } from "solid-js";
import { modelKey, type ModelProvider } from "./types";
import "./model-selector.css";

export interface ModelSelectorProps {
  readonly providers: readonly ModelProvider[];
  readonly selectedKey: string | null;
  readonly onSelect: (key: string) => void;
  readonly onAddProvider: () => void;
}

export function ModelSelector(props: ModelSelectorProps) {
  const [open, setOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;

  const selected = () => {
    const key = props.selectedKey;
    if (!key) return null;
    for (const provider of props.providers) {
      const model = provider.models.find((candidate) => modelKey(provider.id, candidate) === key);
      if (model) return { provider, model };
    }
    return null;
  };

  const hasModels = () => props.providers.some((provider) => provider.models.length > 0);

  const onPointerDown = (event: PointerEvent) => {
    if (open() && root && !root.contains(event.target as Node)) setOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (open() && event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
    }
  };
  window.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("keydown", onKeyDown);
  onCleanup(() => {
    window.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <div class="model-selector" ref={(node) => (root = node)}>
      <Show
        when={hasModels()}
        fallback={
          <button class="model-selector-empty" type="button" onClick={props.onAddProvider}>
            + Model
          </button>
        }
      >
        <button
          class="model-selector-trigger"
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open() ? "true" : "false"}
          onClick={() => setOpen((current) => !current)}
        >
          <span class="model-selector-current">
            <Show when={selected()} fallback={<span>Select model</span>}>
              {(choice) => (
                <>
                  <span class="model-selector-name">{choice().model}</span>
                  <span class="model-selector-provider">{choice().provider.name}</span>
                </>
              )}
            </Show>
          </span>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 10l4 4 4-4" />
          </svg>
        </button>

        <Show when={open()}>
          <div class="model-menu" role="listbox" aria-label="Choose a model">
            <div class="model-menu-scroll">
              <For each={props.providers}>
                {(provider) => (
                  <Show when={provider.models.length > 0}>
                    <section class="model-provider-group">
                      <p class="model-provider-name">{provider.name}</p>
                      <For each={provider.models}>
                        {(model) => {
                          const key = modelKey(provider.id, model);
                          const active = () => props.selectedKey === key;
                          return (
                            <button
                              class="model-option"
                              type="button"
                              role="option"
                              aria-selected={active() ? "true" : "false"}
                              onClick={() => {
                                props.onSelect(key);
                                setOpen(false);
                              }}
                            >
                              <span>{model}</span>
                              <Show when={active()}>
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                  <path d="M5 12.5l4 4L19 7" />
                                </svg>
                              </Show>
                            </button>
                          );
                        }}
                      </For>
                    </section>
                  </Show>
                )}
              </For>
            </div>
            <button
              class="model-menu-add"
              type="button"
              onClick={() => {
                setOpen(false);
                props.onAddProvider();
              }}
            >
              <span aria-hidden="true">+</span>
              Add provider
            </button>
          </div>
        </Show>
      </Show>
    </div>
  );
}
