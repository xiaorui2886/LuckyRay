importScripts("extension-protocol.js", "video-overlay-preference.js", "audio-collection.js", "local-transport-auth.js", "media-import-contract.js", "capture-task.js", "appearance.js", "material-library-consumer.js", "capture-controller.js", "capture-surface.js", "collection-input.js", "collection-batch.js");

const appearanceBroker = LuckyRayAppearance.createBroker({
  read: async () => (await chrome.storage.local.get(LuckyRayAppearance.CACHE_KEY))[LuckyRayAppearance.CACHE_KEY],
  write: value => chrome.storage.local.set({ [LuckyRayAppearance.CACHE_KEY]: value }),
  request: async () => {
    // Appearance follows the same verified binding; a stale selection keeps
    // the cached/default theme instead of reading another Desktop.
    const resolved = await resolveMaterialConnection();
    if (!resolved.ok) throw new Error("appearance-unavailable");
    const response = await LuckyRayLocalTransport.fetch(resolved.binding, "/api/v1/extension/appearance", { method: "GET", cache: "no-store" }, 2000);
    if (!response.ok) throw new Error("appearance-unavailable");
    return LuckyRayExtensionProtocol.unwrapTransportEnvelope(await response.json());
  },
});
chrome.runtime.onConnect?.addListener(port => {
  if (port.name !== LuckyRayAppearance.PORT_NAME || port.sender?.id !== chrome.runtime.id) return;
  const unsubscribe = appearanceBroker.subscribe(value => {
    try { port.postMessage(value); } catch (_) { /* Disconnected surface. */ }
  });
  port.onDisconnect.addListener(unsubscribe);
});

const SOURCE_HEADER = "browser-plugin";
const recentCapturesByTab = new Map();
const MEDIA_CANDIDATE_LIMIT = 40;
const mediaCandidatesByTab = new Map();
const observedSplitTracksByTab = new Map();
const VIDEO_MENU_SESSION_TTL_MS = 2 * 60_000;
const VIDEO_MENU_SESSION_LIMIT = 64;
const videoMenuSessions = new Map();
const VIDEO_CANDIDATE_SESSION_KEY = "luckyrayVideoCandidatesV1";
const VIDEO_CANDIDATE_CACHE_IO_TIMEOUT_MS = 750;
const MEDIA_TRANSFER_BINDING_SESSION_KEY = "luckyrayMediaTransferBindingsV1";
const MEDIA_TRANSFER_BINDING_TTL_MS = 24 * 60 * 60_000;
const MEDIA_TRANSFER_BINDING_LIMIT = 128;
const RECORD_STOP_TIMEOUT_MS = 120_000;
const MEDIA_TRANSFER_TERMINAL_STATES = new Set(["completed", "cancelled", "failed"]);
let videoCandidateCacheHydrated = false;
let videoCandidateCacheReady = null;
const mediaTransferBindings = new Map();
let mediaTransferBindingsReady = null;
const mediaActionGate = LuckyRayExtensionProtocol.createActionGate();
const directVideoActionGate = LuckyRayExtensionProtocol.createActionGate({ retainSuccessMs: 2000 });
const contentReceiver = LuckyRayExtensionProtocol.createContentReceiverBridge(chrome);
// PNG validation, managed-copy import and thumbnail publication are one bounded
// save, not a short availability probe. Stay below the panel's 120-second wait;
// a missing result still remains unknown and is never automatically resubmitted.
const PAGE_CAPTURE_SAVE_TIMEOUT_MS = 90_000;
// The material funnel (library choice, capability reads, saves, progress,
// resume, cancel and note attach) dispatches under one explicitly selected,
// proof-verified Desktop connection. The selection survives service-worker
// restarts for the browser session; task logs carry their own binding.
const CONNECTION_BINDING_SESSION_KEY = "luckyrayConnectionBindingV1";
let connectionBinding = null;
let connectionBindingReady = null;

function bindingShape(value) {
  return value && value.version === 1 && Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535
    && /^[a-f0-9]{64}$/.test(String(value.fingerprint || "")) ? value : null;
}

async function loadConnectionBinding() {
  if (connectionBinding) return connectionBinding;
  if (!connectionBindingReady) {
    connectionBindingReady = (async () => {
      const stored = (await chrome.storage.session.get(CONNECTION_BINDING_SESSION_KEY))[CONNECTION_BINDING_SESSION_KEY];
      connectionBinding = bindingShape(stored) ? stored : null;
    })().finally(() => { connectionBindingReady = null; });
  }
  await connectionBindingReady;
  return connectionBinding;
}

async function persistConnectionBinding(binding) {
  connectionBinding = bindingShape(binding) ? { ...binding,
    generation: Number.isInteger(connectionBinding?.generation) ? connectionBinding.generation + 1 : 1 } : null;
  if (connectionBinding) await chrome.storage.session.set({ [CONNECTION_BINDING_SESSION_KEY]: connectionBinding });
  else await chrome.storage.session.remove(CONNECTION_BINDING_SESSION_KEY);
  return connectionBinding;
}

// Resolves the connection the material funnel must use. An explicit (or
// once-auto-bound) selection is re-verified on ITS OWN endpoint only: when
// that instance is gone the selection STAYS recorded and every dispatch
// fails closed with `connection-selection-stale` until the user explicitly
// re-selects — the remaining instances are never tried, so library choice,
// organize targets, capabilities and saves can never silently move to
// another Desktop. With no recorded selection at all, exactly one verified
// instance binds once; several require an explicit choice.
async function resolveMaterialConnection() {
  const stored = await loadConnectionBinding();
  if (stored) {
    try {
      const verified = await LuckyRayLocalTransport.openBinding(stored.port);
      if (verified.fingerprint === stored.fingerprint) {
        return { ok: true, binding: { ...stored, serverNonce: verified.serverNonce } };
      }
    } catch (_) { /* the selected endpoint no longer verifies */ }
    let refreshed = null;
    try { refreshed = await LuckyRayLocalTransport.discoverCandidates(); } catch (_) { /* offline */ }
    return { ok: false, code: "connection-selection-stale",
      stale: { ...stored, serverNonce: null }, ...(refreshed ? { candidates: refreshed } : {}) };
  }
  let candidates;
  try {
    candidates = await LuckyRayLocalTransport.discoverCandidates();
  } catch (error) {
    return { ok: false, code: error?.code || "app-unavailable" };
  }
  if (candidates.length === 1) {
    return { ok: true, binding: await persistConnectionBinding({ ...candidates[0] }) };
  }
  return { ok: false, code: "multiple-instances", candidates };
}

async function requestCaptureApi(method, path, body, connection, meta) {
  const options = { method, headers: { "Content-Type": "application/json", "X-LuckyRay-Source": "luckyray-plugin" } };
  if (body !== undefined) options.body = JSON.stringify(body);
  // Only receipt-backed endpoints may replay an identical write. A second
  // requestId would create a different action and is never generated here.
  const receiptBacked = !body?.libraryId && body?.requestId && new Set(["/api/media/transfers", "/api/assets/import-media", "/api/notes/attach-material"]).has(path);
  let binding = connection;
  if (binding === undefined) {
    const resolved = await resolveMaterialConnection();
    if (!resolved.ok) {
      return { ok: false, notDispatched: true, errorObject: { code: resolved.code },
        ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
        ...(resolved.stale ? { stale: resolved.stale } : {}) };
    }
    binding = resolved.binding;
  }
  let outcomeUnknown = false;
  for (let attempt = 0; attempt < (receiptBacked ? 2 : 1); attempt += 1) {
    let responseStatus = null, phase = "transport";
    try {
      const timeoutMs = method === "POST" && ["/api/material-libraries/import-bytes", "/api/assets/import-media"].includes(path)
        ? PAGE_CAPTURE_SAVE_TIMEOUT_MS : undefined;
      const response = await LuckyRayLocalTransport.fetch(binding, path, options, timeoutMs, meta);
      responseStatus = response.status; phase = "response-json";
      const payload = await response.json();
      return response.ok
        ? { ok: true, status: response.status, data: LuckyRayExtensionProtocol.unwrapTransportEnvelope(payload) }
        : { ok: false, status: response.status, errorObject: payload,
          diagnostic: { phase: "http-response", status: response.status } };
    } catch (error) {
      outcomeUnknown ||= error?.code === "request-outcome-unknown" || error instanceof SyntaxError;
      // Only a failure proven to predate any dispatch may replay the write.
      // A lost response or a service restart keeps the outcome explicitly
      // unknown; the task reconciles through the durable receipt instead.
      if (receiptBacked && attempt === 0 && !outcomeUnknown && error?.notDispatched === true) continue;
      return { ok: false, notDispatched: !outcomeUnknown && error?.notDispatched === true,
        diagnostic: { phase: error?.notDispatched === true ? "connection-before-send" : phase,
          status: responseStatus, errorKind: phase === "response-json" ? "invalid-json" : error?.transportFailure || "transport-error",
          network: error?.transportNetwork, restarted: error?.restarted === true },
        errorObject: { code: outcomeUnknown ? "capture-commit-uncertain" : error?.code || "app-unavailable" } };
    }
  }
}

const CAPTURE_TASK_KEY = "luckyrayCaptureTaskV1";
const captureTask = LuckyRayCaptureTask.create({
  read: async () => (await chrome.storage.local.get(CAPTURE_TASK_KEY))[CAPTURE_TASK_KEY],
  write: (task) => chrome.storage.local.set({ [CAPTURE_TASK_KEY]: task }),
  request: (method, path, body, connection, meta) => requestCaptureApi(method, path, body, connection, meta),
  protocol: LuckyRayExtensionProtocol,
  media: LuckyRayMediaImport,
  connection: resolveMaterialConnection,
  // Restart recovery is confirmed only after the task layer verified a valid
  // durable receipt; the transport never unlocks on a response by itself.
  confirm: async (connection, expectedNonce) => {
    try {
      return await LuckyRayLocalTransport.confirmBinding(connection, expectedNonce);
    } catch (error) {
      return { ok: false, code: error?.code || "verification-unavailable" };
    }
  },
});
// Rehydrate only the known job/receipt when a suspended service worker wakes.
captureTask.status().catch(() => {});

async function mediaLibraries(connection) {
  const capabilities = await requestCaptureApi("GET", "/api/v1/capabilities", undefined, connection);
  if (!capabilities.ok) return { ok: false, code: "media-library-unavailable" };
  if (!LuckyRayMediaImport.capability(capabilities.data)) return { ok: true, supported: false };
  const result = await requestCaptureApi("GET", "/api/material-libraries", undefined, connection);
  if (!result.ok || result.data?.consumerVersion !== 1 || !Array.isArray(result.data.libraries)) return { ok: false, code: "media-library-denied" };
  const isolated = globalThis.__LUCKYRAY_ISOLATED_TRANSPORT_TARGET__;
  return { ok: true, supported: true, data: isolated ? { ...result.data, libraries: result.data.libraries.filter(library => isolated.libraryIds.includes(library.libraryId)) } : result.data };
}
// Direct media entries use the same authorized library
// choice as the popup. Never guess another library after a stored pick expires.
async function imageDestination(libraryId = "", connection) {
  const result = await mediaLibraries(connection);
  if (!result.ok || !result.supported) return { ok: false, code: "media-library-unavailable" };
  const saved = (await chrome.storage.session.get("luckyrayMediaDestinationV1")).luckyrayMediaDestinationV1;
  const id = libraryId || (saved?.mode === "explicit" ? saved.libraryId : "");
  const available = result.data.libraries.filter(library => library.visible === true && library.state === "ready"
    && library.capabilities?.read === true && library.capabilities?.import === true);
  const library = id ? available.find(library => library.libraryId === id)
    : available.find(library => library.libraryId === result.data.legacyLibraryId)
      || (available.length === 1 ? available[0] : null);
  return library ? { ok: true, library } : { ok: false, code: "media-library-denied" };
}
async function validateMediaDestination(target, noteRequest = null, connection) {
  const result = await mediaLibraries(connection);
  if (!result.ok || !result.supported) return { ok: false, code: result.code || "media-library-unavailable" };
  const library = result.data.libraries.find(value => value.libraryId === target.libraryId);
  if (!library || library.visible !== true || library.state !== "ready" || library.capabilities?.read !== true || library.capabilities?.import !== true) return { ok: false, code: "media-library-denied" };
  if (noteRequest && target.libraryId !== result.data.legacyLibraryId) return { ok: false, code: "media-note-library-unsupported" };
  const organized = target.folderId || target.newFolderName || target.tagIds?.length || target.tagNames?.length;
  if (organized && library.capabilities.organize !== true) return { ok: false, code: "media-organize-denied" };
  if (organized) {
    const taxonomy = await requestCaptureApi("POST", "/api/material-libraries/taxonomy", { libraryId: target.libraryId, requestId: `popup:taxonomy:${crypto.randomUUID()}` }, connection);
    if (!taxonomy.ok || taxonomy.data?.consumerVersion !== 1 || taxonomy.data.libraryId !== target.libraryId) return { ok: false, code: "media-library-denied" };
    if ([target.folderId, target.parentFolderId].filter(Boolean).some(id => !taxonomy.data.folders?.some(folder => folder.id === id))) return { ok: false, code: "media-folder-invalid" };
    if ((target.tagIds || []).some(id => !taxonomy.data.tags?.some(tag => tag.id === id))) return { ok: false, code: "media-tags-invalid" };
  }
  return { ok: true };
}
async function inspectImageExtension(url) {
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 8000);
  let reader;
  try {
    const response = await fetch(url, { method: "GET", credentials: "omit", referrerPolicy: "no-referrer", headers: { Range: "bytes=0-4095" }, signal: abort.signal });
    if (!response.ok || !response.body?.getReader) return null;
    reader = response.body.getReader();
    const chunks = []; let length = 0;
    while (length < 4096) { const next = await reader.read(); if (next.done) break; const chunk = next.value.slice(0, 4096 - length); chunks.push(chunk); length += chunk.length; }
    const prefix = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { prefix.set(chunk, offset); offset += chunk.length; }
    return LuckyRayMediaImport.extension(prefix, response.headers.get("content-type") || "");
  } catch (_) { return null; }
  finally { clearTimeout(timer); if (reader) await reader.cancel().catch(() => {}); abort.abort(); }
}
async function prepareMediaTask(input, connection) {
  input = JSON.parse(JSON.stringify(input));
  if (input.kind === "audio") {
    const fresh = await readAudioCollection(input.tabId, input.pageUrl);
    const candidate = fresh.candidates?.find(item => item.url === input.request?.url);
    if (!fresh.ok || fresh.documentToken !== input.documentToken || !candidate?.importable || input.noteRequest)
      return { ok: false, code: "audio-source-changed" };
    // The existing endpoint is a generic transfer queue, not a video mediaType.
    // Do not forward arbitrary cookie/resolver/track-pair fields from a popup.
    input.request = { url: candidate.url, requestId: input.request.requestId,
      fileName: input.request.fileName, mimeType: candidate.contentType, sourcePageUrl: input.pageUrl,
      ...(input.request.targetFolderId ? { targetFolderId: input.request.targetFolderId } : {}),
      ...(input.request.newFolderName ? { newFolderName: input.request.newFolderName } : {}) };
  }
  const target = input.destination || (input.request?.libraryId ? {
    libraryId: input.request.libraryId, folderId: input.request.targetFolderId, newFolderName: input.request.newFolderName,
    parentFolderId: input.request.parentFolderId, tagIds: input.request.tagIds, tagNames: input.request.tagNames,
  } : null);
  if (!target) return { ok: true, input };
  const admitted = await validateMediaDestination(target, input.noteRequest, connection);
  if (!admitted.ok) return admitted;
  let request = { ...input.request };
  delete request.folder; delete request.newFolder; delete request.parentFolder;
  let name;
  if (input.kind === "image") {
    const extension = await inspectImageExtension(request.url);
    const named = LuckyRayMediaImport.filename({ typed: input.mediaName || request.name || "", fallback: input.fallbackName || "网页图片", extension });
    if (!named.ok) return named;
    name = named.name;
  } else if (input.kind !== "audio" && input.destination && !input.videoExtension && !classifyVideoCandidate(request.url, request.contentType || "")?.direct) {
    return { ok: false, code: "media-format-unsupported" };
  }
  const organization = LuckyRayMediaImport.organization(target, input.kind, name);
  if (!organization.ok) return organization;
  request = { ...request, ...organization.fields };
  const validated = LuckyRayMediaImport.validateRequest(input.kind, request);
  return validated.ok ? { ok: true, input: { ...input, request: validated.request } } : validated;
}

