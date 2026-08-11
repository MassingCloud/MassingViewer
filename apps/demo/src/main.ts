import { asModelId, formatLength, IMPERIAL, METRIC, toGuid, type Guid, type ModelId, type UnitSystem } from "@massing/core";
import { createViewport } from "@massing/viewport";
import { browserWorkerTransport, createLocalKernel } from "@massing/kernel-local";
import {
  ARCHITECTURAL,
  FIRE_SAFETY,
  PAPER_SIZES,
  type Drawing,
  type DrawingInput,
  fitToPaper,
  generatePlan,
  dxfLimitations,
  pdfLimitations,
  toDxf,
  toPdf,
  toSvg,
  type TitleBlockFields,
} from "@massing/drawings2d";
import {
  DEFAULT_TOOLSET,
  type Topic,
  anchoredGuids,
  createTopic,
  isLive,
  resolveAnchor,
  toBcfZip,
} from "@massing/markup";
import {
  canPickHandles,
  createDropTarget,
  describe as describeFile,
  pickFiles,
  type OpenedFile,
} from "@massing/fileio";
import {
  BUILTIN_ID,
  builtinManifests,
  commandIdFor,
  createPluginHost,
  ribbonFrom,
  type PluginManifest,
} from "@massing/plugin-host";
import { consoleSink, createCrashHandler, NOOP_CRASH_SINK } from "@massing/observability";
import { browserEnvironment, isolationStatus } from "@massing/pwa";
import { DE, createTranslator } from "@massing/i18n";
import { TOOLS } from "@massing/ui-model";
import { createRibbon } from "@massing/ribbon";
import "@massing/ribbon/ribbon.css";
import type * as THREE from "three";
// `Cache` is a runtime value, not a type — imported separately so the type-only import above stays type-only.
import { Cache as THREE_CACHE } from "three";
import { tessellate } from "./tessellate";
import { wireDraft, type DraftController } from "./draft";

// The fixture is inlined at build time, not fetched. That is the point of the walking skeleton: after first
// paint the demo makes zero network requests, so it is provably working without a backend. massing's own Pages
// demo fetches a model that does not exist and therefore shows no geometry at all.
import sampleIfc from "../../../fixtures/sample.ifc?raw";

/**
 * The crash handler, installed before anything else can throw.
 *
 * `consoleSink` in development and `NOOP_CRASH_SINK` in a build — so a deployed copy of this demo sends nothing
 * anywhere. That default is the actual privacy control: `httpSink(url)` exists for a deployment that wants
 * reports, and choosing it is one argument rather than an unread page.
 *
 * Installed at the top of the module, because a handler attached after initialisation cannot report a failure
 * during it — and initialisation is where the interesting failures are.
 */
const crash = createCrashHandler({
  where: "demo",
  sink: import.meta.env.DEV ? consoleSink() : NOOP_CRASH_SINK,
});
crash.install(window);

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("#app missing");

app.innerHTML = `
  <div class="shell">
    <header>
      <strong>MassingViewer</strong>
      <span class="muted" id="file">sample.ifc</span>
      <button id="open" title="Open an IFC — or just drop one on the model">Open…</button>
      <span class="spacer"></span>
      <button id="fit" title="Frame the model (F)">Fit</button>
      <button id="author" title="Author a wall offline, in a Worker, with no network">+ Wall</button>
      <button id="plan" title="Cut a plan from the model at 1.2 m">Plan</button>
      <button id="theme" title="Repaint the plan — no regeneration" disabled>Arch</button>
      <button id="sheet" title="Show the plan as an issued sheet: border, title block, revision table, scale bar" disabled aria-pressed="false">Sheet</button>
      <button id="delete" title="Delete the selected element (Del) — watch any markup on it orphan">Delete</button>
      <button id="pdf" title="Export the plan as a layered PDF that keeps its GlobalIds" disabled>PDF</button>
      <button id="dxf" title="Export the plan as DXF R12" disabled>DXF</button>
      <button id="bcf" title="Export every markup as BCF 3.0" disabled>BCF</button>
      <button id="units" title="Toggle metric / imperial">m</button>
      <span class="muted" id="fps"></span>
    </header>
    <div id="ribbon"></div>
    <main>
      <div id="viewport"></div>
      <div id="plan-pane" hidden><div id="plan-svg"></div></div>
      <aside>
        <h2>Model</h2>
        <dl id="model"></dl>
        <h2>Kernel</h2>
        <dl id="kernel"><dt>Status</dt><dd class="muted">starting worker…</dd></dl>
        <h2>Plan</h2>
        <dl id="plan-info"><dt>Status</dt><dd class="muted">Press Plan to cut one</dd></dl>
        <h2>Markup</h2>
        <dl id="markup-info"><dt>Status</dt><dd class="muted">Pick a tool, then click an element</dd></dl>
        <div id="tools"></div>
        <ul id="topics"></ul>
        <h2>Selection</h2>
        <dl id="sel"><dt>Status</dt><dd class="muted">Click an element</dd></dl>
        <h2 id="skipped-h" hidden>Not rendered</h2>
        <ul id="skipped"></ul>
      </aside>
    </main>
    <!-- The dynamic-input HUD. Sits over the viewport, above the footer, because it belongs beside the crosshair
         rather than in a panel — a readout you have to look away to read is a readout nobody uses. -->
    <div id="dyn-hud" hidden aria-live="polite"></div>
    <footer>
      <span>drag orbit &middot; shift+drag pan &middot; wheel zoom</span>
      <span class="spacer"></span>
      <span id="status" class="muted"></span>
    </footer>
  </div>
`;

/**
 * `IFCWALL` → `IfcWall`, the class name IFC itself uses.
 *
 * Shared by the properties panel and the drawing input because there were two conversions and they disagreed:
 * the panel did `replace(/^IFC/, "Ifc")` and displayed **IfcWALL**, which is not a class name in any schema and
 * reads as a bug in the data rather than in the label.
 */
const pascalIfc = (upper: string): string =>
  /^IFC./.test(upper) ? `Ifc${upper.charAt(3)}${upper.slice(4).toLowerCase()}` : upper;

const el = <T extends HTMLElement>(sel: string): T => {
  const node = app.querySelector<T>(sel);
  if (!node) throw new Error(`missing ${sel}`);
  return node;
};

const t0 = performance.now();
const { meshes, guids, skipped } = tessellate(sampleIfc);
const parseMs = performance.now() - t0;

// The meshes a plan is cut from. Held rather than discarded after upload to the GPU, because a plan is a *view*
// of the model — regenerating it after an edit must not require re-reading the file.
let sourceMeshes = meshes;
let sourceGuids = guids;
// The tessellator's losses, held for the same reason: a plan generated after an edit must still be able to say
// what never reached it.
let sourceSkipped = skipped;

el("#viewport").insertAdjacentHTML(
  "beforeend",
  '<div id="drop-hint" hidden><span>Drop an IFC to open it</span></div>',
);

/**
 * The translator, from the browser's own locale.
 *
 * `navigator.language` rather than a setting, because a first-run app has no setting and the browser's answer is
 * the best available guess. German is the only catalogue that exists, so everything else lands on English via the
 * fallback rather than on a blank UI — see docs/i18n.md for how far the translation actually reaches.
 */
const locale = navigator.language.split("-")[0] ?? "en";
const i18n = createTranslator({ locale, catalogue: locale === "de" ? DE : {} });

const viewport = await createViewport({ container: el("#viewport") });

const resolveGuid = (expressId: number): Guid | null => toGuid(guids.get(expressId));
// Reassigned when the kernel authors something and the model is re-tessellated from its IFC output.
let built = viewport.showModel(meshes, resolveGuid, asModelId("sample"));

let units: UnitSystem = METRIC;

// --- panels ---------------------------------------------------------------------------------------

function row(dl: HTMLElement, term: string, value: string, cls = "") {
  dl.insertAdjacentHTML("beforeend", `<dt>${term}</dt><dd class="${cls}">${value}</dd>`);
}

/**
 * The empty state of a `<dl>` panel — and it needs a `<dt>`, which is the whole reason this is a function.
 *
 * These panels started life with a bare `<dd class="muted">Click an element</dd>`. That is a definition with
 * nothing being defined: `axe-core` reports it as `serious` (`definition-list`), and to a screen reader the
 * list announces a value whose term is missing. Five sites had it, which is what a copied inline string does.
 *
 * `Status` is the honest term. The heading above the list names the *panel*, not the row, so the row still needs
 * its own label — and "Status: Click an element" is exactly what the row means.
 */
function placeholder(dl: HTMLElement, message: string) {
  dl.innerHTML = `<dt>Status</dt><dd class="muted">${message}</dd>`;
}

// Read the extents off the box directly rather than via getSize(), so this file needs no THREE import and
// `viewport` stays the only package that touches three.
const bounds = built.bounds;
const dims = {
  x: bounds.max.x - bounds.min.x,
  y: bounds.max.y - bounds.min.y,
  z: bounds.max.z - bounds.min.z,
};

