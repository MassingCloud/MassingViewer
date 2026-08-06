import { asModelId, formatLength, IMPERIAL, METRIC, toGuid, type Guid, type UnitSystem } from "@massingviewer/core";
import { createViewport } from "@massingviewer/viewport";
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
      <button id="units" title="Toggle metric / imperial">m</button>
      <span class="muted" id="fps"></span>
    </header>
    <main>
      <div id="viewport"></div>
      <aside>
        <h2>Model</h2>
        <dl id="model"></dl>
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
const built = viewport.showModel(meshes, resolveGuid, asModelId("sample"));

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
if (skipped.length > 0) {
  el("#skipped-h").hidden = false;
  el("#skipped").innerHTML = skipped
    .map((s) => `<li><code>#${s.expressId}</code> ${s.type} — ${s.reason}</li>`)
    .join("");
}

// --- selection ------------------------------------------------------------------------------------

const byExpressId = new Map(built.elements.map((e) => [e.expressId, e]));

viewport.renderer.domElement.addEventListener("click", (event) => {
  const hit = viewport.pick(event);
  viewport.select(hit ? [hit.expressId] : []);

  const dl = el("#sel");
  dl.innerHTML = "";
  if (!hit) {
    dl.innerHTML = `<dd class="muted">Click an element</dd>`;
    return;
  }
  const element = byExpressId.get(hit.expressId);
  row(dl, "Class", element?.ifcType.replace(/^IFC/, "Ifc") ?? "?");
  row(dl, "expressID", `#${hit.expressId}`);
  // Both ids, deliberately: expressID is what the parse layer and the drawing generator speak, GlobalId is
  // the only one safe to persist. Showing both is how the distinction stays visible.
  row(dl, "GlobalId", hit.guid ?? "— unresolved", hit.guid ? "mono" : "warn");
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
  if (e.key === "Escape") viewport.select([]);
});

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
      elements: typeof built.elements;
      triangles: number;
      renderNow(): void;
      sampleFramebuffer(step?: number): { sampled: number; nonBackground: number; coverage: number };
    };
  }
}

window.__massingviewer = {
  viewport,
  elements: built.elements,
  triangles: built.triangles,
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
