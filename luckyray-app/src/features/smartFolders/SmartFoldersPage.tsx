import { useSyncExternalStore } from "react";
import { materialLibrarySession } from "../../core/services/materialLibraryContext";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { focusEntity } from "../../core/services/context";
import { FAVORITE_CHANGE_EVENT } from "../../core/services/favorites";
import { knowledgeTagIdentity } from "../../core/services/knowledge";
import { knowledgeStore } from "../../core/services/knowledgeStore";
import { materialStore } from "../../core/services/materialStore";
import { focusNote } from "../../core/services/notes";
import {
  SMART_FOLDER_CHANGE_EVENT,
  createSmartFolder,
  deleteSmartFolder,
  emptySmartFolderCriteria,
  listSmartFolders,
  readSmartFolderDraft,
  updateSmartFolder,
  type SmartFolderCriteria,
  type SmartFolderDefinition,
  type SmartFolderDefinitionInput,
  type SmartFolderSort,
  type SmartFolderSource,
} from "../../core/services/smartFolders";
import { listTags, type TagRecord } from "../../core/services/tags";
import { openCanvasById } from "../canvas/canvasNavigation";
import AutoImportManager from "./AutoImportManager";
import { openMaterialAppearanceFromNavigation } from "../materials/materialsToolbarProtocol";
import "../../components/editorialContentChrome.css";
import {
  BUILT_IN_SMART_FOLDERS,
  canRetainSmartFolderStale,
  createLatestSmartFolderResultLoader,
  reconcileSmartFolderDetailSort,
  smartFolderLocalDateInput,
  smartFolderLocalDateIso,
  sortSmartFolderResultEntries,
  type BuiltInSmartFolderDefinition,
  type SmartFolderResultEntry,
} from "./smartFolderModel";
import { readSmartFolderResults } from "./smartFolderResults";
import "./smartFolders.css";
import { defineMessages, useMessages, type Locale } from "../../core/i18n/index";
import { useApplicationModalSurface } from "../../app/applicationModalIsolation";

