import { beforeEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { createSection } from "./section";

/**
 * Clipping is a GPU behaviour, so what is testable here is the *state that drives it* — the planes, their signs,
 * and the two renderer/material flags without which none of it does anything.
 *
 * That is not a weak test surface. Every bug I hit writing this file was in exactly that state: a flag left at its
 * default, a union where an intersection was needed, a sign that hid the half you wanted to keep. None of them
 * need a GPU to catch, and all of them are invisible in a screenshot until you know what you are looking for.
 */

let renderer: THREE.WebGLRenderer;
let root: THREE.Group;

/** A material-bearing mesh, since the controller walks materials rather than meshes. */
function meshed(): THREE.Group {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  group.add(mesh);
  return group;
}

beforeEach(() => {
  // A bare object, not a real WebGL context: `createSection` only ever sets `localClippingEnabled`, and standing
  // up headless WebGL to observe one boolean would make the test slower and no stronger.
  renderer = { localClippingEnabled: false } as unknown as THREE.WebGLRenderer;
  root = meshed();
});

function materialOf(object: THREE.Object3D): THREE.Material {
  let found: THREE.Material | null = null;
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (found === null && mesh.material !== undefined) found = mesh.material as THREE.Material;
  });
  return found!;
}

describe("the flag that makes or breaks it", () => {
  it("enables local clipping, which defaults to false", () => {
    // Without this, `material.clippingPlanes` is silently ignored: the array is set, the planes are right, and
    // nothing is clipped. No warning, no error — the most expensive kind of default.
    expect(renderer.localClippingEnabled).toBe(false);
    createSection(renderer, root);
    expect(renderer.localClippingEnabled).toBe(true);
  });

  it("uses local clipping rather than global, so a gizmo would not clip itself", () => {
    // `renderer.clippingPlanes` needs no flag but applies to everything, including the section box's own handles.
    const section = createSection(renderer, root);
    section.setPlane([0, -1, 0], [0, 3, 0]);
    expect((renderer as { clippingPlanes?: unknown }).clippingPlanes).toBeUndefined();
  });
});

describe("a single plane", () => {
  it("keeps the half-space the normal points at", () => {
    // The sign convention on `constant` is the thing everyone gets backwards, and it shows up as the section
    // hiding the half you wanted to keep. Asserted through `distanceToPoint`, which is what the GPU effectively
    // evaluates: positive means kept.
    const section = createSection(renderer, root);
    section.setPlane([0, -1, 0], [0, 3, 0]);

    const planes = materialOf(root).clippingPlanes!;
    expect(planes).toHaveLength(1);
    const plane = planes[0]!;
    // Below the cut is kept, above is clipped — which is what a plan cut at 3 m means.
    expect(plane.distanceToPoint(new THREE.Vector3(0, 1, 0))).toBeGreaterThan(0);
    expect(plane.distanceToPoint(new THREE.Vector3(0, 5, 0))).toBeLessThan(0);
    expect(plane.distanceToPoint(new THREE.Vector3(0, 3, 0))).toBeCloseTo(0, 6);
  });

  it("does not set clipIntersection for one plane", () => {
    // With a single plane, union and intersection agree — but leaving it on from a previous box would then apply
    // to the plane, so it has to be reset rather than left alone.
    const section = createSection(renderer, root);
    section.setBox([0, 0, 0], [1, 1, 1]);
    expect(materialOf(root).clipIntersection).toBe(true);
    section.setPlane([0, -1, 0], [0, 3, 0]);
    expect(materialOf(root).clipIntersection).toBe(false);
  });

  it("moves along its own normal, which is not the same as 'up'", () => {
    // I wrote this test asserting the opposite of what `offset` documents, so it is worth being explicit rather
    // than just correct. `offset` moves the plane **along its own normal**, and a plan cut's normal points *down*
    // (it keeps what is below). So `offset(+1)` on that plane lowers the cut and reveals less.
    //
    // Worked, because deriving it is exactly where the mistake happens. Plane `n·x + c = 0` with n = (0,-1,0)
    // and a point at y = 3 gives c = 3, i.e. `-y + 3 = 0` → y = 3. Moving one metre along n (downwards) puts the
    // cut at y = 2, which is c = 2 — so `c -= metres`.
    //
    // "Along the normal" is the predictable contract; mapping a scroll gesture onto it is the host's job, and a
    // host that wants "scroll up reveals more" passes a negative offset for a downward-facing plane.
    const section = createSection(renderer, root);
    section.setPlane([0, -1, 0], [0, 3, 0]);
    expect(section.state.plane!.constant).toBeCloseTo(3, 6);

    section.offset(1);
    expect(section.state.plane!.constant).toBeCloseTo(2, 6);

    // Observable: 2.5 m was kept when the cut was at 3 m, and is clipped now the cut is at 2 m.
    const plane = materialOf(root).clippingPlanes![0]!;
    expect(plane.distanceToPoint(new THREE.Vector3(0, 2.5, 0))).toBeLessThan(0);
    expect(plane.distanceToPoint(new THREE.Vector3(0, 1.5, 0))).toBeGreaterThan(0);

    // And the other direction raises it, so nothing is one-way.
    section.offset(-2);
    expect(section.state.plane!.constant).toBeCloseTo(4, 6);
  });
});

