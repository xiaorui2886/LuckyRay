import type { GraphSeed } from '../../core/services/graph';
import { graphPlaybackEdgeKey, type GraphPlaybackPlan } from '../../core/services/graphPlayback';

type Camera = { scale: number; panX: number; panY: number };
/** Portable presentation only. Scene keys, never a source renderer's numeric IDs,
 * identify nodes. activationId preserves the existing deterministic spawn angle. */
export type GraphPlaybackSnapshot = {
  version: 1;
  elapsedMs: number;
  totalDuration: number;
  rootKeys: string[];
  nodes: { key: string; activationId: number; activationOrder: number; startAt: number; duration: number; parentKey: string | null;
    layer: number; spawnX: number; spawnY: number; targetX: number; targetY: number; curve: number }[];
  edges: { fromKey: string; toKey: string; startAt: number; duration: number; treeEdge: boolean }[];
  activatedKeys: string[];
  cameraFollow: boolean;
  cameraTarget: Camera;
  cameraVelocity: { panX: number; panY: number };
  cameraZoomAnchor: { x: number; y: number } | null;
  alpha: number;
};

const MAX_NODES = 20_000, MAX_EDGES = 100_000, MAX_DURATION = 3_600_000;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const only = (value: Record<string, unknown>, fields: readonly string[]) => Object.keys(value).every(key => fields.includes(key));
const finite = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const key = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !value.includes('\0');
const pair = (a: string, b: string) => JSON.stringify(a < b ? [a, b] : [b, a]);
const ordered = <T>(values: T[], select: (value: T) => string) => values.sort((a, b) => select(a) < select(b) ? -1 : select(a) > select(b) ? 1 : 0);

/** Every nested field is checked before either canvas or clock can be changed. */
export function validateGraphPlaybackSnapshot(value: unknown): value is GraphPlaybackSnapshot {
  if (!record(value) || !only(value, ['version', 'elapsedMs', 'totalDuration', 'rootKeys', 'nodes', 'edges', 'activatedKeys', 'cameraFollow', 'cameraTarget', 'cameraVelocity', 'cameraZoomAnchor', 'alpha'])
    || value.version !== 1 || !finite(value.totalDuration, 1, MAX_DURATION) || !finite(value.elapsedMs, 0, value.totalDuration)
    || typeof value.cameraFollow !== 'boolean' || !finite(value.alpha, 0, 1)) return false;
  const camera = value.cameraTarget;
  if (!record(camera) || !only(camera, ['scale', 'panX', 'panY']) || !finite(camera.scale, .025, 12)
    || !finite(camera.panX, -1e7, 1e7) || !finite(camera.panY, -1e7, 1e7)) return false;
  const velocity = value.cameraVelocity, anchor = value.cameraZoomAnchor;
  if (!record(velocity) || !only(velocity, ['panX', 'panY']) || !finite(velocity.panX, -1e6, 1e6) || !finite(velocity.panY, -1e6, 1e6)
    || (anchor !== null && (!record(anchor) || !only(anchor, ['x', 'y']) || !finite(anchor.x, -1e7, 1e7) || !finite(anchor.y, -1e7, 1e7)))) return false;
  if (!Array.isArray(value.nodes) || !value.nodes.length || value.nodes.length > MAX_NODES
    || !Array.isArray(value.edges) || value.edges.length > MAX_EDGES) return false;
  const nodes = new Map<string, GraphPlaybackSnapshot['nodes'][number]>(), activationIds = new Set<number>(), activationOrder = new Set<number>();
  for (const node of value.nodes) {
    if (!record(node) || !only(node, ['key', 'activationId', 'activationOrder', 'startAt', 'duration', 'parentKey', 'layer', 'spawnX', 'spawnY', 'targetX', 'targetY', 'curve'])
      || !key(node.key) || nodes.has(node.key) || !Number.isSafeInteger(node.activationId) || !finite(node.activationId, 0, 2 ** 31 - 1) || activationIds.has(node.activationId)
      || !Number.isInteger(node.activationOrder) || !finite(node.activationOrder, 0, MAX_NODES - 1) || activationOrder.has(node.activationOrder)
      || !finite(node.startAt, 0, value.totalDuration) || !finite(node.duration, 1, value.totalDuration) || node.startAt + node.duration > value.totalDuration
      || (node.parentKey !== null && !key(node.parentKey)) || !Number.isInteger(node.layer) || !finite(node.layer, 0, MAX_NODES)
      || !['spawnX', 'spawnY', 'targetX', 'targetY'].every(field => finite(node[field], -1e8, 1e8)) || !finite(node.curve, -1e8, 1e8)) return false;
    nodes.set(node.key, node as GraphPlaybackSnapshot['nodes'][number]); activationIds.add(node.activationId); activationOrder.add(node.activationOrder);
  }
  const keySet = (values: unknown): Set<string> | null => {
    if (!Array.isArray(values) || values.length > nodes.size || !values.every(item => key(item) && nodes.has(item)) || new Set(values).size !== values.length) return null;
    return new Set(values);
  };
  const roots = keySet(value.rootKeys), activated = keySet(value.activatedKeys);
  if (!roots?.size || !activated) return false;
  const parentPairs = new Set<string>();
  for (const node of nodes.values()) {
    if (roots.has(node.key) !== (node.parentKey === null) || (activated.has(node.key) && node.startAt > value.elapsedMs)) return false;
    if (node.parentKey !== null) {
      const parent = nodes.get(node.parentKey);
      // Strict schedule order also excludes all cycles without recursive parsing.
      if (!parent || parent.startAt >= node.startAt) return false;
      parentPairs.add(pair(node.key, node.parentKey));
    }
  }
  const edges = new Set<string>();
  for (const edge of value.edges) {
    if (!record(edge) || !only(edge, ['fromKey', 'toKey', 'startAt', 'duration', 'treeEdge']) || !key(edge.fromKey) || !key(edge.toKey)
      || !nodes.has(edge.fromKey) || !nodes.has(edge.toKey) || typeof edge.treeEdge !== 'boolean'
      || !finite(edge.startAt, 0, value.totalDuration) || !finite(edge.duration, 1, value.totalDuration) || edge.startAt + edge.duration > value.totalDuration) return false;
    const edgeKey = pair(edge.fromKey, edge.toKey);
    if (edges.has(edgeKey) || edge.treeEdge !== parentPairs.has(edgeKey) || nodes.get(edge.fromKey)!.startAt > nodes.get(edge.toKey)!.startAt) return false;
    edges.add(edgeKey);
  }
  return [...parentPairs].every(edge => edges.has(edge));
}

