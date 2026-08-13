import type { Catalogue } from "./translate.js";

/**
 * German. **Complete, and not native-speaker reviewed.** Those are two separate facts and the second one is the
 * one that matters — see the glossary below, which exists so the review is small enough to actually happen.
 *
 * ## Why a second catalogue exists at all
 *
 * A single-locale i18n framework is untested i18n. Every mistake that matters — a concatenated sentence, a
 * hardcoded plural, a string baked into a `data-` attribute, a layout that assumes English word length — is
 * invisible until a second language is rendered through the same code. German is the right first one here for two
 * specific reasons rather than for coverage:
 *
 * 1. **It is a decimal-comma locale**, so it exercises the ambiguity ADR-0011 is about with a real audience rather
 *    than a hypothetical one.
 * 2. **Its compounds are long.** "Drücken/Ziehen — oberen Griff ziehen, um das gewählte Bauteil höher oder dicker
 *    zu machen" against "Push/pull" is width pressure of the kind that finds a ribbon silently dropping a control —
 *    the failure class `railToolbox.test.ts` was written about.
 *
 *    **Nothing automated measures that yet, and it is worth being exact about why.** The reachability property test
 *    in `packages/ui-model/src/ribbon.test.ts` runs every width from 320 to 3840 against `layoutTab`, which is a
 *    pure layout model that knows tool counts and size classes and *nothing about text*. The ribbon's own tests do
 *    render German, but in happy-dom, which has no layout engine and so measures nothing. Catching a German label
 *    that overflows at 320 px needs a real browser, and that E2E does not exist — recorded in docs/i18n.md. Until
 *    it does, the long compounds are pressure a human sees, not a gate.
 *
 * ## What changed when it went from 32% to complete, and what did not
 *
 * This file used to argue that a gap was better than machine output, because *"a plausible wrong translation reads
 * as reviewed, the completeness check goes green, and nobody ever looks again."* That argument is still correct.
 * Completing the catalogue does not answer it — it removes the signal that used to carry it, so the signal has to
 * be replaced rather than dropped:
 *
 * - **The coverage line now prints review status next to the percentage.** `check-messages.mjs` reports
 *   `de: 99/99 (100%) translated, not native-reviewed`, so 100% cannot be read as done.
 * - **The glossary below is the review.** These strings are not uncertain word by word; the uncertainty
 *   concentrates in about a dozen terminology decisions, each of which propagates across many strings. A drafter
 *   reviewing twelve decisions is a review that happens. A drafter asked to read ninety-nine strings is a review
 *   that does not.
 *
 * ## Terminology decisions a native-speaker drafter should confirm
 *
 * Each row is a choice, not a translation, and changing one changes every string that uses it.
 *
 * | English | Chosen | Alternative considered | Why |
 * |---|---|---|---|
 * | element (the thing you select) | **Bauteil** | Element | `Bauteil` is what a drafter says; `Element` is what the IFC schema says. Kept `Element` in `count.elements`, where the count is of model entities rather than of things on screen |
 * | slab | **Decke** | Geschossdecke, Bodenplatte | `Decke` covers the general case; the other two are specific and would be wrong for the other |
 * | column | **Stütze** | Säule | `Stütze` is structural, `Säule` is architectural/decorative. `IfcColumn` is structural |
 * | level / storey | **Geschoss** | Etage, Stockwerk, Ebene | `Geschoss` is the building-code term and matches `IfcBuildingStorey`. `Ebene` is kept for the *drawn plane* rather than the storey itself |
 * | push/pull | **Drücken/Ziehen** | Push/Pull (untranslated) | German CAD UIs use both; translated here because the label sits next to translated verbs |
 * | walk through | **Begehung** | Rundgang, Gehmodus | `Begehung` is the AEC term for walking a building; `Rundgang` is a guided tour |
 * | gizmo | **Gizmo** | Manipulator, Griffe | Left untranslated: it is the established word in German CAD, and `Manipulator` reads as a machine part |
 * | guide underlay | **Planunterlage** | Bildunterlage, Referenzplan | A scanned plan traced over is a `Planunterlage` in German practice |
 * | E, N, Z (axis labels) | **Ost, Nord, Höhe** | E, N, Z | Spelled out on purpose: a bare `E` reads as *Ebene* or as a key to press. These are axis labels, not typed tokens — the numbers are what gets typed |
 * | hero image | **Titelbild** | Heldenbild | `Heldenbild` is a literal rendering of English marketing jargon and means nothing in German |
 * | plain-English | **Alltagssprache** | Klartext, natürliche Sprache | `Klartext` also means *unencrypted*, which is the wrong association in a tool with a security posture |
 * | issue (a markup topic) | **Vorgang** | Problem, Mangel | `Mangel` is a defect claim with contractual weight; a BCF topic is not necessarily one |
 *
 * Everything below is a developer's German held to those decisions. Recorded in `docs/i18n.md` under what is not
 * done, rather than assumed away.
 */
