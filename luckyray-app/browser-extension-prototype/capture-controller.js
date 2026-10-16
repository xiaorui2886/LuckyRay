(function (global) {
  "use strict";
  const MAX_PIXELS = 40_000_000, MAX_SIDE = 32767, MAX_BYTES = 12 * 1024 * 1024;
  function titleWithin(value, limit = 216) {
    let result = "";
    for (const c of String(value || "网页采集").replace(/[\u0000-\u001f]/g, " ").trim()) {
      if (new TextEncoder().encode(result + c).length > limit) break;
      result += c;
    }
    return result;
  }
  function create({ chromeApi, page, request, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    const drafts = new Map();
    const starting = new Set();
    const capturingTabs = new Set();
    const failure = code => Object.assign(new Error(code), { code });
    async function materialLibrary(id) {
      const result = await request("GET", "/api/material-libraries");
      if (!result.ok || result.data?.consumerVersion !== 1 || !Array.isArray(result.data.libraries)) throw failure("consumer-contract-unavailable");
      const library = result.data.libraries.find(value => value.libraryId === id);
      if (!library || library.visible !== true || library.state !== "ready") throw failure("library-unavailable");
      if (library.capabilities?.read !== true || library.capabilities?.import !== true) throw failure("consumer-library-denied");
      return { read: true, import: true, organize: library.capabilities.organize === true };
    }
    function structuredRejection(result, mode) {
      // Raw errors and the versioned V1 projection must veto zero-write clearing.
      if (result.errorObject?.writeOutcome === "unknown" || result.errorObject?.error?.writeOutcome === "unknown"
        || result.errorObject?.error?.details?.writeOutcome === "unknown") return null;
      const code = result.errorObject?.error?.code || result.errorObject?.code;
      // This flag comes from the local auth adapter, not an HTTP error body.
      // Control failure before business dispatch is definite zero-write even
      // though there is no HTTP status. Do not ask the user to check a save
      // that was never sent, and do not accept a server-supplied lookalike.
      if (!result.ok && result.notDispatched === true && ["app-unavailable", "verification-unavailable",
        "protocol-incompatible", "host-forbidden", "host-unavailable", "bootstrap-rejected",
        "connection-selection-stale", "binding-connection-lost", "binding-identity-mismatch",
        "binding-service-restarted", "multiple-instances"].includes(code)) return code;
      const allowed = mode === "article"
        ? { "note-material-input-invalid": [400], "note-material-source-invalid": [400], "note-material-title-invalid": [400], "note-material-target-invalid": [400], "knowledge-name-conflict": [409] }
        : { "consumer-library-denied": [403], "consumer-folder-denied": [403], "consumer-tag-denied": [403], "consumer-input-invalid": [400], "consumer-capture-too-large": [413], "consumer-capture-busy": [429] };
      // A draft is dispatched once only: no prior unknown attempt can be
      // erased by a later denial. Failed receipt IDs require a new user action.
      return !result.ok && allowed[code]?.includes(result.status) ? code : null;
    }
    const journalKey = "luckyray.pageCapture.pending.v1";
    const storage = chromeApi.storage?.local;
    let pending = [], journalFailed = false;
    const reconciling = new Map();
    const lookupDiagnostics = new Map();
    function safeDiagnostic(result, fallback = "receipt-validation") {
      const code = result?.errorObject?.error?.code || result?.errorObject?.code;
      const reported = result?.diagnostic;
      const network = reported?.network;
      return {
        phase: ["http-response", "connection-before-send", "transport", "response-json"].includes(reported?.phase) ? reported.phase : fallback,
        status: Number.isInteger(result?.status || reported?.status) ? (result?.status || reported.status) : null,
        code: typeof code === "string" && /^[a-z][a-z0-9-]{1,79}$/.test(code) ? code : null,
        errorKind: ["AbortError", "TimeoutError", "TypeError", "transport-error", "invalid-json"].includes(reported?.errorKind) ? reported.errorKind : null,
        ...(network ? { network: {
          event: ["unobserved", "unavailable", "ambiguous", "started", "response", "error"].includes(network.event) ? network.event : "unavailable",
          status: Number.isInteger(network.status) && network.status >= 100 && network.status <= 599 ? network.status : null,
          error: /^net::ERR_[A-Z0-9_]{1,64}$/.test(network.error || "") ? network.error : null,
          port: Number.isInteger(network.port) && network.port > 0 && network.port <= 65535 ? network.port : null,
        } } : {}),
      };
    }
    let receiptCursor = 0;
    const isWriting = id => ["validating", "saving"].includes(drafts.get(id)?.stage);
    function blockedByJournal(records, mode) {
      if (records.some(record => isWriting(record.requestId))) return "capture-busy";
      if (records.length >= 32) return "capture-journal-full";
      // Retain the legacy article-to-article uncertainty guard, but an old
      // screenshot cannot disable an independent knowledge capture.
      if (mode === "article" && records.some(record => record.mode === "article")) return "capture-commit-uncertain";
      return null;
    }
    let journalQueue = storage ? storage.get(journalKey).then(value => {
      const records = value[journalKey] || [];
      if (!Array.isArray(records) || records.length > 32 || records.some(r => !r || !/^popup:[\w-]+$/.test(r.requestId) || typeof r.libraryId !== "string" || !["article", "visible", "region", "element", "full"].includes(r.mode))) throw failure("capture-journal-unavailable");
      pending = records;
    }).catch(() => { journalFailed = true; }) : Promise.resolve();
    function journal(change) {
      const task = journalQueue.then(async () => {
        if (journalFailed) throw failure("capture-journal-unavailable");
        const next = change(pending);
        if (next.length > 32) throw failure("capture-journal-unavailable");
        // Only operation identity is durable: never persist source URLs,
        // Markdown, screenshot bytes, vault bindings, or credentials.
        if (storage) await storage.set({ [journalKey]: next });
        pending = next;
      });
      journalQueue = task.catch(() => {});
      return task;
    }
    const publicDraft = draft => {
      const { bitmap, saveBody, binding, materialConsumer, ...safe } = draft;
      return JSON.parse(JSON.stringify(safe));
    };
    async function reconcilePng(record) {
      if (record.mode === "article" || ["validating", "saving"].includes(drafts.get(record.requestId)?.stage)) return null;
      if (reconciling.has(record.requestId)) return reconciling.get(record.requestId);
      const task = (async () => {
        try {
          // Query the existing host receipt by identity only. Never resend PNG
          // bytes, infer success from content dedupe, or treat absence as proof
          // of zero writes. Older hosts simply leave this operation unresolved.
          const result = await request("POST", "/api/material-libraries/capture-receipt",
            { libraryId: record.libraryId, requestId: record.requestId });
          const lookup = result.data, receipt = lookup?.receipt;
          lookupDiagnostics.set(record.requestId, { ...safeDiagnostic(result),
            state: ["completed", "unknown", "pending"].includes(lookup?.state) ? lookup.state : "unavailable" });
          if (!result.ok || lookup?.receiptLookupVersion !== 1 || lookup.state !== "completed"
            || lookup.libraryId !== record.libraryId || lookup.requestId !== record.requestId
            || receipt?.consumerVersion !== 1 || receipt.libraryId !== record.libraryId
            || receipt.requestId !== record.requestId || typeof receipt.assetId !== "string" || !receipt.assetId
            || !["imported", "duplicate"].includes(receipt.disposition)) return null;
          let stillPending = false, cleanupFailed = false;
          try {
            await journal(records => {
              stillPending = records.some(value => value.requestId === record.requestId && value.libraryId === record.libraryId);
              return stillPending ? records.filter(value => value.requestId !== record.requestId) : records;
            });
          } catch (_) { cleanupFailed = true; }
          if (!stillPending) return null;
          const draft = drafts.get(record.requestId);
          if (draft) {
            draft.receipt = receipt; draft.stage = "saved"; draft.reconciled = true;
            delete draft.bytesBase64; delete draft.saveBody; delete draft.code;
            draft.journalCleanupPending = cleanupFailed;
            if (cleanupFailed) draft.code = "capture-journal-cleanup-pending";
          }
          return { requestId: record.requestId, libraryId: record.libraryId, receipt, journalCleanupPending: cleanupFailed };
        } catch (_) {
          lookupDiagnostics.set(record.requestId, { phase: "receipt-query", status: null, code: "receipt-query-failed", state: "unavailable" });
          return null;
        }
      })();
      reconciling.set(record.requestId, task);
      try { return await task; } finally { reconciling.delete(record.requestId); }
    }
    async function current(draft) {
      if (draft.cancelled) throw failure("capture-cancelled");
      const tab = await chromeApi.tabs.get(draft.tabId);
      if (tab.url !== draft.pageUrl || !tab.active || tab.windowId !== draft.windowId) throw failure("capture-page-changed");
      return tab;
    }
    function bounds(width, height) {
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) throw failure("capture-size-limit");
    }
    async function shot(draft, expected) {
      await current(draft);
      const before = await page(draft.tabId, "metrics");
      if (!before.ok || before.documentToken !== expected.documentToken || before.width !== expected.width || before.height !== expected.height || before.dpr !== expected.dpr || before.url !== draft.pageUrl || Math.abs(before.y - expected.y) > 1 || Math.abs(before.x - expected.x) > 1) throw failure("capture-page-changed");
      let data;
      try { data = await chromeApi.tabs.captureVisibleTab(draft.windowId, { format: "png" }); }
      catch (error) { throw failure(/activeTab|<all_urls>/.test(error?.message || "") ? "capture-user-invocation-required" : "capture-browser-failed"); }
      await current(draft);
      const after = await page(draft.tabId, "metrics");
      if (after.documentToken !== before.documentToken || after.y !== before.y || after.x !== before.x || after.width !== before.width || after.height !== before.height || after.dpr !== before.dpr) throw failure("capture-page-changed");
      if (draft.mode === "full" && (after.pageHeight !== before.pageHeight || after.pageWidth !== before.pageWidth)) throw failure("capture-page-size-changed");
      return createImageBitmap(await (await fetch(data)).blob());
    }
    async function capture(draft) {
      capturingTabs.add(draft.tabId);
      let prepared = null;
      const deadline = Date.now() + 100000;
      try {
        await current(draft);
        const hidden = await page(draft.tabId, "suspend-ui");
        if (!hidden.ok) throw failure("capture-page-unavailable");
        let m = await page(draft.tabId, "metrics");
        draft.documentToken = m.documentToken;
        if (!m.ok || m.visualScale !== 1) throw failure("capture-zoom-unsupported");
        bounds(Math.ceil(m.width * m.dpr), Math.ceil(m.height * m.dpr));
        let rect = null;
        if (["region", "element"].includes(draft.mode)) {
          await chromeApi.windows.update(draft.windowId, { focused: true });
          const picked = await page(draft.tabId, "pick", { mode: draft.mode });
          if (!picked.ok) throw failure(picked.code || "capture-cancelled");
          rect = picked.rect; m = picked;
        }
        let canvas;
        if (draft.mode === "full") {
          prepared = await page(draft.tabId, "prepare");
          if (!prepared.ok || prepared.pageWidth > prepared.width + 1) throw failure("capture-horizontal-page");
          m = prepared;
          bounds(Math.ceil(m.width * m.dpr), Math.ceil(m.pageHeight * m.dpr));
          if (Math.ceil(m.pageHeight / m.height) > 64) throw failure("capture-size-limit");
          let covered = 0, scale = null;
          for (let tile = 0; covered < m.pageHeight && tile < 64; tile++) {
            if (Date.now() > deadline) throw failure("capture-time-limit");
            const at = await page(draft.tabId, "scroll", { documentToken: m.documentToken, y: covered, hideFixed: tile > 0 });
            if (!at.ok || at.pageHeight !== m.pageHeight || at.width !== m.width || at.height !== m.height || at.dpr !== m.dpr) throw failure("capture-page-size-changed");
            const image = await shot(draft, at);
            try {
              const ratio = image.width / m.width;
              if (scale === null) {
                scale = ratio;
                bounds(image.width, Math.round(m.pageHeight * scale));
                canvas = new OffscreenCanvas(image.width, Math.round(m.pageHeight * scale));
              }
              if (Math.abs(ratio - scale) > .001 || Math.abs(image.height / m.height - scale) > .02) throw failure("capture-page-changed");
              const offset = covered - at.y;
              const remaining = Math.min(m.height - offset, m.pageHeight - covered);
              if (remaining <= 0 || at.x !== 0 || offset < -1) throw failure("capture-scroll-failed");
              const top = Math.round(offset * scale), dest = Math.round(covered * scale);
              const height = Math.min(image.height - top, canvas.height - dest, Math.round(remaining * scale));
              canvas.getContext("2d").drawImage(image, 0, top, image.width, height, 0, dest, image.width, height);
              covered = Math.min(m.pageHeight, at.y + m.height);
              draft.progress = Math.round(covered / m.pageHeight * 100);
            } finally { image.close(); }
            if (covered < m.pageHeight) await delay(600);
          }
          if (covered < m.pageHeight) throw failure("capture-size-limit");
        } else {
          const image = await shot(draft, m);
          try {
            const ratio = image.width / m.width;
            if (Math.abs(image.height / m.height - ratio) > .02) throw failure("capture-page-changed");
            rect ||= { x: 0, y: 0, width: m.width, height: m.height };
            const x = Math.round(rect.x * ratio), y = Math.round(rect.y * ratio);
            const width = Math.min(image.width - x, Math.round(rect.width * ratio)), height = Math.min(image.height - y, Math.round(rect.height * ratio));
            bounds(width, height); canvas = new OffscreenCanvas(width, height);
            canvas.getContext("2d").drawImage(image, x, y, width, height, 0, 0, width, height);
          } finally { image.close(); }
        }
        await current(draft);
        const blob = await canvas.convertToBlob({ type: "image/png" });
        if (blob.size > MAX_BYTES) throw failure("capture-bytes-limit");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
        draft.bytesBase64 = btoa(binary); draft.width = canvas.width; draft.height = canvas.height; draft.sizeBytes = blob.size;
        draft.stage = "preview";
      } catch (error) { draft.stage = "failed"; draft.code = error.code || "capture-failed"; }
      finally {
        try {
        if (prepared) await page(draft.tabId, "restore", { documentToken: prepared.documentToken }).catch(() => {});
        if (draft.cancelled) await page(draft.tabId, "cancel").catch(() => {});
        await page(draft.tabId, "resume-ui").catch(() => {});
        if (draft.panelWindowId && !draft.cancelled) await chromeApi.windows.update(draft.panelWindowId, { focused: true }).catch(() => {});
        } finally { capturingTabs.delete(draft.tabId); }
      }
    }
    async function start(input, panelWindowId) {
      if (!input || !["article", "visible", "region", "element", "full"].includes(input.mode) || !Number.isInteger(input.tabId)) return { ok: false, code: "capture-input-invalid" };
      for (const [id, draft] of drafts) if (Date.now() - draft.createdAt > 10 * 60_000 && !["validating", "saving", "uncertain"].includes(draft.stage)) { draft.cancelled = true; drafts.delete(id); }
      if (starting.has(input.tabId) || capturingTabs.has(input.tabId) || [...drafts.values()].some(d => d.tabId === input.tabId && ["capturing", "validating", "saving"].includes(d.stage))) return { ok: false, code: "capture-busy" };
      starting.add(input.tabId);
      try {
      await journalQueue;
      if (journalFailed) return { ok: false, code: "capture-journal-unavailable" };
      const blocked = blockedByJournal(pending, input.mode);
      if (blocked) return { ok: false, code: blocked };
      const tab = await chromeApi.tabs.get(input.tabId);
      const sourceUrl = LuckyRayExtensionProtocol.normalizeSourcePageUrl(tab.url);
      if (!sourceUrl || !tab.active) return { ok: false, code: "capture-page-unavailable" };
      if (input.mode !== "article" && (!input.libraryId || !/^[\w:-]{1,160}$/.test(input.libraryId))) return { ok: false, code: "capture-library-required" };
      const draft = { id: `popup:${crypto.randomUUID()}`, tabId: tab.id, windowId: tab.windowId, panelWindowId,
        pageUrl: tab.url, sourceUrl, title: titleWithin(tab.title), mode: input.mode,
        libraryId: input.libraryId || null, stage: "capturing", createdAt: Date.now(), progress: 0 };
      if (input.mode === "article") {
        const binding = await request("POST", "/api/notes/capture-target", { target: "new" });
        if (!binding.ok || !binding.data?.activation?.vaultId) return { ok: false, code: binding.errorObject?.error?.code || binding.errorObject?.code || "knowledge-target-unavailable" };
        draft.binding = binding.data;
        draft.libraryId = binding.data.activation.vaultId;
      } else {
        try { draft.materialCapabilities = await materialLibrary(draft.libraryId); }
        catch (error) { return { ok: false, code: error.code }; }
      }
      drafts.set(draft.id, draft);
      if (draft.mode === "article") {
        try {
          const result = await page(tab.id, "article"); await current(draft);
          draft.documentToken = result.documentToken;
          if (result.title) draft.title = result.title;
          draft.markdown = result.markdown || ""; draft.contentKind = result.kind; draft.images = result.images || [];
          draft.stage = "preview"; draft.extractionCode = result.ok ? null : result.code;
        } catch (_) { draft.stage = "failed"; draft.code = "capture-page-changed"; }
      } else void capture(draft);
      return { ok: true, draft: publicDraft(draft) };
      } finally { starting.delete(input.tabId); }
    }
    async function save(id, input) {
      const draft = drafts.get(id);
      if (!draft || Date.now() - draft.createdAt > 10 * 60_000) return { ok: false, code: "capture-expired" };
      if (draft.stage !== "preview" || draft.cancelled) return { ok: false, code: "capture-busy", draft: publicDraft(draft) };
      // Freeze the stage before any await so a double click cannot dispatch
      // two note/material writes under the same preview.
      draft.stage = "validating";
      try {
        await current(draft);
        const m = await page(draft.tabId, "metrics");
        if (m.documentToken !== draft.documentToken) throw failure("capture-page-changed");
        if (draft.cancelled) throw failure("capture-cancelled");
      } catch (error) { draft.stage = "failed"; draft.code = error.code || "capture-page-changed"; return { ok: false, code: draft.code, draft: publicDraft(draft) }; }
      const title = String(input.title || draft.title).trim();
      if (!title || new TextEncoder().encode(title).length > (draft.mode === "article" ? 220 : 216) || /[\u0000-\u001f]/.test(title)) { draft.stage = "preview"; return { ok: false, code: "capture-title-invalid" }; }
      let route, body;
      if (draft.mode === "article") {
        const markdown = input.asLink ? `[${title.replace(/[\[\]\\]/g, "\\$&")}](<${draft.sourceUrl.replace(/[<>]/g, c => encodeURIComponent(c))}>)` : draft.markdown;
        if (!markdown) { draft.stage = "preview"; return { ok: false, code: "no-readable-content" }; }
        route = "/api/notes/capture";
        body = { requestId: draft.id, target: "new", title, content: markdown, sourceUrl: draft.sourceUrl, binding: draft.binding };
      } else {
        try {
          draft.materialCapabilities = await materialLibrary(draft.libraryId);
          const organized = input.folderId || String(input.newFolderName || "").trim() || input.tagIds?.length || input.tagNames?.length;
          if (organized && !draft.materialCapabilities.organize) throw failure("consumer-organize-denied");
        } catch (error) { draft.stage = "preview"; return { ok: false, code: error.code, draft: publicDraft(draft) }; }
        route = "/api/material-libraries/import-bytes";
        body = { requestId: draft.id, libraryId: draft.libraryId, name: `${title.replace(/[<>:"/\\|?*]/g, "_")}.png`, mimeType: "image/png", bytesBase64: draft.bytesBase64,
          sourcePageUrl: draft.sourceUrl, sourcePageTitle: draft.title,
          ...(input.folderId ? { targetFolderId: input.folderId } : {}),
          ...(input.newFolderName ? { newFolderName: String(input.newFolderName).trim() } : {}),
          sourcePageKind: "capture-page", tagIds: Array.isArray(input.tagIds) ? input.tagIds : [],
          tagNames: Array.isArray(input.tagNames) ? input.tagNames : [] };
      }
      try {
        await journal(records => {
          // Serialize live writes, not historic unknown outcomes. Never remove
          // an older identity to admit a new one, or replay an uncertain draft.
          const blocked = blockedByJournal(records, draft.mode);
          if (blocked) throw failure(blocked);
          return [...records, { requestId: draft.id, libraryId: draft.libraryId, mode: draft.mode, startedAt: Date.now() }];
        });
      } catch (error) {
        draft.stage = "preview";
        const code = ["capture-busy", "capture-commit-uncertain", "capture-journal-full"].includes(error.code) ? error.code : "capture-journal-unavailable";
        return { ok: false, code, draft: publicDraft(draft) };
      }
      draft.stage = "saving";
      draft.saveBody = body;
      let rejected = null;
      try {
        let receipt;
        if (draft.mode === "article") {
          const result = await request("POST", route, body);
          rejected = structuredRejection(result, draft.mode);
          if (!result.ok) throw failure(result.errorObject?.error?.code || result.errorObject?.code || "capture-commit-uncertain");
          receipt = result.data;
          if (!(receipt?.documentRef || receipt?.noteId) || (receipt.documentRef?.vaultId && receipt.documentRef.vaultId !== draft.libraryId)) throw failure("capture-commit-uncertain");
        } else {
          const consumer = global.LuckyRayMaterialLibraries.create(async (method, path, payload) => {
            const result = await request(method, path, payload);
            draft.saveDiagnostic = safeDiagnostic(result);
            rejected = structuredRejection(result, draft.mode);
            if (!result.ok) throw failure(result.errorObject?.error?.code || result.errorObject?.code || "capture-commit-uncertain");
            return result.data;
          });
          consumer.select(draft.libraryId);
          receipt = (await consumer.save(consumer.prepareCapture(body))).receipt;
          if (!receipt.assetId || !["imported", "duplicate"].includes(receipt.disposition)) throw failure("capture-commit-uncertain");
        }
        draft.receipt = receipt;
        draft.stage = "saved"; delete draft.bytesBase64; delete draft.saveBody;
        try { await journal(records => records.filter(record => record.requestId !== draft.id)); }
        catch (_) { draft.journalCleanupPending = true; draft.code = "capture-journal-cleanup-pending"; }
      } catch (error) {
        if (rejected) {
          try {
            await journal(records => records.filter(record => record.requestId !== draft.id));
            draft.stage = "failed"; draft.code = rejected; draft.notCommitted = true; delete draft.saveBody;
          } catch (_) { draft.stage = "uncertain"; draft.code = "capture-journal-unavailable"; }
        } else { draft.stage = "uncertain"; draft.code = error.code || "capture-commit-uncertain"; }
      }
      if (draft.stage === "uncertain") {
        // Record only safe stage/status/category alongside the existing identity.
        // It survives worker restart without screenshot content or credentials.
        try { await journal(records => records.map(record => record.requestId === draft.id
          ? { ...record, diagnostic: { ...draft.saveDiagnostic, code: draft.saveDiagnostic?.code || safeDiagnostic({ errorObject: { code: draft.code } }).code } } : record)); }
        catch (_) { /* The original identity remains authoritative. */ }
      }
      if (draft.stage === "uncertain" && draft.mode !== "article") {
        await reconcilePng({ requestId: draft.id, libraryId: draft.libraryId, mode: draft.mode });
      }
      return { ok: draft.stage === "saved", draft: publicDraft(draft), code: draft.code };
    }
    async function cancel(id) {
      const draft = drafts.get(id);
      if (!draft || ["validating", "saving", "saved", "uncertain"].includes(draft.stage)) return { ok: false, code: "capture-busy" };
      draft.cancelled = true; await page(draft.tabId, "cancel").catch(() => {}); drafts.delete(id);
      return { ok: true };
    }
    async function pendingStatus() {
      await journalQueue;
      // One bounded identity-only lookup per call, rotating so an older unknown
      // record cannot starve a later completed request (also after worker wake).
      const candidates = pending.filter(value => value.mode !== "article" && !isWriting(value.requestId));
      const record = candidates.length ? candidates[receiptCursor++ % candidates.length] : null;
      const recovered = record && !journalFailed ? await reconcilePng(record) : null;
      return { ok: !journalFailed, code: journalFailed ? "capture-journal-unavailable" : undefined,
        pending: pending.map(record => ({ ...record, inFlight: isWriting(record.requestId), lookupDiagnostic: lookupDiagnostics.get(record.requestId) })), recovered: recovered ? [recovered] : [] };
    }
    async function acknowledge(id, options = {}) {
      const draft = drafts.get(id);
      if (draft && ["validating", "saving"].includes(draft.stage)) return { ok: false, code: "capture-busy" };
      try {
        await journal(records => {
          // Inline recovery may inspect a historic article from another source
          // document, but only after explicit desktop-check acknowledgement.
          // Validate the actual journal inside its serialized transaction, not
          // an earlier pending snapshot; PNG unknowns are never cleared here.
          if (options.articleOnly === true) {
            const record = records.find(value => value.requestId === id);
            if (!record || record.mode !== "article") throw failure("capture-forbidden");
            if (isWriting(id)) throw failure("capture-busy");
          }
          return records.filter(record => record.requestId !== id);
        });
      } catch (error) { return { ok: false, code: error.code || "capture-journal-unavailable" }; }
      if (draft?.stage === "uncertain") drafts.delete(id);
      return pendingStatus();
    }
    return { start, save, cancel, pendingStatus, acknowledge, status: id => { const draft = drafts.get(id); return draft ? { ok: true, draft: publicDraft(draft) } : { ok: false, code: "capture-expired" }; } };
  }
  global.LuckyRayPageCaptureController = { create, MAX_PIXELS, MAX_SIDE, MAX_BYTES };
  if (typeof module !== "undefined") module.exports = global.LuckyRayPageCaptureController;
})(globalThis);
