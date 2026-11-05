// Fixed real-app LSH UI lifecycle. Ordinary-child tests cover this observer's
// failure/exit contract; only a native run can establish actual DSH acceptance.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { APP, TAURI, TARGET, directory, readRegular, writeNew, run, requireNative, isMacosValidationRepository } from "./macos-build-common.mjs";
import { safeShutdown, knownProofSignal } from "./check-macos-lsh-proof.mjs";

export const SURFACE_TIMEOUT_MS = 20 * 60 * 1000;
export const SURFACE_CLEANUP_MS = 90 * 1000;
const UI_FLAGS = ["surfaceAttached", "surfaceHidden", "surfaceReshown", "bindingPreserved", "authenticatedParent", "processImageMatched"];
const QUIT_FLAGS = ["officialSavedStop", "editorsSaved", "normalHostShutdown", "ownedGroupSettled"];
const ALL_FLAGS = [...UI_FLAGS, ...QUIT_FLAGS];
const STAGES = ["choose-mode", "mode-shell", "mode-route", "mode-wait", "mode-choices", "mode-dismiss", "open", "attached", "hidden", "reshown", "normal-quit"];
const BACKEND_STEPS = ["not-started", "client-ready", "child-origin", "node-image", "parent-ping", "binding-retained", "official-saved-stop", "normal-shutdown"];
const QUIT_BLOCKERS = ["not-run", "none", "other-blocker", "update-lsh-task-active", "update-lsh-schedule-active", "update-lsh-draft-pending",
  "update-lsh-composition-pending", "update-lsh-save-failed", "update-lsh-save-timeout", "update-lsh-client-timeout",
  "update-lsh-exit-timeout", "update-lsh-control-timeout", "update-lsh-identity-changed", "update-lsh-content-changed",
  "update-lsh-preparing", "update-lsh-state-unavailable", "update-lsh-not-quiescent", "update-editors-not-saved", "update-service-drain-incomplete",
  "macos-quit-stop-unconfirmed", "macos-quit-cleanup-pending", "macos-quit-recovered", "update-generation-active", "update-task-state-unavailable", "update-gateway-preparing"];
const ERRORS = ["context-invalid", "driver-unavailable", "scenario-failed", "window-failed", "result-invalid", "quit-failed"];
const invalid = () => { throw new Error("macos-lsh-surface-flow-result-invalid"); };
const bool = value => typeof value === "boolean";
const settled = facts => !!facts && facts.groupSettledAfterCleanup && facts.rootExitedAfterCleanup
  && facts.stdoutClosed && facts.stderrClosed && facts.groupState === "settled";
const normal = facts => settled(facts) && facts.writeCompleted && facts.acknowledged && facts.rootExitedBeforeCleanup
  && facts.rootSucceeded && facts.groupSettledBeforeCleanup && !facts.forcedCleanup;

