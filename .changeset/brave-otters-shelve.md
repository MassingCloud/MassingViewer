---
"@massing/assets": minor
---

New package: the family library format, parser and queries.

`MassingCloud/massing-families` holds 419 families and 2,769 types across 57 discipline packs, IFC4, with its
`catalog/` content under **CC0-1.0**. This package ships the format, loader and queries under MIT; the content stays
where it is generated. That is the plan's asset-pack model — *"asset packs are code-free plugins"* — and it is what
keeps a 2,769-type library out of a viewer bundle.

The schema mirrors massing-families' own `_family_index()` output, `snake_case` and all, because a schema invented
to look tidy in TypeScript has to be reconciled with the real JSON on first contact. `parseLibrary` is the single
place that mapping lives, and it is tolerant of unknown fields (the upstream library is actively developed) while
strict about the two an entry cannot be placed without — `key` and `ifc_class` — refusing with a JSON path rather
than a bare "no", because at 2,769 types a refusal nobody can locate is a refusal nobody can act on.

It performs no I/O. The host owns the transport, which is what makes a cached offline pack and massing's live
`GET /families/library` the same code path.
