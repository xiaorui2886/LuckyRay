(function (global) {
  "use strict";
  const collection = { mode: "single", session: "", items: [], selected: new Set(), batch: null, loading: false, error: "", restored: false, busy: false };
  let timer = null, sourceKey = "", metadataPort = null, metadataAt = 0;
  const visible = () => collection.items.filter(item => LuckyRayImageCollection.matches(item, {
    width: el("lr-filter-width").value, height: el("lr-filter-height").value, format: el("lr-filter-format").value,
  }));
  const isGrid = () => state.type === "image" && collection.mode === "grid";
  const pending = () => collection.batch && !collection.batch.acknowledged;
  async function remember() {
    await chrome.storage.session.set({ luckyrayImageSelectionV1: { tabId: state.tab?.id, pageUrl: state.tab?.url,
      session: collection.session, selected: Array.from(collection.selected).slice(0, 100) } });
  }
  function gate() {
    if (pending()) return { canSubmit: false, reason: collection.batch.stage === "unknown" ? "请先核对下方保存结果" : collection.batch.stage === "running" ? "已有图片保存任务，请查看下方结果" : "请先查看本批结果，点击继续采集后再保存新图片" };
    if (!isGrid()) return null;
    const target = el("lr-target").value;
    const unresolvedTask = state.captureTask && !state.captureTask.acknowledged && !["completed", "failed"].includes(state.captureTask.stage);
    const reason = !state.port ? "请先打开 LuckyRay 桌面端" : state.submitting || collection.busy ? "正在准备保存" : unresolvedTask ? "请先处理上一项保存结果" : state.unresolvedWrite ? "保存结果待核对，请先检查桌面端"
      : !collection.selected.size ? "请选择要保存的图片" : collection.selected.size > 100 ? "每次最多保存 100 张，请减少选择"
      : [...collection.selected].some(id => !collection.items.some(item => item.id === id && item.available !== false)) ? "已选图片或作品来源已变化，请重新选择"
      : !["asset:root", "asset:pick"].includes(target) ? "批量图片请保存到已有素材文件夹；笔记追加可逐张采集"
      : target === "asset:pick" && !state.selectedFolderId ? "请选择素材文件夹" : collection.error ? collection.error : "";
    return { canSubmit: !reason, reason };
  }
  function render() {
    if (!el("lr-image-collection")) return;
    el("lr-image-collection").hidden = !isGrid();
    el("lr-image-single").setAttribute("aria-pressed", String(collection.mode === "single"));
    el("lr-image-grid-open").setAttribute("aria-pressed", String(collection.mode === "grid"));
    const media = ["image", "video", "audio"].includes(state.type);
    el("lr-media-organize").hidden = !media;
    el("lr-media-name").disabled = !["video", "audio"].includes(state.type);
    el("lr-media-boundary").textContent = state.type === "video" ? "可改保存名称。原有文件夹整理可用；多库和标签等待桌面端支持。" : "当前桌面版按原有规则命名图片；改名、多库和标签等待桌面端支持。";
    global.LuckyRayMediaDestination?.render();
    const preview = el("lr-single-preview");
    if (preview) {
      preview.hidden = state.type !== "image" || isGrid();
      const image = preview.querySelector("img"), text = preview.querySelector("span");
      const url = state.prefillMedia?.url || state.page.imageUrl || "";
      image.hidden = !url;
      if (url && image.getAttribute("src") !== url) image.src = url;
      if (!url) image.removeAttribute("src");
      text.textContent = url ? "保存网页原图 · 也可切换到网页图片" : "在网页右键选择原图，或打开“网页图片”多选";
    }
    const items = visible(), grid = el("lr-image-grid"), current = new Map(Array.from(grid.querySelectorAll("[data-candidate-id]"), node => [node.dataset.candidateId, node]));
    for (const item of items) {
      let button = current.get(item.id);
      if (!button) {
        button = document.createElement("button"); button.type = "button"; button.className = "lr-image-card"; button.dataset.candidateId = item.id;
        const image = document.createElement("img"); image.alt = ""; image.loading = "lazy"; image.referrerPolicy = "no-referrer"; if (item.previewUrl) image.src = item.previewUrl;
        const check = document.createElement("span"); check.className = "lr-image-check"; check.textContent = "✓";
        const name = document.createElement("strong"), size = document.createElement("span"); size.className = "lr-image-size";
        button.append(image, check, name, size);
        button.addEventListener("click", () => {
          if (collection.busy || pending() || !collection.items.some(current => current.id === item.id && current.available !== false)) return;
          if (collection.selected.has(item.id)) collection.selected.delete(item.id);
          else if (collection.selected.size < 100) collection.selected.add(item.id);
          else { showToast("每次最多选择 100 张图片", true); return; }
          remember().catch(() => {}); render(); renderSubmitState();
        });
        grid.append(button);
      }
      current.delete(item.id); button.hidden = false;
      const previewImage = button.querySelector("img"); previewImage.hidden = !item.previewUrl;
      if (item.previewUrl && previewImage.getAttribute("src") !== item.previewUrl) previewImage.src = item.previewUrl;
      const name = item.title || LuckyRayImageCollection.suggestedName(state.page.title, item.url, collection.items.indexOf(item) + 1);
      button.querySelector("strong").textContent = name; button.title = name;
      button.querySelector(".lr-image-size").textContent = `${item.width && item.height ? `${item.width} × ${item.height}` : "尺寸未知"} · ${item.format === "other" ? "格式未知" : item.format.toUpperCase()}`;
      button.setAttribute("aria-label", `${name}，${button.querySelector(".lr-image-size").textContent}`);
      button.setAttribute("aria-pressed", String(collection.selected.has(item.id))); button.disabled = item.available === false || collection.busy || Boolean(pending());
      if (item.available === false) button.title = "图片或来源已变化，请刷新后重新选择";
    }
    for (const button of current.values()) button.hidden = true;
    grid.querySelector(".lr-empty")?.remove();
    if (!items.length) { const empty = document.createElement("p"); empty.className = "lr-empty";
      empty.textContent = collection.error || (collection.loading ? "正在读取网页图片…" : collection.items.length ? "没有符合条件的图片，试试放宽筛选。" : "暂未发现图片。滚动网页加载后，再点击刷新。"); grid.append(empty); }
    const hiddenSelected = collection.selected.size - items.filter(item => collection.selected.has(item.id)).length;
    el("lr-images-count").textContent = `${items.length} 张可见 · 已选 ${collection.selected.size}${hiddenSelected ? `（${hiddenSelected} 张被筛选隐藏）` : ""}`;
    el("lr-images-hint").textContent = collection.capped ? "已到本次读取上限。已选图片保留，可分批保存。" : "滚动网页后，新图片会继续加入。尺寸来自已加载图片，格式按图片地址识别。";
    el("lr-images-select").disabled = collection.busy || Boolean(pending()); el("lr-images-clear").disabled = collection.busy || Boolean(pending());
  }
  async function refresh(rescan = false) {
    if (!isGrid() || collection.loading || !state.tab?.id) return;
    const key = `${state.tab.id}:${state.tab.url}`;
    collection.loading = true;
    const response = await sendMessage({ type: "luckyray-popup-images", tabId: state.tab.id, pageUrl: state.tab.url, rescan: rescan === true });
    collection.loading = false;
    if (key !== `${state.tab?.id}:${state.tab?.url}`) return;
    if (!response.ok) collection.error = "页面已变化或暂时无法读取，请回网页重新打开采集。";
    else {
      collection.error = "";
      if (collection.session && collection.session !== response.session) collection.selected.clear();
      collection.session = response.session; collection.items = response.candidates || []; collection.capped = response.capped; collection.loading = response.pending;
      if (!collection.restored) {
        collection.restored = true;
        const saved = (await chrome.storage.session.get("luckyrayImageSelectionV1")).luckyrayImageSelectionV1;
        if (saved?.tabId === state.tab.id && saved.pageUrl === state.tab.url && saved.session === response.session)
          for (const id of saved.selected || []) if (collection.items.some(item => item.id === id && item.available !== false)) collection.selected.add(id);
      }
      for (const id of collection.selected) if (!collection.items.some(item => item.id === id && item.available !== false)) collection.selected.delete(id);
      await remember();
    }
    render(); renderSubmitState(); collection.loading = false;
  }
  async function open() { state.type = "image"; state.categoryChosen = true; collection.mode = "grid"; renderTypeSelection(); renderQuickCollect(); renderSubmitState(); await refresh(); }
  async function submit(submission) {
    if (collection.busy) return;
    // onSubmit has acquired the shared UI gate. Snapshot selection once.
    const items = collection.items.filter(item => collection.selected.has(item.id));
    if (!items.length || items.length > 100 || items.length !== collection.selected.size
      || !["asset:root", "asset:pick"].includes(submission.target)) { showToast("请重新检查已选图片和保存位置", true); return; }
    collection.busy = true; render();
    try {
      const result = await sendMessage({ type: "luckyray-image-batch", action: "start", input: {
        source: { tabId: submission.tabId, pageUrl: submission.pageUrl, session: collection.session },
        target: { mode: submission.target, folderId: submission.folderId,
          ...(submission.destination ? { destination: submission.destination, namePrefix: submission.mediaName } : {}) },
        items: items.map((item, index) => ({ id: item.id, url: item.url, binding: item.binding, name: item.title || LuckyRayImageCollection.suggestedName(submission.pageTitle, item.url, index + 1) })),
      } });
      if (result.batch) renderBatch(result.batch);
      if (!result.ok) { await observeBatch(); showToast("尚未确认新任务，请查看保存结果。", true); }
      else showToast("已开始保存，关闭弹窗后任务仍会继续");
    } finally { collection.busy = false; render(); renderSubmitState(); }
  }
  function renderBatch(batch) {
    collection.batch = batch;
    const panel = el("lr-batch-result"); panel.hidden = !batch || batch.acknowledged;
    if (panel.hidden) return;
    const count = stateName => batch.items.filter(item => item.state === stateName).length;
    el("lr-batch-caption").textContent = ({ running: "正在保存图片", completed: "图片已处理", partial: count("failed") ? "部分图片未保存" : "图片已保存，部分整理待完成", unknown: "有图片的保存结果待核对", paused: "已暂停后续图片" })[batch.stage] || "图片保存结果";
    if (batch.stage === "running" && batch.stopRequested) el("lr-batch-caption").textContent = "正在处理当前图片，随后暂停";
    el("lr-batch-summary").textContent = `${count("saved") + count("saved-partial")} 张已保存 · ${count("duplicate")} 张已存在 · ${count("failed")} 张失败${count("saved-partial") ? ` · ${count("saved-partial")} 张整理未完成，请在桌面端检查` : ""}${count("queued") ? ` · ${count("queued")} 张未开始` : ""}${count("unknown") ? ` · ${count("unknown")} 张待核对。请先在 LuckyRay 中核对；不会重新保存待核对图片。` : ""}`;
    const canCheck = batch.stage === "unknown" && Boolean(batch.target?.destination?.libraryId);
    const labels = { queued: "未开始", saving: "保存中", saved: "已保存", "saved-partial": "已保存，整理待完成", duplicate: "已存在", failed: "未保存", unknown: canCheck ? "保存结果待核对" : "请到桌面端核对" };
    el("lr-batch-items").replaceChildren(...batch.items.map(item => {
      const row = document.createElement("li"), name = document.createElement("span"), result = document.createElement("strong");
      name.textContent = item.asset?.name || item.name; result.textContent = labels[item.state];
      if (item.state === "failed" && item.errorCode === "capture-target-changed") result.textContent = "图片已变化，未保存";
      row.append(name, result); row.dataset.state = item.state; return row;
    }));
    el("lr-batch-stop").hidden = batch.stage !== "running" || batch.stopRequested;
    el("lr-batch-resume").hidden = batch.stage !== "paused" && !canCheck;
    el("lr-batch-resume").textContent = canCheck ? "核对原保存结果" : "继续未开始的图片";
    el("lr-batch-retry").hidden = batch.stage !== "partial" || !count("failed");
    el("lr-batch-continue").hidden = batch.stage === "running";
    el("lr-batch-continue").textContent = batch.stage === "unknown" ? "已在桌面核对，开始新采集" : batch.stage === "paused" ? "结束本批，继续采集" : "继续采集";
    el("lr-batch-continue").title = "开始新采集；本批未开始或待核对的图片不会重新提交";
    // The batch owns this single-task observer; avoid exposing contradictory actions.
    el("lr-capture-task").style.display = "none"; el("lr-transfer-progress").style.display = "none";
    renderSubmitState();
  }
  async function observeBatch() {
    const result = await sendMessage({ type: "luckyray-image-batch", action: "status" });
    if (result.ok) renderBatch(result.batch);
  }
  async function action(actionName) {
    if (collection.busy) return;
    collection.busy = true;
    try {
      const response = await sendMessage({ type: "luckyray-image-batch", action: actionName, id: collection.batch?.id,
        confirmed: actionName === "acknowledge" && collection.batch?.stage === "unknown" });
      if (response.ok) {
        renderBatch(response.batch);
        if (actionName === "acknowledge") {
          collection.selected.clear(); await remember();
          const current = await sendMessage({ type: "luckyray-capture-task", action: "status" });
          if (current.ok) renderCaptureTask(current.task);
        }
      } else showToast("任务状态已变化，请查看最新结果", true);
    } finally { collection.busy = false; render(); renderSubmitState(); }
  }
  async function metadata() {
    if (global.LuckyRayMediaDestination) return global.LuckyRayMediaDestination.refresh();
    if (!state.port || (metadataPort === state.port && Date.now() - metadataAt < 15000)) return;
    metadataPort = state.port; metadataAt = Date.now();
    const result = await callApi("GET", "/api/material-libraries");
    const data = result.data, legacy = data?.libraries?.find(library => library.libraryId === data.legacyLibraryId);
    if (result.ok && legacy) el("lr-media-library").textContent = legacy.name || "桌面默认素材库";
  }
  document.addEventListener("DOMContentLoaded", () => {
    const preview = document.createElement("div"); preview.id = "lr-single-preview"; preview.className = "lr-single-preview";
    const image = document.createElement("img"); image.alt = "所选网页图片预览"; image.referrerPolicy = "no-referrer";
    const text = document.createElement("span"); preview.append(image, text); el("lr-image-entry").append(preview);
    // Keep the destination and save action together, below the one scroll area.
    document.querySelector(".lr-footer").prepend(el("lr-qc"));
    el("lr-image-grid-open").addEventListener("click", open);
    el("lr-image-single").addEventListener("click", () => { collection.mode = "single"; render(); renderSubmitState(); });
    el("lr-images-refresh").addEventListener("click", () => refresh(true));
    for (const id of ["lr-filter-width", "lr-filter-height", "lr-filter-format"]) el(id).addEventListener("input", () => { render(); renderSubmitState(); });
    el("lr-images-select").addEventListener("click", () => { if (pending() || collection.busy) return; for (const item of visible()) if (item.available !== false && collection.selected.size < 100) collection.selected.add(item.id); remember().catch(() => {}); render(); renderSubmitState(); });
    el("lr-images-clear").addEventListener("click", () => { if (pending()) return; collection.selected.clear(); remember().catch(() => {}); render(); renderSubmitState(); });
    el("lr-image-grid").addEventListener("keydown", event => {
      if (event.isComposing || event.keyCode === 229 || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      const buttons = Array.from(el("lr-image-grid").querySelectorAll("button:not([hidden])")), index = buttons.indexOf(event.target);
      if (index < 0) return;
      const columns = getComputedStyle(el("lr-image-grid")).gridTemplateColumns.split(" ").length;
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key];
      const next = buttons[index + step]; if (next) { event.preventDefault(); next.focus(); }
    });
    for (const [id, name] of [["lr-batch-stop", "stop"], ["lr-batch-resume", "resume"], ["lr-batch-retry", "retry"], ["lr-batch-continue", "acknowledge"]]) el(id).addEventListener("click", () => action(name));
    el("lr-shortcuts-open").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") }));
    timer = setInterval(async () => {
      if (document.hidden) return;
      const key = `${state.tab?.id}:${state.tab?.url}`;
      if (sourceKey && sourceKey !== key) { collection.items = []; collection.selected.clear(); collection.session = ""; collection.restored = false; }
      sourceKey = key;
      await refresh(); await observeBatch(); await metadata();
    }, 1500);
    observeBatch(); render();
  });
  addEventListener("pagehide", () => clearInterval(timer), { once: true });
  global.LuckyRayCollectionPopup = { render, gate, open, isGrid, submit };
})(globalThis);
