// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { asModelId } from "@massing/core";
import { createViewport } from "./viewport.js";
import type { SourceMesh } from "./meshes.js";

/**
 * Federation — ADR-0013, asserted on the registry rather than through a GPU.
 *
 * ## Why this can be a unit test at all
 *
 * The renderer is faked. What federation actually is — a keyed registry, per-model visibility and transform, and a
 * pick that reports *which* model — is bookkeeping, and bookkeeping is where the bugs are. The pixels are the E2E
 * suite's job and the GPU's; the thing that will silently go wrong is a `removeModel` that frees one model's buffers
 * and leaks its neighbours', or a hidden discipline you can still click through.
 *
 * `three` itself is real here, so `Group`, `Box3` and visibility behave as they do in the browser. Only the WebGL
 * context is replaced, because happy-dom has none.
 */

vi.mock("./renderer.js", () => ({
  browserWebGpuProbe: () => ({ available: () => false, create: async () => ({}) }),
  createRenderer: async () => ({
    renderer: {
      domElement: Object.assign(document.createElement("canvas"), {
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      }),
      setClearColor: () => {},
      setPixelRatio: () => {},
      setSize: () => {},
      shadowMap: {},
      info: { memory: { geometries: 0, textures: 0 }, render: { calls: 0 } },
      render: () => {},
      dispose: () => {},
      getContext: () => null,
      localClippingEnabled: false,
      clippingPlanes: [],
    },
    choice: { backend: "webgl2", reason: "test double", degraded: false },
  }),
}));

/**
 * A unit cube at an offset, so two models can be told apart by where they are.
 *
 * `color` is a parameter because a colour-restore bug is only *observable* when the two models start out different:
 * with both grey, a cache keyed on the wrong thing restores grey onto grey and the test passes while the bug is live.
 */
function cube(x: number, expressId: number, color: readonly [number, number, number, number] = [0.8, 0.8, 0.8, 1]): SourceMesh {
  const v = [
    [x, 0, 0],
    [x + 1, 0, 0],
    [x + 1, 1, 0],
    [x, 0, 0],
    [x + 1, 1, 0],
    [x, 1, 0],
  ];
  const positions = new Float32Array(v.flat());
  return {
    expressId,
    ifcType: "IFCWALL",
    positions,
    normals: new Float32Array(positions.length),
    indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
    color,
  } as unknown as SourceMesh;
}

const ARCH = asModelId("arch");
const STRUCT = asModelId("struct");
const guids = (prefix: string) => (expressId: number) => `${prefix}${expressId}`;

async function viewer() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return createViewport({ container });
}

describe("the model registry", () => {
  it("holds several models at once, in the order they were added", async () => {
    const v = await viewer();
    v.addModel([cube(0, 1)], guids("a"), ARCH);
    v.addModel([cube(10, 1)], guids("s"), STRUCT);
    // Insertion-ordered, so "architectural then structural" survives a round trip and a host is not forced to
    // re-sort for display.
    expect(v.models).toEqual([ARCH, STRUCT]);
    v.dispose();
  });

  it("replaces ONLY the re-added model, which is the whole point", async () => {
    // A consultant reissuing their structural file must not clear the architectural model beside it. This is the
    // behaviour that distinguishes `addModel` from `showModel`.
    const v = await viewer();
    v.addModel([cube(0, 1)], guids("a"), ARCH);
    v.addModel([cube(10, 1)], guids("s"), STRUCT);
    v.addModel([cube(10, 1), cube(20, 2)], guids("s"), STRUCT);

    expect(v.models).toEqual([ARCH, STRUCT]);
    v.dispose();
  });

  it("showModel still replaces everything, so a single-model host is unchanged", async () => {
    const v = await viewer();
    v.addModel([cube(0, 1)], guids("a"), ARCH);
    v.addModel([cube(10, 1)], guids("s"), STRUCT);
    v.showModel([cube(0, 1)], guids("a"), ARCH);
    expect(v.models).toEqual([ARCH]);
    v.dispose();
  });

  it("removeModel reports whether there was anything to remove", async () => {
    const v = await viewer();
    v.addModel([cube(0, 1)], guids("a"), ARCH);
    expect(v.removeModel(ARCH)).toBe(true);
    // False rather than throwing: removing a model that is already gone is idempotent by intent, and a host
    // reacting to a websocket message should not have to guard.
    expect(v.removeModel(ARCH)).toBe(false);
    expect(v.models).toEqual([]);
    v.dispose();
  });
});

