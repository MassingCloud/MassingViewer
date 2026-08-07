import { describe, expect, it } from "vitest";
import {
  asGuid,
  asLocalId,
  asModelId,
  elementRef,
  isGuid,
  refKey,
  resolveRefs,
  sameElement,
  toGuid,
  type Guid,
  type LocalId,
  type ModelId,
  type ModelIdMap,
} from "./identity.js";

const G1 = asGuid("1hqA$Xk3v9wBOHu4bPqRcZ");
const G2 = asGuid("2mnB_Yl4w0xCPIv5cQrSdA");
const M1 = asModelId("arch");
const M2 = asModelId("struct");

function map(modelId: ModelId, entries: [Guid, number][]): ModelIdMap {
  const fwd = new Map(entries);
  const rev = new Map(entries.map(([g, l]) => [l, g]));
  return {
    modelId,
    localIdOf: (g) => {
      const l = fwd.get(g);
      return l === undefined ? undefined : (l as LocalId);
    },
    guidOf: (l) => rev.get(l as number),
  };
}

describe("GlobalId validation", () => {
  it("accepts a well-formed GlobalId", () => {
    expect(isGuid("1hqA$Xk3v9wBOHu4bPqRcZ")).toBe(true);
  });

  it("rejects the shapes that actually show up", () => {
    // Each of these has been seen in the wild in one importer or another. Left unvalidated they all
    // collapse into a single phantom element that appears to be selected everywhere at once.
    expect(isGuid("")).toBe(false);
    expect(isGuid("undefined")).toBe(false);
    expect(isGuid("null")).toBe(false);
    expect(isGuid("too-short")).toBe(false);
    expect(isGuid("1hqA$Xk3v9wBOHu4bPqRcZZ")).toBe(false); // 23 chars
    expect(isGuid("1hqA$Xk3v9wBOHu4bPqRc")).toBe(false); // 21 chars
    expect(isGuid("1hqA$Xk3v9wBOHu4bPqRc-")).toBe(false); // '-' is not in IFC's alphabet
    expect(isGuid(42)).toBe(false);
    expect(isGuid(null)).toBe(false);
    expect(isGuid(undefined)).toBe(false);
    expect(isGuid({})).toBe(false);
  });

  it("throws with an actionable message rather than returning a bad brand", () => {
    expect(() => asGuid("nope")).toThrow(/Not an IFC GlobalId/);
    // The message has to say WHY it matters, because the person reading it is usually writing an
    // importer and about to reach for a cast.
    expect(() => asGuid("nope")).toThrow(/survive a reload/);
  });

  it("toGuid degrades to null where malformed input is expected", () => {
    expect(toGuid("1hqA$Xk3v9wBOHu4bPqRcZ")).toBe("1hqA$Xk3v9wBOHu4bPqRcZ");
    expect(toGuid("nope")).toBeNull();
  });

  it("rejects a non-integer or negative local id", () => {
    expect(() => asLocalId(1.5)).toThrow();
    expect(() => asLocalId(-1)).toThrow();
    expect(asLocalId(0)).toBe(0);
  });

  it("rejects an empty model id", () => {
    expect(() => asModelId("")).toThrow();
  });
});

describe("element references include the model", () => {
  it("distinguishes the same GlobalId in different models", () => {
    // Not exotic: GlobalIds are only unique within a file, and a federated arch + struct + MEP model is
    // the normal case. A bare Guid would conflate two different elements.
    const a = elementRef(M1, G1);
    const b = elementRef(M2, G1);
    expect(sameElement(a, b)).toBe(false);
    expect(refKey(a)).not.toBe(refKey(b));
  });

  it("treats identical model + guid as the same element", () => {
    expect(sameElement(elementRef(M1, G1), elementRef(M1, G1))).toBe(true);
  });

  it("produces a key usable in a Set", () => {
    const set = new Set([refKey(elementRef(M1, G1)), refKey(elementRef(M1, G1))]);
    expect(set.size).toBe(1);
  });
});

describe("resolveRefs separates the failure modes", () => {
  it("resolves what it can", () => {
    const out = resolveRefs([elementRef(M1, G1)], [map(M1, [[G1, 7]])]);
    expect(out.complete).toBe(true);
    expect(out.resolved).toEqual([{ ref: elementRef(M1, G1), localId: 7 }]);
    expect(out.missing).toEqual([]);
    expect(out.unloaded).toEqual([]);
  });

  it("reports an unloaded model separately from a deleted element", () => {
    // The distinction the whole shape exists for. "3 pins are in a model you haven't opened" is an
    // instruction; "3 pins point at elements that no longer exist" is data loss. Collapsing them into
    // one number reports a loading state as data loss.
    const out = resolveRefs(
      [elementRef(M1, G1), elementRef(M1, G2), elementRef(M2, G1)],
      [map(M1, [[G1, 7]])],
    );
    expect(out.resolved.map((r) => r.localId)).toEqual([7]);
    expect(out.missing).toEqual([elementRef(M1, G2)]); // model loaded, element gone
    expect(out.unloaded).toEqual([elementRef(M2, G1)]); // model not loaded
    expect(out.complete).toBe(false);
  });

  it("is complete only when nothing failed either way", () => {
    expect(resolveRefs([], []).complete).toBe(true);
    expect(resolveRefs([elementRef(M1, G1)], []).complete).toBe(false);
  });

  it("does not lose duplicate refs", () => {
    // A markup set can legitimately reference one element several times. Silently de-duplicating here
    // would drop pins.
    const out = resolveRefs([elementRef(M1, G1), elementRef(M1, G1)], [map(M1, [[G1, 7]])]);
    expect(out.resolved).toHaveLength(2);
  });

  it("resolves across several loaded models", () => {
    const out = resolveRefs(
      [elementRef(M1, G1), elementRef(M2, G2)],
      [map(M1, [[G1, 7]]), map(M2, [[G2, 3]])],
    );
    expect(out.complete).toBe(true);
    expect(out.resolved.map((r) => r.localId).sort()).toEqual([3, 7]);
  });
});
