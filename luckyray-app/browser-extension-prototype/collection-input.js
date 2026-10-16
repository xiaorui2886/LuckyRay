(function (global) {
  "use strict";
  function linkUrl(value) {
    const raw = String(value || "").trim();
    if (!raw || raw.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(raw)) return "";
    try {
      const url = new URL(raw);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return "";
      const secret = key => /^(access_token|api_key|apikey|auth|authorization|bearer|cookie|secret|sig|signature|token|x-amz-[\w-]+)$/i.test(key);
      if ([...url.searchParams.keys()].some(secret)) return "";
      let hash = url.hash.slice(1); for (let i = 0; i < 2; i++) hash = decodeURIComponent(hash);
      if (hash.split(/[?&;]/).some(part => secret(part.split("=")[0]))) return "";
      return url.href;
    } catch (_) { return ""; }
  }
  function linkContext(info, tab, text = "", now = Date.now()) {
    const url = linkUrl(info?.linkUrl), pageUrl = linkUrl(tab?.url);
    if (!url || !pageUrl || !Number.isInteger(tab?.id) || !info?.documentToken || !info.targetToken) return null;
    return { linkUrl: url, linkText: String(text || info.linkText || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 240),
      tabId: tab.id, pageUrl, frameId: Number.isInteger(info.frameId) ? info.frameId : 0, documentToken: info.documentToken, targetToken: info.targetToken, ts: now };
  }
  function currentLink(context, tab, pageUrl, now = Date.now(), documentToken = null) {
    if (!context || context.tabId !== tab?.id || context.pageUrl !== tab?.url || context.pageUrl !== pageUrl
      || !context.documentToken || !context.targetToken || (documentToken && context.documentToken !== documentToken)
      || now < context.ts || now - context.ts > 60000 || linkUrl(context.linkUrl) !== context.linkUrl) return null;
    return { url: context.linkUrl, title: context.linkText || context.linkUrl };
  }
  const api = { linkUrl, linkContext, currentLink }; global.LuckyRayCollectionInput = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
