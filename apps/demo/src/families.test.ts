// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { mountFamilies, type FamiliesDeps } from "./families.js";

/**
 * The family gallery's host-side behaviour.
 *
 * The layout itself is `@massing/ui-model`'s and tested there. What is worth asserting *here* is the part that only
 * exists in the host: a library is **third-party content**, and this panel builds its markup with `innerHTML`.
 */

const hostile = {
  name: "hostile",
  version: "1",
  license: "MIT",
  packs: [
    {
      file: "x.ifc",
      discipline: "Arch<img src=x onerror=alert(1)>",
      index: [
        {
          key: "evil",
          label: `</span><script>alert(1)</script>`,
          category: `Doors"><script>alert(2)</script>`,
          ifc_class: "IfcWall",
        },
      ],
    },
  ],
};

function mount(over: Partial<FamiliesDeps> = {}) {
  const panel = document.createElement("div");
  const canvas = document.createElement("canvas");
  document.body.append(panel, canvas);
  const status = vi.fn();
  const gallery = mountFamilies({
    panel,
    canvas,
    camera: {},
    supports: () => true,
    place: async () => null,
    status,
    ...over,
  });
  return { panel, canvas, status, gallery };
}

describe("a library is third-party content", () => {
  it("escapes a label, a category and a discipline rather than executing them", () => {
    /**
     * `sanitizeSvg` and the escaping in `svg.ts` exist because IFC arrives from consultants and subs. A family
     * library is the same shape of input — a pack a user installs, or an index served by whatever authoring service
     * they connected to — and this panel is built by string concatenation, so it is the same path.
     *
     * The fixture shipped in `families.ts` is ours and contains nothing dangerous, which is precisely why this is
     * easy to forget and worth pinning.
     */
    const { panel } = mount({ library: hostile });

    expect(panel.querySelector("script"), "a script element was constructed from library content").toBeNull();
    expect(panel.querySelector("img"), "an img element was constructed from library content").toBeNull();
    // The text still reaches the user — escaped, not dropped. A family whose name contains an angle bracket should
    // still be findable rather than silently missing from the gallery.
    expect(panel.textContent).toContain("alert(1)");
    expect(panel.querySelectorAll(".fam-tile").length).toBeGreaterThan(0);
  });

  it("reports a malformed library instead of rendering an empty gallery", () => {
    // `parseLibrary` refuses with a JSON path. Showing it beats a blank panel, which reads as "no families exist".
    const { panel } = mount({ library: { name: "no packs here" } });
    expect(panel.textContent ?? "").toContain("packs");
    expect(panel.querySelectorAll(".fam-tile")).toHaveLength(0);
  });
});

describe("what the panel says about placement", () => {
  it("dims an entry no operation can place, and names the reason", () => {
    const { panel } = mount();
    const dimmed = [...panel.querySelectorAll<HTMLElement>('.fam-tile[aria-disabled="true"]')];
    expect(dimmed.length, "nothing is dimmed, so availability is not being shown").toBeGreaterThan(0);
    for (const tile of dimmed) {
      expect((tile.getAttribute("title") ?? "").length, "a dimmed tile carries no reason").toBeGreaterThan(20);
    }
  });

  it("dims everything when the kernel supports nothing, rather than hiding the library", () => {
    // The house rule, at its limit. A viewer with no authoring kernel should still show what exists and what it
    // would take — a gallery that emptied itself would read as "this product has no families".
    const { panel } = mount({ supports: () => false });
    const tiles = panel.querySelectorAll(".fam-tile");
    const dimmed = panel.querySelectorAll('.fam-tile[aria-disabled="true"]');
    expect(tiles.length).toBeGreaterThan(0);
    expect(dimmed.length).toBe(tiles.length);
  });

  it("does not make an unplaceable tile draggable", () => {
    // Dragging something that can only be refused on drop is a promise the drop cannot keep.
    const { panel } = mount();
    for (const tile of panel.querySelectorAll<HTMLElement>('.fam-tile[aria-disabled="true"]')) {
      expect(tile.getAttribute("draggable")).toBe("false");
    }
  });

  it("unbinds its canvas listeners on dispose", () => {
    /**
     * Asserted on `removeEventListener`, not by dispatching a drop.
     *
     * The obvious test — dispose, then dispatch a synthetic `drop` and expect nothing to happen — passes whether or
     * not `dispose` unbinds anything, because happy-dom's `DataTransfer.getData` returns `undefined`: the handler
     * takes its early return and never reaches the code under test. Verified rather than assumed, and the drop path
     * itself is covered in the E2E suite where a real `DataTransfer` exists.
     *
     * The leak is real: the canvas outlives the panel, so a second mount over it would place two elements per drop.
     */
    const { canvas, gallery } = mount();
    const spy = vi.spyOn(canvas, "removeEventListener");
    gallery.dispose();
    const removed = spy.mock.calls.map((c) => String(c[0]));
    expect(removed, "the drop listener was left on the canvas").toContain("drop");
    expect(removed, "the dragover listener was left on the canvas").toContain("dragover");
  });
});
