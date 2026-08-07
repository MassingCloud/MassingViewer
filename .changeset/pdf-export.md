---
"@massingviewer/drawings2d": minor
---

PDF export: the third pure function of `(Drawing, Theme, Paper)`, and the only one whose markup can come back.

Layers survive as Optional Content Groups so a reviewer can switch off the grid. GlobalIds survive twice — in
marked content inside the page, and in an attached JSON index mapping GlobalId to paper coordinates — so a
markup made in Bluebeam or Acrobat, tools that know nothing about IFC, resolves back to the element it covers.
`toDxf` cannot do that; DXF R12 has nowhere to put it.