async function readImageCollection(tabId, pageUrl, rescan = false) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.url !== pageUrl || !LuckyRayCollectionInput.linkUrl(tab.url)) return { ok: false, code: "capture-target-changed" };
  const result = await contentReceiver.request(tabId, { type: "luckyray-image-collection", rescan: rescan === true }, { frameId: 0, requiredProtocolVersion: LuckyRayExtensionProtocol.CAPTURE_PROTOCOL_VERSION });
  const after = await chrome.tabs.get(tabId);
  return result?.ok && result.pageUrl === pageUrl && after.url === pageUrl ? result : { ok: false, code: "capture-target-changed" };
}
function batchSourcePageTitle(value) {
  // MaterialSourcePageInput::from_parts trims source titles and accepts at
  // most 240 UTF-8 bytes without control characters. This is provenance text,
  // so filename punctuation and naming rules do not apply.
  const title = String(value || "").trim();
  if (!title || /[\u0000-\u001f\u007f-\u009f]/.test(title)
    || !Number.isFinite(LuckyRayMediaImport.utf8Length(title))) return "";
  let prefix = "", bytes = 0;
  for (const point of title) {
    const length = LuckyRayMediaImport.utf8Length(point);
    if (bytes + length > 240) break;
    prefix += point; bytes += length;
  }
  return prefix.trim();
}
const imageBatch = LuckyRayCollectionBatch.create({
  read: async () => {
    const journal = (await chrome.storage.local.get("luckyrayImageBatchV1")).luckyrayImageBatchV1;
    if (!journal) return null;
    const media = (await chrome.storage.session.get("luckyrayImageBatchUrlsV1")).luckyrayImageBatchUrlsV1;
    return { ...journal, items: journal.items.map(item => ({ ...item, url: media?.batchId === journal.id ? media.urls?.[item.requestId] || "" : "" })) };
  },
  write: async batch => {
    // Signed media URLs stay in browser-session memory. The durable journal
    // keeps receipt IDs/results, not bearer-bearing image URLs or credentials.
    await chrome.storage.session.set({ luckyrayImageBatchUrlsV1: { batchId: batch.id,
      urls: Object.fromEntries(batch.items.filter(item => item.url).map(item => [item.requestId, item.url])) } });
    const journal = JSON.parse(JSON.stringify(batch));
    for (const item of journal.items) delete item.url;
    for (const previous of journal.previous || []) for (const item of previous.items) delete item.url;
    await chrome.storage.local.set({ luckyrayImageBatchV1: journal });
  }, task: captureTask,
  prepare: async (item, target, source, connection) => {
    // Legacy journals cannot acquire whichever Desktop is selected now.
    // The durable batch binding owns preparation and every accepted item.
    if (!bindingShape(connection)) return { ok: false, code: "capture-task-binding-missing" };
    if (!item.url) return { ok: false, code: "capture-target-changed" };
    const tab = await chrome.tabs.get(source.tabId);
    if (tab.url !== source.pageUrl || !["asset:root", "asset:pick"].includes(target?.mode)
      || (target.mode === "asset:pick" && !target.folderId)) return { ok: false, code: "capture-target-changed" };
    const renewed = await contentReceiver.request(tab.id, { type: "luckyray-image-renew", ...item, session: source.session, pageUrl: source.pageUrl },
      { frameId: 0, requiredProtocolVersion: LuckyRayExtensionProtocol.CAPTURE_PROTOCOL_VERSION });
    const current = await chrome.tabs.get(tab.id);
    if (!renewed?.ok || renewed.pageUrl !== source.pageUrl || current.url !== source.pageUrl
      || renewed.descriptor?.url !== item.url || renewed.descriptor?.documentToken !== source.session || !item.binding
      || item.binding.documentToken !== source.session || renewed.descriptor.targetToken !== item.binding.targetToken
      || (renewed.descriptor.linkUrl || null) !== item.binding.linkUrl) return { ok: false, code: "capture-target-changed" };
    const intent = LuckyRayExtensionProtocol.createMaterialImportIntent({ mediaType: "image", url: item.url,
      ...(target.mode === "asset:pick" ? { targetFolderId: target.folderId } : {}),
      actionId: item.requestId, requestId: item.requestId, kind: "image", storageMode: "managed", mode: target.mode, captureSource: "popup" });
    let request = { ...intent.request };
    if (await supportsMaterialSourcePage(connection)) {
      // Images bind provenance in sourcePageUrl. materialSourcePageUrl belongs
      // to video transfers, whose sourcePageUrl is downloader/resolver context.
      const sourcePageUrl = renewed.descriptor.linkUrl || source.pageUrl;
      const sourcePageTitle = sourcePageUrl === source.pageUrl ? batchSourcePageTitle(current.title) : "";
      Object.assign(request, { sourcePageUrl, sourcePageKind: renewed.descriptor.linkUrl ? "work-page" : "capture-page",
        ...(sourcePageTitle ? { sourcePageTitle } : {}) });
    }
    return prepareMediaTask({ kind: "image", request, sourceUrl: source.pageUrl,
      ...(target.destination ? { destination: target.destination, mediaName: target.namePrefix ? `${target.namePrefix} ${item.index || 1}` : "", fallbackName: item.name } : {}) }, connection);
  },
});
imageBatch.status().catch(() => {});

const pageCapture = LuckyRayPageCaptureController.create({
  chromeApi: chrome,
  page: (tabId, action, input = {}) => contentReceiver.request(tabId, { type: `luckyray-page-capture-${action}`, ...input }, { frameId: 0, requiredProtocolVersion: LuckyRayExtensionProtocol.CAPTURE_PROTOCOL_VERSION }),
  request: requestCaptureApi,
});
const captureReturns = new Map();
async function showCaptureMain(tab, context) {
  if (!LuckyRayExtensionProtocol.normalizeSourcePageUrl(tab?.url) || !chrome.action?.openPopup) throw new Error("capture-main-unavailable");
  // Main resolves its page from the active tab. Focus the verified source,
  // never a newly-created extension tab or the independent preview window.
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
  for (const [key, value] of captureReturns) if (value.expires < Date.now()) captureReturns.delete(key);
  if (captureReturns.size >= 32) throw new Error("capture-busy");
  const nonce = crypto.randomUUID(), previous = await chrome.action.getPopup({ tabId: tab.id });
  captureReturns.set(nonce, { ...context, tabId: tab.id, pageUrl: tab.url, expires: Date.now() + 60000 });
  try {
    await chrome.action.setPopup({ tabId: tab.id, popup: `popup.html?captureReturn=${nonce}` });
    await chrome.action.openPopup({ windowId: tab.windowId });
  } catch (error) { captureReturns.delete(nonce); throw error; }
  finally { await chrome.action.setPopup({ tabId: tab.id, popup: previous }); }
}
const captureSurface = LuckyRayCaptureSurface.create({ chromeApi: chrome, controller: pageCapture, showMain: showCaptureMain,
  page: (tabId, action, input = {}) => contentReceiver.request(tabId, { type: `luckyray-page-capture-${action}`, ...input }, { frameId: 0, requiredProtocolVersion: LuckyRayExtensionProtocol.CAPTURE_PROTOCOL_VERSION }) });

chrome.commands?.onCommand.addListener(async command => {
  if (command === "toggle-video-overlays") {
    await LuckyRayVideoOverlayPreference.toggle().catch(() => notify("视频悬浮按钮设置未保存，请重试。", true));
    return;
  }
  if (!["capture-page", "collect-images", "capture-visible", "show-collector"].includes(command)) return;
  const tab = await getActiveTab();
  if (!tab?.id || !LuckyRayExtensionProtocol.normalizeSourcePageUrl(tab.url)) return;
  if (command === "show-collector" || command === "collect-images") {
    await setPrefill({ type: "image", mode: "root", tabId: tab.id, ...(command === "collect-images" ? { collectionMode: "grid" } : {}) }); return;
  }
  const result = await captureSurface.open(tab.id, command === "capture-visible" ? "visible" : "article");
  if (!result.ok) void notify("此页面无法显示采集浮层，请从扩展菜单选择备用预览。");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !["luckyray-capture-return", "luckyray-capture-open", "luckyray-capture-surface", "luckyray-page-draft", "luckyray-capture-libraries", "luckyray-capture-taxonomy"].includes(message.type)) return;
  const surface = sender.url?.split(/[?#]/)[0];
  if (sender.id !== chrome.runtime.id || ![chrome.runtime.getURL("popup.html"), chrome.runtime.getURL("capture.html")].includes(surface)) {
    sendResponse({ ok: false, code: "capture-forbidden" }); return;
  }
  (async () => {
    if (message.type === "luckyray-capture-return") {
      if (surface !== chrome.runtime.getURL("popup.html") || sender.tab) return { ok: false, code: "capture-forbidden" };
      const nonce = new URL(sender.url).searchParams.get("captureReturn"), context = captureReturns.get(nonce);
      if (!context || context.expires < Date.now()) { captureReturns.delete(nonce); return { ok: false, code: "capture-forbidden" }; }
      captureReturns.delete(nonce); // One action document consumes its own URL-bound context.
      const tab = await chrome.tabs.get(context.tabId);
      if (tab.url !== context.pageUrl) return { ok: false, code: "capture-forbidden" };
      const state = await contentReceiver.request(tab.id, { type: "luckyray-page-capture-surface-state" }, { frameId: 0, requiredProtocolVersion: LuckyRayExtensionProtocol.CAPTURE_PROTOCOL_VERSION });
      if (!state.ok || state.documentToken !== context.documentToken || state.url !== context.pageUrl || (context.session && state.session !== context.session)) return { ok: false, code: "capture-forbidden" };
      return { ok: true, context: { tabId: tab.id, pageUrl: tab.url, category: context.category } };
    }
    if (message.type === "luckyray-capture-open") {
      if (surface !== chrome.runtime.getURL("popup.html")) return { ok: false, code: "capture-forbidden" };
      const tab = await chrome.tabs.get(message.tabId);
      if (!LuckyRayExtensionProtocol.normalizeSourcePageUrl(tab.url)) return { ok: false, code: "capture-page-unavailable" };
      if (message.fallback === true) {
        const category = ["image", "video", "text", "link"].includes(message.returnCategory) ? message.returnCategory : message.mode === "article" ? "text" : "image";
        await chrome.windows.create({ url: chrome.runtime.getURL(`capture.html?tabId=${tab.id}&mode=${encodeURIComponent(message.mode || "article")}&returnCategory=${category}`), type: "popup", width: 600, height: 760 });
        return { ok: true, fallback: true };
      }
      return captureSurface.open(tab.id, message.mode || "article", message.returnCategory);
    }
    if (surface !== chrome.runtime.getURL("capture.html")) return { ok: false, code: "capture-forbidden" };
    const inline = new URL(sender.url).searchParams.get("inline") === "1";
    if (inline && message.type === "luckyray-capture-surface" && ["close", "return-main"].includes(message.action)) return captureSurface.close(sender, message.action === "return-main");
    const session = inline ? await captureSurface.authorize(sender) : null;
    // A web-accessible frame is never authority merely because its URL is ours.
    if ((inline && !session) || (!inline && sender.tab && !sender.tab.url?.startsWith(chrome.runtime.getURL("capture.html")))) return { ok: false, code: "capture-forbidden" };
    if (message.type === "luckyray-capture-surface") {
      if (!inline && message.action === "return-main") {
        const sourceId = Number(new URL(sender.url).searchParams.get("tabId"));
        if (!Number.isInteger(sourceId)) return { ok: false, code: "capture-forbidden" };
        const tab = await chrome.tabs.get(sourceId);
        const state = await contentReceiver.request(sourceId, { type: "luckyray-page-capture-surface-state" }, { frameId: 0, requiredProtocolVersion: LuckyRayExtensionProtocol.CAPTURE_PROTOCOL_VERSION });
        if (!state.ok || state.url !== tab.url) return { ok: false, code: "capture-forbidden" };
        const requested = new URL(sender.url).searchParams.get("returnCategory");
        await showCaptureMain(tab, { category: ["image", "video", "text", "link"].includes(requested) ? requested : new URL(sender.url).searchParams.get("mode") === "article" ? "text" : "image", documentToken: state.documentToken });
        return { ok: true };
      }
      if (!session || message.action !== "ready") return { ok: false, code: "capture-forbidden" };
      const height = Number.isFinite(message.height) ? Math.max(120, Math.min(740, Math.ceil(message.height))) : undefined;
      return contentReceiver.request(session.tabId, { type: "luckyray-page-capture-surface-ready", session: session.id, documentToken: session.documentToken, height }, { frameId: 0, requiredProtocolVersion: LuckyRayExtensionProtocol.CAPTURE_PROTOCOL_VERSION });
    }
    if (message.type === "luckyray-capture-libraries") return requestCaptureApi("GET", "/api/material-libraries");
    if (message.type === "luckyray-capture-taxonomy") return requestCaptureApi("POST", "/api/material-libraries/taxonomy", { libraryId: message.libraryId, requestId: message.requestId });
    if (inline && message.action !== "pending") return captureSurface.draft(session, message);
    if (message.action === "start") return pageCapture.start(message.input, Number.isInteger(message.panelWindowId) ? message.panelWindowId : sender.tab?.windowId);
    if (message.action === "status") return pageCapture.status(message.id);
    if (message.action === "cancel") return pageCapture.cancel(message.id);
    if (message.action === "save") return pageCapture.save(message.id, message.input || {});
    if (message.action === "pending") return pageCapture.pendingStatus();
    if (message.action === "acknowledge") return pageCapture.acknowledge(message.id);
    return { ok: false, code: "capture-action-invalid" };
  })().then(sendResponse).catch(() => sendResponse({ ok: false, code: "capture-unavailable" }));
  return true;
});

function settleAvailabilityWithin(promise, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    Promise.resolve(promise).then(finish, () => finish(null));
  });
}

function getResponseHeader(headers, name) {
  const want = String(name || "").toLowerCase();
  const item = (headers || []).find((h) => String(h.name || "").toLowerCase() === want);
  return item ? String(item.value || "") : "";
}

function getExtensionFromUrl(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const match = path.match(/\.([a-z0-9]{2,5})$/);
    return match ? match[1] : "";
  } catch (_) {
    return "";
  }
}

function classifyVideoCandidate(url, contentType) {
  const value = String(url || "").toLowerCase();
  const type = String(contentType || "").toLowerCase();
  const ext = getExtensionFromUrl(value);
  if (!value) return null;
  let host = "";
  try { host = new URL(value).hostname.toLowerCase(); } catch (_) {}
  const pinterestCmfv = ext === "cmfv" && (host === "pinimg.com" || host.endsWith(".pinimg.com"));
  if (value.startsWith("blob:")) return { kind: "blob", direct: false, reason: "站内 blob 播放流" };
  if (value.includes(".m3u8") || type.includes("mpegurl") || type.includes("x-mpegurl")) {
    return { kind: "hls", direct: false, reason: "HLS 分片播放列表" };
  }
  if (value.includes(".mpd") || type.includes("dash+xml")) {
    return { kind: "dash", direct: false, reason: "DASH 分片播放列表" };
  }
  if (["ts", "m4s"].includes(ext)) return { kind: "segment", direct: false, reason: "视频分片" };
  if (["mp4", "webm", "mov", "m4v", "ogv", "ogg"].includes(ext) || type.startsWith("video/") || pinterestCmfv) {
    return {
      kind: "direct_video",
      direct: true,
      reason: "可下载视频直链",
      ...(pinterestCmfv && !type ? { contentType: "video/mp4" } : {}),
    };
  }
  if (type === "application/octet-stream" && ["mp4", "webm", "mov", "m4v"].includes(ext)) {
    return { kind: "direct_video", direct: true, reason: "可下载视频直链" };
  }
  return null;
}

function rememberVideoCandidate(tabId, candidate) {
  if (typeof tabId !== "number" || tabId < 0 || !candidate || !candidate.url) return;
  if (candidate.kind === "segment") return;
  if (!videoCandidateCacheHydrated) {
    void ensureVideoCandidateCache().then(() => rememberVideoCandidate(tabId, candidate));
    return;
  }
  const now = Date.now();
  const list = mediaCandidatesByTab.get(tabId) || [];
  const existing = list.find((item) => item.url === candidate.url);
  if (existing) {
    existing.lastSeenAt = now;
    existing.contentType = candidate.contentType || existing.contentType;
    existing.size = candidate.size || existing.size;
    existing.kind = candidate.kind || existing.kind;
    existing.direct = typeof candidate.direct === "boolean" ? candidate.direct : existing.direct;
    existing.reason = candidate.reason || existing.reason;
    existing.source = candidate.source || existing.source;
    existing.width = Number(candidate.width) || existing.width;
    existing.height = Number(candidate.height) || existing.height;
    existing.bitrate = Number(candidate.bitrate) || existing.bitrate;
    existing.frameId = Number.isInteger(candidate.frameId) ? candidate.frameId : existing.frameId;
    existing.documentId = candidate.documentId || existing.documentId;
    if (candidate.binding === "site-track-pair" && safeDragCollectUrl(candidate.audioUrl)) {
      existing.audioUrl = candidate.audioUrl;
      existing.binding = "site-track-pair";
    }
  } else {
    list.unshift({
      ...candidate,
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }
  list.sort((a, b) => Number(b.direct) - Number(a.direct) || b.lastSeenAt - a.lastSeenAt);
  mediaCandidatesByTab.set(tabId, list.slice(0, MEDIA_CANDIDATE_LIMIT));
  void persistVideoCandidateCache();
}

function mediaResponseType(url, contentType) {
  const headerType = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
  if (headerType.startsWith("video/") || headerType.startsWith("audio/")) return headerType;
  try {
    const queryType = String(new URL(String(url || "")).searchParams.get("mime") || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    return queryType.startsWith("video/") || queryType.startsWith("audio/") ? queryType : "";
  } catch (_) {
    return "";
  }
}

function boundedMediaResponseSize(url, size) {
  const headerSize = Number(size);
  if (Number.isSafeInteger(headerSize) && headerSize > 0) return Math.min(headerSize, 2_147_483_648);
  try {
    const querySize = Number(new URL(String(url || "")).searchParams.get("clen"));
    return Number.isSafeInteger(querySize) && querySize > 0 ? Math.min(querySize, 2_147_483_648) : 0;
  } catch (_) {
    return 0;
  }
}

function isHostSuffix(url, suffix) {
  try {
    const host = new URL(String(url || "")).hostname.replace(/\.$/, "").toLowerCase();
    return host === suffix || host.endsWith(`.${suffix}`);
  } catch (_) {
    return false;
  }
}

function canonicalObservedTrackUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (!isHostSuffix(parsed.href, "googlevideo.com")) return parsed.href;
    const length = Number(parsed.searchParams.get("clen"));
    if (Number.isSafeInteger(length) && length > 0 && length <= 2_147_483_648) {
      parsed.searchParams.set("range", `0-${length - 1}`);
    } else {
      parsed.searchParams.delete("range");
    }
    parsed.searchParams.delete("rn");
    parsed.searchParams.delete("rbuf");
    return parsed.href;
  } catch (_) {
    return "";
  }
}

async function observeSplitMediaTrack(details, contentType, size) {
  if (!Number.isInteger(details?.tabId) || details.tabId < 0 || !isHostSuffix(details.url, "googlevideo.com")) return;
  const type = mediaResponseType(details.url, contentType);
  const role = type.startsWith("video/") ? "video" : type.startsWith("audio/") ? "audio" : "";
  if (!role) return;
  const tab = await chrome.tabs.get(details.tabId).catch(() => null);
  const pageUrl = supportedResolverPageUrl(tab?.url);
  if (!pageUrl || !isHostSuffix(pageUrl, "youtube.com")) return;
  const now = Date.now();
  const previous = observedSplitTracksByTab.get(details.tabId);
  const state = previous?.pageUrl === pageUrl
    ? previous
    : { pageUrl, video: null, audio: null };
  const candidate = {
    url: canonicalObservedTrackUrl(details.url),
    contentType: type,
    size: boundedMediaResponseSize(details.url, size),
    frameId: Number.isInteger(details.frameId) ? details.frameId : 0,
    documentId: details.documentId || null,
    observedAt: now,
  };
  const current = state[role];
  if (!current || candidate.size >= current.size || now - current.observedAt > 30_000) state[role] = candidate;
  observedSplitTracksByTab.set(details.tabId, state);
  if (!state.video || !state.audio || Math.abs(state.video.observedAt - state.audio.observedAt) > 30_000) return;
  rememberVideoCandidate(details.tabId, {
    url: state.video.url,
    audioUrl: state.audio.url,
    binding: "site-track-pair",
    kind: "track_pair",
    direct: false,
    reason: "浏览器实际播放的独立音视频轨",
    contentType: state.video.contentType || "video/mp4",
    size: state.video.size || "",
    source: "network-track-pair",
    frameId: state.video.frameId,
    documentId: state.video.documentId,
  });
}

function getVideoCandidatesForTab(tabId) {
  const list = mediaCandidatesByTab.get(tabId) || [];
  const projected = list.map((item) => ({
      url: item.url,
      kind: item.kind,
      direct: !!item.direct,
      reason: item.reason || "",
      contentType: item.contentType || "",
      size: item.size || "",
      source: item.source || "network",
      frameId: Number.isInteger(item.frameId) ? item.frameId : -1,
      documentId: item.documentId || null,
      ...(item.binding === "site-track-pair" && safeDragCollectUrl(item.audioUrl)
        ? { audioUrl: item.audioUrl, binding: "site-track-pair" }
        : {}),
      lastSeenAt: item.lastSeenAt,
    }));
  const quality = (candidate) => LuckyRayExtensionProtocol.buildVideoActionMenu([candidate], { maxItems: 1 }).items[0] || {};
  return projected.sort((left, right) => {
    const a = quality(left);
    const b = quality(right);
    return Number(b.height || 0) - Number(a.height || 0)
      || Number(b.width || 0) - Number(a.width || 0)
      || Number(b.bitrate || 0) - Number(a.bitrate || 0)
      || Number(b.canDownload) - Number(a.canDownload)
      || Number(right.lastSeenAt || 0) - Number(left.lastSeenAt || 0);
  });
}

function getPopupVideoCandidates(tab) {
  const candidates = getVideoCandidatesForTab(tab?.id);
  const resolverPage = supportedResolverPageUrl(tab?.url);
  if (!resolverPage || candidates.some((candidate) => candidate.url === resolverPage)) {
    return candidates;
  }
  return [...candidates, {
    url: resolverPage,
    contentType: "application/x-luckyray-video-page",
    kind: "site_page",
    direct: false,
    reason: "站点解析最佳公开版本",
    source: "site-resolver",
    frameId: 0,
    documentId: null,
    lastSeenAt: Date.now(),
  }];
}

const observedAudioByTab = new Map();
async function observeAudioResponse(details, mime) {
  if (!Number.isInteger(details.tabId) || details.tabId < 0 || details.statusCode < 200 || details.statusCode >= 300
    || !String(mime).toLowerCase().startsWith("audio/")) return;
  const candidate = LuckyRayAudioCollection.classify(details.url, mime);
  if (!candidate) return;
  const tab = await chrome.tabs.get(details.tabId).catch(() => null);
  if (!tab?.url || details.initiator && new URL(tab.url).origin !== details.initiator) return;
  const now = Date.now(), old = observedAudioByTab.get(tab.id);
  const record = old?.pageUrl === tab.url && now - old.at < 600000 ? old : { pageUrl: tab.url, at: now, candidates: new Map() };
  record.at = now;
  record.candidates.set(candidate.url, { ...candidate, source: "response" });
  if (record.candidates.size > 64) record.candidates.delete(record.candidates.keys().next().value);
  observedAudioByTab.set(tab.id, record);
  if (observedAudioByTab.size > 64) observedAudioByTab.delete(observedAudioByTab.keys().next().value);
}
async function readAudioCollection(tabId, pageUrl) {
  const tab = Number.isInteger(tabId) ? await chrome.tabs.get(tabId).catch(() => null) : null;
  if (!tab || tab.url !== pageUrl || !LuckyRayExtensionProtocol.normalizeSourcePageUrl(pageUrl)) return { ok: false, code: "audio-source-changed" };
  const page = await contentReceiver.request(tabId, { type: "luckyray-get-audio-candidates" },
    { frameId: 0, requiredProtocolVersion: LuckyRayExtensionProtocol.CAPTURE_PROTOCOL_VERSION }).catch(() => null);
  const after = await chrome.tabs.get(tabId).catch(() => null);
  if (!page?.ok || page.pageUrl !== pageUrl || after?.url !== pageUrl) return { ok: false, code: "audio-source-changed" };
  const response = observedAudioByTab.get(tabId);
  const network = response?.pageUrl === pageUrl && Date.now() - response.at < 600000 ? [...response.candidates.values()] : [];
  return { ok: true, pageUrl, documentToken: page.documentToken,
    candidates: LuckyRayAudioCollection.merge([...page.candidates, ...network], pageUrl) };
}
chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.url || change.status === "loading") observedAudioByTab.delete(tabId); });
chrome.tabs.onRemoved.addListener(tabId => observedAudioByTab.delete(tabId));
if (chrome.webRequest && chrome.webRequest.onHeadersReceived) {
  chrome.webRequest.onHeadersReceived.addListener((details) => {
    const contentType = getResponseHeader(details.responseHeaders, "content-type");
    const size = getResponseHeader(details.responseHeaders, "content-length");
    void observeAudioResponse(details, contentType).catch(() => {});
    void observeSplitMediaTrack(details, contentType, size);
    const classified = classifyVideoCandidate(details.url, contentType);
    if (!classified) return;
    rememberVideoCandidate(details.tabId, {
      url: details.url,
      contentType,
      size,
      source: "network",
      frameId: details.frameId,
      documentId: details.documentId || null,
      ...classified,
    });
  }, {
    urls: ["http://*/*", "https://*/*"],
    types: ["media", "xmlhttprequest", "other"],
  }, ["responseHeaders"]);
}

