import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useViewport } from '@xyflow/react';
import { imageResultsStripLayout, type CanvasResultImage } from '../../core/canvas/imageResults';
import { CanvasSharpImage } from './CanvasSharpImage';
import './CanvasImageResults.css';

type Props = {
  items: readonly CanvasResultImage[];
  selected?: boolean;
  english?: boolean;
  fallback: string;
  resolveUrl: (url?: string | null) => string;
  onSelectPrimary: (sourceIndex: number) => void;
  onDimensions?: (width: number, height: number) => void;
};

/** The collapsed card always shows source index zero, which is the persisted primary. */
export function CanvasImageResults({ items, selected, english, fallback, resolveUrl, onSelectPrimary, onDimensions }: Props) {
  const [expanded, setExpanded] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState({ previous: false, next: false });
  const updateScrollState = () => {
    const element = strip.current;
    if (element) setScrollState({ previous: element.scrollLeft > 1, next: element.scrollLeft + element.clientWidth < element.scrollWidth - 1 });
  };
  const navigate = (direction: number) => {
    const element = strip.current;
    if (!element) return;
    const step = (element.firstElementChild as HTMLElement | null)?.offsetWidth || element.clientWidth;
    element.scrollBy({ left: direction * (step + 12), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  };
  const choicesId = useId();
  const viewport = useViewport();
  const [stripLayout, setStripLayout] = useState<ReturnType<typeof imageResultsStripLayout> | null>(null);
  useLayoutEffect(() => {
    if (!expanded || !root.current) return;
    const element = root.current;
    const stage = element.closest('.react-flow') || element.closest('.canvas-editor-stage');
    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0) return;
      const stageRect = stage?.getBoundingClientRect();
      const zoom = element.offsetWidth > 0 ? rect.width / element.offsetWidth : viewport.zoom;
      setStripLayout(imageResultsStripLayout({
        rootLeft: rect.left, rootWidth: rect.width, zoom, count: items.length,
        viewportLeft: Math.max(0, stageRect?.left || 0),
        viewportRight: Math.min(window.innerWidth, stageRect && stageRect.width > 0 ? stageRect.right : window.innerWidth),
      }));
    };
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    if (stage) observer?.observe(stage);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [expanded, items.length, viewport.x, viewport.y, viewport.zoom]);
  useLayoutEffect(() => {
    if (!expanded || !strip.current) return;
    const element = strip.current;
    updateScrollState();
    const wheel = (event: WheelEvent) => {
      // Preserve pinch-to-zoom. Wheel browsing is local to an overflowing result strip.
      if (event.ctrlKey || element.scrollWidth <= element.clientWidth + 1) return;
      event.preventDefault();
      event.stopPropagation();
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1;
      element.scrollLeft += delta * unit;
    };
    element.addEventListener('wheel', wheel, { passive: false });
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateScrollState) : null;
    observer?.observe(element);
    return () => { element.removeEventListener('wheel', wheel); observer?.disconnect(); };
  }, [expanded, stripLayout]);
  const signature = JSON.stringify(items.map(item => item.url));
  useEffect(() => { setExpanded(false); }, [signature]);
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setExpanded(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setExpanded(false);
      toggle.current?.focus();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
    };
  }, [expanded]);
  if (!items.length) return null;
  const multiple = items.length > 1;
  return <div ref={root} data-stack-depth={Math.min(2, items.length - 1)} className={`canvas-image-results${multiple ? ' is-stacked' : ''}${expanded ? ' is-expanded nodrag nopan nowheel' : ''}`}>
    <div className="canvas-image-results-frame" style={expanded && stripLayout ? { left: stripLayout.left, width: stripLayout.width, "--results-item-width": `${stripLayout.itemWidth}px` } as CSSProperties : undefined}>
    <div ref={strip} id={choicesId} className="canvas-image-results-strip" onScroll={updateScrollState} tabIndex={expanded ? 0 : undefined} role={expanded ? 'group' : undefined} aria-label={expanded ? (english ? 'Image results. Use left and right arrows to browse.' : '图片结果，使用左右方向键浏览') : undefined}
      onKeyDown={event => { if (expanded && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) { event.preventDefault(); event.stopPropagation(); navigate(event.key === 'ArrowLeft' ? -1 : 1); } }}>
      {(expanded ? items : items.slice(0, 1)).map((item, sourceIndex) => <div className="canvas-image-result-choice" key={`${sourceIndex}:${item.url}`} data-result-image-index={sourceIndex}>
        <CanvasSharpImage source={resolveUrl(item.url)} preview={resolveUrl(item.thumbnailUrl)} alt={english ? `Generated image ${sourceIndex + 1}` : `生成图片 ${sourceIndex + 1}`} selected={selected} fallback={fallback} onDimensions={sourceIndex === 0 ? onDimensions : undefined} />
        {expanded ? <button type="button" className="canvas-image-result-primary nodrag nopan" aria-pressed={sourceIndex === 0}
          onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
          onClick={event => { event.stopPropagation(); if (sourceIndex !== 0) onSelectPrimary(sourceIndex); setExpanded(false); toggle.current?.focus(); }}>
          {sourceIndex === 0 ? (english ? 'Main image' : '主图') : (english ? 'Set as main' : '设为主图')}
        </button> : null}
      </div>)}
    </div>
    {expanded && (scrollState.previous || scrollState.next) ? <>
      <button type="button" className="canvas-image-results-nav is-previous nodrag nopan" disabled={!scrollState.previous} aria-label={english ? 'Previous images' : '上一张图片'} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); navigate(-1); }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m10 3-5 5 5 5" /></svg></button>
      <button type="button" className="canvas-image-results-nav is-next nodrag nopan" disabled={!scrollState.next} aria-label={english ? 'Next images' : '下一张图片'} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); navigate(1); }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg></button>
    </> : null}
    {multiple ? <button ref={toggle} type="button" className="canvas-image-results-count nodrag nopan" aria-expanded={expanded} aria-controls={choicesId}
      aria-label={english ? `${expanded ? 'Collapse' : 'Expand'} ${items.length} images` : `${expanded ? '收起' : '展开'} ${items.length} 张图片`}
      onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); setExpanded(value => !value); }}>
      <span>{english ? `${items.length} images` : `${items.length} 张`}</span>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d={expanded ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'} /></svg>
    </button> : null}
    </div>
  </div>;
}
