// Engineering proof: populate an EMPTY pnpm store exclusively from previously
// hash-checked tarballs, then install the ORIGINAL authenticated lock offline.
// Public pnpm fetch uses a bounded local cache, never a modified lock/store.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, copyFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { frozenPackageInputs, frozenLockedInputs } from "./dsh-frozen-inputs.mjs";
import { openFrozenCacheRelay } from "./dsh-frozen-cache-relay.mjs";
import { auditNpmTarball } from "./dsh-npm-tar-policy.mjs";
import { validateFrozenAssemblyDescription } from "./dsh-frozen-assembly-description.mjs";
import { validateDshRuntimeAuthority, validateDshFrozenClosure, verifyExtractedPnpmPackage,
  projectPortableDshReleaseLayout, verifyPortableStagedDshRuntime, probeDshNativeModules } from "./dsh-supply-chain.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function main() {
  const [repoArg, acquiredArg, bootstrapArg, outputArg, recordArg, recoveryArg] = process.argv.slice(2);
  if (!outputArg) throw new Error("usage: repo acquisition bootstrap new-output-directory");
  const repo = resolve(repoArg), acquired = resolve(acquiredArg), bootstrap = resolve(bootstrapArg), output = resolve(outputArg);
  await mkdir(output);
  const authorityFile = join(repo, "dsh-host/runtime-authority.json");
  const authority = validateDshRuntimeAuthority(JSON.parse(await readFile(authorityFile, "utf8")));
  const audit = JSON.parse(await readFile(join(repo, "dsh-host/records/dependency-audit.json"), "utf8"));
  const lock = await readFile(join(repo, "dsh-host/pnpm-lock.yaml"));
  const hostPackage = JSON.parse(await readFile(join(repo, "dsh-host/package.json"), "utf8"));
  const npmrc = await readFile(join(repo, "dsh-host/.npmrc"), "utf8");
  const workspacePolicy = await readFile(join(repo, "dsh-host/pnpm-workspace.yaml"));
  validateDshFrozenClosure({ authority, hostPackage, lockfile: lock, npmrc, workspacePolicy });
  const expected = frozenPackageInputs(lock.toString("utf8"), audit);
  const descriptionBytes = await readFile(recordArg ? resolve(recordArg) : join(acquired, "official-inputs.json"));
  const hostFiles = {};
  for (const name of ["package.json", ".npmrc", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) hostFiles[name] = await readFile(join(repo, "dsh-host", name));
  // Maintainer self-pointer validates schema/reproducibility only. Ordinary
  // client must supply hash/size from an admitted native signed Candidate.
  const record = validateFrozenAssemblyDescription({ bytes: descriptionBytes, expectedHash: sha256(descriptionBytes), expectedBytes: descriptionBytes.length,
    authority, lockfile: lock, dependencyAudit: audit, hostFiles });
  const inputs = record.packages;
  const locked = frozenLockedInputs(lock.toString("utf8"));
  if (record.releaseTimes?.length !== locked.length || record.releaseTimes.some((pkg, i) =>
    pkg.name !== locked[i].name || pkg.version !== locked[i].version || pkg.integrity !== locked[i].integrity || pkg.url !== locked[i].url)) throw new Error("local-release-time-identity-invalid");
  if (inputs.length !== expected.length) throw new Error("local-input-count-invalid");
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    if (input.name !== expected[i].name || input.version !== expected[i].version || input.url !== expected[i].url || input.integrity !== expected[i].integrity) throw new Error("local-input-identity-invalid");
    const bytes = await readFile(join(acquired, "tarballs", `${input.sha256}.tgz`));
    if (bytes.length !== input.bytes || sha256(bytes) !== input.sha256 || `sha512-${createHash("sha512").update(bytes).digest("base64")}` !== input.integrity) throw new Error("local-input-bytes-invalid");
    auditNpmTarball(bytes);
  }
  const node = join(bootstrap, "bootstrap-node/node-v22.19.0-win-x64/node.exe");
  if (sha256(await readFile(node)) !== authority.nodeRuntime.nodeExeSha256) throw new Error("local-node-invalid");
  const pnpm = join(bootstrap, "bootstrap-pnpm");
  await verifyExtractedPnpmPackage({ authorityPath: authorityFile, packageRoot: pnpm });
  const recovery = recoveryArg ? resolve(recoveryArg) : null;
  const store = join(recovery ?? output, "empty-store");
  const project = join(output, "acquisition-project");
  await mkdir(project);
  const configs = ["package.json", ".npmrc", "pnpm-lock.yaml", "pnpm-workspace.yaml"];
  for (const name of configs) await copyFile(join(repo, "dsh-host", name), join(project, name));
  let sequence = 0;
  async function runPnpm(cwd, args, registry = null) {
    const policy = join(output, `policy-${++sequence}`);
    await mkdir(policy);
    const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC,
      PATH: resolve(node, ".."), HOME: policy, USERPROFILE: policy, APPDATA: policy, LOCALAPPDATA: policy,
      XDG_CONFIG_HOME: policy, XDG_DATA_HOME: policy, XDG_CACHE_HOME: policy, PNPM_HOME: policy,
      TEMP: policy, TMP: policy, CI: "true", npm_config_registry: registry ?? "http://127.0.0.1:9/", npm_config_offline: registry ? "false" : "true" };
    env.LUCKYRAY_FROZEN_CACHE_PORT = registry ? new URL(registry).port : "";
    await new Promise((res, rej) => {
      const child = spawn(node, ["--import", pathToFileURL(join(repo, "scripts/dsh-assembly-network-fence.mjs")).href,
        join(repo, "scripts/dsh-supply-chain.mjs"), "run-pnpm", "--authority", authorityFile, "--pnpm-root", pnpm, "--", ...args,
        `--registry=${registry ?? "http://127.0.0.1:9/"}`, ...(registry ? [] : ["--offline"]),
        "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile", "--prod", "--verify-store-integrity=true",
        "--cache-dir", join(recovery ?? output, "metadata-cache"), "--store-dir", store],
      { cwd, env, windowsHide: true, stdio: "inherit" });
      child.once("error", rej); child.once("exit", (code) => code === 0 ? res() : rej(new Error("local-pnpm-failed")));
    });
  }
  let cacheHydration;
  if (recovery) {
    // Only reuse a cache created by the earlier explicit engineering trial,
    // never a machine/user pnpm store. pnpm rechecks stored package integrity.
    const recovered = JSON.parse(await readFile(join(recovery, "assembly-result.json"), "utf8"));
    if (recovered.outcome !== "OFFLINE_EXACT_TARBALL_ASSEMBLY" || recovered.previouslyPopulatedStoreUsed !== false
        || recovered.originalLockStaged !== sha256(lock) || recovered.cacheHydration.tarballRequests !== inputs.length
        || recovered.cacheHydration.rejected !== 0 || recovered.cacheHydration.droppedConnections !== 0) throw new Error("recovery-receipt-invalid");
    cacheHydration = { mode: "verified-owned-cache-recovery", requests: 0, newUpstreamDownloads: 0 };
  } else {
    const relay = await openFrozenCacheRelay(inputs, join(acquired, "tarballs"), record.releaseTimes);
    try { await runPnpm(project, ["fetch", "--fetch-retries=0", "--network-concurrency=4"], relay.registry); }
    finally {
      await relay.close();
      process.stdout.write(JSON.stringify({ outcome: "CACHE_HYDRATION_ACCOUNTING", ...relay.statistics() }) + "\n");
    }
    cacheHydration = relay.statistics();
    if (cacheHydration.rejected !== 0 || cacheHydration.droppedConnections !== 0 || cacheHydration.tarballRequests !== inputs.length) throw new Error("cache-hydration-not-exact");
  }
  const stage = join(output, "stage");
  await mkdir(stage);
  await mkdir(join(stage, "node")); await mkdir(join(stage, "host"));
  await copyFile(node, join(stage, "node/node.exe"));
  await copyFile(join(bootstrap, "bootstrap-node/node-v22.19.0-win-x64/LICENSE"), join(stage, "node/LICENSE"));
  for (const name of configs) await copyFile(join(repo, "dsh-host", name), join(stage, "host", name));
  await runPnpm(join(stage, "host"), ["install", "--fetch-retries=0", "--node-linker=hoisted", "--package-import-method=copy", "--strict-peer-dependencies=true"]);
  await projectPortableDshReleaseLayout({ stageRoot: stage, expectedShimCount: 13 });
  const verified = await verifyPortableStagedDshRuntime({ authorityPath: authorityFile, recordsDirectory: join(repo, "dsh-host/records"), stageRoot: stage });
  // This script itself must run under the pinned Node for ABI-native evidence.
  const native = await probeDshNativeModules({ stageRoot: stage });
  const result = { outcome: "OFFLINE_EXACT_TARBALL_ASSEMBLY", verified, native,
    previouslyPopulatedStoreUsed: !!recovery, cacheHydration, assemblyRegistry: "unreachable-loopback",
    originalLockStaged: sha256(await readFile(join(stage, "host/pnpm-lock.yaml"))) };
  await writeFile(join(output, "assembly-result.json"), JSON.stringify(result) + "\n", { flag: "wx" });
  process.stdout.write(JSON.stringify(result) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(String(error.stack) + "\n"); process.exitCode = 1; });
}
