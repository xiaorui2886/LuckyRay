// D81: 素材库 React 化主组件
// 文件夹树 + 瀑布流 + 素材卡片 + 详情面板 + 工具栏

import { forwardRef, useSyncExternalStore, useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { CSSProperties, DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent, ReactNode, UIEvent as ReactUIEvent } from "react";
import { useI18n, type Locale, type MessageKey } from "../../core/i18n/index";
import { ExperienceNotices, useExperienceNotices } from "../../components/ExperienceOverlay";
import { resolveScopedShortcut, matchesShortcut, isTextEntry } from "../../app/shortcuts";
import { clearCurrentAssetContext, publishCurrentAssetContext } from "../../core/services/context";
import { materialNavigationCoordinator } from "../../core/services/materialNavigationCoordinator";
import type { MaterialNavigationIntent } from "../../core/services/materialNavigationCoordinator";
import { MaterialLibrarySwitcher } from "./MaterialLibrarySwitcher";
import { MaterialFilmViewer } from "./MaterialFilmViewer";
import { createPortal } from "react-dom";
import { NativeVideoInline } from "./NativeVideoInline";
import {useWorkspaceTools,type ToolAdapter} from '../../workspace/toolRegistry';
import type {ToolKind} from '../../workspace/toolLayout';
import { cachedNativeVideoCover, retainNativeVideoCover } from "./nativeVideoCoverCache";
import { NativeVideoHover } from "./NativeVideoHover";
import type { NativeVideoMetadata } from "./nativeVideoPreview";
import { useMaterialViewerHost } from "./useMaterialViewerHost";
import { nativeVideoMetadata, nativeVideoThumbnail } from "./nativeVideoPreview";
import { MaterialLibraryTransferUI } from "./MaterialLibraryTransferUI";
import { requestMaterialLibraryCopy } from "../../core/services/materialLibraryTransfers";
import { materialLibrarySession, readMaterialLibraryPreference, writeMaterialLibraryPreference } from "../../core/services/materialLibraryContext";
import {MaterialViewProvider,useMaterialViewScope,useMaterialViewServices,type MaterialViewIdentity} from './MaterialViewContext';
import {materialStore as defaultMaterialStore} from '../../core/services/materialStore';
import { materialNativeDetailViews, sameMaterialDetailAsset, observeMaterialDetailPaint, type MaterialNativeDetailRequest, type MaterialNativeDetailAck } from "./materialNativeDetailRegistry";
import { MaterialAppearancePanel } from "./MaterialAppearancePanel";
import { createMaterialDragGesture } from "./materialDragGesture";
import { materialSmartQueryMatchesKind, sortMaterialMetadata } from "./materialSearch";
import { toMaterialCatalogError } from "../../core/services/materialCatalog";
import type { MaterialStoreQuery, MaterialStoreSnapshot } from "../../core/services/materialStore";
import { openInLightSeek, waitForOpenInLightSeekIntent } from "../../core/services/openInLightSeek";
import { openExternalUrl } from "../../core/services/system";
import {
  planMaterialCsvExport, discardMaterialCsvExportPlan, chooseMaterialCsvDestination,
  startMaterialCsvExport, getMaterialCsvExportTask, cancelMaterialCsvExport, retryMaterialCsvExport,
  materialSourceInfo,
  type MaterialSourcePage,
} from "../../core/services/materials";
import { smartFolderDraftHash } from "../../core/services/smartFolders";
import {
  beginMaterialExternalDrag,
  planMaterialExport,
  discardMaterialExportPlan,
  chooseMaterialExportDirectory,
  startMaterialExport,
  getMaterialExportTask,
  cancelMaterialExport,
  openMaterialExportDestination,
  getMaterialAssetPreviewUrl,
  importDroppedMaterialAssets,
  importMaterialAssets,
  importMaterialFolder,
  listMaterialLibraryTasks,
  insertMaterialAssetIntoCurrentKnowledge,
  performMaterialExternalAction,
  consumeActiveMaterialExternalDrag,
  peekActiveMaterialExternalDrag,
  resolveMaterialExternalDragSelection,
  resolveMaterialLightSeekAttachments,
  selectMaterialRelocationPath,
} from "../../core/services/materials";
import type { MaterialAsset, MaterialImportProgress, MaterialExportPlan, MaterialExportPlanRequest, MaterialExportTask, MaterialCsvExportPlan, MaterialCsvExportPlanRequest, MaterialCsvExportTask } from "../../core/services/materials";
import { MaterialExportUI } from "./MaterialExportUI";
import { MaterialCsvExportDialog } from "./MaterialCsvExportUI";
import {
  isMaterialExportRunning, isMaterialExportSummaryExpired, upsertMaterialExportTask,
  type MaterialExportNotice, type MaterialExportTaskProblem,
} from "./materialExportPresentation";
import { readMaterialWatchSources } from "./materialWatch";
import { readSavedSettings, writeSavedSettingsPatch } from "../settings/useSettings";
import { flattenFolders } from "../folders/useFolders";
import type { Folder } from "../folders/useFolders";
import {
  MATERIALS_FILTER_PANEL_ID,
  MATERIALS_MISSING_PANEL_ID,
  MATERIALS_SORT_OPTIONS,
  MATERIALS_TOOLBAR_COMMAND_EVENT,
  clearMaterialsToolbarFilters,
  countActiveStandardMaterialsFilters,
  normalizeStandardMaterialsFilters,
  publishMaterialsToolbarState,
  type MaterialsSortBy,
  type MaterialsToolbarCommand,
  type MaterialsToolbarState,
  type MaterialsViewMode,
} from "./materialsToolbarProtocol";
import {
  attachMaterialMissingScanTriggers,
  closeCurrentConfirmDialog,
  createMaterialMissingScanCoordinator,
  notifyMaterialMissingCount,
  replaceCurrentConfirmDialog,
  resolveMaterialPathAction,
  runMaterialRelocationWithConfirmation,
  type MaterialMissingItem,
  type MaterialMissingScanReason,
} from "./materialMissingRecovery";
import { resolveMaterialViewerBounds } from "./materialViewerGeometry";
import MaterialCompareModal, { type MaterialCompareSlotAsset } from "./MaterialCompareModal";
import {
  MATERIAL_WORK_VIEW_ORDER,
  loadMaterialWorkViewPreferences,
  recordMaterialWorkViewAdjustment,
  saveMaterialWorkViewPreferences,
  switchMaterialWorkViewPreset,
  type MaterialWorkViewPresetId,
  type MaterialWorkViewPreferences,
} from "./materialWorkViewPresets";
import { calculateContextMenuPosition } from "./materialContextMenuPlacement";
import {
  resolveContainedMaterialMediaRect,
  resolveMaterialMediaDimensions,
  resolveMaterialVideoPlaybackPath,
  resolveMaterialVideoSource,
  shouldDismissMaterialViewerFromBlank,
} from "./materialViewerInteraction";
import { createMaterialContextActionAuthority, resolveCurrentMaterialFolderReveal } from "./materialActionRegressions";
import type {
  MaterialMediaDimensions,
  MaterialMediaDimensionsSnapshot,
  MaterialVideoSourceSnapshot,
} from "./materialViewerInteraction";
import {
  createMaterialHueFilter,
  getMaterialColorFilterView,
  materialColorFilterSample,
  materialPaletteMatchesStandardColor,
  normalizeStandardMaterialColorFilter,
  type MaterialNeutralFilter,
  type StandardMaterialColorFilter,
} from "./materialColorSimilarity";
import "./materials.css";
import { useFavoriteItems } from "../favorites/useFavoriteItems";
import { FavoriteGlyph } from "../../components/FavoriteGlyph";
import { readActiveKnowledgeSource } from "../../core/services/knowledgeSource";
import { readKnownNotesVaults } from "../notes/knownVaults";
import { MaterialAttachmentSection } from "./MaterialAttachmentSection";

type Asset = MaterialAsset;

function assetToActiveAssetContext(asset: Asset) {
  return {
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    mimeType: asset.mimeType,
    libraryPath: asset.libraryPath,
    folderId: asset.folderId,
    description: asset.description,
    updatedAt: asset.updatedAt,
  };
}

type Tag = {
  id: string;
  name: string;
  color: string | null;
};


type ViewMode = MaterialsViewMode;
type MaterialViewerMode = "preview" | "detail";
type AssetStorageMode = "linked" | "managed" | "source";
type StorageFilter = "all" | AssetStorageMode;
type ImportProgressState = {
  current: number;
  total: number;
  label: string;
  indeterminate?: boolean;
  bytesRead?: number;
  bytesTotal?: number;
};
type ConfirmDialogAction = {
  label: string;
  kind?: "primary" | "danger";
  onClick: () => void | Promise<void>;
};
type ConfirmDialogState = {
  message: ReactNode;
  actions?: ConfirmDialogAction[];
  onConfirm?: () => void | Promise<void>;
  onCancel?: () => void;
};

type MaterialFilterState = {
  kinds: string[];
  tagIds: string[];
  recentOnly: boolean;
  storageMode: StorageFilter;
  folderId: string | null;
  color: StandardMaterialColorFilter | null;
  dateFrom: string;
  dateTo: string;
  ratingMin: number | null;
};

type MaterialsViewCache = {
  filter: MaterialFilterState;
  selectedFolderId: string | null;
  sortBy: string;
  viewMode: ViewMode;
  scrollTop: number;
};
type MaterialsT = ReturnType<typeof useI18n>["t"];

type ContextMenuState = {
  sessionId: number;
  assetId: string;
  asset: Asset;
  x: number;
  y: number;
  trigger: HTMLElement | null;
};

type ModalState =
  | { type: "move"; assetIds: string[] }
  | { type: "tags"; assetIds: string[] }
  | { type: "rename"; asset: Asset; name: string }
  | { type: "renameFile"; asset: Asset; fileName: string }
  | null;

const VIEW_STORAGE_KEY = "luckyray-materials-view-v1";
const FILTER_STORAGE_KEY = "luckyray-materials-filter-v1";
const COLOR_EXTRACT_STORAGE_PREFIX = "luckyray-material-colors-v2";
const ASSET_FOCUS_HIGHLIGHT_MS = 6000;
const ASSET_FOCUS_POSITION_TIMEOUT_MS = 6000;
const ASSET_FOCUS_TRANSACTION_TIMEOUT_MS = 8000;
const videoPreviewCache = new Map<string, Promise<string>>();
const resolvedVideoPreviewCache = new Map<string, { sourcePath: string; url: string; aspectRatio?: number }>();
const videoViewportListeners = new WeakMap<Element, (visible: boolean) => void>();
let videoViewportObserver: IntersectionObserver | null = null;
let videoViewportObserverTargets = 0;
const materialsViewCaches = new Map<string, MaterialsViewCache>();

function observeMaterialVideoViewport(element: Element, listener: (visible: boolean) => void) {
  if (typeof IntersectionObserver === "undefined") {
    listener(true);
    return () => {};
  }
  if (!videoViewportObserver) {
    videoViewportObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        videoViewportListeners.get(entry.target)?.(entry.isIntersecting);
      }
    }, { rootMargin: "240px 0px", threshold: 0.01 });
  }
  videoViewportListeners.set(element, listener);
  videoViewportObserver.observe(element);
  videoViewportObserverTargets += 1;
  return () => {
    videoViewportObserver?.unobserve(element);
    videoViewportListeners.delete(element);
    videoViewportObserverTargets = Math.max(0, videoViewportObserverTargets - 1);
    if (videoViewportObserverTargets === 0) {
      videoViewportObserver?.disconnect();
      videoViewportObserver = null;
    }
  };
}

function applyMaterialZoomToElement(zoom: number, target:HTMLElement = document.documentElement) {
  const clamped = Math.min(300, Math.max(60, Math.round(zoom)));
  const ratio = Math.min(1, Math.max(0, (clamped - 60) / (300 - 60)));
  const cols = Math.round(16 - ratio * (16 - 2));
  const listThumbSize = Math.round(48 + ratio * 56);
  target.style.setProperty("--materials-card-size", `${clamped}px`);
  target.style.setProperty("--materials-masonry-cols", String(cols));
  target.style.setProperty("--materials-list-thumb-size", `${listThumbSize}px`);
}

function loadFilterState(libraryId?:string|null): MaterialFilterState {
  try {
    const raw = readMaterialLibraryPreference(FILTER_STORAGE_KEY,libraryId);
    if (!raw) return createDefaultFilterState();
    const parsed = JSON.parse(raw);
    const storageMode = parsed.storageMode === "linked" || parsed.storageMode === "managed" || parsed.storageMode === "source" ? parsed.storageMode : "all";
    return {
      kinds: Array.isArray(parsed.kinds) ? parsed.kinds : [],
      tagIds: Array.isArray(parsed.tagIds) ? parsed.tagIds : [],
      recentOnly: Boolean(parsed.recentOnly),
      storageMode,
      folderId: typeof parsed.folderId === "string" && parsed.folderId ? parsed.folderId : null,
      color: normalizeStandardMaterialColorFilter(parsed.color),
      dateFrom: typeof parsed.dateFrom === "string" ? parsed.dateFrom : "",
      dateTo: typeof parsed.dateTo === "string" ? parsed.dateTo : "",
      ratingMin: typeof parsed.ratingMin === "number" && parsed.ratingMin > 0 ? parsed.ratingMin : null,
    };
  } catch { return createDefaultFilterState(); }
}

function createDefaultFilterState(): MaterialFilterState {
  return { kinds: [], tagIds: [], recentOnly: false, storageMode: "all", folderId: null, color: null, dateFrom: "", dateTo: "", ratingMin: null };
}

function readMaterialImportOptions(libraryId: string | null): { storageMode: AssetStorageMode; managedLibraryDir: string | null; libraryId: string | null } {
  const session = materialLibrarySession.getSnapshot();
  const library = session.registry?.libraries.find(item => item.id === libraryId);
  if (library && library.id !== session.registry?.legacyId) return { storageMode: library.storageMode, managedLibraryDir: null, libraryId };
  const settings = readSavedSettings();
  const modeValue = settings["materials.importMode"];
  const dirValue = settings["materials.managedLibraryDir"];
  const managedLibraryDir = typeof dirValue === "string" && dirValue.trim() ? dirValue.trim() : null;
  return {
    storageMode: modeValue === "managed" || modeValue === "source" ? modeValue : "linked",
    managedLibraryDir, libraryId,
  };
}

function getDroppedFilePath(file: File): string {
  const nativeFile = file as File & { path?: unknown; webkitRelativePath?: unknown; mozFullPath?: unknown };
  const candidates = [nativeFile.path, nativeFile.webkitRelativePath, nativeFile.mozFullPath];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const value = candidate.trim();
    if (isAbsoluteLocalPath(value)) return value;
  }
  return "";
}

function isAbsoluteLocalPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value) || value.startsWith("/");
}

function isTauriRuntime(): boolean {
  const global = window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return Boolean(global.__TAURI_INTERNALS__ || global.__TAURI__);
}

function isFolderTreeDragEvent(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i += 1) {
    if (types[i] === "text/luckyray-folder-id") return true;
  }
  return false;
}

async function splitDroppedPaths(paths: string[]): Promise<{ files: string[]; folders: string[] }> {
  if (!isTauriRuntime()) return { files: paths, folders: [] };
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const entries = await invoke<Array<{ path: string; is_file?: boolean; is_dir?: boolean }>>("classify_dropped_paths", { paths });
    return {
      files: entries.filter((entry) => entry.is_file === true).map((entry) => entry.path),
      folders: entries.filter((entry) => entry.is_dir === true).map((entry) => entry.path),
    };
  } catch {
    // Fall back for browser previews or stale dev shells that do not expose the Rust command yet.
  }
  try {
    const { lstat } = await import("@tauri-apps/plugin-fs");
    const entries = await Promise.all(paths.map(async (path) => {
      try {
        const info = await lstat(path);
        return { path, isDirectory: info.isDirectory === true };
      } catch {
        return { path, isDirectory: false };
      }
    }));
    return {
      files: entries.filter((entry) => !entry.isDirectory).map((entry) => entry.path),
      folders: entries.filter((entry) => entry.isDirectory).map((entry) => entry.path),
    };
  } catch {
    return { files: paths, folders: [] };
  }
}

function notifyMaterialFoldersChanged() {
  window.dispatchEvent(new CustomEvent("luckyray:folders-changed", { detail: { scope: "materials" } }));
}

function saveFilterState(state: MaterialFilterState,libraryId?:string|null) {
  try { writeMaterialLibraryPreference(FILTER_STORAGE_KEY, JSON.stringify(state),libraryId); } catch {}
}

function getColorExtractionSignature(asset: Asset): string {
  return [
    "v2-border-aware",
    asset.id,
    asset.libraryPath || asset.originalPath || "",
    asset.thumbnailUrl || "",
    asset.updatedAt || asset.importedAt || "",
  ].join("|");
}

function isMaterialColorExtractionFresh(asset: Asset): boolean {
  if (getMaterialPalette(asset.dominantColor).length === 0) return false;
  try {
    return localStorage.getItem(`${COLOR_EXTRACT_STORAGE_PREFIX}:${asset.id}`) === getColorExtractionSignature(asset);
  } catch {
    return false;
  }
}

function markMaterialColorExtractionFresh(asset: Asset) {
  try {
    localStorage.setItem(`${COLOR_EXTRACT_STORAGE_PREFIX}:${asset.id}`, getColorExtractionSignature(asset));
  } catch {}
}

function dateBoundaryIso(value: string, addDays = 0): string | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return undefined;
  date.setDate(date.getDate() + addDays);
  return date.toISOString();
}

function getFolderAndDescendantIdSet(folders: Folder[], folderId: string | null): Set<string> | null {
  if (!folderId) return null;
  const root = findFolderNode(folders, folderId);
  if (!root) return new Set([folderId]);
  const ids = new Set<string>();
  const walk = (folder: Folder) => {
    ids.add(folder.id);
    (folder.children || []).forEach(walk);
  };
  walk(root);
  return ids;
}

function findFolderNode(folders: Folder[], folderId: string): Folder | null {
  for (const folder of folders) {
    if (folder.id === folderId) return folder;
    const found = findFolderNode(folder.children || [], folderId);
    if (found) return found;
  }
  return null;
}

async function insertAssetIntoCurrentNote(asset: Asset, vaultId?: string): Promise<{ noteId: string; position?: string }> {
  return insertMaterialAssetIntoCurrentKnowledge(asset, {}, vaultId);
}

export default function MaterialsPage({ attachmentCollection = false, workspace }: { attachmentCollection?: boolean;workspace?:MaterialViewIdentity }) {
  const session = useSyncExternalStore(materialLibrarySession.subscribe, materialLibrarySession.getSnapshot);
  useEffect(() => {
    if (workspace || attachmentCollection || !isTauriRuntime()) return;
    const initialize = () => { void materialLibrarySession.initialize().catch(() => {}); };
    initialize();
    window.addEventListener("luckyray:bridge-ready", initialize);
    return () => window.removeEventListener("luckyray:bridge-ready", initialize);
  }, [attachmentCollection,workspace?.viewId]);
  if(workspace)return <MaterialViewProvider identity={workspace}><MaterialLibraryContents key={workspace.viewId}/></MaterialViewProvider>;
  if (attachmentCollection || !isTauriRuntime()) return <MaterialLibraryContents key={attachmentCollection ? `attachments:${session.generation}` : "browser"} attachmentCollection={attachmentCollection} />;
  const current = session.registry?.libraries.find(library => library.id === session.libraryId);
  return <div className="material-library-workspace">
    <MaterialLibrarySwitcher showControls={false} />
    <MaterialLibraryTransferUI showControls={false} />
    <div className="material-library-body">
      {session.status === "ready" && current?.state === "ready"
        ? <MaterialLibraryContents key={`${session.libraryId}:${session.generation}`} />
        : <div className="material-library-unavailable" role="status">
          {session.status === "switching" ? "正在切换素材库…" : session.status === "error" ? session.error : current ? "素材库位置不可用，请在管理中重新定位，或切换到其他库。" : "正在读取素材库…"}
          {session.status === "error" && <button type="button" onClick={() => { void materialLibrarySession.initialize().catch(() => {}); }}>重试</button>}
        </div>}
    </div>
  </div>;
}

