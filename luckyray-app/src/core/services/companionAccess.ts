import type { CompanionGatewayStatus, CompanionServiceGrantState, LanIpv4Interface } from "./companionGateway";

export type CompanionGrant = CompanionServiceGrantState["grants"][number];
export type CompanionGrantChange = CompanionGrant & { enabled: boolean };
export type CompanionTrustSelection = { catalog: boolean; vault: boolean; catalogWrite: boolean; vaultWrite: boolean };
const common = ["content.read", "ingest.write", "desktop.open"] as const;
export const sameCompanionGrant = (a: CompanionGrant, b: CompanionGrant) =>
  a.grantClass === b.grantClass && a.scopeKind === b.scopeKind && a.scopeId === b.scopeId;

/** A finite snapshot of explicitly selected scopes, never a wildcard or a future-vault policy. */
export function companionTrustChanges(state: CompanionServiceGrantState, selection: CompanionTrustSelection): CompanionGrantChange[] {
  const changes: CompanionGrantChange[] = [];
  const append = (scopeKind: "catalog" | "vault", scopeId: string, write: boolean) => {
    for (const grantClass of [...common, ...(write ? ["content.write" as const] : [])]) {
      const grant = { grantClass, scopeKind, scopeId };
      if (!state.grants.some(existing => sameCompanionGrant(existing, grant))) changes.push({ ...grant, enabled: true });
    }
  };
  if (selection.catalog) append("catalog", "", selection.catalogWrite);
  if (selection.vault && state.currentVault) append("vault", state.currentVault.vaultId, selection.vaultWrite);
  return changes;
}

/** Interface names are a hint, not proof of physical topology or phone reachability. */
export function companionInterfaceHint(item: LanIpv4Interface): "lan" | "virtual" | "unknown" {
  const name = item.name.toLowerCase();
  if (/virtual|vethernet|vmware|vbox|hyper-v|docker|wsl|vpn|tailscale|zerotier|wireguard|wintun|tap-|隧道|虚拟/.test(name)) return "virtual";
  return /wi-?fi|wlan|wireless|ethernet|以太网|无线/.test(name) ? "lan" : "unknown";
}
export function orderedCompanionInterfaces(interfaces: readonly LanIpv4Interface[]): LanIpv4Interface[] {
  const rank = { lan: 0, unknown: 1, virtual: 2 };
  return [...interfaces].sort((a, b) => rank[companionInterfaceHint(a)] - rank[companionInterfaceHint(b)]
    || a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
}
export function selectedCompanionAddress(current: string, interfaces: readonly LanIpv4Interface[], status: CompanionGatewayStatus | null): string {
  if (status?.state === "running" || status?.state === "resume-failed") return status.bindAddress || "";
  return interfaces.some(item => item.address === current) ? current : orderedCompanionInterfaces(interfaces)[0]?.address || "";
}
