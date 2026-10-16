import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { MaterialAsset } from "../../core/services/materialCatalog";
import { materialLibrarySession } from "../../core/services/materialLibraryContext";
import { adaptMaterialAssetMedia } from "../../core/services/materialAssetAdapter";
import { cachedFilmstrip, retainFilmstrip, displayedFilmFrame, filmstrip, filmThumbnailCount, filmTime, filmPreciseTime, parseFilmPosition, type FilmMark, type FilmMarks, type FilmThumbnail } from "./materialFilmTools";
import { MaterialFilmTimeline } from "./MaterialFilmTimeline";
import { FilmIcon } from "./FilmIcon";
import { createPortal } from "react-dom";
import { NativeFilmTransport, nativeFilmAvailable, transientNativeVideoError } from "./nativeFilmTransport";
import { nativeFilmstrip } from "./nativeVideoPreview";
import { cachedNativeVideoCover } from "./nativeVideoCoverCache";
import { observeVideoSurface } from "./nativeVideoSurface";
import { useMaterialViewerHost } from "./useMaterialViewerHost";
import "./materialFilmViewer.css";
import {useMaterialViewScope} from './MaterialViewContext';

type FrameResult = { assets: MaterialAsset[]; importedCount: number; skippedDuplicateCount: number; failedItems: { error: string }[] };
type Props = { onNativeElement?: (element: HTMLElement | null) => void; asset: MaterialAsset; libraryId: string; resolveSource: (asset: MaterialAsset) => Promise<string>; onClose: () => void; onFrame: (asset: MaterialAsset) => void; renderDetails?: (resolution: { width: number; height: number } | null, close: () => void, duration: number) => ReactNode };
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

