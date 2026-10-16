import { Children, cloneElement, isValidElement, useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import LightSeekToolsMenu from "../features/ai/LightSeekToolsMenu";
import {windowLayoutStore} from '../workspace/layoutStore';
import {arrangeControls,defaultPresentation,materialsToolbarControls,reorderVisibleControl,type ControlOrder} from '../workspace/presentation';
import {beginControlPointerDrag} from '../workspace/controlPointerDrag';
import {IntegratedLayoutManager} from '../workspace/IntegratedLayoutManager';
import {notesNativeViews} from '../features/notes/notesNativeViewRegistry';
import {graphNativeViews} from '../features/graph/graphNativeViewRegistry';
import {resolveNavigationPresentation} from '../workspace/navigationVisibility';
import {beginNotesTabPointerDrag} from '../features/notes/notesPaneDocking';
import {graphSessionStore} from '../features/graph/graphSessionStore';
import {beginGraphTabPointerDrag} from '../features/graph/graphTabPointerDrag';
import { TitlebarMaterialSearch } from "./TitlebarMaterialSearch";
import { PhoneConnectionEntry } from "../features/settings/PhoneConnectionDialog";
import { FolderTree, type FolderTreeExternalDrop } from "../features/folders/FolderTree";
import { useFolders } from "../features/folders/useFolders";
import { MaterialLibraryNavigation } from "../features/materials/MaterialLibraryNavigation";
import { materialLibraryDisplayName } from "../features/materials/materialLibraryNavigationProtocol";
import { materialLibrarySession } from "../core/services/materialLibraryContext";
import { requestMaterialLibraryCopy } from "../core/services/materialLibraryTransfers";
import { readSavedSettings, type SettingsMap } from "../features/settings/useSettings";
import { useI18n, type I18nContextValue, type MessageKey } from "../core/i18n/index";
import { focusEntity } from "../core/services/context";
import { moveActiveMaterialExternalDragToFolder } from "../core/services/materials";
import { hasUsableKnowledgeSnapshot, knowledgeStore } from "../core/services/knowledgeStore";
import { nativeTitlebarDragRegion } from "./windowChromePolicy";
import lightSeekHarnessMarkUrl from "../assets/branding/lightseek-harness-mark.svg";
import canvasIconUrl from "../assets/icons/lightseek-ui-v2/canvas.svg";
import collectionIconUrl from "../assets/icons/lightseek-ui-v2/collection.svg";
import communityIconUrl from "../assets/icons/lightseek-ui-v2/community.svg";
import favoriteIconUrl from "../assets/icons/lightseek-ui-v2/favorite.svg";
import knowledgeGraphIconUrl from "../assets/icons/lightseek-ui-v2/knowledge-graph.svg";
import knowledgeLibraryIconUrl from "../assets/icons/lightseek-ui-v2/knowledge-library.svg";
import settingsIconUrl from "../assets/icons/lightseek-ui-v2/settings.svg";
import { SidebarBrandHeader } from "./SidebarBrandHeader";
import smartFolderIconUrl from "../assets/icons/lightseek-ui-v2/smart-folder.svg";
import tagIconUrl from "../assets/icons/lightseek-ui-v2/tag.svg";
import {
  MATERIALS_FILTER_PANEL_ID,
  MATERIALS_MISSING_PANEL_ID,
  MATERIALS_SORT_OPTIONS,
  MATERIALS_TOOLBAR_STATE_EVENT,
  MATERIALS_VIEW_ORDER,
  dispatchMaterialsToolbarCommand,
  type MaterialsToolbarState,
  type MaterialsViewMode,
} from "../features/materials/materialsToolbarProtocol";

export type ShellRoute = "materials" | "attachments" | "notes" | "graph" | "canvas" | "browser" | "community" | "ai" | "tags" | "collection" | "favorites" | "smart" | "settings" | "plugins";

type NavItem = {
  id: ShellRoute;
  labelKey: MessageKey;
  icon: React.ReactNode;
};

const SPACE_NAV: NavItem[] = [
  { id: "materials", labelKey: "sidebar.route.materials", icon: <IconGrid /> },
  { id: "notes", labelKey: "sidebar.route.notes", icon: <MaskedSidebarIcon src={knowledgeLibraryIconUrl} /> },
  { id: "graph", labelKey: "sidebar.route.graph", icon: <MaskedSidebarIcon src={knowledgeGraphIconUrl} /> },
  { id: "canvas", labelKey: "sidebar.route.canvas", icon: <MaskedSidebarIcon src={canvasIconUrl} /> },
  { id: "community", labelKey: "sidebar.route.community", icon: <MaskedSidebarIcon src={communityIconUrl} /> },
  { id: "ai", labelKey: "sidebar.route.ai", icon: <MaskedSidebarIcon src={lightSeekHarnessMarkUrl} brand /> },
];

const FILTER_NAV: NavItem[] = [
  { id: "tags", labelKey: "sidebar.route.tags", icon: <MaskedSidebarIcon src={tagIconUrl} /> },
  { id: "collection", labelKey: "sidebar.route.collection", icon: <MaskedSidebarIcon src={collectionIconUrl} /> },
  { id: "favorites", labelKey: "sidebar.route.favorites", icon: <MaskedSidebarIcon src={favoriteIconUrl} /> },
  { id: "smart", labelKey: "sidebar.route.smartFolders", icon: <MaskedSidebarIcon src={smartFolderIconUrl} /> },
];

const SIDEBAR_KEY = "luckyray-sidebar-collapsed-v1";

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

export type SidebarPluginPage = {
  key: string;
  label: string;
  packageName: string;
  path: string;
};

export function AppSidebar({
  route,
  onNavigate,
  applicationModalIsolated = false,
  compactAutoCollapsed = false,
  compactExpanded = false,
  onCompactToggle,
  onManualToggle,
  pluginPages = [],
  activePluginPagePath,
  onOpenPluginPage,
  onOpenPhone,
}: {
  route: ShellRoute;
  onNavigate: (page: ShellRoute) => void;
  applicationModalIsolated?: boolean;
  compactAutoCollapsed?: boolean;
  compactExpanded?: boolean;
  onCompactToggle?: () => void;
  onManualToggle?: () => void;
  /** Host-projected plugin page entries, appended at the end of the filters group. */
  pluginPages?: SidebarPluginPage[];
  activePluginPagePath?: string;
  onOpenPluginPage?: (path: string) => void;
  onOpenPhone?: () => void;
}) {
  const { t } = useI18n();
  const [workspaceStore]=useState(()=>windowLayoutStore('main'));
  const workspaceLayout=useSyncExternalStore(workspaceStore.subscribe,workspaceStore.getSnapshot);
  const [managingLayout,setManagingLayout]=useState(false);
  const [persistedCollapsed, setPersistedCollapsed] = useState(loadCollapsed);
  const [folderRevealExpanded, setFolderRevealExpanded] = useState(false);
  const [settingsSnapshot, setSettingsSnapshot] = useState(readSavedSettings);
  const presentation=resolveNavigationPresentation(workspaceLayout.presentation??defaultPresentation(),settingsSnapshot["general.showCollectionNav"]===true);
  const folderScope = route === "materials" ? route : null;
  const showCollectionNav = !presentation.navigation.filters.hidden.includes("collection");
  const filterNav = useMemo(
    () => FILTER_NAV.filter((item) => item.id !== "collection" || showCollectionNav),
    [showCollectionNav],
  );
  const naturallyCollapsed = compactAutoCollapsed ? !compactExpanded : persistedCollapsed;
  const effectiveCollapsed = folderRevealExpanded ? false : naturallyCollapsed;

  const toggle = useCallback(() => {
    if (folderRevealExpanded && naturallyCollapsed) {
      setFolderRevealExpanded(false);
      onManualToggle?.();
      return;
    }
    if (compactAutoCollapsed) {
      onCompactToggle?.();
      return;
    }
    onManualToggle?.();
    setPersistedCollapsed((value) => {
      const next = !value;
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
      } catch {}
      return next;
    });
  }, [compactAutoCollapsed, folderRevealExpanded, naturallyCollapsed, onCompactToggle, onManualToggle]);

  useEffect(() => {
    setFolderRevealExpanded(false);
  }, [route]);

  useEffect(() => {
    const revealFolder = (event: Event) => {
      const detail = (event as CustomEvent<{ scope?: string; folderId?: string | null; status?: string }>).detail;
      if (detail?.scope === "materials" && detail.status !== "missing" && naturallyCollapsed) setFolderRevealExpanded(true);
    };
    window.addEventListener("luckyray:folder-reveal", revealFolder);
    return () => window.removeEventListener("luckyray:folder-reveal", revealFolder);
  }, [naturallyCollapsed]);

  useEffect(() => {
    window.addEventListener("luckyray:shell-toggle-sidebar", toggle);
    return () => window.removeEventListener("luckyray:shell-toggle-sidebar", toggle);
  }, [toggle]);

  useEffect(() => {
    const onSettings = (event: Event) => {
      const next = (event as CustomEvent<{ settings?: Partial<SettingsMap> }>).detail?.settings;
      setSettingsSnapshot((current) => ({ ...current, ...(next || readSavedSettings()) } as SettingsMap));
    };
    window.addEventListener("luckyray:settings-change", onSettings);
    return () => window.removeEventListener("luckyray:settings-change", onSettings);
  }, []);

  const handleNav = useCallback((id: NavItem["id"]) => onNavigate(id), [onNavigate]);
  const reorderNavigation = (section: 'space'|'filters', id: string, index: number) => {
    const current = resolveNavigationPresentation(workspaceStore.getSnapshot().presentation ?? defaultPresentation(),settingsSnapshot["general.showCollectionNav"]===true);
    const items = section === 'space' ? SPACE_NAV : filterNav;
    const value = reorderVisibleControl(current.navigation[section], id, index, arrangeControls(items,current.navigation[section]).map(item=>item.id));
    workspaceStore.dispatch({type:'presentation',presentation:{...current,navigation:{...current.navigation,[section]:value}}});
  };

  return (
    <aside
      className={`sidebar${effectiveCollapsed ? " collapsed" : ""}`}
      id="sidebar"
      inert={applicationModalIsolated || undefined}
      aria-hidden={applicationModalIsolated || undefined}
    >
      <SidebarBrandHeader
        collapsed={effectiveCollapsed}
        onToggle={toggle}
        expandLabel={t("sidebar.action.expand")}
        collapseLabel={t("sidebar.action.collapse")}
      />

      <nav className="sidebar-nav" id="main-sidebar-navigation">
        <NavSection title={t("sidebar.section.space")} group="space">
          {arrangeControls(SPACE_NAV,presentation.navigation.space).map((item) => (
            <NavRow
              key={item.id}
              item={item}
              active={route === item.id}
              onClick={() => handleNav(item.id)}
              onMove={(id,index)=>reorderNavigation("space",id,index)}
            />
          ))}
        </NavSection>

        <NavSection title={t("sidebar.section.filters")} group="filters">
          {arrangeControls(filterNav,presentation.navigation.filters).map((item) => (
            <NavRow
              key={item.id}
              item={item}
              active={route === item.id}
              onClick={() => handleNav(item.id)}
              onMove={(id,index)=>reorderNavigation("filters",id,index)}
            />
          ))}
          {pluginPages.map((page) => (
            <div
              key={page.key}
              className={`nav-item${activePluginPagePath === page.path ? " active" : ""}`}
              aria-current={activePluginPagePath === page.path ? "page" : undefined}
              title={`${page.packageName} · ${page.label}`}
              onClick={() => onOpenPluginPage?.(page.path)}
            >
              <span className="nav-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h4"/></svg></span>
              <span className="nav-label">{page.label}</span>
            </div>
          ))}
        </NavSection>

        {folderScope && (
          <div className="nav-section" id="folder-section">
            <FolderSection scope={folderScope} onNavigate={onNavigate} />
          </div>
        )}
      </nav>

      <div className="sidebar-footer">
        <button className="sidebar-toggle" title="管理布局" aria-label="管理布局" onClick={()=>{if(!notesNativeViews.hasFrozenViews()&&!graphNativeViews.hasFrozenViews())setManagingLayout(true);}}><span className="nav-icon"><IconGrid /></span><span className="toggle-text">布局</span></button>
        {onOpenPhone && <PhoneConnectionEntry onOpen={onOpenPhone} />}
        <div className={`nav-item${route === "settings" ? " active" : ""}`} onClick={() => onNavigate("settings")}>
          <span className="nav-icon"><MaskedSidebarIcon src={settingsIconUrl} /></span>
          <span className="nav-label">{t("sidebar.route.settings")}</span>
        </div>
      </div>
      {managingLayout&&<IntegratedLayoutManager store={workspaceStore} route={route} onClose={()=>setManagingLayout(false)}/>}
      {workspaceStore.storageError&&<span className="sidebar-layout-error" role="status">{workspaceStore.storageError}</span>}
    </aside>
  );
}

