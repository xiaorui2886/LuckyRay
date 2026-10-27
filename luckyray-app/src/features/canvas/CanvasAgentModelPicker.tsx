import './canvasAgentModelPicker.css';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CanvasAgentModels, CanvasAgentModelSelection } from '../../core/canvas/agent/types';

export type CanvasAgentModelPickerProps = {
  models?: CanvasAgentModels | null;
  selectedModel?: CanvasAgentModelSelection | null;
  disabled?: boolean;
  error?: string;
  english?: boolean;
  onSelect?: (model: CanvasAgentModelSelection | null) => void;
  onRefresh?: () => void;
};
const keyOf = (model: CanvasAgentModelSelection | null | undefined) => model ? JSON.stringify([model.provider, model.model]) : '';

/** Uses the live LSH catalog; never advertises a model from a static UI list. */
export function CanvasAgentModelPicker({ models, selectedModel, disabled, error, english, onSelect, onRefresh }: CanvasAgentModelPickerProps) {
  const [open, setOpen] = useState<'model' | 'strength' | null>(null);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), strengthTrigger = useRef<HTMLButtonElement>(null), popover = useRef<HTMLDivElement>(null);
  const id = useId();
  const selectedKey = keyOf(selectedModel);
  const available = models?.available || [];
  const effective = selectedModel || models?.defaultModel;
  const effectiveEntry = available.find(item => keyOf(item) === keyOf(effective));
  const reasoning = effectiveEntry?.reasoning;
  const effort = selectedModel?.reasoningEffort ?? (!selectedModel ? models?.defaultModel?.reasoningEffort : undefined);
  const staleEffort = !!effort && !reasoning?.efforts.some(item => item.id === effort);
  const stale = !!selectedModel && !!models && !available.some(item => keyOf(item) === selectedKey);
  const label = effective?.model || (english ? 'Choose model' : '选择模型');
  const effortName = (item: {id: string; name: string}) => english ? item.name : ({off:'关闭',minimal:'最低',low:'低',medium:'中',high:'高',max:'最高',xhigh:'超高'}[item.id] || item.name);
  const effortLabel = staleEffort ? english ? 'Unavailable' : '已失效' : reasoning?.efforts.find(item => item.id === effort);
  const strengthLabel = typeof effortLabel === 'object' ? effortName(effortLabel) : effortLabel || (english ? 'Auto' : '默认');
  const close = (focus = false) => { setOpen(null); if (focus) (open === 'strength' ? strengthTrigger : trigger).current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(null); };
    document.addEventListener('pointerdown', outside, true);
    const target = popover.current?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]:not(:disabled)') || popover.current?.querySelector<HTMLButtonElement>('[role="option"]:not(:disabled)');
    target?.focus();
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const panel = root.current?.closest<HTMLElement>('.canvas-r1-agent-panel');
    const fit = () => {
      if (!popover.current) return;
      const top = Math.max(0, panel?.getBoundingClientRect().top || 0);
      // Menus open above the composer and stay inside the actual panel, including
      // short windows/fullscreen. No OS popup, portal or model behavior change.
      popover.current.style.maxHeight = `${Math.max(0, Math.min(360, popover.current.getBoundingClientRect().bottom - top - 8))}px`;
    };
    fit();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    if (panel) observer?.observe(panel);
    window.addEventListener('resize', fit);
    return () => { observer?.disconnect(); window.removeEventListener('resize', fit); };
  }, [open]);
  useEffect(() => { if (disabled || !onSelect) setOpen(null); }, [disabled, onSelect]);
  useEffect(() => { if (!reasoning || !effective) setOpen(value => value === 'strength' ? null : value); }, [reasoning, effective]);
  const pick = (model: CanvasAgentModelSelection | null) => { if (disabled) return; onSelect?.(model); close(true); };
  return <div className="canvas-agent-model-picker" ref={root} onKeyDown={event => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (!open) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === 'Tab') { close(true); return; }
    const options = [...(popover.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') || [])];
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    const target = event.key === 'ArrowDown' ? (index + 1) % options.length : event.key === 'ArrowUp' ? (index - 1 + options.length) % options.length : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : -1;
    if (target >= 0 && options[target]) { event.preventDefault(); event.stopPropagation(); options[target].focus(); }
  }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(null); }}>
    <button type="button" ref={trigger} className={`canvas-agent-model-trigger${stale || error ? ' has-warning' : ''}`} disabled={disabled || !onSelect}
      aria-label={english ? `Thinking model: ${label}` : `思考模型：${label}`} aria-haspopup="listbox" aria-expanded={open === 'model'} aria-controls={id}
      title={effectiveEntry?.label || (effective ? `${effective.provider} · ${effective.model}` : english ? 'Choose an LSH thinking model' : '选择 LSH 思考模型')}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen('model'); } }}
      onClick={() => setOpen(value => value === 'model' ? null : 'model')}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z" /></svg>
      <span className="canvas-agent-model-kind">{english ? 'Think' : '思考'}</span><strong>{label}</strong>
      <svg className="canvas-agent-model-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4" /></svg>
    </button>
    {reasoning && effective && <button type="button" ref={strengthTrigger} className={`canvas-agent-strength${staleEffort ? ' has-warning' : ''}`}
      aria-label={english ? 'Reasoning strength' : '思考强度'} title={english ? 'Reasoning strength' : '思考强度'}
      aria-haspopup="listbox" aria-expanded={open === 'strength'} aria-controls={`${id}-strength`} disabled={disabled || !onSelect}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen('strength'); } }}
      onClick={() => setOpen(value => value === 'strength' ? null : 'strength')}>
      <span>{strengthLabel}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4" /></svg>
    </button>}
    {open === 'strength' && reasoning && effective && <div className="canvas-agent-strength-popover" ref={popover}>
      <div className="canvas-agent-model-heading"><strong>{english ? 'Reasoning strength' : '思考强度'}</strong></div>
      <div className="canvas-agent-model-options" role="listbox" id={`${id}-strength`} aria-label={english ? 'Reasoning strengths' : '思考强度选项'}>
        <button type="button" role="option" data-effort="" aria-selected={!effort} onClick={() => pick({provider:effective.provider,model:effective.model})}><span><strong>{english ? 'Auto' : '默认'}</strong></span><span aria-hidden="true">{!effort ? '✓' : ''}</span></button>
        {staleEffort && <button type="button" role="option" data-effort={effort} aria-selected="true" disabled><span><strong>{english ? 'Unavailable' : '已失效'}</strong></span></button>}
        {reasoning.efforts.map(item => <button type="button" key={item.id} role="option" data-effort={item.id} aria-selected={effort === item.id} title={item.description} onClick={() => pick({provider:effective.provider,model:effective.model,reasoningEffort:item.id})}>
          <span><strong>{effortName(item)}</strong></span><span aria-hidden="true">{effort === item.id ? '✓' : ''}</span>
        </button>)}
      </div>
    </div>}
    {open === 'model' && <div className="canvas-agent-model-popover" ref={popover}>
      <div className="canvas-agent-model-heading"><strong>{english ? 'Thinking model' : '思考模型'}</strong>{onRefresh && <button type="button" onClick={onRefresh} aria-label={english ? 'Refresh model list' : '刷新模型列表'}>{english ? 'Refresh' : '刷新'}</button>}</div>
      <div className="canvas-agent-model-options" role="listbox" id={id} aria-label={english ? 'LSH models' : 'LSH 模型'}>
        <button type="button" role="option" aria-selected={!selectedModel} disabled={!models?.defaultModel} onClick={() => pick(null)}>
          <span><strong>{english ? 'Follow LSH' : '跟随 LSH'}</strong><small>{models?.defaultModel ? `${models.defaultModel.provider} · ${models.defaultModel.model}` : english ? 'No default model configured' : '尚未配置默认模型'}</small></span><span aria-hidden="true">{!selectedModel ? '✓' : ''}</span>
        </button>
        {available.map(model => <button type="button" key={keyOf(model)} role="option" aria-selected={selectedKey === keyOf(model)} onClick={() => pick({provider:model.provider, model:model.model})}>
          <span><strong>{model.model}</strong><small>{model.provider}{model.inputModalities.includes('image') ? english ? ' · Image input' : ' · 支持图片输入' : ''}</small></span><span aria-hidden="true">{selectedKey === keyOf(model) ? '✓' : ''}</span>
        </button>)}
      </div>
      {(stale || error || !available.length) && <p className="canvas-agent-model-notice" role="status">{stale ? english ? 'The selected model is unavailable. Choose another model.' : '原模型已不可用，请重新选择。' : error ? english ? 'Could not load models. Refresh to retry.' : '模型列表未能加载，请刷新重试。' : english ? 'Configure a model in LSH, then refresh.' : '先在 LSH 配置模型，再刷新这里。'}</p>}
      <p className="canvas-agent-model-note">{english ? 'For conversation and planning. Image and video generation use your canvas configuration.' : '用于对话与规划；生图和视频沿用画布模型配置。'}</p>
    </div>}
  </div>;
}
