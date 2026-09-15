/**
 * What the model thought, in the transcript.
 *
 * Shown by default and short: a reasoning model's thinking is the part that says *why* an answer
 * went the way it did, and hiding it entirely leaves the user watching a slow answer appear with
 * no way to tell whether the question was even understood. What it is not is the main event — the
 * answer is — so the first few lines are what shows, and the rest is one click away.
 *
 * The preview is the beginning rather than the end: the opening of a reasoning trace is where the
 * problem is restated, which is what a reader is checking for at a glance.
 */
import { createSignal, Show } from "solid-js";

/** How much shows before anyone asks for more. */
const PREVIEW_CHARACTERS = 280;

export function ThinkingBlock(props: { readonly text: string; readonly streaming?: boolean }) {
  const [expanded, setExpanded] = createSignal(false);
  const long = () => props.text.length > PREVIEW_CHARACTERS;
  const shown = () => (expanded() || !long() ? props.text : props.text.slice(0, PREVIEW_CHARACTERS));

  return (
    <div class="thinking-block" data-streaming={props.streaming ? "true" : "false"}>
      <button
        class="thinking-head"
        type="button"
        aria-expanded={expanded() ? "true" : "false"}
        onClick={() => setExpanded((current) => !current)}
      >
        <span class="thinking-label">{props.streaming ? "Thinking" : "Thought process"}</span>
        <Show when={long()}>
          <span class="thinking-toggle">{expanded() ? "Show less" : "Show all"}</span>
        </Show>
      </button>
      <p class="thinking-text">
        {shown()}
        <Show when={!expanded() && long()}>
          <span class="thinking-ellipsis"> …</span>
        </Show>
      </p>
    </div>
  );
}
