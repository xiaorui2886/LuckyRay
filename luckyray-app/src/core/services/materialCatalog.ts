import type { MaterialChange } from "./materialChangeProtocol";

export type MaterialStorageMode = "managed" | "linked" | "source";

export const MATERIAL_CATALOG_ERROR_PREFIX = "luckyray-material-error:";
export const SOURCE_RELOCATE_CONTENT_MISMATCH_CODE = "source-relocate-content-mismatch";

export type MaterialRelocateOptions = {
  allowSourceContentChange?: boolean;
  expectedSourceContentHash?: string;
};

type MaterialCatalogErrorPayload = {
  code: string;
  message: string;
  details?: Record<string, unknown> | null;
};

export class MaterialCatalogError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | null;

  constructor(code: string, message: string, details?: Record<string, unknown> | null) {
    super(message);
    this.name = "MaterialCatalogError";
    this.code = code;
    this.details = details ?? null;
  }
}

function parseMaterialCatalogErrorPayload(error: unknown): MaterialCatalogErrorPayload | null {
  if (error instanceof MaterialCatalogError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
    if (typeof candidate.code === "string") {
      return {
        code: candidate.code,
        message: typeof candidate.message === "string" ? candidate.message : candidate.code,
        details: typeof candidate.details === "object" && candidate.details !== null
          ? candidate.details as Record<string, unknown>
          : null,
      };
    }
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message.startsWith(MATERIAL_CATALOG_ERROR_PREFIX)) return null;
  try {
    const payload = JSON.parse(message.slice(MATERIAL_CATALOG_ERROR_PREFIX.length)) as Partial<MaterialCatalogErrorPayload>;
    if (typeof payload.code !== "string") return null;
    return {
      code: payload.code,
      message: typeof payload.message === "string" ? payload.message : payload.code,
      details: typeof payload.details === "object" && payload.details !== null
        ? payload.details as Record<string, unknown>
        : null,
    };
  } catch {
    return null;
  }
}

export function getMaterialCatalogErrorCode(error: unknown): string | null {
  return parseMaterialCatalogErrorPayload(error)?.code ?? null;
}

export function toMaterialCatalogError(error: unknown): MaterialCatalogError {
  const payload = parseMaterialCatalogErrorPayload(error);
  if (payload) return new MaterialCatalogError(payload.code, payload.message, payload.details);
  const message = error instanceof Error ? error.message : String(error || "素材操作失败");
  return new MaterialCatalogError("material-catalog-error", message);
}

export type MaterialAsset = {
  id: string;
  name: string;
  originalPath: string;
  libraryPath: string | null;
  storageMode: MaterialStorageMode;
  kind: string;
  mimeType: string;
  sizeBytes: number | null;
  thumbnailUrl: string;
  previewUrl?: string;
  description: string;
  rating: number | null;
  dominantColor: string | null;
  folderId: string | null;
  importedAt: string;
  updatedAt: string;
  contentHash: string | null;
};

export type VideoThumbnailBackfillInput =
  | { kind: "image-data"; value: string }
  | { kind: "video-file"; value: string };

type VideoThumbnailBackfillAsset = Pick<
  MaterialAsset,
  "kind" | "thumbnailUrl" | "libraryPath" | "originalPath"
>;

