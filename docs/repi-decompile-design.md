# Repi decompile workspace design

> Status: implemented for landscape. Native binaries are analysed by the real Kuna
> engine, compiled to WebAssembly and run in a Worker; APK and DEX files are
> analysed by the real Rasc engine, compiled to WebAssembly and run in a Worker of
> its own. The workspace talks to either only through `src/lib/analysis/types.ts`,
> and to neither by name. Portrait and side-by-side comparison are still out of
> scope.

## Scope

The screen described here is the workspace: the place where a binary is actually
read. It begins after the home screen has accepted a file and the format has been
detected.

In scope:

- the layout and its regions;
- how the navigator is organised when one file contains several analysis units;
- the tab model;
- what each view contains;
- the states a user passes through, including analysis in progress;
- the interaction rules that keep it usable on touch and faster with a pointer.

Out of scope for this version: portrait, side-by-side comparison, local project
storage, and export.

## Input model

The workspace targets an iPad or Android tablet, and it is written for **touch
first, pointer accelerated**.

- Every operation is reachable by touch alone. Nothing may depend on hover,
  right-click, or precision dragging.
- A Magic Keyboard adds a trackpad and a keyboard. Those unlock drag-to-resize,
  hover as an enhancement, secondary click, and shortcuts. They never become the
  only path to a feature.
- **Stage Manager and Split View can reduce the window below landscape tablet
  width.** Region visibility therefore follows the measured width, not the
  orientation. Panel sizes are user-adjustable and remembered.

## Layout

One top bar row over two columns. There is no rail: during analysis it would hold
nothing worth permanent width.

```text
┌──────────────────────────────────────────────────────────────────────┐
│  π  Repi  │ notes-release.apk                                     │ 36
├──────────────────────┬───────────────────────────────────────────────┤
│  libnotes.so         │ LoginActivity7 java × │ STRINGS dex × │ …     │ 32
│  arm64-v8a        ▾  ├───────────────────────────────────────────────┤
│  ▾ CLASSES    1,980  │ org.example…LoginActivity7   11 methods       │
│  ⌕  filter           ├───────────────────────────────────────────────┤
│     PayloadCodec51   │ ▾ applyCached  0x00100000  28 bytes           │
│     SyncWorker5      │    1  void *applyCached(bool arg1) {          │
│  STRINGS     512     │ ▾ read_1       0x00100018  72 bytes      ←    │
│  ▸ IMPORT    52      │    1  void *read_1(uint64_t arg2) {           │
└──────────────────────┴───────────────────────────────────────────────┘
        300px, resizable            flexible
```

| Region | Size | Notes |
| --- | --- | --- |
| Top bar | 36px fine / 44px coarse | Always one row |
| Tab strip | 32px fine / 44px coarse | The first row of the main area; the active underline is drawn inside the tab so it adds no height |
| Section head | 30px fine / 44px coarse | Sticky within the column |
| List row | 28px fine / 44px coarse | The whole row is the target |
| Code | 12px / 17px leading, at the same two densities | Follows the row token |
| Progress | 2px, overlaid | Costs no layout height |
| Navigator | 300px wide | Resizable, remembered |
| Main area | remainder | Roughly 880px at a 1180px window |

The dimensions are one skin, chosen from four directions, and they are measured by
the smoke check rather than asserted here: `npm run smoke` reads the rendered box
of the bar, a row, the tab strip, a section head and two code lines, at both
densities, and fails if any of them leaves its token.

**The section head is 30px, not the 28px an earlier draft specified.** This is the
one size that does not follow the row token. At 28px the head sits exactly on the
rows it introduces, and a header that is the same height as its contents reads as
another row. Two pixels of difference is enough to separate them without the head
becoming a band. Everything else in the table does follow the row token.

### Density follows the pointer

The two densities exist because a finger and a mouse want different things. Under
a coarse pointer every target is at least 44px. Under a fine pointer the rows
tighten to 28px, because the whole row is the target either way and the slack is
worth nothing to a cursor.

The decision is made in `src/lib/pointer.ts`, which reads
`matchMedia("(pointer: fine)")` and writes a `data-pointer` attribute that the CSS
keys off — not a `@media (pointer: fine)` block. The reason is testability rather
than taste: Chrome's `Emulation.setEmulatedMedia` can override media features but
**not** `pointer`, so a CSS-only version leaves the coarse branch unreachable to
the check suite, which is the branch most in need of a check. One signal in one
place also means the branch cannot disagree with itself.

