# ADR-0008 — LocalKernel: own the entity table, borrow the geometry

- **Status:** Accepted
- **Date:** 2026-08-06
- **Supersedes nothing. Constrains:** `packages/kernel-local`, `packages/ifc`, `packages/geometry-worker`

## Context

`LocalKernel` is the reason this product can claim "the model never leaves your browser" (ADR-0001). It has
to do four things no read-only viewer does: **parse** arbitrary IFC from consultants, **author** new elements,
**cut** openings, and **write IFC back out** that other tools accept.

The candidate parts are settled and license-clean under `docs/adr/0003-license-posture.md`:

| Concern | Library | License |
|---|---|---|
| IFC parse + tessellation | `web-ifc` 0.0.77 | MPL-2.0 |
| 3D booleans (openings) | `manifold-3d` 3.5.1 | Apache-2.0 |
| 2D offsets and booleans | `clipper2-wasm` 0.4.0 | BSL-1.0 |

What is *not* settled, and is the whole decision, is **where the authoritative model lives** — and it turns
out that one question determines GUID stability, export fidelity, and whether this tool can be trusted with a
consultant's file.

## The three candidate shapes

**A. web-ifc is the model.** Parse into web-ifc, mutate through its API, serialise with its writer.
Straightforward, and the way most browser IFC editors are built.

**B. Our own reduced document model.** Parse IFC into a clean typed model of the things we understand (walls,
slabs, columns, openings, storeys, psets), edit that, serialise it back to IFC.

**C. Own the STEP entity table; borrow web-ifc for geometry only.** Keep the file's entities as a table we
control — every entity, including the ones we do not understand. Edits insert, replace, or remove *entities*.
Export re-emits the table. web-ifc is used to tessellate and to answer geometric questions, never as the store.

## Decision

**C.** `LocalKernel` owns the entity table. web-ifc tessellates; manifold cuts; clipper2 offsets. None of them
holds the truth.

Two consequences follow, and both are the point rather than side effects.

### 1. GUIDs are ours, and they are never derived

An `expressID` is a *file offset artefact*: it changes when the file is rewritten, and web-ifc hands out new
ones on reparse. A `GlobalId` is the only identifier safe to persist — `packages/core/src/identity.ts` makes
that a type-level distinction, and every markup anchor, plan↔3D link, schedule row, and issue reference in
this product resolves through it.

So: an imported element keeps the `GlobalId` **the file gave it**, verbatim, forever. A created element gets
one minted by us, recorded in the entity table at creation, and never recomputed. There is no code path where
a `GlobalId` is a function of an `expressID`, which means the conformance suite's first and hardest invariant
family — GUID stability across apply / reload / re-serialise — holds *by construction* rather than by
vigilance.

Shape A cannot promise this, because the promise depends on someone else's writer. That is exactly the
"silent divergence between an `ifcopenshell` writer and a `web-ifc` writer" that risk #3 names.

### 2. Export preserves what we do not understand

This is the reason B is rejected, and it is worth stating plainly:

> **An editor that round-trips through its own reduced model is a data-destroying editor.**

A structural consultant's IFC carries analytical members, load cases, and `IfcRelAssigns` we have no concept
for. An MEP file carries distribution systems, ports, and flow segments. Under shape B, opening one of those,
moving a single wall, and exporting silently deletes all of it — and the file still *looks* fine. The person
who finds out is on site, which is the same failure mode this codebase keeps designing against (see
`DrawingProvenance.incomplete` in `packages/kernel-api/src/provider.ts`, and the skipped-element list in the
demo).

Under C, an entity nobody edited is re-emitted byte-for-byte. Editing a wall touches the wall's entities and
nothing else. The tool is *safe to open a file with*, which is a prerequisite for anyone using it twice.

The cost is real and accepted: we maintain a STEP tokeniser and emitter. That is a few hundred lines of
well-understood work — `fixtures/build-sample.mjs` already writes conformant IFC4 and `sample.ifc` is read by
web-ifc — against an unbounded liability. The trade is not close.

### 3. Worker-only, with no synchronous escape hatch

manifold executes serially; a boolean on a dense mesh halts the event loop. `KernelProvider` is async on
*every* method for this reason (see its doc comment), and `LocalKernel` is constructed with a Worker or not at
all. There is no in-process mode "for tests" — the conformance suite drives it through the same boundary the
app does, because a test-only sync path is how the boundary erodes.

## Consequences

- **`packages/ifc`** owns the entity table, the tokeniser, the emitter, and the web-ifc bridge. It is the only
  package that knows what a STEP line looks like.
- **`packages/geometry-worker`** owns manifold and clipper2 behind an async, cancellable job API. It knows
  nothing about IFC.
- **`packages/kernel-local`** composes them into `KernelProvider`. It declares
  `transactions: "snapshot"` honestly — snapshotting an entity table is cheap, so unlike `RemoteKernel` it can
  promise undo.
- **Openings are a boolean, and that is visible.** `manifold` produces the cut mesh; the entity table still
  records `IfcOpeningElement` + `IfcRelVoidsElement`, so the *file* stays semantic even though the *render* is
  a boolean result. Exported IFC therefore opens correctly in tools that do their own voiding.
- **Partial op coverage ships honestly.** `LOCAL_OPS` starts at the ~15 recipes covering the Architectural
  group, the transform gizmo, push/pull, and the command line's verbs. Everything else returns `unsupported`
  with the hint that names the service, the ribbon dims it with that sentence, and the parity ledger that
  `describeRecipeParity` in `packages/kernel-conformance/src/index.ts` consumes makes the number a ratchet.
  See ADR-0001.

## What would change this decision

If web-ifc gains a writer that provably preserves unmodelled entities *and* guarantees `GlobalId` stability
across a rewrite, shape A becomes cheaper than C at equal safety, and the entity table becomes dead weight.
That is a testable claim: the conformance suite's GUID-stability family plus a round-trip byte-preservation
test on a structural fixture would answer it in an afternoon. Until then, we own the table.
