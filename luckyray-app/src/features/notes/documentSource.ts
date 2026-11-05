import type { KnowledgeSourceMode, KnowledgeTreeNode } from "../../core/bridge/knowledgeTypes";
import { isMacPlatform, joinMacPath } from "../../app/macosPresentation";
import { readActiveKnowledgeWriteSource } from "../../core/services/knowledgeSource";
import { macFolderClient, type MacFolderClient, type MacFolderMutationInput, type MacFolderMutationResult, type MacFolderRecovery } from "../../core/services/macFolderMutations";
import { folderContainsPath } from "./macFolderRuntime";
import {
  readKnowledgeDocument,
  replaceKnowledgeDocument,
  moveKnowledgeDocument,
  deleteKnowledgeDocument,
  ensureActiveKnowledgeUiSource,
  type KnowledgeDocumentSnapshot,
} from "../../core/services/knowledge";

export type KnowledgeDocument = {
  id: string;
  title: string;
  contentText: string;
  source: KnowledgeSourceMode;
  relativePath?: string;
  absolutePath?: string;
  updatedAt?: string;
  revision?: string;
  fileIdentity?: string;
  workspaceSourceId?:string;
  raw?: unknown;
};

export type KnowledgeMutationResult = {
  ok: boolean;
  code: string;
  message: string;
  source: KnowledgeSourceMode;
  relativePath?: string;
  absolutePath?: string;
  raw?: unknown;
};

export class KnowledgeSourceError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "KnowledgeSourceError";
    this.code = code;
  }
}
export class KnowledgeFolderOperationError extends KnowledgeSourceError {
  result?: MacFolderMutationResult;
  constructor(code: string, message: string, result?: MacFolderMutationResult) {
    super(code, message);
    this.name = "KnowledgeFolderOperationError";
    this.result = result;
  }
}
export function acceptWorkspaceSourceProof(previous:string|undefined,incoming:string|undefined):string|undefined{
  if(incoming===undefined)return previous;
  if(!/^note-source-v1:[a-f0-9]{64}$/.test(incoming))throw new KnowledgeSourceError('knowledge-document-source-invalid','Document read source proof is invalid');
  if(previous&&previous!==incoming)throw new KnowledgeSourceError('knowledge-document-source-changed','The document belongs to a replaced Vault source; reopen it before transfer');
  return incoming;
}

export type KnowledgeDocumentRef = string | KnowledgeDocument | { id?: string; relativePath?: string; revision?: string; fileIdentity?: string; vaultId?: string };
export type KnowledgeFolderRef = string | KnowledgeTreeNode | { id?: string; relativePath?: string } | null | undefined;
export type KnowledgeFolderNode = KnowledgeTreeNode & { folderOperation?: MacFolderMutationResult };

export type DocumentSourceAdapter = {
  mode: KnowledgeSourceMode;
  listTree: () => Promise<KnowledgeTreeNode[]>;
  createDocument: (parentIdOrPath?: string | null, title?: string) => Promise<KnowledgeDocument>;
  createFolder: (parentIdOrPath?: string | null, name?: string) => Promise<KnowledgeTreeNode>;
  openDocument: (idOrPath: string) => Promise<KnowledgeDocument>;
  saveDocument: (documentRef: KnowledgeDocumentRef, contentText: string) => Promise<KnowledgeDocument>;
  renameDocument: (documentRef: KnowledgeDocumentRef, newTitle: string) => Promise<KnowledgeDocument>;
  renameFolder: (folderRef: KnowledgeFolderRef, newName: string) => Promise<KnowledgeFolderNode>;
  moveDocument: (documentRef: KnowledgeDocumentRef, targetFolderRef?: KnowledgeFolderRef) => Promise<KnowledgeDocument>;
  moveFolder: (folderRef: KnowledgeFolderRef, targetFolderRef?: KnowledgeFolderRef) => Promise<KnowledgeFolderNode>;
  deleteDocument: (documentRef: KnowledgeDocumentRef) => Promise<KnowledgeMutationResult>;
  deleteFolder: (folderRef: KnowledgeFolderRef) => Promise<KnowledgeMutationResult>;
  prepareFolderMutation?: (folderRef: KnowledgeFolderRef) => Promise<void>;
  listFolderRecoveries?: () => Promise<MacFolderRecovery[]>;
  restoreFolder?: (operationId: string) => Promise<MacFolderMutationResult>;
};

