// Actual driver in a synthetic DOM. These tests do not run the Mac application.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import vm from "node:vm";
import { emptyNoteFlow, noteScenarioRecord, observeNotePhase, safeDeleteObservation, safeImportObservation, safeMoveObservation, safeNoteFlow, safeNotePhase, safeRecoveryObservation, safeFolderObservation, FOLDER_NATIVE_BOOLS, NOTE_SOURCES, NOTE_UI_FLAGS, FOLDER_SOURCE } from "../scripts/check-macos-note-flow.mjs";
import { PHASES, publishableReport, summarizeBuildResult } from "../scripts/check-macos-internal.mjs";
import { INTEGRATION_NATIVE_CASES } from "../scripts/check-macos-note-data.mjs";

const source = await readFile(new URL("../src-tauri/src/macos_note_flow_driver.js", import.meta.url), "utf8");
const canary = "private-path-or-error-must-not-escape";

async function runDriver(failure) {
  const s = { modal: true, imported: false, afterSave: false, moved: false, selected: null, menu: false,
    dialog: false, folderOpen: false, targetClicks: 0, oldRowClicks: 0, treeDelay: 0, reports: [], movedChecks: 0,
    name: "Synthetic", renameInputVisible: false, renameCount: 0, deleted: false, foreign: false, confirm: false,
    copyCreated: false, destinationSet: false, sourceMode: failure === "recovery-already-source", sourceClicks: 0,
    productFolder: 'Folder', productFolderDirty: false, productFolderStage: 'idle', productFolderMenu: false,
    productRename: false, productMove: false, productDeleteConfirm: false, productDeleted: false, productRestored: false,
    graphSide: false, graphScope: false, checkpoints: [] };
  const recoveryScenario = failure.startsWith("recover");
  const listeners = new Map();
  const emit = (name, event) => { for (const listener of listeners.get(name) || []) listener(event); };
  const browserWindow = { addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set());listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); } };
  class Element {
    getClientRects() { return [1]; }
    click() {}
    dispatchEvent() {}
  }
  class HTMLSelectElement extends Element {
    constructor() { super();this.disabled = false;this.innerValue = "reference"; }
    set value(value) { this.innerValue = value; } get value() { return this.innerValue; }
  }
  class HTMLInputElement extends Element {
    set value(value) { this.innerValue = value; } get value() { return this.innerValue; }
    dispatchEvent(event) {
      if (event.type === "keydown" && event.key === "Enter") {
        s.name = this.innerValue; s.renameInputVisible = false; s.renameCount++;
        s.selected = `real-vault:Moved/${s.name}.md`;
        queueMicrotask(() => emit("luckyray:notes-active-note", { detail: { noteId: s.selected } }));
      }
    }
  }
  class HTMLTextAreaElement extends Element {
    constructor() { super();this.innerValue = "![fixture](attachments/note-flow.png)"; }
    set value(value) { this.innerValue = value; } get value() { return this.innerValue; }
    focus() {}
  }
  const generic = new Element(), policy = new HTMLSelectElement(), editor = new HTMLTextAreaElement(), renameInput = new HTMLInputElement();
  const recoveredEditor = new HTMLTextAreaElement();recoveredEditor.innerValue = "Synthetic delete.";
  const recoverySource = new Element();recoverySource.classList = { contains: name => name === "active" && s.sourceMode };
  recoverySource.click = () => { s.sourceClicks++; s.sourceMode = !s.sourceMode; };
  const chooser = new Element();chooser.querySelectorAll = () => [{ click() { s.modal = false; } }, {}, {}];
  const note = title => {
    const row = new Element();
    const updatedTree = s.moved && s.treeDelay === 0 && failure !== "stale-tree-stuck";
    const id = title === 'FolderNote' ? `real-vault:${s.productFolder}/FolderNote.md`
      : updatedTree && !["Delete", "Delete-recovered"].includes(title) ? `real-vault:Moved/${title}.md` : `real-vault:${title}.md`;
    row.querySelector = () => ({ textContent: `${title}.md` });
    row.getAttribute = name => name === "data-folder-document-id" ? id : null;
    row.classList = { contains: name => name === "active" && s.selected === id };
    row.click = () => {
      if (s.moved && id === "real-vault:Synthetic.md") s.oldRowClicks++;
      s.selected = id;
      if (!(s.moved && failure === "select-moved") && !(title === "Delete-recovered" && failure === "recover-select-recovered"))
        queueMicrotask(() => emit("luckyray:notes-active-note", { detail: { noteId: id } }));
    };
    row.dispatchEvent = () => {
      if (failure === "move-menu" && !s.moved || failure === "rename-menu" && s.moved && title === "Synthetic"
          || failure === "restore-menu" && title === "Renamed") return;
      s.menu = true;
    };
    return row;
  };
  const rows = () => {
    const result = !s.imported ? [] : [
      ...(s.afterSave && failure === "context-menu" ? [] : [note(s.name)]),
      ...(!s.deleted || s.foreign ? [note("Delete")] : []),
      ...(s.copyCreated ? [note("Delete-recovered")] : []),
      ...(recoveryScenario ? [note('FolderNote')] : []),
    ];
    if (s.treeDelay > 0) s.treeDelay--;
    return result;
  };
  const moveAction = new Element();moveAction.click = () => { s.menu = false;s.dialog = true; };
  const renameAction = new Element();renameAction.click = () => {
    s.menu = false;
    s.renameInputVisible = !(failure === "rename-input" && s.name === "Synthetic" || failure === "restore-input" && s.name === "Renamed");
  };
  const deleteAction = new Element();deleteAction.click = () => { s.menu = false; s.confirm = true; };
  const confirmDelete = new Element();confirmDelete.click = () => { s.deleted = true; s.confirm = false; };
  const panel = new Element();panel.open = true;
  const records = new HTMLSelectElement();records.options = [{ textContent: " · Delete.md · ", value: "record" }];
  const versions = new HTMLSelectElement();versions.options = [{ textContent: "retained", value: "retained" }];
  const destination = new HTMLInputElement();destination.dispatchEvent = () => { s.destinationSet = true; };
  const copy = new Element();copy.disabled = false;copy.click = () => { s.copyCreated = true; };
  const restore = new Element();restore.disabled = true;
  const copyStatus = new Element();copyStatus.textContent = "已另存：synthetic";
  const moveTarget = new Element();moveTarget.click = () => {
    s.targetClicks++;s.dialog = false;s.moved = true;
    if (["stale-tree", "stale-tree-stuck"].includes(failure)) s.treeDelay = 3;
  };
  const chevron = new Element();chevron.classList = { contains: name => name === "open" && s.folderOpen };
  chevron.click = () => { s.folderOpen = true; };
  const preview = new Element();
  const image = new Element();Object.assign(image, { complete: true, naturalWidth: 32, naturalHeight: 24, src: "asset://localhost/fixture" });
  const folderEditor = new HTMLTextAreaElement();folderEditor.innerValue = FOLDER_SOURCE;
  folderEditor.dispatchEvent = event => {
    if (event.type === 'input') s.productFolderDirty = true;
    if (event.type === 'keydown' && event.key === 's') s.productFolderDirty = false;
  };
  const folderSource = new Element();folderSource.classList = { contains: () => true };
  const host = new Element();host.hidden = false;host.getAttribute = () => s.selected;
  host.querySelectorAll = selector => s.selected?.endsWith('/FolderNote.md')
    ? selector === '[data-note-action="source"]' ? [folderSource]
      : selector === '.note-content-area textarea' ? [folderEditor]
      : selector === '.note-preview' ? [preview]
      : selector === '.note-preview img' && failure !== 'recovery-folder-preview-missing' ? [image] : []
    : selector === ".note-preview" ? [preview]
    : selector === ".note-preview img" ? s.moved && failure === "preview-moved" ? [] : [image]
    : selector === '[data-note-action="source"]' && s.selected === "real-vault:Delete-recovered.md" && failure !== "recover-source-control" ? [recoverySource]
    : selector === '.note-content-area textarea' && s.selected === "real-vault:Delete-recovered.md" && s.sourceMode && failure !== "recover-recovered-content" ? [recoveredEditor] : [];
  const page = new Element();page.dispatchEvent = event => {
    if (failure === "import-dispatch-drop") throw new Error(canary);
    if (failure !== "import-wait-tree") s.imported = true;
    event.defaultPrevented = true;
  };
  page.getAttribute = name => name === 'data-folder-unsaved' ? String(s.productFolderDirty)
    : name === 'data-folder-operation-stage' ? s.productFolderStage : null;
  const productChevron = new Element();productChevron.classList = { contains: () => true };
  const productFolderRow = new Element();productFolderRow.querySelector = () => productChevron;
  productFolderRow.dispatchEvent = () => { s.productFolderMenu = true; };
  const productRenameAction = new Element();productRenameAction.click = () => {
    s.productFolderMenu = false;
    if (s.productFolderDirty) s.productFolderStage = 'blocked-draft';
    else { s.productFolderStage = 'ready'; s.productRename = failure !== 'recovery-folder-rename-input'; }
  };
  const productRenameInput = new HTMLInputElement();productRenameInput.dispatchEvent = event => {
    if (event.type === 'keydown' && event.key === 'Enter') {
      s.productFolder = productRenameInput.value; s.productRename = false;
      if (failure !== 'recovery-folder-rename-host') s.selected = `real-vault:${s.productFolder}/FolderNote.md`;
    }
  };
  const productMoveAction = new Element();productMoveAction.click = () => { s.productFolderMenu = false; s.productMove = true; };
  const productMoveTarget = new Element();productMoveTarget.click = () => {
    s.productFolder = 'Destination/Renamed'; s.productMove = false;
    if (failure !== 'recovery-folder-stale-path') s.selected = `real-vault:${s.productFolder}/FolderNote.md`;
  };
  const productDeleteAction = new Element();productDeleteAction.click = () => { s.productFolderMenu = false; s.productDeleteConfirm = true; };
  const productDelete = new Element();productDelete.click = () => { s.productDeleted = true; s.productDeleteConfirm = false; };
  const productRecovery = new Element();productRecovery.open = true;productRecovery.querySelector = () => generic;
  const productRestore = new Element();productRestore.disabled = false;productRestore.click = () => { s.productDeleted = false; s.productRestored = true; };
  productRecovery.querySelectorAll = () => s.productDeleted ? [productRestore] : [];
  const graphSearch = new HTMLInputElement();graphSearch.dispatchEvent = () => {};
  const graphResult = new Element();graphResult.querySelector = () => ({ textContent: failure === 'recovery-graph-stale-path' ? 'Folder/FolderNote.md' : `${s.productFolder}/FolderNote.md` });
  graphResult.click = () => { s.graphScope = true; };
  const graphToggle = new Element();graphToggle.click = () => { s.graphSide = true; };
  const graphClose = new Element();graphClose.click = () => { s.graphSide = false; };
  const graphClear = new Element();graphClear.click = () => { s.graphScope = false; };
  const graphCanvas = new Element();Object.assign(graphCanvas, { width: 800, height: 600 });
  graphCanvas.getContext = () => ({ getImageData: () => ({ data: failure === 'recovery-graph-blank'
    ? [0, 0, 0, 0] : [32, 32, 32, 255, 180, 180, 180, 255, 120, 30, 200, 255] }) });
  const graphPane = new Element();
  graphPane.querySelector = selector => selector === '.graph-canvas' ? graphCanvas
    : selector === '.graph-side-panel.open' ? s.graphSide ? generic : null
    : selector === '.graph-side-toggle' ? graphToggle : selector === '.graph-side-close' ? graphClose
    : selector === '.graph-search-scope' ? s.graphScope ? { textContent: 'FolderNote' } : null
    : selector === '.graph-search-scope button' ? graphClear : null;
  graphPane.querySelectorAll = selector => selector === '.graph-node-finder input' ? [graphSearch]
    : selector === '.graph-find-result' ? [graphResult] : selector === '.graph-find-result small' ? [graphResult.querySelector()] : [];
  const document = { querySelectorAll(selector) {
    const folderPath = /^\[data-folder-id="([^"]+)"\]$/.exec(selector)?.[1];
    if (folderPath) return folderPath === s.productFolder || folderPath === 'Destination'
      || folderPath === 'FolderEmpty' && !s.productDeleted ? [productFolderRow] : [];
    if (selector === '[data-folder-action="rename"]') return s.productFolderMenu ? [productRenameAction] : [];
    if (selector === '[data-folder-rename-id="Folder"]') return s.productRename ? [productRenameInput] : [];
    if (selector === '[data-folder-action="move"]') return s.productFolderMenu ? [productMoveAction] : [];
    if (selector === '[data-folder-move-target="Destination"]') return s.productMove ? [productMoveTarget] : [];
    if (selector === '[data-folder-action="delete"]') return s.productFolderMenu ? [productDeleteAction] : [];
    if (selector === '[data-folder-delete-confirm="FolderEmpty"]') return s.productDeleteConfirm ? [productDelete] : [];
    if (selector === '[data-folder-recovery-panel]') return [productRecovery];
    if (selector === '[data-folder-recovery-refresh]') return [generic];
    if (selector === '[data-control-id="graph"]') return [generic];
    if (selector === '.graph-pane.active') return [graphPane];
    if (selector === ".material-import-mode-modal") return s.modal ? [chooser] : [];
    if (selector === "[data-folder-document-id]") return rows();
    if (selector === "#page-notes [data-notes-view-document]") return s.selected ? [host] : [];
    if (selector === "#page-notes") return [page];
    if (selector === "#page-notes .notes-vault-title") return [{ getClientRects: () => [1], textContent: "Synthetic notes flow" }];
    if (selector === ".attachment-handling-control select") return [policy];
    if (selector === ".notes-index-popover-header") return failure === "import-close-settings" ? [generic] : [];
    if (selector === "#page-notes .note-content-area textarea") return [editor];
    if (selector === "#page-notes .editor-status-center") return [{ getClientRects: () => [1], textContent: "Saved" }];
    if (selector === '[data-note-action="move"]') return s.menu ? [moveAction] : [];
    if (selector === '[data-note-action="rename"]') return s.menu ? [renameAction] : [];
    if (selector === '.folder-inline-rename-input') return s.renameInputVisible ? [renameInput] : [];
    if (selector === '[data-note-move-target="Moved"]') return s.dialog && failure !== "destination" ? [moveTarget] : [];
    if (selector === '[data-folder-id="Moved"] .folder-chevron') return failure === "open-folder" ? [] : [chevron];
    if (selector === '[data-note-action="delete"]') return recoveryScenario && s.menu ? [deleteAction] : [];
    if (selector === '[data-note-action="confirm-delete"]') return recoveryScenario && s.confirm ? [confirmDelete] : [];
    if (selector === '[data-note-recovery="panel"]') return recoveryScenario ? [panel] : [];
    if (selector === '[data-note-recovery="refresh"]') return recoveryScenario ? [generic] : [];
    if (selector === '[data-note-recovery="records"]') return recoveryScenario ? [records] : [];
    if (selector === '[data-note-recovery="versions"]') return recoveryScenario ? [versions] : [];
    if (selector === '[data-note-recovery="restore"]') return recoveryScenario ? [restore] : [];
    if (selector === '[data-note-recovery="restore-unavailable"]') return recoveryScenario ? [generic] : [];
    if (selector === '[data-note-recovery="destination"]') return recoveryScenario && failure !== "recover-destination" ? [destination] : [];
    if (selector === '[data-note-recovery="copy"]') return recoveryScenario && !(failure === "recover-copy" && s.destinationSet) ? [copy] : [];
    if (selector === '[data-note-recovery="status"]') return recoveryScenario && s.copyCreated && failure !== "recover-copy-status" ? [copyStatus] : [];
    if (selector === '#page-notes .notes-vault-entry') return recoveryScenario && failure !== "recover-refresh-open" ? [generic] : [];
    if (selector === '[data-note-action="refresh-vault"]') return recoveryScenario && failure !== "recover-refresh-action" ? [generic] : [];
    if (selector === '.notes-vault-dialog .editorial-dialog-close, .notes-vault-dialog-react .editorial-dialog-close, .notes-index-popover-header .editorial-dialog-close')
      return recoveryScenario && failure !== "recover-refresh-close" ? [generic] : [];
    if (selector === '.notes-index-popover-header .editorial-dialog-close' && s.copyCreated && failure === "recover-close-recovery") return [];
    if (['[data-control-id="notes"]', '#page-notes .notes-vault-settings', '.notes-index-popover-header .editorial-dialog-close',
      '#page-notes [data-note-action="source"]'].includes(selector)) return [generic];
    return [];
  } };
  const invoke = async (command, args) => {
    if (command === "macos_note_flow_checkpoint") {
      s.checkpoints.push(args.stage);
      if (args.stage === 'folder-renamed' && failure === 'recovery-folder-rename-checkpoint') return false;
      if (args.stage === "imported" && failure === "import-checkpoint") return false;
      if (args.stage === "renamed") return failure !== "rename-checkpoint" && s.name === "Renamed";
      if (args.stage === "rename-restored") return failure !== "restore-checkpoint" && s.name === "Synthetic" && s.renameCount === 2;
      if (args.stage === "deleted") return s.deleted;
      if (args.stage === "install-conflict") { s.foreign = true; return true; }
      if (args.stage === "conflict-observed") return true;
      if (args.stage === "recovered") return failure !== "recover-checkpoint" && s.copyCreated;
      if (args.stage === "saved") s.afterSave = true;
      if (args.stage === "moved") {s.movedChecks++;return failure !== "checkpoint";}
      return true;
    }
    if (command === "macos_note_flow_report") {s.reports.push(JSON.parse(JSON.stringify(args.report)));return;}
    if (command === "close_window") return;
    throw new Error(canary);
  };
  browserWindow.__TAURI_INTERNALS__ = { invoke };
  class DataTransfer {
    constructor() { if (failure === "import-construct-transfer") throw new Error(canary); }
    items = { add() { if (failure === "import-populate-transfer") throw new Error(canary); } };
  }
  class File { constructor() {} }
  class Event { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } }
  const context = { window: browserWindow, document, HTMLSelectElement, HTMLInputElement, HTMLTextAreaElement,
    Event, MouseEvent: Event, KeyboardEvent: Event, DragEvent: Event, DataTransfer, File,
    setTimeout(callback) { queueMicrotask(callback);return null; }, clearTimeout };
  await vm.runInNewContext(source, context)({ phase: "exercise", sourcePaths: ["/synthetic/Synthetic.md", "/synthetic/Delete.md"] });
  assert.equal(s.reports.length, 1);assert([...listeners.values()].every(set => set.size === 0));
  return s;
}

