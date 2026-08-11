import { asModelId, type Guid, type ModelId } from "@massing/core";
import type { KernelProvider } from "@massing/kernel-api";
import { createViewport, type SourceMesh, type Viewport, type WebGpuProbe } from "@massing/viewport";
import { createRibbon, type Ribbon } from "@massing/ribbon";
import {
  builtinManifests,
  createPluginHost,
  ribbonFrom,
  type PluginHost,
  type PluginLoader,
  type PluginManifest,
} from "@massing/plugin-host";
import {
  ARCHITECTURAL,
  fitToPaper,
  generatePlan,
  PAPER_SIZES,
  toDxf,
  toPdf,
  toSvg,
  type Drawing,
  type ElementMesh,
  type Paper,
  type Theme,
  type TitleBlockFields,
  type ViewDefinition,
} from "@massing/drawings2d";
import { createDropTarget, sniff, supportFor, type DropTarget, type OpenedFile } from "@massing/fileio";
import { NOOP_CRASH_SINK, createCrashHandler, type CrashSink } from "@massing/observability";
import { createSession, type AuthoringSession } from "@massing/authoring";
import { createRegistry, type CommandContext, type Registry } from "@massing/commands";
import { createTopic, isLive, resolveAnchor, toBcfZip, type Topic } from "@massing/markup";

/**
 * `createMassingViewer` — the one function massing imports.
 *
 * ## What this is for
 *
 * The plan's M9, and the risk register's number one: *"Divergence from massing — the only risk that can end the
 * project."* Two live copies of an 11,570-line engine is a fork, not a plan, so this facade exists to be the
 * *entire* surface massing needs — small enough to adopt in one PR, complete enough that
 * `apps/web/src/viewer/` can be deleted rather than kept "just in case".
 *
 * The plan describes the extraction in one line, and it is literally one field:
 *
 * > `ViewerCtx.api: ApiClient` becomes `ViewerCtx.kernel: KernelProvider` — this one field change is the whole
 * > extraction in miniature.
 *
 * That is why {@link MassingViewerOptions.kernel} is required rather than defaulted. A facade that quietly
 * constructed a `LocalKernel` would let massing adopt this while still holding an `ApiClient` somewhere, and the
 * coupling this is meant to break would survive the migration invisibly.
 *
 * ## Why the Worker is not constructed here
 *
 * It cannot be. `new Worker(new URL("./kernel.worker.ts", import.meta.url))` has to appear in the *application's*
 * source for a bundler to see it — a `new URL` inside a published package resolves against a module that has
 * already been inlined, and no chunk is emitted at all. That is not a hypothesis: it is what happened the first
 * time in `apps/demo`.
 *
 * So the host builds its kernel and passes it in. One line in the app, and it is the line that decides whether
 * authoring is local or remote — which is exactly the decision that should be visible in the app.
 *
 * ## What it deliberately does not wrap
 *
 * massing's own panels. `buildToolsPanel` is 3,071 lines of persona-ordered construction-platform UI, and it
 * belongs to massing — the dissection in the plan splits ~1,350 engine lines out of `app.ts` and leaves ~3,610
 * where they are. A facade that tried to own the panels too would be a rewrite of massing rather than an
 * extraction from it, and it would never land.
 */

export interface MassingViewerOptions {
  /** Where the 3D view goes. */
  readonly container: HTMLElement;
  /**
   * Forwarded to the viewport. Injectable so a host can force the WebGL path, and so tests can drive the
   * advertised-but-unusable-adapter branch without hardware. See `packages/viewport/src/renderer.ts`.
   */
  readonly webGpuProbe?: WebGpuProbe;
  /**
   * How a model's bytes become meshes. **Optional**, and only needed for {@link MassingViewer.openIfc}.
   *
   * Optional rather than required because a host that converts IFC server-side and streams geometry never hands
   * this facade any IFC text — it calls {@link MassingViewer.showMeshes} instead. Requiring a tessellator would
   * force such a host to supply a `web-ifc` WASM payload it would never execute, which is the cost the note on
   * {@link Tessellator} exists to avoid. Without one, `openIfc` refuses and says so.
   */
  readonly tessellate?: Tessellator;
  /**
   * The geometry kernel. **Required.**
   *
   * Not defaulted, on purpose — see the note above. The host constructs it, which is what makes
   * `ViewerCtx.api → ViewerCtx.kernel` a change the compiler enforces rather than one a reviewer has to spot.
   */
  readonly kernel: KernelProvider;
  /** Where the ribbon goes. Omit for a host that keeps its own toolbar during the transition. */
  readonly ribbonContainer?: HTMLElement;
  /** Extra plugins, on top of the built-in tool surface. */
  readonly plugins?: readonly PluginManifest[];
  /** How a plugin's code is fetched. Required only if `plugins` is non-empty. */
  readonly loadPlugin?: PluginLoader;
  /** Crash sink. Defaults to sending nothing, which is the whole posture of `observability`. */
  readonly crashSink?: CrashSink;
  /** The model this viewer operates on. Defaults to `"model"`. */
  readonly modelId?: ModelId;
  /** Called when the selection changes, with the GlobalId or `null`. */
  readonly onSelect?: (guid: Guid | null) => void;
  /** Called when files are dropped on the container. Omit to leave drag-and-drop to the host. */
  readonly onFiles?: (files: readonly OpenedFile[]) => void;
  /** Called for anything worth showing the user — a refusal, a plugin failure, a truncated drop. */
  readonly onStatus?: (message: string, kind: "ok" | "warn") => void;
}

