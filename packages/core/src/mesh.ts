/**
 * Tessellated element geometry, as it travels between the thing that produces it and the thing that draws it.
 *
 * ## Why this is in `core` rather than beside a renderer
 *
 * It lived in `@massing/viewport` — layer 4, and the only package allowed to import `three`. That was a fair
 * place for it while the only producer and the only consumer were both inside the viewport, and it stopped being
 * fair the moment anything below layer 4 needed to *make* one. A tessellator produces these; it has no business
 * depending on a renderer to describe its own output, and the layer DAG says so by refusing the edge.
 *
 * The type itself is the evidence that this is the right layer: four typed arrays, a number, a string and a
 * colour. No DOM, no `three`, nothing that knows a scene exists. `THREE.BufferGeometry` is built *from* one of
 * these, which is a different fact about the renderer than about the geometry.
 *
 * ## The shape is `@ifc-lite/geometry`'s, deliberately
 *
 * It is what the parse layer produces (see `docs/adr/0004-2d-drawing-engine.md`), and re-shaping it here would
 * mean copying every vertex buffer for no gain. Structured-cloneable as a consequence, which is what lets one of
 * these cross a Worker boundary without a serializer.
 */
export interface SourceMesh {
  /** IFC expressID. The parse layer's key for everything. */
  readonly expressId: number;
  readonly ifcType?: string;
  readonly modelIndex?: number;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  /** RGBA 0..1. */
  readonly color: readonly [number, number, number, number];
}
