/**
 * Build the GitHub Pages site: the documentation, with the demo mounted underneath it.
 *
 * ## Why this exists, given the plan cut it
 *
 * `docs site` is listed under *Cut from v1* in the project plan, and that was the right call at the time — a docs
 * site is a maintenance surface, and until there was documentation worth reading it would have been a shell. There
 * are now twenty-five documents totalling several thousand lines, all of which are the *reason* several decisions
 * in this repository are defensible, and they are readable only by browsing GitHub. So the call has been reversed
 * deliberately rather than drifted past. Recorded in `docs/deployment.md`.
 *
 * ## The shape, and the two things that dictated it
 *
 * `/` is the documentation. `/demo/` is the app. That order is not a preference:
 *
 * 1. **The demo already builds for a subpath.** `apps/demo/vite.config.ts` sets `base: "./"` and
 *    `packages/pwa/src/plugin.ts` emits `./sw-register.js` and registers `./sw.js` — both relative, both with a
 *    comment saying why. So the demo can be moved under a directory with no rebuild and no configuration, and its
 *    service-worker scope follows it. Putting the *docs* in a subdirectory instead would have been the change that
 *    needed thinking about.
 * 2. **A visitor who lands on a CAD canvas has no idea what they are looking at.** The plan's own framing is that
 *    the room "is not behind on features — it is behind on the first ten minutes." A landing page that says what
 *    this is, and then hands over a working demo, is that first minute.
 *
 * ## No dependency reaches the browser
 *
 * `marked` renders at build time; the output is HTML with one inline stylesheet and no script at all. Nothing is
 * fetched from another origin — no CDN, no web font, no analytics — which is the same posture `docs/deployment.md`
 * describes for the app, and `pages.yml` checks it on the built output rather than trusting this comment.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "site");
const REPO = "https://github.com/MassingCloud/MassingViewer";
const BLOB = `${REPO}/blob/main`;

/**
 * Pages, discovered rather than listed.
 *
 * Same reasoning as `collectDocs` in `check-doc-paths.mjs`, which exists because an earlier hand-written list
 * meant `docs/testing.md` had never been gated at all: a new document must be picked up by existing, not by
 * someone remembering to edit a build script. A doc that is written and never published is the same waste as one
 * that is never written.
 */
const GROUPS = [
  { title: "Start here", match: (p) => ["README.md", "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md"].includes(p) },
  { title: "Decisions (ADRs)", match: (p) => p.startsWith("docs/adr/") },
  { title: "Guides", match: (p) => p.startsWith("docs/") },
  { title: "Reference", match: () => true },
];

function collect() {
  const found = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md", "THIRD-PARTY-NOTICES.md"];
  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir))) {
      const rel = posix.join(dir, entry);
      if (statSync(join(ROOT, rel)).isDirectory()) {
        // `pending/` holds extraction leftovers that cite massing's paths, not ours — the same exclusion the
        // doc-path gate makes, for the same reason.
        if (entry !== "pending") walk(rel);
      } else if (entry.endsWith(".md")) {
        found.push(rel);
      }
    }
  };
  walk("docs");
  return found.filter((p) => existsSync(join(ROOT, p)));
}

/** `README.md` becomes the site root; everything else keeps its path with an `.html` extension. */
const outputFor = (source) => (source === "README.md" ? "index.html" : source.replace(/\.md$/, ".html"));

/** GitHub's heading-anchor algorithm, closely enough that `CONTRIBUTING.md#versioning` keeps working. */
function slug(text, used) {
  const base = text
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
  let candidate = base === "" ? "section" : base;
  for (let n = 1; used.has(candidate); n++) candidate = `${base}-${n}`;
  used.add(candidate);
  return candidate;
}

const sources = collect();
const pages = new Map(sources.map((source) => [source, outputFor(source)]));

