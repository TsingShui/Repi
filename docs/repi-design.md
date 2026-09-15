# Repi UI design

> What is here is the interface: the conversation that the application opens on,
> the page that explains it, the file intake, and the rules a tablet imposes. The
> application design that used to be in this file — the engine seam, the platform
> choices, the performance list, the privacy clauses, the deployment shape, the
> delivery sequence and the Agent design — was removed with the workspace it was
> written for. It is in the history at `c9ae5a1` if it is wanted back.

## The conversation

The home surface is a conversation beside browser-local history: a left rail on
wide screens and an off-canvas drawer on narrow ones. The rail creates, selects and
deletes conversations; each one stores its transcript in IndexedDB and takes its
title from the first message or file. Attached binaries are streamed into OPFS,
with an IndexedDB `Blob` fallback where OPFS is unavailable. The conversation itself is a wide centred
column, a transcript, and a capsule composer. The layout is the one the assistant
surfaces have settled on — a rotating investigation prompt over the composer when
nothing has been said, a composer that docks to the bottom once there is a transcript — because a
conversation that looks like the ones people already use is one they do not have
to learn. The conversation borrows a quiet, persistent version of About's structure
field: dimmer, slower, without fragments or pointer parallax, and masked beneath the
content so it adds texture without reducing transcript legibility.

The geometry and the layout are borrowed; the colour and the type are not. The
palette is this product's own — its accent, its greys, its green for the local-safe
signal — and the type is the platform's. Icons are black and white: the mark and the
avatars are an ink tile with the page's colour for the glyph, so the accent appears
only where something is actionable, or where a word is the page's point.

Two states share one DOM rather than two trees behind a `Show`: the same composer
element is in both, so sending the first message does not move the element the caret
is in. With nothing said yet the block is centred in the window, a little above the
middle; once there is a transcript the column sits against the composer and the
composer docks to the bottom.

The earlier direction was the opposite of this one — sharp geometry, no rounded
corners, a hairline on everything — and it was written for a workspace of tables and
tabs. That workspace is gone, and square corners inside a rounded shell would read as
two products, so the geometry moved with the product. The one place more than one
colour is used is the assistant's own mark.

The transcript holds three kinds of line, and they are told apart rather than
merged:

- **what the user typed**, right-aligned in a tinted bubble;
- **what the application says about itself** — what it recognised, what it cannot
  read, or a provider failure — left-aligned behind the mark, labelled `Repi`;
- **an Agent answer**, streamed from the selected provider, rendered as Markdown
  with syntax-highlighted code blocks, and able to call local, read-only analysis
  tools. Raw HTML and remote Markdown images are disabled; links open only after
  the reader acts on them;
- **a file**, as a card under the same mark: name, format, architecture, size, and a
  badge saying whether anything in this build can read it. That badge is the point
  of the card: "nothing here reads this" is an answer, and silence is not.

The rail carries the product identity and the About link. Its lower-left stack also
holds **Storage** and **Device**.

**Storage** is the one row there that shows a quantity rather than a state: the amount
the browser is holding, a bar for how much of the quota that is on the label's own line
instead of one of its own, and the backend and retention policy underneath. The bar is
green while there is room, amber past three
quarters, red past nine tenths, because the only thing a capacity bar has to say is
when to stop. A store that holds something is never drawn empty: a few hundred
kilobytes against a ten-gigabyte quota rounds to nothing, and zero would be a lie about
a cache that is not empty. The whole row is the control that opens the panel, which
lists the cached binaries — name, format and architecture read back from the
transcript card, size, date, owning conversation — and deletes them one at a time or
all at once behind a second tap. That footer control is always present and disabled
when the cache is empty: the first version only appeared once there was more than one
file, which read as a panel with no way to empty it. Deleting clears the
`Saved locally` badge on the card that pointed at it, because a card may not claim
bytes that are gone.

**Device** is a direct WebUSB ADB manager rather than a server-side device list.
The user explicitly opens Chromium's USB picker and Android's ADB authorization prompt;
the manager stores the browser ADB key locally, reports Android/ABI/SELinux facts, and
runs only `su -c id` to state whether the connected phone grants root. It does not yet
expose a general shell or Frida session to the Agent. The conversation has no header:
the disconnected model state is not useful enough to reserve a row for it. On narrow
screens, a single floating button opens the conversation-history drawer.

The composer is one capsule: attach, the input, send, with the active model in a
small selector above it. Models are grouped by provider; when none exists, the
selector is itself an invitation to add one. Enter sends and Shift+Enter starts a
line; a touch keyboard's return key is a real newline, because Shift cannot be held
on glass. A send with nothing to send is a white circle on the tinted capsule rather
than a bare arrow, because a control that has no container reads as an icon that
failed to render.

A **+ Model** action sits at the lower left of the history rail. The dialog has two
real paths: **API Key** selects a Pi built-in Provider and inherits its model catalog,
protocol and compatibility metadata; **Custom** accepts an OpenAI-compatible base URL,
discovers its catalog through `GET /models`, can resynchronise it later, and falls back
to manual model IDs only when that endpoint is absent. Account/OAuth login is omitted:
Pi's subscription flows require a local callback or device-code broker, which this
static browser application deliberately does not run. Provider credentials live in
IndexedDB and are never copied into a conversation. Each conversation stores only its
selected provider/model reference.

The active model runs through Pi's browser-safe Agent loop. Its tools are deliberately
read-only and local: list attached binaries, inspect one, find functions or classes,
search strings, and decompile a selected function or class. The tools read the OPFS
copy through Kuna or Rasc and return bounded text; the original binary is never put in
the model request. The full Pi Coding Agent shell is not embedded because its file,
process and terminal runtime is Node-specific and would break the browser-only trust
boundary.

