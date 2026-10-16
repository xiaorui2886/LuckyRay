import { materialLibrarySession } from "./core/services/materialLibraryContext";
import { createMaterialLibraryAdapter, createMaterialVaultAttachmentAdapter, type MaterialLibraryAi } from "./core/services/materialLibraryAdapter";
import type { MaterialCatalogAdapter } from "./core/services/materialCatalog";
import { adaptMaterialAssetMedia, derivePreviewUrl } from "./core/services/materialAssetAdapter";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { shellFilePath } from "./core/services/shellFilePath";
import { mkdir, readFile, writeFile } from "@tauri-apps/plugin-fs";
import Database from "@tauri-apps/plugin-sql";
import { useCallback, useRef } from "react";
import { openBackendOwnedDatabase, type BackendBootstrapStatus } from "./core/backendBootstrap";
import { createDefaultKnowledgeLegacyBridgeAdapter, knowledgeLegacyBridgeAdapter } from "./core/services/knowledgeLegacyBridge";
import {
  KnowledgeServiceError,
  createKnowledgeDocument,
  knowledgeDocumentNoteId,
  knowledgeTagCanonicalKey,
  parseKnowledgeDocumentNoteId,
  readKnowledgeDocument,
  readKnowledgeIndexSnapshot,
  setActiveKnowledgeDocumentTags,
} from "./core/services/knowledge";
import { MATERIAL_CHANGE_LOCAL_EVENT, type MaterialChange } from "./core/services/materialChangeProtocol";
import {
  resolveVideoThumbnailBackfillInput,
  toMaterialCatalogError,
  type MaterialRelocateOptions,
} from "./core/services/materialCatalog";
import { projectAiSettingsForFrontend } from "./core/services/aiSettingsPrivacy";
import type {
  SmartFolderDefinition,
  SmartFolderDefinitionInput,
} from "./core/services/smartFolders";
import { readSavedSettings } from "./features/settings/useSettings";
import "./App.css";

import type {
  AssetStorageMode,
  MaterialImportOptions,
  MaterialFolderImportOptions,
  BridgeAsset,
  BridgeFolder,
  BridgeFolderNode,
  CreateFolderInput,
  MoveFolderInput,
  MoveAssetToFolderInput,
  UpdateTagInput,
  BridgeTag,
  CreateTagInput,
  BridgeSettings,
  BridgeAiMessageContent,
  BridgeAiConversation,
  BridgeAiMessage,
  BridgeBackupInfo,
  BridgeExportResult,
  ExportNotesMarkdownOptions,
  BridgeVaultMetadata,
  BridgeOpenVaultResult,
  BridgeNotesVaultFileNode,
  BridgeNotesVaultMarkdownFile,
  BridgeNotesVaultMarkdownIndex,
  BridgeNotesVaultAssetExistsResult,
  BridgeNotesVaultAssetCandidateResult,
  BridgeNotesVaultWriteResult,
  BridgeNotesVaultDeleteResult,
  BridgeNotesVaultImportMarkdownResult,
  BridgeNotesVaultExportMarkdownResult,
  BridgeDroppedPathInfo,
  BridgeStorageUsage,
  BridgeClearCacheResult,
  BridgeClearAllDataResult,
  BridgeImportFolderResult,
  BridgeMissingAsset,
  BridgeRemoveResult,
  BridgeAssetFilter,
  BridgeCollectionItem,
  LuckyRayBridge,
  FavoriteItemType,
  FavoriteItem,
  FavoriteItemCounts,
  FavoriteRemoval,
  BridgeCanvasListEntry,
  BridgeNotesInlinePreview,
  BridgeNotesInlineApplyResult,
  BridgeCanvasFile,
  BridgeCanvasStorageCheck,
  BridgeAssetPatch,
  MemoryViewId,
  MemoryEntryView,
} from "./core/bridge/bridgeTypes";

type BridgeAssetSearchHit = {
  asset: BridgeAsset;
  snippet: string;
};


const canvasIdentityCache = new Map<string, { revision: number; contentDigest: string }>();

type RawBridgeCanvasListEntry = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  node_count: number;
  edge_count: number;
  cover_version?: number;
  cover_kind?: "image" | "video" | null;
  cover_url?: string | null;
  cover_poster?: string | null;
  revision?: number;
  content_digest?: string;
};

function normalizeCanvasListEntry(entry: RawBridgeCanvasListEntry): BridgeCanvasListEntry {
  const normalized = {
    id: entry.id,
    name: entry.name,
    createdAt: entry.created_at,
    updatedAt: entry.updated_at,
    nodeCount: entry.node_count,
    edgeCount: entry.edge_count,
    coverVersion: entry.cover_version ?? 0,
    coverKind: entry.cover_kind ?? null,
    coverUrl: entry.cover_url ?? null,
    coverPoster: entry.cover_poster ?? null,
    revision: entry.revision ?? 0,
    contentDigest: entry.content_digest ?? "",
  };
  canvasIdentityCache.set(normalized.id, {
    revision: normalized.revision,
    contentDigest: normalized.contentDigest,
  });
  return normalized;
}

const DB_PATH = "sqlite:luckyray.db";
const FALLBACK_STORAGE_KEY = "luckyray.assets";
const FALLBACK_FOLDERS_KEY = "luckyray.folders";
const FALLBACK_TAGS_KEY = "luckyray.tags";
const FALLBACK_ASSET_TAGS_KEY = "luckyray.assetTags";
const FALLBACK_SETTINGS_KEY = "luckyray.settings";
const FALLBACK_AI_CONV_KEY = "luckyray.aiConversations";
const FALLBACK_AI_MSG_KEY = "luckyray.aiMessages";
const browserPreviewUrls = new Map<string, string>();
const videoThumbnailBackfillPending = new Set<string>();
const videoThumbnailBackfillQueue: Array<() => Promise<void>> = [];
let videoThumbnailBackfillActive = 0;
const VIDEO_THUMBNAIL_BACKFILL_CONCURRENCY = 2;

let dbPromise: Promise<Database | null> | null = null;
export let dbInitError: string | null = null;
let bridgeReadinessGeneration = 0;

function publishBridgeReadiness(generation: number, databaseReady: boolean, error: string | null) {
  if (typeof window === "undefined") return;
  const readiness = {
    generation,
    bridgeInstalled: true,
    databaseReady,
    error,
  };
  (window as unknown as { __LUCKYRAY_BRIDGE_READINESS__?: typeof readiness }).__LUCKYRAY_BRIDGE_READINESS__ = readiness;
  window.dispatchEvent(new CustomEvent("luckyray:bridge-ready", { detail: readiness }));
}

function createId(prefix = "asset") {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function filenameFromPath(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

function extensionFromName(name: string) {
  const match = /\.([^.]+)$/.exec(name);
  return match ? match[1].toLowerCase() : "";
}

function extensionWithDotFromName(name: string) {
  const fileName = filenameFromPath(name);
  const index = fileName.lastIndexOf(".");
  return index > 0 ? fileName.slice(index) : "";
}

function normalizeRealRenameFileName(input: string, currentPath: string) {
  const raw = input.trim();
  if (!raw) throw new Error("文件名不能为空");
  if (/[\\/]/.test(raw)) throw new Error("文件名不能包含路径");
  if (raw === "." || raw === "..") throw new Error("文件名不正确");

  const originalName = filenameFromPath(currentPath);
  const originalExt = extensionWithDotFromName(originalName);
  const nextExt = extensionWithDotFromName(raw);
  if (originalExt && nextExt && nextExt.toLowerCase() !== originalExt.toLowerCase()) {
    throw new Error(`真实文件重命名暂不修改扩展名，请保留 ${originalExt}`);
  }
  return originalExt && !nextExt ? `${raw}${originalExt}` : raw;
}

function kindFromName(name: string, mimeType = "") {
  const ext = extensionFromName(name);
  if (mimeType.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) return "image";
  if (mimeType.startsWith("video/") || ["mp4", "mov", "avi", "mkv", "webm"].includes(ext)) return "video";
  if (mimeType.startsWith("audio/") || ["mp3", "wav", "ogg", "flac", "m4a"].includes(ext)) return "audio";
  if (["pdf", "doc", "docx", "md", "txt", "rtf", "ppt", "pptx", "xls", "xlsx"].includes(ext)) return "document";
  return "other";
}

function fallbackAssets() {
  try {
    return JSON.parse(localStorage.getItem(FALLBACK_STORAGE_KEY) || "[]") as BridgeAsset[];
  } catch {
    return [];
  }
}

function saveFallbackAssets(assets: BridgeAsset[]) {
  localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(assets));
}

function normalizeRating(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const rating = Number(value);
  if (!Number.isFinite(rating)) return null;
  return Math.max(0, Math.min(5, Math.round(rating)));
}

function collectDominantColors(value: unknown, maxColors = 8): string[] {
  if (typeof value !== "string") return [];
  const matches = value.toLowerCase().match(/#[0-9a-f]{6}/g) || [];
  const colors: string[] = [];
  for (const color of matches) {
    if (!colors.includes(color)) colors.push(color);
    if (colors.length >= maxColors) break;
  }
  return colors;
}

function normalizeDominantColor(value: unknown): string | null {
  const colors = collectDominantColors(value);
  return colors.length ? colors.join(",") : null;
}

function normalizeDominantColorFilter(value: unknown): string | null {
  return collectDominantColors(value, 1)[0] || null;
}

function dominantColorContains(value: unknown, color: unknown): boolean {
  const needle = normalizeDominantColorFilter(color);
  return Boolean(needle && collectDominantColors(value).includes(needle));
}

function normalizeAssetStorageMode(value: unknown): AssetStorageMode {
  return value === "managed" || value === "source" ? value : "linked";
}

function readMaterialImportSettings(options?: MaterialImportOptions): { storageMode: AssetStorageMode; managedLibraryDir: string | null } {
  const saved = readSavedSettings();
  const storageMode = normalizeAssetStorageMode(options?.storageMode || saved["materials.importMode"]);
  const dirValue = typeof options?.managedLibraryDir === "string"
    ? options.managedLibraryDir
    : String(saved["materials.managedLibraryDir"] || "");
  const managedLibraryDir = dirValue.trim() || null;
  return { storageMode, managedLibraryDir };
}

function normalizeAsset(asset: Partial<BridgeAsset>): BridgeAsset {
  const importedAt = asset.importedAt || new Date().toISOString();
  return adaptMaterialAssetMedia({
    id: asset.id || createId(),
    name: asset.name || filenameFromPath(asset.originalPath || "untitled"),
    originalPath: asset.originalPath || "",
    libraryPath: asset.libraryPath ?? null,
    storageMode: normalizeAssetStorageMode(asset.storageMode),
    kind: asset.kind || kindFromName(asset.name || asset.originalPath || ""),
    mimeType: asset.mimeType || "",
    sizeBytes: asset.sizeBytes ?? null,
    thumbnailUrl: asset.thumbnailUrl || "",
    previewUrl: asset.previewUrl,
    description: asset.description || "",
    rating: normalizeRating(asset.rating),
    dominantColor: normalizeDominantColor(asset.dominantColor),
    folderId: asset.folderId ?? null,
    importedAt,
    updatedAt: asset.updatedAt || importedAt,
    contentHash: asset.contentHash ?? null,
  });
}

function normalizeFolder(row: Partial<BridgeFolder>): BridgeFolder {
  const now = new Date().toISOString();
  return {
    id: row.id || createId("folder"),
    scope: row.scope || "materials",
    parentId: row.parentId ?? null,
    name: row.name || "新建文件夹",
    sortOrder: row.sortOrder ?? 0,
    open: row.open === true,
    createdAt: row.createdAt || now,
    updatedAt: row.updatedAt || now,
  };
}

function readFallbackArray<T>(key: string): T[] {
  try {
    return JSON.parse(localStorage.getItem(key) || "[]") as T[];
  } catch {
    return [];
  }
}

function readFallbackRecord<T>(key: string): Record<string, T> {
  try {
    return JSON.parse(localStorage.getItem(key) || "{}") as Record<string, T>;
  } catch {
    return {};
  }
}

async function countRows(db: Database, table: string): Promise<number> {
  const rows = await db.select<Array<{ count: number }>>(`select count(*) as count from ${table}`);
  return rows[0]?.count ?? 0;
}

export async function migrateLegacyNonKnowledgeDataToDb(db: Database) {
  const now = new Date().toISOString();

  if ((await countRows(db, "asset")) === 0) {
    for (const asset of readFallbackArray<BridgeAsset>(FALLBACK_STORAGE_KEY).map(normalizeAsset)) {
      await db.execute(
        `insert or ignore into asset (id, name, original_path, library_path, storage_mode, kind, mime_type, size_bytes, thumbnail_url, description, rating, dominant_color, folder_id, imported_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [asset.id, asset.name, asset.originalPath, asset.libraryPath, asset.storageMode, asset.kind, asset.mimeType, asset.sizeBytes, asset.thumbnailUrl, asset.description, asset.rating, asset.dominantColor, asset.folderId, asset.importedAt, asset.updatedAt],
      );
    }
  }

  if ((await countRows(db, "folder")) === 0) {
    for (const folder of readFallbackArray<BridgeFolder>(FALLBACK_FOLDERS_KEY)
      .map(normalizeFolder)
      .filter((candidate) => candidate.scope === "materials")) {
      await db.execute(
        `insert or ignore into folder (id, scope, parent_id, name, sort_order, open, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [folder.id, folder.scope, folder.parentId, folder.name, folder.sortOrder, folder.open ? 1 : 0, folder.createdAt, folder.updatedAt],
      );
    }
  }

  if ((await countRows(db, "tag")) === 0) {
    for (const tag of readFallbackArray<BridgeTag>(FALLBACK_TAGS_KEY).map(normalizeTag).filter((tag) => tag.name)) {
      await db.execute(
        `insert or ignore into tag (id, name, color, created_at, updated_at) values ($1, $2, $3, $4, $5)`,
        [tag.id, tag.name, tag.color, tag.createdAt, tag.updatedAt],
      );
    }
  }

  if ((await countRows(db, "item_tag")) === 0) {
    for (const [assetId, tagIds] of Object.entries(readFallbackRecord<string[]>(FALLBACK_ASSET_TAGS_KEY))) {
      for (const tagId of tagIds || []) {
        await db.execute(
          `insert or ignore into item_tag (id, item_type, item_id, tag_id, created_at) values ($1, 'asset', $2, $3, $4)`,
          [createId("itemtag"), assetId, tagId, now],
        );
      }
    }
  }

  if ((await countRows(db, "settings")) === 0) {
    const settings = normalizeSettings(readFallbackRecord<unknown>(FALLBACK_SETTINGS_KEY) as Partial<BridgeSettings>);
    const pairs: Array<[string, string]> = [
      ["aiProvider", settings.aiProvider ?? ""],
      ["aiApiKey", settings.aiApiKey ?? ""],
      ["aiBaseURL", settings.aiBaseURL ?? ""],
      ["aiModel", settings.aiModel ?? ""],
      ["aiTemperature", String(settings.aiTemperature)],
      ["aiMaxTokens", String(settings.aiMaxTokens)],
      ["temperature", String(settings.temperature)],
      ["maxTokens", String(settings.maxTokens)],
    ];
    for (const [key, value] of pairs) {
      await db.execute(`insert or ignore into settings (key, value) values ($1, $2)`, [key, value]);
    }
  }

  if ((await countRows(db, "ai_conversation")) === 0) {
    for (const conversation of readFallbackArray<BridgeAiConversation>(FALLBACK_AI_CONV_KEY)) {
      await db.execute(
        `insert or ignore into ai_conversation (id, title, created_at, updated_at) values ($1, $2, $3, $4)`,
        [conversation.id || createId("conv"), conversation.title || "新对话", conversation.createdAt || now, conversation.updatedAt || conversation.createdAt || now],
      );
    }
  }

  if ((await countRows(db, "ai_message")) === 0) {
    const messageMap = readFallbackRecord<BridgeAiMessage[]>(FALLBACK_AI_MSG_KEY);
    for (const [conversationId, messages] of Object.entries(messageMap)) {
      for (const message of messages || []) {
        await db.execute(
          `insert or ignore into ai_message (id, conversation_id, role, content, created_at) values ($1, $2, $3, $4, $5)`,
          [message.id || createId("msg"), message.conversationId || conversationId, message.role || "user", message.content || "", message.createdAt || now],
        );
      }
    }
  }
}

export async function getDb() {
  if (!isTauri()) return null;
  dbPromise ??= openBackendOwnedDatabase(true, {
    readStatus: () => invoke<BackendBootstrapStatus>("get_backend_bootstrap_status"),
    openDatabase: () => Database.load(DB_PATH),
    migrateLegacyBrowserData: migrateLegacyNonKnowledgeDataToDb,
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[luckyray] failed to open backend-owned sqlite", error);
    dbInitError = `SQLite (${DB_PATH}) — ${message}。数据目录: %APPDATA%\\com.luckyray.desktop\\luckyray.db`;
    return null;
  });
  return dbPromise;
}

async function persistAssets(assets: BridgeAsset[]) {
  const normalized = assets.map(normalizeAsset);
  const existing = fallbackAssets();
  saveFallbackAssets([...normalized, ...existing.map(normalizeAsset)]);
}

async function listAssets() {
  if (isTauri()) {
    const assets = await invoke<BridgeAsset[]>("material_catalog_list_assets", { filters: null });
    for (const asset of assets) scheduleVideoThumbnailBackfill(asset);
    const normalized = assets.map((asset) => normalizeAsset(asset));
    return normalized;
  }
  return fallbackAssets().map(normalizeAsset);
}

async function getAssetsByIds(assetIds: string[]) {
  const uniqueIds = [...new Set(assetIds)].filter((id) => typeof id === "string" && id.length > 0).slice(0, 64);
  if (uniqueIds.length === 0) return [];
  if (isTauri()) {
    const assets = await invoke<BridgeAsset[]>("material_catalog_get_assets", { assetIds: uniqueIds });
    return assets.map((asset) => normalizeAsset(asset));
  }
  const wanted = new Set(uniqueIds);
  return fallbackAssets().filter((asset) => wanted.has(asset.id)).map(normalizeAsset);
}

async function updateAsset(id: string, patch: BridgeAssetPatch) {
  const current = (await listAssets()).find((asset) => asset.id === id);
  if (!current) return null;
  const changesOnlyDominantColor =
    Object.prototype.hasOwnProperty.call(patch, "dominantColor") &&
    !Object.prototype.hasOwnProperty.call(patch, "name") &&
    !Object.prototype.hasOwnProperty.call(patch, "description") &&
    !Object.prototype.hasOwnProperty.call(patch, "rating");

  const updated = normalizeAsset({
    ...current,
    name: typeof patch.name === "string" && patch.name.trim() ? patch.name.trim() : current.name,
    description: typeof patch.description === "string" ? patch.description : current.description,
    rating: Object.prototype.hasOwnProperty.call(patch, "rating") ? normalizeRating(patch.rating) : current.rating,
    dominantColor: Object.prototype.hasOwnProperty.call(patch, "dominantColor") ? normalizeDominantColor(patch.dominantColor) : current.dominantColor,
    updatedAt: changesOnlyDominantColor ? current.updatedAt : new Date().toISOString(),
  });

  if (isTauri()) {
    const saved = await invoke<BridgeAsset | null>("material_catalog_update_asset", {
      id,
      patch,
      reason: "desktop-asset-update",
    });
    return saved ? normalizeAsset(saved) : null;
  }

  saveFallbackAssets(fallbackAssets().map((asset) => (asset.id === id ? updated : normalizeAsset(asset))));
  return updated;
}

async function selectAssetFile(): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await open({
    title: "重新定位素材文件",
    multiple: false,
    filters: [
      { name: "素材文件", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "mp4", "mov", "webm", "mp3", "wav", "pdf", "md", "txt", "doc", "docx", "ppt", "pptx", "xls", "xlsx"] },
      { name: "所有文件", extensions: ["*"] },
    ],
  });
  if (Array.isArray(selected)) return selected[0] || null;
  return selected || null;
}

async function relocateAsset(id: string, path: string, options?: MaterialRelocateOptions): Promise<BridgeAsset | null> {
  const nextPath = typeof path === "string" ? path.trim() : "";
  if (!nextPath) return null;
  const current = (await listAssets()).find((asset) => asset.id === id);
  if (!current) return null;

  const kind = kindFromName(filenameFromPath(nextPath));
  const thumbnailUrl = (isTauri() && (kind === "image" || kind === "video")) ? convertFileSrc(nextPath) : current.thumbnailUrl;
  const updated = normalizeAsset({
    ...current,
    originalPath: nextPath,
    libraryPath: nextPath,
    kind,
    thumbnailUrl,
    updatedAt: new Date().toISOString(),
  });

  if (isTauri()) {
    try {
      const saved = await invoke<BridgeAsset | null>("material_catalog_relocate_asset", {
        id,
        path: nextPath,
        options: {
          allowSourceContentChange: Boolean(options?.allowSourceContentChange),
          expectedSourceContentHash: options?.expectedSourceContentHash || null,
        },
      });
      return saved ? normalizeAsset(saved) : null;
    } catch (error) {
      throw toMaterialCatalogError(error);
    }
  }

  saveFallbackAssets(fallbackAssets().map((asset) => (asset.id === id ? updated : normalizeAsset(asset))));
  return updated;
}

async function renameAssetFile(id: string, fileName: string): Promise<BridgeAsset | null> {
  const current = (await listAssets()).find((asset) => asset.id === id);
  if (!current) return null;
  if (!isTauri()) throw new Error("当前环境不支持重命名真实文件");

  const mode = normalizeAssetStorageMode(current.storageMode);
  if (mode === "linked") {
    throw new Error("链接引用素材不会直接重命名真实文件，请在资源管理器中处理。");
  }

  const targetPath = mode === "managed" ? current.libraryPath : (current.libraryPath || current.originalPath);
  if (!targetPath || targetPath.startsWith("browser:") || targetPath.startsWith("dropped:")) {
    throw new Error("这个素材没有可重命名的本地真实文件。");
  }

  const nextFileName = normalizeRealRenameFileName(fileName, targetPath);
  const saved = await invoke<BridgeAsset | null>("material_catalog_rename_asset_file", {
    id,
    fileName: nextFileName,
  });
  return saved ? normalizeAsset(saved) : null;
}

async function deleteAsset(id: string, options?: { deleteFile?: boolean }) {
  if (isTauri()) {
    await invoke<{ success: boolean; cleanupPending: boolean }>("material_catalog_delete_asset", {
      id,
      deleteFile: Boolean(options?.deleteFile),
    });
    return;
  }
  saveFallbackAssets(fallbackAssets().filter((asset) => asset.id !== id));
  const tagMap = fallbackAssetTagMap();
  if (tagMap[id] !== undefined) {
    delete tagMap[id];
    saveFallbackAssetTagMap(tagMap);
  }
}

async function revealAssetPath(path: string) {
  if (!path || path.startsWith("browser:") || !isTauri()) return false;
  try {
    await revealItemInDir(shellFilePath(path));
    return true;
  } catch (error) {
    console.warn("[luckyray] revealAssetPath failed", path, error);
    return false;
  }
}

async function openFilePath(path: string) {
  if (!path || path.startsWith("browser:") || !isTauri()) return false;
  try {
    await openPath(shellFilePath(path));
    return true;
  } catch (error) {
    console.warn("[luckyray] openFilePath plugin failed; trying command fallback", path, error);
    try {
      await invoke<void>("open_existing_local_file_with_default_app", { path });
      return true;
    } catch (fallbackError) {
      console.warn("[luckyray] openFilePath fallback failed", path, fallbackError);
      return false;
    }
  }
}

async function getMaterialChangeState(): Promise<MaterialChange | null> {
  if (!isTauri()) return null;
  return invoke<MaterialChange>("material_catalog_get_change");
}

async function publishMaterialChange(input: {
  reason: string;
  affectedIds?: string[];
  foldersChanged?: boolean;
}): Promise<MaterialChange | null> {
  if (!isTauri()) return null;
  const change = await invoke<MaterialChange>("publish_material_change", {
    reason: input.reason,
    affectedIds: input.affectedIds || [],
    foldersChanged: Boolean(input.foldersChanged),
  });
  window.dispatchEvent(new CustomEvent(MATERIAL_CHANGE_LOCAL_EVENT, { detail: change }));
  return change;
}

async function openNotesVaultMarkdownFileWithDefaultApp(input: { vault: BridgeVaultMetadata; relativePath: string }): Promise<void> {
  if (!isTauri()) throw new Error("real-vault-open-markdown-default-app-not-supported");
  return await invoke<void>("open_notes_vault_markdown_file_with_default_app", input);
}

async function notesVaultAssetExists(input: { vault: BridgeVaultMetadata; relativePath: string }): Promise<BridgeNotesVaultAssetExistsResult> {
  if (!isTauri()) return { relativePath: input.relativePath, absolutePath: "", exists: false, isFile: false };
  return await invoke<BridgeNotesVaultAssetExistsResult>("notes_vault_asset_exists", input);
}

async function notesVaultFindAssetCandidates(input: { vault: BridgeVaultMetadata; target: string; currentRelativePath: string }): Promise<BridgeNotesVaultAssetCandidateResult[]> {
  if (!isTauri()) return [];
  return await invoke<BridgeNotesVaultAssetCandidateResult[]>("notes_vault_find_asset_candidates", input);
}

async function openExternalUrl(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) throw new Error("链接格式不正确");
  await openUrl(url);
}

