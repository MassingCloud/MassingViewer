import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * The Ctrl+K palette.
 *
 * ## What it is for, which is not "another way to run commands"
 *
 * It is how a user *finds* a verb they cannot name the location of, and how they learn the keybinding for one
 * they use often. Both are onboarding, and the second is the reason each row shows its chord: a palette that
 * teaches its own shortcuts makes itself unnecessary, which is the correct ambition for a search box.
 *
 * It searches **commands and objects together** — elements, sheets, views, layers — because "where is the thing
 * called Wall-042" and "what is the verb for isolating it" are the same question asked twice, and splitting them
 * across two search boxes means the user has to know which kind of thing they are looking for before they look.
 *
 * ## Accessibility is the hard part, not the fuzzy match
 *
 * A combobox is one of the few widgets where getting ARIA wrong makes it *unusable* rather than merely worse: a
 * screen-reader user needs to hear the highlighted option change as they press Down, and that only happens if
 * `aria-activedescendant` moves while focus stays in the input. Moving focus to the option instead — the obvious
 * implementation — breaks typing entirely.
 */

export interface PaletteEntry {
  readonly id: string;
  readonly label: string;
  /** "Draw", "View", "Sheet" — grouped in the list and searched as part of the text. */
  readonly category?: string;
  /** Normalised chord, shown right-aligned. The teaching half of the palette. */
  readonly chord?: string;
  /** Dimmed with this reason rather than hidden, exactly as in the ribbon. */
  readonly unavailable?: string;
  readonly kind?: "command" | "element" | "sheet" | "view" | "layer";
}

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly entries: readonly PaletteEntry[];
  readonly onRun: (entry: PaletteEntry) => void;
  readonly onClose: () => void;
  readonly placeholder?: string;
  /** Cap on rendered rows. 5 000 elements in one list is a scroll container nobody can use. */
  readonly limit?: number;
}

/**
 * Subsequence fuzzy match, scored.
 *
 * Subsequence rather than substring because that is what makes an acronym work: `sp` should find "Section
 * plane". Scored rather than boolean because ranking is the entire user experience of a palette — every
 * candidate matching is the same as none matching if the right one is fortieth.
 *
 * The weights encode what people actually mean when they type three letters:
 *
 * - a **word-boundary** hit is worth far more than a mid-word one, because `sp` meaning "Section plane" is
 *   overwhelmingly more likely than `sp` meaning "iSolate Plane"
 * - **consecutive** hits beat scattered ones, so `sec` prefers "Section" over "SElect Colour"
 * - a hit at position 0 gets a bonus, because people type the beginning of what they want
 *
 * Returns `null` for no match, so a caller cannot accidentally treat 0 as "matched badly".
 */
export function fuzzyScore(text: string, query: string): { score: number; hits: readonly number[] } | null {
  if (query === "") return { score: 0, hits: [] };
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();

  let score = 0;
  let at = 0;
  let previous = -2;
  const hits: number[] = [];

  for (const char of needle) {
    const found = lower.indexOf(char, at);
    if (found === -1) return null;
    hits.push(found);

    // A word boundary: start of string, or preceded by a space, hyphen, dot or an underscore.
    const boundary = found === 0 || /[\s\-._/(]/.test(lower[found - 1] ?? "");
    if (boundary) score += 12;
    if (found === previous + 1) score += 8;
    if (found === 0) score += 6;
    // Later matches are worth slightly less, so an early hit wins a tie. Small, or it swamps the boundary bonus.
    score += Math.max(0, 4 - found / 12);

    previous = found;
    at = found + 1;
  }

  // Shorter labels win ties: "Fit" should beat "Fit to selection extents" for the query "fit".
  score += Math.max(0, 20 - text.length / 4);
  return { score, hits };
}

/** Rank entries against a query, most relevant first. */
export function rank(entries: readonly PaletteEntry[], query: string): readonly PaletteEntry[] {
  if (query.trim() === "") return entries;
  const scored: { entry: PaletteEntry; score: number }[] = [];
  for (const entry of entries) {
    // Category is searched as part of the text, so "view fit" finds Fit in the View category — which is how
    // people narrow a search when they half-remember where something lives.
    const haystack = entry.category === undefined ? entry.label : `${entry.category} ${entry.label}`;
    const result = fuzzyScore(haystack, query.trim());
    if (result === null) continue;
    // An unavailable entry ranks below every available one rather than being hidden. Same argument as the
    // ribbon's dim-not-hide: hiding it means the user cannot tell "does not exist" from "not right now".
    scored.push({ entry, score: result.score - (entry.unavailable === undefined ? 0 : 1000) });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label));
  return scored.map((s) => s.entry);
}

