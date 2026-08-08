import * as THREE from "three";

/**
 * Interactive section planes and a clipping box.
 *
 * The M9 seam listed this as a gap with a precise reason: *"the drawing layer cuts sections; the interactive clip
 * in the viewport is not ported."* Those are genuinely different things, and it is worth being clear about which
 * this is:
 *
 * - `drawings2d` **cuts** — it intersects geometry with a plane and produces linework with GlobalIds, which is
 *   what a drawing is made of.
 * - This **hides** — it tells the GPU not to draw fragments on one side of a plane. Nothing is computed and
 *   nothing is produced; it is a view state.
 *
 * Conflating them is a real trap. A clipped viewport looks like a section and is not one: the cut face is
 * *hollow*, because clipping removes fragments rather than closing the surface. That is why a capped section
 * needs the drawing path and not this one.
 *
 * ## The setting that makes or breaks it
 *
 * **`renderer.localClippingEnabled` must be true**, and it defaults to false. Without it, `material.clippingPlanes`
 * is silently ignored — the array is set, the planes are correct, and nothing is clipped. There is no warning and
 * no error; the feature simply does not work, which is the most expensive kind of default.
 *
 * Global clipping (`renderer.clippingPlanes`) needs no such flag but applies to *everything* including helpers and
 * gizmos, so the section box would clip its own handles.
 */

export type SectionMode = "off" | "plane" | "box";

export interface SectionState {
  readonly mode: SectionMode;
  /** For `plane`: the world-space plane. Geometry on the negative side is hidden. */
  readonly plane: { readonly normal: readonly [number, number, number]; readonly constant: number } | null;
  /** For `box`: min and max corners, world space. */
  readonly box: { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] } | null;
}

export interface SectionController {
  /** A single plane. `normal` points at the half-space that stays visible. */
  setPlane(normal: readonly [number, number, number], point: readonly [number, number, number]): void;
  /** A box. Six inward-facing planes, so only what is inside remains. */
  setBox(min: readonly [number, number, number], max: readonly [number, number, number]): void;
  /** Nudge the active plane along its own normal, in metres. The scroll-wheel gesture. */
  offset(metres: number): void;
  clear(): void;
  readonly state: SectionState;
  /** Apply to a newly-built model. Called after `showModel`, or a reload silently loses the clip. */
  reapply(root: THREE.Object3D): void;
  dispose(): void;
}

/** Every material under `root`, deduplicated — one material is shared by many meshes. */
function materialsIn(root: THREE.Object3D): THREE.Material[] {
  const seen = new Set<THREE.Material>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.material === undefined) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) seen.add(material);
  });
  return [...seen];
}

/**
 * How many live controllers each renderer has, and what its flag was before the first of them.
 *
 * `localClippingEnabled` belongs to the *renderer*, not to any one controller, so disposal cannot simply decide
 * what it should be. Two weaker designs both fail:
 *
 * - **Force it `false` on dispose.** Disposing one controller then breaks every other one sharing the renderer,
 *   and the symptom is a section that silently stops clipping with no error.
 * - **Capture the value at construction and restore it.** Looks careful and is still wrong with two controllers:
 *   the second captures `true` (set by the first), the first restores `false`, and the survivor is broken. That
 *   was the first fix I wrote here, and a two-controller test is what showed it up.
 *
 * So it is reference counted, and the flag returns to its original value only when the last controller goes. A
 * `WeakMap` so a discarded renderer is not held alive by this bookkeeping.
 */
const clippingUsers = new WeakMap<THREE.WebGLRenderer, { count: number; wasEnabled: boolean }>();