async function getAppDataDir(): Promise<string> {
  if (!isTauri()) return "";
  try {
    return await invoke<string>("get_app_data_dir");
  } catch (error) {
    console.warn("[luckyray] getAppDataDir failed", error);
    return "";
  }
}

async function getCollectionServerBaseUrl(): Promise<string> {
  if (!isTauri()) return "http://127.0.0.1:37418";
  try {
    return await invoke<string>("get_collection_server_base_url");
  } catch (error) {
    console.warn("[luckyray] getCollectionServerBaseUrl failed", error);
    return "http://127.0.0.1:37418";
  }
}

async function openDirectory(path: string): Promise<void> {
  if (!isTauri() || !path) return;
  try {
    await invoke<void>("open_directory", { path });
  } catch (error) {
    console.warn("[luckyray] openDirectory failed", path, error);
    throw error;
  }
}

const NOTES_VAULT_FALLBACK_KEY = "luckyray-notes-current-vault-v1";

async function selectVaultDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await open({
    title: "选择 LuckyRay 仓库目录",
    directory: true,
    multiple: false,
  });
  if (Array.isArray(selected)) return selected[0] || null;
  return selected || null;
}

function readFallbackVault(): BridgeVaultMetadata | null {
  try {
    const raw = localStorage.getItem(NOTES_VAULT_FALLBACK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BridgeVaultMetadata;
    return parsed && typeof parsed.rootPath === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function writeFallbackVault(vault: BridgeVaultMetadata | null) {
  try {
    if (vault) localStorage.setItem(NOTES_VAULT_FALLBACK_KEY, JSON.stringify(vault));
    else localStorage.removeItem(NOTES_VAULT_FALLBACK_KEY);
  } catch {
    // localStorage can be unavailable in restricted webviews.
  }
}

async function getCurrentNotesVault(): Promise<BridgeVaultMetadata | null> {
  if (!isTauri()) return readFallbackVault();
  try {
    const vault = await invoke<BridgeVaultMetadata | null>("get_current_notes_vault");
    writeFallbackVault(vault);
    return vault;
  } catch (error) {
    console.warn("[luckyray] getCurrentNotesVault failed", error);
    return readFallbackVault();
  }
}

async function createNotesVault(rootPath: string): Promise<BridgeVaultMetadata> {
  if (!isTauri()) throw new Error("当前环境不支持建立本地仓库");
  const vault = await invoke<BridgeVaultMetadata>("create_notes_vault", { rootPath });
  writeFallbackVault(vault);
  return vault;
}

async function openNotesVault(rootPath: string): Promise<BridgeOpenVaultResult> {
  if (!isTauri()) throw new Error("当前环境不支持打开本地仓库");
  const result = await invoke<BridgeOpenVaultResult>("open_notes_vault", { rootPath });
  if (result.vault) writeFallbackVault(result.vault);
  return result;
}

async function listNotesVaultFiles(vault: BridgeVaultMetadata): Promise<BridgeNotesVaultFileNode> {
  if (!isTauri()) throw new Error("当前环境不支持读取真实 Vault 文件树");
  return await invoke<BridgeNotesVaultFileNode>("list_notes_vault_files", { vault });
}

async function getNotesVaultMarkdownIndex(vault: BridgeVaultMetadata): Promise<BridgeNotesVaultMarkdownIndex> {
  if (!isTauri()) throw new Error("当前环境不支持建立真实 Vault Markdown 索引");
  return await invoke<BridgeNotesVaultMarkdownIndex>("get_notes_vault_markdown_index", { vault });
}

async function createNotesVaultFolder(input: { vault: BridgeVaultMetadata; parentRelativePath: string; name: string }): Promise<BridgeNotesVaultFileNode> {
  if (!isTauri()) throw new Error("当前环境不支持创建真实 Vault 文件夹");
  return await invoke<BridgeNotesVaultFileNode>("create_notes_vault_folder", input);
}

async function createNotesVaultMarkdownFile(input: { vault: BridgeVaultMetadata; parentRelativePath: string; name: string }): Promise<BridgeNotesVaultMarkdownFile> {
  if (!isTauri()) throw new Error("当前环境不支持创建真实 Vault Markdown 文件");
  return await invoke<BridgeNotesVaultMarkdownFile>("create_notes_vault_markdown_file", input);
}

async function readNotesVaultMarkdownFile(input: { vault: BridgeVaultMetadata; relativePath: string }): Promise<BridgeNotesVaultMarkdownFile> {
  if (!isTauri()) throw new Error("当前环境不支持读取真实 Vault Markdown 文件");
  return await invoke<BridgeNotesVaultMarkdownFile>("read_notes_vault_markdown_file", input);
}

async function writeNotesVaultMarkdownFile(input: { vault: BridgeVaultMetadata; relativePath: string; contentText: string }): Promise<BridgeNotesVaultWriteResult> {
  if (!isTauri()) throw new Error("当前环境不支持保存真实 Vault Markdown 文件");
  return await invoke<BridgeNotesVaultWriteResult>("write_notes_vault_markdown_file", input);
}


async function renameNotesVaultMarkdownFile(input: { vault: BridgeVaultMetadata; relativePath: string; newName: string }): Promise<BridgeNotesVaultMarkdownFile> {
  if (!isTauri()) throw new Error("real-vault-rename-markdown-not-supported");
  return await invoke<BridgeNotesVaultMarkdownFile>("rename_notes_vault_markdown_file", input);
}

async function renameNotesVaultFolder(input: { vault: BridgeVaultMetadata; relativePath: string; newName: string }): Promise<BridgeNotesVaultFileNode> {
  if (!isTauri()) throw new Error("real-vault-rename-folder-not-supported");
  return await invoke<BridgeNotesVaultFileNode>("rename_notes_vault_folder", input);
}

async function moveNotesVaultMarkdownFile(input: { vault: BridgeVaultMetadata; relativePath: string; targetParentRelativePath: string }): Promise<BridgeNotesVaultMarkdownFile> {
  if (!isTauri()) throw new Error("real-vault-move-markdown-not-supported");
  return await invoke<BridgeNotesVaultMarkdownFile>("move_notes_vault_markdown_file", input);
}

async function moveNotesVaultFolder(input: { vault: BridgeVaultMetadata; relativePath: string; targetParentRelativePath: string }): Promise<BridgeNotesVaultFileNode> {
  if (!isTauri()) throw new Error("real-vault-move-folder-not-supported");
  return await invoke<BridgeNotesVaultFileNode>("move_notes_vault_folder", input);
}

async function deleteNotesVaultMarkdownFile(input: { vault: BridgeVaultMetadata; relativePath: string }): Promise<BridgeNotesVaultDeleteResult> {
  if (!isTauri()) throw new Error("real-vault-delete-markdown-not-supported");
  return await invoke<BridgeNotesVaultDeleteResult>("delete_notes_vault_markdown_file", input);
}

async function deleteNotesVaultEmptyFolder(input: { vault: BridgeVaultMetadata; relativePath: string }): Promise<BridgeNotesVaultDeleteResult> {
  if (!isTauri()) throw new Error("real-vault-delete-empty-folder-not-supported");
  return await invoke<BridgeNotesVaultDeleteResult>("delete_notes_vault_empty_folder", input);
}

async function getLocalTransportClientConfig(): Promise<{ baseUrl: string; credential: string; protocolVersion: number }> {
  if (!isTauri()) {
    return { baseUrl: "http://127.0.0.1:37418", credential: "", protocolVersion: 1 };
  }
  return invoke<{ baseUrl: string; credential: string; protocolVersion: number }>(
    "get_local_transport_client_config",
  );
}

async function classifyDroppedPaths(paths: string[]): Promise<BridgeDroppedPathInfo[]> {
  if (!isTauri() || !paths.length) return [];
  const items = await invoke<Array<{ path: string; is_file?: boolean; is_dir?: boolean; isFile?: boolean; isDir?: boolean }>>(
    "classify_dropped_paths",
    { paths },
  );
  return items.map((item) => ({
    path: item.path,
    isFile: Boolean(item.isFile ?? item.is_file),
    isDir: Boolean(item.isDir ?? item.is_dir),
  }));
}

async function importNotesVaultMarkdownFiles(input: { vault: BridgeVaultMetadata; targetParentRelativePath: string; sourcePaths?: string[] }): Promise<BridgeNotesVaultImportMarkdownResult> {
  if (!isTauri()) {
    return { copiedCount: 0, skippedCount: 0, conflictRenamedCount: 0, targetParentRelativePath: input.targetParentRelativePath || "", files: [], errors: [] };
  }
  let sourcePaths = input.sourcePaths || [];
  if (!sourcePaths.length) {
    const selected = await open({
      title: "导入 Markdown 到当前仓库",
      multiple: true,
      filters: [
        { name: "Markdown", extensions: ["md", "markdown"] },
      ],
    });
    if (!selected) {
      return { copiedCount: 0, skippedCount: 0, conflictRenamedCount: 0, targetParentRelativePath: input.targetParentRelativePath || "", files: [], errors: [] };
    }
    sourcePaths = Array.isArray(selected) ? selected : [selected];
  }
  return await invoke<BridgeNotesVaultImportMarkdownResult>("import_notes_vault_markdown_files", {
    vault: input.vault,
    sourcePaths,
    targetParentRelativePath: input.targetParentRelativePath || "",
  });
}

async function importNotesVaultMarkdownFolder(input: { vault: BridgeVaultMetadata; targetParentRelativePath: string; sourceDirectoryPath?: string }): Promise<BridgeNotesVaultImportMarkdownResult> {
  if (!isTauri()) {
    return { copiedCount: 0, skippedCount: 0, conflictRenamedCount: 0, targetParentRelativePath: input.targetParentRelativePath || "", files: [], errors: [] };
  }
  let sourceDirectoryPath = input.sourceDirectoryPath || "";
  if (!sourceDirectoryPath) {
    const selected = await open({
      title: "选择要导入的 Markdown 文件夹",
      directory: true,
      multiple: false,
    });
    if (!selected) {
      return { copiedCount: 0, skippedCount: 0, conflictRenamedCount: 0, targetParentRelativePath: input.targetParentRelativePath || "", files: [], errors: [] };
    }
    sourceDirectoryPath = Array.isArray(selected) ? (selected[0] || "") : selected;
  }
  if (!sourceDirectoryPath) {
    return { copiedCount: 0, skippedCount: 0, conflictRenamedCount: 0, targetParentRelativePath: input.targetParentRelativePath || "", files: [], errors: [] };
  }
  return await invoke<BridgeNotesVaultImportMarkdownResult>("import_notes_vault_markdown_folder", {
    vault: input.vault,
    sourceDirectoryPath,
    targetParentRelativePath: input.targetParentRelativePath || "",
  });
}

async function exportNotesVaultMarkdownFile(input: { vault: BridgeVaultMetadata; relativePath: string; targetDirectoryPath?: string }): Promise<BridgeNotesVaultExportMarkdownResult> {
  if (!isTauri()) {
    return { exportedCount: 0, conflictRenamedCount: 0, targetDirectoryPath: input.targetDirectoryPath || "", files: [], errors: [] };
  }
  let targetDirectoryPath = input.targetDirectoryPath || "";
  if (!targetDirectoryPath) {
    const selected = await open({
      title: "选择 Markdown 导出位置",
      directory: true,
      multiple: false,
    });
    if (!selected) {
      return { exportedCount: 0, conflictRenamedCount: 0, targetDirectoryPath: "", files: [], errors: [] };
    }
    targetDirectoryPath = Array.isArray(selected) ? (selected[0] || "") : selected;
  }
  if (!targetDirectoryPath) {
    return { exportedCount: 0, conflictRenamedCount: 0, targetDirectoryPath: "", files: [], errors: [] };
  }
  return await invoke<BridgeNotesVaultExportMarkdownResult>("export_notes_vault_markdown_file", {
    vault: input.vault,
    relativePath: input.relativePath,
    targetDirectoryPath,
  });
}

async function exportNotesVaultMarkdownFolder(input: { vault: BridgeVaultMetadata; relativePath: string; targetDirectoryPath?: string }): Promise<BridgeNotesVaultExportMarkdownResult> {
  if (!isTauri()) {
    return { exportedCount: 0, conflictRenamedCount: 0, targetDirectoryPath: input.targetDirectoryPath || "", files: [], errors: [] };
  }
  let targetDirectoryPath = input.targetDirectoryPath || "";
  if (!targetDirectoryPath) {
    const selected = await open({
      title: "选择文件夹导出位置",
      directory: true,
      multiple: false,
    });
    if (!selected) {
      return { exportedCount: 0, conflictRenamedCount: 0, targetDirectoryPath: "", files: [], errors: [] };
    }
    targetDirectoryPath = Array.isArray(selected) ? (selected[0] || "") : selected;
  }
  if (!targetDirectoryPath) {
    return { exportedCount: 0, conflictRenamedCount: 0, targetDirectoryPath: "", files: [], errors: [] };
  }
  return await invoke<BridgeNotesVaultExportMarkdownResult>("export_notes_vault_markdown_folder", {
    vault: input.vault,
    relativePath: input.relativePath || "",
    targetDirectoryPath,
  });
}


async function getAutoLaunchEnabled(): Promise<boolean> {
  if (!isTauri()) return false;
  return await invoke<boolean>("get_auto_launch_enabled");
}

async function setAutoLaunchEnabled(enabled: boolean): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("set_auto_launch_enabled", { enabled });
}

async function getStorageUsage(): Promise<BridgeStorageUsage> {
  if (!isTauri()) {
    return {
      app_data_dir: "",
      db_size_bytes: 0,
      asset_library_size_bytes: 0,
      thumbnail_size_bytes: 0,
      canvas_size_bytes: 0,
      generated_media_size_bytes: 0,
      other_data_size_bytes: 0,
      backup_size_bytes: 0,
      total_size_bytes: 0,
      asset_count: 0,
      note_count: 0,
      tag_count: 0,
      collection_count: 0,
    };
  }
  return await invoke<BridgeStorageUsage>("get_storage_usage");
}

async function clearThumbnailCache(): Promise<BridgeClearCacheResult> {
  if (!isTauri()) return { removed_bytes: 0, removed_files: 0 };
  return await invoke<BridgeClearCacheResult>("clear_thumbnail_cache");
}

async function clearAllData(): Promise<BridgeClearAllDataResult> {
  if (!isTauri()) return { backup_id: "browser-preview", cleared_tables: [], removed_bytes: 0, removed_files: 0 };
  if (dbPromise) {
    try {
      const db = await dbPromise;
      if (db) await db.close();
    } catch (_) {}
    dbPromise = null;
  }
  const result = await invoke<BridgeClearAllDataResult>("clear_all_data");
  dbPromise = null;
  await getDb();
  return result;
}

// ===== D16 数据安全 Bridge =====

async function createBackup(): Promise<BridgeBackupInfo> {
  return await invoke<BridgeBackupInfo>("create_backup");
}

async function listBackups(): Promise<BridgeBackupInfo[]> {
  return await invoke<BridgeBackupInfo[]>("list_backups");
}

async function restoreBackup(backupId: string): Promise<string> {
  // 关闭当前数据库连接，避免文件锁定
  if (dbPromise) {
    try {
      const db = await dbPromise;
      if (db) await db.close();
    } catch (_) {}
    dbPromise = null;
  }
  const result = await invoke<string>("restore_backup", { backupId });
  // 重新打开数据库连接
  dbPromise = null;
  await getDb();
  return result;
}

async function exportNotesMarkdown(options?: ExportNotesMarkdownOptions): Promise<BridgeExportResult> {
  if (options?.noteIds?.length || options?.folderIds?.length) {
    throw new KnowledgeServiceError("legacy-db-note-retired", "Legacy database note export selection is retired");
  }
  const vault = await getCurrentNotesVault();
  if (!vault) throw new KnowledgeServiceError("knowledge-vault-required", "Open or create a Vault before exporting knowledge documents");
  const result = await exportNotesVaultMarkdownFolder({ vault, relativePath: "" });
  return { path: result.targetDirectoryPath, count: result.exportedCount };
}

async function exportAssetsIndex(): Promise<BridgeExportResult> {
  return await invoke<BridgeExportResult>("export_assets_index");
}

// ===== D17 素材库完善 Bridge =====

async function selectImportFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await open({
    title: "选择要导入的文件夹",
    directory: true,
    multiple: false,
  });
  if (Array.isArray(selected)) return selected[0] || null;
  return selected || null;
}

async function importFolder(path: string, options?: MaterialFolderImportOptions): Promise<BridgeImportFolderResult> {
  const { storageMode, managedLibraryDir } = readMaterialImportSettings(options);
  return invoke<{
    importedCount: number;
    skippedDuplicateCount: number;
    failedCount: number;
    failedItems: Array<{ file: string; code?: string; error: string }>;
  }>("material_catalog_import_folder", {
    path,
    options: {
      storageMode,
      managedLibraryDir,
      recursive: options?.recursive ?? true,
      preserveFolderStructure: options?.preserveFolderStructure ?? true,
      folderId: null,
    },
  });
}

async function scanMissingAssets(): Promise<BridgeMissingAsset[]> {
  return await invoke<BridgeMissingAsset[]>("material_catalog_scan_missing");
}

async function removeAssetRecord(id: string): Promise<BridgeRemoveResult> {
  return await invoke<BridgeRemoveResult>("material_catalog_remove_asset_record", { id });
}

async function listAssetsFiltered(filters: BridgeAssetFilter): Promise<BridgeAsset[]> {
  if (isTauri()) {
    const assets = await invoke<BridgeAsset[]>("material_catalog_list_assets", { filters });
    return assets.map((asset) => normalizeAsset(asset));
  }
  const tagMap = fallbackAssetTagMap();
  let assets = await listAssets();
  if (filters.tag_ids?.length) {
    assets = assets.filter((asset) => {
      const ids = tagMap[asset.id] || [];
      return filters.tag_ids!.every((tagId) => ids.includes(tagId));
    });
  }
  if (filters.folder_id) assets = assets.filter((asset) => asset.folderId === filters.folder_id);
  if (filters.kinds?.length) assets = assets.filter((asset) => filters.kinds!.includes(asset.kind));
  if (filters.dominant_color) assets = assets.filter((asset) => dominantColorContains(asset.dominantColor, filters.dominant_color));
  if (typeof filters.rating_min === "number") assets = assets.filter((asset) => (asset.rating ?? 0) >= Number(filters.rating_min));
  if (filters.date_from) assets = assets.filter((asset) => Date.parse(asset.importedAt || asset.updatedAt || "") >= Date.parse(filters.date_from!));
  if (filters.date_to) assets = assets.filter((asset) => Date.parse(asset.importedAt || asset.updatedAt || "") < Date.parse(filters.date_to!));
  return filters.recent_only ? assets.slice(0, 50) : assets.slice(0, filters.limit || assets.length);
}

// ===== D21 收集箱 Bridge =====

function normalizeCollectionItem(row: Record<string, unknown>): BridgeCollectionItem {
  return {
    id: row.id as string,
    type: ((row.type as string) || "text") as BridgeCollectionItem["type"],
    content: (row.content as string) || "",
    assetId: (row.asset_id as string) || null,
    urlMetadata: (row.url_metadata as string) || null,
    source: (row.source as string) || null,
    createdAt: (row.created_at as string) || new Date().toISOString(),
    processedAt: (row.processed_at as string) || null,
    processedNoteId: (row.processed_note_id as string) || null,
    processedAction: (row.processed_action as string) || null,
    thumbnail: (row.thumbnail as string) || null,
    browser: (row.browser as string) || null,
    trigger: (row.trigger as string) || null,
  };
}

async function collectionAddTextWithSource(content: string, source: string): Promise<BridgeCollectionItem> {
  const db = await getDb();
  const id = createId("col");
  const now = new Date().toISOString();
  if (!db) {
    return normalizeCollectionItem({ id, type: "text", content, source, created_at: now });
  }
  await db.execute(
    `insert into collection_item (id, type, content, source, created_at) values ($1, 'text', $2, $3, $4)`,
    [id, content, source, now],
  );
  return normalizeCollectionItem({ id, type: "text", content, source, created_at: now });
}

async function collectionAddText(content: string): Promise<BridgeCollectionItem> {
  return collectionAddTextWithSource(content, "manual");
}

async function collectionAddLink(url: string): Promise<BridgeCollectionItem> {
  const db = await getDb();
  const id = createId("col");
  const now = new Date().toISOString();
  // 基础 URL metadata 解析
  let metadata = "{}";
  try {
    const u = new URL(url);
    metadata = JSON.stringify({ hostname: u.hostname, pathname: u.pathname });
  } catch (_) { /* 不是标准 URL，仍保存 */ }
  if (!db) {
    return normalizeCollectionItem({ id, type: "link", content: url, url_metadata: metadata, source: "manual", created_at: now });
  }
  await db.execute(
    `insert into collection_item (id, type, content, url_metadata, source, created_at) values ($1, 'link', $2, $3, 'manual', $4)`,
    [id, url, metadata, now],
  );
  return normalizeCollectionItem({ id, type: "link", content: url, url_metadata: metadata, source: "manual", created_at: now });
}

async function collectionAddClipboard(type: "text" | "image"): Promise<BridgeCollectionItem | null> {
  if (type === "text") {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        console.warn("[luckyray] clipboard text is empty");
        return null;
      }
      return await collectionAddTextWithSource(text, "clipboard_text");
    } catch (e) {
      console.warn("[luckyray] clipboard readText failed", e);
      return null;
    }
  }
  // 图片
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const mimeType of item.types) {
        if (mimeType.startsWith("image/")) {
          const blob = await item.getType(mimeType);
          // 转为 File 并走 importDroppedFiles
          const ext = mimeType.split("/")[1] || "png";
          const file = new File([blob], `clipboard-${Date.now()}.${ext}`, { type: mimeType });
          const result = await importDroppedFiles([file]);
          if (result.assets.length > 0) {
            const asset = result.assets[0];
            const db = await getDb();
            const id = createId("col");
            const now = new Date().toISOString();
            if (db) {
              await db.execute(
                `insert into collection_item (id, type, content, asset_id, source, created_at) values ($1, 'file', $2, $3, 'clipboard_image', $4)`,
                [id, asset.name, asset.id, now],
              );
            }
            return normalizeCollectionItem({ id, type: "file", content: asset.name, asset_id: asset.id, source: "clipboard_image", created_at: now });
          }
          break;
        }
      }
    }
    console.warn("[luckyray] clipboard has no image");
    return null;
  } catch (e) {
    console.warn("[luckyray] clipboard read failed", e);
    return null;
  }
}

