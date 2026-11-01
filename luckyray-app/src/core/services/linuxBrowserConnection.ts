import { invoke } from "@tauri-apps/api/core";

export type BrowserConnectionExtension = {
  origin: string;
  configured: boolean;
  status: "not-requested" | "pending" | "approved" | "denied" | "revoked";
  requestId: string | null;
  grantId: string | null;
  requestExpiresInSeconds: number | null;
};
export type BrowserConnectionSnapshot = {
  session: string;
  revision: number;
  extensions: BrowserConnectionExtension[];
};
type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
const hex = (value: unknown, length: number) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);

export function validateBrowserConnectionSnapshot(value: unknown): BrowserConnectionSnapshot {
  const invalid = () => { throw new Error("browser-connection-response-invalid"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const snapshot = value as BrowserConnectionSnapshot;
  if (!hex(snapshot.session, 32) || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !Array.isArray(snapshot.extensions)) return invalid();
  const origins = new Set<string>();
  for (const item of snapshot.extensions) {
    if (!item || typeof item !== "object" || !/^(chrome-extension|moz-extension):\/\/[a-z0-9_-]+$/.test(item.origin)
      || origins.has(item.origin) || typeof item.configured !== "boolean") return invalid();
    origins.add(item.origin);
    if (item.status === "approved") {
      if (!hex(item.grantId, 32) || item.requestId !== null || item.requestExpiresInSeconds !== null) return invalid();
    } else if (item.status === "pending") {
      if (!hex(item.requestId, 64) || item.grantId !== null || !Number.isInteger(item.requestExpiresInSeconds)
        || item.requestExpiresInSeconds! < 0 || item.requestExpiresInSeconds! > 300) return invalid();
    } else if (item.status === "denied" || item.status === "revoked") {
      if (!hex(item.requestId, 64) || item.grantId !== null || item.requestExpiresInSeconds !== null) return invalid();
    } else if (item.status === "not-requested") {
      if (item.requestId !== null || item.grantId !== null || item.requestExpiresInSeconds !== null) return invalid();
    } else return invalid();
  }
  return snapshot;
}

export function createLinuxBrowserConnectionClient(call: Invoke = invoke) {
  const request = async (command: string, args?: Record<string, unknown>) =>
    validateBrowserConnectionSnapshot(await call(command, args));
  return {
    snapshot: () => request("linux_browser_connection_status"),
    decide: (requestId: string, decision: "approve" | "reject" | "retry") =>
      request("linux_browser_connection_decide", { requestId, decision }),
    revoke: (origin: string, grantId: string) =>
      request("linux_browser_connection_revoke", { origin, grantId }),
  };
}
