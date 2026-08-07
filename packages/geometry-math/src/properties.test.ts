/**
 * Property-based tests for the precision kit.
 *
 * The ported suites are example-based, and good: each one pins a case someone thought about. What they
 * cannot express is the *invariant* — "for all inputs, this holds" — and the invariant is where a
 * refactor of the snap resolver or the unit parser will actually break.
 *
 * These are deliberately written as properties an implementation could fail while passing every example,
 * because that is the gap worth covering rather than restating what is already tested.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

/**
 * Property tests run **seeded by default**, and that is a deliberate trade with a real cost.
 *
 * Unseeded, fast-check picks a fresh seed per run, which is how it finds things nobody thought of. It is
 * also how a gate becomes flaky: this suite passed locally and then failed in CI on a counterexample the
 * local seed had not reached. A test that fails on some runs and not others gets muted or retried, and
 * then it protects nothing — which is this repo's stated principle about gates, applied to itself.
 *
 * So: deterministic in CI and in `npm run verify`, and explorative on demand.
 *
 *   FAST_CHECK_SEED=random npm run test        # fresh seed — run this before a release
 *   FAST_CHECK_SEED=-609673715 npm run test    # reproduce a specific reported failure
 *
 * `numRuns` is raised above the default 100 to buy back some of the coverage that fixing the seed costs:
 * a fixed seed with more runs explores a larger fixed region.
 *
 * A nightly job should run with `FAST_CHECK_SEED=random`, so new counterexamples still surface — just
 * not in a way that blocks a PR that did not cause them.
 */
const seedEnv = process.env.FAST_CHECK_SEED;
fc.configureGlobal({
  numRuns: 500,
  ...(seedEnv === "random" ? {} : { seed: seedEnv ? Number(seedEnv) : 0x4d565752 }),
  // Report the shrunk counterexample and the path, so a CI failure is directly reproducible.
  verbose: false,
  endOnFailure: true,
});
import { applyDynamicInput, polarConstrain, resolveSnap, segmentSnaps, type SnapCandidate } from "./snapEngine.js";
import { checkPolygon } from "./placeValid.js";
import { dynKeystroke, formatDynConstraint, parseDynConstraint } from "./dynInput.js";

/**
 * Finite, bounded coordinates. Unbounded floats would only ever test float arithmetic.
 *
 * ## What the winding-invariance property actually taught us (two rounds)
 *
 * `checkPolygon`'s crossing test is an orientation predicate built from naive floating-point
 * determinants. It is *algebraically* invariant to winding — reversing a ring preserves the cyclic edge
 * set, and the predicate is symmetric under swapping either segment's endpoints. It is not
 * *numerically* invariant on near-degenerate input.
 *
 * **First diagnosis, incomplete.** fast-check found a counterexample at magnitudes near 1e-232 and the
 * cause was read as subnormal underflow: the determinant multiplies two coordinate differences, the
 * product underflows to zero, and the sign disappears. True, and the generator was bounded to
 * realistic magnitudes.
 *
 * **Then CI found a second counterexample the local seed had missed**, at 1e-4 — right at the bounded
 * minimum, nowhere near subnormal:
 *
 *     [0, -0.00010000000000000003], [0.0001, -0.0001],
 *     [0, -0.00010000000000000002], [0.0001, 0.0001]
 *
 * Vertices 0 and 2 differ in the last representable bit. The determinant's terms are fine in magnitude;
 * what destroys the sign is **catastrophic cancellation** when subtracting nearly-equal coordinates.
 * That is the general failure, and subnormal underflow was only one instance of it. Bounding the
 * magnitude was therefore treating a symptom.
 *
 * **The correct scoping** is on *separation*, not magnitude: a naive orientation predicate is
 * meaningful when its inputs are not nearly-coincident, and that is the only region where invariance
 * can be claimed. So the winding property now requires vertices to be at least `MIN_SEPARATION` apart.
 * Robustness on genuinely degenerate input would need adaptive-precision arithmetic (Shewchuk's
 * predicates), and buying that to satisfy a test over polygons whose vertices are 1e-20 m apart would
 * be the wrong trade — `MIN_RUN_M` is 50 mm, so placement validation rejects these long before the
 * polygon check sees them.
 */
const MIN_MAGNITUDE = 1e-4; // 0.1 mm — below any manufacturing tolerance in construction
const MAX_MAGNITUDE = 1e5; // 100 km — beyond any site

/**
 * Minimum vertex separation for the winding-invariance property, in metres.
 *
 * 1 mm. Below this, two vertices are the same point for any construction purpose, and the naive
 * determinant cannot reliably sign the orientation — see the note above.
 */
