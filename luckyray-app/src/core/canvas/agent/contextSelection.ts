/** Read-only task context selection. Never authorizes an edit or generation. */
export type TaskContextNode = {
  id: string; title?: string; kind?: string; text?: string; revision?: string;
  parentId?: string; selected?: boolean;
  layout?: { x: number; y: number; parentId?: string };
  position?: { x: number; y: number }; width?: number; height?: number;
  data?: { label?: unknown; kind?: unknown; text?: unknown; [key: string]: unknown };
};
export type TaskContextConnection = { source: string; target: string };
export type TaskContextRequest = {
  targetNodeIds?: readonly string[]; selectedNodeIds?: readonly string[];
  referenceNodeIds?: readonly string[]; retainedNodeIds?: readonly string[];
  /** Optional transport working-set budget, not a task/capability limit. */
  maxNodes?: number;
  /** Full read bypasses task selection. The caller may page the returned data. */
  full?: boolean;
};
const sortedUnique = (ids: readonly string[]) => [...new Set(ids)].sort();

/**
 * All lightweight summaries remain visible, including omitted-node identities.
 * Full text is included only for chosen nodes; overview is never read evidence.
 * Targets/selection/references outrank neighbors and retained context. Required
 * IDs are never silently dropped if they exceed an optional transport budget.
 */
export function selectTaskContext<T extends TaskContextNode>(
  nodes: readonly T[], connections: readonly TaskContextConnection[], request: TaskContextRequest = {},
) {
  if (request.maxNodes !== undefined && (!Number.isSafeInteger(request.maxNodes) || request.maxNodes < 1)) throw new Error('canvas-context-invalid-budget');
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (byId.size !== nodes.length) throw new Error('canvas-context-duplicate-id');
  const sourceSelected = nodes.filter(node => node.selected).map(node => node.id);
  const required = sortedUnique([...(request.targetNodeIds ?? []), ...(request.selectedNodeIds ?? sourceSelected), ...(request.referenceNodeIds ?? [])]);
  const missingNodeIds = required.filter(id => !byId.has(id));
  const requiredPresent = required.filter(id => byId.has(id));
  const requiredSet = new Set(requiredPresent);
  const neighbors = new Set<string>();
  for (const node of nodes) {
    const parent = node.parentId ?? node.layout?.parentId;
    if (parent && requiredSet.has(node.id) && byId.has(parent)) neighbors.add(parent);
    if (parent && requiredSet.has(parent)) neighbors.add(node.id);
  }
  for (const edge of connections) {
    if (requiredSet.has(edge.source) && byId.has(edge.target)) neighbors.add(edge.target);
    if (requiredSet.has(edge.target) && byId.has(edge.source)) neighbors.add(edge.source);
  }
  const retained = sortedUnique(request.retainedNodeIds ?? []).filter(id => byId.has(id));
  const allIds = [...byId.keys()].sort();
  const priority = [...new Set([...requiredPresent, ...[...neighbors].sort(), ...retained, ...allIds])];
  const budget = request.full ? nodes.length : request.maxNodes ?? nodes.length;
  const chosenIds = priority.slice(0, Math.max(requiredPresent.length, budget));
  const chosen = new Set(chosenIds);
  const omittedNodeIds = allIds.filter(id => !chosen.has(id));
  const overview = allIds.map(id => {
    const node = byId.get(id)!;
    const position = node.layout ?? node.position;
    const text = node.text ?? (typeof node.data?.text === 'string' ? node.data.text : '');
    return {
      id, title: node.title ?? (typeof node.data?.label === 'string' ? node.data.label : id),
      kind: node.kind ?? (typeof node.data?.kind === 'string' ? node.data.kind : 'unknown'),
      ...(node.revision ? { revision: node.revision } : {}),
      ...(node.parentId ?? node.layout?.parentId ? { parentId: node.parentId ?? node.layout?.parentId } : {}),
      ...(position ? { bounds: { x: position.x, y: position.y, ...(node.width !== undefined ? { width: node.width } : {}), ...(node.height !== undefined ? { height: node.height } : {}) } } : {}),
      textCharacters: text.length, fullTextIncluded: chosen.has(id),
    };
  });
  return {
    nodes: chosenIds.map(id => byId.get(id)!), nodeIds: chosenIds, overview,
    connections: connections.filter(edge => chosen.has(edge.source) && chosen.has(edge.target)),
    coverage: {
      scope: request.full ? 'full-canvas' : 'task-working-set', complete: omittedNodeIds.length === 0,
      totalNodes: nodes.length, suppliedNodes: chosenIds.length, omittedNodes: omittedNodeIds.length,
      omittedNodeIds, missingNodeIds, requiredNodeIds: requiredPresent,
      neighborNodeIds: [...neighbors].filter(id => chosen.has(id)).sort(),
      transportBudgetExceeded: chosenIds.length > budget,
      omittedConnections: connections.filter(edge => !chosen.has(edge.source) || !chosen.has(edge.target)).length,
      notice: 'Overview summaries are not evidence that full text or images were read. Read omitted targets and every source page explicitly; selection does not grant permissions.',
    },
  };
}
