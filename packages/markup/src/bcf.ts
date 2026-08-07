import type { Topic, Viewpoint } from "./topic.js";
import { makeZip, type ZipEntry } from "./zip.js";

/**
 * BCF 3.0 serialisation.
 *
 * A `.bcfzip` is a ZIP containing `bcf.version`, an optional `project.bcfp`, and one folder per topic named by its
 * GUID, each holding `markup.bcf`, zero or more `*.bcfv` viewpoints, and any snapshots. That layout is the whole
 * interop contract — Solibri, BIMcollab, Revizto, Navisworks and Bonsai all read it, and none of them read anyone's
 * proprietary issue format.
 *
 * ## Why the element references carry an IFC project GUID
 *
 * `<Component IfcGuid="...">` is what makes a topic resolvable in a *federated* model: without the owning
 * project, two disciplines' elements are indistinguishable, and a topic opened against the wrong model silently
 * anchors to nothing. BCF has the field; tools that skip it produce topics that work only in the authoring
 * session.
 */

const BCF_VERSION = "3.0";

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** An element, only when the value is present — BCF rejects an empty required-if-present element. */
function tag(name: string, value: string | undefined, indent: string): string {
  return value === undefined || value === "" ? "" : `${indent}<${name}>${xml(value)}</${name}>\n`;
}

export interface BcfProject {
  /** A canonical UUID, not an IFC GlobalId. */
  readonly guid: string;
  readonly name: string;
}

export interface BcfExportOptions {
  readonly project?: BcfProject;
  /**
   * The IFC project GUID topics are anchored within.
   *
   * Optional because a single-model session does not need it, and stamping a wrong one is worse than omitting it:
   * a reader that trusts it will look for the elements in a project that does not exist.
   */
  readonly ifcProject?: string;
  readonly author?: string;
}

function viewpointXml(viewpoint: Viewpoint, ifcProject: string | undefined): string {
  const camera = viewpoint.camera;
  const [px, py, pz] = camera.position;
  const [dx, dy, dz] = camera.direction;
  const [ux, uy, uz] = camera.up;
  const cameraTag = camera.kind === "perspective" ? "PerspectiveCamera" : "OrthogonalCamera";
  const valueTag =
    camera.kind === "perspective"
      ? `      <FieldOfView>${camera.value}</FieldOfView>\n`
      : `      <ViewToWorldScale>${camera.value}</ViewToWorldScale>\n`;

  const component = (guid: string): string =>
    ifcProject === undefined
      ? `        <Component IfcGuid="${xml(guid)}" />\n`
      : `        <Component IfcGuid="${xml(guid)}" OriginatingSystem="MassingViewer" AuthoringToolId="${xml(ifcProject)}" />\n`;

  const selection =
    (viewpoint.selection ?? []).length === 0
      ? ""
      : `      <Selection>\n${viewpoint.selection!.map(component).join("")}      </Selection>\n`;
  const visibility =
    (viewpoint.hidden ?? []).length === 0
      ? ""
      : `      <Visibility DefaultVisibility="true">\n        <Exceptions>\n${viewpoint.hidden!
          .map((g) => `    ${component(g)}`)
          .join("")}        </Exceptions>\n      </Visibility>\n`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<VisualizationInfo Guid="${xml(viewpoint.guid)}">
${selection || visibility ? `  <Components>\n${selection}${visibility}  </Components>\n` : ""}  <${cameraTag}>
    <CameraViewPoint>
      <X>${px}</X>
      <Y>${py}</Y>
      <Z>${pz}</Z>
    </CameraViewPoint>
    <CameraDirection>
      <X>${dx}</X>
      <Y>${dy}</Y>
      <Z>${dz}</Z>
    </CameraDirection>
    <CameraUpVector>
      <X>${ux}</X>
      <Y>${uy}</Y>
      <Z>${uz}</Z>
    </CameraUpVector>
${valueTag}  </${cameraTag}>
</VisualizationInfo>
`;
}

function markupXml(topic: Topic, ifcProject: string | undefined): string {
  const labels = topic.labels.map((l) => `    <Labels>${xml(l)}</Labels>\n`).join("");
  const related = topic.relatedTopics.map((g) => `    <RelatedTopic Guid="${xml(g)}" />\n`).join("");

  const comments = topic.comments
    .map(
      (c) =>
        `  <Comment Guid="${xml(c.guid)}">\n` +
        `    <Date>${xml(c.date)}</Date>\n` +
        `    <Author>${xml(c.author)}</Author>\n` +
        `    <Comment>${xml(c.comment)}</Comment>\n` +
        (c.modifiedDate === undefined ? "" : `    <ModifiedDate>${xml(c.modifiedDate)}</ModifiedDate>\n`) +
        (c.modifiedAuthor === undefined ? "" : `    <ModifiedAuthor>${xml(c.modifiedAuthor)}</ModifiedAuthor>\n`) +
        (c.viewpointGuid === undefined ? "" : `    <Viewpoint Guid="${xml(c.viewpointGuid)}" />\n`) +
        `  </Comment>\n`,
    )
    .join("");

  const viewpoints = topic.viewpoints
    .map(
      (v) =>
        `  <Viewpoints Guid="${xml(v.guid)}">\n` +
        `    <Viewpoint>${xml(v.guid)}.bcfv</Viewpoint>\n` +
        (v.snapshotPng === undefined ? "" : `    <Snapshot>${xml(v.guid)}.png</Snapshot>\n`) +
        `  </Viewpoints>\n`,
    )
    .join("");

  // The pin is written as a topic-level reference so a reader that does not understand our drawing coordinates
  // still learns which elements the topic is about — which is the entire point of anchoring to GlobalIds.
  const pinComponents =
    topic.pin === undefined || topic.pin.guids.length === 0
      ? ""
      : `  <BimSnippet SnippetType="MassingViewerPin">\n` +
        `    <Reference>${xml(topic.pin.guids.join(" "))}</Reference>\n` +
        `    <ReferenceSchema>urn:massingviewer:pin:1</ReferenceSchema>\n` +
        `  </BimSnippet>\n`;

  void ifcProject;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Markup>
  <Topic Guid="${xml(topic.guid)}" TopicType="${xml(topic.type)}" TopicStatus="${xml(topic.status)}">
    <Title>${xml(topic.title)}</Title>
${tag("Priority", topic.priority, "    ")}${tag("CreationDate", topic.creationDate, "    ")}${tag(
    "CreationAuthor",
    topic.creationAuthor,
    "    ",
  )}${tag("ModifiedDate", topic.modifiedDate, "    ")}${tag("ModifiedAuthor", topic.modifiedAuthor, "    ")}${tag(
    "DueDate",
    topic.dueDate,
    "    ",
  )}${tag("AssignedTo", topic.assignedTo, "    ")}${tag("Description", topic.description, "    ")}${labels}${related}  </Topic>
${pinComponents}${comments}${viewpoints}</Markup>
`;
}

