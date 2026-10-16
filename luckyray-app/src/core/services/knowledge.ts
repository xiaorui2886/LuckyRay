import { readActiveKnowledgeWriteSource, setActiveKnowledgeSource, type ActiveKnowledgeSource } from "./knowledgeSource";

export type KnowledgeDocumentRef = {
  vaultId: string;
  relativePath: string;
};

export type KnowledgeDocumentSummary = {
  documentRef: KnowledgeDocumentRef;
  title: string;
  relativePath: string;
  modifiedAt: string | null;
  size: number;
};

export type KnowledgeDocumentSnapshot = KnowledgeDocumentSummary & {
  content: string;
  revision: string;
  /** Native proof from the exact scope that performed this document read. */
  workspaceSourceId?:string;
};

export type KnowledgeMutationResult = {
  document: KnowledgeDocumentSnapshot;
  position: "append" | "cursor" | "replace" | string;
  indexWarning?: { code: string; message: string } | null;
  indexStale?: boolean;
};

export type KnowledgeIndexHeading = { level: number; text: string; slug: string; line: number };
export type KnowledgeIndexWikiLink = { raw: string; target: string; alias: string | null; line: number };
export type KnowledgeIndexEmbed = { raw: string; target: string; kind: string | null; line: number };
export type KnowledgeIndexDocument = {
  documentRef: KnowledgeDocumentRef;
  relativePath: string;
  fileName: string;
  title: string;
  revision: string;
  headings: KnowledgeIndexHeading[];
  wikiLinks: KnowledgeIndexWikiLink[];
  embeds: KnowledgeIndexEmbed[];
  tags: string[];
  frontmatterTags: string[];
  inlineTags: string[];
  plainText: string;
  excerpt: string;
  contentLength: number;
  modifiedAt: string | null;
  size: number;
};
export type KnowledgeIndexFailure = {
  code: string;
  message: string;
  documentRef: KnowledgeDocumentRef;
  relativePath: string;
  staleDocumentRetained: boolean;
};
export type KnowledgeIndexSnapshot = {
  vaultId: string;
  generation: number;
  builtAt: string;
  documents: KnowledgeIndexDocument[];
  errors: KnowledgeIndexFailure[];
  version: number;
  changedPaths: string[];
  removedPaths: string[];
  stale: boolean;
  refreshError: { code: string; message: string } | null;
};
export type KnowledgeDocumentRelations = {
  documentRef: KnowledgeDocumentRef;
  headings: KnowledgeIndexHeading[];
  wikiLinks: KnowledgeIndexWikiLink[];
  embeds: KnowledgeIndexEmbed[];
  tags: string[];
};
export type KnowledgeWikiResolution = {
  status: "resolved" | "ambiguous" | "unresolved" | string;
  documentRef: KnowledgeDocumentRef | null;
  candidates: KnowledgeDocumentRef[];
};
export type KnowledgeBacklink = {
  sourceRef: KnowledgeDocumentRef;
  link: KnowledgeIndexWikiLink;
  resolution: KnowledgeWikiResolution;
};
export type KnowledgeTagSummary = { name: string; documentCount: number };

const KNOWLEDGE_TAG_ID_PREFIX = "real-vault-tag:";

export type KnowledgeTagIdentity = {
  vaultId: string;
  key: string;
};

export function normalizeKnowledgeTagDisplayName(value: unknown): string {
  return typeof value === "string" ? value.trim().normalize("NFC") : "";
}

export function knowledgeTagCanonicalKey(value: unknown): string {
  return normalizeKnowledgeTagDisplayName(value).toLowerCase();
}

export function knowledgeTagIdentity(vaultId: string, name: string): string {
  const canonicalVaultId = vaultId.trim();
  const key = knowledgeTagCanonicalKey(name);
  if (!canonicalVaultId || canonicalVaultId !== vaultId || !key) {
    throw new KnowledgeServiceError("knowledge-invalid-tag", "Invalid knowledge tag identity");
  }
  return `${KNOWLEDGE_TAG_ID_PREFIX}${encodeURIComponent(canonicalVaultId)}:${encodeURIComponent(key)}`;
}

export function parseKnowledgeTagIdentity(value: unknown): KnowledgeTagIdentity | null {
  if (typeof value !== "string" || !value.startsWith(KNOWLEDGE_TAG_ID_PREFIX)) return null;
  const encoded = value.slice(KNOWLEDGE_TAG_ID_PREFIX.length);
  const separator = encoded.indexOf(":");
  if (separator <= 0 || separator !== encoded.lastIndexOf(":")) return null;
  try {
    const vaultId = decodeURIComponent(encoded.slice(0, separator));
    const key = decodeURIComponent(encoded.slice(separator + 1));
    if (!vaultId || vaultId.trim() !== vaultId || !key || knowledgeTagCanonicalKey(key) !== key) return null;
    return knowledgeTagIdentity(vaultId, key) === value ? { vaultId, key } : null;
  } catch {
    return null;
  }
}

export type KnowledgeCreateInput = {
  title: string;
  parentRelativePath?: string | null;
  content?: string;
};

export type KnowledgeCurrentContextInput = {
  documentRef: KnowledgeDocumentRef;
  cursorOffset?: number | null;
  selection?: string | null;
  expectedRevision?: string | null;
};

export type KnowledgeContextSession = {
  sessionId: string;
  sessionEpoch: number;
};

