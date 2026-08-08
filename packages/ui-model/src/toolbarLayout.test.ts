// Extracted from ibuilder/massing @ de980159585163d11ca88151fbf8e9013c3ba7b2 (apps/web/src/viewer/toolbarLayout.test.ts), MIT.
// See NOTICE and docs/PROVENANCE.tsv. Upstream changes to that path are reported weekly.
//
// PORT NOTE — this test was SPLIT, and the split is worth reading before you touch it.
//
// Upstream this file has four describe blocks: two assert the layout table and the icon map (pure), and
// two drive `installToolbarView` against a real DOM to assert what actually rendered. `toolbarView` is
// a vanilla-DOM renderer being replaced by the React ribbon, so it does not come to this package.
//
// The 137 lines of DOM assertions are preserved verbatim at `docs/pending/toolbarView.test.ts.txt` and
// re-land in @massing/ui-react at M7, re-expressed against the ribbon. They are NOT discarded,
// because of what they protect: that pair exists precisely because `TOOL_ICON` once shipped complete
// and fully tested while `toolbarView` never called `iconFor` — so "all 27 verbs are mapped" was true
// and nothing on screen had changed. Asserting a table is not asserting a render. The ribbon needs its
// own version of that assertion or it will reproduce the same bug.
import { describe, expect, it } from "vitest";
import { hasIcon } from "./icons.js";
import { GROUP_LABELS, MAX_PRIMARY, TOOLS, TOOL_ICON, describe as describeTool, iconFor, primaryTitles, specFor, unlaidTitles } from "./toolbarLayout.js";
/**
 * R26-TOOLBAR. The audit's finding was 25 unlabeled glyphs, all of them, always. The risk in fixing
 * it is losing a tool — so the tests below are mostly about *nothing disappearing*, and only then
 * about the bar being short.
 */
const ctx = (selection: boolean, canEdit = true) => ({ selection, canEdit });

describe("the table describes every tool, and nothing it does not", () => {
  it("has a unique label and group for each entry", () => {
    for (const t of TOOLS) {
      expect(t.label.trim().length, t.title).toBeGreaterThan(0);
      expect(GROUP_LABELS.map(([g]) => g), t.title).toContain(t.group);
    }
  });

  it("keys on titles, and titles are unique", () => {
    const titles = TOOLS.map((t) => t.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("reports an undescribed tool instead of silently dropping it", () => {
    expect(unlaidTitles(TOOLS.map((t) => t.title))).toEqual([]);
    expect(unlaidTitles(["Some new tool nobody laid out"])).toEqual(["Some new tool nobody laid out"]);
    expect(specFor("nope")).toBeNull();
  });

  it("pulls the More description from the title's own second half", () => {
    const withDash = TOOLS.find((t) => t.title.includes(" — "))!;
    expect(describeTool(withDash)).toBe(withDash.title.split(" — ")[1]);
    const plain = TOOLS.find((t) => !t.title.includes(" — "))!;
    expect(describeTool(plain)).toBe("");
  });
});

describe("the primary set is short, and contextual", () => {
  it("never exceeds the cap — 'contextual' that still shows fifteen has solved nothing", () => {
    for (const c of [ctx(false), ctx(true), ctx(true, false), ctx(false, false)]) {
      expect(primaryTitles(c).length).toBeLessThanOrEqual(MAX_PRIMARY);
    }
  });

  it("promotes the transform verbs only when something is selected", () => {
    const idle = primaryTitles(ctx(false));
    const picked = primaryTitles(ctx(true));
    expect(idle.some((t) => t.startsWith("Move selected"))).toBe(false);
    expect(picked.some((t) => t.startsWith("Move selected"))).toBe(true);
  });

  it("holds the pinned verbs in FIXED positions as context changes", () => {
    // The first version of this table failed here: contextual verbs pushed Ask past the cap, so it
    // silently moved into More the moment you selected something. A verb you learn the position of
    // and then cannot find is worse than one that was never on the bar.
    const idle = primaryTitles(ctx(false));
    for (const c of [ctx(true), ctx(true, false), ctx(false, false)]) {
      expect(primaryTitles(c).slice(0, idle.length)).toEqual(idle);
    }
  });

  it("keeps author verbs out of the primary row below Editor — they stay in More, dimmed", () => {
    const noEdit = primaryTitles(ctx(true, false));
    expect(noEdit.some((t) => t.startsWith("Move selected"))).toBe(false);
    expect(noEdit).toContain("Measure distance (M)");
  });

  it("fills the bar from what is INSTALLED, not from the table", () => {
    // Capping against the whole table and intersecting afterwards would leave a stripped-down
    // toolbar with fewer primary buttons than it has room for.
    const two = ["Measure distance (M)", "Ask the model — plain-English questions about the data"];
    expect(primaryTitles(ctx(true), two).sort()).toEqual([...two].sort());
    expect(primaryTitles(ctx(true), [])).toEqual([]);
  });
});
// --- R26-ICONS: every verb wears an icon, and every icon is one we actually vendored -------------
describe("the icon map covers the toolbar and nothing else", () => {
  it("every labelled tool has an icon — a new verb cannot ship wearing a blank", () => {
    const missing = TOOLS.map((t) => t.label).filter((l) => !iconFor(l));
    expect(missing).toEqual([]);
  });
  it("every icon named is one that was actually vendored", () => {
    // The map is written by hand; the set is generated. A typo here would render nothing at all,
    // and "nothing at all" looks identical to "this button has no icon yet".
    const unknown = Object.values(TOOL_ICON).filter((n) => !hasIcon(n));
    expect(unknown).toEqual([]);
  });
  it("maps no label that is not a real tool", () => {
    const labels = new Set(TOOLS.map((t) => t.label));
    expect(Object.keys(TOOL_ICON).filter((l) => !labels.has(l))).toEqual([]);
  });
  it("the two walk tools deliberately share one icon", () => {
    // They are the same verb. v0.3.691 established the DUPLICATION is the finding; distinct icons
    // would disguise it.
    expect(iconFor("Walk (drag)")).toBe(iconFor("Walk (locked)"));
  });
  it("an unmapped label returns null rather than an inherited property", () => {
    expect(iconFor("constructor")).toBeNull();
    expect(iconFor("nope")).toBeNull();
  });
});