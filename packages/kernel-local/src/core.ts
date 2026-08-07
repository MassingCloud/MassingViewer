import { type Guid, type ModelId, type Result, asGuid, err, ok } from "@massingviewer/core";
import type {
  ElementProperties,
  KernelFailure,
  OpDescriptor,
  OpParams,
  OpResult,
  SnapCandidatePoint,
  SpatialNode,
} from "@massingviewer/kernel-api";
import { kernelFailure, unsupported } from "@massingviewer/kernel-api";
import { EntityTable, type StepValue } from "@massingviewer/ifc";
import { BLANK_IFC4 } from "./blank";
import { type GuidMinter, randomGuidMinter } from "./guid";
import { LOCAL_OPS, UNSUPPORTED_HINT } from "./ops";
import { LocalModel } from "./model";

/**
 * The authoring engine, with no transport around it.
 *
 * This class is what runs *inside* the Worker. The `KernelProvider` that callers see is a thin client over a
 * message port (see `provider.ts`), and there is no in-process provider: `docs/adr/0008-local-kernel-geometry-stack.md`
 * makes the boundary structural rather than conventional, because a sync path added "just for tests" is how the
 * boundary erodes.
 *
 * Tested directly all the same. That is not a contradiction — this is an internal class, and testing it here
 * gives failures that point at the operation rather than at a message round-trip. The *contract* is tested
 * through the real Worker by `@massingviewer/kernel-conformance`.
 */
export class LocalKernelCore {
  private readonly models = new Map<string, ModelState>();
  private readonly mint: GuidMinter;
  private txSeq = 0;

  constructor(mint: GuidMinter = randomGuidMinter()) {
    this.mint = mint;
  }

  /** Open an IFC file, or start a new model when `ifc` is omitted. */
  open(modelId: ModelId, ifc?: string): Result<{ elements: number; created: readonly string[] }, KernelFailure> {
    let table: EntityTable;
    try {
      table = EntityTable.parse(ifc ?? BLANK_IFC4);
    } catch (cause) {
      // A parse failure is the user's file being wrong, not this kernel being broken, so it is a `refused`
      // rather than an `internal` — the distinction drives whether the UI shows an error or an incident.
      return err(
        kernelFailure("refused", `that file is not readable as IFC: ${(cause as Error).message}`, {
          modelId,
        }),
      );
    }
    const model = new LocalModel(table, this.mint);
    this.models.set(modelId, { model, version: 1, geometryVersion: 1, undo: [], transactions: new Map() });
    return ok({ elements: table.size, created: model.created });
  }

  close(modelId: ModelId): void {
    this.models.delete(modelId);
  }

  /** Every op this kernel implements. Static here, unlike `RemoteKernel`, which discovers its set. */
  ops(): readonly OpDescriptor[] {
    // The `run` function is stripped: it is not serialisable, and this list crosses a message boundary.
    return LOCAL_OPS.map(({ run: _run, ...descriptor }) => descriptor);
  }

  private state(modelId: ModelId): Result<ModelState, KernelFailure> {
    const state = this.models.get(modelId);
    if (!state) {
      return err(
        kernelFailure("no_such_element", `model ${modelId} is not open`, { modelId }),
      );
    }
    return ok(state);
  }

  // -------------------------------------------------------------------------------------------------
  // Apply
  // -------------------------------------------------------------------------------------------------

