---
"@massing/ui-model": minor
---

`createCanvasModeSwitch` — 2D as a peer of 3D, not a strip of it.

Ported from `ibuilder/massing`'s `canvasMode.ts` (see `docs/PROVENANCE.tsv`). The mode **is** the state and
visibility is derived from it: two surfaces with independent `hidden` flags have four states and two of them are
wrong, and nothing prevents them except everyone remembering.

A mode cannot be registered without a surface to enter, a refusal carries a sentence rather than swallowing the
click, and switching to the already-active mode is a successful no-op that does *not* re-enter — re-entering would
reset that surface's camera, scroll position and zoom on every click of the tab you are already on.

Shaped as a factory returning an interface rather than upstream's class, matching the rest of this package.

See ADR-0015.
