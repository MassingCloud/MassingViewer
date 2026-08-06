# ADR-0006 — React only in the shell; the core stays framework-agnostic

- **Status:** Accepted
- **Date:** 2026-08-06

## Context

massing's web app is **plain TypeScript against the DOM** — no React, no Vue, no Svelte, no state library.
Module-level closures and `window` custom events. That is a deliberate and defensible choice for an app of
its shape, and it means there is no component tree to port.

MassingViewer needs a materially better UI than the one it inherits: an Office-style ribbon with contextual
tabs and responsive group collapsing, a command palette, an AutoCAD-style command line, a dockable panel
system, and drag-and-drop as a headline interaction. Hand-building responsive ribbon collapse, KeyTips and
docking against raw DOM is where a large share of the UI budget would go, for no differentiating benefit.

But MassingViewer must also be **pulled back into massing** (milestone M9), and massing is vanilla. If the
whole thing is React, React enters massing's bundle and its existing panels get rewritten.

## Decision

**Split at the rendering boundary.**

- **Core packages stay vanilla TypeScript**, with no DOM and no framework: `core`, `kernel-api`,
  `kernel-conformance`, `geometry-math`, `ui-model`, `catalog`, `jobs`, `commands`, `drawings2d`,
  `plugin-host`, and the kernels. These are publishable, independently useful, and consumable from any
  host — Node, a Worker, vanilla DOM, React, React Native.
- **React is confined to `packages/ui-react`**, plus the app. `packages/viewport` owns `three` and
  `@thatopen/*` imperatively — not `react-three-fiber`, because the reconciler adds indirection in the
  hottest path in the application. If r3f appears later it is for overlays and gizmos only.

Two structural consequences make this hold rather than merely being intended.

**`packages/ui-model` exists because of this decision.** The ribbon and palette *layout model* — which
tools exist, how they group, how groups collapse — is pure data and pure math, and it lives one layer below
React. Both hosts read one table. Had it lived inside the React package, massing would have grown a second
copy and the two would have diverged; that is the drift shape this repo is trying not to repeat.

**The boundary is a build failure, not a convention.** `scripts/check-architecture.mjs` confines `react`
and `react-dom` to `ui-react`, and `three` and `@thatopen/*` to `viewport`. It confines `three` for a
concrete, measured reason: massing's `apps/web/vite.config.ts` documents `resolve.dedupe: ["three"]` because
"Multiple instances of Three.js" was an observed failure there — two copies in one bundle produce objects
that fail each other's `instanceof` checks, and the symptom is geometry that silently refuses to render.
One importing package is what makes deduping tractable.

The core packages' `tsconfig.json` files also omit the `DOM` lib entirely, so a stray `document` reference
is a type error at home rather than a runtime failure in someone else's environment.

## Consequences

- Two rendering implementations of the toolbar exist during the transition: massing's `apps/web/src/viewer/toolbarView.ts` and
  the React ribbon. `packages/ui-model` is the shared truth between them, and M9 removes the duplication.
- The 137 lines of DOM-render assertions from massing's `toolbarLayout.test.ts` do not port directly. They
  are preserved verbatim at `docs/pending/toolbarView.test.ts.txt` and re-land in `ui-react` at M7,
  re-expressed against the ribbon. They are **not** discarded, for a specific reason: that pair of tests
  exists because massing's icon map once shipped complete and fully tested while the renderer never called
  `iconFor` — so "all 27 verbs are mapped" was true and nothing on screen had changed. **Asserting a table
  is not asserting a render.** The ribbon needs its own version of that assertion or it will reproduce the
  same bug.
- No component library and no runtime CSS-in-JS. massing's vanilla shell fits a 220 KB budget; React plus a
  component library would not. Per-package bundle budgets are set from day one, and `ui-react` builds on
  primitives rather than a kit.
- Internationalisation lands *with* the React shell at M7, not after. Retrofitting i18n is the single most
  expensive deferred decision in an app this size.
