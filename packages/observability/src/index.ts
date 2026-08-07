// @massingviewer/observability — knowing what happened, without shipping what happened.
//
// Four concerns that are usually one package and must not be, because they have opposite requirements:
//
//   - **crash** reports are redacted and the default sink sends NOTHING. massing wires its reporter to a hosted
//     service; that is right for a hosted product and wrong here, because a reporter that phones home breaks the
//     "the model never leaves the browser" promise exactly when the model was unusual.
//   - **telemetry** is opt-in and schema-bound at RUNTIME. Types cannot deliver "cannot send an undeclared field":
//     `track("x", {...provenance})` typechecks and ships GlobalIds.
//   - **audit** is the opposite of telemetry and that is why they are separate modules. Telemetry must carry no
//     identifiers; an audit entry saying "an element was deleted" without saying which is not an audit entry.
//   - **flags** and **migrations** both exist because retrofitting them is the expensive kind of impossible.

export { REDACTION_RULES, redact, redactValue, redactionLimits } from "./redact";
export type { RedactionRule } from "./redact";

export { NOOP_CRASH_SINK, consoleSink, createCrashHandler, httpSink, redactReport } from "./crash";
export type { CrashHandler, CrashHandlerOptions, CrashReport, CrashSink, HttpSinkOptions } from "./crash";

export { APP_SCHEMA, DURATION_BUCKETS, NOOP_SINK, bucketDuration, createTelemetry } from "./telemetry";
export type {
  EventSchema,
  FieldKind,
  Rejection,
  Telemetry,
  TelemetryEvent,
  TelemetryOptions,
  TelemetrySchema,
  TelemetrySink,
} from "./telemetry";

export { auditCoverage, createAuditLog, teeAudit } from "./audit";
export type { AuditEntry, AuditLog, AuditSink, Coverage } from "./audit";

export { envelope, isVersioned, migrate, validateChain } from "./migrate";
export type { MigrateResult, MigrationStep, Versioned } from "./migrate";

export { APP_FLAGS, createFlags, expiredFlags, queryFlagSource, storageFlagSource } from "./flags";
export type { FlagDeclaration, FlagSource, Flags } from "./flags";
