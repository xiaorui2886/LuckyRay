(function (global) {
  "use strict";
  const destination = { mode: "legacy", libraryId: "", supported: false, libraries: [], legacyLibraryId: "", taxonomy: null,
    status: "idle", error: "", loading: false, taxonomyLoading: false, generation: 0, lastRead: 0, port: null };
  const media = () => ["image", "video", "audio"].includes(state.type);
  const eligible = library => library.visible === true && library.state === "ready" && library.capabilities?.read === true && library.capabilities?.import === true;
  const selectedLibrary = () => destination.libraries.find(library => library.libraryId === destination.libraryId && eligible(library));
  const explicit = () => destination.mode === "explicit";
  const isolated = global.__LUCKYRAY_ISOLATED_TRANSPORT_TARGET__ || null;
  if (isolated) { destination.mode = "explicit"; destination.libraryId = isolated.defaultLibraryId; }
  const requiresLibrary = () => Boolean(isolated) || destination.supported && !destination.legacyLibraryId;
  const tags = () => [...el("lr-media-tags").querySelectorAll("input:checked")].map(node => node.value);
  const tagNames = () => el("lr-media-tag-names").value.split(/[,，]/).map(value => value.trim()).filter(Boolean);
  function gate() {
    if (!media()) return null;
    if (destination.status === "idle" || destination.loading) return { canSubmit: false, reason: "正在读取保存位置" };
    if (!explicit()) return requiresLibrary() ? { canSubmit: false, reason: "请选择素材库" } : null;
    let reason = destination.error || (!destination.supported ? "所选素材库暂不可用，请更新桌面端或重新选择保存位置" : "");
    const library = selectedLibrary(), target = el("lr-target").value;
    if (!reason && !library) reason = "所选素材库暂不可用，请重新选择保存位置";
    if (!reason && target.startsWith("note:") && destination.libraryId !== destination.legacyLibraryId) reason = "此素材库暂不支持笔记联动，请选择桌面默认素材库";
    if (!reason && destination.taxonomyLoading) reason = "正在读取所选素材库的文件夹和标签";
    if (!reason && target === "asset:pick" && !destination.taxonomy?.folders.some(folder => folder.id === state.selectedFolderId)) reason = "请在所选素材库中重新选择文件夹";
    if (!reason && library?.capabilities.organize !== true && (target !== "asset:root" && !target.startsWith("note:") || tags().length || tagNames().length)) reason = "此素材库暂不允许整理，请保存到根目录或选择其他素材库";
    const typed = el("lr-media-name").value;
    if (!reason && typed) { const code = LuckyRayMediaImport.filenameError(typed); if (code) reason = LuckyRayMediaImport.message(code); }
    return reason ? { canSubmit: false, reason } : null;
  }
  function snapshot(target) {
    if (!explicit()) return null;
    const result = { libraryId: destination.libraryId, tagIds: tags(), tagNames: tagNames() };
    if (target === "asset:pick" && state.selectedFolderId) result.folderId = state.selectedFolderId;
    if (target === "asset:newFolder") {
      result.newFolderName = el("lr-new-folder-name").value.trim();
      if (el("lr-media-parent").value) result.parentFolderId = el("lr-media-parent").value;
    }
    return JSON.parse(JSON.stringify(result));
  }
  function summary() {
    if (!media() || !explicit()) return;
    const library = selectedLibrary(), target = el("lr-target").value;
    const folder = destination.taxonomy?.folders.find(folder => folder.id === state.selectedFolderId);
    el("lr-target-summary").textContent = `${library?.name || "所选素材库"} / ${target === "asset:pick" ? folder?.name || "请选择文件夹" : target === "asset:newFolder" ? el("lr-new-folder-name").value.trim() || "新文件夹" : LuckyRayExtensionProtocol.quickCollectTargetLabel(target) || "根目录"}`;
  }
  function render() {
    if (!el("lr-media-library")) return;
    const grid = global.LuckyRayCollectionPopup?.isGrid();
    el("lr-media-name").disabled = state.type !== "video" && state.type !== "audio" && (!explicit() || !destination.supported);
    el("lr-media-name").placeholder = grid && explicit() ? "批量名称前缀，留空保留原文件名" : "默认使用原文件名或网页标题";
    el("lr-media-boundary").textContent = explicit() ? "保存时保留原格式。已存在的素材会保留原名称、文件夹和标签。" : state.type === "video" || state.type === "audio" ? "按桌面默认库保存，可改名；多库和标签需桌面端支持。" : "按桌面默认库保存；图片改名和标签需桌面端支持。";
    el("lr-media-taxonomy").hidden = !explicit();
    const organize = selectedLibrary()?.capabilities.organize === true && destination.supported;
    el("lr-media-tag-names").disabled = !organize || destination.taxonomyLoading;
    for (const input of el("lr-media-tags").querySelectorAll("input")) input.disabled = !organize || destination.taxonomyLoading;
    el("lr-media-parent-box").hidden = !explicit() || el("lr-target").value !== "asset:newFolder";
    el("lr-media-use-legacy").hidden = !explicit() || requiresLibrary();
    el("lr-media-reload").hidden = !destination.error && destination.supported;
    el("lr-media-read-status").textContent = destination.loading || destination.taxonomyLoading ? "正在读取保存位置…" : destination.error;
    if (explicit() && destination.taxonomy && state.folders !== destination.taxonomy.folders) { state.folders = destination.taxonomy.folders; renderFolders(); }
    summary();
    if (destination.status === "idle" && state.port) void refresh();
  }
  async function remember() { await chrome.storage.session.set({ luckyrayMediaDestinationV1: { mode: destination.mode, libraryId: destination.libraryId } }); }
  function renderLibraries() {
    const select = el("lr-media-library");
    select.replaceChildren(new Option("按桌面默认库保存", ""));
    if (requiresLibrary()) select.options[0].disabled = true;
    for (const library of destination.libraries.filter(eligible)) select.append(new Option(library.name || "素材库", library.libraryId));
    if (explicit() && !destination.libraries.some(library => library.libraryId === destination.libraryId && eligible(library))) select.append(new Option("所选素材库暂不可用", destination.libraryId));
    select.value = explicit() ? destination.libraryId : "";
  }
  async function taxonomy() {
    const id = destination.libraryId, generation = ++destination.generation;
    destination.taxonomy = null; destination.taxonomyLoading = true; state.selectedFolderId = null;
    el("lr-media-tags").replaceChildren(); el("lr-media-parent").replaceChildren(new Option("根目录", ""));
    if (selectedLibrary()?.capabilities.organize !== true) { destination.taxonomy = { libraryId: id, folders: [], tags: [] }; destination.taxonomyLoading = false; render(); renderSubmitState(); return; }
    render(); renderSubmitState();
    const result = await sendMessage({ type: "luckyray-media-destination", action: "taxonomy", libraryId: id }, 15000);
    if (generation !== destination.generation || id !== destination.libraryId || !explicit()) return;
    destination.taxonomyLoading = false;
    if (!result.ok || result.data?.libraryId !== id || !Array.isArray(result.data.folders) || !Array.isArray(result.data.tags)) destination.error = "文件夹和标签暂时无法读取，请重新连接后再保存";
    else {
      destination.taxonomy = result.data; destination.error = "";
      for (const tag of result.data.tags) { const label = document.createElement("label"), input = document.createElement("input"), text = document.createElement("span");
        input.type = "checkbox"; input.value = tag.id; text.textContent = tag.name; label.append(input, text); el("lr-media-tags").append(label); input.addEventListener("change", renderSubmitState); }
      if (!result.data.tags.length) el("lr-media-tags").textContent = "此库暂无标签，可在下方输入新标签";
      for (const folder of result.data.folders) el("lr-media-parent").append(new Option(folder.name, folder.id));
    }
    render(); renderSubmitState();
  }
  async function refresh(force = false) {
    if (!state.port || destination.loading || !force && destination.port === state.port && Date.now() - destination.lastRead < 15000) return;
    destination.loading = true; destination.port = state.port; destination.lastRead = Date.now(); renderSubmitState();
    const initial = destination.status === "idle";
    if (initial) { const saved = (await chrome.storage.session.get("luckyrayMediaDestinationV1")).luckyrayMediaDestinationV1;
      if (saved?.mode === "explicit" && LuckyRayMediaImport.validId(saved.libraryId)) { destination.mode = "explicit"; destination.libraryId = saved.libraryId; } }
    const result = await sendMessage({ type: "luckyray-media-destination", action: "libraries" }, 15000);
    destination.loading = false;
    if (!result.ok) { destination.status = "offline"; destination.error = explicit() ? "所选素材库暂不可用，请重新连接后再保存" : ""; destination.supported = false; }
    else if (!result.supported) { destination.status = "legacy"; destination.supported = false; destination.error = explicit() ? "当前桌面端尚不支持所选素材库，请更新后继续" : ""; }
    else {
      destination.status = "ready"; destination.supported = true; destination.error = ""; destination.libraries = result.data.libraries; destination.legacyLibraryId = result.data.legacyLibraryId;
      if (!explicit() && (initial || requiresLibrary())) {
        const available = destination.libraries.filter(eligible);
        const preferred = available.find(library => library.libraryId === destination.legacyLibraryId)
          || (!destination.legacyLibraryId && available.length === 1 ? available[0] : null);
        if (preferred || requiresLibrary()) {
          destination.mode = "explicit"; destination.libraryId = preferred?.libraryId || "";
          await remember();
        }
      }
    }
    renderLibraries();
    if (explicit() && destination.supported && (!destination.taxonomy || destination.taxonomy.libraryId !== destination.libraryId || force)) await taxonomy();
    render(); renderSubmitState();
  }
  async function useLegacy() {
    if (requiresLibrary()) { showToast("请选择获授权的素材库", true); return; }
    destination.mode = "legacy"; destination.libraryId = ""; destination.error = ""; destination.generation++; destination.taxonomyLoading = false; destination.taxonomy = null;
    el("lr-media-tag-names").value = ""; el("lr-media-tags").replaceChildren(); state.selectedFolderId = null;
    await remember(); renderLibraries(); await loadConnectedData(); render(); renderQuickCollect(); renderSubmitState();
  }
  document.addEventListener("DOMContentLoaded", () => {
    el("lr-media-library").addEventListener("change", async () => {
      const id = el("lr-media-library").value; if (!id) return useLegacy();
      destination.mode = "explicit"; destination.libraryId = id; destination.error = ""; state.selectedFolderId = null;
      el("lr-media-tag-names").value = ""; await remember(); await taxonomy(); renderQuickCollect();
    });
    el("lr-media-use-legacy").addEventListener("click", useLegacy);
    el("lr-media-reload").addEventListener("click", () => refresh(true));
    for (const id of ["lr-media-name", "lr-media-tag-names", "lr-media-parent", "lr-new-folder-name"]) el(id).addEventListener("input", () => { summary(); renderSubmitState(); });
    el("lr-target").addEventListener("change", () => { render(); renderSubmitState(); });
    render();
  });
  global.LuckyRayMediaDestination = { refresh, render, gate, snapshot, summary, explicit };
})(globalThis);
