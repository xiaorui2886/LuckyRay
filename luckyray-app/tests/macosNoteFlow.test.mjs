// Real ordinary child processes cover observer cleanup and projection, not Mac UI.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { NOTE_UI_FLAGS, safeNoteFlow, safeNotePhase, noteScenarioRecord, emptyNoteFlow, observeNotePhase, NOTE_SOURCES, FOLDER_SOURCE } from "../scripts/check-macos-note-flow.mjs";
import { PHASES, publishableReport, summarizeBuildResult } from "../scripts/check-macos-internal.mjs";
import { INTEGRATION_NATIVE_CASES } from "../scripts/check-macos-note-data.mjs";
import { INTEGRATION_FRONTEND_TEST_FILES } from "../scripts/macos-frontend-test-reporter.mjs";
const canary = "note-flow-private-material-must-not-escape";
const record = phase => ({ schemaVersion: 1, mode: "macos-note-flow", phase, status: "passed", step: phase === "exercise" ? "graph" : "reopen",
  uiFlags: NOTE_UI_FLAGS[phase].map(() => true), backendVerified: true, raw: canary });
function phase(phase) {
  return { ...emptyNoteFlow()[phase], ...noteScenarioRecord(record(phase), phase), filesVerified: true, normalSavedQuit: true,
    screenshotCaptured: phase === "reopen", exitCode: 0, raw: canary };
}
// Synthetic result records exercise the projection; they do not claim a Mac run.
function publicCandidateReport() {
  const ui = { schemaVersion: 1, mode: 'macos-lsh-surface-flow', status: 'passed', stage: 'reshown',
    surfaceAttached: true, surfaceHidden: true, surfaceReshown: true, bindingPreserved: true,
    authenticatedParent: true, processImageMatched: true, officialSavedStop: false, editorsSaved: false,
    normalHostShutdown: false, ownedGroupSettled: false, shutdown: null, cancelled: false,
    backendStep: 'binding-retained', quitBlocker: 'not-run', interaction: 'application-dom-automation',
    modelAccount: 'not-configured', systemPointerInput: 'not-run' };
  const quit = { ...ui, stage: 'normal-quit', officialSavedStop: true, editorsSaved: true,
    normalHostShutdown: true, ownedGroupSettled: true, backendStep: 'normal-shutdown', quitBlocker: 'none',
    shutdown: { writeCompleted: true, acknowledged: true, rootExitedBeforeCleanup: true,
      rootSucceeded: true, groupSettledBeforeCleanup: true, forcedCleanup: false, groupSettledAfterCleanup: true,
      rootExitedAfterCleanup: true, stdoutClosed: true, stderrClosed: true, groupState: 'settled' } };
  return { schemaVersion: 1, mode: 'internal-native-validation', scope: 'full', binaryExport: false,
    status: 'passed', workerExit: 0, workerSignal: null,
    source: { repository: 'xiaorui2886/LuckyRay', commit: 'c'.repeat(40), tree: 'd'.repeat(40) },
    build: summarizeBuildResult({ version: '1.9.9', target: 'aarch64-apple-darwin', sidecars: ['luckyray-native-host', 'luckyray-cli', 'luckyray-mcp'],
      mediaFiles: 1, dshFiles: 1, distribution: { readyToPackage: false, sourceInputsSha256: 'a'.repeat(64),
        providedSourceInputs: 1, providedSourceBytes: 1, missingRequirements: [{ id: 'missing-source' }] } }),
    lsh: { status: 'passed', ui, quit, exitCode: 0, signal: null, timedOut: false, cancelRequested: false,
      forcedTermination: false, outputInvalid: false, spawnFailed: false, screenshotCaptured: true,
      observationFailure: null, durationMs: 1, cleanup: 'confirmed', failure: null },
    noteData: { status: 'passed', compiled: true, failure: 'none',
      cases: INTEGRATION_NATIVE_CASES.map(({ id }) => ({ id, status: 'passed', exit: 0 })) },
    notesUi: { ...emptyNoteFlow(), status: 'passed', sourceUnchanged: true, exercise: phase('exercise'), reopen: phase('reopen') },
    frontendChecks: { status: 'passed', cases: INTEGRATION_FRONTEND_TEST_FILES.map(file => ({ file, line: 1, column: 1, status: 'passed', errorCode: null })) },
    distributionReady: false, diagnostics: {}, failure: null,
    phases: PHASES.map(phase => ({ phase, status: 'passed' })) };
}
test("notes projection requires real data, every DOM observation, normal exit and same-profile reopen", () => {
  const input = { ...emptyNoteFlow(), status: "passed", sourceUnchanged: true, exercise: phase("exercise"), reopen: phase("reopen"), raw: canary };
  const safe = safeNoteFlow(input);assert(!JSON.stringify(safe).includes(canary));
  for (const field of ["filesVerified", "normalSavedQuit", "backendVerified", "screenshotCaptured"]) {
    assert.throws(() => safeNoteFlow({ ...input, reopen: { ...input.reopen, [field]: false } }), /result-invalid/);
  }
  for (const bad of [{ exitCode: 3 }, { signal: "SIGTERM" }, { cancelRequested: true }, { flags: [true, true, false] }])
    assert.throws(() => safeNoteFlow({ ...input, reopen: { ...input.reopen, ...bad } }), /result-invalid/);
  assert.throws(() => safeNoteFlow({ ...input, sourceUnchanged: false }), /result-invalid/);
  assert.throws(() => safeNoteFlow({ ...input, exercise: emptyNoteFlow().exercise }), /result-invalid/);
  assert.throws(() => safeNotePhase({ ...phase("exercise"), failure: canary }, "exercise"), /result-invalid/);
});
test("missing exact source reports both UI phases NOT_RUN while retaining independent native data", () => {
  const data = { status: "passed", compiled: true, failure: "none", cases: INTEGRATION_NATIVE_CASES.map(({ id }) => ({ id, status: "passed", exit: 0 })) };
  const input = { schemaVersion: 1, mode: "internal-native-validation", binaryExport: false, status: "failed", workerExit: 1, workerSignal: null,
    source: { repository: "xiaorui2886/LuckyRay", commit: "a".repeat(40), tree: "b".repeat(40) }, build: null, lsh: null, noteData: data,
    distributionReady: false, diagnostics: {}, failure: { code: "macos-note-data-source-input-missing" },
    phases: PHASES.map((phase, i) => ({ phase, status: i < 2 ? "passed" : i === 2 ? "failed" : "not-run" })) };
  const result = publishableReport(input);assert.equal(result.noteData.passedCount, INTEGRATION_NATIVE_CASES.length);assert.equal(result.notesUi.status, "not-run");
  assert.deepEqual(result.source, input.source);
  assert.throws(() => publishableReport({ ...input, source: { ...input.source, repository: "other/repo" } }), /result-invalid/);
  assert.equal(result.notesUi.exercise.status, "not-run");assert.equal(result.notesUi.reopen.status, "not-run");
  assert.equal(result.coverage.notesRecoveryUi, "not-run");assert.equal(result.lsh, null);
  assert.throws(() => publishableReport({ ...input, phases: input.phases.map((p, i) => i === 6 ? { ...p, status: "passed" } : p) }), /result-invalid/);
  const notesUi = { ...emptyNoteFlow(), status: "passed", sourceUnchanged: true, exercise: phase("exercise"), reopen: phase("reopen") };
  const build = summarizeBuildResult({ version: "1.9.9", target: "aarch64-apple-darwin", sidecars: ["luckyray-native-host", "luckyray-cli", "luckyray-mcp"],
    mediaFiles: 1, dshFiles: 1, distribution: { readyToPackage: false, sourceInputsSha256: "a".repeat(64), providedSourceInputs: 1, providedSourceBytes: 1, missingRequirements: [{ id: "missing-source" }] } });
  const afterNotes = { ...input, build, notesUi, phases: PHASES.map((phase, i) => ({ phase, status: i < 7 ? "passed" : "failed" })), failure: { code: "macos-lsh-surface-flow-scenario-failed" } };
  const retained = publishableReport(afterNotes);assert.equal(retained.notesUi.status, "passed");
  assert.equal(retained.coverage.guiInteraction, "application-dom-automation");assert.equal(retained.coverage.screenshotVisualReview, "required");
  assert.throws(() => publishableReport({ ...afterNotes, build: null }), /result-invalid/);
});
test("observer checks files before capture and again after natural saved exit", async () => {
  for (const changedAfterQuit of [false, true]) {
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(0),100)"], { stdio: ["pipe", "pipe", "pipe"] });
    let verified = 0, captured = 0;
    const result = await observeNotePhase(child, "reopen", { readRecord: async () => record("reopen"),
      readQuit: async () => ({ phase: "reopen", normalSavedQuit: true }), verifyFiles: async () => ++verified === 1 || !changedAfterQuit,
      capture: async () => {captured += 1;}, timeoutMs: 3000, cleanupMs: 1000, pollMs: 2 });
    assert.equal(verified, 2);assert.equal(captured, 1);assert.equal(result.status, changedAfterQuit ? "failed" : "passed");
    assert.equal(result.failure, changedAfterQuit ? "files-changed" : "none");
  }
});
test("timeout cancellation and forced termination never become normal UI success", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},10000)"], { stdio: ["pipe", "pipe", "pipe"] });
  const result = await observeNotePhase(child, "exercise", { readRecord: async () => null, readQuit: async () => ({ phase: "exercise", normalSavedQuit: true }),
    verifyFiles: async () => true, timeoutMs: 15, cleanupMs: 20, pollMs: 2 });
  assert.equal(result.status, "failed");assert(result.timedOut);assert(result.cancelRequested);assert(result.forcedTermination);
  assert.equal(result.signal, "SIGKILL");
});
test("scenario contracts match fixed production fixtures and production UI controls", async () => {
  const rust = await readFile(new URL('../src-tauri/src/macos_note_flow.rs', import.meta.url), 'utf8');
  for (const text of [...Object.values(NOTE_SOURCES), FOLDER_SOURCE]) assert(rust.includes(JSON.stringify(text).slice(1, -1)));
  const driver = await readFile(new URL('../src-tauri/src/macos_note_flow_driver.js', import.meta.url), 'utf8');
  assert(driver.includes('new DragEvent("drop"'));assert(driver.includes('invoke("close_window")'));
  assert(driver.includes('set(versions, \'retained\')'));assert(!driver.includes('knowledge_recover_note_version'));
  const page = await readFile(new URL('../src/features/notes/NotesPage.tsx', import.meta.url), 'utf8');
  const panel = await readFile(new URL('../src/features/notes/NoteRecoveryPanel.tsx', import.meta.url), 'utf8');
  for (const action of ['move','rename','delete','confirm-delete','refresh-vault']) assert(page.includes(`data-note-action="${action}"`));
  for (const action of ['panel','refresh','records','versions','copy','restore','restore-unavailable']) assert(panel.includes(`data-note-recovery="${action}"`));
});
test("old note-only success cannot stand in for the folder and graph candidate", () => {
  assert.throws(() => noteScenarioRecord({ ...record('exercise'), uiFlags: Array(7).fill(true), step: 'recover' }, 'exercise'), /result-invalid/);
  assert.throws(() => noteScenarioRecord({ ...record('reopen'), uiFlags: Array(3).fill(true) }, 'reopen'), /result-invalid/);
  for (const index of [7, 8, 9, 10, 11, 12, 13, 14]) {
    const candidate = record('exercise'); candidate.uiFlags[index] = false;
    assert.throws(() => noteScenarioRecord(candidate, 'exercise'), /result-invalid/);
  }
});
test("native failure remains failed while independent completed app evidence remains reportable", () => {
  const data = { status: 'failed', compiled: true, failure: 'test-failed', cases: INTEGRATION_NATIVE_CASES.map(({ id }, i) => ({ id, status: i === 0 ? 'failed' : 'passed', exit: i === 0 ? 101 : 0 })) };
  const build = summarizeBuildResult({ version: '1.9.9', target: 'aarch64-apple-darwin', sidecars: ['luckyray-native-host', 'luckyray-cli', 'luckyray-mcp'],
    mediaFiles: 1, dshFiles: 1, distribution: { readyToPackage: false, sourceInputsSha256: 'a'.repeat(64), providedSourceInputs: 1, providedSourceBytes: 1, missingRequirements: [{ id: 'missing-source' }] } });
  const report = publishableReport({ schemaVersion: 1, mode: 'internal-native-validation', binaryExport: false, status: 'failed', workerExit: 1, workerSignal: null,
    source: { repository: 'xiaorui2886/LuckyRay', commit: 'c'.repeat(40), tree: 'd'.repeat(40) }, build, noteData: data, lsh: null,
    notesUi: { ...emptyNoteFlow(), status: 'passed', sourceUnchanged: true, exercise: phase('exercise'), reopen: phase('reopen') },
    distributionReady: false, diagnostics: {}, failure: { code: 'macos-note-data-failed' },
    phases: PHASES.map((phase, i) => ({ phase, status: i === 1 || i === 7 ? 'failed' : 'passed' })) });
  assert.equal(report.status, 'failed'); assert.equal(report.noteData.cases[0].status, 'failed');
  assert.equal(report.notesUi.status, 'passed'); assert.equal(report.coverage.folderUi, 'dom-dirty-veto-rename-move-delete-original-directory-restore-and-reopen');
  assert.deepEqual(report.knownRemaining.keychainDatabaseRecreation, { status: 'unresolved', currentCandidate: 'not-run',
    knownFailure: 'returned-original-instead-of-error', strictAssertion: 'retained' });
  assert(!Object.hasOwn(report, 'historicalEvidence'));assert(!Object.hasOwn(report, 'historicalFollowupEvidence'));
  assert.equal(report.coverage.phoneSimulation.physicalPhone, 'not-run');
});