export type KnowledgeUiSourceActivation = {
  vaultId: string;
  sourceEpoch: number;
};

export type KnowledgeContextOrder = KnowledgeContextSession & {
  sourceEpoch: number;
  generation: number;
};

export type OrderedKnowledgeCurrentContextInput = KnowledgeCurrentContextInput & KnowledgeContextOrder;

export type KnowledgeCurrentContext = {
  documentRef: KnowledgeDocumentRef;
  cursorOffset: number | null;
  selection: string | null;
  expectedRevision: string;
  updatedAt: string;
};

export class KnowledgeServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "KnowledgeServiceError";
    this.code = code;
  }
}

export type KnowledgePreviewAdapter = {
  listDocuments(input?: { limit?: number }): Promise<KnowledgeDocumentSummary[]>;
  searchDocuments?(query: string, limit?: number): Promise<KnowledgeDocumentSummary[]>;
  readDocument?(documentRef: KnowledgeDocumentRef): Promise<KnowledgeDocumentSnapshot>;
  createDocument?(input: KnowledgeCreateInput): Promise<KnowledgeDocumentSnapshot>;
  appendDocument?(documentRef: KnowledgeDocumentRef, content: string, expectedRevision?: string | null): Promise<KnowledgeMutationResult>;
  insertDocument?(documentRef: KnowledgeDocumentRef, offset: number, text: string, expectedRevision?: string | null): Promise<KnowledgeMutationResult>;
  replaceDocument?(documentRef: KnowledgeDocumentRef, content: string, expectedRevision?: string | null): Promise<KnowledgeMutationResult>;
  moveDocument?(documentRef: KnowledgeDocumentRef, title: string, expectedRevision: string, parentRelativePath?: string | null): Promise<KnowledgeDocumentSnapshot>;
  deleteDocument?(documentRef: KnowledgeDocumentRef, expectedRevision: string): Promise<void>;
  insertIntoCurrent?(input: { text: string; appendIfNoCursor?: boolean }): Promise<KnowledgeMutationResult>;
  activateUiSource?(vaultId: string): Promise<KnowledgeUiSourceActivation>;
  activateCurrentUiSource?(): Promise<KnowledgeUiSourceActivation>;
  deactivateUiSource?(): Promise<void>;
  beginCurrentContextSession?(sessionId: string): Promise<KnowledgeContextSession>;
  setCurrentContext?(input: OrderedKnowledgeCurrentContextInput): Promise<KnowledgeCurrentContext>;
  clearCurrentContext?(order: KnowledgeContextOrder): Promise<void>;
  getCurrentContext?(): Promise<KnowledgeCurrentContext | null>;
  refreshIndex?(): Promise<KnowledgeIndexSnapshot>;
  indexSnapshot?(): Promise<KnowledgeIndexSnapshot>;
  documentRelations?(documentRef: KnowledgeDocumentRef): Promise<KnowledgeDocumentRelations>;
  backlinks?(documentRef: KnowledgeDocumentRef): Promise<KnowledgeBacklink[]>;
  tagSummary?(): Promise<KnowledgeTagSummary[]>;
  documentsForTag?(tag: string): Promise<KnowledgeDocumentSummary[]>;
  documentsReferencingEmbed?(target: string): Promise<KnowledgeDocumentSummary[]>;
  setDocumentTags?(documentRef: KnowledgeDocumentRef, expectedRevision: string, tags: string[]): Promise<KnowledgeMutationResult>;
};

export type KnowledgeRuntime = {
  isTauri(): boolean;
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  preview: KnowledgePreviewAdapter;
};

export type KnowledgeClient = {
  listDocuments(input?: { limit?: number }): Promise<KnowledgeDocumentSummary[]>;
  searchDocuments(query: string, limit?: number): Promise<KnowledgeDocumentSummary[]>;
  readDocument(documentRef: KnowledgeDocumentRef): Promise<KnowledgeDocumentSnapshot>;
  createDocument(input: KnowledgeCreateInput, sourceEpoch?: number): Promise<KnowledgeDocumentSnapshot>;
  appendDocument(documentRef: KnowledgeDocumentRef, content: string, expectedRevision?: string | null, sourceEpoch?: number): Promise<KnowledgeMutationResult>;
  insertDocument(documentRef: KnowledgeDocumentRef, offset: number, text: string, expectedRevision?: string | null, sourceEpoch?: number): Promise<KnowledgeMutationResult>;
  replaceDocument(documentRef: KnowledgeDocumentRef, content: string, expectedRevision?: string | null, sourceEpoch?: number): Promise<KnowledgeMutationResult>;
  moveDocument(documentRef: KnowledgeDocumentRef, title: string, expectedRevision: string, parentRelativePath?: string | null, sourceEpoch?: number): Promise<KnowledgeDocumentSnapshot>;
  deleteDocument(documentRef: KnowledgeDocumentRef, expectedRevision: string, sourceEpoch?: number): Promise<void>;
  insertIntoCurrent(input: { text: string; appendIfNoCursor?: boolean }, sourceEpoch?: number): Promise<KnowledgeMutationResult>;
  activateUiSource(vaultId: string): Promise<KnowledgeUiSourceActivation>;
  activateCurrentUiSource(): Promise<KnowledgeUiSourceActivation>;
  deactivateUiSource(): Promise<void>;
  beginCurrentContextSession(sessionId: string, sourceEpoch: number): Promise<KnowledgeContextSession>;
  setCurrentContext(input: OrderedKnowledgeCurrentContextInput): Promise<KnowledgeCurrentContext>;
  clearCurrentContext(order: KnowledgeContextOrder): Promise<void>;
  getCurrentContext(): Promise<KnowledgeCurrentContext | null>;
  refreshIndex(modifiedPaths?: string[]): Promise<KnowledgeIndexSnapshot>;
  indexSnapshot(): Promise<KnowledgeIndexSnapshot>;
  documentRelations(documentRef: KnowledgeDocumentRef): Promise<KnowledgeDocumentRelations>;
  backlinks(documentRef: KnowledgeDocumentRef): Promise<KnowledgeBacklink[]>;
  tagSummary(): Promise<KnowledgeTagSummary[]>;
  documentsForTag(tag: string): Promise<KnowledgeDocumentSummary[]>;
  documentsReferencingEmbed(target: string): Promise<KnowledgeDocumentSummary[]>;
  setDocumentTags(documentRef: KnowledgeDocumentRef, expectedRevision: string, tags: string[], sourceEpoch?: number): Promise<KnowledgeMutationResult>;
};

