import { serializeDshHostInvoke } from "./dshHostOperations";

// Host-side DSH plugin compatibility service client (COMPAT-R1).
// All authority lives in the wrapper via the authenticated frame protocol;
// this module only invokes the bounded Tauri commands and projects responses.

export type DshPluginCompatFinding = {
  kind: string;
  dependency?: string;
  name?: string;
  range?: string;
};

export type DshPluginCompatEntry = {
  entryId: string;
  packageName: string;
  version: string | null;
  resolved?: boolean;
  outcome: "pass" | "fail" | "unknown" | "environment-limited" | "unchecked";
  reason: string | null;
  quarantined: boolean;
  quarantineReason: string | null;
};

export type DshPluginCompatStatus = {
  runtimeVersion: string | null;
  inactiveDependencies: { packageName: string; version: string | null; installed: boolean }[];
  patchLayers: { layer: string; state: string }[];
  historicalQuarantine: { entryId: string; packageName: string; version: string | null }[];
  manifestMissing: boolean;
  manifestValid: boolean;
  bundles: string[];
  plugins: DshPluginCompatEntry[];
  quarantineSet: string[];
  compatMode: boolean;
  checkerVersion: number;
  dynamicTrial: string;
};

export type DshPluginCompatCheckResult = {
  checked: boolean;
  reason?: string;
  plugins: DshPluginCompatEntry[];
  baseline?: { outcome: string; reason?: string } | null;
  dynamicTrial?: string;
  note?: string;
};

export type DshPluginCompatApplyResult = {
  applied: boolean;
  quarantineSet?: string[];
  guardActive?: boolean;
  unquarantinable?: string[];
  failed?: boolean;
  checked?: boolean;
  reason?: string;
  note?: string | null;
};

export type DshPluginCompatActionFailure = "partial" | "failed" | null;

/**
 * Apply/check responses are control decisions, not advisory status. Fail
 * closed on malformed or ambiguous results so the renderer cannot reopen the
 * original composition unless the requested operation explicitly succeeded.
 */
export function dshPluginCompatActionFailure(value: unknown): DshPluginCompatActionFailure {
  if (!value || typeof value !== "object") return "failed";
  const row = value as Record<string, unknown>;
  if ("unquarantinable" in row && !Array.isArray(row.unquarantinable)) return "failed";
  if (Array.isArray(row.unquarantinable) && row.unquarantinable.length > 0) return "partial";
  if (row.failed === true || row.applied === false || row.checked === false) return "failed";
  if (row.applied !== true && row.checked !== true) return "failed";
  return null;
}

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const OUTCOMES = new Set(["pass", "fail", "unknown", "environment-limited", "unchecked"]);

function projectEntry(value: unknown): DshPluginCompatEntry | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.entryId !== "string" || typeof row.packageName !== "string") return null;
  const outcome = typeof row.outcome === "string" && OUTCOMES.has(row.outcome)
    ? row.outcome as DshPluginCompatEntry["outcome"]
    : "unknown";
  return {
    entryId: row.entryId.slice(0, 128),
    packageName: row.packageName.slice(0, 214),
    version: typeof row.version === "string" ? row.version.slice(0, 64) : null,
    resolved: row.resolved !== false,
    outcome,
    reason: typeof row.reason === "string" ? row.reason.slice(0, 128) : null,
    quarantined: row.quarantined === true,
    quarantineReason: typeof row.quarantineReason === "string" ? row.quarantineReason.slice(0, 128) : null,
  };
}

export function projectDshPluginCompatStatus(value: unknown): DshPluginCompatStatus {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return Object.freeze({
    runtimeVersion: typeof row.runtimeVersion === "string" ? row.runtimeVersion.slice(0, 64) : null,
    inactiveDependencies: Array.isArray(row.inactiveDependencies) ? row.inactiveDependencies.filter((item) => item && typeof item.packageName === "string").slice(0, 64).map((item) => ({ packageName: item.packageName.slice(0, 214), version: typeof item.version === "string" ? item.version.slice(0, 64) : null, installed: item.installed === true })) : [],
    patchLayers: Array.isArray(row.patchLayers) ? row.patchLayers.filter((item) => item && typeof item.layer === "string" && typeof item.state === "string").slice(0, 2).map((item) => ({ layer: item.layer.slice(0, 16), state: item.state.slice(0, 32) })) : [],
    historicalQuarantine: Array.isArray(row.historicalQuarantine) ? row.historicalQuarantine.filter((item) => item && typeof item.entryId === "string" && typeof item.packageName === "string").slice(0, 64).map((item) => ({ entryId: item.entryId.slice(0, 128), packageName: item.packageName.slice(0, 214), version: typeof item.version === "string" ? item.version.slice(0, 64) : null })) : [],
    manifestMissing: row.manifestMissing === true,
    manifestValid: row.manifestValid === true,
    bundles: Array.isArray(row.bundles)
      ? row.bundles.filter((name): name is string => typeof name === "string").slice(0, 32)
      : [],
    plugins: Array.isArray(row.plugins)
      ? row.plugins.map(projectEntry).filter((entry): entry is DshPluginCompatEntry => entry !== null).slice(0, 64)
      : [],
    quarantineSet: Array.isArray(row.quarantineSet)
      ? row.quarantineSet.filter((id): id is string => typeof id === "string").slice(0, 32)
      : [],
    compatMode: row.compatMode === true,
    checkerVersion: Number.isSafeInteger(row.checkerVersion) ? Number(row.checkerVersion) : 0,
    dynamicTrial: typeof row.dynamicTrial === "string" ? row.dynamicTrial.slice(0, 32) : "unknown",
  });
}

export function createDshPluginCompatClient(invoke: Invoke) {
  invoke = serializeDshHostInvoke(invoke);
  return Object.freeze({
    status: async () => projectDshPluginCompatStatus(await invoke("dsh_plugin_compat_status")),
    check: async (baseline: boolean) => (
      await invoke<Record<string, unknown>>("dsh_plugin_compat_check", { baseline })
    ),
    apply: (action: { kind: "normal" } | { kind: "compatible" } | { kind: "restore"; entryId: string }) => (
      invoke<DshPluginCompatApplyResult>("dsh_plugin_compat_apply", { action })
    ),
    // Retires a frozen/dead native surface child so the outer recovery panel
    // is reachable; never closes a healthy surface.
    reclaimFailedSurface: () => invoke<void>("dsh_plugin_compat_reclaim_surface"),
  });
}

export async function createDefaultDshPluginCompatClient() {
  const { invoke } = await import("@tauri-apps/api/core");
  return createDshPluginCompatClient(invoke as Invoke);
}

export type DshPluginCompatReasonToken =
  | "pass"
  | "failed"
  | "quarantined"
  | "limited"
  | "unknown"
  | "unchecked";

/** Semantic reason token for one entry; copy lives in the UI layer. */
export function dshPluginCompatReasonToken(entry: DshPluginCompatEntry): DshPluginCompatReasonToken {
  if (entry.quarantined) {
    return entry.outcome === "fail" ? "failed" : "quarantined";
  }
  switch (entry.outcome) {
    case "pass": return "pass";
    case "fail": return "failed";
    case "environment-limited": return "limited";
    case "unknown": return "unknown";
    default: return "unchecked";
  }
}
