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
  const note = (title, expectedId = null) => [...document.querySelectorAll('[data-folder-document-id]')]
    .find(el => visible(el) && (!expectedId || el.getAttribute("data-folder-document-id") === expectedId)
      && el.querySelector('.folder-document-title')?.textContent.replace(/\.(?:md|markdown)$/i, '') === title);
  let syntheticId = null;
  let selectionClickCalled = false, selectionClickReturned = false;
  let interaction = { selectionReadyEvent: false, targetHostMatched: false, clickCalled: false,
    clickReturned: false, clickEventObserved: false, previewObservedVisible: false };
  const syntheticHost = () => {
    const row = note("Synthetic", syntheticId);
    if (!syntheticId || !row?.classList.contains("active") || row.getAttribute("data-folder-document-id") !== syntheticId) return null;
    return [...document.querySelectorAll('#page-notes [data-notes-view-document]')]
      .find(el => !el.hidden && visible(el) && el.getAttribute("data-notes-view-document") === syntheticId) || null;
  };
  const inSyntheticHost = selector => [...syntheticHost()?.querySelectorAll(selector) || []].find(visible);
  const image = () => [...syntheticHost()?.querySelectorAll('.note-preview img') || []].find(el => visible(el)
    && el.complete && el.naturalWidth === 32 && el.naturalHeight === 24
    && (/^asset:/.test(el.src) || /^https?:\/\/asset\.localhost(?:[:/]|$)/.test(el.src)));
  const checkpoint = stage => wait(() => invoke("macos_note_flow_checkpoint", { stage }));
  const selectSynthetic = async (expectedId = null) => {
    selectionClickCalled = false; selectionClickReturned = false;
    const row = await wait(() => note("Synthetic", expectedId));
    const id = row.getAttribute("data-folder-document-id");
    if (!id) throw new Error("fixed-note-selection-invalid");
    syntheticId = id;
    interaction = { selectionReadyEvent: false, targetHostMatched: false, clickCalled: false,
      clickReturned: false, clickEventObserved: false, previewObservedVisible: false };
    const onReady = event => { if (event?.detail?.noteId === id) interaction.selectionReadyEvent = true; };
    window.addEventListener("luckyray:notes-active-note", onReady);
    try {
      const current = note("Synthetic", id);
      if (!current || current.getAttribute("data-folder-document-id") !== id) throw new Error("fixed-note-selection-changed");
      selectionClickCalled = true; current.click(); selectionClickReturned = true;
      await wait(() => interaction.selectionReadyEvent && syntheticHost());
      // The event follows the real document read; let React commit its state,
      // then recheck that the visible host still belongs to the selected row.
      await delay(0);
      await wait(() => syntheticHost());
      interaction.targetHostMatched = true;
    } finally { window.removeEventListener("luckyray:notes-active-note", onReady); }
  };
  const openMoved = async () => {
    if (step === "move") moveStage = "open-folder";
    const chevron = await wait(() => find('[data-folder-id="Moved"] .folder-chevron'));
    if (!chevron.classList.contains("open")) chevron.click();
    if (step === "move") moveStage = "select-moved";
    // The disk checkpoint may finish before the tree replaces the old row.
    // Wait for the exact destination instead of clicking the stale source.
    await selectSynthetic("real-vault:Moved/Synthetic.md");
  };
  const renameInTree = async (title, id, nextTitle, restoring) => {
    moveStage = restoring ? "restore-menu" : "rename-menu";
    (await wait(() => note(title, id))).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 180, clientY: 180 }));
    await click('[data-note-action="rename"]');
    moveStage = restoring ? "restore-input" : "rename-input";
    const input = await wait(() => find('.folder-inline-rename-input'));
    set(input, nextTitle);
    await delay(0);
    const nextId = `real-vault:Moved/${nextTitle}.md`;
    let ready = false;
    const onReady = event => { if (event?.detail?.noteId === nextId) ready = true; };
    window.addEventListener("luckyray:notes-active-note", onReady);
    try {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
      moveStage = restoring ? "restore-checkpoint" : "rename-checkpoint";
      await checkpoint(restoring ? "rename-restored" : "renamed");
      await wait(() => ready && note(nextTitle, nextId));
      await delay(0);
    } finally { window.removeEventListener("luckyray:notes-active-note", onReady); }
  };
  let previewAction = "not-entered";
  const preview = async () => {
    // This control toggles the mode. An existing preview may still be loading.
    if (inSyntheticHost('.note-preview')) previewAction = "already-visible";
    else {
      previewAction = "toggle-requested";
      await wait(() => {
        const control = inSyntheticHost('[data-note-action="preview"]');
        if (!control) return false;
        const onClick = event => { if (event.target === control) interaction.clickEventObserved = true; };
        window.addEventListener("click", onClick, true);
        try { interaction.clickCalled = true; control.click(); interaction.clickReturned = true; }
        finally { window.removeEventListener("click", onClick, true); }
        return true;
      });
    }
    await wait(() => { if (inSyntheticHost('.note-preview')) interaction.previewObservedVisible = true; return image(); });
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
    return { ...dom, resolution, fixtureDecode, reconstructedUriKind, reconstructedAssetDecode, interaction: { ...interaction } };
  };
  const refreshTree = async () => {
    recoveryStage = "refresh-open";
    await click('#page-notes .notes-vault-entry');
    recoveryStage = "refresh-action";
    await click('[data-note-action="refresh-vault"]');
    recoveryStage = "refresh-close";
    await click('.notes-vault-dialog .editorial-dialog-close, .notes-vault-dialog-react .editorial-dialog-close, .notes-index-popover-header .editorial-dialog-close');
  };
  let step = "setup";
  let moveStage = "context-menu";
  let deleteStage = "context-menu";
  let importStage = "close-settings";
  let recoveryStage = "destination";
  let folderStage = "not-entered";
  let recoverySelectionCalled = false, recoverySelectionReturned = false, recoverySelectionReady = false;
  let transferCreated = false, filesAdded = false, dropDispatched = false, dropDefaultPrevented = false;
  const uiFlags = Array(config.phase === "exercise" ? 15 : 6).fill(false);
  // A layout box does not prove that an element is visible or received input.
  const moveDiagnostic = () => {
    const chevron = find('[data-folder-id="Moved"] .folder-chevron');
    const rows = [...document.querySelectorAll('[data-folder-document-id]')];
    const rowVisible = id => rows.some(row => visible(row) && row.getAttribute("data-folder-document-id") === id);
    const destinationId = "real-vault:Moved/Synthetic.md";
    const destinationRow = note("Synthetic", destinationId);
    const destinationHostVisible = [...document.querySelectorAll('#page-notes [data-notes-view-document]')]
      .some(el => !el.hidden && visible(el) && el.getAttribute("data-notes-view-document") === destinationId);
    const selectingDestination = syntheticId === destinationId;
    return { stage: moveStage, syntheticRowHasBox: !!note("Synthetic"), moveActionHasBox: !!find('[data-note-action="move"]'),
      moveTargetHasBox: !!find('[data-note-move-target="Moved"]'), movedChevronHasBox: !!chevron,
      movedChevronOpen: !!chevron?.classList.contains("open"), originalRowHasBox: rowVisible("real-vault:Synthetic.md"),
      movedRowHasBox: rowVisible(destinationId), selectionClickCalled: selectingDestination && selectionClickCalled,
      selectionClickReturned: selectingDestination && selectionClickReturned,
      selectionReadyEvent: selectingDestination && interaction.selectionReadyEvent,
      destinationRowActive: !!destinationRow?.classList.contains("active"), destinationHostVisible };
  };
  const deleteDiagnostic = () => ({ stage: deleteStage, deleteRowHasBox: !!note("Delete"),
    deleteActionHasBox: !!find('[data-note-action="delete"]'), confirmHasBox: !!find('[data-note-action="confirm-delete"]') });
  const importDiagnostic = () => ({ stage: importStage, rootHasBox: !!find('#page-notes'),
    syntheticRowHasBox: !!note("Synthetic"), deleteRowHasBox: !!note("Delete"),
    transferCreated, filesAdded, dropDispatched, dropDefaultPrevented });
  const recoveredId = "real-vault:Delete-recovered.md";
  const recoveredHost = () => {
    const row = note("Delete-recovered", recoveredId);
    if (!row?.classList.contains("active")) return null;
    return [...document.querySelectorAll('#page-notes [data-notes-view-document]')]
      .find(el => !el.hidden && visible(el) && el.getAttribute("data-notes-view-document") === recoveredId) || null;
  };
  const inRecoveredHost = selector => [...recoveredHost()?.querySelectorAll(selector) || []].find(visible);
  const recoveryDiagnostic = () => {
    const row = note("Delete-recovered", recoveredId), host = recoveredHost();
    const textarea = inRecoveredHost('.note-content-area textarea');
    return { stage: recoveryStage, selectionClickCalled: recoverySelectionCalled, selectionClickReturned: recoverySelectionReturned,
      selectionReadyEvent: recoverySelectionReady, recoveredRowHasBox: !!row, recoveredRowActive: !!row?.classList.contains("active"),
      recoveredHostVisible: !!host, sourceControlHasBox: !!inRecoveredHost('[data-note-action="source"]'),
      sourceTextareaHasBox: !!textarea, recoveredContentVerified: !!textarea?.value.includes("Synthetic delete.") };
  };
  const folderRow = path => find(`[data-folder-id="${path}"]`);
  const openFolder = async path => {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const row = await wait(() => folderRow(parts.slice(0, i).join('/')));
      const chevron = row.querySelector('.folder-chevron');
      if (chevron && !chevron.classList.contains('open')) chevron.click();
    }
  };
  const folderHost = path => [...document.querySelectorAll('#page-notes [data-notes-view-document]')]
    .find(el => !el.hidden && visible(el) && el.getAttribute('data-notes-view-document') === `real-vault:${path}/FolderNote.md`);
  const selectFolderNote = async path => {
    await openFolder(path);
    (await wait(() => note('FolderNote', `real-vault:${path}/FolderNote.md`))).click();
    const host = await wait(() => folderHost(path));
    const control = [...host.querySelectorAll('[data-note-action="source"]')].find(visible);
    if (!control) throw new Error('fixed-folder-source-unavailable');
    if (!control.classList.contains('active')) control.click();
    return wait(() => [...folderHost(path)?.querySelectorAll('.note-content-area textarea') || []].find(visible));
  };
  const folderContext = async path => {
    (await wait(() => folderRow(path))).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 180, clientY: 180 }));
  };
  const folderPreview = async path => {
    const host = await wait(() => folderHost(path));
    if (![...host.querySelectorAll('.note-preview')].some(visible)) {
      const control = [...host.querySelectorAll('[data-note-action="preview"]')].find(visible);
      if (!control) throw new Error('fixed-folder-preview-unavailable');
      control.click();
    }
    await wait(() => [...folderHost(path)?.querySelectorAll('.note-preview img') || []].some(el => visible(el)
      && el.complete && el.naturalWidth === 32 && el.naturalHeight === 24
      && (/^asset:/.test(el.src) || /^https?:\/\/asset\.localhost(?:[:/]|$)/.test(el.src))));
  };
  const graphFlow = async () => {
    folderStage = 'graph-open';
    await click('[data-control-id="graph"]');
    const pane = await wait(() => find('.graph-pane.active'));
    folderStage = 'graph-canvas';
    await wait(() => {
      const canvas = pane.querySelector('.graph-canvas');
      if (!canvas || !visible(canvas) || canvas.width < 1 || canvas.height < 1 || pane.querySelector('.graph-status')) return false;
      const context = canvas.getContext('2d');
      if (!context) return false;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data, colors = new Set();
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3]) colors.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
        if (colors.size >= 3) return true;
      }
      return false;
    });
    if (config.phase === 'exercise') uiFlags[12] = true;
    folderStage = 'graph-search';
    if (!pane.querySelector('.graph-side-panel.open')) pane.querySelector('.graph-side-toggle')?.click();
    const search = await wait(() => [...pane.querySelectorAll('.graph-node-finder input')].find(visible));
    set(search, 'FolderNote');
    const result = await wait(() => [...pane.querySelectorAll('.graph-find-result')].find(el => visible(el)
      && el.querySelector('small')?.textContent.trim() === 'Destination/Renamed/FolderNote.md'));
    if ([...pane.querySelectorAll('.graph-find-result small')].some(el => /^(Folder|Renamed)\//.test(el.textContent.trim())))
      throw new Error('fixed-graph-stale-folder-path');
    folderStage = 'graph-select';
    result.click();
    await wait(() => pane.querySelector('.graph-search-scope')?.textContent.includes('FolderNote'));
    pane.querySelector('.graph-search-scope button')?.click();
    pane.querySelector('.graph-side-close')?.click();
    folderStage = 'return-note';
    await click('[data-control-id="notes"]');
  };
  const folderDiagnostic = failure => {
    const page = find('#page-notes'), rename = find('[data-folder-rename-id="Folder"]');
    const stage = page?.getAttribute('data-folder-operation-stage');
    const hosts = ['Folder', 'Renamed', 'Destination/Renamed'].map(folderHost).filter(Boolean);
    const recovery = find('[data-folder-recovery-panel]'), graph = find('.graph-pane.active');
    return { stage: folderStage, productStage: ['idle', 'preparing', 'ready', 'running', 'completed', 'interrupted', 'blocked-draft'].includes(stage) ? stage : 'unknown', failure,
      unsaved: page?.getAttribute('data-folder-unsaved') === 'true', savePending: page?.getAttribute('data-folder-save-pending') === 'true',
      operationPending: page?.getAttribute('data-folder-operation-pending') === 'true',
      renameActionPresent: !!find('[data-folder-action="rename"]'), renameInputPresent: !!rename, renameValueCorrect: !!rename && rename.value === 'Renamed',
      sourceFolderPresent: !!folderRow('Folder'), renamedFolderPresent: !!folderRow('Renamed'), movedFolderPresent: !!folderRow('Destination/Renamed'),
      sourceHostVisible: !!folderHost('Folder'), renamedHostVisible: !!folderHost('Renamed'), movedHostVisible: !!folderHost('Destination/Renamed'),
      renamedRowActive: !!note('FolderNote', 'real-vault:Renamed/FolderNote.md')?.classList.contains('active'),
      movedRowActive: !!note('FolderNote', 'real-vault:Destination/Renamed/FolderNote.md')?.classList.contains('active'),
      draftMarkerVisible: hosts.some(host => [...host.querySelectorAll('.note-content-area textarea')].some(el => visible(el) && el.value.includes('Unsaved folder draft preserved.'))),
      previewDecoded: hosts.some(host => [...host.querySelectorAll('.note-preview img')].some(el => visible(el) && el.complete && el.naturalWidth === 32 && el.naturalHeight === 24)),
      recoveryPanelPresent: !!recovery, restoreEnabled: !!recovery && [...recovery.querySelectorAll('[data-folder-restore]')].some(el => visible(el) && !el.disabled),
      graphPanePresent: !!graph, graphSearchNewPath: !!graph && [...graph.querySelectorAll('.graph-find-result small')].some(el => el.textContent.trim() === 'Destination/Renamed/FolderNote.md') };
  };
  const report = (passed, previewObservation = null, moveObservation = null, deleteObservation = null, importObservation = null, recoveryObservation = null, folderObservation = null) => invoke("macos_note_flow_report", { report: { phase: config.phase, step, passed, uiFlags, previewObservation, moveObservation, deleteObservation, importObservation, recoveryObservation, folderObservation } });
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
      step = "import";
      importStage = "close-settings";
      await click('.notes-index-popover-header .editorial-dialog-close');
      await wait(() => !find('.notes-index-popover-header'));
      // Existing React browser-drop -> classify -> actual import transaction.
      // Paths are two fixed source leaves, admitted by the Rust context.
      importStage = "construct-transfer";
      const transfer = new DataTransfer();
      transferCreated = true; importStage = "populate-transfer";
      for (const path of config.sourcePaths) {
        const file = new File([], path.split('/').pop(), { type: "text/markdown" });
        Object.defineProperty(file, "path", { value: path }); transfer.items.add(file);
      }
      filesAdded = true; importStage = "dispatch-drop";
      const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer });
      root.dispatchEvent(drop); dropDispatched = true; dropDefaultPrevented = drop.defaultPrevented === true;
      importStage = "wait-tree"; await wait(() => note("Synthetic") && note("Delete"));
      importStage = "checkpoint"; await checkpoint("imported"); uiFlags[0] = true;
      step = "preview"; await selectSynthetic(); await preview(); uiFlags[1] = true;
      step = "save"; await click('#page-notes [data-note-action="source"]');
      const editor = await wait(() => find('#page-notes .note-content-area textarea'));
      if (!editor.value.includes("note-flow.png")) throw new Error("fixed-note-source-invalid");
      set(editor, editor.value + "\nSaved by the native note flow.\n");
      await delay(0); editor.focus();
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", metaKey: true, bubbles: true, cancelable: true }));
      await wait(() => ['已保存', 'Saved'].includes(find('#page-notes .editor-status-center')?.textContent.trim()));
      await checkpoint("saved"); uiFlags[2] = true;
      step = "move";
      moveStage = "context-menu";
      (await wait(() => note("Synthetic"))).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 180, clientY: 180 }));
      moveStage = "move-menu"; await click('[data-note-action="move"]');
      moveStage = "destination"; await click('[data-note-move-target="Moved"]');
      moveStage = "checkpoint"; await checkpoint("moved"); await openMoved();
      moveStage = "preview-moved"; await preview();
      await renameInTree("Synthetic", "real-vault:Moved/Synthetic.md", "Renamed", false);
      await renameInTree("Renamed", "real-vault:Moved/Renamed.md", "Synthetic", true);
      await wait(() => note("Synthetic", "real-vault:Moved/Synthetic.md")); uiFlags[3] = true;
      step = "delete";
      deleteStage = "context-menu";
      (await wait(() => note("Delete"))).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 180, clientY: 180 }));
      deleteStage = "delete-menu"; await click('[data-note-action="delete"]');
      deleteStage = "confirm"; await click('[data-note-action="confirm-delete"]');
      deleteStage = "checkpoint"; await checkpoint("deleted");
      deleteStage = "tree-update"; await wait(() => !note("Delete")); uiFlags[4] = true;
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
      recoveryStage = "destination";
      set(await wait(() => find('[data-note-recovery="destination"]')), "Delete-recovered.md");
      recoveryStage = "copy";
      await click('[data-note-recovery="copy"]');
      recoveryStage = "copy-status";
      await wait(() => find('[data-note-recovery="status"]')?.textContent.startsWith('已另存：'));
      recoveryStage = "checkpoint";
      await checkpoint("recovered");
      recoveryStage = "close-recovery";
      await click('.notes-index-popover-header .editorial-dialog-close'); await refreshTree();
      recoveryStage = "select-recovered";
      const onRecoveryReady = event => { if (event?.detail?.noteId === recoveredId) recoverySelectionReady = true; };
      window.addEventListener("luckyray:notes-active-note", onRecoveryReady);
      try {
        const row = await wait(() => note("Delete-recovered", recoveredId));
        recoverySelectionCalled = true; row.click(); recoverySelectionReturned = true;
        await wait(() => recoverySelectionReady && recoveredHost());
        await delay(0); await wait(() => recoveredHost());
      } finally { window.removeEventListener("luckyray:notes-active-note", onRecoveryReady); }
      recoveryStage = "source-control";
      const sourceControl = await wait(() => inRecoveredHost('[data-note-action="source"]'));
      if (!sourceControl.classList.contains("active")) sourceControl.click();
      recoveryStage = "recovered-content";
      await wait(() => inRecoveredHost('.note-content-area textarea')?.value.includes("Synthetic delete.")); uiFlags[6] = true;
      recoveryStage = "open-moved"; await openMoved();
      recoveryStage = "preview-moved"; await preview();
      step = 'folder-dirty';
      folderStage = 'dirty-open';
      const folderEditor = await selectFolderNote('Folder');
      folderStage = 'dirty-input';
      set(folderEditor, folderEditor.value + '\nUnsaved folder draft preserved.\n');
      await wait(() => find('#page-notes')?.getAttribute('data-folder-unsaved') === 'true');
      folderStage = 'dirty-menu';
      await folderContext('Folder'); await click('[data-folder-action="rename"]');
      folderStage = 'dirty-veto';
      await wait(() => find('#page-notes')?.getAttribute('data-folder-operation-stage') === 'blocked-draft');
      if (find('[data-folder-rename-id="Folder"]') || !folderEditor.value.includes('Unsaved folder draft preserved.'))
        throw new Error('fixed-folder-draft-not-preserved');
      folderStage = 'dirty-checkpoint'; await checkpoint('folder-dirty-blocked'); uiFlags[7] = true;
      folderStage = 'save-request';
      folderEditor.focus();
      folderEditor.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', metaKey: true, bubbles: true, cancelable: true }));
      folderStage = 'save-checkpoint'; await checkpoint('folder-saved');
      folderStage = 'save-idle';
      await wait(() => {
        const page = find('#page-notes');
        return page && page.getAttribute('data-folder-unsaved') !== 'true' && page.getAttribute('data-folder-save-pending') !== 'true';
      });
      step = 'folder-rename';
      folderStage = 'rename-menu';
      await folderContext('Folder'); await click('[data-folder-action="rename"]');
      folderStage = 'rename-input';
      const rename = await wait(() => find('[data-folder-rename-id="Folder"]'));
      set(rename, 'Renamed'); await delay(0);
      folderStage = 'rename-submit';
      rename.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      folderStage = 'rename-checkpoint'; await checkpoint('folder-renamed');
      folderStage = 'rename-open'; await openFolder('Renamed');
      folderStage = 'rename-host';
      await wait(() => folderHost('Renamed') && note('FolderNote', 'real-vault:Renamed/FolderNote.md')?.classList.contains('active'));
      folderStage = 'rename-source-retired';
      if (folderHost('Folder')) throw new Error('fixed-folder-old-host-retained');
      uiFlags[8] = true;
      step = 'folder-move';
      folderStage = 'move-menu';
      await folderContext('Renamed'); await click('[data-folder-action="move"]');
      folderStage = 'move-destination';
      await click('[data-folder-move-target="Destination"]');
      folderStage = 'move-checkpoint'; await checkpoint('folder-moved');
      folderStage = 'move-open'; await openFolder('Destination/Renamed');
      folderStage = 'move-host';
      await wait(() => folderHost('Destination/Renamed') && note('FolderNote', 'real-vault:Destination/Renamed/FolderNote.md')?.classList.contains('active'));
      folderStage = 'move-source-retired';
      if (folderHost('Renamed')) throw new Error('fixed-folder-moved-host-stale');
      uiFlags[9] = true;
      folderStage = 'attachment-preview'; await folderPreview('Destination/Renamed'); uiFlags[14] = true;
      step = 'folder-delete';
      folderStage = 'delete-menu';
      await folderContext('FolderEmpty'); await click('[data-folder-action="delete"]');
      folderStage = 'delete-confirm';
      await click('[data-folder-delete-confirm="FolderEmpty"]');
      folderStage = 'delete-checkpoint'; await checkpoint('folder-deleted');
      folderStage = 'delete-tree'; await wait(() => !folderRow('FolderEmpty')); uiFlags[10] = true;
      step = 'folder-restore';
      folderStage = 'restore-panel';
      const folderRecovery = await wait(() => find('[data-folder-recovery-panel]'));
      if (!folderRecovery.open) folderRecovery.querySelector('summary')?.click();
      folderStage = 'restore-refresh'; await click('[data-folder-recovery-refresh]');
      folderStage = 'restore-action';
      const restore = await wait(() => [...folderRecovery.querySelectorAll('[data-folder-recovery-path="FolderEmpty"] [data-folder-restore]')]
        .find(el => visible(el) && !el.disabled));
      restore.click(); folderStage = 'restore-checkpoint'; await checkpoint('folder-restored');
      folderStage = 'restore-tree'; await wait(() => folderRow('FolderEmpty')); uiFlags[11] = true;
      folderRecovery.querySelector('summary')?.click();
      step = 'graph'; await graphFlow(); folderStage = 'graph-checkpoint'; await checkpoint('graph-ready'); uiFlags[13] = true;
      folderStage = 'return-note';
      await selectFolderNote('Destination/Renamed'); await folderPreview('Destination/Renamed');
    } else {
      step = "reopen"; await openMoved();
      await click('#page-notes [data-note-action="source"]');
      await wait(() => find('#page-notes .note-content-area textarea')?.value.includes("Saved by the native note flow.")); uiFlags[0] = true;
      await preview(); uiFlags[1] = true;
      await wait(() => note("Delete-recovered") && note("Delete")); uiFlags[2] = true;
      folderStage = 'reopen-note'; const folderEditor = await selectFolderNote('Destination/Renamed');
      folderStage = 'reopen-marker';
      if (!folderEditor.value.includes('Unsaved folder draft preserved.')) throw new Error('fixed-folder-reopen-draft-missing');
      folderStage = 'attachment-preview'; await folderPreview('Destination/Renamed'); uiFlags[3] = true;
      folderStage = 'reopen-folder'; await wait(() => folderRow('FolderEmpty')); uiFlags[4] = true;
      await graphFlow(); uiFlags[5] = true;
      folderStage = 'reopen-checkpoint'; await checkpoint("reopened");
      folderStage = 'return-note';
      await selectFolderNote('Destination/Renamed'); await folderPreview('Destination/Renamed');
    }
    await report(true);
  } catch (error) {
    let observation = null;
    if (step === "preview") { try { observation = await previewDiagnostic(); } catch { /* The failure record remains authoritative. */ } }
    let moveObservation = null;
    if (step === "move") { try { moveObservation = moveDiagnostic(); } catch { /* The failure record remains authoritative. */ } }
    let deleteObservation = null;
    if (step === "delete") { try { deleteObservation = deleteDiagnostic(); } catch { /* The failure record remains authoritative. */ } }
    let importObservation = null;
    if (step === "import") { try { importObservation = importDiagnostic(); } catch { /* The failure record remains authoritative. */ } }
    let recoveryObservation = null;
    if (step === "recover") { try { recoveryObservation = recoveryDiagnostic(); } catch { /* The failure record remains authoritative. */ } }
    let folderObservation = null;
    if (step.startsWith('folder-') || step === 'graph' || step === 'reopen' && folderStage !== 'not-entered') {
      const codes = { 'fixed-note-flow-timeout': 'wait-timeout', 'macos-note-flow-context-invalid': 'checkpoint-context',
        'fixed-folder-old-host-retained': 'stale-source-host', 'fixed-folder-moved-host-stale': 'stale-moved-host',
        'fixed-folder-draft-not-preserved': 'draft-not-preserved', 'fixed-folder-reopen-draft-missing': 'reopen-draft-missing', 'fixed-graph-stale-folder-path': 'graph-stale-path' };
      try { folderObservation = folderDiagnostic(Object.hasOwn(codes, error?.message) ? codes[error.message] : 'other'); } catch { /* A missing observation cannot make a failed scenario pass. */ }
    }
    try { await report(false, observation, moveObservation, deleteObservation, importObservation, recoveryObservation, folderObservation); } catch { /* Observer rejects missing/invalid records. */ }
  }
  await delay(12000); // Capture only this synthetic application window.
  await invoke("close_window"); // Actual draft/IME/save and normal service drain.
})
