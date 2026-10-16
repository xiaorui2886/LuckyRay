(function (global) {
  "use strict";
  if (global !== global.top) return;
  global.__lrPageCapture?.cleanup();
  const documentToken = crypto.randomUUID();
  let lease = null, picker = null, surface = null, uiLease = null;
  const uiSelector = "[data-luckyray-capture-surface],[data-luckyray-drag-collector],[data-luckyray-video-capture]";
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const metrics = () => ({ documentToken, url: location.href, title: document.title,
    x: scrollX, y: scrollY, width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
    pageWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
    pageHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
    visualScale: visualViewport?.scale || 1 });
  function resumeUi() {
    if (!uiLease) return;
    clearTimeout(uiLease.timer);
    uiLease.observer.disconnect();
    for (const { node, value, priority } of uiLease.hidden) {
      node.style.setProperty("visibility", value, priority);
    }
    uiLease = null;
  }
  async function suspendUi() {
    resumeUi();
    const hidden = [], seen = new Set();
    const hide = () => {
      for (const node of document.querySelectorAll(uiSelector)) {
        if (seen.has(node)) continue;
        seen.add(node); hidden.push({ node, value: node.style.getPropertyValue("visibility"), priority: node.style.getPropertyPriority("visibility") });
        node.style.setProperty("visibility", "hidden", "important");
      }
    };
    const observer = new MutationObserver(hide);
    uiLease = { hidden, observer, timer: setTimeout(resumeUi, 120000) };
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["data-luckyray-capture-surface", "data-luckyray-drag-collector", "data-luckyray-video-capture"] });
    hide();
    await frame(); // All modes wait for two paints, before pick/shot.
  }
  function hideSurface() {
    if (!surface) return;
    surface.host.style.setProperty("display", "none", "important");
    if (surface.focus?.isConnected) surface.focus.focus({ preventScroll: true });
  }
  const surfaceAlive = () => !!(surface?.host.isConnected && surface.iframe.isConnected);
  const matchesSurface = message => surfaceAlive() && message.session === surface.session && message.documentToken === documentToken;
  function showReadySurface() {
    surface.iframe.style.display = "block";
    surface.fallback.style.display = "none";
    surface.host.style.setProperty("height", `min(${surface.height || 320}px,calc(100vh - 32px))`, "important");
  }
  const surfaceKey = event => {
    if (event.key !== "Escape" || event.isComposing || picker || !surfaceAlive() || surface.host.style.getPropertyValue("display") === "none") return;
    event.preventDefault(); event.stopImmediatePropagation(); hideSurface();
  };
  function openSurface(message) {
    const url = new URL(message.url);
    if (message.documentToken !== documentToken || url.href.split(/[?#]/)[0] !== chrome.runtime.getURL("capture.html")
      || url.searchParams.get("inline") !== "1" || url.searchParams.get("session") !== message.session) return { ok: false, code: "capture-forbidden" };
    if (surface?.session !== message.session || !surfaceAlive()) {
      clearTimeout(surface?.timer);
      const focus = surface?.focus?.isConnected ? surface.focus : document.activeElement;
      surface?.host.remove();
      const host = document.createElement("div");
      host.dataset.luckyrayCaptureSurface = "true";
      host.style.cssText = "all:initial!important;position:fixed!important;right:16px!important;top:16px!important;width:min(480px,calc(100% - 32px))!important;height:min(320px,calc(100vh - 32px))!important;z-index:2147483646!important;visibility:visible!important;display:block!important;";
      const shadow = host.attachShadow({ mode: "closed" });
      const iframe = document.createElement("iframe");
      iframe.title = "LuckyRay 网页采集";
      iframe.style.cssText = "width:100%;height:100%;border:0;border-radius:16px;box-shadow:0 12px 48px #0006;background:transparent;";
      iframe.src = url.href;
      const fallback = document.createElement("div");
      fallback.style.cssText = "display:none;padding:20px;border-radius:12px;background:#202127;color:white;font:14px/1.6 sans-serif";
      fallback.textContent = "此页未能显示预览。请重新打开扩展，再次选择采集以使用独立预览。";
      const close = document.createElement("button"); close.textContent = "关闭";
      close.addEventListener("click", hideSurface); fallback.append(close);
      shadow.append(iframe, fallback); document.documentElement.append(host);
      surface = { host, iframe, fallback, session: message.session, focus };
      const current = surface;
      current.timer = setTimeout(() => { if (surface === current && !current.ready) { current.blocked = true; iframe.style.display = "none"; fallback.style.display = "block"; host.style.setProperty("height", "auto", "important"); } }, 8000);
    }
    if (surface.ready) showReadySurface();
    surface.host.style.setProperty("display", "block", "important");
    surface.iframe.focus({ preventScroll: true });
    return { ok: true, session: surface.session, ...metrics() };
  }
  function restore() {
    if (!lease) return;
    clearTimeout(lease.timer);
    for (const { node, value, priority } of lease.hidden) node.style.setProperty("visibility", value, priority);
    // Restore position while our instant-scroll override is still active;
    // restoring a site's smooth behavior first would animate the cleanup.
    scrollTo(lease.x, lease.y);
    document.documentElement.style.setProperty("scroll-behavior", lease.behavior, lease.behaviorPriority);
    document.documentElement.style.setProperty("scroll-snap-type", lease.snap, lease.snapPriority);
    lease = null;
  }
  function cancelPicker() { picker?.finish({ ok: false, code: "capture-cancelled" }); }
  function choose(mode) {
    cancelPicker();
    return new Promise(resolve => {
      const host = document.createElement("div");
      host.dataset.luckyrayPagePicker = "true";
      host.style.cssText = "position:fixed;inset:0;z-index:2147483647;cursor:crosshair;";
      const shadow = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = ':host{all:initial} .box{position:fixed;border:2px solid #b09cff;box-shadow:0 0 0 99999px #09071666;pointer-events:none;box-sizing:border-box} .hint{position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#211b35;color:#fff;padding:10px 18px;border-radius:12px;font:14px system-ui;pointer-events:none}';
      const box = document.createElement("div"); box.className = "box";
      const hint = document.createElement("div"); hint.className = "hint";
      hint.textContent = mode === "element" ? "点击要截取的元素 · Esc 取消" : "拖动选择范围 · Esc 取消";
      shadow.append(style, box, hint); document.documentElement.append(host);
      let start = null, rect = null;
      let timer;
      const show = r => { rect = r; box.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px`; };
      const point = e => ({ x: Math.min(innerWidth, Math.max(0, e.clientX)), y: Math.min(innerHeight, Math.max(0, e.clientY)) });
      const finish = async result => {
        if (picker?.host !== host) return;
        clearTimeout(timer);
        picker = null; host.remove(); document.removeEventListener("keydown", key, true);
        await frame(); resolve(result);
      };
      const key = e => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); void finish({ ok: false, code: "capture-cancelled" }); } };
      host.addEventListener("pointerdown", e => {
        if (!e.isTrusted || e.button !== 0) return;
        e.preventDefault(); e.stopImmediatePropagation(); start = point(e); host.setPointerCapture(e.pointerId);
      });
      host.addEventListener("pointermove", e => {
        if (!e.isTrusted) return;
        if (mode === "element") {
          host.style.pointerEvents = "none";
          const target = document.elementFromPoint(e.clientX, e.clientY);
          host.style.pointerEvents = "auto";
          if (!target) return;
          const r = target.getBoundingClientRect();
          show({ x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.min(innerWidth, r.right) - Math.max(0, r.left), height: Math.min(innerHeight, r.bottom) - Math.max(0, r.top) });
        } else if (start) {
          const p = point(e); show({ x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), width: Math.abs(p.x - start.x), height: Math.abs(p.y - start.y) });
        }
      });
      host.addEventListener("pointerup", e => {
        if (!e.isTrusted || !start) return;
        e.preventDefault(); e.stopImmediatePropagation();
        if (!rect || rect.width < 3 || rect.height < 3) return;
        void finish({ ok: true, rect, ...metrics() });
      });
      document.addEventListener("keydown", key, true);
      picker = { host, finish };
      timer = setTimeout(() => void finish({ ok: false, code: "capture-time-limit" }), 60000);
    });
  }
  const listener = (message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !String(message?.type || "").startsWith("luckyray-page-capture-")) return;
    const action = message.type.slice("luckyray-page-capture-".length);
    (async () => {
      if (action === "article") {
        const result = LuckyRayArticleExtractor.extract(document);
        return { ...metrics(), ...result, sourceUrl: LuckyRayExtensionProtocol.normalizeSourcePageUrl(location.href) };
      }
      if (action === "metrics") return { ok: true, ...metrics() };
      if (action === "surface-state") return { ok: true, ...metrics(), alive: surfaceAlive(), session: surface?.session || null, blocked: !!surface?.blocked };
      if (action === "surface-open") return openSurface(message);
      if (action === "surface-ready") {
        if (!matchesSurface(message)) return { ok: false, code: "capture-forbidden" };
        if (Number.isFinite(message.height)) surface.height = Math.max(120, Math.min(740, Math.ceil(message.height)));
        surface.ready = true; surface.blocked = false; clearTimeout(surface.timer); showReadySurface();
        return { ok: true, maxHeight: Math.max(120, Math.min(740, innerHeight - 32)) };
      }
      if (action === "surface-hide") {
        if (!matchesSurface(message)) return { ok: false, code: "capture-forbidden" };
        hideSurface(); return { ok: true };
      }
      if (action === "suspend-ui") { await suspendUi(); return { ok: true, ...metrics() }; }
      if (action === "resume-ui") { resumeUi(); return { ok: true }; }
      if (action === "cancel") { cancelPicker(); restore(); return { ok: true }; }
      if (action === "pick") return choose(message.mode);
      if (action === "prepare") {
        restore();
        const style = document.documentElement.style;
        lease = { x: scrollX, y: scrollY, behavior: style.getPropertyValue("scroll-behavior"), behaviorPriority: style.getPropertyPriority("scroll-behavior"), snap: style.getPropertyValue("scroll-snap-type"), snapPriority: style.getPropertyPriority("scroll-snap-type"), hidden: [], timer: setTimeout(restore, 120000) };
        style.setProperty("scroll-behavior", "auto", "important"); style.setProperty("scroll-snap-type", "none", "important");
        return { ok: true, ...metrics() };
      }
      if (message.documentToken !== documentToken) return { ok: false, code: "capture-page-changed" };
      if (action === "scroll") {
        if (!lease) return { ok: false, code: "capture-expired" };
        if (message.hideFixed && !lease.hidden.length) {
          for (const node of [...document.querySelectorAll("*")].slice(0, 20000)) {
            const position = getComputedStyle(node).position;
            if (position !== "fixed" && position !== "sticky") continue;
            lease.hidden.push({ node, value: node.style.getPropertyValue("visibility"), priority: node.style.getPropertyPriority("visibility") });
            node.style.setProperty("visibility", "hidden", "important");
          }
        }
        scrollTo(0, message.y); await frame();
        await Promise.race([Promise.all([...document.images].filter(image => { const r = image.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; }).map(image => image.decode?.().catch(() => {}))), new Promise(resolve => setTimeout(resolve, 500))]);
        return { ok: true, ...metrics() };
      }
      if (action === "restore") { restore(); return { ok: true }; }
      return { ok: false, code: "capture-action-invalid" };
    })().then(result => respond({ ...result, captureProtocolVersion: LuckyRayExtensionProtocol.CAPTURE_PROTOCOL_VERSION })).catch(() => respond({ ok: false, code: "capture-page-unavailable", captureProtocolVersion: LuckyRayExtensionProtocol.CAPTURE_PROTOCOL_VERSION }));
    return true;
  };
  chrome.runtime.onMessage.addListener(listener);
  addEventListener("keydown", surfaceKey, true);
  const cleanup = () => { cancelPicker(); restore(); resumeUi(); clearTimeout(surface?.timer); surface?.host.remove(); surface = null; removeEventListener("keydown", surfaceKey, true); chrome.runtime.onMessage.removeListener(listener); };
  addEventListener("pagehide", cleanup, { once: true });
  global.__lrPageCapture = { cleanup };
})(globalThis);
