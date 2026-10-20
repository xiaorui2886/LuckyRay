import { CanvasAgentBlackHole } from './CanvasAgentBlackHole';
import './canvasAgentOrb.css';

type Props = { busy: boolean; unavailable: boolean; english: boolean; controls?: string; onOpen: () => void };
/** A launcher only: the panel and its running session remain mounted beside it. */
export function CanvasAgentOrb({ busy, unavailable, english, controls, onOpen }: Props) {
  const status = busy ? english ? 'Working' : '正在处理' : unavailable ? english ? 'Connection unavailable' : '连接暂不可用' : english ? 'Ready' : '就绪';
  return <button type="button" className={`canvas-agent-orb nodrag nopan${busy ? ' is-busy' : ''}${unavailable ? ' is-unavailable' : ''}`}
    aria-label={english ? 'Expand Agent' : '展开 Agent'} aria-expanded="false" aria-controls={controls} title={`Agent · ${status}`} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onOpen(); }}>
    <CanvasAgentBlackHole busy={busy} unavailable={unavailable} />
    <span className="canvas-agent-orb-status" aria-hidden="true" />
    <span className="canvas-r1-agent-sr-only" role="status">{status}</span>
  </button>;
}
