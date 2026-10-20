import { useEffect, useRef, useState, type ReactNode } from 'react';
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
  canvas_read_context: ['查看画布', 'Read canvas'], canvas_propose_plan: ['整理创作方案', 'Prepare creative plan'],
  canvas_apply_plan: ['编辑画布', 'Edit canvas'], canvas_generate_plan: ['生成素材', 'Generate media'], canvas_edit_graph: ['调整布局与连线', 'Arrange nodes and connections'], canvas_execute_plan: ['执行创作方案', 'Execute creative plan'],
  canvas_read_execution: ['检查创作结果', 'Inspect creative results'], canvas_report_progress: ['更新任务进展', 'Report task progress'],
};
type VisibleActivity = CanvasAgentActivity & { title?: string; detail?: string; toolName?: string };
export type CanvasAgentReasoningStatus = { active: boolean; startedAt?: number; endedAt?: number };
export type CanvasAgentProgressSummary = { id: string; summary: string; createdAt?: number };
type CanvasAgentToolEvent = { callId: string; name: string; status: 'running' | 'completed' | 'failed'; startedAt: number; endedAt?: number; summary?: string; displayTitle?: string; displayTitleEn?: string; eventSeq?: number };
function TraceIcon({ kind }: { kind: 'tool' | 'reasoning' | 'progress' }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">{kind === 'tool' ? <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3m6 0h4" /></> : kind === 'reasoning' ? <><path d="M9 4a3 3 0 0 0-5 2 4 4 0 0 0-1 7 4 4 0 0 0 6 6m6-15a3 3 0 0 1 5 2 4 4 0 0 1 1 7 4 4 0 0 1-6 6M9 3v18m6-18v18M5 8h4m6 0h4M5 15h4m6 0h4" /></> : <><path d="m5 12 4 4L19 6M5 21h14" /></>}</svg>;
}
/** Only real runtime status and officially published model reasoning belong here. */
export function CanvasAgentActivityView({ activity, tools: runtimeTools = [], reasoning, progress = [], english = false }: {
  activity: readonly VisibleActivity[]; tools?: readonly CanvasAgentToolEvent[]; reasoning?: CanvasAgentReasoningStatus; progress?: readonly CanvasAgentProgressSummary[]; english?: boolean;
}) {
  const tools: VisibleActivity[] = runtimeTools.length ? runtimeTools.map(item => ({ id: item.callId, kind: 'tool', label: 'waiting-model', toolName: item.name, title: (english ? item.displayTitleEn : item.displayTitle) || TOOL_LABELS[item.name]?.[english ? 1 : 0] || item.name.replace(/^canvas_/, '').replace(/_/g, ' '), detail: item.summary, status: item.status, startedAt: item.startedAt, endedAt: item.endedAt })) : activity.filter(item => item.kind === 'tool');
  const phase = [...activity].reverse().find(item => item.kind === 'phase' && item.status === 'running');
  if (!tools.length && !phase && !reasoning && !progress.length) return null;
  const duration = reasoning?.startedAt !== undefined && reasoning.endedAt !== undefined ? Math.max(0, (reasoning.endedAt - reasoning.startedAt) / 1000).toFixed(1) : null;
  return <section className="canvas-agent-activity" aria-label={english ? 'Task activity' : '任务过程'}>
    {reasoning && <div className={`canvas-agent-reasoning-status${reasoning.active ? ' is-running' : ''}`} role="status"><TraceIcon kind="reasoning" /><span>{reasoning.active ? english ? 'Thinking' : '正在思考' : english ? 'Thought' : '已思考'}{duration !== null && ` · ${duration}s`}</span></div>}
    {progress.map(item => <details key={item.id} className="canvas-agent-progress-summary"><summary><TraceIcon kind="progress" /><span>{english ? 'Task progress' : '任务进展'} · {item.summary}</span><span className="canvas-agent-trace-chevron" aria-hidden="true">›</span></summary><p>{item.summary}</p></details>)}
    <ol>{tools.map(item => <li key={item.id} className={`is-${item.status}`}><details>
      <summary><TraceIcon kind="tool" /><span className="canvas-agent-trace-title">{item.title || LABELS[item.label]?.[english ? 1 : 0] || item.toolName || (english ? 'Canvas operation' : '画布操作')}</span><small>{item.status === 'failed' ? english ? 'Interrupted' : '已中断' : item.status === 'running' ? english ? 'Running' : '进行中' : item.endedAt !== undefined ? `${Math.max(0, (item.endedAt - item.startedAt) / 1000).toFixed(1)}s` : ''}</small><span className="canvas-agent-trace-chevron" aria-hidden="true">›</span></summary>
      <div className="canvas-agent-trace-detail">{item.toolName && <code>{item.toolName}</code>}<p>{item.detail || (item.label === 'reading-context' ? english ? 'Read the canvas references included in this request.' : '读取本次任务中的画布参考内容。' : item.label === 'proposing-plan' ? english ? 'Prepared a plan. This tool does not execute it.' : '已整理创作方案，此工具本身不执行方案。' : english ? 'Status reported by the canvas runtime.' : '状态由画布运行时报告。')}</p></div>
    </details></li>)}</ol>
    {phase && !reasoning?.active && !tools.some(item => item.status === 'running') && <div className="canvas-agent-phase" role="status"><span className="canvas-agent-activity-dot is-running" aria-hidden="true" />{LABELS[phase.label]?.[english ? 1 : 0] || (english ? 'Working' : '运行中')}</div>}
  </section>;
}

