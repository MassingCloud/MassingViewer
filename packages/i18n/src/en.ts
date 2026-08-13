/**
 * The English catalogue, and the source of `MessageKey`.
 *
 * ## Generated for the tool entries, hand-written for the rest
 *
 * The `tab.*`, `group.*` and `tool.*` entries were generated from `TABS`, `buildRibbon()` and `TOOLS` in
 * `@massing/ui-model`, so English output is unchanged by construction rather than by careful transcription of
 * ninety strings. They are committed rather than generated at build time: a catalogue is a translator's input
 * file, and a generated one cannot be diffed, reviewed, or annotated with the context a translator needs.
 *
 * ## Keys, and why the tool ids are reused as keys
 *
 * A tool's id is already derived from its English title and already stable — it is the `data-tool` attribute the
 * E2E suite selects on. Reusing it as the message key means no second naming scheme to keep in sync, and it means
 * `everyToolMapped()` and the message-completeness gate are checking the same set of names from two directions.
 *
 * ## `as const satisfies`
 *
 * `as const` is what makes `MessageKey` a union of the literal keys rather than `string`, so a typo in a `t()` call
 * is a compile error. `satisfies Record<string, string>` keeps the values checked without widening the keys — the
 * combination is the point, and an explicit `Record<MessageKey, string>` annotation would defeat it by making
 * `MessageKey` circular.
 */
