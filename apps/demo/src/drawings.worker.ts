/**
 * The Worker that cuts drawings.
 *
 * `e2e/longtask.spec.ts` measured `generatePlan` blocking the main thread for about 450 ms — roughly a quarter of a
 * second of dropped frames on a six-element fixture, and the plan names main-thread stalls as risk #5. Sectioning is
 * a pure function of `(DrawingInput, ViewDefinition)`, so there is nothing to keep it here: no DOM, no GPU, no
 * shared state.
 *
 * Same shape as `kernel.worker.ts`, and in the app for the same reason: `new URL(…, import.meta.url)` needs
 * bundler-specific knowledge, and the app is the only place that knows which bundler it has.
 *
 * ## What crosses the boundary
 *
 * In: element meshes whose `positions` and `indices` are typed arrays, which structured-clone natively. Out: a
 * `Drawing`, which is plain data — points, strings, numbers — by ADR-0004's design, because entities live in model
 * space and paper is a render-time transform. Neither direction needs a serializer, and that is a property of the
 * Semantic Drawing Model rather than luck.
 */

import { generatePlan, type Drawing, type DrawingInput, type ViewDefinition } from "@massing/drawings2d";

export interface CutRequest {
  /** Echoed back, so a reply can be matched to its request and a stale one discarded. */
  readonly id: number;
  readonly input: DrawingInput;
  readonly view: ViewDefinition;
}

export type CutResponse =
  | { readonly id: number; readonly ok: true; readonly drawing: Drawing }
  // A refusal rather than a thrown error crossing the boundary: `postMessage` cannot clone an `Error`'s stack, and
  // a worker that dies silently looks exactly like one that is still working.
  | { readonly id: number; readonly ok: false; readonly why: string };

self.addEventListener("message", (event: MessageEvent<CutRequest>) => {
  const { id, input, view } = event.data;
  try {
    const drawing = generatePlan(input, view);
    self.postMessage({ id, ok: true, drawing } satisfies CutResponse);
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      why: error instanceof Error ? error.message : String(error),
    } satisfies CutResponse);
  }
});
