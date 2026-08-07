/**
 * Layer gate.
 *
 * The whole value proposition of the core packages is that they are framework-agnostic and
 * host-agnostic: usable from a Worker, from Node, from massing's vanilla-DOM app, and from React. That
 * property has no natural defender. It erodes one convenient import at a time — `geometry-math` needs a
 * `Vector3`, so it imports `three`; `kernel-api` needs a spinner, so it imports a React hook — and each
 * step is individually reasonable. By the time anyone notices, the package cannot be published usefully
 * and the second host has to fork it.
 *
 * So the layering is a build failure, not a convention. Ported from massingifc's own
 * `scripts/check-architecture.mjs`, which already enforces the narrower rule that only one package may
 * import `three`.
 *
 * Checks:
 *   1. A package may only import packages in a strictly lower layer.
 *   2. Only allow-listed packages may import specific heavy externals (`three`, `@thatopen/*`, `react`).
 *   3. Every workspace import is declared as a dependency (npm's flat node_modules hides this; pnpm
 *      would catch it, and this is how we get that safety without changing package manager).
 *   4. No import cycles between packages.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/**
 * Layers. A package may import from a strictly lower layer only. Same-layer imports are refused too —
 * they are how a DAG becomes a mesh, and the fix is almost always that the shared thing belongs one
 * layer down.
 */
const LAYERS = [
  ["core", "kernel-api", "kernel-conformance"],
  // `ifc` sits here rather than at layer 2 where the original plan put it, and the move is a consequence of
  // docs/adr/0008-local-kernel-geometry-stack.md rather than a convenience. The plan assumed this package would
  // wrap `web-ifc` and therefore carry WASM; the ADR decided the entity table is ours and web-ifc is used only
  // for tessellation elsewhere. What actually shipped is pure TypeScript with no DOM, no network and no WASM —
  // which is the definition of this layer. Leaving it at 2 would have forced a same-layer exception for
  // `kernel-local -> ifc`, papering over a classification that had simply become wrong.
  ["geometry-math", "ui-model", "catalog", "jobs", "ifc"],
  ["geometry-worker", "kernel-local", "kernel-remote", "kernel-memory"],
  ["drawings2d", "markup", "markup-ui", "commands", "plugin-host", "assets"],
  ["viewport", "ui-react", "ribbon"],
  ["embed", "cli"],
];

/** Exception: kernel-api legitimately sits above core, and kernel-conformance above kernel-api. */
const SAME_LAYER_ALLOWED = new Set([
  "kernel-api -> core",
  "kernel-conformance -> core",
  "kernel-conformance -> kernel-api",
]);

/**
 * Heavy or environment-bound externals, and the only packages allowed to import them.
 *
 * `three` is the important one and it is not about taste. massing's `vite.config.ts` carries a comment
 * about `resolve.dedupe: ["three"]` because "Multiple instances of Three.js" was a *measured* failure
 * there — two copies of three in one bundle produce objects that fail each other's `instanceof` checks,
 * and the symptom is geometry that silently refuses to render. Confining the import to one package is
 * what makes deduping tractable.
 */
const RESTRICTED_EXTERNALS = {
  three: ["viewport"],
  "@thatopen/components": ["viewport"],
  "@thatopen/components-front": ["viewport"],
  "@thatopen/fragments": ["viewport"],
  "@thatopen/ui": ["viewport"],
  "camera-controls": ["viewport"],
  react: ["ui-react"],
  "react-dom": ["ui-react"],
  konva: ["ui-react", "drawings2d"],
  "web-ifc": ["ifc"],
  "manifold-3d": ["geometry-worker"],
  "clipper2-wasm": ["geometry-worker"],
  "pdfjs-dist": ["markup-ui"],
  "pdf-lib": ["markup-ui"],
};

const layerOf = (pkg) => LAYERS.findIndex((l) => l.includes(pkg));

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "node_modules" || entry === "dist") continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Strip comments and string literals so the import scan reads code, not prose.
 *
 * Necessary, not defensive: this file's own first run flagged `packages/ui-model/src/index.ts` for
 * importing `"this button has no icon yet"` — a phrase from a doc comment that happened to follow the
 * word "from" and a quote. A gate that reports imaginary problems gets switched off, so it has to read
 * the code the compiler reads.
 *
 * Deliberately a scanner rather than a regex: nested quotes inside comments and apostrophes inside
 * prose ("doesn't") both break the regex approach, and the second one silently swallows the rest of the
 * file, which would make the gate pass by seeing nothing.
 */
function stripCommentsAndStrings(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // Keep the quotes and content of genuine string literals — they may be import specifiers — but
    // consume them atomically so an apostrophe inside one cannot desynchronise the scan.
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (source[i] === "\\") {
          out += source[i] + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (source[i] === quote) break;
        out += source[i];
        i++;
      }
      out += quote;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Every `from "..."` and `import("...")` specifier in a file. */
function importsOf(rawSource) {
  const source = stripCommentsAndStrings(rawSource);
  const specs = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) specs.push(m[1]);
  }
  return specs;
}

