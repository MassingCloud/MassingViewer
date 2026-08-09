/**
 * The translator.
 *
 * ## Why this is a package and not a dependency
 *
 * The whole surface is a lookup, an interpolation and a plural rule. `Intl.PluralRules` — in every browser this
 * project supports — does the only genuinely hard part, which is knowing that Polish has four plural categories
 * and Japanese has one. What remains is small enough that a runtime i18n library would be more bytes of adapter
 * than of value, in a bundle with per-package budgets.
 *
 * ## Why keys, rather than English strings as keys
 *
 * The tempting shortcut is `t("Draw a wall")`, with English doubling as the key. It fails on the second sentence
 * that needs different translations of one English phrase, and it makes every copy edit a silent
 * re-translation-required event that no tool can detect. Keys are opaque and stable; `MessageKey` is a union
 * derived from the English catalogue, so a typo is a compile error rather than a string that renders as itself.
 */

import { EN, type MessageKey } from "./en.js";

export type { MessageKey };

/**
 * A catalogue for one locale. Partial on purpose — a translation in progress is the normal state of a catalogue,
 * and requiring completeness would mean either blocking a language on its last string or committing machine
 * output as if it were reviewed.
 */
export type Catalogue = Partial<Record<MessageKey, string>>;

/** Values interpolated into `{placeholder}` slots. */
export type MessageParams = Readonly<Record<string, string | number>>;

/**
 * A plural *base* — a key like `count.elements`, whose catalogue entries are `count.elements.one` and
 * `count.elements.other`.
 *
 * Derived rather than declared, and it exists because typing `plural()` as `MessageKey` was wrong: the base is not
 * itself a key, so `plural("count.elements", n)` failed to compile at the first real call site. Widening the
 * parameter to `string` would have "fixed" it by removing the only check that matters. Extracting the bases from
 * the `.other` forms keeps a typo in a plural call a compile error, and `.other` is the right anchor because it is
 * the one category every locale has — which is also why the message gate requires it.
 */
export type PluralKey = MessageKey extends infer K ? (K extends `${infer Base}.other` ? Base : never) : never;

export interface Translator {
  /** Look up a key, interpolate, and fall back to English when the locale has no entry. */
  t(key: MessageKey, params?: MessageParams): string;
  /**
   * Plural form. `key` is the base; the catalogue holds `key.one`, `key.other`, and whichever of `zero`, `two`,
   * `few` and `many` the locale actually uses.
   */
  plural(key: PluralKey, count: number, params?: MessageParams): string;
  /** Format a number for display. Locale-aware, unlike anything that parses the command grammar. */
  number(value: number, options?: Intl.NumberFormatOptions): string;
  readonly locale: string;
  /**
   * Keys asked for that the catalogue could not supply, in insertion order.
   *
   * Exposed rather than logged, so a test can assert a screen is fully translated and the answer is data. The
   * alternative — noticing untranslated text by looking at it — does not scale past one language.
   */
  missing(): readonly MessageKey[];
}

/**
 * Interpolate `{name}` slots.
 *
 * An unknown placeholder is left verbatim rather than replaced with "undefined". A message reading
 * "Deleted {count} elements" is obviously a bug to whoever sees it; "Deleted undefined elements" reads like a
 * data problem and sends the reader to the wrong place.
 */
function interpolate(template: string, params: MessageParams | undefined): string {
  if (params === undefined) return template;
  return template.replaceAll(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  );
}

export interface TranslatorOptions {
  readonly locale?: string;
  readonly catalogue?: Catalogue;
}

export function createTranslator(options: TranslatorOptions = {}): Translator {
  const locale = options.locale ?? "en";
  const catalogue = options.catalogue ?? {};
  const missing: MessageKey[] = [];
  // Constructed once. `Intl.PluralRules` is not cheap to build and this runs per rendered row.
  const rules = new Intl.PluralRules(locale);
  const numbers = new Intl.NumberFormat(locale);

  const lookup = (key: MessageKey): string | undefined => {
    const own = catalogue[key];
    if (own !== undefined) return own;
    const english = EN[key];
    // Recorded even when English answers, because "English was used" is exactly the fact a completeness check
    // needs. Only a key absent from *both* is a hard error, and that one is unreachable through `MessageKey`.
    if (locale !== "en") missing.push(key);
    return english;
  };

  return {
    locale,

    t(key, params) {
      const template = lookup(key);
      // Falling back to the key itself rather than throwing. A missing string must degrade to something a user can
      // still act on — an untranslated label beats a blank ribbon or a crashed panel.
      return interpolate(template ?? key, params);
    },

    plural(key: PluralKey, count, params) {
      const category = rules.select(count);
      // `${key}.${category}` is a runtime-constructed key, so it is outside the `MessageKey` union by
      // construction. The cast is confined to this one line, and `scripts/check-messages.mjs` is what actually
      // checks that every plural base has the categories its locale needs.
      const specific = `${key}.${category}` as MessageKey;
      const template =
        catalogue[specific] ?? EN[specific] ?? catalogue[`${key}.other` as MessageKey] ?? EN[`${key}.other` as MessageKey];
      if (template === undefined) {
        missing.push(specific);
        return interpolate(key, { ...params, count });
      }
      return interpolate(template, { ...params, count: numbers.format(count) });
    },

    number(value, numberOptions) {
      return numberOptions === undefined
        ? numbers.format(value)
        : new Intl.NumberFormat(locale, numberOptions).format(value);
    },

    missing() {
      return missing;
    },
  };
}

/** The English translator. Its `missing()` is always empty, because `MessageKey` is derived from its catalogue. */
export const EN_TRANSLATOR: Translator = createTranslator({ locale: "en", catalogue: EN });
