// @massingviewer/catalog — the parametric element palette.
//
// Each entry says what a user can draw, which IFC class it becomes, which kernel operation authors it,
// how many points it takes, and which parameters it exposes. That one table drives three surfaces: the
// ribbon gallery, the interactive prompt loop's option keywords, and the properties strip shown while
// placing. One schema, three renderings — not three hand-maintained lists.
//
// This is also already the shape an asset pack needs, which is why the eventual `.mvpack` format
// generalises it rather than introducing a second element description.

export { DRAFT_ELEMENTS, DISCIPLINES, familyToDraftElement } from "./draftCatalog.js";
export type {
  Discipline,
  ParamType,
  ParamDef,
  ParamValues,
  DraftElement,
  FamilyDef,
} from "./draftCatalog.js";
