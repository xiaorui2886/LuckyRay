"use strict";
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const tabId = Number(params.get("tabId"));
const inline = params.get("inline") === "1";
let draft = null, libraries = [], taxonomy = null, pollTimer = null, busy = false, pending = [], taxonomyGeneration = 0, pollDeadline = 0;
let pendingTimer = null, pendingDeadline = 0, pendingGeneration = 0;
let startFailureCode = null, showBlocked = false, pendingUnavailable = false;
let starting = false, returningToMain = false;
const panelWindow = inline ? Promise.resolve(null) : chrome.windows.getCurrent();
const errors = {
  "capture-user-invocation-required": "请回到来源网页，从 LuckyRay 扩展图标或 Alt+Shift+L 快捷键重新打开采集，以授予本次截图权限。",
  "capture-size-limit": "页面超过截图上限（4000 万像素、单边 32767 像素或 64 屏）。请使用选区或可见区。",
  "capture-bytes-limit": "截图超过 12 MB，请缩小范围后重试。",
  "capture-horizontal-page": "页面存在横向滚动，整页截图暂不支持。请使用可见区。",
  "capture-page-size-changed": "页面在采集时改变了尺寸，未生成不完整截图。请等待加载完成后重试。",
  "capture-page-changed": "来源页面已变化，请重新采集。",
  "capture-forbidden": "预览连接已失效，请从扩展入口重新打开。未重新提交保存。",
  "capture-cancelled": "已取消采集。",
  "capture-expired": "预览已过期，请重新采集。",
  "capture-zoom-unsupported": "页面使用了手势缩放，请恢复后重试；浏览器常规缩放受支持。",
  "article-size-limit": "正文超过 64 KB，请选中需要的段落后重新采集，或改存链接。",
  "no-readable-content": "没有识别到可验证的正文。可选择网页文字后重新采集，或改存链接。",
  "capture-commit-uncertain": "暂未收到保存确认，正在自动查询原请求的回执，不会重复提交截图。",
  "app-unavailable": "LuckyRay 连接暂不可用，本次保存未提交。恢复连接后重新采集即可。",
  "verification-unavailable": "暂时无法确认 LuckyRay 连接身份，本次保存未提交。请恢复连接后重试。",
  "protocol-incompatible": "LuckyRay 与插件版本不匹配，本次保存未提交。请更新匹配版本后重试。",
  "capture-busy": "另一项采集正在保存。本次没有再次提交，请稍后再试。",
  "capture-journal-unavailable": "无法记录保存状态，已停止提交。请检查扩展存储是否可用。",
  "capture-journal-full": "尚未确认的请求记录已达到本地上限，已停止新提交；原记录保留，请恢复桌面连接以自动读取结果。",
  "consumer-library-denied": "目标库未授予完整保存所需的读取和导入权限。未写入，请更换已授权目标后重新采集。",
  "consumer-organize-denied": "目标库未授权分类或标签整理。未写入，请清除分类标签后保存，或更换目标。",
  "library-unavailable": "目标库不可见或尚未就绪。未提交，请在桌面端检查后重新采集。",
  "consumer-folder-denied": "文件夹不属于目标库或未获授权。未写入，请重新采集并选择正确分类。",
  "consumer-tag-denied": "标签不属于目标库或未获授权。未写入，请重新采集并选择正确标签。",
  "consumer-input-invalid": "保存内容或字段无效，未写入。请检查标题和分类后重新采集。",
  "consumer-capture-too-large": "素材超过宿主大小上限，未写入。请缩小范围后重新采集。",
  "consumer-capture-busy": "桌面端正在处理其它截图，本次未写入。稍后重新采集。",
  "note-material-input-invalid": "笔记正文或请求字段无效，未写入。请重新采集。",
  "note-material-source-invalid": "笔记来源地址无效，未写入。请重新采集。",
  "note-material-title-invalid": "笔记标题无效，未写入。请调整标题后重新采集。",
  "note-material-target-invalid": "笔记目标无效，未写入。请在桌面端打开知识库后重新采集。",
  "knowledge-name-conflict": "同名笔记已存在，本次未写入。请重新采集并修改标题。",
  "capture-title-invalid": "标题为空、包含控制字符或超过 UTF-8 文件名长度，请缩短标题后重试。",
  "article-complexity-limit": "页面结构过于复杂，请选择需要的文字后采集，或改存来源链接。",
  "capture-time-limit": "采集超过时限，已停止并恢复页面。请缩小范围后重试。",
  "capture-library-required": "请先选择一个可导入的素材库。",
  "knowledge-target-unavailable": "知识库尚未就绪，请在 LuckyRay 中打开知识库后重试。",
  "knowledge-source-inactive": "请先在 LuckyRay 打开“知识库”并选中要保存的库，再回来采集正文。当前知识库尚未激活，不是网站不支持。",
  "knowledge-vault-required": "请先在 LuckyRay 选择或创建一个知识库，再回来采集正文。",
  "knowledge-vault-unavailable": "当前知识库目录无法访问，请在 LuckyRay 检查目录是否可用，再回来采集正文。",
  "knowledge-target-not-current": "保存目标已切换，请在 LuckyRay 确认当前知识库，再重新采集正文。",
};
function message(code) { return errors[code] || (String(code || "").includes("grant") || String(code || "").includes("forbidden") ? "当前连接尚未授权这个目标库，请在桌面端配置后重试。" : "采集暂时不可用，请检查 LuckyRay 连接后重试。"); }
function status(text, error = false) { $("status").textContent = text; $("status").classList.toggle("error", error); }
function send(payload) {
  return new Promise(resolve => {
    let done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); resolve(value || { ok: false, code: "capture-unavailable" }); };
    const timer = setTimeout(() => finish({ ok: false, code: payload.action === "restore" ? "capture-time-limit" : "capture-commit-uncertain" }), ["save", "restore"].includes(payload.action) ? 120000 : 15000);
    chrome.runtime.sendMessage(payload, response => { void chrome.runtime.lastError; finish(response); });
  });
}
function journalBlocks(mode = $("mode").value) {
  return pending.length >= 32 || pending.some(record => record.inFlight)
    || (mode === "article" && pending.some(record => record.mode === "article"));
}
function lock(value) {
  busy = value;
  for (const id of ["mode", "library"]) $(id).disabled = value;
  for (const button of document.querySelectorAll("[data-capture-mode]")) button.disabled = value;
  $("start").disabled = value;
  updateSaveGate();
}
function updateSaveGate() {
  const preview = draft?.stage === "preview";
  const ready = draft?.mode === "article" ? Boolean(draft.markdown || $("as-link").checked)
    : !draft?.materialCapabilities?.organize || taxonomy?.libraryId === draft?.libraryId;
  $("save").disabled = !preview || busy || pendingUnavailable || journalBlocks(draft?.mode) || !ready;
}
// Read-only Markdown presentation; the original capture.markdown remains the
// save payload. No HTML interpretation, URL loading, or executable attributes.
function renderArticle(markdown, title) {
  const target = $("article-preview");
  target.replaceChildren();
  const plain = text => text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "图片：$1")
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, "$1 ($2)")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => a || b)
    .replace(/\x60([^\x60]+)\x60/g, "$1");
  const lines = String(markdown).split(/\r?\n/);
  let paragraph = [], list = null, code = null, firstHeading = true;
  const append = (tag, text) => { const node = document.createElement(tag); node.textContent = text; target.append(node); return node; };
  const flush = () => { if (paragraph.length) append("p", plain(paragraph.join("\n"))); paragraph = []; list = null; };
  for (const line of lines) {
    if (/^\s*\x60{3}/.test(line)) { flush(); if (code) { append("pre", code.join("\n")); code = null; } else code = []; continue; }
    if (code) { code.push(line); continue; }
    const heading = line.match(/^(#{1,6})\s+(.+)$/), item = line.match(/^\s*([-*+] |\d+\. )(.+)$/);
    if (heading) { flush(); const text = plain(heading[2]); if (!(firstHeading && text.trim() === String(title || "").trim())) append(heading[1].length < 3 ? "h2" : "h3", text); firstHeading = false; }
    else if (item) { if (paragraph.length) flush(); const kind = /^\d/.test(item[1]) ? "ol" : "ul"; if (!list || list.tagName.toLowerCase() !== kind) list = append(kind, ""); const child = document.createElement("li"); child.textContent = plain(item[2]); list.append(child); }
    else if (/^>\s?/.test(line)) { flush(); append("blockquote", plain(line.replace(/^>\s?/, ""))); }
    else if (!line.trim()) flush();
    else { list = null; paragraph.push(line); }
  }
  flush(); if (code) append("pre", code.join("\n"));
}
async function refreshPending() {
  const generation = ++pendingGeneration;
  clearTimeout(pendingTimer);
  const hadPending = pending.length > 0;
  const result = await send({ type: "luckyray-page-draft", action: "pending" });
  if (generation !== pendingGeneration) return false;
  pendingUnavailable = !result.ok;
  $("retry-state").hidden = result.ok;
  if (!result.ok) { status("暂时无法读取保存状态，请重试。", true); lock(false); return false; }
  pending = result.pending || [];
  const automatic = pending.some(record => record.mode !== "article");
  if (automatic && !pendingDeadline) pendingDeadline = Date.now() + 120000;
  if (!pending.length) pendingDeadline = 0;
  const checking = automatic && Date.now() < pendingDeadline;
  // Historical PNG receipts stay background-only. Article recovery is offered
  // only after an explicit operation is blocked, never on initial opening.
  const blocked = (showBlocked || draft?.stage === "preview" && draft.mode === "article") && journalBlocks(draft?.mode);
  $("pending").hidden = !blocked;
  $("pending-text").textContent = blocked ? (pending.some(record => record.inFlight)
    ? "上一项还在保存，请稍候再试。"
    : pending.length >= 32 ? "暂存记录已满，请打开 LuckyRay 等待保存结果更新。"
    : "上一次正文保存结果未确认，请先在桌面核对。") : "";
  $("acknowledge").hidden = !blocked || !pending.some(record => record.mode === "article" && !record.inFlight);
  $("acknowledge").disabled = pending.some(record => record.inFlight);
  if (checking) pendingTimer = setTimeout(() => { void refreshPending(); }, 5000);
  lock(busy);
  if (draft?.stage === "preview") {
    if (!journalBlocks(draft.mode) && hadPending) render(draft);
  }
  if (result.recovered?.length) {
    const recovered = result.recovered.find(value => value.requestId === draft?.id);
    if (recovered && (draft.stage !== "saved" || (draft.journalCleanupPending && !recovered.journalCleanupPending))) {
      const state = await send({ type: "luckyray-page-draft", action: "status", id: draft.id });
      if (generation === pendingGeneration && state.draft?.stage === "saved") render(state.draft);
    }
  }
  return true;
}
function modeChanged() {
  const article = $("mode").value === "article";
  $("library-field").hidden = article;
  $("heading").textContent = article ? "正文剪藏" : "网页截图";
  document.body.dataset.kind = article ? "article" : "image";
  $("mode-field").hidden = article;
  for (const button of document.querySelectorAll("[data-capture-mode]")) button.setAttribute("aria-pressed", String(button.dataset.captureMode === $("mode").value));
  $("start").textContent = article ? "提取正文" : "开始截图";
  const hints = { article: "提取正文或已选文字，保存为笔记并保留来源。", visible: "截取当前可见区域。", region: "切回网页后拖动选区；按 Esc 取消。", element: "切回网页后点击需要的元素。", full: "截取完整网页；动态页面建议使用框选。" };
  $("mode-hint").textContent = hints[$("mode").value];
  lock(busy);
}
async function loadLibraries() {
  const result = await send({ type: "luckyray-capture-libraries" });
  $("library").replaceChildren();
  if (!result.ok || result.data?.consumerVersion !== 1 || !Array.isArray(result.data.libraries)) {
    const option = new Option("素材库连接未就绪", ""); $("library").append(option);
    if ($("mode").value !== "article") status("截图预览可在选库连接就绪后开始，请检查桌面端与库授权。", true);
    return;
  }
  libraries = result.data.libraries.filter(library => library.visible === true && library.state === "ready" && library.capabilities?.read === true && library.capabilities?.import === true);
  $("library").append(new Option("选择素材库", ""));
  for (const library of libraries) $("library").append(new Option(library.name, library.libraryId));
  if (!libraries.length) $("library").append(new Option("没有可见且就绪、已授权读取和导入的库", ""));
  // Desktop's stable legacy identity is the original default material library,
  // not its active library, list order, display name or the last-used target.
  const defaultId = result.data.legacyLibraryId;
  if (libraries.some(library => library.libraryId === defaultId)) $("library").value = defaultId;
  else if ($("mode").value !== "article") status("默认素材库不可用，请选择已授权的素材库。", true);
}
async function loadTaxonomy(captured) {
  const generation = ++taxonomyGeneration;
  $("save").disabled = true; $("retry-taxonomy").hidden = true;
  if (!captured.materialCapabilities?.organize) {
    $("folder").replaceChildren(new Option("根目录", "")); $("tags").replaceChildren();
    $("new-folder").value = ""; $("new-tags").value = "";
    taxonomy = { libraryId: captured.libraryId }; $("save").disabled = false; return;
  }
  const requestId = `popup:${crypto.randomUUID()}`;
  const result = await send({ type: "luckyray-capture-taxonomy", libraryId: captured.libraryId, requestId });
  if (draft?.id !== captured.id || draft.stage !== "preview" || generation !== taxonomyGeneration) return;
  $("folder").replaceChildren(new Option("根目录", "")); $("tags").replaceChildren(); taxonomy = null;
  if (!result.ok || result.data?.consumerVersion !== 1 || result.data?.libraryId !== captured.libraryId || result.data?.requestId !== requestId || !Array.isArray(result.data.folders) || !Array.isArray(result.data.tags)) {
    status("已完成截图预览；分类信息读取失败，请重新连接后再保存。", true); $("save").disabled = true; $("retry-taxonomy").hidden = false; return;
  }
  taxonomy = result.data;
  const folders = new Map(taxonomy.folders.map(folder => [folder.id, folder]));
  const folderLabel = folder => {
    const names = [], seen = new Set();
    for (let node = folder; node && !seen.has(node.id) && names.length < 24; node = folders.get(node.parentId)) { names.unshift(node.name); seen.add(node.id); }
    return names.join(" / ");
  };
  for (const folder of taxonomy.folders) $("folder").append(new Option(folderLabel(folder), folder.id));
  for (const tag of taxonomy.tags || []) {
    const label = document.createElement("label"), check = document.createElement("input"); check.type = "checkbox"; check.value = tag.id;
    label.append(check, document.createTextNode(tag.name)); $("tags").append(label);
  }
  if (!(taxonomy.tags || []).length) $("tags").textContent = "此库暂无标签";
  $("save").disabled = false;
}
function render(captured) {
  const samePreview = draft?.id === captured.id && $("preview").hidden === false;
  draft = captured;
  document.body.dataset.stage = captured.stage;
  $("restart").hidden = !["preview", "failed"].includes(captured.stage);
  $("restart").disabled = ["validating", "saving", "uncertain", "saved"].includes(captured.stage);
  $("save").textContent = ["saving", "validating"].includes(captured.stage) ? "保存中…" : "保存";
  try { $("source").textContent = new URL(captured.sourceUrl).hostname; } catch (_) { $("source").textContent = ""; }
  $("source").hidden = !$("source").textContent;
  if (captured.stage === "capturing") { status(captured.mode === "region" || captured.mode === "element" ? "请在来源网页选择范围；Esc 取消。" : `正在采集${captured.progress ? ` · ${captured.progress}%` : ""}`); return; }
  clearTimeout(pollTimer);
  if (["validating", "saving"].includes(captured.stage)) { status(samePreview ? "" : "保存中…"); $("save").disabled = true; return; }
  if (captured.stage === "failed") { status(message(captured.code), true); $("save").disabled = true; lock(false); return; }
  if (captured.stage === "uncertain") {
    $("start").textContent = captured.mode === "article" ? "继续剪藏" : "继续截图";
    status("暂未收到保存结果");
    $("save").disabled = true; lock(false); void refreshPending(); return;
  }
  if (captured.stage === "saved") {
    $("start").textContent = captured.mode === "article" ? "继续剪藏" : "继续截图";
    $("preview").hidden = true; $("receipt").hidden = false;
    const receipt = captured.receipt;
    $("receipt-text").textContent = "已保存";
    $("view-hint").textContent = captured.mode === "article" ? "可在 LuckyRay 知识库查看" : libraries.find(l => l.libraryId === captured.libraryId)?.name || "可在 LuckyRay 素材库查看";
    status(receipt.warning ? "部分整理未完成，可在桌面端调整。" : "");
    // Keep the confirmed receipt visible, but a new explicit Start does not
    // need a separate reset click. Old identity remains terminal/non-replayable.
    $("save").disabled = true; lock(false); void refreshPending(); return;
  }
  if (captured.stage !== "preview") return;
  $("preview").hidden = false; if (!samePreview) $("title").value = captured.title; $("save").disabled = false;
  const article = captured.mode === "article";
  $("dimensions").hidden = article;
  $("organize").hidden = article;
  if (!article && !captured.materialCapabilities?.organize) {
    $("folder").value = ""; $("new-folder").value = ""; $("new-tags").value = "";
    for (const check of $("tags").querySelectorAll("input")) check.checked = false;
  }
  $("taxonomy").hidden = article || !captured.materialCapabilities?.organize; $("new-taxonomy").hidden = article || !captured.materialCapabilities?.organize; $("organize-hint").hidden = article || !!captured.materialCapabilities?.organize; $("article-preview").hidden = !article; $("image-preview").hidden = article;
  $("destination").textContent = article ? "当前知识库 · 新笔记" : libraries.find(l => l.libraryId === captured.libraryId)?.name || "目标素材库";
  if (article) renderArticle(captured.markdown || "暂无正文预览", captured.title);
  $("image-hint").hidden = !article || !captured.images?.length;
  $("link-fallback").hidden = !article || !!captured.markdown; if (!samePreview) $("as-link").checked = false;
  if (article) { status(captured.extractionCode ? message(captured.extractionCode) : "", !!captured.extractionCode); $("save").disabled = !captured.markdown && !$("as-link").checked; }
  else { $("image-preview").src = `data:image/png;base64,${captured.bytesBase64}`; $("dimensions").textContent = `${captured.width} × ${captured.height} · ${(captured.sizeBytes / 1024 / 1024).toFixed(2)} MB`; status(""); if (!samePreview || taxonomy?.libraryId !== captured.libraryId) void loadTaxonomy(captured); }
  updateSaveGate();
}
async function poll() {
  if (!draft) return;
  const result = await send({ type: "luckyray-page-draft", action: "status", id: draft.id });
  if (!result.ok) { status(message(result.code), true); lock(false); await refreshPending(); return; }
  render(result.draft);
  if (["capturing", "validating", "saving"].includes(draft.stage)) {
    if (Date.now() < pollDeadline) pollTimer = setTimeout(poll, 500);
    else { status("仍未收到最终保存结果，原请求已保留，不会重新提交。", true); await refreshPending(); }
  }
}
$("mode").value = ["article", "visible", "region", "element", "full"].includes(params.get("mode")) ? params.get("mode") : "article";
$("mode").addEventListener("change", modeChanged);
for (const button of document.querySelectorAll("[data-capture-mode]")) button.addEventListener("click", () => {
  if (busy || starting) return;
  $("mode").value = button.dataset.captureMode; modeChanged();
  void startCapture();
});
async function startCapture() {
  if (busy || starting) return;
  // Reserve synchronously, before journal/library reads can yield. Every entry
  // shares this guard, including a double click while reconnecting.
  starting = true; lock(true);
  try {
    if (pendingUnavailable && !await refreshPending()) return;
    if (journalBlocks()) { showBlocked = true; await refreshPending(); return; }
    showBlocked = false; $("pending").hidden = true;
    if ($("mode").value !== "article" && !$("library").value) { await loadLibraries(); if (!$("library").value) return; }
    if (draft && ["capturing", "preview", "failed"].includes(draft.stage)) await send({ type: "luckyray-page-draft", action: "cancel", id: draft.id });
    draft = null; taxonomy = null; taxonomyGeneration++; startFailureCode = null;
    document.body.dataset.stage = "setup"; $("organize").open = false;
    $("preview").hidden = true; $("receipt").hidden = true; lock(true); status("正在开始采集…");
    const result = await send({ type: "luckyray-page-draft", action: "start", ...(inline ? {} : { panelWindowId: (await panelWindow).id }), input: { tabId, mode: $("mode").value, libraryId: $("library").value } });
    if (!result.ok) { startFailureCode = result.code || "capture-unavailable"; status(message(startFailureCode), true); lock(false); await refreshPending(); return; }
    pollDeadline = Date.now() + 180000;
    render(result.draft); if (draft.stage === "capturing") void poll();
  } finally {
    starting = false; lock(!!draft && ["capturing", "validating", "saving"].includes(draft.stage));
  }
}
$("start").addEventListener("click", startCapture);
$("save").addEventListener("click", async () => {
  if (!draft || draft.stage !== "preview" || $("save").disabled) return;
  if (pendingUnavailable && !await refreshPending()) return;
  if (!draft || draft.stage !== "preview" || $("save").disabled) return;
  if (journalBlocks(draft.mode)) { showBlocked = true; await refreshPending(); return; }
  draft.stage = "saving"; taxonomyGeneration++; $("restart").disabled = true; $("save").textContent = "保存中…";
  pollDeadline = Date.now() + 180000;
  document.body.dataset.stage = "saving"; $("save").disabled = true; status("");
  const result = await send({ type: "luckyray-page-draft", action: "save", id: draft.id, input: { title: $("title").value,
    folderId: $("new-folder").value.trim() ? "" : $("folder").value, newFolderName: $("new-folder").value.trim(),
    tagNames: $("new-tags").value.split(/[,，]/).map(value => value.trim()).filter(Boolean),
    tagIds: [...$("tags").querySelectorAll("input:checked")].map(node => node.value), asLink: $("as-link").checked } });
  if (result.draft) {
    render(result.draft);
    if (!result.ok && result.draft.stage === "preview") {
      status(message(result.code), true);
      if (["capture-busy", "capture-commit-uncertain"].includes(result.code)) await refreshPending();
    }
  }
  else {
    const state = await send({ type: "luckyray-page-draft", action: "status", id: draft.id });
    if (state.draft) { render(state.draft); if (["saving", "validating"].includes(state.draft.stage)) void poll(); }
    status(message(result.code), true); await refreshPending();
  }
});
$("as-link").addEventListener("change", updateSaveGate);
$("retry-state").addEventListener("click", async () => { if (await refreshPending()) status(""); });
async function closeSurface() {
  if (returningToMain) return;
  returningToMain = true;
  const result = await send({ type: "luckyray-capture-surface", action: "return-main" });
  returningToMain = false;
  if (!result.ok) { status("主页面暂时无法打开，请点扩展图标返回。当前采集与保存状态已保留。", true); return; }
  if (!inline) { returningToMain = true; window.close(); }
}
$("cancel").addEventListener("click", closeSurface);
addEventListener("keydown", event => { if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); void closeSurface(); } });
$("restart").addEventListener("click", async () => {
  if (!draft || !["preview", "failed"].includes(draft.stage)) return;
  const result = await send({ type: "luckyray-page-draft", action: "cancel", id: draft.id });
  if (!result.ok) { status(message(result.code), true); return; }
  taxonomyGeneration++; draft = null; taxonomy = null; document.body.dataset.stage = "setup"; $("restart").hidden = true; $("preview").hidden = true; $("image-preview").removeAttribute("src"); lock(false); modeChanged(); status("");
});
$("retry-taxonomy").addEventListener("click", () => { if (draft?.stage === "preview") void loadTaxonomy(draft); });
$("acknowledge").addEventListener("click", async () => {
  if (!showBlocked || $("acknowledge").hidden || $("acknowledge").disabled) return;
  $("acknowledge").disabled = true;
  for (const record of pending.filter(value => value.mode === "article" && !value.inFlight)) {
    const result = await send({ type: "luckyray-page-draft", action: "acknowledge", id: record.requestId, confirmed: true });
    if (!result.ok) { status(message(result.code), true); break; }
    if (draft?.id === record.requestId) { draft = null; $("preview").hidden = true; }
  }
  $("acknowledge").disabled = false; busy = false; await refreshPending();
  if (!journalBlocks()) { showBlocked = false; $("pending").hidden = true; document.body.dataset.stage = "setup"; modeChanged(); status(""); }
});
addEventListener("pagehide", () => { clearTimeout(pendingTimer); clearTimeout(pollTimer); pendingGeneration++; if (!returningToMain && draft && ["capturing", "preview", "failed"].includes(draft.stage)) chrome.runtime.sendMessage({ type: "luckyray-page-draft", action: "cancel", id: draft.id }); });
modeChanged(); lock(true);
void (async () => {
  if (inline) {
    const ready = await send({ type: "luckyray-capture-surface", action: "ready" });
    if (!ready.ok) { status(message(ready.code), true); return; }
    if (Number.isFinite(ready.maxHeight)) document.body.style.setProperty("--surface-limit", `${ready.maxHeight}px`);
  }
  await loadLibraries();
  if (inline) {
    const state = await send({ type: "luckyray-page-draft", action: "restore" });
    if (!state.ok) { status(message(state.code), true); return; }
    if (state.startCode) {
      startFailureCode = state.startCode; draft = null; document.body.dataset.stage = "setup";
      $("preview").hidden = true; $("receipt").hidden = true; $("restart").hidden = true;
      status(message(state.startCode), true);
    } else if (state.draft) { $("mode").value = state.draft.mode; modeChanged(); render(state.draft); pollDeadline = Date.now() + 180000; if (["capturing", "validating", "saving"].includes(draft.stage)) void poll(); }
  }
  if (await refreshPending()) lock(!!draft && ["capturing", "validating", "saving"].includes(draft.stage));
})();
globalThis.LuckyRayAppearance?.bindSurface(document.documentElement);
if (inline && globalThis.ResizeObserver) {
  let sizeTimer, lastHeight = 0;
  const reportSize = () => {
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => {
      const height = Math.ceil(document.body.getBoundingClientRect().height) + 2;
      if (Math.abs(height - lastHeight) < 2) return;
      lastHeight = height;
      void send({ type: "luckyray-capture-surface", action: "ready", height }).then(result => {
        if (result.ok && Number.isFinite(result.maxHeight)) document.body.style.setProperty("--surface-limit", `${result.maxHeight}px`);
      });
    }, 60);
  };
  new ResizeObserver(reportSize).observe(document.body);
  addEventListener("resize", () => { lastHeight = 0; reportSize(); });
}
