import {
  CANVAS_GENERATION_TASK_VERSION,
  type CanvasGenerationKind,
  type CanvasGenerationRequestSnapshot,
  type CanvasGenerationTask,
  type CanvasGenerationTaskStatus,
} from "./generationTasks";

export const CANVAS_GENERATION_HISTORY_VERSION = 4 as const;

export type CanvasGenerationHistoryEntry = {
  version: typeof CANVAS_GENERATION_HISTORY_VERSION;
  id: string;
  taskId: string;
  parentTaskId?: string;
  /** User picks within this immutable image result; retained by the existing history store. */
  preferredImageIndexes?: number[];
  sourceNodeId: string;
  resultNodeId: string;
  kind: CanvasGenerationKind;
  status: CanvasGenerationTaskStatus;
  request: CanvasGenerationRequestSnapshot;
  attempt: number;
  prompt: string;
  model: string;
  aspect?: string;
  quality?: string;
  resolution?: string;
  duration?: number;
  providerTaskId?: string;
  resumedAt?: string;
  providerStage?: CanvasGenerationTask["providerStage"];
  progress?: number;
  outputText?: string;
  outputMediaUrl?: string;
  outputThumbnailUrl?: string;
  outputMediaItems?: Array<{ url: string; thumbnailUrl?: string | null }>;
  errorCode?: string;
  errorMessage?: string;
  errorRetryable?: boolean;
  errorDetail?: string;
  createdAt: string;
  updatedAt: string;
};

export type CanvasGenerationHistoryOutput = {
  text?: string;
  mediaUrl?: string;
  thumbnailUrl?: string;
  mediaItems?: Array<{ url: string; thumbnailUrl?: string | null }>;
};

export type CanvasGenerationLibraryCandidate = {
  historyId: string;
  taskId: string;
  kind: "image" | "video";
  mediaUrl: string;
  thumbnailUrl?: string;
  prompt: string;
  model: string;
  createdAt: string;
};

export function historyEntryFromTask(
  task: CanvasGenerationTask,
  output?: CanvasGenerationHistoryOutput,
): CanvasGenerationHistoryEntry {
  return {
    version: CANVAS_GENERATION_HISTORY_VERSION,
    id: `history:${task.id}`,
    taskId: task.id,
    parentTaskId: task.parentTaskId,
    sourceNodeId: task.sourceNodeId,
    resultNodeId: task.resultNodeId,
    kind: task.request.kind,
    status: task.status,
    request: {
      ...task.request,
      references: task.request.references.map((reference) => ({ ...reference })),
    },
    attempt: task.attempt,
    prompt: task.request.prompt,
    model: task.request.model,
    aspect: task.request.aspect,
    quality: task.request.quality,
    resolution: task.request.resolution,
    duration: task.request.duration,
    providerTaskId: task.providerTaskId,
    resumedAt: task.resumedAt,
    providerStage: task.providerStage,
    progress: task.progress,
    outputText: output?.text,
    outputMediaUrl: output?.mediaUrl,
    outputThumbnailUrl: output?.thumbnailUrl,
    outputMediaItems: output?.mediaItems?.map((item) => ({ ...item })),
    errorCode: task.error?.code,
    errorMessage: task.error?.message,
    errorRetryable: task.error?.retryable,
    errorDetail: task.error?.detail,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}
export function upsertGenerationHistory(
  entries: readonly CanvasGenerationHistoryEntry[],
  task: CanvasGenerationTask,
  output?: CanvasGenerationHistoryOutput,
): CanvasGenerationHistoryEntry[] {
  const previous = entries.find((entry) => entry.taskId === task.id);
  const next = {
    ...historyEntryFromTask(task, output),
    preferredImageIndexes: previous?.preferredImageIndexes,
    providerTaskId: task.providerTaskId ?? previous?.providerTaskId,
    resumedAt: task.resumedAt ?? previous?.resumedAt,
    providerStage: task.providerStage ?? previous?.providerStage,
    progress: task.progress ?? previous?.progress,
    outputText: output?.text ?? previous?.outputText,
    outputMediaUrl: output?.mediaUrl ?? previous?.outputMediaUrl,
    outputThumbnailUrl: output?.thumbnailUrl ?? previous?.outputThumbnailUrl,
    outputMediaItems: output?.mediaItems?.map((item) => ({ ...item })) ?? previous?.outputMediaItems,
  };
  return [next, ...entries.filter((entry) => entry.taskId !== task.id)]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function normalizeGenerationHistory(value: unknown): CanvasGenerationHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is CanvasGenerationHistoryEntry => {
    if (!entry || typeof entry !== "object") return false;
    const item = entry as Partial<CanvasGenerationHistoryEntry>;
    return typeof item.taskId === "string"
      && typeof item.sourceNodeId === "string"
      && typeof item.resultNodeId === "string"
      && ["text", "image", "video"].includes(item.kind || "")
      && typeof item.createdAt === "string";
  }).map((entry) => {
    const request = entry.request && typeof entry.request === "object"
      ? entry.request
      : {
          kind: entry.kind,
          prompt: entry.prompt || "",
          model: entry.model || "",
          aspect: entry.aspect,
          quality: entry.quality,
          resolution: entry.resolution,
          duration: entry.duration,
          references: [],
        };
    return {
      ...entry,
      version: CANVAS_GENERATION_HISTORY_VERSION,
      preferredImageIndexes: Array.isArray(entry.preferredImageIndexes)
        ? [...new Set(entry.preferredImageIndexes.filter(index=>Number.isInteger(index)&&index>=0&&index<(entry.outputMediaItems?.length||(entry.outputMediaUrl?1:0))))]
        : undefined,
      request: {
        ...request,
        references: Array.isArray(request.references) ? request.references.map((reference) => ({ ...reference })) : [],
      },
      attempt: Math.max(1, Math.floor(entry.attempt || 1)),
      outputMediaItems: Array.isArray(entry.outputMediaItems)
        ? entry.outputMediaItems.filter((item) => !!item?.url).map((item) => ({ ...item }))
        : undefined,
    };
  });
}

export function toGenerationLibraryCandidate(
  entry: CanvasGenerationHistoryEntry,
): CanvasGenerationLibraryCandidate | null {
  if ((entry.kind !== "image" && entry.kind !== "video") || !entry.outputMediaUrl) return null;
  return {
    historyId: entry.id,
    taskId: entry.taskId,
    kind: entry.kind,
    mediaUrl: entry.outputMediaUrl,
    thumbnailUrl: entry.outputThumbnailUrl,
    prompt: entry.prompt,
    model: entry.model,
    createdAt: entry.createdAt,
  };
}
export function generationTaskFromHistory(entry: CanvasGenerationHistoryEntry): CanvasGenerationTask {
  return {
    version: CANVAS_GENERATION_TASK_VERSION,
    id: entry.taskId,
    parentTaskId: entry.parentTaskId,
    sourceNodeId: entry.sourceNodeId,
    resultNodeId: entry.resultNodeId,
    status: entry.status,
    request: {
      ...entry.request,
      references: entry.request.references.map((reference) => ({ ...reference })),
    },
    attempt: entry.attempt,
    adapter: null,
    error: entry.status === "failed" ? {
      code: entry.errorCode || "HISTORY_RESTORED_FAILURE",
      message: entry.errorMessage || "生成失败",
      retryable: entry.errorRetryable ?? true,
      detail: entry.errorDetail,
    } : null,
    providerTaskId: entry.providerTaskId,
    resumedAt: entry.resumedAt,
    providerStage: entry.providerStage,
    progress: entry.progress,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}
