import test from "node:test";
import assert from "node:assert/strict";
import {
  canConnect,
  connectionLabel,
  isRunning,
  validTunnelId,
  safeErrorCode,
} from "../../../src/features/community/mcp/model.ts";
const status = {
  phase: "installed",
  configured: true,
  hasKey: true,
  authorized: true,
  grant: { expiresAt: 2000 },
  desktopReady: true,
  tunnelReady: true,
  lastWebCallAt: null,
};
test("connection requires both scopes, a key, a configured tunnel and a live grant", () => {
  assert.equal(canConnect(status, 1000), true);
  for (const change of [
    { authorized: false },
    { configured: false },
    { hasKey: false },
    { grant: null },
    { phase: "absent" },
    { updateAvailable: true },
    { phase: "starting" },
    { phase: "ready" },
    { phase: "reconnecting" },
    { grant: { expiresAt: 0 } },
  ])
    assert.equal(canConnect({ ...status, ...change }, 1000), false);
});
test("local readiness is never reported as verified web use", () => {
  assert.equal(connectionLabel({ ...status, phase: "ready" }), "webPending");
  assert.equal(
    connectionLabel({ ...status, phase: "ready", lastWebCallAt: 100 }),
    "ready",
  );
  assert.equal(
    connectionLabel({ ...status, phase: "ready", tunnelReady: false }),
    "stopped",
  );
  assert.equal(
    connectionLabel({ ...status, authorized: false, phase: "ready" }),
    "authorize",
  );
});
test("lifecycle and input boundaries", () => {
  assert.equal(isRunning("failed"), false);
  assert.equal(isRunning("reconnecting"), true);
  assert.equal(validTunnelId("tunnel_0123456789abcdef0123456789abcdef"), true);
  assert.equal(validTunnelId("tunnel_" + "g".repeat(32)), true);
  for (const value of [
    "x",
    "tunnel_../secret",
    "tunnel_a\nkey",
    " tunnel_12345678",
    "tunnel_" + "G".repeat(32),
    "tunnel_" + "g".repeat(31),
    "tunnel_" + "g".repeat(33),
    "key_" + "g".repeat(32),
  ])
    assert.equal(validTunnelId(value), false);
  assert.equal(safeErrorCode("secret sk-test https://url"), "operation-failed");
  assert.equal(safeErrorCode({ message: "credential" }), "operation-failed");
  assert.equal(safeErrorCode("target-not-running"), "target-not-running");
});