export function createSection(renderer: THREE.WebGLRenderer, modelRoot: THREE.Object3D): SectionController {
  const users = clippingUsers.get(renderer) ?? { count: 0, wasEnabled: renderer.localClippingEnabled };
  users.count++;
  clippingUsers.set(renderer, users);

  // The line without which none of this does anything. See the note above.
  renderer.localClippingEnabled = true;

  let mode: SectionMode = "off";
  let planes: THREE.Plane[] = [];
  /** Kept so `offset` can move the plane without re-deriving it from a point that no longer exists. */
  let planeNormal = new THREE.Vector3(0, -1, 0);
  let boxMin: THREE.Vector3 | null = null;
  let boxMax: THREE.Vector3 | null = null;

  function apply(root: THREE.Object3D = modelRoot): void {
    for (const material of materialsIn(root)) {
      // An empty array, not `null`. three.js treats `null` as "inherit the renderer's global planes", so
      // clearing a section by assigning null would leave any global clip in force — which reads as a section
      // that cannot be turned off.
      material.clippingPlanes = planes.length === 0 ? [] : planes;
      // Required for a box: with more than one plane, the default is union (any plane hides), and a box needs
      // intersection (all planes must keep it). Without this, a six-plane box hides the entire model.
      material.clipIntersection = mode === "box";
      material.needsUpdate = true;
    }
  }

  return {
    setPlane(normal, point) {
      const n = new THREE.Vector3(...normal).normalize();
      planeNormal = n.clone();
      // `setFromNormalAndCoplanarPoint`, not a hand-computed constant: the sign convention for `constant` is
      // the thing everyone gets backwards, and it shows up as the section hiding the half you wanted to keep.
      planes = [new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(...point))];
      mode = "plane";
      boxMin = null;
      boxMax = null;
      apply();
    },

    setBox(min, max) {
      const lo = new THREE.Vector3(...min);
      const hi = new THREE.Vector3(...max);
      boxMin = lo.clone();
      boxMax = hi.clone();
      // Six planes whose normals point INWARD, so each keeps the side towards the box centre. With
      // `clipIntersection` on, geometry survives only where all six agree.
      planes = [
        new THREE.Plane(new THREE.Vector3(1, 0, 0), -lo.x),
        new THREE.Plane(new THREE.Vector3(-1, 0, 0), hi.x),
        new THREE.Plane(new THREE.Vector3(0, 1, 0), -lo.y),
        new THREE.Plane(new THREE.Vector3(0, -1, 0), hi.y),
        new THREE.Plane(new THREE.Vector3(0, 0, 1), -lo.z),
        new THREE.Plane(new THREE.Vector3(0, 0, -1), hi.z),
      ];
      mode = "box";
      apply();
    },

    offset(metres) {
      if (mode === "plane" && planes[0] !== undefined) {
        // Moving along the normal means subtracting from `constant`: a plane is `normal · x + constant = 0`, so
        // increasing `constant` moves it *against* the normal. Getting this backwards makes the scroll wheel
        // push the section the wrong way, which feels broken rather than inverted.
        planes[0].constant -= metres;
        apply();
        return;
      }
      if (mode === "box" && boxMin !== null && boxMax !== null) {
        // For a box, offset raises the top plane — the common gesture is "show me one more storey".
        boxMax = boxMax.clone().add(new THREE.Vector3(0, metres, 0));
        this.setBox([boxMin.x, boxMin.y, boxMin.z], [boxMax.x, boxMax.y, boxMax.z]);
      }
    },

    clear() {
      mode = "off";
      planes = [];
      boxMin = null;
      boxMax = null;
      apply();
    },

    get state(): SectionState {
      const p = planes[0];
      return {
        mode,
        plane:
          mode === "plane" && p !== undefined
            ? { normal: [p.normal.x, p.normal.y, p.normal.z], constant: p.constant }
            : null,
        box:
          mode === "box" && boxMin !== null && boxMax !== null
            ? { min: [boxMin.x, boxMin.y, boxMin.z], max: [boxMax.x, boxMax.y, boxMax.z] }
            : null,
      };
    },

    reapply(root) {
      // A reload builds new materials, and new materials have no clipping planes. Without this call after every
      // `showModel`, authoring one wall would silently clear the section — and the user would blame the edit.
      apply(root);
    },

    dispose() {
      planes = [];
      apply();
      // Only the last controller out restores the flag; anyone still using it keeps it.
      const remaining = clippingUsers.get(renderer);
      if (remaining !== undefined) {
        remaining.count--;
        if (remaining.count <= 0) {
          renderer.localClippingEnabled = remaining.wasEnabled;
          clippingUsers.delete(renderer);
        }
      }
      void planeNormal;
    },
  };
}
