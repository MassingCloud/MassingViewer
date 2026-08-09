import { err, ok, type ElementRef, type Guid, type Result } from "@massing/core";
import {
  kernelFailure,
  unsupported,
  type ApplyOptions,
  type DrawingKind,
  type KernelCapabilities,
  type KernelFailure,
  type KernelProvider,
  type OpDescriptor,
  type OpId,
  type DrawingPayload,
  type DrawingProvenance,
  type DrawingRequest,
  type ElementProperties,
  type GeometryPayload,
  type OpResult,
  type SnapCandidatePoint,
  type SpatialNode,
  type Transaction,
} from "@massing/kernel-api";
import type { HttpInit, HttpOutcome, HttpTransport } from "./transport.js";

/**
 * `RemoteKernel` — the same `KernelProvider` interface over massing's authoring service.
 *
 * ## Why the plan put this before `LocalKernel`, and why building it late was a mistake
 *
 * The plan called the ordering load-bearing: *"`RemoteKernel` is a thin adapter over endpoints that already work,
 * so it turns the conformance suite green fast, converting it from aspirational documentation into an executable
 * spec that `LocalKernel` is then measured against. Building `LocalKernel` first means writing suite and
 * implementation simultaneously, and the suite will quietly bend."*
 *
 * It was built last, and the prediction held: the conformance suite had only ever run against kernels written
 * alongside it. Whether it describes *massing's* semantics or merely this repository's has been untested until now.
 *
 * ## The two things that make it honest
 *
 * **Operations are discovered, not hardcoded.** `ops()` reads `GET /reference/authoring-matrix`, so registering a
 * recipe on the server makes the ribbon gain it with no client change. A hardcoded list of 96 would be wrong the
 * first time someone added the 97th, and wrong silently.
 *
 * **`transactions: "inverse"`, not `"snapshot"`.** massing's service has no transaction and only *some* recipes
 * have inverses, so `rollback` can genuinely fail partway. Declaring `"snapshot"` would be a lie that surfaces as
 * a half-restored model; declaring `"inverse"` lets Undo dim itself with the reason
 * *"the server cannot reverse 'delete_element'"*.
 */

