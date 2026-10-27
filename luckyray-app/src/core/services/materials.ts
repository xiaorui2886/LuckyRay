import { adaptMaterialAssetMedia } from "./materialAssetAdapter";
import { invoke as invokeTauriCommand } from "@tauri-apps/api/core";
import { getLuckyRayBridgeSync } from "../bridge/luckyRayBridge";
import type { LuckyRayBridge } from "../bridge/luckyRayBridge";
import type {
  MaterialAsset,
  MaterialAssetFilter,
  MaterialCatalogAdapter,
  MaterialFolderImportResult,
  MaterialFolderImportOptions,
  MaterialFolder,
  MaterialImportProgress,
  MaterialImportResult,
  MaterialRelocateOptions,
  MaterialTag,
} from "./materialCatalog";
import { toLegacyMaterialBridgeFilter, toMaterialCatalogError } from "./materialCatalog";
import { createRealVaultLibraryAssetResolver } from "../markdown/realVaultEmbeds";
import {
  ensureActiveKnowledgeUiSource,
  knowledgeDocumentNoteId,
  type KnowledgeIndexSnapshot,
  type KnowledgeMutationResult,
} from "./knowledge";
import { flushCurrentNoteContextUpdates } from "./context";
import { knowledgeStore } from "./knowledgeStore";
import { readActiveKnowledgeSource, readActiveKnowledgeWriteSource } from "./knowledgeSource";
import { materialStore } from "./materialStore";
import { materialLibrarySession } from "./materialLibraryContext";
import { createMaterialLibraryAdapter, createMaterialVaultAttachmentAdapter } from "./materialLibraryAdapter";
import type { OpenInLightSeekLocalResource } from "./openInLightSeek";

export type { MaterialAsset, MaterialAssetFilter, MaterialFolder, MaterialTag } from "./materialCatalog";
export type MaterialAssetUpdate = Partial<Pick<MaterialAsset, "name" | "description" | "rating" | "dominantColor">>;
export type { MaterialFolderImportOptions, MaterialFolderImportResult, MaterialImportProgress, MaterialImportResult } from "./materialCatalog";
export type MaterialImportMode = "managed" | "linked" | "source";
export type MaterialLinkedNote = {
  id: string;
  title: string;
  updatedAt?: string | null;
  folderId?: string | null;
};
export type MaterialAiSuggestion = NonNullable<Awaited<ReturnType<LuckyRayBridge["getAssetAiSuggestion"]>>>;

export type MaterialMissingAsset = {
  id: string;
  name: string;
  libraryPath: string;
};

export async function listMaterialFolders(): Promise<MaterialFolder[]> {
  const folders = await requireBridge().listFolders("materials");
  return Array.isArray(folders) ? folders : [];
}

export async function getMaterialCatalogChange() {
  return requireBridge().getMaterialChangeState();
}

function requireBridge(libraryId = materialLibrarySession.getSnapshot().libraryId): MaterialCatalogAdapter {
  const bridge = getLuckyRayBridgeSync();
  if (!bridge) throw new Error("LuckyRay bridge is not ready");
  const id = libraryId;
  return id ? createMaterialLibraryAdapter(bridge as MaterialCatalogAdapter, id) : bridge as MaterialCatalogAdapter;
}

function attachmentBridge(vaultId?: string, libraryId = materialLibrarySession.getSnapshot().libraryId) {
  return vaultId ? createMaterialVaultAttachmentAdapter(requireBridge(null), vaultId) : requireBridge(libraryId);
}
function requireCoordinationBridge(): LuckyRayBridge {
  const bridge = getLuckyRayBridgeSync();
  if (!bridge) throw new Error("LuckyRay bridge is not ready");
  return bridge;
}

export async function listMaterialAssets(): Promise<MaterialAsset[]> {
  const bridge = requireBridge();
  const assets = await bridge.listAssets();
  return Array.isArray(assets) ? assets : [];
}

export async function getMaterialAssetsByIds(assetIds: string[]): Promise<MaterialAsset[]> {
  const assets = await requireBridge().getAssetsByIds(assetIds);
  return Array.isArray(assets) ? assets : [];
}

export async function listFilteredMaterialAssets(filters: MaterialAssetFilter, options?: { refreshAttachmentIndex?: boolean }): Promise<MaterialAsset[]> {
  if (filters.scope === "note-attachments") {
    const assets = await invokeTauriCommand<MaterialAsset[]>("material_catalog_list_note_attachments", { vaultId: filters.vaultId || null, includeUnreferenced: filters.includeUnreferenced === true, filter: toLegacyMaterialBridgeFilter(filters), refreshIndex: options?.refreshAttachmentIndex ?? true });
    return assets.map((asset) => adaptMaterialAssetMedia(asset));
  }
  const bridge = requireBridge();
  const assets = await bridge.listAssetsFiltered(toLegacyMaterialBridgeFilter(filters));
  return Array.isArray(assets) ? assets : [];
}

export type MaterialAttachmentDetails = { assetId: string; ordinary: boolean; absolutePath: string | null; referenceCount: number; references: { vaultId: string; notePath: string; target: string; absolutePath: string }[] };
export const getMaterialAttachmentDetails = (id: string) => invokeTauriCommand<MaterialAttachmentDetails>("material_catalog_attachment_details", { id });
export async function promoteMaterialAttachment(id: string, folderId: string | null = null): Promise<MaterialAsset> {
  return adaptMaterialAssetMedia(await invokeTauriCommand<MaterialAsset>("material_catalog_promote_note_attachment", { id, folderId }));
}

