/**
 * Bundle budget gate.
 *
 * ## The lesson carried over from massing, which is the whole reason this is not three lines
 *
 * massing's version parses the entry filename **out of `index.html`** rather than filename-matching
 * `index-*.js` in the output directory. That looks like over-engineering until you hit the case it exists for:
 * a lazily-loaded vendor chunk whose hashed name also begins with `index-` gets counted as shell, the number
 * jumps for no reason anyone can explain, and the usual response is to raise the budget.
 *
 * A budget that gets raised whenever it fires is not a budget. So the entry is identified the way the browser
 * identifies it — by reading the `<script src>` the HTML actually loads.
 *
 * ## Why brotli
 *
 * Every CDN and every serious host serves brotli, so raw or gzip size overstates what a user waits for. Gating
 * on the number the user actually experiences avoids both false alarms and false comfort.
 */

import { brotliCompressSync, constants } from "node:zlib";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const UPDATE = process.argv.includes("--update");
const BUDGETS_PATH = join(ROOT, "scripts", "bundle-budgets.json");

/**
 * Budgets in KB brotli, as a **ratchet**: recorded from a real build and allowed a small tolerance for
 * compression noise. Guessed numbers are worse than none — too high and the gate never fires, too low and it
 * blocks work for no reason.
 */
const TOLERANCE = 1.08; // 8% headroom, so a dependency patch bump does not fail the build

/**
 * Directories whose contents, if newer than the build, mean the build is not of this source tree.
 *
 * Added after this gate did both of the two things a stale measurement can do, in one sitting. It reported a **30 KB
 * regression that did not exist** — a leftover entry chunk from an earlier build was still in `dist`, so the total
 * counted two entries — and then, after the directory was cleaned, it reported a **passing number for a bundle built
 * from different source**, because it never builds and simply measures whatever is on disk.
 *
 * The false pass is the dangerous one: the gate exists to catch growth, and a gate that silently measures yesterday's
 * output cannot. CI happens to build immediately beforehand, so this only ever bites locally — which is exactly where
 * someone decides whether a number is worth investigating.
 */
const SOURCES = ["apps/demo/src", "packages"];

/** Newest mtime under a directory, skipping `node_modules` and `dist` — build outputs are not inputs. */
function newestMtime(dir) {
  let newest = 0;
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else newest = Math.max(newest, statSync(full).mtimeMs);
    }
  };
  if (existsSync(dir)) walk(dir);
  return newest;
}

const targets = [
  {
    name: "demo shell",
    dir: "apps/demo/dist",
    html: "apps/demo/dist/index.html",
    note:
      "The whole walking skeleton: three.js + the viewport + the IFC tessellator. three is the bulk of it and " +
      "is not code-split yet, which is the obvious first optimisation when this starts to hurt.",
  },
];

function brotliKB(bytes) {
  const out = brotliCompressSync(bytes, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  });
  return out.byteLength / 1024;
}

/** The entry script the HTML actually loads — not whatever file happens to be named `index-*.js`. */
function entryFromHtml(htmlPath) {
  const html = readFileSync(htmlPath, "utf8");
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  /**
   * `modulepreload` counts as part of the entry, and missing it was a real hole.
   *
   * Found 2026-08-10 by the WebGPU renderer. A dynamic `import("three/webgpu")` made Rollup split `three` into a
   * shared `three.core` chunk, which `index.html` then references as `<link rel="modulepreload">` rather than as a
   * `<script src>`. The browser fetches it on first load — it is not optional and not lazy — but this function only
   * looked at `src` and stylesheets, so **entry JS fell from ~165 KB to 116 KB while first-load cost went up.**
   *
   * A budget that improves when the thing it measures gets worse is worse than no budget. This file's own header
   * already records the sibling lesson — parsing the entry out of the HTML rather than filename-matching, because a
   * hashed vendor chunk was once miscounted as shell — and this is the same mistake one layer along: trusting the
   * *shape* of the reference instead of asking what the browser actually loads.
   */
  const preloads = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)].map((m) => m[1]);
  const styles = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => m[1]);
  return { scripts: [...scripts, ...preloads], styles };
}

