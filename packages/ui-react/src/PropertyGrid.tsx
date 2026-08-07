import { useMemo, useState } from "react";

/**
 * The property grid — where React genuinely earns its place.
 *
 * ADR-0009 sent the ribbon to vanilla DOM because it is long-lived, imperative and needed by two hosts. This is
 * the opposite case and the reason `ui-react` still exists: a property grid is a *tree of data* that is entirely
 * replaced when the selection changes, with expand/collapse state layered on top. That is what a component tree
 * is for, and writing it imperatively means hand-rolling reconciliation.
 *
 * ## The feature that makes it worth having
 *
 * **Declared values and measured values are shown together, and disagreements are called out.** A wall whose type
 * says 300 mm and whose geometry measures 296 mm is the single most common real defect in a federated model, and
 * every viewer in this market shows you one number. Which number depends on the viewer, and nobody tells you
 * which one you are looking at.
 *
 * That is not a display preference. A quantity takeoff built on declared thicknesses and a clash check built on
 * measured geometry disagree by exactly this amount, and the argument on site is about whose number was right.
 */

export type PropertyValue = string | number | boolean | null;

export interface Property {
  readonly name: string;
  /** What the model *says* — from an IfcPropertySet or a type. */
  readonly declared?: PropertyValue;
  /** What the geometry *is* — measured. Absent when nothing measures it. */
  readonly measured?: PropertyValue;
  readonly unit?: string;
  /**
   * Tolerance for calling declared and measured a disagreement, in the value's own unit.
   *
   * Required to be explicit per property, because there is no sensible default: 1 mm on a wall thickness is a
   * defect and 1 mm on a 40 m span is rounding. A single global tolerance would report one of those wrongly, and
   * a grid that cries wolf is a grid whose warnings get ignored — which is worse than not having them.
   */
  readonly tolerance?: number;
  readonly readOnly?: boolean;
}

export interface PropertySet {
  readonly name: string;
  readonly properties: readonly Property[];
  /** Collapsed on first render. For sets that are long and rarely read — Pset_QuantityTakeOff, say. */
  readonly collapsed?: boolean;
}

export interface PropertyGridProps {
  /** Absent means nothing is selected, which is a different state from "selected, but has no properties". */
  readonly sets: readonly PropertySet[] | null;
  readonly onEdit?: (set: string, property: string, value: string) => void;
  /** Element identity, shown as a header. The GlobalId is what a markup or a BCF topic will anchor to. */
  readonly subject?: { readonly label: string; readonly ifcClass?: string; readonly guid?: string };
}

export type Discrepancy = { readonly kind: "none" } | { readonly kind: "mismatch"; readonly delta: number };

/**
 * Compare a declared value with a measured one.
 *
 * Only numbers are compared. Comparing strings would flag "RC200" against "Reinforced concrete 200mm" as a
 * disagreement, which is two names for one thing — and a warning that is usually wrong trains people to dismiss
 * the ones that are right.
 */
export function discrepancyOf(property: Property): Discrepancy {
  const { declared, measured, tolerance } = property;
  if (typeof declared !== "number" || typeof measured !== "number") return { kind: "none" };
  const delta = measured - declared;
  // No tolerance means no comparison, not a zero tolerance. A zero default would flag every float as a mismatch.
  if (tolerance === undefined) return { kind: "none" };
  return Math.abs(delta) <= tolerance ? { kind: "none" } : { kind: "mismatch", delta };
}

function format(value: PropertyValue, unit?: string): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    // Trailing zeros stripped, because "300.00 mm" and "300 mm" are the same number and the extra digits imply a
    // precision the source may not have.
    const text = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
    return unit === undefined ? text : `${text} ${unit}`;
  }
  return value;
}

