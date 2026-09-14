import { For, Show } from "solid-js";
import type { Tab } from "./workspace";

export interface ViewTabsProps {
  readonly tabs: readonly Tab[];
  readonly activeKey: string | null;
  readonly onSelect: (key: string) => void;
  readonly onClose: (key: string) => void;
}

/**
 * A tab is the thing you opened, so the strip shows whatever has been opened and
 * nothing else. Every tab closes, including a code tab — there is no privileged
 * entry, which is what keeps one rule instead of two.
 *
 * The strip scrolls sideways when it fills. That is the weakest part of tabs on
 * touch and it is the price of the model; the tag on each tab is what stops two
 * `Strings` tabs from being ambiguous.
 */
export function ViewTabs(props: ViewTabsProps) {
  return (
    <nav class="view-tabs" aria-label="Open tabs" data-testid="tabs">
      <For each={props.tabs}>
        {(tab) => (
          <span class="view-tab" data-tab={tab.key} data-kind={tab.kind} data-active={props.activeKey === tab.key ? "true" : "false"}>
            <button
              class="view-tab-label"
              type="button"
              title={tab.label}
              aria-pressed={props.activeKey === tab.key ? "true" : "false"}
              onClick={() => props.onSelect(tab.key)}
            >
              <span class="view-tab-name">{tab.label}</span>
              <Show when={tab.tag}>
                {(tag) => <span class="view-tab-tag">{tag()}</span>}
              </Show>
            </button>
            <button
              class="view-tab-close"
              type="button"
              data-close={tab.key}
              aria-label={`Close ${tab.label}`}
              onClick={() => props.onClose(tab.key)}
            >
              <span aria-hidden="true">×</span>
            </button>
          </span>
        )}
      </For>
      <Show when={props.tabs.length === 0}>
        <span class="view-tabs-empty">No tab open</span>
      </Show>
    </nav>
  );
}
