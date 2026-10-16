import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { calculateContextMenuPlacement, type ContextMenuPlacement } from "./contextMenuPlacement";
export { CONTEXT_MENU_VIEWPORT_MARGIN } from "./contextMenuPlacement";

function directMenuItems(menu: HTMLElement) {
  return Array.from(menu.querySelectorAll<HTMLElement>(
    ':scope > [data-context-menu-item="root"], :scope > [data-context-menu-entry="root"] > [data-context-menu-item="root"]',
  )).filter((item) => !item.matches(":disabled") && item.getAttribute("aria-disabled") !== "true");
}

export function moveContextMenuFocus(menu: HTMLElement, current: HTMLElement | null, key: "ArrowDown" | "ArrowUp" | "Home" | "End") {
  const items = directMenuItems(menu);
  if (!items.length) return;
  const currentIndex = current ? items.indexOf(current) : -1;
  let nextIndex = 0;
  if (key === "End") nextIndex = items.length - 1;
  else if (key === "ArrowDown") nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
  else if (key === "ArrowUp") nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
  const next = items[nextIndex];
  next?.focus({ preventScroll: true });
  next?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

export function ContextMenuSurface({
  x,
  y,
  className,
  placementKey,
  label,
  returnFocusTo,
  onRequestClose,
  children,
}: {
  x: number;
  y: number;
  className: string;
  placementKey?: string | number;
  label: string;
  returnFocusTo?: HTMLElement | null;
  onRequestClose: (reason: "escape" | "tab") => void;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<ContextMenuPlacement & { ready: boolean }>({
    x,
    y,
    ready: false,
  });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const place = () => {
      const next = calculateContextMenuPlacement({
        anchorX: x,
        anchorY: y,
        menuWidth: menu.offsetWidth,
        menuHeight: menu.scrollHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      });
      setPlacement((current) => current.ready
        && current.x === next.x
        && current.y === next.y
        && current.maxHeight === next.maxHeight
        ? current
        : { ...next, ready: true });
    };
    place();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    resizeObserver?.observe(menu);
    window.addEventListener("resize", place);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [placementKey, x, y]);

  useLayoutEffect(() => {
    if (!placement.ready) return;
    directMenuItems(menuRef.current as HTMLElement)[0]?.focus({ preventScroll: true });
  }, [placement.ready, placementKey, x, y]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (event.key === "Enter" || event.key === " ") {
      const target = document.activeElement as HTMLButtonElement | null;
      if (target?.matches('[role="menuitem"]')) {
        event.preventDefault();
        event.stopPropagation();
        target.click();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onRequestClose("escape");
      return;
    }
    if (event.key === "Tab") {
      window.setTimeout(() => onRequestClose("tab"), 0);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      event.stopPropagation();
      moveContextMenuFocus(event.currentTarget, document.activeElement as HTMLElement | null, event.key);
    }
  };

  const style: CSSProperties = {
    left: placement.x,
    top: placement.y,
    maxHeight: placement.maxHeight,
    visibility: placement.ready ? "visible" : "hidden",
  };

  return (
    <div
      ref={menuRef}
      className={className}
      role="menu"
      aria-label={label}
      style={style}
      onKeyDown={handleKeyDown}
      onClickCapture={(event) => {
        if ((event.target as HTMLElement | null)?.closest('[role="menuitem"]') && returnFocusTo?.isConnected) {
          returnFocusTo.focus({ preventScroll: true });
        }
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}
