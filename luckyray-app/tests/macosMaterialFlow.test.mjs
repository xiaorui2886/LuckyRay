import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { FIXTURE, safeMaterialFlow, scenarioRecord } from "../scripts/check-macos-material-flow.mjs";
import { appBuildArguments } from "../scripts/build-macos.mjs";
import { publishableReport, PHASES } from "../scripts/check-macos-internal.mjs";

const flags = { modeSaved: true, previewDecoded: true, backendRecordVerified: true, managedCopyVerified: true, sourceUnchanged: true, normalExit: true };
const image = { present: true, complete: true, width: 32, height: 24, visible: true, uriKind: "asset" };
function observations() {
  return { dom: { importDispatched: true, workspaceTarget: "scoped", bridgeInstalled: true, databaseState: "ready",
    cardCount: 1, dialogPresent: true, thumbnail: { ...image }, preview: { ...image } },
    nativeImport: { status: "returned", calls: 1, importedCount: 1, failedCount: 0, skippedDuplicateCount: 0, errorCodes: [], osError: null } };
}
function passedFlow() {
  return { schemaVersion: 1, interaction: "application-dom-automation", status: "passed", fixtureSha256: FIXTURE.sha256,
    import: { status: "passed", step: "preview", failure: "none", ...flags, ...observations() },
    reopen: { status: "passed", step: "reopen-preview", failure: "none", ...flags, ...observations() }, persistedAsset: true };
}

test("the fixed PNG and internal-only feature preserve normal bundle arguments", async () => {
  const bytes = Buffer.from(FIXTURE.base64, "base64");
  assert.equal(bytes.length, FIXTURE.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), FIXTURE.sha256);
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(bytes.readUInt32BE(16), 32); assert.equal(bytes.readUInt32BE(20), 24);
  const rust = await readFile(new URL("../src-tauri/src/macos_material_flow.rs", import.meta.url), "utf8");
  assert.equal(/const SHA256: &str = "([a-f0-9]{64})"/.exec(rust)?.[1], FIXTURE.sha256);
  assert(!appBuildArguments(false).includes("macos-material-flow"));
  assert(!appBuildArguments(true).includes("macos-material-flow"));
  assert(appBuildArguments(true).includes("macos-lsh-surface-flow"));
  assert(!appBuildArguments(false).includes("macos-lsh-surface-flow"));
  assert(appBuildArguments(true).includes("--locked"));
});

test("projection requires real backend flags, both normal exits and retained identity", () => {
  const value = passedFlow(); value.secret = "private-canary"; value.import.stderr = "/private/private-canary";
  value.import.dom.thumbnail.src = "/private/private-canary";
  value.import.nativeImport.errorMessage = "/private/private-canary";
  assert(!JSON.stringify(safeMaterialFlow(value)).includes("private-canary"));
  for (const phase of ["import", "reopen"]) for (const flag of Object.keys(flags)) {
    const invalid = passedFlow(); invalid[phase][flag] = false;
    assert.throws(() => safeMaterialFlow(invalid), /result-invalid/);
  }
  assert.throws(() => safeMaterialFlow({ ...passedFlow(), persistedAsset: false }), /result-invalid/);
  const record = { schema: 1, phase: "import", status: "passed", step: "preview", assetId: "asset-123", fixtureSha256: FIXTURE.sha256, ...flags, ...observations() };
  assert.equal(scenarioRecord(record, "import").assetId, "asset-123");
  assert.throws(() => scenarioRecord({ ...record, backendRecordVerified: false }, "import"), /result-invalid/);
  assert.throws(() => scenarioRecord({ ...record, step: "choose-mode" }, "import"), /result-invalid/);
  assert.throws(() => scenarioRecord({ ...record, nativeImport: { ...record.nativeImport, errorCodes: ["private-canary"] } }, "import"), /result-invalid/);
  assert.throws(() => scenarioRecord({ ...record, nativeImport: { ...record.nativeImport, osError: 256 } }, "import"), /result-invalid/);
  assert.throws(() => scenarioRecord({ ...record, dom: { ...record.dom, cardCount: 3 } }, "import"), /result-invalid/);
  const failed = passedFlow();
  failed.status = "failed"; failed.persistedAsset = false;
  Object.assign(failed.import, { status: "failed", step: "thumbnail", failure: "scenario-step", previewDecoded: false, normalExit: false });
  failed.reopen = { status: "not-run", step: "not-started", failure: "none",
    ...Object.fromEntries(Object.keys(flags).map(key => [key, false])), dom: null, nativeImport: null };
  assert.equal(safeMaterialFlow(failed).import.backendRecordVerified, true);
  assert.equal(safeMaterialFlow(failed).status, "failed");
  const published = { schemaVersion: 1, mode: "internal-native-validation", status: "passed", binaryExport: false,
    source: { repository: "xiaorui2886/LuckyRay", commit: "a".repeat(40), tree: "b".repeat(40) },
    workerExit: 0, phases: PHASES.map(phase => ({ phase, status: "passed" })), materialFlow: passedFlow() };
  // The next internal job requires LSH evidence. An older successful material
  // scenario must not be accepted as an LSH result.
  assert.throws(() => publishableReport(published), /result-invalid/);
  assert.throws(() => publishableReport({ ...published, materialFlow: null }), /result-invalid/);
});

