export const CONTEXT_MENU_VIEWPORT_MARGIN = 8;

export type ContextMenuPlacement = {
  x: number;
  y: number;
  maxHeight?: number;
};

export function calculateContextMenuPlacement({
  anchorX,
  anchorY,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
  margin = CONTEXT_MENU_VIEWPORT_MARGIN,
}: {
  anchorX: number;
  anchorY: number;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
}): ContextMenuPlacement {
  const safeMargin = Math.max(0, margin);
  const availableHeight = Math.max(0, viewportHeight - safeMargin * 2);
  const availableWidth = Math.max(0, viewportWidth - safeMargin * 2);
  const maxHeight = menuHeight > availableHeight ? availableHeight : undefined;

  const x = menuWidth > availableWidth
    ? safeMargin
    : anchorX + menuWidth <= viewportWidth - safeMargin
      ? Math.max(safeMargin, anchorX)
      : Math.max(safeMargin, Math.min(anchorX - menuWidth, viewportWidth - menuWidth - safeMargin));
  const y = menuHeight > availableHeight
    ? safeMargin
    : anchorY + menuHeight <= viewportHeight - safeMargin
      ? Math.max(safeMargin, anchorY)
      : Math.max(safeMargin, Math.min(anchorY - menuHeight, viewportHeight - menuHeight - safeMargin));

  return { x, y, maxHeight };
}
