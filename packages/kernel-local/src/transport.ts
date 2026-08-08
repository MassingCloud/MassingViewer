import { hostLocalKernel } from "./host.js";
import type { KernelRequest, KernelResponse, KernelTransport } from "./protocol.js";

/**
 * Transports for {@link createLocalKernel}.
 *
 * Two, and the difference between them matters enough to state at both call sites rather than leave to be
 * inferred: {@link browserWorkerTransport} gives real thread isolation, {@link messageChannelTransport} does not.
 */

/**
 * Wrap a `Worker` the **caller** constructed.
 *
 * ## Why this does not create the Worker itself
 *
 * The tempting signature is `browserWorkerTransport()`, doing `new Worker(new URL("./worker.js",
 * import.meta.url))` internally. It does not work, and the way it fails is instructive: the demo built and
 * emitted no worker chunk at all, so the app would have shipped and then failed at runtime on the one code path
 * that matters.
 *
 * Two reasons it cannot work. From source the entry is `worker.ts`, not `.js`. And from a *published* package
 * the URL is relative to a module inside `node_modules` that a bundler has already inlined — there is nothing
 * left for `new URL` to resolve against. Worker construction needs bundler-specific knowledge
 * (`new URL(..., import.meta.url)` for Vite and Rollup, `?worker` suffixes, `worker-loader` for older webpack),
 * and that knowledge belongs in the application, which is the only place that knows which bundler it has.
 *
 * So the app writes four lines, and they are the same four lines in every bundler:
 *
 * ```ts
 * // app/src/kernel.worker.ts
 * import { hostLocalKernel } from "@massing/kernel-local";
 * const handle = hostLocalKernel((response) => self.postMessage(response));
 * self.addEventListener("message", (event) => handle(event.data));
 * ```
 *
 * ```ts
 * // app/src/main.ts
 * const worker = new Worker(new URL("./kernel.worker.ts", import.meta.url), { type: "module" });
 * const kernel = createLocalKernel(browserWorkerTransport(worker));
 * ```
 *
 * `hostLocalKernel` is exported for exactly this. See `apps/demo/src/kernel.worker.ts` for the real one.
 */
export function browserWorkerTransport(worker: Worker): KernelTransport {
  let terminated = false;
  return {
    post(message) {
      worker.postMessage(message);
    },
    listen(handler) {
      worker.addEventListener("message", (event: MessageEvent<KernelResponse>) => handler(event.data));
    },
    async terminate() {
      if (terminated) return;
      terminated = true;
      worker.terminate();
    },
  };
}

/**
 * A `MessageChannel` — same thread, real serialisation.
 *
 * ## What this is, and what it is not
 *
 * It **is** a genuine message boundary. `postMessage` structured-clones the payload, so anything unserialisable
 * in a request fails here exactly as it would in a Worker; replies are asynchronous; and the client's
 * request/response correlation is exercised for real.
 *
 * It is **not** off-main-thread execution. The kernel runs on the caller's thread, so a long operation blocks the
 * event loop. Do not ship this to a browser expecting the responsiveness a Worker gives.
 *
 * ## Why it exists, given ADR-0008 says worker-only
 *
 * That ADR's rule is that there is no *synchronous* escape hatch, and this is not one: it cannot make a call
 * synchronous and it cannot let a caller reach the core directly. What it does is let the conformance suite run
 * from Node against the real `KernelProvider`, the real host dispatch, and real serialisation.
 *
 * A `node:worker_threads` variant was written first and then deleted. It could not load its own module graph: the
 * worker entry is TypeScript, and Node's type stripping does not resolve extensionless imports, while the emitted
 * `dist` is bundler-targeted ESM that Node's loader also rejects. Bundling a worker purely to run tests would put
 * a build step in the middle of the test loop. Shipping it untested — so that it looked supported and worked
 * nowhere — was the one option not worth taking.
 *
 * The consequence, stated plainly: **thread isolation is verified by the browser E2E suite, not by the unit
 * suite.** Every other property of the boundary is covered here.
 */
export function messageChannelTransport(mint?: Parameters<typeof hostLocalKernel>[1]): KernelTransport {
  const channel = new MessageChannel();
  const client = channel.port1;
  const host = channel.port2;

  const handle = hostLocalKernel((response) => host.postMessage(response), mint);
  host.onmessage = (event: MessageEvent<KernelRequest>) => handle(event.data);

  let terminated = false;
  return {
    post(message) {
      client.postMessage(message);
    },
    listen(handler) {
      client.onmessage = (event: MessageEvent<KernelResponse>) => handler(event.data);
    },
    async terminate() {
      if (terminated) return;
      terminated = true;
      // Both ends. An open port keeps Node's event loop alive, and a finished test run that never exits is the
      // same class of hang that once made the E2E suite sit for 27 minutes after passing.
      client.close();
      host.close();
    },
  };
}
