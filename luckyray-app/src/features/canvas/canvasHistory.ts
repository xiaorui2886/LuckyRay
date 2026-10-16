/**
 * Canvas-owned undo/redo history helpers.
 *
 * Pure only: no DOM, Tauri, bridge, filesystem, Provider, Material, Agent or
 * storage calls. Snapshots represent document/editor semantic state, never
 * React Flow UI lifecycle state — the C2 Canvas-owned persistence sanitizers
 * are reused so no competing transient-field list exists.
 */

import {
  sanitizeCanvasEdgesForPersistence,
  sanitizeCanvasNodesForPersistence,
} from "./canvasPersistence";

export const CANVAS_HISTORY_MAX_ENTRIES = 80 as const;

export type CanvasHistorySnapshot<TNode = unknown, TEdge = unknown, THistory = unknown> = {
  canvasId: string;
  nodes: TNode[];
  edges: TEdge[];
  generationHistory: THistory[];
};

export type CanvasHistorySource<TNode = unknown, TEdge = unknown, THistory = unknown> = {
  canvasId: string;
  nodes: TNode[];
  edges: TEdge[];
  generationHistory: THistory[];
};

/**
 * Canonicalize a Canvas history snapshot from live editor state.
 *
 * Known editor-transient fields (C2 list) are stripped, and the payload is
 * deep-cloned so the snapshot never shares mutable nested semantic objects
 * with later live edits. Real node position/manual width/height/style,
 * parent/group links, references, generation data and unknown JSON-safe
 * semantic fields are preserved.
 */
export function createCanvasHistorySnapshot<TNode, TEdge, THistory>(
  source: CanvasHistorySource<TNode, TEdge, THistory>,
): CanvasHistorySnapshot<TNode, TEdge, THistory> {
  return {
    canvasId: source.canvasId,
    nodes: structuredClone(sanitizeCanvasNodesForPersistence(source.nodes)),
    edges: structuredClone(sanitizeCanvasEdgesForPersistence(source.edges)),
    generationHistory: structuredClone(source.generationHistory),
  };
}

/**
 * Append one snapshot preserving chronological order (newest last) under the
 * existing max-80 policy; returns a fresh stack.
 */
export function appendCanvasHistoryEntry<T>(stack: readonly T[], entry: T): T[] {
  const next = [...stack, entry];
  while (next.length > CANVAS_HISTORY_MAX_ENTRIES) next.shift();
  return next;
}

/**
 * Structural equality for canonicalized snapshots (JSON-safe payloads with
 * stable key order from the sanitizers). Used to avoid pushing duplicate
 * identical snapshots when flushing a pending edit and immediately beginning
 * a semantic command.
 */
export function canvasHistorySnapshotsEqual(
  left: CanvasHistorySnapshot,
  right: CanvasHistorySnapshot,
): boolean {
  if (left.canvasId !== right.canvasId) return false;
  return JSON.stringify(left.nodes) === JSON.stringify(right.nodes)
    && JSON.stringify(left.edges) === JSON.stringify(right.edges)
    && JSON.stringify(left.generationHistory) === JSON.stringify(right.generationHistory);
}

export type CanvasBeginPendingEditResult<TNode, TEdge, THistory> = {
  snapshot: CanvasHistorySnapshot<TNode, TEdge, THistory>;
  future: CanvasHistorySnapshot<TNode, TEdge, THistory>[];
};

/**
 * Begin a new text/data edit transaction (used by the primary inline-label
 * path and every other label/payload/data updater).
 *
 * When no edit snapshot exists yet, captures one canonical (sanitized,
 * deep-cloned) pre-edit snapshot and **immediately** invalidates the redo
 * stack — a new real edit must kill stale redo now, not after the 800 ms
 * coalescing timer flushes. Continued typing inside the same burst reuses
 * the same snapshot and keeps the (already empty) future.
 */
