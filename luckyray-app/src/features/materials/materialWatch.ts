import type { LuckyRayBridge } from "../../core/bridge/luckyRayBridge";
import { materialLibrarySession, readMaterialLibraryPreference, writeMaterialLibraryPreference } from "../../core/services/materialLibraryContext";
import { createMaterialLibraryAdapter } from "../../core/services/materialLibraryAdapter";
import type { MaterialCatalogAdapter, MaterialCatalogImportResult } from "../../core/services/materialCatalog";
import { readSavedSettings } from "../settings/useSettings";
import { MaterialRootEvents, RootEventBatch } from "./materialRootEvents";

export type MaterialWatchStorageMode = "managed" | "linked" | "source";

export type MaterialWatchSource = {
  id: string;
  path: string;
  enabled: boolean;
  recursive: boolean;
  storageMode: MaterialWatchStorageMode;
  preserveFolderStructure: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MaterialWatchStatus = {
  sourceId: string;
  state: "idle" | "scanning" | "success" | "error";
  lastRunAt?: string;
  lastImportedCount?: number;
  lastSkippedDuplicateCount?: number;
  lastFailedCount?: number;
  lastError?: string;
  watchError?: string;
  lastElapsedMs?: number;
  waitingFiles?: number;
};

export type MaterialWatchRunSummary = {
  imported: number;
  skipped: number;
  failed: number;
  errors: number;
  scanned: number;
};

const WATCH_SOURCES_KEY = "luckyray-material-watch-sources-v1";
const WATCH_STATUS_KEY = "luckyray-material-watch-status-v1";
const WATCH_ROOT_KEY = "luckyray-material-watch-root-v1";
export const LIBRARY_ROOT_SOURCE = "library-root";
export function readLibraryRootWatch(libraryId: string): { enabled: boolean; root: string } {
  try {
    const value = JSON.parse(readMaterialLibraryPreference(WATCH_ROOT_KEY, libraryId) || "null");
    return { enabled: value?.enabled === true, root: typeof value?.root === "string" ? value.root : "" };
  } catch { return { enabled: false, root: "" }; }
}
export function setLibraryRootWatch(libraryId: string, root: string, enabled: boolean) {
  if (!libraryId || !root) throw new Error("请先确认此素材库的目录");
  writeMaterialLibraryPreference(WATCH_ROOT_KEY, JSON.stringify({ enabled, root }), libraryId);
  window.dispatchEvent(new CustomEvent("luckyray:material-watch-sources"));
}
function configuredRootLibraries() {
  return (materialLibrarySession.getSnapshot().registry?.libraries || []).filter(library =>
    library.visible && library.state === "ready" && readLibraryRootWatch(library.id).enabled);
}
const WATCH_POLL_MS = 300_000;
const WATCH_INITIAL_DELAY_MS = 4_000;
const rootPending = new RootEventBatch();
const rootEvents = new MaterialRootEvents(async (id, root, receive) => {
  const { Channel } = await import("@tauri-apps/api/core");
  const channel = new Channel(receive);
  const token = await materialLibrarySession.request<string>({ op: "watchLibraryRoot", expectedRoot: root, channel }, id);
  return async () => { await materialLibrarySession.request({ op: "unwatchLibraryRoot", token }, id); };
}, (id, event) => {
  if (!watchServiceStarted || !configuredRootLibraries().some(library => library.id === id)) return;
  if (event.error) setWatchError(id, event.error);
  rootPending.add(id, event.rescan ? null : event.paths);
  scheduleWatchScan(350, false);
}, (id, error) => setWatchError(id, `目录监听不可用，使用低频扫描：${String(error)}`));
function setWatchError(id: string, error: string) {
  const statuses = readMaterialWatchStatuses(id);
  statuses[LIBRARY_ROOT_SOURCE] = { ...(statuses[LIBRARY_ROOT_SOURCE] || { sourceId: LIBRARY_ROOT_SOURCE, state: "idle" }), watchError: error };
  writeMaterialWatchStatuses(statuses, id);
}
function syncRootEvents() {
  rootEvents.sync(configuredRootLibraries().map(library => ({ id: library.id, root: readLibraryRootWatch(library.id).root })));
}

let bridgeRef: LuckyRayBridge | null = null;
let legacyBridge: LuckyRayBridge | null = null;
let stopLibraryWatch: (() => void) | null = null;
let watchTimer: number | null = null;
let watchScanPromise: Promise<MaterialWatchRunSummary> | null = null;
let watchRescanRequested = false;
let watchServiceStarted = false;
let watchGeneration = 0;
let watchTimerDue = 0;
let watchTimerFull = false;
let watchFullRequested = false;

function createId(prefix = "watch") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeStorageMode(value: unknown): MaterialWatchStorageMode {
  return value === "managed" || value === "source" ? value : "linked";
}

function normalizeSource(value: unknown): MaterialWatchSource | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<MaterialWatchSource>;
  const path = typeof raw.path === "string" ? raw.path.trim() : "";
  if (!path) return null;
  const now = new Date().toISOString();
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : createId(),
    path,
    enabled: raw.enabled !== false,
    recursive: raw.recursive !== false,
    storageMode: normalizeStorageMode(raw.storageMode),
    preserveFolderStructure: raw.preserveFolderStructure !== false,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
  };
}

