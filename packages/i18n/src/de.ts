import type { Catalogue } from "./translate.js";

/**
 * German. **Partial, and deliberately so.**
 *
 * ## Why a second catalogue exists at all
 *
 * A single-locale i18n framework is untested i18n. Every mistake that matters — a concatenated sentence, a
 * hardcoded plural, a string baked into a `data-` attribute, a layout that assumes English word length — is
 * invisible until a second language is rendered through the same code. German is the right first one here for two
 * specific reasons rather than for coverage:
 *
 * 1. **It is a decimal-comma locale**, so it exercises the ambiguity ADR-0011 is about with a real audience rather
 *    than a hypothetical one.
 * 2. **Its compounds are long.** "Geschossebenen einblenden" against "Levels" is the width pressure that finds a
 *    ribbon which silently drops a control — the failure class `railToolbox.test.ts` was written about.
 *
 * ## Why it is partial rather than complete
 *
 * The entries below are the ribbon chrome, the capability refusals and the tool labels — the strings a German
 * drafter sees on the first screen. The remainder falls back to English, which `Translator.missing()` reports as
 * data so a test can assert exactly how far the translation reaches.
 *
 * Filling the rest with machine output would be worse than the gap: it would read as reviewed, the completeness
 * check would go green, and nobody would ever look again. A visible gap gets closed; a plausible wrong translation
 * does not.
 *
 * These were written by a developer, not a native-speaker reviewer, and that is recorded in `docs/i18n.md` under
 * what is not done. Terminology in particular ("Bauteil" vs "Element") wants a drafter's eye.
 */
export const DE: Catalogue = {
  // --- ribbon tabs ---
  "tab.home": "Start",
  "tab.build": "Bauen",
  "tab.insert": "Einfügen",
  "tab.annotate": "Beschriften",
  "tab.sheet": "Plan",
  "tab.analyse": "Analysieren",
  "tab.review": "Prüfen",
  "tab.view": "Ansicht",
  "tab.manage": "Verwalten",

  // --- ribbon chrome ---
  "ribbon.label": "Multifunktionsleiste",
  "ribbon.more": "{group} — mehr",
  "ribbon.armed": "{tool} aktiviert",
  "ribbon.unavailable": "nicht verfügbar",

  // --- capability refusals. Required to carry a reason, in every language.
  "availability.needsEdit": "Erfordert die Rolle „Bearbeiten“ in diesem Projekt",
  "availability.needsSelection": "Zuerst ein Element auswählen",

  // --- counts. German pluralises like English (one/other), so these two suffice; Polish would need four,
  // which is exactly what the message gate checks per locale rather than assuming.
  "count.elements.one": "{count} Element",
  "count.elements.other": "{count} Elemente",
  "count.topics.one": "{count} Vorgang",
  "count.topics.other": "{count} Vorgänge",

  // --- a sample of tool labels. The long compounds here are the width pressure the ribbon has to survive.
  "tool.toggle-storey-levels-overlay.label": "Ebenen",
  "tool.toggle-storey-levels-overlay.title": "Geschossebenen einblenden",
  "tool.show-all-h.label": "Alle zeigen",
  "tool.show-all-h.title": "Alle zeigen (H)",
  "tool.isolate-selection.label": "Isolieren",
  "tool.isolate-selection.title": "Auswahl isolieren",
};
