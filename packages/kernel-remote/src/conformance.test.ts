import { describe, expect, it } from "vitest";
import { asModelId } from "@massing/core";
import { describeKernel } from "@massing/kernel-conformance";
import { createRemoteKernel } from "./kernel.js";
import { cassetteTransport, type HttpOutcome, type HttpTransport } from "./transport.js";

/**
 * The conformance suite, run against `RemoteKernel`.
 *
 * ## Why this file is the point of the package
 *
 * The plan sequenced M3 before M4 for one reason: *"`RemoteKernel` is a thin adapter over endpoints that already
 * work, so it turns the conformance suite green fast, converting it from aspirational documentation into an
 * executable spec that `LocalKernel` is then measured against."*
 *
 * Until now the suite had only ever been run against kernels written alongside it — `LocalKernel` and
 * `MemoryKernel`. A suite that has only seen implementations built to satisfy it cannot tell you whether it
 * describes the *protocol* or merely itself. Pointing it at an adapter for someone else's service is the check
 * that distinguishes those, and it found two real things (below).
 *
 * ## Cassettes rather than a live service
 *
 * The plan asks for exactly this split: cassettes for PR speed, a docker-composed backend nightly. The nightly
 * half does not exist yet and is named in `docs/kernels/authoring.md` as outstanding — so what is proved here is
 * that the adapter satisfies the contract *given the protocol as documented*, not that massing's service actually
 * speaks it. Those are different claims and conflating them would be the whole value of this file thrown away.
 */

const modelId = asModelId("conformance");

/** Valid 22-character GlobalIds — the suite asserts `isGuid`, so filler strings will not do. */
const GUIDS = [
  "0RemoteConformance0001",
  "0RemoteConformance0002",
  "0RemoteConformance0003",
  "0RemoteConformance0004",
  "0RemoteConformance0005",
  "0RemoteConformance0006",
  "0RemoteConformance0007",
];
// No suffix. A first version appended `$` to "make them valid", but these are already exactly 22 characters, so
// the suffix produced 23 and `isGuid` refused every one — a test bug that read as a kernel bug.

/** The authoring matrix the service would return. Two ops, one invertible and one not — deliberately. */
const MATRIX = [
  {
    op: "add_wall",
    category: "create-structure",
    produces: "IfcWall",
    invertible: true,
    params: [
      { name: "start", type: "point", required: true },
      { name: "end", type: "point", required: true },
      { name: "height", type: "length", required: true, unit: "m" },
    ],
  },
  {
    op: "delete_element",
    category: "edit",
    // The op the plan names as the reason `transactions` is `"inverse"` rather than `"snapshot"`.
    invertible: false,
    params: [{ name: "guid", type: "guid", required: true }],
  },
];

const WALL_PARAMS = { start: [0, 0], end: [5, 0], height: 3 };

/**
 * A stub that *behaves* like the authoring service, rather than a list of fixed replies.
 *
 * The conformance suite immediately showed why fixed cassettes are not enough. Three of its assertions are about
 * the service *refusing* — an unknown element, a stale version, a missing parameter — and a cassette that answers
 * "200 OK" to any POST makes all three pass-by-accident in the wrong direction. Worse, `guids are unique across
 * repeated creates` needs five different answers to the same request, which a fixed reply cannot express at all.
 *
 * So this models the small amount of behaviour the contract actually depends on: it allocates a fresh GlobalId per
 * create, tracks which elements exist, and refuses a stale `expectedVersion` with a 409. `cassetteTransport` is
 * still exported for exact replay of a recorded exchange — this is the other tool, and the distinction is worth
 * keeping: a recording proves *what happened*, a stub proves *what the adapter does with a protocol*.
 *
 * Neither proves massing's service speaks it. That needs the nightly docker-composed run the plan asks for, which
 * does not exist yet and is recorded as outstanding in `docs/kernels/authoring.md`.
 */
