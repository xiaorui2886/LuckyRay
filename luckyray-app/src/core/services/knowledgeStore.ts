import type {
  BridgeNotesVaultFileNode,
  BridgeNotesVaultMarkdownIndex,
  BridgeVaultMetadata,
} from "../bridge/bridgeTypes";
import { getLuckyRayBridgeSync, type LuckyRayBridge } from "../bridge/luckyRayBridge";
import type { KnowledgeTreeNode } from "../bridge/knowledgeTypes";
import { refreshKnowledgeIndex, type KnowledgeIndexSnapshot } from "./knowledge";
import { clearActiveKnowledgeSource, setActiveKnowledgeSource, type ActiveKnowledgeSourceMode } from "./knowledgeSource";
import { VaultFileChangeQueue, markdownContentChanges, type VaultFileChangeBatch } from "./vaultFileChanges";
import { invalidateKnowledgeAttachmentInventory } from "./vaultAttachments";
import { clearAttachmentResolutionReads } from "./vaultAttachmentResolution";
import { knowledgeCommittedPaths, readKnowledgeCommittedCheckpoint } from "./knowledgeLiveSync";

export type KnowledgeStoreMarkdownIndex = BridgeNotesVaultMarkdownIndex & {
  generation: number;
  stale: boolean;
  refreshError: { code: string; message: string } | null;
};

export function adaptKnowledgeIndexToLegacy(
  index: KnowledgeIndexSnapshot,
  rootPath: string,
): KnowledgeStoreMarkdownIndex {
  return {
    vaultId: index.vaultId,
    rootPath,
    generatedAt: index.builtAt,
    generation: index.generation,
    stale: index.stale,
    refreshError: index.refreshError,
    version: index.version,
    changedPaths: index.changedPaths,
    removedPaths: index.removedPaths,
    errors: index.errors.map((error) => ({
      code: error.code,
      message: error.message,
      relativePath: error.relativePath,
    })),
    documents: index.documents.map((document) => ({
      relativePath: document.relativePath,
      absolutePath: "",
      fileName: document.fileName,
      title: document.title,
      revision: document.revision,
      headings: document.headings,
      wikiLinks: document.wikiLinks,
      embeds: document.embeds,
      tags: document.tags,
      frontmatterTags: document.frontmatterTags,
      inlineTags: document.inlineTags,
      plainText: document.plainText,
      excerpt: document.excerpt,
      contentLength: document.contentLength,
      mtime: document.modifiedAt,
      size: document.size,
    })),
  };
}

type KnowledgeStoreBridge = Pick<
  LuckyRayBridge,
  "getCurrentNotesVault" | "listNotesVaultFiles" | "getNotesVaultMarkdownIndex"
>;

export type KnowledgeStoreLoadResult =
  | {
      mode: "real-vault";
      vault: BridgeVaultMetadata;
      root: BridgeNotesVaultFileNode;
      markdownIndex: KnowledgeStoreMarkdownIndex;
    }
  | { mode: "vault-required"; vault: null };

export async function loadKnowledgeStoreData(
  bridge: KnowledgeStoreBridge,
  refreshIndex: () => Promise<KnowledgeIndexSnapshot> = refreshKnowledgeIndex,
  isTauriRuntime: () => boolean = () => (
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
  ),
): Promise<KnowledgeStoreLoadResult> {
  const vault = await bridge.getCurrentNotesVault?.() || null;
  if (!vault) {
    return { mode: "vault-required", vault: null };
  }
  const rootPromise = bridge.listNotesVaultFiles(vault);
  if (!isTauriRuntime()) {
    const [root, previewIndex] = await Promise.all([
      rootPromise,
      bridge.getNotesVaultMarkdownIndex(vault),
    ]);
    return {
      mode: "real-vault",
      vault,
      root,
      markdownIndex: {
        ...previewIndex,
        generation: previewIndex.version,
        stale: false,
        refreshError: null,
      },
    };
  }
  const [root, knowledgeIndex] = await Promise.all([rootPromise, refreshIndex()]);
  if (knowledgeIndex.vaultId !== vault.id) {
    throw new Error("knowledge-vault-not-current: Knowledge index belongs to a different Vault");
  }
  return {
    mode: "real-vault",
    vault,
    root,
    markdownIndex: adaptKnowledgeIndexToLegacy(knowledgeIndex, vault.rootPath),
  };
}

export type KnowledgeStoreStatus = "idle" | "loading" | "refreshing" | "ready" | "error";