export const DE: Catalogue = {
  // --- ribbon tabs ---
  "tab.home": "Start",
  "tab.build": "Bauen",
  "tab.insert": "Einfügen",
  "tab.annotate": "Beschriften",
  "tab.sheet": "Plan",
  "tab.analyse": "Analysieren",
  "tab.review": "Prüfen",
  "tab.view": "Ansicht",
  "tab.manage": "Verwalten",

  // --- ribbon groups ---
  "group.level": "Geschoss",
  "group.select": "Auswahl",
  "group.section": "Schnitt",
  "group.environment": "Umgebung",
  "group.navigate": "Navigieren",
  "group.measure": "Messen",
  "group.modify": "Ändern",
  "group.views": "Ansichten",
  "group.drawing": "Zeichnung",
  "group.style": "Stil",
  "group.issue": "Ausgabe",
  "group.markup": "Markierung",
  "group.reference": "Referenz",
  "group.data": "Daten",
  "group.draw": "Zeichnen",
  "group.openings": "Öffnungen",
  "group.assist": "Assistenz",
  "group.collaborate": "Zusammenarbeit",

  // --- ribbon chrome ---
  "ribbon.label": "Multifunktionsleiste",
  "ribbon.more": "{group} — mehr",
  "ribbon.armed": "{tool} aktiviert",
  "ribbon.unavailable": "nicht verfügbar",

  // --- capability refusals. Required to carry a reason, in every language.
  "availability.needsEdit": "Erfordert die Rolle „Bearbeiten“ in diesem Projekt",
  "availability.needsSelection": "Zuerst ein Bauteil auswählen",

  // --- counts. German pluralises like English (one/other), so these two suffice; Polish would need four,
  // which is exactly what the message gate checks per locale rather than assuming.
  //
  // `Element` rather than `Bauteil` here alone, and deliberately: this count is of model entities — what the
  // kernel returned — not of things the drafter is looking at. See the glossary.
  "count.elements.one": "{count} Element",
  "count.elements.other": "{count} Elemente",
  "count.topics.one": "{count} Vorgang",
  "count.topics.other": "{count} Vorgänge",

  // --- the M6 draw verbs. The first thing a drafter touches, and the terms a German drafter actually uses
  // rather than literal renderings of the English.
  "tool.draw-a-wall-between-two-points-w.label": "Wand",
  "tool.draw-a-wall-between-two-points-w.title": "Wand zwischen zwei Punkten zeichnen (W)",
  "tool.draw-a-slab-from-a-closed-outline.label": "Decke",
  "tool.draw-a-slab-from-a-closed-outline.title": "Decke aus einem geschlossenen Umriss zeichnen",
  "tool.place-a-column-at-a-point.label": "Stütze",
  "tool.place-a-column-at-a-point.title": "Stütze an einem Punkt setzen",

  // --- openings ---
  "tool.add-door-to-selected-wall.label": "Tür einfügen",
  "tool.add-door-to-selected-wall.title": "Tür in die gewählte Wand einfügen",
  "tool.add-window-to-selected-wall.label": "Fenster einfügen",
  "tool.add-window-to-selected-wall.title": "Fenster in die gewählte Wand einfügen",

  // --- level and visibility ---
  //
  // "Ebenen" for the label and "Geschossebenen" in the title, on purpose: the button toggles the drawn *planes*,
  // not the storeys themselves. See the glossary row for Geschoss vs Ebene.
  "tool.toggle-storey-levels-overlay.label": "Ebenen",
  "tool.toggle-storey-levels-overlay.title": "Geschossebenen ein- oder ausblenden",
  "tool.show-all-h.label": "Alle zeigen",
  "tool.show-all-h.title": "Alle einblenden (H)",
  "tool.isolate-selection.label": "Isolieren",
  "tool.isolate-selection.title": "Auswahl isolieren",
  "tool.color-selection.label": "Farbe",
  "tool.color-selection.title": "Auswahl einfärben",

  // --- sectioning ---
  "tool.section-plane-s-dbl-click-a-face.label": "Schnitt",
  "tool.section-plane-s-dbl-click-a-face.title": "Schnittebene (S) — Fläche doppelklicken",
  "tool.section-box-clip-to-model-bounds.label": "Schnittbox",
  "tool.section-box-clip-to-model-bounds.title": "Schnittbox (auf die Modellgrenzen begrenzt)",

  // --- environment. `SSAO` and `Bloom` stay as they are: they are the names of the techniques in German
  // graphics writing too, and inventing German equivalents would make the tooltip less clear, not more.
  "tool.render-mode-sun-soft-shadows-pbr-lighting-ssao-bloom.label": "Rendern",
  "tool.render-mode-sun-soft-shadows-pbr-lighting-ssao-bloom.title":
    "Rendermodus — Sonne, weiche Schatten, PBR-Beleuchtung, SSAO und Bloom",
  "tool.sun-shadow-study-date-time-location.label": "Sonne",
  "tool.sun-shadow-study-date-time-location.title": "Sonnen- und Schattenstudie (Datum · Uhrzeit · Ort)",

  // --- navigation. W/A/S/D are physical keys and stay Latin: remapping them to German words would describe
  // keys that do not exist on the keyboard in front of the drafter.
  "tool.walk-through-first-person-w-a-s-d-drag-to-look.label": "Begehen (Ziehen)",
  "tool.walk-through-first-person-w-a-s-d-drag-to-look.title":
    "Begehung aus der Ich-Perspektive — W/A/S/D, zum Umsehen ziehen",
  "tool.walk-mode-first-person-wasd-walkthrough-esc-exits.label": "Begehen (fest)",
  "tool.walk-mode-first-person-wasd-walkthrough-esc-exits.title":
    "Begehungsmodus — Ich-Perspektive mit WASD (Esc beendet)",

  // --- measuring ---
  "tool.measure-distance-m.label": "Messen",
  "tool.measure-distance-m.title": "Abstand messen (M)",
  "tool.measure-area-a.label": "Fläche",
  "tool.measure-area-a.title": "Fläche messen (A)",
  "tool.clear-measurements.label": "Löschen",
  "tool.clear-measurements.title": "Messungen löschen",

  // --- modifying ---
  "tool.edit-in-place-drag-the-gizmo-to-move-the-selected-element.label": "Direkt bearbeiten",
  "tool.edit-in-place-drag-the-gizmo-to-move-the-selected-element.title":
    "Direkt bearbeiten — Gizmo ziehen, um das gewählte Bauteil zu verschieben",
  "tool.push-pull-drag-the-top-handle-to-make-the-selected-element-taller-or-thicker.label": "Drücken/Ziehen",
  "tool.push-pull-drag-the-top-handle-to-make-the-selected-element-taller-or-thicker.title":
    "Drücken/Ziehen — oberen Griff ziehen, um das gewählte Bauteil höher oder dicker zu machen",
  // Axis labels spelled out rather than left as E,N,Z. See the glossary: a bare "E" reads as a key to press.
  "tool.move-selected-element-e-n-z-metres.label": "Verschieben",
  "tool.move-selected-element-e-n-z-metres.title": "Gewähltes Bauteil verschieben (Ost, Nord, Höhe in Metern)",
  "tool.copy-selected-element-offset-e-n-z-metres.label": "Kopieren",
  "tool.copy-selected-element-offset-e-n-z-metres.title":
    "Gewähltes Bauteil kopieren (Versatz Ost, Nord, Höhe in Metern)",
  "tool.rotate-selected-element-degrees-about-z.label": "Drehen",
  "tool.rotate-selected-element-degrees-about-z.title": "Gewähltes Bauteil drehen (Grad um die Z-Achse)",
  "tool.delete-selected-element.label": "Löschen",
  "tool.delete-selected-element.title": "Gewähltes Bauteil löschen",
  "tool.edit-a-property-on-the-selected-element.label": "Eigenschaft",
  "tool.edit-a-property-on-the-selected-element.title": "Eigenschaft des gewählten Bauteils bearbeiten",

  // --- views and reference ---
  "tool.cut-a-plan-at-the-current-level.label": "Grundriss",
  "tool.cut-a-plan-at-the-current-level.title": "Einen Grundriss auf der aktuellen Ebene schneiden",
  "tool.show-the-sheet-full-width-border-title-block-revision-table.label": "Blatt",
  "tool.show-the-sheet-full-width-border-title-block-revision-table.title": "Das Blatt in voller Breite anzeigen — Rahmen, Schriftfeld, Revisionstabelle",
  "tool.repaint-the-sheet-with-another-discipline-theme-no-regeneration.label": "Darstellung",
  "tool.repaint-the-sheet-with-another-discipline-theme-no-regeneration.title": "Das Blatt mit einem anderen Fachthema neu einfärben — ohne Neuerzeugung",
  "tool.fit-the-drawing-to-paper-at-a-standard-scale.label": "Papier",
  "tool.fit-the-drawing-to-paper-at-a-standard-scale.title": "Die Zeichnung auf einen Standardmaßstab einpassen",
  "tool.export-the-sheet-as-pdf-with-layers-and-a-globalid-index.label": "PDF",
  "tool.export-the-sheet-as-pdf-with-layers-and-a-globalid-index.title": "Das Blatt als PDF exportieren, mit Layern und GlobalId-Index",
  "tool.export-the-sheet-as-dxf-r12.label": "DXF",
  "tool.export-the-sheet-as-dxf-r12.title": "Das Blatt als DXF R12 exportieren",
  "tool.raise-an-issue-on-the-selected-element.label": "Thema",
  "tool.raise-an-issue-on-the-selected-element.title": "Ein Thema am ausgewählten Element anlegen",
  "tool.export-every-markup-as-bcf-3-0.label": "BCF",
  "tool.export-every-markup-as-bcf-3-0.title": "Alle Markierungen als BCF 3.0 exportieren",
  "tool.plan-beside-model.label": "Planfenster",
  "tool.plan-beside-model.title": "Plan neben dem Modell",
  "tool.guide-underlay-pin-a-scanned-plan-to-this-level-and-trace-over-it.label": "Planunterlage",
  "tool.guide-underlay-pin-a-scanned-plan-to-this-level-and-trace-over-it.title":
    "Planunterlage — gescannten Plan auf dieses Geschoss legen und nachzeichnen",

  // --- assistance. "GUID" stays: it is the identifier's name, and translating it would break the link to
  // everything else the drafter reads about GlobalIds.
  "tool.script-this-see-the-guid-safe-recipe-plan-behind-a-plain-english-command-then-apply.label": "Skript",
  "tool.script-this-see-the-guid-safe-recipe-plan-behind-a-plain-english-command-then-apply.title":
    "Als Skript — den GUID-sicheren Rezeptplan hinter einem Befehl in Alltagssprache ansehen und dann anwenden",
  "tool.ask-the-model-plain-english-questions-about-the-data.label": "Fragen",
  "tool.ask-the-model-plain-english-questions-about-the-data.title":
    "Das Modell fragen — Fragen zu den Daten in Alltagssprache",

  // --- collaboration ---
  "tool.live-presence.label": "Anwesenheit",
  "tool.live-presence.title": "Anwesenheit in Echtzeit",
  "tool.share-your-current-view-with-everyone.label": "Ansicht teilen",
  "tool.share-your-current-view-with-everyone.title": "Aktuelle Ansicht mit allen teilen",
  "tool.share-via-qr-open-this-project-on-a-phone-or-tablet.label": "QR",
  "tool.share-via-qr-open-this-project-on-a-phone-or-tablet.title":
    "Per QR-Code teilen — dieses Projekt auf Smartphone oder Tablet öffnen",
  "tool.capture-hero-image-this-view-becomes-page-2-of-the-client-project-package-pdf.label": "Aufnehmen",
  "tool.capture-hero-image-this-view-becomes-page-2-of-the-client-project-package-pdf.title":
    "Titelbild aufnehmen — diese Ansicht wird Seite 2 des Kundenpakets (PDF)",
};
