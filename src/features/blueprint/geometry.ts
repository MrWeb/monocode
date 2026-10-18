import type { BlueprintShape } from "./blueprint";

export type Rect = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };
export type Side = "top" | "right" | "bottom" | "left";

export function center(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/**
 * Where the line from the box's center toward `toward` crosses its border,
 * pulled `inset` px inside it. Stadiums follow their rounded ends.
 */
export function borderPoint(
  r: Rect,
  shape: BlueprintShape,
  toward: Point,
  inset = 0,
): Point {
  const c = center(r);
  const hw = Math.max(r.width / 2 - inset, 0);
  const hh = Math.max(r.height / 2 - inset, 0);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return { x: c.x + hw, y: c.y };

  // Rectangle: scale the direction until it touches the nearer side.
  const t = 1 / Math.max(Math.abs(dx) / hw || 0, Math.abs(dy) / hh || 0);
  const p = { x: c.x + dx * t, y: c.y + dy * t };
  if (shape !== "stadium") return p;

  // Stadium: the ends are half-circles of radius hh. Past the straight
  // section, intersect with the end circle instead.
  const straight = Math.max(hw - hh, 0);
  if (Math.abs(p.x - c.x) <= straight) return p;
  const ex = c.x + Math.sign(dx) * straight;
  // Solve |c + s·d − e|² = hh² for the outer root s.
  const ox = c.x - ex;
  const a = dx * dx + dy * dy;
  const b = 2 * (ox * dx);
  const k = ox * ox - hh * hh;
  const s = (-b + Math.sqrt(b * b - 4 * a * k)) / (2 * a);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

/** Which side of the box a border point is on, for curving the arrow. */
export function sideOf(r: Rect, p: Point): Side {
  const c = center(r);
  const nx = (p.x - c.x) / (r.width / 2 || 1);
  const ny = (p.y - c.y) / (r.height / 2 || 1);
  if (Math.abs(nx) >= Math.abs(ny)) return nx >= 0 ? "right" : "left";
  return ny >= 0 ? "bottom" : "top";
}
