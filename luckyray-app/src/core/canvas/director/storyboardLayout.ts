import { canvasNodeSize, type CanvasArrangementNode } from '../canvasArrangement';
import { storyboardNodeSize } from '../storyboardLayout';

// Canvas-space values, independent of viewport zoom. Keep ordinary R15 spacing.
export const DIRECTOR_STORYBOARD_INSETS = { x: 64, top: 88, bottom: 64, gap: 80 } as const;
type DirectorNode = Parameters<typeof storyboardNodeSize>[0] & { data?: CanvasArrangementNode['data'] & {
  directorDocument?: unknown; directorShotSource?: { version?: number }; storyboard?: { version?: number };
} };

export function directorStoryboardAppendY(members: readonly DirectorNode[]): number {
  return Math.max(DIRECTOR_STORYBOARD_INSETS.top, ...members.map(node => node.position.y + storyboardNodeSize(node).height + DIRECTOR_STORYBOARD_INSETS.gap));
}

export function directorStoryboardBounds(members: readonly DirectorNode[]): { width: number; height: number } {
  return {
    width: Math.max(540, ...members.map(node => node.position.x + storyboardNodeSize(node).width + DIRECTOR_STORYBOARD_INSETS.x)),
    height: Math.max(300, ...members.map(node => node.position.y + storyboardNodeSize(node).height + DIRECTOR_STORYBOARD_INSETS.bottom)),
  };
}

/** Fit existing compact director stacks only. Preserve group origins, content,
 * spacious/custom layouts and every non-director node. Idempotent and immutable.
 */
export function spaceDirectorStoryboards<T extends DirectorNode>(nodes: T[]): T[] {
  const replacements = new Map<string, T>();
  for (const board of nodes) {
    if (board.data?.directorDocument === undefined || board.data.storyboard?.version !== 1) continue;
    const members = nodes.filter(node => node.parentId === board.id);
    if (!members.length) continue;
    const stack = [...members].sort((a, b) => a.position.y - b.position.y);
    const alignedFrames = stack.every(node => node.data?.directorShotSource?.version === 1 && Math.abs(node.position.x - stack[0].position.x) < 1);
    let nextY: number = DIRECTOR_STORYBOARD_INSETS.top;
    const fitted = stack.map(node => {
      if (!alignedFrames) return node;
      const position = { x: Math.max(DIRECTOR_STORYBOARD_INSETS.x, node.position.x), y: Math.max(nextY, node.position.y) };
      nextY = position.y + storyboardNodeSize(node).height + DIRECTOR_STORYBOARD_INSETS.gap;
      if (position.x === node.position.x && position.y === node.position.y) return node;
      const next = { ...node, position }; replacements.set(node.id, next); return next;
    });
    const bounds = directorStoryboardBounds(fitted), size = canvasNodeSize(board);
    const style = (board.style || {}) as { width?: number; height?: number };
    const width = Math.max(size.width, style.width || 0, bounds.width), height = Math.max(size.height, style.height || 0, bounds.height);
    if (width !== style.width || height !== style.height) replacements.set(board.id, { ...board, style: { ...style, width, height } });
  }
  return replacements.size ? nodes.map(node => replacements.get(node.id) || node) : nodes;
}
