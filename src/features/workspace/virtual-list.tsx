import { createMemo, createSignal, For, onCleanup } from "solid-js";
import type { JSX } from "@solidjs/web";

export interface VirtualListProps {
  readonly count: number;
  /** Fallback only. The live value is read from the `--row-h` token so the
   *  density can follow the pointer without the caller knowing the number. */
  readonly rowHeight: number;
  readonly overscan: number;
  readonly label: string;
  /** Identifies the keyboard cursor. Selection is the caller's concern. */
  readonly cursorIndex: () => number;
  readonly onCursor: (index: number) => void;
  readonly onActivate: (index: number) => void;
  readonly renderRow: (index: number) => JSX.Element;
}

/**
 * A windowed list.
 *
 * Only the visible rows plus a small overscan are rendered, so a binary with
 * hundreds of thousands of functions costs the same as one with fifty. Rows are
 * produced by the caller and read straight from the analysis source; none of
 * that content passes through a signal.
 */
export function VirtualList(props: VirtualListProps) {
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(0);
  const [rowHeight, setRowHeight] = createSignal(props.rowHeight);

  let container: HTMLDivElement | undefined;
  let observer: ResizeObserver | undefined;
  let pointerQuery: MediaQueryList | undefined;

  /** The density token is the single source of truth; this reads it back. */
  function measureRowHeight(): void {
    if (!container) return;
    const value = Number.parseFloat(getComputedStyle(container).getPropertyValue("--row-h"));
    if (Number.isFinite(value) && value > 0) setRowHeight(value);
  }

  onCleanup(() => {
    observer?.disconnect();
    pointerQuery?.removeEventListener("change", measureRowHeight);
  });

  const first = createMemo(() =>
    Math.max(0, Math.floor(scrollTop() / rowHeight()) - props.overscan),
  );

  const visibleCount = createMemo(() =>
    Math.ceil(viewportHeight() / rowHeight()) + props.overscan * 2 + 1,
  );

  const indices = createMemo(() => {
    const start = first();
    const end = Math.min(props.count, start + visibleCount());
    const result: number[] = [];
    for (let index = start; index < end; index += 1) result.push(index);
    return result;
  });

  function attach(element: HTMLDivElement): void {
    container = element;
    setViewportHeight(element.clientHeight);
    observer = new ResizeObserver(() => {
      setViewportHeight(element.clientHeight);
      measureRowHeight();
    });
    observer.observe(element);
    // A trackpad being connected can change the density without a resize.
    pointerQuery = window.matchMedia("(pointer: fine)");
    pointerQuery.addEventListener("change", measureRowHeight);
    measureRowHeight();
  }

  function scrollIndexIntoView(index: number): void {
    const top = index * rowHeight();
    const bottom = top + rowHeight();
    const viewTop = scrollTop();
    const viewBottom = viewTop + viewportHeight();

    if (top < viewTop) setScrollTop(top);
    else if (bottom > viewBottom) setScrollTop(bottom - viewportHeight());
  }

  function onKeyDown(event: KeyboardEvent): void {
    const cursor = props.cursorIndex();
    const page = Math.max(1, Math.floor(viewportHeight() / rowHeight()));
    let next: number;

    switch (event.key) {
      case "ArrowDown":
        next = Math.min(props.count - 1, cursor + 1);
        break;
      case "ArrowUp":
        next = Math.max(0, cursor - 1);
        break;
      case "PageDown":
        next = Math.min(props.count - 1, cursor + page);
        break;
      case "PageUp":
        next = Math.max(0, cursor - page);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = props.count - 1;
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (cursor >= 0 && cursor < props.count) props.onActivate(cursor);
        return;
      default:
        return;
    }

    event.preventDefault();
    if (next < 0 || props.count === 0) return;
    props.onCursor(next);
    scrollIndexIntoView(next);
  }

  return (
    <div
      class="virtual-list"
      role="listbox"
      aria-label={props.label}
      tabindex={0}
      ref={attach}
      onKeyDown={onKeyDown}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div class="virtual-list-sizer" style={{ height: `${props.count * rowHeight()}px` }}>
        <div class="virtual-list-window" style={{ transform: `translateY(${first() * rowHeight()}px)` }}>
          {/*
            The height lives on the wrapper, so a row never has to know the
            density and cannot disagree with the offsets.
          */}
          <For each={indices()}>
            {(index) => (
              <div class="virtual-row" style={{ height: `${rowHeight()}px` }}>
                {props.renderRow(index)}
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
