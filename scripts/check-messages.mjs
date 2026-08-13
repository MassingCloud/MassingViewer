/**
 * Message gate — the checks a catalogue needs that neither the compiler nor a unit test can make.
 *
 * TypeScript already does a great deal here: `MessageKey` is `keyof typeof EN`, so a typo in a `t()` call and a
 * stale key in a translation are both compile errors. What it cannot see:
 *
 *   1. **Plural completeness per locale.** A locale's plural categories come from CLDR at runtime, so `MessageKey`
 *      cannot know that Polish needs `few` and `many` where English needs neither. A missing category silently
 *      renders the `other` form — grammatically wrong in a way no English-speaking reviewer will notice.
 *   2. **Orphan keys.** A message nothing looks up costs a translator real effort for no user-visible result, and
 *      the compiler is perfectly happy with it.
 *   3. **The tool catalogue tracking the tool table.** A tool added upstream arrives with an English label and no
 *      catalogue entry, so it silently stops being translatable. `everyToolMapped()` catches a tool with no ribbon
 *      home; nothing caught a tool with no message key.
 *
 * The third is the one that would actually rot. The other two are cheap insurance.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const notes = [];

/**
 * Refuse to check a build older than the source it was built from.
 *
 * This gate reads `dist`, not `src`, because it needs the evaluated tables rather than a parse of TypeScript. That
 * is fine right up until `dist` is stale, and then every number below describes a different tree — which is exactly
 * what happened while eight tools were being added: the gate reported "99 keys, de 100%" against a 33-tool build
 * while the source had 41 tools and twenty untranslated keys. It passed, twice, on yesterday's answer.
 *
 * CI builds immediately before running gates, so this only ever bites locally — which is precisely where someone
 * decides whether a green gate means anything. `scripts/bundle-budget.mjs` carries the same guard for the same
 * reason, discovered the same way.
 */