The fallback is the touch size. If the pointer cannot be identified, the roomy
layout is used, which is the safe direction: too much room costs space, too little
costs the ability to hit anything. Whether `(pointer: fine)` toggles live when a
trackpad or mouse is attached to an iPad mid-session is **unverified** — it needs a
device — and the fallback above is what makes that harmless.

### Top bar

Almost nothing, and that is the point: the mark, the product name, and which file
is open.

```
π  Repi  │ notes-release.apk
```

- **The mark is the way back.** It was a `←` beside a mark that also meant home,
  which is two controls for one intention; the mark is the one people press.
- **The file name is here because nothing else can say it.** It is the one fact
  the application bar holds that the content below cannot, and it is truncated
  rather than wrapped so a long name cannot reshape the bar.
**Nothing else.** A `LOCAL` badge and a `⋯` menu used to sit on the right. The
badge restated something the check suite proves on every run — the page issues no
cross-origin request — and a claim on screen is not the same as one that holds; it
is stated where it can be stated properly, in the home page's copy and the
project's README. The menu held the assembly toggle, which now lives in the code
header beside the mode it switches, so it is still reachable without a keyboard.

**The tab strip is not here.** It used to be, and it was the reason this row
existed; but a strip of open documents in the application bar is a second
navigation for something the content already names, and it took the width the
file name needed. The strip sits at the top of the main area now, directly above
the view it switches, where the tab and the view's own header read as one block:

```
LoginActivity7 java × │ STRINGS dex × │ …              ← the strip
org.example…LoginActivity7        11 methods           ← the view's header
```

There is no breadcrumb. In landscape the navigator is always visible, so the
current function and the current analysis unit are already on screen. A breadcrumb
is the right answer for portrait, where the navigator is not visible, and it
should be reconsidered when portrait is designed.

### Left navigator

Three stacked parts:

1. **Source switcher** — present only when the file contains more than one
   analysis unit. It shows the active unit by name and opens a grouped picker:

   ```text
   ┌─ SOURCE ──────────────┐
   │  DEX                  │
   │   ● DEX               │
   │  NATIVE               │
   │     libfoo.so         │
   │     libbar.so         │
   └───────────────────────┘
   ```

   **DEX is a single entry.** `classes.dex`, `classes2.dex` and so on form one
   class namespace, so splitting them would be artificial. **Native libraries are
   listed individually**, because each `.so` is a separate executable with its own
   function set.

   The unit of this list is an **analysis unit**, not a file. A universal Mach-O
   binary therefore lists its slices, the same way an APK lists its `.so` files.

   **With one unit there is no control and no heading.** The row exists to switch
   between units, and there is nothing to switch between; the file name it used to
   state is in the application bar, and the architecture is in `META`. It spent a
   row of the column repeating what was already on screen, so the tree is the
   first thing in the column now.

2. **Filter** — narrows the list below. Scoped to the navigator only.

3. **List** — a flat function list for Kuna, a package → class → method tree for
   Rasc. A header line above the rows reports the current count; that count is
   information, not decoration.

   **For a Java unit the count is classes, not methods.** The method level of the
   tree appears when a class has been read, because that is when its methods
   become a fact — the engine returns a class as one document. Counting the rows
   that exist at the moment would report zero on an archive holding seventy
   thousand classes, which is the one number the column is certain about. The
   rows still appear only under the class that was opened, which is the second
   thing the tree is for: a class's methods are read when you ask for the class,
   not when the archive is scanned.

### Main area

Holds the active view. The main area is a single slot: exactly one view is visible
at a time. See *Deliberate omissions* for why side-by-side is not in this version.

## Tabs

A tab is **the thing you opened**, not a view. This is the jadx model, and it
replaces an earlier decision to keep a single `CODE` tab whose content followed
the selection.

| | What a tab is | Following a call chain |
| --- | --- | --- |
| **Repi** | an opened document | one tab per method; the strip fills up |
| *earlier* | the view in this slot | `CODE` was replaced in place |

### The unit is whatever the language makes self-contained

The granularity is not one rule applied everywhere; it follows the language.

