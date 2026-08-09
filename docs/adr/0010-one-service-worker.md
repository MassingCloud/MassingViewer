# ADR-0010 — One service worker, and cross-origin isolation off until something needs it

**Status:** accepted · 2026-08-08 · supersedes nothing · relates to ADR-0008

## Context

The plan calls this "the SharedArrayBuffer trap, solved properly", and states it as a chain:
`@thatopen/fragments` needs `SharedArrayBuffer` → which needs COOP/COEP response headers → which GitHub Pages
cannot set → so massing's `VITE_PAGES` build injects `coi-serviceworker` **instead of** its Workbox PWA worker,
because a page has exactly one controlling service worker per scope and the two fight.

massing therefore chooses between working offline and having `SharedArrayBuffer`. For a tool whose headline claim
is that it works with no network and the model never leaves the browser, that is the wrong trade, and the
instruction was to ship one worker doing both jobs.

**On inspection, the first link of the chain is not true in this repository.** There is no `@thatopen/*`
dependency, no `web-ifc`, and no use of `SharedArrayBuffer` or `Atomics` anywhere in `packages/` or `apps/`.
ADR-0008 is why: the entity table in `packages/ifc` is ours and pure TypeScript, and the demo tessellates
in-process. Nothing here needs shared memory.

Meanwhile the offline half is a real, present gap. `apps/demo` makes zero network requests *after first paint* —
that property is asserted in E2E — but nothing was cached, so a reload with no network failed to open the app at
all. "Works offline" survived a session and not a refresh.

## Decision

**One worker, in `@massing/pwa`, doing precaching always and cross-origin isolation on a switch that defaults
off.**

1. **Both behaviours in one `fetch` handler.** They compose because they act at different points: the cache
   decides *what* the response is, the isolation pass decides *what headers it carries*. Two workers cannot
   compose at all — that is the constraint that forced massing's either/or.

2. **`crossOriginIsolation: false` by default.** Enabling it speculatively is not free: COEP `require-corp`
   blocks every cross-origin subresource that does not opt in via CORP or CORS, so turning it on "for later"
   breaks images, fonts and iframes at a distance, with a symptom that reads as a network fault. It is enabled by
   whatever brings `SharedArrayBuffer` with it, in the same change.

3. **Hand-written, not Workbox.** Workbox generates its own `fetch` handler, which is exactly the code that must
   also perform the header rewrite — so combining them means patching generated output, or running Workbox's
   handler and then being unable to reach the response it already returned. The direct version is about ninety
   lines, makes the interaction explicit, and keeps a large transitive tree out of a package whose SBOM is a
   shipped artifact. Consistent with the PDF and IFC serialisers, which are hand-written for the same reason.

4. **The worker is emitted by a pure function.** A service worker cannot be imported by the app it serves — it is
   a separate script with a different global type. `swSource(options)` returns its text, so the manifest, cache
   name and isolation switch are inputs and the tests assert on output. The tests then *execute* that output
   against fake `caches`/`fetch`, because every bug worth catching here is behavioural: a 404 in the manifest, an
   offline navigation, a cached 206.

5. **The fallback is visible.** `isolationStatus()` classifies the environment into distinct reasons, each with a
   sentence written to be shown rather than logged, and the demo renders a `Threads` row. The plan's wording is
   the justification: *a silent fallback is a 5× perf cliff.* It is styled `muted` rather than `warn`, because
   single-threaded is the expected state here and flagging it as a fault would be crying wolf.

## Consequences

- A reload with no network now opens the app. That is the claim the product is sold on, and it was previously
  false in the one case a user would actually try.
- Enabling isolation later is one option flag plus one reload on first install, both already written and tested.
  No re-architecting, which is the value the "unified" requirement was really asking for.
- The plugin is build-only. A worker in `serve` caches the files being edited, and the symptom — a change that did
  not apply, on a page that looks fine — is expensive out of proportion to the convenience.
- The cache name is derived from a hash of the precache manifest, so it changes exactly when the cached set does.
  A hand-maintained version string is a cache-invalidation bug waiting for someone to forget it, and its symptom
  is the previous deploy served indefinitely.
- `@massing/pwa` is published, so massing gets the same worker at M9 rather than keeping its `VITE_PAGES`
  either/or.

## What was rejected

- **Two workers, scoped differently.** Scope is path-based, so isolating the app shell means the isolating worker
  controls everything under it anyway. This does not avoid the conflict, it hides it behind a path.
- **COOP/COEP as static headers.** Correct where a server exists, and documented in `docs/deployment.md` as the
  preferred posture there. It cannot work on GitHub Pages, which is the deployment the public demo uses.
- **`credentialless` instead of `require-corp`.** Weaker breakage, but not supported in Safari, and Safari and
  iPad are the stated differentiator. Revisit if isolation is ever turned on.
