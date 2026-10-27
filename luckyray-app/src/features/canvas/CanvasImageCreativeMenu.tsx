import { useId, useRef, useState } from 'react';
import { IMAGE_CREATIVE_ACTIONS, CREATIVE_RECIPE_OPTION_CHOICES, createCreativeRecipe, normalizeCreativeRecipe, type ImageCreativeActionId, type ImageCreativeRecipe, type CreativeRecipeOptionKey } from '../../core/canvas/imageCreativeActions';
import './canvasImageCreativeMenu.css';

const englishCopy: Record<ImageCreativeActionId, [string, string]> = {
  'story-grid': ['Story sequence', 'Continue the story as a single image grid.'],
  'blocking-board': ['Blocking sketch', 'Sketch movement, eyelines and camera direction.'],
  'multi-angle': ['Nine camera angles', 'Explore nine views of the same subject.'],
  'character-sheet': ['Character sheet', 'Keep identity across views and details.'],
  'scene-sheet': ['Scene sheet', 'Explore space, materials and scene details.'],
  'product-sheet': ['Product sheet', 'Explore product views and material details.'],
  'time-shift': ['Time shift', 'Imagine a moment just before or after.'],
  'relight': ['Relight', 'Change lighting while keeping the composition.'],
  'cinematic-grade': ['Film color', 'Explore cinematic color and contrast.'],
};
export function CreativeActionIcon({ id }: { id?: ImageCreativeActionId }) {
  const icon = IMAGE_CREATIVE_ACTIONS.find(a => a.id === id)?.icon;
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    {icon === 'grid' ? <><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 3v18M3 12h18"/></> :
    icon === 'blocking' ? <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="M8 11v5m-2-3 2-2 2 2m3-4h5m-2-2 2 2-2 2m-3 5h5"/></> :
    icon === 'camera' ? <><path d="M8 6l2-2h4l2 2h4v14H4V6h4Z"/><circle cx="12" cy="12" r="4"/><path d="M2 10V8m20 2V8"/></> :
    icon === 'character' ? <><circle cx="12" cy="7" r="3"/><path d="M6 21v-4a6 6 0 0 1 12 0v4M3 5v14m18-14v14"/></> :
    icon === 'scene' ? <><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m3 16 5-6 5 7 3-4 5 5"/><circle cx="16" cy="8" r="2"/></> :
    icon === 'product' ? <><path d="m12 3 9 5v9l-9 5-9-5V8l9-5Zm0 10 9-5M3 8l9 5v9M7 5.8l9 5"/></> :
    icon === 'time' ? <><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/><path d="M12 7v5l3 2"/></> :
    icon === 'light' ? <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></> :
    icon === 'film' ? <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16m10-16v16M3 9h4m-4 6h4m10-6h4m-4 6h4M12 8v8"/></> :
    <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><path d="M17.5 14v7M14 17.5h7"/></>}
  </svg>;
}
export type CanvasImageCreativeMenuProps = {
  onSelect: (recipe: ImageCreativeRecipe) => void;
  english?: boolean;
  currentId?: ImageCreativeActionId;
  context?: 'draft' | 'derive';
  hasImageReference?: boolean;
};
export function CanvasImageCreativeMenu({ onSelect, english = false, currentId, context = 'derive', hasImageReference = context === 'derive' }: CanvasImageCreativeMenuProps) {
  const picked = useRef(false);
  const groups = [['分镜叙事', '分镜', 'Story'], ['机位', '机位', 'Camera'], ['设定', '设定', 'Sheets'], ['质感', '光影', 'Light & color']] as const;
  const title = context === 'draft' ? (english ? 'Creative presets' : '创作预设') : (english ? 'Create from image' : '基于图片创作');
  const subtitle = context === 'draft' ? (currentId ? (english ? 'Switch preset' : '替换当前预设') : (english ? 'Use in this draft' : '应用到当前草稿')) : (english ? 'Draft first' : '先创建草稿');
  return <div className="canvas-image-creative-menu nodrag nopan nowheel" aria-label={title} onPointerDown={e => e.stopPropagation()}>
    <div className="canvas-image-creative-menu-title">{title}<span>{subtitle}</span></div>
    {groups.map(([group, label, en]) => <section key={group} aria-label={english ? en : label}>
      <h4>{english ? en : label}</h4><div className="canvas-image-creative-grid">
        {IMAGE_CREATIVE_ACTIONS.filter(a => a.group === group).map(action => {
          const needsImage = context === 'draft' && action.requiresImage && !hasImageReference;
          const description = english ? englishCopy[action.id][1] : action.description;
          return <button type="button" key={action.id} data-creative-action={action.id} aria-pressed={currentId === action.id} title={`${description}${needsImage ? (english ? ' Select now; add an image before generating.' : ' 可先选择，生成前请添加参考图。') : ''}`} onClick={() => { if (picked.current) return; const recipe = createCreativeRecipe(action.id); if (recipe) { picked.current = true; onSelect(recipe); } }}>
            <CreativeActionIcon id={action.id}/><span className="canvas-image-creative-action-copy"><span>{english ? englishCopy[action.id][0] : action.label}</span>{needsImage && <small>{english ? 'Image required' : '需参考图'}</small>}</span>
            {currentId === action.id && <svg className="canvas-image-creative-selected" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m3 8 3 3 7-7"/></svg>}
          </button>;
        })}
      </div>
    </section>)}
    <p>{context === 'draft' && !hasImageReference
      ? (english ? 'Add a description or reference image · Generate when ready' : '补充描述或参考图 · 调整后手动生成')
      : (english ? 'AI-guided image drafts · Generate when ready' : 'AI 提示词创作 · 调整后手动生成')}</p>
  </div>;
}
const optionLabels: Record<CreativeRecipeOptionKey, [string, string]> = { grid: ['布局', 'Layout'], direction: ['方向', 'Direction'], seconds: ['时间', 'Time'], lighting: ['光照', 'Lighting'], tone: ['色调', 'Color'] };
const englishOptions: Record<string, string> = { before: 'Before', after: 'After', 'soft-daylight': 'Soft daylight', 'golden-hour': 'Golden hour', 'neon-night': 'Neon night', studio: 'Studio', 'natural-film': 'Natural film', 'warm-vintage': 'Warm vintage', 'cool-suspense': 'Cool suspense', 'black-white': 'Black & white' };
export type CanvasCreativeRecipeEditorProps = {
  value?: ImageCreativeRecipe | null;
  onChange: (recipe: ImageCreativeRecipe | undefined) => void;
  onSwitchRequest?: (anchor: HTMLElement) => void;
  english?: boolean;
};
export function CanvasCreativeRecipeEditor({ value, onChange, onSwitchRequest, english = false }: CanvasCreativeRecipeEditorProps) {
  const [expanded, setExpanded] = useState(false);
  const regionId = useId();
  const recipe = normalizeCreativeRecipe(value);
  if (!recipe) return value ? <div className="canvas-creative-recipe"><button type="button" onClick={() => onChange(undefined)}>{english ? 'Remove unsupported creative recipe' : '移除不支持的创作设定'}</button></div> : null;
  const action = IMAGE_CREATIVE_ACTIONS.find(a => a.id === recipe.id)!;
  const isGrid = ['story-grid', 'blocking-board', 'multi-angle', 'character-sheet', 'scene-sheet', 'product-sheet'].includes(recipe.id);
  const summary = recipe.options.grid?.replace('x', ' × ') ?? (isGrid ? '3 × 3' : '');
  return <div className="canvas-creative-recipe nodrag nopan nowheel" onPointerDown={e => e.stopPropagation()}>
    <div className="canvas-creative-recipe-chip">
      <button type="button" className={onSwitchRequest ? 'canvas-creative-recipe-switch' : 'canvas-creative-recipe-expand'} aria-label={onSwitchRequest ? (english ? `Switch creative preset: ${englishCopy[recipe.id][0]}` : `切换创作预设：${action.label}`) : undefined} title={onSwitchRequest ? (english ? 'Switch creative preset' : '切换创作预设') : undefined} aria-expanded={onSwitchRequest ? undefined : expanded} aria-controls={onSwitchRequest ? undefined : regionId} onClick={e => { if (onSwitchRequest) { setExpanded(false); onSwitchRequest(e.currentTarget); } else setExpanded(v => !v); }}>
        <CreativeActionIcon id={recipe.id}/><span>{english ? englishCopy[recipe.id][0] : action.label}</span>{summary && <small>{summary}</small>}{!onSwitchRequest && <span aria-hidden="true">{expanded ? '⌃' : '⌄'}</span>}
      </button>
      {onSwitchRequest && <button type="button" className="canvas-creative-recipe-settings" aria-label={english ? (action.options.length ? 'Adjust preset options' : 'View preset details') : (action.options.length ? '调整创作预设选项' : '查看创作预设说明')} title={english ? 'Preset options and details' : '预设选项与说明'} aria-expanded={expanded} aria-controls={regionId} onClick={() => setExpanded(v => !v)}><svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={expanded ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'}/></svg></button>}
      <button type="button" className="canvas-creative-recipe-remove" aria-label={english ? 'Remove creative recipe' : '移除创作预设'} title={english ? 'Keep your prompt' : '保留补充提示词'} onClick={() => onChange(undefined)}>×</button>
    </div>
    {expanded && <div id={regionId} className="canvas-creative-recipe-options">
      {action.options.map(key => <label key={key}><span>{optionLabels[key][english ? 1 : 0]}</span><select value={recipe.options[key]} onChange={e => {
        const next = createCreativeRecipe(recipe.id, { ...recipe.options, [key]: key === 'seconds' ? Number(e.target.value) : e.target.value });
        if (next) onChange(next);
      }}>{CREATIVE_RECIPE_OPTION_CHOICES[key].map(choice => <option key={choice.value} value={choice.value}>{key === 'grid' ? String(choice.value).replace('x', ' × ') : english ? (englishOptions[String(choice.value)] ?? `${choice.value} sec`) : choice.label}</option>)}</select></label>)}
      <p>{english ? `${isGrid ? 'One image with a grid. ' : ''}AI prompt guidance; results vary. No true 3D reconstruction.` : `${isGrid ? '宫格合成在一张图内。' : ''}通过 AI 提示词引导，效果依模型而定，不是真实三维重建。`}</p>
    </div>}
  </div>;
}
