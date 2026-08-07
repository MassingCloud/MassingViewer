// @massingviewer/embed — the one function massing imports, and the ledger that says when it can.
//
// M9 is the plan's number-one risk: "Divergence from massing — the only risk that can end the project." Two live
// copies of an 11,570-line engine is a fork, not a plan. So this facade is deliberately small enough to adopt in
// one PR and complete enough that `apps/web/src/viewer/` can be *deleted* rather than kept just in case.
//
// The extraction is one field, and the plan says so: `ViewerCtx.api: ApiClient` becomes
// `ViewerCtx.kernel: KernelProvider`. Which is why `kernel` is a required option here rather than a defaulted
// one — a facade that quietly built a LocalKernel would let massing adopt this while still holding an ApiClient,
// and the coupling being broken would survive the migration invisibly.
//
// `seam.ts` is the other half of M9 and the more useful one day to day: "can massing delete its viewer yet" is
// otherwise an opinion, and an optimistic one, because whoever asks wants the answer to be yes.

export { createMassingViewer } from "./embed.js";
export type {
  ExportFormat,
  MassingViewer,
  MassingViewerOptions,
  MassingViewerOptionsWithTessellator,
  Tessellator,
} from "./embed.js";

export { SEAM, seamCoverage, seamSummary } from "./seam.js";
export type { SeamCapability, SeamCoverage, SeamState } from "./seam.js";
