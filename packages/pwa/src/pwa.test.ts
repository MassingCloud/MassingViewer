import { describe, expect, it, vi } from "vitest";
import { isolationStatus, type IsolationEnvironment } from "./isolation.js";
import { massingPwa } from "./plugin.js";
import { registrationSource, swSource } from "./sw.js";

/**
 * Tests for the generated worker.
 *
 * The interesting decision here is that the last block **executes** the emitted source rather than grepping it.
 * A string assertion proves the text contains `cache.put`; it cannot prove the handler puts the right thing, and
 * every bug worth catching in a service worker is about behaviour under a failure — a missing asset, an offline
 * navigation, a 206. So the source is evaluated against fake `caches`/`fetch`, and the `fetch` handler is invoked.
 */

const OPTIONS = { cacheName: "test-1", precache: ["index.html", "assets/app-abc.js"] };

describe("swSource", () => {
  it("embeds the manifest and cache name as data, not as code to be edited", () => {
    const src = swSource(OPTIONS);
    expect(src).toContain('const CACHE = "test-1"');
    expect(src).toContain('const PRECACHE = ["index.html","assets/app-abc.js"]');
  });

  it("defaults isolation off", () => {
    expect(swSource(OPTIONS)).toContain("const ISOLATE = false");
    expect(swSource({ ...OPTIONS, crossOriginIsolation: true })).toContain("const ISOLATE = true");
  });

  it("escapes `<` so an asset path cannot end the script element", () => {
    // Not hypothetical for a generated file: this text is also inlined into HTML by `transformIndexHtml`, and a
    // `</script` sequence anywhere inside a string literal terminates the element regardless of quoting.
    const src = swSource({ ...OPTIONS, precache: ["</script><img src=x>"] });
    expect(src).not.toContain("</script");
    expect(src).toContain("\\u003c/script");
  });
});

describe("registrationSource", () => {
  it("reloads once when isolating, because the installing navigation cannot carry the headers", () => {
    const src = registrationSource({ swUrl: "./sw.js", crossOriginIsolation: true });
    expect(src).toContain("window.location.reload()");
    // Guarded, or a browser withholding SAB for an unrelated reason reloads forever.
    expect(src).toContain("navigator.serviceWorker.controller === null");
  });

  it("does not reload when not isolating", () => {
    expect(registrationSource({ swUrl: "./sw.js" })).not.toContain("location.reload");
  });
});

