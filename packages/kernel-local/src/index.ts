// @massing/kernel-local — authoring IFC with no server, no account and no upload.
//
// The claim this package exists to make good on: the model never leaves the browser. See
// docs/adr/0001-two-kernels.md for why there are two kernels, and
// docs/adr/0008-local-kernel-geometry-stack.md for why this one owns the file's entity table rather than a
// reduced model of it.

export { createLocalKernel } from "./provider.js";
export type { LocalKernelOptions } from "./provider.js";
export { browserWorkerTransport, messageChannelTransport } from "./transport.js";
export { hostLocalKernel } from "./host.js";
export type { KernelRequest, KernelResponse, KernelTransport } from "./protocol.js";
export { LocalKernelCore } from "./core.js";
export { LocalModel } from "./model.js";
export { LOCAL_OPS, UNSUPPORTED_HINT } from "./ops.js";
export type { OpEffect } from "./ops.js";
export { BLANK_IFC4 } from "./blank.js";
export { compressUuid, countingGuidMinter, decompressUuid, randomGuidMinter } from "./guid.js";
export type { GuidMinter } from "./guid.js";
