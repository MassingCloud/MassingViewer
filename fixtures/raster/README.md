# Tier-3 raster baselines

Eight PNGs: the `sample` fixture's eight views, rendered by `resvg` **2.6.2** at 1600 px wide on A3, with system
fonts switched off. Produced and compared by [`fixtures/raster.test.ts`](../raster.test.ts) — read its header
before changing anything here, it records why the tier is shaped the way it is.

## Regenerating

```bash
RASTER=update npx vitest run fixtures/raster.test.ts
```

Then **open the files and look at them**, and read the checklist below before committing. A binary baseline is the
easiest artefact in a repository to update without reading, which is exactly the reflex the plan's risk #11 names.

## Before you commit a regenerated baseline

1. **Is the drawing still a drawing?** Open the PNG. Walls, slab, column, dashed lines under the cut. A rasteriser
   that silently stopped drawing paths produces a clean white sheet with a border, and it will match itself
   perfectly for ever afterwards.
2. **Did the pixel size change?** 1600×1131 for every view. A different size means the paper or the render width
   moved, and `compare` refuses that rather than scoring it — deliberately, so the change is a decision.
3. **Do the eight views still differ from each other in the expected pattern?** `renders identically` asserts the
   whole structure; if that test changed too, say why in the commit message.
4. **Is `resvg` still 2.6.2?** If not, every baseline changes at once for a reason that has nothing to do with this
   repository. The version is asserted in both directions, so a bump is a red test, not a surprise diff.

## What these do not cover

- **Text.** System fonts are off, so `resvg` renders text as nothing. There is no text in these views today and the
  suite *refuses* any, rather than masking a region — see the header of `raster.test.ts`. When grid bubbles or
  dimensions arrive, a licensed font gets committed and these are re-baselined.
- **The `broken` fixture.** It renders byte-identically to `sample`; its only difference is
  `provenance.incomplete`, which is not drawn. Asserted rather than duplicated.
- **Anything at another scale or paper size.** One sheet, deliberately. The point of this tier is paint — weight,
  dash, colour, draw order — not layout, which Tier 1 covers at every coordinate.
