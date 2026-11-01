// Native macOS production before-build entry. No Windows preparation script,
// placeholder runtime, fixture trust or empty-resource app bundle is used.
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { constants } from "node:fs";
import { open, lstat, unlink } from "node:fs/promises";
import { APP, TAURI, BUILD, TARGET, SIDECARS, sha256, directory, readRegular, inventory, run, requireNative } from "./macos-build-common.mjs";
import { INPUTS, prepareRuntimes } from "./prepare-macos-runtimes.mjs";
import { releaseOrigins, prepareSidecars } from "./prepare-macos-sidecars.mjs";

async function preflight() {
  const config = JSON.parse((await readRegular(join(TAURI, "tauri.macos.conf.json"), 64 * 1024)).toString());
  if (JSON.stringify(config.bundle.externalBin) !== JSON.stringify(SIDECARS.map(name => `binaries/${name}`)))
    throw new Error("macos-sidecar-configuration-mismatch");
  await releaseOrigins();
}
export async function prepareBuild() {
  requireNative(); await preflight(); await directory(BUILD);
  const lockPath = join(BUILD, "product-build.lock");
  const lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  const identity = await lock.stat();
  try {
    // Release sidecars link the shared Tauri library and therefore also need
    // the real frontendDist on a clean checkout, before their Cargo build.
    await run("pnpm", ["build"], { cwd: APP, diagnosticStage: "frontend-build" });
    await prepareRuntimes();
    await prepareSidecars();
    const manifest = JSON.parse((await readRegular(join(TAURI, "media-engine/runtime-manifest.json"), 4 * 1024 * 1024)).toString());
    const actual = (await inventory(join(TAURI, "media-engine"))).filter(item => item.path !== "runtime-manifest.json");
    if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error("macos-media-final-inventory-conflict");
    for (const name of SIDECARS) if (!(await readRegular(join(TAURI, "binaries", `${name}-${TARGET}`))).length)
      throw new Error("macos-sidecar-final-missing");
    return { status: "prepared-for-native-bundling", target: TARGET, sidecars: SIDECARS,
      mediaManifestSha256: sha256(await readRegular(join(TAURI, "media-engine/runtime-manifest.json"))), appBundle: "not-built-by-before-hook" };
  } finally {
    const current = await lstat(lockPath).catch(() => null);
    if (current && current.dev === identity.dev && current.ino === identity.ino) await unlink(lockPath);
    await lock.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.slice(2).join(" ") === "--plan") {
      await preflight();
      console.log(JSON.stringify({ target: TARGET, inputs: INPUTS, sidecars: SIDECARS,
        steps: ["build-frontend", "verify-official-inputs", "install-frozen-offline-dsh-closure", "probe-native-dsh-modules-and-version",
          "build-static-openssl-python-ffmpeg", "stage-official-node-deno-and-wheels", "compile-real-release-sidecars",
          "verify-prepared-product-inventories"], bundleResources: "full-tauri-product-resources",
        nativeExecution: "not-run-by-plan", installerOrSystemChanges: false }, null, 2));
    } else if (process.argv.length === 2) console.log(JSON.stringify(await prepareBuild()));
    else throw new Error("usage: node prepare-macos-build.mjs [--plan]");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