test("import failures identify the attempted UI stage without claiming a completed import", async () => {
  for (const stage of ["close-settings", "construct-transfer", "populate-transfer", "dispatch-drop", "wait-tree", "checkpoint"]) {
    const state = await runDriver(`import-${stage}`), report = state.reports[0];
    assert.equal(report.passed, false); assert.equal(report.step, "import");
    assert.equal(report.importObservation.stage, stage);
    assert.deepEqual(report.uiFlags, NOTE_UI_FLAGS.exercise.map(() => false));
    assert(!JSON.stringify(report).includes(canary));
  }
});

test("only fixed failed-import classifications survive report projection", async () => {
  const driver = (await runDriver("import-checkpoint")).reports[0];
  const native = { checkpointPassed: false, syntheticContentVerified: true, deleteContentVerified: true, attachmentHashVerified: false };
  const observation = { ui: { ...driver.importObservation, raw: canary }, native: { ...native, raw: canary }, raw: canary };
  const record = { schemaVersion: 1, mode: "macos-note-flow", phase: "exercise", status: "failed", step: "import",
    uiFlags: driver.uiFlags, backendVerified: false, importObservation: observation };
  const projected = noteScenarioRecord(record, "exercise");
  const phase = safeNotePhase({ ...emptyNoteFlow().exercise, ...projected, failure: "scenario-failed" }, "exercise");
  assert.equal(phase.importObservation.ui.stage, "checkpoint"); assert.deepEqual(phase.importObservation.native, native);
  assert(!JSON.stringify(phase).includes(canary));
  const flow = safeNoteFlow({ ...emptyNoteFlow(), status: "failed", sourceUnchanged: true, exercise: phase });
  assert.equal(flow.exercise.importObservation.native.attachmentHashVerified, false);
  assert(!JSON.stringify(flow).includes(canary));
  assert.equal(safeImportObservation(undefined), null);
  assert.throws(() => safeImportObservation({ ...observation, ui: { ...observation.ui, stage: canary } }), /result-invalid/);
  assert.throws(() => safeImportObservation({ ...observation, ui: { ...observation.ui, filesAdded: false } }), /result-invalid/);
  assert.throws(() => safeImportObservation({ ...observation, native: { ...observation.native, attachmentHashVerified: canary } }), /result-invalid/);
  assert.throws(() => noteScenarioRecord({ ...record, step: "move" }, "exercise"), /result-invalid/);
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(0),100)"], { stdio: ["pipe", "pipe", "pipe"] });
  let verified = 0;
  const observed = await observeNotePhase(child, "exercise", { readRecord: async () => record, readQuit: async () => null,
    verifyFiles: async () => { verified++; return true; }, timeoutMs: 3000, cleanupMs: 1000, pollMs: 2 });
  assert.equal(observed.status, "failed"); assert.equal(verified, 0);
  assert.equal(observed.importObservation.ui.stage, "checkpoint");
});

