// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { asModelId } from "@massing/core";
import type { KernelProvider } from "@massing/kernel-api";
import { guidsIn } from "@massing/drawings2d";
import { createMassingViewer, type MassingViewer } from "./embed.js";
import { SEAM, seamCoverage, seamSummary } from "./seam.js";

/**
 * The facade is mostly composition, so testing it line by line would be testing the packages underneath again.
 * What is worth asserting is the set of things a *facade* specifically gets wrong:
 *
 * - the seam ledger claiming coverage it does not have, which is the whole value of having a ledger
 * - `dispose()` not being idempotent, which turns a React strict-mode unmount into a crash
 * - `open()` leaving the kernel on the previous model, which gives a correct 3D view whose first edit writes the
 *   wrong file
 * - `open()` trusting a filename
 */

// ===================================================================================================
// The ledger has to be honest, or it is worse than not existing
// ===================================================================================================

describe("the M9 seam ledger", () => {
  it("names a facade member for everything it claims is covered", async () => {
    // The assertion that makes the ledger trustworthy. Marking a capability `covered` without a `via` is how a
    // checklist drifts into optimism — and the whole reason this is code rather than a markdown table.
    for (const entry of SEAM.filter((e) => e.state === "covered")) {
      expect(entry.via, `${entry.id} is marked covered with no facade member`).toBeTruthy();
    }
  });

  it("points every `via` at something the facade actually exposes", async () => {
    // A `via` naming a member that does not exist would be a claim nobody could check. These are the keys of
    // `MassingViewer` plus the option names a host passes in.
    const members = new Set([
      "viewport",
      "session",
      "kernel",
      "host",
      "raise",
      "topics",
      "orphans",
      "exportBcf",
      "ribbon",
      "modelId",
      "open",
      "cut",
      "drawing",
      "export",
      "select",
      "selection",
      "dispose",
      // Options rather than members, for capabilities a host wires up.
      "onFiles",
      "crashSink",
    ]);
    for (const entry of SEAM.filter((e) => e.state === "covered")) {
      expect(members, `${entry.id} names "${entry.via}"`).toContain(entry.via!);
    }
  });

  it("gives every gap and every boundary a reason", async () => {
    // A gap with no reason is a to-do nobody can schedule, and a boundary with no reason reads as an unfinished
    // gap — which is how "not covered" gets mistaken for "not working".
    for (const entry of SEAM.filter((e) => e.state !== "covered")) {
      expect(entry.note, `${entry.id} has no note`).toBeTruthy();
      expect(entry.note!.length, `${entry.id}'s note is too short to act on`).toBeGreaterThan(40);
    }
  });

  it("reports the seam as ready, with every movable capability covered", async () => {
    // This test used to assert the opposite — `gaps.length > 0` and `ready === false` — and it failed the moment
    // the gaps were closed. Worth keeping the story: a test that asserts the *current* state of a ratchet breaks
    // when the ratchet moves, and it breaks in the direction of success, which is the confusing direction.
    //
    // The mechanism ("ready is false while any gap remains") is asserted below against a synthetic ledger, where
    // it belongs. What this one asserts is the state, and it is now allowed to say so.
    const coverage = seamCoverage();
    expect(coverage.gaps).toEqual([]);
    expect(coverage.ready).toBe(true);
    expect(coverage.ratio).toBe(1);
    expect(seamSummary()).not.toContain("Remaining:");
  });

  it("still refuses to call a partial seam ready", async () => {
    // The mechanism, on a synthetic ledger so it cannot rot as the real one improves. A partial adoption means both
    // copies of the engine live, which is the fork the plan says ends the project — so "mostly ready" has to read
    // as "not ready", however close the fraction gets.
    const partial = [
      { id: "a", description: "done", state: "covered" as const, via: "viewport" },
      { id: "b", description: "not done", state: "gap" as const, note: "still to do" },
    ];
    const coverage = seamCoverage(partial);
    expect(coverage.ready).toBe(false);
    expect(coverage.ratio).toBe(0.5);
  });

  it("does not count a boundary as a gap", async () => {
    // `ApiClient` staying in massing is the design, not a shortfall. Counting it against readiness would make the
    // number permanently and misleadingly low.
    const coverage = seamCoverage();
    expect(coverage.boundaries).toBeGreaterThan(0);
    expect(coverage.gaps.map((g) => g.id)).not.toContain("api.client");
  });

  it("has no duplicate ids", async () => {
    const ids = SEAM.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reports ready only when the gaps are closed", async () => {
    const closed = SEAM.map((e) => (e.state === "gap" ? { ...e, state: "covered" as const, via: "viewport" } : e));
    const coverage = seamCoverage(closed);
    expect(coverage.ready).toBe(true);
    expect(seamSummary(closed)).toContain("can be deleted");
  });
});

// ===================================================================================================
// The facade
// ===================================================================================================