describe("the Vite plugin", () => {
  /** The subset of Rollup's bundle map the plugin reads. */
  const bundle = {
    "index.html": { type: "asset" },
    "assets/app-abc123.js": { type: "chunk" },
    "assets/app-def456.css": { type: "asset" },
    "assets/model-xyz.ifc": { type: "asset" },
  };

  function emit(plugin: ReturnType<typeof massingPwa>) {
    const emitted: { fileName: string; source: string }[] = [];
    plugin.generateBundle.call({ emitFile: (a) => emitted.push({ fileName: a.fileName, source: a.source }) }, {}, {
      ...bundle,
    });
    return emitted;
  }

  it("precaches the bundle's real hashed filenames", () => {
    const [sw] = emit(massingPwa());
    expect(sw!.fileName).toBe("sw.js");
    expect(sw!.source).toContain("assets/app-abc123.js");
    expect(sw!.source).toContain("assets/app-def456.css");
  });

  it("leaves out what the include list does not name", () => {
    // The 6.6 MB fixture is inlined into the JS bundle by `?raw`, so precaching a stray .ifc would double the
    // install for bytes nothing fetches.
    expect(emit(massingPwa())[0]!.source).not.toContain("model-xyz.ifc");
  });

  it("always precaches the shell, even when the bundle map omits it", () => {
    const emitted = emit(massingPwa());
    expect(emitted[0]!.source).toContain('"index.html"');
    // And when Vite does not list index.html as an asset at all — the case that would leave an offline
    // navigation with nothing to fall back to.
    const emptyShell: { fileName: string; source: string }[] = [];
    massingPwa().generateBundle.call({ emitFile: (a) => emptyShell.push({ fileName: a.fileName, source: a.source }) }, {}, {
      "assets/app-abc123.js": { type: "chunk" },
    });
    expect(emptyShell[0]!.source).toContain('"index.html"');
  });

  it("changes the cache name when, and only when, the precached set changes", () => {
    const a = emit(massingPwa())[0]!.source;
    const b = emit(massingPwa())[0]!.source;
    expect(cacheNameOf(a)).toBe(cacheNameOf(b));

    const changed: { fileName: string; source: string }[] = [];
    massingPwa().generateBundle.call({ emitFile: (x) => changed.push({ fileName: x.fileName, source: x.source }) }, {}, {
      ...bundle,
      "assets/app-NEWHASH.js": { type: "chunk" },
    });
    // The whole point: a new deploy must not be served the previous deploy's cache.
    expect(cacheNameOf(changed[0]!.source)).not.toBe(cacheNameOf(a));
  });

  it("references the registration script rather than inlining it, because the CSP forbids inline script", () => {
    // The regression this locks down. The first version inlined `registrationSource()` into the HTML, and
    // `docs/deployment.md`'s policy — `script-src 'self' 'wasm-unsafe-eval'`, no `unsafe-inline` — blocked it.
    // The E2E console-error guard reported "Executing inline script violates the following Content Security Policy
    // directive"; the worker never registered, and offline silently did not work.
    const html = massingPwa().transformIndexHtml("<html><body><div id=app></div></body></html>");
    expect(html).toContain('<script type="module" src="./sw-register.js"></script>');
    // No executable content in the document itself, which is the property the CSP actually enforces.
    expect(html).not.toContain("navigator.serviceWorker.register");
    expect(html).toContain("</body>");
  });

  it("emits the registration script as a file, relative because Pages serves from a subpath", () => {
    const emitted = emit(massingPwa());
    const register = emitted.find((f) => f.fileName === "sw-register.js");
    expect(register, "no registration script was emitted, so nothing would ever register the worker").toBeDefined();
    expect(register!.source).toContain('"./sw.js"');
    // An absolute "/sw.js" 404s under a repository subpath, and registration failures are warned rather than
    // thrown — so the whole offline story would be missing with nothing in CI to show it.
    expect(register!.source).not.toContain('"/sw.js"');
  });

  it("is build-only", () => {
    // A worker in `serve` caches the files being edited, and the symptom is a change that did not apply on a page
    // that looks fine.
    expect(massingPwa().apply).toBe("build");
  });
});

const cacheNameOf = (src: string): string => /const CACHE = "([^"]+)"/.exec(src)?.[1] ?? "";

describe("isolationStatus", () => {
  const env = (over: Partial<IsolationEnvironment>): IsolationEnvironment => ({
    crossOriginIsolated: false,
    hasSharedArrayBuffer: false,
    hasServiceWorker: true,
    hasController: false,
    ...over,
  });

  it("reports isolated only when SharedArrayBuffer can actually be allocated", () => {
    expect(isolationStatus(env({ crossOriginIsolated: true, hasSharedArrayBuffer: true })).isolated).toBe(true);
    // Headers without a usable SAB is its own reason: reporting "no headers" sends someone to fix a server config
    // that is already right.
    const partial = isolationStatus(env({ crossOriginIsolated: true }));
    expect(partial.isolated).toBe(false);
    expect(partial.reason).toBe("headers-without-sab");
    expect(partial.detail).toContain("secure context");
  });

  it("distinguishes a pending reload from an absent worker", () => {
    expect(isolationStatus(env({ hasController: true })).reason).toBe("pending-reload");
    expect(isolationStatus(env({ hasServiceWorker: false })).reason).toBe("unsupported");
    expect(isolationStatus(env({})).reason).toBe("no-headers");
  });

  it("always carries a sentence a user could be shown", () => {
    for (const e of [
      env({ crossOriginIsolated: true, hasSharedArrayBuffer: true }),
      env({ crossOriginIsolated: true }),
      env({ hasServiceWorker: false }),
      env({ hasController: true }),
      env({}),
    ]) {
      // The fallback has to be *visible*; a status with an empty detail is a silent fallback with extra steps.
      expect(isolationStatus(e).detail.length).toBeGreaterThan(20);
    }
  });
});