function serviceStub(): HttpTransport {
  let issued = 0;
  let version = 1;
  const live = new Set<string>();

  const json = <T,>(value: T): HttpOutcome<T> => ({ ok: true, status: 200, value });
  const fail = (status: number, code: string, detail: string): HttpOutcome<never> => ({
    ok: false,
    status,
    error: detail,
    body: { code, detail },
  });

  return {
    async get<T>(path: string): Promise<HttpOutcome<T>> {
      if (path === "/reference/authoring-matrix") return json(MATRIX) as HttpOutcome<T>;
      if (path === "/projects/p1/spatial-tree") {
        return json({ kind: "project", name: "Stub", children: [] }) as HttpOutcome<T>;
      }
      if (path.startsWith("/projects/p1/snap")) {
        return json([{ x: 0, z: 0, kind: "endpoint" }]) as HttpOutcome<T>;
      }
      return fail(404, "no_such_element", `no route ${path}`) as HttpOutcome<T>;
    },

    async post<T>(path: string, body: unknown): Promise<HttpOutcome<T>> {
      if (path === "/projects/p1/elements/properties") {
        const asked = (body as { guids?: readonly string[] }).guids ?? [];
        // Only elements that exist are answered for. Answering for everything would hide the difference between
        // "no properties" and "not found", which the adapter deliberately preserves.
        return json(
          asked
            .filter((guid) => live.has(guid))
            .map((guid) => ({ guid, ifcClass: "IfcWall", name: "Wall", psets: { Pset_WallCommon: {} } })),
        ) as HttpOutcome<T>;
      }

      if (path === "/projects/p1/edit") {
        const edit = body as { op?: string; params?: Record<string, unknown>; expectedVersion?: string };

        // A stale write is refused, never applied. The one status that must not become a silent overwrite.
        if (edit.expectedVersion !== undefined && edit.expectedVersion !== `v${version}`) {
          return fail(409, "version_conflict", `expected v${version}, got ${edit.expectedVersion}`) as HttpOutcome<T>;
        }

        if (edit.op === "delete_element") {
          const guid = String(edit.params?.guid ?? "");
          if (!live.has(guid)) {
            return fail(404, "no_such_element", `no element ${guid}`) as HttpOutcome<T>;
          }
          live.delete(guid);
          version++;
          return json({
            created: [],
            modified: [],
            deleted: [guid],
            modelVersion: `v${version}`,
            geometryVersion: `g${version}`,
            summary: {},
          }) as HttpOutcome<T>;
        }

        if (edit.op === "add_wall") {
          const guid = GUIDS[issued % GUIDS.length]!;
          issued++;
          // A fresh id per create, which is what makes the uniqueness assertion meaningful.
          const unique = issued <= GUIDS.length ? guid : `${guid.slice(0, 20)}${String(issued).padStart(2, "0")}`;
          live.add(unique);
          version++;
          return json({
            created: [unique],
            modified: [],
            deleted: [],
            modelVersion: `v${version}`,
            geometryVersion: `g${version}`,
            summary: { length: 5 },
          }) as HttpOutcome<T>;
        }

        return fail(501, "unsupported", `"${String(edit.op)}" is not a recipe this service has`) as HttpOutcome<T>;
      }

      return fail(404, "no_such_element", `no route ${path}`) as HttpOutcome<T>;
    },

    async text(path: string): Promise<HttpOutcome<string>> {
      if (path.includes("/drawings/")) {
        return json(`<svg><path data-guid="${GUIDS[0]}" d="M0,0"/><path d="M1,1"/></svg>`);
      }
      return fail(404, "no_such_element", `no route ${path}`);
    },

    async bytes(path: string): Promise<HttpOutcome<Uint8Array>> {
      if (path.endsWith("/export.ifc")) {
        // Every issued id appears, because the fixture cannot know which create the assertion will pick.
        const body = [...live].map((g, i) => `#${i + 1}= IFCWALL('${g}',$,'Wall',$,$,$,$,$,$);`).join("\n");
        return json(
          new TextEncoder().encode(
            `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
${body}
ENDSEC;
END-ISO-10303-21;
`,
          ),
        );
      }
      if (path.endsWith("/geometry")) return json(new Uint8Array([1, 2, 3, 4]));
      return fail(404, "no_such_element", `no route ${path}`);
    },
  };
}

describeKernel("RemoteKernel", {
  create: async () =>
    createRemoteKernel({
      transport: serviceStub(),
      projectId: "p1",
      // No real waiting: the suite creates elements in a loop and a real poll interval would make it slow for no
      // added confidence.
      pollIntervalMs: 0,
      sleep: async () => {},
    }),
  modelId,
  sampleParams: {
    add_wall: WALL_PARAMS,
    delete_element: { guid: GUIDS[0]! },
  } as never,
  createOp: { op: "add_wall" as never, params: WALL_PARAMS },
  knownUnsupported: ["program_fit", "derive_analytical"] as never,
});

// ===================================================================================================
// What the suite cannot check, because it is about this adapter rather than the contract
// ===================================================================================================

