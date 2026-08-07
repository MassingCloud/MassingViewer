// @massingviewer/ui-react — React for the parts React is good at.
//
// ADR-0009 sent the ribbon to vanilla DOM: it is long-lived, imperative, and needed by two hosts, and a vanilla
// renderer works in both while a React one works in one. This package is what remained after that decision, and
// the split turns out to be a clean one:
//
//   - `Ribbon` is a thin *wrapper*. Mount, update, dispose. If it grows, the ribbon is being reimplemented in
//     React, which is the thing ADR-0009 exists to prevent.
//   - `PropertyGrid` is where React earns its place — a tree of data wholly replaced on selection change, with
//     expand state layered over it. Writing that imperatively means hand-rolling reconciliation.
//   - `Dock` is fixed regions, resizable and collapsible, deliberately NOT arbitrary docking: every
//     tab-dragging engine reparents nodes, and moving a `<canvas>` loses its WebGL context.
//   - `CommandPalette` is a combobox, which is one of the few widgets where getting ARIA wrong makes it
//     unusable rather than merely worse.

export { Ribbon, useRibbonHandle } from "./Ribbon";
export type { RibbonProps } from "./Ribbon";

export { CommandPalette, fuzzyScore, rank, usePaletteShortcut } from "./CommandPalette";
export type { CommandPaletteProps, PaletteEntry } from "./CommandPalette";

export { PropertyGrid, discrepancyOf } from "./PropertyGrid";
export type { Discrepancy, Property, PropertyGridProps, PropertySet, PropertyValue } from "./PropertyGrid";

export { Dock, loadLayout, saveLayout } from "./Dock";
export type { DockLayout, DockPanel, DockProps, DockSide } from "./Dock";
