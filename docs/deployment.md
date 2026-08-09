# Deployment

MassingViewer is a static site. There is no server component, no database, and no required backend — `LocalKernel`
runs entirely in the browser, so `npm run build --workspace @massing/demo` produces a directory you can serve from
anything. `RemoteKernel` adds an authoring service if you want one; nothing else changes.

## The two postures

The difference between them is one HTTP header pair, and it decides whether `SharedArrayBuffer` is available.

|  | **Static host** (GitHub Pages, S3, a CDN) | **Server you control** (nginx, Caddy, Cloudflare Workers) |
|---|---|---|
| COOP/COEP | Cannot be set. Applied by the service worker, if enabled | Set as response headers — the correct place |
| `SharedArrayBuffer` | Only via `crossOriginIsolation: true`, after one reload | Available on first load |
| Offline caching | Yes, always | Yes, always |
| Which to choose | The public demo, and any deployment where a static host is the point | Anything needing shared memory on first paint |

**Neither posture is a downgrade today.** Nothing in this repository uses `SharedArrayBuffer` — see
`docs/adr/0010-one-service-worker.md` — so the static host is fully featured. The distinction becomes load-bearing
only when something arrives that needs shared memory.

### Static host

Build and serve. `apps/demo/vite.config.ts` sets `base: "./"`, so a repository subpath works with no rebuild.

```bash
npm run build --workspace @massing/demo
```

The build emits a service worker at the root of the output (sw.js — generated, so not a tracked path) and
injects its registration into `index.html`. The worker precaches the shell and every
hashed asset, so a reload with no network opens the app rather than failing.

`.github/workflows/pages.yml` does this, and then asserts the deployed page actually renders a building. That
post-deploy check is the point of the workflow, not an extra: "deployed successfully" and "works" are different
claims, and massing's own Pages demo has been live and broken for a long time on exactly that gap.

### Server you control

Set the headers and skip the worker's isolation pass entirely:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Two consequences worth knowing before you do:

- **`require-corp` blocks every cross-origin subresource** that does not opt in with CORP or CORS. If you embed a
  font, a tile server or an iframe from another origin, it stops loading, and the symptom looks like a network
  fault rather than a policy decision. This is why isolation is off by default.
- **`credentialless` is the gentler variant** and Safari does not support it. Safari and iPad are a stated
  differentiator here, so `require-corp` is the one to use.

## Turning on cross-origin isolation

One option:

```ts ignore
import { massingPwa } from "@massing/pwa";

export default defineConfig({
  plugins: [massingPwa({ crossOriginIsolation: true })],
});
```

The generated worker then rewrites navigation responses with COOP/COEP, and the injected registration script
reloads the page **once** on first install. That reload is not avoidable: the worker cannot add headers to the
navigation that installed it, because that response was already on the wire before the worker existed.

Do this in the same change as whatever needs `SharedArrayBuffer`, not in advance.

## Content Security Policy

The policy that survives WASM:

```
script-src 'self' 'wasm-unsafe-eval';
worker-src 'self' blob:;
object-src 'none';
base-uri 'none';
frame-ancestors 'none';
require-trusted-types-for 'script';
```

`'wasm-unsafe-eval'` is the narrow grant that permits WebAssembly compilation. It is **not** `'unsafe-eval'`, and
the difference matters: the broad form re-enables `eval` and `new Function` for all script, which is most of what
a CSP is for.

`worker-src 'self' blob:` is required because `LocalKernel`'s worker is constructed from a blob URL — that is what
makes it worker-only by construction, with no synchronous path a caller could accidentally take.

## Is it actually offline?

Two properties, checked in different places, and they are not the same claim:

- **Zero network requests after first paint** — asserted in E2E (`e2e/walking-skeleton.spec.ts`). The fixture is
  inlined at build time rather than fetched.
- **No third-party origins in the built output** — asserted in `.github/workflows/pages.yml` against the built files, not trusted.
  A CDN font or an analytics snippet would silently break "the model never leaves your browser", and it would
  break it in the built artifact rather than in the source anyone reviews.

To check by hand: load the page, go offline in DevTools, reload. It should open. Before the service worker landed
it did not — the session survived, the refresh did not.

Both are covered by E2E, and the coverage is uneven in a way worth stating:

- **The worker registers and controls the page, with a non-empty cache** — asserted in chromium, firefox, webkit
  and iPad. This is the precondition, and it holds on Safari.
- **The offline reload itself** — asserted in chromium only. On WebKit, `page.reload()` under Playwright's
  `setOffline(true)` fails with "WebKit encountered an internal error"; the offline emulation does not survive a
  reload. What is missing on Safari is that *verification*, not the feature — hence the split into two tests
  rather than one test skipped on WebKit, which would have dropped the moat browser from the claim entirely.
  Verify Safari by hand, or on the weekly real-device run.

## Verifying a deployment

```bash
npm run gate:bundle
```

Per-package budgets, checked in CI and again in `.github/workflows/pages.yml`, because the Pages artifact is what users download.
`scripts/bundle-budget.mjs` parses the entry point out of `index.html` rather than matching a filename pattern —
a lazily-loaded index-&lt;hash&gt;.js vendor chunk was once miscounted as shell, and the fix was to stop guessing from
names.

For the deployed page: the `Threads` row in the Model panel reads `shared memory` when isolation is in effect and
`single` when it is not. That row exists so the answer is on screen rather than discovered later from a
performance profile.
