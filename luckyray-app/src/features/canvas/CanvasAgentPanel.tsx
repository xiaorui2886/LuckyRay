import { CanvasAgentTurnRail, type CanvasAgentRailEntry } from './CanvasAgentTurnRail';
import { useCanvasReducedMotion } from './CanvasMotionContext';
import { CanvasAgentMessageView, CanvasAgentTurnView } from './CanvasAgentConversation';
import { CanvasAgentBlackHole } from './CanvasAgentBlackHole';
import { CanvasAgentOrb } from './CanvasAgentOrb';
import { CanvasAgentModelPicker, type CanvasAgentModelPickerProps } from './CanvasAgentModelPicker';
import { CanvasReferencePreview } from './CanvasReferencePreview';
import { CanvasHoverVideo } from './CanvasHoverVideo';
import { Component, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ErrorInfo, type ReactNode, type RefObject } from 'react';
import type { CanvasAgentExecution, CanvasAgentPlan, CanvasAgentSnapshot } from '../../core/canvas/agent/types';
import './canvasAgentPanel.css';

export type CanvasAgentContextChip = {
  id: string;
  title: string;
  kind: 'text' | 'image' | 'video' | 'note' | 'group';
  /** Display-ready image or video poster URL; never the video itself. */
  thumbnailUrl?: string | null;
  /** Full image for the hover only. */
  previewUrl?: string | null;
  /** Video playback source for the hover only; never changes the Agent input. */
  videoUrl?: string | null;
  /** Bounded, human-readable text content for a reference preview. */
  previewText?: string;
};

export type CanvasAgentPanelProps = {
  models?: CanvasAgentModelPickerProps['models'];
  selectedModel?: CanvasAgentModelPickerProps['selectedModel'];
  onSelectModel?: CanvasAgentModelPickerProps['onSelect'];
  modelsError?: string;
  modelSelectionUnavailable?: boolean;
  modelSelectionLocked?: boolean;
  canvasName: string;
  snapshot: CanvasAgentSnapshot | null;
  contextChips: readonly CanvasAgentContextChip[];
  execution: CanvasAgentExecution | null;
  busy: boolean;
  error?: string | null;
  english?: boolean;
  availability?: 'ready' | 'checking' | 'unavailable';
  availabilityMessage?: string;
  /** A stable canvas ID. Drafts are kept separately per canvas, including after closing. */
  draftKey?: string;
  /** Translate transport error codes at the integration boundary, without exposing traces. */
  formatError?: (message: string) => string;
  /** Resolve false or reject when sending fails. The user's draft is retained. */
  onSend: (prompt: string, execution?: { mode: 'plan' | 'autonomous'; allowGeneration: boolean; maxMediaJobs: number }) => unknown | Promise<unknown>;
  /** Cancels whichever planning or canvas execution operation is active. */
  onCancel: () => unknown | Promise<unknown>;
  /** Resolve false or reject if nothing was applied; successful plans cannot be applied twice. */
  onApply: (plan: CanvasAgentPlan, generate: boolean) => unknown | Promise<unknown>;
  onLocate: (nodeId: string) => void;
  /** Live results verified against this canvas by the integration boundary. */
  executionNodeIds?: readonly string[];
  onLocateExecution?: (execution: CanvasAgentExecution, nodeId?: string) => void;
  onRemoveContext: (id: string) => void;
  onPickContext?: () => void;
  pickingContext?: boolean;
  /** Re-read existing session status. This must not start a model turn. */
  onRefresh?: () => void;
  onNewConversation?: () => Promise<unknown>;
  conversations?: readonly { conversationId: string; sessionId: string | null; title: string; updatedAt: number; messageCount: number }[];
  historyLoading?: boolean;
  historyError?: string | null;
  onLoadConversations?: () => unknown | Promise<unknown>;
  onSelectConversation?: (conversationId: string) => Promise<unknown>;
  rotationPending?: boolean;
  onClose: () => void;
  onCollapsedChange?: (collapsed: boolean) => void;
};

type IconKind = CanvasAgentContextChip['kind'] | 'spark' | 'close' | 'collapse' | 'expand' | 'arrow' | 'plus' | 'chevron' | 'locate' | 'check' | 'stop' | 'warning' | 'history';
function AgentIcon({ kind }: { kind: IconKind }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    {kind === 'spark' ? <><path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z" /><path d="m20 2 .6 1.4L22 4l-1.4.6L20 6l-.6-1.4L18 4l1.4-.6Z" /></>
      : kind === 'image' ? <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m4 18 5-5 3 3 4-5 5 6" /></>
        : kind === 'video' ? <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m10 8 6 4-6 4Z" /></>
          : kind === 'group' ? <path d="M3 7V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v11H3V7Zm0 3h18" />
            : kind === 'note' ? <><path d="M5 3h10l4 4v14H5ZM14 3v5h5M8 12h8M8 16h6" /></>
              : kind === 'close' ? <path d="m6 6 12 12M6 18 18 6" />
                : kind === 'collapse' ? <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M15 4v16m-6-11 3 3-3 3" /></>
                  : kind === 'expand' ? <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16m7-11-3 3 3 3" /></>
                    : kind === 'arrow' ? <path d="M12 19V5m-6 6 6-6 6 6" />
                      : kind === 'history' ? <><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6M12 7v5l3 2" /></>
                      : kind === 'plus' ? <path d="M12 5v14M5 12h14" />
                        : kind === 'chevron' ? <path d="m8 10 4 4 4-4" />
                        : kind === 'locate' ? <><rect x="6" y="6" width="12" height="12" rx="3" /><path d="M12 2v5m0 10v5M2 12h5m10 0h5" /></>
                          : kind === 'check' ? <path d="m5 12 4 4L19 6" />
                            : kind === 'stop' ? <rect x="6" y="6" width="12" height="12" rx="2" />
                              : kind === 'warning' ? <><path d="m12 3 10 18H2ZM12 9v5" /><circle cx="12" cy="17.5" r=".5" /></>
                                : <path d="M5 6h14M5 12h14M5 18h9" />}
  </svg>;
}

function ExecutionLocateButton({ label, tooltip, disabled, onClick }: {
  label: string; tooltip: string; disabled: boolean; onClick: () => void;
}) {
  const id = useId();
  return <span className="canvas-agent-result-locate">
    <button type="button" className="canvas-r1-agent-icon-button" disabled={disabled}
      aria-label={label} aria-describedby={id} onClick={onClick}><AgentIcon kind="locate" /></button>
    <span id={id} role="tooltip" className="canvas-agent-result-tooltip">{tooltip}</span>
  </span>;
}

function ContextThumbnail({ chip }: { chip: CanvasAgentContextChip }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return <span className="canvas-r1-agent-context-thumb" aria-hidden="true">
    {chip.thumbnailUrl && chip.thumbnailUrl !== failedUrl
      ? <img src={chip.thumbnailUrl} alt="" draggable={false} loading="lazy" decoding="async" onError={() => setFailedUrl(chip.thumbnailUrl || null)} />
      : chip.previewText && chip.kind !== 'image' && chip.kind !== 'video' ? <span className="canvas-r1-agent-text-thumbnail">{chip.previewText.slice(0, 90)}</span> : <AgentIcon kind={chip.kind} />}
    {chip.kind === 'video' && chip.thumbnailUrl && chip.thumbnailUrl !== failedUrl && <span className="canvas-r1-agent-video-badge"><AgentIcon kind="video" /></span>}
  </span>;
}

