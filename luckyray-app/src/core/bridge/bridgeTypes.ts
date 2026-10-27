// Shared bridge data shapes. App.tsx owns runtime assembly, not these contracts.
import type { MaterialChange } from "../services/materialChangeProtocol";
import type { MaterialRelocateOptions } from "../services/materialCatalog";
import type { SmartFolderDefinition, SmartFolderDefinitionInput } from "../services/smartFolders";

export type AssetStorageMode = "linked" | "managed" | "source";
export type MaterialImportProgress = {
  current: number;
  total: number;
  name?: string;
  phase?: "selecting" | "copying" | "importing" | "done";
};
export type MaterialImportOptions = {
  folderId?: string | null;
  paths?: string[];
  storageMode?: AssetStorageMode;
  managedLibraryDir?: string | null;
  onProgress?: (progress: MaterialImportProgress) => void;
};
export type MaterialFolderImportOptions = {
  storageMode?: AssetStorageMode;
  managedLibraryDir?: string | null;
  recursive?: boolean;
  preserveFolderStructure?: boolean;
};

export type BridgeAsset = {
  materialGenerationProvenance?: import("../canvas/materialProvenance").MaterialGenerationProvenance;
  id: string;
  name: string;
  originalPath: string;
  libraryPath: string | null;
  storageMode: AssetStorageMode;
  kind: string;
  mimeType: string;
  sizeBytes: number | null;
  thumbnailUrl: string;
  previewUrl: string;
  description: string;
  rating: number | null;
  dominantColor: string | null;
  folderId: string | null;
  importedAt: string;
  updatedAt: string;
  contentHash: string | null;
};

export type BridgeFolder = {
  id: string;
  scope: "materials" | "notes";
  parentId: string | null;
  name: string;
  sortOrder: number;
  open: boolean;
  createdAt: string;
  updatedAt: string;
};

export type BridgeFolderNode = BridgeFolder & { children: BridgeFolderNode[] };

export type CreateFolderInput = {
  scope: "materials" | "notes";
  parentId: string | null;
  name: string;
};

export type MoveFolderInput = {
  id: string;
  targetId: string | null;
  position: "before" | "after" | "inside";
};

export type MoveAssetToFolderInput = { assetId: string; folderId: string | null };
export type MoveNoteToFolderInput = { noteId: string; folderId: string | null };
export type UpdateTagInput = { name?: string; color?: string | null };

