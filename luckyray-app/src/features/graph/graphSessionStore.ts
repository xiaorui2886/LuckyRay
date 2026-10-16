import type { GraphViewState } from '../../core/services/graph';
import { validateGraphPlaybackSnapshot, type GraphPlaybackSnapshot } from './graphPlaybackSession';

export type GraphSessionSnapshot = {
  camera: { scale: number; panX: number; panY: number };
  view: GraphViewState;
  positions: { key: string; x: number; y: number; vx: number; vy: number }[];
  focusedKey?: string | null;
  relationSourceKey?: string | null;
  searchScope?: { kind: 'folder' | 'document'; label: string; nodeKeys: string[] } | null;
  searchQuery?: string;
  sideOpen?: boolean;
  playback?: GraphPlaybackSnapshot;
};
export type GraphSessionTab = { id: string; title: string; number: number };
export type GraphSessionGroup = { id: string; tabIds: string[]; activeTabId: string };
export type GraphSessionLayout = { kind: 'group'; id: string } | {
  kind: 'split'; id: string; orientation: 'row' | 'column'; ratio: number;
  first: GraphSessionLayout; second: GraphSessionLayout;
};
export type GraphSessionState = {
  views: Record<string, GraphSessionTab>;
  groups: GraphSessionGroup[];
  layout: GraphSessionLayout;
  activeGroupId: string;
  activeTabId: string;
  /** The focused group's titlebar tabs. Every view remains in `views`. */
  tabs: GraphSessionTab[];
};
type ViewHandle = { capture: () => GraphSessionSnapshot; restore?: (snapshot: GraphSessionSnapshot) => void };
export type SavedGraphLayout = {
  version: 1; layout: GraphSessionLayout; groups: GraphSessionGroup[]; activeGroupId: string;
  views: GraphSessionTab[]; states: Record<string, GraphSessionSnapshot>;
};

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function replaceGroup(layout: GraphSessionLayout, id: string, replacement: GraphSessionLayout): GraphSessionLayout {
  if (layout.kind === 'group') return layout.id === id ? replacement : layout;
  return { ...layout, first: replaceGroup(layout.first, id, replacement), second: replaceGroup(layout.second, id, replacement) };
}
function removeGroup(layout: GraphSessionLayout, id: string): GraphSessionLayout | null {
  if (layout.kind === 'group') return layout.id === id ? null : layout;
  const first = removeGroup(layout.first, id), second = removeGroup(layout.second, id);
  return !first ? second : !second ? first : { ...layout, first, second };
}
function changeRatio(layout: GraphSessionLayout, id: string, ratio: number): GraphSessionLayout {
  if (layout.kind === 'group') return layout;
  return layout.id === id ? { ...layout, ratio } : { ...layout, first: changeRatio(layout.first, id, ratio), second: changeRatio(layout.second, id, ratio) };
}