export function CanvasAgentMessageView({ message, english = false, disabled, onReuse, hideHeader = false, hideActions = false, beforeContent }: {
  message: CanvasAgentMessage & { streaming?: boolean; reasoningText?: string }; english?: boolean; disabled: boolean; onReuse: (text: string) => void; hideHeader?: boolean; hideActions?: boolean; beforeContent?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false), [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
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
    {message.reasoningText && <details className="canvas-agent-model-reasoning"><summary><TraceIcon kind="reasoning" /><span>{english ? 'Thought' : '已思考'}</span><span className="canvas-agent-trace-chevron" aria-hidden="true">›</span></summary><p>{message.reasoningText}</p></details>}
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
function ReasoningDisclosure({ message, active, now, english }: { message: TurnMessage; active: boolean; now: number; english: boolean }) {
  const content = useRef<HTMLParagraphElement>(null), following = useRef(true);
  const milliseconds = message.reasoningDurationMs === undefined ? undefined : message.reasoningDurationMs + (active && message.reasoningActiveStartedAt !== undefined ? Math.max(0, now - message.reasoningActiveStartedAt) : 0);
  const duration = activityDuration(milliseconds === undefined ? undefined : 0, milliseconds, english);
  useEffect(() => { if (active && following.current && content.current) content.current.scrollTop = content.current.scrollHeight; }, [message.reasoningText, active]);
  return <details className={`canvas-agent-model-reasoning${active ? ' is-running' : ''}`}>
    <summary><TraceIcon kind="reasoning" /><span className="canvas-agent-reasoning-caption">{active ? english ? 'Thinking' : '正在思考' : english ? 'Thought' : '已思考'}{duration && ` ${duration}`}</span><span className="canvas-agent-reasoning-preview">{reasoningPreview(message.reasoningText || '', active)}</span><span className="canvas-agent-trace-chevron" aria-hidden="true">›</span></summary>
    <p ref={content} tabIndex={0} aria-label={english ? 'Published reasoning' : '模型公开的思考内容'} onScroll={event => { const p = event.currentTarget; following.current = p.scrollHeight - p.scrollTop - p.clientHeight < 24; }}>{message.reasoningText}</p>
  </details>;
}
/** One user request, one assistant turn. Runtime identities stay intact inside it. */
export function CanvasAgentTurnView({ messages, activity = [], tools = [], progress = [], reasoning = false, busy = false, status, english = false, disabled, onReuse }: {
  messages: TurnMessage[]; activity?: readonly VisibleActivity[]; tools?: readonly CanvasAgentToolEvent[]; progress?: readonly CanvasAgentProgressSummary[];
  reasoning?: boolean; busy?: boolean; status?: string; english?: boolean; disabled: boolean; onReuse: (text:string)=>void;
}) {
  const now = useActivityClock(busy);
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

  const reasoningText = messages.map(message => message.reasoningText || '').filter(Boolean).join('\n\n');
  const hasProcess = !!reasoningText || !!tools.length || !!activity.length || !!progress.length || prior.some(message => !!message.text) || reasoning;
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
    {hasProcess && <details className="canvas-agent-turn-process">
      <summary><span className="canvas-agent-process-label">{label}{elapsed !== undefined ? ` · ${elapsed}` : ''}</span>{livePreview && <span className="canvas-agent-reasoning-preview">{livePreview}</span>}<span className="canvas-agent-trace-chevron" aria-hidden="true">›</span></summary>
      <div className="canvas-agent-turn-process-body">
        {folded.map((entry,index)=> entry.kind === 'tool' ? <CanvasAgentActivityView key={`tool-${entry.tool.callId}`} activity={[]} tools={[entry.tool]} english={english}/> : <div key={`phase-${index}`} className="canvas-agent-turn-phase">
          {entry.message.reasoningText && <ReasoningDisclosure message={entry.message} active={activelyReasoning && entry.index === messages.length - 1} now={now} english={english} />}
          {entry.index !== finalIndex && entry.message.text && <CanvasAgentMessageView message={{...entry.message,reasoningText:undefined}} english={english} disabled={disabled} onReuse={onReuse} hideHeader hideActions />}
        </div>)}
        <CanvasAgentActivityView activity={tools.length ? activity.filter(item=>item.kind !== 'tool') : activity} progress={progress} reasoning={!reasoningText && activelyReasoning ? {active:true}:undefined} english={english}/>

      </div>
    </details>}
    {response && <CanvasAgentMessageView message={{...response,reasoningText:undefined}} english={english} disabled={disabled} onReuse={onReuse} hideHeader />}
  </article>;
}
