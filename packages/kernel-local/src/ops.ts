import { type Result, type Guid, err, ok } from "@massingviewer/core";
import { type KernelFailure, type OpDescriptor, type OpParams, kernelFailure } from "@massingviewer/kernel-api";
import { FALSE, type StepValue, TRUE, integer, list, real, ref, str } from "@massingviewer/ifc";
import type { LocalModel } from "./model";

/**
 * The operations `LocalKernel` implements, and only those.
 *
 * The set is the fifteen marked `planned` for `local` in `fixtures/recipes.tsv`: enough to make the
 * Architectural group of the element palette, the transform gizmo, push/pull, and the command line's verbs all
 * work with no server. Everything else in the 96 returns `unsupported` with a hint naming what would unlock it,
 * and the ribbon dims it with that sentence rather than hiding the control — see
 * `docs/adr/0001-two-kernels.md`.
 *
 * Each implementation returns the GlobalIds it touched, never expressIDs, because expressIDs do not survive a
 * rewrite and the caller persists what it is given.
 */

export interface OpEffect {
  readonly created: readonly Guid[];
  readonly modified: readonly Guid[];
  readonly deleted: readonly Guid[];
  readonly summary: Readonly<Record<string, unknown>>;
  /** False for a metadata-only change, so a property edit does not trigger a full geometry reload. */
  readonly geometryChanged: boolean;
}

type OpImpl = (model: LocalModel, params: OpParams) => Result<OpEffect, KernelFailure>;

// ---------------------------------------------------------------------------------------------------
// Parameter reading
// ---------------------------------------------------------------------------------------------------
//
// Every op validates before it writes anything. A half-applied operation is far worse than a refused one: the
// entity table would carry orphaned geometry with no product referencing it, and nothing would ever report it.

function num(params: OpParams, name: string, fallback?: number): Result<number, KernelFailure> {
  const raw = params[name];
  if (raw === undefined || raw === null) {
    if (fallback !== undefined) return ok(fallback);
    return err(kernelFailure("invalid_param", `"${name}" is required`, { param: name }));
  }
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return err(kernelFailure("invalid_param", `"${name}" must be a finite number, got ${JSON.stringify(raw)}`, { param: name }));
  }
  return ok(raw);
}

function positive(params: OpParams, name: string, fallback?: number): Result<number, KernelFailure> {
  const v = num(params, name, fallback);
  if (!v.ok) return v;
  if (v.value <= 0) {
    // `degenerate_geometry` rather than `invalid_param`: the value is a well-formed number, and what is wrong
    // is the shape it would produce. The distinction is what lets the UI say "a wall cannot have zero height"
    // instead of "bad parameter".
    return err(kernelFailure("degenerate_geometry", `"${name}" must be greater than zero, got ${v.value}`, { param: name }));
  }
  return ok(v.value);
}

function point(params: OpParams, name: string): Result<readonly [number, number], KernelFailure> {
  const raw = params[name];
  if (!Array.isArray(raw) || raw.length < 2 || !raw.slice(0, 2).every((n) => typeof n === "number" && Number.isFinite(n))) {
    return err(kernelFailure("invalid_param", `"${name}" must be a [x, y] pair of finite numbers`, { param: name }));
  }
  return ok([raw[0] as number, raw[1] as number]);
}

function polygon(params: OpParams, name: string): Result<readonly (readonly [number, number])[], KernelFailure> {
  const raw = params[name];
  if (!Array.isArray(raw)) {
    return err(kernelFailure("invalid_param", `"${name}" must be an array of [x, y] points`, { param: name }));
  }
  if (raw.length < 3) {
    return err(kernelFailure("degenerate_geometry", `a closed outline needs at least 3 points, got ${raw.length}`, { param: name }));
  }
  const out: [number, number][] = [];
  for (const [i, p] of raw.entries()) {
    if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== "number" || typeof p[1] !== "number" || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
      return err(kernelFailure("invalid_param", `"${name}"[${i}] must be a [x, y] pair of finite numbers`, { param: name }));
    }
    out.push([p[0], p[1]]);
  }
  if (Math.abs(signedArea(out)) < 1e-9) {
    // A zero-area outline extrudes to nothing. It renders as absent, which is indistinguishable from a failed
    // load — the failure mode this codebase keeps designing against.
    return err(kernelFailure("degenerate_geometry", "the outline encloses no area", { param: name }));
  }
  return ok(out);
}

