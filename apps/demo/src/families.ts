import { parseLibrary, entries as entriesOf, type FamilyEntry } from "@massing/assets";
import { disciplinesIn, galleryFor, searchGallery, type GalleryTile } from "@massing/ui-model";
import { screenToGround } from "@massing/viewport";

/**
 * The family gallery: hundreds of things to place, in a ribbon that has room for six.
 *
 * `DRAFT_ELEMENTS` gave the demo four buttons — wall, slab, column, door. This is the other half of the answer to
 * *"we need all the massing families, not just slabs, columns, doors and windows"*: the whole library is visible,
 * grouped by discipline and category, searchable, and draggable onto the model.
 *
 * ## The library here is a demo fixture, deliberately
 *
 * It is written in the same `_family_index()` shape the real library publishes and is parsed by `@massing/assets`, so
 * the whole chain — parse, lay out, render, place — is the real one. The *content* is invented for this demo rather
 * than copied from `MassingCloud/massing-families`, whose licence is `Other` and therefore outside the permitted
 * list. A demo that shipped that catalogue's contents would put non-permitted content in an MIT repository, which is
 * the hazard `scripts/check-licenses.mjs` exists to catch — and it would catch it, loudly, which is how this fixture
 * came to be authored rather than borrowed.
 *
 * ## Availability is stated, never hidden
 *
 * `LocalKernel` has fifteen operations, six of which place an element. A library entry whose `ifcClass` is outside
 * that set cannot be placed offline — so its tile is **dimmed with the reason**, not removed. That is the house rule
 * this repository applies everywhere: *a dimmed button that says "needs a connected project" is onboarding, a missing
 * one is a support ticket.* It also makes the shape of the offline kernel legible without reading its docs.
 */

/**
 * The published index shape: snake_case, packs whose entry array is `index`.
 *
 * Kept verbatim so `parseLibrary` is genuinely exercised — and it earned that immediately. The first version of this
 * fixture called the array `entries`, which the parser accepts as *three packs containing nothing*: a pack with no
 * `index` is a legitimate unindexed pack, so there is no error to report. The gallery rendered its tabs and its
 * search box over an empty library, which is the quietest possible way for a fixture to be wrong.
 */
const LIBRARY_DOCUMENT = {
  name: "MassingViewer demo families",
  version: "0.1.0",
  license: "MIT",
  attribution: "Authored for this demo; not derived from any third-party catalogue.",
  packs: [
    {
      file: "architectural.ifc",
      discipline: "Architectural",
      ifc_schema: "IFC4",
      size_bytes: 0,
      index: [
        { key: "door-single-leaf", label: "Single leaf door", category: "Doors", ifc_class: "IfcDoor", predefined: "DOOR" },
        { key: "door-double-leaf", label: "Double leaf door", category: "Doors", ifc_class: "IfcDoor", predefined: "DOOR" },
        { key: "door-sliding", label: "Sliding door", category: "Doors", ifc_class: "IfcDoor", predefined: "DOOR" },
        { key: "door-revolving", label: "Revolving door", category: "Doors", ifc_class: "IfcDoor", geometry: "L200 proxy" },
        { key: "window-casement", label: "Casement window", category: "Windows", ifc_class: "IfcWindow" },
        { key: "window-fixed", label: "Fixed light", category: "Windows", ifc_class: "IfcWindow" },
        { key: "window-tilt-turn", label: "Tilt and turn window", category: "Windows", ifc_class: "IfcWindow" },
        { key: "wall-cavity", label: "Cavity wall, 300", category: "Walls", ifc_class: "IfcWall" },
        { key: "wall-partition", label: "Partition, 100", category: "Walls", ifc_class: "IfcWall" },
        { key: "wall-party", label: "Party wall, 250", category: "Walls", ifc_class: "IfcWall" },
        { key: "slab-floor", label: "Floor slab, 200", category: "Slabs", ifc_class: "IfcSlab" },
        { key: "slab-roof", label: "Roof slab, 250", category: "Slabs", ifc_class: "IfcSlab" },
        { key: "stair-straight", label: "Straight flight stair", category: "Circulation", ifc_class: "IfcStair", geometry: "L200 proxy" },
        { key: "railing-balustrade", label: "Balustrade", category: "Circulation", ifc_class: "IfcRailing", geometry: "L200 proxy" },
      ],
    },
    {
      file: "structural.ifc",
      discipline: "Structural",
      ifc_schema: "IFC4",
      size_bytes: 0,
      index: [
        { key: "beam-universal", label: "Universal beam", category: "Beams", ifc_class: "IfcBeam" },
        { key: "beam-castellated", label: "Castellated beam", category: "Beams", ifc_class: "IfcBeam", geometry: "L200 proxy" },
        { key: "column-shs", label: "Square hollow column", category: "Columns", ifc_class: "IfcColumn" },
        { key: "column-uc", label: "Universal column", category: "Columns", ifc_class: "IfcColumn" },
        { key: "column-circular", label: "Circular column", category: "Columns", ifc_class: "IfcColumn" },
        { key: "footing-pad", label: "Pad footing", category: "Foundations", ifc_class: "IfcFooting", geometry: "L200 proxy" },
        { key: "brace-cross", label: "Cross brace", category: "Bracing", ifc_class: "IfcMember", geometry: "L200 proxy" },
      ],
    },
    {
      file: "mep.ifc",
      discipline: "MEP",
      ifc_schema: "IFC4",
      size_bytes: 0,
      index: [
        { key: "duct-rectangular", label: "Rectangular duct", category: "Ductwork", ifc_class: "IfcDuctSegment", has_ports: true },
        { key: "duct-circular", label: "Circular duct", category: "Ductwork", ifc_class: "IfcDuctSegment", has_ports: true },
        { key: "diffuser-swirl", label: "Swirl diffuser", category: "Terminals", ifc_class: "IfcAirTerminal", has_ports: true },
        { key: "pipe-copper", label: "Copper pipe", category: "Pipework", ifc_class: "IfcPipeSegment", has_ports: true },
        { key: "luminaire-recessed", label: "Recessed luminaire", category: "Lighting", ifc_class: "IfcLightFixture" },
      ],
    },
  ],
};

