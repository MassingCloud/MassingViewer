/**
 * `@massing/assets` — the family library, as data the viewer reads rather than content it contains.
 *
 * ## Why the content is not in this repository
 *
 * `MassingCloud/massing-families` holds 419 families and 2,769 types across 57 discipline packs, IFC4, and its
 * `catalog/` content is **CC0-1.0** — public domain. This package ships the *format, the loader and the queries*
 * under MIT; the content stays where it is generated. That split is the plan's asset-pack model — *"asset packs
 * are code-free plugins"* — and it is what keeps a 2,769-type library out of a viewer bundle.
 *
 * ## The shape is theirs, not invented here
 *
 * The field names below mirror `src/massing_families/pack.py`'s `_family_index()` output, because a schema invented
 * to look tidy in TypeScript would have to be reconciled with the real JSON on first contact. Their JSON is
 * `snake_case`; this package's types are `camelCase`, and {@link parseLibrary} is the one place that mapping lives.
 *
 * ## Where it is read from
 *
 * **massing's `GET /families/library`, not the catalog repository** — confirmed against their tree: they have
 * already vendored the fetch script, hold 59 packs under `services/data/families/external/`, and expose an import
 * endpoint. Fetching the upstream catalog independently would give two copies of the same shelf, free to drift. So
 * this module takes *parsed JSON* and never performs I/O: the host owns the transport, which is also what makes an
 * offline cached pack and a live endpoint the same code path.
 */

/** A licence string as the library reports it — `"CC0-1.0"` for the public-domain content, `"MIXED"` for a pack. */
export type LicenseId = string;

/**
 * One placeable family type.
 *
 * `license` is carried per entry rather than per library on purpose: the upstream library writes
 * `MF_Library.License` onto every type so *"it follows the object into any model that imports it"*, and dropping it
 * here would break that at the first hop.
 */
export interface FamilyEntry {
  readonly key: string;
  readonly label: string;
  readonly category: string;
  readonly discipline: string;
  /** e.g. `IfcDoor`. The class the placed instance becomes. */
  readonly ifcClass: string;
  /** IFC `PredefinedType`, or null where the family does not set one. */
  readonly predefined: string | null;
  /** Level of development, as the library grades it — `tier` upstream. */
  readonly tier: string | null;
  /** How complete the geometry is. The library is explicit that some families are still L200 proxies. */
  readonly geometry: string | null;
  /** Uniclass/OmniClass-style code, where the library assigns one. */
  readonly classification: string | null;
  readonly license: LicenseId;
  /** The corresponding key in massing's own catalogue, where there is one. */
  readonly massingKey: string | null;
  /** MEP families carry connection ports; architectural ones generally do not. */
  readonly hasPorts: boolean;
}

/** One discipline pack: an IFC file plus the index of what is inside it. */
export interface Pack {
  /** The IFC file's name within the library, e.g. `structural-steel-w.ifc`. */
  readonly file: string;
  readonly discipline: string;
  readonly ifcSchema: string | null;
  readonly sizeBytes: number | null;
  readonly entries: readonly FamilyEntry[];
}

export interface Library {
  readonly name: string;
  readonly version: string;
  /** The **content** licence, which is what a consumer shelving IFC packs actually cares about. */
  readonly license: LicenseId;
  readonly attribution: string | null;
  readonly packs: readonly Pack[];
}

/** Refusal rather than an exception — a malformed library is a question for the user, not a crash. */
export interface LibraryFailure {
  readonly code: "not_an_object" | "no_packs" | "malformed_pack" | "malformed_entry";
  readonly message: string;
  /** Where in the document, so a 59-pack library does not have to be searched by hand. */
  readonly at: string;
}

export type ParseResult = { readonly ok: true; readonly library: Library } | { readonly ok: false; readonly why: LibraryFailure };

const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * Parse a library document.
 *
 * **Tolerant of extra fields, strict about the ones it uses.** The upstream library is actively developed — its
 * README advertises a changing family count — so a parser that rejected unknown keys would break on their next
 * release for no reason. What it will not do is invent a value: an entry with no `key` or no `ifc_class` cannot be
 * placed, so it is a refusal naming the entry rather than an entry with an empty string in it.
 */