  apply(
    modelId: ModelId,
    op: string,
    params: OpParams,
    options?: { expectedVersion?: string; transactionId?: string },
  ): Result<OpResult, KernelFailure> {
    const state = this.state(modelId);
    if (!state.ok) return state;

    const descriptor = LOCAL_OPS.find((d) => d.id === op);
    if (!descriptor) {
      // Visible-but-dimmed, never hidden. The hint is what the ribbon shows as a tooltip, so it has to name
      // what would unlock the operation rather than restating that it failed. See docs/adr/0001-two-kernels.md.
      return err(unsupported(op, `"${op}" ${UNSUPPORTED_HINT}`));
    }

    const current = String(state.value.version);
    if (options?.expectedVersion !== undefined && options.expectedVersion !== current) {
      // Never a silent overwrite. Two tabs editing one model is the normal case for a browser tool, and the
      // one outcome that must not happen is the second write erasing the first without anyone knowing.
      return err(
        kernelFailure(
          "version_conflict",
          `the model has changed since you read it (expected ${options.expectedVersion}, now ${current})`,
          { expected: options.expectedVersion, actual: current },
        ),
      );
    }

    // Snapshot before the write, so a failure mid-op cannot leave a half-applied model. The ops validate
    // before they write for the same reason; this is the belt to that braces, and it is what makes
    // `transactions: "snapshot"` an honest claim rather than an aspiration.
    const before = state.value.model.table.emit();
    let effect;
    try {
      effect = descriptor.run(state.value.model, params);
    } catch (cause) {
      this.restore(state.value, before);
      return err(
        kernelFailure("internal", `"${op}" failed: ${(cause as Error).message}`, { op }),
      );
    }
    if (!effect.ok) {
      this.restore(state.value, before);
      return effect;
    }

    state.value.version += 1;
    if (effect.value.geometryChanged) state.value.geometryVersion += 1;
    state.value.undo.push({ label: op, ifc: before });
    // A bounded stack: an unbounded one holds a full copy of the file per operation, and on a large model that
    // is how a long editing session runs out of memory. 50 is the depth CAD tools converge on.
    if (state.value.undo.length > 50) state.value.undo.shift();

    return ok({
      created: effect.value.created,
      modified: effect.value.modified,
      deleted: effect.value.deleted,
      summary: effect.value.summary,
      geometryVersion: String(state.value.geometryVersion),
      modelVersion: String(state.value.version),
    });
  }

  private restore(state: ModelState, ifc: string): void {
    state.model = new LocalModel(EntityTable.parse(ifc), this.mint);
  }

  /**
   * Undo the last operation.
   *
   * Restores a snapshot rather than replaying an inverse, which is why `capabilities.transactions` is
   * `"snapshot"` and why `delete_element` can be undone here even though it declares `invertible: false`.
   * `RemoteKernel` cannot make that promise, and the contract lets each kernel say which it is instead of
   * pretending they are the same — see the `TransactionSupport` note in kernel-api.
   */
  undo(modelId: ModelId): Result<{ label: string; modelVersion: string }, KernelFailure> {
    const state = this.state(modelId);
    if (!state.ok) return state;
    const entry = state.value.undo.pop();
    if (!entry) {
      return err(kernelFailure("refused", "there is nothing to undo", { modelId }));
    }
    this.restore(state.value, entry.ifc);
    state.value.version += 1;
    state.value.geometryVersion += 1;
    return ok({ label: entry.label, modelVersion: String(state.value.version) });
  }

  /**
   * Open a transaction: snapshot now, and be able to get back here.
   *
   * Separate from the undo stack rather than layered on it. Rolling back by calling undo N times needs an
   * accurate N, and N is wrong the moment anything else touches the model — another tab, a plugin, an
   * autosave. A named snapshot is correct regardless of what happened in between, which is the property a
   * transaction is supposed to have.
   */
  begin(modelId: ModelId, label: string): Result<{ id: string; label: string }, KernelFailure> {
    const state = this.state(modelId);
    if (!state.ok) return state;
    const id = `tx${++this.txSeq}`;
    state.value.transactions.set(id, {
      label,
      ifc: state.value.model.table.emit(),
      version: state.value.version,
      geometryVersion: state.value.geometryVersion,
      undoDepth: state.value.undo.length,
    });
    return ok({ id, label });
  }

  commit(modelId: ModelId, txId: string): Result<OpResult, KernelFailure> {
    const state = this.state(modelId);
    if (!state.ok) return state;
    const tx = state.value.transactions.get(txId);
    if (!tx) return err(kernelFailure("refused", `no open transaction ${txId}`, { txId }));
    state.value.transactions.delete(txId);
    // Committing discards the snapshot; the model is already in its post-commit state because every op wrote
    // through. Nothing to apply, which is what makes commit cheap and rollback the expensive direction.
    return ok({
      created: [],
      modified: [],
      deleted: [],
      summary: { transaction: txId, label: tx.label },
      geometryVersion: String(state.value.geometryVersion),
      modelVersion: String(state.value.version),
    });
  }

  rollback(modelId: ModelId, txId: string): Result<void, KernelFailure> {
    const state = this.state(modelId);
    if (!state.ok) return state;
    const tx = state.value.transactions.get(txId);
    if (!tx) return err(kernelFailure("refused", `no open transaction ${txId}`, { txId }));
    state.value.transactions.delete(txId);
    this.restore(state.value, tx.ifc);
    state.value.version = tx.version;
    state.value.geometryVersion = tx.geometryVersion;
    // The undo stack is truncated to the transaction's start too: entries recorded inside a rolled-back
    // transaction describe states that no longer exist, and undoing into one would resurrect work the user
    // just discarded.
    state.value.undo = state.value.undo.filter((_, i) => i < tx.undoDepth);
    return ok(undefined);
  }

