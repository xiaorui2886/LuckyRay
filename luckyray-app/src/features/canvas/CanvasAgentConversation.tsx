import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { DisclosureRow, TextShimmer, MarkdownText, IconThinkOutlineRegular, IconBrowseOutlineRegular, IconEditOutlineRegular, IconSparkleRegular, IconChecklistOutlineRegular } from './dsh-reference/primitives';
import TOOL_LOCALE_ZH from './dsh-reference/tool/locale/conversation.zh.json';
import TOOL_LOCALE_EN from './dsh-reference/tool/locale/conversation.en.json';
import { ToolRow } from './dsh-reference/tool';
import { canvasAgentToolDetail } from './canvasAgentToolDetail';
import { CanvasAgentBlackHole } from './CanvasAgentBlackHole';
import { activityDuration, reasoningPreview } from './canvasAgentPresentation';
import type { CanvasAgentActivity, CanvasAgentMessage } from '../../core/canvas/agent/types';

const LABELS: Record<string, [string, string]> = {
  preparing: ['准备任务', 'Preparing'], 'resolving-model': ['检查模型', 'Checking model'],
  'opening-session': ['连接专属会话', 'Connecting session'], 'waiting-model': ['等待模型回复', 'Waiting for response'],
  'reading-context': ['读取画布参考', 'Read canvas references'], 'proposing-plan': ['整理创作方案', 'Propose creative plan'],
  finalizing: ['保存回复', 'Saving response'], stopping: ['正在停止', 'Stopping'],
};
const TOOL_LABELS: Record<string, [string, string]> = {
  canvas_read_creation: ['查看创作内容', 'Read creative objects'], canvas_edit_creation: ['编辑创作内容', 'Edit creative objects'], canvas_open_creation: ['准备用户确认', 'Prepare user handoff'],
  canvas_read_context: ['查看画布', 'Read canvas'], canvas_propose_plan: ['整理创作方案', 'Prepare creative plan'],
  canvas_apply_plan: ['编辑画布', 'Edit canvas'], canvas_generate_plan: ['生成素材', 'Generate media'], canvas_edit_graph: ['调整布局与连线', 'Arrange nodes and connections'], canvas_execute_plan: ['执行创作方案', 'Execute creative plan'],
  canvas_read_execution: ['检查创作结果', 'Inspect creative results'], canvas_report_progress: ['更新任务进展', 'Report task progress'],
};
type VisibleActivity = CanvasAgentActivity & { title?: string; detail?: string; toolName?: string };
export type CanvasAgentReasoningStatus = { active: boolean; startedAt?: number; endedAt?: number };
export type CanvasAgentProgressSummary = { id: string; summary: string; createdAt?: number };
type CanvasAgentToolEvent = { callId: string; name: string; status: 'running' | 'completed' | 'failed'; startedAt: number; endedAt?: number; summary?: string; displayTitle?: string; displayTitleEn?: string; eventSeq?: number };
/** Real runtime phase, not a synthetic model thought. Uses the same DSH row as tools. */
function CanvasRuntimePhase({ title }: { title: string }) {
  return <div className="canvas-dsh-phase" role="status" data-state="running">
    <DisclosureRow icon={<IconSparkleRegular size={14}/>} title={title} running open={false} expandable={false} onToggle={() => {}} />
  </div>;
}
function TraceChevron() {
  return <svg className="canvas-agent-trace-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m6 4 4 4-4 4" /></svg>;
}
function TraceIcon({ kind }: { kind: 'tool' | 'reasoning' | 'progress' }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">{kind === 'tool' ? <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3m6 0h4" /></> : kind === 'reasoning' ? <><path d="M9 4a3 3 0 0 0-5 2 4 4 0 0 0-1 7 4 4 0 0 0 6 6m6-15a3 3 0 0 1 5 2 4 4 0 0 1 1 7 4 4 0 0 1-6 6M9 3v18m6-18v18M5 8h4m6 0h4M5 15h4m6 0h4" /></> : <><path d="m5 12 4 4L19 6M5 21h14" /></>}</svg>;
}
/** Only real runtime status and officially published model reasoning belong here. */
export function CanvasAgentActivityView({ activity, tools: runtimeTools = [], reasoning, progress = [], english = false, now }: {
  activity: readonly VisibleActivity[]; tools?: readonly CanvasAgentToolEvent[]; reasoning?: CanvasAgentReasoningStatus; progress?: readonly CanvasAgentProgressSummary[]; english?: boolean; now?: number;
}) {
  const tools: VisibleActivity[] = runtimeTools.length ? runtimeTools.map(item => ({ id: item.callId, kind: 'tool', label: 'waiting-model', toolName: item.name, title: (english ? item.displayTitleEn : item.displayTitle) || TOOL_LABELS[item.name]?.[english ? 1 : 0] || item.name.replace(/^canvas_/, '').replace(/_/g, ' '), detail: item.summary, status: item.status, startedAt: item.startedAt, endedAt: item.endedAt })) : activity.filter(item => item.kind === 'tool');
  const phase = [...activity].reverse().find(item => item.kind === 'phase' && item.status === 'running');
  if (!tools.length && !phase && !reasoning && !progress.length) return null;
  const duration = reasoning?.startedAt !== undefined && reasoning.endedAt !== undefined ? Math.max(0, (reasoning.endedAt - reasoning.startedAt) / 1000).toFixed(1) : null;
  return <section className="canvas-agent-activity" aria-label={english ? 'Task activity' : '任务过程'}>
    {reasoning && <div className="canvas-dsh-phase" role="status"><DisclosureRow icon={<IconThinkOutlineRegular size={14}/>} title={`${reasoning.active ? english ? 'Thinking' : '正在思考' : english ? 'Thought' : '已思考'}${duration !== null ? ` · ${duration}s` : ''}`} running={reasoning.active} open={false} expandable={false} onToggle={() => {}} /></div>}
    {progress.map(item => <CanvasProgressRow key={item.id} item={item} english={english}/>)}
    <ol>{tools.map(item => <li key={item.id} className={`is-${item.status}`}><CanvasToolRow item={item} now={now} english={english}/></li>)}</ol>
    {phase && !reasoning?.active && !tools.some(item => item.status === 'running') && <CanvasRuntimePhase title={LABELS[phase.label]?.[english ? 1 : 0] || (english ? 'Working' : '运行中')}/>}
  </section>;
}

