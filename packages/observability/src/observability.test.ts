import { describe, expect, it, vi } from "vitest";
import { REDACTION_RULES, redact, redactValue, redactionLimits } from "./redact";
import { APP_SCHEMA, bucketDuration, createTelemetry, type TelemetrySchema } from "./telemetry";
import { NOOP_CRASH_SINK, consoleSink, createCrashHandler, httpSink, redactReport, type CrashReport } from "./crash";
import { auditCoverage, createAuditLog, teeAudit, type AuditEntry } from "./audit";
import { envelope, isVersioned, migrate, validateChain, type MigrationStep } from "./migrate";
import { APP_FLAGS, createFlags, expiredFlags, queryFlagSource, storageFlagSource } from "./flags";

// ===================================================================================================
// The requirement: the emitter CANNOT send a field it does not declare
// ===================================================================================================

describe("telemetry cannot leak", () => {
  const sent: unknown[] = [];
  const sink = { send: (event: unknown) => void sent.push(event) };
  const fresh = (schema: TelemetrySchema = APP_SCHEMA) => {
    sent.length = 0;
    return createTelemetry({ schema, enabled: true, sink });
  };

  it("drops a spread that carries model content", () => {
    // The exact line the design is against, and it typechecks under any loose signature:
    //
    //     track("drawing.generated", { ...drawing.provenance, view })
    //
    // `provenance.incomplete` is an array of GlobalIds and IFC class names. A type cannot stop this — the spread
    // is the natural way to write it and the compiler agrees — so the schema is enforced at emit.
    const telemetry = fresh();
    telemetry.track("drawing.generated", {
      view: "plan",
      durationMs: 240,
      incompleteCount: 2,
      coverageBucket: "<100%",
      // Everything below is real `DrawingProvenance`, and none of it is declared.
      provider: "local",
      providerVersion: "0.1.0",
      incomplete: [{ guid: "0aBcDeFgHiJkLmNoPqRsTu", ifcClass: "IfcStair", reason: "no representation" }],
      approximations: ["hidden lines: z-sort only"],
    });

    expect(sent).toHaveLength(1);
    // Only the four declared fields survive.
    expect(Object.keys((sent[0] as { fields: object }).fields).sort()).toEqual([
      "coverageBucket",
      "durationMs",
      "incompleteCount",
      "view",
    ]);
    // And nothing anywhere in the payload contains the GlobalId or the class name.
    expect(JSON.stringify(sent[0])).not.toContain("0aBcDeFgHiJkLmNoPqRsTu");
    expect(JSON.stringify(sent[0])).not.toContain("IfcStair");
  });

  it("records the drop without recording the dropped value", () => {
    // The subtle half. A rejection message containing the offending value would reintroduce the leak through the
    // diagnostic *for* the leak — and rejection logs are exactly what a debug build prints.
    const telemetry = fresh();
    telemetry.track("export.completed", { format: "pdf", durationMs: 10, filename: "C:/Clients/Acme/Tower-A.ifc" });
    const rejection = telemetry.rejected.find((r) => r.field === "filename");
    expect(rejection).toBeDefined();
    expect(JSON.stringify(telemetry.rejected)).not.toContain("Acme");
    expect(JSON.stringify(telemetry.rejected)).not.toContain("Tower-A");
  });

  it("refuses an out-of-list enum without echoing it", () => {
    // An unexpected enum value is the other place a filename arrives — someone passes `kind: file.name` instead of
    // `kind: file.sniffed.kind`. So the reason names the allowed list, never the rejected value.
    const telemetry = fresh();
    telemetry.track("model.opened", {
      sizeBucket: "<1k",
      source: "drop",
      kind: "Confidential-Tower-A.ifc",
      parseMs: 100,
    });
    expect(JSON.stringify(telemetry.rejected)).not.toContain("Confidential");
    expect(telemetry.rejected.some((r) => r.field === "kind" && r.why.includes("not one of"))).toBe(true);
  });

  it("drops an undeclared event entirely", () => {
    const telemetry = fresh();
    telemetry.track("user.identified", { email: "someone@example.com" });
    expect(sent).toEqual([]);
    expect(JSON.stringify(telemetry.rejected)).not.toContain("example.com");
  });

  it("sends nothing at all unless explicitly enabled", () => {
    // `enabled === true`, not `!== false`. An undefined config meaning *on* is how a genuinely-unchecked first-run
    // dialog turns into telemetry that was already flowing before anyone was asked.
    for (const enabled of [undefined, false]) {
      sent.length = 0;
      const telemetry = createTelemetry({ schema: APP_SCHEMA, sink, ...(enabled === undefined ? {} : { enabled }) });
      telemetry.track("export.completed", { format: "pdf", durationMs: 10 });
      expect(sent, `enabled=${String(enabled)}`).toEqual([]);
    }
  });

  it("buckets a duration instead of transmitting it", () => {
    // An exact millisecond figure is a fingerprint: "parse took 4 812 ms", plus a timestamp, identifies a session
    // more reliably than most identifiers.
    const telemetry = fresh();
    telemetry.track("export.completed", { format: "pdf", durationMs: 4812 });
    expect((sent[0] as { fields: { durationMs: string } }).fields.durationMs).toBe("<5000ms");
    expect(JSON.stringify(sent[0])).not.toContain("4812");
  });

  it("buckets at the edges the way the ladder says", () => {
    expect(bucketDuration(0)).toBe("<100ms");
    expect(bucketDuration(99)).toBe("<100ms");
    expect(bucketDuration(100)).toBe("<500ms");
    expect(bucketDuration(30_000)).toBe(">=30000ms");
    expect(bucketDuration(-1)).toBe("invalid");
    expect(bucketDuration(Number.NaN)).toBe("invalid");
  });

  it("refuses a count that is not one, rather than coercing it", () => {
    // A field quietly turned into 0 is worse than a missing one: it is indistinguishable from a real measurement
    // and gets averaged into a chart.
    const telemetry = fresh();
    for (const bad of [-1, 1.5, Number.NaN, "3", null]) {
      telemetry.track("drawing.generated", {
        view: "plan",
        durationMs: 1,
        coverageBucket: "100%",
        incompleteCount: bad,
      });
    }
    expect(telemetry.rejected.filter((r) => r.field === "incompleteCount")).toHaveLength(5);
    for (const event of sent) expect((event as { fields: object }).fields).not.toHaveProperty("incompleteCount");
  });

  it("reports a declared field that was not supplied", () => {
    // A chart with a silently absent dimension looks like a chart whose dimension is always the same — a different
    // and wrong conclusion.
    const telemetry = fresh();
    telemetry.track("export.completed", { format: "pdf" });
    expect(telemetry.rejected.some((r) => r.field === "durationMs" && r.why.includes("not supplied"))).toBe(true);
  });

  it("declares no free-text field anywhere in the app schema", () => {
    // The structural version of the rule. Every leak of model content in this industry arrived through a free
    // string, so the schema has no way to express one — and this asserts nobody added a kind that does.
    for (const [event, spec] of Object.entries(APP_SCHEMA)) {
      for (const [field, kind] of Object.entries(spec.fields)) {
        expect(["count", "enum", "duration", "flag"], `${event}.${field}`).toContain(kind.kind);
      }
      expect(spec.description.length, `${event} needs a description for the privacy notice`).toBeGreaterThan(20);
    }
  });
});

