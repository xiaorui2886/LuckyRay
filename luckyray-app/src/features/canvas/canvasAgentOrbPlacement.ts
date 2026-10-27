/** Viewport-relative launcher placement. This never uses ReactFlow/world coordinates. */
export type OrbPoint = { x: number; y: number };
export type OrbBounds = { width: number; height: number };
export type OrbPlacement = { locked: boolean; position: OrbPoint | null };
export const ORB_PLACEMENT_KEY = 'luckyray.canvas.agent-orb-placement.v1';
export const ORB_SIZE = 64;
// The luminous disk is 88px wide around a 64px hit target; keep its halo inside.
export const ORB_INSET = 16;
export const ORB_DRAG_THRESHOLD = 6;
export const DEFAULT_ORB_PLACEMENT: OrbPlacement = { locked: false, position: null };
const unit = (value: number) => Math.max(0, Math.min(1, value));
export function parseOrbPlacement(value: unknown): OrbPlacement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_ORB_PLACEMENT };
  const raw = value as Record<string, unknown>;
  const point = raw.position as Record<string, unknown> | null;
  return { locked: raw.locked === true, position: point && typeof point.x === 'number' && Number.isFinite(point.x) && typeof point.y === 'number' && Number.isFinite(point.y)
    ? { x: unit(point.x), y: unit(point.y) } : null };
}
function axis(length: number) {
  const available = Math.max(0, (Number.isFinite(length) ? length : 0) - ORB_SIZE);
  const inset = Math.min(ORB_INSET, available / 2);
  return { min: inset, travel: Math.max(0, available - inset * 2) };
}
export function clampOrbPoint(point: OrbPoint, bounds: OrbBounds): OrbPoint {
  const x = axis(bounds.width), y = axis(bounds.height);
  return { x: Math.max(x.min, Math.min(x.min + x.travel, point.x)), y: Math.max(y.min, Math.min(y.min + y.travel, point.y)) };
}
export function decodeOrbPosition(position: OrbPoint, bounds: OrbBounds): OrbPoint {
  const x = axis(bounds.width), y = axis(bounds.height);
  return { x: x.min + unit(position.x) * x.travel, y: y.min + unit(position.y) * y.travel };
}
export function encodeOrbPosition(point: OrbPoint, bounds: OrbBounds): OrbPoint {
  const x = axis(bounds.width), y = axis(bounds.height);
  return { x: x.travel > 0 ? unit((point.x - x.min) / x.travel) : 0.5, y: y.travel > 0 ? unit((point.y - y.min) / y.travel) : 0.5 };
}