export function PropertyGrid(props: PropertyGridProps): React.ReactElement {
  const { sets, subject, onEdit } = props;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set((sets ?? []).filter((s) => s.collapsed === true).map((s) => s.name)),
  );

  const mismatches = useMemo(
    () =>
      (sets ?? []).flatMap((set) =>
        set.properties.filter((p) => discrepancyOf(p).kind === "mismatch").map((p) => `${set.name}.${p.name}`),
      ),
    [sets],
  );

  // Three states, not two. "Nothing selected" and "selected but bare" call for different words: the first is an
  // instruction, the second is information about the model. Collapsing them into one empty state makes a model
  // with no property sets look like a broken selection.
  if (sets === null) {
    return (
      <div className="mv-props mv-props-empty" role="region" aria-label="Properties">
        Select an element to see its properties.
      </div>
    );
  }

  return (
    <div className="mv-props" role="region" aria-label="Properties">
      {subject !== undefined && (
        <header className="mv-props-subject">
          <strong>{subject.label}</strong>
          {subject.ifcClass !== undefined && <span className="mv-props-class">{subject.ifcClass}</span>}
          {/* The GlobalId, in full and selectable. It is what a BCF topic anchors to, and someone will need to
              paste it into an issue tracker. Truncating it would make that impossible for no gain. */}
          {subject.guid !== undefined && <code className="mv-props-guid">{subject.guid}</code>}
        </header>
      )}

      {mismatches.length > 0 && (
        <p className="mv-props-warning" role="status">
          {mismatches.length} declared value{mismatches.length === 1 ? "" : "s"} disagree with the geometry.
        </p>
      )}

      {sets.length === 0 && <p className="mv-props-none">This element carries no property sets.</p>}

      {sets.map((set) => {
        const isCollapsed = collapsed.has(set.name);
        return (
          <section key={set.name} className="mv-props-set">
            <h3>
              <button
                type="button"
                aria-expanded={!isCollapsed}
                onClick={() =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(set.name)) next.delete(set.name);
                    else next.add(set.name);
                    return next;
                  })
                }
              >
                {set.name}
                <span className="mv-props-count">{set.properties.length}</span>
              </button>
            </h3>

            {!isCollapsed && (
              // A real table, with real headers. A grid of divs is the usual choice and it costs a screen-reader
              // user the ability to know which column a value is in — which, when the two columns are "declared"
              // and "measured", is the only thing that matters about it.
              <table className="mv-props-table">
                <thead>
                  <tr>
                    <th scope="col">Property</th>
                    <th scope="col">Declared</th>
                    <th scope="col">Measured</th>
                  </tr>
                </thead>
                <tbody>
                  {set.properties.map((property) => {
                    const discrepancy = discrepancyOf(property);
                    const mismatch = discrepancy.kind === "mismatch";
                    return (
                      <tr key={property.name} className={mismatch ? "mv-props-mismatch" : undefined}>
                        <th scope="row">{property.name}</th>
                        <td>
                          {onEdit !== undefined && property.readOnly !== true ? (
                            <input
                              aria-label={`${property.name} declared`}
                              defaultValue={format(property.declared ?? null)}
                              // `onBlur`, not `onChange`: committing per keystroke sends "3", "30", "300" to the
                              // kernel as three edits, which is three entries in the undo stack for one change.
                              onBlur={(event) => onEdit(set.name, property.name, event.target.value)}
                            />
                          ) : (
                            format(property.declared ?? null, property.unit)
                          )}
                        </td>
                        <td>
                          {format(property.measured ?? null, property.unit)}
                          {mismatch && (
                            <span
                              className="mv-props-delta"
                              // The signed difference, not just a warning icon. "300 declared, 296 measured" is
                              // actionable; "⚠" means the user has to work out what is wrong themselves.
                              title={`declared ${format(property.declared ?? null, property.unit)}, measured ${format(property.measured ?? null, property.unit)}`}
                            >
                              {discrepancy.delta > 0 ? "+" : ""}
                              {format(Math.round(discrepancy.delta * 100) / 100, property.unit)}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        );
      })}
    </div>
  );
}