function renderModelPanel() {
  const dl = el("#model");
  dl.innerHTML = "";
  // `plural`, not `String(n)`. The row is one number today and the moment it becomes a sentence — which is what
  // the markup panel below already is — a concatenation would be untranslatable. Doing it here keeps one habit
  // rather than two.
  row(dl, "Elements", i18n.plural("count.elements", distinctElements()));
  row(dl, "Triangles", built.triangles.toLocaleString());
  row(dl, "Parse", `${parseMs.toFixed(1)} ms`);
  row(dl, "Extent", `${formatLength(dims.x, units)} × ${formatLength(dims.z, units)}`);
  row(dl, "Height", formatLength(dims.y, units));
  // Identity coverage, shown rather than assumed. If this is not 100% something in the resolver is wrong and
  // every markup anchored to this model would be anchored to nothing.
  // Counted over distinct elements too, or a wall split into three bands would count its GlobalId three times and
  // the coverage percentage would be an average over meshes rather than over the building.
  const identified = new Set(
    built.elements.filter((e) => e.guid !== null).map((e) => e.expressId),
  ).size;
  const total = distinctElements();
  const pct = Math.round((100 * identified) / Math.max(1, total));
  row(dl, "GlobalIds", `${identified}/${total} (${pct}%)`, pct === 100 ? "ok" : "warn");

  /**
   * Threading, shown rather than left to be discovered.
   *
   * The plan's instruction is that the single-threaded fallback must be **visible**, because a silent one is a
   * 5× perf cliff with no error and no warning — just a deployment that is inexplicably slower than another. It
   * is `muted` rather than `warn` here on purpose: nothing in this app needs `SharedArrayBuffer` yet (ADR-0010),
   * so single-threaded is the expected state and flagging it as a problem would be crying wolf. The row exists so
   * that when something *does* need it, the answer is already on screen.
   */
  const isolation = isolationStatus(browserEnvironment());
  row(dl, "Threads", isolation.isolated ? "shared memory" : "single", isolation.isolated ? "ok" : "muted");
}
renderModelPanel();

// Anything the tessellator could not handle is listed, not hidden. A viewer silently missing half a building
// is the failure mode this codebase keeps designing against — and this tessellator ignores openings by
// design, so saying so is the honest thing.
function renderSkipped(list: typeof skipped): void {
  el("#skipped-h").hidden = list.length === 0;
  el("#skipped").innerHTML = list
    .map((s) => `<li><code>#${s.expressId}</code> ${s.type} — ${s.reason}</li>`)
    .join("");
}
renderSkipped(skipped);

// --- selection ------------------------------------------------------------------------------------

// Derived on demand rather than captured once. Authoring replaces the whole model, and a map built at startup
// would show "?" for the class of anything created afterwards — the panel quietly disagreeing with the model.
const elementAt = (expressId: number) => built.elements.find((e) => e.expressId === expressId);

/**
 * Distinct IFC elements, not meshes.
 *
 * A wall with a door is now several extrusions — two jambs and a lintel — and `showModel` makes one `SceneElement`
 * per mesh, all sharing the host's expressID. So `built.elements.length` counts *bands*, and the Model panel jumped
 * from 6 elements to 11 the moment openings started being subtracted. The count is user-facing and was simply wrong.
 */
function distinctElements(): number {
  // A `function` declaration, not a `const` arrow: `renderModelPanel()` runs at module top level *above* this
  // point, and a `const` there is a temporal dead zone — the app threw "Cannot access 'distinctElements' before
  // initialization" on load and rendered nothing. The crash handler reported it, which is the one reason it was a
  // thirty-second fix rather than a blank page to debug.
  return new Set(built.elements.map((e) => e.expressId)).size;
}

/**
 * The world-space box of every mesh belonging to one element.
 *
 * The gizmo needs the whole wall, not one band. `elementAt` returns the *first* match, so handles on a door wall
 * would have wrapped whichever piece happened to come first — most likely the lintel, floating above the opening.
 */
function unionBox(expressId: number): THREE.Box3 | null {
  let box: THREE.Box3 | null = null;
  for (const element of built.elements) {
    if (element.expressId !== expressId) continue;
    element.object.geometry.computeBoundingBox();
    const local = element.object.geometry.boundingBox;
    if (local === null) continue;
    const world = local.clone().applyMatrix4(element.object.matrixWorld);
    box = box === null ? world : box.union(world);
  }
  return box;
}

/**
 * The ONE way selection changes — the viewport highlight and the panel are written together.
 *
 * They were separate: the click handler set both, but the Escape handler called `viewport.select([])` and
 * nothing else, so the highlight cleared while the panel went on displaying the element that was no longer
 * selected. An E2E test caught it. The bug is not that a call was forgotten; it is that the shape of the code
 * allowed two places to hold an opinion about what is selected. Routing both through here means they cannot
 * disagree, and a future third caller (the palette, a plugin, a plan-pane click) gets it right by default.
 */
let selectedGuid: string | null = null;

function applySelection(hit: { expressId: number; guid: string | null; modelId?: ModelId | null } | null): void {
  // `modelId` is passed through even though the demo loads one model: an expressId is unique only within a file, so a
  // host that later loads two would silently highlight the id in both. Threading what `pick()` already returns costs
  // nothing and removes the trap rather than documenting it.
  viewport.select(hit ? [hit.expressId] : [], hit?.modelId ?? undefined);
  selectedGuid = hit?.guid ?? null;
  // 3D → plan, and 3D → ribbon. Kept in this one function for the same reason the panel is: two places holding
  // an opinion about what is selected is how they end up disagreeing.
  highlightPlan();
  ribbon?.update({ selection: hit !== null, canEdit: true });

  const dl = el("#sel");
  dl.innerHTML = "";
  if (!hit) {
    placeholder(dl, "Click an element");
    // Nothing selected, so no handles. Leaving them behind would offer a transform of whatever was selected last.
    draft?.select(null);
    return;
  }
  const element = elementAt(hit.expressId);

  /**
   * The transform handles follow the selection.
   *
   * The box comes from the element's own geometry rather than from the model bounds, or every element would get
   * handles the size of the building. Computed here because `SceneElement.object` is the mesh and its bounding box
   * is not cached.
   */
  const box = element === undefined ? null : unionBox(hit.expressId);
  draft?.select(box === null ? null : { guid: hit.guid, box });

  row(dl, "Class", element === undefined ? "?" : pascalIfc(element.ifcType));
  row(dl, "expressID", `#${hit.expressId}`);
  // Both ids, deliberately: expressID is what the parse layer and the drawing generator speak, GlobalId is
  // the only one safe to persist. Showing both is how the distinction stays visible.
  row(dl, "GlobalId", hit.guid ?? "— unresolved", hit.guid ? "mono" : "warn");

  // The property inspector, asked for asynchronously — the kernel runs in a Worker.
  void inspect(hit.guid);
}

/**
 * The property inspector: property sets and material layers, read from the kernel.
 *
 * ## Why it is a separate async pass rather than part of `applySelection`
 *
 * `properties()` crosses a Worker boundary, so it cannot be part of a synchronous selection handler without making
 * selection feel slow. The panel therefore fills in a moment later, and `pending` guards the case that matters:
 * clicking quickly through several elements starts several requests, and without the guard a slow earlier reply
 * would overwrite a faster later one — the panel would show the properties of an element the user is no longer
 * looking at, with nothing on screen to suggest it.
 *
 * ## Batched, even for one element
 *
 * `properties` takes an array and returns a Map because the interface calls per-element round-trips "the usual
 * perf mistake". Calling it with one ref keeps this on the same path a multi-selection will use.
 */
let pending: string | null = null;

async function inspect(guid: string | null): Promise<void> {
  pending = guid;
  if (guid === null || !kernelReady) return;

  const answered = await kernel.properties([{ modelId: MODEL, guid: guid as Guid }]);
  // The selection moved on while the Worker was answering. Dropping this reply is the whole point of `pending`.
  if (pending !== guid) return;
  if (!answered.ok) {
    row(el("#sel"), "Properties", answered.error.message, "warn");
    return;
  }

  const props = answered.value.get(guid as Guid);
  if (props === undefined) {
    // Absent, not empty — `properties` deliberately omits an element it could not answer for, so a caller can
    // tell "no properties" from "not found". Saying which is the honest thing to render.
    row(el("#sel"), "Properties", "none recorded", "muted");
    return;
  }

  const dl = el("#sel");
  if (props.name !== undefined && props.name !== "") row(dl, "Name", props.name);
  if (props.predefinedType !== undefined && props.predefinedType !== "") {
    row(dl, "Type", props.predefinedType);
  }

  const sets = Object.entries(props.psets).filter(([, values]) => Object.keys(values).length > 0);
  if (sets.length === 0 && (props.materials ?? []).length === 0) {
    // Said out loud. An element with a name and no property sets otherwise rendered the name and then silence,
    // which is indistinguishable from a panel still waiting on the Worker — and "still loading" is the reading a
    // user will take, because it is the one that suggests the data might arrive.
    row(dl, "Properties", "no property sets", "muted");
    return;
  }

  for (const [setName, values] of sets) {
    const entries = Object.entries(values);
    // The Pset name as its own row, so a reader can see which standard set a value came from — `Pset_WallCommon`
    // is a different claim from a vendor's own set, and flattening them would lose that.
    row(dl, setName, `${entries.length} propert${entries.length === 1 ? "y" : "ies"}`, "muted");
    for (const [key, value] of entries) {
      row(dl, `· ${key}`, formatPropertyValue(value));
    }
  }

  for (const layer of props.materials ?? []) {
    // Thickness through `formatLength`, so the inspector follows the unit toggle like every other measurement.
    row(dl, "Layer", `${layer.name} — ${formatLength(layer.thickness, units)}`);
  }
}

