import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { loadBackgroundSandbox } from "./lib/background-script-sandbox.mjs";

test("Capture R2 keeps permission sets unchanged and vendors the frozen material SDK without semantic edits", async () => {
  const manifest = JSON.parse(await readFile(new URL("../browser-extension-prototype/manifest.json", import.meta.url), "utf8"));
  const baseline = JSON.parse(await readFile(new URL("./browser-extension-runtime/permission-baseline.json", import.meta.url), "utf8"));
  for (const field of ["permissions", "host_permissions", "optional_permissions", "optional_host_permissions"]) assert.deepEqual([...manifest[field]].sort(), [...baseline[field]].sort());
  assert.equal(manifest.content_scripts.length, baseline.content_scripts.length);
  for (let i = 0; i < manifest.content_scripts.length; i++) for (const field of ["matches", "js", "all_frames", "match_about_blank", "run_at"]) assert.deepEqual(manifest.content_scripts[i][field], baseline.content_scripts[i][field]);
  const sdk = await readFile(new URL("../browser-extension-prototype/material-library-consumer.js", import.meta.url), "utf8");
  assert.equal(createHash("sha256").update(sdk.replace(/\r\n/g, "\n")).digest("hex"), "f404a55011dd6cab5979c2591e12b316868f1466126008866c65a247e82a4bee");
});

test("article resource policy rejects credentials, secret queries/fragments and non-web URLs", async () => {
  const context = { URL, TextEncoder }; context.globalThis = context;
  vm.runInNewContext(await readFile(new URL("../browser-extension-prototype/article-extractor.js", import.meta.url), "utf8"), context);
  for (const url of ["javascript:alert(1)", "file:///private", "https://user:pass@site.test/image", "https://site.test/image?apikey=secret", "https://site.test/image#token%253Dsecret", "https://site.test/image?x-amz-signature=secret"]) assert.equal(context.LuckyRayArticleExtractor.url(url, "https://page.test"), "");
  assert.equal(context.LuckyRayArticleExtractor.url("/image?q=normal#figure", "https://page.test"), "https://page.test/image?q=normal#figure");
});

async function controller(options = {}) {
  const calls = [];
  const tab = { id: 11, windowId: 4, active: true, url: "https://page.test/article", title: "Article" };
  const context = { URL, TextEncoder, Date, setTimeout, clearTimeout, crypto: globalThis.crypto,
    LuckyRayExtensionProtocol: { normalizeSourcePageUrl: value => value.startsWith("https://") ? value : "" } };
  context.globalThis = context;
  vm.runInNewContext(await readFile(new URL("../browser-extension-prototype/capture-controller.js", import.meta.url), "utf8"), context);
  const request = async (method, path, body) => {
    calls.push({ method, path, body: structuredClone(body) });
    if (path.endsWith("capture-target")) return options.binding || { ok: true, data: { activation: { vaultId: "vault-A", sourceEpoch: 3 }, revision: "r1" } };
    return options.write ? options.write(method, path, body) : { ok: true, data: { noteId: "note-A", documentRef: { vaultId: "vault-A", relativePath: "Article.md" }, revision: "r2" } };
  };
  const instance = context.LuckyRayPageCaptureController.create({ chromeApi: { storage: options.storage, tabs: { get: async () => { if (options.getTab) await options.getTab(); return { ...tab }; } } },
    page: async (_tabId, action) => { if (options.page) return options.page(action); return action === "article" ? { ok: true, documentToken: "doc-A", markdown: "## Body\n\n- item", kind: "article", images: [] } : { ok: true, documentToken: options.documentToken?.() || "doc-A" }; }, request });
  return { instance, calls, tab };
}

test("article preview freezes vault activation and edited title, with one receipt on simultaneous Save", async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const { instance, calls } = await controller({ write: async () => { await pending; return { ok: true, data: { noteId: "note-A" } }; } });
  const result = await instance.start({ mode: "article", tabId: 11 });
  assert.equal(result.draft.libraryId, "vault-A"); assert.equal(result.draft.stage, "preview");
  const first = instance.save(result.draft.id, { title: "User title" });
  const duplicate = await instance.save(result.draft.id, { title: "Changed while saving" });
  assert.equal(duplicate.ok, false); release(); await first;
  const writes = calls.filter(call => call.path === "/api/notes/capture");
  assert.equal(writes.length, 1); assert.equal(writes[0].body.title, "User title"); assert.equal(writes[0].body.binding.activation.vaultId, "vault-A");
  assert.equal(instance.status(result.draft.id).draft.stage, "saved");
});