export type KnowledgeStoreSnapshot = {
  mode: ActiveKnowledgeSourceMode | "vault-required";
  vault: BridgeVaultMetadata | null;
  tree: KnowledgeTreeNode[];
  markdownIndex: KnowledgeStoreMarkdownIndex | null;
  loaded: boolean;
  status: KnowledgeStoreStatus;
  error: string | null;
  version: number;
  updatedAt: number | null;
  lastReason: string | null;
  attachmentChanges?: VaultFileChangeBatch | null;
  attachmentResolutionRevision?: number;
};

export function hasUsableKnowledgeSnapshot(snapshot: Pick<KnowledgeStoreSnapshot, "loaded">): boolean {
  return snapshot.loaded;
}

export type KnowledgeStoreInvalidation = {
  reason: string;
  force?: boolean;
  modifiedPaths?: string[];
};

export function attachmentIndexSignature(index: BridgeNotesVaultMarkdownIndex | null) {
  return JSON.stringify((index?.documents || []).flatMap(document => document.embeds.map(embed => [document.relativePath, embed.target, embed.kind])));
}

function updateTreeDates(tree: KnowledgeTreeNode[], index: BridgeNotesVaultMarkdownIndex): KnowledgeTreeNode[] {
  const documents = new Map(index.documents.map(document => [document.relativePath, document]));
  const visit = (nodes: KnowledgeTreeNode[]): KnowledgeTreeNode[] => nodes.map(node => node.children
    ? { ...node, children: visit(node.children) }
    : { ...node, updatedAt: documents.get(node.relativePath || "")?.mtime || node.updatedAt });
  return visit(tree);
}

type KnowledgeDocumentPathSnapshot = {
  mode: string;
  vault: { id: string } | null;
  tree: KnowledgeTreeNode[];
};

function normalizedKnowledgeRelativePath(value: string) {
  return value.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
}

function absoluteLocalPath(value: string) {
  return /^[a-z]:[\\/]/iu.test(value)
    || /^\\\\(?:\?\\)?[^\\/]+[\\/][^\\/]+/u.test(value)
    || value.startsWith("/");
}

/** Resolve an indexed Vault document to the bridge-provided canonical path. */
export function resolveKnowledgeDocumentAbsolutePath(
  snapshot: KnowledgeDocumentPathSnapshot,
  documentRef: { vaultId: string; relativePath: string },
) {
  if (snapshot.mode !== "real-vault" || snapshot.vault?.id !== documentRef.vaultId) return null;
  const target = normalizedKnowledgeRelativePath(documentRef.relativePath);
  if (!target) return null;
  const pending = [...snapshot.tree];
  while (pending.length) {
    const node = pending.shift()!;
    if (node.kind === "document"
      && normalizedKnowledgeRelativePath(node.relativePath || "") === target
      && typeof node.absolutePath === "string"
      && absoluteLocalPath(node.absolutePath)) {
      return node.absolutePath;
    }
    if (node.children?.length) pending.unshift(...node.children);
  }
  return null;
}

type StoreListener = () => void;
type ActiveRequest = {
  sequence: number;
  controller: AbortController;
  promise: Promise<KnowledgeStoreSnapshot>;
};

const INVALIDATION_BATCH_MS = 64;
const TAG_INDEX_CACHE_KEY = "luckyray:notes-vault-frontmatter-tag-index-v1";

function vaultNodeToKnowledgeTreeNode(node: BridgeNotesVaultFileNode): KnowledgeTreeNode {
  const isFolder = node.kind === "folder";
  return {
    id: node.relativePath,
    kind: isFolder ? "folder" : "document",
    title: node.name,
    relativePath: node.relativePath,
    absolutePath: node.absolutePath,
    parentId: node.relativePath.includes("/") ? node.relativePath.slice(0, node.relativePath.lastIndexOf("/")) : null,
    children: isFolder ? (node.children || []).map(vaultNodeToKnowledgeTreeNode) : undefined,
    updatedAt: node.mtime || undefined,
    source: "real-vault",
  };
}

