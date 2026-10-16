import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rust = await readFile(new URL("../src-tauri/src/companion_gateway.rs", import.meta.url), "utf8");
const backend = await readFile(new URL("../src-tauri/src/backend/mod.rs", import.meta.url), "utf8");
const lib = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const cargo = await readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
const productionRust = rust.split(/#\[cfg\(test\)\]\r?\nmod tests/)[0];

test("companion gateway is one disabled-by-default app-owned lifecycle", () => {
  assert.match(rust, /pub\(crate\) struct CompanionGateway/);
  assert.match(rust, /GatewayStatus::Disabled/);
  assert.match(rust, /pub\(crate\) fn shutdown/);
  assert.match(rust, /stopping_generation/);
  assert.match(rust, /transition: Mutex<\(\)>/);
  assert.match(rust, /self\.stop_exclusive\(\)\?;\s*self\.start_recording_failure\(bind_address, port\)/);
  assert.match(rust, /pairing-generation-retired/);
  assert.match(lib, /mod companion_gateway;/);
  assert.match(
    lib,
    /let companion_gateway\s*=\s*companion_gateway::CompanionGateway::initialize\(Arc::clone\(&backend\)\);/,
  );
  assert.doesNotMatch(lib, /Arc::new\(companion_gateway::CompanionGateway::initialize/);
  assert.match(lib, /gateway\.shutdown\(\)/);
  assert.equal((productionRust.match(/require_main_caller\(&caller\)\?/g) ?? []).length, 10);
  assert.doesNotMatch(rust, /crate::local_transport|crate::dsh_host|dsh-mobile/i);
});

test("identity uses the Windows secret boundary and companion metadata stays in luckyray.db", () => {
  assert.match(rust, /CryptProtectData/);
  assert.match(rust, /CryptUnprotectData/);
  assert.match(rust, /companion-gateway-identity-v1\.dpapi/);
  assert.match(backend, /const SCHEMA_VERSION: u32 = 20;/);
  for (const table of ["companion_identity", "companion_device", "companion_security_audit"]) {
    assert.match(backend, new RegExp(`CREATE TABLE ${table}`));
  }
  assert.doesNotMatch(backend, /companion_.*(?:private_key|bearer|pairing_secret|authorization)/i);
});

test("foundation exposes only protocol-v1 identity pairing session and WSS shell", () => {
  for (const route of ["/v1/hello", "/v1/pair", "/v1/session", "/v1/events"]) {
    assert.match(rust, new RegExp(route.replaceAll("/", "\\/")));
  }
  assert.doesNotMatch(rust, /\/v1\/(?:assets|notes|sync|capture|ai|turns)/);
  assert.match(rust, /manual-permission-required/);
  assert.match(rust, /security-failure-rate-limited/);
  assert.match(rust, /MAX_HTTP_REQUEST_DURATION/);
  assert.match(rust, /RequestDeadlineReader/);
  assert.match(rust, /AUTH_RATE_LIMITED/);
  assert.match(rust, /AuthenticatedRequestBudget/);
  assert.match(rust, /LOCAL_TRANSPORT_PORT_START: u16 = 37418/);
  assert.match(rust, /authorization/);
  assert.match(rust, /strip_prefix\("Bearer "\)/);
  assert.doesNotMatch(productionRust, /\?token=|0\.0\.0\.0/);
});

test("TLS dependencies stay in-process and no second runtime product is introduced", () => {
  assert.match(cargo, /rustls/);
  assert.match(cargo, /rcgen/);
  assert.doesNotMatch(cargo, /dsh-mobile|companion.*(?:bin|daemon|proxy)/i);
});
