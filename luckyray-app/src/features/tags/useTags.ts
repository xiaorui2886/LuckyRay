import { useState, useEffect, useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { getLuckyRayBridgeSync, waitForLuckyRayBridge } from "../../core/bridge/luckyRayBridge";
import {
  knowledgeDocumentNoteId,
  knowledgeTagCanonicalKey,
  knowledgeTagIdentity,
  normalizeKnowledgeTagDisplayName,
  readKnowledgeIndexSnapshot,
  setActiveKnowledgeDocumentTags,
  type KnowledgeDocumentRef,
  type KnowledgeDocumentSummary,
  type KnowledgeIndexSnapshot,
  type KnowledgeMutationResult,
  type KnowledgeTagSummary,
} from "../../core/services/knowledge";
import { tagColorForName } from "../../core/services/tagPresentation";
import { knowledgeStore } from "../../core/services/knowledgeStore";
import { KNOWLEDGE_SOURCE_CHANGED_EVENT, readActiveKnowledgeSource } from "../../core/services/knowledgeSource";
import { DEFAULT_LOCALE, defineMessages, translate, useMessages } from "../../core/i18n/index";

const COPY = defineMessages({
  "untitledDocument": { "zh-CN": "未命名文档", "en-US": "Untitled document" },
  "error.bridge": { "zh-CN": "桥未就绪", "en-US": "Desktop bridge is not ready" },
  "error.tagsBridge": { "zh-CN": "标签桥未就绪", "en-US": "Tag bridge is not ready" },
});

export type TagSourceMode = "catalog" | "real-vault" | "mixed";

export type RealVaultTagDocument = {
  id: string;
  documentRef: KnowledgeDocumentRef;
  title: string;
  relativePath: string;
  excerpt: string;
  updatedAt: string | null;
  revision: string;
  tags: string[];
};

export type TagGalleryAssetPreview = {
  id: string;
  name: string;
  kind: string;
  thumbnailUrl: string;
};

export type BridgeTag = {
  id: string;
  name: string;
  color: string | null;
  assetCount: number;
  noteCount: number;
  realVaultDocumentCount?: number;
  createdAt: string;
  updatedAt: string;
  catalogRevision?: string;
  source?: TagSourceMode;
  documents?: RealVaultTagDocument[];
  realVaultDocuments?: RealVaultTagDocument[];
  realVaultAliases?: string[];
  galleryAssets?: TagGalleryAssetPreview[];
};

export type TagStats = {
  total: number;
  linked: number;
  top: number;
  weekNew: number;
};

export type TagSourceCounts = {
  total: number;
  assetCount: number;
  realVaultDocumentCount: number;
};

export type TagsData = {
  tags: BridgeTag[];
  stats: TagStats;
  hotTags: BridgeTag[];
  restTags: BridgeTag[];
  loading: boolean;
  error: string | null;
  sourceMode: TagSourceMode;
  refresh: () => Promise<void>;
};

export const TAG_GALLERY_PREVIEW_PER_TAG = 3;
export const TAG_GALLERY_PREVIEW_ASSET_LIMIT = 64;

export type TagGalleryPreviewPlan = {
  assetIds: string[];
  assetIdsByTag: Record<string, string[]>;
};

type TagGalleryPreviewBridge = {
  listItemTagMap?: (itemType: "asset", itemIds?: string[]) => Promise<Record<string, string[]>>;
  getAssetsByIds?: (assetIds: string[]) => Promise<Array<{
    id: string;
    name: string;
    kind: string;
    thumbnailUrl?: string | null;
  }>>;
};

export function buildTagGalleryPreviewPlan(
  tags: BridgeTag[],
  itemTagMap: Record<string, string[]>,
): TagGalleryPreviewPlan {
  const candidatesByTag = new Map(tags.map((tag) => [tag.id, [] as string[]]));
  for (const [assetId, rawTagIds] of Object.entries(itemTagMap)) {
    if (!assetId || !Array.isArray(rawTagIds)) continue;
    for (const tagId of rawTagIds) {
      const candidates = candidatesByTag.get(tagId);
      if (!candidates || candidates.length >= TAG_GALLERY_PREVIEW_PER_TAG) continue;
      candidates.push(assetId);
    }
  }

  const selected = new Set<string>();
  const assetIdsByTag: Record<string, string[]> = {};
  for (const tag of tags) {
    const retained: string[] = [];
    for (const assetId of candidatesByTag.get(tag.id) || []) {
      if (!selected.has(assetId) && selected.size >= TAG_GALLERY_PREVIEW_ASSET_LIMIT) continue;
      selected.add(assetId);
      retained.push(assetId);
    }
    assetIdsByTag[tag.id] = retained;
  }
  return { assetIds: Array.from(selected), assetIdsByTag };
}

export async function hydrateTagGalleryPreviews(
  tags: BridgeTag[],
  bridge: TagGalleryPreviewBridge,
  previousTags: BridgeTag[] = [],
): Promise<BridgeTag[]> {
  if (tags.length === 0
    || typeof bridge.listItemTagMap !== "function"
    || typeof bridge.getAssetsByIds !== "function") return tags;
  try {
    const itemTagMap = await bridge.listItemTagMap("asset");
    const plan = buildTagGalleryPreviewPlan(tags, itemTagMap);
    if (plan.assetIds.length === 0) return tags;
    const assets = await bridge.getAssetsByIds(plan.assetIds);
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    return tags.map((tag) => ({
      ...tag,
      galleryAssets: (plan.assetIdsByTag[tag.id] || []).flatMap((assetId) => {
        const asset = byId.get(assetId);
        return asset ? [{
          id: asset.id,
          name: asset.name,
          kind: asset.kind,
          thumbnailUrl: asset.thumbnailUrl || "",
        }] : [];
      }),
    }));
  } catch {
    const previousById = new Map(previousTags.map((tag) => [tag.id, tag.galleryAssets]));
    return tags.map((tag) => {
      const galleryAssets = previousById.get(tag.id);
      return galleryAssets ? { ...tag, galleryAssets } : tag;
    });
  }
}

function getBridge(): any {
  return getLuckyRayBridgeSync();
}

async function getBridgeForTags(): Promise<any> {
  return getBridge() || await waitForLuckyRayBridge(2000);
}

function normalizeTagName(value: unknown): string {
  return normalizeKnowledgeTagDisplayName(value);
}

function tagMergeKey(name: string): string {
  return knowledgeTagCanonicalKey(name);
}

function markdownTitleFromPath(relativePath: string, untitled = translate(DEFAULT_LOCALE, "search.fallback.untitledNote")): string {
  const fileName = relativePath.split(/[\\/]/).pop() || relativePath;
  return fileName.replace(/\.md$/i, "") || untitled;
}

export function getTagSourceCounts(tag: BridgeTag): TagSourceCounts {
  const assetCount = tag.assetCount || 0;
  const realVaultDocumentCount = tag.realVaultDocumentCount
    ?? tag.realVaultDocuments?.length
    ?? tag.documents?.length
    ?? 0;
  return {
    total: assetCount + realVaultDocumentCount,
    assetCount,
    realVaultDocumentCount,
  };
}

export function buildRealVaultTagsFromKnowledge(
  summaries: KnowledgeTagSummary[],
  documentsByTag: Map<string, KnowledgeDocumentSummary[]>,
  index: KnowledgeIndexSnapshot,
  untitledDocument = translate(DEFAULT_LOCALE, "search.fallback.untitledNote"),
): BridgeTag[] {
  const generatedAt = index.builtAt || new Date().toISOString();
  const indexedByRef = new Map(index.documents.map((document) => [
    `${document.documentRef.vaultId}\0${document.documentRef.relativePath}`,
    document,
  ]));
  const byName = new Map<string, BridgeTag>();
  for (const summary of summaries) {
    const name = normalizeTagName(summary.name);
    if (!name) continue;
    const documents = (documentsByTag.get(summary.name) || []).flatMap((document) => {
      const indexed = indexedByRef.get(`${document.documentRef.vaultId}\0${document.documentRef.relativePath}`);
      if (!indexed || indexed.documentRef.vaultId !== index.vaultId) return [];
      return [{
        id: knowledgeDocumentNoteId(indexed.documentRef),
        documentRef: indexed.documentRef,
        title: indexed.title || markdownTitleFromPath(indexed.relativePath, untitledDocument),
        relativePath: indexed.relativePath,
        excerpt: indexed.excerpt || "",
        updatedAt: indexed.modifiedAt,
        revision: indexed.revision,
        tags: indexed.frontmatterTags,
      } satisfies RealVaultTagDocument];
    });
    const updatedAt = documents.reduce((latest, document) => (
      document.updatedAt && (!latest || Date.parse(document.updatedAt) > Date.parse(latest))
        ? document.updatedAt
        : latest
    ), null as string | null) || generatedAt;
    const id = knowledgeTagIdentity(index.vaultId, name);
    byName.set(knowledgeTagCanonicalKey(name), {
      id,
      name,
      color: tagColorForName(name),
      assetCount: 0,
      noteCount: documents.length,
      realVaultDocumentCount: documents.length,
      createdAt: updatedAt,
      updatedAt,
      source: "real-vault",
      documents,
      realVaultDocuments: documents,
      realVaultAliases: [id],
    });
  }
  return Array.from(byName.values());
}

export function groupKnowledgeIndexTags(index: KnowledgeIndexSnapshot): {
  summaries: KnowledgeTagSummary[];
  documentsByTag: Map<string, KnowledgeDocumentSummary[]>;
} {
  const grouped = new Map<string, { name: string; documents: KnowledgeDocumentSummary[] }>();
  for (const document of index.documents) {
    const summary: KnowledgeDocumentSummary = {
      documentRef: document.documentRef,
      title: document.title,
      relativePath: document.relativePath,
      modifiedAt: document.modifiedAt,
      size: document.size,
    };
    const seen = new Set<string>();
    for (const rawTag of document.tags) {
      const name = normalizeTagName(rawTag);
      const key = tagMergeKey(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const group = grouped.get(key) || { name, documents: [] };
      group.documents.push(summary);
      grouped.set(key, group);
    }
  }

  const groups = Array.from(grouped.values()).sort((left, right) => (
    left.name.localeCompare(right.name, "zh", { sensitivity: "base" })
  ));
  const documentsByTag = new Map<string, KnowledgeDocumentSummary[]>();
  const summaries = groups.map((group) => {
    group.documents.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    documentsByTag.set(group.name, group.documents);
    return { name: group.name, documentCount: group.documents.length };
  });
  return { summaries, documentsByTag };
}

export function createCoalescedTagRefresh(
  run: (requested: TagRefreshKey) => Promise<TagRefreshKey | null>,
  readRevision: () => string,
): (input?: { explicit?: boolean }) => Promise<void> {
  const maxDrainRuns = 3;
  type ActiveRefresh = { promise: Promise<void> };
  let explicitEpoch = 0;
  let activeRefresh: ActiveRefresh | null = null;
  const currentKey = (): TagRefreshKey => ({ revision: readRevision(), explicitEpoch });
  const sameKey = (left: TagRefreshKey | null, right: TagRefreshKey) => Boolean(
    left && left.revision === right.revision && left.explicitEpoch === right.explicitEpoch
  );

  return (input = {}) => {
    if (input.explicit) explicitEpoch += 1;
    if (activeRefresh) return activeRefresh.promise;
    const request: ActiveRefresh = { promise: Promise.resolve() };
    request.promise = (async () => {
      for (let attempt = 0; attempt < maxDrainRuns; attempt += 1) {
        const completed = await run(currentKey());
        if (sameKey(completed, currentKey())) return;
      }
      throw new Error("tags-refresh-not-converged");
    })().finally(() => {
      if (activeRefresh === request) activeRefresh = null;
    });
    activeRefresh = request;
    return request.promise;
  };
}

type TagRefreshKey = {
  revision: string;
  explicitEpoch: number;
};

function readTagsRefreshRevision(): string {
  const source = readActiveKnowledgeSource();
  const snapshot = knowledgeStore.getSnapshot();
  return [
    source?.mode || "none",
    source?.mode === "real-vault" ? source.vaultId : "",
    snapshot.mode,
    snapshot.vault?.id || "",
    snapshot.markdownIndex?.version || 0,
    snapshot.loaded ? 1 : 0,
  ].join(":");
}

export async function removeKnowledgeTagFromDocument(
  document: RealVaultTagDocument,
  tagName: string,
  writer: (
    documentRef: KnowledgeDocumentRef,
    expectedRevision: string,
    tags: string[],
  ) => Promise<KnowledgeMutationResult> = setActiveKnowledgeDocumentTags,
) {
  const target = knowledgeTagCanonicalKey(tagName);
  const nextTags = document.tags.filter((tag) => knowledgeTagCanonicalKey(tag) !== target);
  return writer(document.documentRef, document.revision, nextTags);
}

export function mergeTagSources(catalogTags: BridgeTag[], realVaultTags: BridgeTag[]): BridgeTag[] {
  const byName = new Map<string, BridgeTag>();
  for (const tag of catalogTags) {
    const key = tagMergeKey(tag.name);
    if (!key) continue;
    byName.set(key, {
      ...tag,
      source: "catalog",
      catalogRevision: tag.catalogRevision || tag.updatedAt,
      noteCount: 0,
      realVaultDocumentCount: tag.realVaultDocumentCount ?? tag.realVaultDocuments?.length ?? tag.documents?.length ?? 0,
      documents: tag.documents || [],
      realVaultDocuments: tag.realVaultDocuments || [],
      realVaultAliases: tag.realVaultAliases || [],
    });
  }

  for (const realTag of realVaultTags) {
    const key = tagMergeKey(realTag.name);
    if (!key) continue;
    const realDocuments = realTag.realVaultDocuments || realTag.documents || [];
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, {
        ...realTag,
        source: "real-vault",
        realVaultDocumentCount: realDocuments.length,
        documents: realDocuments,
        realVaultDocuments: realDocuments,
        realVaultAliases: realTag.realVaultAliases || [realTag.id],
      });
      continue;
    }

    const documents = [...(existing.realVaultDocuments || existing.documents || []), ...realDocuments];
    const realVaultAliases = Array.from(new Set([
      ...(existing.realVaultAliases || []),
      ...(realTag.realVaultAliases || [realTag.id]),
    ]));
    byName.set(key, {
      ...existing,
      name: realTag.name,
      color: existing.color || realTag.color,
      noteCount: (existing.noteCount || 0) + realDocuments.length,
      realVaultDocumentCount: (existing.realVaultDocumentCount || existing.realVaultDocuments?.length || 0) + realDocuments.length,
      updatedAt: newerTimestamp(existing.updatedAt, realTag.updatedAt),
      source: "mixed",
      documents,
      realVaultDocuments: documents,
      realVaultAliases,
    });
  }

  return Array.from(byName.values());
}