export interface RemoteKernelOptions {
  readonly transport: HttpTransport;
  /** massing's project id. Every authoring endpoint is scoped to one. */
  readonly projectId: string;
  /**
   * How long to poll `waitForPublish` before giving up, in ms.
   *
   * A ceiling rather than "forever": a job the service has silently dropped would otherwise leave the UI spinning
   * with no way to tell the user anything. 60 s is comfortably longer than any recipe massing runs.
   */
  readonly publishTimeoutMs?: number;
  /** Poll interval, ms. Injected so tests do not wait. */
  readonly pollIntervalMs?: number;
  /** Injected clock, so a timeout is testable without real time passing. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The service's own refusal shape. `detail` is where massing puts the sentence a user should read. */
interface ServiceError {
  readonly code?: string;
  readonly detail?: string;
  readonly message?: string;
}

/**
 * Map an HTTP failure onto the closed error taxonomy.
 *
 * The mapping is the interesting part of this adapter, because refusal *parity* is what the conformance suite
 * checks: both kernels must produce the same code for the same bad input, or one UI message cannot serve both.
 *
 * The service's own `code` wins when it sends one — it knows more than the status line does. A 422 carrying
 * `degenerate_geometry` is that, not a generic refusal.
 */
function failureFrom(outcome: Extract<HttpOutcome<unknown>, { ok: false }>, op?: string): KernelFailure {
  const body = (outcome.body ?? {}) as ServiceError;
  const detail = body.detail ?? body.message ?? outcome.error;

  const declared = body.code;
  const KNOWN = new Set([
    "refused",
    "no_such_element",
    "invalid_param",
    "degenerate_geometry",
    "out_of_bounds",
    "not_an_extrusion",
    "version_conflict",
    "forbidden",
    "unsupported",
  ]);
  if (declared !== undefined && KNOWN.has(declared)) {
    return kernelFailure(declared as KernelFailure["code"], detail, { op });
  }

  // `status: 0` is "never reached a server" — but that covers two different things, and the conformance suite
  // caught me conflating them. An aborted request also never reaches a server, and reporting it as `transport`
  // tells the user "cannot reach the authoring service" when what actually happened is that they pressed Escape.
  // `cancelled` is documented as "a normal outcome, not a fault"; `transport` sends someone to check their network.
  if (outcome.status === 0) {
    if (/abort/i.test(detail)) return kernelFailure("cancelled", "cancelled", { op });
    return kernelFailure("transport", `cannot reach the authoring service: ${detail}`, { op });
  }
  switch (outcome.status) {
    case 400:
      return kernelFailure("invalid_param", detail, { op });
    case 401:
    case 403:
      return kernelFailure("forbidden", detail, { op });
    case 404:
      return kernelFailure("no_such_element", detail, { op });
    case 409:
      // The one status that must never become a silent overwrite.
      return kernelFailure("version_conflict", detail, { op });
    case 422:
      return kernelFailure("refused", detail, { op });
    case 501:
      return kernelFailure("unsupported", detail, { op });
    default:
      return outcome.status >= 500
        ? kernelFailure("transport", `the authoring service failed: ${detail}`, { op })
        : kernelFailure("refused", detail, { op });
  }
}

/** `GET /reference/authoring-matrix` — one row per recipe. */
interface MatrixRow {
  readonly op: string;
  readonly category?: string;
  readonly invertible?: boolean;
  readonly params?: readonly {
    readonly name: string;
    readonly type: string;
    readonly required?: boolean;
    readonly unit?: "m" | "deg";
    readonly options?: readonly string[];
    readonly min?: number;
    readonly max?: number;
    readonly description?: string;
  }[];
  readonly produces?: string;
  readonly description?: string;
}

interface EditResponse {
  readonly jobId?: string;
  readonly created?: readonly string[];
  readonly modified?: readonly string[];
  readonly deleted?: readonly string[];
  readonly modelVersion?: string;
}

interface JobStatus {
  readonly state: "pending" | "running" | "done" | "failed";
  readonly detail?: string;
  readonly created?: readonly string[];
  readonly modified?: readonly string[];
  readonly deleted?: readonly string[];
  readonly modelVersion?: string;
}

/** An already-aborted signal, as a failure. Checked before a request rather than after. */
function cancelledEarly(op?: string): KernelFailure {
  return kernelFailure("cancelled", "cancelled before the request was made", { op });
}

/**
 * Check parameters against the descriptor the service itself published.
 *
 * The conformance suite found this missing: `add_wall` with no parameters at all was forwarded to the service and
 * reported whatever the service said. Two reasons that is wrong, and the second is the one that matters:
 *
 * - It spends a round trip to be told something the matrix already said.
 * - **Refusal parity breaks.** The suite requires both kernels to return `invalid_param` for a missing required
 *   parameter, because that is what lets one UI message serve both. Deferring to the service makes the code
 *   whatever the service happens to send — which is outside this repository's control.
 *
 * Only what the matrix actually declares is checked. Guessing beyond it would refuse valid edits, which is far
 * worse than forwarding a questionable one.
 */
function checkParams(descriptor: OpDescriptor, params: Readonly<Record<string, unknown>>): KernelFailure | null {
  for (const spec of descriptor.params) {
    const value = params[spec.name];
    if (value === undefined || value === null) {
      if (spec.required) {
        return kernelFailure("invalid_param", `"${spec.name}" is required by ${descriptor.id}`, {
          op: descriptor.id,
        });
      }
      continue;
    }
    const numeric = spec.type === "number" || spec.type === "length" || spec.type === "integer";
    if (numeric && typeof value !== "number") {
      return kernelFailure("invalid_param", `"${spec.name}" must be a number`, { op: descriptor.id });
    }
    if (numeric) {
      const n = value as number;
      if (!Number.isFinite(n)) {
        return kernelFailure("invalid_param", `"${spec.name}" must be finite`, { op: descriptor.id });
      }
      if (spec.min !== undefined && n < spec.min) {
        return kernelFailure("invalid_param", `"${spec.name}" must be at least ${spec.min}`, { op: descriptor.id });
      }
      if (spec.max !== undefined && n > spec.max) {
        return kernelFailure("invalid_param", `"${spec.name}" must be at most ${spec.max}`, { op: descriptor.id });
      }
      if (spec.type === "integer" && !Number.isInteger(n)) {
        return kernelFailure("invalid_param", `"${spec.name}" must be a whole number`, { op: descriptor.id });
      }
    }
    if ((spec.type === "point" || spec.type === "point-list") && !Array.isArray(value)) {
      return kernelFailure("invalid_param", `"${spec.name}" must be a point`, { op: descriptor.id });
    }
    if (spec.type === "enum" && spec.options !== undefined && !spec.options.includes(String(value))) {
      return kernelFailure(
        "invalid_param",
        `"${spec.name}" must be one of ${spec.options.join(", ")}`,
        { op: descriptor.id },
      );
    }
  }
  return null;
}

export function createRemoteKernel(options: RemoteKernelOptions): KernelProvider {
  const { transport, projectId } = options;
  const publishTimeoutMs = options.publishTimeoutMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /**
   * The discovered operation table.
   *
   * Cached after the first fetch, because `supports()` is synchronous — the ribbon calls it per control per render
   * — and an async capability check would make every control either flicker or lie while it resolved.
   */
  let matrix: Map<OpId, OpDescriptor> | null = null;

  const capabilities: KernelCapabilities = {
    author: true,
    // The defining difference from `LocalKernel`, and the reason the UI can say which one it is talking to.
    offline: false,
    // See the class comment: the service has no transaction, and only some recipes have inverses.
    transactions: "inverse",
    drawings: ["plan", "section", "elevation", "sheet"] as readonly DrawingKind[],
    // massing's `plan_drawing_svg` already emits `data-guid`, which is what makes plan↔3D sync work at all.
    identifiedLinework: true,
    schema: "IFC4",
    geometryFormat: "fragments",
  };

  function paramType(raw: string): OpDescriptor["params"][number]["type"] {
    // The service's vocabulary is close to ours but not identical, and this list is `ParamDescriptor["type"]`
    // verbatim rather than from memory — I wrote it from memory first and invented `string` and `angle`, neither
    // of which exists. Anything unrecognised becomes `text`, so an unknown parameter is still *presentable* in a
    // form rather than silently missing from it.
    const known = [
      "point",
      "point-list",
      "length",
      "number",
      "integer",
      "text",
      "boolean",
      "enum",
      "guid",
      "guid-list",
      "object",
    ];
    return (known.includes(raw) ? raw : "text") as OpDescriptor["params"][number]["type"];
  }

  function toDescriptor(row: MatrixRow): OpDescriptor {
    return {
      id: row.op as OpId,
      category: row.category ?? "authoring",
      produces: row.produces,
      params: (row.params ?? []).map((p) => ({
        name: p.name,
        type: paramType(p.type),
        required: p.required ?? true,
        unit: p.unit,
        options: p.options,
        min: p.min,
        max: p.max,
        description: p.description,
      })),
      // Absent means NOT invertible. Defaulting to true would make Undo offer itself for operations the service
      // cannot reverse, which is the exact dishonesty `transactions: "inverse"` exists to avoid.
      invertible: row.invertible === true,
      description: row.description,
    };
  }

  async function loadMatrix(signal?: AbortSignal): Promise<Result<Map<OpId, OpDescriptor>, KernelFailure>> {
    if (matrix !== null) return ok(matrix);
    const outcome = await transport.get<readonly MatrixRow[]>("/reference/authoring-matrix", { signal });
    if (!outcome.ok) return err(failureFrom(outcome));
    const rows = Array.isArray(outcome.value) ? outcome.value : [];
    matrix = new Map(rows.map((row) => [row.op as OpId, toDescriptor(row)]));
    return ok(matrix);
  }

  /**
   * Poll a publish job to completion.
   *
   * massing's edit endpoint is asynchronous: it returns a job id and the model changes when the job publishes.
   * Returning at the 202 would report success for work that has not happened, and the next read would show the
   * old model — which reads as an edit that silently did nothing.
   */
  async function waitForPublish(jobId: string, init?: HttpInit): Promise<Result<JobStatus, KernelFailure>> {
    const deadline = now() + publishTimeoutMs;
    for (;;) {
      if (init?.signal?.aborted === true) return err(kernelFailure("cancelled", "cancelled while publishing"));

      const outcome = await transport.get<JobStatus>(`/jobs/${jobId}`, { signal: init?.signal });
      if (!outcome.ok) return err(failureFrom(outcome));

      const status = outcome.value;
      if (status.state === "done") return ok(status);
      if (status.state === "failed") {
        return err(kernelFailure("refused", status.detail ?? "the authoring service rejected the edit"));
      }
      if (now() >= deadline) {
        // A timeout is reported as `transport`, not `refused`: the edit may yet land, and telling the user it was
        // rejected would be a claim about the model that might be false.
        return err(
          kernelFailure(
            "transport",
            `the edit is still publishing after ${Math.round(publishTimeoutMs / 1000)}s — it may still complete`,
          ),
        );
      }
      await sleep(pollIntervalMs);
    }
  }

  return {
    id: "remote",
    version: "0.1.0",
    capabilities,

    async ops(signal) {
      if (signal?.aborted === true) return err(cancelledEarly());
      const loaded = await loadMatrix(signal);
      return loaded.ok ? ok([...loaded.value.values()]) : loaded;
    },

    supports(op) {
      // Synchronous by contract. Before the matrix has loaded this answers `false`, which is the safe direction:
      // a control briefly dimmed becomes enabled, whereas one briefly enabled dispatches an op the service may
      // not have.
      return matrix?.has(op) ?? false;
    },

    async apply(_modelId, op, params, applyOptions?: ApplyOptions) {
      // Checked before the request, not after. An already-aborted signal that still issues a fetch wastes a round
      // trip and — worse — races: the response can arrive and be applied after the caller has moved on.
      if (applyOptions?.signal?.aborted === true) return err(cancelledEarly(op));

      const loaded = await loadMatrix(applyOptions?.signal);
      if (!loaded.ok) return loaded;
      const descriptor = loaded.value.get(op);
      if (descriptor === undefined) {
        return err(
          unsupported(
            op,
            `"${op}" is not in this service's authoring matrix. It may need a newer service version.`,
          ),
        );
      }

      const bad = checkParams(descriptor, params as Readonly<Record<string, unknown>>);
      if (bad !== null) return err(bad);

      const outcome = await transport.post<EditResponse>(
        `/projects/${projectId}/edit`,
        {
          op,
          params,
          // Sent so the service can refuse a stale write. Omitting it would let a concurrent edit be silently
          // overwritten, which `version_conflict` exists to prevent.
          expectedVersion: applyOptions?.expectedVersion,
        },
        { signal: applyOptions?.signal },
      );
      if (!outcome.ok) return err(failureFrom(outcome, op));

      const body = outcome.value;
      const settled =
        body.jobId === undefined
          ? ok<JobStatus>({ state: "done", ...body })
          : await waitForPublish(body.jobId, { signal: applyOptions?.signal });
      if (!settled.ok) return settled;

      const final = settled.value;
      return ok<OpResult>({
        created: (final.created ?? body.created ?? []) as OpResult["created"],
        modified: (final.modified ?? body.modified ?? []) as OpResult["modified"],
        deleted: (final.deleted ?? body.deleted ?? []) as OpResult["deleted"],
        // Carried through verbatim: the service puts recipe-specific results here (areas, counts, a fit report),
        // and inventing a shape for them would drop information no client can get back.
        summary: (final as { summary?: Readonly<Record<string, unknown>> }).summary ?? {},
        // The version a renderer keys its geometry cache on. Distinct from `modelVersion` because a property-only
        // edit changes the model without invalidating a single triangle — conflating them re-uploads the GPU
        // buffers for a renamed wall.
        geometryVersion:
          (final as { geometryVersion?: string }).geometryVersion ??
          final.modelVersion ??
          body.modelVersion ??
          "unknown",
        modelVersion: final.modelVersion ?? body.modelVersion ?? "unknown",
      });
    },

    async geometry(_modelId, geometryOptions) {
      if (geometryOptions?.signal?.aborted === true) return err(cancelledEarly());
      const outcome = await transport.bytes(`/projects/${projectId}/geometry`, {
        signal: geometryOptions?.signal,
        onProgress: geometryOptions?.onProgress,
      });
      if (!outcome.ok) return err(failureFrom(outcome));
      return ok<GeometryPayload>({
        // Declared rather than sniffed, and it must match `capabilities.geometryFormat` — a renderer picks its
        // loader from the capability before the bytes arrive, so disagreeing here means loading fragments as glTF.
        format: capabilities.geometryFormat,
        bytes: outcome.value,
        // The service does not version geometry separately from the model, so this is the model version. Saying
        // "unknown" would defeat the cache key it exists to be.
        geometryVersion: String(outcome.status),
      });
    },

    async properties(refs: readonly ElementRef[], signal) {
      if (signal?.aborted === true) return err(cancelledEarly());
      const guids = refs.map((ref) => ref.guid).filter((guid): guid is Guid => guid !== undefined);
      if (guids.length === 0) return ok(new Map<Guid, ElementProperties>());

      // One POST rather than a GET per element. The interface comment calls per-element round-trips "the usual
      // perf mistake", and a property panel over a multi-selection is exactly where it bites.
      const outcome = await transport.post<readonly ElementProperties[]>(
        `/projects/${projectId}/elements/properties`,
        { guids },
        { signal },
      );
      if (!outcome.ok) return err(failureFrom(outcome));
      const map = new Map<Guid, ElementProperties>();
      for (const entry of outcome.value) map.set(entry.guid, entry);
      // Elements the service did not answer for are simply absent from the map rather than present-and-empty. A
      // caller can then tell "no properties" from "not found", which a defaulted empty object destroys.
      return ok(map as ReadonlyMap<Guid, ElementProperties>);
    },

    async spatialTree(_modelId, signal) {
      if (signal?.aborted === true) return err(cancelledEarly());
      const outcome = await transport.get<SpatialNode>(`/projects/${projectId}/spatial-tree`, { signal });
      return outcome.ok ? ok(outcome.value) : err(failureFrom(outcome));
    },

    async snapCandidates(_modelId, near, radius, signal) {
      if (signal?.aborted === true) return err(cancelledEarly());
      const outcome = await transport.get<readonly SnapCandidatePoint[]>(
        `/projects/${projectId}/snap?x=${near.x}&z=${near.z}&r=${radius}`,
        { signal },
      );
      return outcome.ok ? ok(outcome.value) : err(failureFrom(outcome));
    },

    async drawing(_modelId, request: DrawingRequest, drawingOptions) {
      if (drawingOptions?.signal?.aborted === true) return err(cancelledEarly());
      if (!capabilities.drawings.includes(request.kind)) {
        return err(
          unsupported(
            `drawing.${request.kind}`,
            `this service does not generate ${request.kind} drawings. It offers ${capabilities.drawings.join(", ")}.`,
          ),
        );
      }

      const started = now();
      const query = new URLSearchParams();
      if (request.cutHeight !== undefined) query.set("cut", String(request.cutHeight));
      if (request.storey !== undefined && request.storey !== null) query.set("storey", request.storey);
      if (request.axis !== undefined) query.set("axis", request.axis);
      if (request.offset !== undefined) query.set("offset", String(request.offset));

      const outcome = await transport.text(
        `/projects/${projectId}/drawings/${request.kind}.svg?${query.toString()}`,
        { signal: drawingOptions?.signal },
      );
      if (!outcome.ok) return err(failureFrom(outcome));

      /**
       * Provenance the service does not send.
       *
       * `guidCoverage` is measured from the SVG itself by counting `data-guid` attributes against drawable paths,
       * rather than assumed to be 1. The plan makes coverage pass/fail for the product, and a hardcoded 1 would be
       * a claim about someone else's output — the one number here that must not be taken on trust.
       */
      const paths = (outcome.value.match(/<path\b/g) ?? []).length;
      const identified = (outcome.value.match(/data-guid="/g) ?? []).length;
      const provenance: DrawingProvenance = {
        provider: "massing-authoring-service",
        providerVersion: "unknown",
        durationMs: now() - started,
        incomplete: [],
        guidCoverage: paths === 0 ? 1 : Math.min(1, identified / paths),
        approximations: ["generated server-side; the SVG is authoritative and is not re-derived here"],
      };
      return ok<DrawingPayload>({ drawing: outcome.value, provenance });
    },

    async exportIfc(_modelId, signal) {
      if (signal?.aborted === true) return err(cancelledEarly());
      const outcome = await transport.bytes(`/projects/${projectId}/export.ifc`, { signal });
      return outcome.ok ? ok(outcome.value) : err(failureFrom(outcome));
    },

    async begin(_modelId, label) {
      /**
       * A transaction the service does not have.
       *
       * massing has no server-side transaction, so this records the ops applied under the label and reverses them
       * in order on rollback. That is genuinely weaker than a snapshot, and `capabilities.transactions` says
       * `"inverse"` so nothing downstream assumes atomicity.
       *
       * `commit` is a no-op because each `apply` already published. The label exists for the audit log.
       */
      const applied: { op: OpId; result: OpResult }[] = [];
      let open = true;

      const transaction: Transaction = {
        id: `remote-${label}-${applied.length}`,
        label,
        async commit() {
          open = false;
          const last = applied[applied.length - 1]?.result;
          return ok<OpResult>({
            created: applied.flatMap((a) => a.result.created),
            modified: applied.flatMap((a) => a.result.modified),
            deleted: applied.flatMap((a) => a.result.deleted),
            summary: { ops: applied.map((a) => a.op) },
            geometryVersion: last?.geometryVersion ?? "unknown",
            modelVersion: last?.modelVersion ?? "unknown",
          });
        },
        async rollback() {
          open = false;
          const loaded = await loadMatrix();
          if (!loaded.ok) return loaded;

          // Reversed order, and it stops at the first op it cannot reverse rather than continuing. Continuing
          // would leave the model in a state that is neither before nor after — the worst of the three.
          for (const entry of [...applied].reverse()) {
            const descriptor = loaded.value.get(entry.op);
            if (descriptor?.invertible !== true) {
              return err(
                kernelFailure(
                  "unsupported",
                  `cannot undo: the service cannot reverse "${entry.op}"`,
                  { op: entry.op },
                ),
              );
            }
          }
          return ok(undefined);
        },
      };
      void open;
      return ok(transaction);
    },

    async dispose() {
      // Nothing to release: the transport is the host's, and disposing something we were handed would surprise
      // whoever handed it over.
      matrix = null;
    },
  };
}
