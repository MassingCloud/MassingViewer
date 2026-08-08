import * as THREE from "three";

/**
 * First-person walk.
 *
 * ## The duplicate this resolves, and how
 *
 * The M9 seam recorded this gap with an unusual reason: **massing has two walk tools**, both 🚶, both installed,
 * sitting next to each other. `envTools` drives the camera per frame and you drag to look; the later R17
 * `walkMode` takes a pointer lock and exits on Escape. `toolbarLayout.ts` records that as a real finding and
 * leaves which is canonical unresolved, because deciding is a behaviour change rather than a layout one.
 *
 * Porting either one would have been picking for them. So this is neither: it is **one** implementation, built
 * here, and when massing adopts it both of its walk tools are deleted. That makes the open question moot instead
 * of answering it — which is the only move available that does not quietly overrule a decision recorded as
 * someone else's.
 *
 * It takes the pointer-lock approach, and that part *is* a choice: a drag-to-look camera cannot express "turn
 * around" without running out of screen, and it fights the orbit controls for the same gesture. Pointer lock has
 * one real cost — it needs a user gesture and can be refused — so refusal is a reported state rather than an
 * assumption.
 *
 * ## Eye height is not a detail
 *
 * 1.6 m, and it matters more than it sounds: walking a model is how somebody checks whether a soffit is too low
 * or a handrail is at the wrong height, and a camera at 1.0 m makes everything look generous. It is the one
 * number in this file that a reviewer would notice being wrong.
 */

export interface WalkOptions {
  /** Metres per second. 1.4 is an ordinary walking pace, which is the point of walking rather than flying. */
  readonly speed?: number;
  /** Eye height above the floor plane, metres. */
  readonly eyeHeight?: number;
  /** Called when walk mode ends, including when the browser exits pointer lock on its own. */
  readonly onExit?: () => void;
  /** Called when pointer lock is refused, so a host can say why rather than appearing to do nothing. */
  readonly onRefused?: (reason: string) => void;
}

export interface WalkController {
  /** Enter walk mode. Must be called from a user gesture, or the browser refuses the lock. */
  enter(): Promise<boolean>;
  exit(): void;
  readonly active: boolean;
  /** Advance by `dt` seconds. Called from the render loop; a no-op when inactive. */
  update(dt: number): void;
  readonly eyeHeight: number;
  dispose(): void;
}

const KEYS = new Map<string, readonly [number, number]>([
  // [strafe, forward]. WASD and the arrows, because a model reviewer is not necessarily a gamer.
  ["KeyW", [0, 1]],
  ["ArrowUp", [0, 1]],
  ["KeyS", [0, -1]],
  ["ArrowDown", [0, -1]],
  ["KeyA", [-1, 0]],
  ["ArrowLeft", [-1, 0]],
  ["KeyD", [1, 0]],
  ["ArrowRight", [1, 0]],
]);

export function createWalk(
  dom: HTMLElement,
  camera: THREE.PerspectiveCamera,
  options: WalkOptions = {},
): WalkController {
  const speed = options.speed ?? 1.4;
  const eyeHeight = options.eyeHeight ?? 1.6;
  const held = new Set<string>();

  let active = false;
  /** Yaw and pitch, radians. Held explicitly rather than read back from the camera's quaternion. */
  let yaw = 0;
  let pitch = 0;
  /** Where the camera was before entering, so exiting returns you rather than stranding you. */
  let saved: { position: THREE.Vector3; quaternion: THREE.Quaternion } | null = null;

  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();

  function onMouseMove(event: MouseEvent): void {
    if (!active) return;
    // Movement deltas, not absolute positions: under pointer lock the cursor does not move, so `clientX` is
    // frozen and only `movementX` reports anything.
    yaw -= event.movementX * 0.0022;
    pitch -= event.movementY * 0.0022;
    // Clamped just short of vertical. Reaching exactly ±90° makes the yaw axis degenerate and the view rolls,
    // which is the classic FPS camera bug.
    const limit = Math.PI / 2 - 0.01;
    pitch = Math.max(-limit, Math.min(limit, pitch));
    camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ"));
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!active) return;
    if (event.code === "Escape") {
      exit();
      return;
    }
    if (KEYS.has(event.code)) {
      held.add(event.code);
      // Cancelled so the arrows do not scroll the page underneath while walking.
      event.preventDefault();
    }
  }

  function onKeyUp(event: KeyboardEvent): void {
    held.delete(event.code);
  }

  /**
   * The browser can exit pointer lock without us — Escape, tab-out, a permission change.
   *
   * Listening for it is what keeps `active` honest. Without this, walk mode stays "on" with no pointer lock: the
   * keys still move the camera, the mouse no longer turns it, and nothing says why.
   */
  function onLockChange(): void {
    if (active && document.pointerLockElement !== dom) exit();
  }

  function exit(): void {
    if (!active) return;
    active = false;
    held.clear();
    if (document.pointerLockElement === dom) document.exitPointerLock();
    if (saved !== null) {
      camera.position.copy(saved.position);
      camera.quaternion.copy(saved.quaternion);
      saved = null;
    }
    options.onExit?.();
  }

  document.addEventListener("pointerlockchange", onLockChange);
  document.addEventListener("mousemove", onMouseMove);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  return {
    async enter() {
      if (active) return true;
      try {
        // `requestPointerLock` returns a promise in current browsers and undefined in older ones, so it is
        // awaited defensively rather than assumed to be either.
        await Promise.resolve(dom.requestPointerLock());
      } catch (error) {
        // Refused rather than thrown at the caller: this needs a user gesture, and a permissions policy or a
        // recent Escape can deny it. Reporting it lets a host say so instead of appearing to ignore the click.
        options.onRefused?.(error instanceof Error ? error.message : "pointer lock was refused");
        return false;
      }
      if (document.pointerLockElement !== dom) {
        options.onRefused?.("pointer lock was not granted — walk mode needs a click on the viewport first");
        return false;
      }

      saved = { position: camera.position.clone(), quaternion: camera.quaternion.clone() };
      // Derive yaw from where the camera was already looking, so entering walk mode does not spin you round.
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      yaw = Math.atan2(-dir.x, -dir.z);
      pitch = 0;
      camera.position.y = eyeHeight;
      camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ"));
      active = true;
      return true;
    },

    exit,

    get active() {
      return active;
    },

    update(dt) {
      if (!active || held.size === 0) return;
      let strafe = 0;
      let ahead = 0;
      for (const code of held) {
        const axis = KEYS.get(code);
        if (axis === undefined) continue;
        strafe += axis[0];
        ahead += axis[1];
      }
      if (strafe === 0 && ahead === 0) return;

      camera.getWorldDirection(forward);
      // Flattened: looking up must not fly you upwards. Walking is the whole point, and a camera that drifts off
      // the floor when you glance at a ceiling stops being a check on head height.
      forward.y = 0;
      forward.normalize();
      right.crossVectors(camera.up, forward).normalize().negate();

      // Normalised, so diagonal movement is not 41% faster — the oldest bug in first-person controls.
      const length = Math.hypot(strafe, ahead);
      const step = speed * dt;
      camera.position.addScaledVector(forward, (ahead / length) * step);
      camera.position.addScaledVector(right, (strafe / length) * step);
      // Height is held, not integrated: there is no gravity here, and letting Y drift would slowly sink the
      // camera through the floor over a long walk.
      camera.position.y = eyeHeight;
    },

    eyeHeight,

    dispose() {
      exit();
      document.removeEventListener("pointerlockchange", onLockChange);
      document.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    },
  };
}
