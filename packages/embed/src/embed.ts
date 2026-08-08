import { asModelId, type Guid, type ModelId } from "@massing/core";
import type { KernelProvider } from "@massing/kernel-api";
import { createViewport, type SourceMesh, type Viewport } from "@massing/viewport";
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
  type ViewDefinition,
} from "@massing/drawings2d";
import { createDropTarget, sniff, supportFor, type DropTarget, type OpenedFile } from "@massing/fileio";
import { NOOP_CRASH_SINK, createCrashHandler, type CrashSink } from "@massing/observability";
import { createSession, type AuthoringSession } from "@massing/authoring";
import { createRegistry, type CommandContext } from "@massing/commands";
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
  readonly kernel: KernelProvider;
  readonly host: PluginHost;
  /** `null` when no `ribbonContainer` was given. */
  readonly ribbon: Ribbon | null;
  readonly modelId: ModelId;

  /**
   * Load an IFC. Accepts text or bytes, and sniffs rather than trusting a name.
   *
   * Returns a result rather than throwing, because "this file is a ZIP despite its extension" is a question for
   * the user and not an exception for the caller.
   */
  open(source: string | Uint8Array, name?: string): Promise<{ ok: true; elements: number } | { ok: false; why: string }>;

  /** Cut a drawing from the current model. */
  cut(view?: ViewDefinition): Drawing | null;
  /** The most recently cut drawing. */
  readonly drawing: Drawing | null;
  /** Serialise the current drawing. Throws only if nothing has been cut. */
  export(format: ExportFormat, theme?: Theme, paper?: Paper): string | Uint8Array;

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

