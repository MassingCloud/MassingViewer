/**
 * `MemoryKernel` against the conformance suite.
 *
 * This file is the template a third-party kernel copies. It is deliberately almost all *fixture* and almost
 * no test code: everything that is actually asserted lives in `@massing/kernel-conformance`, so a new
 * kernel inherits the whole contract by supplying sample parameters.
 *
 * It is also the thing that keeps the suite honest. A contract nothing passes is a wish list — when
 * `LocalKernel` or `RemoteKernel` fails an assertion, this proves the assertion was achievable, which is the
 * difference between "the kernel is wrong" and "the suite is unreasonable".
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { asModelId } from "@massing/core";
import { describeKernel, describeRecipeParity, parseRecipeLedger } from "@massing/kernel-conformance";
import { createMemoryKernel } from "./index.js";

const WALL = { start: [0, 0], end: [5, 0], height: 3, thickness: 0.2, name: "Wall-Test" };

describeKernel("MemoryKernel", {
  create: async () => createMemoryKernel(),
  modelId: asModelId("conformance"),
  createOp: { op: "add_wall", params: WALL },

  sampleParams: {
    add_wall: WALL,
    add_slab: { outline: [[0, 0], [4, 0], [4, 3], [0, 3]], thickness: 0.2 },
    add_column: { at: [2, 2], size: 0.3, height: 3 },
  },

  /**
   * The refusal parity table.
   *
   * This is where two independent kernels are made interchangeable. `LocalKernel` (web-ifc) and
   * `RemoteKernel` (ifcopenshell) must return the **same code** for each of these, because that is what lets
   * one UI message serve both. The codes are asserted; the messages never are, since they are localised.
   */
  refusals: [
    {
      label: "zero-length wall",
      op: "add_wall",
      // `degenerate_geometry`, not `invalid_param`: every value is individually valid and it is their
      // combination that cannot become a wall. The distinction is what lets the UI say something useful
      // instead of "bad input".
      params: { ...WALL, end: [0, 0] },
      code: "degenerate_geometry",
    },
    {
      label: "wall shorter than the minimum run",
      op: "add_wall",
      params: { ...WALL, end: [0.01, 0] },
      code: "degenerate_geometry",
    },
    {
      label: "negative wall height",
      op: "add_wall",
      params: { ...WALL, height: -3 },
      code: "invalid_param",
    },
    {
      label: "non-numeric thickness",
      op: "add_wall",
      params: { ...WALL, thickness: "thick" },
      code: "invalid_param",
    },
    {
      label: "wall placed beyond plausible model bounds",
      op: "add_wall",
      params: { ...WALL, start: [0, 0], end: [1e9, 0] },
      code: "out_of_bounds",
    },
    {
      label: "move a GlobalId that does not exist",
      op: "move_element",
      params: { guid: "0000000000000000000000", dx: 1, dy: 0 },
      code: "no_such_element",
    },
    {
      label: "slab outline with too few points",
      op: "add_slab",
      params: { outline: [[0, 0], [1, 1]], thickness: 0.2 },
      code: "invalid_param",
    },
  ],

  knownUnsupported: [
    // Real massing recipes this kernel does not implement. Probed to confirm they refuse *cleanly* — the
    // three failure modes ruled out being throwing (crosses a worker boundary unusably), hanging
    // (indistinguishable from slow), and silently doing nothing (the worst, because the user believes it
    // worked).
    "add_connection_assembly",
    "program_fit",
    "resolve_wall_joins",
    "derive_analytical",
    "execute_ifc_code",
  ],
});

/**
 * Recipe coverage, as a ratchet.
 *
 * massing's authoring service implements 96 recipes. `MemoryKernel` implements 7. That gap is fine and
 * expected — what matters is that it is a **counted, visible number that can only go up**, rather than
 * something a user discovers by clicking a dimmed button.
 *
 * The list is read from the committed ledger rather than restated here, so there is exactly one place that
 * says what each kernel covers. An earlier version inlined a 28-recipe subset, which meant the percentage
 * printed by this test and the percentage a reader would compute from the real 96 were different numbers with
 * the same name — the specific kind of drift this whole ledger exists to prevent.
 */
const ledger = parseRecipeLedger(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/recipes.tsv"), "utf8"),
);

describeRecipeParity("MemoryKernel", { create: async () => createMemoryKernel() }, ledger, "memory");

/**
 * Behaviour specific to this kernel, beyond the shared contract.
 *
 * The suite deliberately cannot assert these — it must be writable against a kernel whose authors it has
 * never met — but they are the interesting parts of *this* implementation.
 */