export class KnowledgeStore {
  private readonly loadData: (bridge: KnowledgeStoreBridge) => Promise<KnowledgeStoreLoadResult>;
  private readonly readBridge: () => LuckyRayBridge | null;
  private readonly refreshModifiedIndex: (paths: string[]) => Promise<KnowledgeIndexSnapshot>;
  private snapshot: KnowledgeStoreSnapshot = {
    mode: "vault-required",
    vault: null,
    tree: [],
    markdownIndex: null,
    loaded: false,
    status: "idle",
    error: null,
    version: 0,
    updatedAt: null,
    lastReason: null,
  };
  private listeners = new Set<StoreListener>();
  private sequence = 0;
  private activeRequest: ActiveRequest | null = null;
  private invalidationTimer: ReturnType<typeof setTimeout> | null = null;
  private invalidationGeneration = 0;
  private invalidationReasons = new Set<string>();
  private invalidationModifiedPaths: Set<string> | null = new Set();
  private invalidationPromise: Promise<KnowledgeStoreSnapshot> | null = null;
  private resolveInvalidation: ((snapshot: KnowledgeStoreSnapshot) => void) | null = null;
  private watchedRoot: string | null = null;
  private watchSession = 0;
  private watchDispose: (() => void) | null = null;
  private watchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly fileChanges = new VaultFileChangeQueue();
  private fileChangeGeneration = 0;
  private fallbackInterval: ReturnType<typeof setInterval> | null = null;
  private fallbackFocusListener: (() => void) | null = null;
  private fallbackVisibilityListener: (() => void) | null = null;
  private committedDispose: (() => void) | null = null;
  private committedFallback: ReturnType<typeof setInterval> | null = null;
  private readonly readCommittedCheckpoint: (vaultId: string) => Promise<string | null>;

  constructor(
    loadData: (bridge: KnowledgeStoreBridge) => Promise<KnowledgeStoreLoadResult> = loadKnowledgeStoreData,
    readBridge: () => LuckyRayBridge | null = getLuckyRayBridgeSync,
    refreshModifiedIndex: (paths: string[]) => Promise<KnowledgeIndexSnapshot> = refreshKnowledgeIndex,
    readCommittedCheckpoint: (vaultId: string) => Promise<string | null> = readKnowledgeCommittedCheckpoint,
  ) {
    this.loadData = loadData;
    this.readBridge = readBridge;
    this.refreshModifiedIndex = refreshModifiedIndex;
    this.readCommittedCheckpoint = readCommittedCheckpoint;
  }

