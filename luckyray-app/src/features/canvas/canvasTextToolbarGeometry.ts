/** Screen-space placement. The node name sits 23 canvas units above the card. */
export function canvasTextToolbarGeometry(centerX: number, nodeTop: number, zoom: number, viewportWidth: number, viewportHeight: number, toolbarWidth: number, toolbarHeight: number) {
  const margin = 8;
  // Match the existing canvas image-toolbar safe area around stage chrome.
  const topChrome = 76, bottomChrome = 56;
  const offset = 23 * zoom + 12;
  const maxWidth = Math.max(0, viewportWidth - margin * 2);
  const width = Math.min(toolbarWidth, maxWidth);
  const left = Math.max(margin, Math.min(centerX - width / 2, viewportWidth - margin - width));
  const bottom = nodeTop - offset;
  return { offset, maxWidth, shiftX: left + width / 2 - centerX,
    // Never pin a detached toolbar to the edge or cover the node name.
    visible: viewportWidth > margin * 2 && centerX >= 0 && centerX <= viewportWidth && bottom - toolbarHeight >= topChrome && bottom <= viewportHeight - bottomChrome };
}
