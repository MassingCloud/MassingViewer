import { type ElementRef, type Guid, type ModelId, type Result, err, ok } from "@massingviewer/core";
import type {
  ApplyOptions,
  DrawingPayload,
  DrawingRequest,
  ElementProperties,
  GeometryPayload,
  KernelCapabilities,
  KernelFailure,
  KernelProvider,
  OpDescriptor,
  OpId,
  OpParams,
  OpResult,
  SnapCandidatePoint,
  SpatialNode,
  Transaction,
} from "@massingviewer/kernel-api";
import { kernelFailure, unsupported } from "@massingviewer/kernel-api";
import type { KernelRequest, KernelRequestBody, KernelResponse, KernelTransport } from "./protocol.js";
import { UNSUPPORTED_HINT } from "./ops.js";

/**
 * `LocalKernel` — the `KernelProvider` callers see.
 *
 * A thin client over a message port. It holds no model state at all: the truth lives in the Worker, and this
 * class only correlates requests with responses and caches the op list so {@link supports} can be synchronous.
 *
 * ## Why there is no in-process constructor
 *
 * `createLocalKernel` takes a transport and cannot be built without one. That makes "Worker-only" a property of
 * the type rather than a convention someone has to remember — see
 * `docs/adr/0008-local-kernel-geometry-stack.md`. A convenience overload that ran the core inline "for tests"
 * would be the first step to a synchronous path, and the reason the contract is async on every method is that
 * geometry work will halt the event loop the moment it is allowed to.
 */
export function createLocalKernel(transport: KernelTransport, options: LocalKernelOptions = {}): KernelProvider {
  return new LocalKernel(transport, options);
}

export interface LocalKernelOptions {
  /**
   * Soft ceiling reported in {@link KernelCapabilities.maxModelBytes}.
   *
   * Declared so the UI can warn *before* a load rather than crash during one. The default is deliberately
   * conservative: this kernel re-emits the whole file on export and snapshots it per operation, which is fine
   * for the models it is meant for and would not be for a 200 MB federated model. Saying so is the honest
   * alternative to discovering it on an iPad.
   */
  readonly maxModelBytes?: number;
}

const CAPABILITIES: KernelCapabilities = {
  author: true,
  offline: true,
  // Snapshot, not inverse. Cheap here because a snapshot is the emitted text, which is why `delete_element` is
  // undoable despite declaring `invertible: false`. RemoteKernel cannot say this, and the contract lets each
  // kernel state which it is rather than having callers assume.
  transactions: "snapshot",
  // Empty, and that is the truth today: 2D generation lives in `@massingviewer/drawings2d`, which does not
  // exist yet. Declaring "plan" here and failing at call time is how a kernel lies about its capabilities, and
  // the conformance suite fails a kernel that does it.
  drawings: [],
  identifiedLinework: false,
  schema: "IFC4",
  // The kernel emits IFC and the viewport tessellates it. See the note on `exportIfc` in core.ts.
  geometryFormat: "ifc",
};

class LocalKernel implements KernelProvider {
  readonly id = "local";
  readonly version = "0.0.0";
  readonly capabilities: KernelCapabilities;

  private readonly transport: KernelTransport;
  private readonly pending = new Map<number, (response: KernelResponse) => void>();
  private nextId = 1;
  private cachedOps: readonly OpDescriptor[] | null = null;
  private disposed = false;

  constructor(transport: KernelTransport, options: LocalKernelOptions) {
    this.transport = transport;
    this.capabilities = {
      ...CAPABILITIES,
      maxModelBytes: options.maxModelBytes ?? 64 * 1024 * 1024,
    };
    transport.listen((response) => {
      const resolve = this.pending.get(response.id);
      // A response with no pending entry means a reply arrived after `dispose`, or twice. Dropping it silently
      // is correct; throwing would turn a benign race into an unhandled rejection in the host page.
      if (resolve === undefined) return;
      this.pending.delete(response.id);
      resolve(response);
    });
  }

