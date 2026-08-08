# Writing a kernel

A **kernel** is what actually changes a model. MassingViewer ships two — one that runs entirely in your
browser and one that talks to a server — and the interface between them and the rest of the app is small
enough that you can write a third.

Reasons people do: your geometry lives in a proprietary system; you have a solver the built-in ops cannot
express; you want IFC written by `ifcopenshell` rather than by us; you are building a multi-user backend and
need every edit to go through your own CRDT.

## The shape of it

```ts
import type { KernelProvider } from "@massing/kernel-api";
```

One interface. Read it before anything else — `packages/kernel-api/src/provider.ts` is the specification, and
its comments explain the *why* behind each decision rather than restating the types.

Two properties of that interface are worth understanding before you start, because they will shape your
implementation and neither is negotiable.

**Operations are named recipes, not a geometry API.** There is no `move(element, matrix)`. There is
`apply(modelId, "move_element", { guid, dx, dy })`. The obvious design cannot express what a real authoring
service does — `add_connection_assembly`, `program_fit`, `resolve_wall_joins` are domain operations with rich
parameter bags, and there is no `Matrix4` that means "fit this program to this envelope". A consequence you get
for free: because the op set is *discovered* at runtime rather than compiled in, a recipe your server gains
tomorrow reaches the ribbon with no client change.

**Every method is async, and there is no synchronous escape hatch.** Not for elegance. Mesh booleans execute
serially and a single one on a dense mesh will halt the event loop. An async-only contract means "just call it
inline for now" is not available to you, so the worker boundary cannot erode one convenient call at a time.
Retrofitting it later is a rewrite — this is the single most expensive thing to get wrong.

## Start from the suite, not from the interface

```bash
npm i -D @massing/kernel-conformance
```

```ts
import { asModelId } from "@massing/core";
import { describeKernel } from "@massing/kernel-conformance";
import { createMemoryKernel } from "@massing/kernel-memory";

// Your factory. `createMemoryKernel` stands in here so this block compiles as written — the reference
// implementation in `packages/kernel-memory` is also the shortest complete example of the interface.
const createMyKernel = createMemoryKernel;

describeKernel("MyKernel", {
  create: async () => createMyKernel(),
  modelId: asModelId("conformance"),
  createOp: { op: "add_wall", params: { start: [0, 0], end: [5, 0], height: 3 } },
  // One params object per op you support. Required: an op with no entry is checked only for capability
  // honesty, so leaving it out silently reduces what the suite actually exercises.
  sampleParams: { add_wall: { start: [0, 0], end: [5, 0], height: 3 } },
  // Ops you know you do not support, confirmed to refuse cleanly rather than throw or hang.
  knownUnsupported: ["program_fit", "derive_analytical"],
});
```

That is the whole setup. Write it first, watch it fail, and make it pass. It turns "write a MassingViewer
kernel" from reverse-engineering into fixing a list of reds.

`packages/kernel-memory/src/conformance.test.ts` is the file to copy. It is deliberately almost all fixture and
almost no test code — everything asserted lives in the suite, so a new kernel inherits the entire contract by
supplying sample parameters. `packages/kernel-memory/src/index.ts` is a complete reference implementation in
about 600 lines with no WASM, no worker and no server, which exists to prove the contract is satisfiable.

### What the suite actually checks

Eight families, and each one is there because it is a place where two kernels disagree *silently*.

1. **GUID stability** across apply, reload and re-serialise. This is the invariant everything else rests on —
   markup anchoring, plan↔3D selection sync, schedules, issue tracking — and the one most likely to differ
   between an `ifcopenshell` writer and a `web-ifc` writer. Tested first and hardest.
2. **Refusal parity.** Identical error *codes* from a closed taxonomy for the same bad input. Codes are
   asserted, messages are not, because messages get translated.
3. **Idempotence and commutativity** where the operation claims them. Catches hidden global state.
4. **Units round-trip** to 1e-9 m.
5. **Version monotonicity.** A stale write gets `version_conflict`, never a silent overwrite.
6. **Capability honesty.** Everything you declare in `ops()` must work; everything you do not declare must
   return `unsupported` — not throw, not hang, not silently do nothing.
7. **Read consistency.** The spatial tree, properties and snap candidates agree with what `apply` reported.
8. **Disposal.** `dispose()` is idempotent and releases whatever you hold.

Family 6 is the one people are surprised by, and it is the most important. **You are expected to ship at
partial coverage.** `LocalKernel` implements 15 of the 96 operations the remote service does. What is not
allowed is being vague about which 15.

## Be honest, in the two places the type system makes you

### `capabilities`

```ts ignore
readonly capabilities: KernelCapabilities;
```

Cheap and synchronous, because the ribbon reads it per control per render. Declare what is true, not what you
intend:

- `transactions: "snapshot" | "inverse" | "none"` — **the important one.** `LocalKernel` says `snapshot`
  because it can restore a prior state cheaply, so undo always works. `RemoteKernel` says `inverse` because
  the server has no transaction and only *some* recipes have inverses. That declaration is why Undo can dim
  itself with "the server cannot reverse 'delete_element'" instead of failing *after* the user commits to it.