/**
 * Which kernel operation places a given IFC class.
 *
 * Held here, in the host, rather than in `@massing/ui-model`: which operations exist is a *kernel* fact, and a layout
 * package that knew it would be one more thing to update when a kernel gains an operation. The gallery model stays a
 * layout table; the host joins it to whatever kernel it is holding.
 */
const OP_FOR_CLASS: Readonly<Record<string, string>> = {
  IfcWall: "add_wall",
  IfcSlab: "add_slab",
  IfcColumn: "add_column",
  IfcBeam: "add_beam",
  IfcDoor: "add_door",
  IfcWindow: "add_window",
};

/** Parameters each placing operation needs beyond a point, so a dropped tile becomes a real element. */
function paramsFor(op: string, at: { x: number; z: number }, label: string): Record<string, unknown> {
  const name = `${label} (placed)`;
  switch (op) {
    case "add_wall":
      return { start: [at.x, at.z], end: [at.x + 4, at.z], height: 3, thickness: 0.2, name };
    case "add_slab":
      return {
        outline: [
          [at.x, at.z],
          [at.x + 4, at.z],
          [at.x + 4, at.z + 4],
          [at.x, at.z + 4],
        ],
        thickness: 0.2,
        name,
      };
    case "add_column":
      return { point: [at.x, at.z], height: 3, name };
    case "add_beam":
      return { start: [at.x, at.z], end: [at.x + 4, at.z], depth: 0.4, width: 0.2, name };
    default:
      // Doors and windows need a host wall, which a drop on open ground does not have. Refused below rather than
      // guessed at: placing a door into whichever wall happens to be nearest is the kind of helpfulness that puts an
      // opening through the wrong element.
      return {};
  }
}

