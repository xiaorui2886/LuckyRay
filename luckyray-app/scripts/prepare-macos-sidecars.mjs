import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { lstat, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { APP, TAURI, BUILD, TARGET, SIDECARS, sha256, directory, stage,
  readRegular, writeNew, jsonNew, requireNative, requireMachO, run, releaseEnvironment } from "./macos-build-common.mjs";

export async function releaseOrigins() {
  const bytes = await readRegular(join(APP, "config/release-extension-origins.json"), 64 * 1024);
  const config = JSON.parse(bytes.toString());
  const manifest = JSON.parse((await readRegular(join(APP, "browser-extension-prototype/manifest.json"), 256 * 1024)).toString());
  const key = Buffer.from(manifest.key, "base64");
  const keyHash = sha256(key);
  const extensionId = [...Buffer.from(keyHash, "hex").subarray(0, 16)]
    .flatMap(byte => [byte >> 4, byte & 15]).map(nibble => "abcdefghijklmnop"[nibble]).join("");
  if (config.schemaVersion !== 1 || config.channel !== "private-release-v1" || key.length < 128
    || key.toString("base64") !== manifest.key || keyHash !== config.publicKeySha256
    || JSON.stringify(config.origins) !== JSON.stringify([`chrome-extension://${extensionId}`]))
    throw new Error("macos-release-origin-contract-invalid");
  if (process.env.LUCKYRAY_EXTENSION_ORIGINS !== undefined && process.env.LUCKYRAY_EXTENSION_ORIGINS !== config.origins.join(","))
    throw new Error("macos-build-origin-override-conflict");
  return { origins: config.origins, originFingerprint: sha256(Buffer.from(`${config.origins.join("\0")}\0`)),
    canonicalConfigSha256: sha256(bytes), manifestPublicKeySha256: keyHash };
}

async function publishFile(source, destination, mode = 0o755) {
  const temporary = `${destination}.macos-stage-${randomUUID()}`;
  await writeNew(temporary, await readRegular(source), mode);
  let exists = false;
  try {
    const meta = await lstat(destination);
    if (!meta.isFile() || meta.isSymbolicLink() || meta.uid !== process.geteuid() || meta.nlink !== 1)
      throw new Error("macos-sidecar-existing-object-unsafe");
    exists = true;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (exists) await rename(destination, `${destination}.macos-backup-${randomUUID()}`);
  await rename(temporary, destination);
}

export async function prepareSidecars() {
  requireNative();
  const origins = await releaseOrigins();
  const binaries = await directory(join(TAURI, "binaries"));
  const originRecord = join(binaries, "luckyray-sidecars.origin.identity.json");
  try {
    const existing = JSON.parse((await readRegular(originRecord, 1024 * 1024)).toString());
    if (existing.target !== TARGET) throw new Error("macos-sidecar-existing-platform-conflict");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const scratch = await stage("sidecars");
  const targetDir = join(TAURI, "target"); await directory(targetDir);
  const userRoot = process.env.HOME;
  const env = releaseEnvironment({
    LUCKYRAY_EXTENSION_ORIGINS: origins.origins.join(","), LUCKYRAY_SIDECAR_PREPARE: "1",
    // Bootstrap compilation has no registered sidecars yet. The final Tauri
    // build uses the real nonempty product resources and three staged binaries.
    TAURI_CONFIG: JSON.stringify({ bundle: { externalBin: [], resources: [] } }) });
  await run("cargo", ["build", "--locked", "--release", "--target", TARGET, "--features", "sidecar-binaries",
    ...SIDECARS.flatMap(name => ["--bin", name])], { cwd: TAURI, env, diagnosticStage: "compile-sidecars" });
  const records = [];
  for (const name of SIDECARS) {
    const source = join(targetDir, TARGET, "release", name);
    await requireMachO(source); await run("/usr/bin/codesign", ["--force", "--sign", "-", source]);
    const bytes = await readRegular(source);
    if (name === "luckyray-cli" && ([APP, userRoot].filter(value => value && value !== "/")).some(value => bytes.includes(Buffer.from(value))))
      throw new Error("macos-cli-release-path-hygiene-failed");
    const destination = join(binaries, `${name}-${TARGET}`);
    await publishFile(source, destination);
    records.push({ name, sha256: sha256(bytes) });
    if (name === "luckyray-cli") {
      const identity = JSON.parse(await run(destination, ["protocol", "identity"], { capture: true }));
      if (identity.ok !== true || identity.protocol !== "luckyray-cli-contract-v1" || !/^[a-f0-9]{64}$/.test(identity.identity))
        throw new Error("macos-cli-protocol-identity-invalid");
      const contract = join(scratch, "cli.identity.json");
      await jsonNew(contract, { schemaVersion: 1, protocol: identity.protocol, identity: identity.identity,
        target: TARGET, binarySha256: sha256(bytes), sourceHead: (await run("git", ["rev-parse", "HEAD"], { capture: true })).trim(),
        cargoLockSha256: sha256(await readRegular(join(TAURI, "Cargo.lock"))), profile: "release", hardening: "release-path-remap-v1" });
      await publishFile(contract, `${destination}.identity.json`, 0o644);
    }
  }
  const origin = join(scratch, "origin.identity.json");
  await jsonNew(origin, { schemaVersion: 1, profile: "release", target: TARGET, ...origins,
    cargoLockSha256: sha256(await readRegular(join(TAURI, "Cargo.lock"))), binaries: records.sort((a, b) => a.name.localeCompare(b.name)) });
  await publishFile(origin, originRecord, 0o644);
  return { target: TARGET, profile: "release", binaries: records };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error("usage: node prepare-macos-sidecars.mjs");
    console.log(JSON.stringify(await prepareSidecars()));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
