// Pure input-data gate. expectedHash/expectedBytes MUST come from a native
// admitted signed Candidate, not this JSON or a registry response. This helper
// does not construct an install token, run commands, download, or switch code.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { frozenPackageInputs, frozenLockedInputs } from "./dsh-frozen-inputs.mjs";
import { validateDshRuntimeAuthority, validateQualifiedDshRuntimeAuthority, frozenHostTemplate,
  validateDshFrozenClosure, buildPublishedDshRecords, reconcileLockedClosure } from "./dsh-supply-chain.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const invalid = () => { throw new Error("assembly-description-invalid"); };
const hex = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
function keys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !isDeepStrictEqual(Object.keys(value).sort(), expected.slice().sort())) invalid();
}
function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return Date.parse(value);
}

// Policy/config is host-owned. Only the lock's exact frozen dependency data is
// supplied by the signed qualification; no npmrc/workspace/pnpmfile is accepted.
export function qualifiedHostFiles(authority, lockfile) {
  return {
    "package.json": Buffer.from(JSON.stringify(frozenHostTemplate(authority.runtimePackage.version), null, 2) + "\n"),
    ".npmrc": Buffer.from("auto-install-peers=true\nengine-strict=true\nignore-scripts=true\nlink-workspace-packages=false\nsave-exact=true\nstrict-peer-dependencies=true\n"),
    "pnpm-lock.yaml": Buffer.from(lockfile),
    "pnpm-workspace.yaml": Buffer.from("packages: []\nminimumReleaseAge: 1440\nminimumReleaseAgeStrict: true\nminimumReleaseAgeIgnoreMissingTime: false\n"),
  };
}

export function validateQualifiedAssemblyDescription({ bytes, expectedHash, expectedBytes }) {
  // Hash/size authentication precedes JSON parsing or any qualification use.
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 2 * 1024 * 1024
      || bytes.length !== expectedBytes || !hex(expectedHash) || hash(bytes) !== expectedHash) invalid();
  const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (input.schema !== 2 || input.kind !== "official-npm-qualified-win-x64-v2") invalid();
  keys(input.qualification, ["authority", "lockfile", "dependencyAudit"]);
  const q = input.qualification;
  if (typeof q.lockfile !== "string" || Buffer.byteLength(q.lockfile) > 1024 * 1024
      || /(?:^|\n)\s*(?:patchedDependencies|overrides|packageExtensions|pnpmfile|onlyBuiltDependencies|ignoredBuiltDependencies|allowBuilds|registries):/u.test(q.lockfile)
      || /(?:^|\s)[!&*][A-Za-z]/u.test(q.lockfile)) invalid();
  const authority = validateQualifiedDshRuntimeAuthority(q.authority);
  // Lock data cannot smuggle new top-level pnpm policy or another importer.
  // The only variable importer data is the frozen peer-context reference.
  const top = q.lockfile.split("\n").filter(line => /^\S/u.test(line));
  if (!isDeepStrictEqual(top, ["lockfileVersion: '9.0'", "settings:", "importers:", "packages:", "snapshots:"])
      || !q.lockfile.startsWith("lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n")) invalid();
  const importer = q.lockfile.split("\nimporters:\n")[1].split("\npackages:\n")[0];
  const dependencies = Object.entries(frozenHostTemplate(authority.runtimePackage.version).dependencies);
  const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const expectedImporter = "^\\n  \\.:\\n    dependencies:\\n" + dependencies.map(([name, version]) =>
    `      ${name.startsWith("@") ? `'${escaped(name)}'` : escaped(name)}:\\n        specifier: ${escaped(version)}\\n        version: ${escaped(version)}(?:\\([A-Za-z0-9@/._():+-]+\\))?\\n`).join("") + "$";
  if (!new RegExp(expectedImporter, "u").test(importer)) invalid();
  const hostFiles = qualifiedHostFiles(authority, q.lockfile);
  validateDshFrozenClosure({ authority, hostPackage: JSON.parse(hostFiles["package.json"]),
    lockfile: hostFiles["pnpm-lock.yaml"], npmrc: hostFiles[".npmrc"].toString("utf8"), workspacePolicy: hostFiles["pnpm-workspace.yaml"] });
  if (!isDeepStrictEqual(reconcileLockedClosure({ lockfile: hostFiles["pnpm-lock.yaml"], stagedPackages: q.dependencyAudit.packages }), q.dependencyAudit.lockReconciliation)) invalid();
  const records = buildPublishedDshRecords({ authority, dependencyAudit: q.dependencyAudit });
  const projection = { ...input, schema: 1, kind: "official-npm-frozen-win-x64-v1" };
  delete projection.qualification;
  const packages = frozenPackageInputs(q.lockfile, q.dependencyAudit), locked = frozenLockedInputs(q.lockfile);
  if (!Array.isArray(input.packages) || input.packages.length !== packages.length
      || !Array.isArray(input.releaseTimes) || input.releaseTimes.length !== locked.length) invalid();
  projection.packages = input.packages.map((item, i) => {
    keys(item, ["name", "version", "bytes", "sha256"]);
    if (item.name !== packages[i].name || item.version !== packages[i].version) invalid();
    return { ...packages[i], bytes: item.bytes, sha256: item.sha256 };
  });
  projection.releaseTimes = input.releaseTimes.map((item, i) => {
    keys(item, ["name", "version", "publishedAt"]);
    if (item.name !== locked[i].name || item.version !== locked[i].version) invalid();
    return { ...locked[i], publishedAt: item.publishedAt };
  });
  const projectedBytes = Buffer.from(JSON.stringify(projection));
  validateFrozenAssemblyDescription({ bytes: projectedBytes, expectedHash: hash(projectedBytes), expectedBytes: projectedBytes.length,
    authority, lockfile: hostFiles["pnpm-lock.yaml"], dependencyAudit: q.dependencyAudit, hostFiles });
  if (input.packageCount !== authority.dependencyClosure.stagedPackageCount
      || input.releaseTimes.length !== authority.dependencyClosure.packageCount
      || input.finalLayout.fileCount !== authority.dependencyClosure.releaseLayout.fileCount) invalid();
  // The top-level runtime TGZ must be one of the exact acquired inputs.
  const runtime = input.packages.find(pkg => pkg.name === "@deepseek-ai/dsh" && pkg.version === authority.runtimePackage.version);
  if (!runtime || runtime.sha256 !== authority.runtimePackage.sha256 || runtime.bytes !== authority.runtimePackage.size) invalid();
  return { description: { ...projection, schema: 2, kind: input.kind }, authority, hostFiles, records };
}