test("public full success requires all current-source native, frontend, notes and LSH results", () => {
  const input = publicCandidateReport();
  const report = publishableReport(input);
  assert.equal(report.status, 'passed');assert.equal(report.scope, 'full');assert.equal(report.noteData.total, 32);
  assert.deepEqual(report.source, input.source);assert.equal(report.notesUi.status, 'passed');assert.equal(report.lsh.status, 'passed');
  assert.equal(report.frontendChecks.passedCount, 9);assert.equal(report.distributionReady, false);
  assert.equal(report.knownRemaining.keychainDatabaseRecreation.status, 'unresolved');
  assert.equal(report.knownRemaining.keychainDatabaseRecreation.currentCandidate, 'not-run');
  assert.equal(report.coverage.phoneSimulation.physicalPhone, 'not-run');
  for (const change of [{ lsh: null }, { build: null }, { workerExit: 1 }, { workerSignal: 'SIGTERM' },
    { notesUi: emptyNoteFlow() }, { noteData: { ...input.noteData, cases: input.noteData.cases.slice(1) } },
    { frontendChecks: { status: 'passed', cases: input.frontendChecks.cases.slice(1) } },
    { phases: input.phases.map((item, i) => i === 7 ? { ...item, status: 'not-run' } : item) },
    { failure: { code: 'macos-note-data-failed' } }, { distributionReady: true }])
    assert.throws(() => publishableReport({ ...input, ...change }), /result-invalid/);
});

