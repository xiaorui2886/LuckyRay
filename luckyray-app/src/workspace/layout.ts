/** Layout is presentation only. Documents, authority and draft text live elsewhere. */
import {decodeTools,type ToolLayout} from './toolLayout';
import {decodePresentation,type WorkspacePresentation} from './presentation';
export type ViewKind = 'note' | 'graph' | 'materials';
export type LibraryRef = { kind: 'knowledge' | 'materials'; id: string };
export type ViewRef = { id: string; kind: ViewKind; title: string; library: LibraryRef; resourceId?: string };
export type Group = { kind: 'group'; id: string; tabs: string[]; active: string | null };
export type Split = { kind: 'split'; id: string; axis: 'row' | 'column'; ratio: number; first: LayoutNode; second: LayoutNode };
export type LayoutNode = Group | Split;
export type WorkspaceLayout = { version: 1; windowId: string; root: LayoutNode; views: Record<string, ViewRef>; focusedGroup: string;tools?:ToolLayout;presentation?:WorkspacePresentation };
export type DropEdge = 'center' | 'left' | 'right' | 'top' | 'bottom';
export type LayoutCommand =
  | { type:'tools';tools:ToolLayout }
  | { type:'presentation';presentation:WorkspacePresentation }
  | { type: 'open'; view: ViewRef; groupId: string; index?: number }
  | { type: 'activate'; viewId: string }
  | { type: 'move'; viewId: string; targetGroup: string; edge: DropEdge; index?: number; groupId?: string; splitId?: string }
  | { type: 'close'; viewId: string }
  | { type: 'resize'; splitId: string; ratio: number };

export function groups(root: LayoutNode): Group[] { return root.kind === 'group' ? [root] : [...groups(root.first), ...groups(root.second)]; }
export function findGroup(layout: WorkspaceLayout, viewId: string) { return groups(layout.root).find(group => group.tabs.includes(viewId)); }
function mapNode(root: LayoutNode, update: (node: LayoutNode) => LayoutNode): LayoutNode {
  return update(root.kind === 'split' ? { ...root, first: mapNode(root.first, update), second: mapNode(root.second, update) } : root);
}
function prune(root: LayoutNode): LayoutNode | null {
  if (root.kind === 'group') return root.tabs.length ? root : null;
  const first = prune(root.first), second = prune(root.second);
  return !first ? second : !second ? first : { ...root, first, second };
}
function without(group: Group, id: string): Group {
  const index = group.tabs.indexOf(id), tabs = group.tabs.filter(tab => tab !== id);
  return { ...group, tabs, active: group.active === id ? tabs[Math.min(index, tabs.length - 1)] ?? null : group.active };
}
function insert(tabs: string[], id: string, index = tabs.length) {
  const next = tabs.filter(tab => tab !== id); next.splice(Math.max(0, Math.min(next.length, index)), 0, id); return next;
}
export function createLayout(windowId: string, groupId = 'workspace-group-1'): WorkspaceLayout {
  return { version: 1, windowId, root: { kind: 'group', id: groupId, tabs: [], active: null }, views: {}, focusedGroup: groupId };
}