/**
 * Execute the generated worker.
 *
 * String assertions above prove the source *mentions* the right APIs. These prove the handler does the right thing
 * when something goes wrong, which is the only interesting part of a service worker.
 */
describe("the generated worker, actually run", () => {
  /**
   * A request as the worker sees one — and a shim rather than a real `Request`, for two reasons that are both
   * about Node rather than about the worker:
   *
   * - `new Request(url, { mode: "navigate" })` throws in undici ("invalid request mode navigate"). Only a browser
   *   navigation may carry that mode, so the one code path most worth testing is unconstructible with the real
   *   class.
   * - A precache manifest holds *relative* URLs (`index.html`). In a service worker they resolve against the
   *   worker's scope; in Node there is no base and `new Request("index.html")` fails to parse.
   *
   * The worker reads only `method`, `url` and `mode`, so this is the whole surface.
   */
  const ORIGIN = "https://example.test";
  interface FakeRequest {
    readonly url: string;
    readonly method: string;
    readonly mode: string;
  }
  const request = (url: string, init: { method?: string; mode?: string } = {}): FakeRequest => ({
    url: new URL(url, `${ORIGIN}/`).href,
    method: init.method ?? "GET",
    mode: init.mode ?? "cors",
  });

  interface FakeCache {
    store: Map<string, Response>;
    add(r: FakeRequest): Promise<void>;
    match(r: FakeRequest | string): Promise<Response | undefined>;
    put(key: FakeRequest | string, response: Response): Promise<void>;
  }

  function harness(source: string, fetchImpl: (r: FakeRequest) => Promise<Response>) {
    const store = new Map<string, Response>();
    const keyOf = (k: FakeRequest | string): string =>
      typeof k === "string" ? k : new URL(k.url).pathname.replace(/^\//, "") || "index.html";
    const cache: FakeCache = {
      store,
      async add(r) {
        const response = await fetchImpl(r);
        if (!response.ok) throw new Error(`bad status ${response.status}`);
        store.set(keyOf(r), response);
      },
      async match(r) {
        return store.get(keyOf(r));
      },
      async put(key, response) {
        store.set(keyOf(key), response);
      },
    };

    const listeners = new Map<string, (event: unknown) => void>();
    const caches = {
      open: async () => cache,
      keys: async () => ["a-stale-cache-from-a-previous-deploy"],
      delete: vi.fn(async () => true),
    };
    const scope = {
      addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
      skipWaiting: vi.fn(),
      clients: { claim: vi.fn() },
      location: { origin: ORIGIN },
      caches,
    };

    // `Request` is shadowed by the shim so the worker's `new Request(url, { cache: "reload" })` resolves relative
    // manifest entries the way a real worker's scope does.
    const RequestShim = function (url: string, init: { method?: string; mode?: string } = {}) {
      return request(url, init);
    } as unknown as new (url: string, init?: object) => FakeRequest;

    new Function(
      "self",
      "caches",
      "fetch",
      "Request",
      "console",
      source,
    )(scope, caches, fetchImpl, RequestShim, console);
    return { scope, cache, listeners, caches };
  }

  const waits: Promise<unknown>[] = [];
  const installEvent = { waitUntil: (p: Promise<unknown>) => waits.push(p) };

  it("a missing asset costs that asset, not the whole install", async () => {
    // `cache.addAll` rejects as a unit, so one 404 in the manifest would leave the app with no offline copy at
    // all. This is the reason the generated worker adds entries individually.
    const source = swSource({ cacheName: "c1", precache: ["index.html", "assets/gone.js", "assets/ok.js"] });
    const { listeners, cache } = harness(source, async (r) =>
      r.url.includes("gone") ? new Response("nope", { status: 404 }) : new Response("ok", { status: 200 }),
    );

    waits.length = 0;
    listeners.get("install")!(installEvent);
    await Promise.all(waits);

    expect([...cache.store.keys()].sort()).toEqual(["assets/ok.js", "index.html"]);
  });

  it("deletes the previous deploy's cache on activate, and claims open pages", async () => {
    // The failure this prevents is the worst one available here: an old cache kept alongside the new one means
    // the previous deploy is served indefinitely, which reads as "the deploy did not work" and has no error
    // anywhere. `caches.keys()` returns a foreign name, so a version-agnostic sweep would be visible as deleting
    // nothing, and deleting the *current* cache would be visible as deleting two.
    const source = swSource({ cacheName: "c-new", precache: [] });
    const { listeners, caches, scope } = harness(source, async () => new Response("ok"));

    waits.length = 0;
    listeners.get("activate")!(installEvent);
    await Promise.all(waits);

    expect(caches.delete).toHaveBeenCalledWith("a-stale-cache-from-a-previous-deploy");
    expect(caches.delete).toHaveBeenCalledTimes(1);
    // Without `claim()`, a page loaded before this worker activated stays uncontrolled until it is navigated
    // again — so the very first visit gets no offline cache despite the install having succeeded.
    expect(scope.clients.claim).toHaveBeenCalled();
  });

  it("serves the shell from cache when the network is gone", async () => {
    const source = swSource({ cacheName: "c1", precache: ["index.html"] });
    let online = true;
    const { listeners, cache } = harness(source, async () => {
      if (!online) throw new TypeError("Failed to fetch");
      return new Response("<html>app</html>", { status: 200 });
    });

    waits.length = 0;
    listeners.get("install")!(installEvent);
    await Promise.all(waits);
    expect(cache.store.has("index.html")).toBe(true);

    online = false;
    const served = await respond(listeners, request("/", { mode: "navigate" }));
    // The offline claim, and specifically that it survives a *reload* rather than only a session.
    expect(await served.text()).toContain("app");
  });

  it("does not cache a partial or errored response", async () => {
    const source = swSource({ cacheName: "c1", precache: [] });
    const { listeners, cache } = harness(source, async () => new Response("half", { status: 206 }));
    // A cached 206 corrupts every later full read of that URL, and a cached error makes the failure permanent for
    // as long as the cache lives.
    await respond(listeners, request("/assets/app.js"));
    expect(cache.store.size).toBe(0);
  });

  it("ignores cross-origin requests entirely", async () => {
    const source = swSource({ cacheName: "c1", precache: [] });
    const { listeners } = harness(source, async () => new Response("third party", { status: 200 }));
    let responded = false;
    listeners.get("fetch")!({
      request: { url: "https://cdn.example.com/font.woff2", method: "GET", mode: "cors" },
      respondWith: () => {
        responded = true;
      },
    });
    // Rewriting someone else's headers is not ours to do, and caching their bytes would break the
    // "no third-party origins" property the Pages workflow asserts.
    expect(responded).toBe(false);
  });

  it("adds COOP and COEP only when isolation is on", async () => {
    for (const on of [false, true]) {
      const source = swSource({ cacheName: "c1", precache: [], crossOriginIsolation: on });
      const { listeners } = harness(source, async () => new Response("<html>", { status: 200 }));
      const served = await respond(listeners, request("/", { mode: "navigate" }));
      expect(served.headers.get("Cross-Origin-Opener-Policy")).toBe(on ? "same-origin" : null);
      expect(served.headers.get("Cross-Origin-Embedder-Policy")).toBe(on ? "require-corp" : null);
    }
  });

  it("leaves a non-GET request to the network", async () => {
    const source = swSource({ cacheName: "c1", precache: [] });
    const { listeners } = harness(source, async () => new Response("ok"));
    let responded = false;
    listeners.get("fetch")!({
      request: request("/api", { method: "POST" }),
      respondWith: () => {
        responded = true;
      },
    });
    expect(responded).toBe(false);
  });
});

/** Invoke the worker's `fetch` listener and await whatever it passed to `respondWith`. */
async function respond(
  listeners: Map<string, (event: unknown) => void>,
  req: { url: string; method: string; mode: string },
): Promise<Response> {
  let promise: Promise<Response> | undefined;
  listeners.get("fetch")!({ request: req, respondWith: (p: Promise<Response>) => (promise = p) });
  if (promise === undefined) throw new Error("the worker did not respond to this request");
  return await promise;
}
