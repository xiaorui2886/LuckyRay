// One fixed synthetic notes exercise and same-profile restart, in the real app.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, realpath, lstat } from "node:fs/promises";
import { APP, TAURI, TARGET, directory, readRegular, writeNew, sha256, run, requireNative, isMacosValidationRepository } from "./macos-build-common.mjs";
import { FIXTURE } from "./check-macos-material-flow.mjs";
import { knownProofSignal } from "./check-macos-lsh-proof.mjs";

export const NOTE_PHASES = Object.freeze(["exercise", "reopen"]);
export const NOTE_STEPS = Object.freeze(["not-started", "setup", "import", "preview", "save", "move", "delete", "conflict", "recover",
  "folder-dirty", "folder-rename", "folder-move", "folder-delete", "folder-restore", "graph", "reopen", "quit"]);
export const NOTE_UI_FLAGS = Object.freeze({ exercise: ["imported", "previewDecoded", "edited", "moved", "deleted", "conflictShown", "recoveryCopyShown",
  "folderDirtyBlocked", "folderRenamed", "folderMoved", "folderDeleted", "folderRestored", "graphRendered", "graphSearchResolved", "folderAttachmentPreviewDecoded"],
  reopen: ["persistedNoteShown", "persistedPreviewDecoded", "persistedRecoveryShown", "persistedFolderNoteAndPreviewShown", "persistedFolderRecoveryShown", "persistedGraphResolved"] });
export const NOTE_SOURCES = Object.freeze({ "Synthetic.md": "# Synthetic\n\nSynthetic note.\n\n![fixture](attachments/note-flow.png)\n", "Delete.md": "# Delete\n\nSynthetic delete.\n" });
export const FOLDER_SOURCE = "# FolderNote\n\nSynthetic folder child.\n\n![fixture](attachments/folder-flow.png)\n";
export const NOTE_FILES = Object.freeze(["Moved/Synthetic.md", "Delete.md", "Delete-recovered.md", "attachments/note-flow.png", "Destination/Renamed/FolderNote.md", "Destination/Renamed/attachments/folder-flow.png"]);
export const NOTE_TIMEOUT_MS = 10 * 60 * 1000;
export const NOTE_CLEANUP_MS = 90000;
const FAILURE = ["none", "spawn-failed", "timeout", "cancelled", "forced-termination", "output-invalid", "scenario-failed", "files-changed", "quit-failed", "window-failed", "context-invalid", "driver-unavailable"];
const BOOLS = ["backendVerified", "filesVerified", "normalSavedQuit", "screenshotCaptured", "timedOut", "cancelRequested", "forcedTermination", "spawnFailed", "outputInvalid"];
const PREVIEW_BOOLS = ["syntheticRowActive", "controlPresent", "controlVisible", "previewPresent", "previewVisible", "missingAsset", "imagePresent", "imageVisible", "imageComplete"];
const PREVIEW_INTERACTION_BOOLS = ["selectionReadyEvent", "targetHostMatched", "clickCalled", "clickReturned", "clickEventObserved", "previewObservedVisible"];
const MOVE_STAGES = ["context-menu", "move-menu", "destination", "checkpoint", "open-folder", "select-moved", "preview-moved",
  "rename-menu", "rename-input", "rename-checkpoint", "restore-menu", "restore-input", "restore-checkpoint"];
const DELETE_STAGES = ["context-menu", "delete-menu", "confirm", "checkpoint", "tree-update"];
const DELETE_UI_BOOLS = ["deleteRowHasBox", "deleteActionHasBox", "confirmHasBox"];
const DELETE_NATIVE_BOOLS = ["checkpointPassed", "sourceMissingVerified", "retainedOriginalVerified"];
const IMPORT_STAGES = ["close-settings", "construct-transfer", "populate-transfer", "dispatch-drop", "wait-tree", "checkpoint"];
const IMPORT_UI_BOOLS = ["rootHasBox", "syntheticRowHasBox", "deleteRowHasBox", "transferCreated", "filesAdded", "dropDispatched", "dropDefaultPrevented"];
const IMPORT_NATIVE_BOOLS = ["checkpointPassed", "syntheticContentVerified", "deleteContentVerified", "attachmentHashVerified"];
const RECOVERY_STAGES = ["destination", "copy", "copy-status", "checkpoint", "close-recovery", "refresh-open", "refresh-action", "refresh-close",
  "select-recovered", "source-control", "recovered-content", "open-moved", "preview-moved"];
