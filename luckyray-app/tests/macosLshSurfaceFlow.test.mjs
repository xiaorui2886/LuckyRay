// Synthetic records and ordinary child processes test the observer/projection,
// not a Mac WebView, official DSH, or native UI acceptance.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { safeSurfaceRecord, safeSurfaceExecution, observeSurfaceFlow } from "../scripts/check-macos-lsh-surface-flow.mjs";
import { PHASES, publishableReport, summarizeBuildResult } from "../scripts/check-macos-internal.mjs";
import { NOTE_DATA_CASES } from "../scripts/check-macos-note-data.mjs";
import { emptyNoteFlow } from "../scripts/check-macos-note-flow.mjs";

const canary = "private-surface-canary-never-publish";
const uiFlags = ["surfaceAttached", "surfaceHidden", "surfaceReshown", "bindingPreserved", "authenticatedParent", "processImageMatched"];
const quitFlags = ["officialSavedStop", "editorsSaved", "normalHostShutdown", "ownedGroupSettled"];
function record(quit = false) {
  return { schemaVersion: 1, mode: "macos-lsh-surface-flow", status: "passed", stage: quit ? "normal-quit" : "reshown",
    ...Object.fromEntries(uiFlags.map(key => [key, true])), ...Object.fromEntries(quitFlags.map(key => [key, quit])),
    cancelled: false, interaction: "application-dom-automation", modelAccount: "not-configured", systemPointerInput: "not-run",
    backendStep: quit ? "normal-shutdown" : "binding-retained", quitBlocker: quit ? "none" : "not-run",
    shutdown: quit ? { writeCompleted: true, acknowledged: true, rootExitedBeforeCleanup: true, rootSucceeded: true,
      groupSettledBeforeCleanup: true, forcedCleanup: false, groupSettledAfterCleanup: true, rootExitedAfterCleanup: true,
      stdoutClosed: true, stderrClosed: true, groupState: "settled" } : null };
}
function execution() {
  return { status: "passed", ui: record(), quit: record(true), exitCode: 0, signal: null, timedOut: false,
    cancelRequested: false, forcedTermination: false, outputInvalid: false, spawnFailed: false, screenshotCaptured: true,
    observationFailure: null, durationMs: 10, cleanup: "confirmed", failure: null };
}
function child(t, source) {
  const value = spawn(process.execPath, ["-e", source], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (value.exitCode === null && value.signalCode === null) value.kill("SIGKILL"); });
  return value;
}

test("the fixed DOM driver uses actual routes in order and stops when native hide rejects", async () => {
  const source = await readFile(new URL("../src-tauri/src/dsh_host/macos_surface_flow_driver.js", import.meta.url), "utf8");
  for (const rejectHide of [false, true]) {
    let choosing = true, route = "materials";
    const clicks = [], reports = [], closed = [];
    const document = { querySelector(selector) {
      if (selector === ".material-import-mode-modal") return choosing ? {
        querySelectorAll: () => [{ click() { choosing = false; } }, {}, {}],
      } : null;
      if (selector === '.dsh-native-surface-layout[data-lsh-attached="true"]') return route === "ai" ? {} : null;
      const item = /^\[data-control-id="(ai|materials)"\]$/.exec(selector)?.[1];
      if (item) return { click() { clicks.push(item); route = item; } };
      throw new Error("unexpected selector");
    } };
    const window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
      if (command === "close_window") { closed.push(route); return; }
      assert.equal(command, "macos_lsh_surface_flow_report"); reports.push(args.report);
      if (rejectHide && args.report.step === "hidden" && !args.report.failed) throw new Error(canary);
    } } };
    await runInNewContext(source, { window, document, setTimeout: callback => queueMicrotask(callback) });
    assert.deepEqual(clicks, rejectHide ? ["ai", "materials"] : ["ai", "materials", "ai"]);
    assert.deepEqual(reports.map(r => [r.step, r.failed]), rejectHide
      ? [["attached", false], ["hidden", false], ["hidden", true]]
      : [["attached", false], ["hidden", false], ["reshown", false]]);
    assert.deepEqual(closed, rejectHide ? [] : ["ai"]);
  }
});

test("surface and saved-quit projection require every actual assertion and discard extras", () => {
  for (const quit of [false, true]) {
    const input = { ...record(quit), path: `/private/${canary}`, raw: canary };
    assert(!JSON.stringify(safeSurfaceRecord(input, quit)).includes(canary));
    for (const key of [...uiFlags, ...(quit ? quitFlags : [])])
      assert.throws(() => safeSurfaceRecord({ ...record(quit), [key]: false }, quit), /result-invalid/);
    assert.throws(() => safeSurfaceRecord({ ...record(quit), cancelled: true }, quit), /result-invalid/);
    assert.throws(() => safeSurfaceRecord({ ...record(quit), backendStep: canary }, quit), /result-invalid/);
    assert.throws(() => safeSurfaceRecord({ ...record(quit), quitBlocker: canary }, quit), /result-invalid/);
  }
  const complete = record(true);
  for (const key of Object.keys(complete.shutdown).filter(key => key !== "groupState"))
    assert.throws(() => safeSurfaceRecord({ ...complete, shutdown: { ...complete.shutdown, [key]: !complete.shutdown[key] } }, true), /result-invalid/);
  assert.throws(() => safeSurfaceRecord({ ...complete, shutdown: { ...complete.shutdown, groupState: "member-running" } }, true), /result-invalid/);
  assert.throws(() => safeSurfaceRecord(complete), /result-invalid/);
  assert.throws(() => safeSurfaceRecord(record(), true), /result-invalid/);
  for (const bad of [{ screenshotCaptured: false }, { exitCode: 3 }, { signal: "SIGTERM" }, { forcedTermination: true, cancelRequested: true }])
    assert.throws(() => safeSurfaceExecution({ ...execution(), ...bad }), /result-invalid/);
  for (const quitBlocker of ["macos-quit-stop-unconfirmed", "macos-quit-cleanup-pending", "macos-quit-recovered"])
    assert.throws(() => safeSurfaceRecord({ ...complete, quitBlocker }, true), /result-invalid/);
});