// D45a-R1: 录制状态
const recordingState = {
  active: false,
  recordingId: "",
  // The Desktop binding the recording STARTED under; stop/save and failure
  // history dispatch under exactly this connection, never a re-selection.
  connection: null,
  tabId: null,
  pageUrl: "",
  sourcePageUrl: "",
  pageTitle: "",
  startedAt: 0,
  // offscreen 录制的 chunks 是 base64 字符串（offscreen 端 base64 编码后送回）
  // 关闭 / 保存时由 offscreen 给出最终 blob
};
let recordingStartPromise = null;
let recordingStopPromise = null;

function clearRecordingState() {
  recordingState.active = false;
  recordingState.recordingId = "";
  recordingState.connection = null;
  recordingState.tabId = null;
  recordingState.pageUrl = "";
  recordingState.sourcePageUrl = "";
  recordingState.pageTitle = "";
  recordingState.startedAt = 0;
}

function videoCandidateFamilyKey(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (!/^https?:$/.test(parsed.protocol)) return "";
    const segments = parsed.pathname.split("/");
    const file = segments.pop() || "";
    const stem = file
      .replace(/\.(?:cmfv|mp4|m4v|mov|webm|m3u8|ts)$/i, "")
      .replace(/(?:[-_.](?:\d{3,4})(?:w|p)|[-_.]\d{2,5}x\d{2,5})+$/i, "");
    if (!stem) return "";
    return `${parsed.origin.toLowerCase()}${segments.join("/").toLowerCase()}/${stem.toLowerCase()}`;
  } catch (_) {
    return "";
  }
}

// D45a-R1: Offscreen document 管理
const OFFSCREEN_DOC_PATH = "offscreen.html";
let creatingOffscreen = null;

async function ensureOffscreen() {
  // chrome offscreen 只允许一个
  const has = await settleAvailabilityWithin(chrome.offscreen.hasDocument?.(), 500);
  if (has) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = settleAvailabilityWithin(chrome.offscreen.createDocument({
    url: OFFSCREEN_DOC_PATH,
    reasons: ["USER_MEDIA"],
    justification: "Recording current tab via chrome.tabCapture and MediaRecorder",
  }), 1_000);
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function refreshRecordingState() {
  try {
    if (!await settleAvailabilityWithin(chrome.offscreen.hasDocument?.(), 500)) return false;
    const status = await sendOffscreenMessage(
      { type: "luckyray-offscreen-record-status" },
      500,
    );
    if (!status?.ok) {
      await closeOffscreenSafely();
      clearRecordingState();
      return false;
    }
    recordingState.active = Boolean(status?.ok && status.active);
    recordingState.recordingId = recordingState.active ? String(status.recordingId || "") : "";
    recordingState.tabId = recordingState.active && Number.isInteger(status.tabId) ? status.tabId : null;
    if (!recordingState.active) {
      recordingState.recordingId = "";
      recordingState.pageUrl = "";
      recordingState.sourcePageUrl = "";
      recordingState.pageTitle = "";
      recordingState.startedAt = 0;
    }
    return recordingState.active;
  } catch (_) {
    await closeOffscreenSafely();
    clearRecordingState();
    return false;
  }
}

async function closeOffscreenSafely() {
  try {
    await settleAvailabilityWithin(chrome.offscreen.closeDocument?.(), 500);
  } catch (_) {}
}

function sendOffscreenMessage(message, timeoutMs = 8_000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, code: "recording-timeout" });
    }, timeoutMs);
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response || { ok: false, code: "recording-unavailable" });
      });
    } catch (_) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: "recording-unavailable" });
    }
  });
}

function installContextMenu() {
  chrome.contextMenus.removeAll(() => {
    for (const item of LuckyRayExtensionProtocol.buildContextMenuSpecification()) {
      const { kind: _kind, ...properties } = item;
      chrome.contextMenus.create(properties);
    }
  });
}

function ensureVideoCandidateCache() {
  if (videoCandidateCacheReady) return videoCandidateCacheReady;
  videoCandidateCacheReady = (async () => {
    try {
      await settleAvailabilityWithin(
        chrome.storage.session?.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" }),
        VIDEO_CANDIDATE_CACHE_IO_TIMEOUT_MS,
      );
      const payload = await settleAvailabilityWithin(
        chrome.storage.session?.get?.(VIDEO_CANDIDATE_SESSION_KEY),
        VIDEO_CANDIDATE_CACHE_IO_TIMEOUT_MS,
      );
      const stored = payload?.[VIDEO_CANDIDATE_SESSION_KEY];
      const now = Date.now();
      for (const [tabKey, rawList] of Object.entries(stored && typeof stored === "object" ? stored : {})) {
        const tabId = Number(tabKey);
        if (!Number.isInteger(tabId) || tabId < 0 || !Array.isArray(rawList)) continue;
        const list = [];
        for (const item of rawList.slice(0, MEDIA_CANDIDATE_LIMIT)) {
          const classified = classifyVideoCandidate(item?.url, item?.contentType || "");
          const lastSeenAt = Number(item?.lastSeenAt);
          if (!classified || !Number.isFinite(lastSeenAt) || now - lastSeenAt > 20 * 60_000) continue;
          list.push({
            url: item.url,
            contentType: String(item.contentType || "").slice(0, 96),
            size: String(item.size || "").slice(0, 32),
            source: "network-session",
            frameId: Number.isInteger(item.frameId) ? item.frameId : -1,
            documentId: item.documentId || null,
            firstSeenAt: Number(item.firstSeenAt) || lastSeenAt,
            lastSeenAt,
            ...classified,
          });
        }
        if (list.length) mediaCandidatesByTab.set(tabId, list);
      }
    } catch (_) {
      // Session metadata is an availability optimization, never an authority.
    } finally {
      videoCandidateCacheHydrated = true;
    }
  })();
  return videoCandidateCacheReady;
}

async function persistVideoCandidateCache() {
  if (!chrome.storage.session?.set) return;
  if (!videoCandidateCacheHydrated) await ensureVideoCandidateCache();
  const snapshot = {};
  const entries = Array.from(mediaCandidatesByTab.entries())
    .sort((left, right) => (right[1][0]?.lastSeenAt || 0) - (left[1][0]?.lastSeenAt || 0))
    .slice(0, 20);
  for (const [tabId, list] of entries) {
    snapshot[String(tabId)] = list.slice(0, MEDIA_CANDIDATE_LIMIT).map((item) => ({
      url: item.url,
      contentType: item.contentType || "",
      size: item.size || "",
      width: Number(item.width) || 0,
      height: Number(item.height) || 0,
      bitrate: Number(item.bitrate) || 0,
      frameId: Number.isInteger(item.frameId) ? item.frameId : -1,
      documentId: item.documentId || null,
      firstSeenAt: item.firstSeenAt,
      lastSeenAt: item.lastSeenAt,
    }));
  }
  await settleAvailabilityWithin(
    chrome.storage.session.set({ [VIDEO_CANDIDATE_SESSION_KEY]: snapshot }),
    VIDEO_CANDIDATE_CACHE_IO_TIMEOUT_MS,
  );
}

void ensureVideoCandidateCache();

function mediaTransferBindingKey(sessionId, candidateId) {
  return `${sessionId}:${candidateId}`;
}

function isSafeBindingId(value, maxLength = 160) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    && /^[a-z0-9_-]+$/i.test(value);
}

function isActiveTransferState(state) {
  return !MEDIA_TRANSFER_TERMINAL_STATES.has(String(state || ""));
}

function ensureMediaTransferBindings() {
  if (mediaTransferBindingsReady) return mediaTransferBindingsReady;
  mediaTransferBindingsReady = (async () => {
    try {
      const payload = await chrome.storage.session?.get?.(MEDIA_TRANSFER_BINDING_SESSION_KEY);
      const stored = payload?.[MEDIA_TRANSFER_BINDING_SESSION_KEY];
      const now = Date.now();
      for (const item of Array.isArray(stored) ? stored.slice(0, MEDIA_TRANSFER_BINDING_LIMIT) : []) {
        const updatedAt = Number(item?.updatedAt);
        if (!isSafeBindingId(item?.sessionId, 128)
          || !isSafeBindingId(item?.candidateId, 64)
          || !/^media-[a-f0-9]+-[a-f0-9]{16}$/i.test(String(item?.transferId || ""))
          || !Number.isInteger(item?.tabId) || item.tabId < 0
          || !Number.isInteger(item?.frameId) || item.frameId < 0
          || (item?.documentId != null && !isSafeBindingId(item.documentId, 160))
          || !Number.isFinite(updatedAt) || now - updatedAt > MEDIA_TRANSFER_BINDING_TTL_MS) continue;
        const binding = {
          sessionId: item.sessionId,
          candidateId: item.candidateId,
          transferId: item.transferId,
          tabId: item.tabId,
          frameId: item.frameId,
          documentId: item.documentId || null,
          state: safeMediaTransferErrorCode(item.state, "running"),
          updatedAt,
          ...(bindingShape(item?.connection) ? { connection: item.connection } : {}),
        };
        mediaTransferBindings.set(mediaTransferBindingKey(binding.sessionId, binding.candidateId), binding);
      }
    } catch (_) {}
  })();
  return mediaTransferBindingsReady;
}

async function persistMediaTransferBindings() {
  if (!chrome.storage.session?.set) return;
  const snapshot = [...mediaTransferBindings.values()]
    .sort((left, right) => Number(isActiveTransferState(right.state)) - Number(isActiveTransferState(left.state))
      || right.updatedAt - left.updatedAt)
    .slice(0, MEDIA_TRANSFER_BINDING_LIMIT)
    .map((binding) => ({
      sessionId: binding.sessionId,
      candidateId: binding.candidateId,
      transferId: binding.transferId,
      tabId: binding.tabId,
      frameId: binding.frameId,
      documentId: binding.documentId,
      state: binding.state,
      updatedAt: binding.updatedAt,
      ...(binding.connection ? { connection: binding.connection } : {}),
    }));
  try {
    await chrome.storage.session.set({ [MEDIA_TRANSFER_BINDING_SESSION_KEY]: snapshot });
  } catch (_) {}
}

async function rememberMediaTransferBinding(session, candidateId, transfer, connection) {
  if (!isSafeBindingId(session?.sessionId, 128) || !isSafeBindingId(candidateId, 64)
    || !Number.isInteger(session?.tabId) || !Number.isInteger(session?.frameId)) return null;
  await ensureMediaTransferBindings();
  const binding = {
    sessionId: session.sessionId,
    candidateId,
    transferId: transfer.transferId,
    tabId: session.tabId,
    frameId: session.frameId,
    documentId: session.documentId || null,
    state: transfer.state,
    updatedAt: Date.now(),
    // The accepted transfer is bound to the Desktop that created it; later
    // status/cancel dispatch under exactly this connection.
    ...(bindingShape(connection) ? { connection } : {}),
  };
  mediaTransferBindings.set(mediaTransferBindingKey(binding.sessionId, binding.candidateId), binding);
  await persistMediaTransferBindings();
  return binding;
}

async function updateMediaTransferBinding(session, candidateId, transfer) {
  await ensureMediaTransferBindings();
  const binding = mediaTransferBindings.get(mediaTransferBindingKey(session.sessionId, candidateId));
  if (!binding || binding.transferId !== transfer.transferId) return;
  binding.state = transfer.state;
  binding.updatedAt = Date.now();
  await persistMediaTransferBindings();
}

async function restoreVideoSessionFromTransferBinding(sender, message) {
  await ensureMediaTransferBindings();
  const sessionId = String(message.sessionId || "");
  const candidateId = String(message.candidateId || "");
  const binding = mediaTransferBindings.get(mediaTransferBindingKey(sessionId, candidateId));
  const tabId = sender.tab?.id;
  const frameId = Number.isInteger(sender.frameId) ? sender.frameId : 0;
  const sameDocument = binding && (!binding.documentId || !sender.documentId || binding.documentId === sender.documentId);
  if (!binding || binding.tabId !== tabId || binding.frameId !== frameId || !sameDocument
    || Date.now() - binding.updatedAt > MEDIA_TRANSFER_BINDING_TTL_MS) return null;
  while (videoMenuSessions.size >= VIDEO_MENU_SESSION_LIMIT) {
    const oldestInactive = [...videoMenuSessions.entries()].find(([, stored]) => (
      ![...stored.transfers.values()].some((storedBinding) => isActiveTransferState(storedBinding.state))
    ))?.[0];
    if (!oldestInactive) return null;
    videoMenuSessions.delete(oldestInactive);
  }
  const session = {
    sessionId,
    tabId,
    frameId,
    documentId: binding.documentId,
    expiresAt: Date.now() + VIDEO_MENU_SESSION_TTL_MS,
    candidates: new Map(),
    transfers: new Map([[candidateId, binding]]),
    pageUrl: "",
    pageTitle: "",
    restoredFromBinding: true,
  };
  videoMenuSessions.set(sessionId, session);
  return session;
}

void ensureMediaTransferBindings();

function forgetVideoState(tabId) {
  mediaCandidatesByTab.delete(tabId);
  observedSplitTracksByTab.delete(tabId);
  for (const [sessionId, session] of videoMenuSessions) {
    if (session.tabId === tabId) videoMenuSessions.delete(sessionId);
  }
  recentCapturesByTab.delete(tabId);
  void persistVideoCandidateCache();
}

chrome.tabs.onRemoved?.addListener((tabId) => forgetVideoState(tabId));
chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || typeof changeInfo.url === "string") {
    forgetVideoState(tabId);
    void stopRecordingForTab(tabId);
  }
});

