---
"@massingviewer/observability": minor
"@massingviewer/ui-react": patch
---

New package: crash reporting, telemetry, audit and feature flags with the sinks inverted.

The default sends nothing — that is the actual privacy control, not the redaction. Telemetry enforces its schema
at emit, in data, because types cannot stop `track("x", {...provenance})` from shipping GlobalIds. Audit is a
separate module precisely because it has the opposite requirement: it must carry identifiers. Migrations use a
`{schemaVersion, data}` envelope and refuse a future version rather than partially reading it; `ui-react`'s dock
layout now goes through it.
