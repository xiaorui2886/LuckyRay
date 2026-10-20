import {useEffect, useMemo, useRef, useState} from 'react';
import {builtinWorkflows, parseWorkflow, WORKFLOW_LIMITS, WorkflowError, type WorkflowTemplate} from '../../core/canvas/workflowTemplates';
import {CanvasCreativeDialog} from './CanvasCreativeDialog';
import './canvasCreative.css';

export function workflowErrorMessage(error: unknown, english = false): string {
  if (error instanceof Error && error.message === "storyboard-unsupported") return english ? "Storyboard notes are not supported in workflow templates yet. Save the canvas instead." : "工作流模板暂不支持分镜信息，请保存画布，避免丢失镜头说明。";
 const code = error instanceof WorkflowError ? error.code : 'operation-failed';
 const messages: Record<string, [string, string]> = {
  'empty-selection':['先在画布中选中卡片或参考包。','Select cards or a reference pack on the canvas first.'],
  'stored-references':['所选生成卡还有直接添加的参考素材。请先改为画布参考卡连线，再导出，避免遗漏参考。','Some cards contain directly attached references. Connect reference cards before exporting to avoid losing inputs.'],
  'too-large':['模板超过上限：64 张卡片、128 条连线、500 KB。','Template exceeds the limit: 64 cards, 128 connections, 500 KB.'],
  'canvas-changed':['当前画布已变化，请重新打开模板。','The active canvas changed. Open templates again.'],
  'invalid-text':['请检查名称与文本长度，名称最多 60 字。','Check the name and text lengths. Names allow up to 60 characters.'],
  'operation-failed':['未能完成操作，画布内容未改变。请重试。','The operation failed. Canvas content was not changed. Please retry.'],
 };
 return messages[code]?.[english ? 1 : 0] || (english ? `Invalid workflow (${code}). Nothing was inserted.` : `模板不符合格式要求（${code}），未添加任何卡片。`);
}

const PREFERENCE_KEY = 'luckyray.canvas.workflow-browser.v1';
type LibraryPreferences = { favorites: string[]; recent: string[] };
function readPreferences(): LibraryPreferences {
 try { const value = JSON.parse(localStorage.getItem(PREFERENCE_KEY) || '{}');
  const safe = (items: unknown) => Array.isArray(items) ? items.filter((id): id is string => typeof id === 'string' && /^builtin-\d+$/.test(id)).slice(0, 32) : [];
  return {favorites: safe(value.favorites), recent: safe(value.recent)};
 } catch { return {favorites: [], recent: []}; }
}
function savePreferences(value: LibraryPreferences) { try { localStorage.setItem(PREFERENCE_KEY, JSON.stringify(value)); } catch { /* Session still works without storage. */ } }

