const el = (id) => document.getElementById(id);
const popupMediaActionGate = LuckyRayExtensionProtocol.createActionGate();
const RECORD_STOP_TIMEOUT_MS = 120_000;
let captureReturnPromise;
function readCaptureReturn() {
  if (!captureReturnPromise) captureReturnPromise = new URLSearchParams(location.search).has("captureReturn")
    ? sendMessage({ type: "luckyray-capture-return" }).then(result => result.ok ? result.context : null)
    : Promise.resolve(null);
  return captureReturnPromise;
}

const state = {
  submitting: false,
  unresolvedWrite: false,
  captureTask: null,
  port: null,
  // Verified Desktop binding for this popup's own direct requests; null on
  // legacy single-discovery transports. Multiple instances require an
  // explicit choice before any save leaves the popup.
  binding: null,
  connectionCandidates: null,
  connectionCode: null,
  tab: null,
  page: { captureProtocolVersion: 0, title: "", url: "", sourceUrl: "", selection: "", content: "", contentKind: "summary", imageUrl: "", videoUrl: "" },
  type: "image",
  categoryChosen: false,
  folders: [],
  recentNotes: [],
  selectedFolderId: null,
  // note:recent / note:search keep mode-scoped selections (FIX-1 P1): a note
  // picked (or preloaded) in one target mode must never authorize a write in
  // another mode. searchSelectionQuery records the query the search selection
  // was made under; any query change invalidates it.
  noteSelection: { recent: null, search: null },
  searchSelectionQuery: "",
  currentNote: null,
  videoCandidates: [],
  selectedVideoUrl: "",
  selectedVideoKey: "",
  // FIX-1 P1-3: an explicit user pick must survive refresh BY IDENTITY; when
  // the picked candidate disappears, the selection is cleared instead of
  // silently retargeting. selectionRequiresPick blocks the submit path and
  // the render-time convenience default until the user picks a visible
  // candidate again.
  selectedVideoExplicit: false,
  selectionRequiresPick: false,
  searchTimer: null,
  prefillMedia: null,
  prefillLink: null,
  prefillLinkInvalid: false,
  prefillMediaInvalid: false,
  prefillExpiryTimer: null,
  advancedCollapsed: LuckyRayExtensionProtocol.quickCollectDefaultViewState().advancedCollapsed,
  recording: {
    status: "idle",
    errorMsg: "",
    startedAt: 0,
    elapsedSec: 0,
    timerId: null,
  },
};

async function sendMessage(message, timeoutMs = 6_500) {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(response || {});
    };
    const timer = setTimeout(() => finish({ code: "host-unavailable" }), timeoutMs);
    chrome.runtime.sendMessage(message, (resp) => {
      const runtimeError = chrome.runtime.lastError;
      finish(resp || (runtimeError ? { code: "host-unavailable" } : {}));
    });
  });
}

async function getActiveTab() {
  return await new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs && tabs[0] ? tabs[0] : null));
  });
}

async function getPageInfo() {
  const context = await readCaptureReturn();
  const source = context ? await chrome.tabs.get(context.tabId).catch(() => null) : null;
  state.tab = source && source.url === context?.pageUrl ? source : await getActiveTab();
  return await sendMessage({ type: "luckyray-popup-get-page", tabId: state.tab && state.tab.id });
}

async function getPageInfoForType(type, tabId = state.tab && state.tab.id) {
  if (type === "image" || type === "video") {
    // EXT-R1-R1 P1-2: always ask the content side for a fresh revalidated
    // descriptor — a prefill or previous selection never short-circuits the
    // fresh-media request that the final Save decision is based on.
    return await sendMessage({ type: "luckyray-popup-get-media", tabId, mediaType: type });
  }
  return await sendMessage({ type: "luckyray-popup-get-page", tabId });
}

async function getConnectionState() {
  const resp = await sendMessage({ type: "luckyray-popup-get-port" });
  if (!resp || (typeof resp.port !== "number" && !resp.code)) {
    return { port: null, code: "host-unavailable" };
  }
  return resp;
}

function applyConnectionState(connection) {
  state.port = typeof connection?.port === "number" ? connection.port : null;
  state.connectionCode = typeof connection?.code === "string" ? connection.code : null;
  // The popup's own direct requests follow the same explicitly selected,
  // proof-verified Desktop binding the background recorded — including the
  // instance nonce, so a restarted service is detected here too.
  state.binding = state.port !== null && /^[a-f0-9]{64}$/.test(String(connection?.fingerprint || ""))
    ? { version: 1, port: state.port,
        origin: typeof connection?.origin === "string" ? connection.origin : LuckyRayLocalTransport.runtimeOrigin(),
        fingerprint: connection.fingerprint,
        serverNonce: /^[a-f0-9]{64}$/.test(String(connection?.serverNonce || "")) ? connection.serverNonce : null }
    : null;
  state.connectionCandidates = Array.isArray(connection?.candidates) ? connection.candidates : null;
}

function renderConnectionChoices() {
  const host = el("lr-connection-choices");
  if (!host) return;
  host.replaceChildren();
  // The chooser is required both for several live instances AND whenever the
  // recorded selection went stale — even if only ONE candidate remains, the
  // user must explicitly re-select before anything may dispatch again.
  const needsChoice = state.port === null && state.connectionCandidates && state.connectionCandidates.length >= 1
    && (state.connectionCode === "multiple-instances" || state.connectionCode === "connection-selection-stale");
  if (!needsChoice) {
    host.hidden = true;
    return;
  }
  const reselect = state.connectionCode === "connection-selection-stale";
  for (const candidate of state.connectionCandidates) {
    if (candidate?.version !== 1 || !Number.isInteger(candidate.port)) continue;
    const option = document.createElement("button");
    option.type = "button";
    option.className = "lr-connection-choice";
    option.textContent = `${reselect ? "重新选择" : "使用"} LuckyRay 127.0.0.1:${candidate.port}（身份 ${String(candidate.fingerprint || "").slice(0, 8)}）`;
    option.addEventListener("click", async () => {
      option.disabled = true;
      // Send the COMPLETE descriptor the user saw — including the instance
      // nonce — so a same-credential restart after display cannot be
      // selected by port/fingerprint alone.
      const response = await sendMessage({ type: "luckyray-popup-select-connection", candidate: {
        version: 1, port: candidate.port, origin: candidate.origin,
        fingerprint: candidate.fingerprint, serverNonce: candidate.serverNonce } });
      option.disabled = false;
      if (!response?.ok) {
        showToast(response?.code === "connection-select-stale"
          ? "该实例已变化，请重新选择。" : "该连接不可用，请重新选择。", true);
        const refreshed = await getConnectionState().catch(() => null);
        if (refreshed) { applyConnectionState(refreshed); renderConnectionChoices(); }
        return;
      }
      applyConnectionState(response);
      setStatus("已连接", "connected");
      renderConnectionChoices();
      await loadConnectedData();
      renderSubmitState();
    });
    host.append(option);
  }
  host.hidden = host.childElementCount === 0;
}

async function getCurrentNote() {
  return await sendMessage({ type: "luckyray-popup-get-current-note" });
}

async function getVideoCandidates() {
  const resp = await sendMessage({ type: "luckyray-popup-get-video-candidates", tabId: state.tab && state.tab.id });
  return Array.isArray(resp.candidates) ? resp.candidates : [];
}

async function getRecordingStatus() {
  const response = await sendMessage({ type: "luckyray-record-status" });
  return {
    active: Boolean(response?.ok && response.active),
    tabId: Number.isInteger(response?.tabId) ? response.tabId : null,
    elapsedSec: Number.isSafeInteger(response?.elapsedSec) ? Math.max(0, response.elapsedSec) : 0,
  };
}