/**
 * Write a `.bcfzip`.
 *
 * Bytes are deterministic for the same input — no clock, no random ordering — because a BCF export that differs
 * every run cannot be a fixture, cannot be diffed, and cannot be compared between two states of a model. Real
 * timestamps live in the topics, where a reader looks for them.
 */
export function toBcfZip(topics: readonly Topic[], options: BcfExportOptions = {}): Uint8Array {
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [];

  entries.push({
    path: "bcf.version",
    bytes: encoder.encode(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Version VersionId="${BCF_VERSION}" />\n`,
    ),
  });

  if (options.project !== undefined) {
    entries.push({
      path: "project.bcfp",
      bytes: encoder.encode(
        `<?xml version="1.0" encoding="UTF-8"?>\n<ProjectInfo>\n  <Project ProjectId="${xml(
          options.project.guid,
        )}">\n    <Name>${xml(options.project.name)}</Name>\n  </Project>\n</ProjectInfo>\n`,
      ),
    });
  }

  for (const topic of topics) {
    entries.push({
      path: `${topic.guid}/markup.bcf`,
      bytes: encoder.encode(markupXml(topic, options.ifcProject)),
    });
    for (const viewpoint of topic.viewpoints) {
      entries.push({
        path: `${topic.guid}/${viewpoint.guid}.bcfv`,
        bytes: encoder.encode(viewpointXml(viewpoint, options.ifcProject)),
      });
      if (viewpoint.snapshotPng !== undefined) {
        entries.push({ path: `${topic.guid}/${viewpoint.guid}.png`, bytes: viewpoint.snapshotPng });
      }
    }
  }

  return makeZip(entries);
}

/** The files a `.bcfzip` would contain, without building it — for a preview, and for testing the layout. */
export function bcfManifest(topics: readonly Topic[], options: BcfExportOptions = {}): readonly string[] {
  const paths = ["bcf.version"];
  if (options.project !== undefined) paths.push("project.bcfp");
  for (const topic of topics) {
    paths.push(`${topic.guid}/markup.bcf`);
    for (const viewpoint of topic.viewpoints) {
      paths.push(`${topic.guid}/${viewpoint.guid}.bcfv`);
      if (viewpoint.snapshotPng !== undefined) paths.push(`${topic.guid}/${viewpoint.guid}.png`);
    }
  }
  return paths;
}
