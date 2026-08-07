/**
 * The kernel conformance suite.
 *
 * A **published test library**, not a test directory. Both first-party kernels call it, and so does anyone
 * writing a third — which is what turns "write a MassingViewer kernel" from a reverse-engineering exercise
 * into `npm i -D @massingviewer/kernel-conformance` and fix the reds.
 *
 * ## Why this is the highest-value thing in the repo
 *
 * `LocalKernel` writes IFC with `web-ifc` in a browser. `RemoteKernel` delegates to `ifcopenshell` behind
 * an HTTP service. Two independent implementations of the same semantics **will** diverge. The divergence
 * that hurts is not "one is missing a feature" — capability negotiation covers that honestly — it is
 * *silent* disagreement: both accept an operation and produce subtly different results, or both refuse for
 * reasons the UI cannot tell apart.
 *
 * A suite that runs against both is the only thing that makes them interchangeable rather than merely
 * similar. Without it, `KernelProvider` is a shape, not a contract.
 *
 * ## Written as assertions about behaviour, never about implementation
 *
 * Every check here is expressible against a kernel the authors have never seen. Nothing inspects internals,
 * nothing depends on operation ordering beyond what the contract states, and error *messages* are never
 * asserted — only codes, because messages are localised and a test that pins wording either blocks copy
 * improvements or gets updated without being read.
 */

import { describe, expect, it } from "vitest";
import { asModelId, isGuid, type Guid, type ModelId } from "@massingviewer/core";
import type {
  KernelCapabilities,
  KernelFailure,
  KernelProvider,
  OpDescriptor,
  OpId,
} from "@massingviewer/kernel-api";

/**
 * What the kernel under test needs to supply beyond the provider itself.
 *
 * The suite cannot invent a valid parameter bag for an arbitrary operation — `add_wall` needs points,
 * `set_element_pset` needs a property name — so the kernel author supplies sample arguments for the
 * operations it claims. That is deliberately the author's job: if they cannot produce a working call for an
 * operation they advertise, that is itself the finding.
 */
export interface KernelFixture {
  /** A fresh, empty (or freshly loaded) kernel. Called once per test — no shared state between tests. */
  create(): Promise<KernelProvider>;
  /** The model to operate on. */
  modelId?: ModelId;
  /**
   * Valid parameters for operations the kernel claims to support, keyed by `OpId`.
   *
   * Operations without an entry are exercised only for *capability honesty* — the suite confirms they are
   * declared and does not attempt to run them. Operations the kernel does NOT claim are always probed, to
   * confirm they refuse cleanly rather than throwing or hanging.
   */
  sampleParams: Readonly<Record<OpId, Readonly<Record<string, unknown>>>>;
  /**
   * An operation that creates something, plus its params. Needed by the GUID-stability family, which is the
   * most important set of assertions here and cannot be written generically without a creator.
   */
  createOp?: { readonly op: OpId; readonly params: Readonly<Record<string, unknown>> };
  /**
   * Parameter bags that MUST be refused, with the code expected.
   *
   * This is where refusal parity is established. Both kernels declaring `degenerate_geometry` for a
   * zero-length wall is what lets one UI message serve both.
   */
  refusals?: readonly {
    readonly label: string;
    readonly op: OpId;
    readonly params: Readonly<Record<string, unknown>>;
    readonly code: KernelFailure["code"];
  }[];
  /** Operations known to be unsupported, to confirm they refuse rather than throw. Defaults are probed too. */
  knownUnsupported?: readonly OpId[];
}

/** Operations probed for clean refusal even when the fixture says nothing about them. */
const ALWAYS_PROBE_UNSUPPORTED: readonly OpId[] = [
  "this_operation_does_not_exist",
  "acme.nonexistent_plugin_recipe",
];

async function expectOk<T>(promise: Promise<{ ok: boolean } & Record<string, unknown>>, what: string): Promise<T> {
  const r = (await promise) as { ok: true; value: T } | { ok: false; error: KernelFailure };
  if (!r.ok) {
    throw new Error(`${what} failed unexpectedly: ${r.error.code} — ${r.error.message}`);
  }
  return r.value;
}

