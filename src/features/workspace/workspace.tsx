import { createSignal, Match, onCleanup, Show, Switch } from "solid-js";
import type { FormatMatch } from "../../lib/detect-format";
import type { AnalysisSource } from "../../lib/analysis/types";
import { supports, type NavigatorNode, type ScanState } from "../../lib/analysis/types";
import { createViewportWidth } from "../../lib/viewport";
import { TopBar } from "./top-bar";
import { ViewTabs } from "./view-tabs";
import { Navigator } from "./navigator";
import { ProgressBar } from "./progress-bar";
import { CodeView } from "./views/code-view";
import { StringsView } from "./views/strings-view";
import { SymbolsView } from "./views/symbols-view";
import { MetaView } from "./views/meta-view";
import "./workspace.css";

export interface WorkspaceProps {
  readonly file: File;
  readonly format: FormatMatch;
  /**
   * The engine for this file, chosen before the workspace mounted. The workspace
   * does not decide which engine to use and does not know what the options are.
   */
  readonly source: AnalysisSource;
  readonly onClose: () => void;
}

const NAVIGATOR_DEFAULT = 300;
const NAVIGATOR_MIN = 240;
const NAVIGATOR_MAX = 480;
const NAVIGATOR_STEP = 24;
/** The main area keeps at least this much width; below it the navigator gives way. */
const MAIN_MIN = 420;
/** Under this the two panes stop being useful at all and the navigator overlays. */
const TWO_COLUMN_MIN = NAVIGATOR_MIN + MAIN_MIN;
const WIDTH_STORAGE_KEY = "repi.navigator-width";

const IDLE_SCAN: ScanState = { phase: "reading-symbols", fraction: null, discovered: 0, message: null };

export type TabKind = "class" | "function" | "strings" | "import" | "export" | "meta";

/**
 * A tab is the thing you opened, not a view.
 *
 * `subject` is the class or function it stands for; `mark` is the method to
 * highlight inside a class, which is how clicking a second method of the same
 * class moves the mark instead of opening a second tab.
 */
export interface Tab {
  readonly key: string;
  readonly label: string;
  readonly kind: TabKind;
  readonly unitId: string;
  readonly tag: string | null;
  readonly subject: string | null;
  readonly mark: string | null;
}

function storedNavigatorWidth(): number {
  const raw = window.localStorage.getItem(WIDTH_STORAGE_KEY);
  const value = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(value)) return NAVIGATOR_DEFAULT;
  return Math.min(NAVIGATOR_MAX, Math.max(NAVIGATOR_MIN, value));
}

