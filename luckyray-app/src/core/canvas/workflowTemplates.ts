import { canConnectCanvasNodes, getCanvasNodeContentKind, normalizeCanvasNodeCapabilityData, type CanvasNodeCapabilityData } from './nodeCapabilities';
import { isCanvasEdgeRole, inferCanvasEdgeRole, type CanvasEdgeRole } from './edgeSemantics';
import type { ReferencePackTag } from './creativeReview';

/** Portable, declarative drafts. Never serialize a live node or task by spreading it. */
export const WORKFLOW_FORMAT = 'luckyray-canvas-workflow' as const;
export const WORKFLOW_LIMITS = { bytes: 512_000, nodes: 64, edges: 128, text: 12_000 } as const;
type Point = { x: number; y: number };
export type WorkflowKind = 'text' | 'image' | 'video' | 'generator' | 'group';
export type WorkflowNode = {
  id: string; kind: WorkflowKind; label: string; position: Point;
  parentId?: string; width?: number; height?: number; referencePack?: ReferencePackTag;
  generationKind?: 'image' | 'video'; prompt?: string; aspect?: string;
  quality?: string; resolution?: string; count?: number; duration?: number; sound?: boolean;
};
export type WorkflowEdge = { source: string; target: string; role: CanvasEdgeRole; order: number };
export type WorkflowTemplate = {
  format: typeof WORKFLOW_FORMAT; version: 1; name: string; description: string;
  nodes: WorkflowNode[]; edges: WorkflowEdge[];
};
export class WorkflowError extends Error {
  public code: string;
  constructor(code: string) { super(code); this.name = 'WorkflowError'; this.code = code; }
}
function fail(code: string): never { throw new WorkflowError(code); }
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return fail('invalid-file');
  return v as Record<string, unknown>;
};
function keys(v: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(v).some(k => !allowed.includes(k))) fail('unsupported-field');
}
function text(v: unknown, max: number, required = false): string {
  if (typeof v !== 'string' || v.length > max || (required && !v.trim())) return fail('invalid-text');
  return v;
}
function numeric(v: unknown, min: number, max: number, integer = false): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) return fail('invalid-number');
  return v;
}
function id(v: unknown): string {
  const result = text(v, 80, true);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) fail('invalid-id');
  return result;
}
const asCapabilities = (node: WorkflowNode): CanvasNodeCapabilityData => ({
  kind: node.kind, generationKind: node.generationKind, _emptyMedia: node.kind === 'image' || node.kind === 'video',
});

