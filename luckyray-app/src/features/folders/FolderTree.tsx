// Shared FolderTree for knowledge/material folders
// Shared props bridge folders / selectedId / onSelect / onCreate.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { materialLibrarySession, readMaterialLibraryPreference, writeMaterialLibraryPreference } from "../../core/services/materialLibraryContext";
import type { Folder } from "./useFolders";
import { createDragEdgeScroller } from "./dragEdgeScroll";
import { defineMessages, useMessages } from "../../core/i18n/index";
import "./folders.css";

export type FolderTreeDocument = {
  id: string;
  title: string;
  subtitle?: string;
};

export type FolderTreeExternalDrop =
  | { source: "browser"; event: React.DragEvent }
  | { source: "tauri"; paths: string[] };

export type FolderTreeProps = {
  folders: Folder[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (parentId: string | null) => void;
  /** Extra className for the tree root. */
  className?: string;
  /** Optional label for the all item. */
  allLabel?: string;
  /** Optional domain root controls, independent of folder selection. */
  allControl?: React.ReactNode;
  /** Whether the uncategorized entry is visible. */
  createButtonLabel?: string;
  /** Whether the all/root entry is visible. */
  hideHeader?: boolean;
  /** Hide the tree header. */
  showUncategorized?: boolean;
  /** Allow folder drag sorting. */
  showAllItem?: boolean;
  /** Optional create button label. */
  onUncategorized?: () => void;
  /** Folder scope controls right-click actions. */
  scope?: "materials" | "notes";
  onRename?: (folderId: string, name: string) => void | Promise<void>;
  onDelete?: (folderId: string) => void | Promise<void>;
  onMove?: (folderId: string, targetId: string | null) => void | Promise<void>;
  onImport?: (folderId: string | null) => void | Promise<void>;
  onExport?: (folderId: string | null) => void | Promise<void>;
  onExportOriginals?: (folderId: string | null) => void | Promise<void>;
  onExportCsv?: (folderId: string) => void | Promise<void>;
  onCopyToLibrary?: (folderId: string) => void;
  onExternalDrop?: (folderId: string | null, drop: FolderTreeExternalDrop) => void | Promise<void>;
  nativeExternalDropEnabled?: boolean;
  onCreateNote?: (folderId: string) => void | Promise<void>;
  documentsByFolderId?: Record<string, FolderTreeDocument[]>;
  allDocumentsByFolderId?: Record<string, FolderTreeDocument[]>;
  uncategorizedDocuments?: FolderTreeDocument[];
  selectedDocumentId?: string | null;
  documentRevealRequest?: { documentId: string; nonce: number } | null;
  onSelectDocument?: (documentId: string) => void;
  onDocumentContextMenu?: (documentId: string, event: React.MouseEvent) => void;
  onRenameDocument?: (documentId: string, name: string) => void | Promise<void>;
  onMoveDocument?: (documentId: string, targetFolderId: string | null) => void | Promise<void>;
  onDropRejected?: (message: string) => void;
  renameDocumentRequest?: { documentId: string; nonce: number } | null;
  forceOpenFolderIds?: string[];
  revealRequest?: { folderId: string | null; ancestorIds: string[]; nonce: number } | null;
  folderPathActions?: FolderPathActions;
  deleteDescription?: (folder: Folder, impact: FolderDeleteImpact) => React.ReactNode;
  hideDeleteSkipConfirm?: boolean;
  getDeleteDisabledReason?: (folder: Folder, impact: FolderDeleteImpact) => string | null;
};

type InlineRenameState =
  | { kind: "folder"; id: string; name: string; originalName: string }
  | { kind: "document"; id: string; name: string; originalName: string };
type InlineRenameInputProps = React.InputHTMLAttributes<HTMLInputElement> & { ref: React.Ref<HTMLInputElement> };
type FolderDeleteImpact = { folderCount: number; documentCount: number };
type FolderTreeDragKind = "folder" | "document";
type FolderPathActions = {
  copy?: (folderId: string) => void | Promise<void>;
  open?: (folderId: string) => void | Promise<void>;
  reveal?: (folderId: string) => void | Promise<void>;
};

const FOLDER_EMPTY_DELETE_SKIP_CONFIRM_KEY = "luckyray-notes-folder-empty-delete-skip-confirm-v1";
const FOLDER_NONEMPTY_DELETE_SKIP_CONFIRM_KEY = "luckyray-notes-folder-nonempty-delete-skip-confirm-v1";

const COPY = defineMessages({
  "action.newNote": { "zh-CN": "新建笔记", "en-US": "New Note" },
  "action.exportCsv": { "zh-CN": "导出此分类清单（CSV）", "en-US": "Export This Category List (CSV)" },
  "action.exportOriginals": { "zh-CN": "导出原文件", "en-US": "Export Original Files" },
  "action.exportIndexAll": { "zh-CN": "导出素材索引（全库）", "en-US": "Export Material Index (All)" },
  "all": { "zh-CN": "全部文档", "en-US": "All Documents" }, "error.sameFolder": { "zh-CN": "文档已在目标文件夹中", "en-US": "The document is already in that folder" }, "error.move": { "zh-CN": "不能移动到该位置", "en-US": "Cannot move to that location" }, "header": { "zh-CN": "文件夹", "en-US": "Folders" }, "action.newFolder": { "zh-CN": "新建文件夹", "en-US": "New Folder" }, "uncategorized": { "zh-CN": "未分类", "en-US": "Uncategorized" },
  "action.newDocument": { "zh-CN": "新建文档", "en-US": "New Document" }, "action.importHere": { "zh-CN": "导入到此处", "en-US": "Import Here" }, "action.exportDocuments": { "zh-CN": "导出文档", "en-US": "Export Documents" }, "action.import": { "zh-CN": "导入", "en-US": "Import" }, "action.export": { "zh-CN": "导出", "en-US": "Export" }, "action.newSubfolder": { "zh-CN": "新建子文件夹", "en-US": "New Subfolder" }, "action.renameFolder": { "zh-CN": "重命名文件夹", "en-US": "Rename Folder" }, "action.moveFolder": { "zh-CN": "移动到文件夹...", "en-US": "Move to Folder..." }, "action.rename": { "zh-CN": "重命名", "en-US": "Rename" },
  "move.submenu": { "zh-CN": "移动到文件夹", "en-US": "Move to Folder" }, "root": { "zh-CN": "根目录", "en-US": "Root" }, "path.copy": { "zh-CN": "复制绝对路径", "en-US": "Copy Absolute Path" }, "path.copyUnavailable": { "zh-CN": "复制绝对路径（未落盘）", "en-US": "Copy Absolute Path (not on disk)" }, "path.copyHint": { "zh-CN": "本地数据库文件夹尚未绑定真实路径", "en-US": "This local database folder is not linked to a real path" }, "path.reveal": { "zh-CN": "在资源管理器中显示", "en-US": "Show in File Explorer" }, "path.revealUnavailable": { "zh-CN": "在资源管理器中显示（未落盘）", "en-US": "Show in File Explorer (not on disk)" }, "path.revealHint": { "zh-CN": "此文件夹尚未绑定真实路径", "en-US": "This folder is not linked to a real path" }, "action.deleteFolder": { "zh-CN": "删除文件夹", "en-US": "Delete Folder" },
  "move.title": { "zh-CN": "移动文件夹", "en-US": "Move Folder" }, "move.copy": { "zh-CN": "选择“{name}”的新位置；自身和子文件夹已自动排除。", "en-US": "Choose a new location for “{name}”. The folder and its children are excluded." }, "move.search": { "zh-CN": "搜索文件夹...", "en-US": "Search folders..." }, "move.rootCopy": { "zh-CN": "移动到知识库根目录", "en-US": "Move to the Knowledge root" }, "move.here": { "zh-CN": "移动到此文件夹下", "en-US": "Move into this folder" }, "move.empty": { "zh-CN": "没有匹配的文件夹", "en-US": "No matching folders" },
  "rename.title": { "zh-CN": "重命名文件夹", "en-US": "Rename Folder" }, "delete.title": { "zh-CN": "删除文件夹", "en-US": "Delete Folder" }, "delete.nonempty": { "zh-CN": "确认删除“{name}”吗？这会删除该文件夹、子文件夹和其中的文档。", "en-US": "Delete “{name}”? This also deletes its subfolders and documents." }, "delete.empty": { "zh-CN": "确定删除“{name}”吗？这会删除该文件夹和子文件夹。", "en-US": "Delete “{name}”? This also deletes its subfolders." }, "delete.folderImpact.one": { "zh-CN": "影响 {count} 个文件夹", "en-US": "Affects {count} folder" }, "delete.folderImpact.other": { "zh-CN": "影响 {count} 个文件夹", "en-US": "Affects {count} folders" }, "delete.documentImpact.one": { "zh-CN": "影响 {count} 个文档", "en-US": "Affects {count} document" }, "delete.documentImpact.other": { "zh-CN": "影响 {count} 个文档", "en-US": "Affects {count} documents" }, "delete.skipNonempty": { "zh-CN": "下次删除非空文件夹不再提醒", "en-US": "Do not ask again for non-empty folders" }, "delete.skipEmpty": { "zh-CN": "下次删除空文件夹不再提醒", "en-US": "Do not ask again for empty folders" }, "action.cancel": { "zh-CN": "取消", "en-US": "Cancel" }, "action.confirm": { "zh-CN": "确认", "en-US": "Confirm" }, "action.delete": { "zh-CN": "删除", "en-US": "Delete" },
});

function readBooleanPreference(key: string) {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeBooleanPreference(key: string, value: boolean) {
  try {
    if (value) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    // Ignore storage failures in restricted environments.
  }
}

function folderDeleteSkipKey(impact: FolderDeleteImpact) {
  return impact.documentCount > 0 || impact.folderCount > 1
    ? FOLDER_NONEMPTY_DELETE_SKIP_CONFIRM_KEY
    : FOLDER_EMPTY_DELETE_SKIP_CONFIRM_KEY;
}

function clampFolderContextMenuPosition(x: number, y: number, width: number, height: number) {
  const margin = 8;
  return {
    x: Math.min(Math.max(margin, x), Math.max(margin, window.innerWidth - width - margin)),
    y: Math.min(Math.max(margin, y), Math.max(margin, window.innerHeight - height - margin)),
  };
}

export const FolderTree = memo(function FolderTree({
  folders,
  selectedId,
  onSelect,
  onCreate,
  className = "",
  allLabel,
  allControl,
  createButtonLabel,
  hideHeader = false,
  showUncategorized = false,
  showAllItem = true,
  onUncategorized,
  scope = "materials",
  onRename,
  onDelete,
  onMove,
  onImport,
  onExport,
  onExportOriginals,
  onExportCsv,
  onCopyToLibrary,
  onExternalDrop,
  nativeExternalDropEnabled = true,
  onCreateNote,
  documentsByFolderId,
  allDocumentsByFolderId,
  uncategorizedDocuments = [],
  selectedDocumentId,
  documentRevealRequest,
  onSelectDocument,
  onDocumentContextMenu,
  onRenameDocument,
  onMoveDocument,
  onDropRejected,
  renameDocumentRequest,
  forceOpenFolderIds,
  revealRequest,
  folderPathActions,
  deleteDescription,
  hideDeleteSkipConfirm = false,
  getDeleteDisabledReason,
}: FolderTreeProps) {
  const { plural, t } = useMessages(COPY);
  const resolvedAllLabel = allLabel || t("all");
  const [ctx, setCtx] = useState<{ folder: Folder; x: number; y: number } | null>(null);
  const [rootCtx, setRootCtx] = useState<{ x: number; y: number } | null>(null);
  const [uncategorizedCtx, setUncategorizedCtx] = useState<{ x: number; y: number } | null>(null);
  const [renameDialog, setRenameDialog] = useState<{ folder: Folder; name: string } | null>(null);
  const [moveDialog, setMoveDialog] = useState<{ folder: Folder } | null>(null);
  const [moveQuery, setMoveQuery] = useState("");
  const [inlineRename, setInlineRename] = useState<InlineRenameState | null>(null);
  const libraryContext = useSyncExternalStore(materialLibrarySession.subscribe, materialLibrarySession.getSnapshot);
  const materialLibraryId = scope === "materials" ? libraryContext.libraryId : null;
  const materialLibraryGeneration = scope === "materials" ? libraryContext.generation : 0;
  const readTreeOpen = () => {
    if (scope !== "materials") return new Set<string>();
    try { const value = JSON.parse(readMaterialLibraryPreference("luckyray-materials-tree-open-v1", materialLibraryId) || "[]"); return new Set<string>(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string").slice(0, 2000) : []); } catch { return new Set<string>(); }
  };
  const [openFolderIds, setOpenFolderIds] = useState<Set<string>>(readTreeOpen);
  const [deleteDialog, setDeleteDialog] = useState<Folder | null>(null);
  const [deleteSkipNext, setDeleteSkipNext] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string | null } | null>(null);
  const [uncategorizedOpen, setUncategorizedOpen] = useState(true);
  const draggingIdRef = useRef<string | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);
  const edgeScroller = useMemo(createDragEdgeScroller, []);
  useEffect(() => () => edgeScroller.stop(), [edgeScroller]);
  useLayoutEffect(() => {
    if (scope !== "materials") return;
    setOpenFolderIds(readTreeOpen()); setCtx(null); setRootCtx(null); setUncategorizedCtx(null); setInlineRename(null); setRenameDialog(null); setMoveDialog(null); setDeleteDialog(null); setDraggingId(null); setDropTarget(null);
    onSelect(null);
  }, [materialLibraryId, materialLibraryGeneration, scope]);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuReturnFocus = useRef<HTMLElement | null>(null);
  const menuActionClaimed = useRef(false);
  useLayoutEffect(() => {
    if (!ctx && !rootCtx && !uncategorizedCtx) return;
    menuActionClaimed.current = false;
    const menu = menuRef.current;
    if (!menu) return;
    // The entrance animation scales the visual rect. Clamp the final layout box,
    // otherwise a bottom/right menu overflows after the animation finishes.
    const requested = ctx || rootCtx || uncategorizedCtx;
    if (!requested) return;
    const point = clampFolderContextMenuPosition(requested.x, requested.y, menu.offsetWidth, menu.offsetHeight);
    menu.style.left = point.x + "px"; menu.style.top = point.y + "px";
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    return () => { menuReturnFocus.current?.focus({ preventScroll: true }); };
  }, [ctx, rootCtx, uncategorizedCtx]);
  useEffect(() => { if (ctx && !findFolder(folders, ctx.folder.id)) setCtx(null); }, [folders, ctx]);
  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      setCtx(null); setRootCtx(null); setUncategorizedCtx(null); return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"))
      .filter(button => button.getClientRects().length > 0);
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
    event.preventDefault(); buttons[next].focus();
  };
  const handledDocumentRevealRef = useRef<number | null>(null);
  const onExternalDropRef = useRef(onExternalDrop);
  const nativeExternalDragActiveRef = useRef(false);
  const lastNativeExternalDropAtRef = useRef(0);
  const pointerDragRef = useRef<{
    kind: FolderTreeDragKind;
    id: string;
    sourceFolderId?: string | null;
    startX: number;
    startY: number;
    active: boolean;
    targetId: string | null | undefined;
  } | null>(null);
  const inlineRenameRef = useRef<InlineRenameState | null>(null);
  const inlineInputRef = useRef<HTMLInputElement | null>(null);
  const handledRenameDocumentNonceRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const moveTargets = useMemo(() => ctx ? getMoveTargets(folders, ctx.folder.id) : [], [ctx, folders]);
  const dialogMoveTargets = useMemo(() => moveDialog ? getMoveTargets(folders, moveDialog.folder.id) : [], [folders, moveDialog]);
  const filteredDialogMoveTargets = useMemo(() => {
    const query = moveQuery.trim().toLowerCase();
    if (!query) return dialogMoveTargets;
    return dialogMoveTargets.filter((target) => target.name.toLowerCase().includes(query));
  }, [dialogMoveTargets, moveQuery]);
  const hasUncategorizedDocuments = uncategorizedDocuments.length > 0;
  const forceOpenFolderSet = useMemo(() => new Set(forceOpenFolderIds || []), [forceOpenFolderIds]);

  useEffect(() => {
    onExternalDropRef.current = onExternalDrop;
  }, [onExternalDrop]);

  useEffect(() => {
    inlineRenameRef.current = inlineRename;
    if (!inlineRename) return;
    requestAnimationFrame(() => {
      inlineInputRef.current?.focus();
      inlineInputRef.current?.select();
    });
  }, [inlineRename]);

  useEffect(() => {
    setDeleteSkipNext(false);
  }, [deleteDialog]);

  useEffect(() => {
    if (!renameDocumentRequest) return;
    if (handledRenameDocumentNonceRef.current === renameDocumentRequest.nonce) return;
    handledRenameDocumentNonceRef.current = renameDocumentRequest.nonce;
    const document = findDocumentById(documentsByFolderId, uncategorizedDocuments, renameDocumentRequest.documentId);
    if (!document) return;
    setInlineRename({
      kind: "document",
      id: document.id,
      name: document.title,
      originalName: document.title,
    });
  }, [documentsByFolderId, renameDocumentRequest, uncategorizedDocuments]);

  useEffect(() => {
    setOpenFolderIds((current) => {
      const validIds = collectFolderIdsSet(folders);
      const requiredIds = collectAutoOpenFolderIds(folders, selectedId, forceOpenFolderSet);
      const next = new Set<string>();
      current.forEach((id) => {
        if (validIds.has(id)) next.add(id);
      });
      requiredIds.forEach((id) => {
        if (validIds.has(id)) next.add(id);
      });
      return setsEqual(current, next) ? current : next;
    });
  }, [folders, forceOpenFolderSet, selectedId]);

  useEffect(() => {
    if (!documentRevealRequest) {
      handledDocumentRevealRef.current = null;
      return;
    }
    if (handledDocumentRevealRef.current === documentRevealRequest.nonce) return;
    const documentId = documentRevealRequest.documentId;
    const folderId = Object.keys(documentsByFolderId || {}).find((id) =>
      documentsByFolderId?.[id].some((document) => document.id === documentId));
    const atRoot = uncategorizedDocuments.some((document) => document.id === documentId);
    // Keep the request pending until this tree's authoritative data arrives.
    if (!folderId && !atRoot) return;
    const ancestors = collectAutoOpenFolderIds(folders, null, new Set(folderId ? [folderId] : []));
    if ([...ancestors].some((id) => !openFolderIds.has(id))) {
      setOpenFolderIds((current) => new Set([...current, ...ancestors]));
      return;
    }
    if (atRoot && showUncategorized && !uncategorizedOpen) {
      setUncategorizedOpen(true);
      return;
    }
    const container = treeRef.current?.querySelector<HTMLElement>(".folder-list");
    const target = Array.from(container?.querySelectorAll<HTMLElement>("[data-folder-document-id]") || [])
      .find((element) => element.dataset.folderDocumentId === documentId);
    if (!container || !target || container.clientHeight === 0) return;
    const viewport = container.getBoundingClientRect();
    const row = target.getBoundingClientRect();
    const top = viewport.top + container.clientTop;
    const bottom = top + container.clientHeight;
    // Scroll only this list, and only far enough to expose the row. Never focus
    // the row or scroll an ancestor containing the user's editor.
    if (row.top < top) container.scrollTop += row.top - top;
    else if (row.bottom > bottom) container.scrollTop += row.bottom - bottom;
    handledDocumentRevealRef.current = documentRevealRequest.nonce;
  }, [documentRevealRequest, documentsByFolderId, folders, openFolderIds, showUncategorized, uncategorizedDocuments, uncategorizedOpen]);

  useEffect(() => {
    if (!revealRequest) return;
    setOpenFolderIds((current) => {
      const validIds = collectFolderIdsSet(folders);
      const next = new Set(current);
      revealRequest.ancestorIds.forEach((id) => {
        if (validIds.has(id)) next.add(id);
      });
      return setsEqual(current, next) ? current : next;
    });
    const targetId = revealRequest.folderId ?? "__root__";
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        const target = Array.from(treeRef.current?.querySelectorAll<HTMLElement>("[data-folder-id]") || [])
          .find((element) => element.dataset.folderId === targetId);
        target?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
        target?.focus({ preventScroll: true });
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [folders, revealRequest?.nonce]);

  useEffect(() => {
    if (!ctx && !rootCtx && !uncategorizedCtx) return;
    const close = () => {
      setCtx(null);
      setRootCtx(null);
      setUncategorizedCtx(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [ctx, rootCtx, uncategorizedCtx]);

  useEffect(() => {
    const tree = treeRef.current;
    if (!tree || documentRevealRequest) return;
    const targetId = selectedId === null ? "__root__" : selectedId;
    if (!targetId) return;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        const target = Array.from(tree.querySelectorAll<HTMLElement>("[data-folder-id]"))
          .find((element) => element.dataset.folderId === targetId);
        target?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [folders, selectedId, documentRevealRequest]);

  const openContextMenu = (event: React.MouseEvent, folder: Folder) => {
    event.preventDefault();
    event.stopPropagation();
    const menuWidth = 190;
    const menuHeight = scope === "notes" ? 410 : onCopyToLibrary ? 338 : 310;
    const position = clampFolderContextMenuPosition(event.clientX, event.clientY, menuWidth, menuHeight);
    menuReturnFocus.current = event.currentTarget as HTMLElement;
    setRootCtx(null); setUncategorizedCtx(null);
    setCtx({ folder, ...position });
  };

  const openUncategorizedContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const menuWidth = 190;
    const menuHeight = 92;
    setCtx(null);
    setRootCtx(null);
    menuReturnFocus.current = event.currentTarget as HTMLElement;
    setUncategorizedCtx(clampFolderContextMenuPosition(event.clientX, event.clientY, menuWidth, menuHeight));
  };

  const openRootContextMenu = (event: React.MouseEvent) => {
    if (scope !== "notes" && !onImport && !onExport) return;
    const target = event.target as HTMLElement | null;
    const row = target?.closest(".folder-item, .folder-document-item, .folder-ctx-react");
    if (row && !(scope === "notes" && row.matches('[data-folder-id="__root__"]'))) return;
    event.preventDefault();
    event.stopPropagation();
    const menuWidth = 190;
    const menuHeight = scope === "notes" ? 200 : 92;
    setCtx(null);
    setUncategorizedCtx(null);
    menuReturnFocus.current = event.currentTarget as HTMLElement;
    setRootCtx(clampFolderContextMenuPosition(event.clientX, event.clientY, menuWidth, menuHeight));
  };

  const runCtx = (action: () => void | Promise<void>) => {
    if (menuActionClaimed.current) return;
    menuActionClaimed.current = true;
    setCtx(null);
    setRootCtx(null);
    setUncategorizedCtx(null);
    void action();
  };

  const handleSubmenuEnter = (event: React.MouseEvent<HTMLDivElement>) => {
    const itemEl = event.currentTarget;
    const subEl = itemEl.querySelector<HTMLElement>(".folder-ctx-sub-react");
    if (!subEl) return;

    const itemRect = itemEl.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const margin = 12;

    const itemCount = 1 + moveTargets.length;
    const estimatedSubmenuHeight = Math.min(260, itemCount * 28 + 10);

    const spaceBelow = vh - itemRect.top - margin;
    const spaceAbove = itemRect.bottom - margin;

    const shouldFlipUp = spaceBelow < estimatedSubmenuHeight && spaceAbove > spaceBelow;
    const maxAvailable = shouldFlipUp ? spaceAbove : spaceBelow;
    const maxHeight = Math.min(260, Math.max(100, Math.floor(maxAvailable)));

    const shouldFlipLeft = itemRect.right + 180 > vw;

    subEl.style.top = shouldFlipUp ? "auto" : "-4px";
    subEl.style.bottom = shouldFlipUp ? "-4px" : "auto";
    subEl.style.left = shouldFlipLeft ? "auto" : "100%";
    subEl.style.right = shouldFlipLeft ? "100%" : "auto";
    subEl.style.maxHeight = `${maxHeight}px`;

    if (shouldFlipUp) {
      subEl.classList.add("flip-up");
    } else {
      subEl.classList.remove("flip-up");
    }

    if (shouldFlipLeft) {
      subEl.classList.add("flip-left");
    } else {
      subEl.classList.remove("flip-left");
    }
  };

  const submitRename = async () => {
    if (!renameDialog) return;
    const nextName = renameDialog.name.trim();
    if (nextName && nextName !== renameDialog.folder.name) {
      await onRename?.(renameDialog.folder.id, nextName);
    }
    setRenameDialog(null);
  };

  const beginFolderRename = (folder: Folder) => {
    if (scope !== "notes") {
      setRenameDialog({ folder, name: folder.name });
      return;
    }
    setInlineRename({
      kind: "folder",
      id: folder.id,
      name: folder.name,
      originalName: folder.name,
    });
  };

  const finishInlineRename = async (commit: boolean) => {
    const state = inlineRenameRef.current;
    if (!state) return;
    inlineRenameRef.current = null;
    setInlineRename(null);
    if (!commit) return;
    const nextName = state.name.trim();
    if (!nextName || nextName === state.originalName) return;
    if (state.kind === "folder") {
      await onRename?.(state.id, nextName);
      return;
    }
    await onRenameDocument?.(state.id, nextName);
  };

  const renameInputProps = (state: InlineRenameState): InlineRenameInputProps => ({
    ref: inlineInputRef,
    className: "folder-inline-rename-input",
    value: state.name,
    onChange: (event) => setInlineRename({ ...state, name: event.currentTarget.value }),
    onClick: (event) => event.stopPropagation(),
    onMouseDown: (event) => event.stopPropagation(),
    onPointerDown: (event) => event.stopPropagation(),
    onDoubleClick: (event) => event.stopPropagation(),
    onContextMenu: (event) => event.stopPropagation(),
    onBlur: () => void finishInlineRename(true),
    onKeyDown: (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void finishInlineRename(true);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        void finishInlineRename(false);
      }
    },
  });

  const setFolderOpen = useCallback((folderId: string, open?: boolean) => {
    setOpenFolderIds((current) => {
      const nextOpen = typeof open === "boolean" ? open : !current.has(folderId);
      if (nextOpen === current.has(folderId)) return current;
      const next = new Set(current);
      if (nextOpen) next.add(folderId);
      else next.delete(folderId);
      if (scope === "materials") writeMaterialLibraryPreference("luckyray-materials-tree-open-v1", JSON.stringify([...next]), materialLibraryId);
      return next;
    });
  }, [scope, materialLibraryId]);

  const setActiveDragId = (folderId: string | null) => {
    draggingIdRef.current = folderId;
    setDraggingId(folderId);
    window.dispatchEvent(new CustomEvent("luckyray:folder-tree-drag", { detail: { active: Boolean(folderId) } }));
  };

  const canMoveFolderTo = (folderId: string, targetId: string | null) => {
    if (targetId === folderId) return false;
    return targetId === null || !getDescendantIds(folders, folderId).includes(targetId);
  };

  const canDropOn = (targetId: string | null) => {
    const drag = pointerDragRef.current;
    const activeId = drag?.id || draggingIdRef.current || draggingId;
    if (!activeId) return false;
    if (drag?.kind === "document") return Boolean(onMoveDocument);
    return canMoveFolderTo(activeId, targetId);
  };

  const resolveDropTarget = (x: number, y: number): string | null | undefined => {
    const element = document.elementFromPoint(x, y);
    const target = element?.closest<HTMLElement>("[data-folder-drop-id]");
    if (!target) return undefined;
    const id = target.dataset.folderDropId;
    if (!id) return undefined;
    return id === "__root__" ? null : id;
  };

  const resolveEventDropTarget = (event: React.DragEvent): string | null => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-folder-drop-id]");
    if (!target || !treeRef.current?.contains(target)) return null;
    const id = target.dataset.folderDropId;
    return id && id !== "__root__" ? id : null;
  };

  useEffect(() => {
    if (!onExternalDrop || !nativeExternalDropEnabled) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    const resolveNativeDropTarget = (position: { x: number; y: number }) => {
      const scale = window.devicePixelRatio || 1;
      const element = document.elementFromPoint(position.x / scale, position.y / scale);
      const target = element?.closest<HTMLElement>("[data-folder-drop-id]");
      if (!target || !treeRef.current?.contains(target)) return undefined;
      const id = target.dataset.folderDropId;
      if (!id) return undefined;
      return id !== "__root__" ? id : null;
    };

    // WebView2 emits these to the webview target, not the enclosing Window.
    // Keep the tree on the same native event channel as the material content.
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((event) => {
        if (disposed) return;
        const payload = event.payload;
        if (payload.type === "leave") {
          edgeScroller.stop();
          nativeExternalDragActiveRef.current = false;
          setDropTarget(null);
          return;
        }

        const targetId = resolveNativeDropTarget(payload.position);
        if (payload.type === "enter" || payload.type === "over") {
          if (scope === "materials") {
            const scale = window.devicePixelRatio || 1;
            edgeScroller.update(treeRef.current?.closest<HTMLElement>(".sidebar-nav") ?? null,
              payload.position.x / scale, payload.position.y / scale, () => {
                const next = resolveNativeDropTarget(payload.position);
                setDropTarget(next === undefined ? null : { id: next });
              });
          }
          nativeExternalDragActiveRef.current = targetId !== undefined;
          setDropTarget(targetId === undefined ? null : { id: targetId });
          return;
        }

        nativeExternalDragActiveRef.current = false;
        edgeScroller.stop();
        setDropTarget(null);
        if (targetId === undefined) return;
        lastNativeExternalDropAtRef.current = Date.now();
        void onExternalDropRef.current?.(targetId, { source: "tauri", paths: payload.paths });
      }))
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => {
        nativeExternalDragActiveRef.current = false;
      });

    return () => {
      disposed = true;
      edgeScroller.stop();
      unlisten?.();
    };
  }, [Boolean(onExternalDrop), nativeExternalDropEnabled]);

  const handleExternalDragOver = (event: React.DragEvent) => {
    if (!onExternalDrop || !hasExternalFileDrop(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setDropTarget({ id: resolveEventDropTarget(event) });
  };

  const handleExternalDrop = (event: React.DragEvent) => {
    edgeScroller.stop();
    if (!onExternalDrop || !hasExternalFileDrop(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const targetId = resolveEventDropTarget(event);
    setDropTarget(null);
    if (nativeExternalDragActiveRef.current || Date.now() - lastNativeExternalDropAtRef.current < 750) return;
    void onExternalDrop(targetId, { source: "browser", event });
  };

  const handleExternalDragLeave = (event: React.DragEvent) => {
    const nextTarget = event.relatedTarget as Node | null;
    if (!nextTarget || !treeRef.current?.contains(nextTarget)) {
      edgeScroller.stop();
      setDropTarget(null);
    }
  };

  const updatePointerDropTarget = (x: number, y: number) => {
    const targetId = resolveDropTarget(x, y);
    const drag = pointerDragRef.current;
    if (!drag) return;
    const canDrop = drag.kind === "folder"
      ? canMoveFolderTo(drag.id, targetId ?? null)
      : Boolean(onMoveDocument);
    if (targetId === undefined || !canDrop) {
      drag.targetId = undefined;
      setDropTarget(null);
      return;
    }
    drag.targetId = targetId;
    setDropTarget({ id: targetId });
  };

  const startPointerDrag = (
    event: React.PointerEvent,
    kind: FolderTreeDragKind,
    id: string,
    sourceFolderId?: string | null,
  ) => {
    if (event.button !== 0) return;
    if (kind === "folder" && !onMove) return;
    if (kind === "document" && !onMoveDocument) return;
    const target = event.target as HTMLElement | null;
    const blockedSelector = kind === "document"
      ? ".folder-action-btn-react, input, textarea, a"
      : ".folder-chevron, .folder-action-btn-react, button, input, textarea, a";
    if (target?.closest(blockedSelector)) return;

    pointerDragRef.current = {
      kind,
      id,
      sourceFolderId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      targetId: undefined,
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || drag.kind !== kind || drag.id !== id) return;
      const distance = Math.hypot(moveEvent.clientX - drag.startX, moveEvent.clientY - drag.startY);
      if (!drag.active && distance < 5) return;
      if (!drag.active) {
        drag.active = true;
        suppressClickRef.current = true;
        setActiveDragId(id);
        document.body.classList.add("folder-pointer-dragging");
      }
      moveEvent.preventDefault();
      updatePointerDropTarget(moveEvent.clientX, moveEvent.clientY);
      if (scope === "materials") edgeScroller.update(treeRef.current?.closest<HTMLElement>(".sidebar-nav") ?? null,
        moveEvent.clientX, moveEvent.clientY, () => updatePointerDropTarget(moveEvent.clientX, moveEvent.clientY));
    };

    const finishPointerDrag = (upEvent: PointerEvent) => {
      edgeScroller.stop();
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishPointerDrag);
      window.removeEventListener("pointercancel", cancelPointerDrag);

      const drag = pointerDragRef.current;
      pointerDragRef.current = null;
      document.body.classList.remove("folder-pointer-dragging");
      if (!drag || drag.kind !== kind || drag.id !== id) return;

      if (drag.active) {
        upEvent.preventDefault();
        const targetId = drag.targetId;
        setActiveDragId(null);
        setDropTarget(null);
        if (targetId !== undefined) {
          if (drag.kind === "folder" && canMoveFolderTo(drag.id, targetId)) {
            void onMove?.(drag.id, targetId);
          } else if (drag.kind === "document" && onMoveDocument) {
            if (drag.sourceFolderId === targetId) {
              onDropRejected?.(t("error.sameFolder"));
            } else {
              void onMoveDocument(drag.id, targetId);
            }
          } else {
            onDropRejected?.(t("error.move"));
          }
        }
        window.setTimeout(() => { suppressClickRef.current = false; }, 0);
      } else {
        suppressClickRef.current = false;
      }
    };

    const cancelPointerDrag = () => {
      edgeScroller.stop();
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishPointerDrag);
      window.removeEventListener("pointercancel", cancelPointerDrag);
      pointerDragRef.current = null;
      setActiveDragId(null);
      setDropTarget(null);
      suppressClickRef.current = false;
      document.body.classList.remove("folder-pointer-dragging");
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", finishPointerDrag);
    window.addEventListener("pointercancel", cancelPointerDrag);
  };

  const selectFolder = (event: React.MouseEvent, folderId: string | null) => {
    if (suppressClickRef.current) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onSelect(folderId);
  };

  const requestDeleteFolder = (folder: Folder) => {
    const impact = getFolderDeleteImpact(folder, allDocumentsByFolderId || documentsByFolderId);
    if (scope === "notes" && readBooleanPreference(folderDeleteSkipKey(impact))) {
      void onDelete?.(folder.id);
      return;
    }
    setDeleteDialog(folder);
  };

  const deleteImpact = deleteDialog
    ? getFolderDeleteImpact(deleteDialog, allDocumentsByFolderId || documentsByFolderId)
    : null;
  const deleteSkipKey = deleteImpact ? folderDeleteSkipKey(deleteImpact) : FOLDER_EMPTY_DELETE_SKIP_CONFIRM_KEY;
  const deleteIsNonEmpty = !!deleteImpact && (deleteImpact.documentCount > 0 || deleteImpact.folderCount > 1);
  const deleteDisabledReason = deleteDialog && deleteImpact ? getDeleteDisabledReason?.(deleteDialog, deleteImpact) || null : null;

  return (
    <div ref={treeRef} className={`folder-sidebar-react${className ? ` ${className}` : ""}`}>
      {!hideHeader && (
        <div className="folder-sidebar-header-react">
          <span className="folder-sidebar-title-react">{t("header")}</span>
          <button
            className={`folder-sidebar-add-react${createButtonLabel ? " text" : ""}`}
            onClick={() => onCreate(null)}
            title={t("action.newFolder")}
          >
            {createButtonLabel ? (
              createButtonLabel
            ) : (
              <svg viewBox="0 0 16 16" width="12" height="12" stroke="currentColor" fill="none" strokeWidth="2">
                <line x1="8" y1="4" x2="8" y2="12" />
                <line x1="4" y1="8" x2="12" y2="8" />
              </svg>
            )}
          </button>
        </div>
      )}
      <div
        className={`folder-list${dropTarget?.id === null ? " folder-root-drop-target" : ""}`}
        data-folder-drop-id="__root__"
        onContextMenu={openRootContextMenu}
        onDragOver={handleExternalDragOver}
        onDrop={handleExternalDrop}
        onDragLeave={handleExternalDragLeave}
      >
        {showAllItem && (
          <div
            className={`folder-item folder-all-item${allControl ? " folder-all-with-accessory" : ""}${selectedId === null ? " active" : ""}${dropTarget?.id === null ? " drop-target" : ""}`}
            data-folder-id="__root__"
            data-folder-drop-id="__root__"
            tabIndex={-1}
            onClick={allControl ? undefined : (event) => selectFolder(event, null)}
            onPointerEnter={() => {
              if (canDropOn(null)) setDropTarget({ id: null });
            }}
          >
            {allControl ?? <><span className="folder-icon all">
              <FolderAllIcon scope={scope} />
            </span>
            <span className="folder-name">{resolvedAllLabel}</span></>}
          </div>
        )}
        {showUncategorized && (
          <div className="folder-group folder-uncategorized-group">
            <div
              className={`folder-item folder-uncategorized-item${selectedId === "__uncategorized__" ? " active" : ""}`}
              data-folder-id="__uncategorized__"
              tabIndex={-1}
              onClick={() => {
                onUncategorized?.();
                if (hasUncategorizedDocuments) setUncategorizedOpen((open) => !open);
              }}
              onContextMenu={openUncategorizedContextMenu}
            >
              <span
                className={`folder-chevron${uncategorizedOpen ? " open" : ""}${!hasUncategorizedDocuments ? " hidden" : ""}`}
                onClick={(event) => {
                  event.stopPropagation();
                  if (hasUncategorizedDocuments) setUncategorizedOpen((open) => !open);
                }}
              >
                <svg viewBox="0 0 16 16" width="10" height="10" stroke="currentColor" fill="none" strokeWidth="2">
                  <path d="M6 4l4 4-4 4" />
                </svg>
              </span>
              <span className="folder-icon">
                <svg viewBox="0 0 16 16"><path d="M2 4h5l2 2h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" /></svg>
              </span>
              <span className="folder-name">{t("uncategorized")}</span>
            </div>
            {uncategorizedOpen && hasUncategorizedDocuments && (
              <div className="folder-documents folder-uncategorized-documents">
                {uncategorizedDocuments.map((document) => (
                  <FolderDocumentItem
                    key={document.id}
                    document={document}
                    active={selectedDocumentId === document.id}
                    depth={1}
                    dragging={draggingId === document.id}
                    dropFolderId={null}
                    onSelect={(documentId) => {
                      onSelect("__uncategorized__");
                      onSelectDocument?.(documentId);
                    }}
                    onContextMenu={onDocumentContextMenu}
                    onPointerDragStart={onMoveDocument ? startPointerDrag : undefined}
                    isClickSuppressed={() => suppressClickRef.current}
                    inlineRename={inlineRename}
                    renameInputProps={renameInputProps}
                  />
                ))}
              </div>
            )}
          </div>
        )}
        {!showUncategorized && hasUncategorizedDocuments && (
          <div className="folder-documents folder-root-documents">
            {uncategorizedDocuments.map((document) => (
              <FolderDocumentItem
                key={document.id}
                document={document}
                active={selectedDocumentId === document.id}
                depth={0}
                dragging={draggingId === document.id}
                dropFolderId={null}
                onSelect={(documentId) => {
                  onSelect(null);
                  onSelectDocument?.(documentId);
                }}
                onContextMenu={onDocumentContextMenu}
                onPointerDragStart={onMoveDocument ? startPointerDrag : undefined}
                isClickSuppressed={() => suppressClickRef.current}
                inlineRename={inlineRename}
                renameInputProps={renameInputProps}
              />
            ))}
          </div>
        )}
        {folders.map((folder) => (
          <FolderItem
            key={folder.id}
            folder={folder}
            selectedId={selectedId}
            onCreate={onCreate}
            onContextMenu={openContextMenu}
            draggingId={draggingId}
            dropTarget={dropTarget}
            canDropOn={canDropOn}
            onPointerDragStart={startPointerDrag}
            onDragOverFolder={(folderId) => setDropTarget(folderId === null ? null : { id: folderId })}
            onSelectFolder={selectFolder}
            onSelectFolderId={onSelect}
            documentsByFolderId={documentsByFolderId}
            selectedDocumentId={selectedDocumentId}
            onSelectDocument={onSelectDocument}
            onDocumentContextMenu={onDocumentContextMenu}
            onDocumentPointerDragStart={onMoveDocument ? startPointerDrag : undefined}
            isClickSuppressed={() => suppressClickRef.current}
            inlineRename={inlineRename}
            renameInputProps={renameInputProps}
            openFolderIds={openFolderIds}
            setFolderOpen={setFolderOpen}
            depth={0}
          />
        ))}
      </div>
      {uncategorizedCtx && (
        <div
          ref={menuRef} role="menu" onKeyDown={onMenuKeyDown}
          className="folder-ctx-react"
          style={{ left: uncategorizedCtx.x, top: uncategorizedCtx.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {scope === "notes" && (
            <FolderCtxItem icon={<IconNote />} label={t("action.newNote")} onClick={() => runCtx(() => onCreateNote?.("__uncategorized__"))} />
          )}
          <FolderCtxItem icon={<IconFolderPlus />} label={t("action.newFolder")} onClick={() => runCtx(() => onCreate(null))} />
        </div>
      )}
      {rootCtx && (
        <div
          ref={menuRef} role="menu" onKeyDown={onMenuKeyDown}
          className="folder-ctx-react"
          style={{ left: rootCtx.x, top: rootCtx.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {scope === "notes" ? (
            <>
              <FolderCtxItem icon={<IconNote />} label={t("action.newNote")} onClick={() => runCtx(() => onCreateNote?.("__uncategorized__"))} />
              <FolderCtxItem icon={<IconFolderPlus />} label={t("action.newFolder")} onClick={() => runCtx(() => onCreate(null))} />
              <div className="folder-ctx-sep-react" />
              <FolderCtxItem icon={<IconUpload />} label={t("action.importHere")} onClick={() => runCtx(() => onImport?.(null))} />
              <FolderCtxItem icon={<IconDownload />} label={t("action.exportDocuments")} onClick={() => runCtx(() => onExport?.(null))} />
            </>
          ) : (
            <>
              <FolderCtxItem icon={<IconUpload />} label={t("action.import")} onClick={() => runCtx(() => onImport?.(null))} />
              <FolderCtxItem icon={<IconDownload />} label={t("action.exportIndexAll")} onClick={() => runCtx(() => onExport?.(null))} />
              {onExportOriginals && <FolderCtxItem icon={<IconDownload />} label={t("action.exportOriginals")} onClick={() => runCtx(() => onExportOriginals(null))} />}
            </>
          )}
        </div>
      )}
      {ctx && (
        <div
          ref={menuRef} role="menu" onKeyDown={onMenuKeyDown}
          className={`folder-ctx-react${ctx.x + 190 + 170 > (typeof window !== "undefined" ? window.innerWidth : 1200) ? " flip-sub-left" : ""}`}
          style={{ left: ctx.x, top: ctx.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {scope === "notes" ? (
            <>
              <FolderCtxItem icon={<IconNote />} label={t("action.newNote")} onClick={() => runCtx(() => onCreateNote?.(ctx.folder.id))} />
              <FolderCtxItem icon={<IconFolderPlus />} label={t("action.newSubfolder")} onClick={() => runCtx(() => onCreate(ctx.folder.id))} />
              <div className="folder-ctx-sep-react" />
              <FolderCtxItem icon={<IconEdit />} label={t("action.renameFolder")} onClick={() => runCtx(() => beginFolderRename(ctx.folder))} />
              <FolderCtxItem icon={<IconMove />} label={t("action.moveFolder")} onClick={() => runCtx(() => { setMoveDialog({ folder: ctx.folder }); setMoveQuery(""); })} />
            </>
          ) : (
            <>
              <FolderCtxItem icon={<IconFolderPlus />} label={t("action.newFolder")} onClick={() => runCtx(() => onCreate(null))} />
              <FolderCtxItem icon={<IconFolderPlus />} label={t("action.newSubfolder")} onClick={() => runCtx(() => onCreate(ctx.folder.id))} />
              <div className="folder-ctx-sep-react" />
              <FolderCtxItem icon={<IconUpload />} label={t("action.import")} onClick={() => runCtx(() => onImport?.(ctx.folder.id))} />
              <FolderCtxItem icon={<IconDownload />} label={t("action.exportIndexAll")} onClick={() => runCtx(() => onExport?.(ctx.folder.id))} />
              {onExportOriginals && <FolderCtxItem icon={<IconDownload />} label={t("action.exportOriginals")} onClick={() => runCtx(() => onExportOriginals(ctx.folder.id))} />}
              {onExportCsv && <FolderCtxItem icon={<IconDownload />} label={t("action.exportCsv")} onClick={() => runCtx(() => {
                if (findFolder(folders, ctx.folder.id)) return onExportCsv(ctx.folder.id);
              })} />}
              {onCopyToLibrary && <FolderCtxItem icon={<IconMove />} label="复制此分类到其他素材库" onClick={() => runCtx(() => { if (findFolder(folders, ctx.folder.id)) onCopyToLibrary(ctx.folder.id); })} />}
              <div className="folder-ctx-sep-react" />
              <FolderCtxItem icon={<IconEdit />} label={t("action.rename")} onClick={() => runCtx(() => setRenameDialog({ folder: ctx.folder, name: ctx.folder.name }))} />
            </>
          )}
          {scope !== "notes" && moveTargets.length > 0 && (
            <div className="folder-ctx-item-react has-sub" onMouseEnter={handleSubmenuEnter}>
              <IconMove />
              <span>{t("move.submenu")}</span>
              <span className="folder-ctx-arrow-react"><IconChevronRight /></span>
              <div className="folder-ctx-sub-react">
                <button type="button" onClick={() => runCtx(() => onMove?.(ctx.folder.id, null))}>{t("root")}</button>
                {moveTargets.map((target) => (
                  <button type="button" key={target.id} onClick={() => runCtx(() => onMove?.(ctx.folder.id, target.id))}>{target.name}</button>
                ))}
              </div>
            </div>
          )}
          {scope === "notes" && (
            <>
              <div className="folder-ctx-sep-react" />
              <FolderCtxItem icon={<IconPath />} label={folderPathActions?.copy ? t("path.copy") : t("path.copyUnavailable")} disabled={!folderPathActions?.copy} title={folderPathActions?.copy ? undefined : t("path.copyHint")} onClick={() => folderPathActions?.copy && runCtx(() => folderPathActions.copy!(ctx.folder.id))} />
              <FolderCtxItem icon={<IconReveal />} label={folderPathActions?.reveal ? t("path.reveal") : t("path.revealUnavailable")} disabled={!folderPathActions?.reveal} title={folderPathActions?.reveal ? undefined : t("path.revealHint")} onClick={() => folderPathActions?.reveal && runCtx(() => folderPathActions.reveal!(ctx.folder.id))} />
              <div className="folder-ctx-sep-react" />
              <FolderCtxItem icon={<IconUpload />} label={t("action.importHere")} onClick={() => runCtx(() => onImport?.(ctx.folder.id))} />
              <FolderCtxItem icon={<IconDownload />} label={t("action.exportDocuments")} onClick={() => runCtx(() => onExport?.(ctx.folder.id))} />
            </>
          )}
          <div className="folder-ctx-sep-react" />
          <FolderCtxItem icon={<IconTrash />} label={t("action.deleteFolder")} danger onClick={() => runCtx(() => requestDeleteFolder(ctx.folder))} />
        </div>
      )}
      {moveDialog && (
        <div className="folder-dialog-overlay-react experience-dialog-backdrop" onPointerDown={() => setMoveDialog(null)}>
          <div className="folder-dialog-react folder-move-dialog-react experience-dialog" role="dialog" aria-modal="true" aria-label={t("move.title")} onPointerDown={(event) => event.stopPropagation()}>
            <div className="folder-dialog-title-react">{t("move.title")}</div>
            <p>{t("move.copy", { name: moveDialog.folder.name })}</p>
            <input
              value={moveQuery}
              autoFocus
              placeholder={t("move.search")}
              onChange={(event) => setMoveQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setMoveDialog(null);
              }}
            />
            <div className="folder-move-target-list">
              <button type="button" onClick={() => { const id = moveDialog.folder.id; setMoveDialog(null); void onMove?.(id, null); }}>
                <span>{t("root")}</span>
                <small>{t("move.rootCopy")}</small>
              </button>
              {filteredDialogMoveTargets.map((target) => (
                <button type="button" className="folder-move-path-target" key={target.id} onClick={() => { const id = moveDialog.folder.id; setMoveDialog(null); void onMove?.(id, target.id); }}>
                  <span>{target.name}</span>
                  <small>{t("move.here")}</small>
                </button>
              ))}
              {filteredDialogMoveTargets.length === 0 && <div className="folder-dialog-empty-react">{t("move.empty")}</div>}
            </div>
            <div className="folder-dialog-actions-react">
              <button type="button" onClick={() => setMoveDialog(null)}>{t("action.cancel")}</button>
            </div>
          </div>
        </div>
      )}
      {renameDialog && (
        <div className="folder-dialog-overlay-react experience-dialog-backdrop" onPointerDown={() => setRenameDialog(null)}>
          <div className="folder-dialog-react experience-dialog" role="dialog" aria-modal="true" aria-label={t("rename.title")} onPointerDown={(event) => event.stopPropagation()}>
            <div className="folder-dialog-title-react">{t("rename.title")}</div>
            <input
              value={renameDialog.name}
              autoFocus
              onChange={(event) => setRenameDialog({ ...renameDialog, name: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submitRename();
                if (event.key === "Escape") setRenameDialog(null);
              }}
            />
            <div className="folder-dialog-actions-react">
              <button type="button" onClick={() => setRenameDialog(null)}>{t("action.cancel")}</button>
              <button type="button" className="primary" onClick={() => void submitRename()}>{t("action.confirm")}</button>
            </div>
          </div>
        </div>
      )}
      {deleteDialog && (
        <div className="folder-dialog-overlay-react experience-dialog-backdrop" onPointerDown={() => setDeleteDialog(null)}>
          <div className="folder-dialog-react experience-dialog" role="alertdialog" aria-modal="true" aria-label={t("delete.title")} onPointerDown={(event) => event.stopPropagation()}>
            <div className="folder-dialog-title-react">{t("delete.title")}</div>
            <p>
              {deleteDescription && deleteImpact
                ? deleteDescription(deleteDialog, deleteImpact)
                : scope === "notes"
                  ? t("delete.nonempty", { name: deleteDialog.name })
                  : t("delete.empty", { name: deleteDialog.name })}
            </p>
            {deleteImpact && (
              <div className="folder-delete-impact-react">
                <span>{plural(deleteImpact.folderCount, { one: "delete.folderImpact.one", other: "delete.folderImpact.other" })}</span>
                <span>{plural(deleteImpact.documentCount, { one: "delete.documentImpact.one", other: "delete.documentImpact.other" })}</span>
              </div>
            )}
            {scope === "notes" && !hideDeleteSkipConfirm && (
              <label className="folder-danger-confirm-react">
                <input
                  type="checkbox"
                  checked={deleteSkipNext}
                  onChange={(event) => setDeleteSkipNext(event.target.checked)}
                />
                <span>{deleteIsNonEmpty ? t("delete.skipNonempty") : t("delete.skipEmpty")}</span>
              </label>
            )}
            <div className="folder-dialog-actions-react">
              <button type="button" onClick={() => setDeleteDialog(null)}>{t("action.cancel")}</button>
              <button
                type="button"
                className="danger"
                disabled={!!deleteDisabledReason}
                title={deleteDisabledReason || undefined}
                onClick={() => {
                  if (deleteDisabledReason) return;
                  const id = deleteDialog.id;
                  if (scope === "notes") writeBooleanPreference(deleteSkipKey, deleteSkipNext);
                  setDeleteDialog(null);
                  void onDelete?.(id);
                }}
              >
                {t("action.delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

function FolderItem({
  folder,
  selectedId,
  onCreate,
  onContextMenu,
  draggingId,
  dropTarget,
  canDropOn,
  onPointerDragStart,
  onDragOverFolder,
  onSelectFolder,
  onSelectFolderId,
  documentsByFolderId,
  selectedDocumentId,
  onSelectDocument,
  onDocumentContextMenu,
  onDocumentPointerDragStart,
  isClickSuppressed,
  inlineRename,
  renameInputProps,
  openFolderIds,
  setFolderOpen,
  depth,
}: {
  folder: Folder;
  selectedId: string | null;
  onCreate: (parentId: string | null) => void;
  onContextMenu: (event: React.MouseEvent, folder: Folder) => void;
  draggingId: string | null;
  dropTarget: { id: string | null } | null;
  canDropOn: (targetId: string | null) => boolean;
  onPointerDragStart: (
    event: React.PointerEvent,
    kind: FolderTreeDragKind,
    id: string,
    sourceFolderId?: string | null,
  ) => void;
  onDragOverFolder: (folderId: string | null) => void;
  onSelectFolder: (event: React.MouseEvent, folderId: string | null) => void;
  onSelectFolderId: (folderId: string | null) => void;
  documentsByFolderId?: Record<string, FolderTreeDocument[]>;
  selectedDocumentId?: string | null;
  onSelectDocument?: (documentId: string) => void;
  onDocumentContextMenu?: (documentId: string, event: React.MouseEvent) => void;
  onDocumentPointerDragStart?: (
    event: React.PointerEvent,
    kind: FolderTreeDragKind,
    id: string,
    sourceFolderId?: string | null,
  ) => void;
  isClickSuppressed: () => boolean;
  inlineRename: InlineRenameState | null;
  renameInputProps: (state: InlineRenameState) => InlineRenameInputProps;
  openFolderIds: Set<string>;
  setFolderOpen: (folderId: string, open?: boolean) => void;
  depth: number;
}) {
  const { t } = useMessages(COPY);
  const hasChildren = folder.children && folder.children.length > 0;
  const documents = documentsByFolderId?.[folder.id] || [];
  const hasDocuments = documents.length > 0;
  const hasNestedContent = hasChildren || hasDocuments;
  const open = openFolderIds.has(folder.id);

  return (
    <div>
      <div
        className={`folder-item folder-draggable${selectedId === folder.id ? " active" : ""}${draggingId === folder.id ? " dragging" : ""}${dropTarget?.id === folder.id ? " drop-target" : ""}`}
        style={{ paddingLeft: 8 }}
        data-folder-depth={depth}
        data-folder-id={folder.id}
        data-folder-drop-id={folder.id}
        tabIndex={0}
        onKeyDown={event => {
          if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          onContextMenu({ preventDefault: () => {}, stopPropagation: () => event.stopPropagation(),
            currentTarget: event.currentTarget, clientX: bounds.right, clientY: bounds.bottom } as unknown as React.MouseEvent, folder);
        }}
        onPointerDown={(event) => onPointerDragStart(event, "folder", folder.id)}
        onPointerEnter={() => {
          if (!canDropOn(folder.id)) return;
          onDragOverFolder(folder.id);
          if (hasNestedContent && !open) setFolderOpen(folder.id, true);
        }}
        onClick={(event) => {
          onSelectFolder(event, folder.id);
          if (!event.defaultPrevented && hasNestedContent) {
            setFolderOpen(folder.id, !open);
          }
        }}
        onContextMenu={(event) => onContextMenu(event, folder)}
      >
        <span
          className={`folder-chevron${open ? " open" : ""}${!hasNestedContent ? " hidden" : ""}`}
          onClick={(e) => { e.stopPropagation(); setFolderOpen(folder.id, !open); }}
        >
          <svg viewBox="0 0 16 16" width="10" height="10" stroke="currentColor" fill="none" strokeWidth="2">
            <path d="M6 4l4 4-4 4" />
          </svg>
        </span>
        <span className="folder-icon">
          <svg viewBox="0 0 16 16"><path d="M2 4h5l2 2h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" /></svg>
        </span>
        {inlineRename?.kind === "folder" && inlineRename.id === folder.id ? (
          <input {...renameInputProps(inlineRename)} />
        ) : (
          <span className="folder-name">{folder.name}</span>
        )}
        <span
          className="folder-action-btn-react"
          title={t("action.newSubfolder")}
          onClick={(e) => {
            e.stopPropagation();
            onCreate(folder.id);
          }}
        >
          <svg viewBox="0 0 16 16" width="10" height="10" stroke="currentColor" fill="none" strokeWidth="2">
            <line x1="8" y1="4" x2="8" y2="12" />
            <line x1="4" y1="8" x2="12" y2="8" />
          </svg>
        </span>
      </div>
      {hasNestedContent && open && (
        <div className="folder-children">
          {(folder.children || []).map((child) => (
            <FolderItem
              key={child.id}
              folder={child}
              selectedId={selectedId}
              onCreate={onCreate}
              onContextMenu={onContextMenu}
              draggingId={draggingId}
              dropTarget={dropTarget}
              canDropOn={canDropOn}
              onPointerDragStart={onPointerDragStart}
              onDragOverFolder={onDragOverFolder}
              onSelectFolder={onSelectFolder}
              onSelectFolderId={onSelectFolderId}
              documentsByFolderId={documentsByFolderId}
              selectedDocumentId={selectedDocumentId}
              onSelectDocument={onSelectDocument}
              onDocumentContextMenu={onDocumentContextMenu}
              onDocumentPointerDragStart={onDocumentPointerDragStart}
              isClickSuppressed={isClickSuppressed}
              inlineRename={inlineRename}
              renameInputProps={renameInputProps}
              openFolderIds={openFolderIds}
              setFolderOpen={setFolderOpen}
              depth={depth + 1}
            />
          ))}
          {documents.map((document) => (
            <FolderDocumentItem
              key={document.id}
              document={document}
              active={selectedDocumentId === document.id}
              depth={depth + 1}
              dragging={draggingId === document.id}
              dropFolderId={folder.id}
              onSelect={(documentId) => {
                onSelectFolderId(folder.id);
                onSelectDocument?.(documentId);
              }}
              onContextMenu={onDocumentContextMenu}
              onPointerDragStart={onDocumentPointerDragStart}
              isClickSuppressed={isClickSuppressed}
              inlineRename={inlineRename}
              renameInputProps={renameInputProps}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FolderDocumentItem({
  document,
  active,
  depth,
  dragging,
  dropFolderId,
  onSelect,
  onContextMenu,
  onPointerDragStart,
  isClickSuppressed,
  inlineRename,
  renameInputProps,
}: {
  document: FolderTreeDocument;
  active: boolean;
  depth: number;
  dragging?: boolean;
  dropFolderId: string | null;
  onSelect?: (documentId: string) => void;
  onContextMenu?: (documentId: string, event: React.MouseEvent) => void;
  onPointerDragStart?: (
    event: React.PointerEvent,
    kind: FolderTreeDragKind,
    id: string,
    sourceFolderId?: string | null,
  ) => void;
  isClickSuppressed?: () => boolean;
  inlineRename: InlineRenameState | null;
  renameInputProps: (state: InlineRenameState) => InlineRenameInputProps;
}) {
  return (
    <button
      type="button"
      className={`folder-document-item${active ? " active" : ""}${onPointerDragStart ? " folder-draggable" : ""}${dragging ? " dragging" : ""}`}
      data-folder-document-id={document.id}
      style={{ paddingLeft: 24 }}
      data-folder-depth={depth}
      data-folder-drop-id={dropFolderId === null ? "__root__" : dropFolderId}
      onPointerDown={(event) => onPointerDragStart?.(event, "document", document.id, dropFolderId)}
      onClick={(event) => {
        event.stopPropagation();
        if (isClickSuppressed?.()) {
          event.preventDefault();
          return;
        }
        onSelect?.(document.id);
      }}
      onContextMenu={(event) => {
        onContextMenu?.(document.id, event);
      }}
    >
      <span className="folder-document-icon">
        <svg viewBox="0 0 16 16"><path d="M4 2.5h5l3 3V14H4z" /><path d="M9 2.5V6h3" /></svg>
      </span>
      <span className="folder-document-text">
        {inlineRename?.kind === "document" && inlineRename.id === document.id ? (
          <input {...renameInputProps(inlineRename)} />
        ) : (
          <span className="folder-document-title">{document.title}</span>
        )}
        {document.subtitle ? <span className="folder-document-subtitle">{document.subtitle}</span> : null}
      </span>
    </button>
  );
}

function getMoveTargets(folders: Folder[], excludeId: string) {
  const excluded = new Set([excludeId, ...getDescendantIds(folders, excludeId)]);
  const targets: Array<{ id: string; name: string; depth: number }> = [];
  const walk = (items: Folder[], path: string, depth: number) => {
    items.forEach((folder) => {
      const name = path ? `${path}/${folder.name}` : folder.name;
      if (!excluded.has(folder.id)) targets.push({ id: folder.id, name, depth });
      walk(folder.children || [], name, depth + 1);
    });
  };
  walk(folders, "", 0);
  return targets;
}

function getDescendantIds(folders: Folder[], folderId: string): string[] {
  const folder = findFolder(folders, folderId);
  if (!folder) return [];
  return (folder.children || []).flatMap((child) => [child.id, ...getDescendantIds(folders, child.id)]);
}

function getFolderDeleteImpact(folder: Folder, documentsByFolderId: Record<string, FolderTreeDocument[]> | undefined) {
  const ids = [folder.id, ...getDescendantIds([folder], folder.id)];
  const documentCount = ids.reduce((count, id) => count + (documentsByFolderId?.[id]?.length || 0), 0);
  return {
    folderCount: ids.length,
    documentCount,
  };
}

function findFolder(folders: Folder[], folderId: string): Folder | null {
  for (const folder of folders) {
    if (folder.id === folderId) return folder;
    const found = findFolder(folder.children || [], folderId);
    if (found) return found;
  }
  return null;
}

function findDocumentById(
  documentsByFolderId: Record<string, FolderTreeDocument[]> | undefined,
  uncategorizedDocuments: FolderTreeDocument[],
  documentId: string,
) {
  const groups = [...Object.values(documentsByFolderId || {}), uncategorizedDocuments];
  for (const group of groups) {
    const document = group.find((item) => item.id === documentId);
    if (document) return document;
  }
  return null;
}

function collectFolderIdsSet(folders: Folder[]) {
  const ids = new Set<string>();
  const walk = (items: Folder[]) => {
    items.forEach((folder) => {
      ids.add(folder.id);
      walk(folder.children || []);
    });
  };
  walk(folders);
  return ids;
}

function collectAutoOpenFolderIds(
  folders: Folder[],
  selectedId: string | null,
  forceOpenFolderIds?: Set<string>,
) {
  const ids = new Set<string>();
  const openPath = (path: string[]) => path.forEach((id) => ids.add(id));
  const walk = (items: Folder[], ancestors: string[]) => {
    items.forEach((folder) => {
      const path = [...ancestors, folder.id];
      if (forceOpenFolderIds?.has(folder.id)) {
        openPath(path);
      }
      if (selectedId === folder.id) {
        openPath(ancestors);
      }
      walk(folder.children || [], path);
    });
  };
  walk(folders, []);
  return ids;
}

function setsEqual<T>(left: Set<T>, right: Set<T>) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function hasExternalFileDrop(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) return false;
  const types = Array.from(dataTransfer.types || []);
  return types.includes("Files") || types.includes("text/uri-list") || types.includes("text/plain");
}

function FolderCtxItem({
  icon,
  label,
  danger,
  disabled,
  title,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button" role="menuitem"
      className={`folder-ctx-item-react${danger ? " danger" : ""}`}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

export function FolderAllIcon({ scope }: { scope: "materials" | "notes" }) {
  if (scope === "materials") {
    return (
      <svg viewBox="0 0 16 16">
        <rect x="2.5" y="2.5" width="4" height="4" rx="0.8" />
        <rect x="9.5" y="2.5" width="4" height="4" rx="0.8" />
        <rect x="2.5" y="9.5" width="4" height="4" rx="0.8" />
        <rect x="9.5" y="9.5" width="4" height="4" rx="0.8" />
      </svg>
    );
  }
  return <svg viewBox="0 0 16 16"><path d="M4 2h7a1 1 0 0 1 1 1v11H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" /><path d="M4 12h8" /></svg>;
}

function IconFolderPlus() {
  return <svg viewBox="0 0 16 16"><path d="M2 5a2 2 0 0 1 2-2h3l2 2h5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5Z" /><line x1="8" y1="7" x2="8" y2="11" /><line x1="6" y1="9" x2="10" y2="9" /></svg>;
}

function IconNote() {
  return <svg viewBox="0 0 16 16"><path d="M4 2h5l4 4v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" /><path d="M9 2v4h4" /><path d="M6 9h4M6 12h3" /></svg>;
}

function IconUpload() {
  return <svg viewBox="0 0 16 16"><path d="M2 10v3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3" /><polyline points="5 6 8 3 11 6" /><line x1="8" y1="3" x2="8" y2="10" /></svg>;
}

function IconDownload() {
  return <svg viewBox="0 0 16 16"><path d="M2 10v3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3" /><polyline points="5 7 8 10 11 7" /><line x1="8" y1="10" x2="8" y2="2" /></svg>;
}

function IconEdit() {
  return <svg viewBox="0 0 16 16"><path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" strokeLinejoin="round" /></svg>;
}

function IconMove() {
  return <svg viewBox="0 0 16 16"><path d="M2 10v3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3" /><polyline points="5 7 8 4 11 7" /><line x1="8" y1="4" x2="8" y2="10" /></svg>;
}

function IconTrash() {
  return <svg viewBox="0 0 16 16"><polyline points="3,4 13,4" /><line x1="6" y1="2" x2="10" y2="2" /><path d="M5 4v9a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V4" /></svg>;
}

function IconPath() {
  return <svg viewBox="0 0 16 16"><path d="M3 5h4l2 2h4" /><path d="M3 5v7h10V7" /><path d="M5 10h6" /></svg>;
}

function IconReveal() {
  return <svg viewBox="0 0 16 16"><path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h3l1.5 2h4.5A1.5 1.5 0 0 1 14 7.5v5A1.5 1.5 0 0 1 12.5 14h-9A1.5 1.5 0 0 1 2 12.5v-7Z" /><path d="M5 10h6" /><path d="M8 7v6" /></svg>;
}

function IconChevronRight() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 3 11 8 6 13" />
    </svg>
  );
}
