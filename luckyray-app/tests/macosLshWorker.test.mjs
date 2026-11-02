// Synthetic JSON and real ordinary Node children test only the worker contract.
// No fixture here is an official DSH/native Mac acceptance result.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { safeLshProof, safeLshExecution, observeLshProof } from "../scripts/check-macos-lsh-proof.mjs";
import { publishableReport, PHASES, summarizeBuildResult } from "../scripts/check-macos-internal.mjs";

const canary = "private_worker_canary_never_publish";
function proof() {
  return { schemaVersion: 1, mode: "macos-lsh-native-proof", status: "passed", stage: "complete", launchStep: "ready",
    installedManifest: true, realProbeCompleted: true, processImageMatched: true, authenticatedParentPing: true,
    normalHostShutdown: true, ownedGroupSettled: true,
    shutdown: { writeCompleted: true, acknowledged: true, rootExitedBeforeCleanup: true, rootSucceeded: true,
      groupSettledBeforeCleanup: true, forcedCleanup: false, groupSettledAfterCleanup: true,
      rootExitedAfterCleanup: true, stdoutClosed: true, stderrClosed: true, groupState: "settled" },
    cancelled: false, guiInteraction: "not-run", modelAccount: "not-configured" };
}
function execution() {
  return { status: "passed", proof: proof(), exitCode: 0, signal: null, timedOut: false, cancelRequested: false,
    forcedTermination: false, outputInvalid: false, spawnFailed: false, durationMs: 10, cleanup: "confirmed", failure: null };
}
function child(t, source) {
  const value = spawn(process.execPath, ["-e", source], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (value.exitCode === null && value.signalCode === null) value.kill("SIGKILL"); });
  return value;
}

test("LSH projection requires every native assertion and discards private extras", () => {
  const input = { ...proof(), raw: canary, path: `/private/${canary}` };
  assert(!JSON.stringify(safeLshProof(input)).includes(canary));
  for (const key of ["installedManifest", "realProbeCompleted", "processImageMatched", "authenticatedParentPing", "normalHostShutdown", "ownedGroupSettled"])
    assert.throws(() => safeLshProof({ ...proof(), [key]: false }), /result-invalid/);
  for (const field of [{ cancelled: true }, { guiInteraction: "clicked" }, { stage: canary }, { launchStep: canary }])
    assert.throws(() => safeLshProof({ ...proof(), ...field }), /result-invalid/);
  const failedExit = { ...execution(), exitCode: 3, status: "failed", failure: "macos-lsh-proof-exit-failed" };
  assert.equal(safeLshExecution(failedExit).exitCode, 3);
  assert.throws(() => safeLshExecution({ ...failedExit, status: "passed" }), /result-invalid/);
  assert.throws(() => safeLshExecution({ ...execution(), timedOut: true }), /result-invalid/);
  const failedProof = { ...proof(), status: "failed", stage: "normal-shutdown", normalHostShutdown: false };
  assert.equal(safeLshExecution({ ...execution(), proof: failedProof, status: "failed", failure: "macos-lsh-proof-rejected" }).exitCode, 0);
});

test("shutdown facts cannot turn forced cleanup or an unknown group into normal exit", () => {
  const value = proof();
  assert(!JSON.stringify(safeLshProof({ ...value, shutdown: { ...value.shutdown, raw: canary } })).includes(canary));
  for (const key of Object.keys(value.shutdown).filter(key => key !== "groupState")) {
    assert.throws(() => safeLshProof({ ...value, shutdown: { ...value.shutdown, [key]: !value.shutdown[key] } }), /result-invalid/);
  }
  for (const groupState of ["member-running", "member-unavailable", "enumeration-incomplete", "root-unavailable", canary])
    assert.throws(() => safeLshProof({ ...value, shutdown: { ...value.shutdown, groupState } }), /result-invalid/);
  assert.throws(() => safeLshProof({ ...value, shutdown: null }), /result-invalid/);
  const failed = { ...value, status: "failed", stage: "normal-shutdown", normalHostShutdown: false,
    shutdown: { ...value.shutdown, groupSettledBeforeCleanup: false, forcedCleanup: true } };
  assert.equal(safeLshProof(failed).shutdown.forcedCleanup, true);
});

