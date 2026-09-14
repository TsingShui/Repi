import { For, Show } from "solid-js";
import type { UnitAnalysis } from "../../../lib/analysis/types";

export interface SymbolsViewProps {
  readonly analysis: UnitAnalysis;
  readonly kind: "import" | "export";
}

/**
 * Imports or exports, one kind per tab.
 *
 * They were a single list carrying a direction, which made every consumer filter
 * it and made it easy to show an export under an import heading. A DEX imports
 * types it references and exports its public API; a native library imports libc
 * symbols and exports JNI entry points.
 */
export function SymbolsView(props: SymbolsViewProps) {
  const rows = () => (props.kind === "import" ? props.analysis.imports() : props.analysis.exports());
  const title = () => (props.kind === "import" ? "IMPORT" : "EXPORT");
  const second = () => (props.kind === "import" ? "MODULE" : "KIND");

  return (
    <div class="view-symbols" data-testid={`${props.kind}s-view`}>
      <header class="view-table-head">
        <span class="view-table-title" data-testid={`${props.kind}s-title`}>
          {title()} · {props.analysis.unit.label}
        </span>
        <span class="view-table-count">{rows().length} entries</span>
      </header>

      <Show
        when={rows().length > 0}
        fallback={
          <p class="view-table-empty">
            This unit has no {props.kind === "import" ? "imports" : "exports"}.
          </p>
        }
      >
        <div class="symbol-columns" aria-hidden="true">
          <span>NAME</span>
          <span>{second()}</span>
        </div>
        <div class="symbol-rows">
          <For each={rows()}>
            {(entry) => (
              <div class="symbol-row">
                <span class="symbol-name">{entry.name}</span>
                <span class="symbol-module">{entry.module}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