test("move failures identify the attempted stage without claiming a completed move", async () => {
  for (const failure of ["context-menu", "move-menu", "destination", "checkpoint", "open-folder", "select-moved", "preview-moved"]) {
    const state = await runDriver(failure), report = state.reports[0];
    assert.equal(report.passed, false);assert.equal(report.step, "move");assert.equal(report.moveObservation.stage, failure);
    assert.deepEqual(report.uiFlags, NOTE_UI_FLAGS.exercise.map((_, i) => i < 3));
    assert.equal(state.targetClicks, ["checkpoint", "open-folder", "select-moved", "preview-moved"].includes(failure) ? 1 : 0);
    assert.equal(report.moveObservation.movedRowHasBox, state.moved);
    assert(!JSON.stringify(report).includes(canary));
  }
});

test("passing the moved preview still requires the fixed image and does not create a failure observation", async () => {
  const state = await runDriver("delete");
  assert.equal(state.reports[0].step, "delete");assert.equal(state.reports[0].uiFlags[3], true);
  assert.equal(state.reports[0].moveObservation, null);assert.equal(state.targetClicks, 1);
  assert.equal(state.renameCount, 2); assert.equal(state.name, "Synthetic");
});

test("move cannot pass if either rename or its return is incomplete", async () => {
  for (const stage of ["rename-menu", "rename-input", "rename-checkpoint", "restore-menu", "restore-input", "restore-checkpoint"]) {
    const state = await runDriver(stage), report = state.reports[0];
    assert.equal(report.step, "move"); assert.equal(report.moveObservation.stage, stage);
    assert.equal(report.uiFlags[3], false);
  }
});

