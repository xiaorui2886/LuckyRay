/** Reuse the already decoded visible cover, never decode a full original on drag. */
export function materialDragPreview(assetId: string): string | undefined {
  try {
    if (typeof document === "undefined" || typeof CSS === "undefined" || !CSS.escape) return;
    const card = document.querySelector<HTMLElement>(`[data-asset-id="${CSS.escape(assetId)}"]`);
    const cover = card?.querySelector<HTMLImageElement>("img");
    if (!cover?.complete || !cover.naturalWidth || !cover.naturalHeight) return;
    const scale = Math.min(192 / cover.naturalWidth, 144 / cover.naturalHeight, 1);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(cover.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(cover.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(cover, 0, 0, canvas.width, canvas.height);
    const png = canvas.toDataURL("image/png");
    return png.length <= 350_000 ? png : undefined;
  } catch { return; } // Tainted/unsupported covers retain the native safe fallback.
}