function tagSemanticSignature(tag: BridgeTag): string {
  const documents = tag.realVaultDocuments || tag.documents || [];
  return JSON.stringify([
    tag.id,
    tag.name,
    tag.color,
    tag.assetCount || 0,
    tag.noteCount || 0,
    tag.realVaultDocumentCount ?? documents.length,
    tag.createdAt,
    tag.updatedAt,
    tag.catalogRevision || "",
    tag.source || "catalog",
    tag.realVaultAliases || [],
    (tag.galleryAssets || []).map((asset) => [asset.id, asset.name, asset.kind, asset.thumbnailUrl]),
    documents.map((document) => [
      document.id,
      document.documentRef.vaultId,
      document.documentRef.relativePath,
      document.title,
      document.relativePath,
      document.excerpt,
      document.updatedAt,
      document.revision,
      document.tags,
    ]),
  ]);
}

export function reuseSemanticallyEqualTags(current: BridgeTag[], next: BridgeTag[]): BridgeTag[] {
  if (current.length === 0) return next.length === 0 ? current : next;
  const currentById = new Map(current.map((tag) => [tag.id, tag]));
  let changed = current.length !== next.length;
  const resolved = next.map((candidate, index) => {
    const existing = currentById.get(candidate.id);
    if (existing && tagSemanticSignature(existing) === tagSemanticSignature(candidate)) {
      if (current[index] !== existing) changed = true;
      return existing;
    }
    changed = true;
    return candidate;
  });
  return changed ? resolved : current;
}