function NavSection({ title, children, group }: { title: string; children: React.ReactNode; group?: string }) {
  return (
    <div className="nav-section" data-control-group={group} data-control-axis="vertical">
      <div className="nav-section-title">{title}</div>
      {children}
    </div>
  );
}

function NavRow({ item, active, onClick, onMove }: { item: NavItem; active: boolean; onClick: () => void; onMove: (id:string,index:number)=>void }) {
  const { t } = useI18n();
  return (
    <div className={`nav-item${active ? " active" : ""}`} onClick={onClick}
      role="button" tabIndex={0} aria-current={active?'page':undefined}
      data-control-id={item.id} data-tauri-no-drag="true"
      onPointerDown={event=>beginControlPointerDrag(event,onMove)}
      onKeyDown={event=>{
        if(event.altKey&&(event.key==='ArrowUp'||event.key==='ArrowDown')){
          event.preventDefault();const ids=Array.from(event.currentTarget.closest('[data-control-group]')!.querySelectorAll<HTMLElement>('[data-control-id]')).map(row=>row.dataset.controlId!);
          onMove(item.id,ids.indexOf(item.id)+(event.key==='ArrowUp'?-1:1));
        }else if(event.key==='Enter'||event.key===' '){event.preventDefault();onClick();}
      }}>
      <span className="nav-icon">{item.icon}</span>
      <span className="nav-label">{t(item.labelKey)}</span>
    </div>
  );
}

function MaskedSidebarIcon({
  src,
  brand = false,
  control = false,
}: {
  src: string;
  brand?: boolean;
  control?: boolean;
}) {
  const className = [
    "sidebar-masked-icon",
    brand ? "lightseek-harness-mark" : "",
    control ? "sidebar-toggle-icon" : "",
  ].filter(Boolean).join(" ");
  return (
    <span
      className={className}
      style={{ "--sidebar-icon-url": `url("${src}")` } as CSSProperties}
      aria-hidden="true"
    />
  );
}

