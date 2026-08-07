/**
 * Redaction — because an error message is user data.
 *
 * ## The thing almost every crash reporter gets wrong
 *
 * A crash report feels like machine output, so it gets treated as safe to send. It is not. In this application
 * the most likely messages are:
 *
 *     Could not parse C:\Projects\Client-Acquisition-Confidential\Tower-A.ifc
 *     Element 3f9K$0aBcDeFgHiJkLmN has no representation
 *     POST https://client-intranet.example/projects/4821/edit failed
 *
 * Each one carries something the user never agreed to send: a client's name in a path, an element GlobalId, an
 * internal hostname, a project id. And it arrives through the one channel nobody reviews, because a stack trace
 * is not thought of as content.
 *
 * So redaction happens **in the sink boundary, not at the call sites**. Asking every `throw` in the codebase to
 * remember not to include a filename is a rule that erodes on the first debugging session — and it is the wrong
 * place anyway, because a developer *wants* the filename in the console. The console sink shows it; the HTTP sink
 * cannot.
 *
 * ## What is deliberately not attempted
 *
 * Detecting arbitrary personal data. That is unsolvable, and pretending otherwise is worse than not trying: a
 * redactor that catches nine kinds of identifier reads as "this is safe to send", which is exactly the belief
 * that makes someone put a customer name in an error message. The honest posture is the one
 * {@link redactionLimits} states: this removes the *shapes* known to appear here, the default sink sends nothing
 * at all, and enabling egress is a decision a deployment makes with its eyes open.
 */

/**
 * Replace a path with `[path]`, keeping its extension.
 *
 * "An IFC failed to parse" stays reportable and the client's name in the directory does not travel. Trailing
 * punctuation is excluded from the extension so `model.ifc.` does not yield `.ifc.`.
 */
function keepExtension(match: string): string {
  const extension = /\.([A-Za-z0-9]{1,8})$/.exec(match);
  return extension === null ? "[path]" : `[path].${extension[1]}`;
}

export interface RedactionRule {
  readonly name: string;
  readonly pattern: RegExp;
  /**
   * A replacement string, or a function of the matched text.
   *
   * The function form exists because of the path rules. Keeping a filename's extension while discarding the rest
   * cannot be expressed in one pattern: a lazy body with an optional trailing `(\.ext)?` group stops at the first
   * position where the terminating lookahead succeeds, so the dot has already been consumed and the group matches
   * empty every time. Extracting it from the match afterwards is both correct and readable.
   */
  readonly replacement: string | ((match: string) => string);
}

/**
 * The rules, in application order.
 *
 * Order matters and is not alphabetical: a URL containing a path must be caught **before** the path rule, or the
 * path rule eats half the URL and leaves a fragment that is neither redacted nor useful.
 *
 * Every pattern is `/g`, which is required for `String#replace` to replace more than the first match. Sharing
 * module-level regexes across calls is safe *here* specifically because `replace` with a global regex sets
 * `lastIndex` to 0 itself — see the note on {@link redact}. It would not be safe with `.test()` or `.exec()`, so a
 * rule added for a different purpose needs its own instance.
 */
