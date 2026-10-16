import { useState, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { consumeNavFocus, focusEntity, publishCurrentTagContext } from "../../core/services/context";
import { createTag, updateTag as svcUpdateTag, mergeTags as svcMergeTags, deleteTag as svcDeleteTag } from "../../core/services/tags";
import { getLuckyRayBridgeSync } from "../../core/bridge/luckyRayBridge";
import { readActiveKnowledgeSource } from "../../core/services/knowledgeSource";
import deleteIconUrl from "../../assets/icons/lightseek-ui-v2/tag-delete-rounded.svg";
import editIconUrl from "../../assets/icons/lightseek-ui-v2/tag-edit-rounded.svg";
import mergeIconUrl from "../../assets/icons/lightseek-ui-v2/tag-merge-rounded.svg";
import tagIconUrl from "../../assets/icons/lightseek-ui-v2/tag.svg";
import "../../components/contentBrowserControls.css";
import "../../components/editorialContentChrome.css";
import "./tags.css";
import { getTagSourceCounts, useTags } from "./useTags";
import type { BridgeTag, TagSourceCounts } from "./useTags";
import TagDetail from "./TagDetail";
import {
  filterAndSortTagGallery,
  resolveTagFocusForActiveVault,
  summarizeTagGallery,
} from "./tagGalleryModel";
import type { TagDetailFilter, TagGalleryFilter, TagGallerySort } from "./tagGalleryModel";
import { defineMessages, useMessages } from "../../core/i18n/index";
import { useApplicationModalSurface } from "../../app/applicationModalIsolation";

const COPY = defineMessages({
  "status.missing": { "zh-CN": "标签已不存在，已返回全部标签", "en-US": "The tag no longer exists; returned to all tags" },
  "status.otherVault": { "zh-CN": "标签导航来自另一个知识库或已失效，已返回全部标签", "en-US": "The tag belongs to another vault or is unavailable; returned to all tags" },
  "status.editReadonly": { "zh-CN": "真实仓库标签请在对应文档的标签区编辑", "en-US": "Edit this vault tag from the corresponding document" },
  "status.mergeReadonly": { "zh-CN": "真实仓库标签合并稍后接入", "en-US": "Vault tag merging is not available yet" },
  "status.removeReadonly": { "zh-CN": "真实仓库标签请在对应文档的标签区移除", "en-US": "Remove this vault tag from the corresponding document" },
  "status.bridge": { "zh-CN": "标签桥未就绪，稍后再试", "en-US": "The tag bridge is not ready. Try again later." },
  "status.mergeBridge": { "zh-CN": "标签合并桥未就绪，稍后再试", "en-US": "The tag merge bridge is not ready. Try again later." },
  "status.created": { "zh-CN": "已新建标签", "en-US": "Tag created" },
  "status.createFailed": { "zh-CN": "新建标签失败", "en-US": "Could not create tag" },
  "status.saved": { "zh-CN": "已保存标签", "en-US": "Tag saved" },
  "status.saveFailed": { "zh-CN": "保存标签失败", "en-US": "Could not save tag" },
  "status.merged": { "zh-CN": "已合并标签", "en-US": "Tags merged" },
  "status.mergeFailed": { "zh-CN": "合并标签失败", "en-US": "Could not merge tags" },
  "status.deleted": { "zh-CN": "已删除标签", "en-US": "Tag deleted" },
  "status.deleteFailed": { "zh-CN": "删除失败", "en-US": "Could not delete tag" },
  "gallery.aria": { "zh-CN": "标签画廊", "en-US": "Tag gallery" },
  "header.title": { "zh-CN": "标签", "en-US": "Tags" },
  "header.subtitle": { "zh-CN": "整理素材与知识，让相关内容自然聚在一起", "en-US": "Organize materials and knowledge so related content gathers naturally" },
  "action.create": { "zh-CN": "新建标签", "en-US": "New tag" },
  "search": { "zh-CN": "搜索标签", "en-US": "Search tags" },
  "filter.all": { "zh-CN": "全部", "en-US": "All" },
  "filter.mixed": { "zh-CN": "混合", "en-US": "Mixed" },
  "filter.materials": { "zh-CN": "素材", "en-US": "Materials" },
  "filter.knowledge": { "zh-CN": "知识库", "en-US": "Knowledge" },
  "filter.aria": { "zh-CN": "标签来源筛选", "en-US": "Filter tags by source" },
  "summary.tags.one": { "zh-CN": "{count} 个标签", "en-US": "{count} tag" }, "summary.tags.other": { "zh-CN": "{count} 个标签", "en-US": "{count} tags" },
  "summary.materials.one": { "zh-CN": "{count} 项素材", "en-US": "{count} material" }, "summary.materials.other": { "zh-CN": "{count} 项素材", "en-US": "{count} materials" },
  "summary.knowledge.one": { "zh-CN": "{count} 篇知识库文档", "en-US": "{count} Knowledge document" }, "summary.knowledge.other": { "zh-CN": "{count} 篇知识库文档", "en-US": "{count} Knowledge documents" },
  "error.refresh": { "zh-CN": "刷新失败，仍显示上次内容", "en-US": "Refresh failed; showing previous content" },
  "loading.aria": { "zh-CN": "正在加载标签", "en-US": "Loading tags" },
  "error.title": { "zh-CN": "标签加载失败", "en-US": "Could not load tags" },
  "error.copy": { "zh-CN": "稍后返回这里重试，不会影响已有素材与知识库内容。", "en-US": "Return later to retry; existing materials and Knowledge content are unaffected." },
  "empty.none": { "zh-CN": "还没有标签", "en-US": "No tags yet" },
  "empty.filtered": { "zh-CN": "没有符合条件的标签", "en-US": "No matching tags" },
  "empty.noneCopy": { "zh-CN": "在素材或知识库中添加标签后，它们会出现在这里。", "en-US": "Tags added in Materials or Knowledge will appear here." },
  "empty.filteredCopy": { "zh-CN": "试试调整搜索内容或来源筛选。", "en-US": "Adjust the search or source filter." },
  "dialog.create": { "zh-CN": "新建标签", "en-US": "New tag" },
  "dialog.edit": { "zh-CN": "编辑标签", "en-US": "Edit tag" },
  "dialog.merge": { "zh-CN": "合并标签", "en-US": "Merge tags" },
  "dialog.delete": { "zh-CN": "删除标签", "en-US": "Delete tag" },
  "action.cancel": { "zh-CN": "取消", "en-US": "Cancel" },
  "action.new": { "zh-CN": "新建", "en-US": "Create" },
  "action.save": { "zh-CN": "保存", "en-US": "Save" },
  "action.merge": { "zh-CN": "合并标签", "en-US": "Merge tags" },
  "action.delete": { "zh-CN": "删除", "en-US": "Delete" },
  "field.name": { "zh-CN": "标签名称", "en-US": "Tag name" },
  "merge.sources": { "zh-CN": "并入的标签", "en-US": "Source tags" },
  "merge.selected.one": { "zh-CN": "{count} 个已选标签", "en-US": "{count} tag selected" }, "merge.selected.other": { "zh-CN": "{count} 个已选标签", "en-US": "{count} tags selected" },
  "merge.none": { "zh-CN": "尚未选择", "en-US": "None selected" },
  "merge.affected.one": { "zh-CN": "共影响 {count} 项内容", "en-US": "Affects {count} item" }, "merge.affected.other": { "zh-CN": "共影响 {count} 项内容", "en-US": "Affects {count} items" },
  "merge.chooseHint": { "zh-CN": "从下方选择一个或多个来源标签", "en-US": "Choose one or more source tags below" },
  "merge.into": { "zh-CN": "并入", "en-US": "Merge into" },
  "merge.target": { "zh-CN": "保留为目标标签", "en-US": "Keep as target tag" },
  "merge.existing.one": { "zh-CN": "现有 {count} 项内容", "en-US": "Currently {count} item" }, "merge.existing.other": { "zh-CN": "现有 {count} 项内容", "en-US": "Currently {count} items" },
  "merge.choose": { "zh-CN": "选择要并入的标签", "en-US": "Choose tags to merge" },
  "merge.progress": { "zh-CN": "{selected} / {total} 已选", "en-US": "{selected} / {total} selected" },
  "merge.total.one": { "zh-CN": "共 {count} 项", "en-US": "{count} item" }, "merge.total.other": { "zh-CN": "共 {count} 项", "en-US": "{count} items" },
  "merge.note": { "zh-CN": "合并后，来源标签将移除；素材与笔记的标签关系会转到目标标签。", "en-US": "Source tags will be removed and their material and note relationships will move to the target tag." },
  "delete.copy": { "zh-CN": "确定删除「{name}」？关联内容不会删除，只会移除这个标签。", "en-US": "Delete “{name}”? Linked content remains; only this tag is removed." },
  "card.total.one": { "zh-CN": "共 {count} 项", "en-US": "{count} item" }, "card.total.other": { "zh-CN": "共 {count} 项", "en-US": "{count} items" },
  "card.noPreview": { "zh-CN": "暂无预览", "en-US": "No preview" },
  "card.documentMark": { "zh-CN": "文", "en-US": "Doc" },
  "kind.video": { "zh-CN": "视频", "en-US": "Video" },
  "kind.audio": { "zh-CN": "音频", "en-US": "Audio" },
  "kind.document": { "zh-CN": "文档", "en-US": "Document" },
  "kind.material": { "zh-CN": "素材", "en-US": "Material" },
  "detail.aria": { "zh-CN": "{name} 标签详情", "en-US": "Details for tag {name}" },
  "action.back": { "zh-CN": "返回", "en-US": "Back" },
  "detail.materials.one": { "zh-CN": "素材 {count}", "en-US": "{count} material" }, "detail.materials.other": { "zh-CN": "素材 {count}", "en-US": "{count} materials" },
  "detail.knowledge.one": { "zh-CN": "知识库 {count}", "en-US": "{count} Knowledge document" }, "detail.knowledge.other": { "zh-CN": "知识库 {count}", "en-US": "{count} Knowledge documents" },
  "detail.total.one": { "zh-CN": "共 {count} 项", "en-US": "{count} item total" }, "detail.total.other": { "zh-CN": "共 {count} 项", "en-US": "{count} items total" },
  "action.edit": { "zh-CN": "编辑标签", "en-US": "Edit tag" },
  "action.mergeTitle": { "zh-CN": "合并标签", "en-US": "Merge tags" },
  "action.deleteTitle": { "zh-CN": "删除标签", "en-US": "Delete tag" },
  "detail.filterAria": { "zh-CN": "标签内容筛选", "en-US": "Filter tag content" },
  "source.materials.one": { "zh-CN": "素材 {count}", "en-US": "{count} material" }, "source.materials.other": { "zh-CN": "素材 {count}", "en-US": "{count} materials" },
  "source.knowledge.one": { "zh-CN": "知识库 {count}", "en-US": "{count} Knowledge document" }, "source.knowledge.other": { "zh-CN": "知识库 {count}", "en-US": "{count} Knowledge documents" },
  "source.empty": { "zh-CN": "暂无关联内容", "en-US": "No linked content" },
  "sort.linked": { "zh-CN": "关联数", "en-US": "Linked items" },
  "sort.name": { "zh-CN": "名称", "en-US": "Name" },
  "sort.label": { "zh-CN": "排序", "en-US": "Sort" },
  "sort.aria": { "zh-CN": "标签排序方式", "en-US": "Tag sort order" },
  "color.aria": { "zh-CN": "标签颜色", "en-US": "Tag color" },
  "color.option": { "zh-CN": "标签颜色 {color}", "en-US": "Tag color {color}" },
  "dialog.kicker": { "zh-CN": "标签", "en-US": "Tag" },
  "dialog.close": { "zh-CN": "关闭对话框", "en-US": "Close dialog" },
});

const TAG_COLORS = ["#fbbf24", "#7c8aff", "#4ade80", "#a78bfa", "#fb7185", "#38bdf8", "#f97316", "#94a3b8"];

function readTagDetailId(hashPath: string) {
  const segment = hashPath.split("/")[1];
  if (!segment) return null;
  try { return decodeURIComponent(segment); } catch { return null; }
}

function tagDetailHash(tagId: string) {
  return `#tags/${encodeURIComponent(tagId)}`;
}

export default function TagsPage({ hashPath = "tags" }: { hashPath?: string }) {
  const { plural, t } = useMessages(COPY);
  const { tags, loading, error, refresh } = useTags();
  const requestedTagId = useMemo(() => readTagDetailId(hashPath), [hashPath]);
  const [activeTagId, setActiveTagId] = useState<string | null>(requestedTagId);
  const [query, setQuery] = useState("");
  const [galleryFilter, setGalleryFilter] = useState<TagGalleryFilter>("all");
  const [gallerySort, setGallerySort] = useState<TagGallerySort>("linked");
  const [detailFilter, setDetailFilter] = useState<TagDetailFilter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createColor, setCreateColor] = useState(TAG_COLORS[0]);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState(TAG_COLORS[0]);
  const [mergeIds, setMergeIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const browseScrollTopRef = useRef(0);
  const restoreBrowseScrollRef = useRef(false);

  const activeTag = tags.find((tag) => tag.id === activeTagId) || null;
  const activeTagReadOnly = Boolean(activeTag && getTagSourceCounts(activeTag).realVaultDocumentCount > 0);
  const mergeCandidates = tags.filter((tag) => (
    tag.id !== activeTag?.id && getTagSourceCounts(tag).realVaultDocumentCount === 0
  ));
  const selectedMergeTags = mergeCandidates.filter((tag) => mergeIds.includes(tag.id));
  const mergeAffectedCount = selectedMergeTags.reduce(
    (total, tag) => total + getTagSourceCounts(tag).total,
    0,
  );
  const summary = useMemo(() => summarizeTagGallery(tags), [tags]);
  const galleryTags = useMemo(() => filterAndSortTagGallery(tags, {
    query,
    filter: galleryFilter,
    sort: gallerySort,
  }), [galleryFilter, gallerySort, query, tags]);

  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(null), 2600);
    return () => window.clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    if (requestedTagId === activeTagId) return;
    setActiveTagId(requestedTagId);
    setDetailFilter("all");
    if (!requestedTagId) publishCurrentTagContext(null);
  }, [activeTagId, requestedTagId]);

  useEffect(() => {
    if (!tags.length) return;
    const focus = consumeNavFocus("tag");
    if (!focus) return;
    const activeSource = readActiveKnowledgeSource();
    const resolution = resolveTagFocusForActiveVault(
      tags,
      focus.id,
      activeSource && activeSource.mode === "real-vault" ? activeSource.vaultId || null : null,
    );
    if (resolution.tag) {
      window.location.hash = tagDetailHash(resolution.tag.id);
      setActiveTagId(resolution.tag.id);
      setDetailFilter("all");
      publishCurrentTagContext({ id: resolution.tag.id, name: resolution.tag.name });
    } else {
      window.location.hash = "#tags";
      setActiveTagId(null);
      setStatus(resolution.status === "not-found" ? t("status.missing") : t("status.otherVault"));
    }
  }, [t, tags]);

  useEffect(() => {
    if (!activeTagId || loading || activeTag) return;
    window.location.hash = "#tags";
    setActiveTagId(null);
    setStatus(t("status.missing"));
  }, [activeTag, activeTagId, loading, t]);

  useLayoutEffect(() => {
    if (activeTagId || !restoreBrowseScrollRef.current || !pageRef.current) return;
    pageRef.current.scrollTop = browseScrollTopRef.current;
    restoreBrowseScrollRef.current = false;
  }, [activeTagId]);

  const enterTagDetail = useCallback((tag: BridgeTag, rememberScroll = true) => {
    if (rememberScroll && pageRef.current) browseScrollTopRef.current = pageRef.current.scrollTop;
    window.location.hash = tagDetailHash(tag.id);
    setActiveTagId(tag.id);
    setDetailFilter("all");
    publishCurrentTagContext({ id: tag.id, name: tag.name });
  }, []);

  const returnToGallery = useCallback(() => {
    restoreBrowseScrollRef.current = true;
    window.location.hash = "#tags";
    setActiveTagId(null);
    setDetailFilter("all");
    publishCurrentTagContext(null);
  }, []);

  const openCreateTag = useCallback(() => {
    setCreateName("");
    setCreateColor(TAG_COLORS[0]);
    setStatus(null);
    setCreateOpen(true);
  }, []);

  const openEditTag = useCallback(() => {
    if (!activeTag) return;
    if (getTagSourceCounts(activeTag).realVaultDocumentCount > 0) {
      setStatus(t("status.editReadonly"));
      return;
    }
    setEditName(activeTag.name);
    setEditColor(activeTag.color || TAG_COLORS[0]);
    setStatus(null);
    setEditOpen(true);
  }, [activeTag, t]);

  const openMergeTag = useCallback(() => {
    if (!activeTag) return;
    if (getTagSourceCounts(activeTag).realVaultDocumentCount > 0) {
      setStatus(t("status.mergeReadonly"));
      return;
    }
    setMergeIds([]);
    setStatus(null);
    setMergeOpen(true);
  }, [activeTag, t]);

  const handleCreateTag = useCallback(async () => {
    const name = createName.trim();
    if (!name) return;
    if (!getLuckyRayBridgeSync()?.createTag) {
      setStatus(t("status.bridge"));
      return;
    }
    try {
      setBusy(true);
      const created = await createTag({ name, color: createColor });
      await refresh();
      window.location.hash = tagDetailHash(created.id);
      setActiveTagId(created.id);
      setDetailFilter("all");
      publishCurrentTagContext({ id: created.id, name: created.name });
      setCreateOpen(false);
      setStatus(t("status.created"));
    } catch (cause) {
      console.warn("[tags] createTag failed", cause);
      setStatus(t("status.createFailed"));
    } finally {
      setBusy(false);
    }
  }, [createColor, createName, refresh, t]);

  const handleEditTag = useCallback(async () => {
    if (!activeTag) return;
    if (getTagSourceCounts(activeTag).realVaultDocumentCount > 0) {
      setStatus(t("status.editReadonly"));
      return;
    }
    const newName = editName.trim();
    if (!newName) return;
    const bridge = getLuckyRayBridgeSync();
    if (!bridge?.updateTag && !bridge?.renameTag) {
      setStatus(t("status.bridge"));
      return;
    }
    const colorChanged = editColor !== (activeTag.color || TAG_COLORS[0]);
    if (newName === activeTag.name && !colorChanged) {
      setEditOpen(false);
      return;
    }
    try {
      setBusy(true);
      const updated = await svcUpdateTag(activeTag.id, { name: newName, color: editColor });
      await refresh();
      publishCurrentTagContext({ id: activeTag.id, name: updated?.name || newName });
      setStatus(t("status.saved"));
      setEditOpen(false);
    } catch (cause) {
      console.warn("[tags] updateTag failed", cause);
      setStatus(t("status.saveFailed"));
    } finally {
      setBusy(false);
    }
  }, [activeTag, editColor, editName, refresh, t]);

  const handleMergeTags = useCallback(async () => {
    if (!activeTag || mergeIds.length === 0) return;
    if (getTagSourceCounts(activeTag).realVaultDocumentCount > 0) {
      setStatus(t("status.mergeReadonly"));
      return;
    }
    if (!getLuckyRayBridgeSync()?.mergeTags) {
      setStatus(t("status.mergeBridge"));
      return;
    }
    try {
      setBusy(true);
      await svcMergeTags(activeTag.id, mergeIds);
      await refresh();
      setActiveTagId(activeTag.id);
      setMergeOpen(false);
      setMergeIds([]);
      setStatus(t("status.merged"));
    } catch (cause) {
      console.warn("[tags] mergeTags failed", cause);
      setStatus(t("status.mergeFailed"));
    } finally {
      setBusy(false);
    }
  }, [activeTag, mergeIds, refresh, t]);

  const handleDeleteTag = useCallback(async () => {
    if (!activeTag) return;
    if (getTagSourceCounts(activeTag).realVaultDocumentCount > 0) {
      setStatus(t("status.removeReadonly"));
      return;
    }
    if (!getLuckyRayBridgeSync()?.deleteTag) {
      setStatus(t("status.bridge"));
      return;
    }
    try {
      setBusy(true);
      await svcDeleteTag(activeTag.id);
      restoreBrowseScrollRef.current = true;
      window.location.hash = "#tags";
      setActiveTagId(null);
      await refresh();
      setStatus(t("status.deleted"));
      setDeleteOpen(false);
    } catch (cause) {
      console.warn("[tags] deleteTag failed", cause);
      setStatus(t("status.deleteFailed"));
    } finally {
      setBusy(false);
    }
  }, [activeTag, refresh, t]);

  const handleOpenAsset = useCallback((assetId: string) => {
    focusEntity("asset", assetId);
    window.location.hash = "#materials";
  }, []);

  const handleOpenNote = useCallback((noteId: string) => {
    focusEntity("note", noteId);
    window.location.hash = "#notes";
  }, []);

  const toggleMergeTag = useCallback((id: string) => {
    setMergeIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }, []);

  return (
    <div id="page-tags" className="page editorial-page-surface" ref={pageRef}
      data-native-tag-id={activeTag?.id}
      data-native-tag-ready={activeTag?.source === "real-vault" && !loading && !error ? "true" : undefined}>
      <main className="tags-page-content">
        {status && <div className="tag-inline-status" role="status">{status}</div>}
        {activeTag ? (
          <TagFocusView
            tag={activeTag}
            readOnly={activeTagReadOnly}
            mergeCandidates={mergeCandidates}
            filter={detailFilter}
            onFilter={setDetailFilter}
            onBack={returnToGallery}
            onEdit={openEditTag}
            onMerge={openMergeTag}
            onDelete={() => activeTagReadOnly
              ? setStatus(t("status.removeReadonly"))
              : setDeleteOpen(true)}
          >
            <TagDetail
              tag={activeTag}
              contentFilter={detailFilter}
              onOpenAsset={handleOpenAsset}
              onOpenNote={handleOpenNote}
              onChanged={refresh}
            />
          </TagFocusView>
        ) : (
          <section className="tag-gallery-view tag-view" aria-label={t("gallery.aria")}>
            <header className="tag-page-header editorial-page-heading">
              <div>
                <h1>{t("header.title")}</h1>
                <p>{t("header.subtitle")}</p>
              </div>
              <button className="tag-create-button editorial-primary-action" type="button" onClick={openCreateTag}>{t("action.create")}</button>
            </header>

            <div className="tag-gallery-toolbar">
              <div className="tag-gallery-controls">
                <label className="tag-search-field">
                  <span className="tag-visually-hidden">{t("search")}</span>
                  <input className="content-browser-control" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("search")} />
                </label>
                <TagSortMenu value={gallerySort} onChange={setGallerySort} />
              </div>

              <div className="tag-gallery-meta">
                <TagSegments<TagGalleryFilter>
                  value={galleryFilter}
                  onChange={setGalleryFilter}
                  items={[["all", t("filter.all")], ["mixed", t("filter.mixed")], ["materials", t("filter.materials")], ["knowledge", t("filter.knowledge")]]}
                  label={t("filter.aria")}
                />
                <p>{[
                  plural(summary.tags, { one: "summary.tags.one", other: "summary.tags.other" }),
                  plural(summary.materials, { one: "summary.materials.one", other: "summary.materials.other" }),
                  plural(summary.knowledge, { one: "summary.knowledge.one", other: "summary.knowledge.other" }),
                ].join(" · ")}</p>
              </div>
            </div>

            {error && tags.length > 0 && <div className="tag-page-refresh-error experience-error" role="status">{t("error.refresh")}</div>}
            {loading && tags.length === 0 ? (
              <div className="tag-gallery-grid experience-skeleton" role="status" aria-live="polite">
                <span className="tag-visually-hidden">{t("loading.aria")}</span>
                {Array.from({ length: 6 }, (_, index) => <div className="tag-card tag-card-skeleton" key={index} aria-hidden="true" />)}
              </div>
            ) : error && tags.length === 0 ? (
              <TagGalleryEmpty title={t("error.title")} copy={t("error.copy")} tone="error" />
            ) : galleryTags.length === 0 ? (
              <TagGalleryEmpty
                title={tags.length === 0 ? t("empty.none") : t("empty.filtered")}
                copy={tags.length === 0 ? t("empty.noneCopy") : t("empty.filteredCopy")}
              />
            ) : (
              <div className="tag-gallery-grid">
                {galleryTags.map((tag) => <TagGalleryCard key={tag.id} tag={tag} onClick={() => enterTagDetail(tag)} />)}
              </div>
            )}
          </section>
        )}
      </main>

      {createOpen && (
        <TagDialog
          title={t("dialog.create")}
          onClose={() => setCreateOpen(false)}
          actions={(
            <>
              <button className="tag-dialog-btn" onClick={() => setCreateOpen(false)} disabled={busy}>{t("action.cancel")}</button>
              <button className="tag-dialog-btn primary" onClick={() => void handleCreateTag()} disabled={busy || !createName.trim()}>{t("action.new")}</button>
            </>
          )}
        >
          <input className="tag-dialog-input" value={createName} placeholder={t("field.name")} onChange={(event) => setCreateName(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Enter") void handleCreateTag();
            if (event.key === "Escape") setCreateOpen(false);
          }} data-modal-initial-focus />
          <ColorSwatches value={createColor} onChange={setCreateColor} />
        </TagDialog>
      )}

      {activeTag && editOpen && (
        <TagDialog
          title={t("dialog.edit")}
          onClose={() => setEditOpen(false)}
          actions={(
            <>
              <button className="tag-dialog-btn" onClick={() => setEditOpen(false)} disabled={busy}>{t("action.cancel")}</button>
              <button className="tag-dialog-btn primary" onClick={() => void handleEditTag()} disabled={busy || !editName.trim()}>{t("action.save")}</button>
            </>
          )}
        >
          <input className="tag-dialog-input" value={editName} onChange={(event) => setEditName(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Enter") void handleEditTag();
            if (event.key === "Escape") setEditOpen(false);
          }} data-modal-initial-focus />
          <ColorSwatches value={editColor} onChange={setEditColor} />
        </TagDialog>
      )}

      {activeTag && mergeOpen && (
        <TagDialog
          title={t("dialog.merge")}
          className="tag-merge-dialog"
          onClose={() => setMergeOpen(false)}
          actions={(
            <>
              <button className="tag-dialog-btn" onClick={() => setMergeOpen(false)} disabled={busy}>{t("action.cancel")}</button>
              <button className="tag-dialog-btn primary" onClick={() => void handleMergeTags()} disabled={busy || mergeIds.length === 0}>{t("action.merge")}</button>
            </>
          )}
        >
          <div className="tag-merge-flow">
            <div className="tag-merge-flow-node sources">
              <span>{t("merge.sources")}</span>
              <strong>{selectedMergeTags.length > 0 ? plural(selectedMergeTags.length, { one: "merge.selected.one", other: "merge.selected.other" }) : t("merge.none")}</strong>
              <small>{selectedMergeTags.length > 0 ? plural(mergeAffectedCount, { one: "merge.affected.one", other: "merge.affected.other" }) : t("merge.chooseHint")}</small>
            </div>
            <div className="tag-merge-direction" aria-label={t("merge.into")}>
              <span aria-hidden="true">→</span>
              <small>{t("merge.into")}</small>
            </div>
            <div className="tag-merge-flow-node target">
              <span>{t("merge.target")}</span>
              <strong><TagGlyph compact />{activeTag.name}</strong>
              <small>{plural(getTagSourceCounts(activeTag).total, { one: "merge.existing.one", other: "merge.existing.other" })}</small>
            </div>
          </div>
          <div className="tag-merge-picker-head">
            <strong>{t("merge.choose")}</strong>
            <span>{t("merge.progress", { selected: mergeIds.length, total: mergeCandidates.length })}</span>
          </div>
          <div className="tag-merge-list">
            {mergeCandidates.map((tag, index) => (
              <label className="tag-merge-item" key={tag.id}>
                <input type="checkbox" checked={mergeIds.includes(tag.id)} onChange={() => toggleMergeTag(tag.id)} disabled={busy} data-modal-initial-focus={index === 0 ? "true" : undefined} />
                <TagGlyph compact />
                <span>{tag.name}</span>
                <small>{plural(getTagSourceCounts(tag).total, { one: "merge.total.one", other: "merge.total.other" })}</small>
              </label>
            ))}
          </div>
          <p className="tag-merge-note">{t("merge.note")}</p>
        </TagDialog>
      )}

      {activeTag && deleteOpen && (
        <TagDialog
          title={t("dialog.delete")}
          dialogRole="alertdialog"
          descriptionId="tag-delete-copy"
          onClose={() => setDeleteOpen(false)}
          actions={(
            <>
              <button className="tag-dialog-btn" data-modal-initial-focus onClick={() => setDeleteOpen(false)} disabled={busy}>{t("action.cancel")}</button>
              <button className="tag-dialog-btn danger" onClick={() => void handleDeleteTag()} disabled={busy}>{t("action.delete")}</button>
            </>
          )}
        >
          <p className="tag-dialog-copy" id="tag-delete-copy">{t("delete.copy", { name: activeTag.name })}</p>
        </TagDialog>
      )}
    </div>
  );
}

