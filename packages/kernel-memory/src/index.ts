/**
 * `MemoryKernel` — a reference `KernelProvider`.
 *
 * ## What it is for
 *
 * Three jobs, and the first is the reason it exists at all:
 *
 * 1. **It proves the conformance suite is satisfiable.** A contract that nothing passes is a wish list. When
 *    `LocalKernel` and `RemoteKernel` fail an assertion, this is the thing that says the assertion is
 *    achievable — otherwise every failure is ambiguous between "the kernel is wrong" and "the suite is
 *    unreasonable".
 * 2. **It is the template for a third-party kernel.** `docs/kernels/authoring.md` points here. Reading a
 *    working implementation beats reading an interface.
 * 3. **It makes the rest of the stack testable without WASM, a worker, or a server.** The command bus, the
 *    ribbon's availability gating, undo, and the audit log all need *a* kernel; they do not need a
 *    geometrically correct one.
 *
 * ## What it deliberately is not
 *
 * Not a modeller. It stores parametric element records and writes valid IFC, but performs no CSG, no
 * openings, no joins, and no geometric validation beyond degeneracy checks. `LocalKernel` (web-ifc +
 * manifold + clipper2, in a Worker) is the real one.
 *
 * It is also **synchronous inside an async interface**, on purpose. The interface is async because
 * `manifold-3d` executes serially and one boolean on a dense mesh halts the event loop — so there must be no
 * synchronous path for anyone to accidentally take. A reference implementation that exposed a sync API would
 * quietly teach the wrong lesson.
 */

import {
  asGuid,
  err,
  ok,
  type ElementRef,
  type Guid,
  type ModelId,
  type Result,
} from "@massingviewer/core";
import {
  kernelFailure,
  unsupported,
  type ApplyOptions,
  type DrawingPayload,
  type DrawingRequest,
  type ElementProperties,
  type GeometryPayload,
  type KernelCapabilities,
  type KernelFailure,
  type KernelProvider,
  type OpDescriptor,
  type OpId,
  type OpParams,
  type OpResult,
  type SnapCandidatePoint,
  type SpatialNode,
  type Transaction,
} from "@massingviewer/kernel-api";

// ---------------------------------------------------------------------------------------------------
// GlobalId generation
// ---------------------------------------------------------------------------------------------------

const B64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

/**
 * A fresh GlobalId.
 *
 * Uses `crypto.getRandomValues` where available and a per-instance counter otherwise. The counter is
 * **per-instance, not module-level**, because the conformance suite asserts that two fresh kernels given the
 * same operations agree — and module-level state is exactly the leak that breaks. In production it shows up
 * as a kernel behaving differently on the second project opened in one session.
 */
function makeGuidFactory(): () => Guid {
  let counter = 0;
  const hasCrypto = typeof globalThis.crypto?.getRandomValues === "function";
  return () => {
    let out = "";
    if (hasCrypto) {
      const bytes = new Uint8Array(22);
      globalThis.crypto.getRandomValues(bytes);
      for (const b of bytes) out += B64[b % 64];
    } else {
      let x = BigInt(++counter) * 0x9e3779b97f4a7c15n + 0xdeadbeefcafebaben;
      for (let i = 0; i < 22; i++) {
        out += B64[Number(x & 63n)];
        x = (x >> 5n) ^ (x * 31n + BigInt(i));
        x &= (1n << 128n) - 1n;
      }
    }
    return asGuid(out);
  };
}

// ---------------------------------------------------------------------------------------------------
// The element store
// ---------------------------------------------------------------------------------------------------

interface Element {
  guid: Guid;
  ifcClass: string;
  name: string;
  /** Plan footprint, metres. */
  points: [number, number][];
  height: number;
  thickness: number;
  /** Vertical offset from the storey datum, metres. */
  base: number;
  psets: Record<string, Record<string, unknown>>;
}

interface ModelState {
  elements: Map<Guid, Element>;
  version: number;
  geometryVersion: number;
}

