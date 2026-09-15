/**
 * The file menu that opens when someone types `@`.
 *
 * It is a menu with one job — say which file — so it shows the name, what the file is, and the
 * path, in that order of usefulness. The filter is the text after the `@`, which means the list
 * narrows under the caret as the user keeps typing and the caret never has to leave the message.
 */
import { For, Show } from "solid-js";
import { formatBytes } from "../../lib/detect-format";
import type { MentionTarget } from "./mentions";
import "./mention-menu.css";

export interface MentionMenuProps {
  readonly targets: readonly MentionTarget[];
  readonly active: number;
  readonly onPick: (target: MentionTarget) => void;
  readonly onHover: (index: number) => void;
}

/** What a file is, in the two words a list row can afford. */
function kindLabel(target: MentionTarget): string {
  return target.kind === "attachment" ? "attached" : "in the sandbox";
}

export function MentionMenu(props: MentionMenuProps) {
  return (
    <div class="mention-menu" role="listbox" aria-label="Reference a file">
      <Show
        when={props.targets.length > 0}
        fallback={<p class="mention-empty">Nothing here matches that name.</p>}
      >
        <For each={props.targets}>
          {(target, index) => (
            <button
              class="mention-option"
              type="button"
              role="option"
              aria-selected={props.active === index() ? "true" : "false"}
              data-active={props.active === index() ? "true" : "false"}
              // Pointer events would otherwise move the focus out of the textarea before the
              // click lands, and the caret is where the insertion happens.
              onPointerDown={(event) => event.preventDefault()}
              onPointerEnter={() => props.onHover(index())}
              onClick={() => props.onPick(target)}
            >
              <span class="mention-option-name">{target.name}</span>
              <span class="mention-option-meta">
                {kindLabel(target)} · {formatBytes(target.bytes)}
              </span>
            </button>
          )}
        </For>
      </Show>
    </div>
  );
}
