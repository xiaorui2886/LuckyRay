import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { MaterialAsset } from "../../core/services/materialCatalog";
import { materialLibrarySession } from "../../core/services/materialLibraryContext";
import { consumeMaterialAppearanceDrag } from "../../core/services/materials";
import { APPEARANCE_MAX_BYTES, AppearanceCancelled, appearanceCandidates, localAppearancePreview, MaterialAppearanceSession,
  type AppearanceProgress, type AppearanceQuery, type AppearanceResult } from "../../core/services/materialAppearance";
import "./materialAppearance.css";
import {useMaterialViewScope} from './MaterialViewContext';

export function MaterialAppearancePanel({ assets, selectedIds, request, searchMode, onResult, onClose, onOpen }: {
  assets: readonly MaterialAsset[]; selectedIds: ReadonlySet<string>; request: { assetId?: string } | null;
  onResult: (ids: string[] | null) => void; onClose: () => void;
  onOpen: () => void;
  searchMode: "materials" | "global";
}) {
  const viewScope=useMaterialViewScope();
  const viewScopeRef=useRef(viewScope);viewScopeRef.current=viewScope;
  const trigger=()=>document.querySelector<HTMLElement>(viewScopeRef.current?`[data-workspace-view="${CSS.escape(viewScopeRef.current.viewId)}"] [data-material-appearance-trigger]`:'[data-material-appearance-trigger]');
  const service = useRef<MaterialAppearanceSession | null>(null);
  const serial = useRef(0), reader = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<AppearanceProgress | null>(null);
  const [result, setResult] = useState<AppearanceResult | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [sourceName, setSourceName] = useState(""), [notice, setNotice] = useState("");
  const [preview, setPreview] = useState("");
  const previewObject = useRef<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 60, right: 12 });
  const open = Boolean(request);
  const callbacks = useRef({ onResult, onClose, onOpen }); callbacks.current = { onResult, onClose, onOpen };
  const releasePreview = () => { if (previewObject.current) URL.revokeObjectURL(previewObject.current); previewObject.current = null; };
  const selection = useMemo(() => {
    try { return { assets: appearanceCandidates(assets, new Set()), error: "" }; }
    catch (e) { return { assets: [], error: e instanceof Error ? e.message : String(e) }; }
  }, [assets]);
  const scope = selection.assets;
  const scopeKey = JSON.stringify(scope.map(a => [a.id, a.contentHash, a.originalPath, a.libraryPath]));
  const assetsRef = useRef(assets); assetsRef.current = assets;
  const cancel = () => {
    ++serial.current; reader.current?.abort(); service.current?.cancelIndex(); service.current?.cancelQuery();
    setBusy(false); setNotice("已取消");
  };
  const clear = () => {
    cancel(); releasePreview(); setPreview(""); setResult(null); setError(""); setNotice(""); setSourceName(""); setProgress(null); callbacks.current.onResult(null);
  };
  const close = () => { clear(); callbacks.current.onClose(); };
  const closeRef = useRef(close); closeRef.current = close;
  const run = async (query: AppearanceQuery | File | string, name: string) => {
    cancel(); releasePreview(); setPreview(""); const request = serial.current; setNotice(""); setError(""); setResult(null); setProgress(null); setBusy(true); setSourceName(name);
    callbacks.current.onOpen(); callbacks.current.onResult([]);
    const current = () => request === serial.current;
    try {
      if (selection.error) throw new Error(selection.error);
      const queryScope = appearanceCandidates(assets, typeof query === "object" && "kind" in query && query.kind === "asset"
        ? new Set() : selectedIds.size > 1 ? selectedIds : new Set());
      if (!queryScope.length) throw new Error("当前范围没有可检索的图片");
      let resolved: AppearanceQuery;
      if (typeof query === "string" || query instanceof File) {
        let bytes: Uint8Array;
        if (typeof query === "string") {
          reader.current = new AbortController();
          const response = await fetch(convertFileSrc(query), { signal: reader.current.signal });
          if (!response.ok || !response.body) throw new Error("无法读取这张图片，请重新选择");
          const stream = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
          try { while (true) { const part = await stream.read(); if (part.done) break; length += part.value.length; if (length > APPEARANCE_MAX_BYTES) throw new Error("请选择不超过 12 MB 的图片"); chunks.push(part.value); } }
          finally { await stream.cancel().catch(() => {}); }
          bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        } else {
          if (!query.size || query.size > APPEARANCE_MAX_BYTES) throw new Error("请选择不超过 12 MB 的图片");
          bytes = new Uint8Array(await query.arrayBuffer());
        }
        resolved = { kind: "bytes", bytes: Array.from(bytes) };
        if (!current()) return;
        previewObject.current = URL.createObjectURL(new Blob([bytes])); setPreview(previewObject.current);
      } else resolved = query;
      if (!current()) return;
      if (resolved.kind === "asset") {
        const asset = assetsRef.current.find(a => a.id === resolved.id);
        if (asset) setPreview(localAppearancePreview(asset) || convertFileSrc(asset.libraryPath || asset.originalPath));
      }
      const session = service.current ?? (service.current = new MaterialAppearanceSession(materialLibrarySession,viewScope?.libraryId));
      await session.index(queryScope.map(a => a.id), value => { if (current()) setProgress(value); });
      if (!current()) return;
      const found = await session.query(queryScope.map(a => a.id), resolved);
      if (current()) { setResult(found); callbacks.current.onResult(found.hits.map(hit => hit.assetId)); }
    } catch (e) { if (current() && !(e instanceof AppearanceCancelled)) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (current()) setBusy(false); }
  };
  const runRef = useRef(run); runRef.current = run;
  useEffect(() => {
    clear();
    return () => { ++serial.current; reader.current?.abort(); releasePreview(); service.current?.dispose(); service.current = null; };
  }, [scopeKey, searchMode]);
  useLayoutEffect(() => { if (!request) clear(); }, [request]);
  // Retained Activity pages may hide without unmounting state. Invalidate before
  // the next paint and never carry a portal/query across a route change.
  useLayoutEffect(() => {
    const leave = () => {
      const route = window.location.hash.replace(/^#\/?/, "").split(/[/?]/)[0];
      if (route && route !== (viewScope?'workspace':'materials')) closeRef.current();
    };
    window.addEventListener("hashchange", leave);
    return () => { window.removeEventListener("hashchange", leave); ++serial.current; reader.current?.abort(); leave(); };
  }, []);
  useLayoutEffect(()=>{if(viewScope&&!viewScope.visible)closeRef.current();},[viewScope?.visible]);
  useEffect(() => {
    if (request?.assetId) void runRef.current({ kind: "asset", id: request.assetId }, assets.find(a => a.id === request.assetId)?.name ?? "所选图片");
  }, [request]);
  useEffect(() => materialLibrarySession.subscribe(() => {
    if (service.current && !service.current.isCurrent()) closeRef.current();
  }), []);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger()?.getBoundingClientRect();
      setPosition({ top: Math.min((anchor?.bottom ?? 52) + 24, Math.max(8, window.innerHeight - (popup.current?.offsetHeight ?? 280) - 8)),
        right: 12 });
    };
    place(); window.addEventListener("resize", place);
    const observer = new ResizeObserver(place); if (popup.current) observer.observe(popup.current);
    return () => { window.removeEventListener("resize", place); observer.disconnect(); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.isComposing && (!viewScopeRef.current||viewScopeRef.current.focused)) { event.preventDefault(); event.stopPropagation(); closeRef.current(); trigger()?.focus({ preventScroll: true }); } };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [open]);
  useEffect(() => {
    const highlight = (target: Element | null) => {
      const scope=viewScopeRef.current;
      const owner=target?.closest<HTMLElement>('[data-workspace-view]')?.dataset.workspaceView;
      const owned=scope?scope.visible&&(owner===scope.viewId||!!popup.current?.contains(target)):!owner;
      const hit = owned&&Boolean(target?.closest?.("[data-material-appearance-drop]")); setDragging(hit);
      trigger()?.classList.toggle("appearance-drop-active", hit);
      return hit;
    };
    const drop = (paths: string[], files?: FileList | null) => {
      highlight(null);
      try {
        const ids = consumeMaterialAppearanceDrag(Date.now(),viewScopeRef.current?.libraryId);
        if (ids) {
          const asset = assetsRef.current.find(a => a.id === ids[0]);
          if (ids.length !== 1 || asset?.kind !== "image") throw new Error("请只拖入一张当前范围内的图片");
          void runRef.current({ kind: "asset", id: asset.id }, asset.name); return;
        }
        if (files?.length === 1) { void runRef.current(files[0], files[0].name); return; }
        if (paths.length !== 1) throw new Error("一次选择一张查询图片");
        void runRef.current(paths[0], paths[0].split(/[\\/]/).pop() ?? "查询图片");
      } catch (e) { callbacks.current.onOpen(); setError(e instanceof Error ? e.message : String(e)); }
    };
    let disposed = false; let unlisten: (() => void) | undefined; let nativeDropAt = 0;
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent(event => {
      if (disposed) return;
      const payload = event.payload;
      if (payload.type === "leave") { highlight(null); return; }
      const scale = window.devicePixelRatio || 1;
      const target = document.elementFromPoint(payload.position.x / scale, payload.position.y / scale);
      if (!highlight(target) || payload.type !== "drop") return;
      nativeDropAt = Date.now(); drop(payload.paths);
    })).then(off => { if (disposed) off(); else unlisten = off; }).catch(() => {});
    const over = (event: DragEvent) => { if (highlight(event.target as Element)) event.preventDefault(); };
    const leave = (event: DragEvent) => { if (!event.relatedTarget) highlight(null); };
    const domDrop = (event: DragEvent) => {
      if (!highlight(event.target as Element)) return;
      event.preventDefault(); event.stopPropagation();
      if (Date.now() - nativeDropAt < 1000) return;
      drop([], event.dataTransfer?.files);
    };
    window.addEventListener("dragover", over); window.addEventListener("dragleave", leave); window.addEventListener("drop", domDrop, true);
    return () => { disposed = true; unlisten?.(); highlight(null); window.removeEventListener("dragover", over); window.removeEventListener("dragleave", leave); window.removeEventListener("drop", domDrop, true); };
  }, []);
  return <>
    {open && createPortal(<div className="material-appearance-dialog" role="dialog" aria-label="以图搜图" ref={popup} style={position}>
      <header><div><h2>以图搜图</h2><p>当前范围 · {scope.length} 张图片</p></div><button type="button" aria-label="关闭以图搜图" onClick={close}>×</button></header>
      <div className={`material-appearance-drop${preview ? " has-preview" : ""}${dragging ? " dragging" : ""}`} data-material-appearance-drop>
        {preview ? <img className="material-appearance-query-image" src={preview} alt={`查询图片：${sourceName}`} /> : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="2"/><path d="m4 19 6-6 4 4 3-3 4 4"/></svg>}
        {!preview && <strong className="material-appearance-source" title={sourceName}>{sourceName || "拖一张图片到这里"}</strong>}
        <div className={preview ? "material-appearance-image-actions" : "material-appearance-empty-actions"}><button type="button" onClick={() => input.current?.click()}>{sourceName ? "更换图片" : "选择图片"}</button>{sourceName && <button type="button" aria-label="移除查询图片" onClick={clear}>移除</button>}</div>
        <input ref={input} type="file" hidden accept=".jpg,.jpeg,.png,.bmp,.webp" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void run(file, file.name); }}/>
      </div>
      {preview && <div className="material-appearance-source material-appearance-caption" title={sourceName}>{sourceName}</div>}
      {(sourceName || error) && <div className="material-appearance-feedback">
        {busy && <progress aria-label="以图搜图进度" max={progress?.total || 1} value={progress?.phase === "indexing" && progress.total > 0 ? progress.completed + progress.failures.length : undefined}/>}
        <div className="material-appearance-progress"><span role={error ? "alert" : "status"}>
          {error || (busy ? progress?.phase === "indexing" ? `正在准备 ${progress.completed + progress.failures.length}/${progress.total}` : "正在查找…"
            : notice || (result ? result.hits.length ? `找到 ${result.hits.length} 张相似图片` : "当前范围没有相似图片" : ""))}
        </span>{busy && <button type="button" onClick={cancel}>取消</button>}</div>
        {Boolean(progress?.failures.length) && <p>{progress!.failures.length} 张图片未参与检索</p>}
      </div>}
      <p className="material-appearance-help">也可直接拖到上方搜图按钮。结果显示在素材列表，不导入查询图片。</p>
      <details className="material-appearance-help"><summary>支持范围</summary><p>比较颜色、构图和外观，不识别文字含义。仅本机计算，不导入查询图片；每次最多检索当前范围的前 96 张图片。支持 JPEG、PNG、BMP、静态 WebP，每张不超过 12 MB、2000 万像素。</p></details>
    </div>, document.querySelector(".react-nav-shell") ?? document.body)}
  </>;
}