export type ExportFormat = "svg" | "dxf" | "pdf";

export interface MassingViewer {
  readonly viewport: Viewport;
  /**
   * The authoring session: armed tool, half-collected arguments, cursor-to-point resolution.
   *
   * This one property closed four of the five M9 gaps. Snapping, the prompt loop, the section box and markup pins
   * were listed separately, and every library under them already existed — what was missing was the object that
   * connected them. See `packages/authoring/src/session.ts`.
   */
  readonly session: AuthoringSession;
  /**
   * The command registry.
   *
   * Exposed because a host has to register its own verbs — massing has ninety-odd — and because the facade owning
   * the registry is what keeps every dispatch on one audited, undoable path. A host that supplied its own could
   * bypass both.
   */
  readonly commands: Registry;
  readonly kernel: KernelProvider;
  readonly host: PluginHost;
  /** `null` when no `ribbonContainer` was given. */
  readonly ribbon: Ribbon | null;
  readonly modelId: ModelId;

  /**
   * Load an IFC. Accepts text or bytes, and sniffs rather than trusting a name.
   *
   * Returns a result rather than throwing, because "this file is a ZIP despite its extension" is a question for
   * the user and not an exception for the caller. Refuses if no `tessellate` was supplied, rather than throwing
   * somewhere deeper.
   */
  openIfc(
    source: string | Uint8Array,
    name?: string,
  ): Promise<{ ok: true; elements: number } | { ok: false; why: string }>;

  /**
   * Show geometry a host produced itself, with no IFC text anywhere.
   *
   * The entry point for a host whose pipeline converts IFC server-side and streams geometry — massing does exactly
   * that, and *"never parse full IFC in the browser at runtime"* is one of its hard constraints. Before this
   * existed the only route was `viewport.showModel`, which works and **silently skips three things `openIfc` also
   * does**: the snap grid, the kernel handoff, and invalidating a drawing and selection cut from the previous
   * model. The result looked correct — 3D and picking both fine — while snapping had no candidates and the first
   * edit went to whichever model the kernel last opened.
   *
   * So this does all of it, and there is no half-wired path left to take by accident.
   */
  showMeshes(model: {
    readonly meshes: readonly SourceMesh[];
    readonly guids: Map<number, string>;
    /**
     * How the kernel learns about this model. **Required, and deliberately not defaulted**, because both wrong
     * answers are silent:
     *
     * - Skipping the handoff sends the first edit to whatever the kernel last held.
     * - Calling `kernel.open(modelId)` with no IFC text makes `LocalKernel` **start a blank model** — see
     *   `packages/kernel-local/src/core.ts`, where `ifc` omitted means `BLANK_IFC4`. The viewport would show this
     *   model and the kernel would hold an empty one.
     *
     * `{ alreadyOpen: true }` is the remote case: the server already has the model, so there is nothing to send.
     * It is taken on trust — `KernelProvider` has no portable way to ask — which is why it has to be stated.
     */
    readonly kernel: { readonly alreadyOpen: true } | { readonly ifc: string };
  }): Promise<{ ok: true; elements: number } | { ok: false; why: string }>;

  /**
   * @deprecated Use {@link MassingViewer.openIfc}. Retained because this is a published surface; it delegates and
   * does nothing else.
   */
  open(source: string | Uint8Array, name?: string): Promise<{ ok: true; elements: number } | { ok: false; why: string }>;