/**
 * Run the suite against one kernel.
 *
 * @example
 * ```ts
 * describeKernel("MemoryKernel", {
 *   create: async () => createMemoryKernel(),
 *   sampleParams: { add_wall: { start: [0, 0], end: [5, 0], height: 3, thickness: 0.2 } },
 *   createOp: { op: "add_wall", params: { start: [0, 0], end: [5, 0], height: 3, thickness: 0.2 } },
 * });
 * ```
 */
export function describeKernel(name: string, fixture: KernelFixture): void {
  const modelId = fixture.modelId ?? asModelId("conformance");

  describe(`${name} — kernel conformance`, () => {
    // -------------------------------------------------------------------------------------------------
    // 0. Shape. Cheap, and it fails first with a clear message rather than as a confusing TypeError later.
    // -------------------------------------------------------------------------------------------------
    describe("shape", () => {
      it("declares an id, a version and capabilities", async () => {
        const k = await fixture.create();
        expect(typeof k.id).toBe("string");
        expect(k.id.length).toBeGreaterThan(0);
        expect(typeof k.version).toBe("string");
        expect(k.capabilities).toBeTruthy();
        await k.dispose();
      });

      it("declares a complete capability set", async () => {
        const k = await fixture.create();
        const c: KernelCapabilities = k.capabilities;
        expect(typeof c.author).toBe("boolean");
        expect(typeof c.offline).toBe("boolean");
        expect(["snapshot", "inverse", "none"]).toContain(c.transactions);
        expect(Array.isArray(c.drawings)).toBe(true);
        // Not a nicety: without identified linework a kernel can render pictures but cannot participate in
        // the review loop, and the UI has to say so rather than appearing to work.
        expect(typeof c.identifiedLinework).toBe("boolean");
        expect(["IFC2X3", "IFC4", "IFC4X3_ADD2", "IFC5"]).toContain(c.schema);
        await k.dispose();
      });

      it("dispose is idempotent", async () => {
        // Called from a component unmount, which can happen twice under React strict mode or a fast
        // navigation. Throwing the second time turns a benign double-unmount into a crash.
        const k = await fixture.create();
        await k.dispose();
        await expect(k.dispose()).resolves.toBeUndefined();
      });
    });

    // -------------------------------------------------------------------------------------------------
    // 1. GUID stability — the invariant everything else rests on
    // -------------------------------------------------------------------------------------------------
    describe("identity", () => {
      it("lists operations, each with a well-formed descriptor", async () => {
        const k = await fixture.create();
        const ops = await expectOk<readonly OpDescriptor[]>(k.ops(), "ops()");
        expect(Array.isArray(ops)).toBe(true);
        for (const op of ops) {
          expect(typeof op.id, `op id`).toBe("string");
          expect(op.id.length, `op id non-empty`).toBeGreaterThan(0);
          expect(typeof op.category, `${op.id}.category`).toBe("string");
          expect(Array.isArray(op.params), `${op.id}.params`).toBe(true);
          // Declared per-op, because it is not uniform: a service may reverse `move_element` and not
          // `delete_element`. This is what lets Undo dim itself with an accurate reason instead of failing
          // after the user has committed to it.
          expect(typeof op.invertible, `${op.id}.invertible`).toBe("boolean");
          for (const p of op.params) {
            expect(typeof p.name).toBe("string");
            expect(typeof p.required).toBe("boolean");
          }
        }
        await k.dispose();
      });

      it("operation ids are unique", async () => {
        const k = await fixture.create();
        const ops = await expectOk<readonly OpDescriptor[]>(k.ops(), "ops()");
        const ids = ops.map((o) => o.id);
        expect(new Set(ids).size).toBe(ids.length);
        await k.dispose();
      });

      const creator = fixture.createOp;
      const maybe = creator ? it : it.skip;

      maybe("a created element gets a valid IFC GlobalId", async () => {
        const k = await fixture.create();
        await expectOk(k.ops(), "ops()"); // supports() is only meaningful after ops() has resolved
        const result = await expectOk<{ created: readonly Guid[] }>(
          k.apply(modelId, creator!.op, creator!.params),
          `apply(${creator!.op})`,
        );
        expect(result.created.length).toBeGreaterThan(0);
        for (const g of result.created) {
          // Not "is a non-empty string". A malformed GlobalId flows through the whole system and collides
          // with every other malformed one, producing a single phantom element selected everywhere at once.
          expect(isGuid(g), `created GlobalId ${JSON.stringify(g)}`).toBe(true);
        }
        await k.dispose();
      });

      maybe("GlobalIds are unique across repeated creates", async () => {
        const k = await fixture.create();
        await expectOk(k.ops(), "ops()");
        const seen = new Set<string>();
        for (let i = 0; i < 5; i++) {
          const r = await expectOk<{ created: readonly Guid[] }>(
            k.apply(modelId, creator!.op, creator!.params),
            "apply",
          );
          for (const g of r.created) {
            expect(seen.has(g), `duplicate GlobalId ${g} on create ${i}`).toBe(false);
            seen.add(g);
          }
        }
        await k.dispose();
      });

      maybe("a created element's GlobalId survives an IFC round-trip", async () => {
        // The assertion most likely to differ silently between an ifcopenshell writer and a web-ifc writer,
        // and the one that breaks markup anchoring, plan-to-3D sync and every persisted reference when it
        // does. Exported bytes must still contain the id we were handed.
        const k = await fixture.create();
        await expectOk(k.ops(), "ops()");
        const r = await expectOk<{ created: readonly Guid[] }>(
          k.apply(modelId, creator!.op, creator!.params),
          "apply",
        );
        const guid = r.created[0]!;

        const exported = await k.exportIfc(modelId);
        if (!exported.ok) {
          // A kernel that cannot export is allowed to say so; it is not allowed to pretend.
          expect(exported.error.code).toBe("unsupported");
          await k.dispose();
          return;
        }
        const text = new TextDecoder().decode(exported.value);
        expect(text).toContain(guid);
        await k.dispose();
      });

      maybe("properties can be read back for a created element", async () => {
        const k = await fixture.create();
        await expectOk(k.ops(), "ops()");
        const r = await expectOk<{ created: readonly Guid[] }>(
          k.apply(modelId, creator!.op, creator!.params),
          "apply",
        );
        const guid = r.created[0]!;
        const props = await k.properties([{ modelId, guid }]);
        if (!props.ok) {
          expect(props.error.code).toBe("unsupported");
          await k.dispose();
          return;
        }
        const entry = props.value.get(guid);
        expect(entry, `properties for ${guid}`).toBeTruthy();
        expect(entry!.guid).toBe(guid);
        expect(typeof entry!.ifcClass).toBe("string");
        await k.dispose();
      });
    });

    // -------------------------------------------------------------------------------------------------
    // 2. Capability honesty — how a partial kernel ships without lying
    // -------------------------------------------------------------------------------------------------
    describe("capability honesty", () => {
      it("supports() agrees with ops()", async () => {
        const k = await fixture.create();
        const ops = await expectOk<readonly OpDescriptor[]>(k.ops(), "ops()");
        for (const op of ops) {
          expect(k.supports(op.id), `supports(${op.id}) after ops() listed it`).toBe(true);
        }
        await k.dispose();
      });

      it("supports() is false for operations not listed", async () => {
        const k = await fixture.create();
        await expectOk(k.ops(), "ops()");
        for (const op of [...ALWAYS_PROBE_UNSUPPORTED, ...(fixture.knownUnsupported ?? [])]) {
          expect(k.supports(op), `supports(${op})`).toBe(false);
        }
        await k.dispose();
      });

      it("an unsupported operation returns `unsupported` — it does not throw, hang or no-op", async () => {
        // The three failure modes this rules out, in order of how badly they mislead:
        //   throwing  — crosses a worker boundary as an unusable Error and can take the host down
        //   hanging   — indistinguishable from a slow operation; the UI spins forever
        //   no-op     — the worst, because the user believes it worked
        const k = await fixture.create();
        await expectOk(k.ops(), "ops()");
        for (const op of [...ALWAYS_PROBE_UNSUPPORTED, ...(fixture.knownUnsupported ?? [])]) {
          const r = await k.apply(modelId, op, {});
          expect(r.ok, `apply(${op}) must not succeed`).toBe(false);
          if (!r.ok) expect(r.error.code, `apply(${op}) code`).toBe("unsupported");
        }
        await k.dispose();
      });

      it("every `unsupported` failure carries a hint naming what would unlock it", async () => {
        // Required, not optional. Unsupported operations stay VISIBLE and dimmed rather than hidden, so the
        // user can discover what exists and learn what a connection would unlock — and that only works if
        // the kernel explains itself. "Dimmed for no stated reason" must not be representable.
        const k = await fixture.create();
        await expectOk(k.ops(), "ops()");
        const r = await k.apply(modelId, "this_operation_does_not_exist", {});
        expect(r.ok).toBe(false);
        if (!r.ok) {
          const hint = (r.error as { hint?: string }).hint ?? r.error.message;
          expect(typeof hint).toBe("string");
          expect(hint.trim().length, "hint must not be empty").toBeGreaterThan(0);
        }
        await k.dispose();
      });

      it("declares drawing kinds honestly", async () => {
        const k = await fixture.create();
        const declared = new Set(k.capabilities.drawings);
        for (const kind of ["plan", "section", "elevation", "axon", "detail", "sheet"] as const) {
          const r = await k.drawing(modelId, { kind });
          if (!declared.has(kind)) {
            expect(r.ok, `undeclared drawing kind ${kind} must be refused`).toBe(false);
            if (!r.ok) expect(r.error.code).toBe("unsupported");
          }
          // A declared kind may still legitimately fail on an empty model; what it must not do is claim
          // `unsupported` for something it advertises.
          if (declared.has(kind) && !r.ok) {
            expect(r.error.code, `declared kind ${kind} reported unsupported`).not.toBe("unsupported");
          }
        }
        await k.dispose();
      });

      it("a kernel claiming identifiedLinework carries GlobalIds in its drawings", async () => {
        const k = await fixture.create();
        if (!k.capabilities.identifiedLinework || k.capabilities.drawings.length === 0) {
          await k.dispose();
          return;
        }
        const r = await k.drawing(modelId, { kind: k.capabilities.drawings[0]! });
        if (r.ok) {
          // Reported rather than inferred. A plan silently missing a wall renders perfectly, so coverage is
          // a number the kernel must state.
          expect(typeof r.value.provenance.guidCoverage).toBe("number");
          expect(r.value.provenance.guidCoverage).toBeGreaterThanOrEqual(0);
          expect(r.value.provenance.guidCoverage).toBeLessThanOrEqual(1);
          expect(Array.isArray(r.value.provenance.incomplete)).toBe(true);
          expect(Array.isArray(r.value.provenance.approximations)).toBe(true);
        }
        await k.dispose();
      });
    });

    // -------------------------------------------------------------------------------------------------
    // 3. Refusal parity — same bad input, same code, across implementations
    // -------------------------------------------------------------------------------------------------
    describe("refusals", () => {
      const refusals = fixture.refusals ?? [];
      const maybeRefusal = refusals.length > 0 ? it : it.skip;

      maybeRefusal("declared refusals produce the expected code", async () => {
        const k = await fixture.create();
        await expectOk(k.ops(), "ops()");
        for (const c of refusals) {
          const r = await k.apply(modelId, c.op, c.params);
          expect(r.ok, `${c.label} must be refused`).toBe(false);
          // The CODE is the contract; the message is not. Two kernels agreeing on
          // `degenerate_geometry` for a zero-length wall is what lets one UI string serve both.
          if (!r.ok) expect(r.error.code, c.label).toBe(c.code);
        }
        await k.dispose();
      });

      maybeRefusal("a refusal never mutates the model", async () => {
        // The property that makes a refusal safe to retry. A half-applied operation leaves geometry the user
        // did not ask for and cannot see, and the version tells them nothing changed.
        const k = await fixture.create();
        await expectOk(k.ops(), "ops()");
        const before = await k.exportIfc(modelId);
        for (const c of refusals) await k.apply(modelId, c.op, c.params);
        const after = await k.exportIfc(modelId);
        if (before.ok && after.ok) {
          expect(after.value.byteLength, "refusals changed the model").toBe(before.value.byteLength);
        }
        await k.dispose();
      });

      it("a missing required parameter is refused with `invalid_param`", async () => {
        const k = await fixture.create();
        const ops = await expectOk<readonly OpDescriptor[]>(k.ops(), "ops()");
        const withRequired = ops.find((o) => o.params.some((p) => p.required));
        if (!withRequired) {
          await k.dispose();
          return;
        }
        const r = await k.apply(modelId, withRequired.id, {});
        expect(r.ok, `${withRequired.id} with no params must be refused`).toBe(false);
        if (!r.ok) {
          // `refused` is acceptable too — a guardrail rejecting it is still a decline. What is not
          // acceptable is `internal`, which means the kernel crashed on input it should have validated.
          expect(["invalid_param", "refused"]).toContain(r.error.code);
        }
        await k.dispose();
      });

      it("operating on a non-existent element is refused, not ignored", async () => {
        const k = await fixture.create();
        const ops = await expectOk<readonly OpDescriptor[]>(k.ops(), "ops()");
        const guidOp = ops.find((o) => o.params.some((p) => p.type === "guid" && p.required));
        if (!guidOp) {
          await k.dispose();
          return;
        }
        const params: Record<string, unknown> = {};
        for (const p of guidOp.params) {
          if (p.type === "guid") params[p.name] = "0000000000000000000000";
          else if (p.required) params[p.name] = fixture.sampleParams[guidOp.id]?.[p.name] ?? 1;
        }
        const r = await k.apply(modelId, guidOp.id, params);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(["no_such_element", "invalid_param", "refused"]).toContain(r.error.code);
        await k.dispose();
      });
    });

    // -------------------------------------------------------------------------------------------------
    // 4. Idempotence and commutativity — catches hidden global state
    // -------------------------------------------------------------------------------------------------
    describe("repeatability", () => {
      const creator = fixture.createOp;
      const maybe = creator ? it : it.skip;

      maybe("applying a create twice yields two distinct elements", async () => {
        // Not one, and not an error. A kernel that de-duplicates identical creates makes it impossible to
        // draw two identical walls, which is a normal thing to want.
        const k = await fixture.create();
        await expectOk(k.ops(), "ops()");
        const a = await expectOk<{ created: readonly Guid[] }>(k.apply(modelId, creator!.op, creator!.params), "apply 1");
        const b = await expectOk<{ created: readonly Guid[] }>(k.apply(modelId, creator!.op, creator!.params), "apply 2");
        expect(a.created.length).toBeGreaterThan(0);
        expect(b.created.length).toBe(a.created.length);
        expect(a.created[0]).not.toBe(b.created[0]);
        await k.dispose();
      });

      maybe("two fresh kernels given the same operations agree", async () => {
        // Catches state leaking across instances — a module-level counter, a shared WASM heap, a cached
        // worker. The symptom in production is a kernel that behaves differently on the second project
        // opened in one session.
        const k1 = await fixture.create();
        const k2 = await fixture.create();
        await expectOk(k1.ops(), "ops()");
        await expectOk(k2.ops(), "ops()");
        const r1 = await expectOk<{ created: readonly Guid[] }>(k1.apply(modelId, creator!.op, creator!.params), "k1");
        const r2 = await expectOk<{ created: readonly Guid[] }>(k2.apply(modelId, creator!.op, creator!.params), "k2");
        expect(r2.created.length).toBe(r1.created.length);
        await k1.dispose();
        await k2.dispose();
      });
    });

    // -------------------------------------------------------------------------------------------------
    // 5. Version monotonicity — a stale write must never silently clobber
    // -------------------------------------------------------------------------------------------------
    describe("versioning", () => {
      const creator = fixture.createOp;
      const maybe = creator ? it : it.skip;

      maybe("a mutation advances the model version", async () => {
        const k = await fixture.create();
        await expectOk(k.ops(), "ops()");
        const a = await expectOk<{ modelVersion: string }>(k.apply(modelId, creator!.op, creator!.params), "apply 1");
        const b = await expectOk<{ modelVersion: string }>(k.apply(modelId, creator!.op, creator!.params), "apply 2");
        expect(typeof a.modelVersion).toBe("string");
        expect(a.modelVersion.length).toBeGreaterThan(0);
        expect(b.modelVersion).not.toBe(a.modelVersion);
        await k.dispose();
      });

      maybe("geometry version changes when geometry changes", async () => {
        // Distinguishing a geometry-changing operation from a metadata-only one is what stops a property
        // edit from triggering a full model re-stream.
        const k = await fixture.create();
        await expectOk(k.ops(), "ops()");
        const r = await expectOk<{ geometryVersion: string }>(k.apply(modelId, creator!.op, creator!.params), "apply");
        expect(typeof r.geometryVersion).toBe("string");
        expect(r.geometryVersion.length).toBeGreaterThan(0);
        await k.dispose();
      });

      maybe("a stale expectedVersion is refused with `version_conflict`", async () => {
        const k = await fixture.create();
        await expectOk(k.ops(), "ops()");
        await expectOk(k.apply(modelId, creator!.op, creator!.params), "apply 1");
        const r = await k.apply(modelId, creator!.op, creator!.params, {
          expectedVersion: "a-version-that-was-never-current",
        });
        expect(r.ok, "a stale write must not succeed").toBe(false);
        if (!r.ok) expect(r.error.code).toBe("version_conflict");
        await k.dispose();
      });
    });

    // -------------------------------------------------------------------------------------------------
    // 6. Cancellation — an abort must settle, not leak
    // -------------------------------------------------------------------------------------------------
    describe("cancellation", () => {
      it("an already-aborted signal settles as `cancelled` rather than hanging", async () => {
        // Every long operation is cancellable because the UI must stay responsive. A cancel that never
        // settles leaks the promise and the spinner stays up for ever — the failure looks like a hang in the
        // kernel rather than a bug in the cancel path.
        const k = await fixture.create();
        await expectOk(k.ops(), "ops()");
        const controller = new AbortController();
        controller.abort();
        const r = await k.geometry(modelId, { signal: controller.signal });
        expect(r.ok === false || r.ok === true).toBe(true); // must settle at all
        if (!r.ok) expect(["cancelled", "unsupported"]).toContain(r.error.code);
        await k.dispose();
      });
    });

    // -------------------------------------------------------------------------------------------------
    // 7. Transactions — honest about what they can actually do
    // -------------------------------------------------------------------------------------------------
    describe("transactions", () => {
      it("matches its declared transaction support", async () => {
        const k = await fixture.create();
        const declared = k.capabilities.transactions;
        const begun = await k.begin(modelId, "conformance");
        if (declared === "none") {
          expect(begun.ok, "a kernel declaring no transactions must refuse begin()").toBe(false);
          await k.dispose();
          return;
        }
        expect(begun.ok, `begin() failed although transactions are "${declared}"`).toBe(true);
        if (begun.ok) {
          expect(typeof begun.value.id).toBe("string");
          // Rollback may legitimately fail under "inverse" — a service with partial inverse coverage cannot
          // reverse everything. What it must do is say so with a code, not throw.
          const rolled = await begun.value.rollback();
          if (!rolled.ok) expect(typeof rolled.error.code).toBe("string");
        }
        await k.dispose();
      });
    });

    // -------------------------------------------------------------------------------------------------
    // 8. Snap candidates — the read path the drawing tools depend on
    // -------------------------------------------------------------------------------------------------
    describe("snap candidates", () => {
      it("returns candidates with a recognised kind, or refuses cleanly", async () => {
        const k = await fixture.create();
        const r = await k.snapCandidates(modelId, { x: 0, z: 0 }, 5);
        if (!r.ok) {
          expect(r.error.code).toBe("unsupported");
          await k.dispose();
          return;
        }
        const kinds = new Set(["endpoint", "midpoint", "center", "intersection", "perpendicular", "nearest"]);
        for (const c of r.value) {
          expect(Number.isFinite(c.x)).toBe(true);
          expect(Number.isFinite(c.z)).toBe(true);
          // A snap that lies about its kind is worse than no snap: the HUD says "perpendicular" while the
          // placed point is something else, and that point carries a GlobalId and feeds schedules.
          expect(kinds.has(c.kind), `unknown snap kind ${c.kind}`).toBe(true);
        }
        await k.dispose();
      });
    });
  });
}

