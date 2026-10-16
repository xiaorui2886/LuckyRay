import type { MaterialAsset } from "../../core/services/materials";
import {
  knowledgeDocumentNoteId,
  knowledgeTagIdentity,
} from "../../core/services/knowledge";
import {
  emptySmartFolderCriteria,
  type CanvasSmartFolderCriteria,
  type MaterialSmartFolderCriteria,
  type NoteSmartFolderCriteria,
  type SmartFolderCriteria,
  type SmartFolderDefinition,
  type SmartFolderSort,
  type SmartFolderSource,
  type SmartFolderTimeWindow,
} from "../../core/services/smartFolders";

export type BuiltInSmartFolderDefinition = SmartFolderDefinition & {
  builtIn: true;
  builtInMode: "recent" | "untagged";
  description: string;
};

export type SmartFolderResultEntry = {
  id: string;
  source: SmartFolderSource;
  name: string;
  summary: string;
  updatedAt: string | null;
  addedAt: string | null;
  previewUrl: string | null;
  kind: string | null;
  tags: string[];
};

export type SmartFolderResultCopy = {
  untitledMaterial: string;
  untitledNote: string;
  untitledCanvas: string;
  canvasSummary: (nodes: number, edges: number) => string;
};

type MaterialFilterContext = {
  tagMap: Record<string, string[]>;
  favoriteIds: ReadonlySet<string>;
  untagged?: boolean;
  copy?: SmartFolderResultCopy;
};

type FavoriteFilterContext = {
  favoriteIds: ReadonlySet<string>;
  untagged?: boolean;
  copy?: SmartFolderResultCopy;
};

type CanvasEntry = {
  id: string;
  name: string;
  updatedAt: string;
  createdAt?: string;
  nodeCount?: number;
  edgeCount?: number;
  coverUrl?: string | null;
};

type NoteDocumentEntry = {
  relativePath: string;
  fileName: string;
  title: string;
  tags: string[];
  plainText: string;
  excerpt: string;
  modifiedAt?: string | null;
  mtime?: string | null;
};

const BUILT_IN_TIMESTAMP = "1970-01-01T00:00:00.000Z";

function builtIn(
  id: string,
  name: string,
  description: string,
  source: SmartFolderSource,
  sort: SmartFolderSort,
  builtInMode: BuiltInSmartFolderDefinition["builtInMode"],
): BuiltInSmartFolderDefinition {
  return {
    id,
    name,
    description,
    source,
    criteriaVersion: 1,
    criteria: emptySmartFolderCriteria(source),
    sort,
    createdAt: BUILT_IN_TIMESTAMP,
    updatedAt: BUILT_IN_TIMESTAMP,
    builtIn: true,
    builtInMode,
  };
}

export const BUILT_IN_SMART_FOLDERS: BuiltInSmartFolderDefinition[] = [
  builtIn("builtin:recent-materials", "最近添加素材", "按添加时间查看最新素材", "material", "added-desc", "recent"),
  builtIn("builtin:modified-notes", "最近修改笔记", "继续最近整理的知识内容", "note", "modified-desc", "recent"),
  builtIn("builtin:edited-canvases", "最近编辑画布", "回到最近编辑的画布", "canvas", "modified-desc", "recent"),
  builtIn("builtin:untagged-materials", "无标签素材", "发现还没有整理标签的素材", "material", "added-desc", "untagged"),
  builtIn("builtin:untagged-notes", "无标签笔记", "发现还没有整理标签的笔记", "note", "modified-desc", "untagged"),
];

export function filterMaterialSmartFolder(
  criteria: MaterialSmartFolderCriteria,
  sort: SmartFolderSort,
  assets: readonly MaterialAsset[],
  context: MaterialFilterContext,
): SmartFolderResultEntry[] {
  const query = normalizeQuery(criteria.query);
  return sortSmartFolderResultEntries(assets.filter((asset) => {
    const tags = context.tagMap[asset.id] || [];
    return matchesQuery(query, asset.name, asset.description, asset.kind)
      && (!criteria.kinds.length || criteria.kinds.includes(asset.kind))
      && (!criteria.tagIds.length || criteria.tagIds.some((tagId) => tags.includes(tagId)))
      && (!context.untagged || tags.length === 0)
      && matchesFavorite(criteria.favorite, context.favoriteIds.has(asset.id))
      && matchesWindow(asset.importedAt, criteria.added)
      && matchesWindow(asset.updatedAt || asset.importedAt, criteria.modified);
  }).map((asset) => ({
    id: asset.id,
    source: "material" as const,
    name: asset.name || context.copy?.untitledMaterial || "未命名素材",
    summary: asset.description || asset.kind,
    updatedAt: asset.updatedAt || asset.importedAt || null,
    addedAt: asset.importedAt || null,
    previewUrl: asset.thumbnailUrl || asset.previewUrl || null,
    kind: asset.kind || null,
    tags: context.tagMap[asset.id] || [],
  })), sort);
}