let contextMenuUpdate = Promise.resolve();
function applyContextMenuKind(contextKind) {
  const specification = LuckyRayExtensionProtocol.buildContextMenuSpecification();
  const kind = ["page", "selection", "link", "image", "video"].includes(contextKind) ? contextKind : "page";
  contextMenuUpdate = contextMenuUpdate.then(() => Promise.all(
    LuckyRayExtensionProtocol.contextMenuVisibility(specification, kind).map(({ id, visible }) => (
      new Promise((resolve) => {
        chrome.contextMenus.update(id, { visible }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      })
    )),
  )).catch(() => {});
  return contextMenuUpdate;
}

// D41c: 把右键"指定位置"意图存到 storage，popup 打开时读取
// payload: { type: "text"|"link"|"image"|"video", mode: "append"|"newNote"|"pickFolder"|"newFolder"|"insertCurrent" }
async function prefillContextLink(info, tab, mode) {
  let text = info.linkText || "", binding = null;
  try {
    const result = await contentReceiver.request(tab.id, { type: "luckyray-context-link-text", url: info.linkUrl },
      { frameId: Number.isInteger(info.frameId) ? info.frameId : 0, requiredProtocolVersion: LuckyRayExtensionProtocol.CAPTURE_PROTOCOL_VERSION });
    text ||= result?.text || "";
    if (result?.ok) binding = result;
  } catch (_) { /* An unverified document has no write authority. */ }
  const current = await chrome.tabs.get(tab.id);
  const context = current.url === tab.url ? LuckyRayCollectionInput.linkContext({ ...info, documentToken: binding?.documentToken, targetToken: binding?.targetToken }, tab, text) : null;
  if (!context) { await notify("此链接无法安全收集，请选择普通网页链接。"); return; }
  await setPrefill({ type: "link", mode, ...context });
}

async function setPrefill(payload) {
  if (!chrome.storage.session?.set) {
    notify("浏览器无法安全保存这次媒体选择，请直接打开插件重试。", true);
    return;
  }
  await chrome.storage.session.set({
    prefill: {
      ...payload,
      ts: Date.now(),
    },
  });
  // 尝试打开 popup（Chrome 118+/Edge 支持）
  try {
    if (chrome.action && typeof chrome.action.openPopup === "function") {
      await chrome.action.openPopup();
    } else {
      notify("请点工具栏的 LuckyRay 图标完成目标选择。");
    }
  } catch (e) {
    notify("请点工具栏的 LuckyRay 图标完成目标选择。");
  }
}

function installExtensionRuntime() {
  installContextMenu();
  void contentReceiver.installOpenTabs().catch(() => {});
}

chrome.runtime.onInstalled.addListener(installExtensionRuntime);
chrome.runtime.onStartup.addListener(installExtensionRuntime);
chrome.tabs.onActivated.addListener(() => { void applyContextMenuKind("page"); });

chrome.action.onClicked.addListener(async (tab) => {
  await collectPage(tab);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab) return;
  const id = info.menuItemId;

  // === 网页正文 ===
  if (id === "luckyray-page-append") {
    await setPrefill({ type: "text", mode: "append" });
  } else if (id === "luckyray-page-new") {
    await setPrefill({ type: "text", mode: "newNote" });
  }
  // === 选中文字 ===
  else if (id === "luckyray-selection-append") {
    await setPrefill({ type: "text", mode: "append" });
  } else if (id === "luckyray-selection-new") {
    await setPrefill({ type: "text", mode: "newNote" });
  }
  // === 链接 ===
  else if (id === "luckyray-link-append") {
    await prefillContextLink(info, tab, "append");
  } else if (id === "luckyray-link-new") {
    await prefillContextLink(info, tab, "newNote");
  }
  // === 图片 -root：直接调 import-media，无需弹窗 ===
  else if (id === "luckyray-image-root") {
    const candidate = LuckyRayExtensionProtocol.chooseContextMenuMedia({
      type: "image",
      infoUrl: info.srcUrl || "",
      descriptor: await getBestContextImage(tab),
    });
    if (candidate?.url) {
      await directMediaImport(tab, "image", candidate.url, {}, mediaActionId(tab, id), "context-menu", candidate);
    } else {
      notify("无法识别此图片 URL。");
    }
  }
  // === 图片 -pick / -new-folder：弹 popup ===
  else if (id === "luckyray-image-pick") {
    const candidate = LuckyRayExtensionProtocol.chooseContextMenuMedia({ type: "image", infoUrl: info.srcUrl || "", descriptor: await getBestContextImage(tab) });
    if (candidate?.url) await setPrefill({ type: "image", mode: "pickFolder", tabId: tab.id, mediaDescriptor: candidate });
    else notify("无法识别此图片 URL。");
  } else if (id === "luckyray-image-new-folder") {
    const candidate = LuckyRayExtensionProtocol.chooseContextMenuMedia({ type: "image", infoUrl: info.srcUrl || "", descriptor: await getBestContextImage(tab) });
    if (candidate?.url) await setPrefill({ type: "image", mode: "newFolder", tabId: tab.id, mediaDescriptor: candidate });
    else notify("无法识别此图片 URL。");
  }
  // === 视频 -root ===
  else if (id === "luckyray-video-root") {
    const candidate = LuckyRayExtensionProtocol.chooseContextMenuMedia({ type: "video", infoUrl: info.srcUrl || "", descriptor: await getBestContextVideo(tab, { resolvePlayable: true }) });
    if (candidate?.url) {
      // A browser srcUrl does not identify one card when multiple cards share
      // the same media URL. Preserve immediate save, but the tab URL is only
      // the capture page; the popup/chip path has target identity revalidation.
      await directVideoMediaTransfer(tab, candidate, {}, "context-menu");
    } else {
      notify("无法识别此视频 URL。");
    }
  }
  // === 视频 -pick / -new-folder ===
  // EXT-R1-REPAIR-3 contract C: a delayed popup write must be bound to the
  // CURRENT content-side descriptor even when the browser reports info.srcUrl.
  // srcUrl may only cross-check the bound descriptor's normalized URL; a
  // missing/mismatching bound descriptor means zero prefill (fail closed) —
  // an unbound browser-contextmenu URL can no longer become a delayed write.
  else if (id === "luckyray-video-pick") {
    const boundDescriptor = await getBestContextVideo(tab);
    const boundUrl = LuckyRayExtensionProtocol.mediaPrefillIdentity(boundDescriptor, "video")
      ? LuckyRayExtensionProtocol.normalizeVideoCandidateUrl(boundDescriptor.url) : "";
    const srcCrossCheckOk = !info.srcUrl || (boundUrl && LuckyRayExtensionProtocol.normalizeVideoCandidateUrl(info.srcUrl) === boundUrl);
    // The BOUND descriptor itself is the prefill (keep its full capture
    // identity: tab/frame/document/tokens/scroll/freshness).
    if (boundDescriptor?.url && boundUrl && srcCrossCheckOk) {
      await setPrefill({ type: "video", mode: "pickFolder", tabId: tab.id, mediaDescriptor: boundDescriptor });
    } else {
      notify("无法识别此视频的当前目标，请在页面上悬停视频后重试。");
    }
  } else if (id === "luckyray-video-new-folder") {
    const boundDescriptor = await getBestContextVideo(tab);
    const boundUrl = LuckyRayExtensionProtocol.mediaPrefillIdentity(boundDescriptor, "video")
      ? LuckyRayExtensionProtocol.normalizeVideoCandidateUrl(boundDescriptor.url) : "";
    const srcCrossCheckOk = !info.srcUrl || (boundUrl && LuckyRayExtensionProtocol.normalizeVideoCandidateUrl(info.srcUrl) === boundUrl);
    if (boundDescriptor?.url && boundUrl && srcCrossCheckOk) {
      await setPrefill({ type: "video", mode: "newFolder", tabId: tab.id, mediaDescriptor: boundDescriptor });
    } else {
      notify("无法识别此视频的当前目标，请在页面上悬停视频后重试。");
    }
  }
  // === 悬停图片/视频 -root ===
  else if (id === "luckyray-hover-image-root") {
    const candidate = await getBestContextImage(tab);
    if (candidate?.url) {
      await directMediaImport(tab, "image", candidate.url, {}, mediaActionId(tab, id), "hover", candidate);
    } else {
      notify("没有找到悬停图片。");
    }
  } else if (id === "luckyray-hover-image-pick") {
    const candidate = await getBestContextImage(tab);
    if (candidate?.url) await setPrefill({ type: "image", mode: "pickFolder", tabId: tab.id, mediaDescriptor: candidate });
    else notify("没有高置信度的悬停图片，请重新悬停后再试。");
  } else if (id === "luckyray-hover-video-root") {
    const v = await getBestContextVideo(tab, { preferPoint: true, allowNetworkFallback: false });
    if (v?.url) {
      await directVideoMediaTransfer(tab, v, {}, "hover");
    } else {
      notify("没有找到悬停视频。");
    }
  } else if (id === "luckyray-hover-video-pick") {
    const candidate = await getBestContextVideo(tab, { preferPoint: true, allowNetworkFallback: false });
    if (candidate?.url) await setPrefill({ type: "video", mode: "pickFolder", tabId: tab.id, mediaDescriptor: candidate });
    else notify("没有高置信度的悬停视频，请重新悬停后再试。");
  }
});

function mediaActionId(tab, menuId) {
  const type = String(menuId || "").includes("video") ? "video" : "image";
  const captured = recentCapture(tab?.id, type);
  const nonce = crypto && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return captured?.actionId || `${tab?.id || "tab"}:${menuId}:${nonce}`;
}

function rememberCapture(tabId, type, descriptor) {
  if (!descriptor) return;
  const current = recentCapturesByTab.get(tabId) || {};
  recentCapturesByTab.set(tabId, { ...current, [type]: descriptor });
}

function recentCapture(tabId, type) {
  const descriptor = recentCapturesByTab.get(tabId)?.[type] || null;
  if (!descriptor) return null;
  return LuckyRayExtensionProtocol.isCaptureDescriptorUsable(descriptor, {
    now: Date.now(),
    tabId,
    frameId: descriptor.frameId,
    documentId: descriptor.documentId,
    documentToken: descriptor.documentToken,
    scrollX: descriptor.scrollX,
    scrollY: descriptor.scrollY,
    targetToken: descriptor.targetToken,
  }) ? descriptor : null;
}

function supportedResolverPageUrl(value) {
  return LuckyRayExtensionProtocol.normalizeSupportedVideoPageUrl(value);
}

// D41c: 不弹 popup 直接调 import-media（用于 -root 入口）
async function directMediaImport(tab, mediaType, url, opts, actionId, captureSource, bound = null) {
  if (isRestrictedUrl(tab?.url)) {
    notify("这个浏览器页面不能收集。");
    return { ok: false, code: "restricted-page" };
  }
  if (isUnsupportedMediaUrl(mediaType, url)) {
    notify(mediaType === "video"
      ? "这个网页的视频是站内播放流，暂不支持直接下载。可以先保存网页链接，后面做下载器/解析器再接。"
      : "这个媒体地址不能直接下载。", true);
    return { ok: false, code: "media-format-unsupported" };
  }
  const input = {
    mediaType,
    kind: mediaType,
    url,
    ...(opts || {}),
    actionId,
    requestId: actionId,
    captureSource,
    storageMode: opts?.storageMode || "managed",
    mode: opts?.mode || (opts?.newFolderName ? "asset:newFolder" : opts?.targetFolderId ? "asset:pick" : "asset:root"),
  };
  const intent = LuckyRayExtensionProtocol.createMaterialImportIntent(input);
  if (!intent) {
    notify("无法识别此媒体 URL。", true);
    return { ok: false, code: "media-url-invalid" };
  }
  return await mediaActionGate.run(intent, async () => {
    // Freeze the verified connection for this submission: capability check,
    // library destination, prepare and the import all run under one binding.
    const frozen = await resolveMaterialConnection();
    if (!frozen.ok) return { ok: false, errorObject: { code: frozen.code } };
    const link = LuckyRayExtensionProtocol.normalizeBoundWorkPageUrl(bound?.linkUrl);
    const boundWork = bound?.sourcePageKind === "work-page"
      ? LuckyRayExtensionProtocol.normalizeBoundWorkPageUrl(bound?.sourcePageUrl) : "";
    const boundCapture = bound?.sourcePageKind === "capture-page"
      ? LuckyRayExtensionProtocol.normalizeSourcePageUrl(bound?.sourcePageUrl) : "";
    const page = boundWork || boundCapture || link
      || LuckyRayExtensionProtocol.normalizeSourcePageUrl(tab?.url);
    const kind = boundWork || (link && link !== url)
      ? "work-page" : "capture-page";
    const supported = page ? await supportsMaterialSourcePage(frozen.binding) : false;
    const request = supported && page
      ? { ...intent.request, sourcePageUrl: page, sourcePageKind: kind,
          ...(page === LuckyRayExtensionProtocol.normalizeSourcePageUrl(tab?.url)
            ? { sourcePageTitle: String(tab?.title || "").slice(0, 240) } : {}) }
      : intent.request;
    let preparedRequest = request;
    if (mediaType === "image") {
      const chosen = await imageDestination(opts?.libraryId, frozen.binding);
      if (!chosen.ok) return { ok: false, errorObject: { code: chosen.code } };
      const prepared = await prepareMediaTask({ kind: "image", request, fallbackName: tab?.title,
        destination: { libraryId: chosen.library.libraryId, folderId: opts?.targetFolderId, newFolderName: opts?.newFolderName } }, frozen.binding);
      if (!prepared.ok) return { ok: false, errorObject: { code: prepared.code } };
      preparedRequest = prepared.input.request;
    }
    const r = await callMediaImport(preparedRequest, frozen.binding);
    if (r.ok) {
      const name = r.asset?.name ? `：${r.asset.name}` : "";
      if (captureSource !== "drag") {
        notify(r.disposition === "duplicate"
          ? `素材已存在${name}`
          : `${mediaType === "video" ? "视频" : "图片"}已保存到素材库${name}；如当前未显示，请检查文件夹或筛选条件`);
        if (page && !supported) notify("当前桌面版不支持保存作品页链接；媒体仍已保存。");
      }
    } else {
      const formatted = LuckyRayExtensionProtocol.formatMaterialImportFailure(r.errorObject, mediaType);
      if (captureSource !== "drag") {
        if (formatted.handled) notify(formatted.message, r.errorObject?.code !== "request-outcome-unknown");
        else if (!notifyTransportFailure(r.errorObject)) notify(formatted.message, true);
      }
    }
    return { ...r, sourcePageUnsupported: Boolean(page && !supported) };
  });
}