/** Validate untrusted JSON completely before any canvas mutation or file write. */
export function validateWorkflow(value: unknown): WorkflowTemplate {
  const v = object(value);
  keys(v, ['format', 'version', 'name', 'description', 'nodes', 'edges']);
  if (v.format !== WORKFLOW_FORMAT || v.version !== 1) fail('unsupported-version');
  if (!Array.isArray(v.nodes) || !v.nodes.length || v.nodes.length > WORKFLOW_LIMITS.nodes || !Array.isArray(v.edges) || v.edges.length > WORKFLOW_LIMITS.edges) fail('too-large');
  const nodes: WorkflowNode[] = (v.nodes as unknown[]).map(raw => {
    const n = object(raw);
    keys(n, ['id', 'kind', 'label', 'position', 'parentId', 'width', 'height', 'referencePack', 'generationKind', 'prompt', 'aspect', 'quality', 'resolution', 'count', 'duration', 'sound']);
    if (!['text', 'image', 'video', 'generator', 'group'].includes(String(n.kind))) fail('invalid-kind');
    const p = object(n.position); keys(p, ['x', 'y']);
    const node: WorkflowNode = { id: id(n.id), kind: n.kind as WorkflowKind, label: text(n.label, WORKFLOW_LIMITS.text), position: { x: numeric(p.x, -100_000, 100_000), y: numeric(p.y, -100_000, 100_000) } };
    if (n.parentId !== undefined) node.parentId = id(n.parentId);
    if (n.width !== undefined) node.width = numeric(n.width, 100, 20_000);
    if (n.height !== undefined) node.height = numeric(n.height, 80, 20_000);
    if (n.referencePack !== undefined) {
      const pack = object(n.referencePack); keys(pack, ['version', 'kind']);
      if (node.kind !== 'group' || pack.version !== 1 || !['character', 'product', 'style'].includes(String(pack.kind))) fail('invalid-pack');
      node.referencePack = { version: 1, kind: pack.kind as ReferencePackTag['kind'] };
    }
    const generationFields = ['generationKind', 'prompt', 'aspect', 'quality', 'resolution', 'count', 'duration', 'sound'];
    if (node.kind !== 'generator' && generationFields.some(k => n[k] !== undefined)) fail('invalid-kind');
    if (node.kind === 'generator') {
      if (n.generationKind !== 'image' && n.generationKind !== 'video') fail('invalid-kind');
      node.generationKind = n.generationKind as 'image' | 'video';
      node.prompt = text(n.prompt ?? '', WORKFLOW_LIMITS.text);
      if (n.aspect !== undefined) node.aspect = text(n.aspect, 32);
      if (n.resolution !== undefined) node.resolution = text(n.resolution, 32);
      if (n.quality !== undefined) node.quality = text(n.quality, 32);
      if (n.count !== undefined) node.count = numeric(n.count, 1, 16, true);
      if (n.duration !== undefined) node.duration = numeric(n.duration, 1, 120);
      if (n.sound !== undefined) { if (typeof n.sound !== 'boolean') fail('invalid-field'); node.sound = n.sound as boolean; }
    }
    return node;
  });
  const byId = new Map(nodes.map(n => [n.id, n]));
  if (byId.size !== nodes.length) fail('duplicate-id');
  for (const node of nodes) {
    const visited = new Set([node.id]); let parent = node.parentId;
    while (parent) {
      if (visited.has(parent) || visited.size > 8) fail('group-cycle');
      visited.add(parent); const p = byId.get(parent);
      if (!p || p.kind !== 'group') fail('invalid-parent');
      parent = p.parentId;
    }
  }
  const pairSet = new Set<string>(), incoming = new Map<string, number>();
  const edges: WorkflowEdge[] = (v.edges as unknown[]).map(raw => {
    const e = object(raw); keys(e, ['source', 'target', 'role', 'order']);
    const source = id(e.source), target = id(e.target), from = byId.get(source), to = byId.get(target);
    if (!from || !to || source === target || !canConnectCanvasNodes(asCapabilities(from), asCapabilities(to))) fail('invalid-edge');
    const pair = JSON.stringify([source, target]); if (pairSet.has(pair)) fail('duplicate-edge'); pairSet.add(pair);
    if (!isCanvasEdgeRole(e.role)) fail('invalid-edge');
    if ((e.role === 'firstFrame' || e.role === 'lastFrame') && (to.kind !== 'generator' || to.generationKind !== 'video' || getCanvasNodeContentKind(asCapabilities(from)) !== 'image')) fail('invalid-edge');
    if (e.role === 'promptContext' && getCanvasNodeContentKind(asCapabilities(from)) !== 'text') fail('invalid-edge');
    if ((e.role === 'firstFrame' || e.role === 'lastFrame') && (v.edges as unknown[]).filter(raw => {const candidate=object(raw); return candidate.target===target && candidate.role===e.role;}).length > 1) fail('invalid-edge');
    if (e.role === 'videoReference' && from.kind !== 'video' && from.generationKind !== 'video') fail('invalid-edge');
    const count = (incoming.get(target) ?? 0) + 1; incoming.set(target, count);
    if (count > 4) fail('too-many-inputs');
    return { source, target, role: e.role as CanvasEdgeRole, order: numeric(e.order, 0, 127, true) };
  });
  // Generated workflows must be acyclic; no inherited tasks run during insertion.
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (node: string) => {
    if (visiting.has(node)) fail('edge-cycle');
    if (visited.has(node)) return;
    visiting.add(node); for (const e of edges) if (e.source === node) visit(e.target);
    visiting.delete(node); visited.add(node);
  };
  nodes.forEach(n => visit(n.id));
  const result: WorkflowTemplate = { format: WORKFLOW_FORMAT, version: 1, name: text(v.name, 60, true).trim(), description: text(v.description ?? '', 400), nodes, edges };
  if (new TextEncoder().encode(JSON.stringify(result)).length > WORKFLOW_LIMITS.bytes) fail('too-large');
  return result;
}
export function parseWorkflow(json: string): WorkflowTemplate {
  if (new TextEncoder().encode(json).length > WORKFLOW_LIMITS.bytes) fail('too-large');
  let value: unknown; try { value = JSON.parse(json); } catch { return fail('invalid-file'); }
  return validateWorkflow(value);
}