/** A property value as one line. IFC values are heterogeneous and a raw `[object Object]` is worse than nothing. */
function formatPropertyValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return String(+value.toFixed(6));
  if (typeof value === "string") return value;
  // An object or array: JSON, truncated. Rendering the shape is more useful than hiding it, and truncating keeps
  // one deeply-nested value from pushing the rest of the panel off screen.
  const text = JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

viewport.renderer.domElement.addEventListener("click", (event) => {
  // Not while a gizmo handle is being dragged: a drag that also reselected would swap the element mid-transform
  // and the handles would jump to something the user was not editing.
  if (draft?.gizmo.dragging === true) return;
  /**
   * And not while a draw tool is armed.
   *
   * `stopPropagation` on `pointerdown` does not stop the `click` that follows it, so every point placed while
   * drafting was *also* selecting whatever was underneath — which attached transform handles mid-command, and the
   * next click landed on a handle instead of placing a point. The wall came out at the cursor distance rather than
   * the typed one, with nothing to suggest why.
   */
  if (draft !== null && draft.session.state.armed !== null) return;
  applySelection(viewport.pick(event));
});

// --- controls -------------------------------------------------------------------------------------

el("#fit").addEventListener("click", () => viewport.fit());
el("#units").addEventListener("click", () => {
  units = units === METRIC ? IMPERIAL : METRIC;
  el("#units").textContent = units === METRIC ? "m" : "ft";
  renderModelPanel();
});

// --- opening a file -------------------------------------------------------------------------------

/**
 * Load an IFC that arrived from the user, replacing the model.
 *
 * The whole path the fixture takes at startup, reachable at runtime: tessellate, show, reopen the kernel, and
 * re-render every panel. Factored out rather than duplicated, because a second "load a model" code path is how
 * the dropped-file case ends up subtly different from the startup case — working geometry with a kernel still
 * holding the old model, say, so the first edit writes into the wrong file.
 */
async function loadIfc(text: string, name: string): Promise<void> {
  const next = tessellate(text);
  if (next.meshes.length === 0) {
    renderKernelPanel(`${name}: parsed, but no geometry — nothing here this can tessellate`, "warn");
    return;
  }

  built = viewport.showModel(next.meshes, (id) => toGuid(next.guids.get(id)), MODEL);
  sourceMeshes = next.meshes;
  sourceGuids = next.guids;
  sourceSkipped = next.skipped;
  viewport.fit();

  // The kernel must be reopened on the new bytes *before* anything can be authored against them. Leaving it on
  // the old model is the failure this function exists to prevent: the 3D view would be right and the first edit
  // would apply to a file the user is no longer looking at.
  const opened = await openable.open(MODEL, text);
  kernelReady = opened.ok;

  // A plan cut from the old model is not a view of this one.
  drawing = null;
  el("#plan-pane").hidden = true;
  el<HTMLButtonElement>("#dxf").disabled = true;
  el<HTMLButtonElement>("#pdf").disabled = true;
  el<HTMLButtonElement>("#bcf").disabled = topics.length === 0;
  selectedGuid = null;

  el("#file").textContent = name;
  renderModelPanel();
  renderSkipped(next.skipped);
  // Topics are deliberately kept, not cleared. Anchors resolve against GlobalIds, so a topic from the previous
  // model orphans and *says* it orphaned — which is more useful than silently discarding a reviewer's work, and
  // it is exactly the mechanism the delete-an-element case already exercises.
  renderTopics();
  renderKernelPanel(
    kernelReady ? `${name}: ${next.meshes.length} element(s) — no network` : "worker did not accept the model",
    kernelReady ? "ok" : "warn",
  );
}

/**
 * Take whatever was dropped or picked.
 *
 * Refuses with the *format's own reason* rather than a generic message. That is the whole point of
 * `supportFor`: "point clouds are M10" and "the only good browser DWG reader is GPL-3.0, export a DXF" are
 * sentences a user can act on, and "unsupported file type" is not.
 */
async function accept(files: readonly OpenedFile[]): Promise<void> {
  if (files.length === 0) return;

  const openable_ = files.filter((f) => f.support.state === "supported");
  if (openable_.length === 0) {
    // One line per file, so a mixed drop explains every rejection instead of reporting the first.
    renderKernelPanel(files.map((f) => describeFile(f, f.sniffed)).join(" · "), "warn");
    return;
  }

  const first = openable_[0]!;
  if (!first.sniffed.agrees) {
    // Surfaced, not silently resolved — the bytes are almost certainly right, but only the user knows whether a
    // `.ifc` that is really a ZIP was a mislabel or an ifcZIP they meant to send.
    renderKernelPanel(describeFile(first, first.sniffed), "warn");
  }
  await loadIfc(await first.text(), first.name);

  if (openable_.length > 1) {
    // Never silently ignore the rest. A drop of four models that loaded one and said nothing reads as a bug.
    renderKernelPanel(
      `opened ${first.name}; ${openable_.length - 1} more file(s) ignored — one model at a time, for now`,
      "warn",
    );
  }
}

const dropHint = el("#drop-hint");
createDropTarget(el("#viewport"), {
  onFiles: (files) => void accept(files),
  onHover: (hovering) => {
    dropHint.hidden = !hovering;
  },
  onError: (message) => renderKernelPanel(message, "warn"),
});

// Say which picker this browser has, in the one place a user would look. `showOpenFilePicker` returns handles
// that can be persisted, so a recent-files list genuinely reopens; an `<input>` cannot, and no amount of UI
// wishing makes it. Stating the difference beats offering "Recent files" that silently does not work — which is
// what happens when a feature is built against the capability one browser has.
el("#open").title = canPickHandles()
  ? "Open an IFC — or just drop one on the model. This browser can remember the file for reopening."
  : "Open an IFC — or just drop one on the model. This browser cannot remember the file, so reopening means picking it again.";

el("#open").addEventListener("click", () => {
  void (async () => {
    const result = await pickFiles({ accept: [".ifc", ".ifcxml", ".ifczip"], description: "IFC models" });
    // `via` is reported because the two mechanisms are not equivalent: handles can be persisted so a recent-files
    // list genuinely reopens, an <input> cannot. Today that is Chromium versus Safari and Firefox.
    if (result.files.length === 0 && result.via === "input") return;
    await accept(result.files);
  })();
});

window.addEventListener("keydown", (e) => {
  // While a draft tool is armed, these keys belong to it: `f` is a valid character in a typed distance, and
  // Escape cancels the *command* rather than the selection. The draft module's own handler already ran and
  // consumed them — this guard stops the second, unrelated meaning from also firing.
  if (draft !== null && draft.session.state.armed !== null) {
    if (e.key === "Escape") draft.disarm();
    return;
  }
  if (e.key === "f" || e.key === "F") viewport.fit();
  if (e.key === "Escape") applySelection(null);
});

// --- offline authoring, in a real Worker -----------------------------------------------------------
//
// This is the claim the whole product rests on, so the demo makes it checkable rather than stating it:
// **the model is edited in your browser, by a kernel in a Worker, with no network.**
//
// It is also the only place thread isolation is actually verified. The unit suite drives `LocalKernel` over a
// `MessageChannel` — real serialisation, real asynchrony, same thread — because a `node:worker_threads` variant
// could not load its own TypeScript module graph. So "runs off the main thread" is tested *here*, by an E2E
// test that authors a wall through a genuine `new Worker(...)` and asserts the model changed.

const MODEL = asModelId("sample");
let authored = 0;

// A genuine Worker, constructed here because only the app knows its bundler. Vite sees this form and emits the
// worker as its own chunk; a `new URL` inside the package would resolve against a module that has already been
// inlined, and no chunk would be emitted at all — which is exactly what happened first time.
const kernelWorker = new Worker(new URL("./kernel.worker.ts", import.meta.url), {
  type: "module",
  name: "massingviewer-local-kernel",
});
const kernel = createLocalKernel(browserWorkerTransport(kernelWorker));
// `open` is not part of KernelProvider — it is how a model gets into a kernel — so it is reached through the
// concrete type rather than the interface.
const openable = kernel as typeof kernel & {
  open(id: typeof MODEL, ifc?: string): Promise<{ ok: boolean; error?: { message: string } }>;
};

