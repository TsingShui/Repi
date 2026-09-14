# Repi UI design

> What is here is the interface: the home page as built, the file intake, and the
> rules a tablet imposes. The application design that used to be in this file — the
> engine seam, the platform choices, the performance list, the privacy clauses, the
> deployment shape, the delivery sequence and the Agent design — was removed with
> the workspace it was written for. It is in the history at `c9ae5a1` if it is
> wanted back.

## Home page

The home screen shows the two ways a file gets in as two halves of a single
control — no gap, one outline, an internal seam — in the accent and in a tint of
it: opening the picker, and carrying a file over the window. Two separate buttons
with a gap between them said "two things"; joined, they say what they are, which is
one outcome through two gestures. The halves are not the same width — each takes
the width its label needs, so the pair is asymmetric and small. Equal halves had to
be sized to the longer label, which left the shorter one as a block of empty
colour, and the whole control grew into a band across the page. The second is a
second tone rather than a greyed-out control, because it is a way in and not a
disabled state, and it lights up while a file is over the window. It also opens the
picker when tapped: you cannot tap to drag, and a block that looks like a button
and answers nothing is worse than one that does the obvious thing.

Below that, the install command with a copy control, under a hairline: one line
saying what it is for, the command in a bordered box at reading size, and a copy
button. It is set apart from opening a file, but it is not set as a footnote — the
first version was 10px mono and read as small print nobody follows. Nothing on this
page should be smaller than the text around it for the sake of looking quiet.

## File intake

- Use the standard file input and platform share/file-picker flow.
- Never require the desktop File System Access API.
- Detect the format locally from bytes, not only from the file extension.
- Accept a drop anywhere in the window, and show that the whole screen is the
  target while a file is being carried over it.
- Never transmit or log the file, and never require the user to name it in order to
  open it.
- A file this build cannot read is refused in one line on the home page. A file it
  can read has nowhere to go yet: the surface that reads it is the Agent surface
  and it is not built, so the page says what it recognised and stops there.

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
/                 the home page
/#/licenses        what Repi is built on, readable before any engine exists
/agent            reserved: the Agent surface, not built
```

The workspace that used to open after a file was accepted has been removed. The
licences page is a hash route rather than a path because a static host has no
rewrite rules, and it is the one page that has to be reachable without an engine
installed.
