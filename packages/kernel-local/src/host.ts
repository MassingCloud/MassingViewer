import { err, ok } from "@massingviewer/core";
import { kernelFailure } from "@massingviewer/kernel-api";
import { LocalKernelCore } from "./core.js";
import type { GuidMinter } from "./guid.js";
import type { KernelRequest, KernelResponse } from "./protocol.js";

/**
 * Serve a {@link LocalKernelCore} over a message channel.
 *
 * The whole worker side, in one function, deliberately transport-agnostic: it is handed a `post` and given back
 * a `handle`. The browser Worker entry (`worker.ts`) and the `MessageChannel` transport the conformance suite
 * uses differ only in how they wire those two, which is what stops the two paths drifting — a bug fixed in one
 * and not the other is a bug that appears only in production, or only in tests.
 */
export function hostLocalKernel(
  post: (response: KernelResponse) => void,
  mint?: GuidMinter,
): (request: KernelRequest) => void {
  const core = new LocalKernelCore(mint);

  return (request: KernelRequest): void => {
    let result;
    try {
      result = dispatch(core, request);
    } catch (cause) {
      // A throw here would otherwise reject nothing and the caller's promise would hang forever, which reads as
      // the app freezing. Every path returns a Result, including the unexpected ones.
      result = err(
        kernelFailure("internal", `${request.kind} threw: ${(cause as Error).message}`, { kind: request.kind }),
      );
    }
    post({ id: request.id, result });
  };
}

function dispatch(core: LocalKernelCore, request: KernelRequest) {
  switch (request.kind) {
    case "open":
      return core.open(request.modelId, request.ifc);
    case "close":
      core.close(request.modelId);
      return ok(undefined);
    case "ops":
      return ok(core.ops());
    case "apply":
      return core.apply(request.modelId, request.op, request.params, {
        ...(request.expectedVersion === undefined ? {} : { expectedVersion: request.expectedVersion }),
        ...(request.transactionId === undefined ? {} : { transactionId: request.transactionId }),
      });
    case "exportIfc":
      return core.exportIfc(request.modelId);
    case "properties": {
      const r = core.properties(request.modelId, request.guids);
      // A Map survives structuredClone, but building it here rather than in the client keeps the client from
      // needing to know the shape twice.
      return r.ok ? ok([...r.value.entries()]) : r;
    }
    case "spatialTree":
      return core.spatialTree(request.modelId);
    case "snap":
      return core.snapCandidates(request.modelId, request.near, request.radius);
    case "undo":
      return core.undo(request.modelId);
    case "versions":
      return core.versions(request.modelId);
    case "begin":
      return core.begin(request.modelId, request.label);
    case "commit":
      return core.commit(request.modelId, request.txId);
    case "rollback":
      return core.rollback(request.modelId, request.txId);
  }
}