describe("per-model state", () => {
  it("hides one model without touching the others", async () => {
    const v = await viewer();
    v.addModel([cube(0, 1)], guids("a"), ARCH);
    v.addModel([cube(10, 1)], guids("s"), STRUCT);

    expect(v.setModelVisible(STRUCT, false)).toBe(true);
    expect(v.isModelVisible(STRUCT)).toBe(false);
    expect(v.isModelVisible(ARCH)).toBe(true);
    v.dispose();
  });

  it("reports null for a model it does not have, rather than guessing", async () => {
    const v = await viewer();
    expect(v.isModelVisible(ARCH)).toBeNull();
    expect(v.setModelVisible(ARCH, false)).toBe(false);
    expect(v.setModelTransform(ARCH, new THREE.Matrix4())).toBe(false);
    v.dispose();
  });

  it("survives a hide/show cycle, because visibility is state and not a one-way door", async () => {
    const v = await viewer();
    v.addModel([cube(0, 1)], guids("a"), ARCH);
    v.setModelVisible(ARCH, false);
    v.setModelVisible(ARCH, true);
    expect(v.isModelVisible(ARCH)).toBe(true);
    v.dispose();
  });

  it("keeps a model's visibility when that model is reissued", async () => {
    // The subtle one. A user hides the structural model, the consultant reissues it, and it must stay hidden —
    // otherwise every re-upload un-does the view the user set up.
    const v = await viewer();
    v.addModel([cube(10, 1)], guids("s"), STRUCT);
    v.setModelVisible(STRUCT, false);
    v.addModel([cube(10, 1), cube(20, 2)], guids("s"), STRUCT);
    expect(v.isModelVisible(STRUCT)).toBe(false);
    v.dispose();
  });

  it("applies a per-model transform as a group matrix", async () => {
    // Site-to-project alignment is per model by definition, and applying it to the group rather than baking it into
    // geometry keeps it free, reversible, and leaves the GlobalIds pointing at the same vertices.
    const v = await viewer();
    v.addModel([cube(0, 1)], guids("a"), ARCH);
    const shift = new THREE.Matrix4().makeTranslation(100, 0, 0);
    expect(v.setModelTransform(ARCH, shift)).toBe(true);
    v.dispose();
  });
});

describe("what federation must not break", () => {
  it("frees every model's buffers on dispose, not just the last one added", async () => {
    /**
     * The invariant `e2e/memory.spec.ts` protects, at the registry level.
     *
     * Before federation, `dispose` freed `current` — one model. With a registry, that would leak the GPU buffers of
     * every other loaded discipline, and nothing would say so: the canvas goes away and the memory does not.
     */
    const v = await viewer();
    v.addModel([cube(0, 1)], guids("a"), ARCH);
    v.addModel([cube(10, 1)], guids("s"), STRUCT);
    v.addModel([cube(20, 1)], guids("m"), asModelId("mep"));
    expect(v.models).toHaveLength(3);

    v.dispose();
    // Everything unregistered — the observable proxy for "every group was removed and disposed".
    expect(v.models).toEqual([]);
  });

  it("is idempotent on dispose, because React strict mode unmounts twice", async () => {
    const v = await viewer();
    v.addModel([cube(0, 1)], guids("a"), ARCH);
    expect(() => {
      v.dispose();
      v.dispose();
    }).not.toThrow();
  });

  it("clears the selection when the model holding it is removed", async () => {
    // A stale expressId is not merely useless: it would recolour whichever element later happens to reuse that
    // number, so the highlight reappears on an unrelated wall.
    const v = await viewer();
    v.addModel([cube(0, 1)], guids("a"), ARCH);
    v.select([1]);
    expect(v.selection).toEqual([1]);
    v.removeModel(ARCH);
    expect(v.selection).toEqual([]);
    v.dispose();
  });

  it("picks nothing when there are no models, rather than throwing", async () => {
    const v = await viewer();
    expect(v.pick({ clientX: 400, clientY: 300 })).toBeNull();
    v.dispose();
  });
});

