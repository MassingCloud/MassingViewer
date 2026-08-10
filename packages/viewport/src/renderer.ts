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

/** The default probe: `navigator.gpu`, then three's own WebGPU renderer. */
export function browserWebGpuProbe(): WebGpuProbe {
  return {
    available: () =>
      typeof navigator !== "undefined" && (navigator as { gpu?: unknown }).gpu !== undefined,
    create: async () => {
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
