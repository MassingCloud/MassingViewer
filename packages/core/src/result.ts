/**
 * `Result` — the reason this project does not throw across package boundaries.
 *
 * Two distinct kinds of failure need distinct handling, and exceptions collapse them:
 *
 * - A **bug** (null dereference, bad invariant) should throw. Nobody can act on it but a developer,
 *   and the stack trace is the whole value.
 * - A **refusal** ("that wall is not an extrusion, so it cannot be push-pulled") is a normal outcome
 *   with a message the user is meant to read. It is data, and it must survive a worker boundary, a
 *   plugin boundary, an undo record, and an audit log entry — all of which `structuredClone` an
 *   object and none of which preserve an `Error`.
 *
 * The plugin host relies on this too: its hard guarantee is *no plugin can crash the host*, which is
 * only achievable if plugin failures arrive as values.
 */

export type Result<T, E = Failure> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(r: Result<T, E>): r is { readonly ok: true; readonly value: T } {
  return r.ok;
}

/**
 * The base failure shape.
 *
 * `code` is for programs — a closed set, asserted by the conformance suite, never localised.
 * `message` is for people — localised, and deliberately **not** asserted in tests, because a test that
 * pins user-facing wording either blocks copy improvements or gets updated without thought.
 */
export interface Failure {
  readonly code: string;
  readonly message: string;
  /** Structured context for logs and for the UI to render. Must be JSON-serialisable. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

export function failure(code: string, message: string, detail?: Record<string, unknown>): Failure {
  return detail === undefined ? { code, message } : { code, message, detail };
}

/** Map the success value, leaving a failure untouched. */
export function mapResult<T, U, E>(r: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return r.ok ? ok(fn(r.value)) : r;
}

/**
 * Unwrap, throwing on failure.
 *
 * For tests and for the top of a call stack where a refusal genuinely is unexpected. Reaching for this
 * inside library code defeats the point of `Result` — if a refusal is possible there, handle it.
 */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  const e = r.error as { code?: string; message?: string };
  throw new Error(`unwrap on a failed Result: ${e.code ?? "?"} — ${e.message ?? JSON.stringify(r.error)}`);
}

/**
 * Run a function that might throw, converting a thrown error into a `Failure`.
 *
 * The boundary adapter: use it where untrusted or third-party code is called (a plugin's `activate`, a
 * WASM entry point, a JSON parse of a file from disk), so the exception becomes a value at the exact
 * point the trust boundary is crossed rather than unwinding an unknown distance.
 */
export function attempt<T>(fn: () => T, code = "internal"): Result<T> {
  try {
    return ok(fn());
  } catch (e: unknown) {
    return err(failure(code, e instanceof Error ? e.message : String(e)));
  }
}

export async function attemptAsync<T>(fn: () => Promise<T>, code = "internal"): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (e: unknown) {
    return err(failure(code, e instanceof Error ? e.message : String(e)));
  }
}
