---
"@massingviewer/authoring": minor
"@massingviewer/viewport": minor
"@massingviewer/embed": minor
---

The authoring session, section clipping, and walk mode — closing all five M9 seam gaps.

`seamCoverage()` now reports **20/20 movable capabilities (100%), 4 staying in massing**, so
`apps/web/src/viewer` can be deleted.

New `@massingviewer/authoring`: the object four of those gaps were waiting on. Snapping runs before the prompt
reducer, so it stays frame-immediate and the reducer stays deterministic; `hover` and `pick` resolve through one
function, so the crosshair cannot show one point and the click commit another.

`viewport` gains `section` (a plane or a six-plane box) and `walk` (one first-person implementation, so massing
can delete both of its two). `embed` exposes the session, markup with orphan detection, and BCF export.
