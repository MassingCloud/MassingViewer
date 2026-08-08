// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createWalk, type WalkController } from "./walk";

/**
 * First-person controls have a small set of bugs that everyone writes once, and all of them are here as tests
 * rather than as comments: diagonal movement running faster than straight, looking up flying you upwards, the
 * camera rolling at the poles, and movement speed depending on frame rate.
 *
 * None of them need a GPU. All of them are the difference between a walk mode that tells you a soffit is too low
 * and one that tells you nothing.
 */

let dom: HTMLElement;
let camera: THREE.PerspectiveCamera;
let walk: WalkController;

/**
 * Pretend the browser grants the lock. happy-dom implements neither the method nor the property.
 *
 * `requestPointerLock` **sets `pointerLockElement`**, which is what the real API does and what my first stub did
 * not. Without it, the first `enter()` worked only because the property had been pre-set, and any re-entry after
 * an `exit()` was refused — so two tests measured zero movement on their second leg and failed for a reason that
 * had nothing to do with what they were asserting. A stub that does not model the state transition is a stub that
 * tests the first call only.
 */
function grantLock(): void {
  const set = (value: unknown) =>
    Object.defineProperty(document, "pointerLockElement", { value, writable: true, configurable: true });
  set(dom);
  (dom as unknown as { requestPointerLock: () => Promise<void> }).requestPointerLock = async () => {
    set(dom);
  };
}

function denyLock(reason = "refused"): void {
  Object.defineProperty(document, "pointerLockElement", { value: null, writable: true, configurable: true });
  (dom as unknown as { requestPointerLock: () => Promise<void> }).requestPointerLock = async () => {
    throw new Error(reason);
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  dom = document.createElement("div");
  document.body.appendChild(dom);
  (document as unknown as { exitPointerLock: () => void }).exitPointerLock = () => {
    Object.defineProperty(document, "pointerLockElement", { value: null, writable: true, configurable: true });
  };
  camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 5, 10);
  camera.lookAt(0, 0, 0);
});

afterEach(() => {
  walk?.dispose();
  vi.restoreAllMocks();
});

/**
 * Re-enter from the original pose.
 *
 * A helper because `enter()` is **async**, and both comparison tests below need a second leg from an identical
 * starting point. Writing `void walk.enter()` inline — which is what I did first — leaves `active` false for the
 * whole second leg, so it measures zero movement and the comparison fails for a reason unrelated to the claim.
 */
async function restart(): Promise<THREE.Vector3> {
  walk.exit();
  camera.position.set(0, 5, 10);
  camera.lookAt(0, 0, 0);
  await walk.enter();
  return camera.position.clone();
}

/** Walk `seconds` of held input, in `steps` frames — so frame-rate independence is observable. */
function walkFor(seconds: number, steps: number): void {
  for (let i = 0; i < steps; i++) walk.update(seconds / steps);
}

function press(code: string): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true, cancelable: true }));
}

