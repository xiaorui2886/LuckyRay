import { useCallback, useEffect, useMemo, useState } from "react";
import { localApiFetch } from "../../core/localApi";
import { consumeNavFocus, focusEntity, publishPageContext } from "../../core/services/context";
import {
  createKnowledgeDocument,
  insertIntoCurrentKnowledgeDocument,
  knowledgeDocumentNoteId,
} from "../../core/services/knowledge";
import { resolveLegacyMaterialLightSeekResources } from "../../core/services/materials";
import { openInLightSeek } from "../../core/services/openInLightSeek";
import { defineMessages, useMessages, type Locale } from "../../core/i18n/index";
import "./collection.css";

type CollectionItem = {
  id: string;
  type: "text" | "link" | "file" | "image";
  content: string;
  assetId: string | null;
  urlMetadata: string | null;
  source: string | null;
  createdAt: string;
  processedAt: string | null;
  processedNoteId: string | null;
  processedAction: string | null;
  thumbnail: string | null;
  browser: string | null;
  trigger: string | null;
};

type FailureItem = {
  id: string;
  source: string;
  payload: string;
  error: string;
  reason: string;
  createdAt: string;
};

type FilterKey = "active" | "all" | "text" | "link" | "image" | "file" | "processed" | "failures";

const COPY = defineMessages({
  "filter.active": { "zh-CN": "未处理", "en-US": "Unprocessed" }, "filter.all": { "zh-CN": "全部", "en-US": "All" }, "filter.text": { "zh-CN": "文本", "en-US": "Text" }, "filter.link": { "zh-CN": "链接", "en-US": "Links" }, "filter.image": { "zh-CN": "图片", "en-US": "Images" }, "filter.file": { "zh-CN": "文件", "en-US": "Files" }, "filter.processed": { "zh-CN": "已处理", "en-US": "Processed" }, "filter.failures": { "zh-CN": "失败记录", "en-US": "Failures" },
  "untitled": { "zh-CN": "未命名收集", "en-US": "Untitled Capture" }, "note.source": { "zh-CN": "来源：{url}", "en-US": "Source: {url}" }, "error.bridge": { "zh-CN": "收集箱 bridge 不可用", "en-US": "Collection bridge is unavailable" }, "error.load": { "zh-CN": "收集箱加载失败", "en-US": "Could not load Collection" },
  "status.textAdded": { "zh-CN": "已加入收集箱", "en-US": "Added to Collection" }, "error.textAdd": { "zh-CN": "添加文本失败", "en-US": "Could not add text" }, "status.linkAdded": { "zh-CN": "链接已加入收集箱", "en-US": "Link added to Collection" }, "error.linkAdd": { "zh-CN": "添加链接失败", "en-US": "Could not add link" },
  "status.clipboardAdded": { "zh-CN": "已收集剪贴板文本", "en-US": "Clipboard text collected" }, "error.clipboardEmpty": { "zh-CN": "剪贴板没有可收集文本", "en-US": "No collectible text on the clipboard" }, "error.clipboard": { "zh-CN": "读取剪贴板失败", "en-US": "Could not read the clipboard" },
  "status.toNote": { "zh-CN": "已转成笔记", "en-US": "Converted to a note" }, "error.toNote": { "zh-CN": "转成笔记失败", "en-US": "Could not convert to a note" }, "status.inserted": { "zh-CN": "已插入当前笔记", "en-US": "Inserted into the current note" }, "error.insert": { "zh-CN": "插入当前笔记失败", "en-US": "Could not insert into the current note" },
  "error.batchEmpty": { "zh-CN": "没有可整理的收集项", "en-US": "No items to organize" }, "batch.noteTitle": { "zh-CN": "收集整理 {date}", "en-US": "Collection {date}" }, "status.batch.one": { "zh-CN": "已整理 {count} 条到笔记", "en-US": "Organized {count} item into a note" }, "status.batch.other": { "zh-CN": "已整理 {count} 条到笔记", "en-US": "Organized {count} items into a note" }, "error.batch": { "zh-CN": "批量转笔记失败", "en-US": "Could not convert items to a note" },
  "status.assetNamed": { "zh-CN": "已入库：{name}", "en-US": "Added to Materials: {name}" }, "status.asset": { "zh-CN": "已收入素材库", "en-US": "Added to Materials" }, "error.asset": { "zh-CN": "图片入库失败", "en-US": "Could not add the image to Materials" }, "status.deleted": { "zh-CN": "已标记删除", "en-US": "Marked as deleted" }, "error.delete": { "zh-CN": "删除失败", "en-US": "Could not delete item" }, "status.restored": { "zh-CN": "已恢复为未处理", "en-US": "Restored as unprocessed" }, "error.restore": { "zh-CN": "恢复失败", "en-US": "Could not restore item" },
  "error.lightseekPath": { "zh-CN": "所选文件尚未收入素材库，无法取得真实路径。请先收入素材库后再发送到 LightSeek", "en-US": "The selected file is not in Materials, so its real path is unavailable. Add it to Materials before sending it to LightSeek." }, "lightseek.one": { "zh-CN": "请帮我整理这个收集箱内容。", "en-US": "Help me organize this collected item." }, "lightseek.many": { "zh-CN": "请帮我整理以下 {count} 个收集箱内容。", "en-US": "Help me organize these {count} collected items." }, "status.lightseekPaths": { "zh-CN": "已将素材路径填入 LightSeek（不是图片附件）", "en-US": "Material paths were added to LightSeek (not as image attachments)" }, "status.lightseekDraft": { "zh-CN": "已准备到 LightSeek 草稿", "en-US": "Prepared a LightSeek draft" }, "error.lightseekMissing": { "zh-CN": "素材原文件已移动或不存在，请在素材库重新定位后重试。", "en-US": "The original material was moved or is missing. Relocate it in Materials and try again." },
  "header.title": { "zh-CN": "收集箱", "en-US": "Collection" }, "header.subtitle": { "zh-CN": "浏览器插件、剪贴板和临时摘录会先落在这里，再整理成素材或笔记。", "en-US": "Browser captures, clipboard text, and quick excerpts land here before becoming materials or notes." }, "summary.aria": { "zh-CN": "{active} 条未处理，{processed} 条已处理，{failures} 条失败", "en-US": "{active} unprocessed, {processed} processed, {failures} failed" }, "summary.active": { "zh-CN": "未处理", "en-US": "Unprocessed" }, "summary.processed": { "zh-CN": "已处理", "en-US": "Processed" }, "summary.failed": { "zh-CN": "失败", "en-US": "Failed" },
  "draft.placeholder": { "zh-CN": "粘贴文字、灵感、网页摘录...", "en-US": "Paste text, ideas, or a web excerpt..." }, "action.addText": { "zh-CN": "加入文本", "en-US": "Add Text" }, "action.addLink": { "zh-CN": "加入链接", "en-US": "Add Link" }, "action.clipboard": { "zh-CN": "读取剪贴板", "en-US": "Read Clipboard" }, "search.placeholder": { "zh-CN": "筛选收集内容...", "en-US": "Filter collected items..." },
  "bulk.selected": { "zh-CN": "已选 {count} 项", "en-US": "{count} selected" }, "action.toNote": { "zh-CN": "整理为笔记", "en-US": "Organize as Note" }, "action.send": { "zh-CN": "发送到 LightSeek", "en-US": "Send to LightSeek" }, "action.clearSelection": { "zh-CN": "取消选择", "en-US": "Clear selection" }, "empty.failures": { "zh-CN": "暂无失败记录", "en-US": "No failure records" }, "empty.items": { "zh-CN": "暂无匹配的收集内容", "en-US": "No matching collected items" },
  "action.refresh": { "zh-CN": "刷新", "en-US": "Refresh" }, "detail.source": { "zh-CN": "来源", "en-US": "Source" }, "detail.time": { "zh-CN": "时间", "en-US": "Time" }, "detail.status": { "zh-CN": "状态", "en-US": "Status" }, "detail.link": { "zh-CN": "链接", "en-US": "Link" }, "action.insert": { "zh-CN": "插入当前笔记", "en-US": "Insert into Current Note" }, "action.convert": { "zh-CN": "转成笔记", "en-US": "Convert to Note" }, "action.toAssets": { "zh-CN": "收入素材库", "en-US": "Add to Materials" }, "action.openTarget": { "zh-CN": "打开目标", "en-US": "Open Target" }, "action.restore": { "zh-CN": "恢复", "en-US": "Restore" }, "action.delete": { "zh-CN": "删除", "en-US": "Delete" }, "empty.select": { "zh-CN": "选择一条收集内容查看详情", "en-US": "Select an item to view its details" },
  "type.link": { "zh-CN": "链接", "en-US": "Link" }, "type.image": { "zh-CN": "图片", "en-US": "Image" }, "type.file": { "zh-CN": "文件", "en-US": "File" }, "type.text": { "zh-CN": "文本", "en-US": "Text" }, "actionLabel.note": { "zh-CN": "已入笔记", "en-US": "Added to note" }, "actionLabel.asset": { "zh-CN": "已入素材", "en-US": "Added to Materials" }, "actionLabel.deleted": { "zh-CN": "已删除", "en-US": "Deleted" },
});
type CollectionT = ReturnType<typeof useMessages<typeof COPY>>["t"];
const FILTERS: FilterKey[] = ["active", "all", "text", "link", "image", "file", "processed", "failures"];

