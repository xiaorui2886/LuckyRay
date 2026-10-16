import { materialLibrarySession } from "./materialLibraryContext";
import { getLuckyRayBridge } from "../bridge/luckyRayBridge";

export const SMART_FOLDER_CRITERIA_VERSION = 1 as const;
export const SMART_FOLDER_CHANGE_EVENT = "luckyray:smart-folder-change";

export type SmartFolderSource = "material" | "note" | "canvas";
export type SmartFolderSort = "added-desc" | "modified-desc" | "modified-asc" | "name-asc";
export type SmartFolderTimeWindow = { after: string | null; before: string | null };

export type MaterialSmartFolderCriteria = {
  source: "material";
  query: string;
  kinds: string[];
  tagIds: string[];
  favorite: boolean | null;
  added: SmartFolderTimeWindow;
  modified: SmartFolderTimeWindow;
};

export type NoteSmartFolderCriteria = {
  source: "note";
  query: string;
  tagIds: string[];
  favorite: boolean | null;
  modified: SmartFolderTimeWindow;
};

export type CanvasSmartFolderCriteria = {
  source: "canvas";
  query: string;
  favorite: boolean | null;
  modified: SmartFolderTimeWindow;
};

export type SmartFolderCriteria =
  | MaterialSmartFolderCriteria
  | NoteSmartFolderCriteria
  | CanvasSmartFolderCriteria;

export type SmartFolderDefinition = {
  id: string;
  name: string;
  source: SmartFolderSource;
  criteriaVersion: typeof SMART_FOLDER_CRITERIA_VERSION;
  criteria: SmartFolderCriteria;
  sort: SmartFolderSort;
  createdAt: string;
  updatedAt: string;
};

export type SmartFolderDefinitionInput = {
  name: string;
  criteria: SmartFolderCriteria;
  sort: SmartFolderSort;
};

const materialSmartIds = new Set<string>();
export async function listSmartFolders(): Promise<SmartFolderDefinition[]> {
  const context = materialLibrarySession.capture();
  const bridge = await getLuckyRayBridge();
  const legacy = await bridge.listSmartFolders();
  const scoped = context.libraryId ? await materialLibrarySession.request<SmartFolderDefinition[]>({ op: "smartFolders" }, context.libraryId) : legacy.filter(item => item.source === "material");
  for (const item of scoped) materialSmartIds.add(item.id);
  return [...legacy.filter(item => item.source !== "material"), ...scoped];
}

export async function createSmartFolder(input: SmartFolderDefinitionInput): Promise<SmartFolderDefinition> {
  const libraryId = materialLibrarySession.getSnapshot().libraryId;
  const item = await (input.criteria.source === "material" && libraryId ? materialLibrarySession.request<SmartFolderDefinition>({ op: "smartCreate", input }, libraryId) : getLuckyRayBridge().then(bridge => bridge.createSmartFolder(input)));
  if (item.source === "material") materialSmartIds.add(item.id);
  publishSmartFolderChange(item.id, "created");
  return item;
}

export async function updateSmartFolder(
  id: string,
  input: SmartFolderDefinitionInput,
): Promise<SmartFolderDefinition> {
  const libraryId = materialLibrarySession.getSnapshot().libraryId;
  const item = await (input.criteria.source === "material" && libraryId ? materialLibrarySession.request<SmartFolderDefinition>({ op: "smartUpdate", id, input }, libraryId) : getLuckyRayBridge().then(bridge => bridge.updateSmartFolder(id, input)));
  publishSmartFolderChange(item.id, "updated");
  return item;
}

export async function deleteSmartFolder(id: string): Promise<boolean> {
  const libraryId = materialLibrarySession.getSnapshot().libraryId;
  const deleted = await (materialSmartIds.has(id) && libraryId ? materialLibrarySession.request<boolean>({ op: "smartDelete", id }, libraryId) : getLuckyRayBridge().then(bridge => bridge.deleteSmartFolder(id)));
  if (deleted) publishSmartFolderChange(id, "deleted");
  return deleted;
}

export function emptySmartFolderCriteria(source: SmartFolderSource): SmartFolderCriteria {
  const modified = { after: null, before: null };
  if (source === "material") {
    return {
      source,
      query: "",
      kinds: [],
      tagIds: [],
      favorite: null,
      added: { after: null, before: null },
      modified,
    };
  }
  if (source === "note") return { source, query: "", tagIds: [], favorite: null, modified };
  return { source, query: "", favorite: null, modified };
}

export function smartFolderDraftHash(input: SmartFolderDefinitionInput) {
  return `#smart?draft=${encodeURIComponent(JSON.stringify(input))}`;
}

export function readSmartFolderDraft(hash = typeof window === "undefined" ? "" : window.location.hash) {
  const query = hash.split("?")[1] || "";
  const value = new URLSearchParams(query).get("draft");
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.criteria)) return null;
    const name = boundedString(parsed.name, 80, false)?.trim();
    const source = parsed.criteria.source;
    const sort = parsed.sort;
    if (!name || !isSmartFolderSource(source) || !isSmartFolderSort(sort)) return null;
    if (source !== "material" && sort === "added-desc") return null;
    const criteria = parseDraftCriteria(source, parsed.criteria);
    return criteria ? { name, criteria, sort } : null;
  } catch {
    return null;
  }
}

function parseDraftCriteria(
  source: SmartFolderSource,
  value: Record<string, unknown>,
): SmartFolderCriteria | null {
  const query = boundedString(value.query, 240, true);
  const favorite = nullableBoolean(value.favorite);
  const modified = timeWindow(value.modified);
  if (query === null || favorite === undefined || modified === null) return null;
  if (source === "canvas") return { source, query, favorite, modified };
  const tagIds = boundedStringList(value.tagIds);
  if (tagIds === null) return null;
  if (source === "note") return { source, query, tagIds, favorite, modified };
  const kinds = boundedStringList(value.kinds);
  const added = timeWindow(value.added);
  if (kinds === null || added === null) return null;
  return { source, query, kinds, tagIds, favorite, added, modified };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSmartFolderSource(value: unknown): value is SmartFolderSource {
  return value === "material" || value === "note" || value === "canvas";
}

function isSmartFolderSort(value: unknown): value is SmartFolderSort {
  return value === "added-desc" || value === "modified-desc" || value === "modified-asc" || value === "name-asc";
}

function boundedString(value: unknown, maxChars: number, optional: boolean) {
  if (value === undefined && optional) return "";
  if (typeof value !== "string" || value.length > maxChars) return null;
  return value;
}

function boundedStringList(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) return null;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item || item.trim() !== item || item.length > 160) return null;
    items.push(item);
  }
  return items;
}

function nullableBoolean(value: unknown): boolean | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "boolean" ? value : undefined;
}

function timeWindow(value: unknown): SmartFolderTimeWindow | null {
  if (value === undefined) return { after: null, before: null };
  if (!isRecord(value)) return null;
  const after = nullableDate(value.after);
  const before = nullableDate(value.before);
  return after === undefined || before === undefined ? null : { after, before };
}

function nullableDate(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function publishSmartFolderChange(id: string, action: "created" | "updated" | "deleted") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SMART_FOLDER_CHANGE_EVENT, { detail: { id, action } }));
}