// This VM tests only the driver protocol and negative decisions. It is not a
// WKWebView/UI acceptance test; the native scenario remains mandatory.
test("driver uses existing handlers and never repairs failed restart or image checks", async () => {
  const source = await readFile(new URL("../src-tauri/src/macos_material_flow_driver.js", import.meta.url), "utf8");
  async function exercise(phase, { badMode = false, badPreview = false, noCard = false, badThumbnail = false, imageUri = "asset://localhost/fixed.png" } = {}) {
    let chosen = false, imported = phase === "reopen", opened = false, chooser = phase === "import";
    const calls = [], drops = [];
    const image = { complete: true, naturalWidth: 32, naturalHeight: 24, src: imageUri, getClientRects: () => [{}] };
    const thumbnail = badThumbnail ? { ...image, complete: false, naturalWidth: 0, naturalHeight: 0 } : image;
    const card = { getAttribute: () => "asset-123", querySelector: key => key === "img" ? thumbnail : { click: () => { opened = true; } } };
    const chooserElement = { closest: () => ({ id: "page-materials-test-pane" }), querySelectorAll: () => [{ click: () => { chosen = true; chooser = false; } }, {}, {}] };
    const viewer = { getAttribute: () => "asset-123", querySelector: () => badPreview ? { ...image, naturalWidth: 0 } : image };
    const context = { setTimeout: fn => { queueMicrotask(fn); }, CustomEvent: class { constructor(type, data) { this.type = type; this.detail = data.detail; } },
      localStorage: { getItem: () => JSON.stringify({ "materials.importMode": !badMode && (chosen || phase === "reopen") ? "managed" : "linked", "materials.importModePromptSeen": !badMode && (chosen || phase === "reopen") }) },
      document: { querySelector: key => key === ".material-import-mode-modal" ? (chooser ? chooserElement : null)
        : key === ".materials-empty-action-btn.primary" ? (chosen ? {} : null)
        : key === ".material-viewer-react.preview" ? (opened ? viewer : null)
        : key === ".material-viewer-react.preview .qp-media-stage-react img" ? (opened ? viewer.querySelector() : null) : null,
        querySelectorAll: () => imported && !noCard ? [card] : [] } };
    context.window = { __LUCKYRAY__: {}, __LUCKYRAY_BRIDGE_READINESS__: { databaseReady: true },
      dispatchEvent: event => { drops.push(event); imported = true; }, __TAURI_INTERNALS__: {
      invoke: async (command, payload) => { calls.push({ command, payload }); },
    } };
    const driver = runInNewContext(source, context);
    await driver({ phase, sourcePath: "/fixed/synthetic.png", assetId: phase === "reopen" ? "asset-123" : null });
    return { chosen, drops, calls, observation: calls.find(call => call.command === "macos_material_flow_report").payload.report };
  }
  const first = await exercise("import");
  assert(first.chosen); assert.equal(first.drops[0].type, "luckyray:materials-native-folder-import");
  assert.equal(first.drops[0].detail.workspaceViewId, "test-pane");
  assert.equal(first.observation.status, "passed"); assert.equal(first.calls.at(-1).command, "close_window");
  assert.equal(first.observation.dom.importDispatched, true); assert.equal(first.observation.dom.cardCount, 1);
  const reopened = await exercise("reopen");
  assert.equal(reopened.drops.length, 0); assert.equal(reopened.observation.status, "passed");
  const wrongMode = await exercise("reopen", { badMode: true });
  assert.equal(wrongMode.observation.status, "failed"); assert.equal(wrongMode.observation.step, "reopen-mode");
  assert.equal(wrongMode.drops.length, 0); assert.equal(wrongMode.chosen, false);
  const brokenImage = await exercise("import", { badPreview: true });
  assert.equal(brokenImage.observation.status, "failed"); assert.equal(brokenImage.observation.step, "preview");
  assert.equal(brokenImage.observation.previewDecoded, false);
  const absent = await exercise("import", { noCard: true });
  assert.equal(absent.observation.status, "failed"); assert.equal(absent.observation.step, "import-card");
  assert.equal(absent.observation.assetId, null); assert.equal(absent.observation.dom.cardCount, 0);
  const unloaded = await exercise("import", { badThumbnail: true });
  assert.equal(unloaded.observation.status, "failed"); assert.equal(unloaded.observation.step, "thumbnail");
  assert.equal(unloaded.observation.assetId, "asset-123"); assert.equal(unloaded.observation.dom.cardCount, 1);
  assert.equal(unloaded.observation.dom.thumbnail.complete, false);
  const wrongUri = await exercise("import", { imageUri: "https://example.invalid/fixture.png" });
  assert.equal(wrongUri.observation.status, "failed"); assert.equal(wrongUri.observation.step, "thumbnail");
  assert.equal(wrongUri.observation.dom.thumbnail.uriKind, "other");
  assert.equal((await exercise("import", { imageUri: "http://asset.localhost/fixed.png" })).observation.status, "passed");
});
