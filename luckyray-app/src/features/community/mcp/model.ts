/** UI DTOs contain labels and opaque IDs only, never native paths or credentials. */
export type RuntimePhase =
  | "absent"
  | "installed"
  | "starting"
  | "ready"
  | "reconnecting"
  | "stopped"
  | "failed";
export type LibraryChoice = { id: string; name: string };
export type McpStatus = {
  revision: string;
  phase: RuntimePhase;
  version: string | null;
  availableVersion?: string;
  updateAvailable?: boolean;
  packageAvailable: boolean;
  downloadBytes: number | null;
  authorized: boolean;
  grant: null | { libraryId: string; vaultId: string; expiresAt: number };
  configured: boolean;
  tunnelId: string | null;
  hasKey: boolean;
  connectOnLaunch: boolean;
  desktopReady: boolean;
  tunnelReady: boolean;
  lastWebCallAt: number | null;
  errorCode: string | null;
  libraries: LibraryChoice[];
  vaults: LibraryChoice[];
};
export type McpAction =
  | "install"
  | "configure"
  | "authorize"
  | "revoke"
  | "connect"
  | "disconnect"
  | "uninstall"
  | "preferences";
export function isRunning(phase: RuntimePhase): boolean {
  return ["starting", "ready", "reconnecting"].includes(phase);
}
export function canConnect(s: McpStatus, now = Date.now()): boolean {
  return (
    s.phase !== "absent" &&
    !s.updateAvailable &&
    !isRunning(s.phase) &&
    s.configured &&
    s.hasKey &&
    s.authorized &&
    !!s.grant &&
    s.grant.expiresAt * 1000 > now
  );
}
export function connectionLabel(
  s: McpStatus,
):
  | "install"
  | "authorize"
  | "configure"
  | "connecting"
  | "webPending"
  | "ready"
  | "stopped"
  | "failed" {
  if (s.phase === "absent") return "install";
  if (!s.authorized) return "authorize";
  if (!s.configured) return "configure";
  if (s.phase === "starting" || s.phase === "reconnecting") return "connecting";
  if (s.phase === "failed") return "failed";
  if (s.phase === "ready" && s.desktopReady && s.tunnelReady)
    return s.lastWebCallAt ? "ready" : "webPending";
  return "stopped";
}
export function validTunnelId(value: string): boolean {
  return /^tunnel_[a-z0-9]{32}$/.test(value);
}
export function safeErrorCode(value: unknown): string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(value)
    ? value
    : "operation-failed";
}