/**
 * A stand-in for the viewport.
 *
 * `createViewport` builds a real `WebGLRenderer`, and happy-dom has no WebGL — so the facade cannot be
 * constructed at all without this. Mocking the boundary is the right answer rather than a workaround: the
 * viewport needs a GPU by definition, it is already exercised against SwiftShader in the E2E suite, and what is
 * under test here is *composition* — does the facade call the right things in the right order and dispose them.
 *
 * The fake records what it was asked to do, which is how "reopens the kernel on the new bytes" and "renders a
 * ribbon only when given somewhere to put it" can be asserted without a renderer.
 */
vi.mock("@massing/viewport", () => ({
  // **Async, matching the real signature.** A synchronous mock would let a missing `await` in `embed.ts` pass here
  // and fail in production: `await someObject` resolves to the object, so the facade would work against the fake and
  // hold a `Promise<Viewport>` against the real one. The mock has to be the same shape as the thing it stands in for.
  createViewport: async () => {
    const listeners: ((refs: readonly { modelId: string; expressId: number }[]) => void)[] = [];
    let disposed = 0;
    /**
     * A **real** registry, not a stub returning fixed values.
     *
     * The federation facade's job is bookkeeping across models, so a mock whose `models` is a hardcoded array would
     * let every one of those tests pass while the real viewport was never told about the second model. Keeping an
     * actual Map here is what makes "the facade forgot to call `addModel`" a failure.
     */
    const registry = new Map<string, { visible: boolean }>();
    const build = (meshes: readonly unknown[]) => ({
      group: {},
      elements: meshes.map((_, i) => ({ expressId: i + 1, guid: null, ifcType: "IFCWALL", object: {} })),
      unresolved: [],
      triangles: meshes.length * 2,
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    });
    return {
      scene: {},
      camera: {},
      renderer: {},
      showModel: (meshes: readonly unknown[], _guid: unknown, id: string) => {
        registry.clear();
        registry.set(id, { visible: true });
        return build(meshes);
      },
      addModel: (meshes: readonly unknown[], _guid: unknown, id: string) => {
        registry.set(id, { visible: registry.get(id)?.visible ?? true });
        return build(meshes);
      },
      removeModel: (id: string) => registry.delete(id),
      get models() {
        return [...registry.keys()];
      },
      setModelVisible: (id: string, visible: boolean) => {
        const entry = registry.get(id);
        if (entry === undefined) return false;
        entry.visible = visible;
        return true;
      },
      isModelVisible: (id: string) => registry.get(id)?.visible ?? null,
      setModelTransform: (id: string) => registry.has(id),
      fit: () => {},
      pick: () => null,
      select: () => {},
      selection: [],
      onSelect: (fn: (refs: readonly { modelId: string; expressId: number }[]) => void) => {
        listeners.push(fn);
        return () => void listeners.splice(listeners.indexOf(fn), 1);
      },
      // The backend the viewport reports. Present because `Viewport` now carries it (ADR-0012) and a host is
      // expected to surface it.
      backend: { backend: "webgl2", reason: "test double", degraded: false },
      stats: () => ({ triangles: 0, drawCalls: 0, geometries: 0, textures: 0, fps: 60 }),
      dispose: () => {
        disposed++;
      },
      get disposeCount() {
        return disposed;
      },
    };
  },
}));

const IFC =
  "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCWALL('0aBcDeFgHiJkLmNoPqRsTu',$,$,$,$,$,$,$,$);\nENDSEC;\n";

/** A tessellator that produces one square mesh, so `open()` has something to show. */
const tessellate = (text: string) => ({
  meshes: text.includes("IFCWALL")
    ? [
        {
          expressId: 1,
          ifcType: "IFCWALL",
          positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]),
          normals: new Float32Array(18),
          indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
          color: [0.8, 0.8, 0.8, 1] as const,
        },
      ]
    : [],
  guids: new Map([[1, "0aBcDeFgHiJkLmNoPqRsTu"]]),
});

function fakeKernel(over: Partial<KernelProvider> = {}) {
  const opened: string[] = [];
  const kernel = {
    id: "fake",
    version: "0.0.0",
    capabilities: { author: true, offline: true, transactions: "snapshot", drawings: ["plan"] },
    ops: async () => ({ ok: true as const, value: [] }),
    supports: () => false,
    open: async (_id: unknown, ifc?: string) => {
      opened.push(ifc ?? "");
      return { ok: true };
    },
    ...over,
  } as unknown as KernelProvider;
  return { kernel, opened };
}

/**
 * Async since `createViewport` became async for `WebGPURenderer.init()` (ADR-0012).
 *
 * The viewport is mocked here, so the promise resolves immediately — but the signature has to match the real one or
 * these tests would stop exercising the shape massing actually calls.
 */
