// @massingviewer/drawings2d — a plan is a live view of the model, not an export of it.
//
// One decision carries the package: entity geometry is in MODEL space, in metres, and paper is a render-time
// transform. massing's generator bakes paper coordinates into its SVG, which freezes scale, paper size, theme
// and viewport placement at generation time — so restyling means regenerating. Here, three of the hardest
// features in a drawing tool fall out of one shape:
//
//   - styling is a stylesheet, so architectural → fire-safety is a repaint
//   - 2D<->3D selection works, because every line carries the GlobalId of its element
//   - SVG, DXF and PDF are three pure functions of (Drawing, Theme, Paper)
//
// No DOM, no renderer, no IFC parser. See docs/adr/0004-2d-drawing-engine.md.

export { boundsOf, entitiesFor, guidsIn, layersIn, makeDrawing } from "./model";
export type {
  Drawing,
  DrawingEntity,
  DrawingKind,
  DrawingProvenance,
  EntityGeometry,
  EntityRole,
  Point,
  Region,
  ViewDefinition,
} from "./model";

export { ARCHITECTURAL, FIRE_SAFETY, THEMES, matches, paintFor } from "./theme";
export type { Paint, Rule, Selector, Theme } from "./theme";

export { IMPERIAL_SCALES, METRIC_SCALES, PAPER_SIZES, SCALES, fitToPaper, toPaper, toPaperLength, transformFor } from "./paper";
export type { Paper, PaperSize, Scale, ScaleLadder, Transform } from "./paper";

export { toSvg } from "./svg";
export type { SvgOptions } from "./svg";

export { dxfLimitations, toDxf } from "./dxf";
export type { DxfOptions } from "./dxf";

export { createPlanProvider, generatePlan } from "./plan";
export type { DrawingFailure, DrawingInput, DrawingProvider, ElementMesh } from "./provider";

export { cutTriangle, nestLoops, ringContains, signedArea, stitch } from "./section";
export type { Seg } from "./section";
