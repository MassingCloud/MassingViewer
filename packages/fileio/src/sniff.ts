/**
 * What a file actually is, decided by reading it.
 *
 * ## The rule, and why it is not the obvious one
 *
 * **The extension is a hint. The bytes are the answer. When they disagree, say so.**
 *
 * massing gates file opening on the extension: `REF_EXTENSIONS` is a list of suffixes, and a file whose suffix
 * is not on it is refused. That is wrong in both directions, and both directions happen constantly in this
 * industry:
 *
 * - A perfectly good IFC arrives as `Tower-A.ifc.txt` because an email gateway renamed it, or as
 *   `model` with no extension because it came out of a zip on a Mac. Refusing it is a support ticket.
 * - A file named `model.ifc` is frequently an **ifcZIP** — the compressed IFC that Revit and Archicad both
 *   export — or occasionally a BCF someone mislabelled. Accepting it on the strength of its name means the IFC
 *   parser gets a ZIP, and the user is told something like "unexpected token PK at line 1", which is true and
 *   useless.
 *
 * So this module answers three separate questions instead of conflating them into one:
 * **what is it** ({@link FileKind}), **how sure are we** ({@link Sniffed.confidence}), and **does that agree
 * with what it was called** ({@link Sniffed.extensionSaid}). A UI that has all three can say "this is named
 * `.ifc` but is actually a ZIP archive — open it as ifcZIP?", which is a question a user can answer.
 *
 * ## No decoding here
 *
 * Sniffing reads a *head* — the first few kilobytes — plus the total size. That keeps it cheap enough to run on
 * every file in a 200-file drop, and it keeps this module pure: no DOM, no `File`, no async. The one check that
 * needs the total size is binary STL, and it is the most interesting one in the file.
 */

export type FileKind =
  /** IFC in STEP physical file form (ISO-10303-21). The main event. */
  | "ifc"
  /** IFC as XML. Rare, valid, and a different parser. */
  | "ifcxml"
  /** A ZIP. Could be ifcZIP, BCF, or a 3D Tiles bundle — the head cannot tell them apart. */
  | "zip"
  /** A STEP file that is not IFC: AP203/AP214 from a mechanical CAD tool. */
  | "step"
  | "obj"
  | "stl-ascii"
  | "stl-binary"
  | "ply"
  | "gltf"
  | "glb"
  | "dxf"
  | "dwg"
  | "pdf"
  | "svg"
  | "geojson"
  /** LAS/LAZ point cloud. */
  | "las"
  | "e57"
  /** Recognisably text, but nothing we know. */
  | "text"
  | "unknown";

export type Confidence =
  /** A magic number or a mandatory header string. Wrong only if the file is deliberately crafted. */
  | "certain"
  /** Structural evidence: the right tokens in the right places. */
  | "likely"
  /** Nothing but the name. */
  | "extension-only";

export interface Sniffed {
  readonly kind: FileKind;
  readonly confidence: Confidence;
  /** What the evidence was, in words, for a UI and for a bug report. */
  readonly why: string;
  /** What the extension implied, or `null` if it had none or an unknown one. */
  readonly extensionSaid: FileKind | null;
  /**
   * `false` when the name and the bytes disagree.
   *
   * Surfaced rather than resolved. Silently trusting the bytes is *usually* right, and the case where it is
   * wrong — a `.ifc` that is really a ZIP — is exactly the case a user needs to be told about, because the
   * answer ("yes, that is an ifcZIP, please open it") is theirs and not ours.
   */
  readonly agrees: boolean;
  /** IFC schema, when the header declared one: `IFC2X3`, `IFC4`, `IFC4X3_ADD2`. */
  readonly schema?: string;
  /** Anything else worth reporting: triangle counts, glTF version. */
  readonly detail?: Readonly<Record<string, string | number>>;
}

/** How much of a file {@link sniff} needs. Everything here reads within the first 4 KiB. */
export const SNIFF_BYTES = 4096;

const EXTENSIONS: Readonly<Record<string, FileKind>> = {
  ifc: "ifc",
  step: "step",
  stp: "step",
  ifcxml: "ifcxml",
  ifczip: "zip",
  bcf: "zip",
  bcfzip: "zip",
  zip: "zip",
  obj: "obj",
  stl: "stl-binary", // Ambiguous by name; the bytes decide between ascii and binary.
  ply: "ply",
  gltf: "gltf",
  glb: "glb",
  dxf: "dxf",
  dwg: "dwg",
  pdf: "pdf",
  svg: "svg",
  geojson: "geojson",
  json: "geojson",
  las: "las",
  laz: "las",
  e57: "e57",
  txt: "text",
};

