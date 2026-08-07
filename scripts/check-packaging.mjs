/**
 * Packaging gate — do the published entry points actually point at what the build produces?
 *
 * ## Why this exists, specifically
 *
 * The test run resolves `@massingviewer/*` to package **source** via a Vitest alias (see `vitest.config.ts`).
 * That fixed a real CI failure and stopped tests passing against stale `dist/`, but it opened a gap: nothing
 * exercises the `exports` field any more. A consumer running `npm i @massingviewer/core` resolves through
 * `exports`, and if that points somewhere the build never writes, the package is broken for everyone *except*
 * this repo — where the alias hides it.
 *
 * That is the worst kind of packaging bug: green CI, broken published artifact, and the only reporter is a
 * user. So the invariant is checked statically instead, which needs no build and runs in milliseconds.
 *
 * It cross-references three files that must agree and are edited independently:
 *   `package.json` (exports / main / types / files) x `tsconfig.json` (rootDir / outDir) x the source tree.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/**
 * Whether `files` ships a given path.
 *
 * npm's `files` semantics are prefix-based for directories, so `"src/ribbon.css"` is shipped by an entry of
 * `"src"`, `"src/"`, `"src/ribbon.css"`, or a glob. Deliberately conservative: it only reports a problem when it
 * can see that nothing covers the path, because a false accusation here blocks a release for no reason.
 */
