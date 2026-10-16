(function (global) {
  "use strict";
  const LIMIT = 300;
  function formatOf(url) {
    try { const ext = new URL(url).pathname.match(/\.(avif|gif|jpe?g|png|svg|webp)$/i)?.[1]?.toLowerCase(); return ext === "jpeg" ? "jpg" : ext || "other"; } catch (_) { return "other"; }
  }
  function suggestedName(title, url, index = 1) {
    let name = "";
    try { name = decodeURIComponent(new URL(url).pathname.split("/").pop() || ""); } catch (_) {}
    if (!name || /^(?:download|image|img|original|\d+)(?:\.[a-z0-9]+)?$/i.test(name)) name = `${title || "网页图片"} ${index}${formatOf(url) === "other" ? "" : `.${formatOf(url)}`}`;
    return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/[. ]+$/g, "").trim().slice(0, 140) || "网页图片";
  }
  function matches(item, { width = 0, height = 0, format = "all" } = {}) {
    return item.width >= Math.max(0, Number(width) || 0) && item.height >= Math.max(0, Number(height) || 0)
      && (format === "all" || item.format === format);
  }
  // Session-owned opaque IDs; URL changes create a new candidate, never retarget
  // an existing selection. DOM references and descriptors stay in the isolated world.
  function createDOMCollector({ document, resolve, describe, descriptor, targetFor = node => node, token, now = Date.now, schedule = setTimeout, unschedule = clearTimeout }) {
    const entries = new Map(), byId = new Map(), queue = [];
    let observer = null, timer = null, expiry = null, session = "", sequence = 0, visits = 0, touched = 0, capped = false;
    const imageLoaded = event => enqueue(event.target);
    function stop() { observer?.disconnect(); observer = null; document.removeEventListener("load", imageLoaded, true); unschedule(timer); unschedule(expiry); timer = expiry = null; queue.length = 0; }
    function enqueue(root) {
      if (!root || root.nodeType !== 1 || root.closest?.("[data-luckyray-capture-surface],[data-luckyray-video-capture],[data-luckyray-drag-collector]")) return;
      if (queue.length >= 100) { capped = true; return; }
      queue.push({ root, walker: document.createTreeWalker(root, 1), first: true });
      if (!timer) timer = schedule(drain, 100);
    }
    function inspect(node) {
      if (!node.isConnected) return;
      const visual = resolve(node);
      if (!visual?.url) return;
      const target = targetFor(node);
      if (!target?.isConnected) return;
      const info = describe(target, visual) || {};
      const captured = descriptor(target, { url: visual.url, previewUrl: info.previewUrl || "" });
      if (!captured?.documentToken || !captured.targetToken) return;
      const key = `${visual.url}\n${captured.linkUrl || ""}`;
      let entry = entries.get(key);
      if (entry && !matchesBinding(entry)) entry = null;
      if (!entry) {
        if (byId.size >= LIMIT) { capped = true; return; }
        entry = { id: `${session}:${++sequence}`, url: visual.url, previewUrl: info.previewUrl || "", previewLoaded: Boolean(info.previewLoaded),
          width: Math.max(0, Number(info.width) || 0), height: Math.max(0, Number(info.height) || 0),
          title: String(info.title || "").slice(0, 180), format: formatOf(visual.url), targets: [target],
          binding: Object.freeze({ documentToken: captured.documentToken, targetToken: captured.targetToken, linkUrl: captured.linkUrl || null }) };
        entries.set(key, entry); byId.set(entry.id, entry);
      }
      // Duplicate displays share a candidate only within the same work source.
      // Saving always renews the original target; it cannot fall back to another.
      if (target === entry.targets[0] && info.previewUrl && (info.previewLoaded || !entry.previewLoaded)) { entry.previewUrl = info.previewUrl; entry.previewLoaded = Boolean(info.previewLoaded); }
      if (!entry.title && info.title) entry.title = String(info.title).slice(0, 180);
      entry.width = Math.max(entry.width, Number(info.width) || 0); entry.height = Math.max(entry.height, Number(info.height) || 0);
    }
    function matchesBinding(entry) {
      const target = entry.targets[0];
      if (!target?.isConnected || resolve(target)?.url !== entry.url) return false;
      const fresh = descriptor(target, entry);
      return fresh?.documentToken === entry.binding.documentToken && fresh.targetToken === entry.binding.targetToken
        && (fresh.linkUrl || null) === entry.binding.linkUrl;
    }
    function drain() {
      timer = null;
      if (!observer || now() - touched > 120000) return stop();
      const deadline = now() + 16;
      for (let count = 0; queue.length && count < 120 && now() <= deadline; count++) {
        if (++visits > 12000) { capped = true; queue.length = 0; break; }
        const work = queue[0], node = work.first ? work.root : work.walker.nextNode(); work.first = false;
        if (!node) { queue.shift(); continue; }
        inspect(node);
      }
      if (queue.length) timer = schedule(drain, 120);
    }
    function touch() {
      touched = now(); unschedule(expiry); expiry = schedule(stop, 120001);
      if (observer) return;
      if (!session) session = token;
      visits = 0;
      observer = new MutationObserver(records => {
        for (const mutation of records.slice(0, 100)) {
          if (mutation.type === "attributes") enqueue(mutation.target);
          else for (const node of Array.from(mutation.addedNodes).slice(0, 40)) enqueue(node);
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
        attributeFilter: ["src", "srcset", "data-src", "data-original", "data-lazy-src", "poster", "href", "style", "class"] });
      document.addEventListener("load", imageLoaded, true);
      enqueue(document.documentElement);
    }
    function snapshot(rescan = false) {
      touch();
      if (rescan) {
        // Keep still-bound opaque IDs, never retarget an old selection to a new
        // DOM node. Reclaim stale entries and the bounded scan budget.
        for (const [key, entry] of entries) if (!matchesBinding(entry)) entries.delete(key);
        for (const [id, entry] of byId) if (!matchesBinding(entry)) byId.delete(id);
        unschedule(timer); timer = null; queue.length = 0; visits = 0; capped = false;
        enqueue(document.documentElement);
      }
      return { session, documentToken: token, candidates: Array.from(entries.values(), entry => { const { targets, previewLoaded, ...item } = entry; return { ...item, available: matchesBinding(entry) }; }),
        pending: queue.length > 0, capped, limit: LIMIT, visits };
    }
    function renew(id, expectedUrl, expectedSession) {
      if (expectedSession !== session) return null;
      const entry = byId.get(id);
      if (!entry || entry.url !== expectedUrl) return null;
      return matchesBinding(entry) ? descriptor(entry.targets[0], entry) : null;
    }
    return { snapshot, renew, stop };
  }
  const api = { LIMIT, formatOf, suggestedName, matches, createDOMCollector };
  global.LuckyRayImageCollection = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
