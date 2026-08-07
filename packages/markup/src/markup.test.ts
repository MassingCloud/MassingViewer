import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { asGuid, type Guid } from "@massingviewer/core";
import {
  addComment,
  addViewpoint,
  anchoredGuids,
  createTopic,
  isLive,
  newBcfGuid,
  resolveAnchor,
  setStatus,
  type Topic,
  type Viewpoint,
} from "./topic";
import { bcfManifest, toBcfZip } from "./bcf";
import { DEFAULT_TOOLSET, parseToolSet, toolSetToJson } from "./toolset";
import { crc32, makeZip } from "./zip";

const guid = (n: number): Guid => asGuid(`0Test${String(n).padStart(17, "0")}`);
const DATE = "2026-08-07T09:00:00Z";

/**
 * Extract a ZIP with an implementation that is **not ours**.
 *
 * The point of these tests is that a hand-rolled ZIP writer must not be checked by a hand-rolled ZIP reader —
 * that only proves self-consistency, which is exactly the failure mode. So this reaches for a real extractor and
 * **throws if it cannot find one**, rather than skipping: a silently skipped independent check is worse than no
 * check, because the suite still reports green.
 *
 * Several candidates because the runners differ — this Windows host does not have `powershell.exe` on the PATH
 * the test process inherits, GNU tar cannot read ZIP even though bsdtar can, and CI is Linux. CPython's
 * `zipfile` is the one that is present essentially everywhere.
 */
