# Performance budgets and trend

Two files, and they do different jobs. `budgets.json` catches a **regression of a kind** — an accidental O(n²), a
per-element allocation, a synchronous call that used to be batched. `trend.jsonl` catches **slow drift**, which no
single run can see, because each step is inside the band.

Run it:

```bash
node scripts/perf-drawings.mjs
```

## The budgets are not yet real

Every entry carries `"baselined": false`, and that flag is load-bearing. The numbers were measured on a developer
machine and multiplied by three for runner headroom. **Three is a guess, not a measurement.** Until a nightly run
exists to baseline against, the gate can only catch a regression bad enough to blow through a 3.6× margin
(3 × the +20% band).

To fix it properly: let the nightly run for a week, read `trend.jsonl`, set each `p95Ms` to the observed p95 across
runs, and set `baselined` to `true`. The "less than half its budget" hint stays suppressed until then — while every
number is a placeholder it would fire on all five cases every run, and five notes that are always present are five
notes nobody reads.

## Why the band is ±20% and only fails upward

The plan states the failure mode directly: *"a tight gate on noisy runners trains people to ignore it."* A GitHub
runner varies by more than 2× between a cold and a warm machine, so a 5% gate fails on infrastructure and everyone
learns to press re-run — at which point it has stopped being a gate. That is risk #11 on the register.

Faster than budget is **never** a failure. A gate that says "you improved it, now update the number" is the most
reliable way to teach people to reach for `--update`.

## The two case families, and why both exist

| Case | Shape | What it measures |
|---|---|---|
| `small`, `medium`, `large` | 1, 5, 20 storeys | **Realistic.** A plan sections one floor and rejects the rest on a vertical-extent test, which is what the product does. The absolute budgets are set against these |
| `floor-small`, `floor-large` | 1 storey, 200 vs 5000 elements | **Like-for-like.** Every mesh crosses the cut plane, so per-mesh cost is comparable between them. This is the pair the scaling check uses |

The split exists because of a mistake worth recording. The first version of this script compared per-mesh cost
between `small` (40 meshes) and `large` (10 000 across 20 storeys) and reported scaling improving from 26 µs/mesh to
1 µs/mesh. That comparison was meaningless: the small figure was dominated by JIT warm-up and the large one by cheap
rejections, so the ratio measured the *mix of the workload*, not the cost of the work. A quadratic sectioner would
have passed it comfortably. The `floor-*` pair changes only how many elements are actually sectioned, so the ratio
means what it claims.

## `floor-large` exceeds the 50 ms long-task budget, and that is the finding

5000 sectioned elements on one floor takes roughly 100 ms. The plan's long-task rule is *"nothing >50 ms on the
golden path"*, so this case would block the main thread through several frames.

It is not a bug to fix in the sectioner — it is the argument for the architecture that already exists.
`LocalKernel` is Worker-only *by construction*: the API is async and there is no synchronous path a caller could
accidentally take. Drawing generation belongs on the same side of that boundary. This case is here to keep the
number visible rather than to be optimised away.

## Reading the trend

Two trend files, one per measurement: `trend.jsonl` for drawing generation, `frames.jsonl` for viewport frame time.
One JSON object per nightly run:

```json
{"commit":"abc123","at":"2026-08-08T02:00:00Z","results":[{"id":"small","p95":1.7,"perMeshUs":25,...}]}
```

**They are uploaded as artifacts, not committed — and this paragraph used to say the opposite.** It read
*"append-only and committed… because a trend that lives for 90 days in artifact storage is a trend nobody can read
six months later"*, which is a good argument for a thing that was never set up: neither file has ever been tracked
by git. The nightly has `contents: read` and cannot push, so "committed" would have meant a human downloading an
artifact and committing it every morning, which nobody was ever asked to do.

The reasoning still stands and is now a known limitation rather than a false claim: **the band described above has
to be set within the artifact retention window** (14 days), or from a trend nobody kept. Making it true would mean
either a job with write permission that commits its own results — which is a supply-chain surface for a number — or
an external metrics store. Neither is worth it yet at one nightly run a day; what is worth it is not claiming the
discipline exists.

## What is not measured here

- **Frame time.** `generatePlan` has no DOM and no GPU; measuring it through a browser would add SwiftShader's
  variance to a number that has nothing to do with rendering. Frame time is a browser measurement and belongs with
  the visual-regression job.
- **Memory.** The plan asks for a leak gate — mount, load, author 50, unmount, force GC, assert
  `renderer.info.memory` back to baseline, `THREE.Cache` empty, zero pending animation-frame callbacks. It calls
  this the most-neglected gate for a long-lived three.js app. It does not exist. Recorded in
  `.github/workflows/nightly.yml`.

## Main-thread blocking, measured 2026-08-13

`e2e/longtask.spec.ts` (run it with `LONGTASK=1`) observes the Long Tasks API across the golden path — load, author,
cut, sheet, export — and prints every task over 50 ms with the step it landed in.

**Finding: cutting a plan blocks the main thread for roughly 450 ms.** `generatePlan` runs synchronously in the demo,
and sectioning is exactly the work the plan expects to live in a Worker (risk #5, *main-thread stalls*). Boot lands a
further ~300–700 ms in script evaluation, which is a bundle-size question rather than a threading one.

It is a report and not a gate, deliberately. Two thresholds were tried and both were dishonest: 250 ms fired about one
run in four, because the cut clears the bar on a warm JIT; excluding the cut, boot alone exceeds it. No number
available from this API separates "the architecture regressed" from "V8 was cold", and inventing one would be the
fourth guessed budget this file already warns about.

The number is how anyone checks whether sectioning has moved off the main thread. It should fall to nothing when it
does.