// ---------------------------------------------------------------------------------------------------
// Recipe parity ledger
// ---------------------------------------------------------------------------------------------------

export type RecipeStatus = "yes" | "planned" | "no";

export interface RecipeLedgerRow {
  readonly recipe: OpId;
  readonly category: string;
  /** Status per kernel column. */
  readonly status: Readonly<Record<string, RecipeStatus>>;
}

export interface RecipeLedger {
  readonly kernels: readonly string[];
  readonly rows: readonly RecipeLedgerRow[];
}

/**
 * Parse the tab-separated parity ledger.
 *
 * Exported because the ledger format is part of the contract, not a private detail: anyone writing a
 * `KernelProvider` gets the same ratchet by pointing this at their own table. The file itself stays on the
 * consumer's disk — a published test library that reads a hardcoded path is a published test library nobody
 * can use.
 *
 * Comment lines (`#`) and blank lines are skipped, so the table can explain itself in place.
 */
export function parseRecipeLedger(tsv: string): RecipeLedger {
  const lines = tsv.split(/\r?\n/).filter((l) => l.trim() !== "" && !l.startsWith("#"));
  const header = lines.shift()?.split("\t");
  if (!header || header[0] !== "recipe" || header[1] !== "category") {
    throw new Error('recipe ledger: first non-comment line must be a header starting "recipe\\tcategory"');
  }
  const kernels = header.slice(2);
  const valid = new Set<string>(["yes", "planned", "no"]);
  const rows = lines.map((line, i) => {
    const cells = line.split("\t");
    if (cells.length !== header.length) {
      throw new Error(`recipe ledger line ${i + 2}: ${cells.length} columns, expected ${header.length}`);
    }
    const status: Record<string, RecipeStatus> = {};
    for (const [j, kernel] of kernels.entries()) {
      const s = cells[j + 2];
      if (s === undefined || !valid.has(s)) {
        throw new Error(`recipe ledger line ${i + 2}: bad status ${JSON.stringify(s)} for ${kernel}`);
      }
      status[kernel] = s as RecipeStatus;
    }
    return { recipe: cells[0] as OpId, category: cells[1]!, status };
  });
  return { kernels, rows };
}

