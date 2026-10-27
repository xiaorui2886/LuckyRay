import { useEffect, useRef, useState } from 'react';
import { CanvasReferencePreview, referencePreviewUrl } from './CanvasReferencePreview';

/** Mounted only for the active hover. Uses the same asset URL video path as canvas cards. */
export function CanvasHoverVideo({ source, poster, label, unavailable, onDimensions }: {
  source?: string | null; poster?: string | null; label: string; unavailable: string;
  onDimensions?: (width: number, height: number) => void;
}) {
  const url = referencePreviewUrl(source), video = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false), [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = video.current;
    setReady(false); setFailed(false);
    if (!element || !url) return;
    element.src = url;
    element.muted = true;
    const play = () => { if (!document.hidden) void element.play().catch(() => {}); };
    const visibility = () => document.hidden ? element.pause() : play();
    element.addEventListener('canplay', play);
    document.addEventListener('visibilitychange', visibility);
    play();
    return () => {
      element.removeEventListener('canplay', play);
      document.removeEventListener('visibilitychange', visibility);
      element.pause(); element.removeAttribute('src'); element.load();
    };
  }, [url]);
  return <div className="canvas-hover-video" style={{ position:'relative', width:'100%', height:'100%', overflow:'hidden' }}>
    {(!ready || failed) && <CanvasReferencePreview thumbnail={poster} label={label} unavailable={url && !failed ? '' : unavailable} />}
    {url && <video ref={video} src={url} muted loop playsInline preload="metadata" aria-label={label}
      style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'contain', opacity:ready && !failed ? 1 : 0, pointerEvents:'none' }}
      onLoadedMetadata={event => { const media = event.currentTarget; if (media.videoWidth > 0 && media.videoHeight > 0) onDimensions?.(media.videoWidth, media.videoHeight); }}
      onLoadedData={() => setReady(true)} onError={() => { video.current?.pause(); setFailed(true); }} />}
  </div>;
}