  private async send<T>(request: KernelRequestBody, signal?: AbortSignal): Promise<Result<T, KernelFailure>> {
    if (this.disposed) {
      return err(kernelFailure("internal", "this kernel has been disposed"));
    }
    if (signal?.aborted === true) {
      return err(kernelFailure("cancelled", "cancelled before it was sent"));
    }
    const id = this.nextId++;
    const message = { ...request, id } as KernelRequest;

    return new Promise<Result<T, KernelFailure>>((resolve) => {
      const settle = (result: Result<T, KernelFailure>): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      // Abort resolves the caller's promise but leaves the worker to finish. Interrupting mid-operation would
      // need the core to be re-entrant, and a half-applied model is worse than a wasted computation — the
      // caller has already stopped caring about the answer either way.
      const onAbort = (): void => {
        this.pending.delete(id);
        settle(err(kernelFailure("cancelled", "cancelled while in flight")));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      this.pending.set(id, (response) => settle(response.result as Result<T, KernelFailure>));
      try {
        this.transport.post(message);
      } catch (cause) {
        this.pending.delete(id);
        // A `DataCloneError` lands here: something unserialisable was put in the params. Reporting it as
        // `transport` rather than `internal` says where to look.
        settle(err(kernelFailure("transport", `could not send ${request.kind}: ${(cause as Error).message}`)));
      }
    });
  }

  /** Open a file, or start an empty model. Not part of `KernelProvider` — it is how a model gets in here. */
  async open(modelId: ModelId, ifc?: string): Promise<Result<{ elements: number; created: readonly string[] }, KernelFailure>> {
    return this.send({ kind: "open", modelId, ...(ifc === undefined ? {} : { ifc }) });
  }

  async ops(signal?: AbortSignal): Promise<Result<readonly OpDescriptor[], KernelFailure>> {
    const result = await this.send<readonly OpDescriptor[]>({ kind: "ops" }, signal);
    if (result.ok) this.cachedOps = result.value;
    return result;
  }

  supports(op: OpId): boolean {
    // False before `ops()` has resolved, rather than a guess. The contract says so explicitly: a ribbon that
    // guesses shows controls that then fail, which is worse than one control appearing a frame late.
    return this.cachedOps?.some((d) => d.id === op) ?? false;
  }

  async apply(
    modelId: ModelId,
    op: OpId,
    params: OpParams,
    options?: ApplyOptions,
  ): Promise<Result<OpResult, KernelFailure>> {
    return this.send<OpResult>(
      {
        kind: "apply",
        modelId,
        op,
        params,
        ...(options?.expectedVersion === undefined ? {} : { expectedVersion: options.expectedVersion }),
        ...(options?.transactionId === undefined ? {} : { transactionId: options.transactionId }),
      },
      options?.signal,
    );
  }

  async geometry(
    modelId: ModelId,
    options?: { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void },
  ): Promise<Result<GeometryPayload, KernelFailure>> {
    const ifc = await this.send<string>({ kind: "exportIfc", modelId }, options?.signal);
    if (!ifc.ok) return ifc;
    const versions = await this.send<{ geometryVersion: string }>({ kind: "versions", modelId }, options?.signal);
    if (!versions.ok) return versions;
    const bytes = new TextEncoder().encode(ifc.value);
    options?.onProgress?.(bytes.byteLength, bytes.byteLength);
    return ok({ format: "ifc", bytes, geometryVersion: versions.value.geometryVersion });
  }

  async properties(
    refs: readonly ElementRef[],
    signal?: AbortSignal,
  ): Promise<Result<ReadonlyMap<Guid, ElementProperties>, KernelFailure>> {
    if (refs.length === 0) return ok(new Map());
    // Grouped by model, because `ElementRef` carries its own modelId and a caller can legitimately mix two
    // federated models in one selection. Assuming they all share the first ref's model would silently return
    // properties for the wrong elements.
    const byModel = new Map<ModelId, Guid[]>();
    for (const ref of refs) {
      const bucket = byModel.get(ref.modelId);
      if (bucket) bucket.push(ref.guid);
      else byModel.set(ref.modelId, [ref.guid]);
    }
    const out = new Map<Guid, ElementProperties>();
    for (const [modelId, guids] of byModel) {
      const result = await this.send<[Guid, ElementProperties][]>({ kind: "properties", modelId, guids }, signal);
      if (!result.ok) return result;
      for (const [guid, properties] of result.value) out.set(guid, properties);
    }
    return ok(out);
  }

  async spatialTree(modelId: ModelId, signal?: AbortSignal): Promise<Result<SpatialNode, KernelFailure>> {
    return this.send<SpatialNode>({ kind: "spatialTree", modelId }, signal);
  }

  async snapCandidates(
    modelId: ModelId,
    near: { x: number; z: number },
    radius: number,
    signal?: AbortSignal,
  ): Promise<Result<readonly SnapCandidatePoint[], KernelFailure>> {
    return this.send<readonly SnapCandidatePoint[]>({ kind: "snap", modelId, near, radius }, signal);
  }

  async drawing(
    _modelId: ModelId,
    request: DrawingRequest,
  ): Promise<Result<DrawingPayload, KernelFailure>> {
    // `capabilities.drawings` is empty, and this agrees with it. A kernel whose capability list and behaviour
    // disagree fails the conformance suite, which is the point of testing capability honesty rather than
    // trusting a declaration.
    return err(
      unsupported(
        `drawing:${request.kind}`,
        `2D ${request.kind} generation is not in this build yet. It ${UNSUPPORTED_HINT}`,
      ),
    );
  }

  async exportIfc(modelId: ModelId, signal?: AbortSignal): Promise<Result<Uint8Array, KernelFailure>> {
    const ifc = await this.send<string>({ kind: "exportIfc", modelId }, signal);
    return ifc.ok ? ok(new TextEncoder().encode(ifc.value)) : ifc;
  }

  async begin(modelId: ModelId, label: string): Promise<Result<Transaction, KernelFailure>> {
    const begun = await this.send<{ id: string; label: string }>({ kind: "begin", modelId, label });
    if (!begun.ok) return begun;
    const txId = begun.value.id;
    return ok({
      id: txId,
      label,
      commit: async () => this.send<OpResult>({ kind: "commit", modelId, txId }),
      rollback: async () => this.send<void>({ kind: "rollback", modelId, txId }),
    });
  }

  async dispose(): Promise<void> {
    // Idempotent: a React unmount fires this twice in strict mode, and throwing the second time turns a benign
    // double-unmount into a crash.
    if (this.disposed) return;
    this.disposed = true;
    // Anything still in flight is answered rather than left hanging, because a caller awaiting a promise that
    // never settles is indistinguishable from the app freezing.
    for (const [id, resolve] of this.pending) {
      resolve({ id, result: err(kernelFailure("cancelled", "the kernel was disposed while this was in flight")) });
    }
    this.pending.clear();
    await this.transport.terminate();
  }
}
