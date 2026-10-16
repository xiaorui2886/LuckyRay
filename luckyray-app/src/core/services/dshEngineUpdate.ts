import { invoke } from "@tauri-apps/api/core";

export type DshEngineUpdatePhase = "recovery_required" | "switch_incomplete" | "recovered_restart_required" | "recovered" | "verification_required" | "verification_failed" | "healthy" | "restart_required" | "exit_prepared" |
  "working" | "unconfigured" | "current" | "requires_host" | "legacy_contract" | "no_candidate" | "upgrade_path" | "check_failed" |
  "untrusted" | "prepare_failed" | "cancelled" | "available" | "idle" |
  "upstream_unvalidated" | "upstream_unavailable" | "upstream_identity" | "initializing";

export type DshEngineUpdateStatus = Readonly<{
  phase: DshEngineUpdatePhase;
  currentVersion: string | null;
  candidateVersion: string | null;
  upstreamVersion?: string | null;
  upstreamUnvalidated?: boolean;
  catalogStatus?: string;
  sourceClass: string;
  channel: string;
  canCheck: boolean;
  canInstall: boolean;
  canCancel: boolean;
  canRecover: boolean;
  canVerify: boolean;
  canRestart: boolean;
  canPrepareExit: boolean;
  message: string;
  workStage: string | null;
  progressDone: number | null;
  progressTotal: number | null;
  cancelRequested: boolean;
  switchError?: string | null;
}>;

let latest: DshEngineUpdateStatus | null = null;
const listeners = new Set<(status: DshEngineUpdateStatus) => void>();

function publish(status: DshEngineUpdateStatus): DshEngineUpdateStatus {
  latest = status;
  for (const listener of listeners) listener(status);
  return status;
}

export const dshEngineUpdate = {
  latest: () => latest,
  subscribe(listener: (status: DshEngineUpdateStatus) => void) {
    listeners.add(listener);
    if (latest) listener(latest);
    return () => { listeners.delete(listener); };
  },
  status: async () => publish(await invoke<DshEngineUpdateStatus>("dsh_engine_update_status")),
  check: async () => publish(await invoke<DshEngineUpdateStatus>("dsh_engine_update_check")),
  install: async () => publish(await invoke<DshEngineUpdateStatus>("dsh_engine_update_install")),
  cancel: async () => publish(await invoke<DshEngineUpdateStatus>("dsh_engine_update_cancel")),
  recover: async () => publish(await invoke<DshEngineUpdateStatus>("dsh_engine_update_recover")),
  verify: async () => publish(await invoke<DshEngineUpdateStatus>("dsh_engine_update_verify")),
  prepareExit: async () => publish(await invoke<DshEngineUpdateStatus>("dsh_engine_update_prepare_exit")),
  restart: async () => invoke<void>("dsh_engine_update_restart"),
};