describe("entering", () => {
  it("reports a refusal rather than appearing to do nothing", async () => {
    // Pointer lock needs a user gesture and can be denied by a permissions policy or a recent Escape. Swallowing
    // that would make clicking Walk do nothing, with no explanation anywhere.
    const onRefused = vi.fn();
    denyLock("blocked by permissions policy");
    walk = createWalk(dom, camera, { onRefused });

    expect(await walk.enter()).toBe(false);
    expect(walk.active).toBe(false);
    expect(onRefused).toHaveBeenCalledWith(expect.stringContaining("permissions policy"));
  });

  it("reports a refusal when the lock is silently not granted", async () => {
    // Some browsers resolve the promise and simply do not grant the lock, so the return value cannot be trusted
    // on its own — the element has to be checked.
    Object.defineProperty(document, "pointerLockElement", { value: null, writable: true, configurable: true });
    (dom as unknown as { requestPointerLock: () => Promise<void> }).requestPointerLock = async () => {};
    const onRefused = vi.fn();
    walk = createWalk(dom, camera, { onRefused });

    expect(await walk.enter()).toBe(false);
    expect(onRefused).toHaveBeenCalledWith(expect.stringContaining("needs a click"));
  });

  it("does not spin you round on entry", async () => {
    // Yaw is derived from where the camera was already looking. Starting from zero would swing the view to face
    // north the moment you enter, which is disorienting in exactly the situation where orientation matters.
    grantLock();
    walk = createWalk(dom, camera);
    const before = new THREE.Vector3();
    camera.getWorldDirection(before);

    await walk.enter();
    const after = new THREE.Vector3();
    camera.getWorldDirection(after);

    // Same heading in plan. Pitch is deliberately levelled, so only the horizontal direction is compared.
    const flat = (v: THREE.Vector3) => new THREE.Vector2(v.x, v.z).normalize();
    expect(flat(after).angle()).toBeCloseTo(flat(before).angle(), 2);
  });

  it("drops the camera to eye height", async () => {
    // 1.6 m, and it is the one number a reviewer would notice being wrong: walking a model is how somebody checks
    // a soffit, and a camera at 1.0 m makes everything look generous.
    grantLock();
    walk = createWalk(dom, camera);
    await walk.enter();
    expect(camera.position.y).toBeCloseTo(1.6, 6);
  });
});

describe("movement", () => {
  beforeEach(async () => {
    grantLock();
    walk = createWalk(dom, camera, { speed: 2 });
    await walk.enter();
  });

  it("does not move diagonally faster than straight", async () => {
    // The oldest bug in first-person controls: summing two unit axes gives a vector of length √2, so holding W+D
    // walks 41% faster than holding W. Normalising is the fix.
    const start = camera.position.clone();
    press("KeyW");
    walkFor(1, 10);
    const straight = camera.position.distanceTo(start);

    // Fresh session, so the heading is identical.
    const start2 = await restart();
    press("KeyW");
    press("KeyD");
    walkFor(1, 10);
    const diagonal = camera.position.distanceTo(start2);

    expect(diagonal).toBeCloseTo(straight, 3);
  });

  it("moves the same distance regardless of frame rate", async () => {
    // `dt` is what makes this true, and it matters more here than in most engines: the pixel governor
    // deliberately varies the frame rate under load, so a fixed per-frame step would make walking speed depend on
    // how heavy the model is.
    const start = camera.position.clone();
    press("KeyW");
    walkFor(1, 6);
    const slow = camera.position.distanceTo(start);

    const start2 = await restart();
    press("KeyW");
    walkFor(1, 120);
    const fast = camera.position.distanceTo(start2);

    expect(fast).toBeCloseTo(slow, 3);
    // And it actually moved — 2 m/s for one second.
    expect(slow).toBeCloseTo(2, 2);
  });

  it("does not fly when you look up", () => {
    // The forward vector is flattened. Without that, glancing at a ceiling lifts you off the floor — and a walk
    // mode that drifts upwards stops being a check on head height, which is most of what it is for.
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    // A large upward look: 400 px of negative movementY.
    const event = new MouseEvent("mousemove", { bubbles: true });
    Object.defineProperty(event, "movementX", { value: 0 });
    Object.defineProperty(event, "movementY", { value: -400 });
    document.dispatchEvent(event);

    press("KeyW");
    walkFor(1, 10);
    expect(camera.position.y).toBeCloseTo(1.6, 6);
  });

  it("holds height rather than integrating it", () => {
    // No gravity here, and letting Y drift would slowly sink the camera through the floor over a long walk.
    press("KeyW");
    for (let i = 0; i < 600; i++) walk.update(1 / 60);
    expect(camera.position.y).toBeCloseTo(1.6, 6);
  });

  it("stops when the key is released", () => {
    press("KeyW");
    walkFor(0.5, 5);
    const moved = camera.position.clone();
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyW", bubbles: true }));
    walkFor(0.5, 5);
    expect(camera.position.distanceTo(moved)).toBeCloseTo(0, 6);
  });

  it("accepts the arrow keys as well as WASD", () => {
    // A model reviewer is not necessarily a gamer, and WASD is not discoverable to someone who has never played
    // a first-person game.
    const start = camera.position.clone();
    press("ArrowUp");
    walkFor(0.5, 5);
    expect(camera.position.distanceTo(start)).toBeGreaterThan(0.5);
  });

  it("does nothing when inactive", () => {
    walk.exit();
    const start = camera.position.clone();
    press("KeyW");
    walkFor(1, 10);
    expect(camera.position.distanceTo(start)).toBeCloseTo(0, 6);
  });
});

