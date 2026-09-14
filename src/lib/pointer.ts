/**
 * Whether a precise pointer is available.
 *
 * The workspace keeps a touch-safe density unless this is true, so the decision
 * has one home rather than being spread across media queries. It is a plain
 * signal rather than CSS because the virtualised lists need the same answer to
 * compute offsets, and because a coarse pointer cannot be emulated for testing —
 * an attribute can.
 *
 * If the media query never matches, the answer stays `false` and the workspace is
 * simply less dense. That is the safe direction to fail in.
 */
import { createSignal, onCleanup } from "solid-js";

const QUERY = "(pointer: fine)";

export function createFinePointer(): () => boolean {
  const query = window.matchMedia(QUERY);
  const [fine, setFine] = createSignal(query.matches);

  const onChange = (event: MediaQueryListEvent) => {
    setFine(event.matches);
  };

  query.addEventListener("change", onChange);
  onCleanup(() => {
    query.removeEventListener("change", onChange);
  });

  return fine;
}