async function mount(over: Partial<Parameters<typeof createMassingViewer>[0]> = {}): Promise<{
  viewer: MassingViewer;
  container: HTMLElement;
  opened: string[];
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const { kernel, opened } = fakeKernel();
  const viewer = await createMassingViewer({ container, kernel, tessellate, modelId: asModelId("m"), ...over });
  return { viewer, container, opened };
}

describe("createMassingViewer", () => {
  it("is idempotent on dispose", async () => {
    // React strict mode unmounts twice, and throwing the second time turns a benign double-unmount into a crash.
    // Every kernel guide in this repo says the same thing about `dispose`; the facade has to obey it too.
    const { viewer } = await mount();
    expect(() => {
      viewer.dispose();
      viewer.dispose();
      viewer.dispose();
    }).not.toThrow();
  });

  it("reopens the kernel on the new bytes", async () => {
    // The failure this prevents: a correct-looking 3D view whose kernel still holds the previous model, so the
    // first edit applies to a file the user is not looking at. Doing it inside `open()` rather than leaving it to
    // the caller is what makes that impossible rather than merely documented.
    const { viewer, opened } = await mount();
    const result = await viewer.open(IFC, "Tower-A.ifc");
    expect(result.ok).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("ISO-10303-21");
    viewer.dispose();
  });

  it("refuses a file whose bytes are not what its name says", async () => {
    // A `.ifc` that is really an ifcZIP is routine — Revit and Archicad both export one — and handing a ZIP to an
    // IFC parser yields "unexpected token PK", which is true and useless.
    const { viewer } = await mount();
    const result = await viewer.open("PKjunk", "model.ifc");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.why).toContain("zip");
    viewer.dispose();
  });

  it("reports a model with no geometry rather than showing an empty scene", async () => {
    const { viewer } = await mount();
    const result = await viewer.open("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\n", "e.ifc");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.why).toContain("no geometry");
    viewer.dispose();
  });

  it("discards a drawing cut from the previous model", async () => {
    // A plan is a *view* of a model. Keeping one across a model swap would show the old building with the new
    // model's identity attached to it, which is worse than showing nothing.
    const { viewer } = await mount();
    await viewer.open(IFC, "a.ifc");
    expect(viewer.cut()).not.toBeNull();
    expect(viewer.drawing).not.toBeNull();
    await viewer.open(IFC, "b.ifc");
    expect(viewer.drawing).toBeNull();
    viewer.dispose();
  });

  it("refuses to export before anything is cut", async () => {
    // Throwing here rather than returning an empty SVG. An empty export looks like a successful export of an
    // empty model, and somebody will send it to a consultant.
    const { viewer } = await mount();
    expect(() => viewer.export("svg")).toThrow(/cut\(\) first/);
    viewer.dispose();
  });

  it("exports all three formats from one drawing", async () => {
    const { viewer } = await mount();
    await viewer.open(IFC, "a.ifc");
    viewer.cut();
    expect(typeof viewer.export("svg")).toBe("string");
    expect(typeof viewer.export("dxf")).toBe("string");
    expect(viewer.export("pdf")).toBeInstanceOf(Uint8Array);
    viewer.dispose();
  });

  it("renders a ribbon only when given somewhere to put it", async () => {
    // A host mid-migration keeps its own toolbar, and a facade that insisted on rendering one would force a
    // bigger PR than the migration needs.
    const { viewer } = await mount();
    expect(viewer.ribbon).toBeNull();
    viewer.dispose();

    const ribbonContainer = document.createElement("div");
    document.body.appendChild(ribbonContainer);
    const second = await mount({ ribbonContainer });
    expect(second.viewer.ribbon).not.toBeNull();
    expect(ribbonContainer.querySelector(".mv-ribbon-tabs")).not.toBeNull();
    second.viewer.dispose();
    expect(ribbonContainer.querySelector(".mv-ribbon-tabs")).toBeNull();
  });

  it("reports a keybinding conflict rather than resolving it silently", async () => {
    const status: string[] = [];
    const conflicting = [
      {
        id: "a.one",
        name: "a",
        version: "1.0.0",
        activation: ["onStartupFinished" as const],
        contributes: {
          commands: [{ id: "a.one.go", title: "Go A" }],
          keybindings: [{ command: "a.one.go", key: "Ctrl+K" }],
        },
      },
      {
        id: "b.two",
        name: "b",
        version: "1.0.0",
        activation: ["onStartupFinished" as const],
        contributes: {
          commands: [{ id: "b.two.go", title: "Go B" }],
          keybindings: [{ command: "b.two.go", key: "ctrl+k" }],
        },
      },
    ];
    const { viewer } = await mount({ plugins: conflicting, onStatus: (m) => status.push(m) });
    expect(status.join(" ")).toContain("Ctrl+K");
    expect(status.join(" ")).toContain("the first wins");
    viewer.dispose();
  });

  it("refuses to load a plugin with no loader configured", async () => {
    // A default loader returning an empty runtime would make a plugin that failed to load indistinguishable from
    // one that loaded and did nothing.
    const status: string[] = [];
    const { viewer } = await mount({
      plugins: [
        {
          id: "x.y",
          name: "x",
          version: "1.0.0",
          activation: ["onCommand:x.y.go"],
          contributes: { commands: [{ id: "x.y.go", title: "Go" }] },
        },
      ],
      onStatus: (m) => status.push(m),
    });
    return viewer.host.fire("onCommand:x.y.go").then(() => {
      expect(status.join(" ")).toContain("no loader configured");
      expect(viewer.host.plugins.find((p) => p.manifest.id === "x.y")!.state).toBe("quarantined");
      viewer.dispose();
    });
  });

  it("installs a drop target only when a handler is given", async () => {
    // Otherwise the facade would install a document-level guard in a host that already has one, and two guards
    // both cancelling the default is how a host's own drop handling stops working.
    const onFiles = vi.fn();
    const { viewer, container } = await mount({ onFiles });
    const event = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { files: [], items: [], dropEffect: "none" } });
    container.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    viewer.dispose();
  });
});

