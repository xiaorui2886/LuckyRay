import test from "node:test";
import { companionTrustChanges } from "../src/core/services/companionAccess.ts";
import assert from "node:assert/strict";
import { createCompanionPresentationStore, companionOnlineCount, companionGrantKey, companionDeviceDisplayLabel } from "../src/core/services/companionPresentationStore.ts";
import { createCompanionGatewayClient, type CompanionServiceGrantState } from "../src/core/services/companionGateway.ts";
const drain = () => new Promise<void>(resolve => setImmediate(resolve));
const device = (id: string, connected = false) => ({ deviceId: id, label: id, connected, revokedAt: null, createdAt: "", lastAuthenticatedAt: null });
const services = (vault = "vault-a", revision = 1): CompanionServiceGrantState => ({ permissionRevision: revision, currentVault: { vaultId: vault, label: vault }, grants: [] });
function fixture() {
  const calls: Array<{ command: string; args: any }> = [];
  let devices = [device("a", true), device("b")], failStatus = false;
  const grants = new Map<string, CompanionServiceGrantState>([["a", services()], ["b", services("vault-b")]]);
  const lsh = new Map([["a", { granted: false, runtimeAvailable: false }], ["b", { granted: false, runtimeAvailable: true }]]);
  const custom = new Map<string, (args: any) => any>();
  const client = createCompanionGatewayClient(async (command, args) => {
    calls.push({ command, args });
    if (custom.has(command)) return custom.get(command)!(args);
    if (command === "companion_gateway_status") { if (failStatus) throw {}; return { state: "running", generation: 1 }; }
    if (command === "companion_gateway_list_devices") return devices;
    if (command === "companion_gateway_list_interfaces" || command === "companion_gateway_list_audit") return [];
    if (command === "companion_gateway_service_grants") return structuredClone(grants.get(args!.deviceId as string));
    if (command === "companion_gateway_lsh_remote_state") return { ...lsh.get(args!.deviceId as string) };
    if (command === "companion_gateway_lsh_remote_set_grant") { lsh.get(args!.deviceId as string)!.granted = args!.granted as boolean; return; }
    if (command === "companion_gateway_service_set_grants") {
      const state = grants.get(args!.deviceId as string)!;
      if (state.permissionRevision !== args!.expectedPermissionRevision) throw { code: "permission-state-changed" };
      for (const change of args!.changes as any[]) {
        state.grants = state.grants.filter(grant => !(grant.grantClass === change.grantClass && grant.scopeKind === change.scopeKind && grant.scopeId === change.scopeId));
        if (change.enabled) state.grants.push({ grantClass: change.grantClass, scopeKind: change.scopeKind, scopeId: change.scopeId });
      }
      state.permissionRevision++; return;
    }
    if (command === "companion_gateway_service_set_grant") {
      const state = grants.get(args!.deviceId as string)!;
      state.grants = state.grants.filter(g => !(g.grantClass === args!.grantClass && g.scopeKind === args!.scopeKind && g.scopeId === args!.scopeId));
      if (args!.enabled) state.grants.push({ grantClass: args!.grantClass as any, scopeKind: args!.scopeKind as any, scopeId: args!.scopeId as string });
      state.permissionRevision++; return;
    }
    if (command === "companion_gateway_issue_pairing") return { pairingId: "ticket-" + calls.length, v: 1, name: "Fixture",
      instance: "fixture-instance", ip: "192.168.10.5", port: 48180, secret: "synthetic-only",
      fp: "a".repeat(64), qrSize: 21, qrPath: "M0 0h1v1h-1z", expiresAt: new Date(Date.now() + 60_000).toISOString() };
    if (command === "companion_gateway_cancel_pairing") return true;
    return {};
  });
  const store = createCompanionPresentationStore(client);
  return { store, calls, custom, grants, lsh, setDevices: (value: typeof devices) => devices = value, fail: () => failStatus = true };
}
const read = { grantClass: "content.read" as const, scopeKind: "vault" as const, scopeId: "vault-a" };
const writes = (calls: ReturnType<typeof fixture>["calls"]) => calls.filter(c => /set_grant|issue_pairing|cancel_pairing|_start|_stop|_restart|revoke/.test(c.command));