function newerTimestamp(left: string, right: string): string {
  const leftTime = left ? Date.parse(left) : 0;
  const rightTime = right ? Date.parse(right) : 0;
  return rightTime > leftTime ? right : left;
}

export function useTags(): TagsData {
  const { locale, t } = useMessages(COPY);
  const [catalogTags, setCatalogTags] = useState<BridgeTag[]>([]);
  const [realVaultTags, setRealVaultTags] = useState<BridgeTag[]>([]);
  const catalogTagsRef = useRef<BridgeTag[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const knowledgeSnapshot = useSyncExternalStore(
    (listener) => knowledgeStore.subscribe(listener),
    knowledgeStore.getSnapshot,
    knowledgeStore.getSnapshot,
  );
  const tags = useMemo(() => mergeTagSources(catalogTags, realVaultTags), [catalogTags, realVaultTags]);
  const sourceMode: TagSourceMode = catalogTags.length > 0 && realVaultTags.length > 0
    ? "mixed"
    : realVaultTags.length > 0 ? "real-vault" : "catalog";

  const performRefresh = useCallback(async (requested: TagRefreshKey): Promise<TagRefreshKey | null> => {
    const requestedStillCurrent = () => readTagsRefreshRevision() === requested.revision;
    if (!requestedStillCurrent()) return null;
    const bridge = await getBridgeForTags();
    if (!bridge) {
      if (!requestedStillCurrent()) return null;
      setError(t("error.bridge"));
      return requested;
    }
    setLoading(true);
    setError(null);
    try {
      let knowledge = await knowledgeStore.ensureSnapshot({ reason: "tags-page" });
      const source = readActiveKnowledgeSource();
      if (source?.mode === "real-vault"
        && (knowledge.mode !== "real-vault" || knowledge.vault?.id !== source.vaultId)) {
        knowledge = await knowledgeStore.revalidate({ reason: "tags-source-sync", force: true });
      }
      if (!requestedStillCurrent()) return null;
      if (source?.mode === "real-vault"
        && (knowledge.mode !== "real-vault" || knowledge.vault?.id !== source.vaultId)) {
        throw new Error("knowledge-vault-not-current");
      }
      const isRealVault = knowledge.mode === "real-vault"
        && Boolean(knowledge.vault?.id)
        && source?.mode === "real-vault"
        && source.vaultId === knowledge.vault?.id;
      let nextCatalogTags: BridgeTag[] = [];
      if (typeof bridge.listTags === "function") {
        const result = await bridge.listTags();
        nextCatalogTags = Array.isArray(result) ? result.map((tag) => ({
          ...tag,
          noteCount: 0,
          catalogRevision: tag.catalogRevision || tag.updatedAt,
          source: "catalog" as const,
        })) : [];
        nextCatalogTags = await hydrateTagGalleryPreviews(nextCatalogTags, bridge, catalogTagsRef.current);
      }
      if (nextCatalogTags.length === 0 && typeof bridge.listTags !== "function") {
        if (!requestedStillCurrent()) return null;
        setError(t("error.tagsBridge"));
        setCatalogTags((current) => reuseSemanticallyEqualTags(current, []));
        return requested;
      }

      let nextRealVaultTags: BridgeTag[] = [];
      if (isRealVault) {
        const index = await readKnowledgeIndexSnapshot();
        if (index.vaultId !== source.vaultId) throw new Error("knowledge-vault-not-current");
        const { summaries, documentsByTag } = groupKnowledgeIndexTags(index);
        const activeAfterQuery = readActiveKnowledgeSource();
        if (activeAfterQuery?.mode !== "real-vault" || activeAfterQuery.vaultId !== index.vaultId) return null;
        const currentKnowledge = knowledgeStore.getSnapshot();
        if (currentKnowledge.mode !== "real-vault"
          || currentKnowledge.vault?.id !== index.vaultId
          || currentKnowledge.markdownIndex?.version !== index.version) return null;
        nextRealVaultTags = buildRealVaultTagsFromKnowledge(summaries, documentsByTag, index, t("untitledDocument"));
      }

      if (!requestedStillCurrent()) return null;
      setCatalogTags((current) => {
        const resolved = reuseSemanticallyEqualTags(current, nextCatalogTags);
        catalogTagsRef.current = resolved;
        return resolved;
      });
      setRealVaultTags((current) => reuseSemanticallyEqualTags(current, nextRealVaultTags));
      return requested;
    } catch (e) {
      if (!requestedStillCurrent()) return null;
      setError(e instanceof Error ? e.message : String(e));
      return requested;
    } finally {
      setLoading(false);
    }
  }, [t]);
  const requestRefresh = useMemo(
    () => createCoalescedTagRefresh(performRefresh, readTagsRefreshRevision),
    [performRefresh],
  );
  const refresh = useCallback(() => requestRefresh({ explicit: true }), [requestRefresh]);

  useEffect(() => {
    void requestRefresh();
  }, [requestRefresh]);

  useEffect(() => {
    if (!knowledgeSnapshot.loaded) return;
    void requestRefresh();
  }, [knowledgeSnapshot.mode, knowledgeSnapshot.version, requestRefresh]);

  useEffect(() => {
    const refreshWhenReady = () => void requestRefresh();
    window.addEventListener("luckyray:bridge-ready", refreshWhenReady);
    window.addEventListener(KNOWLEDGE_SOURCE_CHANGED_EVENT, refreshWhenReady);
    return () => {
      window.removeEventListener("luckyray:bridge-ready", refreshWhenReady);
      window.removeEventListener(KNOWLEDGE_SOURCE_CHANGED_EVENT, refreshWhenReady);
    };
  }, [requestRefresh]);

  const stats = useMemo<TagStats>(() => {
    const total = tags.length;
    const linked = tags.reduce((s, t) => s + (t.assetCount || 0) + (t.noteCount || 0), 0);
    const top = tags.reduce((m, t) => Math.max(m, (t.assetCount || 0) + (t.noteCount || 0)), 0);
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const weekNew = tags.filter((t) => {
      const ts = t.createdAt ? Date.parse(t.createdAt) : 0;
      return ts >= sevenDaysAgo;
    }).length;
    return { total, linked, top, weekNew };
  }, [tags]);

  const sorted = useMemo(() => {
    return [...tags].sort((a, b) => {
      const ca = (a.assetCount || 0) + (a.noteCount || 0);
      const cb = (b.assetCount || 0) + (b.noteCount || 0);
      if (cb !== ca) return cb - ca;
      return (a.name || "").localeCompare(b.name || "", locale);
    });
  }, [locale, tags]);

  const hotTags = useMemo(
    () => sorted.filter((t) => ((t.assetCount || 0) + (t.noteCount || 0)) > 0).slice(0, 6),
    [sorted]
  );

  const restTags = useMemo(
    () => sorted.filter((t) => !hotTags.includes(t)),
    [sorted, hotTags]
  );

  return { tags, stats, hotTags, restTags, loading, error, sourceMode, refresh };
}