| Language | The unit | Why |
| --- | --- | --- |
| Java (Rasc) | **a class** | A method read on its own has no context. Its fields, its other methods and its imports are what make it readable, and a class is the smallest thing that carries all of them. |
| Native (Kuna) | **a function** | There is no enclosing class. A function is already the self-contained unit. |

So a Java class is one tab holding all of its methods, and choosing a method in
the left column activates that class's tab and marks the method inside it. Two
native functions are two tabs, each holding one function.

A tab's identity is its kind plus its subject, so opening the same thing twice
focuses the existing tab rather than creating a second one.

| What you open | The tab | Closable |
| --- | --- | --- |
| a Java class | `LoginActivity`, with every method inside it | yes |
| a method inside it | the same class tab, with that method marked | yes |
| a native function | `authenticate_user` | yes |
| the strings table | `STRINGS` | yes |
| the imports | `IMPORT` | yes |
| the exports | `EXPORT` | yes |
| the file readout | `META`, one scrolling page in two sections | yes |

Everything except the code tabs is scoped to an **analysis unit**, and the tab
carries that unit as a tag. A DEX and a native library inside the same APK have
different strings, different imports and different sections, so an unqualified
`STRINGS` tab would be showing one thing and labelled as another. Two tabs labelled
`STRINGS` with `dex` and `libnotes.so` beside them are unambiguous.

Everything is openable and everything is closable. Closing the active tab
activates its neighbour; closing the last one leaves the empty state, which
points back at the left column.

Three consequences are accepted rather than avoided:

- **The strip can overflow, so it scrolls horizontally.** This is the weakest part
  of tabs on touch, and it is the price of the model. With a trackpad or keyboard
  it costs nothing, and `Cmd/Ctrl+W` makes closing cheap.
- **Memory grows with open tabs**, because each one holds its own decompiled
  output. The cache is bounded, so a tab that has been open a long time may need
  its output rebuilt when it comes back to the front.
- **The left column opens tabs rather than replacing the main area.** Clicking a
  method opens its class and marks the method; clicking a native function opens
  that function; clicking a string in the `STRINGS` tab opens the unit that uses
  it — the class or the function, depending on which unit is on screen — and marks
  the line.

### What expands in the left column, and what does not

The rule is whether the whole list fits.

| Entry | Expands | Why |
| --- | --- | --- |
| the class and function tree | yes | It is a tree; that is what trees do. |
| `IMPORT` | yes | Tens of rows. Expanding shows all of them, and the tab is one click away. |
| `EXPORT` | yes | Same. |
| `STRINGS` | no | Thousands of rows. Expanding it would put a truncated table in a 268px column: one extra click for less information than the tab it leads to. |
| `META` | no | Two sections that belong on one scrolling page, not in a sidebar. |

An entry that expands also opens its tab in the same click, so nothing costs two.

Tab order is insertion order, because that is what makes a call chain readable:
the tabs read left to right in the order you followed them.

## Views

Each view below is a kind of tab. There is no view that replaces another: opening
one never closes what was already open.

### CODE

The code the tab was opened for: one native function, or one Java class holding
all of its methods with the chosen one marked.

```text
┌───────────────────────────────────────────────┐
│  LoginActivity7 java × │ …                    │  ← the tab names it
├───────────────────────────────────────────────┤
│  ▾ applyCached    0x00100000    28 bytes      │
│     1  0x00100000  void *applyCached(bool a) {│
│     2  0x00100008    void *local3;            │
├───────────────────────────────────────────────┤
│  ▾ read_1         0x00100018    72 bytes      │  ← marked
│     1  0x00100018  void *read_1(uint64_t a) { │
│     2  0x0010001c    char *local3;            │
└───────────────────────────────────────────────┘
```

- **There is no view header.** There was one, carrying the qualified name and the
  size of what is inside, and it was removed for saying a second time what the
  content already says: the first line of a function is its signature, every line
  carries its address, and each method of a class has its own header with the size
  beside it. The tab names the tab; the tree shows the package.
- **A call site is a link.** Function names in the code are highlighted and
  clickable: the engine's inventory is the index, so a name that resolves to a
  function this binary actually has opens that function's tab, and a name that
  does not resolve is left as plain text rather than offered as a link to
  nowhere. Aliases are matched too, because the decompiler prints whichever name
  it resolved — often `sub_1149` where the list says `add`.