/**
 * Escape a library-supplied string for HTML.
 *
 * The gallery is built with `innerHTML`, and every string in it — label, category, IFC class, discipline — comes from
 * a **family library**, which is third-party content by definition: a `.mvpack` a user installs, or an index served
 * by whatever authoring service they are connected to. `svg.ts` already treats element names this way and
 * `sanitizeSvg` exists for the same reason; a gallery that trusted a label would be the one place in the read path
 * that does not.
 *
 * The fixture in this file is ours and contains nothing dangerous, which is exactly why this is easy to forget.
 */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface FamiliesDeps {
  readonly panel: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly camera: unknown;
  /** Does this kernel support the operation? Used for the dimmed-with-a-reason state. */
  readonly supports: (op: string) => boolean;
  /** Place an element. Returns a refusal message rather than throwing, because a refusal is a normal outcome. */
  readonly place: (op: string, params: Record<string, unknown>, label: string) => Promise<string | null>;
  readonly status: (message: string, kind: "ok" | "warn") => void;
  /**
   * The library index to render. Defaults to the demo fixture.
   *
   * Injectable because the real integration supplies one — massing serves `GET /families/library`, and the viewer is
   * required to read it from there rather than from the catalogue repository directly. It also makes the escaping
   * below testable against a hostile index, which is the only way to know a defence works.
   */
  readonly library?: unknown;
}

export interface FamiliesPanel {
  readonly total: number;
  dispose(): void;
}

/** Why this entry cannot be placed, or null if it can. */
function refusalFor(entry: FamilyEntry, supports: (op: string) => boolean): string | null {
  const op = OP_FOR_CLASS[entry.ifcClass];
  if (op === undefined) {
    return `${entry.ifcClass} runs on the Massing authoring service. Connect a project to place it.`;
  }
  if (!supports(op)) return `This kernel does not support ${op}.`;
  if (op === "add_door" || op === "add_window") {
    return `A ${entry.ifcClass === "IfcDoor" ? "door" : "window"} needs a host wall — select one and use the ribbon.`;
  }
  return null;
}