function FolderSection({ scope, onNavigate }: { scope: "materials" | "notes"; onNavigate: (page: ShellRoute) => void }) {
  const { plural, t } = useI18n();
  const library = useSyncExternalStore(materialLibrarySession.subscribe, materialLibrarySession.getSnapshot);
  const { folders, createFolder, renameFolder, deleteFolder, moveFolder } = useFolders(scope);
  const [selectedByScope, setSelectedByScope] = useState<Record<"materials" | "notes", string | null>>({
    materials: null,
    notes: null,
  });
  const [folderDialog, setFolderDialog] = useState<{ parentId: string | null; name: string } | null>(null);
  const [folderStatus, setFolderStatus] = useState("");
  const [folderRevealRequest, setFolderRevealRequest] = useState<{ folderId: string | null; ancestorIds: string[]; nonce: number } | null>(null);

  const selectedId = selectedByScope[scope];

  const handleCreate = useCallback((parentId: string | null) => {
    setFolderDialog({ parentId, name: "" });
  }, []);

  const submitCreate = useCallback(async () => {
    const dialog = folderDialog;
    if (!dialog) return;
    const name = dialog.name.trim();
    if (!name) return;
    await createFolder(dialog.parentId, name);
    setFolderDialog(null);
  }, [createFolder, folderDialog]);

  const showFolderStatus = useCallback((message: string) => {
    setFolderStatus(message);
    window.setTimeout(() => setFolderStatus(""), 2400);
  }, []);

  const selectFolder = useCallback((folderId: string | null) => {
    setSelectedByScope((current) => ({ ...current, [scope]: folderId }));
    window.dispatchEvent(new CustomEvent("luckyray:folder-select", {
      detail: { scope, folderId },
    }));
  }, [scope]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("luckyray:folder-select", {
      detail: { scope, folderId: selectedId },
    }));
  }, [scope, selectedId]);

  useEffect(() => {
    const revealFolder = (event: Event) => {
      const detail = (event as CustomEvent<{ scope?: "materials" | "notes"; folderId?: string | null; ancestorIds?: string[]; nonce?: number }>).detail;
      if (detail?.scope && detail.scope !== scope) return;
      setSelectedByScope((current) => ({ ...current, [scope]: detail?.folderId ?? null }));
      setFolderRevealRequest({
        folderId: detail?.folderId ?? null,
        ancestorIds: Array.isArray(detail?.ancestorIds) ? detail.ancestorIds : [],
        nonce: typeof detail?.nonce === "number" ? detail.nonce : Date.now(),
      });
    };
    window.addEventListener("luckyray:folder-reveal", revealFolder);
    return () => window.removeEventListener("luckyray:folder-reveal", revealFolder);
  }, [scope]);

  const handleFolderImport = useCallback(async (folderId: string | null) => {
    if (scope === "materials") {
      window.dispatchEvent(new CustomEvent("luckyray:materials-import", { detail: { folderId } }));
      showFolderStatus(t("sidebar.status.importMaterials"));
      return;
    }
    const bridge = (window as any).__LUCKYRAY__;
    if (!bridge?.importNotesMarkdown) {
      showFolderStatus(t("sidebar.status.noteImportUnsupported"));
      return;
    }
    try {
      const result = await bridge.importNotesMarkdown({ folderId });
      if (result?.notes?.[0]?.id) {
        focusEntity("note", result.notes[0].id);
        onNavigate("notes");
        window.dispatchEvent(new CustomEvent("luckyray:notes-imported", {
          detail: {
            noteIds: result.notes.map((note: { id: string }) => note.id),
            importedAttachments: result.importedAttachments || 0,
          },
        }));
      }
      const attachmentText = result?.importedAttachments ? plural(result.importedAttachments, {
        one: "sidebar.status.attachmentsRecognized.one",
        other: "sidebar.status.attachmentsRecognized.other",
      }) : "";
      showFolderStatus(result?.count ? plural(result.count, {
        one: "sidebar.status.notesImported.one",
        other: "sidebar.status.notesImported.other",
      }, { attachments: attachmentText }) : t("sidebar.status.noNotesSelected"));
    } catch (error) {
      console.warn("[AppSidebar] import notes markdown failed", error);
      showFolderStatus(t("sidebar.status.noteImportFailed"));
    }
  }, [onNavigate, plural, scope, showFolderStatus, t]);

  const handleFolderExport = useCallback(async () => {
    const bridge = (window as any).__LUCKYRAY__;
    try {
      if (scope === "notes" && bridge?.exportNotesMarkdown) {
        await bridge.exportNotesMarkdown();
        showFolderStatus(t("sidebar.status.notesExported"));
        return;
      }
      if (scope === "materials" && bridge?.exportAssetsIndex) {
        await bridge.exportAssetsIndex();
        showFolderStatus(t("sidebar.status.materialIndexExported"));
        return;
      }
      showFolderStatus(t("sidebar.status.exportUnsupported"));
    } catch {
      showFolderStatus(t("sidebar.status.exportFailed"));
    }
  }, [scope, showFolderStatus, t]);

  const handleFolderOriginalExport = useCallback((folderId: string | null) => {
    if (scope !== "materials") return;
    window.dispatchEvent(new CustomEvent("luckyray:materials-export-folder", {
      detail: { folderId },
    }));
  }, [scope]);

  const handleCreateNoteInFolder = useCallback(async (folderId: string) => {
    const bridge = (window as any).__LUCKYRAY__;
    if (!bridge?.createNote) {
      showFolderStatus(t("sidebar.status.newNoteUnsupported"));
      return;
    }
    try {
      const note = await bridge.createNote({ title: t("sidebar.note.untitled"), folderId, contentText: "" });
      if (note?.id) {
        focusEntity("note", note.id);
        onNavigate("notes");
        showFolderStatus(t("sidebar.status.noteCreated"));
      }
    } catch {
      showFolderStatus(t("sidebar.status.noteCreateFailed"));
    }
  }, [onNavigate, showFolderStatus, t]);

  const handleExternalMaterialDrop = useCallback(async (
    folderId: string | null,
    drop: FolderTreeExternalDrop,
  ) => {
    if (scope !== "materials" || drop.source !== "tauri") return;
    try {
      const result = await moveActiveMaterialExternalDragToFolder(folderId);
      if (!result) {
        window.dispatchEvent(new CustomEvent("luckyray:materials-native-folder-import", {
          detail: { paths: drop.paths, folderId },
        }));
        showFolderStatus(t("sidebar.status.materialImporting"));
        return;
      }
      if (result.moved === 0) {
        showFolderStatus(t("sidebar.status.materialMoveFailed"));
        return;
      }
      if (result.moved !== result.total) {
        showFolderStatus(plural(result.total, { one: "sidebar.status.materialsMoved.one", other: "sidebar.status.materialsMoved.other" }, { moved: result.moved, total: result.total }));
      } else {
        showFolderStatus(plural(result.moved, {
          one: "sidebar.status.materialMovedCount.one",
          other: "sidebar.status.materialMovedCount.other",
        }));
      }
      window.dispatchEvent(new CustomEvent("luckyray:materials-data-changed", {
        detail: { reason: "native-folder-drop", folderId },
      }));
    } catch {
      showFolderStatus(t("sidebar.status.materialMoveFailed"));
    }
  }, [plural, scope, showFolderStatus, t]);

  return (
    <>
      <div className="nav-section-title" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span id="folder-section-label">{scope === "materials" ? t("sidebar.folder.materials") : t("sidebar.folder.notes")}</span>
        <button className="folder-section-add-btn" onClick={() => void handleCreate(null)} title={t("sidebar.folder.create")}>
          <svg viewBox="0 0 16 16" width="12" height="12" stroke="currentColor" fill="none" strokeWidth="2"><line x1="8" y1="4" x2="8" y2="12" /><line x1="4" y1="8" x2="12" y2="8" /></svg>
        </button>
      </div>
      <div id="folder-list">
        <FolderTree
          folders={folders}
          selectedId={selectedId}
          onSelect={selectFolder}
          onCreate={handleCreate}
          revealRequest={folderRevealRequest}
          scope={scope}
          onRename={renameFolder}
          onDelete={deleteFolder}
          onMove={moveFolder}
          onImport={handleFolderImport}
          onExport={handleFolderExport}
          onExportOriginals={scope === "materials" ? handleFolderOriginalExport : undefined}
          onExportCsv={scope === "materials" ? (folderId) => {
            window.dispatchEvent(new CustomEvent("luckyray:materials-export-folder-csv", { detail: { folderId } }));
          } : undefined}
          onCopyToLibrary={scope === "materials" && library.libraryId ? folderId => requestMaterialLibraryCopy({ libraryId: library.libraryId!, selection: { folderId }, label: "此分类及子分类" }) : undefined}
          onExternalDrop={scope === "materials" ? handleExternalMaterialDrop : undefined}
          onCreateNote={handleCreateNoteInFolder}
          className="shell-folder-tree"
          allLabel={scope === "materials" ? materialLibraryDisplayName(library.libraryId, library.registry) : t("sidebar.folder.allNotes")}
          allControl={scope === "materials" ? <MaterialLibraryNavigation onViewAll={() => selectFolder(null)} /> : undefined}
          showUncategorized={scope === "notes"}
          onUncategorized={() => selectFolder("__uncategorized__")}
        />
        {folderStatus && <div className="shell-folder-status">{folderStatus}</div>}
      </div>
      {folderDialog && (
        <div className="shell-folder-dialog-overlay experience-dialog-backdrop" onPointerDown={() => setFolderDialog(null)}>
          <div className="shell-folder-dialog experience-dialog" role="dialog" aria-modal="true" aria-label={t("sidebar.folder.create")} onPointerDown={(event) => event.stopPropagation()}>
            <div className="shell-folder-dialog-title">{t("sidebar.folder.create")}</div>
            <input
              value={folderDialog.name}
              autoFocus
              placeholder={t("sidebar.folder.namePlaceholder")}
              onChange={(event) => setFolderDialog({ ...folderDialog, name: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submitCreate();
                if (event.key === "Escape") setFolderDialog(null);
              }}
            />
            <div className="shell-folder-dialog-actions">
              <button type="button" onClick={() => setFolderDialog(null)}>{t("common.action.cancel")}</button>
              <button type="button" className="primary" onClick={() => void submitCreate()}>{t("common.action.confirm")}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

type TitlebarProps = {
  route: ShellRoute;
  hashPath?: string;
  onOpenSearch: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  applicationModalIsolated?: boolean;
  aiPersonalBrowserOpen?: boolean;
  onToggleAiPersonalBrowser?: () => void;
  aiContentBrowserOpen?: boolean;
  onToggleAiContentBrowser?: () => void;
  lightSeekRestarting?: boolean;
  onRestartLightSeek?: () => void;
  onLightSeekToolsOpenChange?: (open: boolean) => void;
};

type NoteTabState = {
  viewId?: string;
  id: string;
  title: string;
  kind?: "note" | "empty";
  noteId?: string | null;
};

type NotesTitlebarPane = {
  activeId: string;
  tabs: Array<{ id: string; viewId?: string; kind: "note" | "empty"; title: string }>;
};
type NotesTitlebarSplit = {
  ratio: number;
  indexOpen: boolean;
  indexWidth: number;
  rootPaneId: string;
  paneId: string | null;
  activePaneId: string;
  root: NotesTitlebarPane;
  pane: NotesTitlebarPane | null;
};

const NOTES_TITLEBAR_SPLIT_EVENT = "luckyray:notes-titlebar-split";
const NOTES_TITLEBAR_PANE_ACTIVATE_EVENT = "luckyray:notes-titlebar-pane-activate";
const NOTES_TITLEBAR_PANE_NEW_EVENT = "luckyray:notes-titlebar-pane-new";
const NOTES_TITLEBAR_PANE_CLOSE_EVENT = "luckyray:notes-titlebar-pane-close";
const NOTES_SPLIT_LIVE_FIRST_TRACK = "--notes-split-live-first-track";

const DEFAULT_MATERIALS_TOOLBAR_STATE: MaterialsToolbarState = {
  viewMode: "masonry",
  workView: "general",
  folderName: null,
  sortBy: "recent",
  filterOpen: false,
  activeFilterCount: 0,
  missingOpen: false,
  exportOpen: false,
  exportRunningCount: 0,
  exportNeedsAttention: false,
};

export function AppTitlebar({
  route,
  hashPath = "",
  onOpenSearch,
  canGoBack = false,
  canGoForward = false,
  onBack,
  onForward,
  applicationModalIsolated = false,
  aiPersonalBrowserOpen = false,
  onToggleAiPersonalBrowser,
  aiContentBrowserOpen = false,
  onToggleAiContentBrowser,
  lightSeekRestarting = false,
  onRestartLightSeek,
  onLightSeekToolsOpenChange,
}: TitlebarProps) {
  const { plural, t } = useI18n();
  const [workspaceStore]=useState(()=>windowLayoutStore('main'));
  const workspaceLayout=useSyncExternalStore(workspaceStore.subscribe,workspaceStore.getSnapshot);
  const materialControlOrder: ControlOrder=workspaceLayout.presentation?.materialsToolbar??{order:materialsToolbarControls,hidden:[]};
  const reorderMaterialControls=(id:string,index:number)=>{
    const current=workspaceStore.getSnapshot().presentation??defaultPresentation();
    const config=current.materialsToolbar??{order:materialsToolbarControls,hidden:[]};
    const visible=materialsToolbarControls.filter(value=>value!=='clear-filter'||materialsToolbarState.activeFilterCount>0);
    workspaceStore.dispatch({type:'presentation',presentation:{...current,materialsToolbar:reorderVisibleControl(config,id,index,arrangeControls(visible.map(id=>({id})),config).map(item=>item.id))}});
  };
  const materialControlProps=(id:string)=>({
    'data-control-id':id,'data-tauri-no-drag':'true',
    onPointerDown:(event:React.PointerEvent<HTMLElement>)=>beginControlPointerDrag(event,reorderMaterialControls),
    onKeyDown:(event:React.KeyboardEvent<HTMLElement>)=>{
      if(!event.altKey||(event.key!=='ArrowLeft'&&event.key!=='ArrowRight'))return;
      event.preventDefault();const ids=Array.from(event.currentTarget.closest('[data-control-group]')!.querySelectorAll<HTMLElement>('[data-control-id]')).map(row=>row.dataset.controlId!);
      reorderMaterialControls(id,ids.indexOf(id)+(event.key==='ArrowLeft'?-1:1));
    }
  });
  const [materialsToolbarState, setMaterialsToolbarState] = useState<MaterialsToolbarState>(DEFAULT_MATERIALS_TOOLBAR_STATE);
  const [missingCount, setMissingCount] = useState(0);
  const [noteTabs, setNoteTabs] = useState<NoteTabState[]>([]);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [notesIndexOpen, setNotesIndexOpen] = useState(true);
  const [notesIndexWidth, setNotesIndexWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem("luckyray-notes-index-width-v1"));
      return Number.isFinite(saved) && saved > 0 ? saved : 272;
    } catch {
      return 272;
    }
  });
  const graphSession=useSyncExternalStore(graphSessionStore.subscribe,graphSessionStore.getSnapshot);
  const graphTabs=graphSession.tabs.map(tab=>({...tab,title:tab.title||(tab.number===1?t("sidebar.graph.title"):t("sidebar.graph.numberedTitle",{number:tab.number}))}));
  const activeGraphId=graphSession.activeTabId;
  const [notesTitlebarSplit, setNotesTitlebarSplit] = useState<NotesTitlebarSplit | null>(null);
  const [notesSplitMenuOpen, setNotesSplitMenuOpen] = useState(false);
  const [notesRootSplitMenuOpen, setNotesRootSplitMenuOpen] = useState(false);
  const [notesChildSplitMenuOpen, setNotesChildSplitMenuOpen] = useState(false);
  const [zoom, setZoom] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("luckyray-materials-zoom-v1");
      const val = saved ? parseInt(saved, 10) : 160;
      return val >= 60 && val <= 300 ? val : 160;
    } catch { return 160; }
  });
  const isMaterials = route === "materials";
  const isNotes = route === "notes";
  const isGraph = route === "graph";
  const subscribeKnowledgeStore = useCallback((listener: () => void) => knowledgeStore.subscribe(listener), []);
  const knowledgeSnapshot = useSyncExternalStore(subscribeKnowledgeStore, knowledgeStore.getSnapshot, knowledgeStore.getSnapshot);
  // Knowledge titlebar actions (new tab / split) enter with the loaded Knowledge
  // UI and stay stable across background refreshes once content is usable.
  const notesTitlebarActionsReady = hasUsableKnowledgeSnapshot(knowledgeSnapshot);
  const isNotesHorizontalSplit = Boolean(notesTitlebarSplit?.paneId && notesTitlebarSplit.pane);
  const notesTitlebarIndexOpen = notesTitlebarSplit?.indexOpen ?? notesIndexOpen;
  const notesTitlebarIndexWidth = notesTitlebarSplit?.indexWidth ?? notesIndexWidth;
  const isCanvasEditor = route === "canvas" && hashPath.split("/")[1] === "main";
  const hideLeftTitle = route === "community" || route === "collection" || route === "ai";
  const hideBreadcrumb = route === "settings" || route === "community" || route === "tags" || route === "collection" || route === "favorites" || route === "smart" || route === "ai" || route === "canvas";

  useEffect(() => {
    if (!isNotes) {
      setNotesSplitMenuOpen(false);
      setNotesRootSplitMenuOpen(false);
      setNotesChildSplitMenuOpen(false);
    }
  }, [isNotes]);


  const cycleView = useCallback(() => {
    const currentIndex = MATERIALS_VIEW_ORDER.indexOf(materialsToolbarState.viewMode);
    const next = MATERIALS_VIEW_ORDER[(currentIndex + 1) % MATERIALS_VIEW_ORDER.length];
    dispatchMaterialsToolbarCommand({ type: "set-view", viewMode: next });
  }, [materialsToolbarState.viewMode]);


  const handleZoomChange = useCallback((value: number) => {
    setZoom(value);
    try { localStorage.setItem("luckyray-materials-zoom-v1", String(value)); } catch {}
    window.dispatchEvent(new CustomEvent("luckyray:materials-zoom", { detail: { zoom: value } }));
  }, []);

  // MATERIAL-VIEW-COMPARE-R1 narrow increment: the materials page's work-view
  // presets apply a density through the same shared zoom event. Subscribe so
  // this slider's handle stays in sync with the preset density. The page
  // persists what it applies (MaterialsPage is shared with the phone line,
  // where this sidebar does not exist); this subscriber only mirrors state,
  // never persists and never re-dispatches.
  useEffect(() => {
    const handleExternalZoom = (event: Event) => {
      const value = (event as CustomEvent<{ zoom?: number }>).detail?.zoom;
      if (typeof value === "number" && value >= 60 && value <= 300) {
        setZoom(Math.round(value));
      }
    };
    window.addEventListener("luckyray:materials-zoom", handleExternalZoom);
    return () => window.removeEventListener("luckyray:materials-zoom", handleExternalZoom);
  }, []);

  const handleImportFolder = useCallback(() => {
    window.dispatchEvent(new CustomEvent("luckyray:materials-import-folder"));
  }, []);

  const handleFilterToggle = useCallback(() => {
    dispatchMaterialsToolbarCommand({ type: "toggle-filter" });
  }, []);

  const handleMissingToggle = useCallback(() => {
    dispatchMaterialsToolbarCommand({ type: "toggle-missing" });
  }, []);

  const handleNotesSplitMenuToggle = useCallback(() => {
    setNotesSplitMenuOpen((open) => !open);
  }, []);

  const requestNotesSplit = useCallback((direction: "left" | "right" | "up" | "down", paneId?: string) => {
    setNotesSplitMenuOpen(false);
    window.dispatchEvent(new CustomEvent("luckyray:notes-split", { detail: { direction, paneId } }));
  }, []);

  const activateNotesTitlebarPane = useCallback((paneId: string, tabId?: string) => {
    window.dispatchEvent(new CustomEvent(NOTES_TITLEBAR_PANE_ACTIVATE_EVENT, { detail: { paneId, tabId } }));
  }, []);

  const createNotesTitlebarPane = useCallback((paneId: string) => {
    window.dispatchEvent(new CustomEvent(NOTES_TITLEBAR_PANE_NEW_EVENT, { detail: { paneId } }));
  }, []);

  const closeNotesTitlebarPane = useCallback((paneId: string, tabId: string) => {
    window.dispatchEvent(new CustomEvent(NOTES_TITLEBAR_PANE_CLOSE_EVENT, { detail: { paneId, tabId } }));
  }, []);

  const handleNoteTabSelect = useCallback((tab: NoteTabState) => {
    window.dispatchEvent(new CustomEvent("luckyray:notes-tab-select", {
      detail: {
        tabId: tab.id,
        kind: tab.kind || "note",
        noteId: tab.noteId ?? (tab.kind === "empty" ? null : tab.id),
      },
    }));
  }, []);

  const handleNoteTabClose = useCallback((tab: NoteTabState) => {
    window.dispatchEvent(new CustomEvent("luckyray:notes-tab-close", {
      detail: {
        tabId: tab.id,
        kind: tab.kind || "note",
        noteId: tab.noteId ?? (tab.kind === "empty" ? null : tab.id),
      },
    }));
  }, []);

  const selectGraphTab = useCallback((tabId: string) => {if(!graphNativeViews.hasFrozenViews())graphSessionStore.select(tabId);}, []);
  const addGraphTab = useCallback((options?: {duplicate?:boolean}) => {if(!graphNativeViews.hasFrozenViews())graphSessionStore.add({duplicate:options?.duplicate});}, []);
  const closeGraphTab = useCallback((tabId:string) => {if(!graphNativeViews.hasFrozenViews())graphSessionStore.close(tabId);}, []);

  // D110: 监听失效素材数量
  useEffect(() => {
    const handleToolbarState = (event: Event) => {
      const next = (event as CustomEvent<MaterialsToolbarState>).detail;
      if (!next || !MATERIALS_VIEW_ORDER.includes(next.viewMode) || !MATERIALS_SORT_OPTIONS.some((option) => option.key === next.sortBy)) return;
      setMaterialsToolbarState(next);
    };
    window.addEventListener(MATERIALS_TOOLBAR_STATE_EVENT, handleToolbarState);
    if (isMaterials) dispatchMaterialsToolbarCommand({ type: "request-state" });
    return () => window.removeEventListener(MATERIALS_TOOLBAR_STATE_EVENT, handleToolbarState);
  }, [isMaterials]);

  useEffect(() => {
    const handler = (event: Event) => {
      const count = (event as CustomEvent<{ count?: number }>).detail?.count;
      if (typeof count === "number") setMissingCount(count);
    };
    window.addEventListener("luckyray:materials-missing-count", handler);
    return () => window.removeEventListener("luckyray:materials-missing-count", handler);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const title = (event as CustomEvent<{ title?: string }>).detail?.title;
      setNoteTabs((current) => activeNoteId
        ? current.map((tab) => tab.id === activeNoteId ? { ...tab, title: title?.trim() || t("sidebar.note.untitled") } : tab)
        : current);
    };
    window.addEventListener("luckyray:notes-active-title", handler);
    return () => window.removeEventListener("luckyray:notes-active-title", handler);
  }, [activeNoteId, t]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ tabs?: NoteTabState[]; activeId?: string | null }>).detail || {};
      setNoteTabs(Array.isArray(detail.tabs) ? detail.tabs : []);
      setActiveNoteId(detail.activeId ?? null);
    };
    window.addEventListener("luckyray:notes-tabs", handler);
    return () => window.removeEventListener("luckyray:notes-tabs", handler);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ open?: boolean; width?: number }>).detail || {};
      const open = detail.open;
      if (typeof open === "boolean") setNotesIndexOpen(open);
      if (typeof detail.width === "number" && Number.isFinite(detail.width)) setNotesIndexWidth(detail.width);
    };
    window.addEventListener("luckyray:notes-panel-state", handler);
    return () => window.removeEventListener("luckyray:notes-panel-state", handler);
  }, []);

  useEffect(() => {
    const duplicate = () => addGraphTab({ duplicate: true });
    const closeActive = () => closeGraphTab(activeGraphId);
    window.addEventListener("luckyray:graph-tab-duplicate", duplicate);
    window.addEventListener("luckyray:graph-tab-close-active", closeActive);
    return () => {
      window.removeEventListener("luckyray:graph-tab-duplicate", duplicate);
      window.removeEventListener("luckyray:graph-tab-close-active", closeActive);
    };
  }, [activeGraphId, addGraphTab, closeGraphTab]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<NotesTitlebarSplit | null>).detail;
      setNotesTitlebarSplit(detail && detail.root && typeof detail.rootPaneId === "string" ? detail : null);
    };
    window.addEventListener(NOTES_TITLEBAR_SPLIT_EVENT, handler);
    return () => window.removeEventListener(NOTES_TITLEBAR_SPLIT_EVENT, handler);
  }, []);

  useLayoutEffect(() => {
    document.querySelector<HTMLElement>(".react-nav-shell")?.style.removeProperty(NOTES_SPLIT_LIVE_FIRST_TRACK);
  }, [notesTitlebarSplit]);

  useEffect(() => {
    if (!isNotes) setNotesTitlebarSplit(null);
  }, [isNotes]);

  const handleAdd = useCallback(() => {
    if (route === "notes") {
      window.dispatchEvent(new CustomEvent("luckyray:notes-new-tab"));
      return;
    }
    if (route === "materials") {
      window.dispatchEvent(new CustomEvent("luckyray:materials-import"));
    }
  }, [route]);

  const handleCanvasHome = useCallback(() => {
    window.dispatchEvent(new CustomEvent("luckyray:canvas-home-request"));
    window.setTimeout(() => {
      if (window.location.hash.startsWith("#canvas/main")) window.location.hash = "#canvas";
    }, 80);
  }, []);

  const suppressTitlebarContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const suppressTitlebarRightMouseDown = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 2) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const titlebarTabsStyle = isNotes
    ? ({ "--notes-index-width": `${notesIndexWidth}px` } as CSSProperties)
    : undefined;

  const graphTabStrip = isGraph && graphSession.groups.length === 1 ? (
    <div className="graph-tabs-bar-react" data-graph-tab-strip={graphSession.activeGroupId}>
      {graphTabs.map((tab) => (
        <button
          key={tab.id}
          className={`graph-tab-react${activeGraphId === tab.id ? " active" : ""}`}
          onContextMenu={suppressTitlebarContextMenu}
          onClick={() => selectGraphTab(tab.id)}
          data-graph-tab-id={tab.id} data-tauri-no-drag="true"
          onPointerDown={event=>beginGraphTabPointerDrag(event,{tabId:tab.id,title:tab.title})}
        >
          <span>{tab.title}</span>
          <span
            className="graph-tab-close-react"
            data-graph-tab-close="true"
            onPointerDown={event=>event.stopPropagation()}
            title={t("common.action.close")}
            onClick={(event) => {
              event.stopPropagation();
              closeGraphTab(tab.id);
            }}
          >
            <svg viewBox="0 0 16 16"><line x1="4" y1="4" x2="12" y2="12" /><line x1="12" y1="4" x2="4" y2="12" /></svg>
          </span>
        </button>
      ))}
      <button className="graph-tab-new-react" onClick={() => addGraphTab()} title={t("titlebar.action.newGraph")}>
        <svg viewBox="0 0 12 12"><line x1="6" y1="2" x2="6" y2="10" /><line x1="2" y1="6" x2="10" y2="6" /></svg>
      </button>
    </div>
  ) : null;

  const notesSplitControl = (_paneId?: string) => isNotes ? (
    <div className="notes-split-control" data-tauri-no-drag="true">
      <button className="tab-split-btn" title={t("titlebar.action.split")} aria-label={t("titlebar.action.split")} aria-expanded={notesSplitMenuOpen} onClick={handleNotesSplitMenuToggle}>
        <svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="1" /><line x1="8" y1="3" x2="8" y2="13" /></svg>
      </button>
      {notesSplitMenuOpen && (
        <div className="notes-split-menu-react" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" onClick={() => requestNotesSplit("left")} title={t("titlebar.action.splitLeft")}><svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="M6.5 3v10" /></svg>{t("titlebar.action.splitLeft")}</button>
          <button type="button" onClick={() => requestNotesSplit("right")} title={t("titlebar.action.splitRight")}><svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="M9.5 3v10" /></svg>{t("titlebar.action.splitRight")}</button>
          <button type="button" onClick={() => requestNotesSplit("up")} title={t("titlebar.action.splitUp")}><svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="M2.5 6.5h11" /></svg>{t("titlebar.action.splitUp")}</button>
          <button type="button" onClick={() => requestNotesSplit("down")} title={t("titlebar.action.splitDown")}><svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="M2.5 9.5h11" /></svg>{t("titlebar.action.splitDown")}</button>
        </div>
      )}
    </div>
  ) : null;

  const notesChildSplitControl = notesTitlebarSplit?.paneId && notesTitlebarSplit.pane ? (
    <div className="notes-split-control notes-titlebar-child-split-control" data-tauri-no-drag="true">
      <button
        type="button"
        className="tab-split-btn"
        title="Split pane"
        aria-label="Split pane"
        aria-expanded={notesChildSplitMenuOpen}
        onClick={() => {
          activateNotesTitlebarPane(notesTitlebarSplit.paneId!);
          setNotesChildSplitMenuOpen((open) => !open);
        }}
      >
        <svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="1" /><line x1="8" y1="3" x2="8" y2="13" /></svg>
      </button>
      {notesChildSplitMenuOpen && (
        <div className="notes-split-menu-react notes-titlebar-child-split-menu" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" title="Split left" onClick={() => { setNotesChildSplitMenuOpen(false); requestNotesSplit("left", notesTitlebarSplit.paneId!); }}><svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="M6.5 3v10" /></svg></button>
          <button type="button" title="Split right" onClick={() => { setNotesChildSplitMenuOpen(false); requestNotesSplit("right", notesTitlebarSplit.paneId!); }}><svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="M9.5 3v10" /></svg></button>
          <button type="button" title="Split up" onClick={() => { setNotesChildSplitMenuOpen(false); requestNotesSplit("up", notesTitlebarSplit.paneId!); }}><svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="M2.5 6.5h11" /></svg></button>
          <button type="button" title="Split down" onClick={() => { setNotesChildSplitMenuOpen(false); requestNotesSplit("down", notesTitlebarSplit.paneId!); }}><svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="M2.5 9.5h11" /></svg></button>
        </div>
      )}
    </div>
  ) : null;

  const notesTitlebarActivePaneId = notesTitlebarSplit?.activePaneId || notesTitlebarSplit?.rootPaneId;
  const notesRootSplitControl = notesTitlebarSplit ? (
    <div className="notes-split-control notes-titlebar-root-split-control" data-tauri-no-drag="true">
      <button
        type="button"
        className="tab-split-btn"
        title="Split pane"
        aria-label="Split pane"
        aria-expanded={notesRootSplitMenuOpen}
        onClick={() => {
          activateNotesTitlebarPane(notesTitlebarActivePaneId!);
          setNotesRootSplitMenuOpen((open) => !open);
        }}
      >
        <svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="1" /><line x1="8" y1="3" x2="8" y2="13" /></svg>
      </button>
      {notesRootSplitMenuOpen && (
        <div className="notes-split-menu-react notes-titlebar-child-split-menu" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" title="Split left" onClick={() => { setNotesRootSplitMenuOpen(false); requestNotesSplit("left", notesTitlebarActivePaneId!); }}><svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="M6.5 3v10" /></svg></button>
          <button type="button" title="Split right" onClick={() => { setNotesRootSplitMenuOpen(false); requestNotesSplit("right", notesTitlebarActivePaneId!); }}><svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="M9.5 3v10" /></svg></button>
          <button type="button" title="Split up" onClick={() => { setNotesRootSplitMenuOpen(false); requestNotesSplit("up", notesTitlebarActivePaneId!); }}><svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="M2.5 6.5h11" /></svg></button>
          <button type="button" title="Split down" onClick={() => { setNotesRootSplitMenuOpen(false); requestNotesSplit("down", notesTitlebarActivePaneId!); }}><svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="M2.5 9.5h11" /></svg></button>
        </div>
      )}
    </div>
  ) : null;

  const notesTitlebarTabs = (pane: NotesTitlebarPane, paneId: string) => pane.tabs.map((tab) => (
    <div
      key={tab.id}
      className={`tab notes-titlebar-pane-tab${pane.activeId === tab.id ? " active" : ""}${notesTitlebarSplit?.activePaneId === paneId ? " pane-active" : ""}`}
      onContextMenu={suppressTitlebarContextMenu}
      onClick={() => activateNotesTitlebarPane(paneId, tab.id)}
      title={tab.title}
      data-notes-dock-tab={tab.id} data-tauri-no-drag="true"
      onPointerDown={event=>beginNotesTabPointerDrag(event,{sourcePaneId:paneId,tabId:tab.id,title:tab.title})}
    >
      <span className="tab-label">{tab.title}</span>
      <button
        className="tab-close"
        title={t("titlebar.action.closeTab")}
        aria-label={t("titlebar.action.closeTab")}
        onClick={(event) => {
          event.stopPropagation();
          closeNotesTitlebarPane(paneId, tab.id);
        }}
      >
        <svg viewBox="0 0 16 16"><line x1="4" y1="4" x2="12" y2="12" /><line x1="12" y1="4" x2="4" y2="12" /></svg>
      </button>
    </div>
  ));
  const notesTitlebarRatio = Math.max(0.08, Math.min(0.92, notesTitlebarSplit?.ratio ?? 0.5));
  const notesTitlebarLeadingPane = notesTitlebarSplit?.rootPaneId || "notes-pane-1";
  const notesTitlebarTrailingPane = notesTitlebarSplit?.paneId || "notes-pane-2";
  const notesTitlebarHorizontalGrid = isNotesHorizontalSplit
    ? (notesTitlebarIndexOpen
      ? `${notesTitlebarIndexWidth}px minmax(0, var(${NOTES_SPLIT_LIVE_FIRST_TRACK}, ${notesTitlebarRatio}fr)) 8px minmax(0, ${1 - notesTitlebarRatio}fr)`
      : `var(${NOTES_SPLIT_LIVE_FIRST_TRACK}, calc(${notesTitlebarRatio * 100}% - ${notesTitlebarRatio * 8}px)) 8px minmax(0, 1fr)`)
    : undefined;

  return (
    <div
      id="app-titlebar"
      className={`titlebar${isMaterials ? " materials-titlebar" : ""}${isNotes ? " notes-titlebar" : ""}${notesTitlebarSplit ? " notes-titlebar-split" : ""}`}
      {...nativeTitlebarDragRegion}
      inert={applicationModalIsolated || undefined}
      aria-hidden={applicationModalIsolated || undefined}
      onContextMenu={suppressTitlebarContextMenu}
      onMouseDown={suppressTitlebarRightMouseDown}
    >
      {isNotes && notesTitlebarActionsReady && notesTitlebarSplit && (
        <div
          className={`notes-titlebar-pane-groups${isNotesHorizontalSplit ? " notes-titlebar-horizontal" : ""}${notesTitlebarIndexOpen ? " notes-titlebar-index-open" : ""}`}
          data-tauri-drag-region="true"
          style={{ ...titlebarTabsStyle, "--notes-index-width": `${notesTitlebarIndexWidth}px`, gridTemplateColumns: notesTitlebarHorizontalGrid } as CSSProperties}
        >
          <div className="notes-titlebar-pane-group notes-titlebar-pane-root" data-notes-dock-tabs={notesTitlebarSplit.rootPaneId} data-tauri-drag-region="true">
            {notesTitlebarTabs(notesTitlebarSplit.root, notesTitlebarSplit.rootPaneId)}
            <button className="tab-add-btn" title={t("titlebar.action.newDocument")} aria-label={t("titlebar.action.newDocument")} onClick={() => createNotesTitlebarPane(notesTitlebarLeadingPane)}><svg viewBox="0 0 16 16"><line x1="8" y1="3" x2="8" y2="13" /><line x1="3" y1="8" x2="13" y2="8" /></svg></button>
            {notesRootSplitControl}
          </div>
          {isNotesHorizontalSplit && notesTitlebarActionsReady && (<>
            <div className="notes-titlebar-pane-divider" aria-hidden="true" />
            <div className="notes-titlebar-pane-group notes-titlebar-pane-child" data-notes-dock-tabs={notesTitlebarSplit.paneId!} data-tauri-drag-region="true">
              {notesTitlebarTabs(notesTitlebarSplit.pane!, notesTitlebarSplit.paneId!)}
              <button className="tab-add-btn" title={t("titlebar.action.newDocument")} aria-label={t("titlebar.action.newDocument")} onClick={() => createNotesTitlebarPane(notesTitlebarTrailingPane)}><svg viewBox="0 0 16 16"><line x1="8" y1="3" x2="8" y2="13" /><line x1="3" y1="8" x2="13" y2="8" /></svg></button>
              {notesChildSplitControl}
            </div>
          </>)}
        </div>
      )}

      <div className="titlebar-left" data-tauri-drag-region="true" style={{ display: notesTitlebarSplit || isNotes || hideLeftTitle ? "none" : "flex" }}>
        {isCanvasEditor ? (
          <button className="titlebar-canvas-home" onClick={handleCanvasHome}>
            <svg viewBox="0 0 16 16"><polyline points="10,3 5,8 10,13" /></svg>
            <span>{t("titlebar.canvasHome")}</span>
          </button>
        ) : null}
        <div className="toolbar-nav" onMouseDown={(event) => event.stopPropagation()} style={{ display: isGraph || route === "ai" || route === "canvas" || route === "community" ? "none" : "flex" }}>
          <button title={t("titlebar.action.back")} disabled={!canGoBack} onClick={onBack}><svg viewBox="0 0 16 16"><polyline points="10,3 5,8 10,13" /></svg></button>
          <button title={t("titlebar.action.forward")} disabled={!canGoForward} onClick={onForward}><svg viewBox="0 0 16 16"><polyline points="6,3 11,8 6,13" /></svg></button>
          {route !== "favorites" && route !== "smart" && route !== "tags" && route !== "settings" ? (
            <button className="titlebar-import" onClick={handleAdd} title={route === "notes" ? t("titlebar.action.newTab") : t("titlebar.action.import")}>
              <svg viewBox="0 0 16 16"><line x1="8" y1="3" x2="8" y2="13" /><line x1="3" y1="8" x2="13" y2="8" /></svg>
            </button>
          ) : null}
        </div>
        {isGraph && graphTabStrip}
        <div className="titlebar-breadcrumb" data-tauri-drag-region="true" style={{ display: hideBreadcrumb || isGraph ? "none" : "flex" }}>
          <span className="breadcrumb-item current" data-tauri-drag-region="true" title={isMaterials ? materialsToolbarState.folderName ?? t("titlebar.materials.all") : undefined}>{isMaterials ? materialsToolbarState.folderName ?? t("titlebar.materials.all") : routeName(route, t)}</span>
        </div>
      </div>

      {/* A split owns its tab/drop targets; do not retain a hidden duplicate. */}
      {!notesTitlebarSplit && <div className={`titlebar-tabs${isNotes ? " show" : ""}${isNotes && notesIndexOpen ? " notes-index-open" : ""}`} style={titlebarTabsStyle} data-tauri-drag-region="true">
        <div className="tab-group" data-notes-dock-tabs="notes-pane-1">
          {noteTabs.map((tab) => (
            <div
              key={tab.id}
              className={`tab${activeNoteId === tab.id ? " active" : ""}${tab.kind === "empty" ? " empty" : ""}`}
              onContextMenu={suppressTitlebarContextMenu}
              onClick={() => handleNoteTabSelect(tab)}
              data-notes-dock-tab={tab.id} data-tauri-no-drag="true"
              onPointerDown={event=>beginNotesTabPointerDrag(event,{sourcePaneId:"notes-pane-1",tabId:tab.id,title:tab.title})}
            >
              <span className="tab-label">{tab.title}</span>
              <button
                className="tab-close"
                title={t("common.action.close")}
                onClick={(event) => {
                  event.stopPropagation();
                  handleNoteTabClose(tab);
                }}
              >
                <svg viewBox="0 0 16 16"><line x1="4" y1="4" x2="12" y2="12" /><line x1="12" y1="4" x2="4" y2="12" /></svg>
              </button>
            </div>
          ))}
        </div>
        {notesTitlebarActionsReady && (<>
          <button className="tab-add-btn" title={t("titlebar.action.newTab")} aria-label={t("titlebar.action.newTab")} onClick={handleAdd}><svg viewBox="0 0 16 16"><line x1="8" y1="3" x2="8" y2="13" /><line x1="3" y1="8" x2="13" y2="8" /></svg></button>
          {notesSplitControl()}
        </>)}
      </div>}
      <div className="titlebar-center" style={{ display: isMaterials ? "flex" : "none" }} data-tauri-no-drag="true">
        <div className="btn-group">
          <OrderedMaterialControls order={materialControlOrder}>
          <button {...materialControlProps("view")} type="button" className="view-cycle" onClick={cycleView} title={t("titlebar.view.switch", { view: materialViewLabel(materialsToolbarState.viewMode, t) })} aria-label={t("titlebar.view.switch", { view: materialViewLabel(materialsToolbarState.viewMode, t) })}>
            <ViewIcon viewMode={materialsToolbarState.viewMode} />
            <span className="view-cycle-tooltip">{materialViewLabel(materialsToolbarState.viewMode, t)}</span>
          </button>
          <button {...materialControlProps("workview")} type="button" className="workview-cycle" title={`${t("materials.workview.label")} · ${t(`materials.workview.${materialsToolbarState.workView}`)}`} aria-label={`${t("materials.workview.label")} · ${t(`materials.workview.${materialsToolbarState.workView}`)}`} onClick={() => dispatchMaterialsToolbarCommand({ type: "cycle-workview" })}>
            <WorkViewIcon preset={materialsToolbarState.workView} />
            <span>{t(`materials.workview.${materialsToolbarState.workView}`)}</span>
          </button>
          <button
            {...materialControlProps("filter")}
            id="materials-filter-trigger"
            type="button"
            className={`titlebar-action materials-filter-trigger${materialsToolbarState.filterOpen ? " open" : ""}${materialsToolbarState.activeFilterCount > 0 ? " active" : ""}`}
            title={materialsToolbarState.activeFilterCount > 0 ? plural(materialsToolbarState.activeFilterCount, { one: "titlebar.materials.filterActive.one", other: "titlebar.materials.filterActive.other" }) : t("titlebar.materials.filter")}
            aria-label={materialsToolbarState.activeFilterCount > 0 ? plural(materialsToolbarState.activeFilterCount, { one: "titlebar.materials.filterAria.one", other: "titlebar.materials.filterAria.other" }) : t("titlebar.materials.filter")}
            aria-expanded={materialsToolbarState.filterOpen}
            aria-controls={MATERIALS_FILTER_PANEL_ID}
            onClick={handleFilterToggle}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11L9.5 8v3.2l-3 1.4V8Z" /></svg>
            {materialsToolbarState.activeFilterCount > 0 && <span className="filter-count-react">{materialsToolbarState.activeFilterCount}</span>}
          </button>
          {materialsToolbarState.activeFilterCount > 0 && (
            <button
              type="button"
              {...materialControlProps("clear-filter")}
              className="titlebar-action materials-filter-clear-action"
              title={t("titlebar.materials.clearFilters")}
              aria-label={plural(materialsToolbarState.activeFilterCount, { one: "titlebar.materials.clearFiltersAria.one", other: "titlebar.materials.clearFiltersAria.other" })}
              onClick={() => dispatchMaterialsToolbarCommand({ type: "clear-filters" })}
            >
              <svg viewBox="0 0 16 16"><line x1="4" y1="4" x2="12" y2="12" /><line x1="12" y1="4" x2="4" y2="12" /></svg>
            </button>
          )}
          <button
            {...materialControlProps("missing")}
            id="materials-missing-trigger"
            type="button"
            className={`titlebar-action${materialsToolbarState.missingOpen ? " open" : ""}`}
            title={t("titlebar.materials.missing")}
            aria-label={t("titlebar.materials.missing")}
            aria-expanded={materialsToolbarState.missingOpen}
            aria-controls={MATERIALS_MISSING_PANEL_ID}
            onClick={handleMissingToggle}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2c.45 0 .83.23 1.06.63l5.35 9.25c.5.86-.12 1.92-1.12 1.92H2.71c-1 0-1.62-1.06-1.12-1.92l5.35-9.25c.23-.4.61-.63 1.06-.63Z" /><path d="M8 5.7v3.9" /><circle cx="8" cy="11.85" r=".65" fill="currentColor" stroke="none" /></svg>
            {missingCount > 0 && <span className="missing-badge-react">{missingCount}</span>}
          </button>
          <button {...materialControlProps("import-folder")} className="titlebar-action" title={t("titlebar.materials.importFolder")} aria-label={t("titlebar.materials.importFolder")} onClick={handleImportFolder}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h4l1.6 1.7h5.4A1.5 1.5 0 0 1 15 7.2v5.3a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-7A1.5 1.5 0 0 1 2.5 4Z" /><path d="M8 7.5v5M5.8 10.3 8 12.5l2.2-2.2" /></svg></button>
          <button {...materialControlProps("export")} id="materials-export-trigger" type="button"
            className={`titlebar-action materials-export-trigger${materialsToolbarState.exportOpen ? " open" : ""}${materialsToolbarState.exportNeedsAttention ? " attention" : ""}`}
            title={t("materials.export.recordsTitle")} aria-label={t("materials.export.recordsTitle")}
            aria-expanded={materialsToolbarState.exportOpen} aria-controls="materials-export-panel"
            onClick={() => dispatchMaterialsToolbarCommand({ type: "toggle-export-tasks" })}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5h10v2H3zM3 7h10v2H3zM3 10.5h7v2H3z" /></svg>
            {materialsToolbarState.exportRunningCount > 0 && <span className="filter-count-react">{materialsToolbarState.exportRunningCount}</span>}
            {materialsToolbarState.exportRunningCount === 0 && materialsToolbarState.exportNeedsAttention && <span className="materials-export-attention-dot" />}
          </button>
          </OrderedMaterialControls>
          <div className="toolbar-sep" />
          <div className="zoom-slider" onMouseDown={(event) => event.stopPropagation()}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="5" width="7" height="6" rx="2" /></svg>
            <input type="range" min="60" max="300" value={zoom} onChange={(e) => handleZoomChange(Number(e.target.value))} />
            <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="2.5" /></svg>
          </div>
        </div>
      </div>

      <div className={`titlebar-right${notesTitlebarSplit ? " graph-titlebar-window-controls" : ""}`} data-tauri-no-drag="true">
        {route === "ai" && onRestartLightSeek ? <LightSeekToolsMenu restarting={lightSeekRestarting} onRestart={onRestartLightSeek} onOpenChange={onLightSeekToolsOpenChange} /> : null}
        {route === "ai" && onToggleAiPersonalBrowser ? (
          <button
            type="button"
            className={`titlebar-ai-browser${aiPersonalBrowserOpen ? " active" : ""}`}
            aria-pressed={aiPersonalBrowserOpen}
            aria-label={aiPersonalBrowserOpen ? t("titlebar.ai.closeBrowser") : t("titlebar.ai.openBrowser")}
            title={aiPersonalBrowserOpen ? t("titlebar.ai.closeBrowser") : t("titlebar.ai.openBrowser")}
            onClick={onToggleAiPersonalBrowser}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="2" y="2.5" width="12" height="11" rx="2" />
              <line x1="2" y1="5.5" x2="14" y2="5.5" />
              <circle cx="4.25" cy="4" r="0.45" fill="currentColor" stroke="none" />
              <circle cx="6" cy="4" r="0.45" fill="currentColor" stroke="none" />
            </svg>
          </button>
        ) : null}
        {route === "ai" && onToggleAiContentBrowser ? (
          <button
            type="button"
            className={`titlebar-ai-browser${aiContentBrowserOpen ? " active" : ""}`}
            aria-pressed={aiContentBrowserOpen}
            aria-label={aiContentBrowserOpen ? t("titlebar.ai.closeContentBrowser") : t("titlebar.ai.openContentBrowser")}
            title={aiContentBrowserOpen ? t("titlebar.ai.closeContentBrowser") : t("titlebar.ai.openContentBrowser")}
            onClick={onToggleAiContentBrowser}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2.5 3.2h4.2l1.2 1.4h5.6v8.2h-11Z" />
              <path d="M5 7.2h6M5 9.5h4.5" />
            </svg>
          </button>
        ) : null}
        {isMaterials ? <TitlebarMaterialSearch query={materialsToolbarState.query ?? ""} mode={materialsToolbarState.searchMode ?? "materials"}/> : !isGraph && !isNotesHorizontalSplit && (
          <button className="titlebar-search" onClick={onOpenSearch}>
            <svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4" /><line x1="10" y1="10" x2="14" y2="14" /></svg>
            <span>{t("titlebar.searching")}</span>
          </button>
        )}
        <WindowControlsFixed />
      </div>
    </div>
  );
}