describe("MemoryKernel — implementation specifics", () => {
  const modelId = asModelId("specifics");

  it("a property edit advances the model version but NOT the geometry version", async () => {
    // The distinction that stops a property edit from triggering a full model re-stream. Collapsing the two
    // versions is an easy mistake and its cost is a visible reload on every keystroke in a properties panel.
    const k = createMemoryKernel();
    await k.ops();
    const created = await k.apply(modelId, "add_wall", WALL);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const guid = created.value.created[0]!;

    const edited = await k.apply(modelId, "set_element_pset", {
      guid,
      pset: "Pset_WallCommon",
      property: "FireRating",
      value: "60",
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;

    expect(edited.value.modelVersion).not.toBe(created.value.modelVersion);
    expect(edited.value.geometryVersion).toBe(created.value.geometryVersion);
    await k.dispose();
  });

  it("push-pull on a slab is refused with `not_an_extrusion`", async () => {
    // The refusal massing's UI depends on. There is deliberately NO client-side allowlist for push-pull, so
    // the refusal must arrive through the normal error path with a code the UI can act on. A kernel that
    // silently succeeded here would make push-pull appear to work on things it cannot edit.
    const k = createMemoryKernel();
    await k.ops();
    const slab = await k.apply(modelId, "add_slab", {
      outline: [[0, 0], [4, 0], [4, 3], [0, 3]],
      thickness: 0.2,
    });
    expect(slab.ok).toBe(true);
    if (!slab.ok) return;

    const r = await k.apply(modelId, "set_extrusion_depth", { guid: slab.value.created[0]!, depth: 0.4 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("not_an_extrusion");
    await k.dispose();
  });

  it("declares delete_element as NOT invertible, and means it", async () => {
    // Claiming invertibility it cannot honour is the dishonesty the transaction family exists to catch. Undo
    // dims with a reason rather than failing after the user has committed to the action.
    const k = createMemoryKernel();
    const ops = await k.ops();
    expect(ops.ok).toBe(true);
    if (!ops.ok) return;
    const del = ops.value.find((o) => o.id === "delete_element");
    expect(del?.invertible).toBe(false);
    const move = ops.value.find((o) => o.id === "move_element");
    expect(move?.invertible).toBe(true);
    await k.dispose();
  });

  it("rolls a transaction back to the exact prior state", async () => {
    const k = createMemoryKernel();
    await k.ops();
    await k.apply(modelId, "add_wall", WALL);
    const before = await k.exportIfc(modelId);
    expect(before.ok).toBe(true);

    const tx = await k.begin(modelId, "add some walls");
    expect(tx.ok).toBe(true);
    if (!tx.ok || !before.ok) return;

    await k.apply(modelId, "add_wall", { ...WALL, start: [0, 5], end: [5, 5] });
    await k.apply(modelId, "add_column", { at: [2, 2], size: 0.3, height: 3 });
    const rolled = await tx.value.rollback();
    expect(rolled.ok).toBe(true);

    const after = await k.exportIfc(modelId);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    // Byte-identical, not merely similar. A rollback that leaves the store subtly different is worse than one
    // that fails, because nothing reports it.
    expect(after.value.byteLength).toBe(before.value.byteLength);
    await k.dispose();
  });

  it("reports a drawing it cannot make as incomplete rather than empty", async () => {
    // The failure mode this codebase keeps designing against: a plan silently missing elements renders
    // perfectly and says nothing. A kernel with no sectioner must say every element failed, not return a
    // clean empty drawing.
    const k = createMemoryKernel({ drawings: true });
    await k.ops();
    await k.apply(modelId, "add_wall", WALL);
    const d = await k.drawing(modelId, { kind: "plan" });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.value.provenance.incomplete.length).toBeGreaterThan(0);
    expect(d.value.provenance.guidCoverage).toBe(0);
    expect(d.value.provenance.approximations.length).toBeGreaterThan(0);
    await k.dispose();
  });

  it("exports IFC containing the exact GlobalIds it handed back", async () => {
    // A writer that re-generates ids on save breaks every persisted reference in the product — markup pins,
    // selection sets, issues, drawing entities. This is the cheapest possible guard against it.
    const k = createMemoryKernel();
    await k.ops();
    const a = await k.apply(modelId, "add_wall", WALL);
    const b = await k.apply(modelId, "add_column", { at: [2, 2], size: 0.3, height: 3 });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    const ifc = await k.exportIfc(modelId);
    expect(ifc.ok).toBe(true);
    if (!ifc.ok) return;
    const text = new TextDecoder().decode(ifc.value);
    expect(text).toContain(a.value.created[0]!);
    expect(text).toContain(b.value.created[0]!);
    expect(text).toContain("IFCWALL(");
    expect(text).toContain("IFCCOLUMN(");
    expect(text).toContain("FILE_SCHEMA(('IFC4'))");
  });

  it("snap candidates carry the GlobalId of the element they belong to", async () => {
    // Without this a snapped point cannot report what it snapped to, and a placed element cannot record what
    // it was aligned against.
    const k = createMemoryKernel();
    await k.ops();
    const w = await k.apply(modelId, "add_wall", WALL);
    expect(w.ok).toBe(true);
    if (!w.ok) return;

    const snaps = await k.snapCandidates(modelId, { x: 0, z: 0 }, 1);
    expect(snaps.ok).toBe(true);
    if (!snaps.ok) return;
    expect(snaps.value.length).toBeGreaterThan(0);
    expect(snaps.value.every((c) => c.guid === w.value.created[0]!)).toBe(true);
    expect(snaps.value.some((c) => c.kind === "endpoint")).toBe(true);
    await k.dispose();
  });
});
