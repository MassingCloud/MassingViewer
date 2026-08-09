import * as THREE from "three";
import { screenToGround } from "./draft.js";

/**
 * The transform gizmo: move, rotate, and push/pull, as draggable handles on the selected element.
 *
 * ## What it is for
 *
 * The ribbon has carried a button reading *"Edit in place — drag the gizmo to move the selected element"* since
 * the tool table was extracted, and there was no gizmo. `move_element`, `rotate_element` and
 * `set_extrusion_depth` are all implemented in `LocalKernel` and were reachable only through the API.
 *
 * ## Why the drag is resolved on a plane rather than by screen delta
 *
 * A screen-space delta scaled by some factor is the tempting shortcut and it is wrong at every zoom: the same
 * pixel drag means a different number of metres depending on how far the camera is, so the handle drifts away
 * from the pointer. Both drags here intersect the pointer ray with a **plane in world space** — the ground plane
 * for a translation, a camera-facing vertical plane for a height — so the handle stays under the cursor by
 * construction and the number is in metres from the start.
 *
 * ## Why it emits deltas and never touches the model
 *
 * `onCommit` receives a delta and the host dispatches a command. The gizmo has no kernel, no command registry and
 * no idea what it is transforming — it moves a *ghost* while dragging and snaps back when it lets go, because the
 * authoritative geometry comes from the kernel's own IFC output. Anything else would let the picture and the file
 * disagree, which is the one thing the whole round-trip design exists to prevent.
 */

/** IFC axes, which are **not** the viewport's. See {@link GizmoCommit}. */
export interface MoveDelta {
  readonly kind: "move";
  /** Metres along IFC x — the same axis as the viewport's x. */
  readonly dx: number;
  /**
   * Metres along IFC y.
   *
   * IFC y is the *plan* y, which is the viewport's **z**. Emitted in IFC terms because that is what
   * `move_element` takes, and converting at the boundary is the only place the swap can be got right once. A
   * gizmo that emitted world axes would move an element sideways when dragged forwards, silently.
   */
  readonly dy: number;
  /** Metres along IFC z — vertical, the viewport's y. */
  readonly dz: number;
}

export interface RotateDelta {
  readonly kind: "rotate";
  /** Degrees about the element's own vertical axis. */
  readonly degrees: number;
}

export interface HeightDelta {
  readonly kind: "height";
  /** The new absolute extrusion depth in metres, not a delta — which is what `set_extrusion_depth` takes. */
  readonly depth: number;
}

export type GizmoCommit = MoveDelta | RotateDelta | HeightDelta;

export interface GizmoOptions {
  /** Snap a translation to this many metres. 0 disables. */
  readonly translateSnap?: number;
  /** Snap a rotation to this many degrees. 0 disables. */
  readonly rotateSnap?: number;
  /**
   * A drag finished. The host turns it into a command.
   *
   * Called only on release and only when the delta is non-zero, so a click that merely selects does not dispatch
   * an edit — a `move_element` of 0 mm would still bump the model version and land in the audit log.
   */
  onCommit(commit: GizmoCommit): void;
}

export interface GizmoController {
  /** Show handles around a box. Called on selection. */
  attach(box: THREE.Box3): void;
  detach(): void
  readonly attached: boolean;
  /** Whether a drag is in progress — the host suppresses orbit and selection while it is. */
  readonly dragging: boolean;
  dispose(): void;
}

/** Handle roles, carried in `userData` so a raycast hit identifies itself. */
type HandleRole = "move" | "rotate" | "height";

const COLOUR: Record<HandleRole, number> = {
  move: 0x44ccff,
  rotate: 0xffcc44,
  height: 0x44ff88,
};