const problems = [];
const measured = {};
let budgets = {};
try {
  budgets = JSON.parse(readFileSync(BUDGETS_PATH, "utf8"));
} catch {
  /* first run — --update writes it */
}

for (const target of targets) {
  const dir = join(ROOT, target.dir);
  const html = join(ROOT, target.html);
  if (!existsSync(html)) {
    problems.push(`${target.name}: ${target.html} does not exist — run the build first`);
    continue;
  }

  // Refuse to measure a build older than the source it claims to be a build of. Reported as a problem rather than a
  // warning, because the whole output below would otherwise be a number about a different tree.
  const builtAt = statSync(html).mtimeMs;
  const sourceAt = Math.max(...SOURCES.map((s) => newestMtime(join(ROOT, s))));
  if (sourceAt > builtAt) {
    const age = Math.round((sourceAt - builtAt) / 1000);
    problems.push(
      `${target.name}: the build in ${target.dir} is ${age}s older than the sources it was built from.\n` +
        `          Every number below would describe a different tree. Run:\n` +
        `              npm run build --workspace @massing/demo`,
    );
    continue;
  }

  const { scripts, styles } = entryFromHtml(html);
  if (scripts.length === 0) {
    problems.push(`${target.name}: no <script src> in ${target.html}; cannot identify the entry`);
    continue;
  }

  let js = 0;
  let css = 0;
  const resolved = [];
  for (const src of [...scripts, ...styles]) {
    // Strip the base and any query, then resolve relative to the output directory.
    const rel = src.replace(/^\.?\//, "").split("?")[0];
    const file = join(dir, rel);
    if (!existsSync(file)) {
      problems.push(`${target.name}: ${target.html} loads "${src}" which is not in the build output`);
      continue;
    }
    const kb = brotliKB(readFileSync(file));
    resolved.push({ rel, kb });
    if (rel.endsWith(".css")) css += kb;
    else js += kb;
  }

  /**
   * Total output — so a lazy chunk ballooning is visible even though it is not in the entry — **minus chunks that
   * are mutually exclusive alternatives**, which get their own budget instead.
   *
   * Added 2026-08-10, when the WebGPU renderer landed. `three/webgpu` is imported dynamically precisely so a
   * WebGL-only visitor never downloads it, and that worked: entry JS stayed at 116 KB against a 150.7 budget. But
   * the *total* jumped 165 → 356 KB, because it summed both renderers — and **no visitor ever downloads both.**
   *
   * The tempting fix was `--update`, and it would have been the wrong one twice over: it is the reflexive
   * re-baselining this repository's risk register names, and it would have quietly redefined `totalJsCss` from
   * "what a visitor downloads" into "what exists on disk", leaving 190 KB of slack for real bloat to hide in.
   *
   * So alternates are partitioned out and budgeted separately. `totalJsCss` keeps meaning what it meant.
   */
  const alternatePatterns = (budgets[target.name]?.alternates ?? []).map((p) => new RegExp(p));
  let total = 0;
  let alternates = 0;
  /**
   * Root-level scripts that are not the bundler's, which means this directory holds two builds.
   *
   * Found on 2026-08-15: the apps' `tsconfig.json` emitted to `dist/`, the same directory Vite writes, so a root
   * `tsc --build` left `main.js`, `draft.js` and friends beside the bundle. This walk counted them, and reported
   * `totalJsCss` 251 KB against a 216.4 budget — a **false red**, locally only, because the CI job runs the Vite
   * build alone and never sees them.
   *
   * The collision is fixed at the source (`outDir` is `dist-tsc` now), so this is the guard against it returning,
   * and it fails rather than silently correcting: a number that quietly excludes files is how `totalJsCss` would
   * drift back into meaning "some of what a visitor downloads". `build-site.mjs` copies this directory into the
   * published site and `pages.yml` greps it for external URLs, so a second build living here is not only a
   * measurement problem.
   */
  const strays = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const f = join(d, e);
      if (statSync(f).isDirectory()) walk(f);
      else if (/\.(js|css)$/.test(e)) {
        // A root-level script the HTML does not reference, and that the bundler did not hash, is not ours.
        const isReferenced = resolved.some((r) => r.rel === e);
        if (d === dir && !isReferenced && !/-[A-Za-z0-9_]{8}\./.test(e) && e !== "sw.js") strays.push(e);
        const kb = brotliKB(readFileSync(f));
        if (alternatePatterns.some((re) => re.test(e))) alternates += kb;
        else total += kb;
      }
    }
  };
  walk(dir);
  if (strays.length > 0) {
    problems.push(
      `${target.name}: ${dir} holds ${strays.length} script(s) the bundler did not emit — ${strays.slice(0, 5).join(", ")}` +
        `${strays.length > 5 ? ", …" : ""}\n` +
        `          Two builds are writing to one directory, so this budget is measuring compiler output as shipped bytes.\n` +
        `          Check the app's tsconfig \`outDir\`; it must not be the bundler's.`,
    );
  }

  measured[target.name] = {
    entryJs: +js.toFixed(1),
    entryCss: +css.toFixed(1),
    totalJsCss: +total.toFixed(1),
    ...(alternatePatterns.length > 0 ? { alternatesJs: +alternates.toFixed(1) } : {}),
  };

  const budget = budgets[target.name];
  console.log(`${target.name}`);
  for (const r of resolved) console.log(`  ${r.rel.padEnd(34)} ${r.kb.toFixed(1)} KB br`);
  console.log(`  ${"entry JS".padEnd(34)} ${js.toFixed(1)} KB br${budget ? ` (budget ${budget.entryJs})` : ""}`);
  console.log(`  ${"entry CSS".padEnd(34)} ${css.toFixed(1)} KB br${budget ? ` (budget ${budget.entryCss})` : ""}`);
  console.log(`  ${"total JS+CSS".padEnd(34)} ${total.toFixed(1)} KB br${budget ? ` (budget ${budget.totalJsCss})` : ""}`);
  if (alternatePatterns.length > 0) {
    console.log(
      `  ${"mutually-exclusive alternates".padEnd(34)} ${alternates.toFixed(1)} KB br` +
        `${budget?.alternatesJs ? ` (budget ${budget.alternatesJs})` : ""}  — never downloaded alongside the above`,
    );
  }

  if (budget) {
    for (const key of ["entryJs", "entryCss", "totalJsCss", "alternatesJs"]) {
      if (budget[key] === undefined) continue;
      const limit = budget[key] * TOLERANCE;
      const actual = measured[target.name][key];
      if (actual > limit) {
        problems.push(
          `${target.name}: ${key} is ${actual} KB br, over the ${budget[key]} KB budget ` +
            `(+${Math.round(TOLERANCE * 100 - 100)}% tolerance = ${limit.toFixed(1)} KB).\n` +
            `          If this growth is intended, run: npm run gate:bundle -- --update`,
        );
      }
    }
  }
}

if (UPDATE) {
  const { writeFileSync } = await import("node:fs");
  /**
   * Merged, not replaced — because this file holds **configuration as well as measurements**.
   *
   * `alternates` is a list of patterns saying which chunks are mutually exclusive; it is a decision, not a number
   * this script can re-derive. The first version of `--update` wrote `measured` wholesale and silently deleted it,
   * which un-partitioned the WebGPU chunk and made the total jump straight back to 356 KB. A re-baseline command
   * that quietly discards configuration is a trap, and it discards it exactly when someone is already busy
   * reacting to a failure.
   */
  const merged = Object.fromEntries(
    Object.entries(measured).map(([name, numbers]) => [name, { ...budgets[name], ...numbers }]),
  );
  writeFileSync(BUDGETS_PATH, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  console.log(`\nwrote ${relative(ROOT, BUDGETS_PATH)}`);
} else if (Object.keys(budgets).length === 0) {
  console.log(`\nNo budgets recorded yet. Baseline them with: npm run gate:bundle -- --update`);
}

if (problems.length > 0) {
  console.error(`\nBundle budget failed — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  console.error("");
  process.exit(1);
}

console.log(`\nBundle budget passed.`);