function CanvasProgressRow({item,english}: {item:CanvasAgentProgressSummary;english:boolean}) {
  const [open,setOpen]=useState(false);
  return <div className="canvas-dsh-progress"><DisclosureRow icon={<IconChecklistOutlineRegular size={14}/>} title={english ? 'Task progress' : '任务进展'} open={open} expandable expandOnRowClick onToggle={()=>setOpen(value=>!value)}
    collapsedContent={<><span className="canvas-dsh-separator" aria-hidden="true"/><span className="canvas-dsh-summary">{item.summary}</span></>}>
    <div className="canvas-dsh-think-body"><MarkdownText text={item.summary} labels={REASONING_LABELS[english?'en':'zh']} variant="compact"/></div>
  </DisclosureRow></div>;
}

/** Each official ToolRow owns disclosure state; a sibling completion cannot collapse it. */
function useToolDisclosure() {
  const [expanded, setExpanded] = useState(false);
  return { expanded, setExpanded, toggle: () => setExpanded(value => !value) };
}
function translateTool(locale: Record<string,string>, key:string, values?:Record<string,unknown>) {
  return (locale[key] || key).replace(/\{(\w+)\}/g, (token,name) => values?.[name] === undefined ? token : String(values[name]));
}
const toolTranslateZh = (key:string, values?:Record<string,unknown>) => translateTool(TOOL_LOCALE_ZH,key,values);
const toolTranslateEn = (key:string, values?:Record<string,unknown>) => translateTool(TOOL_LOCALE_EN,key,values);
function CanvasToolRow({item, now, english}: {item:VisibleActivity;now?:number;english:boolean}) {
  const detail = canvasAgentToolDetail(item.detail);
  const duration = item.status === 'running' ? activityDuration(item.startedAt, now, english)
    : item.endedAt !== undefined ? activityDuration(item.startedAt, item.endedAt, english) : undefined;
  const title = item.title || LABELS[item.label]?.[english ? 1 : 0] || item.toolName || (english ? 'Canvas operation' : '画布操作');
  const read = !!item.toolName?.startsWith('canvas_read_');
  const edit = /canvas_(?:edit|apply|execute)_/.test(item.toolName || '');
  const summary = (detail.prose || '').split(/\r?\n/)[0] || (item.status === 'running' ? english ? 'Running' : '进行中' : item.status === 'failed' ? english ? 'Failed' : '未完成' : english ? 'Completed' : '已完成');
  return <div className="canvas-dsh-tool" data-call-id={item.id} data-state={item.status}>
    <ToolRow useDisclosure={useToolDisclosure} t={english ? toolTranslateEn : toolTranslateZh}
      variant={read ? 'read' : edit ? 'edit' : 'others'} toolName={item.toolName}
      icon={read ? <IconBrowseOutlineRegular size={14}/> : edit ? <IconEditOutlineRegular size={14}/> : <IconSparkleRegular size={14}/>}
      title={title} summary={summary} summarySuffix={duration} output={item.detail || undefined}
      errorSummary={item.status === 'failed' ? summary : undefined} state={item.status === 'failed' ? 'error' : item.status === 'running' ? 'running' : 'ok'}/>
  </div>;
}

