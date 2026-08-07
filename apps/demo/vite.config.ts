import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { defineConfig } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Resolve `@massingviewer/*` to package SOURCE, not built `dist/`.
 *
 * Without this, `npm run dev` on a fresh clone fails with `Failed to resolve import "@massingviewer/core"`,
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
function workspaceAliases(): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const name of readdirSync(join(ROOT, "packages"))) {
    const entry = join(ROOT, "packages", name, "src", "index.ts");
    if (existsSync(entry)) aliases[`@massingviewer/${name}`] = entry;
  }
  return aliases;
}

export default defineConfig({
  resolve: { alias: workspaceAliases() },
  // Relative base so the built demo works from a subpath (GitHub Pages) without a rebuild.
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, target: "es2023" },
  server: { port: 5173, open: false },
  // The fixture is imported as a raw string via `?raw`, so it is inlined at build time and the demo makes
  // ZERO network requests after first paint — which is the property M1 is supposed to demonstrate.
  assetsInclude: ["**/*.ifc"],
});