export function mountFamilies(deps: FamiliesDeps): FamiliesPanel {
  const parsed = parseLibrary(deps.library ?? LIBRARY_DOCUMENT);
  if (!parsed.ok) {
    // A refusal carries a JSON path, so a malformed fixture says *where*. Shown rather than thrown: a broken family
    // library is a reason to lose the gallery, not the application.
    deps.panel.innerHTML = `<p class="warn">Family library: ${parsed.why.message}</p>`;
    return { total: 0, dispose: () => {} };
  }

  const all = entriesOf(parsed.library);
  const disciplines = disciplinesIn(all);
  let discipline = disciplines[0] ?? "";
  let query = "";

  const cleanups: (() => void)[] = [];

  function tileHtml(tile: GalleryTile<FamilyEntry>): string {
    const why = refusalFor(tile.entry, deps.supports);
    const cls = ["fam-tile", why === null ? "" : "fam-dim", tile.proxy ? "fam-proxy" : ""].filter(Boolean).join(" ");
    // `title` carries the reason on hover, and `aria-disabled` carries it to assistive tech — dimmed, never hidden.
    const reason = why === null ? `Drag onto the model to place · ${tile.entry.ifcClass}` : why;
    return (
      `<li class="${cls}" data-key="${esc(tile.entry.key)}" draggable="${why === null}" ` +
      `aria-disabled="${why !== null}" title="${esc(reason)}">` +
      `<span class="fam-label">${esc(tile.entry.label)}</span>` +
      `<span class="fam-meta">${esc(tile.entry.ifcClass.replace(/^Ifc/, ""))}${tile.proxy ? " · proxy" : ""}</span>` +
      `</li>`
    );
  }

  function render(): void {
    const gallery = galleryFor(all, discipline, {
      visible: 6,
      // The ribbon row leads with what this kernel can actually place. Without it the row filled from the
      // alphabetically-first category and led with a balustrade nobody can place offline, while walls and slabs sat
      // in the flyout — visible in the rendered panel, invisible in the code.
      demote: (entry) => refusalFor(entry as FamilyEntry, deps.supports) !== null,
    });
    const searching = query.trim() !== "";
    const results = searching ? searchGallery(all, query, { limit: 24 }) : [];

    const tabs = disciplines
      .map(
        (d) =>
          `<button class="fam-tab${d === discipline ? " fam-on" : ""}" data-discipline="${esc(d)}" ` +
          `aria-pressed="${d === discipline}">${esc(d)}</button>`,
      )
      .join("");

    const body = searching
      ? `<h3 class="fam-h">${results.length} match${results.length === 1 ? "" : "es"}</h3>` +
        `<ul class="fam-grid">${results.map((e) => tileHtml({ entry: e, proxy: false })).join("")}</ul>`
      : `<h3 class="fam-h">On the ribbon</h3>` +
        `<ul class="fam-grid">${gallery.promoted.map(tileHtml).join("")}</ul>` +
        gallery.groups
          .map(
            (group) =>
              `<h3 class="fam-h">${esc(group.category)} <span class="muted">${group.tiles.length}</span></h3>` +
              `<ul class="fam-grid">${group.tiles.map(tileHtml).join("")}</ul>`,
          )
          .join("");

    deps.panel.innerHTML =
      `<div class="fam-tabs">${tabs}</div>` +
      `<input id="fam-search" class="fam-search" type="search" placeholder="Search all families…" ` +
      `value="${esc(query)}" aria-label="Search families">` +
      body +
      `<p class="fam-note muted">${gallery.total} in ${esc(discipline)} · ${all.length} in the library. ` +
      `Dimmed tiles name what would place them.</p>`;

    for (const tab of deps.panel.querySelectorAll<HTMLElement>(".fam-tab")) {
      tab.addEventListener("click", () => {
        discipline = tab.dataset.discipline!;
        render();
      });
    }

    const search = deps.panel.querySelector<HTMLInputElement>("#fam-search");
    search?.addEventListener("input", () => {
      query = search.value;
      const at = search.selectionStart;
      render();
      // Re-focus after the re-render, or typing a second character would go nowhere. Caret restored too, because
      // jumping to the end of the box on every keystroke makes correcting a typo impossible.
      const next = deps.panel.querySelector<HTMLInputElement>("#fam-search");
      next?.focus();
      if (at !== null) next?.setSelectionRange(at, at);
    });

    for (const tile of deps.panel.querySelectorAll<HTMLElement>(".fam-tile")) {
      tile.addEventListener("dragstart", (event) => {
        const key = tile.dataset.key!;
        (event as DragEvent).dataTransfer?.setData("application/x-massing-family", key);
        (event as DragEvent).dataTransfer!.effectAllowed = "copy";
      });
      // A dimmed tile still explains itself on click, because hovering for a tooltip is not a discovery mechanism
      // on a touch screen.
      tile.addEventListener("click", () => {
        const entry = all.find((e) => e.key === tile.dataset.key);
        if (entry === undefined) return;
        const why = refusalFor(entry, deps.supports);
        deps.status(why ?? `${entry.label}: drag onto the model to place it`, why === null ? "ok" : "warn");
      });
    }
  }

  // --- drop onto the model -------------------------------------------------------------------------

  const onDragOver = (event: DragEvent): void => {
    if (event.dataTransfer?.types.includes("application/x-massing-family") !== true) return;
    // `preventDefault` is what makes an element a drop target at all. Without it the browser refuses the drop and
    // nothing happens — no error, no drop, which reads as "the feature is broken" rather than "the handler is absent".
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onDrop = (event: DragEvent): void => {
    const key = event.dataTransfer?.getData("application/x-massing-family");
    if (key === undefined || key === "") return;
    event.preventDefault();

    const entry = all.find((e) => e.key === key);
    if (entry === undefined) return;

    const why = refusalFor(entry, deps.supports);
    if (why !== null) {
      deps.status(why, "warn");
      return;
    }

    const at = screenToGround(event, deps.camera as never, deps.canvas, 0);
    if (at === null) {
      // Dropped on the horizon rather than on the ground plane. Said out loud: a drop that silently does nothing is
      // indistinguishable from a broken feature.
      deps.status("Dropped past the horizon — aim at the ground plane.", "warn");
      return;
    }

    const op = OP_FOR_CLASS[entry.ifcClass]!;
    void deps.place(op, paramsFor(op, at, entry.label), entry.label).then((refusal) => {
      if (refusal !== null) deps.status(refusal, "warn");
    });
  };

  deps.canvas.addEventListener("dragover", onDragOver);
  deps.canvas.addEventListener("drop", onDrop);
  cleanups.push(() => {
    deps.canvas.removeEventListener("dragover", onDragOver);
    deps.canvas.removeEventListener("drop", onDrop);
  });

  render();

  return {
    total: all.length,
    dispose() {
      for (const fn of cleanups) fn();
    },
  };
}