export function filterNoteSmartFolder(
  criteria: NoteSmartFolderCriteria,
  sort: SmartFolderSort,
  vaultId: string,
  documents: readonly NoteDocumentEntry[],
  context: FavoriteFilterContext,
): SmartFolderResultEntry[] {
  const query = normalizeQuery(criteria.query);
  return sortSmartFolderResultEntries(documents.flatMap((document) => {
    let id: string;
    try {
      id = knowledgeDocumentNoteId({ vaultId, relativePath: document.relativePath });
    } catch {
      return [];
    }
    const tagIds = document.tags.flatMap((tag) => {
      try {
        return [knowledgeTagIdentity(vaultId, tag)];
      } catch {
        return [];
      }
    });
    if (!matchesQuery(query, document.title, document.fileName, document.excerpt, document.plainText)) return [];
    if (criteria.tagIds.length && !criteria.tagIds.some((tagId) => tagIds.includes(tagId))) return [];
    if (context.untagged && tagIds.length > 0) return [];
    if (!matchesFavorite(criteria.favorite, context.favoriteIds.has(id))) return [];
    const modifiedAt = document.modifiedAt ?? document.mtime ?? null;
    if (!matchesWindow(modifiedAt, criteria.modified)) return [];
    return [{
      id,
      source: "note" as const,
      name: document.title || document.fileName || context.copy?.untitledNote || "未命名笔记",
      summary: document.excerpt || document.plainText.slice(0, 180),
      updatedAt: modifiedAt,
      addedAt: null,
      previewUrl: null,
      kind: "document",
      tags: document.tags,
    }];
  }), sort);
}

export function filterCanvasSmartFolder(
  criteria: CanvasSmartFolderCriteria,
  sort: SmartFolderSort,
  canvases: readonly CanvasEntry[],
  context: FavoriteFilterContext,
): SmartFolderResultEntry[] {
  const query = normalizeQuery(criteria.query);
  return sortSmartFolderResultEntries(canvases.filter((canvas) => (
    matchesQuery(query, canvas.name)
      && matchesFavorite(criteria.favorite, context.favoriteIds.has(canvas.id))
      && matchesWindow(canvas.updatedAt, criteria.modified)
  )).map((canvas) => ({
    id: canvas.id,
    source: "canvas" as const,
    name: canvas.name || context.copy?.untitledCanvas || "未命名画布",
    summary: context.copy?.canvasSummary(canvas.nodeCount || 0, canvas.edgeCount || 0)
      || `${canvas.nodeCount || 0} 个节点 · ${canvas.edgeCount || 0} 条连线`,
    updatedAt: canvas.updatedAt || null,
    addedAt: canvas.createdAt || null,
    previewUrl: canvas.coverUrl || null,
    kind: "canvas",
    tags: [],
  })), sort);
}

export function summarizeSmartFolderCriteria(criteria: SmartFolderCriteria, sort: SmartFolderSort) {
  const parts: string[] = [];
  if (criteria.query.trim()) parts.push(`包含“${criteria.query.trim()}”`);
  if (criteria.source !== "canvas" && criteria.tagIds.length) parts.push(`${criteria.tagIds.length} 个标签任一匹配`);
  if (criteria.source === "material" && criteria.kinds.length) parts.push(criteria.kinds.join(" / "));
  if (criteria.favorite === true) parts.push("仅收藏");
  if (criteria.favorite === false) parts.push("未收藏");
  const modified = criteria.modified;
  if (modified.after || modified.before) parts.push("限定修改时间");
  if (criteria.source === "material" && (criteria.added.after || criteria.added.before)) parts.push("限定添加时间");
  parts.push(sort === "name-asc" ? "按名称" : sort === "added-desc" ? "最近添加" : sort === "modified-asc" ? "最早修改" : "最近修改");
  return parts.join(" · ");
}

