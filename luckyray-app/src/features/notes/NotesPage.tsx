import {NoteRouteVisibilityContext} from "./noteRouteVisibility";
import {InsertReferencePicker,type InsertPickerState} from './InsertReferencePicker';
import {findSourceEditorTokenAt,toggleMarkdownTaskAtBodyLine,detectAutocompleteTrigger,scoreAutocompleteLabel,wikiNoteSearchPart,wikiNoteSuffixPart,autocompletePopupPosition,sourceTextareaPositionFromPoint,applySourceListIndent,applySourceListEnter,applySourceListBackspace,type AutocompleteKind,type AutocompleteItem,type AutocompleteState} from './sourceNoteEditor';
import {EditorAutocomplete} from './EditorAutocomplete';
import {NoteDocumentSurface} from './NoteDocumentSurface';
import {PreviewAssetMedia,assetKindLabel} from './NotePreview';
import {EditorContextMenu,type TableEditorCommand} from './editor/EditorContextMenu';
import {IconExternal,IconPlus,IconArrowRight,IconWiki,IconEdit,IconCopy,IconTrash} from './editor/noteMenuIcons';
import { materialBlockInsertion, materialBlockSelection } from "../../core/markdown/materialBlockInsertion";
import { excerpt } from "./noteExcerpt";
import { NoteFilenameContext } from "./editor/noteFilename";
import { KnowledgeDraftSet } from "../../core/services/knowledgeDraftSet";
import { readKnowledgeMobileEditing } from "../../core/services/knowledgeLiveSync";
import { useAttachmentFileVersions } from "./useAttachmentFileVersions";
import { registerAttachmentDraftSession, readAttachmentRelinkRequest, subscribeAttachmentRelinkRequest } from "../../core/services/vaultAttachmentSessions";
import { AttachmentRelinkDialog } from "./AttachmentRelinkDialog";
import { Activity, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { resolveScopedShortcut } from "../../app/shortcuts";
import { attachmentContextIsCurrent, captureAttachmentContext, publishVaultAttachment, getVaultAttachmentWorkflow } from "../../core/services/vaultAttachments";
import { readActiveKnowledgeWriteSource } from "../../core/services/knowledgeSource";
import type { ImportReceipt } from "../../core/services/vaultAttachmentWorkflow";
import { VaultAttachmentsPanel } from "./VaultAttachmentsPanel";
import { AttachmentImportDialog } from "./AttachmentImportDialog";
import { ImportResultNotice } from './ImportResultNotice';
import { useVaultFileDrop } from './useVaultFileDrop';
import { useVaultAttachmentChanges, VaultLinkUpdateDialog } from "./VaultLinkUpdateDialog";
import { standardMarkdownReferences, refreshRecentAttachmentVersions } from "../../core/markdown/realVaultEmbeds";
import { resolveAttachmentBatchProgressive, mergeAttachmentBatch, attachmentResolutionMatches, type AttachmentMatch } from '../../core/services/vaultAttachmentResolution';
import { resolveNoteMediaSources } from './media/noteMediaGeometry';
import { useVaultAttachmentResolution } from './useVaultAttachmentResolution';
import { useApplicationModalSurface } from "../../app/applicationModalIsolation";
import { useI18n } from "../../core/i18n/index";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent, PointerEvent as ReactPointerEvent, ReactNode, SetStateAction } from "react";
import { flushSync } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getLuckyRayBridgeSync } from "../../core/bridge/luckyRayBridge";
import type { BridgeNotesInlineApplyResult, BridgeNotesInlinePreview, BridgeNotesVaultMarkdownEmbed, BridgeNotesVaultMarkdownIndex, BridgeNotesVaultMarkdownIndexDocument, BridgeNotesVaultMarkdownWikiLink, BridgeVaultMetadata } from "../../core/bridge/bridgeTypes";
import { hasMarkdownTagReferencesInText } from "../../core/markdown/inlineTags";
import {
  createRealVaultLibraryAssetResolver,
  isSafeRealVaultAssetRelativePath as isSafeRealVaultAssetRelativePathShared,
  resolveRealVaultEmbedAssetRelativePath as resolveRealVaultEmbedAssetRelativePathShared,
} from "../../core/markdown/realVaultEmbeds";
import { createRealVaultWikiTargetResolver, normalizeVaultRelativePath, normalizeWikiLinkKey as normalizeNoteLinkKey, parseWikiReferenceTarget, realVaultDocumentLookupAliases, realVaultMissingDocumentLocation, stripMarkdownExtension } from "../../core/markdown/wikiTargets";
import { clearCurrentNoteContext, clearNavFocus, createCurrentNoteContextPublisher, focusEntity, publishCurrentNoteContext, readNavFocus, resolveKnowledgeDocumentRef, type CurrentNoteContextPublisher } from "../../core/services/context";
import {
  commitKnowledgeDocumentTags,
  createKnowledgeDocument,
  knowledgeDocumentNoteId,
  knowledgeMutationSuccessStatus,
  resolveKnowledgeNoteNavigation,
  parseKnowledgeDocumentNoteId,
  type KnowledgeMutationResult,
} from "../../core/services/knowledge";
import { activateKnowledgeWritesForVault, clearActiveKnowledgeSource, setActiveKnowledgeSource } from "../../core/services/knowledgeSource";
import { hasUsableKnowledgeSnapshot, knowledgeStore, resolveKnowledgeDocumentAbsolutePath } from "../../core/services/knowledgeStore";
import { openInLightSeek } from "../../core/services/openInLightSeek";
import { smartFolderDraftHash } from "../../core/services/smartFolders";
import { getDraggedMaterialAsset, hasDraggedMaterialAsset, type DraggedMaterialAsset } from "../../core/services/assetDrag";
import { applyEditorCommand, replaceEditorContent } from "../../core/services/editor";
import type { AiWriteAction, EditorCommand } from "../../core/services/editor";
import { normalizeNoteHeadingPath, parseNoteFrontmatter } from "../../core/services/noteRenderer";
import { resolveEditableTableRange, parseEditableTableSource, serializeEditableTableSource, copyEditorTableRowText, copyEditorTableColumnText, applyEditableTableCommand } from './editor/tableCommands';
import { type LiveEditorShortcutCommand, type LiveEditorTableContext, type LiveMarkdownEditorHandle, type LiveEditorSessionSnapshot } from "./editor/LiveMarkdownEditor";
import "./media/noteContent.css";
import { clipboardDataUrlToImageFile, extractClipboardImageSource, isClipboardDataImageSource, type ClipboardImageSource } from "./editor/clipboardImages";
import type { LiveEditorTokenContext } from "./editor/types";
import { findSameNoteAnchorRange, getWikiAnchorCompletions, parseWikiAnchorQuery, sameNoteAnchorSearchQuery } from "./editor/sameNoteAnchors";
import { isPlainMarkdownCompletionAllowedAt } from "./editor/wikiCompletion";
import { acceptWorkspaceSourceProof, createRealVaultDocumentSource } from "./documentSource";
import type { KnowledgeDocument } from "./documentSource";
import type { KnowledgeSourceMode, KnowledgeTreeNode } from "../../core/bridge/knowledgeTypes";
import { NoteDocumentReadCoordinator } from "./noteDocumentReadCoordinator";
import { createVaultSessionAuthority, noteTabsStorageKey, persistNoteTabsForVault, readSavedNoteTabsForVault } from "./vaultSessionBarrier";
import { preparePublishedAttachment } from "./media/preparePublishedAttachment";
import type { PreparedAttachment } from "./editor/preparedAttachment";
import { createSerialAttachmentInserts } from "./editor/serialAttachmentInserts";
import { scheduleAttachmentPrefetch } from "./media/attachmentPrefetch";
import {
  NOTES_INDEX_COLLAPSE_THRESHOLD,
  NOTES_INDEX_DEFAULT_WIDTH,
  NOTES_INDEX_MAX_WIDTH,
  NOTES_INDEX_MIN_WIDTH,
  clampNotesIndexWidthTo,
  defaultNotesIndexWidthForViewport,
  notesIndexRestoreWidth,
  resolveNotesIndexWidth,
} from "./notesIndexWidth";
import { dedupeDroppedLocalPaths } from "./externalDropPaths";
import { FolderTree, type FolderTreeDocument, type FolderTreeExternalDrop } from "../folders/FolderTree";
import { flattenFolders } from "../folders/useFolders";
import type { Folder } from "../folders/useFolders";
import { useFavoriteItems } from "../favorites/useFavoriteItems";
import { resolveFavoriteNoteIdentity } from "../favorites/favoriteNoteIdentity";
import { NoteAttachmentSidebar } from './NoteAttachmentSidebar';
import settingsIconUrl from "../../assets/icons/lightseek-ui-v2/settings.svg";
import { mergeKnownNotesVaults, readKnownNotesVaults, rememberKnownNotesVault } from "./knownVaults";
import "../../components/editorialContentChrome.css";
import "./notes.css";
import { dockNotesTab, notesPaneIds, validateNotesLayoutSnapshot, restoreNotesLayoutState, type NotesDockTabRequest, type NotesLayoutSnapshot, type NotesPaneState } from "./notesPaneModel";
import { beginNotesTabPointerDrag, cancelNotesTabPointerDrag, NOTES_DOCK_TAB_EVENT } from "./notesPaneDocking";
import { canReopenSavedNote, preloadNotesLayout } from "./notesLayoutReopen";
import { NotesPaneViews } from "./notesPaneViews";
import {appendIncomingNotesPane,advanceNotesSavedReadProof,assertNotesNativeBaseline,freezeNotesNativeView,notesNativeViews,type NotesNativeViewBinding,type NotesNativeViewAdapter} from './notesNativeViewRegistry';
import {captureNoteMedia,captureNoteSource,captureNoteScroll,noteContentScrollElement,portableRetainedEditor,validateNoteViewPresentation,restoreNoteMedia,restoreNoteSource,restoreNotePresentationLayout,nextNotePresentationFrame,type NoteViewBaseline,type NoteViewPresentationSnapshot,type NoteSourcePresentation,type NoteViewMode} from './noteViewPresentation';
import type {NoteMedia} from './NoteRuntime';
import { registerIntegratedLayout } from "../../workspace/integratedLayoutRegistry";
import { registerWorkspaceFlush, workspaceCompositionActive } from "../../workspace/windowLifecycle";

export async function runKnowledgeTagMutationForStatus<T extends { mutation: KnowledgeMutationResult }>(
  write: () => Promise<T>,
  successMessage: string,
  publishStatus: (status: string) => void,
) {
  const value = await write();
  const status = knowledgeMutationSuccessStatus(value.mutation, successMessage);
  publishStatus(status);
  return {
    value,
    status,
  };
}

export function buildNotesVaultUiModel(
  vault: BridgeVaultMetadata | null,
  copy: { unopenedTitle: string; unopenedSubtitle: string },
) {
  const actions: Array<"create-vault" | "open-vault" | "refresh-vault"> = ["create-vault", "open-vault"];
  if (vault) actions.push("refresh-vault");
  return {
    source: "vault" as const,
    dbNoteMode: false,
    title: vault?.name || copy.unopenedTitle,
    subtitle: vault?.rootPath || copy.unopenedSubtitle,
    actions,
  };
}

type Note = {
  id: string;
  title: string;
  contentText: string;
  contentJson: string;
  folderId: string | null;
  color: string | null;
  createdAt: string;
  updatedAt: string;
};

type Tag = {
  id: string;
  name: string;
  assetCount?: number;
  noteCount?: number;
};

type Backlink = {
  id: string;
  title: string;
  updatedAt: string;
  snippet?: string;
};

type UnlinkedMention = {
  id: string;
  title: string;
  updatedAt: string;
  snippet: string;
};

type NoteLink = {
  targetTitle: string;
  toNoteId: string | null;
  isMissing: number;
};

type OutgoingNoteLinkDisplay = {
  label: string;
  meta: string;
  openOptions: NoteOpenOptions | null;
};

type NoteEmbed = {
  targetName: string;
  assetId: string | null;
  isMissing: number;
};

type Asset = {
  id: string;
  name: string;
  kind?: string;
  mimeType?: string;
  thumbnailUrl?: string;
  previewUrl?: string;
  originalPath?: string;
  libraryPath?: string | null;
};





type BacklinksTab = "outline" | "backlinks" | "notes" | "assets";
type NotesOpenTab = { id: string; kind?: "note" | "empty" };
type NotesSplitDirection = "left" | "right" | "up" | "down";
type NotesPaneLayout =
  | { kind: "pane"; id: string }
  | { kind: "split"; id: string; orientation: "row" | "column"; ratio: number; first: NotesPaneLayout; second: NotesPaneLayout };
type NotesPaneTabs = Record<string, NotesOpenTab[]>;
type NotesPaneActiveTabs = Record<string, string>;
type NotesPaneModes = Record<string, EditorMode>;
type NotesPaneDocumentSnapshot = {
  title: string;
  contentText: string;
  loaded: boolean;
};
type NotesPaneDocuments = Record<string, Record<string, NotesPaneDocumentSnapshot>>;
type NotesPaneAiRequest = { paneId: string; noteId: string; title: string; contentText: string };
type NotesPaneAiState = {
  noteId: string;
  panelOpen: boolean;
  busy: boolean;
  suggestion: NoteAiSuggestionState | null;
  selectedTags: string[] | null;
};
type NotesPaneAiStates = Record<string, Record<string, NotesPaneAiState>>;
type NotesTitlebarPane = {
  activeId: string;
  tabs: Array<{ id: string; kind: "note" | "empty"; title: string;viewId?:string }>;
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
const NOTES_SPLIT_DIVIDER_SIZE = 8;
const NOTES_SPLIT_LIVE_FIRST_TRACK = "--notes-split-live-first-track";

type NotesSplitDividerDragState = {
  splitId: string;
  orientation: "row" | "column";
  rect: DOMRect;
  pointerId: number;
  liveTitlebar: boolean;
  splitElement: HTMLDivElement;
  liveRoot: HTMLElement | null;
  latestClientX: number;
  latestClientY: number;
  lastRatio: number;
  frameId: number | null;
  resizeObserver: ResizeObserver | null;
  hasPointerMove: boolean;
  hasLiveUpdate: boolean;
};

function measureNotesSplitDrag(
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  orientation: "row" | "column",
  clientX: number,
  clientY: number,
) {
  const total = orientation === "row" ? rect.width : rect.height;
  const available = Math.max(1, total - NOTES_SPLIT_DIVIDER_SIZE);
  const preferredMinimum = orientation === "row" ? 280 : 210;
  const minimum = Math.min(preferredMinimum, Math.max(96, available / 2));
  const maximum = available - minimum;
  const offset = orientation === "row" ? clientX - rect.left : clientY - rect.top;
  const unclampedFirstSize = maximum < minimum
    ? available / 2
    : Math.min(Math.max(offset, minimum), maximum);
  const ratio = Math.min(.92, Math.max(.08, unclampedFirstSize / available));
  return { firstSize: ratio * available, ratio };
}

function notesSplitFirstTrack(ratio: number) {
  return `calc(${ratio * 100}% - ${ratio * NOTES_SPLIT_DIVIDER_SIZE}px)`;
}

function countNotesPanes(layout: NotesPaneLayout): number {
  return layout.kind === "pane" ? 1 : countNotesPanes(layout.first) + countNotesPanes(layout.second);
}

function firstNotesPaneId(layout: NotesPaneLayout): string {
  return layout.kind === "pane" ? layout.id : firstNotesPaneId(layout.first);
}

function getNotesTitlebarRow(layout: NotesPaneLayout | null): Extract<NotesPaneLayout, { kind: "split" }> | null {
  if (!layout || layout.kind !== "split") return null;
  if (layout.orientation === "row") return layout;
  if (layout.first.kind === "split" && layout.first.orientation === "row") return layout.first;
  return null;
}

function getNotesTitlebarPaneId(layout: NotesPaneLayout | null): string | null {
  const titlebarRow = getNotesTitlebarRow(layout);
  return titlebarRow ? firstNotesPaneId(titlebarRow.second) : null;
}

function replaceNotesPane(layout: NotesPaneLayout, paneId: string, replacement: NotesPaneLayout): NotesPaneLayout {
  if (layout.kind === "pane") return layout.id === paneId ? replacement : layout;
  return {
    ...layout,
    first: replaceNotesPane(layout.first, paneId, replacement),
    second: replaceNotesPane(layout.second, paneId, replacement),
  };
}

function removeNotesPane(layout: NotesPaneLayout, paneId: string): NotesPaneLayout | null {
  if (layout.kind === "pane") return layout.id === paneId ? null : layout;
  const first = removeNotesPane(layout.first, paneId);
  const second = removeNotesPane(layout.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...layout, first, second };
}

function updateNotesSplitRatio(layout: NotesPaneLayout, splitId: string, ratio: number): NotesPaneLayout {
  if (layout.kind === "pane") return layout;
  if (layout.id === splitId) return { ...layout, ratio };
  return {
    ...layout,
    first: updateNotesSplitRatio(layout.first, splitId, ratio),
    second: updateNotesSplitRatio(layout.second, splitId, ratio),
  };
}
type NoteTabMode = "replace" | "open";
type NoteSelectOptions = NoteOpenOptions & {
  focusEditor?: boolean;
  scrollList?: boolean;
  anchorInEditor?: boolean;
  tabMode?: NoteTabMode;
  syncGlobalTab?: boolean;
};
type NotesIndexPanel = "vault" | "settings";
type KnowledgeSearchResult = {
  id: string;
  kind: "folder" | "note-title" | "note-content";
  title: string;
  path?: string;
  snippet?: string;
};
type KnowledgeSearchGroups = {
  folders: KnowledgeSearchResult[];
  noteTitles: KnowledgeSearchResult[];
  noteContents: KnowledgeSearchResult[];
  total: number;
};
type DialogState =
  | { kind: "document"; parentId: string | null; name: string }
  | { kind: "folder"; parentId: string | null; name: string }
  | { kind: "tag"; selected: string[] };
type ConfirmState = { note: Note };
type MoveModalState = { note: Note };
type RenameDocumentRequestState = { documentId: string; nonce: number } | null;
type NoteCtxState = { note: Note; x: number; y: number };
type AiWriteMenuState = { x: number; y: number };
type EditorCtxState = { x: number; y: number; token?: LiveEditorTokenContext | null; table?: LiveEditorTableContext | null; selection?: { start: number; end: number } };

type LinkAliasDialogState =
  | { kind: "wiki"; token: LiveEditorTokenContext; target: string; alias: string }
  | { kind: "external"; token: LiveEditorTokenContext; title: string; href: string };
type TagRenameDialogState = { token: LiveEditorTokenContext; tagId: string; originalName: string; name: string };
type NoteOpenOptions = { blockId?: string | null; headingPath?: string | null };
type EditorMode = "live" | "source" | "preview";
type AttachmentInsertSession = {
  source: ReturnType<typeof readActiveKnowledgeWriteSource>;
  noteId: string | null;
  noteRequest: number;
  pane: string;
  paneEpoch: number;
  mode: EditorMode;
  modeEpoch: number;
};
type AttachmentInsertSelection = { start: number; end: number };
type AttachmentInsertCursor = {
  content: string;
  observedSelection: AttachmentInsertSelection;
  targetSelection: AttachmentInsertSelection;
  commitRevision: number;
};

function sameAttachmentSelection(left: AttachmentInsertSelection, right: AttachmentInsertSelection) {
  return left.start === right.start && left.end === right.end;
}
type NoteAiSuggestionState = { noteId?: string; summary?: string; auto_tags?: string[]; status?: string; error?: string };
type RealVaultWriteReason = "explicit-save" | "user-edit-autosave" | "create-missing-link" | "internal-hydrate" | "internal-switch";
type RealVaultExternalConflictState = { noteId: string; detectedAt: number } | null;
type RealVaultIndexDeltaDecision = "none" | "removed" | "changed" | "verify-gap";

function decideRealVaultIndexDelta(input: {
  previousVaultId: string | null;
  previousIndexVersion: number;
  currentVaultId: string;
  currentIndexVersion: number;
  currentPath: string | null;
  changedPaths: ReadonlySet<string>;
  removedPaths: ReadonlySet<string>;
}): RealVaultIndexDeltaDecision {
  if (!input.currentPath) return "none";
  if (input.previousVaultId !== input.currentVaultId || input.previousIndexVersion <= 0) return "none";
  if (input.currentIndexVersion <= input.previousIndexVersion) return "none";
  if (input.removedPaths.has(input.currentPath)) return "removed";
  if (input.changedPaths.has(input.currentPath)) return "changed";
  return input.currentIndexVersion > input.previousIndexVersion + 1 ? "verify-gap" : "none";
}

const BACKLINKS_TAB_KEY = "luckyray-notes-backlinks-tab-v1";
const NOTE_TABS_STATE_KEY = "luckyray-notes-tabs-state-v1";
const LEGACY_NOTE_TABS_STATE_KEY = "luckyray.openNoteTabs.v1";
const NOTES_INDEX_WIDTH_KEY = "luckyray-notes-index-width-v1";
const ATTACHMENT_SIDEBAR_WIDTH_KEY = "luckyray-notes-attachment-width-v1";
const ATTACHMENT_SIDEBAR_DEFAULT_WIDTH = 320;
const ATTACHMENT_SIDEBAR_MIN_WIDTH = 260;
const ATTACHMENT_SIDEBAR_MAX_WIDTH = 560;
const ATTACHMENT_SIDEBAR_COLLAPSE_THRESHOLD = 180;

function clampAttachmentSidebarWidth(width: number) {
  const viewportMax = typeof window === "undefined"
    ? ATTACHMENT_SIDEBAR_MAX_WIDTH
    : Math.max(ATTACHMENT_SIDEBAR_MIN_WIDTH, Math.min(ATTACHMENT_SIDEBAR_MAX_WIDTH, Math.floor(window.innerWidth * 0.42)));
  return Math.round(Math.min(Math.max(width, ATTACHMENT_SIDEBAR_MIN_WIDTH), viewportMax));
}
const REAL_VAULT_NOTE_PREFIX = "real-vault:";
const REAL_VAULT_ASSET_PREFIX = "real-vault-asset:";
const REAL_VAULT_MARKDOWN_EMBED_PREFIX = "real-vault-markdown-embed:";
const REAL_VAULT_TAG_PREFIX = "real-vault-tag:";

function clampNotesIndexWidth(width: number) {
  return clampNotesIndexWidthTo(width, typeof window === "undefined" ? NOTES_INDEX_DEFAULT_WIDTH : window.innerWidth);
}

function readSavedNotesIndexWidth(): { width: number; userSet: boolean } {
  let stored: number | null = null;
  try {
    const raw = localStorage.getItem(NOTES_INDEX_WIDTH_KEY);
    if (raw !== null) stored = Number(raw);
  } catch {
    stored = null;
  }
  return resolveNotesIndexWidth({
    storedWidth: stored,
    viewportWidth: typeof window === "undefined" ? NOTES_INDEX_DEFAULT_WIDTH : window.innerWidth,
  });
}

function normalizeSavedNoteTab(tab: unknown): NotesOpenTab | null {
  if (!tab || typeof tab !== "object") return null;
  const item = tab as { id?: unknown; kind?: unknown; noteId?: unknown };
  if (item.kind === "empty") {
    const id = typeof item.id === "string" && item.id ? item.id : createEmptyNoteTab().id;
    return { id, kind: "empty" };
  }
  const noteId = typeof item.noteId === "string" && item.noteId ? item.noteId : typeof item.id === "string" ? item.id : "";
  return noteId ? { id: noteId, kind: "note" } : null;
}

function normalizeSavedNoteTabsPayload(parsed: { tabs?: unknown; openTabs?: unknown; activeId?: unknown; activeTabId?: unknown }): { tabs: NotesOpenTab[]; activeId: string | null } | null {
    const rawTabs = Array.isArray(parsed.tabs) ? parsed.tabs : Array.isArray(parsed.openTabs) ? parsed.openTabs : [];
    const tabs = rawTabs.map(normalizeSavedNoteTab).filter((tab): tab is NotesOpenTab => Boolean(tab));
    const activeId = typeof parsed.activeId === "string" ? parsed.activeId : typeof parsed.activeTabId === "string" ? parsed.activeTabId : null;
    return tabs.length ? { tabs, activeId } : null;
}

function readSavedNoteTabsState(vaultId?: string | null): { tabs: NotesOpenTab[]; activeId: string | null } | null {
  try {
    // Vault-scoped first: a shared slot plus relative-path note ids let one
    // vault's tabs reappear in another. The vault's own slot wins; the shared
    // slot is only a first-open fallback and is still id-filtered by callers.
    if (vaultId) {
      const key = noteTabsStorageKey(vaultId);
      const ownStorage = sessionStorage.getItem(key) !== null ? sessionStorage
        : localStorage.getItem(key) !== null ? localStorage : null;
      // Check both scoped slots before either reader can fall back to legacy.
      const scoped = ownStorage ? readSavedNoteTabsForVault(vaultId, ownStorage)
        : readSavedNoteTabsForVault(vaultId, sessionStorage) ?? readSavedNoteTabsForVault(vaultId, localStorage);
      if (scoped) return normalizeSavedNoteTabsPayload(scoped as { tabs?: unknown; activeId?: unknown });
      return null;
    }
    const raw = sessionStorage.getItem(NOTE_TABS_STATE_KEY)
      || localStorage.getItem(NOTE_TABS_STATE_KEY)
      || localStorage.getItem(LEGACY_NOTE_TABS_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { tabs?: unknown; openTabs?: unknown; activeId?: unknown; activeTabId?: unknown };
    return normalizeSavedNoteTabsPayload(parsed);
  } catch {
    return null;
  }
}

function filterSavedNoteTabs(saved: { tabs: NotesOpenTab[]; activeId: string | null } | null, noteIds: Set<string>) {
  if (!saved) return null;
  const tabs = saved.tabs.filter((tab) => isEmptyNoteTab(tab) || noteIds.has(tab.id));
  if (!tabs.length) return null;
  const active = tabs.find((tab) => tab.id === saved.activeId) || tabs[0];
  return { tabs, activeId: active.id, active };
}


function createEmptyNoteTab(): NotesOpenTab {
  return { id: `empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, kind: "empty" };
}

function restoreNotesPaneScrollWhenReady(container: HTMLElement | null, scrollTop: number) {
  if (!container || !scrollTop) return () => undefined;
  let frame = 0;
  let observer: MutationObserver | null = null;
  let scheduled = false;
  const scheduleRestore = () => {
    const target = container.querySelector<HTMLElement>(".cm-scroller, .note-preview, textarea");
    if (!target || scheduled) return false;
    scheduled = true;
    frame = window.requestAnimationFrame(() => {
      target.scrollTop = scrollTop;
      observer?.disconnect();
      observer = null;
    });
    return true;
  };
  if (!scheduleRestore()) {
    observer = new MutationObserver(() => {
      if (scheduleRestore()) observer?.disconnect();
    });
    observer.observe(container, { childList: true, subtree: true });
  }
  return () => {
    if (frame) window.cancelAnimationFrame(frame);
    observer?.disconnect();
  };
}

function nextOpenTabsForNote(
  current: NotesOpenTab[],
  noteId: string,
  activeTabId: string | null,
  selectedNoteId: string | null,
  tabMode: NoteTabMode,
) {
  if (current.some((tab) => tab.kind !== "empty" && tab.id === noteId)) return current;
  const nextTab: NotesOpenTab = { id: noteId, kind: "note" };
  if (!current.length) return [nextTab];
  if (tabMode === "open") return [...current, nextTab];

  const activeIndex = activeTabId ? current.findIndex((tab) => tab.id === activeTabId) : -1;
  if (activeIndex >= 0) return current.map((tab, index) => index === activeIndex ? nextTab : tab);

  const selectedIndex = selectedNoteId ? current.findIndex((tab) => tab.kind !== "empty" && tab.id === selectedNoteId) : -1;
  if (selectedIndex >= 0) return current.map((tab, index) => index === selectedIndex ? nextTab : tab);

  const emptyIndex = current.findIndex((tab) => tab.kind === "empty");
  if (emptyIndex >= 0) return current.map((tab, index) => index === emptyIndex ? nextTab : tab);

  return current.map((tab, index) => index === 0 ? nextTab : tab);
}

function isEmptyNoteTab(tab: NotesOpenTab) {
  return tab.kind === "empty";
}

function isRealVaultOpenTab(tab: NotesOpenTab) {
  return !isEmptyNoteTab(tab) && isRealVaultNoteId(tab.id);
}

function isDbOpenTab(tab: NotesOpenTab) {
  return !isEmptyNoteTab(tab) && !isRealVaultNoteId(tab.id);
}

function keepTabsForSource(tabs: NotesOpenTab[], source: KnowledgeSourceMode) {
  return tabs.filter((tab) => (
    isEmptyNoteTab(tab)
    || (source === "real-vault" ? isRealVaultOpenTab(tab) : isDbOpenTab(tab))
  ));
}

function isRealVaultNoteId(noteId?: string | null) {
  return Boolean(noteId?.startsWith(REAL_VAULT_NOTE_PREFIX));
}

function realVaultNoteId(relativePath: string) {
  return `${REAL_VAULT_NOTE_PREFIX}${relativePath}`;
}

function realVaultRelativePathFromNoteId(noteId: string) {
  return noteId.startsWith(REAL_VAULT_NOTE_PREFIX) ? noteId.slice(REAL_VAULT_NOTE_PREFIX.length) : noteId;
}

function realVaultParentPath(relativePath?: string | null) {
  if (!relativePath) return null;
  const normalized = relativePath.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : null;
}

function markdownTitleFromPath(relativePath: string | null | undefined, untitledTitle: string) {
  const fileName = (relativePath || "").replace(/\\/g, "/").split("/").pop() || relativePath || untitledTitle;
  return fileName.replace(/\.md$/i, "") || untitledTitle;
}

function normalizeRealVaultEditorContentForDirtyCompare(value?: string | null) {
  return (value || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function normalizeMarkdownTagName(value?: string | null) {
  return (value || "").trim().replace(/^#+/, "").trim();
}

function realVaultTagId(name: string) {
  return `${REAL_VAULT_TAG_PREFIX}${encodeURIComponent(normalizeMarkdownTagName(name))}`;
}

function realVaultTagNameFromId(id: string) {
  if (!id.startsWith(REAL_VAULT_TAG_PREFIX)) return normalizeMarkdownTagName(id);
  try {
    return normalizeMarkdownTagName(decodeURIComponent(id.slice(REAL_VAULT_TAG_PREFIX.length)));
  } catch {
    return normalizeMarkdownTagName(id.slice(REAL_VAULT_TAG_PREFIX.length));
  }
}

function uniqueMarkdownTagNames(values: Array<string | null | undefined>) {
  const byKey = new Map<string, string>();
  values.forEach((value) => {
    const name = normalizeMarkdownTagName(value);
    const key = name.toLocaleLowerCase();
    if (name && !byKey.has(key)) byKey.set(key, name);
  });
  return Array.from(byKey.values());
}

function extractFrontmatterTagNamesForRealVault(contentText: string) {
  const frontmatter = parseNoteFrontmatter(contentText);
  const frontmatterTags = frontmatter.properties
    .filter((property) => property.key.toLocaleLowerCase() === "tag" || property.key.toLocaleLowerCase() === "tags")
    .flatMap((property) => property.values);
  return uniqueMarkdownTagNames(frontmatterTags);
}

function parseAiTagSuggestionResponse(content: string): NoteAiSuggestionState {
  const cleaned = content
    .trim()
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```json?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const jsonText = cleaned.startsWith("{")
    ? cleaned
    : cleaned.slice(Math.max(0, cleaned.indexOf("{")), cleaned.lastIndexOf("}") + 1);
  const parsed = JSON.parse(jsonText);
  const rawTags = Array.isArray(parsed.tags)
    ? parsed.tags
    : Array.isArray(parsed.auto_tags)
      ? parsed.auto_tags
      : [];
  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    auto_tags: uniqueMarkdownTagNames(rawTags.filter((tag: unknown): tag is string => typeof tag === "string")).slice(0, 8),
    status: "pending",
  };
}

function buildRealVaultTagList(
  index: BridgeNotesVaultMarkdownIndex | null,
  currentTagNames: string[],
) {
  const counts = new Map<string, number>();
  (index?.documents || []).forEach((document) => {
    const names = uniqueMarkdownTagNames(document.frontmatterTags || []);
    names.forEach((name) => counts.set(name, (counts.get(name) || 0) + 1));
  });
  currentTagNames.forEach((name) => {
    const normalized = normalizeMarkdownTagName(name);
    if (normalized && !counts.has(normalized)) counts.set(normalized, 0);
  });
  return Array.from(counts.entries())
    .sort((a, b) => a[0].localeCompare(b[0], "zh-CN"))
    .map(([name, noteCount]) => ({ id: realVaultTagId(name), name, noteCount }));
}

function realVaultIndexDocumentToNote(document: BridgeNotesVaultMarkdownIndexDocument, untitledTitle: string): Note {
  const relativePath = normalizeVaultRelativePath(document.relativePath);
  const updatedAt = document.mtime || new Date().toISOString();
  return {
    id: realVaultNoteId(relativePath),
    title: markdownTitleFromPath(relativePath, untitledTitle),
    contentText: document.plainText || document.excerpt || "",
    contentJson: document.plainText || document.excerpt || "",
    folderId: realVaultParentPath(relativePath),
    color: null,
    createdAt: updatedAt,
    updatedAt,
  };
}

function buildRealVaultEditorNotes(
  documents: BridgeNotesVaultMarkdownIndexDocument[],
  fallbackNotes: Note[],
  selectedNote: Note | null,
  untitledTitle: string,
) {
  const byId = new Map<string, Note>();
  documents.forEach((document) => {
    const note = realVaultIndexDocumentToNote(document, untitledTitle);
    byId.set(note.id, note);
  });
  fallbackNotes.forEach((note) => {
    if (isRealVaultNoteId(note.id) && !byId.has(note.id)) byId.set(note.id, note);
  });
  if (selectedNote && isRealVaultNoteId(selectedNote.id) && !byId.has(selectedNote.id)) {
    byId.set(selectedNote.id, selectedNote);
  }
  return Array.from(byId.values());
}

function buildRealVaultEditorNoteLinks(documents: BridgeNotesVaultMarkdownIndexDocument[]): NoteLink[] {
  const byKey = new Map<string, NoteLink>();
  documents.forEach((document) => {
    const relativePath = normalizeVaultRelativePath(document.relativePath);
    const toNoteId = realVaultNoteId(relativePath);
    realVaultDocumentLookupAliases(document).forEach((alias) => {
      const key = normalizeNoteLinkKey(alias);
      if (!key || byKey.has(key)) return;
      byKey.set(key, { targetTitle: alias, toNoteId, isMissing: 0 });
    });
  });
  return Array.from(byKey.values());
}

type RealVaultRelationData = {
  connectedNoteLinks: NoteLink[];
  missingNoteLinks: NoteLink[];
  backlinks: Backlink[];
  unlinkedMentions: UnlinkedMention[];
};

type RealVaultEmbedItem = {
  wikiSyntax: boolean;
  sourceTarget: string;
  target: string;
  display: string;
  line: number;
  snippet: string;
  kind: string | null;
  targetNoteId: string | null;
  assetRelativePath: string | null;
  absolutePath: string | null;
  assetExists: boolean | null;
  assetLookupKey: string | null;
  libraryAssetId: string | null;
  assetMatchCount: number;
  assetMatchKind: string | null;
};

function realVaultEmbedSnippet(
  document: BridgeNotesVaultMarkdownIndexDocument,
  embed: BridgeNotesVaultMarkdownEmbed,
  formatLine: (line: number) => string,
) {
  const body = embed.raw || embed.target || document.excerpt || document.relativePath;
  return `${formatLine(embed.line || 1)} · ${excerpt(body)}`;
}

function isSafeRealVaultAssetRelativePath(value?: string | null) {
  return isSafeRealVaultAssetRelativePathShared(value);
}

function realVaultAssetFileName(relativePath?: string | null, materialFallback = "") {
  return normalizeVaultRelativePath(relativePath).split("/").pop() || relativePath || materialFallback;
}

function realVaultAssetKind(relativePath?: string | null) {
  const ext = realVaultAssetFileName(relativePath).split(".").pop()?.toLowerCase() || "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"].includes(ext)) return "image";
  if (["mp4", "mov", "avi", "mkv", "webm"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "flac", "m4a"].includes(ext)) return "audio";
  if (["pdf", "doc", "docx", "txt", "rtf", "ppt", "pptx", "xls", "xlsx"].includes(ext)) return "document";
  return "other";
}

function realVaultAssetPreviewUrl(absolutePath: string | null, kind: string) {
  if (!absolutePath || (kind !== "image" && kind !== "video")) return "";
  try {
    return convertFileSrc(absolutePath);
  } catch {
    return "";
  }
}
function resolveRealVaultEmbedAssetRelativePath(target: string, currentRelativePath: string) {
  return resolveRealVaultEmbedAssetRelativePathShared(target, currentRelativePath);
}

function realVaultAssetAbsolutePath(rootPath: string | null | undefined, relativePath: string | null) {
  if (!rootPath || !relativePath || !isSafeRealVaultAssetRelativePath(relativePath)) return null;
  return `${rootPath.replace(/[\\/]+$/, "")}\\${relativePath.replace(/\//g, "\\")}`;
}

function buildRealVaultEmbedItems(
  currentRelativePath: string | null,
  index: BridgeNotesVaultMarkdownIndex | null,
  vault: BridgeVaultMetadata | null,
  libraryAssets: Asset[],
  copy: { untitledMaterial: string; formatLine: (line: number) => string },
): RealVaultEmbedItem[] {
  if (!currentRelativePath || !index?.documents?.length) return [];
  const documents = index.documents;
  const resolveWikiTarget = createRealVaultWikiTargetResolver(documents);
  const currentPath = normalizeVaultRelativePath(currentRelativePath);
  const currentDocument = documents.find((document) => normalizeVaultRelativePath(document.relativePath) === currentPath);
  if (!currentDocument) return [];
  const resolveLibraryAsset = createRealVaultLibraryAssetResolver(libraryAssets);

  return (currentDocument.embeds || []).map((embed) => {
    const wikiSyntax = embed.raw.startsWith("![[");
    const target = embed.target;
    const parsed = parseWikiReferenceTarget(embed.target || embed.raw || "");
    const markdownReference = wikiSyntax ? null : standardMarkdownReferences(embed.raw)[0];
    const resolved = wikiSyntax && target ? resolveWikiTarget(target) : null;
    const targetRelativePath = resolved ? normalizeVaultRelativePath(resolved.relativePath) : "";
    const libraryAsset = wikiSyntax && !resolved && target ? resolveLibraryAsset(target) : null;
    const assetRelativePath = resolved || libraryAsset ? null : resolveRealVaultEmbedAssetRelativePath(target, currentPath);
    const assetLookupKey = !resolved && target ? `${vault?.id}:${vault?.rootPath}:${wikiSyntax ? "wiki" : "markdown"}:${currentPath}:${target}` : null;
    return {
      wikiSyntax,
      sourceTarget: wikiSyntax ? target : markdownReference?.target || target,
      target,
      display: (wikiSyntax ? parsed.display : markdownReference?.label.replace(/\|\d{1,4}(?:x\d{1,4})?$/, "")) || realVaultAssetFileName(target, copy.untitledMaterial),
      line: Math.max(1, embed.line || 1),
      snippet: realVaultEmbedSnippet(currentDocument, embed, copy.formatLine),
      kind: resolved ? "markdown" : embed.kind || null,
      targetNoteId: resolved ? realVaultNoteId(targetRelativePath) : null,
      assetRelativePath,
      absolutePath: assetRelativePath ? realVaultAssetAbsolutePath(vault?.rootPath, assetRelativePath) : null,
      assetExists: resolved || libraryAsset ? true : null,
      assetLookupKey,
      libraryAssetId: libraryAsset?.id || null,
      assetMatchCount: 0,
      assetMatchKind: null,
    };
  });
}


function realVaultWikiLinkTargetTitle(link: BridgeNotesVaultMarkdownWikiLink) {
  const parsed = parseWikiReferenceTarget(link.target || link.raw || "");
  return parsed.targetTitle || link.target || link.raw || "";
}

function realVaultBacklinkSnippet(
  document: BridgeNotesVaultMarkdownIndexDocument,
  link: BridgeNotesVaultMarkdownWikiLink,
  formatLine: (line: number) => string,
) {
  const lines = (document.plainText || "").split(/\r?\n/);
  const lineText = link.line > 0 ? (lines[link.line - 1] || "").trim() : "";
  const body = lineText || link.raw || document.excerpt || document.relativePath;
  return `${formatLine(link.line || 1)} · ${excerpt(body)}`;
}

function buildRealVaultRelationData(
  noteId: string | null,
  index: BridgeNotesVaultMarkdownIndex | null,
  formatLine: (line: number) => string,
  untitledTitle: string,
): RealVaultRelationData {
  const empty: RealVaultRelationData = { connectedNoteLinks: [], missingNoteLinks: [], backlinks: [], unlinkedMentions: [] };
  if (!noteId || !isRealVaultNoteId(noteId) || !index?.documents?.length) return empty;

  const documents = index.documents;
  const resolveWikiTarget = createRealVaultWikiTargetResolver(documents);
  const currentRelativePath = normalizeVaultRelativePath(realVaultRelativePathFromNoteId(noteId));
  const currentDocument = documents.find((document) => normalizeVaultRelativePath(document.relativePath) === currentRelativePath);
  if (!currentDocument) return empty;

  const connectedByKey = new Map<string, NoteLink>();
  const missingByKey = new Map<string, NoteLink>();

  (currentDocument.wikiLinks || []).forEach((link) => {
    const targetTitle = realVaultWikiLinkTargetTitle(link);
    if (!targetTitle) return;
    const key = normalizeNoteLinkKey(targetTitle);
    if (!key) return;
    const resolved = resolveWikiTarget(link.target);
    if (resolved) {
      const targetRelativePath = normalizeVaultRelativePath(resolved.relativePath);
      if (!connectedByKey.has(key)) {
        connectedByKey.set(key, { targetTitle, toNoteId: realVaultNoteId(targetRelativePath), isMissing: 0 });
      }
      missingByKey.delete(key);
      return;
    }
    if (!connectedByKey.has(key) && !missingByKey.has(key)) {
      missingByKey.set(key, { targetTitle, toNoteId: null, isMissing: 1 });
    }
  });

  const backlinks: Backlink[] = [];
  documents.forEach((document) => {
    const sourceRelativePath = normalizeVaultRelativePath(document.relativePath);
    if (!sourceRelativePath || sourceRelativePath === currentRelativePath) return;
    (document.wikiLinks || []).forEach((link) => {
      const resolved = resolveWikiTarget(link.target);
      if (!resolved || normalizeVaultRelativePath(resolved.relativePath) !== currentRelativePath) return;
      backlinks.push({
        id: realVaultNoteId(sourceRelativePath),
        title: document.title || markdownTitleFromPath(sourceRelativePath, untitledTitle),
        updatedAt: document.mtime || "",
        snippet: realVaultBacklinkSnippet(document, link, formatLine),
      });
    });
  });

  return {
    connectedNoteLinks: Array.from(connectedByKey.values()),
    missingNoteLinks: Array.from(missingByKey.values()),
    backlinks,
    unlinkedMentions: [],
  };
}
function realVaultInitialMissingContent(title: string, contentText?: string) {
  const trimmed = (contentText || "").trim();
  if (trimmed) return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
  return `# ${title}\n`;
}

function noteFromKnowledgeDocument(document: KnowledgeDocument, untitledTitle = ""): Note {
  const now = new Date().toISOString();
  if (document.source === "real-vault") {
    const relativePath = document.relativePath || document.id;
    const updatedAt = document.updatedAt || now;
    return {
      id: realVaultNoteId(relativePath),
      title: document.title || markdownTitleFromPath(relativePath, untitledTitle),
      contentText: document.contentText || "",
      contentJson: document.contentText || "",
      folderId: realVaultParentPath(relativePath),
      color: null,
      createdAt: updatedAt,
      updatedAt,
    };
  }
  return {
    id: document.id,
    title: document.title || untitledTitle,
    contentText: document.contentText || "",
    contentJson: document.contentText || "",
    folderId: null,
    color: null,
    createdAt: document.updatedAt || now,
    updatedAt: document.updatedAt || now,
  };
}

type RealVaultUiTree = {
  folders: Folder[];
  documentsByFolderId: Record<string, FolderTreeDocument[]>;
  uncategorizedDocuments: FolderTreeDocument[];
  notes: Note[];
};

function buildRealVaultUiTree(nodes: KnowledgeTreeNode[], locale: "zh-CN" | "en-US", untitledTitle: string): RealVaultUiTree {
  const documentsByFolderId: Record<string, FolderTreeDocument[]> = {};
  const uncategorizedDocuments: FolderTreeDocument[] = [];
  const notes: Note[] = [];

  const visit = (items: KnowledgeTreeNode[], parentId: string | null): Folder[] => {
    const folders: Folder[] = [];
    for (const item of items) {
      if (item.kind === "folder") {
        const folderId = item.relativePath || item.id;
        folders.push({
          id: folderId,
          name: item.title,
          parentId,
          open: true,
          children: visit(item.children || [], folderId),
        });
        continue;
      }
      const relativePath = item.relativePath || item.id;
      const note = noteFromKnowledgeDocument({
        id: relativePath,
        // Tree entries include the filename extension; opened documents don't.
        // Keep both presentations identical across background index/save echoes.
        title: markdownTitleFromPath(relativePath, untitledTitle),
        contentText: "",
        source: "real-vault",
        relativePath,
        absolutePath: item.absolutePath,
        updatedAt: item.updatedAt,
        raw: item,
      }, untitledTitle);
      const documentItem: FolderTreeDocument = {
        id: note.id,
        title: item.title || note.title,
        subtitle: item.updatedAt ? shortDate(item.updatedAt, locale) : item.relativePath,
      };
      notes.push(note);
      if (parentId) {
        const list = documentsByFolderId[parentId] || [];
        list.push(documentItem);
        documentsByFolderId[parentId] = list;
      } else {
        uncategorizedDocuments.push(documentItem);
      }
    }
    return folders;
  };

  return {
    folders: visit(nodes, null),
    documentsByFolderId,
    uncategorizedDocuments,
    notes,
  };
}


function tableCommandStatusKey(command: TableEditorCommand) {
  switch (command) {
    case "row-above":
      return "editor.notes.status.tableRowAddedAbove" as const;
    case "row-below":
      return "editor.notes.status.tableRowAddedBelow" as const;
    case "row-move-up":
      return "editor.notes.status.tableRowMovedUp" as const;
    case "row-move-down":
      return "editor.notes.status.tableRowMovedDown" as const;
    case "row-delete":
      return "editor.notes.status.tableRowDeleted" as const;
    case "column-left":
      return "editor.notes.status.tableColumnAddedLeft" as const;
    case "column-right":
      return "editor.notes.status.tableColumnAddedRight" as const;
    case "column-move-left":
      return "editor.notes.status.tableColumnMovedLeft" as const;
    case "column-move-right":
      return "editor.notes.status.tableColumnMovedRight" as const;
    case "column-align-left":
      return "editor.notes.status.tableColumnAlignedLeft" as const;
    case "column-align-center":
      return "editor.notes.status.tableColumnAlignedCenter" as const;
    case "column-align-right":
      return "editor.notes.status.tableColumnAlignedRight" as const;
    case "column-delete":
      return "editor.notes.status.tableColumnDeleted" as const;
    case "sort-asc":
      return "editor.notes.status.tableSortedAscending" as const;
    case "sort-desc":
      return "editor.notes.status.tableSortedDescending" as const;
    default:
      return "editor.notes.status.tableUpdated" as const;
  }
}

function noteTitle(note?: Note | null) {
  return note?.title?.trim() || "";
}

function parseOutgoingNoteLinkDisplays(
  contentText: string,
  copy: {
    blockTarget: (block: string) => string;
    headingTarget: (heading: string) => string;
    pointsTo: (target: string) => string;
  },
) {
  const displays = new Map<string, OutgoingNoteLinkDisplay>();
  const pattern = /(!?)\[\[([^\]\n]+?)\]\]/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(contentText || ""))) {
    if (match[1] === "!") continue;
    if (!isPlainMarkdownCompletionAllowedAt(contentText || "", match.index)) continue;
    const raw = (match[2] || "").trim();
    const [targetPart, ...aliasParts] = raw.split("|");
    const target = targetPart.trim();
    const alias = aliasParts.join("|").trim();
    const hashIndex = target.indexOf("#");
    const targetTitle = (hashIndex >= 0 ? target.slice(0, hashIndex) : target).trim();
    const subpath = hashIndex >= 0 ? target.slice(hashIndex + 1).trim() : "";
    if (!targetTitle) continue;

    const key = normalizeNoteLinkKey(targetTitle);
    const hasAlias = Boolean(alias);
    const anchorMeta = subpath
      ? subpath.startsWith("^")
        ? copy.blockTarget(subpath.slice(1))
        : copy.headingTarget(subpath)
      : "";
    const blockId = subpath.startsWith("^") ? subpath.slice(1).trim() || null : null;
    const meta = [
      hasAlias ? copy.pointsTo(targetTitle) : "",
      anchorMeta,
    ].filter(Boolean).join(" · ");

    const next = {
      label: alias || target || targetTitle,
      meta,
      openOptions: subpath ? { blockId, headingPath: blockId ? null : subpath || null } : null,
    };
    const current = displays.get(key);
    if (!current || hasAlias || (!current.meta && meta)) displays.set(key, next);
  }

  return displays;
}

function parseWikiLinkMarkdownToken(markdown: string) {
  const match = /^\[\[([^\]\n]+)\]\]$/.exec(markdown.trim());
  if (!match) return null;
  const [targetPart, ...aliasParts] = match[1].split("|");
  const target = targetPart.trim();
  if (!target) return null;
  return {
    target,
    alias: aliasParts.join("|").trim(),
  };
}

function parseExternalLinkMarkdownToken(markdown: string) {
  const match = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(markdown.trim());
  if (!match) return null;
  return {
    title: match[1],
    href: match[2],
  };
}





function initialContentForMissingNoteAnchor(
  options?: NoteOpenOptions | null,
  pendingBlock?: (block: string) => string,
) {
  const blockId = options?.blockId?.trim().replace(/^\^/, "");
  if (blockId) return pendingBlock?.(blockId) || `^${blockId}`;

  const heading = options?.headingPath?.trim().replace(/^#+\s*/, "");
  if (heading) return `# ${heading}`;

  return "";
}

function extractDroppedLocalPaths(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) return [];
  const values: string[] = [];
  const push = (value: string | null | undefined) => {
    if (value?.trim()) values.push(value);
  };

  const uriList = dataTransfer.getData("text/uri-list");
  if (uriList) {
    uriList
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .forEach(push);
  }

  const plain = dataTransfer.getData("text/plain");
  if (plain) {
    plain
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach(push);
  }

  Array.from(dataTransfer.files || []).forEach((file) => {
    const path = (file as File & { path?: string }).path;
    if (path) push(path);
  });

  return dedupeDroppedLocalPaths(values);
}

function isMarkdownImportPath(path: string) {
  return /\.(md|markdown)$/i.test(path.trim());
}






const shortDateFormatters = new Map<string, Intl.DateTimeFormat>();
function shortDate(value: string, locale: "zh-CN" | "en-US") {
  if (!value) return "";
  try {
    let formatter = shortDateFormatters.get(locale);
    if (!formatter) { formatter = new Intl.DateTimeFormat(locale, { month: "2-digit", day: "2-digit" }); shortDateFormatters.set(locale, formatter); }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? date.toLocaleDateString(locale) : formatter.format(date);
  } catch {
    return "";
  }
}

function excerptAroundQuery(text = "", query = "") {
  const compact = text.replace(/\s+/g, " ").trim();
  const keyword = query.trim().toLowerCase();
  if (!keyword) return compact.slice(0, 80);
  const index = compact.toLowerCase().indexOf(keyword);
  if (index < 0) return compact.slice(0, 80);
  const start = Math.max(0, index - 28);
  const end = Math.min(compact.length, index + keyword.length + 52);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < compact.length ? "..." : "";
  return `${prefix}${compact.slice(start, end)}${suffix}`;
}

function countWords(text = "") {
  const chinese = text.match(/[\u4e00-\u9fa5]/g)?.length || 0;
  const words = text.replace(/[\u4e00-\u9fa5]/g, " ").trim().match(/[^\s]+/g)?.length || 0;
  return chinese + words;
}

type OutlineItem = { level: number; text: string; line: number };

function getOutline(text = "") {
  const items: OutlineItem[] = [];
  let inFence = false;
  text.split(/\r?\n/).forEach((line, index) => {
    const outlineLine = index === 0 ? line.replace(/^\uFEFF/, "") : line;
    if (/^\s*(```|~~~)/.test(outlineLine)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const match = /^(#{1,6})\s+(.+?)\s*#*$/.exec(outlineLine);
    if (match) items.push({ level: match[1].length, text: match[2].trim(), line: index + 1 });
  });
  return items;
}

function getIndexedOutline(document?: BridgeNotesVaultMarkdownIndexDocument | null) {
  return (document?.headings || []).map((heading) => ({
    level: Math.max(1, Math.min(6, heading.level || 1)),
    text: heading.text,
    line: Math.max(1, heading.line || 1),
  }));
}


















































function clampEditorMenuPosition(x: number, y: number, width = 180, height = 260) {
  return {
    x: Math.min(Math.max(12, x), Math.max(12, window.innerWidth - width - 12)),
    y: Math.min(Math.max(12, y), Math.max(12, window.innerHeight - height - 12)),
  };
}







function mergeAssetsById(current: Asset[], imported: Asset[]) {
  const byId = new Map(current.map((asset) => [asset.id, asset]));
  for (const asset of imported) {
    if (asset?.id) byId.set(asset.id, asset);
  }
  return Array.from(byId.values());
}

export default function NotesPage({visible=true}:{visible?:boolean}={}) {
  const pageVisibleRef=useRef(visible);pageVisibleRef.current=visible;
  const { t, locale } = useI18n();
  const noteFavorites = useFavoriteItems("note");
  const bridge = getLuckyRayBridgeSync();
  const folders = useMemo<Folder[]>(() => [], []);
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [openTabs, setOpenTabs] = useState<NotesOpenTab[]>([]);
  const [activeEmptyTabId, setActiveEmptyTabId] = useState<string | null>(null);
  const notesPaneSequenceRef = useRef(1);
  const notesPaneViewsRef = useRef(new NotesPaneViews());
  const notesViewRefsRef = useRef(new Map<string, {
    live: { current: LiveMarkdownEditorHandle | null };
    source: { current: HTMLTextAreaElement | null };
    content: { current: HTMLDivElement | null };
    mode: EditorMode;
    session?:LiveEditorSessionSnapshot|null;
    sourceComposing?:boolean;contentScroll?:{top:number;left:number};
    noteId?:string;
    committedContent?:string;committedMode?:NoteViewMode;committedPaneId?:string;
    provenance?:{vault:BridgeVaultMetadata;generation:number;workspaceSourceId?:string;source:NonNullable<ReturnType<typeof readActiveKnowledgeWriteSource>>};
  }>());
  const notesSplitDividerDragRef = useRef<NotesSplitDividerDragState | null>(null);
  const [notesPaneLayout, setNotesPaneLayout] = useState<NotesPaneLayout | null>(null);
  const [notesPaneTabs, setNotesPaneTabs] = useState<NotesPaneTabs | null>(null);
  const [notesPaneActiveTabs, setNotesPaneActiveTabs] = useState<NotesPaneActiveTabs | null>(null);
  const [notesPaneModes, setNotesPaneModes] = useState<NotesPaneModes | null>(null);
  const [notesPaneDocuments, setNotesPaneDocuments] = useState<NotesPaneDocuments>({});
  const [notesPaneAiStates, setNotesPaneAiStates] = useState<NotesPaneAiStates>({});
  const notesPaneDocumentCacheRef = useRef(new Map<string, { title: string; contentText: string }>());
  const notesPaneLoadRequestRef = useRef(new Map<string, number>());
  const noteNavigationInFlightRef = useRef<string | null>(null);
  const notesPaneEditorSessionsRef = useRef(new Map<string, LiveEditorSessionSnapshot>());
  const notesPaneScrollPositionsRef = useRef(new Map<string, number>());
  const mediaViewportLinesRef = useRef(new Map<string, {from: number; to: number}>());
  const prepareNoteMediaRef = useRef<(noteId: string) => void>(() => {});
  const notesPaneScrollRestoreKeyRef = useRef<string | null>(null);
  const [notesPaneActivationVersion, setNotesPaneActivationVersion] = useState(0);
  const [activeNotesSplitPane, setActiveNotesSplitPaneState] = useState("notes-pane-1");
  const activeNotesSplitPaneRef = useRef("notes-pane-1");
  const attachmentPaneEpochRef = useRef(0);
  const setActiveNotesSplitPane = useCallback((paneId: string) => {
    if (paneId !== activeNotesSplitPaneRef.current) attachmentPaneEpochRef.current += 1;
    activeNotesSplitPaneRef.current = paneId;
    setActiveNotesSplitPaneState(paneId);
  }, []);
  const [editTitle, setEditTitle] = useState("");
  const [namingNoteId, setNamingNoteId] = useState<string | null>(null);
  const [renamingNoteId, setRenamingNoteId] = useState<string | null>(null);
  const renamingNoteRef = useRef<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [realVaultForceOpenFolderIds, setRealVaultForceOpenFolderIds] = useState<string[]>([]);
  const [folderDocumentReveal, setFolderDocumentReveal] = useState<{
    documentId: string; vaultId: string; session: number; nonce: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [attachmentSidebarOpen, setAttachmentSidebarOpen] = useState(false);
  // Right (attachments) panel width — same interaction contract as the left
  // index: drag the inner edge, drag past the threshold collapses, reopening
  // restores the last expanded width. A CSS var carries it to the sidebar.
  const [attachmentSidebarWidth, setAttachmentSidebarWidth] = useState(() => {
    try {
      const raw = localStorage.getItem(ATTACHMENT_SIDEBAR_WIDTH_KEY);
      const saved = raw === null ? Number.NaN : Number(raw);
      return Number.isFinite(saved) ? clampAttachmentSidebarWidth(saved) : ATTACHMENT_SIDEBAR_DEFAULT_WIDTH;
    } catch {
      return ATTACHMENT_SIDEBAR_DEFAULT_WIDTH;
    }
  });
  const lastExpandedAttachmentWidthRef = useRef(attachmentSidebarWidth);
  const [attachmentSidebarAnimating, setAttachmentSidebarAnimating] = useState(false);
  useEffect(() => {
    if (attachmentSidebarOpen && attachmentSidebarWidth >= ATTACHMENT_SIDEBAR_COLLAPSE_THRESHOLD) {
      lastExpandedAttachmentWidthRef.current = attachmentSidebarWidth;
    }
  }, [attachmentSidebarOpen, attachmentSidebarWidth]);
  useEffect(() => {
    if (!attachmentSidebarOpen) return; // the stored width is a real preference
    try {
      localStorage.setItem(ATTACHMENT_SIDEBAR_WIDTH_KEY, String(attachmentSidebarWidth));
    } catch {
      // Ignore storage failures in restricted webviews.
    }
  }, [attachmentSidebarOpen, attachmentSidebarWidth]);
  const attachmentSidebarAnimationTimerRef = useRef(0);
  useEffect(() => () => window.clearTimeout(attachmentSidebarAnimationTimerRef.current), []);
  const toggleAttachmentSidebar = useCallback((open?: boolean) => {
    setAttachmentSidebarOpen((current) => open === undefined ? !current : open);
    // One short transition on open/close only; dragging stays immediate.
    if (typeof window !== "undefined" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setAttachmentSidebarAnimating(true);
      window.clearTimeout(attachmentSidebarAnimationTimerRef.current);
      attachmentSidebarAnimationTimerRef.current = window.setTimeout(() => setAttachmentSidebarAnimating(false), 200);
    }
  }, []);
  const startAttachmentSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = attachmentSidebarWidth;
    let collapsedByResize = false;
    document.body.classList.add("lr-attachment-resizing");
    const onPointerMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      const rawWidth = startWidth + (startX - moveEvent.clientX);
      if (rawWidth < ATTACHMENT_SIDEBAR_COLLAPSE_THRESHOLD) {
        collapsedByResize = true;
        setAttachmentSidebarOpen(false);
        setAttachmentSidebarWidth(clampAttachmentSidebarWidth(Math.max(lastExpandedAttachmentWidthRef.current, ATTACHMENT_SIDEBAR_DEFAULT_WIDTH)));
        return;
      }
      collapsedByResize = false;
      const nextWidth = clampAttachmentSidebarWidth(rawWidth);
      lastExpandedAttachmentWidthRef.current = nextWidth;
      setAttachmentSidebarOpen(true);
      setAttachmentSidebarWidth(nextWidth);
    };
    const finishResize = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
      document.body.classList.remove("lr-attachment-resizing");
      if (collapsedByResize) {
        setAttachmentSidebarWidth(clampAttachmentSidebarWidth(Math.max(lastExpandedAttachmentWidthRef.current, ATTACHMENT_SIDEBAR_DEFAULT_WIDTH)));
      }
    };
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
  }, [attachmentSidebarWidth]);
  const editorRowRef = useRef<HTMLDivElement>(null);
  const [notesIndexLayoutMax, setNotesIndexLayoutMax] = useState(NOTES_INDEX_MAX_WIDTH);
  useLayoutEffect(() => {
    const row = editorRowRef.current;
    if (!row) return;
    const attachment = row.querySelector<HTMLElement>(".note-attachment-sidebar");
    const measure = () => setNotesIndexLayoutMax(Math.max(
      NOTES_INDEX_MIN_WIDTH,
      Math.floor(row.getBoundingClientRect().width - (attachment?.getBoundingClientRect().width || 0) - 360),
    ));
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    if (attachment) observer.observe(attachment);
    measure();
    return () => observer.disconnect();
  }, [attachmentSidebarOpen]);
  const [status, setStatus] = useState("");
  const [mobileEditingNoteId, setMobileEditingNoteId] = useState<string | null>(null);
  const [currentVault, setCurrentVault] = useState<BridgeVaultMetadata | null>(null);
  const [knownVaults, setKnownVaults] = useState<BridgeVaultMetadata[]>(readKnownNotesVaults);
  const [switchingVaultId, setSwitchingVaultId] = useState<string | null>(null);
  const [vaultSwitchError, setVaultSwitchError] = useState("");
  const vaultSwitchInFlightRef = useRef<string | null>(null);
  const selectedNoteFavoriteIdentity = useMemo(
    () => selectedNote ? resolveFavoriteNoteIdentity(
      selectedNote.id,
      currentVault?.id,
      { allowCurrentVaultLegacy: true },
    ) : null,
    [currentVault?.id, selectedNote],
  );
  const selectedNoteFavorite = useMemo(
    () => selectedNoteFavoriteIdentity?.aliases.map((id) => noteFavorites.byId.get(id)).find(Boolean) || null,
    [noteFavorites.byId, selectedNoteFavoriteIdentity],
  );
  const knowledgeStorageMode = useMemo<KnowledgeSourceMode>(() => "real-vault", []);
  useEffect(() => {
    const noteId = selectedNoteId;
    let retired = false;
    let inFlight = false;
    setMobileEditingNoteId(null);
    if (!noteId || knowledgeStorageMode !== "real-vault") return;
    const check = async () => {
      if (retired || inFlight || document.hidden) return;
      const source = readActiveKnowledgeWriteSource();
      if (!source?.vaultId || source.vaultId !== currentVault?.id) { setMobileEditingNoteId(null); return; }
      inFlight = true;
      try {
        // UI tabs use real-vault paths; advisory IPC keeps canonical, source-fenced refs.
        const documentRef = isRealVaultNoteId(noteId)
          ? { vaultId: source.vaultId, relativePath: realVaultRelativePathFromNoteId(noteId) }
          : parseKnowledgeDocumentNoteId(noteId);
        if (!documentRef || documentRef.vaultId !== source.vaultId) { setMobileEditingNoteId(null); return; }
        const editing = await readKnowledgeMobileEditing(knowledgeDocumentNoteId(documentRef));
        if (!retired) setMobileEditingNoteId(source === readActiveKnowledgeWriteSource() && editing ? noteId : null);
      } catch {
        if (!retired) setMobileEditingNoteId(null);
      } finally { inFlight = false; }
    };
    void check();
    const timer = setInterval(check, 5000);
    document.addEventListener("visibilitychange", check);
    return () => { retired = true; clearInterval(timer); document.removeEventListener("visibilitychange", check); };
  }, [currentVault?.id, selectedNoteId, knowledgeStorageMode]);
  const [realVaultTree, setRealVaultTree] = useState<KnowledgeTreeNode[]>([]);
  const [realVaultMarkdownIndex, setRealVaultMarkdownIndex] = useState<BridgeNotesVaultMarkdownIndex | null>(null);
  const subscribeKnowledgeStore = useCallback((listener: () => void) => knowledgeStore.subscribe(listener), []);
  const knowledgeSnapshot = useSyncExternalStore(subscribeKnowledgeStore, knowledgeStore.getSnapshot, knowledgeStore.getSnapshot);
  const vaultBootstrapReady = hasUsableKnowledgeSnapshot(knowledgeSnapshot);
  const [publishedDraftEmbeds, setPublishedDraftEmbeds] = useState<{noteId: string; prepared: PreparedAttachment}[]>([]);
  const [realVaultAssetMatches, setRealVaultAssetMatches] = useState<Record<string, readonly AttachmentMatch[]>>({});
  const [attachmentResolutionError, setAttachmentResolutionError] = useState('');
  const [attachmentRecheck, setAttachmentRecheck] = useState(0);
  const recheckAttachments = useCallback(() => setAttachmentRecheck(value => value + 1), []);
  useAttachmentFileVersions(currentVault?.id, recheckAttachments);
  const realVaultAssetOpenPathRef = useRef<Map<string, string>>(new Map());
  const [notesIndexPanel, setNotesIndexPanel] = useState<NotesIndexPanel | null>(null);
  const [knowledgeSearchOpen, setKnowledgeSearchOpen] = useState(false);
  const [knowledgeSearchQuery, setKnowledgeSearchQuery] = useState("");
  const [backlinksTab, setBacklinksTab] = useState<BacklinksTab>(() => {
    const saved = localStorage.getItem(BACKLINKS_TAB_KEY);
    return saved === "outline" || saved === "backlinks" || saved === "notes" || saved === "assets" ? saved : "notes";
  });
  const [panelOpen, setPanelOpen] = useState(true);
  // Lazy initializer: reads localStorage EXACTLY ONCE. A bare call here ran
  // on every render, and the synchronous storage read per pointermove made
  // the index drag visibly drop frames.
  const [notesIndexWidthInitial] = useState(readSavedNotesIndexWidth);
  // True once the user has actually dragged/toggled a width preference; until
  // then the width is a live default that follows the viewport (large windows
  // wide, small windows compact) and is never persisted.
  const notesIndexWidthUserSetRef = useRef(notesIndexWidthInitial.userSet);
  const [notesIndexWidth, setNotesIndexWidth] = useState(notesIndexWidthInitial.width);
  const notesViewportWidthRef = useRef(typeof window === "undefined" ? NOTES_INDEX_DEFAULT_WIDTH : window.innerWidth);
  const visibleNotesIndexWidth = Math.min(notesIndexWidth, notesIndexLayoutMax);
  const [noteTags, setNoteTags] = useState<string[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [allAssets, setAllAssets] = useState<Asset[]>([]);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [unlinkedMentions, setUnlinkedMentions] = useState<UnlinkedMention[]>([]);
  const [noteLinks, setNoteLinks] = useState<NoteLink[]>([]);
  const [noteEmbeds, setNoteEmbeds] = useState<NoteEmbed[]>([]);
  const [assetsForNote, setAssetsForNote] = useState<Asset[]>([]);
  const [autocomplete, setAutocomplete] = useState<AutocompleteState | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ConfirmState | null>(null);
  const [moveModal, setMoveModal] = useState<MoveModalState | null>(null);
  const [renameDocumentRequest, setRenameDocumentRequest] = useState<RenameDocumentRequestState>(null);
  const [noteCtx, setNoteCtx] = useState<NoteCtxState | null>(null);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState<NoteAiSuggestionState | null>(null);
  const [aiSelectedTags, setAiSelectedTags] = useState<string[] | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [editorMode, setEditorModeState] = useState<EditorMode>("live");
  // The epoch changes at the request to switch, before React commits the next
  // render. Returning to the same mode cannot resurrect an older insertion.
  const editorModeSessionRef = useRef({mode: "live" as EditorMode, epoch: 0});
  const setEditorMode = useCallback((update: SetStateAction<EditorMode>) => {
    const current = editorModeSessionRef.current;
    const mode = typeof update === "function" ? update(current.mode) : update;
    if (mode !== current.mode) editorModeSessionRef.current = {mode, epoch: current.epoch + 1};
    setEditorModeState(mode);
  }, []);
  const [sourceContentDraft, setSourceContentDraft] = useState<string | null>(null);
  const [editorCtx, setEditorCtx] = useState<EditorCtxState | null>(null);
  const [insertPicker, setInsertPicker] = useState<InsertPickerState | null>(null);
  const [attachmentImportOpen, setAttachmentImportOpen] = useState(false);
  const [linkAliasDialog, setLinkAliasDialog] = useState<LinkAliasDialogState | null>(null);
  const [tagRenameDialog, setTagRenameDialog] = useState<TagRenameDialogState | null>(null);
  const [aiWriteMenu, setAiWriteMenu] = useState<AiWriteMenuState | null>(null);
  const [aiWriteBusy, setAiWriteBusy] = useState(false);
  const [aiWritePreview, setAiWritePreview] = useState<BridgeNotesInlinePreview | null>(null);
  const [aiWriteApplying, setAiWriteApplying] = useState(false);
  const aiWriteCancelRequestedRef = useRef(false);
  const [realVaultExternalConflict, setRealVaultExternalConflict] = useState<RealVaultExternalConflictState>(null);
  const [pendingBlockId, setPendingBlockId] = useState<string | null>(null);
  const [pendingHeadingPath, setPendingHeadingPath] = useState<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeContextTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeContextPublisherRef = useRef<CurrentNoteContextPublisher | null>(null);
  const pendingPatchRef = useRef<{ title?: string; contentText?: string }>({});
  const pendingPatchNoteIdRef = useRef<string | null>(null);
  const flushPendingSaveRef = useRef<() => void>(() => {});
  const notesExitTitleRef = useRef(t("sidebar.route.notes"));
  notesExitTitleRef.current = t("sidebar.route.notes");
  const commitCurrentEditorDraftRef = useRef<() => void>(() => {});
  const saveRequestRef = useRef(0);
  const selectedNoteIdRef = useRef<string | null>(null);
  const selectedNoteRef = useRef<Note | null>(null);
  const realVaultSavedContentRef = useRef<Map<string, string>>(new Map());
  const realVaultReadProofRef=useRef(new Map<string,{generation:number;source:NonNullable<ReturnType<typeof readActiveKnowledgeWriteSource>>;workspaceSourceId:string;revision:string;content:string}>());
  const realVaultLatestContentRef = useRef<Map<string, string>>(new Map());
  const realVaultDocumentReadsRef = useRef(new NoteDocumentReadCoordinator());
  const realVaultUserDirtyRef = useRef<Set<string>>(new NotesNativeDraftSet());
  const realVaultSaveInFlightRef = useRef<Set<string>>(new NotesNativeSaveSet());
  const realVaultSaveCompletionRef = useRef(new Map<string, Promise<void>>());
  const notesInlineCommittedContentRef = useRef<{ noteId: string; content: string; revision: string } | null>(null);
  const openTabsRef = useRef<NotesOpenTab[]>([]);
  const liveEditorRef = useRef<LiveMarkdownEditorHandle | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const sourceComposingRef = useRef(false);
  const relationRequestRef = useRef(0);
  const noteLoadRequestRef = useRef(0);
  // Vault session barrier: every vault activation mints a token; async
  // continuations validate it so a previous vault's late results can never
  // write state (or content) into the current one. See vaultSessionBarrier.ts.
  const vaultSessionRef = useRef(createVaultSessionAuthority());
  const noteContentAreaRef = useRef<HTMLDivElement | null>(null);
  const [importNotice, setImportNotice] = useState<ImportReceipt | null>(null);
  const lastExpandedNotesIndexWidthRef = useRef(notesIndexWidth);
  const realVaultLastExternalCheckAtRef = useRef(0);
  const realVaultKeepEditingAfterConflictRef = useRef<Set<string>>(new Set());
  const realVaultStoreVersionRef = useRef<{ vaultId: string | null; snapshotVersion: number; indexVersion: number }>({
    vaultId: null,
    snapshotVersion: 0,
    indexVersion: 0,
  });

  useLayoutEffect(() => {
    activeNotesSplitPaneRef.current = activeNotesSplitPane;
  }, [activeNotesSplitPane]);

  useEffect(() => () => realVaultDocumentReadsRef.current.cancelPending(), [currentVault?.id, currentVault?.rootPath]);

  const acknowledgeSavedReadProof=useCallback((noteId:string,content:string,revision:string,origin:{source:ReturnType<typeof readActiveKnowledgeWriteSource>;generation:number})=>{
    if(readActiveKnowledgeWriteSource()!==origin.source||!vaultSessionRef.current.isCurrent(origin.generation))throw new Error('Saved note source session changed');
    const previous=realVaultReadProofRef.current.get(noteId),next=advanceNotesSavedReadProof(previous,{content,revision},origin);
    if(next){realVaultReadProofRef.current.set(noteId,next);if(previous?.content!==next.content||previous.revision!==next.revision)notesNativeViews.notifyViews();}
  },[]);
  const realVaultDocumentSource = useMemo(() => {
    const adapter=createRealVaultDocumentSource({bridge,vault:currentVault});
    return {...adapter,saveDocument:async(documentRef:Parameters<typeof adapter.saveDocument>[0],content:string)=>{
      const origin={source:readActiveKnowledgeWriteSource(),generation:vaultSessionRef.current.latest()};
      const saved=await adapter.saveDocument(documentRef,content);
      if(saved.contentText!==content||!saved.revision)throw new Error('Saved document did not acknowledge the exact content');
      acknowledgeSavedReadProof(realVaultNoteId(saved.relativePath||saved.id),saved.contentText,saved.revision,origin);
      return saved;
    },openDocument:async(path:string)=>{
      const generation=vaultSessionRef.current.latest(),source=readActiveKnowledgeWriteSource(),finishRead=notesNativeViews.beginRead();
      try{
      const document=await adapter.openDocument(path);
      if((generation>0&&!vaultSessionRef.current.isCurrent(generation,currentVault?.id))||(source&&readActiveKnowledgeWriteSource()!==source))throw new Error('Document source changed during the actual read');
      if(source&&currentVault&&source.vaultId===currentVault.id&&vaultSessionRef.current.isCurrent(generation,currentVault.id)){
        const noteId=realVaultNoteId(path),old=realVaultReadProofRef.current.get(noteId);
        const previous=old?.generation===generation&&old.source===source?old.workspaceSourceId:undefined;
        const workspaceSourceId=acceptWorkspaceSourceProof(previous,document.workspaceSourceId);
        if(workspaceSourceId){
          const candidates=[...notesViewRefsRef.current.values()].filter(refs=>refs.noteId===noteId&&refs.provenance?.generation===generation&&refs.provenance.source===source);
          for(const refs of candidates)acceptWorkspaceSourceProof(refs.provenance!.workspaceSourceId,workspaceSourceId);
          const acquired=previous!==workspaceSourceId||candidates.some(refs=>refs.provenance!.workspaceSourceId!==workspaceSourceId);
          realVaultReadProofRef.current.set(noteId,{generation,source,workspaceSourceId,revision:document.revision||'',content:document.contentText});
          for(const refs of candidates)refs.provenance!.workspaceSourceId=workspaceSourceId;
          if(acquired)notesNativeViews.notifyViews();
        }
      }
      return document;
      }finally{finishRead();}
    }};
  }, [bridge, currentVault,acknowledgeSavedReadProof]);

  const realVaultUiTree = useMemo(
    () => buildRealVaultUiTree(realVaultTree, locale, t("editor.notes.untitled")),
    [locale, realVaultTree, t],
  );
  const activeFolders = realVaultUiTree.folders;


  const folderPathMap = useMemo(() => {
    const map = new Map<string, string>();
    const walk = (items: Folder[], parentPath = "") => {
      items.forEach((folder) => {
        const path = parentPath ? `${parentPath}/${folder.name}` : folder.name;
        map.set(folder.id, `${path}/`);
        walk(folder.children || [], path);
      });
    };
    walk(activeFolders);
    return map;
  }, [activeFolders]);

  useEffect(() => {
    selectedNoteIdRef.current = selectedNoteId;
  }, [selectedNoteId]);

  useEffect(() => {
    selectedNoteRef.current = selectedNote;
  }, [selectedNote]);

  const toggleSelectedNoteFavorite = useCallback(async () => {
    if (!selectedNote || !selectedNoteFavoriteIdentity) return;
    try {
      const result = await noteFavorites.toggle(
        selectedNoteFavoriteIdentity.canonicalId,
        noteTitle(selectedNote),
        selectedNoteFavoriteIdentity.aliases,
      );
      if (!result.cancelled) setStatus(result.favorited ? t("editor.notes.status.favorited") : t("editor.notes.status.unfavorited"));
    } catch {
      setStatus(t("editor.notes.status.favoriteFailed"));
    }
  }, [noteFavorites, selectedNote, selectedNoteFavoriteIdentity, t]);

  useEffect(() => {
    openTabsRef.current = openTabs;
  }, [openTabs]);

  const revealDocumentInFolderTree = useCallback((noteId: string) => {
    const source = readActiveKnowledgeWriteSource();
    const vaultId = source?.vaultId;
    if (!vaultId || selectedNoteIdRef.current !== noteId) return;
    setFolderDocumentReveal((current) => ({
      documentId: noteId,
      vaultId,
      session: vaultSessionRef.current.latest(),
      nonce: (current?.nonce || 0) + 1,
    }));
  }, []);

  const publishNotesPanelState = useCallback((open: boolean, width: number) => {
    window.dispatchEvent(new CustomEvent("luckyray:notes-panel-state", {
      detail: { open, width: Math.min(width, notesIndexLayoutMax) },
    }));
  }, [notesIndexLayoutMax]);

  useEffect(() => {
    publishNotesPanelState(panelOpen, notesIndexWidth);
  }, [notesIndexWidth, panelOpen, publishNotesPanelState]);

  useEffect(() => {
    if (panelOpen && notesIndexWidth >= NOTES_INDEX_COLLAPSE_THRESHOLD) {
      lastExpandedNotesIndexWidthRef.current = notesIndexWidth;
    }
  }, [notesIndexWidth, panelOpen]);

  useEffect(() => {
    if (!notesIndexWidthUserSetRef.current) return; // live default, not a preference
    // Persist once the resize settles: writing on every width change meant a
    // synchronous storage write per pointermove, and the index visibly trailed
    // the cursor on any drag after the first one.
    const persist = setTimeout(() => {
      try {
        localStorage.setItem(NOTES_INDEX_WIDTH_KEY, String(notesIndexWidth));
      } catch {
        // Ignore storage failures in restricted webviews.
      }
    }, 250);
    return () => clearTimeout(persist);
  }, [notesIndexWidth]);

  // While no user preference exists, the default follows the viewport:
  // maximized windows get the wide default, restored small windows the compact
  // one — never one forcing the other. A stored preference wins outright.
  useEffect(() => {
    const onResize = () => {
      notesViewportWidthRef.current = window.innerWidth;
      if (notesIndexWidthUserSetRef.current) return;
      setNotesIndexWidth(defaultNotesIndexWidthForViewport(window.innerWidth));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const knowledgeSearchResults = useMemo<KnowledgeSearchGroups>(() => {
    const query = knowledgeSearchQuery.trim().toLowerCase();
    const empty: KnowledgeSearchGroups = { folders: [], noteTitles: [], noteContents: [], total: 0 };
    if (!query) return empty;
    const matchesQuery = (...values: Array<string | null | undefined>) => (
      values.some((value) => (value || "").toLowerCase().includes(query))
    );

    const foldersForSearch = flattenFolders(activeFolders)
      .map(({ folder }) => ({
        id: folder.id,
        kind: "folder" as const,
        title: folder.name,
        path: folderPathMap.get(folder.id) || folder.name,
      }))
      .filter((item) => matchesQuery(item.title, item.path));

    if (knowledgeStorageMode === "real-vault") {
      const indexDocuments = realVaultMarkdownIndex?.documents || [];
      const realVaultPathLabel = (document: BridgeNotesVaultMarkdownIndexDocument) => (
        document.relativePath || document.fileName || t("editor.notes.search.vaultRoot")
      );
      const titleMatches = (document: BridgeNotesVaultMarkdownIndexDocument) => (
        matchesQuery(document.title, document.fileName, document.relativePath)
      );
      const noteTitles = indexDocuments.length
        ? indexDocuments
          .filter(titleMatches)
          .slice(0, 40)
          .map((document) => ({
            id: realVaultNoteId(document.relativePath),
            kind: "note-title" as const,
            title: document.title || markdownTitleFromPath(document.relativePath, t("editor.notes.untitled")),
            path: realVaultPathLabel(document),
            snippet: document.excerpt || excerpt(document.plainText || ""),
          }))
        : realVaultUiTree.notes
          .filter((note) => matchesQuery(noteTitle(note), note.folderId || ""))
          .slice(0, 40)
          .map((note) => ({
            id: note.id,
            kind: "note-title" as const,
            title: noteTitle(note),
            path: note.folderId || t("editor.notes.search.vaultRoot"),
            snippet: "",
          }));
      const noteContents = indexDocuments
        .filter((document) => !titleMatches(document) && matchesQuery(document.plainText, document.excerpt))
        .slice(0, 40)
        .map((document) => ({
          id: realVaultNoteId(document.relativePath),
          kind: "note-content" as const,
          title: document.title || markdownTitleFromPath(document.relativePath, t("editor.notes.untitled")),
          path: realVaultPathLabel(document),
          snippet: excerptAroundQuery(document.plainText || document.excerpt || "", query),
        }));
      return { folders: foldersForSearch, noteTitles, noteContents, total: foldersForSearch.length + noteTitles.length + noteContents.length };
    }

    const noteTitles = notes
      .filter((note) => matchesQuery(noteTitle(note)))
      .slice(0, 40)
      .map((note) => ({
        id: note.id,
        kind: "note-title" as const,
        title: noteTitle(note),
        path: note.folderId ? folderPathMap.get(note.folderId) : t("editor.notes.move.uncategorized"),
        snippet: excerpt(note.contentText || ""),
      }));

    const noteContents = notes
      .filter((note) => !matchesQuery(noteTitle(note)) && matchesQuery(note.contentText))
      .slice(0, 40)
      .map((note) => ({
        id: note.id,
        kind: "note-content" as const,
        title: noteTitle(note),
        path: note.folderId ? folderPathMap.get(note.folderId) : t("editor.notes.move.uncategorized"),
        snippet: excerpt(note.contentText || ""),
      }));

    return { folders: foldersForSearch, noteTitles, noteContents, total: foldersForSearch.length + noteTitles.length + noteContents.length };
  }, [activeFolders, folderPathMap, knowledgeSearchQuery, knowledgeStorageMode, notes, realVaultMarkdownIndex, realVaultUiTree.notes, t]);

  const sourceTextareaValue = editorMode === "source" && sourceContentDraft !== null ? sourceContentDraft : editContent;
  const activeEditorContent = editorMode === "source" ? sourceTextareaValue : editContent;
  const realVaultIndexedOutline = useMemo(() => {
    if (knowledgeStorageMode !== "real-vault" || !selectedNoteId || !isRealVaultNoteId(selectedNoteId)) return [];
    const currentRelativePath = normalizeVaultRelativePath(realVaultRelativePathFromNoteId(selectedNoteId));
    const document = realVaultMarkdownIndex?.documents.find((item) => normalizeVaultRelativePath(item.relativePath) === currentRelativePath);
    return getIndexedOutline(document);
  }, [knowledgeStorageMode, realVaultMarkdownIndex, selectedNoteId]);
  const outline = useMemo(() => {
    const parsedOutline = getOutline(activeEditorContent);
    if (knowledgeStorageMode === "real-vault" && !activeEditorContent.trim() && realVaultIndexedOutline.length) return realVaultIndexedOutline;
    return parsedOutline;
  }, [activeEditorContent, knowledgeStorageMode, realVaultIndexedOutline]);
  const lineCount = useMemo(() => Math.max(1, activeEditorContent.split(/\r?\n/).length), [activeEditorContent]);
  const wordCount = useMemo(() => countWords(activeEditorContent), [activeEditorContent]);
  const activeRealVaultExternalConflict = realVaultExternalConflict?.noteId === selectedNoteId
    ? realVaultExternalConflict
    : null;
  const previewAssets = useMemo(() => [...assetsForNote, ...allAssets], [allAssets, assetsForNote]);
  const outgoingNoteLinkDisplays = useMemo(() => parseOutgoingNoteLinkDisplays(activeEditorContent, {
    blockTarget: (block) => t("editor.notes.context.blockTarget", { block }),
    headingTarget: (heading) => t("editor.notes.context.headingTarget", { heading }),
    pointsTo: (target) => t("editor.notes.context.pointsTo", { target }),
  }), [activeEditorContent, t]);
  const realVaultEditorNotes = useMemo(() => (
    buildRealVaultEditorNotes(
      realVaultMarkdownIndex?.documents || [],
      realVaultUiTree.notes,
      selectedNote,
      t("editor.notes.untitled"),
    )
  ), [realVaultMarkdownIndex, realVaultUiTree.notes, selectedNote, t]);
  const realVaultEditorNoteLinks = useMemo(() => (
    buildRealVaultEditorNoteLinks(realVaultMarkdownIndex?.documents || [])
  ), [realVaultMarkdownIndex]);
  const editorNotes = knowledgeStorageMode === "real-vault" ? realVaultEditorNotes : notes;
  const editorNoteLinks = knowledgeStorageMode === "real-vault" ? realVaultEditorNoteLinks : noteLinks;
  const currentRealVaultTagNames = useMemo(() => {
    if (knowledgeStorageMode !== "real-vault" || !selectedNoteId || !isRealVaultNoteId(selectedNoteId)) return [];
    const fromEditorContent = extractFrontmatterTagNamesForRealVault(activeEditorContent);
    if (selectedNote || fromEditorContent.length) return fromEditorContent;
    const currentRelativePath = normalizeVaultRelativePath(realVaultRelativePathFromNoteId(selectedNoteId));
    const indexedDocument = realVaultMarkdownIndex?.documents.find((document) => normalizeVaultRelativePath(document.relativePath) === currentRelativePath);
    return uniqueMarkdownTagNames(indexedDocument?.frontmatterTags || []);
  }, [activeEditorContent, knowledgeStorageMode, realVaultMarkdownIndex, selectedNote, selectedNoteId]);
  const realVaultTags = useMemo(() => (
    buildRealVaultTagList(realVaultMarkdownIndex, currentRealVaultTagNames)
  ), [currentRealVaultTagNames, realVaultMarkdownIndex]);
  const activeAllTags = knowledgeStorageMode === "real-vault" ? realVaultTags : allTags;
  const activeNoteTags = knowledgeStorageMode === "real-vault"
    ? currentRealVaultTagNames.map(realVaultTagId)
    : noteTags;
  const activeTagNameMap = useMemo(() => {
    const map = new Map<string, string>();
    activeAllTags.forEach((tag) => map.set(tag.id, tag.name));
    return map;
  }, [activeAllTags]);

  const aiSuggestionTags = useMemo(() => (
    uniqueMarkdownTagNames(aiSuggestion?.auto_tags || [])
  ), [aiSuggestion]);
  const aiSuggestionTagKey = aiSuggestionTags.join("\u0000");
  const selectedAiTags = useMemo(() => (
    aiSelectedTags === null ? aiSuggestionTags : uniqueMarkdownTagNames(aiSelectedTags)
  ), [aiSelectedTags, aiSuggestionTags]);

  const updateNotesPaneAiState = useCallback((paneId: string, noteId: string, patch: Partial<Omit<NotesPaneAiState, "noteId">>) => {
    setNotesPaneAiStates((current) => {
      const paneStates = current[paneId] || {};
      const existing = paneStates[noteId];
      const base: NotesPaneAiState = existing?.noteId === noteId
        ? existing
        : { noteId, panelOpen: false, busy: false, suggestion: null, selectedTags: null };
      return {
        ...current,
        [paneId]: {
          ...paneStates,
          [noteId]: { ...base, ...patch, noteId },
        },
      };
    });
  }, []);

  useEffect(() => {
    setAiSelectedTags(aiSuggestionTags.length ? aiSuggestionTags : null);
  }, [aiSuggestion?.noteId, aiSuggestionTagKey]);

  useEffect(() => {
    if (!notesPaneLayout || !selectedNoteId) return;
    const paneState = notesPaneAiStates[activeNotesSplitPane]?.[selectedNoteId];
    if (!paneState) return;
    setAiPanelOpen(paneState.panelOpen);
    setAiSuggestion(paneState.suggestion);
    setAiSelectedTags(paneState.selectedTags);
    setAiBusy(paneState.busy);
  }, [activeNotesSplitPane, notesPaneAiStates, notesPaneLayout, selectedNoteId]);

  const toggleAiSuggestionTag = useCallback((tag: string) => {
    const normalized = normalizeMarkdownTagName(tag);
    if (!normalized) return;
    const source = aiSelectedTags === null ? aiSuggestionTags : aiSelectedTags;
    const exists = source.some((item) => item.toLocaleLowerCase() === normalized.toLocaleLowerCase());
    const next = exists
      ? source.filter((item) => item.toLocaleLowerCase() !== normalized.toLocaleLowerCase())
      : uniqueMarkdownTagNames([...source, normalized]);
    setAiSelectedTags(next);
    if (notesPaneLayout && selectedNoteId) {
      updateNotesPaneAiState(activeNotesSplitPane, selectedNoteId, { selectedTags: next });
    }
  }, [activeNotesSplitPane, aiSelectedTags, aiSuggestionTags, notesPaneLayout, selectedNoteId, updateNotesPaneAiState]);

  const readActiveEditorValue = useCallback(() => {
    if (editorMode === "live") return liveEditorRef.current?.getValue() ?? editContent;
    if (editorMode === "source") return textareaRef.current?.value ?? sourceContentDraft ?? editContent;
    return editContent;
  }, [editContent, editorMode, sourceContentDraft]);

  const readActiveEditorSelection = useCallback(() => {
    if (editorMode === "live") {
      return liveEditorRef.current?.getSelection() || { start: editContent.length, end: editContent.length };
    }
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? editContent.length;
    const end = textarea?.selectionEnd ?? start;
    return { start: Math.min(start, end), end: Math.max(start, end) };
  }, [editContent.length, editorMode]);

  const focusActiveEditor = useCallback(() => {
    if (editorMode === "live") liveEditorRef.current?.focus();
    else textareaRef.current?.focus();
  }, [editorMode]);

  const setActiveEditorSelection = useCallback((selection: { start: number; end: number }) => {
    if (editorMode === "live") liveEditorRef.current?.setSelection(selection);
    else {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(selection.start, selection.end);
    }
  }, [editorMode]);

  const focusOutlineLine = useCallback((line: number) => {
    const currentContent = readActiveEditorValue();
    const lines = currentContent.split(/\r?\n/);
    const safeLine = Math.max(1, Math.min(line, lines.length));
    const start = lines.slice(0, safeLine - 1).reduce((sum, item) => sum + item.length + 1, 0);
    const end = start + (lines[safeLine - 1]?.length || 0);
    if (editorMode === "source") {
      const textarea = textareaRef.current;
      textarea?.focus();
      textarea?.setSelectionRange(start, end);
      if (textarea) textarea.scrollTop = Math.max(0, (safeLine - 1) * 24 - textarea.clientHeight / 3);
      return;
    }
    setActiveEditorSelection({ start, end });
  }, [editorMode, readActiveEditorValue, setActiveEditorSelection]);

  const publishActiveNoteContext = useCallback(() => {
    if(!pageVisibleRef.current)return;
    if (!selectedNote) {
      clearCurrentNoteContext(activeContextPublisherRef.current);
      return;
    }
    const { start, end } = readActiveEditorSelection();
    const currentContent = readActiveEditorValue();
    const from = Math.max(0, Math.min(Math.min(start, end), currentContent.length));
    const to = Math.max(0, Math.min(Math.max(start, end), currentContent.length));
    const selection = from !== to ? currentContent.slice(from, to) : "";
    const title = editTitle.trim() || noteTitle(selectedNote);
    publishCurrentNoteContext({
      id: selectedNote.id,
      title,
      contentText: currentContent,
      folderId: selectedNote.folderId,
      tagIds: activeNoteTags,
      tags: activeNoteTags.map((id) => activeTagNameMap.get(id) || id),
      cursorOffset: start,
      selection: selection || null,
      updatedAt: selectedNote.updatedAt,
    }, activeContextPublisherRef.current);
  }, [activeNoteTags, activeTagNameMap, editTitle, readActiveEditorSelection, readActiveEditorValue, selectedNote]);

  const scheduleActiveNoteContext = useCallback(() => {
    if (activeContextTimerRef.current) clearTimeout(activeContextTimerRef.current);
    activeContextTimerRef.current = setTimeout(() => {
      activeContextTimerRef.current = null;
      publishActiveNoteContext();
    }, 120);
  }, [publishActiveNoteContext]);
  const publishedActiveNoteIdRef = useRef<string | null>(null);

  const publishedTabsRef = useRef("");
  const publishTabs = useCallback((tabs: NotesOpenTab[], activeId: string | null, sourceNotes = notes) => {
    const titleMap = new Map(sourceNotes.map((note) => [note.id, noteTitle(note)]));
    const detail = {
      activeId,
      tabs: tabs.map((tab) => ({
        id: tab.id,
        kind: tab.kind || "note",
        noteId: tab.kind === "empty" ? null : tab.id,
        viewId:tab.kind!=="empty"&&!notesPaneLayout?notesPaneViewsRef.current.get("notes-pane-1",tab.id):undefined,
        title: tab.kind === "empty" ? t("editor.notes.newTab") : titleMap.get(tab.id) || (tab.id === activeId ? editTitle || t("editor.notes.untitled") : t("editor.notes.untitled")),
      })),
    };
    const signature = JSON.stringify(detail);
    if (publishedTabsRef.current === signature) return;
    publishedTabsRef.current = signature;
    window.dispatchEvent(new CustomEvent("luckyray:notes-tabs", { detail }));
  }, [editTitle, notes, notesPaneLayout, t]);

  useEffect(() => {
    publishTabs(openTabs, selectedNoteId || activeEmptyTabId);
  }, [activeEmptyTabId, openTabs, publishTabs, selectedNoteId]);


  useEffect(() => {
    if (!vaultBootstrapReady || !openTabs.length) return;
    const activeId = selectedNoteId || activeEmptyTabId || openTabs[0]?.id || null;
    try {
      const payload = JSON.stringify({ tabs: openTabs, activeId });
      if (currentVault?.id) {
        persistNoteTabsForVault(currentVault.id, payload, sessionStorage);
        persistNoteTabsForVault(currentVault.id, payload, localStorage);
      } else {
        sessionStorage.setItem(NOTE_TABS_STATE_KEY, payload);
        localStorage.setItem(NOTE_TABS_STATE_KEY, payload);
        localStorage.setItem(LEGACY_NOTE_TABS_STATE_KEY, payload);
      }
    } catch {
      // Tab state persistence is best effort only.
    }
  }, [activeEmptyTabId, currentVault?.id, openTabs, selectedNoteId, vaultBootstrapReady]);

  const loadTags = useCallback(async () => {
    if (!bridge?.listTags) return;
    try {
      const list = await bridge.listTags();
      setAllTags(Array.isArray(list) ? list : []);
    } catch (error) {
      console.warn("[NotesPage] listTags failed", error);
    }
  }, [bridge]);

  const loadAssets = useCallback(async () => {
    if (!bridge?.listAssets) return;
    try {
      const list = await bridge.listAssets();
      setAllAssets(Array.isArray(list) ? list : []);
    } catch (error) {
      console.warn("[NotesPage] listAssets failed", error);
    }
  }, [bridge]);

  const loadNotes = useCallback(async () => {
    setNotes([]);
  }, []);

  const refreshRealVaultMarkdownIndex = useCallback(async (vaultOverride?: BridgeVaultMetadata | null) => {
    const vault = vaultOverride ?? currentVault;
    if (!vault || !bridge?.getNotesVaultMarkdownIndex) {
      setRealVaultMarkdownIndex(null);
      return null;
    }
    try {
      const snapshot = await knowledgeStore.revalidate({ reason: "notes-index", force: true });
      const index = snapshot.mode === "real-vault" && snapshot.vault?.id === vault.id
        ? snapshot.markdownIndex
        : null;
      if (!index) return null;
      setRealVaultMarkdownIndex(index);
      return index;
    } catch (error) {
      console.warn("[NotesPage] get real vault markdown index failed", error);
      setRealVaultMarkdownIndex(null);
      return null;
    }
  }, [bridge, currentVault]);

  const applyRealVaultStoreSnapshot = useCallback((tree: KnowledgeTreeNode[], index: BridgeNotesVaultMarkdownIndex | null, vaultId: string) => {
    const uiTree = buildRealVaultUiTree(tree, locale, t("editor.notes.untitled"));
    const realFolderIds = new Set<string>();
    const collectFolderIds = (items: Folder[]) => {
      items.forEach((folder) => {
        realFolderIds.add(folder.id);
        collectFolderIds(folder.children || []);
      });
    };
    collectFolderIds(uiTree.folders);
    const noteIds = new Set(uiTree.notes.map((note) => note.id));
    const currentId = selectedNoteIdRef.current;
    const hasCurrent = Boolean(currentId && noteIds.has(currentId));
    // Rename replies remap the active document before the background index catches
    // up. An older tree must not turn that retained editor into an empty tab.
    if (renamingNoteRef.current && currentId && !hasCurrent) return { noteIds, index, uiTree };
    const restoredTabs = filterSavedNoteTabs(readSavedNoteTabsState(vaultId), noteIds);
    const memoryTabs = openTabsRef.current.filter((tab) => isEmptyNoteTab(tab) || noteIds.has(tab.id));
    const baseTabs = memoryTabs.length ? memoryTabs : restoredTabs?.tabs || [];
    const existingEmpty = baseTabs.find(isEmptyNoteTab);
    const fallbackEmpty = existingEmpty || createEmptyNoteTab();
    const activeRestored = restoredTabs?.active && (isEmptyNoteTab(restoredTabs.active) || noteIds.has(restoredTabs.active.id)) ? restoredTabs.active : null;
    const activeTab = hasCurrent && currentId ? baseTabs.find((tab) => tab.id === currentId) || { id: currentId, kind: "note" as const } : activeRestored;
    const normalizedTabs = baseTabs.length ? baseTabs : [fallbackEmpty];
    const shouldOpenRestoredNote = !hasCurrent && activeTab?.kind !== "empty" && activeTab?.id && noteIds.has(activeTab.id);
    setRealVaultTree(tree);
    setRealVaultMarkdownIndex(index);
    setNotes(uiTree.notes);
    setSelectedFolderId((current) => {
      if (!current || current === "__uncategorized__") return current;
      return realFolderIds.has(current) ? current : null;
    });
    if (hasCurrent) {
      setActiveEmptyTabId(null);
    } else if (shouldOpenRestoredNote) {
      setSelectedNoteId(activeTab.id);
      setSelectedNote(null);
      setEditTitle("");
      setEditContent("");
      setSourceContentDraft(null);
      setActiveEmptyTabId(null);
    } else {
      setSelectedNoteId(null);
      setSelectedNote(null);
      setEditTitle("");
      setEditContent("");
      setSourceContentDraft(null);
      setActiveEmptyTabId(fallbackEmpty.id);
    }
    // Keep the ref in lockstep: restores and future snapshots read it before
    // the next commit, and a stale value would resurrect filtered-out tabs.
    openTabsRef.current = normalizedTabs;
    setOpenTabs(normalizedTabs);
    return { noteIds, index, uiTree };
  }, [locale, t]);

  const loadRealVaultTree = useCallback(async (options?: { silent?: boolean; cachedOnly?: boolean; fresh?: boolean }) => {
    if (!currentVault) return;
    const cached = knowledgeStore.getSnapshot();
    let cachedResult: ReturnType<typeof applyRealVaultStoreSnapshot> | undefined;
    if (!options?.fresh && cached.loaded && cached.mode === "real-vault" && cached.vault?.id === currentVault.id) {
      cachedResult = applyRealVaultStoreSnapshot(cached.tree, cached.markdownIndex, cached.vault.id);
      if (options?.cachedOnly) return cachedResult;
    }
    if (!options?.silent && !cachedResult) setLoading(true);
    try {
      const snapshot = await knowledgeStore.revalidate({ reason: "notes-tree", force: options?.fresh });
      if (snapshot.mode !== "real-vault" || snapshot.vault?.id !== currentVault.id) return cachedResult;
      return applyRealVaultStoreSnapshot(snapshot.tree, snapshot.markdownIndex, snapshot.vault.id);
    } catch (error) {
      console.warn("[NotesPage] list real vault files failed", error);
      setStatus(error instanceof Error ? error.message : t("editor.notes.status.vaultLoadFailed"));
    } finally {
      if (!options?.silent) setLoading(false);
    }
  }, [applyRealVaultStoreSnapshot, currentVault, t]);

  const reloadCurrentSource = useCallback(async () => {
    if (knowledgeStorageMode === "real-vault") {
      await loadRealVaultTree();
      return;
    }
    await loadNotes();
  }, [knowledgeStorageMode, loadNotes, loadRealVaultTree]);

  const showEmptyTab = useCallback((tabId?: string, options?: { ensureOpen?: boolean }) => {
    const nextId = tabId || createEmptyNoteTab().id;
    commitCurrentEditorDraftRef.current();
    flushPendingSaveRef.current();
    if (selectedNoteIdRef.current && isRealVaultNoteId(selectedNoteIdRef.current)) {
      realVaultDocumentReadsRef.current.clearHydration();
    }
    noteLoadRequestRef.current += 1;
    relationRequestRef.current += 1;
    if (options?.ensureOpen !== false) {
      setOpenTabs((current) => current.some((tab) => tab.id === nextId) ? current : [...current, { id: nextId, kind: "empty" }]);
    }
    setActiveEmptyTabId(nextId);
    setSelectedNoteId(null);
    setSelectedNote(null);
    setEditTitle("");
    setEditContent("");
    setSourceContentDraft(null);
    setAutocomplete(null);
    setNoteTags([]);
    setBacklinks([]);
    setUnlinkedMentions([]);
    setNoteLinks([]);
    setNoteEmbeds([]);
    setAssetsForNote([]);
    setAiPanelOpen(false);
    setAiSuggestion(null);
    setEditorMode("live");
    window.dispatchEvent(new CustomEvent("luckyray:notes-active-title", { detail: { title: t("editor.notes.newTab") } }));
    window.dispatchEvent(new CustomEvent("luckyray:notes-active-note", { detail: { noteId: null } }));
  }, [t]);

  const resetActiveDocumentForSource = useCallback((source: KnowledgeSourceMode) => {
    commitCurrentEditorDraftRef.current();
    flushPendingSaveRef.current();
    setNotesPaneLayout(null);
    setNotesPaneTabs(null);
    setNotesPaneActiveTabs(null);
    setNotesPaneModes(null);
    // Pane documents, their cache, editors, scroll memory, AI state and the
    // pane id sequence all belong to the session that created them. Note ids
    // are relative-path scoped, so keeping any of them across a vault switch
    // would let the previous vault's content render (and save) under the new
    // vault's identity. The layout alone is not enough.
    setNotesPaneDocuments({});
    notesPaneDocumentCacheRef.current.clear();
    notesPaneScrollPositionsRef.current.clear();
    notesPaneEditorSessionsRef.current.clear();
    notesPaneViewsRef.current.clear();
    realVaultReadProofRef.current.clear();
    notesViewRefsRef.current.clear();
    mediaViewportLinesRef.current.clear();
    setPublishedDraftEmbeds([]);
    scheduleAttachmentPrefetch([], () => false);
    notesPaneLoadRequestRef.current.clear();
    notesPaneSequenceRef.current = 1;
    setNotesPaneAiStates({});
    liveEditorRef.current = null;
    setActiveNotesSplitPane("notes-pane-1");
    if (selectedNoteIdRef.current && isRealVaultNoteId(selectedNoteIdRef.current)) {
      realVaultDocumentReadsRef.current.clearHydration();
    }
    noteLoadRequestRef.current += 1;
    relationRequestRef.current += 1;
    const keptTabs = keepTabsForSource(openTabsRef.current, source);
    const existingEmpty = keptTabs.find(isEmptyNoteTab);
    const fallbackEmpty = existingEmpty || createEmptyNoteTab();
    const nextTabs = keptTabs.length
      ? existingEmpty ? keptTabs : [...keptTabs, fallbackEmpty]
      : [fallbackEmpty];
    // Sync the ref immediately: snapshot restores read it before the next
    // render commits, and a stale ref would resurrect the previous tabs.
    openTabsRef.current = nextTabs;
    setOpenTabs(nextTabs);
    setActiveEmptyTabId(fallbackEmpty.id);
    setSelectedNoteId(null);
    setSelectedNote(null);
    setEditTitle("");
    setEditContent("");
    setSourceContentDraft(null);
    setAutocomplete(null);
    setNoteTags([]);
    setBacklinks([]);
    setUnlinkedMentions([]);
    setNoteLinks([]);
    setNoteEmbeds([]);
    setAssetsForNote([]);
    setAiPanelOpen(false);
    setAiSuggestion(null);
    setEditorMode("live");
    window.dispatchEvent(new CustomEvent("luckyray:notes-active-title", { detail: { title: t("editor.notes.newTab") } }));
    window.dispatchEvent(new CustomEvent("luckyray:notes-active-note", { detail: { noteId: null } }));
  }, [t]);

  const loadNoteRelations = useCallback(async (noteId: string) => {
    const requestId = relationRequestRef.current + 1;
    relationRequestRef.current = requestId;
    const [
      nextTags,
      nextBacklinks,
      nextUnlinkedMentions,
      nextLinks,
      nextEmbeds,
      nextAssets,
      nextAiSuggestion,
    ] = await Promise.all([
      bridge?.getNoteTags ? bridge.getNoteTags(noteId).catch(() => []) : Promise.resolve([]),
      bridge?.getNotesLinkingToNote ? bridge.getNotesLinkingToNote(noteId).catch(() => []) : Promise.resolve([]),
      bridge?.getUnlinkedNoteMentions ? bridge.getUnlinkedNoteMentions(noteId).catch(() => []) : Promise.resolve([]),
      bridge?.getNoteLinks ? bridge.getNoteLinks(noteId).catch(() => []) : Promise.resolve([]),
      bridge?.getNoteEmbeds ? bridge.getNoteEmbeds(noteId).catch(() => []) : Promise.resolve([]),
      bridge?.getAssetsForNote ? bridge.getAssetsForNote(noteId).catch(() => []) : Promise.resolve([]),
      bridge?.getNoteAiSuggestion ? bridge.getNoteAiSuggestion(noteId).catch(() => null) : Promise.resolve(null),
    ]);
    if (relationRequestRef.current !== requestId) return;
    setNoteTags(Array.isArray(nextTags) ? nextTags : []);
    setBacklinks(Array.isArray(nextBacklinks) ? nextBacklinks : []);
    setUnlinkedMentions(Array.isArray(nextUnlinkedMentions) ? nextUnlinkedMentions : []);
    setNoteLinks(Array.isArray(nextLinks) ? nextLinks : []);
    setNoteEmbeds(Array.isArray(nextEmbeds) ? nextEmbeds : []);
    setAssetsForNote(Array.isArray(nextAssets) ? nextAssets : []);
    setAiSuggestion(nextAiSuggestion ? { ...nextAiSuggestion, noteId } : null);
  }, [bridge]);

  const syncNotesPaneDocumentAcrossPanes = useCallback((noteId: string, document: NotesPaneDocumentSnapshot) => {
    setNotesPaneDocuments((current) => {
      let matched = false;
      const next: NotesPaneDocuments = {};
      for (const [paneId, documents] of Object.entries(current)) {
        if (!documents[noteId]) {
          next[paneId] = documents;
          continue;
        }
        matched = true;
        next[paneId] = {
          ...documents,
          [noteId]: { ...documents[noteId], ...document, loaded: true },
        };
      }
      return matched ? next : current;
    });
  }, []);

  const reloadCurrentRealVaultDocumentFromDisk = useCallback(async (noteId: string) => {
    if (!isRealVaultNoteId(noteId)) return false;
    const relativePath = normalizeVaultRelativePath(realVaultRelativePathFromNoteId(noteId));
    const realNoteId = realVaultNoteId(relativePath);
    const source = readActiveKnowledgeWriteSource();
    if (!source || selectedNoteIdRef.current !== realNoteId) return false;
    const draftBeforeRead = realVaultLatestContentRef.current.get(realNoteId);
    const requestId = noteLoadRequestRef.current + 1;
    noteLoadRequestRef.current = requestId;
    try {
      const document = await realVaultDocumentSource.openDocument(relativePath);
      if (noteLoadRequestRef.current !== requestId
        || source !== readActiveKnowledgeWriteSource()
        || selectedNoteIdRef.current !== realNoteId
        || realVaultLatestContentRef.current.get(realNoteId) !== draftBeforeRead) return false;
      const note = noteFromKnowledgeDocument(document, t("editor.notes.untitled"));
      realVaultSavedContentRef.current.set(realNoteId, note.contentText || "");
      realVaultLatestContentRef.current.set(realNoteId, note.contentText || "");
      realVaultUserDirtyRef.current.delete(realNoteId);
      realVaultKeepEditingAfterConflictRef.current.delete(realNoteId);
      setRealVaultExternalConflict((current) => current?.noteId === realNoteId ? null : current);
      setNotes((current) => {
        const exists = current.some((item) => item.id === note.id);
        return exists ? current.map((item) => item.id === note.id ? { ...item, ...note } : item) : [...current, note];
      });
      const paneSnapshot = {
        title: noteTitle(note),
        contentText: note.contentText || "",
        loaded: true,
      };
      notesPaneDocumentCacheRef.current.set(realNoteId, paneSnapshot);
      syncNotesPaneDocumentAcrossPanes(realNoteId, paneSnapshot);
      setSelectedNoteId(realNoteId);
      setSelectedNote(note);
      setEditTitle(note.title || "");
      setEditContent(note.contentText || "");
      setSourceContentDraft(null);
      setAutocomplete(null);
      // Revalidate in place: source-scoped cached matches remain usable while
      // the new index resolves. The existing EditorView synchronizes its value.
      recheckAttachments();
      window.dispatchEvent(new CustomEvent("luckyray:notes-active-title", { detail: { title: noteTitle(note) } }));
      window.dispatchEvent(new CustomEvent("luckyray:notes-active-note", { detail: { noteId: realNoteId } }));
      return true;
    } catch (error) {
      console.warn("[NotesPage] reload real vault document failed", error);
      setStatus(error instanceof Error ? error.message : t("editor.notes.status.vaultReloadFailed"));
      return false;
    }
  }, [realVaultDocumentSource, recheckAttachments, syncNotesPaneDocumentAcrossPanes, t]);

  const selectNote = useCallback(async (noteId: string, options?: NoteSelectOptions) => {
    if(notesNativeViews.hasFrozenViews()&&options?.tabMode!=='open'&&selectedNoteIdRef.current!==noteId)return;
    if (knowledgeStorageMode === "real-vault" || isRealVaultNoteId(noteId)) {
      const relativePath = realVaultRelativePathFromNoteId(noteId);
      const realNoteId = realVaultNoteId(relativePath);
      const isChangingNote = realNoteId !== selectedNoteId;
      if (isChangingNote) {
        const viewport = liveEditorRef.current?.getVisibleLines();
        if (viewport && selectedNoteId) mediaViewportLinesRef.current.set(selectedNoteId, viewport);
        const currentNoteId = selectedNoteIdRef.current;
        commitCurrentEditorDraftRef.current();
        flushPendingSaveRef.current();
        if (currentNoteId && isRealVaultNoteId(currentNoteId)) {
          realVaultDocumentReadsRef.current.clearHydration();
        }
        relationRequestRef.current += 1;
        setNoteTags([]);
        setBacklinks([]);
        setUnlinkedMentions([]);
        setNoteLinks([]);
        setNoteEmbeds([]);
        setAssetsForNote([]);
      }
      const requestId = noteLoadRequestRef.current + 1;
      noteLoadRequestRef.current = requestId;
      const noteSession = vaultSessionRef.current.latest();
      const finishHydration = realVaultDocumentReadsRef.current.beginHydration(realNoteId);
      let hydrationApplied = false;
      // A view may have been evicted, but its unsaved text still belongs to the document authority.
      const existingDraft = realVaultLatestContentRef.current.get(realNoteId);
      const hasDraft = () => realVaultUserDirtyRef.current.has(realNoteId)
        || realVaultSaveInFlightRef.current.has(realNoteId)
        || pendingPatchNoteIdRef.current === realNoteId;
      setAiPanelOpen(false);
      setAiSuggestion(null);
      setActiveEmptyTabId(null);
      // Snapshot refreshes can resolve before React effects mirror the new state
      // into refs. Lock the navigation target synchronously so they cannot
      // restore the previously active document over this one.
      selectedNoteIdRef.current = realNoteId;
      setSelectedNoteId(realNoteId);
      prepareNoteMediaRef.current(realNoteId);
      if (existingDraft !== undefined && hasDraft()) {
        const cached = notes.find((note) => note.id === realNoteId)
          || noteFromKnowledgeDocument({ source: "real-vault", id: relativePath, relativePath,
            title: "", contentText: existingDraft }, t("editor.notes.untitled"));
        {
          const draftNote = { ...cached, id: realNoteId, contentText: existingDraft };
          selectedNoteRef.current = draftNote;
          setSelectedNote(draftNote);
          setEditTitle(draftNote.title || "");
          setEditContent(existingDraft);
          setSourceContentDraft(null);
          // This is a ready draft, not disk hydration. User input must keep its dirty marker.
          finishHydration();
        }
      }
      const tabMode = options?.tabMode || "replace";
      if (options?.syncGlobalTab !== false) {
        setOpenTabs((current) => {
          const next = nextOpenTabsForNote(current, realNoteId, selectedNoteId || activeEmptyTabId, selectedNoteId, tabMode);
          openTabsRef.current = next;
          return next;
        });
      }
      try {
        const baselineBeforeRead = realVaultSavedContentRef.current.get(realNoteId);
        const document = await realVaultDocumentSource.openDocument(relativePath);
        if (!vaultSessionRef.current.isCurrent(noteSession)) return;
        if (noteLoadRequestRef.current !== requestId) return;
        const baselineAfterRead = realVaultSavedContentRef.current.get(realNoteId);
        if (baselineBeforeRead !== baselineAfterRead && document.contentText !== baselineAfterRead) return;
        const note = noteFromKnowledgeDocument(document, t("editor.notes.untitled"));
        const latestDraft = realVaultLatestContentRef.current.get(realNoteId);
        if (latestDraft !== undefined && hasDraft()) {
          const baseline = realVaultSavedContentRef.current.get(realNoteId);
          if (baseline !== undefined && baseline !== (note.contentText || "")) {
            setRealVaultExternalConflict({ noteId: realNoteId, detectedAt: Date.now() });
          }
          note.contentText = latestDraft;
        } else {
          realVaultSavedContentRef.current.set(realNoteId, note.contentText || "");
          realVaultLatestContentRef.current.set(realNoteId, note.contentText || "");
          realVaultUserDirtyRef.current.delete(realNoteId);
          realVaultKeepEditingAfterConflictRef.current.delete(realNoteId);
          setRealVaultExternalConflict((current) => current?.noteId === realNoteId ? null : current);
        }
        setNotes((current) => {
          const exists = current.some((item) => item.id === note.id);
          return exists ? current.map((item) => item.id === note.id ? { ...item, ...note } : item) : [...current, note];
        });
        selectedNoteRef.current = note;
        setSelectedNote(note);
        setEditTitle(note.title || "");
        setEditContent(note.contentText || "");
        setSourceContentDraft(null);
        setAutocomplete(null);
        hydrationApplied = true;
        // The authoritative editor sync is annotated and never calls onChange.
        // Once the document is published, all subsequent input is a user draft.
        finishHydration();
        window.dispatchEvent(new CustomEvent("luckyray:notes-active-title", { detail: { title: noteTitle(note) } }));
        window.dispatchEvent(new CustomEvent("luckyray:notes-active-note", { detail: { noteId: realNoteId } }));
        if (options?.focusEditor) window.setTimeout(() => {
          if (noteLoadRequestRef.current === requestId) focusActiveEditor();
        }, 40);
        if (options?.scrollList) window.setTimeout(() => {
          if (noteLoadRequestRef.current === requestId) revealDocumentInFolderTree(realNoteId);
        }, 80);
      } catch (error) {
        if (!vaultSessionRef.current.isCurrent(noteSession)) return;
        if (noteLoadRequestRef.current !== requestId) return;
        finishHydration();
        console.warn("[NotesPage] open real vault document failed", error);
        if (realVaultLatestContentRef.current.has(realNoteId) && hasDraft()) {
          setStatus(error instanceof Error ? error.message : t("editor.notes.status.documentOpenFailed"));
          return;
        }
        realVaultSavedContentRef.current.delete(realNoteId);
        realVaultLatestContentRef.current.delete(realNoteId);
        realVaultUserDirtyRef.current.delete(realNoteId);
        setStatus(error instanceof Error ? error.message : t("editor.notes.status.documentOpenFailed"));
        const fallbackEmpty = createEmptyNoteTab();
        setOpenTabs((current) => {
          const keptTabs = current.filter((tab) => tab.id !== realNoteId && !isEmptyNoteTab(tab));
          return [...keptTabs, fallbackEmpty];
        });
        setActiveEmptyTabId(fallbackEmpty.id);
        selectedNoteIdRef.current = null;
        selectedNoteRef.current = null;
        setSelectedNoteId(null);
        setSelectedNote(null);
        setEditTitle("");
        setEditContent("");
        setSourceContentDraft(null);
        setAutocomplete(null);
        setRealVaultAssetMatches({});
      } finally {
        // Early returns from a superseded read must release its hydration lease.
        if (!hydrationApplied) finishHydration();
      }
      return;
    }

    if (!bridge?.getNote) return;
    const isChangingNote = noteId !== selectedNoteId;
    if (isChangingNote) {
      commitCurrentEditorDraftRef.current();
      flushPendingSaveRef.current();
      if (selectedNoteIdRef.current && isRealVaultNoteId(selectedNoteIdRef.current)) {
        realVaultDocumentReadsRef.current.clearHydration();
      }
      relationRequestRef.current += 1;
      setNoteTags([]);
      setBacklinks([]);
      setUnlinkedMentions([]);
      setNoteLinks([]);
      setNoteEmbeds([]);
      setAssetsForNote([]);
    }
    const requestId = noteLoadRequestRef.current + 1;
    noteLoadRequestRef.current = requestId;
    setAiPanelOpen(false);
    setAiSuggestion(null);
    setActiveEmptyTabId(null);
    setSelectedNoteId(noteId);
    const tabMode = options?.tabMode || "replace";
    if (options?.syncGlobalTab !== false) {
      setOpenTabs((current) => nextOpenTabsForNote(current, noteId, selectedNoteId || activeEmptyTabId, selectedNoteId, tabMode));
    }
    try {
      const note = await bridge.getNote(noteId);
      if (noteLoadRequestRef.current !== requestId) return;
      if (!note) return;
      setSelectedNote(note);
      setEditTitle(note.title || "");
      setEditContent(note.contentText || "");
      setSourceContentDraft(null);
      setAutocomplete(null);
      await loadNoteRelations(noteId);
      if (noteLoadRequestRef.current !== requestId) return;
      window.dispatchEvent(new CustomEvent("luckyray:notes-active-title", { detail: { title: noteTitle(note) } }));
      window.dispatchEvent(new CustomEvent("luckyray:notes-active-note", { detail: { noteId } }));
      if (options?.anchorInEditor && (options.blockId || options.headingPath)) {
        setEditorMode(editorMode === "source" ? "source" : "live");
        const anchor = findSameNoteAnchorRange(note.contentText || "", options);
        window.setTimeout(() => {
          if (noteLoadRequestRef.current !== requestId) return;
          if (!anchor) {
            setStatus(options.blockId ? t("editor.notes.status.blockNotFound", { block: options.blockId }) : t("editor.notes.status.headingNotFound", { heading: options.headingPath || "" }));
            return;
          }
          setActiveEditorSelection({ start: anchor.from, end: anchor.to });
          if (editorMode === "source") {
            const textarea = textareaRef.current;
            if (textarea) textarea.scrollTop = Math.max(0, (anchor.line - 1) * 24 - textarea.clientHeight / 3);
          }
          setStatus(anchor.kind === "block" ? t("editor.notes.status.blockLocated", { block: anchor.label }) : t("editor.notes.status.headingLocated", { heading: anchor.label }));
        }, 80);
      } else if (options?.blockId) {
        setEditorMode("preview");
        setPendingBlockId(options.blockId);
        setPendingHeadingPath(null);
      } else if (options?.headingPath) {
        setEditorMode("preview");
        setPendingHeadingPath(options.headingPath);
        setPendingBlockId(null);
      } else if (options?.focusEditor) window.setTimeout(() => {
        if (noteLoadRequestRef.current === requestId) focusActiveEditor();
      }, 40);
      if (options?.scrollList) window.setTimeout(() => {
        if (noteLoadRequestRef.current === requestId) revealDocumentInFolderTree(noteId);
      }, 80);
    } catch (error) {
      if (noteLoadRequestRef.current !== requestId) return;
      console.warn("[NotesPage] getNote failed", error);
    }
  }, [activeEmptyTabId, bridge, editorMode, focusActiveEditor, knowledgeStorageMode, loadNoteRelations, notes, realVaultDocumentSource, revealDocumentInFolderTree, selectedNoteId, setActiveEditorSelection, t]);

  const activeNotesTab = useMemo<NotesOpenTab | null>(() => {
    if (selectedNoteId) return { id: selectedNoteId, kind: "note" };
    if (activeEmptyTabId) return { id: activeEmptyTabId, kind: "empty" };
    return null;
  }, [activeEmptyTabId, selectedNoteId]);

  useEffect(() => {
    if (!notesPaneLayout) return;
    setNotesPaneModes((current) => {
      if (current?.[activeNotesSplitPane] === editorMode) return current;
      return { ...(current || {}), [activeNotesSplitPane]: editorMode };
    });
  }, [activeNotesSplitPane, editorMode, notesPaneLayout]);

  const setNotesPaneDocument = useCallback((paneId: string, tabId: string, document: NotesPaneDocumentSnapshot) => {
    setNotesPaneDocuments((current) => ({
      ...current,
      [paneId]: {
        ...(current[paneId] || {}),
        [tabId]: document,
      },
    }));
  }, []);

  const syncActiveNotesPaneDocument = useCallback((paneId: string, tab: NotesOpenTab, document: NotesPaneDocumentSnapshot) => {
    if (activeNotesSplitPaneRef.current !== paneId) return;
    if (tab.kind === "empty") {
      selectedNoteIdRef.current = null;
      selectedNoteRef.current = null;
      setActiveEmptyTabId(tab.id);
      setSelectedNoteId(null);
      setSelectedNote(null);
      setEditTitle("");
      setEditContent("");
      setSourceContentDraft(null);
      return;
    }

    // Pane snapshots retain presentation state, not a second document authority.
    // A native merge or another view may have advanced this document while the
    // pane was inactive. Activation must use the same session-scoped latest text
    // as inactive rendering, including an unsaved draft (and an empty string).
    const contentText = realVaultLatestContentRef.current.get(tab.id) ?? document.contentText;
    const existing = notes.find((note) => note.id === tab.id);
    const note = existing
      ? { ...existing, title: document.title, contentText, contentJson: contentText }
      : noteFromKnowledgeDocument(
          { id: tab.id, title: document.title, contentText, source: "real-vault" },
          t("editor.notes.untitled"),
        );
    selectedNoteIdRef.current = tab.id;
    selectedNoteRef.current = note;
    setSelectedNoteId(tab.id);
    setSelectedNote(note);
    setEditTitle(document.title);
    setEditContent(contentText);
    setSourceContentDraft(null);
    if (isRealVaultNoteId(tab.id)) {
      if (!realVaultSavedContentRef.current.has(tab.id)) realVaultSavedContentRef.current.set(tab.id, document.contentText);
      if (!realVaultLatestContentRef.current.has(tab.id)) realVaultLatestContentRef.current.set(tab.id, document.contentText);
    }
    window.dispatchEvent(new CustomEvent("luckyray:notes-active-title", { detail: { title: document.title } }));
    window.dispatchEvent(new CustomEvent("luckyray:notes-active-note", { detail: { noteId: tab.id } }));
  }, [notes, t]);

  const loadNotesPaneDocument = useCallback(async (paneId: string, tab: NotesOpenTab): Promise<boolean> => {
    if (tab.kind === "empty") {
      const empty = { title: t("editor.notes.newTab"), contentText: "", loaded: true };
      setNotesPaneDocument(paneId, tab.id, empty);
      syncActiveNotesPaneDocument(paneId, tab, empty);
      return true;
    }

    const requestId = (notesPaneLoadRequestRef.current.get(paneId) || 0) + 1;
    notesPaneLoadRequestRef.current.set(paneId, requestId);
    // The vault can switch while this read is in flight; a pane request id
    // alone cannot see that (the reset clears the map, but the comparison
    // below would still hold for a request that started AFTER the map was
    // cleared yet BEFORE the vault settled). The session token is the guard.
    const paneSession = vaultSessionRef.current.latest();
    try {
      if (!isRealVaultNoteId(tab.id)) throw new Error(t("editor.notes.status.legacyDbRetired"));
      const document = await realVaultDocumentSource.openDocument(realVaultRelativePathFromNoteId(tab.id));
      if (!vaultSessionRef.current.isCurrent(paneSession)) return false;
      if (notesPaneLoadRequestRef.current.get(paneId) !== requestId) return false;
      const note = noteFromKnowledgeDocument(document, t("editor.notes.untitled"));
      const snapshot = { title: noteTitle(note), contentText: note.contentText || "", loaded: true };
      setNotes((current) => current.some((item) => item.id === note.id)
        ? current.map((item) => item.id === note.id ? { ...item, ...note } : item)
        : [...current, note]);
      setNotesPaneDocument(paneId, tab.id, snapshot);
      syncActiveNotesPaneDocument(paneId, tab, snapshot);
      return true;
    } catch (error) {
      if (!vaultSessionRef.current.isCurrent(paneSession)) return false;
      if (notesPaneLoadRequestRef.current.get(paneId) !== requestId) return false;
      setStatus(error instanceof Error ? error.message : t("editor.notes.status.documentLoadFailed"));
      return false;
    }
  }, [realVaultDocumentSource, setNotesPaneDocument, syncActiveNotesPaneDocument, t]);

  const activateNotesSplitPane = useCallback((paneId: string, tabId?: string, preferredMode?: EditorMode) => {
    const tabs = notesPaneTabs?.[paneId] || [];
    const target = tabId
      ? tabs.find((tab) => tab.id === tabId)
      : tabs.find((tab) => tab.id === notesPaneActiveTabs?.[paneId]) || tabs[0];
    if (!target) return;
    const paneOrTabChanged = activeNotesSplitPane !== paneId
      || (tabId !== undefined && notesPaneActiveTabs?.[paneId] !== target.id);
    const alreadyActiveTarget = !paneOrTabChanged
      && (target.kind === "empty" ? activeEmptyTabId === target.id : selectedNoteId === target.id);
    if (alreadyActiveTarget && preferredMode === undefined) return;
    if (paneOrTabChanged) {
      commitCurrentEditorDraftRef.current();
      flushPendingSaveRef.current();
    }
    if (tabId) setNotesPaneActiveTabs((current) => current ? { ...current, [paneId]: target.id } : current);
    setActiveNotesSplitPane(paneId);
    activeNotesSplitPaneRef.current = paneId;

    if (paneOrTabChanged) setNotesPaneActivationVersion((version) => version + 1);
    const viewMode = notesViewRefsRef.current.get(notesPaneViewsRef.current.get(paneId, target.id))?.mode;
    setEditorMode(preferredMode || viewMode || notesPaneModes?.[paneId] || "live");
    if (preferredMode === "source") setSourceContentDraft(null);
    if (target.kind === "empty") {
      const empty = notesPaneDocuments[paneId]?.[target.id] || { title: t("editor.notes.newTab"), contentText: "", loaded: true };
      setNotesPaneDocument(paneId, target.id, empty);
      syncActiveNotesPaneDocument(paneId, target, empty);
      return;
    }
    const document = notesPaneDocuments[paneId]?.[target.id];
    if (document?.loaded) {
      syncActiveNotesPaneDocument(paneId, target, document);
      return;
    }
    void loadNotesPaneDocument(paneId, target);
  }, [activeEmptyTabId, activeNotesSplitPane, loadNotesPaneDocument, notesPaneActiveTabs, notesPaneDocuments, notesPaneModes, notesPaneTabs, selectedNoteId, setNotesPaneDocument, syncActiveNotesPaneDocument, t]);

  const createNotesSplitPaneTab = useCallback((paneId: string) => {
    const nextTab = createEmptyNoteTab();
    setNotesPaneTabs((current) => current ? { ...current, [paneId]: [...(current[paneId] || []), nextTab] } : current);
    setNotesPaneActiveTabs((current) => current ? { ...current, [paneId]: nextTab.id } : current);
    setNotesPaneDocument(paneId, nextTab.id, { title: t("editor.notes.newTab"), contentText: "", loaded: true });
    setActiveNotesSplitPane(paneId);
    activeNotesSplitPaneRef.current = paneId;
    if (activeNotesSplitPane !== paneId) setNotesPaneActivationVersion((version) => version + 1);
    syncActiveNotesPaneDocument(paneId, nextTab, { title: t("editor.notes.newTab"), contentText: "", loaded: true });
  }, [activeNotesSplitPane, setNotesPaneDocument, syncActiveNotesPaneDocument, t]);

  const setNotesSplitPaneMode = useCallback((paneId: string, mode: EditorMode) => {
    setNotesPaneModes((current) => ({ ...(current || {}), [paneId]: mode }));
    activateNotesSplitPane(paneId, undefined, mode);
  }, [activateNotesSplitPane]);

  const rememberNotesEditorSession = useCallback((paneId: string, snapshot: LiveEditorSessionSnapshot) => {
    const key = `${paneId}:${snapshot.documentId}`;
    const sessions = notesPaneEditorSessionsRef.current;
    sessions.delete(key);
    sessions.set(key, snapshot);
    // A bounded view cache, separate from the unbounded authoritative draft set.
    while (sessions.size > 64) sessions.delete(sessions.keys().next().value!);
  }, []);
  const captureNotesEditorSessions = useCallback(() => {
    if (!notesPaneLayout) {
      const snapshot = liveEditorRef.current?.captureSession();
      if (snapshot) rememberNotesEditorSession("notes-pane-1", snapshot);
      return;
    }
    for (const [paneId, tabs] of Object.entries(notesPaneTabs || {})) for (const tab of tabs) {
      const id = notesPaneViewsRef.current.get(paneId, tab.id);
      const snapshot = notesViewRefsRef.current.get(id)?.live.current?.captureSession();
      if (snapshot) rememberNotesEditorSession(paneId, snapshot);
    }
  }, [notesPaneLayout, notesPaneTabs, rememberNotesEditorSession]);
  const getNotesEditorSession = useCallback((paneId: string, tabId: string) => notesPaneEditorSessionsRef.current.get(`${paneId}:${tabId}`) || null, []);

  const requestNotesSplit = useCallback((direction: NotesSplitDirection, requestedPaneId?: string) => {
    commitCurrentEditorDraftRef.current();
    captureNotesEditorSessions();
    const orientation = direction === "left" || direction === "right" ? "row" : "column";
    const insertBefore = direction === "left" || direction === "up";
    const sourcePaneId = notesPaneLayout ? requestedPaneId || activeNotesSplitPane : "notes-pane-1";
    const sourcePaneMode = notesPaneModes?.[sourcePaneId] || editorMode;
    const sourceTabs = notesPaneLayout
      ? notesPaneTabs?.[sourcePaneId] || []
      : openTabs;
    const currentTab = sourceTabs.find((tab) => tab.id === notesPaneActiveTabs?.[sourcePaneId])
      || activeNotesTab
      || sourceTabs[0]
      || createEmptyNoteTab();
    const baseTabs = sourceTabs.some((tab) => tab.id === currentTab.id)
      ? sourceTabs
      : [...sourceTabs, currentTab];
    notesPaneSequenceRef.current += 1;
    const nextPaneId = `notes-pane-${notesPaneSequenceRef.current}`;
    const nextTab = currentTab.kind === "empty" ? createEmptyNoteTab() : currentTab;
    const editorSession = getNotesEditorSession(sourcePaneId, currentTab.id);
    if (editorSession) rememberNotesEditorSession(nextPaneId, editorSession);
    const nextLeaf: NotesPaneLayout = { kind: "pane", id: nextPaneId };
    const sourceLeaf: NotesPaneLayout = { kind: "pane", id: sourcePaneId };
    const replacement: NotesPaneLayout = {
      kind: "split",
      id: `notes-split-${notesPaneSequenceRef.current}`,
      orientation,
      ratio: .5,
      first: insertBefore ? nextLeaf : sourceLeaf,
      second: insertBefore ? sourceLeaf : nextLeaf,
    };
    setNotesPaneLayout((current) => current ? replaceNotesPane(current, sourcePaneId, replacement) : replacement);
    setNotesPaneTabs((current) => ({
      ...(current || {}),
      [sourcePaneId]: baseTabs,
      [nextPaneId]: [nextTab],
    }));
    setNotesPaneActiveTabs((current) => ({
      ...(current || {}),
      [sourcePaneId]: currentTab.id,
      [nextPaneId]: nextTab.id,
    }));
    setNotesPaneModes((current) => ({
      ...(current || {}),
      [sourcePaneId]: current?.[sourcePaneId] || sourcePaneMode,
      [nextPaneId]: current?.[sourcePaneId] || sourcePaneMode,
    }));
    const sourceDocument = currentTab.id === selectedNoteIdRef.current
      ? { title: editTitle, contentText: readActiveEditorValue(), loaded: true }
      : notesPaneDocuments[sourcePaneId]?.[currentTab.id]
      || {
        title: currentTab.kind === "empty" ? t("editor.notes.newTab") : noteTitle(selectedNote) || t("editor.notes.untitled"),
        contentText: currentTab.kind === "empty" ? "" : editContent,
        loaded: true,
      };
    setNotesPaneDocuments((current) => ({
      ...current,
      [sourcePaneId]: {
        ...(current[sourcePaneId] || {}),
        [currentTab.id]: sourceDocument,
      },
      [nextPaneId]: {
        ...(current[nextPaneId] || {}),
        [nextTab.id]: { ...sourceDocument },
      },
    }));
    setActiveNotesSplitPane(nextPaneId);
    activeNotesSplitPaneRef.current = nextPaneId;
    setNotesPaneActivationVersion((version) => version + 1);
    setEditorMode(sourcePaneMode);
    syncActiveNotesPaneDocument(nextPaneId, nextTab, sourceDocument);
  }, [captureNotesEditorSessions, getNotesEditorSession, rememberNotesEditorSession, activeNotesSplitPane, activeNotesTab, editContent, editTitle, readActiveEditorValue, editorMode, notesPaneActiveTabs, notesPaneDocuments, notesPaneLayout, notesPaneModes, notesPaneTabs, openTabs, selectedNote, syncActiveNotesPaneDocument, t]);

  const closeNotesSplitDocument = useCallback((paneId: string, tabId?: string, committedHandoff=false) => {
    if(!committedHandoff&&notesNativeViews.hasFrozenViews())return;
    captureNotesEditorSessions();
    const paneTabs = notesPaneTabs?.[paneId] || [];
    const closing = tabId
      ? paneTabs.find((tab) => tab.id === tabId)
      : paneTabs.find((tab) => tab.id === notesPaneActiveTabs?.[paneId]) || paneTabs[0];
    if (!closing) return;
    const remaining = paneTabs.filter((tab) => tab.id !== closing.id);
    const paneCount = notesPaneLayout ? countNotesPanes(notesPaneLayout) : 1;
    if (remaining.length) {
      const replacement = remaining.find((tab) => tab.id === notesPaneActiveTabs?.[paneId]) || remaining[remaining.length - 1];
      setNotesPaneTabs((current) => current ? { ...current, [paneId]: remaining } : current);
      setNotesPaneActiveTabs((current) => current ? { ...current, [paneId]: replacement.id } : current);
      if (activeNotesSplitPane === paneId && notesPaneActiveTabs?.[paneId] === closing.id) activateNotesSplitPane(paneId, replacement.id);
      return;
    }
    if (!notesPaneLayout || paneCount <= 1) {
      const fallback = createEmptyNoteTab();
      setNotesPaneTabs((current) => current ? { ...current, [paneId]: [fallback] } : current);
      setNotesPaneActiveTabs((current) => current ? { ...current, [paneId]: fallback.id } : current);
      setActiveNotesSplitPane(paneId);
      showEmptyTab(fallback.id, { ensureOpen: false });
      return;
    }
    const nextLayout = removeNotesPane(notesPaneLayout, paneId);
    if (!nextLayout) return;
    const fallbackPaneId = firstNotesPaneId(nextLayout);
    const fallbackTabs = notesPaneTabs?.[fallbackPaneId] || [];
    const fallbackTab = fallbackTabs.find((tab) => tab.id === notesPaneActiveTabs?.[fallbackPaneId]) || fallbackTabs[0] || createEmptyNoteTab();
    const returnsToSinglePane = nextLayout.kind === "pane";
    setNotesPaneLayout(returnsToSinglePane ? null : nextLayout);
    if (returnsToSinglePane) {
      notesPaneViewsRef.current.remapPane(fallbackPaneId, "notes-pane-1", fallbackTabs);
      for (const tab of fallbackTabs) {
        const session = getNotesEditorSession(fallbackPaneId, tab.id);
        if (session) rememberNotesEditorSession("notes-pane-1", session);
      }
      setNotesPaneTabs(null);
      setNotesPaneActiveTabs(null);
      setNotesPaneModes(null);
      setOpenTabs(fallbackTabs.length ? fallbackTabs : [fallbackTab]);
    } else {
      setNotesPaneTabs((current) => {
        if (!current) return current;
        const { [paneId]: _removed, ...rest } = current;
        return rest;
      });
      setNotesPaneActiveTabs((current) => {
        if (!current) return current;
        const { [paneId]: _removed, ...rest } = current;
        return rest;
      });
      setNotesPaneModes((current) => {
        if (!current) return current;
        const { [paneId]: _removed, ...rest } = current;
        return rest;
      });
      setNotesPaneDocuments((current) => {
        const { [paneId]: _removed, ...rest } = current;
        return rest;
      });
    }
    setActiveNotesSplitPane(returnsToSinglePane ? "notes-pane-1" : fallbackPaneId);
    activeNotesSplitPaneRef.current = returnsToSinglePane ? "notes-pane-1" : fallbackPaneId;
    setEditorMode(notesPaneModes?.[fallbackPaneId] || "live");
    if (fallbackTab.kind === "empty") showEmptyTab(fallbackTab.id, { ensureOpen: false });
    else if (returnsToSinglePane) void selectNote(fallbackTab.id, { scrollList: true, syncGlobalTab: false });
    else {
      const document = notesPaneDocuments[fallbackPaneId]?.[fallbackTab.id];
      if (document?.loaded) syncActiveNotesPaneDocument(fallbackPaneId, fallbackTab, document);
      else void loadNotesPaneDocument(fallbackPaneId, fallbackTab);
    }
  }, [captureNotesEditorSessions, getNotesEditorSession, rememberNotesEditorSession, activateNotesSplitPane, activeNotesSplitPane, loadNotesPaneDocument, notesPaneActiveTabs, notesPaneDocuments, notesPaneLayout, notesPaneModes, notesPaneTabs, selectNote, showEmptyTab, syncActiveNotesPaneDocument]);

  const applyNotesSplitLiveDrag = useCallback((drag: NotesSplitDividerDragState) => {
    const splitRect = drag.splitElement.getBoundingClientRect();
    const { firstSize, ratio } = measureNotesSplitDrag(
      splitRect,
      "row",
      drag.latestClientX,
      drag.latestClientY,
    );

    drag.rect = splitRect;
    drag.lastRatio = ratio;
    drag.hasLiveUpdate = true;
    drag.liveRoot?.style.setProperty(NOTES_SPLIT_LIVE_FIRST_TRACK, `${firstSize}px`);
  }, []);

  const scheduleNotesSplitLiveDrag = useCallback(() => {
    const drag = notesSplitDividerDragRef.current;
    if (!drag?.liveTitlebar || !drag.hasPointerMove || drag.frameId !== null) return;
    drag.frameId = window.requestAnimationFrame(() => {
      const current = notesSplitDividerDragRef.current;
      if (current !== drag) return;
      current.frameId = null;
      applyNotesSplitLiveDrag(current);
    });
  }, [applyNotesSplitLiveDrag]);

  const startNotesSplitDividerDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>, splitId: string, orientation: "row" | "column") => {
    event.preventDefault();
    event.stopPropagation();
    const splitElement = event.currentTarget.parentElement;
    const rect = splitElement?.getBoundingClientRect();
    if (!(splitElement instanceof HTMLDivElement) || !rect) return;
    const titlebarRow = getNotesTitlebarRow(notesPaneLayout);
    const mapsTitlebar = orientation === "row" && titlebarRow?.id === splitId;
    const liveRoot = mapsTitlebar ? splitElement.closest<HTMLElement>(".react-nav-shell") : null;
    const liveTitlebar = mapsTitlebar && Boolean(liveRoot);
    const drag: NotesSplitDividerDragState = {
      splitId,
      orientation,
      rect,
      pointerId: event.pointerId,
      liveTitlebar,
      splitElement,
      liveRoot,
      latestClientX: event.clientX,
      latestClientY: event.clientY,
      lastRatio: titlebarRow?.ratio ?? .5,
      frameId: null,
      resizeObserver: null,
      hasPointerMove: false,
      hasLiveUpdate: false,
    };
    notesSplitDividerDragRef.current = drag;
    if (liveTitlebar && typeof ResizeObserver !== "undefined") {
      drag.resizeObserver = new ResizeObserver(scheduleNotesSplitLiveDrag);
      drag.resizeObserver.observe(splitElement);
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [notesPaneLayout, scheduleNotesSplitLiveDrag]);

  const updateNotesSplitDividerDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = notesSplitDividerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.latestClientX = event.clientX;
    drag.latestClientY = event.clientY;
    drag.hasPointerMove = true;
    if (drag.liveTitlebar) {
      scheduleNotesSplitLiveDrag();
      return;
    }
    const { ratio } = measureNotesSplitDrag(
      drag.rect,
      drag.orientation,
      drag.latestClientX,
      drag.latestClientY,
    );
    setNotesPaneLayout((current) => current ? updateNotesSplitRatio(current, drag.splitId, ratio) : current);
  }, [scheduleNotesSplitLiveDrag]);

  const endNotesSplitDividerDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = notesSplitDividerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.liveTitlebar && drag.frameId !== null) {
      window.cancelAnimationFrame(drag.frameId);
      drag.frameId = null;
      applyNotesSplitLiveDrag(drag);
    }
    drag.resizeObserver?.disconnect();
    notesSplitDividerDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag.liveTitlebar && drag.hasLiveUpdate) {
      setNotesPaneLayout((current) => current ? updateNotesSplitRatio(current, drag.splitId, drag.lastRatio) : current);
    }
  }, [applyNotesSplitLiveDrag]);

  useEffect(() => () => {
    const drag = notesSplitDividerDragRef.current;
    if (drag?.frameId != null) window.cancelAnimationFrame(drag.frameId);
    drag?.resizeObserver?.disconnect();
    drag?.liveRoot?.style.removeProperty(NOTES_SPLIT_LIVE_FIRST_TRACK);
  }, []);

  const notesTitlebarSplit = useMemo<NotesTitlebarSplit | null>(() => {
    const titlebarRow = getNotesTitlebarRow(notesPaneLayout);
    const titlebarPaneId = getNotesTitlebarPaneId(notesPaneLayout);
    if (!notesPaneLayout || notesPaneLayout.kind !== "split") return null;
    const describeTab = (tab: NotesOpenTab): NotesTitlebarPane["tabs"][number] => {
      if (tab.kind === "empty") return { id: tab.id, kind: "empty", title: t("editor.notes.newTab") };
      const loaded = notes.find((note) => note.id === tab.id);
      if (loaded) return { id: tab.id, kind: "note", title: noteTitle(loaded) };
      const indexed = realVaultMarkdownIndex?.documents.find((document) => realVaultNoteId(document.relativePath) === tab.id);
      return {
        id: tab.id,
        kind: "note",
        title: markdownTitleFromPath(indexed?.relativePath || realVaultRelativePathFromNoteId(tab.id), t("editor.notes.untitled")),
      };
    };
    const describePane = (paneId: string): NotesTitlebarPane => {
      const tabs = notesPaneTabs?.[paneId] || [];
      const fallback = tabs[0] || createEmptyNoteTab();
      const activeId = notesPaneActiveTabs?.[paneId] || fallback.id;
      return { activeId, tabs: (tabs.length ? tabs : [fallback]).map(tab=>({...describeTab(tab),viewId:tab.kind!=="empty"?notesPaneViewsRef.current.get(paneId,tab.id):undefined})) };
    };
    const titlebarRootPaneId = titlebarRow
      ? firstNotesPaneId(titlebarRow.first)
      : firstNotesPaneId(notesPaneLayout.first);
    return {
      ratio: titlebarRow?.ratio ?? notesPaneLayout.ratio,
      indexOpen: panelOpen,
      indexWidth: visibleNotesIndexWidth,
      rootPaneId: titlebarRootPaneId,
      paneId: titlebarPaneId,
      activePaneId: activeNotesSplitPane,
      root: describePane(titlebarRootPaneId),
      pane: titlebarPaneId ? describePane(titlebarPaneId) : null,
    };
  }, [activeNotesSplitPane, notes, visibleNotesIndexWidth, notesPaneActiveTabs, notesPaneLayout, notesPaneTabs, panelOpen, realVaultMarkdownIndex, t]);

  useEffect(() => {
    if (notesSplitDividerDragRef.current?.liveTitlebar) return;
    window.dispatchEvent(new CustomEvent(NOTES_TITLEBAR_SPLIT_EVENT, { detail: notesTitlebarSplit }));
  }, [notesTitlebarSplit]);

  useEffect(() => () => {
    window.dispatchEvent(new CustomEvent(NOTES_TITLEBAR_SPLIT_EVENT, { detail: null }));
  }, []);

  const refreshCurrentSourceManually = useCallback(async () => {
    if (knowledgeStorageMode !== "real-vault") {
      await loadNotes();
      setStatus(t("editor.notes.status.knowledgeRefreshed"));
      return;
    }

    const currentId = selectedNoteIdRef.current;
    const currentIsRealVault = Boolean(currentId && isRealVaultNoteId(currentId));
    const previousNote = currentIsRealVault ? selectedNoteRef.current : null;
    const previousUpdatedAt = previousNote?.id === currentId ? previousNote.updatedAt : null;
    const source = readActiveKnowledgeWriteSource();
    const wasDirty = currentId ? realVaultUserDirtyRef.current.has(currentId) : false;
    const result = await loadRealVaultTree();
    if (!result || source !== readActiveKnowledgeWriteSource() || selectedNoteIdRef.current !== currentId) return;

    if (!currentIsRealVault || !currentId) {
      setStatus(t("editor.notes.status.vaultRefreshed"));
      return;
    }

    if (!result.noteIds.has(currentId)) {
      realVaultSavedContentRef.current.delete(currentId);
      realVaultLatestContentRef.current.delete(currentId);
      realVaultUserDirtyRef.current.delete(currentId);
      setStatus(t("editor.notes.status.documentMissing"));
      return;
    }

    const relativePath = normalizeVaultRelativePath(realVaultRelativePathFromNoteId(currentId));
    const indexedDocument = result.index?.documents?.find((document) => (
      normalizeVaultRelativePath(document.relativePath) === relativePath
    ));
    const diskChanged = Boolean(indexedDocument?.mtime && previousUpdatedAt && indexedDocument.mtime !== previousUpdatedAt);

    const pendingDraft = pendingPatchNoteIdRef.current === currentId && Object.keys(pendingPatchRef.current).length > 0;
    if (wasDirty || realVaultUserDirtyRef.current.has(currentId) || pendingDraft) {
      setStatus(diskChanged ? t("editor.notes.status.diskConflict") : t("editor.notes.status.vaultRefreshedDirty"));
      return;
    }

    const reloaded = await reloadCurrentRealVaultDocumentFromDisk(currentId);
    if (reloaded) {
      setStatus(diskChanged ? t("editor.notes.status.diskReloaded") : t("editor.notes.status.vaultRefreshed"));
    }
  }, [knowledgeStorageMode, loadNotes, loadRealVaultTree, reloadCurrentRealVaultDocumentFromDisk, t]);

  const checkCurrentRealVaultExternalChange = useCallback(async (options?: { force?: boolean; silent?: boolean }) => {
    if (knowledgeStorageMode !== "real-vault") return;
    const noteId = selectedNoteIdRef.current;
    const source = readActiveKnowledgeWriteSource();
    if (!source || !noteId || !isRealVaultNoteId(noteId)) return;
    const now = Date.now();
    if (!options?.force && now - realVaultLastExternalCheckAtRef.current < 3000) return;
    realVaultLastExternalCheckAtRef.current = now;
    const isCurrent = () => source === readActiveKnowledgeWriteSource() && selectedNoteIdRef.current === noteId;
    return realVaultDocumentReadsRef.current.requestExternalCheck(async () => {
      if (!isCurrent() || realVaultSavedContentRef.current.get(noteId) === undefined) return;
      const relativePath = normalizeVaultRelativePath(realVaultRelativePathFromNoteId(noteId));
      try {
        const baselineBeforeRead = realVaultSavedContentRef.current.get(noteId);
        const latestDocument = await realVaultDocumentSource.openDocument(relativePath);
        if (!isCurrent()) return;
        const latestContent = latestDocument.contentText || "";
        const latestBaseline = realVaultSavedContentRef.current.get(noteId);
        // A watcher read can capture the old disk contents just before our save
        // completes. That self echo cannot become a conflict or a disk reload.
        if (baselineBeforeRead !== latestBaseline && latestContent === baselineBeforeRead) return;
        if (latestBaseline === undefined || latestContent === latestBaseline) {
          setRealVaultExternalConflict((current) => current?.noteId === noteId ? null : current);
          return;
        }

        const hasPendingPatch = pendingPatchNoteIdRef.current === noteId && Object.keys(pendingPatchRef.current).length > 0;
        const dirty = realVaultUserDirtyRef.current.has(noteId) || hasPendingPatch;
        if (dirty) {
          if (!realVaultKeepEditingAfterConflictRef.current.has(noteId)) {
            setRealVaultExternalConflict({ noteId, detectedAt: Date.now() });
            setStatus(t("editor.notes.status.diskChanged"));
          }
          return;
        }

        const reloaded = await reloadCurrentRealVaultDocumentFromDisk(noteId);
        if (isCurrent() && reloaded && !options?.silent) setStatus(t("editor.notes.status.diskLoaded"));
      } catch (error) {
        if (!isCurrent()) return;
        console.warn("[NotesPage] check real vault external change failed", error);
        const snapshot = knowledgeStore.getSnapshot();
        const stillExists = snapshot.mode === "real-vault" && snapshot.markdownIndex?.documents.some((document) => (
          normalizeVaultRelativePath(document.relativePath) === relativePath
        ));
        if (!stillExists) {
          realVaultSavedContentRef.current.delete(noteId);
          realVaultLatestContentRef.current.delete(noteId);
          realVaultUserDirtyRef.current.delete(noteId);
          realVaultKeepEditingAfterConflictRef.current.delete(noteId);
          setRealVaultExternalConflict((current) => current?.noteId === noteId ? null : current);
          setStatus(t("editor.notes.status.documentMissing"));
        }
      }
    });
  }, [knowledgeStorageMode, realVaultDocumentSource, reloadCurrentRealVaultDocumentFromDisk, t]);

  useEffect(() => {
    const syncFromStore = () => {
      const snapshot = knowledgeStore.getSnapshot();
      if (snapshot.status !== "ready") return;
      if (
        snapshot.mode !== "real-vault"
        || !snapshot.vault
        || !snapshot.markdownIndex
        || knowledgeStorageMode !== "real-vault"
        || currentVault?.id !== snapshot.vault.id
      ) {
        realVaultStoreVersionRef.current = { vaultId: null, snapshotVersion: 0, indexVersion: 0 };
        return;
      }

      const previous = realVaultStoreVersionRef.current;
      const indexVersion = snapshot.markdownIndex.version || 0;
      const sameSnapshot = previous.vaultId === snapshot.vault.id && previous.snapshotVersion === snapshot.version;
      if (sameSnapshot) return;
      const currentId = selectedNoteIdRef.current;
      const relativePath = currentId && isRealVaultNoteId(currentId)
        ? normalizeVaultRelativePath(realVaultRelativePathFromNoteId(currentId))
        : null;
      const changedPaths = new Set((snapshot.markdownIndex.changedPaths || []).map(normalizeVaultRelativePath));
      const removedPaths = new Set((snapshot.markdownIndex.removedPaths || []).map(normalizeVaultRelativePath));
      const decision = decideRealVaultIndexDelta({
        previousVaultId: previous.vaultId,
        previousIndexVersion: previous.indexVersion,
        currentVaultId: snapshot.vault.id,
        currentIndexVersion: indexVersion,
        currentPath: relativePath,
        changedPaths,
        removedPaths,
      });
      realVaultStoreVersionRef.current = {
        vaultId: snapshot.vault.id,
        snapshotVersion: snapshot.version,
        indexVersion,
      };

      applyRealVaultStoreSnapshot(snapshot.tree, snapshot.markdownIndex, snapshot.vault.id);
      if (!currentId) return;
      if (decision === "removed") {
        realVaultSavedContentRef.current.delete(currentId);
        realVaultLatestContentRef.current.delete(currentId);
        realVaultUserDirtyRef.current.delete(currentId);
        realVaultKeepEditingAfterConflictRef.current.delete(currentId);
        setRealVaultExternalConflict((current) => current?.noteId === currentId ? null : current);
        setStatus(t("editor.notes.status.documentMissing"));
        return;
      }
      if (decision === "changed" || decision === "verify-gap") {
        void checkCurrentRealVaultExternalChange({ force: true, silent: true });
      }
    };

    const unsubscribe = knowledgeStore.subscribe(syncFromStore);
    syncFromStore();
    return () => {
      unsubscribe();
    };
  }, [applyRealVaultStoreSnapshot, checkCurrentRealVaultExternalChange, currentVault?.id, knowledgeStorageMode, t]);

  const reloadRealVaultConflictFromDisk = useCallback(() => {
    const noteId = realVaultExternalConflict?.noteId;
    if (!noteId || !isRealVaultNoteId(noteId)) return;
    if (pendingPatchNoteIdRef.current === noteId) {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      pendingPatchRef.current = {};
      pendingPatchNoteIdRef.current = null;
    }
    realVaultUserDirtyRef.current.delete(noteId);
    realVaultKeepEditingAfterConflictRef.current.delete(noteId);
    setRealVaultExternalConflict(null);
    void (async () => {
      await refreshRealVaultMarkdownIndex(currentVault);
      const reloaded = await reloadCurrentRealVaultDocumentFromDisk(noteId);
      if (reloaded) setStatus(t("editor.notes.status.diskReloaded"));
    })();
  }, [currentVault, realVaultExternalConflict, refreshRealVaultMarkdownIndex, reloadCurrentRealVaultDocumentFromDisk, t]);

  const keepRealVaultConflictEdit = useCallback(() => {
    const noteId = realVaultExternalConflict?.noteId;
    if (noteId) realVaultKeepEditingAfterConflictRef.current.add(noteId);
    setRealVaultExternalConflict(null);
    setStatus(t("editor.notes.status.keptCurrentEdit"));
  }, [realVaultExternalConflict, t]);

  const focusCurrentNoteAnchor = useCallback((options?: NoteOpenOptions | null) => {
    if (!options?.blockId && !options?.headingPath) return false;

    if (editorMode === "preview") {
      if (options.blockId) {
        setPendingBlockId(options.blockId);
        setPendingHeadingPath(null);
      } else {
        setPendingHeadingPath(options.headingPath || null);
        setPendingBlockId(null);
      }
      return true;
    }

    const currentContent = readActiveEditorValue();
    const anchor = findSameNoteAnchorRange(currentContent, options);
    if (!anchor) {
      setStatus(options.blockId ? t("editor.notes.status.blockNotFound", { block: options.blockId }) : t("editor.notes.status.headingNotFound", { heading: options.headingPath || "" }));
      return true;
    }

    window.setTimeout(() => {
      setActiveEditorSelection({ start: anchor.from, end: anchor.to });
      if (editorMode === "source") {
        const textarea = textareaRef.current;
        if (textarea) textarea.scrollTop = Math.max(0, (anchor.line - 1) * 24 - textarea.clientHeight / 3);
      }
      setStatus(anchor.kind === "block" ? t("editor.notes.status.blockLocated", { block: anchor.label }) : t("editor.notes.status.headingLocated", { heading: anchor.label }));
    }, 0);
    return true;
  }, [editorMode, readActiveEditorValue, setActiveEditorSelection, t]);

  const openNoteFromInlineLink = useCallback((noteId: string, options?: NoteOpenOptions) => {
    const anchored = Boolean(options?.blockId || options?.headingPath);
    if (anchored && noteId === selectedNoteId && focusCurrentNoteAnchor(options)) return;
    void selectNote(noteId, {
      focusEditor: !anchored,
      scrollList: true,
      blockId: options?.blockId,
      headingPath: options?.headingPath,
      anchorInEditor: anchored && editorMode !== "preview",
    });
  }, [editorMode, focusCurrentNoteAnchor, selectNote, selectedNoteId]);

  const updateNoteLocal = useCallback((noteId: string, patch: Partial<Note>) => {
    setNotes((current) => current.map((note) => note.id === noteId ? { ...note, ...patch } : note));
    setSelectedNote((current) => current?.id === noteId ? { ...current, ...patch } : current);
  }, []);

  const writeRealVaultDocumentIfAllowed = useCallback(async (
    reason: RealVaultWriteReason,
    document: { id: string; relativePath?: string },
    contentText: string,
  ) => {
    const source = readActiveKnowledgeWriteSource();
    if (reason !== "explicit-save" && reason !== "user-edit-autosave" && reason !== "create-missing-link") {
      return null;
    }
    const relativePath = document.relativePath || document.id;
    const noteId = realVaultNoteId(relativePath);
    let writeDocument: { id: string; relativePath?: string; revision?: string } = document;
    if (reason !== "create-missing-link") {
      try {
        const latestDocument = await realVaultDocumentSource.openDocument(relativePath);
        writeDocument = latestDocument;
        if (!source || readActiveKnowledgeWriteSource() !== source) return null;
        const baselineContent = realVaultSavedContentRef.current.get(noteId);
        const latestContent = latestDocument.contentText || "";
        if (
          baselineContent !== undefined
          && latestContent !== baselineContent
        ) {
          if (selectedNoteIdRef.current === noteId) {
            realVaultKeepEditingAfterConflictRef.current.delete(noteId);
            setRealVaultExternalConflict({ noteId, detectedAt: Date.now() });
            setStatus(t("editor.notes.status.diskRefreshRequired"));
          }
          return null;
        }
      } catch (error) {
        console.warn("[NotesPage] real vault save preflight failed", error);
        if (selectedNoteIdRef.current === noteId) {
          setStatus(t("editor.notes.status.diskStateInvalid"));
        }
        return null;
      }
    }
    if (!source || readActiveKnowledgeWriteSource() !== source) return null;
    try {
      return await realVaultDocumentSource.saveDocument(writeDocument, contentText);
    } catch (error) {
      if ((error as { code?: string })?.code !== "knowledge-revision-conflict") throw error;
      realVaultUserDirtyRef.current.add(noteId);
      if (selectedNoteIdRef.current === noteId) {
        realVaultKeepEditingAfterConflictRef.current.delete(noteId);
        setRealVaultExternalConflict({ noteId, detectedAt: Date.now() });
        setStatus(t("editor.notes.status.diskRefreshRequired"));
      }
      return null;
    }
  }, [realVaultDocumentSource, t]);

  const savePatch = useCallback(async (patch: { title?: string; contentText?: string }, noteIdOverride?: string | null, reason: RealVaultWriteReason = "user-edit-autosave") => {
    const noteId = noteIdOverride || selectedNoteIdRef.current;
    if (!noteId) return;
    const requestId = saveRequestRef.current + 1;
    saveRequestRef.current = requestId;
    let realVaultSaveLocked = false;
    let realVaultWriteSucceeded = false;
    let completeRealVaultSave: (() => void) | undefined;
    let completion: Promise<void> | undefined;
    const source = readActiveKnowledgeWriteSource();
    setSaving(true);
    try {
      if (isRealVaultNoteId(noteId)) {
        const relativePath = realVaultRelativePathFromNoteId(noteId);
        const isCurrentRealVaultNote = selectedNoteIdRef.current === noteId;
        if (realVaultDocumentReadsRef.current.isHydrating(noteId)) {
          return;
        }
        const contentText = patch.contentText ?? (isCurrentRealVaultNote ? selectedNote?.contentText ?? editContent : undefined);
        if (contentText === undefined) return;
        const queueLatestRealVaultAutosave = (latestContent: string) => {
          const savedContent = realVaultSavedContentRef.current.get(noteId);
          if (latestContent === savedContent) return;
          realVaultLatestContentRef.current.set(noteId, latestContent);
          realVaultUserDirtyRef.current.add(noteId);
          // The owner drains its latest draft after the write completes. Never
          // replace the active note's debounce slot with a different note.
        };
        if (realVaultSaveInFlightRef.current.has(noteId)) {
          queueLatestRealVaultAutosave(contentText);
          return;
        }
        const hasUserDirtyContent = realVaultUserDirtyRef.current.has(noteId);
        if (!hasUserDirtyContent) {
          if (patch.title !== undefined) {
            updateNoteLocal(noteId, { title: patch.title });
          }
          return;
        }
        const savedContent = realVaultSavedContentRef.current.get(noteId);
        if (savedContent !== undefined && contentText === savedContent) {
          const latestContent = realVaultLatestContentRef.current.get(noteId);
          if (latestContent !== undefined && latestContent !== contentText) {
            queueLatestRealVaultAutosave(latestContent);
            return;
          }
          // Ctrl+S can mark an already acknowledged document dirty. There is
          // no write to await here; publish the real clean transition without
          // clearing a newer queued draft or another document's dirty state.
          realVaultUserDirtyRef.current.delete(noteId);
          if (patch.title !== undefined) {
            updateNoteLocal(noteId, { title: patch.title });
            if (selectedNoteIdRef.current === noteId) {
              window.dispatchEvent(new CustomEvent("luckyray:notes-active-title", { detail: { title: patch.title || t("editor.notes.untitled") } }));
            }
          }
          if (selectedNoteIdRef.current === noteId && reason === "explicit-save") setStatus(t("editor.notes.saved"));
          return;
        }
        realVaultSaveInFlightRef.current.add(noteId);
        completion = new Promise<void>(resolve => { completeRealVaultSave = resolve; });
        realVaultSaveCompletionRef.current.set(noteId, completion);
        realVaultSaveLocked = true;
        const savedDocument = await writeRealVaultDocumentIfAllowed(reason, { id: relativePath, relativePath }, contentText);
        if (!source || readActiveKnowledgeWriteSource() !== source) return;
        if (!savedDocument) return;
        realVaultWriteSucceeded = true;
        if (selectedNoteIdRef.current === noteId) setStatus(current =>
          (["editor.notes.status.saveFailed", "editor.notes.status.diskStateInvalid"] as const).some(key => current === t(key)) ? "" : current);
        // Saving updates shared attachment candidates even if focus moved to
        // another note while the write was pending.
        void knowledgeStore.invalidate({ reason: "notes-save", modifiedPaths: [relativePath] });
        const savedNote = noteFromKnowledgeDocument(savedDocument, t("editor.notes.untitled"));
        realVaultSavedContentRef.current.set(noteId, contentText);
        const latestContent = realVaultLatestContentRef.current.get(noteId);
        const hasNewerEditorContent = latestContent !== undefined && latestContent !== contentText;
        if (hasNewerEditorContent) {
          queueLatestRealVaultAutosave(latestContent);
          return;
        }
        realVaultLatestContentRef.current.set(noteId, contentText);
        realVaultUserDirtyRef.current.delete(noteId);
        realVaultKeepEditingAfterConflictRef.current.delete(noteId);
        setRealVaultExternalConflict((current) => current?.noteId === noteId ? null : current);
        const localPatch: Partial<Note> = {
          ...savedNote,
          title: patch.title !== undefined ? patch.title : savedNote.title,
          contentText,
          contentJson: contentText,
        };
        updateNoteLocal(noteId, localPatch);
        if (selectedNoteIdRef.current !== noteId) return;
        if (patch.title !== undefined) {
          window.dispatchEvent(new CustomEvent("luckyray:notes-active-title", { detail: { title: patch.title || t("editor.notes.untitled") } }));
        }
        if (reason === "explicit-save") setStatus(t("editor.notes.saved"));
        return;
      }

      if (!bridge?.updateNote) return;
      const saved = await bridge.updateNote(noteId, patch);
      const updatedAt = saved?.updatedAt || new Date().toISOString();
      updateNoteLocal(noteId, { ...patch, updatedAt });
      if (selectedNoteIdRef.current !== noteId) return;
      if (patch.title !== undefined) {
        window.dispatchEvent(new CustomEvent("luckyray:notes-active-title", { detail: { title: patch.title || t("editor.notes.untitled") } }));
      }
      if (patch.title !== undefined || patch.contentText !== undefined) {
        void loadNoteRelations(noteId);
      }
      if (reason === "explicit-save") setStatus(t("editor.notes.saved"));
    } catch (error) {
      console.warn("[NotesPage] updateNote failed", error);
      if (selectedNoteIdRef.current === noteId) setStatus(t("editor.notes.status.saveFailed"));
    } finally {
      if (realVaultSaveLocked && isRealVaultNoteId(noteId)) {
        if (realVaultSaveCompletionRef.current.get(noteId) === completion) {
          realVaultSaveInFlightRef.current.delete(noteId);
          realVaultSaveCompletionRef.current.delete(noteId);
        }
        completeRealVaultSave?.();
        const latest = realVaultLatestContentRef.current.get(noteId);
        if (realVaultWriteSucceeded && source === readActiveKnowledgeWriteSource()
          && realVaultUserDirtyRef.current.has(noteId) && latest !== undefined
          && latest !== realVaultSavedContentRef.current.get(noteId)) {
          void savePatch({ contentText: latest }, noteId, "user-edit-autosave");
        }
      }
      if (saveRequestRef.current === requestId) setSaving(false);
    }
  }, [bridge, editContent, loadNoteRelations, refreshRealVaultMarkdownIndex, selectedNote, selectedNoteId, updateNoteLocal, writeRealVaultDocumentIfAllowed, t]);

  const attachmentPathsAreDirty = useCallback((paths: string[]) => paths.some(path => {
    const id = realVaultNoteId(path);
    return realVaultUserDirtyRef.current.has(id) || realVaultSaveInFlightRef.current.has(id);
  }), []);
  const saveAffectedAttachmentNotes = useCallback(async (paths: string[]) => {
    const source = readActiveKnowledgeWriteSource();
    const requireCurrent = () => {if (!source || readActiveKnowledgeWriteSource() !== source) throw new Error("知识库会话已变化，请重新检查引用");};
    requireCurrent();
    commitCurrentEditorDraftRef.current();
    for (const path of paths) {
      const id = realVaultNoteId(path);
      await realVaultSaveCompletionRef.current.get(id);
      requireCurrent();
      if (realVaultUserDirtyRef.current.has(id)) {
        const text = realVaultLatestContentRef.current.get(id);
        if (text === undefined) throw new Error("笔记草稿尚未准备好，请保存后重试");
        await savePatch({contentText: text}, id);
        requireCurrent();
        await realVaultSaveCompletionRef.current.get(id);
        requireCurrent();
      }
    }
    if (attachmentPathsAreDirty(paths)) throw new Error("笔记尚未保存成功，引用更新已暂停");
  }, [savePatch, attachmentPathsAreDirty]);
  const refreshAffectedAttachmentNotes = useCallback(async (paths: string[]) => {
    const source = readActiveKnowledgeWriteSource();
    const isCurrent = () => source && readActiveKnowledgeWriteSource() === source;
    if (!isCurrent()) return;
    const refreshed = await knowledgeStore.invalidate({reason: "external-attachment-reference-update"});
    if (!isCurrent()) return;
    if (refreshed.status !== 'ready') throw new Error('引用已处理，但笔记索引暂未刷新成功，请重新检查以显示最新内容。');
    for (const path of paths) {
      if (!isCurrent()) return;
      const id = realVaultNoteId(path);
      if (attachmentPathsAreDirty([path])) {
        setRealVaultExternalConflict({noteId:id, detectedAt:Date.now()}); continue;
      }
      const document = await realVaultDocumentSource.openDocument(path);
      if (!isCurrent()) return;
      if (attachmentPathsAreDirty([path])) {setRealVaultExternalConflict({noteId:id, detectedAt:Date.now()});continue;}
      const note = noteFromKnowledgeDocument(document, t("editor.notes.untitled"));
      realVaultSavedContentRef.current.set(id,note.contentText);
      realVaultLatestContentRef.current.set(id,note.contentText);
      updateNoteLocal(id,note);
      syncNotesPaneDocumentAcrossPanes(id,{title:note.title,contentText:note.contentText,loaded:true});
      if (selectedNoteIdRef.current === id) {
        selectedNoteRef.current=note;setSelectedNote(note);setEditContent(note.contentText);setSourceContentDraft(null);
      }
    }
  }, [currentVault?.id,attachmentPathsAreDirty,realVaultDocumentSource,updateNoteLocal,syncNotesPaneDocumentAcrossPanes,t]);
  useEffect(() => {
    const source = readActiveKnowledgeWriteSource();
    if (!source || !currentVault || source.vaultId !== currentVault.id) return;
    return registerAttachmentDraftSession({ vaultId: currentVault.id, source, save: saveAffectedAttachmentNotes, dirty: attachmentPathsAreDirty, refresh: refreshAffectedAttachmentNotes });
  }, [currentVault, saveAffectedAttachmentNotes, attachmentPathsAreDirty, refreshAffectedAttachmentNotes]);
  const attachmentRelinkRequest = useSyncExternalStore(subscribeAttachmentRelinkRequest, readAttachmentRelinkRequest, readAttachmentRelinkRequest);
  const externalAttachmentFlow = useVaultAttachmentChanges({vault:currentVault, batch:knowledgeSnapshot.attachmentChanges,
    saveAffected:saveAffectedAttachmentNotes,isDirty:attachmentPathsAreDirty,refreshAffected:refreshAffectedAttachmentNotes,recheckAttachments});

  const refreshExternalNote = useCallback(async (noteId: string) => {
    if (!noteId || !bridge?.getNote) return;
    const note = await bridge.getNote(noteId).catch(() => null);
    if (!note) return;

    setNotes((current) => current.map((item) => item.id === noteId ? note : item));
    syncNotesPaneDocumentAcrossPanes(noteId, {
      title: noteTitle(note),
      contentText: note.contentText || "",
      loaded: true,
    });
    if (noteId !== selectedNoteId) return;

    const hasPendingLocalSave = saving || Object.keys(pendingPatchRef.current).length > 0;
    const activeContent = readActiveEditorValue();
    if (hasPendingLocalSave || activeContent !== editContent) {
      setStatus(t("editor.notes.status.externalUpdate"));
      return;
    }

    setSelectedNote(note);
    setEditTitle(note.title || "");
    setEditContent(note.contentText || "");
    setSourceContentDraft(null);
    await loadNoteRelations(noteId);
    window.dispatchEvent(new CustomEvent("luckyray:notes-active-title", { detail: { title: noteTitle(note) } }));
  }, [bridge, editContent, loadNoteRelations, readActiveEditorValue, saving, selectedNoteId, syncNotesPaneDocumentAcrossPanes, t]);

  const scheduleSave = useCallback((patch: { title?: string; contentText?: string }) => {
    const targetNoteId = selectedNoteIdRef.current;
    if (targetNoteId && isRealVaultNoteId(targetNoteId) && patch.contentText !== undefined) {
      realVaultLatestContentRef.current.set(targetNoteId, patch.contentText);
    }
    pendingPatchNoteIdRef.current = targetNoteId;
    pendingPatchRef.current = { ...pendingPatchRef.current, ...patch };
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const delay = targetNoteId && isRealVaultNoteId(targetNoteId) ? 1600 : 650;
    saveTimerRef.current = setTimeout(() => {
      const targetNoteId = pendingPatchNoteIdRef.current;
      const nextPatch = pendingPatchRef.current;
      pendingPatchRef.current = {};
      pendingPatchNoteIdRef.current = null;
      void savePatch(nextPatch, targetNoteId);
    }, delay);
  }, [savePatch]);

  const flushPendingSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const targetNoteId = pendingPatchNoteIdRef.current || selectedNoteIdRef.current;
    const nextPatch = pendingPatchRef.current;
    pendingPatchRef.current = {};
    pendingPatchNoteIdRef.current = null;
    if (Object.keys(nextPatch).length) void savePatch(nextPatch, targetNoteId);
  }, [savePatch]);

  const flushPendingSaveForNotesInline = useCallback(async (selectionOverride?: { start: number; end: number } | null) => {
    const note = selectedNoteRef.current;
    const noteId = selectedNoteIdRef.current;
    if (!note || !noteId || !isRealVaultNoteId(noteId)) {
      throw new Error(t("editor.notes.error.aiRequiresLiveNote"));
    }
    const content = readActiveEditorValue();
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    pendingPatchRef.current = {};
    pendingPatchNoteIdRef.current = null;
    realVaultLatestContentRef.current.set(noteId, content);
    if (realVaultSavedContentRef.current.get(noteId) !== content) {
      realVaultUserDirtyRef.current.add(noteId);
    }
    const deadline = performance.now() + 5_000;
    while (true) {
      await savePatch({ contentText: content }, noteId, "explicit-save");
      if (
        !realVaultSaveInFlightRef.current.has(noteId)
        && realVaultSavedContentRef.current.get(noteId) === content
        && !realVaultUserDirtyRef.current.has(noteId)
      ) break;
      if (performance.now() >= deadline) throw new Error(t("editor.notes.error.savePending"));
      await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
    }
    const documentRef = resolveKnowledgeDocumentRef({ id: noteId, title: noteTitle(note) });
    if (!documentRef || !activeContextPublisherRef.current) {
      throw new Error(t("editor.notes.error.contextNotReady"));
    }
    const selection = selectionOverride ?? readActiveEditorSelection();
    await activeContextPublisherRef.current.write({
      noteId,
      documentRef,
      expectedRevision: null,
      cursorOffset: selection.start,
      selection: selection.start === selection.end ? null : content.slice(selection.start, selection.end),
    });
    return { noteId, content, selection };
  }, [readActiveEditorSelection, readActiveEditorValue, savePatch, t]);

  useEffect(() => {
    flushPendingSaveRef.current = flushPendingSave;
  }, [editTitle, flushPendingSave, readActiveEditorValue, savePatch, t]);

  const handleTitleChange = useCallback((value: string) => {
    setEditTitle(value);
    if (selectedNoteId) updateNoteLocal(selectedNoteId, { title: value });
    window.dispatchEvent(new CustomEvent("luckyray:notes-active-title", { detail: { title: value || t("editor.notes.untitled") } }));
    if (selectedNoteId && isRealVaultNoteId(selectedNoteId)) return;
    scheduleSave({ title: value });
  }, [scheduleSave, selectedNoteId, updateNoteLocal, t]);

  const buildAutocompleteItems = useCallback((kind: AutocompleteKind, query: string): AutocompleteItem[] => {
    const parsedAnchorQuery = kind === "anchor" ? parseWikiAnchorQuery(query) : null;
    const q = kind === "note"
      ? wikiNoteSearchPart(query)
      : kind === "anchor"
        ? sameNoteAnchorSearchQuery(parsedAnchorQuery?.anchorQuery || query)
        : query.trim();
    const takeSorted = <T extends { label: string }>(items: T[]) => items
      .map((item) => ({ item, score: scoreAutocompleteLabel(item.label, q) }))
      .filter(({ score }) => score < 1000)
      .sort((a, b) => a.score - b.score || a.item.label.localeCompare(b.item.label, "zh-CN"))
      .slice(0, 10)
      .map(({ item }) => item);

    if (kind === "note") {
      return takeSorted(notes.map((note) => ({
        id: note.id,
        label: noteTitle(note),
        meta: note.folderId ? folderPathMap.get(note.folderId) || t("editor.notes.context.knowledgePath") : t("editor.notes.context.knowledgePath"),
        snippet: excerpt(note.contentText || ""),
      })));
    }

    if (kind === "asset") {
      return takeSorted(allAssets.map((asset) => ({
        id: asset.id,
        label: asset.name,
        meta: assetKindLabel(asset.kind, t),
        kind: asset.kind,
        thumbnailUrl: asset.thumbnailUrl,
        previewUrl: asset.previewUrl,
        libraryPath: asset.libraryPath,
      })));
    }

    if (kind === "anchor") {
      const targetNote = parsedAnchorQuery?.noteTitle
        ? notes.find((note) => noteTitle(note).toLocaleLowerCase() === parsedAnchorQuery.noteTitle?.toLocaleLowerCase())
        : null;
      const anchorSource = parsedAnchorQuery?.noteTitle ? targetNote?.contentText || "" : readActiveEditorValue();
      const anchorOwner = parsedAnchorQuery?.noteTitle || t("editor.notes.meta.currentNote");
      return getWikiAnchorCompletions(anchorSource, query)
        .map((anchor) => ({
          id: anchor.insertText,
          label: anchor.label,
          meta: `${anchorOwner} · ${anchor.detail} · ${t("editor.notes.meta.line", { line: anchor.line })}`,
          kind: anchor.kind,
          insertText: anchor.insertText,
        }));
    }

    return takeSorted(activeAllTags.map((tag) => ({
      id: tag.id,
      label: tag.name,
      meta: t("editor.notes.meta.noteCount", { count: tag.noteCount ?? 0 }),
    })));
  }, [activeAllTags, allAssets, folderPathMap, notes, readActiveEditorValue, t]);

  const insertPickerItems = useMemo(() => {
    if (!insertPicker) return [];
    const q = insertPicker.kind === "note" ? wikiNoteSearchPart(insertPicker.query) : insertPicker.query.trim();
    const takeSorted = <T extends AutocompleteItem>(items: T[]) => items
      .map((item) => ({ item, score: scoreAutocompleteLabel(item.label, q) }))
      .filter(({ score }) => score < 1000)
      .sort((a, b) => a.score - b.score || a.item.label.localeCompare(b.item.label, "zh-CN"))
      .slice(0, 60)
      .map(({ item }) => item);

    if (insertPicker.kind === "asset") {
      return takeSorted(allAssets.map((asset) => ({
        id: asset.id,
        label: asset.name,
        meta: assetKindLabel(asset.kind, t),
        kind: asset.kind,
        thumbnailUrl: asset.thumbnailUrl,
        previewUrl: asset.previewUrl,
        libraryPath: asset.libraryPath,
      })));
    }

    return takeSorted(notes.map((note) => ({
      id: note.id,
      label: noteTitle(note),
      meta: note.folderId ? folderPathMap.get(note.folderId) || t("editor.notes.context.knowledgePath") : t("editor.notes.context.knowledgePath"),
      snippet: excerpt(note.contentText || ""),
    })));
  }, [allAssets, folderPathMap, insertPicker, notes, t]);

  useEffect(() => {
    if (!insertPicker) return;
    const nextIndex = !insertPickerItems.length
      ? -1
      : insertPicker.selectedIndex < 0
        ? 0
        : Math.min(insertPicker.selectedIndex, insertPickerItems.length - 1);
    if (nextIndex === insertPicker.selectedIndex) return;
    setInsertPicker((current) => current ? { ...current, selectedIndex: nextIndex } : current);
  }, [insertPicker, insertPickerItems.length]);

  const updateEditorAutocomplete = useCallback((value = editContent, cursor?: number) => {
    const textarea = textareaRef.current;
    if (!textarea || !selectedNote || editorMode !== "source") {
      setAutocomplete(null);
      return;
    }
    if (sourceComposingRef.current) {
      setAutocomplete(null);
      return;
    }

    const caret = cursor ?? textarea.selectionStart ?? value.length;
    const trigger = detectAutocompleteTrigger(value, caret);
    if (!trigger) {
      setAutocomplete(null);
      return;
    }

    const items = buildAutocompleteItems(trigger.kind, trigger.query);
    if (items.length === 0) {
      setAutocomplete(null);
      return;
    }

    const popup = autocompletePopupPosition(textarea, value, caret, trigger.kind);
    setAutocomplete({
      ...trigger,
      items,
      selectedIndex: 0,
      x: popup.x,
      y: popup.y,
    });
  }, [buildAutocompleteItems, editContent, editorMode, selectedNote]);

  const startActiveEditorCompletion = useCallback((value: string, cursor: number) => {
    if (editorMode === "live") liveEditorRef.current?.startCompletion();
    else updateEditorAutocomplete(value, cursor);
  }, [editorMode, updateEditorAutocomplete]);

  const handleContentChange = useCallback((value: string) => {
    setEditContent(value);
    if (selectedNoteId) updateNoteLocal(selectedNoteId, { contentText: value });
    if (selectedNoteId && isRealVaultNoteId(selectedNoteId)) {
      const committed = notesInlineCommittedContentRef.current;
      if (committed?.noteId === selectedNoteId && committed.content === value) {
        notesInlineCommittedContentRef.current = null;
        realVaultSavedContentRef.current.set(selectedNoteId, value);
        realVaultLatestContentRef.current.set(selectedNoteId, value);
        realVaultUserDirtyRef.current.delete(selectedNoteId);
        pendingPatchRef.current = {};
        pendingPatchNoteIdRef.current = null;
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        setStatus(committed.revision ? t("editor.notes.status.aiApplied") : t("editor.notes.saved"));
        scheduleActiveNoteContext();
        return;
      }
      realVaultLatestContentRef.current.set(selectedNoteId, value);
      const isHydrating = realVaultDocumentReadsRef.current.isHydrating(selectedNoteId);
      const savedContent = realVaultSavedContentRef.current.get(selectedNoteId);
      const editorNormalizedOnly = !realVaultUserDirtyRef.current.has(selectedNoteId)
        && savedContent !== undefined
        && normalizeRealVaultEditorContentForDirtyCompare(savedContent) === normalizeRealVaultEditorContentForDirtyCompare(value);
      if (isHydrating || savedContent === value || editorNormalizedOnly) {
        realVaultUserDirtyRef.current.delete(selectedNoteId);
        realVaultKeepEditingAfterConflictRef.current.delete(selectedNoteId);
        setRealVaultExternalConflict((current) => current?.noteId === selectedNoteId ? null : current);
        if (pendingPatchNoteIdRef.current === selectedNoteId || pendingPatchNoteIdRef.current === null) {
          delete pendingPatchRef.current.contentText;
          if (!Object.keys(pendingPatchRef.current).length && saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
            pendingPatchNoteIdRef.current = null;
          }
        }
        scheduleActiveNoteContext();
        updateEditorAutocomplete(value);
        return;
      }
      realVaultUserDirtyRef.current.add(selectedNoteId);
      scheduleSave({ contentText: value });
      scheduleActiveNoteContext();
      updateEditorAutocomplete(value);
      return;
    }
    scheduleSave({ contentText: value });
    scheduleActiveNoteContext();
    updateEditorAutocomplete(value);
  }, [scheduleActiveNoteContext, scheduleSave, selectedNoteId, updateEditorAutocomplete, updateNoteLocal, t]);

  const togglePreviewTask = useCallback((bodyLine: number) => {
    if (!selectedNote) return;
    const nextContent = toggleMarkdownTaskAtBodyLine(editContent, bodyLine);
    if (nextContent === editContent) return;
    handleContentChange(nextContent);
    setStatus(t("editor.notes.status.taskUpdated"));
  }, [editContent, handleContentChange, selectedNote, t]);

  const materialInsertionUiRef = useRef({insertPicker, autocomplete, editorMode});
  materialInsertionUiRef.current = {insertPicker, autocomplete, editorMode};
  const serialAttachmentInsertsRef = useRef(createSerialAttachmentInserts());
  const attachmentInsertCommitRef = useRef<{revision: number; content: string; selection: AttachmentInsertSelection}>({revision: 0, content: "", selection: {start: 0, end: 0}});
  useEffect(() => () => { editorModeSessionRef.current.epoch += 1; }, []);

  const captureAttachmentInsertSession = (expectedMode: EditorMode): AttachmentInsertSession => {
    const modeSession = editorModeSessionRef.current;
    if (modeSession.mode !== expectedMode || modeSession.mode === "preview") throw new Error("请先打开可编辑笔记");
    return {
      source: readActiveKnowledgeWriteSource(), noteId: selectedNoteIdRef.current,
      noteRequest: noteLoadRequestRef.current, pane: activeNotesSplitPaneRef.current,
      paneEpoch: attachmentPaneEpochRef.current, mode: modeSession.mode, modeEpoch: modeSession.epoch,
    };
  };
  const attachmentInsertSessionIsCurrent = (session: AttachmentInsertSession) =>
    session.source !== null && session.source === readActiveKnowledgeWriteSource()
    && session.noteId === selectedNoteIdRef.current && session.noteRequest === noteLoadRequestRef.current
    && session.pane === activeNotesSplitPaneRef.current && session.paneEpoch === attachmentPaneEpochRef.current
    && session.mode === editorModeSessionRef.current.mode && session.modeEpoch === editorModeSessionRef.current.epoch;
  const captureAttachmentInsertCursor = (selection: AttachmentInsertSelection): AttachmentInsertCursor => ({
    content: readActiveEditorValue(), observedSelection: readActiveEditorSelection(), targetSelection: selection,
    commitRevision: attachmentInsertCommitRef.current.revision,
  });
  const resolveAttachmentInsertSelection = (intent: AttachmentInsertCursor, queued: boolean): AttachmentInsertSelection => {
    const content = readActiveEditorValue();
    const selection = readActiveEditorSelection();
    if (content === intent.content && sameAttachmentSelection(selection, intent.observedSelection)) return intent.targetSelection;
    const lastCommit = attachmentInsertCommitRef.current;
    if (queued && lastCommit.revision > intent.commitRevision && content === lastCommit.content && sameAttachmentSelection(selection, lastCommit.selection)) return selection;
    throw new Error("文档或光标已变化，请重新插入");
  };
  const recordAttachmentInsertCommit = (before: string, replacement: string, range: AttachmentInsertSelection) => {
    const result = replaceEditorContent(before, replacement, range);
    attachmentInsertCommitRef.current = {revision: attachmentInsertCommitRef.current.revision + 1, content: result.content, selection: materialBlockSelection(before, replacement, range)};
  };

  // All material pickers and drag insertion publish the same physical Vault file.
  const publishExistingAssetMarkdown = useCallback(async (asset: { id: string; name: string }) => {
    if (!selectedNote || !isRealVaultNoteId(selectedNote.id)) throw new Error("请先打开知识库笔记");
    if (!asset.id) throw new Error("素材缺少唯一标识，无法可靠复制");
    const session = captureAttachmentInsertSession(editorMode);
    const noteId = selectedNote.id;
    if (session.noteId !== noteId) throw new Error("笔记已切换，请重新插入");
    const before = readActiveEditorValue();
    const selection = readActiveEditorSelection();
    const context = await captureAttachmentContext(realVaultRelativePathFromNoteId(noteId));
    if (!attachmentInsertSessionIsCurrent(session)) throw new Error("编辑会话已切换，请重新插入");
    const result = await publishVaultAttachment(context, { name: asset.name, materialId: asset.id });
    const currentSelection = readActiveEditorSelection();
    if (!attachmentInsertSessionIsCurrent(session) || !sameAttachmentSelection(selection, currentSelection) || !attachmentContextIsCurrent(context) || readActiveEditorValue() !== before) {
      throw new Error("文档已变化，请重试；素材副本已保留在知识库中");
    }
    const prepared = await preparePublishedAttachment(context, result, { ...allAssets.find(item => item.id === asset.id), ...asset });
    const finalSelection = readActiveEditorSelection();
    if (!attachmentInsertSessionIsCurrent(session) || !sameAttachmentSelection(selection, finalSelection) || !attachmentContextIsCurrent(context) || readActiveEditorValue() !== before) {
      throw new Error("文档已变化，请重试；素材副本已保留在知识库中");
    }
    return prepared;
  }, [selectedNote, readActiveEditorValue, readActiveEditorSelection, allAssets]);

  const rememberPublishedAttachment = useCallback((prepared?: PreparedAttachment | readonly PreparedAttachment[]) => {
    if (!prepared || !currentVault || !selectedNoteIdRef.current) return;
    const items = (Array.isArray(prepared) ? prepared : [prepared]).filter(item => item.resolution && item.target);
    if (!items.length) return;
    const noteId = selectedNoteIdRef.current;
    const path = realVaultRelativePathFromNoteId(noteId);
    const entries = items.map(item => {
      const key = `${currentVault.id}:${currentVault.rootPath}:${item.wiki ? "wiki" : "markdown"}:${path}:${item.target}`;
      return [key, attachmentResolutionMatches(item.resolution!)] as const;
    });
    // One short-lived projection for source mode, other panes and watcher
    // invalidation. The editor also carries its receipt in text history.
    flushSync(() => {
      setRealVaultAssetMatches(previous => mergeAttachmentBatch(previous, {keys:entries.map(([key]) => key),entries,errors:[]}));
      setPublishedDraftEmbeds(previous => [...previous.filter(existing => existing.noteId !== noteId || !items.some(item => item.markdown === existing.prepared.markdown)), ...items.map(item => ({noteId,prepared:item}))].slice(-64));
    });
  }, [currentVault]);

  const insertPickedReference = useCallback(async (item: AutocompleteItem) => {
    if (!insertPicker || !selectedNote) return;
    const currentContent = readActiveEditorValue();
    const range = {
      start: Math.max(0, Math.min(insertPicker.selection.start, currentContent.length)),
      end: Math.max(0, Math.min(insertPicker.selection.end, currentContent.length)),
    };
    const safeRange = { start: Math.min(range.start, range.end), end: Math.max(range.start, range.end) };
    let replacement = "";
    let prepared: PreparedAttachment | undefined;
    let statusText = "";

    if (insertPicker.kind === "asset") {
      if (isRealVaultNoteId(selectedNote.id)) {
        try { prepared = await publishExistingAssetMarkdown({id:item.id,name:item.label}); replacement = materialBlockInsertion(currentContent, prepared.markdown, safeRange); }
        catch (error) {setStatus(error instanceof Error ? error.message : String(error));return;}
      } else replacement = materialBlockInsertion(currentContent, `![[${item.label}]]`, safeRange);
      // The inserted attachment itself is the success feedback.
    } else {
      const alias = (insertPicker.alias || "").trim();
      replacement = alias && alias !== item.label ? `[[${item.label}|${alias}]]` : `[[${item.label}]]`;
      statusText = t("editor.notes.status.insertedNoteLink");
    }

    if (materialInsertionUiRef.current.insertPicker !== insertPicker) return;
    rememberPublishedAttachment(prepared);
    if (editorMode === "live" && liveEditorRef.current) {
      liveEditorRef.current.replaceRange(replacement, safeRange, prepared);
      setInsertPicker(null);
      if (statusText) setStatus(statusText);
      publishActiveNoteContext();
      return;
    }
    const result = replaceEditorContent(currentContent, replacement, safeRange);
    if (insertPicker.kind === "asset") result.selection = materialBlockSelection(currentContent, replacement, safeRange);
    if (editorMode === "source") {
      const scrollTop = textareaRef.current?.scrollTop;
      flushSync(() => { setSourceContentDraft(result.content); handleContentChange(result.content); });
      setActiveEditorSelection(result.selection);
      if (textareaRef.current && scrollTop != null) textareaRef.current.scrollTop = scrollTop;
      setInsertPicker(null);
      if (statusText) setStatus(statusText);
      publishActiveNoteContext();
      return;
    }
    handleContentChange(result.content);
    setInsertPicker(null);
    if (statusText) setStatus(statusText);
    window.setTimeout(() => {
      setActiveEditorSelection(result.selection);
      publishActiveNoteContext();
      focusActiveEditor();
    }, 0);
  }, [rememberPublishedAttachment, publishExistingAssetMarkdown, editorMode, focusActiveEditor, handleContentChange, insertPicker, publishActiveNoteContext, readActiveEditorValue, selectedNote, setActiveEditorSelection, t]);

  const flushLiveEditorContent = useCallback(() => {
    if (editorMode !== "live") return editContent;
    const current = liveEditorRef.current?.getValue();
    if (typeof current === "string" && current !== editContent) {
      flushSync(() => handleContentChange(current));
      return current;
    }
    return editContent;
  }, [editContent, editorMode, handleContentChange]);

  useEffect(() => {
    setSourceContentDraft(null);
  }, [selectedNoteId]);

  useEffect(() => {
    if (!aiWritePreview) return;
    const previewId = aiWritePreview.previewId;
    setAiWritePreview(null);
    void bridge?.notesInlineDiscard?.(previewId).catch(() => undefined);
  // A note switch invalidates the server-owned preview binding.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNoteId]);

  const replaceEditorRange = useCallback((nextText: string, range?: { start: number; end: number }, prepared?: PreparedAttachment | readonly PreparedAttachment[]) => {
    const activeSelection = readActiveEditorSelection();
    const start = range?.start ?? activeSelection.start;
    const end = range?.end ?? activeSelection.end;
    rememberPublishedAttachment(prepared);
    // Commit text and caret in one CM transaction; a deferred caret can otherwise
    // land before the prop echo and be mapped through the insertion a second time.
    if (editorMode === "live" && liveEditorRef.current) {
      liveEditorRef.current.replaceRange(nextText, { start, end }, prepared);
      publishActiveNoteContext();
      return;
    }
    const currentContent = readActiveEditorValue();
    const result = replaceEditorContent(currentContent, nextText, { start, end });
    if (prepared) result.selection = materialBlockSelection(currentContent, nextText, { start, end });
    if (editorMode === "source") {
      const scrollTop = textareaRef.current?.scrollTop;
      // A timer can run before React commits the textarea value, clamping the
      // caret to the old length and invalidating the next queued insertion.
      flushSync(() => { setSourceContentDraft(result.content); handleContentChange(result.content); });
      setActiveEditorSelection(result.selection);
      if (textareaRef.current && scrollTop != null) textareaRef.current.scrollTop = scrollTop;
      publishActiveNoteContext();
      return;
    }
    handleContentChange(result.content);
    window.setTimeout(() => {
      setActiveEditorSelection(result.selection);
      publishActiveNoteContext();
    }, 0);
  }, [rememberPublishedAttachment, editorMode, handleContentChange, publishActiveNoteContext, readActiveEditorSelection, readActiveEditorValue, setActiveEditorSelection]);

  const applyAutocompleteItem = useCallback(async (item?: AutocompleteItem) => {
    if (!autocomplete || !item) return;
    if (autocomplete.kind === "asset" && selectedNote && isRealVaultNoteId(selectedNote.id)) {
      try {
        const prepared = await publishExistingAssetMarkdown({id:item.id,name:item.label});
        if (materialInsertionUiRef.current.autocomplete !== autocomplete) return;
        replaceEditorRange(materialBlockInsertion(readActiveEditorValue(), prepared.markdown, {start:autocomplete.start,end:autocomplete.end}), {start:autocomplete.start,end:autocomplete.end}, prepared);
        setAutocomplete(null);
      } catch (error) {setStatus(error instanceof Error ? error.message : String(error));}
      return;
    }
    const replacement = autocomplete.kind === "note"
      ? `[[${item.label}${wikiNoteSuffixPart(autocomplete.query)}]]`
      : autocomplete.kind === "asset"
        ? `![[${item.label}]]`
        : autocomplete.kind === "anchor"
          ? `[[${item.insertText || `#${item.label}`}]]`
          : `#${item.label}`;
    replaceEditorRange(replacement, { start: autocomplete.start, end: autocomplete.end });
    setAutocomplete(null);
  }, [autocomplete, replaceEditorRange, readActiveEditorValue, selectedNote, publishExistingAssetMarkdown]);

  const handleEditorKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!autocomplete) return false;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setAutocomplete((current) => {
        if (!current) return current;
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const selectedIndex = (current.selectedIndex + direction + current.items.length) % current.items.length;
        return { ...current, selectedIndex };
      });
      return true;
    }

    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      applyAutocompleteItem(autocomplete.items[autocomplete.selectedIndex]);
      return true;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setAutocomplete(null);
      return true;
    }
    return false;
  }, [applyAutocompleteItem, autocomplete]);

  const handleEditorCommand = useCallback(async (command: EditorCommand) => {
    if (!selectedNote) return;
    const contextSelection = editorCtx?.selection;
    setEditorCtx(null);
    setAutocomplete(null);
    focusActiveEditor();
    const activeSelection = contextSelection ?? readActiveEditorSelection();
    const start = activeSelection.start;
    const end = activeSelection.end;
    const range = { start: Math.min(start, end), end: Math.max(start, end) };
    const currentContent = readActiveEditorValue();
    const selected = currentContent.slice(range.start, range.end);

    const applyManualChange = (
      content: string,
      selection: { start: number; end: number },
      nextStatus?: string,
      openAutocomplete = false,
    ) => {
      handleContentChange(content);
      if (nextStatus) setStatus(nextStatus);
      window.setTimeout(() => {
        setActiveEditorSelection(selection);
        publishActiveNoteContext();
        if (openAutocomplete) startActiveEditorCompletion(content, selection.start);
      }, 0);
    };

    if (command === "link" || command === "wiki-link") {
      setInsertPicker({
        kind: "note",
        query: selected.trim(),
        selectedIndex: 0,
        selection: range,
        alias: selected.trim() || undefined,
      });
      setStatus(t("editor.notes.status.selectNoteLink"));
      return;
    }

    if (command === "external-link") {
      const selectedTrimmed = selected.trim();
      const selectedIsUrl = /^https?:\/\//i.test(selectedTrimmed);
      const linkTitle = selectedIsUrl ? t("editor.notes.insert.externalLinkTitle") : selected || t("editor.notes.insert.externalLinkTitle");
      const url = selectedIsUrl ? selectedTrimmed : "https://";
      const replacement = `[${linkTitle}](${url})`;
      const result = replaceEditorContent(currentContent, replacement, range);
      const titleStart = range.start + 1;
      const titleEnd = titleStart + linkTitle.length;
      const urlStart = titleEnd + 2;
      const urlEnd = urlStart + url.length;
      applyManualChange(
        result.content,
        selectedIsUrl || !selected ? { start: titleStart, end: titleEnd } : { start: urlStart, end: urlEnd },
        t("editor.notes.status.externalLinkInserted"),
      );
      return;
    }

    if (command === "insert-asset") {
      setInsertPicker({
        kind: "asset",
        query: selected.trim(),
        selectedIndex: 0,
        selection: range,
      });
      setStatus(t("editor.notes.status.selectMaterial"));
      return;
    }

    try {
      const result = await applyEditorCommand(command, {
        content: currentContent,
        selectionStart: start,
        selectionEnd: end,
        clipboard: navigator.clipboard,
      });
      if (result.changed) handleContentChange(result.content);
      if (result.status) setStatus(result.status);
      window.setTimeout(() => {
        setActiveEditorSelection(result.selection);
        publishActiveNoteContext();
      }, 0);
    } catch (error) {
      console.warn("[NotesPage] editor context command failed", command, error);
      setStatus(t("editor.notes.status.contextCommandFailed"));
    }
  }, [editorCtx?.selection, focusActiveEditor, handleContentChange, publishActiveNoteContext, readActiveEditorSelection, readActiveEditorValue, selectedNote, setActiveEditorSelection, startActiveEditorCompletion, t]);

  const handleTableEditorCommand = useCallback(async (tableContext: LiveEditorTableContext, command: TableEditorCommand) => {
    if (!selectedNote) return;
    setEditorCtx(null);
    const currentContent = readActiveEditorValue();
    const tableRange = resolveEditableTableRange(currentContent, tableContext);
    if (!tableRange) {
      setStatus(t("editor.notes.status.tableCommandFailed"));
      return;
    }
    const from = tableRange.from;
    const to = tableRange.to;
    const source = currentContent.slice(from, to);
    const table = parseEditableTableSource(source);
    if (!table) {
      setStatus(t("editor.notes.status.tableCommandFailed"));
      return;
    }
    if (command === "row-copy" || command === "column-copy") {
      const copyText = command === "row-copy" ? copyEditorTableRowText(table, tableContext) : copyEditorTableColumnText(table, tableContext);
      try {
        await navigator.clipboard.writeText(copyText);
        setStatus(command === "row-copy" ? t("editor.notes.status.tableRowCopied") : t("editor.notes.status.tableColumnCopied"));
      } catch {
        setStatus(t("editor.notes.status.tableCopyFailed"));
      }
      return;
    }
    const nextSource = serializeEditableTableSource(applyEditableTableCommand(table, tableContext, command));
    if (nextSource === source) {
      setStatus(t("editor.notes.status.tableUnchanged"));
      return;
    }
    const result = replaceEditorContent(currentContent, nextSource, { start: from, end: to });
    if (editorMode === "source") setSourceContentDraft(result.content);
    handleContentChange(result.content);
    setStatus(t(tableCommandStatusKey(command)));
    window.setTimeout(() => {
      setActiveEditorSelection({ start: from, end: from });
      publishActiveNoteContext();
      focusActiveEditor();
    }, 0);
  }, [editorMode, focusActiveEditor, handleContentChange, publishActiveNoteContext, readActiveEditorValue, selectedNote, setActiveEditorSelection, t]);

  const commitCurrentEditorDraft = useCallback(() => {
    if (editorMode === "live") return flushLiveEditorContent();
    if (editorMode === "source") {
      const current = sourceContentDraft ?? editContent;
      if (sourceContentDraft !== null && sourceContentDraft !== editContent) {
        flushSync(() => handleContentChange(sourceContentDraft));
      }
      return current;
    }
    return editContent;
  }, [editContent, editorMode, flushLiveEditorContent, handleContentChange, sourceContentDraft]);

  useEffect(() => {
    commitCurrentEditorDraftRef.current = () => {
      commitCurrentEditorDraft();
    };
  }, [commitCurrentEditorDraft]);

  useEffect(() => registerWorkspaceFlush(async () => {
    if (sourceComposingRef.current || workspaceCompositionActive() || notesNativeViews.hasFrozenViews()) return false;
    const source = readActiveKnowledgeWriteSource();
    commitCurrentEditorDraft();
    flushPendingSaveRef.current();
    await Promise.all(Array.from(realVaultSaveCompletionRef.current.values()));
    if (source !== readActiveKnowledgeWriteSource() || notesNativeViews.hasFrozenViews()) return false;
    for (const noteId of Array.from(realVaultUserDirtyRef.current)) {
      const content = realVaultLatestContentRef.current.get(noteId);
      if (content === undefined) return false;
      await savePatch({ contentText: content }, noteId, "explicit-save");
      await realVaultSaveCompletionRef.current.get(noteId);
      if (source !== readActiveKnowledgeWriteSource() || notesNativeViews.hasFrozenViews() || realVaultUserDirtyRef.current.has(noteId)) return false;
    }
    return !sourceComposingRef.current && !workspaceCompositionActive()
      && !notesNativeViews.hasFrozenViews()
      && realVaultUserDirtyRef.current.size === 0 && realVaultSaveInFlightRef.current.size === 0;
  }, () => realVaultUserDirtyRef.current.size > 0 || realVaultSaveInFlightRef.current.size > 0), [commitCurrentEditorDraft, savePatch]);

  const togglePreviewMode = useCallback(() => {
    if (!selectedNote) return;
    commitCurrentEditorDraft();
    setSourceContentDraft(null);
    setEditorMode((mode) => (mode === "preview" ? "live" : "preview"));
  }, [commitCurrentEditorDraft, selectedNote]);

  const toggleSourceMode = useCallback(() => {
    if (!selectedNote) return;
    if (editorMode === "source") {
      setSourceContentDraft(null);
      setEditorMode("live");
      return;
    }
    const current = commitCurrentEditorDraft();
    setSourceContentDraft(current);
    setEditorMode("source");
  }, [commitCurrentEditorDraft, editorMode, selectedNote]);

  const openAiWriteMenu = useCallback(() => {
    if (!selectedNote) return;
    commitCurrentEditorDraft();
    setNoteCtx(null);
    setEditorCtx(null);
    setAutocomplete(null);

    let point: { x: number; y: number } | null = null;
    if (editorMode === "live") {
      point = liveEditorRef.current?.getSelectionCoords() || null;
    } else if (editorMode === "source" && textareaRef.current) {
      const textarea = textareaRef.current;
      point = autocompletePopupPosition(textarea, textarea.value, textarea.selectionStart ?? textarea.value.length, "note");
    }
    if (!point) {
      const rect = noteContentAreaRef.current?.getBoundingClientRect();
      point = rect ? { x: rect.left + 28, y: rect.top + 48 } : { x: 240, y: 180 };
    }

    setAiWriteMenu(clampEditorMenuPosition(point.x, point.y));
  }, [commitCurrentEditorDraft, editorMode, selectedNote]);

  const handleLiveEditorCommand = useCallback((command: LiveEditorShortcutCommand) => {
    if (command === "toggle-preview") {
      togglePreviewMode();
      return;
    }
    if (command === "toggle-source") {
      toggleSourceMode();
      return;
    }
    if (command === "ai-write-menu") {
      openAiWriteMenu();
      return;
    }
    void handleEditorCommand(command);
  }, [handleEditorCommand, openAiWriteMenu, togglePreviewMode, toggleSourceMode]);

  const handleSourceEditorShortcut = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const command = resolveScopedShortcut(event.nativeEvent, "knowledge", undefined, {
      ids: [
        "knowledgeBold",
        "knowledgeItalic",
        "knowledgeLink",
        "knowledgeExternalLink",
        "knowledgePreview",
        "knowledgeSource",
        "knowledgeAiWrite",
        "knowledgeAutocomplete",
      ],
    });
    if (!command) return false;

    const runCommand = (command: EditorCommand) => {
      event.preventDefault();
      event.stopPropagation();
      void handleEditorCommand(command);
      return true;
    };

    if (command === "knowledgeAutocomplete") {
      event.preventDefault();
      event.stopPropagation();
      const textarea = event.currentTarget;
      updateEditorAutocomplete(textarea.value, textarea.selectionStart ?? textarea.value.length);
      return true;
    }
    if (command === "knowledgeBold") return runCommand("bold");
    if (command === "knowledgeItalic") return runCommand("italic");
    if (command === "knowledgeLink") return runCommand("link");
    if (command === "knowledgeExternalLink") return runCommand("external-link");
    if (command === "knowledgePreview" || command === "knowledgeSource") {
      event.preventDefault();
      event.stopPropagation();
      if (command === "knowledgeSource") toggleSourceMode();
      else togglePreviewMode();
      return true;
    }
    event.preventDefault();
    event.stopPropagation();
    openAiWriteMenu();
    return true;
  }, [handleEditorCommand, openAiWriteMenu, togglePreviewMode, toggleSourceMode, updateEditorAutocomplete]);

  const handleSourceListShortcut = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!["Enter", "Backspace", "Tab"].includes(event.key) || event.ctrlKey || event.metaKey || event.altKey) return false;
    if (event.key === "Enter" && event.shiftKey) return false;
    if (event.key === "Backspace" && event.shiftKey) return false;
    if (event.nativeEvent.isComposing || sourceComposingRef.current) return false;
    const textarea = event.currentTarget;
    const selectionStart = textarea.selectionStart ?? 0;
    const selectionEnd = textarea.selectionEnd ?? selectionStart;
    const result = event.key === "Enter"
      ? applySourceListEnter(textarea.value, selectionStart, selectionEnd)
      : event.key === "Backspace"
        ? applySourceListBackspace(textarea.value, selectionStart, selectionEnd)
        : applySourceListIndent(textarea.value, selectionStart, selectionEnd, event.shiftKey ? "outdent" : "indent");
    if (!result) return false;

    event.preventDefault();
    event.stopPropagation();
    setSourceContentDraft(result.value);
    handleContentChange(result.value);
    setAutocomplete(null);
    window.setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(result.selectionStart, result.selectionEnd);
      publishActiveNoteContext();
    }, 0);
    return true;
  }, [handleContentChange, publishActiveNoteContext]);

  const openAssetFromPreview = useCallback((assetId: string) => {
    if (assetId.startsWith(REAL_VAULT_MARKDOWN_EMBED_PREFIX)) {
      const noteId = assetId.slice(REAL_VAULT_MARKDOWN_EMBED_PREFIX.length);
      if (isRealVaultNoteId(noteId)) {
        void selectNote(noteId, { scrollList: true });
        return;
      }
    }
    if (assetId.startsWith(REAL_VAULT_ASSET_PREFIX)) {
      const absolutePath = realVaultAssetOpenPathRef.current.get(assetId);
      const label = assetId.slice(REAL_VAULT_ASSET_PREFIX.length);
      if (!absolutePath) {
        setStatus(t("editor.notes.status.materialNotFoundNamed", { label }));
        return;
      }
      void (async () => {
        const opened = bridge?.openFilePath ? await bridge.openFilePath(absolutePath) : false;
        setStatus(opened ? t("editor.notes.status.materialOpened", { label }) : t("editor.notes.status.materialFoundPreviewPending", { label }));
      })();
      return;
    }
    focusEntity("asset", assetId, { action: "detail", source: "notes-embed" });
    window.location.hash = "#materials";
  }, [bridge, selectNote, t]);

  const locateAssetInLibrary = useCallback((assetId: string) => {
    focusEntity("asset", assetId, { action: "focus-only", source: "notes-editor-context" });
    window.location.hash = "#materials";
  }, []);

  const openTagFromEditor = useCallback((tagId: string) => {
    focusEntity("tag", tagId);
    window.location.hash = "#tags";
  }, []);

  const buildDroppedAssetMarkdown = useCallback((assets: Array<Pick<Asset, "name">>, selection: { start: number; end: number }) => {
    return materialBlockInsertion(readActiveEditorValue(), assets.map((asset) => `![[${asset.name}]]`).join("\n"), selection);
  }, [readActiveEditorValue]);

  const insertDroppedFilesAsAssets = useCallback(async (files: FileList | File[], selection: { start: number; end: number }) => {
    if (selectedNote && isRealVaultNoteId(selectedNote.id)) {
      const noteId = selectedNote.id;
      const selected = Array.from(files);
      try {
        const session = captureAttachmentInsertSession(editorMode);
        const intent = captureAttachmentInsertCursor(selection);
        await serialAttachmentInsertsRef.current(
          () => session.noteId === noteId && attachmentInsertSessionIsCurrent(session),
          async (queued) => {
            const insertionSelection = resolveAttachmentInsertSelection(intent, queued);
            const before = readActiveEditorValue();
            const initialSelection = readActiveEditorSelection();
            const current = () => attachmentInsertSessionIsCurrent(session) && readActiveEditorValue() === before && sameAttachmentSelection(readActiveEditorSelection(), initialSelection);
            if (selected.length > 32 || selected.some((file) => file.size > 64 * 1024 * 1024)) throw new Error("一次最多插入 32 个附件，每个不超过 64 MiB");
            const context = await captureAttachmentContext(realVaultRelativePathFromNoteId(noteId));
            if (!current()) throw new Error("笔记或光标已变化，请重新插入");
            const markdown: string[] = [];
            const prepared: PreparedAttachment[] = [];
            for (const file of selected) {
              if (!attachmentContextIsCurrent(context) || !current()) throw new Error("文档或光标内容已变化，请重试；已复制附件保留在知识库中");
              const nativePath = (file as File & { path?: string }).path;
              const input = nativePath ? { name: file.name, sourcePath: nativePath } : { name: file.name, bytes: Array.from(new Uint8Array(await file.arrayBuffer())) };
              if (!attachmentContextIsCurrent(context) || !current()) throw new Error("文档或光标内容已变化，请重试；已复制附件保留在知识库中");
              const result = await publishVaultAttachment(context, input);
              if (!attachmentContextIsCurrent(context) || !current()) throw new Error("编辑会话已切换；已复制附件保留在知识库中");
              markdown.push(result.markdown);
              const kind = file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(file.name)
                ? "image" : file.type.startsWith("video/") || /\.(mp4|mov|webm|m4v)$/i.test(file.name) ? "video" : "file";
              prepared.push(await preparePublishedAttachment(context, result, {id: `published-file:${file.name}`, name:file.name, kind}));
            }
            if (!attachmentContextIsCurrent(context) || !current()) throw new Error("文档已变化，请重新插入；已复制附件保留在知识库中");
            const replacement = materialBlockInsertion(before, markdown.join("\n"), insertionSelection);
            replaceEditorRange(replacement, insertionSelection, prepared);
            recordAttachmentInsertCommit(before, replacement, insertionSelection);
            if (session.mode === "source") await new Promise<void>(resolve => setTimeout(resolve, 0));
          },
        );
      } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
      return;
    }
    if (!selectedNote || !bridge?.importDroppedFiles) return;
    try {
      setStatus(t("editor.notes.status.importingMaterial"));
      const result = await bridge.importDroppedFiles(files);
      const importedAssets = Array.isArray(result?.assets) ? result.assets as Asset[] : [];
      if (!importedAssets.length) {
        setStatus(result?.skippedDuplicates ? t("editor.notes.status.materialDuplicate") : t("editor.notes.status.materialNotImported"));
        return;
      }
      setAllAssets((current) => mergeAssetsById(current, importedAssets));
      const markdown = buildDroppedAssetMarkdown(importedAssets, selection);
      replaceEditorRange(markdown, selection);
      setStatus(importedAssets.length === 1 ? t("editor.notes.status.materialReferenceInserted") : t("editor.notes.status.materialReferencesInserted", { count: importedAssets.length }));
    } catch (error) {
      console.warn("[NotesPage] insert dropped files as assets failed", error);
      setStatus(t("editor.notes.status.materialDropFailed"));
    }
  }, [bridge, buildDroppedAssetMarkdown, readActiveEditorValue, replaceEditorRange, selectedNote, t]);

  const insertClipboardImageAsAsset = useCallback(async (source: ClipboardImageSource, selection: { start: number; end: number }) => {
    if (!selectedNote) return;
    try {
      if (isClipboardDataImageSource(source)) {
        if (!isRealVaultNoteId(selectedNote.id)) setStatus(t("editor.notes.status.importingClipboardImage"));
        const file = await clipboardDataUrlToImageFile(source.value);
        await insertDroppedFilesAsAssets([file], selection);
        return;
      }

      if (isRealVaultNoteId(selectedNote.id)) {
        const url = new URL(source.value);
        if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("不支持此图片地址");
        const destination = url.href.replace(/\(/g, "%28").replace(/\)/g, "%29");
        replaceEditorRange(`![图片](${destination})`, selection);
        setStatus("已插入远程图片链接");
        return;
      }

      if (!bridge?.importImageToAssets) {
        setStatus(t("editor.notes.status.imageUrlUnsupported"));
        return;
      }

      setStatus(t("editor.notes.status.importingClipboardImage"));
      const result = await bridge.importImageToAssets(source.value);
      if (!result?.success || (!result.asset_id && !result.asset_name)) {
        setStatus(result?.error ? t("editor.notes.status.imageImportError", { error: result.error }) : t("editor.notes.status.imageImportFailed"));
        return;
      }

      let importedAssets: Asset[] = [];
      if (bridge.listAssets) {
        const latest = await bridge.listAssets();
        const nextAssets = Array.isArray(latest) ? latest as Asset[] : [];
        setAllAssets(nextAssets);
        importedAssets = result.asset_id ? nextAssets.filter((asset) => asset.id === result.asset_id) : [];
      }
      const fallbackName = result.asset_name || importedAssets[0]?.name || "download.jpg";
      const markdown = buildDroppedAssetMarkdown(importedAssets.length ? importedAssets : [{ name: fallbackName }], selection);
      replaceEditorRange(markdown, selection);
      setStatus(t("editor.notes.status.clipboardImageInserted"));
    } catch (error) {
      console.warn("[NotesPage] insert clipboard image failed", error);
      setStatus(t("editor.notes.status.clipboardImageFailed"));
    }
  }, [bridge, buildDroppedAssetMarkdown, insertDroppedFilesAsAssets, replaceEditorRange, selectedNote, t]);

  const insertExistingAssetReference = useCallback(async (draggedAsset: DraggedMaterialAsset, selection: { start: number; end: number }) => {
    if (!selectedNote) return;
    if (isRealVaultNoteId(selectedNote.id)) {
      const noteId = selectedNote.id;
      try {
        const session = captureAttachmentInsertSession(editorMode);
        const intent = captureAttachmentInsertCursor(selection);
        await serialAttachmentInsertsRef.current(
          () => session.noteId === noteId && attachmentInsertSessionIsCurrent(session),
          async (queued) => {
            const insertionSelection = resolveAttachmentInsertSelection(intent, queued);
            const before = readActiveEditorValue();
            const prepared = await publishExistingAssetMarkdown(draggedAsset);
            if (!attachmentInsertSessionIsCurrent(session)) throw new Error("编辑会话已切换；素材副本已保留在知识库中");
            const replacement = materialBlockInsertion(before, prepared.markdown, insertionSelection);
            replaceEditorRange(replacement, insertionSelection, prepared);
            recordAttachmentInsertCommit(before, replacement, insertionSelection);
            if (session.mode === "source") await new Promise<void>(resolve => setTimeout(resolve, 0));
          },
        );
      } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
      return;
    }
    const asset = allAssets.find((item) => item.id === draggedAsset.id) || allAssets.find((item) => item.name === draggedAsset.name) || draggedAsset;
    const markdown = buildDroppedAssetMarkdown([{ name: asset.name }], selection);
    replaceEditorRange(markdown, selection);
    setStatus(t("editor.notes.status.materialReferenceInserted"));
  }, [allAssets, buildDroppedAssetMarkdown, publishExistingAssetMarkdown, readActiveEditorValue, replaceEditorRange, selectedNote, t]);

  const createLinkedNote = useCallback(async (title: string, options?: { select?: boolean; contentText?: string; openOptions?: NoteOpenOptions | null }) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const contentText = options?.contentText ?? "";
    if (knowledgeStorageMode === "real-vault" || isRealVaultNoteId(selectedNoteId)) {
      const currentRelativePath = selectedNoteId && isRealVaultNoteId(selectedNoteId)
        ? realVaultRelativePathFromNoteId(selectedNoteId)
        : selectedNote?.folderId || null;
      const indexedTarget = createRealVaultWikiTargetResolver(realVaultMarkdownIndex?.documents || [])(trimmed);
      if (indexedTarget) {
        const note = realVaultIndexDocumentToNote(indexedTarget, t("editor.notes.untitled"));
        if (options?.select !== false) {
          const openOptions = options?.openOptions;
          const anchored = Boolean(openOptions?.blockId || openOptions?.headingPath);
          await selectNote(note.id, {
            focusEditor: !anchored,
            scrollList: true,
            blockId: openOptions?.blockId,
            headingPath: openOptions?.headingPath,
            anchorInEditor: anchored,
          });
        }
        return note;
      }

      const target = realVaultMissingDocumentLocation(trimmed, currentRelativePath);
      if (!target) return;
      try {
        const existingDocument = await realVaultDocumentSource.openDocument(target.relativePath);
        const note = noteFromKnowledgeDocument(existingDocument, t("editor.notes.untitled"));
        await loadRealVaultTree();
        if (options?.select !== false) {
          const openOptions = options?.openOptions;
          const anchored = Boolean(openOptions?.blockId || openOptions?.headingPath);
          await selectNote(note.id, {
            focusEditor: !anchored,
            scrollList: true,
            blockId: openOptions?.blockId,
            headingPath: openOptions?.headingPath,
            anchorInEditor: anchored,
          });
        }
        return note;
      } catch {
        // Missing file: create a new Markdown document in the real vault.
      }

      try {
        const createdDocument = await realVaultDocumentSource.createDocument(target.parentPath, target.fileName);
        const initialContent = realVaultInitialMissingContent(target.title, contentText);
        const savedDocument = await writeRealVaultDocumentIfAllowed("create-missing-link", createdDocument, initialContent);
        if (!savedDocument) throw new Error("real-vault write blocked");
        await loadRealVaultTree();
        const note = noteFromKnowledgeDocument(savedDocument, t("editor.notes.untitled"));
        realVaultSavedContentRef.current.set(note.id, savedDocument.contentText || initialContent);
        realVaultLatestContentRef.current.set(note.id, savedDocument.contentText || initialContent);
        if (options?.select !== false) {
          const openOptions = options?.openOptions;
          const anchored = Boolean(openOptions?.blockId || openOptions?.headingPath);
          await selectNote(note.id, {
            focusEditor: !anchored,
            scrollList: true,
            blockId: openOptions?.blockId,
            headingPath: openOptions?.headingPath,
            anchorInEditor: anchored,
          });
        }
        return note;
      } catch (error) {
        console.warn("[NotesPage] create real vault linked markdown failed", error);
        setStatus(error instanceof Error ? error.message : t("editor.notes.status.markdownCreateFailed"));
        return;
      }
    }

    if (!bridge?.createNote) return;
    try {
      const note = await bridge.createNote({ title: trimmed, contentText, contentJson: contentText });
      await loadNotes();
      if (note?.id && options?.select !== false) {
        const openOptions = options?.openOptions;
        const anchored = Boolean(openOptions?.blockId || openOptions?.headingPath);
        await selectNote(note.id, {
          focusEditor: !anchored,
          scrollList: true,
          blockId: openOptions?.blockId,
          headingPath: openOptions?.headingPath,
          anchorInEditor: anchored,
        });
      }
      return note as Note;
    } catch (error) {
      console.warn("[NotesPage] create linked note failed", error);
      setStatus(t("editor.notes.status.noteCreateFailed"));
    }
  }, [bridge, knowledgeStorageMode, loadNotes, loadRealVaultTree, realVaultDocumentSource, realVaultMarkdownIndex, selectNote, selectedNote, selectedNoteId, writeRealVaultDocumentIfAllowed, t]);

  const createNote = useCallback(async (parentOverride?: string | null, titleOverride?: string) => {
    const targetFolderId = parentOverride !== undefined ? parentOverride : selectedFolderId;
    const parentPath = targetFolderId && targetFolderId !== "__uncategorized__" ? targetFolderId : "";
    try {
      const source = readActiveKnowledgeWriteSource();
      const requestedName = (titleOverride || "未命名").trim().replace(/\.md$/i, "") || "未命名";
      let created: Awaited<ReturnType<typeof createKnowledgeDocument>> | undefined;
      for (let index = 0; index < 1000; index++) {
        try {
          created = await createKnowledgeDocument({ title: `${requestedName}${index ? ` ${index}` : ""}`, parentRelativePath: parentPath, content: "" });
          break;
        } catch (error) {
          if (titleOverride || (error as { code?: string }).code !== "knowledge-name-conflict") throw error;
        }
      }
      if (!created) throw new Error("未能创建未命名笔记，请稍后重试");
      if (readActiveKnowledgeWriteSource() !== source) return;
      await loadRealVaultTree();
      const id = realVaultNoteId(created.relativePath);
      setEditorMode("live");
      await selectNote(id, { focusEditor: false, scrollList: true });
      setNamingNoteId(id);
    } catch (error) {
      console.warn("[NotesPage] create real vault markdown failed", error);
      setStatus(error instanceof Error ? error.message : t("editor.notes.status.markdownCreateFailed"));
    }
  }, [loadRealVaultTree, selectNote, selectedFolderId, t]);

  const openCreateDocumentDialog = useCallback((parentOverride?: string | null) => {
    void createNote(parentOverride);
  }, [createNote]);

  const createDocumentFromDialog = useCallback(async () => {
    if (dialog?.kind !== "document") return;
    const name = dialog.name.trim();
    if (!name) {
      setStatus(t("editor.notes.status.enterDocumentName"));
      return;
    }
    await createNote(dialog.parentId, name);
    setDialog(null);
  }, [createNote, dialog, t]);

  const openNotesSplitPaneCreateDocumentDialog = useCallback((paneId: string) => {
    activateNotesSplitPane(paneId);
    openCreateDocumentDialog();
  }, [activateNotesSplitPane, openCreateDocumentDialog]);

  const openNotesSplitPaneDocumentList = useCallback((paneId: string) => {
    activateNotesSplitPane(paneId);
    setBacklinksTab("notes");
    setPanelOpen(true);
  }, [activateNotesSplitPane]);

  const realVaultImportTargetParentPath = useCallback(() => {
    if (selectedFolderId && selectedFolderId !== "__uncategorized__") return selectedFolderId;
    if (selectedNoteId && isRealVaultNoteId(selectedNoteId)) {
      return realVaultParentPath(realVaultRelativePathFromNoteId(selectedNoteId)) || "";
    }
    return "";
  }, [selectedFolderId, selectedNoteId]);

  const revealRealVaultImportTarget = useCallback((relativePath?: string | null) => {
    const folderId = normalizeVaultRelativePath(relativePath || "");
    setSelectedFolderId(folderId || null);
    if (!folderId) return;
    setRealVaultForceOpenFolderIds([folderId]);
    window.setTimeout(() => setRealVaultForceOpenFolderIds([]), 0);
  }, []);

  const reportAttachmentImport = useCallback((receipt: ImportReceipt) => {
    if (!currentVault) return;
    if (!receipt.copiedCount && !receipt.skippedCount && !receipt.failedCount && !receipt.errors.length) return;
    getVaultAttachmentWorkflow(currentVault.id).recordImport(receipt);
    if (readActiveKnowledgeWriteSource()?.vaultId === currentVault.id) setImportNotice(receipt);
  }, [currentVault]);

  useEffect(() => {
    if (!currentVault) return;
    const workflow = getVaultAttachmentWorkflow(currentVault.id);
    let seenResult = workflow.getSnapshot().result;
    return workflow.subscribe(() => {
      const result = workflow.getSnapshot().result;
      if (result && result !== seenResult) { seenResult = result; void loadRealVaultTree(); }
    });
  }, [currentVault?.id, loadRealVaultTree]);

  const importRealVaultMarkdown = useCallback(async (targetParentOverride?: string | null) => {
    if (!currentVault || !bridge?.importNotesVaultMarkdownFiles) {
      setStatus(t("editor.notes.status.openVaultFirst"));
      return;
    }
    try {
      const targetParentRelativePath = targetParentOverride !== undefined
        ? normalizeVaultRelativePath(targetParentOverride || "")
        : realVaultImportTargetParentPath();
      setStatus(t("editor.notes.status.importingFiles"));
      const result = await bridge.importNotesVaultMarkdownFiles({
        vault: currentVault,
        targetParentRelativePath,
      });
      if (result) reportAttachmentImport(result);
      await loadRealVaultTree();
      revealRealVaultImportTarget(result?.targetParentRelativePath ?? targetParentRelativePath);
      const copied = result?.copiedCount || 0;
      const renamed = result?.conflictRenamedCount || 0;
      const failed = result?.errors?.length || 0;
      if (!copied) {
        setStatus(failed ? t("editor.notes.status.importFilesFailedCount", { count: failed }) : t("editor.notes.status.noMarkdownSelected"));
        return;
      }
      const suffix = [
        renamed ? t("editor.notes.status.conflictFilesRenamed", { count: renamed }) : "",
        failed ? t("editor.notes.status.filesFailed", { count: failed }) : "",
      ].filter(Boolean).join(t("editor.notes.status.summarySeparator"));
      setStatus(t("editor.notes.status.markdownImported", {
        count: copied,
        suffix: suffix ? t("editor.notes.status.summarySuffix", { summary: suffix }) : "",
      }));
    } catch (error) {
      console.warn("[NotesPage] import real vault markdown failed", error);
      setStatus(error instanceof Error ? error.message : t("editor.notes.status.markdownImportFailed"));
    }
  }, [bridge, currentVault, loadRealVaultTree, realVaultImportTargetParentPath, revealRealVaultImportTarget, reportAttachmentImport, t]);

  const importRealVaultMarkdownFolder = useCallback(async (targetParentOverride?: string | null) => {
    if (!currentVault || !bridge?.importNotesVaultMarkdownFolder) {
      setStatus(t("editor.notes.status.openVaultFirst"));
      return;
    }
    try {
      const targetParentRelativePath = targetParentOverride !== undefined
        ? normalizeVaultRelativePath(targetParentOverride || "")
        : realVaultImportTargetParentPath();
      setStatus(t("editor.notes.status.importingFolder"));
      const result = await bridge.importNotesVaultMarkdownFolder({
        vault: currentVault,
        targetParentRelativePath,
      });
      if (result) reportAttachmentImport(result);
      await loadRealVaultTree();
      revealRealVaultImportTarget(result?.targetParentRelativePath ?? targetParentRelativePath);
      const copied = result?.copiedCount || 0;
      const failed = result?.errors?.length || 0;
      if (!copied) {
        setStatus(failed ? t("editor.notes.status.importFilesFailedCount", { count: failed }) : t("editor.notes.status.noMarkdownFolder"));
        return;
      }
      const suffix = failed
        ? t("editor.notes.status.summarySuffix", { summary: t("editor.notes.status.filesFailed", { count: failed }) })
        : "";
      setStatus(t("editor.notes.status.markdownFolderImported", { count: copied, suffix }));
    } catch (error) {
      console.warn("[NotesPage] import real vault markdown folder failed", error);
      setStatus(error instanceof Error ? error.message : t("editor.notes.status.markdownFolderImportFailed"));
    }
  }, [bridge, currentVault, loadRealVaultTree, realVaultImportTargetParentPath, revealRealVaultImportTarget, reportAttachmentImport, t]);

  const importRealVaultDroppedPaths = useCallback(async (targetParentOverride: string | null, sourcePaths: string[]) => {
    if (!currentVault || !bridge?.classifyDroppedPaths || !bridge.importNotesVaultMarkdownFiles || !bridge.importNotesVaultMarkdownFolder) {
      setStatus(t("editor.notes.status.openVaultFirst"));
      return;
    }
    const source = readActiveKnowledgeWriteSource();
    const isCurrent = () => source === readActiveKnowledgeWriteSource();
    const paths = dedupeDroppedLocalPaths(sourcePaths);
    if (!paths.length) {
      setStatus(t("editor.notes.status.noImportPath"));
      return;
    }

    const targetParentRelativePath = normalizeVaultRelativePath(targetParentOverride || "");
    try {
      setStatus(t("editor.notes.status.importingDrop"));
      const classified = await bridge.classifyDroppedPaths(paths);
      if (!isCurrent()) return;
      const filePaths = classified
        .filter((item) => item.isFile && isMarkdownImportPath(item.path))
        .map((item) => item.path);
      const folderPaths = classified
        .filter((item) => item.isDir)
        .map((item) => item.path);

      if (!filePaths.length && !folderPaths.length) {
        setStatus(t("editor.notes.status.dropMarkdownOnly"));
        return;
      }

      let copied = 0;
      let renamed = 0;
      let failed = 0;
      let failedNotes = 0;
      let skipped = 0;
      let revealTarget = targetParentRelativePath;
      const importErrors: ImportReceipt["errors"] = [];

      if (filePaths.length) {
        const result = await bridge.importNotesVaultMarkdownFiles({
          vault: currentVault,
          targetParentRelativePath,
          sourcePaths: filePaths,
        });
        if (!isCurrent()) return;
        copied += result?.copiedCount || 0;
        renamed += result?.conflictRenamedCount || 0;
        failed += result?.errors?.length || 0;
        importErrors.push(...(result?.errors || []));
        failedNotes += result?.failedCount || 0;
        skipped += result?.skippedCount || 0;
        reportAttachmentImport({ copiedCount: copied, failedCount: failedNotes, skippedCount: skipped, conflictRenamedCount: renamed, errors: [...importErrors] });
        revealTarget = result?.targetParentRelativePath ?? revealTarget;
      }

      for (const folderPath of folderPaths) {
        if (!isCurrent()) return;
        const result = await bridge.importNotesVaultMarkdownFolder({
          vault: currentVault,
          targetParentRelativePath,
          sourceDirectoryPath: folderPath,
        });
        if (!isCurrent()) return;
        copied += result?.copiedCount || 0;
        renamed += result?.conflictRenamedCount || 0;
        failed += result?.errors?.length || 0;
        importErrors.push(...(result?.errors || []));
        failedNotes += result?.failedCount || 0;
        skipped += result?.skippedCount || 0;
        reportAttachmentImport({ copiedCount: copied, failedCount: failedNotes, skippedCount: skipped, conflictRenamedCount: renamed, errors: [...importErrors] });
        revealTarget = result?.targetParentRelativePath || revealTarget;
      }

      if (!isCurrent()) return;
      await loadRealVaultTree();
      if (!isCurrent()) return;
      revealRealVaultImportTarget(revealTarget);

      if (!copied) {
        setStatus(failed ? t("editor.notes.status.dropImportFailedCount", { count: failed }) : t("editor.notes.status.dropNoMarkdown"));
        return;
      }
      const suffix = [
        renamed ? t("editor.notes.status.conflictFilesRenamed", { count: renamed }) : "",
        failed ? t("editor.notes.status.itemsFailed", { count: failed }) : "",
      ].filter(Boolean).join(t("editor.notes.status.summarySeparator"));
      setStatus(t("editor.notes.status.dropMarkdownImported", {
        count: copied,
        suffix: suffix ? t("editor.notes.status.summarySuffix", { summary: suffix }) : "",
      }));
    } catch (error) {
      if (!isCurrent()) return;
      console.warn("[NotesPage] import dropped markdown into real vault failed", error);
      setStatus(error instanceof Error ? error.message : t("editor.notes.status.dropMarkdownImportFailed"));
    }
  }, [bridge, currentVault, loadRealVaultTree, revealRealVaultImportTarget, reportAttachmentImport, t]);

  const vaultFileDrop = useVaultFileDrop({
    enabled:visible && !notesNativeViews.hasFrozenViews() && knowledgeStorageMode === 'real-vault' && !!currentVault && !!bridge,
    owner:readActiveKnowledgeWriteSource(),
    defaultParent:realVaultImportTargetParentPath(),
    classify:paths=>bridge!.classifyDroppedPaths(paths),
    importPaths:importRealVaultDroppedPaths,
    insertFiles:files=>void insertDroppedFilesAsAssets(files,readActiveEditorSelection()),
    rejected:setStatus,
  });

  useEffect(()=>setImportNotice(null),[currentVault?.id,currentVault?.rootPath]);

  const exportRealVaultMarkdown = useCallback(async () => {
    if (!currentVault || !bridge?.exportNotesVaultMarkdownFile) {
      setStatus(t("editor.notes.status.openVaultFirst"));
      return;
    }
    if (!selectedNoteId || !isRealVaultNoteId(selectedNoteId)) {
      setStatus(t("editor.notes.status.openExportDocument"));
      return;
    }
    if (realVaultUserDirtyRef.current.has(selectedNoteId)) {
      setStatus(t("editor.notes.status.saveBeforeExport"));
      return;
    }
    try {
      setStatus(t("editor.notes.status.exportingDocument"));
      const relativePath = realVaultRelativePathFromNoteId(selectedNoteId);
      const result = await bridge.exportNotesVaultMarkdownFile({ vault: currentVault, relativePath });
      if (result?.exportedCount) {
        setStatus(result.conflictRenamedCount ? t("editor.notes.status.markdownExportedRenamed") : t("editor.notes.status.markdownExported"));
      } else {
        const failed = result?.errors?.[0]?.message;
        setStatus(failed ? t("editor.notes.status.exportFailedCount", { count: failed }) : t("editor.notes.status.noExportLocation"));
      }
    } catch (error) {
      console.warn("[NotesPage] export real vault markdown failed", error);
      setStatus(error instanceof Error ? error.message : t("editor.notes.status.markdownExportFailed"));
    }
  }, [bridge, currentVault, selectedNoteId, t]);

  const exportRealVaultMarkdownFolder = useCallback(async (folderId: string | null) => {
    if (!currentVault || !bridge?.exportNotesVaultMarkdownFolder) {
      setStatus(t("editor.notes.status.openVaultFirst"));
      return;
    }
    try {
      const relativePath = normalizeVaultRelativePath(folderId || "");
      setStatus(t("editor.notes.status.exportingFolder"));
      const result = await bridge.exportNotesVaultMarkdownFolder({ vault: currentVault, relativePath });
      const exported = result?.exportedCount || 0;
      const failed = result?.errors?.length || 0;
      if (!exported) {
        setStatus(failed ? t("editor.notes.status.exportFilesFailedCount", { count: failed }) : t("editor.notes.status.folderNoMarkdown"));
        return;
      }
      const suffix = failed
        ? t("editor.notes.status.summarySuffix", { summary: t("editor.notes.status.filesFailed", { count: failed }) })
        : "";
      setStatus(t("editor.notes.status.markdownFolderExported", { count: exported, suffix }));
    } catch (error) {
      console.warn("[NotesPage] export real vault markdown folder failed", error);
      setStatus(error instanceof Error ? error.message : t("editor.notes.status.markdownFolderExportFailed"));
    }
  }, [bridge, currentVault, t]);



  const createAndSelectTag = useCallback(async (name: string): Promise<Tag | undefined> => {
    const trimmed = normalizeMarkdownTagName(name);
    if (!trimmed) return;
    if (knowledgeStorageMode === "real-vault") {
      const existing = realVaultTags.find((tag) => tag.name.trim().toLocaleLowerCase() === trimmed.toLocaleLowerCase());
      const tag = existing || { id: realVaultTagId(trimmed), name: trimmed, noteCount: 0 };
      setDialog((current) => current?.kind === "tag"
        ? { kind: "tag", selected: Array.from(new Set([...current.selected, tag.id])) }
        : current);
      setStatus(existing ? t("editor.notes.status.tagExists") : t("editor.notes.status.tagAddedPendingSave"));
      return tag;
    }
    if (!bridge?.createTag) return;
    const existing = allTags.find((tag) => tag.name.trim().toLocaleLowerCase() === trimmed.toLocaleLowerCase());
    if (existing) {
      setDialog((current) => current?.kind === "tag"
        ? { kind: "tag", selected: Array.from(new Set([...current.selected, existing.id])) }
        : current);
      setStatus(t("editor.notes.status.tagExists"));
      return existing;
    }
    try {
      const created = await bridge.createTag({ name: trimmed });
      const refreshed = bridge.listTags ? await bridge.listTags().catch(() => null) : null;
      if (Array.isArray(refreshed)) setAllTags(refreshed);
      else await loadTags();
      if (created?.id) {
        setDialog((current) => current?.kind === "tag"
          ? { kind: "tag", selected: Array.from(new Set([...current.selected, created.id])) }
          : current);
        setStatus(t("editor.notes.status.tagCreated"));
        return created as Tag;
      }
    } catch (error) {
      const refreshed = bridge.listTags ? await bridge.listTags().catch(() => null) : null;
      const recovered = Array.isArray(refreshed)
        ? refreshed.find((tag) => tag.name.trim().toLocaleLowerCase() === trimmed.toLocaleLowerCase())
        : null;
      if (Array.isArray(refreshed)) setAllTags(refreshed);
      if (recovered?.id) {
        setDialog((current) => current?.kind === "tag"
          ? { kind: "tag", selected: Array.from(new Set([...current.selected, recovered.id])) }
          : current);
        setStatus(t("editor.notes.status.tagExists"));
        return recovered as Tag;
      }
      console.warn("[NotesPage] createTag failed", error);
      setStatus(t("editor.notes.status.tagCreateFailed"));
    }
  }, [allTags, bridge, knowledgeStorageMode, loadTags, realVaultTags, t]);

  const createAttachAndOpenTagFromToken = useCallback(async (name: string) => {
    if (knowledgeStorageMode === "real-vault" || (selectedNoteId && isRealVaultNoteId(selectedNoteId))) {
      const tagName = normalizeMarkdownTagName(name);
      if (tagName) setStatus(t("editor.notes.status.tagFromMarkdown", { tag: tagName }));
      return;
    }
    const tag = await createAndSelectTag(name.replace(/^#/, ""));
    if (!tag?.id) return;
    if (selectedNoteId && bridge?.setNoteTags) {
      const next = Array.from(new Set([...noteTags, tag.id]));
      setNoteTags(next);
      try {
        await bridge.setNoteTags(selectedNoteId, next);
        await loadTags();
        setStatus(t("editor.notes.status.tagCreatedAndLinked"));
      } catch (error) {
        console.warn("[NotesPage] attach created tag failed", error);
        setStatus(t("editor.notes.status.tagCreatedLinkFailed"));
      }
    }
    openTagFromEditor(tag.id);
  }, [bridge, createAndSelectTag, knowledgeStorageMode, loadTags, noteTags, openTagFromEditor, selectedNoteId, t]);

  const openEditorToken = useCallback((token: LiveEditorTokenContext) => {
    setEditorCtx(null);
    if (token.kind === "asset") {
      if (token.assetId) locateAssetInLibrary(token.assetId);
      else setStatus(t("editor.notes.status.materialNotFound"));
      return;
    }
    if (token.kind === "note") {
      if (token.noteId) openNoteFromInlineLink(token.noteId, token.openOptions);
      else {
        const title = (token.createTitle || token.label).split("#")[0].trim();
        if (title) void createLinkedNote(title, {
          contentText: initialContentForMissingNoteAnchor(
            token.openOptions,
            (block) => t("editor.notes.context.pendingBlock", { block }),
          ),
          openOptions: token.openOptions,
        });
        else setStatus(t("editor.notes.status.noteNotFound"));
      }
      return;
    }
    if (token.kind === "tag") {
      if (token.tagId) openTagFromEditor(token.tagId);
      else void createAttachAndOpenTagFromToken(token.label);
      return;
    }
    if (token.kind === "external") {
      if (token.href) {
        window.open(token.href, "_blank", "noopener,noreferrer");
        setStatus(t("editor.notes.status.externalOpened"));
      } else {
        setStatus(t("editor.notes.status.externalAddressMissing"));
      }
    }
  }, [createAttachAndOpenTagFromToken, createLinkedNote, locateAssetInLibrary, openNoteFromInlineLink, openTagFromEditor, t]);

  const openNoteTokenInBackgroundTab = useCallback((token: LiveEditorTokenContext) => {
    setEditorCtx(null);
    if (token.kind !== "note" || !token.noteId) {
      setStatus(t("editor.notes.status.noteNotFound"));
      return;
    }
    setOpenTabs((current) => (
      current.some((tab) => tab.id === token.noteId)
        ? current
        : [...current, { id: token.noteId! }]
    ));
    setStatus(t("editor.notes.status.openedInTabBar"));
  }, [t]);

  const copyEditorTokenMarkdown = useCallback(async (token: LiveEditorTokenContext) => {
    setEditorCtx(null);
    const content = readActiveEditorValue();
    const text = content.slice(token.from, token.to);
    try {
      await navigator.clipboard.writeText(text);
      setStatus(t("editor.notes.status.referenceCopied"));
    } catch (error) {
      console.warn("[NotesPage] copy editor token failed", error);
      setStatus(t("editor.notes.status.copyFailed"));
    }
  }, [readActiveEditorValue, t]);

  const copyEditorTokenLabel = useCallback(async (token: LiveEditorTokenContext) => {
    setEditorCtx(null);
    const text = token.label.trim();
    if (!text) {
      setStatus(t("editor.notes.status.noNameToCopy"));
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setStatus(token.kind === "asset" ? t("editor.notes.status.materialNameCopied") : t("editor.notes.status.nameCopied"));
    } catch (error) {
      console.warn("[NotesPage] copy editor token label failed", error);
      setStatus(t("editor.notes.status.copyFailed"));
    }
  }, [t]);

  const copyEditorTokenTarget = useCallback(async (token: LiveEditorTokenContext) => {
    setEditorCtx(null);
    const markdown = readActiveEditorValue().slice(token.from, token.to);
    let text = "";
    if (token.kind === "note") {
      const parsed = parseWikiLinkMarkdownToken(markdown);
      text = parsed?.target ? `[[${parsed.target}]]` : "";
    } else if (token.kind === "external") {
      const parsed = parseExternalLinkMarkdownToken(markdown);
      text = parsed?.href || token.href || "";
    }
    if (!text) {
      setStatus(t("editor.notes.status.noLinkTarget"));
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setStatus(token.kind === "external" ? t("editor.notes.status.linkAddressCopied") : t("editor.notes.status.linkTargetCopied"));
    } catch (error) {
      console.warn("[NotesPage] copy editor token target failed", error);
      setStatus(t("editor.notes.status.copyFailed"));
    }
  }, [readActiveEditorValue, t]);

  const openLinkAliasDialog = useCallback((token: LiveEditorTokenContext) => {
    setEditorCtx(null);
    const markdown = readActiveEditorValue().slice(token.from, token.to);
    if (token.kind === "external") {
      const parsed = parseExternalLinkMarkdownToken(markdown);
      if (!parsed) {
        setStatus(t("editor.notes.status.externalNotEditable"));
        return;
      }
      setLinkAliasDialog({ kind: "external", token, title: parsed.title, href: parsed.href });
      return;
    }

    const parsed = parseWikiLinkMarkdownToken(markdown);
    if (!parsed) {
      setStatus(t("editor.notes.status.linkTextNotEditable"));
      return;
    }
    setLinkAliasDialog({ kind: "wiki", token, target: parsed.target, alias: parsed.alias });
  }, [readActiveEditorValue, t]);

  const saveLinkAliasDialog = useCallback(() => {
    if (!linkAliasDialog) return;
    if (linkAliasDialog.kind === "external") {
      const title = linkAliasDialog.title.trim() || linkAliasDialog.href.trim() || t("editor.notes.context.linkFallback");
      const href = linkAliasDialog.href.trim();
      if (!/^https?:\/\//i.test(href)) {
        setStatus(t("editor.notes.status.invalidExternalLink"));
        return;
      }
      replaceEditorRange(`[${title}](${href})`, { start: linkAliasDialog.token.from, end: linkAliasDialog.token.to });
      setLinkAliasDialog(null);
      setStatus(t("editor.notes.status.externalUpdated"));
      return;
    }

    const target = linkAliasDialog.target.trim();
    if (!target) {
      setStatus(t("editor.notes.status.noteTargetEmpty"));
      return;
    }
    if (/[\]\r\n]/.test(target)) {
      setStatus(t("editor.notes.status.noteTargetInvalid"));
      return;
    }
    const alias = linkAliasDialog.alias.trim();
    const replacement = `[[${target}${alias ? `|${alias}` : ""}]]`;
    replaceEditorRange(replacement, { start: linkAliasDialog.token.from, end: linkAliasDialog.token.to });
    setLinkAliasDialog(null);
    setStatus(alias ? t("editor.notes.status.noteReferenceUpdated") : t("editor.notes.status.noteTargetUpdated"));
  }, [linkAliasDialog, replaceEditorRange, t]);

  const openTagRenameDialog = useCallback((token: LiveEditorTokenContext) => {
    setEditorCtx(null);
    if (token.kind !== "tag" || !token.tagId) {
      setStatus(t("editor.notes.status.tagNotCreated"));
      return;
    }
    const name = token.label.trim().replace(/^#/, "");
    setTagRenameDialog({
      token,
      tagId: token.tagId,
      originalName: name,
      name,
    });
  }, [t]);

  const saveTagRenameDialog = useCallback(async () => {
    if (!tagRenameDialog) return;
    const nextName = tagRenameDialog.name.trim().replace(/^#/, "");
    if (!nextName) {
      setStatus(t("editor.notes.status.tagNameEmpty"));
      return;
    }
    if (nextName === tagRenameDialog.originalName) {
      setTagRenameDialog(null);
      return;
    }
    if (!bridge?.updateTag && !bridge?.renameTag) {
      setStatus(t("editor.notes.status.tagRenameUnsupported"));
      return;
    }

    try {
      setStatus(t("editor.notes.status.tagRenaming"));
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      pendingPatchRef.current = {};
      pendingPatchNoteIdRef.current = null;
      if (selectedNoteId) {
        await savePatch({ title: editTitle, contentText: readActiveEditorValue() });
      }

      const updated = bridge.updateTag
        ? await bridge.updateTag(tagRenameDialog.tagId, { name: nextName })
        : await bridge.renameTag(tagRenameDialog.tagId, nextName);
      if (!updated) {
        setStatus(t("editor.notes.status.tagRenameFailed"));
        return;
      }

      await loadTags();
      await loadNotes();
      setTagRenameDialog(null);
      setStatus(t("editor.notes.status.tagRenamed"));
    } catch (error) {
      console.warn("[NotesPage] rename tag from editor token failed", error);
      setStatus(error instanceof Error ? error.message : t("editor.notes.status.tagRenameFailed"));
    }
  }, [bridge, editTitle, loadNotes, loadTags, readActiveEditorValue, savePatch, selectedNoteId, tagRenameDialog, t]);

  const removeEditorToken = useCallback((token: LiveEditorTokenContext) => {
    setEditorCtx(null);
    const currentContent = readActiveEditorValue();
    const nextContent = `${currentContent.slice(0, token.from)}${currentContent.slice(token.to)}`;
    replaceEditorRange("", { start: token.from, end: token.to });
    if (token.kind === "tag" && token.tagId && selectedNoteId && !isRealVaultNoteId(selectedNoteId) && bridge?.setNoteTags) {
      const tagStillInMarkdown = hasMarkdownTagReferencesInText(nextContent, token.label);
      if (!tagStillInMarkdown && noteTags.includes(token.tagId)) {
        const nextTags = noteTags.filter((id) => id !== token.tagId);
        setNoteTags(nextTags);
        bridge.setNoteTags(selectedNoteId, nextTags)
          .then(() => loadTags())
          .catch((error) => {
            console.warn("[NotesPage] detach removed editor tag failed", error);
            setStatus(t("editor.notes.status.tagReferenceRemovedSyncFailed"));
          });
      }
    }
    setStatus(token.kind === "tag" ? t("editor.notes.status.tagReferenceRemoved") : token.kind === "external" ? t("editor.notes.status.externalRemoved") : t("editor.notes.status.referenceRemoved"));
  }, [bridge, loadTags, noteTags, readActiveEditorValue, replaceEditorRange, selectedNoteId, t]);

  const realVaultHasUnsavedChanges = useCallback((noteId: string) => (
    realVaultUserDirtyRef.current.has(noteId)
    || (pendingPatchNoteIdRef.current === noteId && Object.keys(pendingPatchRef.current).length > 0)
  ), []);

  const blockRealVaultDocumentOperationIfDirty = useCallback((noteId: string) => {
    if (!realVaultHasUnsavedChanges(noteId)) return false;
    setStatus(t("editor.notes.status.saveBeforeFileAction"));
    return true;
  }, [realVaultHasUnsavedChanges, t]);

  const moveRealVaultRuntimeEntry = useCallback((oldNoteId: string, newNoteId: string) => {
    if (oldNoteId === newNoteId) return;
    const saved = realVaultSavedContentRef.current.get(oldNoteId);
    if (saved !== undefined) {
      realVaultSavedContentRef.current.set(newNoteId, saved);
      realVaultSavedContentRef.current.delete(oldNoteId);
    }
    const latest = realVaultLatestContentRef.current.get(oldNoteId);
    if (latest !== undefined) {
      realVaultLatestContentRef.current.set(newNoteId, latest);
      realVaultLatestContentRef.current.delete(oldNoteId);
    }
    if (realVaultUserDirtyRef.current.has(oldNoteId)) {
      realVaultUserDirtyRef.current.delete(oldNoteId);
      realVaultUserDirtyRef.current.add(newNoteId);
    }
    if (realVaultKeepEditingAfterConflictRef.current.has(oldNoteId)) {
      realVaultKeepEditingAfterConflictRef.current.delete(oldNoteId);
      realVaultKeepEditingAfterConflictRef.current.add(newNoteId);
    }
    setRealVaultExternalConflict((current) => current?.noteId === oldNoteId ? { ...current, noteId: newNoteId } : current);
  }, []);

  const applyRealVaultDocumentPathChange = useCallback((oldNoteId: string, document: KnowledgeDocument) => {
    const nextNote = noteFromKnowledgeDocument(document, t("editor.notes.untitled"));
    const newNoteId = nextNote.id;
    moveRealVaultRuntimeEntry(oldNoteId, newNoteId);
    liveEditorRef.current?.renameDocument(oldNoteId, newNoteId);
    for (const refs of notesViewRefsRef.current.values()) refs.live.current?.renameDocument(oldNoteId, newNoteId);
    notesPaneViewsRef.current.renameDocument(oldNoteId, newNoteId);
    setNamingNoteId(current => current === oldNoteId ? newNoteId : current);
    setOpenTabs((current) => current.map((tab) => tab.id === oldNoteId ? { ...tab, id: newNoteId, kind: "note" } : tab));
    setNotes((current) => {
      const filtered = current.filter((note) => note.id !== oldNoteId && note.id !== newNoteId);
      return [...filtered, nextNote];
    });
    if (selectedNoteIdRef.current === oldNoteId) {
      selectedNoteIdRef.current = newNoteId;
      selectedNoteRef.current = nextNote;
      noteLoadRequestRef.current += 1;
      setSelectedNoteId(newNoteId);
      setSelectedNote(nextNote);
      setEditTitle(nextNote.title || "");
      setEditContent(nextNote.contentText || "");
      setSourceContentDraft(null);
      realVaultSavedContentRef.current.set(newNoteId, nextNote.contentText || "");
      realVaultLatestContentRef.current.set(newNoteId, nextNote.contentText || "");
      realVaultUserDirtyRef.current.delete(newNoteId);
    }
    return newNoteId;
  }, [moveRealVaultRuntimeEntry, t]);

  const rewriteRealVaultFolderRuntimePaths = useCallback((oldFolderPath: string, newFolderPath: string) => {
    const oldPrefix = normalizeVaultRelativePath(oldFolderPath);
    const newPrefix = normalizeVaultRelativePath(newFolderPath);
    if (!oldPrefix || oldPrefix === newPrefix) return null;
    const rewriteNoteId = (noteId: string) => {
      if (!isRealVaultNoteId(noteId)) return noteId;
      const relativePath = normalizeVaultRelativePath(realVaultRelativePathFromNoteId(noteId));
      if (!relativePath.startsWith(`${oldPrefix}/`)) return noteId;
      return realVaultNoteId(`${newPrefix}/${relativePath.slice(oldPrefix.length + 1)}`);
    };
    const remapKeys = (ids: string[]) => {
      ids.forEach((oldNoteId) => {
        const newNoteId = rewriteNoteId(oldNoteId);
        if (newNoteId !== oldNoteId) moveRealVaultRuntimeEntry(oldNoteId, newNoteId);
      });
    };
    remapKeys(Array.from(realVaultSavedContentRef.current.keys()));
    remapKeys(Array.from(realVaultLatestContentRef.current.keys()));
    remapKeys(Array.from(realVaultUserDirtyRef.current));
    remapKeys(Array.from(realVaultKeepEditingAfterConflictRef.current));
    setOpenTabs((current) => current.map((tab) => {
      const newId = rewriteNoteId(tab.id);
      return newId === tab.id ? tab : { ...tab, id: newId, kind: "note" };
    }));
    setNotes((current) => current.map((note) => {
      const newId = rewriteNoteId(note.id);
      if (newId === note.id) return note;
      const relativePath = realVaultRelativePathFromNoteId(newId);
      return { ...note, id: newId, folderId: realVaultParentPath(relativePath) };
    }));
    const currentId = selectedNoteIdRef.current;
    if (!currentId) return null;
    const nextSelectedId = rewriteNoteId(currentId);
    if (nextSelectedId === currentId) return null;
    setSelectedNoteId(nextSelectedId);
    setSelectedNote((current) => {
      if (!current || current.id !== currentId) return current;
      const relativePath = realVaultRelativePathFromNoteId(nextSelectedId);
      return { ...current, id: nextSelectedId, folderId: realVaultParentPath(relativePath) };
    });
    return nextSelectedId;
  }, [moveRealVaultRuntimeEntry]);

  const vaultAbsolutePath = useCallback((relativePath: string | null | undefined) => {
    if (!currentVault) return "";
    const root = currentVault.rootPath.replace(/[\\/]+$/, "");
    const normalized = normalizeVaultRelativePath(relativePath || "");
    return normalized ? `${root}\\${normalized.replace(/\//g, "\\")}` : root;
  }, [currentVault]);

  const copyNote = useCallback(async (note: Note) => {
    if (isRealVaultNoteId(note.id)) {
      if (blockRealVaultDocumentOperationIfDirty(note.id)) return;
      const relativePath = realVaultRelativePathFromNoteId(note.id);
      const parentPath = realVaultParentPath(relativePath) || "";
      const fileName = relativePath.split("/").pop() || `${noteTitle(note)}.md`;
      const baseName = stripMarkdownExtension(fileName).trim() || noteTitle(note);
      try {
        const source = await realVaultDocumentSource.openDocument(relativePath);
        let created: KnowledgeDocument | null = null;
        let lastError: unknown = null;
        for (let attempt = 1; attempt <= 50; attempt += 1) {
          const suffix = attempt === 1
            ? t("editor.notes.copy.suffix")
            : t("editor.notes.copy.suffixNumber", { count: attempt });
          try {
            created = await realVaultDocumentSource.createDocument(parentPath, `${baseName}${suffix}.md`);
            break;
          } catch (error) {
            lastError = error;
            if (!/already-exists/i.test(String(error))) throw error;
          }
        }
        if (!created) throw lastError || new Error(t("editor.notes.status.copyDocumentFailed"));
        const savedDocument = await writeRealVaultDocumentIfAllowed("explicit-save", created, source.contentText || "");
        const nextDocument = savedDocument || created;
        await loadRealVaultTree();
        const newNoteId = realVaultNoteId(nextDocument.relativePath || nextDocument.id);
        realVaultSavedContentRef.current.set(newNoteId, nextDocument.contentText || source.contentText || "");
        realVaultLatestContentRef.current.set(newNoteId, nextDocument.contentText || source.contentText || "");
        realVaultUserDirtyRef.current.delete(newNoteId);
        await selectNote(newNoteId, { scrollList: true, tabMode: "open" });
        setStatus(t("editor.notes.status.markdownCopied"));
      } catch (error) {
        console.warn("[NotesPage] copy real vault markdown failed", error);
        setStatus(error instanceof Error ? error.message : t("editor.notes.status.markdownCopyFailed"));
      }
      return;
    }
    if (!bridge?.createNote) return;
    try {
      const created = await bridge.createNote({
        title: `${noteTitle(note)} ${t("editor.notes.copy.parentheticalSuffix")}`,
        contentText: note.contentText || "",
        contentJson: note.contentJson || "",
        folderId: note.folderId,
      });
      await loadNotes();
      if (created?.id) await selectNote(created.id, { scrollList: true });
    } catch (error) {
      console.warn("[NotesPage] copyNote failed", error);
    }
  }, [blockRealVaultDocumentOperationIfDirty, bridge, loadNotes, loadRealVaultTree, realVaultDocumentSource, selectNote, writeRealVaultDocumentIfAllowed, t]);

  const copyTextToClipboard = useCallback(async (text: string, successStatus: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus(successStatus);
    } catch (error) {
      console.warn("[NotesPage] copy text failed", error);
      setStatus(t("editor.notes.status.copyFailed"));
    }
  }, [t]);

  const openRealVaultDocumentWithDefaultApp = useCallback(async (note: Note) => {
    if (!isRealVaultNoteId(note.id)) return;
    if (!currentVault || !bridge?.openNotesVaultMarkdownFileWithDefaultApp) {
      setStatus(t("editor.notes.status.openVaultFirst"));
      return;
    }
    const relativePath = realVaultRelativePathFromNoteId(note.id);
    try {
      await bridge.openNotesVaultMarkdownFileWithDefaultApp({ vault: currentVault, relativePath });
      setStatus(t("editor.notes.status.markdownOpened"));
    } catch (error) {
      console.warn("[NotesPage] open real vault markdown with default app failed", error);
      const message = error instanceof Error ? error.message : String(error || "");
      setStatus(message
        ? t("editor.notes.status.openMarkdownFailedWithError", { error: message })
        : t("editor.notes.status.openMarkdownFailed"));
    }
  }, [bridge, currentVault, t]);

  const deleteNote = useCallback(async (note: Note) => {
    if (isRealVaultNoteId(note.id)) {
      if (blockRealVaultDocumentOperationIfDirty(note.id)) {
        setConfirmDelete(null);
        return;
      }
      const wasSelected = selectedNoteIdRef.current === note.id;
      try {
        await realVaultDocumentSource.deleteDocument(realVaultRelativePathFromNoteId(note.id));
        realVaultSavedContentRef.current.delete(note.id);
        realVaultLatestContentRef.current.delete(note.id);
        realVaultUserDirtyRef.current.delete(note.id);
        realVaultKeepEditingAfterConflictRef.current.delete(note.id);
        setRealVaultExternalConflict((current) => current?.noteId === note.id ? null : current);
        setConfirmDelete(null);
        setNotes((current) => current.filter((item) => item.id !== note.id));
        setOpenTabs((current) => {
          const next = current.filter((tab) => tab.id !== note.id);
          return next.length ? next : [createEmptyNoteTab()];
        });
        await loadRealVaultTree();
        if (wasSelected) showEmptyTab(undefined, { ensureOpen: true });
        setStatus(t("editor.notes.status.markdownDeleted"));
      } catch (error) {
        console.warn("[NotesPage] delete real vault markdown failed", error);
        setStatus(error instanceof Error ? error.message : t("editor.notes.status.markdownDeleteFailed"));
      }
      return;
    }
    if (!bridge?.deleteNote) return;
    const nextId = notes.find((item) => item.id !== note.id)?.id || null;
    setConfirmDelete(null);
    setNotes((current) => current.filter((item) => item.id !== note.id));
    if (selectedNoteId === note.id) {
      setSelectedNoteId(nextId);
      setSelectedNote(null);
      setEditTitle("");
      setEditContent("");
      if (nextId) void selectNote(nextId);
      else {
        noteLoadRequestRef.current += 1;
        relationRequestRef.current += 1;
        setNoteTags([]);
        setSourceContentDraft(null);
        setAutocomplete(null);
        setBacklinks([]);
        setUnlinkedMentions([]);
        setNoteLinks([]);
        setNoteEmbeds([]);
        setAssetsForNote([]);
        setAiPanelOpen(false);
        setAiSuggestion(null);
      }
    }
    setOpenTabs((current) => {
      const next = current.filter((tab) => tab.id !== note.id);
      return next;
    });
    try {
      await bridge.deleteNote(note.id);
      setStatus(t("editor.notes.status.deleted"));
    } catch (error) {
      console.warn("[NotesPage] deleteNote failed", error);
      setStatus(t("editor.notes.status.deleteFailed"));
      void loadNotes();
    }
  }, [blockRealVaultDocumentOperationIfDirty, bridge, loadNotes, loadRealVaultTree, notes, realVaultDocumentSource, selectNote, selectedNoteId, showEmptyTab, t]);

  const moveNote = useCallback(async (noteId: string, folderId: string | null) => {
    if (isRealVaultNoteId(noteId)) {
      if (blockRealVaultDocumentOperationIfDirty(noteId)) return;
      setMoveModal(null);
      try {
        const document = await realVaultDocumentSource.moveDocument(realVaultRelativePathFromNoteId(noteId), folderId || "");
        const newNoteId = applyRealVaultDocumentPathChange(noteId, document);
        await loadRealVaultTree();
        if (selectedNoteIdRef.current === newNoteId || selectedNoteIdRef.current === noteId) {
          await selectNote(newNoteId, { scrollList: true });
        }
        setStatus(t("editor.notes.status.markdownMoved"));
      } catch (error) {
        console.warn("[NotesPage] move real vault markdown failed", error);
        setStatus(error instanceof Error ? error.message : t("editor.notes.status.markdownMoveFailed"));
      }
      return;
    }
    if (!bridge?.moveNoteToFolder) return;
    updateNoteLocal(noteId, { folderId, updatedAt: new Date().toISOString() });
    setMoveModal(null);
    try {
      await bridge.moveNoteToFolder({ noteId, folderId });
      setStatus(t("editor.notes.status.moved"));
      void loadNotes();
    } catch (error) {
      console.warn("[NotesPage] moveNoteToFolder failed", error);
      setStatus(t("editor.notes.status.moveFailed"));
    }
  }, [applyRealVaultDocumentPathChange, blockRealVaultDocumentOperationIfDirty, bridge, loadNotes, loadRealVaultTree, realVaultDocumentSource, selectNote, updateNoteLocal, t]);

  const commitFilename = useCallback(async (documentId: string, name: string) => {
    if (!isRealVaultNoteId(documentId)) throw new Error(t("editor.notes.status.legacyRenameUnavailable"));
    if (renamingNoteRef.current) throw new Error("正在重命名，请稍后重试");
    renamingNoteRef.current = documentId;
    setRenamingNoteId(documentId);
    try {
      const source = readActiveKnowledgeWriteSource();
      if (selectedNoteIdRef.current === documentId) { commitCurrentEditorDraftRef.current(); flushPendingSave(); }
      await saveAffectedAttachmentNotes([realVaultRelativePathFromNoteId(documentId)]);
      if (source !== readActiveKnowledgeWriteSource()) throw new Error("知识库已切换，请在当前笔记中重试");
      if (blockRealVaultDocumentOperationIfDirty(documentId)) throw new Error(t("editor.notes.status.saveBeforeFileAction"));
      const document = await realVaultDocumentSource.renameDocument(realVaultRelativePathFromNoteId(documentId), name);
      if (source !== readActiveKnowledgeWriteSource()) return;
      const newNoteId = applyRealVaultDocumentPathChange(documentId, document);
      setRenamingNoteId(newNoteId);
      await loadRealVaultTree({ silent: true, fresh: true });
      return newNoteId;
    } finally { renamingNoteRef.current = null; setRenamingNoteId(null); }
  }, [flushPendingSave, saveAffectedAttachmentNotes, blockRealVaultDocumentOperationIfDirty, realVaultDocumentSource, applyRealVaultDocumentPathChange, loadRealVaultTree, t]);

  const renameDocumentFromTree = useCallback(async (documentId: string, name: string) => {
    const nextName = name.trim();
    if (!nextName) return;
    if (isRealVaultNoteId(documentId)) {
      if (blockRealVaultDocumentOperationIfDirty(documentId)) return;
      try {
        const document = await realVaultDocumentSource.renameDocument(realVaultRelativePathFromNoteId(documentId), nextName);
        const newNoteId = applyRealVaultDocumentPathChange(documentId, document);
        await loadRealVaultTree();
        if (selectedNoteIdRef.current === newNoteId || selectedNoteIdRef.current === documentId) {
          await selectNote(newNoteId, { scrollList: true });
        }
        setStatus(t("editor.notes.status.markdownRenamed"));
      } catch (error) {
        console.warn("[NotesPage] rename real vault markdown failed", error);
        setStatus(error instanceof Error ? error.message : t("editor.notes.status.markdownRenameFailed"));
      }
      return;
    }
    setStatus(t("editor.notes.status.legacyRenameUnavailable"));
  }, [applyRealVaultDocumentPathChange, blockRealVaultDocumentOperationIfDirty, loadRealVaultTree, realVaultDocumentSource, selectNote, t]);

  const renameFolderFromTree = useCallback(async (folderId: string, name: string) => {
    const nextName = name.trim();
    if (!nextName) return;
    try {
      const folder = await realVaultDocumentSource.renameFolder(folderId, nextName);
      const nextPath = normalizeVaultRelativePath(folder.relativePath || folder.id);
      const nextSelectedId = rewriteRealVaultFolderRuntimePaths(folderId, nextPath);
      await loadRealVaultTree();
      if (nextSelectedId) await selectNote(nextSelectedId, { scrollList: true });
      setSelectedFolderId((current) => current === folderId ? nextPath : current);
      setStatus(t("editor.notes.status.folderRenamed"));
    } catch (error) {
      console.warn("[NotesPage] rename real vault folder failed", error);
      setStatus(error instanceof Error ? error.message : t("editor.notes.status.folderRenameFailed"));
    }
  }, [loadRealVaultTree, realVaultDocumentSource, rewriteRealVaultFolderRuntimePaths, selectNote, t]);

  const moveFolderFromTree = useCallback(async (folderId: string, targetFolderId: string | null) => {
    try {
      const folder = await realVaultDocumentSource.moveFolder(folderId, targetFolderId || "");
      const nextPath = normalizeVaultRelativePath(folder.relativePath || folder.id);
      const nextSelectedId = rewriteRealVaultFolderRuntimePaths(folderId, nextPath);
      await loadRealVaultTree();
      if (nextSelectedId) await selectNote(nextSelectedId, { scrollList: true });
      setSelectedFolderId((current) => current === folderId ? nextPath : current);
      setStatus(t("editor.notes.status.folderMoved"));
    } catch (error) {
      console.warn("[NotesPage] move real vault folder failed", error);
      setStatus(error instanceof Error ? error.message : t("editor.notes.status.folderMoveFailed"));
    }
  }, [loadRealVaultTree, realVaultDocumentSource, rewriteRealVaultFolderRuntimePaths, selectNote, t]);

  const deleteFolderFromTree = useCallback(async (folderId: string) => {
    try {
      await realVaultDocumentSource.deleteFolder(folderId);
      setSelectedFolderId((current) => current === folderId ? null : current);
      await loadRealVaultTree();
      setStatus(t("editor.notes.status.emptyFolderDeleted"));
    } catch (error) {
      console.warn("[NotesPage] delete real vault folder failed", error);
      setStatus(error instanceof Error ? error.message : t("editor.notes.status.folderDeleteFailed"));
    }
  }, [loadRealVaultTree, realVaultDocumentSource, t]);

  const saveRealVaultTagNames = useCallback(async (
    noteId: string,
    tagNames: string[],
    editorContent: string,
  ) => {
    if (!currentVault || !isRealVaultNoteId(noteId)) {
      throw new Error(t("editor.notes.status.setupOrOpenVault"));
    }
    const relativePath = realVaultRelativePathFromNoteId(noteId);
    const indexed = realVaultMarkdownIndex?.documents.find((document) => (
      normalizeVaultRelativePath(document.relativePath) === normalizeVaultRelativePath(relativePath)
    ));
    if (!indexed?.revision) {
      throw new Error(t("editor.notes.status.indexMissingCurrentDocument"));
    }
    const baseline = realVaultSavedContentRef.current.get(noteId);
    if (baseline === undefined) {
      throw new Error(t("editor.notes.status.saveBeforeTags"));
    }
    const normalizedTags = uniqueMarkdownTagNames(tagNames);
    const origin={source:readActiveKnowledgeWriteSource(),generation:vaultSessionRef.current.latest()};
    const result = await commitKnowledgeDocumentTags({
      documentRef: { vaultId: currentVault.id, relativePath },
      expectedRevision: indexed.revision,
      tags: normalizedTags,
      editorContent,
      savedContent: baseline,
    });
    acknowledgeSavedReadProof(noteId,result.document.content,result.document.revision,origin);
    setRealVaultMarkdownIndex((current) => {
      if (!current || current.vaultId !== currentVault.id) return current;
      return {
        ...current,
        documents: current.documents.map((document) => (
          normalizeVaultRelativePath(document.relativePath) === normalizeVaultRelativePath(relativePath)
            ? {
              ...document,
              revision: result.document.revision,
              size: result.document.size,
              mtime: result.document.modifiedAt,
              frontmatterTags: normalizedTags,
              tags: uniqueMarkdownTagNames([...normalizedTags, ...document.inlineTags]),
            }
            : document
        )),
      };
    });
    return {
      contentText: result.document.content,
      note: noteFromKnowledgeDocument({
        id: relativePath,
        title: result.document.title,
        contentText: result.document.content,
        relativePath,
        source: "real-vault",
      }, t("editor.notes.untitled")),
      mutation: result,
    };
  }, [currentVault, realVaultMarkdownIndex, t]);

  const saveTagSelection = useCallback(async (
    tagIds: string[],
    successMessage = t("editor.notes.status.tagsWrittenMarkdown"),
  ) => {
    if (!selectedNoteId) return false;
    if (knowledgeStorageMode === "real-vault" || isRealVaultNoteId(selectedNoteId)) {
      if (!isRealVaultNoteId(selectedNoteId)) return false;
      const tagNames = uniqueMarkdownTagNames(tagIds.map(realVaultTagNameFromId));
      const currentContent = readActiveEditorValue();
      setDialog(null);
      const noteId = selectedNoteId;
      setSaving(true);
      try {
        const outcome = await runKnowledgeTagMutationForStatus(
          () => saveRealVaultTagNames(noteId, tagNames, currentContent),
          successMessage,
          setStatus,
        );
        const saved = outcome.value;
        const nextContent = saved.contentText;
        const savedNote = saved.note;
        realVaultSavedContentRef.current.set(noteId, nextContent);
        realVaultLatestContentRef.current.set(noteId, nextContent);
        realVaultUserDirtyRef.current.delete(noteId);
        realVaultKeepEditingAfterConflictRef.current.delete(noteId);
        setRealVaultExternalConflict((current) => current?.noteId === noteId ? null : current);
        setEditContent(nextContent);
        setSourceContentDraft(editorMode === "source" ? nextContent : null);
        updateNoteLocal(noteId, {
          ...savedNote,
          contentText: nextContent,
          contentJson: nextContent,
        });
        if (!saved.mutation.indexWarning && !saved.mutation.indexStale) {
          await refreshRealVaultMarkdownIndex();
        }
        return true;
      } catch (error) {
        console.warn("[NotesPage] save real vault tags failed", error);
        setStatus(error instanceof Error ? error.message : t("editor.notes.status.tagSaveFailed"));
        return false;
      } finally {
        setSaving(false);
      }
    }

    if (!bridge?.setNoteTags) return false;
    setNoteTags(tagIds);
    setDialog(null);
    try {
      await bridge.setNoteTags(selectedNoteId, tagIds);
      await loadTags();
      setStatus(t("editor.notes.status.tagsUpdated"));
      return true;
    } catch (error) {
      console.warn("[NotesPage] setNoteTags failed", error);
      setStatus(t("editor.notes.status.tagSaveFailed"));
      return false;
    }
  }, [bridge, editorMode, knowledgeStorageMode, loadTags, readActiveEditorValue, refreshRealVaultMarkdownIndex, saveRealVaultTagNames, selectedNoteId, updateNoteLocal, t]);

  const removeTag = useCallback((tagId: string) => {
    void saveTagSelection(activeNoteTags.filter((id) => id !== tagId));
  }, [activeNoteTags, saveTagSelection]);

  const createFolderFromDialog = useCallback(async () => {
    if (dialog?.kind !== "folder") return;
    const name = dialog.name.trim();
    if (!name) return;
    try {
      await realVaultDocumentSource.createFolder(dialog.parentId || "", name);
      await loadRealVaultTree();
      setDialog(null);
    } catch (error) {
      console.warn("[NotesPage] create real vault folder failed", error);
      setStatus(error instanceof Error ? error.message : t("editor.notes.status.folderCreateFailed"));
    }
  }, [dialog, loadRealVaultTree, realVaultDocumentSource, t]);

  const generateAiSuggestion = useCallback(async (request?: NotesPaneAiRequest) => {
    const noteId = request?.noteId || selectedNoteId;
    if (!noteId) return;
    const paneId = request?.paneId || (notesPaneLayout ? activeNotesSplitPane : null);
    const isStillVisible = () => paneId
      ? activeNotesSplitPaneRef.current === paneId && selectedNoteIdRef.current === noteId
      : selectedNoteIdRef.current === noteId;
    const updatePane = (patch: Partial<Omit<NotesPaneAiState, "noteId">>) => {
      if (paneId) updateNotesPaneAiState(paneId, noteId, patch);
    };
    const complete = (suggestion: NoteAiSuggestionState, message?: string) => {
      updatePane({ panelOpen: true, busy: false, suggestion, selectedTags: null });
      if (isStillVisible()) {
        setAiPanelOpen(true);
        setAiSuggestion(suggestion);
        setAiSelectedTags(null);
        setAiBusy(false);
        if (message) setStatus(message);
      }
    };
    const fail = (message: string, error?: string) => {
      complete({ noteId, status: "error", error: error || message }, message);
    };
    const requestContent = request?.contentText ?? readActiveEditorValue();
    const requestTitle = request?.title || selectedNote?.title || markdownTitleFromPath(noteId, t("editor.notes.untitled"));
    const indexDocument = isRealVaultNoteId(noteId)
      ? realVaultMarkdownIndex?.documents.find((document) => realVaultNoteId(document.relativePath) === noteId)
      : null;
    const requestTagNames = isRealVaultNoteId(noteId)
      ? extractFrontmatterTagNamesForRealVault(requestContent)
      : indexDocument?.frontmatterTags || (selectedNoteId === noteId ? currentRealVaultTagNames : []);
    updatePane({ panelOpen: true, busy: true, suggestion: null, selectedTags: null });
    if (isStillVisible()) {
      setAiPanelOpen(true);
      setAiSuggestion(null);
      setAiSelectedTags(null);
      setAiBusy(true);
    }
    try {
      if (knowledgeStorageMode === "real-vault" || isRealVaultNoteId(noteId)) {
        if (!isRealVaultNoteId(noteId)) {
          fail(t("editor.notes.status.openVaultDocumentFirst"));
          return;
        }
        if (!bridge?.aiChatComplete) {
          fail(t("editor.notes.status.aiSuggestionUnavailable"));
          return;
        }
        const knownTags = realVaultTags.map((tag) => tag.name).filter(Boolean).slice(0, 80);
        const prompt = `文档标题: ${requestTitle || "未命名文档"}

当前标签: ${requestTagNames.length ? requestTagNames.join(", ") : "无"}
已有标签库: ${knownTags.length ? knownTags.join(", ") : "无"}

文档内容:
${requestContent.slice(0, 4000) || "（空文档）"}

请为这篇 Markdown 文档生成：
1. 一段 50 字以内摘要
2. 3-5 个文档属性标签建议。标签不要带 #，不要输出颜色值、纯数字、代码片段或文件扩展名。

严格输出 JSON，不要输出其它内容：
{"summary":"...","tags":["标签1","标签2","标签3"]}`;
        const result = await bridge.aiChatComplete([
          { role: "user", content: prompt },
        ], {
          systemPrompt: "你是知识库标签助手。只输出 JSON，不要解释。",
          temperature: 0.3,
          maxTokens: 500,
        });
        if (!result?.success || !result.content) throw new Error(result?.error_message || t("editor.notes.status.aiRequestFailed"));
        const parsed = parseAiTagSuggestionResponse(result.content);
        complete({ ...parsed, noteId }, parsed.auto_tags?.length
          ? t("editor.notes.status.aiSuggestionGenerated")
          : t("editor.notes.status.aiSuggestionEmpty"));
        return;
      }

      if (!bridge?.generateNoteAiSuggestion) {
        fail(t("editor.notes.status.aiSuggestionUnavailable"));
        return;
      }
      if (!request && selectedNote && (requestContent !== editContent || editTitle !== (selectedNote.title || ""))) {
        await savePatch({ title: editTitle, contentText: requestContent });
      }
      const result = await bridge.generateNoteAiSuggestion(noteId);
      if (!result) {
        fail(t("editor.notes.status.aiSuggestionEmpty"));
        return;
      }
      complete({ ...result, noteId }, t("editor.notes.status.aiSuggestionGenerated"));
    } catch (error) {
      console.warn("[NotesPage] generateNoteAiSuggestion failed", error);
      fail(t("editor.notes.status.aiSuggestionFailed"), error instanceof Error ? error.message : t("editor.notes.status.generationFailed"));
    } finally {
      updatePane({ busy: false });
      if (isStillVisible()) setAiBusy(false);
    }
  }, [activeNotesSplitPane, bridge, currentRealVaultTagNames, editContent, editTitle, knowledgeStorageMode, notesPaneLayout, readActiveEditorValue, realVaultMarkdownIndex, realVaultTags, savePatch, selectedNote, selectedNoteId, t, updateNotesPaneAiState]);

  const applyAiTags = useCallback(async () => {
    if (!selectedNoteId || !aiSuggestion?.auto_tags?.length) {
      setStatus(t("editor.notes.status.noAiTags"));
      return;
    }
    const tagsToApply = uniqueMarkdownTagNames(selectedAiTags);
    if (!tagsToApply.length) {
      setStatus(t("editor.notes.status.selectAiTags"));
      return;
    }
    const noteId = selectedNoteId;
    const clearPaneAi = () => {
      if (notesPaneLayout) {
        updateNotesPaneAiState(activeNotesSplitPane, noteId, {
          panelOpen: false,
          busy: false,
          suggestion: null,
          selectedTags: null,
        });
      }
    };
    if (aiSuggestion.noteId && aiSuggestion.noteId !== noteId) {
      setAiSuggestion(null);
      setStatus(t("editor.notes.status.aiTagsExpired"));
      return;
    }
    setAiBusy(true);
    try {
      if (knowledgeStorageMode === "real-vault" || isRealVaultNoteId(noteId)) {
        if (!isRealVaultNoteId(noteId)) {
          setStatus(t("editor.notes.status.openVaultDocumentFirst"));
          return;
        }
        const mergedTagIds = uniqueMarkdownTagNames([...currentRealVaultTagNames, ...tagsToApply]).map(realVaultTagId);
        const saved = await saveTagSelection(mergedTagIds, t("editor.notes.status.aiTagsWrittenMarkdown"));
        if (selectedNoteIdRef.current !== noteId) return;
        if (!saved) return;
        setAiPanelOpen(false);
        setAiSuggestion(null);
        clearPaneAi();
        return;
      }

      if (!bridge?.applyAiTags) {
      setStatus(t("editor.notes.status.aiTagsUnsupported"));
        return;
      }
      await bridge.applyAiTags("note", noteId, tagsToApply);
      await loadTags();
      if (selectedNoteIdRef.current !== noteId) return;
      await loadNoteRelations(noteId);
      setAiPanelOpen(false);
      setAiSuggestion(null);
      clearPaneAi();
      setStatus(t("editor.notes.status.aiTagsApplied"));
    } catch (error) {
      if (selectedNoteIdRef.current !== noteId) return;
      console.warn("[NotesPage] applyAiTags failed", error);
      setStatus(t("editor.notes.status.aiTagsFailed"));
    } finally {
      setAiBusy(false);
    }
  }, [activeNotesSplitPane, aiSuggestion, bridge, currentRealVaultTagNames, knowledgeStorageMode, loadNoteRelations, loadTags, notesPaneLayout, saveTagSelection, selectedAiTags, selectedNoteId, updateNotesPaneAiState, t]);

  const resolveNoteLightSeekPath = useCallback((noteId: string) => {
    if (!currentVault || !isRealVaultNoteId(noteId)) throw new Error("lightseek-note-path-unavailable");
    const relativePath = normalizeVaultRelativePath(realVaultRelativePathFromNoteId(noteId));
    const canonicalPath = resolveKnowledgeDocumentAbsolutePath(knowledgeSnapshot, {
      vaultId: currentVault.id,
      relativePath,
    });
    if (!canonicalPath) throw new Error("lightseek-note-path-unavailable");
    return canonicalPath;
  }, [currentVault, knowledgeSnapshot]);

  const openNotePathInLightSeek = useCallback((noteId: string) => {
    const canonicalPath = resolveNoteLightSeekPath(noteId);
    openInLightSeek({
      source: "notes",
      text: "",
      localResources: [{
        kind: "material",
        assetId: noteId.slice(0, 256),
        canonicalPath,
        delivery: "path-reference",
      }],
    });
  }, [resolveNoteLightSeekPath]);

  const askAiAboutPane = useCallback(async (request: NotesPaneAiRequest) => {
    try {
      openNotePathInLightSeek(request.noteId);
      setStatus(t("editor.notes.status.lightSeekReady"));
    } catch {
      setStatus(t("editor.notes.status.lightSeekFailed"));
    }
  }, [openNotePathInLightSeek, t]);

  const askAiAboutNote = useCallback(async () => {
    if (!selectedNote) return;
    try {
      openNotePathInLightSeek(selectedNote.id);
      setStatus(t("editor.notes.status.lightSeekReady"));
    } catch {
      setStatus(t("editor.notes.status.lightSeekFailed"));
    }
  }, [openNotePathInLightSeek, selectedNote, t]);

  const discardNotesInlinePreview = useCallback(async () => {
    const preview = aiWritePreview;
    setAiWritePreview(null);
    if (preview && bridge?.notesInlineDiscard) {
      await bridge.notesInlineDiscard(preview.previewId).catch(() => undefined);
    }
  }, [aiWritePreview, bridge]);

  const applyNotesInlinePreview = useCallback(async (mode: "replace" | "insert-below") => {
    if (!aiWritePreview || aiWriteApplying || !bridge?.notesInlineApply || !selectedNoteId) return;
    const preview = aiWritePreview;
    const noteId = selectedNoteId;
    const origin={source:readActiveKnowledgeWriteSource(),generation:vaultSessionRef.current.latest()};
    setAiWriteApplying(true);
    try {
      const applied: BridgeNotesInlineApplyResult = await bridge.notesInlineApply(preview.previewId, mode);
      acknowledgeSavedReadProof(noteId,applied.content,applied.revision,origin);
      if (selectedNoteIdRef.current !== noteId) {
      setStatus(t("editor.notes.status.aiSwitchedNote"));
        setAiWritePreview(null);
        return;
      }
      notesInlineCommittedContentRef.current = {
        noteId,
        content: applied.content,
        revision: applied.revision,
      };
      if (editorMode === "live" && liveEditorRef.current) {
        liveEditorRef.current.replaceRange(applied.insertedText, {
          start: applied.startUtf16,
          end: applied.endUtf16,
        });
      } else {
        replaceEditorRange(applied.insertedText, {
          start: applied.startUtf16,
          end: applied.endUtf16,
        });
      }
      setAiWritePreview(null);
      setStatus(applied.committedWarning ? t("editor.notes.status.aiAppliedIndexPending") : t("editor.notes.status.aiApplied"));
      void refreshRealVaultMarkdownIndex();
    } catch {
      setStatus(t("editor.notes.status.aiStale"));
    } finally {
      setAiWriteApplying(false);
    }
  }, [acknowledgeSavedReadProof,aiWriteApplying, aiWritePreview, bridge, editorMode, refreshRealVaultMarkdownIndex, replaceEditorRange, selectedNoteId, t]);

  const runAiWrite = useCallback(async (action: AiWriteAction, selectionOverride?: { start: number; end: number } | null) => {
    if (aiWriteBusy) {
    setStatus(t("editor.notes.status.aiProcessing"));
      return;
    }
    if (!selectedNote) {
      setAiWriteMenu(null);
      setStatus(t("editor.notes.status.openDocumentFirst"));
      return;
    }
    if (!bridge?.notesInlineGenerate) {
      setAiWriteMenu(null);
      setStatus(t("editor.notes.status.aiUnavailable"));
      return;
    }
    if (action !== "rewrite" && action !== "shorten" && action !== "expand" && action !== "continue") {
      setAiWriteMenu(null);
      setStatus(t("editor.notes.status.aiActionUnavailable"));
      return;
    }

    setAiWriteBusy(true);
    aiWriteCancelRequestedRef.current = false;
    setAiWriteMenu(null);
    setStatus(t("editor.notes.status.savingForPreview"));
    try {
      await flushPendingSaveForNotesInline(selectionOverride);
      const preview = await bridge.notesInlineGenerate(action);
      setAiWritePreview(preview);
      setStatus(t("editor.notes.status.aiPreviewReady"));
    } catch {
      setStatus(aiWriteCancelRequestedRef.current
        ? t("editor.notes.status.aiStopped")
        : t("editor.notes.status.aiFailedCheckConfiguration"));
    } finally {
      setAiWriteBusy(false);
      aiWriteCancelRequestedRef.current = false;
    }
    return;

    /*
    const requestId = aiWriteRequestSeqRef.current + 1;
    aiWriteRequestSeqRef.current = requestId;
    const startedAt = performance.now();
    const noteId = selectedNote.id;
    const contentSnapshot = readActiveEditorValue();
    const { start, end } = selectionOverride ?? readActiveEditorSelection();
    const isLatestRequest = () => aiWriteRequestSeqRef.current === requestId;
    const setAiWriteStatus = (message: string) => {
      if (isLatestRequest()) setStatus(message);
    };
    const aiWriteDiagnostics = (event: "complete" | "empty" | "stale" | "error", details: {
      rawLength?: number;
      cleanedLength?: number;
      retryCount?: number;
      emptyKind?: "none" | "raw-empty" | "cleaned-empty";
      stale?: boolean;
      error?: string;
      discardedReason?: string;
    } = {}) => {
      console.info("[NotesPage] AI write diagnostics", {
        event,
        requestId,
        action,
        elapsedMs: Math.round(performance.now() - startedAt),
        rawLength: details.rawLength ?? 0,
        cleanedLength: details.cleanedLength ?? 0,
        retryCount: details.retryCount ?? 0,
        emptyKind: details.emptyKind ?? "none",
        stale: details.stale ?? !isLatestRequest(),
        error: details.error,
        discardedReason: details.discardedReason,
      });
    };

    setAiWriteStatus("AI 正在准备...");
    const built = buildAiWriteDraft(action, { content: contentSnapshot, selectionStart: start, selectionEnd: end });
    if (!built.ok) {
      setStatus(built.status);
      setAiWriteMenu(null);
      return;
    }

    const { draft } = built;
    setAiWriteBusy(true);
    setAiWriteMenu(null);
    setAiWriteStatus("AI 正在思考...");
    let stageTimer: ReturnType<typeof window.setTimeout> | null = window.setTimeout(() => {
      stageTimer = null;
      setAiWriteStatus("AI 正在生成...");
    }, 1600);
    let retryCount = 0;
    let lastRawLength = 0;
    let lastCleanedLength = 0;
    let lastEmptyKind: "none" | "raw-empty" | "cleaned-empty" = "none";

    try {
      const requestAiWrite = async (prompt: string) => bridge.aiChatComplete([
        { role: "user", content: prompt },
      ], {
        systemPrompt: draft.systemPrompt,
        temperature: draft.temperature,
        maxTokens: draft.maxTokens,
      });
      const readAiContent = (raw: unknown) => {
        const rawText = String(raw ?? "");
        const cleanedText = cleanAiWriteResponse(rawText);
        const emptyKind = rawText.trim() ? (cleanedText ? "none" : "cleaned-empty") : "raw-empty";
        lastRawLength = rawText.length;
        lastCleanedLength = cleanedText.length;
        lastEmptyKind = emptyKind as "none" | "raw-empty" | "cleaned-empty";
        return { rawText, cleanedText, emptyKind: lastEmptyKind };
      };

      let result = await requestAiWrite(draft.prompt);
      if (!isLatestRequest()) {
        aiWriteDiagnostics("stale", { stale: true, discardedReason: "newer-request" });
        return;
      }
      if (!result?.success) throw new Error(result?.error_message || "AI 请求失败");
      let parsed = readAiContent(result.content);

      if (!parsed.cleanedText) {
        aiWriteDiagnostics("empty", {
          rawLength: parsed.rawText.length,
          cleanedLength: parsed.cleanedText.length,
          retryCount,
          emptyKind: parsed.emptyKind,
        });
        retryCount = 1;
        setAiWriteStatus("AI 返回为空，正在重试...");
        result = await requestAiWrite(draft.prompt + "\n\n上一轮没有返回可写入内容。请直接返回要写入笔记的正文文本，不要解释、不要 JSON、不要代码块、不要空回复。");
        if (!isLatestRequest()) {
          aiWriteDiagnostics("stale", { stale: true, retryCount, discardedReason: "newer-request-after-retry" });
          return;
        }
        if (!result?.success) throw new Error(result?.error_message || "AI 请求失败");
        parsed = readAiContent(result.content);
      }

      if (!parsed.cleanedText) {
        aiWriteDiagnostics("empty", {
          rawLength: parsed.rawText.length,
          cleanedLength: parsed.cleanedText.length,
          retryCount,
          emptyKind: parsed.emptyKind,
        });
        throw new Error("AI 没有返回可写入内容，请换一段内容重试");
      }
      if (selectedNoteIdRef.current !== noteId) {
        aiWriteDiagnostics("stale", {
          rawLength: parsed.rawText.length,
          cleanedLength: parsed.cleanedText.length,
          retryCount,
          stale: true,
          discardedReason: "note-switched",
        });
        setAiWriteStatus("AI 写作结果已忽略：笔记已切换");
        return;
      }
      if (readActiveEditorValue() !== contentSnapshot) {
        aiWriteDiagnostics("stale", {
          rawLength: parsed.rawText.length,
          cleanedLength: parsed.cleanedText.length,
          retryCount,
          stale: true,
          discardedReason: "content-changed",
        });
        setAiWriteStatus("AI 写作结果未写入：笔记内容已变化");
        return;
      }
      const applied = applyAiWriteResponse(draft, parsed.cleanedText);
      if (applied.title) handleTitleChange(applied.title);
      if (applied.replacement) replaceEditorRange(applied.replacement.text, applied.replacement.range);
      aiWriteDiagnostics("complete", {
        rawLength: parsed.rawText.length,
        cleanedLength: parsed.cleanedText.length,
        retryCount,
      });
      setAiWriteStatus("AI 写作已写入");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      aiWriteDiagnostics("error", {
        rawLength: lastRawLength,
        cleanedLength: lastCleanedLength,
        retryCount,
        emptyKind: lastEmptyKind,
        error: errorMessage,
      });
      if (isLatestRequest()) {
        console.warn("[NotesPage] AI write failed", { action, requestId, error: errorMessage });
        setStatus(t("editor.notes.status.aiFailedWithError", { error: errorMessage }));
      }
    } finally {
      if (stageTimer) window.clearTimeout(stageTimer);
      if (isLatestRequest()) setAiWriteBusy(false);
    }
    */
  }, [aiWriteBusy, bridge, flushPendingSaveForNotesInline, handleTitleChange, readActiveEditorSelection, readActiveEditorValue, replaceEditorRange, selectedNote, t]);

  const cancelNotesInlineGeneration = useCallback(async () => {
    aiWriteCancelRequestedRef.current = true;
    setStatus(t("editor.notes.status.aiStopping"));
    await bridge?.notesInlineCancel?.().catch(() => undefined);
  }, [bridge, t]);

  useEffect(() => {
    setAiWritePreview(null);
    return () => {
      void bridge?.notesInlineCancel?.().catch(() => undefined);
    };
  }, [bridge, selectedNoteId, currentVault?.id]);

  const handleContextMenu = useCallback((event: MouseEvent, note: Note) => {
    event.preventDefault();
    event.stopPropagation();
    const position = clampEditorMenuPosition(event.clientX, event.clientY, 224, 450);
    setNoteCtx({
      note,
      x: position.x,
      y: position.y,
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus("");
    knowledgeStore.ensureSnapshot({ reason: "notes-bootstrap" })
      .then((snapshot) => {
        if (cancelled) return;
        if (snapshot.mode === "real-vault" && snapshot.vault) vaultSessionRef.current.begin(snapshot.vault.id);
        setCurrentVault(snapshot.mode === "real-vault" ? snapshot.vault : null);
        setRealVaultMarkdownIndex(snapshot.mode === "real-vault" ? snapshot.markdownIndex : null);
        if (snapshot.status === "error" && !snapshot.loaded) setStatus(t("editor.notes.status.vaultLoadFailed"));
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn("[NotesPage] getCurrentNotesVault failed", error);
        setCurrentVault(null);
        setRealVaultMarkdownIndex(null);
        setStatus(t("editor.notes.status.vaultLoadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, t]);

  useEffect(() => {
    if (!currentVault) {
      clearActiveKnowledgeSource();
      return;
    }
    setKnownVaults(rememberKnownNotesVault(currentVault));
    setActiveKnowledgeSource({
      mode: "real-vault",
      vaultId: currentVault.id,
      rootPath: currentVault.rootPath,
    });
  }, [currentVault?.id, currentVault?.rootPath, knowledgeStorageMode]);

  useEffect(() => {
    if (!vaultBootstrapReady) return;
    void loadAssets();
    void loadTags();
    const snapshot = knowledgeStore.getSnapshot();
    if (snapshot.loaded && snapshot.mode === "real-vault") {
      void loadRealVaultTree({ silent: true, cachedOnly: true });
      return;
    }
    void reloadCurrentSource();
  }, [knowledgeStorageMode, loadAssets, loadNotes, loadRealVaultTree, loadTags, reloadCurrentSource, vaultBootstrapReady]);

  useEffect(() => {
    const reload = () => void loadAssets();
    window.addEventListener("luckyray:materials-data-changed", reload);
    return () => window.removeEventListener("luckyray:materials-data-changed", reload);
  }, [loadAssets]);

  const selectNoteForNavigationRef = useRef(selectNote);
  selectNoteForNavigationRef.current = selectNote;
  useEffect(() => {
    if (!selectedNoteId) return;
    if (knowledgeStorageMode === "real-vault" && !isRealVaultNoteId(selectedNoteId)) return;
    if (realVaultDocumentReadsRef.current.isHydrating(selectedNoteId)) return;
    if (selectedNoteRef.current?.id === selectedNoteId) return;
    void selectNoteForNavigationRef.current(selectedNoteId);
  }, [knowledgeStorageMode, selectedNoteId]);

  useEffect(() => {
    if(!visible)return;
    const publisher = createCurrentNoteContextPublisher();
    activeContextPublisherRef.current = publisher;
    return () => {
      publisher.dispose();
      if (activeContextPublisherRef.current === publisher) activeContextPublisherRef.current = null;
    };
  }, [visible]);

  useEffect(() => {
    const nextNoteId = selectedNote?.id ?? null;
    if (publishedActiveNoteIdRef.current !== nextNoteId) {
      publishedActiveNoteIdRef.current = nextNoteId;
      if (activeContextTimerRef.current) {
        clearTimeout(activeContextTimerRef.current);
        activeContextTimerRef.current = null;
      }
      publishActiveNoteContext();
    } else {
      scheduleActiveNoteContext();
    }
    return () => {
      if (activeContextTimerRef.current) {
        clearTimeout(activeContextTimerRef.current);
        activeContextTimerRef.current = null;
      }
    };
  }, [publishActiveNoteContext, scheduleActiveNoteContext, selectedNote?.id, visible]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if(!pageVisibleRef.current||notesNativeViews.hasFrozenViews())return;
      if (resolveScopedShortcut(event, "knowledge", undefined, { ids: ["knowledgeSave"] }) === "knowledgeSave") {
        event.preventDefault();
        if (selectedNoteIdRef.current && isRealVaultNoteId(selectedNoteIdRef.current)) {
          const noteId = selectedNoteIdRef.current;
          const activeContent = readActiveEditorValue();
          realVaultUserDirtyRef.current.add(noteId);
          void savePatch({ title: editTitle, contentText: activeContent }, noteId, "explicit-save");
          return;
        }
        flushPendingSave();
        setStatus(t("editor.notes.saved"));
      }
    };
    const onBeforeUnload = () => flushPendingSave();
    const onVisibilityChange = () => {
      if (document.hidden) flushPendingSave();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [editTitle, flushPendingSave, readActiveEditorValue, savePatch, t]);

  useEffect(() => {
    localStorage.setItem(BACKLINKS_TAB_KEY, backlinksTab);
  }, [backlinksTab]);

  useEffect(() => {
    if (!status) return;
    if ((["editor.notes.status.saveFailed", "editor.notes.status.diskStateInvalid", "editor.notes.status.diskRefreshRequired"] as const).some(key => status === t(key))) return;
    const timer = window.setTimeout(() => setStatus(""), 2200);
    return () => window.clearTimeout(timer);
  }, [status, t]);

  useEffect(() => {
    if (!pendingBlockId || editorMode !== "preview") return;
    const blockId = pendingBlockId;
    const timer = window.setTimeout(() => {
      const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(blockId) : blockId.replace(/["\\]/g, "\\$&");
      const target = noteContentAreaRef.current?.querySelector<HTMLElement>(`[data-note-block-id="${escaped}"]`);
      if (!target) {
        setStatus(t("editor.notes.status.blockNotFound", { block: blockId }));
        setPendingBlockId(null);
        return;
      }
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.classList.add("note-preview-block-highlight");
      setStatus(t("editor.notes.status.blockLocated", { block: `^${blockId}` }));
      setPendingBlockId(null);
      window.setTimeout(() => target.classList.remove("note-preview-block-highlight"), 1400);
    }, 100);
    return () => window.clearTimeout(timer);
  }, [editContent, editorMode, pendingBlockId, selectedNoteId, t]);

  useEffect(() => {
    if (!pendingHeadingPath || editorMode !== "preview") return;
    const headingKey = normalizeNoteHeadingPath(pendingHeadingPath);
    if (!headingKey) {
      setPendingHeadingPath(null);
      return;
    }
    const timer = window.setTimeout(() => {
      const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(headingKey) : headingKey.replace(/["\\]/g, "\\$&");
      const target = noteContentAreaRef.current?.querySelector<HTMLElement>(`[data-note-heading-key="${escaped}"]`);
      if (!target) {
        setStatus(t("editor.notes.status.headingNotFound", { heading: pendingHeadingPath }));
        setPendingHeadingPath(null);
        return;
      }
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.classList.add("note-preview-block-highlight");
      setStatus(t("editor.notes.status.headingLocated", { heading: pendingHeadingPath }));
      setPendingHeadingPath(null);
      window.setTimeout(() => target.classList.remove("note-preview-block-highlight"), 1400);
    }, 100);
    return () => window.clearTimeout(timer);
  }, [editContent, editorMode, pendingHeadingPath, selectedNoteId, t]);

  useEffect(() => {
    const onFolderSelect = (event: Event) => {
      if(!pageVisibleRef.current||notesNativeViews.hasFrozenViews())return;
      const detail = (event as CustomEvent<{ scope?: string; folderId?: string | null }>).detail;
      if (detail?.scope !== "notes") return;
      setSelectedFolderId(detail.folderId ?? null);
    };
    const onCreate = () => {if(pageVisibleRef.current&&!notesNativeViews.hasFrozenViews())void createNote();};
    const onImported = (event: Event) => {
      const noteIds = (event as CustomEvent<{ noteIds?: string[] }>).detail?.noteIds || [];
      void loadNotes().then(() => {
        if(!pageVisibleRef.current||notesNativeViews.hasFrozenViews())return;
        setEditorMode("live");
        const firstId = noteIds.find(Boolean);
        if (firstId) void selectNote(firstId, { scrollList: true });
      });
    };
    const onTogglePanel = () => {
      if(!pageVisibleRef.current||notesNativeViews.hasFrozenViews())return;
      setPanelOpen((open) => {
        const nextOpen = !open;
        const restoreWidth = notesIndexRestoreWidth({
        lastExpandedWidth: lastExpandedNotesIndexWidthRef.current,
        userSet: notesIndexWidthUserSetRef.current,
        viewportWidth: notesViewportWidthRef.current,
      });
        if (nextOpen) {
          setNotesIndexWidth(restoreWidth);
        } else {
        }
        return nextOpen;
      });
    };
    const onExternalUpdated = (event: Event) => {
      const noteId = (event as CustomEvent<{ noteId?: string }>).detail?.noteId;
      if (noteId) void refreshExternalNote(noteId);
    };
    const onManualRefresh = () => {if(pageVisibleRef.current&&!notesNativeViews.hasFrozenViews())void refreshCurrentSourceManually();};
    window.addEventListener("luckyray:folder-select", onFolderSelect);
    window.addEventListener("luckyray:notes-create", onCreate);
    window.addEventListener("luckyray:notes-imported", onImported);
    window.addEventListener("luckyray:notes-toggle-panel", onTogglePanel);
    window.addEventListener("luckyray:note-external-updated", onExternalUpdated);
    window.addEventListener("luckyray:notes-refresh", onManualRefresh);
    const onRequestSplit = (event: Event) => {
      if(!pageVisibleRef.current||notesNativeViews.hasFrozenViews())return;
      const detail = (event as CustomEvent<{ direction?: NotesSplitDirection; paneId?: string }>).detail;
      const direction = detail?.direction;
      if (direction === "left" || direction === "right" || direction === "up" || direction === "down") requestNotesSplit(direction, detail?.paneId);
    };
    const onTitlebarPaneActivate = (event: Event) => {
      if(!pageVisibleRef.current||notesNativeViews.hasFrozenViews())return;
      const detail = (event as CustomEvent<{ paneId?: string; tabId?: string }>).detail;
      const paneId = detail?.paneId;
      if (paneId) activateNotesSplitPane(paneId, detail?.tabId);
    };
    const onTitlebarPaneNew = (event: Event) => {
      if(!pageVisibleRef.current||notesNativeViews.hasFrozenViews())return;
      const paneId = (event as CustomEvent<{ paneId?: string }>).detail?.paneId;
      if (paneId) createNotesSplitPaneTab(paneId);
    };
    const onTitlebarPaneClose = (event: Event) => {
      if(!pageVisibleRef.current||notesNativeViews.hasFrozenViews())return;
      const detail = (event as CustomEvent<{ paneId?: string; tabId?: string }>).detail;
      const paneId = detail?.paneId;
      if (paneId) closeNotesSplitDocument(paneId, detail?.tabId);
    };
    const onNewTab = () => {
      if(!pageVisibleRef.current||notesNativeViews.hasFrozenViews())return;
      if (notesPaneLayout) {
        createNotesSplitPaneTab(activeNotesSplitPane);
        return;
      }
      showEmptyTab();
    };
    const onTabSelect = (event: Event) => {
      if(!pageVisibleRef.current||notesNativeViews.hasFrozenViews())return;
      const detail = (event as CustomEvent<{ tabId?: string; kind?: "note" | "empty"; noteId?: string | null }>).detail || {};
      if (notesPaneLayout) {
        const targetId = detail.tabId || detail.noteId || null;
        if (!targetId) return;
        const targetPane = Object.entries(notesPaneTabs || {}).find(([, tabs]) => tabs.some((tab) => tab.id === targetId));
        if (targetPane) activateNotesSplitPane(targetPane[0], targetId);
        return;
      }
      if (detail.kind === "empty" || (!detail.noteId && detail.tabId)) {
        showEmptyTab(detail.tabId, { ensureOpen: true });
        return;
      }
      if (detail.noteId) {
        const mode = notesViewRefsRef.current.get(notesPaneViewsRef.current.get("notes-pane-1", detail.noteId))?.mode;
        if (mode) setEditorMode(mode);
        void selectNote(detail.noteId, { scrollList: true });
      }
    };
    const onTabClose = (event: Event) => {
      if(!pageVisibleRef.current||notesNativeViews.hasFrozenViews())return;
      if(notesNativeViews.hasFrozenViews())return;
      const detail = (event as CustomEvent<{ tabId?: string; kind?: "note" | "empty"; noteId?: string | null }>).detail || {};
      const closeId = detail.tabId || detail.noteId || null;
      if (!closeId) return;
      if (notesPaneLayout) {
        const targetPane = Object.entries(notesPaneTabs || {}).find(([, tabs]) => tabs.some((tab) => tab.id === closeId));
        if (targetPane) closeNotesSplitDocument(targetPane[0], closeId);
        return;
      }
      const next = openTabs.filter((tab) => tab.id !== closeId);
      const closingActiveNote = Boolean(detail.noteId && selectedNoteId === detail.noteId);
      const closingActiveEmpty = Boolean(activeEmptyTabId && closeId === activeEmptyTabId);
      const closingActive = closingActiveNote || closingActiveEmpty;
      const normalizedNext = next.length ? next : [createEmptyNoteTab()];
      const fallback = closingActive ? normalizedNext[Math.max(0, Math.min(openTabs.findIndex((tab) => tab.id === closeId), normalizedNext.length - 1))] || normalizedNext[normalizedNext.length - 1] : null;
      setOpenTabs(normalizedNext);
      if (fallback?.kind === "empty") {
        showEmptyTab(fallback.id, { ensureOpen: false });
        return;
      }
      if (fallback?.id) {
        void selectNote(fallback.id, { scrollList: true });
      }
    };
    const closeActiveTab = () => {
      if(!pageVisibleRef.current||notesNativeViews.hasFrozenViews())return;
      if (notesPaneLayout) {
        closeNotesSplitDocument(activeNotesSplitPane);
        return;
      }
      if (selectedNoteId) {
        onTabClose(new CustomEvent("luckyray:notes-tab-close", { detail: { noteId: selectedNoteId, tabId: selectedNoteId, kind: "note" } }));
        return;
      }
      if (activeEmptyTabId) {
        onTabClose(new CustomEvent("luckyray:notes-tab-close", { detail: { tabId: activeEmptyTabId, kind: "empty" } }));
      }
    };
    const switchTab = (direction: 1 | -1) => {
      if(!pageVisibleRef.current||notesNativeViews.hasFrozenViews())return;
      if (notesPaneLayout) {
        const tabs = notesPaneTabs?.[activeNotesSplitPane] || [];
        if (tabs.length < 2) return;
        const activeId = notesPaneActiveTabs?.[activeNotesSplitPane];
        const index = Math.max(0, tabs.findIndex((tab) => tab.id === activeId));
        const next = tabs[(index + direction + tabs.length) % tabs.length];
        if (next) activateNotesSplitPane(activeNotesSplitPane, next.id);
        return;
      }
      if (!selectedNoteId || openTabs.length < 2) return;
      const index = openTabs.findIndex((tab) => tab.id === selectedNoteId);
      const nextIndex = (index + direction + openTabs.length) % openTabs.length;
      const nextId = openTabs[nextIndex]?.id;
      if (nextId) void selectNote(nextId, { scrollList: true });
    };
    const nextTab = () => switchTab(1);
    const prevTab = () => switchTab(-1);
    window.addEventListener("luckyray:notes-split", onRequestSplit);
    window.addEventListener(NOTES_TITLEBAR_PANE_ACTIVATE_EVENT, onTitlebarPaneActivate);
    window.addEventListener(NOTES_TITLEBAR_PANE_NEW_EVENT, onTitlebarPaneNew);
    window.addEventListener(NOTES_TITLEBAR_PANE_CLOSE_EVENT, onTitlebarPaneClose);
    window.addEventListener("luckyray:notes-new-tab", onNewTab);
    window.addEventListener("luckyray:notes-tab-select", onTabSelect);
    window.addEventListener("luckyray:notes-tab-close", onTabClose);
    window.addEventListener("luckyray:notes-tab-close-active", closeActiveTab);
    window.addEventListener("luckyray:notes-tab-next", nextTab);
    window.addEventListener("luckyray:notes-tab-prev", prevTab);
    return () => {
      window.removeEventListener("luckyray:folder-select", onFolderSelect);
      window.removeEventListener("luckyray:notes-create", onCreate);
      window.removeEventListener("luckyray:notes-imported", onImported);
      window.removeEventListener("luckyray:notes-toggle-panel", onTogglePanel);
      window.removeEventListener("luckyray:note-external-updated", onExternalUpdated);
      window.removeEventListener("luckyray:notes-refresh", onManualRefresh);
      window.removeEventListener("luckyray:notes-split", onRequestSplit);
      window.removeEventListener(NOTES_TITLEBAR_PANE_ACTIVATE_EVENT, onTitlebarPaneActivate);
      window.removeEventListener(NOTES_TITLEBAR_PANE_NEW_EVENT, onTitlebarPaneNew);
      window.removeEventListener(NOTES_TITLEBAR_PANE_CLOSE_EVENT, onTitlebarPaneClose);
      window.removeEventListener("luckyray:notes-new-tab", onNewTab);
      window.removeEventListener("luckyray:notes-tab-select", onTabSelect);
      window.removeEventListener("luckyray:notes-tab-close", onTabClose);
      window.removeEventListener("luckyray:notes-tab-close-active", closeActiveTab);
      window.removeEventListener("luckyray:notes-tab-next", nextTab);
      window.removeEventListener("luckyray:notes-tab-prev", prevTab);
    };
  }, [activateNotesSplitPane, activeEmptyTabId, activeNotesSplitPane, closeNotesSplitDocument, createNote, createNotesSplitPaneTab, loadNotes, notesPaneActiveTabs, notesPaneLayout, notesPaneTabs, openTabs, publishNotesPanelState, refreshCurrentSourceManually, refreshExternalNote, requestNotesSplit, selectNote, selectedNoteId, showEmptyTab]);

  useEffect(() => {
    if (!noteCtx && !aiWriteMenu && !editorCtx && !autocomplete) return;
    const close = () => {
      setNoteCtx(null);
      setAiWriteMenu(null);
      setEditorCtx(null);
      setAutocomplete(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [aiWriteMenu, autocomplete, editorCtx, noteCtx]);

  useEffect(() => {
    return () => {
      flushPendingSaveRef.current();
      window.dispatchEvent(new CustomEvent("luckyray:notes-active-title", { detail: { title: notesExitTitleRef.current } }));
      // Activity/StrictMode can replay effects while retaining this ref. Once
      // the titlebar is cleared, the same retained tabs must publish again.
      publishedTabsRef.current = "";
      window.dispatchEvent(new CustomEvent("luckyray:notes-tabs", { detail: { tabs: [], activeId: null } }));
    };
  }, []);

  const handleOpenKnowledgeSearchNote = useCallback((noteId: string) => {
    setKnowledgeSearchOpen(false);
    void selectNote(noteId, { scrollList: true });
  }, [selectNote]);

  const handleOpenKnowledgeSearchFolder = useCallback((folderId: string) => {
    setKnowledgeSearchOpen(false);
    setBacklinksTab("notes");
    setPanelOpen(true);
    setSelectedFolderId(folderId);
  }, []);

  const enterRealVaultMode = useCallback(() => {
    if(notesNativeViews.hasFrozenViews()){setStatus("笔记正在安全移动，请等待完成。");return;}
    if (!currentVault) {
      setStatus(t("editor.notes.status.setupOrOpenVault"));
      return;
    }
    resetActiveDocumentForSource("real-vault");
    activateKnowledgeWritesForVault({
      mode: "real-vault",
      vaultId: currentVault.id,
      rootPath: currentVault.rootPath,
    });
    vaultSessionRef.current.begin(currentVault.id);
    setSelectedFolderId(null);
    setNotesIndexPanel(null);
    void loadRealVaultTree();
  }, [currentVault, loadRealVaultTree, resetActiveDocumentForSource, t]);

  const activateRealVault = useCallback((vault: BridgeVaultMetadata, message: string) => {
    if(notesNativeViews.hasFrozenViews()){setStatus("笔记正在安全移动，请等待完成。");return;}
    // Flush any dirty old-vault draft while the OLD write source is still
    // active: the reset's savePatch captures the write source at entry, and
    // flipping to the new vault first would route an old note's content into
    // the new vault at the same relative path.
    resetActiveDocumentForSource("real-vault");
    activateKnowledgeWritesForVault({
      mode: "real-vault",
      vaultId: vault.id,
      rootPath: vault.rootPath,
    });
    // A new vault is a new session: every in-flight load, save and snapshot
    // continuation from the previous vault is now stale by construction.
    vaultSessionRef.current.begin(vault.id);
    setCurrentVault(vault);
    setSelectedFolderId(null);
    setRealVaultTree([]);
    setRealVaultMarkdownIndex(null);
    setRealVaultAssetMatches({});
    realVaultAssetOpenPathRef.current.clear();
    realVaultSavedContentRef.current.clear();
    realVaultLatestContentRef.current.clear();
    realVaultDocumentReadsRef.current.clearHydration();
    realVaultUserDirtyRef.current.clear();
    realVaultSaveInFlightRef.current.clear();
    realVaultSaveCompletionRef.current.clear();
    realVaultKeepEditingAfterConflictRef.current.clear();
    setRealVaultExternalConflict(null);
    setNotesIndexPanel(null);
    setVaultSwitchError("");
    setStatus(message);
  }, [resetActiveDocumentForSource]);

  const switchKnownVault = useCallback(async (candidate: BridgeVaultMetadata) => {
    if(notesNativeViews.hasFrozenViews()){setStatus("笔记正在安全移动，请等待完成。");return;}
    if (candidate.id === currentVault?.id || vaultSwitchInFlightRef.current || !bridge?.openNotesVault) return;
    vaultSwitchInFlightRef.current = candidate.id;
    setSwitchingVaultId(candidate.id);
    setVaultSwitchError("");
    setStatus(t("editor.notes.status.switchingVault", { name: candidate.name }));
    try {
      const result = await bridge.openNotesVault(candidate.rootPath);
      if (!result.vault) {
        const message = result.missing
          ? t("editor.notes.status.vaultMissingRelink")
          : t("editor.notes.status.switchVaultNoMetadata");
        setVaultSwitchError(message);
        setStatus(message);
        return;
      }
      activateRealVault(result.vault, t("editor.notes.status.switchedVault", { name: result.vault.name }));
    } catch (error) {
      console.warn("[NotesPage] switch known vault failed", error);
      const message = t("editor.notes.status.switchVaultFailed", { error: error instanceof Error ? error.message : String(error) });
      setVaultSwitchError(message);
      setStatus(message);
    } finally {
      vaultSwitchInFlightRef.current = null;
      setSwitchingVaultId(null);
    }
  }, [activateRealVault, bridge, currentVault?.id, t]);

  const knownVaultChoices = useMemo(
    () => mergeKnownNotesVaults(knownVaults, currentVault ? [currentVault] : []),
    [currentVault, knownVaults],
  );

  const createVaultFromPicker = useCallback(async () => {
    if(notesNativeViews.hasFrozenViews()){setStatus("笔记正在安全移动，请等待完成。");return;}
    if (!bridge?.selectVaultDirectory || !bridge?.createNotesVault) {
      setStatus(t("editor.notes.status.createVaultUnsupported"));
      return;
    }
    try {
      const rootPath = await bridge.selectVaultDirectory();
      if (!rootPath) return;
      setStatus(t("editor.notes.status.creatingVault"));
      const vault = await bridge.createNotesVault(rootPath);
      activateRealVault(vault, t("editor.notes.status.vaultCreated"));
    } catch (error) {
      console.warn("[NotesPage] create real vault failed", error);
      setStatus(t("editor.notes.status.createVaultFailed", { error: error instanceof Error ? error.message : String(error) }));
    }
  }, [activateRealVault, bridge, t]);

  const openVaultFromPicker = useCallback(async () => {
    if(notesNativeViews.hasFrozenViews()){setStatus("笔记正在安全移动，请等待完成。");return;}
    if (!bridge?.selectVaultDirectory || !bridge?.openNotesVault) {
      setStatus(t("editor.notes.status.openVaultUnsupported"));
      return;
    }
    try {
      const rootPath = await bridge.selectVaultDirectory();
      if (!rootPath) return;
      setStatus(t("editor.notes.status.openingVault"));
      const result = await bridge.openNotesVault(rootPath);
      if (!result.vault) {
        setStatus(result.missing
          ? t("editor.notes.status.selectedDirectoryNotVault")
          : t("editor.notes.status.openVaultNoMetadata"));
        return;
      }
      activateRealVault(result.vault, t("editor.notes.status.vaultOpened"));
    } catch (error) {
      console.warn("[NotesPage] open real vault failed", error);
      setStatus(t("editor.notes.status.openVaultFailed", { error: error instanceof Error ? error.message : String(error) }));
    }
  }, [activateRealVault, bridge, t]);

  const startNotesIndexResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const pageNotes = document.getElementById("page-notes");
    if (!pageNotes) return;
    const startX = event.clientX;
    const startWidth = visibleNotesIndexWidth;
    const layoutMax = notesIndexLayoutMax;
    let collapsedByResize = false;
    let latestWidth = startWidth;
    let frame = 0;
    document.body.classList.add("notes-index-resizing");

    // Live drag mirrors the right split divider: mutate the index width CSS
    // variable directly inside requestAnimationFrame and commit exactly ONE
    // React width update when the drag ends. A setState per pointermove
    // re-rendered this whole page per frame, so the index trailed the cursor.
    const applyLiveWidth = () => {
      frame = 0;
      pageNotes.style.setProperty("--notes-index-width", `${Math.min(latestWidth, layoutMax)}px`);
      publishNotesPanelState(true, latestWidth);
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      const rawWidth = startWidth + moveEvent.clientX - startX;
      if (rawWidth < NOTES_INDEX_COLLAPSE_THRESHOLD) {
        if (!collapsedByResize) {
          collapsedByResize = true;
          const restoreWidth = notesIndexRestoreWidth({
            lastExpandedWidth: lastExpandedNotesIndexWidthRef.current,
            userSet: notesIndexWidthUserSetRef.current,
            viewportWidth: notesViewportWidthRef.current,
          });
          if (frame) { cancelAnimationFrame(frame); frame = 0; }
          setPanelOpen(false);
          setNotesIndexWidth(restoreWidth);
        }
        return;
      }
      if (collapsedByResize) {
        // Dragged back out of the collapse zone: bring the panel back once
        // and continue live-sizing; React leaves the live CSS variable
        // untouched because the committed width did not change.
        collapsedByResize = false;
        setPanelOpen(true);
      }
      latestWidth = clampNotesIndexWidth(rawWidth);
      lastExpandedNotesIndexWidthRef.current = latestWidth;
      if (!frame) frame = requestAnimationFrame(applyLiveWidth);
    };

    const finishResize = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
      document.body.classList.remove("notes-index-resizing");
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      notesIndexWidthUserSetRef.current = true; // an explicit drag is a preference
      if (collapsedByResize) {
        const restoreWidth = notesIndexRestoreWidth({
        lastExpandedWidth: lastExpandedNotesIndexWidthRef.current,
        userSet: notesIndexWidthUserSetRef.current,
        viewportWidth: notesViewportWidthRef.current,
      });
        setNotesIndexWidth(restoreWidth);
      } else {
        setNotesIndexWidth(latestWidth);
      }
    };

    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
  }, [visibleNotesIndexWidth, notesIndexLayoutMax, publishNotesPanelState]);
  const notesIndexDocumentCount = knowledgeStorageMode === "real-vault" ? realVaultUiTree.notes.length : notes.length;
  const notesIndexDocumentCountLabel = knowledgeStorageMode === "real-vault"
    ? t("editor.notes.meta.markdownCount", { count: notesIndexDocumentCount })
    : t("editor.notes.meta.documentCount", { count: notesIndexDocumentCount });
  const realVaultRelationData = useMemo(() => (
    knowledgeStorageMode === "real-vault"
      ? buildRealVaultRelationData(
          selectedNoteId,
          realVaultMarkdownIndex,
          (line) => t("editor.notes.meta.line", { line }),
          t("editor.notes.untitled"),
        )
      : null
  ), [knowledgeStorageMode, realVaultMarkdownIndex, selectedNoteId, t]);
  const connectedNoteLinks = realVaultRelationData?.connectedNoteLinks || noteLinks.filter((link) => !link.isMissing);
  const missingNoteLinks = realVaultRelationData?.missingNoteLinks || noteLinks.filter((link) => link.isMissing);
  const relationBacklinks = realVaultRelationData?.backlinks || backlinks;
  const relationUnlinkedMentions = realVaultRelationData?.unlinkedMentions || unlinkedMentions;
  const relationTabCount = connectedNoteLinks.length + missingNoteLinks.length + relationBacklinks.length + relationUnlinkedMentions.length;
  const currentRealVaultRelativePath = useMemo(() => {
    if (knowledgeStorageMode !== "real-vault" || !selectedNote || !selectedNoteId) return null;
    if (!isRealVaultNoteId(selectedNoteId) || selectedNote.id !== selectedNoteId) return null;
    return normalizeVaultRelativePath(realVaultRelativePathFromNoteId(selectedNoteId));
  }, [knowledgeStorageMode, selectedNote, selectedNoteId]);

  const mediaIndex = useMemo(() => !realVaultMarkdownIndex || !publishedDraftEmbeds.length ? realVaultMarkdownIndex : {
    ...realVaultMarkdownIndex,
    documents: realVaultMarkdownIndex.documents.map(document => {
      const additions = publishedDraftEmbeds.filter(item => realVaultRelativePathFromNoteId(item.noteId) === document.relativePath
        && !document.embeds.some(embed => embed.raw === item.prepared.markdown));
      return !additions.length ? document : { ...document, embeds: [...document.embeds, ...additions.map(({prepared}) => ({
        raw: prepared.markdown, target: prepared.target!, kind: prepared.asset.kind || null, line: 1,
      }))] };
    }),
  }, [realVaultMarkdownIndex, publishedDraftEmbeds]);
  useEffect(() => {
    setPublishedDraftEmbeds(previous => {
      const remaining = previous.filter(item => {
        // Reconcile short-lived receipts on the existing index echo, never on
        // each keystroke. Undo/deletion already removes the view-owned binding.
        const draft = realVaultLatestContentRef.current.get(item.noteId);
        if (draft !== undefined && !draft.includes(item.prepared.markdown)) return false;
        return !realVaultMarkdownIndex?.documents.some(document =>
          document.relativePath === realVaultRelativePathFromNoteId(item.noteId) && document.embeds.some(embed => embed.raw === item.prepared.markdown));
      });
      return remaining.length === previous.length ? previous : remaining;
    });
  }, [realVaultMarkdownIndex]);

  const rawRealVaultEmbedItems = useMemo(() => (
    knowledgeStorageMode === "real-vault"
      ? buildRealVaultEmbedItems(currentRealVaultRelativePath, mediaIndex, currentVault, allAssets, {
          untitledMaterial: t("editor.notes.context.materialUntitled"),
          formatLine: (line) => t("editor.notes.meta.line", { line }),
        })
      : []
  ), [allAssets, currentRealVaultRelativePath, currentVault, knowledgeStorageMode, mediaIndex, t]);

  const visibleVaultEmbedInputs = useMemo(() => {
    if(knowledgeStorageMode !== "real-vault") return [];
    const ids = new Set([selectedNoteId, ...Object.values(notesPaneActiveTabs || {})].filter((id): id is string => Boolean(id) && isRealVaultNoteId(id!)));
    return Array.from(ids).map(noteId => {
      const relativePath=realVaultRelativePathFromNoteId(noteId);
      return {noteId,relativePath,items:buildRealVaultEmbedItems(relativePath,mediaIndex,currentVault,allAssets,{
        untitledMaterial:t("editor.notes.context.materialUntitled"),formatLine:(line)=>t("editor.notes.meta.line",{line})})};
    });
  },[knowledgeStorageMode,selectedNoteId,notesPaneActiveTabs,mediaIndex,currentVault,allAssets,t]);

  useEffect(() => {
    const batch = knowledgeSnapshot.attachmentChanges;
    if (!batch || batch.vaultId !== currentVault?.id || batch.rootPath !== currentVault.rootPath) return;
    // Recent inactive notes share this bounded resolution cache. Remember a
    // content event now, even if its metadata timestamp is unchanged on revisit.
    setRealVaultAssetMatches(previous => refreshRecentAttachmentVersions(previous, batch));
  }, [knowledgeSnapshot.attachmentChanges, currentVault?.id, currentVault?.rootPath]);

  useVaultAttachmentResolution({
    vault: currentVault,
    lookups: visibleVaultEmbedInputs.flatMap(input => input.items
      .filter(item => !item.targetNoteId && item.assetLookupKey && item.target)
      .map(item => ({ key: item.assetLookupKey!, noteRelativePath: input.relativePath, target: item.target, wiki: item.wikiSyntax }))),
    batch: knowledgeSnapshot.attachmentChanges,
    recheck: attachmentRecheck + (knowledgeSnapshot.attachmentResolutionRevision || 0),
    setMatches: setRealVaultAssetMatches,
    setError: setAttachmentResolutionError,
  });
  const attachmentProblem = attachmentResolutionError || externalAttachmentFlow.error;

  const materialAssetsById = useMemo(() => new Map(allAssets.map((asset) => [asset.id, asset])), [allAssets]);
  const resolveVaultPresentation = useCallback((raw: RealVaultEmbedItem[]) => {
    const items = raw.map((item) => {
      const matches = item.assetLookupKey ? realVaultAssetMatches[item.assetLookupKey] : undefined;
      const checked = item.assetLookupKey ? Object.prototype.hasOwnProperty.call(realVaultAssetMatches, item.assetLookupKey) : false;
      if (item.libraryAssetId && checked && matches?.length === 0) {
        return {
          ...item,
          assetExists: true,
          assetMatchCount: 0,
          assetMatchKind: "material-library",
          assetVersion: null,
        };
      }
      const firstMatch = matches?.length === 1 && matches[0].exists && matches[0].isFile ? matches[0] : null;
      return {
        ...item,
        libraryAssetId: firstMatch?.materialAssetId && materialAssetsById.has(firstMatch.materialAssetId) ? firstMatch.materialAssetId : null,
        assetRelativePath: firstMatch?.relativePath || item.assetRelativePath,
        absolutePath: firstMatch?.absolutePath || item.absolutePath,
        assetExists: item.targetNoteId ? true : firstMatch ? true : checked ? false : null,
        assetMatchCount: matches?.filter((match) => match.exists && match.isFile).length || 0,
        assetMatchKind: firstMatch?.matchKind || matches?.[0]?.matchKind || (checked ? "missing" : "pending"),
        assetVersion: firstMatch?.version || null,
      };
    });
    const byId = new Map<string, Asset>();
    for (const item of items) {
      if (item.targetNoteId) {
        const id = `${REAL_VAULT_MARKDOWN_EMBED_PREFIX}${item.targetNoteId}`;
        byId.set(id, {
          id,
          name: item.display || item.target || realVaultRelativePathFromNoteId(item.targetNoteId),
          kind: "document",
          libraryPath: null,
        });
        continue;
      }
      if (item.targetNoteId || item.assetExists !== true || !item.assetRelativePath || !item.absolutePath) continue;
      const libraryAsset = item.libraryAssetId ? materialAssetsById.get(item.libraryAssetId) : null;
      const publishedAsset = publishedDraftEmbeds.find(({prepared}) => prepared.resolution?.absolutePath === item.absolutePath
        && prepared.resolution?.version === item.assetVersion)?.prepared.asset;
      const id = libraryAsset?.id || `${REAL_VAULT_ASSET_PREFIX}${item.assetRelativePath}`;
      const kind = realVaultAssetKind(item.assetRelativePath);
      const rawPreviewUrl = realVaultAssetPreviewUrl(item.absolutePath, kind);
      const previewUrl = rawPreviewUrl ? `${rawPreviewUrl}?vault=${encodeURIComponent(currentVault?.id || "")}&v=${encodeURIComponent(item.assetVersion || "")}` : "";
      byId.set(id, {
        ...libraryAsset,
        id,
        name: libraryAsset?.name || publishedAsset?.name || item.display || realVaultAssetFileName(item.assetRelativePath, t("editor.notes.context.materialUntitled")),
        kind,
        // A generated catalog thumbnail (videos especially) is the instant
        // cover attachVideoPreview renders as poster; the versioned vault
        // preview URL stays the playable source in previewUrl. Overwriting
        // the thumbnail with the media URL forced every video back to a
        // first-frame fetch before anything was visible.
        thumbnailUrl: libraryAsset?.thumbnailUrl || publishedAsset?.thumbnailUrl || previewUrl,
        previewUrl,
        libraryPath: item.absolutePath,
      });
    }
    const embeds = items
      .map((item) => ({
        targetName: item.wikiSyntax ? item.sourceTarget : `md:${item.sourceTarget}`,
        resolutionStatus: item.assetMatchKind || (item.assetExists === true ? "resolved" : "pending"),
        assetId: item.targetNoteId
          ? REAL_VAULT_MARKDOWN_EMBED_PREFIX + item.targetNoteId
          : item.assetExists === true ? item.libraryAssetId || (REAL_VAULT_ASSET_PREFIX + item.assetRelativePath) : null,
        isMissing: item.assetExists === true || item.targetNoteId ? 0 : 1,
      }));
    return {items, assets:Array.from(byId.values()), embeds};
  }, [realVaultAssetMatches,currentVault?.id,materialAssetsById,publishedDraftEmbeds,t]);
  // Navigation starts resolution/decoding alongside the body read. The normal
  // visible-pane resolver shares in-flight reads and remains the authority.
  prepareNoteMediaRef.current = (noteId) => {
    if (!currentVault) return;
    const source = readActiveKnowledgeWriteSource();
    const session = vaultSessionRef.current.latest();
    const changes = knowledgeSnapshot.attachmentChanges;
    const resolutionRevision = knowledgeSnapshot.attachmentResolutionRevision;
    const request = noteLoadRequestRef.current;
    const isCurrent = () => source === readActiveKnowledgeWriteSource()
      && vaultSessionRef.current.isCurrent(session) && selectedNoteIdRef.current === noteId
      && knowledgeStore.getSnapshot().attachmentChanges === changes
      && knowledgeStore.getSnapshot().attachmentResolutionRevision === resolutionRevision
      && noteLoadRequestRef.current === request;
    const relativePath = realVaultRelativePathFromNoteId(noteId);
    const viewport = mediaViewportLinesRef.current.get(noteId) || {from: 1, to: 30};
    const distance = (line: number) => line < viewport.from ? viewport.from - line : Math.max(0, line - viewport.to);
    const items = buildRealVaultEmbedItems(relativePath, realVaultMarkdownIndex, currentVault, allAssets, {
      untitledMaterial: t("editor.notes.context.materialUntitled"), formatLine: line => String(line),
    }).sort((a, b) => distance(a.line) - distance(b.line));
    let matches = realVaultAssetMatches;
    const warm = () => {
      if (!isCurrent()) return;
      const entries = items.flatMap(item => {
        const match = item.assetLookupKey ? matches[item.assetLookupKey]?.[0] : null;
        if (!match?.exists || !match.isFile || !match.absolutePath) return [];
        const material = match.materialAssetId ? materialAssetsById.get(match.materialAssetId) : null;
        const kind = realVaultAssetKind(match.relativePath);
        const original = realVaultAssetPreviewUrl(match.absolutePath, kind);
        const previewUrl = original ? `${original}?vault=${encodeURIComponent(currentVault.id)}&v=${encodeURIComponent(match.version || "")}` : "";
        const media = resolveNoteMediaSources({kind, previewUrl, thumbnailUrl: material?.thumbnailUrl});
        return media.imageSource ? [{url: media.imageSource, kind: "image"}] : [];
      });
      scheduleAttachmentPrefetch(entries, isCurrent);
    };
    warm();
    const lookups = items.filter(item => !item.targetNoteId && item.assetLookupKey && item.target)
      .map(item => ({key: item.assetLookupKey!, noteRelativePath: relativePath, target: item.target, wiki: item.wikiSyntax}));
    // Only the near-viewport batch is prepared early. All references are still
    // resolved by the mounted pane, and no ordinary keystroke calls this path.
    void resolveAttachmentBatchProgressive(currentVault.id, lookups.slice(0, 12), partial => {
      if (!isCurrent()) return;
      matches = mergeAttachmentBatch(matches, partial);
      warm();
      setRealVaultAssetMatches(previous => mergeAttachmentBatch(previous, partial));
    }).catch(() => {});
  };
  const currentVaultPresentation = useMemo(() => resolveVaultPresentation(rawRealVaultEmbedItems), [resolveVaultPresentation,rawRealVaultEmbedItems]);
  const realVaultEmbedItems = currentVaultPresentation.items;
  const realVaultResolvedAssets = currentVaultPresentation.assets;
  const activePreviewAssets = useMemo(() => knowledgeStorageMode === "real-vault"
    ? mergeAssetsById(previewAssets, realVaultResolvedAssets) : previewAssets, [knowledgeStorageMode,realVaultResolvedAssets,previewAssets]);
  const activeNoteEmbeds = knowledgeStorageMode === "real-vault" ? currentVaultPresentation.embeds : noteEmbeds;
  const getPaneMedia = useCallback((noteId: string) => {
    const raw = visibleVaultEmbedInputs.find(input => input.noteId === noteId)?.items || [];
    const presentation = resolveVaultPresentation(raw);
    return {assets:mergeAssetsById(previewAssets, presentation.assets),noteEmbeds:presentation.embeds};
  }, [visibleVaultEmbedInputs,resolveVaultPresentation,previewAssets]);
  useEffect(() => {
    const paths = new Map<string,string>();
    for(const input of visibleVaultEmbedInputs) for(const asset of resolveVaultPresentation(input.items).assets) {
      if(asset.libraryPath) paths.set(asset.id,asset.libraryPath);
    }
    realVaultAssetOpenPathRef.current=paths;
  },[visibleVaultEmbedInputs,resolveVaultPresentation]);

  const realVaultFolderPathActions = useMemo(() => {
    if (knowledgeStorageMode !== "real-vault" || !currentVault) return undefined;
    return {
      copy: async (folderId: string) => {
        const absolutePath = vaultAbsolutePath(folderId);
        if (!absolutePath) {
          setStatus(t("editor.notes.status.folderPathMissing"));
          return;
        }
        await copyTextToClipboard(absolutePath, t("editor.notes.status.absolutePathCopied"));
      },
      reveal: async (folderId: string) => {
        const absolutePath = vaultAbsolutePath(folderId);
        const revealed = bridge?.revealAssetPath ? await bridge.revealAssetPath(absolutePath) : false;
        setStatus(revealed ? t("editor.notes.status.revealed") : t("editor.notes.status.revealFailed"));
      },
    };
  }, [bridge, copyTextToClipboard, currentVault, knowledgeStorageMode, vaultAbsolutePath, t]);

  const copyRealVaultDocumentAbsolutePath = useCallback(async (note: Note) => {
    if (!isRealVaultNoteId(note.id) || !currentVault) {
      setStatus(t("editor.notes.status.openVaultFirst"));
      return;
    }
    const absolutePath = vaultAbsolutePath(realVaultRelativePathFromNoteId(note.id));
    if (!absolutePath) {
      setStatus(t("editor.notes.status.noMarkdownPath"));
      return;
    }
    await copyTextToClipboard(absolutePath, t("editor.notes.status.absolutePathCopied"));
  }, [copyTextToClipboard, currentVault, vaultAbsolutePath, t]);

  const revealRealVaultDocument = useCallback(async (note: Note) => {
    if (!isRealVaultNoteId(note.id) || !currentVault) {
      setStatus(t("editor.notes.status.openVaultFirst"));
      return;
    }
    const absolutePath = vaultAbsolutePath(realVaultRelativePathFromNoteId(note.id));
    if (!absolutePath) {
      setStatus(t("editor.notes.status.noMarkdownPath"));
      return;
    }
    try {
      const revealed = bridge?.revealAssetPath ? await bridge.revealAssetPath(absolutePath) : false;
      setStatus(revealed ? t("editor.notes.status.revealed") : t("editor.notes.status.revealFailed"));
    } catch (error) {
      console.warn("[NotesPage] reveal real vault markdown failed", error);
      setStatus(t("editor.notes.status.revealFailed"));
    }
  }, [bridge, currentVault, vaultAbsolutePath, t]);

  const assetsTabCount = knowledgeStorageMode === "real-vault" ? realVaultEmbedItems.length : Math.max(assetsForNote.length, noteEmbeds.length);
  const openRealVaultEmbedItem = useCallback(async (item: RealVaultEmbedItem) => {
    const label = item.display || item.target || t("editor.notes.context.materialUntitled");
    if (item.targetNoteId) {
      void selectNote(item.targetNoteId, { scrollList: true });
      return;
    }
    if (item.libraryAssetId) {
      focusEntity("asset", item.libraryAssetId, { action: "focus-only", source: "notes-assets-tab" });
      window.location.hash = "#materials";
      setStatus(t("editor.notes.status.materialOpened", { label }));
      return;
    }
    if (item.assetExists === false || !item.assetRelativePath) {
      setStatus(t("editor.notes.status.materialNotFoundNamed", { label }));
      return;
    }
    if (item.assetExists === true && item.absolutePath) {
      const opened = bridge?.openFilePath ? await bridge.openFilePath(item.absolutePath) : false;
      setStatus(opened
        ? t("editor.notes.status.materialOpened", { label })
        : t("editor.notes.status.materialFoundPreviewPending", { label }));
      return;
    }
    setStatus(t("editor.notes.status.materialChecking", { label }));
  }, [bridge, selectNote, t]);

  const renderNotesIndexTools = () => (
    <div className="notes-index-tools" aria-label={t("editor.notes.action.operations")}>
      <button type="button" className="notes-index-new-note" onClick={() => openCreateDocumentDialog()} title={t("editor.notes.newDocument")} aria-label={t("editor.notes.newDocument")}>
        <svg viewBox="0 0 16 16"><path d="M3 2.5h6l4 4V14H3z" /><path d="M9 2.5V7h4" /><path d="M5.5 10h5M8 7.5v5" /></svg>
        <span className="notes-index-tool-label">{t("editor.notes.newDocument")}</span>
      </button>
      <button type="button" onClick={() => setDialog({ kind: "folder", parentId: selectedFolderId && selectedFolderId !== "__uncategorized__" ? selectedFolderId : null, name: "" })} title={t("editor.notes.dialog.newFolder")} aria-label={t("editor.notes.dialog.newFolder")}>
        <svg viewBox="0 0 16 16"><path d="M2 5.5h12v8H2z" /><path d="M2 5.5V3h4l1.5 2.5" /><path d="M8 8v3M6.5 9.5h3" /></svg>
        <span className="notes-index-tool-label">{t("editor.notes.dialog.newFolder")}</span>
      </button>
      <button
        type="button"
        onClick={() => setAttachmentImportOpen(true)}
        title={t("editor.notes.action.importMarkdown")}
        aria-label={t("editor.notes.action.import")}
      >
        <svg viewBox="0 0 16 16"><path d="M3 13.5h10" /><path d="M8 2.5v8" /><path d="M5 7.5l3 3 3-3" /><path d="M4 3h3M9 3h3" /></svg>
        <span className="notes-index-tool-label">{t("editor.notes.action.import")}</span>
      </button>
      <button
        type="button"
        onClick={() => void exportRealVaultMarkdown()}
        title={t("editor.notes.action.exportMarkdown")}
        aria-label={t("editor.notes.action.export")}
      >
        <svg viewBox="0 0 16 16"><path d="M3 13.5h10" /><path d="M8 10.5v-8" /><path d="M5 5.5l3-3 3 3" /><path d="M4 11h8" /></svg>
        <span className="notes-index-tool-label">{t("editor.notes.action.export")}</span>
      </button>
    </div>
  );

  const notesIndexFolderSelect = useCallback((id: string | null) => {
    startTransition(() => setSelectedFolderId(id));
  }, []);
  const notesIndexFolderCreate = useCallback((parentId: string | null) => {
    setDialog({ kind: "folder", parentId, name: "" });
  }, []);
  const notesIndexDocumentMove = useCallback((documentId: string, targetFolderId: string | null) => {
    void moveNote(documentId, targetFolderId);
  }, [moveNote]);
  const notesIndexDropRejected = useCallback((message: string) => {
    setStatus(message);
  }, []);
  const notesIndexImport = useCallback((folderId: string | null) => {
    void importRealVaultMarkdownFolder(folderId);
  }, [importRealVaultMarkdownFolder]);
  const notesIndexExport = useCallback((folderId: string | null) => {
    void exportRealVaultMarkdownFolder(folderId);
  }, [exportRealVaultMarkdownFolder]);
  const notesIndexOpenPaneNoteRef = useRef<(paneId: string, noteId: string) => Promise<boolean>>(async () => false);
  const notesIndexSelectDocument = useCallback((documentId: string) => {
    if (notesPaneLayout) {
      void notesIndexOpenPaneNoteRef.current(activeNotesSplitPaneRef.current, documentId);
      return;
    }
    void selectNote(documentId, { scrollList: true });
  }, [notesPaneLayout, selectNote]);

  const renderNotesTab = () => {
    const treeFolders = realVaultUiTree.folders;
    const treeDocumentsByFolderId = realVaultUiTree.documentsByFolderId;
    const treeUncategorizedDocuments = realVaultUiTree.uncategorizedDocuments;
    const treeNoteCount = realVaultUiTree.notes.length;

    return (
      <div className="notes-index-tab notes-index-folder-section">
        <FolderTree
          key={`${currentVault?.id || ""}:${currentVault?.rootPath || ""}`}
          folders={treeFolders}
          selectedId={selectedFolderId}
          onSelect={notesIndexFolderSelect}
          onCreate={notesIndexFolderCreate}
          hideHeader
          showAllItem={false}
          showUncategorized={false}
          scope="notes"
          documentsByFolderId={treeDocumentsByFolderId}
          allDocumentsByFolderId={treeDocumentsByFolderId}
          uncategorizedDocuments={treeUncategorizedDocuments}
          selectedDocumentId={selectedNoteId}
          documentRevealRequest={folderDocumentReveal
            && panelOpen && backlinksTab === "notes"
            && folderDocumentReveal.vaultId === currentVault?.id
            && vaultSessionRef.current.isCurrent(folderDocumentReveal.session, currentVault.id)
            && folderDocumentReveal.documentId === selectedNoteId ? folderDocumentReveal : null}
          forceOpenFolderIds={realVaultForceOpenFolderIds}
          onRename={renameFolderFromTree}
          onDelete={deleteFolderFromTree}
          onMove={moveFolderFromTree}
          onMoveDocument={notesIndexDocumentMove}
          onDropRejected={notesIndexDropRejected}
          nativeExternalDropEnabled={false}
          onImport={notesIndexImport}
          onExport={notesIndexExport}
          onExternalDrop={(folderId, drop: FolderTreeExternalDrop) => {
            const paths = drop.source === "tauri"
              ? drop.paths
              : extractDroppedLocalPaths(drop.event.dataTransfer);
            void importRealVaultDroppedPaths(folderId, paths);
          }}
          onSelectDocument={notesIndexSelectDocument}
          onDocumentContextMenu={(documentId, event) => {
            const note = notes.find((item) => item.id === documentId);
            if (note) handleContextMenu(event, note);
          }}
          onRenameDocument={renameDocumentFromTree}
          renameDocumentRequest={renameDocumentRequest}
          onCreateNote={(folderId) => {
            setSelectedFolderId(folderId);
            openCreateDocumentDialog(folderId);
          }}
          folderPathActions={realVaultFolderPathActions}
          getDeleteDisabledReason={(_folder, impact) => (
            impact.documentCount > 0 || impact.folderCount > 1 ? t("editor.notes.status.folderDeleteNonEmpty") : null
          )}
        />
        {loading && <div className="sidebar-note-empty">{t("editor.notes.status.loading")}</div>}
        {!loading && treeNoteCount === 0 && (
          <div className="sidebar-note-empty">{t("editor.notes.emptyVault")}</div>
        )}
      </div>
    );
  };

  const notesRootPaneId = notesPaneLayout ? firstNotesPaneId(notesPaneLayout) : "notes-pane-1";
  const notesTitlebarSplitId = getNotesTitlebarRow(notesPaneLayout)?.id || null;
  const notesTitlebarPaneId = getNotesTitlebarPaneId(notesPaneLayout);
  const rememberNotesPaneScroll = useCallback((paneId: string, tabId: string, scrollTop: number) => {
    notesPaneScrollPositionsRef.current.set(`${paneId}:${tabId}`, Math.max(0, scrollTop));
  }, []);
  const getNotesPaneScrollTop = useCallback((paneId: string, tabId: string) => (
    notesPaneScrollPositionsRef.current.get(`${paneId}:${tabId}`) || 0
  ), []);
  const getNotesSplitDocument = useCallback((paneId: string, tab: NotesOpenTab) => {
    if (tab.kind === "empty") return { title: t("editor.notes.newTab"), contentText: "" };
    const paneDocument = notesPaneDocuments[paneId]?.[tab.id];
    if (paneDocument) return paneDocument;
    const cached = notesPaneDocumentCacheRef.current.get(tab.id);
    const loaded = notes.find((note) => note.id === tab.id);
    const indexed = realVaultMarkdownIndex?.documents.find((document) => realVaultNoteId(document.relativePath) === tab.id);
    if (loaded) {
      const document = {
        title: noteTitle(loaded) || indexed?.title || markdownTitleFromPath(indexed?.relativePath || tab.id, t("editor.notes.untitled")),
        contentText: loaded.contentText || indexed?.plainText || cached?.contentText || indexed?.excerpt || "",
      };
      notesPaneDocumentCacheRef.current.set(tab.id, document);
      return document;
    }
    const document = {
      title: indexed?.title || markdownTitleFromPath(indexed?.relativePath || tab.id, t("editor.notes.untitled")),
      contentText: indexed?.plainText || cached?.contentText || indexed?.excerpt || "",
    };
    if (indexed) {
      notesPaneDocumentCacheRef.current.set(tab.id, document);
      return document;
    }
    return cached || document;
  }, [notes, notesPaneDocuments, realVaultMarkdownIndex, t]);

  const dockNotesPaneTab = useCallback((request: NotesDockTabRequest) => {
    if(notesNativeViews.hasFrozenViews())return;
    if (sourceComposingRef.current || workspaceCompositionActive()) return;
    const currentLayout: NotesPaneLayout = notesPaneLayout || { kind: "pane", id: "notes-pane-1" };
    const currentTabs = notesPaneTabs || { "notes-pane-1": openTabs };
    const currentActive = notesPaneActiveTabs || { "notes-pane-1": selectedNoteId || activeEmptyTabId || openTabs[0]?.id || "" };
    const currentState = { layout: currentLayout, tabs: currentTabs, activeTabs: currentActive, activePaneId: activeNotesSplitPane };
    const nextSequence = notesPaneSequenceRef.current + 1;
    const result = dockNotesTab(currentState, request, {
      paneId: `notes-pane-${nextSequence}`, splitId: `notes-split-${nextSequence}`, emptyTab: createEmptyNoteTab(),
    });
    if (result === currentState) return;
    // Commit the existing editor into its existing note-scoped draft owner
    // before remounting panes. Moving a tab never renames or writes a document.
    const activeContent = commitCurrentEditorDraft();
    captureNotesEditorSessions();
    const moving = currentTabs[request.sourcePaneId].find((tab) => tab.id === request.tabId)!;
    const sourceDocument: { title: string; contentText: string; loaded?: boolean } = getNotesSplitDocument(request.sourcePaneId, moving);
    const snapshot: NotesPaneDocumentSnapshot = {
      ...sourceDocument,
      contentText: moving.id === selectedNoteId ? activeContent : realVaultLatestContentRef.current.get(moving.id) ?? sourceDocument.contentText,
      loaded: moving.kind === "empty" || moving.id === selectedNoteId || Boolean(sourceDocument.loaded),
    };
    const destination = result.activePaneId;
    const remainingIds = new Set(notesPaneIds(result.layout));
    const nextDocuments: NotesPaneDocuments = {};
    for (const paneId of remainingIds) {
      nextDocuments[paneId] = { ...(notesPaneDocuments[paneId] || {}) };
      if (selectedNoteId && currentTabs[paneId]?.some((tab) => tab.id === selectedNoteId)) {
        nextDocuments[paneId][selectedNoteId] = { title: editTitle, contentText: activeContent, loaded: true };
      }
    }
    nextDocuments[destination] = { ...nextDocuments[destination], [moving.id]: snapshot };
    if (destination !== request.sourcePaneId && nextDocuments[request.sourcePaneId]) delete nextDocuments[request.sourcePaneId][moving.id];
    // Late document reads from the former location cannot reclaim focus.
    for (const paneId of new Set([request.sourcePaneId, destination])) {
      notesPaneLoadRequestRef.current.set(paneId, (notesPaneLoadRequestRef.current.get(paneId) || 0) + 1);
    }
    noteLoadRequestRef.current += 1;
    const scrollTop = notesPaneScrollPositionsRef.current.get(`${request.sourcePaneId}:${moving.id}`);
    if (scrollTop !== undefined) notesPaneScrollPositionsRef.current.set(`${destination}:${moving.id}`, scrollTop);
    const movingViewId = notesPaneViewsRef.current.get(request.sourcePaneId, moving.id);
    const movingMode = notesViewRefsRef.current.get(movingViewId)?.mode || notesPaneModes?.[request.sourcePaneId] || editorMode;
    const nextModes: NotesPaneModes = {};
    for (const paneId of remainingIds) nextModes[paneId] = notesPaneModes?.[paneId] || editorMode;
    nextModes[destination] = movingMode;
    const singlePane = result.layout.kind === "pane";
    notesPaneViewsRef.current.move(request.sourcePaneId, moving.id, destination);
    if (singlePane) notesPaneViewsRef.current.remapPane(destination, "notes-pane-1", result.tabs[destination]);
    notesPaneSequenceRef.current = nextSequence;
    setNotesPaneLayout(singlePane ? null : result.layout);
    setNotesPaneTabs(singlePane ? null : result.tabs);
    setNotesPaneActiveTabs(singlePane ? null : result.activeTabs);
    setNotesPaneModes(singlePane ? null : nextModes);
    setNotesPaneDocuments(singlePane ? { "notes-pane-1": nextDocuments[destination] } : nextDocuments);
    setNotesPaneAiStates((current) => {
      const next: NotesPaneAiStates = {};
      for (const paneId of remainingIds) next[paneId] = { ...(current[paneId] || {}) };
      const moved = current[request.sourcePaneId]?.[moving.id];
      if (moved) next[destination] = { ...next[destination], [moving.id]: moved };
      if (destination !== request.sourcePaneId && next[request.sourcePaneId]) delete next[request.sourcePaneId][moving.id];
      return next;
    });
    const activePaneId = singlePane ? "notes-pane-1" : destination;
    for (const tab of result.tabs[destination]) {
      const fromPane = tab.id === moving.id ? request.sourcePaneId : destination;
      const session = getNotesEditorSession(fromPane, tab.id);
      if (session) rememberNotesEditorSession(activePaneId, session);
    }
    if (singlePane) {
      const tabs = result.tabs[destination];
      openTabsRef.current = tabs;
      setOpenTabs(tabs);
    }
    setActiveNotesSplitPane(activePaneId);

    setEditorMode(nextModes[destination] || movingMode);
    setNotesPaneActivationVersion((version) => version + 1);
    if (snapshot.loaded) syncActiveNotesPaneDocument(activePaneId, moving, snapshot);
    else if (singlePane) void selectNote(moving.id, { syncGlobalTab: false });
    else void loadNotesPaneDocument(destination, moving);
  }, [captureNotesEditorSessions, getNotesEditorSession, rememberNotesEditorSession, activeEmptyTabId, activeNotesSplitPane, commitCurrentEditorDraft, editTitle, editorMode, getNotesSplitDocument, loadNotesPaneDocument, notesPaneActiveTabs, notesPaneDocuments, notesPaneLayout, notesPaneModes, notesPaneTabs, openTabs, selectedNoteId, selectNote, setActiveNotesSplitPane, setEditorMode, syncActiveNotesPaneDocument]);

  useEffect(() => {
    const onDock = (event: Event) => {if(pageVisibleRef.current&&!notesNativeViews.hasFrozenViews())dockNotesPaneTab((event as CustomEvent<NotesDockTabRequest>).detail);};
    window.addEventListener(NOTES_DOCK_TAB_EVENT, onDock);
    return () => window.removeEventListener(NOTES_DOCK_TAB_EVENT, onDock);
  }, [dockNotesPaneTab]);
  useEffect(() => () => cancelNotesTabPointerDrag(), [currentVault?.id, currentVault?.rootPath]);

  useEffect(() => {
    if (!currentVault?.id || !vaultBootstrapReady) return;
    const state: NotesPaneState = {
      layout: notesPaneLayout || { kind: "pane", id: "notes-pane-1" },
      tabs: notesPaneTabs || { "notes-pane-1": openTabs },
      activeTabs: notesPaneActiveTabs || { "notes-pane-1": selectedNoteId || activeEmptyTabId || openTabs[0]?.id || "" },
      activePaneId: notesPaneLayout ? activeNotesSplitPane : "notes-pane-1",
    };
    const capture = (): NotesLayoutSnapshot => ({
      version: 1, vaultId: currentVault.id, state,
      modes: notesPaneModes || { "notes-pane-1": editorMode }, indexOpen: panelOpen, indexWidth: visibleNotesIndexWidth,
    });
    const validate = (value: unknown) => validateNotesLayoutSnapshot(value, currentVault.id, state, canReopenSavedNote);
    let restoreMutationStarted=false;
    let restoreOwnedGeneration=-1;
    return registerIntegratedLayout("notes", {
      capture, validate,
      checkpoint: () => {
        if(selectedNoteId && (selectedNoteRef.current?.id!==selectedNoteId || selectedNoteIdRef.current!==selectedNoteId))throw Error('当前笔记仍在加载，请加载完成后再应用布局。');
        restoreMutationStarted=false;
        const checkpointSession = vaultSessionRef.current.latest();
        const content = commitCurrentEditorDraft();
        captureNotesEditorSessions();
        const sessions = new Map(notesPaneEditorSessionsRef.current);
        const restoreViewOwners = notesPaneViewsRef.current.checkpoint();
        const viewModes = new Map(Array.from(notesViewRefsRef.current, ([id, refs]) => [id, refs.mode] as const));
        const scroll = new Map(notesPaneScrollPositionsRef.current);
        const activeTab = state.tabs[state.activePaneId]?.find(tab => tab.id === state.activeTabs[state.activePaneId]);
        const document = activeTab ? { ...getNotesSplitDocument(state.activePaneId, activeTab), contentText: activeTab.id === selectedNoteId ? content : getNotesSplitDocument(state.activePaneId, activeTab).contentText, loaded: true } : null;
        return async () => {
          if (!restoreMutationStarted || !vaultSessionRef.current.isCurrent(checkpointSession) || noteLoadRequestRef.current!==restoreOwnedGeneration) return;
          cancelNotesTabPointerDrag();
          noteLoadRequestRef.current += 1;
          for (const [paneId, generation] of notesPaneLoadRequestRef.current) notesPaneLoadRequestRef.current.set(paneId, generation + 1);
          restoreViewOwners();
          for (const [id, mode] of viewModes) {
            const refs = notesViewRefsRef.current.get(id);
            if (refs) refs.mode = mode;
          }
          setNotesPaneLayout(notesPaneLayout);
          setNotesPaneTabs(notesPaneTabs);
          setNotesPaneActiveTabs(notesPaneActiveTabs);
          setNotesPaneModes(notesPaneModes);
          setNotesPaneDocuments(notesPaneDocuments);
          setNotesPaneAiStates(notesPaneAiStates);
          setOpenTabs(openTabs);
          openTabsRef.current = openTabs;
          notesPaneEditorSessionsRef.current = new Map(sessions);
          notesPaneScrollPositionsRef.current = new Map(scroll);
          setActiveNotesSplitPane(activeNotesSplitPane);
          setEditorMode(editorMode);
          setPanelOpen(panelOpen);
          setNotesIndexWidth(visibleNotesIndexWidth);
          setNotesPaneActivationVersion(version => version + 1);
          if (activeTab && document) syncActiveNotesPaneDocument(activeNotesSplitPane, activeTab, document);
        };
      },
      restore: async (value) => {
        if(notesNativeViews.hasFrozenViews())return false;
        if (!validateNotesLayoutSnapshot(value, currentVault.id, state, canReopenSavedNote) || sourceComposingRef.current || workspaceCompositionActive()) return false;
        if(selectedNoteId && (selectedNoteRef.current?.id!==selectedNoteId || selectedNoteIdRef.current!==selectedNoteId))throw Error('当前笔记仍在加载，请加载完成后再应用布局。');
        cancelNotesTabPointerDrag();
        const content = commitCurrentEditorDraft();
        captureNotesEditorSessions();
        const next = restoreNotesLayoutState(state, value);
        const documents: NotesPaneDocuments = {};
        const sourceByTab = new Map(Object.entries(state.tabs).flatMap(([paneId, tabs]) => tabs.map(tab => [tab.id, { paneId, tab }] as const)));
        const restoreSession = vaultSessionRef.current.latest();
        const restoreGeneration = ++noteLoadRequestRef.current;
        const baselinesBeforeRestore = new Map(realVaultSavedContentRef.current);
        const ownsDraft = (id:string) => realVaultUserDirtyRef.current.has(id) || (realVaultLatestContentRef.current.has(id) && realVaultLatestContentRef.current.get(id)!==realVaultSavedContentRef.current.get(id));
        const prepared = await preloadNotesLayout(value, tab => {
          const source = sourceByTab.get(tab.id);
          const snapshot: {title:string;contentText:string;loaded?:boolean}|undefined = source ? getNotesSplitDocument(source.paneId, source.tab) : undefined;
          return Boolean(source && ((tab.id === selectedNoteId && selectedNoteRef.current?.id===tab.id) || snapshot?.loaded));
        }, relativePath => realVaultDocumentSource.openDocument(relativePath),
        () => vaultSessionRef.current.isCurrent(restoreSession) && noteLoadRequestRef.current === restoreGeneration);
        for(const [id,loaded] of prepared){
          const baselineNow=realVaultSavedContentRef.current.get(id);
          if(baselineNow!==baselinesBeforeRestore.get(id)&&baselineNow!==loaded.contentText)throw Error('笔记刚刚完成了保存，请重新应用布局。当前内容保持不变。');
        }
        if(!vaultSessionRef.current.isCurrent(restoreSession)||noteLoadRequestRef.current!==restoreGeneration)throw Error('知识库或当前布局已变化，请重新应用布局。');
        restoreMutationStarted=true;
        restoreOwnedGeneration=restoreGeneration;
        const aiStates: NotesPaneAiStates = {};
        for (const paneId of notesPaneIds(next.layout)) {
          documents[paneId] = {};
          aiStates[paneId] = {};
          for (const tab of next.tabs[paneId]) {
            const source = sourceByTab.get(tab.id);
            const reopened = prepared.get(tab.id);
            const document: { title: string; contentText: string; loaded?: boolean } = reopened
              ? {title:reopened.title,contentText:reopened.contentText,loaded:true}
              : source ? getNotesSplitDocument(source.paneId, source.tab)
              : {title:t("editor.notes.newTab"),contentText:"",loaded:tab.kind==='empty'};
            const session = source ? getNotesEditorSession(source.paneId, tab.id) : undefined;
            if (session) rememberNotesEditorSession(next.layout.kind === "pane" ? "notes-pane-1" : paneId, session);
            documents[paneId][tab.id] = {
              ...document,
              contentText: tab.id === selectedNoteId ? content : reopened && !ownsDraft(tab.id) ? reopened.contentText : realVaultLatestContentRef.current.get(tab.id) ?? document.contentText,
              loaded: tab.kind === "empty" || tab.id === selectedNoteId || Boolean(document.loaded),
            };
            const ai = source ? notesPaneAiStates[source.paneId]?.[tab.id] : undefined;
            if (ai) aiStates[paneId][tab.id] = ai;
            const scroll = source ? notesPaneScrollPositionsRef.current.get(`${source.paneId}:${tab.id}`) : undefined;
            if (scroll !== undefined) notesPaneScrollPositionsRef.current.set(`${paneId}:${tab.id}`, scroll);
          }
        }
        for (const [id, loaded] of prepared) {
          if(!ownsDraft(id)){
            realVaultSavedContentRef.current.set(id,loaded.contentText);
            realVaultLatestContentRef.current.set(id,loaded.contentText);
          }
        }
        setNotes(current => {
          const nextNotes=[...current];
          for(const [id,loaded] of prepared){
            const note=noteFromKnowledgeDocument(loaded,t("editor.notes.untitled"));
            if(ownsDraft(id))note.contentText=realVaultLatestContentRef.current.get(id)??note.contentText;
            const index=nextNotes.findIndex(item=>item.id===id);if(index<0)nextNotes.push(note);else nextNotes[index]={...nextNotes[index],...note};
          }
          return nextNotes;
        });
        for (const paneId of Object.keys(state.tabs)) notesPaneLoadRequestRef.current.set(paneId, (notesPaneLoadRequestRef.current.get(paneId) || 0) + 1);
        noteLoadRequestRef.current += 1;
        restoreOwnedGeneration=noteLoadRequestRef.current;
        const single = next.layout.kind === "pane";
        const destination = next.activePaneId;
        const activePaneId = single ? "notes-pane-1" : destination;
        const activeTab = next.tabs[destination].find(tab => tab.id === next.activeTabs[destination]) || next.tabs[destination][0];
        const document = documents[destination][activeTab.id];
        // Prevent a restored pane id from colliding with the next new split.
        for (const paneId of notesPaneIds(next.layout)) {
          const sequence = Number(paneId.match(/^notes-pane-(\d+)$/)?.[1]);
          if (Number.isFinite(sequence)) notesPaneSequenceRef.current = Math.max(notesPaneSequenceRef.current, sequence);
        }
        notesPaneViewsRef.current.arrange(state.tabs, next.tabs);
        if (single) notesPaneViewsRef.current.remapPane(destination, "notes-pane-1", next.tabs[destination]);
        setNotesPaneLayout(single ? null : next.layout);
        setNotesPaneTabs(single ? null : next.tabs);
        setNotesPaneActiveTabs(single ? null : next.activeTabs);
        setNotesPaneModes(single ? null : value.modes);
        for (const [paneId, activeTabId] of Object.entries(next.activeTabs)) {
          const refs = notesViewRefsRef.current.get(notesPaneViewsRef.current.get(single ? "notes-pane-1" : paneId, activeTabId));
          if (refs && value.modes[paneId]) refs.mode = value.modes[paneId];
        }
        setNotesPaneDocuments(single ? { "notes-pane-1": documents[destination] } : documents);
        setNotesPaneAiStates(single ? { "notes-pane-1": aiStates[destination] } : aiStates);
        if (single) { openTabsRef.current = next.tabs[destination]; setOpenTabs(next.tabs[destination]); }
        setActiveNotesSplitPane(activePaneId);

        setEditorMode(value.modes[destination] || "live");
        setNotesPaneActivationVersion(version => version + 1);
        setPanelOpen(value.indexOpen);
        setNotesIndexWidth(Math.min(notesIndexLayoutMax, Math.max(NOTES_INDEX_MIN_WIDTH, value.indexWidth)));
        if (document.loaded) syncActiveNotesPaneDocument(activePaneId, activeTab, document);
        else if (!await loadNotesPaneDocument(activePaneId, activeTab)) return false;
        return true;
      },
    });
  }, [captureNotesEditorSessions, getNotesEditorSession, rememberNotesEditorSession, activeEmptyTabId, activeNotesSplitPane, commitCurrentEditorDraft, currentVault?.id, realVaultDocumentSource, t, editorMode, getNotesSplitDocument, loadNotesPaneDocument, notesIndexLayoutMax, notesPaneActiveTabs, notesPaneAiStates, notesPaneDocuments, notesPaneLayout, notesPaneModes, notesPaneTabs, openTabs, panelOpen, selectedNoteId, selectNote, setActiveNotesSplitPane, setEditorMode, syncActiveNotesPaneDocument, vaultBootstrapReady, visibleNotesIndexWidth]);

  const updateNotesSplitPaneContent = useCallback((paneId: string, tab: NotesOpenTab, value: string, mode: EditorMode) => {
    if (tab.kind === "empty") return;
    const currentDocument = getNotesSplitDocument(paneId, tab);
    setNotesPaneDocuments((current) => {
      let matched = false;
      const next: NotesPaneDocuments = {};
      for (const [candidatePaneId, documents] of Object.entries(current)) {
        const document = documents[tab.id];
        if (!document) {
          next[candidatePaneId] = documents;
          continue;
        }
        matched = true;
        next[candidatePaneId] = {
          ...documents,
          [tab.id]: { ...document, contentText: value, loaded: true },
        };
      }
      if (matched) return next;
      return {
        ...current,
        [paneId]: {
          ...(current[paneId] || {}),
          [tab.id]: { ...currentDocument, contentText: value, loaded: true },
        },
      };
    });
    if (activeNotesSplitPaneRef.current !== paneId || selectedNoteIdRef.current !== tab.id) return;
    if (mode === "source") setSourceContentDraft(value);
    handleContentChange(value);
  }, [getNotesSplitDocument, handleContentChange, setNotesPaneDocument]);

  const updateNotesSplitPaneTitle = useCallback((paneId: string, tab: NotesOpenTab, title: string) => {
    if (tab.kind === "empty") return;
    const document = getNotesSplitDocument(paneId, tab);
    setNotesPaneDocuments((current) => {
      let matched = false;
      const next: NotesPaneDocuments = {};
      for (const [candidatePaneId, documents] of Object.entries(current)) {
        const candidate = documents[tab.id];
        if (!candidate) {
          next[candidatePaneId] = documents;
          continue;
        }
        matched = true;
        next[candidatePaneId] = {
          ...documents,
          [tab.id]: { ...candidate, title, loaded: true },
        };
      }
      if (matched) return next;
      return {
        ...current,
        [paneId]: {
          ...(current[paneId] || {}),
          [tab.id]: { ...document, title, loaded: true },
        },
      };
    });
    if (activeNotesSplitPaneRef.current !== paneId || selectedNoteIdRef.current !== tab.id) return;
    handleTitleChange(title);
  }, [getNotesSplitDocument, handleTitleChange, setNotesPaneDocument]);

  const toggleNotesPaneAiSuggestionTag = useCallback((paneId: string, noteId: string, tag: string) => {
    const normalized = normalizeMarkdownTagName(tag);
    if (!normalized) return;
    const state = notesPaneAiStates[paneId]?.[noteId];
    const suggestionTags = uniqueMarkdownTagNames(state?.suggestion?.auto_tags || []);
    const selected = state?.selectedTags === null || state?.selectedTags === undefined
      ? suggestionTags
      : uniqueMarkdownTagNames(state.selectedTags);
    const next = selected.some((item) => item.toLocaleLowerCase() === normalized.toLocaleLowerCase())
      ? selected.filter((item) => item.toLocaleLowerCase() !== normalized.toLocaleLowerCase())
      : uniqueMarkdownTagNames([...selected, normalized]);
    updateNotesPaneAiState(paneId, noteId, { selectedTags: next });
    if (activeNotesSplitPaneRef.current === paneId && selectedNoteIdRef.current === noteId) {
      setAiSelectedTags(next);
    }
  }, [notesPaneAiStates, updateNotesPaneAiState]);

  const applyNotesPaneAiTags = useCallback(async (paneId: string, noteId: string) => {
    const state = notesPaneAiStates[paneId]?.[noteId];
    const suggestionTags = uniqueMarkdownTagNames(state?.suggestion?.auto_tags || []);
    const tagsToApply = state?.selectedTags === null || state?.selectedTags === undefined
      ? suggestionTags
      : uniqueMarkdownTagNames(state.selectedTags);
    if (!suggestionTags.length || !tagsToApply.length) {
      setStatus(t("editor.notes.status.selectAiTags"));
      return;
    }

    updateNotesPaneAiState(paneId, noteId, { busy: true });
    try {
      let successStatus = t("editor.notes.status.aiTagsApplied");
      if (isRealVaultNoteId(noteId)) {
        const tab: NotesOpenTab = { id: noteId, kind: "note" };
        const snapshot = getNotesSplitDocument(paneId, tab);
        const saved = await saveRealVaultTagNames(
          noteId,
          uniqueMarkdownTagNames([
            ...extractFrontmatterTagNamesForRealVault(snapshot.contentText),
            ...tagsToApply,
          ]),
          snapshot.contentText,
        );
        const nextContent = saved.contentText;
        const savedNote = saved.note;
        realVaultSavedContentRef.current.set(noteId, nextContent);
        realVaultLatestContentRef.current.set(noteId, nextContent);
        realVaultUserDirtyRef.current.delete(noteId);
        realVaultKeepEditingAfterConflictRef.current.delete(noteId);
        notesPaneDocumentCacheRef.current.set(noteId, { title: noteTitle(savedNote), contentText: nextContent });
        setNotesPaneDocuments((current) => {
          const next: NotesPaneDocuments = {};
          for (const [candidatePaneId, documents] of Object.entries(current)) {
            const candidate = documents[noteId];
            next[candidatePaneId] = candidate
              ? { ...documents, [noteId]: { ...candidate, title: noteTitle(savedNote), contentText: nextContent, loaded: true } }
              : documents;
          }
          return next;
        });
        updateNoteLocal(noteId, { ...savedNote, contentText: nextContent, contentJson: nextContent });
        if (activeNotesSplitPaneRef.current === paneId && selectedNoteIdRef.current === noteId) {
          setEditContent(nextContent);
          setSourceContentDraft(null);
        }
        if (!saved.mutation.indexWarning && !saved.mutation.indexStale) {
          await refreshRealVaultMarkdownIndex();
        }
        successStatus = knowledgeMutationSuccessStatus(saved.mutation, successStatus);
      } else {
        if (!bridge?.applyAiTags) {
          setStatus(t("editor.notes.status.aiTagsUnsupported"));
          return;
        }
        await bridge.applyAiTags("note", noteId, tagsToApply);
        await loadTags();
        if (activeNotesSplitPaneRef.current === paneId && selectedNoteIdRef.current === noteId) {
          await loadNoteRelations(noteId);
        }
      }
      updateNotesPaneAiState(paneId, noteId, {
        panelOpen: false,
        busy: false,
        suggestion: null,
        selectedTags: null,
      });
      setStatus(successStatus);
    } catch (error) {
      console.warn("[NotesPage] apply pane AI tags failed", error);
      setStatus(t("editor.notes.status.aiTagsFailed"));
    } finally {
      updateNotesPaneAiState(paneId, noteId, { busy: false });
    }
  }, [bridge, getNotesSplitDocument, loadNoteRelations, loadTags, notesPaneAiStates, refreshRealVaultMarkdownIndex, saveRealVaultTagNames, updateNoteLocal, updateNotesPaneAiState, t]);

  useEffect(() => {
    if (!selectedNoteId || !selectedNote) return;
    const document = {
      title: noteTitle(selectedNote),
      contentText: editContent,
      loaded: true,
    };
    notesPaneDocumentCacheRef.current.set(selectedNoteId, document);
    if (notesPaneLayout) setNotesPaneDocument(activeNotesSplitPane, selectedNoteId, document);
  }, [activeNotesSplitPane, editContent, notesPaneLayout, selectedNote, selectedNoteId, setNotesPaneDocument]);

  useEffect(() => {
    if (!notesPaneLayout || !selectedNoteId) return;
    if (notesPaneActiveTabs?.[activeNotesSplitPane] !== selectedNoteId) return;
    const restoreKey = `${activeNotesSplitPane}:${selectedNoteId}:${editorMode}:${notesPaneActivationVersion}`;
    if (notesPaneScrollRestoreKeyRef.current === restoreKey) return;
    notesPaneScrollRestoreKeyRef.current = restoreKey;
    const scrollTop = getNotesPaneScrollTop(activeNotesSplitPane, selectedNoteId);
    if (!scrollTop) return;
    return restoreNotesPaneScrollWhenReady(noteContentAreaRef.current, scrollTop);
  }, [activeNotesSplitPane, editorMode, getNotesPaneScrollTop, notesPaneActivationVersion, notesPaneActiveTabs, notesPaneLayout, selectedNoteId]);

  const openNotesSplitPaneNote = useCallback(async (paneId: string, noteId: string, options?: NoteSelectOptions): Promise<boolean> => {
    // A cache hit must retire the previous async load just like a fresh read.
    notesPaneLoadRequestRef.current.set(paneId, (notesPaneLoadRequestRef.current.get(paneId) || 0) + 1);
    const nextTab: NotesOpenTab = { id: noteId, kind: "note" };
    setNotesPaneTabs((current) => {
      if (!current) return current;
      const tabs = current[paneId] || [];
      if (tabs.some((tab) => tab.id === noteId)) return current;
      const activeTabIndex = tabs.findIndex((tab) => tab.id === notesPaneActiveTabs?.[paneId]);
      if (activeTabIndex < 0) return { ...current, [paneId]: [...tabs, nextTab] };
      const nextTabs = [...tabs];
      nextTabs[activeTabIndex] = nextTab;
      return { ...current, [paneId]: nextTabs };
    });
    setNotesPaneActiveTabs((current) => current ? { ...current, [paneId]: noteId } : current);
    setActiveNotesSplitPane(paneId);
    activeNotesSplitPaneRef.current = paneId;
    if (activeNotesSplitPane !== paneId) setNotesPaneActivationVersion((version) => version + 1);
    const tab = { id: noteId, kind: "note" as const };
    const document = notesPaneDocuments[paneId]?.[noteId];
    const opened = document?.loaded
      ? (syncActiveNotesPaneDocument(paneId, tab, document), true)
      : await loadNotesPaneDocument(paneId, tab);
    if (opened && options?.scrollList && selectedNoteIdRef.current === noteId) {
      revealDocumentInFolderTree(noteId);
    }
    return opened;
  }, [activeNotesSplitPane, loadNotesPaneDocument, notesPaneActiveTabs, notesPaneDocuments, revealDocumentInFolderTree, syncActiveNotesPaneDocument]);
  notesIndexOpenPaneNoteRef.current = openNotesSplitPaneNote;

  useEffect(() => {
    const consumePendingNoteFocus = () => {
      if(!pageVisibleRef.current||notesNativeViews.hasFrozenViews())return;
      const pendingFocus = readNavFocus();
      if (!pendingFocus || pendingFocus.type !== "note") return;
      let targetNoteId = pendingFocus.id;
      if (pendingFocus.id.startsWith("kdoc-")) {
        if (!vaultBootstrapReady) return;
        const decision = resolveKnowledgeNoteNavigation(pendingFocus.id, currentVault?.id);
        if (!decision.ok && pendingFocus.source === "material-attachment" && ["knowledge-note-vault-mismatch", "knowledge-vault-required"].includes(decision.code)) {
          const target = parseKnowledgeDocumentNoteId(pendingFocus.id);
          const candidate = readKnownNotesVaults().find(vault => vault.id === target?.vaultId);
          if (candidate && !vaultSwitchInFlightRef.current) {
            clearNavFocus("note", pendingFocus.id);
            void switchKnownVault(candidate).then(() => {
              if (readActiveKnowledgeWriteSource()?.vaultId === candidate.id) focusEntity("note", pendingFocus.id, { source: "material-attachment" });
            });
            return;
          }
        }
        if (!decision.ok) {
          clearNavFocus("note", pendingFocus.id);
          setStatus(decision.code === "knowledge-note-vault-mismatch"
            ? t("editor.notes.status.navigationVaultMismatch")
            : decision.code === "knowledge-vault-required"
              ? t("editor.notes.status.navigationVaultRequired")
              : t("editor.notes.status.navigationIdentityInvalid"));
          return;
        }
        if (knowledgeStorageMode !== "real-vault") {
          clearNavFocus("note", pendingFocus.id);
          setStatus(t("editor.notes.status.liveKnowledgeDisabled"));
          return;
        }
        targetNoteId = decision.internalNoteId;
      } else if (isRealVaultNoteId(pendingFocus.id)) {
        clearNavFocus("note", pendingFocus.id);
        setStatus(t("editor.notes.status.legacyNavigationMissingVault"));
        return;
      }
      const requestKey = `${pendingFocus.id}:${pendingFocus.ts || 0}`;
      if (noteNavigationInFlightRef.current === requestKey) return;
      noteNavigationInFlightRef.current = requestKey;
      void (async () => {
        setPanelOpen(true);
        const opened = notesPaneLayout
          ? await openNotesSplitPaneNote(activeNotesSplitPaneRef.current, targetNoteId, { scrollList: true })
          : await selectNote(targetNoteId, { scrollList: true }).then(() => selectedNoteIdRef.current === targetNoteId);
        if (opened) clearNavFocus("note", pendingFocus.id);
      })().finally(() => {
        if (noteNavigationInFlightRef.current === requestKey) noteNavigationInFlightRef.current = null;
      });
    };
    consumePendingNoteFocus();
    window.addEventListener("luckyray:nav-focus", consumePendingNoteFocus);
    return () => window.removeEventListener("luckyray:nav-focus", consumePendingNoteFocus);
  }, [currentVault, knowledgeStorageMode, notesPaneLayout, openNotesSplitPaneNote, selectNote, vaultBootstrapReady, switchKnownVault, t,visible]);

  const openNotesSplitPaneTagDialog = useCallback(async (request: NotesPaneAiRequest) => {
    activateNotesSplitPane(request.paneId, request.noteId);
    const selected = isRealVaultNoteId(request.noteId)
      ? (realVaultMarkdownIndex?.documents.find((document) => realVaultNoteId(document.relativePath) === request.noteId)?.frontmatterTags || []).map(realVaultTagId)
      : (bridge?.getNoteTags ? await bridge.getNoteTags(request.noteId).catch(() => []) : []);
    setDialog({ kind: "tag", selected });
  }, [activateNotesSplitPane, bridge, realVaultMarkdownIndex]);

  const requestNotesPaneAiSuggestion = useCallback((request: NotesPaneAiRequest) => {
    void generateAiSuggestion(request);
  }, [generateAiSuggestion]);

  const getNotesPaneAiState = useCallback((paneId: string, noteId: string) => (
    notesPaneAiStates[paneId]?.[noteId] || null
  ), [notesPaneAiStates]);

  const isNotesPaneAiBusy = useCallback((paneId: string, noteId: string) => {
    return Boolean(notesPaneAiStates[paneId]?.[noteId]?.busy);
  }, [notesPaneAiStates]);

  const openNotesSplitPaneEditorContext = useCallback((
    paneId: string,
    tab: NotesOpenTab,
    event: globalThis.MouseEvent,
    selection: { start: number; end: number },
    token?: LiveEditorTokenContext | null,
    table?: LiveEditorTableContext | null,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (tab.kind === "empty") return;
    activateNotesSplitPane(paneId, tab.id);
    setEditorCtx({
      x: Math.min(event.clientX, window.innerWidth - 220),
      y: Math.min(event.clientY, window.innerHeight - 360),
      token,
      table,
      selection,
    });
  }, [activateNotesSplitPane]);

  const retryKnowledgeBootstrap = useCallback(async () => {
    setStatus("");
    try {
      const snapshot = await knowledgeStore.revalidate({ reason: "notes-bootstrap-retry", force: true });
      if (snapshot.mode === "real-vault" && snapshot.vault) vaultSessionRef.current.begin(snapshot.vault.id);
      setCurrentVault(snapshot.mode === "real-vault" ? snapshot.vault : null);
      setRealVaultMarkdownIndex(snapshot.mode === "real-vault" ? snapshot.markdownIndex : null);
      if (snapshot.status === "error" && !snapshot.loaded) setStatus(t("editor.notes.status.vaultLoadFailed"));
    } catch {
      setStatus(t("editor.notes.status.vaultLoadFailed"));
    }
  }, [t]);

  const activeSurface = { selectedNoteFavorite, selectedNote, selectedNoteId, editTitle, editContent, editorMode, sourceTextareaValue, activeNoteEmbeds, activePreviewAssets, editorNoteLinks, activeNoteTags, aiPanelOpen, aiBusy, aiSuggestion, aiSuggestionTags, selectedAiTags, activeRealVaultExternalConflict, status, wordCount, lineCount };
  const renderNotesDocumentPane = (viewId: string, paneId: string, tab: NotesOpenTab) => {
    const isActive = activeNotesSplitPane === paneId && (tab.kind === "empty" ? activeEmptyTabId === tab.id : activeSurface.selectedNoteId === tab.id);
    const document = getNotesSplitDocument(paneId, tab);
    const cachedNote = notes.find(note => note.id === tab.id);
    const selectedNoteId = tab.kind === "empty" ? null : tab.id;
    const isDocumentReady = isActive && activeSurface.selectedNote?.id === tab.id;
    let viewRefs = notesViewRefsRef.current.get(viewId);
    if (!viewRefs) {
      viewRefs = { live: {current:null}, source: {current:null}, content: {current:null}, mode: notesPaneModes?.[paneId] || activeSurface.editorMode };
      notesViewRefsRef.current.set(viewId, viewRefs);
    }
    viewRefs.noteId=tab.id;
    if(!viewRefs.provenance){
      const source=readActiveKnowledgeWriteSource(),generation=vaultSessionRef.current.latest();
      if(currentVault&&source?.vaultId===currentVault.id&&vaultSessionRef.current.isCurrent(generation,currentVault.id))viewRefs.provenance={vault:{...currentVault},generation,source};
    }
    const readProof=realVaultReadProofRef.current.get(tab.id);
    if(viewRefs.provenance&&!viewRefs.provenance.workspaceSourceId&&readProof?.generation===viewRefs.provenance.generation&&readProof.source===viewRefs.provenance.source)viewRefs.provenance.workspaceSourceId=readProof.workspaceSourceId;
    if (isActive) viewRefs.mode = activeSurface.editorMode;
    const selectedNote = tab.kind === "empty" ? null : isDocumentReady ? activeSurface.selectedNote : {
      ...(cachedNote || noteFromKnowledgeDocument({id: tab.id, title: document.title, contentText: document.contentText, source:"real-vault"}, t("editor.notes.untitled"))),
      title: document.title, contentText: document.contentText,
    };
    const editContent = isDocumentReady ? activeSurface.editContent : realVaultLatestContentRef.current.get(tab.id) ?? document.contentText;
    const editTitle = isDocumentReady ? activeSurface.editTitle : document.title;
    const editorMode = viewRefs.mode;
    const sourceTextareaValue = isDocumentReady ? activeSurface.sourceTextareaValue : editContent;
    const media = getPaneMedia(tab.id);
    const activeNoteEmbeds = isActive ? activeSurface.activeNoteEmbeds : media.noteEmbeds;
    const activePreviewAssets = isActive ? activeSurface.activePreviewAssets : media.assets;
    const editorNoteLinks = isActive ? activeSurface.editorNoteLinks : [];
    const indexed = realVaultMarkdownIndex?.documents.find(entry => realVaultNoteId(entry.relativePath) === tab.id);
    const activeNoteTags = isActive ? activeSurface.activeNoteTags : (indexed?.frontmatterTags || []).map(realVaultTagId);
    const selectedNoteFavoriteIdentity = selectedNote ? resolveFavoriteNoteIdentity(selectedNote.id, currentVault?.id, {allowCurrentVaultLegacy:true}) : null;
    const selectedNoteFavorite = isActive ? activeSurface.selectedNoteFavorite : selectedNoteFavoriteIdentity?.aliases.map(id => noteFavorites.byId.get(id)).find(Boolean) || null;
    const ai = getNotesPaneAiState(paneId, tab.id);
    const aiPanelOpen = isActive ? activeSurface.aiPanelOpen : Boolean(ai?.panelOpen);
    const aiBusy = isActive ? activeSurface.aiBusy : isNotesPaneAiBusy(paneId, tab.id);
    const aiSuggestion = isActive ? activeSurface.aiSuggestion : ai?.suggestion;
    const aiSuggestionTags = isActive ? activeSurface.aiSuggestionTags : uniqueMarkdownTagNames(aiSuggestion?.auto_tags || []);
    const selectedAiTags = isActive ? activeSurface.selectedAiTags : ai?.selectedTags || aiSuggestionTags;
    const activeRealVaultExternalConflict = isActive ? activeSurface.activeRealVaultExternalConflict : null;
    const status = isActive ? activeSurface.status : "";
    const wordCount = editContent.trim().length;
    const lineCount = editContent ? editContent.split(/\r?\n/).length : 1;
    const paneTabs = notesPaneTabs?.[paneId] || openTabs;
    const paneRequest = { paneId, noteId: tab.id, title: editTitle, contentText: editContent };
    const showLocalHeader = Boolean(notesPaneLayout && paneId !== notesRootPaneId && paneId !== notesTitlebarPaneId);
    const handleContentChange = (value: string) => updateNotesSplitPaneContent(paneId, tab, value, editorMode);
    const handleTitleChange = (value: string) => updateNotesSplitPaneTitle(paneId, tab, value);
    const openNoteFromInlineLink = (noteId: string, options?: NoteOpenOptions) => notesPaneLayout
      ? void openNotesSplitPaneNote(paneId, noteId, options)
      : void selectNote(noteId, { ...options, scrollList: true, focusEditor: true });
    const presentationVault = viewRefs.provenance?.vault;
    const presentationGeneration = viewRefs.provenance?.generation;
    const presentationSource = viewRefs.provenance?.source;
    const presentationPath = realVaultRelativePathFromNoteId(tab.id);
    const presentationBinding = ():NotesNativeViewBinding => {
      if (!presentationVault || !presentationSource || presentationGeneration===undefined || vaultSwitchInFlightRef.current || !isRealVaultNoteId(tab.id) || presentationSource.vaultId !== presentationVault.id
        || !vaultSessionRef.current.isCurrent(presentationGeneration,presentationVault.id) || readActiveKnowledgeWriteSource() !== presentationSource
        || !notesPaneViewsRef.current.ids().has(viewId)) throw new Error('The exact Main note source is no longer current');
      return {viewId,vaultId:presentationVault.id,vault:{...presentationVault},workspaceSourceId:viewRefs!.provenance?.workspaceSourceId,documentId:knowledgeDocumentNoteId({vaultId:presentationVault.id,relativePath:presentationPath}),resourceId:presentationPath,relativePath:presentationPath,title:editTitle,generation:presentationGeneration};
    };
    const flushPresentation = async () => {
      const binding=presentationBinding();
      const current=()=>{const now=presentationBinding();if(now.generation!==binding.generation||now.documentId!==binding.documentId)throw new Error('Note source changed during save');};
      if (viewRefs!.live.current?.isComposing() || (sourceComposingRef.current && selectedNoteIdRef.current===tab.id)) throw new Error('Finish composition before moving this note');
      if(!realVaultSavedContentRef.current.has(tab.id)){
        // An unopened retained tab may show only an index excerpt. Read its
        // exact source before considering any write; an excerpt is no draft.
        if(realVaultUserDirtyRef.current.has(tab.id)||realVaultSaveInFlightRef.current.has(tab.id))throw new Error('This note has input without a verified saved baseline');
        const loaded=await realVaultDocumentSource.openDocument(binding.relativePath);current();
        if(!loaded.revision||loaded.relativePath!==binding.relativePath||realVaultUserDirtyRef.current.has(tab.id))throw new Error('Exact note hydration was superseded');
        realVaultSavedContentRef.current.set(tab.id,loaded.contentText);realVaultLatestContentRef.current.set(tab.id,loaded.contentText);
        notesPaneDocumentCacheRef.current.set(tab.id,{title:loaded.title,contentText:loaded.contentText});
        setNotesPaneDocument(paneId,tab.id,{title:loaded.title,contentText:loaded.contentText,loaded:true});
        await nextNotePresentationFrame();current();
      }
      const actual=viewRefs!.mode==='live'?viewRefs!.live.current?.getValue():viewRefs!.mode==='source'?viewRefs!.source.current?.value:realVaultLatestContentRef.current.get(tab.id)??editContent;
      if(actual===undefined)throw new Error('Exact note editor is not mounted');
      if(realVaultLatestContentRef.current.has(tab.id)&&realVaultLatestContentRef.current.get(tab.id)!==actual)throw new Error('This view has not received the latest document input');
      if(realVaultSavedContentRef.current.get(tab.id)!==actual&&!realVaultUserDirtyRef.current.has(tab.id))throw new Error('This view has no tracked draft for the changed content');
      const pending=realVaultSaveCompletionRef.current.get(tab.id);if(pending){await pending;current();}
      await savePatch({contentText:actual},tab.id,'explicit-save');current();
      const running=realVaultSaveCompletionRef.current.get(tab.id);if(running){await running;current();}
      if(realVaultUserDirtyRef.current.has(tab.id)||realVaultSavedContentRef.current.get(tab.id)!==actual)throw new Error('The note has unsaved input or a save conflict');
      const saved=await realVaultDocumentSource.openDocument(binding.relativePath);current();
      if(!saved.revision||saved.contentText!==actual||saved.relativePath!==binding.relativePath)throw new Error('The saved note changed before handoff');
      if(!presentationBinding().workspaceSourceId)throw new Error('This document read did not provide a native source proof; reopen it using the current native backend');
      return {revision:saved.revision,content:actual};
    };
    const releasePresentation=()=>{
      presentationBinding();
      if(notesPaneLayout){closeNotesSplitDocument(paneId,tab.id,true);return;}
      const remaining=openTabs.filter(item=>item.id!==tab.id),next=remaining.length?remaining:[createEmptyNoteTab()];
      setOpenTabs(next);
      if(selectedNoteIdRef.current===tab.id){const fallback=next[0];if(fallback.kind==='empty')showEmptyTab(fallback.id,{ensureOpen:false});else void selectNote(fallback.id,{scrollList:true,tabMode:'open'});}
    };
    return <MainNotePresentationRegistration viewId={viewId} paneId={paneId} enabled={Boolean(presentationVault&&isRealVaultNoteId(tab.id))} binding={presentationBinding}
      flush={flushPresentation} release={releasePresentation} hasUnsavedInput={()=>realVaultUserDirtyRef.current.has(tab.id)||realVaultSaveInFlightRef.current.has(tab.id)} mode={editorMode} content={editContent} media={{assets:activePreviewAssets,embeds:activeNoteEmbeds}}
      viewRefs={viewRefs} retained={getNotesEditorSession(paneId,tab.id)}
      changeMode={mode=>{viewRefs!.mode=mode;if(isActive)setEditorMode(mode);else setNotesPaneActivationVersion(version=>version+1);}}>
    <NoteDocumentSurface
      viewId={viewId}
      paneId={paneId}
      selectedNote={selectedNote}
      selectedNoteId={selectedNoteId}
      editTitle={editTitle}
      editorMode={editorMode}
      selectedNoteFavorite={selectedNoteFavorite}
      favoriteAvailable={Boolean(selectedNoteFavoriteIdentity)}
      filenameTitle={Boolean(selectedNote && isRealVaultNoteId(selectedNote.id))}
      attachmentProblem={attachmentProblem}
      attachmentSidebarOpen={attachmentSidebarOpen}
      activeNoteTags={activeNoteTags}
      tagDialogOpen={dialog?.kind === "tag"}
      aiPanelOpen={aiPanelOpen}
      aiBusy={aiBusy}
      aiSuggestion={aiSuggestion}
      aiSuggestionTags={aiSuggestionTags}
      selectedAiTags={selectedAiTags}
      panelOpen={panelOpen}
      wordCount={wordCount}
      lineCount={lineCount}
      activeRealVaultExternalConflict={activeRealVaultExternalConflict}
      status={status}
      mobileEditingNoteId={mobileEditingNoteId}
      locale={locale}
      viewRefs={viewRefs}
      areaEvents={{"onPointerDownCapture": () => { if (!isActive) flushSync(() => activateNotesSplitPane(paneId, tab.id)); },
"onFocusCapture": () => { if (!isActive) flushSync(() => activateNotesSplitPane(paneId, tab.id)); },
"onContextMenuCapture": (event) => {
                if (!isActive) flushSync(() => activateNotesSplitPane(paneId, tab.id));
                if (tab.kind !== "empty" && (selectedNoteIdRef.current !== tab.id || selectedNoteRef.current?.id !== tab.id)) { event.preventDefault(); event.stopPropagation(); }
              },
"onClickCapture": (event) => {
                // Activation may require an async read. Never run the previous
                // note's command while the requested document is still loading.
                if ((event.target as Element).closest("[data-notes-dock-tabs]")) return;
                if (tab.kind !== "empty" && (activeNotesSplitPaneRef.current !== paneId || selectedNoteIdRef.current !== tab.id || selectedNoteRef.current?.id !== tab.id)) {
                  event.preventDefault(); event.stopPropagation();
                  activateNotesSplitPane(paneId, tab.id);
                }
              },
"onPasteCapture": (event) => {
                if (selectedNoteIdRef.current !== tab.id || selectedNoteRef.current?.id !== tab.id) { event.preventDefault(); event.stopPropagation(); }
              },
"onKeyDownCapture": (event) => {
                if (event.key === "Tab" || (event.target as Element).closest("[data-notes-dock-tabs]")) return;
                if (tab.kind !== "empty" && (selectedNoteIdRef.current !== tab.id || selectedNoteRef.current?.id !== tab.id)) { event.preventDefault(); event.stopPropagation(); }
              },
"onDropCapture": (event) => {
                if (!isActive) flushSync(() => activateNotesSplitPane(paneId, tab.id));
                if (selectedNoteIdRef.current !== tab.id || selectedNoteRef.current?.id !== tab.id) { event.preventDefault(); event.stopPropagation(); }
              }}}
      contentEvents={{"onScrollCapture": (event) => {
                  if (!selectedNoteId || !notesPaneLayout) return;
                  const target = event.target;
                  if (target instanceof HTMLElement && target.matches(".cm-scroller, .note-preview, textarea")) {
                    rememberNotesPaneScroll(paneId, selectedNoteId, target.scrollTop);
                  }
                }}}
      sourceEditor={{"placeholder": selectedNote ? t("editor.notes.writePlaceholder") : t("editor.notes.selectPlaceholder"),
"value": sourceTextareaValue,
"readOnly": !isDocumentReady,
"disabled": !selectedNote || selectedNote.id !== selectedNoteId,
"onChange": (event) => {
                      if (activeNotesSplitPaneRef.current !== paneId || selectedNote?.id !== selectedNoteIdRef.current) return;
                      setSourceContentDraft(event.target.value);
                      handleContentChange(event.target.value);
                    },
"onFocus": publishActiveNoteContext,
"onClick": (event) => {
                      publishActiveNoteContext();
                      updateEditorAutocomplete(event.currentTarget.value, event.currentTarget.selectionStart);
                    },
"onKeyDown": (event) => {
                      if (handleSourceEditorShortcut(event)) return;
                      if (handleEditorKeyDown(event)) return;
                      handleSourceListShortcut(event);
                    },
"onKeyUp": (event) => {
                      publishActiveNoteContext();
                      if (event.nativeEvent.isComposing || sourceComposingRef.current) return;
                      updateEditorAutocomplete(event.currentTarget.value, event.currentTarget.selectionStart);
                    },
"onCompositionStart": () => {
                      viewRefs!.sourceComposing=true;
                      sourceComposingRef.current = true;
                      notesNativeViews.notifyDirty();
                      setAutocomplete(null);
                    },
"onCompositionEnd": (event) => {
                      viewRefs!.sourceComposing=false;
                      sourceComposingRef.current = false;
                      notesNativeViews.notifyDirty();
                      updateEditorAutocomplete(event.currentTarget.value, event.currentTarget.selectionStart);
                    },
"onSelect": (event) => {
                      publishActiveNoteContext();
                      updateEditorAutocomplete(event.currentTarget.value, event.currentTarget.selectionStart);
                    },
"onPaste": (event) => {
                      const files = event.clipboardData.files;
                      const textarea = event.currentTarget;
                      const selection = {
                        start: Math.min(textarea.selectionStart, textarea.selectionEnd),
                        end: Math.max(textarea.selectionStart, textarea.selectionEnd),
                      };
                      if (files.length) {
                        event.preventDefault();
                        event.stopPropagation();
                        void insertDroppedFilesAsAssets(files, selection);
                        return;
                      }
                      const imageSource = extractClipboardImageSource(event.clipboardData);
                      if (!imageSource) return;
                      event.preventDefault();
                      event.stopPropagation();
                      void insertClipboardImageAsAsset(imageSource, selection);
                    },
"onDragOver": (event) => {
                      if (!hasDraggedMaterialAsset(event.dataTransfer) && !event.dataTransfer.files.length) return;
                      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
                      event.preventDefault();
                    },
"onDrop": (event) => {
                      const asset = getDraggedMaterialAsset(event.dataTransfer);
                      const files = event.dataTransfer.files;
                      if (!asset && !files.length) return;
                      event.preventDefault();
                      event.stopPropagation();
                      const textarea = event.currentTarget;
                      textarea.focus();
                      if (asset) {
                        insertExistingAssetReference(asset, {
                          start: Math.min(textarea.selectionStart, textarea.selectionEnd),
                          end: Math.max(textarea.selectionStart, textarea.selectionEnd),
                        });
                        return;
                      }
                      void insertDroppedFilesAsAssets(files, {
                        start: Math.min(textarea.selectionStart, textarea.selectionEnd),
                        end: Math.max(textarea.selectionStart, textarea.selectionEnd),
                      });
                    },
"onContextMenu": (event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (selectedNote) {
                        const textarea = event.currentTarget;
                        const clickedPosition = sourceTextareaPositionFromPoint(textarea, event.clientX, event.clientY);
                        const selectionStart = Math.min(textarea.selectionStart, textarea.selectionEnd);
                        const selectionEnd = Math.max(textarea.selectionStart, textarea.selectionEnd);
                        const clickInsideSelection = selectionStart !== selectionEnd && clickedPosition >= selectionStart && clickedPosition <= selectionEnd;
                        const token = findSourceEditorTokenAt(textarea.value, clickedPosition, {
                          assets: activePreviewAssets,
                          currentNoteId: selectedNote.id,
                          noteEmbeds: activeNoteEmbeds,
                          noteLinks: editorNoteLinks,
                          notes: editorNotes,
                          tags: activeAllTags,
                        });
                        const menuSelection = token
                          ? { start: token.from, end: token.to }
                          : clickInsideSelection
                            ? { start: selectionStart, end: selectionEnd }
                            : { start: clickedPosition, end: clickedPosition };
                        if (token) textarea.setSelectionRange(token.from, token.to);
                        else if (!clickInsideSelection) textarea.setSelectionRange(clickedPosition, clickedPosition);
                        setEditorCtx({
                          x: Math.min(event.clientX, window.innerWidth - 220),
                          y: Math.min(event.clientY, window.innerHeight - 360),
                          token,
                          selection: menuSelection,
                        });
                      }
                    }}}
      liveEditor={{"restoreSession": getNotesEditorSession(paneId, selectedNoteId || "empty"),
"onSessionCapture": (snapshot) => { viewRefs!.session=snapshot;rememberNotesEditorSession(paneId, snapshot); },
"value": editContent,
"readOnly": !isDocumentReady,
"disabled": !selectedNote || selectedNote.id !== selectedNoteId,
"placeholderText": selectedNote ? t("editor.notes.writePlaceholder") : t("editor.notes.selectPlaceholder"),
"assets": activePreviewAssets,
"notes": editorNotes.map((note) => ({
                      id: note.id,
                      title: noteTitle(note),
                      folderId: note.folderId,
                      folderPath: note.folderId ? folderPathMap.get(note.folderId) || t("editor.notes.context.knowledgePath") : t("editor.notes.context.knowledgePath"),
                      contentText: note.contentText || "",
                      snippet: excerpt(note.contentText || ""),
                    })),
"tags": activeAllTags,
"noteLinks": editorNoteLinks,
"noteEmbeds": activeNoteEmbeds,
"currentNoteId": selectedNote?.id ?? null,
"onChange": (value) => { if (activeNotesSplitPaneRef.current === paneId && selectedNote?.id === selectedNoteIdRef.current) handleContentChange(value); },
"onFocus": publishActiveNoteContext,
"onSelectionChange": () => scheduleActiveNoteContext(),
"onCommand": handleLiveEditorCommand,
"onContextMenu": (event, selection, token, table) => {
                      if (notesPaneLayout) { openNotesSplitPaneEditorContext(paneId, tab, event, selection, token, table); return; }
                      event.preventDefault();
                      event.stopPropagation();
                      if (selectedNote) {
                        setEditorCtx({
                          x: Math.min(event.clientX, window.innerWidth - 220),
                          y: Math.min(event.clientY, window.innerHeight - 360),
                          token,
                          table,
                          selection,
                        });
                      }
                    },
"onOpenNote": openNoteFromInlineLink,
"onCreateNote": (title, openOptions) => void createLinkedNote(title, {
                      contentText: initialContentForMissingNoteAnchor(
                        openOptions,
                        (block) => t("editor.notes.context.pendingBlock", { block }),
                      ),
                      openOptions,
                    }),
"onOpenAsset": openAssetFromPreview,
"onOpenTag": openTagFromEditor,
"onCreateTag": (name) => void createAndSelectTag(name),
"onInsertFiles": (files, selection) => void insertDroppedFilesAsAssets(files, selection),
"onInsertClipboardImage": (source, selection) => void insertClipboardImageAsAsset(source, selection),
"onInsertAssetReference": (asset, selection) => insertExistingAssetReference(asset, selection)}}
      preview={{"text": editContent,
"currentNoteId": selectedNote?.id ?? null,
"noteLinks": editorNoteLinks,
"noteEmbeds": activeNoteEmbeds,
"assets": activePreviewAssets,
"notes": editorNotes,
"tags": activeAllTags,
"onOpenNote": openNoteFromInlineLink,
"onCreateNote": (title, openOptions) => void createLinkedNote(title, {
                      contentText: initialContentForMissingNoteAnchor(
                        openOptions,
                        (block) => t("editor.notes.context.pendingBlock", { block }),
                      ),
                      openOptions,
                    }),
"onOpenAsset": openAssetFromPreview,
"onOpenTag": openTagFromEditor,
"onCreateTag": (name) => void createAttachAndOpenTagFromToken(name),
"onToggleTask": togglePreviewTask}}
      localHeader={showLocalHeader ? <NotesPaneTabStrip visible={visible} paneId={paneId} tabs={paneTabs} activeId={tab.id}
                getTitle={(entry) => getNotesSplitDocument(paneId, entry).title}
                onActivate={activateNotesSplitPane} onCreate={createNotesSplitPaneTab} onClose={closeNotesSplitDocument}
                onSplit={(direction) => requestNotesSplit(direction, paneId)} /> : null}
      tagName={(id) => activeTagNameMap.get(id) || realVaultTagNameFromId(id)}
      actions={{
changeTitle: handleTitleChange,
askAi: () => notesPaneLayout ? askAiAboutPane(paneRequest) : askAiAboutNote(),
toggleFavorite: () => { void toggleSelectedNoteFavorite(); },
toggleAttachments: toggleAttachmentSidebar,
createDocument: () => notesPaneLayout ? openNotesSplitPaneCreateDocumentDialog(paneId) : openCreateDocumentDialog(),
browseDocuments: () => openNotesSplitPaneDocumentList(paneId),
closeTab: () => { window.dispatchEvent(new CustomEvent("luckyray:notes-tab-close-active")); },
removeTag, editTags: () => { void openNotesSplitPaneTagDialog(paneRequest); },
suggestAi: () => requestNotesPaneAiSuggestion(paneRequest),
toggleAiTag: (tag) => notesPaneLayout ? toggleNotesPaneAiSuggestionTag(paneId, tab.id, tag) : toggleAiSuggestionTag(tag),
applyAiTags: () => { if (notesPaneLayout) void applyNotesPaneAiTags(paneId, tab.id); else void applyAiTags(); },
toggleIndex: () => {
 const restoreWidth = notesIndexRestoreWidth({lastExpandedWidth:lastExpandedNotesIndexWidthRef.current,userSet:notesIndexWidthUserSetRef.current,viewportWidth:notesViewportWidthRef.current});
 const nextOpen = !panelOpen; if (nextOpen) setNotesIndexWidth(restoreWidth); setPanelOpen(nextOpen);
},
reloadConflict: reloadRealVaultConflictFromDisk, keepConflict: keepRealVaultConflictEdit,
retrySave: () => { const id=selectedNoteIdRef.current; if(id) void savePatch({contentText:readActiveEditorValue()},id,"explicit-save"); },
togglePreview: () => notesPaneLayout ? setNotesSplitPaneMode(paneId, editorMode === "preview" ? "live" : "preview") : togglePreviewMode(),
toggleSource: () => notesPaneLayout ? setNotesSplitPaneMode(paneId, editorMode === "source" ? "live" : "source") : toggleSourceMode(),
}}
    />
    </MainNotePresentationRegistration>;
  };

  useLayoutEffect(() => {
    const liveIds = notesPaneViewsRef.current.ids();
    for (const id of notesViewRefsRef.current.keys()) if (!liveIds.has(id)) notesViewRefsRef.current.delete(id);
    const tabId = selectedNoteId || activeEmptyTabId;
    if (!tabId) return;
    const paneId = notesPaneLayout ? activeNotesSplitPane : "notes-pane-1";
    const viewId = notesPaneViewsRef.current.get(paneId, tabId);
    const refs = notesViewRefsRef.current.get(viewId);
    liveEditorRef.current = refs?.live.current || null;
    textareaRef.current = refs?.source.current || null;
    noteContentAreaRef.current = refs?.content.current || null;
  });

  const receiveNativePaneStateRef=useRef({layout:notesPaneLayout,tabs:notesPaneTabs,activeTabs:notesPaneActiveTabs,openTabs,activePaneId:activeNotesSplitPane});
  receiveNativePaneStateRef.current={layout:notesPaneLayout,tabs:notesPaneTabs,activeTabs:notesPaneActiveTabs,openTabs,activePaneId:activeNotesSplitPane};
  const cancelIncomingPaneRef=useRef<(viewId:string,paneId:string,noteId:string,expectedToken:symbol)=>Promise<void>>(async()=>{throw new Error('Main incoming pane cleanup is not ready');});
  cancelIncomingPaneRef.current=async(viewId,paneId,noteId,expectedToken)=>{
    const isCurrent=()=>notesNativeViews.incomingToken(viewId)===expectedToken;
    if(!isCurrent())return;
    const deadline=Date.now()+5000;
    while(notesPaneViewsRef.current.ids().has(viewId)){
      if(!isCurrent())return;
      if(realVaultUserDirtyRef.current.has(noteId)||realVaultSaveInFlightRef.current.has(noteId)||notesViewRefsRef.current.get(viewId)?.sourceComposing)throw new Error('Incoming pane has pending input and was retained');
      closeNotesSplitDocument(paneId,noteId,true);
      await nextNotePresentationFrame();
      if(!isCurrent())return;
      if(Date.now()>=deadline)throw new Error('Incoming pane removal is still pending');
    }
    notesNativeViews.finishIncoming(viewId,expectedToken);
  };
  const receiveNativeNoteBusyRef=useRef(false);
  const receiveNativeNoteRef=useRef<(incoming:import('./notesNativeViewRegistry').NotesNativeIncomingView)=>Promise<NotesNativeViewAdapter>>(async()=>{throw new Error('Main notes are not ready');});
  receiveNativeNoteRef.current=async incoming=>{
    const vault=currentVault,generation=vaultSessionRef.current.latest(),source=readActiveKnowledgeWriteSource();
    if(!vaultBootstrapReady||!vault||!source||incoming.vaultId!==vault.id||source.vaultId!==vault.id||!incoming.relativePath
      ||knowledgeDocumentNoteId({vaultId:vault.id,relativePath:incoming.relativePath})!==incoming.documentId)throw new Error('Main must already have the matching vault open');
    const assertCurrent=()=>{if(!vaultSessionRef.current.isCurrent(generation,vault.id)||readActiveKnowledgeWriteSource()!==source)throw new Error('Main vault changed while receiving the note');};
    assertCurrent();
    if(receiveNativeNoteBusyRef.current)throw new Error('Another note is already being received in Main');
    const beforeLayout=receiveNativePaneStateRef.current;
    const assertLayoutCurrent=()=>{const current=receiveNativePaneStateRef.current;if(current.layout!==beforeLayout.layout||current.tabs!==beforeLayout.tabs||current.activeTabs!==beforeLayout.activeTabs||current.openTabs!==beforeLayout.openTabs||current.activePaneId!==beforeLayout.activePaneId)throw new Error('Main note layout changed while receiving the new view');};
    receiveNativeNoteBusyRef.current=true;
    try{
      const noteId=realVaultNoteId(incoming.relativePath),tab:NotesOpenTab={id:noteId,kind:'note'};
      commitCurrentEditorDraftRef.current();
      if(realVaultUserDirtyRef.current.has(noteId)||realVaultSaveInFlightRef.current.has(noteId))throw new Error('Main has an unsaved draft for this document');
      const loaded=await realVaultDocumentSource.openDocument(incoming.relativePath);assertCurrent();assertLayoutCurrent();
      if(!loaded.revision||loaded.relativePath!==incoming.relativePath||realVaultUserDirtyRef.current.has(noteId)||realVaultSaveInFlightRef.current.has(noteId))throw new Error('The incoming document read was superseded');
      captureNotesEditorSessions();
      const previous:NotesPaneState={layout:notesPaneLayout||{kind:'pane',id:'notes-pane-1'},tabs:notesPaneTabs||{'notes-pane-1':openTabs},activeTabs:notesPaneActiveTabs||{'notes-pane-1':selectedNoteId||activeEmptyTabId||openTabs[0]?.id||''},activePaneId:notesPaneLayout?activeNotesSplitPane:'notes-pane-1'};
      const sequence=++notesPaneSequenceRef.current,paneId=`notes-pane-${sequence}`;
      const next=appendIncomingNotesPane(previous,tab,paneId,`notes-split-${sequence}`);
      const targetViewId=incoming.viewId?notesPaneViewsRef.current.adopt(paneId,noteId,incoming.viewId):notesPaneViewsRef.current.get(paneId,noteId);
      if(!notesNativeViews.isIncoming(targetViewId))notesNativeViews.markIncoming(targetViewId);
      const incomingToken=notesNativeViews.incomingToken(targetViewId)!;
      notesNativeViews.stageIncoming(targetViewId,()=>cancelIncomingPaneRef.current(targetViewId,paneId,noteId,incomingToken));
      const document={title:loaded.title,contentText:loaded.contentText,loaded:true};
      // Shared document content may refresh; independent editor sessions,
      // selections, history, media and stable IDs remain owned by their views.
      realVaultSavedContentRef.current.set(noteId,loaded.contentText);realVaultLatestContentRef.current.set(noteId,loaded.contentText);
      notesPaneDocumentCacheRef.current.set(noteId,document);
      flushSync(()=>{
        setNotesPaneLayout(next.layout);setNotesPaneTabs(next.tabs);setNotesPaneActiveTabs(next.activeTabs);
        setNotesPaneModes(current=>({...current,[paneId]:'live'}));
        setNotesPaneDocuments(current=>({...current,[paneId]:{[noteId]:document}}));
        setActiveNotesSplitPane(paneId);setEditorMode('live');
        syncActiveNotesPaneDocument(paneId,tab,document);
      });
      const deadline=Date.now()+5000;
      while(Date.now()<deadline){
        assertCurrent();const mounted=notesNativeViews.list().find(view=>view.viewId===targetViewId&&view.vaultId===vault.id&&view.documentId===incoming.documentId&&view.generation===generation);
        if(mounted)return notesNativeViews.get(targetViewId);
        await nextNotePresentationFrame();assertCurrent();
      }
      throw new Error('The new independent Main note view did not mount');
    }finally{receiveNativeNoteBusyRef.current=false;}
  };
  useEffect(()=>notesNativeViews.registerReceiver(incoming=>receiveNativeNoteRef.current(incoming)),[]);
  const notesCoverageRef=useRef<()=>boolean>(()=>false);
  notesCoverageRef.current=()=>{
    const source=readActiveKnowledgeWriteSource(),generation=vaultSessionRef.current.latest();
    if(!vaultBootstrapReady||!currentVault||!source||source.vaultId!==currentVault.id||!vaultSessionRef.current.isCurrent(generation,currentVault.id))return false;
    const selected=selectedNoteIdRef.current;
    if(selected&&!Array.from(notesViewRefsRef.current.values()).some(refs=>refs.noteId===selected&&refs.committedPaneId===(notesPaneLayout?activeNotesSplitPaneRef.current:'notes-pane-1')))return false;
    for(const [viewId,refs] of notesViewRefsRef.current){
      if(!refs.noteId||!realVaultSavedContentRef.current.has(refs.noteId))continue;
      const proof=realVaultReadProofRef.current.get(refs.noteId),provenance=refs.provenance;
      if(!proof||!provenance||proof.source!==source||proof.generation!==generation||provenance.source!==source||provenance.generation!==generation||provenance.workspaceSourceId!==proof.workspaceSourceId)return false;
      const bound=notesNativeViews.get(viewId).binding();if(bound.workspaceSourceId!==proof.workspaceSourceId)return false;
      const dirty=realVaultUserDirtyRef.current.has(refs.noteId)||realVaultSaveInFlightRef.current.has(refs.noteId);
      const expected=dirty?realVaultLatestContentRef.current.get(refs.noteId):proof.content;
      if(expected===undefined||refs.committedContent!==expected||refs.committedMode!==refs.mode)return false;
      if(refs.mode==='live'&&refs.live.current?.getValue()!==expected)return false;
      if(refs.mode==='source'&&refs.source.current?.value!==expected)return false;
    }
    return true;
  };
  useEffect(()=>notesNativeViews.registerCoverage(()=>notesCoverageRef.current()),[]);
  useEffect(()=>{notesNativeViews.notifyViews();},[currentVault,vaultBootstrapReady,notesPaneLayout,notesPaneTabs]);
  useEffect(()=>{const changed=()=>notesNativeViews.notifyViews();window.addEventListener('luckyray:knowledge-source-changed',changed);return()=>window.removeEventListener('luckyray:knowledge-source-changed',changed);},[]);

  const managementReceiverRef=useRef<()=>import('./notesNativeViewRegistry').NotesNativeManagementReceiver>(()=>{throw new Error('Main notes are not ready');});
  managementReceiverRef.current=()=>{
    const vault=currentVault,generation=vaultSessionRef.current.latest(),source=readActiveKnowledgeWriteSource();
    const binding=()=>{
      if(!vaultBootstrapReady||!vault||!source||source.vaultId!==vault.id||!vaultSessionRef.current.isCurrent(generation,vault.id)||readActiveKnowledgeWriteSource()!==source)throw new Error('Main note management source changed');
      return {vaultId:vault.id,generation};
    };
    binding();
    return {binding,async open(section){
      binding();
      if(section==='vaults')setNotesIndexPanel('vault');
      else if(section==='settings')setNotesIndexPanel('settings');
      else if(section==='folders'){setNotesIndexPanel(null);setPanelOpen(true);}
      else if(section==='attachments')toggleAttachmentSidebar(true);
      else throw new Error('Unsupported note management section');
      await nextNotePresentationFrame();binding();
      const selector=section==='attachments'?'.lr-attachment-sidebar-frame':section==='folders'?'.note-backlinks.open':'.notes-index-popover-header';
      if(!document.querySelector(selector))throw new Error('Main note management did not mount');
    }};
  };
  useEffect(()=>notesNativeViews.registerManagement(()=>managementReceiverRef.current()),[]);


  if (!vaultBootstrapReady) {
    return (
      <div id="page-notes" className="page">
        <KnowledgeActivity
          failed={knowledgeSnapshot.status === "error" || Boolean(status)}
          onRetry={() => void retryKnowledgeBootstrap()}
        />
      </div>
    );
  }

  return (
    <NoteRouteVisibilityContext.Provider value={visible}>
    <NoteFilenameContext.Provider value={{ rename: commitFilename, namingId: namingNoteId, busyId: renamingNoteId, finish: id => setNamingNoteId(current => current === id ? null : current), focusBody: () => { requestAnimationFrame(focusActiveEditor); } }}>
    <div id="page-notes" className="page" {...vaultFileDrop} style={{ "--notes-index-width": `${visibleNotesIndexWidth}px` } as CSSProperties}>
      <div className="notes-layout">
        <div className="editor-pane active-pane">
          <div ref={editorRowRef} className={`editor-row${notesPaneLayout ? " notes-split-open" : ""}${panelOpen ? " index-open" : ""}${attachmentSidebarOpen ? " attachments-open" : ""}`}
            style={{ "--lr-attachment-width": `${attachmentSidebarWidth}px` } as CSSProperties}
            data-attachments-animating={attachmentSidebarAnimating ? "true" : undefined}>
            <NotesPaneTree
              key={`${currentVault?.id}:${currentVault?.rootPath}`}
              layout={notesPaneLayout}
              activePaneId={activeNotesSplitPane}
              paneTabs={notesPaneTabs || { "notes-pane-1": openTabs }}
              paneActiveTabs={notesPaneActiveTabs || { "notes-pane-1": selectedNoteId || activeEmptyTabId || openTabs[0]?.id || "" }}
              views={notesPaneViewsRef.current}
              titlebarSplitId={notesTitlebarSplitId}
              renderDocument={renderNotesDocumentPane}
              onStartDividerDrag={startNotesSplitDividerDrag}
              onUpdateDividerDrag={updateNotesSplitDividerDrag}
              onEndDividerDrag={endNotesSplitDividerDrag}
            />

              {attachmentSidebarOpen && currentVault ? (
                <div className="lr-attachment-sidebar-frame" style={{ width: attachmentSidebarWidth }}>
                  <div
                    className="lr-attachment-resize-handle"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="调整附件栏宽度"
                    title="拖动调整宽度，拖到最左侧收起"
                    onPointerDown={startAttachmentSidebarResize}
                  />
                  <NoteAttachmentSidebar
                    key={`${currentVault.id}:${currentVault.rootPath}`}
                    vaultId={currentVault.id}
                    currentPath={selectedNoteId && isRealVaultNoteId(selectedNoteId) ? realVaultRelativePathFromNoteId(selectedNoteId) : null}
                    editable={Boolean(selectedNote && selectedNote.id === selectedNoteId && editorMode !== 'preview')}
                    resolutionError={attachmentProblem}
                    onRetryResolution={() => { recheckAttachments(); void externalAttachmentFlow.retry(); }}
                    onClose={() => setAttachmentSidebarOpen(false)}
                    onOpenAsset={openAssetFromPreview}
                    onInsert={async asset => {
                      if (!selectedNote || selectedNote.id !== selectedNoteIdRef.current || editorMode === 'preview') throw new Error('请先打开可编辑笔记');
                      const noteId = selectedNote.id;
                      const session = captureAttachmentInsertSession(editorMode);
                      const intent = captureAttachmentInsertCursor(readActiveEditorSelection());
                      await serialAttachmentInsertsRef.current(
                        () => session.noteId === noteId && attachmentInsertSessionIsCurrent(session),
                        async queued => {
                          const selection = resolveAttachmentInsertSelection(intent, queued);
                          const before = readActiveEditorValue();
                          const prepared = await publishExistingAssetMarkdown(asset);
                          if (!attachmentInsertSessionIsCurrent(session)) throw new Error('编辑会话已切换；素材副本已保留在知识库中');
                          const replacement = materialBlockInsertion(before, prepared.markdown, selection);
                          replaceEditorRange(replacement, selection, prepared);
                          recordAttachmentInsertCommit(before, replacement, selection);
                          if (session.mode === 'source') await new Promise<void>(resolve => setTimeout(resolve, 0));
                        },
                      );
                    }}
                  />
                </div>
              ) : null}
              {/* Legacy fixed-two-pane markup retained here only as a patch boundary. */}
              {/*
              {notesSplit && splitPreviewPaneId && splitPreviewTab && activeEditorOrder === 1 && (
                <NotesSplitPanePreview
                  tab={splitPreviewTab}
                  title={splitPreviewDocument.title}
                  contentText={splitPreviewDocument.contentText}
                  order={3}
                  leading={splitPreviewPaneId === notesSplitLeadingPane}
                  showLocalHeader={notesSplit.direction === "up" || notesSplit.direction === "down" ? splitPreviewPaneId !== notesSplitTopPane : false}
                  onActivate={() => activateNotesSplitPane(splitPreviewPaneId)}
                  onAdd={() => createNotesSplitPaneTab(splitPreviewPaneId)}
                  onClose={() => closeNotesSplitPane(splitPreviewPaneId)}
                  onOpenNote={openNotesSplitPreviewNote}
                  onCreateNote={(title, openOptions) => void createLinkedNote(title, {
                    contentText: initialContentForMissingNoteAnchor(
                      openOptions,
                      (block) => t("editor.notes.context.pendingBlock", { block }),
                    ),
                    openOptions,
                  }).then((note) => note?.id && openNotesSplitPreviewNote(note.id))}
                  onOpenAsset={openAssetFromPreview}
                  onOpenTag={openTagFromEditor}
                  onCreateTag={(name) => void createAndSelectTag(name)}
                  assets={previewAssets}
                  notes={editorNotes}
                  tags={activeAllTags}
                />
              )}
              {notesSplit && (
                <div
                  className={`notes-split-resize-handle notes-split-resize-${notesSplit.direction === "left" || notesSplit.direction === "right" ? "vertical" : "horizontal"}`}
                  style={notesSplit.direction === "left" || notesSplit.direction === "right"
                    ? { left: `${notesSplitRatio * 100}%` }
                    : { top: `${notesSplitRatio * 100}%` }}
                  onPointerDown={beginNotesSplitResize}
                  role="separator"
                  aria-orientation={notesSplit.direction === "left" || notesSplit.direction === "right" ? "vertical" : "horizontal"}
                  aria-label="调整分屏大小"
                />
              )}
            </div>
              */}

            <div className={`note-backlinks${panelOpen ? " open" : ""}`}>
              <div className="backlinks-inner">
                <div className="backlinks-header-react">
                  <span>{t("editor.notes.index.title")}</span>
                  <div className="notes-index-header-actions">
                    <button type="button" onClick={() => setKnowledgeSearchOpen(true)} title={t("editor.notes.index.search")} aria-label={t("editor.notes.index.search")}>
                      <IconSearch />
                    </button>
                  </div>
                </div>
                <div className="notes-index-primary-controls">
                  <div className="notes-vault-row">
                    <button type="button" className="notes-vault-entry" onClick={() => setNotesIndexPanel("vault")}>
                      <span className="notes-vault-entry-main">
                        <span className="notes-vault-title">{currentVault?.name || t("editor.notes.vault.unopened")}</span>
                        <span className="notes-vault-meta">{currentVault?.rootPath || t("editor.notes.vault.setupHint")}</span>
                      </span>
                      <span className="notes-vault-badge">{currentVault ? t("editor.notes.vault.badgeReady") : t("editor.notes.vault.badgeSetup")}</span>
                    </button>
                    <button type="button" className="notes-vault-settings" onClick={() => setNotesIndexPanel("settings")} title={t("editor.notes.vault.settings")} aria-label={t("editor.notes.vault.settings")}>
                      <span
                        className="notes-vault-settings-icon"
                        style={{ "--notes-vault-settings-icon": `url("${settingsIconUrl}")` } as CSSProperties}
                        aria-hidden="true"
                      />
                    </button>
                  </div>
                  {renderNotesIndexTools()}
                </div>
                <div className="backlinks-tabs">
                  {(["backlinks", "outline", "notes", "assets"] as BacklinksTab[]).map((tab) => (
                    <button key={tab} className={`backlinks-tab${backlinksTab === tab ? " active" : ""}`} onClick={() => setBacklinksTab(tab)}>
                      {tab === "backlinks" ? (
                        <>{t("editor.notes.index.tab.relations")}{relationTabCount > 0 ? <span className="backlinks-tab-count">{relationTabCount}</span> : null}</>
                      ) : tab === "outline" ? t("editor.notes.index.tab.outline") : tab === "notes" ? t("editor.notes.index.tab.folders") : t("editor.notes.index.tab.assets")}
                    </button>
                  ))}
                </div>
                {backlinksTab === "notes" && (
                  <div className="sidebar-note-sort notes-index-sort" aria-label={t("editor.notes.index.sortAria")}>
                    <span className="sidebar-note-sort-label">
                      <svg viewBox="0 0 16 16"><path d="M3 4h10M3 8h7M3 12h4" /></svg>
                      {t("editor.notes.index.recentlyModified")}
                    </span>
                    <span className="sidebar-note-count">{notesIndexDocumentCountLabel}</span>
                  </div>
                )}
                <div className={`backlinks-content${backlinksTab === "notes" ? " notes-folder-content" : ""}`}>
                  {backlinksTab === "notes" && renderNotesTab()}
                  {backlinksTab === "outline" && (
                    <>
                      <h3>{t("editor.notes.outline.heading", { count: outline.length })}</h3>
                      {outline.length === 0 ? <div className="backlinks-empty">{t("editor.notes.outline.empty")}</div> : outline.map((item) => (
                        <button className="backlink-item" key={`${item.line}-${item.text}`} style={{ paddingLeft: 10 + item.level * 10 }} onClick={() => focusOutlineLine(item.line)}>
                          <div className="backlink-item-title">{item.text}</div>
                          <div className="backlink-item-preview">{t("editor.notes.outline.line", { line: item.line })}</div>
                        </button>
                      ))}
                    </>
                  )}
                  {backlinksTab === "backlinks" && (
                    <>
                      <div className="relation-health">
                        <div className="relation-health-item">
                          <strong>{connectedNoteLinks.length}</strong>
                          <span>{t("editor.notes.relations.connected")}</span>
                        </div>
                        <div className="relation-health-item">
                          <strong>{missingNoteLinks.length}</strong>
                          <span>{t("editor.notes.relations.missing")}</span>
                        </div>
                        <div className="relation-health-item">
                          <strong>{relationBacklinks.length}</strong>
                          <span>{t("editor.notes.relations.backlinks")}</span>
                        </div>
                      </div>
                      <h3>{t("editor.notes.relations.forward")}</h3>
                      {connectedNoteLinks.length === 0 ? <div className="backlinks-empty">{t("editor.notes.relations.noForward")}</div> : connectedNoteLinks.map((link) => {
                        const display = outgoingNoteLinkDisplays.get(normalizeNoteLinkKey(link.targetTitle));
                        const title = display?.label || link.targetTitle;
                        const preview = [t("editor.notes.relations.connected"), display?.meta].filter(Boolean).join(" · ");
                        return (
                          <button
                            type="button"
                            className="backlink-item"
                            key={link.targetTitle}
                            onClick={() => link.toNoteId && void selectNote(link.toNoteId, display?.openOptions || undefined)}
                          >
                            <div className="backlink-item-title">{title}</div>
                            <div className="backlink-item-preview">{preview}</div>
                          </button>
                        );
                      })}
                      <h3 className="backlinks-subheading">{t("editor.notes.relations.missing")}</h3>
                      {missingNoteLinks.length === 0 ? <div className="backlinks-empty">{t("editor.notes.relations.noMissing")}</div> : missingNoteLinks.map((link) => {
                        const display = outgoingNoteLinkDisplays.get(normalizeNoteLinkKey(link.targetTitle));
                        const title = display?.label || link.targetTitle;
                        const preview = [t("editor.notes.relations.createMissing"), display?.meta].filter(Boolean).join(" · ");
                        return (
                          <button
                            type="button"
                            className="backlink-item missing"
                            key={`missing-${link.targetTitle}`}
                            onClick={() => void createLinkedNote(link.targetTitle, {
                              contentText: initialContentForMissingNoteAnchor(
                                display?.openOptions,
                                (block) => t("editor.notes.context.pendingBlock", { block }),
                              ),
                              openOptions: display?.openOptions,
                            })}
                          >
                            <div className="backlink-item-title">{title}</div>
                            <div className="backlink-item-preview">{preview}</div>
                          </button>
                        );
                      })}
                      <h3 className="backlinks-subheading">{t("editor.notes.relations.reverseCount", { count: relationBacklinks.length })}</h3>
                      {relationBacklinks.length === 0 ? <div className="backlinks-empty">{t("editor.notes.relations.noReverse")}</div> : relationBacklinks.map((item) => (
                        <button type="button" className="backlink-item" key={`${item.id}-${item.snippet || ""}`} onClick={() => void selectNote(item.id)}>
                          <div className="backlink-item-title">{item.title || t("editor.notes.untitledNote")}</div>
                          <div className="backlink-item-preview">{item.snippet || shortDate(item.updatedAt, locale)}</div>
                        </button>
                      ))}
                      {!!relationUnlinkedMentions.length && <h3 className="backlinks-subheading">{t("editor.notes.relations.unlinkedCount", { count: relationUnlinkedMentions.length })}</h3>}
                      {relationUnlinkedMentions.map((item) => (
                        <button type="button" className="backlink-item unlinked" key={`unlinked-${item.id}`} onClick={() => void selectNote(item.id)}>
                          <div className="backlink-item-title">{item.title || t("editor.notes.untitledNote")}</div>
                          <div className="backlink-item-preview">{item.snippet || shortDate(item.updatedAt, locale)}</div>
                        </button>
                      ))}
                    </>
                  )}
                  {backlinksTab === "assets" && (
                    <>
                      <h3>{t("editor.notes.assets.heading", { count: assetsTabCount })}</h3>
                      {knowledgeStorageMode === "real-vault" ? (
                        realVaultEmbedItems.length === 0 ? <div className="backlinks-empty">{t("editor.notes.assets.empty")}</div> : realVaultEmbedItems.map((item) => {
                          const libraryAsset = item.libraryAssetId ? allAssets.find((asset) => asset.id === item.libraryAssetId) : null;
                          const vaultAsset = !libraryAsset && item.assetExists === true && item.assetRelativePath && item.absolutePath ? {
                            id: REAL_VAULT_ASSET_PREFIX + item.assetRelativePath,
                            name: item.display || realVaultAssetFileName(item.assetRelativePath, t("editor.notes.context.materialUntitled")),
                            kind: realVaultAssetKind(item.assetRelativePath),
                            libraryPath: item.absolutePath,
                          } : null;
                          return (
                          <div
                            className={"backlinks-asset-item" + (!item.targetNoteId && item.assetExists === false ? " missing" : "")}
                            key={"real-vault-embed-" + item.line + "-" + item.target}
                            onClick={() => void openRealVaultEmbedItem(item)}
                          >
                            <div className="backlinks-asset-thumb">{item.targetNoteId ? <IconWiki /> : libraryAsset ? <PreviewAssetMedia asset={libraryAsset} compact /> : vaultAsset ? <PreviewAssetMedia asset={vaultAsset} compact /> : item.assetExists === true ? "✓" : "?"}</div>
                            <div className="backlinks-asset-info">
                              <div className="backlinks-asset-name">{item.display}</div>
                              <div className="backlinks-asset-meta">{item.targetNoteId ? t("editor.notes.assets.resolvedMarkdown") : item.assetExists === true ? (item.assetMatchCount > 1 ? t("editor.notes.assets.multiple", { count: item.assetMatchCount }) : t("editor.notes.assets.found")) : item.assetExists === false ? t("editor.notes.assets.missing") : t("editor.notes.assets.checking")} · {item.snippet}</div>
                            </div>
                          </div>
                          );
                        })
                      ) : (
                        assetsForNote.length === 0 && noteEmbeds.length === 0 ? <div className="backlinks-empty">{t("editor.notes.assets.empty")}</div> : <>
                          {assetsForNote.map((asset) => (
                            <div className="backlinks-asset-item" key={asset.id} onClick={() => {
                              focusEntity("asset", asset.id, { action: "focus-only", source: "notes-assets-tab" });
                              window.location.hash = "#materials";
                            }}>
                              <div className="backlinks-asset-thumb"><PreviewAssetMedia asset={asset} compact /></div>
                              <div className="backlinks-asset-info">
                                <div className="backlinks-asset-name">{asset.name}</div>
                                <div className="backlinks-asset-meta">{asset.kind || t("editor.notes.index.tab.assets")}</div>
                              </div>
                            </div>
                          ))}
                          {noteEmbeds.filter((embed) => !embed.assetId).map((embed) => (
                            <div className="backlinks-asset-item missing" key={embed.targetName}>
                              <div className="backlinks-asset-thumb">?</div>
                              <div className="backlinks-asset-info">
                                <div className="backlinks-asset-name">{embed.targetName}</div>
                                <div className="backlinks-asset-meta">{t("editor.notes.assets.missing")}</div>
                              </div>
                            </div>
                          ))}
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
            {panelOpen && (
              <div
                className="notes-index-resize-handle"
                role="separator"
                aria-orientation="vertical"
                aria-label={t("editor.notes.index.resize")}
                title={t("editor.notes.index.resizeHint")}
                onPointerDown={startNotesIndexResize}
              />
            )}
          </div>
        </div>
      </div>

      {/* Keep editor/native owners mounted; hidden route overlays release modal and focus effects. */}
      <Activity mode={visible ? "visible" : "hidden"}>
      {noteCtx && (
        <div className="note-ctx-react" style={{ left: noteCtx.x, top: noteCtx.y }} onPointerDown={(event) => event.stopPropagation()}>
          <div role="menuitem" className="note-ctx-item-react" tabIndex={0} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.currentTarget.click(); } }} onClick={() => { openCreateDocumentDialog(noteCtx.note.folderId || null); setNoteCtx(null); }}>
            <IconPlus /><span>新建笔记</span>
          </div>
          <div role="menuitem" className="note-ctx-item-react" tabIndex={0} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.currentTarget.click(); } }} onClick={() => { setDialog({ kind: "folder", parentId: noteCtx.note.folderId || null, name: "" }); setNoteCtx(null); }}>
            <IconPlus /><span>新建文件夹</span>
          </div>
          <div className="note-ctx-sep-react" />
          <div className="note-ctx-item-react" onClick={() => { void selectNote(noteCtx.note.id, { scrollList: true, tabMode: "open" }); setNoteCtx(null); }}>
            <IconExternal />
            <span>{t("editor.notes.context.openNewTab")}</span>
          </div>
          {isRealVaultNoteId(noteCtx.note.id) && (
            <div className="note-ctx-item-react" onClick={() => { void openRealVaultDocumentWithDefaultApp(noteCtx.note); setNoteCtx(null); }}>
              <IconExternal />
              <span>{t("editor.notes.context.openDefault")}</span>
            </div>
          )}
          <div className="note-ctx-sep-react" />
          <div
            className="note-ctx-item-react"
            onClick={() => {
              setRenameDocumentRequest({ documentId: noteCtx.note.id, nonce: Date.now() });
              setNoteCtx(null);
            }}
          >
            <IconEdit />
            <span>{t("editor.notes.context.rename")}</span>
          </div>
          <div
            className="note-ctx-item-react"
            onClick={() => {
              setMoveModal({ note: noteCtx.note });
              setNoteCtx(null);
            }}
          >
            <IconArrowRight />
            <span>{t("editor.notes.context.move")}</span>
          </div>
          {isRealVaultNoteId(noteCtx.note.id) && (
            <>
              <div className="note-ctx-sep-react" />
              <div className="note-ctx-item-react" onClick={() => { void copyRealVaultDocumentAbsolutePath(noteCtx.note); setNoteCtx(null); }}>
                <IconCopy />
                <span>{t("editor.notes.context.copyAbsolutePath")}</span>
              </div>
              <div className="note-ctx-item-react" onClick={() => { void revealRealVaultDocument(noteCtx.note); setNoteCtx(null); }}>
                <IconExternal />
                <span>{t("editor.notes.context.reveal")}</span>
              </div>
            </>
          )}
          <div className="note-ctx-sep-react" />
          <div className="note-ctx-item-react" onClick={() => { void copyTextToClipboard(`[[${noteTitle(noteCtx.note)}]]`, t("editor.notes.status.linkCopied")); setNoteCtx(null); }}>
            <IconWiki />
            <span>{t("editor.notes.context.copyLink")}</span>
          </div>
          <div
            className="note-ctx-item-react"
            onClick={() => {
              void copyNote(noteCtx.note);
              setNoteCtx(null);
            }}
          >
            <IconCopy />
            <span>{t("editor.notes.context.copyDocument")}</span>
          </div>
          <div className="note-ctx-sep-react" />
          <div
            className="note-ctx-item-react danger"
            onClick={() => {
              setConfirmDelete({ note: noteCtx.note });
              setNoteCtx(null);
            }}
          >
            <IconTrash />
            <span>{t("editor.notes.context.deleteDocument")}</span>
          </div>
        </div>
      )}
      {editorCtx && (
        <EditorContextMenu
          x={editorCtx.x}
          y={editorCtx.y}
          aiBusy={aiWriteBusy}
          token={editorCtx.token}
          table={editorCtx.table}
          onCommand={(command) => void handleEditorCommand(command)}
          onTableCommand={(command) => editorCtx.table && handleTableEditorCommand(editorCtx.table, command)}
          onAiWrite={(action) => {
            const preservedSelection = editorCtx?.selection ?? null;
            setEditorCtx(null);
            void runAiWrite(action, preservedSelection);
          }}
          onOpenToken={openEditorToken}
          onOpenNoteInNewTab={openNoteTokenInBackgroundTab}
          onOpenAssetDetail={(assetId) => { setEditorCtx(null); openAssetFromPreview(assetId); }}
          onCopyToken={copyEditorTokenMarkdown}
          onCopyTokenLabel={copyEditorTokenLabel}
          onCopyTokenTarget={copyEditorTokenTarget}
          onEditNoteAlias={openLinkAliasDialog}
          onRenameTag={openTagRenameDialog}
          onRemoveToken={removeEditorToken}
        />
      )}

      {autocomplete && (
        <EditorAutocomplete
          state={autocomplete}
          onHover={(index) => setAutocomplete((current) => current ? { ...current, selectedIndex: index } : current)}
          onSelect={(item) => applyAutocompleteItem(item)}
        />
      )}

      {attachmentRelinkRequest && currentVault?.id === attachmentRelinkRequest.vaultId && <AttachmentRelinkDialog request={attachmentRelinkRequest} />}
      {attachmentImportOpen && currentVault && <AttachmentImportDialog key={currentVault.id} vaultId={currentVault.id} onCancel={() => setAttachmentImportOpen(false)} onImport={folder => { setAttachmentImportOpen(false); if (folder) void importRealVaultMarkdownFolder(); else void importRealVaultMarkdown(); }} />}
      {insertPicker && (
        <InsertReferencePicker
          state={insertPicker}
          items={insertPickerItems}
          onQueryChange={(query) => setInsertPicker((current) => current ? { ...current, query, selectedIndex: -1 } : current)}
          onSelectIndex={(index) => setInsertPicker((current) => current ? { ...current, selectedIndex: index } : current)}
          onCancel={() => setInsertPicker(null)}
          onInsert={(item) => insertPickedReference(item)}
        />
      )}

      {aiWriteMenu && (
        <div className="note-ai-menu-react" style={{ left: aiWriteMenu.x, top: aiWriteMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <div className="note-ai-menu-title">{t("editor.notes.ai.write")}</div>
          <button onClick={() => void runAiWrite("rewrite")} disabled={aiWriteBusy}>{t("editor.notes.ai.rewrite")}</button>
          <button onClick={() => void runAiWrite("shorten")} disabled={aiWriteBusy}>{t("editor.notes.ai.shorten")}</button>
          <button onClick={() => void runAiWrite("expand")} disabled={aiWriteBusy}>{t("editor.notes.ai.expand")}</button>
          <button onClick={() => void runAiWrite("continue")} disabled={aiWriteBusy}>{t("editor.notes.ai.continue")}</button>
        </div>
      )}

      {aiWriteBusy && !aiWritePreview && (
        <div className="note-inline-ai-running" role="status" aria-live="polite">
          <span>{t("editor.notes.ai.running")}</span>
          <button type="button" onClick={() => void cancelNotesInlineGeneration()}>{t("editor.notes.ai.stop")}</button>
        </div>
      )}

      {aiWritePreview && (
        <div className="modal-overlay-react note-inline-ai-overlay" onPointerDown={() => void discardNotesInlinePreview()}>
          <section className="note-inline-ai-preview" onPointerDown={(event) => event.stopPropagation()} aria-label={t("editor.notes.ai.preview")}>
            <header>
              <div>
                <strong>{t("editor.notes.ai.preview")}</strong>
                <span>{t("editor.notes.ai.previewHint")}</span>
              </div>
              <button type="button" aria-label={t("editor.notes.ai.closePreview")} onClick={() => void discardNotesInlinePreview()}>×</button>
            </header>
            <div className="note-inline-ai-diff">
              {aiWritePreview.originalText && (
                <div>
                  <label>{t("editor.notes.ai.original")}</label>
                  <pre>{aiWritePreview.originalText}</pre>
                </div>
              )}
              <div>
                <label>{aiWritePreview.action === "continue" ? t("editor.notes.ai.continuation") : t("editor.notes.ai.replacement")}</label>
                <pre>{aiWritePreview.replacementText}</pre>
              </div>
            </div>
            <footer>
              <button type="button" className="secondary" disabled={aiWriteApplying} onClick={() => void discardNotesInlinePreview()}>{t("editor.notes.ai.discard")}</button>
              {aiWritePreview.action !== "continue" && (
                <button type="button" className="secondary" disabled={aiWriteApplying} onClick={() => void applyNotesInlinePreview("insert-below")}>{t("editor.notes.ai.insertBelow")}</button>
              )}
              <button type="button" className="primary" disabled={aiWriteApplying} onClick={() => void applyNotesInlinePreview(aiWritePreview.defaultMode)}>
                {aiWriteApplying ? t("editor.notes.ai.applying") : aiWritePreview.defaultMode === "insert-below" ? t("editor.notes.ai.insert") : t("editor.notes.ai.replace")}
              </button>
            </footer>
          </section>
        </div>
      )}

      {linkAliasDialog && (
        <div className="modal-overlay-react" onPointerDown={() => setLinkAliasDialog(null)}>
          <div className="modal-box-react small" onPointerDown={(event) => event.stopPropagation()}>
            <div className="modal-header-react"><div className="modal-title-react">{linkAliasDialog.kind === "external" ? t("editor.notes.dialog.editExternal") : t("editor.notes.dialog.editReference")}</div></div>
            <div className="modal-body-react">
              {linkAliasDialog.kind === "external" ? (
                <>
                  <div className="notes-dialog-field-label">{t("editor.notes.dialog.title")}</div>
                  <input
                    className="notes-dialog-input"
                    value={linkAliasDialog.title}
                    autoFocus
                    onChange={(event) => setLinkAliasDialog({ ...linkAliasDialog, title: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        saveLinkAliasDialog();
                      }
                      if (event.key === "Escape") setLinkAliasDialog(null);
                    }}
                    placeholder={t("editor.notes.dialog.linkTitle")}
                  />
                  <div className="notes-dialog-field-label">{t("editor.notes.dialog.address")}</div>
                  <input
                    className="notes-dialog-input"
                    value={linkAliasDialog.href}
                    onChange={(event) => setLinkAliasDialog({ ...linkAliasDialog, href: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        saveLinkAliasDialog();
                      }
                      if (event.key === "Escape") setLinkAliasDialog(null);
                    }}
                    placeholder="https://"
                  />
                </>
              ) : (
                <>
                  <div className="notes-dialog-field-label">{t("editor.notes.dialog.target")}</div>
                  <input
                    className="notes-dialog-input"
                    value={linkAliasDialog.target}
                    autoFocus
                    onChange={(event) => setLinkAliasDialog({ ...linkAliasDialog, target: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        saveLinkAliasDialog();
                      }
                      if (event.key === "Escape") setLinkAliasDialog(null);
                    }}
                    placeholder={t("editor.notes.dialog.targetPlaceholder")}
                  />
                  <div className="notes-dialog-field-label">{t("editor.notes.dialog.displayText")}</div>
                  <input
                    className="notes-dialog-input"
                    value={linkAliasDialog.alias}
                    onChange={(event) => setLinkAliasDialog({ ...linkAliasDialog, alias: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        saveLinkAliasDialog();
                      }
                      if (event.key === "Escape") setLinkAliasDialog(null);
                    }}
                    placeholder={t("editor.notes.dialog.aliasPlaceholder")}
                  />
                </>
              )}
            </div>
            <div className="notes-dialog-actions">
              <button onClick={() => setLinkAliasDialog(null)}>{t("common.action.cancel")}</button>
              <button className="primary" onClick={saveLinkAliasDialog}>{t("common.action.confirm")}</button>
            </div>
          </div>
        </div>
      )}

      {tagRenameDialog && (
        <div className="modal-overlay-react" onPointerDown={() => setTagRenameDialog(null)}>
          <div className="modal-box-react small" onPointerDown={(event) => event.stopPropagation()}>
            <div className="modal-header-react"><div className="modal-title-react">{t("editor.notes.dialog.renameTag")}</div></div>
            <div className="modal-body-react">
              <div className="notes-dialog-field-label">{t("editor.notes.dialog.tagName")}</div>
              <input
                className="notes-dialog-input"
                value={tagRenameDialog.name}
                autoFocus
                onChange={(event) => setTagRenameDialog({ ...tagRenameDialog, name: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void saveTagRenameDialog();
                  }
                  if (event.key === "Escape") setTagRenameDialog(null);
                }}
                placeholder={t("editor.notes.dialog.tagName")}
              />
            </div>
            <div className="notes-dialog-actions">
              <button onClick={() => setTagRenameDialog(null)}>{t("common.action.cancel")}</button>
              <button className="primary" onClick={() => void saveTagRenameDialog()}>{t("common.action.confirm")}</button>
            </div>
          </div>
        </div>
      )}

      {dialog?.kind === "document" && (
        <div className="modal-overlay-react" onPointerDown={() => setDialog(null)}>
          <div className="modal-box-react small" onPointerDown={(event) => event.stopPropagation()}>
            <div className="modal-header-react"><div className="modal-title-react">{t("editor.notes.newDocument")}</div></div>
            <div className="modal-body-react">
              <input
                className="notes-dialog-input"
                value={dialog.name}
                autoFocus
                onChange={(event) => setDialog({ ...dialog, name: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void createDocumentFromDialog();
                  }
                  if (event.key === "Escape") setDialog(null);
                }}
                placeholder={t("editor.notes.dialog.documentName")}
              />
            </div>
            <div className="notes-dialog-actions">
              <button onClick={() => setDialog(null)}>{t("common.action.cancel")}</button>
              <button className="primary" onClick={() => void createDocumentFromDialog()}>{t("common.action.confirm")}</button>
            </div>
          </div>
        </div>
      )}

      {dialog?.kind === "folder" && (
        <div className="modal-overlay-react" onPointerDown={() => setDialog(null)}>
          <div className="modal-box-react small" onPointerDown={(event) => event.stopPropagation()}>
            <div className="modal-header-react"><div className="modal-title-react">{t("editor.notes.dialog.newFolder")}</div></div>
            <div className="modal-body-react">
              <input className="notes-dialog-input" value={dialog.name} autoFocus onChange={(event) => setDialog({ ...dialog, name: event.target.value })} placeholder={t("editor.notes.dialog.folderName")} />
            </div>
            <div className="notes-dialog-actions">
              <button onClick={() => setDialog(null)}>{t("common.action.cancel")}</button>
              <button className="primary" onClick={() => void createFolderFromDialog()}>{t("common.action.confirm")}</button>
            </div>
          </div>
        </div>
      )}

      {dialog?.kind === "tag" && (
        <TagDialog
          tags={activeAllTags}
          selected={dialog.selected}
          onChange={(selected) => setDialog({ kind: "tag", selected })}
          onCreateTag={(name) => void createAndSelectTag(name)}
          onClose={() => setDialog(null)}
          onSave={() => void saveTagSelection(dialog.selected)}
        />
      )}

      {moveModal && (
        <NoteMoveModal
          folders={isRealVaultNoteId(moveModal.note.id) ? realVaultUiTree.folders : folders}
          currentFolderId={moveModal.note.folderId}
          rootLabel={isRealVaultNoteId(moveModal.note.id) ? t("editor.notes.move.root") : t("editor.notes.move.uncategorized")}
          rootDescription={isRealVaultNoteId(moveModal.note.id) ? t("editor.notes.move.rootDescription") : t("editor.notes.move.uncategorizedDescription")}
          onClose={() => setMoveModal(null)}
          onSelect={(folderId) => void moveNote(moveModal.note.id, folderId)}
        />
      )}

      {notesIndexPanel && (
        <NotesIndexPopover
          attachmentSettings={currentVault && knowledgeStorageMode === "real-vault" ? <VaultAttachmentsPanel
            key={currentVault.id}
            vaultId={currentVault.id}
            relativePath={currentRealVaultRelativePath}
            notePaths={(realVaultMarkdownIndex?.documents || []).map(document => document.relativePath)}
            saveAffected={saveAffectedAttachmentNotes}
            chooseDirectory={async () => { if (!bridge?.selectVaultDirectory) throw new Error("当前环境不支持选择文件夹"); return bridge.selectVaultDirectory(); }}
            hasUnsavedChanges={() => Boolean(selectedNoteIdRef.current && (realVaultSaveInFlightRef.current.has(selectedNoteIdRef.current) || readActiveEditorValue() !== realVaultSavedContentRef.current.get(selectedNoteIdRef.current)))}
          /> : null}
          panel={notesIndexPanel}
          vault={currentVault}
          knownVaults={knownVaultChoices}
          switchingVaultId={switchingVaultId}
          switchError={vaultSwitchError}
          onClose={() => setNotesIndexPanel(null)}
          onUseRealVault={enterRealVaultMode}
          onCreateVault={createVaultFromPicker}
          onOpenVault={openVaultFromPicker}
          onOpenSettings={() => setNotesIndexPanel("settings")}
          onRefresh={() => void refreshCurrentSourceManually()}
          onSwitchVault={switchKnownVault}
        />
      )}

      <VaultLinkUpdateDialog flow={externalAttachmentFlow} />
      {importNotice && <ImportResultNotice receipt={importNotice} onClose={()=>setImportNotice(null)}/>}

      {knowledgeSearchOpen && (
        <KnowledgeSearchDialog
          query={knowledgeSearchQuery}
          results={knowledgeSearchResults}
          onQueryChange={setKnowledgeSearchQuery}
          onClose={() => setKnowledgeSearchOpen(false)}
          onOpenFolder={handleOpenKnowledgeSearchFolder}
          onOpenNote={handleOpenKnowledgeSearchNote}
          onSaveSmartFolder={() => {
            const query = knowledgeSearchQuery.trim();
            window.location.hash = smartFolderDraftHash({
              name: query ? t("editor.notes.smartFolder.named", { query: query.slice(0, 24) }) : t("editor.notes.smartFolder.defaultName"),
              criteria: { source: "note", query, tagIds: [], favorite: null, modified: { after: null, before: null } },
              sort: "modified-desc",
            });
          }}
        />
      )}

      {confirmDelete && (
        <div className="modal-overlay-react" onPointerDown={() => setConfirmDelete(null)}>
          <div className="modal-box-react small" onPointerDown={(event) => event.stopPropagation()}>
            <div className="modal-header-react"><div className="modal-title-react">{t("editor.notes.dialog.deleteNote")}</div></div>
            <div className="modal-body-react"><p className="notes-confirm-text">{t("editor.notes.dialog.deleteConfirm", { title: noteTitle(confirmDelete.note) })}</p></div>
            <div className="notes-dialog-actions">
              <button onClick={() => setConfirmDelete(null)}>{t("common.action.cancel")}</button>
              <button className="danger" onClick={() => void deleteNote(confirmDelete.note)}>{t("common.action.delete")}</button>
            </div>
          </div>
        </div>
      )}
      </Activity>
    </div>
    </NoteFilenameContext.Provider>
    </NoteRouteVisibilityContext.Provider>
  );
}

function KnowledgeActivity({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div
      className={`experience-knowledge-activity${failed ? " experience-error" : ""}`}
      role={failed ? "alert" : "status"}
      aria-live={failed ? "assertive" : "polite"}
    >
      <div className="experience-knowledge-activity-card">
        {!failed ? <span className="experience-knowledge-activity-mark" aria-hidden="true" /> : null}
        <strong>{failed ? t("editor.notes.status.vaultLoadFailed") : t("editor.notes.status.loading")}</strong>
        {failed ? <button type="button" onClick={onRetry}>{t("common.action.retry")}</button> : null}
      </div>
    </div>
  );
}

function NotesPaneTabStrip({
  visible,
  paneId,
  tabs,
  activeId,
  getTitle,
  onActivate,
  onCreate,
  onClose,
  onSplit,
}: {
  visible: boolean;
  paneId: string;
  tabs: NotesOpenTab[];
  activeId?: string;
  getTitle: (tab: NotesOpenTab) => string;
  onActivate: (paneId: string, tabId?: string) => void;
  onCreate: (paneId: string) => void;
  onClose: (paneId: string, tabId?: string) => void;
  onSplit: (direction: NotesSplitDirection) => void;
}) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(()=>{if(!visible)setMenuOpen(false);},[visible]);
  const split = (direction: NotesSplitDirection) => {
    setMenuOpen(false);
    onActivate(paneId);
    onSplit(direction);
  };
  return (
    <div className="notes-split-pane-tabs notes-titlebar" role="tablist" data-notes-dock-tabs={paneId} onPointerDown={(event) => event.stopPropagation()}>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tab"
          tabIndex={0}
          aria-selected={activeId === tab.id}
          className={`notes-split-pane-tab tab${activeId === tab.id ? " active" : ""}`}
          title={getTitle(tab)}
          data-notes-dock-tab={tab.id}
          onContextMenu={event=>{event.preventDefault();event.stopPropagation();}}
          onPointerDown={(event) => beginNotesTabPointerDrag(event, { sourcePaneId: paneId, tabId: tab.id, title: getTitle(tab) })}
          onClick={() => onActivate(paneId, tab.id)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onActivate(paneId, tab.id);
          }}
        >
          <span className="notes-split-pane-tab-label">{getTitle(tab)}</span>
          <button
            type="button"
            className="notes-split-pane-tab-close tab-close"
            aria-label={t("editor.notes.pane.closeTab")}
            title={t("editor.notes.pane.closeTab")}
            onClick={(event) => {
              event.stopPropagation();
              onClose(paneId, tab.id);
            }}
          >
            <IconClose />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="notes-split-pane-add tab-add-btn"
        title={t("editor.notes.newDocument")}
        aria-label={t("editor.notes.newDocument")}
        onClick={() => onCreate(paneId)}
      >
        <svg viewBox="0 0 16 16"><line x1="8" y1="3" x2="8" y2="13" /><line x1="3" y1="8" x2="13" y2="8" /></svg>
      </button>
      <div className="notes-split-pane-control">
        <button
          type="button"
          className="notes-split-pane-split tab-split-btn"
          title={t("editor.notes.pane.split")}
          aria-label={t("editor.notes.pane.split")}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="1" /><line x1="8" y1="3" x2="8" y2="13" /></svg>
        </button>
        {menuOpen && (
          <div className="notes-split-pane-menu" role="menu">
            <button type="button" title={t("editor.notes.pane.splitLeft")} onClick={() => split("left")}><svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="M6.5 3v10" /></svg></button>
            <button type="button" title={t("editor.notes.pane.splitRight")} onClick={() => split("right")}><svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="M9.5 3v10" /></svg></button>
            <button type="button" title={t("editor.notes.pane.splitUp")} onClick={() => split("up")}><svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="M2.5 6.5h11" /></svg></button>
            <button type="button" title={t("editor.notes.pane.splitDown")} onClick={() => split("down")}><svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="M2.5 9.5h11" /></svg></button>
          </div>
        )}
      </div>
    </div>
  );
}

class NotesNativeDraftSet extends KnowledgeDraftSet {
  add(id:string):this{super.add(id);notesNativeViews.notifyDirty();return this;}
  delete(id:string):boolean{const changed=super.delete(id);if(changed)notesNativeViews.notifyDirty();return changed;}
  clear():void{super.clear();notesNativeViews.notifyDirty();}
}
class NotesNativeSaveSet extends Set<string> {
  add(id:string):this{super.add(id);notesNativeViews.notifyDirty();return this;}
  delete(id:string):boolean{const changed=super.delete(id);if(changed)notesNativeViews.notifyDirty();return changed;}
  clear():void{super.clear();notesNativeViews.notifyDirty();}
}

type MainNotePresentationProps={
  viewId:string;paneId:string;enabled:boolean;binding:()=>NotesNativeViewBinding;flush:()=>Promise<{revision:string;content:string}>;
  release:()=>void;hasUnsavedInput:()=>boolean;mode:NoteViewMode;content:string;media:NoteMedia;retained:LiveEditorSessionSnapshot|null;
  viewRefs:{live:{current:LiveMarkdownEditorHandle|null};source:{current:HTMLTextAreaElement|null};content:{current:HTMLDivElement|null};session?:LiveEditorSessionSnapshot|null;sourceComposing?:boolean;contentScroll?:{top:number;left:number};committedContent?:string;committedMode?:NoteViewMode;committedPaneId?:string};
  changeMode:(mode:NoteViewMode)=>void;children:ReactNode;
};
/** Registration lifetime follows the stable mounted view, including hidden
 * tabs. Freezing or parking never unmounts its document, undo or media. */
function MainNotePresentationRegistration(props:MainNotePresentationProps){
  const latest=useRef(props);latest.current=props;
  const root=useRef<HTMLDivElement|null>(null),mounted=useRef(false),locked=useRef(false),parked=useRef(false);
  const sourceState=useRef<NoteSourcePresentation|undefined>(undefined);
  const retained=useRef<LiveEditorSessionSnapshot|null>(props.retained);
  const [status,setStatus]=useState({locked:false,parked:false});
  useLayoutEffect(()=>{
    const refs=props.viewRefs,changed=refs.committedContent!==props.content||refs.committedMode!==props.mode||refs.committedPaneId!==props.paneId;
    refs.committedContent=props.content;refs.committedMode=props.mode;refs.committedPaneId=props.paneId;
    if(changed)notesNativeViews.notifyViews();
  },[props.viewRefs,props.content,props.mode,props.paneId]);
  const frozenBinding=useRef<NotesNativeViewBinding|null>(null),saved=useRef<{revision:string;content:string}|null>(null);
  const sourceWasMeasurable=useRef(true);
  const captured=useRef<NoteViewPresentationSnapshot|null>(null),rollback=useRef<NoteViewPresentationSnapshot|null>(null),restoreSequence=useRef(0);
  useLayoutEffect(()=>()=>{
    sourceState.current=captureNoteSource(latest.current.viewRefs.source.current,sourceState.current);
    retained.current=latest.current.viewRefs.live.current?.captureSession()||retained.current;
  },[props.mode]);
  useLayoutEffect(()=>{
    if(!props.enabled)return;
    mounted.current=true;
    const binding=()=>{
      if(!mounted.current)throw new Error('Exact Main note view is unmounted');
      const value=latest.current.binding(),frozen=frozenBinding.current;
      if(frozen&&['viewId','vaultId','documentId','relativePath','generation'].some(key=>value[key as keyof NotesNativeViewBinding]!==frozen[key as keyof NotesNativeViewBinding]))throw new Error('Main note generation changed');
      return value;
    };
    const content=()=>{
      const current=latest.current;
      return current.mode==='live'?current.viewRefs.live.current?.getValue()??current.content:current.mode==='source'?current.viewRefs.source.current?.value??current.content:current.content;
    };
    const expected=(baseline:NoteViewBaseline)=>{
      freezeNotesNativeView({live:Boolean(latest.current.viewRefs.live.current?.isComposing()),source:latest.current.viewRefs.sourceComposing===true},()=>{});
      const value=binding();
      assertNotesNativeBaseline(value,saved.current,content(),baseline);
    };
    const assertCaptured=()=>{if(!locked.current||!captured.current)throw new Error('Main note has no captured freeze lease');expected(captured.current);};
    const adapter:NotesNativeViewAdapter={
      binding,
      isFrozen:()=>locked.current,
      isDirty:()=>latest.current.hasUnsavedInput()||Boolean(latest.current.viewRefs.live.current?.isComposing())||latest.current.viewRefs.sourceComposing===true,
      freeze(){
        binding();if(locked.current)throw new Error('Main note is already moving');
        freezeNotesNativeView({live:Boolean(latest.current.viewRefs.live.current?.isComposing()),source:latest.current.viewRefs.sourceComposing===true},()=>{
          sourceWasMeasurable.current=Boolean(latest.current.viewRefs.content.current?.clientHeight);
          frozenBinding.current=binding();locked.current=true;parked.current=false;saved.current=null;captured.current=null;rollback.current=null;
          if(root.current)root.current.inert=true;setStatus({locked:true,parked:false});
        });
      },
      async flush(){
        if(!locked.current)throw new Error('Freeze the exact Main view before saving');
        const before=binding();
        const result=await latest.current.flush();
        const after=binding();if(before.generation!==after.generation||content()!==result.content)throw new Error('Main note changed during save');
        saved.current=result;return true;
      },
      async capture(baseline){
        if(!locked.current)throw new Error('Freeze the exact Main view before capture');expected(baseline);
        if(captured.current)return validateNoteViewPresentation(captured.current,baseline);
        const current=latest.current,session=current.viewRefs.live.current?.captureSession()||current.viewRefs.session||retained.current||current.retained;
        retained.current=session;
        const live=current.mode==='live'?current.viewRefs.live.current?.capturePortableSession()||null:portableRetainedEditor(session?.state,baseline.content,{top:session?.scrollTop||0,left:session?.scrollLeft||0});
        // bindScoped supplies a full NoteSnapshot DTO; its documentRef/title are
        // not presentation fields. Project the baseline without widening the schema.
        const snapshot=validateNoteViewPresentation({version:1,authority:baseline.authority,revision:baseline.revision,content:baseline.content,mode:current.mode,live,...captureNoteSource(current.viewRefs.source.current,sourceState.current),contentScroll:captureNoteScroll(noteContentScrollElement(current.viewRefs.content.current),current.viewRefs.contentScroll),media:captureNoteMedia(current.viewRefs.content.current,current.media,baseline.content)},baseline);
        captured.current=snapshot;current.viewRefs.content.current?.querySelectorAll<HTMLMediaElement>('video,audio').forEach(element=>element.pause());
        return snapshot;
      },
      async restore(baseline,input){
        if(!locked.current)throw new Error('Freeze the Main destination before restoring');
        expected(baseline);const snapshot=validateNoteViewPresentation(input,baseline),sequence=++restoreSequence.current;
        if(!rollback.current)rollback.current=await adapter.capture(baseline);expected(baseline);
        const check=()=>{expected(baseline);if(sequence!==restoreSequence.current||!locked.current)throw new Error('Main note restore was cancelled');};
        if(snapshot.live){latest.current.changeMode('live');await nextNotePresentationFrame();check();const live=latest.current.viewRefs.live.current;if(!live)throw new Error('Main live editor did not mount');await live.restorePortableSession(snapshot.live);check();retained.current=live.captureSession();}
        latest.current.changeMode(snapshot.mode);await nextNotePresentationFrame();check();
        sourceState.current={sourceSelection:snapshot.sourceSelection,sourceScroll:snapshot.sourceScroll};restoreNoteSource(latest.current.viewRefs.source.current,snapshot);
        const target=noteContentScrollElement(latest.current.viewRefs.content.current);if(!target)throw new Error('Main note content did not mount');target.scrollTop=snapshot.contentScroll.top;target.scrollLeft=snapshot.contentScroll.left;
        await restoreNoteMedia(()=>latest.current.viewRefs.content.current,()=>latest.current.media,baseline.content,snapshot.media,check);check();
        await restoreNotePresentationLayout(snapshot,{source:()=>latest.current.viewRefs.source.current,content:()=>latest.current.viewRefs.content.current,liveScroll:()=>latest.current.viewRefs.live.current?.getScrollElement()||null},check);check();
        captured.current=snapshot;
      },
      async release(){assertCaptured();parked.current=true;setStatus({locked:true,parked:true});await nextNotePresentationFrame();assertCaptured();},
      async commitRelease(){assertCaptured();if(!parked.current)throw new Error('Main source has not been parked');latest.current.release();},
      async cancelIncoming(){
        const incomingToken=notesNativeViews.incomingToken(props.viewId);
        binding();if(!incomingToken||!locked.current||latest.current.hasUnsavedInput())throw new Error('Only an unedited frozen incoming note admission may be cancelled');
        freezeNotesNativeView({live:Boolean(latest.current.viewRefs.live.current?.isComposing()),source:latest.current.viewRefs.sourceComposing===true},()=>{latest.current.release();});
        await nextNotePresentationFrame();if(notesNativeViews.incomingToken(props.viewId)===incomingToken)throw new Error('Cancelled incoming note view did not unmount');
      },
      async activate(){assertCaptured();if(parked.current)throw new Error('Parked source cannot be activated');rollback.current=null;captured.current=null;saved.current=null;locked.current=false;frozenBinding.current=null;if(root.current)root.current.inert=false;setStatus({locked:false,parked:false});notesNativeViews.finishIncoming(props.viewId);},
      async abort(){
        const retainedCapture=captured.current,retainedRollback=rollback.current;
        restoreSequence.current++;parked.current=false;setStatus({locked:true,parked:false});
        try{if(retainedRollback){await adapter.restore(retainedRollback,retainedRollback);}else if(retainedCapture){expected(retainedCapture);await nextNotePresentationFrame();expected(retainedCapture);await restoreNoteMedia(()=>latest.current.viewRefs.content.current,()=>latest.current.media,retainedCapture.content,retainedCapture.media,()=>expected(retainedCapture));if(sourceWasMeasurable.current)await restoreNotePresentationLayout(retainedCapture,{source:()=>latest.current.viewRefs.source.current,content:()=>latest.current.viewRefs.content.current,liveScroll:()=>latest.current.viewRefs.live.current?.getScrollElement()||null},()=>expected(retainedCapture));}}
        catch(error){captured.current=retainedCapture;rollback.current=retainedRollback;locked.current=true;if(root.current)root.current.inert=true;setStatus({locked:true,parked:false});throw error;}
        notesNativeViews.finishIncoming(props.viewId);locked.current=false;frozenBinding.current=null;captured.current=null;rollback.current=null;saved.current=null;if(root.current)root.current.inert=false;setStatus({locked:false,parked:false});
      },
    };
    const unregister=notesNativeViews.register(props.viewId,adapter);
    return()=>{mounted.current=false;restoreSequence.current++;unregister();};
  },[props.viewId,props.enabled]);
  return <div ref={root} style={{display:status.parked?'none':'contents'}} inert={status.locked||notesNativeViews.isIncoming(props.viewId)} data-note-presentation-owner={props.viewId}
    onCompositionStartCapture={()=>{latest.current.viewRefs.sourceComposing=true;notesNativeViews.notifyDirty();}}
    onCompositionEndCapture={()=>{latest.current.viewRefs.sourceComposing=false;queueMicrotask(()=>notesNativeViews.notifyDirty());}}
    onSelectCapture={()=>{sourceState.current=captureNoteSource(latest.current.viewRefs.source.current,sourceState.current);}}
    onScrollCapture={event=>{sourceState.current=captureNoteSource(latest.current.viewRefs.source.current,sourceState.current);if(event.target instanceof HTMLElement&&event.target.matches('.note-preview'))latest.current.viewRefs.contentScroll=captureNoteScroll(event.target,latest.current.viewRefs.contentScroll);}}>{props.children}</div>;
}

function NotesPaneTree({ layout, activePaneId, paneTabs, paneActiveTabs, views, titlebarSplitId, renderDocument, onStartDividerDrag, onUpdateDividerDrag, onEndDividerDrag }: {
  layout: NotesPaneLayout | null;
  activePaneId: string;
  paneTabs: NotesPaneTabs;
  paneActiveTabs: NotesPaneActiveTabs;
  views: NotesPaneViews;
  titlebarSplitId: string | null;
  renderDocument: (viewId: string, paneId: string, tab: NotesOpenTab) => ReactNode;
  onStartDividerDrag: (event: ReactPointerEvent<HTMLDivElement>, splitId: string, orientation: "row" | "column") => void;
  onUpdateDividerDrag: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onEndDividerDrag: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [rects, setRects] = useState<Record<string, {left:number;top:number;width:number;height:number}>>({});
  const currentLayout: NotesPaneLayout = layout || {kind:"pane",id:"notes-pane-1"};
  const entries = views.list(currentLayout, paneTabs);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const box = root.getBoundingClientRect();
      const next: typeof rects = {};
      root.querySelectorAll<HTMLElement>("[data-notes-pane-slot]").forEach(slot => {
        const rect = slot.getBoundingClientRect();
        next[slot.dataset.notesPaneSlot!] = {left:rect.left-box.left,top:rect.top-box.top,width:rect.width,height:rect.height};
      });
      setRects(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    root.querySelectorAll<HTMLElement>("[data-notes-pane-slot]").forEach(slot => observer.observe(slot));
    measure();
    return () => observer.disconnect();
  }, [layout]);
  const geometry = (entry: NotesPaneLayout): ReactNode => {
    if (entry.kind === "pane") return <div className="notes-pane-slot" data-notes-pane-slot={entry.id} />;
    const mappedTrack = `var(${NOTES_SPLIT_LIVE_FIRST_TRACK}, ${notesSplitFirstTrack(entry.ratio)})`;
    const style: CSSProperties = entry.orientation === "row"
      ? {gridTemplateColumns:`${entry.id === titlebarSplitId ? mappedTrack : notesSplitFirstTrack(entry.ratio)} 8px minmax(0,1fr)`}
      : {gridTemplateRows:`${notesSplitFirstTrack(entry.ratio)} 8px minmax(0,1fr)`};
    return <div className={`notes-pane-split notes-pane-split-${entry.orientation}`} style={style}>
      <div className="notes-pane-split-region notes-pane-split-region-first">{geometry(entry.first)}</div>
      <div className={`notes-pane-split-divider notes-pane-split-divider-${entry.orientation}`} role="separator"
        aria-orientation={entry.orientation === "row" ? "vertical" : "horizontal"}
        title={entry.orientation === "row" ? t("editor.notes.pane.resizeHorizontal") : t("editor.notes.pane.resizeVertical")}
        onPointerDown={event => onStartDividerDrag(event,entry.id,entry.orientation)} onPointerMove={onUpdateDividerDrag}
        onPointerUp={onEndDividerDrag} onPointerCancel={onEndDividerDrag} onLostPointerCapture={onEndDividerDrag}/>
      <div className="notes-pane-split-region notes-pane-split-region-second">{geometry(entry.second)}</div>
    </div>;
  };
  return <div className="notes-split-workspace notes-flat-workspace" ref={rootRef}>
    <div className="notes-pane-geometry">{geometry(currentLayout)}</div>
    {entries.map(({id,paneId,tab}) => {
      const visible = (paneActiveTabs[paneId] || paneTabs[paneId]?.[0]?.id) === tab.id;
      return <div key={id} className={`notes-document-host${layout ? " notes-split-pane" : ""}${paneId === activePaneId ? " notes-document-host-active" : ""}`}
        data-notes-view-id={id} data-notes-view-document={tab.id} data-notes-view-pane={paneId} hidden={!visible} style={rects[paneId] || {inset:0}}>
        {renderDocument(id,paneId,tab)}
      </div>;
    })}
  </div>;
}

/* Legacy fixed-two-pane preview retained for recovery only.
function LegacyNotesSplitPanePreview({
  tab,
  title,
  contentText,
  order,
  leading,
  showLocalHeader,
  onActivate,
  onAdd,
  onClose,
  onOpenNote,
  onCreateNote,
  onOpenAsset,
  onOpenTag,
  onCreateTag,
  assets,
  notes,
  tags,
}: {
  tab: NotesOpenTab;
  title: string;
  contentText: string;
  order: number;
  leading: boolean;
  showLocalHeader: boolean;
  onActivate: () => void;
  onAdd: () => void;
  onClose: () => void;
  onOpenNote: (noteId: string, options?: NoteOpenOptions) => void;
  onCreateNote: (title: string, options?: NoteOpenOptions) => void;
  onOpenAsset: (assetId: string) => void;
  onOpenTag: (tagId: string) => void;
  onCreateTag: (name: string) => void;
  assets: Asset[];
  notes: Note[];
  tags: Tag[];
}) {
  const isEmpty = tab.kind === "empty";
  return (
    <section className="notes-split-pane" style={{ order, flex: leading ? "0 0 var(--notes-split-leading-size)" : undefined }} onPointerDown={onActivate}>
      {showLocalHeader && <div className="notes-split-pane-tabs">
        <button type="button" className="notes-split-pane-tab active" onClick={onActivate} title={title}>
          <span>{title}</span>
        </button>
        <button
          type="button"
          className="notes-split-pane-add"
          title="新建文档"
          aria-label="新建文档"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onAdd();
          }}
        >
          <svg viewBox="0 0 16 16"><line x1="8" y1="3" x2="8" y2="13" /><line x1="3" y1="8" x2="13" y2="8" /></svg>
        </button>
        <button
          type="button"
          className="notes-split-pane-close"
          title="关闭此分屏"
          aria-label="关闭此分屏"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <IconClose />
        </button>
      </div>}
      <div className="notes-split-pane-content">
        {isEmpty ? (
          <div className="notes-split-pane-empty">点击此标签页开始新建文档</div>
        ) : (
          <NotePreview
            text={contentText}
            currentNoteId={tab.id}
            noteLinks={[]}
            noteEmbeds={[]}
            assets={assets}
            notes={notes}
            tags={tags}
            onOpenNote={onOpenNote}
            onCreateNote={onCreateNote}
            onOpenAsset={onOpenAsset}
            onOpenTag={onOpenTag}
            onCreateTag={onCreateTag}
          />
        )}
      </div>
      <div className="notes-split-pane-status" aria-hidden="true">
        <span>{contentText.trim() ? `${contentText.trim().length} 字` : "0 字"}</span>
        <span>{contentText ? contentText.split(/\r?\n/).length : 1} 行</span>
        <span>预览</span>
      </div>
    </section>
  );
}

*/
function NotesIndexPopover({
  attachmentSettings,
  panel,
  vault,
  knownVaults,
  switchingVaultId,
  switchError,
  onClose,
  onUseRealVault,
  onCreateVault,
  onOpenVault,
  onOpenSettings,
  onRefresh,
  onSwitchVault,
}: {
  attachmentSettings: ReactNode;
  panel: NotesIndexPanel;
  vault: BridgeVaultMetadata | null;
  knownVaults: BridgeVaultMetadata[];
  switchingVaultId: string | null;
  switchError: string;
  onClose: () => void;
  onUseRealVault: () => void;
  onCreateVault: () => void;
  onOpenVault: () => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
  onSwitchVault: (vault: BridgeVaultMetadata) => void;
}) {
  const { t } = useI18n();
  const title = panel === "settings" ? t("editor.notes.vault.titleSettings") : t("editor.notes.vault.titleVaults");
  const vaultUi = buildNotesVaultUiModel(vault, {
    unopenedTitle: t("editor.notes.vault.unopened"),
    unopenedSubtitle: t("editor.notes.vault.setupHint"),
  });
  const dialogSurface = useApplicationModalSurface<HTMLDivElement>(true, onClose);

  return (
    <div
      className="editorial-dialog-backdrop notes-vault-modal-overlay experience-dialog-backdrop"
      onPointerDown={dialogSurface.onBackdropPointerDown}
    >
      <div
        ref={dialogSurface.surfaceRef}
        className={"editorial-dialog experience-dialog notes-vault-dialog notes-vault-dialog-" + panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={dialogSurface.onSurfaceKeyDown}
      >
      <div className="editorial-dialog-head notes-index-popover-header">
        <div className="editorial-dialog-header-row">
          <span className="notes-vault-header-icon editorial-dialog-header-icon" aria-hidden="true" />
          <div className="editorial-dialog-heading">
            <h2>{title}</h2>
          </div>
          <button type="button" className="editorial-dialog-close" onClick={onClose} aria-label={t("common.action.close")} title={t("common.action.close")}><span className="editorial-dialog-close-icon" aria-hidden="true" /></button>
        </div>
      </div>
      <div className="editorial-dialog-body notes-vault-dialog-body">
        {panel === "vault" ? (
        <div className="notes-vault-page notes-vault-compact-page">
          <section className="notes-vault-summary-card">
            <div>
              <span className="notes-vault-kicker">{t("editor.notes.vault.currentSource")}</span>
              <strong>{vault?.name || t("editor.notes.vault.unopened")}</strong>
              <p>{t("editor.notes.vault.authority")}</p>
            </div>
            <span className={"notes-vault-hero-badge" + (vault ? " bound" : "")}>{vault ? t("editor.notes.vault.badgeReady") : t("editor.notes.vault.badgeSetup")}</span>
          </section>
          <section className="notes-vault-section notes-vault-switch-section">
            <div className="notes-vault-section-heading">
              <h3>{t("editor.notes.vault.mine")}</h3>
              <span>{t("editor.notes.vault.count", { count: knownVaults.length })}</span>
            </div>
            <div className="notes-vault-switch-list" role="listbox" aria-label={t("editor.notes.vault.switchAria")}>
              {knownVaults.map((candidate) => {
                const active = candidate.id === vault?.id;
                const switching = candidate.id === switchingVaultId;
                return (
                  <button
                    type="button"
                    key={`${candidate.id}:${candidate.rootPath}`}
                    className={`notes-vault-switch-option${active ? " active" : ""}${switching ? " switching" : ""}`}
                    role="option"
                    aria-selected={active}
                    aria-busy={switching}
                    disabled={active || switchingVaultId !== null}
                    onClick={() => onSwitchVault(candidate)}
                  >
                    <span className="notes-vault-switch-copy">
                      <strong>{candidate.name}</strong>
                      <small>{candidate.rootPath}</small>
                    </span>
                    <span className="notes-vault-switch-state">{active ? t("editor.notes.vault.current") : switching ? t("editor.notes.vault.switching") : t("editor.notes.vault.switch")}</span>
                  </button>
                );
              })}
              {knownVaults.length === 0 ? <p className="notes-vault-switch-empty">{t("editor.notes.vault.switchEmpty")}</p> : null}
              {switchError ? <p className="notes-vault-switch-error" role="status">{switchError}</p> : null}
            </div>
          </section>
          <section className="notes-vault-section notes-vault-actions-section">
            <h3>{t("editor.notes.vault.actions")}</h3>
            <div className="notes-index-popover-actions">
              <button type="button" onClick={onCreateVault}>{t("editor.notes.vault.create")}</button>
              <button type="button" onClick={onOpenVault}>{t("editor.notes.vault.addExisting")}</button>
              {vaultUi.actions.includes("refresh-vault") ? <button type="button" onClick={onRefresh}>{t("editor.notes.vault.refresh")}</button> : null}
              <button type="button" onClick={onOpenSettings}>{t("editor.notes.vault.titleSettings")}</button>
            </div>
          </section>
        </div>
        ) : (
        <div className="notes-vault-page notes-vault-compact-page">
          <section className="notes-vault-summary-card">
            <div>
              <span className="notes-vault-kicker">{t("editor.notes.vault.titleSettings")}</span>
              <strong>Markdown Vault</strong>
              <p>{t("editor.notes.vault.settingsIntro")}</p>
            </div>
            <span className="notes-vault-hero-badge">{t("common.action.settings")}</span>
          </section>
          <div className="notes-vault-info-grid">
            <div className="notes-index-popover-row"><span>{t("editor.notes.vault.currentSource")}</span><strong>Markdown Vault</strong></div>
            <div className="notes-index-popover-row"><span>{t("editor.notes.vault.realVault")}</span><strong>{vault ? t("editor.notes.vault.bound") : t("editor.notes.vault.unbound")}</strong></div>
            <div className="notes-index-popover-row wide"><span>{t("editor.notes.vault.path")}</span><strong className="notes-vault-path">{vault?.rootPath || "-"}</strong></div>
          </div>
          {attachmentSettings}
          <section className="notes-vault-section">
            <h3>{t("editor.notes.vault.back")}</h3>
            <div className="notes-index-popover-actions">
              <button type="button" onClick={onCreateVault}>{t("editor.notes.vault.createKnowledge")}</button>
              <button type="button" onClick={onOpenVault}>{t("editor.notes.vault.openKnowledge")}</button>
              <button type="button" disabled={!vault} onClick={onUseRealVault}>{t("editor.notes.vault.useCurrent")}</button>
            </div>
          </section>
        </div>
        )}
      </div>
      <div className="editorial-dialog-footer notes-vault-dialog-footer">
        <button type="button" onClick={onClose}>{t("common.action.close")}</button>
      </div>
      </div>
    </div>
  );
}

function KnowledgeSearchDialog({
  query,
  results,
  onQueryChange,
  onClose,
  onOpenFolder,
  onOpenNote,
  onSaveSmartFolder,
}: {
  query: string;
  results: KnowledgeSearchGroups | KnowledgeSearchResult[] | null | undefined;
  onQueryChange: (query: string) => void;
  onClose: () => void;
  onOpenFolder: (folderId: string) => void;
  onOpenNote: (noteId: string) => void;
  onSaveSmartFolder: () => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { window.setTimeout(() => inputRef.current?.focus(), 0); }, []);
  const hasQuery = query.trim().length > 0;
  const groupedResults = useMemo<KnowledgeSearchGroups>(() => {
    const empty: KnowledgeSearchGroups = { folders: [], noteTitles: [], noteContents: [], total: 0 };
    if (Array.isArray(results)) {
      const folders = results.filter((item) => item?.kind === "folder");
      const noteTitles = results.filter((item) => item?.kind === "note-title");
      const noteContents = results.filter((item) => item?.kind === "note-content");
      return { folders, noteTitles, noteContents, total: results.length };
    }
    if (!results || typeof results !== "object") return empty;
    const folders = Array.isArray(results.folders) ? results.folders : [];
    const noteTitles = Array.isArray(results.noteTitles) ? results.noteTitles : [];
    const noteContents = Array.isArray(results.noteContents) ? results.noteContents : [];
    const total = typeof results.total === "number" ? results.total : folders.length + noteTitles.length + noteContents.length;
    return { folders, noteTitles, noteContents, total };
  }, [results]);
  const sections = [
    { key: "folders", title: t("editor.notes.search.sectionFolders"), items: groupedResults.folders },
    { key: "noteTitles", title: t("editor.notes.search.sectionTitles"), items: groupedResults.noteTitles },
    { key: "noteContents", title: t("editor.notes.search.sectionBody"), items: groupedResults.noteContents },
  ];
  const openResult = (result: KnowledgeSearchResult) => {
    if (result.kind === "folder") onOpenFolder(result.id);
    else onOpenNote(result.id);
  };

  return (
    <div className="modal-overlay-react notes-local-search-overlay" onPointerDown={onClose}>
      <div className="modal-box-react notes-local-search-modal" onPointerDown={(event) => event.stopPropagation()}>
        <div className="modal-header-react">
          <div>
            <div className="modal-title-react">{t("editor.notes.index.search")}</div>
            <p className="notes-local-search-subtitle">{t("editor.notes.search.subtitle")}</p>
          </div>
          <button type="button" className="modal-close-react" onClick={onClose} aria-label={t("editor.notes.search.close")} title={t("editor.notes.search.close")}><IconClose /></button>
        </div>
        <div className="notes-local-search-body">
          <input
            ref={inputRef}
            className="notes-dialog-input notes-local-search-input"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t("editor.notes.search.placeholder")}
            onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
          />
          <div className="notes-local-search-summary">
            <span>{hasQuery ? t("editor.notes.search.results", { count: groupedResults.total }) : t("editor.notes.search.start")}</span>
            {hasQuery ? <button type="button" className="notes-save-smart-folder" onClick={onSaveSmartFolder}>{t("editor.notes.search.saveSmart")}</button> : null}
          </div>
          <div className="notes-local-search-results">
            {!hasQuery ? (
              <div className="notes-local-search-empty">{t("editor.notes.search.emptyStart")}</div>
            ) : groupedResults.total === 0 ? (
              <div className="notes-local-search-empty">{t("editor.notes.search.empty")}</div>
            ) : sections.map((section) => section.items.length ? (
              <section className="notes-local-search-group" key={section.key}>
                <h3>{section.title}</h3>
                {section.items.map((result) => (
                  <button
                    type="button"
                    className="notes-local-search-result"
                    key={result.kind + "-" + result.id + "-" + (result.path || "")}
                    onClick={() => openResult(result)}
                  >
                    <span className="notes-local-search-type">{section.title}</span>
                    <strong className="notes-local-search-title"><HighlightSearchText text={result.title} query={query} /></strong>
                    {result.snippet ? <em className="notes-local-search-snippet"><HighlightSearchText text={result.snippet} query={query} /></em> : null}
                    {result.path ? <span className="notes-local-search-meta"><HighlightSearchText text={result.path} query={query} /></span> : null}
                  </button>
                ))}
              </section>
            ) : null)}
          </div>
        </div>
      </div>
    </div>
  );
}

function HighlightSearchText({ text, query }: { text?: string | null; query: string }) {
  const value = text || "";
  const keyword = query.trim();
  if (!keyword) return <>{value}</>;
  const lowerValue = value.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const index = lowerValue.indexOf(lowerKeyword, cursor);
    if (index < 0) break;
    if (index > cursor) parts.push(value.slice(cursor, index));
    parts.push(<mark key={String(index) + "-" + keyword}>{value.slice(index, index + keyword.length)}</mark>);
    cursor = index + keyword.length;
  }
  if (cursor < value.length) parts.push(value.slice(cursor));
  return <>{parts.length ? parts : value}</>;
}

function IconClose() {
  return <svg viewBox="0 0 16 16"><line x1="4" y1="4" x2="12" y2="12" /><line x1="12" y1="4" x2="4" y2="12" /></svg>;
}

function IconSearch() {
  return <svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>;
}












function TagDialog({
  tags,
  selected,
  onChange,
  onCreateTag,
  onClose,
  onSave,
}: {
  tags: Tag[];
  selected: string[];
  onChange: (selected: string[]) => void;
  onCreateTag: (name: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const trimmedQuery = normalizeMarkdownTagName(query);
  // A real-vault tag does not enter the index until Save. Its selected ID
  // already carries its name, so render that draft alongside indexed tags.
  const options = [...tags];
  selected.forEach((id) => {
    if (id.startsWith(REAL_VAULT_TAG_PREFIX) && !options.some((tag) => tag.id === id)) {
      options.push({ id, name: realVaultTagNameFromId(id), noteCount: 0 });
    }
  });
  const filtered = options.filter((tag) => selected.includes(tag.id) || tag.name.toLocaleLowerCase().includes(trimmedQuery.toLocaleLowerCase()));
  const hasExactTag = !!trimmedQuery && options.some((tag) => tag.name.toLocaleLowerCase() === trimmedQuery.toLocaleLowerCase());
  const canCreate = !!trimmedQuery && !hasExactTag;

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  };

  return (
    <div className="modal-overlay-react" onPointerDown={onClose}>
      <div className="modal-box-react tag-dialog-react" onPointerDown={(event) => event.stopPropagation()}>
        <div className="modal-header-react">
          <div className="modal-title-react">{t("editor.notes.tag.edit")}</div>
          <button className="modal-close-react" onClick={onClose} aria-label={t("common.action.close")} title={t("common.action.close")}><IconClose /></button>
        </div>
        <div className="modal-body-react">
          <input className="notes-dialog-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("editor.notes.tag.searchCreate")} autoFocus />
          <div className="notes-tag-picker">
            {canCreate && (
              <button className="create-tag" onClick={() => { onCreateTag(trimmedQuery); setQuery(""); }}>
                + {trimmedQuery}
              </button>
            )}
            {filtered.map((tag) => (
              <button key={tag.id} aria-pressed={selected.includes(tag.id)} className={selected.includes(tag.id) ? "active" : ""} onClick={() => toggle(tag.id)}>
                {tag.name}
                <span>{tag.noteCount ?? 0}</span>
              </button>
            ))}
            {filtered.length === 0 && !canCreate && <div className="notes-empty-inline">{t("editor.notes.tag.empty")}</div>}
          </div>
        </div>
        <div className="notes-dialog-actions">
          <button onClick={onClose}>{t("common.action.cancel")}</button>
          <button className="primary" onClick={onSave}>{t("common.action.save")}</button>
        </div>
      </div>
    </div>
  );
}

function NoteMoveModal({
  folders,
  currentFolderId,
  rootLabel,
  rootDescription,
  onClose,
  onSelect,
}: {
  folders: Folder[];
  currentFolderId: string | null;
  rootLabel: string;
  rootDescription: string;
  onClose: () => void;
  onSelect: (folderId: string | null) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const targets = useMemo(() => {
    const items: Array<{ id: string; name: string }> = [];
    const walk = (children: Folder[], path: string) => {
      children.forEach((folder) => {
        const name = path ? `${path}/${folder.name}` : folder.name;
        items.push({ id: folder.id, name });
        walk(folder.children || [], name);
      });
    };
    walk(folders, "");
    return items;
  }, [folders]);
  const filteredTargets = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return targets;
    return targets.filter((target) => target.name.toLowerCase().includes(normalizedQuery));
  }, [query, targets]);

  return (
    <div className="folder-dialog-overlay-react" onPointerDown={onClose}>
      <div className="folder-dialog-react folder-move-dialog-react" onPointerDown={(event) => event.stopPropagation()}>
        <div className="folder-dialog-title-react">{t("editor.notes.move.title")}</div>
        <p>{t("editor.notes.move.description")}</p>
        <input
          value={query}
          autoFocus
          placeholder={t("editor.notes.move.search")}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
          }}
        />
        <div className="folder-move-target-list">
          <button className={currentFolderId === null ? "active" : ""} onClick={() => onSelect(null)}>
            <span>{rootLabel}</span>
            <small>{rootDescription}</small>
          </button>
          {filteredTargets.map((target) => (
            <button
              key={target.id}
              className={currentFolderId === target.id ? "active" : ""}
              onClick={() => onSelect(target.id)}
            >
              <span>{target.name}</span>
              <small>{t("editor.notes.move.into")}</small>
            </button>
          ))}
          {filteredTargets.length === 0 && <div className="folder-dialog-empty-react">{t("editor.notes.move.empty")}</div>}
        </div>
        <div className="folder-dialog-actions-react">
          <button onClick={onClose}>{t("common.action.cancel")}</button>
        </div>
      </div>
    </div>
  );
}
