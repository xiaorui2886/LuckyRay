import type { ReferenceEntry } from "./referencePlan";
import type { CanvasEdgeRole } from "./edgeSemantics";
export function planReferenceReorder(
  entries: readonly ReferenceEntry[],
  from: string,
  to: string,
): { order: string[]; roles: Map<string, CanvasEdgeRole> } | null {
  const a = entries.findIndex((entry) => entry.key === from),
    b = entries.findIndex((entry) => entry.key === to);
  if (a < 0 || b < 0 || a === b) return null;
  const left = entries[a],
    right = entries[b],
    roles = new Map<string, CanvasEdgeRole>();
  if (left.role !== right.role) {
    if (
      !["firstFrame", "lastFrame"].includes(left.role) ||
      !["firstFrame", "lastFrame"].includes(right.role)
    )
      return null;
    roles.set(left.key, right.role);
    roles.set(right.key, left.role);
  }
  const order = entries.map((entry) => entry.key);
  const [item] = order.splice(a, 1);
  order.splice(b, 0, item);
  return { order, roles };
}
