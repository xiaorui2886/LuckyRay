import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile, mkdir, mkdtemp, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_INTERFACES, compatibilityDeclaration, validateCompatibility } from "./dsh-host-compatibility.mjs";
import { hostContract } from "./prepare-dsh-production-candidate.mjs";
import { ORIGIN, sha256, rawPublicKey, verifyEnvelope } from "./dsh-production-maintenance.mjs";
import { DSH_HOST_PROTOCOL, createDshHostProtocol, signCanonicalHostFrame } from "../src-tauri/dsh-host/luckyray-dsh-host.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const descriptorPath = process.env.DSH_QUALIFIED_NEW_DESCRIPTION;
assert.ok(descriptorPath, "Set the previously qualified genuine descriptor; no placeholder qualification is permitted");
const descriptor = await readFile(descriptorPath), qualification = JSON.parse(descriptor).qualification;
const contract = await hostContract();
function fixture(schema = 2) {
  const { interfaces, ...audit } = contract;
  const candidate = { schema, channel: "preview", runtimePackage: "@deepseek-ai/dsh", issuedAt: 100, expiresAt: 1000,
    ...audit, platform: "windows-x86_64", fromVersions: ["0.1.7-rc.2"], version: qualification.authority.runtimePackage.version,
    nodeSha256: qualification.authority.nodeRuntime.nodeExeSha256, entrySha256: qualification.dependencyAudit.entryPoint.fileSha256,
    artifactUrl: `${ORIGIN}descriptors/${sha256(descriptor)}.json`, artifactSha256: sha256(descriptor), artifactBytes: descriptor.length,
    closureSha256: "a".repeat(64), closureFileCount: qualification.authority.dependencyClosure.releaseLayout.fileCount,
    dataCompatibility: "no-migration", assembly: { schema: 2, kind: "official-npm-qualified-win-x64-v2", toolset: "node22.19.0-pnpm11.7.0-policy1" },
    ...(schema === 2 ? { compatibility: compatibilityDeclaration() } : {}) };
  const pair = generateKeyPairSync("ed25519"), key = rawPublicKey(pair.publicKey).toString("base64url");
  const envelopeFor = value => { const payload = Buffer.from(JSON.stringify(value));
    return Buffer.from(JSON.stringify({ payload: payload.toString("base64url"), signature: sign(null, payload, pair.privateKey).toString("base64url") })); };
  return { candidate, key, envelopeFor };
}

test("unrelated lib wiring and test edits change audit hashes but keep schema2 admission", async () => {
  const f = fixture(), source = await mkdtemp(join(tmpdir(), "luckyray-compat-source-"));
  const files = ["package.json", "config/dsh-host-compatibility.json", "src-tauri/dsh-host/luckyray-dsh-host.mjs",
    "src-tauri/src/dsh_host.rs", "src-tauri/src/lib.rs", "src-tauri/src/dsh_resource_broker.rs", "src/core/services/openInLightSeek.ts",
    "src/features/ai/DshNativeSurfacePage.tsx", "src/features/ai/LightSeekContentBrowser.tsx",
    "tests/openInLightSeek.contract.test.ts", "tests/dshNativeSurfaceImageIntent.contract.test.mjs"];
  for (const file of files) { await mkdir(dirname(join(source, file)), { recursive: true }); await cp(join(root, file), join(source, file)); }
  await writeFile(join(source, "src-tauri/src/lib.rs"), "\n// unrelated materials/notes integration fixture\n", { flag: "a" });
  await writeFile(join(source, "tests/openInLightSeek.contract.test.ts"), "\n// unrelated additional test fixture\n", { flag: "a" });
  const changed = await hostContract(source);
  assert.notEqual(changed.adapterFingerprint, contract.adapterFingerprint);
  assert.notEqual(changed.resourceGateSha256, contract.resourceGateSha256);
  assert.deepEqual(changed.interfaces, contract.interfaces);
  assert.equal(verifyEnvelope(f.envelopeFor(f.candidate), f.key, descriptor, changed, 500).schema, 2);
  changed.hostVersion = "1.9.9";
  assert.equal(verifyEnvelope(f.envelopeFor(f.candidate), f.key, descriptor, changed, 500).schema, 2);
});

test("range and genuine interface/capability mismatches refuse a correctly signed candidate", () => {
  const f = fixture();
  for (const change of [c => c.compatibility.adapterProtocol++, c => c.compatibility.resourceProtocol++,
    c => c.compatibility.requiredCapabilities.push("unsupported-v1"), c => c.compatibility.requiredCapabilities.push("resource-intents-v1"),
    c => c.compatibility.requiredCapabilities = [], c => c.compatibility.extra = true,
    c => c.compatibility.minimumHostVersion = "1.9.5", c => c.compatibility.maximumHostVersionExclusive = "1.9.4",
    c => c.compatibility.minimumHostVersion = "1.9.4-beta.1", c => c.compatibility = null, c => c.schema = 1]) {
    const candidate = structuredClone(f.candidate); change(candidate);
    assert.throws(() => verifyEnvelope(f.envelopeFor(candidate), f.key, descriptor, contract, 500));
  }
  for (const hostVersion of ["1.9.3", "2.0.0", "1.9.5-beta.1"]) {
    assert.throws(() => verifyEnvelope(f.envelopeFor(f.candidate), f.key, descriptor, { ...contract, hostVersion }, 500));
  }
});