const MIN_SEPARATION = 1e-3;

const coord = () =>
  fc
    .tuple(
      fc.double({ min: MIN_MAGNITUDE, max: MAX_MAGNITUDE, noNaN: true, noDefaultInfinity: true }),
      fc.boolean(),
      fc.boolean(),
    )
    .map(([magnitude, negative, zero]) => (zero ? 0 : negative ? -magnitude : magnitude));
const point = () => fc.record({ x: coord(), z: coord() });
const kind = () =>
  fc.constantFrom<SnapCandidate["kind"]>(
    "endpoint", "midpoint", "center", "intersection", "perpendicular", "nearest", "grid",
  );
const candidate = () => fc.record({ x: coord(), z: coord(), kind: kind() });

const dist = (a: { x: number; z: number }, b: { x: number; z: number }) =>
  Math.hypot(a.x - b.x, a.z - b.z);

/**
 * `resolveSnap`'s near-tie epsilon, in metres — one micron.
 *
 * Not a magic number pulled from the test: it mirrors the `1e-6` in `resolveSnap`'s comparison, which is
 * what makes priority-based tie-breaking work at all ("a coincident vertex beats a midpoint"). It is
 * named here because two properties below have to be stated in terms of it, and a bare `1e-6` in an
 * assertion reads as slop rather than as the implementation's own tolerance.
 */
const TIE_EPSILON = 1e-6;

describe("resolveSnap — properties", () => {
  it("never returns a candidate outside the tolerance", () => {
    fc.assert(
      fc.property(point(), fc.array(candidate(), { maxLength: 40 }), fc.double({ min: 0, max: 50, noNaN: true }),
        (cursor, candidates, tol) => {
          const r = resolveSnap(cursor, candidates, tol);
          if (r === null) return true;
          return r.dist <= tol + 1e-9;
        }),
    );
  });

  it("returns null only when nothing is genuinely in range", () => {
    // The failure this catches: an early `return null` on some code path (an empty priority bucket, a
    // filtered-out kind) that silently discards a valid snap. Any implementation that skips a
    // reachable candidate fails here, no matter which examples it passes.
    fc.assert(
      fc.property(point(), fc.array(candidate(), { maxLength: 40 }), fc.double({ min: 0, max: 50, noNaN: true }),
        (cursor, candidates, tol) => {
          const anyInRange = candidates.some((c) => dist(cursor, c) <= tol);
          return (resolveSnap(cursor, candidates, tol) !== null) === anyInRange;
        }),
    );
  });

  it("returns the minimum distance among candidates in range, within the tie-break epsilon", () => {
    fc.assert(
      fc.property(point(), fc.array(candidate(), { minLength: 1, maxLength: 40 }), fc.double({ min: 0, max: 50, noNaN: true }),
        (cursor, candidates, tol) => {
          const r = resolveSnap(cursor, candidates, tol);
          if (r === null) return true;
          const min = Math.min(...candidates.map((c) => dist(cursor, c)).filter((d) => d <= tol));
          return r.dist - min <= TIE_EPSILON;
        }),
    );
  });

  it("an override is a filter, never a preference", () => {
    // The load-bearing property of one-shot overrides. If asking for `perpendicular` can return a
    // midpoint because nothing perpendicular was in range, then the HUD says "perpendicular" while the
    // placed point is something else — and that point carries a GlobalId and feeds schedules. A snap
    // that lies about its kind is worse than no snap.
    fc.assert(
      fc.property(point(), fc.array(candidate(), { maxLength: 40 }), fc.double({ min: 0, max: 50, noNaN: true }), kind(),
        (cursor, candidates, tol, only) => {
          const r = resolveSnap(cursor, candidates, tol, only);
          if (r === null) return !candidates.some((c) => c.kind === only && dist(cursor, c) <= tol);
          return r.kind === only;
        }),
    );
  });

  it("agrees with itself under reordering, up to the tie-break epsilon", () => {
    // Stated with the epsilon because a stronger version is FALSE, and finding out why is worth the
    // comment.
    //
    // `resolveSnap` breaks near-ties by snap priority, using an absolute epsilon: candidates within
    // 1e-6 of each other in distance are treated as coincident, and the higher-priority kind wins. When
    // two candidates of the *same* priority sit exactly 1e-6 apart, neither branch fires and the winner
    // is whichever was seen first — so the answer depends on array order.
    //
    // A property asserting exact order-invariance fails on precisely that boundary (fast-check finds it
    // in a few dozen shrinks). It is not a defect: 1e-6 m is one micron, the two candidates are the same
    // point for any construction purpose, and tightening the epsilon only moves the boundary rather than
    // removing it. What callers may rely on is that the result is *within epsilon of the true minimum*,
    // which is order-invariant — so that is what this asserts, and the looser guarantee is now written
    // down rather than assumed.
    fc.assert(
      fc.property(point(), fc.array(candidate(), { maxLength: 25 }), fc.double({ min: 0.1, max: 50, noNaN: true }),
        (cursor, candidates, tol) => {
          const forward = resolveSnap(cursor, candidates, tol);
          const reversed = resolveSnap(cursor, [...candidates].reverse(), tol);
          if (forward === null || reversed === null) return forward === reversed;
          return Math.abs(forward.dist - reversed.dist) <= TIE_EPSILON;
        }),
    );
  });

  it("picks the same POINT under reordering when there is no near-tie", () => {
    // The stronger guarantee, scoped to where it actually holds: when candidates are well separated,
    // reordering must not change the answer at all. This is the version that would catch a `>` used
    // where `>=` was meant.
    fc.assert(
      fc.property(point(), fc.array(candidate(), { maxLength: 25 }), fc.double({ min: 0.1, max: 50, noNaN: true }),
        (cursor, candidates, tol) => {
          const inRange = candidates.filter((c) => dist(cursor, c) <= tol);
          if (inRange.length < 1) return true;
          const distances = inRange.map((c) => dist(cursor, c)).sort((a, b) => a - b);
          // Skip the near-tie cases this property deliberately does not cover.
          if (distances.length > 1 && distances[1]! - distances[0]! < TIE_EPSILON * 100) return true;

          const forward = resolveSnap(cursor, candidates, tol);
          const reversed = resolveSnap(cursor, [...candidates].reverse(), tol);
          if (forward === null || reversed === null) return false;
          return forward.x === reversed.x && forward.z === reversed.z && forward.kind === reversed.kind;
        }),
    );
  });
});