/** Pure commands: a canceled drag never calls this; identical view IDs retain their mounted host. */
export function reduceLayout(layout: WorkspaceLayout, command: LayoutCommand): WorkspaceLayout {
  if(command.type==='tools'){const tools=decodeTools(command.tools);return tools?{...layout,tools}:layout;}
  if(command.type==='presentation'){const presentation=decodePresentation(command.presentation);return presentation?{...layout,presentation}:layout;}
  if (command.type === 'resize') {
    if (!Number.isFinite(command.ratio)) return layout;
    return { ...layout, root: mapNode(layout.root, node => node.kind === 'split' && node.id === command.splitId ? { ...node, ratio: Math.max(.08, Math.min(.92, command.ratio)) } : node) };
  }
  if (command.type === 'open') {
    if (layout.views[command.view.id]) return reduceLayout(layout, { type: 'activate', viewId: command.view.id });
    if (!groups(layout.root).some(group => group.id === command.groupId)) return layout;
    return { ...layout, views: { ...layout.views, [command.view.id]: command.view }, focusedGroup: command.groupId,
      root: mapNode(layout.root, node => node.kind === 'group' && node.id === command.groupId ? { ...node, tabs: insert(node.tabs, command.view.id, command.index), active: command.view.id } : node) };
  }
  const source = findGroup(layout, command.viewId);
  if (!source) return layout;
  if (command.type === 'activate') return { ...layout, focusedGroup: source.id,
    root: mapNode(layout.root, node => node.kind === 'group' && node.id === source.id ? { ...node, active: command.viewId } : node) };
  if (command.type === 'close') {
    const views = { ...layout.views }; delete views[command.viewId];
    const root = prune(mapNode(layout.root, node => node.kind === 'group' ? without(node, command.viewId) : node)) ?? { ...source, tabs: [], active: null };
    return { ...layout, views, root, focusedGroup: groups(root).some(group => group.id === layout.focusedGroup) ? layout.focusedGroup : groups(root)[0].id };
  }
  const target = groups(layout.root).find(group => group.id === command.targetGroup);
  if (!target || (source === target && source.tabs.length === 1 && command.edge !== 'center')) return layout;
  const split = command.edge !== 'center';
  // IDs originate in the controller, never from a foreign drag payload.
  if (split && (!command.groupId || !command.splitId || command.groupId === command.splitId)) return layout;
  const ids = new Set<string>(); mapNode(layout.root, node => { ids.add(node.id); return node; });
  if (split && (ids.has(command.groupId!) || ids.has(command.splitId!))) return layout;
  let root = mapNode(layout.root, node => node.kind === 'group' ? without(node, command.viewId) : node);
  root = mapNode(root, node => {
    if (node.kind !== 'group' || node.id !== target.id) return node;
    if (!split) return { ...node, tabs: insert(node.tabs, command.viewId, command.index), active: command.viewId };
    const group: Group = { kind: 'group', id: command.groupId!, tabs: [command.viewId], active: command.viewId };
    const before = command.edge === 'left' || command.edge === 'top';
    return { kind: 'split', id: command.splitId!, axis: command.edge === 'left' || command.edge === 'right' ? 'row' : 'column', ratio: .5,
      first: before ? group : node, second: before ? node : group };
  });
  return { ...layout, root: prune(root)!, focusedGroup: split ? command.groupId! : target.id };
}

