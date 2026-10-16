import { adaptMaterialAssetMedia } from "./materialAssetAdapter";
import { materialLibrarySession } from "./materialLibraryContext";
import type { MaterialAsset, MaterialCatalogAdapter, MaterialCatalogImportResult, MaterialImportResult, MaterialImportProgress } from "./materialCatalog";
import { toMaterialCatalogError } from "./materialCatalog";
import type { LuckyRayBridge } from "../bridge/luckyRayBridge";
export type MaterialLibraryAi = Pick<LuckyRayBridge, "getAssetAiSuggestion" | "generateAssetAiSuggestion"> & { dismissAssetAiSuggestion(id: string): Promise<void>; applyTags(id: string, names: string[]): Promise<void> };
declare global { interface Window { __LUCKYRAY_MATERIAL_AI__?: (libraryId: string | null, vaultId?: string) => MaterialLibraryAi; } }

const adapt = (assets: MaterialAsset[]) => assets.map(asset => adaptMaterialAssetMedia(asset));
function imported(result: MaterialCatalogImportResult): MaterialImportResult {
  return { assets: adapt(result.assets), source: "tauri", skippedDuplicates: result.skippedDuplicateCount,
    errors: result.failedItems.map(item => ({ name: item.file, error: item.error })) };
}
export function createMaterialLibraryAdapter(legacy: MaterialCatalogAdapter, libraryId: string): MaterialCatalogAdapter {
  const policy = materialLibrarySession.getSnapshot().registry?.libraries.find(library => library.id === libraryId)?.storageMode ?? "managed";
  const call = <T>(op: string, fields: Record<string, unknown> = {}) => materialLibrarySession.request<T>({ op, ...fields }, libraryId).catch(e => { throw toMaterialCatalogError(e); });
  return {
    ...legacy,
    listAssets: async () => adapt(await call<MaterialAsset[]>("list")),
    getAssetsByIds: async ids => adapt(await call<MaterialAsset[]>("get", { ids })),
    listAssetsFiltered: async filter => adapt(await call<MaterialAsset[]>("list", { filter })),
    listFolders: () => call("folders"),
    getMaterialChangeState: () => call("change"),
    importAssets: async options => {
      const target = { folderId: options?.folderId ?? null, storageMode: options?.storageMode ?? policy, managedLibraryDir: options?.managedLibraryDir ?? null };
      let paths = options?.paths;
      if (!paths?.length) {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({ multiple: true, directory: false, title: "导入素材" });
        if (!selected) return { assets: [], skippedDuplicates: 0, source: "tauri" };
        paths = typeof selected === "string" ? [selected] : selected;
      }
      options?.onProgress?.({ current: 0, total: paths.length, phase: "importing" });
      const { Channel } = await import("@tauri-apps/api/core");
      const progress = new Channel<MaterialImportProgress>();
      let active = true;
      progress.onmessage = value => { if (active) options?.onProgress?.(value); };
      const result = imported(await call<MaterialCatalogImportResult>("importPaths", { paths, options: target, progress }).finally(() => { active = false; }));
      options?.onProgress?.({ current: paths.length, total: paths.length, phase: "done" });
      return result;
    },
    importDroppedFiles: async (files, options) => {
      const items = await Promise.all(Array.from(files).map(async file => ({ name: file.name, originalPath: `dropped:${file.name}`, mimeType: file.type, bytes: Array.from(new Uint8Array(await file.arrayBuffer())), description: null })));
      return imported(await call<MaterialCatalogImportResult>("importBytes", { items, options: { folderId: options?.folderId ?? null, storageMode: "managed" } }));
    },
    importFolder: (path, options) => call("importFolder", { path, options: { ...options, storageMode: options?.storageMode ?? policy } }),
    updateAsset: async (id, patch) => { const result = await call<MaterialAsset | null>("update", { id, patch }); return result && adaptMaterialAssetMedia(result); },
    renameAssetFile: async (id, name) => { const result = await call<MaterialAsset | null>("renameFile", { id, name }); return result && adaptMaterialAssetMedia(result); },
    relocateAsset: async (id, path, options) => { const result = await call<MaterialAsset | null>("relocate", { id, path, options: options ?? {} }); return result && adaptMaterialAssetMedia(result); },
    deleteAsset: async (id, options) => { await call("delete", { id, deleteFile: options?.deleteFile ?? false }); },
    listTags: () => call("tags"),createTag: input => call("createTag", input),getAssetTags: id => call("assetTags", { id }),
    setAssetTags: (id, tagIds) => call("setTags", { id, tagIds }),moveAssetToFolder: async input => { await call("move", { id: input.assetId, folderId: input.folderId }); },
    scanMissingAssets: () => call("missing"),
    removeAssetRecord: async id => { await call("delete", { id, deleteFile: false }); return { success: true, fileStillExists: true }; },
  };
}

// A selected Vault authorizes only its registered attachment IDs. No ordinary library lookup.
export function createMaterialVaultAttachmentAdapter(legacy: MaterialCatalogAdapter, vaultId: string): MaterialCatalogAdapter {
  const call = async <T>(op: string, fields: Record<string, unknown> = {}) => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>("material_library_command", { request: { libraryId: null, vaultId, action: { op, ...fields } } }).catch(error => { throw toMaterialCatalogError(error); });
  };
  return { ...legacy,
    deleteAsset: async (id, options) => { await call("delete", { id, deleteFile: options?.deleteFile ?? false }); },
    getAssetsByIds: async ids => adapt(await call<MaterialAsset[]>("get", { ids })),
    updateAsset: async (id, patch) => { const asset=await call<MaterialAsset | null>("update", { id, patch }); return asset && adaptMaterialAssetMedia(asset); },
    createTag: input => call("createTag", input),listTags: () => call("tags"),getAssetTags: id => call("assetTags", { id }),setAssetTags: (id, tagIds) => call("setTags", { id, tagIds }),
    renameAssetFile: async (id,name) => {const asset=await call<MaterialAsset | null>("renameFile",{id,name});return asset && adaptMaterialAssetMedia(asset);},
    relocateAsset: async (id,path,options) => {const asset=await call<MaterialAsset | null>("relocate",{id,path,options:options??{}});return asset && adaptMaterialAssetMedia(asset);},
  };
}
