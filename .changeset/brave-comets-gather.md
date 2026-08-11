---
"@massing/embed": minor
"@massing/viewport": minor
---

Federation reaches the facade, and a plan-cutting bug it uncovered.

**`createMassingViewer` gains `addModel` / `removeModel` / `models` / `setModelVisible` / `isModelVisible`.** An added
model is visible, snappable, cuttable and pickable, but it is **not** the kernel's edit target: an authoring kernel
holds one file, and repointing it at whichever consultant's model arrived last would apply the next edit to something
the user is not looking at. `openIfc` and `showMeshes` keep their replace semantics, so a single-model host is
unchanged.

Identity needed less ceremony than expected. An IFC GlobalId is globally unique by specification, so `select`,
`selection`, markup anchors and `AuthoringSession` keep taking a bare `Guid` and are federation-safe as they stand —
only the per-file expressId needed qualifying. Duplicate GlobalIds across two models do happen in practice, and are
now **reported** through `onStatus` rather than refused or silently resolved.

**Breaking, `@massing/viewport`:** `Viewport.selection` and `onSelect` now carry `ElementRef` (`{ modelId, expressId }`)
instead of bare expressIds. Resolving an expressId against the wrong model's guid map does not fail — it returns *a*
guid, for the wrong element.

**Fixed: `cut()` silently mis-sectioned indexed geometry.** `toElementMeshes` dropped `indices`, and `ElementMesh`
documents absent indices as meaning the positions already *are* a triangle soup — so an indexed box's 8 corners were
read as 2 unrelated triangles. The cut still produced a drawing, so `cut()` reported success and returned a plan of a
shape that does not exist. Tessellators emit indexed geometry as a matter of course, so this was the normal path; it
survived because the facade's own fixtures were unindexed soups, the one shape that cannot see it.