test("article target V1 rejection preserves the exact code before extraction or writes", async () => {
  let extracted=false;
  const {instance,calls}=await controller({binding:{ok:false,status:409,errorObject:{ok:false,error:{code:"knowledge-source-inactive"}}},page:()=>{extracted=true;}});
  const result=await instance.start({mode:"article",tabId:11});
  assert.equal(result.ok,false);
  assert.equal(result.code,"knowledge-source-inactive");
  assert.equal(extracted,false);
  assert.equal(calls.length,1);
  assert.equal(calls[0].path,"/api/notes/capture-target");
});

test("an unknown PNG does not block a new article or erase the original request", async () => {
  const key = "luckyray.pageCapture.pending.v1";
  let records = [{requestId:"popup:old-png",libraryId:"library-B",mode:"visible"}];
  const {instance, calls} = await controller({storage:{local:{
    get:async()=>({[key]:structuredClone(records)}),
    set:async value=>{records=structuredClone(value[key]);},
  }}});
  const result = await instance.start({mode:"article",tabId:11});
  assert.equal(result.ok, true);
  assert.equal(result.draft.stage, "preview");
  assert.equal((await instance.save(result.draft.id,{title:"Independent article"})).draft.stage,"saved");
  assert.deepEqual(records,[{requestId:"popup:old-png",libraryId:"library-B",mode:"visible"}]);
  assert.equal(calls.filter(c=>c.path==="/api/notes/capture").length,1);
  assert.equal(calls.filter(c=>c.path.endsWith("/import-bytes")).length,0);
});

test("page navigation or same-URL document replacement after preview produces zero writes", async () => {
  for (const changeUrl of [true, false]) {
    let token = "doc-A";
    const { instance, calls, tab } = await controller({ documentToken: () => token });
    const result = await instance.start({ mode: "article", tabId: 11 });
    if (changeUrl) tab.url += "?new=1"; else token = "doc-B";
    const save = await instance.save(result.draft.id, { title: "Save stale" });
    assert.equal(save.ok, false); assert.equal(save.code, "capture-page-changed");
    assert.equal(calls.filter(call => call.path === "/api/notes/capture").length, 0);
  }
});

test("lost or malformed commit acknowledgement blocks another action under the preview", async () => {
  const { instance, calls } = await controller({ write: async () => ({ ok: false, errorObject: { code: "request-outcome-unknown" } }) });
  const result = await instance.start({ mode: "article", tabId: 11 });
  const save = await instance.save(result.draft.id, { title: "A" });
  assert.equal(save.draft.stage, "uncertain");
  await instance.save(result.draft.id, { title: "B" });
  assert.equal(calls.filter(call => call.path === "/api/notes/capture").length, 1);
});

test("cancelled preview has no write path or persisted content journal", async () => {
  const { instance, calls } = await controller(); const result = await instance.start({ mode: "article", tabId: 11 });
  assert.equal((await instance.cancel(result.draft.id)).ok, true);
  assert.equal((await instance.save(result.draft.id, {})).ok, false);
  assert.equal(calls.filter(call => call.path === "/api/notes/capture").length, 0);
});

test("untrusted content sender cannot open a capture panel, list libraries, or commit drafts", async () => {
  const fixture = await loadBackgroundSandbox();
  for (const type of ["luckyray-capture-open", "luckyray-page-draft", "luckyray-capture-libraries", "luckyray-capture-taxonomy"]) {
    let response;
    for (const listener of fixture.listeners.runtimeMessageListeners) listener({ type, action: "save", id: "popup:forged", input: { tabId: 1 } }, { id: fixture.sandbox.chrome.runtime.id, url: "https://page.test/article", tab: { id: 1, url: "https://page.test/article" } }, value => { response = value; });
    assert.equal(response?.code, "capture-forbidden");
  }
  assert.equal(fixture.transportCalls.length, 0);
});

test("simultaneous Start reserves the tab before its first await", async () => {
  let release; const wait = new Promise(resolve => { release = resolve; });
  const { instance, calls } = await controller({ getTab: () => wait });
  const first = instance.start({ mode: "article", tabId: 11 });
  const second = await instance.start({ mode: "article", tabId: 11 });
  assert.equal(second.code, "capture-busy"); release(); await first;
  assert.equal(calls.filter(c => c.path.endsWith("capture-target")).length, 1);
});

test("Cancel cannot race a validating Save into a write after cancellation", async () => {
  let release, validating = false; const wait = new Promise(resolve => { release = resolve; });
  const { instance, calls } = await controller({ page: async action => {
    if (action === "metrics") { validating = true; await wait; }
    return { ok: true, documentToken: "doc-A", markdown: "body", kind: "article" };
  } });
  const result = await instance.start({ mode: "article", tabId: 11 });
  const saving = instance.save(result.draft.id, { title: "A" });
  while (!validating) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal((await instance.cancel(result.draft.id)).code, "capture-busy");
  release(); assert.equal((await saving).ok, true); assert.equal(calls.filter(c => c.path.endsWith("/capture")).length, 1);
});