const RECOVERY_UI_BOOLS = ["selectionClickCalled", "selectionClickReturned", "selectionReadyEvent", "recoveredRowHasBox", "recoveredRowActive",
  "recoveredHostVisible", "sourceControlHasBox", "sourceTextareaHasBox", "recoveredContentVerified"];
const RECOVERY_NATIVE_BOOLS = ["checkpointPassed", "recoveredCopyVerified", "foreignOriginalVerified", "retainedOriginalVerified"];
const MOVE_UI_BOOLS = ["syntheticRowHasBox", "moveActionHasBox", "moveTargetHasBox", "movedChevronHasBox", "movedChevronOpen", "originalRowHasBox", "movedRowHasBox"];
const MOVE_SELECTION_BOOLS = ["selectionClickCalled", "selectionClickReturned", "selectionReadyEvent", "destinationRowActive", "destinationHostVisible"];
const MOVE_NATIVE_BOOLS = ["checkpointPassed", "sourceMissingVerified", "destinationReadVerified", "savedMarkerVerified", "rewrittenLinkVerified", "attachmentHashVerified"];
export const FOLDER_STAGES = Object.freeze(["not-entered", "dirty-open", "dirty-input", "dirty-menu", "dirty-veto", "dirty-checkpoint",
  "save-request", "save-checkpoint", "save-idle", "rename-menu", "rename-input", "rename-submit", "rename-checkpoint", "rename-open", "rename-host", "rename-source-retired",
  "move-menu", "move-destination", "move-checkpoint", "move-open", "move-host", "move-source-retired", "attachment-preview",
  "delete-menu", "delete-confirm", "delete-checkpoint", "delete-tree", "restore-panel", "restore-refresh", "restore-action", "restore-checkpoint", "restore-tree",
  "graph-open", "graph-canvas", "graph-search", "graph-select", "graph-checkpoint", "return-note", "reopen-note", "reopen-marker", "reopen-folder", "reopen-checkpoint"]);
export const FOLDER_UI_BOOLS = Object.freeze(["unsaved", "savePending", "operationPending", "renameActionPresent", "renameInputPresent", "renameValueCorrect",
  "sourceFolderPresent", "renamedFolderPresent", "movedFolderPresent", "sourceHostVisible", "renamedHostVisible", "movedHostVisible",
  "renamedRowActive", "movedRowActive", "draftMarkerVisible", "previewDecoded", "recoveryPanelPresent", "restoreEnabled", "graphPanePresent", "graphSearchNewPath"]);
export const FOLDER_NATIVE_BOOLS = Object.freeze(["sourceDirectoryOriginal", "renamedDirectoryOriginal", "movedDirectoryOriginal",
  "sourceNoteMatchesSaved", "renamedNoteMatchesSaved", "movedNoteMatchesSaved", "sourceImageOriginal", "renamedImageOriginal", "movedImageOriginal",
  "emptyDirectoryOriginal", "emptyDirectoryMissing"]);
const FOLDER_PRODUCT_STAGES = ["idle", "preparing", "ready", "running", "completed", "interrupted", "blocked-draft", "unknown"];
const FOLDER_FAILURES = ["wait-timeout", "checkpoint-context", "stale-source-host", "stale-moved-host", "draft-not-preserved", "reopen-draft-missing", "graph-stale-path", "other"];
const PREVIEW_ENUMS = { action: ["not-entered", "already-visible", "toggle-requested"], mediaState: ["missing", "loading", "error", "unavailable", "other", "no-status"],
  uriKind: ["missing", "asset", "asset-localhost", "workspace-attachment", "blob", "data", "other"],
  resolution: ["resolved-fixture", "resolved-other", "missing", "ambiguous", "other", "error", "timeout"],
  fixtureDecode: ["passed", "wrong-size", "unsupported", "error", "timeout"],
  reconstructedUriKind: ["missing", "asset", "asset-localhost", "workspace-attachment", "blob", "data", "other"],
  reconstructedAssetDecode: ["not-run", "passed", "wrong-size", "unsupported", "unexpected-uri", "error", "timeout"] };