export function assertGraphPlaybackScene(snapshot: GraphPlaybackSnapshot, seed: Pick<GraphSeed, 'nodes' | 'edges'>) {
  if (!validateGraphPlaybackSnapshot(snapshot)) throw Error('workspace-graph-playback-invalid');
  const keys = new Map(seed.nodes.map(node => [node.id, node.key]));
  const sceneKeys = new Set(keys.values()), playbackKeys = new Set(snapshot.nodes.map(node => node.key));
  if (keys.size !== seed.nodes.length || sceneKeys.size !== seed.nodes.length || snapshot.nodes.some(node => !sceneKeys.has(node.key))) throw Error('workspace-graph-playback-node-mismatch');
  const sceneEdges = new Set<string>();
  for (const [a, b] of seed.edges) {
    const left = keys.get(a), right = keys.get(b);
    if (left !== undefined && right !== undefined && playbackKeys.has(left) && playbackKeys.has(right)) sceneEdges.add(pair(left, right));
  }
  if (sceneEdges.size !== snapshot.edges.length || snapshot.edges.some(edge => !sceneEdges.has(pair(edge.fromKey, edge.toKey)))) throw Error('workspace-graph-playback-edge-mismatch');
}

export function captureGraphPlayback(input: {
  timeline: GraphPlaybackPlan; elapsedMs: number; nodes: { id: number; key: string }[]; activatedIds: Set<number>;
  activationIds: Map<number, number>; activationOrder: Map<number, number>; cameraFollow: boolean; cameraTarget: Camera;
  cameraVelocity: { panX: number; panY: number }; cameraZoomAnchor: { x: number; y: number } | null; alpha: number;
}): GraphPlaybackSnapshot {
  const keys = new Map(input.nodes.map(node => [node.id, node.key]));
  const order = new Map(input.nodes.map((node, index) => [node.id, index]));
  const nodeKey = (id: number) => { const value = keys.get(id); if (value === undefined) throw Error('workspace-graph-playback-node-mismatch'); return value; };
  const { timeline } = input;
  const snapshot: GraphPlaybackSnapshot = {
    version: 1, elapsedMs: Math.min(timeline.totalDuration, input.elapsedMs), totalDuration: timeline.totalDuration,
    rootKeys: timeline.rootIds.map(nodeKey).sort(),
    nodes: ordered([...timeline.nodes.values()].map(({ id, parentId, ...node }) => ({ ...node, key: nodeKey(id), parentKey: parentId === null ? null : nodeKey(parentId), activationId: input.activationIds.get(id) ?? id, activationOrder: input.activationOrder.get(id) ?? order.get(id)! })), node => node.key),
    edges: ordered([...timeline.edges.values()].map(({ fromId, toId, ...edge }) => ({ ...edge, fromKey: nodeKey(fromId), toKey: nodeKey(toId) })), edge => pair(edge.fromKey, edge.toKey)),
    activatedKeys: [...input.activatedIds].map(nodeKey).sort(), cameraFollow: input.cameraFollow, cameraTarget: { ...input.cameraTarget }, alpha: input.alpha,
    cameraVelocity: { ...input.cameraVelocity }, cameraZoomAnchor: input.cameraZoomAnchor ? { ...input.cameraZoomAnchor } : null,
  };
  if (!validateGraphPlaybackSnapshot(snapshot)) throw Error('workspace-graph-playback-invalid');
  return snapshot;
}