async function callApi(method, path, body) {
  if (!state.port) return { ok: false, error: "LuckyRay 未连接" };
  const opts = {
    method,
    headers: { "Content-Type": "application/json", "X-LuckyRay-Source": "luckyray-plugin" },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  try {
    const fetchResponse = async () => {
      const response = await LuckyRayLocalTransport.fetch(state.binding ?? state.port, path, opts);
      return { response, text: await response.text() };
    };
    let received;
    try {
      received = await fetchResponse();
    } catch (error) {
      // Only a failure proven to predate dispatch may replay an identical
      // receipt-backed write; a lost response is never re-sent from here.
      if (!body?.requestId || error?.notDispatched !== true) throw error;
      received = await fetchResponse();
    }
    const { response: r, text } = received;
    if (!r.ok) {
      let errorObject = null;
      try { errorObject = JSON.parse(text); } catch (_) {}
      const code = errorObject?.error?.code || errorObject?.code;
      if (code === "capture-commit-uncertain" || code === "capture-commit-partial") state.unresolvedWrite = true;
      return { ok: false, status: r.status, error: text || `HTTP ${r.status}`, errorObject };
    }
    try {
      return { ok: true, data: LuckyRayExtensionProtocol.unwrapTransportEnvelope(JSON.parse(text)) };
    } catch (_) {
      if (body?.requestId) {
        state.unresolvedWrite = true;
        return { ok: false, errorObject: { code: "capture-commit-uncertain" } };
      }
      return { ok: true, data: text };
    }
  } catch (e) {
    if (body?.requestId) {
      state.unresolvedWrite = true;
      return { ok: false, errorObject: { code: "capture-commit-uncertain" } };
    }
    const code = safePopupTransportCode(e?.code);
    return {
      ok: false,
      error: code === "app-unavailable" ? "LuckyRay 未连接" : "LuckyRay 本地连接暂时中断",
      errorObject: { code },
    };
  }
}

function safePopupTransportCode(value) {
  const code = String(value || "");
  return new Set([
    "app-unavailable",
    "host-unavailable",
    "bootstrap-rejected",
    "verification-unavailable",
    "protocol-incompatible",
  ]).has(code) ? code : "host-unavailable";
}

function showToast(message, isError) {
  const toast = el("lr-toast");
  toast.textContent = message;
  toast.classList.toggle("error", !!isError);
  toast.style.display = "block";
  setTimeout(() => { toast.style.display = "none"; }, 3200);
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function setStatus(text, kind) {
  const status = el("lr-status");
  const dot = document.createElement("i");
  // The label lives in its own span so a long diagnostic truncates inside the
  // pill instead of squeezing the brand. textContent is unchanged.
  const label = document.createElement("span");
  label.className = "lr-status-text";
  label.textContent = text;
  status.replaceChildren(dot, label);
  status.classList.remove("connected", "error");
  if (kind) status.classList.add(kind);
}

function renderSource() {
  const source = el("lr-source");
  source.textContent = state.page.title || state.page.url || "当前网页";
  source.title = state.page.url || "";
  renderPagePreview();
}

function renderPagePreview() {
  renderLinkQuick();
  globalThis.LuckyRayAudioPopup?.render();
  const panel = el("lr-page-preview");
  if (state.type === "audio") { panel.style.display = "none"; renderSubmitState(); return; }
  const reloadButton = el("lr-reload-extension");
  const readiness = LuckyRayExtensionProtocol.pageCaptureReadiness(state.page, state.type);
  reloadButton.style.display = "none";
  if (!readiness.ready) {
    panel.style.display = "";
    const requiresReload = readiness.code === "reload-required";
    el("lr-preview-kind").textContent = requiresReload ? "组件待更新" : "未识别正文";
    el("lr-preview-title").textContent = state.page.title || "当前网页";
    el("lr-preview-meta").style.display = "none";
    el("lr-preview-snippet").textContent = requiresReload
      ? "后台组件仍是旧版本。应用更新后会自动重载插件与当前网页采集器。"
      : "当前页面没有可验证的正文。可以选择文字后采集，或在下方添加链接。";
    reloadButton.style.display = requiresReload ? "" : "none";
    renderSubmitState();
    return;
  }
  const preview = LuckyRayExtensionProtocol.buildPagePreview(state.page, state.type === "link" ? "text" : state.type);
  panel.style.display = preview.visible ? "" : "none";
  if (!preview.visible) return;
  el("lr-preview-kind").textContent = preview.kindLabel;
  el("lr-preview-title").textContent = preview.title || "当前网页";
  el("lr-preview-meta").textContent = preview.metadata;
  el("lr-preview-meta").style.display = preview.metadata ? "" : "none";
  el("lr-preview-snippet").textContent = preview.snippet || "暂无可预览正文";
  renderSubmitState();
}

function renderTypeSelection() {
  el("lr-image-entry").hidden = state.type !== "image";
  el("lr-article-entry").hidden = state.type !== "text" && state.type !== "link";
  el("lr-capture-error").hidden = true;
  document.querySelectorAll(".lr-type").forEach((button) => {
    button.classList.toggle("active", button.dataset.type === (state.type === "link" ? "text" : state.type));
  });
  globalThis.LuckyRayCollectionPopup?.render();
}

function renderLinkQuick() {
  const visible = state.type === "text" || state.type === "link";
  el("lr-link-quick").hidden = !visible;
  el("lr-link-details").hidden = state.type !== "link";
  el("lr-add-link").setAttribute("aria-expanded", String(state.type === "link"));
  const link = state.prefillLink ? LuckyRayCollectionInput.currentLink(state.prefillLink, state.tab, state.page.url) : null;
  el("lr-link-value").textContent = link?.url || state.page.url || "当前网页链接不可用";
}

// M1-S2 Quick Collect (Issue #18): compact first screen + explicit commit gate.
// Collapsing/expanding the advanced surface changes display only — it never
// alters capture type, target or triggers any write.

function applyAdvancedCollapsed() {
  // Naming is part of the primary new-note flow, not a hidden advanced option.
  const naming = el("lr-note-new");
  if (naming && el("lr-advanced")?.contains(naming)) el("lr-advanced").before(naming);
  const advanced = el("lr-advanced");
  const toggle = el("lr-more-options");
  if (!advanced || !toggle) return;
  advanced.hidden = state.advancedCollapsed;
  const label = toggle.querySelector("span");
  const icon = toggle.querySelector("i");
  if (label) label.textContent = state.advancedCollapsed ? "保存选项" : "收起选项";
  if (icon) icon.textContent = state.advancedCollapsed ? "▾" : "▴";
  toggle.setAttribute("aria-expanded", state.advancedCollapsed ? "false" : "true");
  const qc = el("lr-qc");
  if (qc) qc.setAttribute("aria-expanded", state.advancedCollapsed ? "false" : "true");
}

function renderQuickCollect() {
  const chip = el("lr-qc-type");
  if (chip) {
    const icons = { image: "▧", video: "▶", audio: "♫", text: "¶", link: "↗" };
    const iconEl = chip.querySelector("i");
    const labelEl = chip.querySelector("span");
    if (iconEl) {
      iconEl.textContent = icons[state.type] || "▧";
      // Presentation only: names the mask the stylesheet paints so the icon
      // follows the selected capture type. The text glyph above stays in the
      // DOM for any non-CSS consumer.
      iconEl.dataset.lrIcon = ["image", "video", "audio", "text", "link"].includes(state.type) ? state.type : "image";
    }
    if (labelEl) labelEl.textContent = LuckyRayExtensionProtocol.quickCollectTypeLabel(state.type) || "图片";
  }
  const summary = el("lr-target-summary");
  if (summary) {
    summary.textContent = LuckyRayExtensionProtocol.quickCollectTargetLabel(el("lr-target").value) || "未设置保存位置";
  }
  globalThis.LuckyRayMediaDestination?.summary();
}

// Single source of truth for the Quick Collect commit gate: renderSubmitState
// (button state) and onSubmit (final commit revalidation, FIX-2 P1) must use
// exactly the same inputs derived from the current DOM/state.
function quickCollectGateState() {
  const mediaGate = globalThis.LuckyRayMediaDestination?.gate();
  if (mediaGate) return mediaGate;
  const collectionGate = globalThis.LuckyRayCollectionPopup?.gate();
  if (collectionGate) return collectionGate;
  if (state.type === "link" && (state.prefillLinkInvalid || (state.prefillLink && !LuckyRayCollectionInput.currentLink(state.prefillLink, state.tab, state.page.url))))
    return { canSubmit: false, reason: "所选链接已失效，请回网页重新右键选择" };
  if (state.type === "image" && (state.prefillMediaInvalid || (state.prefillMedia && !LuckyRayExtensionProtocol.mediaPrefillIdentity(state.prefillMedia, "image"))))
    return { canSubmit: false, reason: "所选图片已失效，请回网页重新右键选择" };
  if (state.captureTask && !state.captureTask.acknowledged
    && !["completed", "failed"].includes(state.captureTask.stage)) {
    return { canSubmit: false, reason: "已有保存任务，请查看下方进度或处理结果" };
  }
  if (state.unresolvedWrite) return { canSubmit: false, reason: "保存结果待核对，请先在桌面端检查，再重新打开采集" };
  if (state.submitting) return { canSubmit: false, reason: "正在保存，请等待完成" };
  if (state.type === "audio") return globalThis.LuckyRayAudioPopup?.gate() || { canSubmit: false, reason: "正在读取音频" };
  const target = el("lr-target").value;
  const selection = {
    selectedFolderId: state.selectedFolderId,
    selectedNoteId: null,
  };
  if (target === "note:recent") {
    selection.selectedNoteId = state.noteSelection.recent;
  } else if (target === "note:search") {
    // Search completeness additionally requires the selection to be bound to
    // the current query (FIX-1 P1): a stale id must never pass the gate.
    selection.selectedNoteId = state.noteSelection.search;
    selection.searchSelectionMatchesQuery = el("lr-note-q").value.trim() === state.searchSelectionQuery;
  }
  // EXT-R1-R1 P2-1: the visible submit gate receives the same video-selection
  // authority the final write path enforces — when an explicit pick was
  // invalidated, the button is disabled with the re-pick reason instead of
  // letting the click discover it.
  // EXT-R1-REPAIR-2 (contract C): every allowed video destination — asset:*
  // AND all note targets — shares the same visible selection gate; an
  // invalidated selection disables Save everywhere with the re-pick reason.
  const validPrefill = state.type === "video" && state.prefillMedia
    ? LuckyRayExtensionProtocol.mediaPrefillIdentity(state.prefillMedia, "video")
    : null;
  const videoSelection = state.type === "video"
    ? {
      hasValidSelection: Boolean(selectedVideoCandidate()) || Boolean(validPrefill),
      requiresPick: state.selectionRequiresPick || state.prefillMediaInvalid || Boolean(state.prefillMedia && !validPrefill),
    }
    : null;
  return LuckyRayExtensionProtocol.quickCollectSubmitGate({
    port: state.port,
    readiness: LuckyRayExtensionProtocol.pageCaptureReadiness(state.page, state.type),
    target,
    selection,
    videoSelection,
  });
}

function renderSubmitState() {
  const button = el("lr-submit");
  const label = button.querySelector("span");
  const summary = el("lr-action-summary");
  const labels = {
    image: ["保存图片", "图片将进入素材库"],
    video: ["保存视频", "优先保存可下载视频"],
    audio: ["保存音频", "音频将进入素材库"],
    text: ["保存正文", "正文将写入笔记"],
    link: ["保存链接", "链接将写入笔记"],
  };
  const [buttonLabel, summaryLabel] = labels[state.type] || labels.text;
  if (label) label.textContent = buttonLabel;
  const gate = quickCollectGateState();
  button.disabled = !gate.canSubmit;
  summary.textContent = gate.canSubmit ? summaryLabel : gate.reason;
  summary.classList.toggle("lr-action-summary-blocked", !gate.canSubmit);
}

function renderCurrentNote() {
  const box = el("lr-current-note");
  const current = state.currentNote || {};
  box.style.display = current.noteId ? "" : "none";
  if (current.noteId) {
    box.innerHTML = `<span>当前笔记</span><strong>${escapeHtml(current.noteId.slice(0, 8))}</strong><em>${current.hasCursor ? "可插入光标" : "无光标，追加末尾"}</em>`;
  } else {
    box.innerHTML = `<span>当前笔记</span><strong>未检测到</strong><em>可新建或追加到指定笔记</em>`;
  }
}

function isMediaType() {
  return state.type === "image" || state.type === "video" || state.type === "audio";
}

function defaultTargetForType(type) {
  return LuckyRayExtensionProtocol.buildCaptureTargetPolicy(type, {
    hasCurrentNote: Boolean(state.currentNote?.noteId),
    hasRecentNotes: state.recentNotes.length > 0,
  }).defaultTarget;
}

function renderTargetOptions() {
  const select = el("lr-target");
  const policy = LuckyRayExtensionProtocol.buildCaptureTargetPolicy(state.type, {
    hasCurrentNote: Boolean(state.currentNote?.noteId),
    hasRecentNotes: state.recentNotes.length > 0,
  });
  const allowed = new Set(policy.allowedTargets);
  Array.from(select.options).forEach((option) => {
    option.disabled = !allowed.has(option.value);
    option.hidden = !allowed.has(option.value);
  });
  el("lr-record").style.display = policy.showRecording ? "" : "none";
  if (Array.from(select.options).some((o) => o.value === select.value && !o.disabled && !o.hidden)) {
    renderTargetSub();
    return;
  }
  select.value = policy.defaultTarget;
  renderTargetSub();
}

function renderTargetSub() {
  const target = el("lr-target").value;
  ["lr-folder-pick", "lr-folder-new", "lr-note-search", "lr-note-recent", "lr-note-new", "lr-note-insert"].forEach((id) => {
    el(id).style.display = "none";
  });
  if (target === "asset:pick") {
    el("lr-folder-pick").style.display = "";
    renderFolders();
  } else if (target === "asset:newFolder") {
    el("lr-folder-new").style.display = "";
  } else if (target === "note:search") {
    el("lr-note-search").style.display = "";
  } else if (target === "note:recent") {
    el("lr-note-recent").style.display = "";
    renderRecent();
  } else if (target === "note:new") {
    el("lr-note-new").style.display = "";
  } else if (target === "note:insertCurrent") {
    el("lr-note-insert").style.display = "";
  }
}

function renderFolders() {
  const list = el("lr-folder-list");
  if (!state.folders.length) {
    list.textContent = "暂无文件夹";
    return;
  }
  const sorted = [...state.folders].sort((a, b) => {
    if (!a.parentId && b.parentId) return -1;
    if (a.parentId && !b.parentId) return 1;
    return (a.sortOrder || 0) - (b.sortOrder || 0);
  });
  list.innerHTML = "";
  for (const folder of sorted) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "lr-list-item" + (state.selectedFolderId === folder.id ? " selected" : "");
    item.innerHTML = `<span>${folder.parentId ? "↳ " : ""}${escapeHtml(folder.name)}</span>`;
    item.addEventListener("click", () => {
      state.selectedFolderId = folder.id;
      renderFolders();
      renderSubmitState();
    });
    list.appendChild(item);
  }
}

function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  if (diff < 24 * 60 * 60 * 1000) return d.toTimeString().slice(0, 5);
  return iso.slice(0, 10);
}

