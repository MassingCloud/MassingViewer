/**
 * Versioned migrations for persisted artefacts.
 *
 * ## Why this is cheap now and impossible later
 *
 * Every artefact this application persists — a dock layout, a saved theme, a tool set, a keybinding map, a
 * recent-files list — is written by one version and read by another. Without a version field, the reader has to
 * *guess* the shape from its contents, and guessing wrong on a partially-recognised object produces the worst
 * outcome available: it loads, half the fields are `undefined`, and the failure surfaces three interactions later
 * somewhere unrelated.
 *
 * Adding `{ schemaVersion, data }` costs nothing today. Retrofitting it means writing a heuristic to distinguish
 * un-versioned old data from versioned new data, forever.
 *
 * ## Three rules, each from a specific failure
 *
 * **One pure `vN -> vN+1` step per version.** Not a single "read anything" function. A migration chain is testable
 * step by step and a monolith is testable only end to end — so a bug in the v2→v3 logic is found by a v1 fixture
 * that happens to exercise it, or not at all.
 *
 * **A future version is refused, not attempted.** Data written by a newer build has fields this one has never
 * heard of, and "read what I recognise" silently discards the rest — then writes it back, destroying the user's
 * settings the moment they open an older tab. Refusing is the only safe answer, and for regenerable data it is
 * also nearly free.
 *
 * **A golden fixture of every old format is committed while it is current.** After the writer changes, nobody can
 * produce a genuine v1 file again — only a reconstruction of what they believe v1 looked like, which is exactly
 * the belief the migration is supposed to be tested against.
 */

export interface Versioned<T = unknown> {
  readonly schemaVersion: number;
  readonly data: T;
}

export interface MigrationStep {
  /** The version this reads. */
  readonly from: number;
  /** The version it writes. Asserted to be `from + 1`. */
  readonly to: number;
  readonly description: string;
  /** Pure. Given the `data` at `from`, return the `data` at `to`. */
  readonly up: (data: unknown) => unknown;
}

export type MigrateResult<T> =
  | { readonly ok: true; readonly data: T; readonly from: number; readonly applied: readonly string[] }
  /**
   * Refused, with a reason and — crucially — whether discarding is safe.
   *
   * `regenerable` is the field that decides what a caller does. A dock layout can be thrown away and rebuilt from
   * defaults in one render; a user's custom tool set cannot, and silently resetting it is worse than refusing to
   * start. Only the caller knows which it is holding, so the result reports the problem and does not act on it.
   */
  | { readonly ok: false; readonly why: string; readonly kind: "future" | "unknown" | "malformed" | "failed" };

/** Is this a `{schemaVersion, data}` envelope at all? */
export function isVersioned(value: unknown): value is Versioned {
  return (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    typeof (value as Versioned).schemaVersion === "number" &&
    Number.isInteger((value as Versioned).schemaVersion) &&
    "data" in value
  );
}

/**
 * Check a chain before using it.
 *
 * Called by `migrate`, and exported so a test can assert the chain is well-formed without running data through
 * it. A gap in the chain — v1→v2 and v3→v4 with no v2→v3 — is a bug that only manifests for users who skipped a
 * release, which is most of them, and which nobody upgrading one version at a time will ever see.
 */
export function validateChain(steps: readonly MigrationStep[], target: number): readonly string[] {
  const problems: string[] = [];
  const sorted = [...steps].sort((a, b) => a.from - b.from);

  for (const step of sorted) {
    if (step.to !== step.from + 1) {
      problems.push(`step ${step.from}->${step.to} skips a version; one step per version, or a gap is untestable`);
    }
  }
  const seen = new Set<number>();
  for (const step of sorted) {
    if (seen.has(step.from)) problems.push(`two steps read version ${step.from}`);
    seen.add(step.from);
  }
  for (let version = 1; version < target; version++) {
    if (!seen.has(version)) problems.push(`no step reads version ${version}, so a v${version} artefact cannot load`);
  }
  return problems;
}

/**
 * Bring a stored artefact up to `target`.
 *
 * `target` is passed rather than inferred from the longest chain, so a caller upgrading in two stages — or a test
 * pinning an intermediate version — can say so. Inferring it would make adding a step silently change what every
 * existing call does.
 */
export function migrate<T>(stored: unknown, steps: readonly MigrationStep[], target: number): MigrateResult<T> {
  if (!isVersioned(stored)) {
    return { ok: false, kind: "malformed", why: "not a {schemaVersion, data} envelope" };
  }

  const from = stored.schemaVersion;
  if (from > target) {
    return {
      ok: false,
      kind: "future",
      why:
        `written by version ${from}, this build reads ${target}. Refused rather than partially read: loading the ` +
        `fields this build recognises and writing them back would destroy the rest.`,
    };
  }
  if (from < 1) return { ok: false, kind: "malformed", why: `version ${from} is not a version` };

  const problems = validateChain(steps, target);
  if (problems.length > 0) return { ok: false, kind: "unknown", why: problems.join("; ") };

  const byFrom = new Map(steps.map((step) => [step.from, step]));
  let data = stored.data;
  const applied: string[] = [];

  for (let version = from; version < target; version++) {
    const step = byFrom.get(version);
    if (step === undefined) return { ok: false, kind: "unknown", why: `no migration from version ${version}` };
    try {
      data = step.up(data);
    } catch (error) {
      // A throwing step is reported, never partially applied. Returning the half-migrated value would hand the
      // caller data at no coherent version at all — worse than either endpoint.
      return {
        ok: false,
        kind: "failed",
        why: `migration ${step.from}->${step.to} (${step.description}) threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    applied.push(`${step.from}->${step.to}`);
  }

  return { ok: true, data: data as T, from, applied };
}

/** Wrap a value for storage. The only way anything should be persisted. */
export function envelope<T>(schemaVersion: number, data: T): Versioned<T> {
  return { schemaVersion, data };
}