export async function importMaterialAssets(
  folderId?: string | null,
  options: {
    onProgress?: (progress: MaterialImportProgress) => void;
    paths?: string[];
    storageMode?: MaterialImportMode;
    managedLibraryDir?: string | null;
    libraryId?: string | null;
  } = {},
): Promise<MaterialImportResult> {
  const bridge = requireBridge(options.libraryId === undefined ? materialLibrarySession.getSnapshot().libraryId : options.libraryId);
  if (!bridge.importAssets) throw new Error("当前环境不支持导入素材");
  return bridge.importAssets({
    folderId: folderId ?? null,
    paths: options.paths,
    storageMode: options.storageMode,
    managedLibraryDir: options.managedLibraryDir ?? null,
    onProgress: options.onProgress,
  });
}

export async function importDroppedMaterialAssets(
  files: File[] | FileList,
  folderId?: string | null,
  options: { managedLibraryDir?: string | null; libraryId?: string | null } = {},
): Promise<MaterialImportResult> {
  const bridge = requireBridge(options.libraryId === undefined ? materialLibrarySession.getSnapshot().libraryId : options.libraryId);
  if (!bridge.importDroppedFiles) throw new Error("当前环境不支持拖入素材");
  return bridge.importDroppedFiles(files, {
    folderId: folderId ?? null,
    storageMode: "managed",
    managedLibraryDir: options.managedLibraryDir ?? null,
  });
}

export async function selectMaterialImportFolder(): Promise<string | null> {
  const bridge = requireBridge();
  if (!bridge.selectImportFolder) throw new Error("当前环境不支持选择导入文件夹");
  return bridge.selectImportFolder();
}

export async function importMaterialFolder(path: string, options?: MaterialFolderImportOptions, libraryId = materialLibrarySession.getSnapshot().libraryId): Promise<MaterialFolderImportResult> {
  const bridge = requireBridge(libraryId);
  if (!bridge.importFolder) throw new Error("当前环境不支持导入文件夹");
  return bridge.importFolder(path, options);
}

export async function importSelectedMaterialFolder(): Promise<MaterialFolderImportResult | null> {
  const bridge = requireBridge();
  const path = await selectMaterialImportFolder();
  if (!path) return null;
  if (!bridge.importFolder) throw new Error("当前环境不支持导入文件夹");
  return bridge.importFolder(path);
}

export async function updateMaterialAsset(assetId: string, patch: MaterialAssetUpdate, vaultId?: string, libraryId = materialLibrarySession.getSnapshot().libraryId): Promise<MaterialAsset | null> {
  const bridge = attachmentBridge(vaultId, libraryId);
  if (!bridge.updateAsset) throw new Error("当前环境不支持保存素材");
  return bridge.updateAsset(assetId, patch);
}

export async function renameMaterialAsset(assetId: string, name: string, vaultId?: string, libraryId = materialLibrarySession.getSnapshot().libraryId): Promise<MaterialAsset | null> {
  return updateMaterialAsset(assetId, { name }, vaultId, libraryId);
}

export async function renameMaterialAssetFile(assetId: string, fileName: string, vaultId?: string, libraryId = materialLibrarySession.getSnapshot().libraryId): Promise<MaterialAsset | null> {
  const bridge = attachmentBridge(vaultId, libraryId);
  if (!bridge.renameAssetFile) throw new Error("当前环境不支持重命名真实文件");
  return bridge.renameAssetFile(assetId, fileName);
}

export async function selectMaterialRelocationPath(): Promise<string | null> {
  const bridge = requireBridge();
  if (!bridge.selectAssetFile) throw new Error("当前环境不支持选择素材文件");
  return bridge.selectAssetFile();
}

export async function relocateMaterialAsset(
  assetId: string,
  path: string,
  options?: MaterialRelocateOptions,
  vaultId?: string,
  libraryId = materialLibrarySession.getSnapshot().libraryId,
): Promise<MaterialAsset | null> {
  const bridge = attachmentBridge(vaultId, libraryId);
  if (!bridge.relocateAsset) throw new Error("当前环境不支持重新定位素材");
  return bridge.relocateAsset(assetId, path, options);
}

export async function listMaterialTags(): Promise<MaterialTag[]> {
  const bridge = requireBridge();
  const tags = await bridge.listTags();
  return Array.isArray(tags) ? tags : [];
}

export async function createMaterialTag(name: string, vaultId?: string, libraryId = materialLibrarySession.getSnapshot().libraryId): Promise<MaterialTag> {
  const bridge = attachmentBridge(vaultId, libraryId);
  return bridge.createTag({ name });
}

export async function getMaterialAssetTagIds(assetId: string): Promise<string[]> {
  const bridge = requireBridge();
  const tagIds = await bridge.getAssetTags(assetId);
  return Array.isArray(tagIds) ? tagIds : [];
}

export async function getMaterialAssetTagContext(assetIds: string[], vaultId?: string, libraryId = materialLibrarySession.getSnapshot().libraryId): Promise<{ tags: MaterialTag[]; selectedTagIds: string[] }> {
  const bridge=attachmentBridge(vaultId, libraryId);
  const [tags, selectedTagIds] = await Promise.all([
    bridge.listTags(),
    assetIds.length === 1 ? bridge.getAssetTags(assetIds[0]) : Promise.resolve([]),
  ]);
  return { tags, selectedTagIds };
}

