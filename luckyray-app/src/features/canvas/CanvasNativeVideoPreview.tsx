import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../core/i18n';
import { CanvasVideoFrame } from './CanvasVideoFrame';
import { NativeFilmTransport, nativeComfyVideoAvailable, nativeFilmAvailable, transientNativeVideoError } from '../materials/nativeFilmTransport';
import { nativeVideoMetadata } from '../materials/nativeVideoPreview';
import { materialLibrarySession, type MaterialLibraryRegistry } from '../../core/services/materialLibraryContext';
import { observeCanvasVideoSurface, videoSurfaceBounds } from '../materials/nativeVideoSurface';
export {comfyVideoResultName} from './comfyVideoCover';

export type CanvasAudioOwner = { muted: boolean; pause(): void };
// The host has one decoder. Release the previous surface before claiming it,
// including a late open, so two canvas cards never compete for the same HWND.
let releaseCurrent: (() => void) | undefined;

/** Original file, original decoder output; no preview transcode or library import. */
export function CanvasNativeVideoPreview({ resultName, assetId, poster, metadata, selected, visible, onAspectRatio, onAudioClaim, mode = 'card' }: ({resultName: string; assetId?: never} | {assetId: string; resultName?: never}) & {
  poster?: string; metadata?: {width: number; height: number; duration: number}; selected: boolean; visible: boolean;
  onAspectRatio?: (ratio: number) => void;
  onAudioClaim: (owner: CanvasAudioOwner, audible: boolean) => void;
  mode?: 'card' | 'thumbnail';
}) {
  const { t } = useI18n();
  const identity = resultName ? `comfy:${resultName}` : `asset:${assetId}`;
  const surface = useRef<HTMLDivElement>(null);
  const player = useRef<NativeFilmTransport | null>(null);
  const opening = useRef<Promise<NativeFilmTransport | null> | null>(null);
  const metadataRequest = useRef<AbortController | null>(null);
  const dispose = useRef<(() => void) | null>(null);
  const epoch = useRef(0), hovered = useRef(false), manual = useRef(false), wantedPlay = useRef(false), wantedSound = useRef(false);
  const moving = useRef(false), warmFrame = useRef<(() => Promise<void>) | null>(null);
  const callbacks = useRef({ onAspectRatio, onAudioClaim, visible }); callbacks.current = { onAspectRatio, onAudioClaim, visible };
  const [ready, setReady] = useState(false), [failed, setFailed] = useState(false);
  const [ratio, setRatio] = useState(() => metadata && metadata.width > 0 && metadata.height > 0 ? metadata.width / metadata.height : 16 / 9);
  const [intrinsicWidth, setIntrinsicWidth] = useState(() => metadata?.width || 300);
  const [frame, setFrame] = useState<{name: string; src: string} | null>(null);
  const [state, setState] = useState({ time: 0, duration: metadata?.duration || 0, paused: true, muted: true });
  useEffect(() => {
    if (!metadata || player.current) return;
    if (metadata.width > 0 && metadata.height > 0) {setIntrinsicWidth(metadata.width); setRatio(metadata.width / metadata.height); callbacks.current.onAspectRatio?.(metadata.width / metadata.height);}
    if (metadata.duration > 0) setState(s => ({...s, duration: metadata.duration}));
  }, [identity, metadata]);

  const stop = useCallback(() => {
    epoch.current++; opening.current = null;
    metadataRequest.current?.abort(); metadataRequest.current = null;
    wantedPlay.current = false; wantedSound.current = false; hovered.current = false; manual.current = false;
    moving.current = false; warmFrame.current = null;
    dispose.current?.(); dispose.current = null;
    const p = player.current; player.current = null;
    if (p) { callbacks.current.onAudioClaim(p, false); p.close(); }
    if (releaseCurrent === stop) releaseCurrent = undefined;
    setReady(false); setState(s => ({ ...s, paused: true, muted: true }));
  }, []);

  const ensure = useCallback((): Promise<NativeFilmTransport | null> => {
    if (player.current) return Promise.resolve(player.current);
    if (opening.current) return opening.current;
    if (document.hidden || !callbacks.current.visible) return Promise.resolve(null);
    if (releaseCurrent !== stop) releaseCurrent?.();
    releaseCurrent = stop;
    const attempt = ++epoch.current;
    const valid = () => attempt === epoch.current && !document.hidden && callbacks.current.visible;
    const promise = (async () => {
      let p: NativeFilmTransport | null = null;
      try {
        if (!await (resultName ? nativeComfyVideoAvailable(mode === 'thumbnail') : nativeFilmAvailable(mode === 'thumbnail'))) throw Error('native-video-unavailable');
        if (!valid() || !surface.current) return null;
        const fail = (error: unknown) => {
          if (!valid() || transientNativeVideoError(error)) return;
          stop(); setFailed(true);
        };
        const bounds = () => mode === 'thumbnail' ? {x: 0, y: 0, width: 1, height: 1} : videoSurfaceBounds(surface.current!);
        if (resultName) {
          p = new NativeFilmTransport(fail);
          await p.openComfy(resultName, bounds(), mode === 'thumbnail');
        } else {
          // Canvas's existing material bridge is the legacy catalog, independent
          // of the materials page's active library. Never infer a scope from a URL.
          const registry = await materialLibrarySession.request<MaterialLibraryRegistry>({op: 'registry', include_hidden: false}, null);
          if (!valid()) return null;
          if (!assetId || !registry.legacyId) throw Error('native-video-source-unavailable');
          const controller = new AbortController(); metadataRequest.current = controller;
          const source = await nativeVideoMetadata(registry.legacyId, assetId, controller.signal, true);
          if (!valid() || !surface.current) return null;
          p = new NativeFilmTransport(fail);
          await p.open(registry.legacyId, assetId, source.sourceRevision, bounds(), mode === 'thumbnail');
        }
        if (!valid()) { p.close(); return null; }
        p.muted = !wantedSound.current;
        player.current = p;
        const snapshot = await p.snapshot();
        if (!valid()) { p.close(); return null; }
        if (snapshot.width <= 0 || snapshot.height <= 0) throw Error('native-video-no-picture');
        setIntrinsicWidth(snapshot.width);
        setRatio(snapshot.width / snapshot.height);
        callbacks.current.onAspectRatio?.(snapshot.width / snapshot.height);
        let reading = false, lastFrameTime = -1;
        const readFrame = async () => {
          if (reading || !valid() || !p) return;
          reading = true;
          try {const picture = await p.previewFrame(); if (valid()) {lastFrameTime = picture.time; setFrame({name: identity, src: picture.src});}}
          catch { /* Keep the last decoded cover while a seek/frame settles. */ }
          finally {reading = false;}
        };
        warmFrame.current = readFrame;
        await readFrame();
        if (!valid()) {p.close(); return null;}
        const restore = mode === 'thumbnail' ? () => {} : observeCanvasVideoSurface(surface.current!, p, fail, active => {moving.current = active; if (active) void readFrame();});
        let timer: ReturnType<typeof setTimeout> | undefined;
        dispose.current = () => { clearTimeout(timer); restore(); };
        setReady(true); setFailed(false);
        const poll = async () => {
          if (!valid() || !p) return;
          const start = performance.now();
          try {
            const s = await p.snapshot();
            if (!valid()) return;
            setState({ time: s.time, duration: s.duration, paused: s.paused, muted: p.muted });
            if (mode === 'thumbnail' || moving.current || (s.paused && !s.seeking && Math.abs(s.time - lastFrameTime) > .01)) await readFrame();
            if (s.ended) { manual.current = false; wantedPlay.current = false; }
          } catch (error) { fail(error); }
          if (valid()) timer = setTimeout(() => void poll(), Math.max(0, (mode === 'thumbnail' || moving.current ? 1000 / 15 : 100) - (performance.now() - start)));
        };
        void poll();
        p.muted = !wantedSound.current;
        callbacks.current.onAudioClaim(p, wantedSound.current);
        if (wantedPlay.current) await p.play();
        return p;
      } catch {
        p?.close();
        if (valid()) { stop(); setFailed(true); }
        return null;
      } finally { if (attempt === epoch.current) opening.current = null; }
    })();
    opening.current = promise; return promise;
  }, [resultName, assetId, identity, mode, stop]);

  useEffect(() => {
    const hide = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', hide); window.addEventListener('blur', stop);
    return () => { document.removeEventListener('visibilitychange', hide); window.removeEventListener('blur', stop); stop(); };
  }, [identity, mode, stop]);
  useEffect(() => { if (!visible) stop(); }, [visible, stop]);
  useEffect(() => {
    if (selected && visible && mode === 'card') { void ensure(); return; }
    manual.current = false; wantedSound.current = false;
    if (!hovered.current) wantedPlay.current = false;
    if (player.current) { player.current.muted = true; callbacks.current.onAudioClaim(player.current, false); if (!hovered.current) player.current.pause(); }
  }, [selected, visible, mode, ensure]);

  const play = async (audible: boolean, explicit: boolean) => {
    wantedPlay.current = true; wantedSound.current = audible; manual.current = explicit;
    const p = await ensure(); if (!p || !wantedPlay.current) return;
    callbacks.current.onAudioClaim(p, audible); p.muted = !audible;
    try { if (p.ended) p.currentTime = 0; await p.play(); } catch { stop(); setFailed(true); }
  };
  const pause = () => { wantedPlay.current = false; manual.current = false; player.current?.pause(); setState(s => ({ ...s, paused: true })); };
  const picture = frame?.name === identity ? frame.src : poster;
  return <CanvasVideoFrame className="canvas-native-video" dimensions={{width: intrinsicWidth, height: intrinsicWidth / ratio}}
    selected={selected} playing={!state.paused} muted={state.muted} time={state.time} duration={state.duration} variant={mode}
    onPlayPause={() => state.paused ? void play(true, true) : pause()}
    onSeek={fraction => {if (player.current) player.current.currentTime = fraction * state.duration;}}
    onSound={() => {
      if (!player.current || player.current.muted) void play(true, true);
      else {wantedSound.current = false; player.current.muted = true; callbacks.current.onAudioClaim(player.current, false); setState(s => ({...s, muted: true}));}
    }}
    onPointerDownCapture={event => {if (mode === 'card' && !(event.target as HTMLElement).closest('.canvas-video-controls')) void warmFrame.current?.();}}
    onMouseEnter={() => { hovered.current = true; if (!manual.current) void play(false, false); }}
    onMouseLeave={() => { hovered.current = false; if (!manual.current) pause(); }}>
    <div ref={surface} className="canvas-native-video-surface" data-native-canvas-picture="true">
      {picture ? <img src={picture} alt="" /> : !ready && failed ? <span>{t('editor.canvas.node.videoUnavailable')}</span> : null}
    </div>
  </CanvasVideoFrame>;
}
