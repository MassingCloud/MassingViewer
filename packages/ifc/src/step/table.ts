import { type Guid, isGuid } from "@massingviewer/core";
import { type RawEntity, StepSyntaxError, parseParams, scanEntities } from "./parse.js";
import { type StepValue, formatParams } from "./value.js";

/**
 * The authoritative store for an IFC file being edited.
 *
 * ## Why this is a patch list and not a document model
 *
 * `docs/adr/0008-local-kernel-geometry-stack.md` decides it, and the reasoning is worth restating where the
 * code is: **an editor that round-trips through its own reduced model is a data-destroying editor.** A
 * structural consultant's IFC carries analytical members and load cases we have no concept for; an MEP file
 * carries distribution systems and flow segments. Parsing into a model of the things we understand and
 * re-serialising from it deletes the rest — and the file still *looks* fine.
 *
 * So this class never rebuilds the file. It holds the original text plus a sorted list of patches, and
 * {@link emit} applies them. An entity nobody touched is emitted by copying its original bytes. Preservation
 * is therefore a property of the data structure, not a promise a serialiser has to keep, and
 * `parse(x).emit() === x` is true by construction rather than by test — though it is tested anyway, because
 * "by construction" claims are exactly the ones worth checking.
 *
 * ## Identity
 *
 * `expressID` is a file artefact: it changes when a file is rewritten. `GlobalId` is the only identifier safe
 * to persist, and this class never derives one from the other. An imported element keeps the GlobalId its file
 * gave it, verbatim; a created element is given one by the caller. See `@massingviewer/core`'s identity module
 * for why the two are separate types.
 */
export class EntityTable {
  /** Original file text. Never mutated. */
  readonly source: string;
  /** Declared schema, e.g. `IFC4`. Null when the header does not say. */
  readonly schema: string | null;

  private readonly byId = new Map<number, RawEntity>();
  private readonly order: number[] = [];
  private readonly typeIndex = new Map<string, number[]>();
  /** Lazily parsed attribute lists, and edited ones. */
  private readonly paramCache = new Map<number, StepValue[]>();
  /** id → replacement statement text, or null for a deletion. */
  private readonly edits = new Map<number, string | null>();
  /** Appended entities, in creation order. */
  private readonly appended: { id: number; text: string }[] = [];
  private readonly dataEnd: number;
  private nextId: number;

  private constructor(source: string, scan: ReturnType<typeof scanEntities>) {
    this.source = source;
    this.schema = scan.schema;
    this.dataEnd = scan.dataEnd;

    let max = 0;
    for (const e of scan.entities) {
      if (this.byId.has(e.id)) {
        // A duplicate id means two entities claim the same identity and every reference to it is ambiguous.
        // Silently keeping the last one is how a viewer ends up drawing a wall that the schedule says is a
        // door — so this refuses the file instead.
        throw new StepSyntaxError(`#${e.id} is defined more than once`, e.start);
      }
      this.byId.set(e.id, e);
      this.order.push(e.id);
      if (e.type !== "") {
        const bucket = this.typeIndex.get(e.type);
        if (bucket) bucket.push(e.id);
        else this.typeIndex.set(e.type, [e.id]);
      }
      if (e.id > max) max = e.id;
    }
    this.nextId = max + 1;
  }

  static parse(source: string): EntityTable {
    return new EntityTable(source, scanEntities(source));
  }

  get size(): number {
    return this.ids().length;
  }

  /** True once anything has been changed. `emit()` on a clean table returns the source byte-for-byte. */
  get dirty(): boolean {
    return this.edits.size > 0 || this.appended.length > 0;
  }

  /** Live ids in file order, with appended entities last. Deleted ids are absent. */
  ids(): number[] {
    const out = this.order.filter((id) => this.edits.get(id) !== null);
    for (const a of this.appended) out.push(a.id);
    return out;
  }

  has(id: number): boolean {
    return this.edits.get(id) === null ? false : this.byId.has(id) || this.appended.some((a) => a.id === id);
  }

