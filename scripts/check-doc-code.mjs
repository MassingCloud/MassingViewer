#!/usr/bin/env node
/**
 * Every TypeScript block in the guides must compile.
 *
 * ## Why this gate exists
 *
 * A guide whose example does not compile is the fastest way to lose a plugin author. They do not file a bug —
 * they conclude the project is unfinished and leave, and nobody ever finds out.
 *
 * `check-doc-paths.mjs` already asserts that every backticked path in the docs resolves, which catches a guide
 * pointing at a file that has moved. This catches the other half, and it is the half that rots faster: a guide
 * pointing at a *type* that has changed. Renaming a field on `PluginManifest` breaks every example that sets it,
 * and no amount of path checking notices.
 *
 * ## How
 *
 * Extract each ```ts block, wrap it in a module, and run `tsc --noEmit` over the lot with the repository's own
 * `tsconfig.base.json` — same strictness the source is held to, because an example that only compiles under
 * looser settings is an example that will not compile in the reader's project.
 *
 * Blocks are compiled **together, in document order**, per file. That is deliberate: the plugin guide's second
 * block uses `PluginContext` imported in a way the first block establishes, and splitting them would force every
 * example to repeat its imports — which makes for worse documentation.
 *
 * Opt out with ```ts ignore for a block that is deliberately illustrative rather than runnable. Requiring an
 * explicit marker means the exception is visible in the diff.
 */

import { execFileSync } from "node:child_process";
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Forward slashes, whatever the platform.
 *
 * `globSync` returns backslash-separated paths on Windows, so `path.split("/")` yields the whole string as one
 * element — and the first thing built from it is `undefined`. Normalising once at the boundary is the fix;
 * splitting on `sep` in three places is how one of them gets missed.
 */
const slashes = (path) => path.split("\\").join("/");

/** Guides whose code is meant to be real. Not every doc — an ADR quoting a bad example on purpose is fine. */
const PATTERNS = ["docs/plugins/*.md", "docs/kernels/*.md"];

/** ```ts / ```typescript fences, capturing an optional trailing marker on the info string. */
const FENCE = /^```(ts|typescript)([^\n]*)\n([\s\S]*?)^```$/gm;

function blocksIn(text) {
  const blocks = [];
  for (const match of text.matchAll(FENCE)) {
    const info = (match[2] ?? "").trim();
    const line = text.slice(0, match.index).split("\n").length;
    blocks.push({ code: match[3], ignored: info.includes("ignore"), line });
  }
  return blocks;
}

const files = PATTERNS.flatMap((pattern) => globSync(pattern, { cwd: ROOT })).map(slashes).sort();
if (files.length === 0) {
  console.error("Doc-code gate: no guides matched — the patterns are stale, which is a silent pass.");
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "mv-doc-code-"));
let compiled = 0;
let skipped = 0;
const problems = [];

