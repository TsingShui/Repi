/** One compact activity row. The agent's answer, not the transcript, explains tool output. */
import { Show } from "solid-js";
import type { ChatLine } from "./types";

export function ToolLine(props: { readonly line: Extract<ChatLine, { kind: "tool" }> }) {
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
    </div>
  );
}
