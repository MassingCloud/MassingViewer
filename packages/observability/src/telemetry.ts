/**
 * Telemetry: opt-in, schema-bound, and structurally incapable of sending what it does not declare.
 *
 * ## Why a runtime schema and not just types
 *
 * The plan's requirement is precise: *"a documented schema with a test asserting the emitter **cannot** send a
 * field outside it."* Types cannot deliver that. A type says what a *caller written in TypeScript* may pass; it
 * says nothing about a plugin compiled separately, a `as any` under deadline pressure, or an object spread that
 * carries an extra key nobody noticed:
 *
 *     track("plan.generated", { ...drawing.provenance, scale })
 *
 * That line typechecks under a loose signature and ships `incomplete[]` — an array of GlobalIds and IFC class
 * names — to a metrics endpoint. The failure is not carelessness; it is that spreading an object is the natural
 * way to write it, and the type system agrees.
 *
 * So the schema is **data, enforced at emit**. An undeclared field is dropped, an undeclared event is dropped, and
 * both are counted so a build can assert the count is zero. That converts "we are careful" into something a test
 * can fail on.
 *
 * ## What is allowed to be in an event, and why it is this narrow
 *
 * Counters, enumerated strings from a closed list, and **bucketed** durations. Nothing else. In particular:
 *
 * - **No free strings**, because every leak of model content in the history of this industry arrived through one.
 *   A field is either a number or one of a stated list of values.
 * - **Durations are bucketed**, not exact. An exact millisecond figure is a fingerprint: "parse took 4 812 ms" on
 *   a large model, combined with a timestamp, identifies a session more reliably than most identifiers.
 * - **No identifiers at all** — no GlobalIds, no filenames, no project names, no user ids, no session id. Which
 *   means the data cannot answer "which user hit this", and that is the intended trade: it can answer "how often
 *   does this happen", which is the question worth having.
 */

export type FieldKind =
  /** A count. Non-negative, finite, integral. */
  | { readonly kind: "count" }
  /** One of a closed list. The list is the documentation. */
  | { readonly kind: "enum"; readonly values: readonly string[] }
  /** A duration in ms, reported as the bucket it falls in rather than the value. */
  | { readonly kind: "duration" }
  /** A boolean. */
  | { readonly kind: "flag" };

export interface EventSchema {
  readonly description: string;
  readonly fields: Readonly<Record<string, FieldKind>>;
}

export type TelemetrySchema = Readonly<Record<string, EventSchema>>;

/**
 * Duration buckets, in milliseconds.
 *
 * Coarse on purpose, and the boundaries are chosen from what a user notices rather than from round numbers: 100 ms
 * is "instant", 1 s is "a pause", 10 s is "I went to get coffee". A histogram with finer buckets would be more
 * informative and more identifying, and the point of bucketing is to give up the former for the latter.
 */
export const DURATION_BUCKETS = [100, 500, 1_000, 5_000, 10_000, 30_000] as const;

export function bucketDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "invalid";
  for (const edge of DURATION_BUCKETS) if (ms < edge) return `<${edge}ms`;
  return `>=${DURATION_BUCKETS[DURATION_BUCKETS.length - 1]!}ms`;
}

export type TelemetryValue = number | string | boolean;

export interface TelemetryEvent {
  readonly name: string;
  readonly fields: Readonly<Record<string, number | string | boolean>>;
}

/** Where events go. Injected, so the default can send nowhere at all. */
export interface TelemetrySink {
  send(event: TelemetryEvent): void;
}

/** The default. Sends nothing, and is what makes "opt-in" true rather than claimed. */
export const NOOP_SINK: TelemetrySink = { send: () => {} };

export interface Rejection {
  readonly event: string;
  readonly field?: string;
  readonly why: string;
}

export interface Telemetry {
  track(name: string, fields?: Readonly<Record<string, unknown>>): void;
  /**
   * Everything the schema refused.
   *
   * Exposed so a *test* can assert it is empty, which is the requirement. In production it is also the honest
   * signal that a caller believes it is reporting something it is not — a silently dropped event is a metric
   * somebody is about to make a decision on the absence of.
   */
  readonly rejected: readonly Rejection[];
  readonly enabled: boolean;
}

export interface TelemetryOptions {
  readonly schema: TelemetrySchema;
  /**
   * Off unless explicitly true.
   *
   * `enabled?: boolean` with a `!== false` check would make an undefined config mean *on*, which is how a
   * genuinely-unchecked first-run dialog turns into telemetry that was already flowing. The default has to be the
   * safe one, and the check has to be positive.
   */
  readonly enabled?: boolean;
  readonly sink?: TelemetrySink;
}

/**
 * Validate and coerce one field against its declared kind.
 *
 * Returns `undefined` for anything that does not fit, with the reason — never a best-effort coercion. A field
 * quietly turned into `0` or `"unknown"` is worse than a missing one, because it is indistinguishable from a real
 * measurement and will be averaged into a chart.
 */
