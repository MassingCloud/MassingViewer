import type { Guid } from "@massingviewer/core";

/**
 * The markup model, shaped as BCF 3.0 from the start.
 *
 * ## Why BCF is the internal model and not an export format
 *
 * Every tool in this space has its own issue model and a BCF *exporter*, and the exporter always loses something —
 * because the internal model has fields BCF cannot express and lacks fields BCF requires. The result is a
 * round trip that degrades, so people stop using it, so the interop that BCF exists to provide never happens.
 *
 * Modelling BCF directly costs a little expressiveness and buys the thing that matters: a topic here opens in
 * Solibri, BIMcollab, Revizto, Navisworks and Bonsai without a bridge, and comes back unchanged.
 *
 * ## The anchoring decision
 *
 * A markup anchors to an **IFC GlobalId**, not to a page coordinate. That is the difference between this and every
 * PDF-based review tool: their markup is a shape on a flattened raster that has forgotten which wall it is about,
 * so it cannot follow the model, cannot be filtered by element, and cannot be answered by changing the model.
 *
 * The drawing-space point is kept too, but as a *fallback with a stated reason* — see {@link Pin}.
 */

export type TopicStatus = "Open" | "In Progress" | "Closed" | "ReOpened";

/** BCF's own priority vocabulary. A closed set, because a free-text priority cannot be sorted or filtered. */
export type TopicPriority = "Low" | "Normal" | "High" | "Critical";

export type TopicType = "Issue" | "Clash" | "Request" | "Remark" | "Fault" | "Inquiry";

/**
 * Where a markup lives.
 *
 * `guids` is the anchor and is plural on purpose: an issue is frequently *about* a relationship — this beam
 * clashes with that duct, this door does not suit that wall. Forcing one element per topic makes a reviewer
 * either split the issue in two or drop half the information.
 *
 * `at` is drawing-space metres, used to place the pin visually. It is **not** the anchor. When the elements are
 * present the pin can be re-derived from them; when they are not, `at` is all that remains, and
 * {@link resolveAnchor} says so rather than pretending the anchor still works.
 */
export interface Pin {
  readonly guids: readonly Guid[];
  /** Drawing-space position in metres, for placement. Never the identity. */
  readonly at: { readonly x: number; readonly y: number };
  /** Which drawing this pin was placed on, so it is not shown on an unrelated sheet. */
  readonly drawing?: string;
}

export interface Comment {
  readonly guid: string;
  readonly date: string;
  readonly author: string;
  readonly comment: string;
  /** BCF allows editing a comment; both dates are kept because "changed after the reply" is often the point. */
  readonly modifiedDate?: string;
  readonly modifiedAuthor?: string;
  readonly viewpointGuid?: string;
}

/**
 * A camera and visibility state, so "look at what I was looking at" works.
 *
 * `selection` and `visible` carry GlobalIds rather than a screenshot, which is what makes a viewpoint *actionable*
 * — a reviewer opens it and the model is in the state the author described, rather than seeing a picture of it.
 */
export interface Viewpoint {
  readonly guid: string;
  readonly camera: {
    readonly kind: "perspective" | "orthogonal";
    readonly position: readonly [number, number, number];
    readonly direction: readonly [number, number, number];
    readonly up: readonly [number, number, number];
    /** Field of view in degrees for perspective; view-to-world scale for orthogonal. */
    readonly value: number;
  };
  readonly selection?: readonly Guid[];
  /** Explicitly hidden elements. Empty means "default visibility", which is not the same as "nothing hidden". */
  readonly hidden?: readonly Guid[];
  readonly snapshotPng?: Uint8Array;
}

export interface Topic {
  readonly guid: string;
  readonly type: TopicType;
  readonly status: TopicStatus;
  readonly priority: TopicPriority;
  readonly title: string;
  readonly creationDate: string;
  readonly creationAuthor: string;
  readonly modifiedDate?: string;
  readonly modifiedAuthor?: string;
  readonly assignedTo?: string;
  readonly dueDate?: string;
  readonly description?: string;
  readonly labels: readonly string[];
  readonly comments: readonly Comment[];
  readonly viewpoints: readonly Viewpoint[];
  /** Where this was raised. Absent for a topic raised in 3D with no drawing open. */
  readonly pin?: Pin;
  /** Topics this one relates to, by guid — BCF's own mechanism for duplicates and follow-ups. */
  readonly relatedTopics: readonly string[];
}

// ---------------------------------------------------------------------------------------------------
// Anchoring
// ---------------------------------------------------------------------------------------------------

/**
 * What became of a markup's anchor when the model changed.
 *
 * Three outcomes, and the third is the one every other tool gets wrong by not having it:
 *
 * - `resolved` — every element is still present. The markup is fully live.
 * - `partial` — some elements are gone. The markup still means something, and *which* part was lost is stated.
 * - `orphaned` — none are present. The pin can still be drawn at `at`, but it no longer refers to anything, and
 *   showing it as though it does is worse than showing it as orphaned. An issue silently pointing at deleted
 *   geometry is how a resolved-looking issue log hides real work.
 */
export type AnchorOutcome =
  | { readonly kind: "resolved"; readonly guids: readonly Guid[] }
  | { readonly kind: "partial"; readonly present: readonly Guid[]; readonly missing: readonly Guid[] }
  | { readonly kind: "orphaned"; readonly missing: readonly Guid[]; readonly reason: string };