async function createVideoMenuSession(tabId, frameId, documentId, message) {
  await ensureVideoCandidateCache();
  await refreshRecordingState();
  const descriptor = message?.descriptor && typeof message.descriptor === "object" ? message.descriptor : null;
  const now = Date.now();
  const hasTargetResolverBinding = Object.prototype.hasOwnProperty.call(
    message || {},
    "resolverPageUrl",
  );
  const resolverPage = supportedResolverPageUrl(message?.resolverPageUrl)
    || (!hasTargetResolverBinding ? supportedResolverPageUrl(message?.pageUrl) : "");
  const capturePage = LuckyRayExtensionProtocol.normalizeSourcePageUrl(message?.pageUrl);
  const workPage = LuckyRayExtensionProtocol.normalizeSourcePageUrl(message?.sourcePageUrl);
  const boundWorkPage = message?.sourcePageKind === "work-page"
    && supportedResolverPageUrl(workPage)
    && supportedResolverPageUrl(workPage) === resolverPage;
  const sourcePageUrl = boundWorkPage ? workPage : capturePage;
  const sourcePageKind = boundWorkPage ? "work-page" : "capture-page";
  const networkCandidates = [];
  for (const candidate of getVideoCandidatesForTab(tabId)) {
    const sameFrame = !Number.isInteger(candidate.frameId) || candidate.frameId < 0 || candidate.frameId === frameId;
    if (sameFrame && (!candidate.lastSeenAt || now - candidate.lastSeenAt <= 20 * 60_000)) networkCandidates.push(candidate);
  }
  const playerInputs = Array.from(message?.playerCandidates || []).slice(0, 16);
  const targetUrls = playerInputs.map((input) => input?.url).filter(Boolean);
  if (descriptor?.url) targetUrls.push(descriptor.url);
  const targetFamilies = new Set(targetUrls.map(videoCandidateFamilyKey).filter(Boolean));
  const hasTargetContext = targetUrls.length > 0 || message?.playerContext === true;
  let candidates = networkCandidates;
  if (hasTargetContext && targetFamilies.size > 0) {
    candidates = networkCandidates.filter((candidate) => {
      const family = videoCandidateFamilyKey(candidate.url);
      return targetUrls.includes(candidate.url) || (family && targetFamilies.has(family));
    });
  } else if (hasTargetContext) {
    // A blob URL proves that a player exists, but not which of the tab's
    // interleaved network requests belongs to it. Only exact player/MSE
    // evidence below may authorize candidates; otherwise offer recording.
    let resolverHost = "";
    try { resolverHost = new URL(resolverPage).hostname.toLowerCase(); } catch (_) {}
    const isYouTubePage = resolverHost === "youtube.com" || resolverHost.endsWith(".youtube.com");
    candidates = isYouTubePage
      ? networkCandidates.filter((candidate) => (
        candidate.binding === "site-track-pair"
        && candidate.source === "network-track-pair"
      ))
      : [];
  }
  for (const input of playerInputs) {
    const pairVideoUrl = safeDragCollectUrl(input?.url);
    const pairAudioUrl = safeDragCollectUrl(input?.audioUrl);
    const isTrackPair = input?.binding === "site-track-pair"
      && pairVideoUrl
      && pairAudioUrl
      && pairVideoUrl !== pairAudioUrl;
    const classified = isTrackPair
      ? { kind: "track_pair", direct: false, reason: "独立音视频轨" }
      : classifyVideoCandidate(input?.url, input?.contentType || "");
    if (!classified) continue;
    const networkEvidence = networkCandidates.find((candidate) => candidate.url === input.url);
    if (["mse-probe", "site-probe"].includes(input?.binding) && !networkEvidence) continue;
    const existing = candidates.find((candidate) => candidate.url === input.url) || networkEvidence;
    const safeMetadata = {
      width: Number(input?.width) || 0,
      height: Number(input?.height) || 0,
      bitrate: Number(input?.bitrate) || 0,
      source: existing ? "player+network" : "player",
    };
    if (existing) {
      Object.assign(existing, safeMetadata);
      if (!candidates.includes(existing)) candidates.push(existing);
    }
    else candidates.push({
      url: isTrackPair ? pairVideoUrl : input.url,
      ...(isTrackPair ? { audioUrl: pairAudioUrl, binding: "site-track-pair" } : {}),
      contentType: String(input?.contentType || "").slice(0, 96),
      ...safeMetadata,
      ...classified,
    });
  }
  if (descriptor?.url) {
    const existing = candidates.find((candidate) => candidate.url === descriptor.url);
    if (existing) {
      existing.source = "player+network";
      existing.width = message?.width;
      existing.height = message?.height;
    } else {
      const classified = classifyVideoCandidate(descriptor.url, "");
      if (classified) {
        candidates.unshift({
          url: descriptor.url,
          source: "player",
          width: message?.width,
          height: message?.height,
          ...classified,
        });
      }
    }
  }
  if (resolverPage && (descriptor || playerInputs.length > 0 || message?.playerContext === true)) {
    candidates.push({
      url: resolverPage,
      contentType: "application/x-luckyray-video-page",
      kind: "site_page",
      source: "site-resolver",
      width: Number(message?.width) || 0,
      height: Number(message?.height) || 0,
    });
  }
  const menu = LuckyRayExtensionProtocol.buildVideoActionMenu(candidates);
  const sessionId = crypto && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${now}-${Math.random().toString(36).slice(2)}`;
  const byId = new Map();
  const publicItems = menu.items.map((item) => {
    const candidate = candidates[item.sourceIndex];
    if (candidate) byId.set(item.candidateId, candidate);
    const { sourceIndex: _sourceIndex, ...safeItem } = item;
    return safeItem;
  });
  for (const [storedId, stored] of videoMenuSessions) {
    const hasActiveTransfer = [...(stored.transfers || new Map()).values()].some((binding) => isActiveTransferState(binding.state));
    if (stored.expiresAt <= now && !hasActiveTransfer) videoMenuSessions.delete(storedId);
  }
  while (videoMenuSessions.size >= VIDEO_MENU_SESSION_LIMIT) {
    const oldest = [...videoMenuSessions.entries()].find(([, stored]) => (
      ![...(stored.transfers || new Map()).values()].some((binding) => !MEDIA_TRANSFER_TERMINAL_STATES.has(binding.state))
    ))?.[0];
    if (!oldest) {
      return { ok: false, code: "video-session-capacity", message: "当前已有较多视频任务，请稍后再试。" };
    }
    videoMenuSessions.delete(oldest);
  }
  videoMenuSessions.set(sessionId, {
    sessionId,
    tabId,
    frameId,
    documentId: documentId || null,
    expiresAt: now + VIDEO_MENU_SESSION_TTL_MS,
    candidates: byId,
    transfers: new Map(),
    pageUrl: String(message?.pageUrl || ""),
    pageTitle: String(message?.pageTitle || "").slice(0, 240),
    sourcePageUrl,
    sourcePageKind,
  });
  return {
    ok: true,
    sessionId,
    items: publicItems,
    canRecord: message?.drmProtected === true ? false : menu.canRecord || publicItems.length === 0,
    recording: recordingState.active && recordingState.tabId === tabId,
  };
}

function safeMediaTransferErrorCode(value, fallback = "media-transfer-failed") {
  const code = String(value || "");
  return new Set([
    "app-unavailable",
    "host-unavailable",
    "bootstrap-rejected",
    "verification-unavailable",
    "connection-selection-stale",
    "multiple-instances",
    "binding-connection-lost",
    "binding-identity-mismatch",
    "binding-service-restarted",
    "binding-restart-mismatch",
    "request-outcome-unknown",
    "media-transfer-binding-missing",
    "media-capacity",
    "media-cancel-too-late",
    "media-input-invalid",
    "media-transfer-not-found",
    "media-probe-expired",
    "media-probe-invalid",
    "media-cancelled",
    "media-deadline-exceeded",
    "media-duration-limit",
    "media-encoding-unsupported",
    "media-http-unavailable",
    "media-invalid-response",
    "media-authentication-required",
    "media-site-blocked",
    "media-region-restricted",
    "media-drm-protected",
    "media-no-formats",
    "media-needs-recording",
    "media-resolver-unavailable",
    "media-resolver-unsupported",
    "media-resolver-failed",
    "media-hls-unsupported",
    "media-hls-live-unsupported",
    "media-format-unsupported",
    "media-container-invalid",
    "media-network-failed",
    "media-segment-limit",
    "media-size-limit",
    "media-source-invalid",
    "media-staging-unavailable",
    "media-staging-write-failed",
    "media-download-failed",
    "media-transfer-invalid",
    "media-transfer-failed",
    "media-transfer-timeout",
    "queued",
    "running",
    "importing",
    "cancelling",
    "completed",
    "cancelled",
    "failed",
  ]).has(code) ? code : fallback;
}

function safeMediaTransferMessage(code) {
  return {
    "app-unavailable": "请先打开 LuckyRay 桌面端。",
    "host-unavailable": "LuckyRay 本地服务暂时不可用。",
    "connection-selection-stale": "已选的 LuckyRay 连接已不可用，请打开插件重新选择。",
    "multiple-instances": "检测到多个 LuckyRay，请先在插件中选择一个。",
    "binding-connection-lost": "已选的 LuckyRay 连接中断，请稍后重试。",
    "binding-identity-mismatch": "该端口的 LuckyRay 身份已变化，请重新选择连接。",
    "binding-service-restarted": "LuckyRay 已重启，请先核对原任务再继续。",
    "binding-restart-mismatch": "LuckyRay 在确认前再次重启，正在重新核对原任务。",
    "request-outcome-unknown": "保存已发出，但结果暂时无法确认；请先在素材库核对，不要重复保存。",
    "media-transfer-binding-missing": "该任务的桌面连接记录已过期，请重新发起保存。",
    "media-capacity": "当前已有较多视频正在入库，请稍后再试。",
    "media-cancel-too-late": "视频已经写入素材库，无法再取消。",
    "media-input-invalid": "该视频候选无法安全入库。",
    "media-transfer-not-found": "视频入库任务已失效，请重新开始。",
    "media-probe-expired": "清晰度选择已过期，请重新解析。",
    "media-cancelled": "视频入库已取消。",
    "media-deadline-exceeded": "视频解析或下载超时。",
    "media-duration-limit": "视频时长超过当前入库上限。",
    "media-encoding-unsupported": "视频源使用了暂不支持的传输编码。",
    "media-http-unavailable": "视频源拒绝当前下载请求；请刷新站点登录状态后重试。",
    "media-invalid-response": "视频源返回了无效响应。",
    "media-authentication-required": "当前视频需要站点登录授权；请确认已登录并允许 LuckyRay 访问该站点。",
    "media-site-blocked": "视频网站拒绝了当前解析请求；请刷新页面或稍后重试。",
    "media-region-restricted": "该视频受地区限制，当前无法入库。",
    "media-drm-protected": "该视频受 DRM 保护，LuckyRay 不会绕过保护。",
    "media-no-formats": "站点没有提供可下载的视频格式；该内容可能已下架、受限或需要 PO Token。",
    "media-needs-recording": "该视频需要录制后才能入库。",
    "media-resolver-unavailable": "视频解析组件当前不可用；可以稍后重试或使用录制。",
    "media-resolver-unsupported": "当前站点尚未加入视频解析支持；可以使用录制。",
    "media-resolver-failed": "没有解析到可下载的公开媒体；登录、地区限制或 DRM 内容可能不可用。",
    "media-hls-unsupported": "该播放流需要高级解析组件。",
    "media-hls-live-unsupported": "直播流暂不支持直接入库。",
    "media-format-unsupported": "该视频需要录制后才能入库。",
    "media-container-invalid": "下载内容不是受支持的视频文件。",
    "media-download-failed": "视频下载失败，请稍后重试。",
    "media-network-failed": "视频源连接失败，请稍后重试，或改用浏览器下载/录制。",
    "media-segment-limit": "视频分片数量超过当前入库上限。",
    "media-size-limit": "视频文件超过当前入库大小上限。",
    "media-source-invalid": "视频来源信息未通过安全校验。",
    "media-staging-unavailable": "LuckyRay 暂时无法创建视频暂存文件。",
    "media-staging-write-failed": "视频暂存写入失败，请检查磁盘空间后重试。",
    "bootstrap-rejected": "LuckyRay 连接已刷新，正在重新连接。",
    "verification-unavailable": "LuckyRay 本地服务正在重新验证。",
  }[code] || "视频入库失败，请稍后重试。";
}

function siteSpecificMediaTransferFailure(candidate, code) {
  if (code !== "media-resolver-failed") return null;
  try {
    const host = new URL(String(candidate?.url || "")).hostname.toLowerCase();
    if (host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com")) {
      return {
        ok: false,
        code: "media-youtube-token-required",
        message: "YouTube 当前要求站点会话与 PO Token；已授权后仍失败的视频暂不可直接入库。",
      };
    }
  } catch (_) {}
  return null;
}

async function requestMediaTransfer(method, path, body, connection) {
  const attempts = method === "GET" ? 2 : 1;
  let lastFailure = "host-unavailable";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      // Direct media transfers carry a persistent identity too: the same
      // explicit, verified binding as every other entry point, never a
      // numeric port and never a re-scan that could reach another Desktop.
      const resolved = connection ? { ok: true, binding: connection } : await resolveMaterialConnection();
      if (!resolved.ok) {
        lastFailure = resolved.code;
        break;
      }
      const options = {
        method,
        headers: { "Content-Type": "application/json", "X-LuckyRay-Source": "luckyray-plugin" },
      };
      if (body !== undefined) options.body = JSON.stringify(body);
      const response = await LuckyRayLocalTransport.fetch(resolved.binding, path, options);
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const value = LuckyRayExtensionProtocol.unwrapTransportEnvelope(payload);
        const code = safeMediaTransferErrorCode(value?.code);
        return { ok: false, code, message: safeMediaTransferMessage(code) };
      }
      const transfer = LuckyRayExtensionProtocol.parseMediaTransferSnapshot(payload);
      return transfer.ok
        ? { ok: true, transfer }
        : { ok: false, code: transfer.code, message: safeMediaTransferMessage(transfer.code) };
    } catch (error) {
      lastFailure = safeMediaTransferErrorCode(error?.code, "host-unavailable");
      if (attempt + 1 < attempts) continue;
    }
  }
  return { ok: false, code: lastFailure, message: safeMediaTransferMessage(lastFailure) };
}

function parseMediaProbeSnapshot(payload) {
  return LuckyRayExtensionProtocol.parseMediaProbeSnapshot(payload);
}

async function requestMediaProbe(body, connection) {
  try {
    const resolved = connection ? { ok: true, binding: connection } : await resolveMaterialConnection();
    if (!resolved.ok) {
      const code = safeMediaTransferErrorCode(resolved.code, "app-unavailable");
      return { ok: false, code, message: safeMediaTransferMessage(code) };
    }
    const response = await LuckyRayLocalTransport.fetch(resolved.binding, "/api/media/probes", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-LuckyRay-Source": "luckyray-plugin" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const value = LuckyRayExtensionProtocol.unwrapTransportEnvelope(payload);
      const code = safeMediaTransferErrorCode(value?.code);
      return { ok: false, code, message: safeMediaTransferMessage(code) };
    }
    const parsed = parseMediaProbeSnapshot(payload);
    return parsed.ok
      ? parsed
      : { ok: false, code: parsed.code, message: "视频清晰度目录无效，请重试。" };
  } catch (error) {
    const code = safeMediaTransferErrorCode(error?.code, "host-unavailable");
    return { ok: false, code, message: safeMediaTransferMessage(code) };
  }
}

async function expandResolvedFormats(session, candidate, connection) {
  if (!["site_page", "site-resolver"].includes(candidate?.kind)) {
    return { ok: false, code: "video-candidate-invalid", message: "该候选不能解析清晰度。" };
  }
  const sourcePageUrl = String(candidate.url || "");
  const authorization = await requestSiteAuthorization(candidate, { prompt: true, optional: true });
  if (!authorization.ok) {
    return { ok: false, code: "site-auth-required", message: "当前站点会话不可用。" };
  }
  const userAgent = safeBrowserUserAgent();
  const siteAuth = {
    ...(authorization.siteAuth || { cookies: [] }),
    ...(userAgent ? { userAgent } : {}),
    referer: sourcePageUrl,
  };
  const result = await requestMediaProbe({
    url: sourcePageUrl,
    sourcePageUrl,
    siteAuth,
  }, connection);
  if (!result.ok) return result;
  const items = [];
  for (const format of result.formats) {
    const candidateId = `format-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
    session.candidates.set(candidateId, {
      kind: "resolved_format",
      url: sourcePageUrl,
      sourcePageUrl,
      probeId: result.probeId,
      formatId: format.formatId,
      extension: format.extension,
      contentType: `video/${format.extension === "mkv" ? "x-matroska" : format.extension}`,
      siteAuth,
    });
    items.push({
      candidateId,
      host: new URL(sourcePageUrl).hostname.toLowerCase(),
      kind: "resolved-format",
      format: format.extension.toUpperCase(),
      width: format.width,
      height: format.height,
      bitrate: format.bitrate,
      sizeBytes: format.estimatedBytes,
      label: format.label,
      canDownload: false,
      canSaveToMaterials: true,
    });
  }
  return {
    ok: true,
    sessionId: session.sessionId,
    items,
    canRecord: false,
    recording: false,
  };
}

function safeVideoTransferFileName(session, candidate) {
  const suggested = LuckyRayExtensionProtocol.videoTransferFileName(
    session?.pageTitle || "LuckyRay video",
    candidate?.url,
    candidate?.extension,
  );
  const dot = suggested.lastIndexOf(".");
  const suffix = suggested.slice(dot);
  let base = suggested.slice(0, dot).replace(/\u007f/g, " ").trim();
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = `LuckyRay ${base}`;
  // Page titles are automatic names; preserve the extension within the host's UTF-8 limit.
  while (LuckyRayMediaImport.utf8Length(`${base}${suffix}`) > 240) base = Array.from(base).slice(0, -1).join("");
  return `${base || "LuckyRay video"}${suffix}`;
}

function safeVideoTransferMime(candidate) {
  const value = String(candidate?.contentType || "").split(";")[0].trim().toLowerCase();
  if (/^(video\/[a-z0-9.+-]{1,64}|application\/(vnd\.apple\.mpegurl|x-mpegurl))$/.test(value)) return value;
  if (candidate?.kind === "hls") return "application/vnd.apple.mpegurl";
  if (["mpd", "dash"].includes(candidate?.kind)) return "application/dash+xml";
  return undefined;
}

function siteAuthorizationDescriptor(candidate) {
  if (!["site_page", "site-resolver"].includes(candidate?.kind)) return null;
  return LuckyRayExtensionProtocol.sitePermissionDescriptor(candidate.url);
}

function projectSiteCookies(rawCookies, allowedDomains) {
  const result = [];
  const seen = new Set();
  let totalBytes = 0;
  for (const raw of Array.from(rawCookies || [])) {
    if (result.length >= 128) break;
    const name = String(raw?.name || "");
    const value = String(raw?.value || "");
    const domain = String(raw?.domain || "").toLowerCase();
    const normalizedDomain = domain.replace(/^\.+/, "").replace(/\.+$/, "");
    const path = String(raw?.path || "/");
    const allowed = allowedDomains.some((suffix) => (
      normalizedDomain === suffix || normalizedDomain.endsWith(`.${suffix}`)
    ));
    const unsafe = [name, value, domain, path].some((entry) => /[\u0000-\u001f\u007f]/.test(entry));
    const bytes = name.length + value.length + domain.length + path.length;
    const key = `${name}\u0000${domain}\u0000${path}`;
    if (!allowed || unsafe || !name || name.length > 256 || value.length > 4096
      || domain.length > 253 || !path.startsWith("/") || path.length > 1024
      || seen.has(key) || totalBytes + bytes > 64 * 1024) continue;
    seen.add(key);
    totalBytes += bytes;
    result.push({
      name,
      value,
      domain,
      path,
      expires: Number.isSafeInteger(raw?.expirationDate) && raw.expirationDate > 0
        ? Math.trunc(raw.expirationDate)
        : 0,
      secure: raw?.secure === true,
      httpOnly: raw?.httpOnly === true,
    });
  }
  return result;
}

function safeBrowserUserAgent() {
  const value = String(globalThis.navigator?.userAgent || "");
  return value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : "";
}

async function requestSiteAuthorization(candidate, options = {}) {
  const descriptor = siteAuthorizationDescriptor(candidate);
  if (!descriptor) return { ok: true, siteAuth: null };
  const prompt = options.prompt !== false;
  if (!chrome.cookies?.getAll || (prompt && !chrome.permissions?.request)
    || (!prompt && !chrome.permissions?.contains)) {
    return options.optional === true
      ? { ok: true, siteAuth: { cookies: [] } }
      : { ok: false, code: "site-auth-required" };
  }
  const details = { permissions: ["cookies"], origins: descriptor.origins };
  const granted = prompt
    ? await chrome.permissions.request(details).catch(() => false)
    : await chrome.permissions.contains(details).catch(() => false);
  if (!granted) {
    return options.optional === true
      ? { ok: true, siteAuth: { cookies: [] } }
      : { ok: false, code: "site-auth-required" };
  }
  const cookieGroups = [];
  for (const domain of descriptor.domains) {
    cookieGroups.push(await chrome.cookies.getAll({ domain }).catch(() => []));
  }
  const cookies = projectSiteCookies(cookieGroups.flat(), descriptor.domains);
  return { ok: true, siteAuth: { cookies } };
}