test("generic and duplicate device names use public, collision-safe identity without renaming data or inventing models", () => {
  const a = { ...device("device-123456aaaaaa"), label: "LuckyRay Mobile" };
  const b = { ...device("device-789012aaaaaa"), label: "LuckyRay Mobile" };
  const original = structuredClone([a, b]);
  const labelA = companionDeviceDisplayLabel(a, [a, b]);
  const labelB = companionDeviceDisplayLabel(b, [a, b]);
  assert.notEqual(labelA, labelB);
  assert.match(labelA, /^LuckyRay Mobile · [A-F0-9]+$/);
  assert.equal(companionDeviceDisplayLabel(a, [b, a]), labelA, "list order and online state cannot change identity");
  assert.deepEqual([a, b], original);
  assert.equal(companionDeviceDisplayLabel({ ...a, label: "My Pixel" }, [b]), "My Pixel");
});

test("one light status source; open is read-only, no audit/all grants while closed; online means connected and non-revoked", async () => {
  const f = fixture(); await f.store.refresh(); await Promise.all([f.store.refresh(), f.store.refresh()]);
  assert.equal(companionOnlineCount(f.store.getSnapshot()), 1);
  assert.equal(f.calls.some(c => /grants|audit|pairing/.test(c.command)), false);
  const close = f.store.open(Symbol("quick")); await drain();
  assert.equal(writes(f.calls).length, 0);
  assert.equal(f.calls.some(c => /audit/.test(c.command)), false);
  assert.equal(f.calls.filter(c => c.command === "companion_gateway_service_grants").every(c => c.args.deviceId === "a"), true);
  close(); f.calls.length = 0; await f.store.refresh();
  assert.equal(f.calls.some(c => /grants|audit/.test(c.command)), false);
  f.setDevices([{ ...device("a", true), revokedAt: "now" } as any, device("b")]); await f.store.refresh();
  assert.equal(companionOnlineCount(f.store.getSnapshot()), 0);
  f.fail(); await f.store.refresh(); assert.equal(companionOnlineCount(f.store.getSnapshot()), null); f.store.dispose();
});
test("stale status cannot keep icon online", async () => {
  const f = fixture(); await f.store.refresh();
  assert.equal(companionOnlineCount(f.store.getSnapshot(), Date.now() + 26_000), null); f.store.dispose();
});
test("device A late reply never paints B; loading is unknown not off", async () => {
  const f = fixture(); await f.store.refresh(); let resolve!: (s: CompanionServiceGrantState) => void;
  f.custom.set("companion_gateway_service_grants", args => args.deviceId === "a" ? new Promise(r => resolve = r) : services("vault-b"));
  f.store.selectDevice("a"); assert.equal(f.store.getSnapshot().services.a, undefined);
  f.store.selectDevice("b"); await drain(); resolve(services()); await drain();
  assert.equal(f.store.getSnapshot().selectedDeviceId, "b"); assert.equal(f.store.getSnapshot().services.b?.currentVault?.vaultId, "vault-b");
  assert.equal(f.store.getSnapshot().services.a, undefined); f.store.dispose();
});
test("permission writes are single-flight per exact device/class/scope and read back; no optimistic success", async () => {
  const f = fixture(); await f.store.refresh(); await f.store.readGrant("a");
  let release!: () => void;
  f.custom.set("companion_gateway_service_set_grants", async args => {
    await new Promise<void>(r => release = r);
    f.grants.get(args.deviceId)!.grants.push(read); f.grants.get(args.deviceId)!.permissionRevision++;
  });
  const first = f.store.toggleService("a", read); await drain();
  const second = f.store.toggleService("a", read); await drain();
  assert.equal(f.store.getSnapshot().services.a!.grants.length, 0);
  assert.equal(f.store.getSnapshot().grantBusy[companionGrantKey("a", read)], true);
  assert.equal(writes(f.calls).filter(c => /service_set/.test(c.command)).length, 1);
  release(); await Promise.all([first, second]);
  assert.deepEqual(f.store.getSnapshot().services.a!.grants, [read]); f.store.dispose();
});
test("A/B change before preflight completion cannot authorize A or B", async () => {
  const f = fixture(); await f.store.refresh(); await f.store.readGrant("a"); let resolve!: (s: CompanionServiceGrantState) => void;
  f.custom.set("companion_gateway_service_grants", args => args.deviceId === "a" ? new Promise(r => resolve = r) : services("vault-b"));
  const writing = f.store.toggleService("a", read); f.store.selectDevice("b"); resolve(services()); await writing; await drain();
  assert.equal(writes(f.calls).length, 0); f.store.dispose();
});
test("changed vault/revision denies stale action; unrelated vault grant preserved", async () => {
  const f = fixture(); await f.store.refresh(); await f.store.readGrant("a");
  f.grants.set("a", { ...services("vault-new", 2), grants: [{ ...read, scopeId: "other-vault" }] });
  await f.store.toggleService("a", read);
  assert.equal(writes(f.calls).length, 0); assert.equal(f.store.getSnapshot().services.a!.grants[0].scopeId, "other-vault");
  assert.ok(f.store.getSnapshot().grantErrors[companionGrantKey("a", read)]); f.store.dispose();
});
test("write failure retains confirmed state; LSH availability is independent of grant/online", async () => {
  const f = fixture(); await f.store.refresh(); await f.store.readGrant("a");
  f.custom.set("companion_gateway_service_set_grants", () => { throw { code: "denied" }; });
  await f.store.toggleService("a", read); assert.equal(f.store.getSnapshot().services.a!.grants.length, 0);
  assert.ok(f.store.getSnapshot().grantErrors[companionGrantKey("a", read)]);
  await f.store.toggleLsh("a"); assert.equal(f.store.getSnapshot().lsh.a?.granted, true);
  assert.equal(f.store.getSnapshot().lsh.a?.runtimeAvailable, false); f.store.dispose();
});
test("one pairing owner; stale close never cancels new ticket; close does not stop gateway/revoke", async () => {
  const f = fixture(); await f.store.refresh(); const a = Symbol("settings"), b = Symbol("quick");
  f.store.open(a, true); f.store.open(b); await drain();
  await f.store.issuePairing(a); const first = f.store.getSnapshot().pairing!.pairingId;
  await f.store.issuePairing(b); const second = f.store.getSnapshot().pairing!.pairingId;
  await f.store.releasePairing(a);
  assert.equal(f.store.getSnapshot().pairing!.pairingId, second);
  assert.equal(writes(f.calls).filter(c => /cancel_pairing/.test(c.command) && c.args.pairingId === first).length, 1);
  await f.store.releasePairing(b);
  assert.equal(f.store.getSnapshot().pairing, null);
  assert.equal(writes(f.calls).some(c => /_stop|revoke/.test(c.command)), false); f.store.dispose();
});
test("late issuance after presentation close is cancelled, not published", async () => {
  const f = fixture(); await f.store.refresh(); const owner = Symbol("quick"); f.store.open(owner); await drain(); let resolve!: (value: any) => void;
  f.custom.set("companion_gateway_issue_pairing", () => new Promise(r => resolve = r));
  const issued = f.store.issuePairing(owner); await drain(); await f.store.releasePairing(owner);
  resolve({ pairingId: "late", v: 1, name: "Fixture", instance: "fixture", ip: "192.168.1.2", port: 4000,
    secret: "fixture-only", fp: "a".repeat(64), qrSize: 21, qrPath: "", expiresAt: new Date(Date.now()+10000).toISOString() });
  await issued; assert.equal(f.store.getSnapshot().pairing, null);
  assert.ok(writes(f.calls).some(c => /cancel_pairing/.test(c.command) && c.args.pairingId === "late")); f.store.dispose();
});
test("new paired device selected and grants read; no automatic authorization", async () => {
  const f = fixture(); await f.store.refresh(); const owner = Symbol("quick"), close = f.store.open(owner); await drain();
  await f.store.issuePairing(owner); f.grants.set("new", services()); f.lsh.set("new", { granted: false, runtimeAvailable: false });
  f.setDevices([device("a"), device("new", true)]); await f.store.refresh(); await drain();
  assert.equal(f.store.getSnapshot().selectedDeviceId, "new"); assert.equal(f.store.getSnapshot().pairingState, "paired");
  assert.equal(f.store.getSnapshot().services.new!.grants.length, 0);
  assert.equal(writes(f.calls).some(c => /set_grant/.test(c.command)), false); close(); f.store.dispose();
});