function renderKernelPanel(note: string, cls?: string): void {
  const dl = el("#kernel");
  dl.innerHTML = "";
  row(dl, "Provider", `${kernel.id} · offline`);
  row(dl, "Ops", String(kernelOps));
  row(dl, "Authored", String(authored));
  row(dl, "Status", note, cls);
}

let kernelOps = 0;

/**
 * The draft-tool controller, created once the kernel has answered.
 *
 * `null` until then, and every call site uses `draft?.` for a real reason rather than defensiveness: the worker
 * takes a moment to start, and a wall tool armed before the kernel can say which operations it supports would
 * show every verb as enabled and then refuse on click. `availability()` reads the op list, so the list has to
 * exist first.
 */
let draft: DraftController | null = null;
let kernelReady = false;

async function startKernel(): Promise<void> {
  const opened = await openable.open(MODEL, sampleIfc);
  if (!opened.ok) {
    renderKernelPanel(opened.error?.message ?? "could not open the model", "warn");
    return;
  }
  const ops = await kernel.ops();
  kernelOps = ops.ok ? ops.value.length : 0;
  kernelReady = ops.ok;
  renderKernelPanel(kernelReady ? "ready — no network" : "worker did not answer", kernelReady ? "ok" : "warn");

  if (!kernelReady) return;
  draft = wireDraft({
    viewport,
    kernel,
    modelId: MODEL,
    canvas: el("#viewport"),
    hud: el("#dyn-hud"),
    // A getter, not a snapshot: authoring replaces the mesh array, and a captured reference would keep the draft
    // tool snapping to the geometry the model had when the worker started.
    meshes: () => sourceMeshes,
    onModelChanged: reloadFromKernel,
    status: (message, kind) => {
      el("#status").textContent = message;
      el("#status").className = kind ?? "muted";
    },
    canEdit: () => true,
  });
  // The ribbon re-evaluates availability, so the three draw verbs stop being dimmed the moment the kernel is up.
  ribbon.update({ selection: false, canEdit: true });
}

/**
 * Re-render from the kernel's own IFC output, and refresh everything that describes the model.
 *
 * Extracted when the draft tools landed and needed the identical sequence. Duplicating it was the alternative and
 * would have been the worse kind of duplication: the two copies would have diverged in *which panels they
 * refreshed*, so a wall drawn with the wall tool would leave the markup list or the plan stale while the same wall
 * from `+ Wall` did not. That is a bug nobody attributes to a missing function call.
 *
 * Deliberately a full round trip — export, re-tessellate, re-upload — rather than adding a mesh locally. Anything
 * less would prove the command worked and not that the *file* changed, and the file is what a user keeps.
 */
async function reloadFromKernel(): Promise<void> {
  const exported = await kernel.exportIfc(MODEL);
  if (!exported.ok) {
    renderKernelPanel(exported.error.message, "warn");
    return;
  }
  const next = tessellate(new TextDecoder().decode(exported.value));
  built = viewport.showModel(next.meshes, (id) => toGuid(next.guids.get(id)), MODEL);
  sourceMeshes = next.meshes;
  sourceGuids = next.guids;
  // Reassigned with the meshes, or the plan reports the *previous* model's losses — stale provenance is worse
  // than none, because it looks like an answer.
  sourceSkipped = next.skipped;
  // A plan is a *view*: if one is open it must follow the edit, not go stale until someone presses the button.
  if (drawing !== null) generate();
  // An edit is exactly when an anchor can break, so the markup list is re-resolved rather than left stale.
  renderTopics();
  renderModelPanel();
  renderSkipped(next.skipped);
  // The draft tool's snap candidates come from this geometry. Left stale, the next point would snap to where the
  // previous wall used to be — a wall in the wrong place, with no error anywhere.
  draft?.refreshSnaps();
  reattachGizmo();
}

/**
 * Put the transform handles back on the selected element after the model was rebuilt.
 *
 * Necessary because `showModel` replaces every mesh: the `SceneElement` the gizmo measured no longer exists, so
 * the handles keep sitting at the coordinates the element *used to* occupy. Found by dragging a column twice in a
 * browser — the first drag worked, the second silently did nothing, because the second press landed where the
 * element now was and the handles were still two metres away. Nothing errored; the status line still showed the
 * *previous* commit, which made it look like the drag had worked.
 *
 * Re-found by GlobalId rather than by expressID, because a re-tessellation does not promise to keep expressIDs
 * stable and the GlobalId is the only identity that survives a round trip through the file.
 */
function reattachGizmo(): void {
  if (draft === null) return;
  if (selectedGuid === null) {
    draft.select(null);
    return;
  }
  const element = built.elements.find((e) => e.guid === selectedGuid);
  if (element === undefined) {
    // Deleted, or its id no longer resolves. Handles on a vanished element would offer edits that refuse.
    draft.select(null);
    return;
  }
  const box = unionBox(element.expressId);
  draft.select(box === null ? null : { guid: selectedGuid, box });
}

/**
 * Author a wall, then re-render from the kernel's own IFC output.
 *
 * Deliberately a full round trip — apply, export, re-tessellate — rather than adding a mesh locally. Anything
 * less would prove the button worked and not that the *file* changed, and the file is what a user keeps.
 */
async function authorWall(): Promise<void> {
  if (!kernelReady) return;
  const button = el<HTMLButtonElement>("#author");
  button.disabled = true;
  try {
    // Spaced apart so successive clicks are visibly separate walls rather than one wall drawn twice.
    const y = 6 + authored * 1.5;
    const applied = await kernel.apply(MODEL, "add_wall", {
      start: [0, y],
      end: [8.4, y],
      height: 3,
      thickness: 0.2,
      name: `Wall-Authored-${authored + 1}`,
    });
    if (!applied.ok) {
      // A refusal is a normal outcome, not an incident: it is shown in the panel and the button stays usable.
      renderKernelPanel(`${applied.error.code}: ${applied.error.message}`, "warn");
      return;
    }

    authored += 1;
    await reloadFromKernel();
    renderKernelPanel(`authored ${applied.value.created.length} element · v${applied.value.modelVersion}`, "ok");
  } finally {
    button.disabled = false;
  }
}

/**
 * Delete the selected element through the kernel.
 *
 * Here for two reasons. `delete_element` is one of the fifteen operations and is otherwise undemonstrated — and
 * more importantly, deleting an element a markup points at is the only way to *see* the orphaning behaviour that
 * separates a GlobalId anchor from a sticker on a picture. A feature whose distinguishing property cannot be
 * observed is one nobody will believe.
 */
async function deleteSelected(): Promise<void> {
  if (!kernelReady || selectedGuid === null) {
    renderKernelPanel("select an element to delete", "warn");
    return;
  }
  const button = el<HTMLButtonElement>("#delete");
  button.disabled = true;
  try {
    const applied = await kernel.apply(MODEL, "delete_element", { guid: selectedGuid });
    if (!applied.ok) {
      renderKernelPanel(`${applied.error.code}: ${applied.error.message}`, "warn");
      return;
    }
    const exported = await kernel.exportIfc(MODEL);
    if (!exported.ok) {
      renderKernelPanel(exported.error.message, "warn");
      return;
    }
    const next = tessellate(new TextDecoder().decode(exported.value));
    built = viewport.showModel(next.meshes, (id) => toGuid(next.guids.get(id)), MODEL);
    sourceMeshes = next.meshes;
    sourceGuids = next.guids;
    // Reassigned with the meshes, or the plan reports the *previous* model's losses — stale provenance is
    // worse than none, because it looks like an answer.
    sourceSkipped = next.skipped;
    applySelection(null);
    if (drawing !== null) generate();
    // The moment an anchor breaks. Re-resolving here is what turns a deleted element into a visibly orphaned
    // issue rather than an issue that quietly refers to nothing.
    renderTopics();
    renderModelPanel();
    renderKernelPanel(`deleted 1 element · v${applied.value.modelVersion}`, "ok");
  } finally {
    button.disabled = false;
  }
}

el("#delete").addEventListener("click", () => void deleteSelected());
el("#author").addEventListener("click", () => void authorWall());
void startKernel();

// --- the plan pane: a plan is a live view of the model ---------------------------------------------
//
// The loop nobody else has closed, in one screen: cut a plan from the model, click a line in it, and the element
// highlights in 3D. Both directions, because both are needed — a reviewer clicks a plan, and a modeller selects
// in 3D and wants to see where it is on the sheet.
//
// The drawing is generated once and *repainted* to switch discipline. That is the claim `drawings2d` exists to
// make good on, and the Arch/Fire button is here so it can be seen rather than read about.