export const REDACTION_RULES: readonly RedactionRule[] = [
  {
    name: "url",
    // Scheme through to the end of the path, keeping the scheme so a reader can tell HTTP from a file URL.
    pattern: /\b([a-z][a-z0-9+.-]*):\/\/[^\s"'<>)\]]+/gi,
    replacement: "$1://[redacted]",
  },
  {
    name: "email",
    pattern: /\b[^\s@<>()[\]]+@[^\s@<>()[\]]+\.[a-z]{2,}\b/gi,
    replacement: "[email]",
  },
  {
    name: "windows-path",
    // `C:\a\b\file.ifc` — the extension is kept, because "an IFC failed" is useful and the client's name is not.
    pattern: /\b[A-Za-z]:[\\/][^\s"'<>|?*]*/g,
    replacement: keepExtension,
  },
  {
    name: "posix-path",
    // At least two segments, so a bare `/` or `/tmp` is not a path worth redacting — and so an ordinary sentence
    // containing a slash does not turn into `[path]`.
    pattern: /(?:^|(?<=[\s"'(=]))\/(?:[^\s/"'<>|?*]+\/)+[^\s"'<>|?*]*/g,
    replacement: keepExtension,
  },
  {
    name: "guid",
    /**
     * An IFC GlobalId: exactly 22 characters of the compressed-UUID alphabet.
     *
     * Anchored on length, because that is what makes it a GlobalId rather than a word. The alphabet includes `_`
     * and `$`, and the word boundaries have to be hand-rolled — `\b` does not treat `$` as a word character, so
     * `\b[0-9A-Za-z_$]{22}\b` fails on any id that starts or ends with `$`, which is roughly one in sixteen.
     */
    pattern: /(?<![0-9A-Za-z_$])[0-9A-Za-z_$]{22}(?![0-9A-Za-z_$])/g,
    replacement: "[guid]",
  },
  {
    name: "long-hex",
    // Tokens, hashes, session ids. 32+ hex characters is not something a human typed.
    pattern: /(?<![0-9a-f])[0-9a-f]{32,}(?![0-9a-f])/gi,
    replacement: "[hex]",
  },
  {
    name: "bearer",
    pattern: /\b(bearer|token|authorization|api[_-]?key)([=:]\s*|\s+)\S+/gi,
    replacement: "$1$2[secret]",
  },
  {
    name: "ipv4",
    pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    replacement: "[ip]",
  },
];

/**
 * Redact a string.
 *
 * ## A correction worth keeping
 *
 * This loop used to reset `rule.pattern.lastIndex = 0` first, with a comment claiming that a shared `/g` regex
 * would otherwise carry state between calls and leak whatever preceded the last match — "a bug that only shows up
 * on the second crash".
 *
 * That is **not true for `String#replace`**. `RegExp.prototype[Symbol.replace]` sets `lastIndex` to 0 itself when
 * the regex is global, so the reset could never have made a difference. Deleting it was sabotage-tested and no
 * test failed, which is how the false claim was found: a line of defensive code whose justification is wrong is
 * worse than no line, because the next reader trusts the reasoning and applies it somewhere it matters.
 *
 * The hazard is real for `.test()` and `.exec()`, which do advance `lastIndex` on a global regex. Nothing here
 * uses them, and a rule that needs to would need its own regex instance.
 */
export function redact(text: string): string {
  let out = text;
  for (const rule of REDACTION_RULES) {
    out =
      typeof rule.replacement === "string"
        ? out.replace(rule.pattern, rule.replacement)
        : out.replace(rule.pattern, rule.replacement);
  }
  return out;
}

/**
 * Redact a value of any shape, structurally.
 *
 * Keys are redacted as well as values, because a key can be the secret: `{"C:\\Clients\\Acme\\model.ifc": 3}` is
 * a real shape for a per-file counter, and redacting only values would send the whole path.
 *
 * Cycles are handled rather than allowed to throw. An error object with a `cause` chain that loops is unusual and
 * entirely possible, and a redactor that throws on it takes down the crash handler — turning a reportable bug
 * into an unreportable one.
 */
export function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redact(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[redact(key)] = redactValue(entry, seen);
  return out;
}

/**
 * What redaction does not cover, for `docs/` and for a deployment's own risk assessment.
 *
 * Stated as data rather than prose so it can be rendered next to the switch that turns egress on. A limitation
 * nobody reads at the moment of the decision is a limitation that was not communicated.
 */
export function redactionLimits(): readonly string[] {
  return [
    "arbitrary personal data is not detectable — a customer name written into an error message will be sent",
    "a project or element *name* is not a recognisable shape, unlike a GlobalId, so names in messages survive",
    "a filename's extension is kept deliberately, so 'an IFC failed to parse' remains reportable",
    "minified stack frames may contain inlined string literals that no rule matches",
    "this is defence in depth, not consent: the default sink sends nothing, and that is the actual control",
  ];
}
