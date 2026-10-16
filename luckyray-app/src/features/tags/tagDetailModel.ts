import { listItemTagMap } from "../../core/services/tags";
import { knowledgeStore } from "../../core/services/knowledgeStore";
import { DEFAULT_LOCALE, translate } from "../../core/i18n/index";
import { knowledgeMutationSuccessStatus, type KnowledgeMutationResult } from "../../core/services/knowledge";
import { listFilteredMaterialAssets } from "../../core/services/materials";
import { removeKnowledgeTagFromDocument } from "./useTags";
import type { BridgeTag, RealVaultTagDocument } from "./useTags";

export type AssetItem = {
  id: string;
  name: string;
  kind: string;
  thumbnailUrl: string;
  previewUrl: string;
  description?: string;
  sizeBytes?: number | null;
  tagIds: string[];
};

export type DetailItem = { type: "asset"; data: AssetItem };

type TagDetailLoaderDependencies = {
  listAssetsForTag(tagId: string): Promise<Array<{
    id: string;
    name: string;
    kind: string;
    thumbnailUrl?: string | null;
    previewUrl?: string | null;
    description?: string | null;
    sizeBytes?: number | null;
  }>>;
  listTagMap(itemType: "asset", itemIds: string[]): Promise<Record<string, string[]>>;
};

type TagDetailBridgeCapability = {
  listAssetsFiltered?: unknown;
};

export type TagDetailLoadMode = "initial" | "background";

type TagDetailLoadContext = {
  tagId: string;
  mode: TagDetailLoadMode;
};

export function getTagDetailLoadMode(previousTagId: string | null, nextTagId: string): TagDetailLoadMode {
  return previousTagId === nextTagId ? "background" : "initial";
}

export function getTagDetailLoadKey(tag: BridgeTag | null): string | null {
  if (!tag || tag.source === "real-vault") return null;
  return [
    tag.id,
    tag.source || "catalog",
    tag.catalogRevision || tag.updatedAt || "",
    tag.assetCount || 0,
  ].join("\0");
}

export function createLatestTagDetailLoader<T>({
  load,
  onStart,
  onResult,
  onError,
  onSettled,
}: {
  load(tagId: string): Promise<T>;
  onStart(context: TagDetailLoadContext): void;
  onResult(result: T, context: TagDetailLoadContext): void;
  onError(error: unknown, context: TagDetailLoadContext): void;
  onSettled(context: TagDetailLoadContext): void;
}) {
  let revision = 0;
  return Object.freeze({
    async run(tagId: string, input: { mode?: TagDetailLoadMode } = {}) {
      const current = ++revision;
      const context: TagDetailLoadContext = { tagId, mode: input.mode || "initial" };
      onStart(context);
      try {
        const result = await load(tagId);
        if (current !== revision) return false;
        onResult(result, context);
        return true;
      } catch (error) {
        if (current !== revision) return false;
        onError(error, context);
        return false;
      } finally {
        if (current === revision) onSettled(context);
      }
    },
    invalidate() {
      revision += 1;
    },
  });
}

export async function loadTagDetailItemsForSource(
  tagId: string,
  dependencies: TagDetailLoaderDependencies,
): Promise<DetailItem[]> {
  const taggedAssets = await dependencies.listAssetsForTag(tagId);
  if (taggedAssets.length === 0) return [];
  const assetTagMap = await dependencies.listTagMap("asset", taggedAssets.map((asset) => asset.id));
  const result: DetailItem[] = [];
  for (const asset of taggedAssets) {
    const tagIds = assetTagMap[asset.id] || [];
    if (!tagIds.includes(tagId)) continue;
    result.push({ type: "asset", data: {
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      thumbnailUrl: asset.thumbnailUrl || "",
      previewUrl: asset.previewUrl || "",
      description: asset.description || "",
      sizeBytes: asset.sizeBytes ?? null,
      tagIds,
    } });
  }
  return result;
}

export async function loadTagDetailItemsFromActiveBridge(
  tagId: string,
  bridge: TagDetailBridgeCapability | null,
  dependencies: TagDetailLoaderDependencies = {
    listAssetsForTag: (activeTagId) => listFilteredMaterialAssets({ tagIds: [activeTagId] }),
    listTagMap: listItemTagMap,
  },
): Promise<DetailItem[]> {
  if (!bridge) return [];
  if (typeof bridge.listAssetsFiltered !== "function") {
    throw Object.assign(new Error("tag-detail-asset-query-unavailable"), {
      code: "tag-detail-asset-query-unavailable",
    });
  }
  return loadTagDetailItemsForSource(tagId, dependencies);
}

export async function removeAssetTagRelationsAndRefresh(
  tagId: string,
  targets: Array<{ id: string; tagIds: string[] }>,
  dependencies: {
    setTags(assetId: string, tagIds: string[]): Promise<unknown>;
    refresh(): void | Promise<void>;
  },
) {
  await Promise.all(targets.map((target) => (
    dependencies.setTags(target.id, target.tagIds.filter((candidate) => candidate !== tagId))
  )));
  await dependencies.refresh();
}

type TagDetailKnowledgeMutationDependencies = {
  write(document: RealVaultTagDocument, tagName: string): Promise<KnowledgeMutationResult>;
  refresh(): Promise<unknown>;
};

const tagDetailKnowledgeMutationDependencies: TagDetailKnowledgeMutationDependencies = {
  write: removeKnowledgeTagFromDocument,
  refresh: () => knowledgeStore.revalidate({ reason: "tag-detail-remove-real-vault", force: true }),
};

export async function removeKnowledgeTagDocumentForStatus(
  document: RealVaultTagDocument,
  tagName: string,
  dependencies: TagDetailKnowledgeMutationDependencies = tagDetailKnowledgeMutationDependencies,
  successMessage = translate(DEFAULT_LOCALE, "tags.status.removedKnowledge"),
) {
  const mutation = await dependencies.write(document, tagName);
  if (!mutation.indexWarning && !mutation.indexStale) await dependencies.refresh();
  return {
    mutation,
    status: knowledgeMutationSuccessStatus(mutation, successMessage),
  };
}
