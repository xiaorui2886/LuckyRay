import { materialLibrarySession } from "./materialLibraryContext";
import { toMaterialCatalogError } from "./materialCatalog";

export type MaterialTransferSelection = { assetIds?: string[]; folderId?: string | null };
export type MaterialTransferItem = { assetId: string; name: string; state: string; targetAssetId: string | null; error: string | null };
export type MaterialTransferTask = {
  taskId: string; kind: "copy" | "export" | "restore" | "move"; phase: string;
  sourceLibraryId: string; targetLibraryId: string | null; currentFile: string | null;
  sourceName: string; targetName: string | null;
  currentBytes: number; currentTotalBytes: number; completed: number; total: number;
  copied: number; skipped: number; failed: number; items: MaterialTransferItem[];
  error: string | null; outputPath: string | null; retryable: boolean;
};
type TransferTransport = <T>(action: Record<string, unknown>, libraryId: string) => Promise<T>;
export const isMaterialTransferRunning = (task: MaterialTransferTask) => ["prepared", "running", "verifying", "staging", "committing"].includes(task.phase);
const isUnresolved = (task: MaterialTransferTask) => task.phase !== "completed" || task.retryable;
function retainTasks(tasks: MaterialTransferTask[]) {
  const seen = new Set<string>();
  const unique = tasks.filter(task => !seen.has(task.taskId) && !!seen.add(task.taskId));
  return [...unique.filter(isUnresolved), ...unique.filter(task => !isUnresolved(task)).slice(0, 16)];
}

