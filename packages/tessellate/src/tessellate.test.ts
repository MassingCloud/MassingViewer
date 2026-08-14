import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tessellate } from "./index.js";

/**
 * The two behaviours that were lost in a copy.
 *
 * This package exists because `apps/demo` and `apps/shell` each had their own tessellator, and the shell's had
 * drifted: no `refDirection`, so a rotated wall drew unrotated; no `IfcRelVoidsElement`, so a wall with a door
 * drew solid. Neither threw, neither logged, and both had shipped. Merging the two copies without pinning what
 * distinguished them would leave nothing to stop the next merge picking the wrong one.
 *
 * So these are not tests of "does tessellation work" — `fixtures/scale.test.ts` and the E2E suite cover that.
 * They are tests of exactly the two facts that were silently absent.
 */

const SAMPLE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/sample.ifc"), "utf8");

/** The x/z extent of everything tessellated — sensitive to rotation, insensitive to vertex ordering. */
function footprint(ifc: string): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const mesh of tessellate(ifc).meshes) {
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i]!;
      const z = mesh.positions[i + 2]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  return { minX, maxX, minZ, maxZ };
}

describe("the placement's rotation", () => {
  it("moves the geometry, rather than being read and discarded", () => {
    /**
     * `refDirection` is `IFCAXIS2PLACEMENT3D`'s third argument, and the fixture leaves it `$` throughout — so
     * the rotation path is unreachable on the file as committed, which is exactly how a renderer can drop it
     * and still look right. Supplying one is what makes the assertion mean something.
     *
     * A footprint comparison rather than a vertex-by-vertex one: the claim is "the model turned", and asserting
     * individual coordinates would pin the axis convention as well, which is a different fact and one that
     * `fixtures/scale.test.ts` has bounds assertions for.
     */
    const rotated = SAMPLE.replace(/IFCAXIS2PLACEMENT3D\((#\d+),\$,\$\)/g, "IFCAXIS2PLACEMENT3D($1,$,#9001)").replace(
      /ENDSEC;\s*END-ISO-10303-21;/,
      "#9001= IFCDIRECTION((0.,1.,0.));\nENDSEC;\nEND-ISO-10303-21;",
    );

    // The substitution has to have applied, or the test passes by comparing a file with itself.
    expect(rotated, "no placement was given a refDirection, so this asserts nothing").toContain("#9001");
    expect(rotated).not.toEqual(SAMPLE);

    const before = footprint(SAMPLE);
    const after = footprint(rotated);
    expect(before.minX).toBeLessThan(before.maxX);
    expect(
      after,
      "a quarter turn on every placement left the footprint identical, so refDirection is being ignored",
    ).not.toEqual(before);
  });
});

describe("openings", () => {
  it("splits a voided element into bands instead of drawing it solid", () => {
    /**
     * `fixtures/sample.ifc` carries `IfcRelVoidsElement`, and a wall with a door becomes jambs and a lintel —
     * several meshes for one expressID. That is the observable difference between subtracting an opening and
     * ignoring it, and it is what the Model panel's element count reflects.
     */
    const { meshes } = tessellate(SAMPLE);
    const perElement = new Map<number, number>();
    for (const mesh of meshes) perElement.set(mesh.expressId, (perElement.get(mesh.expressId) ?? 0) + 1);

    const banded = [...perElement.entries()].filter(([, count]) => count > 1);
    expect(
      banded.length,
      `no element produced more than one mesh, so openings are not being subtracted (${meshes.length} meshes over ${perElement.size} elements)`,
    ).toBeGreaterThan(0);
  });

  it("does not draw the opening itself", () => {
    // An `IfcOpeningElement` is a void, not a product. Tessellating one fills the hole it was cutting.
    const drawn = new Set(tessellate(SAMPLE).meshes.map((m) => m.ifcType));
    expect(drawn).not.toContain("IFCOPENINGELEMENT");
  });
});