let drawing: Drawing | null = null;
let planTheme = ARCHITECTURAL;
/** Whether the plan pane is showing an issued sheet or bare linework. */
let asSheet = false;
/**
 * A fixed date on the demo's title block.
 *
 * Not `new Date()`. The demo is what the E2E suite and the visual baseline drive, and a title block that stamps
 * today's date would change the sheet every day — turning a stable baseline into a daily false alarm. The same
 * reasoning `pdf.ts` already applies to its own creation date.
 */
const SHEET_DATE = "2026-08-11";

/**
 * The demo's title block, in one place.
 *
 * Shared between the pane toggle and the two file exports on purpose: a sheet whose PDF says one thing and whose
 * on-screen preview says another is the drift the Semantic Drawing Model exists to prevent, and it would be the
 * demo's own fault rather than the library's.
 */
const sheetFields = (name: string): TitleBlockFields => ({
  project: "MassingViewer sample",
  sheetName: name,
  sheetNumber: "A-101",
  date: SHEET_DATE,
  drawnBy: "MV",
  revision: "A",
  status: "FOR REVIEW",
  revisions: [{ rev: "A", date: SHEET_DATE, description: "Cut from the model", by: "MV" }],
});

/** The tessellated model as drawing input, carrying the identity each line must keep. */
function planInput(): DrawingInput {
  return {
    name: "L1 Plan",
    meshes: sourceMeshes.map((m) => ({
      guid: toGuid(sourceGuids.get(m.expressId)),
      ifcClass: pascalIfc(m.ifcType ?? "IFCPRODUCT"),
      positions: m.positions,
      indices: m.indices,
    })),
    // What the tessellator could not build. Passed through so the plan's `incomplete[]` covers the whole pipeline
    // rather than only the sectioning stage — the golden suite found this reporting an empty list for a model
    // three elements short, which is precisely what the field was added to make impossible.
    skipped: sourceSkipped.map((s) => ({
      guid: toGuid(sourceGuids.get(s.expressId)),
      ifcClass: pascalIfc(s.type),
      reason: s.reason,
    })),
  };
}

function paintPlan(): void {
  if (drawing === null) return;
  const paper = fitToPaper(drawing, PAPER_SIZES.find((p) => p.name === "A3")!, 10);
  if (paper === null) {
    el("#plan-svg").innerHTML = `<p class="warn">This plan does not fit on A3 at any standard scale.</p>`;
    return;
  }
  // `interactive` adds the transparent fat twins that make 0.5 mm linework clickable. Without them plan↔3D
  // selection is technically present and practically unusable.
  el("#plan-svg").innerHTML = toSvg(drawing, planTheme, paper, {
    interactive: true,
    border: true,
    // Off by default: a title block inside a live pane is furniture around a view, not a sheet. The toggle is here
    // because the difference between "a plan" and "an issued sheet" is the point of the feature, and a demo that
    // only ever showed one of the two would not make it.
    ...(asSheet ? { scaleBar: true, titleBlock: sheetFields(drawing.name) } : {}),
  });
  highlightPlan();
}

function generate(): void {
  drawing = generatePlan(planInput(), { kind: "plan", cutHeight: 1.2 });
  el("#plan-pane").hidden = false;
  el<HTMLButtonElement>("#theme").disabled = false;
  el<HTMLButtonElement>("#sheet").disabled = false;
  el<HTMLButtonElement>("#dxf").disabled = false;
  el<HTMLButtonElement>("#pdf").disabled = false;
  paintPlan();

  const dl = el("#plan-info");
  dl.innerHTML = "";
  row(dl, "Entities", String(drawing.entities.length));
  const pct = Math.round(drawing.provenance.guidCoverage * 100);
  // The KPI. Below 100% means linework that cannot be marked up, and it is shown rather than logged.
  row(dl, "Identified", `${pct}%`, pct === 100 ? "ok" : "warn");
  row(dl, "Cut at", formatLength(drawing.view.cutHeight ?? 0, units));
  if (drawing.provenance.incomplete.length > 0) {
    row(dl, "Incomplete", String(drawing.provenance.incomplete.length), "warn");
  }
}

/** Outline the plan entities belonging to the current 3D selection. */
function highlightPlan(): void {
  const svg = el("#plan-svg").querySelector("svg");
  if (svg === null) return;
  for (const node of svg.querySelectorAll<SVGElement>("[data-guid]")) {
    node.classList.remove("sel");
  }
  if (selectedGuid === null) return;
  // Every entity for the element, not the first: one L-shaped wall produces several loops, and lighting one leg
  // looks like a bug in the model.
  for (const node of svg.querySelectorAll<SVGElement>(`[data-guid="${CSS.escape(selectedGuid)}"]`)) {
    node.classList.add("sel");
  }
}

el("#plan").addEventListener("click", generate);
el("#theme").addEventListener("click", () => {
  planTheme = planTheme === ARCHITECTURAL ? FIRE_SAFETY : ARCHITECTURAL;
  el("#theme").textContent = planTheme === ARCHITECTURAL ? "Arch" : "Fire";
  // No regeneration. Same Drawing, different stylesheet.
  paintPlan();
});

el("#sheet").addEventListener("click", () => {
  asSheet = !asSheet;
  // `aria-pressed` rather than a colour change alone: this is a toggle, and a toggle whose state only exists as a
  // shade is invisible to a screen reader and to anyone who cannot see the shade.
  el("#sheet").setAttribute("aria-pressed", String(asSheet));
  // Also no regeneration. Sheet furniture is a render-time argument, exactly like the theme — which is the ADR-0004
  // claim this button demonstrates rather than asserts.
  paintPlan();
});

// Plan → 3D. The markup story in miniature: a click on linework resolves to a GlobalId, not to a coordinate.
el("#plan-pane").addEventListener("click", (event) => {
  const target = (event.target as Element | null)?.closest("[data-guid]");
  const guid = target?.getAttribute("data-guid");
  if (guid === null || guid === undefined) return;
  const element = built.elements.find((e) => e.guid === guid);
  if (element === undefined) return;
  applySelection({ expressId: element.expressId, guid });
});

// --- markup: an issue that knows which wall it is about --------------------------------------------
//
// The other half of the loop. Every PDF-based review tool stores a shape on a flattened raster that has forgotten
// what it refers to. Here a markup carries the element's IFC GlobalId, so it survives a model change, can be
// filtered by element, and exports as BCF that opens in Solibri, BIMcollab, Revizto and Bonsai.
//
// Delete the element a markup points at and it becomes *orphaned* — visibly, with a reason. That outcome is the
// one every other tool lacks, and it is why an issue log here cannot quietly look resolved.

let topics: Topic[] = [];
let armedTool = DEFAULT_TOOLSET.tools[0]!.id;

function renderTools(): void {
  el("#tools").innerHTML = DEFAULT_TOOLSET.tools
    .map(
      (t) =>
        `<button class="tool${t.id === armedTool ? " armed" : ""}" data-tool="${t.id}" ` +
        `title="${t.label} — creates a ${t.topicDefaults?.type ?? "Issue"}">${t.glyph ?? t.label}</button>`,
    )
    .join("");
}

/**
 * Re-resolve every markup against the model as it is *now*.
 *
 * Called after any edit, because that is the moment an anchor can break. Reporting the outcome per topic — live,
 * partial, or orphaned with a reason — is the entire difference between a markup that means something and a
 * sticker on a picture.
 */
function renderTopics(): void {
  // `Guid`, not `string`. `SceneElement.guid` is `Guid | null`, so narrowing it to `string` is a predicate whose
  // type is not assignable to its parameter — which `tsc` rejects outright. It compiled for months only because
  // `apps/demo` was missing from the root tsconfig's references and therefore never typechecked at all.
  const live = new Set(built.elements.map((e) => e.guid).filter((g): g is Guid => g !== null));
  const exists = (g: Guid): boolean => live.has(g);

  el("#topics").innerHTML = topics
    .map((t) => {
      if (t.pin === undefined) return `<li>${t.title}</li>`;
      const outcome = resolveAnchor(t.pin, exists as never);
      const badge =
        outcome.kind === "resolved"
          ? `<span class="ok">live</span>`
          : outcome.kind === "partial"
            ? `<span class="warn">partial (${outcome.missing.length} gone)</span>`
            : `<span class="warn" title="${outcome.reason}">orphaned</span>`;
      const tool = DEFAULT_TOOLSET.tools.find((x) => x.topicDefaults?.type === t.type);
      return (
        `<li data-topic="${t.guid}" data-live="${isLive(outcome)}">` +
        `<code>${tool?.glyph ?? "•"}</code> ${t.title} — ${badge}</li>`
      );
    })
    .join("");

  const dl = el("#markup-info");
  dl.innerHTML = "";
  row(dl, "Topics", i18n.plural("count.topics", topics.length));
  const orphaned = topics.filter(
    (t) => t.pin !== undefined && !isLive(resolveAnchor(t.pin, exists as never)),
  ).length;
  row(dl, "Orphaned", String(orphaned), orphaned === 0 ? "" : "warn");
  row(dl, "Anchored to", String(anchoredGuids(topics).length));
  el<HTMLButtonElement>("#bcf").disabled = topics.length === 0;
}