function renderRecent() {
  const list = el("lr-recent-list");
  if (!state.recentNotes.length) {
    list.textContent = "暂无最近笔记";
    return;
  }
  list.innerHTML = "";
  for (const note of state.recentNotes) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "lr-list-item" + (state.noteSelection.recent === note.id ? " selected" : "");
    item.innerHTML = `<span>${escapeHtml(note.title || "未命名笔记")}</span><em>${escapeHtml(formatTime(note.updatedAt))}</em>`;
    item.addEventListener("click", () => {
      state.noteSelection.recent = note.id;
      renderRecent();
      renderSubmitState();
    });
    list.appendChild(item);
  }
}

async function renderSearch() {
  const list = el("lr-note-list");
  const q = el("lr-note-q").value.trim();
  // Any query change invalidates the previous search-result selection until
  // the user explicitly selects a result from the current query (FIX-1 P1).
  if (state.searchSelectionQuery !== q) {
    state.noteSelection.search = null;
    state.searchSelectionQuery = "";
    // The gate must reflect the invalidation immediately.
    renderSubmitState();
  }
  if (!q) {
    list.innerHTML = "";
    return;
  }
  const result = await callApi("GET", `/api/notes/search?q=${encodeURIComponent(q)}`);
  if (!result.ok) {
    list.textContent = `搜索失败：${result.error || result.status || ""}`;
    return;
  }
  const notes = result.data && result.data.notes ? result.data.notes : [];
  list.innerHTML = "";
  for (const note of notes) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "lr-list-item" + (state.noteSelection.search === note.id ? " selected" : "");
    item.innerHTML = `<span>${escapeHtml(note.title || "未命名笔记")}</span><em>${escapeHtml(formatTime(note.updatedAt))}</em>`;
    item.addEventListener("click", () => {
      state.noteSelection.search = note.id;
      state.searchSelectionQuery = q;
      renderSearch();
      renderSubmitState();
    });
    list.appendChild(item);
  }
}

function candidateLabel(candidate) {
  if (!candidate) return "未选择";
  if (candidate.label) return String(candidate.label);
  const menuItem = LuckyRayExtensionProtocol.buildVideoActionMenu([candidate], { maxItems: 1 }).items[0];
  if (menuItem?.label) return menuItem.label;
  if (candidate.kind === "direct_video") return "可直接入库";
  if (candidate.kind === "hls") return "HLS 播放流";
  if (candidate.kind === "dash") return "DASH 播放流";
  if (candidate.kind === "segment") return "视频分片";
  if (candidate.kind === "blob") return "blob 播放流";
  return candidate.reason || "视频候选";
}

// EXT-R1-R1 P1-3: one immutable candidate identity (protocol authority) used
// by render selection, row click, refresh comparison, selected lookup and
// transfer construction. The URL alone is no longer a selection authority: a
// same-URL candidate whose audio/binding/frame/document/probe identity changed
// is a different candidate.
function candidateKey(candidate) {
  const identity = LuckyRayExtensionProtocol.buildVideoCandidateIdentity(candidate);
  return identity || String(candidate?.url || "");
}

function selectedVideoCandidate() {
  return state.videoCandidates.find((candidate) => candidateKey(candidate) === state.selectedVideoKey) || null;
}

async function resolvePopupFormats(candidate) {
  const sourcePageUrl = String(candidate?.url || "");
  const siteAuthResponse = await sendMessage({
    type: "luckyray-site-auth-request",
    url: sourcePageUrl,
    prompt: true,
  });
  const body = { url: sourcePageUrl, sourcePageUrl };
  if (siteAuthResponse?.siteAuth) body.siteAuth = siteAuthResponse.siteAuth;
  const result = await callApi("POST", "/api/media/probes", body);
  if (!result.ok) {
    const code = safeTransferFailureCode(result);
    showToast({
      "media-resolver-unavailable": "视频解析组件当前不可用。",
      "media-authentication-required": "当前视频需要站点登录会话。",
      "media-site-blocked": "视频网站拒绝了当前解析请求。",
      "media-no-formats": "没有解析到可入库的视频清晰度。",
    }[code] || "读取视频清晰度失败，请稍后重试。", true);
    return;
  }
  const parsed = LuckyRayExtensionProtocol.parseMediaProbeSnapshot(result.data);
  if (!parsed.ok) {
    showToast("视频清晰度目录无效，请重试。", true);
    return;
  }
  state.videoCandidates = parsed.formats.map((format) => ({
    kind: "resolved_format",
    url: sourcePageUrl,
    sourcePageUrl,
    probeId: parsed.probeId,
    formatId: format.formatId,
    extension: format.extension,
    label: format.label,
    width: format.width,
    height: format.height,
    bitrate: format.bitrate,
    estimatedBytes: format.estimatedBytes,
    siteAuth: body.siteAuth || null,
    direct: false,
  }));
  state.selectedVideoKey = candidateKey(state.videoCandidates[0]);
  state.selectedVideoUrl = sourcePageUrl;
  // A resolved-format list is a fresh deterministic default (the user asked
  // for the formats); it is not an explicit row pick.
  state.selectedVideoExplicit = false;
  state.selectionRequiresPick = false;
  renderVideoCandidates();
  showToast("已读取可入库的清晰度，请选择一个版本。");
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase();
  } catch (_) {
    return "网页视频";
  }
}