// ===================================================================================================
// Redaction
// ===================================================================================================

describe("redaction", () => {
  it("keeps a filename's extension and loses everything else", () => {
    // "an IFC failed to parse" is reportable and useful; the client's name in the path is not ours to send.
    expect(redact("Could not parse C:\\Projects\\Acme-Confidential\\Tower-A.ifc")).toBe(
      "Could not parse [path].ifc",
    );
    expect(redact("open /home/matt/Clients/Acme/model.ifc failed")).toBe("open [path].ifc failed");
  });

  it("redacts a GlobalId, including one that starts or ends with $", () => {
    // The bug a naive `\b[0-9A-Za-z_$]{22}\b` has: `\b` does not treat `$` as a word character, so any id with a
    // leading or trailing `$` survives — roughly one in sixteen of them.
    // 22 characters exactly, with a `$` in the middle. A first version of this fixture was 20 characters long
    // and failed — the rule was right and the test was wrong, which is worth keeping visible: an id-shaped
    // string is not an id, and length is the whole test.
    expect(redact("Element 3f9K$0aBcDeFgHiJkLmNoP has no representation")).toContain("[guid]");
    expect(redact("$aBcDeFgHiJkLmNoPqRsT$ missing")).toBe("[guid] missing");
    expect(redact("id 0aBcDeFgHiJkLmNoPqRsTu.")).toBe("id [guid].");
    // And a shorter token is not a GlobalId. Length is what makes it one.
    expect(redact("word abcdefghij")).toBe("word abcdefghij");
  });

  it("redacts a URL before the path rule can eat half of it", () => {
    // Order matters: the path rule applied first leaves a fragment that is neither redacted nor useful.
    expect(redact("POST https://client-intranet.example/projects/4821/edit failed")).toBe(
      "POST https://[redacted] failed",
    );
  });

  it("redacts secrets, emails and addresses", () => {
    expect(redact("Authorization: Bearer eyJhbGciOi")).toContain("[secret]");
    expect(redact("mail to matt@example.com")).toBe("mail to [email]");
    expect(redact("connect 192.168.1.14")).toBe("connect [ip]");
    expect(redact(`hash ${"a".repeat(40)}`)).toBe("hash [hex]");
  });

  it("gives the same answer every time, and is idempotent", () => {
    // Repeated calls, because the rules are shared module-level `/g` regexes. This test was originally written to
    // catch a missing `lastIndex` reset — and sabotage-testing showed it cannot, because `String#replace` resets
    // `lastIndex` itself for a global regex. The reset was removed and the false claim with it; see `redact`.
    //
    // What is left is still worth asserting, and is the stronger property: stable across calls, and idempotent —
    // redacting already-redacted text must not mangle the placeholders.
    // `String.raw`, so the backslashes are literal. A doubled-escape version of this line is unreadable and was
    // wrong twice while writing it — and a path fixture whose backslashes are actually escape sequences tests
    // nothing about paths.
    const one = String.raw`id 0aBcDeFgHiJkLmNoPqRsTu at C:\Clients\Acme\m.ifc`;
    const once = redact(one);
    expect(redact(one)).toBe(once);
    expect(redact(one)).toBe(once);
    expect(redact(once)).toBe(once);
  });

  it("redacts keys as well as values", () => {
    // A key can be the secret: `{"C:\\Clients\\Acme\\model.ifc": 3}` is a real shape for a per-file counter.
    const out = redactValue({ "C:\\Clients\\Acme\\model.ifc": 3 }) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["[path].ifc"]);
  });

  it("survives a cycle rather than throwing", () => {
    // An error with a looping `cause` chain is unusual and entirely possible, and a redactor that throws on it
    // takes down the crash handler — turning a reportable bug into an unreportable one.
    const loop: Record<string, unknown> = { name: "outer" };
    loop.self = loop;
    expect(() => redactValue(loop)).not.toThrow();
    expect((redactValue(loop) as { self: unknown }).self).toBe("[circular]");
  });

  it("states what it does not cover", () => {
    // A redactor that claims completeness is the belief that makes someone put a customer name in an error
    // message. This list is meant to be rendered next to the switch that enables egress.
    const limits = redactionLimits();
    expect(limits.length).toBeGreaterThan(3);
    expect(limits.join(" ")).toMatch(/not detectable|names in messages survive/);
    expect(REDACTION_RULES.every((r) => r.pattern.global)).toBe(true);
  });
});

