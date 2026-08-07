// @massingviewer/ifc — the IFC file, as a thing you can edit without breaking.
//
// One idea, stated in docs/adr/0008-local-kernel-geometry-stack.md: the authoritative store is the file's own
// entity table, not a model of the parts we understand. Editing an entity patches that entity; every other
// byte is re-emitted verbatim. That is what makes it safe to open somebody else's file — the structural
// consultant's analytical members and the MEP contractor's flow segments survive a wall being moved, because
// nothing ever rebuilds them from a reduced representation.
//
// No dependencies beyond @massingviewer/core, no DOM, no WASM. Tessellation and booleans live elsewhere; this
// package is only about what the file says.

export { EntityTable } from "./step/table.js";
export { StepSyntaxError, parseParams, scanEntities } from "./step/parse.js";
export type { RawEntity, ScanResult } from "./step/parse.js";
export {
  DERIVED,
  FALSE,
  TRUE,
  UNSET,
  enumeration,
  formatParams,
  formatValue,
  integer,
  list,
  quote,
  real,
  ref,
  str,
  unquote,
} from "./step/value.js";
export type { StepValue } from "./step/value.js";