function renderVideoCandidates() {
  const section = el("lr-video-section");
  const list = el("lr-video-candidates");
  section.style.display = state.type === "video" ? "" : "none";
  if (state.type !== "video") return;
  // M1-S4: unified user-level state, same semantics as the player overlay
  // (single buildVideoCaptureView authority).
  const view = LuckyRayExtensionProtocol.buildVideoCaptureView({
    candidates: state.videoCandidates,
  });
  const banner = el("lr-video-state");
  if (banner) {
    banner.hidden = false;
    banner.dataset.state = view.state;
    banner.textContent = view.label;
    // FIX-1 P1-3: when a vanished explicit pick invalidated the selection,
    // the banner title must point the user at an explicit re-pick instead of
    // the generic state guidance.
    banner.title = state.selectionRequiresPick
      ? "候选已变化，请重新选择要保存的视频"
      : view.guidance;
  }
  if (!state.videoCandidates.length) {
    list.innerHTML = `<div class="lr-empty">${escapeHtml(view.guidance || view.label)}</div>`;
    return;
  }
  list.innerHTML = "";
  for (const candidate of state.videoCandidates.slice(0, 8)) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "lr-candidate" + (state.selectedVideoKey === candidateKey(candidate) ? " selected" : "");
    item.innerHTML = `
      <span class="lr-candidate-top">
        <strong>${escapeHtml(candidateLabel(candidate))}</strong>
        <em class="${candidate.direct || candidate.kind === "resolved_format" ? "ok" : "warn"}">${candidate.kind === "resolved_format" ? "可入库" : candidate.kind === "site_page" ? "解析" : candidate.direct ? "直链" : "需兜底"}</em>
      </span>
      <span class="lr-candidate-url">${escapeHtml(shortUrl(candidate.url))}</span>
    `;
    item.addEventListener("click", async () => {
      if (["site_page", "site-resolver"].includes(candidate.kind)) {
        await resolvePopupFormats(candidate);
        return;
      }
      state.selectedVideoKey = candidateKey(candidate);
      state.selectedVideoUrl = candidate.url;
      // FIX-1 P1-3: a row click is the ONLY explicit selection signal; it
      // re-arms the submit path after any earlier invalidation.
      state.selectedVideoExplicit = true;
      state.selectionRequiresPick = false;
      renderVideoCandidates();
      // EXT-R1-R1 P2-1: the visible gate must reflect the valid selection.
      renderSubmitState();
    });
    list.appendChild(item);
  }
  // FIX-1 P1-3: the convenience default only applies before any explicit pick
  // and never re-arms a selection that was invalidated by a disappearing pick.
  if (!state.selectedVideoUrl && !state.selectionRequiresPick) {
    const firstSaveable = state.videoCandidates.find((item) => !isUnsupportedMediaUrl("video", item.url));
    if (firstSaveable) {
      state.selectedVideoUrl = firstSaveable.url;
      state.selectedVideoKey = candidateKey(firstSaveable);
      renderVideoCandidates();
    }
  }
}

async function refreshVideoCandidates() {
  state.videoCandidates = await getVideoCandidates();
  const selectedStillExists = state.videoCandidates.some((item) => candidateKey(item) === state.selectedVideoKey);
  if (!selectedStillExists) {
    // FIX-1 P1-3: an EXPLICIT user pick must never silently retarget to a
    // different candidate when it disappears from the refreshed list — clear
    // the selection and require an explicit re-pick. The deterministic
    // convenience default may keep auto-selecting only while the user has
    // neither explicitly picked a candidate nor had one invalidated.
    if (state.selectedVideoExplicit) {
      state.selectedVideoUrl = "";
      state.selectedVideoKey = "";
      state.selectedVideoExplicit = false;
      state.selectionRequiresPick = true;
    } else if (!state.selectionRequiresPick) {
      const firstSaveable = state.videoCandidates.find((item) => !isUnsupportedMediaUrl("video", item.url));
      state.selectedVideoUrl = firstSaveable ? firstSaveable.url : "";
      state.selectedVideoKey = firstSaveable ? candidateKey(firstSaveable) : "";
    }
  }
  renderVideoCandidates();
  // EXT-R1-R1 P2-1: invalidation, re-pick and resolved-format projection all
  // change the commit gate — rerender the visible submit state immediately.
  renderSubmitState();
}

function isUnsupportedMediaUrl(mediaType, url, videoCommitCandidate = null) {
  if (mediaType !== "video") return !String(url || "").trim();
  // EXT-R1-REPAIR-3: the ONE commit candidate decides; no state re-selection.
  const candidate = videoCommitCandidate || { url };
  if (candidate.kind === "resolved_format") return false;
  const menu = LuckyRayExtensionProtocol.buildVideoActionMenu([candidate], { maxItems: 1 });
  return !menu.items.some((item) => item.canSaveToMaterials);
}