// ===================================================================================================
// Crash reporting
// ===================================================================================================

describe("crash reporting", () => {
  /**
   * Drain every pending microtask.
   *
   * A `setTimeout(0)` rather than a fixed number of `await Promise.resolve()`. Counting ticks means encoding the
   * shape of the implementation's promise chain into the test, so refactoring the chain breaks tests that are not
   * about it — which is exactly what happened while writing this file.
   */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  const report = (over: Partial<CrashReport> = {}): CrashReport => ({
    kind: "manual",
    message: "boom",
    at: "2026-08-07T00:00:00.000Z",
    ...over,
  });

  it("sends nothing by default", () => {
    // The actual privacy control. Everything else is defence in depth.
    expect(() => NOOP_CRASH_SINK.report(report())).not.toThrow();
  });

  it("redacts on the way out of an HTTP sink, but not to the console", () => {
    // A developer wants the filename; a remote endpoint must not have it. Same report, two sinks, deliberately
    // different treatment — the risk is egress, not display.
    const posted: string[] = [];
    const sink = httpSink("https://crash.example/report", {
      fetch: (async (_url: unknown, init: unknown) => {
        posted.push((init as { body: string }).body);
        return new Response("", { status: 200 });
      }) as unknown as typeof fetch,
    });
    sink.report(report({ message: "Could not parse C:\\Clients\\Acme\\Tower-A.ifc" }));
    expect(posted[0]).toContain("[path].ifc");
    expect(posted[0]).not.toContain("Acme");

    const logged: unknown[] = [];
    consoleSink({ error: (...args: unknown[]) => void logged.push(args) }).report(
      report({ message: "Could not parse C:\\Clients\\Acme\\Tower-A.ifc" }),
    );
    expect(JSON.stringify(logged)).toContain("Acme");
  });

  it("sends no credentials", () => {
    // A crash endpoint has no business receiving a session cookie, and `omit` makes that structural rather than
    // dependent on how the endpoint is configured.
    let init: RequestInit | undefined;
    httpSink("https://crash.example/report", {
      fetch: (async (_u: unknown, i: RequestInit) => {
        init = i;
        return new Response("");
      }) as unknown as typeof fetch,
    }).report(report());
    expect(init?.credentials).toBe("omit");
  });

  it("does not throw when the endpoint is unreachable", () => {
    // A reporter that throws while reporting a crash turns one bug into two, and the second has no stack.
    const sink = httpSink("https://crash.example/report", {
      fetch: (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch,
    });
    expect(() => sink.report(report())).not.toThrow();
  });

  it("bounds its queue and says how many it dropped", async () => {
    // A silent gap reads as a quiet period, which reads as stability.
    //
    // `await` between reports, and that is not test scaffolding — it is the behaviour. A failed send holds
    // `inFlight` until its promise settles on a microtask, so a synchronous burst queues without retrying. That is
    // correct (one request at a time, no concurrent flush racing on `dropped`) and it means a test that does not
    // yield never observes a retry at all.
    const bodies: string[] = [];
    let allow = false;
    const sink = httpSink("https://crash.example/report", {
      queueLimit: 2,
      fetch: (async (_u: unknown, i: unknown) => {
        if (!allow) throw new Error("offline");
        bodies.push((i as { body: string }).body);
        return new Response("");
      }) as unknown as typeof fetch,
    });

    for (let i = 0; i < 5; i++) {
      sink.report(report({ message: `boom ${i}` }));
      await settle();
    }
    expect(bodies).toEqual([]);

    allow = true;
    sink.report(report({ message: "boom last" }));
    await settle();

    expect(bodies).toHaveLength(1);
    const sent = JSON.parse(bodies[0]!);
    // The queue held its limit and the drops travelled with the send that finally succeeded.
    expect(sent.reports).toHaveLength(2);
    expect(sent.dropped).toBe(4);
  });

  it("keeps a report a 5xx failed to accept", async () => {
    // Treating any settled promise as success is how reports vanish into an endpoint that has been returning 503
    // for a week — the request completed, so nothing looks wrong.
    const bodies: string[] = [];
    let status = 503;
    const sink = httpSink("https://crash.example/report", {
      fetch: (async (_u: unknown, i: unknown) => {
        if (status === 200) bodies.push((i as { body: string }).body);
        return new Response("", { status });
      }) as unknown as typeof fetch,
    });

    sink.report(report({ message: "first" }));
    await settle();
    expect(bodies).toEqual([]);

    status = 200;
    sink.report(report({ message: "second" }));
    await settle();
    // Both, because the first was never discarded.
    expect(JSON.parse(bodies[0]!).reports).toHaveLength(2);
  });

  it("handles the things people throw that are not Errors", () => {
    // `throw "boom"` and `throw {code: 42}` both happen, and a handler assuming `Error` reports
    // "undefined: undefined" — a crash report with no information in it.
    const seen: CrashReport[] = [];
    const handler = createCrashHandler({ sink: { report: (r) => void seen.push(r) }, now: () => "T" });
    handler.capture("just a string");
    handler.capture({ code: 42 });
    handler.capture(new TypeError("real"));
    expect(seen.map((r) => r.message)).toEqual(["just a string", '{"code":42}', "TypeError: real"]);
  });

  it("catches an unhandled rejection, not only an error", () => {
    // The half everyone forgets. An async failure with no `.catch` fires no `error` event at all, so a handler
    // that only listens for `error` misses every rejected promise — in an app this async, most of them.
    const seen: CrashReport[] = [];
    const listeners = new Map<string, (event: Event) => void>();
    const target = {
      addEventListener: (type: string, fn: (event: Event) => void) => void listeners.set(type, fn),
      removeEventListener: (type: string) => void listeners.delete(type),
    };
    const off = createCrashHandler({ sink: { report: (r) => void seen.push(r) }, now: () => "T" }).install(
      target as unknown as Window,
    );

    expect([...listeners.keys()].sort()).toEqual(["error", "unhandledrejection"]);
    const rejection = new Event("unhandledrejection") as Event & { reason?: unknown };
    Object.defineProperty(rejection, "reason", { value: new Error("async boom") });
    listeners.get("unhandledrejection")!(rejection);
    expect(seen[0]).toMatchObject({ kind: "rejection", message: "Error: async boom" });

    off();
    expect(listeners.size).toBe(0);
  });

  it("survives a throwing sink", () => {
    // The last line of defence in the process, and the one place swallowing an error is unambiguously right.
    const handler = createCrashHandler({
      sink: {
        report: () => {
          throw new Error("sink is broken");
        },
      },
    });
    expect(() => handler.capture(new Error("boom"))).not.toThrow();
  });

  it("redacts a report on request, without a sink", () => {
    const out = redactReport(report({ message: "at /home/matt/Clients/x.ifc", context: { path: "C:\\a\\b.ifc" } }));
    expect(out.message).toContain("[path].ifc");
    expect(JSON.stringify(out.context)).toContain("[path].ifc");
  });
});

// ===================================================================================================
// Audit
// ===================================================================================================

describe("audit", () => {
  const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
    at: "2026-08-07T00:00:00.000Z",
    command: "wall.add",
    origin: "ribbon",
    outcome: "applied",
    ...over,
  });

  it("keeps the identifiers telemetry must not", () => {
    // The reason these are separate modules rather than one. An audit entry saying "an element was deleted"
    // without saying which is not an audit entry; a telemetry event that says which is a leak.
    const log = createAuditLog();
    log.write(entry({ command: "element.delete", params: { guid: "0aBcDeFgHiJkLmNoPqRsTu" }, version: 4 }));
    expect(log.toJsonl()).toContain("0aBcDeFgHiJkLmNoPqRsTu");
  });

  it("emits JSONL, one entry per line", () => {
    const log = createAuditLog();
    log.write(entry());
    log.write(entry({ command: "element.delete", outcome: "refused", code: "capability_unavailable" }));
    const lines = log.toJsonl().trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toMatchObject({ outcome: "refused", code: "capability_unavailable" });
  });

  it("records that it wrapped, at the top of the file", () => {
    // A truncation notice at the end of a file truncated at the start is in the wrong place — and a log with a
    // silent gap will be presented as complete.
    const log = createAuditLog(2);
    for (let i = 0; i < 5; i++) log.write(entry({ command: `c${i}` }));
    expect(log.entries).toHaveLength(2);
    const first = JSON.parse(log.toJsonl().split("\n")[0]!);
    expect(first.dropped).toBe(3);
  });

  it("tees to several sinks, and one failure does not stop the rest", () => {
    // An audit trail that stops because a disk filled is the failure this guard is for, and losing the *rest* of
    // the trail is the worst part of it.
    const good = createAuditLog();
    const sink = teeAudit(
      {
        write: () => {
          throw new Error("disk full");
        },
      },
      good,
    );
    expect(() => sink.write(entry())).not.toThrow();
    expect(good.entries).toHaveLength(1);
  });

  it("reports coverage in both directions", () => {
    // `missing` is an unaudited action — a mutation somebody added without a path through the bus. `unknown` is a
    // log entry for a command that no longer exists, which means reading that log as current is wrong.
    const coverage = auditCoverage(["a", "b", "c"], [entry({ command: "a" }), entry({ command: "z" })]);
    expect(coverage.missing).toEqual(["b", "c"]);
    expect(coverage.unknown).toEqual(["z"]);
    expect(coverage).toMatchObject({ covered: 1, total: 3 });
  });
});

