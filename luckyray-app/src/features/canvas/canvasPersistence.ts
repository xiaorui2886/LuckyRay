/**
 * Canvas-owned durable persistence boundary.
 *
 * Pure helpers only: no DOM, Tauri, bridge, Provider, Material, Agent,
 * filesystem or storage calls. UI-only editor state (selection, React Flow
 * measurement, transient highlights) must never reach durable Canvas JSON,
 * otherwise every click would churn durable revisions and create avoidable
 * revision conflicts with parallel Canvas Agent commits.
 */

import type { EdgeChange, NodeChange, NodeDimensionChange } from "@xyflow/react";

/**
 * A `dimensions` change is explicit (user resize / layout-enforced size) when
 * React Flow marks it with `setAttributes`. Measurement-only dimension updates
 * (DOM measurement pass) carry no `setAttributes` and are editor-transient.
 */
export function isExplicitCanvasDimensionChange(change: NodeDimensionChange): boolean {
  return change.setAttributes === true
    || change.setAttributes === "width"
    || change.setAttributes === "height";
}

/**
 * True when a node change batch contains at least one durable document edit.
 * Selection-only and measurement-only dimension updates are ephemeral.
 */
export function nodeChangesContainDurableEdit(changes: readonly NodeChange[]): boolean {
  return changes.some((change) => {
    switch (change.type) {
      case "select":
        return false;
      case "dimensions":
        return isExplicitCanvasDimensionChange(change);
      case "position":
      case "add":
      case "remove":
      case "replace":
        return true;
      default:
        return false;
    }
  });
}

/**
 * True when an edge change batch contains at least one durable document edit.
 * Selection-only edge changes are ephemeral.
 */
export function edgeChangesContainDurableEdit(changes: readonly EdgeChange[]): boolean {
  return changes.some((change) => change.type !== "select");
}

const NODE_TRANSIENT_KEYS = new Set(["selected", "dragging", "resizing", "measured"]);
const EDGE_TRANSIENT_KEYS = new Set(["selected"]);
const NODE_DATA_TRANSIENT_KEYS = new Set(["_newHighlight"]);

function stripKeys(input: Record<string, unknown>, keys: ReadonlySet<string>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (keys.has(key)) continue;
    next[key] = input[key];
  }
  return next;
}

/**
 * Strip known editor-transient fields from nodes for durable persistence.
 * `resizing` (React Flow NodeResizeControl lifecycle flag, true while a resize
 * is in progress and false on release) is editor UI state, never document
 * truth, and is stripped like `selected`/`dragging`/`measured`. Preserves
 * position, style/manual size, parent/group links, node data, references,
 * generation data and unknown JSON-safe semantic fields. Does not mutate the
 * input; returns a fresh array of fresh objects.
 */
export function sanitizeCanvasNodesForPersistence<T>(nodes: readonly T[]): T[] {
  return nodes.map((node) => {
    if (!node || typeof node !== "object") return node;
    const record = node as Record<string, unknown>;
    const next = stripKeys(record, NODE_TRANSIENT_KEYS);
    if (record.data && typeof record.data === "object") {
      next.data = stripKeys(record.data as Record<string, unknown>, NODE_DATA_TRANSIENT_KEYS);
    }
    return next as T;
  });
}

/**
 * Strip known editor-transient fields from edges for durable persistence.
 * Preserves semantic edge data and unknown JSON-safe fields. Does not mutate
 * the input; returns a fresh array of fresh objects.
 */
export function sanitizeCanvasEdgesForPersistence<T>(edges: readonly T[]): T[] {
  return edges.map((edge) => {
    if (!edge || typeof edge !== "object") return edge;
    return stripKeys(edge as Record<string, unknown>, EDGE_TRANSIENT_KEYS) as T;
  });
}

/**
 * Advance the durable edit generation. Every real document edit must advance
 * the generation so an in-flight save can tell whether newer edits happened
 * while it was running.
 */
export function advanceCanvasEditGeneration(current: number): number {
  return current + 1;
}

/**
 * A save completion may mark the Canvas clean only when the generation the
 * save captured still matches the current edit generation. When a newer edit
 * advanced the generation while the save was in flight, the Canvas must stay
 * dirty and the newer state must receive a later save.
 */
export function canvasSaveCompletionMayMarkClean(editGeneration: number, savedGeneration: number): boolean {
  return editGeneration === savedGeneration;
}

/**
 * Canvas-local serialized save slot. At most one durable write
 * (`bridge.saveCanvas`) may be in flight for the Canvas; both the explicit
 * save and the autosave paths share this single authority so they can never
 * write concurrently against the same expected revision.
 */
export type CanvasSaveSlot = {
  occupied: boolean;
};

export function tryAcquireCanvasSaveSlot(slot: CanvasSaveSlot): boolean {
  if (slot.occupied) return false;
  slot.occupied = true;
  return true;
}

export function releaseCanvasSaveSlot(slot: CanvasSaveSlot): void {
  slot.occupied = false;
}

/**
 * A save must write only against the identity of the currently open canvas.
 * After waiting for an in-flight save, the identity must be re-read and
 * validated with this rule; never carry an expected revision/digest across
 * the wait.
 */
export function canvasSaveIdentityMatchesCanvas(
  identity: { canvasId: string } | null | undefined,
  canvasId: string,
): identity is { canvasId: string } {
  return identity !== null && identity !== undefined && identity.canvasId === canvasId;
}

/**
 * A serialized follow-up save may be requested only after a *successful* save
 * that discovered newer edits while it was in flight. A failed save must stay
 * dirty/error and stop immediate automatic recursion; a later real edit or an
 * explicit user save may retry instead of spinning continuously.
 */
export function canvasStaleSaveShouldFollowUp(
  saveSucceeded: boolean,
  editGeneration: number,
  lastSavedGeneration: number,
): boolean {
  return saveSucceeded && editGeneration !== lastSavedGeneration;
}
