import { SelectionCheck } from "../../components/SelectionCheck";
// D73: 标签详情组件
// 显示选中标签关联的素材和笔记网格。
// D124: 改用 services/tags + services/notes + services/materials 包装

import { useState, useEffect, useCallback, useLayoutEffect, useRef } from "react";
import type { MouseEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { moveContextMenuFocus } from "../../components/ContextMenuSurface";
import { calculateContextMenuPlacement } from "../../components/contextMenuPlacement";
import type { BridgeTag, RealVaultTagDocument } from "./useTags";
import { setAssetTags } from "../../core/services/tags";
import { resolveMaterialPreviewTarget } from "../../core/services/materialCatalog";
import { getLuckyRayBridgeSync } from "../../core/bridge/luckyRayBridge";
import {
  createLatestTagDetailLoader,
  getTagDetailLoadKey,
  getTagDetailLoadMode,
  loadTagDetailItemsFromActiveBridge,
  removeAssetTagRelationsAndRefresh,
  removeKnowledgeTagDocumentForStatus,
} from "./tagDetailModel";
import type { AssetItem, DetailItem, TagDetailLoadMode } from "./tagDetailModel";
import { defineMessages, useMessages } from "../../core/i18n/index";

const COPY = defineMessages({
  "error.refresh": { "zh-CN": "刷新失败，仍显示上次内容", "en-US": "Refresh failed; showing the previous content" },
  "error.load": { "zh-CN": "加载失败，请稍后重试", "en-US": "Could not load. Try again later." },
  "empty.noTags": { "zh-CN": "还没有标签，新建一个开始分类", "en-US": "Create a tag to start organizing" },
  "error.removeKnowledge": { "zh-CN": "移除知识库标签失败", "en-US": "Could not remove the Knowledge tag" },
  "readonly": { "zh-CN": "知识库标签可从单篇文档移除；重命名、合并和整体删除暂未开放。", "en-US": "Knowledge tags can be removed from individual documents; rename, merge, and full deletion are not available yet." },
  "toolbar.count.one": { "zh-CN": "{count} 项内容", "en-US": "{count} item" }, "toolbar.count.other": { "zh-CN": "{count} 项内容", "en-US": "{count} items" },
  "action.selectAll": { "zh-CN": "全选", "en-US": "Select all" },
  "action.clear": { "zh-CN": "清空", "en-US": "Clear" },
  "action.removeCurrent": { "zh-CN": "移除当前标签", "en-US": "Remove current tag" },
  "status.loading": { "zh-CN": "加载中…", "en-US": "Loading…" },
  "empty.materials": { "zh-CN": "该标签下还没有素材", "en-US": "No materials use this tag" },
  "empty.knowledge": { "zh-CN": "该标签下还没有知识库文档", "en-US": "No Knowledge documents use this tag" },
  "empty.all": { "zh-CN": "该标签下还没有素材或知识库文档", "en-US": "No materials or Knowledge documents use this tag" },
  "section.materials": { "zh-CN": "素材", "en-US": "Materials" },
  "section.knowledge": { "zh-CN": "知识库文档", "en-US": "Knowledge documents" },
  "action.open": { "zh-CN": "打开素材", "en-US": "Open asset" },
  "action.preview": { "zh-CN": "快速预览", "en-US": "Quick preview" },
  "action.select": { "zh-CN": "选择", "en-US": "Select" },
  "action.unselect": { "zh-CN": "取消选择", "en-US": "Deselect" },
  "action.remove": { "zh-CN": "移除标签", "en-US": "Remove tag" },
  "context.menu": { "zh-CN": "素材操作", "en-US": "Material actions" },
  "kind.video": { "zh-CN": "视频", "en-US": "Video" },
  "kind.image": { "zh-CN": "图片", "en-US": "Image" },
  "kind.material": { "zh-CN": "素材", "en-US": "Material" },
  "date.unknown": { "zh-CN": "更新时间未知", "en-US": "Update time unknown" },
  "action.close": { "zh-CN": "关闭", "en-US": "Close" },
  "status.removedKnowledge": { "zh-CN": "已从知识库文档移除标签", "en-US": "Tag removed from the Knowledge document" },
});

export default function TagDetail({
  tag,
  contentFilter = "all",
  onOpenAsset,
  onOpenNote,
  onChanged,
}: {
  tag: BridgeTag | null;
  contentFilter?: "all" | "materials" | "knowledge";
  onOpenAsset: (id: string) => void;
  onOpenNote: (id: string) => void;
  onChanged?: () => void;
}) {
  const { locale, plural, t } = useMessages(COPY);
  const [items, setItems] = useState<DetailItem[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ item: DetailItem; x: number; y: number } | null>(null);
  const contextMenuTriggerRef = useRef<HTMLElement | null>(null);
  const [previewItem, setPreviewItem] = useState<DetailItem | null>(null);
  const realVaultDocuments = tag?.realVaultDocuments || tag?.documents || [];
  const realVaultOnly = tag?.source === "real-vault";
  const showAssets = contentFilter !== "knowledge";
  const showKnowledge = contentFilter !== "materials";
  const detailLoadKey = getTagDetailLoadKey(tag);
  const loadedTagIdRef = useRef<string | null>(null);
  const messagesRef = useRef(t);
  messagesRef.current = t;
  const detailLoaderRef = useRef<ReturnType<typeof createLatestTagDetailLoader<DetailItem[]>> | null>(null);
  if (!detailLoaderRef.current) {
    detailLoaderRef.current = createLatestTagDetailLoader({
      load: async (tagId) => {
        const bridge = getLuckyRayBridgeSync();
        return loadTagDetailItemsFromActiveBridge(tagId, bridge);
      },
      onStart: ({ mode }) => {
        setLoading(true);
        setDetailError(null);
        if (mode === "initial") {
          setItems([]);
          setSelectedKeys(new Set());
          setStatus(null);
          setMenu(null);
          setPreviewItem(null);
        }
      },
      onResult: (result) => {
        setItems(result);
        const available = new Set(result.map(itemKey));
        setSelectedKeys((current) => new Set(Array.from(current).filter((key) => available.has(key))));
      },
      onError: (error, { mode }) => {
        console.warn("[tags] loadDetail failed", error);
        if (mode === "initial") setItems([]);
        setDetailError(mode === "background" ? messagesRef.current("error.refresh") : messagesRef.current("error.load"));
      },
      onSettled: () => {
        setLoading(false);
      },
    });
  }
  const loadDetail = useCallback(
    (tagId: string, mode: TagDetailLoadMode = "initial") => detailLoaderRef.current!.run(tagId, { mode }),
    [],
  );

  useEffect(() => {
    if (tag && detailLoadKey) {
      const mode = getTagDetailLoadMode(loadedTagIdRef.current, tag.id);
      loadedTagIdRef.current = tag.id;
      void loadDetail(tag.id, mode);
    } else {
      detailLoaderRef.current?.invalidate();
      loadedTagIdRef.current = tag?.id || null;
      setItems([]);
      setSelectedKeys(new Set());
      setLoading(false);
      setDetailError(null);
    }
  }, [detailLoadKey, loadDetail, tag?.id]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenu(null);
      requestAnimationFrame(() => contextMenuTriggerRef.current?.focus({ preventScroll: true }));
    };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", closeFromKeyboard);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [menu]);

  if (!tag) {
    return (
      <div className="tag-detail-empty">{t("empty.noTags")}</div>
    );
  }

  const selectedItems = items.filter((item) => selectedKeys.has(itemKey(item)));
  const assetItems = items.filter((item): item is Extract<DetailItem, { type: "asset" }> => item.type === "asset");
  const toggleSelected = (key: string) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const removeTagFromItems = async (targets: DetailItem[]) => {
    if (!tag || !targets.length) return;
    setBusy(true);
    try {
      await removeAssetTagRelationsAndRefresh(
        tag.id,
        targets.map((item) => item.data),
        {
          setTags: setAssetTags,
          refresh: async () => { await onChanged?.(); },
        },
      );
    } catch (error) {
      console.warn("[tags] remove tag relation failed", error);
    } finally {
      setBusy(false);
    }
  };
  const removeTagFromKnowledgeDocument = async (document: RealVaultTagDocument) => {
    if (!tag) return;
    setBusy(true);
    setStatus(null);
    try {
      const result = await removeKnowledgeTagDocumentForStatus(document, tag.name, undefined, t("status.removedKnowledge"));
      setStatus(result.status);
    } catch {
      setStatus(t("error.removeKnowledge"));
    } finally {
      setBusy(false);
    }
  };
  const openItem = (item: DetailItem) => {
    setMenu(null);
    onOpenAsset(item.data.id);
  };
  const openPreview = (item: DetailItem) => {
    setMenu(null);
    setPreviewItem(item);
  };
  const openContextMenu = (event: MouseEvent, item: DetailItem) => {
    event.preventDefault();
    event.stopPropagation();
    contextMenuTriggerRef.current = event.currentTarget as HTMLElement;
    setMenu({ item, x: event.clientX, y: event.clientY });
  };

  return (
    <>
      {status && <div className="tag-real-vault-readonly-note">{status}</div>}
      {detailError && <div className="tag-detail-refresh-error">{detailError}</div>}
      {realVaultOnly && (
        <div className="tag-real-vault-readonly-note">
          {t("readonly")}
        </div>
      )}
      {showAssets && !realVaultOnly && items.length > 0 && (
        <div className="tag-detail-toolbar">
          <span>{plural(items.length, { one: "toolbar.count.one", other: "toolbar.count.other" })}</span>
          <button onClick={() => setSelectedKeys(new Set(items.map(itemKey)))} disabled={busy}>{t("action.selectAll")}</button>
          <button onClick={() => setSelectedKeys(new Set())} disabled={busy || selectedKeys.size === 0}>{t("action.clear")}</button>
          <button onClick={() => void removeTagFromItems(selectedItems)} disabled={busy || selectedItems.length === 0}>{t("action.removeCurrent")}</button>
        </div>
      )}
      {showAssets && !realVaultOnly && loading && items.length === 0 && (
        <div className="tag-detail-grid">
          <div className="tag-detail-empty">{t("status.loading")}</div>
        </div>
      )}
      {!loading && !detailError
        && (!showAssets || items.length === 0)
        && (!showKnowledge || realVaultDocuments.length === 0) && (
        <div className="tag-detail-grid">
          <div className="tag-detail-empty">
            {contentFilter === "materials"
              ? t("empty.materials")
              : contentFilter === "knowledge"
                ? t("empty.knowledge")
                : t("empty.all")}
          </div>
        </div>
      )}
      {showAssets && !realVaultOnly && assetItems.length > 0 && (
        <TagDetailSourceSection title={t("section.materials")} count={assetItems.length}>
          <div className="tag-detail-grid">
            {assetItems.map((item) => (
              <AssetCard
                key={item.data.id}
                asset={item.data}
                selected={selectedKeys.has(itemKey(item))}
                onSelect={() => toggleSelected(itemKey(item))}
                onRemove={() => void removeTagFromItems([item])}
                onContextMenu={(event) => openContextMenu(event, item)}
                onClick={() => onOpenAsset(item.data.id)}
              />
            ))}
          </div>
        </TagDetailSourceSection>
      )}
      {showKnowledge && realVaultDocuments.length > 0 && (
        <RealVaultDocumentsSection
          documents={realVaultDocuments}
          onOpenNote={onOpenNote}
          onRemove={(document) => void removeTagFromKnowledgeDocument(document)}
          busy={busy}
          locale={locale}
        />
      )}
      {menu && (
        <TagDetailContextMenu
          x={menu.x}
          y={menu.y}
          label={t("context.menu")}
          returnFocusTo={contextMenuTriggerRef.current}
          onRequestClose={(reason) => {
            setMenu(null);
            if (reason === "escape") {
              requestAnimationFrame(() => contextMenuTriggerRef.current?.focus({ preventScroll: true }));
            }
          }}
        >
          <TagDetailContextItem icon={<TagContextOpenIcon />} label={t("action.open")} shortcut="Enter" onClick={() => openItem(menu.item)} />
          <TagDetailContextItem icon={<TagContextPreviewIcon />} label={t("action.preview")} shortcut="Space" onClick={() => openPreview(menu.item)} />
          <div className="tag-detail-context-separator" />
          <TagDetailContextItem
            icon={<TagContextSelectIcon />}
            label={selectedKeys.has(itemKey(menu.item)) ? t("action.unselect") : t("action.select")}
            onClick={() => { toggleSelected(itemKey(menu.item)); setMenu(null); }}
          />
          <div className="tag-detail-context-separator" />
          <TagDetailContextItem
            icon={<TagContextRemoveIcon />}
            label={t("action.remove")}
            danger
            onClick={() => { setMenu(null); void removeTagFromItems([menu.item]); }}
          />
        </TagDetailContextMenu>
      )}
      {previewItem && <TagDetailPreview item={previewItem} onClose={() => setPreviewItem(null)} onOpen={() => openItem(previewItem)} />}
    </>
  );
}

function TagDetailContextMenu({ x, y, label, returnFocusTo, onRequestClose, children }: {
  x: number;
  y: number;
  label: string;
  returnFocusTo?: HTMLElement | null;
  onRequestClose: (reason: "escape" | "tab") => void;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight?: number; ready: boolean }>({ left: x, top: y, ready: false });

  const placeAtPointer = useCallback(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const next = calculateContextMenuPlacement({
      anchorX: x,
      anchorY: y,
      menuWidth: menu.offsetWidth,
      menuHeight: menu.scrollHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    setPosition({ left: next.x, top: next.y, maxHeight: next.maxHeight, ready: true });
  }, [x, y]);

  useLayoutEffect(placeAtPointer, [placeAtPointer]);
  useEffect(() => {
    window.addEventListener("resize", placeAtPointer);
    return () => window.removeEventListener("resize", placeAtPointer);
  }, [placeAtPointer]);
  useEffect(() => {
    if (!position.ready) return;
    menuRef.current?.querySelector<HTMLElement>('[data-context-menu-item="root"]:not(:disabled)')?.focus({ preventScroll: true });
  }, [position.ready, x, y]);

  return createPortal(
    <div
      ref={menuRef}
      className="tag-detail-context-menu"
      role="menu"
      aria-label={label}
      style={{ left: position.left, top: position.top, maxHeight: position.maxHeight, visibility: position.ready ? "visible" : "hidden" }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onClickCapture={(event) => {
        if ((event.target as HTMLElement | null)?.closest('[role="menuitem"]') && returnFocusTo?.isConnected) {
          returnFocusTo.focus({ preventScroll: true });
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          const target = document.activeElement as HTMLButtonElement | null;
          if (target?.matches('[role="menuitem"]')) {
            event.preventDefault();
            event.stopPropagation();
            target.click();
          }
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onRequestClose("escape");
        } else if (event.key === "Tab") {
          window.setTimeout(() => onRequestClose("tab"), 0);
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
          event.preventDefault();
          event.stopPropagation();
          moveContextMenuFocus(event.currentTarget, document.activeElement as HTMLElement | null, event.key);
        }
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

function TagDetailContextItem({ icon, label, shortcut, danger, onClick }: {
  icon: ReactNode;
  label: string;
  shortcut?: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-context-menu-item="root"
      tabIndex={-1}
      className={`tag-detail-context-item${danger ? " danger" : ""}`}
      onClick={onClick}
    >
      <span className="tag-detail-context-icon" aria-hidden="true">{icon}</span>
      <span className="tag-detail-context-label">{label}</span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  );
}

function TagContextOpenIcon() {
  return <svg viewBox="0 0 16 16"><path d="M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z" /><circle cx="8" cy="8" r="2" /></svg>;
}

function TagContextPreviewIcon() {
  return <svg viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="12" rx="1" /><circle cx="5" cy="7" r="1.5" /><path d="M1 12l4-3 2 2 3-4 5 5" /></svg>;
}

function TagContextSelectIcon() {
  return <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" /><path d="m5 8 2 2 4-4" /></svg>;
}

function TagContextRemoveIcon() {
  return <svg viewBox="0 0 16 16"><polyline points="3,4 13,4" /><path d="M6 4V2h4v2M5 4v9h6V4" /></svg>;
}

function itemKey(item: DetailItem) {
  return `${item.type}:${item.data.id}`;
}

function formatSize(bytes?: number | null) {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function excerpt(text?: string) {
  const value = (text || "").replace(/\s+/g, " ").trim();
  return value.length > 72 ? `${value.slice(0, 72)}...` : value;
}

function AssetCard({ asset, selected, onSelect, onRemove, onContextMenu, onClick }: { asset: AssetItem; selected: boolean; onSelect: () => void; onRemove: () => void; onContextMenu: (event: MouseEvent) => void; onClick: () => void }) {
  const { t } = useMessages(COPY);
  const isVideo = (asset.kind || "").toLowerCase() === "video";
  const previewTarget = resolveMaterialPreviewTarget(asset);
  return (
    <div className={`tag-detail-card${selected ? " selected" : ""}`} tabIndex={0} aria-haspopup="menu" onClick={onClick} onContextMenu={onContextMenu} title={asset.name}>
      <SelectionCheck className="tag-detail-card-check" checked={selected} label={t(selected ? "action.unselect" : "action.select")} onClick={(event) => { event.stopPropagation(); onSelect(); }} />
      <div className="placeholder">
        {previewTarget?.kind === "image" ? (
          <img
            src={previewTarget.url}
            alt=""
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
        ) : previewTarget?.kind === "video-frame" ? (
          <video
            src={previewTarget.url}
            muted
            playsInline
            preload="metadata"
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        ) : (
          <div className="tag-detail-placeholder-text">
            {isVideo ? t("kind.video") : t("kind.image")}
          </div>
        )}
      </div>
      <div className="card-label">{asset.name}</div>
      <div className="card-summary">{[asset.kind, formatSize(asset.sizeBytes)].filter(Boolean).join(" · ") || t("kind.material")}</div>
      {asset.description && <div className="card-excerpt">{excerpt(asset.description)}</div>}
      <button className="tag-detail-card-action" onClick={(event) => { event.stopPropagation(); onRemove(); }}>{t("action.remove")}</button>
    </div>
  );
}


function TagDetailSourceSection({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="tag-detail-source-section">
      <div className="tag-detail-source-header">
        <span>{title}</span>
        <span>{count}</span>
      </div>
      {children}
    </section>
  );
}

function RealVaultDocumentsSection({
  documents,
  onOpenNote,
  onRemove,
  busy,
  locale,
}: {
  documents: RealVaultTagDocument[];
  onOpenNote: (id: string) => void;
  onRemove: (document: RealVaultTagDocument) => void;
  busy: boolean;
  locale: "zh-CN" | "en-US";
}) {
  const { t } = useMessages(COPY);
  return (
    <TagDetailSourceSection title={t("section.knowledge")} count={documents.length}>
      <div className="tag-document-list">
        {documents.map((document) => (
          <RealVaultNoteCard
            key={document.id}
            document={document}
            onClick={() => onOpenNote(document.id)}
            onRemove={() => onRemove(document)}
            busy={busy}
            locale={locale}
          />
        ))}
      </div>
    </TagDetailSourceSection>
  );
}

function RealVaultNoteCard({ document, onClick, onRemove, busy, locale }: { document: RealVaultTagDocument; onClick: () => void; onRemove: () => void; busy: boolean; locale: "zh-CN" | "en-US" }) {
  const { t } = useMessages(COPY);
  return (
    <div className="tag-document-row">
      <button type="button" className="tag-document-open" onClick={onClick} title={document.relativePath}>
        <span className="tag-document-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6.5 3.5h8l3 3V20.5h-11z" />
            <path d="M14.5 3.5v3h3M9 11h6M9 14h6M9 17h4" />
          </svg>
        </span>
        <span className="tag-document-copy">
          <strong>{document.title}</strong>
          <span>{document.excerpt ? excerpt(document.excerpt) : document.relativePath}</span>
          {document.excerpt && <small>{document.relativePath}</small>}
        </span>
        <time dateTime={document.updatedAt || undefined}>
          {document.updatedAt ? new Date(document.updatedAt).toLocaleDateString(locale) : t("date.unknown")}
        </time>
      </button>
      <button type="button" className="tag-document-action" disabled={busy} onClick={onRemove}>{t("action.remove")}</button>
    </div>
  );
}

function TagDetailPreview({ item, onClose, onOpen }: { item: DetailItem; onClose: () => void; onOpen: () => void }) {
  const { t } = useMessages(COPY);
  const asset = item.data;
  const isVideo = (asset?.kind || "").toLowerCase() === "video";
  const previewTarget = resolveMaterialPreviewTarget(asset);
  const previewPoster = previewTarget?.kind === "image" ? previewTarget.url : undefined;
  return (
    <div className="tag-detail-preview-backdrop" onMouseDown={onClose}>
      <div className="tag-detail-preview" onMouseDown={(event) => event.stopPropagation()}>
        <div className="tag-detail-preview-head">
          <div>
            <div className="tag-detail-preview-title">{asset.name}</div>
            <div className="tag-detail-preview-meta">{[asset.kind, formatSize(asset.sizeBytes)].filter(Boolean).join(" · ") || t("kind.material")}</div>
          </div>
          <button onClick={onClose} title={t("action.close")}>×</button>
        </div>
        <div className="tag-detail-preview-body">
          {isVideo && asset.previewUrl ? (
            <video src={asset.previewUrl} controls preload="metadata" poster={previewPoster} />
          ) : previewTarget?.kind === "image" ? (
            <img src={previewTarget.url} alt="" />
          ) : previewTarget?.kind === "video-frame" ? (
            <video src={previewTarget.url} controls preload="metadata" />
          ) : (
            <div className="tag-detail-preview-empty">{isVideo ? t("kind.video") : t("kind.material")}</div>
          )}
          {asset?.description && <p>{excerpt(asset.description)}</p>}
        </div>
        <div className="tag-detail-preview-actions">
          <button onClick={onClose}>{t("action.close")}</button>
          <button className="primary" onClick={onOpen}>{t("action.open")}</button>
        </div>
      </div>
    </div>
  );
}
