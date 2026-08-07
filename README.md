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

**647 unit tests, 25 E2E tests on Chromium, Firefox, WebKit and iPad, and 9 repo gates** are green.

- **Exports SVG and DXF from one drawing.** Both are pure functions of `(Drawing, Theme, Paper)`, so a DXF a
  consultant opens measures the same as the SVG a reviewer approved — and `dxfLimitations()` states what R12
  cannot carry, including that GlobalIds do not survive a DXF, rather than leaving it to be discovered.

- **A real ribbon**, in vanilla DOM so massing can mount the same code. All 30 inherited tools across nine tabs,
  groups that collapse to dropdowns as the window narrows and **never drop a verb** — asserted at every integer
  width from 320 to 3840 — full keyboard navigation, and controls that dim with a reason instead of vanishing.

What is **not** built: PDF export, the plugin manifest system, and the dockable panel layout. See
[the roadmap](#roadmap).

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
published conformance suite (`@massingviewer/kernel-conformance`), so a third-party kernel is a
supported thing to write rather than a reverse-engineering exercise.

Read [docs/architecture.md](docs/architecture.md) for the package graph and the layering rules CI
enforces.

## Packages

Core packages are **framework-agnostic vanilla TypeScript** — no React, no DOM — so they are usable
from any host, including massing's own vanilla-DOM app. React appears only in the shell.

| Package | What it is |
|---|---|
| `@massingviewer/core` | Document model, GUID identity, units |
| `@massingviewer/kernel-api` | The `KernelProvider` contract |
| `@massingviewer/kernel-conformance` | The contract suite every kernel must pass |
| `@massingviewer/kernel-memory` | A reference kernel that passes it — the template for writing your own |
| `@massingviewer/geometry-math` | Object snapping, polar tracking, dynamic input, CAD command grammar |
| `@massingviewer/ui-model` | Ribbon and palette layout model — pure data, no DOM |
| `@massingviewer/catalog` | The parametric element palette |
| `@massingviewer/viewport` | three.js + `@thatopen` rendering (the only package that imports three) |
| `@massingviewer/drawings2d` | Plan/section generation, SVG + DXF + PDF output |
| `@massingviewer/markup-ui` | BCF-native issues, pins, and Tool Sets |
| `@massingviewer/ui-react` | Ribbon, command palette, command line, docking |

`@massingviewer/geometry-math` is deliberately useful on its own:

```bash
npm i @massingviewer/geometry-math
```

```ts
import { resolveSnap, polarConstrain, segmentSnaps } from "@massingviewer/geometry-math";

const candidates = segmentSnaps([{ x: 0, z: 0 }, { x: 5, z: 0 }], /* closed */ false);
resolveSnap({ x: 4.98, z: 0.01 }, candidates, 0.1);
// → { x: 5, z: 0, kind: "endpoint", dist: 0.0224 }
```

## Roadmap

| Milestone | Ships | State |
|---|---|---|
| M0 | Repo, CI gates, 2D engine bake-off, sample fixtures | ✅ done |
| M1 | Walking skeleton — load and orbit a model, zero backend | ✅ done |
| M2 | `geometry-math` + `commands` published | ⏳ |
| M3 | `kernel-api` + conformance suite + `RemoteKernel` | 🔨 suite + reference kernel done; `RemoteKernel` needs a reachable massing server |
| M4 | `LocalKernel` — **author offline** | ⏳ |
| M5 | 2D drawings + markup — **the full loop** | ⏳ |
| M6 | Authoring tools, gizmos, inspector | ⏳ |
| M7 | React ribbon shell, accessibility, i18n | ⏳ |
| M8 | Enterprise hardening → `1.0.0` | ⏳ |

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
