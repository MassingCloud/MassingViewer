# Testing

Seven layers, ordered by how often they run. Layer 2 is the most valuable thing in the repo.

The organising principle: **a gate people trust is worth ten they route around.** Every choice below trades
sensitivity for stability in that direction, and where a check is inherently flaky it runs nightly rather
than per-PR. A visual gate that gets `--update-snapshots`'d reflexively has stopped being a test.

## 1. Unit — pure math

No DOM, no network, no clock. Fast enough to run on save. This is most of
`packages/geometry-math/src/snapEngine.ts` and friends, and the whole of `packages/core`.

**Add property-based tests, not just examples.** Examples pin cases someone thought about; properties pin
the invariant, and the invariant is what a refactor breaks. See
`packages/geometry-math/src/properties.test.ts` — and read its comments, because two of them record real
findings that only a property test surfaces:

- **`resolveSnap`'s tie-break is epsilon-based**, so at exactly 1e-6 the winner depends on array order.
  That is not a defect — one micron is the same point for any construction purpose — but it means the
  contract is "within epsilon of the true minimum", not "the true minimum". The property is stated in those
  terms, and the looser guarantee is now written down instead of assumed.
- **`checkPolygon`'s exact orientation predicate is algebraically winding-invariant but not numerically so**
  at magnitudes around 1e-232, where the determinant underflows through subnormals and loses its sign. Real,
  and irrelevant: no building has a dimension of 1e-232 m, and the placement checks reject anything near it
  first. So the generator is scoped to 0.1 mm – 100 km, which is scoping the property to its domain rather
  than weakening it. A separate example asserts the predicate still returns a *well-formed verdict* on
  subnormals, because a `NaN` escaping the determinant would make every downstream comparison false and the
  polygon silently "valid".

Both notes exist because the honest answer to a failing property is sometimes "the property was wrong" — and
that has to be written down, or the next person re-derives it. The orientation-determinant note went through
two rounds for exactly this reason: the first diagnosis blamed subnormal underflow and bounded the
coordinate magnitudes, and then CI found a second counterexample at 1e-4 on a seed the local run had never
reached. The real cause is catastrophic cancellation when subtracting nearly-equal coordinates, of which
underflow was one instance — so the property is now scoped on vertex *separation* rather than magnitude,
which is the region where a naive determinant can be trusted at all.

**Property runs are seeded by default.** Unseeded, fast-check finds things nobody thought of; it also makes
the suite pass locally and fail in CI, and a gate that behaves differently in two places gets muted. So PR
runs are deterministic and reproducible, and exploration moves to a nightly job with `FAST_CHECK_SEED=random`
that opens an issue with the reproducing seed rather than blocking a PR that did not cause the failure. Run
`FAST_CHECK_SEED=random npm run test` locally before a release.

## 2. Kernel conformance — the executable specification

`@massing/kernel-conformance` is a **published test library**, not a test directory:

```ts
describeKernel("LocalKernel", () => createLocalKernel(), declaredCapabilities);
```

Both first-party kernels call it. So does anyone writing a third kernel — which is what turns "write a
MassingViewer kernel" from a reverse-engineering exercise into `npm i -D` and fix the reds.

Seven invariant families:

| # | Family | Why it is in this order |
|---|---|---|
| 1 | **GUID stability** across apply / reload / re-serialise | The invariant everything rests on, and the one most likely to differ silently between an `ifcopenshell` writer and a `web-ifc` writer |
| 2 | **Refusal parity** — same error *code* for the same bad input | Codes asserted, messages never (they are localised). A test pinning wording either blocks copy improvements or gets updated unread |
| 3 | **Idempotence and commutativity** | Catches hidden global state in the Worker |
| 4 | **Units round-trip** to 1e-9 m | The other half of the metres-only rule |
| 5 | **Version monotonicity** | A stale write must get `version_conflict`, never a silent overwrite |
| 6 | **Capability honesty** | How a partial kernel ships **without lying**: everything it does not claim returns `unsupported` rather than throwing, hanging, or doing nothing |
| 7 | **Recipe parity ledger** | A ratchet over the remote kernel's 96 operations. CI fails on regression and prints coverage |