export function parseLibrary(document: unknown): ParseResult {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return { ok: false, why: { code: "not_an_object", message: "a library document must be a JSON object", at: "$" } };
  }
  const root = document as Record<string, unknown>;

  const rawPacks = root["packs"];
  if (!Array.isArray(rawPacks) || rawPacks.length === 0) {
    return {
      ok: false,
      why: {
        code: "no_packs",
        message: "a library with no packs has nothing to place — check this is the library index and not a single pack",
        at: "$.packs",
      },
    };
  }

  const packs: Pack[] = [];
  for (const [i, raw] of rawPacks.entries()) {
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, why: { code: "malformed_pack", message: "pack is not an object", at: `$.packs[${i}]` } };
    }
    const pack = raw as Record<string, unknown>;
    const file = str(pack["file"]);
    const discipline = str(pack["discipline"]);
    if (file === null || discipline === null) {
      return {
        ok: false,
        why: {
          code: "malformed_pack",
          message: "a pack needs both `file` and `discipline` — without them it cannot be fetched or filtered",
          at: `$.packs[${i}]`,
        },
      };
    }

    // `index` upstream. Absent is legal and means "not indexed yet"; present-but-not-an-array is a bug worth
    // reporting, because it would silently shelve a pack with nothing in it.
    const rawIndex = pack["index"];
    if (rawIndex !== undefined && !Array.isArray(rawIndex)) {
      return { ok: false, why: { code: "malformed_pack", message: "`index` must be an array", at: `$.packs[${i}].index` } };
    }

    const entries: FamilyEntry[] = [];
    for (const [j, rawEntry] of (rawIndex ?? []).entries()) {
      const at = `$.packs[${i}].index[${j}]`;
      if (typeof rawEntry !== "object" || rawEntry === null) {
        return { ok: false, why: { code: "malformed_entry", message: "entry is not an object", at } };
      }
      const entry = rawEntry as Record<string, unknown>;
      const key = str(entry["key"]);
      const ifcClass = str(entry["ifc_class"]);
      if (key === null || ifcClass === null) {
        return {
          ok: false,
          why: {
            code: "malformed_entry",
            message: "an entry needs `key` and `ifc_class` — a type with neither cannot be placed in a model",
            at,
          },
        };
      }
      entries.push({
        key,
        // Falling back to the key is deliberate: an unlabelled family should still appear in a gallery, because a
        // missing label is a content bug and hiding the family makes it invisible instead of obvious.
        label: str(entry["label"]) ?? key,
        category: str(entry["category"]) ?? "Uncategorised",
        discipline: str(entry["discipline"]) ?? discipline,
        ifcClass,
        predefined: str(entry["predefined"]),
        tier: str(entry["tier"]),
        geometry: str(entry["geometry"]),
        classification: str(entry["classification"]),
        // Per entry, and defaulted from the library rather than left empty — this string follows the object into
        // the model, so a blank one is worse than an inherited one.
        license: str(entry["license"]) ?? str((root["licensing"] as Record<string, unknown> | undefined)?.["content"]) ?? "unknown",
        massingKey: str(entry["massing_key"]),
        hasPorts: entry["has_ports"] === true,
      });
    }

    packs.push({
      file,
      discipline,
      ifcSchema: str(pack["ifc_schema"]),
      sizeBytes: num(pack["size_bytes"]),
      entries,
    });
  }

  const licensing = (root["licensing"] ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    library: {
      name: str(root["name"]) ?? "Family library",
      version: str(root["version"]) ?? "0.0.0",
      license: str(licensing["content"]) ?? "unknown",
      attribution: str(licensing["attribution"]),
      packs,
    },
  };
}

/** Every entry across every pack, flattened — what a gallery iterates. */
export function entries(library: Library): readonly FamilyEntry[] {
  return library.packs.flatMap((pack) => pack.entries);
}

/**
 * Group entries the way the Build ribbon presents them: discipline, then category.
 *
 * A `Map` rather than an object, and insertion-ordered by first appearance rather than sorted, so the library's own
 * ordering survives. The upstream packs are already discipline-ordered and second-guessing that in the UI is how a
 * gallery ends up disagreeing with the documentation the content ships with.
 */
export function byDisciplineAndCategory(library: Library): Map<string, Map<string, FamilyEntry[]>> {
  const out = new Map<string, Map<string, FamilyEntry[]>>();
  for (const entry of entries(library)) {
    let categories = out.get(entry.discipline);
    if (categories === undefined) {
      categories = new Map();
      out.set(entry.discipline, categories);
    }
    const bucket = categories.get(entry.category);
    if (bucket === undefined) categories.set(entry.category, [entry]);
    else bucket.push(entry);
  }
  return out;
}

/**
 * Substring search over label, key and classification, case-insensitively.
 *
 * Deliberately not fuzzy. The Ctrl+K palette owns fuzzy matching across everything; a family gallery filter that
 * guessed would surface a door when someone typed a beam size, and at 2,769 types a wrong guess is worse than no
 * match. Classification is included because a specifier searching `EF_25_10` is searching for exactly that.
 */
export function search(library: Library, query: string): readonly FamilyEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return entries(library);
  return entries(library).filter(
    (e) =>
      e.label.toLowerCase().includes(needle) ||
      e.key.toLowerCase().includes(needle) ||
      (e.classification ?? "").toLowerCase().includes(needle),
  );
}

/** Entries whose geometry the library itself does not claim is finished, so a gallery can say so. */
export function proxies(library: Library): readonly FamilyEntry[] {
  return entries(library).filter((e) => e.geometry !== null && /proxy|l200|placeholder/i.test(e.geometry));
}
