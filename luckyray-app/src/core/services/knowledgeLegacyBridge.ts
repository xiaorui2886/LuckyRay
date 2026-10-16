import {
  KnowledgeServiceError,
  createKnowledgeDocument,
  deleteKnowledgeDocument,
  knowledgeDocumentNoteId,
  knowledgeTagIdentity,
  listKnowledgeDocuments,
  moveKnowledgeDocument,
  parseKnowledgeDocumentNoteId,
  parseKnowledgeTagIdentity,
  readKnowledgeDocument,
  readKnowledgeIndexSnapshot,
  replaceKnowledgeDocument,
  setActiveKnowledgeDocumentTags,
  type KnowledgeCreateInput,
  type KnowledgeDocumentRef,
  type KnowledgeDocumentSnapshot,
  type KnowledgeDocumentSummary,
  type KnowledgeIndexSnapshot,
  type KnowledgeMutationResult,
} from "./knowledge";
import { createRealVaultLibraryAssetResolver } from "../markdown/realVaultEmbeds";
import { createRealVaultWikiTargetResolver } from "../markdown/wikiTargets";
import { knowledgeStore } from "./knowledgeStore";

export type LegacyBridgeNote = {
  id: string;
  title: string;
  contentJson: string;
  contentText: string;
  folderId: string | null;
  color: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LegacyBridgeCreateInput = {
  title?: string;
  folderId?: string | null;
  contentJson?: string;
  contentText?: string;
  color?: string | null;
};

export type LegacyBridgeUpdateInput = Partial<Pick<LegacyBridgeNote, "title" | "contentJson" | "contentText" | "folderId" | "color">>;

export type KnowledgeLegacyBridgeDependencies = {
  listDocuments(input?: { limit?: number }): Promise<KnowledgeDocumentSummary[]>;
  readDocument(documentRef: KnowledgeDocumentRef): Promise<KnowledgeDocumentSnapshot>;
  createDocument(input: KnowledgeCreateInput): Promise<KnowledgeDocumentSnapshot>;
  replaceDocument(documentRef: KnowledgeDocumentRef, content: string, expectedRevision: string): Promise<KnowledgeMutationResult>;
  moveDocument(documentRef: KnowledgeDocumentRef, title: string, expectedRevision: string, parentRelativePath?: string | null): Promise<KnowledgeDocumentSnapshot>;
  deleteDocument(documentRef: KnowledgeDocumentRef, expectedRevision: string): Promise<void>;
  indexSnapshot(): Promise<KnowledgeIndexSnapshot>;
  setDocumentTags(documentRef: KnowledgeDocumentRef, expectedRevision: string, tags: string[]): Promise<KnowledgeMutationResult>;
  listAssets?(): Promise<Array<{ id: string; name: string; originalPath?: string | null; libraryPath?: string | null }>>;
};

const KNOWLEDGE_FOLDER_PREFIX = "kfolder-";

function hexEncode(value: string) {
  return Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexDecode(value: string) {
  if (!value || value.length % 2 !== 0 || !/^[0-9a-f]+$/.test(value)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(value.match(/../g) || [], (byte) => Number.parseInt(byte, 16)));
  } catch {
    return null;
  }
}

export function knowledgeFolderIdentity(vaultId: string, relativePath: string) {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!vaultId || !normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new KnowledgeServiceError("knowledge-folder-id-invalid", "Knowledge folder identity is invalid");
  }
  return `${KNOWLEDGE_FOLDER_PREFIX}${hexEncode(JSON.stringify({ vaultId, relativePath: normalized }))}`;
}

export function parseKnowledgeFolderIdentity(value: string): { vaultId: string; relativePath: string } | null {
  if (!value.startsWith(KNOWLEDGE_FOLDER_PREFIX)) return null;
  const decoded = hexDecode(value.slice(KNOWLEDGE_FOLDER_PREFIX.length));
  if (!decoded) return null;
  try {
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    if (Object.keys(parsed).length !== 2 || typeof parsed.vaultId !== "string" || typeof parsed.relativePath !== "string") return null;
    const identity = { vaultId: parsed.vaultId, relativePath: parsed.relativePath };
    return knowledgeFolderIdentity(identity.vaultId, identity.relativePath) === value ? identity : null;
  } catch {
    return null;
  }
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\r?\n/g, "<br>");
}

