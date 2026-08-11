---
"@massing/viewport": minor
---

Federation — the viewport holds many models, each with its own state (ADR-0013).

`addModel` / `removeModel` / `models` / `setModelVisible` / `setModelTransform` / `isModelVisible`. Re-adding the
same `modelId` replaces **that model only**, which is what a consultant reissuing their structural file needs: it
must not clear the architectural model beside it — and its visibility survives the reissue, or every re-upload
un-does the view the user set up.

Per-model state lives beside the build rather than being inferred from the scene graph, which is the ADR's point:
*"avoid naive layering via generic scene groups alone."* "Is this model hidden" is a lookup, not a traversal.

`pick()` now returns `modelId` alongside `expressId` and `guid`, because with several models loaded an expressId
alone no longer identifies an element. Hidden models are hidden to the pointer too. `fit()` frames the union of
every *visible* model. `stats().triangles` sums all models, visible or not, because the triangles are on the GPU
either way and a stats panel that under-reports hides a leak.

`showModel` is unchanged in behaviour — it replaces everything — so hosts holding a single model need no changes.
