---
"@massing/ui-model": minor
---

Family gallery layout: `galleryFor`, `searchGallery`, `disciplinesIn`.

`DRAFT_ELEMENTS` gave the Build ribbon four things to place. The family library has hundreds across disciplines, and a
flyout listing them alphabetically is a worse tool than four buttons. This turns a flat list of entries into what a
gallery needs: a bounded set of promoted tiles, a grouped overflow, and a ranked search.

In `ui-model` for the same reason `toolbarLayout.ts` is — no DOM, so massing's vanilla app and this repo's React shell
read one table rather than each deciding what a gallery contains. It takes plain entries rather than a `Library`, which
keeps the L1 layer boundary intact and means the same function lays out a gallery over a filtered subset or a host's
own catalogue.

**`visible` caps display, never availability.** `railToolbox.ts` in massing shipped a real bug by capping the toolbox
itself — promoting one tool silently demoted another — so `groups` always holds every entry and a test asserts it at
every cap from 0 to 100.

Promotion is breadth-first: one tile per category before a second from any. "The first six alphabetically" on a real
library means six tiles from whichever category sorts first, which tells a user nothing about what the discipline can
place. A host's `preferred` keys come first, because usage data belongs to the host.

Proxy geometry is marked on the tile. The library is explicit that some families are L200 placeholders, and a user who
places one expecting a detailed component and gets a box has been misled by the tool rather than by the library.

Search is ranked, not fuzzy: exact key, exact label, prefix, substring, then category and IFC class. `@massing/commands`
already carries a fuzzy matcher for the Ctrl+K palette, where the corpus is command titles a user half-remembers; a
family library is a controlled vocabulary someone is reading off a list, and fuzzy matching there produces confident
nonsense.

Rendering and drag-to-place are not in this change.
