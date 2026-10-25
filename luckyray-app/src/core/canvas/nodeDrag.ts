import type { CanvasNodeKind } from './nodeCapabilities';

export const CANVAS_GENERATOR_DRAG_HANDLE = '.canvas-node-drag-handle';

/** Repair persisted/Agent-created content nodes carrying the generator-only selector.
 * Content cards drag from their body; their actual editors and controls retain nodrag.
 * Keep unrelated custom handles and container drag behavior intact.
 */
export function normalizeCanvasNodeDragHandle<T extends { data: { kind: CanvasNodeKind }; dragHandle?: string }>(node: T): T {
  if (node.data.kind === 'generator') {
    return node.dragHandle === CANVAS_GENERATOR_DRAG_HANDLE
      ? node : { ...node, dragHandle: CANVAS_GENERATOR_DRAG_HANDLE };
  }
  if (node.data.kind !== 'group' && node.dragHandle === CANVAS_GENERATOR_DRAG_HANDLE) {
    return { ...node, dragHandle: undefined };
  }
  return node;
}