describe("looking", () => {
  beforeEach(async () => {
    grantLock();
    walk = createWalk(dom, camera);
    await walk.enter();
  });

  it("clamps pitch just short of vertical, so the view cannot roll", () => {
    // Reaching exactly ±90° makes the yaw axis degenerate and the horizon tilts — the classic FPS camera bug, and
    // it looks like corruption rather than like a camera limit.
    for (let i = 0; i < 20; i++) {
      const event = new MouseEvent("mousemove", { bubbles: true });
      Object.defineProperty(event, "movementX", { value: 0 });
      Object.defineProperty(event, "movementY", { value: -500 });
      document.dispatchEvent(event);
    }
    const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
    expect(Math.abs(euler.x)).toBeLessThan(Math.PI / 2);
    // Roll stays zero, which is the thing the clamp protects.
    expect(Math.abs(euler.z)).toBeCloseTo(0, 6);
  });

  it("ignores mouse movement when inactive", () => {
    walk.exit();
    const before = camera.quaternion.clone();
    const event = new MouseEvent("mousemove", { bubbles: true });
    Object.defineProperty(event, "movementX", { value: 300 });
    document.dispatchEvent(event);
    expect(camera.quaternion.angleTo(before)).toBeCloseTo(0, 6);
  });
});

describe("exiting", () => {
  it("restores the camera, rather than stranding you at eye height", async () => {
    // Leaving you where you walked to would mean the orbit view resumes from inside a wall, with no way back
    // except Fit — which discards whatever you were looking at.
    grantLock();
    walk = createWalk(dom, camera);
    const before = camera.position.clone();
    const beforeQ = camera.quaternion.clone();

    await walk.enter();
    press("KeyW");
    walkFor(1, 10);
    expect(camera.position.distanceTo(before)).toBeGreaterThan(1);

    walk.exit();
    expect(camera.position.distanceTo(before)).toBeCloseTo(0, 6);
    expect(camera.quaternion.angleTo(beforeQ)).toBeCloseTo(0, 6);
  });

  it("exits on Escape", async () => {
    grantLock();
    const onExit = vi.fn();
    walk = createWalk(dom, camera, { onExit });
    await walk.enter();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", bubbles: true }));
    expect(walk.active).toBe(false);
    expect(onExit).toHaveBeenCalled();
  });

  it("notices when the browser drops the lock on its own", async () => {
    // Escape, a tab-out, a permission change. Without listening for this, walk mode stays "on" with no lock: the
    // keys still move the camera, the mouse no longer turns it, and nothing says why.
    grantLock();
    const onExit = vi.fn();
    walk = createWalk(dom, camera, { onExit });
    await walk.enter();
    expect(walk.active).toBe(true);

    Object.defineProperty(document, "pointerLockElement", { value: null, writable: true, configurable: true });
    document.dispatchEvent(new Event("pointerlockchange"));

    expect(walk.active).toBe(false);
    expect(onExit).toHaveBeenCalled();
  });

  it("is idempotent", async () => {
    grantLock();
    const onExit = vi.fn();
    walk = createWalk(dom, camera, { onExit });
    await walk.enter();
    walk.exit();
    walk.exit();
    // Once, not twice. A host that closes a panel in `onExit` would otherwise close it again, or throw.
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("releases its listeners on dispose", async () => {
    grantLock();
    walk = createWalk(dom, camera);
    await walk.enter();
    walk.dispose();

    const start = camera.position.clone();
    press("KeyW");
    walk.update(1);
    expect(camera.position.distanceTo(start)).toBeCloseTo(0, 6);
  });
});