function ContextPreview({ chip, english, active }: { chip: CanvasAgentContextChip; english: boolean; active: boolean }) {
  const media = chip.kind === 'image' || chip.kind === 'video';
  const source = chip.previewUrl || chip.videoUrl || chip.thumbnailUrl;
  const [dimensions, setDimensions] = useState<{ source: typeof source; ratio: number }>();
  const aspect = dimensions && dimensions.source === source ? dimensions.ratio : 4 / 3;
  const measure = (width: number, height: number) => {
    if (width > 0 && height > 0) setDimensions(current => current && current.source === source && current.ratio === width / height ? current : {source, ratio: width / height});
  };
  const label = (english ? {image:'Image',video:'Video',text:'Text',note:'Note',group:'Group'} : {image:'图片',video:'视频',text:'文本',note:'笔记',group:'分组'})[chip.kind];
  return <div className={`canvas-r1-agent-reference-preview is-${chip.kind}${active ? ' is-active' : ''}`} role="tooltip"
    style={media ? {width:`calc(var(--agent-preview-media-height, 190px) * ${aspect} + 14px)`, '--agent-preview-media-aspect':aspect} as CSSProperties : undefined}>
    {media ? <div className="canvas-r1-agent-reference-media" onLoadCapture={event => { if (chip.kind === 'image' && event.target instanceof HTMLImageElement) measure(event.target.naturalWidth, event.target.naturalHeight); }}>
      {chip.kind === 'video' && active ? <CanvasHoverVideo key={chip.videoUrl} source={chip.videoUrl} poster={chip.thumbnailUrl} label={chip.title} unavailable={english ? 'Preview unavailable' : '预览不可用'} onDimensions={measure} /> : <CanvasReferencePreview
      thumbnail={chip.kind === 'image' ? chip.previewUrl || chip.thumbnailUrl : chip.thumbnailUrl}
      original={chip.kind === 'image' && chip.previewUrl ? chip.thumbnailUrl : undefined}
      label={chip.title} unavailable={english ? 'Preview unavailable' : '预览不可用'}
    />}</div> : <p>{chip.previewText?.slice(0, 1200) || (english ? 'No text preview' : '暂无正文预览')}</p>}
    <small className="canvas-r1-agent-reference-kind">{label}</small>
  </div>;
}

const STARTERS = [
  { kind: 'image' as const, zh: '构思一组图片', en: 'Explore an image series', zhHint: '风格、构图与视觉方向', enHint: 'Style, composition and direction', zhPrompt: '参考选中的素材，帮我构思一组风格统一的图片，先给出创作方案。', enPrompt: 'Use the selected references to plan a cohesive image series. Show me the creative plan first.' },
  { kind: 'video' as const, zh: '把灵感变成短片', en: 'Turn an idea into a film', zhHint: '从画面到镜头运动', enHint: 'From images to camera movement', zhPrompt: '参考选中的素材，帮我设计一支短片的镜头和视频提示词，先给出创作方案。', enPrompt: 'Use the selected references to plan a short film, including shots and video prompts. Show me the plan first.' },
  { kind: 'text' as const, zh: '展开故事与分镜', en: 'Develop a story', zhHint: '梳理剧本、场景与节奏', enHint: 'Script, scenes and pacing', zhPrompt: '根据选中的内容，帮我展开故事、整理剧本并拆成分镜，先给出创作方案。', enPrompt: 'Develop the selected content into a story, script and shot list. Show me the creative plan first.' },
];

const MAX_DRAFT_LENGTH = 48000;
const draftCache = new Map<string, string>();
function readDraft(key: string | undefined): string {
  if (!key) return '';
  if (draftCache.has(key)) return draftCache.get(key)!;
  try { return (window.localStorage.getItem(`luckyray.canvasAgent.draft.v1:${key}`) || '').slice(0, MAX_DRAFT_LENGTH); } catch { return ''; }
}
function saveDraft(key: string | undefined, draft: string) {
  if (!key) return;
  const bounded = draft.slice(0, MAX_DRAFT_LENGTH);
  draftCache.delete(key); draftCache.set(key, bounded);
  if (draftCache.size > 20) draftCache.delete(draftCache.keys().next().value!);
  try {
    if (bounded) window.localStorage.setItem(`luckyray.canvasAgent.draft.v1:${key}`, bounded);
    else window.localStorage.removeItem(`luckyray.canvasAgent.draft.v1:${key}`);
  } catch { /* The bounded in-memory copy still survives closing and reopening the panel. */ }
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

/** The transcript is prose only. Structured plans have their own reviewable card. */
function readableAssistantMessage(text: string): string | null {
  const candidate = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!candidate.startsWith('{') && !candidate.startsWith('[')) return text;
  try { const parsed: unknown = JSON.parse(candidate); if (parsed && typeof parsed === 'object') return null; } catch { /* Ordinary prose may start with a bracket. */ }
  return text;
}

type CanvasAgentDiagnostic = { autonomous: boolean; allowGeneration: boolean };
function safeRenderDiagnostic(error: unknown, info: ErrorInfo) {
  const message = error instanceof Error ? error.message : '';
  // Only known JavaScript/React failure shapes survive. Never log arbitrary exception text.
  const category = /Cannot read properties of (null|undefined)/.exec(message)?.[0]
    || (/is not a function/.test(message) ? 'Value is not a function' : '')
    || (/Objects are not valid as a React child/.test(message) ? 'Invalid React child' : '')
    || (/Maximum update depth exceeded/.test(message) ? 'Maximum update depth exceeded' : '')
    || (/Rendered (more|fewer) hooks/.test(message) ? 'Hook count changed' : '')
    || 'Unclassified render exception (message redacted)';
  const componentStack = [...(info.componentStack || '').matchAll(/at (Canvas[A-Za-z0-9_]+|ContextThumbnail|ContextPreview|ReasoningDisclosure)\b/g)].map(match => match[1]).slice(0, 12);
  return { message: category, componentStack };
}
type CanvasAgentBoundaryState = { failed: boolean; code: string };
/** Keep a render failure in the Agent from unmounting the entire canvas/application. */
class CanvasAgentRenderBoundary extends Component<{ children: ReactNode; english?: boolean; running: boolean; hasSession: boolean; diagnostic: RefObject<CanvasAgentDiagnostic>; onCancel: () => unknown | Promise<unknown> }, CanvasAgentBoundaryState> {
  state: CanvasAgentBoundaryState = { failed: false, code: '' };
  static getDerivedStateFromError(error: unknown): CanvasAgentBoundaryState {
    return { failed: true, code: error instanceof TypeError ? 'LR_CANVAS_UI_TYPE' : 'LR_CANVAS_UI_RENDER' };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.warn('[LuckyRay Canvas Agent]', this.state.code, { ...safeRenderDiagnostic(error, info), phase: this.props.running ? 'running' : 'idle', hasSession: this.props.hasSession, ...this.props.diagnostic.current });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    const { english, running, onCancel } = this.props;
    return <aside className="canvas-r1-agent-panel canvas-agent-recovery nodrag nopan nowheel" aria-label={english ? 'Canvas Agent' : '画布 Agent'} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      <div className="canvas-r1-agent-error" role="alert"><div>
        <strong>{english ? 'The conversation view needs to recover' : '对话界面需要恢复'}</strong>
        <p>{english ? 'Only this conversation view is affected. A running task may continue; you can stop it below. Recovery does not resend or authorize generation.' : '仅此对话界面需要恢复。正在执行的任务可能继续，可在下方停止；恢复不会重发请求或自动授权生成。'}</p>
        <small>{this.state.code}</small>
        <button type="button" onClick={() => this.setState({ failed: false, code: '' })}>{english ? 'Restore conversation' : '恢复对话'}</button>
        {running && <button type="button" onClick={() => { void Promise.resolve().then(onCancel).catch(() => {}); }}>{english ? 'Stop current task' : '停止当前任务'}</button>}
      </div></div>
    </aside>;
  }
}