  versions(modelId: ModelId): Result<{ modelVersion: string; geometryVersion: string }, KernelFailure> {
    const state = this.state(modelId);
    if (!state.ok) return state;
    return ok({
      modelVersion: String(state.value.version),
      geometryVersion: String(state.value.geometryVersion),
    });
  }

  // -------------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------------

  /**
   * The model as IFC text.
   *
   * `geometryFormat` is `"ifc"` rather than a tessellated format, and that is a real architectural choice, not
   * a shortcut: the kernel owns *semantics* and the viewport owns *tessellation*. Meshing here would mean the
   * kernel deciding curve tolerances and normals on behalf of a renderer it cannot see, and it would put a
   * mesher inside the layer that must stay honest about identity.
   *
   * The cost is that a change re-sends the file, which is why `maxModelBytes` exists and is declared.
   */
  exportIfc(modelId: ModelId): Result<string, KernelFailure> {
    const state = this.state(modelId);
    if (!state.ok) return state;
    return ok(state.value.model.table.emit());
  }

  properties(modelId: ModelId, guids: readonly Guid[]): Result<Map<Guid, ElementProperties>, KernelFailure> {
    const state = this.state(modelId);
    if (!state.ok) return state;
    const { table } = state.value.model;
    const out = new Map<Guid, ElementProperties>();

    // Indexed once for the whole batch rather than per element. A per-element scan over every
    // IfcRelDefinesByProperties is the quadratic mistake that makes a property panel feel broken on a real
    // model, and it is invisible on a fixture with six elements.
    const psetsByElement = new Map<number, number[]>();
    for (const relId of table.byType("IFCRELDEFINESBYPROPERTIES")) {
      const params = table.params(relId);
      const related = params[4];
      const definition = params[5];
      if (related?.k !== "list" || definition?.k !== "ref") continue;
      for (const member of related.v) {
        if (member.k !== "ref") continue;
        const bucket = psetsByElement.get(member.v);
        if (bucket) bucket.push(definition.v);
        else psetsByElement.set(member.v, [definition.v]);
      }
    }

    for (const guid of guids) {
      const id = table.idOfGuid(guid);
      if (id === undefined) continue;
      const params = table.params(id);
      const psets: Record<string, Record<string, unknown>> = {};
      for (const psetId of psetsByElement.get(id) ?? []) {
        if (table.typeOf(psetId) !== "IFCPROPERTYSET") continue;
        const psetParams = table.params(psetId);
        const name = psetParams[2]?.k === "str" ? psetParams[2].v : "Unnamed";
        const properties: Record<string, unknown> = {};
        const hasProperties = psetParams[4];
        if (hasProperties?.k === "list") {
          for (const propRef of hasProperties.v) {
            if (propRef.k !== "ref") continue;
            const prop = table.params(propRef.v);
            const key = prop[0]?.k === "str" ? prop[0].v : null;
            if (key === null) continue;
            properties[key] = plainValue(prop[2]);
          }
        }
        psets[name] = properties;
      }
      out.set(guid, {
        guid,
        ifcClass: pascalCase(table.typeOf(id) ?? "Unknown"),
        ...(params[2]?.k === "str" ? { name: params[2].v } : {}),
        psets,
      });
    }
    return ok(out);
  }