export type CaptureNode = { id: string; parentId?: string; position: Point; style?: { width?: unknown; height?: unknown }; data: CanvasNodeCapabilityData & Record<string, unknown> };
export type CaptureEdge = { source: string; target: string; data?: { role?: unknown; order?: unknown } | null };
export function captureWorkflow(nodes: readonly CaptureNode[], edges: readonly CaptureEdge[], selectedIds: readonly string[], name: string): { template: WorkflowTemplate; omittedEdges: number; placeholders: number } {
  const selected = new Set(selectedIds), byId = new Map(nodes.map(n => [n.id, n]));
  if (!selected.size || [...selected].some(i => !byId.has(i))) fail('empty-selection');
  // Selecting a group includes descendants, even if React Flow only selects its shell.
  let added = true;
  while (added) { added = false; for (const n of nodes) if (n.parentId && selected.has(n.parentId) && !selected.has(n.id)) { selected.add(n.id); added = true; } }
  const source = nodes.filter(n => selected.has(n.id));
  if (source.length > WORKFLOW_LIMITS.nodes) fail('too-large');
  const absolute = (node: CaptureNode): Point => {
    let p = node.parentId, x = node.position.x, y = node.position.y; const seen = new Set([node.id]);
    while (p) { if (seen.has(p)) fail('group-cycle'); seen.add(p); const parent = byId.get(p); if (!parent) fail('invalid-parent'); x += parent.position.x; y += parent.position.y; p = parent.parentId; }
    return { x, y };
  };
  const roots = source.filter(n => !n.parentId || !selected.has(n.parentId));
  const minX = Math.min(...roots.map(n => absolute(n).x)), minY = Math.min(...roots.map(n => absolute(n).y));
  const ids = new Map(source.map((n, index) => [n.id, `n${index + 1}`]));
  const portable = source.map(n => {
    const d = n.data;
    if (Array.isArray(d.generationReferences)) {
      // Generation stores a snapshot of edge inputs too. Those are already represented
      // by the selected graph; only unmatched direct attachments need user action.
      const internal=edges.filter(e=>e.target===n.id && selected.has(e.source));
      for(const raw of d.generationReferences){
        const ref=object(raw);
        if(typeof ref.id!=='string' || !internal.some(edge=>{
          const from=byId.get(edge.source)!;
          const identity=ref.id===`node:${from.id}` || (ref.id as string).startsWith(`node:${from.id}:`) || typeof from.data.payload==='string' && !!from.data.payload && (ref.id===from.data.payload || (ref.id as string).startsWith(`asset:${from.data.payload}:`));
          return identity && (!isCanvasEdgeRole(ref.role) || !isCanvasEdgeRole(edge.data?.role) || ref.role===edge.data.role);
        }))fail('stored-references');
      }
    }
    let kind: WorkflowKind = d.kind === 'aiPrompt' || d.kind === 'noteRef' ? 'text' : d.kind === 'aiResult' ? (d.resultKind || 'text') : d.kind;
    const parentId = n.parentId && ids.get(n.parentId), p = parentId ? n.position : absolute(n);
    // Note IDs, snippets, URLs, task state, model profiles and generated media never leave the canvas.
    const label = d.kind === 'noteRef' ? '请补充笔记内容 / Add note context' : kind === 'text' ? String(d.kind === 'aiResult' ? d.result || d.label || '' : d.label ?? d.result ?? '') : kind === 'image' || kind === 'video' ? (kind === 'image' ? '参考图片 / Reference image' : '参考视频 / Reference video') : String(d.label || '');
    const result: WorkflowNode = { id: ids.get(n.id)!, kind, label, position: parentId ? { ...p } : { x: p.x - minX, y: p.y - minY } };
    if (parentId) result.parentId = parentId;
    if (typeof n.style?.width === 'number') result.width = n.style.width;
    if (typeof n.style?.height === 'number') result.height = n.style.height;
    if (kind === 'group' && d.referencePack) result.referencePack = d.referencePack as ReferencePackTag;
    if (kind === 'generator') {
      result.generationKind = d.generationKind || 'image'; result.prompt = String(d.generationPrompt || d.payload || '');
      if (typeof d.generationAspect === 'string') result.aspect = d.generationAspect;
      if (typeof d.generationResolution === 'string') result.resolution = d.generationResolution;
      if (typeof d.generationQuality === 'string') result.quality = d.generationQuality;
      if (typeof d.generationCount === 'number') result.count = d.generationCount;
      if (typeof d.generationDuration === 'number') result.duration = d.generationDuration;
      if (typeof d.generationSound === 'boolean') result.sound = d.generationSound;
    }
    return result;
  });
  const kept = edges.filter(e => selected.has(e.source) && selected.has(e.target));
  const serializedEdges:WorkflowEdge[]=[];
  for(const e of kept){
    const target=ids.get(e.target)!;
    const incoming=serializedEdges.filter(edge=>edge.target===target).map(edge=>({...edge,data:{role:edge.role}}));
    serializedEdges.push({source:ids.get(e.source)!,target,role:isCanvasEdgeRole(e.data?.role)?e.data.role:inferCanvasEdgeRole(byId.get(e.source)!.data,byId.get(e.target)!.data,incoming),order:typeof e.data?.order==='number'?e.data.order:incoming.length});
  }
  const template = validateWorkflow({ format: WORKFLOW_FORMAT, version: 1, name, description: '', nodes: portable, edges: serializedEdges });
  return { template, omittedEdges: edges.filter(e => selected.has(e.source) !== selected.has(e.target)).length, placeholders: portable.filter(n => n.kind === 'image' || n.kind === 'video').length };
}

