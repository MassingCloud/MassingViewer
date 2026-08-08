import type { Failure } from "@massing/core";

/**
 * The closed set of reasons a kernel can decline an operation.
 *
 * **Codes are a contract; messages are not.** The conformance suite asserts that both kernels return
 * the *same code* for the same bad input, and deliberately never asserts the message — messages are
 * localised and rewritten for clarity, and a test that pins wording is a test that blocks copy
 * improvements or gets updated without being read.
 *
 * The set is closed for a specific reason. `LocalKernel` writes IFC with `web-ifc`; `RemoteKernel`
 * delegates to `ifcopenshell`. Two independent implementations of the same semantics will diverge, and
 * the divergence that actually hurts is not "one is missing a feature" — capability negotiation covers
 * that honestly — it is "both refuse, for reasons the UI cannot tell apart". An open string set makes
 * that divergence invisible. This makes it a test failure.
 */
export type KernelErrorCode =
  /** This kernel does not implement the operation. Not an error — see {@link UnsupportedFailure}. */
  | "unsupported"
  /** Understood and declined: a guardrail, invalid geometry, or a violated precondition. */
  | "refused"
  /** The named element does not exist in the model. */
  | "no_such_element"
  /** A parameter was absent, wrongly typed, or out of range. */
  | "invalid_param"
  /** Geometry would be degenerate — zero-length run, self-intersecting polygon, coincident points. */
  | "degenerate_geometry"
  /** Placement lies outside the model's plausible bounds. */
  | "out_of_bounds"
  /** The operation requires an extruded solid and the target is not one. */
  | "not_an_extrusion"
  /** The caller's model version is stale; someone else wrote first. Never a silent overwrite. */
  | "version_conflict"
  /** The caller lacks the capability (role) the operation requires. */
  | "forbidden"
  /** Cancelled via the AbortSignal. A normal outcome, not a fault. */
  | "cancelled"
  /** Transport failed: offline, timeout, unreachable service. Only `RemoteKernel` emits this. */
  | "transport"
  /** A defect in the kernel. The one code that means "file a bug", and it carries a stack. */
  | "internal";

export interface KernelFailure extends Failure {
  readonly code: KernelErrorCode;
}

/**
 * The failure that makes partial coverage honest.
 *
 * `LocalKernel` implements a fraction of what the remote service does, and will for a long time. The
 * temptation is to hide the rest of the UI when running locally. That is the wrong product: the user
 * cannot then discover what exists, and cannot tell "this tool doesn't exist" from "this tool needs
 * something you don't have".
 *
 * So unsupported operations stay visible, dimmed, with `hint` as the tooltip. `hint` is written *by the
 * kernel*, because only the kernel knows what would unlock the operation — and it is a required field
 * so that "dimmed for no stated reason" is not representable.
 */
export interface UnsupportedFailure extends KernelFailure {
  readonly code: "unsupported";
  readonly op: string;
  /** Shown verbatim as the dimmed control's tooltip. Must name what would make this work. */
  readonly hint: string;
}

export function unsupported(op: string, hint: string): UnsupportedFailure {
  return {
    code: "unsupported",
    op,
    hint,
    message: hint,
    detail: { op },
  };
}

export function kernelFailure(
  code: KernelErrorCode,
  message: string,
  detail?: Record<string, unknown>,
): KernelFailure {
  return detail === undefined ? { code, message } : { code, message, detail };
}

/** True when the failure is a normal outcome the UI should present calmly, not an incident. */
export function isExpectedFailure(f: KernelFailure): boolean {
  return f.code !== "internal" && f.code !== "transport";
}