describe("a box", () => {
  it("keeps only what is inside, which needs clipIntersection", () => {
    // The default is union — *any* plane hides — so a six-plane box with the default hides the entire model. This
    // is the single most likely way to get a box wrong, and the symptom is a blank viewport.
    const section = createSection(renderer, root);
    section.setBox([0, 0, 0], [10, 3, 10]);

    const material = materialOf(root);
    expect(material.clipIntersection).toBe(true);
    expect(material.clippingPlanes).toHaveLength(6);

    // Inside: every plane keeps it. Outside: at least one rejects it.
    const inside = new THREE.Vector3(5, 1.5, 5);
    expect(material.clippingPlanes!.every((p) => p.distanceToPoint(inside) > 0)).toBe(true);

    for (const outside of [
      new THREE.Vector3(-1, 1.5, 5),
      new THREE.Vector3(11, 1.5, 5),
      new THREE.Vector3(5, -1, 5),
      new THREE.Vector3(5, 4, 5),
      new THREE.Vector3(5, 1.5, -1),
      new THREE.Vector3(5, 1.5, 11),
    ]) {
      expect(
        material.clippingPlanes!.some((p) => p.distanceToPoint(outside) < 0),
        `${outside.toArray().join(",")} should be outside`,
      ).toBe(true);
    }
  });

  it("raises the top plane on offset — 'show me one more storey'", () => {
    const section = createSection(renderer, root);
    section.setBox([0, 0, 0], [10, 3, 10]);
    section.offset(3);
    expect(section.state.box!.max[1]).toBeCloseTo(6, 6);
    // And the floor did not move.
    expect(section.state.box!.min[1]).toBeCloseTo(0, 6);
  });
});

describe("clearing", () => {
  it("assigns an empty array, never null", () => {
    // three.js reads `null` as "inherit the renderer's global planes", so clearing with null would leave any
    // global clip in force — which reads as a section that cannot be turned off.
    const section = createSection(renderer, root);
    section.setPlane([0, -1, 0], [0, 3, 0]);
    section.clear();

    const planes = materialOf(root).clippingPlanes;
    expect(planes).not.toBeNull();
    expect(planes).toEqual([]);
    expect(section.state.mode).toBe("off");
  });

  it("reports no plane or box once cleared", () => {
    const section = createSection(renderer, root);
    section.setBox([0, 0, 0], [1, 1, 1]);
    section.clear();
    expect(section.state.plane).toBeNull();
    expect(section.state.box).toBeNull();
  });
});

describe("surviving a model reload", () => {
  it("reapplies to newly built materials", () => {
    // The bug this exists for: a rebuild creates new materials, and new materials carry no clipping planes. So
    // authoring one wall after setting a section would silently clear it — and the user would blame the edit.
    const section = createSection(renderer, root);
    section.setBox([0, 0, 0], [10, 3, 10]);

    const rebuilt = meshed();
    expect(materialOf(rebuilt).clippingPlanes).toBeNull();

    section.reapply(rebuilt);
    expect(materialOf(rebuilt).clippingPlanes).toHaveLength(6);
    expect(materialOf(rebuilt).clipIntersection).toBe(true);
  });

  it("bumps the material version, or the change never reaches the GPU", () => {
    // `needsUpdate` cannot be read back: in three.js it is a **setter only**, which bumps `version` and stores
    // nothing. Asserting `material.needsUpdate === true` reads `undefined`, so the first version of this test
    // failed while the code was right — and `version` is the actual mechanism anyway.
    //
    // It matters because changing the number of clipping planes recompiles the shader program. Without the bump,
    // the old program keeps running and the new planes are ignored.
    const section = createSection(renderer, root);
    const material = materialOf(root);
    const before = material.version;
    section.setPlane([0, -1, 0], [0, 3, 0]);
    expect(material.version).toBeGreaterThan(before);
  });
});

describe("shared materials", () => {
  it("visits each material once even when many meshes share it", () => {
    // Real scenes share one material across hundreds of meshes. Walking meshes instead of deduplicating materials
    // would set the same planes hundreds of times and trigger a shader recompile for each.
    const shared = new THREE.MeshStandardMaterial();
    const group = new THREE.Group();
    for (let i = 0; i < 5; i++) group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), shared));

    const section = createSection(renderer, group);
    section.setPlane([0, -1, 0], [0, 3, 0]);
    expect(shared.clippingPlanes).toHaveLength(1);
  });
});
