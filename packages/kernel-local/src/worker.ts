/**
 * Browser Worker entry point.
 *
 * Loaded as `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })` — see
 * `browserWorkerTransport`. Nothing but wiring: the logic is in `hostLocalKernel`, shared with the Node worker
 * the conformance suite drives, so a fix cannot land in one and miss the other.
 */

import { hostLocalKernel } from "./host";
import type { KernelRequest } from "./protocol";

const handle = hostLocalKernel((response) => {
  (self as unknown as { postMessage(m: unknown): void }).postMessage(response);
});

self.addEventListener("message", (event) => {
  handle((event as MessageEvent<KernelRequest>).data);
});
