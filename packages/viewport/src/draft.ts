import * as THREE from "three";

/**
 * The three things a draft tool needs from a renderer: a ground projection, a visible grid, and a live preview.
 *
 * ## Why these live together
 *
 * They are the M6 gap in one file. `@massing/authoring`'s session is already complete and already consumes
 * `resolveSnap` — what was missing was never logic, it was the three pieces of *renderer* the session cannot
 * supply for itself, because it deliberately knows nothing about three.js:
 *
 *   1. **`screenToGround`** — a pointer event is in pixels and the session speaks metres on the ground plane.
 *      Without it there is no way to call `hover()` at all.
 *   2. **A grid** — M6's acceptance criterion is *"snap to a grid intersection"*, and an intersection you cannot
 *      see is one nobody aims at. `gridSnaps` in `@massing/geometry-math` computes the candidates; this draws them.
 *   3. **A preview** — the crosshair showing where the point will land and the rubber band showing what is being
 *      drawn. `HoverFeedback` is designed to be rendered and nothing rendered it.
 *
 * ## Everything here is disposable, and that is load-bearing
 *
 * `docs/testing.md` calls the memory-leak gate the most-neglected one for a long-lived three.js app. Every
 * geometry and material created below is owned by the controller that made it and released in `dispose()` — three
 * does not garbage-collect GPU resources, so an overlay that is merely removed from the scene leaks its buffers.
 */

/** Where a pointer lands on the ground plane, in model metres. */
export interface GroundPoint {
  readonly x: number;
  readonly z: number;
}

/**
 * Project a pointer position onto the horizontal plane at `elevation`.
 *
 * Returns `null` when the ray does not meet the plane — looking at the horizon or up at the sky. That is a real
 * state and not an error: the honest answer is "nowhere", and returning `{x: 0, z: 0}` instead would place a wall
 * at the origin whenever the camera tilted too far, which reads as a snapping bug.
 */
export function screenToGround(
  event: { clientX: number; clientY: number },
  camera: THREE.Camera,
  canvas: HTMLElement,
  elevation = 0,
): GroundPoint | null {
  const rect = canvas.getBoundingClientRect();
  // Guard the degenerate rect. A detached or zero-size canvas divides by zero and yields NaN, which then fails
  // every comparison downstream in silence rather than throwing — the same class of failure `gridSnaps` refuses.
  if (rect.width === 0 || rect.height === 0) return null;

  const ndc = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -(((event.clientY - rect.top) / rect.height) * 2 - 1),
  );

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -elevation);
  const hit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(plane, hit) === null) return null;
  return { x: hit.x, z: hit.z };
}

export interface GridOptions {
  /** Metres between lines. The snap spacing must match, or the crosshair lands where no line is drawn. */
  readonly spacing?: number;
  /** Half-extent in metres. */
  readonly extent?: number;
  /** Every nth line drawn heavier. 0 disables. */
  readonly major?: number;
}

export interface GridController {
  readonly spacing: number;
  visible(on: boolean): void;
  readonly isVisible: boolean;
  /** Move the grid to a storey elevation, so a plan-level draft snaps on that level rather than at zero. */
  setElevation(metres: number): void;
  readonly elevation: number;
  dispose(): void;
}

/**
 * A construction grid on the ground plane.
 *
 * Built as one `LineSegments` rather than a line per gridline. At 0.5 m spacing over 100 m that is 802 objects
 * versus 1, and 802 draw calls is a measurable frame cost for something that is only ever background — the
 * `stats()` draw-call counter exists to catch exactly this kind of accumulation.
 *
 * `THREE.GridHelper` is deliberately not used: it cannot be re-elevated without rebuilding, has no major/minor
 * distinction, and its colours are not ours. This is thirty lines and does what the tool needs.
 */
export function createGrid(scene: THREE.Scene, options: GridOptions = {}): GridController {
  const spacing = options.spacing ?? 1;
  const extent = options.extent ?? 60;
  const major = options.major ?? 10;

  const minor: number[] = [];
  const heavy: number[] = [];
  const steps = Math.floor(extent / spacing);

  for (let i = -steps; i <= steps; i++) {
    const at = i * spacing;
    // `major` counts *lines*, not metres, so the heavy lines stay every 10th line whatever the spacing is.
    const into = major > 0 && i % major === 0 ? heavy : minor;
    into.push(-extent, 0, at, extent, 0, at);
    into.push(at, 0, -extent, at, 0, extent);
  }

  const group = new THREE.Group();
  group.name = "mv-grid";
  // Never pickable. A grid that intercepts a raycast would swallow every click meant for the building, and the
  // symptom is "selection stopped working" rather than "the grid is in the way".
  group.raycast = () => {};

  const built: { geometry: THREE.BufferGeometry; material: THREE.Material }[] = [];
  for (const [positions, opacity] of [
    [minor, 0.12],
    [heavy, 0.28],
  ] as const) {
    if (positions.length === 0) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({ color: 0x8899aa, transparent: true, opacity });
    const lines = new THREE.LineSegments(geometry, material);
    lines.raycast = () => {};
    // Rendered before the model and without writing depth, so the building always occludes the grid rather than
    // the grid drawing over a wall it is behind.
    material.depthWrite = false;
    lines.renderOrder = -1;
    group.add(lines);
    built.push({ geometry, material });
  }

  group.visible = false;
  scene.add(group);

  let elevation = 0;
  return {
    spacing,
    visible(on) {
      group.visible = on;
    },
    get isVisible() {
      return group.visible;
    },
    setElevation(metres) {
      elevation = metres;
      group.position.y = metres;
    },
    get elevation() {
      return elevation;
    },
    dispose() {
      scene.remove(group);
      // three does not free GPU buffers on removal. Skipping this is the leak the memory gate would catch.
      for (const { geometry, material } of built) {
        geometry.dispose();
        material.dispose();
      }
      built.length = 0;
    },
  };
}

