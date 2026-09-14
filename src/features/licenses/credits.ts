/**
 * What Repi is built on.
 *
 * Two rules keep this list honest.
 *
 * **Scope is stated.** Something that ships inside the page is a different claim
 * from something that only ran on the author's machine while building it, and a
 * reader checking a licence needs to know which one they are looking at.
 *
 * **The licence text is not reproduced here.** Apache-2.0 requires that a
 * recipient gets a copy of the licence, and they do: `npm run build:kuna` copies
 * Kuna's `LICENSE` and `NOTICE` into the served directory, so the copy travels
 * with the artifact that needs it. Repeating four licences on this page would be
 * four more copies to keep in sync, and none of them would be the one the
 * redistributed binary actually carries.
 */

/** Where a project ends up, which is the part a licence question turns on. */
export type CreditScope = "engine" | "upstream" | "page" | "build";

export interface Credit {
  readonly name: string;
  readonly license: string;
  readonly url: string;
  readonly scope: CreditScope;
  readonly note: string;
}

export const SCOPE_LABELS: Record<CreditScope, string> = {
  engine: "Downloaded when you open a file they handle",
  upstream: "The engine Rasc was rewritten from",
  page: "In this page",
  build: "Used to build it",
};

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
    scope: "engine",
    note: "The native decompiler. Compiled to WebAssembly and run in a worker, on this device, with nothing uploaded.",
  },
  {
    name: "Ghidra",
    license: "Apache-2.0",
    url: "https://github.com/NationalSecurityAgency/ghidra",
    scope: "engine",
    note: "The processor specifications Kuna reads, and the C++ decompiler it is a Rust port of.",
  },
  {
    name: "Rasc",
    license: "Apache-2.0",
    url: "https://github.com/TsingShui/rasc",
    scope: "engine",
    note: "The DEX and Android engine: a native Rust rewrite of ASC, compiled to WebAssembly. It answers an APK or a DEX file, and the class tree those screens show is its.",
  },
  {
    name: "ASC",
    license: "Apache-2.0",
    url: "https://github.com/MG1937/ASC",
    scope: "upstream",
    note: "The Android decompiler Rasc is a rewrite of, and the behaviour it is measured against. Nothing here loads it; it is where the DEX side came from.",
  },
  {
    name: "@bjorn3/browser_wasi_shim",
    license: "MIT OR Apache-2.0",
    url: "https://github.com/bjorn3/browser_wasi_shim",
    scope: "page",
    note: "A WASI implementation in JavaScript. It gives the engine a filesystem that exists only in memory.",
  },
  {
    name: "SolidJS",
    license: "MIT",
    url: "https://github.com/solidjs/solid",
    scope: "page",
    note: "The user interface, including the virtualised list and the tab strip.",
  },
  {
    name: "Vite",
    license: "MIT",
    url: "https://github.com/vitejs/vite",
    scope: "build",
    note: "The dev server, and the bundler that produces what is served here.",
  },
  {
    name: "TypeScript",
    license: "Apache-2.0",
    url: "https://github.com/microsoft/TypeScript",
    scope: "build",
    note: "Types, and the checker that refuses to build when they are wrong.",
  },
];
