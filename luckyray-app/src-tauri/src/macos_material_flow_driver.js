// Fixed scenario in the application's real WKWebView. DOM dispatch is not
// operating-system pointer input or a native file-picker interaction.
(async function materialFlowDriver(config) {
  if (window.__LR_MACOS_MATERIAL_FLOW_STARTED__) return;
  window.__LR_MACOS_MATERIAL_FLOW_STARTED__ = true;
  let step = config.phase === "import" ? "choose-mode" : "reopen-mode";
  let assetId = null;
  let modeSaved = false;
  let previewDecoded = false;
  let importDispatched = false;
  let workspaceTarget = "unscoped";
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
  const imageObservation = image => ({
    present: !!image, complete: image?.complete === true,
    width: Math.min(32768, Math.max(0, image?.naturalWidth || 0)),
    height: Math.min(32768, Math.max(0, image?.naturalHeight || 0)),
    visible: !!image?.getClientRects().length,
    uriKind: !image ? "missing" : /^asset:/.test(image.src) ? "asset"
      : /^https?:\/\/asset\.localhost(?:[:/]|$)/.test(image.src) ? "asset-localhost" : "other",
  });
  // Fixed booleans/counts only: never expose paths, image URLs, dialog text or
  // arbitrary backend errors. These observations cannot make a failed UI pass.
  const domObservation = () => {
    const cards = document.querySelectorAll("[data-asset-id]");
    const readiness = window.__LUCKYRAY_BRIDGE_READINESS__;
    return { importDispatched, workspaceTarget,
      bridgeInstalled: !!window.__LUCKYRAY__,
      databaseState: !readiness ? "unknown" : readiness.error ? "failed"
        : readiness.databaseReady === true ? "ready" : "pending",
      cardCount: Math.min(2, cards.length),
      dialogPresent: !!document.querySelector('[role="dialog"], [role="alertdialog"]'),
      thumbnail: imageObservation(cards[0]?.querySelector("img")),
      preview: imageObservation(document.querySelector(".material-viewer-react.preview .qp-media-stage-react img")),
    };
  };
  const report = status => window.__TAURI_INTERNALS__.invoke("macos_material_flow_report", {
    report: { phase: config.phase, status, step, assetId, modeSaved, previewDecoded, dom: domObservation() },
  });
  try {
    if (config.phase === "import") {
      const chooser = await waitFor(() => document.querySelector(".material-import-mode-modal"));
      const owner = chooser.closest?.(".workspace-material-page");
      const workspaceViewId = owner?.id?.startsWith("page-materials-") ? owner.id.slice("page-materials-".length) : null;
      workspaceTarget = workspaceViewId ? "scoped" : "unscoped";
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
      importDispatched = true;
    } else {
      await waitFor(savedMode);
      modeSaved = true;
    }
    step = config.phase === "import" ? "import-card" : "reopen-card";
    const card = await waitFor(() => {
      const cards = document.querySelectorAll("[data-asset-id]");
      return cards.length === 1 ? cards[0] : null;
    });
    if (document.querySelector(".material-import-mode-modal")) throw new Error("mode-not-persisted");
    assetId = card.getAttribute("data-asset-id");
    if (config.phase === "reopen" && assetId !== config.assetId) throw new Error("asset-not-persisted");
    step = config.phase === "import" ? "thumbnail" : "reopen-thumbnail";
    await waitFor(() => imageLoaded(card.querySelector("img")));
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
    await report("passed");
  } catch {
    await report("failed");
  }
  // Leave time for the runner to capture this actual window, then use the
  // ordinary application shutdown/draft barrier. Forced cleanup is not a pass.
  await delay(15000);
  await window.__TAURI_INTERNALS__.invoke("close_window");
})
