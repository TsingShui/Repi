import { createSignal, Match, onCleanup, Switch } from "solid-js";
import { createFinePointer } from "./lib/pointer";
import { detectFormat } from "./lib/detect-format";
import { AboutScreen } from "./features/about/about-screen";
import { ChatScreen, type ChatLine } from "./features/chat/chat-screen";
import "./app.css";

/**
 * The conversation is the home page and has no route of its own. About — which
 * carries the licence list — is reached from it, and is a hash route because the
 * deployment is a static host with no rewrite rules.
 */
function route(): "about" | null {
  if (typeof window === "undefined") return null;
  return window.location.hash.replace(/^#\/?/, "") === "about" ? "about" : null;
}

export function App() {
  const [page, setPage] = createSignal(route());
  const [lines, setLines] = createSignal<readonly ChatLine[]>([]);
  const [dragging, setDragging] = createSignal(false);
  const finePointer = createFinePointer();

  const onHashChange = () => setPage(route());
  window.addEventListener("hashchange", onHashChange);
  onCleanup(() => window.removeEventListener("hashchange", onHashChange));

  const append = (...added: readonly ChatLine[]) =>
    setLines((current) => [...current, ...added]);

  /*
   * Opening a file lives here rather than in a page, because three things open one:
   * the entry block on About, the attach control in the composer, and a drop, which
   * is accepted anywhere in the window. One entry point means the three cannot
   * drift apart in what they accept or in what they say.
   */
  async function accept(file: File | undefined) {
    if (!file) return;

    // Whatever surface it came from, it belongs in the conversation. Going there
    // first means the file card appears where the user is already looking.
    window.location.hash = "";

    try {
      const format = await detectFormat(file);
      append({
        kind: "file",
        name: file.name,
        size: file.size,
        format: format.label,
        detail: format.detail,
        engine: format.engine,
      });
    } catch {
      append({
        kind: "note",
        text: "The browser could not read this file. It may have been moved or removed.",
      });
    }
  }

  /*
   * Nothing answers yet, and the transcript says so once rather than leaving a send
   * that visibly does nothing. This line is the placeholder for an answer: it is
   * where a model's reply appears, with the sentence removed, and it is deliberately
   * not repeated after the first send.
   */
  let saidNothingAnswers = false;
  function send(text: string) {
    const added: ChatLine[] = [{ kind: "you", text }];
    if (!saidNothingAnswers) {
      saidNothingAnswers = true;
      added.push({
        kind: "note",
        text: "Nothing is connected to this conversation yet, so this message stayed on this device and nothing answered.",
      });
    }
    append(...added);
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
        <Match when={page() === "about"}>
          <AboutScreen onClose={() => (window.location.hash = "")} />
        </Match>
        <Match when={true}>
          <ChatScreen lines={lines()} onSend={send} onPick={(file) => void accept(file)} />
        </Match>
      </Switch>

      {/* Covers the whole screen, because the drop is accepted anywhere on it. */}
      <div class="drop-glow" data-active={dragging() ? "true" : "false"} aria-hidden="true" />
    </div>
  );
}
