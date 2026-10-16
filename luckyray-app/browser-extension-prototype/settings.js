"use strict";
LuckyRayAppearance.bindSurface(document.documentElement);
const names = { "toggle-video-overlays": "切换视频悬浮按钮", "capture-page": "正文剪藏与网页截图", "show-collector": "打开网页收集", "collect-images": "选择网页图片", "capture-visible": "截取可见区域" };
const preference = document.getElementById("video-overlays");
const unsubscribe = LuckyRayVideoOverlayPreference.subscribe(value => { preference.checked = value; preference.disabled = false; });
window.addEventListener("pagehide", unsubscribe, { once: true });
preference.addEventListener("change", async () => {
  preference.disabled = true;
  try { await LuckyRayVideoOverlayPreference.set(preference.checked); }
  catch (_) { preference.checked = !preference.checked; }
  finally { preference.disabled = false; }
});
async function refreshCommands() {
  const commands = await chrome.commands.getAll();
  document.getElementById("commands").replaceChildren(...Object.entries(names).map(([id, title]) => {
    const row = document.createElement("div"), label = document.createElement("dt"), value = document.createElement("dd");
    label.textContent = title; value.textContent = commands.find(command => command.name === id)?.shortcut || "未设置";
    row.append(label, value); return row;
  }));
}
document.getElementById("configure").addEventListener("click", () => chrome.tabs.create({ url: /Edg\//.test(navigator.userAgent) ? "edge://extensions/shortcuts" : "chrome://extensions/shortcuts" }));
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshCommands(); });
refreshCommands().catch(() => { document.getElementById("commands").textContent = "暂时无法读取快捷键，请打开浏览器设置查看。"; });
