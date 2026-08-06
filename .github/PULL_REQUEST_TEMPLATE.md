## What and why

<!-- What changed, and what problem it solves. A reviewer should not have to infer the motivation. -->

## Checklist

- [ ] `npm run verify` passes locally (lint, typecheck, tests, repo gates)
- [ ] Tests come with the change, in this PR

<!-- Delete any section below that does not apply. -->

### Extracting code from ibuilder/massing

- [ ] Extracted from `origin/main`, not from a local clone (a stale clone drops features silently — the
      copied files still exist, compile, and pass)
- [ ] Ran `node scripts/preflight-extraction.mjs` — no open upstream PR touches these files
- [ ] Every file carries an `// Extracted from ibuilder/massing @ <sha> (<path>), MIT.` header
- [ ] `docs/PROVENANCE.tsv` has a matching row
- [ ] The upstream tests came along

### Changing a public contract (`packages/kernel-api`, `packages/plugin-host`)

- [ ] An ADR in `docs/adr/` explains the change
- [ ] Conformance assertions updated, including the refusal case
- [ ] Deprecations follow the policy: marked, warned once per session, two minors minimum

### Adding a dependency

- [ ] Permissive license (`npm run gate:license` agrees)
- [ ] `THIRD-PARTY-NOTICES.md` regenerated (`npm run gate:license -- --write`)
