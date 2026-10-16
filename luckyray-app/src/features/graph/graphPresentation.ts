/** Labels follow node geometry. Panning must not elect a new visible subset. */
export type GraphLabelCandidate = {
  id: number; text: string; x: number; y: number; radius: number;
  priority: number; degree: number; alpha: number;
  fontSize?: number;
};
export type GraphLabel = GraphLabelCandidate & { width: number; left: number; top: number; height: number };
export type GraphLabelMemory = Map<number, 'above' | 'below'>;
export type GraphLabelState = { label: GraphLabel; side: 'above' | 'below'; opacity: number };
type Rect = { left: number; top: number; width: number; height: number };
const intersectsViewport = (r: Rect, width: number, height: number) =>
  r.left < width && r.left + r.width > 0 && r.top < height && r.top + r.height > 0;

/** Zoom is multiplicative: reveal progresses evenly across wheel travel.
 * Font metrics depend only on scale, never on pan, collisions or frame time. */
export function graphLabelDetail(scale: number, reveal: number) {
  // Keep overview dots/edges clear. Names start faintly after the overview,
  // then take a further threefold zoom to reach full reading contrast.
  const start = 0.85 + Math.max(0, Math.min(1.6, reveal)) * 0.6;
  const t = Math.max(0, Math.min(1, Math.log(Math.max(scale, 0.001) / start) / Math.log(3)));
  return {alpha: t * t * (3 - 2 * t) * 0.88,
    fontSize: Math.max(8, Math.min(18, 12 * Math.pow(Math.max(scale, 0.001), 0.25)))};
}

export function graphLabelFocusAlpha(alpha: number, focused: boolean, neighbor: boolean, hasFocus: boolean) {
  // Overview hover identifies the target. Neighbours retain zoom visibility
  // instead of flooding the overview with bright, overlapping titles.
  return focused ? 0.95 : neighbor ? alpha : hasFocus ? alpha * 0.36 : alpha;
}

export function placeGraphLabels(candidates: GraphLabelCandidate[], width: number, height: number,
  measure: (text: string) => number, previous: GraphLabelMemory = new Map()): GraphLabel[] {
  const result: GraphLabel[] = [];
  for (const c of candidates) {
    // Alpha belongs to zoom/focus, never to camera translation or collisions.
    // Do not cut a continuously fading name off at a positive alpha threshold.
    if (c.alpha <= 0) continue;
    const fontSize = c.fontSize ?? 12;
    const labelHeight = fontSize * 1.5;
    const top = previous.get(c.id) === 'above' ? c.y - c.radius - labelHeight - 4 : c.y + c.radius + 5;
    if (top >= height || top + labelHeight <= 0) continue;
    const text = c.text.trim();
    // Measure once at 12px, scale metrics for this zoom. Keep the full string:
    // neither zoom nor hover should replace an ellipsis with a different title.
    const labelWidth = measure(text) * fontSize / 12 + 8;
    const rect = {left:c.x-labelWidth/2, top, width:labelWidth, height:labelHeight};
    if (intersectsViewport(rect,width,height)) result.push({...c,...rect,text});
  }
  // Stable paint order only; no density budget, collision admission, or side
  // switching that changes which names exist when the viewport moves.
  return result.sort((a,b)=>a.priority-b.priority || a.degree-b.degree || a.id-b.id);
}

export function updateGraphLabels(candidates: GraphLabelCandidate[], width: number, height: number,
  measure: (text: string) => number, memory: Map<number, GraphLabelState>, _now: number, _reducedMotion = false) {
  const previous: GraphLabelMemory = new Map([...memory].map(([id,state])=>[id,state.side]));
  const selected = placeGraphLabels(candidates, width, height, measure, previous);
  const selectedIds = new Set(selected.map(c => c.id));
  const byId = new Map(candidates.map(c => [c.id,c]));
  for (const [id,state] of memory) if (!selectedIds.has(id)) {
    const c = byId.get(id);
    if (!c || c.alpha <= 0) { memory.delete(id); continue; }
    memory.set(id,{...state,opacity:0,label:{...state.label,...c,text:state.label.text,
      left:c.x-state.label.width/2,top:state.side==='above'?c.y-c.radius-(c.fontSize ?? 12)*1.5-4:c.y+c.radius+5}});
  }
  for (const label of selected) memory.set(label.id,{label,side:previous.get(label.id) ?? 'below',opacity:1});
  // At most one anchor per current eligible node, pruned with the topology.
  // No timers and no growing history of deleted identities.
  return {labels:selected.map(label=>({...label,opacity:1})),animating:false};
}

export type GraphColorGroup = { query: string; color: string };
export function normalizeGraphSections(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, open]) =>
    ['filter', 'appearance', 'groups', 'force'].includes(key) && typeof open === 'boolean'));
}
export function normalizeGraphColorGroups(value: unknown): GraphColorGroup[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).filter(g => g && typeof g.query === 'string' && /^#[0-9a-f]{6}$/i.test(g.color))
    .map(g => ({query: g.query.slice(0, 200), color: g.color}));
}
export function graphGroupMatches(query: string, label: string, path: string, tags: string[]) {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return false;
  if (q.startsWith('tag:')) { const tag = q.slice(4).trim().replace(/^#/, ''); return !!tag && tags.some(t => t.toLocaleLowerCase().replace(/^#/, '') === tag); }
  if (q.startsWith('path:')) { const part = q.slice(5).trim(); return !!part && path.toLocaleLowerCase().includes(part); }
  return label.toLocaleLowerCase().includes(q);
}
