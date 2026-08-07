import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { asModelId } from "@massingviewer/core";
import { describeKernel, describeRecipeParity, parseRecipeLedger } from "@massingviewer/kernel-conformance";
import type { KernelProvider } from "@massingviewer/kernel-api";
import { createLocalKernel } from "./provider";
import { messageChannelTransport } from "./transport";
import { countingGuidMinter } from "./guid";
import { BLANK_IFC4 } from "./blank";

/**
 * `LocalKernel` against the conformance suite, **through a real message boundary**.
 *
 * The suite drives the same `KernelProvider` a browser gets, over a `MessageChannel`: real structured-clone
 * serialisation, real asynchrony, real request/response correlation. What it does not give is thread isolation —
 * see the note on `messageChannelTransport` for why a `node:worker_threads` variant was written and then removed
 * rather than shipped untested, and for where thread isolation is actually verified.
 *
 * It still catches what a naive in-process test would miss: anything unserialisable in a message, and any
 * accidental assumption that a call is synchronous.
 */

const here = dirname(fileURLToPath(import.meta.url));

let seed = 1000;

async function create(): Promise<KernelProvider> {
  // A fresh seed per kernel, so two kernels in one run cannot mint the same GlobalId and make a test pass for
  // the wrong reason.
  const kernel = createLocalKernel(messageChannelTransport(countingGuidMinter((seed += 1000))));
  // The suite expects a model to exist at its `modelId`. `open` is not part of `KernelProvider` — it is how a
  // model gets into a kernel — so the fixture does it here.
  const opened = await (kernel as unknown as {
    open(id: ReturnType<typeof asModelId>, ifc?: string): Promise<{ ok: boolean }>;
  }).open(asModelId("conformance"), BLANK_IFC4);
  expect(opened.ok).toBe(true);
  return kernel;
}

const WALL = { start: [0, 0], end: [5, 0], height: 3, thickness: 0.2, name: "Wall-Test" };

describeKernel("LocalKernel", {
  create,
  modelId: asModelId("conformance"),
  createOp: { op: "add_wall", params: WALL },

  sampleParams: {
    add_wall: WALL,
    add_slab: { points: [[0, 0], [4, 0], [4, 3], [0, 3]], thickness: 0.2 },
    add_column: { point: [2, 2], height: 3, width: 0.4, depth: 0.4 },
    add_beam: { start: [0, 0], end: [4, 0], width: 0.3, depth: 0.5 },
    add_storey: { elevation: 3.5, name: "Level 2" },
    set_extrusion_depth: { depth: 2.5 },
    set_wall_thickness: { thickness: 0.3 },
    set_profile_dims: { width: 0.5, depth: 0.5 },
    set_element_pset: { pset: "Pset_WallCommon", properties: { FireRating: "60min" } },
    move_element: { dx: 1, dy: 1 },
    rotate_element: { degrees: 30 },
    copy_element: { dx: 2, dy: 0 },
  },

  unsupportedOps: [
    "program_fit",
    "derive_analytical",
    "add_connection_assembly",
    "execute_ifc_code",
    "furnish_spaces",
    "resolve_wall_joins",
  ],
});

/**
 * The ledger's fifteen, now earned.
 *
 * The `local` column moved from `planned` to `yes` in the same commit that made this pass, and the floor in
 * `scripts/check-recipe-parity.mjs` went from 0 to 15 with it. Neither could honestly have moved earlier: the
 * suite is the only thing that can tell a real `yes` from an intended one, which is exactly the split described
 * in that script's header.
 */
const ledger = parseRecipeLedger(readFileSync(join(here, "../../../fixtures/recipes.tsv"), "utf8"));

describeRecipeParity("LocalKernel", { create }, ledger, "local");

/**
 * Behaviour specific to this kernel, beyond the shared contract.
 *
 * The suite deliberately cannot assert these — it has to be writable against a kernel whose authors it has
 * never met — but they are the interesting parts of *this* implementation.
 */