export function canvasBeginPendingEdit<TNode, TEdge, THistory>(
  existingSnapshot: CanvasHistorySnapshot<TNode, TEdge, THistory> | null,
  future: readonly CanvasHistorySnapshot<TNode, TEdge, THistory>[],
  source: CanvasHistorySource<TNode, TEdge, THistory>,
): CanvasBeginPendingEditResult<TNode, TEdge, THistory> {
  if (existingSnapshot) {
    return { snapshot: existingSnapshot, future: [...future] };
  }
  return {
    snapshot: createCanvasHistorySnapshot(source),
    future: [],
  };
}

export type CanvasResizeEndDecision = {
  commitTransaction: boolean;
  setManualSize: boolean;
  /**
   * A final-size no-op that changed the durable dimension representation
   * (e.g. React Flow materialized top-level width/height) needs a corrective
   * durable save after the representation is restored, even if an earlier
   * resize generation already settled.
   */
  needsCorrectiveSave: boolean;
};

function asNode(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/**
 * Resize-end decision based on the target node's pre-resize snapshot and its
 * current live state:
 *
 * - real final size change (effective width/height differ) → commit the
 *   pre-resize snapshot as exactly one history transaction and set
 *   `_manualSize: true`;
 * - final effective size unchanged but the durable representation changed
 *   (React Flow materialized top-level width/height where none existed, or
 *   changed their values) → no-op for history and `_manualSize`, but the
 *   representation must be restored and a corrective save is needed;
 * - final effective size unchanged and representation identical → pure
 *   no-op: nothing to commit, set or restore.
 */
export function canvasResizeEndDecision(
  beforeNode: unknown,
  afterNode: unknown,
): CanvasResizeEndDecision {
  const before = asNode(beforeNode);
  const after = asNode(afterNode);
  if (nodeDocumentSize(after) !== nodeDocumentSize(before)) {
    return { commitTransaction: true, setManualSize: true, needsCorrectiveSave: false };
  }
  const representationChanged = ("width" in before) !== ("width" in after)
    || ("height" in before) !== ("height" in after)
    || (("width" in before) && before.width !== after.width)
    || (("height" in before) && before.height !== after.height);
  return {
    commitTransaction: false,
    setManualSize: false,
    needsCorrectiveSave: representationChanged,
  };
}

/**
 * Restore only the resize-owned durable dimension representation of a node
 * (top-level `width`/`height` presence and values) from the pre-resize
 * snapshot, immutably. `style`/manual size, position, data, semantic fields
 * and unrelated live state are preserved as-is; React Flow lifecycle fields
 * are never touched here.
 */
export function restoreCanvasNodeDimensionRepresentation(
  afterNode: Record<string, unknown>,
  beforeNode: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(afterNode)) {
    if (key === "width" || key === "height") continue;
    next[key] = afterNode[key];
  }
  if ("width" in beforeNode) next.width = beforeNode.width;
  if ("height" in beforeNode) next.height = beforeNode.height;
  return next;
}

function nodeDocumentSize(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  const record = node as Record<string, unknown>;
  const style = record.style && typeof record.style === "object"
    ? record.style as Record<string, unknown>
    : {};
  const width = record.width ?? style.width;
  const height = record.height ?? style.height;
  if (width === undefined && height === undefined) return null;
  return `${String(width)}x${String(height)}`;
}

/**
 * True when any node's document size (top-level React Flow width/height or
 * style/manual size) changed between two states — i.e. a real resize happened
 * and deserves exactly one history transaction. A no-op resize yields false.
 */
export function canvasResizeChangedDocumentSize(
  beforeNodes: readonly unknown[],
  afterNodes: readonly unknown[],
): boolean {
  const beforeById = new Map<string, unknown>();
  for (const node of beforeNodes) {
    if (!node || typeof node !== "object") continue;
    const id = (node as Record<string, unknown>).id;
    if (typeof id === "string") beforeById.set(id, node);
  }
  return afterNodes.some((node) => {
    if (!node || typeof node !== "object") return false;
    const id = (node as Record<string, unknown>).id;
    if (typeof id !== "string") return false;
    const before = beforeById.get(id);
    if (!before) return false;
    return nodeDocumentSize(node) !== nodeDocumentSize(before);
  });
}
