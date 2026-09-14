import { createSignal, Match, onCleanup, Switch } from "solid-js";
import { createFinePointer } from "./lib/pointer";
import { detectFormat } from "./lib/detect-format";
import { HomeScreen } from "./features/home/home-screen";
import { LicensesScreen } from "./features/licenses/licenses-screen";
import "./app.css";

/**
 * The licences page is a hash route rather than a mode of the home page.
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

export function App() {
  const [page, setPage] = createSignal(route());
  const [dragging, setDragging] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [notice, setNotice] = createSignal<string | null>(null);
  const finePointer = createFinePointer();

  const onHashChange = () => setPage(route());
  window.addEventListener("hashchange", onHashChange);
  onCleanup(() => window.removeEventListener("hashchange", onHashChange));

  /*
   * Opening a file lives here rather than in the home page because two things open
   * files — the picker and the drop — and a drop is accepted anywhere in the
   * application. One entry point means the two paths cannot drift apart in what
   * they accept or in what they say.
   *
   * What it does with the file is nothing yet, and that is the current state
   * rather than a decision: the surface that reads a binary is the Agent surface.
   * What is left here is the format answer, because a drop that reports nothing at
   * all reads as a broken drop.
   */
  async function accept(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setNotice(null);

    try {
      const format = await detectFormat(file);
      setNotice(`${format.label} recognised. Nothing reads it yet — the Agent surface is not built.`);
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
    <div class="app" data-pointer={finePointer() ? "fine" : "coarse"}>
      <Switch>
        <Match when={page() === "licenses"}>
          <LicensesScreen onClose={() => (window.location.hash = "")} />
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