/** The last dot-suffix, lowercased. `Tower-A.ifc.txt` yields `txt`, which is the point. */
export function extensionOf(name: string): string | null {
  const at = name.lastIndexOf(".");
  if (at <= 0 || at === name.length - 1) return null;
  return name.slice(at + 1).toLowerCase();
}

/**
 * ASCII-decode a byte range, stopping at the first byte that cannot be text.
 *
 * Not `TextDecoder`: a UTF-8 decoder given binary either throws or silently emits replacement characters, and
 * both hide the fact that the file is not text. Here a non-text byte ends the string, so `startsWith` checks on
 * the result cannot accidentally match inside a binary blob.
 */
function ascii(bytes: Uint8Array, from: number, to: number): string {
  let out = "";
  for (let i = from; i < Math.min(to, bytes.length); i++) {
    const byte = bytes[i]!;
    if (byte === 0) break;
    out += String.fromCharCode(byte);
  }
  return out;
}

function u32le(bytes: Uint8Array, at: number): number {
  return (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0;
}

/** Strip a UTF-8 BOM and leading whitespace. Real IFC files from real tools have both. */
function textStart(bytes: Uint8Array): number {
  let at = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) at = 3;
  while (at < bytes.length && (bytes[at] === 0x20 || bytes[at] === 0x09 || bytes[at] === 0x0a || bytes[at] === 0x0d)) at++;
  return at;
}

/**
 * Identify a file from its first bytes and its total size.
 *
 * `size` is separate from `head.length` and is not decoration: it is the only way to tell a binary STL from
 * anything else, and passing `head.length` for it would make that check silently always fail.
 */
