import { asModelId, formatLength, IMPERIAL, METRIC, toGuid, type Guid, type UnitSystem } from "@massing/core";
import { createViewport } from "@massing/viewport";
import { browserWorkerTransport, createLocalKernel } from "@massing/kernel-local";
import {
  ARCHITECTURAL,
  FIRE_SAFETY,
  PAPER_SIZES,
  type Drawing,
  type ElementMesh,
  fitToPaper,
  generatePlan,
  dxfLimitations,
  pdfLimitations,
  toDxf,
  toPdf,
  toSvg,
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
import { createRibbon } from "@massing/ribbon";
import "@massing/ribbon/ribbon.css";
import { tessellate } from "./tessellate";

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

el("#viewport").insertAdjacentHTML(
  "beforeend",
  '<div id="drop-hint" hidden><span>Drop an IFC to open it</span></div>',
);

const viewport = createViewport({ container: el("#viewport") });

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
  row(dl, "Elements", String(built.elements.length));
  row(dl, "Triangles", built.triangles.toLocaleString());
  row(dl, "Parse", `${parseMs.toFixed(1)} ms`);
  row(dl, "Extent", `${formatLength(dims.x, units)} × ${formatLength(dims.z, units)}`);
  row(dl, "Height", formatLength(dims.y, units));
  // Identity coverage, shown rather than assumed. If this is not 100% something in the resolver is wrong and
  // every markup anchored to this model would be anchored to nothing.
  const withGuid = built.elements.filter((e) => e.guid !== null).length;
  const pct = Math.round((100 * withGuid) / Math.max(1, built.elements.length));
  row(dl, "GlobalIds", `${withGuid}/${built.elements.length} (${pct}%)`, pct === 100 ? "ok" : "warn");
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
 * The ONE way selection changes — the viewport highlight and the panel are written together.
 *
 * They were separate: the click handler set both, but the Escape handler called `viewport.select([])` and
 * nothing else, so the highlight cleared while the panel went on displaying the element that was no longer
 * selected. An E2E test caught it. The bug is not that a call was forgotten; it is that the shape of the code
 * allowed two places to hold an opinion about what is selected. Routing both through here means they cannot
 * disagree, and a future third caller (the palette, a plugin, a plan-pane click) gets it right by default.
 */
let selectedGuid: string | null = null;

function applySelection(hit: { expressId: number; guid: string | null } | null): void {
  viewport.select(hit ? [hit.expressId] : []);
  selectedGuid = hit?.guid ?? null;
  // 3D → plan, and 3D → ribbon. Kept in this one function for the same reason the panel is: two places holding
  // an opinion about what is selected is how they end up disagreeing.
  highlightPlan();
  ribbon?.update({ selection: hit !== null, canEdit: true });

  const dl = el("#sel");
  dl.innerHTML = "";
  if (!hit) {
    placeholder(dl, "Click an element");
    return;
  }
  const element = elementAt(hit.expressId);
  row(dl, "Class", element === undefined ? "?" : pascalIfc(element.ifcType));
  row(dl, "expressID", `#${hit.expressId}`);
  // Both ids, deliberately: expressID is what the parse layer and the drawing generator speak, GlobalId is
  // the only one safe to persist. Showing both is how the distinction stays visible.
  row(dl, "GlobalId", hit.guid ?? "— unresolved", hit.guid ? "mono" : "warn");
}

viewport.renderer.domElement.addEventListener("click", (event) => {
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

    const exported = await kernel.exportIfc(MODEL);
    if (!exported.ok) {
      renderKernelPanel(exported.error.message, "warn");
      return;
    }
    authored += 1;

    const ifc = new TextDecoder().decode(exported.value);
    const next = tessellate(ifc);
    const rebuilt = viewport.showModel(next.meshes, (id) => toGuid(next.guids.get(id)), MODEL);
    built = rebuilt;
    sourceMeshes = next.meshes;
    sourceGuids = next.guids;
    // A plan is a *view*: if one is open it must follow the edit, not go stale until someone presses the button.
    if (drawing !== null) generate();
    // An edit is exactly when an anchor can break, so the markup list is re-resolved rather than left stale.
    renderTopics();
    renderModelPanel();
    renderSkipped(next.skipped);
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

/** The tessellated model as drawing input, carrying the identity each line must keep. */
function planInput(): { name: string; meshes: ElementMesh[] } {
  return {
    name: "L1 Plan",
    meshes: sourceMeshes.map((m) => ({
      guid: toGuid(sourceGuids.get(m.expressId)),
      ifcClass: pascalIfc(m.ifcType ?? "IFCPRODUCT"),
      positions: m.positions,
      indices: m.indices,
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
  el("#plan-svg").innerHTML = toSvg(drawing, planTheme, paper, { interactive: true, border: true });
  highlightPlan();
}

function generate(): void {
  drawing = generatePlan(planInput(), { kind: "plan", cutHeight: 1.2 });
  el("#plan-pane").hidden = false;
  el<HTMLButtonElement>("#theme").disabled = false;
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
  row(dl, "Topics", String(topics.length));
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
  const bytes = toPdf(drawing, planTheme, paper, { border: true, title: `${drawing.name} — 1:${paper.scale}` });
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
  const text = toDxf(drawing, planTheme, paper);
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

const RIBBON_ACTIONS: Record<string, () => void> = {
  "measure-distance-m": () => ribbon.announce("Measure is not wired up in this demo yet"),
  "show-all-h": () => applySelection(null),
  "isolate-selection": () => ribbon.announce("Isolate is not wired up in this demo yet"),
  "plan-beside-model": () => generate(),
  "delete-selected-element": () => void deleteSelected(),
  "add-door-to-selected-wall": () => ribbon.announce("Add door needs the wall tool first"),
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
  renderNow() {
    viewport.renderer.render(viewport.scene, viewport.camera);
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
};
