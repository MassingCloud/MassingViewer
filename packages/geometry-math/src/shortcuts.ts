// Extracted from ibuilder/massing @ de980159585163d11ca88151fbf8e9013c3ba7b2 (apps/web/src/viewer/keysDyn.ts), MIT.
// See NOTICE and docs/PROVENANCE.tsv. Upstream changes to that path are reported weekly.
//
// PORT NOTE: only the data table moved. Upstream `keysDyn.ts` is 190 lines of keyboard handling wired
// to massing's rail — the HUD, the help modal, the draft-panel handle. None of that is portable, and
// all of it is being replaced by the command bus's keybinding registry.
//
// The table itself has to move, and had to move *here*, for one specific reason: `snapOverride.test.ts`
// asserts that the two-letter draw-tool codes and the two-letter snap-override codes are **disjoint**.
// Both code sets are typed into the same buffer, so an overlap would silently arm the wrong thing. That
// assertion is only possible if both tables are reachable from one package — so leaving this behind
// would have meant deleting the test that protects the collision.

/**
 * Two-letter draw-tool shortcuts: `[code, catalog key, label]`.
 *
 * Revit-trained users are instantly fast with these, which is the whole point — the codes match the
 * muscle memory people arrive with rather than inventing a new scheme.
 *
 * The table lives beside the parser that dispatches it and is *read* by the help surface, rather than
 * the help surface keeping a second copy. A published shortcut list that drifts from the shortcuts that
 * actually work is worse than no list.
 */
export const KEY_SHORTCUTS: readonly (readonly [string, string, string])[] = [
  ["WA", "wall", "Wall"], ["SL", "slab", "Slab / floor"], ["RF", "roof", "Roof"],
  ["RA", "railing", "Railing"], ["SR", "stair", "Stair"], ["RP", "ramp", "Ramp"],
  ["CL", "column", "Column"], ["BM", "beam", "Beam"],
  ["SC", "steel_column", "Steel column"], ["SB", "steel_beam", "Steel beam"],
  ["RB", "rebar", "Rebar"], ["FT", "footing", "Footing"],
  ["DU", "duct", "Duct"], ["PI", "pipe", "Pipe"], ["CT", "cable_tray", "Cable tray"],
  ["WR", "wire", "Wire"],
];

/** code → catalog key, for dispatch. */
export const KEY_SHORTCUT_MAP: Readonly<Record<string, string>> =
  Object.fromEntries(KEY_SHORTCUTS.map(([code, key]) => [code, key]));
