import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { defineMessages, useMessages } from "../../core/i18n/index";
import { knowledgeStore, resolveKnowledgeDocumentAbsolutePath } from "../../core/services/knowledgeStore";
import { materialStore } from "../../core/services/materialStore";
import { resolveMaterialLightSeekAttachments, type MaterialAsset } from "../../core/services/materials";
import { resolveMaterialPreviewTarget } from "../../core/services/materialCatalog";
import { getNote, listNotes, type NoteRecord } from "../../core/services/notes";
import { openInLightSeek, peekUncertainOpenInLightSeekIntentId, waitForOpenInLightSeekIntent } from "../../core/services/openInLightSeek";

const COPY = defineMessages({
  "aria": { "zh-CN": "LightSeek 内容浏览侧栏", "en-US": "LightSeek content browser sidebar" },
  "tab.materials": { "zh-CN": "素材库", "en-US": "Materials" },
  "tab.notes": { "zh-CN": "知识库", "en-US": "Knowledge" },
  "search.materials": { "zh-CN": "搜索素材", "en-US": "Search materials" },
  "search.notes": { "zh-CN": "搜索笔记", "en-US": "Search notes" },
  "loading": { "zh-CN": "正在读取…", "en-US": "Loading…" },
  "empty": { "zh-CN": "没有找到匹配内容", "en-US": "No matching content" },
  "add": { "zh-CN": "添加到输入框：{name}", "en-US": "Add to draft: {name}" },
  "sending": { "zh-CN": "正在添加…", "en-US": "Adding…" },
  "sent": { "zh-CN": "已放入 LightSeek 输入框", "en-US": "Added to the LightSeek draft" },
  "failed": { "zh-CN": "发送失败，请重试", "en-US": "Could not send. Try again." },
  "uncertain": { "zh-CN": "尚未确认添加结果，请先查看输入框，勿重复添加", "en-US": "Addition not confirmed. Check the draft before adding again." },
  "note.untitled": { "zh-CN": "未命名笔记", "en-US": "Untitled note" },
  "kind.image": { "zh-CN": "图片", "en-US": "Image" },
  "kind.video": { "zh-CN": "视频", "en-US": "Video" },
  "kind.audio": { "zh-CN": "音频", "en-US": "Audio" },
  "kind.document": { "zh-CN": "文档", "en-US": "Document" },
  "kind.file": { "zh-CN": "文件", "en-US": "File" },
});

type BrowserTab = "materials" | "notes";

function MaterialPreviewMedia({ asset, alt, lazy }: { asset: MaterialAsset; alt: string; lazy?: boolean }) {
  const previewTarget = resolveMaterialPreviewTarget(asset);
  if (previewTarget?.kind === "image") {
    return <img src={previewTarget.url} alt={alt} loading={lazy ? "lazy" : undefined} />;
  }
  if (previewTarget?.kind === "video-frame") {
    // `#t=0.1` makes the WebView paint the first frame as the poster.
    return <video src={previewTarget.url} muted playsInline preload="metadata" aria-label={alt} />;
  }
  return <span aria-hidden="true">◇</span>;
}