export function sniff(name: string, head: Uint8Array, size: number): Sniffed {
  const ext = extensionOf(name);
  const extensionSaid = ext === null ? null : (EXTENSIONS[ext] ?? null);
  const start = textStart(head);
  const lead = ascii(head, start, start + 512);
  const upper = lead.toUpperCase();

  const decide = (
    kind: FileKind,
    confidence: Confidence,
    why: string,
    extra?: { schema?: string; detail?: Readonly<Record<string, string | number>> },
  ): Sniffed => ({
    kind,
    confidence,
    why,
    extensionSaid,
    // `stl` maps to `stl-binary` in the table, so an ASCII STL would otherwise be reported as a disagreement.
    // The two STL forms are one format as far as a user's expectations go.
    agrees: extensionSaid === null || extensionSaid === kind || (extensionSaid === "stl-binary" && kind === "stl-ascii"),
    ...extra,
  });

  // --- magic numbers first: cheapest and most reliable -----------------------------------------------

  if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07)) {
    // A ZIP, and that is genuinely as far as the head goes. ifcZIP, BCF and a 3D Tiles bundle are all ZIPs, and
    // telling them apart needs the central directory at the *end* of the file. Reporting "zip" honestly is
    // better than guessing from the extension we already know might be wrong.
    return decide("zip", "certain", "PK signature: a ZIP archive — could be ifcZIP, BCF, or another bundle");
  }
  if (lead.startsWith("%PDF-")) {
    return decide("pdf", "certain", `PDF ${lead.slice(5, 8)}`, { detail: { version: lead.slice(5, 8) } });
  }
  if (ascii(head, 0, 4) === "glTF") {
    const version = u32le(head, 4);
    return decide("glb", "certain", `glTF binary container, version ${version}`, { detail: { version } });
  }
  if (ascii(head, 0, 4) === "LASF") {
    return decide("las", "certain", "LASF signature: a LAS point cloud");
  }
  if (lead.startsWith("ASTM-E57")) {
    return decide("e57", "certain", "ASTM-E57 signature");
  }
  if (ascii(head, 0, 4) === "AC10" || ascii(head, 0, 4) === "AC1.") {
    // AC1015 = R2000, AC1032 = 2018, and so on. Recognised so the refusal can be specific.
    return decide("dwg", "certain", `DWG, format ${ascii(head, 0, 6)}`, { detail: { format: ascii(head, 0, 6) } });
  }

  // --- IFC and STEP: the header is mandatory, so this is as good as a magic number ------------------

  if (upper.startsWith("ISO-10303-21;")) {
    // FILE_SCHEMA is required by the standard, so a file without one is malformed rather than a different
    // format. Reading it here means a caller can refuse IFC2X3 with a reason before parsing 200 MB.
    const schemaMatch = /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i.exec(ascii(head, start, start + SNIFF_BYTES));
    const schema = schemaMatch?.[1]?.toUpperCase();
    if (schema !== undefined && schema.startsWith("IFC")) {
      return decide("ifc", "certain", `ISO-10303-21 header declaring ${schema}`, { schema });
    }
    if (schema !== undefined) {
      return decide("step", "certain", `ISO-10303-21 header declaring ${schema}, which is not IFC`, { schema });
    }
    // The header is there but FILE_SCHEMA was past the head, or absent. Still certainly a STEP file.
    return decide("step", "likely", "ISO-10303-21 header, but no FILE_SCHEMA within the first 4 KiB");
  }

  // --- XML family ------------------------------------------------------------------------------------

  if (lead.startsWith("<?xml") || lead.startsWith("<")) {
    const wide = ascii(head, start, start + SNIFF_BYTES);
    if (/<svg[\s>]/i.test(wide)) return decide("svg", "certain", "an <svg> root element");
    if (/ifcXML|<ifc[A-Z]/i.test(wide)) return decide("ifcxml", "likely", "XML containing ifcXML markup");
    return decide("text", "likely", "XML, but not a format this recognises");
  }

  // --- binary STL: arithmetic, not a signature -------------------------------------------------------

  if (size >= 84) {
    const triangles = u32le(head, 80);
    // The one true test for a binary STL: 80-byte header, a uint32 count, then exactly 50 bytes per triangle.
    // There is no magic number — the header is free-form, and many writers put the word "solid" in it, which is
    // why sniffing an STL by its leading text gets the answer backwards for those files.
    if (triangles > 0 && 84 + triangles * 50 === size) {
      return decide("stl-binary", "certain", `84 + ${triangles} x 50 bytes matches the file size exactly`, {
        detail: { triangles },
      });
    }
  }

  // --- text formats: structural evidence ------------------------------------------------------------

  if (/^solid\b/i.test(lead)) {
    // Only after the binary check. A binary STL whose header begins "solid" is common, and trusting this first
    // would hand a binary file to an ASCII parser.
    return decide("stl-ascii", "likely", "begins with 'solid' and the size does not match a binary STL");
  }
  if (/^\s*0\s*[\r\n]+\s*SECTION\b/.test(lead)) {
    // DXF has no signature either: it opens with group code 0 and the value SECTION.
    const version = /\$ACADVER[\s\S]{0,40}?(AC\d{4})/.exec(ascii(head, start, start + SNIFF_BYTES))?.[1];
    return decide("dxf", "likely", version === undefined ? "group code 0 / SECTION" : `DXF ${version}`, {
      detail: version === undefined ? undefined : { version },
    });
  }
  if (lead.startsWith("ply") && /\bformat\s+(ascii|binary_)/.test(lead)) {
    return decide("ply", "certain", "ply header with a format line");
  }
  // OBJ is line-oriented with no header at all, so this is evidence rather than proof. A vertex or a face is
  // required — matching a leading `#` would match half the plain text ever written, and an outer check for it
  // adds nothing, since anything with a `v `/`f ` line already qualifies.
  if (/^(v|vn|f) /m.test(lead)) return decide("obj", "likely", "OBJ vertex or face records");
  if (lead.startsWith("{")) {
    const wide = ascii(head, start, start + SNIFF_BYTES);
    if (/"asset"\s*:\s*\{/.test(wide) && /"version"/.test(wide)) return decide("gltf", "likely", "glTF JSON asset block");
    if (/"type"\s*:\s*"(FeatureCollection|Feature)"/.test(wide)) return decide("geojson", "likely", "GeoJSON type member");
    return decide("text", "likely", "JSON, but not a format this recognises");
  }

  // --- nothing matched -------------------------------------------------------------------------------

  // Is it even text? If every byte in the head is printable or common whitespace, say "text" — which lets a UI
  // offer "open as IFC anyway" for a mis-transferred file, rather than a dead end.
  let printable = 0;
  const looked = Math.min(head.length, 512);
  for (let i = 0; i < looked; i++) {
    const byte = head[i]!;
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127)) printable++;
  }
  if (looked > 0 && printable / looked > 0.95) {
    return extensionSaid === null
      ? decide("text", "likely", "printable text, but no recognised structure")
      : decide(extensionSaid, "extension-only", `nothing recognisable in the bytes; going on the .${ext} name alone`);
  }

  return extensionSaid === null
    ? decide("unknown", "certain", "binary, with no signature this recognises")
    : decide(extensionSaid, "extension-only", `binary with no known signature; going on the .${ext} name alone`);
}
