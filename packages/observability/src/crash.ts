import { redact, redactValue } from "./redact";

/**
 * Crash reporting, with the sink inverted.
 *
 * ## Why the default sends nothing
 *
 * massing wires `errorReporting.ts` to a hosted service. That is a reasonable choice for a hosted product and the
 * wrong one for this: MassingViewer's central promise is that a model never leaves the browser, and a crash
 * reporter that phones home by default breaks that promise *specifically in the case where the model was
 * unusual* — which is exactly when someone would care.
 *
 * So the interface is inverted. `NOOP_CRASH_SINK` is the default and ships nothing. `consoleSink()` is for
 * development. `httpSink(url)` posts to whatever a deployment chooses — self-hosted Sentry, GlitchTip, a log
 * endpoint — and takes redaction on the way out. No vendor SDK, no default egress, and the difference between
 * "we do not send crash reports" and "we send them to a third party you have not heard of" is one function
 * argument rather than an unread privacy page.
 *
 * ## Reports are redacted at the boundary
 *
 * See `redact.ts`. The short version: an error message in this application routinely contains a client's name in
 * a file path or an element's GlobalId, and a stack trace is the one channel nobody reviews because it does not
 * feel like content. `consoleSink()` deliberately does **not** redact — a developer wants the filename — and
 * every sink that leaves the machine does.
 */

export interface CrashReport {
  readonly message: string;
  readonly stack?: string;
  /** `error` for a thrown exception, `rejection` for an unhandled promise, `manual` for a reported one. */
  readonly kind: "error" | "rejection" | "manual";
  /** Where it happened, in application terms: `"viewport"`, `"kernel"`, `"plugin"`. Never a URL or a path. */
  readonly where?: string;
  /** Extra structured context. Redacted structurally, keys included. */
  readonly context?: Readonly<Record<string, unknown>>;
  /** ISO 8601. Passed in rather than read from a clock, so a report is reproducible in a test. */
  readonly at: string;
}

export interface CrashSink {
  report(report: CrashReport): void;
}

/** The default. Nothing is sent, which is what makes the offline claim true rather than aspirational. */
export const NOOP_CRASH_SINK: CrashSink = { report: () => {} };

/**
 * Log to the console, unredacted.
 *
 * Deliberately unredacted, and it is the one sink where that is correct: the report is not leaving the machine,
 * and a developer chasing a parse failure needs the actual filename. Redacting here would make the local
 * experience worse for no privacy gain — the risk is egress, not display.
 */
export function consoleSink(log: Pick<Console, "error"> = console): CrashSink {
  return {
    report(report) {
      log.error(`[crash:${report.kind}] ${report.where ?? "unknown"}: ${report.message}`, {
        stack: report.stack,
        context: report.context,
        at: report.at,
      });
    },
  };
}

export interface HttpSinkOptions {
  /** Injected so a test does not need a network, and so a host can add its own auth headers. */
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  /** Cap on queued reports while offline. Default 20. */
  readonly queueLimit?: number;
}

/**
 * POST reports to a URL of the deployment's choosing.
 *
 * Three properties that are easy to leave out and each cause a distinct failure:
 *
 * **Redacted.** Everything crossing this boundary goes through `redactValue` — message, stack, and context keys.
 *
 * **Failures are kept, and retried by the next report.** The first version spliced the queue and *then* awaited
 * the POST, so a failed send dropped the batch — and the queue never grew past one entry, which made the whole
 * bounded-queue mechanism dead code. Nothing is removed until the send succeeds.
 *
 * The retry is driven by the **arrival of the next report**, never by a timer. That is what keeps a reporter which
 * cannot reach its endpoint from becoming a loop that holds the tab awake: no new crashes, no new attempts.
 *
 * **Bounded queue.** An offline session that crashes repeatedly must not accumulate reports until the tab dies.
 * The oldest are dropped and the count travels with the next successful send, so the gap is visible rather than
 * silent — a quiet period otherwise reads as stability.
 */
