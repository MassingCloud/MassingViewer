# Accessibility

Target: **WCAG 2.2 AA**. What follows separates what is *enforced*, what is *implemented but not enforceable by a
tool*, and what is *not done yet* — because an accessibility page that blurs those three is worse than no page.
A procurement reviewer needs the third list, and a page without one reads as a page nobody checked.

## The gate

`e2e/a11y.spec.ts` runs `axe-core` and fails on **`serious` and `critical`**. `moderate` and `minor` findings
print to the run log and do not fail the build.

Four states are scanned, not one route:

| Scan | Why it is separate |
|---|---|
| Viewer, initial | The default state |
| Every ribbon tab | Each tab is a different panel. A scan of the default tab says nothing about the other eight |
| Plan pane | Generated SVG, not authored markup — the surface most likely to emit something unlabelled |
| Properties, with a selection | The populated state. Scanning the empty one is scanning the easy case |

It runs on Chromium only, on purpose. axe evaluates the DOM, and the DOM is identical across browsers; the one
rule family that genuinely differs is contrast, which axe computes from rendered styles, so cross-browser
antialiasing differences there produce disagreements about the renderer rather than about the markup. Layout and
touch behaviour across WebKit, Firefox and iPad are covered by the other four E2E projects.

**Why the gate is not at zero.** A gate that fails on `minor` trains the next person to add rule exclusions, and
an exclusion is permanent in a way that a `moderate` line in a log is not. `docs/testing.md` applies the same
reasoning to visual regression and frame time: one gate people trust beats ten they route around.

It has been sabotage-tested. An unlabelled icon button and a low-contrast span were injected and the gate failed
with `CRITICAL button-name` and `SERIOUS color-contrast`, naming the selector in both cases. A gate whose failure
has never been observed is an assumption.

### What it caught

Five `<dl>` panels rendered a bare `<dd class="muted">Click an element</dd>` — a definition with nothing being
defined, `serious` under `definition-list`, and to a screen reader a value whose term is missing. Five sites, one
copied inline string. `placeholder()` in `apps/demo/src/main.ts` now emits the `<dt>`, so the shape cannot recur
by copy.

## The ribbon

Implemented, and unit-tested in `packages/ribbon/src/ribbon.test.ts` — none of this is axe-detectable, which is
why it has its own tests:

- `role="toolbar"` per group, `role="tab"`/`aria-selected` on the tab strip, `aria-expanded` on collapsed-group
  dropdowns, `aria-labelledby` tying each panel to its tab.
- **Roving tabindex.** Arrow keys move within a group, `Home`/`End` jump to its ends, `Tab` moves between groups.
  The first item of every group is its tab stop, set at construction — not only for the active tab, because
  groups on unvisited tabs previously had no tabbable button at all and `Tab` found nothing to focus.
- **`aria-disabled`, never `disabled`.** A `disabled` button is unfocusable and unannounced, so dimming it would
  hide the very thing dimming exists to teach. A dimmed control stays in the tab order, announces its reason
  from `data-reason`, and does nothing when pressed.
- **A live region** announces arming and refusals.
- **Reachability at every width.** `packages/ui-model/src/ribbon.test.ts` asserts every tool remains reachable
  from 320 px to 3840 px. massing shipped a real bug here — a hard cap of 8 primary tools silently demoted Move
  when Push/pull was promoted — so this failure class is designed out rather than tested out.

## The 3D canvas: the honest limit

**A WebGL canvas is opaque to assistive technology.** Nothing inside it — geometry, selection, the model tree as
rendered — is available to a screen reader, and no amount of ARIA changes that.

What that does *not* excuse is the element being anonymous. The canvas carries `role="img"`, an `aria-label`
(overridable via `ViewportOptions.label`, so a host that knows it is showing "Tower-A, level 3" can say so), and
`tabindex="0"` so it is focusable at all — orbit and walk both bind keys, and a control you cannot focus is a
control a keyboard user does not have.

`role="application"` is deliberately **not** used. It instructs a screen reader to surrender its own key handling
because the element implements a complete keyboard interface. This one does not, and claiming otherwise would
take away a working navigation mode in exchange for nothing.

### The alternative, and its current status

The genuine answer to an inaccessible canvas is not to describe the canvas — it is to offer a path that does not
require it. `packages/geometry-math/src/cadCommands.ts` parses `WALL 0,0 5,0`: a keyboard-only, screen-reader-
legible way to author geometry precisely, which is a real accessibility story rather than a consolation prize,
and one no browser-BIM competitor offers.

**It is a parser today, not a feature.** The grammar is implemented and tested; no command-line UI is wired into
any app. Until one is, this section describes a design, and the honest status of keyboard-only authoring is
*not available*. It lands with the M6 authoring tools.

## Known gaps

| Gap | Why it is not done |
|---|---|
| **No `aria-pressed` on armed tools.** Arming announces via the live region, but nothing records sustained state, so a screen reader user who tabs away and back cannot tell which tool is armed. | `RibbonItem` has no toggle-vs-action distinction, and `aria-pressed` on a one-shot action like Fit announces a toggle that does not exist. Doing it correctly means classifying all 30 tools in `ui-model`; guessing the classification would encode 30 unverified claims. Lands with M6, when the tools it describes exist. |
| **No keyboard authoring path.** See above — `cadCommands` has no UI. | M6. |
| **No screen-reader testing with real assistive technology.** axe checks markup, not experience; NVDA/VoiceOver find things it cannot. | Not automatable in CI. Needs a manual pass, and this table is the record that it has not happened. |
| **`moderate` and `minor` findings are logged, not gated.** | Deliberate — see above. The log is the record. |
| **Reduced-motion preference is not honoured** by the viewport's camera animation. | `prefers-reduced-motion` is unread. Small, real, and unscheduled. |

## Running it

```bash
npm run e2e -- --project=a11y
```

Failures name the rule, the impact, the selector and axe's own suggested fix, so the usual case needs no report.
The HTML report is uploaded as a CI artifact when the leg fails.
