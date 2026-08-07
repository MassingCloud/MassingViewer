import { type StepValue, unquote } from "./value";

/**
 * A located entity instance: `#42=IFCWALL(...);`
 *
 * The offsets are the point of this type. They are what makes byte-preserving emit possible — an entity
 * nobody edited is re-emitted by copying `source.slice(start, end)`, so preservation is a property of the
 * data structure rather than of a serialiser someone has to keep faithful.
 */
export interface RawEntity {
  readonly id: number;
  /** Uppercase IFC class, e.g. `IFCWALL`. Empty for a complex instance (`#1=(A(…)B(…));`). */
  readonly type: string;
  /** Offset of the `#`. */
  readonly start: number;
  /** Offset just past the terminating `;`. */
  readonly end: number;
  /** Offset of the `(` opening the attribute list, or -1 for a complex instance. */
  readonly paramsAt: number;
}

export interface ScanResult {
  readonly entities: readonly RawEntity[];
  /**
   * Offset of the `ENDSEC;` that closes the DATA section — where new entities are inserted.
   *
   * -1 when there is no DATA section, which means the file is a header-only stub or not STEP at all. The
   * caller decides what to do about that; this scanner does not guess.
   */
  readonly dataEnd: number;
  readonly schema: string | null;
}

const WS = new Set([" ", "\t", "\r", "\n"]);

/** Advance past whitespace and `/* … *\/` comments. */
function skipTrivia(s: string, i: number): number {
  for (;;) {
    while (i < s.length && WS.has(s[i]!)) i++;
    if (s[i] === "/" && s[i + 1] === "*") {
      const close = s.indexOf("*/", i + 2);
      // An unterminated comment swallows the rest of the file. Reporting that as "no entities found" would
      // send someone hunting for a parser bug, so it is an explicit error at the call site instead.
      if (close === -1) throw new StepSyntaxError("unterminated /* comment", i);
      i = close + 2;
      continue;
    }
    return i;
  }
}

export class StepSyntaxError extends Error {
  constructor(
    message: string,
    readonly at: number,
  ) {
    super(`${message} (at offset ${at})`);
    this.name = "StepSyntaxError";
  }
}

/**
 * Find every entity instance, the DATA section's end, and the declared schema.
 *
 * One pass, no regex over the whole file: a `;` inside a string literal is common in STEP headers
 * (`FILE_DESCRIPTION((''),'2;1')`) and a line-oriented scan splits the file in the wrong place. Strings and
 * comments are skipped structurally so that cannot happen.
 */
export function scanEntities(source: string): ScanResult {
  const entities: RawEntity[] = [];
  let dataEnd = -1;
  let schema: string | null = null;
  let i = 0;
  let inData = false;

  while (i < source.length) {
    i = skipTrivia(source, i);
    if (i >= source.length) break;
    const ch = source[i]!;

    if (ch === "#") {
      const entity = readEntity(source, i);
      entities.push(entity);
      i = entity.end;
      continue;
    }

    // A keyword-or-simple statement: read to its terminating `;`, skipping strings and comments. This covers
    // ISO-10303-21;, HEADER;, DATA;, ENDSEC;, END-ISO-10303-21;, and every header entity.
    const stmtStart = i;
    i = readToSemicolon(source, i);
    const stmt = source.slice(stmtStart, i - 1).trim();

    if (stmt === "DATA" || stmt.startsWith("DATA(")) {
      inData = true;
    } else if (stmt === "ENDSEC") {
      if (inData) dataEnd = stmtStart;
      inData = false;
    } else if (stmt.startsWith("FILE_SCHEMA")) {
      // FILE_SCHEMA(('IFC4')) — the first string is the schema name.
      const m = /'([^']*)'/.exec(stmt);
      if (m) schema = m[1]!;
    }
  }

  return { entities, dataEnd, schema };
}

/** Read from `i` (at a `#`) through the terminating `;`. */
function readEntity(source: string, i: number): RawEntity {
  const start = i;
  i++; // '#'
  const digitsAt = i;
  while (i < source.length && source[i]! >= "0" && source[i]! <= "9") i++;
  if (i === digitsAt) throw new StepSyntaxError("expected an entity id after '#'", start);
  const id = Number(source.slice(digitsAt, i));

  i = skipTrivia(source, i);
  if (source[i] !== "=") throw new StepSyntaxError(`expected '=' after #${id}`, i);
  i = skipTrivia(source, i + 1);

  // A complex instance: `#1=(A(…)B(…));`. Nothing here understands them, and nothing needs to — they are
  // re-emitted from their source span like everything else. Recording them is what matters, because an id
  // this scanner does not know about is an id a later `add()` could collide with.
  if (source[i] === "(") {
    const end = readToSemicolon(source, i);
    return { id, type: "", start, end, paramsAt: -1 };
  }

  const nameAt = i;
  while (i < source.length && /[A-Za-z0-9_]/.test(source[i]!)) i++;
  if (i === nameAt) throw new StepSyntaxError(`expected a type name for #${id}`, i);
  const type = source.slice(nameAt, i).toUpperCase();

  i = skipTrivia(source, i);
  if (source[i] !== "(") throw new StepSyntaxError(`expected '(' after ${type}`, i);
  const paramsAt = i;
  const end = readToSemicolon(source, i);
  return { id, type, start, end, paramsAt };
}