/** Independent, retained graph views. The store owns membership, never canvas objects. */
export function createGraphSessionStore() {
  let sequence = 1;
  let state: GraphSessionState = {
    views: { 'graph-1': { id: 'graph-1', title: '', number: 1 } },
    groups: [{ id: 'graph-group-1', tabIds: ['graph-1'], activeTabId: 'graph-1' }],
    layout: { kind: 'group', id: 'graph-group-1' }, activeGroupId: 'graph-group-1', activeTabId: 'graph-1', tabs: [],
  };
  state.tabs = [state.views['graph-1']];
  const listeners = new Set<() => void>();
  const handles = new Map<string, ViewHandle>();
  const retained = new Map<string, GraphSessionSnapshot>();
  const owner = (tabId: string) => state.groups.find(group => group.tabIds.includes(tabId));
  const emit = (next: GraphSessionState) => {
    const group = next.groups.find(item => item.id === next.activeGroupId) || next.groups[0];
    state = { ...next, activeGroupId: group.id, activeTabId: group.activeTabId, tabs: group.tabIds.map(id => next.views[id]) };
    for (const listener of listeners) listener();
  };
  const captureView = (id: string) => {
    const snapshot = handles.get(id)?.capture() || retained.get(id);
    return snapshot ? clone(snapshot) : undefined;
  };
  const select = (tabId: string) => {
    const group = owner(tabId);
    if (!group || (group.id === state.activeGroupId && group.activeTabId === tabId)) return;
    emit({ ...state, activeGroupId: group.id, groups: state.groups.map(item => item.id === group.id ? { ...item, activeTabId: tabId } : item) });
  };
  const add = (options?: { title?: string; duplicate?: boolean; groupId?: string; sourceTabId?: string; snapshot?: GraphSessionSnapshot }) => {
    const group = state.groups.find(item => item.id === options?.groupId) || owner(options?.sourceTabId || state.activeTabId) || state.groups[0];
    const source = options?.snapshot || (options?.duplicate ? captureView(options.sourceTabId || group.activeTabId) : undefined);
    const number = ++sequence, id = `graph-${number}`;
    if (source) retained.set(id, clone(source));
    emit({ ...state, views: { ...state.views, [id]: { id, number, title: options?.title || '' } }, activeGroupId: group.id,
      groups: state.groups.map(item => item.id === group.id ? { ...item, tabIds: [...item.tabIds, id], activeTabId: id } : item) });
    return id;
  };
  const close = (tabId: string) => {
    const group = owner(tabId);
    if (!group || Object.keys(state.views).length <= 1) return false;
    const index = group.tabIds.indexOf(tabId), tabIds = group.tabIds.filter(id => id !== tabId);
    const views = { ...state.views }; delete views[tabId];
    const layout = tabIds.length ? state.layout : removeGroup(state.layout, group.id)!;
    const groups = state.groups.flatMap(item => item.id !== group.id ? [item] : tabIds.length ? [{ ...item, tabIds, activeTabId: item.activeTabId === tabId ? tabIds[Math.min(index, tabIds.length - 1)] : item.activeTabId }] : []);
    handles.delete(tabId); retained.delete(tabId);
    emit({ ...state, views, layout, groups });
    return true;
  };
  const move = (tabId: string, targetGroupId: string, index?: number) => {
    const source = owner(tabId), target = state.groups.find(group => group.id === targetGroupId);
    if (!source || !target) return false;
    const ids = target.tabIds.filter(id => id !== tabId);
    ids.splice(Math.max(0, Math.min(index ?? ids.length, ids.length)), 0, tabId);
    let groups = state.groups.map(group => group.id === target.id ? { ...group, tabIds: ids, activeTabId: tabId }
      : group.id === source.id ? { ...group, tabIds: group.tabIds.filter(id => id !== tabId), activeTabId: group.activeTabId === tabId ? group.tabIds.find(id => id !== tabId)! : group.activeTabId } : group);
    const empty = groups.find(group => !group.tabIds.length);
    const layout = empty ? removeGroup(state.layout, empty.id)! : state.layout;
    groups = groups.filter(group => group.tabIds.length > 0);
    emit({ ...state, groups, layout, activeGroupId: target.id });
    return true;
  };
  const split = (tabId: string, orientation: 'row' | 'column', options?: { move?: boolean; before?: boolean; targetGroupId?: string; snapshot?: GraphSessionSnapshot }) => {
    const source = owner(tabId), target = state.groups.find(group => group.id === options?.targetGroupId) || source;
    if (!source || !target || (options?.move && source.id === target.id && source.tabIds.length < 2)) return false;
    let nextTabId = tabId;
    let views = state.views;
    if (!options?.move) {
      const number = ++sequence;
      nextTabId = `graph-${number}`;
      views = { ...views, [nextTabId]: { id: nextTabId, number, title: state.views[tabId].title } };
      const snapshot = options?.snapshot || captureView(tabId);
      if (snapshot) retained.set(nextTabId, clone(snapshot));
    }
    const newGroupId = `graph-group-${++sequence}`;
    const leaf: GraphSessionLayout = { kind: 'group', id: newGroupId };
    const oldLeaf: GraphSessionLayout = { kind: 'group', id: target.id };
    let layout = replaceGroup(state.layout, target.id, { kind: 'split', id: `graph-split-${sequence}`, orientation, ratio: .5,
      first: options?.before ? leaf : oldLeaf, second: options?.before ? oldLeaf : leaf });
    let groups = options?.move ? state.groups.map(group => group.id === source.id ? { ...group, tabIds: group.tabIds.filter(id => id !== tabId), activeTabId: group.activeTabId === tabId ? group.tabIds.find(id => id !== tabId)! : group.activeTabId } : group) : state.groups;
    const empty = groups.find(group => !group.tabIds.length);
    if (empty) layout = removeGroup(layout, empty.id)!;
    groups = [...groups.filter(group => group.tabIds.length), { id: newGroupId, tabIds: [nextTabId], activeTabId: nextTabId }];
    emit({ ...state, views, groups, layout, activeGroupId: newGroupId });
    return true;
  };
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => state,
    select, add, close, move, split,
    /** Native import preserves the existing stable graph ID; no global source is selected. */
    openNative(id: string, title: string) {
      if (!sessionId(id, 'graph-') || state.views[id] || title.length > 200) throw Error('workspace-graph-native-id-conflict');
      const number = Number(id.slice('graph-'.length)); sequence = Math.max(sequence, number);
      const group = state.groups.find(item => item.id === state.activeGroupId) || state.groups[0];
      emit({ ...state, views: { ...state.views, [id]: { id, title, number } }, activeGroupId: group.id,
        groups: state.groups.map(item => item.id === group.id ? { ...item, tabIds: [...item.tabIds, id], activeTabId: id } : item) });
      return id;
    },
    releaseNative(id: string) {
      if (!state.views[id]) throw Error('workspace-graph-native-view-missing');
      if (Object.keys(state.views).length === 1) add();
      return close(id);
    },
    reorder(tabId: string, beforeTabId: string | null) {
      const group = owner(tabId); if (!group) return false;
      if (beforeTabId === tabId) return true;
      const index = beforeTabId ? group.tabIds.filter(id => id !== tabId).indexOf(beforeTabId) : group.tabIds.length;
      if (index < 0) return false;
      return move(tabId, group.id, index);
    },
    activateGroup(id: string) { const group = state.groups.find(item => item.id === id); if (group) select(group.activeTabId); },
    setRatio(id: string, ratio: number) { if (Number.isFinite(ratio)) emit({ ...state, layout: changeRatio(state.layout, id, Math.max(.12, Math.min(.88, ratio))) }); },
    registerView(id: string, handle: ViewHandle) {
      handles.set(id, handle);
      return () => { if (handles.get(id) !== handle) return; if (state.views[id]) retained.set(id, clone(handle.capture())); handles.delete(id); };
    },
    getInitialSnapshot(id: string) { const snapshot = retained.get(id); return snapshot ? clone(snapshot) : undefined; },
    captureView,
    capture(): SavedGraphLayout {
      const states: Record<string, GraphSessionSnapshot> = {};
      for (const id of Object.keys(state.views)) {
        const snapshot = captureView(id);
        if (snapshot) states[id] = { camera: snapshot.camera, view: snapshot.view, positions: [], sideOpen: snapshot.sideOpen };
      }
      return clone({ version: 1, layout: state.layout, groups: state.groups, activeGroupId: state.activeGroupId, views: Object.values(state.views), states });
    },
    validate: validateGraphLayout,
    checkpoint() {
      const previousState = clone(state);
      const previousSequence = sequence;
      const snapshots = new Map<string, GraphSessionSnapshot>();
      for (const id of Object.keys(previousState.views)) {
        const snapshot = captureView(id);
        if (snapshot) snapshots.set(id, snapshot);
      }
      return async () => {
        // Rollback is exact, unlike a user preset which preserves extra tabs.
        for (const id of [...handles.keys()]) if (!previousState.views[id]) handles.delete(id);
        retained.clear();
        for (const [id, snapshot] of snapshots) {
          retained.set(id, clone(snapshot));
          handles.get(id)?.restore?.(clone(snapshot));
        }
        sequence = previousSequence;
        emit(previousState);
      };
    },
    async restore(value: unknown) {
      if (!validateGraphLayout(value)) return false;
      const saved = clone(value as SavedGraphLayout);
      const views = { ...state.views, ...Object.fromEntries(saved.views.map(view => [view.id, view])) };
      const mentioned = new Set(saved.groups.flatMap(group => group.tabIds));
      const extraIds = state.groups.flatMap(group => group.tabIds).filter(id => !mentioned.has(id));
      const groups = saved.groups.map((group, index) => index === 0 ? { ...group, tabIds: [...group.tabIds, ...extraIds] } : group);
      for (const view of saved.views) sequence = Math.max(sequence, view.number, ...[view.id, ...groups.map(group => group.id)].map(id => Number(id.split('-').slice(-1)[0]) || 0));
      const reserveLayoutIds = (layout: GraphSessionLayout) => {
        sequence = Math.max(sequence, Number(layout.id.split('-').slice(-1)[0]) || 0);
        if (layout.kind === 'split') { reserveLayoutIds(layout.first); reserveLayoutIds(layout.second); }
      };
      reserveLayoutIds(saved.layout);
      for (const [id, snapshot] of Object.entries(saved.states)) {
        retained.set(id, clone(snapshot)); handles.get(id)?.restore?.(clone(snapshot));
      }
      emit({ ...state, views, groups, layout: saved.layout, activeGroupId: saved.activeGroupId });
      return true;
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}
function keysOnly(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).every(key => allowed.includes(key));
}
function boundedString(value: unknown, max = 8192): value is string { return typeof value === 'string' && value.length <= max; }
function finite(value: unknown, min: number, max: number): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max; }
function sessionId(value: unknown, prefix: string): value is string {
  return typeof value === 'string' && value.startsWith(prefix) && /^[1-9]\d{0,8}$/.test(value.slice(prefix.length));
}

