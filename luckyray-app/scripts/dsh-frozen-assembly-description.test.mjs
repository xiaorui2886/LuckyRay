import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { validateFrozenAssemblyDescription, validateQualifiedAssemblyDescription, qualifiedHostFiles } from "./dsh-frozen-assembly-description.mjs";
import { validateDshRuntimeAuthority, validateQualifiedDshRuntimeAuthority, qualifiedNodeToolset } from "./dsh-supply-chain.mjs";
import { frozenPackageInputs, frozenLockedInputs } from "./dsh-frozen-inputs.mjs";
const root = new URL("../dsh-host/", import.meta.url);
const authority = JSON.parse(await readFile(new URL("runtime-authority.json", root), "utf8"));
const dependencyAudit = JSON.parse(await readFile(new URL("records/dependency-audit.json", root), "utf8"));
const hostFiles = {};
for (const name of ["package.json", ".npmrc", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) hostFiles[name] = await readFile(new URL(name, root));
const lockfile = hostFiles["pnpm-lock.yaml"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Synthetic schema-only data; never fetched, installed, or claimed as official bytes.
const fixture = {
  schema: 1, kind: "official-npm-frozen-win-x64-v1", runtimePackage: authority.runtimePackage,
  node: { ...authority.nodeRuntime, archiveBytes: 37754834 }, packageManager: { ...authority.packageManager, archiveBytes: 4590455 },
  lockSha256: hash(lockfile), hostFiles: Object.entries(hostFiles).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })),
  packages: frozenPackageInputs(lockfile.toString("utf8"), dependencyAudit).map((pkg) => ({ ...pkg, bytes: 1, sha256: "a".repeat(64) })),
  packageCount: 593, packageBytes: 593, finalLayout: authority.dependencyClosure.releaseLayout,
  authorization: "UNSIGNED_MAINTAINER_INPUT_RECORD_NOT_INSTALL_AUTHORITY",
  releaseTimes: frozenLockedInputs(lockfile.toString("utf8")).map((pkg) => ({ ...pkg, publishedAt: "2026-09-01T00:00:00.000Z" })),
  releaseTimePolicy: { minimumAgeMinutes: 1440, strict: true, ignoreMissingTime: false, lockedVersionCount: 665,
    source: "https://registry.npmjs.org/", acquiredAt: "2026-09-29T00:00:00.000Z" },
};
function verify(value, overrides = {}) {
  const bytes = Buffer.from(JSON.stringify(value));
  return validateFrozenAssemblyDescription({ bytes, expectedHash: hash(bytes), expectedBytes: bytes.length,
    authority, dependencyAudit, lockfile, hostFiles, ...overrides });
}
test("bounded description is data only, and binds the entire frozen input set", () => {
  assert.equal(verify(fixture).packages.length, 593); assert.equal(verify(fixture).releaseTimes.length, 665);
});
test("changed bytes or pointer size/hash are rejected before use", () => {
  assert.throws(() => verify(fixture, { expectedHash: "b".repeat(64) }));
  assert.throws(() => verify(fixture, { expectedBytes: 1 }));
});
test("commands, arbitrary sources, missing/extra/duplicate packages, budgets and gate changes fail", () => {
  const mutations = [
    (d) => { d.command = "execute"; }, (d) => { d.node.archive = "https://example.com/node.zip"; },
    (d) => { d.packages[0].url = "https://example.com/pkg.tgz"; }, (d) => { d.packages[0].version = "latest"; },
    (d) => { d.packages.pop(); }, (d) => { d.packages[1] = d.packages[0]; },
    (d) => { d.packages[0].bytes = 256 * 1024 * 1024 + 1; }, (d) => { d.packageBytes++; },
    (d) => { d.lockSha256 = "0".repeat(64); }, (d) => { d.finalLayout.contentSha256 = "0".repeat(64); },
    (d) => { d.hostFiles[0].path = "../../config"; }, (d) => { d.packages[0].nativeArtifacts = []; },
    (d) => { d.releaseTimes.pop(); }, (d) => { d.releaseTimes[0].publishedAt = "2026-02-30T00:00:00.000Z"; },
    (d) => { d.releaseTimePolicy.strict = false; }, (d) => { d.releaseTimePolicy.minimumAgeMinutes = 0; },
  ];
  // Pick a real native-bearing entry for the native-evidence removal mutation.
  mutations[11] = (d) => { d.packages.find((pkg) => pkg.nativeArtifacts.length).nativeArtifacts = []; };
  for (const mutate of mutations) { const d = structuredClone(fixture); mutate(d); assert.throws(() => verify(d)); }
});
test("genuine acquired record validates when explicitly supplied, without network or installation", { skip: !process.env.DSH_OFFICIAL_INPUTS_RECORD }, async () => {
  const bytes = await readFile(process.env.DSH_OFFICIAL_INPUTS_RECORD);
  assert.equal(validateFrozenAssemblyDescription({ bytes, expectedHash: hash(bytes), expectedBytes: bytes.length,
    authority, dependencyAudit, lockfile, hostFiles }).packageBytes, 153832468);
});