function TagGalleryCard({ tag, onClick }: { tag: BridgeTag; onClick: () => void }) {
  const { plural } = useMessages(COPY);
  const counts = getTagSourceCounts(tag);
  return (
    <button type="button" className="tag-gallery-card" style={{ "--tag-card-color": tag.color || TAG_COLORS[1] } as CSSProperties} onClick={onClick}>
      <div className="tag-card-copy">
        <strong className="tag-card-name">{tag.name}</strong>
        <span className="tag-card-total">{plural(counts.total, { one: "card.total.one", other: "card.total.other" })}</span>
        <TagSourceSummary counts={counts} />
      </div>
      <TagCardPreview tag={tag} />
    </button>
  );
}

function TagCardPreview({ tag }: { tag: BridgeTag }) {
  const { t } = useMessages(COPY);
  const assets = tag.galleryAssets || [];
  const documents = tag.realVaultDocuments || tag.documents || [];
  const entries = [
    ...assets.map((asset) => ({ type: "asset" as const, asset })),
    ...documents.slice(0, Math.max(0, 3 - assets.length)).map((document) => ({ type: "document" as const, document })),
  ].slice(0, 3);
  if (entries.length === 0) return <span className="tag-card-preview empty">{t("card.noPreview")}</span>;
  return (
    <span className="tag-card-preview" aria-hidden="true">
      {entries.map((entry, index) => entry.type === "asset" ? (
        <span className="tag-card-preview-item" key={entry.asset.id} style={{ "--tag-preview-index": index } as CSSProperties}>
          {canRenderGalleryThumbnail(entry.asset.kind, entry.asset.thumbnailUrl) ? (
            <img src={entry.asset.thumbnailUrl} alt="" loading="lazy" decoding="async" />
          ) : (
            <span className="tag-card-preview-kind">{materialKindLabel(entry.asset.kind, t)}</span>
          )}
        </span>
      ) : (
        <span className="tag-card-preview-item document" key={entry.document.id} style={{ "--tag-preview-index": index } as CSSProperties}>
          <span className="tag-card-preview-document-mark">{t("card.documentMark")}</span>
          <span>{entry.document.title}</span>
        </span>
      ))}
    </span>
  );
}