export async function setMaterialAssetTags(assetId: string, tagIds: string[], vaultId?: string, libraryId = materialLibrarySession.getSnapshot().libraryId): Promise<string[]> {
  const bridge = attachmentBridge(vaultId, libraryId);
  return bridge.setAssetTags(assetId, tagIds);
}

export async function applyMaterialAssetTags(assetIds: string[], tagIds: string[], vaultId?: string, libraryId = materialLibrarySession.getSnapshot().libraryId): Promise<PromiseSettledResult<string[]>[]> {
  const bridge = attachmentBridge(vaultId, libraryId);
  if (assetIds.length === 1) {
    return Promise.allSettled([bridge.setAssetTags(assetIds[0], tagIds)]);
  }
  return Promise.allSettled(assetIds.map(async (assetId) => {
    const currentTagIds = await bridge.getAssetTags(assetId);
    return bridge.setAssetTags(assetId, Array.from(new Set([...currentTagIds, ...tagIds])));
  }));
}

export async function moveMaterialAssetsToFolder(assetIds: string[], folderId: string | null, libraryId = materialLibrarySession.getSnapshot().libraryId): Promise<PromiseSettledResult<void>[]> {
  const bridge = requireBridge(libraryId);
  return Promise.allSettled(assetIds.map((assetId) => bridge.moveAssetToFolder({ assetId, folderId })));
}

export async function deleteMaterialAsset(assetId: string, options?: { deleteFile?: boolean }, vaultId?: string, libraryId = materialLibrarySession.getSnapshot().libraryId): Promise<void> {
  const bridge = attachmentBridge(vaultId, libraryId);
  await bridge.deleteAsset(assetId, options);
}

export async function deleteMaterialAssets(assetIds: string[], options?: { deleteFile?: boolean }): Promise<PromiseSettledResult<void>[]> {
  const bridge = requireBridge();
  return Promise.allSettled(assetIds.map((assetId) => bridge.deleteAsset(assetId, options)));
}