export function createGizmo(
  scene: THREE.Scene,
  camera: THREE.Camera,
  canvas: HTMLElement,
  options: GizmoOptions,
): GizmoController {
  const translateSnap = options.translateSnap ?? 0.25;
  const rotateSnap = options.rotateSnap ?? 15;

  const group = new THREE.Group();
  group.name = "mv-gizmo";
  group.visible = false;
  scene.add(group);

  const owned: { dispose(): void }[] = [];

  /** A handle: a small mesh that raycasts and carries its role. */
  function handle(role: HandleRole, geometry: THREE.BufferGeometry): THREE.Mesh {
    const material = new THREE.MeshBasicMaterial({
      color: COLOUR[role],
      transparent: true,
      opacity: 0.85,
      // Always visible, even inside the element being edited. A handle hidden by the geometry it transforms is
      // a handle the user believes is broken.
      depthTest: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.role = role;
    mesh.renderOrder = 1000;
    group.add(mesh);
    owned.push(geometry, material);
    return mesh;
  }

  // Move: a flat plate at the base, dragged in the ground plane.
  const moveHandle = handle("move", new THREE.BoxGeometry(1, 0.04, 1));
  // Rotate: a torus lying flat, dragged around the vertical axis.
  const rotateHandle = handle("rotate", new THREE.TorusGeometry(1, 0.05, 8, 32));
  rotateHandle.rotation.x = Math.PI / 2;
  // Height: a cap on top, dragged vertically. This is push/pull.
  const heightHandle = handle("height", new THREE.ConeGeometry(0.22, 0.5, 12));

  let box: THREE.Box3 | null = null;
  /** The element's own meshes, moved as a ghost during a drag and restored on release. */
  let ghost: THREE.Object3D | null = null;

  function layout(): void {
    if (box === null) return;
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    // Sized from the element, floored so a thin wall still has a grabbable plate. A handle proportional with no
    // floor becomes a few pixels on a 200 mm-thick wall, which is unusable at exactly the moment it matters.
    const reach = Math.max(0.6, Math.max(size.x, size.z) * 0.5 + 0.3);

    moveHandle.position.set(centre.x, box.min.y + 0.02, centre.z);
    moveHandle.scale.set(reach, 1, reach);

    rotateHandle.position.set(centre.x, box.min.y + 0.05, centre.z);
    rotateHandle.scale.setScalar(reach);

    /**
     * The height handle is **off the vertical axis**, and that is a bug fix rather than a preference.
     *
     * It started above the box centre, which is where push/pull naturally belongs — directly over the top face.
     * That put all three handles on one vertical line, so from any near-top-down view the cone eclipsed the move
     * plate and **the move handle could not be grabbed at all**: a raycast straight down hits the cone first, and
     * nearest-wins is the correct rule for a raycast and the wrong outcome here. A plan view is the view a drafter
     * spends most of their time in, so this was "move is broken" in the commonest case.
     *
     * Sitting it over the +x/+z corner of the top face separates the three in screen space from every angle,
     * without needing a hit-priority rule that would then have to be explained.
     */
    heightHandle.position.set(box.max.x + 0.2, box.max.y + 0.25, box.max.z + 0.2);

    /**
     * Matrices updated here, and this is a real bug fix rather than defensive tidying.
     *
     * A raycast reads `matrixWorld`, and three only refreshes it during a render. So between `attach()` and the
     * next frame every handle is still at the *origin with an identity transform* — and a downward ray at the
     * centre then hits the rotate torus, because an unrotated torus lies in the XY plane with its ring passing
     * through (0, ±1, 0). Grabbing "move" immediately after selecting therefore started a **rotation**.
     *
     * In the browser the render loop hides this most of the time, which is what makes it worth fixing rather than
     * relying on: it is a race that shows up as an occasional inexplicable rotation, on the very first click.
     */
    group.updateMatrixWorld(true);
  }

  // --- dragging -----------------------------------------------------------------------------------

  const raycaster = new THREE.Raycaster();
  // The handles are `depthTest: false` and small; a slightly generous threshold makes the torus grabbable without
  // making the plate swallow clicks meant for the model.
  raycaster.params.Line = { threshold: 0.1 };

  interface Drag {
    readonly role: HandleRole;
    /** Where the drag started, in world metres on the resolving plane. */
    readonly from: THREE.Vector3;
    /** The element's height at grab time, for a push/pull. */
    readonly startHeight: number;
    readonly centre: THREE.Vector3;
    /** Live delta, applied to the ghost and emitted on release. */
    current: GizmoCommit | null;
  }
  let drag: Drag | null = null;

  const ndc = (event: { clientX: number; clientY: number }): THREE.Vector2 | null => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -(((event.clientY - rect.top) / rect.height) * 2 - 1),
    );
  };

  /** Which handle is under the pointer, or null. */
  function handleAt(event: { clientX: number; clientY: number }): HandleRole | null {
    if (!group.visible) return null;
    const point = ndc(event);
    if (point === null) return null;
    raycaster.setFromCamera(point, camera);
    // Refreshed again here, not only in `layout()`: the camera moves between frames too, and a host that never
    // rendered — a test, or a backgrounded tab — has no frame to have done it.
    group.updateMatrixWorld(true);
    const hits = raycaster.intersectObjects(group.children, false);
    return hits.length === 0 ? null : ((hits[0]!.object.userData.role as HandleRole | undefined) ?? null);
  }

  /**
   * A vertical plane facing the camera, for resolving a height drag.
   *
   * Facing the camera rather than a fixed axis, so dragging up feels like up from wherever you are standing. A
   * plane on a world axis makes the handle stick when the camera is looking along it.
   */
  function verticalPlaneAt(centre: THREE.Vector3): THREE.Plane {
    const toCamera = new THREE.Vector3();
    camera.getWorldPosition(toCamera).sub(centre);
    toCamera.y = 0;
    if (toCamera.lengthSq() < 1e-9) toCamera.set(0, 0, 1);
    toCamera.normalize();
    return new THREE.Plane().setFromNormalAndCoplanarPoint(toCamera, centre);
  }

  function pointOnPlane(event: { clientX: number; clientY: number }, plane: THREE.Plane): THREE.Vector3 | null {
    const point = ndc(event);
    if (point === null) return null;
    raycaster.setFromCamera(point, camera);
    const hit = new THREE.Vector3();
    return raycaster.ray.intersectPlane(plane, hit) === null ? null : hit;
  }

  const snap = (value: number, step: number): number => (step > 0 ? Math.round(value / step) * step : value);

  const onDown = (event: PointerEvent): void => {
    if (event.button !== 0 || box === null) return;
    const role = handleAt(event);
    if (role === null) return;

    // Swallowed, so neither orbit nor selection also acts on this press. A drag that both moves a wall and
    // spins the camera is unusable, and a drag that reselects mid-transform loses the gizmo.
    event.preventDefault();
    event.stopPropagation();

    const centre = box.getCenter(new THREE.Vector3());
    const from =
      role === "height"
        ? pointOnPlane(event, verticalPlaneAt(centre))
        : (() => {
            const ground = screenToGround(event, camera, canvas, box.min.y);
            return ground === null ? null : new THREE.Vector3(ground.x, box.min.y, ground.z);
          })();
    if (from === null) return;

    drag = { role, from, startHeight: box.max.y - box.min.y, centre, current: null };
    canvas.setPointerCapture?.(event.pointerId);
  };

  const onMove = (event: PointerEvent): void => {
    if (drag === null || box === null) return;
    event.preventDefault();
    event.stopPropagation();

    if (drag.role === "height") {
      const at = pointOnPlane(event, verticalPlaneAt(drag.centre));
      if (at === null) return;
      const raw = drag.startHeight + (at.y - drag.from.y);
      // Never negative, and never zero: `set_extrusion_depth` declares `min: 0`, and a zero-depth solid is
      // geometry that renders as nothing while reporting success.
      const depth = Math.max(0.05, snap(raw, translateSnap));
      drag.current = { kind: "height", depth };
      if (ghost !== null) ghost.scale.y = depth / Math.max(1e-6, drag.startHeight);
      return;
    }

    const at = screenToGround(event, camera, canvas, box.min.y);
    if (at === null) return;

    if (drag.role === "rotate") {
      const a0 = Math.atan2(drag.from.z - drag.centre.z, drag.from.x - drag.centre.x);
      const a1 = Math.atan2(at.z - drag.centre.z, at.x - drag.centre.x);
      // Negated: a positive rotation about IFC +z is counter-clockwise seen from above, and atan2 in the x/z
      // plane runs the other way. Getting this wrong rotates the opposite way from the drag, which reads as the
      // gizmo fighting the user.
      const degrees = snap((-(a1 - a0) * 180) / Math.PI, rotateSnap);
      drag.current = { kind: "rotate", degrees };
      if (ghost !== null) ghost.rotation.y = (-degrees * Math.PI) / 180;
      return;
    }

    const dx = snap(at.x - drag.from.x, translateSnap);
    const dWorldZ = snap(at.z - drag.from.z, translateSnap);
    // The axis swap, in one place. IFC y is the plan y, which is the viewport's z.
    drag.current = { kind: "move", dx, dy: dWorldZ, dz: 0 };
    if (ghost !== null) ghost.position.set(dx, 0, dWorldZ);
  };

  const onUp = (event: PointerEvent): void => {
    if (drag === null) return;
    event.preventDefault();
    event.stopPropagation();
    const finished = drag;
    drag = null;
    canvas.releasePointerCapture?.(event.pointerId);
    resetGhost();

    const commit = finished.current;
    if (commit === null) return;
    // A zero delta is a click, not an edit. Dispatching it would bump the model version and write an audit entry
    // for something the user did not change.
    if (commit.kind === "move" && commit.dx === 0 && commit.dy === 0 && commit.dz === 0) return;
    if (commit.kind === "rotate" && commit.degrees === 0) return;
    if (commit.kind === "height" && Math.abs(commit.depth - finished.startHeight) < 1e-6) return;
    options.onCommit(commit);
  };

  function resetGhost(): void {
    if (ghost === null) return;
    ghost.position.set(0, 0, 0);
    ghost.rotation.set(0, 0, 0);
    ghost.scale.set(1, 1, 1);
    ghost = null;
  }

  canvas.addEventListener("pointerdown", onDown, { capture: true });
  canvas.addEventListener("pointermove", onMove, { capture: true });
  canvas.addEventListener("pointerup", onUp, { capture: true });

  return {
    attach(next) {
      // Copied, not held. `BuildResult.bounds` is reused across loads, so keeping the reference would make the
      // gizmo silently follow a different element after a re-tessellation.
      box = next.clone();
      layout();
      group.visible = true;
    },

    detach() {
      box = null;
      drag = null;
      resetGhost();
      group.visible = false;
    },

    get attached() {
      return group.visible;
    },

    get dragging() {
      return drag !== null;
    },

    dispose() {
      canvas.removeEventListener("pointerdown", onDown, { capture: true } as never);
      canvas.removeEventListener("pointermove", onMove, { capture: true } as never);
      canvas.removeEventListener("pointerup", onUp, { capture: true } as never);
      scene.remove(group);
      // three does not free GPU buffers on removal, and an overlay that skips this is the leak the memory gate
      // in docs/testing.md exists to find.
      for (const item of owned) item.dispose();
      owned.length = 0;
    },
  };
}