const dynamic = { ...structuredClone(fixture), schema: 2, kind: "official-npm-qualified-win-x64-v2",
  qualification: { authority, lockfile: lockfile.toString("utf8"), dependencyAudit },
  hostFiles: Object.entries(qualifiedHostFiles(authority, lockfile)).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })),
  packages: fixture.packages.map(({ name, version }) => ({ name, version, bytes: name === "@deepseek-ai/dsh" ? authority.runtimePackage.size : 1,
    sha256: name === "@deepseek-ai/dsh" ? authority.runtimePackage.sha256 : "a".repeat(64) })),
  releaseTimes: fixture.releaseTimes.map(({ name, version, publishedAt }) => ({ name, version, publishedAt })),
};
dynamic.packageBytes = dynamic.packages.reduce((sum, pkg) => sum + pkg.bytes, 0);
function verifyDynamic(value, overrides = {}) {
  const bytes = Buffer.from(JSON.stringify(value));
  return validateQualifiedAssemblyDescription({ bytes, expectedHash: hash(bytes), expectedBytes: bytes.length, ...overrides });
}
test("signed qualification projection retains baseline seal and generates fixed policy, never imports config", () => {
  const result = verifyDynamic(dynamic);
  assert.equal(result.authority.runtimePackage.version, "0.2.2-rc.1");
  assert.equal(result.records.dependencyAudit.entryPoint.fileSha256, dependencyAudit.entryPoint.fileSha256);
  assert.deepEqual(result.hostFiles, qualifiedHostFiles(authority, lockfile));
  assert.throws(() => { result.authority.policy.allowInstallScripts = true; }, TypeError);
  const unbranded = structuredClone(authority); unbranded.runtimePackage.version = "0.1.5-rc.2";
  assert.throws(() => validateDshRuntimeAuthority(unbranded), /authority-invalid/u);
});
test("Node 24 qualification accepts only its complete pinned bootstrap and preserves Node 22", () => {
  const next = structuredClone(dynamic);
  const node24 = next.qualification.authority.nodeRuntime;
  Object.assign(node24, { version: "24.22.2",
    archive: "https://nodejs.org/dist/v24.22.2/node-v24.22.2-win-x64.zip",
    archiveSha256: "ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2",
    nodeExeSha256: "1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9",
    licenseSha256: "ed34dd8e3f0a78dbaf00d0444ce8e285b015b765379c2e17880455f70370f8e9" });
  next.qualification.authority.dependencyClosure.nodeVersion = node24.version;
  next.node = { ...node24, archiveBytes: 37_754_834 };
  next.hostFiles = Object.entries(qualifiedHostFiles(next.qualification.authority, lockfile))
    .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) }));
  const result = verifyDynamic(next);
  assert.equal(result.authority.nodeRuntime.version, "24.22.2");
  assert.equal(JSON.parse(result.hostFiles["package.json"]).engines.node, "=24.22.2");
  assert.equal(qualifiedNodeToolset(result.authority.nodeRuntime).name, "node24.22.2-pnpm11.7.0-policy1");
  // Exercise the old pinned Node identity using a synthetic qualification;
  // this does not assert that the DSH 0.2.2 package itself runs on Node 22.
  const legacy = structuredClone(dynamic);
  Object.assign(legacy.qualification.authority.nodeRuntime, {
    version: "22.19.0",
    archive: "https://nodejs.org/dist/v22.19.0/node-v22.19.0-win-x64.zip",
    archiveSha256: "ea3fad0e67a991d8477d8c01344b56e69c676ccb733f065b22436994b1253f86",
    nodeExeSha256: "995a3fb3cefad590cd3f4b321532a4b9582fb9c6575320ed2e3e894caac3e362",
    licenseSha256: "339c50294da6a84322dcbe7285b57b248123bd4d9e37a2f72d68d5abf2574783",
  });
  legacy.qualification.authority.dependencyClosure.nodeVersion = "22.19.0";
  legacy.node = { ...legacy.qualification.authority.nodeRuntime, archiveBytes: 35_424_607 };
  legacy.hostFiles = Object.entries(qualifiedHostFiles(legacy.qualification.authority, lockfile))
    .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) }));
  const oldResult = verifyDynamic(legacy);
  assert.equal(qualifiedNodeToolset(oldResult.authority.nodeRuntime).name, "node22.19.0-pnpm11.7.0-policy1");
  assert.equal(oldResult.authority.nodeRuntime.version, "22.19.0");
  assert.throws(() => validateDshRuntimeAuthority(structuredClone(oldResult.authority)), /authority-invalid/u);
  for (const mutate of [
    d => { d.qualification.authority.nodeRuntime.archiveSha256 = "0".repeat(64); },
    d => { d.qualification.authority.nodeRuntime.nodeExeSha256 = "0".repeat(64); },
    d => { d.qualification.authority.nodeRuntime.licenseSha256 = "0".repeat(64); },
    d => { d.qualification.authority.nodeRuntime.archive = "https://other.example/node.zip"; },
    d => { d.qualification.authority.dependencyClosure.nodeVersion = "22.19.0"; },
    d => { d.node.archiveBytes++; },
    d => { d.qualification.authority.policy.allowInstallScripts = true; },
  ]) { const bad = structuredClone(next); mutate(bad); assert.throws(() => verifyDynamic(bad)); }
  assert.throws(() => validateQualifiedDshRuntimeAuthority({ ...authority, nodeRuntime: { ...node24, version: "24.22.3" } }));
});
test("qualification rejects policy/script/tool injection, bad binding, extra/missing/duplicate inputs and audit changes", () => {
  const changes = [
    d => { d.command = "run"; }, d => { d.qualification.npmrc = "ignore-scripts=false"; },
    d => { d.qualification.authority.policy.allowInstallScripts = true; },
    d => { d.qualification.authority.packageManager.version = "12.0.0"; },
    d => { d.qualification.authority.nodeRuntime.version = "24.0.0"; },
    d => { d.qualification.authority.packageManager.installPolicy.minimumReleaseAge = 0; },
    d => { d.qualification.authority.runtimePackage.tarball = "https://other.example/runtime.tgz"; },
    d => { d.qualification.lockfile += "\noverrides:\n  bad: latest\n"; },
    d => { d.qualification.lockfile += "\nunknownPolicy: true\n"; },
    d => { d.qualification.lockfile = d.qualification.lockfile.replace("autoInstallPeers: true", "autoInstallPeers: false"); },
    d => { d.qualification.lockfile = d.qualification.lockfile.replace("\npackages:\n", "\n  other:\n    dependencies: {}\n\npackages:\n"); },
    d => { d.qualification.dependencyAudit.packages.pop(); },
    d => { d.packages.pop(); }, d => { d.packages.push(d.packages[0]); }, d => { d.packages[1] = d.packages[0]; },
    d => { d.packages[0].url = "https://other.example/input.tgz"; },
    d => { d.packages.find(pkg => pkg.name === "@deepseek-ai/dsh").sha256 = "0".repeat(64); },
    d => { d.releaseTimes.pop(); }, d => { d.hostFiles[0].sha256 = "0".repeat(64); },
  ];
  for (const change of changes) { const next = structuredClone(dynamic); change(next); assert.throws(() => verifyDynamic(next)); }
  assert.throws(() => verifyDynamic(dynamic, { expectedHash: "0".repeat(64) }));
  assert.throws(() => verifyDynamic(dynamic, { expectedBytes: 1 }));
});
test("two different genuine qualification datasets use the same parser/templates", {
  skip: !process.env.DSH_QUALIFIED_OLD_DESCRIPTION || !process.env.DSH_QUALIFIED_NEW_DESCRIPTION,
}, async () => {
  const results = [];
  for (const path of [process.env.DSH_QUALIFIED_OLD_DESCRIPTION, process.env.DSH_QUALIFIED_NEW_DESCRIPTION]) {
    const bytes = await readFile(path);
    results.push(validateQualifiedAssemblyDescription({ bytes, expectedHash: hash(bytes), expectedBytes: bytes.length }));
  }
  assert.deepEqual(results.map(result => result.authority.runtimePackage.version), [
    process.env.DSH_QUALIFIED_OLD_VERSION ?? "0.1.5-rc.2",
    process.env.DSH_QUALIFIED_NEW_VERSION ?? "0.1.7-rc.2",
  ]);
  assert.notEqual(results[0].authority.dependencyClosure.sha256, results[1].authority.dependencyClosure.sha256);
  assert.notEqual(results[0].records.dependencyAudit.entryPoint.fileSha256, results[1].records.dependencyAudit.entryPoint.fileSha256);
});