export type BridgeTag = {
  id: string;
  name: string;
  color: string | null;
  assetCount: number;
  noteCount: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateTagInput = { name: string; color?: string | null };

export type BridgeNote = {
  id: string;
  title: string;
  contentJson: string;
  contentText: string;
  folderId: string | null;
  color: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ImportNotesMarkdownResult = {
  notes: BridgeNote[];
  count: number;
  importedAttachments?: number;
};

export type CreateNoteInput = { title?: string; folderId?: string | null; contentJson?: string; contentText?: string; color?: string | null };
export type UpdateNoteInput = Partial<Pick<BridgeNote, "title" | "contentJson" | "contentText" | "folderId" | "color">>;

export type BridgeSettings = {
  aiProvider: string | null;  // 'deepseek' | 'openai' | 'custom'
  aiApiKey: string | null;
  aiApiKeyConfigured?: boolean;
  aiBaseURL: string | null;
  aiModel: string | null;
  aiTemperature: number;
  aiMaxTokens: number;
  aiImageApiKey: string | null;
  aiImageApiKeyConfigured?: boolean;
  aiImageBaseURL: string | null;
  aiImageModel: string | null;
  aiVideoModel: string | null;
  // 6.6 通用命名 (1.0.1+ 简化版, 同步 aiTemperature / aiMaxTokens, 兼容 HTML 老接口)
  temperature?: number;
  maxTokens?: number;
};

export type BridgeAiChatResponse = {
  success: boolean;
  content?: string | null;
  error_kind?: string | null;
  error_message?: string | null;
  error_detail?: string | null;
};

export type BridgeAiMessageContent =
  | string
  | Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
    }>;

export type BridgeAiConversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type BridgeAiMessage = {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  actionTruth?: unknown;
};

export type BridgeSearchResults = {
  assets: Array<{ id: string; name: string; kind: string; folderId: string | null; thumbnailUrl: string; snippet: string }>;
  notes: Array<{ id: string; title: string; folderId: string | null; updatedAt: string; snippet: string }>;
  tags: Array<{ id: string; name: string; assetCount: number; noteCount: number }>;
};

export type BridgeBackupManifest = {
  created_at: string;
  app_version: string;
  db_size_bytes: number;
  asset_count: number;
  source_dir: string;
};

export type BridgeBackupInfo = {
  id: string;
  path: string;
  manifest: BridgeBackupManifest;
};

export type BridgeExportResult = {
  path: string;
  count: number;
};

export type ExportNotesMarkdownOptions = {
  noteIds?: string[];
  folderIds?: string[];
};

export type BridgeVaultMetadata = {
  id: string;
  name: string;
  rootPath: string;
  mode: string;
  createdAt: string;
  lastOpenedAt: string;
  schemaVersion: number;
  linkUpdatePolicy?: "ask" | "always";
};

export type BridgeOpenVaultResult = {
  vault: BridgeVaultMetadata | null;
  missing: boolean;
  rootPath: string;
};



export type BridgeNotesVaultFileNode = {
  kind: "folder" | "file";
  name: string;
  relativePath: string;
  absolutePath: string;
  children: BridgeNotesVaultFileNode[];
  mtime: string | null;
  size: number;
};

export type BridgeNotesVaultMarkdownFile = {
  name: string;
  relativePath: string;
  absolutePath: string;
  contentText: string;
  mtime: string | null;
  size: number;
};

export type BridgeNotesVaultMarkdownHeading = {
  level: number;
  text: string;
  slug: string;
  line: number;
};

export type BridgeNotesVaultMarkdownWikiLink = {
  raw: string;
  target: string;
  alias: string | null;
  line: number;
};

export type BridgeNotesVaultMarkdownEmbed = {
  raw: string;
  target: string;
  kind: string | null;
  line: number;
};

export type BridgeNotesVaultMarkdownIndexDocument = {
  relativePath: string;
  absolutePath: string;
  fileName: string;
  title: string;
  revision: string;
  headings: BridgeNotesVaultMarkdownHeading[];
  wikiLinks: BridgeNotesVaultMarkdownWikiLink[];
  embeds: BridgeNotesVaultMarkdownEmbed[];
  tags: string[];
  frontmatterTags: string[];
  inlineTags: string[];
  plainText: string;
  excerpt: string;
  contentLength: number;
  mtime: string | null;
  size: number;
};

export type BridgeNotesVaultMarkdownIndexError = {
  code: string;
  message: string;
  relativePath: string;
};

export type BridgeNotesVaultMarkdownIndex = {
  vaultId: string;
  rootPath: string;
  generatedAt: string;
  documents: BridgeNotesVaultMarkdownIndexDocument[];
  errors: BridgeNotesVaultMarkdownIndexError[];
  version: number;
  changedPaths: string[];
  removedPaths: string[];
};

export type BridgeNotesVaultAssetExistsResult = {
  relativePath: string;
  absolutePath: string;
  exists: boolean;
  isFile: boolean;
};

export type BridgeNotesVaultAssetCandidateResult = {
  relativePath: string;
  absolutePath: string;
  exists: boolean;
  isFile: boolean;
  matchKind: string;
};

export type BridgeNotesVaultWriteResult = {
  relativePath: string;
  absolutePath: string;
  mtime: string | null;
  size: number;
  message: string;
};

export type BridgeNotesVaultDeleteResult = {
  relativePath: string;
  absolutePath: string;
  deleted: boolean;
  message: string;
};

export type BridgeNotesVaultFileTransferItem = {
  sourcePath: string;
  relativePath: string;
  absolutePath: string;
  renamed: boolean;
};

export type BridgeNotesVaultFileTransferError = {
  sourcePath: string;
  code: string;
  message: string;
};

export type BridgeNotesVaultImportMarkdownResult = {
  copiedCount: number;
  failedCount?: number;
  skippedCount: number;
  conflictRenamedCount: number;
  targetParentRelativePath: string;
  files: BridgeNotesVaultFileTransferItem[];
  errors: BridgeNotesVaultFileTransferError[];
};

export type BridgeNotesVaultExportMarkdownResult = {
  exportedCount: number;
  conflictRenamedCount: number;
  targetDirectoryPath: string;
  files: BridgeNotesVaultFileTransferItem[];
  errors: BridgeNotesVaultFileTransferError[];
};

export type BridgeDroppedPathInfo = {
  path: string;
  isFile: boolean;
  isDir: boolean;
};

export type BridgeStorageUsage = {
  app_data_dir: string;
  db_size_bytes: number;
  asset_library_size_bytes: number;
  thumbnail_size_bytes: number;
  canvas_size_bytes: number;
  generated_media_size_bytes: number;
  other_data_size_bytes: number;
  backup_size_bytes: number;
  total_size_bytes: number;
  asset_count: number;
  note_count: number;
  tag_count: number;
  collection_count: number;
};

export type BridgeClearCacheResult = {
  removed_bytes: number;
  removed_files: number;
};

export type BridgeClearAllDataResult = {
  backup_id: string;
  cleared_tables: string[];
  removed_bytes: number;
  removed_files: number;
};

export type BridgeImportFolderResult = {
  importedCount: number;
  skippedDuplicateCount: number;
  failedCount: number;
  failedItems: Array<{ file: string; code?: string; error: string }>;
};

export type BridgeMissingAsset = {
  id: string;
  name: string;
  libraryPath: string;
};

export type BridgeRemoveResult = {
  success: boolean;
  fileStillExists: boolean;
};

export type BridgeAssetFilter = {
  kinds?: string[];
  tag_ids?: string[];
  folder_id?: string;
  recent_only?: boolean;
  date_from?: string;
  date_to?: string;
  rating_min?: number;
  dominant_color?: string;
  limit?: number;
};

export type BridgeCollectionItem = {
  id: string;
  type: "text" | "link" | "file" | "image";
  content: string;
  assetId: string | null;
  urlMetadata: string | null;
  source: string | null;
  createdAt: string;
  processedAt: string | null;
  processedNoteId: string | null;
  processedAction: string | null;
  thumbnail: string | null;
  browser: string | null;
  trigger: string | null;
};

/** Canvas's existing material catalog is fixed, independent of materials-page selection. */
export type BridgeCanvasFolder = { id: string; name: string; parentId: string | null };
export type BridgeCanvasMaterialDestination = { catalogId: "legacy-material-catalog"; folderId: string | null };
export type BridgeCanvasMaterialFolders = { catalogId: "legacy-material-catalog"; folders: BridgeCanvasFolder[] };
export type BridgeCanvasKnowledgeFolders = {
  vaultId: string | null;
  folders: BridgeCanvasFolder[];
  noteFolderIds: Record<string, string | null>;
};

export type LuckyRayBridge = {
  importAssets: (options?: MaterialImportOptions) => Promise<{ assets: BridgeAsset[]; source: "tauri" | "browser"; skippedDuplicates: number }>;
  importDroppedFiles: (files: File[] | FileList, options?: MaterialImportOptions) => Promise<{ assets: BridgeAsset[]; source: "tauri" | "browser"; skippedDuplicates: number; errors?: Array<{ name: string; error: string }> }>;
  listAssets: () => Promise<BridgeAsset[]>;
  listCanvasAssets?: () => Promise<BridgeAsset[]>;
  listCanvasMaterialFolders?: () => Promise<BridgeCanvasMaterialFolders>;
  listCanvasKnowledgeFolders?: () => Promise<BridgeCanvasKnowledgeFolders>;
  getAssetsByIds: (assetIds: string[]) => Promise<BridgeAsset[]>;
  getMaterialChangeState: () => Promise<MaterialChange | null>;
  updateAsset: (id: string, patch: BridgeAssetPatch) => Promise<BridgeAsset | null>;
  selectAssetFile: () => Promise<string | null>;
  relocateAsset: (id: string, path: string, options?: MaterialRelocateOptions) => Promise<BridgeAsset | null>;
  renameAssetFile: (id: string, fileName: string) => Promise<BridgeAsset | null>;
  deleteAsset: (id: string, options?: { deleteFile?: boolean }) => Promise<void>;
  revealAssetPath: (path: string) => Promise<boolean>;
  openFilePath: (path: string) => Promise<boolean>;
  openNotesVaultMarkdownFileWithDefaultApp: (input: { vault: BridgeVaultMetadata; relativePath: string }) => Promise<void>;
  notesVaultAssetExists: (input: { vault: BridgeVaultMetadata; relativePath: string }) => Promise<BridgeNotesVaultAssetExistsResult>;
  notesVaultFindAssetCandidates: (input: { vault: BridgeVaultMetadata; target: string; currentRelativePath: string }) => Promise<BridgeNotesVaultAssetCandidateResult[]>;
  openExternalUrl: (url: string) => Promise<void>;
  getAssetPreviewUrl: (path: string) => Promise<string>;
  listFolders: (scope?: "materials" | "notes") => Promise<BridgeFolderNode[]>;
  createFolder: (input: CreateFolderInput) => Promise<BridgeFolder>;
  renameFolder: (id: string, name: string) => Promise<BridgeFolder | null>;
  deleteFolder: (id: string) => Promise<void>;
  moveFolder: (input: MoveFolderInput) => Promise<void>;
  moveAssetToFolder: (input: MoveAssetToFolderInput) => Promise<void>;
  moveNoteToFolder: (input: MoveNoteToFolderInput) => Promise<void>;
  listTags: () => Promise<BridgeTag[]>;
  listKnowledgeTags: () => Promise<BridgeTag[]>;
  createKnowledgeTag: (input: { name: string }) => Promise<BridgeTag>;
  createTag: (input: CreateTagInput) => Promise<BridgeTag>;
  renameTag: (id: string, name: string) => Promise<BridgeTag | null>;
  updateTag: (id: string, patch: UpdateTagInput) => Promise<BridgeTag | null>;
  mergeTags: (targetId: string, sourceIds: string[]) => Promise<void>;
  deleteTag: (id: string) => Promise<void>;
  setAssetTags: (assetId: string, tagIds: string[]) => Promise<string[]>;
  setNoteTags: (noteId: string, tagIds: string[]) => Promise<string[]>;
  addKnowledgeTag: (noteId: string, name: string) => Promise<string[]>;
  removeKnowledgeTag: (noteId: string, tagId: string) => Promise<string[]>;
  getAssetTags: (assetId: string) => Promise<string[]>;
  getNoteTags: (noteId: string) => Promise<string[]>;
  listItemTagMap: (itemType: "asset" | "note", itemIds?: string[]) => Promise<Record<string, string[]>>;
  listNotes: () => Promise<BridgeNote[]>;
  getNote: (id: string) => Promise<BridgeNote | null>;
  getNoteById: (id: string) => Promise<BridgeNote | null>;
  createNote: (input?: CreateNoteInput) => Promise<BridgeNote>;
  importNotesMarkdown: (options?: { folderId?: string | null; paths?: string[] }) => Promise<ImportNotesMarkdownResult>;
  updateNote: (id: string, patch: UpdateNoteInput) => Promise<BridgeNote | null>;
  deleteNote: (id: string) => Promise<void>;
  // Compatibility shape backed by the Knowledge index.
  getNotesForAsset: (assetId: string) => Promise<BridgeNote[]>;
  getAssetsForNote: (noteId: string) => Promise<BridgeAsset[]>;
  getNoteLinks: (noteId: string) => Promise<Array<{ targetTitle: string; toNoteId: string | null; isMissing: number }>>;
  getNoteEmbeds: (noteId: string) => Promise<Array<{ targetName: string; assetId: string | null; isMissing: number }>>;
  getGraphRelations: () => Promise<{
    links: Array<{ fromNoteId: string; targetTitle: string; toNoteId: string | null; isMissing: number }>;
    embeds: Array<{ noteId: string; targetName: string; assetId: string | null; isMissing: number }>;
  }>;
  getNotesLinkingToNote: (noteId: string) => Promise<Array<{ id: string; title: string; updatedAt: string; snippet?: string }>>;
  getUnlinkedNoteMentions: (noteId: string) => Promise<Array<{ id: string; title: string; updatedAt: string; snippet: string }>>;
  search: (query: string, options?: { limit?: number }) => Promise<BridgeSearchResults>;
  searchGlobal: (query: string) => Promise<{ notes: Array<{ id: string; title: string; snippet: string; updatedAt: string; folderId: string | null }>; assets: Array<{ id: string; name: string; snippet: string; kind: string; sizeBytes: number | null; thumbnailUrl: string }>; collection: Array<{ id: string; content: string; snippet: string; type: string; source: string | null; processedAction: string | null; url: string | null; updatedAt: string }>; tags: Array<{ id: string; name: string; noteCount: number }> }>;
  searchNotesForGlobal: (query: string, options?: { limit?: number }) => Promise<Array<{ id: string; title: string; snippet: string; updatedAt: string; folderId: string | null }>>;
  searchCollectionBoxForGlobal: (query: string, options?: { limit?: number }) => Promise<Array<{ id: string; content: string; snippet: string; type: string; source: string | null; processedAction: string | null; url: string | null; updatedAt: string }>>;
  getSettings: () => Promise<BridgeSettings>;
  setSettings: (patch: Partial<BridgeSettings>) => Promise<BridgeSettings>;
  aiChatComplete: (messages: Array<{ role: string; content: BridgeAiMessageContent }>, options?: { systemPrompt?: string; temperature?: number; maxTokens?: number; model?: string }) => Promise<BridgeAiChatResponse>;
  notesInlineGenerate: (action: "rewrite" | "shorten" | "expand" | "continue") => Promise<BridgeNotesInlinePreview>;
  notesInlineApply: (previewId: string, mode: "replace" | "insert-below") => Promise<BridgeNotesInlineApplyResult>;
  notesInlineDiscard: (previewId: string) => Promise<void>;
  notesInlineCancel: () => Promise<boolean>;
  aiImageGenerate: (request: import("../canvas/generationTasks").CanvasGenerationRequestSnapshot) => Promise<import("../canvas/imageGenerationAdapter").CanvasImageGenerationResponse>;
  aiVideoGenerate: (
    request: import("../canvas/generationTasks").CanvasGenerationRequestSnapshot,
    onProgress?: (progress: import("../canvas/videoGenerationAdapter").CanvasVideoGenerationProgress) => void,
    providerTaskId?: string,
    clientTaskId?: string,
  ) => Promise<import("../canvas/videoGenerationAdapter").CanvasVideoGenerationResponse>;
  /** Persist one local PNG slice using the existing generated-image storage. */
  storeCanvasImageSlice?: (png: string) => Promise<string>;
  saveCanvasGenerationToLibrary: (
    candidate: import("../canvas/generationHistory").CanvasGenerationLibraryCandidate,
    destination?: BridgeCanvasMaterialDestination,
  ) => Promise<{ success: boolean; assetId?: string; message?: string }>;
  listAiConversations: () => Promise<BridgeAiConversation[]>;
  createAiConversation: (title?: string) => Promise<BridgeAiConversation>;
  deleteAiConversation: (id: string) => Promise<void>;
  getAiMessages: (conversationId: string) => Promise<BridgeAiMessage[]>;
  appendAiMessage: (conversationId: string, role: "user" | "assistant" | "system", content: string) => Promise<BridgeAiMessage>;
  appendAiConversationPair: (conversationId: string, userContent: string, assistantContent: string) => Promise<[BridgeAiMessage, BridgeAiMessage]>;
  updateAiConversationTitle: (id: string, title: string) => Promise<BridgeAiConversation | null>;
  getAppDataDir: () => Promise<string>;
  getCollectionServerBaseUrl: () => Promise<string>;
  getLocalTransportClientConfig: () => Promise<{ baseUrl: string; credential: string; protocolVersion: number }>;
  openDirectory: (path: string) => Promise<void>;
  selectVaultDirectory: () => Promise<string | null>;
  getCurrentNotesVault: () => Promise<BridgeVaultMetadata | null>;
  createNotesVault: (rootPath: string) => Promise<BridgeVaultMetadata>;
  openNotesVault: (rootPath: string) => Promise<BridgeOpenVaultResult>;
  listNotesVaultFiles: (vault: BridgeVaultMetadata) => Promise<BridgeNotesVaultFileNode>;
  getNotesVaultMarkdownIndex: (vault: BridgeVaultMetadata) => Promise<BridgeNotesVaultMarkdownIndex>;
  createNotesVaultFolder: (input: { vault: BridgeVaultMetadata; parentRelativePath: string; name: string }) => Promise<BridgeNotesVaultFileNode>;
  createNotesVaultMarkdownFile: (input: { vault: BridgeVaultMetadata; parentRelativePath: string; name: string }) => Promise<BridgeNotesVaultMarkdownFile>;
  readNotesVaultMarkdownFile: (input: { vault: BridgeVaultMetadata; relativePath: string }) => Promise<BridgeNotesVaultMarkdownFile>;
  writeNotesVaultMarkdownFile: (input: { vault: BridgeVaultMetadata; relativePath: string; contentText: string }) => Promise<BridgeNotesVaultWriteResult>;
  renameNotesVaultMarkdownFile: (input: { vault: BridgeVaultMetadata; relativePath: string; newName: string }) => Promise<BridgeNotesVaultMarkdownFile>;
  renameNotesVaultFolder: (input: { vault: BridgeVaultMetadata; relativePath: string; newName: string }) => Promise<BridgeNotesVaultFileNode>;
  moveNotesVaultMarkdownFile: (input: { vault: BridgeVaultMetadata; relativePath: string; targetParentRelativePath: string }) => Promise<BridgeNotesVaultMarkdownFile>;
  moveNotesVaultFolder: (input: { vault: BridgeVaultMetadata; relativePath: string; targetParentRelativePath: string }) => Promise<BridgeNotesVaultFileNode>;
  deleteNotesVaultMarkdownFile: (input: { vault: BridgeVaultMetadata; relativePath: string }) => Promise<BridgeNotesVaultDeleteResult>;
  deleteNotesVaultEmptyFolder: (input: { vault: BridgeVaultMetadata; relativePath: string }) => Promise<BridgeNotesVaultDeleteResult>;
  classifyDroppedPaths: (paths: string[]) => Promise<BridgeDroppedPathInfo[]>;
  importNotesVaultMarkdownFiles: (input: { vault: BridgeVaultMetadata; targetParentRelativePath: string; sourcePaths?: string[] }) => Promise<BridgeNotesVaultImportMarkdownResult>;
  importNotesVaultMarkdownFolder: (input: { vault: BridgeVaultMetadata; targetParentRelativePath: string; sourceDirectoryPath?: string }) => Promise<BridgeNotesVaultImportMarkdownResult>;
  exportNotesVaultMarkdownFile: (input: { vault: BridgeVaultMetadata; relativePath: string; targetDirectoryPath?: string }) => Promise<BridgeNotesVaultExportMarkdownResult>;
  exportNotesVaultMarkdownFolder: (input: { vault: BridgeVaultMetadata; relativePath: string; targetDirectoryPath?: string }) => Promise<BridgeNotesVaultExportMarkdownResult>;
  getAutoLaunchEnabled: () => Promise<boolean>;
  setAutoLaunchEnabled: (enabled: boolean) => Promise<void>;
  getStorageUsage: () => Promise<BridgeStorageUsage>;
  clearThumbnailCache: () => Promise<BridgeClearCacheResult>;
  clearAllData: () => Promise<BridgeClearAllDataResult>;
  // D16 数据安全
  createBackup: () => Promise<BridgeBackupInfo>;
  listBackups: () => Promise<BridgeBackupInfo[]>;
  restoreBackup: (backupId: string) => Promise<string>;
  exportNotesMarkdown: (options?: ExportNotesMarkdownOptions) => Promise<BridgeExportResult>;
  exportAssetsIndex: () => Promise<BridgeExportResult>;
  // D17 素材库完善
  selectImportFolder: () => Promise<string | null>;
  importFolder: (path: string, options?: MaterialFolderImportOptions) => Promise<BridgeImportFolderResult>;
  scanMissingAssets: () => Promise<BridgeMissingAsset[]>;
  removeAssetRecord: (id: string) => Promise<BridgeRemoveResult>;
  listAssetsFiltered: (filters: BridgeAssetFilter) => Promise<BridgeAsset[]>;
  // D21 收集箱
  collectionAddText: (content: string) => Promise<BridgeCollectionItem>;
  collectionAddLink: (url: string) => Promise<BridgeCollectionItem>;
  collectionAddClipboard: (type: "text" | "image") => Promise<BridgeCollectionItem | null>;
  collectionList: (filter?: { type?: string; unprocessedOnly?: boolean }) => Promise<BridgeCollectionItem[]>;
  collectionDelete: (id: string) => Promise<void>;
  collectionMarkInsertedToNote: (id: string, noteId: string) => Promise<void>;
  collectionMarkDeleted: (id: string) => Promise<void>;
  // D24 批量操作
  collectionBatchUpdate: (ids: string[], action: string) => Promise<number>;
  collectionRestore: (id: string) => Promise<void>;
  collectionSingleToNote: (id: string, title: string) => Promise<{ noteId: string; assetId?: string | null; assetName?: string | null } | null>;
  collectionBatchToNote: (ids: string[], title: string) => Promise<{ noteId: string; count: number; assetIds?: string[] } | null>;
  // D25 图片素材化
  importImageToAssets: (url: string) => Promise<{ success: boolean; asset_id?: string; asset_name?: string; skipped?: string; error?: string }>;
  collectionImportImageToAssets: (id: string, url?: string) => Promise<{ success: boolean; asset_id?: string; asset_name?: string; skipped?: string; error?: string }>;
  collectionMarkMovedToAssets: (id: string, assetId: string) => Promise<void>;
  // D32 AI 标签/摘要建议
  generateAssetAiSuggestion: (assetId: string) => Promise<{ summary?: string; auto_tags: string[]; status: string; error?: string } | null>;
  generateNoteAiSuggestion: (noteId: string) => Promise<{ summary?: string; auto_tags: string[]; status: string; error?: string } | null>;
  getAssetAiSuggestion: (assetId: string) => Promise<{ summary?: string; auto_tags: string[]; status: string; error?: string; processed_at?: string } | null>;
  getNoteAiSuggestion: (noteId: string) => Promise<{ summary?: string; auto_tags: string[]; status: string; error?: string; processed_at?: string } | null>;
  applyAiTags: (itemType: "asset" | "note", itemId: string, tagNames: string[]) => Promise<void>;
  dismissAiSuggestion: (itemType: "asset" | "note", itemId: string) => Promise<void>;
  // D35 记忆系统
  createMemoryView: (content: string) => Promise<void>;
  updateMemoryView: (entryRef: string, patch: { content?: string; pinned?: boolean }) => Promise<void>;
  deleteMemoryView: (entryRef: string) => Promise<void>;
  listMemoryViews: (view: MemoryViewId) => Promise<MemoryEntryView[]>;
  searchMemoryViews: (view: MemoryViewId, query: string) => Promise<MemoryEntryView[]>;
  // D65 正式画布 MVP：文件存储
  getCanvasStorageDir: () => Promise<string>;
  checkCanvasFiles: () => Promise<BridgeCanvasStorageCheck>;
  listCanvases: () => Promise<Array<BridgeCanvasListEntry>>;
  loadCanvas: (canvasId: string) => Promise<BridgeCanvasFile>;
  saveCanvas: (canvas: BridgeCanvasFile) => Promise<BridgeCanvasListEntry>;
  createCanvas: (name?: string) => Promise<BridgeCanvasListEntry>;
  renameCanvas: (canvasId: string, name: string) => Promise<BridgeCanvasListEntry | null>;
  deleteCanvas: (canvasId: string) => Promise<void>;
  saveCanvasThumbnail: (canvasId: string, data: Uint8Array) => Promise<void>;
  deleteCanvasThumbnail: (canvasId: string) => Promise<void>;
  listFavoriteItems: (itemType: FavoriteItemType) => Promise<FavoriteItem[]>;
  getFavoriteItemCounts: () => Promise<FavoriteItemCounts>;
  addFavoriteItem: (itemType: FavoriteItemType, itemId: string) => Promise<FavoriteItem>;
  updateFavoriteItem: (itemType: FavoriteItemType, itemId: string, theme: string, copy: string) => Promise<FavoriteItem>;
  removeFavoriteItem: (itemType: FavoriteItemType, itemId: string) => Promise<FavoriteRemoval>;
  listSmartFolders: () => Promise<SmartFolderDefinition[]>;
  createSmartFolder: (input: SmartFolderDefinitionInput) => Promise<SmartFolderDefinition>;
  updateSmartFolder: (id: string, input: SmartFolderDefinitionInput) => Promise<SmartFolderDefinition>;
  deleteSmartFolder: (id: string) => Promise<boolean>;
};

export type FavoriteItemType = "material" | "note" | "canvas";

export type FavoriteItem = {
  itemType: FavoriteItemType;
  itemId: string;
  theme: string;
  copy: string;
  favoritedAt: string;
  noteUpdatedAt: string | null;
};

export type FavoriteItemCounts = Record<FavoriteItemType, number>;

export type FavoriteRemoval = {
  removed: boolean;
  hadNotes: boolean;
};

export type BridgeCanvasListEntry = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
  edgeCount: number;
  coverVersion: number;
  coverKind: "image" | "video" | null;
  coverUrl: string | null;
  coverPoster: string | null;
  revision: number;
  contentDigest: string;
};

