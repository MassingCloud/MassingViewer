// @massingviewer/markup — a markup that knows which wall it is about.
//
// Every PDF-based review tool stores a shape on a flattened raster that has forgotten what it refers to. A markup
// here anchors to an IFC GlobalId, so it follows the model, can be filtered by element, and can be answered by
// changing the model rather than by drawing over it again.
//
// BCF 3.0 is the internal model, not an export format. Tools with their own issue model and a BCF exporter always
// lose something in the round trip, so people stop using it, so the interop never happens. Modelling BCF directly
// costs a little expressiveness and buys topics that open unchanged in Solibri, BIMcollab, Revizto, Navisworks and
// Bonsai.
//
// No DOM, no renderer, no zip dependency.

export {
  addComment,
  addViewpoint,
  anchoredGuids,
  createTopic,
  isLive,
  newBcfGuid,
  resolveAnchor,
  setStatus,
} from "./topic.js";
export type {
  AnchorOutcome,
  Comment,
  NewTopicInput,
  Pin,
  Topic,
  TopicPriority,
  TopicStatus,
  TopicType,
  Viewpoint,
} from "./topic.js";

export { bcfManifest, toBcfZip } from "./bcf.js";
export type { BcfExportOptions, BcfProject } from "./bcf.js";

export { DEFAULT_TOOLSET, parseToolSet, toolSetToJson } from "./toolset.js";
export type { MarkupTool, ToolSet } from "./toolset.js";

export { crc32, makeZip } from "./zip.js";
export type { ZipEntry } from "./zip.js";
