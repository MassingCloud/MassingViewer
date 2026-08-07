import type { ElementRef, Guid, ModelId, Result } from "@massingviewer/core";
import type { KernelFailure } from "./failure.js";

/**
 * The `KernelProvider` contract.
 *
 * One interface, two intended implementations:
 *
 * - `LocalKernel` — `web-ifc` + `manifold-3d` + `clipper2` in a Web Worker. Fully offline; the model
 *   never leaves the browser.
 * - `RemoteKernel` — an HTTP adapter to a massing authoring service, which writes IFC with
 *   `ifcopenshell` and exposes ~96 named recipes.
 *
 * ## Why operations are *named recipes* and not a geometry API
 *
 * The obvious design is `move(element, matrix)` / `extrude(profile, depth)`. It cannot express what the
 * remote service already does: `add_connection_assembly`, `program_fit`, `resolve_wall_joins`,
 * `derive_analytical`. Those are domain operations with rich parameter bags and their own guardrails —
 * there is no `Matrix4` that means "fit this program to this envelope".
 *
 * So an operation is an `OpId` plus a parameter object, and the *set of operations is discovered at
 * runtime* rather than compiled in. That is what makes a new server-side recipe appear in the ribbon
 * with no client change, and it is the difference between a plugin system and a plugin API.
 *
 * ## Two rules that make the abstraction honest
 *
 * **1. Every method is async, and there is no synchronous escape hatch.** Not for elegance —
 * `manifold-3d` executes serially and a single boolean on a dense mesh will halt the event loop. Making
 * the contract async means "just call it inline for now" is not available, so the Worker boundary cannot
 * be eroded one convenient call at a time. Retrofitting it later is a rewrite.
 *
 * **2. Capability claims are testable and tested.** {@link KernelProvider.ops} is not documentation.
 * `@massingviewer/kernel-conformance` asserts that every op a kernel claims actually works, and that
 * every op it does *not* claim returns `unsupported` — rather than throwing, hanging, or silently doing
 * nothing. A kernel that lies about its capabilities fails CI.
 */
export interface KernelProvider {
  readonly id: string;
  readonly version: string;

  /** Static shape of this kernel. Cheap, synchronous, safe to read during render. */
  readonly capabilities: KernelCapabilities;

  /**
   * Every operation this kernel can perform, with parameter metadata.
   *
   * Discovered, not hardcoded: `RemoteKernel` reads the server's authoring matrix, so a recipe
   * registered by a server-side plugin — namespaced `<plugin>.<recipe>` — arrives here and reaches the
   * ribbon with zero client change.
   */
  ops(signal?: AbortSignal): Promise<Result<readonly OpDescriptor[], KernelFailure>>;

  /**
   * Whether an op is available. Synchronous because the ribbon calls it per control per render, and an
   * async availability check would mean every button flickers on mount.
   *
   * Implementations answer from the cached result of {@link ops}, so this is only meaningful after
   * `ops()` has resolved once; before that it must return `false` rather than guessing.
   */
  supports(op: OpId): boolean;

  /**
   * Apply one operation.
   *
   * **GUID stability is the contract.** Created elements get GlobalIds that survive re-serialisation,
   * reload, and export. Modified elements keep theirs. This is the single invariant everything else
   * rests on — markup anchoring, plan↔3D selection sync, schedules, issue tracking — and it is the one
   * most likely to differ silently between an `ifcopenshell` writer and a `web-ifc` writer, which is
   * why the conformance suite tests it first and hardest.
   */
  apply(
    modelId: ModelId,
    op: OpId,
    params: OpParams,
    options?: ApplyOptions,
  ): Promise<Result<OpResult, KernelFailure>>;

  /** Model bytes for the renderer, in whichever streaming format this kernel produces. */
  geometry(
    modelId: ModelId,
    options?: { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void },
  ): Promise<Result<GeometryPayload, KernelFailure>>;

  /** Property sets for elements. Batched, because per-element round-trips are the usual perf mistake. */
  properties(
    refs: readonly ElementRef[],
    signal?: AbortSignal,
  ): Promise<Result<ReadonlyMap<Guid, ElementProperties>, KernelFailure>>;

  /** The spatial decomposition: project → site → building → storey → element. */
  spatialTree(modelId: ModelId, signal?: AbortSignal): Promise<Result<SpatialNode, KernelFailure>>;

  /**
   * Candidate snap points near a cursor, for the operation being drawn.
   *
   * Lives on the kernel rather than the viewport because the *authoritative* geometry does. The
   * viewport can offer snaps against tessellated meshes it happens to have loaded; the kernel can offer
   * them against the real element. Callers feed the result to `resolveSnap` in
   * `@massingviewer/geometry-math`, which is where the priority rules live.
   */
  snapCandidates(
    modelId: ModelId,
    near: { x: number; z: number },
    radius: number,
    signal?: AbortSignal,
  ): Promise<Result<readonly SnapCandidatePoint[], KernelFailure>>;