// ===================================================================================================
// Migrations
// ===================================================================================================

describe("migrations", () => {
  const steps: MigrationStep[] = [
    { from: 1, to: 2, description: "sizes keyed by id", up: (d) => ({ sizes: d, collapsed: [] }) },
    {
      from: 2,
      to: 3,
      description: "collapsed as a list",
      up: (d) => ({ ...(d as object), collapsed: [...((d as { collapsed: string[] }).collapsed ?? [])] }),
    },
  ];

  it("walks the chain and reports which steps ran", () => {
    const result = migrate(envelope(1, { left: 200 }), steps, 3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applied).toEqual(["1->2", "2->3"]);
      expect(result.data).toEqual({ sizes: { left: 200 }, collapsed: [] });
    }
  });

  it("refuses data from a newer build rather than partially reading it", () => {
    // "Read what I recognise" silently discards the rest — then writes it back, destroying the user's settings
    // the moment they open an older tab.
    const result = migrate(envelope(9, {}), steps, 3);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("future");
      expect(result.why).toContain("version 9");
    }
  });

  it("refuses anything that is not an envelope", () => {
    expect(migrate({ left: 200 }, steps, 3).ok).toBe(false);
    expect(migrate(null, steps, 3).ok).toBe(false);
    expect(migrate(envelope(0, {}), steps, 3).ok).toBe(false);
    expect(isVersioned({ schemaVersion: 1.5, data: {} })).toBe(false);
  });

  it("catches a gap in the chain before running anything", () => {
    // A gap only manifests for users who skipped a release — which is most of them, and nobody upgrading one
    // version at a time will ever see it.
    const gapped: MigrationStep[] = [steps[0]!, { from: 3, to: 4, description: "x", up: (d) => d }];
    expect(validateChain(gapped, 4).join(" ")).toContain("no step reads version 2");
    const result = migrate(envelope(1, {}), gapped, 4);
    expect(result.ok).toBe(false);
  });

  it("catches a step that skips a version", () => {
    expect(validateChain([{ from: 1, to: 3, description: "big jump", up: (d) => d }], 3).join(" ")).toContain(
      "skips a version",
    );
  });

  it("reports a throwing step rather than returning half-migrated data", () => {
    // Half-migrated data is at no coherent version at all — worse than either endpoint.
    const bad: MigrationStep[] = [
      steps[0]!,
      {
        from: 2,
        to: 3,
        description: "reads a field that is not there",
        up: () => {
          throw new TypeError("cannot read properties of undefined");
        },
      },
    ];
    const result = migrate(envelope(1, {}), bad, 3);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("failed");
      expect(result.why).toContain("2->3");
      expect(result.why).toContain("reads a field that is not there");
    }
  });

  it("is a no-op at the target version", () => {
    const result = migrate(envelope(3, { sizes: {}, collapsed: [] }), steps, 3);
    expect(result.ok && result.applied).toEqual([]);
  });
});

