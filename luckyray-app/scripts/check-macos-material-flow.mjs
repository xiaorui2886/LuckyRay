// One fixed rendered-UI scenario, not a generic browser or application driver.
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { APP, TAURI, TARGET, directory, readRegular, writeNew, jsonNew, sha256, run, requireNative } from "./macos-build-common.mjs";

export const FIXTURE = Object.freeze({ name: "macos-material-flow.png", width: 32, height: 24, bytes: 119,
  sha256: "a4307dbf28c24f349374a7d97bcb4e3856b1cf505f9d8f203c490b60200a976d",
  base64: "iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAYAAACbU/80AAAAPklEQVR42mP4EOX2nxKsO+0DRZhh1AGjDhh1wKgDRh0w4A6w2dL0nxL8dZ8NRXjUAaMOGHXAqANGHTDgDgAAuIv4agXNJmAAAAAASUVORK5CYII=" });
const PHASES = ["import", "reopen"];
const STEPS = ["not-started", "choose-mode", "import", "import-card", "thumbnail", "preview", "reopen-mode", "reopen-card", "reopen-thumbnail", "reopen-preview", "backend-check", "observation", "window-capture", "normal-quit", "source-check"];
const FLAGS = ["modeSaved", "previewDecoded", "backendRecordVerified", "managedCopyVerified", "sourceUnchanged", "normalExit"];
const FAILURES = ["none", "app-exited", "spawn-failed", "context-invalid", "driver-unavailable", "report-invalid", "timeout", "scenario-step", "backend-check", "window-capture", "normal-quit", "source-changed"];
const IMPORT_ERROR_CODES = [
  "database-error", "database-missing", "invalid-storage-mode", "invalid-folder",
  "create-library-failed", "copy-failed", "source-missing", "source-read-failed",
  "source-changed", "managed-destination-conflict", "managed-path-reparse",
  "managed-path-unavailable", "managed-path-untrusted", "managed-root-record-invalid",
  "managed-root-register-conflict", "managed-root-register-failed", "managed-root-unavailable",
  "managed-root-untrusted", "material-library-scope", "physical-path-owned",
  "physical-path-reparse", "physical-path-unavailable", "physical-path-untrusted",
  "physical-content-mismatch", "physical-content-unverified", "physical-identity-mismatch",
  "material-hash-invalid", "staged-file-changed", "staged-file-missing",
  "staged-file-read-failed", "staged-file-too-large", "staged-file-untrusted",
  "staging-unavailable", "change-not-published", "other-code",
];
const blank = () => ({ status: "not-run", step: "not-started", failure: "none", ...Object.fromEntries(FLAGS.map(key => [key, false])), dom: null, nativeImport: null });
const fresh = () => ({ schemaVersion: 1, interaction: "application-dom-automation", status: "not-run", fixtureSha256: FIXTURE.sha256,
  import: blank(), reopen: blank(), persistedAsset: false, systemPointerInput: "not-run", nativeFilePicker: "not-run" });

const invalid = () => { throw new Error("macos-material-flow-result-invalid"); };
const bounded = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
function safeImage(value) {
  if (!value || ["present", "complete", "visible"].some(key => typeof value[key] !== "boolean")
      || !bounded(value.width, 32768) || !bounded(value.height, 32768)
      || !["missing", "asset", "asset-localhost", "other"].includes(value.uriKind)
      || !value.present && (value.complete || value.visible || value.width || value.height || value.uriKind !== "missing")) invalid();
  return { present: value.present, complete: value.complete, width: value.width, height: value.height, visible: value.visible, uriKind: value.uriKind };
}
function safeDom(value) {
  if (!value || ["importDispatched", "bridgeInstalled", "dialogPresent"].some(key => typeof value[key] !== "boolean")
      || !["scoped", "unscoped"].includes(value.workspaceTarget) || !bounded(value.cardCount, 2)
      || !["unknown", "pending", "ready", "failed"].includes(value.databaseState)) invalid();
  return { importDispatched: value.importDispatched, workspaceTarget: value.workspaceTarget,
    bridgeInstalled: value.bridgeInstalled, databaseState: value.databaseState, cardCount: value.cardCount,
    dialogPresent: value.dialogPresent, thumbnail: safeImage(value.thumbnail), preview: safeImage(value.preview) };
}
function safeNativeImport(value) {
  if (!value || !["not-observed", "running", "returned", "error", "multiple-calls", "unavailable"].includes(value.status)
      || ["calls", "importedCount", "failedCount", "skippedDuplicateCount"].some(key => !bounded(value[key], 2))
      || !Array.isArray(value.errorCodes) || value.errorCodes.length > 1
      || value.errorCodes.some(code => !IMPORT_ERROR_CODES.includes(code))
      || value.osError !== null && !bounded(value.osError, 255)
      || ["not-observed", "unavailable"].includes(value.status) && (value.calls || value.importedCount || value.failedCount || value.skippedDuplicateCount || value.errorCodes.length || value.osError !== null)
      || ["running", "returned", "error"].includes(value.status) && value.calls !== 1
      || value.status === "multiple-calls" && value.calls !== 2) invalid();
  return { status: value.status, calls: value.calls, importedCount: value.importedCount, failedCount: value.failedCount,
    skippedDuplicateCount: value.skippedDuplicateCount, errorCodes: [...value.errorCodes], osError: value.osError };
}