test("the move driver waits for the destination row when the source row is briefly stale", async () => {
  const state = await runDriver("stale-tree");
  assert.equal(state.oldRowClicks, 0);
  assert.equal(state.reports[0].step, "delete");
  assert.equal(state.reports[0].uiFlags[3], true);
});

test("a stale source row cannot satisfy destination selection when the tree never updates", async () => {
  const state = await runDriver("stale-tree-stuck");
  assert.equal(state.oldRowClicks, 0);
  assert.equal(state.reports[0].step, "move");
  assert.equal(state.reports[0].moveObservation.stage, "select-moved");
  assert.equal(state.reports[0].moveObservation.selectionClickCalled, false);
  assert.equal(state.reports[0].uiFlags[3], false);
});

test("failed destination selection reports click, readiness, active row and host separately", async () => {
  const state = await runDriver("select-moved"), observation = state.reports[0].moveObservation;
  assert.equal(observation.selectionClickCalled, true);
  assert.equal(observation.selectionClickReturned, true);
  assert.equal(observation.selectionReadyEvent, false);
  assert.equal(observation.destinationRowActive, true);
  assert.equal(observation.destinationHostVisible, true);
});

test("only fixed failed-move classifications survive report projection", async () => {
  const driver = (await runDriver("checkpoint")).reports[0];
  const native = { checkpointPassed: false, sourceMissingVerified: true, destinationReadVerified: true,
    savedMarkerVerified: true, rewrittenLinkVerified: false, attachmentHashVerified: true };
  const observation = { ui: { ...driver.moveObservation, raw: canary }, native: { ...native, raw: canary }, raw: canary };
  const record = { schemaVersion: 1, mode: "macos-note-flow", phase: "exercise", status: "failed", step: "move",
    uiFlags: driver.uiFlags, backendVerified: false, moveObservation: observation };
  const projected = noteScenarioRecord(record, "exercise");
  const phase = safeNotePhase({ ...emptyNoteFlow().exercise, ...projected, failure: "scenario-failed" }, "exercise");
  assert.equal(phase.moveObservation.ui.stage, "checkpoint");assert.deepEqual(phase.moveObservation.native, native);
  assert(!JSON.stringify(phase).includes(canary));
  const build = summarizeBuildResult({ version: "1.9.9", target: "aarch64-apple-darwin", sidecars: ["luckyray-native-host", "luckyray-cli", "luckyray-mcp"],
    mediaFiles: 1, dshFiles: 1, distribution: { readyToPackage: false, sourceInputsSha256: "a".repeat(64), providedSourceInputs: 1, providedSourceBytes: 1, missingRequirements: [{ id: "missing-source" }] } });
  const data = { status: "passed", compiled: true, failure: "none", cases: INTEGRATION_NATIVE_CASES.map(({ id }) => ({ id, status: "passed", exit: 0 })) };
  const internal = { schemaVersion: 1, mode: "internal-native-validation", status: "failed", binaryExport: false, workerExit: 1, workerSignal: null,
    source: { repository: "xiaorui2886/LuckyRay", commit: "a".repeat(40), tree: "b".repeat(40) }, build, noteData: data, lsh: null,
    notesUi: { ...emptyNoteFlow(), status: "failed", sourceUnchanged: true, exercise: phase }, distributionReady: false, diagnostics: {},
    failure: { code: "macos-note-flow-failed" }, phases: PHASES.map((name, i) => ({ phase: name, status: i < 6 ? "passed" : i === 6 ? "failed" : "not-run" })) };
  const published = publishableReport(publishableReport(internal));
  assert.equal(published.notesUi.exercise.moveObservation.native.rewrittenLinkVerified, false);
  assert(!JSON.stringify(published).includes(canary));
  const legacyUi = { ...observation.ui };
  for (const key of ["selectionClickCalled", "selectionClickReturned", "selectionReadyEvent", "destinationRowActive", "destinationHostVisible"]) delete legacyUi[key];
  assert.equal(safeMoveObservation({ ui: legacyUi, native }).ui.selectionClickCalled, false);
  for (const invalid of [
    { ...observation, ui: { ...observation.ui, stage: canary } },
    { ...observation, ui: { ...observation.ui, movedChevronOpen: true, movedChevronHasBox: false } },
    { ...observation, ui: { ...observation.ui, selectionClickCalled: false, selectionClickReturned: true } },
    { ...observation, ui: { ...observation.ui, selectionReadyEvent: null } },
    { ...observation, native: { ...native, destinationReadVerified: false } },
    { ...observation, native: { ...native, checkpointPassed: canary } },
  ]) assert.throws(() => safeMoveObservation(invalid), /result-invalid/);
  assert.throws(() => noteScenarioRecord({ ...record, step: "save" }, "exercise"), /result-invalid/);
  assert.throws(() => noteScenarioRecord({ ...record, phase: "reopen" }, "reopen"), /result-invalid/);
  assert.equal(noteScenarioRecord({ ...record, moveObservation: undefined }, "exercise").moveObservation, null);
});