function requirePreviewMethod<K extends keyof KnowledgePreviewAdapter>(
  preview: KnowledgePreviewAdapter,
  method: K,
): NonNullable<KnowledgePreviewAdapter[K]> {
  const value = preview[method];
  if (typeof value !== "function") {
    throw new KnowledgeServiceError("knowledge-preview-unsupported", `Preview knowledge method is unavailable: ${String(method)}`);
  }
  return value as NonNullable<KnowledgePreviewAdapter[K]>;
}

async function invokeKnowledge<T>(runtime: KnowledgeRuntime, command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await runtime.invoke<T>(command, args);
  } catch (error) {
    throw normalizeKnowledgeError(error);
  }
}

export function normalizeKnowledgeError(error: unknown): KnowledgeServiceError {
  if (error instanceof KnowledgeServiceError) return error;
  const raw = error instanceof Error ? error.message : String(error ?? "knowledge-operation-failed");
  try {
    const parsed = JSON.parse(raw) as { code?: unknown; message?: unknown };
    if (typeof parsed.code === "string") {
      return new KnowledgeServiceError(parsed.code, typeof parsed.message === "string" ? parsed.message : parsed.code);
    }
  } catch {}
  const prefixed = /^([a-z][a-z0-9-]+):\s*(.*)$/i.exec(raw);
  if (prefixed) return new KnowledgeServiceError(prefixed[1], prefixed[2] || prefixed[1]);
  return new KnowledgeServiceError("knowledge-operation-failed", raw);
}

export function knowledgeErrorMessage(error: unknown, fallback: string) {
  const normalized = normalizeKnowledgeError(error);
  if (normalized.code === "knowledge-vault-required"
    || normalized.code === "knowledge-vault-not-current"
    || normalized.code === "knowledge-source-inactive") {
    return "请先建立或打开知识库";
  }
  if (normalized.code === "knowledge-revision-conflict") return "文档已在外部修改，请重新打开后重试";
  if (normalized.code === "knowledge-current-context-required") return "当前没有打开的知识库文档";
  return fallback;
}

