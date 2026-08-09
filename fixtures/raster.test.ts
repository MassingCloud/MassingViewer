import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { Resvg } from "@resvg/resvg-js";
import { ARCHITECTURAL, toSvg } from "@massing/drawings2d";
import { VIEWS, drawingFor, paperFor } from "./plans.js";
import { compare, decodePng, diffImage, encodePng, worstDeltaOf, type RasterImage } from "./raster-compare.js";

/**
 * Tier 3 — rasterisation.
 *
 * The third of the three tiers `docs/testing.md` specifies, and the last one to exist. Tiers 1 and 2 run per-PR in
 * `golden.test.ts`: a semantic digest, and structural assertions against the model. Both work on the drawing's
 * *description*. Neither can see **line weight, dash pattern, hatch density, paint colour, or draw order** — a
 * theme that renders every wall hairline-thin, or a `stroke-dasharray` that stopped being emitted, produces an
 * identical digest and a plan nobody can read.
 *
 * ## It does not run per-PR, and it reports as skipped rather than vanishing
 *
 * `RASTER=1` runs it, `RASTER=update` re-baselines. Without either, these appear in the normal suite as skipped
 * tests. That is deliberate: a nightly tier that leaves no trace in the per-PR output is a tier people forget
 * exists, and `nightly.yml` already carries a comment block for exactly that reason.
 *
 * It is nightly because of risk #11 in the plan — *test-suite abandonment via reflexive `--update-snapshots`.*
 * Pixel baselines are the classic vehicle for it. Nightly keeps a raster failure something someone investigates
 * rather than something standing between them and a merge.
 *
 * ## There is no masked title block, and the reason matters
 *
 * The plan says *"title block masked"*. There is no title block: `toSvg` emits a border and the drawing, and
 * `svg.ts` has no date, no revision and no generated-at stamp. So there is nothing nondeterministic to mask.
 *
 * The thing that *would* be nondeterministic is text, because `resvg` resolves `font-family="sans-serif"` against
 * the host's installed fonts and no two CI images agree. This suite switches system fonts off, which makes text
 * deterministic by making it **invisible** — measured: a render containing a `<text>` element is byte-identical to
 * one containing nothing. So a text entity would be silently *uncovered* rather than wrongly covered, which is
 * worse than either.
 *
 * Hence the refusal below instead of a mask. If any view grows a text entity this suite fails and says what to do
 * about it. A mask hides a region from the gate permanently and nobody revisits it; a refusal makes the next person
 * choose. Same call `docs/accessibility.md` makes about the 3D canvas — state the limit, do not paper over it.
 *
 * ## One fixture is baselined, not both, and the second is asserted rather than dropped
 *
 * `broken` renders **byte-identically** to `sample` in all eight views — measured, not assumed. Its only difference
 * is `provenance.incomplete`, and provenance is not drawn. Committing eight duplicate PNGs would add 150 kB of
 * binary that *looks* like coverage and asserts nothing, so the equality is a test instead: if the broken fixture
 * ever grows geometry that sections, the suite fails and asks for its own baselines.
 *
 * Three of the eight views also collapse under rasterisation, and the whole equivalence structure is pinned below
 * rather than left implicit. That is a claim no per-view baseline can make — see `renders identically`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_DIR = join(HERE, "raster");
/** Failure artefacts. Gitignored, and uploaded by the nightly job so a red run is diagnosable without a repro. */
const OUT_DIR = join(HERE, "..", "test-results", "raster");

const MODE = process.env.RASTER;
const UPDATE = MODE === "update";
const ENABLED = MODE !== undefined && MODE !== "" && MODE !== "0";

/** The one fixture with committed baselines. `broken` is covered by an equality assertion — see the header. */
const FIXTURE = "sample";

/**
 * The pinned rasteriser.
 *
 * A pixel baseline is only meaningful against one rasteriser version — `docs/testing.md` says "resvg version
 * pinned" and this is that pin, asserted in both directions below. An unpinned raster gate fails on a lockfile
 * refresh, the failure looks like a regression, and the fix that gets applied is re-baselining.
 */
const RESVG_PINNED = "2.6.2";

/**
 * Render width in pixels, for an A3 sheet.
 *
 * 1600 px across 420 mm is 3.8 px/mm, which puts a 0.13 mm hairline at half a pixel — deliberately sub-pixel, so a
 * change in stroke width shows up as a change in anti-aliased grey rather than being rounded to the same single
 * black pixel. Measured on the committed baselines: 94% of all ink is mid-grey rather than solid black, which is
 * the regime that makes line weight visible to this gate at all. Coarser than this and thin/thinner become the same
 * picture, which is most of what the tier is for.
 */
