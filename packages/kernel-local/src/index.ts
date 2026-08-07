// @massingviewer/kernel-local — authoring IFC with no server, no account and no upload.
//
// The claim this package exists to make good on: the model never leaves the browser. See
// docs/adr/0001-two-kernels.md for why there are two kernels, and
// docs/adr/0008-local-kernel-geometry-stack.md for why this one owns the file's entity table rather than a
// reduced model of it.

export { createLocalKernel } from "./provider";
export type { LocalKernelOptions } from "./provider";
export { browserWorkerTransport, messageChannelTransport } from "./transport";
export { hostLocalKernel } from "./host";
export type { KernelRequest, KernelResponse, KernelTransport } from "./protocol";
export { LocalKernelCore } from "./core";
export { LocalModel } from "./model";
export { LOCAL_OPS, UNSUPPORTED_HINT } from "./ops";
export type { OpEffect } from "./ops";
export { BLANK_IFC4 } from "./blank";
export { compressUuid, countingGuidMinter, decompressUuid, randomGuidMinter } from "./guid";
export type { GuidMinter } from "./guid";
