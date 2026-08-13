// Extracted from ibuilder/massing @ de980159585163d11ca88151fbf8e9013c3ba7b2 (apps/web/src/viewer/toolbarLayout.ts), MIT.
// See NOTICE and docs/PROVENANCE.tsv. Upstream changes to that path are reported weekly.

/**
 * R26-TOOLBAR — 25 unlabeled glyphs, all of them, always → a handful of **labeled** verbs plus More.
 *
 * The audit's most concrete finding, and the easiest one to get wrong. Two wrong fixes were available:
 * delete tools nobody could identify (they are used, they were just unlabelled), or add labels to all
 * 25 (a wider wall of options is still a wall). What actually helps is **fewer things visible at
 * once, each of them readable, and nothing removed** — the rest one click away under More.
 *
 * Three decisions carry the design:
 *
 * * **Context, not preference.** The primary set depends on what you have selected, because the
 *   answer to "what can I do right now" genuinely changes. Move/Copy/Delete are meaningless with
 *   nothing selected, and burying Measure behind More while they sit in the open is the current
 *   toolbar's actual problem in miniature.
 * * **A glyph without a word is a puzzle.** `⧉`, `✥`, `◧`, `◨`, `⬚`, `⊞` are not guessable, and the
 *   tooltip only helps someone who already suspects what the button does. Primary buttons show a
 *   short verb; More lists label *and* description, so the long tail is scannable as text.
 * * **Nothing is dropped, and nothing is silently misfiled.** Every button the viewer installs must
 *   appear in the table below. One that does not is put in More *and reported* (`data-unlaid`),
 *   because a tool that quietly vanishes from a toolbar is indistinguishable from one that was
 *   deliberately removed.
 */

/** What the user has to work with right now. */
export interface ToolContext {
  /** An element is selected — the transform/edit verbs become meaningful. */
  selection: boolean;
  /** The caller may author on this project (the `edit` capability). */
  canEdit: boolean;
}

export type ToolGroup = "look" | "measure" | "author" | "collaborate" | "analyse";

export interface ToolSpec {
  /** The button's `title`, verbatim — the key, so a retitled button fails the gate rather than drifts. */
  title: string;
  /** The word shown beside the glyph when this tool is primary. Short: it sits in a floating bar. */
  label: string;
  group: ToolGroup;
  /**
   * `"always"` pins the tool to the bar; a predicate promotes it only in that context; absent means
   * it lives in More.
   *
   * The distinction is load-bearing, and the first version of this table got it wrong. Treating
   * always-on tools as merely "a predicate that returns true" let contextual verbs push them past
   * the cap — so **Ask** silently moved into More the moment you selected something. A verb that
   * relocates in response to unrelated state is worse than one that was never on the bar: you learn
   * where it is, and then it is not there.
   */
  primary?: "always" | ((ctx: ToolContext) => boolean);
}

const onSelection = (c: ToolContext) => c.selection;
const onEditableSelection = (c: ToolContext) => c.selection && c.canEdit;

/**
 * Every button `installTools` creates, in the order the toolbar should read.
 *
 * Ordering is deliberate: look → measure → author → the rest. It is the order of the questions people
 * actually ask of a model — *what am I looking at*, then *how big is it*, then *change it*.
 */
