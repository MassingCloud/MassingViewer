import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import react from "@vitejs/plugin-react";
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
function workspaceAliases(): { find: RegExp; replacement: string }[] {
  const aliases: { find: RegExp; replacement: string }[] = [];
  for (const name of readdirSync(join(ROOT, "packages"))) {
    const src = join(ROOT, "packages", name, "src");
    if (!existsSync(join(src, "index.ts"))) continue;
    // A **subpath** alias, and it must come first because Vite matches in order.
    //
    // The plain-string form of `alias` does prefix matching, so a single `@massingviewer/ribbon` entry rewrote
    // `@massingviewer/ribbon/ribbon.css` to `.../src/index.ts/ribbon.css` and the build failed with
    // "Could not load". Subpath exports are real — a stylesheet today, a worker entry tomorrow — so the mapping
    // has to handle them rather than assume every specifier is bare.
    aliases.push({
      find: new RegExp(`^@massingviewer/${name}/(.*)$`),
      replacement: `${src}/$1`,
    });
    // Anchored, so it matches the bare specifier exactly and cannot swallow a subpath.
    aliases.push({
      find: new RegExp(`^@massingviewer/${name}$`),
      replacement: join(src, "index.ts"),
    });
  }
  return aliases;
}

export default defineConfig({
  plugins: [react()],
  resolve: { alias: workspaceAliases() },
  // Relative base so the built demo works from a subpath (GitHub Pages) without a rebuild.
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, target: "es2023" },
  server: { port: 5173, open: false },
  // The fixture is imported as a raw string via `?raw`, so it is inlined at build time and the demo makes
  // ZERO network requests after first paint — which is the property M1 is supposed to demonstrate.
  assetsInclude: ["**/*.ifc"],
});