export function safeMaterialFlow(value) {
  const fail = () => { throw new Error("macos-material-flow-result-invalid"); };
  if (value?.schemaVersion !== 1 || value.interaction !== "application-dom-automation" || value.fixtureSha256 !== FIXTURE.sha256
      || !["not-run", "failed", "passed"].includes(value.status) || typeof value.persistedAsset !== "boolean") fail();
  const result = fresh(); result.status = value.status; result.persistedAsset = value.persistedAsset;
  for (const phase of PHASES) {
    const row = value[phase];
    if (!row || !["not-run", "failed", "passed"].includes(row.status) || !STEPS.includes(row.step)
        || !FAILURES.includes(row.failure) || FLAGS.some(key => typeof row[key] !== "boolean")) fail();
    result[phase] = { status: row.status, step: row.step, failure: row.failure, ...Object.fromEntries(FLAGS.map(key => [key, row[key]])),
      dom: row.dom == null ? null : safeDom(row.dom), nativeImport: row.nativeImport == null ? null : safeNativeImport(row.nativeImport) };
    if (row.status === "passed" && (!result[phase].dom || !result[phase].nativeImport)) fail();
    if (row.status === "passed" && (row.failure !== "none" || FLAGS.some(key => !row[key]))) fail();
    if (row.status === "failed" && row.failure === "none") fail();
    if (row.status === "not-run" && (row.failure !== "none" || row.step !== "not-started" || FLAGS.some(key => row[key]) || result[phase].dom || result[phase].nativeImport)) fail();
  }
  const passed = PHASES.every(phase => result[phase].status === "passed") && result.persistedAsset;
  if (result.reopen.status !== "not-run" && result.import.status !== "passed") fail();
  if ((result.status === "passed") !== passed) fail();
  return result; // Only fixed enum strings, booleans/counts; no paths/IDs/stderr.
}

export function scenarioRecord(value, phase) {
  if (!PHASES.includes(phase) || value?.schema !== 1 || value.phase !== phase || value.fixtureSha256 !== FIXTURE.sha256
      || !["passed", "failed"].includes(value.status) || !STEPS.includes(value.step)
      || value.assetId !== null && (typeof value.assetId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.assetId))
      || FLAGS.filter(key => key !== "normalExit").some(key => typeof value[key] !== "boolean")
      || value.status === "passed" && (!value.assetId || value.step !== (phase === "import" ? "preview" : "reopen-preview")
        || FLAGS.filter(key => key !== "normalExit").some(key => !value[key])))
    throw new Error("macos-material-flow-result-invalid");
  return { schema: 1, phase, status: value.status, step: value.step, assetId: value.assetId, fixtureSha256: FIXTURE.sha256,
    ...Object.fromEntries(FLAGS.filter(key => key !== "normalExit").map(key => [key, value[key]])),
    dom: safeDom(value.dom), nativeImport: safeNativeImport(value.nativeImport) };
}

function appEnvironment(home, temp) {
  const env = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C",
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"),
    LUCKYRAY_APP_PROFILE: "production", GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "xiaorui2886/LuckyRay",
    GITHUB_SHA: process.env.GITHUB_SHA, RUNNER_TEMP: temp };
  for (const name of ["USER", "LOGNAME", "TMPDIR", "__CF_USER_TEXT_ENCODING", "XPC_FLAGS", "XPC_SERVICE_NAME", "SECURITYSESSIONID"])
    if (process.env[name]) env[name] = process.env[name];
  return env;
}
async function waitClosed(closed, milliseconds) {
  let timeout;
  try { return await Promise.race([closed, new Promise(resolve => { timeout = setTimeout(() => resolve(null), milliseconds); })]); }
  finally { clearTimeout(timeout); }
}
async function cleanup(child, closed) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await waitClosed(closed, 5000);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL"); await waitClosed(closed, 5000);
    }
  }
}

