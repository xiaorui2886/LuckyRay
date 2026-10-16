/**
 * Provider-independent generation execution module.
 *
 * Callers provide concrete adapters and receive explicit outcomes. The runner
 * owns adapter selection and valid task transitions; it does not know about
 * React, persistence, Tauri, CLI or MCP transports.
 */

import {
  transitionCanvasGenerationTask,
  type CanvasGenerationKind,
  type CanvasGenerationRequestSnapshot,
  type CanvasGenerationTask,
  type CanvasGenerationTaskError,
} from "./generationTasks";

export type CanvasGenerationOutput = {
  kind: CanvasGenerationKind;
  text?: string;
  mediaUrl?: string;
  thumbnailUrl?: string;
  mediaItems?: Array<{ url: string; thumbnailUrl?: string | null }>;
};

export type CanvasGenerationAdapterResult =
  | { ok: true; output: CanvasGenerationOutput }
  | { ok: false; error: CanvasGenerationTaskError };

export type CanvasGenerationAdapter = {
  id: string;
  supports: (request: CanvasGenerationRequestSnapshot) => boolean;
  execute: (request: CanvasGenerationRequestSnapshot) => Promise<CanvasGenerationAdapterResult>;
};

export type CanvasGenerationExecutionResult =
  | { outcome: "unavailable"; task: CanvasGenerationTask }
  | { outcome: "cancelled"; task: CanvasGenerationTask }
  | { outcome: "skipped"; task: CanvasGenerationTask; reason: "not-queued" | "invalid-transition" }
  | { outcome: "succeeded"; task: CanvasGenerationTask; output: CanvasGenerationOutput }
  | { outcome: "failed"; task: CanvasGenerationTask; error: CanvasGenerationTaskError };

export async function executeCanvasGenerationTask(input: {
  task: CanvasGenerationTask;
  adapters: readonly CanvasGenerationAdapter[];
  now: () => string;
  onTransition: (task: CanvasGenerationTask) => void;
  isCancelled: () => boolean;
}): Promise<CanvasGenerationExecutionResult> {
  if (input.task.status !== "queued") {
    return { outcome: "skipped", task: input.task, reason: "not-queued" };
  }

  const adapter = input.adapters.find((candidate) => candidate.supports(input.task.request));
  if (!adapter) return { outcome: "unavailable", task: input.task };

  const running = transitionCanvasGenerationTask(input.task, "running", input.now(), {
    adapter: adapter.id,
  });
  if (!running.ok) {
    return { outcome: "skipped", task: input.task, reason: "invalid-transition" };
  }
  input.onTransition(running.task);

  let adapterResult: CanvasGenerationAdapterResult;
  try {
    adapterResult = await adapter.execute(running.task.request);
  } catch (error) {
    adapterResult = {
      ok: false,
      error: {
        code: "GENERATION_ADAPTER_EXCEPTION",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    };
  }

  if (input.isCancelled()) {
    return { outcome: "cancelled", task: running.task };
  }

  if (!adapterResult.ok) {
    const failed = transitionCanvasGenerationTask(running.task, "failed", input.now(), {
      adapter: adapter.id,
      error: adapterResult.error,
    });
    if (!failed.ok) {
      return { outcome: "skipped", task: running.task, reason: "invalid-transition" };
    }
    input.onTransition(failed.task);
    return { outcome: "failed", task: failed.task, error: adapterResult.error };
  }

  const succeeded = transitionCanvasGenerationTask(running.task, "succeeded", input.now(), {
    adapter: adapter.id,
  });
  if (!succeeded.ok) {
    return { outcome: "skipped", task: running.task, reason: "invalid-transition" };
  }
  input.onTransition(succeeded.task);
  return { outcome: "succeeded", task: succeeded.task, output: adapterResult.output };
}
