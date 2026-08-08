// @massingviewer/authoring — the missing middle.
//
// `seamCoverage()` listed snapping, the prompt loop, the section box and markup pins as four separate M9 gaps.
// Reading their reasons, they shared one cause: every library underneath already existed and was tested, and
// nothing connected them. There was no object that knew a tool was armed, held the half-collected argument bag,
// and turned a cursor position into a resolved point.
//
// Two properties carry the design:
//
//   - **Snapping runs before the reducer.** `resolveSnap`/`polarConstrain`/`applyDynamicInput` produce the `at`
//     on a `pick-point`, so snapping stays frame-immediate and the reducer stays deterministic — which is what
//     makes a recorded macro a regression test rather than a recording of one machine's timing.
//   - **`hover` and `pick` resolve through one function.** What the crosshair shows is what the click commits,
//     structurally, rather than as something to remember.
//
// No DOM, no renderer, no kernel. Snap candidates arrive through a callback, because the host owns the model.

export { ALL_OVERRIDE_KINDS, DEFAULT_SNAP, KEY_SHORTCUT_MAP, OVERRIDE_CODES, OVERRIDE_LABEL, createSession } from "./session.js";
export type {
  ArmOutcome,
  AuthoringSession,
  HoverFeedback,
  Modifiers,
  SessionDeps,
  SessionState,
  SnapSettings,
  StepOutcome,
} from "./session.js";
