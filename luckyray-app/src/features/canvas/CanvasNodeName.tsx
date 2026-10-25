import { useEffect, useRef, useState } from 'react';
import { CANVAS_MATERIAL_NAME_LIMIT } from '../../core/canvas/materialNaming';

/** A node's name is metadata, never its generation prompt. */
export function CanvasNodeName({ value, english = false, onCommit }: { value: string; english?: boolean; onCommit: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  const cancelBlur = useRef(false);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);
  const finish = () => {
    if (cancelBlur.current) { cancelBlur.current = false; return; }
    const name = draft.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, CANVAS_MATERIAL_NAME_LIMIT);
    setEditing(false);
    if (name && name !== value) onCommit(name);
  };
  return editing ? <input ref={input} className="canvas-node-name-input nodrag nopan nowheel" value={draft} maxLength={CANVAS_MATERIAL_NAME_LIMIT}
    aria-label={english ? 'Node name' : '节点名称'} onChange={event => setDraft(event.target.value)}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onBlur={finish} onKeyDown={event => {
      event.stopPropagation(); if (event.nativeEvent.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); finish(); }
      if (event.key === 'Escape') { event.preventDefault(); cancelBlur.current = true; setDraft(value); setEditing(false); }
    }} /> : <span className="canvas-node-name nodrag nopan" role="button" tabIndex={0} title={value}
    aria-label={`${english ? 'Rename node' : '重命名节点'}: ${value}`}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onDoubleClick={event => { event.stopPropagation(); cancelBlur.current = false; setDraft(value); setEditing(true); }}
    onKeyDown={event => { if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); event.stopPropagation(); cancelBlur.current = false; setDraft(value); setEditing(true); } }}>{value}</span>;
}
