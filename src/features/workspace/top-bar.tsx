import { Show } from "solid-js";
import { BrandMark } from "../../components/brand-mark";

export interface TopBarProps {
  /** Returns to the home screen. The brand mark is the control. */
  readonly onClose: () => void;
  readonly fileName: string;
  readonly narrow: boolean;
  readonly navigatorOpen: boolean;
  readonly onToggleNavigator: () => void;
}

/**
 * One row, and almost nothing in it: the mark, the product name, and which file
 * is open.
 *
 * The privacy badge and the `⋯` menu used to be on the right. The badge said
 * something the smoke check proves on every run — the page issues no cross-origin
 * request — and a claim repeated on screen is not the same as one that holds. The
 * menu held the assembly toggle, which has moved to the code header where the
 * mode is shown, so it is still reachable without a keyboard.
 *
 * It used to carry the tab strip, and the tabs were the reason it existed. They
 * belong with the content they switch — a strip in the application bar is a
 * second navigation for the same thing, and the file name, which is what this
 * row can say and nothing else can, had no room.
 *
 * The mark is the way back. A separate `←` next to a mark that also means "home"
 * was two controls for one intention, and the mark is the one people press.
 */
export function TopBar(props: TopBarProps) {
  return (
    <header class="workspace-top">
      <button class="workspace-back" type="button" onClick={props.onClose} aria-label="Back to home">
        <BrandMark />
      </button>

      <span class="workspace-brand">Repi</span>
      <span class="workspace-sep" aria-hidden="true">
        |
      </span>
      {/* The engine's own name for the binary would be "input.bin"; this is the user's. */}
      <span class="workspace-file" title={props.fileName} data-testid="workspace-file">
        {props.fileName}
      </span>

      <span class="workspace-top-spacer" />

      <Show when={props.narrow}>
        <button
          class="workspace-pane-toggle"
          type="button"
          aria-expanded={props.navigatorOpen ? "true" : "false"}
          onClick={props.onToggleNavigator}
        >
          {props.navigatorOpen ? "Hide list" : "Show list"}
        </button>
      </Show>
    </header>
  );
}
