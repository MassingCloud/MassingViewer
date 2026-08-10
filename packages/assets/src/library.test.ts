import { describe, expect, it } from "vitest";
import { byDisciplineAndCategory, entries, parseLibrary, proxies, search } from "./library.js";

/**
 * The fixture is shaped like the **real** document, `snake_case` and all.
 *
 * Modelled on `_family_index()` in massing-families' `src/massing_families/pack.py` rather than on what would be
 * convenient to assert. A parser tested against a tidied-up fixture passes and then fails on first contact, which is
 * the failure this repository keeps writing gates against.
 */
const DOCUMENT = {
  name: "Massing Family Library",
  version: "1.4.0",
  // Extra top-level keys the upstream library really emits, present so the parser is proven to ignore them rather
  // than merely assumed to.
  categories: ["Doors", "Beams"],
  disciplines: ["architectural", "structural"],
  tiers: ["L200", "L300"],
  licensing: {
    content: "CC0-1.0",
    content_licenses: ["CC0-1.0"],
    code: "MIT",
    attribution: "massing-families (https://github.com/MassingCloud/massing-families)",
    url: "https://github.com/MassingCloud/massing-families/blob/main/LICENSE-CONTENT",
  },
  packs: [
    {
      file: "architectural-doors.ifc",
      discipline: "architectural",
      ifc_schema: "IFC4",
      size_bytes: 41234,
      families: 2,
      index: [
        {
          key: "door_single_flush",
          label: "Single Flush Door",
          category: "Doors",
          discipline: "architectural",
          ifc_class: "IfcDoor",
          predefined: "DOOR",
          tier: "L300",
          geometry: "solid",
          classification: "EF_25_10",
          license: "CC0-1.0",
          massing_key: "door.single",
          has_ports: false,
        },
        {
          // No label, no licence, no discipline — each exercises a different fallback.
          key: "door_double_flush",
          category: "Doors",
          ifc_class: "IfcDoor",
          predefined: null,
          tier: "L200",
          geometry: "L200 proxy",
          classification: null,
          massing_key: null,
          has_ports: false,
        },
      ],
    },
    {
      file: "structural-steel-w.ifc",
      discipline: "structural",
      ifc_schema: "IFC4",
      size_bytes: 903112,
      index: [
        {
          key: "beam_w_w12x26",
          label: "W12X26",
          category: "Beams",
          discipline: "structural",
          ifc_class: "IfcBeam",
          predefined: "BEAM",
          tier: "L300",
          geometry: "solid",
          classification: "EF_20_10",
          license: "CC0-1.0",
          massing_key: null,
          has_ports: false,
        },
      ],
    },
  ],
};

const parsed = () => {
  const result = parseLibrary(DOCUMENT);
  if (!result.ok) throw new Error(`fixture should parse: ${result.why.message}`);
  return result.library;
};