export async function checkMaterialFlow({ onFlow = () => {} } = {}) {
  requireNative();
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== "xiaorui2886/LuckyRay"
      || !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? "")) throw new Error("macos-material-flow-context-invalid");
  let temp;
  try { temp = await realpath(process.env.RUNNER_TEMP ?? "/missing-runner-temp"); }
  catch { throw new Error("macos-material-flow-context-invalid"); }
  if (APP !== join(temp, "luckyray-macos-internal/luckyray-app")) throw new Error("macos-material-flow-context-invalid");
  // Unix asset scope deliberately excludes hidden components. Keep this
  // disposable HOME under the existing ignored, visible target directory;
  // never relax protocol scope just to serve a test profile in .macos-build.
  const root = join(await directory(join(TAURI, "target")), `materials-flow-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  const home = await directory(join(root, "profile"));
  const fixture = Buffer.from(FIXTURE.base64, "base64");
  if (fixture.length !== FIXTURE.bytes || sha256(fixture) !== FIXTURE.sha256) throw new Error("macos-material-flow-result-invalid");
  await writeNew(join(root, FIXTURE.name), fixture, 0o600);
  const helper = join(root, "window-probe");
  await run("/usr/bin/swiftc", ["-target", "arm64-apple-macos15.0", join(APP, "scripts/macos-app-window.swift"), "-o", helper]);
  const binary = join(TAURI, "target", TARGET, "release/bundle/macos/LuckyRay.app/Contents/MacOS/luckyray-app");
  const state = fresh(); let importedId; let observed; const png = join(root, "LuckyRay-real-app.png");
  const publish = () => onFlow(safeMaterialFlow(state));
  publish();
  for (const phase of PHASES) {
    const row = state[phase]; row.status = "failed"; row.step = "observation"; row.failure = "timeout";
    const child = spawn(binary, ["--macos-material-flow", phase, root], { cwd: APP, env: appEnvironment(home, temp), stdio: ["ignore", "ignore", "pipe"] });
    let spawnError; let stderr = "";
    child.on("error", error => { spawnError = error; });
    // Only these whole fixed lines survive. All other stderr is discarded.
    child.stderr.on("data", chunk => {
      const lines = (stderr + chunk.toString()).split(/\r?\n/); stderr = lines.pop().slice(-256);
      for (const line of lines) {
        if (line === "macos-material-flow-context-invalid") row.failure = "context-invalid";
        if (line === "macos-material-flow-driver-unavailable") row.failure = "driver-unavailable";
      }
    });
    // Main-process exit is the quit proof. An escaped tool holding an inherited
    // stderr descriptor cannot turn that into a different cleanup guarantee.
    const closed = new Promise(resolve => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", () => resolve({ code: null, signal: null }));
    });
    try {
      let record;
      for (let attempt = 0; attempt < 2000; attempt++) {
        if (spawnError) { row.failure = "spawn-failed"; throw new Error("macos-material-flow-launch-failed"); }
        if (child.exitCode !== null || child.signalCode !== null) {
          if (row.failure === "timeout") row.failure = "app-exited";
          throw new Error("macos-material-flow-launch-failed");
        }
        try { record = scenarioRecord(JSON.parse((await readRegular(join(root, `${phase}-result.json`), 8192)).toString()), phase); }
        catch (error) { if (error.code !== "ENOENT") { row.failure = "report-invalid"; throw error; } }
        if (record) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!record) throw new Error("macos-material-flow-observation-timeout");
      Object.assign(row, Object.fromEntries(FLAGS.filter(key => key !== "normalExit").map(key => [key, record[key]])),
        { step: record.step, dom: record.dom, nativeImport: record.nativeImport });
      if (record.status !== "passed") { row.failure = record.step === "backend-check" ? "backend-check" : "scenario-step"; throw new Error("macos-material-flow-scenario-failed"); }
      if (phase === "import") importedId = record.assetId;
      else {
        state.persistedAsset = record.assetId === importedId;
        if (!state.persistedAsset) { row.failure = "backend-check"; throw new Error("macos-material-flow-scenario-failed"); }
        row.step = "window-capture"; row.failure = "window-capture";
        const result = spawnSync(helper, [String(child.pid)], { encoding: "utf8", timeout: 5000 });
        if (result.status !== 0) throw new Error("macos-material-flow-window-failed");
        observed = JSON.parse(result.stdout);
        if (observed.pid !== child.pid || !Number.isSafeInteger(observed.windowID) || observed.windowID <= 0)
          throw new Error("macos-material-flow-window-failed");
        await run("/usr/sbin/screencapture", ["-x", "-o", "-l", String(observed.windowID), png]);
        const image = await readRegular(png, 32 * 1024 * 1024);
        if (image.length < 1024 || image.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("macos-real-app-capture-invalid");
      }
      row.step = "normal-quit"; row.failure = "normal-quit";
      const exit = await waitClosed(closed, 45000);
      if (!exit || exit.code !== 0 || exit.signal !== null) throw new Error("macos-material-flow-quit-failed");
      row.normalExit = true;
      row.step = "source-check"; row.failure = "source-changed"; row.sourceUnchanged = false;
      if (sha256(await readRegular(join(root, FIXTURE.name))) !== FIXTURE.sha256) {
        throw new Error("macos-material-flow-result-invalid");
      }
      row.sourceUnchanged = true;
      row.status = "passed"; row.step = record.step; row.failure = "none";
    } catch (error) {
      row.status = "failed"; state.status = "failed"; publish(); throw error;
    } finally { await cleanup(child, closed); child.stderr.destroy(); }
    state.status = phase === "reopen" ? "passed" : "not-run";
    publish();
  }
  const materialFlow = safeMaterialFlow(state);
  const result = { status: "real-product-material-flow-captured", ...observed, appBundle: "LuckyRay.app", screenshot: "LuckyRay-real-app.png",
    frontendInteraction: "application-dom-automation", materialFlow, lshConnection: "not-run", installIntoApplications: "not-run", screenshotVisualReview: "required" };
  await jsonNew(join(root, "startup-result.json"), result);
  return { ...result, artifactDirectory: root };
}
