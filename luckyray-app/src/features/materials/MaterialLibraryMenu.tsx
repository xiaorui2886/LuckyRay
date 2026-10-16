import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import "./materialLibraryNavigation.css";

/** Portals inside an active dialog's top layer, or outside the clipped sidebar. */
export function MaterialLibraryMenu({ anchor, label, onClose, children }: { anchor: HTMLButtonElement; label: string; onClose: (restoreFocus?: boolean) => void; children: ReactNode }) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const id = useId();
  useLayoutEffect(() => {
    const place = () => {
      if (!menu.current) return;
      const rect = anchor.getBoundingClientRect(), popup = menu.current.getBoundingClientRect();
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - popup.width - 8)),
        top: rect.bottom + popup.height + 6 <= window.innerHeight - 8 ? rect.bottom + 6 : Math.max(8, rect.top - popup.height - 6) });
    };
    place();
    const observer = new ResizeObserver(place); observer.observe(anchor); if (anchor.parentElement) observer.observe(anchor.parentElement); if (menu.current) observer.observe(menu.current);
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) place(); };
    window.addEventListener("resize", place); window.addEventListener("scroll", scroll, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", scroll, true); };
  }, [anchor]);
  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (event: PointerEvent) => { if (!anchor.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) onClose(false); };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [position !== null]);
  const keys = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key === "Tab") { onClose(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  };
  return createPortal(<div ref={menu} id={id} role="menu" aria-label={label} className="material-library-menu"
    style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? "visible" : "hidden" }}
    onKeyDown={keys} onClick={event => event.stopPropagation()}>{children}</div>, anchor.closest("dialog") ?? anchor.closest(".react-nav-shell") ?? document.body);
}
