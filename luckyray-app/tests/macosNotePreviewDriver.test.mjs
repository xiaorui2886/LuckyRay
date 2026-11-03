// Exercise the actual fixed driver in a synthetic DOM. This is not a Mac UI test.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { FIXTURE } from "../scripts/check-macos-material-flow.mjs";
import { noteScenarioRecord, safeNotePhase, emptyNoteFlow } from "../scripts/check-macos-note-flow.mjs";
import { PHASES, publishableReport, summarizeBuildResult } from "../scripts/check-macos-internal.mjs";
import { NOTE_DATA_CASES } from "../scripts/check-macos-note-data.mjs";

const source = await readFile(new URL("../src-tauri/src/macos_note_flow_driver.js", import.meta.url), "utf8");
const pageSource = await readFile(new URL("../src/features/notes/NotesPage.tsx", import.meta.url), "utf8");
const toggleBody = pageSource.match(/const togglePreviewMode = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[commitCurrentEditorDraft, selectedNote\]\);/)?.[1];
assert(toggleBody, "production preview handler must remain identifiable");
const productionToggle = new Function("selectedNote", "commitCurrentEditorDraft", "setSourceContentDraft", "setEditorMode", toggleBody);
const canary = "private-path-or-url-must-not-escape";

async function runDriver({ startsPreview = true, loadAt = 3, sourceUrl = "asset://localhost/fixture", mediaMessage = "图片加载中",
  resolver = { status: "resolved", relativePath: "attachments/note-flow.png", absolutePath: "/synthetic/attachments/note-flow.png" },
  decode = "passed", assetDecode = "passed", convertedUrl = "asset://localhost/synthetic-fixture", missingAsset = false, button = true, selectionSticks = true,
  hydrationDelay = 0, useProductionToggle = false, selectionEvent = "matching", hostMatches = true, deliverClickEvent = true,
  ignoreClick = false, detachAfterLookup = false, collapseAt = Infinity, width = 32, height = 24, complete = true, imageVisible = true } = {}) {
  const state = { modal: true, imported: false, selected: null, hydrated: hydrationDelay === 0, preview: startsPreview, ticks: 0, toggles: 0, ignored: 0,
    reports: [], revoked: 0, blobBytes: 0, assetRequests: 0, detached: false };
  const listeners = new Map();
  const emit = (name, event) => { for (const listener of listeners.get(name) || []) listener(event); };
  const emitSelection = title => {if (selectionEvent !== "none") emit("luckyray:notes-active-note", { detail: { noteId: selectionEvent === "wrong" ? "fixed:Other" : `fixed:${title}` } });};
  const browserWindow = { __TAURI_INTERNALS__: null,
    addEventListener(name, listener) {if (!listeners.has(name)) listeners.set(name, new Set());listeners.get(name).add(listener);},
    removeEventListener(name, listener) {listeners.get(name)?.delete(listener);} };
  class Element {
    getClientRects() { return [1]; }
    click() {}
    dispatchEvent() {}
  }
  class HTMLSelectElement extends Element {
    constructor() { super(); this.disabled = false; this.innerValue = "reference"; }
    set value(value) { this.innerValue = value; }
    get value() { return this.innerValue; }
  }
  class HTMLInputElement extends Element { set value(value) { this.innerValue = value; } }
  class HTMLTextAreaElement extends Element { set value(value) { this.innerValue = value; } }
  const generic = new Element(), policy = new HTMLSelectElement();
  const chooser = new Element();chooser.querySelectorAll = () => [{ click() { state.modal = false; } }, {}, {}];
  const notes = ["Synthetic", "Delete"].map(title => {
    const el = new Element();el.querySelector = () => ({ textContent: `${title}.md` });
    el.getAttribute = name => name === "data-folder-document-id" ? `fixed:${title}` : null;
    el.classList = { contains: name => name === "active" && state.selected === title };
    el.click = () => {
      if (!selectionSticks) return;
      state.selected = title;state.hydrated = hydrationDelay === 0;
      if (state.hydrated) queueMicrotask(() => emitSelection(title));
    };return el;
  });
  const previewControl = new Element();previewControl.click = () => {
    state.toggles++;
    if (state.detached || ignoreClick) {state.ignored++;return;}
    if (deliverClickEvent) emit("click", { target: previewControl });
    if (!useProductionToggle) {state.preview = !state.preview;return;}
    const before = state.preview;
    productionToggle(state.hydrated ? { id: "synthetic" } : null, () => {}, () => {}, update => {state.preview = update(state.preview ? "preview" : "live") === "preview";});
    if (state.preview === before) state.ignored++;
  };
  const media = new Element();media.querySelector = selector => selector === ".note-media-status" && mediaMessage ? { textContent: mediaMessage } : null;
  const root = new Element();root.querySelector = selector => selector === '.note-media[data-kind="image"]' ? media
    : selector === ".note-preview-asset-link.missing" && missingAsset ? generic : null;
  const image = new Element();Object.assign(image, { complete, naturalWidth: width, naturalHeight: height, src: sourceUrl });
  image.getClientRects = () => imageVisible ? [1] : [];
  const host = new Element();host.hidden = false;host.getAttribute = name => name === "data-notes-view-document" ? hostMatches ? `fixed:${state.selected}` : "fixed:Other" : null;
  host.querySelectorAll = selector => selector === ".note-preview" ? state.preview ? [root] : []
    : selector === ".note-preview img" ? state.preview && state.ticks >= loadAt ? [image] : []
    : selector === '[data-note-action="preview"]' ? button ? (() => {if (detachAfterLookup) queueMicrotask(() => {state.detached = true;});return [previewControl];})() : [] : [];
  const page = new Element();page.dispatchEvent = () => {state.imported = true;};
  const document = { querySelectorAll(selector) {
    if (selector === ".material-import-mode-modal") return state.modal ? [chooser] : [];
    if (selector === '[data-folder-document-id]') return state.imported ? notes : [];
    if (selector === '#page-notes .note-preview') return state.preview ? [root] : [];
    if (selector === '#page-notes .note-preview img') return state.preview && state.ticks >= loadAt ? [image] : [];
    if (selector === '#page-notes [data-note-action="preview"]') return button ? [previewControl] : [];
    if (selector === '#page-notes [data-notes-view-document]') return state.selected ? [host] : [];
    if (selector === '#page-notes') return [page];
    if (selector === '#page-notes .notes-vault-title') return [{ ...generic, getClientRects: () => [1], textContent: "Synthetic notes flow" }];
    if (selector === '.attachment-handling-control select') return [policy];
    if ([ '[data-control-id="notes"]', '#page-notes .notes-vault-settings', '.notes-index-popover-header .editorial-dialog-close' ].includes(selector)) return [generic];
    return [];
  } };
  const invoke = async (command, args) => {
    if (command === "macos_note_flow_checkpoint") return true;
    if (command === "knowledge_resolve_attachment") {
      assert.deepEqual(JSON.parse(JSON.stringify(args)), { documentRef: { vaultId: "synthetic-macos-notes-flow", relativePath: "Synthetic.md" },
        destination: "attachments/note-flow.png", wiki: false });
      if (resolver instanceof Error) throw resolver;
      return resolver;
    }
    if (command === "macos_note_flow_report") {state.reports.push(JSON.parse(JSON.stringify(args.report)));return;}
    if (command === "close_window") return;
    throw new Error("unexpected command");
  };
  class MockImage {
    naturalWidth = decode === "wrong-size" || assetDecode === "wrong-size" ? 1 : 32;
    naturalHeight = 24;
    set src(value) {this.source = value;if (!value.startsWith("blob:")) state.assetRequests++;}
    decode() {
      const result = this.source.startsWith("blob:") ? decode : assetDecode;
      return result === "error" ? Promise.reject(new Error(canary)) : result === "timeout" ? new Promise(() => {}) : Promise.resolve();
    }
  }
  class DataTransfer { items = { add() {} }; }
  class File { constructor() {} }
  class Event { constructor() {} }
  browserWindow.__TAURI_INTERNALS__ = { invoke, convertFileSrc: () => convertedUrl };
  const context = { window: browserWindow, document, HTMLSelectElement, HTMLInputElement, HTMLTextAreaElement,
    Event, DragEvent: Event, DataTransfer, File, Image: MockImage, Blob, Uint8Array, atob,
    URL: { createObjectURL(blob) {state.blobBytes = blob.size;return `blob:${canary}`;}, revokeObjectURL() {state.revoked++;} },
    setTimeout(callback, ms) {
      if (ms === 3000) return setTimeout(callback, 10);
      queueMicrotask(() => {
        if (ms === 100) {
          state.ticks++;
          if (state.selected && !state.hydrated && state.ticks >= hydrationDelay) {
            state.hydrated = true;emitSelection(state.selected);
          }
          if (state.ticks >= collapseAt) state.preview = false;
        }
        callback();
      });return null;
    }, clearTimeout };
  await vm.runInNewContext(source, context)({ phase: "exercise", sourcePaths: ["/synthetic/Synthetic.md", "/synthetic/Delete.md"] });
  assert([...listeners.values()].every(set => set.size === 0));
  assert.equal(state.reports.length, 1);
  return state;
}