async function importMedia(mediaType, target, url, videoCommitCandidate = null, submission = captureSubmission(target), noteBinding = null, sourcePage = null) {
  const input = { mediaType, url };
  if (target === "asset:newFolder") {
    input.newFolderName = submission.newFolderName || `来自 ${submission.pageTitle || "网页"}`;
  } else if (target === "asset:pick") {
    if (!submission.folderId) return { ok: false, error: "请先选择素材文件夹" };
    input.targetFolderId = submission.folderId;
  }
  const actionId = submission.requestId || submission.prefill?.actionId
    || `popup:${mediaType}:${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  const intent = LuckyRayExtensionProtocol.createMaterialImportIntent({
    ...input,
    actionId,
    requestId: actionId,
    kind: mediaType,
    storageMode: "managed",
    mode: target,
    captureSource: "popup",
  });
  if (!intent) return { ok: false, error: "媒体 URL 无效" };
  let request = mediaType === "video"
    ? await buildVideoTransferRequest(target, url, input.newFolderName, videoCommitCandidate, submission)
    : intent.request;
  if (request?.ok === false) return request;
  if (sourcePage?.pageUrl) {
    const capability = await sendMessage({ type: "luckyray-source-page-capability" });
    if (capability?.supported) {
      request = {
        ...request,
        ...(mediaType === "video"
          ? { materialSourcePageUrl: sourcePage.pageUrl }
          : { sourcePageUrl: sourcePage.pageUrl }),
        sourcePageKind: sourcePage.pageKind,
        ...(sourcePage.pageUrl === LuckyRayExtensionProtocol.normalizeSourcePageUrl(submission.pageUrl)
          ? { sourcePageTitle: submission.pageTitle.slice(0, 240) } : {}),
      };
    } else {
      showToast("当前桌面版不支持保存作品页链接；媒体仍会保存。", true);
    }
  }
  const noteRequest = noteBinding ? {
    ...noteTargetRequest(submission), requestId: submission.requestId,
    sourceUrl: submission.sourceUrl, binding: noteBinding,
    ...(submission.target === "note:new" ? { title: submission.title || submission.pageTitle || "浏览器收集" } : {}),
  } : null;
  return popupMediaActionGate.run(intent, () => sendMessage({
    type: "luckyray-capture-task", action: "start",
    input: { kind: mediaType, request, noteRequest, sourceUrl: submission.sourceUrl,
      ...(submission.destination ? { destination: submission.destination, mediaName: submission.mediaName, fallbackName: submission.pageTitle,
        videoExtension: videoCommitCandidate?.extension || (() => { try { return new URL(url).pathname.match(/\.(mp4|webm|mov|m4v|ogv|ogg|avi|mkv|ts)$/i)?.[1]?.toLowerCase(); } catch (_) { return null; } })() } : {}) },
  }, 25000));
}

function safePopupVideoFileName(url, videoCommitCandidate = null) {
  const selected = videoCommitCandidate;
  return LuckyRayExtensionProtocol.videoTransferFileName(
    state.page.title || state.tab?.title || "LuckyRay video",
    url,
    selected?.extension,
  );
}

function safePopupVideoMime(url, videoCommitCandidate = null) {
  // EXT-R1-REPAIR-3: MIME comes from the ONE commit candidate only — never a
  // URL search over mutable state (same-URL candidates stay distinct).
  const candidate = videoCommitCandidate;
  const value = String(candidate?.contentType || "").split(";")[0].trim().toLowerCase();
  if (/^(video\/[a-z0-9.+-]{1,64}|application\/(vnd\.apple\.mpegurl|x-mpegurl))$/.test(value)) return value;
  try {
    if (/\.m3u8$/i.test(new URL(url).pathname)) return "application/vnd.apple.mpegurl";
  } catch (_) {}
  return undefined;
}

function safeTransferFailureCode(result, fallback = "media-transfer-failed") {
  const value = LuckyRayExtensionProtocol.unwrapTransportEnvelope(result?.errorObject);
  const code = String(value?.code || "");
  return new Set([
    "app-unavailable",
    "host-unavailable",
    "bootstrap-rejected",
    "verification-unavailable",
    "media-capacity",
    "media-cancel-too-late",
    "media-input-invalid",
    "media-transfer-not-found",
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
    "site-auth-required",
  ]).has(code) ? code : fallback;
}

function popupTransferFailureCode(result, url) {
  const code = safeTransferFailureCode(result);
  if (code !== "media-resolver-failed") return code;
  try {
    const host = new URL(String(url || "")).hostname.toLowerCase();
    if (host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com")) {
      return "media-youtube-token-required";
    }
  } catch (_) {}
  return code;
}

function renderPopupTransferProgress(transfer, task) {
  const progress = LuckyRayExtensionProtocol.buildMediaTransferProgress(transfer, task);
  const root = el("lr-transfer-progress");
  const label = el("lr-transfer-progress-label");
  const fill = el("lr-transfer-progress-fill");
  root.style.display = "grid";
  label.textContent = progress.label;
  fill.classList.toggle("indeterminate", progress.indeterminate);
  fill.style.width = progress.indeterminate ? "34%" : `${progress.percent ?? 0}%`;
}

function renderCaptureTask(task) {
  const receipt = LuckyRayExtensionProtocol.captureTaskImportReceipt(task);
  if (task && ["completed", "partial", "attaching"].includes(task.stage) && !receipt.ok)
    task = { ...task, stage: "uncertain", errorCode: receipt.code };
  state.captureTask = task;
  // An empty/new/acknowledged task must not inherit the previous success strip.
  el("lr-transfer-progress").style.display = "none";
  el("lr-transfer-progress-label").textContent = "";
  el("lr-transfer-progress-fill").style.width = "0%";
  el("lr-transfer-progress-fill").classList.remove("indeterminate");
  const panel = el("lr-capture-task");
  panel.style.display = task && !task.acknowledged && !["completed", "failed"].includes(task.stage) ? "grid" : "none";
  if (!task || task.acknowledged) { renderSubmitState(); return; }
  el("lr-capture-task-caption").textContent = "";
  const duplicate = receipt.ok && receipt.disposition === "duplicate";
  const failureCode = popupTransferFailureCode({ errorObject: { code: task.errorCode } }, task.sourceUrl);
  const failure = LuckyRayExtensionProtocol.formatMaterialImportFailure(task.kind === "image"
    ? task.importFailure || { code: task.errorCode } : { code: failureCode }, task.kind).message;
  let label;
  if (task.stage === "completed") label = task.noteRequest
    ? task.noteResult?.data?.indexStale ? "已写入笔记，附件索引等待同步" : duplicate ? "素材已存在，并已写入笔记" : "已入库并写入笔记"
    : duplicate ? "素材已存在" : `${task.kind === "audio" ? "音频" : task.kind === "video" ? "视频" : "图片"}已入库`;
  else if (task.stage === "partial") {
    const outcomes = [task.organizationPartial ? "素材已保存，文件夹或标签未全部整理完成；请在 LuckyRay 中检查。" : "素材已入库。"];
    if (task.noteRequest) {
      if (task.noteResult?.ok) outcomes.push(task.noteResult.data?.indexStale ? "已写入笔记，附件索引等待同步。" : "已写入笔记。");
      else if (task.noteCheckAvailable) outcomes.push("笔记写入结果待核对，请核对原笔记写入；不会自动再次写入。");
      else if (!task.noteResult) outcomes.push("笔记写入结果待核对，请先在 LuckyRay 中核对原笔记，避免重复保存。");
      else outcomes.push(`笔记写入未完成：${LuckyRayExtensionProtocol.formatNoteWriteFailure(task.noteResult)}`);
    }
    label = outcomes.join(" ");
  }
  else if (task.stage === "uncertain") label = "保存结果无法确认，请先在 LuckyRay 中核对；不会自动重新保存。";
  else if (task.stage === "paused") label = "进度读取中断，请连接 LuckyRay 后继续检查原任务。";
  else if (task.stage === "failed") label = failure;
  else label = task.stage === "checking" ? "正在核对原保存结果" : task.stage === "attaching" ? "素材已入库，正在写入原笔记" : "正在保存，关闭弹窗后任务仍会继续";
  label = label.split(" · 诊断")[0].split("· 诊断")[0];
  el("lr-capture-task-label").textContent = label;
  const resume = el("lr-capture-task-resume");
  resume.style.display = task.stage === "paused" || (task.stage === "uncertain" && task.mediaIdentity) || (task.stage === "partial" && task.noteCheckAvailable && !task.noteResult?.ok) ? "" : "none";
  resume.textContent = task.stage === "partial" ? "核对原笔记写入" : "继续检查原任务";
  el("lr-capture-task-ack").style.display = ["partial", "uncertain"].includes(task.stage) ? "" : "none";
  el("lr-capture-task-cancel").style.display = task.kind === "audio" && task.transferId && !task.asset && ["transferring", "paused"].includes(task.stage) ? "" : "none";
  if (task.transfer) renderPopupTransferProgress(task.transfer, task);
  renderSubmitState();
  return label;
}

let captureObservation = null;
function observeCaptureTask(notifyId = null) {
  if (captureObservation) return captureObservation;
  captureObservation = (async () => {
    while (true) {
      const result = await sendMessage({ type: "luckyray-capture-task", action: "status" });
      if (!result.ok) return;
      const label = renderCaptureTask(result.task);
      const task = state.captureTask;
      if (!task || task.acknowledged) return;
      if (!["starting", "transferring", "attaching", "checking"].includes(task.stage)) {
        if (task.id === notifyId) showToast(label, task.stage !== "completed");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  })().finally(() => { captureObservation = null; });
  return captureObservation;
}

async function buildVideoTransferRequest(target, url, newFolderName, videoCommitCandidate = null, submission = captureSubmission(target)) {
  // EXT-R1-REPAIR-3 contract A: the ONE commit candidate chosen in doMedia is
  // the only metadata authority here — no selectedVideoCandidate() re-read and
  // no find-by-URL over mutable state.
  const selectedCandidate = videoCommitCandidate || null;
  const body = {
    requestId: submission.requestId,
    url,
    fileName: LuckyRayExtensionProtocol.videoTransferFileName(submission.mediaName?.replace(/\.(mp4|webm|mov|m4v|ogv|ogg|avi|mkv|ts)$/i, "") || submission.pageTitle || "LuckyRay video", url, selectedCandidate?.extension),
  };
  const mimeType = safePopupVideoMime(url, selectedCandidate);
  if (mimeType) body.mimeType = mimeType;
  if (selectedCandidate?.kind === "resolved_format") {
    body.probeId = String(selectedCandidate.probeId || "");
    body.formatId = String(selectedCandidate.formatId || "");
  }
  if (selectedCandidate?.binding === "site-track-pair"
    && /^https?:\/\//i.test(String(selectedCandidate.audioUrl || ""))) {
    body.audioUrl = selectedCandidate.audioUrl;
  }
  const sourcePageUrl = String(selectedCandidate?.sourcePageUrl || submission.sourceUrl || "");
  if (/^https?:\/\//i.test(sourcePageUrl) && sourcePageUrl.length <= 2048) body.sourcePageUrl = sourcePageUrl;
  if (target === "asset:pick" && submission.folderId) body.targetFolderId = submission.folderId;
  if (target === "asset:newFolder") {
    const folderName = String(newFolderName || "").trim();
    if (!folderName) {
      return { ok: false, error: "请输入新素材文件夹名称", errorObject: { code: "media-input-invalid" } };
    }
    body.newFolderName = folderName.slice(0, 160);
  }
  const authorizationUrl = sourcePageUrl || url;
  if (selectedCandidate?.kind === "resolved_format" && selectedCandidate.siteAuth) {
    body.siteAuth = selectedCandidate.siteAuth;
  } else {
    const siteAuthResponse = await sendMessage({
      type: "luckyray-site-auth-request",
      url: authorizationUrl,
    });
    if (siteAuthResponse?.siteAuth) body.siteAuth = siteAuthResponse.siteAuth;
  }

  return body;
}

function selectedNoteIdForTarget(target) {
  if (target === "note:recent") return state.noteSelection.recent;
  if (target === "note:search") return state.noteSelection.search;
  return null;
}

function captureSubmission(target) {
  const copy = (value) => value ? JSON.parse(JSON.stringify(value)) : null;
  return Object.freeze({
    requestId: `popup:${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`,
    target,
    type: state.type,
    noteId: target === "note:insertCurrent"
      ? state.currentNote?.noteId || ""
      : selectedNoteIdForTarget(target) || "",
    title: el("lr-new-note-title").value.trim(),
    mediaName: el("lr-media-name").value.trim(),
    destination: copy(globalThis.LuckyRayMediaDestination?.snapshot(target)),
    link: copy(state.prefillLink),
    pageTitle: state.page.title || "",
    sourceUrl: state.page.sourceUrl || state.page.url || "",
    pageUrl: state.tab?.url || state.page.url || "",
    tabId: state.tab?.id,
    folderId: state.selectedFolderId,
    newFolderName: el("lr-new-folder-name").value.trim(),
    prefill: copy(state.prefillMedia),
    videoCandidate: copy(selectedVideoCandidate()),
  });
}

function noteTargetRequest(submission) {
  const { target } = submission;
  if (target === "note:insertCurrent") return { target: "current", noteId: submission.noteId };
  if (target === "note:recent" || target === "note:search") return { target: "existing", noteId: submission.noteId };
  if (target === "note:new") return { target: "new" };
  return null;
}

async function prepareNoteBinding(submission) {
  const result = await callApi("POST", "/api/notes/capture-target", noteTargetRequest(submission));
  if (!result.ok) return result;
  const binding = result.data;
  return binding?.activation?.vaultId && Number.isInteger(binding.activation.sourceEpoch)
    ? result
    : { ok: false, errorObject: { code: "note-material-target-invalid" } };
}

async function doMedia(target, submission = captureSubmission(target)) {
  const mediaType = submission.type;
  if (state.prefillMediaInvalid) {
    showToast("右键目标已失效，请回到原标签页重新悬停后再试", true);
    return;
  }
  // FIX-1 P1-3: an explicitly picked candidate that vanished on refresh must
  // not silently commit a remaining (or hovered) video — require an explicit
  // re-pick before any write path.
  if (mediaType === "video" && state.selectionRequiresPick) {
    showToast("视频候选已变化，请重新选择要保存的视频", true);
    return;
  }
  const latest = await getPageInfoForType(mediaType, submission.tabId);
  state.page = { ...state.page, ...(latest || {}) };
  renderSource();
  // EXT-R1-R1 P1-2 + EXT-R1-REPAIR-2 contract A: the prefill is an
  // expectation, never the final authority. The fresh content-side response
  // must carry a full revalidated descriptor; the commit happens only when
  // expected and fresh identities agree on the SAME current target (strict
  // type+URL, tab/frame/document, document/target tokens, scroll, TTL) — URL
  // equality alone never authorizes a write. Any mismatch clears the prefill,
  // produces zero POST and shows a reselect reason instead of silently
  // retargeting to a sibling/current-hover candidate.
  const freshDescriptor = latest?.descriptor || null;
  const freshUrl = mediaType === "video" ? latest?.videoUrl || "" : latest?.imageUrl || "";
  const prefill = submission.prefill?.type === mediaType ? submission.prefill : null;
  if (prefill) {
    // EXT-R1-REPAIR-3 contract B: one TYPE-AWARE identity policy. The actual
    // expected/fresh descriptor types must both match the media type; image
    // and video use their own URL rules; an unbound descriptor never matches.
    if (!freshDescriptor
      || !LuckyRayExtensionProtocol.sameMediaPrefillIdentity(prefill, freshDescriptor, mediaType)
      || (mediaType === "image"
        && LuckyRayExtensionProtocol.normalizeSourcePageUrl(prefill.linkUrl)
          !== LuckyRayExtensionProtocol.normalizeSourcePageUrl(freshDescriptor.linkUrl))
      || (mediaType === "video"
        && LuckyRayExtensionProtocol.normalizeBoundWorkPageUrl(prefill.materialSourcePageUrl)
          !== LuckyRayExtensionProtocol.normalizeBoundWorkPageUrl(freshDescriptor.materialSourcePageUrl))) {
      state.prefillMedia = null;
      state.prefillMediaInvalid = false;
      showToast(freshDescriptor
        ? "右键目标已变化，请回到原标签页重新右键选择后再试"
        : "右键目标已失效，请回到原标签页重新悬停后再试", true);
      return;
    }
  }
  if (!LuckyRayExtensionProtocol.isPageSnapshotCurrent({ url: submission.pageUrl }, latest?.pageUrl)
    || submission.pageUrl !== latest?.pageUrl) {
    showToast("页面已变化，请回到页面重新采集", true);
    return;
  }
  let url = freshUrl;
  // EXT-R1-REPAIR-3 contracts A/B: the ONE video commit candidate is chosen
  // here and never rebuilt downstream. Authority order (mutually exclusive):
  //   1. a verified bound video prefill -> commit candidate built ONLY from
  //      the fresh prefill descriptor + safe page context (no list-row
  //      audio/probe/format/MIME/source may attach);
  //   2. otherwise a selected list row (explicit OR deterministic/default —
  //      the visible gate treats both as a valid selection) commits its URL
  //      and full metadata atomically; hover never replaces it;
  //   3. otherwise the fresh hover URL remains the pre-existing convenience
  //      default as a bare url-only candidate (no row metadata exists).
  let videoCommitCandidate = null;
  if (mediaType === "video") {
    if (prefill && freshDescriptor) {
      videoCommitCandidate = {
        url: freshDescriptor.url,
        kind: "direct",
        binding: "single",
        sourcePageUrl: state.page.sourceUrl || state.page.url || "",
      };
    } else {
      videoCommitCandidate = submission.videoCandidate;
      if (!videoCommitCandidate && freshUrl) {
        videoCommitCandidate = { url: freshUrl };
      }
    }
    if (videoCommitCandidate) url = videoCommitCandidate.url;
  }
  if (!url) {
    showToast(`没有识别到可收集的${mediaType === "video" ? "视频" : "图片"}`, true);
    return;
  }
  if (isUnsupportedMediaUrl(mediaType, url, videoCommitCandidate)) {
    showToast("这个视频不是可直接下载的文件。请先播放视频并刷新候选，或使用录制兜底。", true);
    return;
  }
  if (["site_page", "site-resolver"].includes(videoCommitCandidate?.kind)) {
    await resolvePopupFormats(videoCommitCandidate);
    return;
  }
  if (target === "collection:queue") {
    showToast("收集箱只做失败历史和稍后处理，请选择素材库或笔记目标。", true);
    return;
  }

  let noteBinding = null;
  if (target.startsWith("note:")) {
    const prepared = await prepareNoteBinding(submission);
    if (!prepared.ok) {
      showToast(LuckyRayExtensionProtocol.formatNoteWriteFailure(prepared), true);
      return;
    }
    noteBinding = prepared.data;
  }
  const importTarget = target.startsWith("asset:") ? target : "asset:root";
  const pageUrl = LuckyRayExtensionProtocol.normalizeSourcePageUrl(submission.pageUrl);
  const imageLink = mediaType === "image"
    ? LuckyRayExtensionProtocol.normalizeBoundWorkPageUrl(freshDescriptor?.linkUrl) : "";
  // sourcePageUrl on a video candidate is a resolver/auth input, not proof
  // that the candidate belongs to that work. Only the freshly revalidated
  // target descriptor may contribute a work-page provenance URL.
  const videoLink = mediaType === "video" && prefill && freshDescriptor
    ? LuckyRayExtensionProtocol.normalizeBoundWorkPageUrl(freshDescriptor.materialSourcePageUrl) : "";
  const boundVideoPage = videoLink && LuckyRayExtensionProtocol.normalizeSupportedVideoPageUrl(videoLink);
  const currentVideoPage = pageUrl && LuckyRayExtensionProtocol.normalizeSupportedVideoPageUrl(pageUrl);
  const sourcePage = imageLink && imageLink !== url
    ? { pageUrl: imageLink, pageKind: "work-page" }
    : boundVideoPage
      ? { pageUrl: currentVideoPage === boundVideoPage ? pageUrl : videoLink, pageKind: "work-page" }
      : pageUrl
        ? { pageUrl, pageKind: "capture-page" }
        : null;
  const imported = await importMedia(mediaType, importTarget, url, videoCommitCandidate, submission, noteBinding, sourcePage);
  // EXT-R1-REPAIR-3 contract B: a consumed prefill is cleared once its
  // identity has been used for this commit (success or failure alike) - it
  // must never authorize a second write.
  if (prefill) {
    state.prefillMedia = null;
    state.prefillMediaInvalid = false;
    clearTimeout(state.prefillExpiryTimer);
    state.prefillExpiryTimer = null;
  }
  if (!imported.ok) {
    if (imported.task) renderCaptureTask(imported.task);
    const formatted = LuckyRayExtensionProtocol.formatMaterialImportFailure(imported.errorObject || { code: imported.code }, mediaType);
    showToast(imported.code && globalThis.LuckyRayMediaImport ? LuckyRayMediaImport.message(imported.code) : formatted.message, true);
    return;
  }
  renderCaptureTask(imported.task);
  showToast(mediaType === "video" ? "视频任务已受理，完成后再确认保存结果" : "正在保存图片，关闭弹窗后任务仍会继续");
  await observeCaptureTask(imported.task.id);
}

async function doNote(target, submission = captureSubmission(target)) {
  let binding = null;
  if (target.startsWith("note:")) {
    const prepared = await prepareNoteBinding(submission);
    if (!prepared.ok) {
      showToast(LuckyRayExtensionProtocol.formatNoteWriteFailure(prepared), true);
      return;
    }
    binding = prepared.data;
  }
  const latest = await getPageInfoForType(submission.type, submission.tabId);
  if (!LuckyRayExtensionProtocol.isPageSnapshotCurrent({ url: submission.pageUrl }, latest?.url)) {
    showToast("页面已变化，请回到页面重新采集", true);
    return;
  }
  state.page = { ...state.page, ...(latest || {}) };
  const readiness = LuckyRayExtensionProtocol.pageCaptureReadiness(state.page, submission.type);
  if (submission.type === "link" && submission.link) {
    const verified = await sendMessage({ type: "luckyray-context-link-verify", context: submission.link });
    if (!verified.ok || verified.documentToken !== submission.link.documentToken) {
      if (state.prefillLink?.documentToken === submission.link.documentToken && state.prefillLink?.targetToken === submission.link.targetToken) {
        state.prefillLinkInvalid = true; renderSubmitState();
      }
      showToast("所选链接所在页面已变化，请重新右键选择", true); return;
    }
  }
  if (!readiness.ready) {
    renderPagePreview();
    showToast(readiness.code === "reload-required"
      ? "请先应用插件更新，再重新采集正文。"
      : "当前页面没有识别到正文，请选择文字或改存链接。", true);
    return;
  }
  const link = submission.type === "link" ? (submission.link
    ? LuckyRayCollectionInput.currentLink(submission.link, state.tab, latest.url)
    : { url: LuckyRayCollectionInput.linkUrl(state.page.url), title: state.page.title || state.page.url }) : null;
  if (submission.type === "link" && !link?.url) { showToast("所选链接已失效，请回网页重新右键选择", true); return; }
  const text = submission.type === "link"
    ? `${link.title}\n\n${link.url}`
    : LuckyRayExtensionProtocol.formatPageCaptureText(state.page);
  if (!text.trim()) {
    showToast("没有可收集的文字或链接内容", true);
    return;
  }
  let result;
  if (binding) {
    result = await callApi("POST", "/api/notes/capture", {
      ...noteTargetRequest(submission),
      requestId: submission.requestId,
      content: text,
      binding,
      ...(target === "note:new" ? { title: submission.title || link?.title || submission.pageTitle || "网页收集" } : {}),
    });
  } else if (target === "collection:queue") {
    result = await callApi("POST", "/api/collection", {
      type: submission.type,
      title: link?.title || state.page.title,
      url: link?.url || state.page.sourceUrl || state.page.url,
      content: text,
      source: "browser_plugin",
    });
  } else {
    result = { ok: false, error: "文字和链接只能保存到笔记或收集箱" };
  }
  if (result.ok) {
    showToast("已写入 LuckyRay");
  } else {
    showToast(LuckyRayExtensionProtocol.formatNoteWriteFailure(result), true);
  }
}

function renderRecord() {
  const statusEl = el("lr-record-status");
  const startBtn = el("lr-record-start");
  const stopBtn = el("lr-record-stop");
  const hintEl = el("lr-record-hint");
  const r = state.recording;
  statusEl.classList.remove("recording", "saving", "success", "error");
  startBtn.disabled = false;
  stopBtn.disabled = true;
  if (r.status === "recording") {
    statusEl.classList.add("recording");
    statusEl.textContent = `录制中 · ${formatElapsed(r.elapsedSec)}`;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    hintEl.textContent = "正在录制当前标签页。停止后会保存为 webm 并入库。";
  } else if (r.status === "saving") {
    statusEl.classList.add("saving");
    statusEl.textContent = "保存中";
    startBtn.disabled = true;
    stopBtn.disabled = true;
  } else if (r.status === "success") {
    statusEl.classList.add("success");
    statusEl.textContent = "已入库";
  } else if (r.status === "error") {
    statusEl.classList.add("error");
    statusEl.textContent = `失败：${r.errorMsg || "未知错误"}`;
  } else {
    statusEl.textContent = "未在录制";
    hintEl.textContent = "录制需要浏览器授权标签页音视频。适合无法直接下载的 blob、HLS 或 DRM 风险页面。";
  }
}

function formatElapsed(sec) {
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  return `${String(min).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function setRecordingStatus(status, opts) {
  state.recording.status = status;
  if (opts && opts.errorMsg) state.recording.errorMsg = opts.errorMsg;
  renderRecord();
}

function startRecordTimer(initialElapsedSec = 0) {
  stopRecordTimer();
  state.recording.elapsedSec = Math.max(0, Number(initialElapsedSec) || 0);
  state.recording.startedAt = Date.now() - state.recording.elapsedSec * 1000;
  state.recording.timerId = setInterval(() => {
    state.recording.elapsedSec = Math.floor((Date.now() - state.recording.startedAt) / 1000);
    if (state.recording.status === "recording") renderRecord();
  }, 1000);
}

function stopRecordTimer() {
  if (state.recording.timerId) clearInterval(state.recording.timerId);
  state.recording.timerId = null;
}

function isRestrictedUrl(url) {
  return /^(chrome|edge|extensions|chrome-extension|about|brave|vivaldi|opera):\/\//i.test(url || "");
}

async function onRecordStart() {
  if (!state.port) {
    setRecordingStatus("error", { errorMsg: "桌面端未启动" });
    return;
  }
  if (!state.tab || !state.tab.id || isRestrictedUrl(state.tab.url)) {
    setRecordingStatus("error", { errorMsg: "当前页面不能录制" });
    return;
  }
  setRecordingStatus("recording");
  startRecordTimer();
  const resp = await sendMessage({
    type: "luckyray-record-start",
    tabId: state.tab.id,
    pageUrl: state.tab.url || "",
    pageTitle: state.page.title || state.tab.title || "",
  });
  if (!resp.ok) {
    stopRecordTimer();
    setRecordingStatus("error", { errorMsg: resp.message || "录制启动失败" });
  }
}

async function onRecordStop() {
  setRecordingStatus("saving");
  stopRecordTimer();
  const resp = await sendMessage({ type: "luckyray-record-stop" }, RECORD_STOP_TIMEOUT_MS);
  if (resp.ok) {
    setRecordingStatus("success");
    showToast(resp.disposition === "duplicate"
      ? `该录制素材已存在${resp.assetName ? `：${resp.assetName}` : ""}`
      : (resp.assetName ? `录制已入库：${resp.assetName}` : "录制已入库"));
    if (resp.sourcePageUnsupported) showToast("当前桌面版不支持保存作品页链接；录制素材仍已保存。", true);
  } else {
    setRecordingStatus("error", { errorMsg: resp.message || "保存失败" });
  }
}

function bindEvents() {
  const openCapture = async (mode, fallback = false) => {
    const response = await sendMessage({ type: "luckyray-capture-open", mode, fallback, tabId: state.tab?.id, returnCategory: state.type });
    if (response.ok) window.close();
    else {
      el("lr-capture-error").hidden = false;
      el("lr-capture-fallback").dataset.mode = mode;
    }
  };
  el("lr-article-open").addEventListener("click", () => openCapture("article"));
  el("lr-screenshot-open").addEventListener("click", () => openCapture("visible"));
  el("lr-capture-fallback").addEventListener("click", () => openCapture(el("lr-capture-fallback").dataset.mode || (state.type === "text" ? "article" : "visible"), true));
  document.querySelectorAll(".lr-type").forEach((button) => {
    button.addEventListener("click", async () => {
      void chrome.storage.local.set({ luckyrayPopupCategoryV1: button.dataset.type }).catch(() => {});
      if (state.type === button.dataset.type) {
        state.categoryChosen = true; renderTypeSelection(); renderPagePreview(); return;
      }
      state.type = button.dataset.type;
      state.categoryChosen = true;
      renderTypeSelection();
      state.prefillMedia = null;
      state.prefillLink = null;
      state.prefillLinkInvalid = false;
      state.prefillMediaInvalid = false;
      clearTimeout(state.prefillExpiryTimer);
      state.prefillExpiryTimer = null;
      el("lr-target").value = defaultTargetForType(state.type);
      renderTargetOptions();
      renderVideoCandidates();
      renderPagePreview();
      renderQuickCollect();
      renderSubmitState();
      if (state.type === "video") await refreshVideoCandidates();
      if (state.type === "audio") await globalThis.LuckyRayAudioPopup.refresh();
    });
  });
  const toggleAdvanced = () => {
    state.advancedCollapsed = !state.advancedCollapsed;
    applyAdvancedCollapsed();
  };
  el("lr-more-options").addEventListener("click", toggleAdvanced);
  const qc = el("lr-qc");
  if (qc) {
    qc.addEventListener("click", toggleAdvanced);
    qc.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleAdvanced();
      }
    });
  }
  el("lr-target").addEventListener("change", () => {
    renderTargetSub();
    renderQuickCollect();
    renderSubmitState();
  });
  el("lr-note-q").addEventListener("input", () => {
    if (state.searchTimer) clearTimeout(state.searchTimer);
    // Synchronous invalidation (FIX-2 P1): the visible query has changed, so
    // the previous search selection must not remain submittable during the
    // 250ms debounce window. Only the network search/render is debounced.
    if (el("lr-note-q").value.trim() !== state.searchSelectionQuery) {
      state.noteSelection.search = null;
      state.searchSelectionQuery = "";
      renderSubmitState();
    }
    state.searchTimer = setTimeout(renderSearch, 250);
  });
  el("lr-video-refresh").addEventListener("click", refreshVideoCandidates);
  el("lr-submit").addEventListener("click", onSubmit);
  el("lr-record-start").addEventListener("click", onRecordStart);
  el("lr-record-stop").addEventListener("click", onRecordStop);
  el("lr-reload-extension").addEventListener("click", () => chrome.runtime.reload());
}

