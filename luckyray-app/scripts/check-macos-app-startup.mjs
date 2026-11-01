// Run the full product bundle on a disposable native CI runner, not a library
// fixture. A visible window + PNG is startup evidence, not a user-flow pass.
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { APP, TAURI, TARGET, stage, directory, readRegular, jsonNew, run, requireNative } from "./macos-build-common.mjs";

export async function checkStartup() {
  requireNative();
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== "xiaorui2886/LuckyRay")
    throw new Error("macos-startup-check-requires-disposable-project-ci");
  const scratch = await stage("actual-app-startup");
  const helper = join(scratch, "window-probe");
  await run("/usr/bin/swiftc", ["-target", "arm64-apple-macos15.0", join(APP, "scripts/macos-app-window.swift"), "-o", helper]);
  const app = join(TAURI, "target", TARGET, "release/bundle/macos/LuckyRay.app");
  const binary = join(app, "Contents/MacOS/luckyray-app");
  // Give the real app a fresh profile and no CI tokens, package credentials or
  // inherited loader flags. GUI session selectors contain no authorization.
  const home = await directory(join(scratch, "profile"));
  const env = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C",
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"),
    LUCKYRAY_APP_PROFILE: "production" };
  for (const name of ["USER", "LOGNAME", "TMPDIR", "__CF_USER_TEXT_ENCODING", "XPC_FLAGS", "XPC_SERVICE_NAME", "SECURITYSESSIONID"])
    if (process.env[name]) env[name] = process.env[name];
  const child = spawn(binary, [], { cwd: APP, stdio: "ignore", env });
  let spawnError;
  child.on("error", error => { spawnError = error; });
  try {
    let observed;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error("macos-real-app-exited-before-window");
      }
      if (child.pid) {
        const result = spawnSync(helper, [String(child.pid)], { encoding: "utf8", timeout: 5000 });
        if (result.status === 0) { observed = JSON.parse(result.stdout); break; }
        if (result.status !== 2) throw new Error("macos-window-observation-failed");
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 1000));
    }
    if (!observed) throw new Error("macos-real-app-window-timeout");
    await new Promise(resolveWait => setTimeout(resolveWait, 4000));
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("macos-real-app-exited-before-capture");
    const png = join(scratch, "LuckyRay-real-app.png");
    // Respect the runner's screen capture policy. Failure remains a failed
    // capture; no TCC edit, permission prompt automation or synthetic fallback.
    await run("/usr/sbin/screencapture", ["-x", "-o", "-l", String(observed.windowID), png]);
    const image = await readRegular(png, 32 * 1024 * 1024);
    if (image.length < 1024 || image.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
      throw new Error("macos-real-app-capture-invalid");
    const report = { status: "real-product-window-captured", ...observed,
      appBundle: "LuckyRay.app", screenshot: "LuckyRay-real-app.png", frontendInteraction: "not-run",
      lshConnection: "not-run", installIntoApplications: "not-run", screenshotVisualReview: "required" };
    await jsonNew(join(scratch, "startup-result.json"), report);
    console.log(JSON.stringify({ ...report, artifactDirectory: scratch }));
    return { ...report, artifactDirectory: scratch };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise(resolveClose => child.once("close", resolveClose)), new Promise(resolveWait => setTimeout(resolveWait, 5000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error("usage: node check-macos-app-startup.mjs");
    await checkStartup();
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