function signedArea(points: readonly (readonly [number, number])[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[(i + 1) % points.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function text(params: OpParams, name: string): string | null {
  const raw = params[name];
  return typeof raw === "string" && raw !== "" ? raw : null;
}

/** Resolve a GlobalId parameter to an expressID, refusing rather than guessing. */
function element(model: LocalModel, params: OpParams, name = "guid"): Result<{ id: number; guid: Guid }, KernelFailure> {
  const raw = params[name];
  if (typeof raw !== "string" || raw === "") {
    return err(kernelFailure("invalid_param", `"${name}" must be an IFC GlobalId`, { param: name }));
  }
  const id = model.table.idOfGuid(raw);
  if (id === undefined) {
    return err(kernelFailure("no_such_element", `no element with GlobalId ${raw}`, { guid: raw }));
  }
  return ok({ id, guid: raw as Guid });
}

// ---------------------------------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------------------------------

/** The rectangle a wall's centre-line and thickness describe, in the wall's own coordinates. */
function wallProfilePoints(length: number, thickness: number): readonly (readonly [number, number])[] {
  const h = thickness / 2;
  return [
    [0, -h],
    [length, -h],
    [length, h],
    [0, h],
  ];
}

interface PlacedExtrusion {
  readonly profileId: number;
  readonly solidId: number;
  readonly shapeId: number;
  readonly placementId: number;
}

function placeExtrusion(
  model: LocalModel,
  points: readonly (readonly [number, number])[],
  height: number,
  at: readonly [number, number],
  z: number,
  rotation: number,
  storeyId: number | null,
  profileName?: string,
): PlacedExtrusion {
  const profileId = model.closedProfile(points, profileName);
  const solidId = model.extrude(profileId, height);
  const shapeId = model.bodyShape(solidId);
  const parent = storeyId === null ? null : model.storeyPlacement(storeyId);
  const placementId = model.placement(at[0], at[1], z, rotation, parent);
  return { profileId, solidId, shapeId, placementId };
}

function created(guid: Guid, summary: Record<string, unknown>): OpEffect {
  return { created: [guid], modified: [], deleted: [], summary, geometryChanged: true };
}

// ---------------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------------

const addWall: OpImpl = (model, params) => {
  const start = point(params, "start");
  if (!start.ok) return start;
  const end = point(params, "end");
  if (!end.ok) return end;
  const height = positive(params, "height", 3);
  if (!height.ok) return height;
  const thickness = positive(params, "thickness", 0.2);
  if (!thickness.ok) return thickness;

  const dx = end.value[0] - start.value[0];
  const dy = end.value[1] - start.value[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) {
    // The refusal `placeValid.ts` already makes on the client, restated here because the kernel is the
    // authority — and because the conformance suite asserts both kernels refuse the same way.
    return err(
      kernelFailure("degenerate_geometry", "a wall needs a start and end that are not the same point", {
        length,
      }),
    );
  }

  const storeyId = model.resolveStorey(text(params, "storey"));
  const { placementId, shapeId } = placeExtrusion(
    model,
    wallProfilePoints(length, thickness.value),
    height.value,
    start.value,
    0,
    Math.atan2(dy, dx),
    storeyId,
    "Wall Profile",
  );

  const { id, guid } = model.product(
    "IFCWALL",
    text(params, "name") ?? "Wall",
    placementId,
    shapeId,
    [{ k: "enum", v: "NOTDEFINED" }],
  );
  if (storeyId !== null) model.contain(id, storeyId);
  return ok(created(guid, { length, height: height.value, thickness: thickness.value }));
};

const addSlab: OpImpl = (model, params) => {
  const outline = polygon(params, "points");
  if (!outline.ok) return outline;
  const thickness = positive(params, "thickness", 0.2);
  if (!thickness.ok) return thickness;
  const elevation = num(params, "elevation", 0);
  if (!elevation.ok) return elevation;

  const storeyId = model.resolveStorey(text(params, "storey"));
  // A slab is extruded *down* from its top in most conventions, but IfcExtrudedAreaSolid only goes along its
  // own +Z. Placing the solid's origin a thickness below the datum gives the same result without a negative
  // extrusion, which some readers reject.
  const { placementId, shapeId } = placeExtrusion(
    model,
    outline.value,
    thickness.value,
    [0, 0],
    elevation.value - thickness.value,
    0,
    storeyId,
    "Slab Profile",
  );

  const { id, guid } = model.product("IFCSLAB", text(params, "name") ?? "Slab", placementId, shapeId, [
    { k: "enum", v: "FLOOR" },
  ]);
  if (storeyId !== null) model.contain(id, storeyId);
  return ok(created(guid, { area: Math.abs(signedArea(outline.value)), thickness: thickness.value }));
};

const addColumn: OpImpl = (model, params) => {
  const at = point(params, "point");
  if (!at.ok) return at;
  const height = positive(params, "height", 3);
  if (!height.ok) return height;
  const width = positive(params, "width", 0.4);
  if (!width.ok) return width;
  const depth = positive(params, "depth", 0.4);
  if (!depth.ok) return depth;

  const storeyId = model.resolveStorey(text(params, "storey"));
  const w = width.value / 2;
  const d = depth.value / 2;
  const { placementId, shapeId } = placeExtrusion(
    model,
    [
      [-w, -d],
      [w, -d],
      [w, d],
      [-w, d],
    ],
    height.value,
    at.value,
    0,
    num(params, "rotation", 0).ok ? ((params.rotation as number | undefined) ?? 0) : 0,
    storeyId,
    "Column Profile",
  );

  const { id, guid } = model.product("IFCCOLUMN", text(params, "name") ?? "Column", placementId, shapeId, [
    { k: "enum", v: "COLUMN" },
  ]);
  if (storeyId !== null) model.contain(id, storeyId);
  return ok(created(guid, { width: width.value, depth: depth.value, height: height.value }));
};

const addBeam: OpImpl = (model, params) => {
  const start = point(params, "start");
  if (!start.ok) return start;
  const end = point(params, "end");
  if (!end.ok) return end;
  const width = positive(params, "width", 0.3);
  if (!width.ok) return width;
  const depth = positive(params, "depth", 0.5);
  if (!depth.ok) return depth;
  const elevation = num(params, "elevation", 3);
  if (!elevation.ok) return elevation;

  const dx = end.value[0] - start.value[0];
  const dy = end.value[1] - start.value[1];
  const span = Math.hypot(dx, dy);
  if (span < 1e-6) {
    return err(kernelFailure("degenerate_geometry", "a beam needs a start and end that are not the same point", { span }));
  }

  const storeyId = model.resolveStorey(text(params, "storey"));
  // Extruded along its own +Z then laid down would need a rotated axis; instead the beam is extruded
  // vertically through its own depth and rotated in plan, which keeps every solid axis-aligned in its local
  // frame. The section is width × depth and the length is the span.
  const { placementId, shapeId } = placeExtrusion(
    model,
    [
      [0, -width.value / 2],
      [span, -width.value / 2],
      [span, width.value / 2],
      [0, width.value / 2],
    ],
    depth.value,
    start.value,
    elevation.value - depth.value,
    Math.atan2(dy, dx),
    storeyId,
    "Beam Profile",
  );

  const { id, guid } = model.product("IFCBEAM", text(params, "name") ?? "Beam", placementId, shapeId, [
    { k: "enum", v: "BEAM" },
  ]);
  if (storeyId !== null) model.contain(id, storeyId);
  return ok(created(guid, { span, width: width.value, depth: depth.value }));
};

const addStorey: OpImpl = (model, params) => {
  const elevation = num(params, "elevation");
  if (!elevation.ok) return elevation;
  const name = text(params, "name") ?? `Level ${model.storeys().length + 1}`;

  const existing = model.storeys();
  if (existing.some((s) => Math.abs(s.elevation - elevation.value) < 1e-6)) {
    return err(
      kernelFailure("refused", `a storey already exists at ${elevation.value} m`, { elevation: elevation.value }),
    );
  }

  const placementId = model.placement(0, 0, elevation.value);
  const { id, guid } = model.product("IFCBUILDINGSTOREY", name, placementId, null, [
    { k: "unset" }, // LongName
    { k: "enum", v: "ELEMENT" }, // CompositionType
    real(model.toFile(elevation.value)),
  ]);

  // Attach to the building, so the storey appears in the spatial tree rather than floating unreferenced.
  const buildingId = model.table.byType("IFCBUILDING")[0];
  if (buildingId !== undefined) {
    const aggregates = model.table
      .byType("IFCRELAGGREGATES")
      .find((relId) => {
        const relating = model.table.params(relId)[4];
        return relating?.k === "ref" && relating.v === buildingId;
      });
    if (aggregates !== undefined) {
      const objects = model.table.params(aggregates)[5];
      const members = objects?.k === "list" ? [...objects.v] : [];
      model.table.setParam(aggregates, 5, list([...members, ref(id)]));
    }
  }
  return ok({
    created: [guid],
    modified: [],
    deleted: [],
    summary: { name, elevation: elevation.value },
    // A storey is not drawn. Reporting a geometry change would make every level added re-stream the model.
    geometryChanged: false,
  });
};

/**
 * A door or window: an `IfcOpeningElement` voiding its host, plus the filling product.
 *
 * ## What this does and does not do, stated rather than implied
 *
 * The *file* is fully semantic: the opening exists, `IfcRelVoidsElement` links it to the host, and
 * `IfcRelFillsElement` links the door to the opening. Exported IFC therefore opens correctly in any tool that
 * performs its own voiding, which is most of them.
 *
 * The *render* is not cut. Subtracting the opening from the host mesh needs a boolean, and until `manifold-3d`
 * lands (see `docs/adr/0008-local-kernel-geometry-stack.md`) there isn't one. So the wall still renders solid
 * with the door sitting in it. That is declared in the op's `summary.approximation` and reported by the
 * tessellator's skipped list rather than left for a user to notice — a viewer quietly showing a wall where a
 * doorway should be is the exact failure this codebase keeps designing against.
 */
function addOpening(kind: "door" | "window", ifcClass: string, defaultSill: number): OpImpl {
  return (model, params) => {
    const host = element(model, params, "host_guid");
    if (!host.ok) return host;
    const width = positive(params, "width", kind === "door" ? 0.9 : 1.2);
    if (!width.ok) return width;
    const height = positive(params, "height", kind === "door" ? 2.1 : 1.2);
    if (!height.ok) return height;
    const sill = num(params, "sill", defaultSill);
    if (!sill.ok) return sill;
    // Distance along the host wall's centre-line.
    const along = num(params, "position", 0.5);
    if (!along.ok) return along;

    const hostType = model.table.typeOf(host.value.id);
    if (hostType !== "IFCWALL" && hostType !== "IFCWALLSTANDARDCASE") {
      return err(
        kernelFailure("refused", `a ${kind} needs a wall to sit in; ${host.value.guid} is an ${hostType}`, {
          host: host.value.guid,
          hostType,
        }),
      );
    }

    const hostPlacement = model.table.params(host.value.id)[5];
    const parentPlacement = hostPlacement?.k === "ref" ? hostPlacement.v : null;

    // The opening is a box through the wall. Its depth is deliberately generous so it cuts cleanly once
    // booleans exist, rather than leaving a coincident-face artefact.
    const t = 1;
    const openingShape = placeExtrusion(
      model,
      [
        [0, -t],
        [width.value, -t],
        [width.value, t],
        [0, t],
      ],
      height.value,
      [along.value, 0],
      sill.value,
      0,
      null,
    );
    // Re-parent onto the host's placement so the opening travels with the wall when the wall moves.
    model.table.setParam(openingShape.placementId, 0, parentPlacement === null ? { k: "unset" } : ref(parentPlacement));

    const opening = model.product(
      "IFCOPENINGELEMENT",
      `${kind === "door" ? "Door" : "Window"} Opening`,
      openingShape.placementId,
      openingShape.shapeId,
      [{ k: "enum", v: "OPENING" }],
    );

    model.relationship("IFCRELVOIDSELEMENT", [ref(host.value.id), ref(opening.id)]);

    // The filling product shares the opening's placement, so moving the opening moves both.
    const filling = model.product(
      ifcClass,
      text(params, "name") ?? (kind === "door" ? "Door" : "Window"),
      openingShape.placementId,
      null,
      [
        real(model.toFile(height.value)),
        real(model.toFile(width.value)),
        { k: "enum", v: "NOTDEFINED" },
        { k: "unset" },
        { k: "unset" },
      ],
    );

    model.relationship("IFCRELFILLSELEMENT", [ref(opening.id), ref(filling.id)]);

    const storeyId = model.resolveStorey(text(params, "storey"));
    if (storeyId !== null) model.contain(filling.id, storeyId);

    return ok({
      created: [opening.guid, filling.guid],
      modified: [host.value.guid],
      deleted: [],
      summary: {
        width: width.value,
        height: height.value,
        sill: sill.value,
        approximation:
          "the opening is recorded semantically (IfcRelVoidsElement) but not subtracted from the host mesh — " +
          "the wall will render solid until boolean support lands",
      },
      geometryChanged: true,
    });
  };
}

// ---------------------------------------------------------------------------------------------------
// Modify
// ---------------------------------------------------------------------------------------------------

const moveElement: OpImpl = (model, params) => {
  const target = element(model, params);
  if (!target.ok) return target;
  const dx = num(params, "dx", 0);
  if (!dx.ok) return dx;
  const dy = num(params, "dy", 0);
  if (!dy.ok) return dy;
  const dz = num(params, "dz", 0);
  if (!dz.ok) return dz;

  const origin = model.placementOrigin(target.value.id);
  if (origin === null) {
    return err(
      kernelFailure("refused", `${target.value.guid} has no placement to move`, { guid: target.value.guid }),
    );
  }

  const moved = [
    (origin.at[0] ?? 0) + dx.value,
    (origin.at[1] ?? 0) + dy.value,
    (origin.at[2] ?? 0) + dz.value,
  ];
  // Written back into the *existing* point entity rather than into a new one, so everything parented to this
  // placement travels with it — an opening in a wall, for instance, which is exactly why openings are placed
  // relative to their host.
  const width = Math.max(2, origin.at.length);
  model.table.setParam(origin.pointId, 0, list(moved.slice(0, width).map((v) => real(model.toFile(v)))));

  return ok({
    created: [],
    modified: [target.value.guid],
    deleted: [],
    summary: { from: origin.at, to: moved },
    geometryChanged: true,
  });
};

const rotateElement: OpImpl = (model, params) => {
  const target = element(model, params);
  if (!target.ok) return target;
  const degrees = num(params, "degrees");
  if (!degrees.ok) return degrees;

  const origin = model.placementOrigin(target.value.id);
  if (origin === null) {
    return err(
      kernelFailure("refused", `${target.value.guid} has no placement to rotate`, { guid: target.value.guid }),
    );
  }

  // Rotation is *relative*, so it composes: two 45-degree turns make 90. An absolute setter would force the
  // gizmo's drag-to-rotate to know the current angle, and would silently discard whatever rotation an element
  // was authored with.
  const existing = model.table.params(origin.axisId)[2];
  let current = 0;
  if (existing?.k === "ref") {
    const dir = model.table.params(existing.v)[0];
    if (dir?.k === "list") {
      const x = dir.v[0]?.k === "num" ? dir.v[0].v : 1;
      const y = dir.v[1]?.k === "num" ? dir.v[1].v : 0;
      current = Math.atan2(y, x);
    }
  }
  const next = current + (degrees.value * Math.PI) / 180;
  const dirId = model.table.add("IFCDIRECTION", [list([real(Math.cos(next)), real(Math.sin(next)), real(0)])]);
  model.table.setParam(origin.axisId, 2, ref(dirId));

  return ok({
    created: [],
    modified: [target.value.guid],
    deleted: [],
    summary: { degrees: degrees.value, fromRad: current, toRad: next },
    geometryChanged: true,
  });
};

const deleteElement: OpImpl = (model, params) => {
  const target = element(model, params);
  if (!target.ok) return target;

  // Unlink before removing, or the file keeps a containment relationship pointing at a missing entity — and a
  // dangling reference is a file some readers reject outright and others load with an element missing from the
  // tree but present in geometry.
  model.uncontain(target.value.id);
  for (const relType of ["IFCRELVOIDSELEMENT", "IFCRELFILLSELEMENT", "IFCRELDEFINESBYPROPERTIES"]) {
    for (const relId of [...model.table.byType(relType)]) {
      const params_ = model.table.params(relId);
      const touches = params_.some(
        (p) =>
          (p.k === "ref" && p.v === target.value.id) ||
          (p.k === "list" && p.v.some((m) => m.k === "ref" && m.v === target.value.id)),
      );
      if (touches) model.table.remove(relId);
    }
  }
  model.table.remove(target.value.id);

  return ok({
    created: [],
    modified: [],
    deleted: [target.value.guid],
    summary: { guid: target.value.guid },
    geometryChanged: true,
  });
};

const copyElement: OpImpl = (model, params) => {
  const target = element(model, params);
  if (!target.ok) return target;
  const dx = num(params, "dx", 0);
  if (!dx.ok) return dx;
  const dy = num(params, "dy", 0);
  if (!dy.ok) return dy;
  const dz = num(params, "dz", 0);
  if (!dz.ok) return dz;

  const type = model.table.typeOf(target.value.id);
  if (type === undefined || type === "") {
    return err(kernelFailure("no_such_element", `${target.value.guid} cannot be copied`, { guid: target.value.guid }));
  }

  const origin = model.placementOrigin(target.value.id);
  if (origin === null) {
    return err(
      kernelFailure("refused", `${target.value.guid} has no placement, so there is nothing to offset`, {
        guid: target.value.guid,
      }),
    );
  }

  // The copy gets its own placement and **shares the original's geometry**. Sharing the representation is
  // correct IFC and keeps a hundred-element array from carrying a hundred copies of one profile — and it means
  // editing the profile changes all of them, which is what "copy" means in a BIM tool rather than in a drawing
  // program.
  const axis = model.table.params(origin.axisId);
  const point = model.point3(
    (origin.at[0] ?? 0) + dx.value,
    (origin.at[1] ?? 0) + dy.value,
    (origin.at[2] ?? 0) + dz.value,
  );
  const copiedAxis = model.table.add("IFCAXIS2PLACEMENT3D", [
    ref(point),
    axis[1] ?? { k: "unset" },
    axis[2] ?? { k: "unset" },
  ]);
  const placementId = model.table.add("IFCLOCALPLACEMENT", [origin.parent, ref(copiedAxis)]);

  const source = [...model.table.params(target.value.id)];
  const guid = model.mintGuid();
  source[0] = str(guid);
  source[5] = ref(placementId);
  const id = model.table.add(type, source);

  const storeyId = model.resolveStorey(text(params, "storey"));
  if (storeyId !== null) model.contain(id, storeyId);

  return ok({
    created: [guid],
    modified: [],
    deleted: [],
    summary: { of: target.value.guid, offset: [dx.value, dy.value, dz.value] },
    geometryChanged: true,
  });
};

/** Find the `IfcExtrudedAreaSolid` behind a product, or explain why there isn't one. */
function extrusionOf(model: LocalModel, id: number, guid: Guid): Result<number, KernelFailure> {
  const shapeRef = model.table.params(id)[6];
  if (shapeRef?.k !== "ref") {
    return err(kernelFailure("not_an_extrusion", `${guid} has no geometry`, { guid }));
  }
  const reps = model.table.params(shapeRef.v)[2];
  if (reps?.k !== "list") {
    return err(kernelFailure("not_an_extrusion", `${guid} has no shape representation`, { guid }));
  }
  for (const rep of reps.v) {
    if (rep.k !== "ref") continue;
    const items = model.table.params(rep.v)[3];
    if (items?.k !== "list") continue;
    for (const item of items.v) {
      if (item.k === "ref" && model.table.typeOf(item.v) === "IFCEXTRUDEDAREASOLID") return ok(item.v);
    }
  }
  // A mesh-based or BREP element reaches here. Refusing by *code* rather than by message is what lets the UI
  // say "this element is not a simple extrusion" and the conformance suite assert the same refusal from both
  // kernels — see the `not_an_extrusion` note in kernel-api.
  return err(
    kernelFailure("not_an_extrusion", `${guid} is not built from a single extruded profile`, { guid }),
  );
}

const setExtrusionDepth: OpImpl = (model, params) => {
  const target = element(model, params);
  if (!target.ok) return target;
  const depth = positive(params, "depth");
  if (!depth.ok) return depth;

  const solid = extrusionOf(model, target.value.id, target.value.guid);
  if (!solid.ok) return solid;
  model.table.setParam(solid.value, 3, real(model.toFile(depth.value)));

  return ok({
    created: [],
    modified: [target.value.guid],
    deleted: [],
    summary: { depth: depth.value },
    geometryChanged: true,
  });
};

/** Replace an extrusion's profile with a new closed polyline. Shared by thickness and profile-dims edits. */
function reprofile(
  model: LocalModel,
  solidId: number,
  points: readonly (readonly [number, number])[],
  name: string,
): void {
  const profileId = model.closedProfile(points, name);
  model.table.setParam(solidId, 0, ref(profileId));
}

const setWallThickness: OpImpl = (model, params) => {
  const target = element(model, params);
  if (!target.ok) return target;
  const thickness = positive(params, "thickness");
  if (!thickness.ok) return thickness;

  const type = model.table.typeOf(target.value.id);
  if (type !== "IFCWALL" && type !== "IFCWALLSTANDARDCASE") {
    return err(kernelFailure("refused", `${target.value.guid} is an ${type}, not a wall`, { guid: target.value.guid }));
  }
  const solid = extrusionOf(model, target.value.id, target.value.guid);
  if (!solid.ok) return solid;

  // The wall's length comes from its existing profile, so thickness can change without the caller having to
  // restate geometry it did not ask to change.
  const length = wallLength(model, solid.value);
  if (length === null) {
    return err(
      kernelFailure("not_an_extrusion", `${target.value.guid} does not have a rectangular wall profile`, {
        guid: target.value.guid,
      }),
    );
  }
  reprofile(model, solid.value, wallProfilePoints(length, thickness.value), "Wall Profile");

  return ok({
    created: [],
    modified: [target.value.guid],
    deleted: [],
    summary: { thickness: thickness.value, length },
    geometryChanged: true,
  });
};

/** Length of a wall from its rectangular profile, in metres, or null if the profile is not one. */
function wallLength(model: LocalModel, solidId: number): number | null {
  const profileRef = model.table.params(solidId)[0];
  if (profileRef?.k !== "ref") return null;
  const curve = model.table.params(profileRef.v)[2];
  if (curve?.k !== "ref" || model.table.typeOf(curve.v) !== "IFCPOLYLINE") return null;
  const pts = model.table.params(curve.v)[0];
  if (pts?.k !== "list") return null;
  let maxX = 0;
  for (const p of pts.v) {
    if (p.k !== "ref") continue;
    const coords = model.table.params(p.v)[0];
    if (coords?.k !== "list") continue;
    const x = coords.v[0]?.k === "num" ? model.toMetres(coords.v[0].v) : 0;
    if (x > maxX) maxX = x;
  }
  return maxX > 1e-9 ? maxX : null;
}

const setProfileDims: OpImpl = (model, params) => {
  const target = element(model, params);
  if (!target.ok) return target;
  const width = positive(params, "width");
  if (!width.ok) return width;
  const depth = positive(params, "depth");
  if (!depth.ok) return depth;

  const solid = extrusionOf(model, target.value.id, target.value.guid);
  if (!solid.ok) return solid;

  const w = width.value / 2;
  const d = depth.value / 2;
  reprofile(
    model,
    solid.value,
    [
      [-w, -d],
      [w, -d],
      [w, d],
      [-w, d],
    ],
    "Profile",
  );

  return ok({
    created: [],
    modified: [target.value.guid],
    deleted: [],
    summary: { width: width.value, depth: depth.value },
    geometryChanged: true,
  });
};

const setElementPset: OpImpl = (model, params) => {
  const target = element(model, params);
  if (!target.ok) return target;
  const psetName = text(params, "pset") ?? text(params, "name");
  if (psetName === null) {
    return err(kernelFailure("invalid_param", '"pset" is required', { param: "pset" }));
  }
  const properties = params.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return err(kernelFailure("invalid_param", '"properties" must be an object of name → value', { param: "properties" }));
  }
  const entries = Object.entries(properties as Record<string, unknown>);
  if (entries.length === 0) {
    return err(kernelFailure("invalid_param", '"properties" must not be empty', { param: "properties" }));
  }

  const propIds = entries.map(([key, value]) =>
    ref(
      model.table.add("IFCPROPERTYSINGLEVALUE", [
        str(key),
        { k: "unset" },
        typedValue(value),
        { k: "unset" },
      ]),
    ),
  );
  const psetId = model.rooted("IFCPROPERTYSET", psetName, [list(propIds)]);
  model.relationship("IFCRELDEFINESBYPROPERTIES", [list([ref(target.value.id)]), ref(psetId)]);

  return ok({
    created: [],
    modified: [target.value.guid],
    deleted: [],
    summary: { pset: psetName, count: entries.length },
    // Metadata only. Reporting a geometry change here would make every property edit re-stream the model,
    // which is why `OpResult` carries the two versions separately.
    geometryChanged: false,
  });
};

/**
 * A JS value as an IFC typed value.
 *
 * The wrapper type is not decoration: `IfcPropertySingleValue.NominalValue` is a SELECT, so the file has to say
 * which member it is. A bare `3` where `IFCINTEGER(3)` belongs is rejected by strict readers and silently
 * coerced by lenient ones, which is how a quantity ends up as text in a schedule.
 */
function typedValue(value: unknown): StepValue {
  if (typeof value === "string") return { k: "typed", t: "IFCLABEL", v: [str(value)] };
  if (typeof value === "boolean") return { k: "typed", t: "IFCBOOLEAN", v: [value ? TRUE : FALSE] };
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value)
      ? { k: "typed", t: "IFCINTEGER", v: [integer(value)] }
      : { k: "typed", t: "IFCREAL", v: [real(value)] };
  }
  // Anything else — null, an object, NaN — becomes an explicitly unset value rather than a guess. A property
  // that exists with no value is a fact; a property invented from a coercion is not.
  return { k: "unset" };
}

