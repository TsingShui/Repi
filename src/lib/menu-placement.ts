/**
 * Where a dropdown opens, and how tall it may be.
 *
 * A menu anchored to a control near the bottom of the window has nowhere to go below it, and the
 * only thing worse than a menu that opens off-screen is one that opens and is cut in half. Which
 * side has room is a question about geometry, not about layout: the trigger's rect and the
 * viewport, both read at open time. The menu's height counts too — a short menu at the bottom of
 * a tall window is fine, the same menu with fifty models in it is not.
 *
 * Kept out of the components because it is the same question for every popover in the app, and
 * because the answer is easier to check on its own than through a rendered menu.
 */

/** Which side of the trigger the menu opens on, and the ceiling it must live within. */
export interface MenuPlacement {
  readonly direction: "up" | "down";
  /** The tallest the menu may be and still be fully visible. */
  readonly maxHeight: number;
}

export interface MenuPlacementOptions {
  /** Distance between the trigger and the menu. */
  readonly gap?: number;
  /** Distance to keep from the window's edge. */
  readonly margin?: number;
  /** Below this the menu is unusable, so it is allowed to overflow rather than be squashed. */
  readonly minHeight?: number;
  /**
   * The scrolling part of the menu, when the menu scrolls internally instead of as a whole.
   *
   * This is what keeps the measurement honest. A menu that has already been capped reports the
   * cap as its content — so a placement computed from the menu itself, re-run by a resize
   * observer, measures less room each time and shrinks the menu to a single row. The content
   * element's `scrollHeight` is the content's own height no matter how the box is squeezed, and
   * the difference between the two boxes is the chrome around it, which is fixed.
   */
  readonly content?: HTMLElement | null;
}

export function placeMenu(
  trigger: Element,
  menu: HTMLElement,
  options: MenuPlacementOptions = {},
): MenuPlacement {
  const gap = options.gap ?? 8;
  const margin = options.margin ?? 12;
  const minHeight = options.minHeight ?? 120;

  // The visual viewport is the one that shrinks when a phone keyboard opens; the layout viewport
  // would put the menu behind it.
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const rect = trigger.getBoundingClientRect();
  const content = options.content ?? null;
  const contentHeight =
    content === null
      ? menu.scrollHeight || menu.getBoundingClientRect().height
      : content.scrollHeight + Math.max(0, menu.offsetHeight - content.offsetHeight);

  const spaceBelow = viewportHeight - rect.bottom - gap - margin;
  const spaceAbove = rect.top - gap - margin;

  // Down when it fits or when it is the roomier side; up otherwise. A menu with more room above
  // than below opens up even if it does not fit there either — the ceiling below takes care of
  // the rest, and scrolling the last few pixels is better than a menu that cannot be seen.
  const fitsBelow = contentHeight <= spaceBelow;
  const direction: MenuPlacement["direction"] =
    fitsBelow || spaceBelow >= spaceAbove ? "down" : "up";

  const room = direction === "down" ? spaceBelow : spaceAbove;
  return {
    direction,
    maxHeight: Math.max(minHeight, Math.min(contentHeight, Math.round(room))),
  };
}

/**
 * Applies a placement to a menu element.
 *
 * Imperative rather than a reactive style object: the menu's height is also the ceiling its own
 * scroll area needs, and a property set here cannot be forgotten by a component that re-renders.
 */
export function applyMenuPlacement(menu: HTMLElement, placement: MenuPlacement): void {
  // Writing the same values again is not free: it is a layout change, which is an observer
  // callback, which is another measurement. The values are compared first so a settled menu
  // stops touching the DOM.
  const maxHeight = `${placement.maxHeight}px`;
  if (menu.dataset.placement === placement.direction && menu.style.getPropertyValue("--menu-max") === maxHeight) {
    return;
  }
  menu.dataset.placement = placement.direction;
  menu.style.setProperty("--menu-max", maxHeight);
}
