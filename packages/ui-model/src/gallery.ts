/**
 * The Build ribbon's family galleries, as a layout table rather than as markup.
 *
 * `DRAFT_ELEMENTS` gave the ribbon four things to place — wall, slab, column, door. The family library has hundreds,
 * across disciplines, and a flyout listing them alphabetically is a worse tool than four buttons. This turns a parsed
 * library into what a gallery actually needs: a bounded set of visible tiles, a grouped overflow, and a search index.
 *
 * ## Why this is here and not in `ui-react`
 *
 * Same reason `toolbarLayout.ts` is: no DOM, so massing's vanilla app and this repo's React shell read **one** table
 * rather than each deciding what a gallery contains. A layout decision made in a component is a layout decision the
 * other host cannot see.
 *
 * ## Why it takes `FamilyEntry[]` and not a `Library`
 *
 * `@massing/ui-model` is L1 — pure algorithms, no dependency on `@massing/assets`. Taking the flattened entries keeps
 * the layer boundary intact and, more usefully, means the same function lays out a gallery over a filtered subset, a
 * search result, or a host's own catalogue.
 */

/** The subset of a family entry a gallery needs. Structural, so `FamilyEntry` satisfies it without an import. */
export interface GalleryEntry {
  readonly key: string;
  readonly label: string;
  readonly category: string;
  readonly discipline: string;
  readonly ifcClass: string;
  /** Where the library grades the geometry as a placeholder, the tile has to say so. */
  readonly geometry?: string | null;
  readonly tier?: string | null;
}

export interface GalleryTile<T extends GalleryEntry = GalleryEntry> {
  readonly entry: T;
  /**
   * Whether the library itself calls this geometry a placeholder.
   *
   * Surfaced on the tile, not hidden: the family index is explicit that some entries are L200 proxies, and a user who
   * places one expecting a detailed component and finds a box has been misled by the tool rather than by the library.
   */
  readonly proxy: boolean;
}

export interface GalleryGroup<T extends GalleryEntry = GalleryEntry> {
  readonly category: string;
  readonly tiles: readonly GalleryTile<T>[];
}

export interface Gallery<T extends GalleryEntry = GalleryEntry> {
  readonly discipline: string;
  /** Tiles shown on the ribbon itself, in order. Never more than `visible`. */
  readonly promoted: readonly GalleryTile<T>[];
  /** Everything, grouped by category, for the flyout. Includes the promoted tiles. */
  readonly groups: readonly GalleryGroup<T>[];
  readonly total: number;
}

export interface GalleryOptions {
  /**
   * How many tiles the ribbon shows before the rest go to the flyout. Default 6.
   *
   * A cap on *display*, never on availability — every entry is in `groups`. `railToolbox.ts` in massing shipped a real
   * bug by capping the toolbox itself: promoting one tool silently demoted another, and *"a dropped tool is invisible…
   * the next person to notice is a user who needed it"*. So the invariant asserted in the tests is that
   * `groups` holds everything regardless of this number.
   */
  readonly visible?: number;
  /**
   * Keys to promote, in order, ahead of the frequency-free default.
   *
   * A host's own usage data belongs to the host — this package cannot know what a given office places most. Unknown
   * keys are ignored rather than reserving an empty slot.
   */
  readonly preferred?: readonly string[];
}

const DEFAULT_VISIBLE = 6;

/** A stable order: category, then label, both case-insensitive. */
function compare(a: GalleryEntry, b: GalleryEntry): number {
  const byCategory = a.category.localeCompare(b.category, "en", { sensitivity: "base" });
  return byCategory !== 0 ? byCategory : a.label.localeCompare(b.label, "en", { sensitivity: "base" });
}

/**
 * Whether the library grades this entry's geometry as a placeholder.
 *
 * Matched on the *value* rather than on an allow-list of LOD codes, because the library's vocabulary is its own and
 * will grow. Anything naming itself a proxy or an L100/L200 placeholder counts.
 */
function isProxy(entry: GalleryEntry): boolean {
  const value = `${entry.geometry ?? ""} ${entry.tier ?? ""}`.toLowerCase();
  return /proxy|placeholder|\bl100\b|\bl200\b/.test(value);
}

/**
 * Lay out one discipline's gallery.
 *
 * Entries from other disciplines are ignored rather than being an error: a caller handing over the whole library and
 * asking for `Structural` is the ordinary case, not a mistake.
 */