describe("segmentSnaps — properties", () => {
  it("emits every vertex as an endpoint candidate", () => {
    fc.assert(
      fc.property(fc.array(point(), { minLength: 1, maxLength: 20 }), (pts) => {
        const out = segmentSnaps(pts, false);
        const endpoints = out.filter((c) => c.kind === "endpoint");
        return endpoints.length === pts.length;
      }),
    );
  });

  it("closing a ring adds exactly one segment's worth of midpoints", () => {
    fc.assert(
      fc.property(fc.array(point(), { minLength: 2, maxLength: 20 }), (pts) => {
        const open = segmentSnaps(pts, false).filter((c) => c.kind === "midpoint").length;
        const closed = segmentSnaps(pts, true).filter((c) => c.kind === "midpoint").length;
        return closed === open + 1;
      }),
    );
  });
});

describe("polarConstrain — properties", () => {
  it("a locked result always lies on a multiple of the increment", () => {
    fc.assert(
      fc.property(point(), point(), fc.constantFrom(15, 30, 45, 90), (origin, cursor, inc) => {
        const r = polarConstrain(origin, cursor, inc, 4);
        if (!r.locked) return true;
        const remainder = Math.abs(r.angle % inc);
        return remainder < 1e-6 || Math.abs(remainder - inc) < 1e-6;
      }),
    );
  });

  it("preserves distance from the origin when it locks", () => {
    // Polar tracking constrains the *bearing*. Moving the point along the ray as well would make the
    // rubber-band jump under the cursor, which reads as a broken tool rather than a helpful one.
    fc.assert(
      fc.property(point(), point(), fc.constantFrom(15, 45, 90), (origin, cursor, inc) => {
        const r = polarConstrain(origin, cursor, inc, 4);
        if (!r.locked) return true;
        return Math.abs(dist(origin, r) - dist(origin, cursor)) <= 1e-6;
      }),
    );
  });

  it("a non-positive increment is a no-op", () => {
    fc.assert(
      fc.property(point(), point(), fc.integer({ min: -90, max: 0 }), (origin, cursor, inc) => {
        const r = polarConstrain(origin, cursor, inc, 4);
        return r.locked === false && r.x === cursor.x && r.z === cursor.z;
      }),
    );
  });
});