function canRenderGalleryThumbnail(kind: string, thumbnailUrl: string) {
  if (!thumbnailUrl) return false;
  if (kind.toLowerCase() === "image") return true;
  return /^data:image\//i.test(thumbnailUrl) || /\.(?:png|jpe?g|webp)(?:[?#].*)?$/i.test(thumbnailUrl);
}

type TagsT = ReturnType<typeof useMessages<typeof COPY>>["t"];
function materialKindLabel(kind: string, t: TagsT) {
  const normalized = kind.toLowerCase();
  if (normalized === "video") return t("kind.video");
  if (normalized === "audio") return t("kind.audio");
  if (normalized === "document" || normalized === "pdf") return t("kind.document");
  return t("kind.material");
}

function TagFocusView({ tag, readOnly, mergeCandidates, filter, onFilter, onBack, onEdit, onMerge, onDelete, children }: {
  tag: BridgeTag;
  readOnly: boolean;
  mergeCandidates: BridgeTag[];
  filter: TagDetailFilter;
  onFilter: (filter: TagDetailFilter) => void;
  onBack: () => void;
  onEdit: () => void;
  onMerge: () => void;
  onDelete: () => void;
  children: ReactNode;
}) {
  const { plural, t } = useMessages(COPY);
  const counts = getTagSourceCounts(tag);
  return (
    <section className="tag-focus-view tag-view" aria-label={t("detail.aria", { name: tag.name })}>
      <button className="tag-back-button editorial-back-action" type="button" onClick={onBack} aria-label={t("action.back")}>
        <span className="tag-back-icon editorial-back-icon" aria-hidden="true" />
        <span>{t("action.back")}</span>
      </button>
      <header className="tag-focus-header">
        <div className="tag-focus-title">
          <TagGlyph large />
          <div>
            <h1>{tag.name}</h1>
            <p>{[
              plural(counts.assetCount, { one: "detail.materials.one", other: "detail.materials.other" }),
              plural(counts.realVaultDocumentCount, { one: "detail.knowledge.one", other: "detail.knowledge.other" }),
              plural(counts.total, { one: "detail.total.one", other: "detail.total.other" }),
            ].join(" · ")}</p>
          </div>
        </div>
        <div className="tag-detail-actions">
          <button className="tag-detail-btn" title={readOnly ? t("status.editReadonly") : t("action.edit")} aria-label={readOnly ? t("status.editReadonly") : t("action.edit")} onClick={onEdit} disabled={readOnly}>
            <span className="tag-detail-icon" style={{ "--tag-action-icon": `url("${editIconUrl}")` } as CSSProperties} aria-hidden="true" />
          </button>
          <button className="tag-detail-btn" title={readOnly ? t("status.mergeReadonly") : t("action.mergeTitle")} aria-label={readOnly ? t("status.mergeReadonly") : t("action.mergeTitle")} onClick={onMerge} disabled={readOnly || mergeCandidates.length === 0}>
            <span className="tag-detail-icon" style={{ "--tag-action-icon": `url("${mergeIconUrl}")` } as CSSProperties} aria-hidden="true" />
          </button>
          <button className="tag-detail-btn danger" title={readOnly ? t("status.removeReadonly") : t("action.deleteTitle")} aria-label={readOnly ? t("status.removeReadonly") : t("action.deleteTitle")} onClick={onDelete} disabled={readOnly}>
            <span className="tag-detail-icon" style={{ "--tag-action-icon": `url("${deleteIconUrl}")` } as CSSProperties} aria-hidden="true" />
          </button>
        </div>
      </header>
      <TagSegments<TagDetailFilter> value={filter} onChange={onFilter} items={[["all", t("filter.all")], ["materials", t("filter.materials")], ["knowledge", t("filter.knowledge")]]} label={t("detail.filterAria")} />
      <div className="tag-focus-content">{children}</div>
    </section>
  );
}