/** Read to the next `;` at paren depth 0, honouring strings and comments. Returns the offset past it. */
function readToSemicolon(source: string, i: number): number {
  let depth = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "'") {
      i = skipString(source, i);
      continue;
    }
    if (ch === '"') {
      const close = source.indexOf('"', i + 1);
      if (close === -1) throw new StepSyntaxError("unterminated binary literal", i);
      i = close + 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i = skipTrivia(source, i);
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === ";" && depth <= 0) return i + 1;
    i++;
  }
  throw new StepSyntaxError("unterminated statement — no ';' before end of file", i);
}

/** `i` at the opening quote; returns the offset past the closing quote. `''` is an embedded quote. */
function skipString(source: string, i: number): number {
  i++;
  while (i < source.length) {
    if (source[i] === "'") {
      if (source[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  throw new StepSyntaxError("unterminated string literal", i);
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;

/**
 * Parse an attribute list. `at` must point at the opening `(`.
 *
 * Called lazily, per entity, only when something actually needs the attributes. On a 200 MB file the
 * difference between parsing every attribute list up front and parsing the few thousand that get touched is
 * the difference between a usable tool and a spinner.
 */
export function parseParams(source: string, at: number): StepValue[] {
  const [values, end] = parseListAt(source, at);
  void end;
  return values;
}

function parseListAt(source: string, at: number): [StepValue[], number] {
  if (source[at] !== "(") throw new StepSyntaxError("expected '('", at);
  let i = skipTrivia(source, at + 1);
  const out: StepValue[] = [];
  if (source[i] === ")") return [out, i + 1];

  for (;;) {
    const [value, next] = parseValue(source, i);
    out.push(value);
    i = skipTrivia(source, next);
    if (source[i] === ",") {
      i = skipTrivia(source, i + 1);
      continue;
    }
    if (source[i] === ")") return [out, i + 1];
    throw new StepSyntaxError(`expected ',' or ')' in attribute list, found ${JSON.stringify(source[i])}`, i);
  }
}

function parseValue(source: string, i: number): [StepValue, number] {
  i = skipTrivia(source, i);
  const ch = source[i];
  if (ch === undefined) throw new StepSyntaxError("expected a value, found end of file", i);

  if (ch === "$") return [{ k: "unset" }, i + 1];
  if (ch === "*") return [{ k: "derived" }, i + 1];

  if (ch === "#") {
    let j = i + 1;
    while (j < source.length && source[j]! >= "0" && source[j]! <= "9") j++;
    if (j === i + 1) throw new StepSyntaxError("expected digits after '#'", i);
    return [{ k: "ref", v: Number(source.slice(i + 1, j)) }, j];
  }

  if (ch === "'") {
    const end = skipString(source, i);
    return [{ k: "str", v: unquote(source.slice(i, end)) }, end];
  }

  if (ch === '"') {
    const close = source.indexOf('"', i + 1);
    if (close === -1) throw new StepSyntaxError("unterminated binary literal", i);
    return [{ k: "bin", v: source.slice(i + 1, close) }, close + 1];
  }

  if (ch === ".") {
    const close = source.indexOf(".", i + 1);
    if (close === -1) throw new StepSyntaxError("unterminated enumeration", i);
    return [{ k: "enum", v: source.slice(i + 1, close) }, close + 1];
  }

  if (ch === "(") {
    const [values, end] = parseListAt(source, i);
    return [{ k: "list", v: values }, end];
  }

  if (/[A-Za-z_]/.test(ch)) {
    let j = i;
    while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j++;
    const name = source.slice(i, j).toUpperCase();
    const k = skipTrivia(source, j);
    if (source[k] !== "(") throw new StepSyntaxError(`expected '(' after typed value ${name}`, k);
    const [values, end] = parseListAt(source, k);
    return [{ k: "typed", t: name, v: values }, end];
  }

  const m = NUMBER.exec(source.slice(i));
  if (m) {
    const raw = m[0];
    return [{ k: "num", v: Number(raw), raw }, i + raw.length];
  }

  throw new StepSyntaxError(`unrecognised value starting ${JSON.stringify(source.slice(i, i + 12))}`, i);
}
