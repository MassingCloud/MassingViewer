---
"@massing/viewport": minor
---

`three` moves to `peerDependencies`, and the trio aligns with massing's.

`three` is now `0.185.1` (was `0.184.0`) and `@types/three` `0.185.4` (was `0.184.1`), matching the versions
modelmaker runs in production. It was ahead on both, and dragging a production viewer *backwards* to satisfy a
library is the wrong direction.

The more consequential half is that **`three` is a peer dependency rather than a direct one**. `three` holds
module-level state — the `WebGLRenderer` registry, `Layers` masks, and the `Cache` the memory-leak gate asserts is
empty — so two copies in one bundle do not merely waste bytes: `instanceof` fails across them and raycasting
silently misses. The symptom is "picking stopped working", with no error. A direct dependency invites npm to
install a second copy beside the host's; a peer makes it the host's to supply, and mismatches become a warning at
install time instead of a mystery at runtime. The plan flags this because it is a **measured** failure in massing,
which carries the same note in its own Vite config.

Hosts must now declare `three` themselves — `apps/demo` now does, having imported it directly all along without
declaring it — and should add `resolve.dedupe: ["three"]`, which `apps/demo` also now does.