- **In Java, the receiver is what makes a call site resolvable.** A bare method
  name exists in hundreds of classes, so a Java call site is tokenised with its
  receiver — `com.example.Alpha.target` is one link — and the class that the
  receiver names is opened. A bare name is only linked when the class on screen
  declares it, and a receiver that matches no class in the index, or matches two,
  stays plain text. That is the same rule as above, applied to the one thing a
  Java call site gives you to resolve.
- **A Java class is one document, and its own part is shown.** The package, the
  imports, the class declaration and the fields are read from the same
  decompilation as the methods and rendered above them without a member header,
  because no member owns them. Dropping them would have shown the methods without
  the context that argued for class granularity in the first place: the fields and
  imports are why a method is readable inside its class.
- The marked method's header is accented and its body tinted, so the method you
  asked for is findable in a class of twenty without reading all of them.
- **The mode is a state that is also the control.** A label at the right end of the
  tab strip reads `C` or `ASM`, and pressing it switches modes — the only
  keyboard-free route, now that the application bar has no menu. It sits on the
  strip because the mode belongs to the code tab that is active, and it is not
  drawn at all when the active tab is not code or the engine cannot disassemble:
  a control that does nothing is worse than no control. It stays faint in C, which
  is the mode nearly every visit is in, and takes the accent while it is showing
  assembly.
- Syntax highlighting is provided by a small local highlighter. A full editor
  framework is not worth its weight here; the view is read-only.
- Line numbers are always shown. An address column appears only for a line that
  has one: decompiled C is reconstructed source, so an empty address column
  between the number and the code is a wide gap that reads as a mistake. Call
  sites are followed by name, not by address, because the name is what the engine
  reports.
- Font size follows the system. There is no in-app size control.

### STRINGS

```text
┌───────────────────────────────────────────────┐
│  ⌕  filter strings                  182,441   │
├────────┬─────────────────────────┬────────────┤
│  ADDR  │ VALUE                   │ XREFS      │
├────────┼─────────────────────────┼────────────┤
│ 1043a0 │ "expired session"       │ 2          │
│ 1043c8 │ "GET /v1/auth"          │ 1          │
│ 104402 │ "application/json"      │ 7          │
└────────┴─────────────────────────┴────────────┘
```

Owns its own filter, independent of the navigator filter. Clicking a row opens the
code that uses the string.

- **In a unit with classes**, that class opens with the method marked, so the jump
  lands on the use rather than at the top of the file.
- **In a native unit**, the tab *is* the function, so opening it is the whole jump
  and there is nothing left to mark. Scrolling to the use inside a long function
  needs an address-to-line lookup the adapter does not offer yet; it is recorded in
  *Open questions* alongside address-based navigation rather than pretended here.
  The smoke check asserts the function that opens is the one that owns the string,
  which is the part that can be verified today.

Strings tables run to hundreds of thousands of rows, so this view must be
virtualised and its filtering must happen in the worker rather than on the main
thread.

### META

One scrolling page, two labelled sections. No nested tabs.

```text
┌───────────────────────────────────────────────┐
│  FORMAT                                       │
│    FORMAT        ELF 64-bit executable        │
│    ARCHITECTURE  AArch64                      │
│    SIZE          2.0 MB                       │
│    SHA-256       174ebeae01d0…                │
│                                               │
│  SECTIONS                                     │
│    NAME               ADDRESS     SIZE  FLAGS │
│    .text              0x0001abf0  1.1 MB   AX │
│    .rodata            0x00136d20   61 KB    A │
└───────────────────────────────────────────────┘
```

File details and sections are kept on one page because they are read together:
checking what the binary is and then what it holds is one move, and nested tabs
would interrupt it.

**Imports and exports are not here.** They used to be a third section, and they
are now their own tabs. A native library's import list is the thing you open the
library to look at, not a footnote under its checksum, and the same list arrives
with its own filter and its own scroll position when it is a tab.

A table longer than 400 rows is truncated with a count. A stripped production
binary can carry tens of thousands of imports, and a readout that stalls the page
is worse than one that says what it left out. An empty section reads `None` rather
than rendering nothing.

Runtime figures such as the worker's WASM memory belong in `FORMAT`, not in a
status bar.

