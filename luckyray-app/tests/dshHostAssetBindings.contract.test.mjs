import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const nativeHost = readFileSync(new URL("../src-tauri/src/dsh_host.rs", import.meta.url), "utf8");
const nativeRuntimeSeal = readFileSync(new URL("../src-tauri/src/dsh_runtime_seal.rs", import.meta.url), "utf8");
const assetRoot = new URL("../src-tauri/dsh-host/", import.meta.url);
const bindings = [
  ["HOST_SCRIPT_SHA256", "luckyray-dsh-host.mjs"],
  ["HOST_COMPAT_SCRIPT_SHA256", "luckyray-dsh-plugin-compat.mjs"],
  ["SURFACE_PLUGIN_SHA256", "luckyray-dsh-authenticated-webserver/index.mjs"],
  ["RESOURCE_PLUGIN_SHA256", "luckyray-dsh-resource-tools/index.mjs"],
  ["RESOURCE_MANIFEST_SHA256", "luckyray-dsh-resource-tools/luckyray-dsh-resource-tools.json"],
  ["SURFACE_PATCH_SHA256", "luckyray-dsh-native-surface.patch.yml"],
  ["SURFACE_STATE_PACKAGE_SHA256", "luckyray-dsh-native-surface-state/package.json"],
  ["SURFACE_STATE_CLIENT_SHA256", "luckyray-dsh-native-surface-state/client.js"],
  ["LIGHTSEEK_UI_PACKAGE_SHA256", "luckyray-dsh-lightseek-ui/package.json"],
  ["LIGHTSEEK_UI_CLIENT_SHA256", "luckyray-dsh-lightseek-ui/client.js"],
  ["LIGHTSEEK_UI_BACKGROUND_SHA256", "luckyray-dsh-lightseek-ui/lightseek-cosmic-home.webp", "binary"],
  ["PROVIDER_EXPORT_SHA256", "luckyray-dsh-authenticated-webserver/luckyray-dsh-provider-export.mjs"],
  ["CARRIER_PACKAGE_SHA256", "luckyray-dsh-authenticated-webserver/package.json"],
  ["RESOURCE_PACKAGE_SHA256", "luckyray-dsh-resource-tools/package.json"],
];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
function pin(name) {
  const match = nativeHost.match(new RegExp(`const ${name}: &str =\\s*"([a-f0-9]{64})";`));
  assert.ok(match, `missing Rust asset pin: ${name}`);
  return match[1];
}

// Portable preflight for the exact Rust hash_normalized_host_script byte
// contract. It checks tracked package inputs, not installed-runtime admission,
// stable Win32 handles, native process startup or signatures.
function normalizedDigest(bytes) {
  assert.ok(bytes.length <= 128 * 1024, "native host asset exceeds the Rust size bound");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const normalized = text.replaceAll("\r\n", "\n");
  assert.equal(normalized.includes("\r"), false, "bare carriage return is rejected by Rust");
  return sha256(Buffer.from(normalized, "utf8"));
}

for (const [name, path, kind] of bindings) {
  test(`native asset pin matches the packaged source: ${name}`, () => {
    const bytes = readFileSync(new URL(path, assetRoot));
    assert.equal(kind === "binary" ? sha256(bytes) : normalizedDigest(bytes), pin(name), path);
  });
}

// The runtime descriptor also verifies four compile-time record seals before
// any preload can start. A generated closure/audit change must update these
// exact pins as well as the Node staging authority; host/client pins alone do
// not cover this admission path.
for (const [name, path] of [
  ["AUTHORITY", "runtime-authority.json"],
  ["AUDIT", "records/dependency-audit.json"],
  ["LAUNCH", "records/launch-manifest.json"],
  ["RUNTIME", "records/runtime-manifest.json"],
]) {
  test(`native embedded runtime record pin matches generated source: ${name}`, () => {
    const expected = nativeRuntimeSeal.match(new RegExp(`const ${name}_SHA256: &str =\\s*"([a-f0-9]{64})";`))?.[1];
    assert.ok(expected, `missing production record pin: ${name}`);
    assert.ok(nativeRuntimeSeal.includes(`include_bytes!("../../dsh-host/${path}")`));
    const bytes = readFileSync(new URL(`../dsh-host/${path}`, import.meta.url));
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    assert.equal(text.startsWith("\uFEFF"), false, "Rust rejects a record BOM");
    const normalized = text.replaceAll("\r\n", "\n");
    assert.equal(normalized.includes("\r"), false, "Rust rejects bare record CR");
    assert.equal(sha256(Buffer.from(normalized)), expected, path);
    assert.notEqual(sha256(Buffer.from(normalized + "\n")), expected, "unbound record changes remain rejected");
  });
}

test("the packaged dsh-host directory is the asset authority and build checks every pinned asset", () => {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  assert.equal(config.bundle.resources["dsh-host/"], "dsh-host/");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["test:dsh-host-assets"], "node --test tests/dshHostAssetBindings.contract.test.mjs");
  assert.ok(pkg.scripts.build.startsWith("npm run test:dsh-host-assets && "));
  const nativePins = [...nativeHost.matchAll(/^const ([A-Z_]+_SHA256): &str =/gm)].map(match => match[1]).sort();
  assert.deepEqual(bindings.map(([name]) => name).sort(), nativePins);
  assert.match(nativeHost, /const MAX_HOST_SCRIPT_BYTES: usize = 128 \* 1024;/);
  assert.match(nativeHost, /let normalized = source\.replace\("\\r\\n", "\\n"\);/);
  assert.match(nativeHost, /if normalized\.contains\('\\r'\) \{/);
});

test("resource plugin CRLF is accepted but changed bytes and the previous pin are rejected", () => {
  const bytes = readFileSync(new URL("luckyray-dsh-resource-tools/index.mjs", assetRoot));
  const lf = bytes.toString("utf8").replaceAll("\r\n", "\n");
  const expected = pin("RESOURCE_PLUGIN_SHA256");
  assert.equal(normalizedDigest(Buffer.from(lf.replaceAll("\n", "\r\n"))), expected);
  assert.notEqual(normalizedDigest(Buffer.concat([bytes, Buffer.from("\n// unbound mutation\n")])), expected);
  assert.notEqual(normalizedDigest(bytes), "9a63a89b68856d5510ce515e1f3a4f450d26c392f6272a1f5f892526dd2436e7");
  assert.throws(() => normalizedDigest(Buffer.from("bare\rcarriage return")), /bare carriage return/);
  assert.throws(() => normalizedDigest(Buffer.from([0xff])), /encoded data was not valid/);
  assert.throws(() => normalizedDigest(Buffer.alloc(128 * 1024 + 1)), /size bound/);
});
