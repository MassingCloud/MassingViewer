import { describe, expect, it } from "vitest";
import { DE } from "./de.js";
import { EN, type MessageKey } from "./en.js";
import { createTranslator, EN_TRANSLATOR, type Catalogue } from "./translate.js";

describe("lookup and fallback", () => {
  it("returns the locale's string when it has one", () => {
    const t = createTranslator({ locale: "de", catalogue: DE });
    expect(t.t("tab.home")).toBe("Start");
  });

  /**
   * A deliberately partial catalogue, rather than leaning on German's gaps.
   *
   * These two tests used to assert fallback through `DE`, picking a key German had not reached yet. That worked
   * and was a trap: **completing the German catalogue deleted the coverage silently.** Both tests went red when it
   * reached 100%, which was the lucky outcome — a test that asserted a *fallback happened* would instead have
   * quietly started asserting nothing while still passing.
   *
   * The behaviour under test belongs to `createTranslator`, not to any shipped locale's completeness, so the
   * fixture is built here and cannot be invalidated by translation work.
   */
  const PARTIAL = { "tab.home": "Начало" } as Catalogue;

  it("falls back to English rather than to blank", () => {
    const t = createTranslator({ locale: "bg", catalogue: PARTIAL });
    // An untranslated label beats an empty ribbon, and it is what makes shipping a partial catalogue safe — which
    // in turn is what makes a partial catalogue honest rather than a blocker.
    expect(t.t("tool.move-selected-element-e-n-z-metres.label")).toBe(
      EN["tool.move-selected-element-e-n-z-metres.label"],
    );
  });

  it("records what it fell back on, as data", () => {
    const t = createTranslator({ locale: "bg", catalogue: PARTIAL });
    t.t("tab.home");
    t.t("tool.move-selected-element-e-n-z-metres.label");
    // The point of `missing()`: a test can assert how far a translation reaches. Noticing untranslated text by
    // reading the screen does not scale past one language.
    expect(t.missing()).toEqual(["tool.move-selected-element-e-n-z-metres.label"]);
  });

  it("reports nothing missing for German either, now that it is complete", () => {
    const t = createTranslator({ locale: "de", catalogue: DE });
    for (const key of Object.keys(EN) as MessageKey[]) t.t(key);
    // The assertion the coverage percentage in `check-messages.mjs` prints, made here against the running
    // translator rather than against a key count — so a key present but empty would still be caught.
    expect(t.missing()).toEqual([]);
  });

  it("reports nothing missing for English", () => {
    for (const key of Object.keys(EN) as MessageKey[]) EN_TRANSLATOR.t(key);
    // Guaranteed by construction — `MessageKey` is `keyof typeof EN` — and asserted so the guarantee survives a
    // future change to how the union is derived.
    expect(EN_TRANSLATOR.missing()).toEqual([]);
  });
});

describe("interpolation", () => {
  it("substitutes named slots", () => {
    expect(EN_TRANSLATOR.t("ribbon.armed", { tool: "Wall" })).toBe("Wall armed");
  });

  it("leaves an unknown slot verbatim rather than writing undefined", () => {
    // "{tool} armed" is obviously a bug to whoever sees it. "undefined armed" reads like a data problem and sends
    // the reader to the wrong place entirely.
    expect(EN_TRANSLATOR.t("ribbon.armed")).toBe("{tool} armed");
    expect(EN_TRANSLATOR.t("ribbon.armed", { other: "x" })).toBe("{tool} armed");
  });

  it("interpolates the same slot in a translated string", () => {
    const t = createTranslator({ locale: "de", catalogue: DE });
    expect(t.t("ribbon.armed", { tool: "Wand" })).toBe("Wand aktiviert");
  });
});

