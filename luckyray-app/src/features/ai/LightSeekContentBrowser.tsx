import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { defineMessages, useMessages } from "../../core/i18n/index";
import { knowledgeStore, resolveKnowledgeDocumentAbsolutePath } from "../../core/services/knowledgeStore";
import { materialStore } from "../../core/services/materialStore";
import { resolveMaterialLightSeekAttachments, type MaterialAsset } from "../../core/services/materials";
import { resolveMaterialPreviewTarget } from "../../core/services/materialCatalog";
import { getNote, listNotes, type NoteRecord } from "../../core/services/notes";
import { openInLightSeek, waitForOpenInLightSeekIntent } from "../../core/services/openInLightSeek";

const COPY = defineMessages({
  "aria": { "zh-CN": "LightSeek 内容浏览侧栏", "en-US": "LightSeek content browser sidebar" },
  "title": { "zh-CN": "发送到 LightSeek", "en-US": "Send to LightSeek" },
  "subtitle": { "zh-CN": "不离开对话，直接浏览并添加内容", "en-US": "Browse and add content without leaving the conversation" },
  "tab.materials": { "zh-CN": "素材库", "en-US": "Materials" },
  "tab.notes": { "zh-CN": "知识库", "en-US": "Knowledge" },
  "search.materials": { "zh-CN": "搜索素材", "en-US": "Search materials" },
  "search.notes": { "zh-CN": "搜索笔记", "en-US": "Search notes" },
  "loading": { "zh-CN": "正在读取…", "en-US": "Loading…" },
  "empty": { "zh-CN": "没有找到匹配内容", "en-US": "No matching content" },
  "select.material": { "zh-CN": "选择一个素材查看", "en-US": "Select a material to preview" },
  "select.note": { "zh-CN": "选择一篇笔记预览", "en-US": "Select a note to preview" },
  "send": { "zh-CN": "发送到对话", "en-US": "Send to chat" },
  "sending": { "zh-CN": "正在发送…", "en-US": "Sending…" },
  "sent": { "zh-CN": "已放入 LightSeek 输入框", "en-US": "Added to the LightSeek draft" },
  "failed": { "zh-CN": "发送失败，请重试", "en-US": "Could not send. Try again." },
  "material.kind": { "zh-CN": "{kind}素材", "en-US": "{kind} material" },
  "note.untitled": { "zh-CN": "未命名笔记", "en-US": "Untitled note" },
  "preview.image": { "zh-CN": "素材预览", "en-US": "Material preview" },
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

function contentExcerpt(value: string) {
  return value
    .replace(/!\[\[[^\]]+\]\]/gu, "[素材]")
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/gu, "$1")
    .replace(/[#*_>`~-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 420);
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
  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(null);
  const [selectedNote, setSelectedNote] = useState<NoteRecord | null>(null);
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

  const selectedMaterial = materialSnapshot.allAssets.find((asset) => asset.id === selectedMaterialId) || null;

  const selectNote = async (note: NoteRecord) => {
    const epoch = ++selectionEpochRef.current;
    setStatus("");
    if (note.contentText !== undefined) {
      setSelectedNote(note);
      return;
    }
    setNotesLoading(true);
    try {
      const selected = await getNote(note.id);
      if (selectionEpochRef.current === epoch) setSelectedNote(selected);
    } catch {
      if (selectionEpochRef.current === epoch) setStatus(t("failed"));
    } finally {
      setNotesLoading(false);
    }
  };

  const sendMaterial = async () => {
    if (!selectedMaterial || busyRef.current) return;
    const epoch = selectionEpochRef.current;
    busyRef.current = true;
    setBusy(true);
    setStatus("");
    try {
      const localResources = await resolveMaterialLightSeekAttachments([selectedMaterial]);
      if (selectionEpochRef.current !== epoch) return;
      const intent = openInLightSeek({ source: "materials", text: "", localResources });
      await waitForOpenInLightSeekIntent(intent.intentId);
      if (selectionEpochRef.current === epoch) setStatus(t("sent"));
    } catch {
      if (selectionEpochRef.current === epoch) setStatus(t("failed"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const sendNote = async () => {
    if (!selectedNote || busyRef.current) return;
    const epoch = selectionEpochRef.current;
    busyRef.current = true;
    setBusy(true);
    setStatus("");
    try {
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
          delivery: "path-reference",
        }],
      });
      await waitForOpenInLightSeekIntent(intent.intentId);
      if (selectionEpochRef.current === epoch) setStatus(t("sent"));
    } catch {
      if (selectionEpochRef.current === epoch) setStatus(t("failed"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <aside className="lightseek-content-browser" aria-label={t("aria")}>
      <header className="lightseek-content-browser-header"><div><h2>{t("title")}</h2><p>{t("subtitle")}</p></div></header>
      <div className="lightseek-content-browser-tabs" role="tablist" aria-label={t("title")}>
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
              document.getElementById(`lightseek-content-tab-${next}`)?.focus();
            }}
          >{t(`tab.${item}`)}</button>
        ))}
      </div>
      <label className="lightseek-content-browser-search">
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4" /><path d="m10.2 10.2 3 3" /></svg>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t(tab === "materials" ? "search.materials" : "search.notes")} />
      </label>
      <div className="lightseek-content-browser-body">
        <div id="lightseek-content-panel" className="lightseek-content-browser-list" role="tabpanel" aria-labelledby={`lightseek-content-tab-${tab}`}>
          {tab === "materials" ? (
            materialSnapshot.status === "loading" && !materialSnapshot.loaded ? <p className="lightseek-content-empty">{t("loading")}</p> :
              materials.length ? materials.map((asset) => (
                <button type="button" key={asset.id} className={`lightseek-content-material${selectedMaterialId === asset.id ? " active" : ""}`} onClick={() => { selectionEpochRef.current += 1; setSelectedMaterialId(asset.id); setStatus(""); }} title={asset.name}>
                  <span className="lightseek-content-thumb"><MaterialPreviewMedia asset={asset} alt="" lazy /></span>
                  <span><b>{asset.name}</b><small>{t("material.kind", { kind: asset.kind || "file" })}</small></span>
                </button>
              )) : <p className="lightseek-content-empty">{t("empty")}</p>
          ) : (
            notesLoading && notes.length === 0 ? <p className="lightseek-content-empty">{t("loading")}</p> :
              visibleNotes.length ? visibleNotes.map((note) => (
                <button type="button" key={note.id} className={`lightseek-content-note${selectedNote?.id === note.id ? " active" : ""}`} onClick={() => void selectNote(note)}>
                  <span aria-hidden="true" className="lightseek-content-note-icon">▤</span>
                  <span><b>{note.title || t("note.untitled")}</b><small>{note.updatedAt ? new Date(note.updatedAt).toLocaleDateString(locale) : "Markdown"}</small></span>
                </button>
              )) : <p className="lightseek-content-empty">{t("empty")}</p>
          )}
        </div>
        <div className="lightseek-content-browser-preview">
          {tab === "materials" ? selectedMaterial ? (
            <>
              <div className="lightseek-content-preview-media"><MaterialPreviewMedia asset={selectedMaterial} alt={t("preview.image")} /></div>
              <div className="lightseek-content-preview-copy"><b>{selectedMaterial.name}</b><p>{selectedMaterial.description || selectedMaterial.kind}</p></div>
              <button type="button" className="lightseek-content-send" disabled={busy} onClick={() => void sendMaterial()}>{busy ? t("sending") : t("send")}</button>
            </>
          ) : <p className="lightseek-content-empty">{t("select.material")}</p> : selectedNote ? (
            <>
              <div className="lightseek-content-preview-copy"><b>{selectedNote.title || t("note.untitled")}</b><p>{contentExcerpt(selectedNote.contentText || "") || "Markdown"}</p></div>
              <button type="button" className="lightseek-content-send" disabled={busy} onClick={() => void sendNote()}>{busy ? t("sending") : t("send")}</button>
            </>
          ) : <p className="lightseek-content-empty">{t("select.note")}</p>}
          {status ? <p className="lightseek-content-status" role="status">{status}</p> : null}
        </div>
      </div>
    </aside>
  );
}