- `identifiedLinework` — whether your generated drawing entities carry the GlobalId of the element they came
  from. Pass/fail for the product, not a nice-to-have: without it, plan↔3D selection does not work and a markup
  has nothing to anchor to. A kernel reporting `false` can render pictures but cannot join the review loop, and
  the UI will say so rather than appear to work.
- `drawings: DrawingKind[]` — leave it empty if you do not generate drawings. `LocalKernel` currently does, and
  its `drawing()` refuses to match. Declaring `"plan"` and failing at call time is precisely what family 6
  fails you for.

### `unsupported(op, hint)`

```ts ignore
return err(unsupported(op, `"${op}" runs on the Massing authoring service. Connect a project to use it.`));
```

`hint` is **required**, and it is shown verbatim as the dimmed control's tooltip. Write it as an instruction,
not as an error: only your kernel knows what would unlock the operation.

This is the house rule promoted into the type system. Unsupported operations stay **visible and dimmed, never
hidden** — because a user cannot discover what exists in a UI that hides it, and cannot tell "this tool does not
exist" from "this tool needs something I do not have". *A dimmed button that says "needs Editor" is onboarding;
a missing one is a support ticket.*

## Refuse with the right code

The taxonomy is closed (`packages/kernel-api/src/failure.ts`), and picking the right member is what lets the UI
say something useful:

| Situation | Code |
|---|---|
| A well-formed number that produces an impossible shape — a zero-length wall | `degenerate_geometry` |
| A malformed or missing parameter | `invalid_param` |
| The element exists but is not the kind this op needs — a mesh where an extrusion is required | `not_an_extrusion` |
| The GlobalId does not resolve | `no_such_element` |
| Valid, understood, and declined — a door in a slab | `refused` |
| A stale `expectedVersion` | `version_conflict` |
| The op is not in your set | `unsupported` |
| Your bug | `internal` |

The zero-length wall is the instructive one. `invalid_param` would be defensible — but the number is
well-formed, and what is wrong is the *shape* it would produce. `degenerate_geometry` is what lets the UI say
"a wall cannot have zero length" instead of "bad parameter".

Only `internal` and `transport` are incidents. Everything else is a normal outcome the UI presents calmly —
`isExpectedFailure()` encodes that distinction.

## Identity: the mistake to avoid

An `expressID` is a **file offset artefact**. It changes when a file is rewritten, and a fresh parse hands out
different ones. A `GlobalId` is the only identifier safe to persist.

`@massing/core` makes them different branded types so you cannot mix them by accident, and the rule for
your kernel is short: **never derive a GlobalId from an expressID.** Mint it once at creation, store it, and
return it forever. An imported element keeps whatever its file gave it, verbatim.

`LocalKernel` mints real compressed UUIDs rather than 22 plausible characters, because the encoding is part of
IFC — other tools decompress it to match elements across federated models. `packages/kernel-local/src/guid.ts`
has the implementation if you need it.

## Coverage becomes a number

`fixtures/recipes.tsv` lists all 96 operations with a status column per kernel. Add a column for yours:

```ts
import { readFileSync } from "node:fs";
import { describeRecipeParity, parseRecipeLedger } from "@massing/kernel-conformance";

const ledger = parseRecipeLedger(readFileSync("fixtures/recipes.tsv", "utf8"));
describeRecipeParity("MyKernel", { create: async () => createMyKernel() }, ledger, "mine");
```

It checks both directions: a `yes` your kernel does not declare fails as overstating, and an op you declare that
the ledger does not credit fails as understating. `scripts/check-recipe-parity.mjs` holds the count at or above
a committed floor.

That split is deliberate — a script reading a table cannot know whether a `yes` is *true*, and a live kernel
cannot know what the table claims. Together they make the ledger unable to lie in either direction.

The mechanism is not theoretical. `LocalKernel`'s fifteen ops existed and were unit-tested for two commits while
the ledger still read `planned` and the floor still read 0. The suite promoted them by failing with *"the kernel
declares these but the ledger does not credit them"* until the table caught up.

## Practical notes

**Run in a worker.** `LocalKernel` cannot be constructed without a transport (`createLocalKernel(transport)`),
which makes "worker-only" a property of the type rather than a convention. Copy the pattern in
`packages/kernel-local/src/protocol.ts` if it suits you.

**Everything crossing a message boundary must be `structuredClone`-able.** A `Result` carrying an `Error`, a
function, or a class instance throws `DataCloneError` at `postMessage` — in the worker, where it surfaces as
your request never resolving. `KernelFailure` is a plain object for exactly this reason, and `ops()` strips its
functions before returning. Catch the throw and report it as `transport`, so a caller gets an answer instead of
a hang.

**Correlate replies by id, not by order.** A fast `versions` issued after a slow `apply` finishes first.

**Answer in-flight requests on `dispose()`.** A promise that never settles is indistinguishable from the
application freezing. And make `dispose()` idempotent — React strict mode unmounts twice, and throwing the
second time turns a benign double-unmount into a crash.

## Using it

```ts ignore
const kernel = createMyKernel();
const viewer = createMassingViewer({ container, kernel });
```

Nothing else in the app knows which kernel it has. That is the point.