function OrderedMaterialControls({order,children}:{order:ControlOrder;children:React.ReactNode}){
 const controls=Children.toArray(children).flatMap(child=>{
  if(!isValidElement<{"data-control-id"?:string}>(child))return [];
  const id=child.props['data-control-id'];return id?[{id,element:cloneElement(child,{key:id})}]:[];
 });
 return <div className="materials-feature-tools" data-control-group="materials" data-control-axis="horizontal">{arrangeControls(controls,order).map(control=>control.element)}</div>;
}

function routeName(route: ShellRoute, t: I18nContextValue["t"]) {
  const names: Record<ShellRoute, MessageKey> = {
    materials: "titlebar.materials.all",
    attachments: "sidebar.route.attachments",
    notes: "sidebar.route.notes",
    graph: "sidebar.route.graph",
    canvas: "sidebar.route.canvas",
    browser: "titlebar.browser",
    community: "sidebar.route.community",
    ai: "titlebar.ai",
    tags: "sidebar.route.tags",
    collection: "sidebar.route.collection",
    favorites: "sidebar.route.favorites",
    smart: "sidebar.route.smartFolders",
    settings: "sidebar.route.settings",
    plugins: "sidebar.route.plugins",
  };
  return t(names[route]);
}

function materialViewLabel(viewMode: MaterialsViewMode, t: I18nContextValue["t"]) {
  return t(`titlebar.view.${viewMode}` as MessageKey);
}

