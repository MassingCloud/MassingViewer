// @massingviewer/commands — one abstraction, seven features.
//
// Every user action becomes exactly one serializable `CommandInvocation`, including the interactive
// AutoCAD-style prompt loops, which are a PURE REDUCER that accumulates arguments and emits one invocation on
// completion. From that single property: undo/redo, the command palette, the command line, keyboard remapping,
// macro record/replay, the plugin API, and an audit log that is complete by construction rather than by
// remembering to log.
//
// See docs/architecture.md. The reducer being pure is what makes the whole interactive CAD flow unit-testable
// with no DOM, no viewport, no kernel and no clock.

export {
  assertSerializable,
  availability,
} from "./descriptor.js";
export type {
  ArgKind,
  ArgSpec,
  Availability,
  CapabilityGate,
  CommandContext,
  CommandDescriptor,
  CommandInvocation,
  CommandOrigin,
} from "./descriptor.js";

export { begin, step, toInvocation } from "./prompt.js";
export type { PromptEvent, PromptState, PromptStatus } from "./prompt.js";

export { createRegistry, rankForPalette, replay } from "./registry.js";
export type {
  AnyCommandDescriptor,
  DispatchOptions,
  HistoryEntry,
  Middleware,
  Registry,
  RegistryOptions,
  UndoOutcome,
} from "./registry.js";
