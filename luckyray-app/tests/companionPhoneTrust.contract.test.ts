import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createCompanionGatewayClient, createCompanionPairingSession, assertCanonicalPairingEnvelope } from "../src/core/services/companionGateway.ts";
import { companionGrantEnabled } from "../src/core/services/companionAccess.ts";

const grant = { grantClass: "content.read" as const, scopeKind: "vault" as const, scopeId: "future-saved-vault" };
test("Trusted UI effective switch applies to every scope and explicit off wins", () => {
  const base = { permissionRevision: 1, currentVault: null, grants: [], authorizationMode: "trusted" as const };
  assert.equal(companionGrantEnabled(base, grant), true);
  assert.equal(companionGrantEnabled({ ...base, serviceOverrides: [{ grantClass: "content.read", scopeKind: "vault" }] }, grant), false);
  assert.equal(companionGrantEnabled({ ...base, authorizationMode: "manual" }, grant), false);
  assert.equal(companionGrantEnabled({ ...base, authorizationMode: "manual", grants: [grant], serviceOverrides: [{ grantClass: "content.read", scopeKind: "vault" }] }, grant), true, "native effective manual rows can include exact manual-only exception");
});
test("Explicit pairing consent stays in local command, not QR or phone request", async () => {
  const calls: unknown[] = [];
  const client = createCompanionGatewayClient(async (command, args) => { calls.push({ command, args }); return {}; });
  await client.issuePairing(false, "trusted");
  await client.issuePairing();
  await client.setAuthorizationMode("phone", "trusted", 9);
  assert.deepEqual(calls, [
    { command: "companion_gateway_issue_pairing", args: { replaceExisting: false, authorizationMode: "trusted" } },
    { command: "companion_gateway_issue_pairing", args: { replaceExisting: false, authorizationMode: "manual" } },
    { command: "companion_gateway_set_authorization_mode", args: { deviceId: "phone", authorizationMode: "trusted", expectedPermissionRevision: 9 } },
  ]);
  assert.throws(() => assertCanonicalPairingEnvelope({ authorizationMode: "trusted" }));
});
test("Cancelled pending trust pairing is cancelled by exact ticket ID", async () => {
  let resolve!: (value: unknown) => void;
  const cancelled: unknown[] = [];
  const client = createCompanionGatewayClient(async (command, args) => {
    if (command === "companion_gateway_issue_pairing") return new Promise(r => { resolve = r; });
    cancelled.push(args); return true;
  });
  const session = createCompanionPairingSession(client), pending = session.issue(false, "trusted");
  await session.dispose(); resolve({ pairingId: "pending-trusted-ticket" });
  assert.equal(await pending, null);
  assert.deepEqual(cancelled, [{ pairingId: "pending-trusted-ticket" }]);
});
test("Both local pairing views require a choice and quick view has no auto-issue effect", () => {
  const quick = readFileSync(new URL("../src/features/settings/PhoneConnectionDialog.tsx", import.meta.url), "utf8");
  const settings = readFileSync(new URL("../src/features/settings/CompanionGatewayPanel.tsx", import.meta.url), "utf8");
  assert.match(quick, /PhoneAuthorizationChoice value=\{authorizationMode\}/);
  assert.match(settings, /PhoneAuthorizationChoice value=\{authorizationMode\}/);
  assert.doesNotMatch(quick, /preparedOnOpen|useEffect/);
  assert.match(quick, /useState<CompanionAuthorizationMode \| null>\(null\)/);
});
