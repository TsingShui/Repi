# Repi browser application design

> Status: accepted direction. The home screen and the analysis workspace ship in
> this repository, a pinned Solid 2 project of its own. Native binaries are
> analysed by the real Kuna engine and APK/DEX files by the real Rasc engine, both
> compiled to WebAssembly and run in Workers of their own; local project storage
> and the Agent surface are not implemented yet.

### Two halves, two repositories

Repi is two things that are installed separately, and the interface says so
rather than pretending they are one.

- **The Pi package.** `pi install https://github.com/TsingShui/pi-re` adds a
  toolchain catalog and the commands that check it. It runs in an agent, on the
  machine, next to the tools it describes.
- **The workspace.** This repository is the browser application documented in
  [`repi-decompile-design.md`](./repi-decompile-design.md), which opens a binary
  and reads it locally.

The two shared one repository while the application was being built, and were split
when the names were settled: the application is Repi, the package is `pi-re`.

The home screen shows the two ways a file gets in as two halves of a single
control — no gap, one outline, an internal seam — in the accent and in a tint of
it: opening the picker, and carrying a file over the window. Two separate
buttons with a gap between them said "two things"; joined, they say what they
are, which is one outcome through two gestures. The halves are not the same
width — each takes the width its label needs, so the pair is asymmetric and
small. Equal halves had to be sized to the longer label, which left the shorter
one as a block of empty colour, and the whole control grew into a band across
the page. The second is a second tone rather than a
greyed-out control, because it is a way in and not a disabled state, and it
lights up while a file is over the window. It also opens the picker when
tapped: you cannot tap to drag, and a block that looks like a button and
answers nothing is worse than one that does the obvious thing.

Below that, the install command with a copy control, under a
hairline: one line saying what it is for, the command in a bordered box at
reading size, and a copy button. It is set apart from opening a file, but it is
not set as a footnote — the first version was 10px mono and read as small print
nobody follows. Nothing on this page should be smaller than the text around it
for the sake of looking quiet.

## Product naming

The repository and the product are both **Repi**. The application used to be named
for the idea behind it: it lived under a path called `edge-compute/`, which said
"analysis in the browser, at the edge" and never named the product. That name was
replaced when the application was given the product's own name in the repository,
the package and the interface, and the two halves became two repositories.

## Summary

Repi is a tablet-first reverse-engineering application that runs analysis inside
the browser. Its first release prioritizes useful Kuna and Rasc workflows. The
Agent surface is reserved but is not part of the initial implementation, and is
not advertised in the interface until it exists.

The primary product invariant is:

> A user-supplied binary never leaves the device.

The application targets current iPad Safari and Android tablet Chrome. It is a
client-rendered static application without server-side rendering.

## Goals

1. Load a binary through the device's native file picker.
2. Detect APK/DEX and native executable formats.
3. Analyze native executables with Kuna WASM.
4. Analyze APK/DEX with the custom Rasc WASM build.
5. Browse, search, and inspect functions, classes, symbols, and decompiled output.
6. Keep binaries, complete analysis artifacts, and projects on the device.
7. Remain responsive under tablet memory and touch-input constraints.
8. Preserve a clean integration point for a future Pi-based Agent.

## Non-goals for the first release

- Running the Pi CLI in the browser.
- Implementing an Agent loop or model Provider.
- User accounts, billing, or cloud session storage.
- Uploading binaries for server-side analysis.
- Server-side rendering or server functions.
- Supporting old Android WebViews or unsupported browser engines.
- General-purpose IDE functionality.

## Architecture