test("light status polling cannot erase an owned pairing failure; closing clears only that presentation", async () => {
  const f = fixture(); await f.store.refresh(); const owner = Symbol("quick"); const close = f.store.open(owner); await drain();
  f.custom.set("companion_gateway_issue_pairing", () => { throw { code: "pairing-rate-limited" }; });
  await f.store.issuePairing(owner);
  await f.store.refresh(); await f.store.refresh();
  assert.deepEqual(f.store.getSnapshot().pairingError, { code: "pairing-rate-limited" });
  assert.equal(f.store.getSnapshot().pairing, null);
  assert.equal(f.calls.filter(c => c.command === "companion_gateway_issue_pairing").length, 1);
  close(); await drain(); assert.equal(f.store.getSnapshot().pairingError, null); f.store.dispose();
});

test("a slow grant read does not block light device status or create repeated grant reads", async () => {
  const f = fixture(); await f.store.refresh(); let resolve!: (value: CompanionServiceGrantState) => void;
  f.custom.set("companion_gateway_service_grants", args => args.deviceId === "a" ? new Promise(r => resolve = r) : services("vault-b"));
  const close = f.store.open(Symbol("quick")); await drain();
  f.setDevices([device("a", false), device("b", true)]);
  await f.store.refresh(); await f.store.refresh();
  assert.equal(companionOnlineCount(f.store.getSnapshot()), 1);
  assert.equal(f.store.getSnapshot().devices[0].connected, false);
  assert.equal(f.calls.filter(c => c.command === "companion_gateway_service_grants").length, 1);
  resolve(services()); await drain(); assert.equal(f.store.getSnapshot().grantLoading.a, false);
  close(); f.store.dispose();
});
test("expired ticket cancellation cannot erase a newer owner or publish its late failure", async () => {
  const f = fixture(); await f.store.refresh(); const a = Symbol("old"), b = Symbol("new");
  f.store.open(a); f.store.open(b); await drain(); await f.store.issuePairing(a);
  const first = f.store.getSnapshot().pairing!; first.expiresAt = new Date(Date.now() - 1000).toISOString();
  let reject!: (error: unknown) => void;
  f.custom.set("companion_gateway_cancel_pairing", args => args.pairingId === first.pairingId ? new Promise((_, r) => reject = r) : true);
  f.store.tick(); await f.store.issuePairing(b); const second = f.store.getSnapshot().pairing!.pairingId;
  reject({ code: "old-cancel-failed" }); await drain();
  assert.equal(f.store.getSnapshot().pairing!.pairingId, second);
  assert.equal(f.store.getSnapshot().pairingState, "waiting");
  assert.equal(f.store.getSnapshot().error, null); f.store.dispose();
});

