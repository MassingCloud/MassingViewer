import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { asModelId, isGuid } from "@massing/core";
import { EntityTable } from "@massing/ifc";
import { LocalKernelCore } from "./core.js";
import { LocalModel } from "./model.js";
import { compressUuid, countingGuidMinter, decompressUuid, randomGuidMinter } from "./guid.js";
import { BLANK_IFC4 } from "./blank.js";

const SAMPLE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/sample.ifc"),
  "utf8",
);
const MODEL = asModelId("test");

/** A kernel with deterministic ids, so failures name "the third element created" rather than a random string. */
function kernel(): LocalKernelCore {
  return new LocalKernelCore(countingGuidMinter());
}

function open(ifc?: string): LocalKernelCore {
  const k = kernel();
  const r = k.open(MODEL, ifc);
  expect(r.ok, r.ok ? "" : r.error.message).toBe(true);
  return k;
}

function apply(k: LocalKernelCore, op: string, params: Record<string, unknown>) {
  return k.apply(MODEL, op, params);
}

function mustApply(k: LocalKernelCore, op: string, params: Record<string, unknown>) {
  const r = apply(k, op, params);
  if (!r.ok) throw new Error(`${op} failed: ${r.error.code} — ${r.error.message}`);
  return r.value;
}

describe("GlobalId minting", () => {
  it("round-trips a UUID through the compressed form", () => {
    const bytes = new Uint8Array([0x30, 0x51, 0x72, 0x93, 0xb4, 0xd5, 0x46, 0x17, 0x98, 0x39, 0x5a, 0x7b, 0x9c, 0xbd, 0xde, 0xff]);
    const guid = compressUuid(bytes);
    expect(guid).toHaveLength(22);
    expect(isGuid(guid)).toBe(true);
    expect([...decompressUuid(guid)]).toEqual([...bytes]);
  });

  it("mints valid, version-4, distinct ids", () => {
    const mint = randomGuidMinter();
    const ids = Array.from({ length: 200 }, () => mint());
    for (const id of ids) {
      expect(isGuid(id), id).toBe(true);
      const bytes = decompressUuid(id);
      // A GlobalId that does not decompress to a well-formed UUID cannot be matched against an external
      // database, which is half of what GlobalIds are for.
      expect(bytes[6]! & 0xf0).toBe(0x40);
      expect(bytes[8]! & 0xc0).toBe(0x80);
    }
    expect(new Set(ids).size).toBe(200);
  });

  it("the first character is always 0-3, as a compressed UUID's must be", () => {
    const mint = randomGuidMinter();
    for (let i = 0; i < 50; i++) expect("0123").toContain(mint()[0]!);
  });

  it("refuses a wrong-sized UUID rather than truncating", () => {
    expect(() => compressUuid(new Uint8Array(15))).toThrow(/16 bytes/);
    expect(() => decompressUuid("tooshort")).toThrow(/22 characters/);
  });
});