  // React's useSyncExternalStore receives this as a bare reference; an arrow
  // field keeps the store bound instead of crashing on an undefined receiver.
  subscribe = (listener: StoreListener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  ensureSnapshot(input: { reason: string }) {
    if (this.snapshot.loaded) return Promise.resolve(this.snapshot);
    return this.revalidate({ reason: input.reason });
  }

  revalidate(input: KnowledgeStoreInvalidation) {
    if (this.activeRequest && !input.force) return this.activeRequest.promise;
    if (this.activeRequest) this.activeRequest.controller.abort();

    const bridge = this.readBridge();
    if (!bridge) return Promise.reject(new Error("LuckyRay bridge is not ready"));

    const sequence = ++this.sequence;
    const controller = new AbortController();
    this.publish({
      status: this.snapshot.loaded ? "refreshing" : "loading",
      error: null,
      lastReason: input.reason,
    });

    const request: ActiveRequest = {
      sequence,
      controller,
      promise: Promise.resolve(this.snapshot),
    };
    request.promise = (async () => {
      try {
        const seed = this.snapshot;
        const knownPaths = new Set(seed.markdownIndex?.documents.map(document => document.relativePath));
        const modified = input.modifiedPaths?.length && input.modifiedPaths.length <= 256
          && input.modifiedPaths.every(path => knownPaths.has(path)) ? input.modifiedPaths : null;
        let loaded: KnowledgeStoreLoadResult;
        let retainedTree: KnowledgeTreeNode[] | undefined;
        if (modified && seed.vault && seed.markdownIndex) {
          const refreshed = await this.refreshModifiedIndex(modified);
          if (!this.isCurrent(request)) return this.snapshot;
          if (refreshed.vaultId !== seed.vault.id) throw new Error("knowledge-vault-not-current: Modified document index belongs to another Vault");
          const structureChanged = refreshed.documents.length !== knownPaths.size
            || refreshed.documents.some(document => !knownPaths.has(document.relativePath));
          if (structureChanged) {
            loaded = await this.loadData(bridge);
          } else {
            const markdownIndex = adaptKnowledgeIndexToLegacy(refreshed, seed.vault.rootPath);
            retainedTree = refreshed.version === seed.markdownIndex.version ? seed.tree : updateTreeDates(seed.tree, markdownIndex);
            loaded = { mode: "real-vault", vault: seed.vault, markdownIndex,
              root: { kind: "folder", name: seed.vault.name, relativePath: "", absolutePath: seed.vault.rootPath, mtime: null, size: 0, children: [] } };
          }
        } else loaded = await this.loadData(bridge);
        if (!this.isCurrent(request)) return this.snapshot;

        if (loaded.mode === "real-vault") {
          const { vault, root, markdownIndex } = loaded;
          const previousVaultId = this.snapshot.vault?.id || null;
          const previousIndexVersion = this.snapshot.markdownIndex?.version || 0;
          const previousIndex = previousVaultId === vault.id ? this.snapshot.markdownIndex : null;
          const indexForSnapshot = previousIndex?.version === markdownIndex.version
            && previousIndex.stale === markdownIndex.stale && JSON.stringify(previousIndex.refreshError) === JSON.stringify(markdownIndex.refreshError)
            ? previousIndex
            : markdownIndex;
          this.publishReady({
            mode: "real-vault",
            vault,
            tree: retainedTree || (root.children || []).map(vaultNodeToKnowledgeTreeNode),
            markdownIndex: indexForSnapshot,
          }, input.reason);
          this.cacheTagIndex(vault, indexForSnapshot);
          if (previousVaultId !== vault.id || previousIndexVersion !== indexForSnapshot.version) {
            this.publishIndexChanged(vault, indexForSnapshot, attachmentIndexSignature(previousIndex) !== attachmentIndexSignature(indexForSnapshot));
          }
          this.ensureVaultWatch(vault);
        } else {
          this.publishReady({
            mode: "vault-required",
            vault: null,
            tree: [],
            markdownIndex: null,
          }, input.reason);
          this.stopVaultWatch();
        }
      } catch (error) {
        if (!this.isCurrent(request) || controller.signal.aborted) return this.snapshot;
        this.publish({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          lastReason: input.reason,
        });
      } finally {
        if (this.activeRequest?.sequence === sequence) this.activeRequest = null;
      }
      return this.snapshot;
    })();
    this.activeRequest = request;
    return request.promise;
  }

  invalidate(input: KnowledgeStoreInvalidation) {
    const generation = ++this.invalidationGeneration;
    this.invalidationReasons.add(input.reason);
    if (!input.modifiedPaths) this.invalidationModifiedPaths = null;
    else if (this.invalidationModifiedPaths) for (const path of input.modifiedPaths) this.invalidationModifiedPaths.add(path);
    if (this.invalidationTimer) clearTimeout(this.invalidationTimer);
    if (!this.invalidationPromise) {
      this.invalidationPromise = new Promise((resolve) => {
        this.resolveInvalidation = resolve;
      });
    }
    this.invalidationTimer = setTimeout(async () => {
      this.invalidationTimer = null;
      const reason = Array.from(this.invalidationReasons).join(",") || input.reason;
      this.invalidationReasons.clear();
      const modifiedPaths = this.invalidationModifiedPaths ? [...this.invalidationModifiedPaths] : undefined;
      this.invalidationModifiedPaths = new Set();
      const snapshot = await this.revalidate({ reason, force: true, modifiedPaths }).catch(() => this.snapshot);
      if (generation !== this.invalidationGeneration) return;
      this.resolveInvalidation?.(snapshot);
      this.resolveInvalidation = null;
      this.invalidationPromise = null;
    }, INVALIDATION_BATCH_MS);
    return this.invalidationPromise;
  }

  private isCurrent(request: ActiveRequest) {
    return this.activeRequest?.sequence === request.sequence && !request.controller.signal.aborted;
  }

  private publishReady(
    data: Pick<KnowledgeStoreSnapshot, "mode" | "vault" | "tree" | "markdownIndex">,
    reason: string,
  ) {
    this.publish({
      ...data,
      loaded: true,
      status: "ready",
      error: null,
      version: this.snapshot.version + (data.markdownIndex === this.snapshot.markdownIndex && data.tree === this.snapshot.tree ? 0 : 1),
      updatedAt: Date.now(),
      lastReason: reason,
    });
    if (data.mode === "real-vault") {
      setActiveKnowledgeSource({
        mode: data.mode,
        vaultId: data.vault?.id || null,
        rootPath: data.vault?.rootPath || null,
      });
    } else {
      clearActiveKnowledgeSource();
    }
  }

  private cacheTagIndex(vault: BridgeVaultMetadata, index: BridgeNotesVaultMarkdownIndex) {
    if (typeof sessionStorage === "undefined") return;
    try {
      sessionStorage.setItem(TAG_INDEX_CACHE_KEY, JSON.stringify({
        vaultId: vault.id,
        rootPath: vault.rootPath,
        generatedAt: index.generatedAt,
        cachedAt: Date.now(),
        documents: (index.documents || []).map((document) => ({
          relativePath: document.relativePath,
          fileName: document.fileName,
          title: document.title,
          excerpt: document.excerpt,
          mtime: document.mtime,
          frontmatterTags: document.frontmatterTags || [],
        })),
      }));
    } catch {
      // This compatibility cache is best effort only.
    }
  }

  private publishIndexChanged(vault: BridgeVaultMetadata, index: BridgeNotesVaultMarkdownIndex, attachmentsChanged: boolean) {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("luckyray:notes-vault-index-changed", {
      detail: { vaultId: vault.id, rootPath: vault.rootPath, generatedAt: index.generatedAt, attachmentsChanged },
    }));
  }

