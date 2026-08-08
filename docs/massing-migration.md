# M9: massing consumes MassingViewer

The plan's risk register puts this first, and not by a small margin:

> **Divergence from massing** — near-certain; already live. The 4-rule coordination protocol; ledger-driven weekly
> divergence bot; **M9 must not slip**. *The only risk that can end the project.*
>
> Two live copies of an 11,570-line engine for >8 weeks is a fork, not a plan.

> **A note on the paths below.** Anything in `ibuilder/massing` is written in plain quotes rather than backticks,
> because `scripts/check-doc-paths.mjs` resolves every backticked path against *this* repository — and it is right
> to. A path in another repo cannot be verified from here, so citing one in backticks would be a claim this project
> has no way to keep true. Backticks below mean "in MassingViewer"; quotes mean "in massing".

This document is the migration, and `packages/embed/src/seam.ts` is the machine-readable half of it — because
"can massing delete its viewer yet" is otherwise an opinion, and an optimistic one, since whoever asks wants the
answer to be yes.

## Current readiness

Run it rather than trusting this paragraph:

```bash
node -e "import('@massing/embed').then(m => console.log(m.seamSummary()))"
```

`seamCoverage()` counts only the **movable** surface. `ApiClient` staying in massing is the design, not a
shortfall, and counting it against readiness would make the number permanently and misleadingly low.

`ready` is `false` while any gap remains, and it must be: a partial adoption means both copies live, which is
precisely the fork. The remaining gaps are the interactive authoring surface — snapping, the prompt loop, the
section box, markup pins, and walk mode — all of which are M6 work, not seam work. The packages exist; what is
missing is an armed-tool session to drive them.

## The change, which is one field

The plan describes the whole extraction in a sentence:

> `ViewerCtx.api: ApiClient` becomes `ViewerCtx.kernel: KernelProvider` — this one field change is the whole
> extraction in miniature.

That is why `kernel` is a **required** option on `createMassingViewer` rather than a defaulted one. A facade that
quietly constructed a `LocalKernel` would let massing adopt this while still holding an `ApiClient` somewhere, and
the coupling being broken would survive the migration invisibly. Required means the compiler asks the question.

## Sequence

Never one big-bang PR. Risk #2 in the plan is "app.ts" losing a feature during the dissection, and massing's own
"railToolbox.test.ts" exists *because that already happened once*: "a dropped tool is invisible… the next person to
notice is a user who needed it."

**1. In massing, a pure refactor.** Extract lines 1278–4978 of `apps/web/src/viewer/app.ts` into
"viewer/railPanels.ts", and 1673–4743 into "viewer/toolsPanel.ts", leaving "app.ts" around 1,400 lines. No
behaviour change. This benefits massing on its own merits and is reviewed on massing's CI.

**2. Same PR: retarget the source-text tests.** "toolsSplit.test.ts" (215 lines) and "takeoff2d.test.ts" both
`readFileSync` "app.ts" and parse it as *text*, so they break the moment it moves. The tests that import modules
normally — `toolbarLayout`, `railToolbox`, `planPane`, `snapEngine`, `cadCommands`, `placeValid` — are unaffected.

**3. Add the ratchet.** During the transition, a CI check in massing: *"app.ts" below the rail-panels marker may
contain at most N `api.` references, and N only decreases.* The measurement that makes this work is already in the
plan: of 171 `api.` references, lines 0–1999 hold 36 and lines 2000–5064 hold 135. The engine half is nearly
API-free already, which is why this extraction is feasible at all.

**4. Then, and only then, swap the engine.** `apps/web/src/viewer/` is deleted and replaced by
`@massing/embed`. One `createMassingViewer` call, and `ViewerCtx.kernel` where `ViewerCtx.api` used to be.

## The Worker is constructed in massing, not here

It has to be:

```ts ignore
// In massing's app, not in a package.
const worker = new Worker(new URL("./kernel.worker.ts", import.meta.url), { type: "module" });
const kernel = createLocalKernel(browserWorkerTransport(worker));
```

`new URL(..., import.meta.url)` must appear in the **application's** source for a bundler to see it. Inside a
published package it resolves against a module that has already been inlined, and no chunk is emitted at all —
that is not a hypothesis, it is what happened the first time in `apps/demo`.

The same applies to the tessellator: `createMassingViewer` takes one as a parameter. Bundling `web-ifc` here would
force a WASM asset on every host, and massing already has a pipeline.

## What massing keeps

From `SEAM`, the entries marked `massing`. These are boundaries, not gaps:

- **`buildToolsPanel`** — 3,071 lines of persona-ordered construction-platform sections. massing's product.
- **The rail panels** — issues, pins, clash, 5D, linked records. Each is backed by a massing API endpoint, so
  extracting them would drag `ApiClient` across the seam.
- **`ApiClient`** — ~3,865 lines. Deliberately on the far side; `kernel-remote` is the only package allowed
  anything HTTP-shaped.
- **Auth** — `NoAuth` is what makes the offline story real, and only `kernel-remote` knows auth exists.

## Verification

From the plan, and none of it is optional:

- massing builds and its **full test suite passes** with `apps/web/src/viewer` deleted.
- massing's **bundle budget still holds**. `bundle-budget.mjs` parses the entry from `index.html` rather than
  matching filenames, because a lazy "index-<hash>.js" vendor chunk was once miscounted as shell.
- A wall authored in massing appears in MassingViewer's own demo, and the reverse.
- `seamCoverage().ready === true`.

## What has not been done, and why

**The massing-side PR.** It lives in `ibuilder/massing`, a different repository, and it deletes 11,570 lines of
someone's application. That is not a change to make unasked — and the plan agrees, because the coordination
protocol is built entirely around *not* surprising massing:

> Blocking massing's roadmap would make the extraction politically expensive, which is how extractions die.

What exists on this side is everything that side needs: the facade, the ledger that says when to start, and the
sequence above. The remaining gaps are M6 features rather than seam design, so they close by building tools, not
by rethinking the boundary.
