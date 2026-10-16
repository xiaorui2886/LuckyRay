import type { BridgeNotesVaultMarkdownIndexDocument } from "../../core/bridge/bridgeTypes";
import { getLuckyRayBridge } from "../../core/bridge/luckyRayBridge";
import { materialStore } from "../../core/services/materialStore";
import { knowledgeStore } from "../../core/services/knowledgeStore";
import { readSavedSettings } from "../settings/useSettings";
import { DEFAULT_LOCALE, selectPluralKey, translate, type Locale, type MessageKey } from "../../core/i18n/index";

export type SearchScope = "knowledge" | "materials" | "canvas" | "collection-box";

export const DEFAULT_SEARCH_SCOPES: SearchScope[] = ["knowledge", "materials", "canvas"];
export const COLLECTION_NAV_SETTING_KEY = "general.showCollectionNav";

export function isCollectionBoxSearchEnabled(): boolean {
  return readSavedSettings()[COLLECTION_NAV_SETTING_KEY] === true;
}

export type SearchEntityKind = "db-note" | "real-vault-note" | "material-asset" | "canvas" | "collection-item";

export type EntityRef = {
  kind: SearchEntityKind;
  id: string;
  source: SearchScope;
  locator?: {
    vaultId?: string;
    relativePath?: string;
  };
};

export type SearchQuery = {
  text: string;
  scopes: SearchScope[];
  limit?: number;
  locale?: Locale;
};

export type SearchResult = {
  ref: EntityRef;
  title: string;
  excerpt?: string;
  secondary?: string;
  score?: number;
  updatedAt?: string;
};

export type SearchResultGroup = {
  scope: SearchScope;
  label: string;
  results: SearchResult[];
  error?: string;
};

export type SearchResponse = {
  requestId: number;
  groups: SearchResultGroup[];
  stale: boolean;
};

export type SearchProviderAvailability = {
  available: boolean;
  reason?: string;
  version?: string | number;
};

export type SearchProvider = {
  id: SearchScope;
  label: string;
  defaultEnabled: boolean;
  availability: () => Promise<SearchProviderAvailability>;
  search: (query: SearchQuery, signal: AbortSignal) => Promise<SearchResult[]>;
};

type CacheEntry = {
  expiresAt: number;
  results: SearchResult[];
};

const SEARCH_CACHE_TTL_MS = 5_000;

function normalizedText(value: string | null | undefined): string {
  return (value || "").replace(/\s+/g, " ").trim();
}

function plainText(value: string | null | undefined): string {
  return normalizedText(value).replace(/<\/?b>/g, "");
}

function includesQuery(value: string | null | undefined, query: string): boolean {
  return plainText(value).toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

function firstExcerpt(value: string | null | undefined, query: string, radius = 72): string {
  const content = plainText(value);
  if (!content) return "";
  const index = content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return content.slice(0, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(content.length, index + query.length + radius);
  return `${start > 0 ? "..." : ""}${content.slice(start, end)}${end < content.length ? "..." : ""}`;
}

function searchText(locale: Locale | undefined, key: MessageKey, params?: Record<string, string | number>): string {
  return translate(locale || DEFAULT_LOCALE, key, params);
}

function searchPluralText(
  locale: Locale | undefined,
  count: number,
  forms: { one: MessageKey; other: MessageKey },
): string {
  const resolvedLocale = locale || DEFAULT_LOCALE;
  return searchText(resolvedLocale, selectPluralKey(resolvedLocale, count, forms), { count });
}

function formatUpdatedAt(value: string | null | undefined, locale: Locale): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "numeric", day: "numeric" }).format(date);
}

function searchRealVaultDocument(document: BridgeNotesVaultMarkdownIndexDocument, query: string, locale: Locale): SearchResult | null {
  const matches = [document.title, document.fileName, document.relativePath, document.plainText, document.excerpt]
    .some((value) => includesQuery(value, query));
  if (!matches) return null;
  const excerpt = firstExcerpt(document.plainText || document.excerpt, query) || plainText(document.excerpt);
  return {
    ref: {
      kind: "real-vault-note",
      id: `real-vault:${document.relativePath}`,
      source: "knowledge",
      locator: { relativePath: document.relativePath },
    },
    title: document.title || document.fileName || document.relativePath,
    excerpt,
    secondary: document.relativePath
      ? `${searchText(locale, "search.secondary.realVault")} · ${document.relativePath}`
      : searchText(locale, "search.secondary.realVault"),
    updatedAt: document.mtime || undefined,
  };
}

