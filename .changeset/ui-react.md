---
"@massingviewer/ui-react": minor
---

New package: React for the parts React is good at.

`Ribbon` is a thin wrapper around the vanilla renderer — mount, update, dispose — because ADR-0009 says the
ribbon must work in massing's plain-TypeScript shell too. `PropertyGrid` shows declared against measured values
and calls out disagreements. `Dock` is fixed resizable regions, deliberately not arbitrary docking, because
reparenting a `<canvas>` loses its WebGL context. `CommandPalette` is a combobox with the ARIA that makes it
usable rather than merely present.