describe("applyDynamicInput — properties", () => {
  it("an empty constraint returns the cursor untouched", () => {
    fc.assert(
      fc.property(point(), point(), (origin, cursor) => {
        const r = applyDynamicInput(origin, cursor, {});
        return r.x === cursor.x && r.z === cursor.z;
      }),
    );
  });

  it("a typed distance is honoured exactly", () => {
    // The whole reason to type a number instead of dragging: the result is the number, not
    // approximately the number.
    fc.assert(
      fc.property(point(), point(), fc.double({ min: 0.001, max: 500, noNaN: true }), (origin, cursor, d) => {
        if (dist(origin, cursor) < 1e-9) return true;
        const r = applyDynamicInput(origin, cursor, { distance: d });
        return Math.abs(dist(origin, r) - d) <= 1e-6 * Math.max(1, d);
      }),
    );
  });

  it("a typed angle keeps the cursor's distance", () => {
    fc.assert(
      fc.property(point(), point(), fc.double({ min: -360, max: 360, noNaN: true }), (origin, cursor, a) => {
        const r0 = dist(origin, cursor);
        if (r0 < 1e-9) return true;
        const r = applyDynamicInput(origin, cursor, { angle: a });
        return Math.abs(dist(origin, r) - r0) <= 1e-6 * Math.max(1, r0);
      }),
    );
  });
});

describe("dynInput — the buffer grammar", () => {
  // Worth stating what these two functions are, because the obvious property — `parse(format(x)) === x`
  // — is false, and it is false *by design* rather than by defect.
  //
  // `parseDynConstraint` reads the **typed buffer**: `6`, `<30`, `6<30`, `12'6<30`. `formatDynConstraint`
  // writes the **HUD echo**: `3.81 m @ 30°`. They are deliberately different languages. The echo always
  // answers in metres, so that typing `12'6` visibly reports back `3.81 m` and the drafter sees the
  // conversion before the click commits it — which is the whole point of the echo and would be lost if
  // it mirrored the input syntax.
  //
  // So the real invariant is that the parser is consistent over its own grammar. That is what these test.

  it("round-trips a distance through the buffer grammar", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.001, max: 9999, noNaN: true }), (distance) => {
        const parsed = parseDynConstraint(String(distance));
        return parsed !== null && Math.abs((parsed.distance ?? NaN) - distance) <= 1e-9;
      }),
    );
  });

  it("round-trips distance and angle together", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.001, max: 9999, noNaN: true }),
        fc.double({ min: -360, max: 360, noNaN: true }),
        (distance, angle) => {
          const parsed = parseDynConstraint(`${distance}<${angle}`);
          if (parsed === null) return false;
          return (
            Math.abs((parsed.distance ?? NaN) - distance) <= 1e-9 &&
            Math.abs((parsed.angle ?? NaN) - angle) <= 1e-9
          );
        },
      ),
    );
  });

  it("converts imperial feet-and-inches to metres exactly", () => {
    // The units guarantee, and the reason the parser exists in this shape: the model is metric, the
    // keyboard is whatever the drafter thinks in. 1 in ≡ 25.4 mm exactly, so this is not approximate.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 500 }),
        fc.integer({ min: 0, max: 11 }),
        (feet, inches) => {
          if (feet === 0 && inches === 0) return true; // zero length is refused, tested separately
          const parsed = parseDynConstraint(`${feet}'${inches}`);
          const expected = (feet + inches / 12) * 0.3048;
          return parsed !== null && Math.abs((parsed.distance ?? NaN) - expected) <= 1e-12;
        },
      ),
    );
  });

  it("refuses 12 or more inches rather than silently carrying", () => {
    // `12'13` is not 13 feet 1 inch — it is a typo, and guessing which one it was would place a wall
    // somewhere the drafter did not ask for.
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 500 }), fc.integer({ min: 12, max: 99 }), (feet, inches) =>
        parseDynConstraint(`${feet}'${inches}`) === null,
      ),
    );
  });

  it("never returns a constraint with a non-positive distance", () => {
    fc.assert(
      fc.property(fc.double({ min: -9999, max: 0, noNaN: true }), (d) => {
        const parsed = parseDynConstraint(String(d));
        return parsed === null || parsed.distance === undefined || parsed.distance > 0;
      }),
    );
  });

  it("the HUD echo always reports metres, whatever was typed", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), fc.integer({ min: 0, max: 11 }), (feet, inches) => {
        const parsed = parseDynConstraint(`${feet}'${inches}`);
        if (parsed === null) return false;
        return formatDynConstraint(parsed).includes(" m");
      }),
    );
  });

  it("the buffer only accumulates keys in its own grammar", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 12 }), (keys) => {
        let buf = "";
        for (const k of keys) buf = dynKeystroke(buf, k);
        return /^[0-9.<'"-]*$/.test(buf);
      }),
    );
  });

  it("backspace is the inverse of appending an accepted key", () => {
    fc.assert(
      // fast-check 4 removed `fc.char()`; a length-1 string is the replacement.
      fc.property(fc.string({ maxLength: 8 }), fc.string({ minLength: 1, maxLength: 1 }), (seed, key) => {
        let buf = "";
        for (const k of seed) buf = dynKeystroke(buf, k);
        const after = dynKeystroke(buf, key);
        if (after === buf) return true; // key was rejected — nothing to undo
        return dynKeystroke(after, "Backspace") === buf;
      }),
    );
  });
});