test("expiry readiness belongs to the exact owner and begins only after old ticket cancellation", async () => {
  const f = fixture(); await f.store.refresh(); const owner = Symbol("quick"); const close = f.store.open(owner); await drain();
  await f.store.issuePairing(owner); const old = f.store.getSnapshot().pairing!;
  old.expiresAt = new Date(Date.now()-1000).toISOString(); let finish!: () => void;
  f.custom.set("companion_gateway_cancel_pairing", () => new Promise<void>(resolve => finish = resolve));
  f.store.tick(); const expiry = f.store.getSnapshot().pairingExpiry!;
  assert.equal(expiry.owner, owner); assert.equal(expiry.ready, false); assert.equal(f.store.getSnapshot().pairing, null);
  f.store.tick(); await f.store.refresh(); assert.equal(f.calls.filter(c => /issue_pairing/.test(c.command)).length, 1, "store itself never automatically issues");
  finish(); await drain(); assert.equal(f.store.getSnapshot().pairingExpiry!.ready, true);
  close(); await drain(); assert.equal(f.store.getSnapshot().pairingExpiry, null);
  f.store.dispose();
});

test("closing during expiry retirement withdraws renewal; late cancellation cannot reopen it", async () => {
  const f = fixture(); await f.store.refresh(); const owner = Symbol("quick"), close = f.store.open(owner); await drain();
  await f.store.issuePairing(owner); f.store.getSnapshot().pairing!.expiresAt = new Date(Date.now()-1000).toISOString();
  let finish!: () => void; f.custom.set("companion_gateway_cancel_pairing", () => new Promise<void>(resolve => finish = resolve));
  f.store.tick(); close(); finish(); await drain();
  assert.equal(f.store.getSnapshot().pairingExpiry, null); assert.equal(f.store.getSnapshot().pairingState, "idle");
  assert.equal(writes(f.calls).filter(c => /issue_pairing/.test(c.command)).length, 1); f.store.dispose();
});

