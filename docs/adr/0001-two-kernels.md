# ADR-0001 — Two kernels behind one contract

- **Status:** Accepted
- **Date:** 2026-08-06

## Context

MassingViewer is extracted from the Design Room of [ibuilder/massing](https://github.com/ibuilder/massing),
where **all authoring is server-side**: 96 named recipes in `services/data/src/aec_data/edit.py`, executed
by `ifcopenshell` behind a FastAPI service, with Postgres and MinIO underneath. Every user gesture ends in
`POST /projects/{pid}/edit`, then a poll for publish, then a geometry re-stream.

That architecture is good — `ifcopenshell` is the reference implementation for authoring IFC correctly,
and the recipes carry guardrails that a client cannot enforce. But it means the Design Room **cannot be
handed to someone as a URL**. It needs a Python service, a database, an object store, and an account. The
product goal is the opposite: a standalone tool a person can open and use.

Three options were considered:

1. **Client-side only.** Rebuild authoring in TypeScript. Truly standalone, simplest to host — and
   permanently divergent from massing's 96 recipes, with no path back.
2. **Bundle the Python service.** Ship a docker-compose file. Full fidelity on day one, reusing
   `services/data/src/aec_data/drawings.py` as-is — but "standalone" now means running Docker, which is
   not a link you send someone.
3. **One contract, two implementations.**

## Decision

**Option 3.** Authoring goes through a single `KernelProvider` interface in `packages/kernel-api`, with two
implementations:

- **`LocalKernel`** — `web-ifc` (MPL-2.0) for IFC read/write, `manifold-3d` (Apache-2.0) for CSG,
  `clipper2-wasm` (BSL-1.0) for 2D booleans and offsetting, all in a Web Worker. Fully offline. The model
  never leaves the browser. **This is the default.**
- **`RemoteKernel`** — an HTTP adapter to a massing authoring service. All 96 recipes, discovered at
  runtime rather than compiled in.

Two design choices make this honest rather than aspirational.

### Capabilities are declared, and the declaration is tested

`LocalKernel` will implement a fraction of what the remote service does, for a long time. The tempting
move is to hide the rest of the UI when running locally. That produces a worse product: the user cannot
discover what exists, and cannot distinguish "this tool doesn't exist" from "this tool needs something you
don't have".

So unsupported operations stay visible and **dimmed with the kernel's own explanation** —
`"add_connection_assembly runs on the Massing authoring service. Connect a project to use it."` The `hint`
is a required field on the failure type, so "dimmed for no stated reason" is not representable.

`packages/kernel-conformance` asserts that every operation a kernel *claims* actually works, and that
every operation it does *not* claim returns `unsupported` rather than throwing, hanging, or silently doing
nothing. A kernel that lies about its capabilities fails CI. That is what keeps partial coverage from
becoming quiet breakage.

### Operations are named recipes, not a geometry API

The obvious interface is `move(element, matrix)` / `extrude(profile, depth)`. It cannot express what the
remote service already does: `add_connection_assembly`, `program_fit`, `resolve_wall_joins`,
`derive_analytical`. There is no `Matrix4` that means "fit this program to this envelope".

So an operation is an `OpId` plus a parameter bag, keyed 1:1 with the server's recipe names — no
translation table to maintain. And the operation *set* is discovered at runtime, which is why a recipe
registered by a server-side plugin reaches the ribbon with **zero client change**. That is the difference
between a plugin system and a plugin API.

## Consequences

- Every kernel method is `async`, and there is deliberately **no synchronous escape hatch**. Not for
  elegance: `manifold-3d` executes serially and one boolean on a dense mesh will halt the event loop.
  An async-only contract means "just call it inline for now" is unavailable, so the Worker boundary cannot
  be eroded one convenient call at a time. Retrofitting this later is a rewrite.
- Undo differs between kernels, so `TransactionSupport` is declared rather than assumed. `LocalKernel`
  reports `"snapshot"`. `RemoteKernel` reports `"inverse"`, because the server has no transaction and only
  *some* recipes have inverses. Undo against a remote kernel can therefore return
  `{ kind: "unavailable", reason: "The server cannot reverse 'delete_element'" }` and the button dims with
  that sentence — instead of failing after the user has committed to it.
- GUID stability becomes the single most important thing to test, and the thing most likely to differ
  silently between an `ifcopenshell` writer and a `web-ifc` writer. It is the first invariant family in
  the conformance suite for that reason.
- A third-party kernel is a supported thing to write. `packages/kernel-conformance` is published, so it
  is `npm i -D` and fix the reds rather than a reverse-engineering exercise.

## The deadline this ADR is really about

**massing must stop holding its own copy of this engine.**

Two live copies of an 11,570-line engine is not a plan, it is a fork. Concretely: during the initial
extraction session, massing advanced **15 commits in about 90 minutes**. None touched the extracted files
— verified, not assumed — but the rate is the point.

So: until MassingViewer `0.1.0`, extraction is a **read** of massing and massing keeps shipping normally.
After `0.1.0`, massing's `apps/web/src/viewer` is deleted and replaced with `@massing/*`
dependencies. That is milestone M9 in the roadmap, and it is **not optional and must not slip** — every
week both repos hold a copy is divergence debt at compound interest.

Until then, `docs/PROVENANCE.tsv` plus the weekly divergence report is what keeps the two honest. See
`docs/adr/0005-clean-history-with-provenance-ledger.md`.