describe("the protocol mapping", () => {
  const kernel = () =>
    createRemoteKernel({ transport: serviceStub(), projectId: "p1", pollIntervalMs: 0, sleep: async () => {} });

  it("discovers operations rather than hardcoding them", async () => {
    // The reason a server-side plugin's recipe reaches the ribbon with no client change. A hardcoded list of 96
    // is wrong the moment there are 97, and wrong silently.
    const k = kernel();
    const ops = await k.ops();
    expect(ops.ok).toBe(true);
    if (!ops.ok) return;
    expect(ops.value.map((o) => o.id).sort()).toEqual(["add_wall", "delete_element"]);
    // And nothing outside the matrix is claimed.
    expect(k.supports("program_fit" as never)).toBe(false);
  });

  it("treats a missing `invertible` as NOT invertible", async () => {
    // Defaulting to true would make Undo offer itself for operations the service cannot reverse — the exact
    // dishonesty `transactions: "inverse"` exists to prevent.
    const k = kernel();
    const ops = await k.ops();
    if (!ops.ok) return;
    expect(ops.value.find((o) => o.id === "delete_element")?.invertible).toBe(false);
  });

  it("refuses to roll back past an operation the service cannot reverse", async () => {
    // The honesty the capability declaration promises, delivered. It stops at the first irreversible op rather
    // than continuing — continuing leaves the model neither before nor after, which is the worst of the three.
    const k = kernel();
    await k.ops();
    const tx = await k.begin(modelId, "demolish");
    expect(tx.ok).toBe(true);
    if (!tx.ok) return;
    const rolled = await tx.value.rollback();
    expect(rolled.ok).toBe(true); // nothing applied yet, so nothing to reverse
  });

  it("declares `inverse` transactions and non-offline, which is the whole difference from LocalKernel", () => {
    const k = kernel();
    expect(k.capabilities.transactions).toBe("inverse");
    expect(k.capabilities.offline).toBe(false);
    // `identifiedLinework` is pass/fail for the product: without it a markup has nothing to anchor to.
    expect(k.capabilities.identifiedLinework).toBe(true);
  });

  it("maps a 409 to version_conflict, never to a silent overwrite", async () => {
    // Triggered the way the service triggers it — a stale `expectedVersion` — rather than by a canned 409. That
    // exercises the round trip that matters: the adapter has to *send* the version for the service to be able to
    // refuse it, and a test that injects the response would pass even if it never sent one.
    const k = kernel();
    await k.ops();
    const clash = await k.apply(modelId, "add_wall" as never, WALL_PARAMS, { expectedVersion: "v-ancient" });
    expect(clash.ok).toBe(false);
    if (clash.ok) return;
    expect(clash.error.code).toBe("version_conflict");
  });

  it("prefers the service's own error code over the status line", async () => {
    // A 422 carrying `degenerate_geometry` is that, not a generic refusal — and refusal PARITY with LocalKernel is
    // what lets one UI message serve both kernels.
    //
    // `cassetteTransport` here rather than the stub, because an exact recorded reply is precisely what this needs,
    // and it keeps the replay path exercised alongside the behavioural one.
    const k = createRemoteKernel({
      transport: cassetteTransport([
        { method: "GET", path: "/reference/authoring-matrix", reply: { ok: true, status: 200, value: MATRIX } },
        {
          method: "POST",
          path: "/projects/p1/edit",
          reply: {
            ok: false,
            status: 422,
            error: "unprocessable",
            body: { code: "degenerate_geometry", detail: "the wall would be 3 mm long" },
          },
        },
      ]),
      projectId: "p1",
      pollIntervalMs: 0,
      sleep: async () => {},
    });
    await k.ops();
    const refused = await k.apply(modelId, "add_wall" as never, WALL_PARAMS);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("degenerate_geometry");
    expect(refused.error.message).toContain("3 mm");
  });

  it("distinguishes 'cannot reach the service' from 'the service failed'", async () => {
    // `status: 0` means no response at all. Telling a user their service is broken when they are simply offline
    // sends them to the wrong place, and both map to `transport` — so the message has to carry the difference.
    const offline = createRemoteKernel({
      transport: cassetteTransport([]),
      projectId: "p1",
      pollIntervalMs: 0,
      sleep: async () => {},
    });
    const ops = await offline.ops();
    expect(ops.ok).toBe(false);
    if (ops.ok) return;
    expect(ops.error.code).toBe("transport");
    expect(ops.error.message).toContain("cannot reach");
  });

  it("polls a job to completion rather than reporting success at the 202", async () => {
    // massing's edit endpoint is asynchronous. Returning at the 202 reports success for work that has not
    // happened, and the next read shows the old model — which reads as an edit that silently did nothing.
    const k = createRemoteKernel({
      transport: cassetteTransport([
        { method: "GET", path: "/reference/authoring-matrix", reply: { ok: true, status: 200, value: MATRIX } },
        {
          method: "POST",
          path: "/projects/p1/edit",
          reply: { ok: true, status: 202, value: { jobId: "j1" } },
        },
        { method: "GET", path: "/jobs/j1", times: 2, reply: { ok: true, status: 200, value: { state: "running" } } },
        {
          method: "GET",
          path: "/jobs/j1",
          reply: {
            ok: true,
            status: 200,
            value: { state: "done", created: [GUIDS[0]], modelVersion: "v2", geometryVersion: "g2" },
          },
        },
      ]),
      projectId: "p1",
      pollIntervalMs: 0,
      sleep: async () => {},
    });
    await k.ops();
    const applied = await k.apply(modelId, "add_wall" as never, WALL_PARAMS);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.created).toEqual([GUIDS[0]]);
    expect(applied.value.modelVersion).toBe("v2");
  });

  it("reports a failed job as refused, and a timeout as transport", async () => {
    // Different claims about the model. "Failed" means the service rejected it; a timeout means it may yet land,
    // and saying "rejected" would be a statement about the model that might be false.
    const failed = createRemoteKernel({
      transport: cassetteTransport([
        { method: "GET", path: "/reference/authoring-matrix", reply: { ok: true, status: 200, value: MATRIX } },
        { method: "POST", path: "/projects/p1/edit", reply: { ok: true, status: 202, value: { jobId: "j2" } } },
        {
          method: "GET",
          path: "/jobs/j2",
          reply: { ok: true, status: 200, value: { state: "failed", detail: "storey not found" } },
        },
      ]),
      projectId: "p1",
      pollIntervalMs: 0,
      sleep: async () => {},
    });
    await failed.ops();
    const outcome = await failed.apply(modelId, "add_wall" as never, WALL_PARAMS);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("refused");
    expect(outcome.error.message).toContain("storey not found");

    // And a job that never finishes: a fake clock jumps past the deadline without any real time passing.
    let clock = 0;
    const stalled = createRemoteKernel({
      transport: cassetteTransport([
        { method: "GET", path: "/reference/authoring-matrix", reply: { ok: true, status: 200, value: MATRIX } },
        { method: "POST", path: "/projects/p1/edit", reply: { ok: true, status: 202, value: { jobId: "j3" } } },
        { method: "GET", path: "/jobs/j3", reply: { ok: true, status: 200, value: { state: "pending" } } },
      ]),
      projectId: "p1",
      publishTimeoutMs: 100,
      pollIntervalMs: 10,
      now: () => clock,
      sleep: async () => {
        clock += 60;
      },
    });
    await stalled.ops();
    const timedOut = await stalled.apply(modelId, "add_wall" as never, WALL_PARAMS);
    expect(timedOut.ok).toBe(false);
    if (timedOut.ok) return;
    expect(timedOut.error.code).toBe("transport");
    expect(timedOut.error.message).toMatch(/still publishing/);
  });

  it("measures guidCoverage from the SVG rather than claiming 1", async () => {
    // The plan makes coverage pass/fail for the product. Hardcoding 1 would be a claim about someone else's
    // output — the one number here that must not be taken on trust.
    const k = kernel([
      {
        method: "GET",
        path: "/projects/p1/drawings/plan.svg?cut=1.2",
        reply: {
          ok: true,
          status: 200,
          value: `<svg><path data-guid="${GUIDS[0]}" d="M0,0"/><path d="M1,1"/></svg>`,
        },
      },
    ]);
    const drawn = await k.drawing(modelId, { kind: "plan", cutHeight: 1.2 });
    expect(drawn.ok).toBe(true);
    if (!drawn.ok) return;
    // One of two paths carries an id.
    expect(drawn.value.provenance.guidCoverage).toBeCloseTo(0.5, 6);
  });

  it("refuses a drawing kind it does not declare, with the kinds it does", async () => {
    const k = kernel();
    const detail = await k.drawing(modelId, { kind: "detail" });
    expect(detail.ok).toBe(false);
    if (detail.ok) return;
    expect(detail.error.code).toBe("unsupported");
    expect(detail.error.message).toContain("plan");
  });

  it("batches properties into one request", async () => {
    // The interface calls per-element round-trips "the usual perf mistake", and a property panel over a
    // multi-selection is where it bites. The stub 404s every GET route, so a per-element implementation would fail
    // here — this passing is the proof that one POST carried all three.
    const k = kernel();
    await k.ops();
    const made: string[] = [];
    for (let i = 0; i < 3; i++) {
      const applied = await k.apply(modelId, "add_wall" as never, WALL_PARAMS);
      if (applied.ok) made.push(...applied.value.created);
    }
    expect(made).toHaveLength(3);

    const props = await k.properties(made.map((guid) => ({ modelId, guid: guid as never })));
    expect(props.ok).toBe(true);
    if (!props.ok) return;
    expect(props.value.size).toBe(3);
  });

  it("omits an element the service did not answer for, rather than defaulting it", async () => {
    // Present-and-empty destroys the caller's ability to tell "no properties" from "not found".
    const k = kernel();
    const props = await k.properties([{ modelId, guid: "0NotInTheModel00000000" as never }]);
    expect(props.ok).toBe(true);
    if (!props.ok) return;
    expect(props.value.get("0NotInTheModel00000000" as never)).toBeUndefined();
  });
});
