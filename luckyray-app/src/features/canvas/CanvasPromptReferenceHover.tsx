import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { ReferenceEntry } from "../../core/canvas/referencePlan";
import { CanvasReferenceHover } from "./CanvasReferenceHover";

/** One passive portal owned by the editor, outside its editable/scrolling DOM. */
export function CanvasPromptReferenceHover({ id, anchor, entry }: {
  id: string;
  anchor: HTMLElement;
  entry: ReferenceEntry;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const stage = anchor.closest<HTMLElement>(".canvas-editor-stage");
  const portal = stage || anchor.ownerDocument.body;
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const isText = entry.reference.kind !== "image" && entry.reference.kind !== "video";
  useLayoutEffect(() => {
    const window = anchor.ownerDocument.defaultView;
    const layer = surface.current;
    if (!window || !layer) return;
    let frame = 0;
    let signature = "";
    const place = () => {
      if (!anchor.isConnected) return;
      const margin = 8;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const stageRect = stage?.getBoundingClientRect();
      const bounds = stageRect && stageRect.width && stageRect.height
        ? { left: Math.max(0, stageRect.left), right: Math.min(viewportWidth, stageRect.right),
            top: Math.max(0, stageRect.top), bottom: Math.min(viewportHeight, stageRect.bottom) }
        : { left: 0, right: viewportWidth, top: 0, bottom: viewportHeight };
      const width = Math.max(0, Math.min(isText ? 240 : 112, bounds.right - bounds.left - margin * 2));
      const maxHeight = Math.max(0, Math.min(isText ? 180 : 160, bounds.bottom - bounds.top - margin * 2));
      const rect = anchor.getBoundingClientRect();
      const height = Math.min(layer.getBoundingClientRect().height || maxHeight, maxHeight);
      const above = rect.top - height - 7;
      const below = rect.bottom + 7;
      const preferredTop = above >= bounds.top + margin ? above : below;
      const top = Math.max(bounds.top + margin, Math.min(preferredTop, bounds.bottom - height - margin));
      const left = Math.max(bounds.left + margin, Math.min(rect.left, bounds.right - width - margin));
      const computed = window.getComputedStyle(anchor);
      // The canvas theme inherits through the stage portal. Also preserve any
      // composer-local overrides and the standalone editor's body fallback.
      const theme = Object.fromEntries([
        "--theme-glass-bg", "--text-primary", "--text-secondary",
      ].map(name => [name, computed.getPropertyValue(name).trim()]));
      const scaleX = stageRect && stage?.offsetWidth ? stageRect.width / stage.offsetWidth : 1;
      const scaleY = stageRect && stage?.offsetHeight ? stageRect.height / stage.offsetHeight : 1;
      const next = { ...theme,
        position: stage ? "absolute" : "fixed",
        visibility: rect.bottom >= bounds.top && rect.top <= bounds.bottom &&
          rect.right >= bounds.left && rect.left <= bounds.right && computed.visibility !== "hidden"
          ? "visible" : "hidden",
        left: stage && stageRect ? (left - stageRect.left) / scaleX - stage.clientLeft + stage.scrollLeft : left,
        top: stage && stageRect ? (top - stageRect.top) / scaleY - stage.clientTop + stage.scrollTop : top,
        width: width / scaleX, maxHeight: maxHeight / scaleY,
        fontFamily: computed.fontFamily } as CSSProperties;
      const nextSignature = JSON.stringify(next);
      if (signature !== nextSignature) {
        signature = nextSignature;
        setStyle(next);
      }
    };
    place();
    // The composer can move with a transformed canvas without a scroll event.
    const track = () => { place(); frame = window.requestAnimationFrame(track); };
    if (window.requestAnimationFrame) frame = window.requestAnimationFrame(track);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(layer);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      observer?.disconnect();
    };
  }, [anchor, isText, stage]);
  return createPortal(
    <div ref={surface} id={id} className={`canvas-prompt-reference-floating${isText ? " is-text" : ""}`} style={style}>
      <CanvasReferenceHover entry={entry} />
    </div>,
    portal,
  );
}