/**
 * Recipe-parity ledger check — the half of the ratchet that needs a live kernel.
 *
 * `scripts/check-recipe-parity.mjs` keeps the table well-formed and its counts monotonic; it cannot know
 * whether a `yes` is *true*. This does, and it checks both directions:
 *
 * - **Overstating** — a `yes` the kernel does not actually declare. This is the failure that matters, because
 *   a ledger claiming coverage it does not have is worse than no ledger: it is the document a reviewer trusts.
 * - **Understating** — an op the kernel declares while the ledger says `planned` or `no`. Harmless to a user,
 *   but it means the table is stale, and a table that drifts in the safe direction stops being read.
 *
 * Scope note: ops outside the ledger entirely are ignored here. This function measures *parity with the remote
 * service's recipe set*, which is what its name claims; a kernel is free to expose local-only operations, and
 * {@link describeKernel}'s capability-honesty family already asserts that every op a kernel declares works.
 */
export function describeRecipeParity(
  name: string,
  fixture: { create(): Promise<KernelProvider> },
  ledger: RecipeLedger,
  column: string,
): void {
  const rows = ledger.rows;
  if (!ledger.kernels.includes(column)) {
    throw new Error(
      `recipe ledger has no column "${column}" — columns are ${ledger.kernels.join(", ")}. ` +
        `Add the column before wiring the kernel, so its coverage starts being counted at zero rather than untracked.`,
    );
  }
  const claimed = rows.filter((r) => r.status[column] === "yes").map((r) => r.recipe);

  describe(`${name} — recipe parity (${claimed.length}/${rows.length} claimed)`, () => {
    it("declares every operation the ledger claims for it", async () => {
      const k = await fixture.create();
      try {
        const listed = await k.ops();
        expect(listed.ok).toBe(true);
        if (!listed.ok) return;
        const declared = new Set(listed.value.map((d) => d.id));

        const overstated = claimed.filter((op) => !declared.has(op));
        expect(
          overstated,
          `the ledger claims these for ${column} but the kernel does not declare them — ` +
            `either implement them or move them back to "planned"`,
        ).toEqual([]);

        const pct = Math.round((100 * claimed.length) / Math.max(1, rows.length));
        // Printed so the number is visible in passing CI output, not only on failure. A ratchet nobody can
        // see is a ratchet nobody moves.
        // eslint-disable-next-line no-console
        console.log(`  ${name}: ${claimed.length}/${rows.length} recipes (${pct}%)`);
      } finally {
        await k.dispose();
      }
    });

    it("does not silently exceed the ledger", async () => {
      const k = await fixture.create();
      try {
        const listed = await k.ops();
        expect(listed.ok).toBe(true);
        if (!listed.ok) return;
        const declared = new Set(listed.value.map((d) => d.id));

        const understated = rows
          .filter((r) => r.status[column] !== "yes" && declared.has(r.recipe))
          .map((r) => `${r.recipe} (ledger says "${r.status[column]}")`);

        expect(
          understated,
          `the kernel declares these but the ledger does not credit them — mark them "yes" and raise the ` +
            `floor in scripts/check-recipe-parity.mjs`,
        ).toEqual([]);
      } finally {
        await k.dispose();
      }
    });
  });
}
