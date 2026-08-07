// @vitest-environment happy-dom
import { StrictMode, useState } from "react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Ribbon } from "./Ribbon.js";
import { CommandPalette, fuzzyScore, rank, type PaletteEntry } from "./CommandPalette.js";
import { PropertyGrid, discrepancyOf, type PropertySet } from "./PropertyGrid.js";
import { Dock, loadLayout, saveLayout, type DockPanel } from "./Dock.js";

/**
 * ## What is worth testing in a React shell, and what is not
 *
 * Not "does the component render" — that is what TypeScript and one smoke test cover. What is worth testing is
 * the set of things React specifically breaks, because they are invisible until they are in production:
 *
 * - **StrictMode double-mounting** an imperative widget, which is the default in development and exists precisely
 *   to catch effects that are not idempotent.
 * - **ARIA on a combobox**, where getting it wrong makes the widget unusable rather than merely worse.
 * - **Ranking**, because a palette where every candidate matches is the same as one where none do if the right
 *   answer is fortieth.
 */

/**
 * Count `dispose()` calls through the real `createRibbon`.
 *
 * `importOriginal` rather than a stub: the wrapper is only worth testing against the actual renderer, since half
 * of what it has to get right is how the real one behaves on a second mount. This wraps the return value and
 * counts, leaving every other behaviour untouched.
 */
let disposals = 0;
const disposeCalls = (): number => disposals;

vi.mock("@massingviewer/ribbon", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@massingviewer/ribbon")>();
  return {
    ...actual,
    createRibbon: (container: HTMLElement, options: Parameters<typeof actual.createRibbon>[1]) => {
      const handle = actual.createRibbon(container, options);
      return {
        ...handle,
        update: handle.update.bind(handle),
        setTab: handle.setTab.bind(handle),
        announce: handle.announce.bind(handle),
        dispose: () => {
          disposals++;
          handle.dispose();
        },
      };
    },
  };
});

afterEach(() => {
  cleanup();
  disposals = 0;
});

// happy-dom has neither of these, and both are load-bearing here. Written as the narrow shape the code uses, so
// anything else it starts depending on fails loudly rather than passing against a generous polyfill.
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", FakeResizeObserver);

for (const method of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const) {
  if (!(method in Element.prototype)) {
    Object.defineProperty(Element.prototype, method, { value: () => {}, writable: true });
  }
}

// ===================================================================================================
// The ribbon wrapper — the one thing that must survive StrictMode
// ===================================================================================================