function MaterialLibraryContents({ attachmentCollection = false }: { attachmentCollection?: boolean }) {
  const scope=useMaterialViewScope();const scopeRef=useRef(scope);scopeRef.current=scope;
  const materialStore=scope?.store??defaultMaterialStore;
  const {updateMaterialAsset,renameMaterialAsset,renameMaterialAssetFile,relocateMaterialAsset,deleteMaterialAsset,createMaterialTag,getMaterialAssetTagContext,applyMaterialAssetTags,moveMaterialAssetsToFolder,exportMaterialAssetFile,scanMissingMaterialAssets,removeMissingMaterialAssetRecord,importSelectedMaterialFolder}=useMaterialViewServices();
  const viewRoot=useRef<HTMLDivElement>(null);
  const applyMaterialZoom=useCallback((zoom:number)=>applyMaterialZoomToElement(zoom,scopeRef.current?viewRoot.current??undefined:undefined),[]);
  const acceptsCommand=useCallback((event?:Event)=>{
    const scope=scopeRef.current;if(!scope)return !(event as CustomEvent|undefined)?.detail?.workspaceViewId;
    const target=(event as CustomEvent|undefined)?.detail?.workspaceViewId;
    return scope.visible&&(target?target===scope.viewId:scope.focused);
  },[]);
  const acceptsDrop=useCallback((event:Event)=>!scopeRef.current||!!viewRoot.current?.contains(event.target as Node),[]);
  const libraryContext = useRef(scope?{libraryId:scope.libraryId,generation:0}:materialLibrarySession.capture()).current;
  const libraryId = libraryContext.libraryId;
  const cacheKey = scope?`workspace:${scope.viewId}`:attachmentCollection ? "note-attachments" : libraryId ?? "legacy";
  const readPreference = (key: string) => readMaterialLibraryPreference(key, attachmentCollection ? null : libraryId);
  const writePreference = (key: string, value: string) => writeMaterialLibraryPreference(key, value, attachmentCollection ? null : libraryId);

  const { plural, t } = useI18n();
  const [attachmentVaultId, setAttachmentVaultId] = useState(() => readActiveKnowledgeSource()?.vaultId || "");
  const [includeUnreferenced, setIncludeUnreferenced] = useState(false);
  const [attachmentSearch, setAttachmentSearch] = useState("");
  const [attachmentQueryText, setAttachmentQueryText] = useState("");
  const [materialSearch, setMaterialSearch] = useState("");
  const [materialSearchMode, setMaterialSearchMode] = useState<"materials" | "global">("materials");
  const [appearanceRequest, setAppearanceRequest] = useState<{ assetId?: string } | null>(() => window.location.hash.includes("appearance=1") ? {} : null);
  const [appearanceIds, setAppearanceIds] = useState<string[] | null>(null);
  useEffect(() => {
    const consume = () => {
      if (!window.location.hash.startsWith("#materials?appearance=1")) return;
      setAppearanceRequest({});
      window.history.replaceState(null, "", "#materials");
    };
    consume();
    window.addEventListener("hashchange", consume);
    return () => window.removeEventListener("hashchange", consume);
  }, []);
  const [materialQueryText, setMaterialQueryText] = useState("");
  useEffect(() => { const timer=window.setTimeout(()=>setMaterialQueryText(materialSearchMode === "materials" ? materialSearch.trim() : ""),180); return ()=>window.clearTimeout(timer); },[materialSearch, materialSearchMode]);
  useEffect(() => { const timer = window.setTimeout(() => setAttachmentQueryText(attachmentSearch.trim()), 250); return () => window.clearTimeout(timer); }, [attachmentSearch]);
  const knownAttachmentVaults = useMemo(() => readKnownNotesVaults(), [attachmentCollection]);
  const initialViewCacheRef = useRef<MaterialsViewCache | null>(materialsViewCaches.get(cacheKey) ?? null);
  const initialViewCache = initialViewCacheRef.current;
  const persistedFilter = useMemo(() => {
    const normalized = normalizeStandardMaterialsFilters(initialViewCache?.filter || loadFilterState(libraryId));
    return {
      ...normalized,
      color: normalizeStandardMaterialColorFilter(normalized.color),
    } satisfies MaterialFilterState;
  }, [initialViewCache]);
  const [materialSnapshot, setMaterialSnapshot] = useState<MaterialStoreSnapshot>(() => materialStore.getSnapshot());
  const assets = materialSnapshot.assets as Asset[];
  const allAssets = materialSnapshot.allAssets as Asset[];
  const folders = materialSnapshot.folders as Folder[];
  const loading = !materialSnapshot.loaded && materialSnapshot.status !== "error";
  const dataPending = loading || materialSnapshot.status === "refreshing";
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(() => initialViewCache?.selectedFolderId ?? persistedFilter.folderId);
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [workspaceInspectedAssetId,setWorkspaceInspectedAssetId]=useState<string|null>(null);
  const [sortBy, setSortBy] = useState<MaterialsSortBy>(() => {
    const cached = initialViewCache?.sortBy ?? readPreference("luckyray-materials-sort-v1");
    return cached === "newest" || cached === "random" ? cached : "recent";
  });
  useEffect(() => { writePreference("luckyray-materials-sort-v1", sortBy); }, [sortBy]);
  const [viewMode, setViewMode] = useState<ViewMode>(() => initialViewCache?.viewMode || loadViewMode(libraryId));
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [previewAsset, setPreviewAsset] = useState<Asset | null>(null);
  const [hoveredAssetId, setHoveredAssetId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  // MATERIAL-VIEW-COMPARE-R1: work view presets (presentation-only) and the
  // 2–4 image compare session. Compare uses Asset but only reads the
  // MaterialCompareSlotAsset fields.
  const [workViewPrefs, setWorkViewPrefs] = useState<MaterialWorkViewPreferences | null>(() => loadMaterialWorkViewPreferences(libraryId));
  const [compareSlotIds, setCompareSlotIds] = useState<string[] | null>(null);
  const compareReturnRef = useRef<
    | { kind: "batch" }
    | { kind: "detail"; assetId: string; trigger: HTMLElement | null }
    | { kind: "context"; trigger: HTMLElement | null }
    | null
  >(null);
  const [, setIsDraggingFile] = useState(false);
  const [modal, setModal] = useState<ModalState>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [tagSelection, setTagSelection] = useState<Set<string>>(() => new Set());
  const [newTagName, setNewTagName] = useState("");
  const { notices: ordinaryNotices, notify: setToast, dismiss: dismissOrdinaryNotice } = useExperienceNotices();
  const materialFavorites = useFavoriteItems("material",scope?.libraryId);
  const [importProgress, setImportProgress] = useState<ImportProgressState | null>(null);
  const [exportPlan, setExportPlan] = useState<MaterialExportPlan | null>(null);
  const [csvPlan, setCsvPlan] = useState<MaterialCsvExportPlan | null>(null);
  const [csvPlanning, setCsvPlanning] = useState(false);
  const [csvDescription, setCsvDescription] = useState(false);
  const [csvBusy, setCsvBusy] = useState<"idle" | "choosing" | "starting">("idle");
  const [csvError, setCsvError] = useState("");
  const [csvTasks, setCsvTasks] = useState<Record<string, MaterialCsvExportTask>>({});
  const [csvRetrying, setCsvRetrying] = useState<string | null>(null);
  const csvPlanNonceRef = useRef(0);
  const csvSubmissionRef = useRef<string | null>(null);
  const csvRetryGateRef = useRef(new Set<string>());
  const csvNotifiedRef = useRef(new Set<string>());
  const [exportPlanning, setExportPlanning] = useState(false);
  const [exportSubmissionPhase, setExportSubmissionPhase] = useState<"idle" | "choosing" | "starting">("idle");
  const exportSubmissionRef = useRef<string | null>(null);
  const [exportPreserveHierarchy, setExportPreserveHierarchy] = useState(true);
  const [exportError, setExportError] = useState("");
  const [exportTasks, setExportTasks] = useState<Record<string, MaterialExportTask>>({});
  useEffect(() => {
    if (!libraryId || attachmentCollection) return;
    let active = true;
    void listMaterialLibraryTasks(libraryId).then(tasks => {
      if (!active) return;
      setExportTasks(previous => ({ ...Object.fromEntries(tasks.exports.map(task => [task.taskId, task])), ...previous }));
      setCsvTasks(previous => ({ ...Object.fromEntries(tasks.csv.map(task => [task.taskId, task])), ...previous }));
    }).catch(error => { if (active) setExportError(toMaterialCatalogError(error).message); });
    return () => { active = false; };
  }, [libraryId, attachmentCollection]);
  const [exportTaskLabels, setExportTaskLabels] = useState<Record<string, string>>({});
  const [exportPanelOpen, setExportPanelOpen] = useState(false);
  const [exportNotices, setExportNotices] = useState<MaterialExportNotice[]>([]);
  const csvPlanningGateRef = useRef(false);
  const exportNoticeSerialRef = useRef(0);
  const exportNotifiedRef = useRef(new Set<string>());
  const [exportTaskProblems, setExportTaskProblems] = useState<Record<string, MaterialExportTaskProblem>>({});
  const [exportActionErrors, setExportActionErrors] = useState<Record<string, string>>({});
  // React state may not render between two clicks. Claim a failed task
  // synchronously before awaiting its new plan, then retain the parent ->
  // child fence so an old card cannot re-copy a child success.
  const exportRetryGateRef = useRef(new Map<string, string>());
  const [exportRetryState, setExportRetryState] = useState<Record<string, "inflight" | "continued">>({});
  const [exportRetryChildIds, setExportRetryChildIds] = useState<Record<string, string>>({});
  const [exportRetryErrors, setExportRetryErrors] = useState<Record<string, string>>({});
  const exportPlanNonceRef = useRef(0);
  const [showImportModePrompt, setShowImportModePrompt] = useState(false);
  const viewerMode: MaterialViewerMode | null = selectedAsset ? "detail" : previewAsset ? "preview" : null;
  const viewerAsset = selectedAsset ?? previewAsset;
  const viewerReturnFocusRef = useRef<HTMLElement | null>(null);
  const viewerWasOpenRef = useRef(false);
  const folderRevealNonceRef = useRef(0);
  const contextActionAuthorityRef = useRef(createMaterialContextActionAuthority());
  const askAiBusyRef = useRef(false);

  const closeContextMenu = useCallback((restoreFocus = true, expectedSessionId?: number) => {
    const sessionId = expectedSessionId ?? contextMenu?.sessionId;
    if (!sessionId || !contextActionAuthorityRef.current.isActive(sessionId)) return;
    if (restoreFocus && contextMenu?.trigger?.isConnected) {
      contextMenu.trigger.focus({ preventScroll: true });
    }
    contextActionAuthorityRef.current.retire(sessionId);
    setContextMenu(null);
  }, [contextMenu]);

  const rememberViewerTrigger = useCallback(() => {
    if (viewerWasOpenRef.current) return;
    const activeElement = document.activeElement;
    viewerReturnFocusRef.current = activeElement instanceof HTMLElement && activeElement !== document.body
      ? activeElement
      : null;
  }, []);

  const openDetailViewer = useCallback((asset: Asset) => {
    if(scopeRef.current)setWorkspaceInspectedAssetId(asset.id);
    window.dispatchEvent(new Event("luckyray:material-viewer-opening"));
    rememberViewerTrigger();
    setPreviewAsset(null);
    setSelectedAsset(asset);
  }, [rememberViewerTrigger]);

  const nativeDetailCurrentRef = useRef({ allAssets, viewerAsset, viewerMode, loaded: materialSnapshot.loaded });
  nativeDetailCurrentRef.current = { allAssets, viewerAsset, viewerMode, loaded: materialSnapshot.loaded };
  const [nativeDetailRequestId, setNativeDetailRequestId] = useState(0);
  const nativeDetailSequenceRef = useRef(0);
  const nativeDetailElementRef = useRef<HTMLElement | null>(null);
  const setNativeDetailElement = useCallback((element: HTMLElement | null) => { nativeDetailElementRef.current = element; }, []);
  const nativeDetailPendingRef = useRef<{ requestId: number; request: MaterialNativeDetailRequest; resolve: (value: MaterialNativeDetailAck) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null>(null);
  useLayoutEffect(() => {
    if (attachmentCollection || !libraryId) return;
    const viewId = scopeRef.current?.viewId || 'main-materials';
    const isCurrent = () => scopeRef.current ? scopeRef.current.libraryId === libraryId && scopeRef.current.visible
      : materialLibrarySession.isCurrent(libraryContext) && materialLibrarySession.getSnapshot().status === 'ready';
    const binding = () => {
      if (!isCurrent()) throw Error('workspace-graph-material-source-changed');
      return { viewId, libraryId, generation: libraryContext.generation, ready: nativeDetailCurrentRef.current.loaded };
    };
    const release = materialNativeDetailViews.register(viewId, {
      binding,
      openDetail: request => {
        const bound = binding(), current = nativeDetailCurrentRef.current;
        if (!bound.ready || request.libraryId !== libraryId || !request.assetRevision || nativeDetailPendingRef.current) return Promise.reject(Error('workspace-graph-material-detail-unavailable'));
        const asset = current.allAssets.find(item => item.id === request.asset.id);
        if (!asset || !sameMaterialDetailAsset(asset, request.asset)) return Promise.reject(Error('workspace-graph-material-item-changed'));
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { const pending = nativeDetailPendingRef.current; if (pending?.timer === timer) { nativeDetailPendingRef.current = null; reject(Error('workspace-graph-material-paint-timeout')); } }, 7000);
          const requestId = ++nativeDetailSequenceRef.current;
          nativeDetailPendingRef.current = { requestId, request: JSON.parse(JSON.stringify(request)), resolve, reject, timer };
          setNativeDetailRequestId(requestId);
          openDetailViewer(asset);
        });
      },
    });
    return () => { release(); const pending = nativeDetailPendingRef.current; nativeDetailPendingRef.current = null; if (pending) { clearTimeout(pending.timer); pending.reject(Error('workspace-graph-material-view-closed')); } };
  }, [attachmentCollection, libraryId, libraryContext, openDetailViewer]);
  useLayoutEffect(() => {
    const pending = nativeDetailPendingRef.current;
    if (!pending || pending.requestId !== nativeDetailRequestId) return;
    const finish = (error: Error | null, ack?: MaterialNativeDetailAck) => {
      if (nativeDetailPendingRef.current !== pending) return;
      nativeDetailPendingRef.current = null; clearTimeout(pending.timer);
      if (error) pending.reject(error); else pending.resolve(ack!);
    };
    return observeMaterialDetailPaint(pending.requestId, pending.request, () => {
      if (nativeDetailPendingRef.current !== pending) return null;
      const current = nativeDetailCurrentRef.current;
      const viewId = scopeRef.current?.viewId || 'main-materials';
      return { requestId: pending.requestId, binding: materialNativeDetailViews.get(viewId).binding(),
        asset: current.viewerAsset, mode: current.viewerMode, element: nativeDetailElementRef.current };
    }, ack => finish(null, ack), error => finish(error));
  }, [nativeDetailRequestId, viewerAsset, viewerMode, materialSnapshot.version]);

  const openPreviewViewer = useCallback((asset: Asset) => {
    if(scopeRef.current)setWorkspaceInspectedAssetId(asset.id);
    window.dispatchEvent(new Event("luckyray:material-viewer-opening"));
    rememberViewerTrigger();
    setSelectedAsset(null);
    setPreviewAsset(asset);
  }, [rememberViewerTrigger]);

  const closeMaterialViewer = useCallback(() => {
    setSelectedAsset(null);
    setPreviewAsset(null);
  }, []);

  useLayoutEffect(() => {
    const leave = () => {
      const route = location.hash.replace(/^#\/?/, "").split(/[/?]/)[0];
      if (route && route !== (scopeRef.current?'workspace':'materials')) closeMaterialViewer();
    };
    window.addEventListener("hashchange", leave);
    leave();
    return () => { window.removeEventListener("hashchange", leave); leave(); };
  }, [closeMaterialViewer]);

  const toggleMaterialFavorite = useCallback(async (asset: Asset) => {
    try {
      const result = await materialFavorites.toggle(asset.id, asset.name || t("materials.unnamed"));
      if (!result.cancelled) setToast(t(result.favorited ? "materials.status.favorited" : "materials.status.unfavorited"));
    } catch {
      setToast(t("materials.status.favoriteFailed"), "error");
    }
  }, [materialFavorites, t]);

  useEffect(() => {
    if (!selectedAsset) return;
    const refreshed = allAssets.find((asset) => asset.id === selectedAsset.id);
    if (refreshed && refreshed !== selectedAsset) {
      setSelectedAsset(refreshed);
    } else if (!refreshed && materialSnapshot.loaded) {
      setSelectedAsset(null);
    }
  }, [allAssets, materialSnapshot.loaded, selectedAsset]);

  useEffect(() => {
    if (!previewAsset) return;
    const refreshed = allAssets.find((asset) => asset.id === previewAsset.id);
    if (refreshed && refreshed !== previewAsset) {
      setPreviewAsset(refreshed);
    } else if (!refreshed && materialSnapshot.loaded) {
      setPreviewAsset(null);
    }
  }, [allAssets, materialSnapshot.loaded, previewAsset]);

  // D107/D110: 筛选状态
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterKinds, setFilterKinds] = useState<string[]>(persistedFilter.kinds);
  const [filterRecent, setFilterRecent] = useState(persistedFilter.recentOnly);
  const [filterTagIds, setFilterTagIds] = useState<string[]>(persistedFilter.tagIds);
  const [filterStorageMode, setFilterStorageMode] = useState<StorageFilter>(persistedFilter.storageMode);
  const [filterFolderId, setFilterFolderId] = useState<string | null>(persistedFilter.folderId);
  const [filterColor, setFilterColor] = useState<StandardMaterialColorFilter | null>(persistedFilter.color);
  const [filterDateFrom, setFilterDateFrom] = useState(persistedFilter.dateFrom);
  const [filterDateTo, setFilterDateTo] = useState(persistedFilter.dateTo);
  const [filterRatingMin, setFilterRatingMin] = useState<number | null>(persistedFilter.ratingMin);
  const randomOrderRef = useRef<Map<string, number>>(new Map());
  const extractingColorIdsRef = useRef<Set<string>>(new Set());
  const [focusedAssetId, setFocusedAssetId] = useState<string | null>(null);
  const [assetNavigationIntent, setAssetNavigationIntent] = useState<MaterialNavigationIntent | null>(() => scope?null:materialNavigationCoordinator.restorePendingFocus());
  const masonryContainerRef = useRef<HTMLDivElement | null>(null);
  const cancelFocusPositionRef = useRef<(() => void) | null>(null);
  const focusHighlightTimerRef = useRef<number | null>(null);
  const activeFocusRequestIdRef = useRef<string | null>(null);
  const focusRevalidationRequestIdRef = useRef<string | null>(null);
  const focusTransactionTimeoutRef = useRef<number | null>(null);
  const nativeDropHandledAtRef = useRef(0);
  const folderTreeDragActiveRef = useRef(false);
  const suppressNextCardClickRef = useRef(false);
  const scrollTopRef = useRef(initialViewCache?.scrollTop || 0);
  const appearanceReturn = useRef<{ scrollTop: number; selectedIds: Set<string> } | null>(null);
  const appearanceRestore = useRef<number | null>(null);
  const applyAppearanceResult = (ids: string[] | null) => {
    if (ids !== null && !appearanceReturn.current) {
      appearanceReturn.current = { scrollTop: masonryContainerRef.current?.scrollTop ?? scrollTopRef.current, selectedIds: new Set(selectedIds) };
    } else if (ids === null && appearanceReturn.current) {
      const previous = appearanceReturn.current; appearanceReturn.current = null;
      appearanceRestore.current = previous.scrollTop;
      setSelectedIds(previous.selectedIds);
    }
    setAppearanceIds(ids);
  };
  useLayoutEffect(() => {
    if (appearanceIds !== null || appearanceRestore.current === null) return;
    const top = appearanceRestore.current; appearanceRestore.current = null;
    scrollTopRef.current = top;
    // The waterfall measures after the result projection is removed. Restore
    // against those real dimensions, not the still-empty loading grid.
    let frame = 0, attempts = 0;
    const restore = () => {
      const container = masonryContainerRef.current;
      if (!container) return;
      container.scrollTop = top;
      if (Math.abs(container.scrollTop - top) > 1 && attempts++ < 12) frame = requestAnimationFrame(restore);
    };
    frame = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(frame);
  }, [appearanceIds]);

  useLayoutEffect(() => {
    const viewerOpen = Boolean(viewerAsset);
    if (viewerWasOpenRef.current && !viewerOpen && compareReturnRef.current?.kind !== "detail") {
      const previousTarget = viewerReturnFocusRef.current;
      const focusTarget = previousTarget?.isConnected ? previousTarget : masonryContainerRef.current;
      focusTarget?.focus({ preventScroll: true });
      viewerReturnFocusRef.current = null;
    }
    viewerWasOpenRef.current = viewerOpen;
  }, [viewerAsset]);

  // D115: 应用内弹窗（替代 window.alert / window.confirm）
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const confirmDialogRef = useRef<ConfirmDialogState | null>(null);
  const [alertDialog, setAlertDialog] = useState<{ message: string } | null>(null);

  // D110: 失效素材
  const [missingOpen, setMissingOpen] = useState(false);
  const [missingList, setMissingList] = useState<MaterialMissingItem[]>([]);
  const [missingLoading, setMissingLoading] = useState(false);
  const [missingScanError, setMissingScanError] = useState("");
  const [missingRelocatingIds, setMissingRelocatingIds] = useState<Set<string>>(new Set());
  const materialsPageMountedRef = useRef(false);
  const missingRelocatingIdsRef = useRef<Set<string>>(new Set());
  const sourceRelocateConfirmationRef = useRef<((confirmed: boolean) => void) | null>(null);
  const missingScanCoordinatorRef = useRef<{
    schedule: (reason: MaterialMissingScanReason, delay?: number) => void;
    scanNow: () => Promise<void>;
    dispose: () => void;
  } | null>(null);

  useLayoutEffect(() => {
    confirmDialogRef.current = confirmDialog;
  }, [confirmDialog]);

  const cancelConfirmDialog = useCallback(() => closeCurrentConfirmDialog(
    confirmDialogRef,
    () => setConfirmDialog(null),
    "cancel",
  ), []);

  const closeConfirmDialogForAction = useCallback(() => closeCurrentConfirmDialog(
    confirmDialogRef,
    () => setConfirmDialog(null),
    "action",
  ), []);

  const openConfirmDialog = useCallback((dialog: ConfirmDialogState) => {
    replaceCurrentConfirmDialog(
      confirmDialogRef,
      (nextDialog) => setConfirmDialog(nextDialog),
      dialog,
    );
  }, []);

  const clearMaterialFilters = useCallback(() => {
    setMaterialSearch(""); setMaterialQueryText("");
    const cleared = clearMaterialsToolbarFilters({
      kinds: filterKinds,
      tagIds: filterTagIds,
      recentOnly: filterRecent,
      storageMode: filterStorageMode,
      folderId: filterFolderId,
      color: filterColor,
      dateFrom: filterDateFrom,
      dateTo: filterDateTo,
      ratingMin: filterRatingMin,
      selectedFolderId,
    });
    setFilterKinds([...cleared.kinds]);
    setFilterRecent(cleared.recentOnly);
    setFilterTagIds([...cleared.tagIds]);
    setFilterStorageMode(cleared.storageMode);
    setFilterFolderId(cleared.folderId);
    setFilterColor(normalizeStandardMaterialColorFilter(cleared.color));
    setFilterDateFrom(cleared.dateFrom);
    setFilterDateTo(cleared.dateTo);
    setFilterRatingMin(cleared.ratingMin);
  }, [filterColor, filterDateFrom, filterDateTo, filterFolderId, filterKinds, filterRatingMin, filterRecent, filterStorageMode, filterTagIds, selectedFolderId]);

  const saveCurrentMaterialSmartFolder = useCallback(() => {
    if(scopeRef.current){setToast('工作区筛选仅作用当前视图；请在该素材库主页保存智能文件夹。');return;}
    if (filterTagIds.length > 1) { setToast(t("materials.status.smartTagsAll")); return; }
    if (materialSmartQueryMatchesKind(materialSearch, KIND_OPTIONS.map(option=>option.value), [...allAssets, ...assets])) {
      setToast(t("materials.status.smartQueryKind"));
      return;
    }
    const unsupported = filterRecent
      || filterStorageMode !== "all"
      || Boolean(filterFolderId)
      || Boolean(selectedFolderId)
      || Boolean(filterColor)
      || Boolean(filterRatingMin)
      || sortBy === "recent"
      || sortBy === "random"
      || sortBy === "size-desc";
    if (unsupported) {
      setToast(t("materials.status.smartUnsupported"));
      return;
    }
    const before = filterDateTo ? new Date(`${filterDateTo}T23:59:59.999`).toISOString() : null;
    window.location.hash = smartFolderDraftHash({
      name: t("materials.status.smartName"),
      criteria: {
        source: "material",
        query: materialSearch.trim(),
        kinds: [...filterKinds],
        tagIds: [...filterTagIds],
        favorite: null,
        added: { after: dateBoundaryIso(filterDateFrom) || null, before },
        modified: { after: null, before: null },
      },
      sort: sortBy === "name-asc" ? "name-asc" : "added-desc",
    });
  }, [filterColor, filterDateFrom, filterDateTo, filterFolderId, filterKinds, filterRatingMin, filterRecent, filterStorageMode, filterTagIds, sortBy, selectedFolderId, materialSearch, allAssets, assets, t]);

  const resetMaterialFolderSelection = useCallback(() => {
    setSelectedFolderId(null);
    setFilterFolderId(null);
  }, [t]);

  const activeFilterCount = countActiveStandardMaterialsFilters({
    kinds: filterKinds,
    tagIds: filterTagIds,
    recentOnly: filterRecent,
    storageMode: filterStorageMode,
    folderId: filterFolderId,
    color: filterColor,
    dateFrom: filterDateFrom,
    dateTo: filterDateTo,
    ratingMin: filterRatingMin,
  });
  const toolbarState = useMemo<MaterialsToolbarState>(() => ({
    query: materialSearch,
    searchMode: materialSearchMode,
    viewMode,
    workView: workViewPrefs?.active ?? "general",
    folderName: selectedFolderId ? findFolderNode(folders, selectedFolderId)?.name ?? null : null,
    sortBy,
    filterOpen,
    activeFilterCount,
    missingOpen,
    exportOpen: exportPanelOpen,
    exportRunningCount: Object.values(exportTasks).filter(isMaterialExportRunning).length
      + Object.values(csvTasks).filter((task) => ["preparing", "running", "cancelling"].includes(task.phase)).length,
    exportNeedsAttention: Object.values(exportTasks).some((task) => task.failed > 0 && !exportRetryState[task.taskId])
      || Object.values(exportTaskProblems).some((problem) => problem.stopped)
      || Object.values(csvTasks).some((task) => task.phase === "failed"),
  }), [activeFilterCount, exportPanelOpen, exportRetryState, exportTaskProblems, exportTasks, csvTasks,
    filterOpen, folders, missingOpen, selectedFolderId, sortBy, viewMode, workViewPrefs?.active, materialSearch, materialSearchMode]);

  const selectedCount = selectedIds.size;
  const batchMode = selectedCount > 0;

  const serverFilterKey = useMemo(() => JSON.stringify({
    query: materialQueryText,
    kinds: filterKinds,
    tagIds: filterTagIds,
    recentOnly: filterRecent,
    dateFrom: filterDateFrom,
    dateTo: filterDateTo,
    ratingMin: filterRatingMin,
  }), [materialQueryText, filterDateFrom, filterDateTo, filterKinds, filterRatingMin, filterRecent, filterTagIds]);

  useEffect(() => {
    if(scope)return;
    setAssetNavigationIntent(materialNavigationCoordinator.restorePendingFocus());
    return materialNavigationCoordinator.subscribe(() => {
      setAssetNavigationIntent(materialNavigationCoordinator.getCurrentIntent());
    });
  }, []);

  const hasServerFilters = filterKinds.length > 0
    || Boolean(materialQueryText)
    || filterTagIds.length > 0
    || filterRecent
    || Boolean(filterDateFrom)
    || Boolean(filterDateTo)
    || Boolean(filterRatingMin);

  const materialQuery = useMemo<MaterialStoreQuery>(() => ({
    libraryId: libraryContext.libraryId,
    libraryGeneration: libraryContext.generation,
    key: `${attachmentCollection ? `note-attachments:${attachmentVaultId}:${includeUnreferenced}:${attachmentQueryText}` : "ordinary"}:${serverFilterKey}`,
    filters: hasServerFilters || attachmentCollection
      ? {
        scope: attachmentCollection ? "note-attachments" : "ordinary",
        query: attachmentCollection ? attachmentQueryText || undefined : materialQueryText || undefined,
        vaultId: attachmentCollection ? attachmentVaultId || undefined : undefined,
        includeUnreferenced: attachmentCollection ? includeUnreferenced : undefined,
        kinds: filterKinds.length ? filterKinds : undefined,
        tagIds: filterTagIds.length ? filterTagIds : undefined,
        recentOnly: filterRecent || undefined,
        dateFrom: dateBoundaryIso(filterDateFrom),
        dateTo: dateBoundaryIso(filterDateTo, 1),
        ratingMin: filterRatingMin || undefined,
      }
      : undefined,
  }), [attachmentCollection, attachmentVaultId, includeUnreferenced, attachmentQueryText, materialQueryText, filterDateFrom, filterDateTo, filterKinds, filterRatingMin, filterRecent, filterTagIds, hasServerFilters, serverFilterKey]);

  useEffect(() => {
    if (attachmentCollection) { setSelectedFolderId(null); setFilterFolderId(null); }
    setSelectedIds(new Set());
  }, [attachmentCollection, attachmentVaultId]);

  const revalidateMaterials = useCallback((reason: string, options?: { foldersChanged?: boolean; affectedIds?: string[] }) => (
    materialStore.invalidate({
      reason,
      query: materialQuery,
      foldersChanged: options?.foldersChanged,
      affectedIds: options?.affectedIds,
    })
  ), [materialQuery]);

  const reloadFolders = useCallback(() => (
    revalidateMaterials("materials-folders-refresh", { foldersChanged: true })
  ), [revalidateMaterials]);

  useEffect(() => {
    setMaterialSnapshot(materialStore.getSnapshot());
    const unsubscribe = materialStore.subscribe(() => {
      setMaterialSnapshot(materialStore.getSnapshot());
    });
    const releaseChangeProtocol = materialStore.retainChangeProtocol();
    return () => {
      unsubscribe();
      releaseChangeProtocol();
    };
  }, []);

  useEffect(() => {
    void materialStore.ensureSnapshot({ reason: "materials-page-query", query: materialQuery });
  }, [materialQuery]);

  // D110: 筛选持久化
  useEffect(() => {
    saveFilterState({
      kinds: filterKinds,
      tagIds: filterTagIds,
      recentOnly: filterRecent,
      storageMode: filterStorageMode,
      folderId: filterFolderId,
      color: filterColor,
      dateFrom: filterDateFrom,
      dateTo: filterDateTo,
      ratingMin: filterRatingMin,
    },libraryId);
  }, [filterKinds, filterTagIds, filterRecent, filterStorageMode, filterFolderId, filterColor, filterDateFrom, filterDateTo, filterRatingMin]);

  useEffect(() => {
    materialsViewCaches.set(cacheKey, {
      filter: {
        kinds: [...filterKinds],
        tagIds: [...filterTagIds],
        recentOnly: filterRecent,
        storageMode: filterStorageMode,
        folderId: filterFolderId,
        color: filterColor,
        dateFrom: filterDateFrom,
        dateTo: filterDateTo,
        ratingMin: filterRatingMin,
      },
      selectedFolderId,
      sortBy,
      viewMode,
      scrollTop: scrollTopRef.current,
    });
  }, [filterColor, filterDateFrom, filterDateTo, filterFolderId, filterKinds, filterRatingMin, filterRecent, filterStorageMode, filterTagIds, selectedFolderId, sortBy, viewMode]);

  useEffect(() => {
    if(scope)return;
    publishMaterialsToolbarState(toolbarState);
  }, [toolbarState]);

  useEffect(() => {
    if(scope)return;
    if (!selectedAsset) {
      clearCurrentAssetContext();
      return;
    }
    publishCurrentAssetContext(assetToActiveAssetContext(selectedAsset));
  }, [selectedAsset]);


  useEffect(() => {
    const settings = readSavedSettings();
    if (settings["materials.importModePromptSeen"] !== true) {
      setShowImportModePrompt(true);
    }
  }, []);

  const chooseImportMode = useCallback((mode: AssetStorageMode) => {
    writeSavedSettingsPatch({
      "materials.importMode": mode,
      "materials.importModePromptSeen": true,
    });
    setShowImportModePrompt(false);
    setToast(t("materials.status.storageMode", { mode: getStorageModeLabel(mode, t) }));
  }, [t]);

  useEffect(() => {
    if (!filterOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".filter-panel-react")) return;
      if (target.closest("#materials-filter-trigger")) return;
      setFilterOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [filterOpen]);

  useEffect(() => {
    if (!missingOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".missing-panel-react")) return;
      if (target.closest("#materials-missing-trigger")) return;
      setMissingOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [missingOpen]);

  useEffect(() => {
    // 初始化 zoom CSS 变量
    try {
      const saved = readPreference("luckyray-materials-zoom-v1");
      const val = saved ? parseInt(saved, 10) : 160;
      const zoom = val >= 60 && val <= 300 ? val : 160;
      applyMaterialZoom(zoom);
    } catch {}
  }, []);

  useLayoutEffect(() => {
    const savedScrollTop = initialViewCacheRef.current?.scrollTop || 0;
    if (!savedScrollTop) return;
    let disposed = false;
    let frameId: number | null = null;
    let attempts = 0;
    const maxAttempts = 18;

    const restore = () => {
      if (disposed) return;
      const container = masonryContainerRef.current;
      if (!container) {
        if (attempts++ < maxAttempts) frameId = requestAnimationFrame(restore);
        return;
      }

      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
      container.scrollTop = Math.min(savedScrollTop, maxScrollTop);
      if (Math.abs(container.scrollTop - savedScrollTop) > 1 && attempts++ < maxAttempts) {
        frameId = requestAnimationFrame(restore);
      }
    };

    const container = masonryContainerRef.current;
    const observer = container ? new ResizeObserver(() => {
      if (disposed || attempts >= maxAttempts) return;
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(restore);
    }) : null;
    if (container) observer?.observe(container);
    frameId = requestAnimationFrame(restore);
    return () => {
      disposed = true;
      if (frameId !== null) cancelAnimationFrame(frameId);
      observer?.disconnect();
    };
  }, []);

  const rememberMasonryScroll = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    scrollTopRef.current = event.currentTarget.scrollTop;
    const cached = materialsViewCaches.get(cacheKey);
    if (cached) materialsViewCaches.set(cacheKey, { ...cached, scrollTop: scrollTopRef.current });
  }, []);

  // The page route unmounts the waterfall. Capture the physical scroll offset
  // during layout cleanup as a backstop for wheel/touch scrolling.
  useLayoutEffect(() => () => {
    const scrollTop = masonryContainerRef.current?.scrollTop ?? scrollTopRef.current;
    scrollTopRef.current = scrollTop;
    const cached = materialsViewCaches.get(cacheKey);
    if (cached) materialsViewCaches.set(cacheKey, { ...cached, scrollTop });
  }, []);

  const selectedFolderIds = useMemo(
    () => getFolderAndDescendantIdSet(folders, selectedFolderId),
    [folders, selectedFolderId],
  );

  const colorMatchedAssetIds = useMemo(() => {
    if (!filterColor) return null;
    return new Set(
      allAssets.filter((asset) => materialPaletteMatchesStandardColor(asset.dominantColor, filterColor))
        .map((asset) => asset.id),
    );
  }, [allAssets, filterColor]);

  // Sort the already filtered scope first. Work views only promote a type;
  // stable sorting keeps the user's chosen order inside both groups.
  const appearanceScopeAssets = useMemo(() => {
    let filtered = selectedFolderIds
      ? assets.filter((asset) => asset.folderId ? selectedFolderIds.has(asset.folderId) : false)
      : assets;
    if (filterStorageMode !== "all") {
      filtered = filtered.filter((asset) => normalizeStorageMode(asset.storageMode) === filterStorageMode);
    }
    if (colorMatchedAssetIds) {
      filtered = filtered.filter((asset) => colorMatchedAssetIds.has(asset.id));
    }
    if (sortBy === "recent") {
      const recentRank = new Map(materialSnapshot.recentOrder.map((id, index) => [id, index]));
      filtered = [...filtered].sort((a, b) => {
        const aRank = recentRank.get(a.id);
        const bRank = recentRank.get(b.id);
        if (aRank !== undefined && bRank !== undefined) return aRank - bRank;
        if (aRank !== undefined) return -1;
        if (bRank !== undefined) return 1;
        return getTimeValue(b.importedAt || b.updatedAt) - getTimeValue(a.importedAt || a.updatedAt);
      });
    } else if (sortBy === "newest") {
      filtered = [...filtered].sort((a, b) => (b.importedAt || "").localeCompare(a.importedAt || ""));
    } else if (sortBy === "random") {
      const order = randomOrderRef.current;
      for (const asset of filtered) {
        if (!order.has(asset.id)) order.set(asset.id, Math.random());
      }
      filtered = [...filtered].sort((a, b) => {
        return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
      });
    } else if (sortBy === "name-asc" || sortBy === "size-desc") {
      filtered = sortMaterialMetadata(filtered, sortBy);
    }
    const workView = workViewPrefs?.active ?? "general";
    if (workView !== "general") {
      const preferred = workView === "design" ? isImageAsset : isVideoAsset;
      filtered = [...filtered].sort((a, b) => Number(preferred(b)) - Number(preferred(a)));
    }
    return filtered;
  }, [assets, colorMatchedAssetIds, materialSnapshot.recentOrder, selectedFolderIds, filterStorageMode, sortBy, workViewPrefs?.active]);

  const sortedAssets = useMemo(() => {
    if (appearanceIds === null) return appearanceScopeAssets;
    const byId = new Map(appearanceScopeAssets.map(asset => [asset.id, asset]));
    return appearanceIds.flatMap(id => { const asset = byId.get(id); return asset ? [asset] : []; });
  }, [appearanceScopeAssets, appearanceIds]);

  const hasAvailableFilterColors = useMemo(() => {
    let source = allAssets.length ? allAssets : assets;
    const scopeFolderId = filterFolderId ?? selectedFolderId;
    const scopeFolderIds = getFolderAndDescendantIdSet(folders, scopeFolderId);
    if (scopeFolderIds) source = source.filter((asset) => asset.folderId ? scopeFolderIds.has(asset.folderId) : false);
    if (filterStorageMode !== "all") {
      source = source.filter((asset) => normalizeStorageMode(asset.storageMode) === filterStorageMode);
    }
    if (filterKinds.length) {
      source = source.filter((asset) => filterKinds.includes(asset.kind));
    }
    return source.some((asset) => getMaterialPalette(asset.dominantColor).length > 0);
  }, [allAssets, assets, folders, filterFolderId, selectedFolderId, filterStorageMode, filterKinds]);

  const visibleSelectedIds = useMemo(
    () => sortedAssets.filter((asset) => selectedIds.has(asset.id)).map((asset) => asset.id),
    [sortedAssets, selectedIds]
  );

  const patchMaterialAssets = useCallback((reason: string, affectedIds: string[] | undefined, update: (items: Asset[]) => Asset[]) => {
    materialStore.optimistic({
      reason,
      affectedIds,
      update: (snapshot) => ({
        assets: update(snapshot.assets as Asset[]),
        allAssets: update(snapshot.allAssets as Asset[]),
        folders: snapshot.folders,
      }),
    });
  }, []);

  const mergeAssetUpdate = useCallback((nextAsset: Asset) => {
    patchMaterialAssets("material-asset-update", [nextAsset.id], (current) => (
      current.map((asset) => asset.id === nextAsset.id ? { ...asset, ...nextAsset } : asset)
    ));
    setSelectedAsset((current) => current?.id === nextAsset.id ? { ...current, ...nextAsset } : current);
  }, [patchMaterialAssets]);

  const resolveAssetColorSource = useCallback(async (asset: Asset): Promise<string> => {
    if (asset.thumbnailUrl) return asset.thumbnailUrl;
    if (!asset.libraryPath) return "";
    if (isVideoAsset(asset)) return resolveVideoPreviewUrl(asset);
    if (isImageAsset(asset)) return getMaterialAssetPreviewUrl(asset.libraryPath);
    return "";
  }, []);

  useEffect(() => {
    const candidates = (allAssets.length ? allAssets : assets)
      .filter((asset) => (isImageAsset(asset) || isVideoAsset(asset)) && !isMaterialColorExtractionFresh(asset))
      .filter((asset) => !extractingColorIdsRef.current.has(asset.id))
      .slice(0, 8);
    if (candidates.length === 0) return;

    let cancelled = false;
    const run = async () => {
      for (const asset of candidates) {
        if (cancelled) break;
        extractingColorIdsRef.current.add(asset.id);
        try {
          const source = await resolveAssetColorSource(asset);
          if (!source || cancelled) continue;
          const dominantColor = await extractDominantMaterialPalette(source);
          if (cancelled) break;
          const updated = await updateMaterialAsset(asset.id, { dominantColor }, attachmentCollection ? attachmentVaultId : undefined);
          const nextAsset = { ...asset, ...(updated || {}), dominantColor: updated?.dominantColor || dominantColor };
          if (getMaterialPalette(nextAsset.dominantColor).length) markMaterialColorExtractionFresh(nextAsset);
          mergeAssetUpdate(nextAsset);
        } catch (error) {
          console.warn("[materials] auto dominant color failed", asset.id, error);
        }
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [allAssets, assets, mergeAssetUpdate, resolveAssetColorSource]);

  const focusAssetInView = useCallback((intent: MaterialNavigationIntent) => new Promise<"positioned" | "timeout" | "cancelled">((resolve) => {
    cancelFocusPositionRef.current?.();
    let complete = false;
    let frameId: number | null = null;
    let mutationObserver: MutationObserver | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let observedContainer: HTMLDivElement | null = null;
    let lastRequestedScrollTop: number | null = null;
    const deadline = performance.now() + ASSET_FOCUS_POSITION_TIMEOUT_MS;
    const cancel = () => finish("cancelled");

    const finish = (result: "positioned" | "timeout" | "cancelled") => {
      if (complete) return;
      complete = true;
      if (frameId !== null) cancelAnimationFrame(frameId);
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      observedContainer?.removeEventListener("scroll", queueCheck);
      observedContainer?.removeEventListener("scrollend", queueCheck);
      if (cancelFocusPositionRef.current === cancel) cancelFocusPositionRef.current = null;
      resolve(result);
    };

    const queueCheck = () => {
      if (complete || frameId !== null) return;
      frameId = requestAnimationFrame(() => {
        frameId = null;
        checkPosition();
      });
    };

    const checkPosition = () => {
      if (complete) return;
      if (!materialNavigationCoordinator.isCurrent(intent.requestId)) {
        finish("cancelled");
        return;
      }
      if (performance.now() >= deadline) {
        materialNavigationCoordinator.reportFocusStage(intent.requestId, "timeout");
        finish("timeout");
        return;
      }
      const container = masonryContainerRef.current;
      const item = container?.querySelector<HTMLElement>(`[data-asset-id="${escapeCssIdentifier(intent.assetId)}"]`);
      if (!container || !item || item.getClientRects().length === 0) {
        queueCheck();
        return;
      }

      mutationObserver?.disconnect();
      if (!resizeObserver) {
        observedContainer = container;
        resizeObserver = new ResizeObserver(queueCheck);
        resizeObserver.observe(container);
        resizeObserver.observe(item);
        container.addEventListener("scroll", queueCheck, { passive: true });
        container.addEventListener("scrollend", queueCheck, { passive: true });
      }

      materialNavigationCoordinator.reportFocusStage(intent.requestId, "element-ready");
      const containerRect = container.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      const targetCenter = containerRect.top + containerRect.height / 2;
      const itemCenter = itemRect.top + itemRect.height / 2;
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
      const desiredScrollTop = Math.min(maxScrollTop, Math.max(0, container.scrollTop + itemCenter - targetCenter));
      const visible = itemRect.bottom >= containerRect.top && itemRect.top <= containerRect.bottom;
      const centered = Math.abs(itemCenter - targetCenter) <= Math.max(32, Math.min(120, containerRect.height * 0.15));
      const atBestReachablePosition = Math.abs(container.scrollTop - desiredScrollTop) <= 1;

      if (visible && (centered || atBestReachablePosition)) {
        materialNavigationCoordinator.reportFocusStage(intent.requestId, "scroll-settled");
        finish("positioned");
        return;
      }

      if (lastRequestedScrollTop === null || Math.abs(lastRequestedScrollTop - desiredScrollTop) > 1) {
        lastRequestedScrollTop = desiredScrollTop;
        container.scrollTo({ top: desiredScrollTop, behavior: "smooth" });
      }
      queueCheck();
    };

    cancelFocusPositionRef.current = cancel;
    mutationObserver = new MutationObserver(queueCheck);
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    queueCheck();
  }), []);

  const startAssetFocusHighlight = useCallback((assetId: string) => {
    if (focusHighlightTimerRef.current !== null) clearTimeout(focusHighlightTimerRef.current);
    setFocusedAssetId(assetId);
    focusHighlightTimerRef.current = window.setTimeout(() => {
      setFocusedAssetId((current) => current === assetId ? null : current);
      focusHighlightTimerRef.current = null;
    }, ASSET_FOCUS_HIGHLIGHT_MS);
  }, []);

  useEffect(() => {
    const requestId = assetNavigationIntent?.requestId;
    if (!requestId) return;
    if (activeFocusRequestIdRef.current && activeFocusRequestIdRef.current !== requestId) {
      cancelFocusPositionRef.current?.();
      if (focusHighlightTimerRef.current !== null) clearTimeout(focusHighlightTimerRef.current);
      focusHighlightTimerRef.current = null;
      setFocusedAssetId(null);
    }
    activeFocusRequestIdRef.current = requestId;
    if (focusTransactionTimeoutRef.current !== null) clearTimeout(focusTransactionTimeoutRef.current);
    focusTransactionTimeoutRef.current = window.setTimeout(() => {
      if (!materialNavigationCoordinator.isCurrent(requestId)) return;
      setToast(t("materials.status.locationTimeout"), "error");
      materialNavigationCoordinator.reportFocusStage(requestId, "timeout");
    }, ASSET_FOCUS_TRANSACTION_TIMEOUT_MS);
    return () => {
      if (focusTransactionTimeoutRef.current !== null) {
        clearTimeout(focusTransactionTimeoutRef.current);
        focusTransactionTimeoutRef.current = null;
      }
    };
  }, [assetNavigationIntent?.requestId, t]);

  useEffect(() => () => {
    cancelFocusPositionRef.current?.();
    if (focusHighlightTimerRef.current !== null) clearTimeout(focusHighlightTimerRef.current);
    if (focusTransactionTimeoutRef.current !== null) clearTimeout(focusTransactionTimeoutRef.current);
    const active = materialNavigationCoordinator.getCurrentIntent();
    if (active) materialNavigationCoordinator.releasePage(active.requestId);
  }, []);

  const showAllAssetsForFocus = useCallback((nextAssets: Asset[]) => {
    resetMaterialFolderSelection();
    setFilterKinds([]);
    setFilterTagIds([]);
    setFilterRecent(false);
    setFilterStorageMode("all");
    setFilterColor(null);
    setFilterDateFrom("");
    setFilterDateTo("");
    setFilterRatingMin(null);
    materialStore.optimistic({
      reason: "material-navigation-filter-fallback",
      update: (snapshot) => ({
        assets: nextAssets,
        allAssets: snapshot.allAssets,
        folders: snapshot.folders,
      }),
    });
  }, [resetMaterialFolderSelection]);

  useEffect(() => {
    const requestId = focusRevalidationRequestIdRef.current;
    if (!requestId) return;
    if (!materialNavigationCoordinator.isCurrent(requestId)) {
      focusRevalidationRequestIdRef.current = null;
      return;
    }
    if (dataPending) return;
    focusRevalidationRequestIdRef.current = null;
    materialNavigationCoordinator.completeSnapshotRetry(requestId);
  }, [allAssets, assets, dataPending]);

  useEffect(() => {
    const intent = assetNavigationIntent;
    if (!intent) return;

    if (intent.phase === "received") {
      materialNavigationCoordinator.reportFocusStage(intent.requestId, "snapshot-ready");
      return;
    }

    const target = sortedAssets.find((asset) => asset.id === intent.assetId);
    const knownTarget = allAssets.find((asset) => asset.id === intent.assetId);

    if (!target) {
      if (intent.revalidationPending || dataPending || !materialSnapshot.loaded) return;
      if (knownTarget && !intent.filterFallbackApplied) {
        showAllAssetsForFocus(allAssets);
        setToast(t("materials.status.allForLocation"));
        materialNavigationCoordinator.reportFocusStage(intent.requestId, "filter-resolved", { filterFallbackApplied: true });
        return;
      }
      if (!knownTarget && intent.retry === 0 && materialNavigationCoordinator.retrySnapshot(intent.requestId)) {
        focusRevalidationRequestIdRef.current = intent.requestId;
        void revalidateMaterials("material-navigation-miss");
        return;
      }
      if (!knownTarget && intent.retry > 0) {
        setToast(t("materials.status.notFound"), "error");
        materialNavigationCoordinator.reportFocusStage(intent.requestId, "not-found");
      }
      return;
    }

    if (intent.phase === "snapshot-ready") {
      materialNavigationCoordinator.reportFocusStage(intent.requestId, "filter-resolved");
      return;
    }

    if (intent.phase === "filter-resolved") {
      void focusAssetInView(intent).then((result) => {
        if (result === "timeout") setToast(t("materials.status.locationTimeout"), "error");
      });
      return;
    }

    if (intent.phase === "scroll-settled") {
      startAssetFocusHighlight(target.id);
      materialNavigationCoordinator.reportFocusStage(intent.requestId, "spotlight-applied");
      return;
    }

    if (intent.phase === "optional-detail") {
      openDetailViewer(target);
      setToast(t("materials.status.detailOpened"));
      materialNavigationCoordinator.reportFocusStage(intent.requestId, "detail-opened");
    }
  }, [allAssets, assetNavigationIntent, dataPending, focusAssetInView, materialSnapshot.loaded, openDetailViewer, revalidateMaterials, showAllAssetsForFocus, sortedAssets, startAssetFocusHighlight, t]);

  const mergeImportedAssets = useCallback((importedAssets: Asset[]) => {
    if (importedAssets.length === 0) return;
    materialStore.optimistic({
      reason: "material-import-merge",
      affectedIds: importedAssets.map((asset) => asset.id),
      update: (snapshot) => ({
        assets: mergeAssetLists(importedAssets, snapshot.assets as Asset[]),
        allAssets: mergeAssetLists(importedAssets, snapshot.allAssets as Asset[]),
        folders: snapshot.folders,
      }),
    });
  }, []);

  useEffect(() => {
    try {
      writePreference(VIEW_STORAGE_KEY, viewMode);
    } catch {}
  }, [viewMode]);

  useEffect(() => {
    const handlePointerDown = () => {
      if (compareOpenRef.current) return;
      closeContextMenu(true);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if(!acceptsCommand(event))return;
      if (document.querySelector(".material-film")) return;
      // The compare modal traps the keyboard entirely; page-level Escape and
      // viewer navigation must stay inert while it is open.
      if (compareOpenRef.current) {
        const compareShortcutKey = event.key.toLowerCase();
        if (event.key === "Delete" || event.key === "#" || ((event.ctrlKey || event.metaKey) && ["a", "i", "f"].includes(compareShortcutKey))) {
          event.preventDefault();
        }
        return;
      }
      if (event.key === "Escape") {
        if (cancelConfirmDialog()) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        closeContextMenu(true);
        closeMaterialViewer();
        setModal(null);
        setFilterOpen(false);
        setMissingOpen(false);
      } else if (confirmDialogRef.current) {
        return;
      } else if (viewerAsset && event.key === "ArrowLeft") {
        const target = event.target as HTMLElement | null;
        const tagName = target?.tagName?.toLowerCase();
        if (tagName === "input" || tagName === "textarea" || tagName === "select" || target?.isContentEditable) return;
        event.preventDefault();
        const adjacent = getAdjacentAsset(viewerAsset, sortedAssets, -1);
        if (viewerMode === "detail") setSelectedAsset(adjacent);
        else setPreviewAsset(adjacent);
      } else if (viewerAsset && event.key === "ArrowRight") {
        const target = event.target as HTMLElement | null;
        const tagName = target?.tagName?.toLowerCase();
        if (tagName === "input" || tagName === "textarea" || tagName === "select" || target?.isContentEditable) return;
        event.preventDefault();
        const adjacent = getAdjacentAsset(viewerAsset, sortedAssets, 1);
        if (viewerMode === "detail") setSelectedAsset(adjacent);
        else setPreviewAsset(adjacent);
      }
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [cancelConfirmDialog, closeContextMenu, closeMaterialViewer, sortedAssets, viewerAsset, viewerMode]);

  // 导入素材
  const handleImport = useCallback(async (folderIdOverride?: string | null) => {
    const targetFolderId = folderIdOverride ?? selectedFolderId ?? null;
    const importOptions = readMaterialImportOptions(libraryId);
    try {
      const result = await importMaterialAssets(targetFolderId, {
        ...importOptions,
        onProgress: (progress: MaterialImportProgress) => {
          setImportProgress({
            current: progress.current,
            total: progress.total,
            bytesRead: progress.bytesRead, bytesTotal: progress.bytesTotal,
            label: formatImportProgressLabel(progress, t),
          });
        },
      });
      if (result.assets.length > 0) {
        mergeImportedAssets(result.assets);
        setToast(plural(result.assets.length, { one: "materials.status.imported.one", other: "materials.status.imported.other" }));
      } else if (result.skippedDuplicates > 0) {
        setToast(plural(result.skippedDuplicates, { one: "materials.status.skipped.one", other: "materials.status.skipped.other" }));
      }
      await revalidateMaterials("material-import", { affectedIds: result.assets.map((asset) => asset.id) });
      missingScanCoordinatorRef.current?.schedule("data-change");
    } catch {
      setAlertDialog({ message: t("materials.status.importFailed") });
    } finally {
      setImportProgress(null);
    }
  }, [selectedFolderId, revalidateMaterials, mergeImportedAssets, plural, t]);

  const handleDroppedPaths = useCallback(async (pathsLike: string[] | readonly string[], folderIdOverride?: string | null) => {
    const paths = Array.from(pathsLike || []).map((path) => path.trim()).filter(Boolean);
    if (paths.length === 0) {
      setAlertDialog({ message: t("materials.status.noDropPath") });
      return;
    }
    const targetFolderId = folderIdOverride ?? selectedFolderId ?? null;
    const importOptions = readMaterialImportOptions(libraryId);
    setImportProgress({ current: 0, total: paths.length, label: t("materials.status.importingDropped") });
    try {
      const { files, folders: droppedFolders } = await splitDroppedPaths(paths);
      let importedCount = 0;
      let skippedCount = 0;
      let failedCount = 0;
      let folderChanged = false;

      if (droppedFolders.length > 0) {
        setImportProgress({ current: 0, total: droppedFolders.length, label: t("materials.status.importingFolder"), indeterminate: true });
        for (const folderPath of droppedFolders) {
          const folderResult = await importMaterialFolder(folderPath, importOptions, libraryId);
          importedCount += folderResult.importedCount || 0;
          skippedCount += folderResult.skippedDuplicateCount || 0;
          failedCount += folderResult.failedCount || 0;
        }
        folderChanged = true;
      }

      if (files.length > 0) {
        setImportProgress({ current: 0, total: files.length, label: t("materials.status.importingDropped") });
        const fileResult = await importMaterialAssets(targetFolderId, {
          ...importOptions,
          paths: files,
          onProgress: (progress: MaterialImportProgress) => {
            setImportProgress({
              current: progress.current,
              total: progress.total,
              bytesRead: progress.bytesRead, bytesTotal: progress.bytesTotal,
              label: formatImportProgressLabel(progress, t),
            });
          },
        });
        importedCount += fileResult.assets.length;
        skippedCount += fileResult.skippedDuplicates || 0;
        if (fileResult.assets.length > 0) {
          mergeImportedAssets(fileResult.assets);
        }
      }

      if (folderChanged) {
        resetMaterialFolderSelection();
        notifyMaterialFoldersChanged();
      }

      await revalidateMaterials("material-external-drop", { foldersChanged: folderChanged });
      missingScanCoordinatorRef.current?.schedule("data-change");

      if (importedCount > 0) {
        const importedMessage = plural(importedCount, { one: "materials.status.dropped.one", other: "materials.status.dropped.other" });
        setToast(skippedCount > 0
          ? `${importedMessage} · ${plural(skippedCount, { one: "materials.status.skipped.one", other: "materials.status.skipped.other" })}`
          : importedMessage);
      } else if (skippedCount > 0) {
        setToast(plural(skippedCount, { one: "materials.status.skipped.one", other: "materials.status.skipped.other" }));
      } else if (failedCount > 0) {
        setAlertDialog({ message: t("materials.status.dropFolderFailed") });
      } else if (droppedFolders.length > 0) {
        setToast(t("materials.status.emptyFolder"));
      }
    } catch {
      setAlertDialog({ message: t("materials.status.importFailed") });
    } finally {
      setImportProgress(null);
    }
  }, [resetMaterialFolderSelection, selectedFolderId, revalidateMaterials, mergeImportedAssets, plural, t]);

  const handleDroppedFiles = useCallback(async (filesLike: FileList | File[]) => {
    const files = Array.from(filesLike || []).filter((file) => file && typeof file.name === "string");
    if (files.length === 0) {
      setAlertDialog({ message: t("materials.status.noDropPath") });
      return;
    }
    const targetFolderId = selectedFolderId ?? null;
    const importOptions = readMaterialImportOptions(libraryId);
    const droppedPaths = files.map(getDroppedFilePath).filter(Boolean);
    if (droppedPaths.length === files.length) {
      await handleDroppedPaths(droppedPaths, targetFolderId);
      return;
    }
    if (importOptions.storageMode !== "managed") {
      const paths = files.map(getDroppedFilePath).filter(Boolean);
      if (paths.length !== files.length) {
        setAlertDialog({ message: t("materials.status.noRealPath") });
        return;
      }
      setImportProgress({ current: 0, total: paths.length, label: t("materials.status.importingDropped") });
      try {
        const result = await importMaterialAssets(targetFolderId, {
          ...importOptions,
          paths,
          onProgress: (progress: MaterialImportProgress) => {
            setImportProgress({
              current: progress.current,
              total: progress.total,
              bytesRead: progress.bytesRead, bytesTotal: progress.bytesTotal,
              label: formatImportProgressLabel(progress, t),
            });
          },
        });
        if (result.assets.length > 0) {
          mergeImportedAssets(result.assets);
          setToast(plural(result.assets.length, { one: "materials.status.dropped.one", other: "materials.status.dropped.other" }));
        } else if (result.skippedDuplicates > 0) {
          setToast(plural(result.skippedDuplicates, { one: "materials.status.skipped.one", other: "materials.status.skipped.other" }));
        }
        await revalidateMaterials("material-file-drop", { affectedIds: result.assets.map((asset) => asset.id) });
      } catch {
        setAlertDialog({ message: t("materials.status.importFailed") });
      } finally {
        setImportProgress(null);
      }
      return;
    }
    setImportProgress({ current: 0, total: files.length, label: t("materials.status.importingFiles") });
    try {
      const result = await importDroppedMaterialAssets(files, targetFolderId, { managedLibraryDir: importOptions.managedLibraryDir, libraryId });
      if (result.assets.length > 0) {
        mergeImportedAssets(result.assets);
        setToast(plural(result.assets.length, { one: "materials.status.dropped.one", other: "materials.status.dropped.other" }));
      } else if (result.skippedDuplicates > 0) {
        setToast(plural(result.skippedDuplicates, { one: "materials.status.skipped.one", other: "materials.status.skipped.other" }));
      }
      if (result.errors?.length) {
        setAlertDialog({ message: plural(result.errors.length, { one: "materials.status.dropFilesFailed.one", other: "materials.status.dropFilesFailed.other" }) });
      }
      await revalidateMaterials("material-managed-drop", { affectedIds: result.assets.map((asset) => asset.id) });
    } catch {
      setAlertDialog({ message: t("materials.status.importFailed") });
    } finally {
      setImportProgress(null);
    }
  }, [selectedFolderId, revalidateMaterials, mergeImportedAssets, handleDroppedPaths, plural, t]);

  const viewModeRef = useRef(viewMode);
  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);
  const liveZoomRef = useRef<number>(readInitialMaterialZoom(libraryId));
  const workViewPrefsRef = useRef(workViewPrefs);
  useEffect(() => { workViewPrefsRef.current = workViewPrefs; }, [workViewPrefs]);
  const compareOpenRef = useRef(false);
  useEffect(() => { compareOpenRef.current = compareSlotIds !== null; }, [compareSlotIds]);

  /** Persist a manual presentation change into the ACTIVE preset. */
  const recordWorkViewPresentation = useCallback((nextViewMode: ViewMode | null, zoom: number | null) => {
    const prefs = workViewPrefsRef.current;
    if (!prefs) return; // 未使用过预设时保持原全局偏好路径
    const snapshot = {
      viewMode: nextViewMode ?? viewModeRef.current,
      zoom: zoom ?? liveZoomRef.current,
    };
    // Preserve a preset's stored zoom when only the view mode changed.
    const previous = prefs.saved[prefs.active];
    const merged = zoom === null && previous ? { viewMode: snapshot.viewMode, zoom: previous.zoom } : snapshot;
    const next = recordMaterialWorkViewAdjustment(prefs, prefs.active, merged);
    setWorkViewPrefs(next);
    saveMaterialWorkViewPreferences(next, libraryId);
  }, []);

  const applyWorkViewPreset = useCallback((preset: MaterialWorkViewPresetId) => {
    const prefs = workViewPrefsRef.current;
    // Honest switch: the first departure from 通用 snapshots the CURRENT
    // presentation into general.saved, so switching back restores the exact
    // habit. 通用 with no saved target changes nothing at all.
    const { preferences: nextPrefs, target } = switchMaterialWorkViewPreset(
      prefs,
      preset,
      { viewMode: viewModeRef.current, zoom: liveZoomRef.current },
    );
    workViewPrefsRef.current = nextPrefs;
    setWorkViewPrefs(nextPrefs);
    saveMaterialWorkViewPreferences(nextPrefs, libraryId);
    if (target) {
      viewModeRef.current = target.viewMode;
      setViewMode(target.viewMode);
      applyMaterialZoom(target.zoom);
      liveZoomRef.current = target.zoom;
      // The page persists the density it applies — MaterialsPage is shared
      // with the phone line, where the desktop sidebar (and its slider) does
      // not exist, so persistence must not depend on the subscriber. The
      // sidebar slider only mirrors the handle through the shared channel.
      try { writePreference("luckyray-materials-zoom-v1", String(target.zoom)); } catch {}
      window.dispatchEvent(new CustomEvent("luckyray:materials-zoom", { detail: { zoom: target.zoom } }));
    }
  }, []);

  // ONE honest predicate shared by the button AND the open action: compare
  // requires the WHOLE selection to be exactly two supported images. A
  // single non-image in the selection disables it (mixedSelection) — nothing
  // is silently dropped from what the user selected.
  const selectionImageOk = useMemo(
    () => Array.from(selectedIds).every((id) => {
      const asset = allAssets.find((entry) => entry.id === id);
      return asset ? isImageAsset(asset) : false;
    }),
    [allAssets, selectedIds],
  );
  const compareSelection: MaterialCompareSlotAsset[] = useMemo(() => {
    if (!selectionImageOk || selectedIds.size !== 2) return [];
    return Array.from(selectedIds).flatMap((id) => {
      const asset = allAssets.find((entry) => entry.id === id);
      return asset ? [{
        id: asset.id, name: asset.name, previewUrl: asset.previewUrl,
        thumbnailUrl: asset.thumbnailUrl, updatedAt: asset.updatedAt, mimeType: asset.mimeType,
      }] : [];
    });
  }, [allAssets, selectionImageOk, selectedIds]);
  const compareDisabledReason = !selectionImageOk
    ? "materials.compare.reason.mixedSelection"
    : selectedIds.size < 2 ? "materials.compare.reason.tooFew"
    : selectedIds.size > 2 ? "materials.compare.reason.tooMany"
    : null;
  const compareEntryRef = useRef<HTMLButtonElement | null>(null);
  const openCompare = useCallback(() => {
    if (compareDisabledReason !== null) return;
    compareReturnRef.current = { kind: "batch" };
    setCompareSlotIds(compareSelection.map((asset) => asset.id));
  }, [compareDisabledReason, compareSelection]);
  const openSingleCompare = useCallback((asset: Asset, source: "detail" | "context", trigger: HTMLElement | null = null) => {
    // Resolve against the one live material snapshot. Selection and the
    // context-menu render copy cannot silently substitute a different asset.
    const current = allAssets.find((entry) => entry.id === asset.id);
    if (!current || !isImageAsset(current)) {
      setToast(t(current ? "materials.compare.reason.imageOnly" : "materials.status.assetUnavailable"), "error");
      if (source === "context") (trigger?.isConnected ? trigger : masonryContainerRef.current)?.focus({ preventScroll: true });
      return;
    }
    compareReturnRef.current = source === "detail"
      ? { kind: "detail", assetId: current.id, trigger: viewerReturnFocusRef.current }
      : { kind: "context", trigger };
    if (source === "detail") {
      setSelectedAsset(null);
      setPreviewAsset(null);
    }
    setCompareSlotIds([current.id]);
  }, [allAssets, t]);
  const compareAvailableImages = useMemo(
    () => sortedAssets.filter((asset) => isImageAsset(asset)).slice(0, 200).map((asset) => ({
      id: asset.id, name: asset.name, previewUrl: asset.previewUrl, thumbnailUrl: asset.thumbnailUrl, updatedAt: asset.updatedAt, mimeType: asset.mimeType,
    })),
    [sortedAssets],
  );
  // LIVE lookup refreshed against the material snapshot: an external delete
  // flips the slot to "missing" inside the modal instead of a stale render.
  const compareAssetsById = useMemo(() => {
    const map = new Map<string, MaterialCompareSlotAsset>();
    for (const asset of compareAvailableImages) map.set(asset.id, asset);
    for (const asset of compareSelection) map.set(asset.id, asset);
    for (const id of compareSlotIds ?? []) {
      const asset = allAssets.find((entry) => entry.id === id);
      if (asset && isImageAsset(asset)) map.set(id, {
        id: asset.id, name: asset.name, previewUrl: asset.previewUrl,
        thumbnailUrl: asset.thumbnailUrl, updatedAt: asset.updatedAt, mimeType: asset.mimeType,
      });
    }
    return map;
  }, [allAssets, compareAvailableImages, compareSelection, compareSlotIds]);

    useEffect(() => {
    const handleFolderSelect = (event: Event) => {
      if(!acceptsCommand(event))return;
      const detail = (event as CustomEvent<{ scope?: string; folderId?: string | null }>).detail;
      if (detail?.scope !== "materials") return;
      const nextFolderId = detail.folderId ?? null;
      setSelectedFolderId(nextFolderId);
      setFilterFolderId(nextFolderId);
    };
    const handleShellImport = (event: Event) => {
      if(!acceptsCommand(event))return;
      const folderId = (event as CustomEvent<{ folderId?: string | null }>).detail?.folderId;
      void handleImport(folderId);
    };
    const handleToolbarCommand = (event: Event) => {
      if(!acceptsCommand(event))return;
      const command = (event as CustomEvent<MaterialsToolbarCommand>).detail;
      if (!command) return;
      switch (command.type) {
        case "set-search-mode":
          setMaterialSearchMode(command.mode);
          setAppearanceRequest(null);
          break;
        case "set-query":
          setMaterialSearch(command.query.slice(0, 240));
          break;
        case "open-appearance":
          closeMaterialViewer();
          setAppearanceRequest({});
          break;
        case "toggle-appearance":
          closeMaterialViewer();
          setMaterialSearchMode("materials");
          setAppearanceRequest(current => current ? null : {});
          break;
        case "set-view":
          closeMaterialViewer();
          setViewMode(command.viewMode);
          recordWorkViewPresentation(command.viewMode, null);
          break;
        case "set-sort":
          setSortBy(command.sortBy);
          break;
        case "cycle-workview": {
          closeMaterialViewer();
          const current = workViewPrefsRef.current?.active ?? "general";
          const next = MATERIAL_WORK_VIEW_ORDER[(MATERIAL_WORK_VIEW_ORDER.indexOf(current) + 1) % MATERIAL_WORK_VIEW_ORDER.length];
          applyWorkViewPreset(next);
          break;
        }
        case "toggle-filter":
          setFilterOpen((open) => {
            const next = !open;
            if (next) setMissingOpen(false);
            return next;
          });
          break;
        case "clear-filters":
          clearMaterialFilters();
          break;
        case "toggle-missing":
          setMissingOpen((open) => {
            const next = !open;
            if (next) setFilterOpen(false);
            return next;
          });
          break;
        case "toggle-export-tasks":
          setExportPanelOpen((open) => !open);
          break;
        case "close-overlays":
          setFilterOpen(false);
          setMissingOpen(false);
          setExportPanelOpen(false);
          break;
        case "request-state":
          publishMaterialsToolbarState(toolbarState);
          break;
      }
    };
    const handleZoom = (event: Event) => {
      if(!acceptsCommand(event))return;
      const zoom = (event as CustomEvent<{ zoom?: number }>).detail?.zoom;
      if (typeof zoom === "number") {
        applyMaterialZoom(zoom);
        liveZoomRef.current = zoom;
        recordWorkViewPresentation(null, zoom);
      }
    };
    const handleDataChanged = (event: Event) => {
      const source = (event as CustomEvent<{ source?: string }>).detail?.source;
      if (source === "watch") return;
      void revalidateMaterials("materials-watch", { foldersChanged: true });
    };
    const handleFoldersChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ scope?: string; source?: string }>).detail;
      if (detail?.scope && detail.scope !== "materials") return;
      if (detail?.source === "watch") return;
      void revalidateMaterials("materials-folders-event", { foldersChanged: true });
    };
    const handleImportFolder = async () => {
      if(!acceptsCommand())return;
      try {
        setImportProgress({ current: 0, total: 0, label: t("materials.status.folderImporting"), indeterminate: true });
        const result = await importSelectedMaterialFolder();
        if (result) {
          const importedMessage = plural(result.importedCount, { one: "materials.status.folderImported.one", other: "materials.status.folderImported.other" });
          setToast(result.skippedDuplicateCount > 0
            ? `${importedMessage} · ${plural(result.skippedDuplicateCount, { one: "materials.status.skipped.one", other: "materials.status.skipped.other" })}`
            : importedMessage);
          resetMaterialFolderSelection();
          notifyMaterialFoldersChanged();
          await revalidateMaterials("material-folder-import", { foldersChanged: true });
          missingScanCoordinatorRef.current?.schedule("data-change");
        }
      } catch (error) {
        console.warn("[materials] importFolder failed", error);
        setAlertDialog({ message: t("materials.status.folderImportFailed") });
      } finally {
        setImportProgress(null);
      }
    };
    window.addEventListener("luckyray:folder-select", handleFolderSelect);
    window.addEventListener("luckyray:materials-import", handleShellImport);
    window.addEventListener(MATERIALS_TOOLBAR_COMMAND_EVENT, handleToolbarCommand);
    window.addEventListener("luckyray:materials-zoom", handleZoom);
    window.addEventListener("luckyray:materials-import-folder", handleImportFolder);
    window.addEventListener("luckyray:materials-data-changed", handleDataChanged);
    window.addEventListener("luckyray:folders-changed", handleFoldersChanged);
    return () => {
      window.removeEventListener("luckyray:folder-select", handleFolderSelect);
      window.removeEventListener("luckyray:materials-import", handleShellImport);
      window.removeEventListener(MATERIALS_TOOLBAR_COMMAND_EVENT, handleToolbarCommand);
      window.removeEventListener("luckyray:materials-zoom", handleZoom);
      window.removeEventListener("luckyray:materials-import-folder", handleImportFolder);
      window.removeEventListener("luckyray:materials-data-changed", handleDataChanged);
      window.removeEventListener("luckyray:folders-changed", handleFoldersChanged);
    };
  }, [applyWorkViewPreset, clearMaterialFilters, closeMaterialViewer, handleImport, resetMaterialFolderSelection, revalidateMaterials, toolbarState, plural, t]);

  useEffect(() => {
    const handleNativeFolderImport = (event: Event) => {
      if(!acceptsCommand(event))return;
      const detail = (event as CustomEvent<{ paths?: string[]; folderId?: string | null }>).detail;
      if (!Array.isArray(detail?.paths) || detail.paths.length === 0) return;
      void handleDroppedPaths(detail.paths, detail.folderId ?? null);
    };
    window.addEventListener("luckyray:materials-native-folder-import", handleNativeFolderImport);
    return () => window.removeEventListener("luckyray:materials-native-folder-import", handleNativeFolderImport);
  }, [handleDroppedPaths]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let cleanup: (() => void) | null = null;

    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((event) => {
        if (folderTreeDragActiveRef.current) return;
        const payload = event.payload;
        if (payload.type !== "leave") {
          const scale = window.devicePixelRatio || 1;
          const target = document.elementFromPoint(payload.position.x / scale, payload.position.y / scale);
          if (scopeRef.current && (!scopeRef.current.visible || !viewRoot.current?.contains(target))) {
            setIsDraggingFile(false);
            return;
          }
          if (target?.closest("[data-material-appearance-drop]")) { setIsDraggingFile(false); return; }
        }
        const overFolderTree = payload.type !== "leave" && (() => {
          const scale = window.devicePixelRatio || 1;
          const element = document.elementFromPoint(payload.position.x / scale, payload.position.y / scale);
          return Boolean(element?.closest(".shell-folder-tree [data-folder-drop-id]"));
        })();
        const activeMaterialDrag = peekActiveMaterialExternalDrag();
        if (activeMaterialDrag) {
          setIsDraggingFile(false);
          if (payload.type === "drop" && !overFolderTree) consumeActiveMaterialExternalDrag();
          return;
        }
        if (payload.type === "enter" || payload.type === "over") {
          setIsDraggingFile(!overFolderTree);
          return;
        }
        if (payload.type === "leave") {
          setIsDraggingFile(false);
          return;
        }
        if (payload.type === "drop") {
          nativeDropHandledAtRef.current = Date.now();
          setIsDraggingFile(false);
          if (overFolderTree) return;
          void handleDroppedPaths(payload.paths || []);
        }
      }))
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          cleanup = unlisten;
        }
      })
      .catch((error) => {
        console.warn("[materials] native drag-drop listener failed", error);
      });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [handleDroppedPaths]);

  useEffect(() => {
    let depth = 0;
    const isInternalFolderDrag = (event: DragEvent) => folderTreeDragActiveRef.current || isFolderTreeDragEvent(event) || Boolean(peekActiveMaterialExternalDrag());
    const handleFolderTreeDrag = (event: Event) => {
      const active = (event as CustomEvent<{ active?: boolean }>).detail?.active === true;
      folderTreeDragActiveRef.current = active;
      if (active) {
        depth = 0;
        setIsDraggingFile(false);
      }
    };
    const showOverlay = (event: DragEvent) => {
      if(!acceptsDrop(event))return;
      if ((event.target as Element)?.closest?.("[data-material-appearance-drop]")) { setIsDraggingFile(false); return; }
      if (isInternalFolderDrag(event)) {
        depth = 0;
        setIsDraggingFile(false);
        return;
      }
      event.preventDefault();
      depth += 1;
      setIsDraggingFile(true);
    };
    const keepOverlay = (event: DragEvent) => {
      if(!acceptsDrop(event))return;
      if (isInternalFolderDrag(event)) return;
      event.preventDefault();
    };
    const hideOverlay = (event: DragEvent) => {
      if(!acceptsDrop(event))return;
      if (isInternalFolderDrag(event)) {
        depth = 0;
        setIsDraggingFile(false);
        return;
      }
      event.preventDefault();
      depth = Math.max(0, depth - 1);
      if (depth === 0) setIsDraggingFile(false);
    };
    const dropToImport = (event: DragEvent) => {
      if(!acceptsDrop(event))return;
      if ((event.target as Element)?.closest?.("[data-material-appearance-drop]")) { event.preventDefault(); setIsDraggingFile(false); return; }
      if (isInternalFolderDrag(event)) {
        depth = 0;
        setIsDraggingFile(false);
        return;
      }
      event.preventDefault();
      depth = 0;
      setIsDraggingFile(false);
      if (Date.now() - nativeDropHandledAtRef.current < 1000) return;
      const files = event.dataTransfer?.files;
      if (files && files.length > 0) {
        void handleDroppedFiles(files);
      } else {
        setAlertDialog({ message: t("materials.status.noDropPath") });
      }
    };
    window.addEventListener("dragenter", showOverlay);
    window.addEventListener("dragover", keepOverlay);
    window.addEventListener("dragleave", hideOverlay);
    window.addEventListener("drop", dropToImport);
    window.addEventListener("luckyray:folder-tree-drag", handleFolderTreeDrag);
    return () => {
      window.removeEventListener("dragenter", showOverlay);
      window.removeEventListener("dragover", keepOverlay);
      window.removeEventListener("dragleave", hideOverlay);
      window.removeEventListener("drop", dropToImport);
      window.removeEventListener("luckyray:folder-tree-drag", handleFolderTreeDrag);
    };
  }, [handleDroppedFiles, t]);

  // 删除素材
  const handleDeleteAsset = useCallback(async (assetId: string) => {
    const asset = allAssets.find((item) => item.id === assetId) || assets.find((item) => item.id === assetId) || selectedAsset;
    if (!asset) return;
    const deleteRecord = async (deleteFile = false) => {
      try {
        await deleteMaterialAsset(asset.id, { deleteFile }, attachmentCollection ? attachmentVaultId : undefined);
        if (selectedAsset?.id === asset.id) setSelectedAsset(null);
        patchMaterialAssets("material-delete", [asset.id], (current) => current.filter((item) => item.id !== asset.id));
        setToast(deleteFile ? t("materials.status.removedFile") : t("materials.status.removed"));
        void revalidateMaterials("material-delete", { affectedIds: [asset.id] });
        missingScanCoordinatorRef.current?.schedule("data-change", 0);
      } catch {
        setAlertDialog({ message: t("materials.status.deleteFailed") });
      }
    };
    const mode = normalizeStorageMode(asset.storageMode);
    const physicalLabel = mode === "source" ? t("materials.dialog.removeSource") : t("materials.dialog.removeManagedPhysical");

    if (!shouldOfferPhysicalDelete(asset)) {
      openConfirmDialog({
        message: t("materials.dialog.removeQuestion"),
        onConfirm: () => deleteRecord(false),
      });
      return;
    }

    openConfirmDialog({
      message: mode === "source"
        ? t("materials.dialog.removeSourceHint")
        : t("materials.dialog.removeManagedHint"),
      actions: [
        { label: t("materials.dialog.removeOnly"), onClick: () => deleteRecord(false) },
        { label: physicalLabel, kind: "danger", onClick: () => deleteRecord(true) },
      ],
    });
  }, [attachmentCollection, attachmentVaultId, allAssets, assets, openConfirmDialog, patchMaterialAssets, revalidateMaterials, selectedAsset, t]);

  const handleInsertToCurrentNote = useCallback(async (asset: Asset) => {
    if(scopeRef.current){setAlertDialog({message:'工作区插入需要指定同窗口的目标笔记；当前不会写入其他页面的笔记。'});return;}
    try {
      const result = await insertAssetIntoCurrentNote(asset, attachmentCollection ? attachmentVaultId : undefined);
      window.dispatchEvent(new CustomEvent("luckyray:note-external-updated", { detail: { noteId: result.noteId } }));
      setToast(result.position === "cursor" ? t("materials.status.insertedAtCursor") : t("materials.status.insertedAtEnd"));
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      setAlertDialog({ message: t(code === "knowledge-current-context-required" ? "materials.status.noCurrentNote" : "materials.status.insertFailed") });
    }
  }, [t]);

  const handleAskAiWithAssets = useCallback(async (assetsToSend: readonly Asset[]) => {
    if (assetsToSend.length === 0 || askAiBusyRef.current) return;
    askAiBusyRef.current = true;
    let localResources;
    try {
      localResources = await resolveMaterialLightSeekAttachments(assetsToSend, libraryId, attachmentCollection ? attachmentVaultId : undefined);
    } catch {
      setAlertDialog({ message: t("materials.status.fileMissing") });
      askAiBusyRef.current = false;
      return;
    }
    try {
      const intent = openInLightSeek({
        source: attachmentCollection ? "notes" : "materials",
        text: "",
        localResources,
      });
      await waitForOpenInLightSeekIntent(intent.intentId);
      const imageCount = localResources.filter((resource) => resource.delivery === "image-attachment").length;
      setToast(t(imageCount === localResources.length
        ? "materials.status.sentAttachments"
        : imageCount > 0
          ? "materials.status.sentMixed"
          : "materials.status.sentPath"));
    } catch {
      setAlertDialog({
        message: t("materials.status.lightSeekAddFailed"),
      });
    } finally {
      askAiBusyRef.current = false;
    }
  }, [t]);

  const resolveAskAiSelection = useCallback((asset?: Asset | null) => {
    if (asset && !selectedIds.has(asset.id)) return [asset];
    const byId = new Map(allAssets.map((entry) => [entry.id, entry]));
    const selected = Array.from(selectedIds, (id) => byId.get(id)).filter((entry): entry is Asset => Boolean(entry));
    return selected.length > 0 ? selected : asset ? [asset] : [];
  }, [allAssets, selectedIds]);

  const performMaterialPathAction = useCallback(async (asset: Asset, action: "open" | "reveal") => {
    if (missingList.some((item) => item.id === asset.id)) {
      setMissingOpen(true);
      setAlertDialog({ message: t("materials.status.invalidFile") });
      return false;
    }
    const result = await resolveMaterialPathAction({
      assetId: asset.id,
      attempt: () => performMaterialExternalAction(asset.id, action, libraryId, attachmentCollection ? attachmentVaultId : undefined),
      scanMissing: scanMissingMaterialAssets,
    });
    if (result.status === "opened") return true;
    if (!result.scanFailed) {
      setMissingList(result.missingAssets);
      setMissingScanError("");
    } else {
      setMissingScanError(t("materials.status.scanFailed"));
      setMissingOpen(true);
    }
    if (result.status === "missing") {
      setMissingOpen(true);
      setAlertDialog({ message: t("materials.status.invalidFile") });
      return false;
    }
    setAlertDialog({
      message: result.scanFailed
        ? t("materials.status.operationUnknown")
        : action === "open"
        ? t("materials.status.openSystemFailed")
        : t("materials.status.revealSystemFailed"),
    });
    return false;
  }, [missingList, t]);

  const handleOpenAsset = useCallback(async (asset: Asset) => {
    const opened = await performMaterialPathAction(asset, "open");
    if (opened) setToast(t("materials.status.opened"));
  }, [performMaterialPathAction, t]);

  const handleOpenAssetOrDetail = useCallback((asset: Asset) => {
    openDetailViewer(asset);
    setToast(t("materials.status.detailOpened"));
  }, [openDetailViewer, t]);

  const handleRenameAsset = useCallback(async (asset: Asset, name: string) => {
    const nextName = name.trim();
    if (!nextName) return;
    try {
      const updated = await renameMaterialAsset(asset.id, nextName, attachmentCollection ? attachmentVaultId : undefined);
      const nextAsset = { ...asset, ...(updated || {}), name: updated?.name || nextName };
      mergeAssetUpdate(nextAsset);
      setModal(null);
      setToast(t("materials.status.renamed"));
    } catch (error) {
      console.warn("[materials] rename asset failed", error);
      setAlertDialog({ message: t("materials.status.renameFailed") });
    }
  }, [mergeAssetUpdate, t]);

  const openRenameFileModal = useCallback((asset: Asset) => {
    const targetPath = getRealRenameTargetPath(asset);
    if (!canRenameRealAssetFile(asset)) {
      setAlertDialog({ message: t("materials.status.noRenamePath") });
      return;
    }
    setModal({ type: "renameFile", asset, fileName: getFileNameFromPath(targetPath) });
  }, [t]);

  const confirmRenameAssetFile = useCallback((asset: Asset, fileName: string) => {
    const targetPath = getRealRenameTargetPath(asset);
    const nextName = getRealRenamePreviewName(fileName, targetPath);
    if (!targetPath || !nextName) return;
    const currentName = getFileNameFromPath(targetPath);
    const mode = normalizeStorageMode(asset.storageMode);
    openConfirmDialog({
      message: (
        <div className="rename-file-confirm-react">
          <div>{t("materials.dialog.renameFileQuestion")}</div>
          <dl>
            <dt>{t("materials.dialog.management")}</dt>
            <dd>{getStorageModeLabel(mode, t)}</dd>
            <dt>{t("materials.dialog.originalName")}</dt>
            <dd>{currentName}</dd>
            <dt>{t("materials.dialog.newName")}</dt>
            <dd>{nextName}</dd>
            <dt>{t("materials.dialog.location")}</dt>
            <dd>{targetPath}</dd>
          </dl>
        </div>
      ),
      actions: [
        {
          label: t("materials.dialog.renameReal"),
          kind: "primary",
          onClick: async () => {
            try {
              const updated = await renameMaterialAssetFile(asset.id, nextName, attachmentCollection ? attachmentVaultId : undefined);
              if (updated) mergeAssetUpdate({ ...asset, ...updated });
              setModal(null);
              setToast(t("materials.status.realRenamed"));
              // R3 publishes the canonical post-rename version event and Store revalidates once.
            } catch (error) {
              console.warn("[materials] rename real file failed", error);
              setAlertDialog({ message: t("materials.status.realRenameFailed") });
            }
          },
        },
      ],
    });
  }, [mergeAssetUpdate, openConfirmDialog, t]);

  const handleShowInGraph = useCallback((asset: Asset) => {
    if(!scope)publishCurrentAssetContext(assetToActiveAssetContext(asset));
    window.location.hash = "#graph";
  }, []);

  const handleLinkNote = useCallback((asset: Asset) => {
    openDetailViewer(asset);
    setToast(t("materials.status.notesOpened"));
  }, [openDetailViewer, t]);

  const handleCopyAssetInfo = useCallback(async (asset: Asset) => {
    const text = asset.id ? `${asset.name} (${asset.id})` : asset.name;
    try {
      await navigator.clipboard.writeText(text);
      setToast(t("materials.status.copied"));
    } catch {
      setAlertDialog({ message: t("materials.status.copyFailed") });
    }
  }, [t]);

  const pushExportNotice = useCallback((notice: Omit<MaterialExportNotice, "id">) => {
    const id = `export-notice-${++exportNoticeSerialRef.current}`;
    setExportNotices((current) => [...current, { ...notice, id }].slice(-2));
  }, []);

  const recordExportTask = useCallback((task: MaterialExportTask, label?: string) => {
    setExportTasks((current) => upsertMaterialExportTask(current, task,
      new Set([...exportRetryGateRef.current].filter(([, state]) => state === "inflight").map(([id]) => id))));
    if (label) setExportTaskLabels((current) => ({ ...current, [task.taskId]: label }));
  }, []);

  const recordCsvTask = useCallback((task: MaterialCsvExportTask) => {
    setCsvTasks((current) => {
      const next = { ...current, [task.taskId]: task };
      const finished = Object.keys(next).filter((id) => !["preparing", "running", "cancelling"].includes(next[id].phase));
      for (const id of finished.slice(0, Math.max(0, finished.length - 8))) delete next[id];
      return next;
    });
  }, []);

  const beginCsvExport = useCallback(async (request: MaterialCsvExportPlanRequest) => {
    if (csvPlanningGateRef.current || csvSubmissionRef.current || exportSubmissionRef.current || exportPlan || exportPlanning) return;
    csvPlanningGateRef.current = true;
    const nonce = ++csvPlanNonceRef.current;
    if (csvPlan) void discardMaterialCsvExportPlan(csvPlan.planId);
    setCsvPlan(null);
    setCsvDescription(false);
    setCsvError("");
    setCsvPlanning(true);
    try {
      const plan = await planMaterialCsvExport(request,libraryId);
      if (nonce !== csvPlanNonceRef.current) { await discardMaterialCsvExportPlan(plan.planId); return; }
      setCsvPlan(plan);
    } catch (error) {
      if (nonce === csvPlanNonceRef.current) {
        setCsvError(String(error));
        pushExportNotice({ taskId: null, message: String(error), tone: "error", action: null });
      }
    } finally { csvPlanningGateRef.current = false; if (nonce === csvPlanNonceRef.current) setCsvPlanning(false); }
  }, [csvPlan, exportPlan, exportPlanning, pushExportNotice]);

  const dismissCsvPlan = useCallback(() => {
    if (csvSubmissionRef.current) return;
    ++csvPlanNonceRef.current;
    if (csvPlan) void discardMaterialCsvExportPlan(csvPlan.planId);
    setCsvPlan(null); setCsvPlanning(false); setCsvError("");
  }, [csvPlan]);

  const confirmCsvExport = useCallback(async () => {
    if (!csvPlan || csvSubmissionRef.current) return;
    const plan = csvPlan;
    csvSubmissionRef.current = plan.planId;
    setCsvBusy("choosing"); setCsvError("");
    try {
      const destination = await chooseMaterialCsvDestination();
      if (!destination) return; // Native save dialog cancellation performs no write.
      setCsvBusy("starting");
      const watchRoots = readMaterialWatchSources(libraryId).filter((source) => source.enabled).map((source) => source.path);
      recordCsvTask(await startMaterialCsvExport(plan.planId, destination, csvDescription, watchRoots));
      setCsvPlan(null);
    } catch (error) { setCsvError(String(error)); }
    finally {
      if (csvSubmissionRef.current === plan.planId) { csvSubmissionRef.current = null; setCsvBusy("idle"); }
    }
  }, [csvPlan, csvDescription, recordCsvTask]);

  const csvRunningIds = Object.values(csvTasks)
    .filter((task) => ["preparing", "running", "cancelling"].includes(task.phase))
    .map((task) => task.taskId).sort().join("|");
  useEffect(() => {
    if (!csvRunningIds) return;
    let active = true;
    let timer = 0;
    const ids = csvRunningIds.split("|");
    const poll = async () => {
      await Promise.all(ids.map(async (id) => {
        try { const status = await getMaterialCsvExportTask(id); if (active) recordCsvTask(status); }
        catch (error) { if (active) {
          // A transient status-query failure does not mean the writer failed.
          // Keep polling and leave cancellation available; only the worker's
          // own terminal status may mark the export failed.
          setCsvTasks((current) => current[id] ? { ...current, [id]: { ...current[id], error: String(error) } } : current);
        } }
      }));
      if (active) timer = window.setTimeout(() => void poll(), 400);
    };
    timer = window.setTimeout(() => void poll(), 200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [csvRunningIds, recordCsvTask]);

  useEffect(() => {
    for (const task of Object.values(csvTasks)) {
      if (["preparing", "running", "cancelling"].includes(task.phase) || csvNotifiedRef.current.has(task.taskId)) continue;
      csvNotifiedRef.current.add(task.taskId);
      if (csvNotifiedRef.current.size > 32) csvNotifiedRef.current.delete(csvNotifiedRef.current.values().next().value!);
      pushExportNotice({ taskId: null,
        message: task.phase === "completed" ? t("materials.csv.success", { count: task.total })
          : task.phase === "cancelled" ? t("materials.csv.cancelled") : t("materials.csv.failed"),
        tone: task.phase === "failed" ? "error" : task.phase === "completed" ? "success" : "neutral",
        action: "records" });
    }
  }, [csvTasks, pushExportNotice, t]);

  const cancelCsvTask = useCallback(async (id: string) => {
    try { recordCsvTask(await cancelMaterialCsvExport(id)); }
    catch (error) { setCsvTasks((current) => current[id] ? { ...current, [id]: { ...current[id], error: String(error) } } : current); }
  }, [recordCsvTask]);
  const retryCsvTask = useCallback(async (id: string) => {
    if (csvRetryGateRef.current.has(id)) return;
    csvRetryGateRef.current.add(id); setCsvRetrying(id);
    try {
      const watchRoots = readMaterialWatchSources(libraryId).filter((source) => source.enabled).map((source) => source.path);
      const child = await retryMaterialCsvExport(id, watchRoots);
      setCsvTasks((current) => { const next = { ...current }; delete next[id]; next[child.taskId] = child; return next; });
      csvRetryGateRef.current.delete(id);
    } catch (error) {
      setCsvTasks((current) => current[id] ? { ...current, [id]: { ...current[id], error: String(error) } } : current);
      csvRetryGateRef.current.delete(id);
    } finally { setCsvRetrying(null); }
  }, []);
  const dismissCsvTask = useCallback((id: string) => {
    if (csvRetryGateRef.current.has(id)) return;
    setCsvTasks((current) => { const next = { ...current }; delete next[id]; return next; });
  }, []);

  // UI summaries are process-local and bounded. Keep auxiliary details on the
  // same lifecycle as their visible task, including after automatic eviction.
  useEffect(() => {
    const ids = new Set(Object.keys(exportTasks));
    const prune = <T,>(current: Record<string, T>) => {
      const stale = Object.keys(current).filter((id) => !ids.has(id));
      if (!stale.length) return current;
      const next = { ...current };
      for (const id of stale) delete next[id];
      return next;
    };
    setExportTaskLabels(prune);
    setExportTaskProblems(prune);
    setExportActionErrors(prune);
    setExportRetryErrors(prune);
    setExportRetryState(prune);
    setExportRetryChildIds(prune);
    for (const id of exportRetryGateRef.current.keys()) {
      if (!ids.has(id)) exportRetryGateRef.current.delete(id);
    }
  }, [exportTasks]);

  const beginMaterialExport = useCallback(async (request: MaterialExportPlanRequest) => {
    if (exportSubmissionRef.current || csvSubmissionRef.current || csvPlan || csvPlanning) return;
    const nonce = ++exportPlanNonceRef.current;
    if (exportPlan) void discardMaterialExportPlan(exportPlan.planId);
    setExportPlan(null);
    setExportError("");
    setExportPreserveHierarchy(request.kind === "folder");
    setExportPlanning(true);
    try {
      const plan = await planMaterialExport(request,libraryId);
      if (nonce !== exportPlanNonceRef.current) {
        await discardMaterialExportPlan(plan.planId);
        return;
      }
      setExportPlan(plan);
    } catch (error) {
      if (nonce === exportPlanNonceRef.current) {
        setExportError(String(error));
        pushExportNotice({ taskId: null, message: String(error), tone: "error", action: null });
      }
    } finally {
      if (nonce === exportPlanNonceRef.current) setExportPlanning(false);
    }
  }, [exportPlan, csvPlan, csvPlanning, pushExportNotice]);

  // Knowledge attachments keep their pre-existing one-file export path; the
  // new ordinary-material planner deliberately has no attachment authority.
  const exportAttachmentAsBefore = useCallback(async (asset: Asset) => {
    try {
      const path = await exportMaterialAssetFile(asset, attachmentVaultId);
      setToast(t("materials.status.exported", { path }));
    } catch (error) {
      console.warn("[materials] export attachment failed", error);
      setAlertDialog({ message: t("materials.status.exportFailed") });
    }
  }, [t]);

  const dismissMaterialExportPlan = useCallback(() => {
    if (exportSubmissionRef.current) return;
    ++exportPlanNonceRef.current;
    if (exportPlan) void discardMaterialExportPlan(exportPlan.planId);
    setExportPlan(null);
    setExportPlanning(false);
    setExportError("");
  }, [exportPlan]);

  const confirmMaterialExport = useCallback(async () => {
    if (!exportPlan || exportSubmissionRef.current) return;
    const boundPlan = exportPlan;
    exportSubmissionRef.current = boundPlan.planId;
    setExportSubmissionPhase("choosing");
    setExportError("");
    try {
      const destination = await chooseMaterialExportDirectory();
      if (!destination) return; // Directory dialog cancellation never starts a copy.
      setExportSubmissionPhase("starting");
      const watchRoots = readMaterialWatchSources(libraryId).filter((source) => source.enabled).map((source) => source.path);
      const task = await startMaterialExport(boundPlan.planId, destination, exportPreserveHierarchy, watchRoots);
      recordExportTask(task, boundPlan.scopeLabel);
      if (exportSubmissionRef.current === boundPlan.planId) {
        setExportPlan(null);
        setExportError("");
      }
    } catch (error) {
      if (exportSubmissionRef.current === boundPlan.planId) setExportError(String(error));
    } finally {
      if (exportSubmissionRef.current === boundPlan.planId) {
        exportSubmissionRef.current = null;
        setExportSubmissionPhase("idle");
      }
    }
  }, [exportPlan, exportPreserveHierarchy, recordExportTask]);

  const retryMaterialExportFailures = useCallback(async (task: MaterialExportTask) => {
    if (exportRetryGateRef.current.has(task.taskId)) return;
    const failedIds = task.items.filter((item) => item.state === "failed").map((item) => item.assetId);
    if (!failedIds.length) return;
    exportRetryGateRef.current.set(task.taskId, "inflight");
    setExportRetryState((current) => ({ ...current, [task.taskId]: "inflight" }));
    setExportRetryErrors((current) => {
      const next = { ...current };
      delete next[task.taskId];
      return next;
    });
    let plan: MaterialExportPlan | null = null;
    try {
      plan = await planMaterialExport({ kind: "assets", assetIds: failedIds },libraryId);
      const watchRoots = readMaterialWatchSources(libraryId).filter((source) => source.enabled).map((source) => source.path);
      const retry = await startMaterialExport(plan.planId, task.destination, task.preserveHierarchy, watchRoots);
      exportRetryGateRef.current.set(task.taskId, retry.taskId);
      setExportRetryState((current) => ({ ...current, [task.taskId]: "continued" }));
      setExportRetryChildIds((current) => ({ ...current, [task.taskId]: retry.taskId }));
      recordExportTask(retry, t("materials.export.retriedScope", { count: failedIds.length }));
    } catch (error) {
      if (plan) {
        try { await discardMaterialExportPlan(plan.planId); }
        catch (discardError) { console.warn("[materials] discard failed export retry plan", discardError); }
      }
      exportRetryGateRef.current.delete(task.taskId);
      setExportRetryState((current) => {
        const next = { ...current };
        delete next[task.taskId];
        return next;
      });
      setExportRetryErrors((current) => ({ ...current, [task.taskId]: String(error) }));
    }
  }, [recordExportTask, t]);

  useEffect(() => {
    if (attachmentCollection) return;
    const handleFolderExport = (event: Event) => {
      if (!acceptsCommand(event)) return;
      const folderId = (event as CustomEvent<{ folderId?: string | null }>).detail?.folderId ?? null;
      void beginMaterialExport({ kind: "folder", folderId });
    };
    window.addEventListener("luckyray:materials-export-folder", handleFolderExport);
    return () => window.removeEventListener("luckyray:materials-export-folder", handleFolderExport);
  }, [attachmentCollection, beginMaterialExport]);

  useEffect(() => {
    if (attachmentCollection) return;
    const handleFolderCsv = (event: Event) => {
      if (!acceptsCommand(event)) return;
      const folderId = (event as CustomEvent<{ folderId?: unknown }>).detail?.folderId;
      if (typeof folderId !== "string" || !folderId || !findFolderNode(folders, folderId)) {
        setToast(t("materials.status.folderMissing"), "error");
        return;
      }
      void beginCsvExport({ kind: "folder", folderId });
    };
    window.addEventListener("luckyray:materials-export-folder-csv", handleFolderCsv);
    return () => window.removeEventListener("luckyray:materials-export-folder-csv", handleFolderCsv);
  }, [attachmentCollection, beginCsvExport, folders, setToast, t]);

  const exportRunningIds = Object.values(exportTasks)
    .filter((task) => isMaterialExportRunning(task) && !exportTaskProblems[task.taskId]?.stopped)
    .map((task) => task.taskId).sort().join("|");
  useEffect(() => {
    if (!exportRunningIds) return;
    let active = true;
    let timer = 0;
    const ids = exportRunningIds.split("|");
    const poll = async () => {
      await Promise.all(ids.map(async (id) => {
        try {
          const current = await getMaterialExportTask(id);
          if (active) {
            setExportTasks((tasks) => upsertMaterialExportTask(tasks, current,
              new Set([...exportRetryGateRef.current].filter(([, state]) => state === "inflight").map(([id]) => id))));
            setExportTaskProblems((problems) => {
              if (!problems[id]) return problems;
              const next = { ...problems };
              delete next[id];
              return next;
            });
          }
        } catch (error) {
          if (active) setExportTaskProblems((problems) => {
            const failures = (problems[id]?.failures ?? 0) + 1;
            const expired = isMaterialExportSummaryExpired(error);
            return { ...problems, [id]: { message: String(error), failures,
              stopped: expired || failures >= 3, expired } };
          });
        }
      }));
      if (active) timer = window.setTimeout(() => void poll(), 400);
    };
    timer = window.setTimeout(() => void poll(), 200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [exportRunningIds]);

  useEffect(() => {
    for (const task of Object.values(exportTasks)) {
      if (isMaterialExportRunning(task) || exportNotifiedRef.current.has(task.taskId)) continue;
      exportNotifiedRef.current.add(task.taskId);
      if (exportNotifiedRef.current.size > 64) {
        const oldest = exportNotifiedRef.current.values().next().value;
        if (oldest) exportNotifiedRef.current.delete(oldest);
      }
      const values = { success: task.succeeded, failed: task.failed, cancelled: task.cancelled };
      const cancelled = task.phase === "cancelled" || task.cancelled > 0;
      pushExportNotice({ taskId: task.taskId,
        message: cancelled ? t("materials.export.resultCancelled", values)
          : task.failed > 0 ? t("materials.export.resultPartial", values)
            : t("materials.export.resultSuccess", { count: task.succeeded }),
        tone: task.failed > 0 ? "error" : cancelled ? "neutral" : "success",
        action: task.failed > 0 || cancelled ? "records" : "open" });
    }
  }, [exportTasks, pushExportNotice, t]);

  const closeExportPanel = useCallback(() => setExportPanelOpen(false), []);
  const openExportPanel = useCallback(() => setExportPanelOpen(true), []);
  const cancelExportTask = useCallback(async (taskId: string) => {
    try {
      const task = await cancelMaterialExport(taskId);
      recordExportTask(task);
      setExportActionErrors((current) => { const next = { ...current }; delete next[taskId]; return next; });
    } catch (error) {
      setExportActionErrors((current) => ({ ...current, [taskId]: String(error) }));
      setExportPanelOpen(true);
    }
  }, [recordExportTask]);
  const openExportDestination = useCallback(async (taskId: string) => {
    try {
      await openMaterialExportDestination(taskId);
      setExportActionErrors((current) => { const next = { ...current }; delete next[taskId]; return next; });
    } catch (error) {
      setExportActionErrors((current) => ({ ...current, [taskId]: String(error) }));
      setExportPanelOpen(true);
    }
  }, []);
  const copyExportDestination = useCallback(async (taskId: string, path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setExportActionErrors((current) => { const next = { ...current }; delete next[taskId]; return next; });
    } catch (error) {
      setExportActionErrors((current) => ({ ...current, [taskId]: String(error) }));
    }
  }, []);
  const refreshExportTask = useCallback(async (taskId: string) => {
    setExportTaskProblems((current) => { const next = { ...current }; delete next[taskId]; return next; });
    try {
      recordExportTask(await getMaterialExportTask(taskId));
    } catch (error) {
      const expired = isMaterialExportSummaryExpired(error);
      setExportTaskProblems((current) => ({ ...current, [taskId]: {
        message: String(error), failures: 1, stopped: expired, expired,
      } }));
    }
  }, [recordExportTask]);
  const dismissExportTask = useCallback((taskId: string) => {
    // A retry still creating its child must retain the parent and its gate.
    if (exportRetryGateRef.current.get(taskId) === "inflight") return;
    setExportTasks((current) => { const next = { ...current }; delete next[taskId]; return next; });
    setExportTaskLabels((current) => { const next = { ...current }; delete next[taskId]; return next; });
    setExportTaskProblems((current) => { const next = { ...current }; delete next[taskId]; return next; });
    setExportActionErrors((current) => { const next = { ...current }; delete next[taskId]; return next; });
    setExportRetryErrors((current) => { const next = { ...current }; delete next[taskId]; return next; });
    setExportRetryState((current) => { const next = { ...current }; delete next[taskId]; return next; });
    setExportRetryChildIds((current) => { const next = { ...current }; delete next[taskId]; return next; });
    exportRetryGateRef.current.delete(taskId);
  }, []);
  const clearCompletedExportTasks = useCallback(() => {
    const clearIds = new Set(Object.values(exportTasks)
      .filter((task) => !isMaterialExportRunning(task)
        && exportRetryGateRef.current.get(task.taskId) !== "inflight")
      .map((task) => task.taskId));
    if (!clearIds.size && !Object.values(csvTasks).some((task) =>
      !["preparing", "running", "cancelling"].includes(task.phase))) return;
    const keep = <T,>(current: Record<string, T>) => Object.fromEntries(
      Object.entries(current).filter(([id]) => !clearIds.has(id)));
    setExportTasks((current) => keep(current));
    setExportTaskLabels((current) => keep(current));
    setExportTaskProblems((current) => keep(current));
    setExportActionErrors((current) => keep(current));
    setExportRetryErrors((current) => keep(current));
    setExportRetryState((current) => keep(current));
    setExportRetryChildIds((current) => keep(current));
    for (const id of clearIds) exportRetryGateRef.current.delete(id);
    setCsvTasks((current) => Object.fromEntries(Object.entries(current)
      .filter(([, task]) => ["preparing", "running", "cancelling"].includes(task.phase))));
  }, [exportTasks, csvTasks]);

  const handleContextMenu = useCallback((event: MouseEvent, asset: Asset) => {
    event.preventDefault();
    event.stopPropagation();
    const session = contextActionAuthorityRef.current.begin(asset);
    setContextMenu({
      ...session,
      x: event.clientX,
      y: event.clientY,
      trigger: event.currentTarget instanceof HTMLElement ? event.currentTarget : null,
    });
  }, []);

  const handleRevealAssetFolder = useCallback((asset: Asset) => {
    folderRevealNonceRef.current += 1;
    const currentSnapshot = materialStore.getSnapshot();
    const currentAssets = mergeAssetLists(currentSnapshot.allAssets as Asset[], currentSnapshot.assets as Asset[]);
    const resolution = resolveCurrentMaterialFolderReveal(
      currentAssets,
      currentSnapshot.folders,
      asset.id,
      folderRevealNonceRef.current,
    );
    if (!resolution) {
      setToast(t("materials.status.assetUnavailable"), "error");
      return;
    }
    const { asset: currentAsset, request: revealRequest } = resolution;
    if (revealRequest.status === "missing") {
      setToast(t("materials.status.folderMissing"), "error");
      return;
    }
    const targetFolderId = revealRequest.folderId;
    materialNavigationCoordinator.requestAssetFocus({
      assetId: currentAsset.id,
      source: "materials-folder-reveal",
    });
    setFilterKinds([]);
    setFilterTagIds([]);
    setFilterRecent(false);
    setFilterStorageMode("all");
    setFilterColor(null);
    setFilterDateFrom("");
    setFilterDateTo("");
    setFilterRatingMin(null);
    setFilterFolderId(targetFolderId);
    setSelectedFolderId(targetFolderId);
    setSelectedIds(new Set());
    materialStore.optimistic({
      reason: "material-folder-reveal",
      affectedIds: [currentAsset.id],
      update: (snapshot) => ({
        assets: mergeAssetLists([currentAsset], snapshot.assets as Asset[]),
        allAssets: mergeAssetLists([currentAsset], snapshot.allAssets as Asset[]),
        folders: snapshot.folders,
      }),
    });
    window.dispatchEvent(new CustomEvent("luckyray:folder-reveal", {
      detail: { scope: "materials", ...revealRequest },
    }));
    setToast(targetFolderId ? t("materials.status.folderLocated") : t("materials.status.allLocated"));
  }, [t]);

  const toggleSelected = useCallback((assetId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const selectAllVisible = useCallback(() => {
    setSelectedIds(new Set(sortedAssets.map((asset) => asset.id)));
  }, [sortedAssets]);

  const invertVisibleSelection = useCallback(() => {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const asset of sortedAssets) {
        if (next.has(asset.id)) next.delete(asset.id);
        else next.add(asset.id);
      }
      return next;
    });
  }, [sortedAssets]);

  const openMoveModal = useCallback((assetIds: string[]) => {
    void reloadFolders();
    setModal({ type: "move", assetIds });
    setContextMenu(null);
  }, [reloadFolders]);

  const openTagsModal = useCallback(async (assetIds: string[]) => {
    setModal({ type: "tags", assetIds });
    setContextMenu(null);
    try {
      const context = await getMaterialAssetTagContext(assetIds, attachmentCollection ? attachmentVaultId : undefined);
      setTags(context.tags);
      setTagSelection(new Set(context.selectedTagIds));
    } catch {
      setTags([]);
      setTagSelection(new Set());
    }
    setNewTagName("");
  }, []);

  const handleMoveAssets = useCallback(async (assetIds: string[], folderId: string | null) => {
    const updatedAt = new Date().toISOString();
    patchMaterialAssets("material-move", assetIds, (current) => current.map((asset) => (
      assetIds.includes(asset.id) ? { ...asset, folderId, updatedAt } : asset
    )));
    if (selectedAsset && assetIds.includes(selectedAsset.id)) {
      setSelectedAsset((asset) => asset ? { ...asset, folderId, updatedAt } : asset);
    }
    setModal(null);
    setSelectedIds(new Set());
    const results = await moveMaterialAssetsToFolder(assetIds, folderId);
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed > 0) setAlertDialog({ message: plural(failed, { one: "materials.status.moveFailed.one", other: "materials.status.moveFailed.other" }) });
    void revalidateMaterials("material-move", { affectedIds: assetIds });
  }, [patchMaterialAssets, revalidateMaterials, selectedAsset, plural]);

  const handleApplyTags = useCallback(async (assetIds: string[]) => {
    const nextTags = Array.from(tagSelection);
    const results = await applyMaterialAssetTags(assetIds, nextTags, attachmentCollection ? attachmentVaultId : undefined);
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed > 0) setAlertDialog({ message: plural(failed, { one: "materials.status.tagsFailed.one", other: "materials.status.tagsFailed.other" }) });
    setModal(null);
    setSelectedIds(new Set());
    void revalidateMaterials("material-tags", { affectedIds: assetIds });
  }, [tagSelection, revalidateMaterials, plural]);

  const handleCreateTag = useCallback(async () => {
    const name = newTagName.trim();
    if (!name) return;
    try {
      const tag = await createMaterialTag(name, attachmentCollection ? attachmentVaultId : undefined);
      setTags((current) => [...current, tag]);
      setTagSelection((current) => new Set([...current, tag.id]));
      setNewTagName("");
    } catch {
      setAlertDialog({ message: t("materials.status.createTagFailed") });
    }
  }, [newTagName, t]);

  const handleDeleteMany = useCallback((assetIds: string[]) => {
    if (assetIds.length === 0) return;
    const selectedAssets = assetIds
      .map((assetId) => allAssets.find((asset) => asset.id === assetId) || assets.find((asset) => asset.id === assetId))
      .filter((asset): asset is Asset => Boolean(asset));
    const canDeleteFiles = selectedAssets.some(shouldOfferPhysicalDelete);
    const runDelete = async (deleteFile = false) => {
      const results = await Promise.allSettled(selectedAssets.map((asset) => deleteMaterialAsset(asset.id, { deleteFile: deleteFile && shouldOfferPhysicalDelete(asset) }, attachmentCollection ? attachmentVaultId : undefined)));
      const failed = results.filter((result) => result.status === "rejected").length;
      const deletedIds = selectedAssets
        .filter((_, index) => results[index]?.status === "fulfilled")
        .map((asset) => asset.id);
      if (deletedIds.length > 0) {
        patchMaterialAssets("material-batch-delete", deletedIds, (current) => current.filter((asset) => !deletedIds.includes(asset.id)));
      }
      if (failed > 0) setAlertDialog({ message: plural(failed, { one: "materials.status.batchDeleteFailed.one", other: "materials.status.batchDeleteFailed.other" }) });
      else setToast(deleteFile ? t("materials.status.batchRemovedFiles") : t("materials.status.batchRemoved"));
      setSelectedIds(new Set());
      if (selectedAsset && deletedIds.includes(selectedAsset.id)) setSelectedAsset(null);
      void revalidateMaterials("material-batch-delete", { affectedIds: deletedIds });
      missingScanCoordinatorRef.current?.schedule("data-change", 0);
    };

    openConfirmDialog({
      message: canDeleteFiles
        ? plural(selectedAssets.length, { one: "materials.dialog.batchPhysical.one", other: "materials.dialog.batchPhysical.other" })
        : plural(selectedAssets.length, { one: "materials.dialog.batchRecord.one", other: "materials.dialog.batchRecord.other" }),
      actions: canDeleteFiles
        ? [
            { label: t("materials.dialog.removeOnly"), onClick: () => runDelete(false) },
            { label: t("materials.dialog.removeManaged"), kind: "danger", onClick: () => runDelete(true) },
          ]
        : undefined,
      onConfirm: canDeleteFiles ? undefined : () => runDelete(false),
    });
  }, [attachmentCollection, attachmentVaultId, allAssets, assets, openConfirmDialog, patchMaterialAssets, revalidateMaterials, selectedAsset, plural, t]);

  useEffect(() => {
    const getShortcutCandidate = () => {
      const hoveredAsset = hoveredAssetId ? sortedAssets.find((asset) => asset.id === hoveredAssetId) : null;
      return hoveredAsset ?? sortedAssets.find((asset) => selectedIds.has(asset.id)) ?? selectedAsset ?? sortedAssets[0];
    };
    const toggleInspector = () => {
      const candidate = getShortcutCandidate();
      if (viewerAsset) closeMaterialViewer();
      else if (candidate) openDetailViewer(candidate);
    };
    const handleMaterialShortcuts = (event: KeyboardEvent) => {
      if(!acceptsCommand(event))return;
      if (document.querySelector(".material-film")) return;
      if (compareOpenRef.current) {
        const compareShortcutKey = event.key.toLowerCase();
        if (event.key === "Delete" || event.key === "#" || ((event.ctrlKey || event.metaKey) && ["a", "i", "f"].includes(compareShortcutKey))) {
          event.preventDefault();
        }
        return;
      }
      if (confirmDialogRef.current) {
        const shortcutKey = event.key.toLowerCase();
        if (
          ((event.ctrlKey || event.metaKey) && ["a", "i", "f"].includes(shortcutKey))
          || event.key === "Delete"
          || event.key === "#"
        ) {
          event.preventDefault();
        }
        return;
      }
      const command = resolveScopedShortcut(event, "materials", undefined, {
        ids: [
          "materialsQuickPreview",
          "materialsSelectAll",
          "materialsImport",
          "materialsToggleFilter",
          "materialsOpen",
          "materialsDelete",
          "materialsTag",
        ],
      });

      if (viewerAsset) {
        if (command === "materialsQuickPreview") {
          event.preventDefault();
          if (viewerMode === "detail") openPreviewViewer(viewerAsset);
          else closeMaterialViewer();
        } else if (event.key === "Escape") {
          closeMaterialViewer();
        }
        return;
      }

      const candidate = getShortcutCandidate();

      if (command === "materialsSelectAll") {
        event.preventDefault();
        setSelectedIds(new Set(sortedAssets.map((asset) => asset.id)));
        return;
      }

      if (command === "materialsImport") {
        event.preventDefault();
        void handleImport();
        return;
      }

      if (command === "materialsToggleFilter") {
        event.preventDefault();
        setFilterOpen((value) => {
          const next = !value;
          if (next) setMissingOpen(false);
          return next;
        });
        return;
      }

      if (command === "materialsOpen" && candidate) {
        event.preventDefault();
        void handleOpenAsset(candidate);
        return;
      }

      if (command === "materialsDelete" && selectedIds.size > 0) {
        event.preventDefault();
        handleDeleteMany(Array.from(selectedIds));
        return;
      }

      if (command === "materialsQuickPreview") {
        if (candidate) {
          event.preventDefault();
          openPreviewViewer(candidate);
        }
        return;
      }

      if (command === "materialsTag" && selectedIds.size > 0) {
        event.preventDefault();
        void openTagsModal(Array.from(selectedIds));
        return;
      }

      if (event.key === "Escape") {
        if (selectedIds.size > 0) setSelectedIds(new Set());
      }
    };
    const handleToggleDetail = () => {
      if(!acceptsCommand())return;
      if (confirmDialogRef.current) return;
      toggleInspector();
    };
    window.addEventListener("keydown", handleMaterialShortcuts);
    window.addEventListener("luckyray:materials-toggle-detail", handleToggleDetail);
    return () => {
      window.removeEventListener("keydown", handleMaterialShortcuts);
      window.removeEventListener("luckyray:materials-toggle-detail", handleToggleDetail);
    };
  }, [closeMaterialViewer, handleDeleteMany, handleImport, handleOpenAsset, hoveredAssetId, openDetailViewer, openPreviewViewer, openTagsModal, selectedAsset, selectedIds, sortedAssets, viewerAsset, viewerMode]);

  // D110: 失效素材扫描
  const handleScanMissing = useCallback(async () => {
    if (!materialsPageMountedRef.current) return;
    setMissingLoading(true);
    setMissingScanError("");
    const coordinator = missingScanCoordinatorRef.current;
    if (coordinator) {
      await coordinator.scanNow();
      if (materialsPageMountedRef.current) setMissingLoading(false);
      return;
    }
    try {
      const result = await scanMissingMaterialAssets();
      if (materialsPageMountedRef.current) setMissingList(result);
    } catch {
      if (materialsPageMountedRef.current) {
        setMissingScanError(t("materials.status.missingScanFailed"));
      }
    }
    if (materialsPageMountedRef.current) setMissingLoading(false);
  }, [t]);

  const performRemoveMissing = useCallback(async (id: string) => {
    try {
      await removeMissingMaterialAssetRecord(id);
      setMissingList((list) => list.filter((item) => item.id !== id));
      void revalidateMaterials("material-remove-missing", { affectedIds: [id] });
      missingScanCoordinatorRef.current?.schedule("data-change", 0);
      setToast(t("materials.status.missingRemoved"));
    } catch {
      setAlertDialog({
        message: t("materials.status.missingRemoveFailed"),
      });
    }
  }, [revalidateMaterials, t]);

  const handleRemoveMissing = useCallback((item: MaterialMissingItem) => {
    openConfirmDialog({
      message: t("materials.dialog.missingRecord", { name: item.name }),
      actions: [{
        label: t("materials.missing.remove"),
        kind: "danger",
        onClick: () => { void performRemoveMissing(item.id); },
      }],
    });
  }, [openConfirmDialog, performRemoveMissing, t]);

  const settleSourceRelocateConfirmation = useCallback((confirmed: boolean) => {
    const resolve = sourceRelocateConfirmationRef.current;
    sourceRelocateConfirmationRef.current = null;
    resolve?.(confirmed);
  }, []);

  const requestSourceRelocateConfirmation = useCallback((_actualContentHash: string) => {
    if (!materialsPageMountedRef.current) return Promise.resolve(false);
    settleSourceRelocateConfirmation(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settleCurrentConfirmation = (confirmed: boolean) => {
        if (settled) return;
        settled = true;
        if (sourceRelocateConfirmationRef.current === settleCurrentConfirmation) {
          sourceRelocateConfirmationRef.current = null;
        }
        resolve(confirmed);
      };
      sourceRelocateConfirmationRef.current = settleCurrentConfirmation;
      openConfirmDialog({
        message: t("materials.status.relocateMismatch"),
        onCancel: () => settleCurrentConfirmation(false),
        actions: [{
          label: t("materials.dialog.relocateAnyway"),
          kind: "danger",
          onClick: () => settleCurrentConfirmation(true),
        }],
      });
    });
  }, [openConfirmDialog, settleSourceRelocateConfirmation, t]);

  const handleMaterialRelocation = useCallback(async (assetId: string) => {
    if (!materialsPageMountedRef.current) return "cancelled" as const;
    if (missingRelocatingIdsRef.current.has(assetId)) return "busy" as const;
    missingRelocatingIdsRef.current.add(assetId);
    setMissingRelocatingIds((current) => new Set(current).add(assetId));
    const outcome = await runMaterialRelocationWithConfirmation({
      assetId,
      selectPath: selectMaterialRelocationPath,
      relocate: (id, path, options) => relocateMaterialAsset(id, path, options, attachmentCollection ? attachmentVaultId : undefined),
      confirmSourceContentChange: requestSourceRelocateConfirmation,
    });
    missingRelocatingIdsRef.current.delete(assetId);
    if (!materialsPageMountedRef.current) return "cancelled" as const;
    setMissingRelocatingIds((current) => {
      const next = new Set(current);
      next.delete(assetId);
      return next;
    });
    if (outcome.status === "cancelled") return "cancelled" as const;
    if (outcome.status === "failed") {
      setAlertDialog({
        message: t("materials.status.relocateFailed"),
      });
      return "failed" as const;
    }
    mergeAssetUpdate(outcome.asset as Asset);
    setMissingList((current) => current.filter((candidate) => candidate.id !== assetId));
    missingScanCoordinatorRef.current?.schedule("data-change", 0);
    setToast(t("materials.status.relocated"));
    return "succeeded" as const;
  }, [attachmentCollection, attachmentVaultId, mergeAssetUpdate, requestSourceRelocateConfirmation, t]);

  const handleRelocateMissing = useCallback((item: MaterialMissingItem) => {
    void handleMaterialRelocation(item.id);
  }, [handleMaterialRelocation]);

  useEffect(() => {
    materialsPageMountedRef.current = true;
    const coordinator = createMaterialMissingScanCoordinator<MaterialMissingItem>({
      scan: scanMissingMaterialAssets,
      onResult: (result) => {
        if (!materialsPageMountedRef.current) return;
        setMissingList(result);
        setMissingScanError("");
      },
      onError: () => {
        if (!materialsPageMountedRef.current) return;
        setMissingScanError(t("materials.status.missingScanFailed"));
      },
    });
    missingScanCoordinatorRef.current = coordinator;
    const detach = attachMaterialMissingScanTriggers({
      windowTarget: window,
      documentTarget: document,
      getVisibilityState: () => document.visibilityState,
      schedule: (reason) => coordinator.schedule(reason, reason === "initial" ? 0 : undefined),
    });
    return () => {
      materialsPageMountedRef.current = false;
      closeCurrentConfirmDialog(confirmDialogRef, () => {}, "cancel");
      settleSourceRelocateConfirmation(false);
      detach();
      coordinator.dispose();
      missingScanCoordinatorRef.current = null;
      notifyMaterialMissingCount((count) => {
        window.dispatchEvent(new CustomEvent("luckyray:materials-missing-count", { detail: { count } }));
      }, 0);
    };
  }, [settleSourceRelocateConfirmation, t]);

  useEffect(() => {
    if (missingOpen) missingScanCoordinatorRef.current?.schedule("manual", 0);
  }, [missingOpen]);

  // D110: 失效数量通知给 titlebar
  useEffect(() => {
    notifyMaterialMissingCount((count) => {
      window.dispatchEvent(new CustomEvent("luckyray:materials-missing-count", { detail: { count } }));
    }, missingList.length);
  }, [missingList.length]);

  const renderAssets = () => {
    if (loading) {
      return (
        <div className="materials-empty">
          <div className="materials-empty-spinner" />
          <div className="materials-empty-text">{t("materials.loading")}</div>
        </div>
      );
    }
    if (sortedAssets.length === 0) {
      if (appearanceIds !== null) return null; // The compact query status owns waiting/empty/error feedback.
      if (activeFilterCount > 0 || materialQueryText || (attachmentCollection && attachmentQueryText)) {
        return (
          <div className="materials-empty materials-empty-filtered">
            <div className="materials-empty-icon">
              <svg viewBox="0 0 24 24" width="32" height="32" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
                <line x1="8" y1="11" x2="14" y2="11" />
              </svg>
            </div>
            <div className="materials-empty-title">{t("materials.empty.filteredTitle")}</div>
            <div className="materials-empty-hint">{t(attachmentCollection && attachmentQueryText ? "materials.empty.searchHint" : "materials.empty.filteredHint")}</div>
            <button type="button" className="materials-empty-action-btn" onClick={() => {
              clearMaterialFilters();
              if (attachmentCollection) { setAttachmentSearch(""); setAttachmentQueryText(""); }
            }}>
              {t("materials.filter.clear")}
            </button>
          </div>
        );
      }
      return (
        <div className="materials-empty">
          <div className="materials-empty-icon">
            <svg viewBox="0 0 24 24" width="32" height="32" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <circle cx="9" cy="10" r="1.2" />
              <path d="M21 17l-5-5-7 7" />
            </svg>
          </div>
          <div className="materials-empty-title">
            {t(attachmentCollection ? "materials.empty.noteAttachments" : selectedFolderId ? "materials.empty.folder" : "materials.empty.library")}
          </div>
          <div className="materials-empty-hint">
            {t(attachmentCollection ? "materials.empty.noteAttachmentsHint" : selectedFolderId ? "materials.empty.folderHint" : "materials.empty.libraryHint")}
          </div>
          {!attachmentCollection && <button type="button" className="materials-empty-action-btn primary" onClick={() => void handleImport(selectedFolderId)}>
            <svg viewBox="0 0 16 16" width="14" height="14" stroke="currentColor" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="8" y1="3" x2="8" y2="13" />
              <line x1="3" y1="8" x2="13" y2="8" />
            </svg>
            <span>{t("materials.empty.importAction")}</span>
          </button>}
        </div>
      );
    }

  const commonProps = {
      onOpen: handleOpenAsset,
      onClick: (asset: Asset, event: MouseEvent) => {
        if (suppressNextCardClickRef.current) {
          suppressNextCardClickRef.current = false;
          return;
        }
        if (event.ctrlKey || event.metaKey) {
          setSelectedIds((current) => {
            const next = new Set(current);
            if (next.has(asset.id)) next.delete(asset.id);
            else next.add(asset.id);
            return next;
          });
          return;
        }
        openDetailViewer(asset);
      },
      onContextMenu: handleContextMenu,
      onPointerDown: () => {
        suppressNextCardClickRef.current = false;
      },
      onHover: (assetId: string | null) => setHoveredAssetId(assetId),
      onPreview: openPreviewViewer,
      onToggleSelect: toggleSelected,
      onExternalDrag: (asset: Asset) => {
        const assetIds = resolveMaterialExternalDragSelection(asset.id, selectedIds);
        if (!selectedIds.has(asset.id)) setSelectedIds(new Set([asset.id]));
        suppressNextCardClickRef.current = true;
        void beginMaterialExternalDrag(assetIds, libraryId, attachmentCollection ? attachmentVaultId : undefined).catch(() => {
          setToast(t("materials.status.dragFailed"), "error");
        });
      },
      selectedIds,
      batchMode,
      focusedAssetId,
    };
    // Work-view info emphasis uses ONLY existing asset metadata (dominant
    // color, kind, mime, size): design surfaces format hints for
    // proportion/color comparison; video surfaces a video badge on the big
    // masonry tiles. No scans, no decoding, no new data fields.
    const workViewInfo = workViewPrefs?.active ?? "general";

    if (viewMode === "grid") {
      return (
        <div className={`grid-view-react${batchMode ? " batch-mode" : ""}`}>
          {sortedAssets.map((asset) => (
            <GridAssetCard key={asset.id} asset={asset} isFavorite={materialFavorites.byId.has(asset.id)} onToggleFavorite={toggleMaterialFavorite} workView={workViewInfo} {...commonProps} />
          ))}
        </div>
      );
    }

    if (viewMode === "list") {
      return (
        <div className={`list-view-react${batchMode ? " batch-mode" : ""}`}>
          {sortedAssets.map((asset) => (
            <ListAssetRow key={asset.id} asset={asset} isFavorite={materialFavorites.byId.has(asset.id)} onToggleFavorite={toggleMaterialFavorite} {...commonProps} />
          ))}
        </div>
      );
    }

    return (
      <div className={`masonry${batchMode ? " batch-mode" : ""}`}>
        {sortedAssets.map((asset) => (
          <AssetCard key={asset.id} asset={asset} isFavorite={materialFavorites.byId.has(asset.id)} onToggleFavorite={toggleMaterialFavorite} workView={workViewInfo} {...commonProps} />
        ))}
      </div>
    );
  };

  const toolAssetId=viewerAsset?.id??focusedAssetId??Array.from(selectedIds)[0]??workspaceInspectedAssetId??undefined;
  const renderWorkspaceTool=useRef<(kind:ToolKind,objectId?:string)=>ReactNode>(()=>null);
  renderWorkspaceTool.current=(kind,objectId)=>{
    if(!scope)return null;
    if(kind==='material-filter')return <div className="workspace-material-filter">
      <input aria-label="筛选面板搜索素材" placeholder="搜索此视图的素材…" value={materialSearch} onChange={event=>setMaterialSearch(event.target.value)}/>
      <MaterialsFilterPanel open sortBy={sortBy} onChangeSort={setSortBy} kinds={filterKinds} color={filterColor} hasColorData={hasAvailableFilterColors} colorDataPending={dataPending} ratingMin={filterRatingMin} activeFilterCount={activeFilterCount}
        onChangeKinds={setFilterKinds} onChangeColor={setFilterColor} onChangeRatingMin={rating=>setFilterRatingMin(current=>current===rating?null:rating)} onSaveSmartFolder={saveCurrentMaterialSmartFolder} onClear={clearMaterialFilters}/>
    </div>;
    const asset=allAssets.find(item=>item.id===(objectId??toolAssetId));
    if(!asset)return <p>{objectId?'固定素材已不可用。':'请选择一个素材查看属性。'}</p>;
    // The detached tool is outside this page's React subtree: explicitly carry
    // the immutable library scope so every inspector write stays in its source.
    return <MaterialViewProvider identity={scope}><MaterialsDetailPanel asset={asset} resolution={null}
      onClose={()=>setFocusedAssetId(null)} onOpen={handleOpenAsset} onReveal={item=>performMaterialPathAction(item,'reveal')} onRelocate={handleMaterialRelocation} relocating={missingRelocatingIds.has(asset.id)}
      onPreview={openPreviewViewer} onCompare={()=>openSingleCompare(asset,'context',null)} onFindSimilar={()=>setAppearanceRequest({assetId:asset.id})}
      onExport={()=>void beginMaterialExport({kind:'assets',assetIds:[asset.id]})} onCsvExport={()=>void beginCsvExport({kind:'assets',assetIds:[asset.id]})}
      onUpdated={mergeAssetUpdate} selectedCount={1} onBatchTags={()=>void openTagsModal([asset.id])} onInsertToNote={()=>void handleInsertToCurrentNote(asset)} onAskAi={()=>void handleAskAiWithAssets([asset])}
      favorite={materialFavorites.byId.has(asset.id)} onToggleFavorite={()=>void toggleMaterialFavorite(asset)}/></MaterialViewProvider>;
  };
  const workspaceToolAdapter=useMemo<ToolAdapter|null>(()=>scope?{title:`素材 · ${allAssets.find(asset=>asset.id===toolAssetId)?.name??'当前视图'}`,titleFor:id=>allAssets.find(asset=>asset.id===id)?.name??'素材不可用',kinds:['material-inspector','material-filter'],captureObject:kind=>kind==='material-inspector'?toolAssetId:undefined,render:(kind,objectId)=>renderWorkspaceTool.current(kind,objectId)}:null,
    [scope?.viewId,toolAssetId,allAssets,materialSearch,filterKinds,filterColor,filterRatingMin,sortBy,dataPending,activeFilterCount,materialFavorites.byId]);
  useWorkspaceTools(scope?.viewId,workspaceToolAdapter);
  return (
    <div ref={viewRoot} id={scope?`page-materials-${scope.viewId}`:'page-materials'} className={scope?'page workspace-material-page':'page'} style={{ height: "100%" }}>
      {scope&&<div className="workspace-material-toolbar">
        <input aria-label="搜索当前素材视图" placeholder="搜索素材…" value={materialSearch} onChange={event=>setMaterialSearch(event.target.value)}/>
        <select aria-label="当前视图文件夹" value={selectedFolderId??''} onChange={event=>{setSelectedFolderId(event.target.value||null);setFilterFolderId(event.target.value||null);}}><option value="">全部素材</option>{flattenFolders(folders).map(({folder})=><option key={folder.id} value={folder.id}>{folder.name}</option>)}</select>
        <button onClick={()=>void handleImport()}>导入</button><button onClick={()=>setFilterOpen(value=>!value)}>筛选</button>
        <button data-material-appearance-trigger data-material-appearance-drop onClick={()=>setAppearanceRequest({})}>搜图</button>
        <select aria-label="素材显示方式" value={viewMode} onChange={event=>setViewMode(event.target.value as ViewMode)}><option value="masonry">瀑布流</option><option value="grid">网格</option><option value="list">列表</option></select>
      </div>}
      <div className="materials-layout" inert={viewerAsset ? true : undefined} aria-hidden={viewerAsset ? true : undefined}>
        {/* 中间：内容区（文件夹树由 shell AppSidebar 的 FolderSection 渲染） */}
        <div className="materials-main">
          {!attachmentCollection && libraryId && <MaterialAppearancePanel key={libraryId}
            assets={appearanceScopeAssets} selectedIds={selectedIds} request={appearanceRequest}
            searchMode={materialSearchMode}
            onResult={applyAppearanceResult} onOpen={() => setAppearanceRequest(current => current ?? {})} onClose={() => setAppearanceRequest(null)} />}
          {attachmentCollection ? <section className="materials-attachment-collection" aria-label="笔记附件">
            <div><strong>笔记附件</strong><span>引用原文件，分类不会新增副本</span></div>
            <div className="materials-attachment-controls">
              <input type="search" aria-label="搜索笔记附件" placeholder="搜索附件名称或描述" value={attachmentSearch} onChange={event => setAttachmentSearch(event.target.value)} maxLength={256} />
              <select aria-label="附件所属知识库" value={attachmentVaultId} onChange={event => setAttachmentVaultId(event.target.value)}>
                <option value="">所有已登记知识库</option>
                {attachmentVaultId && !knownAttachmentVaults.some(vault => vault.id === attachmentVaultId) && <option value={attachmentVaultId}>当前知识库</option>}
                {knownAttachmentVaults.map(vault => <option key={vault.id} value={vault.id}>{vault.name}</option>)}
              </select>
              <label><input type="checkbox" checked={includeUnreferenced} onChange={event => setIncludeUnreferenced(event.target.checked)} />包含未引用附件</label>
            </div>
          </section> : null}
          {/* 素材视图 */}
          <div className="masonry-container" ref={masonryContainerRef} tabIndex={0} aria-label="素材列表" onScroll={rememberMasonryScroll}>
            {renderAssets()}
          </div>
        </div>
      </div>
      {contextMenu && (
        <AssetContextMenu
          key={contextMenu.sessionId}
          state={contextMenu}
          onClose={(restoreFocus) => closeContextMenu(restoreFocus, contextMenu.sessionId)}
          onOpen={handleOpenAssetOrDetail}
          onPreview={openPreviewViewer}
          onCompare={(asset) => {
            const currentSnapshot = materialStore.getSnapshot();
            const currentAssets = mergeAssetLists(currentSnapshot.allAssets as Asset[], currentSnapshot.assets as Asset[]);
            const currentAsset = contextActionAuthorityRef.current.resolve(contextMenu.sessionId, currentAssets);
            if (!currentAsset || currentAsset.id !== asset.id) {
              setToast(t("materials.status.assetUnavailable"), "error");
              (contextMenu.trigger?.isConnected ? contextMenu.trigger : masonryContainerRef.current)?.focus({ preventScroll: true });
              return;
            }
            openSingleCompare(currentAsset, "context", contextMenu.trigger);
          }}
          onTags={(asset) => void openTagsModal([asset.id])}
          onMove={(asset) => openMoveModal([asset.id])}
          onRevealFolder={handleRevealAssetFolder}
          onRename={(asset) => setModal({ type: "rename", asset, name: asset.name })}
          onRenameFile={openRenameFileModal}
          onShowInGraph={handleShowInGraph}
          onInsertToNote={() => {
            const currentSnapshot = materialStore.getSnapshot();
            const currentAssets = mergeAssetLists(currentSnapshot.allAssets as Asset[], currentSnapshot.assets as Asset[]);
            const currentAsset = contextActionAuthorityRef.current.resolve(contextMenu.sessionId, currentAssets);
            if (!currentAsset) {
              setToast(t("materials.status.assetUnavailable"), "error");
              return;
            }
            void handleInsertToCurrentNote(currentAsset);
          }}
          onLinkNote={handleLinkNote}
          onAskAi={(asset) => void handleAskAiWithAssets(resolveAskAiSelection(asset))}
          isFavorite={materialFavorites.byId.has(contextMenu.asset.id)}
          onToggleFavorite={(asset) => void toggleMaterialFavorite(asset)}
          onCopy={handleCopyAssetInfo}
          onExport={(asset) => attachmentCollection
            ? void exportAttachmentAsBefore(asset)
            : void beginMaterialExport({ kind: "assets", assetIds: [asset.id] })}
          onCsvExport={attachmentCollection ? undefined : (asset) => void beginCsvExport({ kind: "assets", assetIds: [asset.id] })}
          onCopyToLibrary={!attachmentCollection && libraryId ? asset => requestMaterialLibraryCopy({ libraryId, selection: { assetIds: [asset.id] }, label: "所选 1 项素材" }) : undefined}
          onDelete={(asset) => void handleDeleteAsset(asset.id)}
        />
      )}
      <ExperienceNotices notices={ordinaryNotices} dismiss={dismissOrdinaryNotice} maxVisible={Math.max(0, 2 - (exportPanelOpen ? 0 : exportNotices.length))} />
      {importProgress && <ImportProgressOverlay progress={importProgress} />}
      {!attachmentCollection && <MaterialExportUI
        planning={exportPlanning}
        plan={exportPlan}
        submissionPhase={exportSubmissionPhase}
        preserveHierarchy={exportPreserveHierarchy}
        onPreserveHierarchy={setExportPreserveHierarchy}
        onCancelPlan={dismissMaterialExportPlan}
        onConfirm={() => void confirmMaterialExport()}
        error={exportError}
        tasks={Object.values(exportTasks)}
        labels={exportTaskLabels}
        panelOpen={exportPanelOpen}
        onClosePanel={closeExportPanel}
        onOpenPanel={openExportPanel}
        notices={exportNotices}
        onDismissNotice={(id) => setExportNotices((current) => current.filter((notice) => notice.id !== id))}
        taskProblems={exportTaskProblems}
        actionErrors={exportActionErrors}
        retryState={exportRetryState}
        retryChildren={exportRetryChildIds}
        retryErrors={exportRetryErrors}
        onCancelTask={(taskId) => void cancelExportTask(taskId)}
        onRetry={(task) => void retryMaterialExportFailures(task)}
        onOpenDestination={(taskId) => void openExportDestination(taskId)}
        onCopyDestination={(taskId, path) => void copyExportDestination(taskId, path)}
        onDismissTask={dismissExportTask}
        onClearCompleted={clearCompletedExportTasks}
        onRefreshTask={(taskId) => void refreshExportTask(taskId)}
        csvTasks={Object.values(csvTasks)}
        csvRetrying={csvRetrying}
        onCancelCsvTask={(id) => void cancelCsvTask(id)}
        onRetryCsvTask={(id) => void retryCsvTask(id)}
        onDismissCsvTask={dismissCsvTask}
      />}
      {!attachmentCollection && <MaterialCsvExportDialog
        planning={csvPlanning} plan={csvPlan} description={csvDescription} onDescription={setCsvDescription}
        busy={csvBusy} error={csvError} onClose={dismissCsvPlan} onConfirm={() => void confirmCsvExport()} />}
      {viewerAsset && viewerMode === "detail" && !attachmentCollection && libraryId && workViewPrefs?.active === "video" && isVideoAsset(viewerAsset) ? (
        <MaterialFilmViewer onNativeElement={setNativeDetailElement} key={[libraryId, viewerAsset.id, viewerAsset.contentHash, viewerAsset.libraryPath, viewerAsset.originalPath].join("|")}
          asset={viewerAsset} libraryId={libraryId} resolveSource={resolveVideoPreviewUrl}
          renderDetails={(resolution, close, duration) => <MaterialsDetailPanel asset={viewerAsset} resolution={resolution} mediaDuration={duration} onClose={close}
            onOpen={handleOpenAsset} onReveal={(asset) => performMaterialPathAction(asset, "reveal")}
            onRelocate={handleMaterialRelocation} relocating={missingRelocatingIds.has(viewerAsset.id)}
            onPreview={openPreviewViewer} onCompare={() => openSingleCompare(viewerAsset, "detail")}
            onFindSimilar={() => { const assetId = viewerAsset.id; closeMaterialViewer(); setAppearanceRequest({ assetId }); }}
            onExport={() => void beginMaterialExport({ kind: "assets", assetIds: [viewerAsset.id] })}
            onCsvExport={() => void beginCsvExport({ kind: "assets", assetIds: [viewerAsset.id] })}
            selectedCount={selectedCount} onUpdated={mergeAssetUpdate} onBatchTags={() => void openTagsModal(Array.from(selectedIds))}
            onInsertToNote={() => void handleInsertToCurrentNote(viewerAsset)}
            onAskAi={() => void handleAskAiWithAssets(resolveAskAiSelection(viewerAsset))}
            favorite={materialFavorites.byId.has(viewerAsset.id)} onToggleFavorite={() => void toggleMaterialFavorite(viewerAsset)} />}
          onClose={closeMaterialViewer} onFrame={(frame) => { setSelectedAsset(frame); }} />
      ) : viewerAsset && viewerMode && (
        <MaterialViewer onNativeElement={setNativeDetailElement}
          key={[libraryId,viewerAsset.id,viewerAsset.contentHash,viewerAsset.originalPath,viewerAsset.libraryPath].join('|')}
          libraryId={attachmentCollection ? undefined : libraryId ?? undefined}
          asset={viewerAsset}
          assets={sortedAssets}
          mode={viewerMode}
          onClose={closeMaterialViewer}
          onChange={(asset) => {
            if (viewerMode === "detail") setSelectedAsset(asset);
            else setPreviewAsset(asset);
          }}
          onOpenOriginal={handleOpenAsset}
        >
          {(mediaDimensions) => viewerMode === "detail" ? (
            <MaterialsDetailPanel
              vaultId={attachmentCollection ? attachmentVaultId : undefined}
              asset={viewerAsset}
              resolution={mediaDimensions}
              onClose={closeMaterialViewer}
              onOpen={handleOpenAsset}
              onReveal={(asset) => performMaterialPathAction(asset, "reveal")}
              onRelocate={handleMaterialRelocation}
              relocating={missingRelocatingIds.has(viewerAsset.id)}
              onPreview={openPreviewViewer}
              onCompare={() => openSingleCompare(viewerAsset, "detail")}
              onFindSimilar={!attachmentCollection && libraryId ? () => {
                const assetId = viewerAsset.id; closeMaterialViewer(); setAppearanceRequest({ assetId });
              } : undefined}
              onExport={() => attachmentCollection
                ? void exportAttachmentAsBefore(viewerAsset)
                : void beginMaterialExport({ kind: "assets", assetIds: [viewerAsset.id] })}
              onCsvExport={attachmentCollection ? undefined : () => void beginCsvExport({ kind: "assets", assetIds: [viewerAsset.id] })}
              selectedCount={selectedCount}
              onUpdated={(updatedAsset) => {
                mergeAssetUpdate(updatedAsset);
                setMissingList((current) => current.filter((item) => item.id !== updatedAsset.id));
                missingScanCoordinatorRef.current?.schedule("data-change", 0);
              }}
              onBatchTags={() => void openTagsModal(Array.from(selectedIds))}
              onInsertToNote={() => void handleInsertToCurrentNote(viewerAsset)}
              onAskAi={() => void handleAskAiWithAssets(resolveAskAiSelection(viewerAsset))}
              favorite={materialFavorites.byId.has(viewerAsset.id)}
              onToggleFavorite={() => void toggleMaterialFavorite(viewerAsset)}
            />
          ) : null}
        </MaterialViewer>
      )}
      {showImportModePrompt && (
        <ImportModePrompt
          onChoose={chooseImportMode}
          onClose={() => {
            writeSavedSettingsPatch({ "materials.importModePromptSeen": true });
            setShowImportModePrompt(false);
          }}
        />
      )}
      <BatchBar
        selectedCount={selectedCount}
        visibleSelectedCount={visibleSelectedIds.length}
        onSelectAll={selectAllVisible}
        onInvert={invertVisibleSelection}
        onClear={clearSelection}
        onMove={() => openMoveModal(Array.from(selectedIds))}
        onTags={() => void openTagsModal(Array.from(selectedIds))}
        onCopyToLibrary={!attachmentCollection && libraryId ? () => requestMaterialLibraryCopy({ libraryId, selection: { assetIds: Array.from(selectedIds) }, label: `已选择 ${selectedIds.size} 个素材` }) : undefined}
        onLightSeek={() => void handleAskAiWithAssets(resolveAskAiSelection())}
        onDelete={() => void handleDeleteMany(Array.from(selectedIds))}
        compareDisabled={compareDisabledReason !== null}
        compareReasonKey={compareDisabledReason}
        compareEntryRef={compareEntryRef}
        onCompare={openCompare}
      />
      {compareSlotIds ? (
        // The modal carries the <2 "insufficient" state with an add path;
        // slot state is keyed by asset id and re-verified against the live
        // snapshot, so external changes surface as a per-slot missing state.
        <MaterialCompareModal
          slotAssetIds={compareSlotIds}
          assetsById={compareAssetsById}
          availableImages={compareAvailableImages}
          onClose={() => {
            const origin = compareReturnRef.current;
            compareReturnRef.current = null;
            setCompareSlotIds(null);
            if (origin?.kind === "detail") {
              const current = allAssets.find((asset) => asset.id === origin.assetId);
              if (current) {
                viewerReturnFocusRef.current = origin.trigger;
                setSelectedAsset(current);
              } else {
                (origin.trigger?.isConnected ? origin.trigger : masonryContainerRef.current)?.focus({ preventScroll: true });
              }
            } else if (origin?.kind === "context") {
              (origin.trigger?.isConnected ? origin.trigger : masonryContainerRef.current)?.focus({ preventScroll: true });
            } else {
              compareEntryRef.current?.focus({ preventScroll: true });
            }
          }}
          onSlotIdsChanged={(next) => setCompareSlotIds(next)}
        />
      ) : null}
      {modal?.type === "move" && (
        <FolderPickerModal
          folders={folders}
          selectedFolderId={selectedFolderId}
          onClose={() => setModal(null)}
          onSelect={(folderId) => void handleMoveAssets(modal.assetIds, folderId)}
        />
      )}
      {modal?.type === "tags" && (
        <TagPickerModal
          tags={tags}
          selectedTagIds={tagSelection}
          onToggle={(tagId) => {
            setTagSelection((current) => {
              const next = new Set(current);
              if (next.has(tagId)) next.delete(tagId);
              else next.add(tagId);
              return next;
            });
          }}
          newTagName={newTagName}
          onNewTagNameChange={setNewTagName}
          onCreateTag={() => void handleCreateTag()}
          onClose={() => setModal(null)}
          onApply={() => void handleApplyTags(modal.assetIds)}
        />
      )}
      {modal?.type === "rename" && (
        <div className="modal-overlay-react experience-dialog-backdrop" onPointerDown={() => setModal(null)}>
          <div className="modal-box-react experience-dialog" role="dialog" aria-modal="true" aria-label={t("materials.dialog.renameLibrary")} onPointerDown={(e) => e.stopPropagation()} style={{ width: "min(440px, calc(100vw - 48px))" }}>
            <div className="modal-header-react">
              <div className="modal-title-react">{t("materials.dialog.renameLibrary")}</div>
              <button type="button" className="modal-close-react" aria-label={t("common.action.close")} onClick={() => setModal(null)}>
                <svg viewBox="0 0 16 16" width="14" height="14" stroke="currentColor" fill="none" strokeWidth="2">
                  <line x1="4" y1="4" x2="12" y2="12" />
                  <line x1="12" y1="4" x2="4" y2="12" />
                </svg>
              </button>
            </div>
            <div className="modal-body-react">
              <div className="modal-note-react">{t("materials.dialog.renameLibraryHint")}</div>
              <input
                className="modal-input-react"
                value={modal.name}
                autoFocus
                onChange={(event) => setModal({ ...modal, name: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleRenameAsset(modal.asset, modal.name);
                  if (event.key === "Escape") setModal(null);
                }}
              />
            </div>
            <div className="modal-footer-react">
              <button type="button" className="modal-action-btn-react" onClick={() => setModal(null)}>{t("materials.dialog.cancel")}</button>
              <button type="button" className="modal-action-btn-react primary" onClick={() => void handleRenameAsset(modal.asset, modal.name)}>{t("materials.dialog.confirm")}</button>
            </div>
          </div>
        </div>
      )}
      {modal?.type === "renameFile" && (
        <div className="modal-overlay-react experience-dialog-backdrop" onPointerDown={() => setModal(null)}>
          <div className="modal-box-react experience-dialog" role="dialog" aria-modal="true" aria-label={t("materials.dialog.renameFile")} onPointerDown={(e) => e.stopPropagation()} style={{ width: "min(460px, calc(100vw - 48px))" }}>
            <div className="modal-header-react">
              <div className="modal-title-react">{t("materials.dialog.renameFile")}</div>
              <button type="button" className="modal-close-react" aria-label={t("common.action.close")} onClick={() => setModal(null)}>
                <svg viewBox="0 0 16 16" width="14" height="14" stroke="currentColor" fill="none" strokeWidth="2">
                  <line x1="4" y1="4" x2="12" y2="12" />
                  <line x1="12" y1="4" x2="4" y2="12" />
                </svg>
              </button>
            </div>
            <div className="modal-body-react">
              <div className="modal-note-react">{t("materials.dialog.renameFileHint")}</div>
              <input
                className="modal-input-react"
                value={modal.fileName}
                autoFocus
                onChange={(event) => setModal({ ...modal, fileName: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") confirmRenameAssetFile(modal.asset, modal.fileName);
                  if (event.key === "Escape") setModal(null);
                }}
              />
              <div className="modal-path-preview-react">{getRealRenameTargetPath(modal.asset)}</div>
            </div>
            <div className="modal-footer-react">
              <button type="button" className="modal-action-btn-react" onClick={() => setModal(null)}>{t("materials.dialog.cancel")}</button>
              <button type="button" className="modal-action-btn-react primary" onClick={() => confirmRenameAssetFile(modal.asset, modal.fileName)}>{t("materials.dialog.continue")}</button>
            </div>
          </div>
        </div>
      )}
      {/* D107/D110: 筛选面板 */}
      <MaterialsFilterPanel
        open={filterOpen}
        sortBy={sortBy}
        onChangeSort={setSortBy}
        kinds={filterKinds}
        color={filterColor}
        hasColorData={hasAvailableFilterColors}
        colorDataPending={dataPending}
        ratingMin={filterRatingMin}
        activeFilterCount={activeFilterCount}
        onChangeKinds={setFilterKinds}
        onChangeColor={setFilterColor}
        onChangeRatingMin={(rating) => setFilterRatingMin((current) => current === rating ? null : rating)}
        onSaveSmartFolder={saveCurrentMaterialSmartFolder}
        onClear={clearMaterialFilters}
      />
      {/* D110: 失效素材面板 */}
      <MissingAssetsPanel
        open={missingOpen}
        list={missingList}
        loading={missingLoading}
        error={missingScanError}
        relocatingIds={missingRelocatingIds}
        onScan={handleScanMissing}
        onRelocate={handleRelocateMissing}
        onRemove={handleRemoveMissing}
        onClose={() => setMissingOpen(false)}
      />
      {/* D115: 应用内确认弹窗 */}
      {confirmDialog && (
        <div className="modal-overlay-react experience-dialog-backdrop" onPointerDown={cancelConfirmDialog}>
          <div className="modal-box-react experience-dialog" role="dialog" aria-modal="true" aria-label={t("materials.dialog.confirm")} onPointerDown={(e) => e.stopPropagation()} style={{ maxWidth: 360 }}>
            <div className="modal-body-react" style={{ padding: "20px 16px", textAlign: "center" }}>
              <div style={{ fontSize: 13, color: "var(--text-primary)", lineHeight: 1.6 }}>{confirmDialog.message}</div>
            </div>
            <div className="modal-footer-react">
              <button type="button" className="modal-action-btn-react" onClick={cancelConfirmDialog}>{t("materials.dialog.cancel")}</button>
              {confirmDialog.actions?.length ? confirmDialog.actions.map((action) => (
                <button
                  type="button"
                  key={action.label}
                  className={`modal-action-btn-react${action.kind === "danger" ? " danger" : action.kind === "primary" ? " primary" : ""}`}
                  onClick={() => {
                    if (closeConfirmDialogForAction() !== confirmDialog) return;
                    void action.onClick();
                  }}
                >
                  {action.label}
                </button>
              )) : (
                <button type="button" className="modal-action-btn-react primary" onClick={() => {
                  if (closeConfirmDialogForAction() !== confirmDialog) return;
                  void confirmDialog.onConfirm?.();
                }}>{t("materials.dialog.confirm")}</button>
              )}
            </div>
          </div>
        </div>
      )}
      {/* D115: 应用内提示弹窗 */}
      {alertDialog && (
        <div className="modal-overlay-react experience-dialog-backdrop" onPointerDown={() => setAlertDialog(null)}>
          <div className="modal-box-react experience-dialog" role="dialog" aria-modal="true" aria-label={t("materials.dialog.confirm")} onPointerDown={(e) => e.stopPropagation()} style={{ maxWidth: 360 }}>
            <div className="modal-body-react" style={{ padding: "20px 16px", textAlign: "center" }}>
              <div style={{ fontSize: 13, color: "var(--text-primary)", lineHeight: 1.6 }}>{alertDialog.message}</div>
            </div>
            <div className="modal-footer-react">
              <button type="button" className="modal-action-btn-react primary" onClick={() => setAlertDialog(null)}>{t("materials.dialog.confirm")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ========== D107: 筛选面板 ==========

const KIND_OPTIONS = [
  { value: "image", labelKey: "materials.filter.image" },
  { value: "video", labelKey: "materials.filter.video" },
  { value: "audio", labelKey: "materials.filter.audio" },
  { value: "document", labelKey: "materials.filter.document" },
  { value: "other", labelKey: "materials.filter.other" },
] as const satisfies ReadonlyArray<{ value: string; labelKey: MessageKey }>;

function normalizeFilterColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const color = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : null;
}

function getMaterialPalette(value: unknown, maxColors = 8): string[] {
  if (typeof value !== "string") return [];
  const matches = value.toLowerCase().match(/#[0-9a-f]{6}/g) || [];
  const colors: string[] = [];
  for (const color of matches) {
    if (!colors.includes(color)) colors.push(color);
    if (colors.length >= maxColors) break;
  }
  return colors;
}

function serializeMaterialPalette(colors: string[], maxColors = 5): string {
  const palette: string[] = [];
  for (const color of colors) {
    const normalized = normalizeFilterColor(color);
    if (normalized && !palette.includes(normalized)) palette.push(normalized);
    if (palette.length >= maxColors) break;
  }
  return palette.join(",");
}

function getMaterialColorLabel(value: string | null | undefined, t: MaterialsT): string {
  const color = normalizeFilterColor(value);
  return color ? color.toUpperCase() : t("materials.color.unset");
}

const MATERIAL_HUE_LABEL_KEYS = [
  "materials.filter.hue.0", "materials.filter.hue.1", "materials.filter.hue.2",
  "materials.filter.hue.3", "materials.filter.hue.4", "materials.filter.hue.5",
  "materials.filter.hue.6", "materials.filter.hue.7", "materials.filter.hue.8",
  "materials.filter.hue.9", "materials.filter.hue.10", "materials.filter.hue.11",
] as const satisfies readonly MessageKey[];

function localizedFilterColorLabel(
  view: ReturnType<typeof getMaterialColorFilterView>,
  t: MaterialsT,
): string {
  if (!view) return "";
  if (view.kind === "black") return t("materials.filter.neutralBlack");
  if (view.kind === "gray") return t("materials.filter.neutralGray");
  if (view.kind === "white") return t("materials.filter.neutralWhite");
  return t(MATERIAL_HUE_LABEL_KEYS[Math.round((view.hue || 0) / 30) % MATERIAL_HUE_LABEL_KEYS.length]);
}

function isLightMaterialColor(value: string): boolean {
  const rgb = hexToRgb(value);
  if (!rgb) return false;
  return (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000 > 210;
}

const DETAIL_TAG_COLORS = [
  { bg: "var(--accent-muted)", fg: "var(--accent)" },
  { bg: "rgba(74, 222, 128, 0.12)", fg: "var(--mint)" },
  { bg: "rgba(167, 139, 250, 0.12)", fg: "var(--purple)" },
  { bg: "rgba(251, 191, 36, 0.12)", fg: "var(--amber)" },
  { bg: "rgba(248, 113, 113, 0.12)", fg: "var(--rose)" },
  { bg: "rgba(96, 165, 250, 0.12)", fg: "var(--blue, #60a5fa)" },
] as const;

function MaterialsFilterPanel({
  open,
  sortBy,
  onChangeSort,
  kinds,
  color,
  hasColorData,
  colorDataPending,
  ratingMin,
  activeFilterCount,
  onChangeKinds,
  onChangeColor,
  onChangeRatingMin,
  onSaveSmartFolder,
  onClear,
}: {
  open: boolean;
  sortBy: MaterialsSortBy;
  onChangeSort: (sortBy: MaterialsSortBy) => void;
  kinds: string[];
  color: StandardMaterialColorFilter | null;
  hasColorData: boolean;
  colorDataPending: boolean;
  ratingMin: number | null;
  activeFilterCount: number;
  onChangeKinds: (kinds: string[]) => void;
  onChangeColor: (color: StandardMaterialColorFilter | null) => void;
  onChangeRatingMin: (rating: number) => void;
  onSaveSmartFolder: () => void;
  onClear: () => void;
}) {
  const { plural, t } = useI18n();
  const activeKind = kinds.length === 1 ? kinds[0] : null;
  const colorView = getMaterialColorFilterView(color);
  const colorLabel = localizedFilterColorLabel(colorView, t);
  const [draftHue, setDraftHue] = useState(colorView?.kind === "hue" ? colorView.hue ?? 210 : 210);
  const [hoveredRating, setHoveredRating] = useState<number | null>(null);
  const hueFrameRef = useRef<number | null>(null);
  const pendingHueRef = useRef(draftHue);
  const ratingButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const previewRating = hoveredRating ?? ratingMin ?? 0;
  const draftHueFilter = createMaterialHueFilter(draftHue);
  const neutralFilters: Array<{ value: MaterialNeutralFilter; label: string }> = [
    { value: "neutral:black", label: t("materials.filter.neutralBlack") },
    { value: "neutral:gray", label: t("materials.filter.neutralGray") },
    { value: "neutral:white", label: t("materials.filter.neutralWhite") },
  ];

  useEffect(() => {
    if (colorView?.kind === "hue" && colorView.hue !== null) {
      setDraftHue(colorView.hue);
      pendingHueRef.current = colorView.hue;
    }
  }, [colorView?.hue, colorView?.kind]);

  useEffect(() => () => {
    if (hueFrameRef.current !== null) cancelAnimationFrame(hueFrameRef.current);
  }, []);

  const scheduleHueSelection = (nextHue: number) => {
    const normalizedHue = Number.isFinite(nextHue) ? Math.min(359, Math.max(0, Math.round(nextHue))) : 0;
    setDraftHue(normalizedHue);
    pendingHueRef.current = normalizedHue;
    if (hueFrameRef.current !== null) return;
    hueFrameRef.current = requestAnimationFrame(() => {
      hueFrameRef.current = null;
      onChangeColor(createMaterialHueFilter(pendingHueRef.current));
    });
  };

  const moveRatingFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, rating: number) => {
    let nextRating: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") nextRating = Math.max(1, rating - 1);
    if (event.key === "ArrowRight" || event.key === "ArrowUp") nextRating = Math.min(5, rating + 1);
    if (event.key === "Home") nextRating = 1;
    if (event.key === "End") nextRating = 5;
    if (nextRating === null) return;
    event.preventDefault();
    ratingButtonRefs.current[nextRating - 1]?.focus();
    if (nextRating !== ratingMin) onChangeRatingMin(nextRating);
  };

  if (!open) return null;

  const toggleKind = (value: string) => {
    onChangeKinds(activeKind === value ? [] : [value]);
  };

  return (
    <div
      id={MATERIALS_FILTER_PANEL_ID}
      className="filter-panel-react"
      role="region"
      aria-label={t("materials.filter.aria")}
    >
      <div className="filter-panel-scroll-react">
        <div className="filter-panel-row-react" role="group" aria-labelledby="materials-filter-sort-label">
          <span id="materials-filter-sort-label" className="filter-panel-label-react">{t("materials.filter.sort")}</span>
          <div className="filter-choice-list-react">
            {MATERIALS_SORT_OPTIONS.map(({ key }) => (
              <button key={key} type="button" className={`filter-chip-react${sortBy === key ? " active" : ""}`} aria-pressed={sortBy === key} onClick={() => onChangeSort(key)}>
                {t(`titlebar.materials.sort.${key}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="filter-panel-row-react" role="group" aria-labelledby="materials-filter-kind-label">
          <span id="materials-filter-kind-label" className="filter-panel-label-react">{t("materials.filter.format")}</span>
          <div className="filter-choice-list-react">
            <button type="button" className={"filter-chip-react" + (!activeKind ? " active" : "")} aria-pressed={!activeKind} onClick={() => onChangeKinds([])}>
              {t("materials.filter.all")}
            </button>
            {KIND_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.value}
                className={"filter-chip-react" + (activeKind === option.value ? " active" : "")}
                aria-pressed={activeKind === option.value}
                onClick={() => toggleKind(option.value)}
              >
                {t(option.labelKey)}
              </button>
            ))}
          </div>
        </div>

        <div className="filter-panel-row-react" role="group" aria-labelledby="materials-filter-color-label">
          <span id="materials-filter-color-label" className="filter-panel-label-react">{t("materials.filter.color")}</span>
          <div className="filter-color-control-react">
            <div className="filter-color-main-react">
              <button
                type="button"
                className={"filter-chip-react filter-unlimited-react" + (color === null ? " active" : "")}
                aria-pressed={color === null}
                onClick={() => onChangeColor(null)}
              >
                {t("materials.filter.unlimited")}
              </button>
              <input
                type="range"
                className="filter-hue-range-react"
                min={0}
                max={359}
                step={1}
                value={draftHue}
                disabled={!hasColorData}
                aria-label={t("materials.filter.colorAria")}
                aria-valuetext={localizedFilterColorLabel(getMaterialColorFilterView(draftHueFilter), t)}
                style={{ "--filter-hue-sample": materialColorFilterSample(draftHueFilter) } as CSSProperties}
                onInput={(event) => scheduleHueSelection(Number(event.currentTarget.value))}
              />
              <div className="filter-neutral-list-react" aria-label={t("materials.filter.neutralAria")}>
                {neutralFilters.map(({ value, label }) => (
                  <button
                    type="button"
                    key={value}
                    className={`filter-neutral-option-react ${value.slice("neutral:".length)}${color === value ? " active" : ""}`}
                    aria-label={label}
                    aria-pressed={color === value}
                    title={label}
                    disabled={!hasColorData}
                    onClick={() => onChangeColor(value)}
                  />
                ))}
              </div>
            </div>
            <div className="filter-color-readout-react" aria-live="polite">
              {colorView && <span className={`filter-color-readout-swatch-react${colorView.kind === "white" ? " light" : ""}`} style={{ background: colorView.sample }} />}
              <span>{hasColorData ? colorLabel || t("materials.filter.colorHint") : colorDataPending ? t("materials.filter.extracting") : t("materials.filter.noColor")}</span>
            </div>
          </div>
        </div>

        <div className="filter-panel-row-react" role="radiogroup" aria-label={t("materials.filter.rating")} aria-labelledby="materials-filter-rating-label">
          <span id="materials-filter-rating-label" className="filter-panel-label-react">{t("materials.filter.rating")}</span>
          <div className="filter-rating-list-react" onPointerLeave={() => setHoveredRating(null)}>
            {[1, 2, 3, 4, 5].map((rating) => (
              <button
                type="button"
                key={rating}
                ref={(button) => { ratingButtonRefs.current[rating - 1] = button; }}
                className={`filter-rating-option-react${rating <= previewRating ? " filled" : ""}${ratingMin === rating ? " active" : ""}`}
                role="radio"
                aria-checked={ratingMin === rating}
                aria-label={plural(rating, { one: "materials.filter.atLeastStars.one", other: "materials.filter.atLeastStars.other" })}
                title={ratingMin === rating
                  ? t("materials.filter.clearStars", { rating })
                  : plural(rating, { one: "materials.filter.atLeastStars.one", other: "materials.filter.atLeastStars.other" })}
                tabIndex={ratingMin === rating || (ratingMin === null && rating === 1) ? 0 : -1}
                onPointerEnter={() => setHoveredRating(rating)}
                onFocus={() => setHoveredRating(rating)}
                onBlur={() => setHoveredRating(null)}
                onKeyDown={(event) => moveRatingFocus(event, rating)}
                onClick={() => onChangeRatingMin(rating)}
              >
                <FavoriteGlyph filled={rating <= previewRating} />
              </button>
            ))}
            <span className="filter-rating-readout-react">{ratingMin ? plural(ratingMin, { one: "materials.filter.atLeastStars.one", other: "materials.filter.atLeastStars.other" }) : t("materials.filter.noRating")}</span>
          </div>
        </div>
      </div>

      <div className="filter-panel-footer-react">
        <span aria-live="polite">{activeFilterCount > 0 ? plural(activeFilterCount, { one: "materials.filter.active.one", other: "materials.filter.active.other" }) : t("materials.filter.inactive")}</span>
        <div className="filter-panel-footer-actions-react">
          <button type="button" className="filter-save-smart-react" onClick={onSaveSmartFolder}>{t("materials.filter.saveSmart")}</button>
          <button type="button" className="filter-clear-react" onClick={onClear} disabled={activeFilterCount === 0}>{t("materials.filter.clear")}</button>
        </div>
      </div>
    </div>
  );
}
// ========== D110: 失效素材面板 ==========

function MissingAssetsPanel({
  open,
  list,
  loading,
  error,
  relocatingIds,
  onScan,
  onRelocate,
  onRemove,
  onClose,
}: {
  open: boolean;
  list: MaterialMissingItem[];
  loading: boolean;
  error: string;
  relocatingIds: Set<string>;
  onScan: () => void;
  onRelocate: (item: MaterialMissingItem) => void;
  onRemove: (item: MaterialMissingItem) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  if (!open) return null;

  return (
    <div id={MATERIALS_MISSING_PANEL_ID} className="missing-panel-react" role="region" aria-label={t("materials.missing.title")}>
      <div className="missing-panel-header-react">
        <span className="missing-panel-title-react">{t("materials.missing.title")}</span>
        <div className="missing-panel-actions-react">
          <button type="button" className="missing-rescan-react" onClick={onScan} disabled={loading}>
            <span className="material-action-icon-react sync-retry" aria-hidden="true" />
            {t(loading ? "materials.missing.scanning" : "materials.missing.scan")}
          </button>
          <button type="button" className="missing-close-react" aria-label={t("materials.missing.close")} title={t("materials.detail.close")} onClick={onClose}>
            <span className="material-action-icon-react close" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="missing-panel-body-react">
        {loading && <div className="missing-empty-react">{t("materials.missing.scanningDetail")}</div>}
        {!loading && error && (
          <div className="missing-empty-react" role="status">
            {t("materials.missing.failed", { error })}
          </div>
        )}
        {!loading && !error && list.length === 0 && <div className="missing-empty-react">{t("materials.missing.empty")}</div>}
        {!loading && list.map((item) => (
          <div key={item.id} className="missing-item-react" aria-busy={relocatingIds.has(item.id)}>
            <div className="missing-item-info-react">
              <span className="missing-item-name-react" title={item.name}>{item.name}</span>
              <span className="missing-item-path-react" title={item.libraryPath}>{item.libraryPath}</span>
            </div>
            <div className="missing-panel-actions-react">
              <button
                type="button"
                className="filter-chip-react"
                onClick={() => onRelocate(item)}
                disabled={relocatingIds.has(item.id)}
                aria-label={t("materials.missing.relocateAria", { name: item.name })}
              >
                {t(relocatingIds.has(item.id) ? "materials.missing.relocating" : "materials.missing.relocate")}
              </button>
              <button
                type="button"
                className="missing-item-remove-react"
                onClick={() => onRemove(item)}
                disabled={relocatingIds.has(item.id)}
                aria-label={t("materials.missing.removeAria", { name: item.name })}
              >
                {t("materials.missing.remove")}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ========== 素材卡片 ==========

type AssetCardProps = {
  asset: Asset;
  selectedIds: Set<string>;
  batchMode: boolean;
  onOpen: (asset: Asset) => void;
  onClick: (asset: Asset, event: MouseEvent) => void;
  onHover: (assetId: string | null) => void;
  onContextMenu: (event: MouseEvent, asset: Asset) => void;
  onPreview: (asset: Asset) => void;
  onToggleSelect: (assetId: string) => void;
  onExternalDrag: (asset: Asset) => void;
  onPointerDown: () => void;
  focusedAssetId: string | null;
  isFavorite: boolean;
  onToggleFavorite: (asset: Asset) => void;
};

function useAssetDragGesture(asset: Asset, onExternalDrag: (asset: Asset) => void, onPointerDown: () => void) {
  const latest = useRef(() => onExternalDrag(asset));
  latest.current = () => onExternalDrag(asset);
  const gesture = useMemo(() => createMaterialDragGesture(document, () => latest.current()), []);
  useEffect(() => () => gesture.clear(), [gesture]);
  return (event: React.PointerEvent<HTMLElement>) => {
    onPointerDown();
    if ((event.target as Element).closest("button, input, textarea, a, video")) return;
    gesture.arm(event);
  };
}

function handleAssetDragStart(
  event: ReactDragEvent<HTMLElement>,
) {
  event.preventDefault();
  event.stopPropagation();
}

async function resolveVideoPreviewUrl(asset: Asset): Promise<string> {
  const sourcePath = resolveMaterialVideoPlaybackPath(asset);
  if (isVideoAsset(asset) && sourcePath) {
    const resolved = resolvedVideoPreviewCache.get(asset.id);
    if (resolved?.sourcePath === sourcePath && resolved.url) return resolved.url;
    const cacheKey = sourcePath;
    if (!videoPreviewCache.has(cacheKey)) {
      videoPreviewCache.set(cacheKey, getMaterialAssetPreviewUrl(sourcePath).catch((error: unknown) => {
        videoPreviewCache.delete(cacheKey);
        throw error;
      }));
    }
    const url = await videoPreviewCache.get(cacheKey);
    if (url) {
      resolvedVideoPreviewCache.set(asset.id, {
        sourcePath,
        url,
        aspectRatio: resolved?.sourcePath === sourcePath ? resolved.aspectRatio : undefined,
      });
      return url;
    }
  }
  return "";
}

function HoverVideoPreview({ asset, className, preserveAspectRatio = false }: {
  asset: Asset;
  className?: string;
  preserveAspectRatio?: boolean;
}) {
  const scope=useMaterialViewScope();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeRef = useRef(false);
  const sourcePath = resolveMaterialVideoPlaybackPath(asset);
  const cachedPreview = resolvedVideoPreviewCache.get(asset.id);
  const cachedForAsset = cachedPreview?.sourcePath === sourcePath ? cachedPreview : null;
  const previewLibraryId = scope?.libraryId??materialLibrarySession.getSnapshot().libraryId;
  const cachedCover = cachedNativeVideoCover(previewLibraryId, asset);
  const [videoSrc, setVideoSrc] = useState(() => cachedForAsset?.url || "");
  const [nearViewport, setNearViewport] = useState(false);
  const [hoverActive, setHoverActive] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [videoUnavailable, setVideoUnavailable] = useState(false);
  const [intrinsicAspectRatio, setIntrinsicAspectRatio] = useState<number | null>(() => cachedForAsset?.aspectRatio || null);
  const [thumbFailed, setThumbFailed] = useState(false);
  const [progress, setProgress] = useState(0);
  const [nativeMetadata, setNativeMetadata] = useState<NativeVideoMetadata | null>(() => cachedCover?.metadata ?? null);
  const [hoverPosition, setHoverPosition] = useState({ ratio: 0, serial: 0 });
  const useNativeHover = Boolean(nativeMetadata && (videoUnavailable || nativeMetadata.codec !== "h264"));
  const [nativeCover, setNativeCover] = useState<{src:string;aspect:number}|null>(() => cachedCover);
  useEffect(() => {
    const retained = cachedNativeVideoCover(previewLibraryId, asset);
    setNativeCover(retained);
    setNativeMetadata(retained?.metadata ?? null);
  }, [previewLibraryId, asset.id, asset.contentHash, asset.libraryPath, asset.originalPath]);
  useEffect(() => {
    // Scrolling out of view must not erase measured dimensions/cover: doing so
    // changes masonry height, re-enters the observer, and oscillates forever.
    if (!nearViewport || !previewLibraryId) return;
    const controller = new AbortController();
    void nativeVideoMetadata(previewLibraryId,asset.id,controller.signal).then(async metadata => {
      if (controller.signal.aborted) return;
      setNativeMetadata(metadata);
      const retained = cachedNativeVideoCover(previewLibraryId, asset);
      if (retained?.metadata.sourceRevision === metadata.sourceRevision) return;
      const frame = await nativeVideoThumbnail(previewLibraryId,asset.id,metadata.sourceRevision,Math.min(.5,metadata.duration*.1),controller.signal, "cover");
      if (!controller.signal.aborted) {
        const cover = {src:frame.src,aspect:metadata.width/metadata.height,metadata};
        retainNativeVideoCover(previewLibraryId,asset,cover); setNativeCover(cover);
      }
    }).catch(()=>{}); // Older host retains its HTML preview and honest unavailable state.
    return () => controller.abort();
  }, [nearViewport, previewLibraryId, asset.id, asset.contentHash, asset.libraryPath, asset.originalPath]);

  useEffect(() => {
    activeRef.current = false;
    const cached = resolvedVideoPreviewCache.get(asset.id);
    const nextSourcePath = resolveMaterialVideoPlaybackPath(asset);
    const nextCached = cached?.sourcePath === nextSourcePath ? cached : null;
    setVideoSrc(nextCached?.url || "");
    setNearViewport(false);
    setHoverActive(false);
    setVideoReady(false);
    setVideoUnavailable(false);
    setIntrinsicAspectRatio(nextCached?.aspectRatio || null);
    setThumbFailed(false);
    setProgress(0);
  }, [asset.id, asset.libraryPath, asset.originalPath]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    return observeMaterialVideoViewport(wrapper, setNearViewport);
  }, [asset.id]);

  const mediaAspectRatio = preserveAspectRatio ? nativeCover?.aspect ?? (nativeMetadata ? nativeMetadata.width/nativeMetadata.height : intrinsicAspectRatio) : null;
  const mediaStyle = mediaAspectRatio
    ? ({ "--material-video-aspect-ratio": String(mediaAspectRatio) } as CSSProperties)
    : undefined;
  const shouldMountVideo = (scope?.visible??true)&&(nearViewport || hoverActive);
  useEffect(()=>{if(scope&&!scope.visible){activeRef.current=false;setHoverActive(false);videoRef.current?.pause();}},[scope?.visible]);

  const seekFromPointer = (event: MouseEvent<HTMLElement>) => {
    const video = videoRef.current;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    if (useNativeHover) setHoverPosition(value => ({ ratio, serial: value.serial + 1 }));
    else if (video && Number.isFinite(video.duration) && video.duration > 0) video.currentTime = ratio * video.duration;
    setProgress(ratio);
  };

  const ensureVideoSrc = async () => {
    if (videoSrc) return videoSrc;
    try {
      const url = await resolveVideoPreviewUrl(asset);
      if ((activeRef.current || nearViewport) && url) setVideoSrc(url);
      return url;
    } catch (error) {
      console.warn("[materials] hover video preview failed", error);
      return "";
    }
  };

  useEffect(() => {
    if (!shouldMountVideo) {
      setVideoReady(false);
      return;
    }
    if (!videoSrc) void ensureVideoSrc();
  }, [shouldMountVideo, videoSrc]);

  const handleEnter = (event: MouseEvent<HTMLElement>) => {
    activeRef.current = true;
    setHoverActive(true);
    seekFromPointer(event);
    const video = videoRef.current;
    if (video && videoSrc) {
      video.play().catch(() => {});
      return;
    }
    void ensureVideoSrc();
  };

  const handleMove = (event: MouseEvent<HTMLElement>) => {
    seekFromPointer(event);
  };

  const handleLeave = () => {
    activeRef.current = false;
    setHoverActive(false);
    const video = videoRef.current;
    if (video) video.pause();
  };

  return (
    <div
      ref={wrapperRef}
      className={`hover-video-wrap-react${className ? ` ${className}` : ""}${mediaAspectRatio ? " has-intrinsic-aspect" : ""}`}
      style={mediaStyle}
      onMouseEnter={handleEnter}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
    >
      {nativeCover || (asset.thumbnailUrl && !thumbFailed) ? (
        <img src={nativeCover?.src || asset.thumbnailUrl} alt={asset.name} loading="lazy" onError={() => { setThumbFailed(true); setNativeCover(null); }} />
      ) : (
        <div className="hover-video-fallback-react">{videoUnavailable ? <small>当前播放器无法预览此视频</small> : <FileIcon />}</div>
      )}
      {hoverActive && useNativeHover && nativeMetadata && previewLibraryId && <NativeVideoHover libraryId={previewLibraryId} assetId={asset.id} metadata={nativeMetadata} position={hoverPosition} onProgress={setProgress} />}
      {shouldMountVideo && videoSrc && !useNativeHover ? (
        <video
          className={videoReady ? "ready" : ""}
          ref={videoRef}
          src={videoSrc}
          poster={asset.thumbnailUrl || undefined}
          muted
          loop
          playsInline
          preload="metadata"
          onLoadedMetadata={() => {
            const video = videoRef.current;
            if (preserveAspectRatio && video && video.videoWidth > 0 && video.videoHeight > 0) {
              const ratio = video.videoWidth / video.videoHeight;
              const cached = resolvedVideoPreviewCache.get(asset.id);
              if (cached?.sourcePath === sourcePath) {
                resolvedVideoPreviewCache.set(asset.id, { ...cached, aspectRatio: ratio });
              }
              setIntrinsicAspectRatio((current) => current && Math.abs(current - ratio) < 0.001 ? current : ratio);
            }
            if (video && !activeRef.current && Number.isFinite(video.duration) && video.duration > 0) {
              try { video.currentTime = Math.min(0.25, video.duration / 2); } catch {}
            }
            if (activeRef.current) video?.play().catch(() => {});
          }}
          onLoadedData={event => { const decoded = event.currentTarget.videoWidth > 0 && event.currentTarget.videoHeight > 0; setVideoReady(decoded); setVideoUnavailable(!decoded); if (!decoded) event.currentTarget.pause(); }}
          onCanPlay={event => { if (event.currentTarget.videoWidth > 0 && event.currentTarget.videoHeight > 0) setVideoReady(true); }}
          onError={() => { setVideoReady(false); setVideoUnavailable(true); }}
        />
      ) : null}
      <div className="hover-video-progress-react"><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>
    </div>
  );
}

function AssetColorSwatch({ color, compact = false }: { color?: string | null; compact?: boolean }) {
  const { t } = useI18n();
  const previewColor = getMaterialPalette(color, 1)[0];
  if (!previewColor) return null;
  return (
    <span
      className={`asset-color-swatch-react${compact ? " compact" : ""}${isLightMaterialColor(previewColor) ? " light" : ""}`}
      style={{ backgroundColor: previewColor }}
      title={t("materials.palette.primary", { color: getMaterialColorLabel(previewColor, t) })}
      aria-label={t("materials.palette.primary", { color: getMaterialColorLabel(previewColor, t) })}
    />
  );
}

function AssetColorPalette({ color }: { color?: string | null }) {
  const { t } = useI18n();
  const palette = getMaterialPalette(color, 5);
  if (palette.length === 0) return null;
  return (
    <span className="asset-mini-palette-react" aria-label={t("materials.palette.aria", { colors: palette.map((color) => getMaterialColorLabel(color, t)).join(", ") })}>
      {palette.map((paletteColor) => (
        <span
          key={paletteColor}
          className={`asset-color-swatch-react compact${isLightMaterialColor(paletteColor) ? " light" : ""}`}
          style={{ backgroundColor: paletteColor }}
          title={getMaterialColorLabel(paletteColor, t)}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}

function ImagePreview({ src, alt, className, variant = "thumbnail", sourceIdentity, onLoad }: {
  src: string; alt: string; className?: string; variant?: "thumbnail" | "viewer"; sourceIdentity?: string;
  onLoad?: (event: React.SyntheticEvent<HTMLImageElement>) => void;
}) {
  const { t } = useI18n();
  const identity = `${sourceIdentity || ""}\u001f${src}`;
  const [failedIdentity, setFailedIdentity] = useState<string | null>(null);
  // A cached failure may fire before effects run. Keep it bound to this resource;
  // changing sources immediately permits a fresh image without an effect reset.
  if (failedIdentity === identity || !src) {
    return <div className={variant === "viewer" ? "qp-placeholder-react image-preview-error-react" : `image-preview-fallback-react${className ? ` ${className}` : ""}`} role="img" aria-label={`${alt} · ${t("materials.viewer.imageLoadFailed")}`} title={alt}>
      <FileIcon />
      {variant === "viewer" && <span>{alt}</span>}
      <small>{t("materials.viewer.imageLoadFailed")}</small>
    </div>;
  }
  return <img key={identity} className={className} src={src} alt={alt} loading={variant === "viewer" ? "eager" : "lazy"} onLoad={onLoad} onError={() => setFailedIdentity(identity)} />;
}

function AssetHoverControls({ asset, onPreview, isFavorite, onToggleFavorite }: {
  asset: Asset;
  onPreview: (asset: Asset) => void;
  isFavorite: boolean;
  onToggleFavorite: (asset: Asset) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <div className="asset-hover-badges-react" aria-hidden="true">
        <span>{getAssetKindLabel(asset, t)}</span>
        <span>{getStorageModeShortLabel(asset.storageMode, t)}</span>
      </div>
      <button
        type="button"
        className="asset-preview-fab-react"
        title={t("materials.card.preview")}
        aria-label={t("materials.card.preview")}
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onPreview(asset);
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="7" cy="7" r="4" />
          <path d="M10.2 10.2 14 14" />
          <path d="M7 5v4M5 7h4" />
        </svg>
      </button>
      <button
        type="button"
        className={`asset-favorite-fab-react${isFavorite ? " active" : ""}`}
        title={t(isFavorite ? "materials.card.unfavorite" : "materials.card.favorite")}
        aria-label={t(isFavorite ? "materials.card.unfavoriteAria" : "materials.card.favoriteAria", { name: asset.name })}
        aria-pressed={isFavorite}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.stopPropagation();
          event.currentTarget.blur();
          onToggleFavorite(asset);
        }}
      >
        <FavoriteGlyph filled={isFavorite} />
      </button>
    </>
  );
}

function AssetCard({ asset, selectedIds, batchMode, focusedAssetId, onClick, onHover, onContextMenu, onPreview, onToggleSelect, onExternalDrag, onPointerDown, isFavorite, onToggleFavorite, workView }: AssetCardProps & { workView?: MaterialWorkViewPresetId }) {
  const beginDrag = useAssetDragGesture(asset, onExternalDrag, onPointerDown);
  const { t } = useI18n();
  const isVideo = isVideoAsset(asset);
  const isImage = isImageAsset(asset);
  const previewUrl = asset.thumbnailUrl || "";
  const checked = selectedIds.has(asset.id);
  const focused = focusedAssetId === asset.id;

  return (
    <div
      className={`masonry-item${isVideo ? " video-card-react" : ""}${checked ? " batch-selected" : ""}${batchMode ? " batch-mode" : ""}${focused ? " nav-focused" : ""}`}
      data-asset-id={asset.id}
      data-native-material-drag-source="true"
      tabIndex={0}
      aria-haspopup="menu"
      draggable
      onDragStart={handleAssetDragStart}
      onPointerDown={beginDrag}
      onClick={(event) => onClick(asset, event)}
      onMouseEnter={() => onHover(asset.id)}
      onMouseLeave={() => onHover(null)}
      onContextMenu={(event) => onContextMenu(event, asset)}
    >
      <BatchCheckbox checked={checked} onClick={(event) => { event.stopPropagation(); onToggleSelect(asset.id); }} />
      <AssetHoverControls asset={asset} onPreview={onPreview} isFavorite={isFavorite} onToggleFavorite={onToggleFavorite} />
      {isVideo ? (
        <HoverVideoPreview asset={asset} className="asset-video-thumb-react" preserveAspectRatio />
      ) : isImage && previewUrl ? (
        <ImagePreview src={previewUrl} alt={asset.name} sourceIdentity={`${asset.id}:${asset.updatedAt || ""}`} className="asset-image-thumb-react" />
      ) : (
        <div className="placeholder" style={{ aspectRatio: "4/3" }}>
          <svg viewBox="0 0 24 24" width="32" height="32" stroke="currentColor" fill="none" strokeWidth="1.5">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <circle cx="9" cy="10" r="1.2" />
            <path d="M21 17l-5-5-7 7" />
          </svg>
        </div>
      )}
      <div className="card-overlay">
        <div className="card-name">{asset.name}</div>
        <div className="card-meta">
          <AssetColorSwatch color={asset.dominantColor} compact />
          <span>{asset.kind || t("materials.card.unknown")}</span>
          {asset.sizeBytes && <span>{formatSize(asset.sizeBytes)}</span>}
          {workView === "video" && isVideoAsset(asset) ? <span className="workview-video-hint">{t("materials.workview.videoBadge")}</span> : null}
        </div>
      </div>
    </div>
  );
}

function GridAssetCard({ asset, selectedIds, batchMode, focusedAssetId, onClick, onHover, onContextMenu, onPreview, onToggleSelect, onExternalDrag, onPointerDown, isFavorite, onToggleFavorite, workView }: AssetCardProps & { workView?: MaterialWorkViewPresetId }) {
  const beginDrag = useAssetDragGesture(asset, onExternalDrag, onPointerDown);
  const { t } = useI18n();
  const checked = selectedIds.has(asset.id);
  const previewUrl = asset.thumbnailUrl || "";
  const isImage = isImageAsset(asset);
  const isVideo = isVideoAsset(asset);
  const focused = focusedAssetId === asset.id;

  return (
    <div
      className={`grid-item-react${isVideo ? " video-card-react" : ""}${checked ? " batch-selected" : ""}${batchMode ? " batch-mode" : ""}${focused ? " nav-focused" : ""}`}
      data-asset-id={asset.id}
      data-native-material-drag-source="true"
      tabIndex={0}
      aria-haspopup="menu"
      draggable
      onDragStart={handleAssetDragStart}
      onPointerDown={beginDrag}
      onClick={(event) => onClick(asset, event)}
      onMouseEnter={() => onHover(asset.id)}
      onMouseLeave={() => onHover(null)}
      onContextMenu={(event) => onContextMenu(event, asset)}
    >
      <BatchCheckbox checked={checked} onClick={(event) => { event.stopPropagation(); onToggleSelect(asset.id); }} />
      <AssetHoverControls asset={asset} onPreview={onPreview} isFavorite={isFavorite} onToggleFavorite={onToggleFavorite} />
      {isVideo ? (
        <HoverVideoPreview asset={asset} className="grid-thumb" />
      ) : isImage && previewUrl ? (
        <ImagePreview className="grid-thumb" src={previewUrl} alt={asset.name} sourceIdentity={`${asset.id}:${asset.updatedAt || ""}`} />
      ) : (
        <div className="grid-thumb-placeholder">
          <FileIcon />
        </div>
      )}
      <div className="grid-info">
        <div className="grid-name">{asset.name}</div>
        <div className="grid-meta">
          <AssetColorPalette color={asset.dominantColor} />
          <span>{asset.kind || t("materials.card.unknown")}{asset.sizeBytes ? ` · ${formatSize(asset.sizeBytes)}` : ""}</span>
          {workView === "design" && asset.mimeType ? <span className="workview-design-hint">{asset.mimeType}</span> : null}
        </div>
      </div>
    </div>
  );
}

function ListAssetRow({ asset, selectedIds, batchMode, focusedAssetId, onOpen, onClick, onHover, onContextMenu, onToggleSelect, onExternalDrag, onPointerDown }: AssetCardProps) {
  const beginDrag = useAssetDragGesture(asset, onExternalDrag, onPointerDown);
  const { t } = useI18n();
  const checked = selectedIds.has(asset.id);
  const previewUrl = asset.thumbnailUrl || "";
  const isImage = isImageAsset(asset);
  const isVideo = isVideoAsset(asset);
  const focused = focusedAssetId === asset.id;

  return (
    <div
      className={`list-item-react${checked ? " batch-selected" : ""}${batchMode ? " batch-mode" : ""}${focused ? " nav-focused" : ""}`}
      data-asset-id={asset.id}
      data-native-material-drag-source="true"
      tabIndex={0}
      aria-haspopup="menu"
      draggable
      onDragStart={handleAssetDragStart}
      onPointerDown={beginDrag}
      onClick={(event) => onClick(asset, event)}
      onMouseEnter={() => onHover(asset.id)}
      onMouseLeave={() => onHover(null)}
      onDoubleClick={() => onOpen(asset)}
      onContextMenu={(event) => onContextMenu(event, asset)}
    >
      <BatchCheckbox checked={checked} onClick={(event) => { event.stopPropagation(); onToggleSelect(asset.id); }} />
      <div className="list-thumb">
        {isVideo ? <HoverVideoPreview asset={asset} /> : isImage && previewUrl ? <ImagePreview src={previewUrl} alt={asset.name} sourceIdentity={`${asset.id}:${asset.updatedAt || ""}`} /> : <FileIcon />}
      </div>
      <div className="list-info">
        <div className="list-name">{asset.name}</div>
        <div className="list-meta">
          <AssetColorPalette color={asset.dominantColor} />
          <span>{asset.kind || t("materials.card.unknown")}</span>
          {asset.sizeBytes && <span>{formatSize(asset.sizeBytes)}</span>}
          <span>{formatDate(asset.updatedAt || asset.importedAt)}</span>
        </div>
      </div>
      <span className="list-arrow">›</span>
    </div>
  );
}

function BatchCheckbox({ checked, onClick }: { checked: boolean; onClick: (event: MouseEvent<HTMLButtonElement>) => void }) {
  const { t } = useI18n();
  return (
    <button className={`batch-checkbox-react${checked ? " checked" : ""}`} onClick={onClick} title={t(checked ? "materials.card.unselect" : "materials.card.select")}>
      <svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" /></svg>
    </button>
  );
}

// ========== 详情面板 ==========

type AiSuggestionState = {
  summary?: string;
  auto_tags?: string[];
  status?: string;
  error?: string;
  processed_at?: string;
};

export function MaterialsDetailPanel({
  vaultId,
  asset,
  resolution,
  mediaDuration,
  onClose,
  onOpen,
  onReveal,
  onRelocate,
  relocating,
  onPreview,
  onCompare,
  onFindSimilar,
  onExport,
  onCsvExport,
  onUpdated,
  selectedCount,
  onBatchTags,
  onInsertToNote,
  onAskAi,
  favorite,
  onToggleFavorite,
}: {
  vaultId?: string;
  asset: Asset | null;
  resolution: MaterialMediaDimensions | null;
  mediaDuration?: number;
  onClose: () => void;
  onOpen: (asset: Asset) => void;
  onReveal: (asset: Asset) => Promise<boolean>;
  onRelocate: (assetId: string) => Promise<"succeeded" | "cancelled" | "failed" | "busy">;
  relocating: boolean;
  onPreview: (asset: Asset) => void;
  onCompare: () => void;
  onFindSimilar?: () => void;
  onExport: () => void;
  onCsvExport?: () => void;
  onUpdated: (asset: Asset) => void;
  selectedCount: number;
  onBatchTags: () => void;
  onInsertToNote: () => void;
  onAskAi: () => void;
  favorite: boolean;
  onToggleFavorite: () => void;
}) {
  const { locale, plural, t } = useI18n();
  const {getMaterialSourcePage,getMaterialAssetTagContext,updateMaterialAsset,setMaterialAssetTags,getMaterialAssetAiSuggestion,generateMaterialAssetAiSuggestion,applyMaterialAssetAiTags,dismissMaterialAssetAiSuggestion}=useMaterialViewServices();
  const [activeTab, setActiveTab] = useState<"inspector" | "taxonomy">("inspector");
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftRating, setDraftRating] = useState<number | null>(null);
  const [hoveredDetailRating, setHoveredDetailRating] = useState<number | null>(null);
  const [assetTags, setAssetTagsLocal] = useState<Tag[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [tagLoading, setTagLoading] = useState(false);
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [sourcePage, setSourcePage] = useState<MaterialSourcePage | null>(null);
  const selectionRef = useRef({ assetId: null as string | null, epoch: 0 });
  if (selectionRef.current.assetId !== (asset?.id ?? null)) {
    selectionRef.current = { assetId: asset?.id ?? null, epoch: selectionRef.current.epoch + 1 };
  }
  const [aiSuggestion, setAiSuggestion] = useState<AiSuggestionState | null>(null);
  const [aiSelectedTags, setAiSelectedTags] = useState<string[]>([]);
  const [aiLoading, setAiLoading] = useState(false);
  const tagPickerRootRef = useRef<HTMLDivElement | null>(null);
  const detailRatingButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const materialSource = asset ? materialSourceInfo(asset) : null;
  const selectedSourcePage = sourcePage?.assetId === asset?.id ? sourcePage : null;

  const copySourceValue = async (value: string) => {
    const selectionEpoch = selectionRef.current.epoch;
    try {
      await navigator.clipboard.writeText(value);
      if (selectionRef.current.epoch === selectionEpoch) setStatus(t("materials.source.copied"));
    } catch {
      if (selectionRef.current.epoch === selectionEpoch) setStatus(t("materials.source.copyFailed"));
    }
  };

  const openSourceLink = async (url: string) => {
    const selectionEpoch = selectionRef.current.epoch;
    // http/https only; the shared opener rejects every other scheme.
    if (!/^https?:\/\//i.test(url)) {
      if (selectionRef.current.epoch === selectionEpoch) setStatus(t("materials.source.openFailed"));
      return;
    }
    try {
      await openExternalUrl(url);
    } catch {
      if (selectionRef.current.epoch === selectionEpoch) setStatus(t("materials.source.openFailed"));
    }
  };

  const loadTagState = useCallback(async () => {
    if (!asset) return;
    setTagLoading(true);
    try {
      const context = await getMaterialAssetTagContext([asset.id], vaultId);
      setAllTags(context.tags);
      setAssetTagsLocal(context.tags.filter((tag: Tag) => context.selectedTagIds.includes(tag.id)));
    } catch (e) {
      console.warn("[materials] detail tags failed", e);
      setStatus(t("materials.detail.status.tagLoadFailed"));
    } finally {
      setTagLoading(false);
    }
  }, [asset, t]);

  useEffect(() => {
    let current = true;
    setSourcePage(null);
    if (asset?.id) {
      void getMaterialSourcePage(asset.id, vaultId).then((page) => {
        if (current) setSourcePage(page);
      }).catch(() => {
        if (current) setSourcePage(null);
      });
    }
    return () => { current = false; };
  }, [asset?.id]);

  useEffect(() => {
    setActiveTab("inspector");
    setDraftName(asset?.name ?? "");
    setDraftDescription(asset?.description ?? "");
    setDraftRating(asset?.rating ?? null);
    setHoveredDetailRating(null);
    setStatus("");
    setAssetTagsLocal([]);
    setAllTags([]);
    setTagPickerOpen(false);
    setAiSuggestion(null);
    setAiSelectedTags([]);
    void loadTagState();
  }, [asset, loadTagState]);

  useEffect(() => {
    if (!tagPickerOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (tagPickerRootRef.current?.contains(target)) return;
      setTagPickerOpen(false);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [tagPickerOpen]);

  useEffect(() => {
    let cancelled = false;
    const loadAi = async () => {
      if (!asset) return;
      try {
        const suggestion = await getMaterialAssetAiSuggestion(asset.id, vaultId);
        if (cancelled || !suggestion) return;
        setAiSuggestion(suggestion);
        setAiSelectedTags(Array.isArray(suggestion.auto_tags) ? suggestion.auto_tags : []);
      } catch {}
    };
    void loadAi();
    return () => { cancelled = true; };
  }, [asset?.id]);

  if (!asset) return <div className="detail-panel" />;

  const isVideo = isVideoAsset(asset);
  const isImage = isImageAsset(asset);
  const assetPath = asset.libraryPath || asset.originalPath || "";
  const currentTagIds = new Set(assetTags.map((tag) => tag.id));
  const availableTags = allTags.filter((tag) => !currentTagIds.has(tag.id));
  const storageMode = normalizeStorageMode(asset.storageMode);
  const storageLabel = t(storageMode === "managed" ? "materials.modal.managed" : storageMode === "source" ? "materials.modal.source" : "materials.modal.linked");
  const materialPalette = getMaterialPalette(asset.dominantColor, 5);
  const previewDetailRating = hoveredDetailRating ?? draftRating ?? 0;
  const hasDirtyMeta = draftName.trim() !== (asset.name || "") || draftDescription !== (asset.description || "") || draftRating !== (asset.rating ?? null);
  const saveMeta = async () => {
    const nextName = draftName.trim() || asset.name;
    setSaving(true);
    setStatus("");
    try {
      const updated = await updateMaterialAsset(asset.id, { name: nextName, description: draftDescription, rating: draftRating }, vaultId);
      const nextAsset = { ...asset, ...updated, name: nextName, description: draftDescription, rating: draftRating };
      onUpdated(nextAsset);
      setStatus(t("materials.detail.status.saved"));
    } catch (e) {
      console.warn("[materials] updateAsset failed", e);
      setStatus(t("materials.detail.status.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const applyTagIds = async (nextIds: string[]) => {
    setTagLoading(true);
    setStatus("");
    try {
      await setMaterialAssetTags(asset.id, nextIds, vaultId);
      await loadTagState();
      setTagPickerOpen(false);
      setStatus(t("materials.detail.status.tagsUpdated"));
    } catch (e) {
      console.warn("[materials] setAssetTags failed", e);
      setStatus(t("materials.detail.status.tagsFailed"));
    } finally {
      setTagLoading(false);
    }
  };

  const toggleAiTag = (tagName: string) => {
    setAiSelectedTags((current) => current.includes(tagName) ? current.filter((name) => name !== tagName) : [...current, tagName]);
  };

  const generateAiSuggestion = async () => {
    setAiLoading(true);
    setStatus("");
    try {
      const suggestion = await generateMaterialAssetAiSuggestion(asset.id, vaultId);
      setAiSuggestion(suggestion);
      setAiSelectedTags(Array.isArray(suggestion?.auto_tags) ? suggestion.auto_tags : []);
      const generatedDescription = suggestion?.summary?.trim();
      if (generatedDescription) {
        setDraftDescription(generatedDescription);
      }
      setStatus(suggestion?.error ? t("materials.detail.status.aiFailed") : (generatedDescription ? t("materials.detail.status.aiFilled") : t("materials.detail.status.aiGenerated")));
    } catch (e) {
      console.warn("[materials] generateAssetAiSuggestion failed", e);
      setStatus(t("materials.detail.status.aiFailed"));
    } finally {
      setAiLoading(false);
    }
  };

  const applyAiSuggestion = async () => {
    if (aiSelectedTags.length === 0) return;
    setAiLoading(true);
    setStatus("");
    try {
      await applyMaterialAssetAiTags(asset.id, aiSelectedTags, vaultId);
      await loadTagState();
      setStatus(t("materials.detail.status.aiTagsApplied"));
    } catch (e) {
      console.warn("[materials] applyAiTags failed", e);
      setStatus(t("materials.detail.status.aiTagsFailed"));
    } finally {
      setAiLoading(false);
    }
  };

  const dismissAiSuggestion = async () => {
    setAiLoading(true);
    setStatus("");
    try {
      await dismissMaterialAssetAiSuggestion(asset.id, vaultId);
      setAiSuggestion(null);
      setAiSelectedTags([]);
      setStatus(t("materials.detail.status.aiDismissed"));
    } catch (e) {
      console.warn("[materials] dismissAiSuggestion failed", e);
      setStatus(t("materials.detail.status.aiDismissFailed"));
    } finally {
      setAiLoading(false);
    }
  };

  const openInExplorer = async () => {
    if (!assetPath) {
      setStatus(t("materials.detail.status.noPath"));
      return;
    }
    setStatus("");
    const revealed = await onReveal(asset);
    setStatus(revealed ? t("materials.detail.status.revealed") : t("materials.detail.status.revealFailed"));
  };

  const relocateAssetPath = async () => {
    setStatus("");
    const result = await onRelocate(asset.id);
    if (result === "succeeded") setStatus(t("materials.detail.status.relocated"));
    else if (result === "failed") setStatus(t("materials.detail.status.relocateFailed"));
    else if (result === "busy") setStatus(t("materials.detail.status.relocating"));
  };

  const moveDetailRatingFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, rating: number) => {
    let nextRating: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") nextRating = Math.max(1, rating - 1);
    if (event.key === "ArrowRight" || event.key === "ArrowUp") nextRating = Math.min(5, rating + 1);
    if (event.key === "Home") nextRating = 1;
    if (event.key === "End") nextRating = 5;
    if (nextRating === null) return;
    event.preventDefault();
    setDraftRating(nextRating);
    detailRatingButtonRefs.current[nextRating - 1]?.focus();
  };

  return (
    <aside className="detail-panel open material-viewer-detail" aria-label={t("materials.detail.aria")}>
      <div className="detail-header inspector-header-react">
        <div className="detail-tabs-react" role="tablist" aria-label={t("materials.detail.tabsAria")}>
          <button className={`detail-tab-react${activeTab === "inspector" ? " active" : ""}`} role="tab" aria-selected={activeTab === "inspector"} onClick={() => setActiveTab("inspector")}>{t("materials.detail.inspector")}</button>
          <button className={`detail-tab-react${activeTab === "taxonomy" ? " active" : ""}`} role="tab" aria-selected={activeTab === "taxonomy"} onClick={() => setActiveTab("taxonomy")}>{t("materials.detail.taxonomy")}</button>
        </div>
        <button className="detail-close" onClick={onClose} aria-label={t("materials.detail.close")} title={t("materials.detail.close")}>
          <span className="material-action-icon-react close" aria-hidden="true" />
        </button>
      </div>
      <div className="detail-body inspector-body-react">
        {activeTab === "inspector" ? (
          <>
            <div className="detail-section inspector-section-react">
              <label className="detail-input-label-react">{t("materials.detail.title")}</label>
              <input className="detail-input-react" value={draftName} onChange={(event) => setDraftName(event.target.value)} />
              <div className="detail-field-heading-react">
                <label className="detail-input-label-react detail-description-label-react">{t("materials.detail.description")}</label>
                <button
                  className="ai-suggest-btn-react"
                  onClick={generateAiSuggestion}
                  disabled={aiLoading}
                  title={t("materials.detail.generateTitle")}
                >
                  {aiLoading ? t("materials.detail.generating") : t("materials.detail.generate")}
                </button>
              </div>
              <textarea className="detail-textarea-react" rows={3} aria-label={t("materials.detail.descriptionAria")} value={draftDescription} onChange={(event) => setDraftDescription(event.target.value)} />
              <div className={`detail-save-row-react detail-description-save-row-react${hasDirtyMeta || status ? " show" : ""}`}>
                <span className="detail-status-react">{status}</span>
                {hasDirtyMeta && <button className="detail-primary-btn-react" onClick={saveMeta} disabled={saving}>{saving ? t("materials.detail.saving") : t("materials.detail.save")}</button>}
              </div>
              <div className="detail-ai-inline-react">
                <div className="detail-section-title detail-ai-title-react">
                  <span>{t("materials.detail.aiSuggestion")}</span>
                </div>
                <div className="ai-summary-react">{aiSuggestion?.summary || aiSuggestion?.error || t("materials.detail.aiHint")}</div>
                {Array.isArray(aiSuggestion?.auto_tags) && aiSuggestion.auto_tags.length > 0 && (
                  <div className="ai-suggest-tag-list-react">
                    {aiSuggestion.auto_tags.map((tagName) => {
                      const selected = aiSelectedTags.includes(tagName);
                      return (
                      <button
                        key={tagName}
                        className={`ai-suggest-tag-react${selected ? " selected" : ""}`}
                        onClick={() => toggleAiTag(tagName)}
                        aria-pressed={selected}
                        title={selected ? t("materials.detail.unselect") : t("materials.detail.select")}
                      >
                        <span className="ai-suggest-tag-check-react" aria-hidden="true" />
                        {tagName}
                      </button>
                      );
                    })}
                  </div>
                )}
                {aiSuggestion && (
                  <div className="ai-suggest-actions-react">
                    <button className="detail-primary-btn-react" onClick={applyAiSuggestion} disabled={aiLoading || aiSelectedTags.length === 0}>{t("materials.detail.applyTags")}</button>
                    <button className="detail-secondary-btn-react" onClick={dismissAiSuggestion} disabled={aiLoading}>{t("materials.detail.ignore")}</button>
                  </div>
                )}
              </div>
            </div>

            <div className="detail-section inspector-section-react">
              <div className="detail-section-title">{t("materials.detail.rating")}</div>
              <div className="detail-rating-row-react" role="radiogroup" aria-label={t("materials.detail.ratingAria")} onPointerLeave={() => setHoveredDetailRating(null)}>
                {[1, 2, 3, 4, 5].map((rating) => (
                  <button
                    type="button"
                    key={rating}
                    ref={(button) => { detailRatingButtonRefs.current[rating - 1] = button; }}
                    className={`detail-rating-btn-react${rating <= previewDetailRating ? " filled" : ""}${draftRating === rating ? " active" : ""}`}
                    role="radio"
                    aria-checked={draftRating === rating}
                    aria-label={plural(rating, { one: "materials.detail.stars.one", other: "materials.detail.stars.other" })}
                    tabIndex={draftRating === rating || (draftRating === null && rating === 1) ? 0 : -1}
                    onPointerEnter={() => setHoveredDetailRating(rating)}
                    onFocus={() => setHoveredDetailRating(rating)}
                    onBlur={() => setHoveredDetailRating(null)}
                    onKeyDown={(event) => moveDetailRatingFocus(event, rating)}
                    onClick={() => setDraftRating((current) => current === rating ? null : rating)}
                    title={draftRating === rating
                      ? t("materials.detail.clearStars", { rating })
                      : plural(rating, { one: "materials.detail.setStars.one", other: "materials.detail.setStars.other" })}
                  >
                    <FavoriteGlyph filled={rating <= previewDetailRating} />
                  </button>
                ))}
                <span className="detail-rating-readout-react">{draftRating ? plural(draftRating, { one: "materials.detail.stars.one", other: "materials.detail.stars.other" }) : t("materials.detail.unrated")}</span>
              </div>
            </div>

            <div className="detail-section inspector-section-react">
              <div className="detail-section-title">{t("materials.detail.tags")}</div>
              <div className="detail-tag-list-react">
                {assetTags.map((tag, index) => {
                  const tone = DETAIL_TAG_COLORS[index % DETAIL_TAG_COLORS.length];
                  return (
                    <button
                      key={tag.id}
                      className="detail-tag-react active"
                      style={{ background: tone.bg, color: tone.fg }}
                      onClick={() => void applyTagIds(assetTags.filter((item) => item.id !== tag.id).map((item) => item.id))}
                    >
                      {tag.name}<span>×</span>
                    </button>
                  );
                })}
                <div className="detail-add-tag-wrap-react" ref={tagPickerRootRef}>
                  <button
                    className="detail-add-tag-react"
                    onClick={() => setTagPickerOpen((open) => !open)}
                    disabled={tagLoading}
                  >
                    {t("materials.detail.add")}
                  </button>
                  {tagPickerOpen && (
                    <div className="detail-tag-picker-react">
                      {availableTags.length === 0 ? (
                        <div className="detail-tag-picker-empty-react">{t("materials.detail.noTags")}</div>
                      ) : (
                        availableTags.slice(0, 18).map((tag) => (
                          <button
                            key={tag.id}
                            className="detail-tag-picker-item-react"
                            onClick={() => {
                              setTagPickerOpen(false);
                              void applyTagIds([...assetTags.map((item) => item.id), tag.id]);
                            }}
                          >
                            {tag.name}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="detail-section inspector-section-react">
              <div className="detail-section-title">{t("materials.detail.primaryColor")}</div>
              {materialPalette.length ? (
                <>
                  <div className="detail-color-palette-react">
                    {materialPalette.map((color) => (
                      <span
                        key={color}
                        className={`detail-color-preview-react${isLightMaterialColor(color) ? " light" : ""}`}
                        style={{ backgroundColor: color }}
                        title={getMaterialColorLabel(color, t)}
                      >
                        <span className="detail-color-hex-react">{color.toUpperCase()}</span>
                      </span>
                    ))}
                  </div>
                </>
              ) : (
                <div className="detail-color-empty-react">{isImage || isVideo ? t("materials.detail.extracting") : t("materials.detail.noExtractableColor")}</div>
              )}
            </div>

            <div className="detail-section inspector-section-react">
              <div className="detail-section-title">{t("materials.detail.fileInfo")}</div>
              <div className="detail-meta-grid-react">
                <span>{t("materials.detail.format")}</span><b>{asset.mimeType || asset.kind || "—"}</b>
                <span>{t("materials.detail.size")}</span><b>{asset.sizeBytes ? formatSize(asset.sizeBytes) : "—"}</b>
                <span>{t("materials.detail.resolution")}</span><b>{resolution ? `${resolution.width} × ${resolution.height}` : "—"}</b>
                {mediaDuration != null && mediaDuration > 0 && <><span>时长</span><b>{Math.floor(mediaDuration / 60)}:{String(Math.floor(mediaDuration % 60)).padStart(2, "0")}</b></>}
                <span>{t("materials.detail.storageModeLabel")}</span><b>{storageLabel}</b>
                <span>{t("materials.detail.imported")}</span><b>{formatDate(asset.importedAt, locale)}</b>
                <span>{t("materials.detail.modified")}</span><b>{formatDate(asset.updatedAt, locale)}</b>
              </div>
            </div>

            <div className="detail-section inspector-section-react material-source-section">
              <div className="detail-section-title">{t("materials.source.title")}</div>
              {!selectedSourcePage && (!materialSource || materialSource.kind === "unrecorded") ? (
                <div className="material-source-empty">{t("materials.source.unrecorded")}</div>
              ) : (
                <div className="detail-meta-grid-react material-source-grid">
                  {selectedSourcePage ? (
                    <>
                      <span>{t(selectedSourcePage.pageKind === "work-page" ? "materials.source.workPage" : "materials.source.capturePage")}</span>
                      <b className="material-source-value">
                        <a
                          href={selectedSourcePage.pageUrl}
                          className="material-source-link"
                          title={selectedSourcePage.pageUrl}
                          onClick={(event) => { event.preventDefault(); void openSourceLink(selectedSourcePage.pageUrl); }}
                        >{selectedSourcePage.pageUrl}</a>
                        <button type="button" className="material-source-mini" onClick={() => void copySourceValue(selectedSourcePage.pageUrl)}>{t("materials.source.copy")}</button>
                      </b>
                    </>
                  ) : null}
                  {(materialSource?.kind === "web-resource" || materialSource?.kind === "web-origin") && materialSource.origin ? (
                    <>
                      <span>{t("materials.source.site")}</span>
                      <b className="material-source-value">
                        <span className="material-source-text" title={materialSource.origin}>{materialSource.origin}</span>
                        <button type="button" className="material-source-mini" onClick={() => void copySourceValue(materialSource.origin!)}>{t("materials.source.copy")}</button>
                      </b>
                      {!selectedSourcePage && (
                        <>
                          <span>{t("materials.source.precision")}</span>
                          <b>{t(materialSource.kind === "web-resource" ? "materials.source.precisionResource" : "materials.source.precisionSiteOnly")}</b>
                        </>
                      )}
                    </>
                  ) : null}
                  {materialSource?.kind === "local" && asset.originalPath ? (
                    <>
                      <span>{t("materials.source.localFile")}</span>
                      <b className="material-source-value">
                        <span className="material-source-text" title={asset.originalPath}>{asset.originalPath}</span>
                        <button type="button" className="material-source-mini" onClick={() => void copySourceValue(asset.originalPath)}>{t("materials.source.copy")}</button>
                      </b>
                    </>
                  ) : null}
                  {materialSource?.kind === "recording" ? (
                    <b>{t("materials.source.recording")}</b>
                  ) : null}
                  {materialSource?.kind === "generated" ? (
                    <b>{t("materials.source.generated")}</b>
                  ) : null}
                </div>
              )}
            </div>

            <div className="detail-section inspector-section-react">
              <div className="detail-action-grid-react">
                <button onClick={() => onOpen(asset)}>{t("materials.detail.open")}</button>
                <button onClick={() => onPreview(asset)}>{t("materials.detail.preview")}</button>
                {onFindSimilar && <button onClick={onFindSimilar} disabled={!isImage}>查找相似</button>}
                <button onClick={onExport}><IconDownload />{t("materials.export.originals")}</button>
                {onCsvExport && <button onClick={onCsvExport}><IconDownload />{t("materials.csv.entry")}</button>}
                <button className="detail-compare-action-react" onClick={onCompare} disabled={!isImage} title={!isImage ? t("materials.compare.reason.imageOnly") : t("materials.detail.compare")}><IconCompare />{t("materials.detail.compare")}</button>
                <button onClick={openInExplorer} disabled={!assetPath}>{t("materials.detail.explorer")}</button>
                <button onClick={relocateAssetPath} disabled={relocating}>{relocating ? t("materials.missing.relocating") : t("materials.detail.relocate")}</button>
                <button onClick={onInsertToNote}>{t("materials.detail.insertNote")}</button>
                <button onClick={onAskAi}>{t("materials.detail.sendLightSeek")}</button>
                <button onClick={onToggleFavorite} aria-pressed={favorite} aria-label={favorite ? t("materials.card.unfavorite") : t("materials.card.favorite")} title={favorite ? t("materials.card.unfavorite") : t("materials.card.favorite")}><FavoriteGlyph filled={favorite} />{favorite ? t("materials.card.unfavorite") : t("materials.card.favorite")}</button>
                <button onClick={onBatchTags} disabled={selectedCount === 0}>{t("materials.detail.batchTags")}</button>
                <button className="danger" onClick={() => setStatus(t("materials.detail.status.deleteHint"))} disabled={selectedCount === 0}>{t("materials.detail.batchDelete")}</button>
              </div>
            </div>

            <MaterialAttachmentSection key={asset.id} assetId={asset.id} storageMode={asset.storageMode} onUpdated={onUpdated} />
          </>
        ) : (
          <div className="detail-section inspector-section-react taxonomy-pane-react">
            <div className="detail-meta-grid-react">
              <span>{t("materials.detail.folder")}</span><b>{asset.folderId || t("materials.detail.allMaterials")}</b>
              <span>{t("materials.detail.tagCount")}</span><b>{assetTags.length}</b>
              <span>{t("materials.detail.storage")}</span><b>{storageLabel}</b>
              <span>{t("materials.detail.primaryColor")}</span>
              <b className="detail-meta-color-value-react">
                {materialPalette.length ? (
                  <span className="detail-mini-palette-react">
                    {materialPalette.slice(0, 4).map((color) => (
                      <span
                        key={color}
                        className={`detail-color-preview-react${isLightMaterialColor(color) ? " light" : ""}`}
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </span>
                ) : t("materials.color.unset")}
              </b>
              <span>{t("materials.detail.rating")}</span><b>{asset.rating ? plural(asset.rating, { one: "materials.detail.stars.one", other: "materials.detail.stars.other" }) : t("materials.detail.unrated")}</b>
            </div>
            <div className="detail-linked-empty-react">{t("materials.detail.persistentHint")}</div>
          </div>
        )}
      </div>
    </aside>
  );
}

type MaterialContextSubmenuId = "organize" | "create";
type MaterialContextLeafId =
  | "open"
  | "preview"
  | "compare"
  | "addTag"
  | "move"
  | "reveal"
  | "rename"
  | "renameFile"
  | "graph"
  | "insertNote"
  | "linkNote"
  | "sendLightSeek"
  | "favorite"
  | "copy"
  | "export"
  | "csv"
  | "delete";

const MATERIAL_CONTEXT_GROUP_LABELS: Record<Locale, Record<MaterialContextSubmenuId, string>> = {
  "zh-CN": { organize: "整理", create: "用于创作" },
  "en-US": { organize: "Organize", create: "Create with" },
};

type MaterialContextLeafAction = {
  id: MaterialContextLeafId | "copyToLibrary";
  icon: ReactNode;
  label: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onSelect: (asset: Asset) => void;
};

function contextMenuItems(container: HTMLElement, level: "main" | "submenu") {
  return Array.from(container.querySelectorAll<HTMLButtonElement>(`[data-material-context-level="${level}"]:not(:disabled)`));
}

function focusContextMenuItem(
  event: ReactKeyboardEvent<HTMLElement>,
  container: HTMLElement,
  level: "main" | "submenu",
) {
  const items = contextMenuItems(container, level);
  const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
  if (!items.length) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    items[(currentIndex + delta + items.length) % items.length]?.focus();
  } else if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    items[event.key === "Home" ? 0 : items.length - 1]?.focus();
  }
}

function offsetTopWithin(element: HTMLElement, ancestor: HTMLElement) {
  let top = 0;
  let current: HTMLElement | null = element;
  while (current && current !== ancestor) {
    top += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }
  return top;
}

function AssetContextMenu({
  state,
  onOpen,
  onPreview,
  onCompare,
  onTags,
  onMove,
  onRevealFolder,
  onRename,
  onRenameFile,
  onShowInGraph,
  onInsertToNote,
  onLinkNote,
  onAskAi,
  isFavorite,
  onToggleFavorite,
  onCopy,
  onExport,
  onCsvExport,
  onCopyToLibrary,
  onDelete,
  onClose,
}: {
  state: ContextMenuState;
  onOpen: (asset: Asset) => void;
  onPreview: (asset: Asset) => void;
  onCompare: (asset: Asset) => void;
  onTags: (asset: Asset) => void;
  onMove: (asset: Asset) => void;
  onRevealFolder: (asset: Asset) => void;
  onRename: (asset: Asset) => void;
  onRenameFile: (asset: Asset) => void;
  onShowInGraph: (asset: Asset) => void;
  onInsertToNote: (asset: Asset) => void;
  onLinkNote: (asset: Asset) => void;
  onAskAi: (asset: Asset) => void;
  isFavorite: boolean;
  onToggleFavorite: (asset: Asset) => void;
  onCopy: (asset: Asset) => void;
  onExport: (asset: Asset) => void;
  onCsvExport?: (asset: Asset) => void;
  onCopyToLibrary?: (asset: Asset) => void;
  onDelete: (asset: Asset) => void;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const { locale, t } = useI18n();
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const organizeTriggerRef = useRef<HTMLButtonElement>(null);
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const focusSubmenuOnOpenRef = useRef(false);
  const [submenu, setSubmenu] = useState<MaterialContextSubmenuId | null>(null);
  const [placement, setPlacement] = useState<{ x: number; y: number; maxHeight?: number; ready: boolean }>({
    x: state.x,
    y: state.y,
    ready: false,
  });
  const [submenuPlacement, setSubmenuPlacement] = useState<{
    x: number;
    y: number;
    maxHeight?: number;
    ready: boolean;
    side: "left" | "right";
    verticalOrigin: "top" | "bottom";
  }>({ x: 0, y: 0, ready: false, side: "right", verticalOrigin: "top" });

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const menuWidth = el.offsetWidth;
    const menuHeight = el.offsetHeight;
    const result = calculateContextMenuPosition({
      anchorX: state.x,
      anchorY: state.y,
      menuWidth,
      menuHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      margin: 8,
    });
    setPlacement({
      x: result.x,
      y: result.y,
      maxHeight: result.maxHeight,
      ready: true,
    });
  }, [state.x, state.y, state.asset.id]);

  useEffect(() => {
    setSubmenu(null);
  }, [state.asset.id, state.x, state.y]);

  useEffect(() => {
    if (!placement.ready) return;
    const frame = requestAnimationFrame(() => {
      contextMenuItems(menuRef.current as HTMLElement, "main")[0]?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [placement.ready, state.asset.id, state.x, state.y]);

  const placeSubmenu = useCallback(() => {
    if (!submenu) return;
    const parent = menuRef.current;
    const panel = submenuRef.current;
    const trigger = submenu === "organize" ? organizeTriggerRef.current : createTriggerRef.current;
    if (!parent || !panel || !trigger) return;

    const margin = 8;
    const gap = 0;
    const width = panel.offsetWidth;
    const measuredHeight = panel.offsetHeight;
    const maxHeight = Math.max(0, window.innerHeight - margin * 2);
    const height = Math.min(measuredHeight, maxHeight);
    const parentLeft = placement.x;
    const parentTop = placement.y;
    const triggerTop = parentTop + offsetTopWithin(trigger, parent) - parent.scrollTop;
    const triggerBottom = triggerTop + trigger.offsetHeight;
    const rightX = parentLeft + parent.offsetWidth + gap;
    const leftX = parentLeft - width - gap;
    const side = rightX + width <= window.innerWidth - margin || leftX < margin ? "right" : "left";
    const x = Math.min(
      Math.max(side === "right" ? rightX : leftX, margin),
      Math.max(margin, window.innerWidth - width - margin),
    );
    const preferredY = triggerTop - 5;
    const flipsUp = preferredY + height > window.innerHeight - margin;
    const y = Math.min(
      Math.max(flipsUp ? triggerBottom - height + 5 : preferredY, margin),
      Math.max(margin, window.innerHeight - height - margin),
    );

    setSubmenuPlacement({
      x,
      y,
      maxHeight: measuredHeight > maxHeight ? maxHeight : undefined,
      ready: true,
      side,
      verticalOrigin: flipsUp ? "bottom" : "top",
    });
  }, [placement.x, placement.y, submenu]);

  useLayoutEffect(() => {
    setSubmenuPlacement((current) => ({ ...current, ready: false }));
    placeSubmenu();
  }, [placeSubmenu]);

  useEffect(() => {
    if (!submenuPlacement.ready || !focusSubmenuOnOpenRef.current) return;
    focusSubmenuOnOpenRef.current = false;
    contextMenuItems(submenuRef.current as HTMLElement, "submenu")[0]?.focus({ preventScroll: true });
  }, [submenuPlacement.ready]);

  useEffect(() => {
    const onResize = () => {
      const el = menuRef.current;
      if (!el) return;
      const menuWidth = el.offsetWidth;
      const menuHeight = el.offsetHeight;
      const result = calculateContextMenuPosition({
        anchorX: state.x,
        anchorY: state.y,
        menuWidth,
        menuHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        margin: 8,
      });
      setPlacement({
        x: result.x,
        y: result.y,
        maxHeight: result.maxHeight,
        ready: true,
      });
      if (submenu) requestAnimationFrame(placeSubmenu);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [placeSubmenu, state.x, state.y, submenu]);

  const labels = MATERIAL_CONTEXT_GROUP_LABELS[locale];

  const actions: Record<MaterialContextLeafId, MaterialContextLeafAction> = {
    open: { id: "open", icon: <IconEye />, label: t("materials.context.open"), shortcut: "Enter", onSelect: onOpen },
    preview: { id: "preview", icon: <IconImage />, label: t("materials.context.preview"), shortcut: "Space", onSelect: onPreview },
    compare: { id: "compare", icon: <IconCompare />, label: t("materials.context.compare"), disabled: !isImageAsset(state.asset), disabledReason: t("materials.compare.reason.imageOnly"), onSelect: onCompare },
    addTag: { id: "addTag", icon: <IconList />, label: t("materials.context.addTag"), onSelect: onTags },
    move: { id: "move", icon: <IconMove />, label: t("materials.context.move"), onSelect: onMove },
    reveal: { id: "reveal", icon: <IconFolderLocate />, label: t("materials.context.reveal"), onSelect: onRevealFolder },
    rename: { id: "rename", icon: <IconEdit />, label: t("materials.context.rename"), onSelect: onRename },
    renameFile: { id: "renameFile", icon: <IconFileRename />, label: t("materials.context.renameFile"), onSelect: onRenameFile },
    graph: { id: "graph", icon: <IconGraph />, label: t("materials.context.graph"), onSelect: onShowInGraph },
    insertNote: { id: "insertNote", icon: <IconNotePlus />, label: t("materials.context.insertNote"), onSelect: onInsertToNote },
    linkNote: { id: "linkNote", icon: <IconLink />, label: t("materials.context.linkNote"), onSelect: onLinkNote },
    sendLightSeek: { id: "sendLightSeek", icon: <IconAiSmall />, label: t("materials.context.sendLightSeek"), onSelect: onAskAi },
    favorite: {
      id: "favorite",
      icon: <FavoriteGlyph filled={isFavorite} />,
      label: isFavorite ? t("materials.card.unfavorite") : t("materials.card.favorite"),
      onSelect: onToggleFavorite,
    },
    copy: { id: "copy", icon: <IconCopy />, label: t("materials.context.copy"), onSelect: onCopy },
    export: { id: "export", icon: <IconDownload />, label: t("materials.context.export"), onSelect: onExport },
    csv: { id: "csv", icon: <IconDownload />, label: t("materials.csv.entry"), onSelect: onCsvExport ?? (() => {}) },
    delete: { id: "delete", icon: <IconTrash />, label: t("materials.context.delete"), danger: true, onSelect: onDelete },
  };

  const organizeActions = [
    actions.addTag,
    actions.move,
    actions.reveal,
    actions.rename,
    ...(canRenameRealAssetFile(state.asset) ? [actions.renameFile] : []),
  ];
  const createActions = [actions.graph, actions.insertNote, actions.linkNote, actions.sendLightSeek];

  const run = (action: MaterialContextLeafAction) => {
    if (action.disabled) return;
    if (action.id !== "compare" && state.trigger?.isConnected) {
      state.trigger.focus({ preventScroll: true });
    }
    action.onSelect(state.asset);
    onClose(false);
  };

  const openSubmenu = (next: MaterialContextSubmenuId, moveFocus: boolean) => {
    focusSubmenuOnOpenRef.current = moveFocus;
    setSubmenuPlacement((current) => ({ ...current, ready: false }));
    if (submenu === next) {
      placeSubmenu();
      if (moveFocus) {
        requestAnimationFrame(() => contextMenuItems(submenuRef.current as HTMLElement, "submenu")[0]?.focus({ preventScroll: true }));
      }
      return;
    }
    setSubmenu(next);
  };

  const closeSubmenu = (restoreTrigger: boolean) => {
    const trigger = submenu === "organize" ? organizeTriggerRef.current : createTriggerRef.current;
    setSubmenu(null);
    if (restoreTrigger) requestAnimationFrame(() => trigger?.focus({ preventScroll: true }));
  };

  const handleMainKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      const target = document.activeElement as HTMLButtonElement | null;
      if (target?.matches('[role="menuitem"]')) {
        event.preventDefault();
        event.stopPropagation();
        target.click();
      }
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.stopPropagation();
      focusContextMenuItem(event, event.currentTarget, "main");
      return;
    }
    if (event.key === "ArrowRight") {
      const target = document.activeElement as HTMLButtonElement | null;
      const targetSubmenu = target?.dataset.materialSubmenu as MaterialContextSubmenuId | undefined;
      if (targetSubmenu) {
        event.preventDefault();
        event.stopPropagation();
        openSubmenu(targetSubmenu, true);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    } else if (event.key === "Tab") {
      window.setTimeout(() => onClose(false), 0);
    }
  };

  const handleSubmenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      const target = document.activeElement as HTMLButtonElement | null;
      if (target?.matches('[role="menuitem"]')) {
        event.preventDefault();
        event.stopPropagation();
        target.click();
      }
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.stopPropagation();
      focusContextMenuItem(event, event.currentTarget, "submenu");
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeSubmenu(true);
    } else if (event.key === "Tab") {
      window.setTimeout(() => onClose(false), 0);
    }
  };

  const renderAction = (action: MaterialContextLeafAction, level: "main" | "submenu") => (
    <ContextItem
      key={action.id}
      action={action}
      level={level}
      onPointerEnter={() => {
        if (level === "main") setSubmenu(null);
      }}
      onClick={() => run(action)}
    />
  );

  return (
    <>
      <div
        ref={menuRef}
        className="asset-ctx-react"
        data-material-context-root="true"
        role="menu"
        aria-label={state.asset.name}
        style={{
          left: placement.x,
          top: placement.y,
          maxHeight: placement.maxHeight ? `${placement.maxHeight}px` : undefined,
          visibility: placement.ready ? "visible" : "hidden",
        }}
        onKeyDown={handleMainKeyDown}
        onScroll={() => setSubmenu(null)}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="asset-ctx-react-group">
          {renderAction(actions.open, "main")}
          {renderAction(actions.preview, "main")}
          {renderAction(actions.compare, "main")}
        </div>
        <div className="asset-ctx-react-group">
          <ContextSubmenuTrigger
            ref={organizeTriggerRef}
            icon={<IconList />}
            label={labels.organize}
            submenuId="organize"
            expanded={submenu === "organize"}
            onOpen={openSubmenu}
          />
          <ContextSubmenuTrigger
            ref={createTriggerRef}
            icon={<IconNotePlus />}
            label={labels.create}
            submenuId="create"
            expanded={submenu === "create"}
            onOpen={openSubmenu}
          />
          {renderAction(actions.favorite, "main")}
        </div>
        <div className="asset-ctx-react-group">
          {renderAction(actions.copy, "main")}
          {onCopyToLibrary && renderAction({ id: "copyToLibrary", icon: <IconCopy />, label: "复制此素材到其他库", onSelect: onCopyToLibrary }, "main")}
          {renderAction(actions.export, "main")}
          {onCsvExport && renderAction(actions.csv, "main")}
        </div>
        <div className="asset-ctx-react-group">
          {renderAction(actions.delete, "main")}
        </div>
      </div>

      {submenu && (
        <div
          ref={submenuRef}
          id={`materials-context-${submenu}-submenu`}
          className="asset-ctx-react asset-ctx-react-submenu"
          data-material-context-submenu={submenu}
          data-side={submenuPlacement.side}
          data-vertical-origin={submenuPlacement.verticalOrigin}
          role="menu"
          aria-label={labels[submenu]}
          style={{
            left: submenuPlacement.x,
            top: submenuPlacement.y,
            maxHeight: submenuPlacement.maxHeight ? `${submenuPlacement.maxHeight}px` : undefined,
            visibility: submenuPlacement.ready ? "visible" : "hidden",
          }}
          onKeyDown={handleSubmenuKeyDown}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {submenu === "organize" ? (
            <>
              <div className="asset-ctx-react-group">
                {organizeActions.slice(0, 3).map((action) => renderAction(action, "submenu"))}
              </div>
              <div className="asset-ctx-react-group">
                {organizeActions.slice(3).map((action) => renderAction(action, "submenu"))}
              </div>
            </>
          ) : (
            <>
              <div className="asset-ctx-react-group">
                {createActions.slice(0, 3).map((action) => renderAction(action, "submenu"))}
              </div>
              <div className="asset-ctx-react-group">
                {createActions.slice(3).map((action) => renderAction(action, "submenu"))}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

function ContextItem({
  action,
  level,
  onPointerEnter,
  onClick,
}: {
  action: MaterialContextLeafAction;
  level: "main" | "submenu";
  onPointerEnter: () => void;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-material-context-action={action.id}
      data-material-context-level={level}
      disabled={action.disabled}
      title={action.disabled ? action.disabledReason : action.label}
      tabIndex={-1}
      className={`asset-ctx-react-item${action.danger ? " danger" : ""}`}
      onPointerEnter={onPointerEnter}
      onClick={onClick}
    >
      <span className="asset-ctx-react-icon" aria-hidden="true">{action.icon}</span>
      <span className="asset-ctx-react-label">{action.label}</span>
      {action.shortcut ? <kbd>{action.shortcut}</kbd> : <span aria-hidden="true" />}
    </button>
  );
}

const ContextSubmenuTrigger = forwardRef<HTMLButtonElement, {
  icon: ReactNode;
  label: string;
  submenuId: MaterialContextSubmenuId;
  expanded: boolean;
  onOpen: (submenu: MaterialContextSubmenuId, moveFocus: boolean) => void;
}>(function ContextSubmenuTrigger({ icon, label, submenuId, expanded, onOpen }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      role="menuitem"
      tabIndex={-1}
      className="asset-ctx-react-item"
      data-material-context-level="main"
      data-material-submenu={submenuId}
      data-active={expanded ? "true" : undefined}
      aria-haspopup="menu"
      aria-expanded={expanded}
      aria-controls={`materials-context-${submenuId}-submenu`}
      onPointerEnter={() => onOpen(submenuId, false)}
      onClick={() => onOpen(submenuId, true)}
    >
      <span className="asset-ctx-react-icon" aria-hidden="true">{icon}</span>
      <span className="asset-ctx-react-label">{label}</span>
      <span className="asset-ctx-react-arrow" aria-hidden="true">›</span>
    </button>
  );
});

function IconEye() {
  return <svg viewBox="0 0 16 16"><path d="M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z" /><circle cx="8" cy="8" r="2" /></svg>;
}

function IconImage() {
  return <svg viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="12" rx="1" /><circle cx="5" cy="7" r="1.5" /><path d="M1 12l4-3 2 2 3-4 5 5" /></svg>;
}

function IconCompare() {
  return <svg viewBox="0 0 16 16"><rect x="1" y="2.5" width="6" height="11" rx="1.5" /><rect x="9" y="2.5" width="6" height="11" rx="1.5" /><path d="M8 3v10" /></svg>;
}

function IconList() {
  return <svg viewBox="0 0 16 16"><path d="M4 4h8M4 8h5M4 12h3" /></svg>;
}

function IconMove() {
  return <svg viewBox="0 0 16 16"><rect x="2" y="2" width="5" height="12" rx="1" /><path d="M9 8h5M12 5l3 3-3 3" /></svg>;
}

function IconFolderLocate() {
  return <svg viewBox="0 0 16 16"><path d="M2 5a1 1 0 0 1 1-1h4l2 2h4a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5Z" /><circle cx="8" cy="10" r="2" /><path d="M8 7V5M8 15v-2M5 10H3M13 10h-2" /></svg>;
}

function IconEdit() {
  return <svg viewBox="0 0 16 16"><path d="M8 2l6 6-8 8H0v-6z" /><path d="M6 10l4-4" /></svg>;
}

function IconFileRename() {
  return <svg viewBox="0 0 16 16"><path d="M3 1.5h6l4 4V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1Z" /><path d="M9 1.5V6h4" /><path d="M5 11h6M5 9h4" /></svg>;
}

function IconGraph() {
  return <svg viewBox="0 0 16 16"><circle cx="4" cy="4" r="2" /><circle cx="12" cy="4" r="2" /><circle cx="8" cy="12" r="2" /><line x1="5.5" y1="5.2" x2="6.8" y2="10.8" /><line x1="10.5" y1="5.2" x2="9.2" y2="10.8" /><line x1="5.8" y1="4" x2="10.2" y2="4" /></svg>;
}

function IconNotePlus() {
  return <svg viewBox="0 0 16 16"><path d="M4 2h5l4 4v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" /><path d="M9 2v4h4" /><line x1="8" y1="8" x2="8" y2="12" /><line x1="6" y1="10" x2="10" y2="10" /></svg>;
}

function IconLink() {
  return <svg viewBox="0 0 16 16"><path d="M8 2a4 4 0 0 0-4 4c0 1.5.8 2.8 2 3.5" /><path d="M8 14a4 4 0 0 0 4-4c0-1.5-.8-2.8-2-3.5" /><circle cx="8" cy="8" r="1.5" /></svg>;
}

function IconAiSmall() {
  return <svg viewBox="0 0 16 16"><path d="M9 1l1.1 3.4L13.5 5.5 10.1 6.6 9 10 7.9 6.6 4.5 5.5 7.9 4.4 9 1Z" /><path d="M4 9l.6 1.8L6.5 11.5l-1.9.7L4 14l-.6-1.8-1.9-.7 1.9-.7L4 9Z" /></svg>;
}

function IconCopy() {
  return <svg viewBox="0 0 16 16"><rect x="4" y="2" width="8" height="10" rx="1" /><path d="M3 6h1v8a1 1 0 0 0 1 1h7" /></svg>;
}

function IconDownload() {
  return <svg viewBox="0 0 16 16"><path d="M8 2v8M4 6l4-4 4 4" /><path d="M2 12v2h12v-2" /></svg>;
}

function IconTrash() {
  return <svg viewBox="0 0 16 16"><polyline points="3,4 13,4" /><path d="M6 4V2h4v2M5 4v9h6V4" /></svg>;
}

function MaterialViewer({
  onNativeElement,
  libraryId,
  asset,
  assets,
  mode,
  onClose,
  onChange,
  onOpenOriginal,
  children,
}: {
  onNativeElement?: (element: HTMLElement | null) => void;
  libraryId?: string;
  asset: Asset;
  assets: Asset[];
  mode: MaterialViewerMode;
  onClose: () => void;
  onChange: (asset: Asset) => void;
  onOpenOriginal: (asset: Asset) => void;
  children?: ReactNode | ((dimensions: MaterialMediaDimensions | null) => ReactNode);
}) {
  const { t } = useI18n();
  const isVideo = isVideoAsset(asset);
  const isImage = isImageAsset(asset);
  const isAudio = asset.kind === "audio" || Boolean(asset.mimeType?.startsWith("audio/"));
  const [videoSourceSnapshot, setVideoSourceSnapshot] = useState<MaterialVideoSourceSnapshot | null>(null);
  const [mediaDimensionsSnapshot, setMediaDimensionsSnapshot] = useState<MaterialMediaDimensionsSnapshot | null>(null);
  const [videoFailureKey, setVideoFailureKey] = useState<string | null>(null);
  const [nativeClaim, setNativeClaim] = useState(Boolean(isVideo && libraryId));
  const [bounds, setBounds] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const viewerRootRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => { onNativeElement?.(viewerRootRef.current); return () => onNativeElement?.(null); }, [onNativeElement]);
  const portalHost = useMaterialViewerHost();
  const viewScope=useMaterialViewScope();
  useEffect(()=>{if(viewScope&&!viewScope.visible)portalHost.querySelectorAll('video,audio').forEach(media=>(media as HTMLMediaElement).pause());},[viewScope?.visible,portalHost]);
  const qpStageRef = useRef<HTMLDivElement | null>(null);
  const imagePreviewUrl = asset.previewUrl || asset.thumbnailUrl || "";
  const videoSourceIdentity = [
    asset.libraryPath || "",
    asset.originalPath || "",
    asset.previewUrl || "",
    asset.updatedAt || "",
  ].join("\u001f");
  const videoPreviewUrl = resolveMaterialVideoSource(videoSourceSnapshot, asset.id, videoSourceIdentity);
  const videoFailureIdentity = JSON.stringify([asset.id, videoSourceIdentity, videoPreviewUrl]);
  // Audio uses the same identity-scoped source resolution as video, without
  // introducing another cache or leaving a remote source playing behind a pane.
  const mediaSourceUrl = isVideo ? nativeClaim ? `native:${asset.id}` : videoPreviewUrl : isAudio ? videoPreviewUrl : imagePreviewUrl;
  const imageSourceIdentity = [imagePreviewUrl, asset.updatedAt || ""].join("\u001f");
  const mediaSourceIdentity = isVideo ? videoSourceIdentity : imageSourceIdentity;
  const mediaDimensions = resolveMaterialMediaDimensions(
    mediaDimensionsSnapshot,
    asset.id,
    mediaSourceUrl,
    mediaSourceIdentity,
  );

  // The video element box adopts the largest contained media rectangle so its
  // black surface never covers the letterbox blank space; clicks on that blank
  // space still dismiss detail mode through the media-surface handler.
  const containedMediaRect = mediaDimensions
    ? resolveContainedMaterialMediaRect(stageSize, mediaDimensions)
    : { width: 0, height: 0 };
  const containedVideoStyle = containedMediaRect.width > 0 && containedMediaRect.height > 0
    ? { width: `${containedMediaRect.width}px`, height: `${containedMediaRect.height}px` }
    : undefined;

  useLayoutEffect(() => {
    const stage = qpStageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const updateStage = () => {
      const rect = stage.getBoundingClientRect();
      setStageSize({ width: rect.width, height: rect.height });
    };
    updateStage();
    const stageObserver = new ResizeObserver(updateStage);
    stageObserver.observe(stage);
    return () => stageObserver.disconnect();
  }, []);

  useEffect(() => {
    const stage = qpStageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    setStageSize({ width: rect.width, height: rect.height });
  }, [mode, mediaSourceUrl]);

  useEffect(() => {
    let cancelled = false;
    if (!isVideo && !isAudio) return () => { cancelled = true; };
    const resolvingAssetId = asset.id;
    const resolvingSourceIdentity = videoSourceIdentity;
    const run = async () => {
      try {
        const url = isAudio
          ? await getMaterialAssetPreviewUrl(resolveMaterialVideoPlaybackPath(asset))
          : await resolveVideoPreviewUrl(asset);
        if (!cancelled && url) {
          setVideoSourceSnapshot({
            assetId: resolvingAssetId,
            sourceIdentity: resolvingSourceIdentity,
            url,
          });
        }
      } catch (error) {
        if (!cancelled) setVideoFailureKey(JSON.stringify([resolvingAssetId, resolvingSourceIdentity, ""]));
        console.warn("[materials] quick preview media failed", error);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [asset, isVideo, isAudio, videoSourceIdentity]);

  useLayoutEffect(() => {
    const updateBounds = () => {
      const main = document.querySelector(".react-nav-shell .main") as HTMLElement | null;
      const titlebar = main?.querySelector(".titlebar") as HTMLElement | null;
      const rect = main?.getBoundingClientRect();
      if (!rect) {
        setBounds({ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight });
        return;
      }
      setBounds(resolveMaterialViewerBounds(rect, titlebar?.getBoundingClientRect().height ?? 0));
    };
    updateBounds();
    const main = document.querySelector(".react-nav-shell .main") as HTMLElement | null;
    const boundsObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateBounds);
    if (main && boundsObserver) boundsObserver.observe(main);
    window.addEventListener("resize", updateBounds);
    return () => {
      boundsObserver?.disconnect();
      window.removeEventListener("resize", updateBounds);
    };
  }, []);

  useLayoutEffect(() => {
    viewerRootRef.current?.focus({ preventScroll: true });
  }, [mode]);

  const move = (direction: -1 | 1) => {
    onChange(getAdjacentAsset(asset, assets, direction) ?? asset);
  };

  const handleViewerKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const focusable = Array.from(viewerRootRef.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? []).filter((element) => element.getAttribute("aria-hidden") !== "true" && !element.hasAttribute("hidden"));
    if (focusable.length === 0) {
      event.preventDefault();
      viewerRootRef.current?.focus({ preventScroll: true });
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeElement = document.activeElement;
    if (event.shiftKey && (activeElement === viewerRootRef.current || activeElement === first || !viewerRootRef.current?.contains(activeElement))) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && (activeElement === viewerRootRef.current || activeElement === last || !viewerRootRef.current?.contains(activeElement))) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  };

  const handleMediaDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (target instanceof Element && target.closest("button, a, input, textarea, select, video, audio, [role='button']")) return;
    onOpenOriginal(asset);
  };

  return createPortal(
    <aside
      ref={viewerRootRef}
      className={`material-viewer-react ${mode}`}
      data-material-native-library={libraryId}
      data-material-native-asset={asset.id}
      style={{
        "--viewer-left": `${bounds.left}px`,
        "--viewer-top": `${bounds.top}px`,
        "--viewer-width": `${bounds.width}px`,
        "--viewer-height": `${bounds.height}px`,
      } as CSSProperties}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={mode === "detail" ? t("materials.viewer.detailAria") : t("materials.viewer.previewAria")}
      tabIndex={-1}
      onKeyDownCapture={(event) => {
        // The preview owns its close chord even over native playback controls.
        // Global route shortcuts deliberately ignore modal dialogs (including us).
        // Audio's native control uses Space for play/pause; do not close its
        // viewer before the control can consume that action.
        if (mode !== "preview" || event.nativeEvent.isComposing || (event.target as Element).closest("audio") || (isTextEntry(event.target) && !(event.target as Element).matches('input[type="range"]'))
          || (event.target as Element).closest('[role="dialog"]') !== event.currentTarget) return;
        if (matchesShortcut(event.nativeEvent, "materialsQuickPreview")) {
          event.preventDefault(); event.stopPropagation();
          if (!event.repeat) onClose();
        }
      }}
      onKeyDown={handleViewerKeyDown}
    >
      {mode === "preview" && (
        <button className="qp-close-react" onClick={onClose} title={t("materials.detail.close")} aria-label={t("materials.viewer.close")}>
          <svg viewBox="0 0 16 16" width="16" height="16" stroke="currentColor" fill="none" strokeWidth="2">
            <line x1="4" y1="4" x2="12" y2="12" />
            <line x1="12" y1="4" x2="4" y2="12" />
          </svg>
        </button>
      )}
      <div className={`material-viewer-surface ${mode}`} onClick={(event) => event.stopPropagation()}>
        <div
          className="material-viewer-media"
          onClick={(event) => {
            if (shouldDismissMaterialViewerFromBlank(mode, event.currentTarget, event.target)) onClose();
          }}
          onDoubleClick={handleMediaDoubleClick}
          title={t("materials.viewer.openFile")}
        >
          <button className="qp-nav-react qp-prev-react" onClick={(event) => { event.stopPropagation(); move(-1); }} title={t("materials.viewer.previous")} aria-label={t("materials.viewer.previous")}>
            <svg viewBox="0 0 16 16"><path d="M10 4L6 8l4 4" /></svg>
          </button>
          <div className="qp-media-stage-react" ref={qpStageRef}>
            {isVideo && libraryId && <NativeVideoInline key={[libraryId,asset.id,videoSourceIdentity].join('|')} libraryId={libraryId} assetId={asset.id} poster={cachedNativeVideoCover(libraryId,asset)?.src || asset.thumbnailUrl} style={containedVideoStyle} onClaim={setNativeClaim} onDimensions={(width,height)=>setMediaDimensionsSnapshot({assetId:asset.id,sourceUrl:`native:${asset.id}`,sourceIdentity:videoSourceIdentity,width,height})}/>}
            {!nativeClaim && isVideo && videoPreviewUrl ? (
              <video
                key={`${asset.id}:${videoPreviewUrl}`}
                src={videoPreviewUrl}
                style={containedVideoStyle}
                controls
                autoPlay={viewScope?.visible??true}
                muted
                playsInline
                onLoadedData={event => {
                  if(viewScope&&!viewScope.visible)event.currentTarget.pause();
                  if (!event.currentTarget.videoWidth || !event.currentTarget.videoHeight) {
                    event.currentTarget.pause(); setVideoFailureKey(videoFailureIdentity);
                  } else setVideoFailureKey(null);
                }}
                onError={() => setVideoFailureKey(videoFailureIdentity)}
                onLoadedMetadata={(event) => {
                  if (event.currentTarget.videoWidth > 0 && event.currentTarget.videoHeight > 0) {
                    setMediaDimensionsSnapshot({
                      assetId: asset.id,
                      sourceUrl: videoPreviewUrl,
                      sourceIdentity: videoSourceIdentity,
                      width: event.currentTarget.videoWidth,
                      height: event.currentTarget.videoHeight,
                    });
                  }
                }}
              />
            ) : nativeClaim ? null : isAudio ? (
              <div className="material-audio-preview">
                <span>{asset.name}</span>
                <audio
                  key={`${asset.id}:${videoSourceIdentity}:${videoPreviewUrl}`}
                  src={videoPreviewUrl || undefined}
                  controls
                  preload="metadata"
                  aria-label={asset.name}
                  onLoadedData={() => setVideoFailureKey(null)}
                  onError={() => setVideoFailureKey(videoFailureIdentity)}
                />
                {videoFailureKey === videoFailureIdentity && (
                  <p className="material-audio-unavailable" role="status">当前播放器无法播放此音频，原文件已保留，可通过“打开”使用外部播放器。</p>
                )}
              </div>
            ) : isImage ? (
              <ImagePreview
                key={asset.id}
                src={imagePreviewUrl}
                alt={asset.name}
                variant="viewer"
                sourceIdentity={imageSourceIdentity}
                onLoad={(event) => {
                  if (event.currentTarget.naturalWidth > 0 && event.currentTarget.naturalHeight > 0) {
                    setMediaDimensionsSnapshot({
                      assetId: asset.id,
                      sourceUrl: imagePreviewUrl,
                      sourceIdentity: imageSourceIdentity,
                      width: event.currentTarget.naturalWidth,
                      height: event.currentTarget.naturalHeight,
                    });
                  }
                }}
              />
            ) : (
              <div className="qp-placeholder-react">
                <FileIcon />
                <span>{asset.name}</span>
                <small>{asset.mimeType || asset.kind || t("materials.viewer.unknownType")}</small>
              </div>
            )}
            {!nativeClaim && isVideo && videoFailureKey === videoFailureIdentity && <div className="material-video-unavailable" role="status">当前内置播放器未能解码视频画面。原文件已保留，可通过“打开”使用外部播放器。</div>}
          </div>
          <button className="qp-nav-react qp-next-react" onClick={(event) => { event.stopPropagation(); move(1); }} title={t("materials.viewer.next")} aria-label={t("materials.viewer.next")}>
            <svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" /></svg>
          </button>
          <div className="qp-info-react">{asset.name}</div>
        </div>
        {mode === "detail" && (typeof children === "function" ? children(mediaDimensions) : children)}
      </div>
    </aside>, portalHost
  );
}

function ImportProgressOverlay({ progress }: { progress: ImportProgressState }) {
  const hasBytes = typeof progress.bytesRead === "number" && (progress.bytesTotal ?? 0) > 0;
  const indeterminate = Boolean(progress.indeterminate || progress.total <= 0 || (!hasBytes && progress.current < progress.total));
  const fraction = hasBytes ? Math.min(.99, progress.bytesRead! / progress.bytesTotal!) : 0;
  const percent = indeterminate
    ? undefined
    : Math.max(0, Math.min(100, Math.floor(((progress.current + fraction) / progress.total) * 100)));
  return (
    <div className="material-import-progress experience-progress" role="status" aria-live="polite">
      <div className="material-import-progress-head">
        <span>{progress.label}</span>
        {progress.total > 0 && <b>{hasBytes ? `${Math.floor(progress.bytesRead! / 1048576)} / ${Math.ceil(progress.bytesTotal! / 1048576)} MB` : `${progress.current}/${progress.total}`}</b>}
      </div>
      <div
        className={`material-import-progress-track experience-progress-track${indeterminate ? " indeterminate" : ""}`}
        role="progressbar"
        aria-label={progress.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : percent}
      >
        <span style={percent === undefined ? undefined : { width: `${percent}%` }} />
      </div>
    </div>
  );
}

function ImportModePrompt({ onChoose, onClose }: { onChoose: (mode: AssetStorageMode) => void; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <div className="modal-overlay-react experience-dialog-backdrop" onPointerDown={onClose}>
      <div className="modal-box-react material-import-mode-modal experience-dialog" role="dialog" aria-modal="true" aria-label={t("materials.modal.manageMode")} onPointerDown={(event) => event.stopPropagation()}>
        <ModalHeader title={t("materials.modal.manageMode")} onClose={onClose} />
        <div className="modal-body-react">
          <div className="import-mode-options">
            <button type="button" onClick={() => onChoose("managed")}>
              <strong>{t("materials.modal.managed")}</strong>
              <span>{t("materials.modal.managedDescription")}</span>
            </button>
            <button type="button" onClick={() => onChoose("linked")}>
              <strong>{t("materials.modal.linked")}</strong>
              <span>{t("materials.modal.linkedDescription")}</span>
            </button>
            <button type="button" onClick={() => onChoose("source")}>
              <strong>{t("materials.modal.source")}</strong>
              <span>{t("materials.modal.sourceDescription")}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function BatchBar({
  selectedCount,
  visibleSelectedCount,
  onSelectAll,
  onInvert,
  onClear,
  onMove,
  onTags,
  onCopyToLibrary,
  onLightSeek,
  onDelete,
  compareDisabled,
  compareReasonKey,
  compareEntryRef,
  onCompare,
}: {
  selectedCount: number;
  visibleSelectedCount: number;
  onSelectAll: () => void;
  onInvert: () => void;
  onClear: () => void;
  onMove: () => void;
  onTags: () => void;
  onCopyToLibrary?: () => void;
  onLightSeek: () => void;
  onDelete: () => void;
  compareDisabled: boolean;
  compareReasonKey: string | null;
  compareEntryRef: React.RefObject<HTMLButtonElement | null>;
  onCompare: () => void;
}) {
  const { plural, t } = useI18n();
  if (selectedCount === 0) return null;
  return (
    <div className={`batch-bar-react${selectedCount > 0 ? " show" : ""}`}>
      <span className="batch-count">{plural(selectedCount, { one: "materials.batch.selected.one", other: "materials.batch.selected.other" })}{visibleSelectedCount !== selectedCount ? plural(visibleSelectedCount, { one: "materials.batch.visible.one", other: "materials.batch.visible.other" }) : ""}</span>
      <button className="batch-btn-react" onClick={onSelectAll}>{t("materials.batch.selectAll")}</button>
      <button className="batch-btn-react" onClick={onInvert}>{t("materials.batch.invert")}</button>
      <button className="batch-btn-react" onClick={onClear}>{t("materials.batch.clear")}</button>
      <span className="batch-sep-react" />
      <button className="batch-btn-react" onClick={onMove}>{t("materials.batch.move")}</button>
      <button className="batch-btn-react" onClick={onTags}>{t("materials.batch.tag")}</button>
      {onCopyToLibrary && <button className="batch-btn-react" onClick={onCopyToLibrary}>复制所选到库</button>}
      <span className="batch-compare-entry" title={compareReasonKey ? t(compareReasonKey as Parameters<MaterialsT>[0]) : t("materials.batch.compare")}>
        <button
          ref={compareEntryRef}
          className="batch-btn-react"
          disabled={compareDisabled}
          title={compareReasonKey ? t(compareReasonKey as Parameters<MaterialsT>[0]) : t("materials.batch.compare")}
          aria-label={compareReasonKey ? `${t("materials.batch.compare")} · ${t(compareReasonKey as Parameters<MaterialsT>[0])}` : t("materials.batch.compare")}
          onClick={onCompare}
        >
          {t("materials.batch.compare")}
        </button>
      </span>
      <button className="batch-btn-react" onClick={onLightSeek}>{t("materials.batch.sendLightSeek")}</button>
      <button className="batch-btn-react danger" onClick={onDelete}>{t("materials.batch.delete")}</button>
    </div>
  );
}

function FolderPickerModal({
  folders,
  selectedFolderId,
  onClose,
  onSelect,
}: {
  folders: Folder[];
  selectedFolderId: string | null;
  onClose: () => void;
  onSelect: (folderId: string | null) => void;
}) {
  const { t } = useI18n();
  const flatFolders = flattenFolders(folders);
  return (
    <div className="modal-overlay-react experience-dialog-backdrop" onPointerDown={onClose}>
      <div className="modal-box-react experience-dialog" role="dialog" aria-modal="true" aria-label={t("materials.modal.move")} onPointerDown={(event) => event.stopPropagation()}>
        <ModalHeader title={t("materials.modal.move")} onClose={onClose} />
        <div className="modal-body-react">
          <div className={`modal-folder-item-react${selectedFolderId === null ? " active" : ""}`} onClick={() => onSelect(null)}>
            <FolderIcon />
            <span>{t("materials.detail.allMaterials")}</span>
          </div>
          {flatFolders.map(({ folder, depth }) => (
            <div
              key={folder.id}
              className={`modal-folder-item-react${selectedFolderId === folder.id ? " active" : ""}`}
              onClick={() => onSelect(folder.id)}
              style={{ paddingLeft: 10 + depth * 16 }}
            >
              <FolderIcon />
              <span>{folder.name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function TagPickerModal({
  tags,
  selectedTagIds,
  onToggle,
  newTagName,
  onNewTagNameChange,
  onCreateTag,
  onClose,
  onApply,
}: {
  tags: Tag[];
  selectedTagIds: Set<string>;
  onToggle: (tagId: string) => void;
  newTagName: string;
  onNewTagNameChange: (value: string) => void;
  onCreateTag: () => void;
  onClose: () => void;
  onApply: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="modal-overlay-react experience-dialog-backdrop" onPointerDown={onClose}>
      <div className="modal-box-react experience-dialog" role="dialog" aria-modal="true" aria-label={t("materials.modal.tags")} onPointerDown={(event) => event.stopPropagation()}>
        <ModalHeader title={t("materials.modal.tags")} onClose={onClose} />
        <div className="modal-body-react">
          <div className="modal-create-row-react">
            <input
              className="modal-input-react"
              value={newTagName}
              onChange={(event) => onNewTagNameChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onCreateTag();
              }}
              placeholder={t("materials.modal.newTag")}
            />
            <button className="modal-action-btn-react" onClick={onCreateTag} disabled={!newTagName.trim()}>
              {t("materials.modal.new")}
            </button>
          </div>
          {tags.length === 0 ? (
            <div className="materials-empty-text" style={{ padding: 12 }}>{t("materials.modal.noTags")}</div>
          ) : tags.map((tag) => (
            <div
              key={tag.id}
              className={`modal-tag-item-react${selectedTagIds.has(tag.id) ? " selected" : ""}`}
              onClick={() => onToggle(tag.id)}
            >
              <span className="modal-tag-dot-react" style={{ background: tag.color || "var(--accent)" }} />
              <span>{tag.name}</span>
            </div>
          ))}
        </div>
        <div className="modal-footer-react">
          <button className="modal-action-btn-react" onClick={onClose}>{t("materials.modal.cancel")}</button>
          <button className="modal-action-btn-react primary" onClick={onApply}>{t("materials.modal.save")}</button>
        </div>
      </div>
    </div>
  );
}

function ModalHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="modal-header-react">
      <div className="modal-title-react">{title}</div>
      <button className="modal-close-react" onClick={onClose}>
        <svg viewBox="0 0 16 16" width="14" height="14" stroke="currentColor" fill="none" strokeWidth="2">
          <line x1="4" y1="4" x2="12" y2="12" />
          <line x1="12" y1="4" x2="4" y2="12" />
        </svg>
      </button>
    </div>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.2" />
      <path d="M21 17l-5-5-7 7" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16"><path d="M2 4h5l2 2h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" /></svg>
  );
}

// ========== 工具函数 ==========

function readInitialMaterialZoom(libraryId?:string|null): number {
  try {
    const saved = parseInt(readMaterialLibraryPreference("luckyray-materials-zoom-v1",libraryId) || "", 10);
    return Number.isFinite(saved) && saved >= 60 && saved <= 300 ? saved : 160;
  } catch {
    return 160;
  }
}

function loadViewMode(libraryId?:string|null): ViewMode {
  try {
    const value = readMaterialLibraryPreference(VIEW_STORAGE_KEY,libraryId);
    if (value === "masonry" || value === "grid" || value === "list") return value;
  } catch {}
  return "masonry";
}

function isImageAsset(asset: Asset): boolean {
  return (asset.kind || "").toLowerCase() === "image" || (asset.mimeType || "").startsWith("image/");
}

function isVideoAsset(asset: Asset): boolean {
  return (asset.kind || "").toLowerCase() === "video" || (asset.mimeType || "").startsWith("video/");
}

function getAssetKindLabel(asset: Asset, t: MaterialsT): string {
  const kind = (asset.kind || "").toLowerCase();
  const mime = (asset.mimeType || "").toLowerCase();
  if (kind === "video" || mime.startsWith("video/")) return t("materials.filter.video");
  if (kind === "image" || mime.startsWith("image/")) return t("materials.filter.image");
  if (kind === "audio" || mime.startsWith("audio/")) return t("materials.filter.audio");
  if (kind === "document" || mime.includes("pdf") || mime.includes("text")) return t("materials.filter.document");
  return t("materials.kind.material");
}

function normalizeStorageMode(value: Asset["storageMode"]): AssetStorageMode {
  return value === "managed" || value === "source" ? value : "linked";
}

function getFileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function getExtensionWithDot(name: string): string {
  const fileName = getFileNameFromPath(name);
  const index = fileName.lastIndexOf(".");
  return index > 0 ? fileName.slice(index) : "";
}

function getRealRenamePreviewName(input: string, currentPath: string): string {
  const raw = input.trim();
  if (!raw) return "";
  const originalExt = getExtensionWithDot(getFileNameFromPath(currentPath));
  const nextExt = getExtensionWithDot(raw);
  return originalExt && !nextExt ? `${raw}${originalExt}` : raw;
}

function getRealRenameTargetPath(asset: Asset): string {
  const mode = normalizeStorageMode(asset.storageMode);
  if (mode === "managed") return asset.libraryPath || "";
  if (mode === "source") return asset.libraryPath || asset.originalPath || "";
  return "";
}

function canRenameRealAssetFile(asset: Asset): boolean {
  const path = getRealRenameTargetPath(asset).trim();
  return Boolean(path && !path.startsWith("browser:") && !path.startsWith("dropped:"));
}

function getStorageModeShortLabel(value: Asset["storageMode"], t: MaterialsT): string {
  const mode = normalizeStorageMode(value);
  if (mode === "managed") return t("materials.storage.short.managed");
  if (mode === "source") return t("materials.storage.short.source");
  return t("materials.storage.short.linked");
}

function getStorageModeLabel(value: AssetStorageMode, t: MaterialsT): string {
  if (value === "managed") return t("materials.storage.managed");
  if (value === "source") return t("materials.storage.source");
  return t("materials.storage.linked");
}

function shouldOfferPhysicalDelete(asset: Asset): boolean {
  const mode = normalizeStorageMode(asset.storageMode);
  if (mode === "managed") return Boolean(asset.libraryPath);
  if (mode === "source") {
    const settings = readSavedSettings();
    if (settings["materials.sourceDeletePolicy"] === "recordOnly") return false;
    return Boolean(asset.libraryPath || asset.originalPath);
  }
  return false;
}

function formatImportProgressLabel(progress: MaterialImportProgress, t: MaterialsT): string {
  if (progress.phase === "copying") return progress.name ? t("materials.import.copyNamed", { name: progress.name }) : t("materials.import.copying");
  if (progress.phase === "done") return t("materials.import.done");
  return progress.name ? t("materials.import.importNamed", { name: progress.name }) : t("materials.import.importing");
}

function mergeAssetLists(primary: Asset[], existing: Asset[]): Asset[] {
  const seen = new Set<string>();
  const result: Asset[] = [];
  for (const asset of [...primary, ...existing]) {
    if (!asset?.id || seen.has(asset.id)) continue;
    seen.add(asset.id);
    result.push(asset);
  }
  return result;
}

function escapeCssIdentifier(value: string): string {
  const css = globalThis.CSS as { escape?: (input: string) => string } | undefined;
  if (css?.escape) return css.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

function getTimeValue(value?: string | null): number {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function hexToRgb(value: string): { r: number; g: number; b: number } | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const hex = match[1];
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

function rgbSaturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  return max === 0 ? 0 : (max - min) / max;
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0")).join("")}`;
}

function colorDistanceSq(a: string, b: string): number {
  const rgbA = hexToRgb(a);
  const rgbB = hexToRgb(b);
  if (!rgbA || !rgbB) return Number.POSITIVE_INFINITY;
  return ((rgbA.r - rgbB.r) ** 2) + ((rgbA.g - rgbB.g) ** 2) + ((rgbA.b - rgbB.b) ** 2);
}

type MaterialColorBounds = { left: number; top: number; right: number; bottom: number };

function lineColorStats(pixels: Uint8ClampedArray, size: number, axis: "x" | "y", line: number) {
  let count = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumSq = 0;
  for (let i = 0; i < size; i += 1) {
    const x = axis === "x" ? line : i;
    const y = axis === "y" ? line : i;
    const offset = (y * size + x) * 4;
    if (pixels[offset + 3] < 160) continue;
    const r = pixels[offset];
    const g = pixels[offset + 1];
    const b = pixels[offset + 2];
    sumR += r;
    sumG += g;
    sumB += b;
    sumSq += r * r + g * g + b * b;
    count += 1;
  }
  if (count === 0) return { brightness: 0, saturation: 0, deviation: 0 };
  const r = sumR / count;
  const g = sumG / count;
  const b = sumB / count;
  const meanSq = sumSq / (count * 3);
  const channelMean = (r + g + b) / 3;
  const deviation = Math.sqrt(Math.max(0, meanSq - channelMean * channelMean));
  return {
    brightness: (r * 299 + g * 587 + b * 114) / 255000,
    saturation: rgbSaturation(r, g, b),
    deviation,
  };
}

function isLikelyMatteEdge(pixels: Uint8ClampedArray, size: number, axis: "x" | "y", line: number): boolean {
  const stats = lineColorStats(pixels, size, axis, line);
  return stats.deviation < 18 && (stats.brightness < 0.1 || stats.brightness > 0.92 || stats.saturation < 0.06);
}

function detectMaterialContentBounds(pixels: Uint8ClampedArray, size: number): MaterialColorBounds {
  const maxTrim = Math.floor(size * 0.3);
  let left = 0;
  let right = size - 1;
  let top = 0;
  let bottom = size - 1;

  while (top < maxTrim && isLikelyMatteEdge(pixels, size, "y", top)) top += 1;
  while (bottom > size - 1 - maxTrim && isLikelyMatteEdge(pixels, size, "y", bottom)) bottom -= 1;
  while (left < maxTrim && isLikelyMatteEdge(pixels, size, "x", left)) left += 1;
  while (right > size - 1 - maxTrim && isLikelyMatteEdge(pixels, size, "x", right)) right -= 1;

  const minSpan = Math.floor(size * 0.45);
  if (right - left + 1 < minSpan || bottom - top + 1 < minSpan) {
    return { left: 0, top: 0, right: size - 1, bottom: size - 1 };
  }
  return { left, top, right, bottom };
}

async function loadImageForCanvas(src: string): Promise<{ image: HTMLImageElement; cleanup: () => void }> {
  let objectUrl = "";
  let imageSrc = src;
  if (!src.startsWith("data:")) {
    try {
      const response = await fetch(src);
      if (response.ok) {
        objectUrl = URL.createObjectURL(await response.blob());
        imageSrc = objectUrl;
      }
    } catch {
      imageSrc = src;
    }
  }
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    if (/^https?:\/\//i.test(imageSrc)) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = imageSrc;
  });
  return {
    image,
    cleanup: () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    },
  };
}

async function extractDominantMaterialPalette(src: string): Promise<string> {
  const { image, cleanup } = await loadImageForCanvas(src);
  try {
    const sampleSize = 64;
    const canvas = document.createElement("canvas");
    canvas.width = sampleSize;
    canvas.height = sampleSize;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("canvas unavailable");
    context.drawImage(image, 0, 0, sampleSize, sampleSize);
    const pixels = context.getImageData(0, 0, sampleSize, sampleSize).data;
    const bounds = detectMaterialContentBounds(pixels, sampleSize);
    const buckets = new Map<string, { r: number; g: number; b: number; count: number; score: number }>();
    const quantizeStep = 18;
    const centerX = (bounds.left + bounds.right) / 2;
    const centerY = (bounds.top + bounds.bottom) / 2;
    const halfW = Math.max(1, (bounds.right - bounds.left + 1) / 2);
    const halfH = Math.max(1, (bounds.bottom - bounds.top + 1) / 2);
    for (let y = bounds.top; y <= bounds.bottom; y += 1) {
      for (let x = bounds.left; x <= bounds.right; x += 1) {
        const index = (y * sampleSize + x) * 4;
        const alpha = pixels[index + 3];
        if (alpha < 160) continue;
        const r = pixels[index];
        const g = pixels[index + 1];
        const b = pixels[index + 2];
        const saturation = rgbSaturation(r, g, b);
        const brightness = (r * 299 + g * 587 + b * 114) / 255000;
        const edgeDistance = Math.max(Math.abs(x - centerX) / halfW, Math.abs(y - centerY) / halfH);
        const centerWeight = 1 - Math.min(0.38, edgeDistance * 0.38);
        const key = [
          Math.round(r / quantizeStep),
          Math.round(g / quantizeStep),
          Math.round(b / quantizeStep),
        ].join("-");
        const weight = (0.75 + saturation * 0.9 + Math.min(brightness, 1 - brightness) * 0.25) * centerWeight;
        const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, count: 0, score: 0 };
        bucket.r += r;
        bucket.g += g;
        bucket.b += b;
        bucket.count += 1;
        bucket.score += weight;
        buckets.set(key, bucket);
      }
    }

    const rankedColors = Array.from(buckets.values())
      .filter((bucket) => bucket.count >= 3)
      .map((bucket) => ({
        color: rgbToHex(bucket.r / bucket.count, bucket.g / bucket.count, bucket.b / bucket.count),
        score: bucket.score,
      }))
      .sort((a, b) => b.score - a.score);

    const palette: string[] = [];
    for (const item of rankedColors) {
      if (palette.every((color) => colorDistanceSq(color, item.color) > 900)) {
        palette.push(item.color);
      }
      if (palette.length >= 5) break;
    }

    if (palette.length < 5) {
      for (const item of rankedColors) {
        if (!palette.includes(item.color)) palette.push(item.color);
        if (palette.length >= 5) break;
      }
    }

    return serializeMaterialPalette(palette);
  } finally {
    cleanup();
  }
}

function getAdjacentAsset(asset: Asset | null, assets: Asset[], direction: -1 | 1): Asset | null {
  if (!asset || assets.length === 0) return asset;
  const index = assets.findIndex((item) => item.id === asset.id);
  if (index < 0) return asset;
  const nextIndex = (index + direction + assets.length) % assets.length;
  return assets[nextIndex];
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function formatDate(value: string, locale: Locale = "zh-CN"): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString(locale, { year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    return value;
  }
}