describe("checkPolygon — properties", () => {
  it("self-intersection detection does not depend on winding, given separated vertices", () => {
    // Reversing a ring traverses the same edges in the opposite order. A sweep that compares segment
    // pairs asymmetrically will disagree with itself here while passing every fixture polygon.
    //
    // Scoped to vertices at least MIN_SEPARATION apart — see the long note on `coord()`. This is the
    // region where a naive orientation determinant can be trusted to sign correctly, and therefore the
    // only region where invariance is a real claim rather than a hope about floating point.
    fc.assert(
      fc.property(
        fc.array(fc.tuple(coord(), coord()), { minLength: 3, maxLength: 12 }),
        (pts) => {
          const separated = pts.every((a, i) =>
            pts.every((b, j) => i === j || Math.hypot(a[0] - b[0], a[1] - b[1]) >= MIN_SEPARATION),
          );
          if (!separated) return true; // precondition, not a pass

          const forward = checkPolygon(pts as [number, number][]);
          const reversed = checkPolygon([...pts].reverse() as [number, number][]);
          return forward.ok === reversed.ok;
        },
      ),
    );
  });

  it("returns a well-formed verdict on nearly-coincident vertices, even if it cannot sign them", () => {
    // The part that must hold with no precondition at all. Whatever the predicate decides about a
    // degenerate ring, it must decide *something* and say why — a NaN leaking out of the determinant
    // would make every downstream comparison false and the polygon would silently read as valid.
    //
    // This is the CI counterexample verbatim: vertices 0 and 2 differ in the last representable bit.
    const almostCoincident: [number, number][] = [
      [0, -0.00010000000000000003],
      [0.0001, -0.0001],
      [0, -0.00010000000000000002],
      [0.0001, 0.0001],
    ];
    const forward = checkPolygon(almostCoincident);
    const reversed = checkPolygon([...almostCoincident].reverse());
    for (const v of [forward, reversed]) {
      expect(typeof v.ok).toBe("boolean");
      if (!v.ok) expect(v.reason.length).toBeGreaterThan(0);
    }
  });

  it("does not crash or hang on subnormal coordinates", () => {
    // The domain note on `coord()` explains why winding-invariance is only asserted over realistic
    // magnitudes. This is the part that still has to hold everywhere: whatever the predicate decides at
    // 1e-300, it must decide *something* and return a well-formed verdict. A NaN leaking out of the
    // determinant would make every subsequent comparison false and the polygon silently "valid".
    const tiny: [number, number][] = [
      [1e-320, 0],
      [0, 1e-310],
      [-1e-320, 1e-320],
      [5e-324, -5e-324],
    ];
    const v = checkPolygon(tiny);
    expect(typeof v.ok).toBe("boolean");
    if (!v.ok) expect(v.reason.length).toBeGreaterThan(0);
  });

  it("always returns a reason when it refuses", () => {
    // A refusal with an empty reason surfaces as a toast with no text — the user sees the tool decline
    // and learns nothing. Every failure path must carry a sentence.
    fc.assert(
      fc.property(fc.array(fc.tuple(coord(), coord()), { maxLength: 12 }), (pts) => {
        const v = checkPolygon(pts as [number, number][]);
        return v.ok || v.reason.trim().length > 0;
      }),
    );
  });
});

describe("a convex square is always accepted", () => {
  it("holds for any size and position", () => {
    fc.assert(
      fc.property(coord(), coord(), fc.double({ min: 0.5, max: 100, noNaN: true }), (x, z, s) => {
        const square: [number, number][] = [[x, z], [x + s, z], [x + s, z + s], [x, z + s]];
        return checkPolygon(square).ok;
      }),
    );
  });
});

describe("sanity: the ported example suites and the properties agree", () => {
  it("a coincident vertex beats a midpoint at the same range", () => {
    const at = { x: 0, z: 0 };
    const r = resolveSnap(at, [
      { x: 0, z: 0, kind: "midpoint" },
      { x: 0, z: 0, kind: "endpoint" },
    ], 0.1);
    expect(r?.kind).toBe("endpoint");
  });
});
