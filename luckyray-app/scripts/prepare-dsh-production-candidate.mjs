// Read-only qualification/seal recheck; creates new unsigned maintainer files.
// No downloads, runtime startup, signing, profile changes or publication.
import { createHash } from "node:crypto";
import { readFile, writeFile, readdir, lstat, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateQualifiedAssemblyDescription } from "./dsh-frozen-assembly-description.mjs";
import { verifyPortableStagedDshRuntime } from "./dsh-supply-chain.mjs";
import { ORIGIN, sha256, validateCandidate } from "./dsh-production-maintenance.mjs";
import { compatibilityDeclaration } from "./dsh-host-compatibility.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export async function hostContract(sourceRoot = root) {
  async function fingerprint(domain, files) {
    const digest = createHash("sha256").update(domain).update(Buffer.from([0]));
    for (const file of files) {
      const bytes = await readFile(join(sourceRoot, file)), size = Buffer.alloc(8); size.writeBigUInt64LE(BigInt(bytes.length));
      digest.update(file).update(Buffer.from([0])).update(size).update(bytes);
    }
    return digest.digest("hex");
  }
  return { hostVersion: JSON.parse(await readFile(join(sourceRoot, "package.json"))).version,
    interfaces: JSON.parse(await readFile(join(sourceRoot, "config/dsh-host-compatibility.json"))),
    adapterFingerprint: await fingerprint("luckyray-dsh-host-adapter-v1", ["src-tauri/dsh-host/luckyray-dsh-host.mjs", "src-tauri/src/dsh_host.rs", "src-tauri/src/lib.rs", "src-tauri/src/dsh_resource_broker.rs"]),
    resourceGateSha256: await fingerprint("luckyray-dsh-resource-gate-v1", ["src/core/services/openInLightSeek.ts", "src/features/ai/DshNativeSurfacePage.tsx", "src/features/ai/LightSeekContentBrowser.tsx", "tests/openInLightSeek.contract.test.ts", "tests/dshNativeSurfaceImageIntent.contract.test.mjs"]) };
}
export async function prepareCandidate(descriptorFile, baseline, fromVersions, now = Math.floor(Date.now() / 1000)) {
  if (!Array.isArray(fromVersions) || !fromVersions.length) throw new Error("explicit-qualified-upgrade-origins-required");
  const descriptor = await readFile(descriptorFile), artifactSha256 = sha256(descriptor);
  const qualified = validateQualifiedAssemblyDescription({ bytes: descriptor, expectedHash: artifactSha256, expectedBytes: descriptor.length });
  // Reuse actual existing seal, not package-version labels or assertions in a
  // synthetic JSON fixture. No historical transaction rerun is needed here.
  await verifyPortableStagedDshRuntime({ stageRoot: baseline, qualifiedAuthority: qualified.authority, qualifiedRecords: qualified.records });
  const files = [];
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name), meta = await lstat(path);
      if (meta.isSymbolicLink() || (await realpath(path)).toLowerCase() !== resolve(path).toLowerCase()) throw new Error("candidate-baseline-link");
      if (meta.isDirectory()) await walk(path);
      else if (meta.isFile() && meta.nlink === 1) files.push([relative(baseline, path).replaceAll("\\", "/"), meta.size, sha256(await readFile(path))]);
      else throw new Error("candidate-baseline-shape");
    }
  }
  await walk(baseline); files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const closure = createHash("sha256");
  for (const [path, size, hash] of files) closure.update(path).update("\0").update(String(size)).update("\0").update(hash).update("\n");
  const contract = await hostContract();
  const { interfaces, ...audit } = contract;
  const candidate = { schema: 2, channel: "preview", runtimePackage: "@deepseek-ai/dsh", issuedAt: now - 60, expiresAt: now + 14 * 86400,
    ...audit, compatibility: compatibilityDeclaration(), platform: "windows-x86_64", fromVersions: [...fromVersions], version: qualified.authority.runtimePackage.version,
    nodeSha256: qualified.authority.nodeRuntime.nodeExeSha256, entrySha256: qualified.records.dependencyAudit.entryPoint.fileSha256,
    artifactUrl: `${ORIGIN}descriptors/${artifactSha256}.json`, artifactSha256, artifactBytes: descriptor.length,
    closureSha256: closure.digest("hex"), closureFileCount: files.length, dataCompatibility: "no-migration",
    assembly: { schema: 2, kind: "official-npm-qualified-win-x64-v2", toolset: "node22.19.0-pnpm11.7.0-policy1" } };
  validateCandidate(candidate, descriptor, contract, now);
  return { candidate, contract, descriptor };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [description, baseline, output, fromVersion] = process.argv.slice(2);
    if (!output || !fromVersion) throw new Error("explicit-new-output-and-qualified-origin-required");
    const prepared = await prepareCandidate(resolve(description), resolve(baseline), [fromVersion]);
    const payload = Buffer.from(JSON.stringify(prepared.candidate) + "\n");
    await writeFile(join(resolve(output), "candidate.unsigned.json"), payload, { flag: "wx" });
    await writeFile(join(resolve(output), "host-contract.json"), JSON.stringify(prepared.contract) + "\n", { flag: "wx" });
    process.stdout.write(JSON.stringify({ outcome: "SEALED_QUALIFICATION_PREPARED_NOT_SIGNED", payloadSha256: sha256(payload), ...prepared.candidate }) + "\n");
  } catch { process.stderr.write("PRODUCTION_CANDIDATE_PREPARATION_STOPPED: no candidate authorized or published.\n"); process.exitCode = 1; }
}
