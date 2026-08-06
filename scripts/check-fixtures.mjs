/**
 * Fixture-determinism gate.
 *
 * `fixtures/sample.ifc` is committed *and* generated. That is a deliberate combination — golden tests need a
 * stable file to anchor to, and the generator needs to stay the source of truth — but it creates one failure
 * mode: the two drift apart. Someone edits `build-sample.mjs`, forgets to regenerate, and from then on the
 * committed fixture describes a building the generator no longer produces.
 *
 * That is worse than either alternative alone, because every golden drawing downstream is now anchored to a
 * file whose provenance is a lie.
 *
 * So: regenerate into a temp location and assert byte-identity. This also enforces the determinism the
 * fixture depends on — the deterministic GlobalIds and the fixed timestamp exist precisely so that this check
 * can pass, and if either regresses to something random this fails immediately rather than at the moment
 * someone tries to write a golden test.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const TARGET = join(ROOT, "fixtures", "sample.ifc");
const BACKUP = join(ROOT, "fixtures", "sample.ifc.gate-backup");

if (!existsSync(TARGET)) {
  console.error(`\nFixture gate failed: fixtures/sample.ifc is missing.\n  Run: node fixtures/build-sample.mjs\n`);
  process.exit(1);
}

const committed = readFileSync(TARGET);

// The generator writes to a fixed path, so preserve the committed file and restore it afterwards. Doing this
// rather than teaching the generator an output flag keeps the generator itself simple — it has one job.
copyFileSync(TARGET, BACKUP);
let regenerated;
try {
  execFileSync(process.execPath, [join(ROOT, "fixtures", "build-sample.mjs")], { stdio: "pipe" });
  regenerated = readFileSync(TARGET);
} finally {
  renameSync(BACKUP, TARGET);
}

if (!committed.equals(regenerated)) {
  // Report *where* it diverged. "The files differ" sends the reader to a 137-line diff; a line number and
  // the two texts is usually the whole answer.
  const a = committed.toString("utf8").split("\n");
  const b = regenerated.toString("utf8").split("\n");
  let line = -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      line = i + 1;
      break;
    }
  }
  console.error(
    `\nFixture gate failed: regenerating fixtures/sample.ifc does not reproduce the committed file.\n\n` +
      `  committed:   ${committed.length} bytes, ${a.length} lines\n` +
      `  regenerated: ${regenerated.length} bytes, ${b.length} lines\n` +
      `  first difference at line ${line}:\n` +
      `    committed:   ${JSON.stringify(a[line - 1] ?? "(absent)")}\n` +
      `    regenerated: ${JSON.stringify(b[line - 1] ?? "(absent)")}\n\n` +
      `  Either the generator changed and the fixture was not regenerated:\n` +
      `      node fixtures/build-sample.mjs\n` +
      `    — and then update the expected values in fixtures/sample.test.ts, because the GlobalIds shift\n` +
      `      whenever entity emission order changes, and every golden drawing downstream rebases with them.\n\n` +
      `  Or the generator stopped being deterministic (a real timestamp, a random id). Fix that instead:\n` +
      `    the fixture's whole value is that its expected values can be written down.\n`,
  );
  process.exit(1);
}

if (existsSync(BACKUP)) unlinkSync(BACKUP);

console.log(
  `Fixture gate passed: fixtures/sample.ifc regenerates byte-identically ` +
    `(${committed.length} bytes, ${committed.toString("utf8").split("\n").length} lines).`,
);