test("failed expiry retirement cannot authorize a new ticket and retains its cause across status polls", async () => {
  const f = fixture(); await f.store.refresh(); const owner = Symbol("quick"), close = f.store.open(owner); await drain();
  await f.store.issuePairing(owner); f.store.getSnapshot().pairing!.expiresAt = new Date(Date.now()-1000).toISOString();
  f.custom.set("companion_gateway_cancel_pairing", () => { throw { code: "fixture-cancel-failed" }; });
  f.store.tick(); await drain(); await f.store.refresh(); f.store.tick();
  assert.equal(f.store.getSnapshot().pairingExpiry, null); assert.equal(f.store.getSnapshot().pairingOwner, owner);
  assert.deepEqual(f.store.getSnapshot().pairingError, { code: "fixture-cancel-failed" });
  assert.equal(writes(f.calls).filter(c => /issue_pairing/.test(c.command)).length, 1);
  f.custom.set("companion_gateway_cancel_pairing", () => true); close(); await drain(); f.store.dispose();
});
test("closing the new view while prior ticket cancellation waits cannot issue a hidden new QR", async () => {
  const f = fixture(); await f.store.refresh(); const a = Symbol("old"), b = Symbol("new");
  f.store.open(a); const closeB = f.store.open(b); await drain(); await f.store.issuePairing(a);
  let release!: () => void;
  f.custom.set("companion_gateway_cancel_pairing", () => new Promise<void>(r => release = r));
  const next = f.store.issuePairing(b); await drain(); closeB(); release(); await next;
  assert.equal(f.calls.filter(c => c.command === "companion_gateway_issue_pairing").length, 1);
  assert.equal(f.store.getSnapshot().pairing, null); assert.equal(f.store.getSnapshot().busy, "");
  f.store.dispose();
});
test("revocation before grant preflight resolves prevents either-device writes", async () => {
  const f = fixture(); await f.store.refresh(); await f.store.readGrant("a");
  let resolve!: (value: CompanionServiceGrantState) => void;
  f.custom.set("companion_gateway_service_grants", args => args.deviceId === "a" ? new Promise(r => resolve = r) : services("vault-b"));
  const write = f.store.toggleService("a", read);
  f.setDevices([{ ...device("a"), revokedAt: "revoked" } as any, device("b")]); await f.store.refresh();
  resolve(services()); await write;
  assert.equal(writes(f.calls).length, 0); assert.equal(f.store.getSnapshot().selectedDeviceId, "b"); f.store.dispose();
});
test("readback failure is unknown with a local cause, never rendered as a confirmed off grant", async () => {
  const f = fixture(); await f.store.refresh(); await f.store.readGrant("a"); let reads = 0;
  f.custom.set("companion_gateway_service_grants", () => {
    if (++reads > 1) throw { code: "fixture-readback-failed" };
    return services();
  });
  await f.store.toggleService("a", read);
  assert.equal(f.store.getSnapshot().services.a, undefined);
  assert.ok(f.store.getSnapshot().grantErrors[companionGrantKey("a", read)]);
  const count = writes(f.calls).length; await f.store.toggleService("a", read); assert.equal(writes(f.calls).length, count);
  f.store.dispose();
});
test("vault invalidation rejects an older same-device result and reads the new exact scope", async () => {
  const f = fixture(); await f.store.refresh(); const owner = Symbol("quick"); f.store.open(owner); await drain();
  let old!: (value: CompanionServiceGrantState) => void, reads = 0;
  f.custom.set("companion_gateway_service_grants", () => ++reads === 1 ? new Promise(r => old = r) : services("vault-new", 2));
  const pending = f.store.readGrant("a"); f.store.invalidateScopes(); await drain();
  assert.equal(f.store.getSnapshot().services.a!.currentVault!.vaultId, "vault-new");
  old(services("vault-old", 1)); await pending;
  assert.equal(f.store.getSnapshot().services.a!.currentVault!.vaultId, "vault-new");
  assert.equal(writes(f.calls).length, 0); f.store.dispose();
});


