import * as THREE from "three";

/**
 * The renderer seam — WebGPU first, WebGL2 fallback, and the choice is reported.
 *
 * `docs/adr/0012-webgpu-first-webgl-fallback.md` is the decision. This module is only the *selection*: which
 * backend, why that one, and did the preferred one fail. Constructing the scene, disposing it and rendering
 * frames stay in `viewport.ts`.
 *
 * ## Why selection is its own module with its own tests
 *
 * Because the interesting behaviour is the part that only happens on hardware nobody's CI has. A WebGPU adapter
 * request can fail on a machine that advertises `navigator.gpu` — a blocklisted driver, a headless browser with
 * no adapter, a laptop that lost its GPU to a power event — and the whole value of a fallback is what happens
 * then. Testing that through a real `createViewport` would need four machines. Testing it here needs a fake.
 *
 * So the probe is injectable, the tests drive every branch, and `viewport.ts` gets one function to call.
 *
 * ## The fallback is not silent, and that is a requirement rather than a nicety
 *
 * `docs/deployment.md` already argues this about the single-threaded `SharedArrayBuffer` fallback: *"make the
 * single-threaded fallback visible — a silent fallback is a 5× perf cliff."* Same reasoning, and this is the more
 * likely one to be quietly dropped as polish. A user reporting "it's slow on my iPad" is unanswerable if nothing
 * records whether the fast path ever engaged, so {@link RendererChoice} carries the reason and the caller is
 * expected to surface it.
 */

/** Which backend ended up in use, and why — the payload a host shows and telemetry counts. */
export interface RendererChoice {
  readonly backend: "webgpu" | "webgl2";
  /**
   * Why this backend, in a sentence fit for a status line.
   *
   * A string rather than an enum because the *reason* is the product here: "WebGPU unavailable in this browser"
   * and "WebGPU present but no adapter would initialise" send a user to completely different places, and
   * collapsing them into `fallback: true` throws away the only useful half.
   */
  readonly reason: string;
  /** True when WebGPU was preferred and did not work — the case worth a warning rather than an info line. */
  readonly degraded: boolean;
}

export interface RendererBundle {
  readonly renderer: THREE.WebGLRenderer;
  readonly choice: RendererChoice;
}

/**
 * How the seam asks whether WebGPU is usable, and builds one if so.
 *
 * Injected so the tests can be exhaustive. `available()` is the cheap synchronous check; `create()` is the
 * expensive asynchronous one that can still fail — and keeping them separate is what lets a test cover
 * "advertised but unusable", which is the branch a real fallback exists for and the one a `navigator.gpu`
 * check alone would miss.
 */
export interface WebGpuProbe {
  available(): boolean;
  create(): Promise<THREE.WebGLRenderer>;
}

/**
 * Thrown when `navigator.gpu` exists but hands back no adapter.
 *
 * A distinct type because that is not a failure — it is the browser correctly reporting that this machine has no
 * usable GPU for WebGPU (no Vulkan driver, a blocklisted device, a headless container). Reporting it as a degradation
 * would cry wolf on exactly the hosts where WebGL2 is the right answer.
 */
export class NoWebGpuAdapter extends Error {
  constructor() {
    super("navigator.gpu is present but requestAdapter() returned null");
    this.name = "NoWebGpuAdapter";
  }
}

