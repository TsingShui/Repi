/**
 * Viewport width as a signal.
 *
 * The workspace decides what to show from the width it actually has, not from
 * the device orientation, because Stage Manager and Split View can hand it a
 * window far narrower than the screen.
 */

import { createSignal, onCleanup } from "solid-js";

export function createViewportWidth(): () => number {
  const [width, setWidth] = createSignal(window.innerWidth);

  const onResize = () => {
    setWidth(window.innerWidth);
  };

  window.addEventListener("resize", onResize);
  onCleanup(() => {
    window.removeEventListener("resize", onResize);
  });

  return width;
}