test("observer retains failed-move diagnostics without turning the scenario into a pass", async () => {
  const driver = (await runDriver("checkpoint")).reports[0];
  const native = { checkpointPassed: false, sourceMissingVerified: true, destinationReadVerified: true,
    savedMarkerVerified: true, rewrittenLinkVerified: false, attachmentHashVerified: true };
  const record = { schemaVersion: 1, mode: "macos-note-flow", phase: "exercise", status: "failed", step: "move",
    uiFlags: driver.uiFlags, backendVerified: false, moveObservation: { ui: driver.moveObservation, native } };
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(0),100)"], { stdio: ["pipe", "pipe", "pipe"] });
  let verified = 0;
  const phase = await observeNotePhase(child, "exercise", { readRecord: async () => record, readQuit: async () => null,
    verifyFiles: async () => { verified++;return true; }, timeoutMs: 3000, cleanupMs: 1000, pollMs: 2 });
  assert.equal(phase.status, "failed");assert.equal(phase.failure, "scenario-failed");assert.equal(verified, 0);
  assert.equal(phase.moveObservation.ui.stage, "checkpoint");assert.equal(phase.moveObservation.native.rewrittenLinkVerified, false);
});

test("delete failures identify the attempted UI step and retained-source evidence without private details", async () => {
  const driver = (await runDriver("delete-menu")).reports[0];
  assert.equal(driver.step, "delete");
  assert.equal(driver.deleteObservation.stage, "delete-menu");
  const observation = { ui: { ...driver.deleteObservation, raw: canary },
    native: { checkpointPassed: false, sourceMissingVerified: true, retainedOriginalVerified: false, raw: canary }, raw: canary };
  const record = { schemaVersion: 1, mode: "macos-note-flow", phase: "exercise", status: "failed", step: "delete",
    uiFlags: driver.uiFlags, backendVerified: false, deleteObservation: observation };
  const projected = noteScenarioRecord(record, "exercise");
  const phase = safeNotePhase({ ...emptyNoteFlow().exercise, ...projected, failure: "scenario-failed" }, "exercise");
  assert.equal(phase.deleteObservation.ui.stage, "delete-menu");
  assert.equal(phase.deleteObservation.native.retainedOriginalVerified, false);
  assert(!JSON.stringify(phase).includes(canary));
  assert.equal(safeDeleteObservation(undefined), null);
  assert.throws(() => safeDeleteObservation({ ...observation, ui: { ...observation.ui, stage: canary } }), /result-invalid/);
  assert.throws(() => safeDeleteObservation({ ...observation, native: { ...observation.native, sourceMissingVerified: canary } }), /result-invalid/);
  assert.throws(() => noteScenarioRecord({ ...record, step: "move" }, "exercise"), /result-invalid/);
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(0),100)"], { stdio: ["pipe", "pipe", "pipe"] });
  let verified = 0;
  const observed = await observeNotePhase(child, "exercise", { readRecord: async () => record, readQuit: async () => null,
    verifyFiles: async () => { verified++; return true; }, timeoutMs: 3000, cleanupMs: 1000, pollMs: 2 });
  assert.equal(observed.status, "failed"); assert.equal(verified, 0);
  assert.equal(observed.deleteObservation.ui.stage, "delete-menu");
});