export function Workspace(props: WorkspaceProps) {
  const source = props.source;
  const worldWidth = createViewportWidth();

  const [navigatorWidth, setNavigatorWidth] = createSignal(storedNavigatorWidth());
  const [navigatorPanelOpen, setNavigatorPanelOpen] = createSignal(true);
  const [dragging, setDragging] = createSignal(false);
  const [activeUnitId, setActiveUnitId] = createSignal(source.primaryUnitId);
  const [scanning, setScanning] = createSignal<ScanState>(IDLE_SCAN);
  const [revision, setRevision] = createSignal(0);
  const [tabs, setTabs] = createSignal<readonly Tab[]>([]);
  const [activeKey, setActiveKey] = createSignal<string | null>(null);
  const [showAssembly, setShowAssembly] = createSignal(false);
  const [slowOperation, setSlowOperation] = createSignal(false);

  let filterInput: HTMLInputElement | undefined;
  const started = new Set<string>();

  const narrow = () => worldWidth() < TWO_COLUMN_MIN;
  const analysis = () => source.unit(activeUnitId());
  const activeTab = () => tabs().find((tab) => tab.key === activeKey()) ?? null;

  /** Narrowed accessors, so a Match branch receives the tab rather than a boolean. */
  const codeTab = () => {
    const tab = activeTab();
    return tab && (tab.kind === "class" || tab.kind === "function") ? tab : null;
  };
  const stringsTab = () => (activeTab()?.kind === "strings" ? activeTab() : null);
  const symbolsTab = () => {
    const tab = activeTab();
    return tab && (tab.kind === "import" || tab.kind === "export") ? tab : null;
  };
  const metaTab = () => (activeTab()?.kind === "meta" ? activeTab() : null);

  const discovering = () =>
    scanning().phase === "reading-symbols" || scanning().phase === "discovering";
  const busy = () => discovering() || slowOperation();
  const overlayFraction = () => (discovering() ? scanning().fraction : null);

  const widthCeiling = () => Math.max(NAVIGATOR_MIN, Math.min(NAVIGATOR_MAX, worldWidth() - MAIN_MIN));
  const navigatorWidthNow = () =>
    narrow() ? navigatorWidth() : Math.min(navigatorWidth(), widthCeiling());

  function ensureScan(unitId: string): void {
    if (started.has(unitId)) return;
    started.add(unitId);

    void source
      .unit(unitId)
      .scan((state) => {
        setScanning(state);
        setRevision((value) => value + 1);
      })
      .then(() => {
        setRevision((value) => value + 1);
      })
      .catch(() => {
        /*
         * The adapter has already reported the failure through `onState`, with
         * the engine's own words. This exists so a rejected scan is a state the
         * interface shows rather than an unhandled rejection nobody sees, and it
         * only supplies a message when the engine did not: a generic sentence
         * that overwrites a specific one is worse than no sentence.
         */
        setScanning((current) =>
          current.phase === "failed" && current.message !== null
            ? current
            : {
                phase: "failed",
                fraction: null,
                discovered: 0,
                message: "The analysis stopped unexpectedly.",
              },
        );
        setRevision((value) => value + 1);
      });
  }

  ensureScan(source.primaryUnitId);

  onCleanup(() => {
    source.stop();
  });

  /* ------------------------------------------------------------ tabs */

  function unitTag(unitId: string): string {
    const unit = source.units.find((entry) => entry.id === unitId);
    return unit?.label ?? unitId;
  }

  /**
   * Opening something already open focuses it. A second method of the same class
   * moves the mark rather than adding a tab, because the class is the unit and a
   * method is a position inside it.
   */
  function openTab(tab: Tab): void {
    setTabs((current) => {
      const existing = current.find((entry) => entry.key === tab.key);
      if (!existing) return [...current, tab];
      return current.map((entry) =>
        entry.key === tab.key ? { ...entry, mark: tab.mark ?? entry.mark } : entry,
      );
    });
    setActiveKey(tab.key);
    if (tab.kind !== "class") setShowAssembly(false);
  }

  function closeTab(key: string): void {
    const current = tabs();
    const index = current.findIndex((entry) => entry.key === key);
    if (index === -1) return;

    const remaining = current.filter((entry) => entry.key !== key);
    setTabs(remaining);
    if (activeKey() === key) {
      // Fall to the right neighbour, or the left one when it was last.
      setActiveKey(remaining[index]?.key ?? remaining[index - 1]?.key ?? null);
    }
  }

  function classTab(unitId: string, classId: string, mark: string | null): Tab {
    const klass = analysis().classes().find((entry) => entry.id === classId);
    const simple = klass?.qualifiedName.split(".").at(-1) ?? classId;
    return {
      key: `class:${unitId}:${classId}`,
      label: simple,
      kind: "class",
      unitId,
      tag: "java",
      subject: classId,
      mark,
    };
  }

  function functionTab(unitId: string, functionId: string): Tab {
    const fn = analysis().functions().find((entry) => entry.id === functionId);
    return {
      key: `function:${unitId}:${functionId}`,
      label: fn?.name ?? functionId,
      kind: "function",
      unitId,
      tag: "native",
      subject: functionId,
      mark: null,
    };
  }

  /**
   * Opens the code for a function, in whichever container its language uses.
   *
   * One place decides this, so following a call site from the code and following
   * a string from the strings table cannot disagree about where a method lives.
   */
  function jumpToFunction(unitId: string, functionId: string): void {
    const unit = source.unit(unitId);
    const owning = unit.classes().find((entry) => entry.members.includes(functionId));
    openTab(
      owning === undefined
        ? functionTab(unitId, functionId)
        : classTab(unitId, owning.id, functionId),
    );
  }

  /**
   * Goes to the code that uses a string, when the engine can say.
   *
   * The first class the engine names is the one opened: a set of users is a search result,
   * and the tab model holds documents, so following all of them would open as many tabs as
   * the string has callers. A string nothing uses leaves the screen where it is - an empty
   * answer is an answer, and a jump to nowhere is not.
   */
  async function lookUpString(unitId: string, value: string): Promise<void> {
    const unit = source.unit(unitId);
    if (unit.findReferences === undefined) return;
    const users = await unit.findReferences(value).catch(() => []);
    const first = users.find((entry) => entry.classId !== null);
    // The engine's own member is marked when the class could place it, so the jump lands
    // on the use rather than at the top of the class that holds it.
    if (first?.classId != null) openTab(classTab(unitId, first.classId, first.functionId));
  }

  function unitTab(unitId: string, kind: "strings" | "import" | "export" | "meta"): Tab {
    const labels = { strings: "Strings", import: "Import", export: "Export", meta: "Meta" } as const;
    return {
      key: `${kind}:${unitId}`,
      label: labels[kind],
      kind,
      unitId,
      tag: unitTag(unitId),
      subject: null,
      mark: null,
    };
  }

  /** A navigator row is either something to expand, something to open, or both. */
  function activateNode(node: NavigatorNode): void {
    const unitId = activeUnitId();

    if (node.expandable) analysis().toggle(node.id);

    if (node.kind === "class" && node.classId) {
      openTab(classTab(unitId, node.classId, null));
    } else if (node.kind === "method" && node.classId && node.functionId) {
      openTab(classTab(unitId, node.classId, node.functionId));
    } else if (node.kind === "function" && node.functionId) {
      openTab(functionTab(unitId, node.functionId));
    }

    setRevision((value) => value + 1);
  }

  function selectUnit(unitId: string): void {
    setActiveUnitId(unitId);
    ensureScan(unitId);
  }

  /* --------------------------------------------------------- chrome */

  function commitWidth(width: number): void {
    const clamped = Math.min(NAVIGATOR_MAX, Math.max(NAVIGATOR_MIN, width));
    setNavigatorWidth(clamped);
    window.localStorage.setItem(WIDTH_STORAGE_KEY, String(clamped));
  }

  function beginDrag(event: PointerEvent & { currentTarget: HTMLElement }): void {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }

  function moveDrag(event: PointerEvent): void {
    if (!dragging()) return;
    setNavigatorWidth(Math.min(widthCeiling(), Math.max(NAVIGATOR_MIN, event.clientX)));
  }

  function endDrag(event: PointerEvent & { currentTarget: HTMLElement }): void {
    if (!dragging()) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
    commitWidth(navigatorWidth());
  }

  const onHandleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      commitWidth(navigatorWidth() - NAVIGATOR_STEP);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      commitWidth(navigatorWidth() + NAVIGATOR_STEP);
    }
  };

  const onWindowKeyDown = (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey)) return;

    if (event.key === "[") {
      event.preventDefault();
      props.onClose();
      return;
    }

    if (event.shiftKey && event.key.toLowerCase() === "c") {
      event.preventDefault();
      if (!supports(analysis(), "disassembly")) return;
      setShowAssembly((current) => !current);
      return;
    }

    if (event.shiftKey) return;

    if (event.key.toLowerCase() === "k") {
      event.preventDefault();
      setNavigatorPanelOpen(true);
      filterInput?.focus();
      filterInput?.select();
      return;
    }

    if (event.key.toLowerCase() === "w") {
      event.preventDefault();
      const current = activeKey();
      if (current) closeTab(current);
    }
  };

  window.addEventListener("keydown", onWindowKeyDown);
  onCleanup(() => {
    window.removeEventListener("keydown", onWindowKeyDown);
  });

  return (
    <>
      <TopBar
        onClose={props.onClose}
        fileName={props.file.name}
        narrow={narrow()}
        navigatorOpen={navigatorPanelOpen()}
        onToggleNavigator={() => setNavigatorPanelOpen((open) => !open)}
      />

      <main
        class="workspace-body"
        style={`--navigator-width: ${navigatorWidthNow()}px`}
        data-narrow={String(narrow())}
        data-navigator={navigatorPanelOpen() ? "open" : "closed"}
      >
        <ProgressBar active={busy()} fraction={overlayFraction()} />

        <Navigator
          analysis={analysis()}
          units={source.units.map((unit) => source.unit(unit.id))}
          activeUnitId={activeUnitId()}
          scanning={scanning()}
          revision={revision()}
          activeTabKey={activeKey()}
          highlightFunctionId={activeTab()?.mark ?? null}
          onSelectUnit={selectUnit}
          onActivateNode={activateNode}
          onOpenEntry={(entry) => openTab(unitTab(activeUnitId(), entry))}
          onStop={() => analysis().stop()}
          onFilterReady={(element) => {
            filterInput = element;
          }}
          handle={
            <button
              class="workspace-handle"
              type="button"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize navigator"
              aria-valuenow={navigatorWidthNow()}
              aria-valuemin={NAVIGATOR_MIN}
              aria-valuemax={NAVIGATOR_MAX}
              data-dragging={String(dragging())}
              onPointerDown={beginDrag}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onKeyDown={onHandleKeyDown}
              onDblClick={() => commitWidth(NAVIGATOR_DEFAULT)}
            />
          }
        />

        <section class="workspace-main" data-testid="workspace-main" data-tab={activeTab()?.kind ?? "none"}>
          <div class="workspace-strip">
            <ViewTabs
              tabs={tabs()}
              activeKey={activeKey()}
              onSelect={setActiveKey}
              onClose={closeTab}
            />
            <Show when={codeTab() && supports(source.unit(codeTab()!.unitId), "disassembly")}>
              <button
                class="code-mode is-control"
                type="button"
                data-testid="mode-label"
                aria-pressed={showAssembly() ? "true" : "false"}
                title={showAssembly() ? "Show decompiled C (⌘⇧C)" : "Show assembly (⌘⇧C)"}
                onClick={() => setShowAssembly((current) => !current)}
              >
                {showAssembly() ? "ASM" : "C"}
              </button>
            </Show>
          </div>

          {/* The box a view is centred in, separate from the strip above it. */}
          <div class="workspace-view" data-testid="workspace-view">
            <Switch>
            <Match when={codeTab()}>
              {(tab) => (
                <CodeView
                  analysis={source.unit(tab().unitId)}
                  tab={tab()}
                  revision={revision()}
                  assembly={showAssembly()}
                  busy={discovering()}
                  onSlowOperation={setSlowOperation}
                  onJumpToFunction={(functionId) => jumpToFunction(tab().unitId, functionId)}
                  onJumpToClass={(classId) => openTab(classTab(tab().unitId, classId, null))}
                />
              )}
            </Match>

            <Match when={stringsTab()}>
              {(tab) => (
                <StringsView
                  analysis={source.unit(tab().unitId)}
                  revision={revision()}
                  onJump={(functionId) => jumpToFunction(tab().unitId, functionId)}
                  onLookup={(value) => void lookUpString(tab().unitId, value)}
                />
              )}
            </Match>

            <Match when={symbolsTab()}>
              {(tab) => (
                <SymbolsView
                  analysis={source.unit(tab().unitId)}
                  kind={tab().kind === "export" ? "export" : "import"}
                />
              )}
            </Match>

            <Match when={metaTab()}>
              {(tab) => <MetaView analysis={source.unit(tab().unitId)} revision={revision()} />}
            </Match>

            <Match when={activeTab() === null}>
              <div class="workspace-empty" data-testid="no-tab">
                <p class="workspace-empty-label">No tab open</p>
                <p class="workspace-empty-hint">
                  Choose a class or a function on the left, or open strings, imports or the file readout.
                </p>
              </div>
            </Match>
            </Switch>
          </div>
        </section>

        <Show when={narrow() && navigatorPanelOpen()}>
          <button
            class="workspace-scrim"
            type="button"
            aria-label="Close navigator"
            onClick={() => setNavigatorPanelOpen(false)}
          />
        </Show>
      </main>
    </>
  );
}
