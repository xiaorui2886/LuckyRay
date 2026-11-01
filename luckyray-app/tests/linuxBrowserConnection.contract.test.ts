import assert from "node:assert/strict";
import test from "node:test";
import { createLinuxBrowserConnectionClient, validateBrowserConnectionSnapshot } from "../src/core/services/linuxBrowserConnection.ts";

const origin = "chrome-extension://bckeanklmbjhjjomobmfkfjmeokdcfid";
const view = () => ({ session: "ab".repeat(16), revision: 1, extensions: [{ origin, configured: true, status: "pending", requestId: "cd".repeat(32), grantId: null, requestExpiresInSeconds: 299 }] });

test("Linux browser permissions reject incomplete and contradictory server states", () => {
  assert.deepEqual(validateBrowserConnectionSnapshot(view()), view());
  for (const change of [{ status: "approved" }, { requestId: null }, { requestExpiresInSeconds: 301 }, { status: "connected" }]) {
    const invalid = view(); Object.assign(invalid.extensions[0], change);
    assert.throws(() => validateBrowserConnectionSnapshot(invalid), /response-invalid/);
  }
  assert.throws(() => validateBrowserConnectionSnapshot({ ...view(), revision: -1 }), /response-invalid/);
});

test("Linux browser decision and revocation keep the observed request and grant identities", async () => {
  const calls: unknown[] = [];
  const client = createLinuxBrowserConnectionClient(async (command, args) => { calls.push({ command, args }); return view(); });
  await client.decide("cd".repeat(32), "approve");
  await client.revoke(origin, "ef".repeat(16));
  assert.deepEqual(calls, [
    { command: "linux_browser_connection_decide", args: { requestId: "cd".repeat(32), decision: "approve" } },
    { command: "linux_browser_connection_revoke", args: { origin, grantId: "ef".repeat(16) } },
  ]);
});

test("Linux browser permission writes are never retried after an unknown IPC outcome", async () => {
  let attempts = 0;
  const client = createLinuxBrowserConnectionClient(async () => { attempts += 1; throw new Error("response lost"); });
  await assert.rejects(client.decide("cd".repeat(32), "approve"), /response lost/);
  assert.equal(attempts, 1);
  await assert.rejects(client.revoke(origin, "ef".repeat(16)), /response lost/);
  assert.equal(attempts, 2);
});
