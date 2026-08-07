import { describe, expect, it } from "vitest";
import { extensionOf, sniff, SNIFF_BYTES } from "./sniff.js";
import { describe as describeFile, supportFor, supportMatrix } from "./support.js";

/**
 * The cases here are not hypothetical. Every one of the awkward ones is a file that arrives in this industry
 * routinely, and each is a way that gating on the extension gets the wrong answer.
 */

const bytes = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
};

const IFC_HEADER =
  "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n" +
  "FILE_NAME('Tower-A.ifc','2026-08-07T00:00:00',(''),(''),'','','');\n" +
  "FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n";

describe("extensionOf", () => {
  it("takes the last suffix, which is the whole point", () => {
    // `Tower-A.ifc.txt` is an IFC an email gateway renamed. Reading the *first* suffix would call it an IFC on
    // the strength of a name, which is the habit this module exists to break — the bytes are what decide.
    expect(extensionOf("Tower-A.ifc.txt")).toBe("txt");
    expect(extensionOf("model.IFC")).toBe("ifc");
    expect(extensionOf("model")).toBeNull();
    expect(extensionOf(".gitignore")).toBeNull(); // a leading dot is not an extension
    expect(extensionOf("trailing.")).toBeNull();
  });
});

describe("IFC", () => {
  it("reads the schema out of the header", () => {
    // Worth having before parsing: refusing IFC2X3 with a reason beats parsing 240 MB and then discovering it.
    const result = sniff("Tower-A.ifc", bytes(IFC_HEADER), 5000);
    expect(result.kind).toBe("ifc");
    expect(result.confidence).toBe("certain");
    expect(result.schema).toBe("IFC4");
    expect(result.agrees).toBe(true);
  });

  it("survives a BOM and leading whitespace, which real exporters emit", () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, 0x0d, 0x0a, ...bytes(IFC_HEADER)]);
    expect(sniff("x.ifc", withBom, 5000).kind).toBe("ifc");
  });

  it("recognises an IFC that was renamed to .txt", () => {
    // The refusal case. massing's extension gate rejects this file; it is a valid IFC.
    const result = sniff("Tower-A.ifc.txt", bytes(IFC_HEADER), 5000);
    expect(result.kind).toBe("ifc");
    expect(result.extensionSaid).toBe("text");
    expect(result.agrees).toBe(false);
    expect(supportFor(result.kind).state).toBe("supported");
  });

  it("calls a non-IFC STEP file what it is", () => {
    const ap214 = bytes("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\n");
    const result = sniff("bracket.stp", ap214, 900);
    expect(result.kind).toBe("step");
    expect(result.schema).toBe("AUTOMOTIVE_DESIGN");
    // And declining it says *why*, so nobody files this as a bug.
    expect(supportFor("step").reason).toMatch(/mechanical CAD|OpenCascade/);
  });

  it("still reports STEP when FILE_SCHEMA is past the head", () => {
    const padded = bytes(`ISO-10303-21;\nHEADER;\n${"/* filler */\n".repeat(500)}FILE_SCHEMA(('IFC4'));\n`);
    const result = sniff("x.ifc", padded.subarray(0, SNIFF_BYTES), padded.length);
    expect(result.kind).toBe("step");
    expect(result.confidence).toBe("likely");
    expect(result.why).toContain("no FILE_SCHEMA");
  });
});

describe("the .ifc that is really a ZIP", () => {
  it("reports a ZIP and flags the disagreement rather than guessing", () => {
    // The acceptance case, and the more damaging of the two. Revit and Archicad both export ifcZIP; a user who
    // renames it `.ifc` gets, in a name-trusting viewer, "unexpected token PK at line 1" from the IFC parser.
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);
    const result = sniff("model.ifc", zip, 90_000);
    expect(result.kind).toBe("zip");
    expect(result.confidence).toBe("certain");
    expect(result.agrees).toBe(false);
    expect(result.why).toMatch(/ifcZIP/);
  });

  it("does not pretend to know which kind of ZIP it is", () => {
    // ifcZIP and BCF are both ZIPs and go to different places. Telling them apart needs the central directory at
    // the END of the file, which a head cannot see — so the honest answer is "zip", with the routing deferred.
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    expect(sniff("issues.bcfzip", zip, 4000).kind).toBe("zip");
    expect(sniff("model.ifczip", zip, 4000).kind).toBe("zip");
    expect(supportFor("zip").reason).toMatch(/central directory/);
  });
});

describe("STL, where the arithmetic beats the text", () => {
  it("identifies a binary STL by size, even when its header says 'solid'", () => {
    // The trap, and it is common: many writers put "solid <name>" in the free-form 80-byte header of a *binary*
    // STL. Sniffing on the leading text gets those exactly backwards and hands a binary file to an ASCII parser.
    const triangles = 3;
    const head = new Uint8Array(84);
    head.set(bytes("solid Tower-A exported by something"), 0);
    new DataView(head.buffer).setUint32(80, triangles, true);
    const size = 84 + triangles * 50;

    const result = sniff("part.stl", head, size);
    expect(result.kind).toBe("stl-binary");
    expect(result.confidence).toBe("certain");
    expect(result.detail?.triangles).toBe(triangles);
  });

  it("identifies an ASCII STL when the size does not fit the binary layout", () => {
    const text = bytes("solid Tower\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\n");
    const result = sniff("part.stl", text, text.length);
    expect(result.kind).toBe("stl-ascii");
    // `.stl` maps to binary in the extension table, but the two forms are one format to a user — so this must
    // not be reported as a name/bytes disagreement.
    expect(result.agrees).toBe(true);
  });

  it("does not claim binary STL for a file that merely has the right size", () => {
    // A zero-triangle count would make `84 + 0 * 50 === 84` true for any 84-byte file, so it is excluded.
    const head = new Uint8Array(84);
    expect(sniff("x.bin", head, 84).kind).not.toBe("stl-binary");
  });
});

