import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { defineConfig } from "vite";
/**
 * Imported from **source**, by relative path, and that is not a style choice.
 *
 * `@massing/pwa/vite` resolves through the package's `exports` to `packages/pwa/dist/vite.js`. A config file's own
 * imports are resolved by Node *before* Vite exists, so the `workspaceAliases()` below — which exists precisely to
 * keep everything else off `dist/` — cannot cover this line. The bare specifier therefore made loading this config
 * depend on `tsc --build` having already run.
 *
 * That broke **three workflows on a clean checkout at once**, and none of them locally: `pages.yml` (the demo
 * build), all six legs of `e2e.yml` (the server could not start), and `ci.yml`'s gates job. Every one of them ran
 * `npm ci` and then used this config; on a developer machine a previous `npm run verify` had always left `dist/`
 * lying around. It is the exact failure `vitest.config.ts` documents for the same reason — *"CI fails and local
 * passes… because a previous `tsc --build` had left `dist/` there"* — and it recurred here because that lesson was
 * applied to module resolution inside the build and not to the config that configures it.
 *
 * A relative source import removes the ordering requirement rather than documenting it. Nothing needs to be built
 * before the demo can be served, which is what `npm run dev` on a fresh clone already assumed.
 */
import { massingPwa } from "../../packages/pwa/src/vite.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Resolve `@massing/*` to package SOURCE, not built `dist/`.
 *
 * Without this, `npm run dev` on a fresh clone fails with `Failed to resolve import "@massing/core"`,
 * because each package's `exports` points at `./dist/index.js` and nothing has been built yet. The README's
 * `npm install && npm run dev` quick-start was therefore false on a clean checkout — and the error names the
 * import rather than the missing build, so the fix is not obvious from the message.
 *
 * The same class of bug hit the Vitest run in CI (see the alias in `vitest.config.ts`). Worth noting they were
 * *separate* instances: the test runner and the dev server are different consumers of the same broken
 * assumption, and fixing one did nothing for the other.
 *
 * Two further benefits beyond making it work: HMR now applies to package sources, so editing
 * `packages/viewport` live-reloads the demo; and dev and build resolve identically, which removes a class of
 * "works in dev, broken in the bundle" difference.
 */
function workspaceAliases(): { find: RegExp; replacement: string }[] {
  const aliases: { find: RegExp; replacement: string }[] = [];
  for (const name of readdirSync(join(ROOT, "packages"))) {
    const src = join(ROOT, "packages", name, "src");
    if (!existsSync(join(src, "index.ts"))) continue;
    // A **subpath** alias, and it must come first because Vite matches in order.
    //
    // The plain-string form of `alias` does prefix matching, so a single `@massing/ribbon` entry rewrote
    // `@massing/ribbon/ribbon.css` to `.../src/index.ts/ribbon.css` and the build failed with
    // "Could not load". Subpath exports are real — a stylesheet today, a worker entry tomorrow — so the mapping
    // has to handle them rather than assume every specifier is bare.
    aliases.push({
      find: new RegExp(`^@massing/${name}/(.*)$`),
      replacement: `${src}/$1`,
    });
    // Anchored, so it matches the bare specifier exactly and cannot swallow a subpath.
    aliases.push({
      find: new RegExp(`^@massing/${name}$`),
      replacement: join(src, "index.ts"),
    });
  }
  return aliases;
}

export default defineConfig({
  /**
   * The offline service worker.
   *
   * `crossOriginIsolation` is left off. Nothing here needs `SharedArrayBuffer` — no `@thatopen/fragments`, no
   * `web-ifc`, no `Atomics`; ADR-0010 records why, and COEP `require-corp` would break cross-origin subresources
   * for no gain. Until now "works offline" survived a session but not a reload, because index.html and the bundle
   * were never cached; that is what this fixes, and it is the demo's headline claim.
   */
  plugins: [massingPwa()],
  resolve: { alias: workspaceAliases() },
  // Relative base so the built demo works from a subpath (GitHub Pages) without a rebuild.
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, target: "es2023" },
  // The port comes from the environment, defaulting to 5173. Hardcoded, the dev server cannot start at all when
  // another process already holds that port — and "port in use" is a needlessly hard stop for something that has
  // no reason to care which port it gets.
  server: { port: Number(process.env.PORT ?? 5173), open: false },
  // The fixture is imported as a raw string via `?raw`, so it is inlined at build time and the demo makes
  // ZERO network requests after first paint — which is the property M1 is supposed to demonstrate.
  assetsInclude: ["**/*.ifc"],
});