/** What the preview draws. Mirrors the fields of `HoverFeedback` that have a visual, and nothing more. */
export interface PreviewState {
  /** Where the next point would land. `null` hides the crosshair — the pointer is off the ground plane. */
  readonly at: GroundPoint | null;
  /** The snap that won, so the marker can say *which* kind it is rather than merely that there was one. */
  readonly snapKind: string | null;
  /** Points already committed in this command, for the rubber band. */
  readonly points: readonly GroundPoint[];
}

export interface PreviewController {
  update(state: PreviewState): void;
  clear(): void;
  dispose(): void;
}

/** Snap-marker colours by kind. An endpoint and a grid intersection must not look the same. */
const SNAP_COLOUR: Record<string, number> = {
  endpoint: 0x44ff88,
  midpoint: 0xffcc44,
  center: 0xff88ff,
  intersection: 0x44ccff,
  perpendicular: 0xffffff,
  grid: 0x8899aa,
  nearest: 0x888888,
};

/**
 * The crosshair and rubber band.
 *
 * Buffers are allocated **once** at a fixed capacity and rewritten in place, because this updates on every
 * pointer move. Rebuilding a `BufferGeometry` per frame allocates a GPU buffer per frame, and the resulting
 * churn is invisible until it is a stutter — precisely the shape of bug the plan's long-task and memory gates
 * exist for.
 */
export function createPreview(scene: THREE.Scene, options: { readonly maxPoints?: number } = {}): PreviewController {
  const maxPoints = options.maxPoints ?? 64;

  const group = new THREE.Group();
  group.name = "mv-draft-preview";
  group.raycast = () => {};

  // The snap marker: a small square on the ground, facing up.
  const markerGeometry = new THREE.BufferGeometry();
  markerGeometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1, -1, 0, -1], 3),
  );
  const markerMaterial = new THREE.LineBasicMaterial({ color: 0x44ff88, depthTest: false, transparent: true });
  const marker = new THREE.Line(markerGeometry, markerMaterial);
  marker.raycast = () => {};
  // `depthTest: false` plus a high render order: the crosshair must be visible even when it lands on a face the
  // camera is looking at edge-on. A crosshair hidden inside geometry is worse than none, because the user
  // believes the tool has stopped responding.
  marker.renderOrder = 999;
  marker.visible = false;
  group.add(marker);

  // The rubber band: committed points plus the live one.
  const bandGeometry = new THREE.BufferGeometry();
  const bandPositions = new Float32Array((maxPoints + 1) * 3);
  bandGeometry.setAttribute("position", new THREE.Float32BufferAttribute(bandPositions, 3));
  bandGeometry.setDrawRange(0, 0);
  const bandMaterial = new THREE.LineBasicMaterial({ color: 0xffdd55, depthTest: false, transparent: true });
  const band = new THREE.Line(bandGeometry, bandMaterial);
  band.raycast = () => {};
  band.renderOrder = 998;
  band.visible = false;
  group.add(band);

  scene.add(group);

  /** Marker size in metres. Fixed rather than screen-constant: this is a *construction* aid, not a cursor. */
  const MARKER = 0.15;

  return {
    update(state) {
      if (state.at === null) {
        marker.visible = false;
      } else {
        marker.visible = true;
        marker.position.set(state.at.x, 0.002, state.at.z);
        marker.scale.setScalar(MARKER);
        markerMaterial.color.setHex(SNAP_COLOUR[state.snapKind ?? ""] ?? 0xffffff);
        // A snap that won gets a solid marker; a free point gets a dimmer one, so "is it snapped?" is answerable
        // at a glance rather than by reading a status bar.
        markerMaterial.opacity = state.snapKind === null ? 0.45 : 1;
      }

      const path = state.at === null ? state.points : [...state.points, state.at];
      // Silently truncated at capacity rather than reallocating. A command collecting more than `maxPoints`
      // vertices is not a case worth a per-frame allocation, and the band is a hint rather than the geometry.
      const count = Math.min(path.length, maxPoints + 1);
      const attribute = bandGeometry.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < count; i++) {
        attribute.setXYZ(i, path[i]!.x, 0.002, path[i]!.z);
      }
      attribute.needsUpdate = true;
      bandGeometry.setDrawRange(0, count);
      // Two points minimum, or `LineBasicMaterial` draws nothing and the draw range is wasted work.
      band.visible = count >= 2;
    },

    clear() {
      marker.visible = false;
      band.visible = false;
      bandGeometry.setDrawRange(0, 0);
    },

    dispose() {
      scene.remove(group);
      markerGeometry.dispose();
      markerMaterial.dispose();
      bandGeometry.dispose();
      bandMaterial.dispose();
    },
  };
}