export function CanvasAgentPanel(props: CanvasAgentPanelProps) {
  const diagnostic = useRef<CanvasAgentDiagnostic>({ autonomous: true, allowGeneration: false });
  // A canvas change must never save the previous canvas's draft under a new key.
  return <CanvasAgentRenderBoundary key={props.draftKey} english={props.english} diagnostic={diagnostic} hasSession={!!props.snapshot?.sessionId} running={props.busy || props.snapshot?.status === 'running' || props.execution?.status === 'running'} onCancel={props.onCancel}>
    <CanvasAgentPanelContent {...props} diagnostic={diagnostic} />
  </CanvasAgentRenderBoundary>;
}

function containsEventTarget(element: Element, target: EventTarget | null): boolean {
  return target instanceof Node && element.contains(target);
}

/** Avoid native details/display-lock during mouse selection (WebView2 renderer crash).
 * Dismiss after click, or after keyboard Tab completes; a null blur destination is
 * not evidence of leaving the popup (labels and native select controls can emit it).
 */
function useCanvasAgentPopover() {
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (root.current && !containsEventTarget(root.current, event.target)) setOpen(false);
    };
    const tab = (event: KeyboardEvent) => {
      if (event.key === 'Tab' && root.current && document.activeElement && !root.current.contains(document.activeElement)) setOpen(false);
    };
    document.addEventListener('click', outside, true);
    document.addEventListener('keyup', tab, true);
    return () => { document.removeEventListener('click', outside, true); document.removeEventListener('keyup', tab, true); };
  }, [open]);
  return { root, trigger, open, setOpen, id };
}

/** Stable form subtree: granting permission never inserts/removes a focused budget input. */
function CanvasAgentRunSettings({ english, disabled, mode, allowGeneration, mediaBudget, onModeChange, onAllowGeneration, onBudgetChange }: {
  english: boolean; disabled: boolean;
  mode: 'plan' | 'autonomous'; allowGeneration: boolean; mediaBudget: number;
  onModeChange: (mode: 'plan' | 'autonomous') => void; onAllowGeneration: (allow: boolean) => void; onBudgetChange: (budget: number) => void;
}) {
  const budgetRow = useRef<HTMLLabelElement>(null);
  const allowed = mode === 'autonomous' && allowGeneration;
  const menu = useCanvasAgentPopover();
  return <div ref={menu.root} className="canvas-agent-run-settings" data-open={menu.open || undefined}
    onKeyDown={event => { if (menu.open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); menu.setOpen(false); menu.trigger.current?.focus(); } }}>
    <button ref={menu.trigger} type="button" className="canvas-agent-popover-trigger" aria-expanded={menu.open} aria-controls={menu.id} onClick={() => menu.setOpen(value => !value)}>{mode === 'autonomous' ? english ? 'Auto' : '自主创作' : english ? 'Plan only' : '仅规划'}<small hidden={!allowed}> · {english ? `${mediaBudget} jobs` : `${mediaBudget}次`}</small><AgentIcon kind="chevron" /></button>
    <div id={menu.id} hidden={!menu.open}>
      <label>{english ? 'Run mode' : '运行方式'}<select disabled={disabled} value={mode} onChange={event => { const value = event.currentTarget.value; if (value === 'autonomous' || value === 'plan') onModeChange(value); }}><option value="autonomous">{english ? 'Autonomous canvas editing' : '自主编辑画布'}</option><option value="plan">{english ? 'Plan only, no edits' : '仅规划，不修改'}</option></select></label>
      <label className="canvas-agent-generation-permission"><input type="checkbox" checked={allowed} disabled={disabled || mode !== 'autonomous'} onChange={event => {
        const checkbox = event.currentTarget, checked = checkbox.checked;
        if (!checked && budgetRow.current?.contains(document.activeElement)) checkbox.focus();
        onAllowGeneration(checked);
      }} />{english ? 'Allow media generation for this request' : '允许本轮生成图片／视频'}</label>
      <label ref={budgetRow} hidden={!allowed}>{english ? 'Maximum media jobs' : '本轮生成次数上限'}<input type="number" min="1" max="1000" step="1" value={mediaBudget} disabled={disabled || !allowed} onChange={event => { const value = Number(event.currentTarget.value); if (Number.isSafeInteger(value) && value > 0 && value <= 1000) onBudgetChange(value); }} /></label>
      <p>{mode === 'plan' ? english ? 'Agent prepares suggestions without changing the canvas.' : '仅讨论并整理方案，不修改画布。' : allowed ? english ? 'Uses your configured media models. Each job may incur provider charges. Stopping prevents further jobs; submitted jobs may still be billed.' : '使用已配置的媒体模型，每次生成可能产生费用。停止后不再提交新任务；已提交任务仍可能计费。' : english ? 'Agent can edit this canvas. Paid image and video generation is not authorized.' : '可按你的任务编辑此画布，不授权付费图片或视频生成。'}</p>
    </div>
  </div>;
}

