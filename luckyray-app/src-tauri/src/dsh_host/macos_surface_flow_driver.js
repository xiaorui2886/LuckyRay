// Fixed DOM dispatch in the real main WebView, not system mouse input. The
// official child WebView remains isolated; its lifecycle is observed in Rust.
(async () => {
  if (window.__LR_MACOS_LSH_SURFACE_FLOW__) return;
  window.__LR_MACOS_LSH_SURFACE_FLOW__ = true;
  let step = "choose-mode";
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (check, milliseconds = 60000) => {
    for (let n = 0; n < milliseconds / 100; n++) {
      const value = check();
      if (value) return value;
      await delay(100);
    }
    throw new Error("fixed-scenario-timeout");
  };
  const visible = selector => [...document.querySelectorAll(selector)].find(element => element.getClientRects().length > 0);
  // The LSH scenario does not depend on a fresh material-library preference.
  // WKWebView can retain settings between app launches; accept a completed
  // preference as well as the actual first-run dialog without editing storage.
  const modeAlreadyChosen = () => {
    try {
      const settings = JSON.parse(window.localStorage.getItem("luckyray-settings-v1") || "{}");
      return settings["materials.importModePromptSeen"] === true
        && ["managed", "linked", "source"].includes(settings["materials.importMode"]);
    } catch { return false; }
  };
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  const report = failed => invoke("macos_lsh_surface_flow_report", { report: { step, failed } });
  const attached = () => document.querySelector('.dsh-native-surface-layout[data-lsh-attached="true"]');
  try {
    step = "mode-shell";
    await wait(() => visible('[data-control-id="ai"]') && visible('[data-control-id="materials"]'));
    step = "mode-route";
    // A fresh preference only shows its dialog after MaterialsPage mounts.
    if (!visible(".material-import-mode-modal") && !modeAlreadyChosen()) {
      visible('[data-control-id="materials"]').click();
    }
    step = "mode-wait";
    const initial = await wait(() => {
      const chooser = visible(".material-import-mode-modal");
      return chooser ? { chooser } : modeAlreadyChosen() ? { chooser: null } : null;
    });
    if (initial.chooser) {
      step = "mode-choices";
      const firstChoice = await wait(() => {
        const choices = visible(".material-import-mode-modal")?.querySelectorAll(".import-mode-options button");
        return choices?.length === 3 && choices[0].getClientRects().length ? choices[0] : null;
      });
      firstChoice.click();
      step = "mode-dismiss";
      await wait(() => !visible(".material-import-mode-modal") && modeAlreadyChosen());
    }
    step = "open";
    (await wait(() => visible('[data-control-id="ai"]'))).click();
    await wait(attached, 600000);
    step = "attached";
    await report(false);
    (await wait(() => visible('[data-control-id="materials"]'))).click();
    step = "hidden";
    await report(false); // Actual successful native hide, not a DOM visibility guess.
    (await wait(() => visible('[data-control-id="ai"]'))).click();
    await wait(attached);
    step = "reshown";
    await report(false); // Same authenticated host/carrier binding is required.
    await delay(15000); // The worker captures this app's window before normal quit.
    await invoke("close_window"); // Existing IME/editor barrier and official save/stop.
  } catch {
    try { await report(true); } catch { /* The bounded worker reports failure and cancels. */ }
  }
})();
