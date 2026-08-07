import type { Guid, ModelId, Result } from "@massingviewer/core";
import type { KernelFailure, OpParams } from "@massingviewer/kernel-api";

/**
 * The Worker protocol.
 *
 * Every message is `structuredClone`-able, and that is a hard constraint rather than a style note: a `Result`
 * carrying an `Error`, a function, or a class instance throws `DataCloneError` at `postMessage` — at runtime, in
 * the Worker, where it surfaces as the request simply never resolving. `KernelFailure` is a plain object for
 * exactly this reason, and `ops()` strips its `run` functions before returning.
 *
 * Requests are correlated by `id` rather than by order, because responses can legitimately arrive out of order:
 * a long `apply` and a fast `versions` issued back to back finish in the other sequence.
 */

export type KernelRequest =
  | { readonly id: number; readonly kind: "open"; readonly modelId: ModelId; readonly ifc?: string }
  | { readonly id: number; readonly kind: "close"; readonly modelId: ModelId }
  | { readonly id: number; readonly kind: "ops" }
  | {
      readonly id: number;
      readonly kind: "apply";
      readonly modelId: ModelId;
      readonly op: string;
      readonly params: OpParams;
      readonly expectedVersion?: string;
      readonly transactionId?: string;
    }
  | { readonly id: number; readonly kind: "exportIfc"; readonly modelId: ModelId }
  | { readonly id: number; readonly kind: "properties"; readonly modelId: ModelId; readonly guids: readonly Guid[] }
  | { readonly id: number; readonly kind: "spatialTree"; readonly modelId: ModelId }
  | {
      readonly id: number;
      readonly kind: "snap";
      readonly modelId: ModelId;
      readonly near: { readonly x: number; readonly z: number };
      readonly radius: number;
    }
  | { readonly id: number; readonly kind: "undo"; readonly modelId: ModelId }
  | { readonly id: number; readonly kind: "versions"; readonly modelId: ModelId }
  | { readonly id: number; readonly kind: "begin"; readonly modelId: ModelId; readonly label: string }
  | { readonly id: number; readonly kind: "commit"; readonly modelId: ModelId; readonly txId: string }
  | { readonly id: number; readonly kind: "rollback"; readonly modelId: ModelId; readonly txId: string };

/**
 * A request with its correlation id not yet assigned.
 *
 * `Omit<KernelRequest, "id">` does **not** work here: `Omit` on a union collapses to the keys every member
 * shares, which for this union is only `kind` — so every other field became a type error. The conditional makes
 * it distribute over the members instead.
 */
export type KernelRequestBody<T = KernelRequest> = T extends { id: number } ? Omit<T, "id"> : never;

export interface KernelResponse {
  readonly id: number;
  readonly result: Result<unknown, KernelFailure>;
}

/**
 * A duplex message channel to something hosting a {@link LocalKernelCore}.
 *
 * Abstracted over the transport because a browser `Worker` and a `node:worker_threads` Worker have different
 * APIs for the same idea, and the conformance suite needs to drive a **real** worker from Node. Abstracting it
 * is what makes "worker-only, no in-process mode" testable rather than merely asserted — see
 * `docs/adr/0008-local-kernel-geometry-stack.md`.
 */
export interface KernelTransport {
  post(message: KernelRequest): void;
  /** Called once. The handler receives every message the host sends. */
  listen(handler: (message: KernelResponse) => void): void;
  /** Shut the worker down. Must be safe to call twice — a React unmount fires it twice in strict mode. */
  terminate(): Promise<void>;
}
