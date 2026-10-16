export type ContextMenuPlacementInput = {
  anchorX: number;
  anchorY: number;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
};

export type ContextMenuPlacementResult = {
  x: number;
  y: number;
  maxHeight?: number;
};

export function calculateContextMenuPosition({
  anchorX,
  anchorY,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
  margin = 8,
}: ContextMenuPlacementInput): ContextMenuPlacementResult {
  const safeMargin = Math.max(0, margin);
  const maxAvailableHeight = Math.max(0, viewportHeight - safeMargin * 2);
  let maxHeight: number | undefined;

  let y: number;
  if (menuHeight > maxAvailableHeight) {
    y = safeMargin;
    maxHeight = maxAvailableHeight;
  } else if (anchorY + menuHeight <= viewportHeight - safeMargin) {
    y = Math.max(safeMargin, anchorY);
  } else {
    const flippedY = anchorY - menuHeight;
    y = Math.max(safeMargin, Math.min(flippedY, viewportHeight - menuHeight - safeMargin));
  }

  let x: number;
  const maxAvailableWidth = Math.max(0, viewportWidth - safeMargin * 2);
  if (menuWidth > maxAvailableWidth) {
    x = safeMargin;
  } else if (anchorX + menuWidth <= viewportWidth - safeMargin) {
    x = Math.max(safeMargin, anchorX);
  } else {
    const flippedX = anchorX - menuWidth;
    x = Math.max(safeMargin, Math.min(flippedX, viewportWidth - menuWidth - safeMargin));
  }

  return { x, y, maxHeight };
}
