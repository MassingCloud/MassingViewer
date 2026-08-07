import type { DrawingEntity, EntityRole } from "./model.js";

/**
 * A theme: selectors → paint.
 *
 * ## Why this is a stylesheet and not a generation flag
 *
 * massing's plan generator takes a `by_discipline` argument, so "architectural" and "fire safety" are two
 * *generations* of the same model. That means every restyle costs a round trip through the geometry kernel, and
 * two disciplines of the same plan can drift out of agreement about what geometry is even there.
 *
 * Because the Semantic Drawing Model keeps `role`, `ifcClass`, `layer` and `attrs` on every entity, a theme can
 * be pure data matched against them — so switching discipline is a repaint of the same drawing, and the two
 * views are provably the same geometry.
 */

export interface Paint {
  /** Millimetres **on paper**, not model metres — line weight is a drafting property, not a model one. */
  readonly weight?: number;
  readonly stroke?: string;
  /** SVG dash pattern in paper millimetres. */
  readonly dash?: readonly number[];
  readonly fill?: string;
  readonly fillOpacity?: number;
  /** Points, as type sizes are conventionally given. */
  readonly fontSize?: number;
  readonly hidden?: boolean;
}

/**
 * Matches an entity. Every stated field must match; omitted fields match anything.
 *
 * `ifcClass` accepts a list because a rule almost always covers a family — walls *and* wall standard cases,
 * or every kind of structural member — and writing one rule per class is how they drift apart.
 */
export interface Selector {
  readonly role?: EntityRole | readonly EntityRole[];
  readonly ifcClass?: string | readonly string[];
  readonly layer?: string | readonly string[];
  /** Match on an `attrs` entry, e.g. `{ swing: "left" }`. */
  readonly attr?: Readonly<Record<string, string | number>>;
}

export interface Rule {
  readonly select: Selector;
  readonly paint: Paint;
}

export interface Theme {
  readonly name: string;
  /** Applied to everything first, so a rule only has to state what it changes. */
  readonly base: Paint;
  /**
   * Later rules win over earlier ones on a per-property basis, like CSS.
   *
   * Deliberately *not* specificity-ordered. CSS specificity is the single most common source of "why is this
   * style not applying", and a drawing theme is small enough that source order is both sufficient and
   * predictable. Order is the whole rule: put general rules first.
   */
  readonly rules: readonly Rule[];
}

function matchesOne(value: string | undefined, want: string | readonly string[] | undefined): boolean {
  if (want === undefined) return true;
  if (value === undefined) return false;
  return typeof want === "string" ? value === want : want.includes(value);
}

export function matches(entity: DrawingEntity, selector: Selector): boolean {
  if (!matchesOne(entity.role, selector.role as string | readonly string[] | undefined)) return false;
  if (!matchesOne(entity.ifcClass, selector.ifcClass)) return false;
  if (!matchesOne(entity.layer, selector.layer)) return false;
  if (selector.attr !== undefined) {
    for (const [key, want] of Object.entries(selector.attr)) {
      if (entity.attrs?.[key] !== want) return false;
    }
  }
  return true;
}

/**
 * Resolve the paint for one entity.
 *
 * Property-level merge rather than whole-object replacement: a rule saying `{ dash: [2, 1] }` must not silently
 * discard the stroke colour and weight an earlier rule established. Object replacement is why theme files grow
 * until every rule restates every property.
 */
export function paintFor(theme: Theme, entity: DrawingEntity): Paint {
  let paint: Paint = theme.base;
  for (const rule of theme.rules) {
    if (matches(entity, rule.select)) paint = { ...paint, ...rule.paint };
  }
  return paint;
}

// ---------------------------------------------------------------------------------------------------
// Built-in themes
// ---------------------------------------------------------------------------------------------------

/**
 * The architectural default.
 *
 * The line-weight hierarchy is the part that makes a drawing legible, and it is a convention rather than a
 * preference: cut heaviest, projection medium, below light and dashed, annotation lightest. Getting the
 * *hierarchy* wrong makes a drawing unreadable even when every line is in the right place, which is the usual
 * failure of tools that emit uniform strokes.
 */
export const ARCHITECTURAL: Theme = {
  name: "Architectural",
  base: { weight: 0.18, stroke: "#111111", fontSize: 2.5 },
  rules: [
    { select: { role: "cut" }, paint: { weight: 0.5 } },
    { select: { role: "projection" }, paint: { weight: 0.25 } },
    { select: { role: "hidden" }, paint: { weight: 0.13, dash: [1.5, 1.5] } },
    { select: { role: "below" }, paint: { weight: 0.13, dash: [3, 1.5], stroke: "#555555" } },
    // Poché: the solid fill inside a cut wall or column. Without it a plan reads as an outline drawing, which
    // is the single most common reason a generated plan looks unlike a real one.
    { select: { role: "poche" }, paint: { fill: "#333333", fillOpacity: 1, weight: 0 } },
    { select: { role: "poche", ifcClass: ["IfcSlab", "IfcCovering"] }, paint: { fill: "#888888" } },
    { select: { role: "hatch" }, paint: { weight: 0.09, stroke: "#666666" } },
    { select: { role: "grid" }, paint: { weight: 0.09, stroke: "#8899aa", dash: [8, 2, 1, 2] } },
    { select: { role: "dimension" }, paint: { weight: 0.13, stroke: "#0055aa", fontSize: 2.2 } },
    { select: { role: "annotation" }, paint: { weight: 0.13 } },
    { select: { role: "tag" }, paint: { weight: 0.13, fontSize: 2.2 } },
    { select: { role: "sheet" }, paint: { weight: 0.35 } },
  ],
};

/**
 * Fire safety: the same drawing, repainted.
 *
 * The point of including a second theme in the package rather than only the default is that it demonstrates the
 * claim. Everything not fire-related is greyed back rather than removed — a fire plan still needs its building
 * legible around the compartmentation, and hiding the context is what makes discipline drawings unusable on
 * site.
 */
export const FIRE_SAFETY: Theme = {
  name: "Fire safety",
  base: { weight: 0.13, stroke: "#bbbbbb", fontSize: 2.5 },
  rules: [
    { select: { role: "cut" }, paint: { weight: 0.18, stroke: "#cccccc" } },
    { select: { role: "poche" }, paint: { fill: "#eeeeee", fillOpacity: 1, weight: 0 } },
    { select: { role: ["below", "hidden"] }, paint: { hidden: true } },
    // Compartment walls carry the fire rating in `attrs`, put there by the generator from the element's psets.
    { select: { role: "cut", attr: { fireRated: "yes" } }, paint: { weight: 0.7, stroke: "#cc2200" } },
    { select: { role: "poche", attr: { fireRated: "yes" } }, paint: { fill: "#cc2200", fillOpacity: 0.85 } },
    { select: { ifcClass: ["IfcDoor"] }, paint: { weight: 0.35, stroke: "#cc7700" } },
    { select: { role: "grid" }, paint: { hidden: true } },
    { select: { role: "sheet" }, paint: { weight: 0.35, stroke: "#111111" } },
  ],
};

export const THEMES: readonly Theme[] = [ARCHITECTURAL, FIRE_SAFETY];