test("preview waits for the actual selected note to finish loading", async () => {
  const state = await runDriver({ startsPreview: false, loadAt: 0, hydrationDelay: 3, useProductionToggle: true });
  assert.equal(state.reports[0].step, "save");assert.equal(state.reports[0].uiFlags[0], true);assert.equal(state.reports[0].uiFlags[1], true);
  assert.equal(state.toggles, 1);assert.equal(state.ignored, 0);assert.equal(state.hydrated, true);
});

test("already-open preview is not toggled off while its image loads", async () => {
  const state = await runDriver();
  assert.equal(state.toggles, 0);assert.equal(state.reports[0].step, "save");
  assert.deepEqual(state.reports[0].uiFlags.slice(0, 3), [true, true, false]);
  assert.equal(state.reports[0].previewObservation, null);
});

test("closed preview is opened once; the decoded image gate remains required", async () => {
  const state = await runDriver({ startsPreview: false });
  assert.equal(state.toggles, 1);assert.equal(state.reports[0].step, "save");
  assert.deepEqual(state.reports[0].uiFlags.slice(0, 3), [true, true, false]);
});

test("wrong dimensions, incomplete or invisible images never satisfy preview", async () => {
  for (const options of [{ width: 31 }, { height: 25 }, { complete: false }, { imageVisible: false }]) {
    const state = await runDriver({ startsPreview: true, loadAt: 0, ...options });
    assert.equal(state.reports[0].step, "preview");assert.equal(state.reports[0].uiFlags[1], false);
    assert.equal(state.reports[0].previewObservation.interaction.previewObservedVisible, true);
  }
});