async function startVideoMediaTransfer(session, candidate, candidateId, targetFolderId, newFolderName, libraryId = "", connection) {
  if (!["direct_video", "direct-video", "http_video", "http-video", "hls", "mpd", "dash", "track_pair", "site_page", "site-resolver", "resolved_format"].includes(candidate?.kind)) {
    return { ok: false, code: "media-format-unsupported", message: safeMediaTransferMessage("media-format-unsupported") };
  }
  const existing = session.transfers.get(candidateId);
  if (existing && !MEDIA_TRANSFER_TERMINAL_STATES.has(existing.state)) {
    return await readVideoMediaTransfer(session, candidateId);
  }
  const body = {
    url: candidate.url,
    fileName: safeVideoTransferFileName(session, candidate),
    requestId: `video:${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`,
  };
  if (candidate.kind === "resolved_format") {
    body.probeId = String(candidate.probeId || "");
    body.formatId = String(candidate.formatId || "");
  }
  if (candidate.kind === "track_pair") {
    const audioUrl = safeDragCollectUrl(candidate.audioUrl);
    if (!audioUrl || audioUrl === candidate.url) {
      return { ok: false, code: "media-input-invalid", message: safeMediaTransferMessage("media-input-invalid") };
    }
    body.audioUrl = audioUrl;
  }
  const mimeType = safeVideoTransferMime(candidate);
  if (mimeType) body.mimeType = mimeType;
  const exactResolverPage = ["site_page", "site-resolver", "resolved_format"].includes(candidate.kind)
    ? String(candidate.url || "")
    : "";
  const sourcePageUrl = exactResolverPage || String(session.pageUrl || "");
  if (/^https?:\/\//i.test(sourcePageUrl) && sourcePageUrl.length <= 2048) body.sourcePageUrl = sourcePageUrl;
  const materialPage = LuckyRayExtensionProtocol.normalizeSourcePageUrl(session.sourcePageUrl || session.pageUrl);
  const provenanceSupported = materialPage ? await supportsMaterialSourcePage(connection) : false;
  if (provenanceSupported && materialPage) {
    body.materialSourcePageUrl = materialPage;
    body.sourcePageKind = session.sourcePageKind || "capture-page";
  }
  const authorizationCandidate = siteAuthorizationDescriptor(candidate)
    ? candidate
    : { kind: "site_page", url: sourcePageUrl };
  const authorization = candidate.kind === "resolved_format" && candidate.siteAuth
    ? { ok: true, siteAuth: candidate.siteAuth }
    : await requestSiteAuthorization(authorizationCandidate, { prompt: false, optional: true });
  if (!authorization.ok) {
    return {
      ok: false,
      code: "site-auth-required",
      message: "当前站点会话不可用；公开媒体仍可直接入库，需要登录的内容可稍后授权重试。",
    };
  }
  if (authorization.siteAuth) {
    const userAgent = safeBrowserUserAgent();
    body.siteAuth = {
      ...authorization.siteAuth,
      ...(userAgent ? { userAgent } : {}),
      referer: sourcePageUrl,
    };
  }
  if (targetFolderId) body.targetFolderId = String(targetFolderId).slice(0, 160);
  if (newFolderName) body.newFolderName = String(newFolderName).slice(0, 160);
  const chosen = await imageDestination(libraryId, connection);
  if (!chosen.ok) return { ok: false, code: chosen.code, message: LuckyRayMediaImport.message(chosen.code) };
  const destination = { libraryId: chosen.library.libraryId, folderId: targetFolderId, newFolderName };
  const admitted = await validateMediaDestination(destination, null, connection);
  if (!admitted.ok) return { ok: false, code: admitted.code, message: LuckyRayMediaImport.message(admitted.code) };
  body.libraryId = destination.libraryId;
  const validated = LuckyRayMediaImport.validateRequest("video", body);
  if (!validated.ok) return { ok: false, code: validated.code, message: LuckyRayMediaImport.message(validated.code) };
  const result = await requestMediaTransfer("POST", "/api/media/transfers", body, connection);
  if (!result.ok) {
    const siteFailure = siteSpecificMediaTransferFailure(candidate, result.code);
    if (siteFailure) return siteFailure;
  }
  if (result.ok) {
    const binding = {
      transferId: result.transfer.transferId,
      state: result.transfer.state,
    };
    session.transfers.set(candidateId, bindingShape(connection) ? { ...binding, connection } : binding);
    await rememberMediaTransferBinding(session, candidateId, result.transfer, connection);
  }
  return { ...result, sourcePageUnsupported: Boolean(materialPage && !provenanceSupported) };
}

async function readVideoMediaTransfer(session, candidateId) {
  const binding = session.transfers.get(candidateId);
  if (!binding) return { ok: false, code: "media-transfer-not-found", message: safeMediaTransferMessage("media-transfer-not-found") };
  // A transfer recorded before instance bindings has no attributable
  // Desktop: fail closed instead of asking whichever instance is selected.
  if (!bindingShape(binding.connection)) return { ok: false, code: "media-transfer-binding-missing", message: safeMediaTransferMessage("media-transfer-binding-missing") };
  const result = await requestMediaTransfer("GET", `/api/media/transfers/${binding.transferId}`, undefined, binding.connection);
  if (result.ok) {
    binding.state = result.transfer.state;
    await updateMediaTransferBinding(session, candidateId, result.transfer);
  }
  return result;
}

async function cancelVideoMediaTransfer(session, candidateId) {
  const binding = session.transfers.get(candidateId);
  if (!binding) return { ok: false, code: "media-transfer-not-found", message: safeMediaTransferMessage("media-transfer-not-found") };
  if (!bindingShape(binding.connection)) return { ok: false, code: "media-transfer-binding-missing", message: safeMediaTransferMessage("media-transfer-binding-missing") };
  const result = await requestMediaTransfer("POST", `/api/media/transfers/${binding.transferId}/cancel`, undefined, binding.connection);
  if (result.ok) {
    binding.state = result.transfer.state;
    await updateMediaTransferBinding(session, candidateId, result.transfer);
  }
  return result;
}

async function directVideoMediaTransfer(tab, descriptor, options = {}, captureSource = "context-menu") {
  const identity = JSON.stringify([tab?.id, tab?.url, descriptor?.url, descriptor?.audioUrl, descriptor?.contentType, descriptor?.probeId, descriptor?.formatId, options, captureSource]);
  return await directVideoActionGate.run(identity, () => startDirectVideoMediaTransfer(tab, descriptor, options, captureSource));
}

async function startDirectVideoMediaTransfer(tab, descriptor, options, captureSource) {
  if (isRestrictedUrl(tab?.url)) {
    notify("这个浏览器页面不能收集。", true);
    return { ok: false, code: "restricted-page" };
  }
  const classified = classifyVideoCandidate(descriptor?.url, descriptor?.contentType || "");
  if (!classified || !["direct_video", "http_video", "hls", "mpd"].includes(classified.kind)) {
    notify("该视频需要录制后才能入库。", true);
    return { ok: false, code: "media-format-unsupported" };
  }
  const boundPage = LuckyRayExtensionProtocol.normalizeSourcePageUrl(options?.sourcePageUrl);
  const boundWork = options?.sourcePageKind === "work-page"
    && supportedResolverPageUrl(boundPage);
  const session = {
    pageTitle: String(tab?.title || "LuckyRay video").slice(0, 240),
    pageUrl: String(tab?.url || ""),
    sourcePageUrl: boundWork ? boundPage : LuckyRayExtensionProtocol.normalizeSourcePageUrl(tab?.url),
    sourcePageKind: boundWork ? "work-page" : "capture-page",
    transfers: new Map(),
  };
  const candidateId = "context-video";
  // Freeze the verified connection for this whole direct-media submission.
  const frozen = await resolveMaterialConnection();
  if (!frozen.ok) {
    const code = safeMediaTransferErrorCode(frozen.code, "app-unavailable");
    return { ok: false, code, message: safeMediaTransferMessage(code) };
  }
  const result = await startVideoMediaTransfer(
    session,
    { ...descriptor, ...classified },
    candidateId,
    options.targetFolderId,
    options.newFolderName,
    options.libraryId,
    frozen.binding,
  );
  if (result.ok && captureSource !== "drag") {
    notify("视频已开始下载并入库，可在 LuckyRay 素材库中查看进度结果。");
    if (result.sourcePageUnsupported) notify("当前桌面版不支持保存作品页链接；视频仍会入库。");
  }
  else if (!result.ok) notify(result.message || "视频入库失败，请稍后重试。", true);
  return result;
}

function safeDragCollectUrl(value) {
  const raw = String(value || "");
  if (!raw || raw.length > 4_096 || /[\u0000-\u001f\u007f]/.test(raw)) return "";
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return "";
    return parsed.href;
  } catch (_) {
    return "";
  }
}

function safeDragFolderId(value) {
  const id = String(value || "");
  return id && id.length <= 160 && !/[\u0000-\u001f\u007f]/.test(id) ? id : "";
}

function safeDragFolderName(value) {
  const name = String(value || "").trim();
  return name && name.length <= 160 && !/[\u0000-\u001f\u007f]/.test(name) ? name : "";
}

async function listDragFolders() {
  try {
    const chosen = await imageDestination();
    if (!chosen.ok) return chosen;
    const library = chosen.library;
    if (library.capabilities.organize !== true) return { ok: true, libraryId: library.libraryId, libraryName: library.name, folders: [] };
    const requestId = `drag:taxonomy:${crypto.randomUUID()}`;
    const result = await requestCaptureApi("POST", "/api/material-libraries/taxonomy", { libraryId: library.libraryId, requestId });
    if (!result.ok || result.data?.consumerVersion !== 1 || result.data.libraryId !== library.libraryId || result.data.requestId !== requestId
      || !Array.isArray(result.data.folders)) return { ok: false, code: "media-library-denied" };
    const folders = result.data.folders.slice(0, 128).flatMap(folder => {
      const id = safeDragFolderId(folder?.id), name = safeDragFolderName(folder?.name);
      return id && name ? [{ id, name, parentId: safeDragFolderId(folder.parentId) || null }] : [];
    });
    return { ok: true, libraryId: library.libraryId, libraryName: library.name, folders };
  } catch (_) { return { ok: false, code: "media-library-unavailable" }; }
}

async function collectDraggedMedia(sender, message) {
  const tab = sender?.tab;
  if (!tab || !Number.isInteger(tab.id) || isRestrictedUrl(tab.url)) {
    return { ok: false, code: "restricted-page", message: "这个浏览器页面不能收集。" };
  }
  if (chrome.tabs?.get) {
    const currentTab = await chrome.tabs.get(tab.id).catch(() => null);
    if (!currentTab || currentTab.url !== tab.url) {
      return { ok: false, code: "capture-target-changed", message: "页面已变化，请重新拖动目标。" };
    }
  }
  if (message?.capturePageUrl && message.capturePageUrl !== tab.url) {
    return { ok: false, code: "capture-target-changed", message: "页面已变化，请重新拖动目标。" };
  }
  const mediaType = message?.mediaType === "video" ? "video" : message?.mediaType === "image" ? "image" : "";
  if (message?.target === "pick-folder") {
    return { ok: false, code: "media-input-invalid", message: "请重新加载 LuckyRay 插件后直接选择素材文件夹。" };
  }
  const url = safeDragCollectUrl(message?.url);
  const resolveVideo = mediaType === "video" && message?.resolveVideo === true;
  const targetFolderId = safeDragFolderId(message?.targetFolderId);
  const newFolderName = safeDragFolderName(message?.newFolderName);
  if ((message?.targetFolderId && !targetFolderId) || (message?.newFolderName && !newFolderName)
    || (targetFolderId && newFolderName)) {
    return { ok: false, code: "media-input-invalid", message: "素材文件夹选择无效。" };
  }
  if (!mediaType || (!url && !resolveVideo)) {
    return { ok: false, code: "media-input-invalid", message: "无法识别拖动的媒体。" };
  }
  if (!LuckyRayMediaImport.validId(message?.libraryId)) {
    return { ok: false, code: "media-target-required", message: "保存位置尚未就绪，请重新拖动图片。" };
  }
  const clientActionId = /^[a-z0-9:._-]{1,200}$/i.test(String(message?.actionId || ""))
    ? String(message.actionId)
    : `drag:${crypto.randomUUID?.() || Date.now()}`;
  const actionId = `drag:${tab.id}:${Number.isInteger(sender.frameId) ? sender.frameId : 0}:${clientActionId}`;
  if (resolveVideo) {
    // Freeze before the async menu/probe work, in the common scope shared by
    // direct, adaptive, resolved-format and exact-card fallback candidates.
    const dragFrozen = await resolveMaterialConnection();
    if (!dragFrozen.ok) {
      const code = safeMediaTransferErrorCode(dragFrozen.code, "app-unavailable");
      return { ok: false, code, message: safeMediaTransferMessage(code) };
    }
    const opened = await createVideoMenuSession(
      tab.id,
      Number.isInteger(sender.frameId) ? sender.frameId : 0,
      sender.documentId || null,
      {
        playerCandidates: Array.from(message?.playerCandidates || []).slice(0, 16),
        width: Number(message?.width) || 0,
        height: Number(message?.height) || 0,
        pageUrl: String(tab.url || ""),
        sourcePageUrl: message?.sourcePageUrl,
        sourcePageKind: message?.sourcePageKind,
        resolverPageUrl: safeDragCollectUrl(message?.resolverPageUrl),
        pageTitle: String(tab.title || ""),
        playerContext: true,
      },
    );
    // A drag remains bound to the exact visible card. Pinterest's zero-sized
    // HLS entry is its adaptive master playlist; the transfer service can
    // select the highest variant from it, while a fixed CMFV is only one low
    // rendition. Keep that exact CMFV as the fallback when no master exists.
    const fallbackSelected = opened?.items?.find((item) => (
      item.canSaveToMaterials && item.kind !== "site-resolver"
    ));
    const session = opened?.sessionId ? videoMenuSessions.get(opened.sessionId) : null;
    const resolverItem = opened?.items?.find((item) => item.kind === "site-resolver");
    const resolverCandidate = resolverItem && session?.candidates.get(resolverItem.candidateId);
    let resolverHost = "";
    try { resolverHost = new URL(String(resolverCandidate?.url || "")).hostname.toLowerCase(); } catch (_) {}
    let tabHost = "";
    try { tabHost = new URL(String(tab.url || "")).hostname.toLowerCase(); } catch (_) {}
    const isPinterestContext = resolverHost === "pinterest.com" || resolverHost.endsWith(".pinterest.com")
      || tabHost === "pinterest.com" || tabHost.endsWith(".pinterest.com");
    const pinterestAdaptiveSelected = isPinterestContext && session
      ? opened?.items?.find((item) => {
          return item.canSaveToMaterials && item.kind === "hls"
            && !Number(item.width || 0) && !Number(item.height || 0)
            && session.candidates.has(item.candidateId);
        })
      : null;
    const exactSelected = pinterestAdaptiveSelected || fallbackSelected;
    let selected = exactSelected || opened?.items?.find((item) => item.canSaveToMaterials);
    let candidate = selected && session?.candidates.get(selected.candidateId);
    if (!pinterestAdaptiveSelected && exactSelected && candidate && session && resolverCandidate && isPinterestContext) {
      // Preserve the exact card stream as the non-negotiable fallback. A
      // successful detail-page probe may upgrade it, but a failed/empty probe
      // cannot erase or replace the already-bound card candidate.
      const resolved = await expandResolvedFormats(session, resolverCandidate, dragFrozen.binding);
      const upgraded = resolved?.ok
        ? resolved.items?.find((item) => item.kind === "resolved-format" && item.canSaveToMaterials)
        : null;
      const upgradedCandidate = upgraded && session.candidates.get(upgraded.candidateId);
      if (upgraded && upgradedCandidate) {
        selected = upgraded;
        candidate = upgradedCandidate;
      }
    }
    if (!selected || !session || !candidate) {
      return { ok: false, code: "media-format-unsupported", message: "该视频需要使用播放器按钮或录制功能。" };
    }
    return await mediaActionGate.run(`video:${actionId}`, async () => (
      await startVideoMediaTransfer(session, candidate, selected.candidateId, targetFolderId, newFolderName, message.libraryId, dragFrozen.binding)
    ));
  }
  if (mediaType === "video") {
    const result = await mediaActionGate.run(`video:${actionId}`, async () => await directVideoMediaTransfer(tab, {
        url,
        contentType: String(message?.contentType || "").slice(0, 96),
      }, { targetFolderId, newFolderName, libraryId: message.libraryId,
        sourcePageUrl: message?.sourcePageUrl, sourcePageKind: message?.sourcePageKind }, "drag"));
    return result?.ok
      ? { ok: true, transfer: result.transfer, sourcePageUnsupported: result.sourcePageUnsupported }
      : {
        ok: false,
        code: safeMediaTransferErrorCode(result?.code),
        message: result?.message || safeMediaTransferMessage(result?.code),
      };
  }
  const result = await directMediaImport(
    tab, "image", url, { targetFolderId, newFolderName, libraryId: message.libraryId }, actionId, "drag",
    { sourcePageUrl: message?.sourcePageUrl, sourcePageKind: message?.sourcePageKind },
  );
  if (!result?.ok) {
    const value = LuckyRayExtensionProtocol.unwrapTransportEnvelope(result?.errorObject);
    const code = /^[a-z0-9_-]{1,64}$/i.test(String(value?.code || ""))
      ? String(value.code)
      : "media-transfer-failed";
    return { ok: false, code, message: LuckyRayMediaImport.message(code) };
  }
  return {
    ok: true,
    sourcePageUnsupported: result.sourcePageUnsupported,
    disposition: result.disposition,
    asset: result.asset ? {
      id: String(result.asset.id || "").slice(0, 160),
      name: String(result.asset.name || "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 180),
      kind: String(result.asset.kind || "image").slice(0, 32),
    } : null,
  };
}

async function runVideoMenuAction(sender, message) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) return { ok: false, code: "video-session-invalid", message: "视频操作会话无效。" };
  let session = videoMenuSessions.get(String(message.sessionId || ""));
  if (!session) session = await restoreVideoSessionFromTransferBinding(sender, message);
  const sameFrame = session && session.frameId === (Number.isInteger(sender.frameId) ? sender.frameId : 0);
  const sameDocument = !session?.documentId || !sender.documentId || session.documentId === sender.documentId;
  const hasActiveTransfer = session && [...session.transfers.values()].some((binding) => isActiveTransferState(binding.state));
  if (!session || session.tabId !== tabId || !sameFrame || !sameDocument
    || (session.expiresAt <= Date.now() && !hasActiveTransfer)) {
    if (session?.expiresAt <= Date.now() && !hasActiveTransfer) videoMenuSessions.delete(session.sessionId);
    return { ok: false, code: "video-session-expired", message: "视频候选已过期，请重新点击视频按钮。" };
  }
  session.expiresAt = Date.now() + VIDEO_MENU_SESSION_TTL_MS;
  const action = String(message.action || "");
  if (session.pageUrl && ["save-materials", "probe-formats"].includes(action)
    && sender.tab?.url !== session.pageUrl) {
    return { ok: false, code: "capture-target-changed", message: "页面已变化，请重新选择视频。" };
  }
  if (action === "record-start") {
    return await startRecording(tabId, { pageUrl: session.pageUrl, pageTitle: session.pageTitle });
  }
  if (action === "record-stop") return await stopRecordingAndSave();
  const candidateId = String(message.candidateId || "");
  if (action === "media-transfer-status") return await readVideoMediaTransfer(session, candidateId);
  if (action === "media-transfer-cancel") return await cancelVideoMediaTransfer(session, candidateId);
  if (action === "save-materials" && session.restoredFromBinding && session.transfers.has(candidateId)) {
    return await readVideoMediaTransfer(session, candidateId);
  }
  const candidate = session.candidates.get(candidateId);
  if (!candidate) return { ok: false, code: "video-candidate-invalid", message: "视频候选无效。" };
  if (action === "probe-formats" || action === "save-materials") {
    // Probe and save freeze one verified connection for the whole chain;
    // status/cancel above keep using each transfer's recorded binding.
    const frozen = await resolveMaterialConnection();
    if (!frozen.ok) {
      const code = safeMediaTransferErrorCode(frozen.code, "app-unavailable");
      return { ok: false, code, message: safeMediaTransferMessage(code) };
    }
    if (action === "probe-formats") return await expandResolvedFormats(session, candidate, frozen.binding);
    return await startVideoMediaTransfer(session, candidate, candidateId, undefined, undefined, "", frozen.binding);
  }
  return { ok: false, code: "video-action-invalid", message: "不支持的视频操作。" };
}

async function callMediaImport(body, connection) {
  let submitted = false;
  try {
    const resolved = connection ? { ok: true, binding: connection } : await resolveMaterialConnection();
    if (!resolved.ok) return { ok: false, error: safeMediaTransferMessage(resolved.code), errorObject: { code: resolved.code } };
    submitted = true;
    let result = await requestCaptureApi("POST", "/api/assets/import-media", body, resolved.binding);
    if (!result.ok && body.libraryId && result.notDispatched !== true
      && result.errorObject?.code === "capture-commit-uncertain") {
      // Reconcile this one original action; never repeat the import or scan
      // for another Desktop. A lost response is not a failed catalog write.
      const expected = LuckyRayMediaImport.identity("image", body), meta = {};
      const checked = await requestCaptureApi("POST", "/api/material-libraries/media-receipt", expected, resolved.binding, meta);
      const found = checked.ok && LuckyRayMediaImport.lookup(checked.data, expected);
      if (found?.ok && found.state === "completed") {
        await LuckyRayLocalTransport.confirmBinding(resolved.binding, meta.serverNonce);
        result = { ok: true, data: found.receipt };
      }
    }
    if (!result.ok) {
      const code = result.errorObject?.code;
      return { ...result, errorObject: code === "capture-commit-uncertain"
        ? { code: "request-outcome-unknown" } : result.errorObject };
    }
    const payload = result.data;
    const canonical = body.libraryId
      ? LuckyRayMediaImport.receipt(LuckyRayExtensionProtocol.unwrapTransportEnvelope(payload), LuckyRayMediaImport.identity("image", body))
      : LuckyRayExtensionProtocol.parseMaterialImportResponse(payload);
    return canonical.ok ? canonical : { ok: false, error: canonical.code };
  } catch (e) {
    return { ok: false, notDispatched: !submitted, errorObject: {
      code: submitted ? "request-outcome-unknown" : e?.code || "app-unavailable" } };
  }
}

