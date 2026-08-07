# ADR-0009 — The ribbon renders in vanilla DOM; React wraps it

- **Status:** Accepted
- **Date:** 2026-08-07
- **Amends:** `docs/adr/0006-react-shell-vanilla-core.md`

## Context

ADR-0006 split at the rendering boundary: core packages stay framework-free, React is confined to
`packages/ui-react`, and `packages/ui-model` holds the ribbon *layout model* so both hosts read one table.
That decision rested on an assumption stated in its own consequences:

> Two rendering implementations of the toolbar exist **during the transition**: massing's
> `apps/web/src/viewer/toolbarView.ts` and the React ribbon. `packages/ui-model` is the shared truth between
> them, and **M9 removes the duplication.**

Two requirements have since been stated explicitly, and the second one falsifies that assumption:

1. **MassingViewer must work standalone.** People should be able to use just this and nothing else.
2. **Development continues in massing.** massing is not being replaced by MassingViewer; both go on.

If massing keeps developing *and* consumes MassingViewer, the duplication is not transitional — it is
permanent. Under ADR-0006 as written, that leaves three options, and all three are bad:

- **Two ribbon renderers forever.** The exact drift this repository was created to end. massing's own
  vendorAlias.ts says it: *"three copies of one fact is the drift shape this codebase keeps paying for."*
- **React enters massing.** Its whole shell is plain TypeScript against the DOM with module-level closures and
  `window` custom events. Adding React means either a second rendering paradigm inside one app, or rewriting
  panels that work.
- **massing renders the ribbon itself from `ui-model`.** Better, but it means re-implementing responsive group
  collapse, roving tabindex, KeyTips and contextual tabs — which is most of the difficulty. A shared *table*
  with two implementations of the hard part is a shared table and two sets of bugs.

## Decision

**Move the rendering boundary down one level. The ribbon renders in vanilla DOM, in
`packages/ribbon`, and React wraps it.**

The direction of the dependency is the whole argument:

- A **vanilla renderer works in every host.** massing mounts it directly. MassingViewer's demo mounts it
  directly. React mounts it in a `useEffect` against a `ref`, which is how every framework hosts imperative
  UI.
- A **React renderer works in one host.** It cannot go into massing without React going with it.

This is not a new pattern here — it is the pattern `packages/viewport` already uses, and for the same reason.
The viewport is imperative three.js precisely so that any host can own a canvas, and ADR-0006 endorsed that
while making the opposite choice one layer up. The ribbon has the same shape: long-lived, imperative,
performance-sensitive, and needed by two hosts.

`packages/ui-react` remains in the plan and keeps its purpose — the panels, the property grid, the docking,
the palette — but it becomes a *consumer* of the ribbon rather than its implementation.

## What stays exactly as ADR-0006 decided

The principle is unchanged and the amendment is narrow. **`ui-model` is still the single source of layout
truth**, and it is now more important rather than less: which tools exist, how they group, how groups collapse
at a given width, and which are dimmed is pure data and pure math with no DOM. That is what makes the
renderer thin enough to be worth having only one of.

`scripts/check-architecture.mjs` still confines `react` and `react-dom` to `ui-react`, and `three` to
`viewport`. The core packages still omit the `DOM` lib so a stray `document` is a type error at home.

## Consequences

- **One ribbon implementation, from the start.** There is no transitional second renderer to remove at M9,
  because there is no second renderer.
- **`packages/ribbon` may touch the DOM and nothing else** — no framework, no component library, no runtime
  CSS-in-JS. It has to fit inside massing's 220 KB budget as an addition rather than a replacement.
- **The imperative API is the contract.** `createRibbon(container, model, handlers)` returning an object with
  `update()` and `dispose()`, mirroring `createViewport`. A host that can call three functions can render a
  ribbon.
- **The 137 preserved DOM assertions land here**, not in `ui-react`. `docs/pending/toolbarView.test.ts.txt`
  exists because massing's icon map once shipped complete and fully tested while the renderer never called
  `iconFor` — so *"all 27 verbs are mapped"* was true and nothing on screen had changed. **Asserting a table
  is not asserting a render.** Those assertions were always about DOM output, and DOM output is now what this
  package produces, so they re-land against the real thing rather than being re-expressed against React.
- **i18n still lands with the shell**, as ADR-0006 required. It moves into `ribbon`'s label resolution rather
  than into React context.
- **React is still coming**, and is still the right call for the panels and the docking layout, where a
  component tree genuinely helps and where massing has its own panels already.

## What would change this decision

If massing adopts React for its own reasons, the argument evaporates: a React ribbon would then serve both
hosts, and the vanilla renderer becomes the one with a single consumer. That is a decision for massing to
make on its own merits, and this ADR should be revisited the week it does.