  /**
   * Project → Site → Building → Storey → elements.
   *
   * Built from `IfcRelAggregates` for the spatial chain and `IfcRelContainedInSpatialStructure` for the leaves,
   * which is the distinction IFC actually makes: a storey *aggregates* into a building but *contains* a wall.
   * Conflating them yields a tree that looks right and puts walls inside walls.
   */
  spatialTree(modelId: ModelId): Result<SpatialNode, KernelFailure> {
    const state = this.state(modelId);
    if (!state.ok) return state;
    const { table, ...rest } = state.value.model;
    void rest;

    const aggregates = new Map<number, number[]>();
    for (const relId of table.byType("IFCRELAGGREGATES")) {
      const params = table.params(relId);
      const relating = params[4];
      const related = params[5];
      if (relating?.k !== "ref" || related?.k !== "list") continue;
      const children = related.v.filter((c) => c.k === "ref").map((c) => (c as { v: number }).v);
      aggregates.set(relating.v, [...(aggregates.get(relating.v) ?? []), ...children]);
    }
    const contains = new Map<number, number[]>();
    for (const relId of table.byType("IFCRELCONTAINEDINSPATIALSTRUCTURE")) {
      const params = table.params(relId);
      const structure = params[5];
      const related = params[4];
      if (structure?.k !== "ref" || related?.k !== "list") continue;
      const children = related.v.filter((c) => c.k === "ref").map((c) => (c as { v: number }).v);
      contains.set(structure.v, [...(contains.get(structure.v) ?? []), ...children]);
    }

    const model = state.value.model;
    const node = (id: number, seen: Set<number>): SpatialNode => {
      const params = table.params(id);
      const guid = table.guidOf(id);
      const elevation = table.typeOf(id) === "IFCBUILDINGSTOREY" && params[9]?.k === "num" ? params[9].v : null;
      // Cycle guard. A malformed file can aggregate a storey into itself, and without this the tree walk is an
      // infinite loop that presents as the app hanging with no error anywhere.
      const children =
        seen.has(id)
          ? []
          : [...(aggregates.get(id) ?? []), ...(contains.get(id) ?? [])]
              .filter((child) => child !== id)
              .map((child) => node(child, new Set([...seen, id])));
      return {
        ref: { modelId, guid: guid ?? asGuid("0".repeat(22)), localId: id } as SpatialNode["ref"],
        ifcClass: pascalCase(table.typeOf(id) ?? "Unknown"),
        name: params[2]?.k === "str" ? params[2].v : "",
        ...(elevation === null ? {} : { elevation: model.toMetres(elevation) }),
        children,
      };
    };

    const rootId = table.byType("IFCPROJECT")[0];
    if (rootId === undefined) {
      return err(kernelFailure("refused", "this model has no IfcProject, so it has no spatial tree", { modelId }));
    }
    return ok(node(rootId, new Set()));
  }

  /**
   * Snap points near a cursor, from the authoritative geometry rather than from tessellated meshes.
   *
   * Walls contribute both endpoints and the midpoint of their centre-line; anything else contributes its
   * placement origin. The caller feeds these to `resolveSnap` in `@massingviewer/geometry-math`, which owns the
   * priority rules — this only reports what exists, and deliberately does not rank.
   */
  snapCandidates(
    modelId: ModelId,
    near: { x: number; z: number },
    radius: number,
  ): Result<readonly SnapCandidatePoint[], KernelFailure> {
    const state = this.state(modelId);
    if (!state.ok) return state;
    const model = state.value.model;
    const { table } = model;
    const out: SnapCandidatePoint[] = [];

    const consider = (x: number, z: number, kind: SnapCandidatePoint["kind"], guid: Guid | null): void => {
      if (Math.hypot(x - near.x, z - near.z) > radius) return;
      out.push(guid === null ? { x, z, kind } : { x, z, kind, guid });
    };

    for (const id of table.ids()) {
      const type = table.typeOf(id);
      if (type === undefined || !type.startsWith("IFC")) continue;
      // Only things with geometry. Spatial structure — project, site, building, storey — has a placement but no
      // shape, and every one of them sits at the origin. Including them offered three snap candidates at 0,0
      // labelled "the building", which is not a point anyone means to snap to and which would win over real
      // geometry near the origin on any tie. Requiring a representation is the rule that expresses "snappable"
      // rather than a list of classes to exclude, so a class added later is handled correctly by default.
      if (SPATIAL_CLASSES.has(type)) continue;
      if (table.params(id)[6]?.k !== "ref") continue;
      const guid = table.guidOf(id);
      if (guid === null) continue;
      const origin = model.placementOrigin(id);
      if (origin === null) continue;
      const [ox = 0, oy = 0] = origin.at;

      if (type === "IFCWALL" || type === "IFCWALLSTANDARDCASE" || type === "IFCBEAM") {
        const geometry = wallAxis(model, id);
        if (geometry !== null) {
          const { length, rotation } = geometry;
          const ex = ox + Math.cos(rotation) * length;
          const ey = oy + Math.sin(rotation) * length;
          consider(ox, oy, "endpoint", guid);
          consider(ex, ey, "endpoint", guid);
          consider((ox + ex) / 2, (oy + ey) / 2, "midpoint", guid);
          continue;
        }
      }
      consider(ox, oy, "center", guid);
    }
    return ok(out);
  }
}