// ---------------------------------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------------------------------

export const LOCAL_OPS: readonly (OpDescriptor & { readonly run: OpImpl })[] = [
  {
    id: "add_wall",
    category: "create-architecture",
    produces: "IfcWall",
    invertible: true,
    description: "A wall between two points, by centre-line.",
    params: [
      { name: "start", type: "point", required: true, unit: "m" },
      { name: "end", type: "point", required: true, unit: "m" },
      { name: "height", type: "length", required: false, unit: "m", min: 0 },
      { name: "thickness", type: "length", required: false, unit: "m", min: 0 },
      { name: "storey", type: "text", required: false },
      { name: "name", type: "text", required: false },
    ],
    run: addWall,
  },
  {
    id: "add_slab",
    category: "create-architecture",
    produces: "IfcSlab",
    invertible: true,
    description: "A slab from a closed outline.",
    params: [
      { name: "points", type: "point-list", required: true, unit: "m" },
      { name: "thickness", type: "length", required: false, unit: "m", min: 0 },
      { name: "elevation", type: "length", required: false, unit: "m" },
      { name: "storey", type: "text", required: false },
      { name: "name", type: "text", required: false },
    ],
    run: addSlab,
  },
  {
    id: "add_column",
    category: "create-architecture",
    produces: "IfcColumn",
    invertible: true,
    description: "A rectangular column at a point.",
    params: [
      { name: "point", type: "point", required: true, unit: "m" },
      { name: "height", type: "length", required: false, unit: "m", min: 0 },
      { name: "width", type: "length", required: false, unit: "m", min: 0 },
      { name: "depth", type: "length", required: false, unit: "m", min: 0 },
      { name: "rotation", type: "number", required: false, unit: "deg" },
      { name: "storey", type: "text", required: false },
      { name: "name", type: "text", required: false },
    ],
    run: addColumn,
  },
  {
    id: "add_beam",
    category: "create-architecture",
    produces: "IfcBeam",
    invertible: true,
    description: "A beam between two points.",
    params: [
      { name: "start", type: "point", required: true, unit: "m" },
      { name: "end", type: "point", required: true, unit: "m" },
      { name: "width", type: "length", required: false, unit: "m", min: 0 },
      { name: "depth", type: "length", required: false, unit: "m", min: 0 },
      { name: "elevation", type: "length", required: false, unit: "m" },
      { name: "storey", type: "text", required: false },
      { name: "name", type: "text", required: false },
    ],
    run: addBeam,
  },
  {
    id: "add_door",
    category: "create-architecture",
    produces: "IfcDoor",
    invertible: true,
    description: "A door in a wall. The opening is recorded semantically; the host mesh is not yet cut.",
    params: [
      { name: "host_guid", type: "guid", required: true },
      { name: "width", type: "length", required: false, unit: "m", min: 0 },
      { name: "height", type: "length", required: false, unit: "m", min: 0 },
      { name: "sill", type: "length", required: false, unit: "m" },
      { name: "position", type: "length", required: false, unit: "m" },
      { name: "name", type: "text", required: false },
    ],
    run: addOpening("door", "IFCDOOR", 0),
  },
  {
    id: "add_window",
    category: "create-architecture",
    produces: "IfcWindow",
    invertible: true,
    description: "A window in a wall. The opening is recorded semantically; the host mesh is not yet cut.",
    params: [
      { name: "host_guid", type: "guid", required: true },
      { name: "width", type: "length", required: false, unit: "m", min: 0 },
      { name: "height", type: "length", required: false, unit: "m", min: 0 },
      { name: "sill", type: "length", required: false, unit: "m" },
      { name: "position", type: "length", required: false, unit: "m" },
      { name: "name", type: "text", required: false },
    ],
    run: addOpening("window", "IFCWINDOW", 0.9),
  },
  {
    id: "add_storey",
    category: "spatial",
    produces: "IfcBuildingStorey",
    invertible: true,
    description: "A building storey at an elevation.",
    params: [
      { name: "elevation", type: "length", required: true, unit: "m" },
      { name: "name", type: "text", required: false },
    ],
    run: addStorey,
  },
  {
    id: "move_element",
    category: "edit",
    invertible: true,
    description: "Translate an element.",
    params: [
      { name: "guid", type: "guid", required: true },
      { name: "dx", type: "length", required: false, unit: "m" },
      { name: "dy", type: "length", required: false, unit: "m" },
      { name: "dz", type: "length", required: false, unit: "m" },
    ],
    run: moveElement,
  },
  {
    id: "rotate_element",
    category: "edit",
    invertible: true,
    description: "Rotate an element about its own vertical axis.",
    params: [
      { name: "guid", type: "guid", required: true },
      { name: "degrees", type: "number", required: true, unit: "deg" },
    ],
    run: rotateElement,
  },
  {
    id: "copy_element",
    category: "edit",
    invertible: true,
    description: "Duplicate an element at an offset, sharing its geometry.",
    params: [
      { name: "guid", type: "guid", required: true },
      { name: "dx", type: "length", required: false, unit: "m" },
      { name: "dy", type: "length", required: false, unit: "m" },
      { name: "dz", type: "length", required: false, unit: "m" },
    ],
    run: copyElement,
  },
  {
    id: "delete_element",
    category: "edit",
    // Snapshot transactions make undo work regardless, but the op itself has no inverse to replay: the
    // entity's attributes are gone once it is removed. Declaring that honestly is what stops a caller
    // building an inverse-based undo on a promise this cannot keep.
    invertible: false,
    description: "Remove an element and unlink it from the relationships that referenced it.",
    params: [{ name: "guid", type: "guid", required: true }],
    run: deleteElement,
  },
  {
    id: "set_extrusion_depth",
    category: "geometry",
    invertible: true,
    description: "Change how far a profile is extruded. Refuses anything that is not a single extrusion.",
    params: [
      { name: "guid", type: "guid", required: true },
      { name: "depth", type: "length", required: true, unit: "m", min: 0 },
    ],
    run: setExtrusionDepth,
  },
  {
    id: "set_wall_thickness",
    category: "geometry",
    invertible: true,
    description: "Change a wall's thickness, keeping its length.",
    params: [
      { name: "guid", type: "guid", required: true },
      { name: "thickness", type: "length", required: true, unit: "m", min: 0 },
    ],
    run: setWallThickness,
  },
  {
    id: "set_profile_dims",
    category: "geometry",
    invertible: true,
    description: "Resize a rectangular profile.",
    params: [
      { name: "guid", type: "guid", required: true },
      { name: "width", type: "length", required: true, unit: "m", min: 0 },
      { name: "depth", type: "length", required: true, unit: "m", min: 0 },
    ],
    run: setProfileDims,
  },
  {
    id: "set_element_pset",
    category: "data",
    invertible: true,
    description: "Attach a property set to an element.",
    params: [
      { name: "guid", type: "guid", required: true },
      { name: "pset", type: "text", required: true },
      { name: "properties", type: "object", required: true },
    ],
    run: setElementPset,
  },
];

/** What `unsupported` says for an op this kernel does not implement. Written once, so it stays consistent. */
export const UNSUPPORTED_HINT =
  "runs on the Massing authoring service. Connect a project to use it.";