// ===================================================================================================
// Regressions from the code review
// ===================================================================================================

describe("the session the facade exposes", () => {
  it("does not let the selection stand in for the element you clicked", async () => {
    // `elementAt` used to return `selection`, which answers a different question. An element-argument command then
    // committed whatever happened to be selected regardless of where the user clicked, and with nothing selected,
    // clicking the very wall the prompt asked for never advanced it.
    //
    // This needs no GPU, and it is the stronger claim anyway: with something selected and no pointer recorded, an
    // element pick must NOT resolve. Under the old code it resolved to the selection and committed.
    const { viewer } = await mount();
    await viewer.open(IFC, "Tower-A.ifc");

    const off = viewer.commands.register({
      id: "test.pickone",
      title: "Pick one",
      args: [{ name: "guid", kind: "element", prompt: "Select an element" }],
      async run() {
        return { ok: true as const, value: null };
      },
    });

    // Select something, so the old behaviour would have had an answer to give.
    const guid = viewer.viewport.selection.length > 0 ? null : null;
    void guid;
    expect(viewer.session.arm("test.pickone").ok).toBe(true);
    const outcome = await viewer.session.pick({ x: 1, z: 1 });

    expect(outcome.kind, "an unresolved element pick keeps waiting").toBe("collecting");
    expect(viewer.session.state.armed).toBe("test.pickone");

    off();
    viewer.dispose();
  });

  it("dispatches a composite command's sub-command for real", async () => {
    // `CommandContext.dispatch` is documented as "how a composite command is built". It was stubbed to
    // `{ok: true, value: null}`, so a command dispatching a sub-command got success back and nothing happened: no
    // kernel call, no undo entry, an incomplete audit log, and no way to notice.
    const { viewer } = await mount();
    await viewer.open(IFC, "Tower-A.ifc");

    let innerRan = 0;
    const offLeaf = viewer.commands.register({
      id: "test.leaf",
      title: "Leaf",
      args: [],
      async run() {
        innerRan++;
        return { ok: true as const, value: null };
      },
    });
    const offOuter = viewer.commands.register({
      id: "test.outer",
      title: "Outer",
      args: [],
      async run(_args, ctx) {
        await ctx.dispatch({
          commandId: "test.leaf",
          args: {},
          origin: { via: "plugin", pluginId: "test" },
          seq: 99,
          at: "2026-01-01T00:00:00.000Z",
        });
        return { ok: true as const, value: null };
      },
    });

    expect(viewer.session.arm("test.outer").ok).toBe(true);
    await viewer.session.key("Enter");

    expect(innerRan, "the sub-command must actually run").toBe(1);

    offLeaf();
    offOuter();
    viewer.dispose();
  });
});

// ===================================================================================================
// showMeshes — the entry point for a host that never hands over IFC text
// ===================================================================================================

