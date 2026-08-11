---
"@massing/drawings2d": minor
"@massing/embed": minor
---

Title blocks, revision tables and scale bars — sheet furniture, as paper-space data.

`sheetFurniture(paper, options)` is a pure function of `(Paper, SheetOptions)`, the same shape as the three exporters,
returning primitive `SheetItem`s that SVG, DXF and PDF each render. `toSvg`, `toDxf` and `toPdf` gain `titleBlock` and
`scaleBar` alongside the existing `border`; `MassingViewer.export` takes a fourth `sheetOptions` argument.

**Furniture is not `DrawingEntity`, deliberately.** ADR-0004's rule is that entity geometry lives in model space in
metres so that paper is a render-time transform. A title block is the opposite: a 60 mm block is 60 mm at 1:50 and at
1:200, and expressing it in metres so a transform could scale it back would make its printed size depend on the
drawing scale. Keeping it separate also keeps `guidCoverage` honest — furniture has no GlobalId and would otherwise
count as element geometry that lost its identity.

Coordinates are declared once, in millimetres with Y **down**, matching the SVG viewBox and the way a person
describes a sheet. DXF and PDF are Y-up and each flip in one visible place. That is the trap `pdf.ts` opens by naming,
and there is now a test per serialiser asserting which half of the page the block lands in.

Absent fields leave their cell **labelled but empty** rather than collapsing the layout: an empty CHECKED BY box is a
drawing nobody has checked, and a tidy block that hid it would hide an incomplete issue sheet. Values too long for a
cell are truncated with an ellipsis, so a clipped value cannot read as a complete one. The block clamps onto paper too
small for it. The scale bar's segments are a round number of **metres**, not of millimetres — a bar labelled "2.37 m"
is useless where one labelled "1 m" is what a scale rule is for.

The demo gains a **Sheet** toggle, so the difference between a plan and an issued sheet is visible rather than
described; its PDF and DXF exports carry the block unconditionally, because a downloaded file has no "preview"
reading.