type Props = {
 english?: boolean; selectionCount: number; onClose: () => void;
 onInsert: (template: WorkflowTemplate) => void;
 onExport: (name: string) => Promise<{cancelled: boolean; placeholders: number; omittedEdges: number}>;
};
export function CanvasWorkflowLibrary({english = false, selectionCount, onClose, onInsert, onExport}: Props) {
 const builtins = useMemo(() => builtinWorkflows(english), [english]);
 const [query, setQuery] = useState(''), [filter, setFilter] = useState<'all'|'favorites'|'recent'>('all');
 const [preferences, setPreferences] = useState(readPreferences);
 const [selected, setSelected] = useState<WorkflowTemplate>(builtins[0]);
 const [name, setName] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
 const inserting = useRef(false), exporting = useRef(false);
 const alive = useRef(true), request = useRef(0), fileInput = useRef<HTMLInputElement>(null);
 useEffect(() => {alive.current = true; return () => {alive.current = false; request.current++;};}, []);
 const choose = (template: WorkflowTemplate) => {if (exporting.current) return; request.current++; setSelected(template); setNotice(''); setBusy(false);};
 async function loadFile(file: File | undefined) {
  if (!file) return;
  const token = ++request.current; setBusy(true); setNotice('');
  try {
   if (file.size > WORKFLOW_LIMITS.bytes) throw new WorkflowError('too-large');
   const template = parseWorkflow(await file.text());
   if (!alive.current || token !== request.current) return;
   setSelected(template);
   setNotice(english ? 'File checked. Review its contents before adding it.' : '文件已校验，确认内容后再添加到画布。');
  } catch (error) {if (alive.current && token === request.current) setNotice(workflowErrorMessage(error, english));}
  finally {if (alive.current && token === request.current) setBusy(false);}
 }
 async function exportSelection() {
  if (exporting.current || !name.trim() || !selectionCount) return;
  exporting.current = true;
  setBusy(true); setNotice(''); const token = ++request.current;
  try {
   const result = await onExport(name.trim());
   if (!alive.current || token !== request.current) return;
   setNotice(result.cancelled ? (english ? 'Export cancelled.' : '已取消导出。') : english
    ? `Template saved. ${result.placeholders} media placeholders; ${result.omittedEdges} outside connections omitted.`
    : `模板已保存，含 ${result.placeholders} 个待补素材位置；未包含 ${result.omittedEdges} 条通向选区外的连线。`);
  } catch(error) {if (alive.current && token === request.current) setNotice(workflowErrorMessage(error, english));}
  finally {exporting.current = false; if (alive.current && token === request.current) setBusy(false);}
 }
 const favorite = (id: string) => { const next = {...preferences, favorites: preferences.favorites.includes(id) ? preferences.favorites.filter(value => value !== id) : [...preferences.favorites, id].slice(-32)}; setPreferences(next); savePreferences(next); };
 const templates = builtins.map((template, index) => ({template, id: `builtin-${index}`})).filter(({template, id}) => (!query.trim() || `${template.name} ${template.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) && (filter === 'all' || (filter === 'favorites' ? preferences.favorites : preferences.recent).includes(id)));
 if (filter === 'recent') templates.sort((a,b) => preferences.recent.indexOf(a.id) - preferences.recent.indexOf(b.id));
 const recordUse = () => { const index = builtins.indexOf(selected); if (index < 0) return; const id = `builtin-${index}`, next = {...preferences, recent: [id, ...preferences.recent.filter(value => value !== id)].slice(0, 12)}; setPreferences(next); savePreferences(next); };
 const placeholders = selected.nodes.filter(n => n.kind === 'image' || n.kind === 'video').length;
 return <CanvasCreativeDialog title={english ? 'Workflow templates' : '创作模板'} subtitle={english ? 'Choose a structure, review the inputs, then make it yours.' : '先选结构，再补参考，保留你的创作方式。'} onClose={onClose} english={english} className="canvas-workflow-dialog">
  <div className="canvas-workflow-layout">
   <nav className="canvas-workflow-list" aria-label={english ? 'Template list' : '模板列表'}>
    <input type="search" className="canvas-creative-search" aria-label={english ? 'Search templates' : '搜索模板'} placeholder={english ? 'Search templates…' : '搜索模板…'} value={query} onChange={event => setQuery(event.target.value)} />
    <div className="canvas-creative-filterbar" aria-label={english ? 'Template filters' : '模板筛选'}>{(['all','favorites','recent'] as const).map(value => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? english ? 'All' : '全部' : value === 'favorites' ? english ? 'Saved' : '收藏' : english ? 'Recent' : '最近'}</button>)}</div>
    <div className="canvas-workflow-results">{templates.map(({template, id}) => <div className="canvas-workflow-list-item" key={id}>
     <button type="button" aria-pressed={selected === template} onClick={() => choose(template)}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="6" height="6" rx="1.5"/><rect x="15" y="8" width="6" height="8" rx="1.5"/><path d="M9 7h3v5h3M3 15h6v5H3zM9 17h3v-5"/></svg>
      <span><strong>{template.name}</strong><small>{template.nodes.length} {english ? 'cards' : '张卡片'} · {template.nodes.some(node => node.generationKind === 'video') ? english ? 'Video' : '视频' : english ? 'Images' : '图像'}</small></span>
     </button>
     <button type="button" className="canvas-workflow-favorite" aria-label={`${preferences.favorites.includes(id) ? english ? 'Unsave' : '取消收藏' : english ? 'Save' : '收藏'} ${template.name}`} aria-pressed={preferences.favorites.includes(id)} title={english ? 'Save template' : '收藏模板'} onClick={() => favorite(id)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.3.9-4.5 4.4 1.1 6.2L12 17.3l-5.7 3 1.1-6.2L3 9.6l6.2-.9Z"/></svg></button>
    </div>)}</div>
    {!templates.length && <p className="canvas-creative-search-empty">{query.trim() ? english ? 'No matching templates.' : '没有匹配的模板。' : filter === 'favorites' ? english ? 'Save a template with the star to find it here.' : '点亮模板旁的星标，常用模板就在这里。' : english ? 'Templates you add to a canvas appear here.' : '添加到画布的模板会出现在这里。'}</p>}
    <button type="button" disabled={busy} onClick={() => fileInput.current?.click()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/></svg>{english ? 'Open template file' : '打开模板文件'}</button>
    <input ref={fileInput} type="file" accept=".json,application/json" hidden aria-label={english ? 'Workflow JSON file' : '模板 JSON 文件'} onChange={e => {void loadFile(e.target.files?.[0]); e.target.value = '';}}/>
   </nav>
   <section className="canvas-workflow-detail" aria-label={english ? 'Template preview' : '模板预览'}>
    <WorkflowPreview template={selected}/>
    <h3>{selected.name}</h3><p>{selected.description}</p>
    <div className="canvas-workflow-stats"><span>{selected.nodes.length} {english ? 'cards' : '张卡片'}</span><span>{selected.edges.length} {english ? 'connections' : '条连线'}</span>{placeholders > 0 ? <span>{placeholders} {english ? 'media slots to fill' : '处素材待补齐'}</span> : null}</div>
    <details><summary>{english ? 'Inspect text and prompts' : '查看文本与提示词'}</summary>{selected.nodes.filter(n => n.kind === 'text' || n.kind === 'generator').map(n => <div key={n.id}><strong>{n.kind === 'generator' ? n.label : english ? 'Text card' : '文本卡'}</strong><p>{n.kind === 'generator' ? n.prompt : n.label}</p></div>)}</details>
    <p className="canvas-creative-hint">{english ? 'Adds editable cards and connections to this canvas. Choose media and a model, then generate when ready. No task starts automatically.' : '图片、视频卡均可直接输入生成。按连线顺序逐张操作；不会自动调用模型。'}</p>
    <button type="button" className="is-primary" disabled={busy} onClick={() => {if (inserting.current || busy) return; inserting.current = true; try {onInsert(selected); recordUse(); onClose();} catch(error) {inserting.current = false; setNotice(workflowErrorMessage(error, english));}}}>{english ? 'Add to canvas' : '添加到当前画布'}</button>
   </section>
  </div>
  <details className="canvas-workflow-export-disclosure"><summary>{english ? `Save selected cards as a template · ${selectionCount} selected` : `将所选保存为模板 · 已选 ${selectionCount} 项`}</summary><form className="canvas-workflow-export" onSubmit={e => {e.preventDefault(); void exportSelection();}}>
   <div><strong>{english ? 'Keep your own workflow' : '留住自己的创作流程'}</strong><p>{english ? 'Export selected cards or a reference pack, then open the file in another canvas. Text and prompts are included; review them before sharing. Media, note contents, model profiles and task history are not included.' : '将所选卡片或参考包导出，在另一画布打开。包含文本与提示词，分享前请检查；素材文件、引用笔记正文、模型配置与任务记录不随模板导出。'}</p></div>
   <label><span className="canvas-workflow-eyebrow">{english ? 'TEMPLATE NAME' : '模板名称'}</span><input aria-label={english ? 'Template name' : '模板名称'} maxLength={60} value={name} onChange={e => setName(e.target.value)} placeholder={english ? 'My product workflow' : '如：我的产品创作流程'}/></label>
   <button type="submit" disabled={busy || !name.trim() || !selectionCount}>{english ? 'Export selection' : '导出所选模板'}</button>
  </form></details>
  {notice ? <p className="canvas-creative-notice" role="status">{notice}</p> : null}
 </CanvasCreativeDialog>;
}

function WorkflowPreview({template}: {template: WorkflowTemplate}) {
 const byId = new Map(template.nodes.map(n => [n.id, n]));
 const items = template.nodes.map(n => {
  let x = n.position.x, y = n.position.y, parent = n.parentId;
  while(parent) {const p = byId.get(parent)!; x += p.position.x; y += p.position.y; parent = p.parentId;}
  return {...n, x, y, w: n.width || (n.kind === 'generator' ? 620 : 280), h: n.height || (n.kind === 'generator' ? 430 : 220)};
 });
 const minX = Math.min(...items.map(n => n.x)), minY = Math.min(...items.map(n => n.y));
 const width = Math.max(...items.map(n => n.x + n.w)) - minX, height = Math.max(...items.map(n => n.y + n.h)) - minY;
 return <svg className="canvas-workflow-preview" viewBox={`${minX-30} ${minY-30} ${width+60} ${height+60}`} role="img" aria-label={template.name}>
  {items.filter(n => n.kind === 'group').map(n => <rect key={n.id} className="is-group" x={n.x} y={n.y} width={n.w} height={n.h} rx="16"/>)}
  {template.edges.map((e,i) => {const a = items.find(n => n.id === e.source)!, b = items.find(n => n.id === e.target)!; return <path key={i} d={`M${a.x+a.w},${a.y+a.h/2} C${a.x+a.w+90},${a.y+a.h/2} ${b.x-90},${b.y+b.h/2} ${b.x},${b.y+b.h/2}`}/>;})}
  {items.filter(n => n.kind !== 'group').map(n => <g key={n.id}><rect x={n.x} y={n.y} width={n.w} height={n.h} rx="16" className={n.kind === 'generator' ? 'is-generator' : ''}/><g transform={`translate(${n.x+22} ${n.y+18}) scale(1.25)`}><path d={n.kind === 'text' ? 'M2 4h20M12 4v20M7 24h10' : n.kind === 'generator' && n.generationKind === 'video' ? 'M2 5h14v16H2zM16 10l8-4v14l-8-4' : 'M2 3h22v20H2zM2 18l7-7 6 6 4-4 5 5M17 8h.01'}/></g><path d={`M${n.x+22} ${n.y+68}h${Math.max(20,n.w-44)}m-${Math.max(20,n.w-44)} 24h${Math.max(10,n.w/2)}`}/></g>)}
 </svg>;
}
