<div align="center">

# MassingViewer

**An IFC-native 3D/2D CAD studio that runs in your browser.**
View and author building models. Generate plans from them. Mark those plans up.
The model never leaves your machine unless you tell it to.

[![CI](https://github.com/MassingCloud/MassingViewer/actions/workflows/ci.yml/badge.svg)](https://github.com/MassingCloud/MassingViewer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

---

## Why this exists

Browser BIM has split into two camps that don't talk to each other.

One camp authors 3D — Forma, TestFit, Arcol, Snaptrude. They are good at massing and live metrics, and
weak at drawings. Arcol says so itself: *"drawing creation capabilities remain underdeveloped."*

The other camp marks up 2D — Bluebeam, Revizto, Procore, Fieldwire. They are excellent at markup and
have no 3D authoring at all. They consume PDFs that somebody else made in some other tool.

So the loop from *design* → *drawing* → *review* → *revise* crosses three products and a PDF boundary,
and the markup lands on a flattened raster that has forgotten which wall it is about.

MassingViewer closes that loop:

- **A plan is a live view of the model**, not an export of it. Change the model, the plan changes.
- **A markup on that plan resolves to an IFC GlobalId.** Not to a page coordinate — to the wall.
- **Every markup is a BCF topic**, so it opens in Solibri, BIMcollab, Revizto, Navisworks and Bonsai
  without a bridge.
- **It works offline.** The default kernel writes IFC in a Web Worker in your browser. No account, no
  upload, no server.

## Status

**Pre-alpha, in active extraction.** This repo is being built by lifting the Design Room out of
[ibuilder/massing](https://github.com/ibuilder/massing) — an existing production BIM platform — and
rebuilding its shell around a ribbon UI and a pluggable geometry kernel.

**What works today**, with no backend, no account and no network after first paint:

- **Loads and renders a real IFC4 building.** Orbit, pan and zoom with a mouse *or* pinch-to-zoom on a
  touchscreen. Pick an element and see both its `expressID` and its IFC `GlobalId`.
- **Authors offline.** `LocalKernel` runs in a Web Worker and writes IFC in your browser. The demo's
  `+ Wall` button does a full round trip — apply the operation, export IFC, re-tessellate — so the *file*
  changes, not just the picture. An E2E test asserts it makes **zero network requests** while doing so.
- **Fifteen of the ninety-six authoring operations**, verified by the published conformance suite rather
  than claimed. The other eighty-one return a refusal naming what would unlock them, and the count is a
  ratchet in [`fixtures/recipes.tsv`](fixtures/recipes.tsv) that CI will not let regress.
- **Editing an IFC does not destroy what it does not understand.** The authoritative store is the file's own
  entity table, and an entity nobody touched is re-emitted byte-for-byte — so moving one wall cannot delete a
  structural consultant's analytical model. See
  [ADR-0008](docs/adr/0008-local-kernel-geometry-stack.md).
- **Doors and windows are real holes.** `IfcOpeningElement` voids are subtracted, so a wall with a door becomes
  jambs and a lintel — visible in 3D, and cut as two separate loops by a plan passing through the opening. A plan
  cut below a window sill shows that wall unbroken and one through it shows the gap, which is the difference
  between a drawing and a picture of a massing model. An opening whose profile is not a rectangle is refused and
  reported in the drawing's provenance rather than drawn solid in silence.
- **Cuts a plan, and the plan is a live view.** Cut the model at 1.2 m onto A3, click a line in the plan, and
  that element selects in 3D — because every line carries the GlobalId of the element it came from, not a page
  coordinate. Select in 3D and *all* of that element's plan linework lights up. Author a wall and the open plan
  follows the edit.
- **Switching discipline is a repaint, not a regeneration.** Architectural → fire-safety keeps byte-identical
  path data and changes only the paint, because a theme is a stylesheet over model-space geometry and paper is a
  render-time transform. Auto-fit picks the largest scale on the project's own ladder — metric or imperial, never
  a mix.
- **Marks up, and the markup knows what it is about.** Pick a Tool Set tool, press `m`, and you get a correctly
  typed BCF topic anchored to the element's GlobalId. Delete that element and the topic does not quietly survive
  looking fine — it is struck through as **orphaned**, with a reason naming the missing GlobalId. Export is
  BCF 3.0, written entirely in the page, so topics open in Solibri, BIMcollab, Revizto and Bonsai.
- **A guide for writing your own kernel** ([docs/kernels/authoring.md](docs/kernels/authoring.md)), plus a
  reference implementation that passes the same suite — so a third-party kernel is a supported thing to write.

**1,178 unit tests, 62 E2E tests each on Chromium, Firefox, WebKit and iPad, and 11 repo gates** are green —
plus dedicated Playwright projects for the React shell (9), WCAG 2.2 AA via `axe-core` (4) and viewport visual
regression (2). The E2E suite includes a **memory-leak gate**: twenty model replacements must leave *exactly* the
same number of GPU buffers as one, because three.js does not free them when an object leaves the scene graph and
the symptom of getting that wrong is a tab that gets slow and then dies. Drawings are gated at three tiers, the
third of which rasterises them through pinned `resvg` nightly — because line weight and dash pattern are invisible
to a semantic digest, and a plan whose linework all became hairline-thin is unreadable while every digest matches.

- **Exports SVG and DXF from one drawing.** Both are pure functions of `(Drawing, Theme, Paper)`, so a DXF a
  consultant opens measures the same as the SVG a reviewer approved — and `dxfLimitations()` states what R12
  cannot carry, including that GlobalIds do not survive a DXF, rather than leaving it to be discovered.

- **A real ribbon**, in vanilla DOM so massing can mount the same code. All 30 inherited tools across nine tabs,
  groups that collapse to dropdowns as the window narrows and **never drop a verb** — asserted at every integer
  width from 320 to 3840 — full keyboard navigation, and controls that dim with a reason instead of vanishing.

- **Draws by hand, with snapping and typed dimensions.** Pick Wall, Slab or Column from the ribbon and a 1 m
  construction grid appears with a crosshair that snaps — to the building's own corners first and to a grid
  intersection second, because a drafter reaching for a corner wants the corner. Then **type the dimension**:
  `12'6` produces a wall 3.810 m long, asserted by measuring the geometry rather than by reading the label. The
  readout sits beside the crosshair, showing the live distance and bearing until you type over it. A refusal — a
  double-clicked zero-length wall — states the measurement and **leaves the tool armed with your first point
  intact**, because losing work to a validation message is how people stop trusting a tool.

- **Edits by dragging.** Select an element and three handles appear: a plate at the base to move it in plan, a
  ring to rotate it, and a cone above the top corner to push/pull its height. Every drag resolves against a plane
  in world space, so the handle stays under the cursor at any zoom, and every drag dispatches a **command** — so a
  gizmo edit lands in the undo stack and the audit log exactly like a typed one. A drag that goes nowhere writes
  nothing.

- **Reads an element's properties.** Select something and the panel fills in from the kernel: its name, its
  property sets, and its material layers — with booleans as yes/no and typed measures unwrapped, because
  `[object Object]` in a property panel is worse than nothing. An element with no property sets says so, which is
  a different statement from one the kernel could not answer for, and both beat silence.

**What is not built.** Levels toggles the construction grid rather than drawing storey planes; openings are
subtracted only from rectangular profiles — anything else is drawn solid **and reported**, never silently; a
frame-time gate and a long-task gate are absent (see [docs/testing.md](docs/testing.md)); and desktop.yml and
mobile.yml would package apps that do not exist yet. See [the roadmap](#roadmap).

Nothing here is API-stable until `1.0.0`. Packages are published at `0.x`, where **minor bumps may
break** — see [the versioning policy](CONTRIBUTING.md#versioning).

## Quick start

```bash
git clone https://github.com/MassingCloud/MassingViewer.git
cd MassingViewer
npm install
npm run dev
```

That opens the studio with a sample building already loaded — no backend, no configuration, no
network. If `npm install` complains about your Node version, it will tell you exactly how to fix it.

## Architecture in one screen

Two ideas carry the whole design.

**1. Every action is one serializable command.** Clicking a ribbon button, typing `WALL 0,0 @5<0` on
the command line, running a macro, and a plugin calling the API all produce the same
`CommandInvocation`. Interactive multi-step commands (AutoCAD's *"specify next point"* loop) are a
**pure reducer** that accumulates arguments and emits one invocation when complete. From that single
property you get undo/redo, the command palette, the command line, keyboard remapping, macro
recording, the plugin API, the audit log, and — later — multi-user sync. One abstraction, seven
features.

**2. The geometry engine is pluggable.** Authoring goes through a `KernelProvider`:

| | `LocalKernel` (default) | `RemoteKernel` |
|---|---|---|
| Runs | Entirely in your browser, in a Worker | Against a [massing](https://github.com/ibuilder/massing) server |
| Writes IFC with | Its own STEP entity table, patched in place | `ifcopenshell` |
| Operations | **15 of 96**, conformance-verified | All 96, **discovered at runtime** |
| Undo | Snapshot — always works | Inverse replay — only where the server has one |
| Offline | Yes | No |

Operations the active kernel can't perform are **dimmed with the reason**, never hidden. You see the
whole tool surface and learn what connecting a server would unlock. Both kernels are held to the same
published conformance suite (`@massing/kernel-conformance`), so a third-party kernel is a
supported thing to write rather than a reverse-engineering exercise.

Read [docs/architecture.md](docs/architecture.md) for the package graph and the layering rules CI
enforces.

## Packages

Core packages are **framework-agnostic vanilla TypeScript** — no React, no DOM — so they are usable
from any host, including massing's own vanilla-DOM app. React appears only in the shell.

| Package | What it is |
|---|---|
| `@massing/core` | Document model, GUID identity, units |
| `@massing/kernel-api` | The `KernelProvider` contract |
| `@massing/kernel-conformance` | The contract suite every kernel must pass |
| `@massing/kernel-memory` | A reference kernel that passes it — the template for writing your own |
| `@massing/geometry-math` | Object snapping, polar tracking, dynamic input, CAD command grammar |
| `@massing/ui-model` | Ribbon and palette layout model — pure data, no DOM |
| `@massing/catalog` | The parametric element palette |
| `@massing/viewport` | three.js + `@thatopen` rendering (the only package that imports three) |
| `@massing/drawings2d` | Plan/section generation, SVG + DXF + PDF output |
| `@massing/markup-ui` | BCF-native issues, pins, and Tool Sets |
| `@massing/ui-react` | Ribbon, command palette, command line, docking |

`@massing/geometry-math` is deliberately useful on its own:

```bash
npm i @massing/geometry-math
```

```ts
import { resolveSnap, polarConstrain, segmentSnaps } from "@massing/geometry-math";

const candidates = segmentSnaps([{ x: 0, z: 0 }, { x: 5, z: 0 }], /* closed */ false);
resolveSnap({ x: 4.98, z: 0.01 }, candidates, 0.1);
// → { x: 5, z: 0, kind: "endpoint", dist: 0.0224 }
```

## Roadmap

| Milestone | Ships | State |
|---|---|---|
| M0 | Repo, CI gates, 2D engine bake-off, sample fixtures | ✅ done |
| M1 | Walking skeleton — load and orbit a model, zero backend | ✅ done |
| M2 | `geometry-math` + `commands` published | ✅ done |
| M3 | `kernel-api` + conformance suite + `RemoteKernel` | 🔨 `RemoteKernel` passes the suite against a behavioural stub. The recipe ledger's `remote` column stays at 0, because filling it needs a run against a real massing server — see [docs/kernels/authoring.md](docs/kernels/authoring.md) |
| M4 | `LocalKernel` — **author offline** | ✅ done, 15 of 96 operations, ratcheted |
| M5 | 2D drawings + markup — **the full loop** | ✅ **done.** SVG, DXF, PDF and BCF export, plus all three golden tiers: semantic digests and structural assertions per PR, and nightly rasterisation against pinned `resvg`. Door and window openings are cut into plans; non-rectangular profiles are drawn solid and reported |
| M6 | Authoring tools, gizmos, inspector | ✅ **done.** Wall/slab/column with snapping, a construction grid, a dynamic-input HUD and typed imperial dimensions — M6's own acceptance test passes in E2E — plus a move/rotate/push-pull gizmo and a property inspector. Storey planes and a guide underlay remain, and are M10 |
| M7 | React ribbon shell, accessibility, i18n | 🔨 ribbon, docking, palette, `axe-core` at serious+ and the i18n framework done. German is complete but **not native-speaker reviewed**, which the gate prints on every run, and no tool carries `aria-pressed` — see [docs/accessibility.md](docs/accessibility.md) and [docs/i18n.md](docs/i18n.md) |
| M8 | Enterprise hardening → `1.0.0` | 🔨 sinks, telemetry, audit, migrations, flags, CSP and the unified service worker done. The memory-leak gate is absent and is the expensive omission |
| M9 | massing consumes `@massing/*` | 🔨 `packages/embed` is the facade; massing has not adopted it |

## Design principles

These are load-bearing, not aspirational. Each is enforced by a test or a CI gate.

1. **Elements are referenced by IFC GlobalId, never by transient viewer IDs.** Viewer IDs change
   between loads; a markup anchored to one is a markup that silently detaches.
2. **A control that cannot do what it says is worse than an absent one — so dim it and say why.**
   A greyed button reading *"needs Editor"* is onboarding. A missing button is a support ticket.
3. **Nothing blocks the main thread.** CSG, section cutting, IFC parsing and drawing generation all
   run in Workers with a cancellable job queue. Retrofitting this is a rewrite, so it is structural:
   the kernel API is async and has no synchronous path to accidentally take.
4. **A drawing that is missing an element must say so.** Every generated drawing carries the list of
   elements that failed to section, and its GUID coverage. A plan silently missing a wall renders
   perfectly and lies.
5. **Permissive licenses only.** MIT/BSD/Apache/MPL/BSL. CI refuses GPL, LGPL, AGPL and
   source-available dependencies on the transitive tree.
6. **Offline is the default, not a mode.** Every WASM binary, font and tile is served from origin.
   CI fails if a build references a third-party host.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: Node 24, `npm install`, `npm run verify`, sign your
commits off with `-s`.

Security issues: please use [private vulnerability reporting](https://github.com/MassingCloud/MassingViewer/security/advisories/new)
rather than a public issue. See [SECURITY.md](SECURITY.md).

## Related projects

| | |
|---|---|
| [ibuilder/massing](https://github.com/ibuilder/massing) | The full construction platform this was extracted from. MassingViewer is its Design Room, standing alone. |
| [MassingCloud/massingifc](https://github.com/MassingCloud/massingifc) | The kernel contracts and plugin SDK this builds on. |
| [MassingCloud/massing-pdf](https://github.com/MassingCloud/massing-pdf) | The PDF engine behind sheet markup. |
| [MassingCloud/massingviser](https://github.com/MassingCloud/massingviser) | Unrelated, despite the adjacent name — a separate Python project. |

## License

MIT. See [LICENSE](LICENSE), and [NOTICE](NOTICE) for provenance.
