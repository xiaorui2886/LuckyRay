import {
  knowledgeTagIdentity,
  normalizeKnowledgeTagDisplayName,
} from "../../core/services/knowledge";
import { tagColorForName } from "../../core/services/tagPresentation";
import {
  listItemTagMap,
  listTags,
  type ItemTagMap,
  type ItemTagType,
  type TagRecord,
} from "../../core/services/tags";

export type FavoriteTagChip = {
  id: string;
  name: string;
  color: string | null;
};

type MaterialFavoriteTagDependencies = {
  listTags: () => Promise<TagRecord[]>;
  listItemTagMap: (itemType: ItemTagType, itemIds?: string[]) => Promise<ItemTagMap>;
};

const defaultMaterialFavoriteTagDependencies: MaterialFavoriteTagDependencies = {
  listTags,
  listItemTagMap: (itemType, itemIds) => listItemTagMap(itemType, itemIds, { batchOnly: true }),
};

export async function loadMaterialFavoriteTags(
  itemIds: string[],
  dependencies: MaterialFavoriteTagDependencies = defaultMaterialFavoriteTagDependencies,
): Promise<Record<string, FavoriteTagChip[]>> {
  const boundedIds = Array.from(new Set(itemIds.filter(Boolean)));
  if (!boundedIds.length) return {};
  const [catalog, itemTagMap] = await Promise.all([
    dependencies.listTags(),
    dependencies.listItemTagMap("asset", boundedIds),
  ]);
  const tagById = new Map(catalog.map((tag) => [tag.id, tag]));
  return Object.fromEntries(boundedIds.map((itemId) => [
    itemId,
    (itemTagMap[itemId] || []).flatMap((tagId) => {
      const tag = tagById.get(tagId);
      return tag ? [{ id: tag.id, name: tag.name, color: tag.color || null }] : [];
    }),
  ]));
}

export function projectKnowledgeFavoriteTags(vaultId: string, names: readonly string[]): FavoriteTagChip[] {
  if (!vaultId) return [];
  const seen = new Set<string>();
  return names.flatMap((rawName) => {
    const name = normalizeKnowledgeTagDisplayName(rawName);
    const key = name.toLocaleLowerCase();
    if (!name || seen.has(key)) return [];
    seen.add(key);
    try {
      return [{ id: knowledgeTagIdentity(vaultId, name), name, color: tagColorForName(name) }];
    } catch {
      return [];
    }
  });
}