// Keyed by the parent on immutable library/asset/source identity: late work may
// finish in its original catalog, but must never touch the next video's UI.
export function MaterialFilmViewer({ onNativeElement, asset, libraryId, resolveSource, onClose, onFrame, renderDetails }: Props) {
  const scope=useMaterialViewScope();const visible=scope?.visible??true;
  const retainedPosition=useRef<number|null>(null);
  const portalHost = useMaterialViewerHost();
  const root = useRef<HTMLElement>(null), video = useRef<HTMLVideoElement>(null), live = useRef(true);
  useLayoutEffect(() => { onNativeElement?.(root.current); return () => onNativeElement?.(null); }, [onNativeElement]);
  const stage = useRef<HTMLDivElement>(null), native = useRef<NativeFilmTransport | null>(null);
  const [nativeReady, setNativeReady] = useState(false), [nativeOpening, setNativeOpening] = useState(true);
  const openingPoster = cachedNativeVideoCover(libraryId,asset)?.src || asset.thumbnailUrl;
  const player = () => native.current ?? video.current;
  const startPlayback = () => native.current ? native.current.play(playbackRange.current) : video.current?.play() ?? Promise.resolve();
  const [bounds, setBounds] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [source, setSource] = useState(""); const [failure, setFailure] = useState("");
  const [duration, setDuration] = useState(0), [time, setTime] = useState(0), [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(.7), [line, setLine] = useState(true), [thumbs, setThumbs] = useState<FilmThumbnail[]>([]);
  const [videoAspect, setVideoAspect] = useState(16 / 9);
  const [thumbState, setThumbState] = useState<"loading" | "ready" | "partial" | "unavailable">("loading");
  const thumbCount = filmThumbnailCount(Math.max(0, bounds.width - 52), videoAspect);
  const [muted, setMuted] = useState(false), [markList, setMarkList] = useState(false);
  const [positionEdit, setPositionEdit] = useState<string | null>(null), [positionError, setPositionError] = useState("");
  const scrubResume = useRef(false), scrubbing = useRef(false), positionInput = useRef<HTMLInputElement>(null);
  const [annotations, setAnnotations] = useState<FilmMarks | null>(null), [selected, setSelected] = useState<string | null>(null);
  const [range, setRange] = useState<{ start: number | null; end: number | null; note: string } | null>(null);
  const playbackRange = useRef<{ start: number; end: number; loop: boolean } | null>(null);
  const [looping, setLooping] = useState(false), [hint, setHint] = useState("");
  const [savedFrame, setSavedFrame] = useState<MaterialAsset | null>(null), [capturing, setCapturing] = useState(false);
  const [pending, setPending] = useState(0), [writeError, setWriteError] = useState("");
  const writes = useRef(Promise.resolve()); const dirty = useRef(new Map<string, FilmMark | null>());
  const busy = useRef(false), displayedTime = useRef<number | null>(null);
  const frozenFrame = useRef<{ time: number; bytes: number[] } | null>(null);
  const [frameRetry, setFrameRetry] = useState(false), [details, setDetails] = useState(false);
  const pendingKey = (revision: string) => `luckyray-material-film-pending:${libraryId}:${asset.id}:${revision}`;
  const retainPending = (revision: string) => {
    // Recovery copy only; native Catalog ACK is the sole saved authority.
    try { if (dirty.current.size) localStorage.setItem(pendingKey(revision), JSON.stringify([...dirty.current])); else localStorage.removeItem(pendingKey(revision)); }
    catch { if (live.current) setWriteError("本地恢复副本不可写，请等待原生保存完成后再关闭"); }
  };

  useLayoutEffect(() => {
    const update = () => { const main = document.querySelector(".react-nav-shell .main"); const rect = main?.getBoundingClientRect(); const top = main?.querySelector(".titlebar")?.getBoundingClientRect().bottom ?? rect?.top ?? 0;
      setBounds({ left: rect?.left ?? 0, top, width: rect?.width ?? window.innerWidth, height: Math.max(0, (rect?.bottom ?? window.innerHeight)-top) }); };
    update(); const observer = new ResizeObserver(update); const main = document.querySelector(".react-nav-shell .main"); if (main) observer.observe(main);
    window.addEventListener("resize", update); root.current?.focus();
    return () => { observer.disconnect(); window.removeEventListener("resize", update); };
  }, []);
  useEffect(() => {
    if (!annotations||!visible) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined;
    let transport: NativeFilmTransport | null = null;
    let stopSurface: (() => void) | undefined;
    setNativeReady(false);
    void nativeFilmAvailable().then(async available => {
      if (cancelled) return;
      if (!available) { setNativeOpening(false); return; }
      const rect = stage.current?.getBoundingClientRect(); if (!rect) return;
      video.current?.pause(); setNativeOpening(true);
      transport = new NativeFilmTransport(e => { if (!cancelled) setFailure(`原生播放未完成：${errorText(e)}`); });
      try {
        const scale = window.devicePixelRatio;
        await transport.open(libraryId, asset.id, annotations.sourceRevision, { x: Math.round(rect.x*scale), y: Math.round(rect.y*scale), width: Math.max(1,Math.round(rect.width*scale)), height: Math.max(1,Math.round(rect.height*scale)) });
        if (cancelled) { transport.close(); return; }
        native.current = transport; setNativeReady(true); setNativeOpening(false); setFailure("");
        if(retainedPosition.current!==null){transport.currentTime=retainedPosition.current;transport.pause();setPlaying(false);}
        if (stage.current) stopSurface = observeVideoSurface(stage.current, transport, e => { if (!cancelled) setFailure(errorText(e)); });
        const poll = async () => {
          if (cancelled || !transport) return;
          try { const s = await transport.snapshot(); if (!cancelled) { setDuration(s.duration); if (!scrubbing.current) setTime(s.time); setPlaying(!s.paused); if (s.width && s.height) setVideoAspect(s.width/s.height); } }
          catch (e) { if (!transientNativeVideoError(e)) { if (!cancelled) { setPlaying(false); setFailure(`原生视频会话已停止：${errorText(e)}`); } return; } }
          if (!cancelled) timer = setTimeout(() => void poll(), 80);
        };
        void poll();
      } catch (e) { transport.close(); if (!cancelled) { setNativeOpening(false); setFailure(`原生视频无法打开：${errorText(e)}`); } }
    });
    return () => { cancelled = true; clearTimeout(timer); stopSurface?.();if(transport&&scope)retainedPosition.current=transport.currentTime;transport?.close(); native.current = null; };
  }, [annotations?.sourceRevision,visible]);
  useEffect(()=>{if(!visible){video.current?.pause();setPlaying(false);}},[visible]);
  useEffect(() => {
    live.current = true;
    void resolveSource(asset).then(url => { if (live.current) { if (!url) setFailure("视频原文件不可用"); else setSource(url); } }).catch(e => { if (live.current) setFailure(errorText(e)); });
    void materialLibrarySession.request<FilmMarks>({ op: "videoMarks", id: asset.id }, libraryId).then(value => {
      if (!live.current) return;
      try { const recovered = JSON.parse(localStorage.getItem(pendingKey(value.sourceRevision)) || "[]") as [string,FilmMark|null][];
        if (Array.isArray(recovered) && recovered.length<=512) for (const [id,m] of recovered) {
          if (typeof id!=="string" || (m && (m.id!==id || typeof m.note!=="string" || !Number.isFinite(m.start)))) continue;
          dirty.current.set(id,m); value.marks=value.marks.filter(row=>row.id!==id); if (m) value.marks.push(m);
        }
        if(dirty.current.size)setWriteError("已恢复未保存的标记，请重试保存");
      } catch { setWriteError("标记恢复副本无法读取；原生已保存记录保持不变"); }
      setAnnotations(value);
    }).catch(e => { if (live.current) setFailure(`无法读取视频标记：${errorText(e)}`); });
    return () => { live.current = false; };
  }, []);
  useEffect(() => {
    const key = JSON.stringify([libraryId, asset.id, annotations?.sourceRevision, source, thumbCount, nativeReady]);
    if (!source || !annotations || line || nativeOpening) return;
    const cached = cachedFilmstrip(key);
    if (cached) { setThumbs(cached); setThumbState("ready"); return; }
    const controller = new AbortController(); setThumbState("loading"); setThumbs([]);
    const progress = (images: FilmThumbnail[]) => {
      if (!controller.signal.aborted && live.current) setThumbs(images);
    };
    const timer = setTimeout(() => { void (nativeReady ? nativeFilmstrip(libraryId,asset.id,annotations.sourceRevision,controller.signal,thumbCount,progress) : filmstrip(source, controller.signal, thumbCount, progress)).then(images => {
      if (!controller.signal.aborted && live.current) {
        setThumbs(images); setThumbState(images.length === thumbCount ? "ready" : images.length ? "partial" : "unavailable");
        if (images.length === thumbCount) retainFilmstrip(key, images);
      }
    }); }, 120);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [source, line, thumbCount, annotations?.sourceRevision, nativeReady, nativeOpening]);
  useEffect(() => {
    const element = video.current; if (!element || !source || !element.requestVideoFrameCallback) return;
    let handle = 0, stopped = false;
    const frame: VideoFrameRequestCallback = (_, info) => { displayedTime.current = info.mediaTime; if (!stopped) handle = element.requestVideoFrameCallback(frame); };
    handle = element.requestVideoFrameCallback(frame);
    return () => { stopped = true; element.cancelVideoFrameCallback(handle); };
  }, [source, nativeOpening]);
  useEffect(() => { if (!hint) return; const timer = setTimeout(() => setHint(""), 4500); return () => clearTimeout(timer); }, [hint]);
  const stopPreview = (pause = false, clearNative = true) => { if (pause && playbackRange.current) player()?.pause(); if (clearNative && playbackRange.current) native.current?.clearRange(); playbackRange.current = null; };
  // Loop is a viewing preference, independent of the current playback job or clip.
  const toggleLoop = () => { const next = !looping; setLooping(next); if (playbackRange.current) playbackRange.current.loop = next; native.current?.loop(next); };
  const enforceRange = () => {
    if (native.current) return; // Native A/B and one-shot boundaries run with the decoder.
    const v = video.current, bounds = playbackRange.current;
    if (!v || !bounds || (v.paused && !v.ended) || v.seeking || v.currentTime < bounds.end) return;
    if (bounds.loop) { v.currentTime = bounds.start; setTime(bounds.start); if (v.paused) void v.play().catch(e => { stopPreview(); setFailure(errorText(e)); }); }
    else { v.pause(); v.currentTime = bounds.end; setTime(bounds.end); stopPreview(); }
  };
  // timeupdate alone is too sparse for short selections. Check each animation
  // frame while playing; ended also handles a selection ending at media EOF.
  useEffect(() => {
    if (!playing) return;
    let handle = 0; const tick = () => { enforceRange(); handle = requestAnimationFrame(tick); };
    handle = requestAnimationFrame(tick); return () => cancelAnimationFrame(handle);
  }, [playing]);
  // Native seek already clears its A/B range atomically; a separate clearRange
  // here is redundant and splits every pointer move into an IPC barrier.
  const seek = (next: number) => { const v = player(); if (!v || !duration) return; stopPreview(false, false); v.currentTime = Math.max(0, Math.min(duration, next)); setTime(v.currentTime); };
  const seekTimeline = (next: number) => {
    if (!player() || !duration) return;
    const position = Math.max(0, Math.min(duration, next));
    const mark = annotations?.marks.find(m => m.id === selected);
    const activeScope = playbackRange.current;
    seek(position);
    // Leaving a saved clip is a selection change, not just a preview cancel:
    // otherwise Space rebuilds its old bounds and jumps back to the in point.
    if (mark?.end != null && (position < mark.start || position > mark.end)) setSelected(null);
    // Scrubbing within a playing selection retains its once/loop boundary.
    // Draft I/O points and notes remain untouched while choosing an endpoint.
    if (activeScope && position >= activeScope.start && position <= activeScope.end) playbackRange.current = activeScope;
  };
  const play = () => {
    const v = player(); if (!v) return;
    if (!v.paused) { v.pause(); return; }
    const mark = annotations?.marks.find(m => m.id === selected);
    const scope = range?.start != null && range.end != null && range.end > range.start ? { start: range.start, end: range.end } : mark?.end != null ? { start: mark.start, end: mark.end } : null;
    if (scope) { playbackRange.current = { ...scope, loop: looping }; if (v.currentTime < scope.start || v.currentTime >= scope.end) v.currentTime = scope.start; }
    void startPlayback().catch(e => setFailure(`不能播放此视频：${errorText(e)}`));
  };
  const step = (delta: number) => { player()?.pause(); seek((player()?.currentTime ?? time) + delta); };
  const scrub = (active: boolean) => {
    const v = player(); if (!v) return;
    scrubbing.current = active;
    if (active) { scrubResume.current = !v.paused; v.pause(); }
    else if (scrubResume.current) { scrubResume.current = false; void startPlayback().catch(e => setFailure(errorText(e))); }
  };
  const setPoint = (edge: "in" | "out") => {
    if (duration < .02 || !annotations) return;
    stopPreview(true);
    const current = player()?.currentTime ?? time;
    setSelected(null);
    setRange(previous => edge === "in"
      ? { start: current, end: previous?.end != null && previous.end > current ? previous.end : null, note: previous?.note ?? "" }
      : { start: previous?.start != null && previous.start < current ? previous.start : null, end: current, note: previous?.note ?? "" });
    setHint(`${edge === "in" ? "入点" : "出点"} · ${filmPreciseTime(current)}`);
  };
  const rangeReady = range?.start != null && range?.end != null && range.end > range.start;
  const closeRange = () => { stopPreview(true); setRange(null); root.current?.focus({ preventScroll: true }); };
  const saveRange = () => {
    if (!rangeReady || range?.start == null || range.end == null) return;
    updateMark({ id: crypto.randomUUID(), start: range.start, end: range.end, note: range.note.trim() || `片段 ${filmTime(range.start)}` });
    closeRange(); setHint("已保存片段标记，可继续用 I / O 标记下一段");
  };
  const commitPosition = () => {
    const value = parseFilmPosition(positionEdit ?? "", duration);
    if (value === null) { setPositionError("请输入时长范围内的秒数或 时:分:秒.毫秒"); return; }
    seek(value); setPositionEdit(null); setPositionError(""); root.current?.focus({ preventScroll: true });
  };
  useEffect(() => { if (positionEdit !== null) { positionInput.current?.focus(); positionInput.current?.select(); } }, [positionEdit === null]);
  const close = () => { if (busy.current || pending || dirty.current.size) { setHint("请等待保存完成；保存失败时可在这里重试"); return; } onClose(); };
  const fullscreen = () => { void (document.fullscreenElement ? document.exitFullscreen() : root.current?.requestFullscreen())?.catch(e => setFailure(`全屏不可用：${errorText(e)}`)); };
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    event.stopPropagation();
    const target = event.target as HTMLElement;
    if (event.key === "Tab") {
      const items = Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]') ?? []);
      if (event.shiftKey && (target === items[0] || target === root.current)) { event.preventDefault(); items[items.length-1]?.focus(); }
      else if (!event.shiftKey && target === items[items.length-1]) { event.preventDefault(); items[0]?.focus(); }
      return;
    }
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") { event.preventDefault(); if (document.fullscreenElement) void document.exitFullscreen(); else if (positionEdit !== null) { setPositionEdit(null); setPositionError(""); } else if (selected || range || markList || details) { stopPreview(true); setSelected(null); setRange(null); setMarkList(false); setDetails(false); root.current?.focus(); } else close(); return; }
    // The embedded inspector keeps its editing, rating and tab keyboard controls.
    if (target.closest('.material-film-info')) return;
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && rangeReady) { event.preventDefault(); saveRange(); return; }
    // Sliders are media controls, not text editors: M/I/O must still work after scrubbing or changing volume.
    if (target.matches('input:not([type="range"]),textarea,select') || target.isContentEditable || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.repeat && !["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); return; }
    // Space belongs to the viewer even after a toolbar/marker click. Enter still
    // activates a focused button; editable text and IME were excluded above.
    if (event.key.toLowerCase() === "k" || event.key === " ") { event.preventDefault(); play(); return; }
    if (target.matches('input[type="range"]') && event.key.startsWith("Arrow")) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); step((event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 5 : .1)); }
    if (event.key === "Home" || event.key === "End") { event.preventDefault(); seek(event.key === "Home" ? 0 : duration); }
    if (event.key.toLowerCase() === "m" && annotations && duration) { event.preventDefault(); if (event.shiftKey) { setMarkList(v=>!v); setDetails(false); } else addMark(); }
    if (event.key.toLowerCase() === "i" || event.key.toLowerCase() === "o") { event.preventDefault(); setPoint(event.key.toLowerCase() === "i" ? "in" : "out"); }
    if (event.key.toLowerCase() === "c" && annotations && duration && !frameRetry) { event.preventDefault(); void capture(); }
    if (event.key.toLowerCase() === "f") { event.preventDefault(); fullscreen(); }
    if (event.key === "?") { event.preventDefault(); setDetails(v=>!v); setMarkList(false); }
  };
  const persist = (mark: FilmMark | null, id: string) => {
    if (!annotations) return;
    const revision = annotations.sourceRevision;
    dirty.current.set(id, mark); retainPending(revision); setPending(n => n+1); setWriteError("");
    writes.current = writes.current.catch(() => {}).then(async () => {
      try {
        await materialLibrarySession.request({ op: mark ? "videoMarkSave" : "videoMarkDelete", id: asset.id, sourceRevision: revision, ...(mark ? { mark } : { markId: id }) }, libraryId);
        if (dirty.current.get(id) === mark) dirty.current.delete(id);
        retainPending(revision);
        if (live.current && !dirty.current.size) setWriteError("");
      } catch (e) {
        if (live.current) setWriteError(`标记尚未保存：${errorText(e)}`);
        else window.dispatchEvent(new CustomEvent("luckyray:material-library-error", { detail: `视频标记保存失败：${errorText(e)}` }));
      } finally { if (live.current) setPending(n => n-1); }
    });
  };
  const updateMark = (mark: FilmMark) => { setAnnotations(current => current && ({ ...current, marks: current.marks.some(m => m.id===mark.id) ? current.marks.map(m => m.id===mark.id ? mark : m) : [...current.marks,mark] })); persist(mark, mark.id); };
  const addMark = () => { const mark = { id: crypto.randomUUID(), start: player()?.currentTime ?? time, end: null, note: "" }; updateMark(mark); setHint(`已添加标记 ${1 + (annotations?.marks.filter(m=>m.end===null).length ?? 0)} · ${filmPreciseTime(mark.start)}`); };
  const removeMark = (id: string) => { if (selected === id) { stopPreview(true); setSelected(null); } setAnnotations(current => current && ({ ...current, marks: current.marks.filter(m => m.id!==id) })); persist(null,id); };
  const selectMark = (mark: FilmMark) => { stopPreview(true); seek(mark.start); setSelected(mark.id); setMarkList(false); setRange(null); };
  const preview = (start: number, end: number) => {
    seek(start); playbackRange.current = { start, end, loop: looping };
    void startPlayback().catch(e => { stopPreview(); setFailure(errorText(e)); });
  };
  const capture = async (retry = false) => {
    if (!annotations || busy.current) return; busy.current = true; setCapturing(true); setFailure("");
    try {
      if (!retry) {
        if (native.current) frozenFrame.current = await native.current.capture();
        else {
        const v = video.current; if (!v) throw new Error("视频尚未就绪"); v.pause();
        const capturedAt = displayedTime.current ?? v.currentTime;
        const frame = displayedFilmFrame(v);
        const blob = await frame; frozenFrame.current = { time: capturedAt, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) };
        }
      }
      const frozen = frozenFrame.current; if (!frozen) throw new Error("截帧已失效，请重新截取");
      const result = await materialLibrarySession.request<FrameResult>({ op: "videoFrame", id: asset.id, sourceRevision: annotations.sourceRevision, ...frozen }, libraryId);
      if (result.failedItems.length) throw new Error(result.failedItems[0].error);
      if (!result.assets.length && !result.skippedDuplicateCount) throw new Error("未收到截帧入库结果");
      if (live.current) { setSavedFrame(result.assets[0] ? adaptMaterialAssetMedia(result.assets[0]) : null); setHint(result.skippedDuplicateCount ? "此帧已在素材库中" : "已保存截帧"); setFrameRetry(false); }
      frozenFrame.current = null;
    } catch (e) { if (live.current) { setFailure(`截帧未完成：${errorText(e)}`); setFrameRetry(Boolean(frozenFrame.current)); } }
    finally { busy.current = false; if (live.current) setCapturing(false); }
  };
  const chosen = annotations?.marks.find(m => m.id===selected);
  const ready = duration>0 && Boolean(annotations) && !nativeOpening;
  return createPortal(<section ref={root} className={`material-film${nativeReady ? " material-film-native" : ""}`} data-material-native-library={libraryId} data-material-native-asset={asset.id} role="dialog" aria-modal="true" aria-label={`影视查看器 · ${asset.name}`} tabIndex={-1} onKeyDown={keyDown}
    onDragStart={event=>event.preventDefault()}
    onPointerDown={event=>{event.stopPropagation();if(!(event.target as HTMLElement).closest('button,input,textarea,select,[role="slider"]'))root.current?.focus({preventScroll:true});}}
    style={{ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height } as CSSProperties}>
    <header className="material-film-topbar"><button onClick={close} aria-label="返回素材库" title="返回素材库（Esc）"><FilmIcon name="back"/></button><div className="material-film-top-actions"><button onClick={() => { setMarkList(v=>!v); setDetails(false); }} aria-expanded={markList} aria-label="标记列表" title="标记与片段（Shift+M）"><FilmIcon name="list"/>{Boolean(annotations?.marks.length) && <small>{annotations!.marks.length}</small>}</button><button onClick={() => { setDetails(v=>!v); setMarkList(false); }} aria-expanded={details} title="视频信息（?）" aria-label="视频信息"><FilmIcon name="info"/></button></div></header>
    <div ref={stage} className="material-film-stage">
      {nativeReady ? <div className="material-film-native-hit" onClick={play} aria-label="视频画面"/> : nativeOpening ? (openingPoster ? <img src={openingPoster} alt="" style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'contain'}}/> : <span>正在打开视频…</span>) : source ? <video ref={video} src={source} crossOrigin="anonymous" playsInline preload="auto" draggable={false}
        onLoadedMetadata={e => { const v=e.currentTarget; setDuration(Number.isFinite(v.duration)?v.duration:0); if(v.videoHeight)setVideoAspect(v.videoWidth/v.videoHeight); v.volume=volume; }}
        onLoadedData={e => { if (!e.currentTarget.videoWidth || !e.currentTarget.videoHeight) { e.currentTarget.pause(); setFailure("当前内置播放器未能解码视频画面；文件已保留，可用外部播放器打开"); } }}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onTimeUpdate={e => { setTime(e.currentTarget.currentTime); enforceRange(); }} onEnded={enforceRange}
        onSeeking={() => { displayedTime.current=null; }} onError={() => setFailure("当前视频格式无法播放或原文件已不可用；不会修改原文件")}
        onClick={play} /> : <span>正在打开视频…</span>}
      {details && <aside className="material-film-info" aria-label="视频素材详情">
        {renderDetails ? renderDetails(player()?.videoWidth && player()?.videoHeight ? { width: player()!.videoWidth, height: player()!.videoHeight } : null, () => { setDetails(false); root.current?.focus(); }, duration) : <><strong>{asset.name}</strong><br/>{asset.mimeType}<br/>时长 {filmPreciseTime(duration)}</>}
      </aside>}
      {markList && <aside className="material-film-mark-list" aria-label="标记与片段"><div><strong>标记与片段</strong><button onClick={()=>setMarkList(false)} aria-label="关闭标记列表">×</button></div>{annotations?.marks.length ? [...annotations.marks].sort((a,b)=>a.start-b.start).map(mark=><div className="material-film-mark-row" key={mark.id}><button className="material-film-mark-open" onClick={()=>selectMark(mark)}><FilmIcon name={mark.end===null?"mark":"range"}/><span>{mark.note || (mark.end===null?"未命名标记":"片段")}<small>{filmPreciseTime(mark.start)}{mark.end!==null?` — ${filmPreciseTime(mark.end)}`:""}</small></span></button><button className="material-film-mark-delete" aria-label={`删除${mark.end===null?"标记":"片段"} ${mark.note || filmPreciseTime(mark.start)}`} title="仅删除此标记，不删除视频" onClick={()=>removeMark(mark.id)}>删除</button></div>):<p>按 M 或点击标记，记下当前画面。</p>}</aside>}
      {chosen && <div className="material-film-note" role="group" aria-label="编辑视频标记">
        <div><button onClick={() => seek(chosen.start)}>{filmTime(chosen.start)}{chosen.end!==null ? ` — ${filmTime(chosen.end)}` : ""} ↗</button><button onClick={()=>{stopPreview(true);setSelected(null);}} aria-label="关闭标记备注">×</button></div>
        {chosen.end!==null && <div className="material-film-range-playback"><button onClick={()=>preview(chosen.start,chosen.end!)}>播放片段</button><button aria-pressed={looping} title={looping?"已开启循环；点击关闭，播放到出点停止":"开启片段循环；不会自动开始播放"} onClick={toggleLoop}>循环播放</button></div>}
        <textarea aria-label="标记备注" placeholder={chosen.end===null?"写下标记备注…":"片段名称…"} maxLength={2000} value={chosen.note} onChange={e => updateMark({...chosen,note:e.target.value})}/>
        <div><small>{pending ? "保存中…" : writeError ? "未保存" : "已保存"}</small><button onClick={()=>removeMark(chosen.id)}>删除标记</button></div>
      </div>}
      {range && <div className="material-film-range" role="group" aria-label="标记片段">
        <header><strong>标记片段</strong><button onClick={closeRange} aria-label="取消片段">×</button></header>
        <div className="material-film-range-points"><button aria-label="设置入点" onClick={()=>setPoint("in")} title="I · 将入点设为当前画面"><small>入点 · I</small>{range.start === null ? "待设置" : filmPreciseTime(range.start)}</button><span>—</span><button aria-label="设置出点" onClick={()=>setPoint("out")} title="O · 将出点设为当前画面"><small>出点 · O</small>{range.end === null ? "待设置" : filmPreciseTime(range.end)}</button></div>
        <input aria-label="片段名称" placeholder="片段名称（可选）" maxLength={120} value={range.note} onChange={e=>setRange({...range,note:e.target.value})}/>
        <div className="material-film-range-playback"><button disabled={!rangeReady} onClick={()=>preview(range.start!,range.end!)}>播放片段</button><button aria-pressed={looping} title={looping?"已开启循环；点击关闭，播放到出点停止":"开启片段循环；不会自动开始播放"} onClick={toggleLoop}>循环播放</button></div>
        <div className="material-film-range-save"><small>{rangeReady ? `${filmPreciseTime(range.end! - range.start!)} · 仅标记，不导出` : range.start === null ? "定位到较早画面，按 I 设置入点" : "定位到较晚画面，按 O 设置出点"}</small><button disabled={!rangeReady} onClick={saveRange}>保存片段标记</button></div>
      </div>}
    </div>
    <footer>
      {(failure || writeError || hint) && <div className="material-film-feedback" role="status"><span>{failure || writeError || hint}</span>{writeError && <button onClick={()=>{ for (const [id,m] of dirty.current) persist(m,id); }}>重试保存</button>}{frameRetry && <button disabled={capturing} onClick={()=>void capture(true)}>重试截帧保存</button>}{savedFrame && hint && <button onClick={()=>onFrame(savedFrame)}>查看</button>}</div>}
      <MaterialFilmTimeline duration={duration} time={time} thumbs={thumbs} line={line} thumbState={thumbState} marks={annotations?.marks??[]} range={range} selected={selected} seek={seekTimeline} scrub={scrub} select={selectMark}/>
      <div className="material-film-controls"><div className="material-film-transport"><button className="material-film-play" onClick={play} disabled={!duration} aria-label={playing?"暂停":"播放"} title="空格播放 / 暂停"><FilmIcon name={playing?"pause":"play"}/></button>
        <div className="material-film-step"><button onClick={()=>step(-.1)} disabled={!duration} aria-label="后退0.1秒" title="后退 0.1 秒（←）"><FilmIcon name="previous"/></button><button onClick={()=>step(.1)} disabled={!duration} aria-label="前进0.1秒" title="前进 0.1 秒（→）"><FilmIcon name="next"/></button></div>
        <span className="material-film-clock">{positionEdit === null ? <button aria-label="定位到时间" title="输入秒数或 时:分:秒.毫秒" disabled={!duration} onClick={()=>setPositionEdit(filmPreciseTime(time))}>{filmPreciseTime(time)}</button> : <input ref={positionInput} aria-label="定位时间" aria-invalid={Boolean(positionError)} value={positionEdit} onChange={e=>setPositionEdit(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.nativeEvent.isComposing){e.preventDefault();commitPosition();}}} onBlur={()=>{if(!positionError)setPositionEdit(null)}}/>} <i>/ {filmTime(duration)}</i></span>
        <label className="material-film-volume" title="音量"><button aria-label={muted?"取消静音":"静音"} onClick={()=>{setMuted(!muted);const v=player();if(v)v.muted=!muted;}}><FilmIcon name={muted?"muted":"volume"}/></button><input aria-label="音量" type="range" min="0" max="1" step="0.05" value={volume} onChange={e=>{const n=Number(e.target.value);setVolume(n);const v=player();if(v)v.volume=n;}}/></label>
        </div>
        <div className="material-film-actions"><button aria-label="标记" disabled={!ready} onClick={addMark} title="标记当前时间（M）"><FilmIcon name="mark"/> <span>标记</span></button><button aria-label="截帧" disabled={!ready||capturing||frameRetry} onClick={()=>void capture()} title="截取当前显示帧并保存到原视频所属库"><FilmIcon name="capture"/> <span>{capturing?"保存中":"截帧"}</span></button><button aria-label="片段" aria-expanded={Boolean(range)} disabled={!ready||duration<.02} onClick={()=>range?closeRange():setPoint("in")} title="打开 / 收起片段面板（I / O 设置入点、出点）"><FilmIcon name="range"/> <span>片段</span></button></div>
        <div className="material-film-view-actions"><button onClick={()=>setLine(v=>!v)} aria-pressed={!line} title={line?"显示按时间采样的胶片条":"切换线条时间线"} aria-label="切换时间线样式">{line?"▤":"━"}</button><button onClick={fullscreen} title="全屏 / 退出全屏（F）" aria-label="切换全屏"><FilmIcon name="full"/></button></div>
      </div>
      {positionError && <small className="material-film-position-error" role="alert">{positionError}</small>}
    </footer>
  </section>, portalHost);
}