describe("Ribbon", () => {
  it("disposes on cleanup, so StrictMode's second mount does not leak the first", () => {
    // The assertion this test *should* have made from the start.
    //
    // A first version asserted "exactly one `.mv-ribbon-tabs` under StrictMode" — and it passed with the
    // `dispose()` call deleted, which sabotage-testing found. `createRibbon` begins with
    // `container.innerHTML = ""`, so the second mount wipes the first one's DOM regardless: the symptom I chose
    // was already prevented by the thing under test, and the test was green for a reason unrelated to its name.
    //
    // So assert the contract instead. The wrapper's job at this boundary is exactly "create on mount, dispose on
    // cleanup", and counting the calls is the only thing that says whether it does. It also keeps holding if
    // `createRibbon` later takes a `document`-level listener the way `fileio`'s drop target does — at which point
    // a missed dispose stops being harmless.
    expect(disposeCalls()).toBe(0);
    const { unmount } = render(
      <StrictMode>
        <Ribbon onTool={() => {}} />
      </StrictMode>,
    );
    // StrictMode: mount, cleanup, mount. One dispose by the time it settles.
    expect(disposeCalls()).toBe(1);
    unmount();
    expect(disposeCalls()).toBe(2);
  });

  it("renders exactly one ribbon under StrictMode", () => {
    // Kept, but as a *belt-and-braces* check rather than as the StrictMode assertion. It guards a different
    // thing: that nothing here renders a second tab strip or a second live region — two polite regions would
    // mean every announcement is read twice.
    const { container } = render(
      <StrictMode>
        <Ribbon onTool={() => {}} />
      </StrictMode>,
    );
    expect(container.querySelectorAll(".mv-ribbon-tabs")).toHaveLength(1);
    expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it("calls the current onTool, not the one captured at mount", () => {
    // The stale-closure bug. A handler passed into `createRibbon` at mount closes over the props from that render
    // forever, so after a re-render every click still calls the *first* callback — which usually points at state
    // that no longer exists.
    const first = vi.fn();
    const second = vi.fn();

    function Host(): React.ReactElement {
      const [which, setWhich] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setWhich(1)}>
            swap
          </button>
          <Ribbon onTool={which === 0 ? first : second} />
        </>
      );
    }

    const { container } = render(<Host />);
    fireEvent.click(screen.getByText("swap"));

    const tool = container.querySelector<HTMLButtonElement>("button[data-tool]:not([aria-disabled='true'])");
    expect(tool).not.toBeNull();
    fireEvent.click(tool!);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not rebuild the ribbon when the parent re-renders", () => {
    // If the creating effect depended on props, an object literal in the caller's JSX would rebuild the whole
    // ribbon on every render — losing focus, closing an open dropdown, and costing thirty DOM builds a keystroke.
    // Identity of a live node is the only way to detect a rebuild from outside.
    function Host(): React.ReactElement {
      const [n, setN] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setN(n + 1)}>
            render {n}
          </button>
          <Ribbon onTool={() => {}} />
        </>
      );
    }
    const { container } = render(<Host />);
    const before = container.querySelector(".mv-ribbon-tabs");
    fireEvent.click(screen.getByText(/^render/));
    fireEvent.click(screen.getByText(/^render/));
    expect(container.querySelector(".mv-ribbon-tabs")).toBe(before);
  });

  it("hands back the layout item, not a ToolSpec", () => {
    // The narrowing ADR-0009 implies one layer down: a group contributed by a plugin has no `ToolSpec` behind it,
    // so a wrapper that required one would be unusable for anything but the built-in table.
    const onTool = vi.fn();
    const { container } = render(
      <Ribbon
        onTool={onTool}
        groups={[
          {
            id: "g",
            label: "Group",
            tab: "home",
            priority: 1,
            items: [{ id: "mine", label: "Mine", title: "Mine", preferred: "large" }],
          },
        ]}
      />,
    );
    fireEvent.click(container.querySelector<HTMLButtonElement>('button[data-tool="mine"]')!);
    expect(onTool).toHaveBeenCalledWith("mine", expect.objectContaining({ id: "mine", label: "Mine" }));
  });

  it("leaves nothing behind on unmount", () => {
    const { container, unmount } = render(<Ribbon onTool={() => {}} />);
    expect(container.querySelector(".mv-ribbon-tabs")).not.toBeNull();
    unmount();
    expect(container.querySelector(".mv-ribbon-tabs")).toBeNull();
  });
});

// ===================================================================================================
// Palette ranking
// ===================================================================================================

