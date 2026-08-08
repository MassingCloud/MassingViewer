// @massing/core — the vocabulary every other package speaks.
//
// Three concerns, chosen because each one is a place where disagreement between subsystems is silent
// and expensive: what identifies an element, what a length means, and how a refusal travels.
//
// Zero runtime dependencies, no DOM, no renderer. This package must be importable from a Worker, from
// Node, from a vanilla-DOM host, and from React, because it is the layer that keeps those four from
// needing to agree on anything else.

export {
  // Identity
  isGuid,
  asGuid,
  toGuid,
  asLocalId,
  asModelId,
  elementRef,
  sameElement,
  refKey,
  resolveRefs,
} from "./identity.js";
export type {
  Guid,
  LocalId,
  ModelId,
  ElementRef,
  ModelIdMap,
  ResolveOutcome,
} from "./identity.js";

export {
  // Units — metres internally, always
  toMetres,
  fromMetres,
  isImperial,
  formatLength,
  parseLength,
  METRIC,
  METRIC_MM,
  IMPERIAL,
} from "./units.js";
export type { LengthUnit, UnitSystem } from "./units.js";

export {
  // Result — refusals are values, bugs are exceptions
  ok,
  err,
  isOk,
  failure,
  mapResult,
  unwrap,
  attempt,
  attemptAsync,
} from "./result.js";
export type { Result, Failure } from "./result.js";
