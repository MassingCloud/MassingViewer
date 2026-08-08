// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { asModelId } from "@massingviewer/core";
import type { KernelProvider } from "@massingviewer/kernel-api";
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
  it("names a facade member for everything it claims is covered", () => {
    // The assertion that makes the ledger trustworthy. Marking a capability `covered` without a `via` is how a
    // checklist drifts into optimism — and the whole reason this is code rather than a markdown table.
    for (const entry of SEAM.filter((e) => e.state === "covered")) {
      expect(entry.via, `${entry.id} is marked covered with no facade member`).toBeTruthy();
    }
  });

  it("points every `via` at something the facade actually exposes", () => {
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

  it("gives every gap and every boundary a reason", () => {
    // A gap with no reason is a to-do nobody can schedule, and a boundary with no reason reads as an unfinished
    // gap — which is how "not covered" gets mistaken for "not working".
    for (const entry of SEAM.filter((e) => e.state !== "covered")) {
      expect(entry.note, `${entry.id} has no note`).toBeTruthy();
      expect(entry.note!.length, `${entry.id}'s note is too short to act on`).toBeGreaterThan(40);
    }
  });

  it("reports the seam as ready, with every movable capability covered", () => {
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

  it("still refuses to call a partial seam ready", () => {
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

  it("does not count a boundary as a gap", () => {
    // `ApiClient` staying in massing is the design, not a shortfall. Counting it against readiness would make the
    // number permanently and misleadingly low.
    const coverage = seamCoverage();
    expect(coverage.boundaries).toBeGreaterThan(0);
    expect(coverage.gaps.map((g) => g.id)).not.toContain("api.client");
  });

  it("has no duplicate ids", () => {
    const ids = SEAM.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reports ready only when the gaps are closed", () => {
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
vi.mock("@massingviewer/viewport", () => ({
  createViewport: () => {
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

function mount(over: Partial<Parameters<typeof createMassingViewer>[0]> = {}): {
  viewer: MassingViewer;
  container: HTMLElement;
  opened: string[];
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const { kernel, opened } = fakeKernel();
  const viewer = createMassingViewer({ container, kernel, tessellate, modelId: asModelId("m"), ...over });
  return { viewer, container, opened };
}

describe("createMassingViewer", () => {
  it("is idempotent on dispose", () => {
    // React strict mode unmounts twice, and throwing the second time turns a benign double-unmount into a crash.
    // Every kernel guide in this repo says the same thing about `dispose`; the facade has to obey it too.
    const { viewer } = mount();
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
    const { viewer, opened } = mount();
    const result = await viewer.open(IFC, "Tower-A.ifc");
    expect(result.ok).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("ISO-10303-21");
    viewer.dispose();
  });

  it("refuses a file whose bytes are not what its name says", async () => {
    // A `.ifc` that is really an ifcZIP is routine — Revit and Archicad both export one — and handing a ZIP to an
    // IFC parser yields "unexpected token PK", which is true and useless.
    const { viewer } = mount();
    const result = await viewer.open("PKjunk", "model.ifc");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.why).toContain("zip");
    viewer.dispose();
  });

  it("reports a model with no geometry rather than showing an empty scene", async () => {
    const { viewer } = mount();
    const result = await viewer.open("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\n", "e.ifc");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.why).toContain("no geometry");
    viewer.dispose();
  });

  it("discards a drawing cut from the previous model", async () => {
    // A plan is a *view* of a model. Keeping one across a model swap would show the old building with the new
    // model's identity attached to it, which is worse than showing nothing.
    const { viewer } = mount();
    await viewer.open(IFC, "a.ifc");
    expect(viewer.cut()).not.toBeNull();
    expect(viewer.drawing).not.toBeNull();
    await viewer.open(IFC, "b.ifc");
    expect(viewer.drawing).toBeNull();
    viewer.dispose();
  });

  it("refuses to export before anything is cut", () => {
    // Throwing here rather than returning an empty SVG. An empty export looks like a successful export of an
    // empty model, and somebody will send it to a consultant.
    const { viewer } = mount();
    expect(() => viewer.export("svg")).toThrow(/cut\(\) first/);
    viewer.dispose();
  });

  it("exports all three formats from one drawing", async () => {
    const { viewer } = mount();
    await viewer.open(IFC, "a.ifc");
    viewer.cut();
    expect(typeof viewer.export("svg")).toBe("string");
    expect(typeof viewer.export("dxf")).toBe("string");
    expect(viewer.export("pdf")).toBeInstanceOf(Uint8Array);
    viewer.dispose();
  });

  it("renders a ribbon only when given somewhere to put it", () => {
    // A host mid-migration keeps its own toolbar, and a facade that insisted on rendering one would force a
    // bigger PR than the migration needs.
    const { viewer } = mount();
    expect(viewer.ribbon).toBeNull();
    viewer.dispose();

    const ribbonContainer = document.createElement("div");
    document.body.appendChild(ribbonContainer);
    const second = mount({ ribbonContainer });
    expect(second.viewer.ribbon).not.toBeNull();
    expect(ribbonContainer.querySelector(".mv-ribbon-tabs")).not.toBeNull();
    second.viewer.dispose();
    expect(ribbonContainer.querySelector(".mv-ribbon-tabs")).toBeNull();
  });

  it("reports a keybinding conflict rather than resolving it silently", () => {
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
    const { viewer } = mount({ plugins: conflicting, onStatus: (m) => status.push(m) });
    expect(status.join(" ")).toContain("Ctrl+K");
    expect(status.join(" ")).toContain("the first wins");
    viewer.dispose();
  });

  it("refuses to load a plugin with no loader configured", () => {
    // A default loader returning an empty runtime would make a plugin that failed to load indistinguishable from
    // one that loaded and did nothing.
    const status: string[] = [];
    const { viewer } = mount({
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

  it("installs a drop target only when a handler is given", () => {
    // Otherwise the facade would install a document-level guard in a host that already has one, and two guards
    // both cancelling the default is how a host's own drop handling stops working.
    const onFiles = vi.fn();
    const { viewer, container } = mount({ onFiles });
    const event = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { files: [], items: [], dropEffect: "none" } });
    container.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    viewer.dispose();
  });
});
