import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import './canvasNodeSearchPanel.css';
import './canvasPanelSurface.css';

export type CanvasNodeSearchKind = 'image' | 'video' | 'text' | 'audio' | 'note' | 'group' | 'other';
export type CanvasNodeSearchRow = {
  id: string;
  label: string;
  kind: CanvasNodeSearchKind;
  /** A display-ready image URL. Video rows must supply a poster, never a video URL. */
  thumbnailUrl?: string | null;
  /** The generation prompt or actual text/note body, rather than the node type. */
  snippet?: string | null;
};
export type CanvasNodeSearchFilter = CanvasNodeSearchKind | 'all';

/** Keep generator/legacy result nodes in their actual media category. */
export function canvasNodeSearchKind(data: { kind: string; generationKind?: string; resultKind?: string; refKind?: string }): CanvasNodeSearchKind {
  if (data.kind === 'group') return 'group';
  if (data.kind === 'noteRef' || data.kind === 'note') return 'note';
  if (data.kind === 'aiPrompt' || data.kind === 'text') return 'text';
  const kind = data.kind === 'generator' ? data.generationKind || 'image'
    : data.kind === 'aiResult' ? data.resultKind || 'text'
      : data.refKind === 'audio' ? 'audio' : data.kind;
  return kind === 'image' || kind === 'video' || kind === 'text' || kind === 'audio' ? kind : 'other';
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

/** Filter before ranking, with no arbitrary ten-row cutoff hiding valid nodes. */
export function filterCanvasNodeSearchRows(rows: readonly CanvasNodeSearchRow[], query: string, filter: CanvasNodeSearchFilter = 'all'): CanvasNodeSearchRow[] {
  const needle = normalizeSearchText(query);
  return rows
    .filter(row => filter === 'all' || row.kind === filter)
    .map((row, index) => {
      const label = normalizeSearchText(row.label);
      const body = normalizeSearchText(row.snippet || '');
      const rank = !needle ? 0 : label === needle ? 0 : label.startsWith(needle) ? 1 : label.includes(needle) ? 2 : body.includes(needle) ? 3 : -1;
      return { row, index, rank };
    })
    .filter(item => item.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(item => item.row);
}

const FILTERS: CanvasNodeSearchFilter[] = ['all', 'image', 'video', 'text', 'audio', 'note', 'group'];
const LABELS: Record<CanvasNodeSearchFilter, [string, string]> = {
  all: ['全部', 'All'], image: ['图片', 'Images'], video: ['视频', 'Video'], text: ['文本', 'Text'],
  audio: ['音频', 'Audio'], note: ['笔记', 'Notes'], group: ['分组', 'Groups'], other: ['其他', 'Other'],
};

function SearchIcon({ kind }: { kind: CanvasNodeSearchFilter | 'close' | 'enter' }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    {kind === 'all' ? <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></>
      : kind === 'image' ? <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m4 18 5-5 3 3 4-5 5 6" /></>
        : kind === 'video' ? <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m10 8 6 4-6 4Z" /></>
          : kind === 'audio' ? <><path d="M9 17V5l11-2v12M9 7l11-2" /><ellipse cx="6" cy="18" rx="3" ry="3" /><ellipse cx="17" cy="16" rx="3" ry="3" /></>
            : kind === 'group' ? <path d="M3 7V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v11H3V7Zm0 3h18" />
              : kind === 'note' ? <><path d="M5 3h10l4 4v14H5Z M14 3v5h5M8 12h8M8 16h6" /></>
                : kind === 'close' ? <path d="m6 6 12 12M6 18 18 6" />
                  : kind === 'enter' ? <path d="M20 5v8H5m5-5-5 5 5 5" />
                    : <path d="M5 6h14M5 12h14M5 18h9" />}
  </svg>;
}

function SearchThumbnail({ row, english }: { row: CanvasNodeSearchRow; english: boolean }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const canPreview = row.thumbnailUrl && row.thumbnailUrl !== failedUrl;
  return <span className={`canvas-search-preview${canPreview ? ' has-image' : ''}`} aria-hidden="true">
    {canPreview ? <img src={row.thumbnailUrl!} alt="" loading="lazy" decoding="async" draggable={false}
      onError={() => setFailedUrl(row.thumbnailUrl || null)} />
      : <SearchIcon kind={row.kind} />}
    {row.kind === 'video' && canPreview && <span className="canvas-search-video-badge" title={english ? 'Video' : '视频'}><SearchIcon kind="video" /></span>}
  </span>;
}

export function CanvasNodeSearchPanel({ rows, query, onQueryChange, onSelect, onClose, english = false, portalHost }: {
  rows: readonly CanvasNodeSearchRow[];
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (id: string) => void;
  onClose: () => void;
  english?: boolean;
  /** Untransformed canvas viewport, so sidebars never affect panel centering. */
  portalHost?: HTMLElement | null;
}) {
  const [filter, setFilter] = useState<CanvasNodeSearchFilter>('all');
  const [activeId, setActiveId] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null), input = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null);
  const backdropStart = useRef(false), composing = useRef(false);
  const ids = useId(), listId = `${ids}-results`, helpId = `${ids}-help`;
  const results = useMemo(() => filterCanvasNodeSearchRows(rows, query, filter), [rows, query, filter]);
  const activeIndex = Math.max(0, results.findIndex(row => row.id === activeId));
  const activeRow = results[activeIndex];
  const activeOptionId = activeRow ? `${ids}-option-${activeIndex}` : undefined;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);

  useEffect(() => { setActiveId(null); }, [query, filter]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [activeOptionId]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Canvas shortcuts must never act on the selected node while searching.
    event.stopPropagation();
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (event.key === 'Tab') {
      const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled):not([tabindex="-1"])') || []);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      return;
    }
    if (event.target !== input.current) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length) {
        const next = (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
        setActiveId(results[next].id);
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (activeRow) onSelect(activeRow.id);
    }
  };

  return createPortal(<div className={`canvas-search-overlay canvas-panel-overlay${portalHost ? ' is-canvas-relative' : ''} nodrag nopan nowheel`} role="presentation"
    onPointerDown={event => { backdropStart.current = event.target === event.currentTarget && event.button === 0; event.stopPropagation(); }}
    onPointerUp={event => { if (backdropStart.current && event.target === event.currentTarget) onClose(); backdropStart.current = false; event.stopPropagation(); }}
    onPointerCancel={() => { backdropStart.current = false; }}
    onClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    <section ref={panel} className="canvas-search-dialog" role="dialog" aria-modal="true"
      aria-label={english ? 'Search canvas nodes' : '搜索画布节点'} onKeyDown={onKeyDown}>
      <div className="canvas-search-field">
        <SearchIcon kind="all" />
        <input ref={input} type="text" role="combobox" value={query} autoComplete="off" spellCheck={false}
          aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-activedescendant={activeOptionId}
          aria-describedby={helpId} aria-label={english ? 'Search nodes by name or content' : '按名称或内容搜索节点'}
          placeholder={english ? 'Search nodes…' : '搜索节点…'}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
          onChange={event => onQueryChange(event.target.value)} />
        {query && <button type="button" className="canvas-search-clear" aria-label={english ? 'Clear search' : '清空搜索'}
          onClick={() => { onQueryChange(''); input.current?.focus(); }}><SearchIcon kind="close" /></button>}
        <button type="button" className="canvas-search-close" aria-label={english ? 'Close search' : '关闭搜索'} onClick={onClose}>Esc</button>
      </div>
      <div className="canvas-search-filters" role="group" aria-label={english ? 'Node type' : '节点类型'}>
        {FILTERS.map(kind => <button key={kind} type="button" aria-pressed={filter === kind}
          onClick={() => { setFilter(kind); input.current?.focus(); }}><SearchIcon kind={kind} /><span>{LABELS[kind][english ? 1 : 0]}</span></button>)}
      </div>
      <div ref={list} id={listId} className="canvas-search-results" role="listbox" aria-label={english ? 'Matching nodes' : '匹配节点'}>
        {results.map((row, index) => <button key={row.id} id={`${ids}-option-${index}`} type="button" role="option" tabIndex={-1}
          className="canvas-search-result" aria-selected={index === activeIndex} onMouseEnter={() => setActiveId(row.id)}
          onMouseDown={event => event.preventDefault()} onClick={() => onSelect(row.id)}>
          <SearchThumbnail row={row} english={english} />
          <span className="canvas-search-copy"><strong title={row.label}>{row.label}</strong>
            <small title={row.snippet || undefined}>{row.snippet?.trim().replace(/\s+/g, ' ') || (english ? 'No prompt or content yet' : '暂无提示词或正文')}</small></span>
          <span className="canvas-search-result-type">{LABELS[row.kind][english ? 1 : 0]}</span>
          <span className="canvas-search-enter"><SearchIcon kind="enter" /></span>
        </button>)}
      </div>
      {!results.length && <div className="canvas-search-empty" role="status"><SearchIcon kind="all" />
        <strong>{!rows.length ? english ? 'No nodes on this canvas' : '画布中还没有节点' : english ? 'No matching nodes' : '没有匹配的节点'}</strong>
        <span>{!rows.length ? english ? 'Add a node to find it here.' : '添加节点后，即可在这里搜索。' : english ? 'Try another keyword or node type.' : '试试其他关键词或节点类型。'}</span>
      </div>}
      <footer className="canvas-search-footer" id={helpId}>
        <span className="canvas-search-count" aria-live="polite">{english ? `${results.length} ${results.length === 1 ? 'node' : 'nodes'}` : `${results.length} 个节点`}</span>
        <span><kbd>↑</kbd><kbd>↓</kbd>{english ? 'Navigate' : '切换'}<kbd>↵</kbd>{english ? 'Locate' : '定位'}</span>
      </footer>
    </section>
  </div>, portalHost || document.body);
}