function WindowControlsFixed() {
  const { t } = useI18n();
  const runWindowAction = useCallback(async (action: "minimize" | "hide" | "toggleMaximize" | "close") => {
    if (action === "close") {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("close_window");
      } catch (e) {
        console.warn("[WindowControls] full quit failed:", e);
      }
      return;
    }
    try {
      const mod = await import("@tauri-apps/api/window");
      const appWindow = mod.getCurrentWindow();
      if (action !== "hide" && typeof appWindow[action] === "function") {
        await appWindow[action]();
        return;
      }
    } catch {}

    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const cmd = action === "minimize" ? "minimize_window"
        : action === "hide" ? "hide_window"
        : action === "toggleMaximize" ? "toggle_maximize_window"
        : "close_window";
      await invoke(cmd);
    } catch (e) {
      console.warn("[WindowControls] action failed:", action, e);
    }
  }, []);
  const [confirmClose, setConfirmClose] = useState(false);

  useEffect(() => {
    if (!confirmClose) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConfirmClose(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmClose]);

  const handleClose = useCallback(async () => {
    const settings = readSavedSettings();
    const behavior = String(settings["general.onClose"] || "tray");
    if (behavior === "ask") {
      setConfirmClose(true);
      return;
    }
    await runWindowAction(behavior === "tray" ? "hide" : "close");
  }, [runWindowAction]);

  return (
    <div className="window-controls" data-tauri-no-drag="true">
      <button className="win-btn win-minimize" title={t("shell.window.minimize")} data-tauri-no-drag="true" onClick={() => void runWindowAction("minimize")}><svg viewBox="0 0 14 14"><line x1="3" y1="7" x2="11" y2="7" /></svg></button>
      <button className="win-btn win-maximize" title={t("shell.window.maximize")} data-tauri-no-drag="true" onClick={() => void runWindowAction("toggleMaximize")}><svg viewBox="0 0 14 14"><rect x="3" y="3" width="8" height="8" rx="1.5" fill="none" /></svg></button>
      <button className="win-btn win-close" title={t("shell.window.close")} data-tauri-no-drag="true" onClick={() => void handleClose()}><svg viewBox="0 0 14 14"><line x1="3.5" y1="3.5" x2="10.5" y2="10.5" /><line x1="10.5" y1="3.5" x2="3.5" y2="10.5" /></svg></button>
      {confirmClose && (
        <div className="window-close-overlay experience-dialog-backdrop" onPointerDown={() => setConfirmClose(false)}>
          <div
            className="window-close-confirm experience-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t("window.closeConfirm")}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="window-close-confirm-title">{t("window.closeConfirm")}</div>
            <div className="window-close-confirm-desc">{t("window.closeDescription")}</div>
            <div className="window-close-confirm-actions">
              <button type="button" className="btn-cancel" onClick={() => setConfirmClose(false)}>{t("common.action.cancel")}</button>
              <button type="button" className="btn-primary" onClick={() => { setConfirmClose(false); void runWindowAction("hide"); }}>{t("window.action.hide")}</button>
              <button type="button" className="btn-danger" onClick={() => { setConfirmClose(false); void runWindowAction("close"); }}>{t("window.action.exit")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function WindowControls() {
  const { t } = useI18n();
  const runWindowAction = useCallback(async (action: "minimize" | "hide" | "toggleMaximize" | "close") => {
    if (action === "close") {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("close_window");
      } catch (e) {
        console.warn("[WindowControls] full quit failed:", e);
      }
      return;
    }
    // 优先用 Tauri window API
    try {
      const mod = await import("@tauri-apps/api/window");
      const appWindow = mod.getCurrentWindow();
      if (typeof appWindow[action] === "function") {
        await appWindow[action]();
        return;
      }
    } catch {}
    // fallback: invoke Rust 命令
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const cmd = action === "minimize" ? "minimize_window"
        : action === "hide" ? "hide_window"
        : action === "toggleMaximize" ? "toggle_maximize_window"
        : "close_window";
      await invoke(cmd);
    } catch (e) {
      console.warn("[WindowControls] action failed:", action, e);
    }
  }, []);
  const [confirmClose, setConfirmClose] = useState(false);

  useEffect(() => {
    if (!confirmClose) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConfirmClose(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmClose]);

  const handleClose = useCallback(async () => {
    const settings = readSavedSettings();
    const behavior = String(settings["general.onClose"] || "tray");
    if (behavior === "ask") {
      setConfirmClose(true);
      return;
    }
    if (behavior === "tray") {
      await runWindowAction("hide");
      return;
    }
    await runWindowAction("close");
  }, [runWindowAction]);

  return (
    <div className="window-controls" data-tauri-no-drag="true">
      <button className="win-btn win-minimize" title={t("shell.window.minimize")} data-tauri-no-drag="true" onClick={() => void runWindowAction("minimize")}><svg viewBox="0 0 14 14"><line x1="3" y1="7" x2="11" y2="7" /></svg></button>
      <button className="win-btn win-maximize" title={t("shell.window.maximize")} data-tauri-no-drag="true" onClick={() => void runWindowAction("toggleMaximize")}><svg viewBox="0 0 14 14"><rect x="3" y="3" width="8" height="8" rx="1.5" fill="none" /></svg></button>
      <button className="win-btn win-close" title={t("shell.window.close")} data-tauri-no-drag="true" onClick={() => void handleClose()}><svg viewBox="0 0 14 14"><line x1="3.5" y1="3.5" x2="10.5" y2="10.5" /><line x1="10.5" y1="3.5" x2="3.5" y2="10.5" /></svg></button>
      {confirmClose && (
        <div className="window-close-overlay experience-dialog-backdrop" onPointerDown={() => setConfirmClose(false)}>
          <div
            className="window-close-confirm experience-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t("window.closeConfirm")}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="window-close-confirm-title">{t("window.closeConfirm")}</div>
            <div className="window-close-confirm-desc">{t("window.closeDescription")}</div>
            <div className="window-close-confirm-actions">
              <button type="button" className="btn-cancel" onClick={() => setConfirmClose(false)}>{t("common.action.cancel")}</button>
              <button type="button" className="btn-primary" onClick={() => { setConfirmClose(false); void runWindowAction("minimize"); }}>{t("window.action.minimize")}</button>
              <button type="button" className="btn-danger" onClick={() => { setConfirmClose(false); void runWindowAction("close"); }}>{t("window.action.exit")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ViewIcon({ viewMode }: { viewMode: MaterialsViewMode }) {
  if (viewMode === "list") {
    return <svg viewBox="0 0 16 16"><path d="M2.5 4.25h11M2.5 8h11M2.5 11.75h11" /></svg>;
  }
  if (viewMode === "grid") {
    return <svg viewBox="0 0 16 16"><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></svg>;
  }
  return <svg viewBox="0 0 16 16"><rect x="1" y="1" width="5" height="8" rx="1" /><rect x="8" y="1" width="7" height="5" rx="1" /><rect x="1" y="11" width="5" height="4" rx="1" /><rect x="8" y="8" width="7" height="7" rx="1" /></svg>;
}

function WorkViewIcon({ preset }: { preset: MaterialsToolbarState["workView"] }) {
  if (preset === "design") return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="8" rx="1" /><path d="M2 12.5h12M6 12.5l1.2 1.5h1.6L10 12.5" /></svg>;
  if (preset === "video") return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="3" width="13" height="10" rx="1.5" /><path d="M6.5 6l4 2-4 2Z" /></svg>;
  return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="5" height="5" rx="1" /><rect x="9" y="2.5" width="5" height="5" rx="1" /><rect x="2" y="8.5" width="5" height="5" rx="1" /><rect x="9" y="8.5" width="5" height="5" rx="1" /></svg>;
}

function IconGrid() {
  return <svg viewBox="0 0 18 18"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="12" y="3" width="4" height="4" rx="1" /><rect x="3" y="12" width="4" height="4" rx="1" /><rect x="9" y="10" width="7" height="7" rx="1" /></svg>;
}