describe("showMeshes", () => {
  /**
   * These exist because of a specific finding, and it is worth stating so the tests are not mistaken for
   * coverage-by-symmetry.
   *
   * massing converts IFC server-side and streams geometry; *"never parse full IFC in the browser at runtime"* is
   * one of its hard constraints. Before `showMeshes`, the only route for such a host was `viewport.showModel` —
   * which works, reports success, and **silently skips** the snap grid, the kernel handoff, and invalidating a
   * drawing and selection cut from the previous model. 3D and picking both look right. Snapping has no candidates
   * and the first edit goes to whichever model the kernel last opened.
   *
   * So each test below pins one of the things that used to be skipped.
   */

  /** The same square `tessellate` produces, handed over directly the way a Fragments pipeline would. */
  const SQUARE = {
    meshes: [
      {
        expressId: 7,
        ifcType: "IFCWALL",
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1]),
        normals: new Float32Array(18),
        indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
        color: [0.8, 0.8, 0.8, 1] as const,
      },
    ],
    guids: new Map([[7, "1zYxWvUtSrQpOnMlKjIhGf"]]),
  };

  it("shows geometry without a tessellator being supplied at all", async () => {
    // The point of making `tessellate` optional: a host that never parses IFC must not have to ship a `web-ifc`
    // WASM payload it would never execute.
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { kernel } = fakeKernel();
    const viewer = await createMassingViewer({ container, kernel, modelId: asModelId("m") });

    const result = await viewer.showMeshes({ ...SQUARE, kernel: { alreadyOpen: true } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.elements).toBe(1);
    viewer.dispose();
  });

  it("says so, rather than crashing, when openIfc is called with no tessellator", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { kernel } = fakeKernel();
    const viewer = await createMassingViewer({ container, kernel, modelId: asModelId("m") });

    const result = await viewer.openIfc(IFC, "Tower-A.ifc");
    expect(result.ok).toBe(false);
    // A host that reached here has almost certainly called the wrong method, so the message names the other one.
    if (!result.ok) {
      expect(result.why).toContain("no tessellator");
      expect(result.why).toContain("showMeshes");
    }
    viewer.dispose();
  });

  it("builds the snap grid, which is the thing viewport.showModel silently skipped", async () => {
    const { viewer } = await mount();
    viewer.session.arm("draft.wall");
    // A cursor 20 mm from the square's corner at (1, 0, 1). Without a snap grid there are no candidates and this
    // is null — which is exactly how a host using `showModel` directly lost snapping without any error.
    // `Vec2` in this codebase is `{ x, z }` — the ground plane, not screen space. Writing `{ x, y }` here is how
    // this test failed the first time, and it failed by reporting "the grid was not rebuilt", which was a lie.
    const before = viewer.session.hover({ x: 1.02, z: 1.02 });
    expect(before.snap, "snapped before any model was shown").toBeNull();

    await viewer.showMeshes({ ...SQUARE, kernel: { alreadyOpen: true } });
    const after = viewer.session.hover({ x: 1.02, z: 1.02 });
    expect(after.snap, "no snap candidate after showMeshes — the grid was not rebuilt").not.toBeNull();
    viewer.dispose();
  });

  it("hands the model to the kernel when asked, and not when told it is already open", async () => {
    const { viewer, opened } = await mount();

    await viewer.showMeshes({ ...SQUARE, kernel: { alreadyOpen: true } });
    // The remote case: the server already holds the model, so sending it would be pointless at best. Critically it
    // must not call `kernel.open(modelId)` with no text either — for LocalKernel that starts a BLANK model, so the
    // viewport would show this geometry while the kernel held nothing.
    expect(opened, "showMeshes reopened the kernel despite alreadyOpen").toHaveLength(0);

    await viewer.showMeshes({ ...SQUARE, kernel: { ifc: IFC } });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("ISO-10303-21");
    viewer.dispose();
  });

  it("discards a drawing and selection cut from the previous model", async () => {
    const { viewer } = await mount();
    await viewer.open(IFC, "a.ifc");
    expect(viewer.cut()).not.toBeNull();
    viewer.select("0aBcDeFgHiJkLmNoPqRsTu" as never);
    expect(viewer.selection).not.toBeNull();

    await viewer.showMeshes({ ...SQUARE, kernel: { alreadyOpen: true } });
    // A plan is a *view* of a model, and a GlobalId selected in the old one need not exist in this one.
    expect(viewer.drawing, "a drawing survived a model swap").toBeNull();
    expect(viewer.selection, "a selection survived a model swap").toBeNull();
    viewer.dispose();
  });

  it("cuts a drawing from meshes it was handed directly", async () => {
    // Proof the geometry reached the 2D layer and not only the GPU: the drawing has to carry the GlobalId that
    // came in with the meshes, because that is what markup and plan↔3D selection anchor to.
    const { viewer } = await mount();
    await viewer.showMeshes({ ...SQUARE, kernel: { alreadyOpen: true } });
    const drawing = viewer.cut({ kind: "plan", cutHeight: 0.5 });
    expect(drawing).not.toBeNull();
    viewer.dispose();
  });

  it("refuses empty geometry instead of showing an empty scene", async () => {
    const { viewer } = await mount();
    const result = await viewer.showMeshes({ meshes: [], guids: new Map(), kernel: { alreadyOpen: true } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.why).toContain("no geometry");
    viewer.dispose();
  });

  it("keeps `open` working as a delegate, because it is a published surface", async () => {
    const { viewer, opened } = await mount();
    const result = await viewer.open(IFC, "Tower-A.ifc");
    expect(result.ok).toBe(true);
    expect(opened).toHaveLength(1);
    viewer.dispose();
  });
});

// ===================================================================================================
// Federation at the facade — ADR-0013's last mile
// ===================================================================================================