function getBridge() {
  return window.__LUCKYRAY__;
}

function formatDate(value: string | null | undefined, locale: Locale) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function getContentTitle(item: CollectionItem, t: CollectionT) {
  const meta = parseMeta(item.urlMetadata);
  if (typeof meta?.title === "string" && meta.title.trim()) return meta.title.trim();
  const trimmed = item.content.trim();
  if (!trimmed) return t("untitled");
  return trimmed.split(/\r?\n/)[0].slice(0, 80);
}

function parseMeta(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function itemUrl(item: CollectionItem): string | null {
  const meta = parseMeta(item.urlMetadata);
  const url = meta?.url;
  return typeof url === "string" && url ? url : item.type === "link" ? item.content : null;
}

function collectionTextForNote(item: CollectionItem, t: CollectionT): string {
  const title = getContentTitle(item, t);
  const url = itemUrl(item);
  const body = item.content.trim();
  if (url && body && body !== url) {
    return `${title}\n\n${body}\n\n${t("note.source", { url })}`;
  }
  if (url) return `${title}\n\n${url}`;
  return body || title;
}

export default function CollectionPage() {
  const { locale, plural, t } = useMessages(COPY);
  const [items, setItems] = useState<CollectionItem[]>([]);
  const [failures, setFailures] = useState<FailureItem[]>([]);
  const [filter, setFilter] = useState<FilterKey>("active");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState("");
  const [linkDraft, setLinkDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const showStatus = useCallback((kind: "ok" | "error", text: string) => {
    setStatus({ kind, text });
    window.setTimeout(() => {
      setStatus((current) => current?.text === text ? null : current);
    }, 2200);
  }, []);

  const load = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge?.collectionList) {
      showStatus("error", t("error.bridge"));
      return;
    }
    try {
      const [allItems, failureRes] = await Promise.all([
        bridge.collectionList(),
        localApiFetch("/api/collection/failures?limit=80").then((res) => res.ok ? res.json() : { failures: [] }).catch(() => ({ failures: [] })),
      ]);
      setItems(allItems || []);
      setFailures(Array.isArray(failureRes.failures) ? failureRes.failures : []);
    } catch (error) {
      console.warn("[collection] load failed", error);
      showStatus("error", t("error.load"));
    }
  }, [showStatus, t]);

  useEffect(() => {
    publishPageContext("collection");
    void load();
  }, [load]);

  useEffect(() => {
    const consumeFocus = () => {
      const focus = consumeNavFocus("collection");
      if (!focus) return;
      setSelectedId(focus.id);
      setFilter("all");
      window.setTimeout(() => document.querySelector(`[data-collection-id="${focus.id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 80);
    };
    consumeFocus();
    window.addEventListener("hashchange", consumeFocus);
    return () => window.removeEventListener("hashchange", consumeFocus);
  }, []);

  const visibleItems = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return items.filter((item) => {
      if (filter === "failures") return false;
      if (filter === "active" && item.processedAt) return false;
      if (filter === "processed" && !item.processedAt) return false;
      if (filter === "text" && item.type !== "text") return false;
      if (filter === "link" && item.type !== "link") return false;
      if (filter === "image" && item.type !== "image") return false;
      if (filter === "file" && item.type !== "file") return false;
      if (!keyword) return true;
      return [item.content, item.source, getContentTitle(item, t), itemUrl(item)].some((value) => value?.toLowerCase().includes(keyword));
    });
  }, [filter, items, query, t]);

  const selectedItem = items.find((item) => item.id === selectedId) || visibleItems[0] || null;
  const counts = useMemo(() => ({
    active: items.filter((item) => !item.processedAt).length,
    processed: items.filter((item) => item.processedAt).length,
    all: items.length,
    failures: failures.length,
  }), [failures.length, items]);

  const selectedIds = useMemo(() => Array.from(checkedIds).filter((id) => items.some((item) => item.id === id)), [checkedIds, items]);

  const addText = useCallback(async () => {
    const content = draft.trim();
    if (!content) return;
    setBusy("add-text");
    try {
      await getBridge()?.collectionAddText?.(content);
      setDraft("");
      await load();
      showStatus("ok", t("status.textAdded"));
    } catch {
      showStatus("error", t("error.textAdd"));
    } finally {
      setBusy(null);
    }
  }, [draft, load, showStatus, t]);

  const addLink = useCallback(async () => {
    const url = linkDraft.trim();
    if (!url) return;
    setBusy("add-link");
    try {
      await getBridge()?.collectionAddLink?.(url);
      setLinkDraft("");
      await load();
      showStatus("ok", t("status.linkAdded"));
    } catch {
      showStatus("error", t("error.linkAdd"));
    } finally {
      setBusy(null);
    }
  }, [linkDraft, load, showStatus, t]);

  const captureClipboard = useCallback(async () => {
    setBusy("clipboard");
    try {
      const item = await getBridge()?.collectionAddClipboard?.("text");
      await load();
      showStatus(item ? "ok" : "error", item ? t("status.clipboardAdded") : t("error.clipboardEmpty"));
    } catch {
      showStatus("error", t("error.clipboard"));
    } finally {
      setBusy(null);
    }
  }, [load, showStatus, t]);

  const itemToNote = useCallback(async (item: CollectionItem) => {
    setBusy(`note-${item.id}`);
    try {
      const document = await createKnowledgeDocument({
        title: getContentTitle(item, t),
        content: collectionTextForNote(item, t),
      });
      const noteId = knowledgeDocumentNoteId(document.documentRef);
      await getBridge()?.collectionMarkInsertedToNote?.(item.id, noteId);
      await load();
      focusEntity("note", noteId);
      showStatus("ok", t("status.toNote"));
    } catch {
      showStatus("error", t("error.toNote"));
    } finally {
      setBusy(null);
    }
  }, [load, showStatus, t]);

  const insertIntoCurrentNote = useCallback(async (item: CollectionItem) => {
    setBusy(`insert-${item.id}`);
    try {
      const result = await insertIntoCurrentKnowledgeDocument({ text: collectionTextForNote(item, t), appendIfNoCursor: true });
      const noteId = knowledgeDocumentNoteId(result.document.documentRef);
      await getBridge()?.collectionMarkInsertedToNote?.(item.id, noteId);
      await load();
      showStatus("ok", t("status.inserted"));
    } catch (error) {
      console.warn("[collection] insertIntoCurrentNote failed", error);
      showStatus("error", t("error.insert"));
    } finally {
      setBusy(null);
    }
  }, [load, showStatus, t]);

  const batchToNote = useCallback(async () => {
    if (selectedIds.length === 0) return;
    setBusy("batch-note");
    try {
      const selectedItems = selectedIds
        .map((id) => items.find((item) => item.id === id))
        .filter((item): item is CollectionItem => Boolean(item));
      if (!selectedItems.length) {
        showStatus("error", t("error.batchEmpty"));
        return;
      }
      const document = await createKnowledgeDocument({
        title: t("batch.noteTitle", { date: new Date().toLocaleDateString(locale) }),
        content: selectedItems.map((item) => collectionTextForNote(item, t)).join("\n\n---\n\n"),
      });
      const noteId = knowledgeDocumentNoteId(document.documentRef);
      await Promise.all(selectedItems.map((item) => getBridge()?.collectionMarkInsertedToNote?.(item.id, noteId)));
      setCheckedIds(new Set());
      await load();
      focusEntity("note", noteId);
      showStatus("ok", plural(selectedItems.length, { one: "status.batch.one", other: "status.batch.other" }));
    } catch {
      showStatus("error", t("error.batch"));
    } finally {
      setBusy(null);
    }
  }, [items, load, locale, plural, selectedIds, showStatus, t]);

  const moveImageToAssets = useCallback(async (item: CollectionItem) => {
    setBusy(`asset-${item.id}`);
    try {
      const result = await getBridge()?.collectionImportImageToAssets?.(item.id, itemUrl(item) || undefined);
      await load();
      if (result?.success && result.asset_id) {
        focusEntity("asset", result.asset_id);
        showStatus("ok", result.asset_name ? t("status.assetNamed", { name: result.asset_name }) : t("status.asset"));
      } else {
        showStatus("error", t("error.asset"));
      }
    } catch {
      showStatus("error", t("error.asset"));
    } finally {
      setBusy(null);
    }
  }, [load, showStatus, t]);

  const markDeleted = useCallback(async (item: CollectionItem) => {
    setBusy(`delete-${item.id}`);
    try {
      await getBridge()?.collectionMarkDeleted?.(item.id);
      await load();
      showStatus("ok", t("status.deleted"));
    } catch {
      showStatus("error", t("error.delete"));
    } finally {
      setBusy(null);
    }
  }, [load, showStatus, t]);

  const restoreItem = useCallback(async (item: CollectionItem) => {
    setBusy(`restore-${item.id}`);
    try {
      await getBridge()?.collectionRestore?.(item.id);
      await load();
      showStatus("ok", t("status.restored"));
    } catch {
      showStatus("error", t("error.restore"));
    } finally {
      setBusy(null);
    }
  }, [load, showStatus, t]);

  const askAi = useCallback(async (itemsToSend: readonly CollectionItem[]) => {
    if (itemsToSend.length === 0) return;
    try {
      const localItems = itemsToSend.filter((item) => item.type === "image" || item.type === "file");
      if (localItems.some((item) => !item.assetId)) {
        showStatus("error", t("error.lightseekPath"));
        return;
      }
      const localResources = localItems.length > 0
        ? await resolveLegacyMaterialLightSeekResources(localItems.map((item) => item.assetId as string))
        : [];
      const inlineContent = itemsToSend
        .filter((item) => item.type === "text" || item.type === "link")
        .map((item) => item.content.trim())
        .filter(Boolean);
      openInLightSeek({
        source: "collection",
        text: [
          itemsToSend.length === 1 ? t("lightseek.one") : t("lightseek.many", { count: itemsToSend.length }),
          ...inlineContent,
        ].join("\n"),
        localResources: localResources.length > 0 ? localResources : undefined,
      });
      showStatus(
        "ok",
        localResources.length > 0 ? t("status.lightseekPaths") : t("status.lightseekDraft"),
      );
    } catch {
      showStatus("error", t("error.lightseekMissing"));
    }
  }, [showStatus, t]);

  const openExternalUrl = useCallback(async (url: string) => {
    try {
      const bridge = getBridge();
      if (bridge?.openExternalUrl) await bridge.openExternalUrl(url);
      else window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }, []);

  const openTarget = useCallback((item: CollectionItem) => {
    if (item.processedNoteId) {
      focusEntity("note", item.processedNoteId);
      window.location.hash = "#notes";
      return;
    }
    if (item.assetId) {
      focusEntity("asset", item.assetId);
      window.location.hash = "#materials";
      return;
    }
    const url = itemUrl(item);
    if (url) void openExternalUrl(url);
  }, [openExternalUrl]);

  return (
    <div className="collection-page">
      <div className="collection-page-content">
      <section className="collection-hero">
        <div>
          <h1>{t("header.title")}</h1>
          <p>{t("header.subtitle")}</p>
        </div>
        <div className="collection-summary" aria-label={t("summary.aria", counts)}>
          <span><strong>{counts.active}</strong> {t("summary.active")}</span>
          <i aria-hidden="true">·</i>
          <span><strong>{counts.processed}</strong> {t("summary.processed")}</span>
          <i aria-hidden="true">·</i>
          <span><strong>{counts.failures}</strong> {t("summary.failed")}</span>
        </div>
      </section>

      <section className="collection-actions">
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={t("draft.placeholder")} />
        <div className="collection-action-row">
          <input value={linkDraft} onChange={(event) => setLinkDraft(event.target.value)} placeholder="https://..." />
          <button onClick={() => void addText()} disabled={busy === "add-text" || !draft.trim()}>{t("action.addText")}</button>
          <button onClick={() => void addLink()} disabled={busy === "add-link" || !linkDraft.trim()}>{t("action.addLink")}</button>
          <button onClick={() => void captureClipboard()} disabled={busy === "clipboard"}>{t("action.clipboard")}</button>
        </div>
      </section>

      <div className="collection-toolbar">
        <div className="collection-tabs">
          {FILTERS.map((key) => (
            <button key={key} className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>
              {t(`filter.${key}`)}
            </button>
          ))}
        </div>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("search.placeholder")} />
      </div>

      {status && <div className={`collection-status ${status.kind}`}>{status.text}</div>}

      {filter !== "failures" && selectedIds.length > 0 && (
        <div className="collection-bulk">
          <span>{t("bulk.selected", { count: selectedIds.length })}</span>
          <button onClick={() => void batchToNote()} disabled={busy === "batch-note"}>{t("action.toNote")}</button>
          <button onClick={() => void askAi(selectedIds.map((id) => items.find((item) => item.id === id)).filter((item): item is CollectionItem => Boolean(item)))}>{t("action.send")}</button>
          <button onClick={() => setCheckedIds(new Set())}>{t("action.clearSelection")}</button>
        </div>
      )}

      <main className="collection-main">
        <div className="collection-list">
          {filter === "failures" ? (
            failures.length === 0 ? <div className="collection-empty">{t("empty.failures")}</div> : failures.map((failure) => (
              <article key={failure.id} className="collection-card failure-card">
                <div className="collection-card-head">
                  <span className="collection-type">{failure.reason}</span>
                  <span>{formatDate(failure.createdAt, locale)}</span>
                </div>
                <h3>{failure.source}</h3>
                <p>{failure.error}</p>
                <pre>{failure.payload}</pre>
              </article>
            ))
          ) : visibleItems.length === 0 ? (
            <div className="collection-empty">{t("empty.items")}</div>
          ) : visibleItems.map((item) => (
            <article
              key={item.id}
              data-collection-id={item.id}
              className={`collection-card${selectedItem?.id === item.id ? " active" : ""}`}
              onClick={() => setSelectedId(item.id)}
            >
              <label className="collection-check" onClick={(event) => event.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={checkedIds.has(item.id)}
                  onChange={(event) => {
                    setCheckedIds((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(item.id);
                      else next.delete(item.id);
                      return next;
                    });
                  }}
                />
              </label>
              <div className="collection-card-body">
                <div className="collection-card-head">
                  <span className="collection-type">{typeLabel(item.type, t)}</span>
                  <span>{formatDate(item.createdAt, locale)}</span>
                </div>
                <h3>{getContentTitle(item, t)}</h3>
                <p>{item.content}</p>
                <div className="collection-meta">
                  <span>{item.source || "manual"}</span>
                  {item.processedAction && <span>{actionLabel(item.processedAction, t)}</span>}
                </div>
              </div>
            </article>
          ))}
        </div>

        {filter !== "failures" && (
          <aside className="collection-detail">
            {selectedItem ? (
              <>
                <div className="collection-detail-head">
                  <span>{typeLabel(selectedItem.type, t)}</span>
                  <button onClick={() => void load()}>{t("action.refresh")}</button>
                </div>
                <h2>{getContentTitle(selectedItem, t)}</h2>
                <dl>
                  <div><dt>{t("detail.source")}</dt><dd>{selectedItem.source || "manual"}</dd></div>
                  <div><dt>{t("detail.time")}</dt><dd>{formatDate(selectedItem.createdAt, locale)}</dd></div>
                  <div><dt>{t("detail.status")}</dt><dd>{selectedItem.processedAction ? actionLabel(selectedItem.processedAction, t) : t("filter.active")}</dd></div>
                  {itemUrl(selectedItem) && <div><dt>{t("detail.link")}</dt><dd>{itemUrl(selectedItem)}</dd></div>}
                </dl>
                <pre>{selectedItem.content}</pre>
                <div className="collection-detail-actions">
                  <button onClick={() => void insertIntoCurrentNote(selectedItem)} disabled={busy === `insert-${selectedItem.id}` || !!selectedItem.processedAt}>{t("action.insert")}</button>
                  <button onClick={() => void itemToNote(selectedItem)} disabled={busy === `note-${selectedItem.id}` || !!selectedItem.processedAt}>{t("action.convert")}</button>
                  {(selectedItem.type === "image" || selectedItem.thumbnail || itemUrl(selectedItem)) && (
                    <button onClick={() => void moveImageToAssets(selectedItem)} disabled={busy === `asset-${selectedItem.id}`}>{t("action.toAssets")}</button>
                  )}
                  <button onClick={() => void askAi([selectedItem])}>{t("action.send")}</button>
                  <button onClick={() => openTarget(selectedItem)}>{t("action.openTarget")}</button>
                  {selectedItem.processedAt ? (
                    <button onClick={() => void restoreItem(selectedItem)} disabled={busy === `restore-${selectedItem.id}`}>{t("action.restore")}</button>
                  ) : (
                    <button className="danger" onClick={() => void markDeleted(selectedItem)} disabled={busy === `delete-${selectedItem.id}`}>{t("action.delete")}</button>
                  )}
                </div>
              </>
            ) : (
              <div className="collection-empty">{t("empty.select")}</div>
            )}
          </aside>
        )}
      </main>
      </div>
    </div>
  );
}

function typeLabel(type: CollectionItem["type"], t: CollectionT) {
  return t(`type.${type}`);
}

function actionLabel(action: string, t: CollectionT) {
  if (action === "inserted_to_note") return t("actionLabel.note");
  if (action === "moved_to_assets") return t("actionLabel.asset");
  if (action === "deleted") return t("actionLabel.deleted");
  return action;
}
