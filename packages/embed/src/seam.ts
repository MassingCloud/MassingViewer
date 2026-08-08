/**
 * M9 readiness, as data.
 *
 * ## The question this answers
 *
 * "Can massing delete `apps/web/src/viewer/` yet?" is otherwise a matter of opinion, and an opinion that will be
 * optimistic — because the person asking wants the answer to be yes. The plan is blunt about the stakes:
 *
 * > Two live copies of an 11,570-line engine for >8 weeks is a fork, not a plan.
 * > *Divergence from massing is the only risk that can end the project.*
 *
 * So the capabilities massing's viewer actually provides are enumerated here, each marked with whether this
 * package covers it, and `seamCoverage()` turns "are we ready" into a fraction with a named list of gaps. A gap
 * with a reason is a work item; "it mostly works" is not.
 *
 * ## Why the list lives here and not in a document
 *
 * A checklist in a markdown file is a checklist nobody updates when they add the thing. This one is imported by
 * `embed.test.ts`, which asserts every entry marked `covered` is genuinely reachable through the facade's type —
 * so marking something done without doing it fails the build.
 */

export type SeamState =
  /** Reachable through `createMassingViewer`. */
  | "covered"
  /** Not yet. `note` says what is missing. */
  | "gap"
  /** Stays in massing. `note` says why — this is not a gap, it is a boundary. */
  | "massing";

export interface SeamCapability {
  readonly id: string;
  /** What massing's viewer does today. */
  readonly description: string;
  readonly state: SeamState;
  /** The facade member that provides it, for `covered` entries. Asserted to exist. */
  readonly via?: string;
  readonly note?: string;
}

/**
 * Every capability `apps/web/src/viewer/` provides, from the dissection in the plan.
 *
 * The `massing` entries matter as much as the gaps. The plan's split is ~1,350 engine lines out of `app.ts` and
 * ~3,610 staying — including `buildToolsPanel`, which is 3,071 lines of persona-ordered construction-platform UI.
 * A facade that tried to absorb those would be a rewrite of massing rather than an extraction from it, and it
 * would never land. Naming them as boundaries stops "not covered" being read as "not finished".
 */