/** A small coordinator for the three material operations, with frozen native owners. */
export class MaterialLibraryTransfers {
  private listeners = new Set<() => void>();
  private snapshot: { tasks: MaterialTransferTask[]; error: string | null } = { tasks: [], error: null };
  private refreshing = false;
  private starts = new Map<string, { key: string; work: Promise<MaterialTransferTask> }>();
  private revisions = new Map<string, number>();
  private operationVersion = 0;
  private loads = new Map<string, number>();
  private historyOwner: string | null = null;
  private notified = new Set<string>();
  private controls = new Map<string, number>();
  private transport: TransferTransport;
  private onCommitted: (task: MaterialTransferTask) => void;
  constructor(transport: TransferTransport, onCommitted: (task: MaterialTransferTask) => void = () => {}) {
    this.transport = transport;
    this.onCommitted = onCommitted;
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = () => this.snapshot;
  private publish(tasks = this.snapshot.tasks, error: string | null = null) {
    this.snapshot = { tasks, error }; this.listeners.forEach(listener => listener());
  }
  private record(task: MaterialTransferTask) {
    const existing = this.snapshot.tasks.some(t => t.taskId === task.taskId);
    this.advance(task.taskId);
    // A newly completed result gets a history slot; unresolved work never uses that quota.
    const next = existing && isUnresolved(task) ? this.snapshot.tasks.map(t => t.taskId === task.taskId ? task : t) : [task, ...this.snapshot.tasks.filter(t => t.taskId !== task.taskId)];
    this.publish(retainTasks(next)); this.notify(task);
    return task;
  }
  private advance(taskId: string) { this.revisions.set(taskId, (this.revisions.get(taskId) ?? 0) + 1); }
  private notify(task: MaterialTransferTask) {
    if (["completed", "partial"].includes(task.phase) && !this.notified.has(task.taskId)) {
      this.notified.add(task.taskId); this.onCommitted(task);
    }
  }
  async load(libraryId: string, unresolvedOnly = false) {
    const version = this.operationVersion;
    const revisions = new Map(this.revisions);
    if (!unresolvedOnly) this.historyOwner = libraryId;
    const sequence = (this.loads.get(libraryId) ?? 0) + 1; this.loads.set(libraryId, sequence);
    try {
      const tasks = await this.transport<MaterialTransferTask[]>({ op: "transferList", ...(unresolvedOnly ? { unresolvedOnly: true } : {}) }, libraryId);
      if (version !== this.operationVersion || this.loads.get(libraryId) !== sequence) return;
      tasks.forEach(task => this.confirm(task, libraryId, task.taskId));
      const accepted = tasks.filter(task => (revisions.get(task.taskId) ?? 0) === (this.revisions.get(task.taskId) ?? 0)
        && !this.controls.has(task.taskId)
        && (!unresolvedOnly || isUnresolved(task))
        && (isUnresolved(task) || this.historyOwner === libraryId || this.snapshot.tasks.some(t => t.taskId === task.taskId)));
      const updates = new Map(accepted.map(task => [task.taskId, task]));
      const known = this.snapshot.tasks.map(task => updates.get(task.taskId) ?? task);
      const ids = new Set(this.snapshot.tasks.map(task => task.taskId));
      accepted.forEach(task => this.advance(task.taskId));
      this.publish(retainTasks([
        ...accepted.filter(task => isUnresolved(task) && !ids.has(task.taskId)),
        ...known.filter(isUnresolved),
        ...accepted.filter(task => !isUnresolved(task)),
        ...known.filter(task => !isUnresolved(task) && !updates.has(task.taskId)),
      ]));
      accepted.forEach(task => this.notify(task));
    } catch (e) {
      if (version === this.operationVersion && this.loads.get(libraryId) === sequence) this.publish(undefined, toMaterialCatalogError(e).message);
    }
  }
  start(libraryId: string, action: Record<string, unknown>, requestId = crypto.randomUUID()): Promise<MaterialTransferTask> {
    const key = JSON.stringify([libraryId, action]);
    const existing = this.starts.get(requestId);
    if (existing) return existing.key === key ? existing.work : Promise.reject(new Error("任务身份已用于另一请求"));
    // Copy the request now; later selections cannot change either library or IDs.
    const frozen = structuredClone({ ...action, requestId });
    this.operationVersion++;
    const work = this.transport<MaterialTransferTask>(frozen, libraryId).then(task => this.record(this.confirm(task, libraryId, requestId)));
    this.starts.set(requestId, { key, work });
    void work.finally(() => { this.starts.delete(requestId); }).catch(() => {});
    return work;
  }
  async refresh() {
    if (this.refreshing) return; this.refreshing = true;
    try {
      const active = this.snapshot.tasks.filter(task => isMaterialTransferRunning(task) && !this.controls.has(task.taskId));
      const revisions = active.map(task => this.revisions.get(task.taskId) ?? 0);
      const updates = await Promise.allSettled(active.map(task => this.transport<MaterialTransferTask>({ op: "transferStatus", taskId: task.taskId }, task.sourceLibraryId).then(update => this.confirm(update, task.sourceLibraryId, task.taskId))));
      const errors: string[] = [];
      updates.forEach((result, index) => {
        if (revisions[index] !== (this.revisions.get(active[index].taskId) ?? 0)) return;
        if (result.status === "fulfilled") this.record(result.value);
        else errors.push(`${({ copy: "复制", move: "移动", export: "库包", restore: "恢复" } as Record<string, string>)[active[index].kind] ?? "库包"}任务状态暂时无法读取：${toMaterialCatalogError(result.reason).message}`);
      });
      if (errors.length) this.publish(undefined, errors.join("；"));
    } finally { this.refreshing = false; }
  }
  async cancel(task: MaterialTransferTask) {
    this.operationVersion++;
    return this.control(task, "transferCancel");
  }
  async retry(task: MaterialTransferTask) {
    this.operationVersion++;
    return this.control(task, "transferRetry");
  }
  private async control(task: MaterialTransferTask, op: "transferCancel" | "transferRetry") {
    this.advance(task.taskId); const revision = this.revisions.get(task.taskId)!;
    this.controls.set(task.taskId, revision);
    try {
      const result = this.confirm(await this.transport<MaterialTransferTask>({ op, taskId: task.taskId }, task.sourceLibraryId), task.sourceLibraryId, task.taskId);
      if (revision !== this.revisions.get(task.taskId)) return result;
      if (op === "transferRetry" && task.retryable) this.notified.delete(task.taskId);
      return this.record(result);
    } finally {
      if (this.controls.get(task.taskId) === revision) this.controls.delete(task.taskId);
    }
  }
  private confirm(task: MaterialTransferTask, libraryId: string, taskId: string) {
    if (task.sourceLibraryId !== libraryId || task.taskId !== taskId) throw new Error("素材库任务响应身份不匹配");
    return task;
  }
}
export const materialLibraryTransfers = new MaterialLibraryTransfers((action, libraryId) => materialLibrarySession.request(action, libraryId), task => {
  void materialLibrarySession.refresh().catch(() => {});
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("luckyray:material-library-change", { detail: { libraryId: task.targetLibraryId ?? task.sourceLibraryId } }));
});
export type MaterialLibraryCopyIntent = { libraryId: string; selection: MaterialTransferSelection; label: string };
export function requestMaterialLibraryCopy(intent: MaterialLibraryCopyIntent) {
  window.dispatchEvent(new CustomEvent("luckyray:material-library-copy", { detail: structuredClone(intent) }));
}