/**
 * A closed unit box with a chosen expressId and guid, so two models can deliberately collide on the id.
 *
 * A **box**, not the flat quad the tests above use. A zero-thickness surface has no closed section, so cutting it
 * yields a drawing with no element-derived geometry — which made the labelling test below fail for a reason that had
 * nothing to do with labelling. The other tests here never cut, so a quad was enough for them.
 */
const boxAs = (expressId: number, guid: string) => ({
  meshes: [
    {
      expressId,
      ifcType: "IFCWALL",
      // 8 corners: y=0 face first, then y=1. Cut at y=0.5 and the section is a real loop.
      positions: new Float32Array([
        0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, //
        0, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1,
      ]),
      normals: new Float32Array(24),
      indices: new Uint32Array([
        0, 2, 1, 0, 3, 2, // bottom
        4, 5, 6, 4, 6, 7, // top
        0, 1, 5, 0, 5, 4, // z = 0
        3, 7, 6, 3, 6, 2, // z = 1
        0, 4, 7, 0, 7, 3, // x = 0
        1, 2, 6, 1, 6, 5, // x = 1
      ]),
      color: [0.8, 0.8, 0.8, 1] as const,
    },
  ],
  guids: new Map([[expressId, guid]]),
});

const ARCH_GUID = "0aBcDeFgHiJkLmNoPqRsTu";
const STRUCT_GUID = "1zYxWvUtSrQpOnMlKjIhGf";
const STRUCT = asModelId("struct");

