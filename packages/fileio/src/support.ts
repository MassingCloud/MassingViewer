import type { FileKind, Sniffed } from "./sniff";

/**
 * What this build can do with a file, and — when it cannot — why, in a sentence a user can act on.
 *
 * This is **dim-not-hide applied to file formats**, and it is the same argument the ribbon makes about tools.
 * The alternative, and what almost every viewer does, is to accept a short allowlist and reject everything else
 * with "unsupported file type". That tells a user nothing: they cannot tell whether the format will never be
 * supported, is coming later, or was simply mis-detected — so the only move left is to give up or file a ticket.
 *
 * Recognising a format and declining to open it *with a reason* is strictly better than not recognising it. It
 * also means the list below is a public, checkable statement of scope: the roadmap says point clouds are M10, and
 * a user who drops a `.las` gets told exactly that instead of discovering it by absence.
 */

export type SupportState =
  /** Opens now. */
  | "supported"
  /** Recognised, and the work to open it is planned. `reason` names where. */
  | "planned"
  /** Recognised, and deliberately not planned. `reason` says why — usually a licence. */
  | "declined"
  /** Not a model at all — a drawing, a markup file, a sheet. Handled elsewhere in the app. */
  | "not-a-model";

export interface Support {
  readonly state: SupportState;
  /** Required for everything except `supported`. A refusal with no reason is the thing this file exists to prevent. */
  readonly reason?: string;
  /** Which part of the app takes it, when it is not the 3D model loader. */
  readonly route?: "model" | "drawing" | "markup" | "reference";
}

const SUPPORT: Readonly<Record<FileKind, Support>> = {
  ifc: { state: "supported", route: "model" },
  step: {
    state: "declined",
    reason:
      "AP203/AP214 STEP is mechanical CAD geometry, not a building model — it needs an exact BREP kernel " +
      "(OpenCascade is LGPL and a very large WASM payload). Convert to IFC or to a mesh format first.",
  },
  ifcxml: {
    state: "planned",
    reason: "ifcXML is a second IFC parser rather than a variant of the first one. Not in 1.0.",
    route: "model",
  },
  zip: {
    state: "planned",
    reason:
      "a ZIP could be ifcZIP or BCF and the two go to different places, so it needs the central directory read " +
      "before it can be routed. Unzip it and open the file inside.",
  },
  glb: { state: "planned", reason: "glTF loading is a reference-model feature, M10.", route: "reference" },
  gltf: { state: "planned", reason: "glTF loading is a reference-model feature, M10.", route: "reference" },
  obj: { state: "planned", reason: "mesh references are M10.", route: "reference" },
  "stl-ascii": { state: "planned", reason: "mesh references are M10.", route: "reference" },
  "stl-binary": { state: "planned", reason: "mesh references are M10.", route: "reference" },
  ply: { state: "planned", reason: "point clouds and meshes are M10.", route: "reference" },
  las: { state: "planned", reason: "point clouds are M10 — they need streaming, not a loader.", route: "reference" },
  e57: { state: "planned", reason: "point clouds are M10 — they need streaming, not a loader.", route: "reference" },
  geojson: {
    state: "planned",
    reason:
      "GIS context is M10. It also needs a coordinate reference system and a project origin before the geometry " +
      "means anything, which is a decision rather than a loader.",
    route: "reference",
  },
  dxf: {
    state: "planned",
    reason: "DXF is written today but not read. Reading it means a second drawing importer, planned after 1.0.",
    route: "drawing",
  },
  dwg: {
    state: "declined",
    reason:
      "the only good browser DWG reader is LibreDWG, which is GPL-3.0 and would take this whole project with " +
      "it. Export a DXF instead — every tool that writes DWG also writes DXF.",
  },
  pdf: {
    state: "planned",
    reason: "PDF markup is planned: a sheet to review, not a model to load.",
    route: "markup",
  },
  svg: { state: "planned", reason: "an SVG is a drawing to place on a sheet, not a model.", route: "drawing" },
  text: { state: "declined", reason: "no recognisable structure. If this is an IFC, its header is missing or damaged." },
  unknown: { state: "declined", reason: "binary with no signature this recognises." },
};

export function supportFor(kind: FileKind): Support {
  return SUPPORT[kind];
}

/**
 * The whole matrix, for documentation and for a settings page.
 *
 * Exported so the table can be *rendered* rather than restated. A capability list maintained in prose beside the
 * code is a capability list that is wrong within two releases.
 */
export function supportMatrix(): readonly (Support & { readonly kind: FileKind })[] {
  return (Object.keys(SUPPORT) as FileKind[]).map((kind) => ({ kind, ...SUPPORT[kind] }));
}

/**
 * The sentence to show for one sniffed file.
 *
 * Built here rather than in the UI so massing and MassingViewer say the same thing, and so the awkward case —
 * bytes and name disagreeing — is phrased once. That case is a *question*, not an error: only the user knows
 * whether `Tower-A.ifc` being a ZIP is a mislabelled file or an ifcZIP they meant to send.
 */
export function describe(file: { readonly name: string }, sniffed: Sniffed): string {
  const support = supportFor(sniffed.kind);
  const mismatch = sniffed.agrees
    ? ""
    : ` (named .${sniffed.extensionSaid === null ? "?" : sniffed.extensionSaid}, but the bytes say ${sniffed.kind})`;

  if (support.state === "supported") return `${file.name}: ${sniffed.kind}${mismatch} — ${sniffed.why}`;
  return `${file.name}: ${sniffed.kind}${mismatch} — ${support.reason ?? "not supported"}`;
}