/** Reconstruction is side-effect free so a rejected remap cannot cancel playback. */
export function restoreGraphPlayback(snapshot: GraphPlaybackSnapshot, seed: Pick<GraphSeed, 'nodes' | 'edges'>, now: number) {
  assertGraphPlaybackScene(snapshot, seed);
  const ids = new Map(seed.nodes.map(node => [node.key, node.id]));
  const timeline: GraphPlaybackPlan = {
    startedAt: now - snapshot.elapsedMs, totalDuration: snapshot.totalDuration, rootIds: snapshot.rootKeys.map(key => ids.get(key)!),
    nodes: new Map(snapshot.nodes.map(({ key, parentKey, activationId: _activationId, activationOrder: _activationOrder, ...node }) => { const id = ids.get(key)!; return [id, { ...node, id, parentId: parentKey === null ? null : ids.get(parentKey)! }]; })),
    edges: new Map(snapshot.edges.map(({ fromKey, toKey, ...edge }) => { const fromId = ids.get(fromKey)!, toId = ids.get(toKey)!; return [graphPlaybackEdgeKey(fromId, toId), { ...edge, fromId, toId }]; })),
  };
  return { timeline, activatedIds: new Set(snapshot.activatedKeys.map(key => ids.get(key)!)), activationIds: new Map(snapshot.nodes.map(node => [ids.get(node.key)!, node.activationId])), activationOrder: new Map(snapshot.nodes.map(node => [ids.get(node.key)!, node.activationOrder])) };
}

export function graphPlaybackActivationNodes<T extends { id: number }>(nodes: T[], order?: Map<number, number>) {
  return order ? [...nodes].sort((a, b) => (order.get(a.id) ?? MAX_NODES) - (order.get(b.id) ?? MAX_NODES)) : nodes;
}

/** Hidden and transfer holds overlap; their union pauses time exactly once.
 * No plan is cancelled or mutated while a source transfer is pending. */
export function createGraphPlaybackClock() {
  const holds = new Set<'hidden' | 'presentation'>();
  let heldAt: number | null = null;
  let anchor: { timeline: GraphPlaybackPlan; startedAt: number; at: number; elapsed: number } | null = null;
  const time = (now: number) => heldAt ?? now;
  return {
    time,
    elapsed(timeline: GraphPlaybackPlan, now: number) {
      return Math.max(0, anchor?.timeline === timeline && anchor.startedAt === timeline.startedAt
        ? anchor.elapsed + (time(now) - anchor.at) : time(now) - timeline.startedAt);
    },
    restored(timeline: GraphPlaybackPlan, elapsed: number, now: number) {
      timeline.startedAt = time(now) - elapsed;
      anchor = { timeline, startedAt: timeline.startedAt, at: time(now), elapsed };
    },
    hold(reason: 'hidden' | 'presentation', paused: boolean, now: number, timeline: GraphPlaybackPlan | null) {
      if (paused) { if (!holds.size) heldAt = now; holds.add(reason); return; }
      if (!holds.delete(reason) || holds.size || heldAt === null) return;
      const duration = Math.max(0, now - heldAt);
      if (timeline) {
        timeline.startedAt += duration;
        if (anchor?.timeline === timeline) { anchor.startedAt = timeline.startedAt; anchor.at += duration; }
      }
      heldAt = null;
    },
  };
}