type VaultMetadataLike = {
  id: string;
  name: string;
  rootPath: string;
  mode: string;
  createdAt: string;
  lastOpenedAt: string;
  schemaVersion: number;
};

type VaultFileNodeLike = {
  kind: "folder" | "file";
  name: string;
  relativePath: string;
  absolutePath: string;
  children: VaultFileNodeLike[];
  mtime: string | null;
  size: number;
};

type VaultMarkdownFileLike = {
  name: string;
  relativePath: string;
  absolutePath: string;
  contentText: string;
  mtime: string | null;
  size: number;
};

type VaultDeleteResultLike = {
  relativePath: string;
  absolutePath: string;
  deleted: boolean;
  message: string;
};

type VaultBridge = {
  listNotesVaultFiles?: (vault: VaultMetadataLike) => Promise<VaultFileNodeLike>;
  createNotesVaultFolder?: (input: { vault: VaultMetadataLike; parentRelativePath: string; name: string; sourceEpoch?: number }) => Promise<VaultFileNodeLike>;
  createNotesVaultMarkdownFile?: (input: { vault: VaultMetadataLike; parentRelativePath: string; name: string }) => Promise<VaultMarkdownFileLike>;
  readNotesVaultMarkdownFile?: (input: { vault: VaultMetadataLike; relativePath: string }) => Promise<VaultMarkdownFileLike>;
  renameNotesVaultMarkdownFile?: (input: { vault: VaultMetadataLike; relativePath: string; newName: string }) => Promise<VaultMarkdownFileLike>;
  renameNotesVaultFolder?: (input: { vault: VaultMetadataLike; relativePath: string; newName: string }) => Promise<VaultFileNodeLike>;
  moveNotesVaultMarkdownFile?: (input: { vault: VaultMetadataLike; relativePath: string; targetParentRelativePath: string }) => Promise<VaultMarkdownFileLike>;
  moveNotesVaultFolder?: (input: { vault: VaultMetadataLike; relativePath: string; targetParentRelativePath: string }) => Promise<VaultFileNodeLike>;
  deleteNotesVaultMarkdownFile?: (input: { vault: VaultMetadataLike; relativePath: string }) => Promise<VaultDeleteResultLike>;
  deleteNotesVaultEmptyFolder?: (input: { vault: VaultMetadataLike; relativePath: string }) => Promise<VaultDeleteResultLike>;
};

function markdownDisplayTitle(name: string) {
  return name.replace(/\.md$/i, "") || name;
}

function vaultFileToDocument(file: VaultMarkdownFileLike): KnowledgeDocument {
  return {
    id: file.relativePath,
    title: markdownDisplayTitle(file.name),
    contentText: file.contentText || "",
    source: "real-vault",
    relativePath: file.relativePath,
    absolutePath: file.absolutePath,
    updatedAt: file.mtime || undefined,
    raw: file,
  };
}

function vaultNodeToTreeNode(node: VaultFileNodeLike): KnowledgeTreeNode {
  return {
    id: node.relativePath || node.absolutePath,
    kind: node.kind === "folder" ? "folder" : "document",
    title: node.kind === "folder" ? node.name : markdownDisplayTitle(node.name),
    relativePath: node.relativePath,
    absolutePath: node.absolutePath,
    children: node.children?.map(vaultNodeToTreeNode) || [],
    updatedAt: node.mtime || undefined,
    source: "real-vault",
  };
}

function documentId(ref: KnowledgeDocumentRef) {
  if (typeof ref === "string") return ref;
  const id = ref.relativePath || ref.id;
  if (!id) throw new KnowledgeSourceError("invalid-document-ref", "Document reference is missing");
  return id;
}

function folderId(ref: KnowledgeFolderRef) {
  if (ref == null) return null;
  if (typeof ref === "string") return ref || null;
  const id = ref.relativePath || ref.id;
  return id || null;
}

function mutationResult(source: KnowledgeSourceMode, code: string, message: string, raw?: unknown, relativePath?: string, absolutePath?: string): KnowledgeMutationResult {
  return { ok: true, code, message, source, raw, relativePath, absolutePath };
}

type RevisionedDocuments = {
  read: typeof readKnowledgeDocument;
  replace: typeof replaceKnowledgeDocument;
  move?: typeof moveKnowledgeDocument;
  delete?: typeof deleteKnowledgeDocument;
};

