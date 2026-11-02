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
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  const report = failed => invoke("macos_lsh_surface_flow_report", { report: { step, failed } });
  const attached = () => document.querySelector('.dsh-native-surface-layout[data-lsh-attached="true"]');
  try {
    const chooser = await wait(() => document.querySelector(".material-import-mode-modal"));
    const choices = chooser.querySelectorAll(".import-mode-options button");
    if (choices.length !== 3) throw new Error("fixed-scenario-mode-invalid");
    choices[0].click();
    await wait(() => !document.querySelector(".material-import-mode-modal"));
    step = "open";
    (await wait(() => document.querySelector('[data-control-id="ai"]'))).click();
    await wait(attached, 600000);
    step = "attached";
    await report(false);
    (await wait(() => document.querySelector('[data-control-id="materials"]'))).click();
    step = "hidden";
    await report(false); // Actual successful native hide, not a DOM visibility guess.
    (await wait(() => document.querySelector('[data-control-id="ai"]'))).click();
    await wait(attached);
    step = "reshown";
    await report(false); // Same authenticated host/carrier binding is required.
    await delay(15000); // The worker captures this app's window before normal quit.
    await invoke("close_window"); // Existing IME/editor barrier and official save/stop.
  } catch {
    try { await report(true); } catch { /* The bounded worker reports failure and cancels. */ }
  }
})();
