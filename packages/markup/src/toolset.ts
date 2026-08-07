import type { TopicPriority, TopicType } from "./topic.js";

/**
 * Tool Sets — the most-loved and least-copied feature in AEC review software.
 *
 * ## What they are, and why nobody else has them
 *
 * In Bluebeam, a Tool Set is a named palette of pre-configured markup tools: *this* is what our practice's
 * fire-rated-wall callout looks like, *this* is the RFI stamp with the right fields, *this* is the punch-list
 * marker. A reviewer picks a tool and applies it; the appearance, the default text and the metadata all come with
 * it. They are shared as files, inherited between projects, and people are genuinely attached to theirs.
 *
 * Every competitor with 3D authoring has ignored them, and every competitor with 2D markup has copied only the
 * shapes. What makes them valuable is not the shapes — it is that **the tool carries the data**: applying the
 * "Fire rating query" tool produces a topic already typed as `Inquiry`, labelled `Fire`, priority `High`, assigned
 * to the fire consultant. The markup and the issue are the same act.
 *
 * ## Why they are data and not code
 *
 * A tool is a plain object with no behaviour, so a Tool Set is a JSON file: shareable, diffable, reviewable, and
 * publishable through the same asset-pack channel as families and hatches. A tool that needed code would need a
 * plugin, and a plugin needs trust — which is exactly the friction that stops a practice from sharing its
 * standards.
 */

export interface MarkupTool {
  readonly id: string;
  readonly label: string;
  /** Shown in the palette. One or two characters, or an emoji — kept as text so a Tool Set stays a JSON file. */
  readonly glyph?: string;
  /** The shape this tool draws. `pin` is the anchored marker; the rest are annotation. */
  readonly shape: "pin" | "cloud" | "arrow" | "rectangle" | "ellipse" | "freehand" | "text" | "measure";
  readonly stroke?: string;
  readonly fill?: string;
  /** Millimetres on paper, consistent with the drawing model's line weights. */
  readonly weight?: number;
  /**
   * What applying this tool puts on the topic it creates.
   *
   * The reason Tool Sets are worth having. Without this a tool is a coloured shape; with it, one click produces a
   * correctly typed, labelled, routed issue — and a practice's conventions become impossible to get wrong rather
   * than merely written down.
   */
  readonly topicDefaults?: {
    readonly type?: TopicType;
    readonly priority?: TopicPriority;
    readonly labels?: readonly string[];
    readonly assignedTo?: string;
    readonly titleTemplate?: string;
  };
}

export interface ToolSet {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** Who published it, so an inherited set says where a practice's standard came from. */
  readonly author?: string;
  readonly tools: readonly MarkupTool[];
}

/**
 * The default set: the markups a reviewer reaches for on any project.
 *
 * Deliberately small. A default palette of forty tools is one nobody reads; six that each do something a reviewer
 * recognises is one they will extend rather than replace.
 */
export const DEFAULT_TOOLSET: ToolSet = {
  id: "massingviewer.default",
  name: "Review",
  description: "The markups every project needs, each one producing a correctly typed issue.",
  tools: [
    {
      id: "issue",
      label: "Issue",
      glyph: "!",
      shape: "pin",
      stroke: "#cc2200",
      topicDefaults: { type: "Issue", priority: "Normal" },
    },
    {
      id: "rfi",
      label: "RFI",
      glyph: "?",
      shape: "pin",
      stroke: "#0055aa",
      topicDefaults: { type: "Inquiry", priority: "High", labels: ["RFI"], titleTemplate: "RFI: " },
    },
    {
      id: "clash",
      label: "Clash",
      glyph: "×",
      shape: "cloud",
      stroke: "#cc00aa",
      weight: 0.5,
      topicDefaults: { type: "Clash", priority: "High", labels: ["Coordination"] },
    },
    {
      id: "revision",
      label: "Revision cloud",
      glyph: "◌",
      shape: "cloud",
      stroke: "#cc7700",
      weight: 0.35,
      topicDefaults: { type: "Request", labels: ["Revision"] },
    },
    {
      id: "note",
      label: "Note",
      glyph: "T",
      shape: "text",
      stroke: "#111111",
      topicDefaults: { type: "Remark", priority: "Low" },
    },
    {
      id: "dimension-query",
      label: "Check dimension",
      glyph: "↔",
      shape: "measure",
      stroke: "#0055aa",
      topicDefaults: { type: "Inquiry", labels: ["Dimension"] },
    },
  ],
};

/**
 * Parse a Tool Set from JSON, refusing anything malformed.
 *
 * Validated rather than trusted because Tool Sets are *shared files* — the whole point is that they travel between
 * practices and projects. A set with a tool missing its shape would otherwise fail at click time, in front of a
 * reviewer, with no indication that the file they inherited is the problem.
 */
export function parseToolSet(json: unknown): ToolSet {
  if (typeof json !== "object" || json === null) throw new TypeError("a tool set is a JSON object");
  const raw = json as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id === "") throw new TypeError("a tool set needs an id");
  if (typeof raw.name !== "string" || raw.name === "") throw new TypeError("a tool set needs a name");
  if (!Array.isArray(raw.tools)) throw new TypeError(`tool set "${raw.name}" has no tools array`);

  const shapes = new Set(["pin", "cloud", "arrow", "rectangle", "ellipse", "freehand", "text", "measure"]);
  const seen = new Set<string>();
  const tools = raw.tools.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) throw new TypeError(`tool ${i} is not an object`);
    const tool = entry as Record<string, unknown>;
    if (typeof tool.id !== "string" || tool.id === "") throw new TypeError(`tool ${i} needs an id`);
    if (seen.has(tool.id)) throw new TypeError(`tool set "${raw.name}" has two tools with id "${tool.id}"`);
    seen.add(tool.id);
    if (typeof tool.label !== "string" || tool.label === "") throw new TypeError(`tool "${tool.id}" needs a label`);
    if (typeof tool.shape !== "string" || !shapes.has(tool.shape)) {
      throw new TypeError(
        `tool "${tool.id}" has shape ${JSON.stringify(tool.shape)}; expected one of ${[...shapes].join(", ")}`,
      );
    }
    return tool as unknown as MarkupTool;
  });

  return {
    id: raw.id,
    name: raw.name,
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(typeof raw.author === "string" ? { author: raw.author } : {}),
    tools,
  };
}

export function toolSetToJson(set: ToolSet): string {
  // Two-space indent and a trailing newline: a Tool Set is a shared file that lands in someone's version control,
  // and a single-line JSON blob produces a diff nobody can review.
  return `${JSON.stringify(set, null, 2)}\n`;
}