export function validateFrozenAssemblyDescription({ bytes, expectedHash, expectedBytes, authority: inputAuthority,
  lockfile, dependencyAudit, hostFiles }) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 2 * 1024 * 1024
      || bytes.length !== expectedBytes || !hex(expectedHash) || hash(bytes) !== expectedHash) invalid();
  const authority = validateDshRuntimeAuthority(inputAuthority);
  const descriptor = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  keys(descriptor, ["schema", "kind", "runtimePackage", "node", "packageManager", "lockSha256", "hostFiles",
    "packageCount", "packageBytes", "packages", "finalLayout", "authorization", "releaseTimes", "releaseTimePolicy"]);
  if (descriptor.schema !== 1 || descriptor.kind !== "official-npm-frozen-win-x64-v1"
      || descriptor.authorization !== "UNSIGNED_MAINTAINER_INPUT_RECORD_NOT_INSTALL_AUTHORITY"
      || !isDeepStrictEqual(descriptor.runtimePackage, authority.runtimePackage)
      || !isDeepStrictEqual(descriptor.node, { ...authority.nodeRuntime, archiveBytes: 35424607 })
      || !isDeepStrictEqual(descriptor.packageManager, { ...authority.packageManager, archiveBytes: 4590455 })
      || descriptor.lockSha256 !== authority.dependencyClosure.sha256 || descriptor.lockSha256 !== hash(lockfile)
      || !isDeepStrictEqual(descriptor.finalLayout, authority.dependencyClosure.releaseLayout)) invalid();
  const configNames = ["package.json", ".npmrc", "pnpm-lock.yaml", "pnpm-workspace.yaml"];
  const expectedConfigs = configNames.map((path) => ({ path, sha256: hash(hostFiles[path]), bytes: hostFiles[path].length }));
  if (!isDeepStrictEqual(descriptor.hostFiles, expectedConfigs)) invalid();
  const packages = frozenPackageInputs(lockfile.toString("utf8"), dependencyAudit);
  if (!Array.isArray(descriptor.packages) || descriptor.packageCount !== packages.length || descriptor.packages.length !== packages.length) invalid();
  let packageBytes = 0;
  for (let i = 0; i < packages.length; i++) {
    const input = descriptor.packages[i];
    keys(input, [...Object.keys(packages[i]), "bytes", "sha256"]);
    const { bytes: count, sha256, ...identity } = input;
    if (!isDeepStrictEqual(identity, packages[i]) || !hex(sha256) || !Number.isSafeInteger(count)
        || count < 1 || count > 256 * 1024 * 1024) invalid();
    packageBytes += count;
    if (packageBytes > 1024 * 1024 * 1024) invalid();
  }
  if (descriptor.packageBytes !== packageBytes) invalid();
  const locked = frozenLockedInputs(lockfile.toString("utf8"));
  if (!Array.isArray(descriptor.releaseTimes) || descriptor.releaseTimes.length !== locked.length) invalid();
  keys(descriptor.releaseTimePolicy, ["minimumAgeMinutes", "strict", "ignoreMissingTime", "lockedVersionCount", "source", "acquiredAt"]);
  const policy = descriptor.releaseTimePolicy;
  const acquiredAt = timestamp(policy.acquiredAt);
  if (policy.minimumAgeMinutes !== 1440 || policy.strict !== true || policy.ignoreMissingTime !== false
      || policy.lockedVersionCount !== locked.length || policy.source !== "https://registry.npmjs.org/") invalid();
  for (let i = 0; i < locked.length; i++) {
    const item = descriptor.releaseTimes[i];
    keys(item, [...Object.keys(locked[i]), "publishedAt"]);
    const { publishedAt, ...identity } = item;
    if (!isDeepStrictEqual(identity, locked[i]) || timestamp(publishedAt) > acquiredAt) invalid();
  }
  return structuredClone(descriptor);
}
