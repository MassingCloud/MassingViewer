import { describe, expect, it, vi } from "vitest";
import { createRenderer, NoWebGpuAdapter, type WebGpuProbe } from "./renderer.js";

/**
 * Tests for the renderer seam's *selection*, which is the only part of it that can be tested off hardware.
 *
 * The branch that matters is "WebGPU is advertised and does not work". It cannot be reproduced on demand — it
 * needs a blocklisted driver, a headless browser with no adapter, or a machine that lost its GPU — and it is
 * precisely the branch the fallback exists for. A `navigator.gpu` check alone would never reach it. So the probe
 * is injected and every branch is driven here, rather than hoped for in an E2E run on one machine's GPU.
 */

/** A stand-in renderer. Nothing here renders; selection is what is under test. */
const fakeRenderer = () => ({ dispose: () => {} }) as never;

function probe(over: Partial<WebGpuProbe> = {}): WebGpuProbe {
  return {
    available: () => true,
    create: async () => fakeRenderer(),
    ...over,
  };
}

describe("createRenderer", () => {
  it("uses WebGPU when it is available and initialises", async () => {
    const { choice } = await createRenderer(probe(), fakeRenderer);
    expect(choice.backend).toBe("webgpu");
    expect(choice.degraded).toBe(false);
  });

  it("uses WebGL2 when WebGPU is absent, and does NOT call that degraded", async () => {
    // The judgement worth pinning. On a browser without WebGPU, WebGL2 is the correct path — not a degradation.
    // Flagging it would cry wolf on every device below iPadOS 26, which is most of them, and a warning that fires
    // always is a warning nobody reads.
    const { choice } = await createRenderer(probe({ available: () => false }), fakeRenderer);
    expect(choice.backend).toBe("webgl2");
    expect(choice.degraded).toBe(false);
    expect(choice.reason).toContain("not available");
  });

  it("falls back and reports DEGRADED when WebGPU is advertised but will not initialise", async () => {
    // The whole reason this module exists. `navigator.gpu` present, adapter unusable.
    const { choice } = await createRenderer(
      probe({ create: () => Promise.reject(new Error("No available adapters.")) }),
      fakeRenderer,
    );
    expect(choice.backend).toBe("webgl2");
    expect(choice.degraded).toBe(true);
    // The adapter's own message survives, because this is the branch nobody can reproduce on request and
    // "WebGPU failed" is a shrug.
    expect(choice.reason).toContain("No available adapters.");
  });

  it("never throws for a backend reason", async () => {
    // A viewer that refuses to start because the fast path is missing is worse than a slow viewer.
    const angry = probe({
      create: () => {
        throw new Error("synchronous throw, not a rejection");
      },
    });
    await expect(createRenderer(angry, fakeRenderer)).resolves.toMatchObject({ choice: { backend: "webgl2" } });
  });

  it("only builds a WebGL renderer when it actually needs one", async () => {
    // Constructing a WebGLRenderer allocates a GL context. Building one eagerly and discarding it on the WebGPU
    // path would leak a context per viewport — the class of bug `e2e/memory.spec.ts` exists for.
    const makeWebGl = vi.fn(fakeRenderer);
    await createRenderer(probe(), makeWebGl);
    expect(makeWebGl).not.toHaveBeenCalled();

    await createRenderer(probe({ available: () => false }), makeWebGl);
    expect(makeWebGl).toHaveBeenCalledTimes(1);
  });

  it("keeps only the first line of a multi-line adapter error", async () => {
    // Adapter errors arrive with a stack and a call log. A status line wants the sentence.
    const { choice } = await createRenderer(
      probe({ create: () => Promise.reject(new Error("Adapter lost.\n  at Foo\n  at Bar")) }),
      fakeRenderer,
    );
    expect(choice.reason).toContain("Adapter lost.");
    expect(choice.reason).not.toContain("at Foo");
  });
});

describe("no adapter, which is not the same as a failure", () => {
  /**
   * The distinction this branch exists for, learned the expensive way.
   *
   * `navigator.gpu` being present says the *browser* supports WebGPU, not that the *machine* can provide it. A
   * headless container, a missing Vulkan driver or a blocklisted device all advertise it and then hand back no
   * adapter. Treating that as "WebGPU failed" mislabels the ordinary case as a degradation.
   *
   * It also has to be caught *early*. A `WebGPURenderer.init()` that fails does not leave the page as it found it:
   * on this project it deterministically changed what the WebGL2 renderer drew afterwards, on two operating
   * systems, and turned the nightly visual gate red for four commits. Asking for the adapter first is what keeps
   * the fallback transparent — which is the property ADR-0012 actually promises.
   */
  it("reports WebGL2 without calling it degraded", async () => {
    const { choice } = await createRenderer(
      probe({ create: () => Promise.reject(new NoWebGpuAdapter()) }),
      fakeRenderer,
    );
    expect(choice.backend).toBe("webgl2");
    expect(choice.degraded, "no adapter is not a degradation — nothing failed").toBe(false);
    expect(choice.reason).toContain("no adapter");
  });

  it("still reports degraded for a real initialisation failure, so the two do not collapse into one", async () => {
    // The guard against over-correcting: if every WebGPU disappointment became "no adapter", the degraded signal
    // ADR-0012 requires would never fire again, and the silent-fallback problem would be back with a nicer message.
    const { choice } = await createRenderer(
      probe({ create: () => Promise.reject(new Error("Device lost")) }),
      fakeRenderer,
    );
    expect(choice.degraded).toBe(true);
    expect(choice.reason).toContain("Device lost");
  });
});
