import type { KnowledgeSourceMode, KnowledgeTreeNode } from "../../core/bridge/knowledgeTypes";
import {
  readKnowledgeDocument,
  replaceKnowledgeDocument,
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
export function acceptWorkspaceSourceProof(previous:string|undefined,incoming:string|undefined):string|undefined{
  if(incoming===undefined)return previous;
  if(!/^note-source-v1:[a-f0-9]{64}$/.test(incoming))throw new KnowledgeSourceError('knowledge-document-source-invalid','Document read source proof is invalid');
  if(previous&&previous!==incoming)throw new KnowledgeSourceError('knowledge-document-source-changed','The document belongs to a replaced Vault source; reopen it before transfer');
  return incoming;
}

export type KnowledgeDocumentRef = string | KnowledgeDocument | { id?: string; relativePath?: string; revision?: string };
export type KnowledgeFolderRef = string | KnowledgeTreeNode | { id?: string; relativePath?: string } | null | undefined;

export type DocumentSourceAdapter = {
  mode: KnowledgeSourceMode;
  listTree: () => Promise<KnowledgeTreeNode[]>;
  createDocument: (parentIdOrPath?: string | null, title?: string) => Promise<KnowledgeDocument>;
  createFolder: (parentIdOrPath?: string | null, name?: string) => Promise<KnowledgeTreeNode>;
  openDocument: (idOrPath: string) => Promise<KnowledgeDocument>;
  saveDocument: (documentRef: KnowledgeDocumentRef, contentText: string) => Promise<KnowledgeDocument>;
  renameDocument: (documentRef: KnowledgeDocumentRef, newTitle: string) => Promise<KnowledgeDocument>;
  renameFolder: (folderRef: KnowledgeFolderRef, newName: string) => Promise<KnowledgeTreeNode>;
  moveDocument: (documentRef: KnowledgeDocumentRef, targetFolderRef?: KnowledgeFolderRef) => Promise<KnowledgeDocument>;
  moveFolder: (folderRef: KnowledgeFolderRef, targetFolderRef?: KnowledgeFolderRef) => Promise<KnowledgeTreeNode>;
  deleteDocument: (documentRef: KnowledgeDocumentRef) => Promise<KnowledgeMutationResult>;
  deleteFolder: (folderRef: KnowledgeFolderRef) => Promise<KnowledgeMutationResult>;
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
  createNotesVaultFolder?: (input: { vault: VaultMetadataLike; parentRelativePath: string; name: string }) => Promise<VaultFileNodeLike>;
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
};

export function createRealVaultDocumentSource(input: {
  bridge: VaultBridge | null | undefined;
  vault: VaultMetadataLike | null;
  documents?: RevisionedDocuments;
}): DocumentSourceAdapter {
  const { bridge, vault } = input;
  const documents = input.documents ?? { read: readKnowledgeDocument, replace: replaceKnowledgeDocument };
  // Preserve ID-only callers that have already opened the document. Explicit
  // snapshots take precedence so a background read cannot silently rebase a draft.
  const openedRevisions = new Map<string, string>();
  const openedSourceProofs=new Map<string,string>();
  const requireVault = () => {
    if (!vault) throw new KnowledgeSourceError("source-not-ready", "Open or create a vault first");
    return vault;
  };
  const remember = (document: KnowledgeDocument) => {
    if (document.revision) openedRevisions.set(document.relativePath || document.id, document.revision);
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
    return remember({
      id: relativePath,
      title: snapshot.title,
      contentText: snapshot.content,
      source: "real-vault",
      relativePath,
      absolutePath: `${currentVault.rootPath.replace(/[\\/]+$/, "")}${separator}${relativePath.split("/").join(separator)}`,
      updatedAt: snapshot.modifiedAt || undefined,
      revision: snapshot.revision,
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
    return remember({ ...vaultFileToDocument(file), revision });
  };
  return {
    mode: "real-vault",
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
      const folder = await bridge.createNotesVaultFolder({ vault: currentVault, parentRelativePath: parentIdOrPath || "", name });
      return vaultNodeToTreeNode(folder);
    },
    async openDocument(idOrPath: string) {
      const currentVault = requireVault();
      const snapshot = await documents.read({ vaultId: currentVault.id, relativePath: idOrPath });
      return fromSnapshot(snapshot, idOrPath);
    },
    async saveDocument(documentRef, contentText) {
      const currentVault = requireVault();
      const relativePath = documentId(documentRef);
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
      if (!bridge?.renameNotesVaultMarkdownFile) throw new KnowledgeSourceError("source-not-ready", "Real vault source is missing renameNotesVaultMarkdownFile");
      const relativePath = documentId(documentRef);
      const file = await bridge.renameNotesVaultMarkdownFile({ vault: currentVault, relativePath, newName: newTitle });
      openedRevisions.delete(relativePath);
      return fromLegacyFile(file);
    },
    async renameFolder(folderRef, newName) {
      const currentVault = requireVault();
      if (!bridge?.renameNotesVaultFolder) throw new KnowledgeSourceError("source-not-ready", "Real vault source is missing renameNotesVaultFolder");
      const relativePath = folderId(folderRef);
      if (!relativePath) throw new KnowledgeSourceError("invalid-folder-ref", "Real vault folder path is missing");
      const folder = await bridge.renameNotesVaultFolder({ vault: currentVault, relativePath, newName });
      return vaultNodeToTreeNode(folder);
    },
    async moveDocument(documentRef, targetFolderRef) {
      const currentVault = requireVault();
      if (!bridge?.moveNotesVaultMarkdownFile) throw new KnowledgeSourceError("source-not-ready", "Real vault source is missing moveNotesVaultMarkdownFile");
      const relativePath = documentId(documentRef);
      const targetParentRelativePath = folderId(targetFolderRef) || "";
      const file = await bridge.moveNotesVaultMarkdownFile({ vault: currentVault, relativePath, targetParentRelativePath });
      openedRevisions.delete(relativePath);
      return fromLegacyFile(file);
    },
    async moveFolder(folderRef, targetFolderRef) {
      const currentVault = requireVault();
      if (!bridge?.moveNotesVaultFolder) throw new KnowledgeSourceError("source-not-ready", "Real vault source is missing moveNotesVaultFolder");
      const relativePath = folderId(folderRef);
      if (!relativePath) throw new KnowledgeSourceError("invalid-folder-ref", "Real vault folder path is missing");
      const targetParentRelativePath = folderId(targetFolderRef) || "";
      const folder = await bridge.moveNotesVaultFolder({ vault: currentVault, relativePath, targetParentRelativePath });
      return vaultNodeToTreeNode(folder);
    },
    async deleteDocument(documentRef) {
      const currentVault = requireVault();
      if (!bridge?.deleteNotesVaultMarkdownFile) throw new KnowledgeSourceError("source-not-ready", "Real vault source is missing deleteNotesVaultMarkdownFile");
      const relativePath = documentId(documentRef);
      const result = await bridge.deleteNotesVaultMarkdownFile({ vault: currentVault, relativePath });
      openedRevisions.delete(relativePath);
      return mutationResult("real-vault", "deleted", result.message, result, result.relativePath, result.absolutePath);
    },
    async deleteFolder(folderRef) {
      const currentVault = requireVault();
      if (!bridge?.deleteNotesVaultEmptyFolder) throw new KnowledgeSourceError("source-not-ready", "Real vault source is missing deleteNotesVaultEmptyFolder");
      const relativePath = folderId(folderRef);
      if (!relativePath) throw new KnowledgeSourceError("invalid-folder-ref", "Real vault folder path is missing");
      const result = await bridge.deleteNotesVaultEmptyFolder({ vault: currentVault, relativePath });
      return mutationResult("real-vault", "deleted", result.message, result, result.relativePath, result.absolutePath);
    },
  };
}