export const TOOLS: ToolSpec[] = [
  // ── look ───────────────────────────────────────────────────────────────────────────────────────
  { title: "Toggle storey levels overlay", label: "Levels", group: "look", primary: "always" },
  { title: "Show all (H)", label: "Show all", group: "look", primary: onSelection },
  { title: "Isolate selection", label: "Isolate", group: "look", primary: onSelection },
  { title: "Color selection", label: "Colour", group: "look" },
  { title: "Section plane (S) — dbl-click a face", label: "Section", group: "look", primary: "always" },
  { title: "Section box (clip to model bounds)", label: "Section box", group: "look" },
  { title: "Render mode — sun, soft shadows, PBR lighting, SSAO & bloom", label: "Render", group: "look" },
  { title: "Sun & shadow study (date · time · location)", label: "Sun", group: "look" },
  // Labelling the toolbar surfaced a real duplicate: TWO first-person walk tools, both 🚶, both
  // installed, sitting next to each other. `envTools` drives the camera per frame and you drag to
  // look; the later R17 `walkMode` takes a pointer lock and exits on Esc. They are not the same
  // control, but as two identical glyphs they read as a rendering bug. Distinct labels make the
  // duplication legible; deciding which one is canonical is a behaviour change, not a layout one,
  // so it is recorded in the roadmap rather than settled here by whichever I happened to keep.
  { title: "Walk through (first-person — W/A/S/D, drag to look)", label: "Walk (drag)", group: "look" },
  { title: "Walk mode — first-person WASD walkthrough (Esc exits)", label: "Walk (locked)", group: "look" },
  // ── measure ────────────────────────────────────────────────────────────────────────────────────
  { title: "Measure distance (M)", label: "Measure", group: "measure", primary: "always" },
  { title: "Measure area (A)", label: "Area", group: "measure" },
  { title: "Clear measurements", label: "Clear", group: "measure" },
  // ── author ─────────────────────────────────────────────────────────────────────────────────────
  // The three draw verbs, added for M6. They are listed here rather than only in the demo because
  // `builtinManifests()` derives the built-in ribbon from *this table* — a tool that is not here cannot appear
  // in the ribbon, cannot get a message key (the message gate checks this table in both directions), and cannot
  // be covered by the every-tool-reachable property test. massing's own bar logged "not described by
  // toolbarLayout" for a shipped push/pull verb for exactly this reason.
  //
  // Not `primary`: the floating bar has a hard cap, and promoting a tool there silently demotes another. The
  // ribbon places them from HOMES, where they get a Draw group of their own on Build.
  { title: "Draw a wall between two points (W)", label: "Wall", group: "author" },
  { title: "Draw a slab from a closed outline", label: "Slab", group: "author" },
  { title: "Place a column at a point", label: "Column", group: "author" },

  /**
   * The 2D and markup verbs, which are **this repository's**, not inherited.
   *
   * Everything above this point came from massing's toolbar and is matched to it by title. These are the ones
   * MassingViewer adds because its 2D story is a product claim rather than a side pane: cutting a sheet, giving it
   * the whole canvas, restyling it, issuing it, and marking it up. Without them the Sheet tab held a single
   * control — a tab that exists and has nothing in it.
   *
   * `group: "look"` for the view verbs and `"collaborate"` for the markup ones keeps the floating-bar grouping
   * meaningful for massing's vanilla shell, which reads the same table. None of them is `primary`, deliberately:
   * the floating bar has a hard cap, and promoting a new verb into it demotes an inherited one — the exact failure
   * `railToolbox` already shipped once. These live in the ribbon, which has no cap.
   */
  { title: "Cut a plan at the current level", label: "Cut plan", group: "look" },
  { title: "Show the sheet full width — border, title block, revision table", label: "Sheet", group: "look" },
  { title: "Repaint the sheet with another discipline theme — no regeneration", label: "Theme", group: "look" },
  { title: "Fit the drawing to paper at a standard scale", label: "Paper", group: "look" },
  { title: "Export the sheet as PDF, with layers and a GlobalId index", label: "PDF", group: "collaborate" },
  { title: "Export the sheet as DXF R12", label: "DXF", group: "collaborate" },
  { title: "Raise an issue on the selected element", label: "Issue", group: "collaborate" },
  { title: "Export every markup as BCF 3.0", label: "BCF", group: "collaborate" },
  { title: "Edit in place — drag the gizmo to move the selected element", label: "Edit in place",
    group: "author", primary: onEditableSelection },
  // R38-PUSHPULL — shipped v0.3.821 and NOT registered here, so the bar logged
  // "not described by toolbarLayout" on every load. R26-TOOLBAR's gate is about nothing
  // disappearing; an unregistered tool is exactly that failure arriving from the other side.
  // NOT primary: the bar has a hard cap, and promoting this pushed "Move" into More — the exact
  // silent-demotion the pinned-positions test below exists to catch. It caught it. Push/pull stays
  // in More and on the rail, where it was already reachable.
  { title: "Push/pull — drag the top handle to make the selected element taller or thicker",
    label: "Push/pull", group: "author" },
  { title: "Plan beside model", label: "Plan pane", group: "look" },
  { title: "Move selected element (E,N,Z metres)", label: "Move", group: "author", primary: onEditableSelection },
  { title: "Copy selected element (offset E,N,Z metres)", label: "Copy", group: "author", primary: onEditableSelection },
  // A29-GUIDE-UNDERLAY. In `author` rather than `look` because it is not a way of viewing the model —
  // it is a reference you draw ON TOP OF, so it belongs beside the verbs that draw.
  { title: "Guide underlay — pin a scanned plan to this level and trace over it",
    label: "Guide underlay", group: "author" },
  { title: "Rotate selected element (degrees about Z)", label: "Rotate", group: "author" },
  { title: "Delete selected element", label: "Delete", group: "author" },
  { title: "Edit a property on the selected element", label: "Property", group: "author" },
  { title: "Add door to selected wall", label: "Add door", group: "author" },
  { title: "Add window to selected wall", label: "Add window", group: "author" },
  { title: "Script this — see the GUID-safe recipe plan behind a plain-English command, then apply",
    label: "Script", group: "author" },
  // ── analyse ────────────────────────────────────────────────────────────────────────────────────
  { title: "Ask the model — plain-English questions about the data", label: "Ask", group: "analyse",
    primary: "always" },
  // ── collaborate ────────────────────────────────────────────────────────────────────────────────
  { title: "Live presence", label: "Presence", group: "collaborate" },
  { title: "Share your current view with everyone", label: "Share view", group: "collaborate" },
  { title: "Share via QR — open this project on a phone or tablet", label: "QR", group: "collaborate" },
  { title: "Capture hero image — this view becomes page 2 of the client project package (PDF)",
    label: "Capture", group: "collaborate" },
];