The empty state has a restrained hierarchy rather than one fixed sentence: one of
five slowly rotating investigation questions, one sentence about the device boundary,
the composer, and three prompts that fill — but do not submit — the composer. Rotation
stops under `prefers-reduced-motion`; the stable screen-reader heading names the surface
without announcing every decorative change.

That leaves the interface saying nothing about where a file goes. It is recorded here
because this document argued the other way — that the claim is the product's point and
belongs where the user can check it — and the decision went the other way.

## About page

Reached from the conversation's bar, not shown on the way in: it is what you read when
you are deciding whether to trust the thing. One page, because the licence list used to
be a second page reached through a second link — and it is the same kind of reading,
done by the same person, in the same sitting.

It is one centred column at the conversation's measure. The first version was a
full-bleed hero aligned to the page's gutter with a canvas backdrop behind it; that
made About and the licence list look like two sites behind one hostname, and the
backdrop is the only part of it worth keeping, so the backdrop stayed and the layout
became the product's column.

Three sections:

**The hero.** The product's line — where the work happens, in one claim — and one
paragraph introducing the product: open source, for the edge, everything runs on the
reader's own machine except the text sent to the model they connect. It carries no
control and lists nothing: what it can recognise belongs to the moment a file is in front of it, not to a
page you read first. The first version had the picker and the drop as two
halves of one capsule, which was the right control on a landing page whose only job was
to take a file; on a page you read, a call to action in the middle of the prose is a
detour, and the conversation is one tap away with the same two ways in.

**The other half.** Why the package exists and the command that installs it, with a
copy control: the command in a bordered box at reading size, and a copy button. The
first version was 10px mono and read as small print nobody follows, and a refused
clipboard selects the command rather than doing nothing visible.

The paragraph says what the browser costs — performance and extensibility have a
ceiling in a tab — and that pi-re is the same practice as a Pi Agent extension, running
in an agent with the reader's own tools installed. The command had been pointing at
this repository, which carries no `pi` field and therefore installs nothing; it points
at the package.

**What it is built on.** What this application redistributes and the terms each part
comes under, with Repi's own licence first: the engines whose binaries ship with the
page, and the agent layer the surface is being built on. Four rows, flat. A fork is a
link inside the row it belongs to rather than a row — ASC is named in Rasc's note,
because a fork is not something the reader receives, and a second name with its own
licence column made four shipped things look like five.

One row states its tense: Pi Agent is what the agent surface will be built on, and the
note says nothing is wired to it yet.

It has been three lists. The first grouped everything four ways — in the page, beside a
file, used to build it — and said where each licence file could be found; the second
dropped the npm packages and the note about where the texts live. The groupings went
last: they were a taxonomy doing the work of an argument the reader was not having, and
the two headings that survived explained the difference between "shipped" and "was
forked from" to somebody who only wanted to know what they were receiving. Libraries
inside the bundle and build tooling are not listed at all — they are package
dependencies — and the licence texts are not reproduced, because each one travels
beside the artifact that needs it.

Each note says what its project does: the native decompiler, the Android engine, the
project one of them was written from. The earlier notes described where the work
happens — compiled to WebAssembly, run in a worker, on this device, with nothing
uploaded — which is this product's position rather than a fact about the project a
reader came here to look up, and the same language was removed from the hero paragraph
above for the same reason.

Behind all of it, the structure field: an abstract view of an address space being read
on this device. Decoration with a budget — 30 fps, a static frame under
`prefers-reduced-motion`, device pixel ratio capped at 2, no pointer events.

## File intake

- Use the standard file input and platform share/file-picker flow.
- Never require the desktop File System Access API.
- Detect the format locally from bytes, not only from the file extension.
- Persist attached binaries locally: OPFS holds the bytes and IndexedDB holds the
  owning conversation and metadata. Check the site's storage estimate first and
  request persistent storage; deleting a conversation deletes its owned files.
- Accept a drop anywhere in the window, and show that the whole screen is the
  target while a file is being carried over it. The drop and the composer's attach
  control run through one code path, so they cannot drift apart in what they accept.
- Never transmit or log the file, and never require the user to name it in order to
  open it.
- A file that arrives goes to the conversation, whichever surface it was dropped
  on, and appears there as a card. A file this build cannot read is refused on that
  same card rather than in a dialog.

## Tablet rules

The interface is touch-first rather than a compressed desktop IDE.

- Landscape: navigation pane plus primary result viewer.
- Portrait: one primary surface with drawers or bottom sheets.
- No operation may require hover, right-click, or precision dragging.
- Interactive targets clear 44px under a coarse pointer, and they are the only
  thing a coarse pointer is allowed to change: density tightens when the pointer is
  fine. When the pointer cannot be identified, the roomy layout is the fallback,
  because that is the case a device is most likely to be.
- Respect safe-area insets and both orientations.
- Preserve selection, search, and scroll position when panels move.
- Avoid a permanent three-column layout on narrow screens.
- Keep the privacy/network status visible rather than buried in settings.

## Surfaces

```text
/                 the conversation
/#/about           what Repi is, and how to install the other half of it
/#/licenses        what Repi is built on, readable before any engine exists
/agent            reserved: the Agent surface, not built
```

About and Licenses are hash routes rather than paths because a static host has no
rewrite rules. Licenses is also the one page that has to be reachable without an
engine installed, since the licence question is asked just as often before as
after.
