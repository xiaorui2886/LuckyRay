import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { canvasPickerExcerpt, canvasPickerRows, canvasPreviewPosition, type CanvasPickerItem } from '../../core/canvas/libraryPicker';
import type { CanvasLibraryFolder } from '../../core/canvas/libraryFolders';
import { createPortal } from 'react-dom';
import { CanvasDialogPortal } from './CanvasDialogScope';
import { CanvasHoverVideo } from './CanvasHoverVideo';
import './canvasLibraryPicker.css';
import './canvasPanelSurface.css';

function Icon({kind}: {kind: string}) {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">{kind === 'folder' ? <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/> : kind === 'image' ? <><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="9" r="1.5"/><path d="m4 18 5-5 4 3 3-4 5 6"/></> : kind === 'video' ? <><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 9 5 3-5 3Z"/></> : kind === 'audio' ? <><path d="M9 17V6l11-2v11M9 7l11-2"/><circle cx="6" cy="17" r="3"/><circle cx="17" cy="15" r="3"/></> : kind === 'search' ? <><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></> : <><path d="M6 3h8l4 4v14H6ZM14 3v5h4M9 12h6M9 16h6"/></>}</svg>;
}
function Thumbnail({src,kind}: {src: string; kind: string}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return src && !failed ? <img src={src} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)}/> : <Icon kind={kind}/>;
}