export const SEAM: readonly SeamCapability[] = [
  // --- the engine half, which is what M9 moves -----------------------------------------------------
  { id: "viewport.create", description: "three.js scene, camera, orbit controls, resize", state: "covered", via: "viewport" },
  { id: "viewport.showModel", description: "upload meshes, index by expressID, dispose the previous model", state: "covered", via: "open" },
  { id: "viewport.pick", description: "pick the element under a pointer event", state: "covered", via: "viewport" },
  { id: "viewport.select", description: "highlight a selection and notify", state: "covered", via: "select" },
  { id: "viewport.fit", description: "frame the model or the selection", state: "covered", via: "viewport" },
  { id: "viewport.stats", description: "fps, draw calls, triangles for the status bar", state: "covered", via: "viewport" },
  { id: "viewport.dispose", description: "release GPU allocations and stop the animation loop", state: "covered", via: "dispose" },
  { id: "kernel.provider", description: "the authoring surface — ops, apply, exportIfc, capabilities", state: "covered", via: "kernel" },
  { id: "kernel.open", description: "load a model into the kernel from IFC text", state: "covered", via: "open" },
  { id: "drawings.plan", description: "cut a plan at a height, with GlobalIds on every line", state: "covered", via: "cut" },
  { id: "drawings.export", description: "SVG, DXF and PDF from one drawing", state: "covered", via: "export" },
  { id: "ribbon.render", description: "the tool surface, collapsing responsively", state: "covered", via: "ribbon" },
  { id: "plugins.contribute", description: "commands, ribbon groups and keybindings as data", state: "covered", via: "host" },
  { id: "fileio.drop", description: "open a model by dropping it, sniffed by bytes", state: "covered", via: "onFiles" },
  { id: "crash.capture", description: "report a failure without shipping the model", state: "covered", via: "crashSink" },

  // --- genuine gaps, each a work item --------------------------------------------------------------
  {
    id: "snap.engine",
    description: "snapping with polar tracking and per-snap overrides",
    state: "covered",
    via: "session",
    note:
      "closed by `packages/authoring`. The engine was always in `geometry-math`; what was missing was an armed-tool " +
      "session to feed it. Snapping runs *before* the prompt reducer, so it stays frame-immediate and the reducer " +
      "stays deterministic — and `hover` and `pick` resolve through one function, so the crosshair cannot lie.",
  },
  {
    id: "commands.promptLoop",
    description: "the AutoCAD-style stateful prompt loop and command line",
    state: "covered",
    via: "session",
    note:
      "same object. `session.type()` arms from a verb and routes override codes, dynamic input and keywords, so a " +
      "coordinate typed at a prompt and one typed on a full command line go through identical code.",
  },
  {
    id: "section.box",
    description: "section planes and a clipping box",
    state: "covered",
    via: "viewport",
    note:
      "`viewport.section` — a plane or a six-plane box. Still distinct from `drawings2d`'s cutting, and the " +
      "distinction is worth keeping: this HIDES fragments, so the cut face is hollow. A capped section is a drawing.",
  },
  {
    id: "markup.pins",
    description: "BCF topics pinned to elements, with orphan detection",
    state: "covered",
    via: "raise",
    note:
      "`raise()`, `topics`, `orphans` and `exportBcf()`. `orphans` re-resolves on read rather than caching, because " +
      "an anchor's liveness is a function of the *current* model — a cached answer keeps saying 'live' after the " +
      "element is deleted, which is the exact failure the orphan machinery exists to surface.",
  },
  {
    id: "walk.mode",
    description: "first-person walk",
    state: "covered",
    via: "viewport",
    note:
      "`viewport.walk`, and this is a JUDGEMENT CALL worth flagging rather than burying. massing has TWO walk " +
      "tools, both 🚶, both installed, and `toolbarLayout.ts` records that which is canonical is unresolved. " +
      "Porting either would have been picking for them. This is neither: it is ONE implementation built here, so " +
      "adopting it deletes both and makes the question moot instead of answering it. The pointer-lock approach " +
      "*is* a choice — a drag-to-look camera cannot express 'turn around' without running out of screen, and it " +
      "fights the orbit controls for the same gesture.",
  },

  // --- boundaries: these stay in massing -----------------------------------------------------------
  {
    id: "panels.tools",
    description: "buildToolsPanel — 3,071 lines of persona-ordered construction-platform sections",
    state: "massing",
    note: "massing's product, not a viewer concern. The plan's dissection leaves it where it is.",
  },
  {
    id: "panels.rail",
    description: "the rail panels: issues, pins, clash, 5D, linked records",
    state: "massing",
    note: "each is backed by a massing API endpoint, so extracting them would drag `ApiClient` across the seam.",
  },
  {
    id: "api.client",
    description: "ApiClient — ~3,865 lines of massing's HTTP surface",
    state: "massing",
    note:
      "deliberately on the far side. `ViewerCtx.api → ViewerCtx.kernel` is the whole extraction in miniature, " +
      "and `kernel-remote` is the only package allowed anything HTTP-shaped.",
  },
  {
    id: "auth",
    description: "session, roles, project membership",
    state: "massing",
    note: "`NoAuth` is what makes the offline story real; only `kernel-remote` knows auth exists.",
  },
];

export interface SeamCoverage {
  readonly covered: number;
  /** Capabilities that must move and have not. */
  readonly gaps: readonly SeamCapability[];
  /** Capabilities that stay in massing. Not gaps. */
  readonly boundaries: number;
  /** Fraction of the *movable* surface that has moved, 0..1. */
  readonly ratio: number;
  /**
   * Can massing delete `apps/web/src/viewer/` today?
   *
   * False while any gap remains, and it should stay false until they are all closed. A partial adoption means
   * both copies live — which is the fork the plan says ends the project.
   */
  readonly ready: boolean;
}

export function seamCoverage(seam: readonly SeamCapability[] = SEAM): SeamCoverage {
  const movable = seam.filter((entry) => entry.state !== "massing");
  const gaps = movable.filter((entry) => entry.state === "gap");
  return {
    covered: movable.length - gaps.length,
    gaps,
    boundaries: seam.length - movable.length,
    ratio: movable.length === 0 ? 1 : (movable.length - gaps.length) / movable.length,
    ready: gaps.length === 0,
  };
}

/** A one-line summary, for a README badge or a CI log. */
export function seamSummary(seam: readonly SeamCapability[] = SEAM): string {
  const coverage = seamCoverage(seam);
  return (
    `M9 seam: ${coverage.covered}/${coverage.covered + coverage.gaps.length} movable capabilities ` +
    `(${Math.round(coverage.ratio * 100)}%), ${coverage.boundaries} staying in massing. ` +
    (coverage.ready
      ? "apps/web/src/viewer can be deleted."
      : `Remaining: ${coverage.gaps.map((g) => g.id).join(", ")}.`)
  );
}