const knowledgeProvider: SearchProvider = {
  id: "knowledge",
  label: "knowledge",
  defaultEnabled: true,
  availability: async () => {
    const bridge = await getLuckyRayBridge();
    return {
      available: Boolean(bridge.searchNotesForGlobal || bridge.search),
    };
  },
  search: async (query, signal) => {
    const bridge = await getLuckyRayBridge();
    const limit = query.limit ?? 30;
    const snapshot = await knowledgeStore.ensureSnapshot({ reason: "global-search" });
    if (signal.aborted) return [];

    if (snapshot.mode === "real-vault") {
      const index = snapshot.markdownIndex;
      if (!index) return [];
      return (index.documents || [])
        .map((document) => searchRealVaultDocument(document, query.text, query.locale || DEFAULT_LOCALE))
        .filter((result): result is SearchResult => Boolean(result))
        .slice(0, limit);
    }

    const dbNotes = await (bridge.searchNotesForGlobal
      ? bridge.searchNotesForGlobal(query.text, { limit })
      : bridge.search(query.text, { limit }).then((result) => result.notes || []));
    if (signal.aborted) return [];
    return dbNotes.map((note) => ({
      ref: { kind: "db-note", id: note.id, source: "knowledge" },
      title: note.title || searchText(query.locale, "search.fallback.untitledNote"),
      excerpt: plainText(note.snippet),
      secondary: searchText(query.locale, "search.secondary.localNote"),
      updatedAt: note.updatedAt || undefined,
    }));
  },
};

const materialsProvider: SearchProvider = {
  id: "materials",
  label: "materials",
  defaultEnabled: true,
  availability: async () => ({ available: true, version: materialStore.getSnapshot().sourceVersion ?? undefined }),
  search: async (query, signal) => {
    const snapshot = await materialStore.ensureSnapshot({ reason: "global-search" });
    if (signal.aborted) return [];
    const limit = query.limit ?? 30;
    const results = snapshot.allAssets
      .filter((asset) => [asset.name, asset.description, asset.originalPath, asset.libraryPath]
        .some((value) => includesQuery(value, query.text)))
      .map<SearchResult>((asset) => ({
        ref: { kind: "material-asset", id: asset.id, source: "materials" },
        title: asset.name || searchText(query.locale, "search.fallback.untitledMaterial"),
        excerpt: firstExcerpt(`${asset.description || ""} ${asset.originalPath || asset.libraryPath || ""}`, query.text),
        secondary: asset.kind || searchText(query.locale, "search.secondary.material"),
        updatedAt: asset.updatedAt || undefined,
      }))
      .slice(0, limit);
    return results;
  },
};

const canvasProvider: SearchProvider = {
  id: "canvas",
  label: "canvas",
  defaultEnabled: true,
  availability: async () => {
    const bridge = await getLuckyRayBridge();
    return { available: Boolean(bridge.listCanvases) };
  },
  search: async (query, signal) => {
    const bridge = await getLuckyRayBridge();
    if (!bridge.listCanvases) return [];
    const canvases = await bridge.listCanvases();
    if (signal.aborted) return [];
    const limit = query.limit ?? 30;
    return (Array.isArray(canvases) ? canvases : [])
      .filter((canvas) => includesQuery(canvas.name, query.text))
      .slice(0, limit)
      .map<SearchResult>((canvas) => ({
        ref: { kind: "canvas", id: canvas.id, source: "canvas" },
        title: canvas.name || searchText(query.locale, "search.fallback.untitledCanvas"),
        excerpt: [
          searchPluralText(query.locale, canvas.nodeCount || 0, {
            one: "search.secondary.canvasNodes.one",
            other: "search.secondary.canvasNodes.other",
          }),
          searchPluralText(query.locale, canvas.edgeCount || 0, {
            one: "search.secondary.canvasEdges.one",
            other: "search.secondary.canvasEdges.other",
          }),
        ].join(" · "),
        secondary: canvas.updatedAt
          ? searchText(query.locale, "search.secondary.updatedAt", {
            date: formatUpdatedAt(canvas.updatedAt, query.locale || DEFAULT_LOCALE),
          })
          : searchText(query.locale, "search.secondary.canvas"),
        updatedAt: canvas.updatedAt || undefined,
      }));
  },
};

const collectionBoxProvider: SearchProvider = {
  id: "collection-box",
  label: "collection-box",
  defaultEnabled: false,
  availability: async () => {
    if (!isCollectionBoxSearchEnabled()) {
      return { available: false };
    }
    const bridge = await getLuckyRayBridge();
    return { available: Boolean(bridge.searchCollectionBoxForGlobal || bridge.searchGlobal) };
  },
  search: async (query, signal) => {
    if (!isCollectionBoxSearchEnabled()) return [];
    const bridge = await getLuckyRayBridge();
    const limit = query.limit ?? 30;
    const rows = bridge.searchCollectionBoxForGlobal
      ? await bridge.searchCollectionBoxForGlobal(query.text, { limit })
      : (await bridge.searchGlobal(query.text)).collection;
    if (signal.aborted) return [];
    return rows.slice(0, limit).map<SearchResult>((item) => ({
      ref: { kind: "collection-item", id: item.id, source: "collection-box" },
      title: plainText(item.content) || item.url || searchText(query.locale, "search.fallback.untitledCollection"),
      excerpt: plainText(item.snippet) || firstExcerpt(item.content, query.text),
      secondary: item.source || item.type || searchText(query.locale, "search.secondary.collection"),
      updatedAt: item.updatedAt || undefined,
    }));
  },
};