describe("fuzzy ranking", () => {
  it("matches an acronym across words", () => {
    // Subsequence, not substring: `sp` has to find "Section plane", which is the whole reason a palette beats a
    // filter box. A substring match would find nothing.
    expect(fuzzyScore("Section plane", "sp")).not.toBeNull();
    expect(fuzzyScore("Section plane", "spx")).toBeNull();
  });

  it("prefers word boundaries over mid-word hits", () => {
    // Ranking is the entire user experience. `sp` meaning "Section Plane" is overwhelmingly more likely than
    // `sp` meaning "iSolate Plane", and a scorer that cannot tell them apart puts the right answer fortieth.
    const boundary = fuzzyScore("Section plane", "sp")!.score;
    const midWord = fuzzyScore("Isolate spline", "sp")!.score;
    expect(boundary).toBeGreaterThan(midWord);
  });

  it("prefers consecutive hits", () => {
    expect(fuzzyScore("Section", "sec")!.score).toBeGreaterThan(fuzzyScore("Select colour", "sec")!.score);
  });

  it("breaks ties towards the shorter label", () => {
    // "Fit" should beat "Fit to selection extents" for the query "fit". Both match at position 0 on a boundary.
    expect(fuzzyScore("Fit", "fit")!.score).toBeGreaterThan(fuzzyScore("Fit to selection extents", "fit")!.score);
  });

  it("returns null for no match rather than a zero score", () => {
    // So a caller cannot mistake "matched badly" for "did not match". Zero is a legitimate score for an empty
    // query, which is exactly the ambiguity a nullable return removes.
    expect(fuzzyScore("Section plane", "zzz")).toBeNull();
    expect(fuzzyScore("anything", "")).toEqual({ score: 0, hits: [] });
  });

  it("searches the category too", () => {
    // "view fit" should find Fit in the View category — how people narrow when they half-remember where a verb
    // lives. Without this, typing the category name returns nothing, which reads as a broken search.
    const entries: PaletteEntry[] = [
      { id: "a", label: "Fit", category: "View" },
      { id: "b", label: "Fit", category: "Sheet" },
    ];
    expect(rank(entries, "view fit")[0]!.id).toBe("a");
  });

  it("ranks unavailable entries last instead of hiding them", () => {
    // Dim-not-hide, in the palette. Hiding means a user cannot tell "does not exist" from "not right now" — and
    // the palette is where someone goes precisely because they cannot find a thing.
    const entries: PaletteEntry[] = [
      { id: "dim", label: "Delete element", unavailable: "Select an element first" },
      { id: "ok", label: "Delete layer" },
    ];
    const ranked = rank(entries, "delete");
    expect(ranked.map((e) => e.id)).toEqual(["ok", "dim"]);
  });

  it("returns everything, in order, for an empty query", () => {
    const entries: PaletteEntry[] = [{ id: "a", label: "A" }, { id: "b", label: "B" }];
    expect(rank(entries, "  ")).toEqual(entries);
  });
});