async function getBestContextVideo(tab, opts = {}) {
  const allowNetworkFallback = opts.allowNetworkFallback === true;
  if (!tab?.id || isRestrictedUrl(tab.url)) return null;
  const recent = recentCapture(tab.id, "video");
  try {
    const response = await contentReceiver.request(
      tab.id,
      { type: "luckyray-get-hover-video", resolvePlayable: opts.resolvePlayable === true },
      recent ? { frameId: recent.frameId ?? 0, documentId: recent.documentId || undefined } : { frameId: 0 },
    );
    if (response?.url) {
      const classified = classifyVideoCandidate(response.url, "");
      if (classified) {
        rememberVideoCandidate(tab.id, {
          url: response.url,
          contentType: "",
          size: "",
          source: "hover",
          ...classified,
        });
      }
      return LuckyRayExtensionProtocol.createCaptureDescriptor({
        ...response,
        tabId: tab.id,
        frameId: recent?.frameId ?? 0,
        documentId: recent?.documentId || null,
      });
    }
  } catch (_) {}
  if (allowNetworkFallback) {
    const directCandidate = getVideoCandidatesForTab(tab.id).find((item) => item.direct);
    if (directCandidate) return { type: "video", url: directCandidate.url, confidence: "explicit-network-candidate", importable: true };
  }
  return null;
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "luckyray-context-kind") {
    if (!sender.tab?.id || message.captureProtocolVersion !== LuckyRayExtensionProtocol.CAPTURE_PROTOCOL_VERSION) return;
    void applyContextMenuKind(message.contextKind);
    return;
  }
  if (message.type === "luckyray-context-image") {
    if (!sender.tab?.id || !message.descriptor?.url) return;
    rememberCapture(sender.tab.id, "image", LuckyRayExtensionProtocol.createCaptureDescriptor({
      ...message.descriptor,
      tabId: sender.tab.id,
      frameId: sender.frameId ?? 0,
      documentId: sender.documentId || null,
    }));
    return;
  }
  // D41c: 视频 hover 同步
  if (message.type === "luckyray-context-video") {
    if (!sender.tab?.id || !message.descriptor?.url) return;
    rememberCapture(sender.tab.id, "video", LuckyRayExtensionProtocol.createCaptureDescriptor({
      ...message.descriptor,
      tabId: sender.tab.id,
      frameId: sender.frameId ?? 0,
      documentId: sender.documentId || null,
    }));
    return;
  }
  if (message.type === "luckyray-site-track-pair") {
    const pair = message.pair;
    const pageUrl = supportedResolverPageUrl(pair?.pageUrl);
    const senderPage = supportedResolverPageUrl(sender.tab?.url);
    const videoUrl = safeDragCollectUrl(pair?.url);
    const audioUrl = safeDragCollectUrl(pair?.audioUrl);
    if (!sender.tab?.id || !pageUrl || pageUrl !== senderPage || !videoUrl || !audioUrl || videoUrl === audioUrl) return;
    rememberVideoCandidate(sender.tab.id, {
      url: videoUrl,
      audioUrl,
      binding: "site-track-pair",
      contentType: String(pair?.contentType || "video/mp4").slice(0, 96),
      kind: "track_pair",
      direct: false,
      reason: "独立音视频轨",
      width: Number(pair?.width) || 0,
      height: Number(pair?.height) || 0,
      bitrate: Number(pair?.bitrate) || 0,
      source: "site-track-pair",
      frameId: sender.frameId ?? 0,
      documentId: sender.documentId || null,
    });
    return;
  }
});

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

// D41: popup 通信通道
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return;
  if (["luckyray-popup-images", "luckyray-image-batch"].includes(message.type)) {
    if (_sender.id !== chrome.runtime.id || _sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL("popup.html")) {
      sendResponse({ ok: false, code: "capture-task-forbidden" }); return;
    }
    const operations = { start: async () => {
      const frozen = await resolveMaterialConnection();
      if (!frozen.ok) return { ok: false, code: frozen.code,
        ...(frozen.candidates ? { candidates: frozen.candidates } : {}),
        ...(frozen.stale ? { stale: frozen.stale } : {}) };
      return await imageBatch.start({ ...message.input, connection: frozen.binding });
    }, status: () => imageBatch.status(), stop: () => imageBatch.stop(message.id),
      retry: () => imageBatch.retry(message.id), resume: () => imageBatch.resume(message.id), acknowledge: () => imageBatch.acknowledge(message.id, message.confirmed === true) };
    const operation = message.type === "luckyray-popup-images" ? () => readImageCollection(message.tabId, message.pageUrl, message.rescan === true) : operations[message.action];
    if (!operation) { sendResponse({ ok: false, code: "batch-input-invalid" }); return; }
    operation().then(sendResponse).catch(() => sendResponse({ ok: false, code: "batch-unavailable" })); return true;
  }
  if (message.type === "luckyray-source-page-capability") {
    if (_sender.id !== chrome.runtime.id
      || _sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL("popup.html")) {
      sendResponse({ supported: false });
      return;
    }
    supportsMaterialSourcePage().then((supported) => sendResponse({ supported }));
    return true;
  }
  if (message.type === "luckyray-media-destination") {
    if (_sender.id !== chrome.runtime.id || _sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL("popup.html")) { sendResponse({ ok: false, code: "capture-task-forbidden" }); return; }
    const operation = message.action === "libraries" ? mediaLibraries : message.action === "taxonomy" ? async () => {
      const libraries = await mediaLibraries();
      if (!libraries.ok || !libraries.supported) return { ok: false, code: libraries.code || "media-library-unavailable" };
      const library = libraries.data.libraries.find(value => value.libraryId === message.libraryId && value.visible === true && value.state === "ready" && value.capabilities?.organize === true);
      if (!library) return { ok: false, code: "media-organize-denied" };
      const requestId = `popup:taxonomy:${crypto.randomUUID()}`;
      const result = await requestCaptureApi("POST", "/api/material-libraries/taxonomy", { libraryId: library.libraryId, requestId });
      return result.ok && result.data?.consumerVersion === 1 && result.data.libraryId === library.libraryId && result.data.requestId === requestId ? result : { ok: false, code: "media-library-denied" };
    } : null;
    if (!operation) { sendResponse({ ok: false, code: "media-input-invalid" }); return; }
    operation().then(sendResponse).catch(() => sendResponse({ ok: false, code: "media-library-unavailable" })); return true;
  }
  if (message.type === "luckyray-context-link-verify") {
    if (_sender.id !== chrome.runtime.id || _sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL("popup.html")) { sendResponse({ ok: false }); return; }
    (async () => {
      const context = message.context, tab = await chrome.tabs.get(context?.tabId);
      if (!LuckyRayCollectionInput.currentLink(context, tab, tab.url)) return { ok: false };
      const result = await contentReceiver.request(tab.id, { type: "luckyray-context-link-verify", url: context.linkUrl, documentToken: context.documentToken, targetToken: context.targetToken },
        { frameId: context.frameId, requiredProtocolVersion: LuckyRayExtensionProtocol.CAPTURE_PROTOCOL_VERSION });
      const current = await chrome.tabs.get(tab.id);
      return result?.ok && current.url === context.pageUrl && result.documentToken === context.documentToken ? { ok: true, documentToken: result.documentToken } : { ok: false };
    })().then(sendResponse).catch(() => sendResponse({ ok: false })); return true;
  }
  if (message.type === "luckyray-capture-task") {
    // A web content script cannot submit an arbitrary frozen note binding.
    if (_sender.id !== chrome.runtime.id
      || _sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL("popup.html")) {
      sendResponse({ ok: false, code: "capture-task-forbidden" });
      return;
    }
    const operations = {
      start: async () => {
        if (await imageBatch.blocks()) return { ok: false, code: "capture-task-pending" };
        // Freeze the verified connection at the submission entry: library
        // validation, organize targets and the accepted task all run under
        // this one binding; a selection change mid-flight can never retarget
        // the submission to another Desktop.
        const frozen = await resolveMaterialConnection();
        if (!frozen.ok) return { ok: false, code: frozen.code,
          ...(frozen.candidates ? { candidates: frozen.candidates } : {}),
          ...(frozen.stale ? { stale: frozen.stale } : {}) };
        const prepared = await prepareMediaTask(message.input, frozen.binding);
        return prepared.ok ? captureTask.start({ ...prepared.input, connection: frozen.binding }) : prepared;
      },
      status: () => captureTask.status(),
      resume: () => captureTask.resume(message.id),
      cancel: () => captureTask.cancel(message.id),
      acknowledge: () => captureTask.acknowledge(message.id),
    };
    const operation = operations[message.action];
    if (!operation) { sendResponse({ ok: false, code: "capture-task-invalid" }); return; }
    operation().then(sendResponse).catch(() => sendResponse({ ok: false, code: "capture-task-storage-unavailable" }));
    return true;
  }
  if (message.type === "luckyray-popup-get-audio-candidates") {
    if (_sender.id !== chrome.runtime.id || _sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL("popup.html")) {
      sendResponse({ ok: false, code: "audio-forbidden" }); return;
    }
    readAudioCollection(message.tabId, message.pageUrl).then(sendResponse)
      .catch(() => sendResponse({ ok: false, code: "audio-source-changed" }));
    return true;
  }
  if (message.type === "luckyray-site-auth-request") {
    const exactPage = supportedResolverPageUrl(message.url);
    if (!exactPage) {
      sendResponse({ ok: false, code: "media-input-invalid" });
      return;
    }
    requestSiteAuthorization(
      { url: exactPage, kind: "site_page" },
      { prompt: message.prompt === true, optional: true },
    )
      .then((authorization) => {
        if (!authorization.ok) {
          sendResponse({ ok: false, code: "site-auth-required" });
          return;
        }
        if (!authorization.siteAuth) {
          sendResponse({ ok: true, siteAuth: null });
          return;
        }
        const userAgent = safeBrowserUserAgent();
        sendResponse({
          ok: true,
          siteAuth: {
            ...authorization.siteAuth,
            ...(userAgent ? { userAgent } : {}),
            referer: exactPage,
          },
        });
      })
      .catch(() => sendResponse({ ok: false, code: "site-auth-unavailable" }));
    return true;
  }
  if (message.type === "luckyray-video-overlay-open") {
    (async () => {
      const tabId = _sender.tab?.id;
      if (_sender.tab?.url !== message.pageUrl) {
        sendResponse({ ok: false, code: "capture-target-changed" });
        return;
      }
      const currentTab = Number.isInteger(tabId) && chrome.tabs?.get
        ? await chrome.tabs.get(tabId).catch(() => null) : null;
      if (!currentTab || currentTab.url !== message.pageUrl) {
        sendResponse({ ok: false, code: "capture-target-changed" });
        return;
      }
      sendResponse(Number.isInteger(tabId)
        ? await createVideoMenuSession(
          tabId,
          Number.isInteger(_sender.frameId) ? _sender.frameId : 0,
          _sender.documentId || null,
          message,
        )
        : { ok: false, code: "video-session-invalid" });
    })().catch(() => sendResponse({ ok: false, code: "video-session-invalid" }));
    return true;
  }
  if (message.type === "luckyray-video-overlay-action") {
    runVideoMenuAction(_sender, message)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, code: "video-action-failed", message: "视频操作失败。" }));
    return true;
  }
  if (message.type === "luckyray-drag-folders") {
    listDragFolders()
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, code: "host-unavailable", message: "暂时无法读取素材文件夹。" }));
    return true;
  }
  if (message.type === "luckyray-drag-collect") {
    collectDraggedMedia(_sender, message)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, code: "media-transfer-failed", message: "媒体保存失败，请稍后重试。" }));
    return true;
  }
  if (message.type === "luckyray-popup-get-port") {
    (async () => {
      try {
        const resolved = await resolveMaterialConnection();
        if (!resolved.ok) {
          sendResponse({
            port: null,
            code: resolved.code,
            ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
            ...(resolved.stale ? { stale: resolved.stale } : {}),
          });
          return;
        }
        sendResponse({ port: resolved.binding.port, code: null,
          fingerprint: resolved.binding.fingerprint, origin: resolved.binding.origin,
          serverNonce: resolved.binding.serverNonce });
      } catch (error) {
        sendResponse({
          port: null,
          code: error && error.code ? error.code : "host-unavailable",
          diagnostic: error && error.diagnostic ? error.diagnostic : null,
        });
      }
    })();
    return true;
  }
  if (message.type === "luckyray-popup-select-connection") {
    if (_sender.id !== chrome.runtime.id || _sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL("popup.html")) {
      sendResponse({ ok: false, code: "connection-select-forbidden" });
      return true;
    }
    (async () => {
      try {
        // The pick carries the COMPLETE descriptor the user saw. Every field
        // is re-verified against the current candidates, so a port that was
        // re-occupied by a different identity after display can never be
        // selected by port number alone.
        const pick = message.candidate;
        if (!pick || pick.version !== 1 || !Number.isInteger(pick.port) || pick.port < 1 || pick.port > 65535
          || pick.origin !== LuckyRayLocalTransport.runtimeOrigin()
          || !/^[a-f0-9]{64}$/.test(String(pick.fingerprint || ""))
          || !/^[a-f0-9]{64}$/.test(String(pick.serverNonce || ""))) {
          sendResponse({ ok: false, code: "connection-select-invalid" });
          return;
        }
        const candidates = await LuckyRayLocalTransport.discoverCandidates();
        const current = candidates.find(candidate => candidate.port === pick.port
          && candidate.fingerprint === pick.fingerprint && candidate.origin === pick.origin
          && candidate.serverNonce === pick.serverNonce);
        if (!current) {
          sendResponse({ ok: false, code: "connection-select-stale", candidates });
          return;
        }
        const binding = await LuckyRayLocalTransport.openBinding(pick.port);
        if (binding.fingerprint !== pick.fingerprint || binding.origin !== pick.origin
          || binding.serverNonce !== pick.serverNonce) {
          sendResponse({ ok: false, code: "connection-select-stale", candidates });
          return;
        }
        await persistConnectionBinding(binding);
        sendResponse({ ok: true, port: binding.port, fingerprint: binding.fingerprint,
          origin: binding.origin, serverNonce: binding.serverNonce });
      } catch (error) {
        sendResponse({ ok: false, code: (error && error.code) || "host-unavailable" });
      }
    })();
    return true;
  }
  if (message.type === "luckyray-popup-get-page") {
    (async () => {
      let tabId = message.tabId;
      if (!tabId) {
        const active = await getActiveTab();
        tabId = active && active.id;
      }
      if (!tabId) {
        sendResponse({ title: "", url: "", selection: "", imageUrl: "", videoUrl: "" });
        return;
      }
      try {
        const info = await getPageInfo(tabId);
        const hoverImg = recentCapture(tabId, "image")?.url || "";
        const hoverVid = recentCapture(tabId, "video")?.url || "";
        sendResponse(LuckyRayExtensionProtocol.buildPopupPagePayload(info, {
          imageUrl: hoverImg,
          videoUrl: hoverVid,
        }));
      } catch (e) {
        sendResponse({ title: "", url: "", selection: "", imageUrl: "", videoUrl: "" });
      }
    })();
    return true;
  }
  if (message.type === "luckyray-popup-get-media") {
    (async () => {
      let tabId = message.tabId;
      if (!tabId) {
        const active = await getActiveTab();
        tabId = active && active.id;
      }
      if (!tabId) {
        sendResponse({});
        return;
      }
      try {
        const tab = await chrome.tabs.get(tabId);
        if (message.mediaType === "video") {
          const video = await getBestContextVideo(tab);
          const current = await chrome.tabs.get(tabId);
          sendResponse(current.url === tab.url ? { ...LuckyRayExtensionProtocol.toPopupMediaPayload("video", video), pageUrl: current.url } : {});
          return;
        }
        const image = await getBestContextImage(tab);
        const current = await chrome.tabs.get(tabId);
        sendResponse(current.url === tab.url ? { ...LuckyRayExtensionProtocol.toPopupMediaPayload("image", image), pageUrl: current.url } : {});
      } catch (_) {
        sendResponse({});
      }
    })();
    return true;
  }
  // D41c: popup 拉当前活动笔记
  if (message.type === "luckyray-popup-get-video-candidates") {
    (async () => {
      let tabId = message.tabId;
      if (!tabId) {
        const active = await getActiveTab();
        tabId = active && active.id;
      }
      if (!tabId) {
        sendResponse({ candidates: [] });
        return;
      }
      try {
        const tab = await chrome.tabs.get(tabId);
        await getBestContextVideo(tab);
        sendResponse({ candidates: getPopupVideoCandidates(tab) });
      } catch (_) {
        sendResponse({ candidates: getVideoCandidatesForTab(tabId) });
      }
    })();
    return true;
  }
  if (message.type === "luckyray-popup-get-current-note") {
    (async () => {
      try {
        // Note context reads ride the same verified binding as note attach;
        // they never discover or fail over on their own.
        const resolved = await resolveMaterialConnection();
        if (!resolved.ok) { sendResponse({ noteId: null, hasCursor: false }); return; }
        const r = await LuckyRayLocalTransport.fetch(resolved.binding, "/api/notes/current", { method: "GET" });
        if (!r.ok) { sendResponse({ noteId: null, hasCursor: false }); return; }
        const data = LuckyRayExtensionProtocol.unwrapTransportEnvelope(await r.json());
        sendResponse({
          noteId: data && data.noteId ? data.noteId : null,
          hasCursor: data && typeof data.cursorOffset === "number",
          cursorOffset: data ? data.cursorOffset : null,
        });
      } catch (_) {
        sendResponse({ noteId: null, hasCursor: false });
      }
    })();
    return true;
  }
  // D45a-R1: 录制启动
  if (message.type === "luckyray-record-start") {
    (async () => {
      try {
        const result = await startRecording(message.tabId, {
          pageUrl: message.pageUrl || "",
          pageTitle: message.pageTitle || "",
        });
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, code: "recording-unavailable", message: safeRecordingPublicMessage("recording-unavailable") });
      }
    })();
    return true;
  }
  // D45a-R1: 录制停止并入库
  if (message.type === "luckyray-record-stop") {
    (async () => {
      try {
        const result = await stopRecordingAndSave();
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, code: "recording-save-failed", message: safeRecordingPublicMessage("recording-save-failed") });
      }
    })();
    return true;
  }
  if (message.type === "luckyray-record-status") {
    (async () => {
      await refreshRecordingState();
      sendResponse({
        ok: true,
        active: recordingState.active,
        tabId: recordingState.active ? recordingState.tabId : null,
        elapsedSec: recordingState.active && recordingState.startedAt > 0
          ? Math.max(0, Math.floor((Date.now() - recordingState.startedAt) / 1000))
          : 0,
      });
    })().catch(() => sendResponse({ ok: true, active: false, tabId: null, elapsedSec: 0 }));
    return true;
  }
  // D45a-R1: 录制失败回调（offscreen → background）
  if (message.type === "luckyray-record-fail") {
    (async () => {
      if (message.recordingId && recordingState.recordingId && message.recordingId !== recordingState.recordingId) {
        sendResponse({ ok: true });
        return;
      }
      const recordingConnection = bindingShape(recordingState.connection) ? { ...recordingState.connection } : null;
      try {
        await stopRecordingNoSave();
      } catch (_) {}
      const code = String(message.code || "recording-failed");
      await recordFailureToHistory(code, recordingConnection);
      notify(safeRecordingPublicMessage(code));
      sendResponse({ ok: true });
    })();
    return true;
  }
});