async function applyPrefill() {
  if (!chrome.storage.session?.get || !chrome.storage.session?.remove) return false;
  const stored = await chrome.storage.session.get("prefill");
  const prefill = stored && stored.prefill;
  await chrome.storage.session.remove("prefill");
  if (!prefill || !prefill.type || Date.now() - (prefill.ts || 0) > 60_000) return false;
  state.type = prefill.type;
  state.prefillLink = prefill.type === "link" && prefill.linkUrl ? prefill : null;
  state.prefillLinkInvalid = Boolean(state.prefillLink && !LuckyRayCollectionInput.currentLink(state.prefillLink, state.tab, state.page.url));
  if (prefill.collectionMode === "grid" && prefill.tabId === state.tab?.id) globalThis.LuckyRayCollectionPopup?.open();
  const descriptor = prefill.mediaDescriptor;
  state.prefillMedia = descriptor
    && descriptor.type === prefill.type
    && (!prefill.tabId || prefill.tabId === state.tab?.id)
    && LuckyRayExtensionProtocol.mediaPrefillIdentity(descriptor, prefill.type)
    ? descriptor : null;
  state.prefillMediaInvalid = Boolean(prefill.mediaDescriptor && !state.prefillMedia);
  clearTimeout(state.prefillExpiryTimer);
  state.prefillExpiryTimer = null;
  if (state.prefillMedia) {
    const expiresIn = Math.max(0, Number(state.prefillMedia.capturedAt) + LuckyRayExtensionProtocol.CONTEXT_TTL_MS - Date.now());
    state.prefillExpiryTimer = setTimeout(() => {
      if (state.prefillMedia && !LuckyRayExtensionProtocol.mediaPrefillIdentity(state.prefillMedia, state.type)) {
        state.prefillMediaInvalid = true;
        renderSubmitState();
      }
    }, expiresIn + 1);
  }
  renderTypeSelection();
  const targetByMode = {
    root: "asset:root",
    pickFolder: "asset:pick",
    newFolder: "asset:newFolder",
    append: "note:recent",
    newNote: "note:new",
    insertCurrent: "note:insertCurrent",
  };
  const policy = LuckyRayExtensionProtocol.buildCaptureTargetPolicy(state.type, {
    hasCurrentNote: Boolean(state.currentNote?.noteId),
    hasRecentNotes: state.recentNotes.length > 0,
  });
  const requestedTarget = targetByMode[prefill.mode];
  el("lr-target").value = policy.allowedTargets.includes(requestedTarget)
    ? requestedTarget
    : policy.defaultTarget;
  renderQuickCollect();
  const hint = el("lr-prefill-hint");
  hint.textContent = "已按右键菜单预选内容类型和目标";
  hint.style.display = "block";
  setTimeout(() => { hint.style.display = "none"; }, 2200);
  return true;
}