Refusal parity has one case worth knowing about. massing's server refuses `set_extrusion_depth` on a
non-extrusion, and there is **deliberately no client-side allowlist** — the refusal arrives through the
normal error path. So `LocalKernel` must produce a compatible refusal or that design collapses into "works
against one kernel, silently does nothing against the other".

**Mechanics.** `LocalKernel` runs in-process on every PR. `RemoteKernel` runs against recorded cassettes on
every PR (for speed) and against a live docker-composed backend nightly, with the nightly job failing if the
cassettes have drifted from reality. Cassettes that are never revalidated are fiction.

## 3. Golden drawings — semantic digests, never raw SVG

**Never snapshot SVG text.** It changes on any generator refactor, attribute reordering, or whitespace
change, none of which are regressions — and it fails unreadably, so the reflex is to accept the new output
without reading it.

Three tiers:

**Tier 1 — semantic digest (every PR, the real gate).** Normalise the drawing to a canonical form: per
layer, a sorted list of typed geometry operations, coordinates quantised to 0.1 mm at paper scale, GlobalIds
retained, all `id`/`class`/timestamp/generator-version attributes stripped. Snapshot *that*. It is invariant
to ordering and refactors, it fails on the things that matter (a missing wall, a cut line in the wrong
place, a lost `guid`), and it diffs **readably** — a reviewer sees "layer A-WALL lost 1 polyline at
(3.2, 4.8)".

**Tier 2 — structural assertions (same PR).** Element count by IFC class matches the model. Every drawn
entity's `guid` resolves to a real GlobalId. No geometry outside the sheet border. All text inside its
bounding box.

**Tier 3 — rasterised perceptual diff (nightly, or on a `drawings` label).** `resvg` (Rust, deterministic,
no browser) to PNG, then SSIM against a baseline at 0.995, with the title block masked and the `resvg`
version pinned. This catches what a digest cannot express — hatch pattern changes, line-weight errors —
without gating every PR on pixel luck.

### Updating a golden safely

1. Run the drawing bake-off harness and read the **diff**, not the summary.
2. Confirm the change is intended by naming which entities moved and why. "The generator changed" is not a
   reason.
3. Check `guidCoverage` did not drop. It is the one number that must never regress.
4. Check `incomplete[]` did not grow. A drawing that lost an element renders perfectly and says nothing —
   this list is the only thing that says something.
5. Update, and put the reasoning in the commit message.

## 4. 3D viewport visual regression

WebGL is not deterministic across GPUs, drivers or ANGLE backends. Making it deterministic *enough*:

- Playwright Chromium in a **digest-pinned container**, launched with
  `--use-gl=angle --use-angle=swiftshader --deterministic-mode --force-device-scale-factor=1`.
  SwiftShader is a software rasteriser: identical bytes on any host.
- Remove non-determinism in the scene: fix device pixel ratio to 1, disable MSAA and dithering, fixed tone
  mapping, seeded RNG, frozen clocks.
- **Render N frames, then explicitly read pixels.** massing's hero-capture code documents why:
  `preserveDrawingBuffer` is off, so buffers do not persist between frames and a stale read returns a black
  image. Drive frames from the test rather than waiting on wall time — the frame loop takes an injectable
  frame API for exactly this.
- Baselines are keyed by **renderer signature** (unmasked renderer + Chromium version + container digest).
  A baseline from a different key is a hard failure with a clear message, never a silent pass.
- **Gate on structure, not pixels:** alpha-threshold the render into a coarse occupancy grid and compare
  silhouettes, plus a luminance histogram distance. That catches "the model did not load", "the camera is
  wrong", "geometry vanished". Full SSIM runs nightly only.

**Deliberately no Safari or iPad pixel parity.** Their renderers differ and always will. Chasing it is how
this suite gets abandoned; cross-browser gets functional E2E instead.

## 5. E2E — Playwright