async function supportsMaterialSourcePage(connection) {
  try {
    // Capability reads ride the same explicit, verified binding as the rest
    // of the funnel; they never auto-discover to another Desktop.
    const resolved = connection ? { ok: true, binding: connection } : await resolveMaterialConnection();
    if (!resolved.ok) return false;
    const response = await LuckyRayLocalTransport.fetch(resolved.binding, "/api/v1/capabilities", {
      method: "GET",
      headers: { "X-LuckyRay-Source": SOURCE_HEADER },
    });
    if (!response.ok) return false;
    const payload = LuckyRayExtensionProtocol.unwrapTransportEnvelope(await response.json());
    return payload?.namespaces?.materials?.sourcePage?.available === true
      && payload.namespaces.materials.sourcePage.version >= 1;
  } catch (_) { return false; }
}

function notifyTransportFailure(error) {
  const code = error && error.code;
  if (code === "app-unavailable") {
    notify("请打开 LuckyRay 后重试。", true);
    return true;
  }
  if (code === "host-unavailable") {
    notify("LuckyRay 浏览器连接组件暂时无响应，请重新加载插件后重试。", true);
    return true;
  }
  if (code === "host-not-installed" || code === "host-forbidden") {
    notify("LuckyRay 浏览器连接组件未安装或未授权，请修复桌面端安装。", true);
    return true;
  }
  if (code === "protocol-incompatible") {
    notify("LuckyRay 桌面端与浏览器插件版本不兼容，请更新后重试。", true);
    return true;
  }
  if (code === "verification-unavailable" || code === "bootstrap-rejected") {
    notify("无法验证 LuckyRay 本地服务，请重启桌面端后重试。", true);
    return true;
  }
  return false;
}

async function collectPage(tab) {
  if (isRestrictedUrl(tab?.url)) {
    notify("这个浏览器页面不能收集。");
    return;
  }

  try {
    const info = await getPageInfo(tab.id);
    const content = LuckyRayExtensionProtocol.formatPageCaptureText(info);
    await directCollect({
      type: "text",
      title: info.title,
      url: info.sourceUrl || info.url,
      selection: content,
      thumbnail: info.imageUrl || "",
      capturedAt: new Date().toISOString(),
      source: "luckyray-plugin",
      sourceDetail: { browser: detectBrowser(), trigger: "action", contentKind: info.contentKind },
    }, "网页已发送到 LuckyRay。");
  } catch (error) {
    if (notifyTransportFailure(error)) return;
    console.error("[luckyray-plugin] collectPage failed:", error);
    await fallbackToClipboard(tab, "");
  }
}

async function collectSelection(tab, selectionText) {
  if (isRestrictedUrl(tab?.url)) {
    notify("这个浏览器页面不能收集。");
    return;
  }

  try {
    const info = await getPageInfo(tab.id);
    const selected = LuckyRayExtensionProtocol.createPageSnapshot({
      ...info,
      selection: selectionText || info.selection || "",
    });
    const selection = LuckyRayExtensionProtocol.formatPageCaptureText(selected || info);
    await directCollect({
      type: "text",
      title: info.title,
      url: info.sourceUrl || info.url,
      selection,
      capturedAt: new Date().toISOString(),
      source: "luckyray-plugin",
      sourceDetail: { browser: detectBrowser(), trigger: "contextMenu.selection" },
    }, "选中文字已发送到 LuckyRay。");
  } catch (error) {
    if (notifyTransportFailure(error)) return;
    console.error("[luckyray-plugin] collectSelection failed:", error);
    await fallbackToClipboard(tab, selectionText);
  }
}

async function collectLink(linkUrl, linkText) {
  try {
    await directCollect({
      type: "link",
      title: linkText || linkUrl,
      url: linkUrl,
      selection: "",
      capturedAt: new Date().toISOString(),
      source: "luckyray-plugin",
      sourceDetail: { browser: detectBrowser(), trigger: "contextMenu.link" },
    }, "链接已发送到 LuckyRay。");
  } catch (error) {
    if (notifyTransportFailure(error)) return;
    console.error("[luckyray-plugin] collectLink failed:", error);
    await copyToClipboard(buildMarkdown(linkText || linkUrl, linkUrl, ""));
    notify("LuckyRay 未连接，链接已复制到剪贴板。");
  }
}

async function collectImage(imageUrl, trigger = "contextMenu.image") {
  const title = imageUrl.split("/").pop() || "image";
  try {
    await directCollect({
      type: "image",
      title,
      url: imageUrl,
      selection: "",
      thumbnail: imageUrl,
      capturedAt: new Date().toISOString(),
      source: "luckyray-plugin",
      sourceDetail: { browser: detectBrowser(), trigger },
    }, "图片已发送到 LuckyRay。");
  } catch (error) {
    if (notifyTransportFailure(error)) return;
    console.error("[luckyray-plugin] collectImage failed:", error);
    await copyToClipboard(buildMarkdown(title, imageUrl, ""));
    notify("LuckyRay 未连接，图片链接已复制到剪贴板。");
  }
}

function isUnsupportedMediaUrl(mediaType, url) {
  if (mediaType !== "video") return !String(url || "").trim();
  return !LuckyRayExtensionProtocol.isVideoUrlImportable(url);
}

async function getBestContextImage(tab) {
  if (!tab?.id || isRestrictedUrl(tab.url)) return null;
  const recent = recentCapture(tab.id, "image");
  try {
    const response = await contentReceiver.request(
      tab.id,
      { type: "luckyray-get-hover-image" },
      recent ? { frameId: recent.frameId ?? 0, documentId: recent.documentId || undefined } : { frameId: 0 },
    );
    if (response?.url) {
      if (chrome.tabs?.get) {
        const currentTab = await chrome.tabs.get(tab.id).catch(() => null);
        if (!currentTab || currentTab.url !== tab.url) return null;
      }
      const descriptor = LuckyRayExtensionProtocol.createCaptureDescriptor({
        ...response,
        tabId: tab.id,
        frameId: recent?.frameId ?? 0,
        documentId: recent?.documentId || null,
      });
      rememberCapture(tab.id, "image", descriptor);
      return descriptor;
    }
  } catch (_) {
    // The content script may not be injected yet on old tabs.
  }
  return null;
}

async function directCollect(payload, successMsg) {
  // Page-text collection follows the same explicit, verified binding as the
  // material funnel; it never scans or fails over to another Desktop.
  const resolved = await resolveMaterialConnection();
  if (!resolved.ok) {
    const error = new Error(resolved.code);
    error.code = resolved.code;
    throw error;
  }
  const result = await postToPort(resolved.binding, payload, 5000);
  notify(successMsg);
}

async function postToPort(binding, payload, timeoutMs) {
  const response = await LuckyRayLocalTransport.fetch(binding, "/collect", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-LuckyRay-Source": SOURCE_HEADER,
    },
    body: JSON.stringify(payload),
  }, timeoutMs);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return { port };
}

async function fallbackToClipboard(tab, selectionText) {
  try {
    const info = await getPageInfo(tab.id);
    const selection = selectionText || info.selection || "";
    await copyToClipboard(buildMarkdown(info.title, info.url, selection));
    notify("LuckyRay is not reachable. Content copied to clipboard.");
  } catch (error) {
    console.error("[luckyray-plugin] fallback failed:", error);
    notify("Could not collect this page.");
  }
}

function buildMarkdown(title, url, selection) {
  return `---
title: ${title}
url: ${url}
selection: ${selection}
captured_at: ${new Date().toISOString()}
source: luckyray-plugin
---

# ${title}

${url}

${selection || ""}`;
}

async function getPageInfo(tabId) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await contentReceiver.request(tabId, { type: "luckyray-get-page-context" }, {
      frameId: 0,
      requiredProtocolVersion: LuckyRayExtensionProtocol.CAPTURE_PROTOCOL_VERSION,
    });
    const snapshot = LuckyRayExtensionProtocol.createPageSnapshot(response);
    const tab = await chrome.tabs.get(tabId);
    if (snapshot && LuckyRayExtensionProtocol.isPageSnapshotCurrent(snapshot, tab?.url || "")) {
      return {
        ...snapshot,
        captureProtocolVersion: LuckyRayExtensionProtocol.CAPTURE_PROTOCOL_VERSION,
        selection: snapshot.contentKind === "selection" ? snapshot.content : "",
        articleText: snapshot.contentKind === "article" ? snapshot.content : "",
      };
    }
  }
  throw new Error("Page changed while capturing");
}

async function copyToClipboard(text) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [text],
    func: async (md) => {
      try {
        await navigator.clipboard.writeText(md);
      } catch (_) {
        const textarea = document.createElement("textarea");
        textarea.value = md;
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
    },
  });
}

function isRestrictedUrl(url) {
  return /^(chrome|edge|extensions|chrome-extension|about|brave|vivaldi|opera):\/\//i.test(url || "");
}

function detectBrowser() {
  const ua = navigator.userAgent || "";
  return ua.includes("Edg/") ? "edge" : "chrome";
}

function notify(message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon-48.png",
    title: "LuckyRay",
    message,
  });
}

// === D45a-R1: 录制当前标签页（tabCapture + MediaRecorder via offscreen） ===

async function startRecordingOnce(tabId, opts) {
  await refreshRecordingState();
  if (recordingState.active) {
    return { ok: false, code: "recording-busy", message: "已有标签页正在录制。" };
  }
  if (typeof tabId !== "number") {
    return { ok: false, code: "recording-request-invalid", message: "无法识别当前标签页。" };
  }
  if (typeof chrome.tabCapture === "undefined" || !chrome.tabCapture.getMediaStreamId) {
    await recordFailureToHistory("tab_capture_unavailable");
    return { ok: false, code: "recording-unavailable", message: "当前浏览器不支持标签页录制。" };
  }
  try {
    // Recording start resolves the same verified binding; a stale selection
    // fails closed here instead of silently recording into another Desktop.
    // The binding is kept for the whole recording lifetime.
    const resolved = await resolveMaterialConnection();
    if (!resolved.ok) {
      return { ok: false, code: resolved.code === "connection-selection-stale" || resolved.code === "multiple-instances"
        ? resolved.code : "app-unavailable", message: safeMediaTransferMessage(resolved.code) || "请先打开 LuckyRay。" };
    }
    recordingState.connection = resolved.binding;
  } catch (_) {
    return { ok: false, code: "app-unavailable", message: "请先打开 LuckyRay。" };
  }
  try {
    await ensureOffscreen();
  } catch (_) {
    return { ok: false, code: "recording-unavailable", message: "当前浏览器无法启动录制。" };
  }
  let streamId;
  try {
    streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        if (chrome.runtime.lastError || !id) {
          const msg = (chrome.runtime.lastError && chrome.runtime.lastError.message) || "tabCapture 未返回 streamId";
          reject(new Error(msg));
          return;
        }
        resolve(id);
      });
    });
  } catch (_) {
    await recordFailureToHistory("tab_capture_unavailable");
    return { ok: false, code: "recording-permission-denied", message: "无法取得当前标签页的录制权限。" };
  }
  const recordingId = crypto && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const startResp = await sendOffscreenMessage({
    type: "luckyray-offscreen-record-start",
    streamId,
    recordingId,
    tabId,
  });
  if (!startResp || !startResp.ok) {
    const code = String(startResp?.code || "recording-unavailable");
    await recordFailureToHistory(code);
    return { ok: false, code, message: safeRecordingPublicMessage(code) };
  }
  recordingState.active = true;
  recordingState.recordingId = recordingId;
  recordingState.tabId = tabId;
  recordingState.pageUrl = safeUrlOrigin(opts.pageUrl);
  recordingState.sourcePageUrl = LuckyRayExtensionProtocol.normalizeSourcePageUrl(opts.pageUrl);
  recordingState.pageTitle = opts.pageTitle || "";
  recordingState.startedAt = Date.now();
  return { ok: true };
}

async function startRecording(tabId, opts) {
  if (recordingStartPromise) {
    return { ok: false, code: "recording-busy", message: "正在启动另一个录制。" };
  }
  const operation = startRecordingOnce(tabId, opts || {});
  recordingStartPromise = operation;
  try {
    return await operation;
  } finally {
    if (recordingStartPromise === operation) recordingStartPromise = null;
  }
}

async function stopRecordingAndSaveOnce() {
  if (recordingStartPromise) await recordingStartPromise.catch(() => {});
  if (!recordingState.active) await refreshRecordingState();
  if (!recordingState.active) {
    return { ok: false, code: "recording-not-active", message: "当前没有正在录制的标签页。" };
  }
  const recordingContext = {
    connection: bindingShape(recordingState.connection) ? { ...recordingState.connection } : null,
    title: recordingState.pageTitle || "录制的标签页",
    sourceUrl: recordingState.pageUrl || "",
    sourcePageUrl: recordingState.sourcePageUrl || "",
    startedAt: recordingState.startedAt,
  };
  // 1. 让 offscreen 停止 + 给出 base64 + size
  const stopResp = await sendOffscreenMessage({
    type: "luckyray-offscreen-record-stop",
    recordingId: recordingState.recordingId,
  }, RECORD_STOP_TIMEOUT_MS);
  if (!stopResp || !stopResp.ok) {
    await closeOffscreenSafely();
    clearRecordingState();
    const code = String(stopResp?.code || "recording-unavailable");
    return { ok: false, code, message: safeRecordingPublicMessage(code) };
  }
  clearRecordingState();
  // Clearing the live recording must not discard the stop operation's
  // original Desktop. A recovered recording with no binding stays unbound.
  const recordingBinding = recordingContext.connection;
  if (!recordingBinding) {
    await recordFailureToHistory("recording-save-failed", recordingBinding);
    return { ok: false, code: "recording-save-failed", message: "录制完成，但保存到素材库失败。" };
  }
  // 2. POST 到桌面端
  const body = {
    webmBase64: stopResp.base64,
    title: `${recordingContext.title} · ${formatRecordingTime(new Date(recordingContext.startedAt))}`,
    sourceUrl: recordingContext.sourceUrl,
  };
  const sourcePageSupported = recordingContext.sourcePageUrl
    ? await supportsMaterialSourcePage(recordingBinding) : false;
  if (sourcePageSupported) {
    body.sourcePageUrl = recordingContext.sourcePageUrl;
    // A tab recording can contain a related player from a different work.
    // The tab URL identifies the capture context, never the recorded work.
    body.sourcePageKind = "capture-page";
  }
  let resp;
  try {
    // The finished recording is saved on the exact binding the recording
    // started under — a binding-less state (old worker) fails closed.
    resp = await LuckyRayLocalTransport.fetch(recordingBinding, "/api/video/record/save", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-LuckyRay-Source": SOURCE_HEADER },
      body: JSON.stringify(body),
    }, RECORD_STOP_TIMEOUT_MS);
  } catch (_) {
    await recordFailureToHistory("recording-save-failed", recordingBinding);
    return { ok: false, code: "recording-save-failed", message: "录制完成，但保存到素材库失败。" };
  }
  if (!resp.ok) {
    await recordFailureToHistory("recording-save-failed", recordingBinding);
    return { ok: false, code: "recording-save-failed", message: "录制完成，但保存到素材库失败。" };
  }
  const payload = await resp.json().catch(() => null);
  const canonical = LuckyRayExtensionProtocol.parseMaterialImportResponse(payload);
  if (!canonical.ok) return { ok: false, error: canonical.code };
  return {
    ok: true,
    sourcePageUnsupported: Boolean(recordingContext.sourcePageUrl && !sourcePageSupported),
    disposition: canonical.disposition,
    assetId: canonical.asset.id,
    assetName: canonical.asset.name,
    sizeBytes: canonical.asset.sizeBytes,
    kind: canonical.asset.kind,
  };
}

async function stopRecordingAndSave() {
  if (recordingStopPromise) return await recordingStopPromise;
  const operation = stopRecordingAndSaveOnce();
  recordingStopPromise = operation;
  try {
    return await operation;
  } finally {
    if (recordingStopPromise === operation) recordingStopPromise = null;
  }
}

async function stopRecordingNoSave() {
  if (!recordingState.active) await refreshRecordingState();
  if (!recordingState.active) return;
  const cancelled = await sendOffscreenMessage({
    type: "luckyray-offscreen-record-cancel",
    recordingId: recordingState.recordingId,
  }, 5_000);
  if (!cancelled?.ok) await closeOffscreenSafely();
  clearRecordingState();
}

async function stopRecordingForTab(tabId) {
  if (!recordingState.active) await refreshRecordingState();
  if (recordingState.active && recordingState.tabId === tabId) await stopRecordingNoSave();
}

function formatRecordingTime(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function safeUrlOrigin(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : "";
  } catch (_) {
    return "";
  }
}

function safeRecordingPublicMessage(code) {
  const messages = {
    "recording-size-limit": "录制内容已达到 64 MB 上限，已安全停止。",
    "recording-duration-limit": "录制已达到 20 分钟上限，已安全停止。",
    "recording-permission-denied": "无法取得当前标签页的录制权限。",
    "recording-not-active": "当前没有正在录制的标签页。",
    "recording-busy": "已有标签页正在录制。",
    "recording-save-failed": "录制完成，但保存到素材库失败。",
    "recording-unavailable": "当前浏览器无法启动录制。",
  };
  return messages[String(code || "")] || "标签页录制失败。";
}

async function recordFailureToHistory(code, connection) {
  try {
    const safeCode = String(code || "recording-failed").replace(/[^a-z0-9_-]/gi, "").slice(0, 64) || "recording-failed";
    const payload = {
      source: "browser-plugin-record",
      payload: {},
      error: safeRecordingPublicMessage(safeCode),
      reason: safeCode,
    };
    // Stop/failure callbacks pass a snapshot explicitly, including null for
    // an old unbound recording. Never resolve the current selection in that
    // case. Only pre-start failures without a recording context may resolve.
    const resolved = arguments.length > 1
      ? { ok: Boolean(bindingShape(connection)), binding: connection }
      : bindingShape(recordingState?.connection)
      ? { ok: true, binding: recordingState.connection }
      : await resolveMaterialConnection();
    if (!resolved.ok) return;
    await LuckyRayLocalTransport.fetch(resolved.binding, "/api/collection/failures", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-LuckyRay-Source": SOURCE_HEADER },
      body: JSON.stringify(payload),
    });
  } catch (_) {}
}

// 监听标签页关闭：自动停录制
chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const wasRecording = recordingState.active && recordingState.tabId === tabId;
    await stopRecordingForTab(tabId);
    if (wasRecording) notify("标签页已关闭，录制自动停止。");
  })();
});
