export type GraphPlaybackNodeInput = {
  id: number;
  x: number;
  y: number;
  links: number;
  timelineAt?: number;
};

export type GraphPlaybackEdgeInput = {
  a: number;
  b: number;
};

export type GraphPlaybackNodePlan = {
  id: number;
  startAt: number;
  duration: number;
  parentId: number | null;
  layer: number;
  spawnX: number;
  spawnY: number;
  targetX: number;
  targetY: number;
  curve: number;
};

export type GraphPlaybackEdgePlan = {
  startAt: number;
  duration: number;
  fromId: number;
  toId: number;
  treeEdge: boolean;
};

export type GraphPlaybackPlan = {
  startedAt: number;
  totalDuration: number;
  rootIds: number[];
  nodes: Map<number, GraphPlaybackNodePlan>;
  edges: Map<string, GraphPlaybackEdgePlan>;
};

export type GraphPlaybackNodeVisual = {
  x: number;
  y: number;
  scale: number;
  alpha: number;
  progress: number;
};

const DAY_MS = 86_400_000;
const NODE_SETTLE_MS = 1_100;
const PLAYBACK_LEAD_IN_MS = 180;
const PLAYBACK_TAIL_MS = 460;

export function graphPlaybackEdgeKey(a: number, b: number) {
  return `${Math.min(a, b)}:${Math.max(a, b)}`;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(value: number) {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function deterministicUnit(id: number) {
  const angle = (id * 2.399963229728653) % (Math.PI * 2);
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

function dampedSpring(value: number, damping = 0.72, frequency = 9.4) {
  const t = Math.max(0, value);
  if (t >= 1) return 1;
  const safeDamping = Math.max(0.05, Math.min(0.98, damping));
  const dampedFrequency = frequency * Math.sqrt(1 - safeDamping * safeDamping);
  const envelope = Math.exp(-safeDamping * frequency * t);
  const phase = Math.cos(dampedFrequency * t)
    + (safeDamping / Math.sqrt(1 - safeDamping * safeDamping)) * Math.sin(dampedFrequency * t);
  return 1 - envelope * phase;
}

function chooseStrongestNode(ids: Iterable<number>, nodes: Map<number, GraphPlaybackNodeInput>) {
  let strongest: number | null = null;
  for (const id of ids) {
    const candidate = nodes.get(id);
    const currentId = strongest;
    const current = currentId === null ? null : nodes.get(currentId);
    if (!candidate) continue;
    if (!current || candidate.links > current.links || (candidate.links === current.links && currentId !== null && id < currentId)) strongest = id;
  }
  return strongest;
}

function planBatchRelations(
  batch: number[],
  scheduled: Set<number>,
  adjacency: Map<number, Set<number>>,
  nodes: Map<number, GraphPlaybackNodeInput>,
) {
  const batchSet = new Set(batch);
  const parentById = new Map<number, number | null>();
  const layerById = new Map<number, number>();
  const relationOrder: number[] = [];
  const remaining = new Set(batch);
  const queue: number[] = [];
  let queueCursor = 0;

  const priorRoots = batch
    .map((id) => {
      const parent = chooseStrongestNode(
        [...(adjacency.get(id) || [])].filter((neighbor) => scheduled.has(neighbor)),
        nodes,
      );
      return { id, parent };
    })
    .filter((entry): entry is { id: number; parent: number } => entry.parent !== null)
    .sort((a, b) => (nodes.get(b.id)?.links || 0) - (nodes.get(a.id)?.links || 0) || a.id - b.id);

  for (const { id, parent } of priorRoots) {
    if (!remaining.delete(id)) continue;
    parentById.set(id, parent);
    layerById.set(id, 0);
    relationOrder.push(id);
    queue.push(id);
  }

  const spreadQueue = () => {
    while (queueCursor < queue.length) {
      const id = queue[queueCursor];
      queueCursor += 1;
      const nextLayer = (layerById.get(id) || 0) + 1;
      const neighbors = [...(adjacency.get(id) || [])]
        .filter((neighbor) => remaining.has(neighbor) && batchSet.has(neighbor))
        .sort((a, b) => (nodes.get(b)?.links || 0) - (nodes.get(a)?.links || 0) || a - b);
      for (const neighbor of neighbors) {
        remaining.delete(neighbor);
        parentById.set(neighbor, id);
        layerById.set(neighbor, nextLayer);
        relationOrder.push(neighbor);
        queue.push(neighbor);
      }
    }
  };

  spreadQueue();
  while (remaining.size) {
    const root = chooseStrongestNode(remaining, nodes);
    if (root === null) break;
    remaining.delete(root);
    parentById.set(root, null);
    layerById.set(root, 0);
    relationOrder.push(root);
    queue.push(root);
    spreadQueue();
  }

  return { parentById, layerById, relationOrder };
}

function graphPlaybackNodeInterval(nodeCount: number) {
  return Math.max(120, Math.min(640, 14_000 / Math.max(1, nodeCount)));
}

function graphPlaybackBatchGap(batchCount: number) {
  return Math.max(32, Math.min(360, 2_400 / Math.max(1, batchCount)));
}

export function buildGraphPlaybackPlan(input: {
  nodes: GraphPlaybackNodeInput[];
  edges: GraphPlaybackEdgeInput[];
  startedAt: number;
}): GraphPlaybackPlan | null {
  if (!input.nodes.length) return null;
  const nodes = new Map(input.nodes.map((node) => [node.id, node]));
  const adjacency = new Map<number, Set<number>>();
  for (const edge of input.edges) {
    if (!nodes.has(edge.a) || !nodes.has(edge.b) || edge.a === edge.b) continue;
    let from = adjacency.get(edge.a);
    if (!from) adjacency.set(edge.a, from = new Set());
    from.add(edge.b);
    let to = adjacency.get(edge.b);
    if (!to) adjacency.set(edge.b, to = new Set());
    to.add(edge.a);
  }

  const dated = new Map<number, number[]>();
  const undated: number[] = [];
  for (const node of input.nodes) {
    if (typeof node.timelineAt === "number" && Number.isFinite(node.timelineAt)) {
      const day = Math.floor(node.timelineAt / DAY_MS);
      const batch = dated.get(day) || [];
      batch.push(node.id);
      dated.set(day, batch);
    } else {
      undated.push(node.id);
    }
  }

  const batches = [...dated.entries()]
    .sort(([a], [b]) => a - b)
    .map(([day, ids]) => ({ day, ids }));
  if (undated.length) batches.push({ day: Number.POSITIVE_INFINITY, ids: undated });
  const scheduled = new Set<number>();
  const nodePlans = new Map<number, GraphPlaybackNodePlan>();
  const rootIds: number[] = [];
  const nodeInterval = graphPlaybackNodeInterval(input.nodes.length);
  const batchGap = graphPlaybackBatchGap(batches.length);
  let scheduleCursor = PLAYBACK_LEAD_IN_MS;

  for (const batch of batches) {
    const ids = [...batch.ids].sort((a, b) => {
      const left = nodes.get(a)!;
      const right = nodes.get(b)!;
      return (left.timelineAt || 0) - (right.timelineAt || 0) || right.links - left.links || a - b;
    });
    const { parentById, layerById, relationOrder } = planBatchRelations(ids, scheduled, adjacency, nodes);
    for (const id of relationOrder) {
      const node = nodes.get(id)!;
      const parentId = parentById.get(id) ?? null;
      const parent = parentId === null ? null : nodes.get(parentId) || null;
      const startAt = scheduleCursor;
      scheduleCursor += nodeInterval;
      const parentPlan = parentId === null ? null : nodePlans.get(parentId) || null;
      const parentVisual = parentPlan ? graphPlaybackNodeVisual(parentPlan, startAt) : null;
      const direction = deterministicUnit(id);
      const spawnDistance = parent ? Math.min(4.2, 1.8 + node.links * 0.12) : Math.min(18, 10 + node.links * 0.42);
      const spawnAnchorX = parentVisual?.x ?? parent?.x ?? node.x;
      const spawnAnchorY = parentVisual?.y ?? parent?.y ?? node.y;
      const spawnX = spawnAnchorX + direction.x * spawnDistance;
      const spawnY = spawnAnchorY + direction.y * spawnDistance;
      const dx = node.x - spawnX;
      const dy = node.y - spawnY;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const curveSign = id % 2 ? 1 : -1;
      nodePlans.set(id, {
        id,
        startAt,
        duration: NODE_SETTLE_MS,
        parentId,
        layer: layerById.get(id) || 0,
        spawnX,
        spawnY,
        targetX: node.x,
        targetY: node.y,
        curve: Math.min(48, Math.max(8, distance * 0.16)) * curveSign,
      });
      if (parentId === null) rootIds.push(id);
      scheduled.add(id);
    }
    scheduleCursor += batchGap;
  }

  const totalDuration = Math.max(
    2_200,
    scheduleCursor - batchGap + NODE_SETTLE_MS + PLAYBACK_TAIL_MS,
  );

  const treeEdges = new Set<string>();
  for (const plan of nodePlans.values()) {
    if (plan.parentId !== null) treeEdges.add(graphPlaybackEdgeKey(plan.id, plan.parentId));
  }
  const edgePlans = new Map<string, GraphPlaybackEdgePlan>();
  for (const edge of input.edges) {
    const key = graphPlaybackEdgeKey(edge.a, edge.b);
    if (edgePlans.has(key)) continue;
    const aPlan = nodePlans.get(edge.a);
    const bPlan = nodePlans.get(edge.b);
    if (!aPlan || !bPlan) continue;
    const aFirst = aPlan.startAt < bPlan.startAt || (aPlan.startAt === bPlan.startAt && edge.a <= edge.b);
    const fromId = aFirst ? edge.a : edge.b;
    const toId = aFirst ? edge.b : edge.a;
    const laterPlan = aFirst ? bPlan : aPlan;
    const treeEdge = treeEdges.has(key);
    edgePlans.set(key, {
      startAt: laterPlan.startAt + (treeEdge ? 0 : laterPlan.duration * 0.56),
      duration: treeEdge ? Math.min(300, laterPlan.duration * 0.3) : 420,
      fromId,
      toId,
      treeEdge,
    });
  }

  return {
    startedAt: input.startedAt,
    totalDuration,
    rootIds,
    nodes: nodePlans,
    edges: edgePlans,
  };
}

export function graphPlaybackNodeVisual(
  plan: GraphPlaybackNodePlan,
  elapsed: number,
  liveTarget?: { x: number; y: number },
): GraphPlaybackNodeVisual | null {
  if (elapsed < plan.startAt) return null;
  const targetX = liveTarget?.x ?? plan.targetX;
  const targetY = liveTarget?.y ?? plan.targetY;
  const progress = clamp01((elapsed - plan.startAt) / plan.duration);
  if (progress >= 1) {
    return { x: targetX, y: targetY, scale: 1, alpha: 1, progress: 1 };
  }
  const spring = dampedSpring(progress, 0.46, 7.8);
  const directProgress = Math.max(-0.1, Math.min(1.12, spring));
  const dx = targetX - plan.spawnX;
  const dy = targetY - plan.spawnY;
  const length = Math.max(1, Math.hypot(dx, dy));
  const curveEnvelope = Math.sin(Math.PI * progress) * Math.exp(-1.08 * progress);
  const settleWobble = Math.sin(progress * Math.PI * 3.2)
    * Math.exp(-3.1 * progress)
    * Math.min(9, Math.max(2, length * 0.06));
  const curveOffset = plan.curve * curveEnvelope + Math.sign(plan.curve || 1) * settleWobble;
  const curveX = (-dy / length) * curveOffset;
  const curveY = (dx / length) * curveOffset;
  const scaleSpring = dampedSpring(progress, 0.38, 10.4);
  return {
    x: plan.spawnX + dx * directProgress + curveX,
    y: plan.spawnY + dy * directProgress + curveY,
    scale: Math.max(0.06, Math.min(1.18, 0.08 + 0.92 * scaleSpring)),
    alpha: smoothstep(progress / 0.28),
    progress,
  };
}

export function graphPlaybackEdgeProgress(plan: GraphPlaybackEdgePlan, elapsed: number) {
  return smoothstep((elapsed - plan.startAt) / plan.duration);
}
