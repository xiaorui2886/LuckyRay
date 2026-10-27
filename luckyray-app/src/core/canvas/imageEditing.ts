export type ImageAdjustments = { brightness: number; contrast: number; saturation: number };
export const NEUTRAL_IMAGE_ADJUSTMENTS: ImageAdjustments = { brightness: 0, contrast: 0, saturation: 0 };
/** Identical color pipeline for the downsampled preview and saved PNG. */
export function imageAdjustmentFilter(value?: ImageAdjustments): string {
  if (!value) return "none";
  if (![value.brightness, value.contrast, value.saturation].every(n => Number.isFinite(n) && n >= -100 && n <= 100)) throw Error("invalid-image-adjustments");
  return `brightness(${1 + value.brightness / 100}) contrast(${1 + value.contrast / 100}) saturate(${1 + value.saturation / 100})`;
}
export type ImageEdit = {
  adjustments?: ImageAdjustments;
  turns: number;
  flipX: boolean;
  flipY: boolean;
  crop: { x: number; y: number; width: number; height: number };
  width: number;
  height: number;
};
export const IMAGE_EDIT_LIMITS = {
  sourcePixels: 64_000_000,
  outputPixels: 32_000_000,
  side: 8192,
};
export function validateImageEdit(
  edit: ImageEdit,
  sourceWidth: number,
  sourceHeight: number,
) {
  if (
    !Number.isInteger(sourceWidth) ||
    !Number.isInteger(sourceHeight) ||
    sourceWidth < 1 ||
    sourceHeight < 1 ||
    sourceWidth * sourceHeight > IMAGE_EDIT_LIMITS.sourcePixels
  )
    throw Error("image-too-large");
  if (
    !Number.isInteger(edit.turns) ||
    edit.turns < 0 ||
    edit.turns > 3 ||
    typeof edit.flipX !== "boolean" ||
    typeof edit.flipY !== "boolean"
  )
    throw Error("invalid-edit");
  imageAdjustmentFilter(edit.adjustments);
  const c = edit.crop;
  if (
    ![c.x, c.y, c.width, c.height].every(Number.isFinite) ||
    c.x < 0 ||
    c.y < 0 ||
    c.width <= 0 ||
    c.height <= 0 ||
    c.x + c.width > 1.000001 ||
    c.y + c.height > 1.000001
  )
    throw Error("invalid-crop");
  if (
    ![edit.width, edit.height].every(
      (v) => Number.isInteger(v) && v > 0 && v <= IMAGE_EDIT_LIMITS.side,
    ) ||
    edit.width * edit.height > IMAGE_EDIT_LIMITS.outputPixels
  )
    throw Error("invalid-size");
  const w = edit.turns % 2 ? sourceHeight : sourceWidth,
    h = edit.turns % 2 ? sourceWidth : sourceHeight;
  const left = Math.min(w - 1, Math.round(c.x * w)),
    top = Math.min(h - 1, Math.round(c.y * h));
  return {
    width: w,
    height: h,
    crop: {
      x: left,
      y: top,
      width: Math.max(1, Math.min(w - left, Math.round(c.width * w))),
      height: Math.max(1, Math.min(h - top, Math.round(c.height * h))),
    },
  };
}
/** Non-destructive raster transform; caller owns source and destination lifetime. */
export function renderImageEdit(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  edit: ImageEdit,
  makeCanvas: (w: number, h: number) => HTMLCanvasElement = (w, h) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  },
) {
  const geometry = validateImageEdit(edit, sourceWidth, sourceHeight);
  const oriented = makeCanvas(geometry.width, geometry.height),
    context = oriented.getContext("2d");
  if (!context) throw Error("canvas-unavailable");
  context.filter = imageAdjustmentFilter(edit.adjustments);
  context.translate(geometry.width / 2, geometry.height / 2);
  context.scale(edit.flipX ? -1 : 1, edit.flipY ? -1 : 1);
  context.rotate((edit.turns * Math.PI) / 2);
  context.drawImage(source, -sourceWidth / 2, -sourceHeight / 2);
  const output = makeCanvas(edit.width, edit.height),
    out = output.getContext("2d");
  if (!out) throw Error("canvas-unavailable");
  out.imageSmoothingEnabled =
    geometry.crop.width !== edit.width || geometry.crop.height !== edit.height;
  out.imageSmoothingQuality = "high";
  const c = geometry.crop;
  out.drawImage(
    oriented,
    c.x,
    c.y,
    c.width,
    c.height,
    0,
    0,
    edit.width,
    edit.height,
  );
  return output;
}
export function centeredCrop(width: number, height: number, ratio?: number) {
  if (!ratio) return { x: 0, y: 0, width: 1, height: 1 };
  return width / height > ratio
    ? {
        x: (1 - (ratio * height) / width) / 2,
        y: 0,
        width: (ratio * height) / width,
        height: 1,
      }
    : {
        x: 0,
        y: (1 - width / ratio / height) / 2,
        width: 1,
        height: width / ratio / height,
      };
}
export function canvasPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(Error("image-encode-failed"))),
      "image/png",
    ),
  );
}
/** Rotate the visible edit, preserving the selected region and pixel density. */
export function rotateImageEdit(edit: ImageEdit): ImageEdit {
  const c = edit.crop;
  return {
    ...edit,
    turns: (edit.turns + 1) % 4,
    flipX: edit.flipY,
    flipY: edit.flipX,
    crop: {
      x: Math.max(0, 1 - c.y - c.height),
      y: c.x,
      width: c.height,
      height: c.width,
    },
    width: edit.height,
    height: edit.width,
  };
}
export function imageEditWithCrop(
  edit: ImageEdit,
  crop: ImageEdit["crop"],
  sourceWidth: number,
  sourceHeight: number,
): ImageEdit {
  const w = edit.turns % 2 ? sourceHeight : sourceWidth,
    h = edit.turns % 2 ? sourceWidth : sourceHeight;
  const factor = Math.min(1, 4096 / Math.max(w * crop.width, h * crop.height));
  return {
    ...edit,
    crop,
    width: Math.max(1, Math.round(w * crop.width * factor)),
    height: Math.max(1, Math.round(h * crop.height * factor)),
  };
}
