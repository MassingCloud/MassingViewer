import { type EntityTable, type StepValue, integer, list, real, ref, str } from "@massingviewer/ifc";
import type { Guid } from "@massingviewer/core";
import type { GuidMinter } from "./guid";

/**
 * An IFC model being authored: the entity table, plus the handful of things you need to find before you can
 * add anything to it.
 *
 * ## Why context discovery is its own problem
 *
 * Appending an `IfcWall` to a file is the easy part. Making it *appear* requires attaching it to the file's
 * existing geometric representation sub-context, its length unit, and a storey — all of which are already in
 * the file, expressed in whichever way the exporter that wrote it chose. Get any of them wrong and the element
 * is present, valid, and invisible: the worst outcome, because nothing reports an error.
 *
 * So this class finds what exists and creates only what is missing, and it records which of the two happened
 * (see {@link created}) because "we had to invent a representation context" is a fact worth surfacing rather
 * than a silent repair.
 */
export class LocalModel {
  readonly table: EntityTable;
  private readonly mint: GuidMinter;

  /** Metres per file length unit. A millimetre file gives 0.001. */
  readonly lengthScale: number;

  readonly projectId: number | null;
  /** The `Body` sub-context new shape representations attach to. */
  readonly bodyContextId: number;
  /** Owner history, if the file has one. New elements reuse it rather than inventing an author. */
  readonly ownerHistoryId: number | null;
  /** Things this class had to create because the file lacked them. */
  readonly created: readonly string[];

  constructor(table: EntityTable, mint: GuidMinter) {
    this.table = table;
    this.mint = mint;
    const created: string[] = [];

    this.projectId = table.byType("IFCPROJECT")[0] ?? null;
    this.lengthScale = discoverLengthScale(table, this.projectId);
    this.ownerHistoryId = table.byType("IFCOWNERHISTORY")[0] ?? null;

    const body = findBodyContext(table);
    if (body !== null) {
      this.bodyContextId = body;
    } else {
      this.bodyContextId = this.createBodyContext();
      created.push("IfcGeometricRepresentationSubContext('Body')");
    }
    this.created = created;
  }

  /**
   * Mint a GlobalId.
   *
   * Public because relationship entities (`IfcRelVoidsElement`, `IfcRelDefinesByProperties`) are rooted and
   * need one, but are not products — so {@link product}, which builds a whole product entity, is the wrong
   * tool for them.
   */
  mintGuid(): Guid {
    return this.mint();
  }

  /** Metres → file units, for writing coordinates. */
  toFile(metres: number): number {
    return metres / this.lengthScale;
  }

  /** File units → metres, for reading them back. */
  toMetres(fileUnits: number): number {
    return fileUnits * this.lengthScale;
  }

  private add(type: string, params: readonly StepValue[]): number {
    return this.table.add(type, params);
  }

  private createBodyContext(): number {
    const origin = this.point3(0, 0, 0);
    const axis = this.add("IFCAXIS2PLACEMENT3D", [ref(origin), { k: "unset" }, { k: "unset" }]);
    const north = this.add("IFCDIRECTION", [list([real(0), real(1)])]);
    const context = this.add("IFCGEOMETRICREPRESENTATIONCONTEXT", [
      { k: "unset" },
      str("Model"),
      integer(3),
      real(1e-5),
      ref(axis),
      ref(north),
    ]);
    return this.add("IFCGEOMETRICREPRESENTATIONSUBCONTEXT", [
      str("Body"),
      str("Model"),
      { k: "derived" },
      { k: "derived" },
      { k: "derived" },
      { k: "derived" },
      ref(context),
      { k: "unset" },
      { k: "enum", v: "MODEL_VIEW" },
      { k: "unset" },
    ]);
  }

  // -------------------------------------------------------------------------------------------------
  // Geometry primitives
  // -------------------------------------------------------------------------------------------------

  /** Coordinates are metres in, file units out — the conversion happens here and nowhere else. */
  point3(x: number, y: number, z: number): number {
    return this.add("IFCCARTESIANPOINT", [
      list([real(this.toFile(x)), real(this.toFile(y)), real(this.toFile(z))]),
    ]);
  }

  point2(x: number, y: number): number {
    return this.add("IFCCARTESIANPOINT", [list([real(this.toFile(x)), real(this.toFile(y))])]);
  }