test("explicit trust sends one exact-scope batch, without deletion or LSH by default", async () => {
  const f = fixture(); await f.store.refresh(); await f.store.readGrant("a");
  const before = f.store.getSnapshot().services.a!;
  const changes = companionTrustChanges(before, { catalog: true, vault: true, catalogWrite: false, vaultWrite: false });
  assert.equal(await f.store.applyServiceChanges("a", changes, before), true);
  const batch = writes(f.calls).filter(call => call.command === "companion_gateway_service_set_grants");
  assert.equal(batch.length, 1); assert.equal(batch[0].args.expectedPermissionRevision, 1);
  assert.equal(batch[0].args.expectedCurrentVaultId, "vault-a"); assert.equal(batch[0].args.changes.length, 6);
  assert.equal(f.store.getSnapshot().services.a?.grants.some(grant => grant.grantClass === "content.write"), false);
  assert.equal(f.lsh.get("a")?.granted, false); f.store.dispose();
});
test("batch consent rejects changed vault/revision and does not reuse stale choices", async () => {
  const f = fixture(); await f.store.refresh(); await f.store.readGrant("a");
  const before = structuredClone(f.store.getSnapshot().services.a!);
  const changes = companionTrustChanges(before, { catalog: true, vault: true, catalogWrite: true, vaultWrite: true });
  f.grants.set("a", services("vault-b", 2));
  assert.equal(await f.store.applyServiceChanges("a", changes, before), false);
  assert.equal(writes(f.calls).length, 0); assert.deepEqual(f.grants.get("a")!.grants, []);
  assert.ok(f.store.getSnapshot().grantErrors["a:batch"]); f.store.dispose();
});
test("batch mutations are single-flight and keep confirmed state until readback", async () => {
  const f = fixture(); await f.store.refresh(); await f.store.readGrant("a");
  const before = f.store.getSnapshot().services.a!;
  let release!: () => void;
  f.custom.set("companion_gateway_service_set_grants", async args => {
    await new Promise<void>(resolve => release = resolve);
    f.grants.get("a")!.grants = args.changes.map(({ enabled, ...grant }: any) => grant);
    f.grants.get("a")!.permissionRevision++;
  });
  const first = f.store.applyServiceChanges("a", [{ ...read, enabled: true }], before); await drain();
  await f.store.toggleService("a", read); await f.store.toggleLsh("a");
  assert.equal(await f.store.applyServiceChanges("a", [{ ...read, enabled: true }], before), false);
  assert.equal(writes(f.calls).length, 1); assert.equal(f.store.getSnapshot().services.a?.grants.length, 0);
  release(); assert.equal(await first, true); assert.deepEqual(f.store.getSnapshot().services.a?.grants, [read]); f.store.dispose();
});
test("saved grants survive switch back and a new vault is denied; revoke old scope is exact", async () => {
  const f = fixture(); await f.store.refresh(); await f.store.readGrant("a");
  await f.store.toggleService("a", read);
  f.grants.get("a")!.currentVault = { vaultId: "vault-b", label: "B" }; f.store.invalidateScopes(); await f.store.readGrant("a");
  assert.deepEqual(f.store.getSnapshot().services.a?.grants, [read]);
  assert.equal(f.store.getSnapshot().services.a?.grants.some(grant => grant.scopeId === "vault-b"), false);
  f.grants.get("a")!.currentVault = { vaultId: "vault-a", label: "A" }; f.store.invalidateScopes(); await f.store.readGrant("a");
  assert.deepEqual(f.store.getSnapshot().services.a?.grants, [read]);
  f.grants.get("a")!.currentVault = { vaultId: "vault-b", label: "B" }; f.store.invalidateScopes(); await f.store.readGrant("a");
  await f.store.toggleService("a", read); assert.deepEqual(f.grants.get("a")!.grants, []); f.store.dispose();
});
test("revoked/forgotten device cannot receive a pending batch and new pairing gets no old rights", async () => {
  const f = fixture(); await f.store.refresh(); await f.store.readGrant("a");
  const before = f.store.getSnapshot().services.a!; let release!: (value: any) => void;
  f.custom.set("companion_gateway_service_grants", () => new Promise(resolve => release = resolve));
  const pending = f.store.applyServiceChanges("a", [{ ...read, enabled: true }], before);
  f.setDevices([device("new")]); await f.store.refresh(); release(before);
  assert.equal(await pending, false); assert.equal(writes(f.calls).length, 0);
  assert.equal(f.store.getSnapshot().services.new, undefined); f.store.dispose();
});

