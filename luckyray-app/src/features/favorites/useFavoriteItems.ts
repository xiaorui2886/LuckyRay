import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FAVORITE_CHANGE_EVENT,
  addFavoriteItem,
  favoriteHasNotes,
  listFavoriteItems,
  removeFavoriteItem,
  type FavoriteItem,
  type FavoriteItemType,
} from "../../core/services/favorites";
import { createFavoriteSourceListLoader } from "./favoriteShelfModel";
import { defineMessages, useMessages } from "../../core/i18n/index";

const COPY = defineMessages({
  "remove.confirm": {
    "zh-CN": "取消收藏“{label}”？\n\n收藏主题和备注会一并删除，原内容不会受到影响。",
    "en-US": "Remove “{label}” from Favorites?\n\nIts Favorite theme and note will be deleted; the original content stays untouched.",
  },
});

export function useFavoriteItems(itemType: FavoriteItemType, libraryId?:string|null) {
  const { t } = useMessages(COPY);
  const [items, setItems] = useState<FavoriteItem[]>([]);
  const itemTypeRef = useRef(itemType);
  itemTypeRef.current = itemType;
  const libraryRef=useRef(libraryId);libraryRef.current=libraryId;
  const loaderRef = useRef<ReturnType<typeof createFavoriteSourceListLoader<FavoriteItem>> | null>(null);
  if (!loaderRef.current) {
    loaderRef.current = createFavoriteSourceListLoader(
      () => listFavoriteItems(itemTypeRef.current,libraryRef.current),
      setItems,
    );
  }

  const refresh = useCallback(async (options: { invalidate?: boolean } = {}) => {
    return loaderRef.current!.refresh(options);
  }, []);

  useEffect(() => {
    loaderRef.current!.activate();
    void refresh({ invalidate: true }).catch(() => {});
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<{ itemType?: FavoriteItemType }>).detail;
      if (detail?.itemType !== itemType) return;
      void refresh({ invalidate: true }).catch(() => {});
    };
    window.addEventListener(FAVORITE_CHANGE_EVENT, onChange);
    return () => {
      loaderRef.current!.deactivate();
      window.removeEventListener(FAVORITE_CHANGE_EVENT, onChange);
    };
  }, [itemType, libraryId, refresh]);

  const byId = useMemo(() => new Map(items.map((item) => [item.itemId, item])), [items]);

  const toggle = useCallback(async (itemId: string, label: string, aliases: string[] = []) => {
    const existing = [itemId, ...aliases].map((candidate) => byId.get(candidate)).find(Boolean);
    if (!existing) {
      const added = await addFavoriteItem(itemType, itemId,libraryId);
      setItems((current) => current.some((item) => item.itemId === itemId) ? current : [added, ...current]);
      return { favorited: true };
    }
    if (favoriteHasNotes(existing) && !window.confirm(t("remove.confirm", { label }))) {
      return { favorited: true, cancelled: true };
    }
    await removeFavoriteItem(itemType, existing.itemId,libraryId);
    setItems((current) => current.filter((item) => item.itemId !== existing.itemId));
    return { favorited: false };
  }, [byId, itemType, libraryId, t]);

  return { items, byId, toggle, refresh };
}
