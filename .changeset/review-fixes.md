---
"@massing/authoring": patch
"@massing/embed": minor
"@massing/viewport": patch
---

Seven fixes from a code review of the authoring session, two of which let invalid geometry reach the kernel.

The worst: after a placement refusal, clicking again bypassed validation entirely and committed the geometry that
had just been refused. `points` is now derived from the prompt reducer rather than mirrored beside it, which makes
the drift that caused it unrepresentable.

Also: a typed distance now follows the cursor's bearing instead of always going due east; the facade resolves a
clicked element by raycast rather than reading the selection; `CommandContext.dispatch` really dispatches instead
of returning a fake success; snap candidates come from a grid built per model load rather than a full vertex scan
per frame; `section.dispose()` reference-counts the renderer's clipping flag; and a snap override no longer arms
while nothing is armed. `embed` now exposes `commands`, since a host has to register its own verbs.
