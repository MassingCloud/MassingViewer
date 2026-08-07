import { asModelId, formatLength, IMPERIAL, METRIC, toGuid, type Guid, type UnitSystem } from "@massingviewer/core";
import { createViewport } from "@massingviewer/viewport";
import { browserWorkerTransport, createLocalKernel } from "@massingviewer/kernel-local";
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
      <button id="units" title="Toggle metric / imperial">m</button>
      <span class="muted" id="fps"></span>
    </header>
    <main>
      <div id="viewport"></div>
      <aside>
        <h2>Model</h2>
        <dl id="model"></dl>
        <h2>Kernel</h2>
        <dl id="kernel"><dd class="muted">starting worker…</dd></dl>
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

const el = <T extends HTMLElement>(sel: string): T => {
  const node = app.querySelector<T>(sel);
  if (!node) throw new Error(`missing ${sel}`);
  return node;
};

const t0 = performance.now();
const { meshes, guids, skipped } = tessellate(sampleIfc);
const parseMs = performance.now() - t0;

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
function applySelection(hit: { expressId: number; guid: string | null } | null): void {
  viewport.select(hit ? [hit.expressId] : []);

  const dl = el("#sel");
  dl.innerHTML = "";
  if (!hit) {
    dl.innerHTML = `<dd class="muted">Click an element</dd>`;
    return;
  }
  const element = elementAt(hit.expressId);
  row(dl, "Class", element?.ifcType.replace(/^IFC/, "Ifc") ?? "?");
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
    renderModelPanel();
    renderSkipped(next.skipped);
    renderKernelPanel(`authored ${applied.value.created.length} element · v${applied.value.modelVersion}`, "ok");
  } finally {
    button.disabled = false;
  }
}

el("#author").addEventListener("click", () => void authorWall());
void startKernel();

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
      sampleFramebuffer(step?: number): { sampled: number; nonBackground: number; coverage: number };
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
  kernelId: kernel.id,
  renderNow() {
    viewport.renderer.render(viewport.scene, viewport.camera);
  },
  sampleFramebuffer(step = 24) {
    const canvas = viewport.renderer.domElement;
    const gl = viewport.renderer.getContext();
    viewport.renderer.render(viewport.scene, viewport.camera);
    const px = new Uint8Array(4);
    let sampled = 0;
    let nonBackground = 0;
    for (let y = Math.floor(canvas.height * 0.2); y < canvas.height * 0.85; y += step) {
      for (let x = Math.floor(canvas.width * 0.15); x < canvas.width * 0.9; x += step) {
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