/** First `# ` heading, or the filename. The nav reads better from a real title than from a slug. */
function titleOf(markdown, source) {
  const heading = /^#\s+(.+)$/m.exec(markdown);
  return heading === null ? source : heading[1].replace(/`/g, "");
}

const titles = new Map(
  sources.map((source) => [source, titleOf(readFileSync(join(ROOT, source), "utf8"), source)]),
);
// The README's own H1 is the project name, which makes a useless nav entry ("MassingViewer" under
// "Start here", linking to the page you are already on) and a `<title>` that reads "MassingViewer —
// MassingViewer". The page keeps its heading; only its label changes.
const NAV_LABELS = new Map([["README.md", "Overview"]]);
const labelOf = (source) => NAV_LABELS.get(source) ?? titles.get(source);

const nav = GROUPS.map((group) => ({
  title: group.title,
  items: sources
    .filter((source) => GROUPS.find((g) => g.match(source)) === group)
    .sort((a, b) => (a === "README.md" ? -1 : b === "README.md" ? 1 : a.localeCompare(b))),
})).filter((group) => group.items.length > 0);

/**
 * Rewrite one link.
 *
 * Three cases, and the third is the one that makes the site worth reading. A doc that says
 * "enforced by `scripts/check-architecture.mjs`" links to that file; the file is not part of the site, so the link
 * has to go somewhere real. Dropping it, or leaving it to 404, would break the property the doc-path gate exists
 * to protect — that every citation in these documents is checkable by clicking.
 */
function rewrite(href, fromSource, dead, anchors) {
  if (/^(?:[a-z]+:|\/\/|#)/i.test(href)) {
    // A same-page fragment still has to exist. `#repo-gates` that matches no heading is a link that silently
    // does nothing, which is the failure this whole build is meant to make impossible.
    if (href.startsWith("#")) anchors.push({ from: fromSource, target: fromSource, fragment: href.slice(1), href });
    return href;
  }
  const [path, fragment] = href.split("#");
  const anchor = fragment === undefined ? "" : `#${fragment}`;
  if (path === "") return anchor;

  // Resolved against the *linking file's* directory, not the repository root. `docs/testing.md` writes
  // `../CONTRIBUTING.md`, and treating that as a repo-relative path was this function's first bug — it reported a
  // perfectly good link as dead. The gate caught it on its first run, which is the argument for having it.
  const resolved = posix.normalize(posix.join(posix.dirname(fromSource), path));

  const target = pages.get(resolved);
  if (target !== undefined) {
    if (fragment !== undefined) anchors.push({ from: fromSource, target: resolved, fragment, href });
    const here = dirname(outputFor(fromSource));
    const rel = relative(here, target).split(sep).join("/");
    return `${rel === "" ? "." : rel}${anchor}`;
  }

  if (!existsSync(join(ROOT, resolved))) dead.push(`${fromSource} → ${href}`);
  return `${BLOB}/${resolved}${anchor}`;
}

const STYLE = `
:root{--bg:#fbfbfa;--fg:#1c1c1a;--muted:#5d5d57;--rule:#e2e2dd;--accent:#8a5a2b;--code:#f2f1ed}
@media (prefers-color-scheme:dark){:root{--bg:#16161a;--fg:#e6e6e1;--muted:#a0a099;--rule:#2c2c31;--accent:#d3a06a;--code:#1e1e23}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}
.wrap{display:grid;grid-template-columns:16rem minmax(0,1fr);gap:3rem;max-width:74rem;margin:0 auto;padding:2rem 1.5rem 6rem}
nav{position:sticky;top:2rem;align-self:start;max-height:calc(100vh - 4rem);overflow:auto;font-size:.9rem}
nav .brand{font-weight:650;letter-spacing:-.01em;margin-bottom:.25rem;display:block;color:var(--fg);text-decoration:none}
nav .tagline{color:var(--muted);font-size:.8rem;margin-bottom:1.5rem}
nav h2{font-size:.7rem;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);margin:1.5rem 0 .5rem}
nav ul{list-style:none;margin:0;padding:0}
nav li{margin:.3rem 0}
nav a{text-decoration:none;color:var(--fg);opacity:.82}
nav a:hover{opacity:1;text-decoration:underline}
nav a[aria-current=page]{color:var(--accent);opacity:1;font-weight:600}
.try{display:inline-block;margin:1rem 0 .5rem;padding:.5rem .9rem;border:1px solid var(--accent);border-radius:.4rem;color:var(--accent);text-decoration:none;font-weight:600;font-size:.85rem}
main{min-width:0}
main :is(h1,h2,h3,h4){line-height:1.25;letter-spacing:-.015em;margin:2.2rem 0 .8rem}
main h1{margin-top:0;font-size:2rem}
main h2{font-size:1.4rem;border-bottom:1px solid var(--rule);padding-bottom:.3rem}
main h3{font-size:1.1rem}
main :is(h1,h2,h3,h4,h5,h6)>a.anchor{color:var(--muted);text-decoration:none;opacity:0;padding-left:.4rem;font-weight:400}
main :is(h1,h2,h3,h4,h5,h6):hover>a.anchor{opacity:1}
code{background:var(--code);padding:.12em .35em;border-radius:.25rem;font-size:.88em;font-family:ui-monospace,"Cascadia Code",Consolas,monospace}
pre{background:var(--code);padding:1rem;border-radius:.5rem;overflow-x:auto}
pre code{background:none;padding:0;font-size:.82rem;line-height:1.55}
blockquote{margin:1.2rem 0;padding:.1rem 0 .1rem 1rem;border-left:3px solid var(--rule);color:var(--muted)}
.tablewrap{overflow-x:auto;margin:1.2rem 0}
table{border-collapse:collapse;font-size:.88rem;min-width:100%}
th,td{border:1px solid var(--rule);padding:.45rem .7rem;text-align:left;vertical-align:top}
th{background:var(--code);font-weight:600}
hr{border:0;border-top:1px solid var(--rule);margin:2.5rem 0}
img{max-width:100%}
footer{grid-column:1/-1;margin-top:4rem;padding-top:1.5rem;border-top:1px solid var(--rule);color:var(--muted);font-size:.82rem}
@media (max-width:60rem){.wrap{grid-template-columns:1fr;gap:1.5rem}nav{position:static;max-height:none}}
`.trim();

