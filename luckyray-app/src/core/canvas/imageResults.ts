export type CanvasResultImage = { url: string; thumbnailUrl?: string | null };
export type CanvasImageResultData = {
  resultMediaItems?: CanvasResultImage[];
  resultMediaUrl?: string | null;
  resultThumbnailUrl?: string | null;
};
/** Promote by source index, preserving every result and the immutable task/history output. */
export function selectPrimaryResultImage<T extends CanvasImageResultData>(data: T, sourceIndex: number): T {
  const items = data.resultMediaItems;
  if (!items || !Number.isInteger(sourceIndex) || sourceIndex <= 0 || sourceIndex >= items.length || !items[sourceIndex].url) return data;
  const primary = items[sourceIndex];
  return {
    ...data,
    resultMediaItems: [primary, ...items.filter((_, index) => index !== sourceIndex)],
    resultMediaUrl: primary.url,
    resultThumbnailUrl: primary.thumbnailUrl || null,
  };
}

/** Convert viewport-safe screen bounds back into the transformed canvas coordinate space. */
export function imageResultsStripLayout(input: {
  rootLeft: number; rootWidth: number; viewportLeft: number; viewportRight: number;
  zoom: number; count: number;
}): { left: number; width: number; itemWidth: number } {
  const zoom = Number.isFinite(input.zoom) && input.zoom > 0 ? input.zoom : 1;
  const available = Math.max(1, input.viewportRight - input.viewportLeft);
  const margin = Math.min(12, available / 4);
  const minLeft = input.viewportLeft + margin;
  const maxRight = input.viewportRight - margin;
  const desired = input.rootWidth * Math.max(1, input.count) + 12 * zoom * Math.max(0, input.count - 1);
  const width = Math.max(1, Math.min(desired, 1100, maxRight - minLeft));
  const left = Math.max(minLeft, Math.min(input.rootLeft, maxRight - width));
  return { left: (left - input.rootLeft) / zoom, width: width / zoom, itemWidth: input.rootWidth / zoom };
}

/** Keep earlier generations in the existing same-card switcher; history outputs stay immutable. */
export function mergeImageResults(previous: CanvasImageResultData, output: {
  mediaItems?: CanvasResultImage[];
  mediaUrl?: string | null;
  thumbnailUrl?: string | null;
}): CanvasResultImage[] {
  const incoming = output.mediaItems?.length ? output.mediaItems
    : output.mediaUrl ? [{ url: output.mediaUrl, thumbnailUrl: output.thumbnailUrl }] : [];
  const earlier = previous.resultMediaItems?.length ? previous.resultMediaItems
    : previous.resultMediaUrl ? [{ url: previous.resultMediaUrl, thumbnailUrl: previous.resultThumbnailUrl }] : [];
  const seen = new Set<string>();
  return [...incoming, ...earlier].filter(item => {
    if (!item.url.trim() || seen.has(item.url)) return false;
    seen.add(item.url); return true;
  }).map(item => ({ ...item }));
}
