/**
 * The HTTP seam — four functions, injected.
 *
 * ## Why an interface and not `ApiClient`
 *
 * massing's `apps/web/src/api/client.ts` is ~3,865 lines threaded through five files, and the plan names
 * re-coupling to it as risk #9. Taking it as a dependency would drag authentication, retry policy, demo-mode
 * interception, error toasts and a project-context singleton into a package whose job is to speak one protocol.
 *
 * Four functions is the whole surface. The consequences are worth having:
 *
 * - **The conformance suite runs with no backend.** `cassetteTransport` replays recorded exchanges, so
 *   `describeKernel` can be pointed at `RemoteKernel` on every PR rather than nightly-only. That is what the plan
 *   wanted M3 for — turning the suite from aspirational documentation into an executable spec — and it does not
 *   work if the kernel can only be exercised against a live service.
 * - **Auth is the host's problem.** A host that has OIDC passes a transport that adds a header. This package never
 *   learns that tokens exist, which is also why `scripts/check-architecture.mjs` can assert that nothing outside
 *   `kernel-remote` imports anything HTTP-shaped.
 * - **Offline is representable.** A transport that always fails is a legitimate transport, and the kernel reports
 *   `transport` failures rather than throwing.
 */

export type HttpOutcome<T> =
  | { readonly ok: true; readonly status: number; readonly value: T }
  /**
   * Failed, with the status if there was one.
   *
   * `status: 0` means the request never reached a server — offline, DNS, a refused connection. Distinguishing that
   * from a 500 matters: one is "you are not connected", the other is "the service is broken", and telling a user
   * the wrong one sends them to the wrong place.
   */
  | { readonly ok: false; readonly status: number; readonly error: string; readonly body?: unknown };

export interface HttpInit {
  readonly signal?: AbortSignal;
  readonly onProgress?: (loaded: number, total: number) => void;
}

export interface HttpTransport {
  /** JSON GET. */
  get<T>(path: string, init?: HttpInit): Promise<HttpOutcome<T>>;
  /** JSON POST. */
  post<T>(path: string, body: unknown, init?: HttpInit): Promise<HttpOutcome<T>>;
  /** Text GET — the drawing endpoints return SVG. */
  text(path: string, init?: HttpInit): Promise<HttpOutcome<string>>;
  /** Binary GET — geometry and IFC export. */
  bytes(path: string, init?: HttpInit): Promise<HttpOutcome<Uint8Array>>;
}

/**
 * A transport over `fetch`.
 *
 * Offered for convenience and deliberately thin. `baseUrl` is joined without a trailing slash so a caller cannot
 * accidentally produce `//projects`, which some gateways treat as a different route and others 404.
 */
export function fetchTransport(baseUrl: string, headers: Readonly<Record<string, string>> = {}): HttpTransport {
  const base = baseUrl.replace(/\/+$/, "");
  const url = (path: string): string => `${base}/${path.replace(/^\/+/, "")}`;

  async function run<T>(
    path: string,
    init: RequestInit & HttpInit,
    read: (response: Response) => Promise<T>,
  ): Promise<HttpOutcome<T>> {
    try {
      const response = await fetch(url(path), { ...init, headers: { ...headers, ...init.headers } });
      if (!response.ok) {
        // The body is carried through even on failure: massing's service puts its refusal reason there, and
        // discarding it would turn "wall would be 3 mm long" into "HTTP 422".
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          body = undefined;
        }
        return { ok: false, status: response.status, error: `HTTP ${response.status}`, body };
      }
      return { ok: true, status: response.status, value: await read(response) };
    } catch (error) {
      // `status: 0`, because there was no response. See the note on `HttpOutcome`.
      return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    get: (path, init) =>
      run(path, { method: "GET", signal: init?.signal, headers: { accept: "application/json" } }, (r) => r.json()),
    post: (path, body, init) =>
      run(
        path,
        {
          method: "POST",
          signal: init?.signal,
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(body),
        },
        (r) => r.json(),
      ),
    text: (path, init) => run(path, { method: "GET", signal: init?.signal }, (r) => r.text()),
    bytes: (path, init) =>
      run(path, { method: "GET", signal: init?.signal }, async (r) => new Uint8Array(await r.arrayBuffer())),
  };
}

/** One recorded exchange. `body` is compared structurally for POSTs, so a cassette is order-independent. */
export interface Cassette {
  readonly method: "GET" | "POST";
  readonly path: string;
  /** For POST: match only when the request body deep-equals this. Omit to match any body. */
  readonly body?: unknown;
  readonly reply: HttpOutcome<unknown>;
  /** Replay this many times before falling through to the next match. For polling. */
  readonly times?: number;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A transport that replays recorded exchanges.
 *
 * This is what makes `RemoteKernel` testable on every PR, and the plan asks for exactly it: cassettes for PR
 * speed, a docker-composed backend nightly. Two properties matter:
 *
 * - **An unmatched request fails loudly**, rather than returning an empty success. A cassette that silently
 *   answers "{}" to a request nobody recorded produces a test that passes while asserting nothing, which is worse
 *   than no test.
 * - **`times` supports polling.** `waitForPublish` polls until a job completes, so a cassette has to be able to
 *   say "pending, pending, done" — and a fixed reply cannot express that.
 */
export function cassetteTransport(cassettes: readonly Cassette[]): HttpTransport & { readonly unmatched: readonly string[] } {
  const remaining = cassettes.map((c) => ({ ...c, left: c.times ?? Infinity }));
  const unmatched: string[] = [];

  function match(method: "GET" | "POST", path: string, body?: unknown): HttpOutcome<unknown> {
    for (const entry of remaining) {
      if (entry.method !== method || entry.path !== path || entry.left <= 0) continue;
      if (method === "POST" && entry.body !== undefined && !sameJson(entry.body, body)) continue;
      entry.left--;
      return entry.reply;
    }
    const description = `${method} ${path}`;
    unmatched.push(description);
    return { ok: false, status: 0, error: `no cassette for ${description}` };
  }

  return {
    get: async (path) => match("GET", path) as HttpOutcome<never>,
    post: async (path, body) => match("POST", path, body) as HttpOutcome<never>,
    text: async (path) => match("GET", path) as HttpOutcome<string>,
    bytes: async (path) => match("GET", path) as HttpOutcome<Uint8Array>,
    get unmatched() {
      return [...unmatched];
    },
  };
}
