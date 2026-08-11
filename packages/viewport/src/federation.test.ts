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

/** A unit cube at an offset, so two models can be told apart by where they are. */
function cube(x: number, expressId: number): SourceMesh {
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
    color: [0.8, 0.8, 0.8, 1] as const,
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
