// @massing/kernel-api — the contract, and nothing else.
//
// No implementation lives here on purpose. This package is what a third party reads to write a kernel,
// and what `@massing/kernel-conformance` tests against. Adding so much as a helper that touches
// `web-ifc` or `fetch` would make it un-implementable from the other side of one of those choices.
//
// Changes here bind us via the deprecation policy in docs/plugin-deprecation-policy.md, so they need an
// ADR. See CODEOWNERS.

export type {
  KernelProvider,
  KernelCapabilities,
  TransactionSupport,
  Transaction,
  OpId,
  OpParams,
  OpDescriptor,
  ParamDescriptor,
  ApplyOptions,
  OpResult,
  GeometryPayload,
  ElementProperties,
  MaterialLayer,
  SpatialNode,
  SnapCandidatePoint,
  DrawingKind,
  DrawingRequest,
  DrawingIncludes,
  DrawingPayload,
  DrawingProvenance,
} from "./provider.js";

export { unsupported, kernelFailure, isExpectedFailure } from "./failure.js";
export type { KernelErrorCode, KernelFailure, UnsupportedFailure } from "./failure.js";
