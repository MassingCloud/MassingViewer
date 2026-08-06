// @massingviewer/geometry-math — the precision kit.
//
// Everything here is pure: same input, same output, no DOM, no renderer, no network, no clock. That is
// what makes it exhaustively testable, and it is why this layer carries the highest coverage floor in
// the repo — the rest of the app is a shell around these decisions.
//
// Coordinate convention, stated once because getting it wrong is silent: this works in the **world
// X/Z plane**, where plan East = +x and plan North = -z. It is the plane the viewer's ground actually
// lies in, so no conversion happens at the boundary. `Vec2` is `{ x, z }` for that reason and not
// `{ x, y }` — a `y` here would read as height to anyone coming from 3D and as north to anyone coming
// from 2D, and both would be wrong half the time.

// ---------------------------------------------------------------------------------------------------
// Object snapping, polar tracking, dynamic input
// ---------------------------------------------------------------------------------------------------
export {
  resolveSnap,
  perpendicularSnaps,
  nearestSnaps,
  segmentSnaps,
  polarConstrain,
  applyDynamicInput,
} from "./snapEngine";
export type { Vec2, SnapKind, SnapCandidate, SnapResult } from "./snapEngine";

// One-shot snap overrides ("this one pick, take a perpendicular").
export {
  OVERRIDE_CODES,
  OVERRIDE_LABEL,
  ALL_OVERRIDE_KINDS,
  overrideCandidates,
  createSnapOverride,
} from "./snapOverride";
export type { OverrideKind, PlanBox, SnapOverrideHandle } from "./snapOverride";

// ---------------------------------------------------------------------------------------------------
// Drawing inference (on-axis / parallel / perpendicular, without holding a modifier)
// ---------------------------------------------------------------------------------------------------
// `inference` declares its own structurally-identical Vec2; the canonical one is re-exported above, so
// only the members that add something are re-exported here.
export { inferDirection, midpoint } from "./inference";
export type { Inference } from "./inference";

// ---------------------------------------------------------------------------------------------------
// Typed constraint entry — "5 <Tab> 90 <Enter>", and imperial (12'6)
// ---------------------------------------------------------------------------------------------------
export {
  parseDynConstraint,
  isDynKey,
  dynKeystroke,
  formatDynConstraint,
} from "./dynInput";
export type { DynConstraint } from "./dynInput";

// ---------------------------------------------------------------------------------------------------
// Placement validation — refuse before the round-trip, with a reason a human can act on
// ---------------------------------------------------------------------------------------------------
export {
  MIN_RUN_M,
  BOUNDS_MARGIN_M,
  checkRun,
  checkBounds,
  checkPolygon,
  validatePlacement,
} from "./placeValid";
export type { PlanBounds, PlacementVerdict } from "./placeValid";

// ---------------------------------------------------------------------------------------------------
// Per-stroke undo for the point being collected (distinct from document undo)
// ---------------------------------------------------------------------------------------------------
export { DraftPointHistory } from "./draftHistory";

// ---------------------------------------------------------------------------------------------------
// Sun position — shadow studies and daylight, from date + latitude + longitude
// ---------------------------------------------------------------------------------------------------
export { sunAltAz, sunSceneDir } from "./solar";
export type { SunPos } from "./solar";

// ---------------------------------------------------------------------------------------------------
// AutoCAD-style command grammar: `WALL 0,0 @5<0`
// ---------------------------------------------------------------------------------------------------
// This parses a whole one-line command today. The command bus consumes the same token grammar for the
// interactive prompt loop, so a coordinate typed at a "specify next point" prompt and one typed on a
// full command line go through identical code — there is no second parser to drift.
export { cadCommandList, parseCadCommand } from "./cadCommands";
export type { CadRecipeStep, CadParse } from "./cadCommands";

// Two-letter draw-tool codes (WA = wall, CL = column …). Exported from here rather than from a keyboard
// package because `snapOverride.test.ts` asserts these are disjoint from the snap-override codes — both
// are typed into the same buffer, so an overlap silently arms the wrong tool.
export { KEY_SHORTCUTS, KEY_SHORTCUT_MAP } from "./shortcuts";
