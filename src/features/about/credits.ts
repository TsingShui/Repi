/**
 * What Repi redistributes, in the order it matters: the application, the engines whose
 * binaries ship with it, then the project one of them was rewritten from.
 *
 * It is flat on purpose. The list was grouped by where each project ends up — in the
 * page, beside a file, used to build it — and the grouping was doing the work of an
 * argument the reader was not having: five rows do not need a taxonomy, and the two
 * headings that survived explained the difference between "shipped" and "was forked
 * from" to somebody who only wanted to know what they were receiving.
 *
 * Libraries inside the bundle and tools that only ran while building it are not here:
 * they are package dependencies, and this is what a user receives.
 *
 * **The licence text is not reproduced here.** Apache-2.0 requires that a
 * recipient gets a copy of the licence, and they do: `npm run build:kuna` and
 * `npm run build:rasc` copy each engine's `LICENSE` and `NOTICE` into the served
 * directory beside its module, so the copy travels with the artifact that needs
 * it. Repeating four licences on this page would be four more copies to keep in
 * sync, and none of them would be the one the redistributed binary actually
 * carries.
 */

export interface Credit {
  readonly name: string;
  readonly license: string;
  readonly url: string;
  readonly note: string;
  /**
   * The project this one was written from, when that is part of what it is. It is a
   * link rather than a row of its own: a fork is not something the reader receives,
   * and a second name with a second licence column for it made the list look like
   * five shipped things when it is four.
   */
  readonly derivedFrom?: { readonly name: string; readonly url: string };
}

/** Repi's own licence. Apache-2.0, the same one every engine behind it uses. */
export const PROJECT = {
  name: "Repi",
  license: "Apache-2.0",
  url: "https://github.com/TsingShui/Repi",
};

export const CREDITS: readonly Credit[] = [
  {
    name: "Kuna",
    license: "Apache-2.0",
    url: "https://github.com/Noelo-Lab/kuna",
    note: "The native decompiler: functions, code and symbols out of an ELF, PE or Mach-O binary.",
  },
  {
    name: "Rasc",
    license: "Apache-2.0",
    url: "https://github.com/TsingShui/rasc",
    note: "The Android engine: classes, methods and code out of an APK or a DEX file.",
    derivedFrom: { name: "ASC", url: "https://github.com/MG1937/ASC" },
  },
  {
    name: "Pi Agent",
    license: "MIT",
    url: "https://github.com/earendil-works/pi",
    note: "The agent layer this application is being built on: the loop that runs tool calls and keeps their state, and the client that speaks to a model provider. Nothing is wired to it yet.",
  },
];