/** One atomic graph mutation. Caller uses the existing canvas undo/save path. */
export function instantiateWorkflow(value: unknown, origin: Point, nextId: () => string, occupiedIds: readonly string[] = []) {
  const template = validateWorkflow(value), used = new Set(occupiedIds);
  numeric(origin.x, -1_000_000, 1_000_000); numeric(origin.y, -1_000_000, 1_000_000);
  const allocate = () => { const id = nextId(); if (!id || used.has(id)) return fail('id-collision'); used.add(id); return id; };
  const ids = new Map(template.nodes.map(n => [n.id, allocate()]));
  const nodes = template.nodes.map(n => {
    // Match the canvas's current New Image / New Video action immediately,
    // rather than creating legacy placeholders that change kind after reopen.
    const mediaDraft=n.kind==='image'||n.kind==='video';
    const kind=mediaDraft?'generator':n.kind;
    return {
      id:ids.get(n.id)!,type:kind==='group'?'group':'spike',
      ...(n.parentId?{parentId:ids.get(n.parentId)!,extent:'parent' as const}:{}),
      position:n.parentId?{...n.position}:{x:origin.x+n.position.x,y:origin.y+n.position.y},
      ...(!mediaDraft&&(n.width||n.height)?{style:{...(n.width?{width:n.width}:{}),...(n.height?{height:n.height}:{})}}:{}),
      dragHandle:kind==='group'?'.canvas-group-drag-handle':kind==='generator'?'.canvas-node-drag-handle':undefined,
      selected:!n.parentId,
      data:normalizeCanvasNodeCapabilityData({kind,label:n.label,
        ...(n.referencePack?{referencePack:{...n.referencePack}}:{}),
        ...(kind==='group'?{groupMemberCount:template.nodes.filter(child=>child.parentId===n.id).length}:{}),
        ...(kind==='generator'?{generationKind:mediaDraft?n.kind as 'image'|'video':n.generationKind,generationPrompt:n.prompt||'',generationAspect:n.aspect||((mediaDraft?n.kind:n.generationKind)==='video'?'16:9':'1:1'),generationQuality:n.quality,generationResolution:n.resolution,generationCount:n.count,generationDuration:n.duration,generationSound:n.sound}:{}),
      }),
    };
  });
  // React Flow requires parents before children; input JSON ordering is irrelevant.
  const depth = (id: string): number => { const n = nodes.find(n => n.id === id)!; return n.parentId ? depth(n.parentId) + 1 : 0; };
  nodes.sort((a, b) => depth(a.id) - depth(b.id));
  const edges = template.edges.map(e => ({ id: allocate(), source: ids.get(e.source)!, target: ids.get(e.target)!, animated: false, data: { semanticsVersion: 1, role: e.role, order: e.order } }));
  return { nodes, edges };
}