test("saved and re-published internal reports require the new visible lifecycle", () => {
  const notesUi = emptyNoteFlow();notesUi.status = "passed";notesUi.sourceUnchanged = true;
  for (const phase of ["exercise", "reopen"]) Object.assign(notesUi[phase], { status: "passed", step: phase === "exercise" ? "recover" : "reopen",
    flags: notesUi[phase].flags.map(() => true), backendVerified: true, filesVerified: true, normalSavedQuit: true,
    screenshotCaptured: phase === "reopen", exitCode: 0 });
  const noteData = { status: "passed", compiled: true, failure: "none", cases: NOTE_DATA_CASES.map(({ id }) => ({ id, status: "passed", exit: 0 })) };
  const build = summarizeBuildResult({ version: "1.9.9", target: "aarch64-apple-darwin",
    sidecars: ["luckyray-native-host", "luckyray-cli", "luckyray-mcp"], mediaFiles: 96, dshFiles: 35556,
    distribution: { sourceInputsSha256: "a".repeat(64), readyToPackage: false, providedSourceInputs: 26,
      providedSourceBytes: 100, missingRequirements: [{ id: "missing-source", raw: canary }] } });
  const input = { schemaVersion: 1, mode: "internal-native-validation", binaryExport: false, status: "passed", workerExit: 0,
    workerSignal: null, source: { repository: "xiaorui2886/LuckyRay", commit: "a".repeat(40), tree: "b".repeat(40), path: canary },
    phases: PHASES.map(phase => ({ phase, status: "passed" })), build, noteData, notesUi, lsh: { ...execution(), env: canary }, distributionReady: false };
  const saved = publishableReport(input);
  assert.deepEqual(publishableReport(JSON.parse(JSON.stringify(saved))), saved);
  assert(!JSON.stringify(saved).includes(canary));
  assert.equal(saved.lsh.quit.officialSavedStop, true);
  assert.equal(saved.coverage.guiInteraction, "application-dom-automation");
  assert.equal(saved.coverage.systemPointerInput, "not-run");
  assert.equal(saved.coverage.screenshotVisualReview, "required");
  assert.equal(saved.distributionReady, false);
  for (const bad of [{ lsh: null }, { notesUi: null }, { noteData: null }, { workerExit: 3 }, { workerSignal: "SIGTERM" }, { distributionReady: true }])
    assert.throws(() => publishableReport({ ...input, ...bad }), /result-invalid/);
});

test("a real ordinary child exit is independent of claimed UI and quit records", async t => {
  for (const code of [0, 3]) {
    let captures = 0;
    const value = child(t, `process.stderr.write(${JSON.stringify(canary)});setTimeout(()=>{process.exitCode=${code};},40);`);
    const result = await observeSurfaceFlow(value, { readUi: async () => record(), readQuit: async () => record(true),
      capture: async () => { captures++; }, timeoutMs: 3000, cleanupMs: 1000, pollMs: 5 });
    assert.equal(captures, 1); assert.equal(result.exitCode, code);
    assert.equal(result.status, code === 0 ? "passed" : "failed");
    assert(!JSON.stringify(result).includes(canary));
  }
});

test("timeout cancels by the private pipe, preserves nonzero exit, and cannot pass", async t => {
  const value = child(t, "process.stdin.once('data',x=>{if(x.toString()!=='C')process.exit(9);process.stdin.pause();process.exitCode=3;});");
  const result = await observeSurfaceFlow(value, { readUi: async () => null, readQuit: async () => null,
    capture: async () => assert.fail("no UI was ready"), timeoutMs: 30, cleanupMs: 3000, pollMs: 5 });
  assert.equal(result.status, "failed"); assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 3); assert.equal(result.forcedTermination, false);
  assert.equal(result.failure, "macos-lsh-surface-flow-timeout"); assert.equal(result.cleanup, "unconfirmed");
});

test("an unresponsive app records observer force and never claims group cleanup", async t => {
  const value = child(t, "process.stdin.resume();setInterval(()=>{},1000);");
  const result = await observeSurfaceFlow(value, { readUi: async () => null, readQuit: async () => null,
    capture: async () => {}, timeoutMs: 30, cleanupMs: 60, pollMs: 5 });
  assert.equal(result.forcedTermination, true); assert.equal(result.signal, "SIGKILL");
  assert.equal(result.status, "failed"); assert.equal(result.cleanup, "unconfirmed");
});

test("malformed UI and capture failure revoke instead of claiming an ordinary quit", async t => {
  for (const malformed of [true, false]) {
    const value = child(t, "process.stdin.once('data',()=>{process.stdin.pause();process.exitCode=3;});");
    const result = await observeSurfaceFlow(value, { readUi: async () => malformed ? { raw: canary } : record(),
      readQuit: async () => null, capture: async () => { throw new Error(canary); }, timeoutMs: 3000, cleanupMs: 1000, pollMs: 5 });
    assert.equal(result.status, "failed"); assert.equal(result.cancelRequested, true);
    assert.equal(result.outputInvalid, malformed); assert.equal(result.screenshotCaptured, false);
    assert(!JSON.stringify(result).includes(canary));
  }
});
