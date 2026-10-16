import test from "node:test";
import assert from "node:assert/strict";
import { companionInterfaceHint, orderedCompanionInterfaces, selectedCompanionAddress, companionTrustChanges } from "../src/core/services/companionAccess.ts";
import type { CompanionServiceGrantState, LanIpv4Interface } from "../src/core/services/companionGateway.ts";
const row = (name: string, address: string): LanIpv4Interface => ({ name, address, interfaceId: address, prefixLength: 24 });
const fixture: CompanionServiceGrantState = { permissionRevision: 3, currentVault: { vaultId: "vault-a", label: "A" }, grants: [] };
test("LAN-named candidates precede possible VM/VPN without pretending every private address works", () => {
  const original = [row("vEthernet (WSL)", "172.19.0.1"), row("Adapter", "10.9.0.1"), row("以太网", "192.168.1.5"), row("WireGuard VPN", "10.2.0.1"), row("Wi-Fi", "192.168.3.5")];
  const ordered = orderedCompanionInterfaces(original);
  assert.deepEqual(ordered.map(companionInterfaceHint), ["lan", "lan", "unknown", "virtual", "virtual"]);
  assert.equal(original[0].name, "vEthernet (WSL)", "polling may not mutate the source list");
  assert.equal(companionInterfaceHint(row("Unknown hardware", "192.168.2.2")), "unknown");
  assert.equal(selectedCompanionAddress("", original, null), ordered[0].address);
});
test("saved listener and user selection win; adapter disappearance never silently rebinds a running service", () => {
  const interfaces = [row("Ethernet", "192.168.1.5"), row("VirtualBox", "192.168.56.1")];
  assert.equal(selectedCompanionAddress(interfaces[1].address, interfaces, null), interfaces[1].address);
  assert.equal(selectedCompanionAddress("10.0.0.99", interfaces, null), interfaces[0].address);
  const failed = { state: "resume-failed" as const, bindAddress: "192.168.2.8", port: 40000, code: "unavailable" };
  assert.equal(selectedCompanionAddress("", interfaces, failed), failed.bindAddress);
  assert.equal(selectedCompanionAddress("", [], failed), failed.bindAddress);
  assert.equal(selectedCompanionAddress("", [], null), "");
});
test("batch choices are explicit snapshots; write/delete is opt-in; existing rights are never cloned or removed", () => {
  const common = companionTrustChanges(fixture, { catalog: true, vault: true, catalogWrite: false, vaultWrite: false });
  assert.equal(common.length, 6); assert.equal(common.some(change => change.grantClass === "content.write"), false);
  assert.equal(companionTrustChanges(fixture, { catalog: false, vault: false, catalogWrite: true, vaultWrite: true }).length, 0);
  const full = companionTrustChanges(fixture, { catalog: true, vault: true, catalogWrite: true, vaultWrite: true });
  assert.equal(full.length, 8); assert.ok(full.every(change => change.scopeKind === "catalog" || change.scopeId === "vault-a"));
  const old = { ...fixture, grants: [{ grantClass: "content.write" as const, scopeKind: "vault" as const, scopeId: "old-vault" }] };
  assert.equal(companionTrustChanges(old, { catalog: false, vault: true, catalogWrite: false, vaultWrite: false }).some(change => change.scopeId === "old-vault"), false);
  assert.equal(old.grants.length, 1);
  assert.equal(companionTrustChanges({ ...fixture, currentVault: null }, { catalog: false, vault: true, catalogWrite: false, vaultWrite: true }).length, 0);
});
