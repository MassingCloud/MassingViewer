import { describe, expect, it, vi } from "vitest";
import { attempt, attemptAsync, err, failure, isOk, mapResult, ok, unwrap } from "./result";

describe("ok / err / isOk", () => {
  it("carries the value on success", () => {
    const r = ok(42);
    expect(r.ok).toBe(true);
    expect(isOk(r)).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  it("carries the error on failure", () => {
    const r = err(failure("refused", "nope"));
    expect(r.ok).toBe(false);
    expect(isOk(r)).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("refused");
  });

  it("wraps falsy values without collapsing them", () => {
    // The trap `Result` exists to avoid: `if (!result)` cannot distinguish a successful `0`, `""`, `null`
    // or `false` from a failure. Each of these is a legitimate success value.
    for (const v of [0, "", null, false, NaN]) {
      const r = ok(v);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual(v);
    }
  });
});

describe("failure", () => {
  it("omits detail entirely when none is given", () => {
    // Not cosmetic: these travel through `structuredClone` across worker and plugin boundaries, and get
    // written to the audit log. `{ detail: undefined }` and `{}` serialise differently, and an audit entry
    // whose shape varies by call site is harder to query.
    const f = failure("invalid_param", "bad");
    expect(Object.hasOwn(f, "detail")).toBe(false);
    expect(JSON.parse(JSON.stringify(f))).toEqual({ code: "invalid_param", message: "bad" });
  });

  it("carries detail when given", () => {
    const f = failure("out_of_bounds", "too far", { x: 1e9 });
    expect(f.detail).toEqual({ x: 1e9 });
  });

  it("survives structuredClone — the whole reason refusals are values", () => {
    const f = failure("not_an_extrusion", "that wall is not an extrusion", { guid: "abc" });
    const cloned = structuredClone(f);
    expect(cloned).toEqual(f);
    // An Error, by contrast, loses its own fields across the same boundary.
    const asError = Object.assign(new Error("x"), { code: "y" });
    expect(structuredClone(asError).code).toBeUndefined();
  });
});

describe("mapResult", () => {
  it("maps the success value", () => {
    const r = mapResult(ok(2), (n) => n * 3);
    expect(r).toEqual({ ok: true, value: 6 });
  });

  it("passes a failure through untouched, without calling the mapper", () => {
    const fn = vi.fn();
    const original = err(failure("refused", "no"));
    const r = mapResult(original, fn);
    expect(fn).not.toHaveBeenCalled();
    expect(r).toBe(original); // same object — no needless allocation on the error path
  });
});

describe("unwrap", () => {
  it("returns the value on success", () => {
    expect(unwrap(ok("v"))).toBe("v");
  });

  it("throws with the code and message on failure", () => {
    expect(() => unwrap(err(failure("version_conflict", "someone wrote first")))).toThrow(
      /version_conflict.*someone wrote first/,
    );
  });

  it("still produces a readable message for a non-Failure error shape", () => {
    // `Result<T, E>` allows any error type. A caller who used a bare string must not get
    // "unwrap on a failed Result: undefined — undefined".
    expect(() => unwrap(err("just a string"))).toThrow(/just a string/);
  });
});

describe("attempt", () => {
  it("returns ok for a function that returns", () => {
    expect(attempt(() => 1)).toEqual({ ok: true, value: 1 });
  });

  it("converts a thrown Error into a Failure at the boundary", () => {
    const r = attempt(() => {
      throw new Error("boom");
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("internal");
      expect(r.error.message).toBe("boom");
    }
  });

  it("handles a thrown non-Error", () => {
    // Untrusted code — a plugin, a WASM binding — can throw anything. `throw "nope"` and
    // `throw { weird: true }` are both legal, and neither has `.message`.
    for (const thrown of ["nope", 42, { weird: true }, null, undefined]) {
      const r = attempt(() => {
        throw thrown;
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(typeof r.error.message).toBe("string");
    }
  });

  it("uses the supplied code", () => {
    const r = attempt(() => {
      throw new Error("bad json");
    }, "invalid_param");
    if (!r.ok) expect(r.error.code).toBe("invalid_param");
  });
});

describe("attemptAsync", () => {
  it("returns ok for a resolving promise", async () => {
    await expect(attemptAsync(async () => 5)).resolves.toEqual({ ok: true, value: 5 });
  });

  it("converts a rejection into a Failure", async () => {
    const r = await attemptAsync(async () => {
      throw new Error("async boom");
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe("async boom");
  });

  it("catches a synchronous throw from inside the async function", async () => {
    const r = await attemptAsync(() => {
      throw new Error("sync throw in async position");
    });
    expect(r.ok).toBe(false);
  });

  it("handles a rejection with a non-Error", async () => {
    const r = await attemptAsync(() => Promise.reject("plain string rejection"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("plain string rejection");
  });
});