/** The default probe: `navigator.gpu`, then an adapter, then three's own WebGPU renderer. */
export function browserWebGpuProbe(): WebGpuProbe {
  return {
    available: () =>
      typeof navigator !== "undefined" && (navigator as { gpu?: unknown }).gpu !== undefined,
    create: async () => {
      /**
       * Ask for an adapter **before** importing or constructing anything.
       *
       * Measured, not defensive: a `WebGPURenderer.init()` that fails does *not* leave the page as it found it. On a
       * host advertising `navigator.gpu` with no obtainable adapter, attempting and failing changed what the
       * subsequently-created WebGL2 renderer drew — a deterministic silhouette shift, identical on Windows and on
       * Linux CI, which turned the nightly visual gate red. Bisected to this attempt, then narrowed by elimination:
       * importing `three/webgpu` alone did nothing, constructing the renderer alone did nothing, and `init()` was
       * the step that moved the picture.
       *
       * So the fallback was not transparent, and ADR-0012 requires that it be: choosing WebGL2 must look exactly
       * like never having tried. Checking the adapter first avoids the whole sequence in the common
       * advertised-but-unusable case. It does not *prove* transparency when an adapter exists and `init()` still
       * fails — that path remains reported as `degraded`, and is the one to suspect if this ever recurs.
       */
      const adapter = (await (
        navigator as unknown as { gpu: { requestAdapter(): Promise<{ requestDevice?: () => Promise<unknown> } | null> } }
      ).gpu.requestAdapter()) as { requestDevice?: () => Promise<unknown> } | null;
      if (adapter === null || adapter === undefined) throw new NoWebGpuAdapter();

      /**
       * And a **device**, not merely an adapter.
       *
       * Measured, after the adapter check above turned out to be only half the guard. Forcing the
       * adapter-exists-but-init-fails path — a stubbed `requestAdapter` returning something non-null — reproduced
       * the original silhouette shift exactly: 64 occupancy cells, the same ones. So `WebGPURenderer.init()`
       * mutating shared state is not avoided by having an adapter; it is avoided by never reaching `init()`.
       *
       * `requestDevice()` is what actually fails on a machine that advertises WebGPU it cannot deliver, and it
       * fails *before* three is imported. What remains unguarded is an init that fails despite a working device,
       * which is a narrower window than the one this closes and still carries the same caveat in ADR-0012.
       */
      if (typeof adapter.requestDevice !== "function") throw new NoWebGpuAdapter();
      const device = await adapter.requestDevice();
      if (device === null || device === undefined) throw new NoWebGpuAdapter();

      // Imported lazily, and this is load-bearing rather than tidy: `three/webgpu` is a separate ~1 MB entry
      // point, and a static import would ship it to every WebGL-only visitor — the exact cost the bundle budget
      // exists to catch. A dynamic import keeps it out of the shell chunk.
      const webgpu = (await import("three/webgpu")) as unknown as {
        WebGPURenderer: new (options: { antialias: boolean }) => THREE.WebGLRenderer & {
          init: () => Promise<unknown>;
        };
      };
      const renderer = new webgpu.WebGPURenderer({ antialias: true });
      // `init()` is where an advertised-but-unusable adapter actually rejects. Awaiting it here rather than
      // letting the caller discover it is what makes the fallback below reachable.
      await renderer.init();
      return renderer;
    },
  };
}

/**
 * Pick a renderer.
 *
 * WebGPU when it is available *and* initialises; WebGL2 otherwise. Never throws for a backend reason — a viewer
 * that refuses to start because the fast path is missing is worse than a slow viewer, and on the iPad this
 * product claims, the slow path is the normal path for anyone below iPadOS 26.
 */
export async function createRenderer(
  probe: WebGpuProbe = browserWebGpuProbe(),
  makeWebGl: () => THREE.WebGLRenderer = () => new THREE.WebGLRenderer({ antialias: true, alpha: false }),
): Promise<RendererBundle> {
  if (!probe.available()) {
    return {
      renderer: makeWebGl(),
      choice: {
        backend: "webgl2",
        reason: "WebGPU is not available in this browser; using WebGL2.",
        // Not degraded. On a browser without WebGPU, WebGL2 *is* the correct path, and calling that a degradation
        // would cry wolf on every pre-iPadOS-26 device — which is most of them.
        degraded: false,
      },
    };
  }

  try {
    return {
      renderer: await probe.create(),
      choice: { backend: "webgpu", reason: "WebGPU.", degraded: false },
    };
  } catch (error) {
    if (error instanceof NoWebGpuAdapter) {
      return {
        renderer: makeWebGl(),
        choice: {
          backend: "webgl2",
          reason: "WebGPU is advertised but this device offers no adapter; using WebGL2.",
          // Not degraded, for the same reason absent WebGPU is not: nothing failed. The browser said it could not
          // supply a GPU, and WebGL2 is the correct answer rather than a consolation.
          degraded: false,
        },
      };
    }
    const why = error instanceof Error ? error.message.split(/\r?\n/)[0] : String(error);
    return {
      renderer: makeWebGl(),
      choice: {
        backend: "webgl2",
        // The message is kept, because this is the branch nobody can reproduce on request. "WebGPU failed" is
        // a shrug; naming the adapter error is the difference between a bug report and a support loop.
        reason: `WebGPU is available but would not initialise (${why}); fell back to WebGL2.`,
        degraded: true,
      },
    };
  }
}
