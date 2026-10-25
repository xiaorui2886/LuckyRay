import { useEffect, useId, useRef, useState, type RefObject } from 'react';

export type CanvasAgentRailEntry = { key: string; question: string; answer: string };
const MAX_MARKS = 72;
/** Sample only the navigation marks, never the messages. Arrow keys still visit every request. */
export function sampleTurnMarks(count: number, active: number, focused: number | null = null): number[] {
  if (count <= MAX_MARKS) return Array.from({ length: count }, (_, i) => i);
  const marks = new Set(Array.from({ length: MAX_MARKS - 2 }, (_, i) => Math.round(i * (count - 1) / (MAX_MARKS - 3))));
  marks.add(active);
  if (focused !== null && focused >= 0 && focused < count) marks.add(focused);
  return [...marks].sort((a, b) => a - b);
}
function excerpt(value: string, limit: number) { return value.replace(/\s+/g, ' ').trim().slice(0, limit); }

/** A request index beside (not inside) the scrolling prose. No tool events become fake turns. */
export function CanvasAgentTurnRail({ entries, transcript, english, onNavigate }: {
  entries: readonly CanvasAgentRailEntry[]; transcript: RefObject<HTMLDivElement | null>; english: boolean; onNavigate: (last: boolean) => void;
}) {
  const [active, setActive] = useState(0), [preview, setPreview] = useState<number | null>(null), [focused, setFocused] = useState<number | null>(null);
  const rail = useRef<HTMLElement>(null);
  const id = useId();
  const identity = entries.map(entry => entry.key).join('|');
  useEffect(() => {
    const host = transcript.current;
    if (!host) return;
    let frame = 0;
    const anchors = [...host.querySelectorAll<HTMLElement>('[data-agent-query]')];
    const update = () => {
      frame = 0;
      const origin = host.getBoundingClientRect().top;
      const target = host.scrollTop + Math.min(80, host.clientHeight * .2);
      let low = 0, high = anchors.length - 1;
      // Binary search reads O(log turns) positions, including while the last reply streams.
      // No cached offsets become stale when an earlier disclosure expands.
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const position = anchors[mid].getBoundingClientRect().top - origin + host.scrollTop;
        if (position <= target) low = mid; else high = mid - 1;
      }
      setActive(low);
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    const resize = schedule;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(host);
    const log = host.querySelector<HTMLElement>('.canvas-r1-agent-messages');
    if (log) observer?.observe(log);
    // Observe message containers so streaming text / expanded tools invalidate offsets, without per-token DOM scans.
    for (const child of host.querySelectorAll<HTMLElement>('.canvas-r1-agent-messages > *')) observer?.observe(child);
    host.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', resize);
    update();
    return () => { observer?.disconnect(); host.removeEventListener('scroll', schedule); window.removeEventListener('resize', resize); if (frame) window.cancelAnimationFrame(frame); };
  }, [identity, transcript]);
  useEffect(() => { setPreview(null); setFocused(null); }, [identity]);
  if (!entries.length) return null;
  const selected = Math.min(active, entries.length - 1);
  const navigate = (index: number, focus = false) => {
    const host = transcript.current;
    const anchor = host?.querySelectorAll<HTMLElement>('[data-agent-query]')[index];
    if (!host || !anchor) return;
    onNavigate(false); // Even the last request may have a long answer; do not resume streaming follow implicitly.
    host.scrollTop = Math.max(0, anchor.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop - 12);
    setActive(index); setPreview(index);
    if (focus) setFocused(index);
    if (focus) window.requestAnimationFrame(() => rail.current?.querySelector<HTMLButtonElement>(`[data-turn-index="${index}"]`)?.focus());
  };
  const shown = preview === null ? undefined : entries[preview];
  return <nav ref={rail} className="canvas-agent-turn-rail" aria-label={english ? 'Conversation requests' : '对话轮次导航'} onMouseLeave={() => setPreview(null)}>
    <div className="canvas-agent-turn-marks">{sampleTurnMarks(entries.length, selected, focused).map(index => <button key={entries[index].key} type="button" data-turn-index={index}
      tabIndex={index === selected ? 0 : -1} className={index === selected ? 'is-current' : undefined} aria-current={index === selected ? 'step' : undefined}
      aria-label={english ? `Request ${index + 1}: ${excerpt(entries[index].question, 80)}` : `第 ${index + 1} 轮：${excerpt(entries[index].question, 80)}`}
      aria-describedby={preview === index ? `${id}-preview` : undefined} onMouseEnter={() => setPreview(index)} onFocus={() => { setPreview(index); setFocused(index); }}
      onBlur={event => { if (!(event.relatedTarget instanceof Node) || !rail.current?.contains(event.relatedTarget)) { setPreview(null); setFocused(null); } }} onClick={() => navigate(index)}
      onKeyDown={event => { const next = event.key === 'ArrowDown' ? Math.min(entries.length - 1, index + 1) : event.key === 'ArrowUp' ? Math.max(0, index - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : undefined;
        if (next !== undefined) { event.preventDefault(); navigate(next, true); } else if (event.key === 'Escape') setPreview(null);
      }}><span aria-hidden="true" /></button>)}</div>
    {shown && <div id={`${id}-preview`} role="tooltip" className="canvas-agent-turn-preview"><small>{english ? `Request ${preview! + 1} of ${entries.length}` : `第 ${preview! + 1} / ${entries.length} 轮`}</small><strong>{excerpt(shown.question, 180)}</strong>{shown.answer && <p>{excerpt(shown.answer, 260)}</p>}</div>}
  </nav>;
}