test("the recovered copy must be selected and hydrated before its source control is used", async () => {
  const success = await runDriver("recovery-success");
  assert.equal(success.reports[0].passed, true);
  assert.equal(success.reports[0].uiFlags[6], true);
  assert.equal(success.sourceClicks, 1);
  const alreadySource = await runDriver("recovery-already-source");
  assert.equal(alreadySource.reports[0].passed, true);
  assert.equal(alreadySource.sourceClicks, 0);
  const stale = await runDriver("recover-select-recovered");
  assert.equal(stale.reports[0].step, "recover");
  assert.equal(stale.reports[0].recoveryObservation.stage, "select-recovered");
  assert.equal(stale.reports[0].recoveryObservation.selectionClickCalled, true);
  assert.equal(stale.reports[0].recoveryObservation.selectionReadyEvent, false);
  assert.equal(stale.sourceClicks, 0);
  assert.equal(stale.reports[0].uiFlags[6], false);
});

test("folder and graph driver require updated paths, decoded attachment and restoration", async () => {
  const complete = await runDriver('recovery-success');
  assert.equal(complete.reports[0].passed, true);
  assert.deepEqual(complete.reports[0].uiFlags, NOTE_UI_FLAGS.exercise.map(() => true));
  assert.equal(complete.productRestored, true);
  for (const name of ['folder-dirty-blocked', 'folder-saved', 'folder-renamed', 'folder-moved', 'folder-deleted', 'folder-restored', 'graph-ready'])
    assert(complete.checkpoints.includes(name));
  const stale = await runDriver('recovery-folder-stale-path');
  assert.equal(stale.reports[0].passed, false);assert.equal(stale.reports[0].step, 'folder-move');
  assert.equal(stale.reports[0].uiFlags[8], true);assert.equal(stale.reports[0].uiFlags[9], false);
  const preview = await runDriver('recovery-folder-preview-missing');
  assert.equal(preview.reports[0].passed, false);assert.equal(preview.reports[0].uiFlags[14], false);
  const graph = await runDriver('recovery-graph-stale-path');
  assert.equal(graph.reports[0].passed, false);assert.equal(graph.reports[0].step, 'graph');
  assert.equal(graph.reports[0].uiFlags[13], false);
  const blank = await runDriver('recovery-graph-blank');
  assert.equal(blank.reports[0].passed, false);assert.equal(blank.reports[0].uiFlags[12], false);
});

