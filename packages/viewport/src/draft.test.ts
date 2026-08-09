import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createGrid, createPreview, screenToGround } from "./draft";

/**
 * The renderer half of the draft tools.
 *
 * As with `section.test.ts`, what is testable without a GPU is the *state that drives* the drawing — and that is
 * where the bugs are. A projection off by a factor of two, a grid that swallows raycasts, a preview that
 * reallocates its buffer every frame, an overlay that leaks its GPU buffers on dispose: none of those need pixels
 * to catch and all of them are invisible in a screenshot until you know to look.
 */

/**
 * A camera looking straight down at the origin from 10 m up. Makes the expected projection arithmetic obvious.
 *
 * `up` is set to −Z **before** `lookAt`, and that is not cosmetic. The default up is +Y, which for a straight-down
 * view is *parallel to the view direction* — a degenerate `lookAt` that three resolves by nudging the up vector.
 * The result is a camera tilted by about a thousandth of a radian, which put every projection here 1 mm off and
 * looked exactly like a rounding error in `screenToGround`. It was a bad test fixture, not a bad projection.
 */
function topDown(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
  camera.position.set(0, 10, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

/** A canvas stand-in with a known rect, since happy-dom reports zero for a real element. */
function canvasOf(width = 200, height = 200, left = 0, top = 0): HTMLElement {
  return {
    getBoundingClientRect: () => ({ width, height, left, top, right: left + width, bottom: top + height }),
  } as unknown as HTMLElement;
}

describe("screenToGround", () => {
  it("maps the canvas centre to the point under the camera", () => {
    const point = screenToGround({ clientX: 100, clientY: 100 }, topDown(), canvasOf());
    expect(point).not.toBeNull();
    expect(point!.x).toBeCloseTo(0, 6);
    expect(point!.z).toBeCloseTo(0, 6);
  });

  it("maps a corner to a known metre offset", () => {
    // 90° vertical FOV at 10 m: the visible half-height on the ground is 10·tan(45°) = 10 m, and the aspect is 1,
    // so the right edge is +10 m in x and the top edge is −10 m in z. Chosen so the expected answer is derivable
    // rather than copied from the output.
    const point = screenToGround({ clientX: 200, clientY: 0 }, topDown(), canvasOf());
    expect(point!.x).toBeCloseTo(10, 4);
    expect(point!.z).toBeCloseTo(-10, 4);
  });

  it("accounts for the canvas offset within the page", () => {
    // The ribbon and header push the canvas down the page. Ignoring `rect.left`/`rect.top` is the classic version
    // of this bug: it works in a full-page demo and is wrong by the header height in a real shell.
    const shifted = screenToGround({ clientX: 150, clientY: 180 }, topDown(), canvasOf(200, 200, 50, 80));
    expect(shifted!.x).toBeCloseTo(0, 6);
    expect(shifted!.z).toBeCloseTo(0, 6);
  });

  it("respects an elevation, so a level-2 draft lands on level 2", () => {
    const camera = topDown();
    const atZero = screenToGround({ clientX: 200, clientY: 100 }, camera, canvasOf(), 0);
    const atThree = screenToGround({ clientX: 200, clientY: 100 }, camera, canvasOf(), 3);
    // Nearer the camera, so the same ray covers less ground: the offset shrinks in proportion to the remaining
    // height (7 m of 10).
    expect(atThree!.x).toBeCloseTo(atZero!.x * 0.7, 4);
  });

  it("returns null when the ray never meets the plane", () => {
    // Looking at the sky. The honest answer is "nowhere" — returning {0,0} would silently place geometry at the
    // origin whenever the camera tilted up, which reads as a snapping bug rather than a missed plane.
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 1, 0);
    camera.lookAt(0, 10, -1);
    camera.updateMatrixWorld(true);
    expect(screenToGround({ clientX: 100, clientY: 100 }, camera, canvasOf())).toBeNull();
  });

  it("returns null for a zero-size canvas rather than NaN", () => {
    // A detached or not-yet-laid-out canvas. NaN fails every comparison downstream *in silence*, so the snap
    // engine would simply stop working with nothing to look at.
    expect(screenToGround({ clientX: 0, clientY: 0 }, topDown(), canvasOf(0, 0))).toBeNull();
  });
});

describe("createGrid", () => {
  it("draws one LineSegments per weight, not one object per line", () => {
    const scene = new THREE.Scene();
    const grid = createGrid(scene, { spacing: 1, extent: 20, major: 10 });
    const group = scene.getObjectByName("mv-grid")!;
    // 41 lines each way at 1 m over ±20 m. As individual objects that is 82 draw calls for background; batched it
    // is 2. The `stats()` draw-call counter exists to catch exactly this kind of accumulation.
    expect(group.children).toHaveLength(2);
    for (const child of group.children) expect(child).toBeInstanceOf(THREE.LineSegments);
    grid.dispose();
  });

  it("is not pickable, at the group and at every child", () => {
    const scene = new THREE.Scene();
    const grid = createGrid(scene);
    const group = scene.getObjectByName("mv-grid")!;
    const raycaster = new THREE.Raycaster();
    const hits: THREE.Intersection[] = [];
    group.raycast(raycaster, hits);
    for (const child of group.children) child.raycast(raycaster, hits);
    // A grid that intercepts a ray swallows every click meant for the building, and the symptom presents as
    // "selection stopped working" rather than "the grid is in the way".
    expect(hits).toEqual([]);
    grid.dispose();
  });

  it("starts hidden, and toggles", () => {
    const scene = new THREE.Scene();
    const grid = createGrid(scene);
    expect(grid.isVisible).toBe(false);
    grid.visible(true);
    expect(grid.isVisible).toBe(true);
    grid.dispose();
  });

  it("moves to a storey elevation", () => {
    const scene = new THREE.Scene();
    const grid = createGrid(scene);
    grid.setElevation(3.5);
    expect(grid.elevation).toBe(3.5);
    expect(scene.getObjectByName("mv-grid")!.position.y).toBe(3.5);
    grid.dispose();
  });

  it("keeps major lines every nth LINE, not every nth metre", () => {
    // `major: 10` at 0.5 m spacing must put heavy lines every 10 lines (5 m), not every 10 m. Getting this wrong
    // makes the emphasis depend on the spacing, so a half-metre grid looks unstructured.
    const scene = new THREE.Scene();
    createGrid(scene, { spacing: 0.5, extent: 10, major: 10 });
    const group = scene.getObjectByName("mv-grid")!;
    const heavy = group.children[1] as THREE.LineSegments;
    const positions = heavy.geometry.getAttribute("position");
    // Steps = 20, so i ∈ [−20, 20] and i % 10 === 0 for −20, −10, 0, 10, 20 → 5 lines each way, 2 vertices each.
    expect(positions.count).toBe(5 * 2 * 2);
    (group.children[0] as THREE.LineSegments).geometry.dispose();
  });

  it("frees its GPU buffers on dispose", () => {
    const scene = new THREE.Scene();
    const grid = createGrid(scene);
    const group = scene.getObjectByName("mv-grid")!;
    const geometries = group.children.map((c) => (c as THREE.LineSegments).geometry);
    let disposed = 0;
    for (const geometry of geometries) geometry.addEventListener("dispose", () => (disposed += 1));

    grid.dispose();

    // Removing from the scene does not free GPU memory — three requires an explicit dispose, and an overlay that
    // skips it is exactly the leak the memory gate in docs/testing.md is meant to find.
    expect(scene.getObjectByName("mv-grid")).toBeUndefined();
    expect(disposed).toBe(geometries.length);
  });
});

describe("createPreview", () => {
  const bandOf = (scene: THREE.Scene) =>
    scene.getObjectByName("mv-draft-preview")!.children[1] as THREE.Line;
  const markerOf = (scene: THREE.Scene) =>
    scene.getObjectByName("mv-draft-preview")!.children[0] as THREE.Line;

  it("hides the crosshair when the pointer is off the ground plane", () => {
    const scene = new THREE.Scene();
    const preview = createPreview(scene);
    preview.update({ at: null, snapKind: null, points: [] });
    expect(markerOf(scene).visible).toBe(false);
    preview.dispose();
  });

  it("colours the marker by snap kind, and dims an unsnapped point", () => {
    const scene = new THREE.Scene();
    const preview = createPreview(scene);
    const marker = markerOf(scene);
    const material = marker.material as THREE.LineBasicMaterial;

    preview.update({ at: { x: 1, z: 2 }, snapKind: "endpoint", points: [] });
    const endpointColour = material.color.getHex();
    expect(material.opacity).toBe(1);

    preview.update({ at: { x: 1, z: 2 }, snapKind: "grid", points: [] });
    // An endpoint and a grid intersection must not look the same, or the marker conveys only "snapped" and the
    // drafter cannot tell whether they caught the building or the paper.
    expect(material.color.getHex()).not.toBe(endpointColour);

    preview.update({ at: { x: 1, z: 2 }, snapKind: null, points: [] });
    expect(material.opacity).toBeLessThan(1);
    preview.dispose();
  });

  it("places the marker at the point, lifted clear of the ground", () => {
    const scene = new THREE.Scene();
    const preview = createPreview(scene);
    preview.update({ at: { x: 3, z: -4 }, snapKind: "grid", points: [] });
    const marker = markerOf(scene);
    expect(marker.position.x).toBe(3);
    expect(marker.position.z).toBe(-4);
    // Slightly above zero, or it z-fights with the grid and the slab and flickers.
    expect(marker.position.y).toBeGreaterThan(0);
    preview.dispose();
  });

  it("draws the rubber band through the committed points and the live one", () => {
    const scene = new THREE.Scene();
    const preview = createPreview(scene);
    preview.update({ at: { x: 5, z: 0 }, snapKind: null, points: [{ x: 0, z: 0 }] });
    const band = bandOf(scene);
    expect(band.visible).toBe(true);
    expect(band.geometry.drawRange.count).toBe(2);
    const positions = band.geometry.getAttribute("position");
    expect(positions.getX(0)).toBe(0);
    expect(positions.getX(1)).toBe(5);
    preview.dispose();
  });

  it("hides the band below two points, rather than drawing nothing at a cost", () => {
    const scene = new THREE.Scene();
    const preview = createPreview(scene);
    preview.update({ at: { x: 1, z: 1 }, snapKind: null, points: [] });
    expect(bandOf(scene).visible).toBe(false);
    preview.dispose();
  });

  it("rewrites its buffer in place rather than reallocating per update", () => {
    const scene = new THREE.Scene();
    const preview = createPreview(scene);
    const before = bandOf(scene).geometry.getAttribute("position");
    for (let i = 0; i < 50; i++) preview.update({ at: { x: i, z: 0 }, snapKind: null, points: [{ x: 0, z: 0 }] });
    // Same attribute object, same backing array. This runs on every pointer move; a fresh BufferGeometry per
    // frame allocates a GPU buffer per frame and the churn shows up as a stutter, not as an error.
    expect(bandOf(scene).geometry.getAttribute("position")).toBe(before);
    preview.dispose();
  });

  it("truncates at capacity instead of overrunning the buffer", () => {
    const scene = new THREE.Scene();
    const preview = createPreview(scene, { maxPoints: 4 });
    const points = Array.from({ length: 20 }, (_, i) => ({ x: i, z: 0 }));
    expect(() => preview.update({ at: { x: 99, z: 0 }, snapKind: null, points })).not.toThrow();
    expect(bandOf(scene).geometry.drawRange.count).toBe(5);
    preview.dispose();
  });

  it("clears without disposing, because a command ends more often than a viewport does", () => {
    const scene = new THREE.Scene();
    const preview = createPreview(scene);
    preview.update({ at: { x: 1, z: 1 }, snapKind: "grid", points: [{ x: 0, z: 0 }] });
    preview.clear();
    expect(markerOf(scene).visible).toBe(false);
    expect(bandOf(scene).visible).toBe(false);
    // Still in the scene and still usable — disarming a tool must not cost a rebuild.
    expect(scene.getObjectByName("mv-draft-preview")).toBeDefined();
    preview.update({ at: { x: 2, z: 2 }, snapKind: "grid", points: [] });
    expect(markerOf(scene).visible).toBe(true);
    preview.dispose();
  });

  it("frees both geometries and both materials on dispose", () => {
    const scene = new THREE.Scene();
    const preview = createPreview(scene);
    const group = scene.getObjectByName("mv-draft-preview")!;
    let disposed = 0;
    for (const child of group.children) {
      (child as THREE.Line).geometry.addEventListener("dispose", () => (disposed += 1));
      ((child as THREE.Line).material as THREE.Material).addEventListener("dispose", () => (disposed += 1));
    }
    preview.dispose();
    expect(scene.getObjectByName("mv-draft-preview")).toBeUndefined();
    expect(disposed).toBe(4);
  });
});