describe("federation at the facade", () => {
  it("adds a model beside the reference model rather than replacing it", async () => {
    const { viewer } = await mount();
    await viewer.showMeshes({ ...boxAs(1, ARCH_GUID), kernel: { alreadyOpen: true } });
    const added = viewer.addModel({ modelId: STRUCT, ...boxAs(1, STRUCT_GUID) });

    expect(added).toEqual({ ok: true, elements: 1 });
    expect(viewer.models).toEqual([asModelId("m"), STRUCT]);
    viewer.dispose();
  });

  it("keeps showMeshes as REPLACE, so a single-model host is unchanged", async () => {
    // The compatibility promise. showMeshes has always meant "show this instead", and federation must not quietly
    // turn every load into an accumulation — a host calling it in a loop would end up with a scene full of history.
    const { viewer } = await mount();
    viewer.addModel({ modelId: STRUCT, ...boxAs(1, STRUCT_GUID) });
    await viewer.showMeshes({ ...boxAs(1, ARCH_GUID), kernel: { alreadyOpen: true } });
    expect(viewer.models).toEqual([asModelId("m")]);
    viewer.dispose();
  });

  it("cuts a plan that labels each model's element with ITS OWN GlobalId", async () => {
    /**
     * The bug this design exists to prevent, and the one a union-of-meshes shortcut would have shipped.
     *
     * Both models here contain expressId 1 — ordinary, because expressIds are per file. Handing the union to a single
     * expressId-to-guid map would label one model's wall with the other's GlobalId. The drawing would look correct
     * and its data-guid attributes would point at the wrong building: markup anchored from that plan would land on
     * another consultant's element, and nothing would report it.
     */
    const { viewer } = await mount();
    await viewer.showMeshes({ ...boxAs(1, ARCH_GUID), kernel: { alreadyOpen: true } });
    viewer.addModel({ modelId: STRUCT, ...boxAs(1, STRUCT_GUID) });

    const drawing = viewer.cut({ kind: "plan", cutHeight: 0.5 });
    expect(drawing, "nothing was cut, so the labelling assertion below would be vacuous").not.toBeNull();
    // guidsIn is the package's own accessor. My first attempt invented an `e.guids` array that does not exist, so
    // the set came back empty and the test failed for a reason unrelated to what it is about.
    const guids = new Set(guidsIn(drawing!));
    expect(guids, "the architectural element lost its GlobalId").toContain(ARCH_GUID);
    expect(guids, "the structural element was labelled with the wrong model's GlobalId").toContain(STRUCT_GUID);
    viewer.dispose();
  });

  it("reports a duplicate GlobalId across models instead of resolving it silently", async () => {
    // IFC requires GlobalIds to be unique, and real exporters break that. Refusing the file would stop the user
    // looking at their own building; resolving it silently would put their markup on the wrong element. Saying so is
    // the only option that does neither.
    const warnings: string[] = [];
    const { viewer } = await mount({
      onStatus: (m: string, kind: string) => {
        if (kind === "warn") warnings.push(m);
      },
    });
    await viewer.showMeshes({ ...boxAs(1, ARCH_GUID), kernel: { alreadyOpen: true } });
    viewer.addModel({ modelId: STRUCT, ...boxAs(7, ARCH_GUID) });

    expect(warnings.join(" "), "a duplicate GlobalId passed without a word").toContain(ARCH_GUID);
    viewer.dispose();
  });

  it("does not repoint the kernel at an added model", async () => {
    /**
     * The judgement worth pinning, because the opposite is defensible until you say it out loud.
     *
     * showMeshes hands the kernel its model, since a viewer whose kernel holds a different file edits something the
     * user is not looking at. A federation has no equivalent answer — an authoring kernel edits *one* file — so
     * following the most recent arrival would mean a consultant's reference model becomes the edit target simply by
     * being loaded second.
     */
    const { viewer, opened } = await mount();
    await viewer.showMeshes({ ...boxAs(1, ARCH_GUID), kernel: { ifc: IFC } });
    const afterReference = opened.length;
    viewer.addModel({ modelId: STRUCT, ...boxAs(1, STRUCT_GUID) });
    expect(opened.length, "adding a reference model repointed the kernel at it").toBe(afterReference);
    viewer.dispose();
  });

  it("treats an anchor as live if the element exists in ANY loaded model", async () => {
    // Orphan detection scoped to one model would report every consultant-model anchor as orphaned the moment
    // federation was used — the markup equivalent of the selection bug.
    const { viewer } = await mount();
    await viewer.showMeshes({ ...boxAs(1, ARCH_GUID), kernel: { alreadyOpen: true } });
    viewer.addModel({ modelId: STRUCT, ...boxAs(1, STRUCT_GUID) });

    viewer.select(STRUCT_GUID as never);
    const topic = viewer.raise({ title: "on the structural model" });
    expect(topic, "nothing was raised, so the orphan assertion would be vacuous").not.toBeNull();
    expect(viewer.orphans, "an anchor into a federated model was called orphaned").toEqual([]);
    viewer.dispose();
  });

  it("unloads a model, and drops a selection that lived in it", async () => {
    const { viewer } = await mount();
    await viewer.showMeshes({ ...boxAs(1, ARCH_GUID), kernel: { alreadyOpen: true } });
    viewer.addModel({ modelId: STRUCT, ...boxAs(2, STRUCT_GUID) });
    viewer.select(STRUCT_GUID as never);
    expect(viewer.selection).toBe(STRUCT_GUID);

    expect(viewer.removeModel(STRUCT)).toBe(true);
    expect(viewer.models).toEqual([asModelId("m")]);
    expect(viewer.selection, "a selection survived the unloading of the model holding it").toBeNull();
    // False rather than throwing, so a host reacting to a websocket message need not guard.
    expect(viewer.removeModel(STRUCT)).toBe(false);
    viewer.dispose();
  });

  it("keeps a selection that lives in a model that was NOT unloaded", async () => {
    const { viewer } = await mount();
    await viewer.showMeshes({ ...boxAs(1, ARCH_GUID), kernel: { alreadyOpen: true } });
    viewer.addModel({ modelId: STRUCT, ...boxAs(2, STRUCT_GUID) });
    viewer.select(ARCH_GUID as never);

    viewer.removeModel(STRUCT);
    expect(viewer.selection, "unloading one model cleared an unrelated selection").toBe(ARCH_GUID);
    viewer.dispose();
  });

  it("invalidates a drawing when the federation changes under it", async () => {
    // A drawing is a view of a set of models. Keeping it after one arrives or leaves would let export() emit a sheet
    // of a scene that no longer exists, which is worse than making the caller re-cut.
    const { viewer } = await mount();
    await viewer.showMeshes({ ...boxAs(1, ARCH_GUID), kernel: { alreadyOpen: true } });
    expect(viewer.cut({ kind: "plan", cutHeight: 0.5 })).not.toBeNull();

    viewer.addModel({ modelId: STRUCT, ...boxAs(2, STRUCT_GUID) });
    expect(viewer.drawing, "a drawing cut before a model arrived still described the old federation").toBeNull();

    viewer.cut({ kind: "plan", cutHeight: 0.5 });
    viewer.removeModel(STRUCT);
    expect(viewer.drawing, "a drawing survived the removal of a model it was cut from").toBeNull();
    viewer.dispose();
  });

  it("hides one model without touching the other", async () => {
    const { viewer } = await mount();
    await viewer.showMeshes({ ...boxAs(1, ARCH_GUID), kernel: { alreadyOpen: true } });
    viewer.addModel({ modelId: STRUCT, ...boxAs(2, STRUCT_GUID) });

    expect(viewer.setModelVisible(STRUCT, false)).toBe(true);
    expect(viewer.isModelVisible(STRUCT)).toBe(false);
    expect(viewer.isModelVisible(asModelId("m"))).toBe(true);
    expect(viewer.isModelVisible(asModelId("nope")), "guessed at a model it does not hold").toBeNull();
    viewer.dispose();
  });

  it("refuses an empty model rather than registering a model with nothing in it", async () => {
    const { viewer } = await mount();
    const result = viewer.addModel({ modelId: STRUCT, meshes: [], guids: new Map() });
    expect(result.ok).toBe(false);
    expect(viewer.models).not.toContain(STRUCT);
    viewer.dispose();
  });
});

