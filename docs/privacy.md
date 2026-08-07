# What MassingViewer sends, and what it cannot

**By default: nothing.** No telemetry, no crash reports, no analytics, no fonts, no CDN. The demo's
Content-Security-Policy has `connect-src 'self'`, and an E2E test asserts zero network requests after first paint —
so the offline claim is structural rather than a promise. The model cannot leave the browser because the page
cannot talk to anything.

Everything below describes what happens **if a deployment turns something on**.

## The two channels, and why they have opposite rules

| | Telemetry | Audit log |
|---|---|---|
| Purpose | how often does this happen | who did what to which element |
| Identifiers | **none, ever** | **required** — an entry that omits them is useless |
| Default destination | nowhere (`NOOP_SINK`) | memory, in the tab |
| Leaves the machine | only if a sink is configured | only if you export it |

They are separate modules in `packages/observability/src/` for exactly this reason. Conflating them produces
either a metrics pipeline full of GlobalIds, or an audit trail nobody can act on.

## Telemetry cannot send a field it does not declare

Not "is careful not to" — cannot. `packages/observability/src/telemetry.ts` enforces the schema **at emit**, in
data, because types cannot deliver this. The failing case is not carelessness:

```ts ignore
track("drawing.generated", { ...drawing.provenance, view });
```

That typechecks under any loose signature, and `provenance.incomplete` is an array of GlobalIds and IFC class
names. A spread is the natural way to write it and the compiler agrees. So an undeclared field is **dropped**, and
the drop is recorded — with the field's *name* and never its *value*, because a rejection log is exactly where the
leak would otherwise reappear.

Three kinds of field exist, and no fourth:

- **counts** — non-negative integers
- **enums** — one of a stated closed list
- **durations** — bucketed at `<100ms`, `<500ms`, `<1000ms`, `<5000ms`, `<10000ms`, `<30000ms`, `>=30000ms`

There is deliberately **no free-text field kind**, because every leak of model content in this industry arrived
through one. And durations are bucketed rather than exact, because "parse took 4 812 ms" plus a timestamp
identifies a session more reliably than most identifiers.

### The complete event list

Rendered from `APP_SCHEMA` in `packages/observability/src/telemetry.ts`, which is the authority. A privacy notice
maintained separately from the emitter is wrong within two releases, and being wrong about this one is not a
documentation bug.

| Event | Fields |
|---|---|
| `model.opened` | `sizeBucket` (`<100` … `>=100k`), `source` (`drop`/`picker`/`fixture`), `kind` (`ifc`/`ifcxml`/`zip`/`other`), `parseMs` (bucketed) |
| `drawing.generated` | `view` (`plan`/`section`/…), `durationMs` (bucketed), `incompleteCount`, `coverageBucket` |
| `export.completed` | `format` (`svg`/`dxf`/`pdf`/`bcf`/`ifc`), `durationMs` (bucketed) |
| `kernel.refused` | `code` (from the closed refusal taxonomy), `local` |
| `plugin.quarantined` | `phase` (`load`/`activate`/`deactivate`) |

Note what is **absent** and had to be argued for:

- `model.opened` reports a size *bucket*, not a count — "41 812 elements" is close to a fingerprint.
- `drawing.generated` reports `incompleteCount`, never the failures themselves; `incomplete[]` carries GlobalIds.
- `kernel.refused` reports the `code`, never the `message`. The message is prose and can quote anything.
- `plugin.quarantined` reports the phase, not the plugin. **A plugin id is an identifier.**

The consequence, stated plainly: this data cannot answer "which user hit this". That is the trade, and it was made
on purpose — it can answer "how often does this happen", which is the question worth having.

## Crash reports are redacted, and off by default

`packages/observability/src/crash.ts`. Three sinks:

- `NOOP_CRASH_SINK` — the **default**. Sends nothing.
- `consoleSink()` — development. Deliberately **not** redacted: the report is not leaving the machine, and a
  developer chasing a parse failure needs the actual filename. The risk is egress, not display.
- `httpSink(url)` — a URL a deployment chooses: self-hosted Sentry, GlitchTip, a log endpoint. No vendor SDK, no
  default egress. Cookies are `omit`ted, because a crash endpoint has no business receiving a session.

### Why a stack trace is user data

The messages this application actually produces look like:

```
Could not parse C:\Projects\Client-Acquisition-Confidential\Tower-A.ifc
Element 3f9K$0aBcDeFgHiJkLmNoP has no representation
POST https://client-intranet.example/projects/4821/edit failed
```

Each carries something nobody agreed to send — a client's name, an element GlobalId, an internal hostname, a
project id — through the one channel nobody reviews, because a stack trace does not feel like content.

`packages/observability/src/redact.ts` removes URLs, emails, Windows and POSIX paths (keeping the file
*extension*, so "an IFC failed to parse" stays reportable), 22-character IFC GlobalIds, 32+ character hex tokens,
bearer/token/api-key values, and IPv4 addresses. Redaction happens at the **sink boundary**, not at the call
sites: asking every `throw` to remember not to include a filename is a rule that erodes on the first debugging
session.

### What redaction does not cover

From `redactionLimits()`, and worth reading before enabling egress:

- **Arbitrary personal data is not detectable.** A customer name written into an error message will be sent.
- A project or element **name** is not a recognisable shape, unlike a GlobalId, so names in messages survive.
- A filename's extension is kept deliberately.
- Minified stack frames may contain inlined string literals no rule matches.
- **This is defence in depth, not consent.** The default sink sends nothing, and *that* is the actual control.

## The audit log

`packages/observability/src/audit.ts`. Sits at the command bus, so it is complete **by construction** rather than
by remembering to add a log line — every audit log written by hand is incomplete in the same way, and the missing
entry looks exactly like the absent action. `auditCoverage()` turns that into a number a test can assert.

It records the command, its parameters, the origin, the outcome and the model version. It keeps identifiers,
because that is what an audit trail is for. It lives in memory by default and exports as JSONL — greppable
without a parser, which is the point of the format for a compliance artefact.

Being sensitive is the consequence: an exported audit log contains element GlobalIds and whatever the parameters
carried. Treat it as project data.

## Configuring it

```ts ignore
import {
  createCrashHandler,
  createTelemetry,
  httpSink,
  APP_SCHEMA,
  NOOP_CRASH_SINK,
} from "@massingviewer/observability";

// Crash reports to your own endpoint. Redacted on the way out.
createCrashHandler({ sink: httpSink("https://crash.internal.example/report") }).install(window);

// Telemetry, only after the user has said yes. `enabled` defaults to false, and the check is `=== true` —
// an undefined config means off, so an unchecked first-run dialog cannot leave it already flowing.
createTelemetry({ schema: APP_SCHEMA, enabled: userSaidYes, sink: myTelemetrySink });

// Or nothing at all, which is what happens if you configure neither.
createCrashHandler({ sink: NOOP_CRASH_SINK });
```

The first-run dialog must be **genuinely unchecked**. A pre-ticked box is not consent, and the `=== true` check
exists so that forgetting to wire the dialog fails closed rather than open.
