import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertQrEnvelope,
  runCompanionV1ReferenceFlow,
} from "../protocol/companion-v1/reference-client.mjs";

const root = new URL("../protocol/companion-v1/", import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

test("manifest freezes only the implemented foundation routes and stable errors", () => {
  const manifest = readJson("manifest.json");
  assert.equal(manifest.protocolVersion, 1);
  assert.deepEqual(manifest.qrEnvelope.required, ["v", "name", "instance", "ip", "port", "secret", "fp"]);
  assert.deepEqual(manifest.routes.map((route) => [route.method, route.path]), [
    ["GET", "/v1/hello"],
    ["POST", "/v1/pair"],
    ["GET", "/v1/session"],
    ["GET", "/v1/events"],
  ]);
  assert.equal(manifest.errors.AUTH_RATE_LIMITED.status, 429);
  assert.equal(manifest.errors.AUTH_REVOKED.status, 401);
  assert.equal(manifest.errors["pairing-secret-invalid"].status, 401);
  assert.equal(manifest.errors["pairing-expired"].status, 410);
  assert.equal(manifest.errors["pairing-replayed"].status, 409);
  assert.equal(JSON.stringify(manifest).match(/material|knowledge|canvas|lightseek|attachment|file-sync|runs/gi), null);
});

test("golden QR is exact, v is mandatory, and aliases or extra segments are rejected", () => {
  const qr = readJson("fixtures/success/qr-envelope.json");
  assert.deepEqual(Object.keys(qr), ["v", "name", "instance", "ip", "port", "secret", "fp"]);
  assert.deepEqual(assertQrEnvelope(qr), qr);
  assert.throws(() => assertQrEnvelope({ ...qr, v: 2 }));
  assert.throws(() => assertQrEnvelope({ ...qr, lightseek: {} }));
  for (const ip of ["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.20"]) {
    assert.equal(assertQrEnvelope({ ...qr, ip }).ip, ip);
  }
  for (const ip of ["10.", "192.168.999.999-extra", "127.0.0.1", "0.0.0.0", "8.8.8.8", "172.32.0.1"]) {
    assert.throws(() => assertQrEnvelope({ ...qr, ip }), ip);
  }
  const schema = readJson("schemas/qr-envelope.schema.json");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.v.const, 1);
  const schemaIp = new RegExp(schema.properties.ip.pattern);
  assert.equal(schemaIp.test("192.168.1.20"), true);
  assert.equal(schemaIp.test("192.168.999.999-extra"), false);
});

test("reference flow pins TLS then proves hello, pair, session, heartbeat, revoke and old credential rejection", async () => {
  const qr = readJson("fixtures/success/qr-envelope.json");
  const hello = readJson("fixtures/success/hello.json");
  const pair = readJson("fixtures/success/pair-response.json");
  const session = readJson("fixtures/success/session-response.json");
  const revoked = readJson("fixtures/error/auth-revoked.json");
  const calls = [];
  let revokedNow = false;
  const transport = {
    async pin(fingerprint) {
      calls.push(["pin", fingerprint]);
      return fingerprint;
    },
    async request(request) {
      calls.push([request.method, request.path, request.headers || {}, request.body || null]);
      if (request.path === "/v1/hello") return { status: 200, body: hello };
      if (request.path === "/v1/pair") return { status: 200, body: pair };
      if (request.path === "/v1/session" && !revokedNow) return { status: 200, body: session };
      if (request.path === "/v1/session" && revokedNow) return revoked;
      throw new Error(`unexpected request ${request.method} ${request.path}`);
    },
    async openEvents(request) {
      calls.push(["WSS", request.path, request.headers]);
      if (revokedNow) return revoked;
      return { serverPingBytes: 8, pongEchoed: true };
    },
    async revoke(deviceId) {
      calls.push(["revoke", deviceId]);
      revokedNow = true;
      return { outcome: "revoked" };
    },
  };

  const result = await runCompanionV1ReferenceFlow({ envelope: qr, transport });
  assert.equal(result.deviceId, pair.deviceId);
  assert.equal(result.revokedEventReconnectRejected, true);
  assert.deepEqual(calls.map((call) => call[0]), ["pin", "GET", "POST", "GET", "WSS", "revoke", "GET", "WSS"]);
  assert.equal(calls[2][2]["content-type"], "application/json");
  assert.equal(calls[3][2].authorization, `Bearer ${pair.credential}`);
  assert.equal(calls[4][2].authorization, `Bearer ${pair.credential}`);
  assert.equal(calls[7][2].authorization, `Bearer ${pair.credential}`);
});

test("error fixtures remain finite and match the runtime-distinguishable statuses", () => {
  for (const [path, status, code] of [
    ["fixtures/error/pairing-invalid.json", 401, "pairing-secret-invalid"],
    ["fixtures/error/pairing-expired.json", 410, "pairing-expired"],
    ["fixtures/error/pairing-replayed.json", 409, "pairing-replayed"],
    ["fixtures/error/pairing-device-limit.json", 409, "pairing-device-limit"],
    ["fixtures/error/auth-rate-limited.json", 429, "AUTH_RATE_LIMITED"],
    ["fixtures/error/auth-revoked.json", 401, "AUTH_REVOKED"],
  ]) {
    const fixture = readJson(path);
    assert.equal(fixture.status, status);
    assert.equal(fixture.body.code, code);
    assert.equal(fixture.body.ok, false);
  }
});

test("handoff manifest and schemas are tied to the exact Desktop runtime seams", () => {
  const backend = readFileSync(new URL("../src-tauri/src/companion_gateway.rs", import.meta.url), "utf8");
  for (const [method, path] of [["GET", "/v1/hello"], ["POST", "/v1/pair"], ["GET", "/v1/session"], ["GET", "/v1/events"]]) {
    assert.match(backend, new RegExp(`\\(\"${method}\", \\"${path}\\"\\)`));
  }
  assert.match(backend, /pairing-expired"\s*\|\s*"pairing-generation-retired"\s*=>\s*410/);
  assert.match(backend, /pairing-replayed"\s*\|\s*"pairing-device-limit"\s*=>\s*409/);
  assert.match(backend, /"AUTH_RATE_LIMITED"\s*=>\s*429/);
  assert.match(backend, /QrCode::new\(payload\.as_bytes\(\)\)/);
  assert.doesNotMatch(backend, /api\.qrserver|chart\.googleapis|quickchart/i);
});
