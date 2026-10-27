import {
  MATERIAL_CHANGE_EVENT,
  MATERIAL_CHANGE_LOCAL_EVENT,
  isMaterialChange,
  type MaterialChange,
} from "./materialChangeProtocol";
import {
  getMaterialAssetsByIds,
  getMaterialCatalogChange,
  listFilteredMaterialAssets,
  listMaterialAssets,
  listMaterialFolders,
} from "./materials";
import type { MaterialAsset, MaterialAssetFilter } from "./materials";
import { materialLibrarySession } from "./materialLibraryContext";

export type MaterialStoreFolder = {
  id: string;
  name: string;
  parentId: string | null;
  open: boolean;
  children: MaterialStoreFolder[];
};

export type MaterialStoreQuery = {
  key: string;
  filters?: MaterialAssetFilter;
  libraryId?: string | null;
  libraryGeneration?: number;
};

export type MaterialStoreStatus = "idle" | "loading" | "refreshing" | "ready" | "error";

export type MaterialStoreInvalidation = {
  reason: string;
  background?: boolean;
  affectedIds?: string[];
  foldersChanged?: boolean;
  sourceVersion?: number;
  query?: MaterialStoreQuery;
};

export type MaterialStoreSnapshot = {
  assets: MaterialAsset[];
  allAssets: MaterialAsset[];
  recentOrder: string[];
  folders: MaterialStoreFolder[];
  loaded: boolean;
  status: MaterialStoreStatus;
  error: string | null;
  queryKey: string;
  version: number;
  sourceVersion: number | null;
  updatedAt: number | null;
  lastReason: string | null;
  lastInvalidation: MaterialStoreInvalidation | null;
  lastChange: MaterialChange | null;
};

type StoreListener = () => void;
type ActiveRequest = {
  sequence: number;
  query: MaterialStoreQuery;
  controller: AbortController;
  sourceVersion: number | null;
  promise: Promise<MaterialStoreSnapshot>;
  libraryContext: ReturnType<typeof materialLibrarySession.capture>;
};

type BridgeReadiness = {
  generation: number;
  bridgeInstalled: boolean;
  databaseReady: boolean;
};

const DEFAULT_QUERY: MaterialStoreQuery = { key: "all" };
const MATERIAL_INVALIDATION_BATCH_MS = 48;

function normalizeQuery(query?: MaterialStoreQuery, context = materialLibrarySession.capture()): MaterialStoreQuery {
  return {
    key: query?.key || DEFAULT_QUERY.key,
    filters: query?.filters,
    libraryId: query?.libraryId ?? context.libraryId,
    libraryGeneration: query?.libraryGeneration ?? context.generation,
  };
}

function asFolders(value: unknown): MaterialStoreFolder[] {
  return Array.isArray(value) ? value as MaterialStoreFolder[] : [];
}

function materialRecentTime(asset: MaterialAsset) {
  // "Recent" is reconstructed after every app start. Metadata mutations such
  // as Agent tags advance updatedAt for CAS/revision truth, but must not make an
  // existing asset look newly imported. importedAt is the durable chronology;
  // updatedAt is only a compatibility fallback for legacy rows.
  const value = Date.parse(asset.importedAt || asset.updatedAt || "");
  return Number.isFinite(value) ? value : 0;
}

export function reconcileMaterialRecentOrder(
  assets: readonly MaterialAsset[],
  previousOrder: readonly string[] = [],
  preservePreviousOrder = false,
) {
  const byId = new Map(assets.map((asset, index) => [asset.id, { asset, index }]));
  if (preservePreviousOrder && previousOrder.length > 0) {
    const retained = previousOrder.filter((id) => byId.has(id));
    const retainedIds = new Set(retained);
    const appended = assets
      .filter((asset) => !retainedIds.has(asset.id))
      .map((asset, index) => ({ asset, index }))
      .sort((left, right) => materialRecentTime(right.asset) - materialRecentTime(left.asset) || left.index - right.index)
      .map(({ asset }) => asset.id);
    return [...retained, ...appended];
  }
  return [...byId.values()]
    .sort((left, right) => materialRecentTime(right.asset) - materialRecentTime(left.asset) || left.index - right.index)
    .map(({ asset }) => asset.id);
}

function readBridgeReadiness(): BridgeReadiness | null {
  if (typeof window === "undefined") return null;
  const value = (window as Window & { __LUCKYRAY_BRIDGE_READINESS__?: BridgeReadiness }).__LUCKYRAY_BRIDGE_READINESS__;
  return value && Number.isInteger(value.generation) ? value : null;
}

