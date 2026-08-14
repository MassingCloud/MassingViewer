import * as THREE from "three";
import type { Guid, LocalId, ModelId, SourceMesh } from "@massing/core";

/**
 * Re-exported, not redefined.
 *
 * `SourceMesh` moved to `@massing/core` so a tessellator can produce one without depending on a renderer — see
 * that file for why. It is still exported from here because this is where every existing consumer imports it
 * from, and a type that has not changed shape is not worth a breaking change to the facade.
 */
export type { SourceMesh } from "@massing/core";

/**
 * Turning tessellated element geometry into a three.js scene, without losing element identity.
 */

/**
 * One element in the scene, with the identity needed to select it and to anchor anything to it.
 *
 * Both ids are kept, because they answer different questions and conflating them is the mistake
 * `packages/core/src/identity.ts` exists to prevent: `expressId` is what the parse layer and the drawing
 * generator speak, `guid` is the only thing safe to persist.
 */
export interface SceneElement {
  readonly expressId: number;
  readonly guid: Guid | null;
  readonly ifcType: string;
  readonly object: THREE.Mesh;
}

export interface BuildResult {
  readonly group: THREE.Group;
  readonly elements: readonly SceneElement[];
  /** Elements whose GlobalId could not be resolved. Reported, never silently dropped — see below. */
  readonly unresolved: readonly number[];
  readonly triangles: number;
  readonly bounds: THREE.Box3;
}

/**
 * Resolves an expressID to a GlobalId.
 *
 * Injected rather than imported so `viewport` never depends on a parser. It also means the *caller* owns the
 * expressID-to-GlobalId direction, which is where the ifc-lite accessor hazard lives (the columnar arrays are
 * row-indexed while the accessors are expressID-indexed — mixing them returns another element's data with no
 * error). Keeping that in one adapter is better than scattering it.
 */
export type GuidResolver = (expressId: number) => Guid | null;

/**
 * Build a scene group from element meshes.
 *
 * ## Why one mesh per element rather than one merged buffer
 *
 * Merging every element into a single geometry is faster to draw and makes selection, per-element visibility,
 * and colour override all impossible without re-uploading. Since selection and isolate are core to the
 * product, per-element meshes are the right default; batching by material is a later optimisation that must
 * preserve `entityIds` per vertex to stay selectable.
 */
export function buildScene(
  meshes: readonly SourceMesh[],
  resolveGuid: GuidResolver,
  options: { readonly modelId: ModelId },
): BuildResult {
  const group = new THREE.Group();
  group.name = `model:${options.modelId}`;

  const elements: SceneElement[] = [];
  const unresolved: number[] = [];
  let triangles = 0;

  for (const m of meshes) {
    const geometry = new THREE.BufferGeometry();
    // Views onto the source arrays — no copy. The source is owned by the caller for the scene's lifetime,
    // which `dispose` below is careful not to violate.
    geometry.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
    if (m.normals.length === m.positions.length) {
      geometry.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
    } else {
      // A tessellator that omitted normals, or emitted the wrong count. Computing them is cheap and the
      // alternative is an unlit black mesh that reads as a loading failure.
      geometry.computeVertexNormals();
    }
    geometry.setIndex(new THREE.BufferAttribute(m.indices, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const [r, g, b, a] = m.color;
    const material = new THREE.MeshLambertMaterial({
      color: new THREE.Color(r, g, b),
      // ifc-lite's own docs warn that winding order is unreliable because meshes are double-sided by design.
      // Single-sided rendering would therefore drop apparently-random faces — which looks like corrupt
      // geometry rather than a culling setting.
      side: THREE.DoubleSide,
      transparent: a < 1,
      opacity: a,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `${m.ifcType ?? "IfcProduct"}:${m.expressId}`;
    // Identity on the object, so a raycast hit resolves without a side table.
    mesh.userData.expressId = m.expressId;

    const guid = resolveGuid(m.expressId);
    if (guid === null) unresolved.push(m.expressId);
    mesh.userData.guid = guid;

    group.add(mesh);
    elements.push({ expressId: m.expressId, guid, ifcType: m.ifcType ?? "IfcProduct", object: mesh });
    triangles += m.indices.length / 3;
  }

  const bounds = new THREE.Box3().setFromObject(group);
  return { group, elements, unresolved, triangles, bounds };
}

/**
 * Release GPU resources for a built scene.
 *
 * three.js does not free geometries or materials when an object leaves the graph — they are GPU allocations
 * with no finalizer, so an unmounted viewport leaks its whole model. The memory gate asserts that
 * `renderer.info.memory.geometries` returns to baseline after unmount, and this is what makes that true.
 */
export function disposeScene(result: BuildResult): void {
  for (const el of result.elements) {
    el.object.geometry.dispose();
    const material = el.object.material;
    if (Array.isArray(material)) for (const m of material) m.dispose();
    else material.dispose();
  }
  result.group.clear();
}

/** Map viewer object ids to elements, for resolving raycast hits. */
export function elementIndex(result: BuildResult): {
  byLocalId: ReadonlyMap<LocalId, SceneElement>;
  byExpressId: ReadonlyMap<number, SceneElement>;
} {
  const byLocalId = new Map<LocalId, SceneElement>();
  const byExpressId = new Map<number, SceneElement>();
  for (const el of result.elements) {
    byLocalId.set(el.object.id as LocalId, el);
    byExpressId.set(el.expressId, el);
  }
  return { byLocalId, byExpressId };
}