try {
  const entries = [];

  for (const file of files) {
    const text = readFileSync(join(ROOT, file), "utf8");
    const blocks = blocksIn(text);
    if (blocks.length === 0) continue;

    const parts = [];
    /**
     * Combined-file line → the markdown line it came from.
     *
     * Without this, an error reports a line number in a temp file that no longer exists, and the reader has to
     * count fences to find the block. The whole value of this gate is that a broken example is *easy* to fix, so
     * an unusable line number gives most of that back.
     */
    const lineMap = [];
    let cursor = 1;

    for (const [i, block] of blocks.entries()) {
      if (block.ignored) {
        skipped++;
        continue;
      }
      // A header line naming the source, so even the raw temp file is readable if it ever needs to be.
      parts.push(`// --- ${file}:${block.line} (block ${i + 1}) ---\n${block.code}`);
      const lines = block.code.split("\n").length;
      // `block.line` is the fence, so the code itself starts on the next markdown line. The header takes one
      // line in the combined file, so the code starts at `cursor + 1`.
      lineMap.push({ from: cursor + 1, lines, docLine: block.line + 1 });
      cursor += 1 + lines;
      compiled++;
    }
    if (parts.length === 0) continue;

    const name = `${file.replace(/[^A-Za-z0-9]+/g, "_")}.ts`;
    writeFileSync(join(work, name), parts.join("\n"), "utf8");
    entries.push({ file, name, lineMap });
  }

  if (entries.length === 0) {
    console.error("Doc-code gate: every block is marked `ignore`, which makes this gate a no-op.");
    process.exit(1);
  }

  // Module resolution has to reach the real workspace packages, or every import fails and the gate reports
  // nonsense. `baseUrl`/`paths` point at each package's source: examples import from `@massing/*`, which
  // is what a reader writes, and the published `dist` may not be built.
  const paths = {};
  for (const pkg of globSync("packages/*/src/index.ts", { cwd: ROOT }).map(slashes).sort()) {
    const name = pkg.split("/")[1];
    paths[`@massing/${name}`] = [join(ROOT, "packages", name, "src", "index.ts")];
    paths[`@massing/${name}/*`] = [join(ROOT, "packages", name, "src", "*")];
  }

  writeFileSync(
    join(work, "tsconfig.json"),
    JSON.stringify(
      {
        extends: join(ROOT, "tsconfig.base.json"),
        compilerOptions: {
          noEmit: true,
          composite: false,
          incremental: false,
          declaration: false,
          declarationMap: false,
          lib: ["ES2023", "DOM"],
          // Node types, because a kernel guide legitimately reads a fixture off disk in its example.
          types: ["node"],
          // The temp directory has no `node_modules`, so type resolution has to be pointed back at the repo's.
          typeRoots: [join(ROOT, "node_modules", "@types")],
          // Relaxed for doc blocks only, and only these two. `noUnusedLocals` is a source-hygiene rule, not a
          // correctness one, and a guide that opens with "here is the one interface you implement" is *supposed*
          // to import a name it does not then use. Every other strict flag stays on, because an example that
          // compiles only under looser settings is an example that will not compile in the reader's project.
          noUnusedLocals: false,
          noUnusedParameters: false,
          baseUrl: work,
          paths,
        },
        files: entries.map((e) => e.name),
      },
      null,
      2,
    ),
    "utf8",
  );

  try {
    execFileSync(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", work], {
      cwd: ROOT,
      stdio: "pipe",
      encoding: "utf8",
    });
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    for (const raw of output.split("\n").filter((l) => l.trim() !== "")) {
      const entry = entries.find((e) => raw.includes(e.name));
      if (entry === undefined) {
        problems.push(raw.trim());
        continue;
      }
      // Match and discard the whole prefix up to the generated filename. Stripping a *known* prefix does not
      // work: `tsc` emits a path relative to its cwd, so it arrives as `../../Users/.../mv-doc-code-xxxx/…`
      // and depends on where the OS put the temp directory. The filename is the part that is stable.
      const escaped = entry.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      problems.push(
        raw.replace(new RegExp(`^.*?${escaped}\\((\\d+),(\\d+)\\)`), (_match, line, column) => {
          const at = Number(line);
          const block = entry.lineMap.find((b) => at >= b.from && at < b.from + b.lines);
          return block === undefined
            ? `${entry.file}(${line},${column})`
            : `${entry.file}:${block.docLine + (at - block.from)}:${column}`;
        }),
      );
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error(`Doc-code gate FAILED — ${problems.length} problem(s) in the guides:\n`);
  for (const problem of problems) console.error(`  • ${problem}`);
  console.error(
    "\nA guide whose example does not compile is the fastest way to lose a plugin author: they do not file\n" +
      "a bug, they conclude the project is unfinished. Fix the example, or mark the block ```ts ignore if it\n" +
      "is deliberately illustrative.",
  );
  process.exit(1);
}

console.log(
  `Doc-code gate passed: ${compiled} TypeScript block(s) across ${files.length} guide(s) compile` +
    `${skipped > 0 ? `, ${skipped} marked ignore` : ""}.`,
);