async function collectionList(filter?: { type?: string; unprocessedOnly?: boolean }): Promise<BridgeCollectionItem[]> {
  const db = await getDb();
  if (!db) return [];
  let sql = "select * from collection_item";
  const conditions: string[] = [];
  const params: unknown[] = [];
  let index = 1;
  if (filter?.type) {
    conditions.push(`type = $${index++}`);
    params.push(filter.type);
  }
  if (filter?.unprocessedOnly) {
    conditions.push("processed_at is null");
  }
  if (conditions.length) sql += ` where ${conditions.join(" and ")}`;
  sql += " order by created_at desc";
  const rows = await db.select<Record<string, unknown>[]>(sql, params);
  return rows.map(normalizeCollectionItem);
}

async function collectionDelete(id: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.execute("delete from collection_item where id = $1", [id]);
}

async function collectionMarkInsertedToNote(id: string, noteId: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const now = new Date().toISOString();
  await db.execute(
    `update collection_item set processed_at = $1, processed_note_id = $2, processed_action = 'inserted_to_note' where id = $3`,
    [now, noteId, id],
  );
}

async function collectionMarkDeleted(id: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const now = new Date().toISOString();
  await db.execute(
    `update collection_item set processed_at = $1, processed_action = 'deleted' where id = $2`,
    [now, id],
  );
}

// D24: 批量状态更新（归档/忽略/删除）
async function collectionBatchUpdate(ids: string[], action: string): Promise<number> {
  if (!ids.length) return 0;
  if (!["archived", "ignored", "deleted"].includes(action)) return 0;
  const db = await getDb();
  if (!db) return 0;
  const now = new Date().toISOString();
  const placeholders = ids.map((_, i) => `$${i + 3}`).join(",");
  const result = await db.execute(
    `update collection_item set processed_at = $1, processed_action = $2 where id in (${placeholders}) and processed_at is null`,
    [now, action, ...ids],
  );
  return result.rowsAffected || 0;
}

// D24: 恢复为未处理
async function collectionRestore(id: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.execute(
    `update collection_item set processed_at = null, processed_action = null, processed_note_id = null, processed_asset_id = null where id = $1`,
    [id],
  );
}

type CollectionImageRow = {
  id: string;
  type: string;
  content: string;
  asset_id: string | null;
  processed_asset_id?: string | null;
  url_metadata: string | null;
  thumbnail?: string | null;
  trigger?: string | null;
};

function parseCollectionMetaValue(raw: string | null | undefined): Record<string, unknown> {
  try {
    return raw ? JSON.parse(raw) as Record<string, unknown> : {};
  } catch (_) {
    return {};
  }
}

function collectionImageUrlFromRow(item: CollectionImageRow, overrideUrl?: string): string {
  const meta = parseCollectionMetaValue(item.url_metadata);
  const candidates = [
    overrideUrl,
    meta.imageUrl,
    item.thumbnail,
    meta.url,
    item.content,
  ].map((value) => String(value || ""));
  return candidates.find((value) => /^https?:\/\//i.test(value) && /\.(png|jpe?g|gif|webp|bmp|avif)(\?|#|$)/i.test(value))
    || candidates.find((value) => /^https?:\/\//i.test(value))
    || "";
}

function isCollectionImageRow(item: CollectionImageRow): boolean {
  if (item.thumbnail) return true;
  if (item.trigger === "contextMenu.image" || item.trigger === "contextMenu.hoverImage") return true;
  return !!collectionImageUrlFromRow(item);
}

async function getAssetNameById(db: Database, assetId: string): Promise<string | null> {
  void db;
  return (await listAssets()).find((asset) => asset.id === assetId)?.name || null;
}

async function ensureCollectionImageAsset(
  db: Database,
  item: CollectionImageRow,
  overrideUrl?: string,
): Promise<{ assetId: string; assetName: string; result: ImportImageResult }> {
  const existingAssetId = item.asset_id || item.processed_asset_id || "";
  if (existingAssetId) {
    const existingName = await getAssetNameById(db, existingAssetId);
    if (existingName) {
      return {
        assetId: existingAssetId,
        assetName: existingName,
        result: { success: true, asset_id: existingAssetId, asset_name: existingName },
      };
    }
  }

  const imageUrl = collectionImageUrlFromRow(item, overrideUrl);
  if (!imageUrl) {
    throw new Error("没有找到可入库的图片 URL");
  }

  const result = await importImageToAssets(imageUrl);
  const assetId = result.asset_id || "";
  if (!assetId) {
    throw new Error(result.error || "图片入库失败，未返回素材 ID");
  }
  const assetName = result.asset_name || await getAssetNameById(db, assetId) || filenameFromPath(imageUrl) || "image";
  return { assetId, assetName, result: { ...result, success: true, asset_id: assetId, asset_name: assetName } };
}

// D24: 单条转笔记（新建笔记）
async function collectionSingleToNote(id: string, title: string): Promise<{ noteId: string; assetId?: string | null; assetName?: string | null } | null> {
  const db = await getDb();
  if (!db) return null;

  // 读取收集项
  const items = await db.select<Array<CollectionImageRow>>(
    `select id, type, content, asset_id, processed_asset_id, url_metadata, thumbnail, trigger from collection_item where id = $1 and processed_at is null`,
    [id],
  );
  if (!items.length) return null;
  const item = items[0];

  // 解析 metadata
  let meta: Record<string, unknown> = {};
  try { meta = item.url_metadata ? JSON.parse(item.url_metadata) : {}; } catch (_) {}

  // 生成笔记内容
  const now = new Date().toISOString();
  let contentText = buildNoteContentFromItem(item.type, item.content, meta);
  let processedAssetId: string | null = null;
  let processedAssetName: string | null = null;
  if (isCollectionImageRow(item)) {
    const imported = await ensureCollectionImageAsset(db, item);
    processedAssetId = imported.assetId;
    processedAssetName = imported.assetName;
    const sourceUrl = (meta.url as string) || collectionImageUrlFromRow(item);
    contentText = `![[${imported.assetName}]]${sourceUrl ? `\n\n来源: ${sourceUrl}` : ""}`;
  }

  // 创建笔记
  const created = await createKnowledgeDocument({ title, content: contentText });
  const noteId = knowledgeDocumentNoteId(created.documentRef);

  // 标记收集项已转笔记
  await db.execute(
    `update collection_item set processed_at = $1, processed_action = 'inserted_to_note', processed_note_id = $2, processed_asset_id = $3 where id = $4`,
    [now, noteId, processedAssetId, id],
  );

  return { noteId, assetId: processedAssetId, assetName: processedAssetName };
}

// D24: 批量合并转笔记
async function collectionBatchToNote(ids: string[], title: string): Promise<{ noteId: string; count: number; assetIds?: string[] } | null> {
  if (!ids.length) return null;
  const db = await getDb();
  if (!db) return null;

  // 读取所有收集项
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
  const items = await db.select<Array<CollectionImageRow>>(
    `select id, type, content, asset_id, processed_asset_id, url_metadata, thumbnail, trigger from collection_item where id in (${placeholders}) and processed_at is null order by created_at desc`,
    ids,
  );
  if (!items.length) return null;

  // 合并内容
  const parts: string[] = [];
  const itemAssetIds = new Map<string, string>();
  for (const item of items) {
    let meta: Record<string, unknown> = {};
    try { meta = item.url_metadata ? JSON.parse(item.url_metadata) : {}; } catch (_) {}
    const title = (meta.title as string) || item.content.substring(0, 50);
    if (isCollectionImageRow(item)) {
      const imported = await ensureCollectionImageAsset(db, item);
      itemAssetIds.set(item.id, imported.assetId);
      parts.push(`## ${title}\n\n![[${imported.assetName}]]`);
    } else {
      parts.push(`## ${title}\n\n${buildNoteContentFromItem(item.type, item.content, meta)}`);
    }
    if (meta.url) parts.push(`\n来源: ${meta.url}\n`);
  }

  const now = new Date().toISOString();
  const contentText = parts.join("\n\n---\n\n");

  // 创建笔记
  const created = await createKnowledgeDocument({ title, content: contentText });
  const noteId = knowledgeDocumentNoteId(created.documentRef);

  // 标记所有收集项
  const updatePlaceholders = ids.map((_, i) => `$${i + 2}`).join(",");
  await db.execute(
    `update collection_item set processed_at = $1, processed_action = 'inserted_to_note', processed_note_id = $2 where id in (${updatePlaceholders})`,
    [now, noteId, ...ids],
  );
  for (const [itemId, assetId] of itemAssetIds) {
    await db.execute(
      `update collection_item set processed_asset_id = $1 where id = $2`,
      [assetId, itemId],
    );
  }

  return { noteId, count: items.length, assetIds: Array.from(itemAssetIds.values()) };
}

// 辅助：从收集项生成笔记内容文本
function buildNoteContentFromItem(type: string, content: string, meta: Record<string, unknown>): string {
  const url = (meta.url as string) || "";
  const title = (meta.title as string) || "";
  const selection = (meta.selection as string) || "";

  if (type === "link") {
    return `## ${title || url}\n\n${url}\n\n${selection}`;
  }
  if (type === "text") {
    return `${content}\n\n${url ? `来源: ${url}` : ""}`;
  }
  return content;
}

// D25: 图片 URL 入素材库
type ImportImageResult = {
  success: boolean;
  asset_id?: string;
  asset_name?: string;
  skipped?: string;
  error?: string;
};

async function importImageToAssets(url: string): Promise<ImportImageResult> {
  return await invoke<ImportImageResult>("import_image_from_url", { url });
}

async function collectionImportImageToAssets(id: string, url?: string): Promise<ImportImageResult> {
  if (isTauri()) {
    try {
      return await invoke<ImportImageResult>("collection_image_to_assets", { item_id: id, url: url || "" });
    } catch (error: any) {
      // D36: 透传真实错误,前端 toast 能看到 "Unexpected end of input" 等具体信息
      const raw = typeof error === "string" ? error : (error && error.message) ? error.message : (() => { try { return JSON.stringify(error); } catch { return String(error); } })();
      console.warn("[luckyray] collection_image_to_assets command failed, fallback to frontend path", error);
      return { success: false, error: `后端命令失败: ${raw}` };
    }
  }
  const db = await getDb();
  if (!db) return { success: false, error: "数据库未就绪" };
  try {
    const rows = await db.select<Array<CollectionImageRow>>(
      `select id, type, content, asset_id, processed_asset_id, url_metadata, thumbnail, trigger from collection_item where id = $1`,
      [id],
    );
    if (!rows.length) return { success: false, error: "收集项不存在" };
    const item = rows[0];
    if (!isCollectionImageRow(item)) return { success: false, error: "该收集项不是图片" };

    const imported = await ensureCollectionImageAsset(db, item, url);
    const now = new Date().toISOString();
    await db.execute(
      `update collection_item set processed_at = $1, processed_action = 'moved_to_assets', processed_asset_id = $2 where id = $3`,
      [now, imported.assetId, id],
    );
    return imported.result;
  } catch (e: any) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[luckyray] collectionImportImageToAssets frontend fallback failed", e);
    return { success: false, error: `前端入库失败: ${msg}` };
  }
}

// D25: 标记收集项已入素材库
async function collectionMarkMovedToAssets(id: string, assetId: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const now = new Date().toISOString();
  await db.execute(
    `update collection_item set processed_at = $1, processed_action = 'moved_to_assets', processed_asset_id = $2 where id = $3`,
    [now, assetId, id],
  );
}

// D29: AI 后端调用
type AiChatResponse = {
  success: boolean;
  content?: string;
  error_kind?: string;
  error_message?: string;
  error_detail?: string;
};

type BridgeAiImageGenerateResponse = {
  success: boolean;
  images: Array<{ url: string; thumbnail_url?: string | null }>;
  error_kind?: string | null;
  error_message?: string | null;
  error_detail?: string | null;
};

type BridgeAiVideoGenerateResponse = {
  success: boolean;
  video_url?: string | null;
  thumbnail_url?: string | null;
  error_kind?: string | null;
  error_message?: string | null;
  error_detail?: string | null;
};

type BridgeAiVideoGenerationProgress = {
  client_task_id: string;
  provider_task_id?: string | null;
  stage: "queued" | "generating" | "downloading";
  progress?: number | null;
};

async function aiChatComplete(messages: Array<{ role: string; content: BridgeAiMessageContent }>, options?: { systemPrompt?: string; temperature?: number; maxTokens?: number; model?: string }): Promise<AiChatResponse> {
  try {
    return await invoke<AiChatResponse>("ai_chat_complete", {
      request: {
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        system_prompt: options?.systemPrompt ?? null,
        temperature: options?.temperature ?? null,
        max_tokens: options?.maxTokens ?? null,
        model: options?.model?.trim() || null,
      },
    });
  } catch (e: any) {
    const msg = e?.message || String(e);
    try {
      const parsed = JSON.parse(msg);
      if (parsed && parsed.error_kind) {
        return {
          success: false,
          error_kind: parsed.error_kind,
          error_message: parsed.error_message || msg,
          error_detail: parsed.error_detail,
        };
      }
    } catch {
      // Non-JSON bridge errors fall through to a generic connection error.
    }
    return { success: false, error_kind: "connection", error_message: msg };
  }
}

// ===== D32: AI 标签/摘要建议 =====

type AiSuggestion = {
  summary?: string;
  auto_tags: string[];
  status: string;
  error?: string;
  processed_at?: string;
};

// 从已有标签库中获取标签名列表（用于 prompt 中限制标签范围）
type AssetAiSource = {
  name: string | null;
  kind: string | null;
  mime_type: string | null;
  description: string | null;
  original_path: string | null;
  library_path: string | null;
  thumbnail_url: string | null;
};

async function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (/^https?:\/\//i.test(src)) image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image load failed"));
    image.src = src;
  });
}

