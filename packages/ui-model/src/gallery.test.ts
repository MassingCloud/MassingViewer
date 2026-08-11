import { describe, expect, it } from "vitest";
import { disciplinesIn, galleryFor, searchGallery, type GalleryEntry } from "./gallery.js";

/**
 * Family galleries.
 *
 * The failure this file is mostly about is the one massing already shipped once. `railToolbox.ts` capped its toolbox
 * at eight, so promoting Push/pull silently demoted Move — *"a dropped tool is invisible… the next person to notice is
 * a user who needed it"*. A gallery over hundreds of families is the same shape with a bigger denominator, so the cap
 * here bounds **display** and the tests assert that nothing is ever dropped from availability.
 */

const entry = (over: Partial<GalleryEntry> & { key: string }): GalleryEntry => ({
  label: over.key,
  category: "General",
  discipline: "Architectural",
  ifcClass: "IfcBuildingElementProxy",
  ...over,
});

/** A library shaped like the real one: several disciplines, uneven categories, some proxy geometry. */
const LIBRARY: readonly GalleryEntry[] = [
  entry({ key: "door-single", label: "Single door", category: "Doors", ifcClass: "IfcDoor" }),
  entry({ key: "door-double", label: "Double door", category: "Doors", ifcClass: "IfcDoor" }),
  entry({ key: "door-sliding", label: "Sliding door", category: "Doors", ifcClass: "IfcDoor" }),
  entry({ key: "door-revolving", label: "Revolving door", category: "Doors", ifcClass: "IfcDoor", geometry: "L200 proxy" }),
  entry({ key: "win-casement", label: "Casement window", category: "Windows", ifcClass: "IfcWindow" }),
  entry({ key: "win-fixed", label: "Fixed window", category: "Windows", ifcClass: "IfcWindow" }),
  entry({ key: "wall-cavity", label: "Cavity wall", category: "Walls", ifcClass: "IfcWall" }),
  entry({ key: "beam-w", label: "W-section beam", category: "Beams", discipline: "Structural", ifcClass: "IfcBeam" }),
  entry({ key: "col-shs", label: "SHS column", category: "Columns", discipline: "Structural", ifcClass: "IfcColumn" }),
  entry({ key: "duct-rect", label: "Rectangular duct", category: "Ducts", discipline: "MEP", ifcClass: "IfcDuctSegment" }),
];

const keysOf = (tiles: readonly { readonly entry: GalleryEntry }[]): string[] => tiles.map((t) => t.entry.key);

describe("what a gallery contains", () => {
  it("never drops an entry, however small the visible cap", () => {
    // The invariant. `visible` bounds the ribbon row; availability is not negotiable.
    for (const visible of [0, 1, 3, 100]) {
      const g = galleryFor(LIBRARY, "Architectural", { visible });
      const all = g.groups.flatMap((group) => keysOf(group.tiles));
      expect(all, `visible=${visible} lost entries`).toHaveLength(7);
      expect(g.total).toBe(7);
      expect(g.promoted.length, `visible=${visible} promoted too many`).toBeLessThanOrEqual(visible);
    }
  });

  it("ignores other disciplines rather than treating them as an error", () => {
    // A caller handing over the whole library and asking for one discipline is the ordinary case.
    const g = galleryFor(LIBRARY, "Structural");
    expect(g.total).toBe(2);
    expect(g.groups.map((group) => group.category)).toEqual(["Beams", "Columns"]);
  });

  it("reports an empty gallery for a discipline it does not have, rather than throwing", () => {
    const g = galleryFor(LIBRARY, "Landscape");
    expect(g.total).toBe(0);
    expect(g.groups).toEqual([]);
    expect(g.promoted).toEqual([]);
  });

  it("marks proxy geometry so a tile can say so", () => {
    /**
     * The library is explicit that some families are L200 placeholders. A user who places one expecting a detailed
     * component and gets a box has been misled by the tool, not by the library — so the grading reaches the tile.
     */
    const g = galleryFor(LIBRARY, "Architectural", { visible: 100 });
    const tiles = g.groups.flatMap((group) => group.tiles);
    expect(tiles.find((t) => t.entry.key === "door-revolving")!.proxy).toBe(true);
    expect(tiles.find((t) => t.entry.key === "door-single")!.proxy).toBe(false);
  });
});