function coerce(kind: FieldKind, value: unknown): { ok: true; value: TelemetryValue } | { ok: false; why: string } {
  switch (kind.kind) {
    case "count":
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
        return { ok: false, why: `expected a non-negative integer, got ${JSON.stringify(value)}` };
      }
      return { ok: true, value };
    case "flag":
      if (typeof value !== "boolean") return { ok: false, why: `expected a boolean, got ${typeof value}` };
      return { ok: true, value };
    case "duration":
      if (typeof value !== "number") return { ok: false, why: `expected a number of ms, got ${typeof value}` };
      // Bucketed here, at the boundary. Bucketing at the call site would mean the exact value existed in a
      // variable that something else could pick up, and would let one caller forget.
      return { ok: true, value: bucketDuration(value) };
    case "enum":
      if (typeof value !== "string") return { ok: false, why: `expected one of ${kind.values.join(", ")}` };
      if (!kind.values.includes(value)) {
        // The rejected value is NOT echoed into the reason. An unexpected enum value is exactly where a filename
        // or a project name would arrive, and putting it in a rejection message that a sink might log would
        // reintroduce the leak through the diagnostic for the leak.
        return { ok: false, why: `not one of ${kind.values.join(", ")}` };
      }
      return { ok: true, value };
  }
}

export function createTelemetry(options: TelemetryOptions): Telemetry {
  const enabled = options.enabled === true;
  const sink = options.sink ?? NOOP_SINK;
  const rejected: Rejection[] = [];

  return {
    get rejected() {
      return rejected;
    },
    enabled,

    track(name, fields = {}) {
      const schema = options.schema[name];
      if (schema === undefined) {
        // Recorded even when telemetry is off, because a test needs to catch an undeclared event whether or not
        // the run it is testing had a sink. Nothing is transmitted either way.
        rejected.push({ event: name, why: "event is not in the schema" });
        return;
      }

      const out: Record<string, TelemetryValue> = {};
      for (const [key, value] of Object.entries(fields)) {
        const kind = schema.fields[key];
        if (kind === undefined) {
          // The dropped field's *value* is never recorded. This is the branch a spread lands in, and it is the
          // one carrying model content — so its own diagnostic must not carry it either.
          rejected.push({ event: name, field: key, why: "field is not declared for this event" });
          continue;
        }
        const result = coerce(kind, value);
        if (!result.ok) {
          rejected.push({ event: name, field: key, why: result.why });
          continue;
        }
        out[key] = result.value;
      }

      // Missing declared fields are reported too. A chart with a silently absent dimension looks like a chart
      // whose dimension is always the same, which is a different and wrong conclusion.
      //
      // Only fields absent from the *input* — a field that failed coercion has already been reported, and saying
      // so twice makes a list that a build asserts on noisier than it needs to be.
      for (const key of Object.keys(schema.fields)) {
        if (!(key in out) && !(key in fields)) {
          rejected.push({ event: name, field: key, why: "declared field was not supplied" });
        }
      }

      if (!enabled) return;
      sink.send({ name, fields: out });
    },
  };
}

/**
 * The schema this application actually uses.
 *
 * Exported so it can be *rendered* into the privacy documentation rather than restated there. A privacy notice
 * maintained separately from the emitter is a privacy notice that is wrong within two releases — and being wrong
 * about this one is not a documentation bug.
 */
export const APP_SCHEMA: TelemetrySchema = {
  "model.opened": {
    description: "A model was opened. No filename, no project, no element identity — only how and how big.",
    fields: {
      // Buckets rather than a count, because "this user's model has 41 812 elements" is close to a fingerprint.
      sizeBucket: { kind: "enum", values: ["<100", "<1k", "<10k", "<100k", ">=100k"] },
      source: { kind: "enum", values: ["drop", "picker", "fixture"] },
      kind: { kind: "enum", values: ["ifc", "ifcxml", "zip", "other"] },
      parseMs: { kind: "duration" },
    },
  },
  "drawing.generated": {
    description: "A plan or section was cut. Coverage is a health metric, not a model description.",
    fields: {
      view: { kind: "enum", values: ["plan", "section", "elevation", "axon", "detail"] },
      durationMs: { kind: "duration" },
      // The count of failures, never the failures themselves — `incomplete[]` carries GlobalIds and class names.
      incompleteCount: { kind: "count" },
      coverageBucket: { kind: "enum", values: ["<50%", "<90%", "<100%", "100%"] },
    },
  },
  "export.completed": {
    description: "Something was exported. Format and success only.",
    fields: {
      format: { kind: "enum", values: ["svg", "dxf", "pdf", "bcf", "ifc"] },
      durationMs: { kind: "duration" },
    },
  },
  "kernel.refused": {
    description: "An operation was refused. The code, from the closed taxonomy — never the message, which is prose.",
    fields: {
      code: {
        kind: "enum",
        values: [
          "unsupported",
          "out_of_bounds",
          "not_an_extrusion",
          "capability_unavailable",
          "version_conflict",
          "degenerate_geometry",
          "unknown_op",
        ],
      },
      local: { kind: "flag" },
    },
  },
  "plugin.quarantined": {
    description: "A plugin failed to activate. Which phase, not which plugin — a plugin id is an identifier.",
    fields: { phase: { kind: "enum", values: ["load", "activate", "deactivate"] } },
  },
};