function TagSegments<T extends string>({ value, onChange, items, label }: {
  value: T;
  onChange: (value: T) => void;
  items: ReadonlyArray<readonly [T, string]>;
  label: string;
}) {
  return (
    <div className="tag-segments" role="group" aria-label={label}>
      {items.map(([id, text]) => (
        <button type="button" key={id} className={value === id ? "active" : ""} onClick={() => onChange(id)} aria-pressed={value === id}>{text}</button>
      ))}
    </div>
  );
}

function TagGlyph({ compact = false, large = false }: { compact?: boolean; large?: boolean }) {
  return <span className={`tag-glyph${compact ? " compact" : ""}${large ? " large" : ""}`} style={{ "--tag-icon-url": `url("${tagIconUrl}")` } as CSSProperties} aria-hidden="true" />;
}

function TagSourceSummary({ counts }: { counts: TagSourceCounts }) {
  const { plural, t } = useMessages(COPY);
  const parts = [
    counts.assetCount > 0 ? plural(counts.assetCount, { one: "source.materials.one", other: "source.materials.other" }) : "",
    counts.realVaultDocumentCount > 0 ? plural(counts.realVaultDocumentCount, { one: "source.knowledge.one", other: "source.knowledge.other" }) : "",
  ].filter(Boolean);
  return <span className="tag-card-sources">{parts.length ? parts.join(" · ") : t("source.empty")}</span>;
}

