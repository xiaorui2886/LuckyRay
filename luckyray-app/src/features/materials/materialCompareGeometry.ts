/**
 * Pure geometry for the 2–4 image compare surface (MATERIAL-VIEW-COMPARE-R1).
 *
 * One consistent state model (no compensating patches):
 * - A slot's zoom is `{ multiplier, offset }` where `multiplier` is FIT-RELATIVE
 *   (1 = fit) and `offset` is the projected top-left in stage pixels (the
 *   image renders absolutely positioned with transform-origin 0 0).
 * - Every slot's multiplier bounds are PER-SLOT and absolute-safe:
 *   lower = min(1, 1/fit) (so a small image can zoom OUT to true 1:1),
 *   upper = max(16, 1/fit) (so a huge image can zoom IN to true 1:1).
 * - "100%" is ABSOLUTE: rendering scale 1 image px = 1 CSS px, i.e.
 *   multiplier = 1/fit. It is never the same as fit.
 * - INDEPENDENT mode: wheel/keys/drag act on the ACTIVE slot's multiplier.
 * - LINKED mode: one SHARED fit-relative multiplier M drives every slot
 *   (m_i = M). Linked PAN applies the same pixel delta to every slot.
 *   The shared multiplier adopts the active slot's multiplier when linked
 *   turns on (no jump for the slot being viewed).
 * - Pan clamping keeps at least COMPARE_VISIBLE_FRACTION of the projected
 *   image intersecting the stage on each axis; a fit-or-smaller projection
 *   self-centers.
 */

export type CompareDimensions = { width: number; height: number };
export type ComparePoint = { x: number; y: number };

export const COMPARE_VISIBLE_FRACTION = 0.15;
export const COMPARE_BASE_MAX_MULTIPLIER = 16;

export type CompareZoomState = {
  multiplier: number;
  offset: ComparePoint;
};

export const COMPARE_FIT_OFFSET = { x: 0, y: 0 };

