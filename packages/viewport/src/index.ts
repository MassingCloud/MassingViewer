export { browserWebGpuProbe, createRenderer } from "./renderer.js";
export type { RendererBundle, RendererChoice, WebGpuProbe } from "./renderer.js";
export { createGizmo } from "./gizmo.js";
export type { GizmoCommit, GizmoController, GizmoOptions, HeightDelta, MoveDelta, RotateDelta } from "./gizmo.js";
export { createGrid, createPreview, screenToGround } from "./draft.js";
export type { GridController, GridOptions, GroundPoint, PreviewController, PreviewState } from "./draft.js";
// @massing/viewport — the only package permitted to import `three`.
//
// That confinement is enforced by scripts/check-architecture.mjs, and it is not a style rule: massing's
// vite config documents `resolve.dedupe: ["three"]` because "Multiple instances of Three.js" was a measured
// failure there. Two copies in one bundle produce objects that fail each other's `instanceof` checks, and
// the symptom is geometry that silently refuses to render.

export { createViewport } from "./viewport.js";
export type { Viewport, ViewportOptions } from "./viewport.js";

export { createSection } from "./section.js";
export type { SectionController, SectionMode, SectionState } from "./section.js";

export { createWalk } from "./walk.js";
export type { WalkController, WalkOptions } from "./walk.js";

export { buildScene, disposeScene, elementIndex } from "./meshes.js";
export type { SourceMesh, SceneElement, BuildResult, GuidResolver } from "./meshes.js";

// The zero-width-canvas guard. Exported because it is pure, and because the failure it prevents was
// misdiagnosed upstream for weeks as a stalled loader — see the comment in resize.ts.
export { decideResize, observeSize } from "./resize.js";
export type { Size, ResizeDecision } from "./resize.js";

// Frame-loop and adaptive-resolution primitives, ported from massing.
export { coalesced, frameLoop } from "./raf.js";
export type { FrameApi, Coalesced } from "./raf.js";
export {
  RATIO_STEPS,
  DEFAULT_OPTS,
  snapRatio,
  shadowFrustum,
  texelSize,
  step as governorStep,
  initialState as governorInitialState,
  attachPixelGovernor,
} from "./pixelGovernor.js";
export type { GovernorOpts, GovernorState } from "./pixelGovernor.js";