  /** Uppercase IFC class, or undefined for an unknown or deleted id. */
  typeOf(id: number): string | undefined {
    if (this.edits.get(id) === null) return undefined;
    const cached = this.editedTypes.get(id);
    if (cached !== undefined) return cached;
    return this.byId.get(id)?.type;
  }

  private readonly editedTypes = new Map<number, string>();

  /**
   * Ids of every entity of a type. Exact class only — no subtype expansion, because this layer has no schema
   * and guessing that `IFCWALLSTANDARDCASE` is an `IFCWALL` belongs in a layer that actually knows.
   */
  byType(type: string): readonly number[] {
    const upper = type.toUpperCase();
    // The prebuilt index still applies to existing entities because an edit never changes an entity's type —
    // `setParams` keeps it, and a type change is a remove plus an add. So only deletions need filtering out.
    const existing = (this.typeIndex.get(upper) ?? []).filter((id) => this.edits.get(id) !== null);
    const added = this.appended.filter((a) => this.editedTypes.get(a.id) === upper).map((a) => a.id);
    return [...existing, ...added];
  }

  /**
   * Attribute list, parsed on first access and cached.
   *
   * Returns a frozen array: handing out a mutable view of the cache would let a caller change attributes
   * without going through {@link setParams}, and then `emit()` would write the *original* text while every
   * reader saw the edited values — a divergence with no symptom until export.
   */
  params(id: number): readonly StepValue[] {
    const cached = this.paramCache.get(id);
    if (cached) return cached;
    const raw = this.byId.get(id);
    if (!raw || this.edits.get(id) === null) {
      throw new RangeError(`#${id} is not in this table`);
    }
    if (raw.paramsAt < 0) throw new RangeError(`#${id} is a complex instance and has no attribute list`);
    const parsed = Object.freeze(parseParams(this.source, raw.paramsAt));
    this.paramCache.set(id, parsed as StepValue[]);
    return parsed;
  }

  /**
   * The GlobalId of a rooted entity, or null.
   *
   * Every `IfcRoot` subtype carries GlobalId as its first attribute, which is why this can be schema-free.
   * The length-and-alphabet check is the load-bearing part: a file that puts something else in attribute 0
   * must yield null rather than a 34-character "GlobalId" that then fails to match anything, forever, with no
   * error. See the identity notes in `@massingviewer/core`.
   */
  guidOf(id: number): Guid | null {
    let first: StepValue | undefined;
    try {
      first = this.params(id)[0];
    } catch {
      return null;
    }
    if (first?.k !== "str") return null;
    return isGuid(first.v) ? first.v : null;
  }

  /** Reverse index from GlobalId to expressID, built on first use. */
  private guidIndex: Map<string, number> | null = null;

  idOfGuid(guid: string): number | undefined {
    if (this.guidIndex === null) {
      this.guidIndex = new Map();
      for (const id of this.ids()) {
        const g = this.guidOf(id);
        if (g !== null) this.guidIndex.set(g, id);
      }
    }
    return this.guidIndex.get(guid);
  }

  // -------------------------------------------------------------------------------------------------
  // Edits
  // -------------------------------------------------------------------------------------------------

  /**
   * Replace an entity's attributes, keeping its id and type.
   *
   * The whole statement is re-emitted from `params`, so any formatting inside *this* entity is normalised.
   * That is the intended scope of the damage: you edited this wall, so this wall's line is rewritten, and
   * nothing else in the file moves.
   */
  setParams(id: number, params: readonly StepValue[]): void {
    const type = this.typeOf(id);
    if (type === undefined) throw new RangeError(`#${id} is not in this table`);
    if (type === "") throw new RangeError(`#${id} is a complex instance and cannot be edited attribute-wise`);
    const next = Object.freeze([...params]) as StepValue[];
    this.paramCache.set(id, next);
    this.writeStatement(id, type, next);
  }

