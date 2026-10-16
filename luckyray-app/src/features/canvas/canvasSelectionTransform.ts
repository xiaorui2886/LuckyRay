type CanvasSelectableNode = {
  id: string;
  selected?: boolean;
  parentId?: string;
  data?: { kind?: string };
  position?: { x: number; y: number };
};

type CanvasPositionPlan = {
  positions: Map<string, number>;
  changed: boolean;
};

export function selectedCanvasIdsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}

export function synchronizeCanvasNodeSelection<T extends CanvasSelectableNode>(
  nodes: readonly T[],
  selectedIds: readonly string[],
): T[] {
  const ids = new Set(selectedIds);
  return nodes.map((node) => {
    const selected = ids.has(node.id);
    return node.selected === selected ? node : { ...node, selected };
  });
}

export function selectedCanvasGroupContainerIds<T extends CanvasSelectableNode>(
  nodes: readonly T[],
  selectedIds: readonly string[],
): string[] {
  const selected = new Set(selectedIds);
  return nodes
    .filter((node) => selected.has(node.id) && node.data?.kind === "group")
    .map((node) => node.id);
}

export function canUngroupCanvasSelection<T extends CanvasSelectableNode>(
  nodes: readonly T[],
  selectedIds: readonly string[],
): boolean {
  if (selectedIds.length === 0) return false;
  const selected = new Set(selectedIds);
  const groupIds = selectedCanvasGroupContainerIds(nodes, selectedIds);
  return groupIds.length === selected.size;
}

function selectedCanvasTransformNodes<T extends CanvasSelectableNode>(
  nodes: readonly T[],
  selectedIds: readonly string[],
): T[] | null {
  const ids = new Set(selectedIds);
  const selected = nodes.filter((node) => ids.has(node.id));
  if (ids.size === 0 || selected.length !== ids.size || selected.some((node) => !node.position)) return null;
  return selected;
}

export function isSafeCanvasTransformSelection<T extends CanvasSelectableNode>(
  nodes: readonly T[],
  selectedIds: readonly string[],
): boolean {
  const selected = selectedCanvasTransformNodes(nodes, selectedIds);
  if (!selected || selected.some((node) => node.data?.kind === "group")) return false;
  const parentIds = new Set(selected.map((node) => node.parentId || null));
  return parentIds.size === 1;
}

export function planCanvasLeftAlignment<T extends CanvasSelectableNode>(
  nodes: readonly T[],
  selectedIds: readonly string[],
): CanvasPositionPlan | null {
  if (!isSafeCanvasTransformSelection(nodes, selectedIds)) return null;
  const selected = selectedCanvasTransformNodes(nodes, selectedIds)!;
  if (selected.length < 2) return null;
  const left = Math.min(...selected.map((node) => node.position!.x));
  const positions = new Map(selected.map((node) => [node.id, left]));
  return {
    positions,
    changed: selected.some((node) => node.position!.x !== left),
  };
}

export function planCanvasHorizontalDistribution<T extends CanvasSelectableNode>(
  nodes: readonly T[],
  selectedIds: readonly string[],
): CanvasPositionPlan | null {
  if (!isSafeCanvasTransformSelection(nodes, selectedIds)) return null;
  const selected = selectedCanvasTransformNodes(nodes, selectedIds)!;
  if (selected.length < 3) return null;
  const ordered = [...selected].sort((left, right) =>
    left.position!.x - right.position!.x || left.id.localeCompare(right.id),
  );
  const first = ordered[0].position!.x;
  const last = ordered[ordered.length - 1].position!.x;
  const step = (last - first) / (ordered.length - 1);
  const positions = new Map(ordered.map((node, index) => [node.id, first + step * index]));
  return {
    positions,
    changed: ordered.some((node) => node.position!.x !== positions.get(node.id)),
  };
}