export function safeCompareDimensions(value: CompareDimensions | null | undefined): CompareDimensions | null {
  if (!value) return null;
  const width = Number(value.width);
  const height = Number(value.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

export function resolveCompareFitScale(stage: CompareDimensions, image: CompareDimensions): number {
  const safeStage = safeCompareDimensions(stage);
  const safeImage = safeCompareDimensions(image);
  if (!safeStage || !safeImage) return 1;
  return Math.min(safeStage.width / safeImage.width, safeStage.height / safeImage.height);
}

export type CompareMultiplierBounds = { lower: number; upper: number };

/** Per-slot, absolute-safe multiplier bounds derived from that slot's fit. */
export function resolveCompareMultiplierBounds(fit: number): CompareMultiplierBounds {
  const safeFit = Number.isFinite(fit) && fit > 0 ? fit : 1;
  const oneToOne = 1 / safeFit;
  return {
    lower: Math.min(1, oneToOne),
    upper: Math.max(COMPARE_BASE_MAX_MULTIPLIER, oneToOne),
  };
}

export function clampCompareMultiplierToBounds(
  multiplier: number,
  bounds: CompareMultiplierBounds,
): number {
  if (!Number.isFinite(multiplier)) return bounds.lower;
  return Math.min(bounds.upper, Math.max(bounds.lower, multiplier));
}

/** The multiplier that renders an image at absolute 1:1 CSS px. */
export function resolveOneToOneMultiplier(stage: CompareDimensions, image: CompareDimensions): number {
  const fit = resolveCompareFitScale(stage, image);
  if (!Number.isFinite(fit) || fit <= 0) return 1;
  const bounds = resolveCompareMultiplierBounds(fit);
  return clampCompareMultiplierToBounds(1 / fit, bounds);
}

export function clampComparePanOffset(offset: number, projectedSize: number, stageSize: number): number {
  if (!Number.isFinite(offset) || !Number.isFinite(projectedSize) || !Number.isFinite(stageSize)) return 0;
  if (projectedSize <= 0 || stageSize <= 0) return 0;
  if (projectedSize <= stageSize) return (stageSize - projectedSize) / 2;
  const minVisible = projectedSize * COMPARE_VISIBLE_FRACTION;
  const lower = minVisible - projectedSize;
  const upper = stageSize - minVisible;
  return Math.min(upper, Math.max(lower, offset));
}

export function clampComparePan(
  state: CompareZoomState,
  stage: CompareDimensions,
  projected: CompareDimensions,
  bounds: CompareMultiplierBounds,
): CompareZoomState {
  const safeStage = safeCompareDimensions(stage);
  const safeProjected = safeCompareDimensions(projected);
  if (!safeStage || !safeProjected) {
    return { multiplier: bounds.lower, offset: { x: 0, y: 0 } };
  }
  return {
    multiplier: clampCompareMultiplierToBounds(state.multiplier, bounds),
    offset: {
      x: clampComparePanOffset(state.offset.x, safeProjected.width, safeStage.width),
      y: clampComparePanOffset(state.offset.y, safeProjected.height, safeStage.height),
    },
  };
}

export function resolveCompareProjection(image: CompareDimensions, multiplier: number, fit: number): CompareDimensions {
  const scale = multiplier * fit;
  return { width: image.width * scale, height: image.height * scale };
}

/**
 * Zoom one slot by `factor` around `anchor` (cursor position inside the
 * stage). The anchor's normalized position over the projected image stays
 * fixed across the change.
 */
export function zoomCompareSlot(
  state: CompareZoomState,
  factor: number,
  anchor: ComparePoint,
  stage: CompareDimensions,
  image: CompareDimensions,
): CompareZoomState {
  const safeStage = safeCompareDimensions(stage);
  const safeImage = safeCompareDimensions(image);
  if (!safeStage || !safeImage) return { multiplier: 1, offset: { x: 0, y: 0 } };
  const fit = resolveCompareFitScale(safeStage, safeImage);
  const bounds = resolveCompareMultiplierBounds(fit);
  const current = clampCompareMultiplierToBounds(state.multiplier, bounds);
  const next = clampCompareMultiplierToBounds(current * factor, bounds);
  if (next === current) return { multiplier: current, offset: { ...state.offset } };

  const currentProjected = resolveCompareProjection(safeImage, current, fit);
  const anchorX = Math.min(safeStage.width, Math.max(0, Number.isFinite(anchor.x) ? anchor.x : safeStage.width / 2));
  const anchorY = Math.min(safeStage.height, Math.max(0, Number.isFinite(anchor.y) ? anchor.y : safeStage.height / 2));
  const fx = currentProjected.width > 0 ? (anchorX - state.offset.x) / currentProjected.width : 0.5;
  const fy = currentProjected.height > 0 ? (anchorY - state.offset.y) / currentProjected.height : 0.5;

  const nextProjected = resolveCompareProjection(safeImage, next, fit);
  const nextOffset = {
    x: anchorX - fx * nextProjected.width,
    y: anchorY - fy * nextProjected.height,
  };
  return clampComparePan({ multiplier: next, offset: nextOffset }, safeStage, nextProjected, bounds);
}

/** Re-clamp a slot's pan after a stage resize (multiplier semantics survive). */
export function reclampCompareStateAfterResize(
  state: CompareZoomState,
  stage: CompareDimensions,
  image: CompareDimensions,
): CompareZoomState {
  const fit = resolveCompareFitScale(stage, image);
  const bounds = resolveCompareMultiplierBounds(fit);
  const multiplier = clampCompareMultiplierToBounds(state.multiplier, bounds);
  const projected = resolveCompareProjection(image, multiplier, fit);
  return clampComparePan({ multiplier, offset: { ...state.offset } }, stage, projected, bounds);
}

/** Linked mode adopts the active slot's multiplier — no jump for that slot. */
export function adoptSharedMultiplier(slots: CompareZoomState[], activeIndex: number): number {
  const active = slots[activeIndex];
  if (active && Number.isFinite(active.multiplier)) return active.multiplier;
  return 1;
}

/** 2 slots side by side; 3–4 slots in a 2×2 grid; 1 slot full width. */
export function resolveCompareGridColumns(count: number): 1 | 2 {
  return count >= 2 ? 2 : 1;
}