async function imageBlobToAiDataUrl(blob: Blob, maxSide = 1024): Promise<string> {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await loadImageElement(objectUrl);
    const width = image.naturalWidth || image.width || 1;
    const height = image.naturalHeight || image.height || 1;
    const scale = Math.min(1, maxSide / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) return "";
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function imageUrlToAiDataUrl(src: string, maxSide = 1024): Promise<string> {
  if (!src) return "";
  if (src.startsWith("data:image/")) {
    const response = await fetch(src);
    return imageBlobToAiDataUrl(await response.blob(), maxSide);
  }
  try {
    const response = await fetch(src);
    if (!response.ok) throw new Error(`image fetch failed: ${response.status}`);
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) return "";
    return imageBlobToAiDataUrl(blob, maxSide);
  } catch (error) {
    try {
      const image = await loadImageElement(src);
      const width = image.naturalWidth || image.width || 1;
      const height = image.naturalHeight || image.height || 1;
      const scale = Math.min(1, maxSide / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d");
      if (!context) return "";
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.82);
    } catch (fallbackError) {
      console.warn("[luckyray] failed to prepare asset image for AI", error, fallbackError);
      return "";
    }
  }
}

async function buildAssetAiVisualDataUrl(asset: AssetAiSource): Promise<string> {
  const kind = (asset.kind || "").toLowerCase();
  const mimeType = asset.mime_type || "";
  const isImage = kind === "image" || mimeType.startsWith("image/");
  const isVideo = kind === "video" || mimeType.startsWith("video/");
  if (!isImage && !isVideo) return "";

  if (isVideo) {
    const thumbnailUrl = asset.thumbnail_url ? derivePreviewUrl("image", null, asset.thumbnail_url) : "";
    if (thumbnailUrl) {
      const dataUrl = await imageUrlToAiDataUrl(thumbnailUrl);
      if (dataUrl) return dataUrl;
    }
    const videoUrl = asset.library_path ? derivePreviewUrl("video", asset.library_path, null) : "";
    return videoUrl ? generateVideoThumbnail(videoUrl) : "";
  }

  const imageUrl = derivePreviewUrl("image", asset.library_path, asset.thumbnail_url);
  return imageUrl ? imageUrlToAiDataUrl(imageUrl) : "";
}

type MaterialAiCatalog = Pick<MaterialCatalogAdapter,"getAssetsByIds"|"getAssetTags"|"listTags"|"createTag"|"setAssetTags">;
const defaultMaterialAiCatalog = ():MaterialAiCatalog => ({getAssetsByIds,getAssetTags,listTags,createTag,setAssetTags});
async function generateAssetAiSuggestion(assetId: string, catalog:MaterialAiCatalog=defaultMaterialAiCatalog()): Promise<AiSuggestion | null> {
  const db = await getDb();
  if (!db) return null;
  // 读取素材信息
  const catalogAsset = (await catalog.getAssetsByIds([assetId]))[0];
  if (!catalogAsset) return null;
  const asset: AssetAiSource = {
    name: catalogAsset.name,
    kind: catalogAsset.kind,
    mime_type: catalogAsset.mimeType,
    description: catalogAsset.description,
    original_path: catalogAsset.originalPath,
    library_path: catalogAsset.libraryPath,
    thumbnail_url: catalogAsset.thumbnailUrl,
  };
  const existingTags = await catalog.getAssetTags(assetId);
  const tagNames = (await catalog.listTags()).map(tag=>tag.name);
  const visualDataUrl = await buildAssetAiVisualDataUrl(asset);

  const prompt = `素材名称: ${asset.name || '未命名'}
类型: ${asset.kind || '未知'}
MIME: ${asset.mime_type || '无'}
描述: ${asset.description || '无'}
路径: ${asset.original_path || '无'}
已有标签: ${existingTags.length ? existingTags.join(', ') : '无'}
标签库: ${tagNames.length ? tagNames.join(', ') : '无'}
当前画面: ${visualDataUrl ? '已附上当前素材的实际图片/视频帧，请以画面为准' : '未能读取预览图，只能参考文字信息'}

请为这个素材生成：
1. 一段素材画面描述（40字以内，写清主体、场景、光线或风格）
2. 3-5个标签建议（优先从标签库中选择，也可以新增）

要求：
- 如果旧描述、文件名或路径与画面冲突，以当前画面为准。
- 标签必须贴合当前素材，不要沿用上一张素材的结果。
- 描述和标签都使用中文。

严格按以下 JSON 格式输出，不要输出其他内容：
{"description":"...","tags":["标签1","标签2","标签3"]}`;

  try {
    const userContent: BridgeAiMessageContent = visualDataUrl
      ? [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: visualDataUrl } },
        ]
      : prompt;
    const result = await aiChatComplete([
      { role: 'system', content: '你是素材图片理解和标签建议助手。根据当前素材画面生成准确描述和标签，只输出 JSON，不要解释。' },
      { role: 'user', content: userContent }
    ], { temperature: 0.25, maxTokens: 650 });

    if (!result.success || !result.content) {
      const errorMessage = visualDataUrl
        ? `当前模型未能处理素材图片输入：${result.error_message || '生成失败'}`
        : (result.error_message || '生成失败');
      await db.execute(
        "insert or replace into asset_ai(asset_id, status, error, processed_at) values($1, 'error', $2, $3)",
        [assetId, errorMessage, new Date().toISOString()]
      );
      return { auto_tags: [], status: 'error', error: errorMessage };
    }

    // 解析 JSON（过滤 <think> 推理标签）
    const cleaned = result.content.trim().replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^```json?\s*/,'').replace(/\s*```$/,'').trim();
    const parsed = JSON.parse(cleaned);
    const rawTags: unknown[] = Array.isArray(parsed.tags) ? parsed.tags : [];
    const tags = Array.from(new Set<string>(
      rawTags
        .filter((tag: unknown): tag is string => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter(Boolean)
    )).slice(0, 6);
    const desc = typeof parsed.description === 'string'
      ? parsed.description.trim()
      : (typeof parsed.summary === 'string' ? parsed.summary.trim() : '');

    await db.execute(
      "insert or replace into asset_ai(asset_id, description, auto_tags, status, processed_at) values($1, $2, $3, 'pending', $4)",
      [assetId, desc, JSON.stringify(tags), new Date().toISOString()]
    );
    return { summary: desc, auto_tags: tags, status: 'pending' };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    await db.execute(
      "insert or replace into asset_ai(asset_id, status, error, processed_at) values($1, 'error', $2, $3)",
      [assetId, errMsg, new Date().toISOString()]
    );
    return { auto_tags: [], status: 'error', error: errMsg };
  }
}