export async function performMaterialExternalActionWithTransport(
  assetId: string,
  action: "open" | "reveal",
  transport: (command: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<boolean> {
  await transport("material_catalog_shell_action", { request: { assetId, action } });
  return true;
}

export function performMaterialExternalAction(assetId: string, action: "open" | "reveal", libraryId = materialLibrarySession.getSnapshot().libraryId, vaultId?: string): Promise<boolean> {
  return performMaterialExternalActionWithTransport(assetId, action, nativeMaterialTransport(libraryId, vaultId));
}

export async function exportMaterialAssetFile(asset: { id?: string; libraryPath?: string | null; originalPath?: string | null; name?: string | null }, vaultId?: string, libraryId = materialLibrarySession.getSnapshot().libraryId): Promise<string> {
  const owner = vaultId ? null : libraryId;
  if (owner) {
    if (!asset.id) throw new Error("导出需要素材的库内身份");
    const { downloadDir } = await import("@tauri-apps/api/path");
    const plan = await libraryOperation<MaterialExportPlan>("exportPlan", { request: { kind: "assets", assetIds: [asset.id] } }, "material_export_plan", owner);
    rememberOwner(exportPlanOwners, plan.planId, owner);
    let task = await startMaterialExport(plan.planId, await downloadDir(), false, []);
    while (!["completed", "cancelled"].includes(task.phase)) { await new Promise(resolve => setTimeout(resolve, 100)); task = await getMaterialExportTask(task.taskId); }
    const output = task.items.find(item => item.state === "succeeded")?.outputPath;
    if (!output) throw new Error(task.items.find(item => item.error)?.error || "素材导出未完成");
    return output;
  }
  const sourcePath = asset.libraryPath || asset.originalPath || "";
  if (!sourcePath || sourcePath.startsWith("browser:")) throw new Error("这个素材没有可导出的本地路径。");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("export_asset_file", {
    sourcePath,
    filename: asset.name || "exported_asset",
    ...(vaultId ? { vaultId, assetId: asset.id } : {}),
  });
}

export type MaterialExportPlanRequest =
  | { kind: "assets"; assetIds: string[] }
  | { kind: "folder"; folderId: string | null };

export type MaterialExportPlan = {
  planId: string;
  total: number;
  scopeLabel: string;
  includesDescendants: boolean;
};

export type MaterialExportItem = {
  assetId: string;
  name: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  outputPath: string | null;
  error: string | null;
};

export type MaterialExportTask = {
  taskId: string;
  destination: string;
  preserveHierarchy: boolean;
  phase: "preparing" | "running" | "cancelling" | "completed" | "cancelled";
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  currentFile: string | null;
  currentBytes: number;
  currentTotalBytes: number;
  items: MaterialExportItem[];
};

type LibraryOwner = string | null;
const exportPlanOwners = new Map<string, LibraryOwner>();
const exportTaskOwners = new Map<string, LibraryOwner>();
const csvPlanOwners = new Map<string, LibraryOwner>();
const csvTaskOwners = new Map<string, LibraryOwner>();
function ownerOf(owners: Map<string, LibraryOwner>, id: string) { return owners.has(id) ? owners.get(id)! : null; }
function rememberOwner(owners: Map<string, LibraryOwner>, id: string, owner: LibraryOwner) { owners.set(id, owner); if (owners.size > 512) owners.delete(owners.keys().next().value!); }
function libraryOperation<T>(op: string, fields: Record<string, unknown>, legacyCommand: string, owner = materialLibrarySession.getSnapshot().libraryId): Promise<T> {
  return owner ? materialLibrarySession.request<T>({ op, ...fields }, owner) : invokeTauriCommand<T>(legacyCommand, fields);
}
function nativeMaterialTransport(libraryId = materialLibrarySession.getSnapshot().libraryId, vaultId?: string) {
  return (command: string, args: Record<string, unknown>) => invokeTauriCommand(command, vaultId ? { ...args, vaultId } : libraryId ? { ...args, libraryId } : args);
}
export async function listMaterialLibraryTasks(libraryId: string) {
  const result = await materialLibrarySession.request<{ exports: MaterialExportTask[]; csv: MaterialCsvExportTask[] }>({ op: "tasks" }, libraryId);
  result.exports.forEach(task => rememberOwner(exportTaskOwners, task.taskId, libraryId));
  result.csv.forEach(task => rememberOwner(csvTaskOwners, task.taskId, libraryId));
  return result;
}
export const planMaterialExport = async (request: MaterialExportPlanRequest, owner = materialLibrarySession.getSnapshot().libraryId) => {
  const plan = await libraryOperation<MaterialExportPlan>("exportPlan", { request }, "material_export_plan", owner);
  rememberOwner(exportPlanOwners, plan.planId, owner); return plan;
};

export const discardMaterialExportPlan = (planId: string) =>
  libraryOperation<void>("exportDiscard", { planId }, "material_export_discard_plan", ownerOf(exportPlanOwners, planId));

export async function chooseMaterialExportDirectory(): Promise<string | null> {
  const [{ open }, { downloadDir }] = await Promise.all([
    import("@tauri-apps/plugin-dialog"), import("@tauri-apps/api/path"),
  ]);
  const defaultPath = await downloadDir().catch(() => undefined);
  const selected = await open({ directory: true, multiple: false, defaultPath });
  return typeof selected === "string" && selected ? selected : null;
}

export const startMaterialExport = async (planId: string, destination: string, preserveHierarchy: boolean, watchRoots: string[]) => {
  const owner = ownerOf(exportPlanOwners, planId);
  const task = await libraryOperation<MaterialExportTask>("exportStart", { planId, destination, preserveHierarchy, watchRoots }, "material_export_start", owner);
  rememberOwner(exportTaskOwners, task.taskId, owner); return task;
};

export const getMaterialExportTask = (taskId: string) =>
  libraryOperation<MaterialExportTask>("exportStatus", { taskId }, "material_export_status", ownerOf(exportTaskOwners, taskId));

export const cancelMaterialExport = (taskId: string) =>
  libraryOperation<MaterialExportTask>("exportCancel", { taskId }, "material_export_cancel", ownerOf(exportTaskOwners, taskId));

export const openMaterialExportDestination = (taskId: string) =>
  invokeTauriCommand<void>("material_export_open_destination", { taskId, libraryId: ownerOf(exportTaskOwners, taskId) });

export type MaterialCsvExportPlanRequest =
  | { kind: "assets"; assetIds: string[] }
  | { kind: "folder"; folderId: string };
export type MaterialCsvExportPlan = {
  planId: string; total: number; scopeLabel: string; includesDescendants: boolean;
};
export type MaterialCsvExportTask = {
  taskId: string; phase: "preparing" | "running" | "cancelling" | "completed" | "cancelled" | "failed";
  total: number; completed: number; outputPath: string | null; destination: string; error: string | null;
};
export const planMaterialCsvExport = async (request: MaterialCsvExportPlanRequest, owner = materialLibrarySession.getSnapshot().libraryId) => {
  const plan = await libraryOperation<MaterialCsvExportPlan>("csvPlan", { request }, "material_csv_export_plan", owner);
  rememberOwner(csvPlanOwners, plan.planId, owner); return plan;
};
export const discardMaterialCsvExportPlan = (planId: string) =>
  libraryOperation<void>("csvDiscard", { planId }, "material_csv_export_discard_plan", ownerOf(csvPlanOwners, planId));
export async function chooseMaterialCsvDestination(): Promise<string | null> {
  const [{ save }, { downloadDir, join }] = await Promise.all([
    import("@tauri-apps/plugin-dialog"), import("@tauri-apps/api/path"),
  ]);
  const root = await downloadDir().catch(() => undefined);
  const defaultPath = root ? await join(root, "素材清单.csv") : "素材清单.csv";
  const selected = await save({ defaultPath, filters: [{ name: "CSV", extensions: ["csv"] }] });
  return typeof selected === "string" && selected ? selected : null;
}
export const startMaterialCsvExport = async (planId: string, destination: string, includeDescription: boolean, watchRoots: string[]) => {
  const owner = ownerOf(csvPlanOwners, planId);
  const task = await libraryOperation<MaterialCsvExportTask>("csvStart", { planId, destination, includeDescription, watchRoots }, "material_csv_export_start", owner);
  rememberOwner(csvTaskOwners, task.taskId, owner); return task;
};
export const getMaterialCsvExportTask = (taskId: string) =>
  libraryOperation<MaterialCsvExportTask>("csvStatus", { taskId }, "material_csv_export_status", ownerOf(csvTaskOwners, taskId));
export const cancelMaterialCsvExport = (taskId: string) =>
  libraryOperation<MaterialCsvExportTask>("csvCancel", { taskId }, "material_csv_export_cancel", ownerOf(csvTaskOwners, taskId));
export const retryMaterialCsvExport = async (taskId: string, watchRoots: string[]) => {
  const owner = ownerOf(csvTaskOwners, taskId);
  const task = await libraryOperation<MaterialCsvExportTask>("csvRetry", { taskId, watchRoots }, "material_csv_export_retry", owner);
  rememberOwner(csvTaskOwners, task.taskId, owner); return task;
};

export interface MaterialSourceInfo {
  kind: "web-resource" | "web-origin" | "recording" | "generated" | "unrecorded" | "local";
  origin?: string;
}

/** Mirrors the Rust-side source classification: only a well-formed http(s)
 * URL without embedded credentials counts as a web-resource origin; legacy
 * placeholders and local paths never pretend to be a web page. */
export function materialSourceInfo(asset: { originalPath?: string | null; storageMode?: string | null }): MaterialSourceInfo {
  const raw = asset.originalPath || "";
  if ([...raw].some((character) => /[\u0000-\u001f\u007f-\u009f]/u.test(character))) return { kind: "unrecorded" };
  if (raw.startsWith("recording://")) return { kind: "recording" };
  if (raw.startsWith("canvas-generation://")) return { kind: "generated" };
  if (raw) {
    try {
      const parsed = new URL(raw);
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host && !parsed.username && !parsed.password) {
        return { kind: parsed.pathname === "/" && !parsed.search && !parsed.hash ? "web-origin" : "web-resource", origin: parsed.origin };
      }
      if (/^[a-zA-Z]:[\\/]/u.test(raw)) return { kind: "local" };
      return { kind: "unrecorded" };
    } catch { /* not a URL */ }
  }
  if (["browser:", "dropped:", "blob:", "data:", "javascript:", "file:"].some((prefix) => raw.toLowerCase().startsWith(prefix)) || raw === "") return { kind: "unrecorded" };
  if (/^https?:/i.test(raw)) return { kind: "unrecorded" };
  if (/^[a-z][a-z0-9+.-]*:/iu.test(raw)) return { kind: "unrecorded" };
  return { kind: "local" };
}

export interface MaterialSourcePage {
  assetId: string;
  pageUrl: string;
  pageKind: "work-page" | "capture-page";
  title: string | null;
}

/** Targeted read: the page link is not added to every MaterialAsset DTO. */
export async function getMaterialSourcePage(assetId: string, vaultId?: string, libraryId = materialLibrarySession.getSnapshot().libraryId): Promise<MaterialSourcePage | null> {
  if (vaultId) return invokeTauriCommand<MaterialSourcePage | null>("material_library_command", { request: { libraryId: null, vaultId, action: { op: "sourcePage", id: assetId } } });
  return libraryId ? materialLibrarySession.request<MaterialSourcePage | null>({ op: "sourcePage", id: assetId }, libraryId) : invokeTauriCommand<MaterialSourcePage | null>("material_catalog_get_source_page", { assetId });
}

export type MaterialExternalDragTransport = (
  command: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export type MaterialLightSeekPathTransport = MaterialExternalDragTransport;

export async function resolveMaterialLightSeekResourcesWithTransport(
  assetIds: string[],
  transport: MaterialLightSeekPathTransport,
  libraryId?: string | null,
): Promise<readonly OpenInLightSeekLocalResource[]> {
  if (assetIds.length === 0) throw new Error("请选择要发送到 LightSeek 的素材");
  if (assetIds.length > 64) throw new Error("一次最多发送 64 个素材到 LightSeek，请分批操作");
  if (assetIds.some((id) => !id || id.length > 256 || id.trim() !== id || /[\u0000-\u001f\u007f]/u.test(id))) {
    throw new Error("素材选择无效");
  }
  let result: unknown;
  try {
    result = await transport("material_catalog_resolve_lightseek_paths", { assetIds: [...assetIds] });
  } catch (error) {
    const catalogError = toMaterialCatalogError(error);
    throw new Error(catalogError.message);
  }
  if (!Array.isArray(result) || result.length !== assetIds.length
    || result.some((path) => typeof path !== "string" || !path || path.trim() !== path
      || new TextEncoder().encode(path).byteLength > 4 * 1024
      || /[\u0000-\u001f\u007f]/u.test(path)
      || !(/^[a-z]:[\\/]/iu.test(path) || /^\\\\(?:\?\\)?[^\\/]+[\\/][^\\/]+/u.test(path) || path.startsWith("/")))) {
    throw new Error("素材原文件已移动或不存在，请在素材库重新定位后重试。");
  }
  return Object.freeze(result.map((canonicalPath, index) => Object.freeze({
    kind: "material" as const,
    assetId: assetIds[index],
    ...(libraryId ? { libraryId } : {}),
    canonicalPath,
    delivery: "path-reference" as const,
  })));
}

export function resolveMaterialLightSeekResources(assetIds: string[], libraryId = materialLibrarySession.getSnapshot().libraryId) {
  return resolveMaterialLightSeekResourcesWithTransport(assetIds, nativeMaterialTransport(libraryId), libraryId);
}
export const resolveLegacyMaterialLightSeekResources = (assetIds: string[]) => resolveMaterialLightSeekResources(assetIds, null);
export const listLegacyMaterialAssets = () => requireBridge(null).listAssets();
export const listLegacyFilteredMaterialAssets = (filter: MaterialAssetFilter) => requireBridge(null).listAssetsFiltered(toLegacyMaterialBridgeFilter(filter));

type MaterialLightSeekAttachmentAsset = Readonly<{
  id: string;
  kind?: string;
  mimeType?: string;
  name?: string;
}>;

const LIGHTSEEK_IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const LIGHTSEEK_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const LIGHTSEEK_MAX_IMAGE_ATTACHMENTS = 20;

export async function resolveMaterialLightSeekAttachmentsWithTransport(
  assets: readonly MaterialLightSeekAttachmentAsset[],
  transport: MaterialLightSeekPathTransport,
  libraryId?: string | null,
) {
  const uniqueAssets = Array.from(new Map(assets.map((asset) => [asset.id, asset])).values());
  const resources = await resolveMaterialLightSeekResourcesWithTransport(
    uniqueAssets.map((asset) => asset.id),
    transport, libraryId,
  );
  let imageCount = 0;
  return Object.freeze(resources.map((resource, index) => {
    const asset = uniqueAssets[index];
    const extension = resource.canonicalPath.split(/[\\/]/u).pop()?.split(".").pop()?.toLowerCase() || "";
    const mimeType = (asset?.mimeType || "").trim().toLowerCase();
    const imageAttachment = asset?.kind?.toLowerCase() === "image"
      && (mimeType === "" || LIGHTSEEK_IMAGE_MEDIA_TYPES.has(mimeType))
      && LIGHTSEEK_IMAGE_EXTENSIONS.has(extension)
      && imageCount < LIGHTSEEK_MAX_IMAGE_ATTACHMENTS;
    if (imageAttachment) imageCount += 1;
    return Object.freeze({
      ...resource,
      delivery: imageAttachment ? "image-attachment" as const : "file-attachment" as const,
    });
  }));
}

export function resolveMaterialLightSeekAttachments(assets: readonly MaterialLightSeekAttachmentAsset[], libraryId = materialLibrarySession.getSnapshot().libraryId, vaultId?: string) {
  return resolveMaterialLightSeekAttachmentsWithTransport(assets, nativeMaterialTransport(vaultId ? null : libraryId, vaultId), vaultId ? null : libraryId);
}

export async function beginMaterialExternalDragWithTransport(
  assetIds: string[],
  transport: MaterialExternalDragTransport,
  previewPng?: string,
): Promise<void> {
  const uniqueIds = Array.from(new Set(assetIds));
  if (uniqueIds.length === 0) throw new Error("请选择要拖出的素材");
  if (uniqueIds.length > 64 || uniqueIds.some((id) => !id || id.length > 256 || id.trim() !== id)) {
    throw new Error("素材选择无效");
  }
  await transport("material_catalog_begin_external_drag", { assetIds: uniqueIds, ...(previewPng ? { previewPng } : {}) });
}

export async function beginMaterialExternalDrag(assetIds: string[], libraryId = materialLibrarySession.getSnapshot().libraryId, vaultId?: string, previewPng?: string): Promise<void> {
  const transport = nativeMaterialTransport(libraryId, vaultId);
  await ensureMaterialExternalDragCompletionListener();
  setActiveMaterialExternalDrag(assetIds, Date.now(), libraryId);
  try {
    await beginMaterialExternalDragWithTransport(assetIds, transport, previewPng);
  } catch (error) {
    clearActiveMaterialExternalDrag();
    throw error;
  }
}

type ActiveMaterialExternalDrag = {
  bound: boolean;
  context: ReturnType<typeof materialLibrarySession.capture>;
  assetIds: string[];
  startedAt: number;
  finishedAt: number | null;
};

const MATERIAL_EXTERNAL_DRAG_MAX_AGE_MS = 10 * 60 * 1_000;
const MATERIAL_EXTERNAL_DRAG_FINISH_GRACE_MS = 2_000;
let activeMaterialExternalDrag: ActiveMaterialExternalDrag | null = null;
let materialExternalDragCompletionListener: Promise<void> | null = null;

export function setActiveMaterialExternalDrag(assetIds: string[], now = Date.now(), libraryId?: string | null): void {
  const uniqueIds = Array.from(new Set(assetIds));
  if (uniqueIds.length === 0 || uniqueIds.length > 64) {
    activeMaterialExternalDrag = null;
    return;
  }
  activeMaterialExternalDrag = { assetIds: uniqueIds, startedAt: now, finishedAt: null, bound:libraryId!==undefined, context: libraryId===undefined?materialLibrarySession.capture():{libraryId,generation:0} };
}
function dragMatchesLibrary(active:ActiveMaterialExternalDrag,libraryId:string|null){
  return active.context.libraryId===libraryId&&(active.bound||materialLibrarySession.isCurrent(active.context));
}

export function markActiveMaterialExternalDragFinished(now = Date.now()): void {
  if (activeMaterialExternalDrag) activeMaterialExternalDrag.finishedAt = now;
}

export function clearActiveMaterialExternalDrag(): void {
  activeMaterialExternalDrag = null;
}

export function peekActiveMaterialExternalDrag(now = Date.now()): string[] | null {
  const active = activeMaterialExternalDrag;
  if (!active) return null;
  const expired = now - active.startedAt > MATERIAL_EXTERNAL_DRAG_MAX_AGE_MS
    || (active.finishedAt !== null && now - active.finishedAt > MATERIAL_EXTERNAL_DRAG_FINISH_GRACE_MS);
  if (expired) {
    activeMaterialExternalDrag = null;
    return null;
  }
  return [...active.assetIds];
}

export function consumeActiveMaterialExternalDrag(now = Date.now()): string[] | null {
  const assetIds = peekActiveMaterialExternalDrag(now);
  activeMaterialExternalDrag = null;
  return assetIds;
}

/** Query drops share the native drag identity; never reinterpret a stale drag as an external file. */
export function consumeMaterialAppearanceDrag(now = Date.now(), libraryId=materialLibrarySession.getSnapshot().libraryId): string[] | null {
  const active = activeMaterialExternalDrag;
  const ids = consumeActiveMaterialExternalDrag(now);
  if (ids && active && !dragMatchesLibrary(active,libraryId)) throw new Error("素材库范围不同，请重新拖入当前库的图片");
  return ids;
}

function ensureMaterialExternalDragCompletionListener(): Promise<void> {
  if (typeof window === "undefined" || !(window as any).__TAURI_INTERNALS__) return Promise.resolve();
  if (!materialExternalDragCompletionListener) {
    materialExternalDragCompletionListener = import("@tauri-apps/api/event")
      .then(({ listen }) => listen("material-external-drag-ended", () => {
        markActiveMaterialExternalDragFinished();
      }))
      .then(() => undefined)
      .catch((error) => {
        materialExternalDragCompletionListener = null;
        throw error;
      });
  }
  return materialExternalDragCompletionListener;
}

export function resolveMaterialExternalDragSelection(
  draggedAssetId: string,
  selectedAssetIds: Iterable<string>,
): string[] {
  const selected = Array.from(new Set(selectedAssetIds));
  return selected.includes(draggedAssetId) ? selected : [draggedAssetId];
}

export async function moveActiveMaterialExternalDragToFolderWithAdapter(
  folderId: string | null,
  move: (assetIds: string[], folderId: string | null) => Promise<PromiseSettledResult<void>[]>,
  now = Date.now(),
): Promise<{ moved: number; total: number } | null> {
  // A stale internal drag must be rejected, never reclassified as file import.
  const active = activeMaterialExternalDrag;
  if (peekActiveMaterialExternalDrag(now) && active && !dragMatchesLibrary(active,materialLibrarySession.getSnapshot().libraryId)) {
    clearActiveMaterialExternalDrag();
    throw new Error("素材库已切换，未移动素材");
  }
  const assetIds = consumeActiveMaterialExternalDrag(now);
  if (!assetIds) return null;
  const results = await move(assetIds, folderId);
  return {
    moved: results.filter((result) => result.status === "fulfilled").length,
    total: assetIds.length,
  };
}

export async function moveActiveMaterialExternalDragToFolder(
  folderId: string | null,
): Promise<{ moved: number; total: number } | null> {
  return moveActiveMaterialExternalDragToFolderWithAdapter(folderId, moveMaterialAssetsToFolder);
}

export async function getMaterialAssetPreviewUrl(libraryPath: string): Promise<string> {
  const bridge = requireBridge();
  return bridge.getAssetPreviewUrl(libraryPath);
}

export async function scanMissingMaterialAssets(libraryId = materialLibrarySession.getSnapshot().libraryId): Promise<MaterialMissingAsset[]> {
  const bridge = requireBridge(libraryId);
  const missing = await bridge.scanMissingAssets();
  return Array.isArray(missing) ? missing : [];
}

export async function removeMissingMaterialAssetRecord(id: string, libraryId = materialLibrarySession.getSnapshot().libraryId) {
  const bridge = requireBridge(libraryId);
  return bridge.removeAssetRecord(id);
}

export async function getMaterialAssetLinkedNotes(assetId: string): Promise<MaterialLinkedNote[]> {
  let knowledge = await knowledgeStore.ensureSnapshot({ reason: "material-linked-documents" });
  const source = readActiveKnowledgeSource();
  if (source?.mode === "real-vault"
    && (knowledge.mode !== "real-vault" || knowledge.vault?.id !== source.vaultId)) {
    knowledge = await knowledgeStore.revalidate({ reason: "material-linked-documents-source-sync", force: true });
  }
  if (knowledge.mode === "real-vault" && knowledge.vault && knowledge.markdownIndex
    && source?.mode === "real-vault" && source.vaultId === knowledge.vault.id) {
    const assets = (await materialStore.ensureSnapshot({ reason: "material-linked-documents" })).allAssets;
    return resolveMaterialKnowledgeLinkedNotes(assetId, assets, {
      vaultId: knowledge.markdownIndex.vaultId,
      documents: knowledge.markdownIndex.documents.map((document) => ({
        documentRef: { vaultId: knowledge.markdownIndex!.vaultId, relativePath: document.relativePath },
        title: document.title,
        modifiedAt: document.mtime,
        embeds: document.embeds,
      })),
    });
  }
  throw new Error(source?.mode === "real-vault" ? "knowledge-vault-not-current" : "knowledge-vault-required");
}

type MaterialKnowledgeIndex = Pick<KnowledgeIndexSnapshot, "vaultId"> & {
  documents: Array<Pick<KnowledgeIndexSnapshot["documents"][number], "documentRef" | "title" | "modifiedAt" | "embeds">>;
};

export function resolveMaterialKnowledgeLinkedNotes(
  assetId: string,
  assets: Array<Pick<MaterialAsset, "id" | "name" | "originalPath" | "libraryPath">>,
  index: MaterialKnowledgeIndex,
): MaterialLinkedNote[] {
  const resolveAsset = createRealVaultLibraryAssetResolver(assets);
  return index.documents.flatMap((document) => {
    if (document.documentRef.vaultId !== index.vaultId) return [];
    const linked = document.embeds.some((embed) => resolveAsset(embed.target || embed.raw || "")?.id === assetId);
    return linked ? [{
      id: knowledgeDocumentNoteId(document.documentRef),
      title: document.title,
      updatedAt: document.modifiedAt,
      folderId: null,
    }] : [];
  });
}

type MaterialCurrentNoteInsertDependencies = {
  writer?: (input: { text: string; appendIfNoCursor?: boolean }) => Promise<KnowledgeMutationResult>;
  awaitCurrentNoteReady?: () => Promise<void>;
};

export function buildMaterialAssetKnowledgeEmbed(asset: Pick<MaterialAsset, "id" | "name">): string {
  return `![[${asset.id}|${asset.name}]]`;
}

export async function insertMaterialAssetIntoCurrentKnowledge(
  asset: Pick<MaterialAsset, "id" | "name">,
  dependencies: MaterialCurrentNoteInsertDependencies = {},
  vaultId?: string,
): Promise<{ noteId: string; position?: string }> {
  const frozenAsset = { id: asset.id, name: asset.name };
  const libraryId = materialLibrarySession.getSnapshot().libraryId;
  const source = readActiveKnowledgeWriteSource();
  await (dependencies.awaitCurrentNoteReady || flushCurrentNoteContextUpdates)();
  let result: KnowledgeMutationResult;
  if (dependencies.writer) {
    result = await dependencies.writer({ text: buildMaterialAssetKnowledgeEmbed(frozenAsset), appendIfNoCursor: true });
  } else {
    if (!source || source !== readActiveKnowledgeWriteSource()) throw new Error("知识库已切换，请重新插入素材");
    const active = await ensureActiveKnowledgeUiSource();
    if (source !== readActiveKnowledgeWriteSource() || active.vaultId !== source.vaultId) throw new Error("知识库已切换，请重新插入素材");
    result = await invokeTauriCommand<KnowledgeMutationResult>("knowledge_insert_material_current", { assetId: frozenAsset.id, sourceEpoch: active.sourceEpoch, libraryId: vaultId ? null : libraryId, vaultId });
  }
  // Native insertion changes both the saved document and its attachment refs.
  // Refresh the shared snapshots before consumers reveal the new Markdown;
  // the retained Notes page may have no active effects to receive a UI event.
  if (source && source === readActiveKnowledgeWriteSource() && result.document.documentRef.vaultId === source.vaultId) {
    await Promise.all([
      knowledgeStore.invalidate({ reason: "material-current-note-insert" }),
      materialStore.invalidate({ reason: "material-current-note-insert" }),
    ]);
  }
  return {
    noteId: knowledgeDocumentNoteId(result.document.documentRef),
    position: result.position,
  };
}

export async function getMaterialAssetAiSuggestion(assetId: string, vaultId?: string, libraryId = materialLibrarySession.getSnapshot().libraryId): Promise<MaterialAiSuggestion | null> {
  if ((libraryId || vaultId) && !window.__LUCKYRAY_MATERIAL_AI__) throw new Error("当前素材库的 AI 服务尚未就绪");
  const bridge = (libraryId || vaultId) && window.__LUCKYRAY_MATERIAL_AI__ ? window.__LUCKYRAY_MATERIAL_AI__(vaultId ? null : libraryId, vaultId) : requireCoordinationBridge();
  if (!bridge.getAssetAiSuggestion) return null;
  return bridge.getAssetAiSuggestion(assetId);
}

export async function generateMaterialAssetAiSuggestion(assetId: string, vaultId?: string, libraryId = materialLibrarySession.getSnapshot().libraryId): Promise<MaterialAiSuggestion | null> {
  if ((libraryId || vaultId) && !window.__LUCKYRAY_MATERIAL_AI__) throw new Error("当前素材库的 AI 服务尚未就绪");
  const bridge = (libraryId || vaultId) && window.__LUCKYRAY_MATERIAL_AI__ ? window.__LUCKYRAY_MATERIAL_AI__(vaultId ? null : libraryId, vaultId) : requireCoordinationBridge();
  if (!bridge.generateAssetAiSuggestion) throw new Error("当前环境不支持 AI 建议");
  return bridge.generateAssetAiSuggestion(assetId);
}

export async function applyMaterialAssetAiTags(assetId: string, tagNames: string[], vaultId?: string, libraryId = materialLibrarySession.getSnapshot().libraryId): Promise<void> {
  if ((libraryId || vaultId) && !window.__LUCKYRAY_MATERIAL_AI__) throw new Error("当前素材库的 AI 服务尚未就绪");
  if ((libraryId || vaultId) && window.__LUCKYRAY_MATERIAL_AI__) { await window.__LUCKYRAY_MATERIAL_AI__(vaultId ? null : libraryId, vaultId).applyTags(assetId, tagNames); return; }
  const bridge = requireCoordinationBridge();
  if (!bridge.applyAiTags) throw new Error("当前环境不支持 AI 标签应用");
  await bridge.applyAiTags("asset", assetId, tagNames);
}

export async function dismissMaterialAssetAiSuggestion(assetId: string, vaultId?: string, libraryId = materialLibrarySession.getSnapshot().libraryId): Promise<void> {
  if ((libraryId || vaultId) && !window.__LUCKYRAY_MATERIAL_AI__) throw new Error("当前素材库的 AI 服务尚未就绪");
  if ((libraryId || vaultId) && window.__LUCKYRAY_MATERIAL_AI__) { await window.__LUCKYRAY_MATERIAL_AI__(vaultId ? null : libraryId, vaultId).dismissAssetAiSuggestion(assetId); return; }
  const bridge = requireCoordinationBridge();
  if (!bridge.dismissAiSuggestion) throw new Error("当前环境不支持忽略 AI 建议");
  await bridge.dismissAiSuggestion("asset", assetId);
}