const invalid = () => { throw new Error("macos-note-flow-result-invalid"); };
const blank = phase => ({ phase, status: "not-run", step: "not-started", flags: NOTE_UI_FLAGS[phase].map(() => false),
  ...Object.fromEntries(BOOLS.map(key => [key, false])), exitCode: null, signal: null, failure: "none", previewObservation: null, moveObservation: null, deleteObservation: null, importObservation: null, recoveryObservation: null, folderObservation: null });
export const emptyNoteFlow = () => ({ schemaVersion: 1, status: "not-run", interaction: "application-dom-automation",
  sourceUnchanged: false, exercise: blank("exercise"), reopen: blank("reopen"), systemPointerInput: "not-run", nativeFilePicker: "not-run" });

export function safePreviewObservation(value) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value) || PREVIEW_BOOLS.some(key => typeof value[key] !== "boolean")
      || Object.entries(PREVIEW_ENUMS).some(([key, values]) => !values.includes(value[key]))
      || ["width", "height"].some(key => !Number.isInteger(value[key]) || value[key] < 0 || value[key] > 32768)
      || value.controlVisible && !value.controlPresent || value.previewVisible && !value.previewPresent
      || !value.imagePresent && (value.imageVisible || value.imageComplete || value.width !== 0 || value.height !== 0 || value.uriKind !== "missing")
      || value.imagePresent && value.uriKind === "missing") invalid();
  const interaction = value.interaction;
  if (interaction != null && (typeof interaction !== "object" || Array.isArray(interaction)
      || PREVIEW_INTERACTION_BOOLS.some(key => typeof interaction[key] !== "boolean")
      || interaction.targetHostMatched && !interaction.selectionReadyEvent
      || (interaction.clickCalled || interaction.previewObservedVisible) && !interaction.targetHostMatched
      || (interaction.clickReturned || interaction.clickEventObserved) && !interaction.clickCalled)) invalid();
  return { ...Object.fromEntries(PREVIEW_BOOLS.map(key => [key, value[key]])), ...Object.fromEntries(Object.keys(PREVIEW_ENUMS).map(key => [key, value[key]])),
    width: value.width, height: value.height,
    ...(interaction == null ? {} : { interaction: Object.fromEntries(PREVIEW_INTERACTION_BOOLS.map(key => [key, interaction[key]])) }) };
}
export function safeMoveObservation(value) {
  if (value == null) return null;
  const ui = value?.ui, native = value?.native;
  if (typeof value !== "object" || Array.isArray(value) || !ui || typeof ui !== "object" || Array.isArray(ui)
      || !native || typeof native !== "object" || Array.isArray(native) || !MOVE_STAGES.includes(ui.stage)
      || MOVE_UI_BOOLS.some(key => typeof ui[key] !== "boolean") || MOVE_NATIVE_BOOLS.some(key => typeof native[key] !== "boolean")
      || MOVE_SELECTION_BOOLS.some(key => ui[key] !== undefined && typeof ui[key] !== "boolean")
      || ui.movedChevronOpen && !ui.movedChevronHasBox
      || ui.selectionClickReturned === true && ui.selectionClickCalled !== true
      || (native.savedMarkerVerified || native.rewrittenLinkVerified) && !native.destinationReadVerified) invalid();
  return { ui: { stage: ui.stage, ...Object.fromEntries(MOVE_UI_BOOLS.map(key => [key, ui[key]])),
    ...Object.fromEntries(MOVE_SELECTION_BOOLS.map(key => [key, ui[key] === true])) },
    native: Object.fromEntries(MOVE_NATIVE_BOOLS.map(key => [key, native[key]])) };
}
export function safeDeleteObservation(value) {
  if (value == null) return null;
  const ui = value?.ui, native = value?.native;
  if (typeof value !== "object" || Array.isArray(value) || !ui || typeof ui !== "object" || Array.isArray(ui)
      || !native || typeof native !== "object" || Array.isArray(native) || !DELETE_STAGES.includes(ui.stage)
      || DELETE_UI_BOOLS.some(key => typeof ui[key] !== "boolean")
      || DELETE_NATIVE_BOOLS.some(key => typeof native[key] !== "boolean")) invalid();
  return { ui: { stage: ui.stage, ...Object.fromEntries(DELETE_UI_BOOLS.map(key => [key, ui[key]])) },
    native: Object.fromEntries(DELETE_NATIVE_BOOLS.map(key => [key, native[key]])) };
}
export function safeImportObservation(value) {
  if (value == null) return null;
  const ui = value?.ui, native = value?.native;
  if (typeof value !== "object" || Array.isArray(value) || !ui || typeof ui !== "object" || Array.isArray(ui)
      || !native || typeof native !== "object" || Array.isArray(native) || !IMPORT_STAGES.includes(ui.stage)
      || IMPORT_UI_BOOLS.some(key => typeof ui[key] !== "boolean") || IMPORT_NATIVE_BOOLS.some(key => typeof native[key] !== "boolean")
      || ui.filesAdded && !ui.transferCreated || ui.dropDispatched && !ui.filesAdded
      || ui.dropDefaultPrevented && !ui.dropDispatched) invalid();
  return { ui: { stage: ui.stage, ...Object.fromEntries(IMPORT_UI_BOOLS.map(key => [key, ui[key]])) },
    native: Object.fromEntries(IMPORT_NATIVE_BOOLS.map(key => [key, native[key]])) };
}
export function safeRecoveryObservation(value) {
  if (value == null) return null;
  const ui = value?.ui, native = value?.native;
  if (typeof value !== "object" || Array.isArray(value) || !ui || typeof ui !== "object" || Array.isArray(ui)
      || !native || typeof native !== "object" || Array.isArray(native) || !RECOVERY_STAGES.includes(ui.stage)
      || RECOVERY_UI_BOOLS.some(key => typeof ui[key] !== "boolean") || RECOVERY_NATIVE_BOOLS.some(key => typeof native[key] !== "boolean")
      || ui.selectionClickReturned && !ui.selectionClickCalled || ui.recoveredRowActive && !ui.recoveredRowHasBox
      || ui.recoveredContentVerified && !ui.sourceTextareaHasBox) invalid();
  return { ui: { stage: ui.stage, ...Object.fromEntries(RECOVERY_UI_BOOLS.map(key => [key, ui[key]])) },
    native: Object.fromEntries(RECOVERY_NATIVE_BOOLS.map(key => [key, native[key]])) };
}
export function safeFolderObservation(value) {
  if (value == null) return null;
  const ui = value.ui, native = value.native;
  if (!FOLDER_STAGES.includes(ui?.stage) || !FOLDER_PRODUCT_STAGES.includes(ui?.productStage) || !FOLDER_FAILURES.includes(ui?.failure)
      || FOLDER_UI_BOOLS.some(key => typeof ui?.[key] !== "boolean") || FOLDER_NATIVE_BOOLS.some(key => typeof native?.[key] !== "boolean")
      || !Number.isInteger(native?.checkpointCount) || native.checkpointCount < 0 || native.checkpointCount > 14
      || ui.renameValueCorrect && !ui.renameInputPresent || ui.graphSearchNewPath && !ui.graphPanePresent) invalid();
  return { ui: { stage: ui.stage, productStage: ui.productStage, failure: ui.failure, ...Object.fromEntries(FOLDER_UI_BOOLS.map(key => [key, ui[key]])) },
    native: { checkpointCount: native.checkpointCount, ...Object.fromEntries(FOLDER_NATIVE_BOOLS.map(key => [key, native[key]])) } };
}
export function safeNotePhase(value, phase) {
  if (!NOTE_PHASES.includes(phase) || value?.phase !== phase || !["not-run", "failed", "passed"].includes(value.status)
      || !NOTE_STEPS.includes(value.step) || !FAILURE.includes(value.failure) || BOOLS.some(key => typeof value[key] !== "boolean")
      || !Array.isArray(value.flags) || value.flags.length !== NOTE_UI_FLAGS[phase].length || value.flags.some(v => typeof v !== "boolean")
      || value.exitCode !== null && (!Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255)
      || value.signal !== null && !knownProofSignal(value.signal)
      || (value.timedOut || value.forcedTermination) && !value.cancelRequested) invalid();
  const previewObservation = safePreviewObservation(value.previewObservation);
  if (previewObservation && (value.status !== "failed" || value.step !== "preview")) invalid();
  const moveObservation = safeMoveObservation(value.moveObservation);
  if (moveObservation && (value.status !== "failed" || value.step !== "move" || phase !== "exercise")) invalid();
  const deleteObservation = safeDeleteObservation(value.deleteObservation);
  if (deleteObservation && (value.status !== "failed" || value.step !== "delete" || phase !== "exercise")) invalid();
  const importObservation = safeImportObservation(value.importObservation);
  if (importObservation && (value.status !== "failed" || value.step !== "import" || phase !== "exercise")) invalid();
  const recoveryObservation = safeRecoveryObservation(value.recoveryObservation);
  if (recoveryObservation && (value.status !== "failed" || value.step !== "recover" || phase !== "exercise")) invalid();
  const folderObservation = safeFolderObservation(value.folderObservation);
  if (folderObservation && (value.status !== "failed" || !value.step.startsWith("folder-") && !["graph", "reopen"].includes(value.step))) invalid();
  if (value.status === "not-run") {
    if (value.step !== "not-started" || value.failure !== "none" || value.flags.some(Boolean) || BOOLS.some(k => value[k]) || value.exitCode !== null || value.signal !== null) invalid();
  } else {
    const passed = value.failure === "none" && value.flags.every(Boolean) && value.backendVerified && value.filesVerified && value.normalSavedQuit
      && (phase !== "reopen" || value.screenshotCaptured) && value.exitCode === 0 && value.signal === null
      && !["timedOut", "cancelRequested", "forcedTermination", "spawnFailed", "outputInvalid"].some(k => value[k])
      && value.step === (phase === "exercise" ? "graph" : "reopen");
    if ((value.status === "passed") !== passed || value.status === "failed" && value.failure === "none") invalid();
  }
  return { phase, status: value.status, step: value.step, flags: [...value.flags],
    ...Object.fromEntries(BOOLS.map(k => [k, value[k]])), exitCode: value.exitCode, signal: value.signal, failure: value.failure, previewObservation, moveObservation, deleteObservation, importObservation, recoveryObservation, folderObservation };
}
export function safeNoteFlow(value) {
  if (value?.schemaVersion !== 1 || value.interaction !== "application-dom-automation" || typeof value.sourceUnchanged !== "boolean") invalid();
  const exercise = safeNotePhase(value.exercise, "exercise"), reopen = safeNotePhase(value.reopen, "reopen");
  if (reopen.status !== "not-run" && exercise.status !== "passed") invalid();
  const status = exercise.status === "not-run" && reopen.status === "not-run" ? "not-run"
    : exercise.status === "passed" && reopen.status === "passed" && value.sourceUnchanged ? "passed" : "failed";
  if (value.status !== status || status === "not-run" && value.sourceUnchanged) invalid();
  return { schemaVersion: 1, status, interaction: "application-dom-automation", flagNames: NOTE_UI_FLAGS, exercise, reopen, sourceUnchanged: value.sourceUnchanged,
    systemPointerInput: "not-run", nativeFilePicker: "not-run" };
}
export function noteScenarioRecord(value, phase) {
  if (value?.schemaVersion !== 1 || value.mode !== "macos-note-flow" || value.phase !== phase
      || !["passed", "failed"].includes(value.status) || !NOTE_STEPS.includes(value.step) || typeof value.backendVerified !== "boolean"
      || !Array.isArray(value.uiFlags) || value.uiFlags.length !== NOTE_UI_FLAGS[phase]?.length || value.uiFlags.some(v => typeof v !== "boolean")
      || value.status === "passed" && (!value.uiFlags.every(Boolean) || !value.backendVerified || value.step !== (phase === "exercise" ? "graph" : "reopen"))) invalid();
  const previewObservation = safePreviewObservation(value.previewObservation);
  if (previewObservation && (value.status !== "failed" || value.step !== "preview")) invalid();
  const moveObservation = safeMoveObservation(value.moveObservation);
  if (moveObservation && (value.status !== "failed" || value.step !== "move" || phase !== "exercise")) invalid();
  const deleteObservation = safeDeleteObservation(value.deleteObservation);
  if (deleteObservation && (value.status !== "failed" || value.step !== "delete" || phase !== "exercise")) invalid();
  const importObservation = safeImportObservation(value.importObservation);
  if (importObservation && (value.status !== "failed" || value.step !== "import" || phase !== "exercise")) invalid();
  const recoveryObservation = safeRecoveryObservation(value.recoveryObservation);
  if (recoveryObservation && (value.status !== "failed" || value.step !== "recover" || phase !== "exercise")) invalid();
  const folderObservation = safeFolderObservation(value.folderObservation);
  if (folderObservation && (value.status !== "failed" || !value.step.startsWith("folder-") && !["graph", "reopen"].includes(value.step))) invalid();
  return { phase, status: value.status, step: value.step, flags: [...value.uiFlags], backendVerified: value.backendVerified, previewObservation, moveObservation, deleteObservation, importObservation, recoveryObservation, folderObservation };
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(exited, ms) {
  let timer;try { return await Promise.race([exited, new Promise(resolve => {timer = setTimeout(() => resolve(false), ms);})]); }
  finally {clearTimeout(timer);}
}
export async function observeNotePhase(child, phase, { readRecord, readQuit, verifyFiles, capture = async () => {}, timeoutMs = NOTE_TIMEOUT_MS,
  cleanupMs = NOTE_CLEANUP_MS, pollMs = 100 } = {}) {
  const row = { ...blank(phase), status: "failed", step: "setup", failure: "scenario-failed" };
  let closed = false, record = null, line = "";
  const exited = new Promise(resolve => {
    child.once("error", () => {row.spawnFailed = true; closed = true;resolve(true);});
    child.once("exit", (code, signal) => {row.exitCode = code; row.signal = signal; closed = true;resolve(true);});
  });
  child.stdin?.on("error", () => {});child.stdout?.resume();
  child.stderr?.on("data", bytes => {
    const lines = (line + bytes.toString()).split(/\r?\n/);line = lines.pop().slice(-128);
    if (lines.includes("macos-note-flow-context-invalid")) row.failure = "context-invalid";
    if (lines.includes("macos-note-flow-driver-unavailable")) row.failure = "driver-unavailable";
  });
  const cancel = () => {if (!closed && !row.cancelRequested) {row.cancelRequested = true;child.stdin?.end("C");}};
  const interrupt = () => cancel();
  process.once("SIGTERM", interrupt);process.once("SIGINT", interrupt);process.once("disconnect", interrupt);
  const timer = setTimeout(() => {if (!closed) {row.timedOut = true;cancel();}}, timeoutMs);
  try {
    while (!closed && !row.cancelRequested) {
      const value = await readRecord();
      if (value != null) {
        record = value;const projected = noteScenarioRecord(value, phase);
        Object.assign(row, { step: projected.step, flags: projected.flags, backendVerified: projected.backendVerified,
          previewObservation: projected.previewObservation, moveObservation: projected.moveObservation, deleteObservation: projected.deleteObservation, importObservation: projected.importObservation, recoveryObservation: projected.recoveryObservation, folderObservation: projected.folderObservation });
        if (projected.status !== "passed") break;
        row.filesVerified = await verifyFiles(record);
        if (!row.filesVerified) {row.failure = "files-changed";break;}
        if (phase === "reopen") {try {await capture(child.pid);row.screenshotCaptured = true;}catch {row.failure = "window-failed";break;}}
        row.failure = "none";break;
      }
      await delay(pollMs);
    }
    if (row.failure !== "none") cancel();
    while (!closed && !row.cancelRequested) await delay(pollMs);
  } catch {row.outputInvalid = true;row.failure = "output-invalid";cancel();}
  finally {
    if (!closed) {
      cancel();
      if (!await bounded(exited, cleanupMs)) {row.forcedTermination = true;child.kill("SIGKILL");await bounded(exited, 5000);}
    }
    clearTimeout(timer);
    process.removeListener("SIGTERM", interrupt);process.removeListener("SIGINT", interrupt);process.removeListener("disconnect", interrupt);
    try {
      const quit = await readQuit();
      row.normalSavedQuit = quit?.phase === phase && quit.normalSavedQuit === true;
      if (record && row.filesVerified) row.filesVerified = await verifyFiles(record);
    } catch {row.outputInvalid = true;}
    child.stdin?.destroy();child.stdout?.destroy();child.stderr?.destroy();
  }
  row.failure = row.spawnFailed ? "spawn-failed" : row.timedOut ? "timeout" : row.forcedTermination ? "forced-termination"
    : row.outputInvalid ? "output-invalid" : row.cancelRequested && row.failure === "none" ? "cancelled"
    : row.failure !== "none" ? row.failure : !row.filesVerified ? "files-changed"
    : row.exitCode !== 0 || row.signal !== null || !row.normalSavedQuit ? "quit-failed" : "none";
  row.status = row.failure === "none" ? "passed" : "failed";
  return safeNotePhase(row, phase);
}
async function verifyFiles(root, record) {
  if (!Array.isArray(record.files) || record.files.length !== NOTE_FILES.length) return false;
  for (let i = 0; i < NOTE_FILES.length; i++) {
    const b = record.files[i], path = join(root, "vault", NOTE_FILES[i]);
    if (b?.path !== NOTE_FILES[i] || !/^[0-9]{1,20}$/.test(b.device) || !/^[0-9]{1,20}$/.test(b.inode)
        || !/^[a-f0-9]{64}$/.test(b.hash) || !Number.isSafeInteger(b.bytes) || b.bytes < 1 || b.bytes > 1024 * 1024) return false;
    const before = await lstat(path, { bigint: true }), bytes = await readRegular(path, 1024 * 1024), after = await lstat(path, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || after.uid !== BigInt(process.geteuid()) || (after.mode & 0o022n)
        || before.dev !== after.dev || before.ino !== after.ino || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs
        || after.dev.toString() !== b.device || after.ino.toString() !== b.inode || bytes.length !== b.bytes || sha256(bytes) !== b.hash) return false;
  } return true;
}
function environment(home, temp, input) {
  const env = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C", XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: input.GITHUB_REPOSITORY,
    GITHUB_SHA: input.GITHUB_SHA, RUNNER_TEMP: temp };
  for (const name of ["USER", "LOGNAME", "TMPDIR", "__CF_USER_TEXT_ENCODING", "XPC_FLAGS", "XPC_SERVICE_NAME", "SECURITYSESSIONID"])
    if (typeof input[name] === "string") env[name] = input[name];
  return env;
}
export async function runNoteFlow(app, input, evidence) {
  requireNative();
  const temp = await realpath(input.RUNNER_TEMP ?? "/missing-runner-temp");
  if (app !== join(TAURI, "target", TARGET, "release/bundle/macos/LuckyRay.app") || APP !== join(temp, "luckyray-macos-internal/luckyray-app")
      || input.GITHUB_ACTIONS !== "true" || !isMacosValidationRepository(input.GITHUB_REPOSITORY) || !/^[a-f0-9]{40}$/.test(input.GITHUB_SHA ?? "")
      || evidence !== join(TAURI, ".macos-build/internal-validation-evidence")) throw new Error("macos-note-flow-context-invalid");
  const root = join(await directory(join(TAURI, "target")), `notes-flow-${randomUUID()}`);await mkdir(root, { mode: 0o700 });
  const home = await directory(join(root, "profile"));const vault = await directory(join(root, "vault"));
  const source = await directory(join(root, "source"));await directory(join(source, "attachments"));
  await directory(join(vault, "Moved"));await directory(join(vault, ".luckyray"));
  for (const name of ["Folder", "FolderEmpty", "Destination"]) await directory(join(vault, name));
  await directory(join(vault, "Folder/attachments"));
  await writeNew(join(vault, "Folder/FolderNote.md"), FOLDER_SOURCE, 0o600);
  for (const [name, text] of Object.entries(NOTE_SOURCES)) await writeNew(join(source, name), text, 0o600);
  const image = Buffer.from(FIXTURE.base64, "base64");
  if (image.length !== FIXTURE.bytes || sha256(image) !== FIXTURE.sha256) invalid();
  await writeNew(join(source, "attachments/note-flow.png"), image, 0o600);
  await writeNew(join(vault, "Folder/attachments/folder-flow.png"), image, 0o600);
  const data = await directory(join(home, "Library/Application Support/com.luckyray.desktop"));
  const registration = { id: "synthetic-macos-notes-flow", name: "Synthetic notes flow", rootPath: vault, mode: "vault-bound",
    createdAt: "2026-11-02T00:00:00Z", lastOpenedAt: "2026-11-02T00:00:00Z", schemaVersion: 1, linkUpdatePolicy: "ask" };
  // Fixture precondition only: creation/selection UI is not part of this proof.
  await writeNew(join(vault, ".luckyray/vault.json"), JSON.stringify(registration) + "\n", 0o600);await writeNew(join(data, "notes-vault-current.json"), JSON.stringify(registration) + "\n", 0o600);
  const helper = join(root, "window-probe");await run("/usr/bin/swiftc", ["-target", "arm64-apple-macos15.0", join(APP, "scripts/macos-app-window.swift"), "-o", helper]);
  const state = emptyNoteFlow();
  const read = async name => {try {return JSON.parse((await readRegular(join(root, name), 16384)).toString());}catch (e) {if (e.code === "ENOENT") return null;throw e;}};
  const sourcesUnchanged = async () => {
    try {
      for (const [name, text] of Object.entries(NOTE_SOURCES)) if (sha256(await readRegular(join(source, name))) !== sha256(Buffer.from(text))) return false;
      return sha256(await readRegular(join(source, "attachments/note-flow.png"))) === FIXTURE.sha256;
    } catch {return false;}
  };
  for (const phase of NOTE_PHASES) {
    const child = spawn(join(app, "Contents/MacOS/luckyray-app"), ["--macos-note-flow", phase, root],
      { cwd: APP, env: environment(home, temp, input), stdio: ["pipe", "pipe", "pipe"] });
    state[phase] = await observeNotePhase(child, phase, { readRecord: () => read(`${phase}-result.json`), readQuit: () => read(`${phase}-quit.json`),
      verifyFiles: record => verifyFiles(root, record), capture: async pid => {
        const result = spawnSync(helper, [String(pid)], { encoding: "utf8", timeout: 5000 });
        if (result.status !== 0) throw new Error("macos-note-flow-window-failed");
        const window = JSON.parse(result.stdout);
        if (window.pid !== pid || !Number.isSafeInteger(window.windowID) || window.windowID <= 0) throw new Error("macos-note-flow-window-failed");
        const png = join(root, "LuckyRay-note-flow.png");
        const shot = spawnSync("/usr/sbin/screencapture", ["-x", "-o", "-l", String(window.windowID), png], { stdio: "ignore", timeout: 5000 });
        if (shot.status !== 0 || child.exitCode !== null || child.signalCode !== null) throw new Error("macos-note-flow-window-failed");
        const bytes = await readRegular(png, 32 * 1024 * 1024);
        if (bytes.length < 1024 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("macos-note-flow-window-failed");
        await writeNew(join(evidence, "LuckyRay-note-flow.png"), bytes, 0o600);
      } });
    state.sourceUnchanged = await sourcesUnchanged();state.status = "failed";
    if (state[phase].status !== "passed" || !state.sourceUnchanged) return safeNoteFlow(state);
  }
  state.status = "passed";return safeNoteFlow(state);
}