  /** Replace one attribute. Convenience over {@link setParams}, and the common case. */
  setParam(id: number, index: number, value: StepValue): void {
    const params = [...this.params(id)];
    if (index < 0 || index >= params.length) {
      throw new RangeError(`#${id} (${this.typeOf(id)}) has ${params.length} attributes; no index ${index}`);
    }
    params[index] = value;
    this.setParams(id, params);
  }

  /**
   * Append a new entity. Returns its expressID.
   *
   * The id is `max(existing) + 1` and counts up from there, including over ids freed by {@link remove} — a
   * reused id would be indistinguishable from the removed entity to anything holding a stale reference, and
   * stale references are the normal state of affairs in an undo stack.
   */
  add(type: string, params: readonly StepValue[]): number {
    const id = this.nextId++;
    const upper = type.toUpperCase();
    this.paramCache.set(id, Object.freeze([...params]) as StepValue[]);
    this.editedTypes.set(id, upper);
    this.appended.push({ id, text: statement(id, upper, params) });
    this.guidIndex = null;
    return id;
  }

  /**
   * Remove an entity.
   *
   * **Does not chase references.** An `IfcWall` referenced by an `IfcRelContainedInSpatialStructure` leaves a
   * dangling `#id` behind, and that is a broken file. Reference repair needs schema knowledge this layer does
   * not have, so it belongs one level up in the kernel, where "delete a wall" means "delete the wall, its
   * placement, its representation, and unlink it from its storey". Making the low-level operation obviously
   * incomplete is better than making it quietly wrong.
   */
  remove(id: number): void {
    if (!this.has(id)) throw new RangeError(`#${id} is not in this table`);
    const appendedAt = this.appended.findIndex((a) => a.id === id);
    if (appendedAt >= 0) {
      this.appended.splice(appendedAt, 1);
    } else {
      this.edits.set(id, null);
    }
    this.paramCache.delete(id);
    this.guidIndex = null;
  }

  private writeStatement(id: number, type: string, params: readonly StepValue[]): void {
    const text = statement(id, type, params);
    const appended = this.appended.find((a) => a.id === id);
    if (appended) appended.text = text;
    else this.edits.set(id, text);
    this.editedTypes.set(id, type);
    this.guidIndex = null;
  }

  // -------------------------------------------------------------------------------------------------
  // Emit
  // -------------------------------------------------------------------------------------------------

  /**
   * Serialise. On a clean table this returns {@link source} unchanged, character for character.
   *
   * Note what is *not* here: no header rewriting, no re-numbering, no reordering, no reformatting of
   * untouched entities. A diff between input and output shows exactly the entities that were edited, which
   * makes an export reviewable — and an export nobody can review is one nobody can trust with a file they
   * did not create.
   */
  emit(): string {
    if (!this.dirty) return this.source;

    const out: string[] = [];
    let cursor = 0;

    for (const id of this.order) {
      const edit = this.edits.get(id);
      if (edit === undefined) continue;
      const raw = this.byId.get(id)!;
      out.push(this.source.slice(cursor, raw.start));
      if (edit !== null) out.push(edit);
      cursor = raw.end;
      if (edit === null) {
        // Consume the line break the removed statement occupied, so a deletion does not leave a blank line.
        if (this.source.startsWith("\r\n", cursor)) cursor += 2;
        else if (this.source[cursor] === "\n") cursor += 1;
      }
    }

    if (this.appended.length > 0) {
      if (this.dataEnd < 0) {
        throw new Error(
          "cannot append entities: this file has no DATA section, so there is nowhere valid to put them",
        );
      }
      out.push(this.source.slice(cursor, this.dataEnd));
      for (const a of this.appended) out.push(`${a.text}\n`);
      cursor = this.dataEnd;
    }

    out.push(this.source.slice(cursor));
    return out.join("");
  }
}

function statement(id: number, type: string, params: readonly StepValue[]): string {
  return `#${id}=${type}(${formatParams(params)});`;
}