function legacyNoteFromSummary(summary: KnowledgeDocumentSummary): LegacyBridgeNote {
  const timestamp = summary.modifiedAt || "";
  return {
    id: knowledgeDocumentNoteId(summary.documentRef),
    title: summary.title,
    contentJson: "",
    contentText: "",
    folderId: null,
    color: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function legacyNoteFromSnapshot(snapshot: KnowledgeDocumentSnapshot): LegacyBridgeNote {
  return {
    ...legacyNoteFromSummary(snapshot),
    contentJson: escapeHtml(snapshot.content),
    contentText: snapshot.content,
  };
}

function requireDocumentRef(noteId: string): KnowledgeDocumentRef {
  const parsed = parseKnowledgeDocumentNoteId(noteId);
  if (parsed) return parsed;
  if (!noteId.startsWith("kdoc-")) {
    throw new KnowledgeServiceError("legacy-db-note-retired", "Legacy database note identities are retired");
  }
  throw new KnowledgeServiceError("knowledge-document-id-invalid", "Knowledge document identity is invalid");
}

function requireKnowledgeFolder(folderId: string | null | undefined) {
  if (!folderId) return null;
  const folder = parseKnowledgeFolderIdentity(folderId);
  if (folder) return folder;
  throw new KnowledgeServiceError(
    "legacy-db-note-retired",
    "Legacy database note folders are retired; choose a Vault folder",
  );
}

export function createKnowledgeLegacyBridgeAdapter(dependencies: KnowledgeLegacyBridgeDependencies) {
  const readIndexedDocument = async (noteId: string) => {
    const documentRef = requireDocumentRef(noteId);
    const snapshot = await dependencies.indexSnapshot();
    const document = snapshot.documents.find((candidate) => (
      candidate.documentRef.vaultId === documentRef.vaultId
      && candidate.documentRef.relativePath === documentRef.relativePath
    ));
    if (!document) throw new KnowledgeServiceError("knowledge-not-found", "Knowledge document does not exist");
    return { snapshot, documentRef, document };
  };

  return {
    async listNotes(): Promise<LegacyBridgeNote[]> {
      const documents = await dependencies.listDocuments({ limit: 200 });
      return documents.map(legacyNoteFromSummary);
    },

    async getNote(noteId: string): Promise<LegacyBridgeNote | null> {
      const documentRef = requireDocumentRef(noteId);
      try {
        return legacyNoteFromSnapshot(await dependencies.readDocument(documentRef));
      } catch (error) {
        if (error instanceof KnowledgeServiceError && error.code === "knowledge-not-found") return null;
        throw error;
      }
    },

    async createNote(input: LegacyBridgeCreateInput = {}): Promise<LegacyBridgeNote> {
      const parent = requireKnowledgeFolder(input.folderId);
      if (parent) {
        const snapshot = await dependencies.indexSnapshot();
        if (snapshot.vaultId !== parent.vaultId) {
          throw new KnowledgeServiceError("knowledge-vault-not-current", "Knowledge folder belongs to another Vault");
        }
      }
      const snapshot = await dependencies.createDocument({
        title: input.title?.trim() || "Untitled",
        parentRelativePath: parent?.relativePath || null,
        content: input.contentText || "",
      });
      return legacyNoteFromSnapshot(snapshot);
    },

    async updateNote(noteId: string, patch: LegacyBridgeUpdateInput): Promise<LegacyBridgeNote | null> {
      let snapshot = await dependencies.readDocument(requireDocumentRef(noteId));
      const parent = requireKnowledgeFolder(patch.folderId);
      if (parent && parent.vaultId !== snapshot.documentRef.vaultId) {
        throw new KnowledgeServiceError("knowledge-vault-not-current", "Knowledge folder belongs to another Vault");
      }
      if (patch.title !== undefined && patch.title.trim() && patch.title.trim() !== snapshot.title) {
        snapshot = await dependencies.moveDocument(snapshot.documentRef, patch.title.trim(), snapshot.revision, parent?.relativePath);
      } else if (parent) {
        snapshot = await dependencies.moveDocument(snapshot.documentRef, snapshot.title, snapshot.revision, parent.relativePath);
      }
      if (patch.contentText !== undefined && patch.contentText !== snapshot.content) {
        snapshot = (await dependencies.replaceDocument(
          snapshot.documentRef,
          patch.contentText,
          snapshot.revision,
        )).document;
      }
      return legacyNoteFromSnapshot(snapshot);
    },

    async deleteNote(noteId: string): Promise<void> {
      const snapshot = await dependencies.readDocument(requireDocumentRef(noteId));
      await dependencies.deleteDocument(snapshot.documentRef, snapshot.revision);
    },

    async listNoteFolders() {
      const [snapshot, documents] = await Promise.all([
        dependencies.indexSnapshot(),
        dependencies.listDocuments({ limit: 200 }),
      ]);
      const vaultId = snapshot.vaultId;
      const paths = new Set<string>();
      for (const document of documents) {
        if (document.documentRef.vaultId !== vaultId) continue;
        const parts = document.relativePath.split("/").slice(0, -1);
        for (let index = 1; index <= parts.length; index += 1) paths.add(parts.slice(0, index).join("/"));
      }
      const nodes = new Map<string, { id: string; scope: "notes"; parentId: string | null; name: string; sortOrder: number; open: boolean; createdAt: string; updatedAt: string; children: unknown[] }>();
      for (const path of [...paths].sort()) {
        const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
        nodes.set(path, {
          id: knowledgeFolderIdentity(vaultId, path),
          scope: "notes",
          parentId: parentPath ? knowledgeFolderIdentity(vaultId, parentPath) : null,
          name: path.split("/").pop() || path,
          sortOrder: 0,
          open: true,
          createdAt: "",
          updatedAt: "",
          children: [],
        });
      }
      const roots: typeof nodes extends Map<string, infer T> ? T[] : never = [];
      for (const [path, node] of nodes) {
        const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
        if (parentPath) nodes.get(parentPath)?.children.push(node);
        else roots.push(node);
      }
      return roots;
    },

    async moveNoteToFolder(input: { noteId: string; folderId: string | null }) {
      const snapshot = await dependencies.readDocument(requireDocumentRef(input.noteId));
      const folder = requireKnowledgeFolder(input.folderId);
      if (folder && folder.vaultId !== snapshot.documentRef.vaultId) {
        throw new KnowledgeServiceError("knowledge-vault-not-current", "Knowledge folder belongs to another Vault");
      }
      await dependencies.moveDocument(snapshot.documentRef, snapshot.title, snapshot.revision, folder?.relativePath || "");
    },

    async getNoteTags(noteId: string): Promise<string[]> {
      const { documentRef, document } = await readIndexedDocument(noteId);
      return document.tags.map((tag) => knowledgeTagIdentity(documentRef.vaultId, tag));
    },

    async listKnowledgeTags() {
      const snapshot = await dependencies.indexSnapshot();
      const tags = new Map<string, { id: string; name: string; color: null; assetCount: 0; noteCount: number; createdAt: string; updatedAt: string }>();
      for (const document of snapshot.documents) {
        for (const rawName of document.tags) {
          const name = rawName.trim();
          if (!name) continue;
          const id = knowledgeTagIdentity(snapshot.vaultId, name);
          const current = tags.get(id);
          if (current) current.noteCount += 1;
          else tags.set(id, { id, name, color: null, assetCount: 0, noteCount: 1, createdAt: "", updatedAt: document.modifiedAt || "" });
        }
      }
      return [...tags.values()].sort((left, right) => left.name.localeCompare(right.name));
    },

    async createKnowledgeTag(input: { name: string }) {
      const snapshot = await dependencies.indexSnapshot();
      const name = input.name.trim();
      if (!name) throw new KnowledgeServiceError("knowledge-tag-id-invalid", "Knowledge tag name is invalid");
      return {
        id: knowledgeTagIdentity(snapshot.vaultId, name),
        name,
        color: null,
        assetCount: 0,
        noteCount: 0,
        createdAt: "",
        updatedAt: "",
      };
    },

    async setNoteTags(noteId: string, tagIds: string[]): Promise<string[]> {
      const document = await dependencies.readDocument(requireDocumentRef(noteId));
      const indexed = await readIndexedDocument(noteId);
      const existingNames = new Map(indexed.document.tags.map((tag) => [
        knowledgeTagIdentity(document.documentRef.vaultId, tag),
        tag,
      ]));
      const tags = tagIds.map((tagId) => {
        const identity = parseKnowledgeTagIdentity(tagId);
        if (!identity || identity.vaultId !== document.documentRef.vaultId) {
          throw new KnowledgeServiceError("knowledge-tag-id-invalid", "Knowledge tag identity is invalid");
        }
        return existingNames.get(tagId) || identity.key;
      });
      const mutation = await dependencies.setDocumentTags(document.documentRef, document.revision, tags);
      return mutation.document.documentRef.vaultId === document.documentRef.vaultId
        ? tags.map((tag) => knowledgeTagIdentity(document.documentRef.vaultId, tag))
        : [];
    },

    async addKnowledgeTag(noteId: string, rawName: string): Promise<string[]> {
      const document = await dependencies.readDocument(requireDocumentRef(noteId));
      const indexed = await readIndexedDocument(noteId);
      const name = rawName.trim();
      if (!name) throw new KnowledgeServiceError("knowledge-tag-id-invalid", "Knowledge tag name is invalid");
      const id = knowledgeTagIdentity(document.documentRef.vaultId, name);
      const currentIds = indexed.document.tags.map((tag) => knowledgeTagIdentity(document.documentRef.vaultId, tag));
      if (currentIds.includes(id)) return currentIds;
      const tags = [...indexed.document.tags, name];
      await dependencies.setDocumentTags(document.documentRef, document.revision, tags);
      return tags.map((tag) => knowledgeTagIdentity(document.documentRef.vaultId, tag));
    },

    async removeKnowledgeTag(noteId: string, tagId: string): Promise<string[]> {
      const document = await dependencies.readDocument(requireDocumentRef(noteId));
      const indexed = await readIndexedDocument(noteId);
      const identity = parseKnowledgeTagIdentity(tagId);
      if (!identity || identity.vaultId !== document.documentRef.vaultId) {
        throw new KnowledgeServiceError("knowledge-tag-id-invalid", "Knowledge tag identity is invalid");
      }
      const tags = indexed.document.tags.filter((tag) => knowledgeTagIdentity(document.documentRef.vaultId, tag) !== tagId);
      await dependencies.setDocumentTags(document.documentRef, document.revision, tags);
      return tags.map((tag) => knowledgeTagIdentity(document.documentRef.vaultId, tag));
    },

    async getNoteLinks(noteId: string) {
      const { snapshot, document } = await readIndexedDocument(noteId);
      const resolve = createRealVaultWikiTargetResolver(snapshot.documents);
      return document.wikiLinks.map((link) => {
        const target = resolve(link.target, document.relativePath);
        return {
          targetTitle: link.target,
          toNoteId: target ? knowledgeDocumentNoteId(target.documentRef) : null,
          isMissing: target ? 0 : 1,
        };
      });
    },

    async getNoteEmbeds(noteId: string) {
      const { document } = await readIndexedDocument(noteId);
      const assets = dependencies.listAssets ? await dependencies.listAssets() : [];
      const resolve = createRealVaultLibraryAssetResolver(assets);
      return document.embeds.map((embed) => {
        const asset = resolve(embed.target || embed.raw || "");
        return {
          targetName: embed.target,
          assetId: asset?.id || null,
          isMissing: asset ? 0 : 1,
        };
      });
    },

    async getGraphRelations() {
      const snapshot = await dependencies.indexSnapshot();
      const resolveNote = createRealVaultWikiTargetResolver(snapshot.documents);
      const assets = dependencies.listAssets ? await dependencies.listAssets() : [];
      const resolveAsset = createRealVaultLibraryAssetResolver(assets);
      return {
        links: snapshot.documents.flatMap((document) => document.wikiLinks.map((link) => {
          const target = resolveNote(link.target, document.relativePath);
          return {
            fromNoteId: knowledgeDocumentNoteId(document.documentRef),
            targetTitle: link.target,
            toNoteId: target ? knowledgeDocumentNoteId(target.documentRef) : null,
            isMissing: target ? 0 : 1,
          };
        })),
        embeds: snapshot.documents.flatMap((document) => document.embeds.map((embed) => {
          const asset = resolveAsset(embed.target || embed.raw || "");
          return {
            noteId: knowledgeDocumentNoteId(document.documentRef),
            targetName: embed.target,
            assetId: asset?.id || null,
            isMissing: asset ? 0 : 1,
          };
        })),
      };
    },

    async getNotesLinkingToNote(noteId: string) {
      const documentRef = requireDocumentRef(noteId);
      const snapshot = await dependencies.indexSnapshot();
      const resolve = createRealVaultWikiTargetResolver(snapshot.documents);
      return snapshot.documents.flatMap((document) => document.wikiLinks.some((link) => (
        resolve(link.target, document.relativePath)?.documentRef.relativePath === documentRef.relativePath
        && document.documentRef.vaultId === documentRef.vaultId
      )) ? [{
        id: knowledgeDocumentNoteId(document.documentRef),
        title: document.title,
        updatedAt: document.modifiedAt || "",
        snippet: document.excerpt,
      }] : []);
    },

    async getUnlinkedNoteMentions(noteId: string) {
      requireDocumentRef(noteId);
      return [] as Array<{ id: string; title: string; updatedAt: string; snippet: string }>;
    },

    async getNotesForAsset(assetId: string): Promise<LegacyBridgeNote[]> {
      const snapshot = await dependencies.indexSnapshot();
      const assets = dependencies.listAssets ? await dependencies.listAssets() : [];
      const resolve = createRealVaultLibraryAssetResolver(assets);
      return snapshot.documents.flatMap((document) => document.embeds.some((embed) => (
        resolve(embed.target || embed.raw || "")?.id === assetId
      )) ? [legacyNoteFromSummary({
        documentRef: document.documentRef,
        title: document.title,
        relativePath: document.relativePath,
        modifiedAt: document.modifiedAt,
        size: document.size,
      })] : []);
    },

    async getAssetsForNote(noteId: string) {
      const { document } = await readIndexedDocument(noteId);
      const assets = dependencies.listAssets ? await dependencies.listAssets() : [];
      const resolve = createRealVaultLibraryAssetResolver(assets);
      const matched = new Map<string, (typeof assets)[number]>();
      for (const embed of document.embeds) {
        const asset = resolve(embed.target || embed.raw || "");
        if (asset) matched.set(asset.id, asset);
      }
      return [...matched.values()];
    },

    async searchNotesForGlobal(query: string, options?: { limit?: number }) {
      const normalized = query.trim().toLowerCase();
      if (!normalized) return [];
      const snapshot = await dependencies.indexSnapshot();
      return snapshot.documents
        .filter((document) => document.title.toLowerCase().includes(normalized) || document.plainText.toLowerCase().includes(normalized))
        .slice(0, Math.max(1, Math.min(options?.limit || 50, 200)))
        .map((document) => ({
          id: knowledgeDocumentNoteId(document.documentRef),
          title: document.title,
          snippet: document.excerpt,
          updatedAt: document.modifiedAt || "",
          folderId: null,
        }));
    },
  };
}

export function createDefaultKnowledgeLegacyBridgeAdapter(
  overrides: Pick<KnowledgeLegacyBridgeDependencies, "listAssets"> = {},
) {
  const requireVaultSource = async () => {
    const snapshot = await knowledgeStore.ensureSnapshot({ reason: "legacy-knowledge-bridge" });
    if (snapshot.mode !== "real-vault" || !snapshot.vault) {
      throw new KnowledgeServiceError("knowledge-vault-required", "Open or create a Vault before using knowledge documents");
    }
  };
  return createKnowledgeLegacyBridgeAdapter({
    listDocuments: listKnowledgeDocuments,
    readDocument: readKnowledgeDocument,
    createDocument: async (input) => {
      await requireVaultSource();
      return createKnowledgeDocument(input);
    },
    replaceDocument: async (documentRef, content, expectedRevision) => {
      await requireVaultSource();
      return replaceKnowledgeDocument(documentRef, content, expectedRevision);
    },
    moveDocument: async (documentRef, title, expectedRevision, parentRelativePath) => {
      await requireVaultSource();
      return moveKnowledgeDocument(documentRef, title, expectedRevision, parentRelativePath);
    },
    deleteDocument: async (documentRef, expectedRevision) => {
      await requireVaultSource();
      return deleteKnowledgeDocument(documentRef, expectedRevision);
    },
    indexSnapshot: readKnowledgeIndexSnapshot,
    setDocumentTags: async (documentRef, expectedRevision, tags) => {
      await requireVaultSource();
      return setActiveKnowledgeDocumentTags(documentRef, expectedRevision, tags);
    },
    ...overrides,
  });
}

export const knowledgeLegacyBridgeAdapter = createDefaultKnowledgeLegacyBridgeAdapter();
