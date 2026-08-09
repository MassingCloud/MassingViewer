import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createGizmo, type GizmoCommit } from "./gizmo";

/**
 * The transform gizmo.
 *
 * Three things here can be silently wrong in a way no type catches, and each one has a test:
 *
 *   1. **The axis swap.** `move_element` takes IFC `dx/dy/dz`, where IFC y is the plan y — the viewport's **z**.
 *      Emitting world axes instead moves an element sideways when dragged forwards, with no error.
 *   2. **The rotation sign.** `atan2` in the x/z plane runs opposite to a positive rotation about IFC +z, so the
 *      naive subtraction spins the wrong way and reads as the gizmo fighting the user.
 *   3. **The zero-delta guard.** A click that merely selects must not dispatch an edit, or every selection bumps
 *      the model version and writes an audit entry for a change nobody made.
 */

/** A camera looking down, with `up` on −Z so a straight-down `lookAt` is not degenerate. */
function topDown(height = 20): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 200);
  camera.position.set(0, height, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

/**
 * A canvas stand-in that records listeners, so a test can dispatch to the capture-phase handlers directly.
 *
 * happy-dom reports a zero rect for a real element, and the gizmo correctly refuses to resolve a drag on a
 * zero-size canvas — so a real element would make every test here a no-op that passes.
 */
function fakeCanvas(width = 200, height = 200) {
  const listeners = new Map<string, ((event: PointerEvent) => void)[]>();
  const el = {
    getBoundingClientRect: () => ({ width, height, left: 0, top: 0, right: width, bottom: height }),
    addEventListener: (type: string, fn: (event: PointerEvent) => void) => {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener: (type: string, fn: (event: PointerEvent) => void) => {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
    },
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  } as unknown as HTMLElement;

  const send = (type: string, x: number, y: number, button = 0): void => {
    const event = {
      clientX: x,
      clientY: y,
      button,
      pointerId: 1,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as PointerEvent;
    for (const fn of listeners.get(type) ?? []) fn(event);
  };
  return { el, send, listeners };
}

/** A 2 m cube centred on the origin, sitting on the ground. */
const cube = () => new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));

interface Harness {
  readonly commits: GizmoCommit[];
  readonly send: (type: string, x: number, y: number, button?: number) => void;
  readonly gizmo: ReturnType<typeof createGizmo>;
  readonly scene: THREE.Scene;
}

function harness(options: Partial<Parameters<typeof createGizmo>[3]> = {}): Harness {
  const scene = new THREE.Scene();
  const camera = topDown();
  const { el, send } = fakeCanvas();
  const commits: GizmoCommit[] = [];
  const gizmo = createGizmo(scene, camera, el, {
    onCommit: (commit) => commits.push(commit),
    ...options,
  });
  return { commits, send, gizmo, scene };
}

/**
 * Screen coordinates for a world point on the ground plane, under `topDown()`.
 *
 * 90° vertical FOV at height h puts the visible half-extent at h metres, so with a square aspect the mapping is
 * linear: world x of +h is the right edge. Derived rather than measured, so the expected metres in each test are
 * knowable from the numbers in the test.
 */
function screenOf(x: number, z: number, height = 20, size = 200): [number, number] {
  return [((x / height) * 0.5 + 0.5) * size, ((z / height) * 0.5 + 0.5) * size];
}

describe("attach and detach", () => {
  it("is hidden until something is selected", () => {
    const { gizmo, scene } = harness();
    expect(gizmo.attached).toBe(false);
    expect(scene.getObjectByName("mv-gizmo")!.visible).toBe(false);
    gizmo.dispose();
  });

  it("shows three handles, each identifying its own role", () => {
    const { gizmo, scene } = harness();
    gizmo.attach(cube());
    const roles = scene.getObjectByName("mv-gizmo")!.children.map((c) => c.userData.role);
    // A raycast hit has to say what it is; a positional guess would break the moment the layout changed.
    expect(roles.sort()).toEqual(["height", "move", "rotate"]);
    gizmo.dispose();
  });

  it("copies the box rather than holding it", () => {
    // `BuildResult.bounds` is reused across loads. Holding the reference would make the gizmo silently follow a
    // different element after a re-tessellation.
    const { gizmo, scene } = harness();
    const box = cube();
    gizmo.attach(box);
    const before = scene.getObjectByName("mv-gizmo")!.children[0]!.position.clone();
    box.min.set(-100, 0, -100);
    box.max.set(-98, 2, -98);
    expect(scene.getObjectByName("mv-gizmo")!.children[0]!.position).toEqual(before);
    gizmo.dispose();
  });

  it("floors the handle size, so a thin wall is still grabbable", () => {
    const { gizmo, scene } = harness();
    // A 200 mm wall. Proportional sizing with no floor makes the plate a few pixels wide — unusable at exactly
    // the moment it matters most.
    gizmo.attach(new THREE.Box3(new THREE.Vector3(-2, 0, -0.1), new THREE.Vector3(2, 3, 0.1)));
    const move = scene.getObjectByName("mv-gizmo")!.children.find((c) => c.userData.role === "move")!;
    expect(move.scale.x).toBeGreaterThanOrEqual(0.6);
    gizmo.dispose();
  });

  it("detaching hides the handles and forgets the box", () => {
    const { gizmo } = harness();
    gizmo.attach(cube());
    gizmo.detach();
    expect(gizmo.attached).toBe(false);
    gizmo.dispose();
  });
});

describe("the move handle", () => {
  it("emits IFC axes, so dragging along the viewport's z becomes dy", () => {
    const { gizmo, send, commits } = harness();
    gizmo.attach(cube());

    // Grab the plate at the origin, drag to world (2, 0, 3).
    send("pointerdown", ...screenOf(0, 0));
    send("pointermove", ...screenOf(2, 3));
    send("pointerup", ...screenOf(2, 3));

    expect(commits).toHaveLength(1);
    /**
     * The assertion this file exists for.
     *
     * `dy: 3` — the drag along the viewport's **z** becomes IFC **y**, because IFC y is the plan y. Were this
     * emitting world axes, `move_element` would receive `dy: 0, dz: 3` and lift the element three metres into the
     * air instead of moving it three metres north. Nothing would error.
     */
    expect(commits[0]).toEqual({ kind: "move", dx: 2, dy: 3, dz: 0 });
  });

  it("never emits a vertical component, because the plate drags in the ground plane", () => {
    const { gizmo, send, commits } = harness();
    gizmo.attach(cube());
    send("pointerdown", ...screenOf(0, 0));
    send("pointermove", ...screenOf(1, 1));
    send("pointerup", ...screenOf(1, 1));
    expect((commits[0] as { dz: number }).dz).toBe(0);
    gizmo.dispose();
  });

  it("snaps the translation", () => {
    const { gizmo, send, commits } = harness({ translateSnap: 1 });
    gizmo.attach(cube());
    // 2.4 m rounds to 2, 2.6 m to 3 — so the snap is rounding rather than truncating.
    send("pointerdown", ...screenOf(0, 0));
    send("pointermove", ...screenOf(2.4, 2.6));
    send("pointerup", ...screenOf(2.4, 2.6));
    expect(commits[0]).toEqual({ kind: "move", dx: 2, dy: 3, dz: 0 });
    gizmo.dispose();
  });

  it("does not emit anything for a click that merely selects", () => {
    const { gizmo, send, commits } = harness({ translateSnap: 1 });
    gizmo.attach(cube());
    // Pressed and released without moving far enough to leave the snap cell.
    send("pointerdown", ...screenOf(0, 0));
    send("pointermove", ...screenOf(0.1, 0.1));
    send("pointerup", ...screenOf(0.1, 0.1));
    // A zero `move_element` still bumps the model version and writes an audit entry, so it must not be sent.
    expect(commits).toEqual([]);
    gizmo.dispose();
  });

  it("ignores a press that misses every handle", () => {
    const { gizmo, send, commits } = harness();
    gizmo.attach(cube());
    // Far outside the plate: this press belongs to orbit or selection, not to the gizmo.
    send("pointerdown", ...screenOf(9, 9));
    send("pointermove", ...screenOf(5, 5));
    send("pointerup", ...screenOf(5, 5));
    expect(commits).toEqual([]);
    expect(gizmo.dragging).toBe(false);
    gizmo.dispose();
  });

  it("ignores a right-click", () => {
    const { gizmo, send, commits } = harness();
    gizmo.attach(cube());
    send("pointerdown", ...screenOf(0, 0), 2);
    send("pointermove", ...screenOf(3, 0));
    send("pointerup", ...screenOf(3, 0), 2);
    expect(commits).toEqual([]);
    gizmo.dispose();
  });

  it("does nothing at all while detached", () => {
    const { gizmo, send, commits } = harness();
    send("pointerdown", ...screenOf(0, 0));
    send("pointermove", ...screenOf(3, 3));
    send("pointerup", ...screenOf(3, 3));
    expect(commits).toEqual([]);
    gizmo.dispose();
  });

  it("reports `dragging`, so the host can suppress orbit and selection", () => {
    const { gizmo, send } = harness();
    gizmo.attach(cube());
    expect(gizmo.dragging).toBe(false);
    send("pointerdown", ...screenOf(0, 0));
    // A drag that also spun the camera would be unusable, and one that reselected mid-transform would lose the
    // gizmo — so the host needs to know.
    expect(gizmo.dragging).toBe(true);
    send("pointerup", ...screenOf(0, 0));
    expect(gizmo.dragging).toBe(false);
    gizmo.dispose();
  });
});

describe("the rotate handle", () => {
  /** The torus sits at radius ≈ reach; for a 2 m cube that is 1.3 m from the centre. */
  const onRing = (angleDeg: number, radius = 1.3): [number, number] =>
    screenOf(Math.cos((angleDeg * Math.PI) / 180) * radius, Math.sin((angleDeg * Math.PI) / 180) * radius);

  it("rotates counter-clockwise-from-above for a counter-clockwise drag", () => {
    const { gizmo, send, commits } = harness({ rotateSnap: 0 });
    gizmo.attach(cube());
    // From +x round towards −z, which is anticlockwise viewed from above.
    send("pointerdown", ...onRing(0));
    send("pointermove", ...onRing(-90));
    send("pointerup", ...onRing(-90));

    expect(commits).toHaveLength(1);
    const commit = commits[0] as { kind: string; degrees: number };
    expect(commit.kind).toBe("rotate");
    /**
     * Positive, and that sign is the finding.
     *
     * A positive rotation about IFC +z is counter-clockwise seen from above, while `atan2` in the x/z plane runs
     * the other way — so the naive `a1 - a0` produces the opposite sign and the element spins away from the drag.
     * There is no error; it simply feels like the gizmo is fighting you.
     */
    expect(commit.degrees).toBeCloseTo(90, 3);
  });

  it("snaps the angle", () => {
    const { gizmo, send, commits } = harness({ rotateSnap: 15 });
    gizmo.attach(cube());
    send("pointerdown", ...onRing(0));
    send("pointermove", ...onRing(-20));
    send("pointerup", ...onRing(-20));
    // 20° snaps to 15°, not to 30° — rounding, and to the nearest increment.
    expect((commits[0] as { degrees: number }).degrees).toBeCloseTo(15, 6);
    gizmo.dispose();
  });

  it("emits nothing when the angle snaps back to zero", () => {
    const { gizmo, send, commits } = harness({ rotateSnap: 15 });
    gizmo.attach(cube());
    send("pointerdown", ...onRing(0));
    send("pointermove", ...onRing(-2));
    send("pointerup", ...onRing(-2));
    expect(commits).toEqual([]);
    gizmo.dispose();
  });
});

describe("the height handle — push/pull", () => {
  /**
   * A side-on camera, because a top-down one cannot exercise this.
   *
   * The height drag resolves against a **camera-facing vertical plane**, so under a straight-down camera that
   * plane is nearly edge-on to the ray and the pixel-to-metre mapping is degenerate. Looking horizontally makes it
   * exact: at 90° FOV from 20 m the visible half-extent on the z = 0 plane is 20 m over 100 px, so one world metre
   * is five pixels and every expected number below is derivable rather than copied from the output.
   */
  function sideOn(): { gizmo: ReturnType<typeof createGizmo>; send: Harness["send"]; commits: GizmoCommit[] } {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 200);
    camera.position.set(0, 0, 20);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const { el, send } = fakeCanvas();
    const commits: GizmoCommit[] = [];
    const gizmo = createGizmo(scene, camera, el, { onCommit: (c) => commits.push(c), translateSnap: 0 });
    return { gizmo, send, commits };
  }

  /** Screen position of the cone, which sits over the box's +x/+z top corner at world (1.2, 2.25, 1.2). */
  const CONE: [number, number] = [106.4, 88];

  it("emits an absolute depth, not a delta", () => {
    const { gizmo, send, commits } = sideOn();
    gizmo.attach(cube());

    // Grab the cone, drag up 25 px = 5 m. The cube is 2 m tall, so the new depth is 7 m.
    send("pointerdown", ...CONE);
    send("pointermove", CONE[0], CONE[1] - 25);
    send("pointerup", CONE[0], CONE[1] - 25);

    expect(commits).toHaveLength(1);
    const commit = commits[0] as { kind: string; depth: number };
    expect(commit.kind).toBe("height");
    /**
     * Absolute, not a delta, because that is what `set_extrusion_depth` takes. Emitting a delta would compound:
     * two 1 m drags would produce a 4 m wall rather than a 4 m one from a 2 m start... which is the same number
     * here only by coincidence, and diverges the moment the start height is not the delta.
     */
    expect(commit.depth).toBeCloseTo(7, 3);
    gizmo.dispose();
  });

  it("shrinks as well as grows", () => {
    const { gizmo, send, commits } = sideOn();
    gizmo.attach(cube());
    // Down 5 px = 1 m, from 2 m → 1 m.
    send("pointerdown", ...CONE);
    send("pointermove", CONE[0], CONE[1] + 5);
    send("pointerup", CONE[0], CONE[1] + 5);
    expect((commits[0] as { depth: number }).depth).toBeCloseTo(1, 3);
    gizmo.dispose();
  });

  it("refuses to collapse a solid to nothing", () => {
    /**
     * A floor of 50 mm, tighter than the operation's own `min: 0`.
     *
     * A zero-depth extrusion is the worst available outcome: it renders as nothing while the operation reports
     * success, so the element is invisible and still in the file, still in every schedule and quantity take-off.
     * The op permits it; the gizmo will not produce it.
     */
    const { gizmo, send, commits } = sideOn();
    gizmo.attach(cube());
    // Far below the base — a drag that would ask for a negative depth.
    send("pointerdown", ...CONE);
    send("pointermove", CONE[0], CONE[1] + 200);
    send("pointerup", CONE[0], CONE[1] + 200);
    expect((commits[0] as { depth: number }).depth).toBeGreaterThan(0);
    expect((commits[0] as { depth: number }).depth).toBeCloseTo(0.05, 6);
    gizmo.dispose();
  });

  it("emits nothing when the height comes back to where it started", () => {
    const { gizmo, send, commits } = sideOn();
    gizmo.attach(cube());
    send("pointerdown", ...CONE);
    send("pointermove", CONE[0], CONE[1] - 20);
    // Back to the start before releasing: the net change is zero, so there is nothing to dispatch.
    send("pointermove", ...CONE);
    send("pointerup", ...CONE);
    expect(commits).toEqual([]);
    gizmo.dispose();
  });
});

