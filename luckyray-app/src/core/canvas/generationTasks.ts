import {normalizeGenerationEditorSnapshot, type CanvasGenerationEditorSnapshot} from "./generationEditorSnapshot";
/**
 * Stable, JSON-friendly canvas generation task contract.
 *
 * This module deliberately has no React, DOM, Tauri or provider dependency.
 * Desktop, CLI and MCP adapters can create the same immutable request snapshot,
 * then drive the task through the same explicit state transitions.
 */

import type { CanvasEdgeRole } from "./edgeSemantics";

export const CANVAS_GENERATION_TASK_VERSION = 1 as const;

export const CANVAS_GENERATION_TASK_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type CanvasGenerationTaskStatus = (typeof CANVAS_GENERATION_TASK_STATUSES)[number];
export type CanvasGenerationKind = "text" | "image" | "video";
export type CanvasGenerationProviderStage = "submitting" | "queued" | "generating" | "downloading";

export type CanvasGenerationReferenceSnapshot = {
  id: string;
  sourceNodeId?: string;
  label: string;
  kind: string;
  role: CanvasEdgeRole;
  thumbnailUrl?: string | null;
  mediaUrl?: string | null;
  /** Text or note content compiled into the downstream prompt. */
  text?: string | null;
};

export type CanvasGenerationRequestSnapshot = {
  kind: CanvasGenerationKind;
  prompt: string;
  /** Original editable prompt before connected context is compiled. */
  sourcePrompt?: string;
  editor?: CanvasGenerationEditorSnapshot;
  model: string;
  /** Backend-only credential reference, pinned when the task starts. */
  textProfileId?: string;
  textProfileRevision?: number;
  mediaProfileId?: string;
  mediaProfileRevision?: number;
  aspect?: string;
  quality?: string;
  resolution?: string;
  duration?: number;
  sound?: boolean;
  count?: number;
  cameraStrength?: number;
  references: CanvasGenerationReferenceSnapshot[];
};

export type CanvasGenerationTaskError = {
  code: string;
  message: string;
  retryable: boolean;
  /** Redacted, bounded provider diagnostics safe to persist in canvas history. */
  detail?: string;
};

