/**
 * `@massing/pwa` — one service worker doing offline precaching and, optionally, cross-origin isolation.
 *
 * The plan calls this "the SharedArrayBuffer trap, solved properly". The trap: `@thatopen/fragments` needs
 * `SharedArrayBuffer`, which needs COOP/COEP, which GitHub Pages cannot set, so massing's `VITE_PAGES` injects
 * `coi-serviceworker` *instead of* the Workbox PWA worker because a page has one controlling worker and the two
 * fight. That forces a choice between working offline and using SAB.
 *
 * **What is actually true in this repository, which changes the shape of the answer:** nothing here needs
 * `SharedArrayBuffer`. There is no `@thatopen/*` dependency, no `web-ifc`, and no `Atomics` use — `packages/ifc`
 * is a pure-TypeScript entity table per ADR-0008, and the demo tessellates in-process. So the isolation half has
 * no consumer today and is **off by default**, while the offline half is a present, load-bearing need: the app
 * claims to work with no network, and until now that survived a session but not a reload.
 *
 * Enabling isolation speculatively is not free. COEP `require-corp` blocks every cross-origin subresource that
 * does not opt in, so "on just in case" breaks images, fonts and iframes at a distance, with a symptom that looks
 * like a network fault. It is a switch for whatever brings SAB with it.
 *
 * See `docs/deployment.md` for both postures, and {@link isolationStatus} for the reason the fallback is visible
 * rather than silent.
 */

// The Vite plugin is NOT re-exported here. It is build-time code and this entry point is imported by the app
// itself, so a single barrel would put the plugin in the browser bundle — which is how `node:crypto` ended up
// externalised with a warning before the hash was made pure. Import it from `@massing/pwa/vite`.
export { registrationSource, swSource, type SwOptions } from "./sw.js";
export {
  browserEnvironment,
  isolationStatus,
  type IsolationEnvironment,
  type IsolationReason,
  type IsolationStatus,
} from "./isolation.js";
