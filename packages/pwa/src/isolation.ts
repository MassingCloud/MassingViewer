/**
 * Whether this page got cross-origin isolation, and therefore `SharedArrayBuffer`.
 *
 * ## Why this is a first-class export rather than an `if` somewhere
 *
 * The plan names the failure directly: *"make the single-threaded fallback **visible** — a silent fallback is a
 * 5× perf cliff."* A multithreaded WASM build that quietly drops to one thread does not error, does not warn, and
 * does not look different. It is simply slow, on some deployments and not others, and the person who eventually
 * investigates has no reason to suspect a response header. Every hour spent on that is an hour this function
 * would have saved, which is why the status is a value the UI can render rather than a console line.
 */

/** Why isolation is or is not available. Distinct causes, because the fix differs for each. */
export type IsolationReason =
  /** Headers present and honoured. `SharedArrayBuffer` works. */
  | "isolated"
  /** No service worker and no server headers. The default on GitHub Pages. */
  | "no-headers"
  /** Headers arrived but the browser still withheld `SharedArrayBuffer` — most often a missing secure context. */
  | "headers-without-sab"
  /** A service worker is registered and will apply headers after one reload. */
  | "pending-reload"
  /** The browser has no service worker support at all, so the worker route is not available either. */
  | "unsupported";

export interface IsolationStatus {
  /** `true` only when `SharedArrayBuffer` can actually be constructed. Never inferred from headers alone. */
  readonly isolated: boolean;
  readonly reason: IsolationReason;
  /** One sentence, written to be shown to a user rather than logged. */
  readonly detail: string;
}

/**
 * The environment this reads. Injected so the whole thing is testable without a browser — every branch below
 * corresponds to a real deployment, and none of them are reachable from a single test host.
 */
export interface IsolationEnvironment {
  readonly crossOriginIsolated: boolean;
  /** Whether the constructor exists **and** can be used. A cross-origin-isolated check alone is not enough. */
  readonly hasSharedArrayBuffer: boolean;
  readonly hasServiceWorker: boolean;
  /** Whether a worker controls this page. An installed-but-not-controlling worker means "reload pending". */
  readonly hasController: boolean;
}

/** Read the environment from a real browser. */
export function browserEnvironment(scope: typeof globalThis = globalThis): IsolationEnvironment {
  const nav = (scope as { navigator?: { serviceWorker?: { controller?: unknown } } }).navigator;
  return {
    crossOriginIsolated: (scope as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
    // Constructed rather than merely looked up. Some browsers keep the global present while refusing to allocate
    // outside an isolated context, so `typeof SharedArrayBuffer !== "undefined"` reports a capability the page
    // does not have — the exact silent-fallback shape this module exists to prevent.
    hasSharedArrayBuffer: canAllocateShared(scope),
    hasServiceWorker: nav?.serviceWorker !== undefined,
    hasController: nav?.serviceWorker?.controller != null,
  };
}

function canAllocateShared(scope: typeof globalThis): boolean {
  const ctor = (scope as { SharedArrayBuffer?: new (n: number) => object }).SharedArrayBuffer;
  if (ctor === undefined) return false;
  try {
    new ctor(8);
    return true;
  } catch {
    return false;
  }
}

/** Classify an environment. Pure, so every deployment posture is a test case. */
export function isolationStatus(env: IsolationEnvironment): IsolationStatus {
  if (env.crossOriginIsolated && env.hasSharedArrayBuffer) {
    return { isolated: true, reason: "isolated", detail: "Cross-origin isolated. Multithreaded WASM available." };
  }

  // Isolated but no usable SharedArrayBuffer. Reporting this as "no headers" would send someone to look at a
  // server config that is already correct, so it gets its own reason: the usual cause is an insecure context.
  if (env.crossOriginIsolated) {
    return {
      reason: "headers-without-sab",
      isolated: false,
      detail:
        "Isolation headers are present but SharedArrayBuffer is unavailable. Check that the page is a secure " +
        "context (https, or localhost).",
    };
  }

  if (!env.hasServiceWorker) {
    return {
      isolated: false,
      reason: "unsupported",
      detail: "This browser has no service worker, so isolation cannot be applied client-side. Running single-threaded.",
    };
  }

  // A worker is installed but not yet driving this page, so its headers were not on this navigation. This is the
  // normal state of the very first load and resolves itself, which is why it is not reported as a problem.
  if (env.hasController) {
    return {
      isolated: false,
      reason: "pending-reload",
      detail: "The service worker is installed and will apply isolation headers on the next load.",
    };
  }

  return {
    isolated: false,
    reason: "no-headers",
    detail:
      "No cross-origin isolation: SharedArrayBuffer is unavailable and multithreaded WASM will run on one " +
      "thread. See docs/deployment.md.",
  };
}