test("public projection rejects partial scopes and never adopts historical or invented passes", () => {
  const current = publicCandidateReport();
  const historical = { sourceCommit: 'e'.repeat(40), sourceTree: 'f'.repeat(40), runId: 'synthetic-earlier-run',
    lsh: 'passed', pairingIdentityRestart: 'passed', raw: canary };
  const input = { ...current, status: 'failed', workerExit: 1, lsh: null, noteData: null,
    phases: current.phases.map((item, i) => i === 1 || i === 7 ? { ...item, status: 'failed' } : item),
    failure: { code: 'native-worker-failed' }, historicalEvidence: historical, historicalFollowupEvidence: historical,
    knownRemaining: { keychainDatabaseRecreation: { status: 'passed', currentCandidate: 'passed' } } };
  const report = publishableReport(input);
  assert.equal(report.status, 'failed');assert.equal(report.scope, 'full');assert.equal(report.noteData, null);
  assert.deepEqual(report.source, current.source);assert.equal(report.lsh, null);assert.equal(report.coverage.lsh, 'not-completed');
  assert.equal(report.coverage.attachmentReclaim, 'not-completed');
  assert.equal(report.coverage.phoneSimulation.pairingAndIdentityRestart, 'not-run');
  assert.equal(report.knownRemaining.keychainDatabaseRecreation.status, 'unresolved');
  assert.equal(report.knownRemaining.keychainDatabaseRecreation.currentCandidate, 'not-run');
  assert.equal(report.knownRemaining.keychainDatabaseRecreation.strictAssertion, 'retained');
  assert(!Object.hasOwn(report, 'historicalEvidence'));assert(!Object.hasOwn(report, 'historicalFollowupEvidence'));
  const output = JSON.stringify(report);assert(!output.includes(canary));assert(!output.includes('synthetic-earlier-run'));
  for (const scope of ['partial', 'unchecked', '', 'constructor'])
    assert.throws(() => publishableReport({ ...current, scope }), /result-invalid/);
  assert.throws(() => publishableReport({ ...input, status: 'passed', workerExit: 0, failure: null }), /result-invalid/);
  assert.throws(() => publishableReport({ ...current, source: { ...current.source, repository: 'example/other' } }), /result-invalid/);
  assert.throws(() => publishableReport({ ...current, source: { ...current.source, commit: 'invalid' } }), /result-invalid/);
});
