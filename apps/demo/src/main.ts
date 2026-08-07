import { asModelId, formatLength, IMPERIAL, METRIC, toGuid, type Guid, type UnitSystem } from "@massingviewer/core";
import { createViewport } from "@massingviewer/viewport";
import { browserWorkerTransport, createLocalKernel } from "@massingviewer/kernel-local";
import {
  ARCHITECTURAL,
  FIRE_SAFETY,
  PAPER_SIZES,
  type Drawing,
  type ElementMesh,
  fitToPaper,
  generatePlan,
  dxfLimitations,
  toDxf,
  toSvg,
} from "@massingviewer/drawings2d";
import {
  DEFAULT_TOOLSET,
  type Topic,
  anchoredGuids,
  createTopic,
  isLive,
  resolveAnchor,
  toBcfZip,
} from "@massingviewer/markup";
import { tessellate } from "./tessellate";

// The fixture is inlined at build time, not fetched. That is the point of the walking skeleton: after first
// paint the demo makes zero network requests, so it is provably working without a backend. massing's own Pages
// demo fetches a model that does not exist and therefore shows no geometry at all.
import sampleIfc from "../../../fixtures/sample.ifc?raw";

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("#app missing");

app.innerHTML = `
  <div class="shell">
    <header>
      <strong>MassingViewer</strong>
      <span class="muted" id="file">sample.ifc</span>
      <span class="spacer"></span>
      <button id="fit" title="Frame the model (F)">Fit</button>
      <button id="author" title="Author a wall offline, in a Worker, with no network">+ Wall</button>
      <button id="plan" title="Cut a plan from the model at 1.2 m">Plan</button>
      <button id="theme" title="Repaint the plan — no regeneration" disabled>Arch</button>
      <button id="delete" title="Delete the selected element (Del) — watch any markup on it orphan">Delete</button>
      <button id="dxf" title="Export the plan as DXF R12" disabled>DXF</button>
      <button id="bcf" title="Export every markup as BCF 3.0" disabled>BCF</button>
      <button id="units" title="Toggle metric / imperial">m</button>
      <span class="muted" id="fps"></span>
    </header>
    <main>
      <div id="viewport"></div>
      <div id="plan-pane" hidden><div id="plan-svg"></div></div>
      <aside>
        <h2>Model</h2>
        <dl id="model"></dl>
        <h2>Kernel</h2>
        <dl id="kernel"><dd class="muted">starting worker…</dd></dl>
        <h2>Plan</h2>
        <dl id="plan-info"><dd class="muted">Press Plan to cut one</dd></dl>
        <h2>Markup</h2>
        <dl id="markup-info"><dd class="muted">Pick a tool, then click an element</dd></dl>
        <div id="tools"></div>
        <ul id="topics"></ul>
        <h2>Selection</h2>
        <dl id="sel"><dd class="muted">Click an element</dd></dl>
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

const viewport = createViewport({ container: el("#viewport") });

const resolveGuid = (expressId: number): Guid | null => toGuid(guids.get(expressId));
// Reassigned when the kernel authors something and the model is re-tessellated from its IFC output.
let built = viewport.showModel(meshes, resolveGuid, asModelId("sample"));

let units: UnitSystem = METRIC;

// --- panels ---------------------------------------------------------------------------------------

function row(dl: HTMLElement, term: string, value: string, cls = "") {
  dl.insertAdjacentHTML("beforeend", `<dt>${term}</dt><dd class="${cls}">${value}</dd>`);
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
  // 3D → plan. Kept in this one function for the same reason the panel is: two places holding an opinion about
  // what is selected is how they end up disagreeing.
  highlightPlan();

  const dl = el("#sel");
  dl.innerHTML = "";
  if (!hit) {
    dl.innerHTML = `<dd class="muted">Click an element</dd>`;
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
  const live = new Set(built.elements.map((e) => e.guid).filter((g): g is string => g !== null));
  const exists = (g: string): boolean => live.has(g);

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

// --- status ---------------------------------------------------------------------------------------

setInterval(() => {
  const s = viewport.stats();
  el("#fps").textContent = `${s.fps} fps`;
  el("#status").textContent = `${s.drawCalls} draw calls · ${s.geometries} geometries`;
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
