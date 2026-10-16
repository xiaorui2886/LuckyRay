// D124: 标签服务薄封装
// 只封装已存在的 bridge 能力，不新增任何 IPC

import { getLuckyRayBridgeSync } from "../bridge/luckyRayBridge";

export type TagRecord = {
  id: string;
  name: string;
  color?: string | null;
  icon?: string | null;
  isAuto?: boolean;
  usageCount?: number;
};

export type CreateTagInput = { name: string; color?: string | null };
export type ItemTagType = "asset" | "note";
export type ItemTagMap = Record<string, string[]>;
export type ListItemTagMapOptions = { batchOnly?: boolean };

function requireBridge() {
  const bridge = getLuckyRayBridgeSync();
  if (!bridge) throw new Error("LuckyRay bridge is not ready");
  return bridge;
}

export async function listTags(): Promise<TagRecord[]> {
  const bridge = requireBridge();
  if (!bridge.listTags) throw new Error("当前环境不支持读取标签");
  const list = await bridge.listTags();
  return Array.isArray(list) ? list : [];
}

export async function createTag(input: CreateTagInput): Promise<TagRecord> {
  const bridge = requireBridge();
  if (!bridge.createTag) throw new Error("当前环境不支持新建标签");
  return bridge.createTag(input);
}

export async function renameTag(id: string, name: string): Promise<TagRecord | null> {
  const bridge = requireBridge();
  if (!bridge.renameTag) throw new Error("当前环境不支持重命名标签");
  return bridge.renameTag(id, name);
}

export async function updateTag(id: string, patch: { name?: string; color?: string | null }): Promise<TagRecord | null> {
  const bridge = requireBridge();
  if (bridge.updateTag) return bridge.updateTag(id, patch);
  if (typeof patch.name === "string") return renameTag(id, patch.name);
  throw new Error("当前环境不支持更新标签");
}

export async function deleteTag(id: string): Promise<void> {
  const bridge = requireBridge();
  if (!bridge.deleteTag) throw new Error("当前环境不支持删除标签");
  await bridge.deleteTag(id);
}

export async function mergeTags(targetId: string, sourceIds: string[]): Promise<void> {
  const bridge = requireBridge();
  if (!bridge.mergeTags) throw new Error("当前环境不支持合并标签");
  await bridge.mergeTags(targetId, sourceIds);
}

export async function getAssetTags(assetId: string): Promise<string[]> {
  const bridge = requireBridge();
  if (!bridge.getAssetTags) return [];
  const tags = await bridge.getAssetTags(assetId);
  return Array.isArray(tags) ? tags : [];
}

export async function setAssetTags(assetId: string, tagIds: string[]): Promise<string[]> {
  const bridge = requireBridge();
  if (!bridge.setAssetTags) throw new Error("当前环境不支持设置素材标签");
  return bridge.setAssetTags(assetId, tagIds);
}

export async function getNoteTags(noteId: string): Promise<string[]> {
  const bridge = requireBridge();
  if (!bridge.getNoteTags) return [];
  const tags = await bridge.getNoteTags(noteId);
  return Array.isArray(tags) ? tags : [];
}

export async function setNoteTags(noteId: string, tagIds: string[]): Promise<string[]> {
  const bridge = requireBridge();
  if (!bridge.setNoteTags) throw new Error("当前环境不支持设置笔记标签");
  return bridge.setNoteTags(noteId, tagIds);
}

export async function listItemTagMap(
  itemType: ItemTagType,
  itemIds: string[] = [],
  options: ListItemTagMapOptions = {},
): Promise<ItemTagMap> {
  const bridge = requireBridge();
  if (bridge.listItemTagMap) {
    const map = await bridge.listItemTagMap(itemType, itemIds);
    return normalizeItemTagMap(map, itemIds);
  }
  if (options.batchOnly) return Object.fromEntries(itemIds.map((id) => [id, []]));
  const getter = itemType === "asset" ? bridge.getAssetTags : bridge.getNoteTags;
  if (!getter) return Object.fromEntries(itemIds.map((id) => [id, []]));
  const entries = await Promise.all(
    itemIds.map(async (id) => {
      try {
        const tagIds = await getter(id);
        return [id, Array.isArray(tagIds) ? tagIds : []] as const;
      } catch {
        return [id, []] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

function normalizeItemTagMap(map: unknown, itemIds: string[]): ItemTagMap {
  const source = map && typeof map === "object" ? map as Record<string, unknown> : {};
  const ids = itemIds.length ? itemIds : Object.keys(source);
  return Object.fromEntries(
    ids.map((id) => {
      const tagIds = source[id];
      return [id, Array.isArray(tagIds) ? tagIds.filter((tagId): tagId is string => typeof tagId === "string") : []];
    }),
  );
}