/** Raise a markup against whatever is selected, using the armed tool's defaults. */
function raiseMarkup(): void {
  if (selectedGuid === null) {
    renderKernelPanel("select an element first — a markup with no anchor is a sticker", "warn");
    return;
  }
  const tool = DEFAULT_TOOLSET.tools.find((t) => t.id === armedTool)!;
  const element = built.elements.find((e) => e.guid === selectedGuid);
  const label = element === undefined ? "element" : pascalIfc(element.ifcType);

  topics = [
    ...topics,
    createTopic({
      // A tool with its own template supplies the whole prefix; without one the label is the prefix. Using both
      // produced "RFI: RFI on IfcWall", which is the kind of wording that makes a tool look unfinished.
      title:
        tool.topicDefaults?.titleTemplate === undefined
          ? `${tool.label} on ${label}`
          : `${tool.topicDefaults.titleTemplate}${label}`,
      author: "demo@massingviewer",
      // Passed in rather than read inside the model, so an export is reproducible.
      date: new Date().toISOString(),
      ...tool.topicDefaults,
      pin: { guids: [selectedGuid as never], at: { x: 0, y: 0 }, drawing: drawing?.name ?? "3D" },
    }),
  ];
  renderTopics();
}

el("#tools").addEventListener("click", (event) => {
  const id = (event.target as Element | null)?.closest("[data-tool]")?.getAttribute("data-tool");
  if (id === null || id === undefined) return;
  armedTool = id;
  renderTools();
});

/**
 * Download the current plan as a PDF — the third serialiser, and the one to reach for.
 *
 * The difference from the DXF button next to it is not fidelity, it is **identity**. A DXF R12 has nowhere to
 * put a GlobalId, so a markup made on one cannot come back. This PDF carries every element's GlobalId twice —
 * in marked content inside the page, and in an attached JSON index mapping GlobalId to paper coordinates — so a
 * reviewer can mark it up in Bluebeam or Acrobat, tools that know nothing about IFC, and the result still
 * resolves to the wall it was about. That is the loop the competitive research found nobody had closed.
 */
el("#pdf").addEventListener("click", () => {
  if (drawing === null) return;
  const paper = fitToPaper(drawing, PAPER_SIZES.find((p) => p.name === "A3")!, 10);
  if (paper === null) {
    renderKernelPanel("this plan does not fit on A3 at any standard scale", "warn");
    return;
  }
  const bytes = toPdf(drawing, planTheme, paper, {
    border: true,
    scaleBar: true,
    // Unconditional, unlike the pane: a downloaded PDF has no "preview" reading. It is an issued sheet or it is a
    // file nobody can file.
    titleBlock: sheetFields(drawing.name),
    title: `${drawing.name} — 1:${paper.scale}`,
  });
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `plan-1-${paper.scale}.pdf`;
  a.click();
  URL.revokeObjectURL(url);
  const guids = new Set(drawing.entities.map((e) => e.guid).filter((g) => g !== undefined)).size;
  renderKernelPanel(
    `PDF at 1:${paper.scale} — ${guids} GlobalId(s) carried, ${pdfLimitations().length} stated limitations`,
    "ok",
  );
});

/**
 * Download the current plan as DXF, at the same scale and with the same theme the SVG shows.
 *
 * The claim this makes checkable: SVG and DXF are two serialisers of one `Drawing`, so what a consultant opens
 * measures the same as what the reviewer approved. massing has `plan_svg` and `plan_dxf` as separate generation
 * paths, which is why they disagree.
 */
el("#dxf").addEventListener("click", () => {
  if (drawing === null) return;
  const paper = fitToPaper(drawing, PAPER_SIZES.find((p) => p.name === "A3")!, 10);
  if (paper === null) {
    renderKernelPanel("this plan does not fit on A3 at any standard scale", "warn");
    return;
  }
  const text = toDxf(drawing, planTheme, paper, {
    border: true,
    scaleBar: true,
    titleBlock: sheetFields(drawing.name),
  });
  const url = URL.createObjectURL(new Blob([text], { type: "application/dxf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `plan-1-${paper.scale}.dxf`;
  a.click();
  URL.revokeObjectURL(url);
  // The losses are surfaced at the moment of export, not left for whoever opens the file to notice. GlobalIds in
  // particular do not survive a DXF, so a markup placed on one cannot come back.
  renderKernelPanel(`DXF at 1:${paper.scale} — ${dxfLimitations().length} stated limitations`, "ok");
});

el("#bcf").addEventListener("click", () => {
  const bytes = toBcfZip(topics, { project: { guid: "0000-demo", name: "MassingViewer demo" } });
  // A Blob and an object URL: no server, no upload. The export happens entirely in the page, which is the same
  // claim as the rest of the tool.
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "issues.bcfzip";
  a.click();
  URL.revokeObjectURL(url);
  renderKernelPanel(`exported ${topics.length} topic(s) as BCF 3.0`, "ok");
});

window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey) return;
  // `m` raises a markup on the selection; Delete removes the element, so the two halves of the anchoring story
  // are both one keystroke away.
  if (e.key === "m" || e.key === "M") raiseMarkup();
  if (e.key === "Delete") void deleteSelected();
});

renderTools();
renderTopics();

// --- the ribbon ------------------------------------------------------------------------------------
//
// Mounted from `@massing/ribbon`, which is vanilla DOM precisely so that massing can mount the same code.
// See docs/adr/0009-ribbon-renders-in-vanilla-dom.md — a vanilla renderer works in both hosts, a React one works
// in one, and the layout decisions live in `ui-model` so the two hosts cannot disagree about where a tool is.
//
// The handlers below wire the inherited verbs to what actually exists today. A verb with no implementation yet
// announces that plainly rather than doing nothing: a button that appears to work and does not is worse than one
// that says it is not built.

/**
 * Point the user at the gizmo handle that does what they just asked for.
 *
 * `announce` rather than `#status`, because the ribbon's live region is what a screen-reader user hears — and a
 * hint that only appears in a footer is a hint half the audience never receives.
 */
function explainGizmo(which: "move" | "rotate" | "push/pull"): void {
  if (draft === null) {
    ribbon.announce("The transform handles need the kernel to finish starting");
    return;
  }
  if (selectedGuid === null) {
    ribbon.announce("Select an element first — the handles appear on it");
    return;
  }
  const where =
    which === "move"
      ? "drag the blue plate at the base"
      : which === "rotate"
        ? "drag the amber ring"
        : "drag the green cone above the top corner";
  ribbon.announce(`${which}: ${where}`);
  el("#status").textContent = `${which} — ${where}`;
}

const RIBBON_ACTIONS: Record<string, () => void> = {
  "measure-distance-m": () => ribbon.announce("Measure is not wired up in this demo yet"),
  "show-all-h": () => applySelection(null),
  "isolate-selection": () => ribbon.announce("Isolate is not wired up in this demo yet"),
  "plan-beside-model": () => generate(),
  "delete-selected-element": () => void deleteSelected(),
  "add-door-to-selected-wall": () => ribbon.announce("Add door needs the wall tool first"),
  /**
   * Levels toggles the construction grid.
   *
   * The nearest honest mapping in the inherited table: the tool is "Toggle storey levels overlay" and the grid is
   * drawn at the active level's elevation. It is not the full storey-plane overlay the title implies, and saying
   * so in the announcement is better than a button that half-does what it says without mentioning it.
   */
  /**
   * The four transform verbs all point at the same gizmo, and say so.
   *
   * They are not separate modes: the handles for move, rotate and push/pull are on screen together the moment
   * something is selected, which is how a direct-manipulation gizmo works. So the honest thing for these buttons
   * to do is *tell the user where the handles are* rather than arm a mode that does not exist. Announcing beats
   * both silence and a fake mode — the button reads "drag the gizmo", and now there is one to drag.
   */
  "edit-in-place-drag-the-gizmo-to-move-the-selected-element": () => explainGizmo("move"),
  "move-selected-element-e-n-z-metres": () => explainGizmo("move"),
  "rotate-selected-element-degrees-about-z": () => explainGizmo("rotate"),
  "push-pull-drag-the-top-handle-to-make-the-selected-element-taller-or-thicker": () => explainGizmo("push/pull"),

  "toggle-storey-levels-overlay": () => {
    if (draft === null) {
      ribbon.announce("The grid needs the kernel to finish starting");
      return;
    }
    const on = !draft.grid.isVisible;
    draft.grid.visible(on);
    ribbon.announce(on ? "Construction grid on, 1 m" : "Construction grid off");
  },
};

