import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { useI18n } from '../../core/i18n';
import { generatorCardDimensions } from '../../core/canvas/storyboardLayout';

// Both decoders use the same card, geometry and controls. Only the picture
// element and transport callbacks differ; a loading poster is never its size.
export function CanvasVideoFrame({ children, dimensions, selected, playing, muted, time, duration,
  onPlayPause, onSound, onSeek, variant = 'card', className = '', ...events }: {
  children: ReactNode;
  dimensions?: { width: number; height: number };
  selected: boolean; playing: boolean; muted: boolean; time: number; duration: number;
  onPlayPause(): void; onSound(): void; onSeek(fraction: number): void;
  variant?: 'card' | 'thumbnail';
  className?: string;
} & Pick<HTMLAttributes<HTMLDivElement>, 'onMouseEnter' | 'onMouseLeave' | 'onPointerDownCapture'>) {
  const { t } = useI18n();
  const size = dimensions && dimensions.width > 0 && dimensions.height > 0 ? dimensions : {width: 300, height: 300 * 9 / 16};
  const ratio = size.width / size.height;
  const preset = generatorCardDimensions(ratio);
  const width = Math.min(size.width, preset.width, preset.height * ratio);
  const progress = duration > 0 ? Math.min(100, Math.max(0, time / duration * 100)) : 0;
  const clock = (value: number) => {
    if (!Number.isFinite(value) || value < 0) return '0:00';
    return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
  };
  return <div className={`canvas-video-preview ${className} ${variant === 'thumbnail' ? 'is-thumbnail' : ''} ${selected ? 'is-selected' : ''} ${playing ? 'is-playing' : ''}`}
    style={{'--canvas-video-width': `${width}px`, '--canvas-video-ratio': ratio} as CSSProperties} {...events}>
    {children}
    {variant === 'card' && <div className="canvas-video-controls nodrag nopan" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      <div className="canvas-video-control-row">
        <button type="button" className="canvas-video-toggle" aria-label={t(playing ? 'editor.canvas.node.pauseVideo' : 'editor.canvas.node.playVideo')} onClick={onPlayPause}>
          <svg viewBox="0 0 18 18" aria-hidden="true">{playing ? <path d="M6 5v8M12 5v8" /> : <path className="canvas-video-play-glyph" d="m7 5 6 4-6 4Z" />}</svg>
        </button>
        <div className="canvas-video-progress" title={t('editor.canvas.node.seekHint')} onPointerDown={event => {
          event.currentTarget.setPointerCapture(event.pointerId);
          const box = event.currentTarget.getBoundingClientRect();
          if (box.width > 0) onSeek(Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)));
        }} onPointerMove={event => {
          if (!event.buttons) return;
          const box = event.currentTarget.getBoundingClientRect();
          if (box.width > 0) onSeek(Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)));
        }}>
          <span className="canvas-video-progress-fill" style={{width: `${progress}%`}} /><i className="canvas-video-progress-thumb" style={{left: `${progress}%`}} />
        </div>
        <span className="canvas-video-time">{clock(time)} / {clock(duration)}</span>
        <button type="button" className="canvas-video-toggle" aria-label={t(muted ? 'editor.canvas.node.unmuteVideo' : 'editor.canvas.node.muteVideo')} aria-pressed={!muted} onClick={onSound}>
          <svg viewBox="0 0 18 18" aria-hidden="true"><path d="M8 4 4.5 7H2v4h2.5L8 14Z" />{muted ? <path d="m11 7 4 4m0-4-4 4" /> : <path d="M11 6a4 4 0 0 1 0 6m2-8a7 7 0 0 1 0 10" />}</svg>
        </button>
      </div>
    </div>}
  </div>;
}