describe("CommandPalette", () => {
  const entries: PaletteEntry[] = [
    { id: "fit", label: "Fit", category: "View", chord: "F" },
    { id: "plan", label: "Cut plan", category: "Sheet" },
    { id: "del", label: "Delete element", unavailable: "Select an element first" },
  ];

  const open = (onRun = vi.fn(), onClose = vi.fn()) => {
    const utils = render(<CommandPalette open entries={entries} onRun={onRun} onClose={onClose} />);
    return { ...utils, onRun, onClose, input: screen.getByRole("combobox") as HTMLInputElement };
  };

  it("keeps focus in the input and moves aria-activedescendant", () => {
    // The assertion that decides whether a screen-reader user can use this at all. Moving *focus* to the option
    // is the obvious implementation and it breaks typing entirely; the highlight has to move while focus stays.
    const { input } = open();
    expect(document.activeElement).toBe(input);
    const first = input.getAttribute("aria-activedescendant");
    expect(first).not.toBeNull();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-activedescendant")).not.toBe(first);
  });

  it("points aria-activedescendant at an element that exists", () => {
    // A dangling `aria-activedescendant` is announced as nothing at all, which is indistinguishable from the
    // widget being broken — and it is exactly what happens when the id scheme and the option ids drift.
    const { input } = open();
    const id = input.getAttribute("aria-activedescendant")!;
    expect(document.getElementById(id)).not.toBeNull();
    expect(document.getElementById(id)!.getAttribute("role")).toBe("option");
  });

  it("wraps at both ends", () => {
    // A list that stops at the end makes a user reverse direction to reach the top, which nobody does — they
    // close the palette and reopen it.
    const { input } = open();
    const active = () => screen.getAllByRole("option").findIndex((o) => o.getAttribute("aria-selected") === "true");
    expect(active()).toBe(0);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(active()).toBe(entries.length - 1);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(active()).toBe(0);
  });

  it("runs the highlighted entry on Enter and closes", () => {
    const { input, onRun, onClose } = open();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ id: "fit" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("will not run an unavailable entry", () => {
    // Selectable and inert, exactly like a dimmed ribbon control: focusable so it can be discovered and
    // announced, and doing nothing when invoked.
    const onRun = vi.fn();
    const onClose = vi.fn();
    const { input } = open(onRun, onClose);
    fireEvent.change(input, { target: { value: "delete element" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRun).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("resets the highlight on every keystroke", () => {
    // Keeping the index would leave the highlight on whatever row now happens to sit at position 2, which is
    // never what the user meant by typing another letter.
    const { input } = open();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.change(input, { target: { value: "p" } });
    const options = screen.getAllByRole("option");
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("shows each entry's chord, which is the teaching half", () => {
    open();
    expect(screen.getByText("F").tagName.toLowerCase()).toBe("kbd");
  });

  it("announces an empty result rather than showing a blank list", () => {
    // A sighted user sees an empty list; a screen-reader user hears nothing at all unless it is said.
    const { input } = open();
    fireEvent.change(input, { target: { value: "zzzzz" } });
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("No matches");
  });

  it("closes on Escape and on a backdrop click, but not on a click inside", () => {
    const onClose = vi.fn();
    const { input, container } = open(vi.fn(), onClose);
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(container.querySelector(".mv-palette-backdrop")!);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("renders nothing when closed", () => {
    render(<CommandPalette open={false} entries={entries} onRun={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says how many it is not showing when it caps the list", () => {
    // Silent truncation reads as "the search is broken". Same rule as the file drop limit.
    const many: PaletteEntry[] = Array.from({ length: 40 }, (_, i) => ({ id: `e${i}`, label: `Entry ${i}` }));
    render(<CommandPalette open entries={many} limit={5} onRun={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getAllByRole("option")).toHaveLength(5);
    expect(screen.getByRole("status").textContent).toContain("5 of 40");
  });
});

// ===================================================================================================
// Property grid
// ===================================================================================================

describe("declared against measured", () => {
  it("flags a disagreement beyond the stated tolerance", () => {
    // The real defect this is for: a wall whose type says 300 mm and whose geometry measures 296 mm. Every
    // viewer in this market shows one number, and which one depends on the viewer.
    expect(discrepancyOf({ name: "t", declared: 300, measured: 296, tolerance: 1 })).toEqual({
      kind: "mismatch",
      delta: -4,
    });
    expect(discrepancyOf({ name: "t", declared: 300, measured: 300.5, tolerance: 1 })).toEqual({ kind: "none" });
  });

  it("compares nothing without a tolerance", () => {
    // No tolerance means no comparison, not a zero tolerance. A zero default would flag every float as a
    // mismatch, and a grid that cries wolf is a grid whose warnings get ignored.
    expect(discrepancyOf({ name: "t", declared: 300, measured: 296 })).toEqual({ kind: "none" });
  });

  it("never compares strings", () => {
    // "RC200" against "Reinforced concrete 200mm" is two names for one thing. Flagging it would be a warning
    // that is usually wrong, which trains people to dismiss the ones that are right.
    expect(discrepancyOf({ name: "m", declared: "RC200", measured: "Reinforced concrete 200mm", tolerance: 1 })).toEqual({
      kind: "none",
    });
  });

  const sets: PropertySet[] = [
    {
      name: "Pset_WallCommon",
      properties: [
        { name: "Thickness", declared: 300, measured: 296, tolerance: 1, unit: "mm" },
        { name: "LoadBearing", declared: true },
      ],
    },
    { name: "Pset_QuantityTakeOff", collapsed: true, properties: [{ name: "NetVolume", declared: 4.2, unit: "m3" }] },
  ];

  it("distinguishes 'nothing selected' from 'selected but bare'", () => {
    // Three states, not two. The first is an instruction; the second is information about the model. Collapsing
    // them makes an element with no property sets look like a broken selection.
    const { unmount } = render(<PropertyGrid sets={null} />);
    expect(screen.getByText(/Select an element/)).toBeTruthy();
    unmount();
    render(<PropertyGrid sets={[]} />);
    expect(screen.getByText(/no property sets/)).toBeTruthy();
  });

  it("summarises the disagreements at the top", () => {
    render(<PropertyGrid sets={sets} />);
    expect(screen.getByRole("status").textContent).toContain("1 declared value");
  });

  it("shows the signed delta, not just a warning", () => {
    // "300 declared, 296 measured, −4" is actionable. A warning triangle means the user has to work out what is
    // wrong themselves, from two numbers they then have to find.
    render(<PropertyGrid sets={sets} />);
    expect(screen.getByText("-4 mm")).toBeTruthy();
  });

  it("uses a real table with real headers", () => {
    // A grid of divs is the usual choice and it costs a screen-reader user the ability to know which column a
    // value is in — which, when the columns are "declared" and "measured", is the only thing that matters.
    render(<PropertyGrid sets={sets} />);
    expect(screen.getByRole("columnheader", { name: "Declared" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Measured" })).toBeTruthy();
    expect(screen.getByRole("rowheader", { name: "Thickness" })).toBeTruthy();
  });

  it("honours collapsed, and toggles it", () => {
    render(<PropertyGrid sets={sets} />);
    const toggle = screen.getByRole("button", { name: /Pset_QuantityTakeOff/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("rowheader", { name: "NetVolume" })).toBeTruthy();
  });

  it("commits an edit on blur, not per keystroke", () => {
    // Per-keystroke would send "3", "30", "300" to the kernel as three edits — three entries in the undo stack
    // for one change, and two of them describing a wall 3 mm thick.
    const onEdit = vi.fn();
    render(<PropertyGrid sets={sets} onEdit={onEdit} />);
    const input = screen.getByLabelText("Thickness declared");
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.change(input, { target: { value: "30" } });
    expect(onEdit).not.toHaveBeenCalled();
    fireEvent.blur(input, { target: { value: "305" } });
    expect(onEdit).toHaveBeenCalledExactlyOnceWith("Pset_WallCommon", "Thickness", "305");
  });

  it("shows the GlobalId in full", () => {
    // Someone will paste it into an issue tracker. Truncating it makes that impossible for no gain — it is 22
    // characters, and it is what a BCF topic anchors to.
    const guid = "0aBcDeFgHiJkLmNoPqRsTu";
    render(<PropertyGrid sets={sets} subject={{ label: "Wall-042", ifcClass: "IfcWall", guid }} />);
    expect(screen.getByText(guid)).toBeTruthy();
  });
});

// ===================================================================================================
// Dock
// ===================================================================================================

describe("Dock", () => {
  const panels: DockPanel[] = [
    { id: "tree", title: "Project", side: "left", content: <p>tree</p> },
    { id: "props", title: "Properties", side: "right", content: <p>props</p>, size: 320 },
  ];

  it("renders the centre exactly once and does not move it", () => {
    // The reason this is regions rather than arbitrary docking: moving a `<canvas>` in the DOM loses its WebGL
    // context in some browsers and always costs a full texture re-upload.
    const { container } = render(
      <Dock panels={panels}>
        <canvas id="viewport" />
      </Dock>,
    );
    const canvas = container.querySelector("#viewport")!;
    expect(container.querySelectorAll("#viewport")).toHaveLength(1);
    expect(canvas.parentElement!.className).toBe("mv-dock-centre");

    // Collapsing a panel must not reparent it.
    fireEvent.click(screen.getByRole("button", { name: "Properties" }));
    expect(container.querySelector("#viewport")).toBe(canvas);
  });

  it("keeps a collapsed panel mounted, hidden", () => {
    // Unmounting would throw away scroll position, expanded property sets and any in-progress edit — so
    // collapsing a panel would silently discard work.
    render(
      <Dock panels={panels}>
        <div />
      </Dock>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Properties" }));
    const body = screen.getByText("props").parentElement!;
    expect(body.hasAttribute("hidden")).toBe(true);
    expect(screen.getByText("props")).toBeTruthy(); // still in the tree
  });

  it("exposes each handle as a separator with a value", () => {
    // `role="separator"` with `aria-valuenow` is what makes a resize handle discoverable at all. A handle that
    // only responds to a pointer is a control a keyboard user cannot operate.
    render(
      <Dock panels={panels}>
        <div />
      </Dock>,
    );
    const handle = screen.getByRole("separator", { name: "Resize Properties" });
    expect(handle.getAttribute("aria-valuenow")).toBe("320");
    expect(handle.getAttribute("tabindex")).toBe("0");
  });

  it("resizes from the keyboard, in the right direction per side", () => {
    // The sign flips for the right-hand side: it grows as the pointer (or the arrow key) moves towards the
    // origin. Getting it backwards produces a handle that runs away from the cursor.
    const onLayoutChange = vi.fn();
    render(
      <Dock panels={panels} onLayoutChange={onLayoutChange}>
        <div />
      </Dock>,
    );
    const right = screen.getByRole("separator", { name: "Resize Properties" });
    fireEvent.keyDown(right, { key: "ArrowLeft" });
    expect(Number(right.getAttribute("aria-valuenow"))).toBeGreaterThan(320);

    const left = screen.getByRole("separator", { name: "Resize Project" });
    const was = Number(left.getAttribute("aria-valuenow"));
    fireEvent.keyDown(left, { key: "ArrowLeft" });
    expect(Number(left.getAttribute("aria-valuenow"))).toBeLessThan(was);
  });

  it("will not shrink a panel below its minimum", () => {
    render(
      <Dock panels={[{ id: "p", title: "P", side: "left", content: <div />, size: 150, minSize: 140 }]}>
        <div />
      </Dock>,
    );
    const handle = screen.getByRole("separator");
    for (let i = 0; i < 10; i++) fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(Number(handle.getAttribute("aria-valuenow"))).toBe(140);
  });

  it("reports the layout once per gesture, not per frame", () => {
    const onLayoutChange = vi.fn();
    render(
      <Dock panels={panels} onLayoutChange={onLayoutChange}>
        <div />
      </Dock>,
    );
    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize Project" }), { key: "ArrowRight" });
    expect(onLayoutChange).toHaveBeenCalledTimes(1);
    expect(onLayoutChange.mock.calls[0]![0]).toMatchObject({ sizes: expect.objectContaining({ tree: 292 }) });
  });

  it("restores a saved layout", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    saveLayout(storage, { sizes: { tree: 200, props: 400 }, collapsed: ["props"] });

    const layout = loadLayout(storage)!;
    render(
      <Dock panels={panels} layout={layout}>
        <div />
      </Dock>,
    );
    expect(screen.getByRole("separator", { name: "Resize Project" }).getAttribute("aria-valuenow")).toBe("200");
    expect(screen.getByRole("button", { name: "Properties" }).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("layout persistence", () => {
  const reader = (raw: string | null) => ({ getItem: () => raw });

  it("discards a future version rather than partially reading it", () => {
    // A layout regenerates from defaults in one render, so losing it costs nearly nothing — while reading the
    // fields a newer build wrote and writing them back destroys the rest. Cheap to lose, expensive to get wrong.
    expect(loadLayout(reader(JSON.stringify({ schemaVersion: 99, data: { sizes: {}, collapsed: [] } })))).toBeUndefined();
  });

  it("discards anything that is not a versioned envelope", () => {
    // Including the shape this used to write. Unversioned data is indistinguishable from a future version's data
    // without a heuristic over the contents, which is the thing the envelope exists to avoid needing.
    expect(loadLayout(reader(JSON.stringify({ sizes: { a: 1 }, collapsed: [] })))).toBeUndefined();
    expect(loadLayout(reader(JSON.stringify({ version: 1, layout: { sizes: {}, collapsed: [] } })))).toBeUndefined();
  });

  it("survives corrupt JSON", () => {
    // Throwing here would take down the whole shell over a stored preference.
    expect(loadLayout(reader("{not json"))).toBeUndefined();
    expect(loadLayout(reader(null))).toBeUndefined();
  });

  it("drops one bad size without discarding the layout", () => {
    // One NaN should not cost the user every other panel width they set.
    const raw = JSON.stringify({
      schemaVersion: 1,
      data: { sizes: { good: 300, bad: null, worse: -5 }, collapsed: ["x", 7] },
    });
    expect(loadLayout(reader(raw))).toEqual({ sizes: { good: 300 }, collapsed: ["x"] });
  });

  it("does not throw when storage refuses to write", () => {
    // Private browsing, a full quota, or storage disabled by policy. A preference that cannot be saved is not a
    // reason to interrupt anyone.
    expect(() =>
      saveLayout(
        {
          setItem: () => {
            throw new DOMException("QuotaExceededError");
          },
        },
        { sizes: {}, collapsed: [] },
      ),
    ).not.toThrow();
  });
});

// A no-op reference so `act` is imported for its side effect of registering the test environment flag, which
// React 19 checks before allowing synchronous updates in tests.
void act;
