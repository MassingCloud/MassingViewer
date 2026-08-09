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

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const notes = [];

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
// gap, because it reads as reviewed and nobody looks again. docs/i18n.md carries the same number in prose.
for (const [locale, catalogue] of Object.entries(LOCALES)) {
  if (locale === "en") continue;
  const done = keys.filter((k) => Object.hasOwn(catalogue, k)).length;
  notes.push(`${locale}: ${done}/${keys.length} (${Math.round((100 * done) / keys.length)}%) translated`);
}

if (problems.length > 0) {
  console.error(`Message gate failed — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}

console.log(`Message gate passed: ${keys.length} key(s), ${bases.size} pluralised, ${Object.keys(LOCALES).length} locale(s).`);
for (const n of notes) console.log(`  ${n}`);