describe("which tiles reach the ribbon", () => {
  it("shows breadth before depth — one per category before a second from any", () => {
    /**
     * The judgement worth pinning. "The first six alphabetically" on a real library means six tiles from whichever
     * category sorts first and a flyout for everything else, which tells a user nothing about what the discipline can
     * place. Round-robin makes the row a summary of *kinds*.
     */
    const g = galleryFor(LIBRARY, "Architectural", { visible: 3 });
    const categories = g.promoted.map((t) => t.entry.category);
    expect(new Set(categories).size, `only ${new Set(categories).size} categories in ${categories.join(", ")}`).toBe(3);
  });

  it("honours a host's preferred keys first, in order", () => {
    // Usage data belongs to the host: this package cannot know what a given office places most.
    const g = galleryFor(LIBRARY, "Architectural", { visible: 3, preferred: ["win-fixed", "door-double"] });
    expect(keysOf(g.promoted).slice(0, 2)).toEqual(["win-fixed", "door-double"]);
  });

  it("ignores an unknown preferred key instead of reserving an empty slot", () => {
    // A host's saved preferences outlive any one library version, so a key that no longer exists is expected input.
    const g = galleryFor(LIBRARY, "Architectural", { visible: 2, preferred: ["nope", "door-double"] });
    expect(keysOf(g.promoted)[0]).toBe("door-double");
    expect(g.promoted).toHaveLength(2);
  });

  it("promotes no entry twice", () => {
    // A preferred key is also in its category queue, so the round-robin has to know it is already taken.
    const g = galleryFor(LIBRARY, "Architectural", { visible: 5, preferred: ["door-single"] });
    const keys = keysOf(g.promoted);
    expect(new Set(keys).size, `duplicates in ${keys.join(", ")}`).toBe(keys.length);
  });

  it("is deterministic, so a ribbon does not reshuffle between renders", () => {
    const a = keysOf(galleryFor(LIBRARY, "Architectural", { visible: 4 }).promoted);
    const b = keysOf(galleryFor([...LIBRARY].reverse(), "Architectural", { visible: 4 }).promoted);
    expect(b).toEqual(a);
  });
});

describe("finding a family to place", () => {
  it("ranks a label match above a metadata match", () => {
    // A user typing "door" wants the door families. `IfcDoor` on a hardware family is a weaker signal than a label.
    const results = searchGallery(LIBRARY, "door");
    expect(results[0]!.category).toBe("Doors");
    expect(results.map((r) => r.key)).toContain("door-sliding");
  });

  it("puts an exact label ahead of a prefix, and a prefix ahead of a substring", () => {
    /**
     * The labels are chosen so alphabetical order **disagrees** with the ranking.
     *
     * The first version of this test used "Door", "Doorset, double" and "Sliding door bottom track", where sorting by
     * label alone already produces the expected answer — so deleting the ranking entirely left it green. A ranking
     * test whose fixture is already in ranked order tests nothing.
     */
    const ranked = searchGallery(
      [
        entry({ key: "a", label: "Automatic sliding door" }), // substring
        entry({ key: "b", label: "Door" }), // exact
        entry({ key: "c", label: "Doorset, double" }), // prefix
      ],
      "door",
    ).map((r) => r.key);
    expect(ranked, "alphabetical would give a, b, c").toEqual(["b", "c", "a"]);
  });

  it("finds by IFC class, so IfcDoor and Doors both work", () => {
    expect(searchGallery(LIBRARY, "IfcDuctSegment").map((r) => r.key)).toEqual(["duct-rect"]);
  });

  it("returns nothing for an empty query rather than everything", () => {
    // An empty search box means "no filter yet", not "show me all four hundred families".
    expect(searchGallery(LIBRARY, "")).toEqual([]);
    expect(searchGallery(LIBRARY, "   ")).toEqual([]);
  });

  it("can be scoped to one discipline, and is not by default", () => {
    expect(searchGallery(LIBRARY, "column").map((r) => r.key)).toEqual(["col-shs"]);
    expect(searchGallery(LIBRARY, "door", { discipline: "Structural" })).toEqual([]);
  });

  it("honours a limit, because a flyout has a height", () => {
    expect(searchGallery(LIBRARY, "door", { limit: 2 })).toHaveLength(2);
  });
});

describe("the discipline strip", () => {
  it("lists each discipline once, in a stable order", () => {
    expect(disciplinesIn(LIBRARY)).toEqual(["Architectural", "MEP", "Structural"]);
    expect(disciplinesIn([...LIBRARY].reverse())).toEqual(["Architectural", "MEP", "Structural"]);
  });
});