/** Strict, bounded restore. Unknown fields (including draft text) are never serialized. */
export function decodeLayout(value: unknown, windowId: string): WorkspaceLayout | null {
  try {
    const data = value as WorkspaceLayout;
    if (!data || data.version !== 1 || data.windowId !== windowId || !data.views || typeof data.views !== 'object') return null;
    const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 512 && !['__proto__', 'constructor', 'prototype'].includes(id);
    const refs = Object.entries(data.views); if (refs.length > 100) return null;
    const views: Record<string, ViewRef> = Object.create(null);
    for (const [id, view] of refs) {
      if (!validId(id) || !view || view.id !== id || !['note', 'graph', 'materials'].includes(view.kind)
        || typeof view.title !== 'string' || view.title.length > 1000 || !view.library || !validId(view.library.id)
        || view.library.kind !== (view.kind === 'materials' ? 'materials' : 'knowledge')
        || (view.resourceId !== undefined && !validId(view.resourceId))) return null;
      views[id] = { id, kind: view.kind, title: view.title, library: { kind: view.library.kind, id: view.library.id }, ...(view.resourceId === undefined ? {} : { resourceId: view.resourceId }) };
    }
    const nodeIds = new Set<string>(), tabs = new Set<string>(); let count = 0;
    const read = (node: LayoutNode, depth: number): LayoutNode => {
      if (!node || depth > 16 || ++count > 199 || !validId(node.id) || nodeIds.has(node.id)) throw new Error('invalid-node');
      nodeIds.add(node.id);
      if (node.kind === 'group') {
        if (!Array.isArray(node.tabs) || node.tabs.length > 100) throw new Error('invalid-tabs');
        for (const tab of node.tabs) { if (!validId(tab) || !views[tab] || tabs.has(tab)) throw new Error('invalid-tab'); tabs.add(tab); }
        if (node.active !== null && !node.tabs.includes(node.active) || node.tabs.length > 0 && node.active === null) throw new Error('invalid-active');
        return { kind: 'group', id: node.id, tabs: [...node.tabs], active: node.active };
      }
      if (node.kind !== 'split' || !['row', 'column'].includes(node.axis) || !Number.isFinite(node.ratio) || node.ratio < .08 || node.ratio > .92) throw new Error('invalid-split');
      return { kind: 'split', id: node.id, axis: node.axis, ratio: node.ratio, first: read(node.first, depth + 1), second: read(node.second, depth + 1) };
    };
    const root = read(data.root, 0);
    if (tabs.size !== refs.length || !groups(root).some(group => group.id === data.focusedGroup)) return null;
    const tools=decodeTools(data.tools);if(!tools)return null;
    const presentation=decodePresentation(data.presentation);if(!presentation)return null;
    return { version: 1, windowId, views, root, focusedGroup: data.focusedGroup,...(data.tools===undefined?{}:{tools}),...(data.presentation===undefined?{}:{presentation}) };
  } catch { return null; }
}
export function encodeLayout(layout: WorkspaceLayout): string {
  const safe = decodeLayout(layout, layout.windowId); if (!safe) throw new Error('invalid-workspace-layout'); return JSON.stringify(safe);
}

export type Rect = { left: number; top: number; width: number; height: number };
export type LayoutGeometry = { groups: Map<string, Rect>; dividers: Array<{ id: string; axis: Split['axis']; rect: Rect; container: Rect; ratio: number }> };
export function measureLayout(root: LayoutNode, width: number, height: number, divider = 6): LayoutGeometry {
  const result: LayoutGeometry = { groups: new Map(), dividers: [] };
  const visit = (node: LayoutNode, rect: Rect) => {
    if (node.kind === 'group') { result.groups.set(node.id, rect); return; }
    const horizontal = node.axis === 'row', size = horizontal ? rect.width : rect.height, gap = Math.min(divider, size);
    const available = Math.max(0, size - gap), minimum = Math.min(horizontal ? 240 : 160, available / 2);
    const first = Math.max(minimum, Math.min(available - minimum, available * node.ratio));
    const a = { ...rect, [horizontal ? 'width' : 'height']: first };
    const handle = horizontal ? { ...rect, left: rect.left + first, width: gap } : { ...rect, top: rect.top + first, height: gap };
    const b = horizontal ? { ...rect, left: rect.left + first + gap, width: available - first } : { ...rect, top: rect.top + first + gap, height: available - first };
    result.dividers.push({ id: node.id, axis: node.axis, rect: handle, container: rect, ratio: node.ratio }); visit(node.first, a); visit(node.second, b);
  };
  visit(root, { left: 0, top: 0, width: Math.max(0, width), height: Math.max(0, height) }); return result;
}

export function dropEdge(rect: Rect, x: number, y: number): DropEdge {
  const dx = x - rect.left, dy = y - rect.top, threshold = Math.min(60, rect.width / 4, rect.height / 4);
  const edges: Array<[DropEdge, number]> = [['left', dx], ['right', rect.width - dx], ['top', dy], ['bottom', rect.height - dy]];
  edges.sort((a,b) => a[1]-b[1]); return edges[0][1] < threshold ? edges[0][0] : 'center';
}