const COPY = defineMessages({
  "source.material": { "zh-CN": "素材", "en-US": "Materials" },
  "source.note": { "zh-CN": "知识库", "en-US": "Knowledge" },
  "source.canvas": { "zh-CN": "画布", "en-US": "Canvas" },
  "source.materialDesc": { "zh-CN": "按格式、标签、收藏和时间整理素材", "en-US": "Organize materials by format, tags, favorites, and time" },
  "source.noteDesc": { "zh-CN": "按文字、标签、收藏和修改时间整理笔记", "en-US": "Organize notes by text, tags, favorites, and modification time" },
  "source.canvasDesc": { "zh-CN": "按名称、收藏和修改时间整理画布", "en-US": "Organize canvases by name, favorites, and modification time" },
  "kind.image": { "zh-CN": "图片", "en-US": "Images" },
  "kind.video": { "zh-CN": "视频", "en-US": "Videos" },
  "kind.audio": { "zh-CN": "音频", "en-US": "Audio" },
  "kind.document": { "zh-CN": "文档", "en-US": "Documents" },
  "kind.other": { "zh-CN": "其他", "en-US": "Other" },
  "error.read": { "zh-CN": "智能文件夹读取失败", "en-US": "Could not read Smart Folders" },
  "dialog.kicker": { "zh-CN": "智能文件夹", "en-US": "Smart Folder" },
  "delete.title": { "zh-CN": "删除“{name}”？", "en-US": "Delete “{name}”?" },
  "delete.close": { "zh-CN": "关闭删除对话框", "en-US": "Close delete dialog" },
  "delete.copy": { "zh-CN": "只会删除这组动态规则，不会移动或删除任何原内容。", "en-US": "Only this dynamic rule set is deleted; original content is not moved or deleted." },
  "action.cancel": { "zh-CN": "取消", "en-US": "Cancel" },
  "action.deleting": { "zh-CN": "删除中", "en-US": "Deleting" },
  "action.delete": { "zh-CN": "删除", "en-US": "Delete" },
  "header.title": { "zh-CN": "智能文件夹", "en-US": "Smart Folders" },
  "header.subtitle": { "zh-CN": "保存筛选规则，让素材、知识与画布始终按真实状态自动归位。", "en-US": "Save filters so materials, knowledge, and canvases always organize themselves from current data." },
  "action.create": { "zh-CN": "新建智能文件夹", "en-US": "New Smart Folder" },
  "tabs.aria": { "zh-CN": "智能文件夹内容", "en-US": "Smart Folder content" },
  "tab.quick": { "zh-CN": "快捷视图", "en-US": "Quick Views" },
  "tab.autoImport": { "zh-CN": "自动导入", "en-US": "Auto Import" },
  "quick.description": { "zh-CN": "无需配置，始终使用当前来源数据。", "en-US": "No setup required; always uses current source data." },
  "custom.title": { "zh-CN": "我的智能文件夹", "en-US": "My Smart Folders" },
  "custom.description": { "zh-CN": "每个文件夹只管理一种来源，规则清晰可控。", "en-US": "Each folder manages one source with clear, controllable rules." },
  "custom.count": { "zh-CN": "{count} 个", "en-US": "{count}" },
  "custom.empty": { "zh-CN": "还没有自定义智能文件夹", "en-US": "No custom Smart Folders yet" },
  "custom.emptyCopy": { "zh-CN": "可以在素材库、知识库或画布中保存当前筛选，也可以从这里开始。", "en-US": "Save the current filter from Materials, Knowledge, or Canvas, or start here." },
  "custom.first": { "zh-CN": "创建第一组规则", "en-US": "Create your first rule" },
  "card.quick": { "zh-CN": "快捷视图", "en-US": "Quick View" },
  "builtin.recentMaterials.name": { "zh-CN": "最近添加素材", "en-US": "Recently Added Materials" },
  "builtin.recentMaterials.description": { "zh-CN": "按添加时间查看最新素材", "en-US": "See the newest materials by date added" },
  "builtin.modifiedNotes.name": { "zh-CN": "最近修改笔记", "en-US": "Recently Modified Notes" },
  "builtin.modifiedNotes.description": { "zh-CN": "继续最近整理的知识内容", "en-US": "Continue with recently organized knowledge" },
  "builtin.editedCanvases.name": { "zh-CN": "最近编辑画布", "en-US": "Recently Edited Canvases" },
  "builtin.editedCanvases.description": { "zh-CN": "回到最近编辑的画布", "en-US": "Return to recently edited canvases" },
  "builtin.untaggedMaterials.name": { "zh-CN": "无标签素材", "en-US": "Untagged Materials" },
  "builtin.untaggedMaterials.description": { "zh-CN": "发现还没有整理标签的素材", "en-US": "Find materials that still need tags" },
  "builtin.untaggedNotes.name": { "zh-CN": "无标签笔记", "en-US": "Untagged Notes" },
  "builtin.untaggedNotes.description": { "zh-CN": "发现还没有整理标签的笔记", "en-US": "Find notes that still need tags" },
  "error.results": { "zh-CN": "结果刷新失败", "en-US": "Could not refresh results" },
  "action.back": { "zh-CN": "返回", "en-US": "Back" },
  "action.edit": { "zh-CN": "编辑规则", "en-US": "Edit rules" },
  "detail.search": { "zh-CN": "在{source}结果中搜索", "en-US": "Search {source} results" },
  "sort.label": { "zh-CN": "排序", "en-US": "Sort" },
  "result.count.one": { "zh-CN": "{count} 项", "en-US": "{count} item" }, "result.count.other": { "zh-CN": "{count} 项", "en-US": "{count} items" },
  "result.refreshing": { "zh-CN": "正在更新", "en-US": "Updating" },
  "result.error": { "zh-CN": "刷新失败，已保留上次结果。", "en-US": "Refresh failed; previous results are preserved." },
  "result.empty": { "zh-CN": "当前没有匹配内容", "en-US": "No matching content" },
  "result.emptyCopy": { "zh-CN": "来源内容发生变化后，这里会按同一组规则重新计算。", "en-US": "Results recalculate with the same rules whenever source content changes." },
  "result.canvas": { "zh-CN": "画布", "en-US": "Canvas" },
  "result.material": { "zh-CN": "素材", "en-US": "Material" },
  "result.noSummary": { "zh-CN": "暂无摘要", "en-US": "No summary" },
  "error.tags": { "zh-CN": "标签暂时不可用", "en-US": "Tags are temporarily unavailable" },
  "editor.edit": { "zh-CN": "编辑智能文件夹", "en-US": "Edit Smart Folder" },
  "editor.create": { "zh-CN": "新建智能文件夹", "en-US": "New Smart Folder" },
  "editor.close": { "zh-CN": "关闭", "en-US": "Close" },
  "editor.source": { "zh-CN": "来源", "en-US": "Source" },
  "field.name": { "zh-CN": "名称", "en-US": "Name" },
  "field.namePlaceholder": { "zh-CN": "例如：本月收藏的灵感图", "en-US": "For example: Favorite inspiration this month" },
  "field.query": { "zh-CN": "包含文字", "en-US": "Contains text" },
  "field.queryPlaceholder": { "zh-CN": "标题、名称或摘要中的关键词", "en-US": "Keywords in the title, name, or summary" },
  "field.kinds": { "zh-CN": "素材类型", "en-US": "Material types" },
  "field.tags": { "zh-CN": "标签（任一匹配）", "en-US": "Tags (match any)" },
  "field.noTags": { "zh-CN": "暂无可选标签", "en-US": "No tags available" },
  "field.favorite": { "zh-CN": "收藏状态", "en-US": "Favorite status" },
  "field.any": { "zh-CN": "不限", "en-US": "Any" },
  "field.favorited": { "zh-CN": "已收藏", "en-US": "Favorited" },
  "field.notFavorited": { "zh-CN": "未收藏", "en-US": "Not favorited" },
  "field.added": { "zh-CN": "添加时间", "en-US": "Date added" },
  "field.modified": { "zh-CN": "修改时间", "en-US": "Date modified" },
  "field.from": { "zh-CN": "从", "en-US": "From" },
  "field.to": { "zh-CN": "至", "en-US": "To" },
  "action.saving": { "zh-CN": "保存中", "en-US": "Saving" },
  "action.save": { "zh-CN": "保存规则", "en-US": "Save rules" },
  "criteria.tags.one": { "zh-CN": "{count} 个标签任一匹配", "en-US": "Match {count} tag" }, "criteria.tags.other": { "zh-CN": "{count} 个标签任一匹配", "en-US": "Match any of {count} tags" },
  "criteria.modified": { "zh-CN": "修改时间", "en-US": "Modified date" },
  "criteria.added": { "zh-CN": "添加时间", "en-US": "Date added" },
  "criteria.all": { "zh-CN": "全部内容", "en-US": "All content" },
  "sort.addedDesc": { "zh-CN": "最近添加", "en-US": "Recently added" },
  "sort.modifiedDesc": { "zh-CN": "最近修改", "en-US": "Recently modified" },
  "sort.modifiedAsc": { "zh-CN": "最早修改", "en-US": "Oldest modified" },
  "sort.name": { "zh-CN": "按名称", "en-US": "By name" },
  "sort.custom": { "zh-CN": "自定义排序", "en-US": "Custom order" },
  "loading.aria": { "zh-CN": "正在加载智能文件夹", "en-US": "Loading Smart Folders" },
  "result.untitledMaterial": { "zh-CN": "未命名素材", "en-US": "Untitled material" },
  "result.untitledNote": { "zh-CN": "未命名笔记", "en-US": "Untitled note" },
  "result.untitledCanvas": { "zh-CN": "未命名画布", "en-US": "Untitled canvas" },
  "result.canvasNodes.one": { "zh-CN": "{count} 个节点", "en-US": "{count} node" },
  "result.canvasNodes.other": { "zh-CN": "{count} 个节点", "en-US": "{count} nodes" },
  "result.canvasEdges.one": { "zh-CN": "{count} 条连线", "en-US": "{count} connection" },
  "result.canvasEdges.other": { "zh-CN": "{count} 条连线", "en-US": "{count} connections" },
});