describe("parseLibrary", () => {
  it("reads the library, its content licence and its packs", () => {
    const library = parsed();
    expect(library.name).toBe("Massing Family Library");
    expect(library.version).toBe("1.4.0");
    // The *content* licence, not the toolchain's MIT — that is what a consumer shelving IFC packs cares about.
    expect(library.license).toBe("CC0-1.0");
    expect(library.attribution).toContain("massing-families");
    expect(library.packs).toHaveLength(2);
    expect(library.packs[0]!.ifcSchema).toBe("IFC4");
    expect(library.packs[1]!.sizeBytes).toBe(903112);
  });

  it("maps snake_case to camelCase in one place", () => {
    const [door] = parsed().packs[0]!.entries;
    expect(door!.ifcClass).toBe("IfcDoor");
    expect(door!.massingKey).toBe("door.single");
    expect(door!.hasPorts).toBe(false);
  });

  it("falls back to the key when a family has no label, rather than hiding it", () => {
    // A missing label is a content bug. Rendering the key makes it obvious; dropping the family makes it invisible.
    const second = parsed().packs[0]!.entries[1]!;
    expect(second.label).toBe("door_double_flush");
  });

  it("inherits the licence from the library when an entry omits it", () => {
    // This string follows the object into any model that imports it, so a blank one is worse than an inherited one.
    expect(parsed().packs[0]!.entries[1]!.license).toBe("CC0-1.0");
  });

  it("inherits discipline from the pack when an entry omits it", () => {
    expect(parsed().packs[0]!.entries[1]!.discipline).toBe("architectural");
  });

  it("defaults an absent category rather than failing", () => {
    const result = parseLibrary({
      packs: [{ file: "a.ifc", discipline: "d", index: [{ key: "k", ifc_class: "IfcWall" }] }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.library.packs[0]!.entries[0]!.category).toBe("Uncategorised");
  });

  it("tolerates a pack with no index at all", () => {
    // "Not indexed yet" is a legal state upstream, and refusing it would make a partially-built library unusable.
    const result = parseLibrary({ packs: [{ file: "a.ifc", discipline: "d" }] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.library.packs[0]!.entries).toEqual([]);
  });
});

describe("parseLibrary refusals", () => {
  it("refuses a document that is not an object, and says where", () => {
    for (const bad of [null, 42, "x", ["packs"]]) {
      const result = parseLibrary(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.why.code).toBe("not_an_object");
        expect(result.why.at).toBe("$");
      }
    }
  });

  it("refuses an empty library with a message that names the likely mistake", () => {
    const result = parseLibrary({ name: "x", packs: [] });
    expect(result.ok).toBe(false);
    // Handing a single pack to the index parser is the obvious error, so the message says so rather than just "no".
    if (!result.ok) expect(result.why.message).toContain("single pack");
  });

  it("refuses a pack missing file or discipline, pointing at the index", () => {
    const result = parseLibrary({ packs: [{ file: "a.ifc" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.why.code).toBe("malformed_pack");
      expect(result.why.at).toBe("$.packs[0]");
    }
  });

  it("refuses an entry with no key or no ifc_class, and locates it exactly", () => {
    // At 2,769 types a refusal without a path is a refusal nobody can act on.
    const result = parseLibrary({
      packs: [
        { file: "a.ifc", discipline: "d", index: [{ key: "ok", ifc_class: "IfcWall" }, { key: "no_class" }] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.why.code).toBe("malformed_entry");
      expect(result.why.at).toBe("$.packs[0].index[1]");
    }
  });

  it("refuses an index that is present but not an array", () => {
    const result = parseLibrary({ packs: [{ file: "a.ifc", discipline: "d", index: { key: "k" } }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.why.at).toBe("$.packs[0].index");
  });
});

describe("queries", () => {
  it("flattens every entry across every pack", () => {
    expect(entries(parsed()).map((e) => e.key)).toEqual([
      "door_single_flush",
      "door_double_flush",
      "beam_w_w12x26",
    ]);
  });

  it("groups by discipline then category, preserving the library's own order", () => {
    // Not sorted. The upstream packs are already discipline-ordered, and re-sorting in the UI is how a gallery ends
    // up disagreeing with the documentation the content ships with.
    const grouped = byDisciplineAndCategory(parsed());
    expect([...grouped.keys()]).toEqual(["architectural", "structural"]);
    expect([...grouped.get("architectural")!.keys()]).toEqual(["Doors"]);
    expect(grouped.get("architectural")!.get("Doors")).toHaveLength(2);
    expect(grouped.get("structural")!.get("Beams")).toHaveLength(1);
  });

  it("searches label, key and classification, case-insensitively", () => {
    const library = parsed();
    expect(search(library, "single flush").map((e) => e.key)).toEqual(["door_single_flush"]);
    // By key, which is what someone who knows the library types.
    expect(search(library, "W12X26").map((e) => e.key)).toEqual(["beam_w_w12x26"]);
    expect(search(library, "w12x26").map((e) => e.key)).toEqual(["beam_w_w12x26"]);
    // By classification, because a specifier searching `EF_20_10` is searching for exactly that.
    expect(search(library, "EF_20_10").map((e) => e.key)).toEqual(["beam_w_w12x26"]);
  });

  it("returns everything for an empty or whitespace query", () => {
    // A filter that empties the gallery when the box is cleared is the bug people report as "the families vanished".
    expect(search(parsed(), "")).toHaveLength(3);
    expect(search(parsed(), "   ")).toHaveLength(3);
  });

  it("finds nothing rather than guessing", () => {
    // Deliberately not fuzzy: at 2,769 types, surfacing a door when someone typed a beam size is worse than no hit.
    expect(search(parsed(), "escalator")).toEqual([]);
  });

  it("reports the families the library itself calls proxies", () => {
    // The upstream README is explicit that some families are still L200 proxies. A gallery that presents those as
    // finished geometry is making a claim the content does not.
    expect(proxies(parsed()).map((e) => e.key)).toEqual(["door_double_flush"]);
  });
});
