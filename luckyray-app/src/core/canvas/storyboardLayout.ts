import { canvasNodeSize, type CanvasArrangementNode } from './canvasArrangement';

// Canvas-space geometry. These are the existing group insets and the 23px
// out-of-flow card heading plus 25px breathing room; never screen/zoom pixels.
export const STORYBOARD_INSETS = { x: 42, top: 58, bottom: 42, gap: 48 } as const;
type LayoutNode = CanvasArrangementNode & { data?: CanvasArrangementNode['data'] & {
  generationAspect?: string; storyboardShot?: { description?: string; action?: string; dialogue?: string };
  directorShotSource?: { version?: number; shot?: { scene?: { camera?: { aspect?: string } } } };
} };

export function generatorCardDimensions(aspectRatio: number): { width: number; height: number } {
  const ratio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1;
  if (ratio >= 1.15) {
    const width = 430;
    return { width, height: Math.max(204, Math.min(374, Math.round(width / ratio))) };
  }
  if (ratio <= .88) {
    const height = 430;
    return { width: Math.max(242, Math.min(378, Math.round(height * ratio))), height };
  }
  return { width: 360, height: 360 };
}


/** Estimated pre-mount summary, matching CanvasShotSummary's capped two-line fields.
 * ReactFlow measurements cover actual mounted sizes. No DOM rects (zoom scaled).
 * Use full-width glyphs for CJK/emoji and preserve explicit newlines.
 */
function summaryHeight(shot: NonNullable<NonNullable<LayoutNode['data']>['storyboardShot']>, width: number): number {
  const usable = Math.max(1, width - 26); // 12px horizontal padding and borders
  const fields = [shot.description, shot.action, shot.dialogue].filter(Boolean) as string[];
  const lines = (text: string) => Math.min(2, text.split('\n').reduce((total, line) => {
    const glyphWidth = Array.from(line).reduce((sum, ch) => sum + (/[^\x00-\xff]/.test(ch) ? 11 : 6.6), 24);
    return total + Math.max(1, Math.ceil(glyphWidth / usable));
  }, 0));
  // Header/button up to 24px, vertical padding+border 22px, each paragraph 6px margin.
  return Math.min(150, 46 + fields.reduce((height, value) => height + 6 + lines(value) * 17.6, 0));
}

export function storyboardNodeSize(node: LayoutNode): { width: number; height: number } {
  if (node.data?.kind === 'image' && node.data.directorShotSource?.version === 1) {
    // These PNGs use the ordinary image preview (560 x 420 cap), not the
    // 300 x 220 unmounted asset fallback or a generator's smaller preview.
    const [w, h] = (node.data.directorShotSource.shot?.scene?.camera?.aspect || '16:9').split(':').map(Number);
    const ratio = w > 0 && h > 0 ? w / h : 16 / 9;
    const width = Math.min(560, 420 * ratio), height = Math.min(420, 560 / ratio);
    const measured = canvasNodeSize(node);
    return { width: Math.max(width + 2, measured.width), height: Math.max(height + 2 + (node.data.storyboardShot ? 8 + summaryHeight(node.data.storyboardShot, width) : 0), measured.height) };
  }
  if (node.data?.kind !== 'generator') {
    const size = canvasNodeSize(node);
    // Assets can be tagged as shots and appended in the same transaction, before
    // ReactFlow observes their newly inserted summary. Conservatively reserve it
    // here rather than risking overlap from a pre-summary measurement.
    return { ...size, height: size.height + (node.data?.storyboardShot ? 8 + summaryHeight(node.data.storyboardShot, size.width) : 0) };
  }
  const [w, h] = (node.data.generationAspect || '1:1').split(':').map(Number);
  const media = generatorCardDimensions(w > 0 && h > 0 ? w / h : 1);
  const measured = canvasNodeSize(node);
  const estimatedHeight = media.height + (node.data.storyboardShot ? 8 + summaryHeight(node.data.storyboardShot, media.width) : 0) + 2;
  // A recently edited summary can outgrow a not-yet-refreshed measurement. Reserve
  // the greater estimate until ReactFlow measures it; never move existing siblings.
  return { width: Math.max(media.width, measured.width), height: Math.max(estimatedHeight, measured.height) };
}

/** Append only. Existing manually positioned cards are never sorted or moved. */
export function storyboardAppendY(members: readonly LayoutNode[]): number {
  return Math.max(STORYBOARD_INSETS.top, ...members.map(node => node.position.y + storyboardNodeSize(node).height + STORYBOARD_INSETS.gap));
}

export function storyboardBounds(members: readonly LayoutNode[]): { width: number; height: number } {
  return {
    width: Math.max(STORYBOARD_INSETS.x * 2, ...members.map(node => node.position.x + storyboardNodeSize(node).width + STORYBOARD_INSETS.x)),
    height: Math.max(STORYBOARD_INSETS.top + STORYBOARD_INSETS.bottom, ...members.map(node => node.position.y + storyboardNodeSize(node).height + STORYBOARD_INSETS.bottom)),
  };
}
