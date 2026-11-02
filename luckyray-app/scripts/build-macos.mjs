// Controlled Apple Silicon app/DMG build. Ad-hoc signing uses no Apple account
// and does not notarize or publish. Sign the outer app after its immutable
// runtime and sidecar inventories, so no post-compile tool changes those bytes.
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { symlink, lstat, rename, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { APP, TAURI, TARGET, SIDECARS, sha256, directory, stage, readRegular, inventory,
  run, requireNative, requireMachO, isolatedEnvironment, jsonNew, releaseEnvironment } from "./macos-build-common.mjs";
import { inspectDshDistribution } from "./macos-dsh-distribution.mjs";

export const APP_BUILD_ARGUMENTS = Object.freeze(["exec", "tauri", "build", "--ci", "--target", TARGET,
  "--bundles", "app", "--no-sign", "--", "--locked", "--no-default-features", "--features", "browser-host-runtime", "--bin", "luckyray-app"]);
export function appBuildArguments(internalValidation = false) {
  const args = [...APP_BUILD_ARGUMENTS];
  if (internalValidation) args.splice(args.indexOf("--"), 0, "--config", '{"bundle":{"createUpdaterArtifacts":false}}');
  if (internalValidation) args.splice(args.indexOf("--bin"), 0, "--features", "macos-lsh-surface-flow");
  return args;
}

export async function verifyApp(app, { internalValidation = false } = {}) {
  const contents = join(app, "Contents"); const resources = join(contents, "Resources");
  const pkg = JSON.parse((await readRegular(join(APP, "package.json"))).toString());
  const version = (await run("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(contents, "Info.plist")], { capture: true })).trim();
  if (version !== pkg.version) throw new Error("macos-app-version-mismatch");
  await requireMachO(join(contents, "MacOS/luckyray-app"));
  const origins = JSON.parse((await readRegular(join(TAURI, "binaries/luckyray-sidecars.origin.identity.json"))).toString());
  for (const name of SIDECARS) {
    const binary = join(contents, "MacOS", name); await requireMachO(binary);
    if (sha256(await readRegular(binary)) !== origins.binaries.find(item => item.name === name)?.sha256)
      throw new Error("macos-app-sidecar-bytes-changed");
  }
  try { await lstat(join(contents, "MacOS/luckyray-browser-host")); throw new Error("macos-app-contains-windows-only-host"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const media = join(resources, "media-engine");
  const manifestBytes = await readRegular(join(media, "runtime-manifest.json"));
  if (sha256(manifestBytes) !== sha256(await readRegular(join(TAURI, "media-engine/runtime-manifest.json"))))
    throw new Error("macos-app-media-manifest-changed");
  const manifest = JSON.parse(manifestBytes.toString());
  const actual = (await inventory(media)).filter(item => item.path !== "runtime-manifest.json");
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error("macos-app-media-bytes-changed");
  const dsh = join(resources, "lr-lsh/199-1/deepseek-harness");
  const record = JSON.parse((await readRegular(join(dsh, "macos-build.json"))).toString());
  if (record.platform !== "darwin" || record.architecture !== "arm64" || record.nativeModuleLoadProbe.status !== "passed")
    throw new Error("macos-app-dsh-record-invalid");
  const dshFiles = (await inventory(dsh)).filter(item => item.path !== "macos-build.json");
  if (JSON.stringify(dshFiles) !== JSON.stringify(record.files)) throw new Error("macos-app-dsh-bytes-changed");
  const distribution = await inspectDshDistribution(dsh);
  if (record.distribution?.sourceInputsSha256 !== distribution.sourceInputsSha256
      || record.distribution.readyToPackage !== distribution.readyToPackage
      || JSON.stringify(record.distribution.missingRequirements) !== JSON.stringify(distribution.missingRequirements))
    throw new Error("macos-app-distribution-index-changed");
  if (!internalValidation && !distribution.readyToPackage)
    throw new Error("macos-dsh-distribution-materials-incomplete");
  const scratch = await stage("bundled-runtime-probes");
  const env = isolatedEnvironment(scratch);
  const cli = JSON.parse(await run(join(contents, "MacOS/luckyray-cli"), ["protocol", "identity"], { capture: true, env }));
  const identity = JSON.parse((await readRegular(join(TAURI, `binaries/luckyray-cli-${TARGET}.identity.json`))).toString());
  if (cli.ok !== true || cli.identity !== identity.identity || cli.protocol !== identity.protocol)
    throw new Error("macos-app-cli-contract-mismatch");
  const node = join(dsh, "node/node");
  if ((await run(node, ["--version"], { capture: true, env })).trim() !== "v22.19.0") throw new Error("macos-app-node-version-invalid");
  if ((await run(node, [join(dsh, "host/node_modules/@deepseek-ai/dsh/lib/bin.js"), "--version"], { capture: true, env })).trim() !== "0.2.1-rc.3")
    throw new Error("macos-app-dsh-version-invalid");
  await run(join(media, "python/bin/python3.11"), ["-I", "-B", "-c",
    "import sys,ssl,zlib; assert sys.version_info[:3]==(3,11,8); assert sys.prefix==sys.argv[1]", join(media, "python")], { env });
  await run(join(media, "deno/deno"), ["--version"], { env });
  await run(join(media, "ffmpeg/ffmpeg"), ["-hide_banner", "-version"], { env });
  return { version, target: TARGET, sidecars: SIDECARS, mediaFiles: manifest.files.length, dshFiles: dshFiles.length, distribution,
    ui: "not-tested-by-inventory-and-command-probes", hostConnection: "not-tested" };
}

// This function creates only an app bundle. The independent internal entry
// never calls buildMacos(), which is the sole DMG/archive export path below.
export async function buildMacosApp({ internalValidation = false, onStage = () => {} } = {}) {
  requireNative();
  const targetDir = await directory(join(TAURI, "target"));
  const env = releaseEnvironment({ CARGO_TARGET_DIR: targetDir });
  // This is a full main binary with production features and real externalBin
  // resources. The feature selection matches the controlled Windows app build:
  // sidecars are prepared separately rather than rediscovered as Cargo bins.
  onStage("compile-app");
  await run("pnpm", appBuildArguments(internalValidation), { env, diagnosticStage: "tauri-build" });
  const bundle = join(targetDir, TARGET, "release/bundle"); const app = join(bundle, "macos/LuckyRay.app");
  onStage("verify-resources-and-runtimes");
  const result = await verifyApp(app, { internalValidation });
  if (internalValidation && (JSON.stringify((await readdir(bundle)).sort()) !== '["macos"]'
      || JSON.stringify((await readdir(join(bundle, "macos"))).sort()) !== '["LuckyRay.app"]'))
    throw new Error("macos-internal-unexpected-bundle-export");
  // Do not use --deep while signing: nested binaries already have their own
  // signatures and the compiled manifest/CLI contracts bind their exact bytes.
  onStage("ad-hoc-sign");
  await run("/usr/bin/codesign", ["--force", "--sign", "-", "--options", "runtime", app]);
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  return { ...result, app, bundle };
}

export async function buildMacos() {
  // Default verification requires complete corresponding source; an internal
  // validation result is never accepted as export authorization here.
  const { app, bundle, ...result } = await buildMacosApp();
  const imageRoot = await stage("dmg-contents");
  await run("/usr/bin/ditto", ["--noqtn", "--norsrc", app, join(imageRoot, "LuckyRay.app")]);
  await symlink("/Applications", join(imageRoot, "Applications"));
  const dmgRoot = await directory(join(bundle, "dmg"));
  const dmg = join(dmgRoot, `LuckyRay_${result.version}_aarch64.dmg`);
  try {
    const previous = await lstat(dmg);
    if (!previous.isFile() || previous.isSymbolicLink() || previous.uid !== process.geteuid()) throw new Error("macos-dmg-existing-object-unsafe");
    await rename(dmg, `${dmg}.backup-${randomUUID()}`);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await run("/usr/bin/hdiutil", ["create", "-volname", "LuckyRay", "-srcfolder", imageRoot, "-format", "UDZO", dmg]);
  await run("/usr/bin/hdiutil", ["verify", dmg]);
  const archive = join(bundle, `LuckyRay_${result.version}_aarch64.app.tar.gz`);
  try {
    const previous = await lstat(archive);
    if (!previous.isFile() || previous.isSymbolicLink() || previous.uid !== process.geteuid()) throw new Error("macos-app-archive-existing-object-unsafe");
    await rename(archive, `${archive}.backup-${randomUUID()}`);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  // GitHub artifact ZIPs do not preserve Unix executable bits. The app archive
  // and DMG preserve them, instead of uploading a loose .app directory.
  await run("/usr/bin/tar", ["-czf", archive, "-C", join(bundle, "macos"), "LuckyRay.app"]);
  const recordPath = join(bundle, `macos-artifacts-${randomUUID()}.json`);
  await jsonNew(recordPath, { ...result, app: "macos/LuckyRay.app", dmg: `dmg/LuckyRay_${result.version}_aarch64.dmg`,
    dmgSha256: sha256(await readRegular(dmg, 2 * 1024 * 1024 * 1024)),
    appArchiveSha256: sha256(await readRegular(archive, 2 * 1024 * 1024 * 1024)), signing: "ad-hoc", notarization: "not-requested",
    release: "not-published", appLaunch: "not-run-by-build-command" });
  return { ...result, app, dmg, archive, recordPath };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error("usage: node build-macos.mjs");
    console.log(JSON.stringify(await buildMacos()));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
