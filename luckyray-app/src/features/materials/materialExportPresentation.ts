import type { MaterialExportTask } from "../../core/services/materials";

export const MATERIAL_EXPORT_VISIBLE_HISTORY_LIMIT = 16;

export type MaterialExportNotice = {
  id: string;
  taskId: string | null;
  message: string;
  tone: "success" | "error" | "neutral";
  action: "open" | "records" | null;
};

export type MaterialExportTaskProblem = {
  message: string;
  failures: number;
  stopped: boolean;
  expired: boolean;
};

export function isMaterialExportRunning(task: MaterialExportTask): boolean {
  return task.phase === "preparing" || task.phase === "running" || task.phase === "cancelling";
}

export function isMaterialExportSummaryExpired(error: unknown): boolean {
  return String(error).includes("导出任务不存在或摘要已过期");
}

/** Preserve insertion order and active controls while bounding the process-local UI history. */
export function upsertMaterialExportTask(
  current: Record<string, MaterialExportTask>,
  task: MaterialExportTask,
  protectedIds: ReadonlySet<string> = new Set(),
): Record<string, MaterialExportTask> {
  const next = { ...current, [task.taskId]: task };
  while (Object.keys(next).length > MATERIAL_EXPORT_VISIBLE_HISTORY_LIMIT) {
    const oldestFinished = Object.values(next).find((item) =>
      !isMaterialExportRunning(item) && !protectedIds.has(item.taskId));
    if (!oldestFinished) break;
    delete next[oldestFinished.taskId];
  }
  return next;
}

/** Display projection only. Never pass this result back to the export backend. */
export function materialExportFriendlyPath(path: string): { full: string; folder: string } {
  const full = path.replace(/^\\\\\?\\(?=[A-Za-z]:\\|UNC\\)/i, "")
    .replace(/^UNC\\/i, "\\\\");
  const segments = full.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return { full, folder: segments[segments.length - 1] || full };
}
