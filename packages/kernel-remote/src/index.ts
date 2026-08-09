// @massing/kernel-remote — the same KernelProvider, over massing's authoring service.
//
// The plan put this BEFORE LocalKernel and called the ordering load-bearing: a thin adapter over endpoints that
// already work turns the conformance suite green fast, which converts the suite from aspirational documentation
// into an executable spec. It was built last, and the prediction held — until now the suite had only ever run
// against kernels written alongside it.
//
// Two things make it honest rather than merely present:
//
//   - Operations are DISCOVERED from `GET /reference/authoring-matrix`, so a recipe registered on the server
//     appears in the ribbon with no client change. A hardcoded list of 96 is wrong the moment there are 97.
//   - `transactions: "inverse"`, not `"snapshot"`. The service has no transaction and only some recipes have
//     inverses, so rollback can genuinely fail partway — and Undo dims itself with the reason.
//
// The HTTP seam is four injected functions, never massing's `ApiClient`. That is what lets the conformance suite
// run against recorded cassettes on every PR, and what lets the architecture gate assert that nothing outside
// this package imports anything HTTP-shaped.

export { createRemoteKernel } from "./kernel.js";
export type { RemoteKernelOptions } from "./kernel.js";

export { cassetteTransport, fetchTransport } from "./transport.js";
export type { Cassette, HttpInit, HttpOutcome, HttpTransport } from "./transport.js";