export function builtinWorkflows(english = false): WorkflowTemplate[] {
  const base=(name:string,description:string,nodes:WorkflowNode[],edges:WorkflowEdge[])=>validateWorkflow({format:WORKFLOW_FORMAT,version:1,name,description,nodes,edges});
  const edge=(source:string,target:string,role:CanvasEdgeRole,order=0):WorkflowEdge=>({source,target,role,order});
  const card=(id:string,label:string,prompt:string,x=0,y=0,kind:'image'|'video'='image'):WorkflowNode=>({id,kind:'generator',label,generationKind:kind,prompt,aspect:kind==='video'?'16:9':'1:1',position:{x,y}});
  const brief:WorkflowNode={id:'brief',kind:'text',label:english?'Describe the subject, audience and constraints shared by both directions.':'填写两张图片共用的主题、受众与要求。',position:{x:0,y:0}};
  return [
    base(english?'Product hero image':'产品主图',english?'One ready-to-edit image card. Add your product references directly in its composer.':'直接在图片卡输入产品需求；需要保留现有产品时，在该卡添加参考素材。',[card('hero',english?'Product hero':'产品主图',english?'Create a clean product hero image. Describe the product here, and add product reference images when needed. Preserve their real details.':'在这里填写产品名称、外观、背景与构图要求。需要保持产品一致时，为本卡添加产品参考图，保留真实细节。')],[]),
    base(english?'Poster directions':'海报双方案',english?'Shared brief and two image cards, each with an editable prompt.':'共用一份说明，两张图片卡各自输入方案并生成。',[brief,card('minimal',english?'Minimal poster':'简洁版',english?'Create a clean poster from the connected brief, with a clear subject and space for copy.':'根据连接的说明制作简洁海报，主体突出，层次清晰，预留文案空间。',440),card('atmosphere',english?'Atmospheric poster':'氛围版','根据连接的说明制作氛围感海报，突出光影与场景，保持主题一致。',440,510)],[edge('brief','minimal','promptContext'),edge('brief','atmosphere','promptContext')]),
    base(english?'Character shots':'角色双镜头',english?'Generate the first image, then use its result as the second image’s reference.':'先在第一张图片卡生成角色，再以它的结果作为第二张图片卡的参考。',[card('wide',english?'Character wide shot':'角色 · 全景',english?'Describe the character, clothing and setting. Generate a clear wide shot.':'填写角色外观、服装与场景，生成清晰的全景角色图。'),card('close',english?'Character close-up':'角色 · 特写',english?'Create a close-up using the connected image. Preserve the same character and clothing.':'根据连接的角色图片制作特写，保持同一角色、服装与场景连续。',760)],[edge('wide','close','reference')]),
    base(english?'Image to short video':'图片转短片',english?'Generate an image first, then use it as a video first frame with a compatible model.':'先生成图片，再将结果作为视频首帧；视频卡内直接填写运动描述，需选择支持首帧的模型。',[card('frame',english?'First frame':'首帧图片',english?'Describe the scene and main subject for the opening frame.':'填写开场画面、主体与构图要求。'),card('clip',english?'Video':'视频',english?'Use the connected first frame. Describe the desired motion; maintain scene continuity.':'以连接的图片为首帧，填写希望的镜头运动与主体动作，保持画面连续。',760,0,'video')],[edge('frame','clip','firstFrame')]),
  ];
}
