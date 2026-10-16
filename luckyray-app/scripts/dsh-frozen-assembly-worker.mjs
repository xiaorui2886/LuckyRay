// Fixed desktop-owned input adapter. Native code embeds this file and its
// reviewed helpers/config/records. No program or configuration is loaded from
// the catalog. Native verifies/holds Node, this bundle and downloaded bytes,
// owns the Windows Job, and supplies an admitted descriptor digest/size.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, mkdir, copyFile, lstat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateFrozenAssemblyDescription, validateQualifiedAssemblyDescription } from "./dsh-frozen-assembly-description.mjs";
import { auditNpmTarball } from "./dsh-npm-tar-policy.mjs";
import { openFrozenCacheRelay } from "./dsh-frozen-cache-relay.mjs";
import { validateDshRuntimeAuthority, extractVerifiedPnpmPackage, verifyExtractedPnpmPackage,
  projectPortableDshReleaseLayout, verifyPortableStagedDshRuntime, probeDshNativeModules } from "./dsh-supply-chain.mjs";

const digest = (bytes, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
const configNames = ["package.json", ".npmrc", "pnpm-lock.yaml", "pnpm-workspace.yaml"];
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let failureStage = "descriptor";
const pnpmFailureCodes = ["ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION", "ERR_PNPM_NO_OFFLINE_TARBALL", "ERR_PNPM_TARBALL_INTEGRITY", "ERR_PNPM_PEER_DEP_ISSUES",
  "ERR_PNPM_LOCKFILE_BREAKING_CHANGE", "ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE", "ERR_PNPM_LINKING_FAILED",
  "ERR_PNPM_ENAMETOOLONG", "ERR_PNPM_ENOENT", "ERR_PNPM_EPERM", "ERR_PNPM_EACCES",
  "ENAMETOOLONG", "ENOENT", "EPERM", "EACCES"];
export function pnpmFailureCode(output) {
  return pnpmFailureCodes.find((code) => new RegExp(`\\b${code}\\b`, "u").test(output)) ?? "worker";
}
export function workerFailureShape(error, stage) {
  const stages = ["descriptor", "preflight", "pnpm-extract", "cache-populate", "offline-install", "portable-seal", "native-probe"];
  return { kind: "failure", stage: stages.includes(stage) ? stage : "descriptor",
    category: error?.name === "DshSupplyChainError" ? "seal" : pnpmFailureCodes.includes(error?.code) ? error.code : "worker" };
}

export async function readWorkerDescription(bundle, workspace, hash, size) {
  const bytes = await readFile(join(workspace, "description.json"));
  // Never inspect unauthenticated data to select execution or policy. Both
  // parsers authenticate the entire descriptor before parsing.
  if (bytes.length !== size || bytes.length > 2 * 1024 * 1024 || digest(bytes) !== hash) throw new Error("assembly-description-invalid");
  if (JSON.parse(bytes).schema === 2) {
    const qualified = validateQualifiedAssemblyDescription({ bytes, expectedHash: hash, expectedBytes: size });
    return { ...qualified, authorityFile: join(bundle, "runtime-authority.json"), qualified: true };
  }
  const authorityFile = join(bundle, "runtime-authority.json");
  const authority = validateDshRuntimeAuthority(JSON.parse(await readFile(authorityFile, "utf8")));
  const hostFiles = {};
  for (const name of configNames) hostFiles[name] = await readFile(join(bundle, "host", name));
  const description = validateFrozenAssemblyDescription({ bytes, expectedHash: hash, expectedBytes: size,
    authority, hostFiles, lockfile: hostFiles["pnpm-lock.yaml"],
    dependencyAudit: JSON.parse(await readFile(join(bundle, "records/dependency-audit.json"), "utf8")) });
  return { authorityFile, authority, description, hostFiles, qualified: false };
}

async function immutableInput(path, expectedBytes, expectedHash) {
  const meta = await lstat(path, { bigint: true });
  if (!meta.isFile() || meta.isSymbolicLink() || meta.nlink !== 1n || meta.size !== BigInt(expectedBytes)) throw new Error("assembly-input-invalid");
  const bytes = await readFile(path);
  if (bytes.length !== expectedBytes || digest(bytes) !== expectedHash) throw new Error("assembly-input-invalid");
  return bytes;
}

export function workerPaths(command, workspaceArg, stageArg, hash, sizeArg) {
  const size = Number(sizeArg);
  if (!["plan", "assemble"].includes(command) || !isAbsolute(workspaceArg ?? "") || !isAbsolute(stageArg ?? "")
      || !/^[a-f0-9]{64}$/u.test(hash ?? "") || !Number.isSafeInteger(size) || size < 1 || size > 2 * 1024 * 1024) throw new Error("assembly-worker-arguments-invalid");
  const workspace = resolve(workspaceArg), stage = resolve(stageArg);
  if (dirname(workspace) !== dirname(stage) || !/^\.assembly-[a-f0-9]{32}$/u.test(workspace.split(/[\\/]/u).at(-1))
      || !/^\.stage-[a-f0-9]{32}$/u.test(stage.split(/[\\/]/u).at(-1))) throw new Error("assembly-worker-arguments-invalid");
  return { command, workspace, stage, hash, size };
}

export function workerCliPaths(bundle, args) {
  if (args.length !== 4 || !/^\.stage-[a-f0-9]{32}$/u.test(args[1] ?? "")
      || !isAbsolute(bundle) || bundle.split(/[\\/]/u).at(-1) !== "worker") throw new Error("assembly-worker-arguments-invalid");
  const workspace = dirname(bundle);
  return workerPaths(args[0], workspace, join(dirname(workspace), args[1]), args[2], args[3]);
}

export function pnpmCachePolicy(registry, acquiring) {
  const match = typeof registry === "string" && /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/[a-f0-9]{32}\/$/u.exec(registry);
  if (typeof acquiring !== "boolean" || !match || Number(match[1]) > 65535) throw new Error("assembly-cache-invalid");
  const port = match[1];
  // Preserve pnpm's metadata-cache namespace after the server closes. Offline
  // verification may need that genuine acquired metadata even when fetch's
  // lockfile-verification cache misses. The namespace is NOT a socket grant.
  return { registryArg: `--registry=${registry}`, fencePort: acquiring ? port : "",
    offlineArgs: acquiring ? [] : ["--offline"] };
}

async function assemble({ workspace, stage }, bundle, { authorityFile, authority, description, hostFiles, records, qualified }) {
  failureStage = "preflight";
  const pnpm = join(workspace, "pnpm"), tarballs = join(workspace, "tarballs");
  const pnpmBytes = await immutableInput(join(workspace, "pnpm.tgz"), description.packageManager.archiveBytes, authority.packageManager.sha256);
  if (`sha512-${createHash("sha512").update(pnpmBytes).digest("base64")}` !== authority.packageManager.registryIntegrity) throw new Error("assembly-input-invalid");
  for (const input of description.packages) {
    const bytes = await immutableInput(join(tarballs, `${input.sha256}.tgz`), input.bytes, input.sha256);
    if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== input.integrity) throw new Error("assembly-input-invalid");
    auditNpmTarball(bytes);
  }
  failureStage = "pnpm-extract";
  await extractVerifiedPnpmPackage({ authorityPath: authorityFile, pnpmTarballPath: join(workspace, "pnpm.tgz"), outputRoot: pnpm });
  await verifyExtractedPnpmPackage({ authorityPath: authorityFile, packageRoot: pnpm });
  let policySequence = 0;
  async function runPnpm(cwd, args, registry, acquiring) {
    const cachePolicy = pnpmCachePolicy(registry, acquiring);
    const policy = join(workspace, `policy-${++policySequence}`);
    await mkdir(policy);
    // Explicit whitelist. No inherited NODE_OPTIONS, proxy/global config,
    // Electron hooks, preinstalled toolchain or user package-manager cache.
    const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      COMSPEC: process.env.COMSPEC, PATH: dirname(process.execPath), HOME: policy,
      USERPROFILE: policy, APPDATA: policy, LOCALAPPDATA: policy, XDG_CONFIG_HOME: policy,
      XDG_DATA_HOME: policy, XDG_CACHE_HOME: policy, PNPM_HOME: policy, TEMP: policy,
      TMP: policy, CI: "true", LUCKYRAY_FROZEN_CACHE_PORT: cachePolicy.fencePort };
    await new Promise((complete, failed) => {
      const child = spawn(process.execPath, ["--import", pathToFileURL(join(bundle, "dsh-assembly-network-fence.mjs")).href,
        join(bundle, "dsh-supply-chain.mjs"), "run-pnpm", "--authority", authorityFile, "--pnpm-root", pnpm, "--",
        ...args, cachePolicy.registryArg, ...cachePolicy.offlineArgs,
        "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile", "--prod", "--verify-store-integrity=true",
        "--cache-dir", join(workspace, "metadata-cache"), "--store-dir", join(workspace, "store")],
      { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let outputBytes = 0, tooLarge = false, outputTail = Buffer.alloc(0);
      const drain = (chunk) => {
        outputBytes += chunk.length;
        // Retained only inside the worker. Never output raw pnpm paths/argv.
        outputTail = Buffer.concat([outputTail, chunk]).subarray(-64 * 1024);
        if (outputBytes > 8 * 1024 * 1024) { tooLarge = true; child.kill(); }
      };
      child.stdout.on("data", drain); child.stderr.on("data", drain);
      child.once("error", () => failed(new Error("assembly-pnpm-failed")));
      child.once("close", (code) => {
        if (code === 0 && !tooLarge) complete();
        else { const error = new Error("assembly-pnpm-failed"); error.code = pnpmFailureCode(outputTail.toString("utf8")); failed(error); }
      });
    });
  }
  const acquisition = join(workspace, "acquisition");
  await mkdir(acquisition);
  for (const name of configNames) await writeFile(join(acquisition, name), hostFiles[name], { flag: "wx" });
  emit({ kind: "progress", stage: "assemble", done: 0, total: 4 });
  const relay = await openFrozenCacheRelay(description.packages, tarballs, description.releaseTimes);
  failureStage = "cache-populate";
  try { await runPnpm(acquisition, ["fetch", "--fetch-retries=0", "--network-concurrency=4"], relay.registry, true); }
  finally { await relay.close(); }
  const accounting = relay.statistics();
  if (accounting.rejected || accounting.droppedConnections || accounting.tarballRequests !== description.packages.length) throw new Error("assembly-cache-invalid");
  emit({ kind: "progress", stage: "assemble", done: 1, total: 4 });
  await mkdir(stage); // Must not exist. Native creates its sibling, not target.
  await mkdir(join(stage, "node"));
  await copyFile(process.execPath, join(stage, "node/node.exe"));
  await copyFile(join(workspace, "node/LICENSE"), join(stage, "node/LICENSE"));
  const host = join(stage, "host");
  await mkdir(host);
  for (const name of configNames) await writeFile(join(host, name), hostFiles[name], { flag: "wx" });
  failureStage = "offline-install";
  // Fresh host project never reuses fetch's linked virtual-store tree. Keep
  // the acquired metadata namespace, but the relay is CLOSED and the offline
  // fence allows no sockets/DNS. Do not relax policy or forge its cache.
  await runPnpm(host, ["install", "--fetch-retries=0", "--node-linker=hoisted", "--package-import-method=copy", "--strict-peer-dependencies=true"], relay.registry, false);
  emit({ kind: "progress", stage: "assemble", done: 2, total: 4 });
  failureStage = "portable-seal";
  await projectPortableDshReleaseLayout({ stageRoot: stage, expectedShimCount: authority.dependencyClosure.releaseLayout.normalizedShimCount });
  await verifyPortableStagedDshRuntime({ authorityPath: authorityFile, recordsDirectory: join(bundle, "records"), stageRoot: stage,
    ...(qualified ? { qualifiedAuthority: authority, qualifiedRecords: records } : {}) });
  emit({ kind: "progress", stage: "assemble", done: 3, total: 4 });
  failureStage = "native-probe";
  await probeDshNativeModules({ stageRoot: stage, qualified });
  emit({ kind: "progress", stage: "assemble", done: 4, total: 4 });
  return { outcome: "ASSEMBLED_FROZEN_RUNTIME", packageCount: description.packageCount };
}

async function main() {
  const bundle = dirname(fileURLToPath(import.meta.url));
  const paths = workerCliPaths(bundle, process.argv.slice(2));
  const config = await readWorkerDescription(bundle, paths.workspace, paths.hash, paths.size);
  if (digest(await readFile(process.execPath)) !== config.authority.nodeRuntime.nodeExeSha256) throw new Error("assembly-node-invalid");
  const result = paths.command === "plan"
    ? { outcome: "FROZEN_INPUT_PLAN", version: config.authority.runtimePackage.version,
      nodeSha256: config.authority.nodeRuntime.nodeExeSha256, entrySha256: config.description.schema === 2 ? config.records.dependencyAudit.entryPoint.fileSha256 : undefined,
      closureFileCount: config.authority.dependencyClosure.releaseLayout.fileCount,
      packages: config.description.packages.map(({ name, version, url, bytes, sha256 }) => ({ name, version, url, bytes, sha256 })) }
    : await assemble(paths, bundle, config);
  emit({ kind: "result", ...result });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { emit(workerFailureShape(error, failureStage)); process.exitCode = 1; });
}