export function readMaterialWatchSources(libraryId?: string | null): MaterialWatchSource[] {
  try {
    const raw = readMaterialLibraryPreference(WATCH_SOURCES_KEY, libraryId);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeSource).filter((item): item is MaterialWatchSource => Boolean(item));
  } catch {
    return [];
  }
}

export function writeMaterialWatchSources(sources: MaterialWatchSource[]) {
  const normalized = sources
    .map(normalizeSource)
    .filter((item): item is MaterialWatchSource => Boolean(item));
  try {
    writeMaterialLibraryPreference(WATCH_SOURCES_KEY, JSON.stringify(normalized));
  } catch {
    // Keep in-memory callers alive if storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent("luckyray:material-watch-sources", { detail: { sources: normalized } }));
  scheduleWatchScan(1_200);
}

export function addMaterialWatchSource(path: string, defaults?: Partial<MaterialWatchSource>): MaterialWatchSource[] {
  const trimmedPath = path.trim();
  if (!trimmedPath) return readMaterialWatchSources();
  const now = new Date().toISOString();
  const sources = readMaterialWatchSources();
  const existingIndex = sources.findIndex((source) => normalizePath(source.path) === normalizePath(trimmedPath));
  if (existingIndex >= 0) {
    const next = [...sources];
    next[existingIndex] = {
      ...next[existingIndex],
      enabled: true,
      updatedAt: now,
      ...defaults,
      path: trimmedPath,
      id: next[existingIndex].id,
      createdAt: next[existingIndex].createdAt,
    };
    writeMaterialWatchSources(next);
    return next;
  }
  const source: MaterialWatchSource = {
    id: createId(),
    path: trimmedPath,
    enabled: true,
    recursive: defaults?.recursive ?? true,
    storageMode: normalizeStorageMode(defaults?.storageMode || materialLibrarySession.getSnapshot().registry?.libraries.find(library => library.id === materialLibrarySession.getSnapshot().libraryId)?.storageMode || readSavedSettings()["materials.importMode"]),
    preserveFolderStructure: defaults?.preserveFolderStructure ?? true,
    createdAt: now,
    updatedAt: now,
  };
  const next = [...sources, source];
  writeMaterialWatchSources(next);
  return next;
}

export function updateMaterialWatchSource(sourceId: string, patch: Partial<MaterialWatchSource>): MaterialWatchSource[] {
  const now = new Date().toISOString();
  const next = readMaterialWatchSources().map((source) => (
    source.id === sourceId
      ? normalizeSource({ ...source, ...patch, id: source.id, updatedAt: now }) || source
      : source
  ));
  writeMaterialWatchSources(next);
  return next;
}

export function removeMaterialWatchSource(sourceId: string): MaterialWatchSource[] {
  const next = readMaterialWatchSources().filter((source) => source.id !== sourceId);
  writeMaterialWatchSources(next);
  const statuses = readMaterialWatchStatuses();
  delete statuses[sourceId];
  writeMaterialWatchStatuses(statuses);
  return next;
}

export function readMaterialWatchStatuses(libraryId = materialLibrarySession.getSnapshot().libraryId): Record<string, MaterialWatchStatus> {
  try {
    const raw = readMaterialLibraryPreference(WATCH_STATUS_KEY, libraryId);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, MaterialWatchStatus> : {};
  } catch {
    return {};
  }
}

function writeMaterialWatchStatuses(statuses: Record<string, MaterialWatchStatus>, libraryId = materialLibrarySession.getSnapshot().libraryId) {
  try {
    writeMaterialLibraryPreference(WATCH_STATUS_KEY, JSON.stringify(statuses), libraryId);
  } catch {}
  window.dispatchEvent(new CustomEvent("luckyray:material-watch-status", { detail: { statuses } }));
}

function setSourceStatus(sourceId: string, status: Omit<MaterialWatchStatus, "sourceId">, libraryId = materialLibrarySession.getSnapshot().libraryId) {
  const statuses = readMaterialWatchStatuses(libraryId);
  statuses[sourceId] = { sourceId, watchError: statuses[sourceId]?.watchError, ...status };
  writeMaterialWatchStatuses(statuses, libraryId);
}

export function startMaterialWatchService(bridge: LuckyRayBridge) {
  legacyBridge = bridge;
  const choose = () => {
    const id=materialLibrarySession.getSnapshot().libraryId;
    bridgeRef=id && legacyBridge ? createMaterialLibraryAdapter(legacyBridge as unknown as MaterialCatalogAdapter,id) as unknown as LuckyRayBridge : legacyBridge;
  };
  choose();
  if (watchServiceStarted) {
    scheduleWatchScan(WATCH_INITIAL_DELAY_MS);
    return stopMaterialWatchService;
  }
  watchServiceStarted = true;
  syncRootEvents();
  let context=materialLibrarySession.capture();
  stopLibraryWatch=materialLibrarySession.subscribe(() => {
    syncRootEvents();
    const next=materialLibrarySession.capture();
    if(context.libraryId===next.libraryId && context.generation===next.generation) return;
    context=next;choose();++watchGeneration;scheduleWatchScan(WATCH_INITIAL_DELAY_MS);
  });
  watchGeneration += 1;
  window.addEventListener("luckyray:settings-change", handleWatchConfigChanged);
  window.addEventListener("luckyray:material-watch-run-now", handleRunNow);
  window.addEventListener("luckyray:material-watch-sources", handleWatchConfigChanged);
  scheduleWatchScan(WATCH_INITIAL_DELAY_MS);
  return stopMaterialWatchService;
}

export function stopMaterialWatchService() {
  if (watchTimer !== null) {
    window.clearTimeout(watchTimer);
    watchTimer = null;
  }
  if (!watchServiceStarted) return;
  watchServiceStarted = false;
  rootEvents.stop(); rootPending.clear(); watchFullRequested = false;
  watchGeneration += 1;
  watchRescanRequested = false;
  bridgeRef = null;legacyBridge = null;stopLibraryWatch?.();stopLibraryWatch=null;
  window.removeEventListener("luckyray:settings-change", handleWatchConfigChanged);
  window.removeEventListener("luckyray:material-watch-run-now", handleRunNow);
  window.removeEventListener("luckyray:material-watch-sources", handleWatchConfigChanged);
}

function handleWatchConfigChanged() {
  syncRootEvents();
  scheduleWatchScan(1_500);
}

function handleRunNow() {
  scheduleWatchScan(10);
}

function scheduleWatchScan(delayMs = WATCH_POLL_MS, full = true) {
  if (!watchServiceStarted || !bridgeRef) return;
  if (!hasEnabledMaterialWatchSources() && !configuredRootLibraries().length) {
    if (watchTimer !== null) window.clearTimeout(watchTimer);
    watchTimer = null;
    watchRescanRequested = false;
    return;
  }
  if (watchScanPromise) {
    watchRescanRequested = true;
    watchFullRequested ||= full;
    return;
  }
  // Keep the earliest scheduled event batch; continuous copies cannot starve it.
  if (watchTimer !== null && watchTimerDue <= Date.now() + delayMs) {
    watchTimerFull ||= full;
    return;
  }
  if (watchTimer !== null) window.clearTimeout(watchTimer);
  watchTimerDue = Date.now() + delayMs;
  watchTimerFull = full;
  watchTimer = window.setTimeout(() => {
    watchTimer = null;
    const targets = rootPending.drain();
    const runFull = watchTimerFull || watchFullRequested;
    watchFullRequested = false;
    void runMaterialWatchScan(bridgeRef, runFull ? undefined : targets).finally(() => {
      const again = watchRescanRequested;
      watchRescanRequested = false;
      scheduleWatchScan(again ? 1_000 : hasEnabledMaterialWatchSources() ? 45_000 : WATCH_POLL_MS, !again);
    });
  }, delayMs);
}

export function hasEnabledMaterialWatchSources(
  settings = readSavedSettings(),
  sources = readMaterialWatchSources(),
) {
  return settings["general.watchFolder"] === true
    && sources.some((source) => source.enabled && source.path.trim());
}

export async function runMaterialWatchScan(bridge = bridgeRef, targets?: Map<string, Set<string> | null>): Promise<MaterialWatchRunSummary> {
  const summary: MaterialWatchRunSummary = { imported: 0, skipped: 0, failed: 0, errors: 0, scanned: 0 };
  if (!bridge?.importFolder) return summary;
  if (watchScanPromise) return watchScanPromise;
  const settings = readSavedSettings();
  const allSources = readMaterialWatchSources();
  const sources = !targets && hasEnabledMaterialWatchSources(settings, allSources)
    ? allSources.filter((source) => source.enabled && source.path.trim()) : [];
  const rootLibraries = configuredRootLibraries().filter(library => !targets || targets.has(library.id));
  if (!sources.length && !rootLibraries.length) return summary;
  const runGeneration = watchServiceStarted ? watchGeneration : 0;
  const libraryId = materialLibrarySession.getSnapshot().libraryId;

  const promise = (async () => {
    let legacyImported = 0;
    for (const library of rootLibraries) {
      if (runGeneration && (!watchServiceStarted || watchGeneration !== runGeneration)) break;
      const live = materialLibrarySession.getSnapshot().registry?.libraries.find(item => item.id === library.id);
      const config = readLibraryRootWatch(library.id);
      if (!live?.visible || live.state !== "ready" || !config.enabled || !config.root) continue;
      setSourceStatus(LIBRARY_ROOT_SOURCE, { state: "scanning", lastRunAt: new Date().toISOString() }, library.id);
      summary.scanned++;
      try {
        const paths = targets?.get(library.id);
        const result = await materialLibrarySession.request<MaterialCatalogImportResult & { changed: boolean; change?: unknown; previousVersion?: number; deferredPaths?: string[]; elapsedMs?: number }>({ op: "importLibraryRoot", expectedRoot: config.root, ...(paths ? { paths: [...paths] } : {}) }, library.id);
        summary.imported += result.importedCount;
        summary.skipped += result.skippedDuplicateCount;
        summary.failed += result.failedCount;
        setSourceStatus(LIBRARY_ROOT_SOURCE, { state: result.failedCount ? "error" : "success", lastRunAt: new Date().toISOString(),
          lastImportedCount: result.importedCount, lastSkippedDuplicateCount: result.skippedDuplicateCount,
          lastFailedCount: result.failedCount, lastError: result.failedItems[0]?.error,
          lastElapsedMs: result.elapsedMs, waitingFiles: result.deferredPaths?.length || 0 }, library.id);
        if (result.changed) window.dispatchEvent(new CustomEvent("luckyray:material-library-change", { detail: { libraryId: library.id, source: "auto-import", change: result.change, previousVersion: result.previousVersion } }));
        if (watchServiceStarted && readLibraryRootWatch(library.id).enabled && result.deferredPaths?.length) {
          rootPending.add(library.id, result.deferredPaths);
          watchRescanRequested = true;
        }
      } catch (error) {
        summary.errors++;
        setSourceStatus(LIBRARY_ROOT_SOURCE, { state: "error", lastRunAt: new Date().toISOString(), lastError: error instanceof Error ? error.message : String(error) }, library.id);
      }
    }
    for (const source of sources) {
      if (runGeneration && (!watchServiceStarted || watchGeneration !== runGeneration)) break;
      if (!hasEnabledMaterialWatchSources() || !readMaterialWatchSources(libraryId).some(item => item.id === source.id && item.enabled)) break;
      const startedAt = new Date().toISOString();
      summary.scanned += 1;
      setSourceStatus(source.id, { state: "scanning", lastRunAt: startedAt }, libraryId);
      try {
        const result = await bridge.importFolder(source.path, {
          storageMode: source.storageMode,
          recursive: source.recursive,
          preserveFolderStructure: source.preserveFolderStructure,
          managedLibraryDir: null,
        });
        summary.imported += result.importedCount || 0;
        legacyImported += result.importedCount || 0;
        summary.skipped += result.skippedDuplicateCount || 0;
        summary.failed += result.failedCount || 0;
        setSourceStatus(source.id, {
          state: "success",
          lastRunAt: new Date().toISOString(),
          lastImportedCount: result.importedCount || 0,
          lastSkippedDuplicateCount: result.skippedDuplicateCount || 0,
          lastFailedCount: result.failedCount || 0,
          lastError: result.failedItems?.[0]?.error,
        }, libraryId);
        if (runGeneration && (!watchServiceStarted || watchGeneration !== runGeneration)) break;
      } catch (error) {
        summary.errors += 1;
        setSourceStatus(source.id, {
          state: "error",
          lastRunAt: new Date().toISOString(),
          lastError: error instanceof Error ? error.message : String(error),
        }, libraryId);
        if (runGeneration && (!watchServiceStarted || watchGeneration !== runGeneration)) break;
      }
    }

    if (legacyImported > 0 && materialLibrarySession.getSnapshot().libraryId === libraryId && (!runGeneration || (watchServiceStarted && watchGeneration === runGeneration))) {
      window.dispatchEvent(new CustomEvent("luckyray:folders-changed", { detail: { scope: "materials", source: "watch" } }));
      window.dispatchEvent(new CustomEvent("luckyray:materials-data-changed", { detail: { source: "watch", summary } }));
    }
    return summary;
  })();
  watchScanPromise = promise;
  try {
    return await promise;
  } finally {
    if (watchScanPromise === promise) watchScanPromise = null;
  }
}

function normalizePath(path: string) {
  return path.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
}
