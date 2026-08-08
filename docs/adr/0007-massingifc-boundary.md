# ADR-0007 — MassingViewer is the runtime; massingifc is the contract layer

- **Status:** Accepted
- **Date:** 2026-08-06

## Context

`MassingCloud/massingifc` was expected to be three small vendored files. It is a **23-package MIT
monorepo**, and several of its packages overlap directly with what MassingViewer was about to build:

```
analytics  authoring  coordination  core-kernel  digital-twin  engine-bridge  estimating-5d
family-libraries  federation  icdd  integration  interop  markup  massing  planning-4d
plugin-sdk  procurement-field  project-schema  storage-browser  storage-node  ui-shell
viewer-runtime  viewer-thatopen
```

What it already contains matters:

- `packages/viewer-runtime` defines `ViewerRuntime`, `ModelLoaderService`, `SelectionService`,
  `VisibilityService`, `PropertyService`, `SpatialTreeService`, `ViewpointService` and
  `SectioningService` as capability tokens — free of `three` and `@thatopen`.
- massingifc's `authoring/src/contracts.ts` defines `GeometryBackendToken`, `EditOperation`,
  `AuthoringSessionService`, `PublishService`, `SketchPlaneService`, `ConstraintService`.
- massingifc's `core-kernel/src/plugin-host.ts` is ~550 lines with the hard property **no plugin can crash
  the host**: it wraps `activate` in a result-returning attempt, rolls back *partial* activation (a
  half-activated plugin with live commands and dead invariants is worse than an absent one), quarantines a
  failed plugin so an automatic retry cannot become an activation loop, and topologically sorts
  dependencies while reporting **the actual cycle** rather than "there is a cycle".
- `scripts/check-architecture.mjs` already enforces that only one package may import `three`.

Every package in it is `"private": true`, which is the sole reason massing vendors three of them into
`apps/web/src/vendor/massingifc/` rather than depending on them.

Two problems follow. First, the planned `@massing/*` package set collides by name: both would own a
`markup`, and both would appear to own a kernel and a plugin host. Two competing kernels in one GitHub
organisation is precisely the drift that massing's own `apps/web/vendorAlias.ts` doc comment complains
about ("three copies of one fact is the drift shape this codebase keeps paying for"). Second, rebuilding a
plugin host is waste — and would get the details above wrong, since each one reads as a lesson learned the
hard way rather than a design sketch.

## Decision

**massingifc is the contract and schema layer. MassingViewer is the runtime.** MassingViewer sits on top,
does not fork it, and does not re-derive its contracts.

Concretely:

1. **Reuse the plugin host.** `@massingifc/core-kernel`'s `PluginHost` and `CommandBus` are adopted as-is.
   `@massing/plugin-host` is an *adapter* over them (declarative contribution manifests, lazy
   activation events, a worker transport, asset-pack loading) — not a second host.

2. **`KernelProvider` is a new contract, and the reason is specific.** massingifc's `GeometryBackend` is
   *operation-level* — `EditOperation` is shaped like `{ kind: "move-element", element, transform }`.
   massing's authoring reality is *recipe-level*: 96 named recipes with per-recipe parameter bags,
   guardrails, and namespaced plugin recipes. There is no `Matrix4` that expresses
   `add_connection_assembly` or `program_fit`. So `KernelProvider` is the coarser, correct port — and
   `packages/kernel-api` ships `geometryBackendFromKernel()` so existing massingifc authoring plugins run
   against both kernels unchanged. The ecosystem does not split.

3. **Rename to remove the collision.** MassingViewer's markup packages are named so that it is unambiguous
   which side of the boundary they sit on.

   **Amended 2026-08-07, when the package was actually built.** This originally said the package is
   `markup-ui`, "making it unambiguous that the *contract* is upstream and the *UI* is here". That framing
   turned out to be wrong about what got built: `@massing/markup` is the BCF 3.0 domain model, the
   anchoring logic and the `.bcfzip` writer — no DOM, no renderer, and in the same *kind* of layer as the
   upstream contract package rather than above it.

   Calling it `markup-ui` would have been two mistakes. It would describe a DOM-free model as UI, and it would
   spend the one accurate name on the wrong package — the React pin palette and PDF surface still need to be
   called something, and `markup-ui` is what they are.

   So: **`@massing/markup`** is the model, and `markup-ui` is reserved for the presentation layer that
   consumes it. The collision this point worried about is a *human* one rather than a technical one — npm scopes
   already make `@massing/markup` and `@massingifc/markup` different packages — and the honest way to
   address confusion is that the two do different things and say so, not that one carries a misleading suffix.

4. **Depend, do not re-vendor.** Copying 18,192 lines of another repo's source into a package meant to be
   published is not viable: path aliases do not survive publication, `apps/web/vendorAlias.ts` only works
   because Vite, Vitest and `tsconfig` paths are all under one roof, and both upstreams are already MIT so
   there is no licensing reason to copy.

## The blocking prerequisite

`@massingifc/{core-kernel,plugin-sdk,project-schema}` must be **published to npm**. They are `private: true`
and unpublished today, so the work is: flip `private`, add `publishConfig` with public access and
provenance, add a changesets release workflow, tag. Publish only the three packages massing actually
consumes (verified against `apps/web/vendorAlias.ts`); the other twenty stay private until someone needs
them. Same for `@massingcloud/pdf-viewer` from `MassingCloud/massing-pdf`.

**Fallback if that slips:** carry the vendored trees exactly as massing does, confined to a single
a single vendor-bridge workspace workspace with one source-of-truth alias map and the assertion that keeps
`tsconfig` paths honest. Swapping to npm dependencies is then a one-file change. Treat it as a **two-week
bridge with a CI-enforced expiry date recorded here**, not as a plan.

## Consequences

- One upstream ask: `PluginHost.register` takes a plugin *object*, but lazy activation needs registering a
  *manifest* without importing the module. Two ways to solve it — upstream a `registerDeferred(manifest,
  loader)`, or wrap locally with a `LazyPlugin` whose `activate` performs the dynamic import. **Do the
  local wrapper now** (zero upstream change, works today) and send the upstream PR separately. Do not block
  on someone else's merge queue.
- `packages/viewport` must *provide* massingifc's existing service tokens, so any plugin written against
  the massingifc ecosystem works here unchanged.
- `MassingCloud/massingviser` is an unrelated Python project with a confusingly adjacent name. `README.md`
  disambiguates it explicitly, because the next person to search the organisation will otherwise assume a
  relationship.
- If extending `@massingifc/core-kernel`'s kernel contract proves impossible in practice rather than in
  theory, the fallback is to rename `@massing/kernel-api` to `provider-api` and supersede this ADR
  stating that the two are deliberately separate. That is a worse outcome and should be argued for, not
  drifted into.