  /**
   * A placement, optionally rotated about Z and optionally relative to a parent placement.
   *
   * `refDirection` is written only when there is a rotation. An identity direction is legal but noise, and
   * a file full of redundant `IFCDIRECTION((1.,0.,0.))` is harder to read in a diff — which matters, because
   * reviewable diffs are the point of the entity-table design.
   */
  placement(x: number, y: number, z: number, rotationRad = 0, parentId: number | null = null): number {
    const origin = this.point3(x, y, z);
    let refDir: StepValue = { k: "unset" };
    if (rotationRad !== 0) {
      const d = this.add("IFCDIRECTION", [list([real(Math.cos(rotationRad)), real(Math.sin(rotationRad)), real(0)])]);
      refDir = ref(d);
    }
    const axis = this.add("IFCAXIS2PLACEMENT3D", [ref(origin), { k: "unset" }, refDir]);
    return this.add("IFCLOCALPLACEMENT", [parentId === null ? { k: "unset" } : ref(parentId), ref(axis)]);
  }

  /** A closed polyline profile from metres-space points. The first point is repeated to close the loop. */
  closedProfile(points: readonly (readonly [number, number])[], name?: string): number {
    if (points.length < 3) throw new RangeError(`a closed profile needs at least 3 points, got ${points.length}`);
    const ids = points.map(([x, y]) => ref(this.point2(x, y)));
    // IfcPolyline for a closed loop repeats the first point as the last. Omitting it produces a profile that
    // some kernels close implicitly and others reject, which is the worst kind of disagreement.
    const polyline = this.add("IFCPOLYLINE", [list([...ids, ids[0]!])]);
    return this.add("IFCARBITRARYCLOSEDPROFILEDEF", [
      { k: "enum", v: "AREA" },
      name === undefined ? { k: "unset" } : str(name),
      ref(polyline),
    ]);
  }

  /** Extrude a profile along +Z by `height` metres. */
  extrude(profileId: number, height: number): number {
    const origin = this.point3(0, 0, 0);
    const axis = this.add("IFCAXIS2PLACEMENT3D", [ref(origin), { k: "unset" }, { k: "unset" }]);
    const dir = this.add("IFCDIRECTION", [list([real(0), real(0), real(1)])]);
    return this.add("IFCEXTRUDEDAREASOLID", [ref(profileId), ref(axis), ref(dir), real(this.toFile(height))]);
  }

  /** Wrap a solid as the product's `Body` shape. */
  bodyShape(solidId: number): number {
    const shape = this.add("IFCSHAPEREPRESENTATION", [
      ref(this.bodyContextId),
      str("Body"),
      str("SweptSolid"),
      list([ref(solidId)]),
    ]);
    return this.add("IFCPRODUCTDEFINITIONSHAPE", [{ k: "unset" }, { k: "unset" }, list([ref(shape)])]);
  }

  // -------------------------------------------------------------------------------------------------
  // Products
  // -------------------------------------------------------------------------------------------------

  /**
   * Create a rooted product entity with a freshly minted GlobalId.
   *
   * The GlobalId is generated here, once, and is the return value's identity for the rest of time. Nothing in
   * this package recomputes one, and nothing derives one from an expressID.
   */
  product(
    ifcClass: string,
    name: string | null,
    placementId: number | null,
    shapeId: number | null,
    extra: readonly StepValue[] = [],
  ): { id: number; guid: Guid } {
    const guid = this.mint();
    const params: StepValue[] = [
      str(guid),
      this.ownerHistoryId === null ? { k: "unset" } : ref(this.ownerHistoryId),
      name === null ? { k: "unset" } : str(name),
      { k: "unset" }, // Description
      { k: "unset" }, // ObjectType
      placementId === null ? { k: "unset" } : ref(placementId),
      shapeId === null ? { k: "unset" } : ref(shapeId),
      { k: "unset" }, // Tag
      ...extra,
    ];
    const id = this.table.add(ifcClass, params);
    return { id, guid };
  }

