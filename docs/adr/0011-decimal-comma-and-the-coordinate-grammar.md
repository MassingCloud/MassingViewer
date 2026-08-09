# ADR-0011 — `3,5` is a point, `2,5` is a number: the decimal comma and the command grammar

**Status:** accepted · 2026-08-08 · relates to ADR-0009

## Context

The plan names this trap explicitly and asks for an ADR and a test:

> **Named trap:** decimal-comma locales conflict with `cadCommands.ts`'s `5,0` coordinate grammar — resolve in an
> ADR and test it.

The conflict is total. `3,5` is the point (3, 5) to an anglophone drafter and the single number 3.5 to most of the
rest of the world, and **both are valid input to this grammar.** No parser can tell them apart from the text
alone.

What makes it worth a decision rather than a guess is the failure mode. There is no error. `WALL 0,0 3,5` draws a
wall, it is simply the wrong wall, and a drafter has no reason to suspect the parser. Compare the polar branch of
the same function, which has carried a comment since extraction about `Number("")` being `0`: *"a sloppy split
would silently draw a wrong wall… a drafter would never notice."* Same class of bug, one character over.

## Decision

**Ambiguity is resolved by an explicit separator, never by locale.**

### 1. Where there is one number, a comma is a decimal separator

No competing reading exists, so accepting it costs nothing and refusing it makes the tool feel broken to most of
its potential users. This applies to:

- `parseLength` in `@massing/core` — settings fields, property edits.
- `parseDynConstraint` in `packages/geometry-math/src/dynInput.ts` — the typed-distance HUD. `2,5<30,5` is two and
  a half metres at thirty and a half degrees; the grammar already split distance from bearing on the `<`.
- A standalone command argument — `WALL 0,0 5,0 2,7` is a 2.7 m wall.
- Either side of a polar `d<a` — `@5,5<0`.

### 2. Where there are two, a comma stays the separator and `;` is the way out

- `3,5` → the point (3, 5). **Unchanged**, and it must stay unchanged.
- `3,5;7,2` → the point (3.5, 7.2). Unambiguous, needing no configuration.

`;` is not invented here: it is the separator decimal-comma locales already use in CSV files and in spreadsheet
formulas, so the population that needs it is the population that already knows it.

### 3. Locale is never consulted by a parser

Two reasons, and the second decides it.

1. **Muscle memory outranks number formatting.** AutoCAD's command grammar is `,`-separated with a `.` decimal in
   every locale it ships in. A drafter's hands already know this.
2. **A locale-dependent parser makes a saved macro mean different things to different people.** Command
   invocations are serialisable *by design* — that is what makes macros, the audit log, replay and the eventual
   CRDT path work. A recorded `WALL 0,0 3,5` that draws one wall for a colleague in Berlin and a different one for
   a colleague in Boston is a data-corruption bug wearing an i18n hat, and it would surface as "the macro is
   broken" long after the cause.

Formatting for *display* is fully locale-aware — `Translator.number()` uses `Intl.NumberFormat`, so a German UI
shows `12.480` and `41 %` with its non-breaking space. **Display is localised; the grammar is a formal language.**

## Consequences

- A German drafter can type every single-number field naturally, and has an unambiguous coordinate form.
- The English form is untouched, and a test asserts the two readings produce *different* points — stated as an
  assertion rather than a comment, because if they ever agree the disambiguation has been lost and one population
  is silently getting the other's geometry.
- The `;` form is not discoverable from the UI yet. It is in `docs/i18n.md`; a hint in the command line belongs
  with the command line, which is not built (see the gaps table there).

### A bug this found

Writing the tests surfaced a real defect in the pre-existing cartesian branch. `Number("")` is `0`, so
`WALL 0,0 5,` resolved to the point (5, 0) — a point the drafter never typed, silently, with no error. The polar
branch had guarded against exactly this since extraction; the cartesian branch beside it never got the guard.
`coordinateParts` now rejects an empty component in either form, and `WALL 0,0,0 5,0,3` still parses, because
`x,y,z` with `z` dropped is documented as valid.

## What was rejected

- **Read the locale and switch separators.** Rejected above: it breaks macro portability, which is a correctness
  property rather than a preference.
- **A user setting for the decimal separator.** Same defect with an extra dialog, plus it makes a paste between
  two colleagues' notes wrong depending on whose settings are loaded.
- **Refuse an ambiguous token and ask.** Attractive, and impossible: `3,5` is not detectably ambiguous. It is a
  well-formed point *and* a well-formed number, so there is nothing to flag. Refusing every comma would refuse the
  grammar's own documented form.
- **`.` as the only decimal separator everywhere.** What the code did before this ADR. Correct for coordinates and
  needlessly hostile in every single-number field, which is most of the fields in the product.
