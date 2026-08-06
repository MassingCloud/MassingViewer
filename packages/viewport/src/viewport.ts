import * as THREE from "three";
import { frameLoop } from "./raf";
import { attachPixelGovernor, initialState } from "./pixelGovernor";
import { decideResize, observeSize, type Size } from "./resize";
import { buildScene, disposeScene, elementIndex, type BuildResult, type GuidResolver, type SourceMesh } from "./meshes";
import type { ModelId } from "@massingviewer/core";

/**
 * The 3D viewport.
 *
 * Imperative three.js, not react-three-fiber. The reconciler adds indirection in the hottest path in the
 * application, and the viewport's lifecycle (build a scene, orbit it, dispose it) does not benefit from
 * declarative reconciliation. `docs/adr/0006-react-shell-vanilla-core.md` has the reasoning; the practical
 * consequence is that this file is usable from massing's vanilla-DOM app unchanged.
 *
 * ## Renders from meshes, not from a streaming format
 *
 * Input is `SourceMesh[]` — tessellated element geometry with expressIDs. That is what the parse layer
 * produces offline, so the whole read path works with no server and no WASM streaming format. massing's
 * viewer streams `.frag` tiles instead, which requires a server-side converter, SharedArrayBuffer, and
 * COOP/COEP headers; none of that can exist in a standalone offline app. When `RemoteKernel` lands, a
 * `.frag` source becomes a second loader behind the same interface rather than a different viewport.
 */
export interface ViewportOptions {
  readonly container: HTMLElement;
  /** Cap on device pixel ratio. Above ~2 the cost is real and the difference is not. */
  readonly maxPixelRatio?: number;
  readonly background?: number;
}

export interface Viewport {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  /** Replace the model. Disposes the previous one — see the note in `meshes.ts` about GPU allocations. */
  showModel(meshes: readonly SourceMesh[], resolveGuid: GuidResolver, modelId: ModelId): BuildResult;
  /** Frame the whole model, or the current selection when there is one. */
  fit(target?: THREE.Box3): void;
  /** Pick the element under a pointer event, or null. */
  pick(event: { clientX: number; clientY: number }): { expressId: number; guid: string | null } | null;
  select(expressIds: readonly number[]): void;
  readonly selection: readonly number[];
  onSelect(fn: (expressIds: readonly number[]) => void): () => void;
  readonly stats: () => { triangles: number; drawCalls: number; geometries: number; textures: number; fps: number };
  dispose(): void;
}

const SELECTION_COLOR = new THREE.Color(0.15, 0.55, 1.0);

