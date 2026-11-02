// Real ordinary child processes cover observer cleanup and projection, not Mac UI.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { NOTE_UI_FLAGS, safeNoteFlow, safeNotePhase, noteScenarioRecord, emptyNoteFlow, observeNotePhase, NOTE_SOURCES } from "../scripts/check-macos-note-flow.mjs";
import { PHASES, publishableReport, summarizeBuildResult } from "../scripts/check-macos-internal.mjs";
import { NOTE_DATA_CASES } from "../scripts/check-macos-note-data.mjs";
const canary = "note-flow-private-material-must-not-escape";
const record = phase => ({ schemaVersion: 1, mode: "macos-note-flow", phase, status: "passed", step: phase === "exercise" ? "recover" : "reopen",
  uiFlags: NOTE_UI_FLAGS[phase].map(() => true), backendVerified: true, raw: canary });
function phase(phase) {
  return { ...emptyNoteFlow()[phase], ...noteScenarioRecord(record(phase), phase), filesVerified: true, normalSavedQuit: true,
    screenshotCaptured: phase === "reopen", exitCode: 0, raw: canary };
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
  const data = { status: "passed", compiled: true, failure: "none", cases: NOTE_DATA_CASES.map(({ id }) => ({ id, status: "passed", exit: 0 })) };
  const input = { schemaVersion: 1, mode: "internal-native-validation", binaryExport: false, status: "failed", workerExit: 1, workerSignal: null,
    source: { repository: "xiaorui2886/LuckyRay", commit: "a".repeat(40), tree: "b".repeat(40) }, build: null, lsh: null, noteData: data,
    distributionReady: false, diagnostics: {}, failure: { code: "macos-note-data-source-input-missing" },
    phases: PHASES.map((phase, i) => ({ phase, status: i < 2 ? "passed" : i === 2 ? "failed" : "not-run" })) };
  const result = publishableReport(input);assert.equal(result.noteData.passedCount, 20);assert.equal(result.notesUi.status, "not-run");
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
  for (const text of Object.values(NOTE_SOURCES)) assert(rust.includes(JSON.stringify(text).slice(1, -1)));
  const driver = await readFile(new URL('../src-tauri/src/macos_note_flow_driver.js', import.meta.url), 'utf8');
  assert(driver.includes('new DragEvent("drop"'));assert(driver.includes('invoke("close_window")'));
  assert(driver.includes('set(versions, \'retained\')'));assert(!driver.includes('knowledge_recover_note_version'));
  const page = await readFile(new URL('../src/features/notes/NotesPage.tsx', import.meta.url), 'utf8');
  const panel = await readFile(new URL('../src/features/notes/NoteRecoveryPanel.tsx', import.meta.url), 'utf8');
  for (const action of ['move','delete','confirm-delete','refresh-vault']) assert(page.includes(`data-note-action="${action}"`));
  for (const action of ['panel','refresh','records','versions','copy','restore','restore-unavailable']) assert(panel.includes(`data-note-recovery="${action}"`));
});