describe("LocalKernel — across the message boundary", () => {
  const modelId = asModelId("conformance");

  it("survives a request whose params are not serialisable, and says so", async () => {
    const kernel = await create();
    try {
      // A function in the params throws DataCloneError inside postMessage. Without the try/catch in `send`, the
      // caller's promise would never settle and the app would appear to freeze.
      const result = await kernel.apply(modelId, "add_wall", { ...WALL, onDone: () => undefined } as never);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // `transport`, not `internal` — it says where to look.
        expect(result.error.code).toBe("transport");
      }
    } finally {
      await kernel.dispose();
    }
  });

  it("answers in-flight requests when disposed instead of leaving them hanging", async () => {
    const kernel = await create();
    const inFlight = kernel.apply(modelId, "add_wall", WALL);
    await kernel.dispose();
    const result = await inFlight;
    // A promise that never settles is indistinguishable from the app freezing, so dispose resolves them.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("cancelled");
  });

  it("dispose is idempotent, because React strict mode unmounts twice", async () => {
    const kernel = await create();
    await kernel.dispose();
    await expect(kernel.dispose()).resolves.toBeUndefined();
  });

  it("correlates responses by id, not by order", async () => {
    const kernel = await create();
    try {
      // Issued together and awaited together. If the client matched replies positionally, the fast `ops` would
      // be handed to the slow `apply` and both would look plausible.
      const [ops, applied, tree] = await Promise.all([
        kernel.ops(),
        kernel.apply(modelId, "add_wall", WALL),
        kernel.spatialTree(modelId),
      ]);
      expect(ops.ok && ops.value.length).toBe(15);
      expect(applied.ok && applied.value.created).toHaveLength(1);
      expect(tree.ok && tree.value.ifcClass).toBe("IfcProject");
    } finally {
      await kernel.dispose();
    }
  });

  it("a cancelled request resolves as cancelled rather than rejecting", async () => {
    const kernel = await create();
    try {
      const controller = new AbortController();
      const pending = kernel.apply(modelId, "add_wall", WALL, { signal: controller.signal });
      controller.abort();
      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("cancelled");
    } finally {
      await kernel.dispose();
    }
  });

  it("geometry comes back as IFC bytes the caller can re-parse", async () => {
    const kernel = await create();
    try {
      await kernel.apply(modelId, "add_wall", WALL);
      const geometry = await kernel.geometry(modelId);
      expect(geometry.ok).toBe(true);
      if (!geometry.ok) return;
      expect(geometry.value.format).toBe("ifc");
      const text = new TextDecoder().decode(geometry.value.bytes);
      expect(text.startsWith("ISO-10303-21;")).toBe(true);
      expect(text).toContain("IFCWALL");
    } finally {
      await kernel.dispose();
    }
  });

  it("a property edit leaves the geometry version alone", async () => {
    const kernel = await create();
    try {
      const wall = await kernel.apply(modelId, "add_wall", WALL);
      if (!wall.ok) throw new Error("add_wall failed");
      const before = wall.value.geometryVersion;

      const edited = await kernel.apply(modelId, "set_element_pset", {
        guid: wall.value.created[0],
        pset: "Pset_WallCommon",
        properties: { FireRating: "60min" },
      });
      expect(edited.ok).toBe(true);
      if (!edited.ok) return;
      expect(edited.value.modelVersion).not.toBe(wall.value.modelVersion);
      // Otherwise every property edit re-streams the whole model.
      expect(edited.value.geometryVersion).toBe(before);
    } finally {
      await kernel.dispose();
    }
  });

  it("rollback discards everything the transaction did", async () => {
    const kernel = await create();
    try {
      const before = await kernel.exportIfc(modelId);
      if (!before.ok) throw new Error("export failed");

      const tx = await kernel.begin(modelId, "batch");
      expect(tx.ok).toBe(true);
      if (!tx.ok) return;

      await kernel.apply(modelId, "add_wall", WALL, { transactionId: tx.value.id });
      await kernel.apply(modelId, "add_column", { point: [1, 1], height: 3 }, { transactionId: tx.value.id });
      const rolled = await tx.value.rollback();
      expect(rolled.ok).toBe(true);

      const after = await kernel.exportIfc(modelId);
      if (!after.ok) throw new Error("export failed");
      expect(new TextDecoder().decode(after.value)).toBe(new TextDecoder().decode(before.value));
    } finally {
      await kernel.dispose();
    }
  });

  it("declares no drawing support and refuses drawings to match", async () => {
    const kernel = await create();
    try {
      expect(kernel.capabilities.drawings).toEqual([]);
      const drawn = await kernel.drawing(modelId, { kind: "plan" });
      expect(drawn.ok).toBe(false);
      if (!drawn.ok) {
        // A kernel whose capability list and behaviour disagree is the thing capability honesty exists to catch.
        expect(drawn.error.code).toBe("unsupported");
        expect(drawn.error.message).toMatch(/not in this build yet/);
      }
    } finally {
      await kernel.dispose();
    }
  });

  it("supports() is false until ops() has resolved, rather than guessing", async () => {
    const kernel = await create();
    try {
      // The contract says so explicitly: a ribbon that guesses shows controls that then fail, which is worse
      // than a control appearing one frame late.
      expect(kernel.supports("add_wall")).toBe(false);
      await kernel.ops();
      expect(kernel.supports("add_wall")).toBe(true);
      expect(kernel.supports("program_fit")).toBe(false);
    } finally {
      await kernel.dispose();
    }
  });
});
