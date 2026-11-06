import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useMaterialViewScope } from "./MaterialViewContext";
import type { MaterialAsset } from "../../core/services/materials";
import "./materialFilePreview.css";

type Preview = { kind: "text" | "image" | "waveform"; previewUri?: string | null; text?: string | null; truncated: boolean } | null;
type PreviewEntry = { promise: Promise<Preview>; users: number; started: boolean; run: () => void; cancel: () => void };
const previews = new Map<string, PreviewEntry>();
const waiting: PreviewEntry[] = [];
let active = 0;
function requestPreview(key: string, libraryId: string | undefined, vaultId: string | undefined, assetId: string, detail: boolean) {
  let entry = previews.get(key);
  if (!entry) {
    let resolve!: (value: Preview) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<Preview>((yes, no) => { resolve = yes; reject = no; });
    entry = { promise, users: 0, started: false, cancel: () => resolve(null), run: () => {} };
    const current = entry;
    current.run = () => {
      current.started = true; active++;
      void invoke<Preview>("material_file_preview", { libraryId: libraryId || null, vaultId: vaultId || null, assetId, detail })
        .then(resolve, error => { if (previews.get(key) === current) previews.delete(key); reject(error); })
        .finally(() => { active--; waiting.shift()?.run(); });
    };
    previews.set(key, current);
    if (previews.size > 256) {
      const oldest = [...previews].find(([, value]) => value.users === 0 && value.started);
      if (oldest) previews.delete(oldest[0]);
    }
  }
  entry.users++;
  if (!entry.started && !waiting.includes(entry)) {
    if (active < 2) entry.run(); else if (detail) waiting.unshift(entry); else waiting.push(entry);
  }
  const current = entry;
  return { promise: entry.promise, release: () => {
    current.users--;
    if (!current.users && !current.started) {
      const index = waiting.indexOf(current); if (index >= 0) waiting.splice(index, 1);
      if (previews.get(key) === current) previews.delete(key);
      current.cancel();
    }
  } };
}

export function materialFileFormat(asset: Pick<MaterialAsset, "name" | "mimeType" | "kind">): string {
  const extension = asset.name.split(".").pop();
  if (extension && extension !== asset.name && extension.length <= 12) return extension.toUpperCase();
  return asset.kind === "audio" ? "音频" : asset.kind === "document" || asset.kind === "text" ? "文档" : "文件";
}

export function MaterialFilePreview({ asset, variant = "card", onOpen, libraryId, vaultId }: {
  asset: MaterialAsset; libraryId?: string; vaultId?: string; variant?: "card" | "grid" | "list" | "detail" | "cover"; onOpen?: () => void;
}) {
  const scope = useMaterialViewScope();
  const detail = variant === "detail";
  const previewLibraryId = vaultId ? undefined : libraryId ?? scope?.libraryId;
  const key = JSON.stringify([previewLibraryId || "", vaultId || "", asset.id, asset.updatedAt || asset.importedAt || "", asset.name, detail]);
  const root = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<{ key: string; value: Preview; failed?: boolean } | null>(null);
  const [broken, setBroken] = useState("");
  const [retry, setRetry] = useState(0);
  const current = snapshot?.key === key ? snapshot.value : null;
  const loaded = snapshot?.key === key;
  useEffect(() => {
    if (scope && !scope.visible) return;
    let live = true;
    let observer: IntersectionObserver | undefined;
    let release: (() => void) | undefined;
    const load = () => { observer?.disconnect();
      const request = requestPreview(key, previewLibraryId, vaultId, asset.id, detail); release = request.release;
      void request.promise.then(value => { if (live) setSnapshot({ key, value }); }, () => { if (live) setSnapshot({ key, value: null, failed: true }); }); };
    if (detail || typeof IntersectionObserver === "undefined") load();
    else {
      observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) load(); }, { rootMargin: "160px" });
      if (root.current) observer.observe(root.current);
    }
    return () => { live = false; observer?.disconnect(); release?.(); };
  }, [key, scope?.visible, previewLibraryId, vaultId, asset.id, detail, retry]);
  const format = materialFileFormat(asset);
  return <div ref={root} className={`material-file-preview material-file-preview--${variant}${current?.kind === "waveform" ? " material-file-preview--waveform" : ""}`} data-file-format={format}>
    {(current?.kind === "image" || current?.kind === "waveform") && current.previewUri && broken !== key ?
      <img src={current.previewUri} alt={`${asset.name}${current.kind === "waveform" ? " 内容声波" : " 封面预览"}`} draggable={false} onError={() => setBroken(key)} /> :
      current?.kind === "text" ? <>
        <div className="material-file-preview-heading"><span>{format}</span>{detail && <strong>{asset.name}</strong>}</div>
        <pre tabIndex={detail ? 0 : undefined} onDoubleClick={detail ? event => event.stopPropagation() : undefined}>{current.text || "（空文件）"}</pre>
        {detail && current.truncated && <p className="material-file-preview-note">已显示前 64 KB 内容，完整内容请打开原文件。</p>}
      </> : <div className="material-file-preview-empty">
        <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>
        <span className="material-file-format">{format}</span>
        {detail && <><strong>{asset.name}</strong><small>{loaded ? snapshot?.failed ? "预览读取失败，可重试或打开原文件" : "此文件暂时没有可用预览" : "正在读取预览…"}</small></>}
      </div>}
    {detail && (onOpen || snapshot?.failed) && <div className="material-file-preview-actions">{snapshot?.key === key && snapshot.failed && <button type="button" onClick={event => { event.stopPropagation(); setSnapshot(null); setRetry(value => value + 1); }}>重试预览</button>}{onOpen && <button type="button" onClick={event => { event.stopPropagation(); onOpen(); }}>打开原文件</button>}</div>}
  </div>;
}