/**
 * An example plugin, declared and loaded like any third-party one.
 *
 * It exists to make the extension story checkable rather than described. Everything a real plugin has: a
 * namespaced command, a ribbon group joining an *existing* tab, a keybinding, and — the part that matters —
 * `onCommand:` activation, so its code is not fetched until the button is pressed.
 *
 * Deliberately in the demo rather than in a package. A plugin that ships inside the host it extends is not a
 * plugin; it is a feature with extra ceremony. This one is loaded through the same `load` callback a real one
 * would be, so it proves the seam instead of decorating it.
 */
const EXAMPLE_PLUGIN: PluginManifest = {
  id: "example.metrics",
  name: "Quick metrics",
  version: "1.0.0",
  description: "Reports the model's footprint. A plugin small enough to read and real enough to prove the seam.",
  publisher: "MassingCloud",
  activation: ["onCommand:example.metrics.footprint"],
  contributes: {
    commands: [{ id: "example.metrics.footprint", title: "Footprint", capability: "view" }],
    // Joins Analyse, a tab that already exists. Plugins join tabs; they do not invent them.
    ribbon: [
      {
        id: "example-metrics",
        label: "Metrics",
        tab: "analyse",
        priority: 4,
        items: [{ command: "example.metrics.footprint", size: "large" }],
      },
    ],
    keybindings: [{ command: "example.metrics.footprint", key: "Shift+M" }],
  },
};

/**
 * The host, with the built-in tools and the example plugin loaded side by side.
 *
 * `builtinManifests()` derives the first-party ribbon from `ui-model`'s own tables, so what renders below is the
 * contribution model exercised on the real UI rather than on a toy. The unit tests assert it reproduces
 * `buildRibbon()` exactly; this is the same claim, in a browser.
 */
const host = createPluginHost({
  // The loader is where a real deployment would `import()` a chunk. Here it resolves the one example plugin, and
  // refuses everything else — a loader that silently returns an empty runtime would make a missing plugin look
  // like a working one.
  load: async (id) => {
    if (id !== EXAMPLE_PLUGIN.id) throw new Error(`no module for ${id}`);
    return {
      activate: (ctx) => {
        ctx.registerCommand("example.metrics.footprint", () => {
          const b = built.bounds;
          const area = (b.max.x - b.min.x) * (b.max.y - b.min.y);
          el("#status").textContent = `footprint ${formatLength(b.max.x - b.min.x, units)} x ${formatLength(b.max.y - b.min.y, units)} = ${area.toFixed(1)} m2`;
        });
      },
    };
  },
  onFailure: (id, phase, error) => {
    // Surfaced, not swallowed. A quarantined plugin the user cannot see is a plugin they will report as "the
    // button does nothing" — which is exactly what rollback prevents and what this makes legible.
    el("#status").textContent = `plugin ${id} failed to ${phase}: ${error instanceof Error ? error.message : String(error)}`;
  },
});

const loaded = host.load([...builtinManifests(), EXAMPLE_PLUGIN]);
if (loaded.rejected.length > 0) {
  el("#status").textContent = `rejected ${loaded.rejected.map((r) => r.id).join(", ")}`;
}

const ribbon = createRibbon(el("#ribbon"), {
  context: { selection: false, canEdit: true },
  // The groups come from the host, so a contributed group and a built-in one go through one collapse algorithm.
  // Two paths would diverge, and the divergence would show up as plugin buttons behaving differently at a narrow
  // window — reported by an author, months later.
  groups: ribbonFrom(host.contributions()),
  handlers: {
    onTool: (id, item) => {
      /**
       * A draft verb, first.
       *
       * Before `RIBBON_ACTIONS` rather than after, because arming a tool is a *mode change* and must not be
       * shadowed by a one-shot action that happens to share an id. `armByToolId` returns false for anything that
       * is not a draft verb, so this is a filter and not a claim on every button.
       */
      if (draft?.armByToolId(id) === true) {
        ribbon.announce(`${item.label} armed — click to place points, Escape to cancel`);
        return;
      }

      // A built-in tool with a demo implementation.
      const action = RIBBON_ACTIONS[id];
      if (action !== undefined) {
        action();
        return;
      }

      // Otherwise it is a contributed command. `runCommand` activates the owning plugin on demand, which is the
      // whole point of `onCommand:` — the button existed from startup, the code arrives now.
      const command = COMMAND_FOR_ITEM.get(id);
      if (command !== undefined) {
        void host.runCommand(command).catch((error: unknown) => {
          el("#status").textContent = `${item.label}: ${error instanceof Error ? error.message : String(error)}`;
        });
        return;
      }

      // Honest rather than silent. Thirty verbs came across from massing's toolbar and only a handful have an
      // implementation here; pretending otherwise is how a demo teaches the wrong thing about the product.
      ribbon.announce(`${item.label} is in the ribbon but not implemented in this demo`);
      el("#status").textContent = `${item.label}: not implemented in this demo`;
    },
  },
});

/**
 * Ribbon item id → command id.
 *
 * Needed because `RibbonItem.id` is derived from the *title* — the same derivation built-ins use, so a plugin
 * command and a built-in tool have ids of one shape and anything keyed on item id treats them alike. The price is
 * this one lookup, built from the contributions rather than guessed at.
 */
const COMMAND_FOR_ITEM = new Map<string, string>(
  (host.contributions().commands ?? [])
    .filter((c) => !c.id.startsWith(`${BUILTIN_ID}.`))
    .map((c) => [ribbonItemIdFor(c.title), c.id]),
);