test("folder failure diagnostics distinguish input, native checkpoint, and active host without private text", async () => {
  for (const [failure, stage] of [['recovery-folder-rename-input', 'rename-input'], ['recovery-folder-rename-checkpoint', 'rename-checkpoint'], ['recovery-folder-rename-host', 'rename-host']]) {
    const observed = (await runDriver(failure)).reports[0];
    assert.equal(observed.passed, false);assert.equal(observed.step, 'folder-rename');
    assert.equal(observed.folderObservation.stage, stage);assert.equal(observed.folderObservation.failure, 'wait-timeout');
    const native = { checkpointCount: stage === 'rename-host' ? 10 : 9, ...Object.fromEntries(FOLDER_NATIVE_BOOLS.map(key => [key, false])) };
    const observation = { ui: { ...observed.folderObservation, raw: canary }, native: { ...native, raw: canary }, raw: canary };
    const safe = safeFolderObservation(observation);
    assert.equal(safe.native.checkpointCount, native.checkpointCount);assert(!JSON.stringify(safe).includes(canary));
    const record = { schemaVersion: 1, mode: 'macos-note-flow', phase: 'exercise', status: 'failed', step: 'folder-rename',
      uiFlags: observed.uiFlags, backendVerified: false, folderObservation: observation };
    const projected = noteScenarioRecord(record, 'exercise');
    const row = safeNotePhase({ ...emptyNoteFlow().exercise, ...projected, failure: 'scenario-failed' }, 'exercise');
    assert.equal(row.folderObservation.ui.stage, stage);
    if (stage === 'rename-host') { assert.equal(row.folderObservation.ui.sourceHostVisible, true);assert.equal(row.folderObservation.ui.renamedHostVisible, false); }
    for (const bad of [{ ...observation, ui: { ...observation.ui, failure: canary } },
      { ...observation, ui: { ...observation.ui, productStage: canary } },
      { ...observation, native: { ...observation.native, checkpointCount: 100 } }]) assert.throws(() => safeFolderObservation(bad), /result-invalid/);
  }
});

