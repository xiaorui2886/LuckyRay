import type { CompanionGrantChange } from "./companionAccess";
export type CompanionGatewayStatus =
  | {
      state: "disabled";
      desktopInstanceId: string;
      certificateFingerprint: string;
    }
  | {
      state: "running";
      desktopInstanceId: string;
      certificateFingerprint: string;
      bindAddress: string;
      port: number;
      generation: number;
      firewall: "manual-permission-required";
    }
  | {
      state: "stopping";
      desktopInstanceId: string;
      certificateFingerprint: string;
      generation: number;
    }
  | { state: "recovery-required"; code: string }
  | { state: "resume-failed"; bindAddress: string | null; port: number | null; code: string; bindFailure?: { stage: "bind"; kind: "address-in-use" | "access-denied" | "address-unavailable" | "unknown"; osCode: number | null; attempts: number } };

export type EndpointRecoveryEnvelope = {
  schema: 1;
  kind: "luckyray.endpoint-recovery";
  baseUrl: string;
  desktopInstanceId: string;
  certificateFingerprint: string;
};
export type EndpointRecoveryPresentation = { envelope: EndpointRecoveryEnvelope; qrSize: number; qrPath: string };

export type LanIpv4Interface = {
  interfaceId: string;
  name: string;
  address: string;
  prefixLength: number;
};

export type PairingPresentation = {
  pairingId: string;
  v: 1;
  name: string;
  instance: string;
  ip: string;
  port: number;
  secret: string;
  fp: string;
  expiresAt: string;
  qrSize: number;
  qrPath: string;
};

export type CanonicalPairingEnvelope = Pick<
  PairingPresentation,
  "v" | "name" | "instance" | "ip" | "port" | "secret" | "fp"
>;

export type PairedCompanionDevice = {
  deviceId: string;
  label: string;
  createdAt: string;
  lastAuthenticatedAt: string | null;
  revokedAt: string | null;
  connected: boolean;
};

export type CompanionSecurityAuditEntry = {
  action: string;
  deviceId: string | null;
  occurredAt: string;
  result: string;
};

export type CompanionRevokeResult = {
  deviceId: string;
  gateway: { outcome: "revoked" | "already-revoked" | "not-found" };
  lightseek: null;
};

export type CompanionAuthorizationMode = "manual" | "trusted";

export type CompanionServiceGrantState = {
  authorizationMode?: CompanionAuthorizationMode;
  authorizationConfigured?: boolean;
  savedLibraries?: Array<{ scopeKind: "catalog" | "vault"; scopeId: string; label: string; available: boolean }>;
  serviceOverrides?: Array<{ grantClass: string; scopeKind: string }>;
  permissionRevision: number;
  grants: Array<{ grantClass: "content.read" | "content.write" | "ingest.write" | "desktop.open"; scopeKind: "catalog" | "vault"; scopeId: string }>;
  currentVault: { vaultId: string; label: string } | null;
};

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

const QR_KEYS = ["v", "name", "instance", "ip", "port", "secret", "fp"] as const;
const PRESENTATION_KEYS = new Set<string>([...QR_KEYS, "pairingId", "expiresAt", "qrSize", "qrPath"]);

function isPrivateLanIpv4(value: string) {
  const octets = value.split(".");
  if (octets.length !== 4 || octets.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part))) return false;
  const numbers = octets.map(Number);
  if (numbers.some((part) => part > 255)) return false;
  return numbers[0] === 10
    || (numbers[0] === 172 && numbers[1] >= 16 && numbers[1] <= 31)
    || (numbers[0] === 192 && numbers[1] === 168);
}

export function assertCanonicalPairingEnvelope(value: unknown): CanonicalPairingEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("配对码格式无效");
  }
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((key) => !PRESENTATION_KEYS.has(key))) {
    throw new Error("配对码包含未支持字段");
  }
  if (
    source.v !== 1
    || typeof source.name !== "string"
    || !source.name.trim()
    || typeof source.instance !== "string"
    || !source.instance.trim()
    || typeof source.ip !== "string"
    || !isPrivateLanIpv4(source.ip)
    || !Number.isInteger(source.port)
    || Number(source.port) < 1
    || Number(source.port) > 65_535
    || typeof source.secret !== "string"
    || !source.secret
    || typeof source.fp !== "string"
    || !/^[a-f\d]{64}$/i.test(source.fp)
  ) {
    throw new Error("配对码字段无效");
  }
  return Object.fromEntries(QR_KEYS.map((key) => [key, source[key]])) as CanonicalPairingEnvelope;
}

export type PairingMemoryAction =
  | { type: "issued"; presentation: PairingPresentation }
  | { type: "close"; pairingId?: string }
  | { type: "expired" | "gateway-stopped" | "gateway-restarted" | "left-panel" };

export function pairingMemoryReducer(
  current: PairingPresentation | null,
  action: PairingMemoryAction,
): PairingPresentation | null {
  if (action.type === "issued") {
    assertCanonicalPairingEnvelope(action.presentation);
    return action.presentation;
  }
  if (action.type === "close" && action.pairingId && current?.pairingId !== action.pairingId) return current;
  return null;
}

export function pairingSecondsRemaining(presentation: PairingPresentation, now = Date.now()) {
  const expiresAt = Date.parse(presentation.expiresAt);
  if (!Number.isFinite(expiresAt)) return 0;
  return Math.max(0, Math.ceil((expiresAt - now) / 1_000));
}