// ===================================================================================================
// Selection across models — a bug federation introduced, caught by asking what `index` holds
// ===================================================================================================

describe("selection with more than one model loaded", () => {
  /**
   * The defect: `select()` resolved through a single `index`, which after federation is the *only* model's index —
   * and therefore an **empty map whenever two models are loaded**. So the highlight silently stopped working while
   * `selection` still updated and listeners still fired: a host would be told the selection succeeded.
   *
   * That is the "reports success while nothing happened" shape, which is the one this repository keeps finding by
   * asking what a value actually contains rather than trusting that a call returned.
   *
   * Colour is the observable. `MeshLambertMaterial.color` is what `select` mutates, so reading it back is a direct
   * check rather than a proxy.
   */
  const colourOf = (v: Awaited<ReturnType<typeof viewer>>, modelId: ReturnType<typeof asModelId>): string => {
    // `buildScene` names each model's group `model:<id>` — that name is the only per-model handle in the scene graph,
    // so the helper reads it rather than a `userData.modelId` that does not exist. Getting this wrong once already
    // made all four tests fail on the helper instead of on the bug, which is a test that proves nothing.
    const group = v.scene.getObjectByName(`model:${modelId}`);
    if (group === undefined) throw new Error(`no group named model:${modelId}`);
    const mesh = group.children.find((o) => (o as THREE.Mesh).isMesh) as THREE.Mesh | undefined;
    if (mesh === undefined) throw new Error(`group model:${modelId} has no mesh`);
    return `#${(mesh.material as THREE.MeshLambertMaterial).color.getHexString()}`;
  };

  it("highlights the picked element when two models are loaded", async () => {
    const v = await viewer();
    v.addModel([cube(0, 1)], guids("a"), ARCH);
    v.addModel([cube(10, 1)], guids("s"), STRUCT);

    const before = colourOf(v, ARCH);
    v.select([1], ARCH);
    const after = colourOf(v, ARCH);
    expect(after, "the element was not recoloured, so selection did nothing").not.toBe(before);
    v.dispose();
  });

  it("leaves the other model alone when a model is named", async () => {
    // Two models sharing expressId 1 is ordinary — expressIds are per file. Naming the model is what disambiguates,
    // and it must not highlight both.
    const v = await viewer();
    v.addModel([cube(0, 1)], guids("a"), ARCH);
    v.addModel([cube(10, 1)], guids("s"), STRUCT);

    const archBefore = colourOf(v, ARCH);
    const structBefore = colourOf(v, STRUCT);
    v.select([1], ARCH);
    // Both halves, deliberately. Asserting only that STRUCT is untouched is satisfied by highlighting *nothing* —
    // which is precisely the bug — so the positive assertion is what stops the test passing vacuously.
    expect(colourOf(v, ARCH), "the named model was not highlighted at all").not.toBe(archBefore);
    expect(colourOf(v, STRUCT), "selecting in one model recoloured the other").toBe(structBefore);
    v.dispose();
  });

  it("restores the previous colour when the selection moves, per model", async () => {
    const v = await viewer();
    v.addModel([cube(0, 1)], guids("a"), ARCH);
    v.addModel([cube(10, 1)], guids("s"), STRUCT);

    const archOriginal = colourOf(v, ARCH);
    v.select([1], ARCH);
    expect(colourOf(v, ARCH), "nothing was highlighted, so the restore proves nothing").not.toBe(archOriginal);
    v.select([1], STRUCT);
    expect(colourOf(v, ARCH), "the previous selection was not restored").toBe(archOriginal);
    v.dispose();
  });

  it("restores each model's OWN colour, not whichever was cached under that expressId first", async () => {
    /**
     * The colour-cache collision, made observable.
     *
     * `originalColors` was keyed on the bare expressId. Two models both containing `#1` therefore shared one cache
     * slot, and the second model's element never got its own colour recorded — so deselecting restored the *first*
     * model's colour onto it. With both cubes grey (as every other test here has them) the wrong colour is the right
     * colour and nothing fails, which is why this test gives them different ones.
     */
    const v = await viewer();
    const red = [0.9, 0.1, 0.1, 1] as const;
    v.addModel([cube(0, 1)], guids("a"), ARCH);
    v.addModel([cube(10, 1, red)], guids("s"), STRUCT);

    const archOriginal = colourOf(v, ARCH);
    const structOriginal = colourOf(v, STRUCT);
    expect(archOriginal, "the fixture's two models are the same colour, so this test cannot detect the bug").not.toBe(
      structOriginal,
    );

    v.select([1], STRUCT); // caches struct's red
    v.select([1], ARCH); // restores struct, highlights arch
    v.select([]); // restores arch — from arch's own cache, or from struct's?

    expect(colourOf(v, ARCH), "arch was restored to the wrong model's colour").toBe(archOriginal);
    expect(colourOf(v, STRUCT), "struct was not restored").toBe(structOriginal);
    v.dispose();
  });

  it("keeps a selection in another model when one model is unloaded", async () => {
    // Removal used to `originalColors.clear()` and blank the whole selection, which was harmless while only one model
    // could be loaded and is wrong now: unloading the structural file must not drop an architectural selection.
    const v = await viewer();
    v.addModel([cube(0, 1)], guids("a"), ARCH);
    v.addModel([cube(10, 2)], guids("s"), STRUCT);
    v.select([1], ARCH);

    v.removeModel(STRUCT);
    expect(v.selection, "an unrelated model's removal dropped the selection").toEqual([1]);
    v.dispose();
  });

  it("forgets a removed model's cached colours, so a reissue is not painted with the old file's colour", async () => {
    /**
     * Found by writing the prune and the key in two steps and then reading them together: the prune matched on
     * `"arch "` while the key was `"arch":1`, so it silently never matched anything.
     *
     * The consequence needs three steps to show, which is why nothing else here catches it. A cached colour that
     * outlives its geometry is not itself visible — but when the same model is reissued and reuses the expressId,
     * `originalColors.has(key)` is already true, the new element's real colour is never recorded, and deselecting
     * paints it with the colour of a file that is no longer loaded.
     */
    const v = await viewer();
    const red = [0.9, 0.1, 0.1, 1] as const;
    v.addModel([cube(0, 1)], guids("a"), ARCH); // grey
    v.select([1], ARCH);
    v.removeModel(ARCH);

    v.addModel([cube(0, 1, red)], guids("a"), ARCH); // reissued, same expressId, different colour
    const reissued = colourOf(v, ARCH);
    v.select([1], ARCH);
    v.select([]);
    expect(colourOf(v, ARCH), "restored the colour of the model that was unloaded").toBe(reissued);
    v.dispose();
  });

  it("tells listeners when a removal drops their selection, and stays quiet when it does not", async () => {
    // A host that renders a properties panel from `onSelect` would otherwise keep displaying an element whose geometry
    // has been unloaded — the panel/highlight disagreement `apps/demo/src/main.ts` already documents having had once.
    const v = await viewer();
    v.addModel([cube(0, 1)], guids("a"), ARCH);
    v.addModel([cube(10, 2)], guids("s"), STRUCT);
    v.select([1], ARCH);

    const calls: number[][] = [];
    v.onSelect((ids) => calls.push([...ids]));

    v.removeModel(STRUCT); // holds nothing selected
    expect(calls, "a removal that changed no selection still notified").toEqual([]);
    v.removeModel(ARCH); // holds the selection
    expect(calls, "the selection was dropped without telling anyone").toEqual([[]]);
    v.dispose();
  });

  it("still works with one model and no modelId, so existing callers are unaffected", async () => {
    const v = await viewer();
    v.addModel([cube(0, 1)], guids("a"), ARCH);
    const before = colourOf(v, ARCH);
    v.select([1]);
    expect(colourOf(v, ARCH)).not.toBe(before);
    v.dispose();
  });
});