test("recovery failures identify their stage and project only fixed synthetic classifications", async () => {
  for (const stage of ["destination", "copy", "copy-status", "checkpoint", "close-recovery", "refresh-open", "refresh-action", "refresh-close", "source-control", "recovered-content"]) {
    const state = await runDriver(`recover-${stage}`), report = state.reports[0];
    assert.equal(report.step, "recover", stage); assert.equal(report.recoveryObservation.stage, stage);
    assert.equal(report.uiFlags[6], false); assert(!JSON.stringify(report).includes(canary));
  }
  const driver = (await runDriver("recover-recovered-content")).reports[0];
  const native = { checkpointPassed: true, recoveredCopyVerified: true, foreignOriginalVerified: true, retainedOriginalVerified: true };
  const observation = { ui: { ...driver.recoveryObservation, raw: canary }, native: { ...native, raw: canary }, raw: canary };
  const record = { schemaVersion: 1, mode: "macos-note-flow", phase: "exercise", status: "failed", step: "recover",
    uiFlags: driver.uiFlags, backendVerified: true, recoveryObservation: observation };
  const projected = noteScenarioRecord(record, "exercise");
  const phase = safeNotePhase({ ...emptyNoteFlow().exercise, ...projected, failure: "scenario-failed" }, "exercise");
  const flow = safeNoteFlow({ ...emptyNoteFlow(), status: "failed", sourceUnchanged: true, exercise: phase });
  assert.equal(flow.exercise.recoveryObservation.ui.stage, "recovered-content");
  assert.deepEqual(flow.exercise.recoveryObservation.native, native);
  assert(!JSON.stringify(flow).includes(canary));
  assert.equal(safeRecoveryObservation(undefined), null);
  assert.throws(() => safeRecoveryObservation({ ...observation, ui: { ...observation.ui, stage: canary } }), /result-invalid/);
  assert.throws(() => safeRecoveryObservation({ ...observation, ui: { ...observation.ui, selectionClickCalled: false } }), /result-invalid/);
  assert.throws(() => noteScenarioRecord({ ...record, step: "move" }, "exercise"), /result-invalid/);
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(0),100)"], { stdio: ["pipe", "pipe", "pipe"] });
  const observed = await observeNotePhase(child, "exercise", { readRecord: async () => record, readQuit: async () => null,
    verifyFiles: async () => { throw new Error("must not verify a failed flow as passed"); }, timeoutMs: 3000, cleanupMs: 1000, pollMs: 2 });
  assert.equal(observed.status, "failed");
  assert.equal(observed.recoveryObservation.native.recoveredCopyVerified, true);
});

test("a plain filesystem rename preserves the old relative link in the synthetic fixture", async () => {
  const root = await mkdtemp(join(tmpdir(), "luckyray-move-probe-"));
  try {
    await mkdir(join(root, "Moved"));
    const source = NOTE_SOURCES["Synthetic.md"] + "\nSaved by the native note flow.\n";
    await writeFile(join(root, "Synthetic.md"), source);
    await rename(join(root, "Synthetic.md"), join(root, "Moved", "Synthetic.md"));
    const moved = await readFile(join(root, "Moved", "Synthetic.md"), "utf8");
    assert.equal(moved, source);assert(moved.includes("attachments/note-flow.png"));
    assert(!moved.includes("../attachments/note-flow.png"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