```text
┌──────────────────────────────── iPad / Android tablet ────────────────────────────────┐
│                                                                                       │
│  Solid 2 application                                                                  │
│  ├── file selection and format detection                                              │
│  ├── analysis workspace                                                               │
│  ├── virtualized navigation                                                           │
│  ├── local project storage                                                            │
│  └── Agent (not implemented)                                                          │
│             │                                                                         │
│             ▼                                                                         │
│  Engine module                                                                         │
│  ├── Kuna adapter ──► dedicated Worker ──► Kuna WASM + WASI + SLEIGH specs            │
│  └── Rasc adapter ──► dedicated Worker ──► Rasc WASM                                  │
│             │                                                                         │
│             ▼                                                                         │
│  Browser memory + IndexedDB                                                           │
│                                                                                       │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

The browser main thread owns UI only. Parsing, inventory, search, decompilation,
and export work run in dedicated Workers.

### Engine seam

Kuna and Rasc are separate adapters behind an engine seam. The shared interface
must be extracted from their real capabilities after both integrations are
understood; it must not force native functions and DEX classes into an artificial
lowest-common-denominator model.

**Built twice, and it changed the interface once each time.** Kuna is wired in as
the first real adapter, and being real immediately disproved the assumption the
contract had been written on: that an engine answers every question and simply
answers "none" for some. Kuna answers two of the six — an inventory, and one
function's code — and cannot list strings, sections, imports, exports or
disassembly at all. An empty collection cannot express that difference, so
`UnitAnalysis` now declares its `capabilities` and the interface hides what the
engine cannot answer instead of drawing tables full of nothing, which would read
as facts about the binary.

Rasc then arrived with a different shape and a smaller answer — the classes an
archive defines, and one class's Java — and forced a second, narrower addition.
Its unit is a class, but it delivers the class as one document, so the methods
inside it do not exist as a list until the class has been read:
`UnitAnalysis.prepareClass` is that read, and the code view performs it before
asking for a method. Everything else held. The workspace still did not change, and
choosing between engines still happens above it, which is what the first adapter's
change was for.

The minimum responsibilities expected at the seam are:

- probe whether an engine accepts an input;
- open one local analysis session;
- execute typed engine-specific requests;
- report progress and structured errors;
- cancel work and release all retained memory.

Only one engine runtime should be active by default. Switching projects or
engines terminates the old Worker unless the user explicitly keeps it open.

### Local artifact module

Large engine results do not belong in Solid signals or stores. The local artifact
module owns binaries and complete results and exposes small references to the UI:

```ts
type LocalArtifactRef = {
  id: string;
  kind: string;
  label: string;
  byteSize: number;
};
```

The UI stores identifiers, summaries, viewport data, and task state. It requests
pages or individual artifacts when needed.

## Frontend platform

### Selected stack

- Solid 2
- `@solidjs/web`
- `@solidjs/router`
- `@solidjs/vite-plugin`
- Vite 8
- TypeScript
- native CSS
- Web Workers
- IndexedDB through the small `idb` wrapper
- Vitest and Playwright for development tests

Solid 2 is currently a release candidate. The runtime, renderer, router, and Vite
plugin must be upgraded as one coordinated set. Exact versions are pinned in
`package-lock.json`; RC ranges must not float independently.

### Project shape

Use Solid 2's `basic` project shape:

```ts
solid({
  start: true,
  ssr: false,
  diagnostics: true,
});
```

This provides static file-system routes, page metadata, and tests. Production
output is `dist/`. SSR and server functions remain disabled because
the application and its WASM engines are browser-only.

Planned routes:

```text
/          product entry and local privacy statement
/analyze   local analysis workspace
/agent     reserved
/settings  local storage, privacy, and engine settings
```

### Dependency policy

The first release should have very few runtime dependencies. Do not add a library
when a browser primitive or a small local module provides a clearer interface.
Every runtime dependency must document the complexity it hides.

Do not initially add:

- a component or CSS framework;
- a second state manager;
- Axios or a general utility library;
- Monaco or another full IDE shell;
- Comlink;
- a Markdown renderer;
- Pi Agent packages;
- an analytics SDK.

Use native `fetch`, inline SVG icons, Solid signals/stores, and explicit typed
Worker messages. Add a virtual-list library only if a fixed-row local renderer is
insufficient.

## Functional scope

### File opening

- Use the standard file input and platform share/file-picker flow.
- Never require the desktop File System Access API.
- Detect the format locally from bytes, not only from the file extension.
- **Open a recognised file immediately.** The workspace is where a file is
  described; a readout on the way there duplicated its opening screen and made
  opening a file feel like two steps. The home screen reports only what it cannot
  open, in one line, without a table of facts about the file.
- Accept a drop anywhere in the window, including over the workspace, and show
  that the whole screen is the target while a file is being carried over it.
- Never transmit or log the file, and never require the user to name it to open it.

### Native analysis with Kuna

Kuna already has a browser integration based on `wasm32-wasip1`, a JavaScript
WASI shim, an in-memory filesystem, a Worker, and lazily fetched SLEIGH `.sla`
files. The adapter should reuse that proven execution shape instead of wrapping
the native CLI on a server.

Initial capabilities:

- identify format and architecture;
- inventory functions;
- filter functions by name/address;
- decompile one selected function;
- cancel by terminating and recreating the Worker;
- export a project archive when memory permits.

### APK/DEX analysis with Rasc

Rasc uses the separately developed WASM build, compiled to `wasm32-unknown-unknown`
and driven through its JavaScript host interface: the module has no filesystem and
asks its host for synchronous byte ranges, which a Worker answers from the user's
`File`.

Built capabilities:

- identify APK/DEX input, including an APK whose manifest is not the first ZIP
  entry, and a bare DEX served as the one entry it would have been inside one;
- list and filter packages and classes, with a class's methods read when the class
  is opened;
- inspect a selected class as one Java document;
- cancel by terminating and recreating the Worker, keeping the class rows already
  parsed;
- report the module's real linear memory in the file readout.

Not yet used by the workspace: reference search, manifest reading, and the native
libraries an APK contains.

## Tablet UX

The interface is touch-first rather than a compressed desktop IDE.

- Landscape: navigation pane plus primary result viewer.
- Portrait: one primary surface with drawers or bottom sheets.
- No operation may require hover, right-click, or precision dragging.
- Interactive targets must remain comfortably touchable.
- Respect safe-area insets and both orientations.
- Preserve selection, search, and scroll position when panels move.
- Avoid a permanent three-column layout on narrow screens.
- Keep the privacy/network status visible rather than buried in settings.

The workspace screen that follows file selection is specified in
[Repi decompile workspace design](./repi-decompile-design.md), which refines the
input model above: the workspace is touch-first, but a Magic Keyboard's pointer
and keyboard are treated as accelerators rather than ignored.

## Performance requirements

Framework overhead is not expected to be the primary bottleneck. Optimize the
WASM and data path first.

1. Do not load Kuna or Rasc on the landing page.
2. Lazy-load only the engine selected by the input format.
3. Run all engine work in a Worker.
4. Transfer `ArrayBuffer` ownership instead of cloning large binaries.
5. Do not place a binary or complete result collection in reactive state.
6. Filter and page large collections in the Worker.
7. Virtualize large function, class, symbol, and string lists.
8. Coalesce progress updates to avoid rendering more than once per frame.
9. Terminate Workers to provide hard cancellation and reclaim memory.
10. Use a lightweight read-only code renderer; do not ship Monaco initially.
11. Treat physical iPad and Android tablet tests as release gates.

Optional WASM SIMD or threading requires feature detection and real Safari tests.
Threads may also require cross-origin isolation headers. The application must
remain correct without optional acceleration.

## Privacy and security

### Initial release

The initial application has no model connection and no analysis backend. Network
access is limited to static application assets and lazily fetched engine assets.

It must not transmit:

- binaries or binary fragments;
- filenames or binary hashes;
- symbols, classes, functions, strings, or decompiled code;
- project/session contents.

Do not include third-party scripts. Apply a restrictive Content Security Policy
and an explicit `connect-src` allowlist. Automated browser tests should fail on
unexpected outbound requests during local analysis.

### Telemetry

Product trust takes precedence over detailed analytics.

Allowed by default:

- aggregate page/static-asset traffic from the hosting layer;
- operational build and availability metrics that contain no project data.

Local tool telemetry, if ever added, must be opt-in, coarse-grained, documented,
and independently disableable. Never collect filenames, hashes, exact sizes,
analysis queries, artifacts, prompts, or code.

## Deployment

The first release is a static site. It may be hosted on GitHub Pages or through a
static Cloudflare deployment. Cloudflare is not required as an analysis backend.
It may later provide response headers, CDN delivery, and aggregate site metrics
without receiving analysis content.

The application is its own repository with its own package manifest and
lockfile. The Pi package repository declares only Pi package resources: no web
dependencies, no workspaces, and no install hooks, so `pi install` is unaffected
by anything the application needs.

## Future Agent design

The Agent surface is not implemented in the first release: there is no Agent
dependency, no transport, and no badge or route standing in for one.

The intended future design is:

```text
Local Artifact Store
        │
        ▼