function ribbonItemIdFor(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// The keybinding layer, straight from the manifests: remapping is data, not a switch statement.
window.addEventListener("keydown", (event) => {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");
  if (event.metaKey) parts.push("Meta");
  parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
  const command = host.keymap().get(parts.join("+"));
  if (command === undefined) return;
  event.preventDefault();
  void host.runCommand(command).catch(() => {
    /* reported through onFailure */
  });
});

void commandIdFor;

// --- status ---------------------------------------------------------------------------------------

/**
 * The perf readout, and why it stopped writing to `#status`.
 *
 * It used to set both `#fps` and `#status`, so every message the app produced was overwritten within 500 ms by
 * "7 draw calls · 7 geometries". Chromium's timing happened to hide it; **webkit surfaced it** — the plugin
 * keybinding test pressed Shift+M, the footprint appeared, and the interval clobbered it before the assertion ran.
 *
 * Two writers with no coordination, which is the exact failure the selection code in this file already carries a
 * comment about: *"the shape of the code allowed two places to hold an opinion"*. The fix is the same one — give
 * each its own element — rather than teaching the interval to skip a recent message, which would be a second
 * opinion about whose turn it is.
 */
setInterval(() => {
  const s = viewport.stats();
  el("#fps").textContent = `${s.fps} fps · ${s.drawCalls} draws · ${s.geometries} geoms`;
}, 500);

el("#status").textContent = "ready";

// --- debug hook -----------------------------------------------------------------------------------
//
// Exposed deliberately, and it is not only for debugging: E2E needs a way to drive one frame and read the
// framebuffer, because `requestAnimationFrame` is suspended in a backgrounded or hidden page and Playwright
// runs headless. Without a handle, a test cannot distinguish "rendered correctly" from "never rendered" —
// which is the exact ambiguity that had massing's zero-width canvas misfiled as a stalled loader.
//
// `renderNow` renders and reads in the same synchronous turn on purpose: `preserveDrawingBuffer` is off, so
// a deferred read returns an empty buffer.
declare global {
  interface Window {
    __massingviewer?: {
      viewport: typeof viewport;
      readonly elements: typeof built.elements;
      readonly triangles: number;
      readonly authored: number;
      kernelId: string;
      /**
       * How many tools the inherited table holds.
       *
       * Exposed so an E2E test can assert "every tool in the table reaches the DOM" without hardcoding a total.
       * It used to read `30 + 1`, and adding the three M6 draw verbs broke two tests that then reported the
       * ribbon had *lost* a tool. A literal tests the number someone typed last time; this tests the property.
       */
      readonly toolCount: number;
      /**
       * The draft controller, for tests that need to drive the authoring session directly.
       *
       * Exposed because the interesting bugs in this area are in the *host* wiring, and separating host from
       * session is impossible from outside without a handle on both.
       */
      readonly draft: DraftController | null;
      /**
       * Leak probe: re-show the current model `cycles` times and report GPU resource counts.
       *
       * Exists for the same reason `sampleFramebuffer` and `renderSignature` do — the thing being measured is
       * invisible from outside. `docs/testing.md` calls the memory-leak gate the highest-value and most-neglected
       * check for a long-lived three.js app, and it cannot be written without a way to drive mount/unmount and read
       * `renderer.info.memory` from a test.
       */
      remount(cycles: number): {
        geometries: number;
        textures: number;
        programs: number;
        cacheSize: number;
        sceneChildren: number;
      };
      /**
       * The markup topics, and the camera distance.
       *
       * Both were exposed on the object and **missing from this declaration**, which never failed because
       * `apps/demo` was absent from the root tsconfig's references and so was never typechecked. The E2E tests
       * reach them through `page.evaluate`, where the callback is compiled against the browser's `Window` and the
       * mismatch is invisible. A declaration that does not match what it declares is worse than none: it is a lie
       * that autocompletes.
       */
      readonly topics: typeof topics;
      readonly cameraDistance: number;
      renderNow(): void;
      /** Coverage over a fixed `grid x grid` of samples — resolution-independent by design. */
      sampleFramebuffer(grid?: number): { sampled: number; nonBackground: number; coverage: number };
      /**
       * The two signals the visual-regression job gates on: a silhouette occupancy grid and a luminance histogram.
       *
       * Not pixels, and not SSIM. `docs/testing.md` is explicit that gating per-PR on pixels is how a visual suite
       * gets abandoned — one antialiasing difference and the reflex becomes accepting every new baseline. These two
       * are coarse enough to be stable across driver versions and specific enough to catch a model that failed to
       * load, a camera that moved, or a material that lost its shading.
       */
      renderSignature(grid?: number): {
        renderer: string;
        cells: number[];
        luminance: number[];
      };
    };
  }
}

window.__massingviewer = {
  viewport,
  // Getters, not values: authoring replaces the model, and a snapshot captured at startup would make an E2E
  // test assert the state before the edit while appearing to assert the state after it.
  get elements() {
    return built.elements;
  },
  get triangles() {
    return built.triangles;
  },
  get authored() {
    return authored;
  },
  /**
   * Distance from the camera to the model centre, in metres.
   *
   * Exposed because it is what "zoom" actually means, and the obvious proxy is wrong: an E2E test asserted that
   * pinching out *reduces* framebuffer coverage, and it does not — zooming out reveals more of the ground grid,
   * which counts as non-background, so coverage went from 0.17 to 0.21 while the camera correctly moved away.
   * Coverage is a fine signal for "did anything draw"; it is not a signal for direction of zoom.
   */
  get topics() {
    return topics;
  },
  get cameraDistance() {
    const b = built.bounds;
    const cx = (b.min.x + b.max.x) / 2;
    const cy = (b.min.y + b.max.y) / 2;
    const cz = (b.min.z + b.max.z) / 2;
    const p = viewport.camera.position;
    return Math.hypot(p.x - cx, p.y - cy, p.z - cz);
  },
  kernelId: kernel.id,
  get toolCount() {
    return TOOLS.length;
  },
  get draft() {
    return draft;
  },
  renderNow() {
    viewport.renderer.render(viewport.scene, viewport.camera);
  },

  /**
   * Re-show the same model `cycles` times, then report what the GPU is still holding.
   *
   * This is the leak that actually threatens this app. Every authoring round trip calls `showModel` again, and
   * `showModel` is the one place that must dispose the scene it replaces — three does **not** free GPU buffers
   * when an object leaves the scene graph, so a missing `disposeScene` grows `renderer.info.memory.geometries`
   * on every edit until the tab dies. There is no error and nothing on screen: it is slow, then it is gone.
   *
   * Driving `showModel` directly rather than authoring fifty walls: it is the same call the round trip makes, and
   * fifty round trips would take a minute of wall clock to test one line of disposal.
   */
  remount(cycles: number) {
    for (let i = 0; i < cycles; i++) {
      built = viewport.showModel(sourceMeshes, (id) => toGuid(sourceGuids.get(id)), MODEL);
    }
    // Rendered once, so any buffer a re-show created is actually uploaded and therefore counted. Without a frame
    // the numbers describe what has been *asked for*, not what is held.
    viewport.renderer.render(viewport.scene, viewport.camera);
    const info = viewport.renderer.info;
    return {
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      // `THREE.Cache` is a module-level map that `TextureLoader` and friends populate and nothing clears. It is
      // empty here because this app loads no external assets, and asserting that keeps it true.
      cacheSize: Object.keys((THREE_CACHE as { files?: object }).files ?? {}).length,
      sceneChildren: viewport.scene.children.length,
    };
  },
  /**
   * Coverage over a fixed `grid × grid` of samples, **independent of resolution**.
   *
   * `grid` used to be a pixel *step*, which made the sample count a function of the framebuffer size — so when
   * the pixel governor legitimately halved the resolution, the count halved with it and an assertion of
   * `sampled > 100` failed at 80 with nothing wrong. That is the second time an assertion here fought the
   * governor, and the fix belongs in the instrument rather than in each assertion: a coverage metric that
   * changes when the resolution changes is measuring the wrong thing.
   *
   * Sampling proportionally makes both `sampled` and `coverage` comparable between runs, machines and pixel
   * ratios — which is the whole point of having the number.
   */
  sampleFramebuffer(grid = 24) {
    const canvas = viewport.renderer.domElement;
    const gl = viewport.renderer.getContext();
    viewport.renderer.render(viewport.scene, viewport.camera);
    const px = new Uint8Array(4);
    let sampled = 0;
    let nonBackground = 0;
    // Inset from the edges: the outer band is empty on any fitted camera, and including it would dilute coverage
    // by a factor that depends on the aspect ratio rather than on what was drawn.
    const x0 = canvas.width * 0.15;
    const y0 = canvas.height * 0.2;
    const spanX = canvas.width * 0.75;
    const spanY = canvas.height * 0.65;
    for (let iy = 0; iy < grid; iy++) {
      for (let ix = 0; ix < grid; ix++) {
        const x = Math.min(canvas.width - 1, Math.floor(x0 + (spanX * ix) / grid));
        const y = Math.min(canvas.height - 1, Math.floor(y0 + (spanY * iy) / grid));
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        sampled++;
        // Clear colour is 0x1a1d21 = (26,29,33). Anything meaningfully different is geometry or the grid.
        const bg = Math.abs(px[0]! - 26) < 12 && Math.abs(px[1]! - 29) < 12 && Math.abs(px[2]! - 33) < 12;
        if (!bg) nonBackground++;
      }
    }
    return { sampled, nonBackground, coverage: nonBackground / Math.max(1, sampled) };
  },

  /**
   * A silhouette occupancy grid and a luminance histogram, read from a freshly rendered frame.
   *
   * `render()` is called first and the pixels are read immediately, for the reason massing's hero-capture
   * documents: `preserveDrawingBuffer` is off, so the buffer is invalid once the frame is composited and a
   * later read returns black. A visual baseline of an all-black frame is worse than no baseline — it passes.
   *
   * **Occupancy per cell, quantised to eighths.** A cell records how much of it is covered, not what colour it
   * is. That survives an antialiasing or driver difference (which moves a handful of pixels inside a cell) and
   * fails on a model that did not load, a camera that moved, or geometry that vanished. Quantising is what makes
   * it a *stable* number rather than a float that differs in the last place on every machine.
   *
   * **Luminance in 8 buckets**, over the same samples. This is the half that notices shading: a material that
   * lost its light response keeps its silhouette exactly and collapses its histogram into one bucket.
   */
  renderSignature(grid = 16) {
    const canvas = viewport.renderer.domElement;
    const gl = viewport.renderer.getContext();
    viewport.renderer.render(viewport.scene, viewport.camera);

    const cells: number[] = [];
    const luminance = [0, 0, 0, 0, 0, 0, 0, 0];
    // 4 samples per cell per axis, so a cell has 16 samples and occupancy has 17 possible values before
    // quantisation. Reading every pixel would be more precise and far more fragile.
    const per = 4;
    const w = canvas.width;
    const h = canvas.height;
    const px = new Uint8Array(4);

    for (let cy = 0; cy < grid; cy++) {
      for (let cx = 0; cx < grid; cx++) {
        let hit = 0;
        for (let sy = 0; sy < per; sy++) {
          for (let sx = 0; sx < per; sx++) {
            const x = Math.min(w - 1, Math.floor(((cx + (sx + 0.5) / per) / grid) * w));
            const y = Math.min(h - 1, Math.floor(((cy + (sy + 0.5) / per) / grid) * h));
            gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
            const r = px[0]!;
            const g = px[1]!;
            const b = px[2]!;
            // Clear colour 0x1a1d21 = (26,29,33), matching sampleFramebuffer's threshold.
            const bg = Math.abs(r - 26) < 12 && Math.abs(g - 29) < 12 && Math.abs(b - 33) < 12;
            if (!bg) {
              hit++;
              // Rec. 601 luma. Integer weights so the bucket cannot differ by a float rounding step.
              const luma = (299 * r + 587 * g + 114 * b) / 1000;
              luminance[Math.min(7, Math.floor((luma / 256) * 8))]!++;
            }
          }
        }
        // Eighths: 0 for empty, 8 for full. Coarse on purpose.
        cells.push(Math.round((hit / (per * per)) * 8));
      }
    }

    // The renderer string, because a baseline is only comparable within one rasteriser. A mismatched key must be a
    // loud failure rather than a quiet comparison of two different renderers — see docs/testing.md.
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = debug
      ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));

    return { renderer, cells, luminance };
  },
};
