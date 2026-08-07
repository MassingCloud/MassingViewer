/**
 * Feature flags — declared, defaulted off, and impossible to read by accident.
 *
 * ## The two ways a flag system rots
 *
 * **Undeclared flags.** `flags.enabled("newRibbon")` typos to `"newRibon"`, returns falsy, and the feature is
 * silently off. Nothing fails; the feature just does not exist, and the person debugging it looks at the ribbon
 * code. So every flag is **declared**, and reading an undeclared one throws — at the read, naming the flag and
 * listing the real ones, rather than returning a plausible `false`.
 *
 * **Flags that never leave.** A flag with no expiry becomes permanent, and a codebase with forty permanent flags
 * has 2^40 configurations of which one is tested. Each declaration carries an `until` date, and
 * {@link expiredFlags} plus `scripts/check-flags.mjs` make passing it a build failure — the same ratchet
 * discipline as the licence exceptions, pointed at the thing that otherwise accumulates silently.
 *
 * ## Why not environment variables
 *
 * Because a flag has to be answerable at runtime, per user, and readable by a plugin — and because an env var
 * cannot carry an expiry date, an owner, or a description. The declaration is the documentation, and it is what
 * the expiry gate reads.
 */

export interface FlagDeclaration {
  readonly key: string;
  readonly description: string;
  /** Off unless a source says otherwise. A flag that defaults on is not a flag, it is a release. */
  readonly default: boolean;
  /**
   * ISO date after which this flag must be gone.
   *
   * Required. An optional expiry is an expiry nobody sets — and a flag outliving its reason is the entire failure
   * mode being prevented here.
   */
  readonly until: string;
  /** Who makes the removal decision. Required for the same reason `until` is: a date with no owner is a wish. */
  readonly owner: string;
}

export interface FlagSource {
  /** `undefined` means "no opinion", which is a different answer from `false`. */
  get(key: string): boolean | undefined;
}

export interface Flags {
  /** Throws for an undeclared key. */
  enabled(key: string): boolean;
  readonly declarations: readonly FlagDeclaration[];
  /** Every flag and its resolved value, for a diagnostics panel and a bug report. */
  snapshot(): Readonly<Record<string, boolean>>;
}

export function createFlags(declarations: readonly FlagDeclaration[], ...sources: readonly FlagSource[]): Flags {
  const byKey = new Map(declarations.map((flag) => [flag.key, flag]));
  const duplicates = declarations.map((f) => f.key).filter((key, i, all) => all.indexOf(key) !== i);
  if (duplicates.length > 0) {
    // Two declarations of one key means two descriptions and two expiry dates, and whichever wins is an accident
    // of ordering. Refused at construction, where it is one line to fix.
    throw new Error(`duplicate flag declaration(s): ${[...new Set(duplicates)].join(", ")}`);
  }

  return {
    declarations,

    enabled(key) {
      const declaration = byKey.get(key);
      if (declaration === undefined) {
        // Throwing rather than returning false. A typo that returns `false` disables a feature silently and sends
        // the next hour to the wrong file. The message lists what *is* declared, so the typo is visible in it.
        throw new Error(
          `"${key}" is not a declared feature flag. Declared: ${[...byKey.keys()].sort().join(", ") || "(none)"}`,
        );
      }
      // First source with an opinion wins, so a URL override beats a stored preference beats the default.
      for (const source of sources) {
        const opinion = source.get(key);
        if (opinion !== undefined) return opinion;
      }
      return declaration.default;
    },

    snapshot() {
      const out: Record<string, boolean> = {};
      for (const key of byKey.keys()) out[key] = this.enabled(key);
      return out;
    },
  };
}

/**
 * Flags past their expiry date.
 *
 * A build failure, on purpose. The alternative is that a flag added "for two weeks" is still there two years
 * later, and by then nobody remembers which branch of it is the tested one.
 *
 * `today` is a parameter rather than a clock read, for two reasons: a test needs to pin it, and a gate that reads
 * the wall clock fails on a *date* rather than on a *change* — so a build that passed yesterday fails today with
 * no commit in between, usually on somebody else's unrelated PR. That is the shape of a gate people route around.
 */
export function expiredFlags(declarations: readonly FlagDeclaration[], today: string): readonly FlagDeclaration[] {
  return declarations.filter((flag) => flag.until < today);
}

/** Read overrides from a query string: `?flags=newRibbon,oldPalette:off`. */
export function queryFlagSource(search: string): FlagSource {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const overrides = new Map<string, boolean>();
  for (const entry of (params.get("flags") ?? "").split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const [key, value] = trimmed.split(":");
    // Bare `name` means on, `name:off` means off. A URL flag that could only turn things *on* would give no way to
    // reproduce a bug that needs a default-on flag disabled.
    overrides.set(key!, value !== "off" && value !== "0" && value !== "false");
  }
  return { get: (key) => overrides.get(key) };
}

/** Read overrides from storage, tolerating anything. */
export function storageFlagSource(storage: Pick<Storage, "getItem">, key = "mv.flags"): FlagSource {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(storage.getItem(key) ?? "{}") as Record<string, unknown>;
  } catch {
    // Corrupt JSON means no opinion. Throwing here would take down the application over a preference.
  }
  return {
    get: (name) => {
      const value = parsed[name];
      // Only a real boolean counts. A stored `"true"` is a string, and coercing it would make `"false"` mean true.
      return typeof value === "boolean" ? value : undefined;
    },
  };
}

/**
 * The flags this application declares.
 *
 * Empty, and that is the honest state — nothing shipped so far has needed one. The machinery exists because the
 * first flag gets added under time pressure, and that is the worst moment to be designing an expiry policy.
 *
 * Written across three lines rather than as `= [];` deliberately: `scripts/check-flags.mjs` parses this block out
 * of the source, and a one-line empty array was the first thing that made the gate fail to find it. Keeping the
 * shape stable is cheaper than making the parser cleverer, and the gate fails loudly when it cannot parse — so the
 * two can only go wrong together, noisily.
 */
export const APP_FLAGS: readonly FlagDeclaration[] = [
  // No flags declared.
];