export function createCompanionGatewayClient(invoke: Invoke) {
  return {
    status: () => invoke("companion_gateway_status") as Promise<CompanionGatewayStatus>,
    start: (bindAddress: string) => invoke("companion_gateway_start", { bindAddress }) as Promise<CompanionGatewayStatus>,
    recoverEndpoint: (expectedAddress: string, expectedPort: number) => invoke("companion_gateway_recover_endpoint", { expectedAddress, expectedPort, confirmed: true }) as Promise<CompanionGatewayStatus>,
    endpointRecoveryPresentation: () => invoke("companion_gateway_endpoint_recovery_presentation") as Promise<EndpointRecoveryPresentation>,
    stop: () => invoke("companion_gateway_stop") as Promise<CompanionGatewayStatus>,
    restart: (bindAddress: string) => invoke("companion_gateway_restart", { bindAddress }) as Promise<CompanionGatewayStatus>,
    issuePairing: (replaceExisting = false, authorizationMode: CompanionAuthorizationMode = "manual") => invoke("companion_gateway_issue_pairing", { replaceExisting, authorizationMode }) as Promise<PairingPresentation>,
    cancelPairing: (pairingId: string) => invoke("companion_gateway_cancel_pairing", { pairingId }) as Promise<boolean>,
    listInterfaces: () => invoke("companion_gateway_list_interfaces") as Promise<LanIpv4Interface[]>,
    listDevices: () => invoke("companion_gateway_list_devices") as Promise<PairedCompanionDevice[]>,
    listAudit: (limit = 24) => invoke("companion_gateway_list_audit", { limit }) as Promise<CompanionSecurityAuditEntry[]>,
    revokeDevice: (deviceId: string) => invoke("companion_gateway_revoke_device", { deviceId }) as Promise<CompanionRevokeResult>,
    setLshRemoteGrant: (deviceId: string, granted: boolean) => invoke("companion_gateway_lsh_remote_set_grant", { deviceId, granted }) as Promise<void>,
    lshRemoteState: (deviceId: string) => invoke("companion_gateway_lsh_remote_state", { deviceId }) as Promise<{ granted: boolean; runtimeAvailable: boolean }>,
    setAuthorizationMode: (deviceId: string, authorizationMode: CompanionAuthorizationMode, expectedPermissionRevision: number) =>
      invoke("companion_gateway_set_authorization_mode", { deviceId, authorizationMode, expectedPermissionRevision }) as Promise<void>,
    serviceGrants: (deviceId: string) => invoke("companion_gateway_service_grants", { deviceId }) as Promise<CompanionServiceGrantState>,
    setServiceGrants: (deviceId: string, changes: CompanionGrantChange[], expectedPermissionRevision: number, expectedCurrentVaultId: string | null) =>
      invoke("companion_gateway_service_set_grants", { deviceId, changes, expectedPermissionRevision, expectedCurrentVaultId }) as Promise<void>,
    setServiceGrant: (deviceId: string, grantClass: CompanionServiceGrantState["grants"][number]["grantClass"],
      scopeKind: "catalog" | "vault", scopeId: string, enabled: boolean) =>
      invoke("companion_gateway_service_set_grant", { deviceId, grantClass, scopeKind, scopeId, enabled }) as Promise<void>,
  } as const;
}

export type CompanionGatewayClient = ReturnType<typeof createCompanionGatewayClient>;

// One panel lifetime owns only the local ticket ID. The backend remains the
// authority: a delayed close/dispose cannot cancel a newer ticket.
export function createCompanionPairingSession(client: CompanionGatewayClient) {
  let activeId: string | null = null;
  let disposed = false;
  let revision = 0;
  return {
    async issue(replaceExisting: boolean, authorizationMode: CompanionAuthorizationMode = "manual"): Promise<PairingPresentation | null> {
      if (disposed) return null;
      const requestedRevision = ++revision;
      const presentation = await client.issuePairing(replaceExisting, authorizationMode);
      if (disposed || requestedRevision !== revision) {
        await client.cancelPairing(presentation.pairingId);
        return null;
      }
      activeId = presentation.pairingId;
      return presentation;
    },
    async close(pairingId: string) {
      // Closing the visible code also closes any regeneration still in flight.
      // A stale close for another ID has no effect on the current UI lifetime.
      if (activeId === pairingId) revision += 1;
      await client.cancelPairing(pairingId);
      if (activeId === pairingId) activeId = null;
    },
    async dispose() {
      disposed = true;
      if (activeId) {
        const pairingId = activeId;
        activeId = null;
        await client.cancelPairing(pairingId);
      }
    },
  };
}

export async function createDefaultCompanionGatewayClient() {
  const { invoke } = await import("@tauri-apps/api/core");
  return createCompanionGatewayClient(invoke as Invoke);
}

export function companionGatewayErrorMessage(error: unknown) {
  const source = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = typeof source.code === "string" ? source.code : "";
  if (code === "gateway-interface-enumeration-failed") return "无法读取可用的局域网接口。";
  if (["gateway-bind-address-invalid", "gateway-bind-address-not-private", "gateway-bind-address-unavailable"].includes(code)) {
    return "只能选择当前可用的本机局域网 IPv4 接口。";
  }
  if (code === "gateway-bind-conflict") return "该局域网接口暂时无法监听，请稍后重试。";
  if (code === "gateway-bind-access-denied" || code === "firewall/manual-permission-required") return "Windows 拒绝绑定此地址或端口，可能涉及系统保留端口或网络策略；尚不能确定是防火墙。";
  if (code === "pairing-rate-limited") return "配对码生成过于频繁，请稍后再试。";
  if (code === "gateway-transition-in-progress") return "连接服务正在切换状态，请稍后再试。";
  if (typeof source.message === "string" && source.message.length <= 160) return source.message;
  return "连接手机服务暂不可用。";
}