export function safeSurfaceRecord(value, quit = false) {
  if (value?.schemaVersion !== 1 || value.mode !== "macos-lsh-surface-flow"
      || !["passed", "failed"].includes(value.status) || !STAGES.includes(value.stage)
      || (value.stage === "normal-quit") !== quit || ALL_FLAGS.some(key => !bool(value[key]))
      || !BACKEND_STEPS.includes(value.backendStep) || !QUIT_BLOCKERS.includes(value.quitBlocker)
      || !quit && value.quitBlocker !== "not-run" || quit && value.quitBlocker === "not-run"
      || !bool(value.cancelled) || value.interaction !== "application-dom-automation"
      || value.modelAccount !== "not-configured" || value.systemPointerInput !== "not-run") invalid();
  const shutdown = safeShutdown(value.shutdown);
  if (value.normalHostShutdown !== normal(shutdown) || value.ownedGroupSettled !== settled(shutdown)
      || !quit && (shutdown !== null || QUIT_FLAGS.some(key => value[key]))
      || value.status === "passed" && (value.cancelled || UI_FLAGS.some(key => !value[key])
        || !quit && (value.stage !== "reshown" || value.backendStep !== "binding-retained")
        || quit && (QUIT_FLAGS.some(key => !value[key]) || value.quitBlocker !== "none" || value.backendStep !== "normal-shutdown"))) invalid();
  return { schemaVersion: 1, mode: value.mode, status: value.status, stage: value.stage,
    ...Object.fromEntries(ALL_FLAGS.map(key => [key, value[key]])), shutdown, cancelled: value.cancelled,
    backendStep: value.backendStep, quitBlocker: value.quitBlocker,
    interaction: "application-dom-automation", modelAccount: "not-configured", systemPointerInput: "not-run" };
}
function failureCode(value, ui, quit) {
  if (value.spawnFailed) return "macos-lsh-surface-flow-spawn-failed";
  if (value.timedOut) return "macos-lsh-surface-flow-timeout";
  if (value.observationFailure) return `macos-lsh-surface-flow-${value.observationFailure}`;
  if (value.cancelRequested) return "macos-lsh-surface-flow-cancelled";
  if (value.forcedTermination) return "macos-lsh-surface-flow-forced-termination";
  if (value.outputInvalid) return "macos-lsh-surface-flow-result-invalid";
  if (!ui || ui.status !== "passed") return "macos-lsh-surface-flow-scenario-failed";
  if (value.exitCode !== 0 || value.signal !== null) return "macos-lsh-surface-flow-exit-failed";
  if (!quit || quit.status !== "passed") return "macos-lsh-surface-flow-quit-failed";
  if (!value.screenshotCaptured) return "macos-lsh-surface-flow-window-failed";
  return null;
}
export function safeSurfaceExecution(value) {
  if (!value || ["timedOut", "cancelRequested", "forcedTermination", "outputInvalid", "spawnFailed", "screenshotCaptured"].some(key => !bool(value[key]))
      || (value.timedOut || value.forcedTermination) && !value.cancelRequested
      || value.observationFailure !== null && !ERRORS.includes(value.observationFailure)
      || value.exitCode !== null && (!Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255)
      || value.signal !== null && !knownProofSignal(value.signal)
      || !Number.isSafeInteger(value.durationMs) || value.durationMs < 0 || value.durationMs > 24 * 60 * 60 * 1000) invalid();
  const ui = value.ui == null ? null : safeSurfaceRecord(value.ui);
  const quit = value.quit == null ? null : safeSurfaceRecord(value.quit, true);
  const failure = failureCode(value, ui, quit);
  const status = failure === null ? "passed" : "failed";
  const cleanup = value.spawnFailed ? "not-started" : quit?.ownedGroupSettled && !value.forcedTermination ? "confirmed" : "unconfirmed";
  if (value.status !== status || value.failure !== failure || value.cleanup !== cleanup) invalid();
  return { status, ui, quit, exitCode: value.exitCode, signal: value.signal, timedOut: value.timedOut,
    cancelRequested: value.cancelRequested, forcedTermination: value.forcedTermination, outputInvalid: value.outputInvalid,
    spawnFailed: value.spawnFailed, screenshotCaptured: value.screenshotCaptured, observationFailure: value.observationFailure,
    durationMs: value.durationMs, cleanup, failure };
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function boundedExit(exited, milliseconds) {
  let timer;
  try { return await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(null), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

export async function observeSurfaceFlow(child, { readUi, readQuit, capture, timeoutMs = SURFACE_TIMEOUT_MS,
  cleanupMs = SURFACE_CLEANUP_MS, pollMs = 100 } = {}) {
  const start = Date.now();
  let closed = false, exitCode = null, signal = null, timedOut = false, cancelRequested = false;
  let forcedTermination = false, outputInvalid = false, spawnFailed = false, screenshotCaptured = false;
  let observationFailure = null, ui = null, quit = null;
  const exited = new Promise(resolve => {
    child.once("error", () => { spawnFailed = true; closed = true; resolve(); });
    child.once("exit", (code, receivedSignal) => { closed = true; exitCode = code; signal = receivedSignal; resolve(); });
  });
  child.stdin?.on("error", () => {});
  // Never retain raw stdout/stderr, paths, rendered content or account material.
  child.stdout?.resume();
  let pendingLine = "";
  child.stderr?.on("data", chunk => {
    const lines = (pendingLine + chunk.toString()).split(/\r?\n/); pendingLine = lines.pop().slice(-128);
    for (const line of lines) {
      if (line === "macos-lsh-surface-flow-context-invalid") observationFailure = "context-invalid";
      if (line === "macos-lsh-surface-flow-driver-unavailable") observationFailure = "driver-unavailable";
    }
  });
  const cancel = () => {
    if (closed || cancelRequested) return;
    cancelRequested = true;
    child.stdin?.end("C"); // Only cancellation; Rust still owns cleanup.
  };
  const interrupt = () => cancel();
  process.once("SIGTERM", interrupt); process.once("SIGINT", interrupt); process.once("disconnect", interrupt);
  const timer = setTimeout(() => { if (!closed) { timedOut = true; cancel(); } }, timeoutMs);
  try {
    while (!closed && !cancelRequested && !observationFailure) {
      const observed = await readUi();
      if (observed != null) {
        ui = safeSurfaceRecord(observed);
        if (ui.status !== "passed") { observationFailure = "scenario-failed"; break; }
        try { await capture(child.pid); screenshotCaptured = true; }
        catch { observationFailure = "window-failed"; }
        break;
      }
      await delay(pollMs);
    }
    if (observationFailure || !ui || ui.status !== "passed") cancel();
    // The driver invokes normal close after capture. A timeout revokes this
    // parent pipe, waits for anchored Rust cleanup, then records any kill.
    while (!closed && !cancelRequested) await delay(pollMs);
  } catch {
    outputInvalid = true; observationFailure = "result-invalid"; cancel();
  } finally {
    if (!closed) {
      cancel();
      if (!await boundedExit(exited.then(() => true), cleanupMs)) {
        forcedTermination = true; child.kill("SIGKILL");
        await boundedExit(exited.then(() => true), 5000);
      }
    }
    clearTimeout(timer);
    process.removeListener("SIGTERM", interrupt); process.removeListener("SIGINT", interrupt); process.removeListener("disconnect", interrupt);
    try { const value = await readQuit(); if (value != null) quit = safeSurfaceRecord(value, true); }
    catch { outputInvalid = true; observationFailure ??= "result-invalid"; }
    child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
  }
  const value = { ui, quit, exitCode, signal, timedOut, cancelRequested, forcedTermination, outputInvalid,
    spawnFailed, screenshotCaptured, observationFailure, durationMs: Math.max(0, Date.now() - start) };
  value.failure = failureCode(value, ui, quit);
  value.status = value.failure === null ? "passed" : "failed";
  value.cleanup = spawnFailed ? "not-started" : quit?.ownedGroupSettled && !forcedTermination ? "confirmed" : "unconfirmed";
  return safeSurfaceExecution(value);
}

function environment(home, temp, input) {
  const env = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C",
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"),
    GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: input.GITHUB_REPOSITORY, GITHUB_SHA: input.GITHUB_SHA, RUNNER_TEMP: temp };
  for (const name of ["USER", "LOGNAME", "TMPDIR", "__CF_USER_TEXT_ENCODING", "XPC_FLAGS", "XPC_SERVICE_NAME", "SECURITYSESSIONID"])
    if (typeof input[name] === "string") env[name] = input[name];
  return env;
}
export async function runLshSurfaceFlow(app, input, evidence) {
  requireNative();
  const expected = join(TAURI, "target", TARGET, "release/bundle/macos/LuckyRay.app");
  const temp = await realpath(input.RUNNER_TEMP ?? "/missing-runner-temp");
  if (app !== expected || APP !== join(temp, "luckyray-macos-internal/luckyray-app")
      || input.GITHUB_ACTIONS !== "true" || !isMacosValidationRepository(input.GITHUB_REPOSITORY)
      || !/^[a-f0-9]{40}$/.test(input.GITHUB_SHA ?? "")
      || evidence !== join(TAURI, ".macos-build/internal-validation-evidence"))
    throw new Error("macos-lsh-surface-flow-context-invalid");
  const root = join(await directory(join(TAURI, "target")), `lsh-surface-flow-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  const home = await directory(join(root, "profile"));
  const helper = join(root, "window-probe");
  await run("/usr/bin/swiftc", ["-target", "arm64-apple-macos15.0", join(APP, "scripts/macos-app-window.swift"), "-o", helper]);
  const child = spawn(join(app, "Contents/MacOS/luckyray-app"), ["--macos-lsh-surface-flow", root],
    { cwd: APP, env: environment(home, temp, input), stdio: ["pipe", "pipe", "pipe"] });
  const read = async name => {
    try { return JSON.parse((await readRegular(join(root, name), 8192)).toString()); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  };
  return observeSurfaceFlow(child, { readUi: () => read("ui-result.json"), readQuit: () => read("quit-result.json"),
    capture: async pid => {
      const observed = spawnSync(helper, [String(pid)], { encoding: "utf8", timeout: 5000 });
      if (observed.status !== 0) throw new Error("macos-lsh-surface-flow-window-failed");
      const window = JSON.parse(observed.stdout);
      if (window.pid !== pid || !Number.isSafeInteger(window.windowID) || window.windowID <= 0)
        throw new Error("macos-lsh-surface-flow-window-failed");
      const png = join(root, "LuckyRay-lsh-surface.png");
      const captured = spawnSync("/usr/sbin/screencapture", ["-x", "-o", "-l", String(window.windowID), png],
        { stdio: "ignore", timeout: 5000 });
      if (captured.status !== 0) throw new Error("macos-lsh-surface-flow-window-failed");
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("macos-lsh-surface-flow-window-failed");
      const image = await readRegular(png, 32 * 1024 * 1024);
      if (image.length < 1024 || image.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
        throw new Error("macos-lsh-surface-flow-window-failed");
      await writeNew(join(evidence, "LuckyRay-lsh-surface.png"), image, 0o600);
    } });
}