function extractZip(archive: string, out: string): string {
  const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const candidates: { cmd: string; args: string[] }[] = [
    // CPython's zipfile, which is a wholly independent implementation and is present on this host and on the CI
    // runners. Listed first because it needs no PATH luck.
    { cmd: "python", args: ["-m", "zipfile", "-e", archive, out] },
    { cmd: "python3", args: ["-m", "zipfile", "-e", archive, out] },
    { cmd: "unzip", args: ["-q", archive, "-d", out] },
    {
      // Absolute, because `powershell.exe` is not on the PATH this test process inherits — the first version
      // used the bare name and failed with ENOENT.
      cmd: powershell,
      args: ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${out}' -Force`],
    },
  ];

  const tried: string[] = [];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate.cmd, candidate.args, { stdio: "pipe" });
      return candidate.cmd;
    } catch (cause) {
      tried.push(`${candidate.cmd}: ${(cause as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error(
    "no independent ZIP extractor available, so the archive could not be verified by anything but our own " +
      `writer. Tried:\n  ${tried.join("\n  ")}`,
  );
}

function topic(over: Partial<Parameters<typeof createTopic>[0]> = {}): Topic {
  return createTopic({
    title: "Wall clashes with duct",
    author: "reviewer@example.com",
    date: DATE,
    guid: "11111111-1111-4111-8111-111111111111",
    ...over,
  });
}

// ---------------------------------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------------------------------

describe("crc32", () => {
  it("matches the canonical known answer", () => {
    // The one assertion that catches a typo'd polynomial. A wrong CRC does not throw and does not look wrong;
    // it produces an archive every reader rejects as corrupt.
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("is zero for empty input and stable for a known string", () => {
    expect(crc32(new Uint8Array())).toBe(0);
    expect(crc32(new TextEncoder().encode("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
  });
});

describe("makeZip", () => {
  it("refuses paths a ZIP cannot legally contain", () => {
    const bytes = new Uint8Array([1]);
    expect(() => makeZip([{ path: "/absolute.txt", bytes }])).toThrow(/forward slashes/);
    expect(() => makeZip([{ path: "windows\\path.txt", bytes }])).toThrow(/forward slashes/);
    expect(() => makeZip([{ path: "a.txt", bytes }, { path: "a.txt", bytes }])).toThrow(/duplicate/);
  });

  it("is byte-deterministic for the same input", () => {
    // A BCF export whose bytes change every run cannot be a fixture, cannot be diffed, and produces a diff on
    // every build — which is why the timestamps are fixed and the real time lives in the topic XML.
    const entries = [{ path: "a.txt", bytes: new TextEncoder().encode("hello") }];
    expect([...makeZip(entries)]).toEqual([...makeZip(entries)]);
  });

  /**
   * The verification that matters: extract with an **independent** implementation.
   *
   * Reading the archive back with our own reader would only prove we are self-consistent, which is exactly the
   * failure mode a hand-rolled ZIP writer has. This uses the operating system's own unzip, so a header field we
   * got wrong shows up as a real extraction failure.
   */
  it("produces an archive the operating system can extract", () => {
    const files = {
      "bcf.version": '<?xml version="1.0"?>\n<Version VersionId="3.0" />\n',
      "topic/markup.bcf": "<Markup><Topic /></Markup>\n",
      "topic/nested/deep.txt": "a nested path, to check the directory entries\n",
      // Non-ASCII, to check the UTF-8 filename flag. Without bit 11 a reader falls back to CP437 and this
      // arrives mangled.
      "Büro/notes.txt": "Grüße\n",
    };
    const zip = makeZip(
      Object.entries(files).map(([path, text]) => ({ path, bytes: new TextEncoder().encode(text) })),
    );

    const dir = mkdtempSync(join(tmpdir(), "mv-zip-"));
    try {
      const archive = join(dir, "test.zip");
      const out = join(dir, "out");
      writeFileSync(archive, zip);

      extractZip(archive, out);

      for (const [path, expected] of Object.entries(files)) {
        const actual = readFileSync(join(out, ...path.split("/")), "utf8");
        expect(actual, path).toBe(expected);
      }
      expect(readdirSync(out).sort()).toEqual(["bcf.version", "Büro", "topic"].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Anchoring — the whole point
// ---------------------------------------------------------------------------------------------------

describe("resolveAnchor", () => {
  const present = new Set([guid(1), guid(2)]);
  const exists = (g: Guid): boolean => present.has(g);

  it("resolves when every element is still there", () => {
    const outcome = resolveAnchor({ guids: [guid(1), guid(2)], at: { x: 0, y: 0 } }, exists);
    expect(outcome.kind).toBe("resolved");
    expect(isLive(outcome)).toBe(true);
  });

  it("reports partial rather than silently dropping the missing half", () => {
    // An issue about a beam clashing with a duct is still an issue when the duct is deleted — and *which* half
    // was lost is what a reviewer needs in order to decide whether it is resolved.
    const outcome = resolveAnchor({ guids: [guid(1), guid(9)], at: { x: 0, y: 0 } }, exists);
    expect(outcome.kind).toBe("partial");
    if (outcome.kind !== "partial") return;
    expect(outcome.present).toEqual([guid(1)]);
    expect(outcome.missing).toEqual([guid(9)]);
    // Half an issue is still an issue.
    expect(isLive(outcome)).toBe(true);
  });

  it("orphans a markup whose elements are all gone, and says why", () => {
    // The outcome every other tool lacks. An issue silently pointing at deleted geometry is how a
    // resolved-looking issue log hides real work.
    const outcome = resolveAnchor({ guids: [guid(8), guid(9)], at: { x: 1, y: 2 } }, exists);
    expect(outcome.kind).toBe("orphaned");
    if (outcome.kind !== "orphaned") return;
    expect(outcome.reason).toMatch(/none of the 2 elements/);
    expect(isLive(outcome)).toBe(false);
  });

  it("names the single missing element rather than saying 'none of the 1'", () => {
    const outcome = resolveAnchor({ guids: [guid(9)], at: { x: 0, y: 0 } }, exists);
    if (outcome.kind !== "orphaned") throw new Error("expected orphaned");
    expect(outcome.reason).toContain(guid(9));
  });

  it("treats a pin with no elements as orphaned from the start", () => {
    // A position-only markup is what a PDF tool produces, and it is exactly what this model exists to avoid.
    // It is representable, and it is honest about being unanchored.
    const outcome = resolveAnchor({ guids: [], at: { x: 3, y: 4 } }, exists);
    expect(outcome.kind).toBe("orphaned");
    if (outcome.kind === "orphaned") expect(outcome.reason).toMatch(/never anchored/);
  });
});

// ---------------------------------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------------------------------

describe("topics", () => {
  it("mints a canonical 36-character UUID, not an IFC GlobalId", () => {
    // The two identifier formats sit side by side in this codebase. Emitting a 22-character IFC id where BCF
    // wants a UUID validates against nothing and is rejected by strict readers.
    const id = newBcfGuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).not.toMatch(/^[0-9A-Za-z_$]{22}$/);
    expect(new Set(Array.from({ length: 100 }, newBcfGuid)).size).toBe(100);
  });

  it("refuses a topic with no title", () => {
    // BCF requires it, and a titleless topic is unidentifiable in every issue list that would ever show it.
    expect(() => topic({ title: "" })).toThrow(/needs a title/);
    expect(() => topic({ title: "   " })).toThrow(/needs a title/);
  });

  it("defaults to an open, normal-priority issue", () => {
    const t = topic();
    expect(t.status).toBe("Open");
    expect(t.priority).toBe("Normal");
    expect(t.type).toBe("Issue");
    expect(t.comments).toEqual([]);
  });

  it("records who changed a status and when", () => {
    const t = setStatus(topic(), "Closed", "lead@example.com", "2026-08-08T10:00:00Z");
    expect(t.status).toBe("Closed");
    expect(t.modifiedAuthor).toBe("lead@example.com");
  });

  it("ignores a no-op status change", () => {
    // "Closed → Closed" adds a modification date and no information, and an audit trail full of them is one
    // nobody reads.
    const closed = setStatus(topic(), "Closed", "a", "2026-08-08T10:00:00Z");
    expect(setStatus(closed, "Closed", "b", "2026-08-09T10:00:00Z")).toBe(closed);
  });

  it("refuses an empty comment and stamps the topic when one is added", () => {
    expect(() => addComment(topic(), { author: "a", date: DATE, comment: "  " })).toThrow(/needs text/);
    const t = addComment(topic(), { author: "a", date: DATE, comment: "Confirmed on site." });
    expect(t.comments).toHaveLength(1);
    expect(t.modifiedDate).toBe(DATE);
  });

  it("does not mutate the topic it was given", () => {
    // Immutable so the command bus can invert the operation — the same reason every op in the kernel returns a
    // new state rather than editing in place.
    const original = topic();
    addComment(original, { author: "a", date: DATE, comment: "x" });
    setStatus(original, "Closed", "a", DATE);
    expect(original.comments).toEqual([]);
    expect(original.status).toBe("Open");
  });

  it("collects every anchored element across topics and viewpoints", () => {
    const viewpoint: Viewpoint = {
      guid: "22222222-2222-4222-8222-222222222222",
      camera: { kind: "perspective", position: [1, 2, 3], direction: [0, 0, -1], up: [0, 1, 0], value: 60 },
      selection: [guid(3)],
    };
    const a = addViewpoint(topic({ pin: { guids: [guid(1), guid(2)], at: { x: 0, y: 0 } } }), viewpoint);
    const b = topic({ guid: "33333333-3333-4333-8333-333333333333", pin: { guids: [guid(2)], at: { x: 1, y: 1 } } });
    // Deduplicated: guid(2) is on both, and badging the model twice for one element would double-count.
    expect(anchoredGuids([a, b]).sort()).toEqual([guid(1), guid(2), guid(3)].sort());
  });
});

// ---------------------------------------------------------------------------------------------------
// BCF
// ---------------------------------------------------------------------------------------------------

describe("BCF export", () => {
  const viewpoint: Viewpoint = {
    guid: "22222222-2222-4222-8222-222222222222",
    camera: { kind: "perspective", position: [10, 5, 10], direction: [-1, -0.5, -1], up: [0, 1, 0], value: 60 },
    selection: [guid(1)],
    hidden: [guid(2)],
  };
  const full = addViewpoint(
    addComment(topic({ pin: { guids: [guid(1), guid(2)], at: { x: 4, y: 3 }, drawing: "L1 Plan" } }), {
      author: "reviewer@example.com",
      date: DATE,
      comment: "The duct passes through the beam.",
      guid: "44444444-4444-4444-8444-444444444444",
    }),
    viewpoint,
  );

  it("lays the archive out the way every BCF reader expects", () => {
    // This layout *is* the interop contract — Solibri, BIMcollab, Revizto and Bonsai all read it, and none of
    // them read anyone's proprietary issue format.
    expect(bcfManifest([full], { project: { guid: "p", name: "Tower A" } })).toEqual([
      "bcf.version",
      "project.bcfp",
      `${full.guid}/markup.bcf`,
      `${full.guid}/${viewpoint.guid}.bcfv`,
    ]);
  });

  it("writes valid, deterministic XML with the topic's real data", () => {
    const zip = toBcfZip([full], { project: { guid: "p", name: "Tower A" } });
    expect([...zip]).toEqual([...toBcfZip([full], { project: { guid: "p", name: "Tower A" } })]);

    const text = new TextDecoder().decode(zip);
    expect(text).toContain('VersionId="3.0"');
    expect(text).toContain('<Topic Guid="11111111-1111-4111-8111-111111111111" TopicType="Issue" TopicStatus="Open">');
    expect(text).toContain("<Title>Wall clashes with duct</Title>");
    expect(text).toContain("<CreationAuthor>reviewer@example.com</CreationAuthor>");
    expect(text).toContain("<Comment>The duct passes through the beam.</Comment>");
    // The anchor survives into the file, which is the point of anchoring at all.
    expect(text).toContain(`<Reference>${guid(1)} ${guid(2)}</Reference>`);
    expect(text).toContain(`<Component IfcGuid="${guid(1)}"`);
    expect(text).toContain("<PerspectiveCamera>");
    expect(text).toContain("<FieldOfView>60</FieldOfView>");
  });

  it("omits absent optional elements rather than writing empty ones", () => {
    // BCF rejects an empty element where a value is required-if-present, and a reader that tolerates it usually
    // shows a blank assignee instead of an unassigned one.
    const text = new TextDecoder().decode(toBcfZip([topic()]));
    expect(text).not.toContain("<AssignedTo>");
    expect(text).not.toContain("<Description>");
    expect(text).not.toContain("<ModifiedDate>");
    expect(text).not.toContain("project.bcfp");
  });

  it("writes an orthogonal camera with the right element", () => {
    const ortho = addViewpoint(topic(), {
      guid: "55555555-5555-4555-8555-555555555555",
      camera: { kind: "orthogonal", position: [0, 20, 0], direction: [0, -1, 0], up: [0, 0, -1], value: 30 },
    });
    const text = new TextDecoder().decode(toBcfZip([ortho]));
    expect(text).toContain("<OrthogonalCamera>");
    expect(text).toContain("<ViewToWorldScale>30</ViewToWorldScale>");
    expect(text).not.toContain("<FieldOfView>");
  });

  it("escapes XML that would otherwise break the document", () => {
    // Topic titles come from users, and comments come from consultants pasting from email.
    const nasty = addComment(topic({ title: `Wall <A> & "B"`, description: "5 < 6" }), {
      author: "a",
      date: DATE,
      comment: "</Comment><Injected/>",
    });
    const text = new TextDecoder().decode(toBcfZip([nasty]));
    expect(text).not.toContain("<Injected/>");
    expect(text).toContain("&lt;Injected/&gt;");
    expect(text).toContain("Wall &lt;A&gt; &amp; &quot;B&quot;");
  });

  it("includes a snapshot as its own entry when one is attached", () => {
    const withSnap = addViewpoint(topic(), {
      ...viewpoint,
      snapshotPng: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });
    expect(bcfManifest([withSnap])).toContain(`${withSnap.guid}/${viewpoint.guid}.png`);
    const text = new TextDecoder().decode(toBcfZip([withSnap]));
    expect(text).toContain(`<Snapshot>${viewpoint.guid}.png</Snapshot>`);
  });

  it("produces a .bcfzip the operating system can extract", () => {
    // The end-to-end interop check: real archive, independent extractor, real XML on disk.
    const zip = toBcfZip([full], { project: { guid: "p", name: "Tower A" } });
    const dir = mkdtempSync(join(tmpdir(), "mv-bcf-"));
    try {
      const archive = join(dir, "issues.bcfzip.zip");
      const out = join(dir, "out");
      writeFileSync(archive, zip);
      extractZip(archive, out);
      expect(readFileSync(join(out, "bcf.version"), "utf8")).toContain('VersionId="3.0"');
      const markup = readFileSync(join(out, full.guid, "markup.bcf"), "utf8");
      expect(markup).toContain("<Title>Wall clashes with duct</Title>");
      const bcfv = readFileSync(join(out, full.guid, `${viewpoint.guid}.bcfv`), "utf8");
      expect(bcfv).toContain("<PerspectiveCamera>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Tool Sets
// ---------------------------------------------------------------------------------------------------

describe("tool sets", () => {
  it("ships a small default set where every tool produces a typed issue", () => {
    // The reason Tool Sets are worth having: the markup and the issue are the same act. A tool that only drew a
    // coloured shape would be a shape library.
    expect(DEFAULT_TOOLSET.tools.length).toBeGreaterThan(0);
    expect(DEFAULT_TOOLSET.tools.length).toBeLessThanOrEqual(8);
    for (const tool of DEFAULT_TOOLSET.tools) {
      expect(tool.topicDefaults, tool.id).toBeDefined();
      expect(tool.topicDefaults!.type, tool.id).toBeDefined();
    }
    const rfi = DEFAULT_TOOLSET.tools.find((t) => t.id === "rfi")!;
    expect(rfi.topicDefaults!.type).toBe("Inquiry");
    expect(rfi.topicDefaults!.labels).toContain("RFI");
  });

  it("round-trips through JSON", () => {
    // A Tool Set is a shared *file*, so this is the actual usage rather than a serialisation nicety.
    const json = toolSetToJson(DEFAULT_TOOLSET);
    expect(json.endsWith("\n")).toBe(true);
    expect(json).toContain("\n  ");
    expect(parseToolSet(JSON.parse(json))).toEqual(DEFAULT_TOOLSET);
  });

  it("refuses a malformed shared file, naming what is wrong", () => {
    // These travel between practices. A tool missing its shape would otherwise fail at click time, in front of a
    // reviewer, with no indication that the inherited file is the problem.
    expect(() => parseToolSet(null)).toThrow(/JSON object/);
    expect(() => parseToolSet({ name: "x", tools: [] })).toThrow(/needs an id/);
    expect(() => parseToolSet({ id: "x", tools: [] })).toThrow(/needs a name/);
    expect(() => parseToolSet({ id: "x", name: "Set" })).toThrow(/no tools array/);
    expect(() => parseToolSet({ id: "x", name: "Set", tools: [{ id: "a", label: "A" }] })).toThrow(/shape/);
    expect(() =>
      parseToolSet({ id: "x", name: "Set", tools: [{ id: "a", label: "A", shape: "wobble" }] }),
    ).toThrow(/expected one of/);
    expect(() =>
      parseToolSet({
        id: "x",
        name: "Set",
        tools: [
          { id: "a", label: "A", shape: "pin" },
          { id: "a", label: "B", shape: "pin" },
        ],
      }),
    ).toThrow(/two tools with id "a"/);
  });

  it("applying a tool's defaults produces a correctly routed topic", () => {
    // One click, and the practice's convention is impossible to get wrong rather than merely written down.
    const clash = DEFAULT_TOOLSET.tools.find((t) => t.id === "clash")!;
    const t = createTopic({
      title: "Beam vs duct",
      author: "a",
      date: DATE,
      ...clash.topicDefaults,
    });
    expect(t.type).toBe("Clash");
    expect(t.priority).toBe("High");
    expect(t.labels).toContain("Coordination");
  });
});
