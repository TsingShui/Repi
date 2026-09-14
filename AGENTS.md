# Working on Repi

Instructions for anyone — human or agent — changing this repository. Pi loads this
file at startup, so it is the shortest path to being useful here.

## What this repository is

The browser application: a tablet-first workspace that decompiles a binary locally
in the tab. Native binaries are analysed by Kuna, APK and DEX files by Rasc, and
everything else by a deterministic mock. Nothing is uploaded.

The Pi package that shares the name is a **separate repository**,
[`TsingShui/pi-re`](https://github.com/TsingShui/pi-re): a reverse-engineering
toolchain catalog and the commands that check it, installed with `pi install`. It
is not a dependency of this one and nothing here is installed by it — which is the
point of the split, because a `pi install` must not pull a web toolchain.

The application was built inside that repository, under a directory named
`edge-compute/`. That named the idea — analysis in the browser, at the edge — and
never the product. It is retired: anything a user reads says **Repi**, and
`docs/check-design-doc.mjs` fails if the documents say otherwise.

## Commands

Run these from the repository root. Nothing here needs the network except
`build:kuna`, which reads a local checkout.

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server. |
| `npm run build` | `tsc --noEmit`, a Vite build, then the licence is copied in. Zero type errors is the bar, not a target. |
| `npm run check:analysis` | The analysis contract, in Node, without a browser. |
| `npm run smoke` | Drives the real page in headless Chrome. **Does not start a server** — point it at one with `REPI_SMOKE_URL`, or use `verify`. |
| `npm run verify` | Starts a preview server, runs the smoke check, then the design-document check, and stops the server. This is the one-command path. |
| `npm run build:kuna` | Builds the real decompiler from a Kuna checkout. See *The engines* below. |
| `npm run build:rasc` | Rebuilds the APK/DEX decompiler from a Rasc checkout. See *The engines* below. |

**One environment note, because it cost a session an iteration.** `npm run verify` and
`npm run smoke` need a Chrome that actually starts. On one machine the browser in
`~/.cache/repi-chrome` is missing ten shared libraries - libatk, libatk-bridge, libatspi,
libcairo, libcups, libpango and four X11 ones - and refuses to run, and no other browser is
installed; `~/.cache/repi-chrome/chrome-linux64/deb.deps` names the packages to install.
Checked on 2026-09-13: there is no nix store, no `/run/current-system` and no
other browser on the machine, so an install is the only route - do not spend another iteration
searching for a bundled copy.
Everything else runs without a browser: `check:analysis` and `build`. A skipped smoke is not a
passed one, so say which of the two states a change is in. The cascade is worth knowing before
chasing it: a `verify` that cannot start Chrome still writes a report (one failed assertion) to
`.smoke/`, and `docs/check-design-doc.mjs` compares the design document's figure against that
report - so a blocked run makes the check fail with a number that looks like a regression and
is not one.

A blocked run is recorded as blocked (`blocked` in `.smoke/assertions.json`) and the
document check prints a loud skip naming the reason and the unchecked count, so the two states
cannot be confused. The seam that exercises this without a browser, for anyone who needs to prove
it again:

```sh
CHROME_PATH=/bin/sleep node scripts/smoke.mjs --url http://127.0.0.1:1/
# writes {..., "blocked": "Chrome DevTools endpoint never became available"}; exit 1
node docs/check-design-doc.mjs   # skip line, exit 0
```

**Before saying anything is done**, run `npm run verify` and `npm run check:analysis`. A green
run is the claim; a plausible-sounding summary is not.

## The engines

Native binaries are analysed by **Kuna**, compiled to WebAssembly and run in a
module Worker. APK and DEX files are analysed by **Rasc**, compiled to
WebAssembly and run in a module Worker of its own. Everything else runs on the
deterministic mock.

- `src/lib/analysis/` is the seam. `types.ts` is the contract; nothing above it
  knows which engine is answering.
- `src/lib/analysis/kuna/` and `.../rasc/` are the only places that know which
  engine answers a file. The workspace is handed whichever one suits the file and
  branches on nothing else: `grep -rniE "kuna|rasc" src/features/ --exclude-dir=licenses`
  must stay empty. `src/features/licenses/` is the documented exception — the
  credits page names both, because a licence page that could not name what it
  credits would attribute nothing. The rule was always about the seam rather than
  about the words; the licence page made that distinction visible.
- `public/kuna/` is about 25 MB of build output and is gitignored. Run
  `npm run build:kuna` to produce it from a local checkout (`KUNA_REPO`, default
  `~/zhome/kuna`). Without it the application still builds and still runs, and a
  native binary is refused in one line.
- `public/rasc/` is 1.7 MB and **is committed**, because it is small enough to
  ship and shipping it is what lets a clone — and the deployed site — decompile an
  APK without a Rasc checkout. `npm run build:rasc` refreshes it from a checkout
  (`RASC_REPO`, default `~/rasc`), and `PROVENANCE.md` there records the commit.
  Nothing else in that directory is generated.
- `src/vendor/kuna/` and `src/vendor/rasc/` are the engines' browser harnesses,
  committed because the page imports them statically and a missing module is a
  build failure. They are refreshed wholesale by `build:kuna` and `build:rasc` —
  never edit them by hand.

Kuna is Apache-2.0 and derived from Ghidra. `browser_wasi_shim` is MIT/Apache-2.0.
Rasc is Apache-2.0. The licences travel with the artifacts; the build scripts copy
them. `npm run build` also copies this repository's own `LICENSE` and `NOTICE` into
`dist/`, because serving the page is distributing it.

## Rules that are not negotiable

**Nothing leaves the device.** The smoke check asserts that the page issues no
cross-origin request, and that assertion is the product's central claim. Any new
dependency that fetches at runtime breaks it.

**Never fabricate progress.** If an engine can report a real fraction, show it. If
it cannot — Kuna makes one opaque call — report `null` and let the bar be
indeterminate. A percentage that creeps toward 90% on a timer is a lie the user
cannot check.

**A hidden thing beats a wrong thing.** When an engine cannot answer something,
declare it absent rather than serving an empty collection. An empty imports table
is a claim that the binary imports nothing, which an engine that cannot read an
import table is in no position to make. This is what `UnitAnalysis.capabilities`
is for.

**Refuse out loud.** When a file cannot be analysed — no engine for the format, no
engine installed, an unreadable binary — say so, in the engine's own words where
there are any. Never fall back to something that produces plausible data under
another engine's name.

**44px is a floor, not a preference.** Under a coarse pointer every interactive
target clears it. Density tightens only under a fine pointer, and the fallback
when the pointer cannot be identified is the roomy layout. One target is exempt
and documented: the resize handle.

**No new runtime dependencies.** Virtualisation, highlighting, the tab strip and
the WASM driver are all written here. Vendored files copied from a checkout are
not npm dependencies, but say so when you add one.

**The design document is the source of truth.** `docs/repi-decompile-design.md`
describes the workspace. If implementation forces a deviation, write the deviation
into the document with the reason; do not leave the document wrong.

## The mistakes this project keeps making

This section exists because these are not hypothetical. Each one shipped, and each
was found by a check or by looking at a screenshot — never by reasoning.

**Asserting existence instead of appearance.** The check said the STRINGS table
was present while it was squashed to 32px. It said the import list had 52 rows
while the user could see exactly one, because `height: 100%` resolved against the
scroll body instead of the virtual-list wrapper. Count the *rendered* thing:
measure boxes, heights and positions, not `querySelectorAll(...).length`.

**Tests that cannot fail.** An assertion that the page did not error is not an
assertion. An assertion that a control exists is not an assertion that pressing it
does anything. Prefer comparing against an independent oracle — the smoke check
compares the C on screen against what the same wasm produces under Node, so a
mangled byte in the browser cannot pass.

**Hardcoded expectations read from the wrong place.** Read the DOM to decide what
to expect, not a literal. A test that strips the line number from a whole code row
with a regex also strips the indentation, and then fails for the wrong reason.

**Content that grows the layout instead of clipping.** A grid column is `auto` by
default and an `auto` column is sized to its widest content, so one long name
makes the page wider than the window instead of scrolling. Pin columns with
`minmax(0, 1fr)` and give truncating flex items `min-width: 0`. `ellipsis` does
nothing without `white-space: nowrap` — the text wraps instead. Both of these
shipped and both were fixed twice.

**Reading a prefix where the fact lives elsewhere.** Format detection called a ZIP
an Android package when `AndroidManifest.xml` or `classes.dex` appeared in the
first four kilobytes. Those bytes hold whichever entry the build tool wrote first,
which is not always the manifest: a real 61 MB APK starts with `META-INF/…` and
was refused as a plain archive before any engine saw it, while the fixture passed
because it put the manifest at offset 30. Ask where the fact is — for a ZIP, the
central directory — and read that range.

**Escapes inside template literals.** `evaluate(\`...\`)` is a JavaScript template
literal: `\\d` becomes `d`, `\\"` becomes a bare quote, and a backtick inside ends
the string early. Write the expression without escapes, or use a separate file.

**Patch scripts that silently do nothing.** A string replacement whose anchor is
not present is a no-op that reports success. Always assert the anchor exists
before replacing, and assert the result afterwards.

**Trusting a build command's exit code without reading it.** Filtering build
output down to `grep "error TS"` hides a Vite failure that happened after the type
check passed.

**Availability probes that believe `200`.** A static host with an SPA fallback
answers 200 with `index.html` for a path that is not there. Check what came back,
not that something did.

**A path that is only correct in one layout.** The engines were written with
`const ARTIFACT_ROOT = "/kuna/"`, which asks a project page for a directory that is
not its own; `check:analysis` guards it now. The same class of mistake is what the
extraction out of the Pi package's repository was: `ship-licence.mjs` read
`../LICENSE`, and `verify.mjs` ran `../docs/check-design-doc.mjs`, both of which
were true only while this code lived one level below the repository root.

## Conventions

**Commits** explain why, in prose. Say what was wrong, what the change does about
it, and what it costs. Do not list files. Do not describe a plan as though it were
finished.

**Checks come with the change.** A new behaviour needs an assertion that would
fail without it. Prefer a check that measures the rendered result over one that
inspects state.

**Seams for tests.** The mock reads `?mockDelay`, `?mockCount`, `?mockSymbols`,
`?mockWork` and `?mockNames`; the engine choice reads `?engine=mock` or
`?engine=kuna`. These exist so paths that are hard to reach on demand can still be
driven. Document a new seam next to the others.

**Skipping is loud.** The engine is optional, so part of the smoke check cannot
run without it. A skipped section names itself and how many assertions it skipped,
and the count is declared next to the section so a partial run cannot quietly
lower what the suite claims to cover.

**Design documents are checked.** `docs/check-design-doc.mjs` greps the documents
for vocabulary belonging to superseded decisions, and compares the assertion count
they cite against what the smoke run actually produced. When a decision is
reversed, add the retired phrase to that list with the reason it was retired.

**Solid 2 is not Solid 1.** `classList` does not exist — use `class={["a", { b:
cond }]}`. `JSX` comes from `@solidjs/web`. `createEffect(compute, effectFn)` is
two-stage. `aria-*` attributes need literal `"true"`/`"false"` strings. There is no
`onMount`; the component body is the setup, and cleanup goes in `onCleanup`.

**Write for the reader who arrives next.** Comment the reason, not the mechanism.
Where a choice looks wrong until you know the constraint, say what the constraint
is.