  /**
   * Add any `IfcRoot` subtype: GlobalId, OwnerHistory, Name, Description, then the given attributes.
   *
   * Those four attributes, in that order, are shared by every rooted entity — relationships, property sets,
   * products — and writing them out at each call site is how one of them ends up subtly different from the
   * others. `name` is explicit rather than folded into `tail` because it sits at index 2: an earlier version of
   * this took only a tail, and `IfcPropertySet`'s Name landed at index 4, producing a seven-attribute property
   * set that no reader would accept.
   */
  rooted(ifcClass: string, name: string | null, tail: readonly StepValue[]): number {
    return this.table.add(ifcClass, [
      str(this.mint()),
      this.ownerHistoryId === null ? { k: "unset" } : ref(this.ownerHistoryId),
      name === null ? { k: "unset" } : str(name),
      { k: "unset" }, // Description
      ...tail,
    ]);
  }

  /** An unnamed `IfcRelationship`, which is the usual case. */
  relationship(ifcClass: string, tail: readonly StepValue[]): number {
    return this.rooted(ifcClass, null, tail);
  }

  /**
   * Walk a product's `IfcLocalPlacement` down to the `IfcCartesianPoint` that holds its origin.
   *
   * Returned as ids rather than values because both callers need to *write* — `move_element` edits the point in
   * place so that anything parented to this placement travels with it, and `copy_element` needs the axis to
   * clone its rotation. Returning coordinates only would force each to re-walk the chain.
   */
  placementOrigin(productId: number): { axisId: number; pointId: number; parent: StepValue; at: number[] } | null {
    const placement = this.table.params(productId)[5];
    if (placement?.k !== "ref") return null;
    const placementParams = this.table.params(placement.v);
    const axis = placementParams[1];
    if (axis?.k !== "ref") return null;
    const originRef = this.table.params(axis.v)[0];
    if (originRef?.k !== "ref") return null;
    const coords = this.table.params(originRef.v)[0];
    if (coords?.k !== "list") return null;
    return {
      axisId: axis.v,
      pointId: originRef.v,
      parent: placementParams[0] ?? { k: "unset" },
      at: coords.v.map((c) => (c.k === "num" ? this.toMetres(c.v) : 0)),
    };
  }

  // -------------------------------------------------------------------------------------------------
  // Spatial structure
  // -------------------------------------------------------------------------------------------------

  /** Every storey, in elevation order, with elevations in metres. */
  storeys(): { id: number; guid: Guid | null; name: string | null; elevation: number }[] {
    return this.table
      .byType("IFCBUILDINGSTOREY")
      .map((id) => {
        const p = this.table.params(id);
        const elevation = p[9]?.k === "num" ? this.toMetres(p[9].v) : 0;
        return {
          id,
          guid: this.table.guidOf(id),
          name: p[2]?.k === "str" ? p[2].v : null,
          elevation,
        };
      })
      .sort((a, b) => a.elevation - b.elevation);
  }

  /** The storey a new element goes into when the caller did not name one: the lowest. */
  defaultStorey(): number | null {
    return this.storeys()[0]?.id ?? null;
  }

  resolveStorey(nameOrGuid: string | null | undefined): number | null {
    if (nameOrGuid === null || nameOrGuid === undefined || nameOrGuid === "") return this.defaultStorey();
    const byGuid = this.table.idOfGuid(nameOrGuid);
    if (byGuid !== undefined && this.table.typeOf(byGuid) === "IFCBUILDINGSTOREY") return byGuid;
    return this.storeys().find((s) => s.name === nameOrGuid)?.id ?? null;
  }

  /** The storey's own placement, so an element's placement can hang off it rather than off the world. */
  storeyPlacement(storeyId: number): number | null {
    const p = this.table.params(storeyId)[5];
    return p?.k === "ref" ? p.v : null;
  }

  /**
   * Put an element in a storey.
   *
   * Appends to the storey's existing `IfcRelContainedInSpatialStructure` when there is one, rather than adding
   * a second relationship. IFC permits only one containment relationship per element, and some readers take
   * the first they find — so two rels for one storey means elements that appear in the tree for some tools and
   * not others. This is exactly the edit the entity-table design makes cheap: one attribute on one entity.
   */
  contain(elementId: number, storeyId: number): void {
    for (const relId of this.table.byType("IFCRELCONTAINEDINSPATIALSTRUCTURE")) {
      const params = this.table.params(relId);
      const structure = params[5];
      if (structure?.k === "ref" && structure.v === storeyId) {
        const related = params[4];
        const members = related?.k === "list" ? [...related.v] : [];
        if (members.some((m) => m.k === "ref" && m.v === elementId)) return;
        this.table.setParam(relId, 4, list([...members, ref(elementId)]));
        return;
      }
    }
    this.relationship("IFCRELCONTAINEDINSPATIALSTRUCTURE", [list([ref(elementId)]), ref(storeyId)]);
  }