  /** Cut a drawing from the current model. */
  /**
   * Add a model beside the ones already loaded — ADR-0013's federation at the facade.
   *
   * Re-adding an id replaces that model only. The added model is visible, snappable, cuttable and pickable, but it is
   * **not** the kernel's edit target: an authoring kernel holds one file, and repointing it at whichever consultant's
   * model arrived last would apply the next edit to something the user is not looking at. The reference model — the
   * one {@link MassingViewer.openIfc} or {@link MassingViewer.showMeshes} set — keeps that role.
   *
   * A duplicate GlobalId across two models is reported through `onStatus`, not refused and not silently resolved.
   */
  addModel(model: {
    readonly modelId: ModelId;
    readonly meshes: readonly SourceMesh[];
    readonly guids: Map<number, string>;
  }): { ok: true; elements: number } | { ok: false; why: string };
  /** Unload one model and free its GPU buffers. False if there was nothing by that id. */
  removeModel(modelId: ModelId): boolean;
  /** Loaded model ids, in load order. */
  readonly models: readonly ModelId[];
  /** Hide or show one model. Hidden means hidden to the pointer too. */
  setModelVisible(modelId: ModelId, visible: boolean): boolean;
  /** Whether a model is visible. `null` if there is no such model. */
  isModelVisible(modelId: ModelId): boolean | null;

  cut(view?: ViewDefinition): Drawing | null;
  /** The most recently cut drawing. */
  readonly drawing: Drawing | null;
  /** Serialise the current drawing. Throws only if nothing has been cut. */
  /**
   * Serialise the current drawing.
   *
   * `sheetOptions` carries the title block. DXF and PDF get a border, a title block and a scale bar; the interactive
   * SVG deliberately gets none, because that one is the app's own pane and furniture around a live view is noise.
   */
  export(
    format: ExportFormat,
    theme?: Theme,
    paper?: Paper,
    sheetOptions?: { readonly titleBlock?: TitleBlockFields; readonly scaleBar?: boolean },
  ): string | Uint8Array;

  select(guid: Guid | null): void;
  readonly selection: Guid | null;

  /**
   * Markup: BCF topics anchored to GlobalIds, with orphan detection.
   *
   * `packages/markup` was complete before this existed; the gap was that the facade did not expose it. Anchors
   * resolve by GlobalId, so deleting an element **orphans** its topics and says so rather than losing them.
   */
  raise(options?: { readonly title?: string; readonly at?: { readonly x: number; readonly y: number } }): Topic | null;
  readonly topics: readonly Topic[];
  /** Topics whose anchor no longer resolves in the current model. */
  readonly orphans: readonly Topic[];
  /** BCF 3.0 `.bcfzip` bytes. */
  exportBcf(): Uint8Array;

  /** Idempotent. Called twice by a React strict-mode unmount, and by any host that is being careful. */
  dispose(): void;
}

/**
 * Meshes the drawing layer can cut, from meshes the viewport was given.
 *
 * **`indices` must be carried.** `ElementMesh` documents the rule — *"absent means `positions` is already a triangle
 * soup"* — and this function used to drop it, so every indexed mesh was handed to the sectioner as loose vertices and
 * read as unrelated triangles. An indexed box's 8 corners became 2 nonsense triangles: the cut still produced a
 * drawing, so `cut()` reported success and returned a plan of a shape that does not exist. Tessellators emit indexed
 * geometry as a matter of course, which is what made this the normal path rather than an edge case.
 *
 * It survived because the facade's own fixtures happened to be unindexed triangle soups, where dropping `indices` is
 * a no-op — the exact shape of fixture that cannot see this bug.
 */
function toElementMeshes(meshes: readonly SourceMesh[], guidOf: (expressId: number) => Guid | null): ElementMesh[] {
  const out: ElementMesh[] = [];
  for (const mesh of meshes) {
    const guid = guidOf(mesh.expressId);
    if (guid === null) continue;
    out.push({
      guid,
      ifcClass: mesh.ifcType ?? "IfcBuildingElement",
      positions: Array.from(mesh.positions),
      ...(mesh.indices === undefined ? {} : { indices: Array.from(mesh.indices) }),
    });
  }
  return out;
}

/**
 * How a model's bytes become meshes.
 *
 * Injected rather than imported, and this is the one place the facade genuinely cannot decide for its host.
 * Tessellation means either `web-ifc` (a WASM payload the host must serve) or a host's existing pipeline —
 * massing already has one. Bundling a tessellator here would force a WASM asset on a host that does not need it,
 * and choosing *not* to bundle one would make `open()` a lie. So it is a parameter.
 */
export interface Tessellator {
  (ifcText: string): { meshes: readonly SourceMesh[]; guids: Map<number, string> };
}

/**
 * `tessellate` required.
 *
 * @deprecated Use {@link MassingViewerOptions}, where it is optional. Kept so existing callers keep compiling: a
 * host that passes one is still doing something valid, it is only no longer the sole way in.
 */
