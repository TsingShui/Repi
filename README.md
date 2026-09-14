# Repi

The browser-local Repi application. It runs Kuna and Rasc as WebAssembly inside
a dedicated worker so that a user's binary, and every artifact derived from it,
never leaves the device.

This repository is the application. The Pi package that shares the name — the
toolchain catalog and the commands that check it — lives separately at
[`TsingShui/pi-re`](https://github.com/TsingShui/pi-re), and nothing here is
installed by `pi install`. The path name this application used to live under,
`edge-compute/`, named the idea and not the product; it was replaced by **Repi**
everywhere a user can see it.

## Stack

| Concern | Choice |
| --- | --- |
| UI | Solid 2 (`2.0.0-rc.8`), client-rendered only |
| Build | Vite 8 with `vite-plugin-solid` |
| Language | TypeScript, `strict` |
| Styling | Plain CSS with custom-property tokens, light theme first |
| Routing | None yet; the single screen is mounted by `src/app.tsx` |

Everything is pinned in `package-lock.json`, and this is the repository's only
manifest. The Pi package that shares the name is a separate repository, so web
tooling never enters the `pi install` path.

## Local development

```bash
npm install
npm run dev
```

Vite serves on <http://127.0.0.1:5173>.

## Build

```bash
npm run build
```

`npm run build` type-checks with `tsc --noEmit` before bundling. The static site
is written to `dist/` and is never committed.

```bash
npm run preview
```

serves the built output on <http://127.0.0.1:4173>.

## Checks

`npm run check:analysis` verifies the analysis adapter without a browser. It
bundles the checks with Vite and runs them under Node, and covers the paths that
are awkward to reach by hand: progressive discovery, abort keeping partial
results, a stripped binary, a class tree, and a list of 120,000. It also covers
the parts of the Rasc adapter that do not need a Worker — the streaming SHA-256
the readout prints, and the ZIP directory read that says APK rather than ZIP when
the first bytes cannot — because their failure mode is a plausible answer rather
than a crash.

`npm run verify` starts the built site, runs the smoke check against it, and stops
it again. That is the one command to use:

```bash
npm run verify
```

`npm run smoke` is the check on its own, for pointing at a server you already
have — a preview in another terminal, or a deployed build. It does not start one,
and it says so clearly when nothing is listening:

```bash
npm run preview          # terminal one
npm run smoke            # terminal two
REPI_SMOKE_URL=https://tsingshui.github.io/Repi/ npm run smoke
```

Set `CHROME_PATH` when Chrome is not at the macOS default. The check also fails
if the page issues any cross-origin request, which protects the core promise
that a binary is never uploaded.

## Layout

```text
src/
  main.tsx                     mount point
  app.tsx                      application shell; home or workspace
  app.css
  styles/global.css            design tokens and reset
  components/brand-mark.tsx
  lib/detect-format.ts         local format detection, header plus ZIP directory
  lib/highlight.ts             C, Java and assembly tokenisers for the code view
  lib/sha256.ts                streaming digest, so a large file is never held
  lib/viewport.ts              measured width, not orientation
  lib/analysis/types.ts        the adapter the workspace talks to
  lib/analysis/mock-source.ts  deterministic stand-in for a real engine
  lib/analysis/mock-fixtures.ts
  lib/analysis/random.ts
  lib/analysis/kuna/           the native engine: Worker, WASI shim, adapter
  lib/analysis/rasc/           the APK/DEX engine: Worker, host glue, adapter
    driver.ts                  the Worker and the command protocol
    worker.ts                  byte ranges from a Blob, one run at a time
  features/home/               home screen and the file selection flow
  features/home/structure-field.tsx  full-screen canvas backdrop
  features/workspace/          the screen that opens after a file is accepted
    workspace.tsx              layout, state machine, shortcuts
    top-bar.tsx  view-tabs.tsx
    navigator.tsx  source-switcher.tsx  virtual-list.tsx
    progress-bar.tsx
    views/code-view.tsx  views/strings-view.tsx  views/meta-view.tsx
```

## Current scope

Implemented:

- the home screen;
- opening a file through the platform picker or a drop;
- local format detection for ELF, PE, Mach-O, APK, DEX and plain ZIP, with the
  ZIP's central directory read when the header alone cannot tell an APK from an
  archive;
- honest reporting when no engine handles a container yet;
- a full-screen canvas backdrop that depicts an address space being read, and
  pulses once per accepted file.

The workspace:

- one top bar over a navigator and a single main area, no rail;
- a tab per thing you opened: a class for a Java unit and a function for a native
  one, plus that unit's strings, imports, exports and file readout — the ones the
  engine behind the unit can actually answer. Everything closes, reopening
  focuses, and the strip carries each unit as a tag so two `STRINGS` tabs cannot
  be confused;
- a Java class rendered as one document: its fields and imports above the methods,
  each method with its own header, and call sites linked through their receiver —
  the parts and their line ranges come from the engine, not from a scan of the
  source;
- a left column that expands only what fits in it — the class tree, and the
  import and export lists, which open their tab on the same click. Strings and
  the readout are single entries;
- a navigator that lists analysis units (DEX once, each native library
  separately), filters, and virtualises, so 120,000 functions render about thirty
  rows;
- decompiled C and assembly, with local syntax highlighting and an assembly
  toggle reachable without a keyboard;
- a strings table with its own filter — for a Java unit the filter is a query the
  engine answers, because the archive's table is 69 MB on the biggest corpus and is
  never held; the jump back to the code that uses a string is left out until a
  cross-reference is asked for, because the engine reports the table and not who uses
  each entry;
- a META page carrying the format facts and the sections — for an APK, the
  archive's entries with their offsets — with imports and exports as their own tabs;
- discovery that reports as it goes, is abortable, and keeps what it found — a Java
  unit's fraction is the engine's own entry walk, one step per DEX file, never an
  estimate;
- one overlay progress indicator for every stage.

Native binaries are analysed by the **real Kuna decompiler**, compiled to
`wasm32-wasip1` and run in a module Worker under a JavaScript WASI shim. Nothing
is uploaded; the binary lives in an in-memory virtual filesystem for the length of
the session.

APK and DEX files are analysed by the **real Rasc decompiler**, compiled to
`wasm32-unknown-unknown` and run in a second module Worker. It has no filesystem
either: it asks its host for the byte ranges it needs, synchronously, and the
Worker answers them from the user's `File` through `FileReaderSync` — windowed,
because a raw `Blob` read costs a real round trip. A bare `.dex` needs no
packaging: the engine accepts one as the single entry it would have been inside an
archive. Nothing is uploaded here either.

What Rasc can answer is smaller than Kuna's surface: it lists the classes an
archive defines, decompiles one of them, lists the archive's entries, counts its
strings and searches them, and declares nothing else. The workspace hides the imports, exports
and disassembly a Java unit cannot answer rather than drawing tables that would read
as facts about the archive.

The workspace is handed whichever engine suits the file, so it does not know
either engine exists. The mock in `src/lib/analysis/` serves every format no real
engine claims and is what keeps every interaction exercisable without an engine
installed.

### Licenses

`/#/licenses` lists what Repi is built on and under which terms, grouped by where
each project ends up: downloaded with the engine, in the page, or only used to
build it. It is reachable from the home screen and needs no engine installed.

### Building the engine

Both engines are separate repositories, so their artifacts come from checkouts:

```bash
npm run build:kuna                              # reads ~/zhome/kuna
KUNA_REPO=/path/to/kuna npm run build:kuna      # or say where it is

npm run build:rasc                              # reads ~/rasc
RASC_REPO=/path/to/rasc npm run build:rasc      # or say where it is
```

`build:kuna` builds the wasm, copies the SLEIGH runtime tree and the preload
bundle into a gitignored `public/kuna/` (about 25 MB), and refreshes the committed
harness in `src/vendor/kuna/`. Without it the application still builds and still
runs, and a native binary is refused in one line instead of being quietly handed
to the mock.

`build:rasc` builds the wasm and refreshes both the served module and the vendored
host glue. Its 1.7 MB output goes to a gitignored `public/rasc/`, the same
arrangement as Kuna's: a clone decompiles an APK once that script has run, and the
deployed page does because the deploy workflow builds the module before it builds
the page.

Still absent: an APK's native libraries as their own units, portrait, side-by-side
comparison, local project storage, and the Agent surface.

The workspace's specified behaviour, including what it deliberately leaves out, is
in [the decompile workspace design](./docs/repi-decompile-design.md).

## Notes on the backdrop

`structure-field.tsx` is decoration with a budget:

- it renders at 30 fps and pauses while the tab is hidden;
- it draws a single static frame and never starts a loop when the visitor sets
  `prefers-reduced-motion: reduce`;
- the canvas is capped at device pixel ratio 2, which bounds the memory it holds
  on a 12.9-inch iPad to roughly 45 MB across the visible surface and its
  offscreen texture;
- it ignores pointer events entirely.
