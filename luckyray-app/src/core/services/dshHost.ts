import { observeDshStartupInvoke } from "./dshStartupObservation";
import { runDshHostOperation } from "./dshHostOperations";

export type DshHostStage =
  | "initializing"
  | "unavailable"
  | "bundled-verified"
  | "starting"
  | "process-alive"
  | "protocol-authenticated"
  | "session-ready"
  | "exact-turn-accepted"
  | "probe-completed"
  | "restart-waiting"
  | "shutting-down";

export type DshHostStatus = {
  stage: DshHostStage;
  latestProbePassed: boolean;
  hostReusable: boolean;
  canProbe: boolean;
  canRetry: boolean;
  shuttingDown: boolean;
  retryAttempt: number;
  durationMs: number | null;
  message: string;
};

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export type DshHostClient = Readonly<{
  status: () => Promise<DshHostStatus>;
  probe: () => Promise<DshHostStatus>;
  retry: () => Promise<DshHostStatus>;
}>;

type DshHostStartupAction = "probe" | "retry";

class DshHostStartupError extends Error {}

let dshHostReadinessFlight: Promise<DshHostStatus> | null = null;

const STAGES = new Set<DshHostStage>([
  "initializing",
  "unavailable",
  "bundled-verified",
  "starting",
  "process-alive",
  "protocol-authenticated",
  "session-ready",
  "exact-turn-accepted",
  "probe-completed",
  "restart-waiting",
  "shutting-down",
]);

export function projectDshHostStatus(value: unknown): DshHostStatus {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const stage = typeof source.stage === "string" && STAGES.has(source.stage as DshHostStage)
    ? source.stage as DshHostStage
    : "unavailable";
  const durationMs = Number.isSafeInteger(source.durationMs) && Number(source.durationMs) >= 0
    ? Number(source.durationMs)
    : null;
  const retryAttempt = Number.isSafeInteger(source.retryAttempt) && Number(source.retryAttempt) >= 0 && Number(source.retryAttempt) <= 3
    ? Number(source.retryAttempt)
    : 0;
  const verified = stage === "probe-completed";
  // Initial admission runs off the UI thread. A queued probe waits for it on
  // the backend; initializing is never projected as verified/readiness.
  const probeEligible = stage === "initializing" || stage === "bundled-verified" || stage === "probe-completed";
  return {
    stage,
    latestProbePassed: verified && source.latestProbePassed === true,
    hostReusable: verified && source.hostReusable === true,
    canProbe: probeEligible && source.shuttingDown !== true && source.canProbe === true,
    canRetry: stage === "unavailable" && source.shuttingDown !== true && source.canRetry === true,
    shuttingDown: stage === "shutting-down" && source.shuttingDown === true,
    retryAttempt,
    durationMs,
    message: typeof source.message === "string" && source.message.length <= 120
      ? source.message
      : "DeepSeek Harness 诊断暂不可用。",
  };
}

export function createDshHostClient(invoke: Invoke) {
  const call = async (command: "dsh_host_status" | "dsh_host_probe" | "dsh_host_retry") =>
    projectDshHostStatus(await invoke(command));
  return {
    status: () => call("dsh_host_status"),
    probe: () => call("dsh_host_probe"),
    retry: () => call("dsh_host_retry"),
  };
}

function isDshHostReady(status: DshHostStatus) {
  return status.stage === "probe-completed"
    && status.latestProbePassed
    && status.hostReusable;
}

function unavailableMessage(status: DshHostStatus) {
  if (status.shuttingDown) return "AI 助手正在关闭，请稍后重试。";
  if (status.stage === "unavailable") return "AI 助手运行组件暂不可用，请重试。";
  return "AI 助手尚未准备好，请重试。";
}

async function runDshHostReadiness(
  client: DshHostClient,
  action: DshHostStartupAction,
) {
  const current = await client.status();
  if (isDshHostReady(current)) return current;

  let result: DshHostStatus;
  if (action === "retry" && current.canRetry) {
    result = await client.retry();
  } else if (current.canProbe) {
    result = await client.probe();
  } else {
    throw new DshHostStartupError(unavailableMessage(current));
  }
  if (!isDshHostReady(result)) {
    throw new DshHostStartupError(unavailableMessage(result));
  }
  return result;
}

// React StrictMode/remounts share only an in-progress request. Backend status
// remains the readiness truth, and every settlement clears this renderer aid.
export function ensureDshHostReady(
  client: DshHostClient,
  action: DshHostStartupAction = "probe",
) {
  if (dshHostReadinessFlight) return dshHostReadinessFlight;
  const request = runDshHostOperation(() => runDshHostReadiness(client, action));
  dshHostReadinessFlight = request;
  const clear = () => {
    if (dshHostReadinessFlight === request) dshHostReadinessFlight = null;
  };
  void request.then(clear, clear);
  return request;
}

// Explicit Settings diagnostics still perform a fresh diagnostic, but must
// not overlap the app-owned startup or the compatibility recovery channel.
export function runDshHostDiagnostic(client: DshHostClient, retry: boolean) {
  return runDshHostOperation(() => retry ? client.retry() : client.probe());
}

export function readDshHostStatusAfterOperations(client: DshHostClient) {
  return runDshHostOperation(() => client.status());
}

export function createDshHostStartupPreloader(createClient = createDefaultDshHostClient) {
  let startup: Promise<DshHostStatus> | null = null;
  return (nativeWindowLabel: string | null) => {
    if (nativeWindowLabel !== "main") return null;
    if (!startup) {
      let client: Promise<DshHostClient> | null = null;
      const getClient = () => client ??= createClient();
      // Reserve readiness synchronously, before any route can inspect compat.
      // The lazy client import and native probe run without blocking rendering.
      startup = ensureDshHostReady({
        status: async () => (await getClient()).status(),
        probe: async () => (await getClient()).probe(),
        retry: async () => (await getClient()).retry(),
      });
      // Failure is observed by the AI entry and its existing explicit Retry UI.
      // A remount does not silently start another probe or recovery attempt.
      void startup.catch(() => undefined);
    }
    return startup;
  };
}

export const preloadDshHostAtStartup = createDshHostStartupPreloader();

export function describeDshHostStartupError(error: unknown) {
  return error instanceof DshHostStartupError
    ? error.message
    : "AI 助手启动失败，请重试。";
}

export async function createDefaultDshHostClient() {
  const { invoke } = await import("@tauri-apps/api/core");
  return createDshHostClient(observeDshStartupInvoke(invoke as Invoke));
}