async function readMaterialChange(): Promise<MaterialChange | null> {
  const change = await getMaterialCatalogChange();
  return isMaterialChange(change) ? change : null;
}

export type MaterialStoreReads = {
  list: typeof listMaterialAssets;
  filtered: typeof listFilteredMaterialAssets;
  folders: typeof listMaterialFolders;
  byIds: typeof getMaterialAssetsByIds;
  change: () => Promise<MaterialChange | null>;
};
const defaultReads: MaterialStoreReads = { list: listMaterialAssets, filtered: listFilteredMaterialAssets, folders: listMaterialFolders, byIds: getMaterialAssetsByIds, change: readMaterialChange };

export class MaterialStore {
  private readonly binding?: { libraryId: string; reads: MaterialStoreReads };
  private readonly reads: MaterialStoreReads;
  private context() { return this.binding ? {libraryId:this.binding.libraryId,generation:0} : materialLibrarySession.capture(); }
  private isContextCurrent(context: {libraryId:string|null;generation:number}) { const current=this.context();return current.libraryId===context.libraryId&&current.generation===context.generation; }
  constructor(binding?: { libraryId: string; reads: MaterialStoreReads }) {
    this.binding=binding;this.reads=binding?.reads??defaultReads;
    if(binding)return;
    let context = materialLibrarySession.capture();
    materialLibrarySession.subscribe(() => {
      const next = materialLibrarySession.capture();
      if (context.libraryId === next.libraryId && context.generation === next.generation) return;
      context = next;
      this.activeRequest?.controller.abort(); this.activeRequest = null; ++this.sequence;
      this.queuedInvalidation = null; this.observedSourceVersion = 0;
      this.currentQuery = normalizeQuery({ key: `library:${next.libraryId}:${next.generation}` });
      this.publish({ assets: [], allAssets: [], folders: [], recentOrder: [], loaded: false, status: "idle", error: null, sourceVersion: null, lastChange: null, queryKey: this.currentQuery.key });
    });
  }
  private snapshot: MaterialStoreSnapshot = {
    assets: [],
    allAssets: [],
    recentOrder: [],
    folders: [],
    loaded: false,
    status: "idle",
    error: null,
    queryKey: DEFAULT_QUERY.key,
    version: 0,
    sourceVersion: null,
    updatedAt: null,
    lastReason: null,
    lastInvalidation: null,
    lastChange: null,
  };
  private listeners = new Set<StoreListener>();
  private sequence = 0;
  private currentQuery: MaterialStoreQuery = DEFAULT_QUERY;
  private activeRequest: ActiveRequest | null = null;
  private queuedInvalidation: MaterialStoreInvalidation | null = null;
  private queuedInvalidationPromise: Promise<MaterialStoreSnapshot> | null = null;
  private observedSourceVersion = 0;
  private observedBridgeReadyGeneration = 0;
  private changeProtocolConsumers = 0;
  private localChangeListener: ((event: Event) => void) | null = null;
  private libraryChangeListener: ((event: Event) => void) | null = null;
  private bridgeReadyListener: (() => void) | null = null;
  private tauriChangeUnlisten: (() => void) | null = null;

