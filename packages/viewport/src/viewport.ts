import * as THREE from "three";
import { createRenderer, type RendererChoice, type WebGpuProbe } from "./renderer.js";
import { createSection, type SectionController } from "./section.js";
import { createWalk, type WalkController, type WalkOptions } from "./walk.js";
import { frameLoop } from "./raf.js";
import { attachPixelGovernor, initialState } from "./pixelGovernor.js";
import { decideResize, observeSize, type Size } from "./resize.js";
import { buildScene, disposeScene, elementIndex, type BuildResult, type GuidResolver, type SourceMesh } from "./meshes.js";
import type { ModelId } from "@massing/core";

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
  /** Walk-mode tuning. Eye height in particular: 1.6 m is what makes a low soffit look low.*/
  readonly walk?: WalkOptions;
  /**
   * How to decide whether WebGPU is usable. Injectable, and the default is the browser.
   *
   * Present so a test can drive the fallback branch — an adapter that is advertised and then refuses to
   * initialise is the case the fallback exists for, and it needs hardware no CI runner has. See `renderer.ts`.
   */
  readonly webGpuProbe?: WebGpuProbe;
  readonly container: HTMLElement;
  /** Cap on device pixel ratio. Above ~2 the cost is real and the difference is not. */
  readonly maxPixelRatio?: number;
  readonly background?: number;
  /**
   * Accessible name for the canvas.
   *
   * Overridable because a host that knows *what* it is showing can say so — "Tower-A, level 3" is a far more
   * useful announcement than the generic default, and only the host knows it. The default is never empty, so
   * forgetting this leaves the canvas labelled rather than anonymous.
   */
  readonly label?: string;
}

export interface Viewport {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  /**
   * Which rendering backend is in use, and why.
   *
   * Exposed rather than kept internal because ADR-0012 makes surfacing it a requirement, not polish: *"a silent
   * WebGL fallback means a user reports 'it's slow on my iPad' and nobody can tell whether the fast path ever
   * engaged."* A host is expected to show `reason` and count `backend`.
   */
  readonly backend: RendererChoice;
  /**
   * Replace the whole scene with one model. Disposes the previous ones — see the note in `meshes.ts` about GPU
   * allocations.
   *
   * Kept for hosts that only ever hold one model. For federation use {@link Viewport.addModel}.
   */
  showModel(meshes: readonly SourceMesh[], resolveGuid: GuidResolver, modelId: ModelId): BuildResult;

  /**
   * Add a model, leaving the others alone — ADR-0013's federation.
   *
   * Re-adding the same `modelId` replaces **that** model only, which is what a consultant reissuing their
   * structural file needs: it must not clear the architectural model beside it.
   */
  addModel(meshes: readonly SourceMesh[], resolveGuid: GuidResolver, modelId: ModelId): BuildResult;
  /** Remove one model and free its GPU buffers. False if there was nothing by that id. */
  removeModel(modelId: ModelId): boolean;
  /** Loaded model ids, in the order they were added. */
  readonly models: readonly ModelId[];
  /** Hide or show one model. Hidden means hidden to the pointer too. */
  setModelVisible(modelId: ModelId, visible: boolean): boolean;
  /** Site-to-project alignment, per model, as a group matrix rather than baked into geometry. */
  setModelTransform(modelId: ModelId, matrix: THREE.Matrix4): boolean;
  /** Whether a model is currently visible. `null` if there is no such model. */
  isModelVisible(modelId: ModelId): boolean | null;

  /** Frame every visible model, or the given box. */
  fit(target?: THREE.Box3): void;
  /**
   * Pick the element under a pointer event, or null.
   *
   * `modelId` comes back because with several models loaded an expressId alone no longer identifies an element —
   * ADR-0013 keys cross-boundary identity on `(modelId, guid)`.
   */
  pick(event: {
    clientX: number;
    clientY: number;
  }): { expressId: number; guid: string | null; modelId: ModelId | null } | null;
  /**
   * Highlight elements.
   *
   * `modelId` is optional and should be supplied whenever it is known — `pick()` returns it. Omitting it selects the
   * id in *every* model that contains it, because an expressId is unique only within one IFC file and choosing
   * arbitrarily between two valid matches would be an invisible coin toss. Unchanged for a single-model host.
   */
  select(expressIds: readonly number[], modelId?: ModelId): void;
  /**
   * Interactive clipping — a plane or a box.
   *
   * Distinct from `drawings2d`'s cutting, and the distinction matters: this *hides* fragments, so the cut face is
   * hollow. A capped section is a drawing, not a view state.
   */
  readonly section: SectionController;
  /** First-person walk. One implementation, so massing can delete both of its two. */
  readonly walk: WalkController;
  readonly selection: readonly number[];
  onSelect(fn: (expressIds: readonly number[]) => void): () => void;
  readonly stats: () => { triangles: number; drawCalls: number; geometries: number; textures: number; fps: number };
  dispose(): void;
}

