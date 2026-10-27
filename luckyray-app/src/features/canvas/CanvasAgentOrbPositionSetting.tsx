import { useCanvasAgentOrbPlacement } from './useCanvasAgentOrbPlacement';
export function CanvasAgentOrbPositionSetting({ english }: { english: boolean }) {
  const { placement, update, saveFailed } = useCanvasAgentOrbPlacement();
  return <div className="canvas-agent-orb-position-setting">
    <button type="button" className="canvas-settings-toggle" aria-pressed={placement.locked} onClick={() => update({ locked: !placement.locked })}>
      <span><strong>{english ? 'Lock black hole position' : '锁定黑洞位置'}</strong><small>{english ? 'Drag the Agent entrance to place it. Lock to keep it there.' : '拖动 Agent 入口调整位置，锁定后不再移动。'}</small></span>
      <i className={placement.locked ? 'is-on' : ''}><b /></i>
    </button>
    {placement.position && <button type="button" className="canvas-agent-orb-reset" onClick={() => update({ position: null })}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 8a6 6 0 1 1 .9 6M4 4v4h4" /></svg><span>{english ? 'Reset entrance position' : '恢复入口默认位置'}</span></button>}
    {saveFailed && <small role="status" className="canvas-agent-orb-save-error">{english ? 'This position could not be saved. Try again.' : '当前位置未能保存，请重试。'}</small>}
  </div>;
}
