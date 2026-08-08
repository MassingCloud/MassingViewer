// @massing/ribbon — the ribbon, in vanilla DOM so both hosts can render it.
//
// See docs/adr/0009-ribbon-renders-in-vanilla-dom.md. MassingViewer must work standalone and development
// continues in massing, whose shell is plain TypeScript against the DOM. A vanilla renderer works in both;
// a React one works in one. React wraps this the way it wraps any imperative UI — a ref and a useEffect —
// exactly as `packages/viewport` is already wrapped.
//
// The layout *decisions* are not here: which tools exist, how they group, and how groups collapse at a given
// width all live in `@massing/ui-model`, so massing's renderer and this one cannot disagree about where
// a tool is.

export { createRibbon } from "./ribbon.js";
export type { Ribbon, RibbonHandlers, RibbonOptions } from "./ribbon.js";
