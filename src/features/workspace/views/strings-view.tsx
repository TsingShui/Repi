import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { StringEntry, UnitAnalysis } from "../../../lib/analysis/types";
import { VirtualList } from "../virtual-list";

export interface StringsViewProps {
  readonly analysis: UnitAnalysis;
  readonly revision: number;
  /**
   * Follows a string to the unit that uses it. For a language with classes that
   * is the class, with the method marked; for a native unit it is the function.
   */
  readonly onJump: (functionId: string) => void;
  /**
   * Asks the engine who uses this string, and goes there.
   *
   * A unit whose engine can search asks it; a unit that holds its own table jumps straight
   * to the row's owner. The two are the same intention, which is why they arrive as two
   * props and the view does not decide which is available.
   */
  readonly onLookup: (value: string) => void;
}

/** Fallback only. The live row height comes from the `--row-h` token. */
const ROW_FALLBACK = 44;
/** Rows in a searched page. A page is what a reader scans before narrowing further. */
const PAGE_ROWS = 500;
/** Typing is not a request per keystroke. */
const SEARCH_DELAY_MS = 250;

/**
 * The strings table.
 *
 * It owns a filter independent of the navigator's: one narrows symbols, the other
 * narrows strings, and conflating them would make either useless.
 */
export function StringsView(props: StringsViewProps) {
  const [query, setQuery] = createSignal("");
  const [cursor, setCursor] = createSignal(0);
  /** The rows the engine returned for the current query, when it does the searching. */
  const [page, setPage] = createSignal<readonly StringEntry[]>([]);
  const [failed, setFailed] = createSignal<string | null>(null);

  /*
   * A table of half a million values is not held: the engine searches it and hands back
   * a page, so the filter has to ask it. The work is debounced because typing is not a
   * request per keystroke, and the request is abandoned when the query has moved on —
   * two searches in flight would otherwise race, and the older answer can arrive last.
   */
  const searches = () => props.analysis.searchStrings !== undefined;

  createEffect(
    () => ({ query: query(), revision: props.revision, searches: searches() }),
    (target) => {
      const search = props.analysis.searchStrings;
      if (search === undefined) return;

      let token = 0;
      const timer = window.setTimeout(() => {
        token += 1;
        const mine = token;
        void search
          .call(props.analysis, target.query.trim(), PAGE_ROWS)
          .then((entries) => {
            if (mine !== token) return;
            setFailed(null);
            setPage(entries);
          })
          .catch((error: unknown) => {
            if (mine !== token) return;
            setFailed(error instanceof Error ? error.message : String(error));
          });
      }, SEARCH_DELAY_MS);

      return () => {
        window.clearTimeout(timer);
        token += 1;
      };
    },
  );

  const rows = createMemo(() => {
    void props.revision;
    if (searches()) return page();
    const all = props.analysis.strings();
    const needle = query().trim().toLowerCase();
    if (needle.length === 0) return all;
    return all.filter((entry) => entry.value.toLowerCase().includes(needle));
  });

  /*
   * The counts are one pass over the archive, asked for when the table is opened rather than
   * when the unit is: the tab may never be opened, and the pass costs more than the page it
   * annotates. A failure is reported rather than swallowed - the check suite treats a console
   * error as a failure, so a broken call cannot pass as "this table has no counts".
   */
  const loadXrefs = props.analysis.loadStringXrefs;
  if (loadXrefs !== undefined) {
    void loadXrefs.call(props.analysis).catch((error: unknown) => {
      console.error("strings: reference counts could not be read:", error);
    });
  }

  onCleanup(() => setPage([]));

  function activate(index: number): void {
    const entry = rows()[index];
    if (!entry) return;
    if (entry.functionId !== null) {
      props.onJump(entry.functionId);
      return;
    }
    // No owner in the table: ask the engine, which is the only way a Java unit can say who
    // uses a string. A unit that cannot search does nothing here rather than jump wrongly.
    if (props.analysis.findReferences !== undefined) props.onLookup(entry.value);
  }

  return (
    <div class="view-strings" data-testid="strings-view">
      <header class="view-table-head">
        <label class="strings-filter">
          <span class="navigator-filter-icon" aria-hidden="true">
            ⌕
          </span>
          <input
            type="search"
            placeholder="Filter strings"
            value={query()}
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setCursor(0);
            }}
            data-testid="strings-filter"
          />
        </label>
        {/* A searched page says how much of the table it is a page of: a bare "500"
            beside a filter reads as the whole answer. */}
        <span class="view-table-count" data-testid="strings-count">
          {(() => {
            const total = props.analysis.stringTotal?.();
            const shown = rows().length.toLocaleString();
            return total !== undefined && total > rows().length ? `${shown} / ${total.toLocaleString()}` : shown;
          })()}
        </span>
      </header>

      <div class="strings-columns" aria-hidden="true">
        <span class="strings-col-addr">ADDR</span>
        <span class="strings-col-value">VALUE</span>
        <span class="strings-col-xrefs">XREFS</span>
      </div>

      {failed() !== null ? (
        <p class="navigator-note" data-testid="strings-failed">
          {failed()}
        </p>
      ) : null}

      <VirtualList
        count={rows().length}
        rowHeight={ROW_FALLBACK}
        overscan={6}
        label="Strings"
        cursorIndex={cursor}
        onCursor={setCursor}
        onActivate={activate}
        renderRow={(index) => {
          const entry = rows()[index];
          if (!entry) return null;
          return (
            <button
              class="strings-row"
              type="button"
              role="option"
              aria-selected="false"
              data-jumpable={entry.functionId ? "true" : "false"}
              data-owner={entry.functionId ?? ""}
              onClick={() => {
                setCursor(index);
                activate(index);
              }}
            >
              <span class="strings-col-addr">{entry.address.toString(16)}</span>
              <span class="strings-col-value">{entry.value}</span>
              {/* A dash is "nobody has counted"; a zero is "counted, and nothing uses it". */}
              <span class="strings-col-xrefs" data-empty={entry.xrefs === null ? "true" : "false"}>
                {entry.xrefs ?? "—"}
              </span>
            </button>
          );
        }}
      />
    </div>
  );
}