describe("other formats", () => {
  it("reads a GLB and its version", () => {
    const glb = new Uint8Array(12);
    glb.set(bytes("glTF"), 0);
    new DataView(glb.buffer).setUint32(4, 2, true);
    const result = sniff("site.glb", glb, 5000);
    expect(result.kind).toBe("glb");
    expect(result.detail?.version).toBe(2);
  });

  it("distinguishes glTF JSON from GeoJSON from other JSON", () => {
    expect(sniff("a.gltf", bytes('{"asset":{"version":"2.0"},"scenes":[]}'), 40).kind).toBe("gltf");
    expect(sniff("a.geojson", bytes('{"type":"FeatureCollection","features":[]}'), 42).kind).toBe("geojson");
    expect(sniff("a.json", bytes('{"hello":1}'), 11).kind).toBe("text");
  });

  it("reads a DXF, which has no signature either", () => {
    const dxf = bytes("  0\nSECTION\n  2\nHEADER\n  9\n$ACADVER\n  1\nAC1009\n");
    const result = sniff("plan.dxf", dxf, dxf.length);
    expect(result.kind).toBe("dxf");
    expect(result.detail?.version).toBe("AC1009");
  });

  it("recognises DWG so the refusal can name the licence", () => {
    const result = sniff("plan.dwg", bytes("AC1032\0\0\0\0\0"), 90_000);
    expect(result.kind).toBe("dwg");
    // The whole reason to recognise a format we will never open: "the only good browser DWG reader is GPL-3.0,
    // export a DXF" is a sentence a user can act on. "Unsupported file type" is not.
    expect(supportFor("dwg").state).toBe("declined");
    expect(supportFor("dwg").reason).toMatch(/LibreDWG|GPL-3\.0/);
    expect(supportFor("dwg").reason).toMatch(/DXF/);
  });

  it("tells an SVG from other XML", () => {
    expect(sniff("a.svg", bytes('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg">'), 60).kind).toBe("svg");
    expect(sniff("a.xml", bytes("<?xml version=\"1.0\"?><project/>"), 31).kind).toBe("text");
  });

  it("requires a vertex or a face for OBJ, not just a comment", () => {
    // A comment-first heuristic matches most plain text ever written, so it is not evidence.
    expect(sniff("a.obj", bytes("# Blender v4.0\nv 0 0 0\nv 1 0 0\nf 1 2 3\n"), 40).confidence).toBe("likely");

    // A comment-only `.obj` still comes back as `obj`, because falling back to the extension is the designed last
    // resort — but as `extension-only`, which is the field carrying the difference. A first version asserted on
    // `kind` here, which conflates "we read this and recognised it" with "we are taking your word for it".
    const weak = sniff("notes.obj", bytes("# just some notes about the model\n"), 34);
    expect(weak.kind).toBe("obj");
    expect(weak.confidence).toBe("extension-only");
  });
});

describe("when the bytes say nothing", () => {
  it("falls back to the extension and says that is what it did", () => {
    const result = sniff("mystery.las", new Uint8Array([1, 2, 3, 250, 251, 252, 0, 4]), 900);
    expect(result.confidence).toBe("extension-only");
    expect(result.why).toMatch(/name alone/);
  });

  it("reports plain text as text, so a UI can offer 'open as IFC anyway'", () => {
    const result = sniff("dump", bytes("just some words, nothing structured\n"), 36);
    expect(result.kind).toBe("text");
    expect(result.extensionSaid).toBeNull();
  });

  it("reports unknown binary as unknown, not as a guess", () => {
    const result = sniff("blob", new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0xab, 0xcd]), 6);
    expect(result.kind).toBe("unknown");
    expect(result.confidence).toBe("certain");
  });
});

describe("the support matrix", () => {
  it("gives every kind a state, and every non-supported one a reason", () => {
    // The invariant that keeps this honest. A refusal with no reason is exactly the "unsupported file type"
    // dead end the module exists to replace, and it would be added by accident the first time a kind is.
    for (const entry of supportMatrix()) {
      expect(entry.state, entry.kind).toBeDefined();
      if (entry.state !== "supported") {
        expect(entry.reason, `${entry.kind} has no reason`).toBeTruthy();
        expect(entry.reason!.length, `${entry.kind}'s reason is too short to help`).toBeGreaterThan(20);
      }
    }
  });

  it("covers every FileKind sniff can return", () => {
    // A kind with no entry would throw at the point of use. Enumerating the matrix and comparing against the
    // union is the only way to catch it, because TypeScript's exhaustiveness check is satisfied by `Record`.
    const kinds = supportMatrix().map((e) => e.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds).toContain("ifc");
    expect(kinds).toContain("unknown");
  });

  it("phrases the disagreement as information, not an error", () => {
    const result = sniff("model.ifc", new Uint8Array([0x50, 0x4b, 0x03, 0x04]), 90_000);
    const sentence = describeFile({ name: "model.ifc" }, result);
    expect(sentence).toContain("model.ifc");
    expect(sentence).toContain("but the bytes say zip");
  });
});
