// @massing/fileio — the first ten minutes.
//
// The Design Room's own roadmap says it: "the room is not behind on features — it is behind on the first ten
// minutes." This package is that sentence, addressed. Two decisions carry it:
//
//   - **A file is what its bytes say, not what its name says.** massing gates on the extension, which refuses a
//     good IFC called `Tower-A.ifc.txt` and accepts a ZIP called `model.ifc` — then fails deep inside the parser
//     with "unexpected token PK". Sniffing answers what/how-sure/does-it-agree as three separate questions.
//   - **Recognising a format and declining it with a reason beats not recognising it.** The same argument the
//     ribbon makes about tools, applied to file types: "point clouds are M10" is actionable, "unsupported file
//     type" is not.
//
// Vanilla DOM, per docs/adr/0009-ribbon-renders-in-vanilla-dom.md — a drop target that only works inside React
// is a drop target massing has to write a second time.

export { SNIFF_BYTES, extensionOf, sniff } from "./sniff.js";
export type { Confidence, FileKind, Sniffed } from "./sniff.js";

export { describe, supportFor, supportMatrix } from "./support.js";
export type { Support, SupportState } from "./support.js";

export { canPickHandles, createDropTarget, pickFiles } from "./open.js";
export type { DropTarget, DropTargetOptions, OpenedFile, PickOptions, PickResult } from "./open.js";