// ---------------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------------

/**
 * The supported operation set, with real parameter metadata.
 *
 * Names match massing's recipe keys 1:1 so a `RemoteKernel` needs no translation table — a table that would
 * need updating every time the server gains a recipe, which is what runtime discovery exists to avoid.
 */
const OPS: readonly OpDescriptor[] = [
  {
    id: "add_wall",
    category: "create-structure",
    produces: "IfcWall",
    invertible: true,
    description: "A straight wall between two plan points.",
    params: [
      { name: "start", type: "point", required: true, unit: "m" },
      { name: "end", type: "point", required: true, unit: "m" },
      { name: "height", type: "length", required: true, unit: "m", min: 0.01 },
      { name: "thickness", type: "length", required: true, unit: "m", min: 0.001 },
      { name: "name", type: "text", required: false },
    ],
  },
  {
    id: "add_slab",
    category: "create-structure",
    produces: "IfcSlab",
    invertible: true,
    params: [
      { name: "outline", type: "point-list", required: true, unit: "m" },
      { name: "thickness", type: "length", required: true, unit: "m", min: 0.001 },
      { name: "base", type: "length", required: false, unit: "m" },
      { name: "name", type: "text", required: false },
    ],
  },
  {
    id: "add_column",
    category: "create-structure",
    produces: "IfcColumn",
    invertible: true,
    params: [
      { name: "at", type: "point", required: true, unit: "m" },
      { name: "size", type: "length", required: true, unit: "m", min: 0.001 },
      { name: "height", type: "length", required: true, unit: "m", min: 0.01 },
      { name: "name", type: "text", required: false },
    ],
  },
  {
    id: "move_element",
    category: "edit",
    invertible: true,
    params: [
      { name: "guid", type: "guid", required: true },
      { name: "dx", type: "length", required: true, unit: "m" },
      { name: "dy", type: "length", required: true, unit: "m" },
    ],
  },
  {
    id: "delete_element",
    category: "edit",
    // Deliberately NOT invertible. The store does not keep tombstones, and claiming invertibility it cannot
    // honour is exactly the dishonesty the conformance suite's transaction family exists to catch. Undo
    // therefore dims with a reason rather than failing after the user commits.
    invertible: false,
    params: [{ name: "guid", type: "guid", required: true }],
  },
  {
    id: "set_extrusion_depth",
    category: "edit",
    invertible: true,
    params: [
      { name: "guid", type: "guid", required: true },
      { name: "depth", type: "length", required: true, unit: "m", min: 0.01 },
    ],
  },
  {
    id: "set_element_pset",
    category: "data",
    invertible: true,
    params: [
      { name: "guid", type: "guid", required: true },
      { name: "pset", type: "text", required: true },
      { name: "property", type: "text", required: true },
      { name: "value", type: "text", required: true },
    ],
  },
];

const OP_IDS = new Set(OPS.map((o) => o.id));

// ---------------------------------------------------------------------------------------------------
// Parameter helpers
// ---------------------------------------------------------------------------------------------------

type Fail = { readonly ok: false; readonly error: KernelFailure };

const fail = (code: KernelFailure["code"], message: string, detail?: Record<string, unknown>): Fail =>
  err(kernelFailure(code, message, detail)) as Fail;

function point(params: OpParams, key: string): [number, number] | Fail {
  const v = params[key];
  if (!Array.isArray(v) || v.length < 2) {
    return fail("invalid_param", `"${key}" must be a [x, z] point in metres`, { param: key });
  }
  const [x, z] = v as unknown[];
  if (typeof x !== "number" || typeof z !== "number" || !Number.isFinite(x) || !Number.isFinite(z)) {
    return fail("invalid_param", `"${key}" must contain two finite numbers`, { param: key });
  }
  return [x, z];
}

