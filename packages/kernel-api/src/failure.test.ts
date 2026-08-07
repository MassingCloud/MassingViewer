import { describe, expect, it } from "vitest";
import { isExpectedFailure, kernelFailure, unsupported, type KernelErrorCode } from "./failure.js";

describe("unsupported — the failure that makes partial coverage honest", () => {
  it("requires a hint, and uses it as the user-facing message", () => {
    // The whole design rests on this. `LocalKernel` implements a fraction of what the remote service does,
    // and the product decision is to keep the rest VISIBLE and dimmed rather than hidden — so the user can
    // discover what exists and learn what a connection would unlock. That only works if every unsupported
    // operation carries a sentence explaining itself, which is why `hint` is required rather than optional.
    const f = unsupported(
      "add_connection_assembly",
      '"add_connection_assembly" runs on the Massing authoring service. Connect a project to use it.',
    );
    expect(f.code).toBe("unsupported");
    expect(f.op).toBe("add_connection_assembly");
    expect(f.hint).toBeTruthy();
    expect(f.message).toBe(f.hint); // the tooltip and the log line are the same sentence
  });

  it("puts the operation in detail as well, for structured logs", () => {
    expect(unsupported("add_wall", "not here").detail).toEqual({ op: "add_wall" });
  });

  it("survives structuredClone — it crosses a worker boundary on every call", () => {
    const f = unsupported("program_fit", "needs the authoring service");
    expect(structuredClone(f)).toEqual(f);
  });
});

describe("kernelFailure", () => {
  it("omits detail when none is given", () => {
    const f = kernelFailure("refused", "guardrail declined this");
    expect(Object.hasOwn(f, "detail")).toBe(false);
  });

  it("carries detail when given", () => {
    const f = kernelFailure("out_of_bounds", "too far from the model", { distance: 1e6 });
    expect(f.detail).toEqual({ distance: 1e6 });
  });
});

describe("isExpectedFailure", () => {
  // The distinction this draws: which failures are a normal part of using the tool, and which are an
  // incident. A refused wall is a toast; an internal error is a crash report. Getting it backwards means
  // either alerting on ordinary user mistakes or silently swallowing defects.
  const expected: KernelErrorCode[] = [
    "unsupported",
    "refused",
    "no_such_element",
    "invalid_param",
    "degenerate_geometry",
    "out_of_bounds",
    "not_an_extrusion",
    "version_conflict",
    "forbidden",
    "cancelled",
  ];

  it.each(expected)("treats %s as an expected outcome", (code) => {
    expect(isExpectedFailure(kernelFailure(code, "x"))).toBe(true);
  });

  it("treats internal as unexpected — it means file a bug", () => {
    expect(isExpectedFailure(kernelFailure("internal", "x"))).toBe(false);
  });

  it("treats transport as unexpected — it is an environment problem, not a user one", () => {
    expect(isExpectedFailure(kernelFailure("transport", "x"))).toBe(false);
  });

  it("classifies cancelled as expected, not as an error", () => {
    // A user who cancels a long section cut has not encountered a fault, and a cancellation reported as an
    // error trains people to ignore error toasts.
    expect(isExpectedFailure(kernelFailure("cancelled", "aborted"))).toBe(true);
  });

  it("covers every code in the taxonomy", () => {
    // A ratchet on the closed set: adding a code without deciding whether it is expected leaves it
    // silently classified by the default branch, and this fails until someone chooses.
    const classified = new Set<KernelErrorCode>([...expected, "internal", "transport"]);
    const declared: KernelErrorCode[] = [
      "unsupported", "refused", "no_such_element", "invalid_param", "degenerate_geometry",
      "out_of_bounds", "not_an_extrusion", "version_conflict", "forbidden", "cancelled",
      "transport", "internal",
    ];
    expect(declared.filter((c) => !classified.has(c))).toEqual([]);
    expect(declared.length).toBe(classified.size);
  });
});
