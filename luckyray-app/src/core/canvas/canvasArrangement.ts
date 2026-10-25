export type CanvasArrangementNode = {
  id: string;
  type?: string;
  parentId?: string;
  position: { x: number; y: number };
  measured?: { width?: number; height?: number };
  width?: number;
  height?: number;
  style?: unknown;
  data?: { kind?: string; label?: string };
  extent?: unknown;
};

export type CanvasArrangementEdge = {
  source: string;
  target: string;
};

export type CanvasGroupDraft = {
  id: string;
  label: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  memberIds: string[];
};

const GROUP_PADDING_X = 42;
const GROUP_PADDING_TOP = 58;
const GROUP_PADDING_BOTTOM = 42;
const COLUMN_GAP = 168;
const ROW_GAP = 88;

/** Align a dropped group once, moving selected roots by one shared offset. */
export function snapCanvasGroupDrop<T extends CanvasArrangementNode>(
  nodes: readonly T[], leaderId: string, movedIds: readonly string[], grid: readonly [number, number],
): T[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const leader = byId.get(leaderId);
  if (leader?.data?.kind !== "group") return nodes as T[];
  const moved = new Set(movedIds);
  const roots = nodes.filter(node => {
    if (!moved.has(node.id)) return false;
    let parent = node.parentId;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      if (moved.has(parent)) return false;
      seen.add(parent); parent = byId.get(parent)?.parentId;
    }
    return true;
  });
  if (!roots.some(node => node.id === leaderId)) return nodes as T[];
  let dx = Math.round(leader.position.x / grid[0]) * grid[0] - leader.position.x;
  let dy = Math.round(leader.position.y / grid[1]) * grid[1] - leader.position.y;
  // Keep co-selected nodes inside their existing parent/explicit extents.
  for (const node of roots) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    const size = canvasNodeSize(node);
    const extent = node.extent === "parent" && parent
      ? [[0, 0], [canvasNodeSize(parent).width - size.width, canvasNodeSize(parent).height - size.height]]
      : Array.isArray(node.extent) ? node.extent as number[][] : null;
    if (extent) {
      dx = Math.max(extent[0][0] - node.position.x, Math.min(extent[1][0] - node.position.x, dx));
      dy = Math.max(extent[0][1] - node.position.y, Math.min(extent[1][1] - node.position.y, dy));
    }
  }
  if (!dx && !dy) return nodes as T[];
  const rootIds = new Set(roots.map(node => node.id));
  return nodes.map(node => rootIds.has(node.id)
    ? { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } }
    : node);
}