function shipped(manifest, rel) {
  const files = manifest.files;
  if (!Array.isArray(files)) return true; // no `files` means npm ships everything not ignored
  return files.some((entry) => {
    const clean = String(entry).replace(/^\.\//, "").replace(/\/$/, "");
    if (clean === rel) return true;
    if (rel.startsWith(`${clean}/`)) return true;
    // A glob: compare the directory part only, which is enough to answer "is this tree included".
    if (clean.includes("*")) {
      const dir = clean.split("*")[0].replace(/\/$/, "");
      return dir === "" || rel.startsWith(dir);
    }
    return false;
  });
}

const problems = [];
let checked = 0;

const packagesDir = join(ROOT, "packages");
if (!existsSync(packagesDir)) {
  console.log("no packages/ directory yet — nothing to check");
  process.exit(0);
}

for (const name of readdirSync(packagesDir)) {
  const dir = join(packagesDir, name);
  if (!statSync(dir).isDirectory()) continue;
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) continue;

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.private === true) continue; // not published; nothing to promise
  checked++;

  const where = `packages/${name}/package.json`;
  const tsconfigPath = join(dir, "tsconfig.json");
  if (!existsSync(tsconfigPath)) {
    problems.push(`${where}: no tsconfig.json, so there is no build to point at`);
    continue;
  }
  // Strip comments — these tsconfigs carry explanatory ones, and JSON.parse rejects them.
  const tsconfigText = readFileSync(tsconfigPath, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
  let tsconfig;
  try {
    tsconfig = JSON.parse(tsconfigText);
  } catch (e) {
    problems.push(`packages/${name}/tsconfig.json: not parseable — ${e.message}`);
    continue;
  }

  const outDir = tsconfig.compilerOptions?.outDir;
  const rootDir = tsconfig.compilerOptions?.rootDir;
  if (!outDir || !rootDir) {
    problems.push(`packages/${name}/tsconfig.json: needs both rootDir and outDir to be predictable`);
    continue;
  }

  // The entry source file the build will compile into the entry output file.
  const entrySource = join(dir, rootDir, "index.ts");
  if (!existsSync(entrySource)) {
    problems.push(`packages/${name}: no ${rootDir}/index.ts, but the manifest advertises an entry point`);
  }

  /** Every path the manifest promises a consumer. */
  const promised = [];
  const collect = (value, label) => {
    if (typeof value === "string") promised.push({ path: value, label });
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) collect(v, `${label}.${k}`);
    }
  };
  collect(manifest.exports, "exports");
  collect(manifest.main, "main");
  collect(manifest.types, "types");

  if (promised.length === 0) {
    problems.push(`${where}: publishes nothing — no exports, main or types`);
  }

  for (const { path, label } of promised) {
    if (!path.startsWith("./")) {
      problems.push(`${where}: ${label} = "${path}" must be a relative path starting with "./"`);
      continue;
    }
    const rel = path.slice(2);

    /**
     * A static asset shipped verbatim is a different promise from a build output.
     *
     * `tsc` writes rootDir/**.ts -> outDir/**.{js,d.ts} and copies nothing else, so a stylesheet or a `.wasm`
     * cannot live in `dist` — but it also cannot go *stale*, because it is committed. What has to be true for
     * those is that the file exists and that `files` actually ships it; requiring them under `outDir` would push
     * a package into inventing a copy step for a file that was never generated.
     *
     * `@massingviewer/ribbon` is the case that found this: it exports `./ribbon.css` from `src`, which is correct
     * and which the original rule rejected. The rule was about JS entry points going missing; it was stated as a
     * rule about paths.
     */
    const isBuildOutput = /\.(js|mjs|cjs|d\.ts)$/.test(rel);
    if (!isBuildOutput) {
      if (!existsSync(join(packagesDir, name, rel))) {
        problems.push(`${where}: ${label} = "${path}" does not exist on disk, so consumers get a missing file`);
      } else if (!shipped(manifest, rel)) {
        problems.push(
          `${where}: ${label} = "${path}" exists but "files" does not include it, so it is absent from the tarball`,
        );
      }
      continue;
    }

    // The build writes rootDir/**.ts -> outDir/**.{js,d.ts}. Anything promised outside outDir will never
    // exist in the tarball.
    if (!rel.startsWith(`${outDir}/`)) {
      problems.push(
        `${where}: ${label} = "${path}" is outside outDir "${outDir}", so the build never writes it`,
      );
      continue;
    }
    const stem = rel.slice(outDir.length + 1).replace(/\.(js|d\.ts)$/, "");
    const source = join(dir, rootDir, `${stem}.ts`);
    if (!existsSync(source)) {
      problems.push(
        `${where}: ${label} = "${path}" implies ${rootDir}/${stem}.ts, which does not exist`,
      );
    }
  }

  // `files` decides the tarball contents. Omitting outDir ships a package with no code in it — and npm gives
  // no warning, because an empty-but-valid tarball is a legitimate thing to publish.
  const files = manifest.files;
  if (!Array.isArray(files) || files.length === 0) {
    problems.push(`${where}: no "files" array, so the tarball contents are whatever happens to be on disk`);
  } else if (!files.includes(outDir)) {
    problems.push(`${where}: "files" does not include "${outDir}" — the published package would contain no code`);
  }

  // A published package needs a license identifier for the license gate, and for anyone auditing us.
  if (manifest.license !== "MIT") {
    problems.push(`${where}: license must be "MIT" (got ${JSON.stringify(manifest.license)})`);
  }

  // npm provenance is how a consumer verifies the tarball came from this repo's CI rather than someone's
  // laptop. Cheap to set, and impossible to add retroactively to an already-published version.
  if (manifest.publishConfig?.provenance !== true) {
    problems.push(`${where}: publishConfig.provenance should be true`);
  }
  if (manifest.publishConfig?.access !== "public") {
    problems.push(`${where}: publishConfig.access should be "public" for a scoped package`);
  }

  // Workspace dependencies must be declared, or `npm i` on the published package resolves nothing.
  for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
    if (!dep.startsWith("@massingviewer/")) continue;
    const target = dep.slice("@massingviewer/".length);
    if (!existsSync(join(packagesDir, target, "package.json"))) {
      problems.push(`${where}: depends on ${dep}, which is not a package in this repo`);
    }
    if (typeof range !== "string" || range.length === 0) {
      problems.push(`${where}: dependency ${dep} has no version range`);
    }
  }
}

if (problems.length > 0) {
  console.error(`\nPackaging gate failed — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  console.error(
    `\n  These are checked statically because the test run resolves workspace packages to SOURCE via a\n` +
      `  Vitest alias. That is deliberate — it stopped tests passing against stale dist/ — but it means the\n` +
      `  published "exports" field is no longer exercised by any test. A broken entry point would show up\n` +
      `  only for consumers.\n`,
  );
  process.exit(1);
}

console.log(`Packaging gate passed: ${checked} published package(s), entry points consistent with their builds.`);