export function CommandPalette(props: CommandPaletteProps): React.ReactElement | null {
  const { open, entries, onRun, onClose } = props;
  const limit = props.limit ?? 100;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const matches = useMemo(() => rank(entries, query).slice(0, limit), [entries, query, limit]);
  const total = useMemo(() => (query.trim() === "" ? entries.length : rank(entries, query).length), [entries, query]);

  // Reset when opened, not when closed. Resetting on close is visible: the list flickers back to the top as the
  // dialog fades, which reads as a rendering bug.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      input.current?.focus();
    }
  }, [open]);

  // The active row has to be *scrolled to*, or arrowing past the tenth item moves an invisible highlight.
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, matches]);

  const run = useCallback(
    (entry: PaletteEntry | undefined) => {
      if (entry === undefined) return;
      if (entry.unavailable !== undefined) return; // Dimmed rows are selectable and inert, like the ribbon's.
      onRun(entry);
      onClose();
    },
    [onRun, onClose],
  );

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
      event.preventDefault();
      // Wraps. A list that stops at the end makes a user reverse direction to reach the top, which nobody does —
      // they close the palette and reopen it.
      setActive((i) => (matches.length === 0 ? 0 : (i + 1) % matches.length));
      return;
    }
    if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
      event.preventDefault();
      setActive((i) => (matches.length === 0 ? 0 : (i - 1 + matches.length) % matches.length));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActive(Math.max(0, matches.length - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      run(matches[active]);
    }
  };

  if (!open) return null;

  const activeId = matches[active] === undefined ? undefined : `mv-palette-${matches[active]!.id}`;

  return (
    <div
      className="mv-palette-backdrop"
      // A click on the backdrop closes; a click inside must not. Checking the target rather than stopping
      // propagation on the panel, because stopPropagation on a subtree breaks anything else listening above it.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="mv-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={input}
          className="mv-palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls="mv-palette-list"
          // Focus stays in the input while the *highlight* moves. Moving focus to the option instead is the
          // obvious implementation and it breaks typing entirely.
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          placeholder={props.placeholder ?? "Search commands, elements, sheets…"}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            // Back to the top on every keystroke: keeping the index would leave the highlight on whatever row
            // now happens to sit at position 7, which is never what the user meant.
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />

        <ul id="mv-palette-list" ref={list} className="mv-palette-list" role="listbox" aria-label="Results">
          {matches.map((entry, i) => (
            <li
              key={entry.id}
              id={`mv-palette-${entry.id}`}
              role="option"
              aria-selected={i === active}
              aria-disabled={entry.unavailable !== undefined}
              className={`mv-palette-row${i === active ? " mv-active" : ""}${entry.unavailable !== undefined ? " mv-dimmed" : ""}`}
              title={entry.unavailable}
              // `mouseDown`, not `click`: a click fires after the input has lost focus, and the resulting blur
              // can close the palette before the handler runs.
              onMouseDown={(event) => {
                event.preventDefault();
                run(entry);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {entry.category !== undefined && <span className="mv-palette-category">{entry.category}</span>}
              <span className="mv-palette-label">{entry.label}</span>
              {entry.unavailable !== undefined && <span className="mv-palette-reason">{entry.unavailable}</span>}
              {entry.chord !== undefined && <kbd className="mv-palette-chord">{entry.chord}</kbd>}
            </li>
          ))}
        </ul>

        {/* Announced, because a sighted user sees an empty list and a screen-reader user hears nothing at all. */}
        <div className="mv-palette-footer" role="status" aria-live="polite">
          {matches.length === 0
            ? `No matches for "${query}"`
            : total > matches.length
              ? `${matches.length} of ${total} — keep typing to narrow`
              : `${matches.length} result${matches.length === 1 ? "" : "s"}`}
        </div>
      </div>
    </div>
  );
}

/**
 * Bind a chord to open the palette.
 *
 * Separate from the component so a host can own its own keyboard layer — massing already has one, and two
 * listeners both claiming Ctrl+K is exactly the conflict `plugin-host` reports rather than resolves.
 */
export function usePaletteShortcut(onOpen: () => void, key = "k"): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === key) {
        // Cancelled, because Ctrl+K is the browser's search-bar focus in some builds — and losing the palette to
        // the address bar is the kind of thing that gets reported as "the shortcut does not work".
        event.preventDefault();
        onOpen();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onOpen, key]);
}
