/**
 * STEP (ISO-10303-21) attribute values.
 *
 * Deliberately close to the file's own grammar rather than to a friendly domain model. The reason is
 * `docs/adr/0008-local-kernel-geometry-stack.md`: this package's job is to let an editor change one entity
 * and leave every other byte alone. A representation that normalises — collapsing `3.` and `3.0`, or turning
 * an unset attribute into `undefined` — cannot re-emit what it read, and an editor that cannot re-emit what
 * it read silently rewrites files it does not understand.
 *
 * So numbers keep their original text, `$` and `*` are distinct values rather than both being "absent", and
 * a typed value like `IFCINTEGER(3)` stays typed.
 */

export type StepValue =
  /** `$` — an optional attribute with no value. Distinct from a value that happens to be empty. */
  | { readonly k: "unset" }
  /**
   * `*` — a *derived* attribute: the schema computes it, so the file must not state it.
   *
   * Emitting `$` here instead would be accepted by lenient readers and rejected by strict ones, which is the
   * worst kind of bug to introduce by accident. It gets its own case so it cannot be conflated.
   */
  | { readonly k: "derived" }
  /**
   * A number, with the source text retained.
   *
   * `raw` exists because STEP distinguishes integers from reals lexically — `3` is an INTEGER, `3.` is a REAL,
   * and an attribute typed REAL that receives `3` is invalid. Re-serialising from the JS number alone would
   * produce `3` for both and quietly corrupt every real-valued attribute in the file.
   */
  | { readonly k: "num"; readonly v: number; readonly raw: string }
  /** A single-quoted string, already unescaped (`''` → `'`). */
  | { readonly k: "str"; readonly v: string }
  /** `.T.`, `.F.`, `.UNKNOWN.`, or a schema enumeration like `.ELEMENT.`. Stored without the dots. */
  | { readonly k: "enum"; readonly v: string }
  /** `#123` — a reference to another entity instance. */
  | { readonly k: "ref"; readonly v: number }
  | { readonly k: "list"; readonly v: readonly StepValue[] }
  /** `IFCINTEGER(3)` — a SELECT type narrowed in the file. */
  | { readonly k: "typed"; readonly t: string; readonly v: readonly StepValue[] }
  /** `"0F"` — a binary literal, kept as its source hex text. */
  | { readonly k: "bin"; readonly v: string };

export const UNSET: StepValue = { k: "unset" };
export const DERIVED: StepValue = { k: "derived" };

/** A real, emitted with the trailing dot STEP requires. */
export function real(v: number): StepValue {
  if (!Number.isFinite(v)) throw new RangeError(`STEP has no representation for ${v}`);
  // `1e-7` is valid STEP, and shortening is not this layer's business, so the JS repr is used as-is — but a
  // whole number must gain the dot that marks it REAL, or a strict reader rejects the attribute.
  const s = String(v);
  return { k: "num", v, raw: /[.eE]/.test(s) ? s : `${s}.` };
}

export function integer(v: number): StepValue {
  if (!Number.isInteger(v)) throw new RangeError(`${v} is not an integer`);
  return { k: "num", v, raw: String(v) };
}

export function str(v: string): StepValue {
  return { k: "str", v };
}

export function ref(id: number): StepValue {
  if (!Number.isInteger(id) || id <= 0) throw new RangeError(`entity ids are positive integers, got ${id}`);
  return { k: "ref", v: id };
}

export function list(v: readonly StepValue[]): StepValue {
  return { k: "list", v };
}

export function enumeration(v: string): StepValue {
  return { k: "enum", v };
}

export const TRUE: StepValue = { k: "enum", v: "T" };
export const FALSE: StepValue = { k: "enum", v: "F" };

/**
 * Escape and quote a STEP string.
 *
 * STEP's data section is 7-bit: anything outside it must be encoded, and `\X2\…\X0\` is the IFC4 way to do
 * that (UTF-16 code units in hex). Writing a raw non-ASCII byte produces a file that some readers accept,
 * some mangle, and some reject — and the failure surfaces as a corrupted room name in a schedule, long after
 * anyone would connect it to an export.
 */
export function quote(v: string): string {
  let out = "";
  let unicode = "";
  const flush = (): void => {
    if (unicode !== "") {
      out += `\\X2\\${unicode}\\X0\\`;
      unicode = "";
    }
  };
  for (const ch of v) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x20 && cp <= 0x7e) {
      flush();
      out += ch === "'" ? "''" : ch === "\\" ? "\\\\" : ch;
    } else {
      // Surrogate pairs are emitted as the two UTF-16 units they are, which is exactly what \X2\ encodes.
      for (let i = 0; i < ch.length; i++) unicode += ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
    }
  }
  flush();
  return `'${out}'`;
}

/** Decode the escapes {@link quote} produces, plus the older `\S\` and `\X\` forms found in real files. */
export function unquote(raw: string): string {
  // `raw` includes the surrounding quotes.
  const body = raw.slice(1, -1);
  let out = "";
  let i = 0;
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === "'" && body[i + 1] === "'") {
      out += "'";
      i += 2;
      continue;
    }
    if (ch !== "\\") {
      out += ch;
      i += 1;
      continue;
    }
    const next = body[i + 1];
    if (next === "\\") {
      out += "\\";
      i += 2;
    } else if (next === "S" && body[i + 2] === "\\") {
      // \S\x — ISO 8859-1 upper half: the character is x with the high bit set.
      const c = body.charCodeAt(i + 3);
      out += String.fromCharCode(c + 0x80);
      i += 4;
    } else if (next === "X" && body[i + 2] === "\\") {
      out += String.fromCharCode(parseInt(body.slice(i + 3, i + 5), 16));
      i += 5;
    } else if (next === "X" && body[i + 2] === "2" && body[i + 3] === "\\") {
      const end = body.indexOf("\\X0\\", i);
      const hex = end === -1 ? body.slice(i + 4) : body.slice(i + 4, end);
      for (let j = 0; j + 4 <= hex.length; j += 4) out += String.fromCharCode(parseInt(hex.slice(j, j + 4), 16));
      i = end === -1 ? body.length : end + 4;
    } else if (next === "X" && body[i + 2] === "4" && body[i + 3] === "\\") {
      const end = body.indexOf("\\X0\\", i);
      const hex = end === -1 ? body.slice(i + 4) : body.slice(i + 4, end);
      for (let j = 0; j + 8 <= hex.length; j += 8) out += String.fromCodePoint(parseInt(hex.slice(j, j + 8), 16));
      i = end === -1 ? body.length : end + 4;
    } else {
      // An escape nobody documents. Pass the backslash through rather than dropping it: a mangled name is
      // recoverable, a silently deleted one is not.
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** Serialise one value. */
export function formatValue(v: StepValue): string {
  switch (v.k) {
    case "unset":
      return "$";
    case "derived":
      return "*";
    case "num":
      return v.raw;
    case "str":
      return quote(v.v);
    case "enum":
      return `.${v.v}.`;
    case "ref":
      return `#${v.v}`;
    case "bin":
      return `"${v.v}"`;
    case "list":
      return `(${v.v.map(formatValue).join(",")})`;
    case "typed":
      return `${v.t}(${v.v.map(formatValue).join(",")})`;
  }
}

/** Serialise a whole attribute list, without the surrounding parentheses. */
export function formatParams(params: readonly StepValue[]): string {
  return params.map(formatValue).join(",");
}
