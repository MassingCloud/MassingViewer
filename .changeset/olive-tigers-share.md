---
"@massing/ui-model": minor
---

A 2D tab with something in it, and markup on Review.

The Sheet tab held one control — a tab that exists and has nothing in it, which is the same failure `unhomed()`
catches from the other direction. It now carries eight verbs this repository owns rather than inherits: cut a plan,
show it full width, restyle it, fit it to paper, export PDF and DXF, raise an issue, export BCF.

None is marked `primary`. The floating bar has a hard cap and promoting a new verb into it demotes an inherited one —
the exact failure `railToolbox` already shipped once. These live in the ribbon, which has no cap.

`GROUP_LABELS` and `GROUP_PRIORITY` gain Drawing, Style, Issue and Markup; without the first, a new group renders its
raw id, which is what the browser showed.