test("single toggle uses the atomic revision fence when another view revokes after preflight", async () => {
  const f = fixture(); await f.store.refresh(); await f.store.readGrant("a");
  const before = f.store.getSnapshot().services.a!.permissionRevision;
  f.custom.set("companion_gateway_service_set_grants", args => {
    f.grants.get("a")!.permissionRevision++;
    assert.equal(args.expectedPermissionRevision, before);
    assert.equal(args.changes.length, 1);
    if (f.grants.get("a")!.permissionRevision !== args.expectedPermissionRevision) throw { code: "permission-state-changed" };
    throw Error("stale write must not be admitted");
  });
  await f.store.toggleService("a", read);
  assert.deepEqual(f.grants.get("a")!.grants, []);
  assert.ok(f.store.getSnapshot().grantErrors[companionGrantKey("a", read)]); f.store.dispose();
});

test("late interface enumeration cannot overwrite newer address candidates", async () => {
  const f = fixture(); const close = f.store.open(Symbol("network")); await drain();
  let release!: (value: any) => void; let count = 0;
  const fresh = [{ interfaceId: "lan", address: "192.168.1.2", name: "Ethernet", prefixLength: 24 }];
  f.custom.set("companion_gateway_list_interfaces", () => ++count === 1 ? new Promise(resolve => release = resolve) : fresh);
  const old = f.store.refreshDetails(); await f.store.refreshDetails(); release([{ ...fresh[0], address: "192.168.1.99" }]); await old;
  assert.deepEqual(f.store.getSnapshot().interfaces, fresh); close(); f.store.dispose();
});


test("advanced open keeps its slow audit while light polls supersede only interfaces", async () => {
  const f = fixture(); let resolveAudit!: (rows: any[]) => void, interfacesRead = 0;
  const fresh = [{ interfaceId: "lan", address: "192.168.1.2", name: "Ethernet", prefixLength: 24 }];
  f.custom.set("companion_gateway_list_audit", () => new Promise(resolve => resolveAudit = resolve));
  f.custom.set("companion_gateway_list_interfaces", () => ++interfacesRead === 1 ? [{ ...fresh[0], address: "192.168.1.99" }] : fresh);
  const close = f.store.open(Symbol("advanced"), true); await drain();
  assert.ok(interfacesRead >= 2, "status refresh starts a newer interfaces-only read during advanced open");
  assert.deepEqual(f.store.getSnapshot().interfaces, fresh);
  assert.deepEqual(f.store.getSnapshot().audit, []);
  await f.store.refreshDetails(false);
  const audit = [{ action: "fixture", deviceId: "a", occurredAt: "2026-10-07T00:00:00Z", result: "ok" }];
  resolveAudit(audit); await drain();
  assert.deepEqual(f.store.getSnapshot().audit, audit);
  assert.deepEqual(f.store.getSnapshot().interfaces, fresh, "late advanced response cannot restore stale interfaces");
  await f.store.refresh(); await drain();
  assert.equal(f.calls.filter(call => call.command === "companion_gateway_list_audit").length, 1, "light refresh never polls audit");
  close(); f.store.dispose();
});
test("a newer advanced audit wins without being overwritten by its older response", async () => {
  const f = fixture(); const close = f.store.open(Symbol("advanced"), true); await drain();
  let release!: (rows: any[]) => void, reads = 0;
  const fresh = [{ action: "latest", deviceId: "a", occurredAt: "2026-10-07T00:00:00Z", result: "ok" }];
  f.custom.set("companion_gateway_list_audit", () => ++reads === 1 ? new Promise(resolve => release = resolve) : fresh);
  const old = f.store.refreshDetails(true); await f.store.refreshDetails(true);
  release([{ ...fresh[0], action: "stale" }]); await old;
  assert.deepEqual(f.store.getSnapshot().audit, fresh); close(); f.store.dispose();
});

test("background poll never republishes initial loading or grant-button busy states", async () => {
  const f = fixture(), first = f.store.refresh();
  assert.equal(f.store.getSnapshot().loading, true, "first status load remains visible");
  await first;
  const close = f.store.open(Symbol("quick")); await drain();
  const trace: Array<{ loading: boolean; grantLoading: boolean; grantBusy: boolean }> = [];
  const stop = f.store.subscribe(() => { const state = f.store.getSnapshot(); trace.push({ loading: state.loading, grantLoading: Boolean(state.grantLoading.a), grantBusy: Object.values(state.grantBusy).some(Boolean) }); });
  await f.store.refresh(); await drain();
  assert.ok(trace.every(state => !state.loading && !state.grantLoading && !state.grantBusy), JSON.stringify(trace));
  assert.equal(writes(f.calls).length, 0);
  stop(); close(); f.store.dispose();
});