export function CanvasLibraryPicker<T extends CanvasPickerItem>({title,variant,items,loading,folders = null,error,onPick,onImport,onClose,renderItem,emptyText,resolveUrl,english = false,portalHost}: {
  title: string; variant: 'asset' | 'note'; items: T[]; loading: boolean; folders?: CanvasLibraryFolder[] | null; error?: string;
  onPick: (item: T) => void; onImport?: () => void; onClose: () => void; renderItem: (item: T) => string; emptyText: string;
  resolveUrl: (value: string | null | undefined) => string; english?: boolean; portalHost?: HTMLElement | null;
}) {
  const [query,setQuery] = useState(''), [expanded,setExpanded] = useState<Set<string>>(() => new Set()), [active,setActive] = useState('');
  const [preview,setPreview] = useState<{item: T; left: number; top: number; width: number; path: string} | null>(null);
  const overlay = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null), list = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const enterTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), pointerStartedOutside = useRef(false);
  const titleId = useId(), listId = useId();
  const rows = useMemo(() => canvasPickerRows(items, folders, expanded, query, renderItem), [items, folders, expanded, query, renderItem]);
  const cancelTimers = () => { clearTimeout(enterTimer.current); clearTimeout(leaveTimer.current); };
  const closePreview = () => { cancelTimers(); setPreview(null); };
  useEffect(() => { const old = document.activeElement instanceof HTMLElement ? document.activeElement : null; input.current?.focus(); return () => { cancelTimers(); if (old?.isConnected) old.focus(); }; }, []);
  useEffect(() => { closePreview(); setActive(''); }, [query, expanded, items, loading, error]);
  useEffect(() => {
    const close = () => closePreview();
    window.addEventListener('resize',close);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(close);
    if (portalHost) observer?.observe(portalHost);
    return () => { window.removeEventListener('resize',close); observer?.disconnect(); };
  }, [portalHost]);
  const folderCounts = useMemo(() => { const counts = new Map<string,number>(); for (const item of items) if (item.folderId) counts.set(item.folderId,(counts.get(item.folderId)||0)+1); return counts; }, [items]);
  const folderParents = useMemo(() => new Set((folders || []).map(folder => folder.parentId)), [folders]);
  const kindOf = (item: T) => variant === 'note' ? 'note' : item.kind || 'document';
  const thumbnail = (item: T) => variant === 'note' ? '' : resolveUrl(item.thumbnailUrl || (item.kind === 'image' ? item.previewUrl || item.libraryPath || item.originalPath : ''));
  const typeName = (item: T) => ({image:english?'Image':'图片',video:english?'Video':'视频',audio:english?'Audio':'音频',note:english?'Note':'笔记',document:english?'Document':'文档'}[kindOf(item)] || (english?'File':'文件'));
  const toggle = (id: string) => setExpanded(current => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const showPreview = (item: T, path: string, target: HTMLElement, immediate = false) => {
    cancelTimers(); const rect = target.getBoundingClientRect(), bounds = overlay.current?.getBoundingClientRect();
    const anchor = {left:rect.left-(bounds?.left||0),right:rect.right-(bounds?.left||0),top:rect.top-(bounds?.top||0)};
    const viewport = {width:bounds?.width||window.innerWidth,height:bounds?.height||window.innerHeight};
    enterTimer.current = setTimeout(() => setPreview({item,path,...canvasPreviewPosition(anchor,viewport)}), immediate ? 0 : 240);
  };
  const leave = () => { clearTimeout(enterTimer.current); leaveTimer.current = setTimeout(() => setPreview(null), 180); };
  const move = (step: number) => {
    if (!rows.length || loading || error) return;
    const index = rows.findIndex(row => row.key === active), next = rows[index < 0 ? (step > 0 ? 0 : rows.length - 1) : (index + step + rows.length) % rows.length];
    setActive(next.key); const target = list.current?.querySelector<HTMLElement>(`[data-row-index="${rows.indexOf(next)}"]`);
    target?.scrollIntoView?.({block:'nearest'}); if (next.item && target) showPreview(next.item,next.path,target,true); else closePreview();
  };
  const current = rows.find(row => row.key === active);
  const content = <div ref={overlay} className={`clp-backdrop canvas-panel-overlay${portalHost ? ' is-canvas-relative' : ''} nodrag nopan nowheel`} role="presentation" onWheel={event => event.stopPropagation()} onPointerDown={event => { pointerStartedOutside.current = event.target === event.currentTarget && event.button === 0; }} onClick={event => { if (event.target === event.currentTarget && pointerStartedOutside.current) onClose(); pointerStartedOutside.current = false; }} onKeyDown={event => {
    event.stopPropagation(); if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); if (preview) closePreview(); else onClose(); }
    if (event.key === 'Tab') {
      const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input') || []), first = controls[0], last = controls[controls.length-1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <div className="clp-dialog" ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="clp-header"><span className="clp-header-symbol"><Icon kind={variant === 'asset' ? 'image' : 'note'}/></span><h2 id={titleId}>{title}</h2><span className="clp-count">{items.length}</span></header>
      <label className="clp-search"><Icon kind="search"/><input ref={input} value={query} onChange={event=>setQuery(event.target.value)} placeholder={english?'Search names and content…':variant==='asset'?'搜索素材名称、提示词…':'搜索笔记标题、正文…'} aria-label={english?'Search library':'搜索库内容'} aria-controls={listId} onKeyDown={event=>{
        if(event.nativeEvent.isComposing || event.keyCode === 229)return;
        if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();move(event.key==='ArrowDown'?1:-1);}
        if(event.key==='Enter'&&current&&!loading&&!error){event.preventDefault();current.folder?toggle(current.folder.id):current.item&&onPick(current.item);}
      }}/>{query&&<button type="button" onClick={()=>{setQuery('');input.current?.focus();}} aria-label={english?'Clear search':'清空搜索'}>×</button>}</label>
      <div className="clp-location"><span>{query ? (english?'Search all folders':'搜索全部文件夹') : variant==='asset'?(english?'Material library':'素材库'):(english?'Knowledge library':'知识库')}</span><span>{query ? `${rows.length} ${english?'results':'项结果'}` : english?'Folders & contents':'文件夹与内容'}</span></div>
      <div className="clp-list" ref={list} id={listId} onScroll={closePreview}>
        {error ? <div className="clp-empty" role="alert">{error}</div> : loading ? <div className="clp-empty" role="status">{english?'Loading…':'正在加载…'}</div> : !rows.length ? <div className="clp-empty">{query?(english?'No matching content':'没有匹配的内容'):emptyText}</div> : rows.map((row,index)=>row.folder ? <div key={row.key}>
          <button type="button" className={`clp-row clp-folder${active===row.key?' is-active':''}`} style={{paddingLeft:10+Math.min(row.depth,12)*18}} data-row-index={index} aria-expanded={expanded.has(row.folder.id)} onMouseEnter={closePreview} onClick={()=>toggle(row.folder!.id)} onKeyDown={event=>{if(event.key==='ArrowRight'&&!expanded.has(row.folder!.id)){event.preventDefault();toggle(row.folder!.id);}if(event.key==='ArrowLeft'&&expanded.has(row.folder!.id)){event.preventDefault();toggle(row.folder!.id);}}}>
            <svg className={`clp-chevron${expanded.has(row.folder.id)?' is-open':''}`} viewBox="0 0 16 16"><path d="m6 3 5 5-5 5"/></svg><Icon kind="folder"/><strong>{row.folder.name}</strong><span className="clp-folder-count">{folderCounts.get(row.folder.id) || ''}</span>
          </button>
          {expanded.has(row.folder.id)&&!folderCounts.has(row.folder.id)&&!folderParents.has(row.folder.id)&&<div className="clp-empty-folder" style={{paddingLeft:46+Math.min(row.depth,12)*18}}>{english?'Empty folder':'空文件夹'}</div>}
        </div> : row.item ? <button key={row.key} data-row-index={index} type="button" className={`clp-row clp-item${active===row.key||preview?.item.id===row.item.id?' is-active':''}`} style={{paddingLeft:28+Math.min(row.depth,12)*18}} onClick={()=>onPick(row.item!)} onMouseEnter={event=>{setActive(row.key);showPreview(row.item!,row.path,event.currentTarget);}} onMouseLeave={leave} onFocus={event=>{setActive(row.key);showPreview(row.item!,row.path,event.currentTarget);}} onBlur={leave}>
          <span className="clp-thumb"><Thumbnail src={thumbnail(row.item)} kind={kindOf(row.item)}/>{kindOf(row.item)==='video'&&<span className="clp-video-badge" aria-hidden="true"><svg viewBox="0 0 12 12"><path d="m4 2 6 4-6 4Z"/></svg></span>}</span><span className="clp-copy"><strong>{renderItem(row.item)}</strong>{query&&<small>{[canvasPickerExcerpt(row.item),row.path].filter(Boolean).join(" · ")||typeName(row.item)}</small>}</span><span className="clp-item-type">{typeName(row.item)}</span>
        </button> : null)}
      </div>
      <footer className="clp-footer">{onImport&&variant==='asset'?<button type="button" onClick={onImport} disabled={loading}>{english?'+ Import from computer':'+ 从本地导入'}</button>:<span>{english?'Click to add to canvas':'点击添加到画布'}</span>}<span>{english?'Hover to preview':'悬停预览'}<kbd>Esc</kbd></span></footer>
      {preview&&!loading&&!error&&<aside className="clp-hover" style={{left:preview.left,top:preview.top,width:preview.width,maxHeight:`calc(100% - ${preview.top + 12}px)`}} aria-label={english?'Content preview':'内容预览'} onMouseEnter={()=>clearTimeout(leaveTimer.current)} onMouseLeave={leave} onFocus={()=>clearTimeout(leaveTimer.current)} onBlur={leave}>
        {kindOf(preview.item)==='video'?<div className="clp-hover-media"><CanvasHoverVideo key={preview.item.id} source={resolveUrl(preview.item.libraryPath||preview.item.originalPath||preview.item.previewUrl)} poster={thumbnail(preview.item)} label={renderItem(preview.item)} unavailable={english?'Preview unavailable':'预览不可用'}/></div>:kindOf(preview.item)==='image'||thumbnail(preview.item)?<div className="clp-hover-media"><Thumbnail src={resolveUrl(preview.item.kind==='image'?(preview.item.previewUrl||preview.item.libraryPath||preview.item.originalPath||preview.item.thumbnailUrl):preview.item.thumbnailUrl)} kind={kindOf(preview.item)}/></div>:<div className={`clp-hover-document${variant==='note'?' is-note':''}`}>{variant==='note'?<p>{preview.item.contentText?.trim()||(english?'This note has no text preview.':'这篇笔记暂无正文预览。')}</p>:<Icon kind={kindOf(preview.item)}/>}</div>}
        <div className="clp-hover-copy"><strong>{renderItem(preview.item)}</strong><small>{preview.path||typeName(preview.item)}</small>{variant==='asset'&&canvasPickerExcerpt(preview.item)&&<p>{canvasPickerExcerpt(preview.item)}</p>}</div><button className="clp-apply" type="button" onClick={()=>onPick(preview.item)}>{english?'Add to canvas':'添加到画布'}</button>
      </aside>}
    </div>
  </div>;
  return portalHost ? createPortal(content, portalHost) : <CanvasDialogPortal layer={1500}>{content}</CanvasDialogPortal>;
}