test("new contract preserves signature, descriptor, platform, migration and expiry checks", () => {
  const f = fixture(), envelope = f.envelopeFor(f.candidate);
  const tampered = JSON.parse(envelope), changed = structuredClone(f.candidate);
  changed.compatibility.adapterProtocol++;
  tampered.payload = Buffer.from(JSON.stringify(changed)).toString("base64url");
  assert.throws(() => verifyEnvelope(Buffer.from(JSON.stringify(tampered)), f.key, descriptor, contract, 500), /signature-invalid/u);
  const badDescriptor = Buffer.from(descriptor); badDescriptor[badDescriptor.length - 5] ^= 1;
  assert.throws(() => verifyEnvelope(envelope, f.key, badDescriptor, contract, 500), /descriptor-binding-invalid/u);
  for (const change of [c => c.platform = "linux-x86_64", c => c.dataCompatibility = "migration",
    c => c.artifactSha256 = "0".repeat(64), c => c.nodeSha256 = "0".repeat(64), c => c.entrySha256 = "0".repeat(64)]) {
    const candidate = structuredClone(f.candidate); change(candidate);
    assert.throws(() => verifyEnvelope(f.envelopeFor(candidate), f.key, descriptor, contract, 500));
  }
  assert.throws(() => verifyEnvelope(envelope, f.key, descriptor, contract, 1001));
});

test("legacy signed payloads retain the exact host and audit byte restrictions", () => {
  const f = fixture(1), envelope = f.envelopeFor(f.candidate);
  assert.equal(verifyEnvelope(envelope, f.key, descriptor, contract, 500).schema, 1);
  for (const change of [c => c.hostVersion = "1.9.9", c => c.adapterFingerprint = "0".repeat(64), c => c.resourceGateSha256 = "0".repeat(64)]) {
    const changed = structuredClone(contract); change(changed);
    assert.throws(() => verifyEnvelope(envelope, f.key, descriptor, changed, 500), /legacy-host-binding-invalid/u);
  }
  const legacyClientFields = ["schema", "channel", "runtimePackage", "issuedAt", "expiresAt", "hostVersion", "adapterFingerprint", "platform",
    "fromVersions", "version", "nodeSha256", "entrySha256", "artifactUrl", "artifactSha256", "artifactBytes", "closureSha256",
    "closureFileCount", "dataCompatibility", "resourceGateSha256", "assembly"];
  assert.deepEqual(Object.keys(f.candidate).sort(), legacyClientFields.sort());
  assert.equal(Object.hasOwn(fixture(2).candidate, "compatibility"), true, "legacy deny_unknown_fields clients must reject schema2 without falling back");
});

test("interface declaration matches real authenticated host and resource protocol versions", async () => {
  const native = await readFile(join(root, "src-tauri/src/dsh_host.rs"), "utf8");
  const broker = await readFile(join(root, "src-tauri/src/dsh_resource_broker.rs"), "utf8");
  const resource = JSON.parse(await readFile(join(root, "src-tauri/dsh-host/luckyray-dsh-resource-tools/luckyray-dsh-resource-tools.json")));
  assert.equal(HOST_INTERFACES.adapterProtocol, DSH_HOST_PROTOCOL);
  assert.match(native, /UPDATE_ADAPTER_PROTOCOL: u64 = 1;[\s\S]*const PROTOCOL: u64 = UPDATE_ADAPTER_PROTOCOL;/u);
  assert.match(broker, /manifest.version != UPDATE_RESOURCE_PROTOCOL/u);
  assert.equal(HOST_INTERFACES.resourceProtocol, resource.version);
  assert.doesNotThrow(() => validateCompatibility(compatibilityDeclaration(), contract.hostVersion));
  const output = [], challenge = "a".repeat(64);
  let probes = 0;
  const host = createDshHostProtocol({ writeFrame: frame => output.push(frame), nativeProbe: async () => { probes++; return { sessionReady: true, turnAccepted: true, durationMs: 1 }; } });
  await host.accept(JSON.stringify({ type: "bootstrap", protocol: DSH_HOST_PROTOCOL, generation: 1, challenge }));
  assert.equal(output[0].type, "hello");
  const probe = { type: "probe", protocol: DSH_HOST_PROTOCOL, generation: 1, seq: 1, requestId: "probe-1" };
  probe.mac = signCanonicalHostFrame(challenge, "parent", probe);
  await host.accept(JSON.stringify(probe));
  assert.equal(probes, 1);
  await assert.rejects(host.accept(JSON.stringify({ type: "ping", protocol: 2, generation: 1, seq: 2, mac: "0".repeat(64) })));
  assert.equal(probes, 1);
});
