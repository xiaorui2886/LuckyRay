// Fixed scenario in the application's real WKWebView. DOM dispatch is not
// operating-system pointer input or a native file-picker interaction.
(async function materialFlowDriver(config) {
  if (window.__LR_MACOS_MATERIAL_FLOW_STARTED__) return;
  window.__LR_MACOS_MATERIAL_FLOW_STARTED__ = true;
  let step = config.phase === "import" ? "choose-mode" : "reopen-mode";
  let assetId = null;
  let modeSaved = false;
  let previewDecoded = false;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const waitFor = async check => {
    for (let attempt = 0; attempt < 600; attempt++) {
      const result = check();
      if (result) return result;
      await delay(100);
    }
    throw new Error("fixed-scenario-timeout");
  };
  const savedMode = () => {
    try {
      const settings = JSON.parse(localStorage.getItem("luckyray-settings-v1") || "{}");
      return settings["materials.importMode"] === "managed" && settings["materials.importModePromptSeen"] === true;
    } catch { return false; }
  };
  const imageLoaded = image => image && image.complete && image.naturalWidth === 32 && image.naturalHeight === 24
    && image.getClientRects().length > 0
    && (/^asset:/.test(image.src) || /^https?:\/\/asset\.localhost(?:[:/]|$)/.test(image.src));
  try {
    if (config.phase === "import") {
      const chooser = await waitFor(() => document.querySelector(".material-import-mode-modal"));
      const owner = chooser.closest?.(".workspace-material-page");
      const workspaceViewId = owner?.id?.startsWith("page-materials-") ? owner.id.slice("page-materials-".length) : null;
      const choices = chooser.querySelectorAll(".import-mode-options button");
      if (choices.length !== 3 || savedMode()) throw new Error("profile-not-fresh");
      choices[0].click(); // Existing managed-copy onChoose handler.
      await waitFor(() => !document.querySelector(".material-import-mode-modal") && savedMode());
      modeSaved = true;
      step = "import";
      await waitFor(() => document.querySelector(".materials-empty-action-btn.primary"));
      window.dispatchEvent(new CustomEvent("luckyray:materials-native-folder-import", {
        detail: { paths: [config.sourcePath], folderId: null, ...(workspaceViewId ? { workspaceViewId } : {}) },
      })); // Existing frontend path-import handler and real Rust importer.
    } else {
      await waitFor(savedMode);
      modeSaved = true;
    }
    const card = await waitFor(() => {
      const cards = document.querySelectorAll("[data-asset-id]");
      return cards.length === 1 && imageLoaded(cards[0].querySelector("img")) ? cards[0] : null;
    });
    if (document.querySelector(".material-import-mode-modal")) throw new Error("mode-not-persisted");
    assetId = card.getAttribute("data-asset-id");
    if (config.phase === "reopen" && assetId !== config.assetId) throw new Error("asset-not-persisted");
    step = config.phase === "import" ? "preview" : "reopen-preview";
    const preview = card.querySelector(".asset-preview-fab-react");
    if (!preview) throw new Error("preview-control-missing");
    preview.click(); // Existing onPreview handler; no fabricated preview nodes.
    await waitFor(() => {
      const viewer = document.querySelector(".material-viewer-react.preview");
      return viewer?.getAttribute("data-material-native-asset") === assetId
        && imageLoaded(viewer.querySelector(".qp-media-stage-react img"));
    });
    previewDecoded = true;
    await window.__TAURI_INTERNALS__.invoke("macos_material_flow_report", {
      report: { phase: config.phase, status: "passed", step, assetId, modeSaved, previewDecoded },
    });
  } catch {
    await window.__TAURI_INTERNALS__.invoke("macos_material_flow_report", {
      report: { phase: config.phase, status: "failed", step, assetId, modeSaved, previewDecoded },
    });
  }
  // Leave time for the runner to capture this actual window, then use the
  // ordinary application shutdown/draft barrier. Forced cleanup is not a pass.
  await delay(15000);
  await window.__TAURI_INTERNALS__.invoke("close_window");
})