  /** Generate a 2D drawing. Absent from `capabilities.drawings` → `unsupported`. */
  drawing(
    modelId: ModelId,
    request: DrawingRequest,
    options?: { signal?: AbortSignal; onProgress?: (fraction: number, note: string) => void },
  ): Promise<Result<DrawingPayload, KernelFailure>>;

  /** Serialise the current model to IFC bytes. */
  exportIfc(modelId: ModelId, signal?: AbortSignal): Promise<Result<Uint8Array, KernelFailure>>;

  /** Group several operations into one undo step. See {@link Transaction} for the honesty caveat. */
  begin(modelId: ModelId, label: string): Promise<Result<Transaction, KernelFailure>>;

  /** Release workers, WASM instances, connections. Idempotent. */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------------

/**
 * An operation name. 1:1 with the remote service's recipe keys, so `RemoteKernel` needs no translation
 * table — a table that would have to be updated every time the server gains a recipe, which is exactly
 * the coupling runtime discovery exists to avoid.
 *
 * A dot namespaces a plugin-contributed op: `acme.brand_wall`.
 */
export type OpId = string;

export type OpParams = Readonly<Record<string, unknown>>;

export interface ParamDescriptor {
  readonly name: string;
  readonly type:
    | "point"
    | "point-list"
    | "length"
    | "number"
    | "integer"
    | "text"
    | "boolean"
    | "enum"
    | "guid"
    | "guid-list"
    | "object";
  readonly required: boolean;
  /** Lengths are always metres at this boundary — see `@massingviewer/core`'s units note. */
  readonly unit?: "m" | "deg";
  readonly options?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly description?: string;
}

export interface OpDescriptor {
  readonly id: OpId;
  /** Grouping for the ribbon and palette: "create-structure", "edit", "annotate", "data"… */
  readonly category: string;
  /** IFC class this produces, when it creates something: "IfcWall". */
  readonly produces?: string;
  readonly params: readonly ParamDescriptor[];
  /**
   * Whether this op has a registered inverse.
   *
   * Load-bearing for undo, and it is *not* uniform: a remote service may be able to reverse
   * `move_element` and not `delete_element`. Declaring it per-op is what lets Undo dim itself with an
   * accurate reason instead of failing after the user commits to it.
   */
  readonly invertible: boolean;
  /** Set when a plugin contributed this op, so the UI can badge third-party operations. */
  readonly pluginId?: string;
  readonly description?: string;
}

export interface ApplyOptions {
  readonly signal?: AbortSignal;
  /** Optimistic-concurrency token from a prior read. Mismatch → `version_conflict`, never a clobber. */
  readonly expectedVersion?: string;
  readonly transactionId?: string;
  readonly onProgress?: (fraction: number, note: string) => void;
}

export interface OpResult {
  /** GlobalIds of created elements, in creation order. */
  readonly created: readonly Guid[];
  readonly modified: readonly Guid[];
  readonly deleted: readonly Guid[];
  /** Per-op summary, passed through verbatim from the kernel for display. */
  readonly summary: Readonly<Record<string, unknown>>;
  /**
   * Bumped only when geometry actually changed.
   *
   * The caller re-streams geometry when this differs from what it holds. Distinguishing a
   * geometry-changing op from a metadata-only one is what stops a property edit from triggering a full
   * model reload.
   */
  readonly geometryVersion: string;
  readonly modelVersion: string;
}

// ---------------------------------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------------------------------

export interface KernelCapabilities {
  /** False for a read-only kernel: every `apply` returns `unsupported`. */
  readonly author: boolean;
  /** True when no network is required for any operation. */
  readonly offline: boolean;
  readonly transactions: TransactionSupport;
  readonly drawings: readonly DrawingKind[];
  /**
   * Whether generated drawing entities carry the GlobalId of the element they came from.
   *
   * Pass/fail for the product, not a nice-to-have: without it, plan↔3D selection sync does not work
   * and a markup placed on a plan has nothing to anchor to. A kernel reporting `false` here can render
   * pictures but cannot participate in the review loop, and the UI must say so rather than appearing
   * to work.
   */
  readonly identifiedLinework: boolean;
  readonly schema: "IFC2X3" | "IFC4" | "IFC4X3_ADD2" | "IFC5";
  /** Streaming format of {@link KernelProvider.geometry}. */
  readonly geometryFormat: "fragments" | "gltf" | "ifc";
  /** Soft ceiling for this kernel/device, used to warn before a load rather than after a crash. */
  readonly maxModelBytes?: number;
}

/**
 * How undo works — and it differs between kernels, so it is declared rather than assumed.
 *
 * - `snapshot` — the kernel can restore a prior state cheaply. Undo always works.
 * - `inverse` — undo is replaying an inverse op, which only exists for *some* ops.
 * - `none` — no undo below the UI layer.
 *
 * The `inverse` case is the one that matters. A remote service with no transaction support and partial
 * inverse coverage cannot promise undo. The alternative to declaring that is an Undo button that fails
 * *after* the user has committed to it, which is strictly worse than one that dims itself and explains.
 */
export type TransactionSupport = "snapshot" | "inverse" | "none";

export type DrawingKind = "plan" | "section" | "elevation" | "axon" | "detail" | "sheet";

// ---------------------------------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------------------------------

export interface Transaction {
  readonly id: string;
  readonly label: string;
  commit(): Promise<Result<OpResult, KernelFailure>>;
  /**
   * Undo the transaction.
   *
   * Under `transactions: "inverse"` this can partially fail, and it says so instead of pretending: the
   * failure names the first op it could not reverse, so the message the user sees is "cannot undo:
   * the service cannot reverse 'delete_element'" rather than a generic error after the model has
   * already been half-restored.
   */
  rollback(): Promise<Result<void, KernelFailure>>;
}

// ---------------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------------

export interface GeometryPayload {
  readonly format: "fragments" | "gltf" | "ifc";
  readonly bytes: Uint8Array;
  readonly geometryVersion: string;
}

export interface ElementProperties {
  readonly guid: Guid;
  readonly ifcClass: string;
  readonly name?: string;
  readonly predefinedType?: string;
  /** Property sets, keyed by Pset name then property name. */
  readonly psets: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly materials?: readonly MaterialLayer[];
}

export interface MaterialLayer {
  readonly name: string;
  /** Metres. */
  readonly thickness: number;
}

export interface SpatialNode {
  readonly ref: ElementRef;
  readonly ifcClass: string;
  readonly name: string;
  /** Metres above project zero, for storeys. */
  readonly elevation?: number;
  readonly children: readonly SpatialNode[];
}

export interface SnapCandidatePoint {
  readonly x: number;
  readonly z: number;
  readonly kind: "endpoint" | "midpoint" | "center" | "intersection" | "perpendicular" | "nearest";
  /** The element this point belongs to, so a snap can report what it snapped to. */
  readonly guid?: Guid;
}

// ---------------------------------------------------------------------------------------------------
// Drawings
// ---------------------------------------------------------------------------------------------------

export interface DrawingRequest {
  readonly kind: DrawingKind;
  /** Plan: the storey to cut. Null → cut at `cutHeight` above project zero. */
  readonly storey?: string | null;
  /** Metres above the storey datum. Architectural convention is ~1.2 m. */
  readonly cutHeight?: number;
  /** Section/elevation. */
  readonly axis?: "x" | "y";
  readonly offset?: number;
  readonly direction?: "north" | "south" | "east" | "west";
  readonly viewDepth?: number;
  /** Restrict to these IFC classes. Empty/absent → everything. */
  readonly classes?: readonly string[];
  readonly include?: DrawingIncludes;
}

export interface DrawingIncludes {
  readonly hatching?: boolean;
  readonly hiddenLines?: boolean;
  readonly belowCut?: boolean;
  readonly grid?: boolean;
  readonly tags?: boolean;
  readonly dimensions?: boolean;
  readonly keynotes?: boolean;
}

/**
 * A generated drawing.
 *
 * `provenance` is mandatory and is the part most likely to be treated as optional. A plan that is
 * silently missing a wall **renders perfectly** — there is no visual cue, and the person who finds out
 * is on site. So a kernel must report which elements failed to section and what fraction of the output
 * carries a GlobalId, and the UI is expected to surface both. The full model is defined in
 * `@massingviewer/drawings2d`; this is the transport shape.
 */
export interface DrawingPayload {
  /** Semantic Drawing Model, JSON-serialisable. Model-space metres — paper is a render-time transform. */
  readonly drawing: unknown;
  readonly provenance: DrawingProvenance;
}

export interface DrawingProvenance {
  readonly provider: string;
  readonly providerVersion: string;
  readonly durationMs: number;
  /** Elements that could not be sectioned, and why. Empty is a claim, not an absence of data. */
  readonly incomplete: readonly { guid: Guid; ifcClass: string; reason: string }[];
  /** Fraction of entities carrying a GlobalId, 0..1. The KPI for `identifiedLinework`. */
  readonly guidCoverage: number;
  /** Honest shortcuts taken: "hidden lines: z-sort only", "arcs tessellated at 2mm". */
  readonly approximations: readonly string[];
}
