import { useEffect, useRef } from 'react';
import { useCanvasReducedMotion } from './CanvasMotionContext';
import { mountBlackHole } from './canvasBlackHoleRenderer';
import './canvasAgentOrb.css';

/** Shared decorative mark. No button, label, or session state of its own. */
export function CanvasAgentBlackHole({ busy = false, unavailable = false, detailScale = 1, animated = true }: { busy?: boolean; unavailable?: boolean; detailScale?: number; animated?: boolean }) {
  const reduced = useCanvasReducedMotion();
  const animate = animated && !reduced;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<ReturnType<typeof mountBlackHole>>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Static/reduced-motion marks still paint the exact same disk, never a different logo.
    renderer.current = mountBlackHole(canvas, { busy: false, unavailable: false }, detailScale, animate);
    canvas.dataset.ready = renderer.current ? 'true' : 'false';
    return () => { renderer.current?.dispose(); renderer.current = null; };
  }, [detailScale, animate]);
  useEffect(() => { renderer.current?.update({ busy, unavailable }); }, [busy, unavailable, detailScale, animate]);
  return (<span className="canvas-agent-orb-visual" data-motion={animate ? "flow" : "still"} aria-hidden="true">
      <svg className="canvas-agent-orb-fallback" viewBox="0 0 88 64" focusable="false">
        <g transform="translate(44 32) rotate(-15)">
          <ellipse rx="34" ry="16" fill="#151b36" opacity=".45" />
          <ellipse rx="29" ry="13" fill="none" stroke="#68709d" strokeWidth="3" opacity=".65" />
          <ellipse rx="25" ry="11" fill="none" stroke="#a09ab9" strokeWidth="1" opacity=".7" />
          <ellipse rx="19" ry="8.8" fill="#03040b" />
        </g>
      </svg>
      <canvas ref={canvasRef} className="canvas-agent-orb-black-hole" />
    </span>);
}
