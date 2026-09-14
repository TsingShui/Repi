# Repi UI design

> What is here is the interface: the conversation that the application opens on,
> the page that explains it, the file intake, and the rules a tablet imposes. The
> application design that used to be in this file — the engine seam, the platform
> choices, the performance list, the privacy clauses, the deployment shape, the
> delivery sequence and the Agent design — was removed with the workspace it was
> written for. It is in the history at `c9ae5a1` if it is wanted back.

## The conversation

The home surface is one conversation: a column, a transcript that scrolls, and a
composer pinned under it. The shape is the one chat interfaces have settled on,
because it is the shape a person already knows how to use; the skin is this
product's — square geometry, one accent, hairline rules.

The empty state carries the brand and one sentence about what this is: analysis
runs on this device. It also says what is not true yet, in the same breath:
**no model is connected, so the conversation does not answer**, and a dropped file
reports what it recognised and stops there. A welcome screen that looked like a
working assistant would be a lie the first keystroke exposes.

The transcript holds three kinds of line, and they are told apart rather than
merged:

- **what the user typed**, right-aligned in a tinted block;
- **what the application says about itself** — what it recognised, what it cannot
  read, what is not connected — left-aligned, muted, labelled `REPI`;
- **a file**, as a card: name, format, architecture or container note, size, and
  whether anything in this build can read it. The card exists so that "nothing
  here reads this" is an answer rather than silence.

The composer is one bordered box: attach, the input, send. Enter sends and
Shift+Enter starts a line, which is what a chat interface does; a touch keyboard's
return key is a real newline, because Shift cannot be held on glass. The two
controls in the box carry the 44px floor under a coarse pointer, and they are the
only targets on the surface that are not already text-sized.

Under the box, always visible rather than only on the welcome screen: **nothing
you type, and no file you drop, leaves this device.** It is the claim the product
is built on, and a claim made once at the top of a scroll is a claim the user stops
being able to check.

## About page

Reached from the top bar rather than shown on the way in. It was the home page
until the conversation took that place; everything on it is about the product
rather than about a file.

The page shows the two ways a file gets in as two halves of a single control — no
gap, one outline, an internal seam — in the accent and in a tint of it: opening
the picker, and carrying a file over the window. Two separate buttons with a gap
between them said "two things"; joined, they say what they are, which is one
outcome through two gestures. The halves are not the same width — each takes the
width its label needs, so the pair is asymmetric and small. Equal halves had to be
sized to the longer label, which left the shorter one as a block of empty colour,
and the whole control grew into a band across the page. The second is a second tone
rather than a greyed-out control, because it is a way in and not a disabled state,
and it lights up while a file is over the window. It also opens the picker when
tapped: you cannot tap to drag, and a block that looks like a button and answers
nothing is worse than one that does the obvious thing.

Below that, the install command with a copy control, under a hairline: one line
saying what it is for, the command in a bordered box at reading size, and a copy
button. It is set apart from opening a file, but it is not set as a footnote — the
first version was 10px mono and read as small print nobody follows. Nothing on this
page should be smaller than the text around it for the sake of looking quiet.

Behind it, the structure field: an abstract view of an address space being read on
this device. It is decoration with a budget — 30 fps, a static frame under
`prefers-reduced-motion`, device pixel ratio capped at 2, no pointer events.

## File intake

- Use the standard file input and platform share/file-picker flow.
- Never require the desktop File System Access API.
- Detect the format locally from bytes, not only from the file extension.
- Accept a drop anywhere in the window, and show that the whole screen is the
  target while a file is being carried over it. The drop, the entry block on About
  and the attach control in the composer all run through one code path, so they
  cannot drift apart in what they accept.
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