async function getAssetAiSuggestion(assetId: string, catalog:MaterialAiCatalog=defaultMaterialAiCatalog()): Promise<AiSuggestion | null> {
  if (!(await catalog.getAssetsByIds([assetId])).length) throw new Error("素材不属于此库");
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select<Array<{ description: string; auto_tags: string; status: string; error: string; processed_at: string }>>(
    "select description, auto_tags, status, error, processed_at from asset_ai where asset_id = $1", [assetId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  let tags: string[] = [];
  try { tags = JSON.parse(r.auto_tags || '[]'); } catch {}
  return { summary: r.description, auto_tags: tags, status: r.status, error: r.error, processed_at: r.processed_at };
}

async function applyAssetAiTags(assetId: string, tagNames: string[], catalog:MaterialAiCatalog=defaultMaterialAiCatalog()): Promise<void> {
  if (!(await catalog.getAssetsByIds([assetId])).length) throw new Error("素材不属于此库");
  const db = await getDb();
  if (!db) return;
  // 获取或创建标签
  const knownTags = await catalog.listTags();
  const tagIds: string[] = [];
  for (const name of tagNames) {
    const existing = knownTags.find((tag) => tag.name === name);
    if (existing) {
      tagIds.push(existing.id);
    } else {
      const created = await catalog.createTag({ name });
      knownTags.push(created);
      tagIds.push(created.id);
    }
  }
  // 合并已有标签
  const currentTagIds = await catalog.getAssetTags(assetId);
  const merged = [...new Set([...currentTagIds, ...tagIds])];
  await catalog.setAssetTags(assetId, merged);
  await db.execute("update asset_ai set status = 'applied' where asset_id = $1", [assetId]);
}

async function notesInlineGenerate(action: "rewrite" | "shorten" | "expand" | "continue") {
  return invoke<BridgeNotesInlinePreview>("notes_inline_generate", { request: { action } });
}

async function notesInlineApply(previewId: string, mode: "replace" | "insert-below") {
  return invoke<BridgeNotesInlineApplyResult>("notes_inline_apply", {
    request: { previewId, mode },
  });
}

async function notesInlineDiscard(previewId: string) {
  await invoke("notes_inline_discard", { request: { previewId } });
}

async function notesInlineCancel() {
  return invoke<boolean>("notes_inline_cancel");
}

function canvasGenerationFailure(kind = "connection") {
  const messages: Record<string, string> = {
    no_api_key: "尚未配置画布生成服务",
    unauthorized: "画布生成服务认证失败",
    rate_limited: "画布生成服务请求过于频繁",
    timeout: "画布生成请求超时",
    invalid_response: "画布生成服务响应无效",
    unsupported_input: "当前生成服务不支持该输入",
    empty_response: "画布生成服务没有返回可用结果",
    connection: "画布生成服务连接失败",
  };
  return { error_kind: kind, error_message: messages[kind] || "画布生成服务暂时不可用" };
}

async function aiImageGenerate(
  request: import("./core/canvas/generationTasks").CanvasGenerationRequestSnapshot,
): Promise<import("./core/canvas/imageGenerationAdapter").CanvasImageGenerationResponse> {
  if (request.references.some((reference) => reference.kind === "video")) {
    return { success: false, images: [], ...canvasGenerationFailure("unsupported_input") };
  }
  try {
    // Text and notes are already compiled into the prompt; the native media list accepts images only.
    const references = await Promise.all(request.references.filter(reference => reference.kind !== "text" && reference.kind !== "note").map(async (reference) => ({
      id: reference.id,
      label: reference.label,
      kind: reference.kind,
      role: reference.role,
      media_url: reference.mediaUrl ? await prepareCanvasMediaReference(reference.mediaUrl) : null,
    })));
    const response = await invoke<BridgeAiImageGenerateResponse>("ai_image_generate", {
      mediaProfileId: request.mediaProfileId ?? null,
      mediaProfileRevision: request.mediaProfileRevision ?? null,
      request: {
        prompt: request.prompt,
        model: request.model,
        aspect: request.aspect ?? null,
        quality: request.quality ?? null,
        resolution: request.resolution ?? null,
        count: request.count ?? 1,
        references,
      },
    });
    const images = await Promise.all((response.images || []).map(async (image) => ({
      url: await materializeCanvasGeneratedImage(image.url),
      thumbnailUrl: image.thumbnail_url ? await materializeCanvasGeneratedImage(image.thumbnail_url) : null,
    })));
    return {
      success: response.success,
      images,
      error_kind: response.error_kind,
      error_message: response.error_message,
      error_detail: null,
    };
  } catch (error) {
    // Distinguish a rejected invocation (binding/permission/protocol issue)
    // from a real transport failure so the history entry says what happened.
    const code = String(error);
    if (code.includes("provider_error") || code.includes("canvas-media-profile")) {
      return { success: false, images: [], ...canvasGenerationFailure("provider_error") };
    }
    return { success: false, images: [], ...canvasGenerationFailure("connection") };
  }
}

async function aiVideoGenerate(
  request: import("./core/canvas/generationTasks").CanvasGenerationRequestSnapshot,
  onProgress?: (progress: import("./core/canvas/videoGenerationAdapter").CanvasVideoGenerationProgress) => void,
  providerTaskId?: string,
): Promise<import("./core/canvas/videoGenerationAdapter").CanvasVideoGenerationResponse> {
  if (request.references.some((reference) => reference.kind === "video")) {
    return { success: false, ...canvasGenerationFailure("unsupported_input") };
  }
  const clientTaskId = `canvas-video-${crypto.randomUUID()}`;
  let unlisten: undefined | (() => void);
  try {
    if (onProgress) {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<BridgeAiVideoGenerationProgress>("canvas-ai-video-progress", ({ payload }) => {
        if (payload.client_task_id !== clientTaskId) return;
        onProgress({
          stage: payload.stage,
          progress: payload.progress ?? undefined,
          providerTaskId: payload.provider_task_id ?? undefined,
        });
      });
    }
    // Text and notes are already compiled into the prompt; the native media list accepts images only.
    const references = await Promise.all(request.references.filter(reference => reference.kind !== "text" && reference.kind !== "note").map(async (reference) => ({
      id: reference.id,
      label: reference.label,
      kind: reference.kind,
      role: reference.role,
      media_url: reference.mediaUrl ? await prepareCanvasMediaReference(reference.mediaUrl) : null,
    })));
    const response = await invoke<BridgeAiVideoGenerateResponse>("ai_video_generate", {
      mediaProfileId: request.mediaProfileId ?? null,
      mediaProfileRevision: request.mediaProfileRevision ?? null,
      request: {
        client_task_id: clientTaskId,
        provider_task_id: providerTaskId || null,
        prompt: request.prompt,
        model: request.model,
        aspect: request.aspect ?? null,
        quality: request.quality ?? null,
        duration: request.duration ?? null,
        sound: request.sound ?? null,
        references,
      },
    });
    return {
      success: response.success,
      videoUrl: response.video_url,
      thumbnailUrl: response.thumbnail_url,
      error_kind: response.error_kind,
      error_message: response.error_message,
      error_detail: null,
    };
  } catch (error) {
    const code = String(error);
    if (code.includes("provider_error") || code.includes("canvas-media-profile")) {
      return { success: false, ...canvasGenerationFailure("provider_error") };
    }
    return { success: false, ...canvasGenerationFailure("connection") };
  } finally {
    unlisten?.();
  }
}

async function prepareCanvasMediaReference(value: string): Promise<string> {
  if (/^data:image\//i.test(value) || /^https:\/\//i.test(value)) return value;
  if (/^blob:/i.test(value)) {
    const response = await fetch(value);
    const blob = await response.blob();
    return bytesToCanvasDataUrl(new Uint8Array(await blob.arrayBuffer()), blob.type || "image/png");
  }
  let path = value;
  try {
    const url = new URL(value);
    if (url.protocol === "asset:" || url.hostname === "asset.localhost") {
      path = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, "$1");
    }
  } catch {
    // A plain local path is resolved by the Tauri filesystem plugin.
  }
  const bytes = await readFile(path);
  if (bytes.byteLength > 12 * 1024 * 1024) throw new Error("canvas-reference-too-large");
  const extension = path.split(/[?#]/, 1)[0].split(".").pop()?.toLowerCase();
  const mime = extension === "jpg" || extension === "jpeg" ? "image/jpeg"
    : extension === "webp" ? "image/webp"
      : extension === "gif" ? "image/gif"
        : "image/png";
  return bytesToCanvasDataUrl(bytes, mime);
}

function bytesToCanvasDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

async function materializeCanvasGeneratedImage(value: string): Promise<string> {
  if (!value.startsWith("data:image/")) return value;
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(value);
  if (!match) throw new Error("canvas-generated-image-invalid");
  const binary = atob(match[2]);
  if (binary.length > 24 * 1024 * 1024) throw new Error("canvas-generated-image-too-large");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const appDataDir = await getAppDataDir();
  const separator = appDataDir.includes("\\") ? "\\" : "/";
  const outputDir = `${appDataDir}${separator}generated-images`;
  await mkdir(outputDir, { recursive: true });
  const extension = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
  const outputPath = `${outputDir}${separator}${crypto.randomUUID()}.${extension}`;
  await writeFile(outputPath, bytes);
  return outputPath;
}

async function saveCanvasGenerationToLibrary(
  candidate: import("./core/canvas/generationHistory").CanvasGenerationLibraryCandidate,
): Promise<{ success: boolean; assetId?: string; message?: string }> {
  const mediaUrl = candidate.mediaUrl.trim();
  if (!mediaUrl) return { success: false, message: "生成结果没有可保存的文件" };
  if (candidate.kind === "image" && /^https:\/\//i.test(mediaUrl)) {
    const result = await importImageToAssets(mediaUrl);
    return result.success
      ? { success: true, assetId: result.asset_id, message: "已保存到素材库" }
      : { success: false, message: "图片结果暂时无法保存到素材库" };
  }
  if (/^(?:https?|data|blob):/i.test(mediaUrl)) {
    return { success: false, message: "远程结果需先生成本地文件后才能保存" };
  }
  try {
    const imported = await importAssets({ paths: [mediaUrl], storageMode: "managed" });
    const asset = imported.assets[0];
    return asset
      ? { success: true, assetId: asset.id, message: "已保存到素材库" }
      : { success: false, message: "素材库没有接受该生成结果" };
  } catch {
    return { success: false, message: "生成结果暂时无法保存到素材库" };
  }
}

async function dismissAssetAiSuggestion(assetId: string, catalog:MaterialAiCatalog=defaultMaterialAiCatalog()): Promise<void> {
  if (!(await catalog.getAssetsByIds([assetId])).length) throw new Error("素材不属于此库");
  const db = await getDb();
  if (!db) return;
  await db.execute("update asset_ai set status = 'dismissed' where asset_id = $1", [assetId]);
}

// ===== D35: 记忆系统 =====

const knowledgeAiSuggestionCache = new Map<string, AiSuggestion>();

function requireKnowledgeDocumentRef(noteId: string) {
  const documentRef = parseKnowledgeDocumentNoteId(noteId);
  if (!documentRef) {
    throw new KnowledgeServiceError("legacy-db-note-retired", "Legacy database note identities are retired");
  }
  return documentRef;
}

async function generateNoteAiSuggestion(noteId: string): Promise<AiSuggestion | null> {
  const documentRef = requireKnowledgeDocumentRef(noteId);
  const [document, index] = await Promise.all([
    readKnowledgeDocument(documentRef),
    readKnowledgeIndexSnapshot(),
  ]);
  if (index.vaultId !== documentRef.vaultId) {
    throw new KnowledgeServiceError("knowledge-vault-not-current", "Knowledge document belongs to another Vault");
  }
  const indexed = index.documents.find((candidate) => candidate.relativePath === documentRef.relativePath);
  if (!indexed) throw new KnowledgeServiceError("knowledge-not-found", "Knowledge document does not exist");
  const tagNames = [...new Set(index.documents.flatMap((candidate) => candidate.tags))];
  const prompt = [
    `Document title: ${document.title}`,
    `Content:\n${document.content.slice(0, 2000) || "(empty)"}`,
    `Existing tags: ${indexed.tags.join(", ") || "none"}`,
    `Vault tags: ${tagNames.join(", ") || "none"}`,
    'Return JSON only: {"summary":"...","tags":["tag"]}',
  ].join("\n\n");
  try {
    const result = await aiChatComplete([
      { role: "system", content: "Summarize the document and suggest 3-5 concise tags. Return JSON only." },
      { role: "user", content: prompt },
    ], { temperature: 0.3, maxTokens: 500 });
    if (!result.success || !result.content) {
      const failed = { auto_tags: [], status: "error", error: result.error_message };
      knowledgeAiSuggestionCache.set(noteId, failed);
      return failed;
    }
    const cleaned = result.content.trim().replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^```json?\s*/, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(cleaned) as { summary?: unknown; tags?: unknown };
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean).slice(0, 6)
      : [];
    const suggestion: AiSuggestion = {
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
      auto_tags: tags,
      status: "pending",
      processed_at: new Date().toISOString(),
    };
    knowledgeAiSuggestionCache.set(noteId, suggestion);
    return suggestion;
  } catch (error) {
    const failed: AiSuggestion = {
      auto_tags: [],
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      processed_at: new Date().toISOString(),
    };
    knowledgeAiSuggestionCache.set(noteId, failed);
    return failed;
  }
}

async function getNoteAiSuggestion(noteId: string): Promise<AiSuggestion | null> {
  requireKnowledgeDocumentRef(noteId);
  return knowledgeAiSuggestionCache.get(noteId) || null;
}

async function applyAiTags(itemType: "asset" | "note", itemId: string, tagNames: string[]): Promise<void> {
  if (itemType === "asset") return applyAssetAiTags(itemId, tagNames);
  const documentRef = requireKnowledgeDocumentRef(itemId);
  const [document, index] = await Promise.all([
    readKnowledgeDocument(documentRef),
    readKnowledgeIndexSnapshot(),
  ]);
  const indexed = index.vaultId === documentRef.vaultId
    ? index.documents.find((candidate) => candidate.relativePath === documentRef.relativePath)
    : null;
  if (!indexed) throw new KnowledgeServiceError("knowledge-vault-not-current", "Knowledge document belongs to another Vault");
  const merged = new Map(indexed.tags.map((name) => [knowledgeTagCanonicalKey(name), name]));
  for (const rawName of tagNames) {
    const name = rawName.trim();
    const key = knowledgeTagCanonicalKey(name);
    if (key && !merged.has(key)) merged.set(key, name);
  }
  await setActiveKnowledgeDocumentTags(documentRef, document.revision, [...merged.values()]);
  const suggestion = knowledgeAiSuggestionCache.get(itemId);
  if (suggestion) knowledgeAiSuggestionCache.set(itemId, { ...suggestion, status: "applied" });
}

async function dismissAiSuggestion(itemType: "asset" | "note", itemId: string): Promise<void> {
  if (itemType === "asset") return dismissAssetAiSuggestion(itemId);
  requireKnowledgeDocumentRef(itemId);
  knowledgeAiSuggestionCache.delete(itemId);
}

async function createMemoryView(content: string): Promise<void> {
  await invoke("agent_memory_manage_create", { content });
}

async function listMemoryViews(view: MemoryViewId): Promise<MemoryEntryView[]> {
  return invoke<MemoryEntryView[]>("agent_memory_list_view", { view });
}

async function searchMemoryViews(view: MemoryViewId, query: string): Promise<MemoryEntryView[]> {
  return invoke<MemoryEntryView[]>("agent_memory_search_view", { view, query });
}

async function updateMemoryView(entryRef: string, patch: { content?: string; pinned?: boolean }): Promise<void> {
  const content = typeof patch.content === "string" ? patch.content.trim() : undefined;
  if (typeof content === "string" && !content) throw new Error("记忆内容不能为空");
  await invoke("agent_memory_manage_update", {
    entryRef,
    content,
    pinned: patch.pinned,
  });
}

async function deleteMemoryView(entryRef: string): Promise<void> {
  await invoke("agent_memory_manage_delete", { entryRef });
}

async function getAssetPreviewUrl(path: string) {
  if (!path) return "";
  if (path.startsWith("browser:")) return browserPreviewUrls.get(path) || "";
  if (!isTauri()) return "";
  return convertFileSrc(path);
}

async function readBrowserImageThumbnail(file: File) {
  if (!file.type.startsWith("image/")) return "";
  const imageUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = imageUrl;
    });
    const maxSide = 640;
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth || 1, image.naturalHeight || 1));
    const width = Math.max(1, Math.round((image.naturalWidth || 1) * scale));
    const height = Math.max(1, Math.round((image.naturalHeight || 1) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return "";
    context.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL(file.type === "image/png" ? "image/png" : "image/jpeg", 0.82);
  } catch (error) {
    console.warn("[luckyray] failed to generate browser thumbnail", error);
    return "";
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

// 给 video 文件生成缩略图（取第一帧的 jpeg data URL）
// src 可以是 asset:// URL（tauri），或 blob: URL，或 http(s) URL
async function generateVideoThumbnail(src: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = "anonymous";
    video.src = src;
    let done = false;
    const finish = (v: string) => { if (!done) { done = true; resolve(v); } };
    const fail = () => { console.warn("[luckyray] video thumbnail failed", src); finish(""); };
    // 10 秒超时（视频元数据卡住）
    const timer = setTimeout(fail, 10000);
    video.addEventListener("error", () => { clearTimeout(timer); fail(); }, { once: true });
    video.addEventListener("loadedmetadata", () => {
      try {
        // 抓 0.1s 或中点帧
        video.currentTime = Math.min(0.1, (video.duration || 0) / 2);
      } catch (e) {
        clearTimeout(timer);
        fail();
      }
    });
    video.addEventListener("seeked", () => {
      clearTimeout(timer);
      try {
        const maxSide = 640;
        const w = video.videoWidth || 320;
        const h = video.videoHeight || 240;
        const scale = Math.min(1, maxSide / Math.max(w, h));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return fail();
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL("image/jpeg", 0.82));
      } catch (e) {
        fail();
      }
    });
  });
}

type VideoThumbnailBackfillAsset = Pick<BridgeAsset, "id" | "kind" | "originalPath" | "libraryPath" | "thumbnailUrl">;

const videoThumbnailNotifyIds = new Set<string>();
let videoThumbnailNotifyTimer: ReturnType<typeof setTimeout> | null = null;

function videoThumbnailBytes(dataUrl: string): number[] {
  const match = /^data:image\/(?:jpeg|jpg|png|webp);base64,([a-z0-9+/=]+)$/i.exec(dataUrl);
  if (!match) throw new Error("Unsupported video thumbnail data URL");
  const binary = atob(match[1]);
  const bytes = new Array<number>(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function persistVideoThumbnailData(assetId: string, dataUrl: string, notify: boolean): Promise<string> {
  return invoke<string>("persist_video_thumbnail", {
    assetId,
    data: videoThumbnailBytes(dataUrl),
    notify,
  });
}

function notifyVideoThumbnailBatch(assetId: string) {
  videoThumbnailNotifyIds.add(assetId);
  if (videoThumbnailNotifyTimer) clearTimeout(videoThumbnailNotifyTimer);
  videoThumbnailNotifyTimer = setTimeout(() => {
    const affectedIds = Array.from(videoThumbnailNotifyIds);
    videoThumbnailNotifyIds.clear();
    videoThumbnailNotifyTimer = null;
    if (affectedIds.length > 0) {
      void publishMaterialChange({ reason: "video-thumbnails-ready", affectedIds }).catch((error) => {
        console.warn("[luckyray] publish video thumbnail batch failed", error);
      });
    }
  }, 500);
}

function runVideoThumbnailBackfillQueue() {
  while (videoThumbnailBackfillActive < VIDEO_THUMBNAIL_BACKFILL_CONCURRENCY) {
    const task = videoThumbnailBackfillQueue.shift();
    if (!task) return;
    videoThumbnailBackfillActive += 1;
    void task().finally(() => {
      videoThumbnailBackfillActive = Math.max(0, videoThumbnailBackfillActive - 1);
      runVideoThumbnailBackfillQueue();
    });
  }
}

function scheduleVideoThumbnailBackfill(asset: VideoThumbnailBackfillAsset) {
  if (asset.kind !== "video" || videoThumbnailBackfillPending.has(asset.id)) return;
  const backfillInput = resolveVideoThumbnailBackfillInput(asset);
  if (!backfillInput) return;

  videoThumbnailBackfillPending.add(asset.id);
  videoThumbnailBackfillQueue.push(async () => {
    try {
      const dataUrl = backfillInput.kind === "image-data"
        ? backfillInput.value
        : await generateVideoThumbnail(convertFileSrc(backfillInput.value));
      if (!dataUrl) return;
      await persistVideoThumbnailData(asset.id, dataUrl, false);
      notifyVideoThumbnailBatch(asset.id);
    } catch (error) {
      console.warn("[luckyray] video thumbnail backfill failed", asset.id, error);
    } finally {
      videoThumbnailBackfillPending.delete(asset.id);
    }
  });
  runVideoThumbnailBackfillQueue();
}

async function pickBrowserFiles() {
  return new Promise<BridgeAsset[]>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.display = "none";
    input.addEventListener(
      "change",
      async () => {
        const importedAt = new Date().toISOString();
        const assets = await Promise.all(Array.from(input.files || []).map(async (file) => {
          const kind = kindFromName(file.name, file.type);
          const originalPath = `browser:${file.name}`;
          let thumbnailUrl = "";
          if (kind === "image") {
            thumbnailUrl = await readBrowserImageThumbnail(file);
          } else if (kind === "video") {
            // 浏览器内走 blob: URL 抓第一帧
            const blobUrl = URL.createObjectURL(file);
            browserPreviewUrls.set(originalPath, blobUrl);
            thumbnailUrl = await generateVideoThumbnail(blobUrl);
          }
          return normalizeAsset({
            id: createId(),
            name: file.name,
            originalPath,
            libraryPath: null,
            storageMode: "linked",
            kind,
            mimeType: file.type,
            sizeBytes: file.size,
            thumbnailUrl,
            importedAt,
            updatedAt: importedAt,
          });
        }));
        input.remove();
        resolve(assets);
      },
      { once: true },
    );
    document.body.appendChild(input);
    input.click();
  });
}

// 1.3 基础去重: 拉取 asset 表里已有的 original_path 集合
async function getExistingOriginalPaths(): Promise<Set<string>> {
  return new Set(fallbackAssets().map((asset) => asset.originalPath).filter(Boolean));
}

async function importAssets(options?: MaterialImportOptions) {
  const folderId = options?.folderId ?? null;
  const providedPaths = Array.isArray(options?.paths) ? options!.paths.filter((p) => typeof p === "string" && p.length > 0) : null;
  const { storageMode, managedLibraryDir } = readMaterialImportSettings(options);
  const onProgress = options?.onProgress;
  let effectiveFolderId = folderId;
  if (folderId) {
    // 校验 folderId 存在且 scope = materials
    const folder = await getFolderById(folderId);
    if (!folder || folder.scope !== "materials") {
      console.warn("[luckyray] importAssets: folderId invalid, falling back to root", folderId);
      // 不 throw, 静默 fallback 到根级 (UX 友好)
      effectiveFolderId = null;
    }
  }

  // 1.3 拉取已存在的 original_path 集合用于去重
  if (isTauri()) {
    const selected = providedPaths && providedPaths.length > 0
      ? providedPaths
      : await open({
          title: "导入素材",
          multiple: true,
          filters: [
            { name: "素材文件", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "mp4", "mov", "webm", "mp3", "wav", "pdf", "md", "txt", "doc", "docx", "ppt", "pptx", "xls", "xlsx"] },
            { name: "所有文件", extensions: ["*"] },
          ],
        });
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    if (paths.length === 0) return { assets: [], source: "tauri" as const, skippedDuplicates: 0 };
    onProgress?.({ current: 0, total: paths.length, phase: storageMode === "managed" ? "copying" : "importing" });
    const result = await invoke<{
      assets: BridgeAsset[];
      importedCount: number;
      skippedDuplicateCount: number;
      failedCount: number;
      failedItems: Array<{ file: string; code: string; error: string }>;
    }>("material_catalog_import_paths", {
      paths,
      options: {
        folderId: effectiveFolderId,
        storageMode,
        managedLibraryDir,
        preserveFolderStructure: false,
        recursive: false,
      },
    });
    const assets = result.assets.map((asset) => normalizeAsset(asset));
    onProgress?.({ current: paths.length, total: paths.length, phase: "done" });
    return {
      assets,
      source: "tauri" as const,
      skippedDuplicates: result.skippedDuplicateCount,
      errors: result.failedItems.length
        ? result.failedItems.map((item) => ({ name: item.file, error: item.error }))
        : undefined,
    };
  }

  const existingPaths = await getExistingOriginalPaths();

  const assets = await pickBrowserFiles();
  const deduped = assets.filter((asset) => !existingPaths.has(asset.originalPath));
  const skippedDuplicates = assets.length - deduped.length;
  if (skippedDuplicates > 0) {
    console.info(`[luckyray] importAssets dedup: skipped ${skippedDuplicates} browser paths already in library`);
  }
  if (deduped.length === 0) {
    return { assets: [], source: "browser" as const, skippedDuplicates };
  }
  const stamped = deduped.map((asset) => normalizeAsset({ ...asset, folderId: effectiveFolderId }));
  await persistAssets(stamped);
  return { assets: stamped, source: "browser" as const, skippedDuplicates };
}

async function importDroppedFiles(filesLike: File[] | FileList, options?: MaterialImportOptions) {
  const folderId = options?.folderId ?? null;
  const { managedLibraryDir } = readMaterialImportSettings(options);
  const files = Array.from(filesLike || []).filter((file) => {
    return file && typeof file.name === "string" && typeof file.arrayBuffer === "function";
  });
  if (files.length === 0) {
    return { assets: [], source: isTauri() ? "tauri" as const : "browser" as const, skippedDuplicates: 0 };
  }

  let effectiveFolderId = folderId;
  if (folderId) {
    const folder = await getFolderById(folderId);
    if (!folder || folder.scope !== "materials") {
      console.warn("[luckyray] importDroppedFiles: folderId invalid, falling back to root", folderId);
      effectiveFolderId = null;
    }
  }

  if (isTauri()) {
    const items = await Promise.all(files.map(async (file) => ({
      name: file.name,
      originalPath: `dropped:${file.name}:${file.size}:${file.lastModified || 0}`,
      mimeType: file.type,
      bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
    })));
    const result = await invoke<{
      assets: BridgeAsset[];
      skippedDuplicateCount: number;
      failedItems: Array<{ file: string; error: string }>;
    }>("material_catalog_import_bytes", {
      items,
      options: {
        folderId: effectiveFolderId,
        storageMode: "managed",
        managedLibraryDir,
        preserveFolderStructure: false,
        recursive: false,
      },
    });
    return {
      assets: result.assets.map((asset) => normalizeAsset(asset)),
      source: "tauri" as const,
      skippedDuplicates: result.skippedDuplicateCount,
      errors: result.failedItems.length
        ? result.failedItems.map((item) => ({ name: item.file, error: item.error }))
        : undefined,
    };
  }

  const existingPaths = await getExistingOriginalPaths();
  const importedAt = new Date().toISOString();
  const candidates = files.map((file) => ({
    file,
    originalPath: `dropped:${file.name}:${file.size}:${file.lastModified || 0}`,
  }));
  const deduped = candidates.filter((item) => !existingPaths.has(item.originalPath));
  const skippedDuplicates = candidates.length - deduped.length;

  if (deduped.length === 0) {
    return { assets: [], source: "browser" as const, skippedDuplicates };
  }

  const assets: BridgeAsset[] = [];

  for (const { file, originalPath } of deduped) {
    const id = createId();
    const kind = kindFromName(file.name, file.type);
    let thumbnailUrl = "";

    if (kind === "image") {
      thumbnailUrl = await readBrowserImageThumbnail(file);
    } else if (kind === "video") {
      const blobUrl = URL.createObjectURL(file);
      browserPreviewUrls.set(originalPath, blobUrl);
      thumbnailUrl = await generateVideoThumbnail(blobUrl);
    }

    assets.push(normalizeAsset({
      id,
      name: file.name,
      originalPath,
      libraryPath: null,
      storageMode: "linked",
      kind,
      mimeType: file.type,
      sizeBytes: file.size,
      thumbnailUrl,
      folderId: effectiveFolderId,
      importedAt,
      updatedAt: importedAt,
    }));
  }

  await persistAssets(assets);
  return { assets, source: "browser" as const, skippedDuplicates };
}

// ===== FOLDER BRIDGE =====

function fallbackFolders(): BridgeFolder[] {
  try {
    return JSON.parse(localStorage.getItem(FALLBACK_FOLDERS_KEY) || "[]") as BridgeFolder[];
  } catch {
    return [];
  }
}

function saveFallbackFolders(folders: BridgeFolder[]) {
  localStorage.setItem(FALLBACK_FOLDERS_KEY, JSON.stringify(folders));
}

type FolderRow = {
  id: string;
  scope: "materials" | "notes";
  parent_id: string | null;
  name: string;
  sort_order: number;
  open: number;
  created_at: string;
  updated_at: string;
};

function rowToFolder(row: FolderRow): BridgeFolder {
  return {
    id: row.id,
    scope: row.scope,
    parentId: row.parent_id,
    name: row.name,
    sortOrder: row.sort_order,
    open: row.open === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildFolderTree(folders: BridgeFolder[]): BridgeFolderNode[] {
  const map = new Map<string, BridgeFolderNode>();
  folders.forEach((f) => map.set(f.id, { ...f, children: [] }));
  const roots: BridgeFolderNode[] = [];
  map.forEach((node) => {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  });
  const sortRecursive = (nodes: BridgeFolderNode[]) => {
    nodes.sort((a, b) => a.sortOrder - b.sortOrder);
    nodes.forEach((n) => sortRecursive(n.children));
  };
  sortRecursive(roots);
  return roots;
}

async function listFolders(scope?: "materials" | "notes"): Promise<BridgeFolderNode[]> {
  if (isTauri() && scope === "materials") {
    return invoke<BridgeFolderNode[]>("material_catalog_list_folders");
  }
  const db = await getDb();
  if (!db) {
    const all = fallbackFolders();
    return buildFolderTree(scope ? all.filter((f) => f.scope === scope) : all);
  }
  const sql = scope
    ? `select id, scope, parent_id, name, sort_order, open, created_at, updated_at from folder where scope = $1 order by sort_order`
    : `select id, scope, parent_id, name, sort_order, open, created_at, updated_at from folder order by sort_order`;
  const rows = await db.select<FolderRow[]>(sql, scope ? [scope] : []);
  return buildFolderTree(rows.map(rowToFolder));
}

async function nextFolderSortOrder(scope: string, parentId: string | null): Promise<number> {
  const db = await getDb();
  if (!db) {
    const siblings = fallbackFolders().filter((f) => f.scope === scope && f.parentId === parentId);
    return siblings.length;
  }
  const rows = parentId
    ? await db.select<{ max: number | null }[]>(
        `select max(sort_order) as max from folder where scope = $1 and parent_id = $2`,
        [scope, parentId],
      )
    : await db.select<{ max: number | null }[]>(
        `select max(sort_order) as max from folder where scope = $1 and parent_id is null`,
        [scope],
      );
  return (rows[0]?.max ?? -1) + 1;
}

async function createFolder(input: CreateFolderInput): Promise<BridgeFolder> {
  if (isTauri() && input.scope === "materials") {
    return invoke<BridgeFolder>("material_catalog_create_folder", {
      input: { parentId: input.parentId, name: input.name },
    });
  }
  const folder = normalizeFolder({
    scope: input.scope,
    parentId: input.parentId,
    name: input.name,
    sortOrder: await nextFolderSortOrder(input.scope, input.parentId),
    open: false,
  });

  const db = await getDb();
  if (!db) {
    const all = fallbackFolders();
    all.push(folder);
    saveFallbackFolders(all);
    return folder;
  }
  await db.execute(
    `insert into folder (id, scope, parent_id, name, sort_order, open, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [folder.id, folder.scope, folder.parentId, folder.name, folder.sortOrder, folder.open ? 1 : 0, folder.createdAt, folder.updatedAt],
  );
  if (folder.scope === "materials") {
    await publishMaterialChange({ reason: "desktop-folder-create", foldersChanged: true });
  }
  return folder;
}

async function getFolderById(id: string): Promise<BridgeFolder | null> {
  if (isTauri()) {
    const pending = [...await listFolders("materials")];
    while (pending.length) {
      const folder = pending.shift()!;
      if (folder.id === id) return folder;
      pending.push(...folder.children);
    }
  }
  const db = await getDb();
  if (!db) {
    return fallbackFolders().find((f) => f.id === id) ?? null;
  }
  const rows = await db.select<FolderRow[]>(`select * from folder where id = $1 limit 1`, [id]);
  return rows[0] ? rowToFolder(rows[0]) : null;
}

async function renameFolder(id: string, name: string): Promise<BridgeFolder | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const existingMaterialFolder = isTauri()
    ? (await listFolders("materials")).flatMap(function flatten(folder): BridgeFolderNode[] {
        return [folder, ...folder.children.flatMap(flatten)];
      }).find((folder) => folder.id === id)
    : null;
  if (existingMaterialFolder) {
    return invoke<BridgeFolder | null>("material_catalog_rename_folder", { id, name: trimmed });
  }
  const updatedAt = new Date().toISOString();

  const db = await getDb();
  if (!db) {
    const all = fallbackFolders();
    const folder = all.find((f) => f.id === id);
    if (!folder) return null;
    folder.name = trimmed;
    folder.updatedAt = updatedAt;
    saveFallbackFolders(all);
    return folder;
  }
  const result = await db.execute(`update folder set name = $1, updated_at = $2 where id = $3`, [trimmed, updatedAt, id]);
  if (!result.rowsAffected) return null;
  const updated = await getFolderById(id);
  if (updated?.scope === "materials") {
    await publishMaterialChange({ reason: "desktop-folder-rename", foldersChanged: true });
  }
  return updated;
}

async function collectDescendantFolderIds(rootId: string): Promise<string[]> {
  const db = await getDb();
  if (!db) {
    // browser fallback: flatten 全表 + BFS
    const tree = await listFolders();
    const flat: BridgeFolder[] = [];
    (function walk(nodes: BridgeFolderNode[]) {
      nodes.forEach((n) => {
        flat.push(n);
        walk(n.children);
      });
    })(tree);
    const visited = new Set<string>([rootId]);
    const queue: string[] = [rootId];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const f of flat) {
        if (f.parentId === cur && !visited.has(f.id)) {
          visited.add(f.id);
          queue.push(f.id);
        }
      }
    }
    return [...visited];
  }
  // Tauri SQLite: 用递归 CTE 一次查询
  const rows = await db.select<{ id: string }[]>(
    `with recursive descendants(id) as (
       select id from folder where id = $1
       union all
       select f.id from folder f inner join descendants d on f.parent_id = d.id
     )
     select id from descendants`,
    [rootId],
  );
  return rows.map((r) => r.id);
}

async function deleteFolder(id: string): Promise<void> {
  const existingMaterialFolder = isTauri()
    ? (await listFolders("materials")).flatMap(function flatten(folder): BridgeFolderNode[] {
        return [folder, ...folder.children.flatMap(flatten)];
      }).find((folder) => folder.id === id)
    : null;
  if (existingMaterialFolder) {
    await invoke<boolean>("material_catalog_delete_folder", { id });
    return;
  }
  const db = await getDb();
  const rootFolder = await getFolderById(id);
  if (rootFolder?.scope === "notes") {
    throw new Error("legacy-db-note-retired: Legacy database note folders are retired");
  }
  const descendantIds = await collectDescendantFolderIds(id);
  if (!db) {
    const all = fallbackFolders().filter((f) => !descendantIds.includes(f.id));
    saveFallbackFolders(all);
    // 级联：相关 asset.folderId 设为 null
    const assets = fallbackAssets();
    assets.forEach((a) => {
      if (a.folderId && descendantIds.includes(a.folderId)) a.folderId = null;
    });
    saveFallbackAssets(assets);
    return;
  }

  if (descendantIds.length === 0) return;
  const placeholders = descendantIds.map((_, i) => `$${i + 1}`).join(",");
  await db.execute(
    `delete from folder where id in (${placeholders})`,
    descendantIds,
  );
  if (rootFolder?.scope === "materials") {
    await publishMaterialChange({ reason: "desktop-folder-delete", foldersChanged: true });
  }
}

async function isFolderDescendantOrSelf(dragId: string, candidateId: string): Promise<boolean> {
  if (dragId === candidateId) return true;
  const db = await getDb();
  if (!db) {
    const all = fallbackFolders();
    let cursor: string | null = candidateId;
    while (cursor) {
      if (cursor === dragId) return true;
      const parent = all.find((f) => f.id === cursor);
      cursor = parent?.parentId ?? null;
    }
    return false;
  }
  const rows = await db.select<{ id: string }[]>(
    `with recursive ancestors(id, parent_id) as (
       select id, parent_id from folder where id = $1
       union all
       select f.id, f.parent_id from folder f inner join ancestors a on f.id = a.parent_id
      )
     select id from ancestors where id = $2`,
    [candidateId, dragId],
  );
  return rows.length > 0;
}

async function moveFolder(input: MoveFolderInput): Promise<void> {
  const { id, targetId, position } = input;
  if (targetId && id === targetId) return;
  const existingMaterialFolder = isTauri()
    ? (await listFolders("materials")).flatMap(function flatten(folder): BridgeFolderNode[] {
        return [folder, ...folder.children.flatMap(flatten)];
      }).find((folder) => folder.id === id)
    : null;
  if (existingMaterialFolder) {
    await invoke<boolean>("material_catalog_move_folder", { input });
    return;
  }

  const updatedAt = new Date().toISOString();
  const db = await getDb();

  if (!db) {
    const all = fallbackFolders();
    const folder = all.find((f) => f.id === id);
    const target = targetId ? all.find((f) => f.id === targetId) : null;
    if (!folder || (targetId && !target)) return;
    if (target && target.scope !== folder.scope) return;
    if (targetId && await isFolderDescendantOrSelf(id, targetId)) return; // 防环

    let newParentId: string | null;
    let newSortOrder: number;
    if (position === "inside" || !target) {
      newParentId = targetId ?? null;
      newSortOrder = all.filter((f) => f.scope === folder.scope && f.id !== id && f.parentId === newParentId).length;
    } else {
      newParentId = target.parentId;
      const siblings = all.filter((f) => f.scope === folder.scope && f.id !== id && f.parentId === newParentId);
      const targetIdx = siblings.findIndex((f) => f.id === targetId);
      newSortOrder = position === "before" ? targetIdx : targetIdx + 1;
    }
    folder.parentId = newParentId;
    folder.sortOrder = newSortOrder;
    folder.updatedAt = updatedAt;
    saveFallbackFolders(all);
    return;
  }

  // Tauri SQLite 路径
  const folder = await getFolderById(id);
  if (!folder) return;
  const target = targetId ? await getFolderById(targetId) : null;
  if (targetId && !target) return;
  if (target && target.scope !== folder.scope) return;
  if (targetId && await isFolderDescendantOrSelf(id, targetId)) return;

  let newParentId: string | null;
  let newSortOrder: number;
  if (position === "inside" || !target) {
    newParentId = targetId ?? null;
    const rows = newParentId
      ? await db.select<{ max: number | null }[]>(
          `select max(sort_order) as max from folder where scope = $1 and parent_id = $2`,
          [folder.scope, newParentId],
        )
      : await db.select<{ max: number | null }[]>(
          `select max(sort_order) as max from folder where scope = $1 and parent_id is null`,
          [folder.scope],
        );
    newSortOrder = (rows[0]?.max ?? -1) + 1;
  } else {
    newParentId = target.parentId;
    const rows = newParentId
      ? await db.select<{ id: string; sort_order: number }[]>(
          `select id, sort_order from folder where scope = $1 and parent_id = $2 order by sort_order`,
          [folder.scope, newParentId],
        )
      : await db.select<{ id: string; sort_order: number }[]>(
          `select id, sort_order from folder where scope = $1 and parent_id is null order by sort_order`,
          [folder.scope],
        );
    const targetIdx = rows.findIndex((r) => r.id === targetId);
    if (targetIdx === -1) return;
    newSortOrder = position === "before" ? targetIdx : targetIdx + 1;
    // 把 targetIdx+1..end 的 sort_order + 1
    for (let i = (position === "before" ? targetIdx : targetIdx + 1); i < rows.length; i++) {
      await db.execute(`update folder set sort_order = sort_order + 1 where id = $1`, [rows[i].id]);
    }
  }
  await db.execute(
    `update folder set parent_id = $1, sort_order = $2, updated_at = $3 where id = $4`,
    [newParentId, newSortOrder, updatedAt, id],
  );
  if (folder.scope === "materials") {
    await publishMaterialChange({ reason: "desktop-folder-move", foldersChanged: true });
  }
}

async function moveAssetToFolder(input: MoveAssetToFolderInput): Promise<void> {
  const { assetId, folderId } = input;
  if (isTauri()) {
    await invoke<boolean>("material_catalog_move_asset", { id: assetId, folderId });
    return;
  }
  if (folderId) {
    const folder = await getFolderById(folderId);
    if (!folder || folder.scope !== "materials") return; // scope mismatch
  }
  const assets = fallbackAssets();
  const asset = assets.find((candidate) => candidate.id === assetId);
  if (!asset) return;
  asset.folderId = folderId;
  asset.updatedAt = new Date().toISOString();
  saveFallbackAssets(assets);
}

// ===== TAG BRIDGE =====

function fallbackTags(): BridgeTag[] {
  try {
    const raw = JSON.parse(localStorage.getItem(FALLBACK_TAGS_KEY) || "[]") as BridgeTag[];
    // 兜底字段（assetCount/noteCount 老数据可能缺）
    return raw.map((t) => ({
      id: t.id,
      name: t.name || "",
      color: t.color ?? null,
      assetCount: typeof t.assetCount === "number" ? t.assetCount : 0,
      noteCount: typeof t.noteCount === "number" ? t.noteCount : 0,
      createdAt: t.createdAt || new Date().toISOString(),
      updatedAt: t.updatedAt || t.createdAt || new Date().toISOString(),
    }));
  } catch {
    return [];
  }
}

function saveFallbackTags(tags: BridgeTag[]) {
  localStorage.setItem(FALLBACK_TAGS_KEY, JSON.stringify(tags));
}

function fallbackAssetTagMap(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(FALLBACK_ASSET_TAGS_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveFallbackAssetTagMap(map: Record<string, string[]>) {
  localStorage.setItem(FALLBACK_ASSET_TAGS_KEY, JSON.stringify(map));
}

function normalizeTag(row: Partial<BridgeTag>): BridgeTag {
  const now = new Date().toISOString();
  return {
    id: row.id || createId("tag"),
    name: (row.name || "").trim(),
    color: row.color ?? null,
    assetCount: row.assetCount ?? 0,
    noteCount: row.noteCount ?? 0,
    createdAt: row.createdAt || now,
    updatedAt: row.updatedAt || row.createdAt || now,
  };
}

async function listTags(): Promise<BridgeTag[]> {
  if (isTauri()) return invoke<BridgeTag[]>("material_catalog_list_tags");
  const assetMap = fallbackAssetTagMap();
  return fallbackTags().map((tag) => ({
    ...tag,
    assetCount: Object.values(assetMap).filter((ids) => ids.includes(tag.id)).length,
    noteCount: 0,
  }));
}

async function createTag(input: CreateTagInput): Promise<BridgeTag> {
  const name = (input.name || "").trim();
  if (isTauri() && name) {
    return invoke<BridgeTag>("material_catalog_create_tag", { name, color: input.color ?? null });
  }
  if (!name) throw new Error("标签名不能为空");
  const tag = normalizeTag({
    name,
    color: input.color ?? null,
  });

  const all = fallbackTags();
  if (all.some((existing) => existing.name.toLowerCase() === name.toLowerCase())) {
    throw new Error("标签名已存在");
  }
  all.push(tag);
  saveFallbackTags(all);
  return tag;
}

async function renameTag(id: string, name: string): Promise<BridgeTag | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (isTauri()) {
    const current = (await listTags()).find((tag) => tag.id === id);
    if (!current) return null;
    const updated = await invoke<BridgeTag | null>("material_catalog_update_tag", {
      id,
      patch: { name: trimmed },
    });
    return updated;
  }
  const updatedAt = new Date().toISOString();
  const all = fallbackTags();
  if (all.some((tag) => tag.id !== id && tag.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new Error("标签名已存在");
  }
  const tag = all.find((candidate) => candidate.id === id);
  if (!tag) return null;
  tag.name = trimmed;
  tag.updatedAt = updatedAt;
  saveFallbackTags(all);
  return tag;
}

async function updateTag(id: string, patch: UpdateTagInput): Promise<BridgeTag | null> {
  if (isTauri()) {
    const current = (await listTags()).find((tag) => tag.id === id);
    if (!current) return null;
    const updated = await invoke<BridgeTag | null>("material_catalog_update_tag", { id, patch });
    return updated;
  }
  const updatedAt = new Date().toISOString();
  const all = fallbackTags();
  const tag = all.find((candidate) => candidate.id === id);
  if (!tag) return null;
  const nextName = patch.name === undefined ? tag.name : patch.name.trim();
  if (!nextName) return null;
  if (all.some((candidate) => candidate.id !== id && candidate.name.toLowerCase() === nextName.toLowerCase())) {
    throw new Error("标签名已存在");
  }
  tag.name = nextName;
  tag.color = patch.color === undefined ? tag.color : (patch.color || null);
  tag.updatedAt = updatedAt;
  saveFallbackTags(all);
  return tag;
}

async function mergeTags(targetId: string, sourceIds: string[]): Promise<void> {
  const sources = Array.from(new Set(sourceIds.filter((id) => id && id !== targetId)));
  if (!targetId || sources.length === 0) return;
  if (isTauri()) {
    await invoke<{ targetName: string; sourceNames: string[] }>("material_catalog_merge_tags", {
      targetId,
      sourceIds: sources,
    });
    return;
  }
  const allTags = fallbackTags();
  const targetTag = allTags.find((tag) => tag.id === targetId);
  if (!targetTag) return;
  const tagIds = new Set(allTags.map((tag) => tag.id));
  const sourceSet = new Set(sources.filter((id) => tagIds.has(id)));
  const assetMap = fallbackAssetTagMap();
  Object.keys(assetMap).forEach((itemId) => {
    const current = assetMap[itemId] || [];
    const hasSource = current.some((tagId) => sourceSet.has(tagId));
    const next = current.filter((tagId) => !sourceSet.has(tagId));
    if (hasSource && !next.includes(targetId)) next.push(targetId);
    if (next.length) assetMap[itemId] = next;
    else delete assetMap[itemId];
  });
  saveFallbackAssetTagMap(assetMap);
  saveFallbackTags(allTags.filter((tag) => !sourceSet.has(tag.id)));
}

async function deleteTag(id: string): Promise<void> {
  if (isTauri()) {
    await invoke<boolean>("material_catalog_delete_tag", { id });
    return;
  }
  saveFallbackTags(fallbackTags().filter((tag) => tag.id !== id));
  const assetMap = fallbackAssetTagMap();
  Object.keys(assetMap).forEach((itemId) => {
    assetMap[itemId] = assetMap[itemId].filter((tagId) => tagId !== id);
    if (assetMap[itemId].length === 0) delete assetMap[itemId];
  });
  saveFallbackAssetTagMap(assetMap);
}

async function setItemTags(itemType: "asset", itemId: string, tagIds: string[]): Promise<string[]> {
  if (isTauri()) {
    return invoke<string[]>("material_catalog_set_asset_tags", { id: itemId, tagIds });
  }
  // 校验 tag 存在
  const db = await getDb();
  if (!db) {
    const all = fallbackTags();
    const validIds = new Set(all.map((t) => t.id));
    const filtered = Array.from(new Set(tagIds.filter((id) => validIds.has(id))));
    const map = fallbackAssetTagMap();
    if (filtered.length === 0) {
      delete map[itemId];
    } else {
      map[itemId] = filtered;
    }
    saveFallbackAssetTagMap(map);
    return filtered;
  }
  // Tauri SQLite: 先查存在的 tag
  const uniqueIds = Array.from(new Set(tagIds));
  if (uniqueIds.length === 0) {
    await db.execute(`delete from item_tag where item_type = $1 and item_id = $2`, [itemType, itemId]);
    await publishMaterialChange({ reason: "desktop-asset-tags", affectedIds: [itemId] });
    return [];
  }
  const placeholders = uniqueIds.map((_, i) => `$${i + 1}`).join(",");
  const existing = await db.select<Array<{ id: string }>>(
    `select id from tag where id in (${placeholders})`,
    uniqueIds,
  );
  const validIds = existing.map((r) => r.id);
  // 替换：删旧 + 插新
  await db.execute(`delete from item_tag where item_type = $1 and item_id = $2`, [itemType, itemId]);
  const now = new Date().toISOString();
  for (const tagId of validIds) {
    await db.execute(
      `insert into item_tag (id, item_type, item_id, tag_id, created_at) values ($1, $2, $3, $4, $5)`,
      [createId("itemtag"), itemType, itemId, tagId, now],
    );
  }
  await publishMaterialChange({ reason: "desktop-asset-tags", affectedIds: [itemId] });
  return validIds;
}

async function setAssetTags(assetId: string, tagIds: string[]): Promise<string[]> {
  return setItemTags("asset", assetId, tagIds);
}

async function getItemTags(itemType: "asset", itemId: string): Promise<string[]> {
  if (isTauri()) {
    return invoke<string[]>("material_catalog_get_asset_tags", { id: itemId });
  }
  const db = await getDb();
  if (!db) {
    const map = fallbackAssetTagMap();
    return map[itemId] || [];
  }
  const rows = await db.select<Array<{ tag_id: string }>>(
    `select tag_id from item_tag where item_type = $1 and item_id = $2 order by created_at`,
    [itemType, itemId],
  );
  return rows.map((r) => r.tag_id);
}

async function getAssetTags(assetId: string): Promise<string[]> {
  return getItemTags("asset", assetId);
}

async function listItemTagMap(itemType: "asset", itemIds?: string[]): Promise<Record<string, string[]>> {
  const ids = Array.isArray(itemIds) ? Array.from(new Set(itemIds.filter(Boolean))) : null;
  if (ids && ids.length === 0) return {};
  if (isTauri()) {
    return invoke<Record<string, string[]>>("material_catalog_list_asset_tag_map", { ids });
  }
  const db = await getDb();
  if (!db) {
    const source = fallbackAssetTagMap();
    const entries = ids ? ids.map((id) => [id, source[id] || []] as const) : Object.entries(source);
    return Object.fromEntries(entries.map(([id, tagIds]) => [id, Array.isArray(tagIds) ? tagIds : []]));
  }
  const params: unknown[] = [itemType];
  let where = "where item_type = $1";
  if (ids) {
    const placeholders = ids.map((_, index) => `$${index + 2}`).join(",");
    where += ` and item_id in (${placeholders})`;
    params.push(...ids);
  }
  const rows = await db.select<Array<{ item_id: string; tag_id: string }>>(
    `select item_id, tag_id from item_tag ${where} order by item_id, created_at`,
    params,
  );
  const map: Record<string, string[]> = {};
  if (ids) {
    for (const id of ids) map[id] = [];
  }
  for (const row of rows) {
    if (!map[row.item_id]) map[row.item_id] = [];
    map[row.item_id].push(row.tag_id);
  }
  return map;
}

// ===== SEARCH BRIDGE =====


function escapeFtsQuery(q: string): string {
  // FTS5 查询语法：每个词加 "*" 后缀做前缀匹配；引号转义
  return q.trim()
    .replace(/"/g, '""')
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"*`)
    .join(" ");
}


// D26: 全局搜索 — 查询 4 类来源（笔记/素材/收集箱/标签）
type GlobalSearchResults = {
  notes: Array<{ id: string; title: string; snippet: string; updatedAt: string; folderId: string | null }>;
  assets: Array<{ id: string; name: string; snippet: string; kind: string; sizeBytes: number | null; thumbnailUrl: string; updatedAt: string }>;
  collection: Array<{ id: string; content: string; snippet: string; type: string; source: string | null; processedAction: string | null; url: string | null; updatedAt: string }>;
  tags: Array<{ id: string; name: string; noteCount: number; updatedAt: string }>;
};

async function searchGlobal(query: string): Promise<GlobalSearchResults> {
  const trimmed = (query || "").trim();
  const limit = 50;
  const result: GlobalSearchResults = { notes: [], assets: [], collection: [], tags: [] };
  if (!trimmed) return result;

  const db = await getDb();
  if (!db) return result;

  const ftsQuery = escapeFtsQuery(trimmed);

  // 1. 知识文档（Markdown Vault）
  try {
    result.notes = await knowledgeLegacyBridgeAdapter.searchNotesForGlobal(trimmed, { limit });
  } catch (e) { console.warn("[luckyray] searchGlobal notes failed", e); }

  // 2. 素材
  try {
    const hits = await invoke<BridgeAssetSearchHit[]>("material_catalog_search_assets", { query: ftsQuery, limit });
    result.assets = hits.map((hit) => {
      const asset = normalizeAsset(hit.asset);
      return {
        id: asset.id,
        name: asset.name,
        snippet: hit.snippet || "",
        kind: asset.kind,
        sizeBytes: asset.sizeBytes,
        thumbnailUrl: asset.thumbnailUrl,
        updatedAt: asset.updatedAt,
      };
    });
  } catch (e) { console.warn("[luckyray] searchGlobal assets failed", e); }

  // 3. 收集箱（FTS5 + LIKE fallback）
  try {
    const colRows = await db.select<Array<{ id: string; content: string; snippet: string; type: string; source: string | null; processed_action: string | null; url_metadata: string | null; created_at: string }>>(
      `select ci.id, ci.content, snippet(cis, 1, '<b>', '</b>', '...', 32) as snippet, ci.type, ci.source, ci.processed_action, ci.url_metadata, ci.created_at
       from collection_item_search cis join collection_item ci on ci.rowid = cis.rowid
       where collection_item_search match ? and (ci.processed_action is null or ci.processed_action != 'deleted')
       order by rank, ci.created_at desc
       limit ?`,
      [ftsQuery, limit],
    );
    result.collection = colRows.map(r => {
      let url: string | null = null;
      try { url = r.url_metadata ? JSON.parse(r.url_metadata).url : null; } catch (_) {}
      return { id: r.id, content: r.content, snippet: r.snippet || "", type: r.type, source: r.source, processedAction: r.processed_action, url, updatedAt: r.created_at };
    });
  } catch (e) {
    // FTS5 失败时 fallback 到 LIKE 搜索
    console.warn("[luckyray] searchGlobal FTS5 collection failed, fallback to LIKE", e);
    try {
      const likeRows = await db.select<Array<{ id: string; content: string; type: string; source: string | null; processed_action: string | null; url_metadata: string | null; created_at: string }>>(
        `select id, content, type, source, processed_action, url_metadata, created_at
         from collection_item
         where (content like ? or url_metadata like ?) and (processed_action is null or processed_action != 'deleted')
         order by created_at desc
         limit ?`,
        [`%${trimmed}%`, `%${trimmed}%`, limit],
      );
      result.collection = likeRows.map(r => {
        let url: string | null = null;
        try { url = r.url_metadata ? JSON.parse(r.url_metadata).url : null; } catch (_) {}
        return { id: r.id, content: r.content, snippet: "", type: r.type, source: r.source, processedAction: r.processed_action, url, updatedAt: r.created_at };
      });
    } catch (e2) { console.warn("[luckyray] searchGlobal collection LIKE fallback also failed", e2); }
  }

  // 4. 标签
  try {
    const q = trimmed.toLowerCase();
    result.tags = (await listTags())
      .filter((tag) => tag.name.toLowerCase().includes(q))
      .slice(0, 20)
      .map((tag) => ({ id: tag.id, name: tag.name, noteCount: tag.noteCount, updatedAt: tag.updatedAt }));
  } catch (e) { console.warn("[luckyray] searchGlobal tags failed", e); }

  return result;
}


// Narrow provider bridges keep the global-search coordinator from invoking
// unrelated sources merely to filter them out in the renderer.

async function searchCollectionBoxForGlobal(query: string, options?: { limit?: number }): Promise<GlobalSearchResults["collection"]> {
  const trimmed = (query || "").trim();
  const limit = options?.limit ?? 50;
  if (!trimmed) return [];

  const db = await getDb();
  if (!db) {
    const items = await collectionList().catch(() => []);
    const normalizedQuery = trimmed.toLowerCase();
    return items
      .filter((item) => {
        const metadata = item.urlMetadata || "";
        return `${item.content || ""}\n${metadata}`.toLowerCase().includes(normalizedQuery);
      })
      .slice(0, limit)
      .map((item) => {
        let url: string | null = null;
        try { url = item.urlMetadata ? JSON.parse(item.urlMetadata).url : null; } catch {}
        return {
          id: item.id,
          content: item.content || "",
          snippet: "",
          type: item.type,
          source: item.source || null,
          processedAction: item.processedAction || null,
          url,
          updatedAt: item.createdAt,
        };
      });
  }

  const ftsQuery = escapeFtsQuery(trimmed);
  const toResult = (row: { id: string; content: string; snippet: string; type: string; source: string | null; processed_action: string | null; url_metadata: string | null; created_at: string }) => {
    let url: string | null = null;
    try { url = row.url_metadata ? JSON.parse(row.url_metadata).url : null; } catch {}
    return {
      id: row.id,
      content: row.content,
      snippet: row.snippet || "",
      type: row.type,
      source: row.source,
      processedAction: row.processed_action,
      url,
      updatedAt: row.created_at,
    };
  };
  try {
    const rows = await db.select<Array<{ id: string; content: string; snippet: string; type: string; source: string | null; processed_action: string | null; url_metadata: string | null; created_at: string }>>(
      `select ci.id, ci.content, snippet(cis, 1, '<b>', '</b>', '...', 32) as snippet, ci.type, ci.source, ci.processed_action, ci.url_metadata, ci.created_at
       from collection_item_search cis join collection_item ci on ci.rowid = cis.rowid
       where collection_item_search match ? and (ci.processed_action is null or ci.processed_action != 'deleted')
       order by rank, ci.created_at desc
       limit ?`,
      [ftsQuery, limit],
    );
    return rows.map(toResult);
  } catch (error) {
    console.warn("[luckyray] scoped collection search FTS failed, falling back to LIKE", error);
    try {
      const rows = await db.select<Array<{ id: string; content: string; type: string; source: string | null; processed_action: string | null; url_metadata: string | null; created_at: string }>>(
        `select id, content, type, source, processed_action, url_metadata, created_at
         from collection_item
         where (content like ? or url_metadata like ?) and (processed_action is null or processed_action != 'deleted')
         order by created_at desc
         limit ?`,
        [`%${trimmed}%`, `%${trimmed}%`, limit],
      );
      return rows.map((row) => toResult({ ...row, snippet: "" }));
    } catch (fallbackError) {
      console.warn("[luckyray] scoped collection search LIKE fallback failed", fallbackError);
      return [];
    }
  }
}

// ===== SETTINGS BRIDGE =====

const DEFAULT_SETTINGS: BridgeSettings = {
  aiProvider: "deepseek",
  aiApiKey: "",
  aiBaseURL: "https://api.deepseek.com/v1",
  aiModel: "deepseek-chat",
  aiTemperature: 0.7,
  aiMaxTokens: 2048,
  aiImageApiKey: "",
  aiImageBaseURL: "https://apihub.agnes-ai.com/v1",
  aiImageModel: "agnes-image-2.1-flash",
  aiVideoModel: "agnes-video-v2.0",
  // 6.6 通用命名 - 与 ai* 字段保持同步, 设置页 slider 改完即存
  temperature: 0.7,
  maxTokens: 2048,
};

// 6.6 temperature / maxTokens 共享一个数值 (ai* 和通用命名, HTML 端读 ai*, 1.0.1+ 简化接口读通用名)
function readTemperature(row: Partial<BridgeSettings>): number {
  if (typeof row.temperature === "number") return row.temperature;
  if (typeof row.aiTemperature === "number") return row.aiTemperature;
  return DEFAULT_SETTINGS.aiTemperature;
}

function clampMaxTokens(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SETTINGS.aiMaxTokens!;
  return Math.max(256, Math.min(32768, Math.round(value)));
}

function readMaxTokens(row: Partial<BridgeSettings>): number {
  if (typeof row.maxTokens === "number") return clampMaxTokens(row.maxTokens);
  if (typeof row.aiMaxTokens === "number") return clampMaxTokens(row.aiMaxTokens);
  return DEFAULT_SETTINGS.aiMaxTokens;
}

function normalizeSettings(row: Partial<BridgeSettings>): BridgeSettings {
  const temperature = readTemperature(row);
  const maxTokens = readMaxTokens(row);
  return {
    aiProvider: row.aiProvider ?? DEFAULT_SETTINGS.aiProvider,
    aiApiKey: row.aiApiKey ?? "",
    aiBaseURL: row.aiBaseURL ?? DEFAULT_SETTINGS.aiBaseURL,
    aiModel: row.aiModel ?? DEFAULT_SETTINGS.aiModel,
    aiTemperature: temperature,
    aiMaxTokens: maxTokens,
    aiImageApiKey: row.aiImageApiKey ?? "",
    aiImageBaseURL: row.aiImageBaseURL ?? DEFAULT_SETTINGS.aiImageBaseURL,
    aiImageModel: row.aiImageModel ?? DEFAULT_SETTINGS.aiImageModel,
    aiVideoModel: row.aiVideoModel ?? DEFAULT_SETTINGS.aiVideoModel,
    temperature,
    maxTokens,
  };
}

function fallbackSettings(): BridgeSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(FALLBACK_SETTINGS_KEY) || "{}");
    return normalizeSettings(raw);
  } catch {
    return normalizeSettings({});
  }
}

function saveFallbackSettings(s: BridgeSettings) {
  localStorage.setItem(FALLBACK_SETTINGS_KEY, JSON.stringify(projectAiSettingsForFrontend(s)));
}

async function getStoredSettings(): Promise<BridgeSettings> {
  const db = await getDb();
  if (!db) return fallbackSettings();
  const rows = await db.select<Array<{ key: string; value: string | null }>>(
    `select key, value from settings where key in ('aiProvider','aiProtocol','aiApiKey','aiBaseURL','aiModel','aiImageApiKey','aiImageBaseURL','aiImageModel','aiVideoModel','temperature','aiTemperature','maxTokens','aiMaxTokens')`,
  );
  const map: Record<string, string> = {};
  for (const r of rows) {
    if (r.value !== null) map[r.key] = r.value;
  }
  // 解析字符串字段
  const result: Partial<BridgeSettings> = {};
  if (map.aiProvider !== undefined) result.aiProvider = map.aiProvider;
  if (map.aiApiKey !== undefined) result.aiApiKey = map.aiApiKey;
  if (map.aiBaseURL !== undefined) result.aiBaseURL = map.aiBaseURL;
  if (map.aiModel !== undefined) result.aiModel = map.aiModel;
  if (map.aiImageApiKey !== undefined) result.aiImageApiKey = map.aiImageApiKey;
  if (map.aiImageBaseURL !== undefined) result.aiImageBaseURL = map.aiImageBaseURL;
  if (map.aiImageModel !== undefined) result.aiImageModel = map.aiImageModel;
  if (map.aiVideoModel !== undefined) result.aiVideoModel = map.aiVideoModel;
  // 6.6 优先读通用命名, 兜底读 ai* 旧命名
  if (map.temperature !== undefined) result.temperature = parseFloat(map.temperature) || DEFAULT_SETTINGS.temperature!;
  if (map.aiTemperature !== undefined && result.temperature === undefined) result.aiTemperature = parseFloat(map.aiTemperature) || DEFAULT_SETTINGS.aiTemperature;
  if (map.maxTokens !== undefined) result.maxTokens = parseInt(map.maxTokens, 10) || DEFAULT_SETTINGS.maxTokens!;
  if (map.aiMaxTokens !== undefined && result.maxTokens === undefined) result.aiMaxTokens = parseInt(map.aiMaxTokens, 10) || DEFAULT_SETTINGS.aiMaxTokens;
  return normalizeSettings(result);
}

async function getSettings(): Promise<BridgeSettings> {
  return projectAiSettingsForFrontend(await getStoredSettings());
}

async function setSettings(patch: Partial<BridgeSettings>): Promise<BridgeSettings> {
  const current = await getStoredSettings();
  const next: BridgeSettings = {
    ...current,
    ...patch,
    aiApiKey: patch.aiApiKey === undefined || patch.aiApiKey === null
      ? current.aiApiKey
      : patch.aiApiKey,
    aiImageApiKey: patch.aiImageApiKey === undefined || patch.aiImageApiKey === null
      ? current.aiImageApiKey
      : patch.aiImageApiKey,
  };
  // 6.6 同步通用命名 <-> ai* 命名, 两边写一致
  next.aiTemperature = readTemperature(next);
  next.aiMaxTokens = readMaxTokens(next);
  next.temperature = next.aiTemperature;
  next.maxTokens = next.aiMaxTokens;
  const db = await getDb();
  if (!db) {
    saveFallbackSettings(next);
    return projectAiSettingsForFrontend(next);
  }
  // 6.6 双写: ai* 老键 + 通用键, 都持久化, 互为兜底
  const pairs: Array<[string, string]> = [
    ["aiProvider", next.aiProvider ?? ""],
    ["aiApiKey", next.aiApiKey ?? ""],
    ["aiBaseURL", next.aiBaseURL ?? ""],
    ["aiModel", next.aiModel ?? ""],
    ["aiImageApiKey", next.aiImageApiKey ?? ""],
    ["aiImageBaseURL", next.aiImageBaseURL ?? ""],
    ["aiImageModel", next.aiImageModel ?? ""],
    ["aiVideoModel", next.aiVideoModel ?? ""],
    ["aiTemperature", String(next.aiTemperature)],
    ["aiMaxTokens", String(next.aiMaxTokens)],
    ["temperature", String(next.temperature)],
    ["maxTokens", String(next.maxTokens)],
  ];
  for (const [k, v] of pairs) {
    await db.execute(
      `insert into settings (key, value) values ($1, $2)
       on conflict(key) do update set value = excluded.value`,
      [k, v],
    );
  }
  return projectAiSettingsForFrontend(next);
}

// ===== AI CONVERSATION BRIDGE =====

function fallbackAiConversations(): BridgeAiConversation[] {
  try {
    const raw = JSON.parse(localStorage.getItem(FALLBACK_AI_CONV_KEY) || "[]");
    return raw.map((c: any) => ({
      id: c.id,
      title: c.title || "新对话",
      createdAt: c.createdAt || new Date().toISOString(),
      updatedAt: c.updatedAt || c.createdAt || new Date().toISOString(),
    }));
  } catch {
    return [];
  }
}

function saveFallbackAiConversations(convs: BridgeAiConversation[]) {
  localStorage.setItem(FALLBACK_AI_CONV_KEY, JSON.stringify(convs));
}

function fallbackAiMessages(): Record<string, BridgeAiMessage[]> {
  try {
    return JSON.parse(localStorage.getItem(FALLBACK_AI_MSG_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveFallbackAiMessages(map: Record<string, BridgeAiMessage[]>) {
  localStorage.setItem(FALLBACK_AI_MSG_KEY, JSON.stringify(map));
}

function normalizeAiConv(row: Partial<BridgeAiConversation>): BridgeAiConversation {
  const now = new Date().toISOString();
  const createdAt = row.createdAt || now;
  return {
    id: row.id || createId("conv"),
    title: row.title || "新对话",
    createdAt,
    updatedAt: row.updatedAt || createdAt,
  };
}

function normalizeAiMsg(
  row: Partial<BridgeAiMessage>,
  allowBackendActionTruth = false,
): BridgeAiMessage {
  return {
    id: row.id || createId("msg"),
    conversationId: row.conversationId || "",
    role: row.role || "user",
    content: row.content || "",
    createdAt: row.createdAt || new Date().toISOString(),
    actionTruth: allowBackendActionTruth ? row.actionTruth ?? null : null,
  };
}

async function listAiConversations(): Promise<BridgeAiConversation[]> {
  const db = await getDb();
  if (!db) {
    return fallbackAiConversations().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  const rows = await db.select<Array<{ id: string; title: string; created_at: string; updated_at: string }>>(
    `select id, title, created_at, updated_at from ai_conversation order by updated_at desc`,
  );
  return rows.map((r) => normalizeAiConv({
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

async function createAiConversation(title?: string): Promise<BridgeAiConversation> {
  const conv = normalizeAiConv({ title: title || "新对话" });
  const db = await getDb();
  if (!db) {
    const all = fallbackAiConversations();
    all.push(conv);
    saveFallbackAiConversations(all);
    return conv;
  }
  await db.execute(
    `insert into ai_conversation (id, title, created_at, updated_at) values ($1, $2, $3, $4)`,
    [conv.id, conv.title, conv.createdAt, conv.updatedAt],
  );
  return conv;
}

async function deleteAiConversation(id: string): Promise<void> {
  if (isTauri()) {
    await invoke("delete_ai_conversation", { conversationId: id });
    return;
  }
  const db = await getDb();
  if (!db) {
    const all = fallbackAiConversations().filter((c) => c.id !== id);
    saveFallbackAiConversations(all);
    const msgs = fallbackAiMessages();
    delete msgs[id];
    saveFallbackAiMessages(msgs);
    return;
  }
  await db.execute(`delete from ai_message where conversation_id = $1`, [id]);
  await db.execute(`delete from ai_conversation where id = $1`, [id]);
}

async function getAiMessages(conversationId: string): Promise<BridgeAiMessage[]> {
  if (isTauri()) {
    const rows = await invoke<BridgeAiMessage[]>("agent_conversation_messages", { conversationId });
    return (Array.isArray(rows) ? rows : []).map((row) => normalizeAiMsg(row, true));
  }
  const map = fallbackAiMessages();
  return (map[conversationId] || []).map((row) => normalizeAiMsg(row));
}

async function appendAiMessage(conversationId: string, role: "user" | "assistant" | "system", content: string): Promise<BridgeAiMessage> {
  const msg = normalizeAiMsg({ conversationId, role, content });
  const now = new Date().toISOString();
  const db = await getDb();
  if (!db) {
    const map = fallbackAiMessages();
    if (!map[conversationId]) map[conversationId] = [];
    map[conversationId].push(msg);
    saveFallbackAiMessages(map);
    // 更新 conv.updatedAt
    const all = fallbackAiConversations();
    const c = all.find(x => x.id === conversationId);
    if (c) {
      c.updatedAt = now;
      saveFallbackAiConversations(all);
    }
    return msg;
  }
  await db.execute(
    `insert into ai_message (id, conversation_id, role, content, created_at) values ($1, $2, $3, $4, $5)`,
    [msg.id, msg.conversationId, msg.role, msg.content, msg.createdAt],
  );
  await db.execute(`update ai_conversation set updated_at = $1 where id = $2`, [now, conversationId]);
  return msg;
}

async function appendAiConversationPair(
  conversationId: string,
  userContent: string,
  assistantContent: string,
): Promise<[BridgeAiMessage, BridgeAiMessage]> {
  const user = normalizeAiMsg({ conversationId, role: "user", content: userContent });
  const assistant = normalizeAiMsg({ conversationId, role: "assistant", content: assistantContent });
  const now = new Date().toISOString();
  const db = await getDb();
  if (!db) {
    const map = fallbackAiMessages();
    if (!map[conversationId]) map[conversationId] = [];
    map[conversationId].push(user, assistant);
    saveFallbackAiMessages(map);
    const all = fallbackAiConversations();
    const conversation = all.find((item) => item.id === conversationId);
    if (conversation) {
      conversation.updatedAt = now;
      saveFallbackAiConversations(all);
    }
    return [user, assistant];
  }
  await db.execute(
    `insert into ai_message (id, conversation_id, role, content, created_at)
     values ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)`,
    [
      user.id, user.conversationId, user.role, user.content, user.createdAt,
      assistant.id, assistant.conversationId, assistant.role, assistant.content, assistant.createdAt,
    ],
  );
  await db.execute(`update ai_conversation set updated_at = $1 where id = $2`, [now, conversationId]);
  return [user, assistant];
}

async function updateAiConversationTitle(id: string, title: string): Promise<BridgeAiConversation | null> {
  const trimmed = title.trim();
  if (!trimmed) return null;
  const now = new Date().toISOString();
  const db = await getDb();
  if (!db) {
    const all = fallbackAiConversations();
    const c = all.find(x => x.id === id);
    if (!c) return null;
    c.title = trimmed;
    c.updatedAt = now;
    saveFallbackAiConversations(all);
    return c;
  }
  const result = await db.execute(`update ai_conversation set title = $1, updated_at = $2 where id = $3`, [trimmed, now, id]);
  if (!result.rowsAffected) return null;
  const rows = await db.select<Array<{ id: string; title: string; created_at: string; updated_at: string }>>(
    `select id, title, created_at, updated_at from ai_conversation where id = $1`,
    [id],
  );
  return rows[0] ? normalizeAiConv(rows[0]) : null;
}

// ===== D65 正式画布 MVP：文件存储 bridge =====
// 调用 Tauri 命令，错误透传。canvasId 由后端校验 ASCII 字母数字下划线连字符。
async function getCanvasStorageDir(): Promise<string> {
  if (!isTauri()) return "";
  try {
    return await invoke<string>("get_canvas_storage_dir");
  } catch (e) {
    console.warn("[luckyray] getCanvasStorageDir failed", e);
    throw e;
  }
}

async function checkCanvasFiles(): Promise<BridgeCanvasStorageCheck> {
  if (!isTauri()) {
    return { ok: true, storageDir: "", canvasCount: 0, checkedFiles: 0, issues: [] };
  }
  const raw = await invoke<{
    ok: boolean;
    storage_dir: string;
    canvas_count: number;
    checked_files: number;
    issues: string[];
  }>("check_canvas_files");
  return {
    ok: raw.ok,
    storageDir: raw.storage_dir,
    canvasCount: raw.canvas_count,
    checkedFiles: raw.checked_files,
    issues: Array.isArray(raw.issues) ? raw.issues : [],
  };
}

async function listCanvases(): Promise<BridgeCanvasListEntry[]> {
  if (!isTauri()) return [];
  try {
    const raw = await invoke<RawBridgeCanvasListEntry[]>("list_canvases");
    return raw.map(normalizeCanvasListEntry);
  } catch (e) {
    console.warn("[luckyray] listCanvases failed", e);
    throw e;
  }
}

async function loadCanvas(canvasId: string): Promise<BridgeCanvasFile> {
  if (!isTauri()) {
    return {
      schemaVersion: 1,
      revision: 0,
      contentDigest: "",
      canvasId,
      name: "默认画布",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      generationHistory: [],
    };
  }
  const raw = await invoke<{
    schema_version: number;
    canvas_id: string;
    name: string;
    created_at: string;
    updated_at: string;
    nodes: unknown;
    edges: unknown;
    viewport: { x: number; y: number; zoom: number };
    generation_history?: unknown;
    revision?: number;
    content_digest?: string;
  }>("load_canvas", { canvasId });
  canvasIdentityCache.set(raw.canvas_id, {
    revision: raw.revision ?? 0,
    contentDigest: raw.content_digest ?? "",
  });
  return {
    schemaVersion: raw.schema_version,
    canvasId: raw.canvas_id,
    name: raw.name,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    nodes: raw.nodes,
    edges: raw.edges,
    viewport: raw.viewport,
    generationHistory: raw.generation_history ?? [],
    revision: raw.revision ?? 0,
    contentDigest: raw.content_digest ?? "",
  };
}

async function saveCanvas(canvas: BridgeCanvasFile): Promise<BridgeCanvasListEntry> {
  const identity = canvasIdentityCache.get(canvas.canvasId);
  const entry = await invoke<RawBridgeCanvasListEntry>("save_canvas", {
    canvas: {
      schema_version: canvas.schemaVersion ?? 1,
      canvas_id: canvas.canvasId,
      name: canvas.name,
      created_at: canvas.createdAt,
      updated_at: canvas.updatedAt,
      nodes: canvas.nodes,
      edges: canvas.edges,
      viewport: canvas.viewport,
      generation_history: canvas.generationHistory ?? [],
      revision: canvas.revision ?? identity?.revision ?? 0,
      content_digest: canvas.contentDigest ?? identity?.contentDigest ?? "",
    },
  });
  return normalizeCanvasListEntry(entry);
}

async function createCanvas(name?: string): Promise<BridgeCanvasListEntry> {
  const result = await invoke<{ canvas: RawBridgeCanvasListEntry }>("create_canvas", { name: name || null });
  const c = result.canvas;
  return normalizeCanvasListEntry(c);
}

async function renameCanvas(canvasId: string, name: string): Promise<BridgeCanvasListEntry | null> {
  const identity = canvasIdentityCache.get(canvasId);
  if (!identity) throw new Error("canvas-revision-conflict");
  const entry = await invoke<RawBridgeCanvasListEntry | null>("rename_canvas", {
    canvasId,
    name,
    expectedRevision: identity.revision,
    expectedDigest: identity.contentDigest,
  });
  if (!entry) return null;
  return normalizeCanvasListEntry(entry);
}

async function deleteCanvas(canvasId: string): Promise<void> {
  const identity = canvasIdentityCache.get(canvasId);
  if (!identity) throw new Error("canvas-revision-conflict");
  await invoke<void>("delete_canvas", {
    canvasId,
    expectedRevision: identity.revision,
    expectedDigest: identity.contentDigest,
  });
  canvasIdentityCache.delete(canvasId);
}

async function saveCanvasThumbnail(canvasId: string, data: Uint8Array): Promise<void> {
  await invoke<void>("save_canvas_thumbnail", { canvasId, data: Array.from(data) });
}

async function deleteCanvasThumbnail(canvasId: string): Promise<void> {
  await invoke<void>("delete_canvas_thumbnail", { canvasId });
}

async function listFavoriteItems(itemType: FavoriteItemType): Promise<FavoriteItem[]> {
  return invoke<FavoriteItem[]>("favorite_items_list", { itemType });
}

async function getFavoriteItemCounts(): Promise<FavoriteItemCounts> {
  return invoke<FavoriteItemCounts>("favorite_item_counts");
}

async function addFavoriteItem(itemType: FavoriteItemType, itemId: string): Promise<FavoriteItem> {
  return invoke<FavoriteItem>("favorite_item_add", { itemType, itemId });
}

async function updateFavoriteItem(
  itemType: FavoriteItemType,
  itemId: string,
  theme: string,
  copy: string,
): Promise<FavoriteItem> {
  return invoke<FavoriteItem>("favorite_item_update", { itemType, itemId, theme, copy });
}

async function removeFavoriteItem(itemType: FavoriteItemType, itemId: string): Promise<FavoriteRemoval> {
  return invoke<FavoriteRemoval>("favorite_item_remove", { itemType, itemId });
}

async function listSmartFolders(): Promise<SmartFolderDefinition[]> {
  return invoke<SmartFolderDefinition[]>("smart_folder_list");
}

async function createSmartFolder(input: SmartFolderDefinitionInput): Promise<SmartFolderDefinition> {
  return invoke<SmartFolderDefinition>("smart_folder_create", { input });
}

async function updateSmartFolder(
  id: string,
  input: SmartFolderDefinitionInput,
): Promise<SmartFolderDefinition> {
  return invoke<SmartFolderDefinition>("smart_folder_update", { id, input });
}

async function deleteSmartFolder(id: string): Promise<boolean> {
  return invoke<boolean>("smart_folder_delete", { id });
}

// D65-R1: 把 bridge 组装抽出为可复用函数。
// 同一份 bridge 逻辑被 App.tsx（iframe 路由）和 main.tsx（#canvas-main 独立路由）共用。
export function buildLuckyRayBridge(): LuckyRayBridge {
  const knowledgeBridge = createDefaultKnowledgeLegacyBridgeAdapter({ listAssets });
  const materialFolderIds = new Set<string>();
  const rememberMaterialFolders = (folders: BridgeFolderNode[]) => {
    const visit = (folder: BridgeFolderNode) => {
      materialFolderIds.add(folder.id);
      folder.children.forEach(visit);
    };
    folders.forEach(visit);
    return folders;
  };
  const requireMaterialFolder = (id: string | null) => {
    if (id && !materialFolderIds.has(id)) {
      throw new Error("legacy-db-note-retired: Legacy database note folders are retired");
    }
  };
  const bridge: LuckyRayBridge = {
    importAssets,
    importDroppedFiles,
    listAssets,
    getAssetsByIds,
    getMaterialChangeState,
    updateAsset,
    selectAssetFile,
    relocateAsset,
    renameAssetFile,
    deleteAsset,
    revealAssetPath,
    openFilePath,
    openNotesVaultMarkdownFileWithDefaultApp,
    notesVaultAssetExists,
    notesVaultFindAssetCandidates,
    openExternalUrl,
    getAssetPreviewUrl,
    listFolders: async (scope) => scope === "notes"
      ? knowledgeBridge.listNoteFolders() as Promise<BridgeFolderNode[]>
      : rememberMaterialFolders(await listFolders("materials")),
    createFolder: async (input) => {
      if (input.scope === "notes") {
        throw new Error("knowledge-folder-operation-unavailable: Create folders from the Vault file tree");
      }
      requireMaterialFolder(input.parentId);
      const folder = await createFolder(input);
      materialFolderIds.add(folder.id);
      return folder;
    },
    renameFolder: async (id, name) => {
      requireMaterialFolder(id);
      return renameFolder(id, name);
    },
    deleteFolder: async (id) => {
      requireMaterialFolder(id);
      await deleteFolder(id);
      materialFolderIds.delete(id);
    },
    moveFolder: async (input) => {
      requireMaterialFolder(input.id);
      requireMaterialFolder(input.targetId);
      return moveFolder(input);
    },
    moveAssetToFolder,
    moveNoteToFolder: knowledgeBridge.moveNoteToFolder,
    listTags,
    listKnowledgeTags: knowledgeBridge.listKnowledgeTags,
    createKnowledgeTag: knowledgeBridge.createKnowledgeTag,
    createTag,
    renameTag,
    updateTag,
    mergeTags,
    deleteTag,
    setAssetTags,
    setNoteTags: knowledgeBridge.setNoteTags,
    addKnowledgeTag: knowledgeBridge.addKnowledgeTag,
    removeKnowledgeTag: knowledgeBridge.removeKnowledgeTag,
    getAssetTags,
    getNoteTags: knowledgeBridge.getNoteTags,
    listItemTagMap: async (itemType, itemIds) => {
      if (itemType === "asset") return listItemTagMap(itemType, itemIds);
      const ids = itemIds || (await knowledgeBridge.listNotes()).map((note) => note.id);
      return Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await knowledgeBridge.getNoteTags(id)])));
    },
    listNotes: knowledgeBridge.listNotes,
    getNote: knowledgeBridge.getNote,
    getNoteById: knowledgeBridge.getNote,
    createNote: knowledgeBridge.createNote,
    importNotesMarkdown: async () => {
      throw new Error("legacy-db-note-retired: Legacy database note import is retired");
    },
    updateNote: knowledgeBridge.updateNote,
    deleteNote: knowledgeBridge.deleteNote,
    getNotesForAsset: knowledgeBridge.getNotesForAsset,
    getAssetsForNote: async (noteId) => knowledgeBridge.getAssetsForNote(noteId) as Promise<BridgeAsset[]>,
    getNoteLinks: knowledgeBridge.getNoteLinks,
    getNoteEmbeds: knowledgeBridge.getNoteEmbeds,
    getGraphRelations: knowledgeBridge.getGraphRelations,
    getNotesLinkingToNote: knowledgeBridge.getNotesLinkingToNote,
    getUnlinkedNoteMentions: knowledgeBridge.getUnlinkedNoteMentions,
    search: async (query, options) => {
      const result = await searchGlobal(query);
      const limit = Math.max(1, Math.min(options?.limit || 50, 200));
      return {
        notes: result.notes.slice(0, limit),
        assets: result.assets.slice(0, limit).map((asset) => ({
          id: asset.id,
          name: asset.name,
          kind: asset.kind,
          folderId: null,
          thumbnailUrl: asset.thumbnailUrl,
          snippet: asset.snippet,
        })),
        tags: result.tags.slice(0, limit).map((tag) => ({
          id: tag.id,
          name: tag.name,
          assetCount: 0,
          noteCount: tag.noteCount,
        })),
      };
    },
    searchGlobal,
    searchNotesForGlobal: knowledgeBridge.searchNotesForGlobal,
    searchCollectionBoxForGlobal,
    getSettings,
    setSettings,
    aiChatComplete,
    notesInlineGenerate,
    notesInlineApply,
    notesInlineDiscard,
    notesInlineCancel,
    aiImageGenerate,
    aiVideoGenerate,
    saveCanvasGenerationToLibrary,
    listAiConversations,
    createAiConversation,
    deleteAiConversation,
    getAiMessages,
    appendAiMessage,
    appendAiConversationPair,
    updateAiConversationTitle,
    getAppDataDir,
    getCollectionServerBaseUrl,
    getLocalTransportClientConfig,
    openDirectory,
    selectVaultDirectory,
    getCurrentNotesVault,
    createNotesVault,
    openNotesVault,
    listNotesVaultFiles,
    getNotesVaultMarkdownIndex,
    createNotesVaultFolder,
    createNotesVaultMarkdownFile,
    readNotesVaultMarkdownFile,
    writeNotesVaultMarkdownFile,
    renameNotesVaultMarkdownFile,
    renameNotesVaultFolder,
    moveNotesVaultMarkdownFile,
    moveNotesVaultFolder,
    deleteNotesVaultMarkdownFile,
    deleteNotesVaultEmptyFolder,
    classifyDroppedPaths,
    importNotesVaultMarkdownFiles,
    importNotesVaultMarkdownFolder,
    exportNotesVaultMarkdownFile,
    exportNotesVaultMarkdownFolder,
    getAutoLaunchEnabled,
    setAutoLaunchEnabled,
    getStorageUsage,
    clearThumbnailCache,
    clearAllData,
    createBackup,
    listBackups,
    restoreBackup,
    exportNotesMarkdown,
    exportAssetsIndex,
    selectImportFolder,
    importFolder,
    scanMissingAssets,
    removeAssetRecord,
    listAssetsFiltered,
    collectionAddText,
    collectionAddLink,
    collectionAddClipboard,
    collectionList,
    collectionDelete,
    collectionMarkInsertedToNote,
    collectionMarkDeleted,
    collectionBatchUpdate,
    collectionRestore,
    collectionSingleToNote,
    collectionBatchToNote,
    importImageToAssets,
    collectionImportImageToAssets,
    collectionMarkMovedToAssets,
    generateAssetAiSuggestion: id => generateAssetAiSuggestion(id),
    generateNoteAiSuggestion,
    getAssetAiSuggestion: id => getAssetAiSuggestion(id),
    getNoteAiSuggestion,
    applyAiTags,
    dismissAiSuggestion,
    createMemoryView,
    updateMemoryView,
    deleteMemoryView,
    listMemoryViews,
    searchMemoryViews,
    // D65 正式画布 MVP
    getCanvasStorageDir,
    checkCanvasFiles,
    listCanvases,
    loadCanvas,
    saveCanvas,
    createCanvas,
    renameCanvas,
    deleteCanvas,
    saveCanvasThumbnail,
    deleteCanvasThumbnail,
    listFavoriteItems,
    getFavoriteItemCounts,
    addFavoriteItem,
    updateFavoriteItem,
    removeFavoriteItem,
    listSmartFolders,
    createSmartFolder,
    updateSmartFolder,
    deleteSmartFolder,
  };

  // 桥必须先于 DB 初始化完成暴露。否则 DB 迁移慢或失败时，
  // HTML 会停在静态演示态，导航与真实数据刷新都像"卡死"。
  (bridge as Record<string, unknown>).dbInitError = dbInitError;
  const previousGeneration = typeof window !== "undefined"
    ? (window as unknown as { __LUCKYRAY_BRIDGE_READINESS__?: { generation?: number } })
        .__LUCKYRAY_BRIDGE_READINESS__?.generation || 0
    : 0;
  const generation = Math.max(bridgeReadinessGeneration, previousGeneration) + 1;
  bridgeReadinessGeneration = generation;
  publishBridgeReadiness(generation, false, null);
  void getDb().then(() => {
    (bridge as Record<string, unknown>).dbInitError = dbInitError;
    publishBridgeReadiness(generation, dbInitError === null, dbInitError);
  });
  return bridge;
}

function App() {
  const frameRef = useRef<HTMLIFrameElement>(null);

  const installBridge = useCallback(async () => {
    const bridge = buildLuckyRayBridge();

    window.__LUCKYRAY__ = bridge;
    window.__LUCKYRAY_MATERIAL_AI__ = (libraryId:string|null,vaultId?:string):MaterialLibraryAi => {
      const catalog=vaultId ? createMaterialVaultAttachmentAdapter(bridge as MaterialCatalogAdapter,vaultId) : libraryId ? createMaterialLibraryAdapter(bridge as MaterialCatalogAdapter,libraryId) : bridge as MaterialCatalogAdapter;
      return {getAssetAiSuggestion:id=>getAssetAiSuggestion(id,catalog),generateAssetAiSuggestion:id=>generateAssetAiSuggestion(id,catalog),dismissAssetAiSuggestion:id=>dismissAssetAiSuggestion(id,catalog),applyTags:(id,names)=>applyAssetAiTags(id,names,catalog)};
    };
    if (isTauri()) void materialLibrarySession.initialize().catch(error=>console.error("素材库初始化失败",error));
    window.dispatchEvent(new CustomEvent("luckyray:bridge-ready"));
    const frameWindow = frameRef.current?.contentWindow;
    if (frameWindow) {
      frameWindow.__LUCKYRAY__ = bridge;
      frameWindow.dispatchEvent(new CustomEvent("luckyray:bridge-ready"));
    }

    getDb()
      .then(() => {
        (bridge as Record<string, unknown>).dbInitError = dbInitError;
        window.dispatchEvent(new CustomEvent("luckyray:bridge-ready"));
        const latestFrameWindow = frameRef.current?.contentWindow;
        if (latestFrameWindow) {
          latestFrameWindow.__LUCKYRAY__ = bridge;
          latestFrameWindow.dispatchEvent(new CustomEvent("luckyray:bridge-ready"));
        }
      })
      .catch((error) => {
        dbInitError = error instanceof Error ? error.message : String(error);
        (bridge as Record<string, unknown>).dbInitError = dbInitError;
      });

  }, []);

  return (
    <iframe
      ref={frameRef}
      className="luckyray-prototype-frame"
      src="/luckyray-ui.html"
      title="luckyray"
      onLoad={installBridge}
    />
  );
}

export default App;