test("worker restart retains metadata-only unknown operation until explicit desktop-check acknowledgement", async () => {
  const stored = {}; const storage = { local: { get: async key => ({ [key]: stored[key] }), set: async value => Object.assign(stored, structuredClone(value)) } };
  const first = await controller({ storage, write: async () => { throw new Error("response lost"); } });
  const result = await first.instance.start({ mode: "article", tabId: 11 });
  assert.equal((await first.instance.save(result.draft.id, { title: "Private title" })).draft.stage, "uncertain");
  const persisted = JSON.stringify(stored);
  assert(!persisted.includes("Private title") && !persisted.includes("page.test") && !persisted.includes("Body") && !persisted.includes("sourceEpoch"));
  const restarted = await controller({ storage });
  assert.equal((await restarted.instance.start({ mode: "article", tabId: 11 })).code, "capture-commit-uncertain");
  assert.equal(restarted.calls.length, 0);
  assert.equal((await restarted.instance.pendingStatus()).pending[0].requestId, result.draft.id);
  await restarted.instance.acknowledge(result.draft.id);
  assert.equal((await restarted.instance.start({ mode: "article", tabId: 11 })).ok, true);
});

test("failed journal persistence dispatches zero writes and leaves editable preview", async () => {
  const storage = { local: { get: async () => ({}), set: async () => { throw new Error("disk denied"); } } };
  const { instance, calls } = await controller({ storage });
  const result = await instance.start({ mode: "article", tabId: 11 });
  const save = await instance.save(result.draft.id, { title: "A" });
  assert.equal(save.code, "capture-journal-unavailable"); assert.equal(save.draft.stage, "preview");
  assert.equal(calls.filter(c => c.path.endsWith("/capture")).length, 0);
});

test("public previews cannot mutate the frozen binding or content and wrong-vault receipt stays uncertain", async () => {
  const { instance, calls } = await controller({ write: async () => ({ ok: true, data: { documentRef: { vaultId: "vault-B" } } }) });
  const result = await instance.start({ mode: "article", tabId: 11 });
  assert.equal(result.draft.binding, undefined); result.draft.markdown = "forged";
  assert.equal((await instance.save(result.draft.id, { title: "A" })).draft.stage, "uncertain");
  assert.equal(calls.at(-1).body.content, "## Body\n\n- item"); assert.equal(calls.at(-1).body.binding.activation.vaultId, "vault-A");
});