/** Validate the entire untrusted saved value before any live canvas is changed. */
export function validateGraphSessionSnapshot(value: unknown): value is GraphSessionSnapshot {
  if (!record(value) || !keysOnly(value, ['camera', 'view', 'positions', 'focusedKey', 'relationSourceKey', 'searchScope', 'searchQuery', 'sideOpen', 'playback'])) return false;
  const { camera, view, positions } = value;
  if (!record(camera) || !keysOnly(camera, ['scale', 'panX', 'panY'])
    || !finite(camera.scale, .025, 12) || !finite(camera.panX, -1e7, 1e7) || !finite(camera.panY, -1e7, 1e7)) return false;
  if (!record(view) || view.spatialVersion !== 3) return false;
  const numeric: Record<string, [number, number]> = {
    spatialVersion: [3, 3], labelReveal: [0, 1.6], textOpacity: [0, 1], nodeSize: [3, 12], edgeWidth: [.5, 4], forceStrength: [0, 3],
    centerForce: [0, 100], repulsionForce: [0, 100], linkAttraction: [0, 100], linkLength: [64, 360], nodeSpacing: [0, 100],
    scale: [.025, 12], panX: [-1e7, 1e7], panY: [-1e7, 1e7],
  };
  const booleans = ['showIsolated', 'nearbyFilter', 'showArrows', 'showLabels'];
  if (!keysOnly(view, [...Object.keys(numeric), ...booleans, 'nearbyDepth', 'colorMode', 'filters', 'sections', 'colorGroups'])) return false;
  for (const [key, range] of Object.entries(numeric)) if (key in view && !finite(view[key], ...range)) return false;
  for (const key of booleans) if (key in view && typeof view[key] !== 'boolean') return false;
  if ('nearbyDepth' in view && view.nearbyDepth !== 1 && view.nearbyDepth !== 2) return false;
  if ('colorMode' in view && !['default', 'type', 'degree'].includes(view.colorMode as string)) return false;
  if ('filters' in view) {
    if (!record(view.filters) || !keysOnly(view.filters, ['note', 'material', 'tag', 'web'])
      || !['note', 'material', 'tag', 'web'].every(key => typeof (view.filters as Record<string, unknown>)[key] === 'boolean')) return false;
  }
  if ('sections' in view && (!record(view.sections) || !keysOnly(view.sections, ['filter', 'appearance', 'groups', 'force']) || !Object.values(view.sections).every(open => typeof open === 'boolean'))) return false;
  if ('colorGroups' in view && (!Array.isArray(view.colorGroups) || view.colorGroups.length > 16 || !view.colorGroups.every(group => record(group)
    && keysOnly(group, ['query', 'color']) && boundedString(group.query, 200) && typeof group.color === 'string' && /^#[0-9a-f]{6}$/i.test(group.color)))) return false;
  if (!Array.isArray(positions) || positions.length > 20000) return false;
  const positionKeys = new Set<string>();
  for (const position of positions) {
    if (!record(position) || !keysOnly(position, ['key', 'x', 'y', 'vx', 'vy']) || !boundedString(position.key) || !position.key || positionKeys.has(position.key)
      || !finite(position.x, -1e8, 1e8) || !finite(position.y, -1e8, 1e8) || !finite(position.vx, -1e6, 1e6) || !finite(position.vy, -1e6, 1e6)) return false;
    positionKeys.add(position.key);
  }
  for (const key of ['focusedKey', 'relationSourceKey']) if (key in value && value[key] !== null && !boundedString(value[key])) return false;
  if ('searchQuery' in value && !boundedString(value.searchQuery, 10000)) return false;
  if ('sideOpen' in value && typeof value.sideOpen !== 'boolean') return false;
  if ('playback' in value && (!validateGraphPlaybackSnapshot(value.playback) || value.playback.nodes.some(node => !positionKeys.has(node.key)))) return false;
  if ('searchScope' in value && value.searchScope !== null) {
    const scope = value.searchScope;
    if (!record(scope) || !keysOnly(scope, ['kind', 'label', 'nodeKeys']) || !['folder', 'document'].includes(scope.kind as string)
      || !boundedString(scope.label) || !Array.isArray(scope.nodeKeys) || scope.nodeKeys.length > 20000 || !scope.nodeKeys.every(key => boundedString(key) && key.length > 0)) return false;
  }
  return true;
}

/** Renderer order and JSON property order are not graph identity. Compare every
 * field, normalizing only collections keyed by the portable scene identity. */
export function sameGraphSessionSnapshot(left: GraphSessionSnapshot, right: GraphSessionSnapshot) {
  const normalize = (snapshot: GraphSessionSnapshot) => {
    const value = clone(snapshot);
    const sort = <T>(items: T[], key: (item: T) => string) => items.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
    sort(value.positions, node => node.key);
    if (value.playback) {
      sort(value.playback.nodes, node => node.key);
      sort(value.playback.edges, edge => JSON.stringify([edge.fromKey, edge.toKey]));
      value.playback.rootKeys.sort(); value.playback.activatedKeys.sort();
    }
    const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical)
      : record(input) ? Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical(input[key])])) : input;
    return JSON.stringify(canonical(value));
  };
  return validateGraphSessionSnapshot(left) && validateGraphSessionSnapshot(right) && normalize(left) === normalize(right);
}