export interface MassingViewerOptionsWithTessellator extends MassingViewerOptions {
  readonly tessellate: Tessellator;
}

/**
 * **Async since 2026-08-10.** `createViewport` awaits `WebGPURenderer.init()` (ADR-0012), so this cannot be
 * synchronous. Batched with federation (ADR-0013) deliberately: both break this same signature, and massing is
 * mid-adoption, so it absorbs one change rather than two.
 */
export async function createMassingViewer(options: MassingViewerOptions): Promise<MassingViewer> {
  const modelId = options.modelId ?? asModelId("model");
  const status = options.onStatus ?? (() => {});
  const crash = createCrashHandler({ where: "massingviewer", sink: options.crashSink ?? NOOP_CRASH_SINK });

  const viewport = await createViewport({ container: options.container, webGpuProbe: options.webGpuProbe });

  const topics: Topic[] = [];

  /**
   * Snap candidates, bucketed on a coarse grid and rebuilt once per model load.
   *
   * `session.hover()` is documented as safe to call per animation frame, and it asks for candidates every time. A
   * previous version scanned every vertex of every mesh on each call — 200k iterations per frame on a real model,
   * about 12 million a second, on the main thread beside rendering. Its comment claimed the work was "pre-filtered
   * so a 200k-vertex model does not hand `resolveSnap` every vertex", which was true of what got passed onward and
   * false about the cost of getting there: the O(n) scan happened regardless.
   *
   * A hash grid makes the query O(candidates nearby) instead. `CELL` is comfortably larger than any sane snap
   * tolerance, so a query needs only the nine cells around the cursor.
   */
  const CELL = 1;
  let snapGrid = new Map<string, { x: number; z: number; kind: "endpoint" }[]>();

  const cellKey = (x: number, z: number): string => `${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`;

  function buildSnapGrid(source: readonly SourceMesh[]): void {
    const grid = new Map<string, { x: number; z: number; kind: "endpoint" }[]>();
    for (const mesh of source) {
      const positions = mesh.positions;
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i]!;
        const z = positions[i + 2]!;
        const key = cellKey(x, z);
        const bucket = grid.get(key);
        // Deduplicated per cell: a box mesh repeats each corner across several triangles, so without this a
        // single vertex enters the grid a dozen times and `resolveSnap` compares it a dozen times.
        if (bucket === undefined) grid.set(key, [{ x, z, kind: "endpoint" }]);
        else if (!bucket.some((c) => c.x === x && c.z === z)) bucket.push({ x, z, kind: "endpoint" });
      }
    }
    snapGrid = grid;
  }

  /**
   * The command registry and the session.
   *
   * The registry is created here rather than taken as an option because the facade owns the dispatch path — a host
   * that supplied its own would be able to bypass the audit sink and the undo history, which are the two things
   * the command bus exists to guarantee.
   */
  const registry = createRegistry();

  /**
   * The last pointer position over the container, in client coordinates.
   *
   * Needed by `elementAt`: `viewport.pick` raycasts from screen space, and the session speaks model space. The
   * facade owns this listener, so it is the only place that has both.
   */
  let lastPointer: { clientX: number; clientY: number } | null = null;
  const onPointerMove = (event: PointerEvent): void => {
    lastPointer = { clientX: event.clientX, clientY: event.clientY };
  };
  options.container.addEventListener("pointermove", onPointerMove);

  const commandContext = (): CommandContext => ({
    // `edit` unconditionally: the local kernel has no notion of a role, and inventing a restriction the kernel
    // does not enforce would dim controls for a reason that is not true. A host with real roles supplies its own
    // context by wrapping `session`.
    capabilities: new Set(["view", "review", "edit"]),
    selection: selection === null ? [] : [selection],
    supportsOp: () => true,
    opHint: (op) => `"${op}" is not available with this kernel`,
    online: true,
    /**
     * A real dispatch, so a composite command works.
     *
     * `CommandContext.dispatch` is documented as "how a composite command is built". A previous version stubbed it
     * to `{ ok: true, value: null }`, so a command that dispatched a sub-command got success back and nothing
     * happened: no kernel call, no undo entry, an incomplete audit log, and no way to notice.
     *
     * `commandContext()` is called fresh here rather than closed over, so a sub-command sees the selection as it is
     * *now* — a composite that selects something and then acts on it depends on that.
     */
    dispatch: async (invocation) => await registry.dispatch(invocation, commandContext()),
  });

  const session = createSession({
    registry,
    context: commandContext,
    // Snap candidates from the model the viewport is actually showing. A callback, so the session never needs to
    // know what a mesh is — and a grid lookup, so it stays cheap enough to call per frame.
    candidates: (cursor) => {
      const out: { x: number; z: number; kind: "endpoint" }[] = [];
      const cx = Math.floor(cursor.x / CELL);
      const cz = Math.floor(cursor.z / CELL);
      // The nine cells around the cursor. `resolveSnap` still applies the exact tolerance; this only bounds how
      // much it has to look at.
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = snapGrid.get(`${cx + dx}:${cz + dz}`);
          if (bucket !== undefined) out.push(...bucket);
        }
      }
      return out;
    },
    /**
     * The element under the cursor, resolved by raycast.
     *
     * A previous version returned `selection`, which is a different thing entirely: an element-argument command
     * would commit whatever happened to be selected regardless of where the user clicked, and with nothing
     * selected, clicking the very wall the prompt was asking for never advanced it.
     *
     * `viewport.pick` needs screen coordinates, so the facade records the last pointer position over its own
     * container — it owns that listener, and the session deals only in model space.
     */
    elementAt: () => {
      if (lastPointer === null) return null;
      return viewport.pick(lastPointer)?.guid ?? null;
    },
  });

  const host = createPluginHost({
    // A loader that refuses by default. Returning an empty runtime would make a plugin that failed to load
    // indistinguishable from one that loaded and did nothing.
    load: options.loadPlugin ?? ((id) => Promise.reject(new Error(`no loader configured, cannot load "${id}"`))),
    onFailure: (id, phase, error) =>
      status(`plugin ${id} failed to ${phase}: ${error instanceof Error ? error.message : String(error)}`, "warn"),
  });
  const loaded = host.load([...builtinManifests(), ...(options.plugins ?? [])]);
  if (loaded.rejected.length > 0) {
    status(`rejected plugin(s): ${loaded.rejected.map((r) => `${r.id} (${r.why})`).join("; ")}`, "warn");
  }
  for (const [chord, commands] of loaded.keybindingConflicts) {
    // Reported, never silently resolved. The user presses the chord, gets the wrong command, and nothing says why.
    status(`${chord} is bound by ${commands.join(" and ")}; the first wins`, "warn");
  }

  /**
   * The loaded models, keyed by id — ADR-0013's federation reaching the facade.
   *
   * ## Why the guid needs no model qualifier, contrary to what this was scoped as
   *
   * The plan for this work assumed identity had to become `(modelId, guid)` and be threaded through
   * `AuthoringSession` and `@massing/markup`. Reading the constraint again dissolved most of it: an IFC **GlobalId is
   * globally unique by specification** — a 22-character base64 UUID — so a guid already identifies an element across
   * every loaded file. It is the *expressId* that is per-file and collides, which is a viewport concern and now
   * handled there. So markup, selection and the authoring session keep taking a bare `Guid` and are federation-safe
   * as they stand. Threading a model through them would have been ceremony.
   *
   * What that specification does not guarantee is that real exporters obey it. Duplicate GlobalIds across two files
   * happen — copy-paste between projects, a bad exporter, the same file loaded twice under two ids. That is detected
   * on load and **reported**, because a silently ambiguous guid resolves to whichever model was added first and the
   * user would see markup land on the wrong building.
   */
  interface LoadedModel {
    readonly meshes: readonly SourceMesh[];
    readonly guids: Map<number, string>;
  }
  const models = new Map<ModelId, LoadedModel>();
  let drawing: Drawing | null = null;
  let selection: Guid | null = null;
  let disposed = false;

  /** A guid resolver bound to one model, which is what `viewport.addModel` wants. */
  const guidResolverFor =
    (id: ModelId) =>
    (expressId: number): Guid | null => {
      const raw = models.get(id)?.guids.get(expressId);
      return raw === undefined ? null : (raw as Guid);
    };

  /** Every loaded model's meshes, in load order — what the snap grid is built from. */
  const allMeshes = (): readonly SourceMesh[] => [...models.values()].flatMap((m) => [...m.meshes]);

  /**
   * The cuttable geometry of the whole federation, resolved **per model**.
   *
   * Not `toElementMeshes(allMeshes(), oneResolver)`. That would hand a union of meshes to a single expressId→guid map,
   * and expressIds collide across files: every element whose id also exists in another model would be labelled with
   * the other model's GlobalId. The drawing would look right and its `data-guid` attributes would point at the wrong
   * building — a silent mislabelling, not a visible failure.
   */
  const federatedElementMeshes = (): ElementMesh[] =>
    [...models.entries()].flatMap(([id, model]) => toElementMeshes(model.meshes, guidResolverFor(id)));

  /** Which model holds a guid, or null. Linear over models, not over elements: each map lookup is O(1). */
  function modelOfGuid(guid: Guid): { readonly modelId: ModelId; readonly expressId: number } | null {
    for (const [id, model] of models) {
      for (const [expressId, value] of model.guids) {
        if (value === guid) return { modelId: id, expressId };
      }
    }
    return null;
  }

  /**
   * Report guids the incoming model shares with one already loaded.
   *
   * Reported rather than refused. A duplicate GlobalId is a defect in someone else's exporter, and refusing the file
   * would leave the user unable to look at their own building; resolving it silently would put their markup on the
   * wrong element. Naming it is the only option that does neither.
   */
  function reportGuidCollisions(incoming: Map<number, string>, exclude: ModelId): void {
    const seen = new Set<string>();
    for (const [id, model] of models) {
      if (id === exclude) continue;
      for (const value of model.guids.values()) seen.add(value);
    }
    const clashes = new Set([...incoming.values()].filter((g) => seen.has(g)));
    if (clashes.size > 0) {
      const sample = [...clashes].slice(0, 3).join(", ");
      status(
        `${clashes.size} GlobalId(s) in this model are already used by another loaded model (${sample}` +
          `${clashes.size > 3 ? ", …" : ""}). IFC requires them to be unique; markup and selection on those ` +
          `elements will resolve to whichever model was loaded first.`,
        "warn",
      );
    }
  }

  /**
   * Everything that has to happen when the model changes, in one place.
   *
   * There are four steps and the whole point is that no caller can perform three of them. `viewport.showModel` on
   * its own leaves the snap grid built from the previous model, the kernel holding the previous model, and a
   * drawing and selection cut from the previous model — and reports success, because from the viewport's point of
   * view it succeeded. Both entry points route through here so that path does not exist.
   */
  async function applyModel(
    next: readonly SourceMesh[],
    nextGuids: Map<number, string>,
    handoff: { readonly alreadyOpen: true } | { readonly ifc: string },
    label: string,
  ): Promise<{ ok: true; elements: number } | { ok: false; why: string }> {
    // Replace semantics: this entry point has always meant "show this model instead", and federation must not
    // change that silently for a host that only ever holds one. `addModel` is the additive door.
    models.clear();
    models.set(modelId, { meshes: next, guids: nextGuids });

    // Rebuilt here, once, rather than derived per hover. A stale grid would offer snaps to geometry that is no
    // longer in the model, which is worse than offering none.
    buildSnapGrid(allMeshes());
    const built = viewport.showModel(next, guidResolverFor(modelId), modelId);
    viewport.fit();

    // A drawing cut from the previous model is not a view of this one, and a selected GlobalId from it may not
    // exist here. Cleared before the kernel handoff, so an early return below cannot leave them stale.
    drawing = null;
    selection = null;

    // The kernel is brought onto the new model here, not left to the caller. A viewer whose 3D view is right and
    // whose kernel still holds the previous model applies the first edit to a file the user is not looking at.
    if (!("alreadyOpen" in handoff)) {
      const openable = options.kernel as KernelProvider & {
        open?: (id: ModelId, ifc?: string) => Promise<{ ok: boolean; error?: { message: string } }>;
      };
      if (typeof openable.open === "function") {
        const opened = await openable.open(modelId, handoff.ifc);
        if (!opened.ok) {
          return { ok: false, why: opened.error?.message ?? `the kernel would not open ${label}` };
        }
      }
    }

    return { ok: true, elements: built.elements.length };
  }

  /**
   * Add a model beside the ones already loaded, or replace just that one — the federated counterpart of
   * {@link applyModel}.
   *
   * Deliberately **not** wired to the kernel. `applyModel` hands the kernel the model it is showing, because a
   * single-model viewer whose kernel holds a different file edits something the user is not looking at. A federation
   * has no such answer: an authoring kernel edits *one* file, and silently repointing it at whichever consultant's
   * model arrived last would be worse than not touching it. So the reference model — the one the kernel holds and
   * `applyModel` set — stays put, and added models are reference geometry until a host says otherwise. Stated here
   * rather than discovered: an added model is visible, snappable, cuttable and pickable, but not the edit target.
   */
  function addFederatedModel(
    id: ModelId,
    next: readonly SourceMesh[],
    nextGuids: Map<number, string>,
  ): { ok: true; elements: number } | { ok: false; why: string } {
    if (next.length === 0) return { ok: false, why: `${id}: no geometry` };
    reportGuidCollisions(nextGuids, id);
    models.set(id, { meshes: next, guids: nextGuids });

    const built = viewport.addModel(next, guidResolverFor(id), id);
    // The union, not just the new arrival: a snap grid holding only the last-added model would stop offering snaps to
    // the building the user has been working on.
    buildSnapGrid(allMeshes());
    // A drawing cut before this model arrived is a view of a smaller federation, and re-cutting it silently would
    // discard a paper transform the caller chose. Invalidated, so `drawing` never describes a scene that is gone.
    drawing = null;
    return { ok: true, elements: built.elements.length };
  }

  /**
   * The IFC path, as a named function rather than a method.
   *
   * Both `openIfc` and the deprecated `open` need it, and routing one through `this.openIfc` stopped type-checking
   * the moment `createMassingViewer` became async — the object literal's `this` widened to include the promise. A
   * shared implementation was the better shape anyway: a delegate does not need dynamic dispatch.
   */
  async function openIfcImpl(
    source: string | Uint8Array,
    name = "model.ifc",
  ): Promise<{ ok: true; elements: number } | { ok: false; why: string }> {
    if (options.tessellate === undefined) {
      // Refused here, with a sentence, rather than crashing on `undefined(...)` three frames down. A host that
      // never intended to parse IFC in the browser has almost certainly called the wrong method.
      return {
        ok: false,
        why:
          `${name}: no tessellator was supplied, so this viewer cannot read IFC. Either pass \`tessellate\` to ` +
          `createMassingViewer, or use showMeshes() if your pipeline converts IFC outside the browser.`,
      };
    }

    const text = typeof source === "string" ? source : new TextDecoder().decode(source);
    // Sniffed rather than trusted. A `.ifc` that is really an ifcZIP is routine — Revit and Archicad both export
    // one — and handing a ZIP to an IFC parser produces "unexpected token PK", which is useless.
    const head = new TextEncoder().encode(text.slice(0, 4096));
    const sniffed = sniff(name, head, text.length);
    const support = supportFor(sniffed.kind);
    if (support.state !== "supported") {
      return { ok: false, why: `${name}: ${sniffed.kind} — ${support.reason ?? "not supported"}` };
    }

    const parsed = options.tessellate(text);
    if (parsed.meshes.length === 0) return { ok: false, why: `${name}: parsed, but no geometry` };

    return applyModel(parsed.meshes, parsed.guids, { ifc: text }, name);
  }

  const offSelect = viewport.onSelect((refs) => {
    // Model-qualified, so the guid comes out of the map belonging to the model that was actually clicked. Resolving
    // an expressId against the wrong model's map is not a missing lookup — it silently returns *a* guid, for the
    // wrong element, and everything downstream believes it.
    const first = refs[0];
    selection = first === undefined ? null : guidResolverFor(first.modelId)(first.expressId);
    options.onSelect?.(selection);
  });

  let ribbon: Ribbon | null = null;
  if (options.ribbonContainer !== undefined) {
    ribbon = createRibbon(options.ribbonContainer, {
      groups: ribbonFrom(host.contributions()),
      context: { selection: false, canEdit: options.kernel.capabilities.author },
      handlers: {
        onTool: (_id, item) => {
          const command = (host.contributions().commands ?? []).find((c) => c.title === item.title);
          if (command === undefined) {
            status(`${item.label}: no command behind this control`, "warn");
            return;
          }
          void host.runCommand(command.id).catch((error: unknown) => {
            crash.capture(error, { command: command.id });
            status(`${item.label}: ${error instanceof Error ? error.message : String(error)}`, "warn");
          });
        },
      },
    });
  }

  let dropTarget: DropTarget | null = null;
  if (options.onFiles !== undefined) {
    dropTarget = createDropTarget(options.container, {
      onFiles: options.onFiles,
      onError: (message) => status(message, "warn"),
    });
  }

  return {
    viewport,
    kernel: options.kernel,
    host,
    get ribbon() {
      return ribbon;
    },
    modelId,

    openIfc: openIfcImpl,

    async showMeshes(model) {
      if (model.meshes.length === 0) {
        return { ok: false, why: "showMeshes was given no geometry — nothing would be visible" };
      }
      return applyModel(model.meshes, model.guids, model.kernel, "the supplied meshes");
    },

    /**
     * @deprecated Delegates to `openIfc` and does nothing else.
     *
     * Calls the shared implementation rather than `this.openIfc`. Once `createMassingViewer` became async the
     * object literal's `this` widened to `MassingViewer | PromiseLike<MassingViewer>` and `this.openIfc` stopped
     * type-checking — a good prompt to stop routing a delegate through dynamic dispatch it never needed.
     */
    async open(source, name) {
      return openIfcImpl(source, name);
    },

    session,
    commands: registry,

    raise(options = {}) {
      if (selection === null) return null;
      const topic = createTopic({
        title: options.title ?? `Issue on ${selection}`,
        author: "massingviewer",
        // Passed in rather than read from the clock, because `createTopic` requires it for a reason: a BCF export
        // has to be reproducible, and a topic that stamps `new Date()` at creation cannot be byte-compared.
        date: new Date().toISOString(),
        // The pin carries the anchor. `guids` is the identity and `at` is only a position — a pin with a position
        // and no guids is exactly what `resolveAnchor` reports as never-anchored.
        pin: { guids: [selection], at: options.at ?? { x: 0, y: 0 } },
      });
      topics.push(topic);
      return topic;
    },

    get topics() {
      return [...topics];
    },

    get orphans() {
      // Re-resolved on read, not cached. An anchor's liveness is a function of the *current* model, and a cached
      // answer would keep saying "live" after the element was deleted — precisely the failure the orphan machinery
      // exists to surface.
      // Every loaded model, because an anchor is live if the element exists *anywhere* in the federation. Scoping
      // this to one model would report a consultant-model anchor as orphaned the moment federation was used.
      const live = new Set([...models.values()].flatMap((m) => [...m.guids.values()]));
      return topics.filter(
        (topic) => topic.pin !== undefined && !isLive(resolveAnchor(topic.pin, (guid) => live.has(guid))),
      );
    },

    exportBcf() {
      return toBcfZip(topics, { project: { guid: String(options.modelId ?? modelId), name: String(modelId) } });
    },

    cut(view = { kind: "plan", cutHeight: 1.2 }) {
      if (models.size === 0) return null;
      drawing = generatePlan({ name: view.storey ?? "Plan", meshes: federatedElementMeshes() }, view);
      return drawing;
    },

    get drawing() {
      return drawing;
    },

    export(format, theme = ARCHITECTURAL, paper, sheetOptions) {
      if (drawing === null) throw new Error("nothing to export — call cut() first");
      const sheet = paper ?? fitToPaper(drawing, PAPER_SIZES.find((p) => p.name === "A3")!, 10);
      if (sheet === null) throw new Error("this drawing does not fit on A3 at any standard scale");
      /**
       * An exported sheet gets a border and a title block; the interactive SVG does not.
       *
       * The same drawing serves two purposes, and they want opposite furniture. A pane inside the app is a *view* —
       * a title block floating in a panel is noise. A file that leaves the building is a *sheet*, and one without a
       * project name, a sheet number and a revision is not issuable, whatever the linework looks like.
       *
       * The title block's own fields default to the drawing rather than to nothing, so an export that names none of
       * them still carries the scale, the view name and a date instead of an empty block.
       */
      const furniture = {
        border: true,
        scaleBar: sheetOptions?.scaleBar ?? true,
        titleBlock: {
          sheetName: drawing.name,
          ...sheetOptions?.titleBlock,
        },
      };
      if (format === "svg") return toSvg(drawing, theme, sheet, { interactive: true });
      if (format === "dxf") return toDxf(drawing, theme, sheet, furniture);
      return toPdf(drawing, theme, sheet, furniture);
    },

    addModel(model) {
      return addFederatedModel(model.modelId, model.meshes, model.guids);
    },

    removeModel(id) {
      const removed = viewport.removeModel(id);
      if (!removed) return false;
      models.delete(id);
      // The same three things `addModel` does, in reverse: a grid holding vertices of an unloaded model would offer
      // snaps to geometry that is not there, and a drawing cut with it is a view of a federation that no longer
      // exists. A selection into the removed model is dropped by the viewport, so `selection` is re-read rather than
      // assumed still valid.
      buildSnapGrid(allMeshes());
      drawing = null;
      if (selection !== null && modelOfGuid(selection) === null) selection = null;
      return true;
    },

    get models() {
      return [...models.keys()];
    },

    setModelVisible(id, visible) {
      return viewport.setModelVisible(id, visible);
    },

    isModelVisible(id) {
      return viewport.isModelVisible(id);
    },

    select(guid) {
      // A guid is globally unique, so the model holding it is a lookup rather than a guess — and naming it is what
      // stops the same expressId in another model being highlighted instead.
      const found = guid === null ? null : modelOfGuid(guid);
      viewport.select(found === null ? [] : [found.expressId], found?.modelId);
      selection = found === null ? null : guid;
    },

    get selection() {
      return selection;
    },

    dispose() {
      // Idempotent, and it has to be: React strict mode unmounts twice, and throwing the second time turns a
      // benign double-unmount into a crash. Every kernel guide in this repo says the same thing about `dispose`.
      if (disposed) return;
      disposed = true;
      offSelect();
      options.container.removeEventListener("pointermove", onPointerMove);
      dropTarget?.dispose();
      ribbon?.dispose();
      void host.dispose();
      viewport.dispose();
    },
  };
}
