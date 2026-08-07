/**
 * The Worker that hosts `LocalKernel`.
 *
 * Four lines of wiring, and it lives in the app rather than in the package on purpose — see the note on
 * `browserWorkerTransport`. Worker construction needs bundler-specific knowledge, and the app is the only place
 * that knows which bundler it has.
 *
 * Everything this file does is `hostLocalKernel`, which is the same function the conformance suite drives over a
 * `MessageChannel`. One implementation, two transports: a bug fixed in one cannot miss the other.
 */

import { hostLocalKernel } from "@massingviewer/kernel-local";
import type { KernelRequest } from "@massingviewer/kernel-local";

const handle = hostLocalKernel((response) => self.postMessage(response));

self.addEventListener("message", (event: MessageEvent<KernelRequest>) => handle(event.data));
