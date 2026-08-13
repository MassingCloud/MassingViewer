---
"@massing/ribbon": patch
---

`onGroupKey` and the tablist handler declare `next` without a placeholder initialiser.

Every path through both switches either assigns `next` or returns, so `= current` was dead — and declaring it
without one turns a future `case` that forgets to assign into a compile error rather than a key that silently does
nothing. No behaviour change.

Found by `no-useless-assignment`, now enabled in this repository's lint rather than arriving as a surprise from a
linter bump.