export function sanitizeCanvasGenerationErrorDetail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const redacted = trimmed
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/(["']?(?:api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, "$1[REDACTED]")
    .replace(/data:(?:image|video)\/[^;,]+;base64,[A-Za-z0-9+/=]+/gi, "data:[REDACTED]");
  return redacted.length > 2000 ? `${redacted.slice(0, 2000)}…` : redacted;
}

export type CanvasGenerationTask = {
  version: typeof CANVAS_GENERATION_TASK_VERSION;
  id: string;
  /** Optional lineage pointer for retries, rerolls and continued creation. */
  parentTaskId?: string;
  sourceNodeId: string;
  resultNodeId: string;
  status: CanvasGenerationTaskStatus;
  request: CanvasGenerationRequestSnapshot;
  attempt: number;
  adapter: string | null;
  error: CanvasGenerationTaskError | null;
  /** Optional provider telemetry. It is safe to persist and ignore in CLI/MCP hosts. */
  providerStage?: CanvasGenerationProviderStage;
  progress?: number;
  /** Provider-side async task id used to resume polling after reopening. */
  providerTaskId?: string;
  /** Set by a host when it resumes an existing provider task after reopening. */
  resumedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type CanvasGenerationTaskTransitionError = {
  code: "INVALID_GENERATION_TASK_TRANSITION";
  message: string;
  from: CanvasGenerationTaskStatus;
  to: CanvasGenerationTaskStatus;
};

export type CanvasGenerationTaskTransitionResult =
  | { ok: true; task: CanvasGenerationTask }
  | { ok: false; error: CanvasGenerationTaskTransitionError };

const ALLOWED_TRANSITIONS: Record<CanvasGenerationTaskStatus, readonly CanvasGenerationTaskStatus[]> = {
  queued: ["running", "failed", "cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function createCanvasGenerationTask(input: {
  id: string;
  sourceNodeId: string;
  resultNodeId: string;
  request: CanvasGenerationRequestSnapshot;
  createdAt: string;
  attempt?: number;
  adapter?: string | null;
  parentTaskId?: string;
}): CanvasGenerationTask {
  return {
    version: CANVAS_GENERATION_TASK_VERSION,
    id: input.id,
    parentTaskId: input.parentTaskId,
    sourceNodeId: input.sourceNodeId,
    resultNodeId: input.resultNodeId,
    status: "queued",
    request: {
      ...input.request,
      editor: normalizeGenerationEditorSnapshot(input.request.editor, input.request.references.length),
      references: input.request.references.map((reference) => ({ ...reference })),
    },
    attempt: Math.max(1, Math.floor(input.attempt ?? 1)),
    adapter: input.adapter ?? null,
    error: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}
export function canCancelCanvasGenerationTask(task: CanvasGenerationTask): boolean {
  return task.status === "queued" || task.status === "running";
}

/** Submission is not provider acceptance; terminal state always wins over saved telemetry. */
export function canvasGenerationSubmissionLabel(task: CanvasGenerationTask | undefined, english: boolean): string {
  if (!task) return '';
  if (task.status === 'failed') return english ? 'Request failed' : '提交失败';
  if (task.status === 'cancelled') return english ? 'Cancelled' : '已取消';
  if (task.status === 'succeeded') return english ? 'Completed' : '已完成';
  if (task.request.kind === 'video' && task.providerTaskId?.trim()) return english ? 'Accepted by provider' : '供应商已受理';
  if (task.status === 'queued') return english ? 'Queued locally' : '本地排队';
  return task.request.kind === 'video' ? (english ? 'Submitting' : '提交中') : (english ? 'Processing' : '处理中');
}

export function canRetryCanvasGenerationTask(task: CanvasGenerationTask): boolean {
  // An uncertain POST is not permission to submit a second paid generation.
  if (task.error?.code === "VIDEO_SUBMISSION_UNKNOWN" || task.error?.code === "VIDEO_SUBMISSION_BINDING_CHANGED" || task.error?.code === "VIDEO_STABLE_TASK_ID_REQUIRED") return false;
  return task.status === "failed" || task.status === "cancelled";
}

/** Retry video polling using the same native submission identity and binding.
 * Creating a genuinely new generation remains a separate explicit operation. */
export function resumeCanvasVideoGenerationTask(
  task: CanvasGenerationTask, updatedAt: string,
): CanvasGenerationTask | null {
  if (task.request.kind !== "video" || !canRetryCanvasGenerationTask(task)) return null;
  return {
    ...task,
    status: "queued",
    error: null,
    resumedAt: updatedAt,
    updatedAt,
    providerStage: "queued",
    request: {
      ...task.request,
      references: task.request.references.map(reference => ({ ...reference })),
    },
  };
}

export function transitionCanvasGenerationTask(
  task: CanvasGenerationTask,
  status: CanvasGenerationTaskStatus,
  updatedAt: string,
  options?: {
    adapter?: string | null;
    error?: CanvasGenerationTaskError | null;
  },
): CanvasGenerationTaskTransitionResult {
  if (!ALLOWED_TRANSITIONS[task.status].includes(status)) {
    return {
      ok: false,
      error: {
        code: "INVALID_GENERATION_TASK_TRANSITION",
        message: `Cannot transition generation task from ${task.status} to ${status}`,
        from: task.status,
        to: status,
      },
    };
  }

  return {
    ok: true,
    task: {
      ...task,
      status,
      adapter: options?.adapter === undefined ? task.adapter : options.adapter,
      error: status === "failed" ? options?.error ?? task.error : null,
      providerStage: status === "running" ? task.providerStage : undefined,
      progress: status === "running" ? task.progress : status === "succeeded" ? 100 : undefined,
      updatedAt,
    },
  };
}