**Matrix: `chromium` + `webkit` + `firefox` on every PR, and `webkit` is a required check.** Safari and
iPad support is a stated differentiator (the nearest competitor is Chrome/Edge only), so it cannot be a
nightly afterthought. iPad runs emulated per-PR plus a **weekly real-device run** — emulated WebKit does not
reproduce real iOS memory pressure or WASM limits, which is precisely where an iPad fails.

### The suite runs serially, on purpose

`fullyParallel: false`, `workers: 1`. This is not a flakiness workaround — it is what the tests contend for.

Every E2E test rasterises WebGL in software (SwiftShader, so the bytes are host-independent), which means they
are all CPU-bound on the same scarce resource. Running them in parallel makes each one *slower*, and slower
frames make the adaptive pixel-ratio governor step the resolution down mid-test. The canvas then changes size
underneath assertions written against its previous size, and pick coordinates shift.

Two failures in the first full run were exactly this, and both were the harness being wrong rather than the app:

| Symptom | Actual cause |
|---|---|
| A click found no element; the same test passed in isolation | Parallel contention. Nothing about the app was wrong. |
| `canvas.w >= container.w * 0.9` failed at 495 vs 990 | The governor had correctly dropped to its 0.5 floor. The assertion was fighting a working feature. |

The lesson generalises: **when a suite shares one saturable resource, parallelism buys nothing and costs
correctness.** The canvas assertion was rewritten to check the buffer tracks the container *at whatever ratio
is currently in force*, and that the ratio is one of the legal steps — which is the real invariant, and now
holds under load instead of only when the machine is idle.

The third failure in that run *was* a real bug: Escape cleared the viewport selection but not the properties
panel, because the click handler and the key handler each held their own opinion about what was selected. The
fix routes both through one `applySelection`, so they cannot disagree. See `apps/demo/src/main.ts`.

Flows:

1. **Local golden path, zero network.** Import a fixture IFC, orbit, select a wall, read its properties,
   generate a plan, place a markup pin, export PDF, export BCF. This is `LocalKernel`'s acceptance test and
   the demo's smoke test in one.
2. **Author flow.** Arm the wall tool, snap to a grid intersection, type `12'6`, commit. Assert the wall
   appears in 3D **and** in the plan with a matching `guid`. This is the only test that exercises snapping,
   imperial parsing and identity together in a real DOM.
3. **Refusal UX.** Author a zero-length wall; assert the refusal surfaces and the tool stays armed. A
   refusal that disarms the tool loses the user's work.
4. **Offline.** Load, go offline, author, reload; assert work persisted.
5. **Capability gating.** Assert unavailable controls are **dimmed with a visible reason**, not absent.

## 6. Performance and memory

- **Frame time:** scripted orbit, gate on p95 with a 20% tolerance band, and report p50/p99 to the job
  summary. A tight gate on noisy runners trains people to ignore it, so the trend is tracked in a committed
  JSON where a regression is visible even while under threshold.
- **Long tasks:** nothing over 50 ms during the golden path. This is the gate that keeps the Worker boundary
  real rather than nominal.
- **Drawing generation:** per-fixture wall-clock budgets.
- **Bundle budget:** per package. Parse the entry from `index.html` rather than filename-matching — massing
  learned that a lazily-loaded vendor chunk whose hashed name happens to start with `index-` gets
  miscounted as shell.
- **Memory leaks** — the highest-value and most-neglected gate for a long-lived three.js app. Mount, load,
  author 50 elements, unmount, force GC, then assert: renderer geometry and texture counts back to baseline,
  the three.js cache empty, JS heap within 5% of pre-mount, **zero pending animation-frame callbacks**, and
  listener counts at baseline. The frame-loop helper exists because an animation loop with no way to stop
  outlives whatever it was drawing for; test that property directly.

## 7. Accessibility

`axe-core` on every route and every open panel, gated at `serious` and above.

Ribbon-specific, beyond what axe can see: keyboard traversal of every tool (roving tabindex, arrows within
a group, Tab between groups), correct toolbar roles and pressed/expanded state, 3:1 focus contrast, focus
returning to the invoking control on close, and live-region announcements for tool arm/disarm and for
refusals.

