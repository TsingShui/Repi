# Repi

Repi is being rebuilt as an **Agent surface**: one conversation, a binary the user
drops into it, and the tools that read that binary running on the device.
Everything stays on the machine except the model request, and what that request
carries is text the agent chose out of local analysis — never the file itself.

What is in the repository today is the part of the old build that survives:

- the conversation, which is the home surface: a chat shell with browser-local
  history and configurable OpenAI-compatible providers. Conversation and provider
  records live in IndexedDB; attached binaries live in OPFS where available, with
  a separate IndexedDB blob store as the fallback, and the rail's storage meter opens
  a panel that lists what is cached and deletes individual copies;
- the Pi Agent loop, connected to user-configured OpenAI-compatible providers. It
  discovers their model catalogs through `/models` and can call bounded, read-only
  tools over the locally stored binary; only textual tool results enter the model request;
- direct WebUSB ADB connection for a locally attached Android phone: browser-stored
  ADB credentials, Android authorization, device facts and a root-capability probe all
  stay local; Frida sessions are the next layer, not yet wired into the Agent;
- the file intake (picker, drop, attach, local format detection);
- the two engines as **analysers** — Kuna for native binaries, Rasc for APK and
  DEX, both compiled to WebAssembly and run on the device — with their Worker
  transport and the contract the Agent tools call;
- the About page, which carries the licence list — the engines ship with the page, so
  their terms have to be readable from it;
- the analysis contract's checks, which run in Node with no browser.

The workspace UI that used to sit behind the home page — tabs, a navigator, code,
strings and meta views, and its progress model — has been removed, along with its
design document and its demos. The previous state is in the history at `c9ae5a1`.

The Pi package that shares the name — a reverse-engineering toolchain catalog and
the commands that check it — lives separately at
[`TsingShui/pi-re`](https://github.com/TsingShui/pi-re), and nothing here is
installed by `pi install`.

## Stack

| Concern | Choice |
| --- | --- |
| UI | Solid 2 (`2.0.0-rc.8`), client-rendered only |
| Build | Vite 8 with `vite-plugin-solid` |
| Language | TypeScript, `strict` |
| Styling | Plain CSS with custom-property tokens, light theme first |
| Device transport | Tango / Ya-WebADB over direct Chromium WebUSB |
| Routing | A hash route for `/#/about`, and nothing else yet |

Everything is pinned in `package-lock.json`.

## Local development

```bash
npm install
npm run dev
```

Vite serves on <http://127.0.0.1:5173>. WebUSB works only in Chromium browsers on
`localhost` or HTTPS. Enable USB debugging on the Android phone; for a direct WebUSB
connection, desktop `adb` may need to release the phone's ADB interface first.

## Build

```bash
npm run build     # tsc --noEmit, then Vite, then the licence is copied into dist/
npm run preview   # serves dist/ on http://127.0.0.1:4173
```

## Checks

`npm run check:analysis` runs the analysis contract under Node, without a browser.
It bundles the checks with Vite and covers the paths that are awkward to reach by
hand: progressive discovery, abort keeping partial results, a stripped binary, a
class tree, a list of 120,000, the streaming SHA-256 the readout prints, and the
ZIP directory read that says APK rather than ZIP when the first bytes cannot.

There is no browser-level check at the moment: the smoke suite drove the
workspace, and the workspace is gone. One belongs with the Agent surface, and the
things it has to assert are different — the old suite's most important assertion
was that the page issued no cross-origin request, which is no longer the shape of
the promise now that a model request leaves the machine.

## Layout

```text
src/
  main.tsx                      mount point
  app.tsx                       the shell: routes, the transcript, every way in
  app.css
  styles/global.css             design tokens and reset
  components/brand-mark.tsx
  features/chat/                transcript, composer, and browser-local conversation history
  features/models/              provider setup and per-conversation model selection
  features/devices/             left-rail Android device manager and its dialog
  features/storage/             the capacity meter's wording, and the cache panel
  features/about/               what Repi is, and the other half's install command
  features/about/structure-field.tsx  full-screen canvas backdrop
  features/about/               what Repi is, what it is built on, the install command
  features/about/credits.ts     the credits and the scopes they are grouped by
  lib/detect-format.ts          local format detection, header plus ZIP directory
  lib/storage/                  IndexedDB records and OPFS-backed binary storage
  lib/agent/                    Pi Agent runtime and local reverse-engineering tools
  lib/device/                   direct WebUSB ADB adapter; protocol details stay here
  lib/sha256.ts                 streaming digest, so a large file is never held
  lib/pointer.ts                fine or coarse pointer, read once
  lib/analysis/types.ts         the contract an engine implements
  lib/analysis/kuna/            the native engine: Worker, WASI shim, adapter
  lib/analysis/rasc/            the APK/DEX engine: Worker, host glue, adapter
    driver.ts                   the Worker and the command protocol
    worker.ts                   byte ranges from a Blob, one run at a time
  lib/analysis/mock-source.ts   deterministic stand-in, used by the checks
```

### Licenses

The About page lists what Repi is built on and under which terms, grouped by where each
project ends up: downloaded with the engine, in the page, or only used to build it. It
is reachable from the conversation's bar and needs no engine installed.

### Building the engines

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
runs; a native binary simply has no analyser to hand it to.

`build:rasc` builds the wasm and refreshes both the served module and the vendored
host glue. Its 1.7 MB output goes to a gitignored `public/rasc/`, the same
arrangement as Kuna's: the deployed site ships both engines because the deploy
workflow builds them before it builds the page.

Native binaries are analysed by Kuna compiled to `wasm32-wasip1` and run in a
module Worker under a JavaScript WASI shim; APK and DEX files by Rasc compiled to
`wasm32-unknown-unknown` and run in a second module Worker that asks its host for
the byte ranges it needs, synchronously, from the user's `File`. Neither engine has
a filesystem of its own and neither is handed a copy of the file.

## Notes on the backdrop

`structure-field.tsx` is decoration with a budget:

- it renders at 30 fps and pauses while the tab is hidden;
- it draws a single static frame and never starts a loop when the visitor sets
  `prefers-reduced-motion: reduce`;
- the canvas is capped at device pixel ratio 2, which bounds the memory it holds
  on a 12.9-inch iPad to roughly 45 MB across the visible surface and its
  offscreen texture;
- it ignores pointer events entirely.
