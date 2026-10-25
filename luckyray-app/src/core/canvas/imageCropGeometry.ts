import { IMAGE_EDIT_LIMITS } from "./imageEditing";
import type { ImageEdit } from "./imageEditing";

/** Coordinates are relative to the already-oriented source, not the preview. */
export type CropRect = ImageEdit["crop"];
export type CropSourceSize = { width: number; height: number };
export type CropDelta = { x: number; y: number };
export type CropHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
export type CropArrowKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

const handles: readonly CropHandle[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function validateSource(source: CropSourceSize) {
  if (
    !source ||
    !Number.isSafeInteger(source.width) ||
    !Number.isSafeInteger(source.height) ||
    source.width < 1 ||
    source.height < 1 ||
    source.width * source.height > IMAGE_EDIT_LIMITS.sourcePixels
  ) throw Error("invalid-crop-source");
}

function validateDelta(delta: CropDelta) {
  if (!delta || ![delta.x, delta.y].every(Number.isFinite)) throw Error("invalid-crop-delta");
}

/**
 * Fit a finite, non-inverted rectangle inside the source. Sizes below one source
 * pixel grow to one pixel; sizes above the source shrink to it. Position then
 * clamps without changing the fitted size. Invalid dimensions/NaN/Infinity throw.
 * All helpers return new objects and never mutate their arguments.
 */
export function clampCropRect(rect: CropRect, source: CropSourceSize): CropRect {
  validateSource(source);
  if (
    !rect ||
    ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) throw Error("invalid-crop-rect");
  const width = clamp(rect.width, 1 / source.width, 1);
  const height = clamp(rect.height, 1 / source.height, 1);
  return {
    x: clamp(rect.x, 0, 1 - width),
    y: clamp(rect.y, 0, 1 - height),
    width,
    height,
  };
}

/** Move by a normalized delta, preserving size even when a source edge is hit. */
export function moveCropRect(rect: CropRect, delta: CropDelta, source: CropSourceSize): CropRect {
  const crop = clampCropRect(rect, source);
  validateDelta(delta);
  return {
    ...crop,
    x: clamp(crop.x + delta.x, 0, 1 - crop.width),
    y: clamp(crop.y + delta.y, 0, 1 - crop.height),
  };
}

/**
 * Resize from the gesture-start rectangle by a normalized pointer/key delta.
 * The opposite corner (corner handle) or edge (edge handle) stays anchored.
 * Dragging through that anchor clamps at the minimum size; handles never flip.
 *
 * aspectRatio means SOURCE-PIXEL width / height. The corresponding normalized
 * ratio is aspectRatio * source.height / source.width. A locked corner uses the
 * axis with the larger absolute change relative to its ORIGINAL cropped pixel
 * length as its driver (horizontal wins ties), and derives the other dimension.
 * Thus a purely vertical drag works, and a one-pixel key delta advances its
 * driven edge by one source pixel unless constrained by the source/minimum.
 * A locked edge uses only its own axis; the perpendicular dimension remains
 * centered on the original crop and growth stops before either centered edge
 * leaves the source. It does not shift that center to gain more room.
 *
 * Every dimension is at least one source pixel. A ratio that cannot satisfy this
 * within the anchored space throws "crop-aspect-does-not-fit" rather than moving
 * the anchor, breaking the ratio, or returning a subpixel crop. A mismatched
 * starting rectangle is fitted to the requested ratio with the same anchors.
 * Pass the dimensions after rotation (swap width/height for odd quarter-turns).
 */
export function resizeCropRect(
  rect: CropRect,
  handle: CropHandle,
  delta: CropDelta,
  source: CropSourceSize,
  aspectRatio?: number,
): CropRect {
  const crop = clampCropRect(rect, source);
  validateDelta(delta);
  if (!handles.includes(handle)) throw Error("invalid-crop-handle");
  if (aspectRatio !== undefined && (!Number.isFinite(aspectRatio) || aspectRatio <= 0)) {
    throw Error("invalid-crop-aspect");
  }

  const west = handle.includes("w"), east = handle.includes("e");
  const north = handle.includes("n"), south = handle.includes("s");
  const horizontal = west || east, vertical = north || south;
  const right = crop.x + crop.width, bottom = crop.y + crop.height;
  const centerX = crop.x + crop.width / 2, centerY = crop.y + crop.height / 2;
  const desiredWidth = crop.width + (west ? -delta.x : east ? delta.x : 0);
  const desiredHeight = crop.height + (north ? -delta.y : south ? delta.y : 0);
  const availableWidth = horizontal ? (west ? right : 1 - crop.x) : 2 * Math.min(centerX, 1 - centerX);
  const availableHeight = vertical ? (north ? bottom : 1 - crop.y) : 2 * Math.min(centerY, 1 - centerY);
  let width = crop.width, height = crop.height;

  if (aspectRatio === undefined) {
    if (horizontal) width = clamp(desiredWidth, 1 / source.width, availableWidth);
    if (vertical) height = clamp(desiredHeight, 1 / source.height, availableHeight);
  } else {
    // These global limits also keep all subsequent ratio arithmetic finite.
    if (aspectRatio < 1 / source.height || aspectRatio > source.width) {
      throw Error("crop-aspect-does-not-fit");
    }
    const normalizedRatio = aspectRatio * source.height / source.width;
    const minWidth = Math.max(1 / source.width, normalizedRatio / source.height);
    const maxWidth = Math.min(availableWidth, availableHeight * normalizedRatio);
    // Allow only round-off at an exactly one-pixel anchored boundary.
    const tolerance = Number.EPSILON * 8 * Math.max(minWidth, maxWidth);
    if (maxWidth + tolerance < minWidth) throw Error("crop-aspect-does-not-fit");
    let requestedWidth: number;
    if (horizontal && vertical) {
      // Cross-multiply rather than divide by tiny crop sizes: even very large
      // finite pointer deltas remain comparable without overflow to Infinity.
      const horizontalDriver = Math.abs(delta.x) * crop.height >= Math.abs(delta.y) * crop.width;
      requestedWidth = horizontalDriver ? desiredWidth : desiredHeight * normalizedRatio;
    } else {
      requestedWidth = horizontal ? desiredWidth : desiredHeight * normalizedRatio;
    }
    width = clamp(requestedWidth, Math.min(minWidth, maxWidth), maxWidth);
    height = width / normalizedRatio;
  }

  return {
    x: Math.max(0, west ? right - width : east ? crop.x : centerX - width / 2),
    y: Math.max(0, north ? bottom - height : south ? crop.y : centerY - height / 2),
    width,
    height,
  };
}

/** One oriented source pixel per arrow press, or ten with Shift; not CSS pixels. */
export function cropNudgeDelta(key: CropArrowKey, source: CropSourceSize, shift = false): CropDelta {
  validateSource(source);
  if (typeof shift !== "boolean") throw Error("invalid-crop-nudge");
  const step = shift ? 10 : 1;
  switch (key) {
    case "ArrowLeft": return { x: -step / source.width, y: 0 };
    case "ArrowRight": return { x: step / source.width, y: 0 };
    case "ArrowUp": return { x: 0, y: -step / source.height };
    case "ArrowDown": return { x: 0, y: step / source.height };
    default: throw Error("invalid-crop-nudge");
  }
}
