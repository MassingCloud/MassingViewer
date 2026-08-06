// @massingviewer/viewport — the only package permitted to import `three`.
//
// That confinement is enforced by scripts/check-architecture.mjs, and it is not a style rule: massing's
// vite config documents `resolve.dedupe: ["three"]` because "Multiple instances of Three.js" was a measured
// failure there. Two copies in one bundle produce objects that fail each other's `instanceof` checks, and
// the symptom is geometry that silently refuses to render.

export { createViewport } from "./viewport";
export type { Viewport, ViewportOptions } from "./viewport";

export { buildScene, disposeScene, elementIndex } from "./meshes";
export type { SourceMesh, SceneElement, BuildResult, GuidResolver } from "./meshes";

// The zero-width-canvas guard. Exported because it is pure, and because the failure it prevents was
// misdiagnosed upstream for weeks as a stalled loader — see the comment in resize.ts.
export { decideResize, observeSize } from "./resize";
export type { Size, ResizeDecision } from "./resize";

// Frame-loop and adaptive-resolution primitives, ported from massing.
export { coalesced, frameLoop } from "./raf";
export type { FrameApi, Coalesced } from "./raf";
export {
  RATIO_STEPS,
  DEFAULT_OPTS,
  snapRatio,
  shadowFrustum,
  texelSize,
  step as governorStep,
  initialState as governorInitialState,
  attachPixelGovernor,
} from "./pixelGovernor";
export type { GovernorOpts, GovernorState } from "./pixelGovernor";