/**
 * Resolve a pin against the elements a model currently contains.
 *
 * Takes a predicate rather than a model, so this stays a pure function testable without a kernel — and so a
 * caller can resolve against a federated set, a filtered view, or a historical version without this package
 * needing to know those exist.
 */
export function resolveAnchor(pin: Pin, exists: (guid: Guid) => boolean): AnchorOutcome {
  if (pin.guids.length === 0) {
    return {
      kind: "orphaned",
      missing: [],
      reason: "this markup was never anchored to an element — it has only a position",
    };
  }
  const present = pin.guids.filter((g) => exists(g));
  const missing = pin.guids.filter((g) => !exists(g));
  if (missing.length === 0) return { kind: "resolved", guids: present };
  if (present.length === 0) {
    return {
      kind: "orphaned",
      missing,
      reason:
        missing.length === 1
          ? `the element this refers to (${missing[0]}) is no longer in the model`
          : `none of the ${missing.length} elements this refers to are still in the model`,
    };
  }
  return { kind: "partial", present, missing };
}

/** True when the markup still refers to something. `partial` counts — half an issue is still an issue. */
export function isLive(outcome: AnchorOutcome): boolean {
  return outcome.kind !== "orphaned";
}

// ---------------------------------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------------------------------

let counter = 0;

/**
 * A GUID for a topic, comment or viewpoint.
 *
 * BCF wants a canonical 36-character UUID here, **not** the 22-character compressed form IFC uses. Emitting an
 * IFC GlobalId where BCF expects a UUID is a mistake that validates against nothing and is rejected by strict
 * readers — the two identifier formats sit side by side in this file and are easy to confuse.
 */
export function newBcfGuid(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const b = new Uint8Array(16);
    globalThis.crypto.getRandomValues(b);
    b[6] = (b[6]! & 0x0f) | 0x40;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const hex = [...b].map((n) => n.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // No cryptographic source. A BCF guid collision merges two issues, which is bad but recoverable by a human —
  // unlike an IFC GlobalId collision, which merges two *elements* everywhere downstream. So this degrades with a
  // counter rather than refusing, and the counter is visible in the value so the degradation is not silent.
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
}

export interface NewTopicInput {
  readonly title: string;
  readonly author: string;
  /** ISO 8601. Passed in rather than read from the clock, so exports are reproducible and testable. */
  readonly date: string;
  readonly type?: TopicType;
  readonly priority?: TopicPriority;
  readonly status?: TopicStatus;
  readonly description?: string;
  readonly assignedTo?: string;
  readonly labels?: readonly string[];
  readonly pin?: Pin;
  readonly guid?: string;
}

export function createTopic(input: NewTopicInput): Topic {
  if (input.title.trim() === "") {
    // A titleless topic is unreadable in every issue list, and BCF requires the element. Refusing at creation is
    // better than exporting something a reviewer cannot identify.
    throw new RangeError("a topic needs a title");
  }
  return {
    guid: input.guid ?? newBcfGuid(),
    type: input.type ?? "Issue",
    status: input.status ?? "Open",
    priority: input.priority ?? "Normal",
    title: input.title,
    creationDate: input.date,
    creationAuthor: input.author,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.assignedTo === undefined ? {} : { assignedTo: input.assignedTo }),
    labels: input.labels ?? [],
    comments: [],
    viewpoints: [],
    ...(input.pin === undefined ? {} : { pin: input.pin }),
    relatedTopics: [],
  };
}

/** Add a comment, returning a new topic. Immutable so a command bus can invert the operation. */
export function addComment(
  topic: Topic,
  input: { author: string; date: string; comment: string; viewpointGuid?: string; guid?: string },
): Topic {
  if (input.comment.trim() === "") throw new RangeError("a comment needs text");
  return {
    ...topic,
    modifiedDate: input.date,
    modifiedAuthor: input.author,
    comments: [
      ...topic.comments,
      {
        guid: input.guid ?? newBcfGuid(),
        date: input.date,
        author: input.author,
        comment: input.comment,
        ...(input.viewpointGuid === undefined ? {} : { viewpointGuid: input.viewpointGuid }),
      },
    ],
  };
}

/**
 * Change status, recording who and when.
 *
 * Rejects a no-op transition. "Closed → Closed" adds a modification date and no information, and an audit trail
 * full of them is one nobody reads.
 */
export function setStatus(topic: Topic, status: TopicStatus, author: string, date: string): Topic {
  if (topic.status === status) return topic;
  return { ...topic, status, modifiedDate: date, modifiedAuthor: author };
}

export function addViewpoint(topic: Topic, viewpoint: Viewpoint): Topic {
  return { ...topic, viewpoints: [...topic.viewpoints, viewpoint] };
}

/** Every element any topic in the set refers to — what the 3D side needs in order to badge the model. */
export function anchoredGuids(topics: readonly Topic[]): readonly Guid[] {
  const seen = new Set<Guid>();
  for (const topic of topics) {
    for (const guid of topic.pin?.guids ?? []) seen.add(guid);
    for (const viewpoint of topic.viewpoints) {
      for (const guid of viewpoint.selection ?? []) seen.add(guid);
    }
  }
  return [...seen];
}