## States

### Opening and scanning

```text
├──────────────────────────────────────────────────────────────────────┤
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │ overlay
├──────────────────────┬───────────────────────────────────────────────┤
│  libnotes.so         │                                               │
│  arm64-v8a        ▾  │      〔the structure field is visible here〕   │
│  ▾ FUNCTIONS  1,284 ⏹│                                               │
│  FUN_00102bd0        │             No tab open                       │
│  FUN_00102c40        │                                               │
│  FUN_001031a4        │   Pick a function on the left, or open        │
│      ↑ still growing │   STRINGS or META from the column.            │
└──────────────────────┴───────────────────────────────────────────────┘
```

The list is populated in two stages: the symbol table first, which is immediate,
then functions discovered by the engine scanning code, which arrive progressively.
A stripped binary shows up as a growing column of `FUN_<address>` rows.

The growing list is itself the progress indicator, so the header carries the count
and the stop control. **Analysis never locks the interface**: functions that have
already been discovered can be selected, read and scrolled while the scan
continues.

### Nothing open

With no tab open the main area shows the empty state: the label `No tab open` and
one line pointing at the column. No illustration, no icon.

### A class or function selected

The `CODE` tab shows it. For a class, every method is present and the one that was
chosen is marked.

### Decompiling a function

```text
│  FUN_00103a20   0x00103a20                    │
│───────────────────────────────────────────────│
│             DECOMPILING                       │
│             ▓▓▓▓▓▓▓░░░░░░░                    │
```

Decompiling a single function is usually fast, so this inline state appears only
after roughly 400 ms. The top bar progress becomes involved only past roughly two
seconds. An indicator that flashes for a moment is worse than none.

## Analysis progress

One overlay bar serves every analysis stage. It is absolutely positioned under the
top bar, 2px tall, and costs no layout height.

- When the engine reports a real fraction, the bar shows it.
- When it cannot, the bar is indeterminate: a moving segment. **A fabricated
  percentage that creeps toward 90% is not acceptable.** Slow is honest; fake
  progress is not.
- On abort or failure the bar takes the state colour and disappears. A bar frozen
  at 60% is never left on screen.

The full-screen structure field from the home screen reappears behind the empty
state while discovery runs, as the visual form of "this device is reading the
binary". It is bound to the empty state rather than to the scan, so it is gone the
moment there is code to read and never animates behind text.

## Interaction rules

- Selecting a row in the column opens its tab, or focuses it if it is already
  open. A method row in an open class moves the mark rather than adding a tab.
- Clicking a row in `STRINGS` opens the code that uses it and marks the line.
- Stopping analysis **keeps the results already produced** and marks the analysis
  as partial. Compute that has already been spent is not thrown away.
- The navigator keeps its scroll position and its selection when the main area
  changes view.
- **Target size follows the input device.** Under a coarse pointer — a finger —
  every interactive target is at least 44px in its smallest dimension. When the
  browser reports a fine pointer the density tightens to 28–36px rows, because a
  mouse or trackpad does not need the slack and the whole cell is the target
  either way. The fallback is the touch size: a pointer that cannot be identified
  gets the roomy layout. Applying 44px unconditionally would spend a third of the
  column on slack that a device without a finger never uses.
- Safe-area insets are respected on all four edges.

## Deliberate omissions

**Side-by-side comparison.** The main area is one slot. Keeping code and the
strings table on screen together would mean docking a second region, which costs
the width that decompiled C — with its long lines — needs most. If the need turns
out to be common, this is the first thing to revisit.

**A window on a call chain.** Tabs hold documents, so a chain of calls is several
tabs and no two of them are on screen at once. Splitting the main area — even just
for a callee — would cost the width that decompiled C needs most, so it is not
here. It remains the first thing to revisit if following chains turns out to be
the common case.

**Portrait.** Deferred. When it is designed, the navigator becomes a separate
surface and the breadcrumb returns as the way back.

**A bottom status bar.** Removed. The function count lives in the navigator
header, analysis state in the overlay bar, and runtime figures in `META`.

## Implementation notes

The workspace knows nothing about Kuna, Rasc, WebAssembly or Workers. It renders
whatever an `AnalysisSource` reports, which is what let the screen be built before
either engine existed and what lets a real one arrive without touching it.