test("background equal payloads retain projection identity and emit only freshness", async () => {
  const f = fixture(); const close = f.store.open(Symbol("quick")); await drain();
  const before = f.store.getSnapshot(); let notifications = 0;
  const stop = f.store.subscribe(() => notifications++);
  await f.store.refresh(); await drain();
  const after = f.store.getSnapshot();
  for (const key of ["status", "devices", "interfaces", "services", "lsh", "grantLoading", "grantErrors"] as const) assert.equal(after[key], before[key], key);
  assert.ok(notifications <= 1, `only the confirmed-at freshness timestamp may publish, got ${notifications}`);
  stop(); close(); f.store.dispose();
});

test("background read retains confirmed permissions while pending but exposes real read failure", async () => {
  const f = fixture(); await f.store.refresh(); await f.store.readGrant("a");
  const previous = f.store.getSnapshot().services.a; let reject!: (reason: unknown) => void;
  f.custom.set("companion_gateway_service_grants", () => new Promise((_, fail) => reject = fail));
  const pending = f.store.readGrant("a");
  assert.equal(f.store.getSnapshot().services.a, previous);
  assert.equal(f.store.getSnapshot().grantLoading.a, false);
  reject({ code: "permission-unavailable" }); await pending;
  assert.equal(f.store.getSnapshot().services.a, undefined);
  assert.equal((f.store.getSnapshot().grantErrors.a as any).code, "permission-unavailable");
  f.fail(); await f.store.refresh(); assert.equal(companionOnlineCount(f.store.getSnapshot()), null);
  assert.equal(f.store.getSnapshot().loading, false); f.store.dispose();
});

test("background poll does not swallow an explicit toggle and late pre-write data cannot overwrite readback", async () => {
  const f = fixture(); await f.store.refresh(); await f.store.readGrant("a");
  const previous = structuredClone(f.store.getSnapshot().services.a!); let release!: (value: CompanionServiceGrantState) => void, reads = 0;
  f.custom.set("companion_gateway_service_grants", () => ++reads === 1 ? new Promise(resolve => release = resolve) : structuredClone(f.grants.get("a")));
  const background = f.store.readGrant("a");
  const trace: boolean[] = []; const stop = f.store.subscribe(() => trace.push(Boolean(f.store.getSnapshot().grantBusy[companionGrantKey("a", read)])));
  await f.store.toggleService("a", read);
  assert.ok(trace.includes(true), "explicit user write retains its own busy indicator");
  assert.equal(f.store.getSnapshot().services.a?.grants.length, 1);
  release(previous); await background;
  assert.equal(f.store.getSnapshot().services.a?.grants.length, 1, "stale background data cannot resurrect the old revision");
  assert.equal(f.store.getSnapshot().services.a?.permissionRevision, previous.permissionRevision + 1);
  stop(); f.store.dispose();
});

test("background equality does not suppress real grant changes or status freshness", async () => {
  const f = fixture(); const originalNow = Date.now; let now = originalNow(); Date.now = () => now;
  try {
    const close = f.store.open(Symbol("quick")); await drain();
    for (let i = 0; i < 4; i++) { now += 10_000; await f.store.refresh(); await drain(); assert.equal(companionOnlineCount(f.store.getSnapshot(), now), 1); }
    const before = f.store.getSnapshot().services.a;
    f.grants.get("a")!.grants.push(read); f.grants.get("a")!.permissionRevision++;
    await f.store.refresh(); await drain();
    assert.notEqual(f.store.getSnapshot().services.a, before);
    assert.deepEqual(f.store.getSnapshot().services.a?.grants, [read]);
    now += 26_000; f.store.tick(); assert.equal(companionOnlineCount(f.store.getSnapshot(), now), null);
    close(); f.store.dispose();
  } finally { Date.now = originalNow; }
});

test("background details stop after close and disposed reads cannot publish", async () => {
  const f = fixture(); const close = f.store.open(Symbol("quick")); await drain();
  close(); f.calls.length = 0; await f.store.refresh(); await drain();
  assert.equal(f.calls.some(call => /service_grants|list_interfaces|list_audit/.test(call.command)), false);
  let release!: (value: any) => void;
  f.custom.set("companion_gateway_status", () => new Promise(resolve => release = resolve));
  const pending = f.store.refresh(); let published = 0; f.store.subscribe(() => published++);
  f.store.dispose(); release({ state: "running", generation: 1 }); await pending;
  assert.equal(published, 0);
});