describe("opening models", () => {
  it("the blank model is valid, authorable and byte-stable", () => {
    const table = EntityTable.parse(BLANK_IFC4);
    expect(table.schema).toBe("IFC4");
    // The whole point of the blank file: it already has everything an element needs to be visible.
    expect(table.byType("IFCPROJECT")).toHaveLength(1);
    expect(table.byType("IFCBUILDINGSTOREY")).toHaveLength(1);
    expect(table.byType("IFCGEOMETRICREPRESENTATIONSUBCONTEXT")).toHaveLength(1);
    expect(table.emit()).toBe(BLANK_IFC4);

    for (const id of table.ids()) {
      const guid = table.guidOf(id);
      if (guid !== null) expect(isGuid(guid), `#${id}`).toBe(true);
    }
  });

  it("finds the existing context in a real file rather than inventing one", () => {
    const k = kernel();
    const opened = k.open(MODEL, SAMPLE);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    // Counted from the file rather than hardcoded: a literal here failed as "the kernel stopped finding
    // elements" when the fixture grew a property set, which is the opposite of what had happened.
    expect(opened.value.elements).toBe((SAMPLE.match(/^#\d+=/gm) ?? []).length);
    // Inventing a representation context when the file already has one produces elements attached to a
    // different context — valid, and invisible in the same viewer that shows the rest of the model.
    expect(opened.value.created).toEqual([]);
  });

  it("refuses an unreadable file as the user's problem, not an internal error", () => {
    const k = kernel();
    const r = k.open(MODEL, "this is not an IFC file at all");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // `refused` rather than `internal`: the UI shows an error, not an incident report.
    expect(r.error.code).toBe("refused");
  });

  it("reports operations on a model that is not open", () => {
    const k = kernel();
    const r = k.apply(MODEL, "add_wall", { start: [0, 0], end: [1, 0] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("no_such_element");
  });
});

describe("authoring produces IFC that reads back", () => {
  it("a wall is created, contained, and round-trips through export", () => {
    const k = open();
    const result = mustApply(k, "add_wall", {
      start: [0, 0],
      end: [5, 0],
      height: 3,
      thickness: 0.2,
      name: "Wall-A",
    });
    expect(result.created).toHaveLength(1);
    const guid = result.created[0]!;
    expect(isGuid(guid)).toBe(true);
    expect(result.summary.length).toBeCloseTo(5, 9);

    const exported = k.exportIfc(MODEL);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    // Re-parsed from scratch: this is the check that the emitted text is actually valid IFC rather than merely
    // something this package can read back.
    const table = EntityTable.parse(exported.value);
    const id = table.idOfGuid(guid);
    expect(id).toBeDefined();
    expect(table.typeOf(id!)).toBe("IFCWALL");
    expect(table.params(id!)[2]).toEqual({ k: "str", v: "Wall-A" });

    // Contained in the storey, via the storey's existing relationship rather than a second one.
    expect(table.byType("IFCRELCONTAINEDINSPATIALSTRUCTURE")).toHaveLength(1);
    // And it has geometry attached to the Body context.
    expect(table.byType("IFCEXTRUDEDAREASOLID")).toHaveLength(1);
  });

  it("many walls share one containment relationship", () => {
    // Two relationships for one storey means elements that appear in the tree for some readers and not others,
    // because IFC permits only one containment per element and readers differ on which they honour.
    const k = open();
    for (let i = 0; i < 5; i++) mustApply(k, "add_wall", { start: [0, i], end: [4, i] });
    const exported = k.exportIfc(MODEL);
    if (!exported.ok) throw new Error("export failed");
    const table = EntityTable.parse(exported.value);
    expect(table.byType("IFCRELCONTAINEDINSPATIALSTRUCTURE")).toHaveLength(1);
    const related = table.params(table.byType("IFCRELCONTAINEDINSPATIALSTRUCTURE")[0]!)[4];
    expect(related?.k).toBe("list");
    if (related?.k === "list") expect(related.v).toHaveLength(5);
  });

  it("a slab, a column and a beam all produce their own class", () => {
    const k = open();
    mustApply(k, "add_slab", { points: [[0, 0], [4, 0], [4, 3], [0, 3]], thickness: 0.2 });
    mustApply(k, "add_column", { point: [2, 2], height: 3 });
    mustApply(k, "add_beam", { start: [0, 0], end: [4, 0] });

    const exported = k.exportIfc(MODEL);
    if (!exported.ok) throw new Error("export failed");
    const table = EntityTable.parse(exported.value);
    expect(table.byType("IFCSLAB")).toHaveLength(1);
    expect(table.byType("IFCCOLUMN")).toHaveLength(1);
    expect(table.byType("IFCBEAM")).toHaveLength(1);
  });

  it("a door records the void semantically and says that the mesh is not cut", () => {
    const k = open();
    const wall = mustApply(k, "add_wall", { start: [0, 0], end: [5, 0] }).created[0]!;
    const door = mustApply(k, "add_door", { host_guid: wall, width: 0.9, height: 2.1, position: 2 });

    // An opening and the door itself.
    expect(door.created).toHaveLength(2);
    expect(door.modified).toEqual([wall]);
    // The honest declaration, carried in the result rather than left for a user to discover by looking at a
    // wall with no doorway in it.
    expect(String(door.summary.approximation)).toMatch(/not subtracted from the host mesh/);

    const exported = k.exportIfc(MODEL);
    if (!exported.ok) throw new Error("export failed");
    const table = EntityTable.parse(exported.value);
    expect(table.byType("IFCOPENINGELEMENT")).toHaveLength(1);
    expect(table.byType("IFCDOOR")).toHaveLength(1);
    // These two relationships are what make the exported file correct in tools that do their own voiding.
    expect(table.byType("IFCRELVOIDSELEMENT")).toHaveLength(1);
    expect(table.byType("IFCRELFILLSELEMENT")).toHaveLength(1);
  });

  it("refuses a door in something that is not a wall", () => {
    const k = open();
    const slab = mustApply(k, "add_slab", { points: [[0, 0], [4, 0], [4, 3], [0, 3]] }).created[0]!;
    const r = apply(k, "add_door", { host_guid: slab });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("refused");
      expect(r.error.message).toMatch(/needs a wall/);
    }
  });

  it("a property set attaches and reads back through properties()", () => {
    const k = open();
    const wall = mustApply(k, "add_wall", { start: [0, 0], end: [5, 0] }).created[0]!;
    mustApply(k, "set_element_pset", {
      guid: wall,
      pset: "Pset_WallCommon",
      properties: { FireRating: "60min", LoadBearing: true, ThermalTransmittance: 0.24, Layers: 3 },
    });

    const props = k.properties(MODEL, [wall]);
    expect(props.ok).toBe(true);
    if (!props.ok) return;
    const entry = props.value.get(wall);
    expect(entry?.ifcClass).toBe("IfcWall");
    expect(entry?.psets.Pset_WallCommon).toEqual({
      FireRating: "60min",
      // `.T.` becomes a boolean, not the string "T" — a checkbox in the property grid, not the letter T.
      LoadBearing: true,
      ThermalTransmittance: 0.24,
      Layers: 3,
    });
  });
});

describe("editing", () => {
  it("move translates and reports where it went", () => {
    const k = open();
    const wall = mustApply(k, "add_wall", { start: [1, 2], end: [6, 2] }).created[0]!;
    const moved = mustApply(k, "move_element", { guid: wall, dx: 3, dy: -1 });
    expect(moved.modified).toEqual([wall]);
    expect(moved.summary.to).toEqual([4, 1, 0]);
    // And the GlobalId is unchanged, which is the invariant everything downstream depends on.
    const exported = k.exportIfc(MODEL);
    if (!exported.ok) throw new Error("export failed");
    expect(EntityTable.parse(exported.value).idOfGuid(wall)).toBeDefined();
  });

  it("a door moves with the wall it sits in", () => {
    // The reason openings are parented to the host's placement and the reason `move_element` edits the existing
    // point rather than creating a new one. If this fails, a moved wall leaves its doorway behind.
    const k = open();
    const wall = mustApply(k, "add_wall", { start: [0, 0], end: [5, 0] }).created[0]!;
    mustApply(k, "add_door", { host_guid: wall, position: 2 });

    const before = k.exportIfc(MODEL);
    if (!before.ok) throw new Error("export failed");
    const openingBefore = openingWorldX(before.value);

    mustApply(k, "move_element", { guid: wall, dx: 10 });
    const after = k.exportIfc(MODEL);
    if (!after.ok) throw new Error("export failed");
    expect(openingWorldX(after.value)).toBeCloseTo(openingBefore + 10, 6);
  });

  it("rotation composes rather than replacing", () => {
    const k = open();
    const col = mustApply(k, "add_column", { point: [0, 0] }).created[0]!;
    const first = mustApply(k, "rotate_element", { guid: col, degrees: 45 });
    const second = mustApply(k, "rotate_element", { guid: col, degrees: 45 });
    expect(first.summary.toRad as number).toBeCloseTo(Math.PI / 4, 9);
    // Two 45-degree turns make 90. An absolute setter would leave this at 45 and make drag-to-rotate wrong.
    expect(second.summary.toRad as number).toBeCloseTo(Math.PI / 2, 9);
  });

  it("copy shares geometry and offsets the placement", () => {
    const k = open();
    const wall = mustApply(k, "add_wall", { start: [0, 0], end: [5, 0] }).created[0]!;
    const copy = mustApply(k, "copy_element", { guid: wall, dx: 0, dy: 3 });
    expect(copy.created).toHaveLength(1);
    expect(copy.created[0]).not.toBe(wall);

    const exported = k.exportIfc(MODEL);
    if (!exported.ok) throw new Error("export failed");
    const table = EntityTable.parse(exported.value);
    expect(table.byType("IFCWALL")).toHaveLength(2);
    // One profile and one solid for two walls — sharing the representation is correct IFC and is what makes an
    // array of a hundred elements not a hundred copies of one profile.
    expect(table.byType("IFCEXTRUDEDAREASOLID")).toHaveLength(1);
  });

  it("delete unlinks before it removes, leaving no dangling reference", () => {
    const k = open();
    const wall = mustApply(k, "add_wall", { start: [0, 0], end: [5, 0] }).created[0]!;
    mustApply(k, "set_element_pset", { guid: wall, pset: "P", properties: { a: 1 } });
    const deleted = mustApply(k, "delete_element", { guid: wall });
    expect(deleted.deleted).toEqual([wall]);

    const exported = k.exportIfc(MODEL);
    if (!exported.ok) throw new Error("export failed");
    const table = EntityTable.parse(exported.value);
    expect(table.idOfGuid(wall)).toBeUndefined();
    // The containment relationship held only this wall, so it goes rather than being left with an empty set —
    // which is invalid IFC, the attribute being a non-empty SET.
    expect(table.byType("IFCRELCONTAINEDINSPATIALSTRUCTURE")).toHaveLength(0);
    expect(table.byType("IFCRELDEFINESBYPROPERTIES")).toHaveLength(0);
    // And nothing anywhere still points at the removed entity.
    expect(danglingRefs(table)).toEqual([]);
  });

  it("set_extrusion_depth changes the height and refuses non-extrusions", () => {
    const k = open();
    const wall = mustApply(k, "add_wall", { start: [0, 0], end: [5, 0], height: 3 }).created[0]!;
    mustApply(k, "set_extrusion_depth", { guid: wall, depth: 4.5 });

    const exported = k.exportIfc(MODEL);
    if (!exported.ok) throw new Error("export failed");
    const table = EntityTable.parse(exported.value);
    const solid = table.byType("IFCEXTRUDEDAREASOLID")[0]!;
    expect(table.params(solid)[3]).toEqual({ k: "num", v: 4.5, raw: "4.5" });

    // A storey has no extrusion, and the refusal has to be `not_an_extrusion` so the UI can say what is wrong
    // rather than "operation failed" — and so both kernels refuse identically. See kernel-api's note.
    const storeys = k.spatialTree(MODEL);
    expect(storeys.ok).toBe(true);
    const storeyGuid = findStoreyGuid(k);
    const refused = apply(k, "set_extrusion_depth", { guid: storeyGuid, depth: 2 });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("not_an_extrusion");
  });

  it("set_wall_thickness keeps the wall's length", () => {
    const k = open();
    const wall = mustApply(k, "add_wall", { start: [0, 0], end: [5, 0], thickness: 0.2 }).created[0]!;
    const changed = mustApply(k, "set_wall_thickness", { guid: wall, thickness: 0.35 });
    // Changing thickness must not require restating geometry the caller did not ask to change.
    expect(changed.summary.length).toBeCloseTo(5, 6);
    expect(changed.summary.thickness).toBe(0.35);
  });
});

describe("refusals are specific", () => {
  it("a zero-length wall is degenerate geometry, not a bad parameter", () => {
    const k = open();
    const r = apply(k, "add_wall", { start: [1, 1], end: [1, 1] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("degenerate_geometry");
      expect(r.error.message).toMatch(/not the same point/);
    }
  });

  it("a zero-area outline is refused rather than extruded to nothing", () => {
    const k = open();
    const r = apply(k, "add_slab", { points: [[0, 0], [1, 0], [2, 0]] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("degenerate_geometry");
  });

  it("a non-positive dimension names the parameter", () => {
    const k = open();
    const r = apply(k, "add_wall", { start: [0, 0], end: [5, 0], height: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("degenerate_geometry");
      expect(r.error.detail?.param).toBe("height");
    }
  });

  it("a missing required parameter is invalid_param", () => {
    const k = open();
    const r = apply(k, "add_wall", { start: [0, 0] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("invalid_param");
  });

  it("an unknown GlobalId is no_such_element", () => {
    const k = open();
    const r = apply(k, "move_element", { guid: "aaaaaaaaaaaaaaaaaaaaaa", dx: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("no_such_element");
  });

  it("an unimplemented op is unsupported, with a hint naming what would unlock it", () => {
    const k = open();
    const r = apply(k, "program_fit", {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("unsupported");
      // The hint is the dimmed control's tooltip, so it has to say what to do, not that something failed.
      expect(r.error.message).toMatch(/Massing authoring service/);
    }
  });

  it("a refused operation leaves the model exactly as it was", () => {
    // The reason `apply` snapshots before running: a half-applied op would leave orphaned geometry with no
    // product referencing it, and nothing would ever report that.
    const k = open();
    mustApply(k, "add_wall", { start: [0, 0], end: [5, 0] });
    const before = k.exportIfc(MODEL);
    if (!before.ok) throw new Error("export failed");

    expect(apply(k, "add_slab", { points: [[0, 0], [1, 0], [2, 0]] }).ok).toBe(false);
    expect(apply(k, "add_wall", { start: [0, 0], end: [0, 0] }).ok).toBe(false);

    const after = k.exportIfc(MODEL);
    if (!after.ok) throw new Error("export failed");
    expect(after.value).toBe(before.value);
  });
});

describe("versions and undo", () => {
  it("a property edit advances the model version but not the geometry version", () => {
    const k = open();
    const wall = mustApply(k, "add_wall", { start: [0, 0], end: [5, 0] }).created[0]!;
    const before = k.versions(MODEL);
    if (!before.ok) throw new Error("versions failed");

    const edit = mustApply(k, "set_element_pset", { guid: wall, pset: "P", properties: { a: 1 } });
    expect(edit.modelVersion).not.toBe(before.value.modelVersion);
    // If this changed, every property edit would re-stream the whole model.
    expect(edit.geometryVersion).toBe(before.value.geometryVersion);
  });

  it("a stale write is refused, never silently applied", () => {
    const k = open();
    mustApply(k, "add_wall", { start: [0, 0], end: [5, 0] });
    const r = k.apply(MODEL, "add_wall", { start: [0, 1], end: [5, 1] }, { expectedVersion: "1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("version_conflict");
  });

  it("undo restores the previous state, including for a delete", () => {
    // `delete_element` declares `invertible: false` — there is no inverse op to replay. Snapshot transactions
    // undo it anyway, which is exactly why `capabilities.transactions` is declared per kernel rather than
    // assumed.
    const k = open();
    const wall = mustApply(k, "add_wall", { start: [0, 0], end: [5, 0] }).created[0]!;
    const withWall = k.exportIfc(MODEL);
    if (!withWall.ok) throw new Error("export failed");

    mustApply(k, "delete_element", { guid: wall });
    const undone = k.undo(MODEL);
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.value.label).toBe("delete_element");

    const restored = k.exportIfc(MODEL);
    if (!restored.ok) throw new Error("export failed");
    expect(restored.value).toBe(withWall.value);
  });

  it("undo on an untouched model refuses rather than throwing", () => {
    const k = open();
    const r = k.undo(MODEL);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("refused");
  });
});

describe("reads", () => {
  it("the spatial tree nests project → site → building → storey → element", () => {
    const k = open();
    mustApply(k, "add_wall", { start: [0, 0], end: [5, 0], name: "W" });
    const tree = k.spatialTree(MODEL);
    expect(tree.ok).toBe(true);
    if (!tree.ok) return;

    expect(tree.value.ifcClass).toBe("IfcProject");
    const site = tree.value.children[0]!;
    expect(site.ifcClass).toBe("IfcSite");
    const building = site.children[0]!;
    expect(building.ifcClass).toBe("IfcBuilding");
    const storey = building.children[0]!;
    expect(storey.ifcClass).toBe("IfcBuildingStorey");
    expect(storey.elevation).toBe(0);
    // A wall is *contained* by a storey, not aggregated into it. Conflating the two puts walls inside walls.
    expect(storey.children.map((c) => c.ifcClass)).toEqual(["IfcWall"]);
  });

  it("the real fixture yields a full tree with all six elements", () => {
    const k = open(SAMPLE);
    const tree = k.spatialTree(MODEL);
    expect(tree.ok).toBe(true);
    if (!tree.ok) return;
    const classes: string[] = [];
    const walk = (n: typeof tree.value): void => {
      classes.push(n.ifcClass);
      for (const c of n.children) walk(c);
    };
    walk(tree.value);
    expect(classes.filter((c) => c === "IfcWall")).toHaveLength(4);
    expect(classes).toContain("IfcSlab");
    expect(classes).toContain("IfcColumn");
  });

  it("snap candidates give a wall both endpoints and its midpoint", () => {
    const k = open();
    mustApply(k, "add_wall", { start: [0, 0], end: [6, 0] });
    const near = k.snapCandidates(MODEL, { x: 0, z: 0 }, 100);
    expect(near.ok).toBe(true);
    if (!near.ok) return;

    const xs = near.value.filter((c) => c.kind === "endpoint").map((c) => c.x).sort((a, b) => a - b);
    expect(xs).toEqual([0, 6]);
    const mid = near.value.find((c) => c.kind === "midpoint");
    expect(mid?.x).toBeCloseTo(3, 6);
    // Every candidate names the element it came from, so a snap can report what it snapped to.
    for (const c of near.value) expect(c.guid).toBeDefined();
  });

  it("snap candidates respect the radius", () => {
    const k = open();
    mustApply(k, "add_wall", { start: [50, 50], end: [56, 50] });
    const far = k.snapCandidates(MODEL, { x: 0, z: 0 }, 1);
    expect(far.ok).toBe(true);
    if (far.ok) expect(far.value).toEqual([]);
  });

  it("declares exactly the fifteen operations, all serialisable", () => {
    const k = kernel();
    const ops = k.ops();
    expect(ops).toHaveLength(15);
    // `ops()` crosses a message boundary, so anything unserialisable here is a runtime failure in the Worker.
    expect(() => structuredClone(ops)).not.toThrow();
    for (const op of ops) {
      expect(op.id).toMatch(/^[a-z_]+$/);
      expect(op.category).not.toBe("");
      expect(op.params.every((p) => p.name !== "")).toBe(true);
    }
    expect(ops.find((o) => o.id === "delete_element")?.invertible).toBe(false);
  });
});

describe("units", () => {
  it("a millimetre file is read and written in millimetres", () => {
    // The most common way an IFC integration produces nonsense: a millimetre file read as metres gives a
    // building 1000x too large, and the symptom — an empty viewport, because the camera fit to something the
    // size of a city — looks nothing like a units bug.
    const mm = BLANK_IFC4.replace(
      "#2= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);",
      "#2= IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);",
    );
    const model = new LocalModel(EntityTable.parse(mm), countingGuidMinter());
    expect(model.lengthScale).toBe(0.001);

    const k = open(mm);
    mustApply(k, "add_wall", { start: [0, 0], end: [5, 0], height: 3 });
    const exported = k.exportIfc(MODEL);
    if (!exported.ok) throw new Error("export failed");
    const table = EntityTable.parse(exported.value);
    const solid = table.byType("IFCEXTRUDEDAREASOLID")[0]!;
    // 3 metres written into a millimetre file is 3000.
    expect(table.params(solid)[3]).toEqual({ k: "num", v: 3000, raw: "3000." });
  });

  it("an imperial conversion-based unit is understood", () => {
    const feet = BLANK_IFC4.replace(
      "#2= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);",
      "#2= IFCCONVERSIONBASEDUNIT(#1,.LENGTHUNIT.,'FOOT',#100);\n#100= IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#101);\n#101= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);",
    );
    const model = new LocalModel(EntityTable.parse(feet), countingGuidMinter());
    expect(model.lengthScale).toBeCloseTo(0.3048, 9);
  });
});

// ---------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------

/** World X of the opening's placement, following the parent chain. */
function openingWorldX(ifc: string): number {
  const table = EntityTable.parse(ifc);
  const opening = table.byType("IFCOPENINGELEMENT")[0]!;
  let placement = table.params(opening)[5];
  let x = 0;
  const seen = new Set<number>();
  while (placement?.k === "ref" && !seen.has(placement.v)) {
    seen.add(placement.v);
    const params = table.params(placement.v);
    const axis = params[1];
    if (axis?.k === "ref") {
      const originRef = table.params(axis.v)[0];
      if (originRef?.k === "ref") {
        const coords = table.params(originRef.v)[0];
        if (coords?.k === "list" && coords.v[0]?.k === "num") x += coords.v[0].v;
      }
    }
    placement = params[0];
  }
  return x;
}

/** Any `#id` referenced by a live entity that is not itself live. */
function danglingRefs(table: EntityTable): string[] {
  const live = new Set(table.ids());
  const bad: string[] = [];
  for (const id of table.ids()) {
    if (table.typeOf(id) === "") continue;
    const walk = (v: { k: string; v?: unknown }): void => {
      if (v.k === "ref" && !live.has(v.v as number)) bad.push(`#${id} → #${String(v.v)}`);
      if (v.k === "list" || v.k === "typed") for (const inner of v.v as { k: string }[]) walk(inner);
    };
    for (const p of table.params(id)) walk(p);
  }
  return bad;
}

function findStoreyGuid(k: LocalKernelCore): string {
  const tree = k.spatialTree(MODEL);
  if (!tree.ok) throw new Error("no tree");
  let found: string | null = null;
  const walk = (n: typeof tree.value): void => {
    if (n.ifcClass === "IfcBuildingStorey" && found === null) found = n.ref.guid;
    for (const c of n.children) walk(c);
  };
  walk(tree.value);
  if (found === null) throw new Error("no storey");
  return found;
}
