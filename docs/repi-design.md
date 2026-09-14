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
bottom once there is a transcript — because a conversation that looks like the ones
people already use is one they do not have to learn.

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

The empty state is the greeting and the composer, and nothing else. An earlier
version of this page explained itself under both — what runs where, and that no
model is connected — and the copy was removed: the greeting asks the question the
product is for, and the composer is the answer to it.

That leaves the interface saying nothing about where a file goes. It is recorded here
because this document argued the other way — that the claim is the product's point and
belongs where the user can check it — and the decision went the other way.