  subscribe(listener: StoreListener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot() {
    return this.snapshot;
  }

  retainChangeProtocol() {
    this.changeProtocolConsumers += 1;
    if (this.changeProtocolConsumers === 1) this.startChangeProtocol();
    return () => {
      this.changeProtocolConsumers = Math.max(0, this.changeProtocolConsumers - 1);
      if (this.changeProtocolConsumers === 0) this.stopChangeProtocol();
    };
  }

  ensureSnapshot(input: { reason: string; query?: MaterialStoreQuery }) {
    const query = normalizeQuery(input.query || this.currentQuery,this.context());
    if (input.query) this.currentQuery = query;
    if (this.consumeBridgeReadyGeneration()) {
      return this.revalidate({ reason: `${input.reason}:database-ready`, query, force: true });
    }
    if (this.snapshot.loaded && (!input.query || this.snapshot.queryKey === query.key)) {
      void this.reconcileMaterialVersion("material-store-resume");
      return Promise.resolve(this.snapshot);
    }
    return this.revalidate({ reason: input.reason, query });
  }

  revalidate(input: { reason: string; query?: MaterialStoreQuery; force?: boolean; background?: boolean }) {
    const query = normalizeQuery(input.query || this.currentQuery,this.context());
    const context = this.context();
    if (query.libraryId !== context.libraryId || query.libraryGeneration !== context.generation) return Promise.resolve(this.snapshot);
    if (input.query) this.currentQuery = query;
    const active = this.activeRequest;
    if (active && active.query.key === query.key && !input.force) return active.promise;
    if (active) active.controller.abort();

    const sequence = ++this.sequence;
    const controller = new AbortController();
    this.publish({
      status: this.snapshot.loaded ? input.background ? "ready" : "refreshing" : "loading",
      error: null,
      queryKey: query.key,
      lastReason: input.reason,
    });

    const request: ActiveRequest = {
      sequence,
      query,
      controller,
      sourceVersion: null,
      promise: Promise.resolve(this.snapshot),
      libraryContext: this.context(),
    };
    const promise = (async () => {
      try {
        const [allAssets, filteredAssets, folders, change] = await Promise.all([
          query.filters?.scope === "note-attachments" ? this.reads.filtered({ scope: query.filters.scope, vaultId: query.filters.vaultId, includeUnreferenced: query.filters.includeUnreferenced }) : this.reads.list(),
          query.filters ? this.reads.filtered(query.filters) : Promise.resolve(null),
          this.reads.folders().then(asFolders),
          this.reads.change().catch(() => null),
        ]);
        if (!this.isCurrentRequest(request)) return this.snapshot;
        const previous = new Map(this.snapshot.allAssets.map(asset => [asset.id, asset]));
        const retainRows = (assets: MaterialAsset[]) => input.background ? assets.map(asset => {
          const old = previous.get(asset.id);
          return old && JSON.stringify(old) === JSON.stringify(asset) ? old : asset;
        }) : assets;
        const normalizedAssets = retainRows(Array.isArray(allAssets) ? allAssets : []);
        const sourceVersion = change?.version ?? this.snapshot.sourceVersion;
        if (typeof sourceVersion === "number") this.observedSourceVersion = Math.max(this.observedSourceVersion, sourceVersion);
        this.publish({
          assets: query.filters && Array.isArray(filteredAssets) ? retainRows(filteredAssets) : normalizedAssets,
          allAssets: normalizedAssets,
          recentOrder: reconcileMaterialRecentOrder(normalizedAssets),
          folders,
          loaded: true,
          status: "ready",
          error: null,
          queryKey: query.key,
          version: this.snapshot.version + 1,
          sourceVersion,
          updatedAt: Date.now(),
          lastReason: input.reason,
          lastChange: change || this.snapshot.lastChange,
        });
      } catch (error) {
        if (!this.isCurrentRequest(request) || controller.signal.aborted) return this.snapshot;
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
    request.promise = promise;
    this.activeRequest = request;
    return promise;
  }

  invalidate(input: MaterialStoreInvalidation) {
    if (input.query && (input.query.libraryId !== undefined && input.query.libraryId !== this.context().libraryId
      || input.query.libraryGeneration !== undefined && input.query.libraryGeneration !== this.context().generation)) return Promise.resolve(this.snapshot);
    this.queuedInvalidation = this.mergeInvalidation(this.queuedInvalidation, input);
    if (this.queuedInvalidationPromise) return this.queuedInvalidationPromise;

    this.queuedInvalidationPromise = new Promise<MaterialStoreSnapshot>((resolve) => {
      setTimeout(async () => {
        let result = this.snapshot;
        while (this.queuedInvalidation) {
          const invalidation = this.queuedInvalidation;
          this.queuedInvalidation = null;
          this.publish({ lastInvalidation: invalidation });
          result = this.isTargetedMetadataChange(invalidation)
            ? await this.reconcileAffectedAssets(invalidation)
            : await this.revalidate({
              reason: invalidation.reason,
              query: invalidation.query || this.currentQuery,
              force: true,
              background: invalidation.background,
            });
        }
        resolve(result);
      }, MATERIAL_INVALIDATION_BATCH_MS);
    }).finally(() => {
      this.queuedInvalidationPromise = null;
    });
    return this.queuedInvalidationPromise;
  }

  optimistic(input: {
    reason: string;
    affectedIds?: string[];
    update: (snapshot: MaterialStoreSnapshot) => Pick<MaterialStoreSnapshot, "assets" | "allAssets" | "folders">;
  }) {
    if (this.activeRequest) {
      this.activeRequest.controller.abort();
      this.activeRequest = null;
    }
    const next = input.update(this.snapshot);
    this.publish({
      ...next,
      loaded: true,
      status: "ready",
      error: null,
      version: this.snapshot.version + 1,
      updatedAt: Date.now(),
      lastReason: input.reason,
      lastInvalidation: {
        reason: input.reason,
        affectedIds: input.affectedIds,
      },
    });
    return this.snapshot;
  }

  private mergeInvalidation(current: MaterialStoreInvalidation | null, next: MaterialStoreInvalidation): MaterialStoreInvalidation {
    if (!current) return {
      ...next,
      affectedIds: next.affectedIds ? [...new Set(next.affectedIds)] : undefined,
    };
    return {
      reason: `${current.reason},${next.reason}`,
      background: current.background === true && next.background === true,
      affectedIds: [...new Set([...(current.affectedIds || []), ...(next.affectedIds || [])])],
      foldersChanged: Boolean(current.foldersChanged || next.foldersChanged),
      sourceVersion: Math.max(current.sourceVersion || 0, next.sourceVersion || 0) || undefined,
      query: next.query || current.query,
    };
  }

  private isCurrentRequest(request: ActiveRequest) {
    return this.activeRequest?.sequence === request.sequence && !request.controller.signal.aborted && this.isContextCurrent(request.libraryContext);
  }

  private isTargetedMetadataChange(invalidation: MaterialStoreInvalidation) {
    return (invalidation.query || this.currentQuery).filters?.scope !== "note-attachments"
      && invalidation.reason.endsWith("agent-material-tags")
      && !invalidation.foldersChanged
      && Boolean(invalidation.affectedIds?.length)
      && (invalidation.affectedIds?.length || 0) <= 64;
  }

  private async reconcileAffectedAssets(invalidation: MaterialStoreInvalidation) {
    const context = this.context();
    const sequence = ++this.sequence;
    if (this.activeRequest) {
      this.activeRequest.controller.abort();
      this.activeRequest = null;
    }
    const affectedIds = [...new Set(invalidation.affectedIds || [])];
    const affected = new Set(affectedIds);
    const query = normalizeQuery(invalidation.query || this.currentQuery,this.context());
    try {
      const [changedAssets, filteredAssets] = await Promise.all([
        this.reads.byIds(affectedIds),
        query.filters ? this.reads.filtered(query.filters) : Promise.resolve(null),
      ]);
      if (!this.isContextCurrent(context) || sequence !== this.sequence) return this.snapshot;
      const changed = new Map(changedAssets.map((asset) => [asset.id, asset]));
      const merge = (current: MaterialAsset[]) => {
        const merged = current
          .filter((asset) => !affected.has(asset.id) || changed.has(asset.id))
          .map((asset) => changed.get(asset.id) || asset);
        for (const asset of changedAssets) {
          if (!current.some((candidate) => candidate.id === asset.id)) merged.push(asset);
        }
        return merged;
      };
      const sourceVersion = typeof invalidation.sourceVersion === "number"
        ? Math.max(invalidation.sourceVersion, this.snapshot.sourceVersion || 0)
        : this.snapshot.sourceVersion;
      const allAssets = merge(this.snapshot.allAssets);
      this.publish({
        assets: query.filters && Array.isArray(filteredAssets) ? filteredAssets : merge(this.snapshot.assets),
        allAssets,
        recentOrder: reconcileMaterialRecentOrder(allAssets, this.snapshot.recentOrder, true),
        loaded: true,
        status: "ready",
        error: null,
        queryKey: query.key,
        version: this.snapshot.version + 1,
        sourceVersion,
        updatedAt: Date.now(),
        lastReason: invalidation.reason,
        lastInvalidation: invalidation,
      });
    } catch (error) {
      if (!this.isContextCurrent(context) || sequence !== this.sequence) return this.snapshot;
      this.publish({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        lastReason: invalidation.reason,
        lastInvalidation: invalidation,
      });
    }
    return this.snapshot;
  }

  private startChangeProtocol() {
    if (typeof window === "undefined" || this.localChangeListener) return;
    this.localChangeListener = (event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (isMaterialChange(detail)) this.receiveMaterialChange(detail);
    };
    window.addEventListener(MATERIAL_CHANGE_LOCAL_EVENT, this.localChangeListener);
    this.libraryChangeListener = event => {
      const detail = (event as CustomEvent<{ libraryId: string; source?: string; change?: MaterialChange; previousVersion?: number }>).detail;
      if (detail?.libraryId !== this.context().libraryId) return;
      if (detail.source === "auto-import") {
        // Reconcile authoritative metadata as well: a different writer may have
        // committed during this import. Do not advance a global version using
        // only this batch's IDs and accidentally hide concurrent changes.
        void this.invalidate({ reason: "library-auto-import", background: true });
      } else void this.reconcileMaterialVersion("library-mutation");
    };
    window.addEventListener("luckyray:material-library-change", this.libraryChangeListener);
    this.bridgeReadyListener = () => {
      const readiness = readBridgeReadiness();
      if (this.consumeBridgeReadyGeneration()) {
        void this.revalidate({
          reason: "material-store-database-ready",
          query: this.currentQuery,
          force: true,
        });
      } else if (!readiness) {
        // Browser preview and older bridge adapters have no persistent marker.
        void this.revalidate({
          reason: "material-store-bridge-ready",
          query: this.currentQuery,
        });
      }
    };
    window.addEventListener("luckyray:bridge-ready", this.bridgeReadyListener);
    if (this.consumeBridgeReadyGeneration()) {
      void this.revalidate({
        reason: "material-store-retain-database-ready",
        query: this.currentQuery,
        force: true,
      });
    }
    void this.reconcileMaterialVersion("material-store-start");
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen<MaterialChange>(MATERIAL_CHANGE_EVENT, (event) => {
        this.receiveMaterialChange(event.payload);
      }))
      .then((unlisten) => {
        if (this.changeProtocolConsumers > 0) this.tauriChangeUnlisten = unlisten;
        else unlisten();
      })
      .catch(() => {
        // Browser previews intentionally use the local compatibility event only.
      });
  }

  private stopChangeProtocol() {
    if (typeof window !== "undefined" && this.libraryChangeListener) window.removeEventListener("luckyray:material-library-change", this.libraryChangeListener);
    this.libraryChangeListener = null;
    if (typeof window !== "undefined" && this.localChangeListener) {
      window.removeEventListener(MATERIAL_CHANGE_LOCAL_EVENT, this.localChangeListener);
    }
    if (typeof window !== "undefined" && this.bridgeReadyListener) {
      window.removeEventListener("luckyray:bridge-ready", this.bridgeReadyListener);
    }
    this.localChangeListener = null;
    this.bridgeReadyListener = null;
    this.tauriChangeUnlisten?.();
    this.tauriChangeUnlisten = null;
  }

  private consumeBridgeReadyGeneration() {
    const readiness = readBridgeReadiness();
    if (!readiness?.bridgeInstalled || !readiness.databaseReady) return false;
    if (readiness.generation <= this.observedBridgeReadyGeneration) return false;
    this.observedBridgeReadyGeneration = readiness.generation;
    return true;
  }

  private async reconcileMaterialVersion(reason: string) {
    const context = this.context();
    const change = await this.reads.change().catch(() => null);
    if (!change || !this.isContextCurrent(context)) return this.snapshot;
    if (!this.snapshot.loaded) {
      this.observedSourceVersion = Math.max(this.observedSourceVersion, change.version);
      this.publish({ sourceVersion: change.version, lastChange: change });
      return this.snapshot;
    }
    if (change.version > (this.snapshot.sourceVersion || 0)) {
      this.receiveMaterialChange({ ...change, reason: `${reason}:${change.reason}` }, true);
    }
    return this.snapshot;
  }

  private receiveMaterialChange(change: MaterialChange, scoped = false) {
    if (!isMaterialChange(change)) return;
    if (this.context().libraryId && !scoped) { void this.reconcileMaterialVersion("library-event"); return; }
    const appliedSourceVersion = this.snapshot.sourceVersion || 0;
    if (change.version <= this.observedSourceVersion && change.version <= appliedSourceVersion) return;
    this.observedSourceVersion = Math.max(this.observedSourceVersion, change.version);
    this.publish({ lastChange: change });
    if (!this.snapshot.loaded) return;
    void this.invalidate({
      reason: `material-change:${change.reason}`,
      affectedIds: change.affectedIds,
      foldersChanged: change.foldersChanged,
      sourceVersion: change.version,
    });
  }

  private publish(update: Partial<MaterialStoreSnapshot>) {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
}

export const materialStore = new MaterialStore();
