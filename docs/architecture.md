# Architecture

## The two ideas

Everything else follows from these.

### 1. Every action is one serializable command

Clicking a ribbon button, typing `WALL 0,0 @5<0` on the command line, replaying a macro, and a plugin
calling the API all produce the same `CommandInvocation`. Interactive multi-step commands — AutoCAD's
*"specify next point"* loop — are not an exception: a prompt loop is a **pure reducer** that accumulates
arguments and emits exactly one invocation when complete.

```ts
step<A>(descriptor, state, event, ctx): PromptState<A>   // pure — no DOM, no viewport, no kernel
toInvocation<A>(state, origin): CommandInvocation<A>     // the only exit from interactivity
```

Snap resolution and polar constraint happen *before* the event reaches the reducer, so snapping stays
frame-immediate while the reducer stays deterministic and unit-testable with nothing mocked.

From that one property, seven features fall out rather than being built:

| Feature | How |
|---|---|
| Undo / redo | A serializable inverse invocation, or a kernel transaction rollback |
| Command palette | Filter the registry by `availability()` |
| AutoCAD command line | The verb index feeds the same prompt loop |
| Keybinding remap | `defaultKeys` are defaults; overrides are data, so nothing is hardcoded |
| Macro record / replay | Tee the dispatch stream. The recording is also a regression test |
| Plugin API | A plugin contributes descriptors and dispatches invocations |
| Audit log | The bus is the single choke point, so the log is complete *by construction* |

Multi-user sync is the eighth, later: the invocation stream already *is* an operation log, and `origin`
and `seq` are on the type.

### 2. The geometry engine is pluggable

Authoring goes through `KernelProvider` (`packages/kernel-api/src/provider.ts`), with two intended
implementations:

| | `LocalKernel` (default) | `RemoteKernel` |
|---|---|---|
| Runs | In your browser, in a Worker | Against a massing authoring service |
| Writes IFC with | `web-ifc` + `manifold-3d` + `clipper2-wasm` | `ifcopenshell` |
| Operations | A core set, growing | All 96, **discovered at runtime** |
| Offline | Yes — the model never leaves the browser | No |

Operations the active kernel cannot perform are **dimmed with the kernel's own explanation**, never
hidden. The rationale, and the reason operations are named recipes rather than a geometry API, is in
`docs/adr/0001-two-kernels.md`.

## Package layers

Imports go **down** the stack only. `scripts/check-architecture.mjs` enforces it, including same-layer
edges — those are how a DAG becomes a mesh, and the fix is almost always that the shared thing belongs one
layer lower.

```
L5  embed · cli                      integration surfaces
L4  viewport · ui-react              the ONLY packages that may import three / @thatopen / react
L3  drawings2d · markup-ui · commands · plugin-host · assets
L2  geometry-worker · ifc · kernel-local · kernel-remote      workers and kernels
L1  geometry-math · ui-model · catalog · jobs                 pure algorithms, no DOM
L0  core · kernel-api · kernel-conformance                    vocabulary and contracts
```

### L0 — vocabulary and contracts

| Package | Owns |
|---|---|
| `@massing/core` | Element identity, units, `Result`. Three concerns, each one a place where silent disagreement between subsystems is expensive |
| `@massing/kernel-api` | The `KernelProvider` contract and error taxonomy. **Types only** — a helper that touched `fetch` or `web-ifc` would make it un-implementable from the other side of that choice |
| `@massing/kernel-conformance` | The suite every kernel must pass. Published, so writing a kernel is `npm i -D` and fix the reds |

### L1 — pure algorithms

| Package | Owns |
|---|---|
| `@massing/geometry-math` | Object snapping with priority ties, polar tracking, dynamic input, drawing inference, placement validation, the CAD command grammar |
| `@massing/ui-model` | Ribbon and palette layout as data. Exists so massing's vanilla DOM and the React shell read **one** table — see `docs/adr/0006-react-shell-vanilla-core.md` |
| `@massing/catalog` | The parametric element palette: what can be drawn, which IFC class it becomes, which operation authors it |
| @massing/jobs | The cancellable job queue — **planned, not built.** Unbackticked deliberately: backticks are reserved for things that exist, and this table read as an inventory of shipped packages while naming one that never shipped. |

These omit the `DOM` lib from `tsconfig.json` entirely, so a stray `document` is a type error here rather
than a runtime failure in someone else's environment.

### L2 and above

`geometry-worker` owns `manifold-3d` and `clipper2-wasm`; `ifc` owns `web-ifc`. They are separate workers
on purpose — different WASM, different memory profiles, different threading needs.

`viewport` is the only package permitted to import `three`. Not a style rule: massing's `apps/web/vite.config.ts`
documents `resolve.dedupe: ["three"]` because "Multiple instances of Three.js" was a *measured* failure
there — two copies in one bundle produce objects that fail each other's `instanceof` checks, and the
symptom is geometry that silently refuses to render.

## Three rules with teeth

### Metres, everywhere internally

Every length crossing a package boundary, entering a kernel, or being stored is a number of metres.
Conversion happens at exactly two places: parsing user input and formatting for display.

Stated as a rule because the failure is specific and expensive: once two subsystems disagree about metres
versus millimetres, the bug looks like geometry off by 1000x, and it surfaces in a plan drawing weeks later
rather than at the line that got it wrong.

### GlobalId, never viewer id