Disclosure module
        │ approved text only
        ▼
Pi Agent Core model stream seam
├── Direct adapter: browser Pi AI + user Provider key
├── Self-hosted adapter: user-owned relay
└── Managed adapter: optional Repi Cloud/API
```

Planned Pi modules:

- `@earendil-works/pi-agent-core` for the browser Agent loop and local tools;
- `@earendil-works/pi-ai` for browser-direct Provider support;
- `streamProxy()` for optional self-hosted or managed transport.

The Agent tools will operate on local artifact identifiers. They must never expose
a binary-reading primitive to a remote model. A disclosure module will construct
the exact bounded text allowed to enter model context.

Each connection mode must be explicit in the UI:

- **Direct:** selected context goes directly to the model Provider; Repi cannot
  see it.
- **Self-hosted:** selected context passes through infrastructure controlled by
  the user.
- **Managed:** selected context passes through Repi Cloud and may be metered.

No mode may silently fall back to another. A future paid API should sell managed
model/Agent access while analysis execution remains local. A cloud endpoint that
accepts binaries would be a separate product and would contradict this design's
primary invariant.

## Delivery sequence

### Phase 0 — Solid foundation

- [x] Replace the dependency-free prototype with a pinned Solid 2 `basic` project.
- [x] Preserve the current visual direction.
- [x] Implement the home screen: file opening, local format detection, and honest
  reporting for unsupported containers.
- [x] Add a production-build smoke test that drives the real page in headless
  Chrome, and assert that no cross-origin request is issued.
- [ ] Add the Analyze route and the Agent surface.

### Phase 1 — Kuna workflow

- [x] Implement file opening and local format detection.
- [ ] Integrate Kuna WASM through its Worker execution shape.
- Implement inventory, search, decompile, cancellation, and export.
- Validate memory behavior on physical tablets.

### Phase 2 — Rasc workflow

- [x] Integrate the custom Rasc WASM build.
- [x] Add APK/DEX navigation and analysis capabilities.
- [x] Extract the smallest useful shared engine interface from the two real adapters.
- Reference search and manifest reading are not wired to the workspace yet, and an
  APK's native libraries are not offered as their own units.

### Phase 3 — Local projects

- Persist project metadata and selected artifacts in IndexedDB.
- Add storage visibility, export, and explicit deletion.
- Test storage pressure and browser eviction behavior.

### Later — Agent

- Specify and test the disclosure module.
- Add Pi Agent Core and local analysis tools.
- Start with a direct Provider adapter.
- Add self-hosted or managed transport only when required.

## Open questions

- Where is the Rasc WASM repository or local source tree?
- What initialization, search, and decompilation interface does Rasc expose?
- Which exact tablet OS/browser versions become the support floor?
- What file-size thresholds are safe for each engine on physical devices?
- Which Kuna build/version should be pinned and how will its artifacts be
  reproduced in CI?
- Which local artifacts should persist by default versus remain session-only?