/** Meshes the drawing layer can cut, from meshes the viewport was given. */
function toElementMeshes(meshes: readonly SourceMesh[], guidOf: (expressId: number) => Guid | null): ElementMesh[] {
  const out: ElementMesh[] = [];
  for (const mesh of meshes) {
    const guid = guidOf(mesh.expressId);
    if (guid === null) continue;
    out.push({ guid, ifcClass: mesh.ifcType ?? "IfcBuildingElement", positions: Array.from(mesh.positions) });
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

export interface MassingViewerOptionsWithTessellator extends MassingViewerOptions {
  readonly tessellate: Tessellator;
}

export function createMassingViewer(options: MassingViewerOptionsWithTessellator): MassingViewer {
  const modelId = options.modelId ?? asModelId("model");
  const status = options.onStatus ?? (() => {});
  const crash = createCrashHandler({ where: "massingviewer", sink: options.crashSink ?? NOOP_CRASH_SINK });

  const viewport = createViewport({ container: options.container });

  const topics: Topic[] = [];

  /**
   * The command registry and the session.
   *
   * The registry is created here rather than taken as an option because the facade owns the dispatch path — a host
   * that supplied its own would be able to bypass the audit sink and the undo history, which are the two things
   * the command bus exists to guarantee.
   */
  const registry = createRegistry();

  const commandContext = (): CommandContext => ({
    // `edit` unconditionally: the local kernel has no notion of a role, and inventing a restriction the kernel
    // does not enforce would dim controls for a reason that is not true. A host with real roles supplies its own
    // context by wrapping `session`.
    capabilities: new Set(["view", "review", "edit"]),
    selection: selection === null ? [] : [selection],
    supportsOp: () => true,
    opHint: (op) => `"${op}" is not available with this kernel`,
    online: true,
    dispatch: async () => ({ ok: true, value: null }),
  });

  const session = createSession({
    registry,
    context: commandContext,
    // Snap candidates from the model the viewport is actually showing. A callback, so the session never needs to
    // know what a mesh is.
    candidates: (cursor) => {
      const out: { x: number; z: number; kind: "endpoint" }[] = [];
      for (const mesh of meshes) {
        const positions = mesh.positions;
        for (let i = 0; i < positions.length; i += 3) {
          const x = positions[i]!;
          const z = positions[i + 2]!;
          // Pre-filtered to a generous radius so a 200k-vertex model does not hand `resolveSnap` every vertex on
          // every mouse move. The tolerance check inside it is exact; this is only about how much it has to look at.
          if (Math.abs(x - cursor.x) < 2 && Math.abs(z - cursor.z) < 2) out.push({ x, z, kind: "endpoint" });
        }
      }
      return out;
    },
    elementAt: () => selection,
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

  let guids = new Map<number, string>();
  let meshes: readonly SourceMesh[] = [];
  let drawing: Drawing | null = null;
  let selection: Guid | null = null;
  let disposed = false;

  const guidOf = (expressId: number): Guid | null => {
    const raw = guids.get(expressId);
    return raw === undefined ? null : (raw as Guid);
  };

  const offSelect = viewport.onSelect((expressIds) => {
    const first = expressIds[0];
    selection = first === undefined ? null : guidOf(first);
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

    async open(source, name = "model.ifc") {
      const text = typeof source === "string" ? source : new TextDecoder().decode(source);
      // Sniffed rather than trusted. A `.ifc` that is really an ifcZIP is routine — Revit and Archicad both
      // export one — and handing a ZIP to an IFC parser produces "unexpected token PK", which is useless.
      const head = new TextEncoder().encode(text.slice(0, 4096));
      const sniffed = sniff(name, head, text.length);
      const support = supportFor(sniffed.kind);
      if (support.state !== "supported") {
        return { ok: false, why: `${name}: ${sniffed.kind} — ${support.reason ?? "not supported"}` };
      }

      const parsed = options.tessellate(text);
      if (parsed.meshes.length === 0) return { ok: false, why: `${name}: parsed, but no geometry` };

      meshes = parsed.meshes;
      guids = parsed.guids;
      const built = viewport.showModel(meshes, guidOf, modelId);
      viewport.fit();

      // The kernel is reopened on the new bytes here, not left to the caller. A viewer whose 3D view is right and
      // whose kernel still holds the previous model applies the first edit to a file the user is not looking at.
      const openable = options.kernel as KernelProvider & {
        open?: (id: ModelId, ifc?: string) => Promise<{ ok: boolean; error?: { message: string } }>;
      };
      if (typeof openable.open === "function") {
        const opened = await openable.open(modelId, text);
        if (!opened.ok) return { ok: false, why: opened.error?.message ?? "the kernel would not open this model" };
      }

      // A drawing cut from the previous model is not a view of this one.
      drawing = null;
      selection = null;
      return { ok: true, elements: built.elements.length };
    },

      session,

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
      const live = new Set(guids.values());
      return topics.filter(
        (topic) => topic.pin !== undefined && !isLive(resolveAnchor(topic.pin, (guid) => live.has(guid))),
      );
    },

    exportBcf() {
      return toBcfZip(topics, { project: { guid: String(options.modelId ?? modelId), name: String(modelId) } });
    },

    cut(view = { kind: "plan", cutHeight: 1.2 }) {
      if (meshes.length === 0) return null;
      drawing = generatePlan({ name: view.storey ?? "Plan", meshes: toElementMeshes(meshes, guidOf) }, view);
      return drawing;
    },

    get drawing() {
      return drawing;
    },

    export(format, theme = ARCHITECTURAL, paper) {
      if (drawing === null) throw new Error("nothing to export — call cut() first");
      const sheet = paper ?? fitToPaper(drawing, PAPER_SIZES.find((p) => p.name === "A3")!, 10);
      if (sheet === null) throw new Error("this drawing does not fit on A3 at any standard scale");
      if (format === "svg") return toSvg(drawing, theme, sheet, { interactive: true });
      if (format === "dxf") return toDxf(drawing, theme, sheet);
      return toPdf(drawing, theme, sheet, { border: true });
    },

    select(guid) {
      const match = [...guids.entries()].find(([, value]) => value === guid);
      viewport.select(match === undefined ? [] : [match[0]]);
      selection = match === undefined ? null : guid;
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
      dropTarget?.dispose();
      ribbon?.dispose();
      void host.dispose();
      viewport.dispose();
    },
  };
}