export function validateGraphLayout(value: unknown): value is SavedGraphLayout {
  if (!record(value) || !keysOnly(value, ['version', 'views', 'groups', 'layout', 'activeGroupId', 'states'])) return false;
  const saved = value as unknown as SavedGraphLayout;
  if (saved.version !== 1 || !Array.isArray(saved.views) || !saved.views.length || saved.views.length > 100 || !Array.isArray(saved.groups) || !saved.groups.length || saved.groups.length > 100 || !record(saved.states)) return false;
  const ids = new Set<string>(), groupIds = new Set<string>(), membership = new Set<string>();
  for (const view of saved.views) {
    if (!record(view) || !keysOnly(view, ['id', 'title', 'number']) || !sessionId(view.id, 'graph-') || !boundedString(view.title, 200) || !Number.isSafeInteger(view.number) || !finite(view.number, 1, 999999999) || ids.has(view.id)) return false;
    ids.add(view.id);
  }
  for (const group of saved.groups) {
    if (!record(group) || !keysOnly(group, ['id', 'tabIds', 'activeTabId']) || !sessionId(group.id, 'graph-group-') || groupIds.has(group.id) || !Array.isArray(group.tabIds) || !group.tabIds.length || group.tabIds.length > 100 || !group.tabIds.includes(group.activeTabId)) return false;
    groupIds.add(group.id);
    for (const id of group.tabIds) { if (typeof id !== 'string' || !ids.has(id) || membership.has(id)) return false; membership.add(id); }
  }
  if (membership.size !== ids.size || !groupIds.has(saved.activeGroupId)) return false;
  const leaves = new Set<string>(), splits = new Set<string>();
  const visit = (node: unknown, depth = 0): boolean => {
    if (!record(node) || depth > 24) return false;
    if (node.kind === 'group') { if (!keysOnly(node, ['kind', 'id']) || typeof node.id !== 'string' || !groupIds.has(node.id) || leaves.has(node.id)) return false; leaves.add(node.id); return true; }
    if (node.kind !== 'split' || !keysOnly(node, ['kind', 'id', 'orientation', 'ratio', 'first', 'second']) || !sessionId(node.id, 'graph-split-') || splits.has(node.id) || !['row', 'column'].includes(node.orientation as string) || !finite(node.ratio, .12, .88)) return false;
    splits.add(node.id); return visit(node.first, depth + 1) && visit(node.second, depth + 1);
  };
  if (!visit(saved.layout) || leaves.size !== groupIds.size) return false;
  for (const [id, snapshot] of Object.entries(saved.states)) if (!ids.has(id) || !validateGraphSessionSnapshot(snapshot)) return false;
  return true;
}

export const graphSessionStore = createGraphSessionStore();