function TagGalleryEmpty({ title, copy, tone = "empty" }: { title: string; copy: string; tone?: "empty" | "error" }) {
  return <div className={`tag-gallery-empty experience-empty${tone === "error" ? " experience-error" : ""}`}><TagGlyph large /><strong>{title}</strong><p>{copy}</p></div>;
}

function TagSortMenu({ value, onChange }: { value: TagGallerySort; onChange: (value: TagGallerySort) => void }) {
  const { t } = useMessages(COPY);
  const options: Array<{ value: TagGallerySort; label: string }> = [{ value: "linked", label: t("sort.linked") }, { value: "name", label: t("sort.name") }];
  return (
    <label className="tag-sort-field">
      <span>{t("sort.label")}</span>
      <select
        className="tag-sort-trigger content-browser-control"
        value={value}
        aria-label={t("sort.aria")}
        onChange={(event) => onChange(event.target.value as TagGallerySort)}
      >
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function ColorSwatches({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const { t } = useMessages(COPY);
  const labelId = useId();
  const swatchRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = TAG_COLORS.indexOf(value);
  const tabStopIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const selectColorByIndex = (index: number) => {
    const safeIndex = (index + TAG_COLORS.length) % TAG_COLORS.length;
    onChange(TAG_COLORS[safeIndex]);
    swatchRefs.current[safeIndex]?.focus();
  };
  const handleColorKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      selectColorByIndex(index - 1);
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      selectColorByIndex(index + 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      selectColorByIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      selectColorByIndex(TAG_COLORS.length - 1);
    }
  };
  return (
    <div className="tag-color-field">
      <span className="tag-color-label" id={labelId}>{t("color.aria")}</span>
      <div className="tag-color-swatches" role="radiogroup" aria-labelledby={labelId}>
        {TAG_COLORS.map((color, index) => {
          const selected = value === color;
          return (
            <button
              ref={(node) => { swatchRefs.current[index] = node; }}
              key={color}
              className={`tag-color-swatch${selected ? " active" : ""}`}
              style={{ "--tag-swatch-color": color } as CSSProperties}
              onClick={() => onChange(color)}
              onKeyDown={(event) => handleColorKeyDown(event, index)}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={t("color.option", { color })}
              tabIndex={index === tabStopIndex ? 0 : -1}
            >
              <span className="tag-color-tone" aria-hidden="true" />
              <span className="tag-color-check" aria-hidden="true">
                <svg viewBox="0 0 12 12"><path d="M2.4 6.1l2.1 2.1 5-5" /></svg>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TagDialog({ title, children, actions, onClose, className = "", dialogRole = "dialog", descriptionId }: { title: string; children: ReactNode; actions?: ReactNode; onClose: () => void; className?: string; dialogRole?: "dialog" | "alertdialog"; descriptionId?: string }) {
  const { t } = useMessages(COPY);
  const titleId = useId();
  const { surfaceRef, onSurfaceKeyDown, onBackdropPointerDown } = useApplicationModalSurface<HTMLDivElement>(true, onClose);
  return (
    <div className="tag-dialog-backdrop editorial-dialog-backdrop experience-dialog-backdrop" onPointerDown={onBackdropPointerDown}>
      <div
        ref={surfaceRef}
        className={`tag-dialog editorial-dialog experience-dialog${className ? ` ${className}` : ""}`}
        role={dialogRole}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={onSurfaceKeyDown}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="tag-dialog-head editorial-dialog-head">
          <div className="editorial-dialog-header-row">
            <span className="tag-dialog-header-icon editorial-dialog-header-icon" aria-hidden="true" />
            <div className="editorial-dialog-heading">
              <div className="tag-dialog-title editorial-dialog-title" id={titleId}>{title}</div>
            </div>
            <button className="tag-dialog-close editorial-dialog-close" type="button" onClick={onClose} aria-label={t("dialog.close")} title={t("dialog.close")}>
              <span className="editorial-dialog-close-icon" aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="tag-dialog-body editorial-dialog-body">{children}</div>
        {actions ? <div className="tag-dialog-actions editorial-dialog-footer">{actions}</div> : null}
      </div>
    </div>
  );
}