export function galleryFor<T extends GalleryEntry>(
  entries: readonly T[],
  discipline: string,
  options: GalleryOptions = {},
): Gallery<T> {
  const visible = Math.max(0, options.visible ?? DEFAULT_VISIBLE);
  const mine = entries.filter((e) => e.discipline === discipline);
  const tile = (entry: T): GalleryTile<T> => ({ entry, proxy: isProxy(entry) });

  const byCategory = new Map<string, T[]>();
  for (const entry of [...mine].sort(compare)) {
    const bucket = byCategory.get(entry.category);
    if (bucket === undefined) byCategory.set(entry.category, [entry]);
    else bucket.push(entry);
  }

  /**
   * Promotion: the caller's preferred keys first, then one per category before a second from any.
   *
   * Round-robin rather than "the first six alphabetically", which on a real library means six tiles from whichever
   * category sorts first and a flyout for everything else. Breadth is what makes the ribbon row useful — it shows
   * what *kinds* of thing this discipline can place.
   */
  const promoted: GalleryTile<T>[] = [];
  const taken = new Set<string>();
  for (const key of options.preferred ?? []) {
    if (promoted.length >= visible) break;
    const found = mine.find((e) => e.key === key);
    if (found !== undefined && !taken.has(found.key)) {
      promoted.push(tile(found));
      taken.add(found.key);
    }
  }
  const queues = [...byCategory.values()].map((list) => list.filter((e) => !taken.has(e.key)));
  let round = 0;
  while (promoted.length < visible && queues.some((q) => q.length > round)) {
    for (const queue of queues) {
      if (promoted.length >= visible) break;
      const entry = queue[round];
      if (entry !== undefined && !taken.has(entry.key)) {
        promoted.push(tile(entry));
        taken.add(entry.key);
      }
    }
    round++;
  }

  return {
    discipline,
    promoted,
    // Every entry, always — `visible` bounds the ribbon row and nothing else.
    groups: [...byCategory.entries()].map(([category, list]) => ({ category, tiles: list.map(tile) })),
    total: mine.length,
  };
}

/** Disciplines present, in a stable order, so a host can build the tab strip without sorting. */
export function disciplinesIn(entries: readonly GalleryEntry[]): readonly string[] {
  return [...new Set(entries.map((e) => e.discipline))].sort((a, b) =>
    a.localeCompare(b, "en", { sensitivity: "base" }),
  );
}

export interface GallerySearchOptions {
  readonly limit?: number;
  /** Restrict to one discipline. Absent searches them all, which is what a palette wants. */
  readonly discipline?: string;
}

/**
 * Search for a family to place.
 *
 * Ranked, not filtered, and the ranking is the point: a user typing "door" wants the door families, not the first
 * alphabetical entry whose description happens to contain the word. Exact key, then label prefix, then label
 * substring, then category and IFC class — so `IfcDoor` and `Doors` both find doors, and a label match always beats a
 * metadata match.
 *
 * Deliberately not fuzzy. `@massing/commands` already carries a fuzzy matcher for the Ctrl+K palette, where the corpus
 * is a few hundred command titles a user half-remembers. A family library is a controlled vocabulary someone is
 * reading off a list, and fuzzy matching there mostly produces confident nonsense.
 */
export function searchGallery<T extends GalleryEntry>(
  entries: readonly T[],
  query: string,
  options: GallerySearchOptions = {},
): readonly T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const pool = options.discipline === undefined ? entries : entries.filter((e) => e.discipline === options.discipline);

  const scored: { entry: T; score: number }[] = [];
  for (const entry of pool) {
    const label = entry.label.toLowerCase();
    const score =
      entry.key.toLowerCase() === q
        ? 0
        : label === q
          ? 1
          : label.startsWith(q)
            ? 2
            : label.includes(q)
              ? 3
              : entry.category.toLowerCase().includes(q)
                ? 4
                : entry.ifcClass.toLowerCase().includes(q)
                  ? 5
                  : entry.key.toLowerCase().includes(q)
                    ? 6
                    : -1;
    if (score >= 0) scored.push({ entry, score });
  }

  scored.sort((a, b) => (a.score !== b.score ? a.score - b.score : compare(a.entry, b.entry)));
  const limit = options.limit ?? 20;
  return scored.slice(0, limit).map((s) => s.entry);
}