const BY_TITLE = new Map(TOOLS.map((t) => [t.title, t]));

export function specFor(title: string): ToolSpec | null {
  return BY_TITLE.get(title) ?? null;
}

/** Capped, because "contextual" that still yields fifteen buttons has solved nothing. */
export const MAX_PRIMARY = 8;

/**
 * The titles visible as labeled buttons: the pinned verbs first, then whatever this context promotes.
 *
 * The two-phase order is the whole point. Pinned verbs hold **fixed positions** — you learn where
 * Measure is once — and contextual verbs append after them, so gaining a selection never reshuffles
 * what was already on the bar. The cap therefore only ever trims the contextual tail.
 *
 * `available` restricts to the tools this toolbar actually installed, **before** the cap. Capping
 * against the full table and intersecting afterwards would leave a stripped-down build with fewer
 * primary buttons than it has room for — the cap would be spending slots on tools that do not exist.
 */
export function primaryTitles(ctx: ToolContext, available?: string[]): string[] {
  const pool = available ? TOOLS.filter((t) => available.includes(t.title)) : TOOLS;
  const pinned = pool.filter((t) => t.primary === "always");
  const contextual = pool.filter((t) => typeof t.primary === "function" && t.primary(ctx));
  return [...pinned, ...contextual].map((t) => t.title).slice(0, MAX_PRIMARY);
}

/** Titles the viewer registered that this table does not describe. Must be empty; surfaced, not hidden. */
export function unlaidTitles(registered: string[]): string[] {
  return registered.filter((t) => !BY_TITLE.has(t));
}

/** Human group headings for the More menu, in reading order. */
export const GROUP_LABELS: [ToolGroup, string][] = [
  ["look", "View"], ["measure", "Measure"], ["author", "Modify"],
  ["analyse", "Analyse"], ["collaborate", "Share"],
];

/** The description shown beside a label in More — the part of the title after the em dash, if any. */
export function describe(spec: ToolSpec): string {
  const i = spec.title.indexOf(" — ");
  return i > 0 ? spec.title.slice(i + 3) : "";
}

/**
 * R26-ICONS — the icon each labelled verb wears, keyed by label.
 *
 * Keyed by LABEL rather than by title, because the label is the word already chosen for the button
 * and the two must agree: an icon that disagrees with the word beside it is worse than no icon,
 * since the reader now has two claims and no way to choose. `toolbarLayout.test` asserts every
 * label here resolves to a vendored icon and that no label is missed, so a new verb cannot ship
 * wearing a blank.
 */
export const TOOL_ICON: Record<string, string> = {
  // The M6 draw verbs. `box` for a wall and a column and `layers` for a slab are the nearest honest matches in
  // the vendored set — no glyph is invented, because the gate below asserts every name here was actually
  // vendored and a typo renders nothing, which looks exactly like "this button has no icon yet".
  "Wall": "box",
  "Slab": "layers",
  "Column": "box",
  // The 2D and markup verbs. `pencil-ruler` for cutting a drawing, `panel-top` for a sheet with a title block
  // across its head, `file-text` for the PDF and `download` for the DXF — nearest honest matches, nothing invented.
  "Cut plan": "pencil-ruler",
  "Sheet": "panel-top",
  "Theme": "palette",
  "Paper": "ruler",
  "PDF": "file-text",
  "DXF": "download",
  "Issue": "flag",
  "BCF": "share-2",
  "Guide underlay": "scan",     // A29-GUIDE-UNDERLAY — a scanned plan, traced over
  "Levels": "layers",
  "Show all": "eye",
  "Isolate": "focus",
  "Colour": "palette",
  "Section": "scissors",
  "Section box": "box",
  "Render": "sparkles",
  "Sun": "sun",
  // Two walk tools, deliberately the same icon: they ARE the same verb, and v0.3.691 established
  // that the DUPLICATION is the finding. Giving them different icons would disguise it.
  "Walk (drag)": "footprints",
  "Walk (locked)": "footprints",
  "Measure": "ruler",
  "Area": "scan",
  "Clear": "eraser",
  "Edit in place": "pencil",
  "Push/pull": "box",
  "Plan pane": "layers",
  "Move": "move-3d",
  "Copy": "copy",
  "Rotate": "rotate-cw",
  "Delete": "trash-2",
  "Property": "info",
  "Add door": "door-open",
  "Add window": "panel-top",
  "Script": "code",
  "Ask": "message-circle-question-mark",
  "Presence": "users",
  "Share view": "share-2",
  "QR": "qr-code",
  "Capture": "camera",
};

/** The icon for a tool, or null when it has none — the caller falls back to its label. */
export function iconFor(label: string): string | null {
  return Object.prototype.hasOwnProperty.call(TOOL_ICON, label) ? TOOL_ICON[label]! : null;
}
