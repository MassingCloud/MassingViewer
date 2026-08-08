---
"@massing/drawings2d": patch
---

Fix an attribute-name injection in SVG output, and pin the escaping with a security test.

`dataAttrs` escaped attribute *values* but not attribute *names*, so an `attrs` key carrying a quote broke out and
injected an event handler: `{ 'x" onload="alert(1)': '1' }` rendered as `data-x onload="alert(1)="1"`. Escaping
cannot fix that — there is no escape syntax inside an attribute name — so the character set is restricted instead.

`attrs` is author-supplied by a `DrawingProvider`, which is this package's advertised extension point, and the
output is assigned to `innerHTML` by every host that shows a plan.
