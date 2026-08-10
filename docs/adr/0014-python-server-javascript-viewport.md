# ADR-0014 — Python and Rust on the server, compiled JavaScript in the viewport, and where Reflex fits

- **Status:** **Accepted** (2026-08-09)
- **Date:** 2026-08-09

## Context

Two related proposals arrived together: do as much server-side work as possible in pure Python and Rust, and
consider [Reflex](https://reflex.dev) so the product ships *the least possible client-side JavaScript* while keeping
the same or better viewer quality for builders.

The first is right and is already the direction. The second needs a boundary drawn, because the phrase "least
client-side JavaScript" turns out to describe two different things, and only one of them is achievable.

`modelmaker` is confirmed as the platform to integrate with. `massingviser` is analysed below rather than adopted
wholesale.

## What Reflex actually is

Verified rather than assumed, because the decision turns on the mechanism:

- Reflex **compiles Python into a Next.js + React single-page app** with a FastAPI backend.
- Only the UI is compiled to JavaScript; **application logic and state stay in Python on the server**.
- The frontend talks to the backend **over a WebSocket** — events go up, state diffs come down.
- It can **wrap third-party React components**, which is the important part for us.

So Reflex does not remove client-side JavaScript. It removes *hand-written* client-side JavaScript, and ships a
generated React bundle instead. Those are different goals and worth separating: if the aim is "author less JS",
Reflex delivers it; if the aim is "the browser downloads and runs less JS", it does not.

## The evidence already in the org: `massingviser`

`massingviser` is the experiment. It describes itself as *"a federated AEC platform in pure Python: plugin kernel,
15 capability families, content-addressed version control, server-side geometry, browser viewer"* — 151 Python
files, and a `viewer/` layer built on `viser`, which is WebSocket-driven Python 3D.

Its browser layer, measured from the repository tree:

| File | Size |
|---|---|
| `web/vendor/three.module.min.js` | **687 KB** |
| `web/vendor/OrbitControls.js` | 32 KB |
| `web/src/viewer.js` | 9 KB |

**The pure-Python platform ships three.js to the browser.** That is not a criticism of it — it is the honest
outcome of putting 3D in a browser at all, and its own README is straightforward that the viewer is *"a browser
layer thin enough to be worth reading"*. What it demonstrates is that "pure Python" describes where the *logic*
lives, not the absence of a JavaScript renderer.

It is also worth being precise about what its viewer does: three massing blocks on a site, a panel that sketches
and extrudes. That is a massing viewer. It is not a CAD authoring surface with snap resolution on pointer-move, a
drag-in-progress gizmo, and typed dynamic input.

## Decision

**Python and Rust own the server. Compiled JavaScript owns the viewport. Reflex is welcome at the shell, and the
viewport is mounted into it as a React component.**

Three parts:

1. **Server-side geometry, analysis and orchestration in Python — extended, not reduced.** `massingviser` already
   does BVH picking, frustum culling, clash, LOD and crease-aware tessellation in Python. That is directly relevant
   to this repository's deferred Rust decision: it may mean Python is sufficient, or it may show where the ceiling
   is. Either way it is a measurement we can borrow rather than repeat. Recorded in `docs/roadmap.md` as an input
   to the scale-benchmark item, which is the gate on any Rust work.
2. **The interactive viewport stays a client-side renderer.** Not preference — latency. Snapping resolves on every
   pointer-move against a candidate grid with a 0.35 m tolerance; the gizmo drags at frame rate; dynamic input
   updates a HUD per keystroke. Reflex's model puts a WebSocket round trip between the event and the state change.
   At 20–100 ms per round trip that is not a slower CAD tool, it is a different one — you cannot convincingly snap,
   drag a handle, or orbit. `viser` has the same property, which is why `massingviser`'s viewer is a block viewer.
3. **Reflex, if adopted, hosts the platform shell and mounts `@massing/embed` as a component.** Project lists,
   admin, permissions, issue tables, takeoff reports, schedule and cost views are CRUD, and Reflex is strong at
   CRUD in Python. Because it wraps third-party React components, the viewer goes in as one — keeping its own local
   state and its own frame loop. That is the arrangement that gets the "author almost no JavaScript" outcome without
   putting a socket in the snapping path.

## Consequences

**Offline survives, and it would not otherwise.** *"The model never leaves your browser"* is this product's
headline claim, and the whole of `LocalKernel`, the unified service worker (ADR-0010), the COOP/COEP posture and
the E2E offline test presume no server. A Reflex page cannot function without a live WebSocket to a Python process.
Any Reflex adoption is therefore **additive at the shell**, and the viewer must remain independently loadable —
otherwise the offline claim has to be withdrawn, which is a product decision far larger than a framework choice.

**Nothing already built is discarded.** 23 published packages, 1,193 tests and the M9 integration with massing stay
as they are. A Reflex shell consumes `@massing/embed`, which is the same facade massing consumes — one seam, two
hosts, which is exactly what that facade was built for.

**`massingviser` is analysed, not merged.** It and `modelmaker` both have federation designs; `modelmaker` is the
platform. What is worth taking from `massingviser` is specific and server-side: the Python geometry pipeline, the
capability-family contracts, and the content-addressed versioning idea. What is not worth taking is a second
browser viewer.

**One thing this ADR does not claim:** that a Reflex shell is the right choice for this product. That is a product
decision about who maintains the shell and in which language. What it settles is narrower and sufficient — *if*
Reflex is adopted, this is the boundary, and the viewport is not on the Python side of it.

## Alternatives rejected

- **Reflex all the way down, including the viewport.** Would require the snapping engine, the gizmo, the prompt
  loop and the dynamic-input HUD to round-trip to Python per pointer event, and would end the offline claim. It is
  the one option that cannot deliver "the same or better level of detail and quality in the viewer".
- **A Python-driven viewer via `viser`.** The same architecture as the above with a different label, and
  `massingviser` shows the result: a capable block viewer, not a CAD authoring surface.
- **Rewrite the client in Python and keep three.js as a dumb renderer.** This is the version that sounds
  achievable. It fails on the same latency boundary: the moment interaction state (what is snapped, what is being
  dragged, what has been typed) lives on the server, every frame of feedback is a round trip.
