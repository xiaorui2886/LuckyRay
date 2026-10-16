import type { FavoriteItem, FavoriteItemType } from "../../core/services/favorites";
import type { FavoriteTagChip } from "./favoriteTagProjection";

export type FavoriteSort = "favorited" | "modified" | "name";

export type FavoriteShelfEntry = {
  favorite: FavoriteItem;
  sourceId: string | null;
  sourceConfirmation: "legacy-current-vault" | null;
  missing: boolean;
  name: string;
  summary: string;
  sourceUpdatedAt: string | null;
  previewKind: "image" | "video" | "audio" | "document" | "canvas" | "other";
  previewUrl: string | null;
  previewPoster: string | null;
  materialKind?: string | null;
  tags: FavoriteTagChip[];
};

export type FavoriteShelfViewState = {
  query: string;
  sort: FavoriteSort;
  scrollTop: number;
};

export const FAVORITE_TYPES: readonly FavoriteItemType[] = ["material", "note", "canvas"];

export function defaultFavoriteViewState(): Record<FavoriteItemType, FavoriteShelfViewState> {
  return {
    material: { query: "", sort: "favorited", scrollTop: 0 },
    note: { query: "", sort: "favorited", scrollTop: 0 },
    canvas: { query: "", sort: "favorited", scrollTop: 0 },
  };
}

export function filterAndSortFavorites(
  entries: readonly FavoriteShelfEntry[],
  state: Pick<FavoriteShelfViewState, "query" | "sort">,
) {
  const query = state.query.trim().toLocaleLowerCase();
  return entries
    .filter((entry) => !query || [entry.name, entry.summary, entry.favorite.theme, entry.favorite.copy]
      .some((value) => value.toLocaleLowerCase().includes(query)))
    .slice()
    .sort((left, right) => {
      if (state.sort === "name") return left.name.localeCompare(right.name, "zh-CN", { numeric: true });
      if (state.sort === "modified") {
        const leftTime = latestTime(left.sourceUpdatedAt, left.favorite.noteUpdatedAt);
        const rightTime = latestTime(right.sourceUpdatedAt, right.favorite.noteUpdatedAt);
        return rightTime - leftTime || left.name.localeCompare(right.name, "zh-CN", { numeric: true });
      }
      return Date.parse(right.favorite.favoritedAt) - Date.parse(left.favorite.favoritedAt)
        || left.name.localeCompare(right.name, "zh-CN", { numeric: true });
    });
}

export function selectFavoriteSourcesById<T extends { id: string }>(
  favorites: readonly FavoriteItem[],
  sources: readonly T[],
) {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  return favorites.map((favorite) => ({ favorite, source: sourceById.get(favorite.itemId) || null }));
}

export function createFavoriteSourceListLoader<T>(
  load: () => Promise<T[]>,
  publish: (items: T[]) => void,
) {
  let generation = 0;
  let request: { dirty: boolean; generation: number; promise: Promise<T[]> } | null = null;

  return {
    activate() {
      generation += 1;
    },
    deactivate() {
      generation += 1;
    },
    refresh(options: { invalidate?: boolean } = {}) {
      if (request) {
        if (options.invalidate) request.dirty = true;
        request.generation = generation;
        return request.promise;
      }
      const current = {
        dirty: false,
        generation,
        promise: Promise.resolve([] as T[]),
      };
      current.promise = (async () => {
        let items: T[] = [];
        do {
          current.dirty = false;
          items = await load();
        } while (current.dirty);
        if (current.generation === generation) publish(items);
        return items;
      })().finally(() => {
        if (request === current) request = null;
      });
      request = current;
      return current.promise;
    },
  };
}

function latestTime(...values: Array<string | null>) {
  return Math.max(0, ...values.map((value) => value ? Date.parse(value) || 0 : 0));
}

export function createFavoriteShelfLoader(
  load: (
    itemType: FavoriteItemType,
    publishPartial: (entries: FavoriteShelfEntry[]) => void,
  ) => Promise<FavoriteShelfEntry[]>,
  publish: (itemType: FavoriteItemType, entries: FavoriteShelfEntry[]) => void,
) {
  let activeType: FavoriteItemType = "material";
  let requestGeneration = 0;
  const inFlight = new Map<FavoriteItemType, {
    dirty: boolean;
    generation: number;
    promise: Promise<FavoriteShelfEntry[]>;
  }>();

  return {
    activate(itemType: FavoriteItemType) {
      activeType = itemType;
      requestGeneration += 1;
    },
    async refresh(itemType: FavoriteItemType, options: { invalidate?: boolean } = {}) {
      const activeRequest = inFlight.get(itemType);
      if (activeRequest) {
        if (options.invalidate) activeRequest.dirty = true;
        activeRequest.generation = requestGeneration;
        return activeRequest.promise;
      }
      const request = {
        dirty: false,
        generation: requestGeneration,
        promise: Promise.resolve([] as FavoriteShelfEntry[]),
      };
      request.promise = (async () => {
        let entries: FavoriteShelfEntry[] = [];
        do {
          request.dirty = false;
          const cycleGeneration = request.generation;
          entries = await load(itemType, (partialEntries) => {
            if (
              !request.dirty
              && activeType === itemType
              && cycleGeneration === requestGeneration
            ) publish(itemType, partialEntries);
          });
        } while (request.dirty);
        if (activeType === itemType && request.generation === requestGeneration) publish(itemType, entries);
        return entries;
      })().finally(() => {
        if (inFlight.get(itemType) === request) inFlight.delete(itemType);
      });
      inFlight.set(itemType, request);
      return request.promise;
    },
    isLoading(itemType: FavoriteItemType) {
      return inFlight.has(itemType);
    },
  };
}