  /** Remove an element from whatever containment relationship holds it. */
  uncontain(elementId: number): void {
    for (const relId of this.table.byType("IFCRELCONTAINEDINSPATIALSTRUCTURE")) {
      const params = this.table.params(relId);
      const related = params[4];
      if (related?.k !== "list") continue;
      const kept = related.v.filter((m) => !(m.k === "ref" && m.v === elementId));
      if (kept.length === related.v.length) continue;
      if (kept.length === 0) {
        // An empty RelatedElements set is invalid IFC (the attribute is a non-empty SET), so the relationship
        // goes rather than being left as a malformed husk.
        this.table.remove(relId);
      } else {
        this.table.setParam(relId, 4, list(kept));
      }
      return;
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------------------------------

/**
 * The `Body` representation sub-context, if the file has one.
 *
 * Matched on `ContextIdentifier === "Body"` — the identifier IFC reserves for solid geometry. Attaching a
 * shape to an `Axis` or `Box` sub-context instead produces an element that is valid and invisible in every
 * viewer, which is why this looks for the right one rather than the first one.
 */
function findBodyContext(table: EntityTable): number | null {
  for (const id of table.byType("IFCGEOMETRICREPRESENTATIONSUBCONTEXT")) {
    const identifier = table.params(id)[0];
    if (identifier?.k === "str" && identifier.v === "Body") return id;
  }
  return null;
}

/** SI prefixes that appear on a length unit, as metres per unit. */
const SI_PREFIX: Record<string, number> = {
  KILO: 1e3,
  HECTO: 1e2,
  DECA: 1e1,
  DECI: 1e-1,
  CENTI: 1e-2,
  MILLI: 1e-3,
  MICRO: 1e-6,
};

/**
 * Metres per file length unit.
 *
 * Getting this wrong is the single most common way an IFC integration produces nonsense: a millimetre file read
 * as metres gives a building 1000× too large, and the symptom — an empty viewport because the camera fit to
 * something the size of a city — looks nothing like a units bug. `@massingviewer/core` is metres-only
 * internally precisely so that this conversion happens once, here, at the file boundary.
 *
 * Defaults to metres when the file does not say, which is what IFC's own default is.
 */
function discoverLengthScale(table: EntityTable, projectId: number | null): number {
  if (projectId === null) return 1;
  const unitsInContext = table.params(projectId)[8];
  if (unitsInContext?.k !== "ref") return 1;
  const assignment = table.params(unitsInContext.v)[0];
  if (assignment?.k !== "list") return 1;

  for (const entry of assignment.v) {
    if (entry.k !== "ref") continue;
    const type = table.typeOf(entry.v);
    const params = table.params(entry.v);

    if (type === "IFCSIUNIT") {
      if (params[1]?.k !== "enum" || params[1].v !== "LENGTHUNIT") continue;
      const prefix = params[2];
      return prefix?.k === "enum" ? (SI_PREFIX[prefix.v] ?? 1) : 1;
    }

    if (type === "IFCCONVERSIONBASEDUNIT") {
      if (params[1]?.k !== "enum" || params[1].v !== "LENGTHUNIT") continue;
      // ConversionFactor is an IfcMeasureWithUnit: a value, and the SI unit it is expressed in. Imperial
      // files reach here — a foot is 0.3048 m — and reading only the value would silently drop the prefix on
      // a "millimetre-based inch" file, which does exist.
      const factorRef = params[3];
      if (factorRef?.k !== "ref") continue;
      const factor = table.params(factorRef.v);
      const value = factor[0];
      const unit = factor[1];
      const magnitude =
        value?.k === "num" ? value.v : value?.k === "typed" && value.v[0]?.k === "num" ? value.v[0].v : null;
      if (magnitude === null) continue;
      let base = 1;
      if (unit?.k === "ref" && table.typeOf(unit.v) === "IFCSIUNIT") {
        const prefix = table.params(unit.v)[2];
        if (prefix?.k === "enum") base = SI_PREFIX[prefix.v] ?? 1;
      }
      return magnitude * base;
    }
  }
  return 1;
}
