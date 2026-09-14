# Repi documentation

- [Repi browser application design](./repi-design.md) — architecture and implementation plan for the tablet-first, browser-local reverse-engineering application.
- [Repi decompile workspace design](./repi-decompile-design.md) — the screen that opens after a file is accepted: layout, tabs, views, states, and the interaction rules. It cites the assertion count the smoke suite produces, and `npm run verify` compares the two.
- [Repi UI demos](./ui-demos.html) — Ink-style interactive tablet mockups for the local entry, Kuna workspace, and Rasc portrait workspace.
- [Workspace, decided model](./ui-workspace-demo.html) — the C′ skin with a directory left column and jadx-style tabs: a tab is the thing you opened, so two methods are two tabs with their own content, and reopening one focuses it. Verify with `node docs/check-workspace-demo.mjs`.
- [DEX workspace, four visual directions](./ui-direction-demos.html) — the same DEX decompile screen rendered four ways, with the density and type differences measured rather than asserted. All four respect the 44px touch floor the product enforces; C′ shows what lifting it would buy. Verify with `node docs/check-direction-demos.mjs`.
- [Working on Repi](../AGENTS.md) — how to run this repository: the commands, and what deploying takes.