export function createKnowledgeClient(runtime: KnowledgeRuntime): KnowledgeClient {
  const withSourceEpoch = (args: Record<string, unknown>, sourceEpoch?: number) => (
    sourceEpoch === undefined ? args : { ...args, sourceEpoch }
  );
  return {
    listDocuments(input = {}) {
      if (!runtime.isTauri()) return runtime.preview.listDocuments(input);
      return invokeKnowledge(runtime, "knowledge_list_documents", input.limit === undefined ? {} : { limit: input.limit });
    },
    searchDocuments(query, limit) {
      if (!runtime.isTauri()) return requirePreviewMethod(runtime.preview, "searchDocuments").call(runtime.preview, query, limit);
      return invokeKnowledge(runtime, "knowledge_search_documents", { query, limit });
    },
    readDocument(documentRef) {
      if (!runtime.isTauri()) return requirePreviewMethod(runtime.preview, "readDocument").call(runtime.preview, documentRef);
      return invokeKnowledge(runtime, "knowledge_read_document", { documentRef });
    },
    createDocument(input, sourceEpoch) {
      if (!runtime.isTauri()) return requirePreviewMethod(runtime.preview, "createDocument").call(runtime.preview, input);
      return invokeKnowledge(runtime, "knowledge_create_document", withSourceEpoch({ input }, sourceEpoch));
    },
    appendDocument(documentRef, content, expectedRevision, sourceEpoch) {
      if (!runtime.isTauri()) {
        return requirePreviewMethod(runtime.preview, "appendDocument").call(runtime.preview, documentRef, content, expectedRevision);
      }
      return invokeKnowledge(runtime, "knowledge_append_document", withSourceEpoch({ input: { documentRef, content, expectedRevision } }, sourceEpoch));
    },
    insertDocument(documentRef, offset, text, expectedRevision, sourceEpoch) {
      if (!runtime.isTauri()) {
        return requirePreviewMethod(runtime.preview, "insertDocument").call(runtime.preview, documentRef, offset, text, expectedRevision);
      }
      return invokeKnowledge(runtime, "knowledge_insert_document", withSourceEpoch({ input: { documentRef, offset, text, expectedRevision } }, sourceEpoch));
    },
    replaceDocument(documentRef, content, expectedRevision, sourceEpoch) {
      if (!runtime.isTauri()) {
        return requirePreviewMethod(runtime.preview, "replaceDocument").call(runtime.preview, documentRef, content, expectedRevision);
      }
      return invokeKnowledge(runtime, "knowledge_replace_document", withSourceEpoch({ input: { documentRef, content, expectedRevision } }, sourceEpoch));
    },
    moveDocument(documentRef, title, expectedRevision, parentRelativePath, sourceEpoch) {
      if (!runtime.isTauri()) {
        return requirePreviewMethod(runtime.preview, "moveDocument").call(runtime.preview, documentRef, title, expectedRevision, parentRelativePath);
      }
      return invokeKnowledge(runtime, "knowledge_move_document", withSourceEpoch({ input: { documentRef, title, expectedRevision, parentRelativePath } }, sourceEpoch));
    },
    deleteDocument(documentRef, expectedRevision, sourceEpoch) {
      if (!runtime.isTauri()) {
        return requirePreviewMethod(runtime.preview, "deleteDocument").call(runtime.preview, documentRef, expectedRevision);
      }
      return invokeKnowledge(runtime, "knowledge_delete_document", withSourceEpoch({ input: { documentRef, expectedRevision } }, sourceEpoch));
    },
    insertIntoCurrent(input, sourceEpoch) {
      if (!runtime.isTauri()) return requirePreviewMethod(runtime.preview, "insertIntoCurrent").call(runtime.preview, input);
      return invokeKnowledge(runtime, "knowledge_insert_current", withSourceEpoch({ input }, sourceEpoch));
    },
    activateUiSource(vaultId) {
      if (!runtime.isTauri()) return requirePreviewMethod(runtime.preview, "activateUiSource").call(runtime.preview, vaultId);
      return invokeKnowledge(runtime, "knowledge_activate_ui_source", { vaultId });
    },
    activateCurrentUiSource() {
      if (!runtime.isTauri()) throw new KnowledgeServiceError("knowledge-source-inactive", "A real Vault is required");
      return invokeKnowledge(runtime, "knowledge_activate_current_ui_source");
    },
    deactivateUiSource() {
      if (!runtime.isTauri()) return requirePreviewMethod(runtime.preview, "deactivateUiSource").call(runtime.preview);
      return invokeKnowledge(runtime, "knowledge_deactivate_ui_source");
    },
    beginCurrentContextSession(sessionId, sourceEpoch) {
      if (!runtime.isTauri()) return requirePreviewMethod(runtime.preview, "beginCurrentContextSession").call(runtime.preview, sessionId);
      return invokeKnowledge(runtime, "knowledge_begin_current_context_session", { sessionId, sourceEpoch });
    },
    setCurrentContext(input) {
      if (!runtime.isTauri()) return requirePreviewMethod(runtime.preview, "setCurrentContext").call(runtime.preview, input);
      return invokeKnowledge(runtime, "knowledge_set_current_context", { input });
    },
    clearCurrentContext(order) {
      if (!runtime.isTauri()) return requirePreviewMethod(runtime.preview, "clearCurrentContext").call(runtime.preview, order);
      return invokeKnowledge(runtime, "knowledge_clear_current_context", { input: order });
    },
    getCurrentContext() {
      if (!runtime.isTauri()) return Promise.resolve(previewCurrent);
      return invokeKnowledge(runtime, "knowledge_get_current_context");
    },
    refreshIndex(modifiedPaths) {
      if (!runtime.isTauri()) return requirePreviewMethod(runtime.preview, "refreshIndex").call(runtime.preview);
      return invokeKnowledge(runtime, "knowledge_refresh_index", modifiedPaths ? { modifiedPaths } : undefined);
    },
    indexSnapshot() {
      if (!runtime.isTauri()) return requirePreviewMethod(runtime.preview, "indexSnapshot").call(runtime.preview);
      return invokeKnowledge(runtime, "knowledge_index_snapshot");
    },
    documentRelations(documentRef) {
      if (!runtime.isTauri()) return requirePreviewMethod(runtime.preview, "documentRelations").call(runtime.preview, documentRef);
      return invokeKnowledge(runtime, "knowledge_document_relations", { documentRef });
    },
    backlinks(documentRef) {
      if (!runtime.isTauri()) return requirePreviewMethod(runtime.preview, "backlinks").call(runtime.preview, documentRef);
      return invokeKnowledge(runtime, "knowledge_backlinks", { documentRef });
    },
    tagSummary() {
      if (!runtime.isTauri()) return requirePreviewMethod(runtime.preview, "tagSummary").call(runtime.preview);
      return invokeKnowledge(runtime, "knowledge_tag_summary");
    },
    documentsForTag(tag) {
      if (!runtime.isTauri()) return requirePreviewMethod(runtime.preview, "documentsForTag").call(runtime.preview, tag);
      return invokeKnowledge(runtime, "knowledge_documents_for_tag", { tag });
    },
    documentsReferencingEmbed(target) {
      if (!runtime.isTauri()) return requirePreviewMethod(runtime.preview, "documentsReferencingEmbed").call(runtime.preview, target);
      return invokeKnowledge(runtime, "knowledge_documents_referencing_embed", { target });
    },
    setDocumentTags(documentRef, expectedRevision, tags, sourceEpoch) {
      if (!runtime.isTauri()) {
        return requirePreviewMethod(runtime.preview, "setDocumentTags").call(runtime.preview, documentRef, expectedRevision, tags);
      }
      return invokeKnowledge(runtime, "knowledge_set_document_tags", withSourceEpoch({ input: { documentRef, expectedRevision, tags } }, sourceEpoch));
    },
  };
}

