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
const canary = "private-path-or-url-must-not-escape";

async function runDriver({ startsPreview = true, loadAt = 3, sourceUrl = "asset://localhost/fixture", mediaMessage = "图片加载中",
  resolver = { status: "resolved", relativePath: "attachments/note-flow.png", absolutePath: "/synthetic/attachments/note-flow.png" },
  decode = "passed", assetDecode = "passed", convertedUrl = "asset://localhost/synthetic-fixture", missingAsset = false, button = true, selectionSticks = true } = {}) {
  const state = { modal: true, imported: false, selected: null, preview: startsPreview, ticks: 0, toggles: 0, reports: [], revoked: 0, blobBytes: 0, assetRequests: 0 };
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
    el.classList = { contains: name => name === "active" && state.selected === title };
    el.click = () => {if (selectionSticks) state.selected = title;};return el;
  });
  const previewControl = new Element();previewControl.click = () => {state.toggles++;state.preview = !state.preview;};
  const media = new Element();media.querySelector = selector => selector === ".note-media-status" && mediaMessage ? { textContent: mediaMessage } : null;
  const root = new Element();root.querySelector = selector => selector === '.note-media[data-kind="image"]' ? media
    : selector === ".note-preview-asset-link.missing" && missingAsset ? generic : null;
  const image = new Element();Object.assign(image, { complete: true, naturalWidth: 32, naturalHeight: 24, src: sourceUrl });
  const page = new Element();page.dispatchEvent = () => {state.imported = true;};
  const document = { querySelectorAll(selector) {
    if (selector === ".material-import-mode-modal") return state.modal ? [chooser] : [];
    if (selector === '[data-folder-document-id]') return state.imported ? notes : [];
    if (selector === '#page-notes .note-preview') return state.preview ? [root] : [];
    if (selector === '#page-notes .note-preview img') return state.preview && state.ticks >= loadAt ? [image] : [];
    if (selector === '#page-notes [data-note-action="preview"]') return button ? [previewControl] : [];
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
  const context = { window: { __TAURI_INTERNALS__: { invoke, convertFileSrc: () => convertedUrl } }, document, HTMLSelectElement, HTMLInputElement, HTMLTextAreaElement,
    Event, DragEvent: Event, DataTransfer, File, Image: MockImage, Blob, Uint8Array, atob,
    URL: { createObjectURL(blob) {state.blobBytes = blob.size;return `blob:${canary}`;}, revokeObjectURL() {state.revoked++;} },
    setTimeout(callback, ms) {
      if (ms === 3000) return setTimeout(callback, 10);
      queueMicrotask(() => { if (ms === 100) state.ticks++; callback(); });return null;
    }, clearTimeout };
  await vm.runInNewContext(source, context)({ phase: "exercise", sourcePaths: ["/synthetic/Synthetic.md", "/synthetic/Delete.md"] });
  assert.equal(state.reports.length, 1);
  return state;
}

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
    previewObservation: { ...observed.previewObservation, raw: canary } };
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
  assert.throws(() => noteScenarioRecord({ ...record, step: "save" }, "exercise"), /result-invalid/);
  assert(source.includes(FIXTURE.base64));
});