An IFC `GlobalId` is stable for the life of an element. A viewer id is assigned when geometry streams and
is valid for exactly that long. Anything that outlives a session — a markup pin, a selection set, an issue,
a drawing entity — must be anchored to a GlobalId.

`packages/core/src/identity.ts` gives them **incompatible branded types**, so you cannot pass one where the
other belongs without going through `ElementRef`, which is the single place the mapping lives. Anchor to a
viewer id and it will appear to work, then quietly point at a different element after the next reload —
with no error and no stack trace.

`resolveRefs` reports `missing` (model loaded, element gone) separately from `unloaded` (model not open),
because "3 pins are in a model you have not opened" is an instruction and "3 pins point at elements that no
longer exist" is data loss. Collapsing them reports a loading state as data loss.

### Refusals are values; bugs are exceptions

A null dereference should throw — nobody but a developer can act on it, and the stack trace is the whole
value. *"That wall is not an extrusion, so it cannot be push-pulled"* is a normal outcome carrying a
message a user is meant to read, and it must survive a worker boundary, a plugin boundary, an undo record
and an audit entry. None of those preserve an `Error`; all of them `structuredClone` an object.

Hence `Result` in `packages/core/src/result.ts`, and hence the plugin host's hard guarantee that no plugin
can crash the host — only achievable if plugin failures arrive as values.

## Threading

Everything expensive is in a Worker, and the contract makes that structural rather than aspirational: every
`KernelProvider` method is `async` and there is **no synchronous escape hatch**, so "just call it inline for
now" is unavailable.

The reason is concrete: `manifold-3d` executes serially, and one boolean on a dense mesh will halt the event
loop. Retrofitting the Worker boundary later is a rewrite.

In a Worker: CSG, 2D booleans and offsetting, IFC parse and write, section cutting, hidden-line removal,
drawing generation, and live metrics. On the main thread: rendering, input, snap resolution against
already-loaded geometry, and the prompt-loop reducer.

## Drawings

Entity geometry is in **model space (metres)**, never paper space. Paper is a render-time transform.

Every entity carries `role` (cut / projection / hidden / below / poche / grid / dimension), `ifcClass`,
`layer`, and — repeating freely, since one element becomes many loops — `guid`. Three things follow:
styling is a stylesheet, so a theme switch is a repaint rather than a regeneration; 2D-to-3D selection sync
works because identity is on every entity; and SVG, DXF and PDF export become three pure functions of
`(Drawing, Theme, PaperTransform)` with no parallel code paths to drift.

Every drawing carries mandatory provenance: which elements failed to section, the GUID coverage, and the
approximations taken. Not optional — **a plan silently missing a wall renders perfectly**, gives no visual
cue, and the person who finds out is on site.

Which engine generates them is deliberately still open: `docs/adr/0004-2d-drawing-engine.md`.

## Plugins, in three tiers

| Tier | Isolation | For | Ships |
|---|---|---|---|
| 0 | Same realm, ESM | First-party modules with declarative contribution manifests and lazy activation | v1 |
| 1 | Web Worker, typed RPC | Trusted plugins: geometry generators, analysis, importers — all of which want to be off the main thread anyway | v1.1 |
| 2 | QuickJS-WASM + sandboxed iframe | Untrusted marketplace plugins, with declared permissions surfaced at install | v2 |

Tier 0 is dogfooded: the entire first-party ribbon is assembled from contribution manifests. If it cannot
be, the contribution model is wrong and we find out in week two rather than when the first third-party
plugin arrives.

**Asset packs are code-free plugins.** One manifest format serves 3D families, 2D blocks, markup stamps,
hatch patterns and sheet templates. That is Bluebeam's Tool Sets — the most-loved and least-copied feature
in AEC software — unified with the family library, and it is the plugin ecosystem's on-ramp.

The plugin host itself is **reused, not rebuilt**, from `@massingifc/core-kernel`:
`docs/adr/0007-massingifc-boundary.md`.

## Provenance

Most of this repo was extracted from [ibuilder/massing](https://github.com/ibuilder/massing). Every
extracted file carries a header naming its origin and upstream commit; `docs/PROVENANCE.tsv` is the
machine-readable ledger; `scripts/check-provenance.mjs` asserts the two agree in **both** directions.

The ledger is not bookkeeping. The weekly divergence report reads it to detect upstream changes to code we
extracted — which is the only thing standing between an extraction and a fork. During the initial
extraction session massing advanced 15 commits in about 90 minutes.
See `docs/adr/0005-clean-history-with-provenance-ledger.md`.

## Where to look

| Question | File |
|---|---|
| What is an element, and what is a length? | `packages/core/src/identity.ts`, `packages/core/src/units.ts` |
| What can a kernel do? | `packages/kernel-api/src/provider.ts` |
| How does a refusal travel? | `packages/kernel-api/src/failure.ts`, `packages/core/src/result.ts` |
| How does snapping work? | `packages/geometry-math/src/snapEngine.ts`, `packages/geometry-math/src/snapOverride.ts` |
| What can be drawn? | `packages/catalog/src/draftCatalog.ts` |
| What is on the ribbon? | `packages/ui-model/src/toolbarLayout.ts` |
| Why is the layering like this? | `scripts/check-architecture.mjs` |
| Which dependencies are refused, and why? | `scripts/check-licenses.mjs`, `docs/adr/0003-license-posture.md` |