export default function LightSeekContentBrowser() {
  const { locale, t } = useMessages(COPY);
  const subscribeMaterials = useCallback((listener: () => void) => materialStore.subscribe(listener), []);
  const readMaterialSnapshot = useCallback(() => materialStore.getSnapshot(), []);
  const materialSnapshot = useSyncExternalStore(subscribeMaterials, readMaterialSnapshot, readMaterialSnapshot);
  const [tab, setTab] = useState<BrowserTab>("materials");
  const [query, setQuery] = useState("");
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesLoaded, setNotesLoaded] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const selectionEpochRef = useRef(0);
  const busyRef = useRef(false);

  useEffect(() => () => { selectionEpochRef.current += 1; }, []);

  useEffect(() => {
    void materialStore.ensureSnapshot({ reason: "lightseek-content-browser" });
  }, []);

  useEffect(() => {
    if (tab !== "notes" || notesLoaded) return;
    let active = true;
    setNotesLoading(true);
    void listNotes()
      .then((value) => { if (active) { setNotes(value); setNotesLoaded(true); } })
      .catch(() => { if (active) setNotes([]); })
      .finally(() => { if (active) setNotesLoading(false); });
    return () => { active = false; };
  }, [notesLoaded, tab]);

  const materials = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase(locale);
    const source = materialSnapshot.allAssets;
    return (normalized
      ? source.filter((asset) => `${asset.name} ${asset.description || ""}`.toLocaleLowerCase(locale).includes(normalized))
      : source).slice(0, 240);
  }, [locale, materialSnapshot.allAssets, query]);

  const visibleNotes = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase(locale);
    return normalized ? notes.filter((note) => note.title.toLocaleLowerCase(locale).includes(normalized)) : notes;
  }, [locale, notes, query]);

  const sendMaterial = async (asset: MaterialAsset) => {
    if (busyRef.current) return;
    const epoch = selectionEpochRef.current;
    busyRef.current = true;
    setBusy(true);
    setActiveId(asset.id);
    setStatus("");
    try {
      const localResources = await resolveMaterialLightSeekAttachments([asset]);
      if (selectionEpochRef.current !== epoch) return;
      const intent = openInLightSeek({ source: "materials", text: "", localResources });
      await waitForOpenInLightSeekIntent(intent.intentId);
      if (selectionEpochRef.current === epoch) setStatus(t("sent"));
    } catch {
      if (selectionEpochRef.current === epoch) setStatus(t(peekUncertainOpenInLightSeekIntentId() ? "uncertain" : "failed"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const sendNote = async (note: NoteRecord) => {
    if (busyRef.current) return;
    const epoch = selectionEpochRef.current;
    busyRef.current = true;
    setBusy(true);
    setActiveId(note.id);
    setStatus("");
    try {
      const selectedNote = await getNote(note.id);
      if (!selectedNote) throw new Error("lightseek-note-unavailable");
      const snapshot = await knowledgeStore.ensureSnapshot({ reason: "lightseek-content-browser-note-path" });
      const canonicalPath = resolveKnowledgeDocumentAbsolutePath(snapshot, selectedNote.documentRef);
      if (!canonicalPath) throw new Error("lightseek-note-path-unavailable");
      if (selectionEpochRef.current !== epoch) return;
      const intent = openInLightSeek({
        source: "notes",
        text: "",
        localResources: [{
          kind: "material",
          assetId: selectedNote.id,
          canonicalPath,
          delivery: "file-attachment",
        }],
      });
      await waitForOpenInLightSeekIntent(intent.intentId);
      if (selectionEpochRef.current === epoch) setStatus(t("sent"));
    } catch {
      if (selectionEpochRef.current === epoch) setStatus(t(peekUncertainOpenInLightSeekIntentId() ? "uncertain" : "failed"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <aside className="lightseek-content-browser" aria-label={t("aria")}>
      <div className="lightseek-content-browser-tabs" role="tablist" aria-label={t("aria")}>
        {(["materials", "notes"] as const).map((item) => (
          <button
            key={item}
            id={`lightseek-content-tab-${item}`}
            type="button"
            role="tab"
            tabIndex={tab === item ? 0 : -1}
            aria-selected={tab === item}
            aria-controls="lightseek-content-panel"
            className={tab === item ? "active" : ""}
            onClick={() => { selectionEpochRef.current += 1; setTab(item); setQuery(""); setStatus(""); }}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === "ArrowLeft" || event.key === "Home" ? "materials" : "notes";
              setTab(next);
              selectionEpochRef.current += 1;
              setQuery("");
              setStatus("");
              document.getElementById(`lightseek-content-tab-${next}`)?.focus();
            }}
          >{t(`tab.${item}`)}</button>
        ))}
      </div>
      <label className="lightseek-content-browser-search">
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4" /><path d="m10.2 10.2 3 3" /></svg>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t(tab === "materials" ? "search.materials" : "search.notes")} />
      </label>
      <div className="lightseek-content-browser-body" aria-busy={busy}>
        <div id="lightseek-content-panel" className="lightseek-content-browser-list" role="tabpanel" aria-labelledby={`lightseek-content-tab-${tab}`}>
          {tab === "materials" ? (
            materialSnapshot.status === "loading" && !materialSnapshot.loaded ? <p className="lightseek-content-empty">{t("loading")}</p> :
              materials.length ? materials.map((asset) => (
                <button type="button" key={asset.id} disabled={busy} className={`lightseek-content-material${activeId === asset.id ? " active" : ""}`} onClick={() => void sendMaterial(asset)} title={t("add", { name: asset.name })} aria-label={t("add", { name: asset.name })}>
                  <span className="lightseek-content-thumb"><MaterialPreviewMedia asset={asset} alt="" lazy /></span>
                  <span><b>{asset.name}</b><small>{t(`kind.${asset.kind === "image" || asset.kind === "video" || asset.kind === "audio" || asset.kind === "document" ? asset.kind : "file"}`)}</small></span>
                </button>
              )) : <p className="lightseek-content-empty">{t("empty")}</p>
          ) : (
            notesLoading && notes.length === 0 ? <p className="lightseek-content-empty">{t("loading")}</p> :
              visibleNotes.length ? visibleNotes.map((note) => (
                <button type="button" key={note.id} disabled={busy} className={`lightseek-content-note${activeId === note.id ? " active" : ""}`} onClick={() => void sendNote(note)} aria-label={t("add", { name: note.title || t("note.untitled") })}>
                  <span aria-hidden="true" className="lightseek-content-note-icon"><svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg></span>
                  <span><b>{note.title || t("note.untitled")}</b><small>{note.updatedAt ? new Date(note.updatedAt).toLocaleDateString(locale) : "Markdown"}</small></span>
                </button>
              )) : <p className="lightseek-content-empty">{t("empty")}</p>
          )}
        </div>
        {(busy || status) ? <p className="lightseek-content-status" role="status">{busy ? t("sending") : status}</p> : null}
      </div>
    </aside>
  );
}