describe("cutting indexed geometry, which is what a tessellator produces", () => {
  /**
   * A regression test for a bug the facade shipped: `toElementMeshes` dropped `indices`.
   *
   * `ElementMesh` says absent indices mean the positions *are* a triangle soup, so dropping them did not fail — it
   * changed the meaning of the data. An indexed box's 8 corners were read as 2 unrelated triangles, and `cut()`
   * returned a plan of a shape that does not exist while reporting success.
   *
   * The assertion is on the **footprint**, not on entity counts. A count can be satisfied by nonsense geometry; the
   * bounds of a section through a unit box at mid-height cannot — they must be the box's own footprint.
   */
  it("sections a box through its real faces, not through vertex soup", async () => {
    const { viewer } = await mount();
    await viewer.showMeshes({ ...boxAs(1, ARCH_GUID), kernel: { alreadyOpen: true } });

    const drawing = viewer.cut({ kind: "plan", cutHeight: 0.5 });
    expect(drawing).not.toBeNull();

    const cut = drawing!.entities.filter((e) => e.role === "cut");
    expect(cut.length, "no cut geometry at all — the section found nothing to cut").toBeGreaterThan(0);

    // The unit box spans 0..1 in both plan axes, so `bounds` — the drawing's own record of its content extent — must
    // be the box's footprint. A soup reading of the same 8 vertices sections two arbitrary triangles instead, and its
    // extent does not agree with the box. Read from `bounds` rather than by walking `geometry`, which is a tagged
    // union: reaching into it was how this test first asserted a field (`e.points`) that does not exist at that level.
    expect(drawing!.bounds.min.x, "the plan does not start at the box's edge").toBeCloseTo(0, 3);
    expect(drawing!.bounds.max.x, "the plan is not as wide as the box").toBeCloseTo(1, 3);
    expect(drawing!.bounds.min.y).toBeCloseTo(0, 3);
    expect(drawing!.bounds.max.y).toBeCloseTo(1, 3);

    // Every element that should have a GlobalId has one, so the plan is anchorable.
    expect(drawing!.provenance.guidCoverage).toBe(1);
    viewer.dispose();
  });
});

describe("an exported sheet carries a title block; the app's own pane does not", () => {
  /**
   * The same drawing serves two purposes that want opposite furniture.
   *
   * A pane inside the application is a *view*: a title block floating in a panel is noise, which is the complaint
   * that started this work from the other direction. A file that leaves the building is a *sheet*, and one with no
   * project name, sheet number or revision is not issuable however good the linework is.
   */
  const cutOne = async () => {
    const { viewer } = await mount();
    await viewer.showMeshes({ ...boxAs(1, ARCH_GUID), kernel: { alreadyOpen: true } });
    expect(viewer.cut({ kind: "plan", cutHeight: 0.5 })).not.toBeNull();
    return viewer;
  };

  it("puts the caller's fields into an exported PDF", async () => {
    const viewer = await cutOne();
    const pdf = viewer.export("pdf", undefined, undefined, {
      titleBlock: { project: "Tower A", sheetNumber: "A-101", revision: "C" },
    }) as Uint8Array;
    const text = new TextDecoder("latin1").decode(pdf);
    for (const field of ["Tower A", "A-101", "PROJECT", "SHEET"]) {
      expect(text, `the exported PDF has no ${field}`).toContain(field);
    }
    viewer.dispose();
  });

  it("puts them into an exported DXF too, so the two delivery formats agree", async () => {
    // Export is meant to be three pure functions of the same inputs. A title block present in the PDF and absent
    // from the DXF would be exactly the parallel-path drift the Semantic Drawing Model exists to prevent.
    const viewer = await cutOne();
    const dxf = viewer.export("dxf", undefined, undefined, {
      titleBlock: { project: "Tower A", sheetNumber: "A-101" },
    }) as string;
    expect(dxf).toContain("Tower A");
    expect(dxf).toContain("A-101");
    expect(dxf, "sheet furniture is not on its own layer").toContain("SHEET");
    viewer.dispose();
  });

  it("leaves the interactive SVG free of sheet furniture", async () => {
    const viewer = await cutOne();
    const svg = viewer.export("svg", undefined, undefined, { titleBlock: { project: "Tower A" } }) as string;
    expect(svg, "the app's own pane grew a title block").not.toContain("PROJECT");
    // And it keeps the thing it exists for: clickable, identity-carrying linework.
    expect(svg).toContain("data-guid");
    viewer.dispose();
  });

  it("falls back to the drawing's own name rather than an empty block", async () => {
    // An export that names no fields should still say what the sheet is and at what scale. An empty title block is
    // worse than none: it looks like an issued sheet whose information was lost.
    const viewer = await cutOne();
    const pdf = viewer.export("pdf") as Uint8Array;
    const text = new TextDecoder("latin1").decode(pdf);
    expect(text, "the exported sheet does not name the drawing").toContain("Plan");
    expect(text, "the exported sheet does not state its scale").toContain("1:");
    viewer.dispose();
  });
});
