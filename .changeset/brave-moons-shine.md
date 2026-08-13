---
"@massing/demo": patch
---

Sectioning runs in a Worker.

`e2e/longtask.spec.ts` measured `generatePlan` blocking the main thread for ~450 ms — a quarter of a second of
dropped frames on a six-element fixture, and risk #5 in the plan. Sectioning is a pure function of
`(DrawingInput, ViewDefinition)`, so nothing kept it on the main thread except that it was easier there.

Nothing needed a serializer in either direction: meshes carry typed arrays, and a `Drawing` is plain data because
ADR-0004 keeps entities in model space with paper as a render-time transform. That is a property of the Semantic
Drawing Model rather than luck.

Replies are matched by sequence number and stale ones discarded. Cutting twice quickly — the ribbon verb and the
header button are one click apart, and `reloadFromKernel` re-cuts after every edit — would otherwise let a slow
first reply paint over a fast second one.

Measured after: the worst main-thread task on the golden path falls from ~450–711 ms to 148–182 ms, and the cut
disappears from the report entirely. What remains is boot, which is a bundle-size question rather than a threading
one.