export function createViewport(options: ViewportOptions): Viewport {
  const { container } = options;

  // --- renderer -------------------------------------------------------------------------------------
  //
  // `antialias: true` rather than a post-process pass: MSAA is free on modern GPUs and a viewport full of
  // architectural edges is the worst case for aliasing.
  //
  // `preserveDrawingBuffer` is deliberately left OFF. It costs memory on every frame, and it is only needed
  // to read pixels after the fact. Capture code must instead render one fresh frame and read immediately —
  // massing's hero-capture documents this, and the visual-regression harness depends on it.
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setClearColor(options.background ?? 0x1a1d21, 1);
  renderer.shadowMap.enabled = false; // shadows are an env-tools concern, not a walking-skeleton one
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 5000);
  camera.position.set(14, 10, 14);
  camera.lookAt(0, 1.5, 0);

  // Hemisphere + directional rather than a single light: a building lit from one direction has faces that go
  // pure black, which reads as missing geometry.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(1, 2, 1.5);
  scene.add(sun);

  const grid = new THREE.GridHelper(60, 60, 0x2f3540, 0x23272d);
  grid.position.y = -0.001; // just below zero, so it does not z-fight a slab sitting on the datum
  scene.add(grid);

  const modelRoot = new THREE.Group();
  scene.add(modelRoot);

  // --- sizing ---------------------------------------------------------------------------------------

  let size: Size = { width: 1, height: 1 };
  const maxRatio = options.maxPixelRatio ?? Math.min(window.devicePixelRatio || 1, 2);
  let governor = initialState(maxRatio);

  function applySize(to: Size) {
    size = to;
    camera.aspect = to.width / to.height;
    camera.updateProjectionMatrix();
    renderer.setSize(to.width, to.height, false);
  }

  // Measure once at construction, and keep watching.
  //
  // The initial measurement is routinely useless — 0 before layout, or implausibly small in a pane that is
  // not compositing yet. Both are run through the same `decideResize` the observer uses, rather than a
  // separate `> 0` check here, so there is exactly one definition of "a size worth applying". A second,
  // looser check at construction is how the observer's guard gets bypassed by the very first measurement.
  const initial = decideResize({ width: 0, height: 0 }, { width: container.clientWidth, height: container.clientHeight });
  applySize(initial.act === "resize" ? initial.to : { width: 800, height: 600 });
  const stopObserving = observeSize(container, () => size, applySize);

  // Belt and braces for the non-compositing case. `ResizeObserver` delivery is part of the rendering
  // lifecycle, so a hidden or backgrounded page never gets the callback that would correct a bad initial
  // measurement — which is precisely how a parsed-but-invisible model happens. One deferred re-measure costs
  // nothing and closes that window.
  queueMicrotask(() => {
    const late = decideResize(size, { width: container.clientWidth, height: container.clientHeight });
    if (late.act === "resize") applySize(late.to);
  });

  // --- frame loop -----------------------------------------------------------------------------------

  let alive = true;
  let frames = 0;
  let fps = 0;
  let lastFpsAt = 0;
  let lastFrameAt = 0;

  // The governor watches frame time and drops device pixel ratio when the GPU falls behind, recovering it
  // when there is headroom. It owns its own state internally; ours is only kept so `stats()` can report the
  // current ratio without reaching inside it.
  renderer.setPixelRatio(governor.ratio);
  const detachGovernor = attachPixelGovernor(
    {
      setPixelRatio: (r: number) => {
        governor = { ...governor, ratio: r };
        renderer.setPixelRatio(r);
      },
    },
    { raf: (cb) => requestAnimationFrame(cb), caf: (h) => cancelAnimationFrame(h) },
    () => performance.now(),
    maxRatio,
  );

  // --- orbit ----------------------------------------------------------------------------------------
  //
  // A small hand-rolled orbit controller rather than three's OrbitControls addon. Not NIH: the addon is an
  // examples/jsm module whose path and API have moved between three versions, and pinning it is one more
  // coupling in a stack that already has a version-parity gate. This is ~60 lines and does what a CAD
  // viewport needs — orbit, pan, dolly, with the target as the pivot so orbit-around-selection is trivial.
  const controls = createOrbit(renderer.domElement, camera, new THREE.Vector3(4, 1.2, 3));

  const stopLoop = frameLoop(
    () => {
      const now = performance.now();
      if (lastFrameAt !== 0) {
        frames++;
        if (now - lastFpsAt > 500) {
          fps = Math.round((frames * 1000) / (now - lastFpsAt));
          frames = 0;
          lastFpsAt = now;
        }
      } else {
        lastFpsAt = now;
      }
      lastFrameAt = now;
      controls.update();
      renderer.render(scene, camera);
    },
    () => alive,
  );

  // --- model ----------------------------------------------------------------------------------------

  let current: BuildResult | null = null;
  let index = { byLocalId: new Map(), byExpressId: new Map() } as ReturnType<typeof elementIndex>;
  let selection: number[] = [];
  const originalColors = new Map<number, THREE.Color>();
  const selectListeners = new Set<(ids: readonly number[]) => void>();

  function showModel(meshes: readonly SourceMesh[], resolveGuid: GuidResolver, modelId: ModelId) {
    if (current) {
      modelRoot.remove(current.group);
      disposeScene(current);
      originalColors.clear();
      selection = [];
    }
    current = buildScene(meshes, resolveGuid, { modelId });
    index = elementIndex(current);
    modelRoot.add(current.group);
    fit(current.bounds);
    return current;
  }

  function fit(target?: THREE.Box3) {
    const box = target ?? current?.bounds;
    if (!box || box.isEmpty()) return;
    const centre = box.getCenter(new THREE.Vector3());
    const radius = box.getBoundingSphere(new THREE.Sphere()).radius || 1;
    // 1.6x the radius over tan(half-fov) puts the whole sphere in frame with a margin that does not feel
    // cramped. Straight trigonometry beats a magic multiplier that breaks when the fov changes.
    const dist = (radius * 1.6) / Math.tan((camera.fov * Math.PI) / 360);
    const dir = new THREE.Vector3(1, 0.75, 1).normalize();
    camera.position.copy(centre).addScaledVector(dir, dist);
    controls.setTarget(centre);
    camera.near = Math.max(0.01, dist / 1000);
    camera.far = dist * 20;
    camera.updateProjectionMatrix();
  }

  const raycaster = new THREE.Raycaster();
  function pick(event: { clientX: number; clientY: number }) {
    if (!current) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -(((event.clientY - rect.top) / rect.height) * 2 - 1),
    );
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(current.group.children, false);
    const hit = hits[0];
    if (!hit) return null;
    const expressId = hit.object.userData.expressId as number | undefined;
    if (typeof expressId !== "number") return null;
    return { expressId, guid: (hit.object.userData.guid as string | null) ?? null };
  }

  function select(expressIds: readonly number[]) {
    // Restore previous selection colours first, so overlapping selections do not leave a stuck highlight.
    for (const id of selection) {
      const el = index.byExpressId.get(id);
      const original = originalColors.get(id);
      if (el && original) (el.object.material as THREE.MeshLambertMaterial).color.copy(original);
    }
    selection = [...expressIds];
    for (const id of selection) {
      const el = index.byExpressId.get(id);
      if (!el) continue;
      const material = el.object.material as THREE.MeshLambertMaterial;
      if (!originalColors.has(id)) originalColors.set(id, material.color.clone());
      material.color.copy(SELECTION_COLOR);
    }
    for (const fn of selectListeners) fn(selection);
  }

  return {
    scene,
    camera,
    renderer,
    showModel,
    fit,
    pick,
    select,
    get selection() {
      return selection;
    },
    onSelect(fn) {
      selectListeners.add(fn);
      return () => selectListeners.delete(fn);
    },
    stats: () => ({
      triangles: current?.triangles ?? 0,
      drawCalls: renderer.info.render.calls,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      fps,
    }),
    dispose() {
      // Order matters. Stop the loop before disposing the renderer, or the next scheduled frame renders
      // into a disposed context — which throws asynchronously from a place with no useful stack.
      alive = false;
      stopLoop();
      detachGovernor();
      stopObserving();
      controls.dispose();
      if (current) {
        modelRoot.remove(current.group);
        disposeScene(current);
        current = null;
      }
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.domElement.remove();
      selectListeners.clear();
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Orbit / pan / dolly
// ---------------------------------------------------------------------------------------------------

interface Orbit {
  update(): void;
  setTarget(v: THREE.Vector3): void;
  dispose(): void;
}

function createOrbit(dom: HTMLElement, camera: THREE.PerspectiveCamera, target: THREE.Vector3): Orbit {
  let dragging: "orbit" | "pan" | null = null;
  let lastX = 0;
  let lastY = 0;
  const t = target.clone();

  const onDown = (e: PointerEvent) => {
    // Middle button or shift+left pans, matching every CAD tool the user has already learned.
    dragging = e.button === 1 || e.shiftKey ? "pan" : "orbit";
    lastX = e.clientX;
    lastY = e.clientY;
    dom.setPointerCapture(e.pointerId);
  };
  const onUp = (e: PointerEvent) => {
    dragging = null;
    if (dom.hasPointerCapture(e.pointerId)) dom.releasePointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    const offset = camera.position.clone().sub(t);
    if (dragging === "orbit") {
      const spherical = new THREE.Spherical().setFromVector3(offset);
      spherical.theta -= dx * 0.005;
      // Clamp phi off the poles. At exactly 0 or PI the up-vector degenerates and the camera flips, which
      // feels like the viewport broke.
      spherical.phi = Math.max(0.05, Math.min(Math.PI - 0.05, spherical.phi - dy * 0.005));
      offset.setFromSpherical(spherical);
      camera.position.copy(t).add(offset);
    } else {
      // Pan in the camera's own plane, scaled by distance so the model tracks the cursor at any zoom.
      const scale = offset.length() * 0.0015;
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
      const shift = right.multiplyScalar(-dx * scale).add(up.multiplyScalar(dy * scale));
      camera.position.add(shift);
      t.add(shift);
    }
    camera.lookAt(t);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const offset = camera.position.clone().sub(t);
    // Multiplicative dolly: each notch is a constant *fraction* of the current distance, so zooming feels
    // the same whether you are 2 m or 200 m out. Additive zoom either crawls or overshoots.
    const factor = Math.exp(Math.sign(e.deltaY) * 0.12);
    const len = Math.max(0.2, Math.min(4000, offset.length() * factor));
    camera.position.copy(t).add(offset.setLength(len));
  };

  dom.addEventListener("pointerdown", onDown);
  dom.addEventListener("pointerup", onUp);
  dom.addEventListener("pointercancel", onUp);
  dom.addEventListener("pointermove", onMove);
  dom.addEventListener("wheel", onWheel, { passive: false });

  return {
    update() {
      /* no damping yet — the camera is updated directly on input */
    },
    setTarget(v) {
      t.copy(v);
      camera.lookAt(t);
    },
    dispose() {
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointerup", onUp);
      dom.removeEventListener("pointercancel", onUp);
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("wheel", onWheel);
    },
  };
}