describe("dispose", () => {
  it("removes the group and frees every geometry and material", () => {
    const { gizmo, scene } = harness();
    const group = scene.getObjectByName("mv-gizmo")!;
    let disposed = 0;
    for (const child of group.children) {
      const mesh = child as THREE.Mesh;
      mesh.geometry.addEventListener("dispose", () => (disposed += 1));
      (mesh.material as THREE.Material).addEventListener("dispose", () => (disposed += 1));
    }
    gizmo.dispose();
    expect(scene.getObjectByName("mv-gizmo")).toBeUndefined();
    // Three handles, each a geometry and a material. Removal alone does not free GPU memory.
    expect(disposed).toBe(6);
  });

  it("detaches its listeners, so a disposed gizmo cannot still act", () => {
    const scene = new THREE.Scene();
    const { el, send, listeners } = fakeCanvas();
    const commits: GizmoCommit[] = [];
    const gizmo = createGizmo(scene, topDown(), el, { onCommit: (c) => commits.push(c) });
    gizmo.attach(cube());
    gizmo.dispose();

    expect(listeners.get("pointerdown")).toEqual([]);
    send("pointerdown", ...screenOf(0, 0));
    send("pointermove", ...screenOf(3, 3));
    send("pointerup", ...screenOf(3, 3));
    expect(commits).toEqual([]);
  });
});
