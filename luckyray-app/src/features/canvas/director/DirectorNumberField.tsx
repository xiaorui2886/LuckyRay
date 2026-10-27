import { createContext, useContext, useEffect, useRef, useState } from 'react';

/** A gesture previews locally; only its final value enters document history/storage. */
export const DirectorNumericGesture = createContext<{
  begin: () => void; finish: () => void; cancel: () => void; source: unknown;
} | null>(null);

type Props = { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void; className?: string; english?: boolean };
export function DirectorNumberField({ label, value, min, max, step = .1, onChange, className = 'director-number', english = false }: Props) {
  const transaction = useContext(DirectorNumericGesture);
  const latest = useRef({ value, onChange, transaction }); latest.current = { value, onChange, transaction };
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(String(value)), [editing, setEditing] = useState(false), [dragging, setDragging] = useState(false);
  const gesture = useRef<{ id: number; startX: number; lastX: number; value: number; initial: number; active: boolean } | null>(null);
  const cancelled = useRef(false), dirty = useRef(false), composing = useRef(false);
  const pending = useRef<number | null>(null), frame = useRef<number | null>(null);
  const precision = Math.min(8, Math.max(3, Math.ceil(-Math.log10(step)) + 2));
  const normalize = (n: number) => Number(Math.min(max, Math.max(min, n)).toFixed(precision));
  const display = (n: number) => String(Number(n.toFixed(precision)));
  const flush = () => { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; const next = pending.current; pending.current = null; if (next !== null) { setDraft(display(next)); latest.current.onChange(next); } };
  const release = () => { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; pending.current = null; const g = gesture.current; gesture.current = null; if (g && input.current?.hasPointerCapture?.(g.id)) input.current.releasePointerCapture(g.id); setDragging(false); };
  const cancel = () => {
    const g = gesture.current; release(); cancelled.current = true; dirty.current = false;
    if (g?.active) { if (latest.current.transaction) latest.current.transaction.cancel(); else latest.current.onChange(g.initial); }
    setDraft(display(g?.initial ?? latest.current.value)); setEditing(false);
  };
  useEffect(() => { if (!gesture.current?.active) setDraft(display(value)); }, [value]);
  // External document replacement invalidates even a same-ID gesture, never replay stale edits.
  useEffect(() => { release(); dirty.current = false; setDraft(display(latest.current.value)); setEditing(false); }, [transaction?.source]);
  useEffect(() => {
    const blur = () => { if (gesture.current) cancel(); };
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('blur', blur); if (frame.current !== null) cancelAnimationFrame(frame.current); pending.current = null; if (gesture.current?.active) latest.current.transaction?.cancel(); gesture.current = null; };
  }, []);
  const commitText = () => {
    if (gesture.current) { cancel(); return; }
    const n = Number(draft);
    if (dirty.current && !cancelled.current && draft.trim() && Number.isFinite(n)) latest.current.onChange(normalize(n));
    cancelled.current = false; dirty.current = false; setEditing(false); setDraft(display(latest.current.value));
  };
  return <label className={`${className} director-scrub-number${dragging ? ' is-dragging' : ''}`}><span>{label}</span><input
    ref={input} type="number" value={draft} min={min} max={max} step={step} aria-label={label}
    title={english ? 'Drag left/right · Shift for precision · Click or Enter to type' : '左右拖动调整 · Shift 精细调整 · 单击或回车输入'}
    readOnly={!editing} onFocus={() => { cancelled.current = false; }}
    onChange={e => { cancelled.current = false; dirty.current = true; setDraft(e.target.value); }} onBlur={commitText}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
    onPointerDown={e => {
      if (e.button !== 0 || editing || e.currentTarget.matches(':disabled')) return;
      e.preventDefault(); e.stopPropagation(); cancelled.current = false;
      gesture.current = { id: e.pointerId, startX: e.clientX, lastX: e.clientX, value, initial: value, active: false };
      e.currentTarget.setPointerCapture?.(e.pointerId); e.currentTarget.focus();
    }}
    onPointerMove={e => {
      const g = gesture.current; if (!g || g.id !== e.pointerId) return;
      if (e.currentTarget.matches(':disabled')) { cancel(); return; }
      if (!g.active && Math.abs(e.clientX - g.startX) < 3) return;
      if (!g.active) { g.active = true; latest.current.transaction?.begin(); setDragging(true); }
      // Integrating deltas avoids a jump when Shift is pressed/released mid-drag.
      g.value = Math.min(max, Math.max(min, g.value + (e.clientX - g.lastX) * step / (e.shiftKey ? 50 : 5)));
      g.lastX = e.clientX; const next = normalize(g.value); pending.current = next; if (frame.current === null) frame.current = requestAnimationFrame(flush);
      e.preventDefault(); e.stopPropagation();
    }}
    onPointerUp={e => {
      const g = gesture.current; if (!g || g.id !== e.pointerId) return;
      e.preventDefault(); e.stopPropagation(); if (g.active) flush(); release();
      if (g.active) { latest.current.transaction?.finish(); requestAnimationFrame(() => { if (input.current) setDraft(display(latest.current.value)); }); }
      else { setEditing(true); requestAnimationFrame(() => input.current?.select()); }
    }}
    onPointerCancel={() => cancel()} onLostPointerCapture={() => { if (gesture.current) cancel(); }}
    onKeyDown={e => {
      if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) { e.stopPropagation(); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); e.currentTarget.blur(); return; }
      if (gesture.current) return;
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (editing) e.currentTarget.blur(); else { setEditing(true); requestAnimationFrame(() => input.current?.select()); } }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault(); const n = editing && draft.trim() && Number.isFinite(Number(draft)) ? Number(draft) : value;
        const next = normalize(n + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? .1 : 1));
        latest.current.onChange(next); dirty.current = false; setDraft(display(next));
      } else if (!editing && /^[0-9.+-]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); cancelled.current = false; dirty.current = true; setEditing(true); setDraft(e.key); }
    }}/></label>;
}