function isImageThumbnailReference(value: string): boolean {
  return /\.(?:jpe?g|png|webp)(?:[?#].*)?$/i.test(value);
}

/**
 * Decides from raw Catalog fields whether a video still needs a persisted image poster.
 * A WebView-ready video URL is a playback source, never proof that a thumbnail exists.
 */
export function resolveVideoThumbnailBackfillInput(
  asset: VideoThumbnailBackfillAsset,
): VideoThumbnailBackfillInput | null {
  if (asset.kind !== "video") return null;
  const rawThumbnail = (asset.thumbnailUrl || "").trim();
  if (rawThumbnail.startsWith("data:image/")) {
    return { kind: "image-data", value: rawThumbnail };
  }
  if (rawThumbnail && isImageThumbnailReference(rawThumbnail)) return null;

  const sourcePath = (asset.libraryPath || asset.originalPath || "").trim();
  if (!sourcePath || sourcePath.startsWith("browser:") || sourcePath.startsWith("dropped:")) return null;
  return { kind: "video-file", value: sourcePath };
}

/**
 * Canonical card/sidebar preview target shared by Tags detail and the
 * LightSeek materials sidebar. A persisted image poster wins; videos without
 * one fall back to an honest first-frame playback URL (`#t=0.1` makes the
 * WebView paint that frame) so legacy assets never render as black cards.
 */
export type MaterialPreviewTarget =
  | { kind: "image"; url: string }
  | { kind: "video-frame"; url: string };

export function resolveMaterialPreviewTarget(asset: {
  kind?: string | null;
  thumbnailUrl?: string | null;
  previewUrl?: string | null;
}): MaterialPreviewTarget | null {
  const kind = (asset.kind || "").trim().toLowerCase();
  const thumbnailUrl = (asset.thumbnailUrl || "").trim();
  const previewUrl = (asset.previewUrl || "").trim();
  if (kind === "video") {
    if (thumbnailUrl.startsWith("data:image/") || isImageThumbnailReference(thumbnailUrl)) {
      return { kind: "image", url: thumbnailUrl };
    }
    if (previewUrl) {
      return { kind: "video-frame", url: `${previewUrl}#t=0.1` };
    }
    return null;
  }
  if (thumbnailUrl) return { kind: "image", url: thumbnailUrl };
  if (previewUrl) return { kind: "image", url: previewUrl };
  return null;
}

/** Canonical catalog filter. Snake-case aliases are retained at the UI adapter boundary. */
export type MaterialAssetFilter = {
  query?: string;
  scope?: "ordinary" | "note-attachments" | "all";
  vaultId?: string;
  includeUnreferenced?: boolean;
  kinds?: string[];
  tagIds?: string[];
  folderId?: string;
  recentOnly?: boolean;
  dateFrom?: string;
  dateTo?: string;
  ratingMin?: number;
  dominantColor?: string;
  limit?: number;
};

export function toLegacyMaterialBridgeFilter(filter: MaterialAssetFilter) {
  return {
    ...(filter.query ? { query: filter.query } : {}),
    kinds: filter.kinds,
    tag_ids: filter.tagIds,
    folder_id: filter.folderId,
    recent_only: filter.recentOnly,
    date_from: filter.dateFrom,
    date_to: filter.dateTo,
    rating_min: filter.ratingMin,
    dominant_color: filter.dominantColor,
    limit: filter.limit,
  };
}

export type MaterialTag = {
  id: string;
  name: string;
  color: string | null;
  assetCount: number;
  noteCount: number;
  createdAt: string;
  updatedAt: string;
};

export type MaterialFolder = {
  id: string;
  scope: "materials";
  parentId: string | null;
  name: string;
  sortOrder: number;
  open: boolean;
  createdAt: string;
  updatedAt: string;
  children: MaterialFolder[];
};

export type MaterialImportItemError = { file: string; code?: string; error: string };

export type MaterialCatalogImportResult = {
  assets: MaterialAsset[];
  importedCount: number;
  skippedDuplicateCount: number;
  failedCount: number;
  failedItems: MaterialImportItemError[];
};

export type MaterialImportProgress = {
  current: number;
  total: number;
  name?: string;
  bytesRead?: number;
  bytesTotal?: number;
  phase?: "selecting" | "copying" | "importing" | "done";
};

export type MaterialImportResult = {
  assets: MaterialAsset[];
  source: "tauri" | "browser";
  skippedDuplicates: number;
  errors?: Array<{ name: string; error: string }>;
};

export type MaterialFolderImportOptions = {
  storageMode?: MaterialStorageMode;
  managedLibraryDir?: string | null;
  recursive?: boolean;
  preserveFolderStructure?: boolean;
};

export type MaterialFolderImportResult = {
  importedCount: number;
  skippedDuplicateCount: number;
  failedCount: number;
  failedItems: MaterialImportItemError[];
};

export type MaterialMissingAsset = { id: string; name: string; libraryPath: string };
export type MaterialRemoveResult = { success: boolean; fileStillExists: boolean };

export type MaterialCatalogBridgeFilter = ReturnType<typeof toLegacyMaterialBridgeFilter>;

export type MaterialCatalogAdapter = {
  listAssets(): Promise<MaterialAsset[]>;
  getAssetsByIds(assetIds: string[]): Promise<MaterialAsset[]>;
  listAssetsFiltered(filters: MaterialCatalogBridgeFilter): Promise<MaterialAsset[]>;
  listFolders(scope: "materials"): Promise<MaterialFolder[]>;
  getMaterialChangeState(): Promise<MaterialChange | null>;
  importAssets(options?: {
    folderId?: string | null;
    paths?: string[];
    storageMode?: MaterialStorageMode;
    managedLibraryDir?: string | null;
    onProgress?: (progress: MaterialImportProgress) => void;
  }): Promise<MaterialImportResult>;
  importDroppedFiles(files: File[] | FileList, options?: {
    folderId?: string | null;
    storageMode?: MaterialStorageMode;
    managedLibraryDir?: string | null;
  }): Promise<MaterialImportResult>;
  selectImportFolder(): Promise<string | null>;
  importFolder(path: string, options?: MaterialFolderImportOptions): Promise<MaterialFolderImportResult>;
  updateAsset(id: string, patch: Partial<Pick<MaterialAsset, "name" | "description" | "rating" | "dominantColor">>): Promise<MaterialAsset | null>;
  renameAssetFile(id: string, fileName: string): Promise<MaterialAsset | null>;
  selectAssetFile(): Promise<string | null>;
  relocateAsset(id: string, path: string, options?: MaterialRelocateOptions): Promise<MaterialAsset | null>;
  deleteAsset(id: string, options?: { deleteFile?: boolean }): Promise<void>;
  listTags(): Promise<MaterialTag[]>;
  createTag(input: { name: string; color?: string | null }): Promise<MaterialTag>;
  getAssetTags(id: string): Promise<string[]>;
  setAssetTags(id: string, tagIds: string[]): Promise<string[]>;
  moveAssetToFolder(input: { assetId: string; folderId: string | null }): Promise<void>;
  getAssetPreviewUrl(path: string): Promise<string>;
  scanMissingAssets(): Promise<MaterialMissingAsset[]>;
  removeAssetRecord(id: string): Promise<MaterialRemoveResult>;
};
