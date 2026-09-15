/**
 * One tool call, in the transcript.
 *
 * The head says what was called and on what; the body is what came back. Both are visible by
 * default — a tool call hidden behind a summary is a tool call the user cannot check, and checking
 * is the point of watching an analysis rather than reading its conclusion. What is *not* shown by
 * default is the whole of a large answer: an engine listing is tens of kilobytes, and the first
 * part of it is what tells the reader whether the call was the right one.
 *
 * The expansion is per line and lives here rather than in the transcript because it is a property
 * of reading one output, not of the conversation.
 */
import { createSignal, Show } from "solid-js";
import { formatBytes } from "../../lib/detect-format";
import type { ChatLine } from "./types";

/** How much of an answer is shown before anyone asks for more. */
const PREVIEW_CHARACTERS = 700;

export function ToolLine(props: { readonly line: Extract<ChatLine, { kind: "tool" }> }) {
  const [expanded, setExpanded] = createSignal(false);
  const text = () => props.line.result ?? "";
  const long = () => text().length > PREVIEW_CHARACTERS;
  const shown = () => {
    if (expanded() || !long()) return text();
    // Cut on a line boundary when there is one nearby: half a line reads like a bug.
    const cut = text().lastIndexOf("\n", PREVIEW_CHARACTERS);
    return text().slice(0, cut > PREVIEW_CHARACTERS / 2 ? cut : PREVIEW_CHARACTERS);
  };

  return (
    <div class="tool-line" data-state={props.line.state}>
      <p class="tool-head">
        <span class="tool-name">{props.line.name}</span>
        <Show when={props.line.summary}>
          {(summary) => <span class="tool-summary">{summary()}</span>}
        </Show>
        <Show when={props.line.state === "running"}>
          <span class="tool-running" aria-label="Running" />
        </Show>
      </p>
      <Show when={props.line.state !== "running" && text() !== ""}>
        <div class="tool-output">
          <pre>{shown()}</pre>
          <Show when={long()}>
            <button class="tool-more" type="button" onClick={() => setExpanded((current) => !current)}>
              {expanded()
                ? "Show less"
                : `Show all ${formatBytes(props.line.bytes ?? text().length)}`}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