type PreviewRecord = KnowledgeDocumentSnapshot;
const PREVIEW_STORAGE_KEY = "luckyray:knowledge-preview-v1";
let previewMemory: PreviewRecord[] = [];
let previewCurrent: KnowledgeCurrentContext | null = null;
let previewContextSession: KnowledgeContextSession | null = null;
let previewContextGeneration = 0;
let previewNextSessionEpoch = 0;
let previewUiSourceEpoch = 0;

function readPreviewRecords(): PreviewRecord[] {
  if (typeof window === "undefined") return previewMemory;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PREVIEW_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writePreviewRecords(records: PreviewRecord[]) {
  previewMemory = records;
  if (typeof window === "undefined") return;
  window.localStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(records));
}

function previewRevision(content: string) {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `preview-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function normalizePreviewTitle(title: string) {
  const value = title.trim().replace(/[\\/:*?"<>|]/g, "-") || "Untitled";
  return value.toLowerCase().endsWith(".md") ? value.slice(0, -3) : value;
}

function previewSnapshot(documentRef: KnowledgeDocumentRef, title: string, content: string): PreviewRecord {
  return {
    documentRef,
    title,
    relativePath: documentRef.relativePath,
    modifiedAt: new Date().toISOString(),
    size: new TextEncoder().encode(content).byteLength,
    content,
    revision: previewRevision(content),
  };
}

function previewFind(documentRef: KnowledgeDocumentRef) {
  return readPreviewRecords().find((row) => row.documentRef.vaultId === documentRef.vaultId && row.documentRef.relativePath === documentRef.relativePath);
}

function requirePreviewContextOrder(order: KnowledgeContextOrder) {
  if (!previewContextSession
    || order.sessionId !== previewContextSession.sessionId
    || order.sessionEpoch !== previewContextSession.sessionEpoch
    || order.generation <= previewContextGeneration) {
    throw new KnowledgeServiceError("knowledge-context-stale", "Knowledge editor context update is stale");
  }
}

export const browserPreviewKnowledgeAdapter: KnowledgePreviewAdapter = {
  async listDocuments(input = {}) {
    const rows = [...readPreviewRecords()].sort((a, b) => (b.modifiedAt || "").localeCompare(a.modifiedAt || ""));
    return input.limit ? rows.slice(0, input.limit) : rows;
  },
  async activateUiSource(vaultId) {
    previewUiSourceEpoch += 1;
    return { vaultId, sourceEpoch: previewUiSourceEpoch };
  },
  async deactivateUiSource() {
    previewUiSourceEpoch += 1;
    previewCurrent = null;
  },
  async searchDocuments(query, limit) {
    const needle = query.trim().toLocaleLowerCase();
    const rows = readPreviewRecords().filter((row) => `${row.title}\n${row.relativePath}\n${row.content}`.toLocaleLowerCase().includes(needle));
    return limit ? rows.slice(0, limit) : rows;
  },
  async readDocument(documentRef) {
    const row = previewFind(documentRef);
    if (!row) throw new KnowledgeServiceError("knowledge-not-found", "Document not found");
    return row;
  },
  async createDocument(input) {
    const title = normalizePreviewTitle(input.title);
    const parent = (input.parentRelativePath || "").replace(/^\/+|\/+$/g, "");
    const relativePath = `${parent ? `${parent}/` : ""}${title}.md`;
    const documentRef = { vaultId: "browser-preview", relativePath };
    if (previewFind(documentRef)) throw new KnowledgeServiceError("knowledge-name-conflict", "Document already exists");
    const row = previewSnapshot(documentRef, title, input.content || "");
    writePreviewRecords([...readPreviewRecords(), row]);
    return row;
  },
  async appendDocument(documentRef, content, expectedRevision) {
    const row = previewFind(documentRef);
    if (!row) throw new KnowledgeServiceError("knowledge-not-found", "Document not found");
    if (expectedRevision && expectedRevision !== row.revision) throw new KnowledgeServiceError("knowledge-revision-conflict", "Document changed");
    const document = previewSnapshot(documentRef, row.title, row.content ? `${row.content}\n\n${content}` : content);
    writePreviewRecords(readPreviewRecords().map((candidate) => candidate.documentRef.relativePath === row.documentRef.relativePath ? document : candidate));
    return { document, position: "append" };
  },
  async insertDocument(documentRef, offset, text, expectedRevision) {
    const row = previewFind(documentRef);
    if (!row) throw new KnowledgeServiceError("knowledge-not-found", "Document not found");
    if (expectedRevision && expectedRevision !== row.revision) throw new KnowledgeServiceError("knowledge-revision-conflict", "Document changed");
    if (!Number.isInteger(offset) || offset < 0 || offset > row.content.length) {
      throw new KnowledgeServiceError("knowledge-offset-conflict", "Document offset is stale");
    }
    const document = previewSnapshot(documentRef, row.title, `${row.content.slice(0, offset)}${text}${row.content.slice(offset)}`);
    writePreviewRecords(readPreviewRecords().map((candidate) => candidate.documentRef.relativePath === row.documentRef.relativePath ? document : candidate));
    return { document, position: "cursor" };
  },
  async replaceDocument(documentRef, content, expectedRevision) {
    const row = previewFind(documentRef);
    if (!row) throw new KnowledgeServiceError("knowledge-not-found", "Document not found");
    if (expectedRevision && expectedRevision !== row.revision) throw new KnowledgeServiceError("knowledge-revision-conflict", "Document changed");
    const document = previewSnapshot(documentRef, row.title, content);
    writePreviewRecords(readPreviewRecords().map((candidate) => candidate.documentRef.relativePath === row.documentRef.relativePath ? document : candidate));
    return { document, position: "replace" };
  },
  async insertIntoCurrent(input) {
    if (!previewCurrent) throw new KnowledgeServiceError("knowledge-current-context-required", "No current document");
    const row = previewFind(previewCurrent.documentRef);
    if (!row) throw new KnowledgeServiceError("knowledge-not-found", "Document not found");
    if (row.revision !== previewCurrent.expectedRevision) throw new KnowledgeServiceError("knowledge-revision-conflict", "Document changed");
    const offset = previewCurrent.cursorOffset;
    const content = offset == null
      ? (input.appendIfNoCursor === false ? row.content : `${row.content}${row.content ? "\n\n" : ""}${input.text}`)
      : `${row.content.slice(0, offset)}${input.text}${row.content.slice(offset)}`;
    const document = previewSnapshot(row.documentRef, row.title, content);
    writePreviewRecords(readPreviewRecords().map((candidate) => candidate.documentRef.relativePath === row.documentRef.relativePath ? document : candidate));
    previewCurrent = { ...previewCurrent, expectedRevision: document.revision, cursorOffset: offset == null ? null : offset + input.text.length };
    return { document, position: offset == null ? "append" : "cursor" };
  },
  async beginCurrentContextSession(sessionId) {
    previewNextSessionEpoch += 1;
    previewContextSession = { sessionId, sessionEpoch: previewNextSessionEpoch };
    previewContextGeneration = 0;
    previewCurrent = null;
    return previewContextSession;
  },
  async setCurrentContext(input) {
    requirePreviewContextOrder(input);
    const row = previewFind(input.documentRef);
    if (!row) throw new KnowledgeServiceError("knowledge-not-found", "Document not found");
    if (input.expectedRevision && input.expectedRevision !== row.revision) throw new KnowledgeServiceError("knowledge-revision-conflict", "Document changed");
    previewContextGeneration = input.generation;
    previewCurrent = {
      documentRef: input.documentRef,
      cursorOffset: input.cursorOffset ?? null,
      selection: input.selection ?? null,
      expectedRevision: row.revision,
      updatedAt: new Date().toISOString(),
    };
    return previewCurrent;
  },
  async clearCurrentContext(order) {
    requirePreviewContextOrder(order);
    previewContextGeneration = order.generation;
    previewCurrent = null;
  },
};

const defaultRuntime: KnowledgeRuntime = {
  isTauri: () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window,
  invoke: async <T>(command: string, args?: Record<string, unknown>) => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command, args);
  },
  preview: browserPreviewKnowledgeAdapter,
};

const defaultClient = createKnowledgeClient(defaultRuntime);
// Explicit-source adapters must capture an activated epoch before opening UI.
// Native Knowledge owns writes/revisions; callers must also honor live editor drafts.
export const sourceBoundKnowledgeWrites = {
  createDocument: defaultClient.createDocument,
  insertDocument: defaultClient.insertDocument,
};

// Production source identity is stable until an explicit session/scope change.
// Readers must return that captured object, not construct a projection per call.
type ActiveKnowledgeSourceReader = () => ActiveKnowledgeSource | null;
type ActiveRealVaultSource = ActiveKnowledgeSource & { mode: "real-vault"; vaultId: string };

export function createActiveKnowledgeUiClient(
  client: KnowledgeClient,
  readSource: ActiveKnowledgeSourceReader = readActiveKnowledgeWriteSource,
) {
  let activation: KnowledgeUiSourceActivation | null = null;
  let activationSource: ActiveKnowledgeSource | null = null;
  let transition: Promise<void> = Promise.resolve();

  const serializeTransition = <T>(operation: () => Promise<T>) => {
    const result = transition.then(operation, operation);
    transition = result.then(() => undefined, () => undefined);
    return result;
  };

  const requireSource = (): ActiveRealVaultSource => {
    const source = readSource();
    if (source?.mode !== "real-vault" || !source.vaultId) {
      throw new KnowledgeServiceError("knowledge-source-inactive", "Knowledge writes require the active real Vault source");
    }
    return source as ActiveRealVaultSource;
  };

  const ensureActive = async (): Promise<KnowledgeUiSourceActivation> => {
    const requested = requireSource();
    return serializeTransition(async () => {
      const current = requireSource();
      if (current !== requested) {
        throw new KnowledgeServiceError("knowledge-source-inactive", "Knowledge source changed before activation started");
      }
      const cached = activation;
      // Reopening the same Vault retires its epoch too. Revalidation does not.
      if (cached?.vaultId === current.vaultId && activationSource === current) return cached;
      const next = await client.activateUiSource(current.vaultId);
      const latest = readSource();
      if (latest !== current) {
        await client.deactivateUiSource().catch(() => undefined);
        activation = null;
        activationSource = null;
        throw new KnowledgeServiceError("knowledge-source-inactive", "Knowledge source changed before activation completed");
      }
      activation = next;
      activationSource = current;
      return next;
    });
  };

  const requireLatestActivation = (active: KnowledgeUiSourceActivation, documentRef?: KnowledgeDocumentRef) => {
    const latest = requireSource();
    if (latest !== activationSource || active !== activation
        || latest.vaultId !== active.vaultId || (documentRef && documentRef.vaultId !== active.vaultId)) {
      throw new KnowledgeServiceError("knowledge-source-inactive", "Knowledge document is not in the active real Vault");
    }
  };

  return {
    ensureActive,
    restoreCurrent: (publishSource: (active: KnowledgeUiSourceActivation) => void) => serializeTransition(async () => {
      const requested = readSource();
      const next = await client.activateCurrentUiSource();
      if (readSource() !== requested) {
        throw new KnowledgeServiceError("knowledge-source-inactive", "Knowledge source changed before restoration completed");
      }
      publishSource(next);
      const current = requireSource();
      if (current.vaultId !== next.vaultId) {
        throw new KnowledgeServiceError("knowledge-source-inactive", "Restored Knowledge source does not match the current Vault");
      }
      activation = next;
      activationSource = current;
      return next;
    }),
    deactivate: () => serializeTransition(async () => {
      activation = null;
      activationSource = null;
      await client.deactivateUiSource();
    }),
    async createDocument(input: KnowledgeCreateInput) {
      const active = await ensureActive();
      requireLatestActivation(active);
      return client.createDocument(input, active.sourceEpoch);
    },
    async appendDocument(documentRef: KnowledgeDocumentRef, content: string, expectedRevision?: string | null) {
      const active = await ensureActive();
      requireLatestActivation(active, documentRef);
      return client.appendDocument(documentRef, content, expectedRevision, active.sourceEpoch);
    },
    async insertDocument(documentRef: KnowledgeDocumentRef, offset: number, text: string, expectedRevision?: string | null) {
      const active = await ensureActive();
      requireLatestActivation(active, documentRef);
      return client.insertDocument(documentRef, offset, text, expectedRevision, active.sourceEpoch);
    },
    async replaceDocument(documentRef: KnowledgeDocumentRef, content: string, expectedRevision?: string | null) {
      const active = await ensureActive();
      requireLatestActivation(active, documentRef);
      return client.replaceDocument(documentRef, content, expectedRevision, active.sourceEpoch);
    },
    async insertIntoCurrent(input: { text: string; appendIfNoCursor?: boolean }) {
      const active = await ensureActive();
      requireLatestActivation(active);
      return client.insertIntoCurrent(input, active.sourceEpoch);
    },
    async setDocumentTags(documentRef: KnowledgeDocumentRef, expectedRevision: string, tags: string[]) {
      const active = await ensureActive();
      requireLatestActivation(active, documentRef);
      return client.setDocumentTags(documentRef, expectedRevision, tags, active.sourceEpoch);
    },
    async moveDocument(documentRef: KnowledgeDocumentRef, title: string, expectedRevision: string, parentRelativePath?: string | null) {
      const active = await ensureActive();
      requireLatestActivation(active, documentRef);
      return client.moveDocument(documentRef, title, expectedRevision, parentRelativePath, active.sourceEpoch);
    },
    async deleteDocument(documentRef: KnowledgeDocumentRef, expectedRevision: string) {
      const active = await ensureActive();
      requireLatestActivation(active, documentRef);
      return client.deleteDocument(documentRef, expectedRevision, active.sourceEpoch);
    },
  };
}

const defaultActiveUiClient = createActiveKnowledgeUiClient(defaultClient);

export const ensureActiveKnowledgeUiSource = defaultActiveUiClient.ensureActive;
export const deactivateKnowledgeUiSource = defaultActiveUiClient.deactivate;

/** Restores UI state only after Backend confirms its current real Vault. */
export async function activateBackendCurrentKnowledgeUiSource(): Promise<KnowledgeUiSourceActivation> {
  return defaultActiveUiClient.restoreCurrent(activation => {
    const current = readActiveKnowledgeWriteSource();
    setActiveKnowledgeSource({ mode: "real-vault", vaultId: activation.vaultId,
      rootPath: current?.vaultId === activation.vaultId ? current.rootPath : null }, true);
  });
}

export const listKnowledgeDocuments = defaultClient.listDocuments;
export const searchKnowledgeDocuments = defaultClient.searchDocuments;
export const readKnowledgeDocument = defaultClient.readDocument;
export const createKnowledgeDocument = defaultActiveUiClient.createDocument;
export const appendKnowledgeDocument = defaultActiveUiClient.appendDocument;
export const insertKnowledgeDocument = defaultActiveUiClient.insertDocument;
export const replaceKnowledgeDocument = defaultActiveUiClient.replaceDocument;
export const moveKnowledgeDocument = defaultActiveUiClient.moveDocument;
export const deleteKnowledgeDocument = defaultActiveUiClient.deleteDocument;
export const insertIntoCurrentKnowledgeDocument = defaultActiveUiClient.insertIntoCurrent;
export const setActiveKnowledgeDocumentTags = defaultActiveUiClient.setDocumentTags;
export const refreshKnowledgeIndex = defaultClient.refreshIndex;
export const readKnowledgeIndexSnapshot = defaultClient.indexSnapshot;
export const readKnowledgeDocumentRelations = defaultClient.documentRelations;
export const getCurrentKnowledgeContext = defaultClient.getCurrentContext;
export const readKnowledgeBacklinks = defaultClient.backlinks;
export const readKnowledgeTagSummary = defaultClient.tagSummary;
export const readKnowledgeDocumentsForTag = defaultClient.documentsForTag;
export const readKnowledgeDocumentsReferencingEmbed = defaultClient.documentsReferencingEmbed;

export type KnowledgeTagCommitInput = {
  documentRef: KnowledgeDocumentRef;
  expectedRevision: string;
  tags: string[];
  editorContent: string;
  savedContent: string;
};

function normalizedEditorContent(value: string) {
  return value.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export async function commitKnowledgeDocumentTags(
  input: KnowledgeTagCommitInput,
  writer: (
    documentRef: KnowledgeDocumentRef,
    expectedRevision: string,
    tags: string[],
  ) => Promise<KnowledgeMutationResult> = setActiveKnowledgeDocumentTags,
) {
  if (normalizedEditorContent(input.editorContent) !== normalizedEditorContent(input.savedContent)) {
    throw new KnowledgeServiceError(
      "knowledge-editor-dirty",
      "Save the current document before changing its tags",
    );
  }
  return writer(input.documentRef, input.expectedRevision, input.tags);
}

export function knowledgeMutationSuccessStatus(
  result: KnowledgeMutationResult,
  successMessage: string,
) {
  return result.indexWarning || result.indexStale
    ? `${successMessage}，索引刷新稍后重试`
    : successMessage;
}
export const beginCurrentKnowledgeContextSession = defaultClient.beginCurrentContextSession;
export const setCurrentKnowledgeContext = defaultClient.setCurrentContext;
export const clearCurrentKnowledgeContext = defaultClient.clearCurrentContext;

function isCanonicalKnowledgeDocumentRef(value: unknown): value is KnowledgeDocumentRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("vaultId") || !keys.includes("relativePath")) return false;
  const candidate = value as Partial<KnowledgeDocumentRef>;
  if (typeof candidate.vaultId !== "string" || candidate.vaultId.trim() !== candidate.vaultId || !candidate.vaultId) return false;
  if (typeof candidate.relativePath !== "string" || candidate.relativePath.trim() !== candidate.relativePath || !candidate.relativePath) return false;
  const path = candidate.relativePath;
  if (path.startsWith("/") || path.startsWith("~") || path.includes(":")) return false;
  if (path.includes("\\") || path.includes("\0") || !path.toLowerCase().endsWith(".md")) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment
    && segment !== "."
    && segment !== ".."
    && segment.toLowerCase() !== ".luckyray");
}

export function knowledgeDocumentNoteId(documentRef: KnowledgeDocumentRef) {
  if (!isCanonicalKnowledgeDocumentRef(documentRef)) {
    throw new KnowledgeServiceError("knowledge-invalid-document-ref", "Knowledge document reference is invalid");
  }
  const payload = new TextEncoder().encode(JSON.stringify({
    vaultId: documentRef.vaultId,
    relativePath: documentRef.relativePath,
  }));
  const encoded = Array.from(payload, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `kdoc-${encoded}`;
}

export function parseKnowledgeDocumentNoteId(noteId: string): KnowledgeDocumentRef | null {
  if (!noteId.startsWith("kdoc-")) return null;
  const encoded = noteId.slice("kdoc-".length);
  if (!encoded || encoded.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(encoded)) return null;
  const bytes = new Uint8Array(encoded.length / 2);
  for (let index = 0; index < encoded.length; index += 2) {
    bytes[index / 2] = Number.parseInt(encoded.slice(index, index + 2), 16);
  }
  try {
    const payload = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const documentRef = JSON.parse(payload) as unknown;
    if (!isCanonicalKnowledgeDocumentRef(documentRef)) return null;
    return knowledgeDocumentNoteId(documentRef) === noteId ? documentRef : null;
  } catch {
    return null;
  }
}

export type KnowledgeNoteNavigationDecision =
  | { ok: true; documentRef: KnowledgeDocumentRef; internalNoteId: string }
  | { ok: false; code: "knowledge-note-id-invalid" | "knowledge-note-vault-mismatch" | "knowledge-vault-required" };

export function resolveKnowledgeNoteNavigation(
  noteId: string,
  currentVaultId: string | null | undefined,
): KnowledgeNoteNavigationDecision {
  const documentRef = parseKnowledgeDocumentNoteId(noteId);
  if (!documentRef) return { ok: false, code: "knowledge-note-id-invalid" };
  if (!currentVaultId) return { ok: false, code: "knowledge-vault-required" };
  if (documentRef.vaultId !== currentVaultId) {
    return { ok: false, code: "knowledge-note-vault-mismatch" };
  }
  return {
    ok: true,
    documentRef,
    internalNoteId: `real-vault:${documentRef.relativePath}`,
  };
}