test("unmatched or absent readiness and an unmatched host never click preview", async () => {
  for (const options of [{ selectionEvent: "wrong" }, { selectionEvent: "none" }, { hostMatches: false }]) {
    const state = await runDriver({ startsPreview: false, ...options });
    assert.equal(state.reports[0].step, "preview");assert.equal(state.reports[0].uiFlags[1], false);assert.equal(state.toggles, 0);
    const interaction = state.reports[0].previewObservation.interaction;
    assert.equal(interaction.selectionReadyEvent, options.hostMatches === false);assert.equal(interaction.targetHostMatched, false);
    assert.equal(interaction.clickCalled, false);assert.equal(interaction.clickEventObserved, false);
  }
});

test("a replaced control is reacquired and clicked before another render can detach it", async () => {
  const state = await runDriver({ startsPreview: false, loadAt: 0, detachAfterLookup: true, useProductionToggle: true });
  assert.equal(state.reports[0].step, "save");assert.equal(state.reports[0].uiFlags[1], true);
  assert.equal(state.toggles, 1);assert.equal(state.ignored, 0);assert.equal(state.detached, true);
});

test("diagnostics distinguish a returned click, DOM event, and preview that later disappears", async () => {
  const ignored = await runDriver({ startsPreview: false, ignoreClick: true });
  const a = ignored.reports[0].previewObservation.interaction;
  assert.equal(a.selectionReadyEvent, true);assert.equal(a.targetHostMatched, true);assert.equal(a.clickCalled, true);
  assert.equal(a.clickReturned, true);assert.equal(a.clickEventObserved, false);assert.equal(a.previewObservedVisible, false);
  const vanished = await runDriver({ startsPreview: false, loadAt: Infinity, collapseAt: 1 });
  const b = vanished.reports[0].previewObservation.interaction;
  assert.equal(vanished.reports[0].previewObservation.previewPresent, false);assert.equal(b.clickEventObserved, true);assert.equal(b.previewObservedVisible, true);
  assert.equal(vanished.reports[0].uiFlags[1], false);
});

