/**
 * The audit log — complete by construction, not by remembering.
 *
 * ## Why this belongs at the command bus and nowhere else
 *
 * Every audit log written by hand is incomplete, and it is incomplete in the same way: someone adds a mutation and
 * forgets the log line. Nobody notices, because the absence of a log entry looks exactly like the absence of the
 * action. The log is then worse than none at all, because it is *believed*.
 *
 * The command bus already has the property that makes this solvable: **every user action produces exactly one
 * serialisable `CommandInvocation`**, including interactive prompt loops, which are a reducer that emits one
 * invocation on completion. So a sink at the bus sees everything by construction — and
 * {@link auditCoverage} turns "everything" into a number a test can assert, by comparing the commands that were
 * *registered* against the ones that have ever been *logged*.
 *
 * ## What is recorded, and the one thing that is not
 *
 * Who, what, when, and whether it succeeded — plus the parameters, because an audit entry that says "an element
 * was deleted" without saying which is not an audit entry. This is the deliberate difference from
 * `telemetry.ts`, and the reason they are separate modules rather than one: **telemetry must not carry
 * identifiers, and an audit log is useless without them.** Conflating them produces either a metrics pipeline
 * full of GlobalIds or an audit trail nobody can act on.
 *
 * The consequence is that an audit log is *sensitive*. The default sink writes to memory, and exporting it is an
 * explicit act.
 */

export interface AuditEntry {
  /** ISO 8601. Injected, so a test is reproducible and a replay keeps the original time. */
  readonly at: string;
  /** The command id. */
  readonly command: string;
  /** Where it came from — a ribbon click, a keybinding, the palette, a macro, a plugin, a remote peer. */
  readonly origin: string;
  /** Who, if the host knows. Absent under `NoAuth`, which is the default and the offline case. */
  readonly actor?: string;
  /** The invocation's arguments. Identifiers included, unlike telemetry — that is the point. */
  readonly params?: Readonly<Record<string, unknown>>;
  readonly outcome: "applied" | "refused" | "failed";
  /** For a refusal, the code from the closed taxonomy. */
  readonly code?: string;
  /** Model version after the change, so a sequence of entries can be replayed and checked. */
  readonly version?: number;
}

export interface AuditSink {
  write(entry: AuditEntry): void;
}

export interface AuditLog extends AuditSink {
  readonly entries: readonly AuditEntry[];
  /** JSONL — one entry per line. The self-hoster's compliance artefact, and greppable without a parser. */
  toJsonl(): string;
  clear(): void;
}

/**
 * An in-memory log, bounded.
 *
 * Bounded because an unbounded one in a long-lived tab is a memory leak with a compliance justification, which is
 * the hardest kind to argue against. When it wraps it records that it wrapped: a log with a silent gap is a log
 * that will be presented as complete.
 */
export function createAuditLog(limit = 10_000): AuditLog {
  const entries: AuditEntry[] = [];
  let dropped = 0;

  return {
    get entries() {
      return entries;
    },

    write(entry) {
      if (entries.length >= limit) {
        entries.shift();
        dropped++;
      }
      entries.push(entry);
    },

    toJsonl() {
      const lines = entries.map((entry) => JSON.stringify(entry));
      if (dropped > 0) {
        // First line, so it cannot be missed by someone reading the tail — and a truncation notice at the end of
        // a file that was truncated at the start is in the wrong place.
        lines.unshift(JSON.stringify({ at: entries[0]?.at, note: `${dropped} earlier entr(ies) dropped`, dropped }));
      }
      return lines.join("\n") + (lines.length > 0 ? "\n" : "");
    },

    clear() {
      entries.length = 0;
      dropped = 0;
    },
  };
}

/** Several sinks at once — memory for the UI, a file or an endpoint for retention. */
export function teeAudit(...sinks: readonly AuditSink[]): AuditSink {
  return {
    write(entry) {
      for (const sink of sinks) {
        try {
          sink.write(entry);
        } catch {
          // One failing sink must not stop the others. An audit trail that stops because a disk filled is the
          // failure this guard exists for, and it is the case where losing the *rest* of the trail is worst.
        }
      }
    },
  };
}

export interface Coverage {
  /** Commands registered but never seen in the log. */
  readonly missing: readonly string[];
  /** Commands in the log that are not registered — a stale entry, or a command that was removed. */
  readonly unknown: readonly string[];
  readonly covered: number;
  readonly total: number;
}

/**
 * Compare what is registered against what has been logged.
 *
 * The assertion that makes "complete by construction" checkable rather than asserted. Run over a suite that
 * exercises every command, `missing` must be empty — and when it is not, it names the mutation somebody added
 * without a path through the bus.
 *
 * Both directions, because they are different bugs. `missing` is an unaudited action. `unknown` is a log entry
 * for a command that no longer exists, which means either a rename that lost its history or a replay of a log
 * against a newer build — and reading such a log as current is how a compliance answer ends up wrong.
 */
export function auditCoverage(registered: readonly string[], log: readonly AuditEntry[]): Coverage {
  const known = new Set(registered);
  const seen = new Set(log.map((entry) => entry.command));
  return {
    missing: registered.filter((id) => !seen.has(id)).sort(),
    unknown: [...seen].filter((id) => !known.has(id)).sort(),
    covered: registered.filter((id) => seen.has(id)).length,
    total: known.size,
  };
}
