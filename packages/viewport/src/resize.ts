/**
 * When a canvas should be resized to match its container.
 *
 * ## Why this is a named, exported, tested function rather than three lines inside a ResizeObserver
 *
 * massing recorded this failure for weeks as "the dev-preview geometry loader stalls". It never stalled.
 * Measured on a real project: the `.frag` fetch returned 200, the worker parsed, four meshes and 230
 * triangles were built and marked visible — into a canvas of **width zero**. Nothing renders, and from
 * outside that is indistinguishable from a loader that never finished. It was cited as an environment
 * limitation in eight changelog entries before anyone asked the page how wide its canvas was.
 *
 * The cause: a renderer sizes itself once, from whatever the container measured at construction. Anything
 * that gives the container its real width *later* — a rail expanding, a workspace becoming visible, a font
 * or CSS pass landing — leaves that first size in place for ever.
 *
 * ## The second failure, which the fix must not trade for the first
 *
 * Resizing *to* 0x0 is also wrong: it sets a camera aspect of `0/0 = NaN`, every projected vertex becomes
 * NaN, and the scene disappears in a way that looks nothing like a sizing bug. So a zero measurement must
 * be ignored rather than applied.
 *
 * Both failure modes are silent and both look like something else. That is why this is a pure function with
 * its own test rather than an inline closure: massing's version could only be tested by duplicating the
 * logic in the test file, which means the test could pass while the real code diverged.
 */

export interface Size {
  readonly width: number;
  readonly height: number;
}

export type ResizeDecision =
  /** Apply this size to the renderer and camera. */
  | { readonly act: "resize"; readonly to: Size }
  /** Do nothing, and why — surfaced so a stuck viewport can be diagnosed from a log rather than guessed at. */
  | { readonly act: "skip"; readonly reason: "zero" | "implausible" | "unchanged" | "not-finite" };

/**
 * Below this, in CSS pixels, a measurement is treated as not-yet-laid-out rather than as a real size.
 *
 * Found by running the demo in a browser pane that was hidden: the container measured **2 x 20**, that got
 * applied, and because a hidden page does not composite, neither `requestAnimationFrame` nor `ResizeObserver`
 * delivery ran to correct it. The result was a model that had parsed perfectly — 6 elements, 72 triangles,
 * 100% GlobalIds — rendering into a 2 x 20 canvas. Which is massing's "the geometry loader stalls" bug
 * wearing a different hat.
 *
 * Guarding only against exactly zero is not enough, because the failure mode is *implausibly small*, not
 * zero. No CAD viewport is ever intentionally 64 px wide, so treating that as "wait for a real measurement"
 * costs nothing and removes a class of silent blank-screen.
 */
const MIN_PLAUSIBLE_PX = 64;

/**
 * Decide whether to resize.
 *
 * `current` is the size the renderer is presently using; `measured` is what the container just reported.
 *
 * Deliberately tolerant of sub-pixel churn: a `ResizeObserver` on a flex layout can fire with widths that
 * differ by 0.03 px, and honouring those means reallocating the drawing buffer several times a second for
 * no visible change.
 */
export function decideResize(current: Size, measured: Size): ResizeDecision {
  const { width, height } = measured;

  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return { act: "skip", reason: "not-finite" };
  }

  // The NaN-aspect trap. A container that is display:none, or measured before layout, reports 0.
  if (width <= 0 || height <= 0) {
    return { act: "skip", reason: "zero" };
  }

  // Implausibly small — almost certainly a pre-layout measurement. Distinguished from "zero" so a log can
  // tell "not laid out yet" from "something upstream is broken". See MIN_PLAUSIBLE_PX.
  if (width < MIN_PLAUSIBLE_PX || height < MIN_PLAUSIBLE_PX) {
    return { act: "skip", reason: "implausible" };
  }

  // Round before comparing, because that is what will actually be applied — otherwise 800.4 and 800.2
  // compare as different, both round to 800, and the resize runs forever.
  const w = Math.round(width);
  const h = Math.round(height);
  if (w === Math.round(current.width) && h === Math.round(current.height)) {
    return { act: "skip", reason: "unchanged" };
  }

  return { act: "resize", to: { width: w, height: h } };
}

/**
 * Watch an element and call `onResize` whenever {@link decideResize} says to.
 *
 * Returns a disposer. Not optional: an observer that outlives the canvas it was watching keeps the whole
 * scene graph alive, which is the leak the memory gate looks for.
 */
export function observeSize(
  element: Element,
  getCurrent: () => Size,
  onResize: (to: Size) => void,
): () => void {
  if (typeof ResizeObserver === "undefined") {
    // Node, or an ancient browser. Returning a no-op disposer keeps callers from having to branch, and the
    // headless test path exercises `decideResize` directly anyway.
    return () => {};
  }

  const observer = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1];
    if (!entry) return;
    // `contentRect` rather than `contentBoxSize`: the latter is an array whose shape varies across browsers
    // and is empty in some Safari versions, which is precisely the platform this project treats as a moat.
    const decision = decideResize(getCurrent(), {
      width: entry.contentRect.width,
      height: entry.contentRect.height,
    });
    if (decision.act === "resize") onResize(decision.to);
  });

  observer.observe(element);
  return () => observer.disconnect();
}
