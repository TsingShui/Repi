import { createSignal, Match, onCleanup, Switch } from "solid-js";
import { createFinePointer } from "./lib/pointer";
import { detectFormat, type FormatMatch } from "./lib/detect-format";
import { chooseSource } from "./lib/analysis/choose-source";
import type { AnalysisSource } from "./lib/analysis/types";
import { HomeScreen } from "./features/home/home-screen";
import { LicensesScreen } from "./features/licenses/licenses-screen";
import { Workspace } from "./features/workspace/workspace";
import "./app.css";

/**
 * The licences page is a hash route rather than a mode of the workspace.
 *
 * It has nothing to do with a file, it is reached from the home screen, and it
 * has to be readable before any engine is installed — which is when the licence
 * question is most likely to be asked. A hash keeps it working on a static host
 * with no rewrite rules.
 */
function route(): "licenses" | null {
  if (typeof window === "undefined") return null;
  return window.location.hash === "#/licenses" ? "licenses" : null;
}

interface Session {
  readonly file: File;
  readonly format: FormatMatch;
  /**
   * Chosen before the workspace mounts, so the workspace always has an engine and
   * never has to render a half-built state. A file this build cannot analyse does
   * not open a workspace at all.
   */
  readonly source: AnalysisSource;
}

export function App() {
  const [session, setSession] = createSignal<Session | null>(null);
  const [page, setPage] = createSignal(route());

  const onHashChange = () => setPage(route());
  window.addEventListener("hashchange", onHashChange);
  onCleanup(() => window.removeEventListener("hashchange", onHashChange));
  const [dragging, setDragging] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [notice, setNotice] = createSignal<string | null>(null);
  const finePointer = createFinePointer();

  /*
   * Opening a file lives here rather than in the home screen because two things
   * open files — the picker and the drop — and a drop is accepted anywhere in the
   * application, including over the workspace. Keeping one entry point means the
   * two paths cannot drift apart in what they accept or what they say when they
   * refuse.
   */
  async function accept(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setNotice(null);

    try {
      const format = await detectFormat(file);

      if (format.engine !== null) {
        const chosen = await chooseSource(file, format);
        if (chosen.source === null) {
          // Recognised, but this deployment has no engine for it. That is a
          // refusal like any other, and it is said out loud rather than dressed
          // up as a result.
          setNotice(chosen.unavailable);
          return;
        }
        setSession({ file, format, source: chosen.source });
        return;
      }

      /*
       * Only the files that cannot be opened produce a message. A recognised file
       * goes straight to the workspace: the readout that used to sit here was the
       * workspace's opening screen shown one step early, and it made opening a
       * file feel like a two-stage process.
       */
      setNotice(`No Repi engine handles ${format.label} yet. Native archives such as JAR, AAR and plain ZIP are not in this build.`);
    } catch {
      setNotice("The browser could not read this file. It may have been moved or removed.");
    } finally {
      setBusy(false);
    }
  }

  // Depth counter, because dragenter fires again for every child the pointer
  // crosses; the leaves only balance out if they are counted.
  let dragDepth = 0;
  const isFileDrag = (event: DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes("Files");

  const onDragEnter = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepth += 1;
    setDragging(true);
  };

  const onDragOver = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    // Without this the browser refuses the drop and navigates to the file instead.
    event.preventDefault();
  };

  const onDragLeave = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDragging(false);
  };

  const onDrop = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepth = 0;
    setDragging(false);
    void accept(event.dataTransfer?.files?.[0]);
  };

  // The component body is the setup: Solid 2 has no `onMount`.
  window.addEventListener("dragenter", onDragEnter);
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("dragleave", onDragLeave);
  window.addEventListener("drop", onDrop);

  onCleanup(() => {
    window.removeEventListener("dragenter", onDragEnter);
    window.removeEventListener("dragover", onDragOver);
    window.removeEventListener("dragleave", onDragLeave);
    window.removeEventListener("drop", onDrop);
  });

  return (
    <div
      class="app"
      data-surface={session() ? "workspace" : "home"}
      data-pointer={finePointer() ? "fine" : "coarse"}
    >
      {/*
        Three surfaces, one of which is showing. `Switch` rather than nested
        `Show`s because nesting makes the truthiness of one condition narrow the
        other, and the page and the session are unrelated facts.
      */}
      <Switch>
        <Match when={page() === "licenses"}>
          <LicensesScreen onClose={() => (window.location.hash = "")} />
        </Match>
        <Match when={session()}>
          {(current) => (
            <Workspace
              file={current().file}
              format={current().format}
              source={current().source}
              onClose={() => setSession(null)}
            />
          )}
        </Match>
        <Match when={true}>
          <HomeScreen
            busy={busy()}
            notice={notice()}
            dropActive={dragging()}
            onPick={(file) => void accept(file)}
          />
        </Match>
      </Switch>

      {/* Covers the whole screen, including the top bar, because the drop is accepted there too. */}
      <div class="drop-glow" data-active={dragging() ? "true" : "false"} aria-hidden="true" />
    </div>
  );
}