export function createSearchProviderRegistry(): Map<SearchScope, SearchProvider> {
  return new Map<SearchScope, SearchProvider>([
    [knowledgeProvider.id, knowledgeProvider],
    [materialsProvider.id, materialsProvider],
    [canvasProvider.id, canvasProvider],
    [collectionBoxProvider.id, collectionBoxProvider],
  ]);
}

export function resolveSearchScopes(scope: SearchScope | "all"): SearchScope[] {
  return scope === "all" ? [...DEFAULT_SEARCH_SCOPES] : [scope];
}

export class SearchCoordinator {
  private readonly providers: Map<SearchScope, SearchProvider>;
  private readonly cache = new Map<string, CacheEntry>();
  private activeController: AbortController | null = null;
  private requestId = 0;
  private retainCount = 0;
  private releaseMaterialStore: (() => void) | null = null;
  private unsubscribeMaterialStore: (() => void) | null = null;
  private notesIndexListener: (() => void) | null = null;

  constructor(providers = createSearchProviderRegistry()) {
    this.providers = providers;
  }

  retain() {
    this.retainCount += 1;
    if (this.retainCount === 1) this.startInvalidationListeners();
    return () => {
      this.retainCount = Math.max(0, this.retainCount - 1);
      if (this.retainCount === 0) this.stopInvalidationListeners();
    };
  }

  cancel() {
    this.requestId += 1;
    this.activeController?.abort();
    this.activeController = null;
  }

  invalidate(scope?: SearchScope) {
    if (!scope) {
      this.cache.clear();
      return;
    }
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${scope}|`)) this.cache.delete(key);
    }
  }

  async search(query: SearchQuery): Promise<SearchResponse> {
    const text = normalizedText(query.text);
    const requestId = ++this.requestId;
    this.activeController?.abort();
    const controller = new AbortController();
    this.activeController = controller;
    const scopes = [...new Set(query.scopes)].filter((scope): scope is SearchScope => this.providers.has(scope));
    if (!text || !scopes.length) return { requestId, groups: [], stale: false };

    const groupLabel = (scope: SearchScope) => searchText(query.locale, scope === "collection-box"
      ? "search.scope.collection"
      : `search.scope.${scope}` as MessageKey);
    const groups = await Promise.all(scopes.map(async (scope): Promise<SearchResultGroup> => {
      const provider = this.providers.get(scope);
      if (!provider) return { scope, label: groupLabel(scope), results: [] };
      try {
        const availability = await provider.availability();
        if (!availability.available || controller.signal.aborted) {
          return { scope, label: groupLabel(scope), results: [], error: availability.reason };
        }
        return {
          scope,
          label: groupLabel(scope),
          results: await this.searchProvider(provider, { ...query, text, scopes }, controller.signal),
        };
      } catch (error) {
        if (controller.signal.aborted) return { scope, label: groupLabel(scope), results: [] };
        return {
          scope,
          label: groupLabel(scope),
          results: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }));
    return { requestId, groups, stale: requestId !== this.requestId || controller.signal.aborted };
  }

  private async searchProvider(provider: SearchProvider, query: SearchQuery, signal: AbortSignal): Promise<SearchResult[]> {
    const key = `${provider.id}|${query.locale || DEFAULT_LOCALE}|${query.text.toLocaleLowerCase()}|${query.limit ?? ""}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.results;
    const results = await provider.search(query, signal);
    if (!signal.aborted) {
      this.cache.set(key, { results, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS });
    }
    return results;
  }

  private startInvalidationListeners() {
    this.releaseMaterialStore = materialStore.retainChangeProtocol();
    let materialVersion = materialStore.getSnapshot().version;
    this.unsubscribeMaterialStore = materialStore.subscribe(() => {
      const snapshot = materialStore.getSnapshot();
      if (snapshot.version !== materialVersion) {
        materialVersion = snapshot.version;
        this.invalidate("materials");
      }
    });
    if (typeof window !== "undefined") {
      const onNotesIndexChanged = () => this.invalidate("knowledge");
      window.addEventListener("luckyray:notes-vault-index-changed", onNotesIndexChanged);
      this.notesIndexListener = () => window.removeEventListener("luckyray:notes-vault-index-changed", onNotesIndexChanged);
    }
  }

  private stopInvalidationListeners() {
    this.releaseMaterialStore?.();
    this.releaseMaterialStore = null;
    this.unsubscribeMaterialStore?.();
    this.unsubscribeMaterialStore = null;
    this.notesIndexListener?.();
    this.notesIndexListener = null;
  }
}

export const searchCoordinator = new SearchCoordinator();