**Two engines sit behind that boundary.** `src/lib/analysis/mock-source.ts`
implements the contract in full — progressive discovery, an abortable scan that
keeps what it found, a stripped binary, a class tree, a container holding several
analysis units — and serves every format no real engine claims, plus the engine
seam the workspace assertions are written against. `src/lib/analysis/kuna/` serves
native binaries with the real Kuna decompiler, compiled to WebAssembly and run in
a module Worker under a JavaScript WASI shim. `src/lib/analysis/rasc/` serves APK
and DEX files with the real Rasc decompiler, compiled to WebAssembly and run in a
module Worker that reads the archive's byte ranges synchronously through a
`Blob`. Which one a file gets is decided in `choose-source.ts` before the
workspace mounts; the workspace is handed an engine and does not know there was a
choice.

### A unit says what it can answer

`UnitAnalysis.capabilities` is not decoration. Kuna inventories a binary and
decompiles a function, and that is all: it has no strings table, no sections, no
imports or exports, and no disassembly. Rasc lists the classes an archive defines
and decompiles one of them, and that is all: it has no strings table, no sections,
no imports or exports and no disassembly either. Those are declared **absent**,
not served empty, and the difference is the whole point — an empty imports table
is a claim that this binary imports nothing, which is not something an engine that
cannot read an import table is in a position to say. The workspace hides the
Strings entry, Import, Export, the SECTIONS heading and the assembly toggle when
the engine behind the current unit cannot answer them. META stays either way,
because every engine knows the format, the architecture and the size.

A Java unit therefore shows a class tree, META, and nothing else in the column.
That is a real limit of the engine, and it is the reason the capability list
exists at all: with Rasc behind it, the workspace is a class browser that
decompiles, and it says so rather than drawing four empty tables.

### What Kuna cannot do, and how that is handled

- **It cannot be interrupted mid-call.** WASI runs synchronously once it enters
  WebAssembly, so a cancel message could not be read until the work it is
  cancelling had already finished. Cancelling is `Worker.terminate()` and a clean
  Worker, which is the only primitive that can stop it. The binary is kept on the
  page side so the next request rehydrates the session.
- **It reports no progress.** One call, one answer. The scan reports `null` for
  its fraction from first to last and the overlay is indeterminate, because that
  is the truth about an opaque call.
- **It cannot say how much memory it is using.** The file readout has no WORKER
  MEMORY row under Kuna rather than a figure nobody can check.

### What Rasc cannot do, and how that is handled

- **It cannot be interrupted mid-call either.** A run is one synchronous call
  into WebAssembly, so cancelling is the same `Worker.terminate()` and a clean
  Worker. Stopping keeps the class rows already parsed, which is a real prefix of
  the engine's answer — the index arrives sorted, so a stopped scan shows the
  first part of it and the column says `Partial`.
- **It reports progress where it has some.** The archive is walked one entry at a
  time and the engine says how many are done, so the overlay shows a real fraction
  over a total it knew before it started: ten DEX files are ten steps, and on a
  120 MB archive those steps are three seconds of work. Inside one entry the engine
  says nothing, and the overlay says nothing either — no estimate is invented for
  the part that cannot be measured.
- **It lists what an archive holds, and that is not the same thing as sections.** An
  APK's entries — its manifest, its DEX files, its native libraries, its resources —
  are what it has instead of a section table, and the readout shows them with the
  entry's local header offset where a section's address would be. The capability is
  still called `sections` because that is what the readout's table is; for a native
  binary the table is sections and for an archive it is entries.
- **Its strings are the archive's vocabulary, not its classes', and they are not held.**
  The table holds every descriptor, member name and literal in every DEX, including the
  ones no class mentions, and on the 126 MB corpus that is 496,435 values and 69 MB of
  records — the largest thing a unit has, for a tab that may never be opened. So the
  host asks the engine for the count (a DEX header field, no string data) and for a page
  of matches when someone types; the table itself never crosses the Worker boundary. The
  engine reported no cross-references: who used a string was a `findrefs` query, the column
  read zero, and a row did not jump — a row that did would have been jumping to an owner
  nobody had looked up. What ships now is the paragraph after this one.

  **What ships now.** `strings --xrefs` counts, in one pass over
  the archive, how many **methods** use each string - the same rule `findrefs` reports a row
  per, so the two agree by construction - and the view fills the column from it, asking when
  the table is opened rather than when the unit is (296 ms on the 126 MB corpus, against 22 ms
  *per row* for asking one at a time). Nothing is held: the census is 4.8% of the string
  table's bytes, and a string it does not name is a **counted zero** while a table with no
  census shows a dash - the two are different claims and the column says which.
