import type { Guid, Result } from "@massing/core";
import type { Drawing, DrawingKind, ViewDefinition } from "./model.js";

/**
 * `DrawingProvider` — the seam between the drawing model and whatever generates the linework.
 *
 * Defined **before** either engine, and deliberately so. `docs/adr/0004-2d-drawing-engine.md` chose
 * `@ifc-lite/drawing-2d` for generation on measured results and kept our own sectioner as the interaction
 * engine, because it is 8.5× faster on cut-only work. Two engines behind one interface only stays honest if the
 * interface was not shaped around whichever arrived first — and it is also the hedge: if one turns out to lose
 * GUID fidelity on a real model, swapping it is a one-file change rather than a rewrite of everything
 * downstream.
 *
 * Providers disagreeing on a golden case is the cheapest bug detector available here, and it only works if both
 * can be driven identically.
 */
export interface DrawingProvider {
  readonly id: string;
  readonly version: string;
  /** Which view kinds this provider can produce. Anything else must be refused, not attempted. */
  readonly kinds: readonly DrawingKind[];

  generate(
    input: DrawingInput,
    view: ViewDefinition,
    options?: { signal?: AbortSignal; onProgress?: (fraction: number, note: string) => void },
  ): Promise<Result<Drawing, DrawingFailure>>;
}

export interface DrawingFailure {
  readonly code: "unsupported_kind" | "no_geometry" | "cancelled" | "internal";
  readonly message: string;
}

/**
 * A triangulated element, tagged with the identity that must survive into the drawing.
 *
 * Meshes rather than IFC on purpose: it is the one input both engines already accept, it keeps this package free
 * of an IFC parser, and it means a provider can be fed geometry from any source — a kernel, a fragments file, a
 * point cloud's derived surfaces.
 *
 * `guid` is what everything downstream depends on. A mesh arriving without one produces linework that cannot be
 * marked up or selected, which is why {@link DrawingInput} makes it a required field and the generator counts
 * the ones it could not carry through.
 */
export interface ElementMesh {
  readonly guid: Guid | null;
  readonly ifcClass: string;
  readonly name?: string;
  /** Interleaved x, y, z — **Y up**, metres, world space. */
  readonly positions: Float32Array | readonly number[];
  /** Triangle indices. Absent means `positions` is already a triangle soup. */
  readonly indices?: Uint32Array | readonly number[];
  /** Anything the theme should be able to select on, e.g. `{ fireRated: "yes" }` from the element's psets. */
  readonly attrs?: Readonly<Record<string, string | number>>;
}

export interface DrawingInput {
  readonly name: string;
  readonly meshes: readonly ElementMesh[];
  /** Storey elevations in metres, so a plan can name the level it cut and place grid bubbles. */
  readonly storeys?: readonly { readonly name: string; readonly elevation: number; readonly guid?: Guid }[];
  /**
   * Elements lost **before** this input was built — by the tessellator, the loader, or the kernel.
   *
   * Added because the golden suite proved `DrawingProvenance.incomplete` was blind exactly where it mattered. Its
   * doc comment says a plan silently missing a wall *"renders perfectly… and the person who finds out is on
   * site"*, and a generator can only report the elements it was *handed* and failed on. An element the tessellator
   * dropped never reaches `meshes`, so the drawing reported `incomplete: []` and full coverage while three
   * elements were missing — the precise failure the field exists to prevent, relocated one stage upstream where
   * nothing was looking.
   *
   * `tessellate()` already tracks these with reasons; there was simply no channel for them. This is the channel,
   * and a provider must merge them into its provenance rather than treat them as somebody else's problem.
   */
  readonly skipped?: readonly { readonly guid?: Guid | null; readonly ifcClass: string; readonly reason: string }[];
}