export function CanvasAgentMessageView({ message, english = false, disabled, onReuse, hideHeader = false, hideActions = false, beforeContent }: {
  message: CanvasAgentMessage & { streaming?: boolean; reasoningText?: string }; english?: boolean; disabled: boolean; onReuse: (text: string) => void; hideHeader?: boolean; hideActions?: boolean; beforeContent?: ReactNode;
}) {
  // Do not shrink an answer the user is watching when its stream settles.
  // Historical long messages still start as previews; both remain user-toggleable.
  const [expanded, setExpanded] = useState(() => !!message.streaming), [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const mounted = useRef(true), copying = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (copyState !== 'copied') return; const timer = setTimeout(() => setCopyState('idle'), 1800); return () => clearTimeout(timer); }, [copyState]);
  const copy = async () => {
    if (copying.current) return; copying.current = true; setCopyState('copying');
    try { if (!navigator.clipboard?.writeText) throw Error('unavailable'); await navigator.clipboard.writeText(message.text); if (mounted.current) setCopyState('copied'); }
    catch { if (mounted.current) setCopyState('failed'); }
    finally { copying.current = false; }
  };
  const long = message.text.length > 2400 && !message.streaming;
  const reuseLabel = message.role === 'user' ? english ? 'Edit & reuse' : '编辑复用' : english ? 'Refine' : '继续完善';
  return <article className={`canvas-r1-agent-message is-${message.role}${message.streaming ? ' is-streaming' : ''}`} aria-busy={message.streaming || undefined}>
    {message.role === 'assistant' && !hideHeader && <div className="canvas-r1-agent-message-label"><span aria-hidden="true">✧</span><span>Agent</span></div>}
    {beforeContent}
    <div className={message.role === 'user' ? 'canvas-agent-user-bubble' : 'canvas-agent-message-content'}>
    {message.reasoningText?.trim() && <details className="canvas-agent-model-reasoning"><summary><TraceIcon kind="reasoning" /><span>{english ? 'Thought' : '已思考'}</span><TraceChevron /></summary><p>{message.reasoningText}</p></details>}
    {message.text && <p>{long && !expanded ? `${message.text.slice(0, 2400)}…` : message.text}{message.streaming && <span className="canvas-agent-stream-caret" aria-hidden="true" />}</p>}
    {long && <button type="button" className="canvas-agent-expand-message" onClick={() => setExpanded(value => !value)}>{expanded ? english ? 'Collapse' : '收起全文' : english ? 'Show more' : '展开全文'}</button>}
    </div>
    {message.text && !hideActions && <div className="canvas-agent-message-actions">
      <button type="button" disabled={copyState === 'copying'} aria-label={english ? 'Copy message' : '复制消息'} title={copyState === 'copied' ? english ? 'Copied' : '已复制' : english ? 'Copy message' : '复制消息'} onClick={() => void copy()}><svg viewBox="0 0 24 24" aria-hidden="true">{copyState === 'copied' ? <path d="m5 12 4 4L19 6" /> : <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M15 8V4H4v12h4" /></>}</svg></button>
      <button type="button" disabled={disabled} aria-label={reuseLabel} title={`${reuseLabel} · ${english ? 'Fill input only; does not send or replay tools' : '仅填入输入框，不会自动发送或重复执行工具'}`} onClick={() => onReuse(message.role === 'user' ? message.text : english ? `Please refine this response:\n${message.text}` : `请继续完善这条回复：\n${message.text}`)}><svg viewBox="0 0 24 24" aria-hidden="true">{message.role === 'user' ? <><path d="m14 4 6 6M4 20l4-1L20 7a2 2 0 0 0-4-4L4 15v5Z" /></> : <><path d="M5 19V8a3 3 0 0 1 3-3h11m-5-4 5 4-5 4M10 19h9m-4-4 4 4-4 4" /></>}</svg></button>
      {copyState === 'copied' && <span className="canvas-agent-sr-only" role="status">{english ? 'Copied' : '已复制'}</span>}
      {copyState === 'failed' && <small role="status">{english ? 'Copy failed. Select text to copy.' : '复制失败，可选中文字复制。'}</small>}
    </div>}
  </article>;
}


