/**
 * Fixture-determinism gate.
 *
 * `fixtures/sample.ifc` and `fixtures/broken.ifc` are committed *and* generated. That is a deliberate combination
 * — golden tests need a stable file to anchor to, and the generator needs to stay the source of truth — but it
 * creates one failure mode: the two drift apart. Someone edits `build-sample.mjs`, forgets to regenerate, and from
 * then on the committed fixture describes a building the generator no longer produces.
 *
 * That is worse than either alternative alone, because every golden drawing downstream is now anchored to a
 * file whose provenance is a lie. Sixteen digests under `fixtures/golden/` depend on these bytes.
 *
 * So: regenerate over the committed file, assert byte-identity, and restore. This also enforces the determinism
 * the fixtures depend on — the deterministic GlobalIds and the fixed timestamp exist precisely so that this check
 * can pass, and if either regresses to something random this fails immediately rather than at the moment someone
 * tries to write a golden test.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/**
 * Every generated fixture, with the argument that produces it.
 *
 * `broken.ifc` joined when the golden suite needed an input the sectioner cannot handle. It is the only way to
 * exercise `DrawingProvenance.incomplete`, and a field with no failing input has never actually been tested — the
 * suite found it reporting an empty list for a model three elements short.
 */
const FIXTURES = [
  { name: "sample.ifc", args: [] },
  { name: "broken.ifc", args: ["broken"] },
];

/** Regenerate one fixture over its committed copy and assert byte-identity. Exits on failure. */
function check({ name, args }) {
  const target = join(ROOT, "fixtures", name);
  const backup = join(ROOT, "fixtures", `${name}.gate-backup`);
  const how = ["node fixtures/build-sample.mjs", ...args].join(" ");

  if (!existsSync(target)) {
    console.error(`\nFixture gate failed: fixtures/${name} is missing.\n  Run: ${how}\n`);
    process.exit(1);
  }

  const committed = readFileSync(target);

  // The generator writes to a fixed path, so preserve the committed file and restore it afterwards. Doing this
  // rather than teaching the generator an output flag keeps the generator itself simple — it has one job.
  copyFileSync(target, backup);
  let regenerated;
  try {
    execFileSync(process.execPath, [join(ROOT, "fixtures", "build-sample.mjs"), ...args], { stdio: "pipe" });
    regenerated = readFileSync(target);
  } finally {
    renameSync(backup, target);
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
      `\nFixture gate failed: regenerating fixtures/${name} does not reproduce the committed file.\n\n` +
        `  committed:   ${committed.length} bytes, ${a.length} lines\n` +
        `  regenerated: ${regenerated.length} bytes, ${b.length} lines\n` +
        `  first difference at line ${line}:\n` +
        `    committed:   ${JSON.stringify(a[line - 1] ?? "(absent)")}\n` +
        `    regenerated: ${JSON.stringify(b[line - 1] ?? "(absent)")}\n\n` +
        `  Either the generator changed and the fixture was not regenerated:\n` +
        `      ${how}\n` +
        `    — and then update the expected values in fixtures/sample.test.ts, because the GlobalIds shift\n` +
        `      whenever entity emission order changes, and every golden drawing downstream rebases with them:\n` +
        `      GOLDEN=update npx vitest run fixtures/golden.test.ts, and READ the diff.\n\n` +
        `  Or the generator stopped being deterministic (a real timestamp, a random id). Fix that instead:\n` +
        `    the fixture's whole value is that its expected values can be written down.\n`,
    );
    process.exit(1);
  }

  if (existsSync(backup)) unlinkSync(backup);
  return `fixtures/${name}: ${committed.length} bytes, ${committed.toString("utf8").split("\n").length} lines`;
}

const results = FIXTURES.map(check);

console.log(`Fixture gate passed: ${results.length} fixture(s) regenerate byte-identically.`);
for (const r of results) console.log(`  ${r}`);
