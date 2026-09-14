import { createMemo, createSignal, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { supports, type NavigatorNode, type ScanState, type UnitAnalysis } from "../../lib/analysis/types";
import { SourceSwitcher } from "./source-switcher";
import { VirtualList } from "./virtual-list";

/** A short list that fits in the column, so it can be shown in full. */
type ExpandableEntry = "import" | "export";
/** A single document. Expanding it would only show a truncated table. */
type TabEntry = "strings" | "meta";

export interface NavigatorProps {
  readonly analysis: UnitAnalysis;
  readonly units: readonly UnitAnalysis[];
  readonly activeUnitId: string;
  readonly scanning: ScanState;
  readonly revision: number;
  readonly activeTabKey: string | null;
  readonly highlightFunctionId: string | null;
  readonly onSelectUnit: (unitId: string) => void;
  readonly onActivateNode: (node: NavigatorNode) => void;
  readonly onOpenEntry: (entry: TabEntry | ExpandableEntry) => void;
  readonly onStop: () => void;
  readonly onFilterReady: (element: HTMLInputElement) => void;
  /** The resize handle, owned by the workspace because it needs the drag state. */
  readonly handle: JSX.Element;
}

/** Fallback only. The live row height comes from the `--row-h` token. */
const ROW_FALLBACK = 28;

export function Navigator(props: NavigatorProps) {
  const [query, setQuery] = createSignal("");
  const [cursor, setCursor] = createSignal(0);
  const [open, setOpen] = createSignal<readonly ExpandableEntry[]>([]);
  const [treeOpen, setTreeOpen] = createSignal(true);
  const [pickerOpen, setPickerOpen] = createSignal(false);

  const unit = () => props.analysis.unit;
  const isDex = () => unit().kind === "dex";

  /*
   * Whether an entry expands is decided by whether its whole list fits. The tree
   * is a tree. Imports and exports are tens of rows, so expanding shows all of
   * them. Strings are thousands, so expanding would put a truncated table in a
   * 268px column — one extra click for less information than the tab it leads to.
   */
  const rows = createMemo<readonly NavigatorNode[]>(() => {
    const all = props.analysis.navigator();
    void props.revision;
    const needle = query().trim().toLowerCase();
    if (needle.length === 0) return all;
    return all.filter((row) => row.label.toLowerCase().includes(needle));
  });

  const scanning = () =>
    props.scanning.phase === "reading-symbols" || props.scanning.phase === "discovering";

  const totalFunctions = () => {
    void props.revision;
    // A class tree is counted in classes. A Java engine hands back a class as one
    // document, so the number of methods is not knowable until a class has been
    // read — and a column holding a class index that says "0" would be reporting
    // the one number it cannot know instead of the one it does.
    return isDex() ? props.analysis.classes().length : props.analysis.functions().length;
  };
  const filtered = () => query().trim().length > 0;

  /**
   * The string count, read through the revision.
   *
   * A unit's table arrives during its scan, and an expression that reads only
   * `props.analysis` does not run again when the table fills in: the count stayed `0`
   * for the whole session under an engine whose strings are fetched after the classes,
   * and a zero there is a claim that the archive has none.
   */
  const stringCount = () => {
    void props.revision;
    // An engine that can count without producing the table says so; otherwise the table
    // is what there is to count.
    return props.analysis.stringTotal?.() ?? props.analysis.strings().length;
  };

  const headCount = () => {
    const total = totalFunctions().toLocaleString();
    return filtered() ? `${rows().length.toLocaleString()} / ${total}` : total;
  };

  const headTitle = () => (isDex() ? "Classes" : "Functions");

  function activate(index: number): void {
    const row = rows()[index];
    if (!row) return;
    props.onActivateNode(row);
  }

  function toggleEntry(entry: ExpandableEntry): void {
    setOpen((current) =>
      current.includes(entry) ? current.filter((value) => value !== entry) : [...current, entry],
    );
    // Expanding and opening are the same intent, so they share one click.
    props.onOpenEntry(entry);
  }

  const symbolRows = (kind: ExpandableEntry) =>
    kind === "import" ? props.analysis.imports() : props.analysis.exports();

  return (
    <aside class="workspace-navigator">
      <Show
        when={props.units.length > 1}
      >
        <SourceSwitcher
          units={props.units.map((entry) => entry.unit)}
          activeId={props.activeUnitId}
          open={pickerOpen()}
          onToggle={() => setPickerOpen((value) => !value)}
          onSelect={(unitId) => {
            setPickerOpen(false);
            setQuery("");
            setCursor(0);
            props.onSelectUnit(unitId);
          }}
        />
      </Show>

      <section class="section" data-section="tree" data-open={String(treeOpen())}>
        <header class="section-head">
          <button
            class="section-toggle"
            type="button"
            aria-expanded={treeOpen() ? "true" : "false"}
            onClick={() => setTreeOpen((value) => !value)}
          >
            <span class="twist" aria-hidden="true">
              {treeOpen() ? "▾" : "▸"}
            </span>
            <span class="section-title">{headTitle()}</span>
          </button>
          <span class="section-count" data-testid="navigator-count">
            {headCount()}
          </span>
          <Show when={scanning()}>
            <span class="section-working">Analyzing</span>
            <button class="navigator-stop" type="button" onClick={props.onStop} aria-label="Stop analysis">
              <span aria-hidden="true">■</span>
            </button>
          </Show>
          <Show when={props.scanning.phase === "stopped"}>
            <span class="section-working" data-testid="navigator-partial">
              Partial
            </span>
          </Show>
        </header>

        <Show when={treeOpen()}>
          {/*
            An empty column explains nothing on its own: it looks identical
            whether the engine is still starting, found no functions, or could
            not read the file. Whatever the scan has to say is said here, in the
            column the user is already looking at.
          */}
          <Show when={props.scanning.message}>
            {(message) => (
              <p class="navigator-note" data-testid="navigator-note" data-phase={props.scanning.phase}>
                {message()}
              </p>
            )}
          </Show>

          <label class="navigator-filter">
            <span class="navigator-filter-icon" aria-hidden="true">
              ⌕
            </span>
            <input
              type="search"
              placeholder="Filter"
              value={query()}
              ref={props.onFilterReady}
              onInput={(event) => {
                setQuery(event.currentTarget.value);
                setCursor(0);
              }}
            />
          </label>

          <VirtualList
            count={rows().length}
            rowHeight={ROW_FALLBACK}
            overscan={6}
            label={headTitle()}
            cursorIndex={cursor}
            onCursor={setCursor}
            onActivate={activate}
            renderRow={(index) => {
              const row = rows()[index];
              if (!row) return null;
              const selected =
                (row.functionId !== null && row.functionId === props.highlightFunctionId) ||
                (row.functionId === null && props.activeTabKey === `class:${row.classId}`);
              return (
                <button
                  class="navigator-row"
                  type="button"
                  role="option"
                  aria-selected={selected ? "true" : "false"}
                  data-kind={row.kind}
                  data-depth={row.depth}
                  data-expanded={row.expandable ? String(row.expanded) : undefined}
                  onClick={() => {
                    setCursor(index);
                    activate(index);
                  }}
                >
                  <span class="navigator-row-label">{row.label}</span>
                  <span class="navigator-row-detail">{row.detail}</span>
                </button>
              );
            }}
          />
        </Show>
      </section>

      {/*
        An entry appears only when the engine behind this unit can answer it. A
        disabled row would be a promise the engine has not made; an absent one is
        simply the truth about what is loaded.
      */}
      <Show when={supports(props.analysis, "strings")}>
        <button
          class="section-head is-entry"
          type="button"
          data-entry="strings"
          onClick={() => props.onOpenEntry("strings")}
        >
          <span class="twist" aria-hidden="true" />
          <span class="section-title">Strings</span>
          <span class="section-count">{stringCount().toLocaleString()}</span>
        </button>
      </Show>

      {(["import", "export"] as const)
        .filter((kind) => supports(props.analysis, kind === "import" ? "imports" : "exports"))
        .map((kind) => (
        <section class="section" data-section={kind} data-open={String(open().includes(kind))}>
          <button
            class="section-head"
            type="button"
            data-section={kind}
            aria-expanded={open().includes(kind) ? "true" : "false"}
            onClick={() => toggleEntry(kind)}
          >
            <span class="twist" aria-hidden="true">
              {open().includes(kind) ? "▾" : "▸"}
            </span>
            <span class="section-title">{kind === "import" ? "Import" : "Export"}</span>
            <span class="section-count">{symbolRows(kind).length} entries</span>
          </button>

          <Show when={open().includes(kind)}>
            <div class="section-body" data-list={kind}>
              {symbolRows(kind).map((entry) => (
                <button
                  class="navigator-row symbol-row"
                  type="button"
                  data-kind={kind}
                  onClick={() => props.onOpenEntry(kind)}
                >
                  <span class="navigator-row-label">{entry.name}</span>
                  <span class="navigator-row-detail">{entry.module}</span>
                </button>
              ))}
            </div>
          </Show>
          </section>
        ))}

      <button
        class="section-head is-entry"
        type="button"
        data-entry="meta"
        onClick={() => props.onOpenEntry("meta")}
      >
        <span class="twist" aria-hidden="true" />
        <span class="section-title">Meta</span>
        <span class="section-count">
          {supports(props.analysis, "sections") ? "format · sections" : "format"}
        </span>
      </button>

      {props.handle}
    </aside>
  );
}