  private ensureVaultWatch(vault: BridgeVaultMetadata) {
    if (typeof window === "undefined" || this.watchedRoot === vault.rootPath) return;
    this.stopVaultWatch();
    this.watchedRoot = vault.rootPath;
    const session = ++this.watchSession;
    this.startCommittedObservation(vault, session);
    void import("@tauri-apps/plugin-fs")
      .then(({ watch }) => watch(vault.rootPath, (event) => {
        if (session !== this.watchSession) return;
        if (!event.paths?.length) {
          this.fileChanges.add(null, Date.now());
          this.queueVaultWatchRefresh();
          return;
        }
        const paths = (event.paths || []).filter((path) => this.isRelevantVaultPath(path, vault.rootPath));
        if (!paths.length) return;
        this.fileChanges.add({ paths, type: event.type }, Date.now());
        this.queueVaultWatchRefresh();
      }, { recursive: true, delayMs: 650 }))
      .then((dispose) => {
        if (session !== this.watchSession) dispose();
        else this.watchDispose = dispose;
      })
      .catch((error) => {
        if (session !== this.watchSession) return;
        console.warn("[KnowledgeStore] vault watcher unavailable; using low-frequency reconciliation", error);
        this.startWatchFallback();
      });
  }

  private queueVaultWatchRefresh() {
    if (this.watchDebounceTimer) clearTimeout(this.watchDebounceTimer);
    this.watchDebounceTimer = setTimeout(async () => {
      this.watchDebounceTimer = null;
      const vault = this.snapshot.vault;
      const watchSession = this.watchSession;
      const batch = this.fileChanges.drain();
      let modifiedPaths: string[] | undefined;
      if (vault && vault.rootPath === this.watchedRoot) {
        const attachmentChanges: VaultFileChangeBatch = {
          ...batch, vaultId: vault.id, rootPath: vault.rootPath,
          session: this.watchSession, generation: ++this.fileChangeGeneration,
        };
        // Non-Markdown file events (or an incomplete batch) change the
        // attachment tree the backend caches a shared snapshot of; the
        // document index never reports those paths, so drop it explicitly.
        if (!markdownContentChanges(attachmentChanges)) {
          try { await invalidateKnowledgeAttachmentInventory(vault.id); }
          catch (error) {
            if (watchSession === this.watchSession) this.publish({ status: "error", error: String(error) });
            return;
          }
          if (watchSession !== this.watchSession || this.snapshot.vault?.rootPath !== vault.rootPath) return;
          clearAttachmentResolutionReads();
        }
        this.publish({ attachmentChanges });
        const contentPaths = markdownContentChanges(attachmentChanges);
        const root = vault.rootPath.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
        if (contentPaths?.every(path => path.replace(/\\/g, "/").toLowerCase().startsWith(root.toLowerCase()))) {
          modifiedPaths = contentPaths.map(path => path.replace(/\\/g, "/").slice(root.length));
        }
      }
      void this.invalidate({ reason: "vault-watch", modifiedPaths });
    }, this.fileChanges.delay(Date.now()));
  }

