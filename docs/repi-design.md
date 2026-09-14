# Repi UI design

> What is here is the interface: the conversation that the application opens on,
> the page that explains it, the file intake, and the rules a tablet imposes. The
> application design that used to be in this file — the engine seam, the platform
> choices, the performance list, the privacy clauses, the deployment shape, the
> delivery sequence and the Agent design — was removed with the workspace it was
> written for. It is in the history at `c9ae5a1` if it is wanted back.

## The conversation

The home surface is one conversation: a wide centred column, a transcript, and a
capsule composer. The layout is the one the assistant surfaces have settled on — a
greeting over the composer when nothing has been said, a composer that docks to the
bottom once there is a transcript, suggestions under it in the empty state — because
a conversation that looks like the ones people already use is one they do not have
to learn.

The geometry and the layout are borrowed; the colour and the type are not. The
palette is this product's own — its accent, its greys, its green for the local-safe
signal — and the type is the platform's. Icons are black and white: the mark and the
avatars are an ink tile with the page's colour for the glyph, so the accent appears
only where something is actionable, or where a word is the page's point.

Two states share one DOM rather than two trees behind a `Show`: the same composer
element is in both, so sending the first message does not move the element the caret
is in. With nothing said yet the block is centred in the window, a little above the
middle, with two suggestions under the composer; once there is a transcript the
column sits against the composer and the suggestions go away.

The earlier direction was the opposite of this one — sharp geometry, no rounded
corners, a hairline on everything — and it was written for a workspace of tables and
tabs. That workspace is gone, and square corners inside a rounded shell would read as
two products, so the geometry moved with the product. The one place more than one
colour is used is the assistant's own mark.

The transcript holds three kinds of line, and they are told apart rather than
merged:

- **what the user typed**, right-aligned in a tinted bubble;
- **what the application says about itself** — what it recognised, what it cannot
  read, what is not connected — left-aligned behind the mark, labelled `Repi`;
- **a file**, as a card under the same mark: name, format, architecture, size, and a
  badge saying whether anything in this build can read it. That badge is the point
  of the card: "nothing here reads this" is an answer, and silence is not.

The bar carries the state of the thing the page is for, in the place a chat header
usually puts the model it is talking to: a pill reading **No model**, with no chevron
because there is no menu behind it.

The composer is one capsule: attach, the input, send. Enter sends and Shift+Enter
starts a line; a touch keyboard's return key is a real newline, because Shift cannot
be held on glass. A send with nothing to send is a white circle on the tinted
capsule rather than a bare arrow, because a control that has no container reads as an
icon that failed to render.

Under the box, always visible rather than only on the welcome screen: **nothing you
type, and no file you drop, leaves this device.** It is the claim the product is
built on, and a claim made once at the top of a scroll is a claim the user stops
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
