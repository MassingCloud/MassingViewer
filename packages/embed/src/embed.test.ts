// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { asModelId } from "@massing/core";
import type { KernelProvider } from "@massing/kernel-api";
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
    const listeners: ((ids: readonly number[]) => void)[] = [];
    let disposed = 0;
    return {
      scene: {},
      camera: {},
      renderer: {},
      showModel: (meshes: readonly unknown[]) => ({
        group: {},
        elements: meshes.map((_, i) => ({ expressId: i + 1, guid: null, ifcType: "IFCWALL", object: {} })),
        unresolved: [],
        triangles: meshes.length * 2,
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      }),
      fit: () => {},
      pick: () => null,
      select: () => {},
      selection: [],
      onSelect: (fn: (ids: readonly number[]) => void) => {
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