export function createLatestSmartFolderResultLoader<T>(
  read: () => Promise<T[]>,
  publish: (items: T[]) => void,
) {
  let activeKey: string | null = null;
  let sequence = 0;
  let currentRead = read;
  let activeRequest: { key: string; promise: Promise<T[]> } | null = null;
  let trailingRefresh: { key: string; promise: Promise<T[]> } | null = null;
  let trailingRequested = false;
  let lastSettled: T[] = [];

  const start = (key: string) => {
    const requestSequence = ++sequence;
    const promise = currentRead().then((items) => {
      lastSettled = items;
      if (activeKey === key && requestSequence === sequence) publish(items);
      return items;
    }).finally(() => {
      if (activeRequest?.promise === promise) activeRequest = null;
    });
    activeRequest = { key, promise };
    return promise;
  };

  const scheduleTrailing = (key: string) => {
    trailingRequested = true;
    if (trailingRefresh?.key === key) return trailingRefresh.promise;
    const current = activeRequest?.promise ?? Promise.resolve(lastSettled);
    const promise = current.catch(() => lastSettled).then(() => {
      if (!trailingRequested || activeKey !== key) return lastSettled;
      trailingRequested = false;
      trailingRefresh = null;
      return start(key);
    }).finally(() => {
      if (trailingRefresh?.promise === promise) trailingRefresh = null;
    });
    trailingRefresh = { key, promise };
    return promise;
  };

  return {
    activate(key: string) {
      if (activeKey === key) return;
      activeKey = key;
      sequence += 1;
      activeRequest = null;
      trailingRefresh = null;
      trailingRequested = false;
    },
    deactivate() {
      activeKey = null;
      sequence += 1;
      activeRequest = null;
      trailingRefresh = null;
      trailingRequested = false;
    },
    setRead(next: () => Promise<T[]>) {
      currentRead = next;
    },
    refresh(key: string, options: { invalidate?: boolean } = {}) {
      if (activeKey !== key) this.activate(key);
      if (activeRequest?.key === key) {
        return options.invalidate ? scheduleTrailing(key) : activeRequest.promise;
      }
      return start(key);
    },
  };
}

function normalizeQuery(value: string) {
  return value.trim().toLocaleLowerCase();
}

function matchesQuery(query: string, ...values: Array<string | null | undefined>) {
  return !query || values.some((value) => (value || "").toLocaleLowerCase().includes(query));
}

function matchesFavorite(filter: boolean | null, favorited: boolean) {
  return filter === null || filter === favorited;
}

function matchesWindow(value: string | null | undefined, window: SmartFolderTimeWindow) {
  if (!window.after && !window.before) return true;
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return false;
  const after = window.after ? Date.parse(window.after) : Number.NEGATIVE_INFINITY;
  const before = window.before ? Date.parse(window.before) : Number.POSITIVE_INFINITY;
  return timestamp >= (Number.isFinite(after) ? after : Number.NEGATIVE_INFINITY)
    && timestamp <= (Number.isFinite(before) ? before : Number.POSITIVE_INFINITY);
}

export function sortSmartFolderResultEntries(entries: SmartFolderResultEntry[], sort: SmartFolderSort) {
  return [...entries].sort((left, right) => {
    if (sort === "name-asc") return left.name.localeCompare(right.name, "zh-CN");
    const leftValue = sort === "added-desc" ? left.addedAt : left.updatedAt;
    const rightValue = sort === "added-desc" ? right.addedAt : right.updatedAt;
    const order = String(rightValue || "").localeCompare(String(leftValue || ""));
    return (sort === "modified-asc" ? -order : order) || left.name.localeCompare(right.name, "zh-CN");
  });
}

export function reconcileSmartFolderDetailSort(
  previous: { id: string; source: SmartFolderSource; sort: SmartFolderSort } | null,
  current: { id: string; source: SmartFolderSource; sort: SmartFolderSort },
  localSort: SmartFolderSort,
) {
  return !previous
    || previous.id !== current.id
    || previous.source !== current.source
    || previous.sort !== current.sort
    ? current.sort
    : localSort;
}

export function canRetainSmartFolderStale(
  previous: { id: string; source: SmartFolderSource } | null,
  current: { id: string; source: SmartFolderSource },
) {
  return previous?.id === current.id && previous.source === current.source;
}

export function smartFolderLocalDateInput(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export function smartFolderLocalDateIso(value: string, end: boolean) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    end ? 23 : 0,
    end ? 59 : 0,
    end ? 59 : 0,
    end ? 999 : 0,
  );
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