const RENDER_WIDTH = 1600;

/** The plan's number. Structural change, not the primary gate — see the header of `raster-compare.ts`. */
const SSIM_FLOOR = 0.995;

function render(svg: string): RasterImage {
  const image = new Resvg(svg, {
    fitTo: { mode: "width", value: RENDER_WIDTH },
    // No system fonts, ever. This is what makes the output identical on a developer's machine and on a runner — and
    // it is why text is refused rather than rendered. See the header.
    font: { loadSystemFonts: false },
  }).render();
  return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.pixels) };
}

/** A fixture and view, rendered exactly as the baselines were. One definition, so no comparison drifts from it. */
function renderView(fixture: string, id: string): RasterImage {
  const view = VIEWS.find((v) => v.id === id)!.view;
  const drawing = drawingFor(fixture, view);
  // `interactive: false`: the fat transparent twins that make hairlines clickable are invisible to a rasteriser by
  // design, so including them would double the work and assert nothing.
  return render(toSvg(drawing, ARCHITECTURAL, paperFor(drawing), { border: true, interactive: false }));
}

describe("Tier 3 — rasterisation", () => {
  it("pins the rasteriser in both directions", () => {
    const require = createRequire(import.meta.url);
    const installed = JSON.parse(readFileSync(require.resolve("@resvg/resvg-js/package.json"), "utf8")) as {
      version: string;
    };
    const root = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };

    // The declared range, exactly. Installed with `-E` on purpose: a caret here would let a patch bump land with a
    // lockfile refresh and change every baseline, and the first person to see it would read it as a regression.
    expect(root.devDependencies["@resvg/resvg-js"], "declare the rasteriser exactly, not as a range").toBe(
      RESVG_PINNED,
    );
    // And what is actually loaded, which is the version the baselines were made with.
    expect(installed.version, `baselines were rendered by resvg ${RESVG_PINNED}; re-baseline deliberately`).toBe(
      RESVG_PINNED,
    );
  });

  // `runIf` rather than a bare `if`: the tests are still collected and reported as skipped, so the per-PR output
  // says this tier exists and did not run, instead of saying nothing at all.
  describe.runIf(ENABLED)("baselines", () => {
    if (!existsSync(BASELINE_DIR)) mkdirSync(BASELINE_DIR, { recursive: true });
    if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

    for (const { id, view } of VIEWS) {
      it(`${FIXTURE} / ${id}`, () => {
        const drawing = drawingFor(FIXTURE, view);
        const paper = paperFor(drawing);

        /**
         * Refuse text rather than mask it. See the header for why this is a refusal.
         *
         * When grid bubbles or dimensions land, this fails, and the message is the whole point: the fix is to commit
         * a licensed font and pass it through resvg's `fontFiles`, at which point text becomes both deterministic
         * *and* covered. Rendering it against system fonts would make this suite fail on a runner image update for
         * no reason anyone could act on.
         */
        const text = drawing.entities.filter((e) => e.geometry.kind === "text");
        expect(
          text.length,
          `${FIXTURE}/${id} has ${text.length} text entities, and this tier renders text as nothing because system ` +
            `fonts are off. Commit a licensed font, pass it through resvg's fontFiles, re-baseline, and delete this ` +
            `assertion — do not mask the region.`,
        ).toBe(0);

        const actual = renderView(FIXTURE, id);
        const file = join(BASELINE_DIR, `${FIXTURE}.${id}.png`);

        if (UPDATE || !existsSync(file)) {
          writeFileSync(file, encodePng(actual));
          if (!UPDATE) {
            // Written, then failed — the same rule Tier 1 follows. A silently accepted new baseline is a view that
            // landed green having asserted nothing, and nobody ever opens the file it created.
            expect.fail(
              `no raster baseline for ${FIXTURE}/${id} — one has been written to ${file}. ` +
                `Open it, confirm it is a correct plan, and commit it.`,
            );
          }
          return;
        }

        const baseline = decodePng(readFileSync(file));
        const result = compare(actual, baseline);

        if (result.over > 0 || result.ssim < SSIM_FLOOR) {
          // Artefacts first, so they exist even though the assertion below is about to throw.
          writeFileSync(join(OUT_DIR, `${FIXTURE}.${id}.actual.png`), encodePng(actual));
          writeFileSync(join(OUT_DIR, `${FIXTURE}.${id}.diff.png`), encodePng(diffImage(actual, baseline)));
        }

        // Where, in millimetres on the sheet, so the message points at a place on a drawing rather than at a pixel
        // in an image nobody has open.
        const mmPerPx = paper.size.width / actual.width;
        const where =
          result.bbox === null
            ? ""
            : ` First differs near ${(result.bbox.minX * mmPerPx).toFixed(1)}, ` +
              `${(result.bbox.minY * mmPerPx).toFixed(1)} mm, spanning ` +
              `${((result.bbox.maxX - result.bbox.minX + 1) * mmPerPx).toFixed(1)}×` +
              `${((result.bbox.maxY - result.bbox.minY + 1) * mmPerPx).toFixed(1)} mm.`;
        const detail =
          `${FIXTURE}/${id}: ${result.over} of ${actual.width * actual.height} pixels differ by more than the ` +
          `anti-aliasing tolerance, worst by ${result.worstDelta}/255, mssim ${result.ssim.toFixed(6)}.${where} ` +
          `Artefacts in test-results/raster/. Re-baseline with RASTER=update once the change is intended.`;

        expect(result.over, detail).toBe(0);
        // Independent of the pixel count, and kept because the plan names it: a difference spread thinly enough to
        // look like anti-aliasing noise everywhere, but structural in aggregate, passes the count and fails this.
        expect(result.ssim, detail).toBeGreaterThanOrEqual(SSIM_FLOOR);
      });
    }
  });

  describe.runIf(ENABLED)("renders identically", () => {
    /**
     * The equivalence structure of the eight views under rasterisation, pinned in both directions.
     *
     * Per-view baselines cannot make this claim. If the architectural theme stopped distinguishing `cut` from
     * `below` — one selector deleted, one `stroke-dasharray` dropped — every view would start rendering the same
     * plan, and *every individual baseline would still match its own file*. Only a comparison between views
     * notices. So: pairs listed here must be pixel-identical, and every pair not listed must differ.
     */
    const IDENTICAL: readonly (readonly string[])[] = [
      // Single-storey fixture, and the default `belowDepth` already reaches the ground, so filtering by storey name
      // and deepening the below band are both no-ops on this building.
      ["plan-1200", "plan-1200-deep", "plan-storey"],
      // 0.05 m and 0.3 m are both below every opening, so the loops are the same rectangles. The Tier-1 digests
      // *do* differ here: the section walk emits collinear intermediate vertices at different points along the same
      // edges. Identical drawing, different vertex lists — the two tiers disagree, and each is right about the
      // question it asks. Recorded in docs/testing.md, because it is the clearest example of why neither tier
      // replaces the other.
      ["plan-0050", "plan-0300"],
    ];

    /** Rendered once each and shared across both tests here; 28 pairs over 8 images. */
    const cache = new Map<string, RasterImage>();
    const of = (id: string): RasterImage => {
      let image = cache.get(id);
      if (image === undefined) {
        image = renderView(FIXTURE, id);
        cache.set(id, image);
      }
      return image;
    };

    const groupOf = (id: string): number => IDENTICAL.findIndex((g) => g.includes(id));

    it("exactly the views that should collapse do", () => {
      const ids = VIEWS.map((v) => v.id);
      const unexpected: string[] = [];
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const group = groupOf(ids[i]);
          const listed = group !== -1 && group === groupOf(ids[j]);
          // `worstDeltaOf` rather than `compare`: this asks only whether two renders are the same, and full-res
          // SSIM on 28 megapixel pairs costs half a minute to answer a yes/no question.
          const delta = worstDeltaOf(of(ids[i]), of(ids[j]));
          if (listed && delta !== 0) {
            unexpected.push(`${ids[i]} and ${ids[j]} are listed as identical but differ, worst by ${delta}/255`);
          }
          if (!listed && delta === 0) {
            unexpected.push(
              `${ids[i]} and ${ids[j]} render identically and are not listed — either a view lost its ` +
                `distinguishing feature, or the theme stopped painting one of the roles differently`,
            );
          }
        }
      }
      expect(unexpected).toEqual([]);
    });

    it("the broken fixture matches the sample, which is why it has no baselines of its own", () => {
      // Its only difference is `provenance.incomplete`, and provenance is not drawn. When that stops being true
      // this fails, and the fix is to baseline it too — not to loosen this.
      for (const { id } of VIEWS) {
        expect(
          worstDeltaOf(renderView("broken", id), of(id)),
          `broken/${id} no longer renders like sample/${id} — it now draws something the sample does not, so it ` +
            `needs baselines of its own. Baseline it with RASTER=update and drop this assertion for that view.`,
        ).toBe(0);
      }
    });
  });
});
