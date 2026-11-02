// One real bundled LSH proof. The observer is separately testable with ordinary
// child processes; those process-contract tests are not native DSH acceptance.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { TAURI, APP } from "./macos-build-common.mjs";

export const PROOF_TIMEOUT_MS = 20 * 60 * 1000;
export const PROOF_CLEANUP_MS = 90 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const STAGES = new Set(["context", "installed-resources", "initialize", "real-dsh-probe",
  "authenticated-parent", "normal-shutdown", "complete", "cancelled"]);
const STEPS = new Set(["not-started", "runtime-use", "private-environment", "spawn-owned", "node-image",
  "bootstrap-write", "authenticated-hello", "source-revalidate", "probe-request", "probe-session",
  "probe-turn", "probe-result", "ready"]);
const FLAGS = ["installedManifest", "realProbeCompleted", "processImageMatched", "authenticatedParentPing",
  "normalHostShutdown", "ownedGroupSettled"];
const SIGNALS = new Set(["SIGABRT", "SIGALRM", "SIGBUS", "SIGCHLD", "SIGCONT", "SIGEMT", "SIGFPE", "SIGHUP", "SIGILL",
  "SIGINFO", "SIGINT", "SIGIO", "SIGKILL", "SIGPIPE", "SIGPROF", "SIGQUIT", "SIGSEGV", "SIGSTOP", "SIGSYS", "SIGTERM",
  "SIGTRAP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGURG", "SIGUSR1", "SIGUSR2", "SIGVTALRM", "SIGWINCH", "SIGXCPU", "SIGXFSZ"]);
export const knownProofSignal = value => SIGNALS.has(value);
const invalid = () => { throw new Error("macos-lsh-proof-result-invalid"); };
const bool = value => typeof value === "boolean";

export function safeLshProof(value) {
  if (value?.schemaVersion !== 1 || value.mode !== "macos-lsh-native-proof"
      || !["passed", "failed"].includes(value.status) || !STAGES.has(value.stage) || !STEPS.has(value.launchStep)
      || FLAGS.some(key => !bool(value[key])) || !bool(value.cancelled)
      || value.guiInteraction !== "not-run" || value.modelAccount !== "not-configured"
      || value.status === "passed" && (value.stage !== "complete" || value.launchStep !== "ready"
        || value.cancelled || FLAGS.some(key => !value[key]))
      || value.status === "failed" && value.stage === "complete"
      || value.cancelled !== (value.stage === "cancelled")) invalid();
  return { schemaVersion: 1, mode: value.mode, status: value.status, stage: value.stage, launchStep: value.launchStep,
    ...Object.fromEntries(FLAGS.map(key => [key, value[key]])), cancelled: value.cancelled,
    guiInteraction: "not-run", modelAccount: "not-configured" };
}

function failureCode(value, proof) {
  if (value.spawnFailed) return "macos-lsh-proof-spawn-failed";
  if (value.timedOut) return "macos-lsh-proof-timeout";
  if (value.cancelRequested) return "macos-lsh-proof-cancelled";
  if (value.forcedTermination) return "macos-lsh-proof-forced-termination";
  if (value.outputInvalid || !proof) return "macos-lsh-proof-output-invalid";
  if (value.exitCode !== 0 || value.signal !== null) return "macos-lsh-proof-exit-failed";
  if (proof.status !== "passed") return "macos-lsh-proof-rejected";
  return null;
}
export function safeLshExecution(value) {
  if (!value || ["timedOut", "cancelRequested", "forcedTermination", "outputInvalid", "spawnFailed"].some(key => !bool(value[key]))
      || (value.timedOut || value.forcedTermination) && !value.cancelRequested
      || value.exitCode !== null && (!Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255)
      || value.signal !== null && !SIGNALS.has(value.signal)
      || !Number.isSafeInteger(value.durationMs) || value.durationMs < 0 || value.durationMs > 24 * 60 * 60 * 1000) invalid();
  const proof = value.proof == null ? null : safeLshProof(value.proof);
  const failure = failureCode(value, proof);
  const status = failure === null ? "passed" : "failed";
  const cleanup = value.spawnFailed ? "not-started"
    : proof?.ownedGroupSettled && !value.forcedTermination ? "confirmed" : "unconfirmed";
  if (value.status !== status || value.cleanup !== cleanup || value.failure !== failure) invalid();
  return { status, proof, exitCode: value.exitCode, signal: value.signal, timedOut: value.timedOut,
    cancelRequested: value.cancelRequested, forcedTermination: value.forcedTermination,
    outputInvalid: value.outputInvalid, spawnFailed: value.spawnFailed, durationMs: value.durationMs, cleanup, failure };
}

export async function observeLshProof(child, { timeoutMs = PROOF_TIMEOUT_MS, cleanupMs = PROOF_CLEANUP_MS } = {}) {
  const start = Date.now();
  const chunks = [];
  let bytes = 0, timedOut = false, cancelRequested = false, forcedTermination = false;
  let outputInvalid = false, spawnFailed = false, closed = false, forceTimer;
  const cancel = () => {
    if (closed || cancelRequested) return;
    cancelRequested = true;
    // This private pipe only revokes the proof. Rust still owns all native
    // handles and performs the anchored group sweep before it reports cleanup.
    child.stdin?.end("C");
    forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        forcedTermination = true;
        child.kill("SIGKILL");
      }
    }, cleanupMs);
  };
  const timeout = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
  const interrupted = () => cancel();
  process.once("SIGTERM", interrupted);
  process.once("SIGINT", interrupted);
  process.once("disconnect", interrupted);
  child.stdin?.on("error", () => {}); // Exit can close the private pipe first.
  child.stdout?.on("data", chunk => {
    bytes += chunk.length;
    if (bytes > MAX_OUTPUT_BYTES) { outputInvalid = true; cancel(); }
    else chunks.push(chunk);
  });
  child.stderr?.resume(); // No raw native output or environment is retained.
  child.once("error", () => { spawnFailed = true; });
  const exit = await new Promise(resolveExit => child.once("close", (code, signal) => resolveExit({ code, signal })));
  closed = true;
  clearTimeout(timeout); clearTimeout(forceTimer);
  process.removeListener("SIGTERM", interrupted);
  process.removeListener("SIGINT", interrupted);
  process.removeListener("disconnect", interrupted);
  let proof = null;
  if (!outputInvalid) {
    try { proof = safeLshProof(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
    catch { outputInvalid = true; }
  }
  const execution = { proof, exitCode: exit.code, signal: exit.signal, timedOut, cancelRequested,
    forcedTermination, outputInvalid, spawnFailed, durationMs: Math.max(0, Date.now() - start) };
  execution.failure = failureCode(execution, proof);
  execution.status = execution.failure === null ? "passed" : "failed";
  execution.cleanup = spawnFailed ? "not-started" : proof?.ownedGroupSettled && !forcedTermination ? "confirmed" : "unconfirmed";
  return safeLshExecution(execution);
}

export function runLshProof(app, env) {
  const expected = join(TAURI, "target/aarch64-apple-darwin/release/bundle/macos/LuckyRay.app");
  if (app !== expected) throw new Error("macos-lsh-proof-context-invalid");
  // No shell, arbitrary target, script, account or browser registration.
  const child = spawn(join(expected, "Contents/MacOS/luckyray-app"), ["--macos-lsh-proof"],
    { cwd: APP, env, stdio: ["pipe", "pipe", "pipe"] });
  return observeLshProof(child);
}