function assertFresh(pkg) {
  const src = join(root, "packages", pkg, "src");
  const dist = join(root, "packages", pkg, "dist");
  if (!existsSync(dist)) {
    problems.push(`packages/${pkg}/dist does not exist — run \`npm run build\` first.`);
    return;
  }
  const newest = (dir) => {
    let latest = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      latest = Math.max(latest, entry.isDirectory() ? newest(full) : statSync(full).mtimeMs);
    }
    return latest;
  };
  if (newest(src) > newest(dist)) {
    problems.push(
      `packages/${pkg}/dist is older than its src. Every count below would describe a different tree.\n` +
        `          Run: npm run build`,
    );
  }
}
assertFresh("ui-model");
assertFresh("i18n");
if (problems.length > 0) {
  console.error(`\nMessage gate failed — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}

const { EN, DE } = await import(`file://${join(root, "packages/i18n/dist/index.js")}`);
const { TOOLS } = await import(`file://${join(root, "packages/ui-model/dist/toolbarLayout.js")}`);
const { toolId, TABS, buildRibbon } = await import(`file://${join(root, "packages/ui-model/dist/ribbon.js")}`);

const keys = Object.keys(EN);

// --- 1. every tool, tab and group has a key, and every tool key has a tool -------------------------
const expected = new Set();
for (const tab of TABS) expected.add(`tab.${tab.id}`);
for (const group of buildRibbon()) expected.add(`group.${group.id}`);
for (const tool of TOOLS) {
  expected.add(`tool.${toolId(tool.title)}.label`);
  expected.add(`tool.${toolId(tool.title)}.title`);
}

for (const key of expected) {
  if (!Object.hasOwn(EN, key)) {
    problems.push(
      `EN is missing "${key}". A tool, tab or group exists in @massing/ui-model with no message key, so it ` +
        `renders its English literal forever and no translator can reach it.`,
    );
  }
}

// The other direction. A key for a tool that no longer exists is dead weight a translator still pays for.
for (const key of keys) {
  if (!/^(?:tool|tab|group)\./.test(key)) continue;
  if (!expected.has(key)) {
    problems.push(`EN has "${key}" but @massing/ui-model has no such tool, tab or group — remove the stale key.`);
  }
}

// --- 2. plural completeness, per locale ------------------------------------------------------------
/**
 * Plural bases: a key with `.one`/`.other`/… suffixes. English needs `one` and `other`; another locale needs
 * whatever CLDR says, which is why this asks `Intl` rather than assuming.
 */
const PLURAL_CATEGORIES = new Set(["zero", "one", "two", "few", "many", "other"]);
const bases = new Map();
for (const key of keys) {
  const dot = key.lastIndexOf(".");
  if (dot < 0) continue;
  const suffix = key.slice(dot + 1);
  if (!PLURAL_CATEGORIES.has(suffix)) continue;
  const base = key.slice(0, dot);
  if (!bases.has(base)) bases.set(base, new Set());
  bases.get(base).add(suffix);
}

const LOCALES = { en: EN, de: DE };
for (const [locale, catalogue] of Object.entries(LOCALES)) {
  const needed = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  for (const base of bases.keys()) {
    // A locale that has not started this message at all is a translation gap, not a plural bug — reported by
    // `Translator.missing()` and recorded in docs/i18n.md, not here. Only a *partially* pluralised message is
    // this gate's business: that is the one that renders the wrong grammar while looking done.
    const started = needed.some((c) => Object.hasOwn(catalogue, `${base}.${c}`));
    if (!started) continue;
    for (const category of needed) {
      if (!Object.hasOwn(catalogue, `${base}.${category}`)) {
        problems.push(
          `${locale}: "${base}" has some plural forms but not ".${category}", which ${locale} requires ` +
            `(${needed.join("/")}). It will silently render the wrong grammar.`,
        );
      }
    }
  }
  if (locale === "en") {
    for (const [base, has] of bases) {
      if (!has.has("other")) {
        problems.push(`EN: "${base}" has no ".other" form, which is the fallback every other locale relies on.`);
      }
    }
  }
}

// --- 3. orphan keys: defined and never looked up ---------------------------------------------------
/** Every `.ts` under `packages/` and `apps/`, excluding the catalogues themselves and build output. */
function sources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const files = [...sources(join(root, "packages")), ...sources(join(root, "apps"))].filter(
  (f) => !f.includes(join("i18n", "src")),
);
const corpus = files.map((f) => readFileSync(f, "utf8")).join("\n");

const usedLiterally = (key) => corpus.includes(`"${key}"`) || corpus.includes(`'${key}'`);

for (const key of keys) {
  // Three ways a key is legitimately reached, and each needs its own check or the gate becomes noise nobody reads:
  //
  //  - **Literally** — `t("ribbon.armed")`.
  //  - **From a template** — `tool.${item.id}.label`. The prefix is the only thing a text search can see; without
  //    this, all sixty tool keys report as orphans.
  //  - **Via a plural base** — `plural("count.elements", n)` reaches `count.elements.one` and `.other`, and
  //    neither suffixed form ever appears in the source. Checking the base is what makes the categories visible.
  const dot = key.lastIndexOf(".");
  const base = dot < 0 ? null : key.slice(0, dot);
  const viaPlural = base !== null && bases.has(base) && usedLiterally(base);

  if (!usedLiterally(key) && !/^(?:tool|tab|group)\./.test(key) && !viaPlural) {
    problems.push(`EN defines "${key}" and nothing looks it up. Remove it, or wire it up.`);
  }
}

// --- reporting ------------------------------------------------------------------------------------
// Translation coverage is printed, never gated. A gate on completeness would mean either blocking a release on a
// language's last string or committing machine output to turn the number green — and the second is worse than the
// gap, because it reads as reviewed and nobody looks again. docs/i18n.md carries the same numbers in prose.

/**
 * Locales a native-speaker has actually reviewed.
 *
 * Exists because **coverage and correctness are different facts, and a bare 100% conflates them.** German reached
 * complete written by a developer; printing `de: 99/99 (100%) translated` and stopping there would retire the one
 * signal that used to say "somebody still needs to look at this" — the argument `de.ts` itself makes about why a
 * gap can be better than a filled-in catalogue.
 *
 * A locale joins this set in the same commit as a reviewer's corrections, which makes the claim traceable to a
 * diff rather than to a memory. English is here because it is the source, not because it was reviewed.
 */
const REVIEWED = new Set(["en"]);

for (const [locale, catalogue] of Object.entries(LOCALES)) {
  if (locale === "en") continue;
  const done = keys.filter((k) => Object.hasOwn(catalogue, k)).length;
  const status = REVIEWED.has(locale) ? "native-reviewed" : "not native-reviewed";
  notes.push(`${locale}: ${done}/${keys.length} (${Math.round((100 * done) / keys.length)}%) translated, ${status}`);
}

if (problems.length > 0) {
  console.error(`Message gate failed — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}

console.log(`Message gate passed: ${keys.length} key(s), ${bases.size} pluralised, ${Object.keys(LOCALES).length} locale(s).`);
for (const n of notes) console.log(`  ${n}`);
