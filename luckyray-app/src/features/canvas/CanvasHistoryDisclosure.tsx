import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Native disclosure: ordinary Tab navigation, no misleading menu keyboard contract. */
export function CanvasHistoryDisclosure({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.button !== 0 || event.isPrimary === false) return;
      if (ref.current && !event.composedPath().includes(ref.current)) ref.current.open = false;
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);
  return <details ref={ref} className="canvas-history-disclosure" onToggle={event => setOpen(event.currentTarget.open)}
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.nativeEvent.isComposing || !ref.current?.open) return;
      event.preventDefault(); event.stopPropagation();
      ref.current.open = false;
      ref.current.querySelector('summary')?.focus();
    }}>
    <summary aria-label={label} title={label}><span aria-hidden="true">···</span></summary>
    <div className="canvas-history-disclosure-content">{children}</div>
  </details>;
}