const SELECTION_COLOR = new THREE.Color(0.15, 0.55, 1.0);

/**
 * Build a viewport.
 *
 * **Async since 2026-08-10, and that is the whole cost of ADR-0012**: `WebGPURenderer.init()` returns a promise, so
 * the renderer cannot be constructed synchronously. The ripple reaches `createMassingViewer` and therefore massing's
 * integration, which is why federation (ADR-0013) is batched with it — one breaking change for the consumer instead
 * of two.
 */
export async function createViewport(options: ViewportOptions): Promise<Viewport> {
  const { container } = options;

  // --- renderer -------------------------------------------------------------------------------------
  //
  // `antialias: true` rather than a post-process pass: MSAA is free on modern GPUs and a viewport full of
  // architectural edges is the worst case for aliasing.
  //
  // `preserveDrawingBuffer` is deliberately left OFF. It costs memory on every frame, and it is only needed
  // to read pixels after the fact. Capture code must instead render one fresh frame and read immediately —
  // massing's hero-capture documents this, and the visual-regression harness depends on it.
  // WebGPU when the host can, WebGL2 otherwise, and the choice is reported rather than inferred. The WebGL
  // construction stays here — including the `antialias`/`preserveDrawingBuffer` reasoning above — and is passed to
  // the seam as the fallback, so the two renderers cannot drift in how they are configured.
  const { renderer, choice: backend } = await createRenderer(
    options.webGpuProbe,
    () => new THREE.WebGLRenderer({ antialias: true, alpha: false }),
  );
  renderer.setClearColor(options.background ?? 0x1a1d21, 1);
  renderer.shadowMap.enabled = false; // shadows are an env-tools concern, not a walking-skeleton one
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";

  /**
   * The canvas gets a name and a role, because "a screen reader cannot see inside WebGL" is not a reason to
   * leave the element itself anonymous.
   *
   * `role="img"` with a label is the honest description: this is one graphic whose *contents* are unavailable to
   * assistive technology. `role="application"` would be a lie in the other direction — it tells a screen reader
   * to surrender its own key handling because the element implements a full keyboard interface, and this one
   * does not. `docs/accessibility.md` states the limit and names the alternative rather than papering over it.
   *
   * `tabindex="0"` so the canvas is reachable: orbit and walk both bind keys, and a control you cannot focus is
   * a control a keyboard user does not have. Set here rather than in the app, so every host gets it — this
   * package is the only one that owns the canvas.
   */
  renderer.domElement.setAttribute("role", "img");
  renderer.domElement.setAttribute(
    "aria-label",
    options.label ?? "3D model view. Drag to orbit, shift-drag to pan, scroll to zoom.",
  );
  renderer.domElement.tabIndex = 0;

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
  const section = createSection(renderer, modelRoot);
  const walk = createWalk(renderer.domElement, camera, options.walk);

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
      /**
       * Walk before the orbit controls, and with a real `dt`.
       *
       * The `dt` is what makes movement frame-rate independent. A fixed step per frame walks twice as fast on a
       * 120 Hz display as on a 60 Hz one — and the pixel governor here *deliberately* varies the frame rate under
       * load, so a fixed step would make walking speed depend on how heavy the model is.
       *
       * Clamped, because `dt` after a tab has been backgrounded is however long the tab was hidden. Without the
       * clamp, returning to a tab teleports the camera through the building.
       */
      const dt = lastFrameAt === 0 ? 0 : Math.min((now - lastFrameAt) / 1000, 0.1);
      lastFrameAt = now;
      walk.update(dt);
      // Skipped while walking: the orbit controls would fight the first-person camera for the same state, and
      // the visible result is a view that snaps back the instant you move.
      if (!walk.active) controls.update();
      renderer.render(scene, camera);
    },
    () => alive,
  );

  // --- model ----------------------------------------------------------------------------------------

  /**
   * The model registry — ADR-0013's federation, as a keyed map rather than one `current`.
   *
   * A `Map` keyed by `ModelId`, insertion-ordered, so "architectural then structural" survives round-tripping and a
   * host is not forced to re-sort for display. Per-model state lives **beside the build** rather than being inferred
   * from the scene graph, which is the ADR's point: *"avoid naive layering via generic scene groups alone."*
   * "Is this model hidden" is then a lookup, not a traversal.
   */
  interface Loaded {
    readonly build: BuildResult;
    readonly index: ReturnType<typeof elementIndex>;
    visible: boolean;
  }
  const models = new Map<ModelId, Loaded>();

  /**
   * Selection is held as `(modelId, expressId)` pairs, not bare expressIds.
   *
   * An expressId is only unique *within* an IFC file, so two federated models routinely both contain `#1`. Keying
   * selection or cached colours on the number alone means model B's restore writes model A's colour, and there is no
   * symptom until two disciplines are loaded at once — which is exactly when nobody is looking at the highlight code.
   *
   * This replaced a single `index` variable that pointed at *the only* model, and was therefore an empty map whenever
   * two models were loaded: `select()` silently recoloured nothing while still updating `selection` and notifying
   * listeners. Resolving per model removes the possibility rather than fixing the symptom.
   */
  interface ElementRef {
    readonly modelId: ModelId;
    readonly expressId: number;
  }
  let selected: ElementRef[] = [];
  const originalColors = new Map<string, THREE.Color>();
  const selectListeners = new Set<(ids: readonly number[]) => void>();
  const colorKey = (ref: ElementRef): string => `${JSON.stringify(ref.modelId)}:${ref.expressId}`;

  /** Union of every *visible* model's bounds — what `fit()` frames when nothing is selected. */
  function federatedBounds(): THREE.Box3 {
    const box = new THREE.Box3();
    for (const loaded of models.values()) {
      if (loaded.visible && !loaded.build.bounds.isEmpty()) box.union(loaded.build.bounds);
    }
    return box;
  }

  /**
   * Add a model without disturbing the others.
   *
   * Re-adding the same `modelId` **replaces** that one model and leaves the rest alone. That is deliberate: a
   * consultant reissuing their structural file is the ordinary case, and it must not clear the architectural model
   * beside it. `showModel` keeps the old whole-scene semantics for callers that only ever hold one.
   */
  function addModel(meshes: readonly SourceMesh[], resolveGuid: GuidResolver, modelId: ModelId): BuildResult {
    const existing = models.get(modelId);
    if (existing !== undefined) removeModel(modelId);

    const build = buildScene(meshes, resolveGuid, { modelId });
    const loaded: Loaded = { build, index: elementIndex(build), visible: existing?.visible ?? true };
    models.set(modelId, loaded);
    build.group.visible = loaded.visible;
    modelRoot.add(build.group);
    // A rebuild creates new materials, and new materials carry no clipping planes. Without this the first edit
    // after setting a section would silently clear it — and the user would blame the edit, not the reload.
    section.reapply(build.group);

    return build;
  }

  /** Remove one model and free its GPU buffers. Returns false if there was nothing by that id. */
  function removeModel(modelId: ModelId): boolean {
    const loaded = models.get(modelId);
    if (loaded === undefined) return false;
    modelRoot.remove(loaded.build.group);
    disposeScene(loaded.build);
    models.delete(modelId);

    // Selection and cached colours belonging to *this* model referred to geometry that no longer exists. Dropping
    // them is not tidiness: a stale expressId would recolour whichever element later happens to reuse that number.
    // Other models' entries survive, because unloading the structural file must not clear an architectural
    // selection — the bug the old blanket `clear()` had, invisible while only one model could be loaded.
    const dropped = selected.some((ref) => ref.modelId === modelId);
    selected = selected.filter((ref) => ref.modelId !== modelId);
    // Deleting from a Map while iterating its keys is well-defined, so no snapshot copy is needed. The prefix is
    // built the same way `colorKey` builds it, so a model id containing the separator cannot alias another model's.
    const prefix = `${JSON.stringify(modelId)}:`;
    for (const key of originalColors.keys()) {
      if (key.startsWith(prefix)) originalColors.delete(key);
    }
    if (dropped) for (const fn of selectListeners) fn(selectedIds());
    return true;
  }

  /**
   * Per-model visibility.
   *
   * Sets `group.visible`, which also removes it from picking — `intersectObjects` skips invisible objects — so
   * "hidden" means hidden to the pointer too. A federation where you could select through a hidden discipline would
   * be worse than one without visibility at all.
   */
  function setModelVisible(modelId: ModelId, visible: boolean): boolean {
    const loaded = models.get(modelId);
    if (loaded === undefined) return false;
    loaded.visible = visible;
    loaded.build.group.visible = visible;
    return true;
  }

  /**
   * Per-model transform — site-to-project alignment, which is per model by definition.
   *
   * Applied to the model's own group rather than baked into geometry, so re-aligning is free and reversible and the
   * GlobalIds keep pointing at the same vertices. Getting alignment wrong is the classic federation bug; making it a
   * group matrix means it is also the classic federation *fix*.
   */
  function setModelTransform(modelId: ModelId, matrix: THREE.Matrix4): boolean {
    const loaded = models.get(modelId);
    if (loaded === undefined) return false;
    loaded.build.group.matrixAutoUpdate = false;
    loaded.build.group.matrix.copy(matrix);
    loaded.build.group.matrixWorld.copy(matrix);
    loaded.build.group.updateMatrixWorld(true);
    return true;
  }

  /**
   * Replace the whole scene with one model — the pre-federation behaviour, kept exactly.
   *
   * Retained rather than removed because every current caller holds a single model, and changing their semantics in
   * the same release as making the constructor async would be two breaking changes wearing one coat.
   */
  function showModel(meshes: readonly SourceMesh[], resolveGuid: GuidResolver, modelId: ModelId) {
    for (const id of [...models.keys()]) removeModel(id);
    const build = addModel(meshes, resolveGuid, modelId);
    fit(build.bounds);
    return build;
  }

  function fit(target?: THREE.Box3) {
    // Federated: the union of every *visible* model. Framing only the last one loaded would zoom to the structural
    // file and leave the building it belongs to off screen.
    const box = target ?? federatedBounds();
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
    if (models.size === 0) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -(((event.clientY - rect.top) / rect.height) * 2 - 1),
    );
    raycaster.setFromCamera(ndc, camera);
    /**
     * Every visible model, in one raycast, so the nearest hit wins across disciplines rather than within one.
     *
     * `intersectObjects` skips invisible objects, so a hidden model is hidden to the pointer too — a federation you
     * could select through would be worse than one with no visibility control at all. Flattened rather than
     * recursive: element meshes are direct children of each model group, and `recursive: true` would also hit the
     * gizmo and preview helpers that live elsewhere in the scene.
     */
    const candidates: THREE.Object3D[] = [];
    for (const loaded of models.values()) {
      if (loaded.visible) candidates.push(...loaded.build.group.children);
    }
    const hits = raycaster.intersectObjects(candidates, false);
    const hit = hits[0];
    if (!hit) return null;
    const expressId = hit.object.userData.expressId as number | undefined;
    if (typeof expressId !== "number") return null;
    // `modelId` comes back too: with several models loaded, an expressId alone no longer identifies an element, and
    // ADR-0013 keys identity on `(modelId, guid)` for exactly that reason.
    return {
      expressId,
      guid: (hit.object.userData.guid as string | null) ?? null,
      modelId: (hit.object.userData.modelId as ModelId | undefined) ?? null,
    };
  }

  /** The mesh an `(modelId, expressId)` pair names, or null if that model has no such element. */
  function elementOf(ref: ElementRef): { object: THREE.Mesh } | null {
    return models.get(ref.modelId)?.index.byExpressId.get(ref.expressId) ?? null;
  }

  /**
   * Resolve bare expressIds to model-qualified refs.
   *
   * With `modelId` given — which is what `pick()` returns, so precise selection is always available — only that model
   * is consulted. Without it, *every* model containing the id matches. That is the deliberate reading of an ambiguous
   * request: "select element 7" with no model named cannot mean one of two equally-valid elements, and highlighting
   * both is visible, whereas picking one arbitrarily is a coin toss the user cannot see. With a single model loaded —
   * every caller before federation — the two paths are identical.
   */
  function resolveRefs(expressIds: readonly number[], modelId?: ModelId): ElementRef[] {
    const ids = modelId === undefined ? [...models.keys()] : models.has(modelId) ? [modelId] : [];
    const refs: ElementRef[] = [];
    for (const expressId of expressIds) {
      for (const id of ids) {
        if (models.get(id)!.index.byExpressId.has(expressId)) refs.push({ modelId: id, expressId });
      }
    }
    return refs;
  }

  const selectedIds = (): number[] => selected.map((ref) => ref.expressId);

  function select(expressIds: readonly number[], modelId?: ModelId) {
    // Restore previous selection colours first, so overlapping selections do not leave a stuck highlight.
    for (const ref of selected) {
      const el = elementOf(ref);
      const original = originalColors.get(colorKey(ref));
      if (el && original) (el.object.material as THREE.MeshLambertMaterial).color.copy(original);
    }
    selected = resolveRefs(expressIds, modelId);
    for (const ref of selected) {
      const el = elementOf(ref);
      if (!el) continue;
      const material = el.object.material as THREE.MeshLambertMaterial;
      const key = colorKey(ref);
      if (!originalColors.has(key)) originalColors.set(key, material.color.clone());
      material.color.copy(SELECTION_COLOR);
    }
    for (const fn of selectListeners) fn(selectedIds());
  }

  return {
    backend,
    addModel,
    removeModel,
    setModelVisible,
    setModelTransform,
    isModelVisible: (modelId: ModelId) => models.get(modelId)?.visible ?? null,
    get models() {
      return [...models.keys()];
    },
    scene,
    camera,
    renderer,
    showModel,
    fit,
    pick,
    select,
    get selection() {
      // expressIds, so a single-model host sees exactly what it saw before federation. Only ids that actually resolved
      // appear: reporting a selection of geometry that is not loaded is the same class of lie as highlighting nothing
      // and saying it worked.
      return selectedIds();
    },
    onSelect(fn) {
      selectListeners.add(fn);
      return () => selectListeners.delete(fn);
    },
    stats: () => ({
      // Summed across every loaded model, visible or not: the triangles exist on the GPU either way, and a
      // stats panel that under-reports because a discipline is hidden is a stats panel that hides a leak.
      triangles: [...models.values()].reduce((n, m) => n + m.build.triangles, 0),
      drawCalls: renderer.info.render.calls,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      fps,
    }),
    section,
    walk,
    dispose() {
      // Order matters. Stop the loop before disposing the renderer, or the next scheduled frame renders
      // into a disposed context — which throws asynchronously from a place with no useful stack.
      alive = false;
      stopLoop();
      // Before the renderer: `walk.dispose` exits pointer lock, and `section.dispose` touches materials. Both
      // need a live context, and both are cheap — the cost of getting the order wrong is an async throw.
      walk.dispose();
      section.dispose();
      detachGovernor();
      stopObserving();
      controls.dispose();
      // Every model, not just the last one. With a registry, disposing `current` alone would leak the GPU buffers
      // of every other loaded discipline — which is precisely what `e2e/memory.spec.ts` asserts cannot happen.
      for (const id of [...models.keys()]) removeModel(id);
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

/** Distance clamp for the camera, shared by wheel and pinch so they cannot disagree about the limits. */
const MIN_DISTANCE = 0.2;
const MAX_DISTANCE = 4000;

/**
 * Orbit, pan and dolly — mouse *and* touch.
 *
 * ## Why multi-touch is not a nice-to-have here
 *
 * Single-pointer drag arrives as a `pointer` event on a touchscreen too, so orbiting appeared to work on an
 * iPad and the gap went unnoticed. Zooming did not: there is no wheel on a tablet, so with wheel as the only
 * dolly input **an iPad user could not zoom at all**. Safari and iPad support is a stated differentiator for
 * this product — the nearest browser-BIM competitor is Chrome/Edge only and field teams are on iPads — so
 * "cannot change the zoom level" is not a rough edge, it is the platform being unusable.
 *
 * An E2E run on the emulated iPad found it, by failing with "Mouse wheel is not supported in mobile WebKit".
 * That message is about the test, and the honest reading was about the app.
 */
function createOrbit(dom: HTMLElement, camera: THREE.PerspectiveCamera, target: THREE.Vector3): Orbit {
  let dragging: "orbit" | "pan" | null = null;
  let lastX = 0;
  let lastY = 0;
  const t = target.clone();

  /** Every pointer currently down, so a second finger can be recognised as a pinch rather than a jump. */
  const active = new Map<number, { x: number; y: number }>();
  /** Finger separation and midpoint at the last pinch sample. */
  let pinchSpan = 0;
  let pinchX = 0;
  let pinchY = 0;

  /** Multiplicative dolly: `factor` < 1 moves closer. */
  const dolly = (factor: number): void => {
    const offset = camera.position.clone().sub(t);
    const len = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, offset.length() * factor));
    camera.position.copy(t).add(offset.setLength(len));
  };

  /** Pan in the camera's own plane, scaled by distance so the model tracks the pointer at any zoom. */
  const pan = (dx: number, dy: number): void => {
    const scale = camera.position.distanceTo(t) * 0.0015;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
    const shift = right.multiplyScalar(-dx * scale).add(up.multiplyScalar(dy * scale));
    camera.position.add(shift);
    t.add(shift);
  };

  const orbit = (dx: number, dy: number): void => {
    const offset = camera.position.clone().sub(t);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta -= dx * 0.005;
    // Clamp phi off the poles. At exactly 0 or PI the up-vector degenerates and the camera flips, which
    // feels like the viewport broke.
    spherical.phi = Math.max(0.05, Math.min(Math.PI - 0.05, spherical.phi - dy * 0.005));
    offset.setFromSpherical(spherical);
    camera.position.copy(t).add(offset);
  };

  const beginPinch = (): void => {
    const [a, b] = [...active.values()];
    if (!a || !b) return;
    pinchSpan = Math.hypot(a.x - b.x, a.y - b.y);
    pinchX = (a.x + b.x) / 2;
    pinchY = (a.y + b.y) / 2;
  };

  const onDown = (e: PointerEvent) => {
    active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (active.size >= 2) {
      // A second finger cancels the drag it interrupted, rather than letting the remaining finger keep
      // orbiting while the pinch also runs — which reads as the model lurching.
      dragging = null;
      beginPinch();
      return;
    }
    // Middle button or shift+left pans, matching every CAD tool the user has already learned.
    dragging = e.button === 1 || e.shiftKey ? "pan" : "orbit";
    lastX = e.clientX;
    lastY = e.clientY;
    // Throws if the pointer is no longer active — which happens when the pointer was released between the
    // event being queued and this handler running, and for synthesised events. Capture is an optimisation
    // (it keeps a drag alive outside the canvas), so failing to get it must not break the interaction.
    try {
      dom.setPointerCapture(e.pointerId);
    } catch {
      /* not capturable; drag still works while the pointer stays over the canvas */
    }
  };

  const onUp = (e: PointerEvent) => {
    active.delete(e.pointerId);
    if (active.size < 2) pinchSpan = 0;
    if (active.size === 0) dragging = null;
    // A finger lifting from a two-finger gesture leaves one still down. Re-seat the drag origin at its
    // current position, or the next move is interpreted as a jump of the whole gesture's width.
    if (active.size === 1) {
      const [only] = [...active.values()];
      if (only) {
        lastX = only.x;
        lastY = only.y;
      }
    }
    if (dom.hasPointerCapture(e.pointerId)) dom.releasePointerCapture(e.pointerId);
  };

  const onMove = (e: PointerEvent) => {
    if (active.has(e.pointerId)) active.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (active.size >= 2) {
      const [a, b] = [...active.values()];
      if (!a || !b) return;
      const span = Math.hypot(a.x - b.x, a.y - b.y);
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      if (pinchSpan > 0 && span > 0) {
        // Fingers apart → span grows → factor < 1 → closer. The same multiplicative rule as the wheel, so a
        // pinch and a scroll of equivalent size move the camera by the same proportion.
        dolly(pinchSpan / span);
        // Two fingers also pan, which is what every map and CAD app on a tablet does.
        pan(midX - pinchX, midY - pinchY);
      }
      pinchSpan = span;
      pinchX = midX;
      pinchY = midY;
      camera.lookAt(t);
      return;
    }

    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    if (dragging === "orbit") orbit(dx, dy);
    else pan(dx, dy);
    camera.lookAt(t);
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    // Each notch is a constant *fraction* of the current distance, so zooming feels the same whether you are
    // 2 m or 200 m out. Additive zoom either crawls or overshoots.
    dolly(Math.exp(Math.sign(e.deltaY) * 0.12));
  };

  // Without this the browser claims the gesture first: a one-finger drag scrolls the page and a pinch zooms
  // the document, so the canvas sees a `pointercancel` mid-interaction and the model appears to stick.
  dom.style.touchAction = "none";

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
