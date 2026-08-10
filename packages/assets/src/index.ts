// @massing/assets — the family library as data the viewer reads, not content it contains.
//
// The format, the loader and the queries are MIT and live here. The 419 families and 2,769 types are CC0-1.0 and
// live in MassingCloud/massing-families, reached through massing's `GET /families/library` so there is one shelf
// rather than two that drift. See the header of `library.ts`.
export {
  byDisciplineAndCategory,
  entries,
  parseLibrary,
  proxies,
  search,
} from "./library.js";
export type { FamilyEntry, Library, LibraryFailure, LicenseId, Pack, ParseResult } from "./library.js";
