# Security Policy

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/MassingCloud/MassingViewer/security/advisories/new)
rather than opening a public issue.

We aim to acknowledge within **3 business days** and to ship a fix or a documented mitigation within
**90 days**, coordinating disclosure with you.

## Scope — what we consider a vulnerability

MassingViewer processes files that arrive from outside the organisation using it: IFC models from
consultants, PDFs from subcontractors, DXF underlays, and drawing SVG. **Handling of untrusted input
is explicitly in scope**, not treated as user error.

In scope:

- **Untrusted IFC** causing memory corruption, unbounded allocation, worker escape, or code execution
  during parse or geometry generation.
- **Untrusted SVG** reaching the DOM without sanitisation. This is the sharpest edge in the product:
  when the local kernel generates a drawing client-side, there is **no server-side escaping in front
  of it**, so `sanitizeSvg` is the primary control rather than defence-in-depth. Any path from drawing
  bytes to DOM that bypasses it is a vulnerability, and there is an import-graph assertion in CI
  intended to make that impossible.
- **Untrusted PDF** causing the same classes of failure via the PDF pipeline.
- Content Security Policy bypasses, including anything that turns `wasm-unsafe-eval` into general
  script execution.
- Plugin sandbox escapes — a plugin reaching capabilities it did not declare, or reading data outside
  its granted scope.
- Authentication or capability-gating bypass in `kernel-remote`: performing an operation the server
  should have refused, or a client-side gate being the *only* thing preventing it.
- Leaking model content, file paths, GlobalIds or project names through telemetry or crash reports.
  Telemetry is opt-in and must never carry model data; a violation is a vulnerability, not a bug.
- Dependency vulnerabilities reachable from a supported configuration.

Out of scope:

- Findings that require the user to run a plugin they were warned about and explicitly granted
  permissions to. Sandbox *escapes* remain in scope; a plugin doing what the user authorised is not.
- Denial of service from a legitimately enormous model. There are documented size limits and a
  "too large for this device" path; a slow load is not a vulnerability.
- Missing hardening headers on a *third party's* self-hosted deployment. We ship a reference
  a reference nginx config and a CSP; how someone else deploys is theirs. Report defects in what we ship.
- Anything requiring physical access to an unlocked machine, or a compromised browser or OS.
- Social engineering, and reports consisting solely of automated scanner output with no demonstrated
  impact.

## Supported versions

Pre-`1.0.0`: only the latest `0.x` release. After `1.0.0`, the current major and the previous minor.

## What we do on our side

- `gitleaks` on every push, as a hard gate with an empty ignore list.
- CodeQL (`security-extended`), `npm audit` at `high`, and dependency review on PRs.
- A CycloneDX SBOM attached to every release and signed with keyless `cosign`.
- A transitive license gate that refuses copyleft and source-available dependencies.
- No third-party runtime origins: all WASM, fonts and tiles are served from origin, asserted in CI.
- No telemetry by default, and no crash reporting egress by default. With `LocalKernel`, the model
  never leaves the browser.