function length(params: OpParams, key: string, min = 0): number | Fail {
  const v = params[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return fail("invalid_param", `"${key}" must be a finite number of metres`, { param: key });
  }
  if (v <= min) {
    return fail("invalid_param", `"${key}" must be greater than ${min} m (got ${v})`, { param: key, value: v });
  }
  return v;
}

const isFail = (v: unknown): v is Fail =>
  typeof v === "object" && v !== null && "ok" in v && (v as { ok: unknown }).ok === false;

/** Minimum run length, matching `MIN_RUN_M` in @massingviewer/geometry-math. */
const MIN_RUN_M = 0.05;
/** Plausible model bounds, mirroring the placement checks. */
const MAX_COORD_M = 100_000;

// ---------------------------------------------------------------------------------------------------
// The kernel
// ---------------------------------------------------------------------------------------------------

export interface MemoryKernelOptions {
  /** Report a drawing capability. Off by default — this kernel has no sectioner. */
  readonly drawings?: boolean;
}

export function createMemoryKernel(options: MemoryKernelOptions = {}): KernelProvider {
  const nextGuid = makeGuidFactory();
  const models = new Map<ModelId, ModelState>();
  let disposed = false;
  let opsListed = false;
  let txSeq = 0;

  const capabilities: KernelCapabilities = {
    author: true,
    offline: true,
    // Snapshot: the store is small enough to clone, so rollback always works. `RemoteKernel` will report
    // "inverse" instead, because a service with partial inverse coverage cannot promise undo.
    transactions: "snapshot",
    drawings: options.drawings ? ["plan"] : [],
    identifiedLinework: Boolean(options.drawings),
    schema: "IFC4",
    geometryFormat: "ifc",
  };

  function state(modelId: ModelId): ModelState {
    let s = models.get(modelId);
    if (!s) {
      s = { elements: new Map(), version: 0, geometryVersion: 0 };
      models.set(modelId, s);
    }
    return s;
  }

  const versionOf = (s: ModelState) => `v${s.version}`;
  const geometryVersionOf = (s: ModelState) => `g${s.geometryVersion}`;

  function result(s: ModelState, created: Guid[], modified: Guid[], deleted: Guid[], summary: Record<string, unknown>): OpResult {
    return {
      created,
      modified,
      deleted,
      summary,
      geometryVersion: geometryVersionOf(s),
      modelVersion: versionOf(s),
    };
  }

  /** Reject implausible geometry before it enters the store — cheaper than discovering it in a drawing. */
  function checkBounds(points: readonly [number, number][]): Fail | null {
    for (const [x, z] of points) {
      if (Math.abs(x) > MAX_COORD_M || Math.abs(z) > MAX_COORD_M) {
        return fail("out_of_bounds", `point (${x}, ${z}) lies outside the plausible model extent`, { x, z });
      }
    }
    return null;
  }

  function apply(
    modelId: ModelId,
    op: OpId,
    params: OpParams,
    opts?: ApplyOptions,
  ): Result<OpResult, KernelFailure> {
    if (disposed) return fail("internal", "kernel has been disposed");
    if (opts?.signal?.aborted) return fail("cancelled", "aborted before the operation began");

    if (!OP_IDS.has(op)) {
      // The hint is required, and it names what would unlock the operation. Unsupported operations stay
      // visible and dimmed rather than hidden, so the user can discover what exists — which only works if
      // the kernel explains itself.
      return err(
        unsupported(
          op,
          `"${op}" is not implemented by MemoryKernel. It supports ${OPS.length} operations; connect a ` +
            `Massing authoring service for the full set.`,
        ),
      ) as Fail;
    }

    const s = state(modelId);

    // Optimistic concurrency, checked before any mutation so a conflict cannot half-apply.
    if (opts?.expectedVersion !== undefined && opts.expectedVersion !== versionOf(s)) {
      return fail(
        "version_conflict",
        `the model has moved on (expected ${opts.expectedVersion}, now ${versionOf(s)})`,
        { expected: opts.expectedVersion, actual: versionOf(s) },
      );
    }

    const bump = (geometry: boolean) => {
      s.version++;
      if (geometry) s.geometryVersion++;
    };

    const element = (guid: unknown): Element | Fail => {
      if (typeof guid !== "string") return fail("invalid_param", `"guid" must be a string`);
      const el = s.elements.get(guid as Guid);
      if (!el) return fail("no_such_element", `no element with GlobalId ${guid} in this model`, { guid });
      return el;
    };

    switch (op) {
      case "add_wall": {
        const start = point(params, "start");
        if (isFail(start)) return start;
        const end = point(params, "end");
        if (isFail(end)) return end;
        const height = length(params, "height", 0.01);
        if (isFail(height)) return height;
        const thickness = length(params, "thickness", 0.001);
        if (isFail(thickness)) return thickness;

        const run = Math.hypot(end[0] - start[0], end[1] - start[1]);
        if (run < MIN_RUN_M) {
          // `degenerate_geometry`, not `invalid_param`: each value is individually valid, and it is their
          // combination that cannot become a wall. The distinction is what lets the UI say something useful.
          return fail(
            "degenerate_geometry",
            `a wall must be at least ${MIN_RUN_M * 1000} mm long (got ${(run * 1000).toFixed(1)} mm)`,
            { length: run },
          );
        }
        const oob = checkBounds([start, end]);
        if (oob) return oob;

        const guid = nextGuid();
        s.elements.set(guid, {
          guid,
          ifcClass: "IfcWall",
          name: typeof params.name === "string" ? params.name : `Wall-${s.elements.size + 1}`,
          points: [start, end],
          height,
          thickness,
          base: 0,
          psets: {},
        });
        bump(true);
        return ok(result(s, [guid], [], [], { length: run }));
      }

      case "add_slab": {
        const raw = params.outline;
        if (!Array.isArray(raw) || raw.length < 3) {
          return fail("invalid_param", `"outline" must be at least 3 plan points`);
        }
        const pts: [number, number][] = [];
        for (let i = 0; i < raw.length; i++) {
          const p = point({ p: raw[i] }, "p");
          if (isFail(p)) return p;
          pts.push(p);
        }
        const thickness = length(params, "thickness", 0.001);
        if (isFail(thickness)) return thickness;
        const oob = checkBounds(pts);
        if (oob) return oob;

        const guid = nextGuid();
        s.elements.set(guid, {
          guid,
          ifcClass: "IfcSlab",
          name: typeof params.name === "string" ? params.name : `Slab-${s.elements.size + 1}`,
          points: pts,
          height: thickness,
          thickness,
          base: typeof params.base === "number" ? params.base : 0,
          psets: {},
        });
        bump(true);
        return ok(result(s, [guid], [], [], { points: pts.length }));
      }

      case "add_column": {
        const at = point(params, "at");
        if (isFail(at)) return at;
        const size = length(params, "size", 0.001);
        if (isFail(size)) return size;
        const height = length(params, "height", 0.01);
        if (isFail(height)) return height;
        const oob = checkBounds([at]);
        if (oob) return oob;

        const h = size / 2;
        const guid = nextGuid();
        s.elements.set(guid, {
          guid,
          ifcClass: "IfcColumn",
          name: typeof params.name === "string" ? params.name : `Column-${s.elements.size + 1}`,
          points: [
            [at[0] - h, at[1] - h],
            [at[0] + h, at[1] - h],
            [at[0] + h, at[1] + h],
            [at[0] - h, at[1] + h],
          ],
          height,
          thickness: size,
          base: 0,
          psets: {},
        });
        bump(true);
        return ok(result(s, [guid], [], [], { size }));
      }

      case "move_element": {
        const el = element(params.guid);
        if (isFail(el)) return el;
        const dx = params.dx;
        const dy = params.dy;
        if (typeof dx !== "number" || typeof dy !== "number" || !Number.isFinite(dx) || !Number.isFinite(dy)) {
          return fail("invalid_param", `"dx" and "dy" must be finite numbers of metres`);
        }
        const moved = el.points.map(([x, z]) => [x + dx, z + dy] as [number, number]);
        const oob = checkBounds(moved);
        if (oob) return oob;
        el.points = moved;
        bump(true);
        return ok(result(s, [], [el.guid], [], { dx, dy }));
      }

      case "delete_element": {
        const el = element(params.guid);
        if (isFail(el)) return el;
        s.elements.delete(el.guid);
        bump(true);
        return ok(result(s, [], [], [el.guid], {}));
      }

      case "set_extrusion_depth": {
        const el = element(params.guid);
        if (isFail(el)) return el;
        // The refusal massing's UI depends on: there is deliberately NO client-side allowlist for push-pull,
        // so the refusal must arrive through the normal error path with a code the UI can act on. A kernel
        // that silently succeeded here would make push-pull appear to work on things it cannot edit.
        if (el.ifcClass === "IfcSlab") {
          return fail(
            "not_an_extrusion",
            `${el.name} is a slab defined by its outline, so its depth cannot be push-pulled`,
            { guid: el.guid, ifcClass: el.ifcClass },
          );
        }
        const depth = length(params, "depth", 0.01);
        if (isFail(depth)) return depth;
        el.height = depth;
        bump(true);
        return ok(result(s, [], [el.guid], [], { depth }));
      }

      case "set_element_pset": {
        const el = element(params.guid);
        if (isFail(el)) return el;
        const pset = params.pset;
        const property = params.property;
        if (typeof pset !== "string" || typeof property !== "string" || pset === "" || property === "") {
          return fail("invalid_param", `"pset" and "property" must be non-empty strings`);
        }
        (el.psets[pset] ??= {})[property] = params.value;
        // Metadata only — the model version advances but the GEOMETRY version does not, so the caller does
        // not re-stream the model for a property edit.
        bump(false);
        return ok(result(s, [], [el.guid], [], { pset, property }));
      }

      default:
        return err(unsupported(op, `"${op}" is declared but not implemented — this is a bug in MemoryKernel.`)) as Fail;
    }
  }

  // --- IFC export ---------------------------------------------------------------------------------

  function exportIfc(modelId: ModelId): Uint8Array {
    const s = state(modelId);
    const lines: string[] = [];
    let id = 0;
    const e = (type: string, args: string) => {
      lines.push(`#${++id}= ${type}(${args});`);
      return `#${id}`;
    };
    const n = (v: number) => (Number.isInteger(v) ? `${v}.` : String(v));

    const metre = e("IFCSIUNIT", "*,.LENGTHUNIT.,$,.METRE.");
    const units = e("IFCUNITASSIGNMENT", `(${metre})`);
    const origin = e("IFCCARTESIANPOINT", `(${n(0)},${n(0)},${n(0)})`);
    const axis = e("IFCAXIS2PLACEMENT3D", `${origin},$,$`);
    const ctx = e("IFCGEOMETRICREPRESENTATIONCONTEXT", `$,'Model',3,1.E-05,${axis},$`);
    const place = e("IFCLOCALPLACEMENT", `$,${axis}`);
    e("IFCPROJECT", `'${nextGuid()}',$,'MemoryKernel',$,$,$,$,(${ctx}),${units}`);
    const storey = e("IFCBUILDINGSTOREY", `'${nextGuid()}',$,'Level 1',$,$,${place},$,$,.ELEMENT.,${n(0)}`);

    const products: string[] = [];
    for (const el of s.elements.values()) {
      // Walls are stored as an axis + thickness; widen them into a footprint so the exported profile is a
      // real closed area rather than a degenerate line.
      const outline =
        el.ifcClass === "IfcWall" && el.points.length === 2
          ? widen(el.points[0]!, el.points[1]!, el.thickness)
          : el.points;

      const pts = outline.map(([x, z]) => e("IFCCARTESIANPOINT", `(${n(x)},${n(z)})`));
      const poly = e("IFCPOLYLINE", `(${[...pts, pts[0]].join(",")})`);
      const profile = e("IFCARBITRARYCLOSEDPROFILEDEF", `.AREA.,$,${poly}`);
      const basePt = e("IFCCARTESIANPOINT", `(${n(0)},${n(0)},${n(el.base)})`);
      const baseAxis = e("IFCAXIS2PLACEMENT3D", `${basePt},$,$`);
      const dir = e("IFCDIRECTION", `(${n(0)},${n(0)},${n(1)})`);
      const solid = e("IFCEXTRUDEDAREASOLID", `${profile},${baseAxis},${dir},${n(el.height)}`);
      const rep = e("IFCSHAPEREPRESENTATION", `${ctx},'Body','SweptSolid',(${solid})`);
      const shape = e("IFCPRODUCTDEFINITIONSHAPE", `$,$,(${rep})`);
      const type = el.ifcClass.toUpperCase();
      // The GlobalId is written verbatim: the conformance suite asserts that the id handed back by `apply`
      // appears in the exported bytes, because a writer that re-generates ids on save breaks every persisted
      // reference in the product.
      products.push(e(type, `'${el.guid}',$,'${el.name}',$,$,${place},${shape},$,$`));
    }
    if (products.length > 0) {
      e("IFCRELCONTAINEDINSPATIALSTRUCTURE", `'${nextGuid()}',$,$,$,(${products.join(",")}),${storey}`);
    }

    const header =
      `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');\n` +
      `FILE_NAME('memory.ifc','',('MassingViewer'),('MassingCloud'),'@massingviewer/kernel-memory','',' ');\n` +
      `FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;`;
    return new TextEncoder().encode(`${header}\n${lines.join("\n")}\nENDSEC;\nEND-ISO-10303-21;\n`);
  }

  /** Widen a two-point axis into a rectangle of the given thickness. */
  function widen(a: [number, number], b: [number, number], thickness: number): [number, number][] {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * (thickness / 2);
    const nz = (dx / len) * (thickness / 2);
    return [
      [a[0] + nx, a[1] + nz],
      [b[0] + nx, b[1] + nz],
      [b[0] - nx, b[1] - nz],
      [a[0] - nx, a[1] - nz],
    ];
  }

  // --- the provider -------------------------------------------------------------------------------

  const provider: KernelProvider = {
    id: "memory",
    version: "0.0.0",
    capabilities,

    async ops() {
      if (disposed) return fail("internal", "kernel has been disposed");
      opsListed = true;
      return ok(OPS);
    },

    supports(op) {
      // False until `ops()` has resolved once, rather than guessing. A ribbon that renders enabled controls
      // before the operation set is known would flicker, and worse, would let a user click something the
      // kernel has not confirmed it can do.
      return opsListed && OP_IDS.has(op);
    },

    async apply(modelId, op, params, opts) {
      return apply(modelId, op, params, opts);
    },

    async geometry(modelId, opts) {
      if (disposed) return fail("internal", "kernel has been disposed");
      if (opts?.signal?.aborted) return fail("cancelled", "aborted before geometry was produced");
      const bytes = exportIfc(modelId);
      opts?.onProgress?.(bytes.byteLength, bytes.byteLength);
      const payload: GeometryPayload = {
        format: "ifc",
        bytes,
        geometryVersion: geometryVersionOf(state(modelId)),
      };
      return ok(payload);
    },

    async properties(refs, signal) {
      if (signal?.aborted) return fail("cancelled", "aborted");
      const out = new Map<Guid, ElementProperties>();
      for (const ref of refs) {
        const el = models.get(ref.modelId)?.elements.get(ref.guid);
        if (!el) continue; // absent rather than an error: a partial result is the honest answer
        out.set(el.guid, {
          guid: el.guid,
          ifcClass: el.ifcClass,
          name: el.name,
          psets: el.psets,
          materials: [{ name: "Unspecified", thickness: el.thickness }],
        });
      }
      return ok(out);
    },

    async spatialTree(modelId, signal) {
      if (signal?.aborted) return fail("cancelled", "aborted");
      const s = state(modelId);
      const children: SpatialNode[] = [...s.elements.values()].map((el) => ({
        ref: { modelId, guid: el.guid } satisfies ElementRef,
        ifcClass: el.ifcClass,
        name: el.name,
        children: [],
      }));
      return ok({
        ref: { modelId, guid: asGuid("0000000000000000000001") },
        ifcClass: "IfcBuildingStorey",
        name: "Level 1",
        elevation: 0,
        children,
      });
    },

    async snapCandidates(modelId, near, radius, signal) {
      if (signal?.aborted) return fail("cancelled", "aborted");
      const s = state(modelId);
      const out: SnapCandidatePoint[] = [];
      for (const el of s.elements.values()) {
        const pts = el.points;
        for (let i = 0; i < pts.length; i++) {
          const [x, z] = pts[i]!;
          if (Math.hypot(x - near.x, z - near.z) <= radius) {
            out.push({ x, z, kind: "endpoint", guid: el.guid });
          }
          const next = pts[(i + 1) % pts.length]!;
          if (i + 1 < pts.length || pts.length > 2) {
            const mx = (x + next[0]) / 2;
            const mz = (z + next[1]) / 2;
            if (Math.hypot(mx - near.x, mz - near.z) <= radius) {
              out.push({ x: mx, z: mz, kind: "midpoint", guid: el.guid });
            }
          }
        }
      }
      return ok(out);
    },

    async drawing(modelId, request: DrawingRequest) {
      if (!capabilities.drawings.includes(request.kind)) {
        return err(
          unsupported(
            `drawing:${request.kind}`,
            `MemoryKernel has no sectioner. Use LocalKernel, or connect a Massing service, for ${request.kind} drawings.`,
          ),
        ) as Fail;
      }
      const s = state(modelId);
      const payload: DrawingPayload = {
        drawing: { entities: [] },
        provenance: {
          provider: "memory",
          providerVersion: "0.0.0",
          durationMs: 0,
          // Honest: everything failed to section, because there is no sectioner. An empty `incomplete` list
          // here would be a claim that the drawing is complete.
          incomplete: [...s.elements.values()].map((el) => ({
            guid: el.guid,
            ifcClass: el.ifcClass,
            reason: "MemoryKernel does not section geometry",
          })),
          guidCoverage: 0,
          approximations: ["no sectioning: this kernel emits an empty drawing"],
        },
      };
      return ok(payload);
    },

    async exportIfc(modelId, signal) {
      if (signal?.aborted) return fail("cancelled", "aborted");
      return ok(exportIfc(modelId));
    },

    async begin(modelId, label) {
      if (disposed) return fail("internal", "kernel has been disposed");
      const s = state(modelId);
      // Snapshot rollback. Viable because the store is small; `LocalKernel` will snapshot the IFC buffer and
      // `RemoteKernel` cannot snapshot at all, which is why `TransactionSupport` is declared per kernel.
      const snapshot = new Map([...s.elements].map(([g, el]) => [g, structuredClone(el)]));
      const beforeVersion = s.version;
      const beforeGeometry = s.geometryVersion;
      const id = `tx${++txSeq}`;

      const tx: Transaction = {
        id,
        label,
        async commit() {
          return ok(result(s, [], [...s.elements.keys()], [], { transaction: id }));
        },
        async rollback() {
          s.elements = snapshot;
          s.version = beforeVersion;
          s.geometryVersion = beforeGeometry;
          return ok(undefined);
        },
      };
      return ok(tx);
    },

    async dispose() {
      // Idempotent by construction. Called from a component unmount, which happens twice under React strict
      // mode; throwing the second time turns a benign double-unmount into a crash.
      disposed = true;
      models.clear();
    },
  };

  return provider;
}
