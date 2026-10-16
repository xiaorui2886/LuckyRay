(function (global) {
  "use strict";
  // Ephemeral UI authority, separate from the durable write/receipt journal.
  function create({ chromeApi, page, controller, showMain }) {
    const sessions = new Map(), opening = new Map();
    const fail = code => ({ ok: false, code });
    function sourceFrame(sender) {
      if (sender.id !== chromeApi.runtime.id || !Number.isInteger(sender.frameId) || sender.frameId < 1 || !sender.documentId) return null;
      let url;
      try { url = new URL(sender.url); } catch (_) { return null; }
      const tabId = Number(url.searchParams.get("tabId")), id = url.searchParams.get("session");
      if (url.href.split(/[?#]/)[0] !== chromeApi.runtime.getURL("capture.html")
        || (sender.origin && sender.origin !== chromeApi.runtime.getURL("").replace(/\/$/, ""))
        || url.searchParams.get("inline") !== "1" || !id || !Number.isInteger(tabId) || sender.tab?.id !== tabId) return null;
      return { tabId, id };
    }
    async function open(tabId, mode = "visible", returnCategory) {
      if (opening.has(tabId)) return opening.get(tabId);
      const task = (async () => {
        const tab = await chromeApi.tabs.get(tabId);
        if (!tab.active || !LuckyRayExtensionProtocol.normalizeSourcePageUrl(tab.url)) return fail("capture-page-unavailable");
        const state = await page(tabId, "surface-state");
        if (!state.ok || state.url !== tab.url || !state.documentToken) return fail("capture-page-unavailable");
        let session = sessions.get(tabId);
        const sameDocument = session?.pageUrl === tab.url && session.documentToken === state.documentToken;
        const kind = mode === "article" ? "article" : "image";
        if (sameDocument && state.alive && state.blocked) return fail("capture-inline-unavailable");
        if (!sameDocument || !state.alive || state.session !== session.id || session.kind !== kind) {
          if (!session && sessions.size >= 32) return fail("capture-busy");
          // Only a verified user entry can rotate frame authority. Preserve the
          // original draft/journal on a same-document DOM rebuild, never on navigation.
          // The two UI pages retain separate ephemeral task identities. Moving
          // between them never cancels, acknowledges or replays the other write.
          const tasks = sameDocument ? session.tasks : {};
          const task = tasks[kind] ||= { draftId: null, starting: null, startCode: null };
          session = { id: crypto.randomUUID(), tabId, pageUrl: tab.url, documentToken: state.documentToken,
            kind, tasks, task };
          sessions.set(tabId, session);
        }
        session.returnCategory = ["image", "video", "text", "link"].includes(returnCategory) ? returnCategory : kind === "article" ? "text" : "image";
        const url = chromeApi.runtime.getURL(`capture.html?inline=1&session=${session.id}&tabId=${tabId}&mode=${encodeURIComponent(mode)}`);
        const result = await page(tabId, "surface-open", { url, session: session.id, documentToken: session.documentToken });
        return result.ok && result.documentToken === session.documentToken && result.url === session.pageUrl && result.session === session.id
          ? { ok: true, inline: true } : fail(result.code || "capture-inline-unavailable");
      })();
      opening.set(tabId, task);
      try { return await task; } catch (_) { return fail("capture-inline-unavailable"); }
      finally { opening.delete(tabId); }
    }
    async function authorize(sender) {
      const frame = sourceFrame(sender);
      const session = frame && sessions.get(frame.tabId);
      if (!session || frame.id !== session.id) return null;
      // The first extension frame is bound by its browser-assigned document ID.
      if (session.frameDocumentId && sender.documentId !== session.frameDocumentId) return null;
      const tab = await chromeApi.tabs.get(session.tabId).catch(() => null);
      if (!tab || tab.url !== session.pageUrl) return null;
      const state = await page(session.tabId, "surface-state").catch(() => null);
      if (!state?.ok || !state.alive || state.session !== session.id || state.documentToken !== session.documentToken
        || state.url !== session.pageUrl || sessions.get(session.tabId) !== session) return null;
      if (session.frameDocumentId && session.frameDocumentId !== sender.documentId) return null;
      session.frameDocumentId = sender.documentId;
      return session;
    }
    async function close(sender, returnToMain = false) {
      const frame = sourceFrame(sender);
      if (!frame) return fail("capture-forbidden");
      const session = sessions.get(frame.tabId);
      if (session?.id === frame.id && session.frameDocumentId && session.frameDocumentId !== sender.documentId) return fail("capture-forbidden");
      const tab = await chromeApi.tabs.get(frame.tabId).catch(() => null);
      if (!tab || !LuckyRayExtensionProtocol.normalizeSourcePageUrl(tab.url)) return fail("capture-forbidden");
      const state = await page(frame.tabId, "surface-state").catch(() => null);
      if (!state?.ok || !state.alive || state.session !== frame.id || state.url !== tab.url || !state.documentToken) return fail("capture-forbidden");
      if (returnToMain) {
        const fallbackCategory = new URL(sender.url).searchParams.get("mode") === "article" ? "text" : "image";
        try { await showMain(tab, { category: session?.id === frame.id ? session.returnCategory : fallbackCategory, documentToken: state.documentToken, session: frame.id }); } catch (_) { return fail("capture-main-unavailable"); }
      }
      // Narrow UI-only recovery after worker suspension: the source content
      // script checks its own live nonce again. This never creates RPC authority.
      return page(frame.tabId, "surface-hide", { session: frame.id, documentToken: state.documentToken });
    }
    async function draft(session, message) {
      if (sessions.get(session.tabId) !== session) return fail("capture-forbidden");
      const task = session.task;
      if (message.action === "restore") {
        // Rebuilt frames share this document's single Start, including the
        // period before the controller has allocated its draft identity.
        if (task.starting) await task.starting;
        if (sessions.get(session.tabId) !== session) return fail("capture-forbidden");
        // An older terminal/unknown draft remains intact, but is not the
        // outcome of the latest failed Start.
        if (task.startCode) return { ok: true, draft: null, startCode: task.startCode };
        return task.draftId ? controller.status(task.draftId) : { ok: true, draft: null, startCode: task.startCode };
      }
      if (message.action === "start") {
        if (message.input?.tabId !== session.tabId) return fail("capture-forbidden");
        if (task.starting) return fail("capture-busy");
        task.startCode = null;
        const starting = Promise.resolve().then(() => controller.start(message.input)).catch(() => fail("capture-unavailable")).then(result => {
          if (result.draft) task.draftId = result.draft.id;
          task.startCode = result.ok ? null : result.code || "capture-unavailable";
          return result;
        });
        task.starting = starting;
        try { return await starting; }
        finally { if (task.starting === starting) task.starting = null; }
      }
      if (message.action === "acknowledge") {
        if (message.confirmed !== true) return fail("capture-forbidden");
        const result = await controller.acknowledge(message.id, { articleOnly: true });
        if (result.ok && task.draftId === message.id) task.draftId = null;
        return result;
      }
      if (["status", "cancel", "save"].includes(message.action)) {
        if (!task.draftId || message.id !== task.draftId) return fail("capture-forbidden");
        if (message.action === "status") return controller.status(message.id);
        if (message.action === "save") return controller.save(message.id, message.input || {});
        const result = await controller.cancel(message.id);
        if (result.ok) task.draftId = null;
        return result;
      }
      return fail("capture-action-invalid");
    }
    chromeApi.tabs.onRemoved?.addListener(tabId => sessions.delete(tabId));
    return { open, authorize, close, draft };
  }
  global.LuckyRayCaptureSurface = { create };
  if (typeof module !== "undefined") module.exports = global.LuckyRayCaptureSurface;
})(globalThis);
