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

`trend.jsonl` is append-only and committed. One JSON object per nightly run:

```json
{"commit":"abc123","at":"2026-08-08T02:00:00Z","results":[{"id":"small","p95":1.7,"perMeshUs":25,...}]}
```

Committed rather than left as a CI artifact, because a trend that lives for 90 days in artifact storage is a trend
nobody can read six months later — which is exactly when slow drift becomes visible.

## What is not measured here

- **Frame time.** `generatePlan` has no DOM and no GPU; measuring it through a browser would add SwiftShader's
  variance to a number that has nothing to do with rendering. Frame time is a browser measurement and belongs with
  the visual-regression job.
- **Memory.** The plan asks for a leak gate — mount, load, author 50, unmount, force GC, assert
  `renderer.info.memory` back to baseline, `THREE.Cache` empty, zero pending animation-frame callbacks. It calls
  this the most-neglected gate for a long-lived three.js app. It does not exist. Recorded in
  `.github/workflows/nightly.yml`.