/**
 * Spatial structure: containers, not geometry.
 *
 * Listed as well as checked for a representation because `IfcSpace` legitimately *has* geometry — a room
 * volume — and is still not something to snap to while drawing a wall.
 */
const SPATIAL_CLASSES = new Set([
  "IFCPROJECT",
  "IFCSITE",
  "IFCBUILDING",
  "IFCBUILDINGSTOREY",
  "IFCSPACE",
  "IFCOPENINGELEMENT",
]);

interface ModelState {
  model: LocalModel;
  version: number;
  geometryVersion: number;
  undo: { label: string; ifc: string }[];
  transactions: Map<string, Snapshot>;
}

interface Snapshot {
  label: string;
  ifc: string;
  version: number;
  geometryVersion: number;
  /** Undo-stack depth when the transaction opened, so a rollback discards only what it should. */
  undoDepth: number;
}

/** A linear element's length and plan rotation, from its profile and placement. */
function wallAxis(model: LocalModel, id: number): { length: number; rotation: number } | null {
  const shapeRef = model.table.params(id)[6];
  if (shapeRef?.k !== "ref") return null;
  const reps = model.table.params(shapeRef.v)[2];
  if (reps?.k !== "list") return null;
  for (const rep of reps.v) {
    if (rep.k !== "ref") continue;
    const items = model.table.params(rep.v)[3];
    if (items?.k !== "list") continue;
    for (const item of items.v) {
      if (item.k !== "ref" || model.table.typeOf(item.v) !== "IFCEXTRUDEDAREASOLID") continue;
      const profileRef = model.table.params(item.v)[0];
      if (profileRef?.k !== "ref") continue;
      const curve = model.table.params(profileRef.v)[2];
      if (curve?.k !== "ref") continue;
      const pts = model.table.params(curve.v)[0];
      if (pts?.k !== "list") continue;
      let maxX = 0;
      for (const p of pts.v) {
        if (p.k !== "ref") continue;
        const coords = model.table.params(p.v)[0];
        if (coords?.k !== "list") continue;
        const x = coords.v[0]?.k === "num" ? model.toMetres(coords.v[0].v) : 0;
        if (x > maxX) maxX = x;
      }
      if (maxX <= 1e-9) return null;
      const origin = model.placementOrigin(id);
      let rotation = 0;
      if (origin !== null) {
        const dirRef = model.table.params(origin.axisId)[2];
        if (dirRef?.k === "ref") {
          const dir = model.table.params(dirRef.v)[0];
          if (dir?.k === "list") {
            const x = dir.v[0]?.k === "num" ? dir.v[0].v : 1;
            const y = dir.v[1]?.k === "num" ? dir.v[1].v : 0;
            rotation = Math.atan2(y, x);
          }
        }
      }
      return { length: maxX, rotation };
    }
  }
  return null;
}

/** `IFCWALLSTANDARDCASE` → `IfcWallStandardCase`, using IFC's own class names for display and matching. */
function pascalCase(upper: string): string {
  const KNOWN = [
    "IfcProject", "IfcSite", "IfcBuilding", "IfcBuildingStorey", "IfcSpace",
    "IfcWall", "IfcWallStandardCase", "IfcSlab", "IfcColumn", "IfcBeam",
    "IfcDoor", "IfcWindow", "IfcOpeningElement", "IfcRoof", "IfcStair",
    "IfcRailing", "IfcRamp", "IfcCovering", "IfcCurtainWall", "IfcFooting",
  ];
  return KNOWN.find((k) => k.toUpperCase() === upper) ?? `Ifc${upper.slice(3).toLowerCase()}`;
}

/**
 * An IFC typed value back to a plain JS value, for the property panel.
 *
 * `.T.`/`.F.` become booleans and every other enumeration stays a string. The alternative — treating every
 * enumeration as a string, including the booleans — puts the literal text "T" in a property grid where a
 * checkbox belongs, which is the kind of thing that gets reported as "the data is wrong" rather than as a
 * display bug.
 */
function plainValue(value: StepValue | undefined): unknown {
  switch (value?.k) {
    case "str":
      return value.v;
    case "num":
      return value.v;
    case "enum":
      return value.v === "T" ? true : value.v === "F" ? false : value.v;
    case "typed":
      return plainValue(value.v[0]);
    default:
      // `$`, `*`, a reference, a list, a binary literal — none of which a single-value property should hold.
      return null;
  }
}
