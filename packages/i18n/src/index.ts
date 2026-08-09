/**
 * `@massing/i18n` — message catalogues, plural rules, and locale-aware number *formatting*.
 *
 * The plan puts i18n in M7 rather than after it, with a reason: *"retrofitting i18n is the most expensive
 * deferred decision at this size."* It shipped without it, so this closes that.
 *
 * **The line this package draws, and it is the important part.** Formatting is locale-aware; the CAD command
 * grammar is not. `t()` and `number()` respect the user's locale. `parseCadCommand` does not, because a command
 * invocation is serialisable by design — that is what makes macros, the audit log and replay work — and a
 * locale-dependent parser would make a recorded `WALL 0,0 3,5` mean different geometry for a German colleague
 * than for an American one. That is a data-corruption bug wearing an i18n hat.
 *
 * The genuine ambiguity — `3,5` as the point (3, 5) or the number 3.5 — is resolved with an explicit `;`
 * separator rather than a locale setting. See `docs/adr/0011-decimal-comma-and-the-coordinate-grammar.md`, and
 * `docs/i18n.md` for what is translated so far and what is not.
 */

export { DE } from "./de.js";
export { EN, type MessageKey } from "./en.js";
export {
  createTranslator,
  EN_TRANSLATOR,
  type Catalogue,
  type MessageParams,
  type PluralKey,
  type Translator,
  type TranslatorOptions,
} from "./translate.js";
