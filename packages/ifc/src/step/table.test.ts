import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EntityTable } from "./table.js";
import { StepSyntaxError } from "./parse.js";
import { integer, real, str } from "./value.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures/sample.ifc");
const sample = readFileSync(FIXTURE, "utf8");

/** Known contents of `fixtures/sample.ifc`, asserted so a fixture change is a visible failure. */
const WALL_SOUTH = { id: 35, guid: "OwCSTfxILZZaOeUwK4fcAk" };
const SLAB_GROUND = 119;

/**
 * How many entities the fixture actually declares, counted from the file.
 *
 * Derived rather than written as a literal, and that is a lesson learned three times over in this repository. It
 * used to read `toBe(136)`; adding a property set to the fixture made it 143, and three tests then failed
 * reporting that **the parser had stopped finding entities** when the parser was perfectly correct and the file
 * had simply grown. A literal tests the number someone typed last time; this tests the property that matters —
 * the table finds every entity the file declares.
 */
const DECLARED = (sample.match(/^#\d+=/gm) ?? []).length;

describe("EntityTable — parsing the real fixture", () => {
  it("finds every entity and reports the schema", () => {
    const t = EntityTable.parse(sample);
    expect(t.schema).toBe("IFC4");
    expect(t.size).toBe(DECLARED);
    // File order, not sorted order — the emit path depends on it.
    expect(t.ids().slice(0, 3)).toEqual([1, 2, 3]);
  });

  it("resolves classes and GlobalIds without a schema", () => {
    const t = EntityTable.parse(sample);
    expect(t.typeOf(WALL_SOUTH.id)).toBe("IFCWALL");
    expect(t.guidOf(WALL_SOUTH.id)).toBe(WALL_SOUTH.guid);
    expect(t.typeOf(SLAB_GROUND)).toBe("IFCSLAB");
    expect(t.byType("IfcWall")).toEqual([35, 48, 61, 74]);
  });

  it("indexes GlobalId → expressID in both directions", () => {
    const t = EntityTable.parse(sample);
    expect(t.idOfGuid(WALL_SOUTH.guid)).toBe(WALL_SOUTH.id);
    expect(t.idOfGuid("nOtArEaLgUiDnOtArEaL0")).toBeUndefined();
  });

  it("returns null for entities that are not rooted, rather than inventing a GlobalId", () => {
    const t = EntityTable.parse(sample);
    // IfcCartesianPoint's first attribute is a coordinate list, not a GlobalId.
    const point = t.byType("IFCCARTESIANPOINT")[0]!;
    expect(t.guidOf(point)).toBeNull();
  });

  it("parses attribute lists lazily but correctly", () => {
    const t = EntityTable.parse(sample);
    const params = t.params(WALL_SOUTH.id);
    expect(params[0]).toEqual({ k: "str", v: WALL_SOUTH.guid });
    // Attribute 2 is Name. The fixture names its walls.
    expect(params[2]).toEqual({ k: "str", v: "Wall-South" });
  });

  it("refuses to hand out a mutable view of its cache", () => {
    const t = EntityTable.parse(sample);
    const params = t.params(WALL_SOUTH.id) as unknown[];
    // A caller mutating this would change what every reader sees while emit() still wrote the original text.
    expect(() => {
      params[2] = str("Renamed");
    }).toThrow(TypeError);
  });
});

describe("EntityTable — byte preservation", () => {
  it("a clean table emits the source character for character", () => {
    const t = EntityTable.parse(sample);
    expect(t.dirty).toBe(false);
    expect(t.emit()).toBe(sample);
  });

  it("reading every attribute list does not make it dirty", () => {
    // Parsing must be a pure read. If touching an entity marked it dirty, a viewer that inspects properties
    // would start rewriting files it only looked at.
    const t = EntityTable.parse(sample);
    for (const id of t.ids()) {
      if (t.typeOf(id) !== "") {
        try {
          t.params(id);
        } catch {
          /* complex instances have no attribute list; the fixture has none, but do not depend on that */
        }
      }
    }
    expect(t.dirty).toBe(false);
    expect(t.emit()).toBe(sample);
  });

  it("editing one entity changes exactly one line", () => {
    const t = EntityTable.parse(sample);
    t.setParam(WALL_SOUTH.id, 2, str("Wall-South-Renamed"));

    const before = sample.split("\n");
    const after = t.emit().split("\n");
    expect(after).toHaveLength(before.length);

    const changed = before.map((l, i) => (l === after[i] ? null : i)).filter((i) => i !== null);
    expect(changed, "exactly one line should differ").toHaveLength(1);
    expect(after[changed[0]!]).toContain("Wall-South-Renamed");
    // And the rest of the file is genuinely untouched, including the header timestamp and the trailing marker.
    expect(t.emit()).toContain("END-ISO-10303-21;");
  });

  it("the edit round-trips: re-parsing the output sees the new value", () => {
    const t = EntityTable.parse(sample);
    t.setParam(WALL_SOUTH.id, 2, str("Wall-South-Renamed"));
    const reparsed = EntityTable.parse(t.emit());
    expect(reparsed.params(WALL_SOUTH.id)[2]).toEqual({ k: "str", v: "Wall-South-Renamed" });
    // The GlobalId is untouched by an unrelated edit. This is the invariant everything downstream rests on.
    expect(reparsed.guidOf(WALL_SOUTH.id)).toBe(WALL_SOUTH.guid);
    expect(reparsed.size).toBe(DECLARED);
  });

  it("appends before the DATA section's ENDSEC, keeping the file valid", () => {
    const t = EntityTable.parse(sample);
    const id = t.add("IfcPropertySingleValue", [str("Added"), { k: "unset" }, integer(7), { k: "unset" }]);
    // The next free id, whatever the fixture's size is — an append must not reuse or skip.
    expect(id).toBe(DECLARED + 1);

    const out = t.emit();
    expect(out.indexOf(`#${id}=`)).toBeLessThan(out.lastIndexOf("ENDSEC;"));
    expect(out.endsWith("END-ISO-10303-21;\n")).toBe(true);

    const reparsed = EntityTable.parse(out);
    expect(reparsed.size).toBe(DECLARED + 1);
    expect(reparsed.typeOf(id)).toBe("IFCPROPERTYSINGLEVALUE");
    expect(reparsed.byType("IFCPROPERTYSINGLEVALUE")).toContain(id);
  });

  it("removing an entity leaves no blank line and no other change", () => {
    const t = EntityTable.parse(sample);
    const victim = t.byType("IFCPROPERTYSINGLEVALUE")[0] ?? t.byType("IFCCARTESIANPOINT").at(-1)!;
    t.remove(victim);

    const out = t.emit();
    expect(out.split("\n")).toHaveLength(sample.split("\n").length - 1);
    expect(out).not.toContain(`#${victim}=`);
    expect(EntityTable.parse(out).has(victim)).toBe(false);
  });

  it("never reuses an id, even after a removal", () => {
    // A reused id is indistinguishable from the removed entity to anything holding a stale reference, and an
    // undo stack is made of stale references.
    const t = EntityTable.parse(sample);
    const first = t.add("IfcLabel", [str("a")]);
    t.remove(first);
    const second = t.add("IfcLabel", [str("b")]);
    expect(second).toBeGreaterThan(first);
  });

  it("an appended entity can itself be edited and removed", () => {
    const t = EntityTable.parse(sample);
    const id = t.add("IfcPropertySingleValue", [str("Draft"), { k: "unset" }, integer(1), { k: "unset" }]);
    t.setParam(id, 0, str("Final"));
    expect(EntityTable.parse(t.emit()).params(id)[0]).toEqual({ k: "str", v: "Final" });

    t.remove(id);
    expect(t.emit()).toBe(sample);
    expect(t.dirty).toBe(false);
  });
});

describe("EntityTable — refusals", () => {
  it("rejects a duplicate expressID instead of keeping the last one", () => {
    // Two entities claiming one identity makes every reference to it ambiguous, and the symptom is a viewer
    // drawing a wall the schedule calls a door.
    const src = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=IFCLABEL('a');\n#1=IFCLABEL('b');\nENDSEC;\nEND-ISO-10303-21;\n";
    expect(() => EntityTable.parse(src)).toThrow(/#1 is defined more than once/);
  });

  it("names the offset when the syntax is broken", () => {
    expect(() => EntityTable.parse("DATA;\n#1=IFCLABEL('unterminated);\nENDSEC;")).toThrow(StepSyntaxError);
  });

  it("refuses to append when there is no DATA section to append into", () => {
    const t = EntityTable.parse("ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n");
    t.add("IfcLabel", [str("x")]);
    expect(() => t.emit()).toThrow(/no DATA section/);
  });

  it("reports an out-of-range attribute index with the entity's actual arity", () => {
    const t = EntityTable.parse(sample);
    expect(() => t.setParam(WALL_SOUTH.id, 99, str("x"))).toThrow(/attributes; no index 99/);
  });

  it("a removed entity is gone from every accessor, not just from emit", () => {
    const t = EntityTable.parse(sample);
    const victim = t.byType("IFCCARTESIANPOINT").at(-1)!;
    t.remove(victim);
    expect(t.has(victim)).toBe(false);
    expect(t.typeOf(victim)).toBeUndefined();
    expect(t.ids()).not.toContain(victim);
    expect(t.byType("IFCCARTESIANPOINT")).not.toContain(victim);
    expect(() => t.params(victim)).toThrow(/not in this table/);
  });
});

describe("STEP grammar corners that real files contain", () => {
  const wrap = (body: string): string =>
    `ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n${body}\nENDSEC;\nEND-ISO-10303-21;\n`;

  it("a semicolon inside a header string does not split the statement", () => {
    // FILE_DESCRIPTION((''),'2;1') is in essentially every IFC file, and a line-oriented scan mis-parses it.
    const src = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCLABEL('x');\nENDSEC;\nEND-ISO-10303-21;\n`;
    const t = EntityTable.parse(src);
    expect(t.schema).toBe("IFC4");
    expect(t.ids()).toEqual([1]);
    expect(t.emit()).toBe(src);
  });

  it("distinguishes $ from * — absent is not derived", () => {
    const t = EntityTable.parse(wrap("#1=IFCTEST($,*);"));
    expect(t.params(1)).toEqual([{ k: "unset" }, { k: "derived" }]);
    // Emitting one as the other is accepted by lenient readers and rejected by strict ones.
    t.setParams(1, t.params(1));
    expect(t.emit()).toContain("#1=IFCTEST($,*);");
  });

  it("keeps a REAL a REAL when rewriting", () => {
    // `3` is an INTEGER and `3.` is a REAL. Re-serialising from the JS number alone silently corrupts every
    // real-valued attribute in the file.
    const t = EntityTable.parse(wrap("#1=IFCTEST(3.,3);"));
    expect(t.params(1)).toEqual([
      { k: "num", v: 3, raw: "3." },
      { k: "num", v: 3, raw: "3" },
    ]);
    t.setParams(1, t.params(1));
    expect(t.emit()).toContain("#1=IFCTEST(3.,3);");
    expect(t.emit()).not.toContain("IFCTEST(3,3)");
  });

  it("round-trips nested lists, typed values, enums and refs", () => {
    const t = EntityTable.parse(wrap("#1=IFCTEST((#2,#3),IFCINTEGER(4),.ELEMENT.,((1.,2.),(3.,4.)));"));
    const p = t.params(1);
    expect(p[0]).toEqual({ k: "list", v: [{ k: "ref", v: 2 }, { k: "ref", v: 3 }] });
    expect(p[1]).toEqual({ k: "typed", t: "IFCINTEGER", v: [{ k: "num", v: 4, raw: "4" }] });
    expect(p[2]).toEqual({ k: "enum", v: "ELEMENT" });
    t.setParams(1, p);
    expect(t.emit()).toContain("#1=IFCTEST((#2,#3),IFCINTEGER(4),.ELEMENT.,((1.,2.),(3.,4.)));");
  });

  it("skips comments wherever they appear", () => {
    const t = EntityTable.parse(wrap("/* leading */\n#1=IFCTEST(/* mid */1,2);"));
    expect(t.params(1)).toHaveLength(2);
  });

  it("handles a multi-line entity", () => {
    const src = wrap("#1=IFCTEST(\n  'a',\n  'b'\n);");
    const t = EntityTable.parse(src);
    expect(t.params(1)).toHaveLength(2);
    expect(t.emit()).toBe(src);
    // Editing normalises *this* entity onto one line, and only this one. That is the intended scope of the
    // damage: you edited it, so its statement is rewritten.
    t.setParam(1, 0, str("c"));
    expect(t.emit()).toContain("#1=IFCTEST('c','b');");
  });

  it("preserves an unparsed complex instance and counts its id", () => {
    // Nothing here understands `#1=(A(1)B(2));`, and nothing needs to — but if the scanner skipped it, a
    // later add() could hand out #1 again.
    const src = wrap("#1=(IFCA(1)IFCB(2));\n#2=IFCTEST('x');");
    const t = EntityTable.parse(src);
    expect(t.ids()).toEqual([1, 2]);
    expect(t.typeOf(1)).toBe("");
    expect(() => t.params(1)).toThrow(/complex instance/);
    expect(t.add("IfcLabel", [str("y")])).toBe(3);
  });

  it("escapes and recovers non-ASCII text", () => {
    const t = EntityTable.parse(wrap("#1=IFCTEST('x');"));
    t.setParam(1, 0, str("Büro — 3′"));
    const emitted = t.emit();
    // STEP's data section is 7-bit; a raw UTF-8 byte here is mangled by some readers and rejected by others.
    expect(emitted).toMatch(/\\X2\\[0-9A-F]+\\X0\\/);
    expect([...emitted].filter((c) => c.codePointAt(0)! > 0x7e), "output must be 7-bit").toEqual([]);
    expect(EntityTable.parse(emitted).params(1)[0]).toEqual({ k: "str", v: "Büro — 3′" });
  });

  it("round-trips an embedded apostrophe", () => {
    const t = EntityTable.parse(wrap("#1=IFCTEST('x');"));
    t.setParam(1, 0, str("Level 1's slab"));
    expect(t.emit()).toContain("'Level 1''s slab'");
    expect(EntityTable.parse(t.emit()).params(1)[0]).toEqual({ k: "str", v: "Level 1's slab" });
  });

  it("emits a whole number as a REAL when asked for one", () => {
    expect(real(3).raw).toBe("3.");
    expect(real(0.5).raw).toBe("0.5");
    expect(real(-2).raw).toBe("-2.");
    expect(integer(3).raw).toBe("3");
    expect(() => real(Number.NaN)).toThrow(RangeError);
    expect(() => integer(1.5)).toThrow(RangeError);
  });
});