async function loadConnectedData() {
  if (!state.port) return;
  const [folders, recent] = await Promise.all([callApi("GET", "/api/folders"), callApi("GET", "/api/notes/recent")]);
  if (folders.ok) state.folders = folders.data && folders.data.folders ? folders.data.folders : [];
  if (recent.ok) {
    state.recentNotes = recent.data && recent.data.notes ? recent.data.notes : [];
    // Deterministic recent-note default, kept mode-scoped and visibly marked
    // selected by renderRecent (FIX-1 P1: it never leaks into note:search).
    if (!state.noteSelection.recent && state.recentNotes.length) {
      state.noteSelection.recent = state.recentNotes[0].id;
    }
  }
  renderTargetOptions();
}

async function ensurePage() {
  const returned = await readCaptureReturn();
  if (returned && !state.categoryChosen) {
    state.type = returned.category;
    renderTypeSelection();
    el("lr-target").value = defaultTargetForType(state.type);
  }
  let connection;
  try {
    connection = await getConnectionState();
  } catch (_) {
    connection = { port: null, code: "host-unavailable" };
  }
  applyConnectionState(connection);
  renderConnectionChoices();
  const offlineText = connection.code === "app-unavailable"
    ? "请打开 LuckyRay"
    : connection.code === "host-not-installed"
      ? "连接组件未安装"
      : connection.code === "host-unavailable"
        ? "连接组件无响应"
      : connection.code === "protocol-incompatible"
        ? "版本不兼容"
        : connection.code === "verification-unavailable"
          ? "本地服务验证失败"
        : connection.code === "multiple-instances"
          ? "检测到多个 LuckyRay，请选择"
        : connection.code === "connection-selection-stale"
          ? "已选连接不可用，请重新选择"
          : "未连接";
  const diagnostic = typeof connection.diagnostic === "string" && /^native-(host|channel)-[a-z-]+$/.test(connection.diagnostic)
    ? ` · ${connection.diagnostic}`
    : "";
  setStatus(state.port ? "已连接" : offlineText, state.port ? "connected" : "error");
  el("lr-status").title = diagnostic ? `重新检查连接${diagnostic}` : "重新检查 LuckyRay 连接";

  const [pageResult, currentNoteResult] = await Promise.allSettled([getPageInfo(), getCurrentNote()]);
  if (pageResult.status === "fulfilled") state.page = pageResult.value || state.page;
  if (currentNoteResult.status === "fulfilled") state.currentNote = currentNoteResult.value;
  const recordingStatus = await getRecordingStatus();
  if (recordingStatus.active && recordingStatus.tabId === state.tab?.id) {
    state.recording.status = "recording";
    startRecordTimer(recordingStatus.elapsedSec);
  }
  renderSource();
  renderCurrentNote();
  await loadConnectedData();
  const returnCategory = returned?.tabId === state.tab?.id && returned?.pageUrl === state.tab?.url ? returned.category : null;
  const appliedPrefill = !state.categoryChosen && !returnCategory && await applyPrefill();
  if (returnCategory && !state.categoryChosen) state.type = returnCategory;
  else if (!appliedPrefill && !state.categoryChosen) {
    const saved = await chrome.storage.local.get("luckyrayPopupCategoryV1").catch(() => ({}));
    if (!state.categoryChosen) state.type = ["image", "video", "audio", "text", "link"].includes(saved.luckyrayPopupCategoryV1)
      ? saved.luckyrayPopupCategoryV1 : LuckyRayExtensionProtocol.choosePopupCaptureType(state.page);
  }
  if (!appliedPrefill) {
    renderTypeSelection();
    el("lr-target").value = defaultTargetForType(state.type);
  }
  renderPagePreview();
  renderTargetOptions();
  renderQuickCollect();
  renderRecord();
  renderSubmitState();
  if (state.type === "video") await refreshVideoCandidates();
  if (state.type === "audio") await globalThis.LuckyRayAudioPopup.refresh();
}

