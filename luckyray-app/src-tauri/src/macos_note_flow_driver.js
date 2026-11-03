// Fixed DOM actions in the real WKWebView. No system pointer or native picker.
(async function noteFlowDriver(config) {
  if (window.__LR_MACOS_NOTE_FLOW__) return;
  window.__LR_MACOS_NOTE_FLOW__ = true;
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = el => el && el.getClientRects().length > 0;
  const wait = async check => {
    for (let i = 0; i < 300; i++) { const value = await check(); if (value) return value; await delay(100); }
    throw new Error("fixed-note-flow-timeout");
  };
  const find = selector => [...document.querySelectorAll(selector)].find(visible);
  const click = async selector => (await wait(() => find(selector))).click();
  const set = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  };
  const note = title => [...document.querySelectorAll('[data-folder-document-id]')]
    .find(el => visible(el) && el.querySelector('.folder-document-title')?.textContent.replace(/\.(?:md|markdown)$/i, '') === title);
  const image = () => [...document.querySelectorAll('#page-notes .note-preview img')].find(el => visible(el)
    && el.complete && el.naturalWidth === 32 && el.naturalHeight === 24
    && (/^asset:/.test(el.src) || /^https?:\/\/asset\.localhost(?:[:/]|$)/.test(el.src)));
  const checkpoint = stage => wait(() => invoke("macos_note_flow_checkpoint", { stage }));
  const openMoved = async () => {
    const chevron = await wait(() => find('[data-folder-id="Moved"] .folder-chevron'));
    if (!chevron.classList.contains("open")) chevron.click();
    (await wait(() => note("Synthetic"))).click();
  };
  let previewAction = "not-entered";
  const preview = async () => {
    // This control toggles the mode. An existing preview may still be loading.
    if (find('#page-notes .note-preview')) previewAction = "already-visible";
    else { previewAction = "toggle-requested"; await click('#page-notes [data-note-action="preview"]'); }
    await wait(image);
  };
  const boundedProbe = async work => {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(work), new Promise(resolve => { timer = setTimeout(() => resolve("timeout"), 3000); })]);
    } catch { return "error"; }
    finally { clearTimeout(timer); }
  };
  const uriKind = source => !source ? "missing" : /^asset:/.test(source) ? "asset"
    : /^https?:\/\/asset\.localhost(?::[0-9]{1,5})?(?:[/?#]|$)/.test(source) ? "asset-localhost"
    : /^workspace-attachment:/.test(source) ? "workspace-attachment"
    : /^blob:/.test(source) ? "blob" : /^data:/.test(source) ? "data" : "other";
  // These probes use only the fixed synthetic fixture. Never report paths,
  // URLs, text, error messages, or arbitrary values returned by the app.
  const previewDiagnostic = async () => {
    const roots = [...document.querySelectorAll('#page-notes .note-preview')];
    const root = roots.find(visible) || roots[0];
    const controls = [...document.querySelectorAll('#page-notes [data-note-action="preview"]')];
    const images = [...document.querySelectorAll('#page-notes .note-preview img')];
    const img = images.find(visible) || images[0];
    const source = img?.src || "";
    const imageUriKind = !img ? "missing" : uriKind(source) === "missing" ? "other" : uriKind(source);
    const media = root?.querySelector('.note-media[data-kind="image"]');
    const message = media?.querySelector('.note-media-status')?.textContent?.trim();
    const mediaState = !media ? "missing" : message === "图片加载中" ? "loading"
      : message === "图片读取失败，可打开引用检查文件" ? "error"
      : message === "媒体源不可用，可打开素材检查文件" ? "unavailable"
      : message ? "other" : "no-status";
    const dimension = value => Number.isInteger(value) && value >= 0 && value <= 32768 ? value : 0;
    const dom = { action: previewAction, syntheticRowActive: !!note("Synthetic")?.classList.contains("active"),
      controlPresent: controls.length > 0, controlVisible: controls.some(visible),
      previewPresent: roots.length > 0, previewVisible: roots.some(visible), missingAsset: !!root?.querySelector('.note-preview-asset-link.missing'),
      mediaState, imagePresent: !!img, imageVisible: !!visible(img), imageComplete: !!img?.complete,
      width: dimension(img?.naturalWidth), height: dimension(img?.naturalHeight), uriKind: imageUriKind };
    let resolved = null, reconstructedUriKind = "missing";
    const resolve = boundedProbe(async () => {
      const result = await invoke("knowledge_resolve_attachment", { documentRef: { vaultId: "synthetic-macos-notes-flow", relativePath: "Synthetic.md" },
        destination: "attachments/note-flow.png", wiki: false });
      if (result?.status === "resolved") {
        if (result.relativePath !== "attachments/note-flow.png") return "resolved-other";
        resolved = result;return "resolved-fixture";
      }
      return ["missing", "ambiguous"].includes(result?.status) ? result.status : "other";
    });
    // Separately reconstruct the same synthetic asset URL the notes page uses.
    // This is a probe after the failure, not the URL observed by the UI.
    const reconstructed = (async () => {
      if (await resolve !== "resolved-fixture" || typeof resolved?.absolutePath !== "string" || !resolved.absolutePath) return "not-run";
      return boundedProbe(async () => {
        if (typeof window.__TAURI_INTERNALS__.convertFileSrc !== "function") return "unsupported";
        const converted = window.__TAURI_INTERNALS__.convertFileSrc(resolved.absolutePath, "asset");
        if (typeof converted !== "string" || !converted) return "error";
        reconstructedUriKind = uriKind(converted);
        if (!["asset", "asset-localhost"].includes(reconstructedUriKind)) return "unexpected-uri";
        const source = `${converted}?vault=${encodeURIComponent("synthetic-macos-notes-flow")}&v=${encodeURIComponent(resolved.version || "")}`;
        const probe = new Image();
        if (typeof probe.decode !== "function") return "unsupported";
        probe.src = source;await probe.decode();
        return probe.naturalWidth === 32 && probe.naturalHeight === 24 ? "passed" : "wrong-size";
      });
    })();
    const decode = (async () => {
      let url;
      try { return await boundedProbe(async () => {
        const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAYAAACbU/80AAAAPklEQVR42mP4EOX2nxKsO+0DRZhh1AGjDhh1wKgDRh0w4A6w2dL0nxL8dZ8NRXjUAaMOGHXAqANGHTDgDgAAuIv4agXNJmAAAAAASUVORK5CYII="), c => c.charCodeAt(0));
        url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
        const probe = new Image();
        if (typeof probe.decode !== "function") return "unsupported";
        probe.src = url; await probe.decode();
        return probe.naturalWidth === 32 && probe.naturalHeight === 24 ? "passed" : "wrong-size";
      }); } finally { if (url) URL.revokeObjectURL(url); }
    })();
    const [resolution, fixtureDecode, reconstructedAssetDecode] = await Promise.all([resolve, decode, reconstructed]);
    return { ...dom, resolution, fixtureDecode, reconstructedUriKind, reconstructedAssetDecode };
  };
  const refreshTree = async () => {
    await click('#page-notes .notes-vault-entry');
    await click('[data-note-action="refresh-vault"]');
    await click('.notes-vault-dialog .editorial-dialog-close, .notes-vault-dialog-react .editorial-dialog-close, .notes-index-popover-header .editorial-dialog-close');
  };
  let step = "setup";
  const uiFlags = Array(config.phase === "exercise" ? 7 : 3).fill(false);
  const report = (passed, previewObservation = null) => invoke("macos_note_flow_report", { report: { phase: config.phase, step, passed, uiFlags, previewObservation } });
  try {
    if (config.phase === "exercise") {
      const chooser = await wait(() => find('.material-import-mode-modal'));
      const choices = chooser.querySelectorAll('.import-mode-options button');
      if (choices.length !== 3) throw new Error("fixed-note-profile-invalid");
      choices[0].click(); await wait(() => !find('.material-import-mode-modal'));
    } else if (find('.material-import-mode-modal')) throw new Error("fixed-note-profile-not-persisted");
    await click('[data-control-id="notes"]');
    const root = await wait(() => find('#page-notes'));
    await wait(() => find('#page-notes .notes-vault-title')?.textContent === "Synthetic notes flow");
    if (config.phase === "exercise") {
      await click('#page-notes .notes-vault-settings');
      const policy = await wait(() => {
        const select = find('.attachment-handling-control select');return select && !select.disabled ? select : null;
      });
      set(policy, 'copy'); await wait(() => policy.value === 'copy' && !policy.disabled);
      await click('.notes-index-popover-header .editorial-dialog-close');
      step = "import";
      // Existing React browser-drop -> classify -> actual import transaction.
      // Paths are two fixed source leaves, admitted by the Rust context.
      const transfer = new DataTransfer();
      for (const path of config.sourcePaths) {
        const file = new File([], path.split('/').pop(), { type: "text/markdown" });
        Object.defineProperty(file, "path", { value: path }); transfer.items.add(file);
      }
      root.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
      await wait(() => note("Synthetic") && note("Delete")); await checkpoint("imported"); uiFlags[0] = true;
      (await wait(() => note("Synthetic"))).click();
      step = "preview"; await preview(); uiFlags[1] = true;
      step = "save"; await click('#page-notes [data-note-action="source"]');
      const editor = await wait(() => find('#page-notes .note-content-area textarea'));
      if (!editor.value.includes("note-flow.png")) throw new Error("fixed-note-source-invalid");
      set(editor, editor.value + "\nSaved by the native note flow.\n");
      await delay(0); editor.focus();
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", metaKey: true, bubbles: true, cancelable: true }));
      await wait(() => ['已保存', 'Saved'].includes(find('#page-notes .editor-status-center')?.textContent.trim()));
      await checkpoint("saved"); uiFlags[2] = true;
      step = "move";
      (await wait(() => note("Synthetic"))).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 180, clientY: 180 }));
      await click('[data-note-action="move"]'); await click('[data-note-move-target="Moved"]');
      await checkpoint("moved"); await openMoved(); await preview(); uiFlags[3] = true;
      step = "delete";
      (await wait(() => note("Delete"))).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 180, clientY: 180 }));
      await click('[data-note-action="delete"]'); await click('[data-note-action="confirm-delete"]');
      await checkpoint("deleted"); await wait(() => !note("Delete")); uiFlags[4] = true;
      step = "conflict";
      // The sole test mutation creates one new foreign inode at the now-empty
      // fixed Delete.md path. It never changes a product result or grants restore.
      if (!await invoke("macos_note_flow_checkpoint", { stage: "install-conflict" })) throw new Error("fixed-note-conflict-invalid");
      await click('#page-notes .notes-vault-settings');
      const panel = await wait(() => find('[data-note-recovery="panel"]'));
      if (!panel.open) panel.querySelector('summary').click();
      await click('[data-note-recovery="refresh"]');
      const records = await wait(() => {
        const select = find('[data-note-recovery="records"]');
        const option = [...select?.options || []].find(option => option.textContent.includes(' · Delete.md · '));
        return option ? { select, option } : null;
      });
      set(records.select, records.option.value);
      const versions = await wait(() => {
        const select = find('[data-note-recovery="versions"]');
        return [...select?.options || []].some(option => option.value === 'retained') ? select : null;
      });
      set(versions, 'retained');
      await wait(() => find('[data-note-recovery="restore"]')?.disabled === true
        && find('[data-note-recovery="restore-unavailable"]') && find('[data-note-recovery="copy"]')?.disabled === false);
      await checkpoint("conflict-observed"); uiFlags[5] = true;
      step = "recover";
      set(await wait(() => find('[data-note-recovery="destination"]')), "Delete-recovered.md");
      await click('[data-note-recovery="copy"]');
      await wait(() => find('[data-note-recovery="status"]')?.textContent.startsWith('已另存：'));
      await checkpoint("recovered");
      await click('.notes-index-popover-header .editorial-dialog-close'); await refreshTree();
      (await wait(() => note("Delete-recovered"))).click();
      await click('#page-notes [data-note-action="source"]');
      await wait(() => find('#page-notes .note-content-area textarea')?.value.includes("Synthetic delete.")); uiFlags[6] = true;
      await openMoved(); await preview();
    } else {
      step = "reopen"; await openMoved();
      await click('#page-notes [data-note-action="source"]');
      await wait(() => find('#page-notes .note-content-area textarea')?.value.includes("Saved by the native note flow.")); uiFlags[0] = true;
      await preview(); uiFlags[1] = true;
      await wait(() => note("Delete-recovered") && note("Delete")); uiFlags[2] = true;
      await checkpoint("reopened");
    }
    await report(true);
  } catch {
    let observation = null;
    if (step === "preview") { try { observation = await previewDiagnostic(); } catch { /* The failure record remains authoritative. */ } }
    try { await report(false, observation); } catch { /* Observer rejects missing/invalid records. */ }
  }
  await delay(12000); // Capture only this synthetic application window.
  await invoke("close_window"); // Actual draft/IME/save and normal service drain.
})