**State the 3D-canvas limit honestly** in the accessibility docs rather than claiming parity — and name the
alternative, because there is a real one: the CAD command grammar in
`packages/geometry-math/src/cadCommands.ts` means `WALL 0,0 5,0` authors a wall with no pointing device at
all. That is a genuine and underrated accessibility story, and it is worth saying out loud.

## Running things

```bash
npm run test          # layers 1–3, with coverage thresholds enforced
npm run test:fast     # the same tests without coverage — for the inner loop
npm run test:watch    # while working
npm run verify        # lint + typecheck + test + repo gates — what CI runs
npm run gates         # the repo gates alone
```

The repo gates are described in [CONTRIBUTING.md](../CONTRIBUTING.md#repo-gates). Each fails the build
rather than warning, and each one's failure paths are themselves verified — a gate that has never been
observed to fail is decoration, so `scripts/check-architecture.mjs`, `scripts/check-licenses.mjs` and
`scripts/check-provenance.mjs` were each run against deliberate violations before being trusted.

## A flake, and the four wrong diagnoses before the right one

Worth writing down in full, because the *method* transfers and three of the four fixes were plausible.

**The symptom.** Running all four E2E projects locally, about one test per run failed on `webkit` or `ipad` — and
a *different* test each time: the plan click, the units toggle, the discipline switch, a BCF export. Each passed
3/3 in isolation. Each project passed 32/32 alone.

**Wrong diagnosis 1: slowness.** `timeout` went from 30 s to 60 s, since `workers: 1` already exists because every
test rasterises WebGL in software. It reduced nothing — the failures were not near the limit.

**Wrong diagnosis 2: two writers of `#status`.** This *was* a real bug and did fix one test: a 500 ms
`setInterval` overwrote every message the app produced with "7 draw calls · 7 geometries", so a plugin's output was
clobbered before the assertion ran. Chromium's timing hid it; webkit surfaced it. Fixed by giving the perf readout
its own element — the same "two places holding an opinion" pattern the selection code already carries a comment
about. It was not the main cause.

**Wrong diagnosis 3: ambiguous locators.** `getByRole("button", { name: "Plan" })` is a case-insensitive
*substring* match, so it also matches the ribbon's "Section plane" — a genuine fragility, and `name: "m"` had
already broken once. Every header control now uses its id. Also not the cause.

**Wrong diagnosis 4: clicking during startup.** The ribbon relayouts under a `ResizeObserver`, so a click measured
before a shift could land elsewhere. Waiting for kernel-ready in `beforeEach` was reasonable and changed nothing.

**The actual method that worked: make the failure describe itself.** `cutPlan()` replaced a bare
`expect(...).toBeVisible()` — which reports "timeout exceeded" for at least three distinct causes — with a probe
that answers each of them. On the next occurrence it said:

```
atCentre: "button#plan"          the button is at the click point, nothing covering it
inViewport: true                 not scrolled out of view
headerOverflows: false           the header is not even overflowing
planInfo: "Press Plan to cut one"   generate() never ran
page errors: (none)              the handler did not throw
programmaticClickWorks: true     the listener is attached and works
```

Every app-side explanation is eliminated by that block. The listener works; the *synthetic event delivery* is what
intermittently fails on WebKit.

**The fix.** Tests whose subject is the plan pipeline dispatch the event directly with `dispatchEvent("click")`,
which bypasses the input-routing layer that is the flake. Tests whose subject *is* real input keep it — "clicking
an element selects it" drives `page.mouse`, and "pinch zooms" synthesises pointer events against the canvas.
Using `dispatchEvent` there would be testing a mock of the interaction.

Result: four consecutive clean all-projects runs at 105/105, and about 20% faster.

**The transferable part.** Four plausible hypotheses cost more than one good diagnostic. A retry would have made
the suite green immediately and destroyed the only evidence — and two of the four fixes were worth keeping anyway
(the `#status` collision and the locators were real bugs), which is exactly why "it got greener" is not evidence of
a correct diagnosis.