export function createRealVaultDocumentSource(input: {
  bridge: VaultBridge | null | undefined;
  vault: VaultMetadataLike | null;
  documents?: RevisionedDocuments;
  readSource?: typeof readActiveKnowledgeWriteSource;
  ensureSource?: typeof ensureActiveKnowledgeUiSource;
  folders?: MacFolderClient;
}): DocumentSourceAdapter {
  const { bridge, vault } = input;
  const readSource = input.readSource ?? readActiveKnowledgeWriteSource;
  const ensureSource = input.ensureSource ?? ensureActiveKnowledgeUiSource;
  const folders = input.folders ?? macFolderClient;
  const documents = {
    read: input.documents?.read ?? readKnowledgeDocument,
    replace: input.documents?.replace ?? replaceKnowledgeDocument,
    move: input.documents ? input.documents.move : moveKnowledgeDocument,
    delete: input.documents ? input.documents.delete : deleteKnowledgeDocument,
  };
  // Preserve ID-only callers that have already opened the document. Explicit
  // snapshots take precedence so a background read cannot silently rebase a draft.
  const openedRevisions = new Map<string, string>();
  const openedFileIdentities = new Map<string, string>();
  const openedSourceProofs=new Map<string,string>();
  let folderCacheGeneration = 0;
  let retiringFolder: string | null = null;
  const folderSelections = new Map<string, { source: ReturnType<typeof readSource>; sourceEpoch: number; proof: string }>();
  const folderSelectionRequests = new Map<string, symbol>();
  const requireVault = () => {
    if (!vault) throw new KnowledgeSourceError("source-not-ready", "Open or create a vault first");
    return vault;
  };
  const folderActivation = async () => {
    const currentVault = requireVault(), origin = readSource();
    if (origin?.mode !== "real-vault" || origin.vaultId !== currentVault.id
        || (origin.rootPath && origin.rootPath !== currentVault.rootPath))
      throw new KnowledgeSourceError("knowledge-source-inactive", "请先打开当前知识库再操作文件夹。");
    const activation = await ensureSource();
    if (readSource() !== origin || activation.vaultId !== currentVault.id)
      throw new KnowledgeSourceError("knowledge-source-inactive", "知识库已切换，请重新选择文件夹。");
    return { origin, sourceEpoch: activation.sourceEpoch };
  };
  const invalidateFolderReads = (relativePath: string) => {
    folderCacheGeneration += 1;
    for (const cache of [openedRevisions, openedFileIdentities, openedSourceProofs])
      for (const path of cache.keys()) if (folderContainsPath(relativePath, path)) cache.delete(path);
  };
  const checkedFolderPath = (path: string, allowRoot = false) => {
    if ((allowRoot && path === "") || (path && path === path.trim() && !/[\\\p{Cc}]/u.test(path)
      && path.split("/").every(part => part && part !== "." && part !== ".."))) return path;
    throw new KnowledgeSourceError("knowledge-invalid-path", "文件夹路径不明确，请刷新目录后重新选择。");
  };
  const acceptFolderResult = (result: MacFolderMutationResult, origin: ReturnType<typeof readSource>) => {
    if (readSource() !== origin)
      throw new KnowledgeFolderOperationError("knowledge-folder-recovery-required", "知识库已切换；文件夹操作结果保留在原知识库的“文件夹恢复”中，请先检查再重试。", result);
    if (result.state !== "completed")
      throw new KnowledgeFolderOperationError(result.state === "unchanged" ? "knowledge-folder-unchanged" : "knowledge-folder-recovery-required",
        result.message || (result.state === "unchanged" ? "文件夹没有改变，请刷新目录后重试。" : "文件夹操作尚未确认，请查看“文件夹恢复”，不要重复操作。"), result);
    return result;
  };
  const mutateMacFolder = async (relativePath: string, operation: MacFolderMutationInput["operation"], extra: { newName?: string; targetParentRelativePath?: string } = {}) => {
    checkedFolderPath(relativePath);
    if (extra.targetParentRelativePath !== undefined) checkedFolderPath(extra.targetParentRelativePath, true);
    if (extra.newName !== undefined && (!extra.newName || extra.newName !== extra.newName.trim()
      || extra.newName === "." || extra.newName === ".." || /[\\/:*?"<>|\p{Cc}]/u.test(extra.newName)))
      throw new KnowledgeSourceError("knowledge-invalid-title", "文件夹名称无效。");
    if (retiringFolder) throw new KnowledgeSourceError("knowledge-folder-busy", "正在处理另一个文件夹，请稍后重试。");
    const selected = folderSelections.get(relativePath);
    folderSelections.delete(relativePath);
    if (!selected || selected.source !== readSource())
      throw new KnowledgeSourceError("knowledge-folder-selection-required", "请重新打开文件夹操作菜单，确认当前文件夹后再操作。");
    const { origin, sourceEpoch } = await folderActivation();
    if (selected.source !== origin || selected.sourceEpoch !== sourceEpoch)
      throw new KnowledgeSourceError("knowledge-source-inactive", "知识库已重新打开，请重新选择文件夹。");
    if (retiringFolder) throw new KnowledgeSourceError("knowledge-folder-busy", "正在处理另一个文件夹，请稍后重试。");
    retiringFolder = relativePath;
    invalidateFolderReads(relativePath);
    try {
      const result = await folders.mutate({ sourceEpoch, relativePath, operation, expectedSelection: selected.proof, ...extra });
      if (result.oldRelativePath !== relativePath || result.operation !== operation)
        throw new KnowledgeFolderOperationError("knowledge-folder-recovery-required", "文件夹操作回执不匹配，请查看“文件夹恢复”。", result);
      if (result.newRelativePath) invalidateFolderReads(result.newRelativePath);
      return acceptFolderResult(result, origin);
    } finally {
      invalidateFolderReads(relativePath);
      retiringFolder = null;
    }
  };
  const folderNodeFromResult = (result: MacFolderMutationResult): KnowledgeFolderNode => {
    const path = result.newRelativePath;
    if (!path) throw new KnowledgeFolderOperationError("knowledge-folder-recovery-required", "文件夹的新位置未确认，请查看“文件夹恢复”。", result);
    return { id: path, kind: "folder", title: path.slice(path.lastIndexOf("/") + 1), relativePath: path,
      absolutePath: joinMacPath(requireVault().rootPath, path), children: [], source: "real-vault", folderOperation: result };
  };
  const remember = (document: KnowledgeDocument) => {
    const path = document.relativePath || document.id;
    if (document.revision) openedRevisions.set(path, document.revision);
    if (document.fileIdentity) openedFileIdentities.set(path, document.fileIdentity);
    else openedFileIdentities.delete(path);
    return document;
  };
  const fromSnapshot = (snapshot: KnowledgeDocumentSnapshot, relativePath: string): KnowledgeDocument => {
    const currentVault = requireVault();
    if (snapshot.documentRef.vaultId !== currentVault.id
      || snapshot.documentRef.relativePath !== relativePath || !snapshot.revision) {
      throw new KnowledgeSourceError("knowledge-document-identity-mismatch", "Document response does not match the requested Vault and path");
    }
    const separator = currentVault.rootPath.includes("\\") ? "\\" : "/";
    const workspaceSourceId=acceptWorkspaceSourceProof(openedSourceProofs.get(relativePath),snapshot.workspaceSourceId);
    if(workspaceSourceId)openedSourceProofs.set(relativePath,workspaceSourceId);
    const fileIdentity = (snapshot as { fileIdentity?: string }).fileIdentity
      || (snapshot as { summary?: { fileIdentity?: string } }).summary?.fileIdentity;
    if (fileIdentity) openedFileIdentities.set(relativePath, fileIdentity);
    return remember({
      id: relativePath,
      title: snapshot.title,
      contentText: snapshot.content,
      source: "real-vault",
      relativePath,
      absolutePath: isMacPlatform() ? joinMacPath(currentVault.rootPath, relativePath)
        : `${currentVault.rootPath.replace(/[\\/]+$/, "")}${separator}${relativePath.split("/").join(separator)}`,
      updatedAt: snapshot.modifiedAt || undefined,
      revision: snapshot.revision,
      ...(fileIdentity ? { fileIdentity } : {}),
      workspaceSourceId,
      raw: snapshot,
    });
  };
  const fromLegacyFile = async (file: VaultMarkdownFileLike) => {
    // Legacy create/move/rename responses contain the exact UTF-8 file text.
    // Hash those returned bytes, never reread and adopt a concurrent edit as the
    // baseline for the caller's next save. Backend CAS uses the same SHA-256.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(file.contentText));
    const revision = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    const fileIdentity = (file as { fileIdentity?: string }).fileIdentity;
    if (fileIdentity) openedFileIdentities.set(file.relativePath, fileIdentity);
    return remember({ ...vaultFileToDocument(file), revision, ...(fileIdentity ? { fileIdentity } : {}) });
  };
  const moveMacDocument = async (documentRef: KnowledgeDocumentRef, targetParentRelativePath: string, newTitle?: string) => {
    const currentVault = requireVault();
    const relativePath = documentId(documentRef);
    if (!documents.move) throw new KnowledgeSourceError("source-not-ready", "Protected note move is unavailable");
    const origin = readSource();
    if (origin && (origin.mode !== "real-vault" || origin.vaultId !== currentVault.id))
      throw new KnowledgeSourceError("knowledge-source-inactive", "Open the current vault before moving a note");
    if (typeof documentRef !== "string" && "vaultId" in documentRef && (documentRef as { vaultId?: string }).vaultId && (documentRef as { vaultId?: string }).vaultId !== currentVault.id) {
      throw new KnowledgeSourceError("knowledge-document-identity-mismatch", "Document belongs to a different vault");
    }
    // The native knowledge service currently treats backslashes as path
    // separators and trims the whole path. Reject ambiguous spellings so a
    // valid macOS filename cannot address a different object by accident.
    if (relativePath.includes("\\") || relativePath !== relativePath.trim()
        || targetParentRelativePath.includes("\\") || targetParentRelativePath !== targetParentRelativePath.trim())
      throw new KnowledgeSourceError("knowledge-invalid-path", "This note or folder path is ambiguous and cannot be moved safely");
    const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const segments = normalized.split("/");
    const basename = segments[segments.length - 1] ?? "";
    if (!normalized || !basename.toLowerCase().endsWith(".md") || basename.includes("/") || basename.includes("\\") || segments.some(s => s === ".." || s === "." || !s)) {
      throw new KnowledgeSourceError("knowledge-invalid-path", "Document path is invalid");
    }
    if (basename.trim() !== basename) {
      throw new KnowledgeSourceError("knowledge-invalid-title", "Document title is not representable");
    }
    const title = newTitle === undefined ? basename : newTitle.trim();
    if (newTitle !== undefined && (!title || title === "." || title === ".." || /^\.md$/i.test(title)
        || /[\\/:*?"<>|\p{Cc}]/u.test(title)))
      throw new KnowledgeSourceError("knowledge-invalid-title", "Document title is invalid");
    const callerRevision = typeof documentRef === "string" ? undefined : documentRef.revision;
    const callerFileIdentity = typeof documentRef === "string" ? undefined : (documentRef as { fileIdentity?: string }).fileIdentity;
    // A string explicitly means the previously opened document. An object
    // without a revision carries no such authority (for example, after a vault
    // session change), so obtain a fresh, session-checked observation instead.
    const useOpenedObservation = typeof documentRef === "string";
    let expectedRevision = callerRevision ?? (useOpenedObservation ? openedRevisions.get(relativePath) : undefined);
    // A revision and file identity must describe the same observation.
    // Never combine an explicit older caller revision with a later cache.
    let expectedFileIdentity = callerRevision !== undefined
      ? callerFileIdentity
      : useOpenedObservation ? openedFileIdentities.get(relativePath) : undefined;
    if (!expectedRevision) {
      const snapshot = await documents.read({ vaultId: currentVault.id, relativePath });
      if (readSource() !== origin)
        throw new KnowledgeSourceError("knowledge-source-inactive", "The vault changed before the move started");
      const observed = fromSnapshot(snapshot, relativePath);
      expectedRevision = observed.revision;
      expectedFileIdentity = observed.fileIdentity;
    }
    if (!expectedRevision) {
      throw new KnowledgeSourceError("knowledge-revision-required", "Open the document before moving it");
    }
    if (!expectedFileIdentity) {
      throw new KnowledgeSourceError("knowledge-identity-unavailable", "Reopen the document before moving it");
    }
    if (readSource() !== origin)
      throw new KnowledgeSourceError("knowledge-source-inactive", "The vault changed before the move started");
    const movedSnapshot = await documents.move(
      { vaultId: currentVault.id, relativePath },
      title,
      expectedRevision,
      targetParentRelativePath,
      expectedFileIdentity,
    );
    openedRevisions.delete(relativePath);
    openedFileIdentities.delete(relativePath);
    const sourceProof = openedSourceProofs.get(relativePath);
    openedSourceProofs.delete(relativePath);
    const newRelativePath = movedSnapshot.documentRef.relativePath;
    if (sourceProof) {
      openedSourceProofs.set(newRelativePath, sourceProof);
    }
    return fromSnapshot(movedSnapshot, newRelativePath);
  };
  return {
    mode: "real-vault",
    async prepareFolderMutation(folderRef) {
      if (!isMacPlatform()) return;
      const relativePath = checkedFolderPath(folderId(folderRef) || "");
      folderSelections.delete(relativePath);
      const request = Symbol(relativePath);
      folderSelectionRequests.set(relativePath, request);
      const { origin, sourceEpoch } = await folderActivation();
      const proof = await folders.prepare(sourceEpoch, relativePath);
      if (readSource() !== origin || folderSelectionRequests.get(relativePath) !== request)
        throw new KnowledgeSourceError("knowledge-source-inactive", "文件夹选择已改变，请重新打开操作菜单。");
      if (!proof) throw new KnowledgeSourceError("knowledge-folder-selection-required", "无法确认当前文件夹，请刷新目录后再试。");
      folderSelections.set(relativePath, { source: origin, sourceEpoch, proof });
    },
    async listTree() {
      const currentVault = requireVault();
      if (!bridge?.listNotesVaultFiles) throw new KnowledgeSourceError("source-not-ready", "Real vault source is missing listNotesVaultFiles");
      const root = await bridge.listNotesVaultFiles(currentVault);
      return root.children?.map(vaultNodeToTreeNode) || [];
    },
    async createDocument(parentIdOrPath = "", title = "Untitled.md") {
      const currentVault = requireVault();
      if (!bridge?.createNotesVaultMarkdownFile) throw new KnowledgeSourceError("source-not-ready", "Real vault source is missing createNotesVaultMarkdownFile");
      const file = await bridge.createNotesVaultMarkdownFile({ vault: currentVault, parentRelativePath: parentIdOrPath || "", name: title });
      return fromLegacyFile(file);
    },
    async createFolder(parentIdOrPath = "", name = "New folder") {
      const currentVault = requireVault();
      if (!bridge?.createNotesVaultFolder) throw new KnowledgeSourceError("source-not-ready", "Real vault source is missing createNotesVaultFolder");
      if (isMacPlatform()) {
        const origin = readSource();
        if (origin?.mode !== "real-vault" || origin.vaultId !== currentVault.id
            || (origin.rootPath && origin.rootPath !== currentVault.rootPath))
          throw new KnowledgeSourceError("knowledge-source-inactive", "Open the current vault before creating a folder");
        const activation = await ensureSource();
        if (readSource() !== origin || activation.vaultId !== currentVault.id)
          throw new KnowledgeSourceError("knowledge-source-inactive", "The vault changed before folder creation started");
        let folder: VaultFileNodeLike;
        try {
          folder = await bridge.createNotesVaultFolder({ vault: currentVault, parentRelativePath: parentIdOrPath || "", name, sourceEpoch: activation.sourceEpoch });
        } catch (failure) {
          const message = typeof failure === "string" ? failure : failure instanceof Error ? failure.message : "";
          if (message.startsWith("knowledge-create-unconfirmed:"))
            throw new KnowledgeSourceError("knowledge-create-unconfirmed", "文件夹创建结果未确认，请检查原知识库后再重试。");
          throw failure;
        }
        if (readSource() !== origin)
          throw new KnowledgeSourceError("knowledge-create-unconfirmed", "知识库已切换，请先检查原知识库中的文件夹，再重试。");
        return vaultNodeToTreeNode(folder);
      }
      const folder = await bridge.createNotesVaultFolder({ vault: currentVault, parentRelativePath: parentIdOrPath || "", name });
      return vaultNodeToTreeNode(folder);
    },
    async openDocument(idOrPath: string) {
      const currentVault = requireVault();
      const generation = folderCacheGeneration;
      if (retiringFolder && folderContainsPath(retiringFolder, idOrPath))
        throw new KnowledgeSourceError("knowledge-folder-busy", "文件夹正在变更，请稍后重新打开笔记。");
      const snapshot = await documents.read({ vaultId: currentVault.id, relativePath: idOrPath });
      if (generation !== folderCacheGeneration)
        throw new KnowledgeSourceError("knowledge-folder-changed", "文件夹已变更，请从新位置重新打开笔记。");
      return fromSnapshot(snapshot, idOrPath);
    },
    async saveDocument(documentRef, contentText) {
      const currentVault = requireVault();
      const relativePath = documentId(documentRef);
      if (retiringFolder && folderContainsPath(retiringFolder, relativePath))
        throw new KnowledgeSourceError("knowledge-folder-busy", "文件夹正在变更；未保存内容已保留，请稍后重试。");
      const expectedRevision = (typeof documentRef === "string" ? undefined : documentRef.revision)
        ?? openedRevisions.get(relativePath);
      if (!expectedRevision) {
        throw new KnowledgeSourceError("knowledge-revision-required", "Open the document before saving it");
      }
      // Native Knowledge checks the active source epoch and compares the exact
      // revision while holding its mutation/file lock. A preflight read alone
      // cannot prevent another window from writing before this commit.
      const result = await documents.replace({ vaultId: currentVault.id, relativePath }, contentText, expectedRevision);
      return fromSnapshot(result.document, relativePath);
    },
    async renameDocument(documentRef, newTitle) {
      const currentVault = requireVault();
      if (isMacPlatform()) {
        const relativePath = documentId(documentRef);
        const slash = relativePath.lastIndexOf("/");
        return moveMacDocument(documentRef, slash < 0 ? "" : relativePath.slice(0, slash), newTitle);
      }
      if (!bridge?.renameNotesVaultMarkdownFile) throw new KnowledgeSourceError("source-not-ready", "Real vault source is missing renameNotesVaultMarkdownFile");
      const relativePath = documentId(documentRef);
      const file = await bridge.renameNotesVaultMarkdownFile({ vault: currentVault, relativePath, newName: newTitle });
      openedRevisions.delete(relativePath);
      openedFileIdentities.delete(relativePath);
      return fromLegacyFile(file);
    },
    async renameFolder(folderRef, newName) {
      const currentVault = requireVault();
      const relativePath = folderId(folderRef);
      if (!relativePath) throw new KnowledgeSourceError("invalid-folder-ref", "Real vault folder path is missing");
      if (isMacPlatform()) return folderNodeFromResult(await mutateMacFolder(relativePath, "rename", { newName }));
      if (!bridge?.renameNotesVaultFolder) throw new KnowledgeSourceError("source-not-ready", "Real vault source is missing renameNotesVaultFolder");
      const folder = await bridge.renameNotesVaultFolder({ vault: currentVault, relativePath, newName });
      return vaultNodeToTreeNode(folder);
    },
    async moveDocument(documentRef, targetFolderRef) {
      const currentVault = requireVault();
      const relativePath = documentId(documentRef);
      const targetParentRelativePath = folderId(targetFolderRef) || "";

      if (isMacPlatform()) return moveMacDocument(documentRef, targetParentRelativePath);

      if (!bridge?.moveNotesVaultMarkdownFile) throw new KnowledgeSourceError("source-not-ready", "Real vault source is missing moveNotesVaultMarkdownFile");
      const file = await bridge.moveNotesVaultMarkdownFile({ vault: currentVault, relativePath, targetParentRelativePath });
      openedRevisions.delete(relativePath);
      openedFileIdentities.delete(relativePath);
      return fromLegacyFile(file);
    },
    async moveFolder(folderRef, targetFolderRef) {
      const currentVault = requireVault();
      const relativePath = folderId(folderRef);
      if (!relativePath) throw new KnowledgeSourceError("invalid-folder-ref", "Real vault folder path is missing");
      const targetParentRelativePath = folderId(targetFolderRef) || "";
      if (isMacPlatform()) return folderNodeFromResult(await mutateMacFolder(relativePath, "move", { targetParentRelativePath }));
      if (!bridge?.moveNotesVaultFolder) throw new KnowledgeSourceError("source-not-ready", "Real vault source is missing moveNotesVaultFolder");
      const folder = await bridge.moveNotesVaultFolder({ vault: currentVault, relativePath, targetParentRelativePath });
      return vaultNodeToTreeNode(folder);
    },
    async deleteDocument(documentRef) {
      const currentVault = requireVault();
      const relativePath = documentId(documentRef);
      if (isMacPlatform()) {
        if (!documents.delete) throw new KnowledgeSourceError("source-not-ready", "Protected note deletion is unavailable");
        if (relativePath.includes("\\") || relativePath !== relativePath.trim())
          throw new KnowledgeSourceError("knowledge-invalid-path", "This note path is ambiguous and cannot be deleted safely");
        const origin = readSource();
        if (origin?.mode !== "real-vault" || origin.vaultId !== currentVault.id)
          throw new KnowledgeSourceError("knowledge-source-inactive", "Open the current vault before deleting a note");
        if (typeof documentRef !== "string" && "vaultId" in documentRef && documentRef.vaultId && documentRef.vaultId !== currentVault.id)
          throw new KnowledgeSourceError("knowledge-document-identity-mismatch", "Document belongs to a different vault");
        const callerRevision = typeof documentRef === "string" ? undefined : documentRef.revision;
        let revision = callerRevision ?? openedRevisions.get(relativePath);
        let identity = callerRevision !== undefined
          ? (typeof documentRef === "string" ? undefined : documentRef.fileIdentity)
          : openedFileIdentities.get(relativePath);
        if (!revision) {
          const snapshot = await documents.read({ vaultId: currentVault.id, relativePath });
          if (readSource() !== origin)
            throw new KnowledgeSourceError("knowledge-source-inactive", "The vault changed before deletion started");
          const observed = fromSnapshot(snapshot, relativePath);
          revision = observed.revision;
          identity = observed.fileIdentity;
        }
        if (!revision) throw new KnowledgeSourceError("knowledge-revision-required", "Open the document before deleting it");
        if (!identity) throw new KnowledgeSourceError("knowledge-identity-unavailable", "Reopen the document before deleting it");
        if (readSource() !== origin)
          throw new KnowledgeSourceError("knowledge-source-inactive", "The vault changed before deletion started");
        // The protected service retains the observed object for recovery. Never
        // fall back to the legacy unlink if this fails or becomes uncertain.
        await documents.delete({ vaultId: currentVault.id, relativePath }, revision, identity);
        openedRevisions.delete(relativePath);
        openedFileIdentities.delete(relativePath);
        openedSourceProofs.delete(relativePath);
        return mutationResult("real-vault", "deleted", "Deleted one Markdown file", undefined, relativePath, joinMacPath(currentVault.rootPath, relativePath));
      }
      if (!bridge?.deleteNotesVaultMarkdownFile) throw new KnowledgeSourceError("source-not-ready", "Real vault source is missing deleteNotesVaultMarkdownFile");
      const result = await bridge.deleteNotesVaultMarkdownFile({ vault: currentVault, relativePath });
      openedRevisions.delete(relativePath);
      openedFileIdentities.delete(relativePath);
      return mutationResult("real-vault", "deleted", result.message, result, result.relativePath, result.absolutePath);
    },
    async deleteFolder(folderRef) {
      const currentVault = requireVault();
      const relativePath = folderId(folderRef);
      if (!relativePath) throw new KnowledgeSourceError("invalid-folder-ref", "Real vault folder path is missing");
      if (isMacPlatform()) {
        const result = await mutateMacFolder(relativePath, "delete");
        return mutationResult("real-vault", "deleted", "空文件夹已移至恢复区，可在“文件夹恢复”中还原。", result, relativePath);
      }
      if (!bridge?.deleteNotesVaultEmptyFolder) throw new KnowledgeSourceError("source-not-ready", "Real vault source is missing deleteNotesVaultEmptyFolder");
      const result = await bridge.deleteNotesVaultEmptyFolder({ vault: currentVault, relativePath });
      return mutationResult("real-vault", "deleted", result.message, result, result.relativePath, result.absolutePath);
    },
    async listFolderRecoveries() {
      if (!isMacPlatform()) return [];
      const { origin, sourceEpoch } = await folderActivation();
      const records = await folders.list(sourceEpoch);
      if (readSource() !== origin) throw new KnowledgeSourceError("knowledge-source-inactive", "知识库已切换。");
      return records;
    },
    async restoreFolder(operationId) {
      if (!isMacPlatform()) throw new KnowledgeSourceError("knowledge-folder-recovery-unavailable", "此恢复入口仅用于 macOS 文件夹事务。");
      const { origin, sourceEpoch } = await folderActivation();
      const result = await folders.restore(sourceEpoch, operationId);
      invalidateFolderReads(result.oldRelativePath);
      if (result.newRelativePath) invalidateFolderReads(result.newRelativePath);
      return acceptFolderResult(result, origin);
    },
  };
}