// ===================================================================================================
// Flags
// ===================================================================================================

describe("flags", () => {
  const declarations = [
    { key: "newPalette", description: "The reworked palette", default: false, until: "2026-12-31", owner: "matt" },
    { key: "oldRibbon", description: "Fall back to the floating bar", default: true, until: "2026-09-30", owner: "matt" },
  ];

  it("throws for an undeclared flag instead of returning false", () => {
    // A typo that returns `false` disables a feature silently and sends the next hour to the wrong file.
    const flags = createFlags(declarations);
    expect(() => flags.enabled("newPallete")).toThrow(/not a declared feature flag/);
    // The message lists what *is* declared, so the typo is visible in the error.
    expect(() => flags.enabled("newPallete")).toThrow(/newPalette/);
  });

  it("refuses two declarations of one key", () => {
    // Two descriptions and two expiry dates, and whichever wins is an accident of ordering.
    expect(() => createFlags([...declarations, declarations[0]!])).toThrow(/duplicate/);
  });

  it("lets the first source with an opinion win", () => {
    const flags = createFlags(
      declarations,
      queryFlagSource("?flags=newPalette,oldRibbon:off"),
      storageFlagSource({ getItem: () => JSON.stringify({ newPalette: false }) }),
    );
    expect(flags.enabled("newPalette")).toBe(true); // query beats storage
    expect(flags.enabled("oldRibbon")).toBe(false); // `:off` turns a default-on flag off
  });

  it("can turn a default-on flag off from a URL", () => {
    // A URL flag that could only turn things *on* gives no way to reproduce a bug that needs a default-on flag
    // disabled.
    for (const suffix of ["off", "0", "false"]) {
      expect(createFlags(declarations, queryFlagSource(`?flags=oldRibbon:${suffix}`)).enabled("oldRibbon")).toBe(false);
    }
  });

  it("ignores a stored value that is not a boolean", () => {
    // A stored `"true"` is a string, and coercing it would make `"false"` mean true.
    const flags = createFlags(declarations, storageFlagSource({ getItem: () => JSON.stringify({ newPalette: "true" }) }));
    expect(flags.enabled("newPalette")).toBe(false);
  });

  it("treats corrupt storage as no opinion", () => {
    const flags = createFlags(declarations, storageFlagSource({ getItem: () => "{not json" }));
    expect(flags.enabled("oldRibbon")).toBe(true);
  });

  it("makes an expired flag a failure", () => {
    // A flag added "for two weeks" is otherwise still there two years later, and by then nobody remembers which
    // branch is the tested one.
    expect(expiredFlags(declarations, "2026-10-01").map((f) => f.key)).toEqual(["oldRibbon"]);
    expect(expiredFlags(declarations, "2026-09-01")).toEqual([]);
  });

  it("has no expired flags in the app's own declarations", () => {
    // The gate, pointed at this repository. Empty today, which is the honest state — nothing has needed a flag.
    expect(expiredFlags(APP_FLAGS, "2030-01-01")).toEqual([]);
    for (const flag of APP_FLAGS) {
      expect(flag.until, `${flag.key} needs an ISO expiry`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(flag.owner.length).toBeGreaterThan(0);
    }
  });

  it("snapshots every flag for a bug report", () => {
    expect(createFlags(declarations).snapshot()).toEqual({ newPalette: false, oldRibbon: true });
  });
});

void vi;
