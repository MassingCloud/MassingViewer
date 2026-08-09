import { manifestDigest, registrationSource, swSource } from "./sw.js";

/**
 * The Vite plugin. One plugin with a mode switch, which is what the plan asks for.
 *
 * It runs at build time only. In `serve` it does nothing at all, deliberately: a service worker during
 * development caches the very files you are editing, and the resulting "my change did not apply" is expensive to
 * diagnose precisely because the page looks fine. HMR already owns the dev-time story.
 */

export interface PwaPluginOptions {
  /**
   * Rewrite navigation responses with COOP/COEP.
   *
   * Off by default. See the note on {@link SwOptions.crossOriginIsolation} — this breaks cross-origin
   * subresources, so it is enabled by whatever needs `SharedArrayBuffer`, not in advance.
   */
  readonly crossOriginIsolation?: boolean;
  /** Emitted worker filename. At the root of `outDir`, so its scope is the whole app. */
  readonly fileName?: string;
  /** Extensions to precache. Anything else in the build is fetched on demand. */
  readonly include?: readonly RegExp[];
  /** Emitted registration-script filename. A separate file, never inline — see `generateBundle`. */
  readonly registerFileName?: string;
}

/** Minimal shapes from Vite's plugin API, so this package does not depend on vite to be typechecked. */
interface EmittedAsset {
  readonly type: "asset";
  readonly fileName: string;
  readonly source: string;
}
interface BundleEntry {
  readonly type: string;
}
interface PluginContext {
  emitFile(asset: EmittedAsset): void;
}
export interface VitePluginLike {
  readonly name: string;
  readonly apply: "build";
  generateBundle(this: PluginContext, options: unknown, bundle: Record<string, BundleEntry>): void;
  transformIndexHtml(html: string): string;
}

const DEFAULT_INCLUDE = [/\.js$/, /\.css$/, /\.html$/, /\.wasm$/, /\.woff2?$/, /\.svg$/, /\.png$/];

export function massingPwa(options: PwaPluginOptions = {}): VitePluginLike {
  const fileName = options.fileName ?? "sw.js";
  const include = options.include ?? DEFAULT_INCLUDE;
  const isolate = options.crossOriginIsolation ?? false;
  const registerFileName = options.registerFileName ?? "sw-register.js";

  return {
    name: "massing-pwa",
    // Build only. A service worker in `serve` caches the files being edited.
    apply: "build",

    generateBundle(_options, bundle) {
      // The manifest is read off the actual bundle rather than guessed from a glob of the source tree. Vite's
      // output filenames are content-hashed and its chunking is not predictable from the inputs, so a
      // source-derived list would precache URLs that do not exist and miss the ones that do. `bundle-budget.mjs`
      // learned the same lesson the hard way: it parses the entry out of index.html rather than matching a
      // filename pattern, because a lazily-loaded `index-<hash>.js` vendor chunk was miscounted as shell.
      const precache = Object.keys(bundle)
        .filter((name) => include.some((re) => re.test(name)))
        .sort();

      // "index.html" is not in the bundle as an asset in every Vite configuration, so the shell is added
      // explicitly. Without it a navigation offline has nothing to fall back to and the app fails to open at all
      // — the one failure mode this plugin exists to prevent.
      if (!precache.includes("index.html")) precache.unshift("index.html");

      // Cache name derived from the manifest, so it changes exactly when the precached set changes. A
      // hand-written version string is a cache-invalidation bug waiting for someone to forget to bump it — and
      // the symptom is the previous deploy served indefinitely, which reads as "the deploy did not work".
      //
      // A pure hash rather than `node:crypto`, so this module stays importable from a browser bundle. The first
      // version used `createHash`, and because `index.ts` re-exported the plugin, Vite pulled `node:crypto` into
      // the app and externalised it with a warning. Collision resistance is irrelevant here — the digest only has
      // to *differ* when the manifest differs.
      const digest = manifestDigest(precache);

      this.emitFile({
        type: "asset",
        fileName,
        source: swSource({
          cacheName: `massingviewer-${digest}`,
          precache,
          crossOriginIsolation: isolate,
          shell: "index.html",
        }),
      });

      /**
       * The registration script is emitted as a **file**, never inlined into the HTML.
       *
       * Not a style preference. `docs/deployment.md` specifies `script-src 'self' 'wasm-unsafe-eval'` with no
       * `unsafe-inline`, so an inline `<script>` is blocked outright — and the E2E console-error guard caught
       * exactly that: *"Executing inline script violates the following Content Security Policy directive"*. The
       * worker then never registers, offline silently does not work, and nothing fails except in a console nobody
       * is watching. A hash or a nonce would also satisfy the CSP, but both have to be regenerated whenever the
       * script changes; a file needs neither.
       */
      this.emitFile({
        type: "asset",
        fileName: registerFileName,
        source: registrationSource({ swUrl: `./${fileName}`, crossOriginIsolation: isolate }),
      });
    },

    transformIndexHtml(html) {
      // Relative, matching `base: "./"` — the demo is served from a repository subpath on Pages, and an absolute
      // "/sw-register.js" would 404 there and register nothing. That failure is silent, because registration
      // errors are caught and warned rather than thrown.
      return html.replace("</body>", `<script type="module" src="./${registerFileName}"></script>\n</body>`);
    },
  };
}
