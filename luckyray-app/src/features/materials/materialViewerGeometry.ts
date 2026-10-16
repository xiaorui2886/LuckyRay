export type MaterialViewerBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type MaterialViewerRect = Pick<DOMRectReadOnly, "left" | "top" | "right" | "bottom">;

export function resolveMaterialViewerBounds(
  mainRect: MaterialViewerRect,
  titlebarHeight: number,
): MaterialViewerBounds {
  const safeTitlebarHeight = Number.isFinite(titlebarHeight) ? Math.max(0, titlebarHeight) : 0;
  const top = mainRect.top + safeTitlebarHeight;
  return {
    left: mainRect.left,
    top,
    width: Math.max(0, mainRect.right - mainRect.left),
    height: Math.max(0, mainRect.bottom - top),
  };
}