export const EN = {
  // --- ribbon tabs -------------------------------------------------------------------------------
  "tab.home": "Home",
  "tab.build": "Build",
  "tab.insert": "Insert",
  "tab.annotate": "Annotate",
  "tab.sheet": "Sheet",
  "tab.analyse": "Analyse",
  "tab.review": "Review",
  "tab.view": "View",
  "tab.manage": "Manage",

  // --- ribbon groups -----------------------------------------------------------------------------
  "group.level": "Level",
  "group.select": "Select",
  "group.section": "Section",
  "group.environment": "Environment",
  "group.navigate": "Navigate",
  "group.measure": "Measure",
  "group.modify": "Modify",
  "group.views": "Views",
  "group.drawing": "Drawing",
  "group.style": "Style",
  "group.issue": "Issue",
  "group.markup": "Markup",
  "group.reference": "Reference",
  "group.data": "Data",
  "group.draw": "Draw",
  "group.openings": "Openings",
  "group.assist": "Assist",
  "group.collaborate": "Collaborate",

  // --- the 30 inherited tools. Generated from TOOLS, so English output is unchanged by construction.
  "tool.toggle-storey-levels-overlay.label": "Levels",
  "tool.toggle-storey-levels-overlay.title": "Toggle storey levels overlay",
  "tool.show-all-h.label": "Show all",
  "tool.show-all-h.title": "Show all (H)",
  "tool.isolate-selection.label": "Isolate",
  "tool.isolate-selection.title": "Isolate selection",
  "tool.color-selection.label": "Colour",
  "tool.color-selection.title": "Color selection",
  "tool.section-plane-s-dbl-click-a-face.label": "Section",
  "tool.section-plane-s-dbl-click-a-face.title": "Section plane (S) — dbl-click a face",
  "tool.section-box-clip-to-model-bounds.label": "Section box",
  "tool.section-box-clip-to-model-bounds.title": "Section box (clip to model bounds)",
  "tool.render-mode-sun-soft-shadows-pbr-lighting-ssao-bloom.label": "Render",
  "tool.render-mode-sun-soft-shadows-pbr-lighting-ssao-bloom.title": "Render mode — sun, soft shadows, PBR lighting, SSAO & bloom",
  "tool.sun-shadow-study-date-time-location.label": "Sun",
  "tool.sun-shadow-study-date-time-location.title": "Sun & shadow study (date · time · location)",
  "tool.walk-through-first-person-w-a-s-d-drag-to-look.label": "Walk (drag)",
  "tool.walk-through-first-person-w-a-s-d-drag-to-look.title": "Walk through (first-person — W/A/S/D, drag to look)",
  "tool.walk-mode-first-person-wasd-walkthrough-esc-exits.label": "Walk (locked)",
  "tool.walk-mode-first-person-wasd-walkthrough-esc-exits.title": "Walk mode — first-person WASD walkthrough (Esc exits)",
  "tool.measure-distance-m.label": "Measure",
  "tool.measure-distance-m.title": "Measure distance (M)",
  "tool.measure-area-a.label": "Area",
  "tool.measure-area-a.title": "Measure area (A)",
  "tool.clear-measurements.label": "Clear",
  "tool.clear-measurements.title": "Clear measurements",
  "tool.edit-in-place-drag-the-gizmo-to-move-the-selected-element.label": "Edit in place",
  "tool.edit-in-place-drag-the-gizmo-to-move-the-selected-element.title": "Edit in place — drag the gizmo to move the selected element",
  "tool.push-pull-drag-the-top-handle-to-make-the-selected-element-taller-or-thicker.label": "Push/pull",
  "tool.push-pull-drag-the-top-handle-to-make-the-selected-element-taller-or-thicker.title": "Push/pull — drag the top handle to make the selected element taller or thicker",
  "tool.cut-a-plan-at-the-current-level.label": "Cut plan",
  "tool.cut-a-plan-at-the-current-level.title": "Cut a plan at the current level",
  "tool.show-the-sheet-full-width-border-title-block-revision-table.label": "Sheet",
  "tool.show-the-sheet-full-width-border-title-block-revision-table.title": "Show the sheet full width — border, title block, revision table",
  "tool.repaint-the-sheet-with-another-discipline-theme-no-regeneration.label": "Theme",
  "tool.repaint-the-sheet-with-another-discipline-theme-no-regeneration.title": "Repaint the sheet with another discipline theme — no regeneration",
  "tool.fit-the-drawing-to-paper-at-a-standard-scale.label": "Paper",
  "tool.fit-the-drawing-to-paper-at-a-standard-scale.title": "Fit the drawing to paper at a standard scale",
  "tool.export-the-sheet-as-pdf-with-layers-and-a-globalid-index.label": "PDF",
  "tool.export-the-sheet-as-pdf-with-layers-and-a-globalid-index.title": "Export the sheet as PDF, with layers and a GlobalId index",
  "tool.export-the-sheet-as-dxf-r12.label": "DXF",
  "tool.export-the-sheet-as-dxf-r12.title": "Export the sheet as DXF R12",
  "tool.raise-an-issue-on-the-selected-element.label": "Issue",
  "tool.raise-an-issue-on-the-selected-element.title": "Raise an issue on the selected element",
  "tool.export-every-markup-as-bcf-3-0.label": "BCF",
  "tool.export-every-markup-as-bcf-3-0.title": "Export every markup as BCF 3.0",
  "tool.plan-beside-model.label": "Plan pane",
  "tool.plan-beside-model.title": "Plan beside model",
  "tool.move-selected-element-e-n-z-metres.label": "Move",
  "tool.move-selected-element-e-n-z-metres.title": "Move selected element (E,N,Z metres)",
  "tool.copy-selected-element-offset-e-n-z-metres.label": "Copy",
  "tool.copy-selected-element-offset-e-n-z-metres.title": "Copy selected element (offset E,N,Z metres)",
  "tool.guide-underlay-pin-a-scanned-plan-to-this-level-and-trace-over-it.label": "Guide underlay",
  "tool.guide-underlay-pin-a-scanned-plan-to-this-level-and-trace-over-it.title": "Guide underlay — pin a scanned plan to this level and trace over it",
  "tool.rotate-selected-element-degrees-about-z.label": "Rotate",
  "tool.rotate-selected-element-degrees-about-z.title": "Rotate selected element (degrees about Z)",
  "tool.delete-selected-element.label": "Delete",
  "tool.delete-selected-element.title": "Delete selected element",
  "tool.edit-a-property-on-the-selected-element.label": "Property",
  "tool.edit-a-property-on-the-selected-element.title": "Edit a property on the selected element",
  "tool.draw-a-wall-between-two-points-w.label": "Wall",
  "tool.draw-a-wall-between-two-points-w.title": "Draw a wall between two points (W)",
  "tool.draw-a-slab-from-a-closed-outline.label": "Slab",
  "tool.draw-a-slab-from-a-closed-outline.title": "Draw a slab from a closed outline",
  "tool.place-a-column-at-a-point.label": "Column",
  "tool.place-a-column-at-a-point.title": "Place a column at a point",
  "tool.add-door-to-selected-wall.label": "Add door",
  "tool.add-door-to-selected-wall.title": "Add door to selected wall",
  "tool.add-window-to-selected-wall.label": "Add window",
  "tool.add-window-to-selected-wall.title": "Add window to selected wall",
  "tool.script-this-see-the-guid-safe-recipe-plan-behind-a-plain-english-command-then-apply.label": "Script",
  "tool.script-this-see-the-guid-safe-recipe-plan-behind-a-plain-english-command-then-apply.title": "Script this — see the GUID-safe recipe plan behind a plain-English command, then apply",
  "tool.ask-the-model-plain-english-questions-about-the-data.label": "Ask",
  "tool.ask-the-model-plain-english-questions-about-the-data.title": "Ask the model — plain-English questions about the data",
  "tool.live-presence.label": "Presence",
  "tool.live-presence.title": "Live presence",
  "tool.share-your-current-view-with-everyone.label": "Share view",
  "tool.share-your-current-view-with-everyone.title": "Share your current view with everyone",
  "tool.share-via-qr-open-this-project-on-a-phone-or-tablet.label": "QR",
  "tool.share-via-qr-open-this-project-on-a-phone-or-tablet.title": "Share via QR — open this project on a phone or tablet",
  "tool.capture-hero-image-this-view-becomes-page-2-of-the-client-project-package-pdf.label": "Capture",
  "tool.capture-hero-image-this-view-becomes-page-2-of-the-client-project-package-pdf.title": "Capture hero image — this view becomes page 2 of the client project package (PDF)",

  // --- ribbon chrome -----------------------------------------------------------------------------
  "ribbon.label": "Ribbon",
  "ribbon.more": "{group} — more",
  "ribbon.armed": "{tool} armed",
  "ribbon.unavailable": "unavailable",

  // --- capability refusals. The reason text is required, never optional: a dimmed control that says
  // "needs Editor" is onboarding, one that says nothing is a support ticket.
  "availability.needsEdit": "Requires the Editor role on this project",
  "availability.needsSelection": "Select an element first",

  // --- counts. `.one`/`.other` are what English needs; a locale with more categories adds its own, and
  // scripts/check-messages.mjs is what checks it has them.
  "count.elements.one": "{count} element",
  "count.elements.other": "{count} elements",
  "count.topics.one": "{count} issue",
  "count.topics.other": "{count} issues",
} as const satisfies Record<string, string>;

/**
 * Every key in the catalogue, as a union.
 *
 * Derived from `EN` rather than declared, so adding a message is one edit and the compiler immediately knows about
 * it everywhere. The direction matters: a hand-maintained union and a catalogue drift apart silently, and the
 * symptom is a key that typechecks and renders as itself.
 */
export type MessageKey = keyof typeof EN;