type TurnMessage = CanvasAgentMessage & { reasoningStartedAt?: number; reasoningEndedAt?: number; reasoningDurationMs?: number; reasoningActiveStartedAt?: number; streaming?: boolean; startedAt?: number; createdAt?: number; eventSeq?: number; turnId?: string };
function useActivityClock(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}
const REASONING_LABELS = {
  en: { code: { copyLabel: 'Copy', copiedLabel: 'Copied', toolbarLabels: { codeLabel: 'Code', wrapLabel: 'Wrap', unwrapLabel: 'Unwrap' } }, footnotes: 'Footnotes' },
  zh: { code: { copyLabel: '复制', copiedLabel: '已复制', toolbarLabels: { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '取消换行' } }, footnotes: '脚注' },
};
/** Adapt the official DSH ReasoningRow to Canvas attempts; never manufacture reasoning. */
function ReasoningDisclosure({ message, active, now, english, visible }: { message: TurnMessage; active: boolean; now: number; english: boolean; visible: boolean }) {
  const content = useRef<HTMLDivElement>(null), following = useRef(true);
  // DSH rows are independently collapsed. R12's outer turn still opens at send.
  const [open, setOpen] = useState(false), [paused, setPaused] = useState(false);
  const milliseconds = message.reasoningDurationMs === undefined ? undefined : message.reasoningDurationMs + (active && message.reasoningActiveStartedAt !== undefined ? Math.max(0, now - message.reasoningActiveStartedAt) : 0);
  const duration = activityDuration(milliseconds === undefined ? undefined : 0, milliseconds, english);
  const text = message.reasoningText || '';
  const summary = reasoningPreview(text, active);
  const preview = !open && summary !== '';
  useLayoutEffect(() => {
    if (visible && open && following.current && content.current) content.current.scrollTop = content.current.scrollHeight;
  }, [text, open, visible]);
  const followLatest = () => {
    following.current = true; setPaused(false);
    if (content.current) content.current.scrollTop = content.current.scrollHeight;
  };
  const interrupt = () => { following.current = false; setPaused(true); };
  return <div className={`canvas-agent-model-reasoning canvas-dsh-reasoning${active ? ' is-running' : ''}`} data-variant="think" data-state={active ? 'running' : 'ok'} data-expanded={open || undefined} data-preview={preview || undefined}>
    {active && <span className="canvas-agent-sr-only">{english ? 'Running' : '运行中'}</span>}
    <DisclosureRow icon={<IconThinkOutlineRegular size={14} />} title={`${active ? english ? 'Thinking' : '正在思考' : english ? 'Thought' : '已思考'}${duration ? ` ${duration}` : ''}`}
      titleClassName="canvas-agent-reasoning-caption" rowClassName="canvas-dsh-reasoning-row" running={active} open={open} expandable expandOnRowClick onToggle={() => setOpen(value => !value)}
      collapsedContent={<><span className="canvas-dsh-separator" data-shimmer-decoration aria-hidden="true" /><span className="canvas-agent-reasoning-preview canvas-dsh-summary" data-streaming={active || undefined}><span className="canvas-dsh-summary-text"><TextShimmer>{summary}</TextShimmer></span></span></>}>
      <div className="canvas-dsh-think-body">
        <div ref={content} className="canvas-dsh-reasoning-scroll" tabIndex={0} aria-label={english ? 'Published reasoning' : '模型公开的思考内容'} onWheel={interrupt} onTouchStart={interrupt} onPointerDown={interrupt} onKeyDown={event => { if (!event.defaultPrevented && ['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)) interrupt(); }} onScroll={event => {
          const p = event.currentTarget;
          following.current = p.scrollHeight - p.scrollTop - p.clientHeight < 24;
          setPaused(!following.current);
        }}><MarkdownText text={text} streaming={active} variant="compact" labels={REASONING_LABELS[english ? 'en' : 'zh']} /></div>
        {paused && <button type="button" className="canvas-agent-reasoning-follow" onClick={followLatest}>{english ? 'Follow latest' : '跟随最新'}<span aria-hidden="true"> ↓</span></button>}
      </div>
    </DisclosureRow>
  </div>;
}
/** One user request, one assistant turn. Runtime identities stay intact inside it. */
export function CanvasAgentTurnView({ messages, activity = [], tools = [], progress = [], reasoning = false, busy = false, status, english = false, disabled, onReuse }: {
  messages: TurnMessage[]; activity?: readonly VisibleActivity[]; tools?: readonly CanvasAgentToolEvent[]; progress?: readonly CanvasAgentProgressSummary[];
  reasoning?: boolean; busy?: boolean; status?: string; english?: boolean; disabled: boolean; onReuse: (text:string)=>void;
}) {
  const now = useActivityClock(busy);
  // Disclosure belongs to the whole user turn, never to an individual model/tool attempt.
  const [processOpen, setProcessOpen] = useState(() => busy || status === 'failed' || status === 'cancelled');
  const completedOnce = useRef(status === 'completed' && !busy);
  const responseStreaming = messages.some(message => message.streaming);
  useLayoutEffect(() => {
    if (status === 'completed' && !busy && !responseStreaming && !completedOnce.current) {
      completedOnce.current = true;
      setProcessOpen(false);
    }
  }, [status, busy, responseStreaming]);
  const activelyReasoning = busy && reasoning && !tools.some(tool=>tool.status === 'running');
  const candidateIndex = messages.map(message => !!message.text.trim()).lastIndexOf(true);
  const candidate = messages[candidateIndex];
  const hasLaterTool = candidate && tools.some(tool => candidate.eventSeq !== undefined && tool.eventSeq !== undefined ? tool.eventSeq > candidate.eventSeq : !!candidate.createdAt && tool.startedAt > candidate.createdAt);
  const finalIndex = hasLaterTool ? -1 : candidateIndex;
  const response = finalIndex >= 0 ? messages[finalIndex] : undefined;
  const prior = messages.filter((_message,index) => index !== finalIndex);
  const processEntries = [...messages.map((message,index)=>({kind:'message' as const,message,index,eventSeq:message.eventSeq,time:message.streaming && message.eventSeq === undefined ? Number.POSITIVE_INFINITY : message.createdAt || message.startedAt || 0})), ...tools.map(tool=>({kind:'tool' as const,tool,eventSeq:tool.eventSeq,time:tool.startedAt}))].sort((a,b)=>a.eventSeq !== undefined && b.eventSeq !== undefined ? a.eventSeq-b.eventSeq : a.time-b.time);
  // Legacy persisted snapshots may contain one reasoning-only message per chunk.
  // Preserve their literal paragraphs, but expose one disclosure until a tool/text boundary.
  const folded: typeof processEntries = [];
  for (const entry of processEntries) {
    const previous = folded[folded.length-1];
    if (entry.kind === 'message' && previous?.kind === 'message' && !entry.message.text && !previous.message.text && entry.message.reasoningText && previous.message.reasoningText && (!entry.message.attemptId && !previous.message.attemptId && !entry.message.messageId && !previous.message.messageId)) { previous.message = {...previous.message,reasoningText:`${previous.message.reasoningText}\n\n${entry.message.reasoningText}`}; previous.index = entry.index; }
    else folded.push(entry.kind === 'message' ? {...entry,message:{...entry.message}} : entry);
  }

  const reasoningText = messages.map(message => message.reasoningText || '').filter(text => text.trim()).join('\n\n');
  const hasProcess = busy || !!reasoningText || !!tools.length || !!activity.length || !!progress.length || prior.some(message => !!message.text) || reasoning;
  const timed = [...activity, ...tools];
  const start = timed.length ? Math.min(...timed.map(item=>item.startedAt)) : undefined;
  const ends = timed.map(item=>item.endedAt).filter((value):value is number=>value !== undefined);
  const elapsed = activity.some(item => item.label === 'preparing') && (busy || timed.every(item => item.endedAt !== undefined)) ? activityDuration(start, busy ? now : ends.length ? Math.max(...ends) : undefined, english) : undefined;
  const runningTool = [...tools].reverse().find(tool => tool.status === 'running');
  const phase = [...activity].reverse().find(item => item.kind === 'phase' && item.status === 'running');
  const currentAction = runningTool ? (english ? runningTool.displayTitleEn : runningTool.displayTitle) || TOOL_LABELS[runningTool.name]?.[english ? 1 : 0] || (english ? 'Working on canvas' : '正在编辑画布')
    : activelyReasoning ? english ? 'Thinking' : '正在思考'
    : messages.some(message => message.streaming && message.text) ? english ? 'Writing' : '正在回复'
    : phase ? LABELS[phase.label]?.[english ? 1 : 0] || (english ? 'Working' : '正在处理') : english ? 'Working' : '正在处理';
  const label = busy ? english ? 'Task activity' : '任务过程' : status === 'failed' ? english ? 'Interrupted' : '已中断' : status === 'cancelled' ? english ? 'Stopped' : '已停止' : status === 'completed' ? english ? 'Completed' : '已完成' : english ? 'Activity' : '任务过程';
  const livePreview = busy && activelyReasoning ? reasoningPreview(reasoningText, true) : undefined;
  return <article className={`canvas-agent-turn${busy ? ' is-running' : ''}`} aria-busy={busy || undefined}>
    <div className="canvas-r1-agent-message-label"><span className="canvas-agent-turn-mark" aria-hidden="true"><CanvasAgentBlackHole busy={busy} animated /></span><span className={busy ? "canvas-agent-live-wordmark" : undefined}>Agent{busy && ` · ${currentAction}`}</span></div>
    {hasProcess && <details className="canvas-agent-turn-process" open={processOpen}>
      <summary onClick={event => { event.preventDefault(); setProcessOpen(open => !open); }}><span className="canvas-agent-process-label">{label}{elapsed !== undefined ? ` · ${elapsed}` : ''}</span>{livePreview && <span className="canvas-agent-reasoning-preview">{livePreview}</span>}<TraceChevron /></summary>
      <div className="canvas-agent-turn-process-body">
        {busy && !folded.length && !activity.length && !progress.length && !reasoning && <CanvasRuntimePhase title={english ? 'Preparing' : '准备任务'}/>}
        {folded.map((entry,index)=> entry.kind === 'tool' ? <CanvasAgentActivityView key={`tool-${entry.tool.callId}`} activity={[]} tools={[entry.tool]} english={english} now={now}/> : <div key={`phase-${entry.message.attemptId || entry.message.messageId || index}`} className="canvas-agent-turn-phase">
          {entry.message.reasoningText?.trim() && <ReasoningDisclosure message={entry.message} active={activelyReasoning && entry.index === messages.length - 1} now={now} english={english} visible={processOpen} />}
          {entry.index !== finalIndex && entry.message.text && <CanvasAgentMessageView message={{...entry.message,reasoningText:undefined}} english={english} disabled={disabled} onReuse={onReuse} hideHeader hideActions />}
        </div>)}
        <CanvasAgentActivityView activity={tools.length ? activity.filter(item=>item.kind !== 'tool' && !(runningTool && item.kind === 'phase')) : activity} progress={progress} now={now} reasoning={!reasoningText && activelyReasoning ? {active:true}:undefined} english={english}/>

      </div>
    </details>}
    {response && <CanvasAgentMessageView message={{...response,reasoningText:undefined}} english={english} disabled={disabled} onReuse={onReuse} hideHeader />}
  </article>;
}