test("saved and re-published reports require LSH and preserve closed build/source facts", () => {
  const build = summarizeBuildResult({ version: "1.9.9", target: "aarch64-apple-darwin",
    sidecars: ["luckyray-native-host", "luckyray-cli", "luckyray-mcp"], mediaFiles: 1, dshFiles: 35556,
    distribution: { sourceInputsSha256: "a".repeat(64), readyToPackage: false, providedSourceInputs: 26,
      providedSourceBytes: 100, missingRequirements: [{ id: "missing-source", raw: canary }] } });
  const input = { schemaVersion: 1, mode: "internal-native-validation", binaryExport: false, status: "passed", workerExit: 0,
    workerSignal: null, source: { repository: "xiaorui2886/LuckyRay", commit: "a".repeat(40), tree: "b".repeat(40), path: canary },
    phases: PHASES.map(phase => ({ phase, status: "passed" })), build, lsh: { ...execution(), env: canary },
    distributionReady: false, raw: canary };
  const saved = publishableReport(input);
  const published = publishableReport(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(published, saved);
  assert(!JSON.stringify(published).includes(canary));
  assert.equal(published.lsh.proof.normalHostShutdown, true);
  assert.equal(published.distributionReady, false);
  assert.deepEqual(published.build.distribution.missingRequirementIds, ["missing-source"]);
  assert.throws(() => publishableReport({ ...input, lsh: null }), /result-invalid/);
  assert.throws(() => publishableReport({ ...input, workerExit: 3 }), /result-invalid/);
  assert.throws(() => publishableReport({ ...input, workerSignal: "SIGTERM" }), /result-invalid/);
  assert.throws(() => publishableReport({ ...input, distributionReady: true }), /result-invalid/);
});

test("ordinary child exit is preserved independently of the claimed JSON result", async t => {
  for (const code of [0, 3]) {
    const value = child(t, `process.stderr.write(${JSON.stringify(canary)});process.stdout.write(${JSON.stringify(JSON.stringify(proof()))});process.exitCode=${code};`);
    const result = await observeLshProof(value, { timeoutMs: 3000, cleanupMs: 1000 });
    assert.equal(result.exitCode, code);
    assert.equal(result.status, code === 0 ? "passed" : "failed");
    assert(!JSON.stringify(result).includes(canary));
  }
});

test("timeout revokes the private pipe and waits for a cleanup report and nonzero exit", async t => {
  const cancelled = { ...proof(), status: "failed", stage: "cancelled", cancelled: true, realProbeCompleted: false, normalHostShutdown: false };
  const value = child(t, `process.stdin.once('data',byte=>{if(byte.toString()!=='C')process.exit(9);process.stdout.write(${JSON.stringify(JSON.stringify(cancelled))});process.exitCode=3;process.stdin.pause();});`);
  const result = await observeLshProof(value, { timeoutMs: 30, cleanupMs: 3000 });
  assert.equal(result.status, "failed"); assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 3); assert.equal(result.proof.cancelled, true);
  assert.equal(result.cleanup, "confirmed"); assert.equal(result.forcedTermination, false);
  assert.equal(result.failure, "macos-lsh-proof-timeout");
});

test("an unresponsive child is killed after grace and never claims group cleanup", async t => {
  const value = child(t, "process.stdin.resume();setInterval(()=>{},1000);");
  const result = await observeLshProof(value, { timeoutMs: 30, cleanupMs: 60 });
  assert.equal(result.status, "failed"); assert.equal(result.timedOut, true);
  assert.equal(result.forcedTermination, true); assert.equal(result.signal, "SIGKILL");
  assert.equal(result.exitCode, null); assert.equal(result.cleanup, "unconfirmed");
  assert.equal(result.proof, null);
});

test("malformed or oversized stdout never becomes published proof", async t => {
  for (const output of [canary, "x".repeat(65537)]) {
    const value = child(t, `process.stdout.write(${JSON.stringify(output)});`);
    const result = await observeLshProof(value, { timeoutMs: 3000, cleanupMs: 1000 });
    assert.equal(result.status, "failed"); assert.equal(result.outputInvalid, true);
    assert.equal(result.proof, null); assert(!JSON.stringify(result).includes(canary));
  }
});