export type BridgeNotesInlinePreview = {
  previewId: string;
  action: "rewrite" | "shorten" | "expand" | "continue";
  originalText: string;
  replacementText: string;
  defaultMode: "replace" | "insert-below";
  expiresInSeconds: number;
};

export type BridgeNotesInlineApplyResult = {
  content: string;
  revision: string;
  startUtf16: number;
  endUtf16: number;
  insertedText: string;
  committedWarning: boolean;
};

export type BridgeCanvasFile = {
  schemaVersion: number;
  revision?: number;
  contentDigest?: string;
  canvasId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  nodes: unknown; // 节点 JSON，结构与 React Flow SpikeNode 兼容
  edges: unknown; // 边 JSON
  viewport: { x: number; y: number; zoom: number };
  generationHistory: unknown;
};

export type BridgeCanvasStorageCheck = {
  ok: boolean;
  storageDir: string;
  canvasCount: number;
  checkedFiles: number;
  issues: string[];
};

export type BridgeAssetPatch = Partial<Pick<BridgeAsset, "name" | "description" | "rating" | "dominantColor">>;

export type MemoryViewId = "all" | "global" | "current-vault";

export type MemoryEntryView = {
  entryRef: string;
  content: string;
  sourceLabel: string;
  pinned: boolean;
  expiryLabel: string;
  scopeLabel: string;
};
