type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const COMMANDS = new Set([
  "dsh_host_status", "dsh_host_probe", "dsh_host_retry",
  "dsh_native_surface_show", "dsh_native_surface_open", "dsh_native_surface_preload",
]);
const REASONS = new Set([
  "dsh-host-action-busy", "dsh-host-action-not-allowed", "dsh-host-shutting-down",
  "dsh-host-unavailable", "dsh-host-cleanup-unconfirmed",
  "dsh-native-surface-bounds-invalid", "dsh-native-surface-not-open",
  "dsh-native-surface-not-ready", "dsh-native-surface-unavailable",
]);
const STAGES = new Set([
  "initializing", "unavailable", "bundled-verified", "starting", "process-alive",
  "protocol-authenticated", "session-ready", "exact-turn-accepted", "probe-completed",
  "restart-waiting", "shutting-down", "closed", "carrier-ready", "webview-created",
  "client-ready", "session-open",
]);

export type DshStartupObservation = Readonly<{
  phase: string;
  outcome: "started" | "completed" | "failed";
  reason: string;
  durationMs: number;
  stage?: string;
}>;
type ObservationSink = (record: DshStartupObservation) => void;
let emitted = 0;
const MAX_EVENTS = 128;
const consoleSink: ObservationSink = record => {
  if (emitted < MAX_EVENTS) {
    emitted += 1;
    console.info("[dsh-startup]", record);
  }
};

// Only finite protocol codes, never raw errors, paths, arguments or session text.
export function dshStartupReason(error: unknown) {
  const code = error instanceof Error ? error.message : error;
  if (typeof code !== "string") return "unclassified";
  if (REASONS.has(code)) return code;
  if (code.startsWith("dsh-surface-failed:plugin")) return "surface-plugin-failed";
  if (code === "dsh-surface-failed:surface-ready-timeout") return "surface-ready-timeout";
  if (code.startsWith("dsh-surface-failed:")) return "surface-failed";
  return "unclassified";
}

export function observeDshStartupInvoke(invoke: Invoke, sink: ObservationSink = consoleSink): Invoke {
  return async <T>(command: string, args?: Record<string, unknown>) => {
    if (!COMMANDS.has(command)) return invoke<T>(command, args);
    const started = performance.now();
    const observe = (outcome: "started" | "completed" | "failed", reason = "none", result?: unknown) => {
      try {
        const stage = result && typeof result === "object" ? (result as { stage?: unknown }).stage : undefined;
        sink(Object.freeze({
          phase: command, outcome, reason,
          durationMs: Math.min(600_000, Math.max(0, Math.round(performance.now() - started))),
          ...(typeof stage === "string" && STAGES.has(stage) ? { stage } : {}),
        }));
      } catch { /* Evidence cannot alter settlement or issue a second command. */ }
    };
    observe("started");
    try {
      const result = await invoke<T>(command, args);
      observe("completed", "none", result);
      return result;
    } catch (error) {
      observe("failed", dshStartupReason(error));
      throw error;
    }
  };
}