test("preview failure distinguishes states without leaking URLs, errors or text", async () => {
  const loading = await runDriver({ loadAt: Infinity, resolver: { status: "resolved", relativePath: "attachments/note-flow.png", absolutePath: canary } });
  const r = loading.reports[0];assert.equal(r.step, "preview");assert.equal(r.passed, false);assert.equal(r.uiFlags[1], false);
  assert.equal(r.previewObservation.action, "already-visible");assert.equal(r.previewObservation.mediaState, "loading");
  assert.equal(r.previewObservation.syntheticRowActive, true);
  assert.equal(r.previewObservation.imagePresent, false);assert.equal(r.previewObservation.resolution, "resolved-fixture");
  assert.equal(r.previewObservation.fixtureDecode, "passed");assert.equal(loading.blobBytes, FIXTURE.bytes);assert.equal(loading.revoked, 1);
  assert.equal(r.previewObservation.reconstructedUriKind, "asset");assert.equal(r.previewObservation.reconstructedAssetDecode, "passed");
  assert(!JSON.stringify(r).includes(canary));
  const mismatch = await runDriver({ loadAt: 0, sourceUrl: `workspace-attachment://localhost/${canary}`, mediaMessage: canary, resolver: new Error(canary), decode: "error" });
  assert.equal(mismatch.reports[0].step, "preview");assert.equal(mismatch.reports[0].uiFlags[1], false);
  assert.equal(mismatch.reports[0].previewObservation.uriKind, "workspace-attachment");
  assert.equal(mismatch.reports[0].previewObservation.mediaState, "other");assert.equal(mismatch.reports[0].previewObservation.resolution, "error");
  assert.equal(mismatch.reports[0].previewObservation.fixtureDecode, "error");assert.equal(mismatch.revoked, 1);
  assert(!JSON.stringify(mismatch.reports[0]).includes(canary));
  const timeout = await runDriver({ loadAt: Infinity, decode: "timeout", resolver: { status: "missing" } });
  assert.equal(timeout.reports[0].previewObservation.fixtureDecode, "timeout");assert.equal(timeout.revoked, 1);
  assert.equal(timeout.reports[0].previewObservation.resolution, "missing");assert.equal(timeout.reports[0].previewObservation.reconstructedAssetDecode, "not-run");
  const assetError = await runDriver({ loadAt: Infinity, assetDecode: "error" });
  assert.equal(assetError.reports[0].previewObservation.fixtureDecode, "passed");
  assert.equal(assetError.reports[0].previewObservation.reconstructedAssetDecode, "error");
  const noSelection = await runDriver({ loadAt: Infinity, selectionSticks: false });
  assert.equal(noSelection.reports[0].previewObservation.syntheticRowActive, false);
  for (const convertedUrl of [`https://private.invalid/${canary}`, `https://asset.localhost:443@private.invalid/${canary}`]) {
    const unexpected = await runDriver({ loadAt: Infinity, convertedUrl });
    assert.equal(unexpected.reports[0].previewObservation.reconstructedAssetDecode, "unexpected-uri");assert.equal(unexpected.assetRequests, 0);
    assert(!JSON.stringify(unexpected.reports[0]).includes(canary));
  }
});

test("missing control is reported separately and does not satisfy the preview gate", async () => {
  const state = await runDriver({ startsPreview: false, button: false });
  assert.equal(state.reports[0].step, "preview");assert.equal(state.reports[0].previewObservation.action, "toggle-requested");
  assert.equal(state.reports[0].previewObservation.controlPresent, false);assert.equal(state.reports[0].previewObservation.previewPresent, false);
  assert.equal(state.reports[0].uiFlags[1], false);
});