- **It has no imports or exports.** The workspace hides what
  the unit does not declare, as above.
- **Its unit is one class, not one method.** The engine prints a class as a single
  Java document, so which methods it holds is a fact about that document and does
  not exist until the class has been read. `UnitAnalysis.prepareClass` is that
  read: the first time a class is opened it is decompiled, the document is split
  into its parts, and the method rows appear in the column. Reading is per class
  and cached, so opening a second method of the same class costs nothing, and the
  code view never asks for a method whose document has not been read.
- **It cannot list the native libraries inside an APK.** An APK's `.so` files are
  separate executables and belong to Kuna, but enumerating them means reading the
  ZIP's central directory and handing each entry to the other engine's Worker.
  Both halves of the seam exist; the composition is not written, so an APK is one
  DEX unit today and its native libraries are not offered. This is a deviation
  from the source-switcher sketch above, and it is the first thing to add when an
  APK's native side matters.
- **A class arrives with its parts.** `getclass --outline` writes one record
  before the source, giving every declaration's name and line range plus the two
  structural parts no declaration owns — the header (package, imports, fields) and
  the footer (the class's closing brace) — and the parts tile the document exactly.
  The source after the record is byte-identical to the plain command's, so a host
  that wants only the text reads it and ignores the record. Before this the host
  scanned the Java for braces itself: a scanner that ends a method one line early
  still renders, it just renders wrong, and there was nothing to check it against.
- **The class index arrives as records.** `classes --json` writes one JSON object
  per class (`dex`, `descriptor`, `name`), because the text row is ` | `-joined
  and a name can contain a separator, a quote or a newline — a row a host reads
  wrong is worse than a row it cannot read. A failure is one `{"error":…}` record
  carrying the same sentence the text mode prints, so nothing is paraphrased for
  the records to parse.
- **A bare DEX is accepted as itself.** Every Rasc command addresses an archive,
  and rather than make the host wrap a `.dex` in one, the engine presents the file
  as the single entry it would have been inside one — named `classes.dex`, stored,
  the whole file. The host hands over the bytes it was given; the walk, the
  inflation limit and the error text are the same code for both shapes. Opening a
  `.dex` and the same `.dex` inside an APK produce identical output, and the smoke
  check asserts exactly that.

### The artifacts, and the seams

Kuna is a separate repository. `npm run build:kuna` reads a checkout (default
`~/zhome/kuna`, or `KUNA_REPO`), builds `kuna_wasm` for `wasm32-wasip1`, copies
the SLEIGH runtime tree, builds the preload bundle, refreshes the vendored
harness, and carries Kuna's licence and notice into the served directory. Output
goes to a gitignored `public/kuna/`; the 160 KB harness is committed, because the
page imports it statically and a missing module is a build failure, which would
make this repository unbuildable without a checkout. Without the output the
application still builds and still runs, and a native binary is refused in one
line instead of being quietly handed to the mock.

Kuna is Apache-2.0 and is derived from Ghidra, also Apache-2.0; the vendored WASI
shim is MIT/Apache-2.0.

**Rasc is the exception to that arrangement, and deliberately.** `npm run
build:rasc` reads a checkout (default `~/rasc`, or `RASC_REPO`), builds the
`wasm32-unknown-unknown` module, refreshes the vendored host glue, and copies the
licence and notice. Its output is `public/rasc/rasc.wasm` — and it is
**committed**, which Kuna's is not. The reason is size: this module is 1.7 MB
against Kuna's 25 MB and its SLEIGH tree, so the cost of carrying it in the
repository is a rounding error next to the difference it makes. A clone builds a
page that decompiles an APK, and the deployed site does too, because the artifact
is already there. Kuna's does not, and that is the trade it makes for its size.

Rasc is Apache-2.0; the licence and notice travel with the module in
`public/rasc/`, and `PROVENANCE.md` there records the commit it was built from.
To refresh it, run the script — it rewrites the served directory in place.

### A prefix is not a format

`detect-format.ts` identifies a ZIP as an Android package by looking for
`AndroidManifest.xml` or `classes.dex`, and it used to look for them in the first
four kilobytes. That is not where they are: those bytes hold whichever entry the
build tool wrote first, and a Gradle-built archive can start with `META-INF/…`.
A real 61 MB APK was therefore classified as a plain ZIP and refused before any
engine saw it, which no check noticed because the fixture had the manifest at
offset 30. Detection now reads the central directory — the end-of-directory
record in the tail, then the head of the directory itself, two slices rather than
the whole file — and the smoke check opens the class index of a DEX that was
reached through an archive it really is.

The engines have URL seams so paths that are hard to reach on demand can be
driven. The mock's are `?mockDelay=0`, `?mockCount=120000`, `?mockSymbols=none`
and `?mockWork=2600`. `?engine=mock`, `?engine=kuna` and `?engine=rasc` pin the
engine itself, which the smoke check needs: the workspace assertions are about the
workspace and were written against the mock, and the engine sections are the
opposite.

`npm run check:analysis` verifies the adapter without a browser. It covers the
mock's contract, the streaming SHA-256 that the readout prints, and the ZIP
directory read that tells an APK from an archive when its first bytes cannot. Those are the parts whose failure mode is not a crash but
a plausible answer, which no end-to-end check would notice.

`npm run smoke` drives the real page in headless Chrome, asserts 226 behaviours
and fails if the page issues any cross-origin request. Those include the density
measurements above, the tab model, both granularities, the mode toggle, the string
jump, and the fact that nothing overflows horizontally at 600px wide. Two sections
drive a real engine and compare what is on screen against what the same wasm
produces under Node — a different host, the same artifact — because a browser path
that mangles a byte would otherwise show the wrong thing confidently. Each section
declares its assertion count and fails if it did not run that many, so a build
without one of the engines cannot quietly lower what the suite claims to cover.

The density check measures the *rendered* box of every kind of control, not the
token it was given, because the two can disagree and only one of them is what a
person sees. The expanded `IMPORT` and `EXPORT` lists are measured for the same
reason: counting the rows in the DOM says nothing about whether they can be read.
A list that is correct in the DOM and one row per screen is a list that does not
work, and the first version of this shipped exactly that.

## Implementation decisions worth knowing

**Decompiled output is cached** for the last 40 functions per unit, in memory. It
is not persisted; the design's local project storage is still to come.

**The overlay covers a slow single decompile too.** Past two seconds the top bar
joins in, but the structure field does not: it belongs to the empty state, and a
long decompile is exactly the case where someone is looking at code rather than at
empty space.

## Open questions

**Left open by this document, now shipped as a default and awaiting confirmation:**

- **Keyboard shortcuts.** `Cmd/Ctrl+K` focuses the filter, `Cmd/Ctrl+W` closes the
  active tab, `Cmd/Ctrl+Shift+C` switches the code view to assembly, and
  `Cmd/Ctrl+[` returns to the home screen. Arrow keys and Enter drive the lists.
- **The resize handle is 24px wide, not 44px.** This is the one target that breaks
  the rule in *Interaction rules*, at either density. A 44px strip would swallow clicks meant for the
  list along the whole navigator edge, so the rule was traded for a wider-than-
  nothing handle that still has a non-drag path: it takes focus, answers the arrow
  keys, and a double click restores the default width. Every other control clears
  44px, and the smoke check samples every kind to prove it. If a wider handle is
  wanted, it should come with a splitter that only accepts the drag near its own
  edge.

**Still genuinely open:**

- **Portrait.** Deferred. When it is designed, the navigator becomes a separate
  surface and the breadcrumb returns as the way back.
- **Stripped binaries.** Every row is `FUN_<address>`, which is honest but not
  navigable. Whether grouping by section helps, or whether the engine can supply
  anything better, is unresolved.
- **Caching depth.** Whether revisiting a function should re-run the engine after
  40 uncached others, and how much output to keep resident, needs a real engine to
  judge.
- **Scrolling to a use inside a function.** A call site opens the function that
  contains the target, and a native string jump opens the function that uses the
  string, but neither scrolls to the line. That needs an address-to-line lookup
  the adapter does not offer.
