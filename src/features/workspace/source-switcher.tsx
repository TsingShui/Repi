import { For, Show } from "solid-js";
import type { AnalysisUnit } from "../../lib/analysis/types";

export interface SourceSwitcherProps {
  readonly units: readonly AnalysisUnit[];
  readonly activeId: string;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onSelect: (id: string) => void;
}

/**
 * Which analysis unit the navigator is showing.
 *
 * DEX is one entry, because `classes.dex`, `classes2.dex` and the rest form a
 * single class namespace. Native libraries are listed individually, because each
 * one is a separate executable with its own functions. The unit of this list is
 * an analysis unit, not a file, so a universal Mach-O lists its slices the same
 * way.
 */
export function SourceSwitcher(props: SourceSwitcherProps) {
  const active = () => props.units.find((unit) => unit.id === props.activeId);
  const dex = () => props.units.filter((unit) => unit.kind === "dex");
  const native = () => props.units.filter((unit) => unit.kind === "native");

  return (
    <div class="source-switcher">
      <button
        class="source-current"
        type="button"
        aria-expanded={props.open ? "true" : "false"}
        aria-haspopup="listbox"
        onClick={props.onToggle}
        data-testid="source-current"
      >
        <span class="source-current-label">{active()?.label ?? ""}</span>
        <span class="source-current-detail">{active()?.detail ?? ""}</span>
        <span class="source-chevron" aria-hidden="true">
          ▾
        </span>
      </button>

      <Show when={props.open}>
        <button class="source-scrim" type="button" aria-label="Close source list" onClick={props.onToggle} />
        <div class="source-picker" role="listbox" aria-label="Analysis units" data-testid="source-picker">
          <Show when={dex().length > 0}>
            <p class="source-group">DEX</p>
            <For each={dex()}>
              {(unit) => (
                <button
                  class="source-option"
                  type="button"
                  role="option"
                  aria-selected={unit.id === props.activeId ? "true" : "false"}
                  data-unit={unit.id}
                  onClick={() => props.onSelect(unit.id)}
                >
                  {unit.label}
                </button>
              )}
            </For>
          </Show>

          <Show when={native().length > 0}>
            <p class="source-group">NATIVE</p>
            <For each={native()}>
              {(unit) => (
                <button
                  class="source-option"
                  type="button"
                  role="option"
                  aria-selected={unit.id === props.activeId ? "true" : "false"}
                  data-unit={unit.id}
                  onClick={() => props.onSelect(unit.id)}
                >
                  <span class="source-option-label">{unit.label}</span>
                  <span class="source-option-detail">{unit.detail}</span>
                </button>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  );
}