type SmartT = ReturnType<typeof useMessages<typeof COPY>>["t"];
type SmartPlural = ReturnType<typeof useMessages<typeof COPY>>["plural"];
const sourceLabel = (source: SmartFolderSource, t: SmartT) => t(`source.${source}` as "source.material" | "source.note" | "source.canvas");
const sourceDescription = (source: SmartFolderSource, t: SmartT) => t(source === "material" ? "source.materialDesc" : source === "note" ? "source.noteDesc" : "source.canvasDesc");
const kindLabel = (kind: string, t: SmartT) => {
  if (kind === "image" || kind === "video" || kind === "audio" || kind === "document" || kind === "other") return t(`kind.${kind}`);
  return kind;
};
const BUILT_IN_MESSAGE_KEYS = {
  "builtin:recent-materials": ["builtin.recentMaterials.name", "builtin.recentMaterials.description"],
  "builtin:modified-notes": ["builtin.modifiedNotes.name", "builtin.modifiedNotes.description"],
  "builtin:edited-canvases": ["builtin.editedCanvases.name", "builtin.editedCanvases.description"],
  "builtin:untagged-materials": ["builtin.untaggedMaterials.name", "builtin.untaggedMaterials.description"],
  "builtin:untagged-notes": ["builtin.untaggedNotes.name", "builtin.untaggedNotes.description"],
} as const;

function builtInCopy(definition: BuiltInSmartFolderDefinition, t: SmartT) {
  const keys = BUILT_IN_MESSAGE_KEYS[definition.id as keyof typeof BUILT_IN_MESSAGE_KEYS];
  return keys ? { name: t(keys[0]), description: t(keys[1]) } : { name: definition.name, description: definition.description };
}

type AnyDefinition = SmartFolderDefinition | BuiltInSmartFolderDefinition;
type TagOption = { id: string; name: string; color?: string | null };
type EditorState = { id: string | null; input: SmartFolderDefinitionInput };

const KIND_OPTIONS = ["image", "video", "audio", "document", "other"] as const;

