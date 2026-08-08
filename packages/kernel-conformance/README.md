# @massing/kernel-conformance

The contract every MassingViewer kernel must satisfy, as a runnable suite.

```bash
npm i -D @massing/kernel-conformance
```

```ts
import { describeKernel } from "@massing/kernel-conformance";
import { createMyKernel } from "./index";

describeKernel("MyKernel", {
  create: async () => createMyKernel(),
  createOp: { op: "add_wall", params: { start: [0, 0], end: [5, 0], height: 3, thickness: 0.2 } },
  sampleParams: { add_wall: { start: [0, 0], end: [5, 0], height: 3, thickness: 0.2 } },
  refusals: [
    { label: "zero-length wall", op: "add_wall",
      params: { start: [0, 0], end: [0, 0], height: 3, thickness: 0.2 },
      code: "degenerate_geometry" },
  ],
});
```

That is the whole integration. Writing a kernel becomes "fix the reds" rather than reverse-engineering an
interface.

## Why this is a published library rather than a test directory

`LocalKernel` writes IFC with `web-ifc` in a browser. `RemoteKernel` delegates to `ifcopenshell` behind an
HTTP service. Two independent implementations of the same semantics **will** diverge.

The divergence that hurts is not "one is missing a feature" — capability negotiation covers that honestly. It
is *silent* disagreement: both accept an operation and produce subtly different results, or both refuse for
reasons the UI cannot tell apart. A suite that runs against both is the only thing that makes them
interchangeable rather than merely similar. Without it, `KernelProvider` is a shape, not a contract.

## What it asserts

| Family | The failure it prevents |
|---|---|
| **Identity** | A created element must get a valid 22-character IFC GlobalId, unique across creates, that **survives an IFC round-trip**. A writer that re-generates ids on save breaks every persisted reference in the product — markup pins, selection sets, issues, drawing entities. |
| **Capability honesty** | `supports()` must agree with `ops()`, and an unsupported operation must return `unsupported` — not throw (crosses a worker boundary unusably), not hang (indistinguishable from slow), and above all not silently no-op (the user believes it worked). Every `unsupported` failure must carry a hint naming what would unlock it. |
| **Refusal parity** | Same bad input, same **code**, across implementations. Codes are asserted; messages never are, because they are localised and a test that pins wording either blocks copy improvements or gets updated unread. A refusal must also never mutate the model, which is what makes it safe to retry. |
| **Repeatability** | Applying a create twice yields two *distinct* elements — a kernel that de-duplicates makes it impossible to draw two identical walls. Two fresh kernels given the same operations must agree, which catches module-level state leaking between instances. |
| **Versioning** | Every mutation advances the model version; a stale `expectedVersion` gets `version_conflict`, never a silent overwrite. Geometry version is tracked separately so a property edit does not trigger a full re-stream. |
| **Cancellation** | An aborted operation must *settle*. A cancel that never resolves leaks the promise and the spinner stays up for ever, which reads as a hang in the kernel rather than a bug in the cancel path. |
| **Transactions** | Behaviour must match the declared `TransactionSupport`. A kernel declaring `none` must refuse `begin()`; one declaring `inverse` may fail a rollback but must say so with a code rather than throwing. |
| **Snap candidates** | Every candidate carries a recognised kind. A snap that lies about its kind is worse than no snap — the HUD says "perpendicular" while the placed point is something else, and that point carries a GlobalId and feeds schedules. |

`describeRecipeParity` is separate: a **ratchet** over an external operation list, so coverage is a counted
number that can only go up. massing's server implements 96 recipes and a new kernel will implement a handful;
the point is that the gap is countable rather than discovered by a user hitting a dimmed button.

## It can fail

A suite that has only ever passed asserts nothing, so it was verified against a deliberately sabotaged
kernel. Four mutations, four precise failures, no false positives:

| Sabotage | Caught by |
|---|---|
| GlobalIds truncated to 8 characters | *a created element gets a valid IFC GlobalId* |
| Unsupported operation throws instead of refusing | *returns `unsupported` — it does not throw, hang or no-op* (and the hint assertion) |
| `version_conflict` check removed | *a stale expectedVersion is refused* |
| Degenerate wall returns `invalid_param` instead of `degenerate_geometry` | *declared refusals produce the expected code* |

## Writing a kernel

Read `@massing/kernel-memory` — a reference implementation that passes this suite in ~600 lines. It
exists partly so that when your kernel fails an assertion, you know the assertion is achievable.
