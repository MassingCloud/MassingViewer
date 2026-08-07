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
  const styles = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => m[1]);
  return { scripts, styles };
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

  // Total output, so a lazy chunk ballooning is visible even though it is not in the entry.
  let total = 0;
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const f = join(d, e);
      if (statSync(f).isDirectory()) walk(f);
      else if (/\.(js|css)$/.test(e)) total += brotliKB(readFileSync(f));
    }
  };
  walk(dir);

  measured[target.name] = {
    entryJs: +js.toFixed(1),
    entryCss: +css.toFixed(1),
    totalJsCss: +total.toFixed(1),
  };

  const budget = budgets[target.name];
  console.log(`${target.name}`);
  for (const r of resolved) console.log(`  ${r.rel.padEnd(34)} ${r.kb.toFixed(1)} KB br`);
  console.log(`  ${"entry JS".padEnd(34)} ${js.toFixed(1)} KB br${budget ? ` (budget ${budget.entryJs})` : ""}`);
  console.log(`  ${"entry CSS".padEnd(34)} ${css.toFixed(1)} KB br${budget ? ` (budget ${budget.entryCss})` : ""}`);
  console.log(`  ${"total JS+CSS".padEnd(34)} ${total.toFixed(1)} KB br${budget ? ` (budget ${budget.totalJsCss})` : ""}`);

  if (budget) {
    for (const key of ["entryJs", "entryCss", "totalJsCss"]) {
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
  writeFileSync(BUDGETS_PATH, `${JSON.stringify(measured, null, 2)}\n`, "utf8");
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