function CanvasAgentPanelContent({
  canvasName, snapshot, contextChips, execution, busy, error, english = false,
  models, selectedModel, onSelectModel, modelsError, modelSelectionUnavailable, modelSelectionLocked,
  availability = 'ready', availabilityMessage, draftKey, formatError, onSend, onCancel, onApply, onLocate,
  executionNodeIds = [], onLocateExecution,
  onRemoveContext, onPickContext, pickingContext = false, onRefresh, onNewConversation, rotationPending=false, onCollapsedChange,
  diagnostic, conversations = snapshot?.conversations || [], historyLoading = false, historyError, onLoadConversations, onSelectConversation,
}: CanvasAgentPanelProps & { diagnostic: RefObject<CanvasAgentDiagnostic> }) {
  const panel = useRef<HTMLElement>(null);
  const composer = useRef<HTMLFormElement>(null);
  const transferFocus = useRef(false);
  const starterMenu = useCanvasAgentPopover(), historyMenu = useRef<HTMLDivElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false), [switchingConversation, setSwitchingConversation] = useState<string | null>(null);
  const [runMode, setRunMode] = useState<'plan' | 'autonomous'>('autonomous');
  const [allowGeneration, setAllowGeneration] = useState(false), [mediaBudget, setMediaBudget] = useState(1);
  useLayoutEffect(() => { diagnostic.current = { autonomous: runMode === 'autonomous', allowGeneration }; }, [diagnostic, runMode, allowGeneration]);
  const [unreadMessages, setUnreadMessages] = useState(false);
  const latestTranscript = useRef('');
  const [collapsed, setCollapsed] = useState(false);
  const [hoveredReference, setHoveredReference] = useState<string | null>(null);
  const [focusedReference, setFocusedReference] = useState<string | null>(null);
  const activeReference = collapsed ? null : hoveredReference || focusedReference;
  const toggleCollapsed = () => {
    transferFocus.current = true;
    const next = !collapsed; setCollapsed(next); onCollapsedChange?.(next);
  };
  const [draft, setDraft] = useState(() => readDraft(draftKey));
  const [sending, setSending] = useState(false);
  const [pendingSend, setPendingSend] = useState<{ text: string; index: number; scope: string; runId?: string | null } | null>(null);
  const [resetting,setResetting]=useState(false),[scrolledAway,setScrolledAway]=useState(false);
  const resetLock=useRef(false), historyLock=useRef(false);
  const [applying, setApplying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [localError, setLocalError] = useState('');
  const [appliedPlans, setAppliedPlans] = useState<Set<string>>(() => new Set());
  const reducedMotion = useCanvasReducedMotion();
  const textarea = useRef<HTMLTextAreaElement>(null), transcript = useRef<HTMLDivElement>(null);
  const processRunKeys = useRef(new Map<string,string>());
  const pendingProcess = useRef<{scope:string;runId:string|null|undefined;key:string}|null>(null);
  const sendLock = useRef(false), applyLock = useRef(false), cancelLock = useRef(false), composing = useRef(false);
  const mounted = useRef(true), stickToBottom = useRef(true);
  const id = useId();
  const plan = snapshot?.plan;
  const isPlanning = snapshot?.status === 'running';
  const isExecuting = execution?.status === 'running';
  const working = busy || resetting || !!switchingConversation || sending || applying || !!isPlanning || !!isExecuting;
  const canSend = availability === 'ready' && !working && !rotationPending && !modelSelectionUnavailable && !!draft.trim();
  const applied = !!plan && (appliedPlans.has(plan.id) || execution?.planId === plan.id);
  const problem = error || localError || snapshot?.error || (snapshot?.status === 'failed' ? 'canvas-agent-model-failed' : undefined);
  // Only a matching failed snapshot owns this detail. A later transport/action error
  // must not accidentally display a previous model failure.
  const runFailure = snapshot?.status === 'failed' && problem === (snapshot.error || 'canvas-agent-model-failed');
  const problemDetail = runFailure ? snapshot?.errorDetail?.message : undefined;
  const runFallback = english ? 'This request did not complete. No specific error reason was received.' : '本次请求未完成，未收到具体错误原因。';
  const problemMessage = problemDetail || (runFailure && ['canvas-agent-unavailable','canvas-agent-model-failed'].includes(problem || '') ? runFallback : undefined);
  const reconnectProblem = availability === 'unavailable' || !runFailure || ['canvas-agent-not-ready','canvas-agent-runtime-unavailable','canvas-agent-transport-busy'].includes(problem || '');
  const receiptNotice = problem === 'canvas-agent-start-unconfirmed' || problem === 'canvas-agent-start-recovered' || problem === 'canvas-agent-previous-request-recovered';
  const displayError = (message: string) => formatError ? formatError(message) : message;
  const preparingSend = sending && !!pendingSend && (pendingSend.scope === (snapshot?.conversationId || draftKey || 'canvas-agent') || (!pendingSend.runId && pendingSend.scope === (draftKey || 'canvas-agent'))) && (snapshot?.runId || null) === (pendingSend.runId || null) && (snapshot?.messages.length || 0) <= pendingSend.index;
  const messages = (snapshot?.messages || []).flatMap((message, index) => {
    const text = message.role === 'assistant' ? readableAssistantMessage(message.text) : message.text;
    return text?.trim() || message.reasoningText?.trim() ? [{ ...message, text: text || '', key: `${snapshot?.conversationId || draftKey || 'canvas-agent'}:${index}-${message.role}` }] : [];
  });
  if (preparingSend && pendingSend) messages.push({role:'user',text:pendingSend.text,key:`${pendingSend.scope}:${pendingSend.index}-user`});
  const stream = preparingSend ? undefined : snapshot?.stream;
  if ((stream?.text || stream?.reasoningText) && stream.status !== 'settled' && !messages.some(message => message.role === 'assistant' && message.attemptId && message.attemptId === stream.attemptId && message.turnId === stream.turnId)) {
    messages.push({ role: 'assistant', attemptId: stream.attemptId, text: stream.text, reasoningText: stream.reasoningText, reasoningStartedAt: stream.reasoningStartedAt, reasoningEndedAt: stream.reasoningEndedAt, reasoningDurationMs: stream.reasoningDurationMs, reasoningActiveStartedAt: stream.reasoningActiveStartedAt, key: `stream-${stream.attemptId}`, turnId:stream.turnId, createdAt:stream.startedAt, streaming: stream.status === 'streaming' } as typeof messages[number]);
  }
  const hasConversation = messages.length > 0 || !!plan || !!execution;
  const transcriptSignature = `${snapshot?.conversationId || ''}:${messages.map(message => `${message.role}:${message.text}:${message.reasoningText || ''}`).join('\n')}:${JSON.stringify(snapshot?.tools || [])}:${JSON.stringify(snapshot?.progress || [])}`;
  const hasRuntimeActivity = preparingSend || isPlanning || !!snapshot?.activity?.length || !!snapshot?.tools?.length || !!snapshot?.progress?.length || !!stream?.reasoning;
  const conversationTurns: {role:'user'|'assistant';key:string;turnId?:string;messages:typeof messages}[] = [];
  for (const message of messages) {
    const previous = conversationTurns[conversationTurns.length - 1];
    const turnId = (message as {turnId?:string}).turnId;
    if (message.role === 'assistant' && previous?.role === 'assistant' && (!turnId || !previous.turnId || previous.turnId === turnId)) {
      previous.messages.push(message); previous.turnId ||= turnId;
    } else conversationTurns.push({role:message.role,key:message.key,turnId,messages:[message]});
  }
  if (hasRuntimeActivity && (!conversationTurns.length || conversationTurns[conversationTurns.length - 1].role === 'user')) conversationTurns.push({role:'assistant',key:`pending-${stream?.attemptId || snapshot?.runId || 'task'}`,turnId:preparingSend ? undefined : stream?.turnId || snapshot?.runId || undefined,messages:[]});
  // Run identities survive model attempts, message trimming and stream settlement.
  // A local preparation key is handed to the accepted run without remounting it.
  const processScope = snapshot?.conversationId || draftKey || 'canvas-agent';
  let userAnchor = `${processScope}:orphan`, assistantSegment = 0;
  for (let index = 0; index < conversationTurns.length; index++) {
    const turn = conversationTurns[index];
    if (turn.role === 'user') { userAnchor = turn.key; assistantSegment = 0; continue; }
    const last = index === conversationTurns.length - 1;
    const runId = turn.turnId || (last && !preparingSend ? snapshot?.runId : undefined);
    const runKey = runId ? `${processScope}:run:${runId}` : undefined;
    const pending = pendingProcess.current;
    if (last && pending && (pending.scope === processScope || (!pending.runId && pending.scope === (draftKey || 'canvas-agent'))) && (preparingSend || (runId && runId !== pending.runId))) {
      turn.key = pending.key;
      if (runKey) { processRunKeys.current.set(runKey, pending.key); pendingProcess.current = null; }
    } else turn.key = runKey ? processRunKeys.current.get(runKey) || runKey : `${userAnchor}:assistant-${assistantSegment++}`;
  }
  const railEntries: CanvasAgentRailEntry[] = [];
  for (const turn of conversationTurns) {
    if (turn.role === 'user') railEntries.push({ key: turn.key, question: turn.messages[0].text, answer: '' });
    else if (railEntries.length) {
      const entry = railEntries[railEntries.length - 1];
      entry.answer = [entry.answer, ...turn.messages.map(message => message.text)].filter(Boolean).join(' ');
    }
  }
  const reuseMessage = (text:string) => {setDraft(text.slice(0,MAX_DRAFT_LENGTH));setLocalError('');textarea.current?.focus();};
  const completedCount = execution?.steps.filter(step => step.status === 'succeeded').length || 0;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { saveDraft(draftKey, draft); }, [draftKey, draft]);
  useEffect(() => { if (collapsed) { setHoveredReference(null); setFocusedReference(null); } }, [collapsed]);
  useEffect(() => {
    // Only explicit collapse/expand transfers focus; mounting must not steal canvas focus.
    if (!transferFocus.current) return;
    transferFocus.current = false;
    if (collapsed) panel.current?.querySelector<HTMLButtonElement>('.canvas-agent-orb')?.focus();
    else textarea.current?.focus();
  }, [collapsed]);
  useEffect(() => {
    if (!textarea.current) return;
    textarea.current.style.height = 'auto';
    textarea.current.style.height = `${Math.min(160, Math.max(76, textarea.current.scrollHeight))}px`;
  }, [draft, collapsed]);
  useEffect(() => {
    if (latestTranscript.current && latestTranscript.current !== transcriptSignature && messages.length && !stickToBottom.current) setUnreadMessages(true);
    latestTranscript.current = transcriptSignature;
  }, [transcriptSignature]);
  useEffect(() => {
    stickToBottom.current = true; setScrolledAway(false); setUnreadMessages(false);
  }, [snapshot?.conversationId]);
  useEffect(() => {
    if ((hasConversation || problem || working) && stickToBottom.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [snapshot, execution, problem, collapsed, hasConversation, working]);
  useEffect(() => {
    if (!working) { cancelLock.current = false; setCancelling(false); }
  }, [working]);
  useLayoutEffect(() => {
    if (collapsed) return;
    const host = panel.current, form = composer.current;
    if (!host || !form) return;
    const fit = () => {
      const bounds = host.getBoundingClientRect(), anchor = form.getBoundingClientRect();
      if (!bounds.height) return;
      for (const preview of form.querySelectorAll<HTMLElement>('.canvas-r1-agent-reference-preview')) {
        preview.style.maxHeight = `${Math.max(0, bounds.height - 16)}px`;
        preview.style.setProperty('--agent-preview-media-height', `${Math.max(0, Math.min(190, bounds.height - 50))}px`);
        const top = Math.max(bounds.top + 8, anchor.top - preview.getBoundingClientRect().height - 6);
        preview.style.top = `${top - anchor.top - form.clientTop}px`;
        preview.style.bottom = 'auto';
      }
    };
    fit();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    observer?.observe(host); observer?.observe(form);
    form.querySelectorAll('.canvas-r1-agent-reference-preview').forEach(preview => observer?.observe(preview));
    window.addEventListener('resize', fit);
    return () => { observer?.disconnect(); window.removeEventListener('resize', fit); };
  }, [collapsed, contextChips]);

  const send = async () => {
    if (!canSend || sendLock.current || composing.current) return;
    const submitted = draft.trim();
    sendLock.current = true; pendingProcess.current = {scope:snapshot?.conversationId || draftKey || 'canvas-agent',runId:snapshot?.runId,key:`${snapshot?.conversationId || draftKey || 'canvas-agent'}:sending:${crypto.randomUUID()}`}; setPendingSend({text:submitted,runId:snapshot?.runId,index:snapshot?.messages.length || 0,scope:snapshot?.conversationId || draftKey || 'canvas-agent'}); setSending(true); setLocalError(''); stickToBottom.current = true;
    try {
      const result = await onSend(submitted, { mode: runMode, allowGeneration: runMode === 'autonomous' && allowGeneration, maxMediaJobs: runMode === 'autonomous' && allowGeneration ? mediaBudget : 0 });
      if (result === false) {
        if (mounted.current) setLocalError(english ? 'Your request was not sent. Your draft is still here; try again.' : '请求未发送，草稿已保留，可以重试。');
        return;
      }
      if (!mounted.current) {
        // Closing while the request is in flight must not resurrect an accepted draft.
        // A newer draft typed in a reopened panel still belongs to the user.
        if (draftKey && readDraft(draftKey).trim() === submitted) saveDraft(draftKey, '');
        return;
      }
      // Do not erase edits made while a slow start request was pending.
      setDraft(current => current.trim() === submitted ? '' : current);
      // Generation permission is scoped to this request, never silently reused on the next send.
      setAllowGeneration(false);
    } catch (failure) {
      if (mounted.current) setLocalError(errorText(failure, english ? 'Could not send. Your draft has been kept.' : '发送失败，已保留你的草稿。'));
    } finally {
      sendLock.current = false;
      if (mounted.current) { setSending(false); setPendingSend(null); }
    }
  };

  const apply = async (generate: boolean) => {
    if (!plan || !plan.steps.length || applied || working || applyLock.current) return;
    applyLock.current = true; setApplying(true); setLocalError(''); stickToBottom.current = true;
    try {
      const result = await onApply(plan, generate);
      if (!mounted.current) return;
      if (result === false) {
        setLocalError(english ? 'The plan could not be added. You can try again.' : '方案未能放入画布，可以重试。');
        return;
      }
      setAppliedPlans(current => new Set(current).add(plan.id));
    } catch (failure) {
      if (mounted.current) setLocalError(errorText(failure, english ? 'Could not apply the plan. You can try again.' : '应用方案失败，可以重试。'));
    } finally {
      applyLock.current = false;
      if (mounted.current) setApplying(false);
    }
  };

  const cancel = async () => {
    if (cancelLock.current || (!working && problem !== 'canvas-agent-start-unconfirmed')) return;
    cancelLock.current = true; setCancelling(true); setLocalError('');
    try {
      const result = await onCancel();
      if (result !== false && mounted.current) setAllowGeneration(false);
      if (result === false && mounted.current) {
        cancelLock.current = false; setCancelling(false);
        setLocalError(english ? 'Could not cancel yet. Try again.' : '暂未能取消，请重试。');
      }
    } catch (failure) {
      cancelLock.current = false;
      if (mounted.current) { setCancelling(false); setLocalError(errorText(failure, english ? 'Could not cancel. Try again.' : '取消失败，请重试。')); }
    } finally {
      if (!working && mounted.current) { cancelLock.current = false; setCancelling(false); }
    }
  };

  const newConversation=async()=>{
    if(!onNewConversation||working||resetLock.current)return;
    resetLock.current=true;setResetting(true);setLocalError('');
    try{
      const result=await onNewConversation();
      if(result===false||!mounted.current)return;
      // Preserve the previous draft separately; only reset UI after durable ACK.
      if(draft&&draftKey&&snapshot?.conversationId)saveDraft(`${draftKey}:${snapshot.conversationId}`,draft);
      setDraft(current=>current===draft?'':current);setHistoryOpen(false);setAllowGeneration(false);setAppliedPlans(new Set());stickToBottom.current=true;
      textarea.current?.focus();
    }catch(failure){if(mounted.current)setLocalError(errorText(failure,english?'Could not create a conversation. Retry to check the same request.':'暂未确认新对话，请重试同一操作。'));}
    finally{resetLock.current=false;if(mounted.current)setResetting(false);}
  };
  const selectConversation = async (conversationId: string) => {
    if (!onSelectConversation || working || rotationPending || historyLock.current || conversationId === snapshot?.conversationId) return;
    historyLock.current = true; setSwitchingConversation(conversationId); setLocalError('');
    try {
      const result = await onSelectConversation(conversationId);
      if (result === false || !mounted.current) return;
      if (draft && draftKey && snapshot?.conversationId) saveDraft(`${draftKey}:${snapshot.conversationId}`, draft);
      setDraft(current => current === draft ? readDraft(draftKey ? `${draftKey}:${conversationId}` : undefined) : current);
      setHistoryOpen(false); setAllowGeneration(false); setAppliedPlans(new Set()); stickToBottom.current = true;
      textarea.current?.focus();
    } catch (failure) { if (mounted.current) setLocalError(errorText(failure, english ? 'Could not restore this conversation. Your current conversation is unchanged.' : '暂未恢复此对话，当前对话保持不变。')); }
    finally { historyLock.current = false; if (mounted.current) setSwitchingConversation(null); }
  };
  useEffect(() => {
    if (!historyOpen) return;
    const closeOutside = (event: PointerEvent) => { if (!historyMenu.current?.contains(event.target as Node)) setHistoryOpen(false); };
    document.addEventListener('pointerdown', closeOutside, true);
    return () => document.removeEventListener('pointerdown', closeOutside, true);
  }, [historyOpen]);
  const chooseStarter = (starter: typeof STARTERS[number]) => {
    setDraft(current => (current.trim() ? `${current}\n${english ? starter.enPrompt : starter.zhPrompt}` : english ? starter.enPrompt : starter.zhPrompt).slice(0, MAX_DRAFT_LENGTH));
    starterMenu.setOpen(false);
    setLocalError(''); textarea.current?.focus();
  };
  const kindName = (kind: 'image' | 'video' | 'text') => kind === 'image' ? english ? 'Image' : '图片' : kind === 'video' ? english ? 'Video' : '视频' : english ? 'Text' : '文本';
  const statusName = (status: NonNullable<CanvasAgentExecution>['steps'][number]['status']) => ({
    draft: english ? 'On canvas' : '已放入画布', queued: english ? 'Queued' : '等待生成', running: english ? 'Generating' : '生成中',
    succeeded: english ? 'Completed' : '已完成', failed: english ? 'Failed' : '失败', cancelled: english ? 'Cancelled' : '已取消',
  })[status];
  const liveExecutionIds = new Set(executionNodeIds);
  const canLocateResults = !!onLocateExecution && liveExecutionIds.size > 0;

  return <aside ref={panel} className={`canvas-r1-agent-panel nodrag nopan nowheel${collapsed ? ' is-collapsed' : ''}${reducedMotion ? ' reduce-motion' : ''}`}
    aria-label={english ? 'Canvas Agent' : '画布 Agent'}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onWheel={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (historyOpen) { setHistoryOpen(false); historyMenu.current?.querySelector('button')?.focus(); return; }
        if (starterMenu.open) { starterMenu.setOpen(false); starterMenu.trigger.current?.focus(); return; }
        if (!collapsed) { transferFocus.current = true; setCollapsed(true); onCollapsedChange?.(true); }
      }
    }}>
    {collapsed && <CanvasAgentOrb busy={working} unavailable={availability === 'unavailable'} english={english} controls={`${id}-body`} onOpen={toggleCollapsed} />}
    <header className="canvas-r1-agent-header" hidden={collapsed}>
      <span className="canvas-r1-agent-mark canvas-r1-agent-black-hole-mark"><CanvasAgentBlackHole busy={working} unavailable={availability === 'unavailable'} /></span>
      <span className="canvas-r1-agent-heading"><strong>Agent</strong><span>{english ? 'Create with your canvas' : '和画布一起创作'}</span></span>
      {onSelectConversation && <div className="canvas-agent-history" ref={historyMenu}>
        <button type="button" className="canvas-r1-agent-icon-button" aria-label={english ? 'Conversation history' : '历史对话'} title={english ? 'Switch conversations' : '切换历史对话'} aria-expanded={historyOpen} aria-controls={`${id}-history`} onClick={() => { const next = !historyOpen; setHistoryOpen(next); if (next) void Promise.resolve(onLoadConversations?.()).catch(() => {}); }}><AgentIcon kind="history" /></button>
        {historyOpen && <div className="canvas-agent-history-popover" id={`${id}-history`} role="region" aria-label={english ? 'Conversations on this canvas' : '此画布的对话'}>
          <div className="canvas-agent-history-heading"><strong>{english ? 'Conversations' : '历史对话'}</strong><button type="button" aria-label={english ? 'Close history' : '关闭历史对话'} onClick={() => setHistoryOpen(false)}><AgentIcon kind="close" /></button></div>
          {historyLoading && <p role="status">{english ? 'Loading conversations…' : '正在读取对话…'}</p>}
          {historyError && <p role="alert">{displayError(historyError)} <button type="button" onClick={() => void Promise.resolve(onLoadConversations?.()).catch(() => {})}>{english ? 'Retry' : '重试'}</button></p>}
          {!historyLoading && !historyError && !conversations.length && <p>{english ? 'Your conversations will appear here.' : '此画布的对话会保存在这里。'}</p>}
          <ul>{conversations.map(conversation => <li key={conversation.conversationId}><button type="button" disabled={working || rotationPending} aria-current={conversation.conversationId === snapshot?.conversationId ? 'true' : undefined} onClick={() => void selectConversation(conversation.conversationId)}><span><strong>{conversation.title || (english ? 'New conversation' : '新对话')}</strong><small>{new Date(conversation.updatedAt).toLocaleDateString(english ? 'en' : 'zh-CN', { month: 'short', day: 'numeric' })} · {conversation.messageCount} {english ? 'messages' : '条消息'}</small></span>{conversation.conversationId === snapshot?.conversationId && <AgentIcon kind="check" />}</button></li>)}</ul>
        </div>}
      </div>}
      {onNewConversation&&<button type="button" className="canvas-r1-agent-icon-button" disabled={working||!snapshot?.conversationId||availability==='checking'} aria-label={english?'New conversation':'新建对话'} title={rotationPending?(english?'Retry the pending new conversation':'核实并重试上次新建对话'):(english?'New conversation. Canvas content and previous session records are kept.':'新建对话，保留画布内容与旧会话记录')} onClick={()=>void newConversation()}><AgentIcon kind="plus"/></button>}
      <span className={`canvas-r1-agent-status-dot${working ? ' is-working' : ''}${availability === 'unavailable' ? ' is-unavailable' : ''}`} aria-hidden="true" />
      <button type="button" className="canvas-r1-agent-icon-button" aria-controls={`${id}-body`} aria-expanded="true"
        aria-label={english ? 'Collapse Agent' : '收起 Agent'} title={english ? 'Collapse Agent' : '收起 Agent'} onClick={toggleCollapsed}><AgentIcon kind="collapse" /></button>
    </header>
    <div id={`${id}-body`} className="canvas-r1-agent-body" hidden={collapsed}>
      <div className="canvas-r1-agent-canvas-label"><span className="canvas-r1-agent-canvas-symbol" aria-hidden="true" /><span title={canvasName}>{canvasName || (english ? 'Untitled canvas' : '未命名画布')}</span><small>{english ? 'CURRENT CANVAS' : '当前画布'}</small></div>
      <div className="canvas-agent-transcript-shell">
      <div ref={transcript} tabIndex={0} aria-label={english ? 'Conversation content' : '对话内容'} className="canvas-r1-agent-transcript" onScroll={event => {
        const element = event.currentTarget; stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64; setScrolledAway(!stickToBottom.current); if (stickToBottom.current) setUnreadMessages(false);
      }}>
        {!hasConversation && availability === 'ready' && <section className="canvas-r1-agent-welcome">
          <div className="canvas-r1-agent-welcome-art" aria-hidden="true"><span><AgentIcon kind="image" /></span><span><AgentIcon kind="spark" /></span><span><AgentIcon kind="video" /></span></div>
          <span className="canvas-r1-agent-eyebrow">{english ? 'A LITTLE IDEA. A NEW DIRECTION.' : '让灵感，顺着画布生长'}</span>
          <h2>{english ? <>A thought to start.<br />A canvas to explore.</> : <>从一个想法，<br />到一张画布。</>}</h2>
          <p>{english ? 'Describe your goal. Agent can organize the canvas, refine ideas and carry out the creative task.' : '说说你的目标。Agent 可以整理画布、完善创意，并推进创作任务。'}</p>
          <div className="canvas-r1-agent-starters">{STARTERS.map(starter => <button key={starter.kind} type="button" disabled={working || availability !== 'ready'} onClick={() => chooseStarter(starter)}>
            <span className="canvas-r1-agent-starter-icon"><AgentIcon kind={starter.kind} /></span><span><strong>{english ? starter.en : starter.zh}</strong><small>{english ? starter.enHint : starter.zhHint}</small></span><span aria-hidden="true">↗</span>
          </button>)}</div>
          <p className="canvas-r1-agent-model-hint">{english ? 'Powered by LSH. Media generation uses your canvas models and requires a budget for this request.' : '由 LSH 驱动。生图／视频沿用画布配置，由你授权本轮生成预算。'}</p>
        </section>}
        {availability !== 'ready' && <div className="canvas-r1-agent-availability" role="status">
          <AgentIcon kind={availability === 'checking' ? 'spark' : 'warning'} /><div><strong>{availability === 'checking' ? english ? 'Connecting to Agent…' : '正在连接 Agent…' : english ? 'Agent is currently unavailable' : 'Agent 暂不可用'}</strong>
            <p>{availabilityMessage || (availability === 'checking' ? english ? 'Checking the existing LSH connection.' : '正在检查现有 LSH 连接。' : english ? 'Check the LSH connection and model in app settings, then reopen Agent.' : '请在应用设置中检查 LSH 连接和模型，再重新打开 Agent。')}</p>{availability === 'unavailable' && !problem && onRefresh && <button type="button" className="canvas-r1-agent-refresh" onClick={onRefresh}>{english ? 'Reconnect' : '重新连接'}</button>}</div>
        </div>}
        {(messages.length > 0 || hasRuntimeActivity) && <div className="canvas-r1-agent-messages" role="log" aria-label={english ? 'Agent conversation' : 'Agent 对话'} aria-live="polite" aria-relevant="additions text">
          {conversationTurns.map((turn,index) => turn.role === 'user' ? <div key={turn.key} data-agent-query={turn.key}><CanvasAgentMessageView message={turn.messages[0]} english={english} disabled={working||rotationPending} onReuse={reuseMessage}/></div> : <CanvasAgentTurnView key={turn.key} messages={turn.messages} english={english} disabled={working||rotationPending} onReuse={reuseMessage}
            tools={(preparingSend && index === conversationTurns.length - 1 ? [] : snapshot?.tools || []).filter(tool => tool.turnId ? tool.turnId === turn.turnId : index === conversationTurns.length - 1)}
            activity={index === conversationTurns.length - 1 && !preparingSend ? snapshot?.activity || [] : []}
            progress={index === conversationTurns.length - 1 && !preparingSend ? snapshot?.progress || [] : []}
            reasoning={index === conversationTurns.length - 1 && stream?.status === 'streaming' && !!stream.reasoning}
            busy={index === conversationTurns.length - 1 && working}
            status={index === conversationTurns.length - 1 && !preparingSend ? snapshot?.status : undefined} />)}
        </div>}
        {plan && <section className="canvas-r1-agent-plan" aria-label={english ? 'Creative plan' : '创作方案'}>
          <div className="canvas-r1-agent-plan-kicker"><span><AgentIcon kind={applied ? 'check' : 'spark'} />{applied ? english ? 'ADDED TO CANVAS' : '已放入画布' : english ? 'CREATIVE PLAN' : '创作方案'}</span><small>{english ? `${plan.steps.length} steps` : `${plan.steps.length} 个步骤`}</small></div>
          <h3>{plan.title}</h3>{plan.summary && <p className="canvas-r1-agent-plan-summary">{plan.summary}</p>}
          <ol className="canvas-r1-agent-plan-steps">{plan.steps.map((step, index) => <li key={step.id}><details>
            <summary><span className="canvas-r1-agent-step-number">{String(index + 1).padStart(2, '0')}</span><span className="canvas-r1-agent-step-title">{step.title}<small>{step.targetNodeId ? english ? 'Edit existing node' : '修改已有节点' : english ? 'Create new node' : '新建节点'}</small></span><span className="canvas-r1-agent-kind"><AgentIcon kind={step.kind} />{kindName(step.kind)}</span></summary>
            <div className="canvas-r1-agent-step-detail">{step.targetNodeId && <div className="canvas-r1-agent-edit-target"><span>{english ? 'Full replacement content' : '替换后的完整内容'}</span><button type="button" onClick={() => onLocate(step.targetNodeId!)}><AgentIcon kind="locate" />{english ? 'Locate existing node' : '定位已有节点'}</button></div>}{step.settings && <div className="canvas-r1-agent-step-settings">{[step.settings.aspect,step.settings.resolution,step.settings.quality,step.settings.duration!==undefined?`${step.settings.duration}${english?'s':' 秒'}`:null].filter(Boolean).map((value,index)=><span key={index}>{value}</span>)}</div>}<p>{step.content}</p>{step.references.length > 0 && <small>{english ? `${step.references.length} references` : `${step.references.length} 个参考`}</small>}</div>
          </details></li>)}</ol>
          <div className="canvas-r1-agent-plan-actions">
            <button type="button" disabled={working || applied || !plan.steps.length} onClick={() => void apply(false)}>{applied ? english ? 'Added to canvas' : '已放入画布' : english ? 'Add to canvas' : '放入画布'}</button>
            <button type="button" className="is-primary" disabled={working || applied || !plan.steps.length} onClick={() => void apply(true)}><AgentIcon kind="spark" />{english ? 'Add & generate' : '放入并生成'}</button>
          </div>
          <p className="canvas-r1-agent-plan-note">{applied ? english ? 'Continue refining in the canvas, or ask for a new plan.' : '可以继续在画布中调整，也可以提出新的创作要求。' : english ? 'Add editable nodes, or generate with your configured canvas models.' : '先放入可编辑节点，或使用画布已配置的模型开始生成。'}</p>
        </section>}
        {execution && <section className="canvas-r1-agent-execution" aria-label={english ? 'Canvas execution' : '画布执行结果'}>
          <div className="canvas-r1-agent-section-heading"><strong>{english ? 'On your canvas' : '画布上的创作'}</strong><span role="status">{execution.status === 'draft' ? english ? 'Ready to edit' : '可继续编辑' : execution.status === 'running' ? english ? `${completedCount}/${execution.steps.length} complete` : `${completedCount}/${execution.steps.length} 已完成` : execution.status === 'failed' ? english ? 'Needs attention' : '有步骤未完成' : execution.status === 'cancelled' ? english ? 'Cancelled' : '已取消' : english ? 'Completed' : '已完成'}</span>
            <ExecutionLocateButton label={english ? 'Select and locate all results' : '选中并定位全部结果'} disabled={!canLocateResults}
              tooltip={canLocateResults ? english ? `Select and locate ${liveExecutionIds.size} result nodes` : `选中并定位 ${liveExecutionIds.size} 个结果节点` : english ? 'No results are available to locate' : '当前暂无可定位的结果'}
              onClick={() => onLocateExecution?.(execution)} />
          </div>
          <ol>{execution.steps.map(step => <li key={step.id} className={`canvas-r1-agent-execution-step is-${step.status}`}>
            <span className="canvas-r1-agent-execution-icon"><AgentIcon kind={step.status === 'succeeded' ? 'check' : step.status === 'failed' ? 'warning' : step.kind} /></span>
            <div><strong>{step.title}</strong><span className="canvas-r1-agent-step-status">{statusName(step.status)}</span>{step.error && <p role="status">{displayError(step.error)}</p>}</div>
            <ExecutionLocateButton label={english ? `Locate ${step.title}` : `定位 ${step.title}`} disabled={!onLocateExecution || !liveExecutionIds.has(step.nodeId)}
              tooltip={liveExecutionIds.has(step.nodeId) ? english ? 'Locate on canvas' : '在画布中定位' : english ? 'This result is not available to locate' : '此结果暂不可定位'}
              onClick={() => onLocateExecution?.(execution, step.nodeId)} />
          </li>)}</ol>
        </section>}
        {snapshot?.status === 'cancelled' && !working && <p className="canvas-r1-agent-inline-status" role="status">{english ? 'Stopped. You can revise your request and continue.' : '已停止。你可以调整要求，继续创作。'}</p>}
        {working && (!hasRuntimeActivity || resetting || switchingConversation || cancelling || isExecuting) && <div className="canvas-r1-agent-working" role="status" aria-live="polite" aria-atomic="true"><span className="canvas-r1-agent-working-indicator" aria-hidden="true"><CanvasAgentBlackHole busy /></span><span>{switchingConversation ? english ? 'Restoring conversation…' : '正在恢复对话…' : resetting ? english?'Creating conversation…':'正在新建对话…' : cancelling ? english ? 'Stopping…' : '正在停止…' : isExecuting ? english ? 'Generating…' : '正在生成…' : applying ? english ? 'Adding…' : '正在添加…' : english ? 'Running…' : '运行中…'}</span></div>}
        {rotationPending&&!resetting&&<p className="canvas-r1-agent-inline-status" role="status">{english?'New conversation is not confirmed. Use New conversation again to verify; sending is paused.':'新对话尚未确认，请再次点“新建对话”核实；暂不发送新的需求。'}</p>}

        {problem && receiptNotice && <p className="canvas-r1-agent-inline-status canvas-agent-receipt-notice" role="status">{displayError(problem)}{problem === 'canvas-agent-start-unconfirmed' && onRefresh && <button type="button" disabled={availability === 'checking'} onClick={() => { setLocalError(''); onRefresh(); }}>{english ? 'Check status' : '核对状态'}</button>}{problem === 'canvas-agent-start-unconfirmed' && <button type="button" disabled={cancelling} title={english ? 'Check the receipt and stop only the matching task. Unconfirmed requests stay protected against duplicate sending.' : '核实回执后仅停止对应任务；未确认请求仍保留防重复发送保护。'} onClick={() => void cancel()}>{english ? 'Stop previous task' : '停止上次任务'}</button>}</p>}
        {problem && !receiptNotice && <div className="canvas-r1-agent-error" role="alert"><AgentIcon kind="warning" /><div><span>{problemMessage || displayError(problem)}</span>{onRefresh && reconnectProblem && <button type="button" className="canvas-r1-agent-refresh" disabled={availability === 'checking'} onClick={() => { setLocalError(''); onRefresh(); }}>{english ? 'Reconnect' : '重新连接'}</button>}</div></div>}
      </div>
      <CanvasAgentTurnRail entries={railEntries} transcript={transcript} english={english} onNavigate={() => { stickToBottom.current = false; setScrolledAway(true); }} />
      </div>
      {hasConversation && messages.length > 0 && scrolledAway && unreadMessages && <div className="canvas-agent-unread-rail"><button type="button" className="canvas-agent-back-bottom" aria-label={english ? 'Go to new messages' : '查看新消息'} onClick={() => { stickToBottom.current = true; setScrolledAway(false); setUnreadMessages(false); if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight; }}><span aria-hidden="true">↓</span>{english ? 'New messages' : '有新消息'}</button></div>}
      <div className="canvas-r1-agent-compose-area">
        <form ref={composer} className="canvas-r1-agent-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
          <div className="canvas-r1-agent-reference-rail">
            {onPickContext && <button type="button" className="canvas-r1-agent-pick-context" aria-label={english ? 'Click canvas to add references' : '点击画布添加'} title={english ? 'Click canvas to add references' : '点击画布添加'} aria-pressed={pickingContext} disabled={working} onClick={onPickContext}><AgentIcon kind="locate" /></button>}
            {contextChips.length > 0 && <ul className="canvas-r1-agent-context-list" aria-label={english ? 'Attached canvas references' : '已加入的画布参考'}>{contextChips.map(chip => <li key={chip.id}
              onMouseEnter={() => setHoveredReference(chip.id)} onMouseLeave={() => setHoveredReference(null)}
              onPointerDown={() => setFocusedReference(null)}
              onFocus={event => { if (event.target.matches(':focus-visible')) setFocusedReference(chip.id); }}
              onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedReference(null); }}>
              <button type="button" className="canvas-r1-agent-context-locate" aria-label={english ? `Locate reference ${chip.title}` : `定位参考 ${chip.title}`} onClick={() => onLocate(chip.id)}><ContextThumbnail chip={chip} /></button>
              <button type="button" className="canvas-r1-agent-context-remove" disabled={working} aria-label={english ? `Remove reference ${chip.title}` : `移除参考 ${chip.title}`} onClick={() => onRemoveContext(chip.id)}><AgentIcon kind="close" /></button>
              <ContextPreview chip={chip} english={english} active={activeReference === chip.id} />
            </li>)}</ul>}
          </div>
          <label className="canvas-r1-agent-sr-only" htmlFor={`${id}-prompt`}>{english ? 'Describe your creative request' : '描述你的创作要求'}</label>
          <textarea ref={textarea} id={`${id}-prompt`} value={draft} rows={3} maxLength={MAX_DRAFT_LENGTH}
            placeholder={english ? 'What would you like to create?' : '描述想法，或说说你想怎么改…'} aria-describedby={`${id}-composer-hint`}
            onChange={event => { setDraft(event.target.value); if (localError) setLocalError(''); }}
            onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !composing.current) { event.preventDefault(); void send(); }
            }} />
          <div className="canvas-r1-agent-composer-bottom">
            <div ref={starterMenu.root} className="canvas-r1-agent-creation-menu" data-open={starterMenu.open || undefined}>
              <button ref={starterMenu.trigger} type="button" className="canvas-agent-popover-trigger" aria-expanded={starterMenu.open} aria-controls={starterMenu.id} onClick={() => starterMenu.setOpen(value => !value)} aria-label={english ? 'Creative starters' : '创作起点'}><AgentIcon kind="plus" /><span>{english ? 'Create' : '创作'}</span><AgentIcon kind="chevron" /></button>
              <div id={starterMenu.id} hidden={!starterMenu.open} className="canvas-r1-agent-creation-options">{STARTERS.map(starter => <button key={starter.kind} type="button" disabled={working || availability !== 'ready'} onClick={() => chooseStarter(starter)}><AgentIcon kind={starter.kind} /><span>{starter.kind === 'text' ? english ? 'Script' : '剧本' : kindName(starter.kind)}</span></button>)}</div>
            </div>
            <CanvasAgentRunSettings english={english} disabled={working || rotationPending} mode={runMode} allowGeneration={allowGeneration} mediaBudget={mediaBudget}
              onModeChange={mode => { setRunMode(mode); setAllowGeneration(false); }} onAllowGeneration={setAllowGeneration} onBudgetChange={setMediaBudget} />
            <CanvasAgentModelPicker models={models} selectedModel={selectedModel} onSelect={onSelectModel} error={modelsError} disabled={working || modelSelectionLocked || availability==='checking'} onRefresh={onRefresh} english={english} />
            {working ? <button type="button" className="canvas-r1-agent-send is-stop" disabled={cancelling||resetting} aria-label={switchingConversation ? english ? 'Restoring conversation…' : '正在恢复对话…' : resetting ? english?'Creating conversation…':'正在新建对话…' : cancelling ? english ? 'Cancelling' : '正在取消' : english ? 'Stop current task' : '停止当前任务'} title={english ? 'Stop current task' : '停止当前任务'} onClick={() => void cancel()}><AgentIcon kind="stop" /></button>
              : <button type="submit" className="canvas-r1-agent-send" disabled={!canSend} aria-label={english ? 'Send request' : '发送要求'} title={english ? 'Send request' : '发送要求'}><AgentIcon kind="arrow" /></button>}
          </div>
        </form>
        <div className="canvas-r1-agent-sr-only" id={`${id}-composer-hint`}><span>{english ? 'Enter to send · Shift + Enter for a new line' : 'Enter 发送 · Shift + Enter 换行'}</span><span>{english ? `${contextChips.length} references attached` : `已附加 ${contextChips.length} 项参考`}</span></div>
      </div>
    </div>
  </aside>;
}