async function syntheticScreenshot(options = {}) {
  let y = 0, restored = 0, captureCount = 0, lease = 0, generation = 0;
  const draws = [], actions = [], writes = [], restoredLeases = [], focused = [];
  const metrics = () => ({ ok: true, documentToken: "doc-A", url: "https://page.test/article", x: 0, y, width: 500, height: 300, dpr: 2, visualScale: 1, pageWidth: 500, pageHeight: options.huge ? 90000 : 850 });
  const context = { URL, TextEncoder, Uint8Array, Date, setTimeout, clearTimeout, crypto: globalThis.crypto, btoa,
    fetch: async () => ({ blob: async () => ({}) }), createImageBitmap: async () => ({ width: 1000, height: 600, close() {} }),
    OffscreenCanvas: class { constructor(width, height) { this.width = width; this.height = height; } getContext() { return { drawImage: (...args) => draws.push(args.slice(1)) }; } async convertToBlob() { return { size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; } },
    LuckyRayExtensionProtocol: { normalizeSourcePageUrl: value => value } };
  context.globalThis = context;
  for (const filename of ["material-library-consumer.js", "capture-controller.js"]) vm.runInNewContext(await readFile(new URL(`../browser-extension-prototype/${filename}`, import.meta.url), "utf8"), context);
  const instance = context.LuckyRayPageCaptureController.create({
    chromeApi: { tabs: { get: async () => ({ id: 11, windowId: 4, active: true, url: metrics().url, title: "Synthetic geometry" }), captureVisibleTab: async () => { captureCount++; if (captureCount === 1 && options.captureGate) await options.captureGate; if (options.denied) throw new Error("Either activeTab or <all_urls> is required"); return "data:image/png;base64,SYNTHETIC"; } }, windows: { update: async id => { focused.push(id); } } },
    page: async (_id, action, input) => {
      actions.push({ action, input });
      if (action === "prepare") lease = ++generation;
      if (action === "cancel") lease = 0;
      if (action === "restore") { restored++; restoredLeases.push(lease); lease = 0; y = 0; }
      if (action === "scroll" && options.leaseTracking && !lease) return { ok: false, code: "capture-expired" };
      if (action === "scroll") { y = Math.min(input.y, 550); if (options.dynamic) return { ...metrics(), pageHeight: 900 }; }
      if (action === "pick") return { ...metrics(), rect: { x: 100, y: 120, width: 280, height: 100 } };
      return metrics();
    }, delay: async () => {}, request: async (_method, route, body) => {
      if (route === "/api/material-libraries") return { ok: true, data: { consumerVersion: 1, libraries: [{ libraryId: "lib-B", state: options.state || "ready", visible: options.visible ?? true, capabilities: { read: options.read ?? true, import: options.import ?? true, organize: options.organize ?? true } }] } };
      if (route === "/api/material-libraries/capture-receipt") {
        assert.deepEqual(Object.keys(body).sort(), ["libraryId", "requestId"]);
        return { ok: true, data: { receiptLookupVersion: 1, ...body, state: "unknown", receipt: null } };
      }
      writes.push(structuredClone(body));
      return options.rejection || { ok: true, data: { consumerVersion: options.wrongVersion ? 2 : 1, libraryId: body.libraryId, requestId: body.requestId, assetId: "asset-A", disposition: "imported", changed: true } };
    },
  });
  const started = await instance.start({ mode: options.mode || "full", tabId: 11, libraryId: "lib-B" }, options.panelWindowId);
  if (!started.ok) return { instance, started, writes };
  for (let i = 0; i < 100 && (options.captureGate ? captureCount === 0 : instance.status(started.draft.id).draft.stage === "capturing"); i++) await new Promise(resolve => setTimeout(resolve, 1));
  return { instance, id: started.draft.id, draws, actions, writes, restoredLeases, focused, lease: () => lease, generation: () => generation, restored: () => restored, captureCount: () => captureCount };
}

test("SYNTHETIC geometry: DPR2 bottom overlap is cropped exactly and full-page finally restores", async () => {
  const fixture = await syntheticScreenshot(); const draft = fixture.instance.status(fixture.id).draft;
  assert.equal(draft.stage, "preview"); assert.equal(draft.width, 1000); assert.equal(draft.height, 1700);
  assert.deepEqual(fixture.draws.map(args => [args[1], args[3], args[5], args[7]]), [[0, 600, 0, 600], [0, 600, 600, 600], [100, 500, 1200, 500]]);
  assert.deepEqual(fixture.actions.filter(a => a.action === "scroll").map(a => a.input.hideFixed), [false, true, true]);
  assert.equal(fixture.restored(), 1);
  const saved = await fixture.instance.save(fixture.id, { title: "Fixture", folderId: "folder-B", tagIds: ["tag-B"] });
  assert.equal(saved.ok, true); assert.equal(fixture.writes[0].libraryId, "lib-B"); assert.equal(fixture.writes[0].targetFolderId, "folder-B"); assert.deepEqual(fixture.writes[0].tagIds, ["tag-B"]);
});

test("SYNTHETIC region geometry uses actual bitmap ratio, not an assumed CSS pixel size", async () => {
  const fixture = await syntheticScreenshot({ mode: "region" }); const draft = fixture.instance.status(fixture.id).draft;
  assert.equal(draft.width, 560); assert.equal(draft.height, 200); assert.deepEqual(fixture.draws[0], [200, 240, 560, 200, 0, 0, 560, 200]);
});

test("SYNTHETIC failures: native denial, dynamic height and oversized page never write and restore", async () => {
  for (const [option, code] of [[{ denied: true }, "capture-user-invocation-required"], [{ dynamic: true }, "capture-page-size-changed"], [{ huge: true }, "capture-size-limit"]]) {
    const fixture = await syntheticScreenshot(option); const draft = fixture.instance.status(fixture.id).draft;
    assert.equal(draft.stage, "failed"); assert.equal(draft.code, code); assert.equal(fixture.restored(), 1);
    assert.equal((await fixture.instance.save(fixture.id, { title: "No" })).ok, false); assert.equal(fixture.writes.length, 0);
  }
});

test("material SDK rejects a different consumer version and prevents another Save", async () => {
  const fixture = await syntheticScreenshot({ wrongVersion: true });
  const result = await fixture.instance.save(fixture.id, { title: "Fixture" });
  assert.equal(result.draft.stage, "uncertain"); assert.equal(result.code, "consumer-contract-unavailable");
  assert.equal((await fixture.instance.save(fixture.id, { title: "Changed" })).ok, false); assert.equal(fixture.writes.length, 1);
});

test("projected V1 note whitelist rejection with any supported unknown marker preserves pending and blocks another open preview", async () => {
  for (const marker of [{ writeOutcome: "unknown" }, { error: { writeOutcome: "unknown" } }, { error: { details: { writeOutcome: "unknown" } } }]) {
    const errorObject = { ok: false, ...marker, error: { ...marker.error, code: "note-material-title-invalid" } };
    const { instance, calls } = await controller({ write: async () => ({ ok: false, status: 400, errorObject }) });
    const first = await instance.start({ mode: "article", tabId: 11 });
    const second = await instance.start({ mode: "article", tabId: 11 });
    const saved = await instance.save(first.draft.id, { title: "Original A" });
    assert.equal(saved.draft.stage, "uncertain"); assert.notEqual(saved.draft.notCommitted, true);
    const pending = (await instance.pendingStatus()).pending;
    assert.equal(pending.length, 1); assert.equal(pending[0].requestId, first.draft.id);
    const blocked = await instance.save(second.draft.id, { title: "Still preview B" });
    assert.equal(blocked.code, "capture-commit-uncertain"); assert.equal(blocked.draft.stage, "preview");
    assert.deepEqual((await instance.pendingStatus()).pending, pending);
    const writes = calls.filter(call => call.method === "POST" && call.path === "/api/notes/capture");
    assert.equal(writes.length, 1); assert.equal(writes[0].body.requestId, first.draft.id);
  }
});

test("projected V1 material unknown preserves its identity without blocking a different explicit preview", async () => {
  for (const marker of [{ writeOutcome: "unknown" }, { error: { writeOutcome: "unknown" } }, { error: { details: { writeOutcome: "unknown" } } }]) {
    const errorObject = { ok: false, ...marker, error: { ...marker.error, code: "consumer-folder-denied" } };
    const fixture = await syntheticScreenshot({ mode: "visible", rejection: { ok: false, status: 403, errorObject } });
    const second = await fixture.instance.start({ mode: "visible", tabId: 11, libraryId: "lib-B" });
    assert.equal(second.ok, true);
    for (let i = 0; i < 100 && fixture.instance.status(second.draft.id).draft.stage === "capturing"; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(fixture.instance.status(second.draft.id).draft.stage, "preview");
    const saved = await fixture.instance.save(fixture.id, { title: "Original A", folderId: "folder-B" });
    assert.equal(saved.draft.stage, "uncertain"); assert.notEqual(saved.draft.notCommitted, true);
    const pending = (await fixture.instance.pendingStatus()).pending;
    assert.equal(pending.length, 1); assert.equal(pending[0].requestId, fixture.id);
    const next = await fixture.instance.save(second.draft.id, { title: "Explicit new B" });
    assert.equal(next.draft.stage, "uncertain");
    const after = (await fixture.instance.pendingStatus()).pending;
    assert.equal(after.length, 2); assert.equal(after[0].requestId, pending[0].requestId);
    assert.equal(fixture.writes.length, 2); assert.equal(fixture.writes[0].requestId, fixture.id);
    await fixture.instance.save(fixture.id, { title: "No original replay" });
    assert.equal(fixture.writes.length, 2);
  }
});

test("projected V1 exact whitelist rejection without an unknown marker still clears note and material pending", async () => {
  const note = await controller({ write: async () => ({ ok: false, status: 400, errorObject: { ok: false, error: { code: "note-material-title-invalid", details: {} } } }) });
  const started = await note.instance.start({ mode: "article", tabId: 11 });
  const noteSaved = await note.instance.save(started.draft.id, { title: "A" });
  assert.equal(noteSaved.draft.stage, "failed"); assert.equal(noteSaved.draft.notCommitted, true);
  assert.equal((await note.instance.pendingStatus()).pending.length, 0);
  const material = await syntheticScreenshot({ mode: "visible", rejection: { ok: false, status: 403, errorObject: { ok: false, error: { code: "consumer-folder-denied", details: {} } } } });
  const materialSaved = await material.instance.save(material.id, { title: "A", folderId: "folder-B" });
  assert.equal(materialSaved.draft.stage, "failed"); assert.equal(materialSaved.draft.notCommitted, true);
  assert.equal((await material.instance.pendingStatus()).pending.length, 0);
});

test("only exact first-attempt precommit note rejections clear pending and permit a new capture", async () => {
  for (const [code, status] of [["note-material-input-invalid", 400], ["note-material-title-invalid", 400], ["knowledge-name-conflict", 409]]) {
    const { instance, calls } = await controller({ write: async () => ({ ok: false, status, errorObject: { code } }) });
    const started = await instance.start({ mode: "article", tabId: 11 });
    const saved = await instance.save(started.draft.id, { title: "A" });
    assert.equal(saved.draft.stage, "failed"); assert.equal(saved.draft.notCommitted, true);
    assert.equal((await instance.pendingStatus()).pending.length, 0);
    assert.equal((await instance.start({ mode: "article", tabId: 11 })).ok, true);
    assert.equal((await instance.save(started.draft.id, { title: "Different body" })).ok, false);
    assert.equal(calls.filter(c => c.path.endsWith("/capture")).length, 1);
  }
});

test("unknown 4xx, postcommit partial and same-code without a verified status remain uncertain", async () => {
  for (const result of [{ ok: false, status: 409, errorObject: { code: "capture-commit-partial" } }, { ok: false, status: 403, errorObject: { code: "knowledge-source-inactive" } }, { ok: false, errorObject: { code: "note-material-title-invalid" } }, { ok: false, status: 400, errorObject: { code: "note-material-title-invalid", writeOutcome: "unknown" } }]) {
    const { instance } = await controller({ write: async () => result }); const started = await instance.start({ mode: "article", tabId: 11 });
    assert.equal((await instance.save(started.draft.id, { title: "A" })).draft.stage, "uncertain");
    assert.equal((await instance.pendingStatus()).pending.length, 1);
  }
});

test("successful receipt plus journal cleanup failure stays saved, never re-dispatches and can be acknowledged", async () => {
  const stored = {}; let sets = 0;
  const storage = { local: { get: async key => ({ [key]: stored[key] }), set: async value => { sets++; if (sets === 2) throw new Error("cleanup failed"); Object.assign(stored, structuredClone(value)); } } };
  const { instance, calls } = await controller({ storage }); const started = await instance.start({ mode: "article", tabId: 11 });
  const saved = await instance.save(started.draft.id, { title: "A" });
  assert.equal(saved.ok, true); assert.equal(saved.draft.stage, "saved"); assert.equal(saved.draft.journalCleanupPending, true);
  assert.equal((await instance.save(started.draft.id, { title: "B" })).ok, false);
  assert.equal(calls.filter(c => c.path.endsWith("/capture")).length, 1);
  assert.equal((await instance.start({ mode: "article", tabId: 11 })).code, "capture-commit-uncertain");
  await instance.acknowledge(started.draft.id); assert.equal((await instance.pendingStatus()).pending.length, 0);
});

test("material visibility/read/import/organize gates are explicit and checked before import", async () => {
  for (const option of [{ read: false }, { import: false }, { visible: false }, { state: "offline" }]) {
    const fixture = await syntheticScreenshot(option); assert.equal(fixture.started.ok, false); assert.equal(fixture.writes.length, 0);
  }
  const fixture = await syntheticScreenshot({ organize: false });
  const rejected = await fixture.instance.save(fixture.id, { title: "A", folderId: "folder-B" });
  assert.equal(rejected.code, "consumer-organize-denied"); assert.equal(rejected.draft.stage, "preview"); assert.equal(fixture.writes.length, 0);
  assert.equal((await fixture.instance.save(fixture.id, { title: "Root only" })).ok, true);
  const denied = await syntheticScreenshot({ rejection: { ok: false, status: 403, errorObject: { code: "consumer-folder-denied" } } });
  assert.equal((await denied.instance.save(denied.id, { title: "A" })).draft.notCommitted, true);
  assert.equal((await denied.instance.pendingStatus()).pending.length, 0);
  const delivery = await syntheticScreenshot({ rejection: { ok: false, status: 403, errorObject: { code: "consumer-delivery-denied", writeOutcome: "unknown" } } });
  assert.equal((await delivery.instance.save(delivery.id, { title: "A" })).draft.stage, "uncertain");
});

test("panel timeout followed by saving status polls the same request to a late successful receipt", async () => {
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, { value: "", children: [], hidden: ["preview", "receipt"].includes(id), disabled: false, textContent: "", events: {}, classList: { toggle() {} }, append(...values) { this.children.push(...values); }, replaceChildren(...values) { this.children = values; }, querySelectorAll: () => [], addEventListener(name, fn) { this.events[name] = fn; }, removeAttribute() {} }); return nodes.get(id); };
  let writes = 0, statuses = 0, panelPending = [];
  const context = { URLSearchParams, location: { search: "?tabId=11" }, Date, crypto: globalThis.crypto,
    setTimeout: (fn, ms) => setTimeout(fn, ms >= 120000 ? 2 : ms === 500 ? 5 : ms), clearTimeout,
    Option: class { constructor(name, value) { this.name = name; this.value = value; } }, document: { getElementById: node, documentElement: {}, createElement: () => node("new"), createTextNode: value => value }, addEventListener() {}, window: { close() {} },
    chrome: { windows: { getCurrent: async () => ({ id: 1 }) }, runtime: { sendMessage: (payload, respond) => {
      if (payload.action === "save") { writes++; return; }
      if (payload.action === "status") { statuses++; respond({ ok: true, draft: { id: "popup:late", mode: "article", stage: statuses === 1 ? "saving" : "saved", libraryId: "vault-A", sourceUrl: "https://page.test", receipt: { noteId: "note-A" } } }); return; }
      respond(payload.action === "pending" ? { ok: true, pending: panelPending } : { ok: true, data: { consumerVersion: 1, libraries: [
        { libraryId: "usable", visible: true, state: "ready", capabilities: { read: true, import: true, organize: false } },
        { libraryId: "ingest-only", visible: true, state: "ready", capabilities: { read: false, import: true } },
        { libraryId: "offline", visible: true, state: "offline", capabilities: { read: true, import: true } },
        { libraryId: "hidden", visible: false, state: "ready", capabilities: { read: true, import: true } },
      ] } });
    } } } };
  context.globalThis = context; vm.createContext(context);
  vm.runInContext(await readFile(new URL("../browser-extension-prototype/capture-panel.js", import.meta.url), "utf8"), context);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(node("library").children.map(option => option.value), ["usable"]);
  node("new-folder").value = "old folder"; node("new-tags").value = "old tag";
  vm.runInContext('render({id:"popup:synthetic-ui",mode:"visible",stage:"preview",title:"UI only",libraryId:"usable",sourceUrl:"https://page.test",bytesBase64:"SYNTHETIC",width:1,height:1,sizeBytes:1,materialCapabilities:{read:true,import:true,organize:false}})', context);
  assert.equal(node("new-taxonomy").hidden, true); assert.equal(node("organize-hint").hidden, false);
  assert.equal(node("new-folder").value, ""); assert.equal(node("new-tags").value, "");
  vm.runInContext('render({id:"popup:late",mode:"article",stage:"preview",title:"Late",libraryId:"vault-A",sourceUrl:"https://page.test",markdown:"body"})', context);
  panelPending = [{ requestId: "popup:other", libraryId: "vault-A", mode: "article" }];
  await vm.runInContext("refreshPending()", context); assert.equal(node("save").disabled, true);
  node("as-link").events.change(); assert.equal(node("save").disabled, true, "link fallback cannot reopen the pending gate");
  panelPending = []; await vm.runInContext("refreshPending()", context);
  assert.equal(node("save").disabled, false, "existing preview resumes when the other journal entry is actually cleared");
  await node("save").events.click();
  for (let i = 0; i < 50 && vm.runInContext("draft.stage", context) !== "saved"; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(vm.runInContext("draft.stage", context), "saved"); assert.equal(node("receipt").hidden, false);
  assert.equal(writes, 1); assert(statuses >= 2);
});

test("two open previews: first unknown blocks the second write and preserves its original pending identity", async () => {
  const { instance, calls } = await controller({ write: async () => ({ ok: false, errorObject: { code: "request-outcome-unknown" } }) });
  const first = await instance.start({ mode: "article", tabId: 11 });
  const second = await instance.start({ mode: "article", tabId: 11 });
  await instance.save(first.draft.id, { title: "Original A" });
  const pendingBefore = (await instance.pendingStatus()).pending;
  const blocked = await instance.save(second.draft.id, { title: "Still preview B" });
  assert.equal(blocked.ok, false); assert.equal(blocked.code, "capture-commit-uncertain"); assert.equal(blocked.draft.stage, "preview");
  assert.deepEqual((await instance.pendingStatus()).pending, pendingBefore);
  const writes = calls.filter(call => call.path === "/api/notes/capture");
  assert.equal(writes.length, 1); assert.equal(writes[0].body.requestId, first.draft.id); assert.equal(writes[0].body.title, "Original A");
});

test("different previews saving concurrently reserve only one journal entry and dispatch one POST", { timeout: 1000 }, async () => {
  let releaseStorage, releaseWrite;
  const storageGate = new Promise(resolve => { releaseStorage = resolve; });
  const writeGate = new Promise(resolve => { releaseWrite = resolve; });
  const stored = {};
  const storage = { local: { get: async key => ({ [key]: stored[key] }), set: async value => { await storageGate; Object.assign(stored, structuredClone(value)); } } };
  const { instance, calls } = await controller({ storage, write: async () => { await writeGate; return { ok: true, data: { noteId: "note-A" } }; } });
  const first = await instance.start({ mode: "article", tabId: 11 });
  const second = await instance.start({ mode: "article", tabId: 11 });
  const savingA = instance.save(first.draft.id, { title: "A" });
  const savingB = instance.save(second.draft.id, { title: "B" });
  releaseStorage(); let blocked;
  try { blocked = await Promise.race([savingB, new Promise((_, reject) => setTimeout(() => reject(new Error("second Save dispatched or remained blocked in transport")), 100))]); }
  catch (error) { releaseWrite(); await Promise.allSettled([savingA, savingB]); throw error; }
  assert.equal(blocked.ok, false); assert.equal(blocked.code, "capture-busy"); assert.equal(blocked.draft.stage, "preview");
  assert.equal(calls.filter(call => call.path === "/api/notes/capture").length, 1);
  const pending = (await instance.pendingStatus()).pending;
  assert.equal(pending.length, 1); assert.equal(pending[0].requestId, first.draft.id);
  releaseWrite(); assert.equal((await savingA).ok, true);
  assert.equal((await instance.pendingStatus()).pending.length, 0);
});

test("after the first success or exact zero-write refusal clears journal, an existing second preview can save", async () => {
  for (const outcome of ["success", "refused"]) {
    let count = 0;
    const { instance, calls } = await controller({ write: async () => {
      count++;
      return outcome === "refused" && count === 1
        ? { ok: false, status: 400, errorObject: { code: "note-material-title-invalid" } }
        : { ok: true, data: { noteId: `note-${count}` } };
    } });
    const first = await instance.start({ mode: "article", tabId: 11 });
    const second = await instance.start({ mode: "article", tabId: 11 });
    await instance.save(first.draft.id, { title: "A" });
    assert.equal((await instance.pendingStatus()).pending.length, 0);
    assert.equal((await instance.save(second.draft.id, { title: "B" })).ok, true);
    const writes = calls.filter(call => call.path === "/api/notes/capture");
    assert.equal(writes.length, 2); assert.equal(writes[1].body.requestId, second.draft.id);
  }
});

test("success with failed journal cleanup still blocks a second already-open preview", async () => {
  const stored = {}; let sets = 0;
  const storage = { local: { get: async key => ({ [key]: stored[key] }), set: async value => { sets++; if (sets === 2) throw new Error("cleanup failed"); Object.assign(stored, structuredClone(value)); } } };
  const { instance, calls } = await controller({ storage });
  const first = await instance.start({ mode: "article", tabId: 11 });
  const second = await instance.start({ mode: "article", tabId: 11 });
  const saved = await instance.save(first.draft.id, { title: "A" });
  assert.equal(saved.ok, true); assert.equal(saved.draft.journalCleanupPending, true);
  const blocked = await instance.save(second.draft.id, { title: "B" });
  assert.equal(blocked.ok, false); assert.equal(blocked.draft.stage, "preview");
  assert.equal(calls.filter(call => call.path === "/api/notes/capture").length, 1);
  assert.equal((await instance.pendingStatus()).pending[0].requestId, first.draft.id);
});

test("cancelled full capture keeps tab occupied until old shot/finally settles, preserving the next lease and focus", { timeout: 1000 }, async () => {
  let release; const captureGate = new Promise(resolve => { release = resolve; });
  const fixture = await syntheticScreenshot({ captureGate, leaseTracking: true, panelWindowId: 10 });
  assert.equal(fixture.lease(), 1); assert.equal(fixture.captureCount(), 1);
  try {
    assert.equal((await fixture.instance.cancel(fixture.id)).ok, true);
    assert.equal(fixture.lease(), 0, "cancel restores the page immediately");
    const blocked = await fixture.instance.start({ mode: "full", tabId: 11, libraryId: "lib-B" }, 20);
    assert.equal(blocked.ok, false); assert.equal(blocked.code, "capture-busy"); assert.equal(fixture.generation(), 1);
  } finally { release(); }
  let next;
  for (let i = 0; i < 100; i++) {
    next = await fixture.instance.start({ mode: "full", tabId: 11, libraryId: "lib-B" }, 20);
    if (next.ok) break;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(next.ok, true);
  for (let i = 0; i < 100 && fixture.instance.status(next.draft.id).draft.stage === "capturing"; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(fixture.instance.status(next.draft.id).draft.stage, "preview");
  assert.equal(fixture.generation(), 2); assert.equal(fixture.restoredLeases[0], 0, "old finally completes before new prepare");
  assert(!fixture.focused.includes(10), "cancelled old capture cannot steal focus back to its panel");
});
