# ADR-0015: 2D is a peer of 3D, not a strip of it — and where MassingPDF fits

- **Status**: accepted (the canvas switch), and *partly deferred* (the review desk)
- **Date**: 2026-08-13
- **Supersedes**: nothing. Amends the plan-pane assumption in ADR-0004.

## The complaint

> "the 2d generated plan is really poor compared to what we used to have in massing… with titleblock and all
> the markup tools like in massingpdf."

Fair, and the same complaint upstream had already written down. `apps/web/src/viewer/canvasMode.ts` in `ibuilder/massing`
opens by describing exactly this: the generated plan was `position:absolute; right:0; width:38%`, so *"2D was not a peer
of 3D — it was a 38% strip of it, and the model was always the thing the canvas was."*

A drawing you are meant to read, measure off, and mark up cannot live in a strip.

## Decision 1 — the canvas becomes one thing at a time

Ported upstream's reducer as `@massing/ui-model`'s `createCanvasModeSwitch` (see `docs/PROVENANCE.tsv`). The **mode is
the state** and visibility is derived from it. Two surfaces with independent `hidden` flags have four states and two of
them are wrong — both visible, neither visible — and nothing prevents them except everyone remembering.

`specs` keeps a seat in the type and is not registered here, for upstream's reason: there is no canvas for it, and a tab
that highlights and shows nothing is the failure this repository files under *existence is not arrival*.

### One deliberate departure: the side-by-side stays

Upstream replaced the pane with the mode. This repository keeps **both**, because the pane is load-bearing here in a way
it is not upstream: clicking a line in the plan selects that element in the 3D viewport, and that loop — *a plan is a
live view of the model* — is the thing the market research says nobody has closed. An E2E test asserts it, and it needs
both surfaces visible.

So: `model` mode is the 3D canvas with the plan optionally beside it, and `sheets` mode gives the drawing the whole
canvas, with its title block on. A partial beside the model, with an option to open it full.

## Decision 2 — the sheet turns its own furniture on

In a side pane a title block is noise around a view. Filling the canvas, its *absence* is what looks wrong. So entering
`sheets` turns the title block on rather than leaving the user to find a toggle.

## Where MassingPDF fits, and what actually blocks it

Researched rather than assumed. `MassingCloud/massing-pdf` is now **public, MIT, zero runtime dependencies**, and
describes itself as a *"construction drawing review engine — PDF markup, calibrated takeoff, issue pins, revision
compare, XFDF/BCF interchange… a reusable plugin kernel."* Its plugin surface is the feature set this complaint is
asking for:

`markup` · `markupList` · `measure` · `pins` · `stamps` · `sheets` · `compare` · `search` · `ocr` · `exporters` ·
`attachments` · `specs` · `views` · `toolbar` · `persistence` · `conflicts` · `historical` · `migration`

**The only thing blocking adoption is that `@massingcloud/pdf-viewer` is not on npm** — `npm view` returns 404. The
plan's M0 already names publishing it as a deliverable. Publishing is not this repository's to do.

Three options, and why the third is chosen:

1. **Vendor it by copy.** Rejected, as the plan already rejects it for `massingifc`: it puts another repository's source
   inside a package meant to be published, and path aliases do not survive publication.
2. **Depend on the git URL.** Works with npm, and is a real option if publishing slips. Rejected *for now* because a git
   dependency does not carry a version, and this repository's licence and version gates walk a resolved tree.
3. **Wait for the publish, and build the seam meanwhile.** Chosen. The canvas mode switch is that seam: `sheets` is a
   registered surface with an owner, and swapping our SVG renderer for the MassingPDF viewer inside it is a change to one
   `enter()`, not to the application.

## What this does *not* claim

The `sheets` surface today renders our own SVG sheet — border, title block, revision table, scale bar, and markup pins
anchored to GlobalIds. That is considerably less than MassingPDF's toolset: no calibrated takeoff, no revision compare,
no OCR, no stamps, no XFDF. Those arrive with the dependency, not before it, and pretending otherwise by building a
second half-copy of them here is exactly the duplicate-engine trap that ends this project (risk #1).
