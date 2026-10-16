// Authoritative Content V1 DTOs; vendored byte-for-byte by Mobile.
export interface Capabilities { contentVersion: 1; bundleRevision: string; capabilities: { materialPreview: boolean; noteRead: boolean; noteWrite: boolean; noteChanges: boolean; noteAttachments: boolean; materialFavorite?: boolean; materialTags?: boolean; materialFolders?: boolean; materialBatch?: boolean; lshRemoteSurface?: boolean }; limits: {pageSize: number; noteBytes: number; attachmentBytes: number; chunkBytes: number; batchAssets?: number} }
export interface NoteResource { resourceId: string; target: string; status: string; version: string | null; mimeType: string; embedded: boolean }
export interface Note { noteId: string; vaultId: string; revision?: string; title?: string; relativePath?: string; content?: string; deleted?: boolean; resources?: NoteResource[] }
export interface Mutation { opId: string; noteId?: string; vaultId: string; kind: "create" | "update" | "rename" | "delete"; expectedRevision?: string | null; title?: string | null; content?: string | null; parentRelativePath?: string | null }
export interface Asset { desktopAssetId: string; name: string; kind: string; mimeType: string; sizeBytes: number; updatedAt: string; contentHash?: string | null; thumbnailRevision: string; folderId?: string | null; storageMode: string; description?: string | null; favorite?: boolean }
export interface AssetPage {items: Asset[]; page: number; limit: number; hasMore: boolean; nextPage: number | null; cached?: boolean; cachedAt?: string}
export interface NotePage {items: Note[]; snapshotSeq: number; hasMore: boolean; nextId: string | null}
export interface Changes {changes: {seq: number; noteId: string; revision: string; deleted: boolean; domain: "note"}[]; cursor: number; hasMore: boolean}
export interface UploadManifest {vaultId: string; expectedRevision: string; name: string; mime: string; sizeBytes: number; sha256: string}
export interface UploadChunk {vaultId: string; offset: number; data: string; sha256: string}

// ---- Wave A: Desktop material organization (desired state, not toggles) ----
export interface MaterialFavoriteInput { desktopAssetId: string; favorited: boolean }
export interface MaterialFavoriteResult { desktopAssetId: string; favorited: boolean }
export interface MaterialTagsInput { desktopAssetId: string; set?: string[]; add?: string[]; remove?: string[] }
export interface MaterialTagsResult { desktopAssetId: string; tags: string[] }
/** folderId is an explicit string | null; null means ROOT, never "unchanged". */
export interface MaterialFolderInput { desktopAssetId: string; folderId: string | null }
export interface MaterialFolderResult { desktopAssetId: string; folderId: string | null }
export interface MaterialCreateTagInput { name: string; color?: string | null }
export interface MaterialCreateFolderInput { name: string; parentId?: string | null }
/** folderId is presence-aware: omitted = leave the folder unchanged,
 *  null = move to root, string = move into that folder. */
export interface MaterialBatchInput { desktopAssetIds: string[]; favorited?: boolean; add?: string[]; remove?: string[]; folderId?: string | null }
export interface MaterialBatchFailure { desktopAssetId: string; reason: string }
/** atomic is always false: a batch reports per-asset outcomes, never atomicity. */
export interface MaterialBatchResult { requested: number; succeeded: string[]; failed: MaterialBatchFailure[]; atomic: false }
export const MATERIAL_BATCH_LIMIT = 100;
