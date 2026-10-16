import { materialLibrarySession } from "./materialLibraryContext";
import type { FavoriteItem, FavoriteItemCounts, FavoriteItemType, FavoriteRemoval } from "../bridge/bridgeTypes";
import { getLuckyRayBridge } from "../bridge/luckyRayBridge";

export type { FavoriteItem, FavoriteItemCounts, FavoriteItemType, FavoriteRemoval };

export const FAVORITE_CHANGE_EVENT = "luckyray:favorite-change";

export async function listFavoriteItems(itemType: FavoriteItemType, libraryId = materialLibrarySession.getSnapshot().libraryId): Promise<FavoriteItem[]> {
  return itemType === "material" && libraryId ? materialLibrarySession.request<FavoriteItem[]>({ op: "favorites" }, libraryId) : (await getLuckyRayBridge()).listFavoriteItems(itemType);
}

export async function getFavoriteItemCounts(): Promise<FavoriteItemCounts> {
  const libraryId = materialLibrarySession.getSnapshot().libraryId;
  return libraryId ? materialLibrarySession.request<FavoriteItemCounts>({ op: "favoriteCounts" }, libraryId) : (await getLuckyRayBridge()).getFavoriteItemCounts();
}

export async function addFavoriteItem(itemType: FavoriteItemType, itemId: string, libraryId = materialLibrarySession.getSnapshot().libraryId): Promise<FavoriteItem> {
  const item = await (itemType === "material" && libraryId ? materialLibrarySession.request<FavoriteItem>({ op: "favoriteAdd", id: itemId },libraryId) : getLuckyRayBridge().then(bridge => bridge.addFavoriteItem(itemType, itemId)));
  publishFavoriteChange(itemType, itemId, "added");
  return item;
}

export async function updateFavoriteItem(
  itemType: FavoriteItemType,
  itemId: string,
  theme: string,
  copy: string,
): Promise<FavoriteItem> {
  const item = await (itemType === "material" && materialLibrarySession.getSnapshot().libraryId ? materialLibrarySession.request<FavoriteItem>({ op: "favoriteNotes", id: itemId, theme, copy }) : getLuckyRayBridge().then(bridge => bridge.updateFavoriteItem(itemType, itemId, theme, copy)));
  publishFavoriteChange(itemType, itemId, "updated");
  return item;
}

export async function removeFavoriteItem(itemType: FavoriteItemType, itemId: string, libraryId = materialLibrarySession.getSnapshot().libraryId): Promise<FavoriteRemoval> {
  const result = await (itemType === "material" && libraryId ? materialLibrarySession.request<FavoriteRemoval>({ op: "favoriteRemove", id: itemId },libraryId) : getLuckyRayBridge().then(bridge => bridge.removeFavoriteItem(itemType, itemId)));
  if (result.removed) publishFavoriteChange(itemType, itemId, "removed");
  return result;
}

export function favoriteHasNotes(item: Pick<FavoriteItem, "theme" | "copy"> | null | undefined) {
  return Boolean(item?.theme.trim() || item?.copy.trim());
}

function publishFavoriteChange(itemType: FavoriteItemType, itemId: string, action: "added" | "updated" | "removed") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(FAVORITE_CHANGE_EVENT, { detail: { itemType, itemId, action } }));
}