async function onSubmit() {
  if (!state.port) {
    showToast("LuckyRay 未连接，先打开桌面端。", true);
    return;
  }
  // Final commit revalidation (FIX-2 P1): recompute the same Quick Collect
  // gate from the current DOM/state right before any write path — a stale
  // enabled button must never bypass the explicit commit gate.
  const gate = quickCollectGateState();
  if (!gate.canSubmit) {
    renderSubmitState();
    showToast(gate.reason || "当前状态不可保存", true);
    return;
  }
  state.submitting = true;
  renderSubmitState();
  try {
    const target = el("lr-target").value;
    const submission = captureSubmission(target);
    if (globalThis.LuckyRayCollectionPopup?.isGrid()) { await globalThis.LuckyRayCollectionPopup.submit(submission); return; }
    if (submission.type === "audio") {
      await globalThis.LuckyRayAudioPopup.submit(submission);
    } else if (submission.type === "image" || submission.type === "video") {
      await doMedia(target, submission);
    } else {
      await doNote(target, submission);
    }
  } catch (e) {
    showToast(`执行失败：${e && e.message ? e.message : String(e)}`, true);
  } finally {
    state.submitting = false;
    renderSubmitState();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  // Measure natural content independently of the scroll viewport, so short
  // pages shrink again after a long category. Body fits the browser's actual
  // available height; this bounded intrinsic request never sets its viewport.
  const main = document.querySelector(".lr-main"), content = document.querySelector(".lr-scroll-content");
  const fixed = [".lr-header", ".lr-source-line", ".lr-footer"].map(selector => document.querySelector(selector));
  const fit = () => {
    const style = getComputedStyle(main);
    const natural = content.getBoundingClientRect().height + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      + fixed.reduce((height, node) => height + node.getBoundingClientRect().height, 0);
    document.documentElement.style.setProperty("--popup-height", `${Math.min(640, Math.ceil(natural))}px`);
  };
  const layoutObserver = new ResizeObserver(fit);
  [content, ...fixed].forEach(node => layoutObserver.observe(node));
  fit();
  applyAdvancedCollapsed();
  bindEvents();
  ensurePage().then(observeCaptureTask);
  el("lr-status").addEventListener("click", async () => {
    const connection = await getConnectionState();
    applyConnectionState(connection);
    renderConnectionChoices();
    setStatus(state.port ? "已连接" : (connection.code === "multiple-instances" || connection.code === "connection-selection-stale" ? "请选择 LuckyRay 连接" : "未连接，点击重试"), state.port ? "connected" : "error");
    if (state.port) await loadConnectedData();
    renderSubmitState();
  });
  el("lr-capture-task-resume").addEventListener("click", async () => {
    const response = await sendMessage({ type: "luckyray-capture-task", action: "resume", id: state.captureTask?.id });
    if (response.ok) { renderCaptureTask(response.task); await observeCaptureTask(response.task.id); }
  });
  el("lr-capture-task-ack").addEventListener("click", async () => {
    const response = await sendMessage({ type: "luckyray-capture-task", action: "acknowledge", id: state.captureTask?.id });
    if (response.ok) renderCaptureTask(response.task);
  });
});
globalThis.LuckyRayAppearance?.bindSurface(document.documentElement);