  private startWatchFallback() {
    if (typeof window === "undefined" || this.fallbackInterval) return;
    const reconcile = async () => {
      // Focus and timer ticks request a read, not a content-change event.
      // Publishing an incomplete watch batch here manufactured a new media URL
      // on every reconciliation, disposing open viewers and resetting playback.
      const vault = this.snapshot.vault, session = this.watchSession;
      if (!vault) return;
      try { await invalidateKnowledgeAttachmentInventory(vault.id); }
      catch (error) {
        if (session === this.watchSession) this.publish({ status: "error", error: String(error) });
        return;
      }
      if (session !== this.watchSession) return;
      clearAttachmentResolutionReads();
      this.publish({ attachmentResolutionRevision: (this.snapshot.attachmentResolutionRevision || 0) + 1 });
      void this.invalidate({ reason: "vault-watch-fallback" });
    };
    this.fallbackFocusListener = reconcile;
    this.fallbackVisibilityListener = () => {
      if (!document.hidden) reconcile();
    };
    window.addEventListener("focus", this.fallbackFocusListener);
    document.addEventListener("visibilitychange", this.fallbackVisibilityListener);
    this.fallbackInterval = setInterval(reconcile, 30000);
  }

  private startCommittedObservation(vault: BridgeVaultMetadata, session: number) {
    const current = () => session === this.watchSession && this.snapshot.vault?.id === vault.id;
    let checkpoint: string | null = null;
    let checking = false;
    const check = async () => {
      if (!current() || document.hidden || checking) return;
      checking = true;
      try {
        const observed = await this.readCommittedCheckpoint(vault.id);
        if (!current() || observed === null || observed === checkpoint) return;
        // First read also reconciles: the initial index load may precede a commit
        // made before listener registration. Never baseline that race away.
        const refreshed = await this.invalidate({ reason: "knowledge-committed-fallback" });
        if (current() && refreshed.status === "ready") checkpoint = observed;
      } catch { /* Existing watcher/fallback remains responsible for file changes. */ }
      finally { checking = false; }
    };
    // No unchanged full-index refresh, directory walk, or snapshot publication.
    this.committedFallback = setInterval(check, 5000);
    void import("@tauri-apps/api/core").then(async ({ isTauri }) => {
      if (!current() || !isTauri()) return;
      const { listen } = await import("@tauri-apps/api/event");
      const dispose = await listen("luckyray:knowledge-committed", event => {
        if (!current()) return;
        const paths = knowledgeCommittedPaths(event.payload, vault.id);
        if (paths) void this.invalidate({ reason: "knowledge-committed", modifiedPaths: paths });
      });
      if (!current()) dispose(); else { this.committedDispose = dispose; void check(); }
    }).catch(() => { /* The existing visible fallback recovers failed listeners. */ });
  }

  private stopVaultWatch() {
    this.watchSession += 1;
    this.committedDispose?.();
    this.committedDispose = null;
    if (this.committedFallback) clearInterval(this.committedFallback);
    this.committedFallback = null;
    this.watchDispose?.();
    this.watchDispose = null;
    this.watchedRoot = null;
    if (this.watchDebounceTimer) clearTimeout(this.watchDebounceTimer);
    this.watchDebounceTimer = null;
    this.fileChanges.drain();
    this.snapshot = { ...this.snapshot, attachmentChanges: null };
    if (this.fallbackInterval) clearInterval(this.fallbackInterval);
    this.fallbackInterval = null;
    if (typeof window !== "undefined" && this.fallbackFocusListener) {
      window.removeEventListener("focus", this.fallbackFocusListener);
    }
    if (typeof document !== "undefined" && this.fallbackVisibilityListener) {
      document.removeEventListener("visibilitychange", this.fallbackVisibilityListener);
    }
    this.fallbackFocusListener = null;
    this.fallbackVisibilityListener = null;
  }

  private isRelevantVaultPath(path: string, rootPath: string) {
    const normalizedPath = path.replace(/\\/g, "/").replace(/^\/\/\?\//, "").toLocaleLowerCase();
    const normalizedRoot = rootPath.replace(/\\/g, "/").replace(/^\/\/\?\//, "").replace(/\/$/, "").toLocaleLowerCase();
    if (!normalizedPath.startsWith(`${normalizedRoot}/`) && normalizedPath !== normalizedRoot) return false;
    const relative = normalizedPath.slice(normalizedRoot.length).replace(/^\/+/, "");
    if (!relative || relative.split("/").includes(".luckyray")) return false;
    const leaf = relative.split("/").pop() || "";
    if (/\.(tmp|swp|swx|bak|crdownload|part)$/i.test(leaf)) return false;
    return true;
  }

  private publish(update: Partial<KnowledgeStoreSnapshot>) {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
}

export const knowledgeStore = new KnowledgeStore();
