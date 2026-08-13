// @massing/ui-model — what the ribbon contains and how it collapses, as data.
//
// Deliberately separate from `ui-react`. Two hosts need to render the same tool surface: MassingViewer's
// React shell, and massing's vanilla-DOM app. If the layout table lived inside the React package, the
// second host would grow a copy of it, and the two would diverge — which is the drift this repo's
// architecture gate exists to prevent.
//
// `toolbarLayout` arrives from massing carrying its own gate test, and that test is the interesting part
// of the port. It asserts that every registered tool is laid out somewhere, that pinned tools never get
// demoted, and that every label has an icon — because a dropped tool is invisible, and the next person
// to notice is a user who needed it.

export {
  TOOLS,
  specFor,
  MAX_PRIMARY,
  primaryTitles,
  unlaidTitles,
  GROUP_LABELS,
  describe,
  TOOL_ICON,
  iconFor,
} from "./toolbarLayout.js";
export type { ToolContext, ToolGroup, ToolSpec } from "./toolbarLayout.js";

// The vendored monoline icon set (Lucide, ISC — attribution in THIRD-PARTY-NOTICES.md), as pure path
// data. It lives here rather than in the React shell so that "every icon this toolbar names is one we
// actually vendored" is assertable within one package. A typo in the icon map renders *nothing*, which
// is visually indistinguishable from "this button has no icon yet" — so it has to be a build failure.
export { ICONS, hasIcon } from "./icons.js";
export type { IconName } from "./icons.js";

export {
  TABS,
  availabilityOf,
  buildRibbon,
  contextualTabsFor,
  emptyTabs,
  everyToolMapped,
  everyToolReachable,
  layoutTab,
  orphanedHomes,
  reachableIn,
  tabsWithContent,
  toolId,
} from "./ribbon.js";
export type {
  Availability,
  ItemSize,
  LaidOutGroup,
  RibbonGroup,
  RibbonItem,
  RibbonLayout,
  TabId,
} from "./ribbon.js";

export { disciplinesIn, galleryFor, searchGallery } from "./gallery.js";
export type {
  Gallery,
  GalleryEntry,
  GalleryGroup,
  GalleryOptions,
  GallerySearchOptions,
  GalleryTile,
} from "./gallery.js";

export { createCanvasModeSwitch, visibility, MODE_ORDER } from "./canvasMode.js";
export type { CanvasMode, CanvasModeSwitch, ModeDef, SwitchResult } from "./canvasMode.js";