test("only bounded failure observations survive both report projections", async () => {
  const state = await runDriver({ loadAt: Infinity });const observed = state.reports[0];
  const record = { schemaVersion: 1, mode: "macos-note-flow", ...observed, status: "failed", backendVerified: false,
    previewObservation: { ...observed.previewObservation, raw: canary, interaction: { ...observed.previewObservation.interaction, raw: canary } } };
  const projected = noteScenarioRecord(record, "exercise");
  const phase = safeNotePhase({ ...emptyNoteFlow().exercise, ...projected, failure: "scenario-failed" }, "exercise");
  assert.equal(phase.previewObservation.mediaState, "loading");assert(!JSON.stringify(phase).includes(canary));
  const build = summarizeBuildResult({ version: "1.9.9", target: "aarch64-apple-darwin", sidecars: ["luckyray-native-host", "luckyray-cli", "luckyray-mcp"],
    mediaFiles: 1, dshFiles: 1, distribution: { readyToPackage: false, sourceInputsSha256: "a".repeat(64), providedSourceInputs: 1, providedSourceBytes: 1, missingRequirements: [{ id: "missing-source" }] } });
  const data = { status: "passed", compiled: true, failure: "none", cases: NOTE_DATA_CASES.map(({ id }) => ({ id, status: "passed", exit: 0 })) };
  const internal = { schemaVersion: 1, mode: "internal-native-validation", status: "failed", binaryExport: false, workerExit: 1, workerSignal: null,
    source: { repository: "xiaorui2886/LuckyRay", commit: "a".repeat(40), tree: "b".repeat(40) }, build, noteData: data, lsh: null,
    notesUi: { ...emptyNoteFlow(), status: "failed", sourceUnchanged: true, exercise: phase }, distributionReady: false, diagnostics: {},
    failure: { code: "macos-note-flow-failed" }, phases: PHASES.map((name, i) => ({ phase: name, status: i < 6 ? "passed" : i === 6 ? "failed" : "not-run" })) };
  const published = publishableReport(publishableReport(internal));
  assert.equal(published.notesUi.exercise.previewObservation.fixtureDecode, "passed");assert(!JSON.stringify(published).includes(canary));
  for (const bad of [{ uriKind: canary }, { width: 32769 }, { imageVisible: true }, { previewPresent: false }])
    assert.throws(() => noteScenarioRecord({ ...record, previewObservation: { ...record.previewObservation, ...bad } }, "exercise"), /result-invalid/);
  for (const bad of [{ targetHostMatched: true, selectionReadyEvent: false }, { clickCalled: false, clickReturned: true }, { clickEventObserved: canary }])
    assert.throws(() => noteScenarioRecord({ ...record, previewObservation: { ...record.previewObservation,
      interaction: { ...record.previewObservation.interaction, ...bad } } }, "exercise"), /result-invalid/);
  const oldObservation = { ...record.previewObservation };delete oldObservation.interaction;
  assert(!("interaction" in noteScenarioRecord({ ...record, previewObservation: oldObservation }, "exercise").previewObservation));
  assert.throws(() => noteScenarioRecord({ ...record, step: "save" }, "exercise"), /result-invalid/);
  assert(source.includes(FIXTURE.base64));
});

test("production selection publishes the note after asynchronous hydration", async () => {
  assert(toggleBody.includes('if (!selectedNote) return;'));
  const start = pageSource.indexOf('const selectNote = useCallback('), end = pageSource.indexOf('if (!bridge?.getNote)', start);
  const selection = pageSource.slice(start, end);
  const positions = ['setSelectedNoteId(realNoteId)', 'await realVaultDocumentSource.openDocument(relativePath)', 'setSelectedNote(note)',
    'window.dispatchEvent(new CustomEvent("luckyray:notes-active-note"'].map(part => selection.indexOf(part));
  assert(positions.every(n => n >= 0));assert(positions.every((n, i) => i === 0 || n > positions[i - 1]));
  const surface = await readFile(new URL('../src/features/notes/NoteDocumentSurface.tsx', import.meta.url), 'utf8');
  const status = surface.slice(surface.indexOf('<div className="editor-status">'));
  assert.match(status, /data-note-action="preview"\s+onClick=\{\(\) => actions\.togglePreview\(\)\}/);
});