describe("plurals", () => {
  it("selects one and other in English", () => {
    expect(EN_TRANSLATOR.plural("count.elements", 1)).toBe("1 element");
    expect(EN_TRANSLATOR.plural("count.elements", 6)).toBe("6 elements");
    // Zero takes `other` in English, which is the case a naive `count === 1 ? a : b` also gets right and a naive
    // `count > 1` does not.
    expect(EN_TRANSLATOR.plural("count.elements", 0)).toBe("0 elements");
  });

  it("selects German plurals from the German catalogue", () => {
    const t = createTranslator({ locale: "de", catalogue: DE });
    expect(t.plural("count.topics", 1)).toBe("1 Vorgang");
    expect(t.plural("count.topics", 3)).toBe("3 Vorgänge");
  });

  it("formats the interpolated count for the locale", () => {
    const t = createTranslator({ locale: "de", catalogue: DE });
    // 12.480, not 12,480 — the thousands separator is exactly the kind of detail a hand-rolled
    // `${count} Elemente` gets wrong, and it is why `plural` formats rather than concatenates.
    expect(t.plural("count.elements", 12_480)).toBe("12.480 Elemente");
  });

  it("uses a locale with more categories than English correctly", () => {
    // Polish has one/few/many/other. Nothing in this repo ships Polish, and that is the point: the plural
    // machinery must not be English-shaped, and the way to know is to run a locale English cannot imitate.
    const t = createTranslator({
      locale: "pl",
      catalogue: {
        "count.elements.one": "{count} element",
        "count.elements.few": "{count} elementy",
        "count.elements.many": "{count} elementów",
        "count.elements.other": "{count} elementu",
      },
    });
    expect(t.plural("count.elements", 1)).toBe("1 element");
    expect(t.plural("count.elements", 3)).toBe("3 elementy");
    expect(t.plural("count.elements", 25)).toBe("25 elementów");
  });

  it("falls back to `other` when a category is absent, rather than rendering the key", () => {
    const t = createTranslator({ locale: "pl", catalogue: { "count.elements.other": "{count} szt." } });
    // Degrades to a grammatically wrong string rather than to a visible key. Wrong grammar is a translation bug;
    // a bare `count.elements` on screen is a broken product.
    expect(t.plural("count.elements", 3)).toBe("3 szt.");
  });
});

describe("number formatting is locale-aware, unlike the command grammar", () => {
  it("uses the locale's separators", () => {
    expect(createTranslator({ locale: "en" }).number(1234.5)).toBe("1,234.5");
    expect(createTranslator({ locale: "de" }).number(1234.5)).toBe("1.234,5");
  });

  it("takes Intl options through", () => {
    const t = createTranslator({ locale: "de" });
    // U+00A0, a non-breaking space before the sign — not the ASCII space an English-shaped assertion would
    // write, and not nothing, which is what English does. Asserted on the exact code point deliberately: this is
    // precisely the difference a hand-rolled `${n}%` gets wrong, and matching loosely would hide the reason
    // `Intl` is doing the work at all.
    expect(t.number(0.412, { style: "percent", maximumFractionDigits: 0 })).toBe("41 %");
  });
});

describe("the German catalogue", () => {
  it("only contains keys the English catalogue defines", () => {
    // A stale key is invisible: it never renders, so nobody notices the string it was meant to replace is now
    // English. Typed as `Catalogue` (`Partial<Record<MessageKey, …>>`) so this is a compile error too — asserted
    // as well, because the check must survive someone loosening that type.
    const unknown = Object.keys(DE).filter((k) => !Object.hasOwn(EN, k));
    expect(unknown, "these German keys do not exist in the English catalogue").toEqual([]);
  });

  it("keeps every interpolation slot its English original has", () => {
    // The failure this catches is a dropped `{op}`: the sentence still reads well and silently stops naming the
    // operation it is about, which is the whole information content of a refusal message.
    const slots = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
    const mismatched: string[] = [];
    for (const [key, german] of Object.entries(DE)) {
      const english = EN[key as MessageKey];
      if (english === undefined) continue;
      if (slots(german!).join() !== slots(english).join()) mismatched.push(key);
    }
    expect(mismatched, "translated strings whose placeholders differ from the English").toEqual([]);
  });

  it("translates every capability refusal, because a reason is required in every language", () => {
    // `availability()` returns a *required* reason. A refusal that falls back to English in a German UI is the one
    // fallback that undermines the feature it belongs to — the dimmed control exists to teach, and it can only
    // teach in a language the reader has.
    const refusals = (Object.keys(EN) as MessageKey[]).filter((k) => k.startsWith("availability."));
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals.filter((k) => DE[k] === undefined)).toEqual([]);
  });
});
