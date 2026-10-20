import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  cropNudgeDelta,
  moveCropRect,
  resizeCropRect,
  type CropArrowKey,
  type CropHandle,
  type CropRect,
  type CropSourceSize,
} from "../../core/canvas/imageCropGeometry";

type Gesture = {
  pointerId: number;
  handle: CropHandle | "move";
  crop: CropRect;
  x: number;
  y: number;
  width: number;
  height: number;
  target: HTMLButtonElement;
  sessionKey: string;
  aspectRatio?: number;
};
const handles: CropHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const handleNames = {
  en: { nw: "top-left corner", n: "top edge", ne: "top-right corner", e: "right edge", se: "bottom-right corner", s: "bottom edge", sw: "bottom-left corner", w: "left edge" },
  zh: { nw: "左上角", n: "上边缘", ne: "右上角", e: "右边缘", se: "右下角", s: "下边缘", sw: "左下角", w: "左边缘" },
};
const percent = (value: number) => `${value * 100}%`;
function release(gesture: Gesture | null) {
  if (!gesture) return;
  try {
    if (gesture.target.hasPointerCapture?.(gesture.pointerId)) gesture.target.releasePointerCapture(gesture.pointerId);
  } catch { /* A source change may already have detached the capture target. */ }
}

/** The full oriented preview is cached separately from the lightweight crop DOM. */
export function CanvasImageCropOverlay({
  source, sourceSize, turns, flipX, flipY, crop, aspectRatio, sessionKey, disabled = false, english = false, onChange,
}: {
  source: HTMLImageElement;
  sourceSize: CropSourceSize;
  turns: number;
  flipX: boolean;
  flipY: boolean;
  crop: CropRect;
  aspectRatio?: number;
  sessionKey: string;
  disabled?: boolean;
  english?: boolean;
  onChange: (crop: CropRect) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null), stage = useRef<HTMLDivElement>(null), viewport = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const latest = useRef({ crop, sourceSize, sessionKey, disabled, onChange, aspectRatio });
  latest.current = { crop, sourceSize, sessionKey, disabled, onChange, aspectRatio };
  const [fit, setFit] = useState<{ width: number; height: number } | null>(null);
  const [dragging, setDragging] = useState(false), [previewReady, setPreviewReady] = useState(false), [announcement, setAnnouncement] = useState("");
  const helpId = useId(), statusId = useId();
  const active = !disabled && previewReady;
  const narration = (rect: CropRect) => {
    const w = Math.max(1, Math.round(rect.width * sourceSize.width)), h = Math.max(1, Math.round(rect.height * sourceSize.height));
    const x = Math.round(rect.x * sourceSize.width), y = Math.round(rect.y * sourceSize.height);
    return english ? `Crop ${w} by ${h} pixels. Left ${x}, top ${y}.` : `裁剪 ${w} × ${h} 像素，左侧 ${x}，顶部 ${y}。`;
  };
  const blocked = () => setAnnouncement(english ? "This crop cannot be made smaller while keeping its ratio." : "保持当前比例时，裁剪范围无法继续缩小。");

  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    try {
      const factor = Math.min(1, 1000 / Math.max(sourceSize.width, sourceSize.height));
      target.width = Math.max(1, Math.round(sourceSize.width * factor));
      target.height = Math.max(1, Math.round(sourceSize.height * factor));
      const context = target.getContext("2d");
      if (!context) throw Error("canvas-unavailable");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.translate(target.width / 2, target.height / 2);
      context.scale((flipX ? -1 : 1) * target.width / sourceSize.width, (flipY ? -1 : 1) * target.height / sourceSize.height);
      context.rotate(turns * Math.PI / 2);
      context.drawImage(source, -source.naturalWidth / 2, -source.naturalHeight / 2);
      setPreviewReady(true);
    } catch {
      setPreviewReady(false);
    }
    // Deliberately excludes crop and output size: pointer movement never redraws pixels.
  }, [source, sourceSize.width, sourceSize.height, turns, flipX, flipY]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const scale = Math.min(bounds.width / sourceSize.width, bounds.height / sourceSize.height);
      const next = { width: sourceSize.width * scale, height: sourceSize.height * scale };
      setFit(previous => previous?.width === next.width && previous.height === next.height ? previous : next);
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [sourceSize.width, sourceSize.height]);

  // A changed source/orientation or save invalidates a gesture, without writing an old
  // rectangle into the new image. The same applies to changing the fixed crop ratio.
  useLayoutEffect(() => {
    const previous = gesture.current;
    gesture.current = null;
    release(previous);
    setDragging(false);
    setAnnouncement("");
  }, [sessionKey, disabled, aspectRatio]);
  useEffect(() => () => { const previous = gesture.current; gesture.current = null; release(previous); }, []);

  const start = (event: PointerEvent<HTMLButtonElement>, handle: CropHandle | "move") => {
    if (!active || latest.current.disabled || event.button !== 0 || event.isPrimary === false || gesture.current) return;
    const bounds = stage.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    gesture.current = { pointerId: event.pointerId, handle, crop: { ...crop }, x: event.clientX, y: event.clientY, width: bounds.width, height: bounds.height, target: event.currentTarget, sessionKey, aspectRatio };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Unsupported in non-pointer DOM environments. */ }
    setDragging(true);
    setAnnouncement("");
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId || current.sessionKey !== latest.current.sessionKey || latest.current.disabled) return;
    event.preventDefault();
    const delta = { x: (event.clientX - current.x) / current.width, y: (event.clientY - current.y) / current.height };
    try {
      const next = current.handle === "move"
        ? moveCropRect(current.crop, delta, sourceSize)
        : resizeCropRect(current.crop, current.handle, delta, sourceSize, current.aspectRatio);
      latest.current.onChange(next);
    } catch { blocked(); }
  };
  const finish = (cancelled: boolean, pointerId?: number) => {
    const current = gesture.current;
    if (!current || (pointerId !== undefined && current.pointerId !== pointerId)) return;
    gesture.current = null;
    release(current);
    setDragging(false);
    if (current.sessionKey !== latest.current.sessionKey || latest.current.disabled) return;
    if (cancelled) {
      latest.current.onChange(current.crop);
      setAnnouncement(english ? "Crop adjustment cancelled." : "已取消本次裁剪调整。");
    } else setAnnouncement(narration(latest.current.crop));
  };
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>, handle: CropHandle | "move") => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && gesture.current) {
      event.preventDefault(); event.stopPropagation(); finish(true); return;
    }
    if (!active || latest.current.disabled || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault(); event.stopPropagation();
    // Keyboard input ends the current pointer gesture before taking over the box.
    if (gesture.current) finish(false);
    try {
      const delta = cropNudgeDelta(event.key as CropArrowKey, sourceSize, event.shiftKey);
      const next = handle === "move" ? moveCropRect(crop, delta, sourceSize) : resizeCropRect(crop, handle, delta, sourceSize, aspectRatio);
      latest.current.onChange(next);
      setAnnouncement(narration(next));
    } catch { blocked(); }
  };
  return (
    <div className="canvas-image-crop-workspace">
      <div ref={viewport} className="canvas-image-crop-viewport">
        <div ref={stage} className={`canvas-image-crop-stage${dragging ? " is-dragging" : ""}${!active ? " is-disabled" : ""}`}
          style={{ width: fit?.width ?? "100%", height: fit?.height, aspectRatio: `${sourceSize.width} / ${sourceSize.height}` }}
          role="group" aria-label={english ? "Image crop editor" : "图片裁剪编辑器"}
          onPointerMove={move} onPointerUp={event => finish(false, event.pointerId)} onPointerCancel={event => finish(true, event.pointerId)}
          onLostPointerCapture={event => finish(true, event.pointerId)}>
          <canvas ref={canvas} aria-label={english ? "Full oriented image preview" : "完整原图方向预览"} />
          <div className="canvas-image-crop-mask" style={{ left: 0, top: 0, width: "100%", height: percent(crop.y) }} />
          <div className="canvas-image-crop-mask" style={{ left: 0, top: percent(crop.y), width: percent(crop.x), height: percent(crop.height) }} />
          <div className="canvas-image-crop-mask" style={{ left: percent(crop.x + crop.width), top: percent(crop.y), right: 0, height: percent(crop.height) }} />
          <div className="canvas-image-crop-mask" style={{ left: 0, top: percent(crop.y + crop.height), width: "100%", bottom: 0 }} />
          <div className="canvas-image-crop-selection" style={{ left: percent(crop.x), top: percent(crop.y), width: percent(crop.width), height: percent(crop.height) }}>
            <div className="canvas-image-crop-guides" aria-hidden="true" />
            <button type="button" className="canvas-image-crop-move" data-crop-handle="move" disabled={!active}
              aria-label={english ? "Move crop selection" : "移动裁剪选区"} aria-describedby={`${helpId} ${statusId}`}
              onPointerDown={event => start(event, "move")} onKeyDown={event => keyboard(event, "move")} />
            {handles.map(handle => <button key={handle} type="button" className={`canvas-image-crop-handle is-${handle}`} data-crop-handle={handle} disabled={!active}
              aria-label={english ? `Resize ${handleNames.en[handle]}` : `调整裁剪${handleNames.zh[handle]}`} aria-describedby={`${helpId} ${statusId}`}
              onPointerDown={event => start(event, handle)} onKeyDown={event => keyboard(event, handle)} />)}
          </div>
        </div>
      </div>
      <div className="canvas-image-crop-caption">
        <span id={helpId}>{english ? "Drag to crop · Arrow keys 1 px · Shift 10 px" : "拖动调整裁剪 · 方向键 1 像素 · Shift 10 像素"}<span className="canvas-image-crop-sr-only">{english ? ". Escape cancels the current drag." : "。Escape 取消当前拖动。"}</span></span>
        <span>{Math.max(1, Math.round(crop.width * sourceSize.width))} × {Math.max(1, Math.round(crop.height * sourceSize.height))} px</span>
      </div>
      <span id={statusId} className="canvas-image-crop-sr-only" role="status" aria-live="polite" aria-atomic="true" aria-busy={dragging}>{!previewReady ? (english ? "Image preview unavailable." : "图片预览暂时不可用。") : announcement || narration(crop)}</span>
    </div>
  );
}
