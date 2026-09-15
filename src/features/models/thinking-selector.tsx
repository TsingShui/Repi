/**
 * The thinking level, as a control.
 *
 * It sits beside the model picker because it is part of the same decision, and it only appears
 * when the answer is not obvious: a model that cannot think has one level, and a menu offering
 * a single option is a menu that wastes a click. What is offered is what this model accepts —
 * the list is not the app's idea of levels but the model's.
 */
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { applyMenuPlacement, placeMenu } from "../../lib/menu-placement";
import "./thinking-selector.css";

export interface ThinkingSelectorProps {
  /** Levels this model accepts, cheapest first. A single one hides the control. */
  readonly levels: readonly ModelThinkingLevel[];
  readonly value: ModelThinkingLevel;
  readonly onSelect: (level: ModelThinkingLevel) => void;
}

/** How a level reads in a chip, which is a place for one word. */
function label(level: ModelThinkingLevel): string {
  return level === "off" ? "off" : level;
}

/**
 * What each level means, for the one-line hint under the menu.
 *
 * Deliberately not in tokens or seconds: providers translate a level into their own budgets and
 * the numbers differ per model, so a precise-sounding claim here would be wrong somewhere.
 */
const HINTS: Partial<Record<ModelThinkingLevel, string>> = {
  off: "Answer directly.",
  minimal: "The shortest amount of thinking the model offers.",
  low: "Some thinking, for questions that need a moment.",
  medium: "The middle ground most models default to.",
  high: "More thinking, for problems with several steps.",
  xhigh: "Near the model's maximum, where it offers one.",
  max: "The most this model offers.",
};

export function ThinkingSelector(props: ThinkingSelectorProps) {
  const [open, setOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;
  let trigger: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;

  // Same geometry as the model menu, and the same reason: this one lives beside it.
  createEffect(
    () => [open(), props.levels] as const,
    () => {
      if (!open() || !trigger || !menu) return;
      const apply = () => applyMenuPlacement(menu!, placeMenu(trigger!, menu!));
      apply();
      window.addEventListener("resize", apply);
      window.addEventListener("scroll", apply, true);
      const observer = new ResizeObserver(apply);
      observer.observe(menu);
      onCleanup(() => {
        window.removeEventListener("resize", apply);
        window.removeEventListener("scroll", apply, true);
        observer.disconnect();
      });
    },
  );

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
    <Show when={props.levels.length > 1}>
      <div class="thinking-selector" ref={(node) => (root = node)}>
        <button
          ref={(node) => (trigger = node)}
          class="thinking-trigger"
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open() ? "true" : "false"}
          aria-label={`Thinking level: ${props.value}`}
          data-level={props.value}
          onClick={() => setOpen((current) => !current)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 4a4 4 0 00-4 4 3 3 0 00-1 5.8V16a3 3 0 003 3h1a1 1 0 001-1v-3.2M12 4a4 4 0 014 4 3 3 0 011 5.8V16a3 3 0 01-3 3h-1" />
          </svg>
          <span>{label(props.value)}</span>
        </button>

        <Show when={open()}>
          <div
            ref={(node) => (menu = node)}
            class="thinking-menu"
            role="listbox"
            aria-label="Thinking level"
          >
            <For each={props.levels}>
              {(level) => (
                <button
                  class="thinking-option"
                  type="button"
                  role="option"
                  aria-selected={props.value === level ? "true" : "false"}
                  data-level={level}
                  onClick={() => {
                    props.onSelect(level);
                    setOpen(false);
                  }}
                >
                  <span class="thinking-option-name">{label(level)}</span>
                  <Show when={props.value === level}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M5 12.5l4 4L19 7" />
                    </svg>
                  </Show>
                </button>
              )}
            </For>
            <p class="thinking-hint">{HINTS[props.value] ?? ""}</p>
          </div>
        </Show>
      </div>
    </Show>
  );
}