export function httpSink(url: string, options: HttpSinkOptions = {}): CrashSink {
  const post = options.fetch ?? globalThis.fetch;
  const limit = options.queueLimit ?? 20;
  const queue: CrashReport[] = [];
  let dropped = 0;
  let inFlight = false;

  const flush = (): void => {
    // One request at a time. Concurrent flushes would send the same reports twice and race on `dropped`.
    if (inFlight || queue.length === 0) return;
    const batch = [...queue];
    const droppedWith = dropped;
    inFlight = true;

    const body = JSON.stringify({ reports: batch.map((report) => redactValue(report)), dropped: droppedWith });

    // An async IIFE rather than `Promise.resolve(post(...)).then(...)`. Two reasons, and the first is a bug: a
    // `fetch` implementation that throws *synchronously* — a bad URL, a permissions policy, a stub in a test —
    // escapes the promise chain entirely and becomes an unhandled exception inside the crash reporter. `try` here
    // catches both shapes. The second is that the wrapper added several microtask ticks for nothing.
    void (async () => {
      try {
        const response = await post(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...options.headers },
          body,
          // No cookies. A crash endpoint has no business receiving a session, and `omit` makes that structural
          // rather than dependent on how the endpoint is configured.
          credentials: "omit",
          keepalive: true,
        });
        // A 5xx is a failure too. Treating any *settled* request as success is how reports vanish into an endpoint
        // that has been returning 503 for a week — the request completed, so nothing looks wrong.
        if (response?.ok === false) return;
        queue.splice(0, batch.length);
        dropped -= droppedWith;
      } catch {
        // Swallowed and kept. Re-attempting here is what would make this a loop.
      } finally {
        inFlight = false;
      }
    })();
  };

  return {
    report(report) {
      if (queue.length >= limit) {
        queue.shift();
        dropped++;
      }
      queue.push(report);
      flush();
    },
  };
}

export interface CrashHandlerOptions {
  readonly sink?: CrashSink;
  /** Where these came from, in application terms. */
  readonly where?: string;
  /** Injected so a report is reproducible in a test rather than carrying a live clock. */
  readonly now?: () => string;
  /** Called for each report before it reaches the sink. Return false to drop it. */
  readonly filter?: (report: CrashReport) => boolean;
}

export interface CrashHandler {
  /** Report something caught by hand. */
  capture(error: unknown, context?: Readonly<Record<string, unknown>>): void;
  /** Attach to `error` and `unhandledrejection` on a target. Returns a disposer. */
  install(target: Pick<Window, "addEventListener" | "removeEventListener">): () => void;
}

/** Message and stack out of anything, including the things people throw that are not Errors. */
function describe(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: `${error.name}: ${error.message}`, stack: error.stack };
  }
  // `throw "boom"` and `throw {code: 42}` both happen, and a handler that assumes `Error` reports
  // "undefined: undefined" for them — which is a crash report with no information in it.
  if (typeof error === "string") return { message: error };
  try {
    return { message: JSON.stringify(error) ?? String(error) };
  } catch {
    return { message: String(error) };
  }
}

export function createCrashHandler(options: CrashHandlerOptions = {}): CrashHandler {
  const sink = options.sink ?? NOOP_CRASH_SINK;
  const now = options.now ?? (() => new Date().toISOString());

  const emit = (report: CrashReport): void => {
    if (options.filter?.(report) === false) return;
    try {
      sink.report(report);
    } catch {
      // A throwing sink must not take down the handler. This is the last line of defence in the process, and it
      // is the one place where swallowing an error is unambiguously right.
    }
  };

  return {
    capture(error, context) {
      const { message, stack } = describe(error);
      emit({ kind: "manual", message, stack, where: options.where, context, at: now() });
    },

    install(target) {
      const onError = (event: Event): void => {
        const detail = event as ErrorEvent;
        const { message, stack } = describe(detail.error ?? detail.message);
        emit({ kind: "error", message, stack, where: options.where, at: now() });
      };
      const onRejection = (event: Event): void => {
        const detail = event as PromiseRejectionEvent;
        const { message, stack } = describe(detail.reason);
        emit({ kind: "rejection", message, stack, where: options.where, at: now() });
      };

      target.addEventListener("error", onError);
      // The half everyone forgets. An async failure with no `.catch` produces no `error` event at all, so a
      // handler that only listens for `error` misses every rejected promise — which in an app this async is most
      // of them.
      target.addEventListener("unhandledrejection", onRejection);

      return () => {
        target.removeEventListener("error", onError);
        target.removeEventListener("unhandledrejection", onRejection);
      };
    },
  };
}

/** Redact a report without a sink — for a host that wants to inspect one before deciding. */
export function redactReport(report: CrashReport): CrashReport {
  return {
    ...report,
    message: redact(report.message),
    stack: report.stack === undefined ? undefined : redact(report.stack),
    context: report.context === undefined ? undefined : (redactValue(report.context) as Record<string, unknown>),
  };
}