const problems = [];
const edges = new Map(); // package -> Set<package>

let packages;
try {
  packages = readdirSync(join(ROOT, "packages")).filter((p) => {
    try {
      return statSync(join(ROOT, "packages", p)).isDirectory();
    } catch {
      return false;
    }
  });
} catch {
  console.log("no packages/ directory yet — nothing to check");
  process.exit(0);
}

for (const pkg of packages) {
  const pkgDir = join(ROOT, "packages", pkg);
  const srcDir = join(pkgDir, "src");
  let files;
  try {
    files = walk(srcDir);
  } catch {
    continue; // no src/ — a plugin dir or a placeholder
  }

  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  } catch {
    problems.push(`${pkg}: no package.json`);
    continue;
  }
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);

  const myLayer = layerOf(pkg);
  if (myLayer === -1) {
    problems.push(
      `${pkg}: not assigned to a layer in scripts/check-architecture.mjs. ` +
        `A new package must declare where it sits before it can import anything.`,
    );
    continue;
  }

  for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    const isTest = /\.test\.tsx?$/.test(file);
    const source = readFileSync(file, "utf8");

    for (const spec of importsOf(source)) {
      if (spec.startsWith(".")) continue; // relative — within the package

      // --- workspace imports: layering + declared-dependency ---
      const ws = /^@massingviewer\/([^/]+)/.exec(spec);
      if (ws) {
        const target = ws[1];
        const theirLayer = layerOf(target);
        if (theirLayer === -1) {
          problems.push(`${rel}: imports @massingviewer/${target}, which has no layer assigned`);
          continue;
        }
        if (!edges.has(pkg)) edges.set(pkg, new Set());
        edges.get(pkg).add(target);

        const pairKey = `${pkg} -> ${target}`;
        if (theirLayer > myLayer) {
          problems.push(
            `${rel}: ${pkg} (layer ${myLayer}) imports ${target} (layer ${theirLayer}) — ` +
              `imports must go DOWN the stack. Move the shared code to a lower layer.`,
          );
        } else if (theirLayer === myLayer && !SAME_LAYER_ALLOWED.has(pairKey)) {
          problems.push(
            `${rel}: ${pkg} imports ${target} at the same layer (${myLayer}). ` +
              `Same-layer edges turn the DAG into a mesh — move the shared code down, or add "${pairKey}" ` +
              `to SAME_LAYER_ALLOWED with a reason.`,
          );
        }
        if (!declared.has(spec) && !isTest) {
          problems.push(
            `${rel}: imports ${spec} but packages/${pkg}/package.json does not declare it. ` +
              `npm's flat node_modules makes this work locally and fail for consumers.`,
          );
        }
        continue;
      }

      // --- restricted externals ---
      const bare = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      const allowed = RESTRICTED_EXTERNALS[bare];
      if (allowed && !allowed.includes(pkg)) {
        problems.push(
          `${rel}: ${pkg} imports "${bare}", which is confined to [${allowed.join(", ")}]. ` +
            `See the note in scripts/check-architecture.mjs for why.`,
        );
      }

      // --- undeclared externals (tests may use root devDependencies) ---
      if (!isTest && !allowed && !declared.has(bare) && !bare.startsWith("node:")) {
        const rootDeps = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
        const inRoot =
          bare in (rootDeps.dependencies ?? {}) || bare in (rootDeps.devDependencies ?? {});
        if (!inRoot) {
          problems.push(`${rel}: imports "${bare}" which is declared nowhere`);
        }
      }
    }
  }
}

// --- cycles ---
const WHITE = 0;
const GREY = 1;
const BLACK = 2;
const colour = new Map();
const stack = [];

function visit(node) {
  colour.set(node, GREY);
  stack.push(node);
  for (const next of edges.get(node) ?? []) {
    const c = colour.get(next) ?? WHITE;
    if (c === GREY) {
      // Report the ACTUAL cycle, not just that one exists. "There is a cycle" sends the reader on a
      // search; naming the path is the difference between a five-minute fix and an afternoon.
      const at = stack.indexOf(next);
      problems.push(`import cycle: ${[...stack.slice(at), next].join(" -> ")}`);
    } else if (c === WHITE) {
      visit(next);
    }
  }
  stack.pop();
  colour.set(node, BLACK);
}

for (const node of edges.keys()) if ((colour.get(node) ?? WHITE) === WHITE) visit(node);

if (problems.length > 0) {
  console.error(`\nArchitecture gate failed — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  console.error("");
  process.exit(1);
}

console.log(
  `Architecture gate passed: ${packages.length} package(s), ` +
    `${[...edges.values()].reduce((n, s) => n + s.size, 0)} workspace edge(s), no cycles.`,
);