function dimension(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

export function canvasNodeSize(node: CanvasArrangementNode): { width: number; height: number } {
  const style = (node.style || {}) as { width?: unknown; height?: unknown };
  const width = dimension(node.measured?.width, dimension(node.width, dimension(style.width, 300)));
  const height = dimension(node.measured?.height, dimension(node.height, dimension(style.height, 220)));
  return { width, height };
}

export function createCanvasGroupDraft(
  nodes: readonly CanvasArrangementNode[],
  selectedIds: readonly string[],
  groupId: string,
  label: string,
): CanvasGroupDraft | null {
  const selected = nodes.filter((node) => selectedIds.includes(node.id));
  if (selected.length < 2 || selected.some((node) => node.parentId || node.data?.kind === "group")) return null;
  const minX = Math.min(...selected.map((node) => node.position.x));
  const minY = Math.min(...selected.map((node) => node.position.y));
  const maxX = Math.max(...selected.map((node) => node.position.x + canvasNodeSize(node).width));
  const maxY = Math.max(...selected.map((node) => node.position.y + canvasNodeSize(node).height));
  return {
    id: groupId,
    label,
    position: { x: minX - GROUP_PADDING_X, y: minY - GROUP_PADDING_TOP },
    width: maxX - minX + GROUP_PADDING_X * 2,
    height: maxY - minY + GROUP_PADDING_TOP + GROUP_PADDING_BOTTOM,
    memberIds: selected.map((node) => node.id),
  };
}

export function attachCanvasNodesToGroup<T extends CanvasArrangementNode>(
  nodes: readonly T[],
  draft: CanvasGroupDraft,
  groupNode: T,
): T[] {
  const memberIds = new Set(draft.memberIds);
  return [groupNode, ...nodes.map((node) => memberIds.has(node.id)
    ? {
        ...node,
        parentId: draft.id,
        extent: "parent",
        position: {
          x: node.position.x - draft.position.x,
          y: node.position.y - draft.position.y,
        },
      }
    : { ...node })];
}

export function ungroupCanvasNodes<T extends CanvasArrangementNode>(
  nodes: readonly T[],
  groupIds: readonly string[],
): T[] {
  const ids = new Set(groupIds);
  const groups = new Map(nodes.filter((node) => ids.has(node.id)).map((node) => [node.id, node]));
  return nodes
    .filter((node) => !ids.has(node.id))
    .map((node) => {
      if (!node.parentId || !ids.has(node.parentId)) return { ...node };
      const group = groups.get(node.parentId);
      if (!group) return { ...node };
      const { parentId: _parentId, extent: _extent, ...rest } = node;
      return {
        ...rest,
        position: {
          x: group.position.x + node.position.x,
          y: group.position.y + node.position.y,
        },
      } as T;
    });
}

function topLevelNodeId(nodeId: string, byId: Map<string, CanvasArrangementNode>): string {
  let current = byId.get(nodeId);
  const visited = new Set<string>();
  while (current?.parentId && byId.has(current.parentId) && !visited.has(current.parentId)) {
    visited.add(current.id);
    current = byId.get(current.parentId);
  }
  return current?.id || nodeId;
}

export function arrangeCanvasNodes<T extends CanvasArrangementNode>(
  nodes: readonly T[],
  edges: readonly CanvasArrangementEdge[],
): T[] {
  if (nodes.length < 2) return nodes.map((node) => ({ ...node }));
  const byId = new Map<string, CanvasArrangementNode>(nodes.map((node) => [node.id, node]));
  const units = nodes.filter((node) => !node.parentId || !byId.has(node.parentId));
  if (units.length < 2) return nodes.map((node) => ({ ...node }));

  const unitIds = new Set(units.map((node) => node.id));
  const adjacency = new Map(units.map((node) => [node.id, new Set<string>()]));
  const indegree = new Map(units.map((node) => [node.id, 0]));
  for (const edge of edges) {
    const source = topLevelNodeId(edge.source, byId);
    const target = topLevelNodeId(edge.target, byId);
    if (source === target || !unitIds.has(source) || !unitIds.has(target)) continue;
    const targets = adjacency.get(source)!;
    if (targets.has(target)) continue;
    targets.add(target);
    indegree.set(target, (indegree.get(target) || 0) + 1);
  }

  const originalOrder = (a: string, b: string) => {
    const nodeA = byId.get(a)!;
    const nodeB = byId.get(b)!;
    return nodeA.position.y - nodeB.position.y || nodeA.position.x - nodeB.position.x;
  };
  const queue = units.filter((node) => indegree.get(node.id) === 0).map((node) => node.id).sort(originalOrder);
  const layers = new Map(units.map((node) => [node.id, 0]));
  const processed = new Set<string>();
  while (queue.length) {
    const source = queue.shift()!;
    processed.add(source);
    for (const target of adjacency.get(source) || []) {
      layers.set(target, Math.max(layers.get(target) || 0, (layers.get(source) || 0) + 1));
      indegree.set(target, (indegree.get(target) || 0) - 1);
      if (indegree.get(target) === 0) {
        queue.push(target);
        queue.sort(originalOrder);
      }
    }
  }

  let cycleLayer = Math.max(0, ...layers.values());
  units.filter((node) => !processed.has(node.id)).sort((a, b) => a.position.x - b.position.x)
    .forEach((node) => layers.set(node.id, cycleLayer++));

  const columns = new Map<number, T[]>();
  for (const unit of units) {
    const layer = layers.get(unit.id) || 0;
    const column = columns.get(layer) || [];
    column.push(unit);
    columns.set(layer, column);
  }
  for (const column of columns.values()) column.sort((a, b) => a.position.y - b.position.y);

  const originX = Math.min(...units.map((node) => node.position.x));
  const originY = Math.min(...units.map((node) => node.position.y));
  const columnEntries = [...columns.entries()].sort(([a], [b]) => a - b);
  const columnHeights = columnEntries.map(([, column]) => column.reduce((sum, node, index) => sum + canvasNodeSize(node).height + (index ? ROW_GAP : 0), 0));
  const maxColumnHeight = Math.max(...columnHeights);
  const nextPositions = new Map<string, { x: number; y: number }>();
  let x = originX;
  columnEntries.forEach(([, column], columnIndex) => {
    const columnWidth = Math.max(...column.map((node) => canvasNodeSize(node).width));
    let y = originY + (maxColumnHeight - columnHeights[columnIndex]) / 2;
    column.forEach((node) => {
      nextPositions.set(node.id, { x, y });
      y += canvasNodeSize(node).height + ROW_GAP;
    });
    x += columnWidth + COLUMN_GAP;
  });

  return nodes.map((node) => nextPositions.has(node.id)
    ? { ...node, position: nextPositions.get(node.id)! }
    : { ...node });
}