export default function SmartFoldersPage(props: { hashPath?: string }) {
  const context = useSyncExternalStore(materialLibrarySession.subscribe, materialLibrarySession.getSnapshot);
  return <SmartFoldersContents key={`${context.libraryId}:${context.generation}`} {...props} />;
}
function SmartFoldersContents({ hashPath = "smart" }: { hashPath?: string }) {
  const { t } = useMessages(COPY);
  const [definitions, setDefinitions] = useState<SmartFolderDefinition[]>([]);
  const [loadingDefinitions, setLoadingDefinitions] = useState(true);
  const [definitionError, setDefinitionError] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SmartFolderDefinition | null>(null);
  const [saving, setSaving] = useState(false);
  const requestRef = useRef<Promise<SmartFolderDefinition[]> | null>(null);
  const closeDeleteDialog = useCallback(() => {
    if (!saving) setDeleteTarget(null);
  }, [saving]);
  const deleteDialogSurface = useApplicationModalSurface<HTMLDivElement>(Boolean(deleteTarget), closeDeleteDialog, {
    closeOnBackdrop: !saving,
    closeOnEscape: !saving,
  });

  const refreshDefinitions = useCallback(() => {
    if (requestRef.current) return requestRef.current;
    const request = listSmartFolders()
      .then((items) => {
        setDefinitions(items);
        setDefinitionError("");
        return items;
      })
      .catch((error) => {
        setDefinitionError(t("error.read"));
        throw error;
      })
      .finally(() => {
        if (requestRef.current === request) requestRef.current = null;
        setLoadingDefinitions(false);
      });
    requestRef.current = request;
    return request;
  }, [t]);

  useEffect(() => {
    void refreshDefinitions().catch(() => undefined);
    const refresh = () => void refreshDefinitions().catch(() => undefined);
    window.addEventListener(SMART_FOLDER_CHANGE_EVENT, refresh);
    return () => {
      window.removeEventListener(SMART_FOLDER_CHANGE_EVENT, refresh);
    };
  }, [refreshDefinitions]);

  useEffect(() => {
    const draft = readSmartFolderDraft();
    if (draft) setEditor({ id: null, input: draft });
  }, []);

  const selectedId = useMemo(() => {
    const segment = hashPath.split("/")[1];
    if (!segment) return "";
    try { return decodeURIComponent(segment); } catch { return ""; }
  }, [hashPath]);
  const allDefinitions = useMemo<AnyDefinition[]>(() => [...BUILT_IN_SMART_FOLDERS, ...definitions], [definitions]);
  const selected = allDefinitions.find((item) => item.id === selectedId) || null;

  const openCreate = useCallback((source: SmartFolderSource = "material") => {
    setEditor({
      id: null,
      input: {
        name: "",
        criteria: emptySmartFolderCriteria(source),
        sort: source === "material" ? "added-desc" : "modified-desc",
      },
    });
  }, []);

  const saveEditor = useCallback(async (input: SmartFolderDefinitionInput) => {
    if (!editor) return;
    setSaving(true);
    try {
      const saved = editor.id
        ? await updateSmartFolder(editor.id, input)
        : await createSmartFolder(input);
      setEditor(null);
      await refreshDefinitions();
      window.location.hash = `#smart/${encodeURIComponent(saved.id)}`;
    } finally {
      setSaving(false);
    }
  }, [editor, refreshDefinitions]);

  const removeDefinition = useCallback(async () => {
    if (!deleteTarget) return;
    setSaving(true);
    try {
      await deleteSmartFolder(deleteTarget.id);
      setDeleteTarget(null);
      await refreshDefinitions();
      window.location.hash = "#smart";
    } finally {
      setSaving(false);
    }
  }, [deleteTarget, refreshDefinitions]);

  return (
    <main className="smart-folders-page editorial-page-surface">
      {!selected ? (
        <SmartFolderOverview
          definitions={definitions}
          loading={loadingDefinitions}
          error={definitionError}
          onCreate={() => openCreate("material")}
        />
      ) : (
        <SmartFolderDetail
          definition={selected}
          onBack={() => { window.location.hash = "#smart"; }}
          onEdit={"builtIn" in selected ? undefined : () => setEditor({
            id: selected.id,
            input: { name: selected.name, criteria: selected.criteria, sort: selected.sort },
          })}
          onDelete={"builtIn" in selected ? undefined : () => setDeleteTarget(selected)}
        />
      )}
      {editor ? (
        <SmartFolderEditor
          state={editor}
          saving={saving}
          onChange={setEditor}
          onCancel={() => {
            setEditor(null);
            if (window.location.hash.includes("?draft=")) window.location.hash = "#smart";
          }}
          onSave={saveEditor}
        />
      ) : null}
      {deleteTarget ? (
        <div className="smart-dialog-backdrop editorial-dialog-backdrop experience-dialog-backdrop" onPointerDown={deleteDialogSurface.onBackdropPointerDown}>
          <div ref={deleteDialogSurface.surfaceRef} className="smart-dialog compact editorial-dialog experience-dialog" role="alertdialog" aria-modal="true" aria-labelledby="smart-delete-title" aria-describedby="smart-delete-copy" tabIndex={-1} onKeyDown={deleteDialogSurface.onSurfaceKeyDown} onPointerDown={(event) => event.stopPropagation()}>
            <header className="smart-dialog-header editorial-dialog-head">
              <div className="editorial-dialog-header-row">
                <span className="smart-dialog-header-icon editorial-dialog-header-icon" aria-hidden="true" />
                <div className="editorial-dialog-heading">
                  <h2 id="smart-delete-title">{t("delete.title", { name: deleteTarget.name })}</h2>
                </div>
                <button type="button" className="smart-dialog-close editorial-dialog-close" aria-label={t("delete.close")} title={t("delete.close")} onClick={() => setDeleteTarget(null)} disabled={saving}><span className="editorial-dialog-close-icon" aria-hidden="true" /></button>
              </div>
            </header>
            <div className="smart-dialog-body editorial-dialog-body"><p id="smart-delete-copy">{t("delete.copy")}</p></div>
            <div className="smart-dialog-actions editorial-dialog-footer">
              <button type="button" data-modal-initial-focus onClick={() => setDeleteTarget(null)} disabled={saving}>{t("action.cancel")}</button>
              <button type="button" className="danger" onClick={() => void removeDefinition()} disabled={saving}>{saving ? t("action.deleting") : t("action.delete")}</button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function SmartFolderOverview({
  definitions,
  loading,
  error,
  onCreate,
}: {
  definitions: SmartFolderDefinition[];
  loading: boolean;
  error: string;
  onCreate: () => void;
}) {
  const { t } = useMessages(COPY);
  const [activeOverviewTab, setActiveOverviewTab] = useState<"quick" | "auto-import">("quick");
  const grouped = useMemo(() => Object.fromEntries(
    (["material", "note", "canvas"] as SmartFolderSource[]).map((source) => [source, definitions.filter((item) => item.source === source)]),
  ) as Record<SmartFolderSource, SmartFolderDefinition[]>, [definitions]);
  return (
    <div className="smart-overview">
      <header className="smart-hero editorial-page-heading">
        <div>
          <h1>{t("header.title")}</h1>
          <p>{t("header.subtitle")}</p>
        </div>
        <div className="smart-overview-actions"><button type="button" className="smart-primary-action editorial-primary-action" onClick={onCreate}>{t("action.create")}</button></div>
      </header>

      <div className="smart-overview-tabs" role="tablist" aria-label={t("tabs.aria")}>
        <button type="button" role="tab" aria-selected={activeOverviewTab === "quick"} aria-controls="smart-quick-views" className={activeOverviewTab === "quick" ? "active" : ""} onClick={() => setActiveOverviewTab("quick")}>{t("tab.quick")}</button>
        <button type="button" role="tab" aria-selected={activeOverviewTab === "auto-import"} aria-controls="smart-auto-import-panel" className={activeOverviewTab === "auto-import" ? "active" : ""} onClick={() => setActiveOverviewTab("auto-import")}>{t("tab.autoImport")}</button>
      </div>

      {activeOverviewTab === "quick" ? (
        <div id="smart-quick-views" role="tabpanel">
          <section className="smart-section" aria-labelledby="smart-built-in-title">
            <div className="smart-section-heading">
              <div><h2 id="smart-built-in-title">{t("tab.quick")}</h2><p>{t("quick.description")}</p></div>
            </div>
            <div className="smart-card-grid built-in">
              <button type="button" className="smart-definition-card source-material" onClick={openMaterialAppearanceFromNavigation}>
                <span className="smart-card-source">素材快捷入口</span><strong>以图搜图</strong>
                <p>拖入或选择图片，在素材库查找相似外观。</p><span className="smart-card-foot"><span>打开素材库搜图</span><span aria-hidden="true">↗</span></span>
              </button>
              {BUILT_IN_SMART_FOLDERS.map((item) => <DefinitionCard key={item.id} definition={item} />)}
            </div>
          </section>

          <section className="smart-section" aria-labelledby="smart-custom-title">
            <div className="smart-section-heading">
              <div><h2 id="smart-custom-title">{t("custom.title")}</h2><p>{t("custom.description")}</p></div>
              <span>{t("custom.count", { count: definitions.length })}</span>
            </div>
            {error ? <div className="smart-inline-error experience-error" role="status">{error}</div> : null}
            {loading && definitions.length === 0 ? <SmartFolderSkeleton /> : null}
            {!loading && definitions.length === 0 ? (
              <div className="smart-empty-overview experience-empty"><h3>{t("custom.empty")}</h3><p>{t("custom.emptyCopy")}</p><button type="button" onClick={onCreate}>{t("custom.first")}</button></div>
            ) : null}
            {(["material", "note", "canvas"] as SmartFolderSource[]).map((source) => grouped[source].length ? (
              <div className="smart-source-group" key={source}>
                <h3>{sourceLabel(source, t)}</h3>
                <div className="smart-card-grid">
                  {grouped[source].map((item) => <DefinitionCard key={item.id} definition={item} />)}
                </div>
              </div>
            ) : null)}
          </section>
        </div>
      ) : (
        <div id="smart-auto-import-panel" role="tabpanel"><AutoImportManager mode="inline" /></div>
      )}
    </div>
  );
}

function DefinitionCard({ definition }: { definition: AnyDefinition }) {
  const { plural, t } = useMessages(COPY);
  const copy = "builtIn" in definition ? builtInCopy(definition, t) : null;
  return (
    <button type="button" className={`smart-definition-card source-${definition.source}`} onClick={() => { window.location.hash = `#smart/${encodeURIComponent(definition.id)}`; }}>
      <span className="smart-card-source">{sourceLabel(definition.source, t)}</span>
      <strong>{copy?.name || definition.name}</strong>
      <p>{copy?.description || criteriaChips(definition.criteria, t, plural).join(" · ")}</p>
      <span className="smart-card-foot"><span>{"builtIn" in definition ? t("card.quick") : summarizeSort(definition.sort, t)}</span><span aria-hidden="true">↗</span></span>
    </button>
  );
}

function SmartFolderDetail({
  definition,
  onBack,
  onEdit,
  onDelete,
}: {
  definition: AnyDefinition;
  onBack: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const { locale, plural, t } = useMessages(COPY);
  const [items, setItems] = useState<SmartFolderResultEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SmartFolderSort>(definition.sort);
  const previousResultRef = useRef<{ id: string; source: SmartFolderSource } | null>(null);
  const previousDefinitionRef = useRef<{ id: string; source: SmartFolderSource; sort: SmartFolderSort } | null>(null);
  const signature = JSON.stringify([definition.id, definition.updatedAt, definition.criteria, definition.sort]);

  useEffect(() => {
    let effectActive = true;
    const sameResultSource = canRetainSmartFolderStale(previousResultRef.current, definition);
    previousResultRef.current = { id: definition.id, source: definition.source };
    const previousDefinition = previousDefinitionRef.current;
    previousDefinitionRef.current = { id: definition.id, source: definition.source, sort: definition.sort };
    if (!sameResultSource) {
      setItems([]);
      setQuery("");
    }
    setSort((current) => reconcileSmartFolderDetailSort(previousDefinition, definition, current));
    setLoading(!sameResultSource);
    setRefreshing(sameResultSource);
    setError("");
    const loader = createLatestSmartFolderResultLoader(
      () => readSmartFolderResults(definition, {
        untitledMaterial: t("result.untitledMaterial"),
        untitledNote: t("result.untitledNote"),
        untitledCanvas: t("result.untitledCanvas"),
        canvasSummary: (nodes, edges) => [
          plural(nodes, { one: "result.canvasNodes.one", other: "result.canvasNodes.other" }),
          plural(edges, { one: "result.canvasEdges.one", other: "result.canvasEdges.other" }),
        ].join(" · "),
      }),
      (next) => setItems(next),
    );
    loader.activate(definition.id);
    const refresh = (invalidate = false) => {
      setRefreshing(true);
      void loader.refresh(definition.id, { invalidate }).catch(() => {
        if (!effectActive) return;
        setError(t("error.results"));
      }).finally(() => {
        if (!effectActive) return;
        setLoading(false);
        setRefreshing(false);
      });
    };
    refresh();
    let releaseSource: () => void = () => undefined;
    if (definition.source === "material") {
      let version = materialStore.getSnapshot().version;
      const releaseProtocol = materialStore.retainChangeProtocol();
      const unsubscribe = materialStore.subscribe(() => {
        const nextVersion = materialStore.getSnapshot().version;
        if (nextVersion === version) return;
        version = nextVersion;
        refresh(true);
      });
      releaseSource = () => { unsubscribe(); releaseProtocol(); };
    } else if (definition.source === "note") {
      let version = knowledgeStore.getSnapshot().version;
      const unsubscribe = knowledgeStore.subscribe(() => {
        const nextVersion = knowledgeStore.getSnapshot().version;
        if (nextVersion === version) return;
        version = nextVersion;
        refresh(true);
      });
      releaseSource = unsubscribe;
    }
    const onFavorite = (event: Event) => {
      const itemType = (event as CustomEvent<{ itemType?: string }>).detail?.itemType;
      if (itemType === definition.source) refresh(true);
    };
    window.addEventListener(FAVORITE_CHANGE_EVENT, onFavorite);
    return () => {
      effectActive = false;
      loader.deactivate();
      releaseSource();
      window.removeEventListener(FAVORITE_CHANGE_EVENT, onFavorite);
    };
  }, [definition, definition.id, definition.source, plural, signature, t]);

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const filtered = normalized ? items.filter((item) => `${item.name} ${item.summary}`.toLocaleLowerCase().includes(normalized)) : items;
    return sortSmartFolderResultEntries(filtered, sort);
  }, [items, query, sort]);

  return (
    <div className="smart-detail">
      <header className="smart-detail-header">
        <button type="button" className="smart-back editorial-back-action" onClick={onBack} aria-label={t("action.back")}><span className="smart-back-icon editorial-back-icon" aria-hidden="true" /><span>{t("action.back")}</span></button>
        <div className="smart-detail-title-row">
          <div className="smart-detail-title-copy"><span className="smart-kicker">{sourceLabel(definition.source, t)} · DYNAMIC VIEW</span><h1>{"builtIn" in definition ? builtInCopy(definition, t).name : definition.name}</h1><div className="smart-rule-chips"><span>{sourceLabel(definition.source, t)}</span>{criteriaChips(definition.criteria, t, plural).map((chip) => <span key={chip}>{chip}</span>)}</div></div>
          {onEdit || onDelete ? <div className="smart-detail-actions">{onEdit ? <button type="button" onClick={onEdit}>{t("action.edit")}</button> : null}{onDelete ? <button type="button" className="danger" onClick={onDelete}>{t("action.delete")}</button> : null}</div> : null}
        </div>
      </header>
      <div className="smart-result-toolbar">
        <label className="smart-search"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("detail.search", { source: sourceLabel(definition.source, t) })} /></label>
        <label className="smart-sort"><span>{t("sort.label")}</span><select value={sort} onChange={(event) => setSort(event.target.value as SmartFolderSort)}>{sortOptions(definition.source, t).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <span className="smart-result-count">{plural(visibleItems.length, { one: "result.count.one", other: "result.count.other" })}</span>
      </div>
      <section className={`smart-results source-${definition.source}`} aria-busy={loading || refreshing}>
        {refreshing && items.length ? <span className="smart-refresh-state">{t("result.refreshing")}</span> : null}
        {error ? <div className="smart-inline-error experience-error" role="status">{t("result.error")}</div> : null}
        {loading && items.length === 0 ? <SmartFolderSkeleton /> : null}
        {!loading && visibleItems.length === 0 ? <div className="smart-results-empty experience-empty"><h2>{t("result.empty")}</h2><p>{t("result.emptyCopy")}</p></div> : null}
        <div className="smart-result-grid">{visibleItems.map((item) => <ResultCard key={item.id} item={item} locale={locale} />)}</div>
      </section>
    </div>
  );
}

function ResultCard({ item, locale }: { item: SmartFolderResultEntry; locale: Locale }) {
  const { t } = useMessages(COPY);
  const open = () => {
    if (item.source === "material") {
      focusEntity("asset", item.id, { action: "detail", source: "smart-folder" });
      window.location.hash = "#materials";
    } else if (item.source === "note") {
      focusNote(item.id);
    } else {
      openCanvasById(item.id);
    }
  };
  return (
    <button type="button" className={`smart-result-card source-${item.source}`} onClick={open}>
      {item.source !== "note" ? <span className="smart-result-preview">{item.previewUrl ? <img src={item.previewUrl} alt="" /> : <span>{item.source === "canvas" ? t("result.canvas") : item.kind || t("result.material")}</span>}</span> : null}
      <span className="smart-result-copy"><strong>{item.name}</strong><small>{item.summary || t("result.noSummary")}</small>{item.tags.length ? <span className="smart-result-tags">{item.tags.slice(0, 3).map((tag) => <em key={tag}>{tag}</em>)}{item.tags.length > 3 ? <em>+{item.tags.length - 3}</em> : null}</span> : null}<time>{formatDate(item.updatedAt || item.addedAt, locale)}</time></span>
    </button>
  );
}

function SmartFolderEditor({
  state,
  saving,
  onChange,
  onCancel,
  onSave,
}: {
  state: EditorState;
  saving: boolean;
  onChange: (state: EditorState) => void;
  onCancel: () => void;
  onSave: (input: SmartFolderDefinitionInput) => Promise<void>;
}) {
  const { locale, t } = useMessages(COPY);
  const [tagOptions, setTagOptions] = useState<TagOption[]>([]);
  const [tagError, setTagError] = useState("");
  const input = state.input;
  const criteria = input.criteria;
  useEffect(() => {
    let active = true;
    setTagOptions([]);
    setTagError("");
    if (criteria.source === "canvas") return () => { active = false; };
    const read = criteria.source === "material"
      ? listTags().then((tags) => tags.map(tagOption))
      : knowledgeStore.ensureSnapshot({ reason: "smart-folder-editor-tags" }).then((snapshot) => {
        if (!snapshot.vault || !snapshot.markdownIndex) return [];
        const names = new Set(snapshot.markdownIndex.documents.flatMap((document) => document.tags));
        return [...names].sort((a, b) => a.localeCompare(b, locale)).flatMap((name) => {
          try { return [{ id: knowledgeTagIdentity(snapshot.vault!.id, name), name }]; } catch { return []; }
        });
      });
    void read.then((options) => { if (active) setTagOptions(options); }).catch(() => { if (active) setTagError(t("error.tags")); });
    return () => { active = false; };
  }, [criteria.source, locale, t]);

  const setInput = (patch: Partial<SmartFolderDefinitionInput>) => onChange({ ...state, input: { ...input, ...patch } });
  const setCriteria = (next: SmartFolderCriteria) => setInput({ criteria: next });
  const changeSource = (source: SmartFolderSource) => setInput({
    criteria: emptySmartFolderCriteria(source),
    sort: source === "material" ? "added-desc" : "modified-desc",
  });
  const tagIds = criteria.source === "canvas" ? [] : criteria.tagIds;
  const setTagIds = (next: string[]) => {
    if (criteria.source === "canvas") return;
    setCriteria({ ...criteria, tagIds: next });
  };
  const valid = input.name.trim().length > 0;
  const dialogSurface = useApplicationModalSurface<HTMLFormElement>(true, onCancel, {
    closeOnBackdrop: !saving,
    closeOnEscape: !saving,
  });

  return (
    <div className="smart-dialog-backdrop editorial-dialog-backdrop experience-dialog-backdrop" onPointerDown={dialogSurface.onBackdropPointerDown}>
      <form ref={dialogSurface.surfaceRef} className="smart-dialog editor editorial-dialog experience-dialog" role="dialog" aria-modal="true" aria-labelledby="smart-editor-title" tabIndex={-1} onKeyDown={dialogSurface.onSurfaceKeyDown} onPointerDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); if (valid) void onSave({ ...input, name: input.name.trim() }); }}>
        <header className="smart-dialog-header editorial-dialog-head">
          <div className="editorial-dialog-header-row">
            <span className="smart-dialog-header-icon editorial-dialog-header-icon" aria-hidden="true" />
            <div className="editorial-dialog-heading">
              <h2 id="smart-editor-title">{state.id ? t("editor.edit") : t("editor.create")}</h2>
            </div>
            <button type="button" className="smart-dialog-close editorial-dialog-close" aria-label={t("editor.close")} title={t("editor.close")} onClick={onCancel} disabled={saving}><span className="editorial-dialog-close-icon" aria-hidden="true" /></button>
          </div>
          <fieldset className="smart-source-picker"><legend>{t("editor.source")}</legend>{(["material", "note", "canvas"] as SmartFolderSource[]).map((source) => <button type="button" key={source} className={criteria.source === source ? "active" : ""} aria-pressed={criteria.source === source} onClick={() => changeSource(source)}><strong>{sourceLabel(source, t)}</strong><small>{sourceDescription(source, t)}</small></button>)}</fieldset>
        </header>
        <div className="smart-editor-body editorial-dialog-body">
          <label className="smart-field"><span>{t("field.name")}</span><input data-modal-initial-focus value={input.name} maxLength={80} onChange={(event) => setInput({ name: event.target.value })} placeholder={t("field.namePlaceholder")} /></label>
          <label className="smart-field"><span>{t("field.query")}</span><input value={criteria.query} maxLength={240} onChange={(event) => setCriteria({ ...criteria, query: event.target.value })} placeholder={t("field.queryPlaceholder")} /></label>
          {criteria.source === "material" ? <fieldset className="smart-option-group"><legend>{t("field.kinds")}</legend><div className="smart-choice-grid">{KIND_OPTIONS.map((value) => <label key={value}><input type="checkbox" checked={criteria.kinds.includes(value)} onChange={() => setCriteria({ ...criteria, kinds: criteria.kinds.includes(value) ? criteria.kinds.filter((kind) => kind !== value) : [...criteria.kinds, value] })} /><span>{t(`kind.${value}`)}</span></label>)}</div></fieldset> : null}
          {criteria.source !== "canvas" ? <fieldset className="smart-option-group"><legend>{t("field.tags")}</legend>{tagError ? <small className="smart-field-error">{tagError}</small> : null}<div className="smart-tag-options">{tagOptions.map((tag) => <label key={tag.id}><input type="checkbox" checked={tagIds.includes(tag.id)} onChange={() => setTagIds(tagIds.includes(tag.id) ? tagIds.filter((id) => id !== tag.id) : [...tagIds, tag.id])} /><span style={tag.color ? { "--smart-tag-color": tag.color } as React.CSSProperties : undefined}>{tag.name}</span></label>)}{!tagOptions.length && !tagError ? <small>{t("field.noTags")}</small> : null}</div></fieldset> : null}
          <div className="smart-field-row">
            <label className="smart-field"><span>{t("field.favorite")}</span><select value={criteria.favorite === null ? "any" : criteria.favorite ? "yes" : "no"} onChange={(event) => setCriteria({ ...criteria, favorite: event.target.value === "any" ? null : event.target.value === "yes" })}><option value="any">{t("field.any")}</option><option value="yes">{t("field.favorited")}</option><option value="no">{t("field.notFavorited")}</option></select></label>
            <label className="smart-field"><span>{t("sort.label")}</span><select value={input.sort} onChange={(event) => setInput({ sort: event.target.value as SmartFolderSort })}>{sortOptions(criteria.source, t).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          </div>
          {criteria.source === "material" ? <TimeWindow label={t("field.added")} value={criteria.added} onChange={(added) => setCriteria({ ...criteria, added })} /> : null}
          <TimeWindow label={t("field.modified")} value={criteria.modified} onChange={(modified) => setCriteria({ ...criteria, modified })} />
        </div>
        <div className="smart-dialog-actions smart-editor-actions editorial-dialog-footer"><button type="button" onClick={onCancel} disabled={saving}>{t("action.cancel")}</button><button type="submit" className="primary" disabled={!valid || saving}>{saving ? t("action.saving") : state.id ? t("action.save") : t("action.create")}</button></div>
      </form>
    </div>
  );
}

function TimeWindow({ label, value, onChange }: { label: string; value: { after: string | null; before: string | null }; onChange: (value: { after: string | null; before: string | null }) => void }) {
  const { t } = useMessages(COPY);
  return <fieldset className="smart-option-group"><legend>{label}</legend><div className="smart-date-row"><label><span>{t("field.from")}</span><input type="date" value={dateInput(value.after)} onChange={(event) => onChange({ ...value, after: dateIso(event.target.value, false) })} /></label><label><span>{t("field.to")}</span><input type="date" value={dateInput(value.before)} onChange={(event) => onChange({ ...value, before: dateIso(event.target.value, true) })} /></label></div></fieldset>;
}

function criteriaChips(criteria: SmartFolderCriteria, t: SmartT, plural: SmartPlural) {
  const chips: string[] = [];
  if (criteria.query.trim()) chips.push(`“${criteria.query.trim()}”`);
  if (criteria.source === "material" && criteria.kinds.length) chips.push(...criteria.kinds.map((kind) => kindLabel(kind, t)));
  if (criteria.source !== "canvas" && criteria.tagIds.length) chips.push(plural(criteria.tagIds.length, { one: "criteria.tags.one", other: "criteria.tags.other" }));
  if (criteria.favorite !== null) chips.push(criteria.favorite ? t("field.favorited") : t("field.notFavorited"));
  if (criteria.modified.after || criteria.modified.before) chips.push(t("criteria.modified"));
  if (criteria.source === "material" && (criteria.added.after || criteria.added.before)) chips.push(t("criteria.added"));
  return chips.length ? chips : [t("criteria.all")];
}

function sortOptions(source: SmartFolderSource, t: SmartT): Array<[SmartFolderSort, string]> {
  return [
    ...(source === "material" ? [["added-desc", t("sort.addedDesc")]] as Array<[SmartFolderSort, string]> : []),
    ["modified-desc", t("sort.modifiedDesc")], ["modified-asc", t("sort.modifiedAsc")], ["name-asc", t("sort.name")],
  ];
}
function summarizeSort(sort: SmartFolderSort, t: SmartT) { return sortOptions("material", t).find(([value]) => value === sort)?.[1] || t("sort.custom"); }
function tagOption(tag: TagRecord): TagOption { return { id: tag.id, name: tag.name, color: tag.color }; }
function dateInput(value: string | null) { return smartFolderLocalDateInput(value); }
function dateIso(value: string, end: boolean) { return smartFolderLocalDateIso(value, end); }
function formatDate(value: string | null, locale: Locale) { if (!value) return ""; const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }).format(date); }
function SmartFolderSkeleton() { const { t } = useMessages(COPY); return <div className="smart-skeleton experience-skeleton" role="status" aria-live="polite"><span className="smart-visually-hidden">{t("loading.aria")}</span><span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" /></div>; }
