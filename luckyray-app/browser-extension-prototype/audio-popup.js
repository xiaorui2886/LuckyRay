(function (global) {
  "use strict";
  const audio = { candidates: [], selected: "", explicit: false, documentToken: "", loading: false, generation: 0, error: "" };
  function render() {
    el("lr-audio-section").hidden = state.type !== "audio";
    const list = el("lr-audio-candidates");
    list.replaceChildren(...audio.candidates.map(item => {
      const button = document.createElement("button"), icon = document.createElement("i"), copy = document.createElement("span"), name = document.createElement("strong"), detail = document.createElement("small");
      button.type = "button"; button.className = "lr-audio-item"; button.disabled = !item.importable;
      button.setAttribute("aria-pressed", String(item.url === audio.selected));
      icon.dataset.lrIcon = "audio"; icon.setAttribute("aria-hidden", "true"); copy.className = "lr-audio-copy";
      const parsed = new URL(item.url);
      try { name.textContent = decodeURIComponent(parsed.pathname.split("/").pop() || "网页音频"); } catch (_) { name.textContent = "网页音频"; }
      detail.textContent = item.importable ? `${item.format.toUpperCase()} · ${parsed.hostname}` : LuckyRayAudioCollection.message(item.reason);
      copy.append(name, detail); button.append(icon, copy);
      button.addEventListener("click", () => { audio.selected = item.url; audio.explicit = true; render(); renderSubmitState(); });
      return button;
    }));
    el("lr-audio-refresh").disabled = audio.loading;
    el("lr-audio-state").textContent = audio.loading ? "正在读取音频…" : audio.error
      || (audio.candidates.length ? "选择音频后保存，只有桌面确认入库才算成功。" : "未发现音频。可先在网页播放，再刷新。");
  }
  async function refresh() {
    const generation = ++audio.generation;
    audio.loading = true; audio.error = ""; render(); renderSubmitState();
    const result = await sendMessage({ type: "luckyray-popup-get-audio-candidates", tabId: state.tab?.id, pageUrl: state.tab?.url });
    if (generation !== audio.generation) return;
    audio.loading = false;
    audio.candidates = result.ok ? result.candidates || [] : [];
    audio.documentToken = result.documentToken || "";
    if (!audio.candidates.some(item => item.url === audio.selected && item.importable)) {
      audio.selected = audio.explicit ? "" : audio.candidates.find(item => item.importable)?.url || "";
    }
    if (!result.ok) audio.error = "此页音频暂时无法读取，请刷新网页后重试。";
    render(); renderSubmitState();
  }
  function gate() {
    if (!state.port) return { canSubmit: false, reason: "请打开 LuckyRay" };
    if (audio.loading) return { canSubmit: false, reason: "正在读取音频" };
    if (!audio.candidates.some(item => item.importable && item.url === audio.selected)) return { canSubmit: false, reason: audio.error || "请选择可保存的 MP3 / WAV 音频" };
    const target = el("lr-target").value;
    if (!["asset:root", "asset:pick", "asset:newFolder"].includes(target)) return { canSubmit: false, reason: "音频请保存到素材库" };
    return { canSubmit: target !== "asset:pick" || Boolean(state.selectedFolderId), reason: "请先选择素材文件夹" };
  }
  async function submit(submission) {
    const candidate = audio.candidates.find(item => item.url === audio.selected && item.importable);
    if (!candidate) { showToast("音频选择已失效，请刷新后重新选择。", true); return; }
    const extension = candidate.format;
    const base = submission.mediaName || (() => { try { return decodeURIComponent(new URL(candidate.url).pathname.split("/").pop() || "网页音频").replace(/\.(mp3|wav)$/i, ""); } catch (_) { return "网页音频"; } })();
    const fileName = `${base.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_").slice(0, 80).replace(/[. ]+$/g, "") || "网页音频"}.${extension}`;
    const request = { requestId: submission.requestId, url: candidate.url, fileName, mimeType: candidate.contentType };
    if (submission.target === "asset:pick") request.targetFolderId = submission.folderId;
    if (submission.target === "asset:newFolder") request.newFolderName = submission.newFolderName || `来自 ${submission.pageTitle || "网页"}`;
    const accepted = await sendMessage({ type: "luckyray-capture-task", action: "start", input: {
      kind: "audio", request, tabId: submission.tabId, pageUrl: submission.pageUrl, documentToken: audio.documentToken,
      sourceUrl: submission.sourceUrl, destination: submission.destination, mediaName: fileName, fallbackName: submission.pageTitle,
    } }, 25000);
    if (!accepted.ok) { showToast(accepted.code === "audio-source-changed" ? "页面或音频已变化，请刷新后重新选择。" : LuckyRayMediaImport.message(accepted.code), true); return; }
    renderCaptureTask(accepted.task);
    void observeCaptureTask(accepted.task.id);
  }
  global.LuckyRayAudioPopup = { refresh, render, gate, submit };
  document.addEventListener("DOMContentLoaded", () => {
    el("lr-audio-refresh").addEventListener("click", refresh);
    const linkMode = enabled => {
      state.type = enabled ? "link" : "text"; state.categoryChosen = true;
      void chrome.storage.local.set({ luckyrayPopupCategoryV1: state.type }).catch(() => {});
      renderTypeSelection(); renderPagePreview(); renderTargetOptions(); renderQuickCollect(); renderSubmitState();
      if (enabled) requestAnimationFrame(() => el("lr-link-details").scrollIntoView({ block: "nearest" }));
    };
    el("lr-add-link").addEventListener("click", () => linkMode(state.type !== "link"));
    el("lr-remove-link").addEventListener("click", () => linkMode(false));
    const toggle = el("lr-video-overlays");
    const dispose = LuckyRayVideoOverlayPreference.subscribe(value => { toggle.checked = value; toggle.disabled = false; });
    window.addEventListener("pagehide", dispose, { once: true });
    toggle.addEventListener("change", async () => {
      toggle.disabled = true;
      try { await LuckyRayVideoOverlayPreference.set(toggle.checked); }
      catch (_) { toggle.checked = !toggle.checked; showToast("设置未保存，请重试。", true); }
      finally { toggle.disabled = false; }
    });
    el("lr-capture-task-cancel").addEventListener("click", async () => {
      const result = await sendMessage({ type: "luckyray-capture-task", action: "cancel", id: state.captureTask?.id });
      if (!result.ok) showToast("取消结果尚未确认，请继续查看原任务。", true);
      void observeCaptureTask();
    });
  });
})(globalThis);