function shell({ title, body, currentSource, depth }) {
  const up = depth === 0 ? "." : Array.from({ length: depth }, () => "..").join("/");
  const navHtml = nav
    .map(
      (group) =>
        `<h2>${group.title}</h2><ul>` +
        group.items
          .map((source) => {
            const href = `${up}/${pages.get(source)}`.replace(/^\.\//, "");
            const current = source === currentSource ? ' aria-current="page"' : "";
            return `<li><a href="${href}"${current}>${escapeHtml(labelOf(source))}</a></li>`;
          })
          .join("") +
        `</ul>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<!--
  Stricter than the app's policy, because these pages can afford it: they are static HTML with one inline
  stylesheet and no script at all. "default-src 'none'" with no script-src means script cannot run here even if
  something later injected a tag. frame-ancestors is deliberately absent — it is ignored in a meta tag, and listing
  a directive that does nothing is how a policy comes to be believed rather than read.

  A meta tag rather than a header for the same reason as the app's: a static Pages deploy cannot set headers.
-->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'none'; base-uri 'none'">
<title>${escapeHtml(title === "MassingViewer" ? title : `${title} — MassingViewer`)}</title>
<meta name="description" content="MassingViewer — an offline-capable browser CAD studio: view and author 3D models, generate 2D plans, mark them up.">
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
<nav>
<a class="brand" href="${up}/index.html">⬡ MassingViewer</a>
<div class="tagline">A browser CAD studio where a plan is a live view of the model.</div>
<a class="try" href="${up}/demo/">Open the demo →</a>
${navHtml}
</nav>
<main>${body}</main>
<footer>MIT licensed. <a href="${REPO}">Source on GitHub</a>. Documentation built from the repository at deploy time, so it cannot drift from the commit it describes.</footer>
</div>
</body>
</html>
`;
}

function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const dead = [];
const anchors = [];
/** External images dropped rather than fetched at page load. Reported, never silent — see the image renderer. */
const stripped = [];
/** Heading slugs actually emitted, per page — the ground truth every `#fragment` link is checked against. */
const slugsBySource = new Map();
let currentSource = "README.md";
let used = new Set();

marked.use({
  gfm: true,
  renderer: {
    heading(token) {
      const inner = this.parser.parseInline(token.tokens);
      const id = slug(token.text, used);
      // A self-link on every heading, so a reader can cite a paragraph of a decision record rather than the whole
      // document. Aria-hidden because "§" read aloud after every heading is noise, not navigation.
      return `<h${token.depth} id="${id}">${inner}<a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">§</a></h${token.depth}>\n`;
    },
    link(token) {
      const inner = this.parser.parseInline(token.tokens);
      // A link whose only content was a stripped external image — a CI badge — would render as an empty anchor:
      // invisible, focusable, and announced by a screen reader as a link to nothing. Drop it with its image.
      if (inner.trim() === "") return "";
      const href = rewrite(token.href, currentSource, dead, anchors);
      // An external link gets `rel="noreferrer"` because these documents cite a lot of third-party projects and
      // none of them need this site's referrer.
      const external = /^https?:/i.test(href) ? ' rel="noreferrer"' : "";
      const title = token.title === null || token.title === undefined ? "" : ` title="${escapeHtml(token.title)}"`;
      return `<a href="${href}"${title}${external}>${inner}</a>`;
    },
    image(token) {
      /**
       * External images are removed, and counted rather than removed quietly.
       *
       * The README's CI and licence badges are `img.shields.io` and `github.com` URLs. They belong on GitHub and
       * not here: every visitor to a documentation page would make a request to a third party that logs it, which
       * contradicts `docs/privacy.md` — no telemetry by default, no egress nobody asked for — and would be blocked
       * anyway by this page's `img-src 'self' data:`, so the visible result would be broken image icons.
       *
       * Counted because a *deliberate* external diagram must not disappear silently. The build prints how many it
       * dropped; if that number is ever surprising, the image should be committed to the repository instead.
       */
      if (/^https?:/i.test(token.href)) {
        stripped.push(`${currentSource} → ${token.href}`);
        return "";
      }
      const src = rewrite(token.href, currentSource, dead, anchors);
      const title = token.title === null || token.title === undefined ? "" : ` title="${escapeHtml(token.title)}"`;
      return `<img src="${src}" alt="${escapeHtml(token.text)}"${title}>`;
    },
    table(token) {
      // These documents are full of wide comparison tables. Without a scroll container the page itself scrolls
      // sideways on a phone, which makes every other paragraph unreadable too.
      const rendered = this.constructor.prototype.table.call(this, token);
      return `<div class="tablewrap">${rendered}</div>`;
    },
  },
});

if (existsSync(OUT)) rmSync(OUT, { recursive: true });

for (const source of sources) {
  currentSource = source;
  // A fresh set per page, and kept afterwards: the de-duplication counter must not leak between documents, and
  // these slugs are what the fragment check below compares every `#…` link against.
  used = new Set();
  slugsBySource.set(source, used);
  const markdown = readFileSync(join(ROOT, source), "utf8");
  const target = pages.get(source);
  const html = shell({
    title: titles.get(source),
    body: marked.parse(markdown),
    currentSource: source,
    depth: target.split("/").length - 1,
  });
  const file = join(OUT, target);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html, "utf8");
}

/**
 * `--docs-only` renders the documentation and skips the demo.
 *
 * So the link gate below can run on every pull request in seconds, without a Vite build. `pages.yml` runs the
 * full build, because a documentation site that advertises a demo it does not contain is worse than no site — and
 * that is the case the missing-directory error below refuses to paper over.
 */
const docsOnly = process.argv.includes("--docs-only");

// Copied in rather than rebuilt: `pages.yml` builds the demo first, and building it twice would let the site ship
// a different bundle from the one the bundle-budget gate measured.
const demo = join(ROOT, "apps/demo/dist");
if (!docsOnly && !existsSync(demo)) {
  console.error(
    `build-site: ${relative(ROOT, demo)} does not exist. Run \`npm run build --workspace @massing/demo\` first — ` +
      `the site is documentation *and* a working demo, and shipping the documentation alone would be a page that ` +
      `advertises something it does not contain.`,
  );
  process.exit(1);
}
if (!docsOnly) cpSync(demo, join(OUT, "demo"), { recursive: true });

/**
 * Every internal link resolves.
 *
 * The gate that makes this build worth trusting. `check-doc-paths.mjs` already asserts that backticked citations
 * resolve in the *repository*; this asserts that markdown links resolve in the *site*, which is a different claim —
 * a link to a file that exists but is not published becomes a GitHub URL, and a link to nothing becomes a 404 that
 * only a visitor would ever find.
 */
const brokenAnchors = anchors.filter(({ target, fragment }) => !(slugsBySource.get(target)?.has(fragment) ?? false));

if (dead.length > 0 || brokenAnchors.length > 0) {
  console.error(`build-site: ${dead.length + brokenAnchors.length} link(s) go nowhere:\n`);
  for (const entry of dead) console.error(`  • dead path    ${entry}`);
  for (const { from, target, href } of brokenAnchors) {
    console.error(`  • dead anchor  ${from} → ${href}  (no such heading in ${target})`);
  }
  console.error(
    `\n  A link that resolves to a page but not to a heading scrolls nowhere and reports nothing, which is why it\n` +
      `  is checked here rather than left to a visitor to discover.\n`,
  );
  process.exit(1);
}

const count = sources.length;
console.log(
  `build-site: ${count} page(s)${docsOnly ? " (--docs-only, no demo)" : " + the demo"}, ` +
    `${anchors.length} heading link(s) checked → ${relative(ROOT, OUT)}/`,
);
if (stripped.length > 0) {
  console.log(`  dropped ${stripped.length} external image(s), which would be a third-party request per visit:`);
  for (const entry of stripped) console.log(`    ${entry}`);
}
