(() => {
"use strict";

const lrCollectorInstallKey = "__LUCKYRAY_COLLECTOR_CONTENT_RECEIVER__";
const lrCollectorPreviousInstall = globalThis[lrCollectorInstallKey];
if (lrCollectorPreviousInstall && typeof lrCollectorPreviousInstall.cleanup === "function") {
  try { lrCollectorPreviousInstall.cleanup(); } catch (_) {}
}
// An extension reload can invalidate the previous isolated world before its
// cleanup runs. Remove page-visible hosts by their stable DOM markers as well;
// closed shadow roots do not prevent removing their host elements.
try {
  for (const host of Array.from(document.querySelectorAll?.(
    "[data-luckyray-drag-collector],[data-luckyray-video-capture]",
  ) || [])) host.remove?.();
} catch (_) {}
const lrCollectorCleanups = [];
const lrCollectorRuntimeId = chrome.runtime?.id;
let lrCollectorDisposed = false;
const lrCollectorIsTopFrame = (() => {
  try { return !window.top || window.top === window; } catch (_) { return false; }
})();

function lrCollectorListen(target, type, listener, options) {
  const guardedListener = function (...args) {
    if (lrCollectorDisposed) return;
    // An extension reload leaves the old isolated world's page listeners
    // alive. Retire that receiver before a hover/play/scroll callback can
    // reattach an old video host removed by the replacement receiver.
    if (lrCollectorRuntimeId && chrome.runtime?.id !== lrCollectorRuntimeId) {
      lrCollectorCleanup();
      return;
    }
    return listener.apply(this, args);
  };
  target.addEventListener(type, guardedListener, options);
  lrCollectorCleanups.push(() => target.removeEventListener(type, guardedListener, options));
}

function lrCollectorListenRuntime(listener) {
  chrome.runtime.onMessage.addListener(listener);
  lrCollectorCleanups.push(() => chrome.runtime.onMessage.removeListener(listener));
}

// Presentation-only: semantic theme tokens for the two closed Shadow DOM
// surfaces (player chip/panel and drag shell). A page's Shadow DOM cannot read
// the popup stylesheet, so the values are inlined here. They mirror
// `browser-extension-prototype/theme.css` and the desktop authority in
// `luckyray-app/src/core/theme/themeTokens.css`.
//
// The surface picks its theme from `data-lr-theme` on its host element and
// falls back to `dark`. Wiring the real desktop theme value into that attribute
// is central's follow-up; nothing here connects, subscribes or persists.
const lrCollectorShadowThemeTokens = `
    :host{all:initial;--lr-radius-xs:6px;--lr-radius-sm:8px;--lr-radius-md:11px;--lr-radius-lg:14px;--lr-radius-xl:18px;--lr-radius-pill:999px;--lr-dur:170ms;--lr-dur-fast:120ms;--lr-ease:cubic-bezier(.22,.61,.36,1);--lr-font:"Segoe UI Variable Display","Segoe UI Variable","PingFang SC","Microsoft YaHei UI",system-ui,sans-serif;--lr-font-label:"Bahnschrift","Segoe UI Variable","PingFang SC",sans-serif;color-scheme:dark;--lr-bg:#0a0a0c;--lr-surface:#111114;--lr-surface-raised:#1a1a1f;--lr-surface-sunken:#0d0d10;--lr-surface-hover:#222228;--lr-border:rgba(255,255,255,.07);--lr-border-strong:rgba(255,255,255,.13);--lr-text:#f0f0f2;--lr-text-muted:#8e8e96;--lr-text-faint:#81818c;--lr-accent:#7c8aff;--lr-accent-hover:#9aa4ff;--lr-accent-soft:rgba(124,138,255,.13);--lr-accent-line:rgba(124,138,255,.38);--lr-accent-ink:#0b0b12;--lr-success:#4ade80;--lr-warning:#fbbf24;--lr-danger:#fb7185;--lr-glass:rgba(17,17,20,.9);--lr-glass-filter:blur(18px) saturate(1.08);--lr-shadow-lg:0 22px 64px rgba(0,0,0,.52)}
    :host([data-lr-theme="light"]){color-scheme:light;--lr-bg:#f1f2f5;--lr-surface:#ffffff;--lr-surface-raised:#ffffff;--lr-surface-sunken:#f6f7f9;--lr-surface-hover:#e8eaf0;--lr-border:rgba(25,28,39,.09);--lr-border-strong:rgba(25,28,39,.16);--lr-text:#18191f;--lr-text-muted:#555966;--lr-text-faint:#717684;--lr-accent:#5968ef;--lr-accent-hover:#4b59e0;--lr-accent-soft:rgba(124,138,255,.14);--lr-accent-line:rgba(95,109,240,.42);--lr-accent-ink:#ffffff;--lr-success:#238657;--lr-warning:#a36a10;--lr-danger:#cd475e;--lr-glass:rgba(255,255,255,.9);--lr-glass-filter:blur(18px) saturate(1.04);--lr-shadow-lg:0 24px 64px rgba(29,32,44,.17)}
    :host([data-lr-theme="ivory-editorial"]){color-scheme:light;--lr-bg:#f3ede3;--lr-surface:#fffaf2;--lr-surface-raised:#fffaf2;--lr-surface-sunken:#f6f1e8;--lr-surface-hover:#e9decf;--lr-border:rgba(75,61,44,.11);--lr-border-strong:rgba(75,61,44,.2);--lr-text:#2f2a23;--lr-text-muted:#74695b;--lr-text-faint:#7e7265;--lr-accent:#9d6839;--lr-accent-hover:#915c2e;--lr-accent-soft:rgba(185,130,79,.15);--lr-accent-line:rgba(168,111,61,.42);--lr-accent-ink:#fffaf2;--lr-success:#4d7e62;--lr-warning:#a0680f;--lr-danger:#b75656;--lr-glass:rgba(255,250,242,.9);--lr-glass-filter:blur(16px) saturate(1.02);--lr-shadow-lg:0 24px 64px rgba(84,64,38,.19)}
    :host([data-lr-theme="rose-tea"]){color-scheme:light;--lr-bg:#f3e8ec;--lr-surface:#fff7f9;--lr-surface-raised:#fff7f9;--lr-surface-sunken:#f6edf0;--lr-surface-hover:#e7d1d9;--lr-border:rgba(98,55,70,.12);--lr-border-strong:rgba(98,55,70,.21);--lr-text:#3f3036;--lr-text-muted:#795f6a;--lr-text-faint:#876b77;--lr-accent:#b15472;--lr-accent-hover:#a3526d;--lr-accent-soft:rgba(201,121,145,.16);--lr-accent-line:rgba(184,99,126,.42);--lr-accent-ink:#fff7f9;--lr-success:#457d67;--lr-warning:#986938;--lr-danger:#b5536d;--lr-glass:rgba(255,247,249,.9);--lr-glass-filter:blur(17px) saturate(1.04);--lr-shadow-lg:0 24px 64px rgba(91,46,63,.19)}
    :host([data-lr-theme="github-dark"]){color-scheme:dark;--lr-bg:#0d1117;--lr-surface:#161b22;--lr-surface-raised:#21262d;--lr-surface-sunken:#0b0f14;--lr-surface-hover:#292f37;--lr-border:rgba(48,54,61,.8);--lr-border-strong:#30363d;--lr-text:#f0f6fc;--lr-text-muted:#8b949e;--lr-text-faint:#858d97;--lr-accent:#58a6ff;--lr-accent-hover:#79c0ff;--lr-accent-soft:rgba(56,139,253,.16);--lr-accent-line:rgba(88,166,255,.45);--lr-accent-ink:#04121f;--lr-success:#3fb950;--lr-warning:#d29922;--lr-danger:#f85149;--lr-glass:rgba(22,27,34,.92);--lr-glass-filter:blur(16px) saturate(1.04);--lr-shadow-lg:0 24px 64px rgba(1,4,9,.58)}
    :host([data-lr-theme="white-zero"]){color-scheme:light;--lr-bg:#f5f5f5;--lr-surface:#ffffff;--lr-surface-raised:#ffffff;--lr-surface-sunken:#fafafa;--lr-surface-hover:#f2f2f2;--lr-border:rgba(17,17,17,.09);--lr-border-strong:rgba(17,17,17,.15);--lr-text:#111113;--lr-text-muted:#60646c;--lr-text-faint:#75757e;--lr-accent:#18181b;--lr-accent-hover:#000000;--lr-accent-soft:rgba(24,24,27,.07);--lr-accent-line:rgba(24,24,27,.3);--lr-accent-ink:#ffffff;--lr-success:#22865c;--lr-warning:#9a6419;--lr-danger:#c83e3e;--lr-glass:rgba(255,255,255,.92);--lr-glass-filter:blur(14px);--lr-shadow-lg:0 24px 64px rgba(0,0,0,.13)}
    :host([data-lr-theme="bangladesh-green"]){color-scheme:dark;--lr-bg:#021510;--lr-surface:#06251f;--lr-surface-raised:#0a332a;--lr-surface-sunken:#041e19;--lr-surface-hover:#0d3c32;--lr-border:rgba(207,255,238,.09);--lr-border-strong:rgba(207,255,238,.16);--lr-text:#eafff8;--lr-text-muted:#9bc9bc;--lr-text-faint:#6d9d90;--lr-accent:#00b884;--lr-accent-hover:#16d39b;--lr-accent-soft:rgba(0,184,132,.16);--lr-accent-line:rgba(0,184,132,.44);--lr-accent-ink:#01180f;--lr-success:#31d49b;--lr-warning:#e7b85d;--lr-danger:#ef7f8f;--lr-glass:rgba(6,37,31,.9);--lr-glass-filter:blur(18px) saturate(1.08);--lr-shadow-lg:0 24px 64px rgba(0,0,0,.52)}
    :host([data-lr-theme="lilac-milk"]){color-scheme:light;--lr-bg:#e8ddd6;--lr-surface:#f8eee8;--lr-surface-raised:#f8eee8;--lr-surface-sunken:#ece1d9;--lr-surface-hover:#dccbc4;--lr-border:rgba(74,80,104,.14);--lr-border-strong:rgba(74,80,104,.24);--lr-text:#3d4257;--lr-text-muted:#51607a;--lr-text-faint:#626d86;--lr-accent:#5b6689;--lr-accent-hover:#4a5677;--lr-accent-soft:rgba(106,118,153,.17);--lr-accent-line:rgba(91,102,137,.42);--lr-accent-ink:#f8eee8;--lr-success:#427763;--lr-warning:#92633a;--lr-danger:#96525f;--lr-glass:rgba(248,238,232,.9);--lr-glass-filter:blur(17px) saturate(1.03);--lr-shadow-lg:0 24px 64px rgba(74,80,104,.18)}
    :host([data-lr-theme="blue-whisper"]){color-scheme:light;--lr-bg:#c7d1dc;--lr-surface:#e3eaf0;--lr-surface-raised:#e3eaf0;--lr-surface-sunken:#ced7e0;--lr-surface-hover:#b8c7d1;--lr-border:rgba(41,71,91,.16);--lr-border-strong:rgba(41,71,91,.26);--lr-text:#223c4d;--lr-text-muted:#365a70;--lr-text-faint:#496c80;--lr-accent:#367083;--lr-accent-hover:#2f6b80;--lr-accent-soft:rgba(75,144,165,.18);--lr-accent-line:rgba(61,127,148,.44);--lr-accent-ink:#e3eaf0;--lr-success:#387364;--lr-warning:#886133;--lr-danger:#92525f;--lr-glass:rgba(227,234,240,.9);--lr-glass-filter:blur(18px) saturate(1.05);--lr-shadow-lg:0 24px 64px rgba(41,71,91,.19)}
    @media (prefers-reduced-motion:reduce){:host{--lr-dur:1ms;--lr-dur-fast:1ms}}
`;

const lrCollectorIconGeometry = {
  video: "<rect x='3' y='5' width='14' height='14' rx='3'/><path d='m17 10 4-2v8l-4-2M8.5 9.5l4 2.5-4 2.5v-5Z'/>",
  close: "<path d='M5.5 5.5 18.5 18.5M18.5 5.5 5.5 18.5'/>",
  success: "<path d='M20 11a8 8 0 1 1-3.1-6.3'/><path d='m8 11.5 3 3L20 5'/>",
  failure: "<circle cx='12' cy='12' r='9'/><path d='m8.5 8.5 7 7M15.5 8.5l-7 7'/>",
  warning: "<path d='M10.2 4.7 3.4 17a2 2 0 0 0 1.8 3h13.6a2 2 0 0 0 1.8-3L13.8 4.7a2 2 0 0 0-3.6 0Z'/><path d='M12 9v5M12 17.5h.01'/>",
  "folder-open": "<path d='M3 8a2.5 2.5 0 0 1 2.5-2.5H10l2 2h6.5A2.5 2.5 0 0 1 21 10H9'/><path d='M3.5 11.5h16l-1.6 6.4a2 2 0 0 1-1.9 1.5H6.2a2 2 0 0 1-2-2l-.7-5.9Z'/>",
  add: "<path d='M12 4v16M4 12h16'/>",
  "collection-inbox": "<path d='M5 5h14l2 8v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5l2-8Z'/><path d='M3 13h5c.4 2 1.7 3 4 3s3.6-1 4-3h5'/><path d='M8 8h8'/>",
  "smart-folder": "<path d='M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7.5Z'/><path d='M8 15c1.3-2.2 3-3.3 5.2-3.3 1.4 0 2.5.4 3.4 1.2'/><circle cx='17.6' cy='12.3' r='1.2'/>",
  "loading": "<path d='M12 3a9 9 0 1 0 9 9'/><path d='M12 3a8.8 8.8 0 0 1 6.4 2.6'/>",
  "offline": "<circle cx='12' cy='12' r='8.5'/><path d='m8.5 8.5 7 7M15.5 8.5l-7 7'/>",
  "online": "<circle cx='12' cy='12' r='8.5'/><path d='M8.5 12.2 10.8 14.5 15.5 9.5'/>",
  "stop": "<rect x='6' y='6' width='12' height='12' rx='3'/>",
  "restore": "<path d='M4 9v10h16V9M3 5h18v4H3z'/><path d='M8 14a4.5 4.5 0 0 1 8.2-2.5M8 14V10M8 14h4'/>",
  "search": "<circle cx='10.5' cy='10.5' r='6.5'/><path d='M15.4 15.4c1.4 1.1 2.8 2.5 4.6 4.6'/><path d='M7.5 8.4c1-1.5 3-2.1 4.7-1.4'/>",
  "note": "<path d='M5 3h14v13l-5 5H5V3Z'/><path d='M14 21v-5h5M8 8h8M8 12h6'/>",
};

/** Build the inline SVG icon for a Shadow DOM surface. Same geometry and
 *  stroke weight the previous mask technique used; `currentColor` keeps the
 *  icon following the semantic theme token on its host element. */
function lrCollectorIconSvg(name) {
  const geometry = lrCollectorIconGeometry[name];
  if (!geometry) return null;
  if (typeof document.createElementNS !== "function") return null;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "lr-icon");
  svg.innerHTML = geometry;
  return svg;
}

function lrCollectorSendRuntimeMessage(message, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (response) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(response || { ok: false, code: "extension-response-missing" });
    };
    const timer = window.setTimeout(
      () => finish({ ok: false, code: "extension-response-timeout" }),
      timeoutMs,
    );
    try {
      Promise.resolve(chrome.runtime.sendMessage(message)).then(finish, () => finish({
        ok: false,
        code: "extension-response-failed",
      }));
    } catch (_) {
      finish({ ok: false, code: "extension-response-failed" });
    }
  });
}

function lrCollectorAbsoluteUrl(value) {
  if (!value) return "";
  try {
    return new URL(value, window.location.href).href;
  } catch (_) {
    return "";
  }
}

// Removed in M1-S3 FIX-2: the loose lrCollectorBackgroundImage fallback could
// resurrect URLs (credentials, javascript:, overlong) that the strict
// protocol sanitizer rejected. CSS background now goes through the single
// LuckyRayExtensionProtocol.visualImageCandidate() resolver everywhere.

let lrCollectorLastImage = null;
let lrCollectorLastSentSrc = "";
let lrCollectorLastSentAt = 0;
let lrCollectorLastPoint = null;
let lrCollectorCurrentImageHit = null;
const lrCollectorDocumentToken = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
  ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const lrCollectorTargetTokens = new WeakMap();
const lrCollectorTargetElements = new Map();
let lrCollectorTargetSequence = 0;

function lrCollectorTargetToken(element) {
  if (!element || typeof element !== "object") return null;
  let token = lrCollectorTargetTokens.get(element);
  if (!token) {
    token = `${lrCollectorDocumentToken}:${++lrCollectorTargetSequence}`;
    lrCollectorTargetTokens.set(element, token);
  }
  lrCollectorTargetElements.set(token, element);
  return token;
}

function lrCollectorPointInRect(x, y, rect) {
  return Number.isFinite(x) && Number.isFinite(y)
    && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function lrCollectorImageInElementAtPoint(element, x, y) {
  if (!element || !(element instanceof Element) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const imgs = Array.from(element.querySelectorAll ? element.querySelectorAll("img") : []);
  const hits = [];
  for (const img of imgs) {
    const src = lrCollectorBestImageSrc(img);
    if (!src) continue;
    const rect = img.getBoundingClientRect();
    if (rect.width < 16 || rect.height < 16) continue;
    if (!lrCollectorPointInRect(x, y, rect)) continue;
    hits.push({ src, target: img, area: rect.width * rect.height });
  }
  hits.sort((a, b) => a.area - b.area);
  return hits[0] || null;
}

function lrCollectorFindImage(target, x, y) {
  let node = target instanceof Element ? target : target?.parentElement;
  for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
    if (node instanceof HTMLImageElement) {
      const src = lrCollectorBestImageSrc(node);
      return src ? { src, target: node } : null;
    }
    if (node instanceof HTMLSourceElement && node.srcset) {
      const src = lrCollectorAbsoluteUrl(node.srcset.split(",")[0].trim().split(/\s+/)[0]);
      return src ? { src, target: node } : null;
    }
    const pointedImage = lrCollectorImageInElementAtPoint(node, x, y);
    if (pointedImage) return pointedImage;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      const nestedImage = node.querySelector && node.querySelector("img");
      if (nestedImage) {
        const src = lrCollectorBestImageSrc(nestedImage);
        if (src) return { src, target: nestedImage };
      }
    }
    // M1-S3 FIX-2: one strict shared resolver (IMG handled above; VIDEO
    // poster, SVG <image> and CSS background here). A URL the strict policy
    // rejected must never be resurrected by a looser fallback.
    const visual = LuckyRayExtensionProtocol.visualImageCandidate(node);
    if (visual) return { src: visual.url, target: node };
  }
  return null;
}

function lrCollectorBestImageSrc(img) {
  if (!img) return "";
  return LuckyRayExtensionProtocol.selectImageCandidate(img, window.location.href)?.url || "";
}

const lrCollectorImageCollection = globalThis.LuckyRayImageCollection?.createDOMCollector({
  document, token: lrCollectorDocumentToken,
  resolve: node => LuckyRayExtensionProtocol.visualImageCandidate(node),
  targetFor: node => node instanceof HTMLSourceElement ? node.closest("picture")?.querySelector("img") || node : node,
  describe: (node, visual) => ({
    previewUrl: node instanceof HTMLImageElement ? lrCollectorAbsoluteUrl(node.currentSrc || node.src) : visual.url,
    previewLoaded: node instanceof HTMLImageElement && node.naturalWidth > 0,
    width: node instanceof HTMLImageElement ? node.naturalWidth : Math.round(node.getBoundingClientRect().width),
    height: node instanceof HTMLImageElement ? node.naturalHeight : Math.round(node.getBoundingClientRect().height),
    title: node.getAttribute?.("alt") || node.getAttribute?.("title") || "",
  }),
  descriptor: (target, entry) => LuckyRayExtensionProtocol.createCaptureDescriptor({
    type: "image", url: entry.url, browserUrl: entry.previewUrl,
    linkUrl: lrCollectorBoundImageWorkPage(target), capturedAt: Date.now(), confidence: "collection-grid",
    documentToken: lrCollectorDocumentToken, targetToken: lrCollectorTargetToken(target),
    scrollX: window.scrollX, scrollY: window.scrollY,
    targetKind: LuckyRayExtensionProtocol.visualImageCandidate(target)?.targetKind,
  }),
});
lrCollectorCleanups.push(() => lrCollectorImageCollection?.stop());
lrCollectorListenRuntime((message, _sender, sendResponse) => {
  if (!["luckyray-image-collection", "luckyray-image-renew"].includes(message?.type) || !lrCollectorIsTopFrame) return;
  const captureProtocolVersion = LuckyRayExtensionProtocol.CAPTURE_PROTOCOL_VERSION;
  if (!lrCollectorImageCollection) { sendResponse({ ok: false, captureProtocolVersion }); return true; }
  if (message.type === "luckyray-image-collection") sendResponse({ ok: true, captureProtocolVersion, pageUrl: window.location.href, ...lrCollectorImageCollection.snapshot(message.rescan === true) });
  else {
    const capture = message.pageUrl === window.location.href
      ? lrCollectorImageCollection.renew(message.id, message.url, message.session) : null;
    sendResponse({ ok: Boolean(capture), captureProtocolVersion, pageUrl: window.location.href, descriptor: capture });
  }
  return true;
});

let lrCollectorContextLink = null;
lrCollectorListen(document, "contextmenu", event => {
  const anchor = event.target?.closest?.("a[href]");
  lrCollectorContextLink = anchor ? { url: lrCollectorAbsoluteUrl(anchor.getAttribute("href")), text: anchor.textContent.trim().slice(0, 240), at: Date.now(), target: anchor,
    documentToken: lrCollectorDocumentToken, targetToken: lrCollectorTargetToken(anchor) } : null;
}, true);
lrCollectorListenRuntime((message, _sender, sendResponse) => {
  if (!["luckyray-context-link-text", "luckyray-context-link-verify"].includes(message?.type)) return;
  const link = lrCollectorContextLink;
  const valid = Boolean(link && link.target.isConnected && link.url === message.url && lrCollectorAbsoluteUrl(link.target.getAttribute("href")) === link.url && Date.now() - link.at < 60000
    && (message.type === "luckyray-context-link-text" || message.documentToken === lrCollectorDocumentToken && message.targetToken === link.targetToken));
  sendResponse({ ok: valid, captureProtocolVersion: LuckyRayExtensionProtocol.CAPTURE_PROTOCOL_VERSION, text: valid ? link.text : "", documentToken: lrCollectorDocumentToken, targetToken: valid ? link.targetToken : null });
  return true;
});

function lrCollectorRememberImage(src, linkUrl, point, target, confidence) {
  if (!src) return;
  const targetToken = lrCollectorTargetToken(target);
  // M1-S3 FIX-2: provenance comes from the single strict shared resolver so
  // capture and revalidation describe the same visual target (IMG HD/original,
  // poster, SVG href, background).
  const visual = LuckyRayExtensionProtocol.visualImageCandidate(target);
  const targetKind = visual?.targetKind
    || (target instanceof HTMLVideoElement ? "video-poster"
      : target instanceof HTMLImageElement ? "img"
        : String(target?.tagName || "").toUpperCase() === "IMAGE" ? "svg-image"
          : "background");
  const descriptor = LuckyRayExtensionProtocol.createCaptureDescriptor({
    type: "image",
    url: src,
    browserUrl: target instanceof HTMLImageElement
      ? lrCollectorAbsoluteUrl(target.currentSrc || target.src || "")
      : src,
    linkUrl: linkUrl || "",
    capturedAt: Date.now(),
    confidence: confidence || "hover-point",
    documentToken: lrCollectorDocumentToken,
    clientX: point?.x,
    clientY: point?.y,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    targetToken,
    source: visual?.source || null,
    targetKind,
    actionId: confidence === "contextmenu" ? `${lrCollectorDocumentToken}:image:${Date.now()}` : null,
  });
  if (!descriptor) return;
  const previousTargetToken = lrCollectorLastImage?.targetToken;
  lrCollectorLastImage = { ...descriptor, capturePageUrl: window.location.href };
  if (previousTargetToken && previousTargetToken !== targetToken && previousTargetToken !== lrCollectorLastVideo?.targetToken) {
    lrCollectorTargetElements.delete(previousTargetToken);
  }
  if (src === lrCollectorLastSentSrc && Date.now() - lrCollectorLastSentAt < 700) return;
  lrCollectorLastSentSrc = src;
  lrCollectorLastSentAt = Date.now();
  chrome.runtime.sendMessage({
    type: "luckyray-context-image",
    descriptor: lrCollectorLastImage,
  }).catch(() => {});
}

function lrCollectorImageCaptureAtCoordinates(x, y, target) {
  const elements = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [target];
  for (const element of elements) {
    const selected = LuckyRayExtensionProtocol.selectPointMedia("image", x, y, [element]);
    if (selected?.url) {
      const target = element instanceof HTMLSourceElement
        ? element.closest("picture")?.querySelector("img") || element
        : element;
      return { src: selected.url, target };
    }
    const nested = lrCollectorFindImage(element, x, y);
    if (nested?.src) return nested;
  }
  return null;
}

function lrCollectorImageAtPoint(event) {
  return lrCollectorImageCaptureAtCoordinates(event.clientX, event.clientY, event.target);
}

lrCollectorListen(document, "mousemove", (event) => {
  lrCollectorLastPoint = { x: event.clientX, y: event.clientY, capturedAt: Date.now() };
  const capture = lrCollectorImageAtPoint(event);
  lrCollectorCurrentImageHit = capture ? { x: event.clientX, y: event.clientY } : null;
  if (!capture?.src) return;
  const link = lrCollectorBoundImageWorkPage(capture.target);
  lrCollectorRememberImage(capture.src, link, lrCollectorLastPoint, capture.target, "hover-point");
}, true);

lrCollectorListen(document, "contextmenu", (event) => {
  lrCollectorLastPoint = { x: event.clientX, y: event.clientY, capturedAt: Date.now() };
  const capture = lrCollectorImageAtPoint(event);
  lrCollectorCurrentImageHit = capture ? { x: event.clientX, y: event.clientY } : null;
  if (!capture?.src) return;
  const link = lrCollectorBoundImageWorkPage(capture.target);
  lrCollectorRememberImage(capture.src, link, lrCollectorLastPoint, capture.target, "contextmenu");
}, true);

function lrCollectorPageAttribute(selector, attribute) {
  try {
    const element = document.querySelector(selector);
    return element && typeof element.getAttribute === "function" ? element.getAttribute(attribute) || "" : "";
  } catch (_) {
    return "";
  }
}

function lrCollectorArticleText() {
  const extract = (root) => {
    if (!root || typeof root.cloneNode !== "function") return "";
    const clone = root.cloneNode(true);
    const noise = clone.querySelectorAll
      ? Array.from(clone.querySelectorAll('script, style, noscript, form, nav, footer, header, aside, template, svg, iframe, object, embed, button, input, select, textarea, [hidden], [aria-hidden="true"], [role="navigation"], [role="banner"], [role="contentinfo"]')).slice(0, 2_048)
      : [];
    for (const element of noise) {
      try { element.remove(); } catch (_) {}
    }
    return String(clone.textContent || clone.innerText || "").trim();
  };
  try {
    const selectors = [
      '[itemprop="articleBody"]',
      ".RichContent-inner",
      ".Post-RichText",
      ".RichText",
      "article",
      "main article",
      '[role="main"] article',
      "main",
      '[role="main"]',
    ];
    let best = "";
    const seen = new Set();
    for (const selector of selectors) {
      const roots = typeof document.querySelectorAll === "function"
        ? Array.from(document.querySelectorAll(selector)).slice(0, 8)
        : [];
      for (const root of roots) {
        if (!root || seen.has(root)) continue;
        seen.add(root);
        const text = extract(root);
        if (text.length > best.length) best = text;
        if (text.length >= 40) return text;
      }
    }
    if (!best) best = extract(document.querySelector('article, main, [role="main"]') || document.body);
    return best;
  } catch (_) {
    return "";
  }
}

function lrCollectorJsonLdMetadata() {
  const candidates = [];
  let visited = 0;
  const scalar = (value) => typeof value === "string" || typeof value === "number" ? String(value) : "";
  const authorName = (value) => {
    if (Array.isArray(value)) return value.slice(0, 4).map(authorName).filter(Boolean).join(", ");
    if (value && typeof value === "object") return scalar(value.name);
    return scalar(value);
  };
  const imageUrl = (value) => {
    if (Array.isArray(value)) return imageUrl(value[0]);
    if (value && typeof value === "object") return scalar(value.url || value.contentUrl);
    return scalar(value);
  };
  const visit = (value, depth) => {
    if (depth > 4 || visited >= 128 || value == null) return;
    visited += 1;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 32)) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    const type = Array.isArray(value["@type"]) ? value["@type"].join(" ") : scalar(value["@type"]);
    const headline = scalar(value.headline || value.name);
    const articleBody = scalar(value.articleBody);
    const publishedAt = scalar(value.datePublished || value.dateModified);
    if (/article|posting|report|news/i.test(type) || value.headline || value.articleBody || value.datePublished) {
      candidates.push({
        headline,
        description: scalar(value.description),
        author: authorName(value.author),
        publishedAt,
        image: imageUrl(value.image || value.thumbnailUrl),
        articleBody,
        score: (articleBody ? 8 : 0) + (headline ? 4 : 0) + (publishedAt ? 2 : 0) + (/article|posting|news/i.test(type) ? 1 : 0),
      });
    }
    for (const key of ["@graph", "mainEntity", "mainEntityOfPage", "subjectOf", "itemListElement"]) {
      if (value[key] != null) visit(value[key], depth + 1);
    }
  };
  try {
    const scripts = typeof document.querySelectorAll === "function"
      ? Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 4)
      : [];
    for (const script of scripts) {
      const text = String(script?.textContent || "").trim();
      if (!text || text.length > 32_768) continue;
      try { visit(JSON.parse(text), 0); } catch (_) {}
    }
  } catch (_) {}
  candidates.sort((left, right) => right.score - left.score);
  return candidates[0] || {};
}

function lrCollectorPageSnapshot() {
  const structured = lrCollectorJsonLdMetadata();
  const extracted = globalThis.LuckyRayArticleExtractor?.extract(document);
  const description = lrCollectorPageAttribute('meta[name="description"]', "content")
    || lrCollectorPageAttribute('meta[property="og:description"]', "content")
    || lrCollectorPageAttribute('meta[name="twitter:description"]', "content")
    || structured.description;
  return LuckyRayExtensionProtocol.createPageSnapshot({
    url: window.location.href,
    canonicalUrl: lrCollectorPageAttribute('link[rel="canonical"]', "href"),
    title: document.title
      || lrCollectorPageAttribute('meta[property="og:title"]', "content")
      || lrCollectorPageAttribute('meta[name="twitter:title"]', "content")
      || structured.headline,
    description,
    author: lrCollectorPageAttribute('meta[name="author"]', "content")
      || lrCollectorPageAttribute('meta[property="article:author"]', "content")
      || structured.author,
    publishedAt: lrCollectorPageAttribute('meta[property="article:published_time"]', "content")
      || lrCollectorPageAttribute('meta[name="date"]', "content")
      || lrCollectorPageAttribute('time[datetime]', "datetime")
      || structured.publishedAt,
    selection: String(window.getSelection ? window.getSelection() || "" : ""),
    articleText: extracted ? (extracted.ok ? extracted.text : "") : lrCollectorArticleText(),
    markdown: extracted?.ok ? extracted.markdown : "",
    ogImage: lrCollectorPageAttribute('meta[property="og:image"]', "content")
      || lrCollectorPageAttribute('meta[name="twitter:image"]', "content")
      || structured.image,
  });
}

lrCollectorListenRuntime((message, _sender, sendResponse) => {
  if (message?.type === "luckyray-get-audio-candidates") {
    sendResponse({ ok: true, pageUrl: window.location.href, documentToken: lrCollectorDocumentToken,
      captureProtocolVersion: LuckyRayExtensionProtocol.CAPTURE_PROTOCOL_VERSION,
      candidates: LuckyRayAudioCollection.collect(document, window.location.href) });
    return;
  }
  if (message?.type !== "luckyray-get-page-context") return;
  sendResponse({
    ...(lrCollectorPageSnapshot() || {}),
    documentToken: lrCollectorDocumentToken,
    captureProtocolVersion: LuckyRayExtensionProtocol.CAPTURE_PROTOCOL_VERSION,
  });
  return true;
});

// D41c/D41f: 视频 hover 检测。优先找可下载的 http(s) 视频源；
// blob: 只能在页面内存中使用，后端无法直接下载，所以作为最后兜底并标记出来。
function lrCollectorVideoInElementAtPoint(element, x, y) {
  if (!element || !(element instanceof Element) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const videos = Array.from(element.querySelectorAll ? element.querySelectorAll("video, source[src], a[href]") : []);
  const hits = [];
  for (const item of videos) {
    const src = lrCollectorVideoSourceFromElement(item);
    if (!src) continue;
    const rectTarget = item instanceof HTMLSourceElement ? item.closest("video") : item;
    if (!rectTarget || !rectTarget.getBoundingClientRect) continue;
    const rect = rectTarget.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 24) continue;
    if (!lrCollectorPointInRect(x, y, rect)) continue;
    hits.push({ src, target: rectTarget, area: rect.width * rect.height });
  }
  hits.sort((a, b) => a.area - b.area);
  return hits[0] || null;
}

function lrCollectorFindVideo(target, x, y) {
  let node = target instanceof Element ? target : target?.parentElement;
  for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
    const src = lrCollectorVideoSourceFromElement(node);
    if (src) return { src, target: node };
    const pointedVideo = lrCollectorVideoInElementAtPoint(node, x, y);
    if (pointedVideo) return pointedVideo;
  }
  return null;
}

function lrCollectorVideoSourceFromElement(element) {
  if (!element || !(element instanceof Element)) return "";
  const selected = LuckyRayExtensionProtocol.selectVideoCandidate(element, window.location.href);
  return selected?.url || "";
}

function lrCollectorVideoElementAtCoordinates(x, y, target) {
  const elements = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [target];
  const candidates = [];
  const add = (video) => {
    if (!(video instanceof HTMLVideoElement) || !video.isConnected || !video.getBoundingClientRect) return;
    const rect = video.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 24 || !lrCollectorPointInRect(x, y, rect)) return;
    if (!candidates.some((item) => item.video === video)) candidates.push({ video, area: rect.width * rect.height });
  };
  for (const element of elements) {
    add(element);
    if (element instanceof Element) {
      add(element.closest?.("video"));
      for (const video of Array.from(element.querySelectorAll?.("video") || []).slice(0, 32)) add(video);
    }
  }
  candidates.sort((left, right) => left.area - right.area);
  return candidates[0]?.video || null;
}

function lrCollectorLooksLikeVideoUrl(value) {
  return /\.(mp4|webm|mov|m4v|ogv|ogg|avi|mkv)(\?|#|$)/i.test(value || "");
}

function lrCollectorVideoFromPerformance() {
  try {
    const entries = performance.getEntriesByType("resource") || [];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const name = entries[i] && entries[i].name;
      if (lrCollectorLooksLikeVideoUrl(name)) return lrCollectorAbsoluteUrl(name);
    }
  } catch (_) {}
  return "";
}

let lrCollectorLastVideo = null;
let lrCollectorLastVideoSentAt = 0;
let lrCollectorLastVideoPoint = null;
let lrCollectorCurrentVideoHit = null;
const lrCollectorMseCandidatesByVideo = new WeakMap();
const lrCollectorDrmVideos = new WeakSet();
const LR_COLLECTOR_MSE_HINT_TTL_MS = 10 * 60_000;
let lrCollectorSiteTrackPair = null;
let lrCollectorSiteVideoCandidate = null;
const lrCollectorPinterestCatalogsByVariant = new Map();
const lrCollectorPinterestDetailWaiters = new Map();
let lrCollectorPinterestDetailSequence = 0;

function lrCollectorPinterestVariantKey(value) {
  try {
    const parsed = new URL(String(value || ""));
    const host = parsed.hostname.toLowerCase();
    if (!(host === "pinimg.com" || host.endsWith(".pinimg.com"))) return "";
    return `${host}${parsed.pathname}`.toLowerCase();
  } catch (_) {
    return "";
  }
}

function lrCollectorPinterestCatalogForVideo(video, nativeCandidates = null) {
  if (!(video instanceof HTMLVideoElement)) return null;
  const candidates = nativeCandidates || LuckyRayExtensionProtocol.collectVideoElementCandidates(video, window.location.href);
  for (const candidate of candidates) {
    const key = lrCollectorPinterestVariantKey(candidate?.url);
    const catalog = key && lrCollectorPinterestCatalogsByVariant.get(key);
    if (catalog && Date.now() - catalog.observedAt <= LR_COLLECTOR_MSE_HINT_TTL_MS) return catalog;
  }
  return null;
}

function lrCollectorPinterestPageIdentity(value) {
  try {
    const current = new URL(String(window.location.href || ""));
    const page = new URL(String(value || ""));
    const host = current.hostname.toLowerCase();
    const match = page.pathname.match(/^\/pin\/(\d{6,32})\/$/);
    if (!(host === "pinterest.com" || host.endsWith(".pinterest.com"))
      || page.origin !== current.origin || page.search || page.hash || !match) return null;
    return { pinId: match[1], pageUrl: page.href };
  } catch (_) {
    return null;
  }
}

function lrCollectorRequestPinterestDetailCatalog(pageUrl) {
  const identity = lrCollectorPinterestPageIdentity(pageUrl);
  if (!identity || lrCollectorPinterestDetailWaiters.size >= 4
    || typeof document.dispatchEvent !== "function" || typeof CustomEvent !== "function") {
    return Promise.resolve(null);
  }
  const requestId = `pdetail:${lrCollectorDocumentToken}:${++lrCollectorPinterestDetailSequence}`;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      lrCollectorPinterestDetailWaiters.delete(requestId);
      resolve(null);
    }, 5_500);
    lrCollectorPinterestDetailWaiters.set(requestId, {
      pinId: identity.pinId,
      resolve: (catalog) => {
        window.clearTimeout(timer);
        lrCollectorPinterestDetailWaiters.delete(requestId);
        resolve(catalog || null);
      },
    });
    try {
      document.dispatchEvent(new CustomEvent("__luckyray_pinterest_detail_request_v1__", {
        detail: Object.freeze({ version: 1, requestId, ...identity }),
      }));
    } catch (_) {
      window.clearTimeout(timer);
      lrCollectorPinterestDetailWaiters.delete(requestId);
      resolve(null);
    }
  });
}

function lrCollectorUpgradePinterestDescriptor(descriptor, catalog) {
  if (!descriptor || !catalog?.variants?.length) return descriptor;
  const candidates = [];
  const seen = new Set();
  for (const raw of [
    ...catalog.variants.map((variant) => ({
      ...variant,
      contentType: "video/mp4",
      source: "pinterest-detail",
      binding: "pinterest-catalog",
    })),
    ...Array.from(descriptor.playerCandidates || []),
  ]) {
    const url = lrCollectorSafeHttpMediaUrl(raw?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    candidates.push({ ...raw, url });
    if (candidates.length >= 16) break;
  }
  return { ...descriptor, resolverPageUrl: catalog.pageUrl, playerCandidates: candidates };
}

function lrCollectorPrimaryVideo() {
  let primary = null;
  let primaryArea = 0;
  for (const video of Array.from(document.querySelectorAll?.("video") || []).slice(0, 64)) {
    if (!(video instanceof HTMLVideoElement) || !video.isConnected) continue;
    const rect = video.getBoundingClientRect?.();
    if (!rect || rect.width < 160 || rect.height < 90 || rect.right <= 0 || rect.bottom <= 0) continue;
    const area = Math.min(rect.width, Number(window.innerWidth || rect.width))
      * Math.min(rect.height, Number(window.innerHeight || rect.height));
    if (area > primaryArea) {
      primary = video;
      primaryArea = area;
    }
  }
  return primary;
}

function lrCollectorVideosForBlobUrl(blobUrl) {
  if (!String(blobUrl || "").startsWith("blob:") || String(blobUrl).length > 4_096) return [];
  try {
    return Array.from(document.querySelectorAll?.("video") || []).filter((video) => (
      video instanceof HTMLVideoElement
      && video.isConnected
      && (String(video.currentSrc || "") === blobUrl || String(video.src || "") === blobUrl)
    )).slice(0, 64);
  } catch (_) {
    return [];
  }
}

function lrCollectorBoundVideoCandidates(video) {
  const native = LuckyRayExtensionProtocol.collectVideoElementCandidates(video, window.location.href);
  const now = Date.now();
  const pinterestCatalog = lrCollectorPinterestCatalogForVideo(video, native);
  const pinterestVariants = Array.from(pinterestCatalog?.variants || []).map((variant) => ({
    ...variant,
    contentType: "video/mp4",
    source: "pinterest-catalog",
    binding: "pinterest-catalog",
  }));
  const probed = (lrCollectorMseCandidatesByVideo.get(video) || [])
    .filter((candidate) => now - candidate.observedAt <= LR_COLLECTOR_MSE_HINT_TTL_MS)
    .slice(-16)
    .map(({ observedAt: _observedAt, ...candidate }) => candidate);
  const sitePair = lrCollectorSiteTrackPair
    && now - lrCollectorSiteTrackPair.observedAt <= LR_COLLECTOR_MSE_HINT_TTL_MS
    && video === lrCollectorPrimaryVideo()
    && LuckyRayExtensionProtocol.normalizeSupportedVideoPageUrl(window.location.href)
      === lrCollectorSiteTrackPair.pageUrl
    ? [lrCollectorSiteTrackPair]
    : [];
  const siteVideo = lrCollectorSiteVideoCandidate
    && now - lrCollectorSiteVideoCandidate.observedAt <= LR_COLLECTOR_MSE_HINT_TTL_MS
    && video === lrCollectorPrimaryVideo()
    && LuckyRayExtensionProtocol.normalizeSupportedVideoPageUrl(window.location.href)
      === lrCollectorSiteVideoCandidate.pageUrl
    ? [lrCollectorSiteVideoCandidate]
    : [];
  return [...sitePair, ...siteVideo, ...pinterestVariants, ...native, ...probed].slice(0, 24);
}

lrCollectorListen(document, "__luckyray_page_media_probe_v1__", (event) => {
  const detail = event?.detail;
  if (!detail || detail.version !== 1) return;
  if (detail.kind === "pinterest-video-catalog") {
    const pinId = String(detail.pinId || "");
    const pageUrl = LuckyRayExtensionProtocol.normalizeSupportedVideoPageUrl(detail.pageUrl);
    if (!/^\d{6,32}$/.test(pinId) || !pageUrl || !pageUrl.includes(`/pin/${pinId}/`)) return;
    const variants = Array.from(detail.variants || []).slice(0, 16).flatMap((raw) => {
      const url = lrCollectorSafeHttpMediaUrl(raw?.url);
      const key = lrCollectorPinterestVariantKey(url);
      if (!key) return [];
      return [{
        url,
        width: Math.max(0, Math.min(16_384, Math.trunc(Number(raw?.width) || 0))),
        height: Math.max(0, Math.min(16_384, Math.trunc(Number(raw?.height) || 0))),
      }];
    }).sort((left, right) => right.height - left.height || right.width - left.width);
    if (!variants.length) return;
    const catalog = { pinId, pageUrl, variants, observedAt: Date.now() };
    for (const variant of variants) {
      const key = lrCollectorPinterestVariantKey(variant.url);
      if (key) lrCollectorPinterestCatalogsByVariant.set(key, catalog);
    }
    while (lrCollectorPinterestCatalogsByVariant.size > 256) {
      lrCollectorPinterestCatalogsByVariant.delete(lrCollectorPinterestCatalogsByVariant.keys().next().value);
    }
    const requestId = /^pdetail:[a-z0-9:._-]{1,160}$/i.test(String(detail.requestId || ""))
      ? String(detail.requestId) : "";
    const waiter = requestId && lrCollectorPinterestDetailWaiters.get(requestId);
    if (waiter && waiter.pinId === pinId) waiter.resolve(catalog);
    return;
  }
  if (detail.kind === "site-track-pair") {
    const pageUrl = LuckyRayExtensionProtocol.normalizeSupportedVideoPageUrl(detail.pageUrl);
    const currentPage = LuckyRayExtensionProtocol.normalizeSupportedVideoPageUrl(window.location.href);
    const videoUrl = lrCollectorSafeHttpMediaUrl(detail.videoUrl);
    const audioUrl = lrCollectorSafeHttpMediaUrl(detail.audioUrl);
    if (!pageUrl || pageUrl !== currentPage || !videoUrl || !audioUrl || videoUrl === audioUrl) return;
    lrCollectorSiteTrackPair = {
      url: videoUrl,
      audioUrl,
      contentType: String(detail.contentType || "video/mp4").slice(0, 96),
      width: Math.max(0, Math.min(16_384, Math.trunc(Number(detail.width) || 0))),
      height: Math.max(0, Math.min(16_384, Math.trunc(Number(detail.height) || 0))),
      bitrate: Math.max(0, Math.min(1_000_000_000, Math.trunc(Number(detail.bitrate) || 0))),
      binding: "site-track-pair",
      pageUrl,
      observedAt: Date.now(),
    };
    chrome.runtime.sendMessage({
      type: "luckyray-site-track-pair",
      pair: { ...lrCollectorSiteTrackPair },
    }).catch(() => {});
    return;
  }
  if (detail.kind === "site-video-candidate") {
    const pageUrl = LuckyRayExtensionProtocol.normalizeSupportedVideoPageUrl(detail.pageUrl);
    const currentPage = LuckyRayExtensionProtocol.normalizeSupportedVideoPageUrl(window.location.href);
    const videoUrl = lrCollectorSafeHttpMediaUrl(detail.videoUrl);
    let trustedShape = false;
    try {
      const pageHost = new URL(pageUrl).hostname.toLowerCase();
      const mediaHost = new URL(videoUrl).hostname.toLowerCase();
      trustedShape = (pageHost === "x.com" || pageHost.endsWith(".x.com")
        || pageHost === "twitter.com" || pageHost.endsWith(".twitter.com"))
        && (mediaHost === "twimg.com" || mediaHost.endsWith(".twimg.com"));
    } catch (_) {}
    if (!pageUrl || pageUrl !== currentPage || !videoUrl || !trustedShape) return;
    lrCollectorSiteVideoCandidate = {
      url: videoUrl,
      contentType: String(detail.contentType || "video/mp4").slice(0, 96),
      bitrate: Math.max(0, Math.min(1_000_000_000, Math.trunc(Number(detail.bitrate) || 0))),
      binding: "site-probe",
      pageUrl,
      observedAt: Date.now(),
    };
    return;
  }
  const videos = lrCollectorVideosForBlobUrl(String(detail.blobUrl || ""));
  if (!videos.length) return;
  if (detail.kind === "drm") {
    for (const video of videos) lrCollectorDrmVideos.add(video);
    return;
  }
  if (detail.kind !== "mse-candidate") return;
  const url = lrCollectorSafeHttpMediaUrl(detail.candidateUrl);
  if (!url) return;
  const contentType = String(detail.contentType || "").slice(0, 96);
  for (const video of videos) {
    const current = (lrCollectorMseCandidatesByVideo.get(video) || [])
      .filter((candidate) => Date.now() - candidate.observedAt <= LR_COLLECTOR_MSE_HINT_TTL_MS);
    const next = current.filter((candidate) => candidate.url !== url);
    next.push({
      url,
      contentType,
      width: Number(video.videoWidth || 0),
      height: Number(video.videoHeight || 0),
      binding: "mse-probe",
      observedAt: Date.now(),
    });
    lrCollectorMseCandidatesByVideo.set(video, next.slice(-16));
  }
}, true);

function lrCollectorRememberVideo(src, point, target, confidence) {
  if (!src) return;
  const targetToken = lrCollectorTargetToken(target);
  const previousTargetToken = lrCollectorLastVideo?.targetToken;
  const boundWork = lrCollectorBoundVideoWorkPage(target) || null;
  const suppressPublish = confidence !== "contextmenu" && lrCollectorLastVideo
    && src === lrCollectorLastVideo.url && targetToken === previousTargetToken
    && boundWork === lrCollectorLastVideo.materialSourcePageUrl
    && Date.now() - lrCollectorLastVideoSentAt < 700;
  lrCollectorLastVideo = LuckyRayExtensionProtocol.createCaptureDescriptor({
    type: "video",
    url: src,
    capturedAt: Date.now(),
    confidence: confidence || "hover-point",
    documentToken: lrCollectorDocumentToken,
    clientX: point?.x,
    clientY: point?.y,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    targetToken,
    materialSourcePageUrl: boundWork,
    actionId: confidence === "contextmenu" ? `${lrCollectorDocumentToken}:video:${Date.now()}` : null,
  });
  if (!lrCollectorLastVideo) return;
  if (previousTargetToken && previousTargetToken !== targetToken && previousTargetToken !== lrCollectorLastImage?.targetToken) {
    lrCollectorTargetElements.delete(previousTargetToken);
  }
  if (suppressPublish) return;
  lrCollectorLastVideoSentAt = Date.now();
  chrome.runtime.sendMessage({
    type: "luckyray-context-video",
    descriptor: lrCollectorLastVideo,
  }).catch(() => {});
}

function lrCollectorVideoCaptureAtCoordinates(x, y, target, opts = {}) {
  const elements = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [target];
  for (const element of elements) {
    const selected = LuckyRayExtensionProtocol.selectPointMedia("video", x, y, [element]);
    if (selected?.url) return { src: selected.url, target: element };
    const nested = lrCollectorFindVideo(element, x, y);
    if (nested?.src) return nested;
  }
  if (opts.allowPerformance) {
    const src = lrCollectorVideoFromPerformance();
    if (src) return { src, target: null };
  }
  return null;
}

lrCollectorListen(document, "mousemove", (event) => {
  lrCollectorLastVideoPoint = { x: event.clientX, y: event.clientY, capturedAt: Date.now() };
  const capture = lrCollectorVideoCaptureAtCoordinates(event.clientX, event.clientY, event.target, { allowPerformance: false });
  lrCollectorCurrentVideoHit = capture ? { x: event.clientX, y: event.clientY } : null;
  if (capture?.src) lrCollectorRememberVideo(capture.src, lrCollectorLastVideoPoint, capture.target, "hover-point");
  const exactVideo = capture?.target instanceof HTMLVideoElement
    ? capture.target
    : lrCollectorVideoElementAtCoordinates(event.clientX, event.clientY, event.target);
  lrCollectorTrackVideoOverlay(exactVideo);
}, true);

lrCollectorListen(document, "contextmenu", (event) => {
  lrCollectorLastVideoPoint = { x: event.clientX, y: event.clientY, capturedAt: Date.now() };
  const capture = lrCollectorVideoCaptureAtCoordinates(event.clientX, event.clientY, event.target, { allowPerformance: false });
  lrCollectorCurrentVideoHit = capture ? { x: event.clientX, y: event.clientY } : null;
  if (capture?.src) lrCollectorRememberVideo(capture.src, lrCollectorLastVideoPoint, capture.target, "contextmenu");
}, true);

let lrCollectorLastContext = { kind: "page", capturedAt: 0 };
let lrCollectorLastPublishedContext = "";
let lrCollectorLastContextSentAt = 0;

function lrCollectorContextKind(event) {
  const selection = String(window.getSelection ? window.getSelection() || "" : "").trim();
  const currentVideo = lrCollectorCurrentVideoHit?.x === event.clientX
    && lrCollectorCurrentVideoHit?.y === event.clientY;
  const currentImage = lrCollectorCurrentImageHit?.x === event.clientX
    && lrCollectorCurrentImageHit?.y === event.clientY;
  const link = event.target instanceof Element && typeof event.target.closest === "function"
    ? event.target.closest("a[href]") : null;
  return selection ? "selection" : currentVideo ? "video" : currentImage ? "image" : link ? "link" : "page";
}

function lrCollectorPublishContextKind(kind, force) {
  const now = Date.now();
  lrCollectorLastContext = {
    kind,
    capturedAt: now,
  };
  if (!force && kind === lrCollectorLastPublishedContext && now - lrCollectorLastContextSentAt < 800) return;
  lrCollectorLastPublishedContext = kind;
  lrCollectorLastContextSentAt = now;
  chrome.runtime.sendMessage({
    type: "luckyray-context-kind",
    captureProtocolVersion: LuckyRayExtensionProtocol.CAPTURE_PROTOCOL_VERSION,
    contextKind: kind,
  }).catch(() => {});
}

lrCollectorListen(document, "mousemove", (event) => {
  lrCollectorPublishContextKind(lrCollectorContextKind(event), false);
}, true);

lrCollectorListen(document, "contextmenu", (event) => {
  lrCollectorPublishContextKind(lrCollectorContextKind(event), true);
}, true);

lrCollectorListen(document, "selectionchange", () => {
  if (String(window.getSelection ? window.getSelection() || "" : "").trim()) {
    lrCollectorPublishContextKind("selection", true);
  }
}, true);

lrCollectorListenRuntime((message, _sender, sendResponse) => {
  if (message?.type !== "luckyray-get-context-kind") return;
  const fresh = Date.now() - Number(lrCollectorLastContext.capturedAt || 0) <= 2_000;
  sendResponse({
    captureProtocolVersion: LuckyRayExtensionProtocol.CAPTURE_PROTOCOL_VERSION,
    contextKind: fresh ? lrCollectorLastContext.kind : "page",
  });
  return true;
});

lrCollectorListenRuntime((message, _sender, sendResponse) => {
  if (message?.type !== "luckyray-get-hover-image") return;
  const current = lrCollectorLastImage;
  const target = current?.targetToken ? lrCollectorTargetElements.get(current.targetToken) : null;
  // M1-S3 FIX-2: revalidation re-resolves the visual target through the same
  // strict shared resolver used at capture time (IMG HD/original, poster,
  // SVG href, background) — a rejected URL cannot be revived here either.
  const targetUrl = target ? (LuckyRayExtensionProtocol.visualImageCandidate(target)?.url || "") : "";
  const liveLink = target instanceof Element ? lrCollectorBoundImageWorkPage(target) : "";
  const capturedLink = LuckyRayExtensionProtocol.normalizeBoundWorkPageUrl(current?.linkUrl || "");
  const capture = current && current.capturePageUrl === window.location.href
    && LuckyRayExtensionProtocol.resolveCapturedDescriptor(current, {
      now: Date.now(),
      documentToken: lrCollectorDocumentToken,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      targetToken: current.targetToken,
      targetConnected: Boolean(target && target.isConnected),
      targetUrl,
    }) && liveLink === capturedLink ? current : null;
  sendResponse(capture || {});
  return true;
});

// D41c: popup 询问 hover video
lrCollectorListenRuntime((message, _sender, sendResponse) => {
  if (message?.type === "luckyray-get-hover-video") {
    const current = lrCollectorLastVideo;
    const target = current?.targetToken ? lrCollectorTargetElements.get(current.targetToken) : null;
    const capture = current && LuckyRayExtensionProtocol.resolveCapturedDescriptor(current, {
      now: Date.now(),
      documentToken: lrCollectorDocumentToken,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      targetToken: current.targetToken,
      targetConnected: Boolean(target && target.isConnected),
      targetUrl: lrCollectorVideoSourceFromElement(target),
    });
    const boundWork = target ? lrCollectorBoundVideoWorkPage(target) : "";
    if (!capture || (capture.materialSourcePageUrl || "") !== boundWork) { sendResponse({}); return true; }
    // Only resolve the exact live context-menu player. Its blob URL is still
    // returned as browserUrl so the service worker can cross-check srcUrl.
    // Never borrow the feed's unbound network/performance candidate list.
    if (message.resolvePlayable && capture.confidence === "contextmenu" && target instanceof HTMLVideoElement && !capture.importable) {
      const direct = lrCollectorBoundVideoCandidates(target).find(candidate =>
        LuckyRayExtensionProtocol.isVideoUrlImportable(candidate.url));
      if (direct) { sendResponse({ ...capture, browserUrl: capture.url, url: direct.url, importable: true }); return true; }
    }
    sendResponse(capture);
    return true;
  }
});

// Video capture surface: every real player owns a separate page-isolated chip.
// Keeping the target inside the overlay instance prevents a later hover on a
// different card from silently retargeting an already-visible action.
const lrCollectorVideoOverlayByTarget = new WeakMap();
const lrCollectorVideoOverlays = new Set();
let lrCollectorVideoOverlaysEnabled = !globalThis.LuckyRayVideoOverlayPreference; // Legacy receivers/tests without the preference module keep their original default.
let lrCollectorHoveredVideo = null;
if (globalThis.LuckyRayVideoOverlayPreference) lrCollectorCleanups.push(LuckyRayVideoOverlayPreference.subscribe(enabled => {
  if (lrCollectorDisposed) return;
  lrCollectorVideoOverlaysEnabled = enabled;
  if (!enabled) for (const overlay of lrCollectorVideoOverlays) {
    if (overlay.hideTimer) window.clearTimeout(overlay.hideTimer);
    overlay.hideTimer = 0;
    overlay.setOpen(false);
    overlay.host.style.display = "none";
  }
  else if (lrCollectorHoveredVideo?.isConnected) lrCollectorTrackVideoOverlay(lrCollectorHoveredVideo);
}));

function lrCollectorDescriptorForVideo(target) {
  if (!(target instanceof HTMLVideoElement) || !target.isConnected) return null;
  const url = lrCollectorVideoSourceFromElement(target);
  if (!url) return null;
  return LuckyRayExtensionProtocol.createCaptureDescriptor({
    type: "video",
    url,
    capturedAt: Date.now(),
    confidence: "player-chip",
    documentToken: lrCollectorDocumentToken,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    targetToken: lrCollectorTargetToken(target),
  });
}

function lrCollectorResolverPageForVideo(target) {
  const current = String(window.location.href || "");
  const catalog = lrCollectorPinterestCatalogForVideo(target);
  if (catalog?.pageUrl) return catalog.pageUrl;
  const boundWork = lrCollectorBoundVideoWorkPage(target);
  if (boundWork) return LuckyRayExtensionProtocol.normalizeSupportedVideoPageUrl(boundWork);
  // Keep the existing supported detail-page resolver for a page-level player,
  // but never borrow it for a distinct related-card target. This resolver is
  // not evidence that the material source is a work-page.
  return lrCollectorNearestCard(target) ? ""
    : LuckyRayExtensionProtocol.chooseBoundVideoPageUrl(current, []);
}

function lrCollectorIsCardBoundary(node) {
  const tag = String(node?.tagName || "").toUpperCase();
  const marker = String(node?.getAttribute?.("data-testid")
    || node?.getAttribute?.("data-test-id") || "").toLowerCase();
  return tag === "ARTICLE" || tag === "LI" || node?.getAttribute?.("role") === "listitem"
    || Boolean(node?.getAttribute?.("data-pin-id") || node?.getAttribute?.("data-test-pin-id"))
    || /^(?:pin|work|artwork|post|card)(?:-|$)/.test(marker);
}

function lrCollectorNearestCard(target) {
  let node = target?.parentElement;
  for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
    if (lrCollectorIsCardBoundary(node)) return node;
  }
  return null;
}

function lrCollectorDirectTargetLink(target) {
  const closest = target?.closest?.("a[href]");
  if (closest?.href) return closest.href;
  let node = target?.parentElement;
  for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
    if (node.matches?.("a[href]") || String(node.tagName || "").toUpperCase() === "A") return node.href || "";
    if (lrCollectorIsCardBoundary(node)) break;
  }
  return "";
}

function lrCollectorBoundCardWorkPage(target, mediaType) {
  const normalize = mediaType === "video"
    ? (value) => {
      const page = LuckyRayExtensionProtocol.normalizeSourcePageUrl(value);
      return LuckyRayExtensionProtocol.normalizeSupportedVideoPageUrl(page) ? page : "";
    }
    : LuckyRayExtensionProtocol.normalizeBoundWorkPageUrl;
  const direct = normalize(lrCollectorDirectTargetLink(target));
  if (direct) return direct;
  const card = lrCollectorNearestCard(target);
  if (!card) return "";
  // A larger container with multiple visual targets cannot lend its sole
  // anchor to one particular target. Never climb beyond this boundary.
  if (Array.from(card.querySelectorAll?.("img,video") || []).length > 1) return "";
  if (mediaType === "video") {
    const pinId = String(card.getAttribute?.("data-pin-id")
      || card.getAttribute?.("data-test-pin-id") || "");
    if (/^\d{6,32}$/.test(pinId)) {
      const current = LuckyRayExtensionProtocol.normalizeSourcePageUrl(window.location.href);
      if (current) {
        const pin = normalize(`${new URL(current).origin}/pin/${pinId}/`);
        if (pin) return pin;
      }
    }
  }
  const matches = Array.from(card.querySelectorAll?.("a[href]") || []).slice(0, 32)
    .map((link) => normalize(link.href)).filter(Boolean);
  return new Set(matches).size === 1 ? matches[0] : "";
}

function lrCollectorBoundImageWorkPage(target) {
  return lrCollectorBoundCardWorkPage(target, "image");
}

function lrCollectorBoundVideoWorkPage(target) {
  const bound = lrCollectorBoundCardWorkPage(target, "video");
  if (bound) return bound;
  // A detail tab may also contain unrelated players. Without target-bound
  // evidence, the tab URL is only a capture page, even if its route is known.
  return "";
}

function lrCollectorVideoSourcePage(target) {
  const work = lrCollectorBoundVideoWorkPage(target);
  const page = LuckyRayExtensionProtocol.normalizeSourcePageUrl(window.location.href);
  return work
    ? { sourcePageUrl: work, sourcePageKind: "work-page" }
    : { sourcePageUrl: page, sourcePageKind: "capture-page" };
}

function lrCollectorEnsureVideoOverlay(target) {
  if (!lrCollectorVideoOverlaysEnabled) return null;
  if (!(target instanceof HTMLVideoElement) || !target.isConnected) return null;
  const existing = lrCollectorVideoOverlayByTarget.get(target);
  if (existing) {
    lrCollectorVideoOverlays.add(existing);
    return existing;
  }
  if (typeof document.createElement !== "function" || !document.documentElement) return null;
  const host = document.createElement("div");
  host.setAttribute("data-luckyray-video-capture", "");
  host.style.cssText = "all:initial;position:fixed;display:none;z-index:2147483646;pointer-events:none;";
  if (globalThis.LuckyRayAppearance) lrCollectorCleanups.push(LuckyRayAppearance.bindSurface(host));
  const shadow = typeof host.attachShadow === "function" ? host.attachShadow({ mode: "closed" }) : host;
  const style = document.createElement("style");
  style.textContent = lrCollectorShadowThemeTokens + `
    *{box-sizing:border-box}
    /* Icons are inline SVG children (lrCollectorIconSvg): a strict page CSP
       blocks data:-URL mask fetches at the document level and Shadow DOM does
       not isolate that, so the mask technique renders as an empty box there.
       Inline SVG performs no fetch at all. */
    .lr-chip .lr-icon{width:17px;height:17px}
    .lr-close .lr-icon{width:15px;height:15px}
    .lr-chip{width:34px;height:34px;border:1px solid var(--lr-border-strong);border-radius:var(--lr-radius-md);background:var(--lr-glass);color:var(--lr-accent-text,var(--lr-accent));box-shadow:0 10px 26px rgba(0,0,0,.34);display:grid;place-items:center;cursor:pointer;-webkit-backdrop-filter:var(--lr-glass-filter);backdrop-filter:var(--lr-glass-filter);transition:transform var(--lr-dur) var(--lr-ease),background var(--lr-dur) var(--lr-ease),border-color var(--lr-dur) var(--lr-ease),box-shadow var(--lr-dur) var(--lr-ease);pointer-events:auto}
    .lr-chip:hover,.lr-chip[aria-expanded="true"]{transform:translateY(-1px);border-color:var(--lr-accent-line);background:var(--lr-accent-soft);box-shadow:0 12px 30px rgba(0,0,0,.4)}
    .lr-chip:focus-visible{outline:2px solid var(--lr-accent);outline-offset:2px}
    .lr-panel{position:absolute;top:42px;right:0;width:min(348px,calc(100vw - 24px));max-height:min(460px,calc(100vh - 70px));overflow:auto;padding:12px;border:1px solid var(--lr-border-strong);border-radius:var(--lr-radius-lg);background:var(--lr-glass);box-shadow:var(--lr-shadow-lg);font:12.5px/1.45 var(--lr-font);color:var(--lr-text);pointer-events:auto;display:none;-webkit-backdrop-filter:var(--lr-glass-filter);backdrop-filter:var(--lr-glass-filter);scrollbar-color:var(--lr-border-strong) transparent;scrollbar-width:thin}
    .lr-panel[data-open="true"]{display:block;animation:lr-in var(--lr-dur) var(--lr-ease)}
    @keyframes lr-in{from{opacity:0;transform:translateY(-6px) scale(.985)}to{opacity:1;transform:none}}
    .lr-head{display:flex;align-items:center;justify-content:space-between;padding:1px 2px 10px}.lr-brand{display:flex;gap:8px;align-items:center;font-weight:700;font-size:12.5px;color:var(--lr-text)}.lr-mark{color:var(--lr-accent-text,var(--lr-accent));font-family:var(--lr-font-label);font-size:9.5px;letter-spacing:.14em;line-height:1}.lr-close{display:grid;place-items:center;width:26px;height:26px;border:1px solid transparent;border-radius:var(--lr-radius-xs);background:transparent;color:var(--lr-text-faint);cursor:pointer;transition:color var(--lr-dur) var(--lr-ease),background var(--lr-dur) var(--lr-ease),border-color var(--lr-dur) var(--lr-ease)}.lr-close:hover{color:var(--lr-text);background:var(--lr-surface-hover);border-color:var(--lr-border)}
    .lr-list{display:grid;gap:6px}.lr-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;padding:9px 10px;border:1px solid var(--lr-border);border-radius:var(--lr-radius-md);background:var(--lr-surface-raised);transition:border-color var(--lr-dur) var(--lr-ease),background var(--lr-dur) var(--lr-ease),transform var(--lr-dur-fast) var(--lr-ease)}.lr-item:hover{border-color:var(--lr-accent-line);transform:translateY(-1px)}
    .lr-copy{min-width:0}.lr-quality{font-weight:650;color:var(--lr-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.lr-host{margin-top:3px;color:var(--lr-text-faint);font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.lr-progress{display:none;position:relative;height:4px;margin-top:7px;overflow:hidden;border-radius:var(--lr-radius-pill);background:var(--lr-border)}.lr-progress[data-visible="true"]{display:block}.lr-progress>i{display:block;width:0;height:100%;border-radius:inherit;background:var(--lr-accent);transition:width var(--lr-dur) var(--lr-ease)}.lr-progress[data-indeterminate="true"]>i{width:38%!important;animation:lr-progress 1s var(--lr-ease) infinite}@keyframes lr-progress{from{transform:translateX(-110%)}to{transform:translateX(300%)}}.lr-actions{display:flex;gap:5px}.lr-action{border:1px solid var(--lr-border-strong);border-radius:var(--lr-radius-sm);background:var(--lr-surface);color:var(--lr-text-muted);padding:7px 9px;font:600 11px/1 var(--lr-font);cursor:pointer;transition:border-color var(--lr-dur) var(--lr-ease),color var(--lr-dur) var(--lr-ease),background var(--lr-dur) var(--lr-ease)}.lr-action:hover{border-color:var(--lr-accent-line);color:var(--lr-accent-text,var(--lr-accent));background:var(--lr-surface-hover)}.lr-action:focus-visible{outline:2px solid var(--lr-accent);outline-offset:2px}.lr-action[data-primary="true"]{background:var(--lr-accent);color:var(--lr-accent-ink);border-color:var(--lr-accent)}.lr-action[data-primary="true"]:hover{background:var(--lr-accent-hover);color:var(--lr-accent-ink)}
    .lr-record{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;margin-top:8px;border:1px solid var(--lr-accent-line);border-radius:var(--lr-radius-md);background:var(--lr-accent-soft);color:var(--lr-accent-text,var(--lr-accent));padding:9px;font:650 12px/1 var(--lr-font);cursor:pointer;transition:background var(--lr-dur) var(--lr-ease),border-color var(--lr-dur) var(--lr-ease)}.lr-record:hover{background:var(--lr-surface-hover)}.lr-cancel{border:0;background:transparent;color:var(--lr-danger);padding:6px 2px;font:600 11px/1 var(--lr-font);cursor:pointer}.lr-cancel:disabled{opacity:.55;cursor:default}.lr-status{min-height:17px;padding:9px 2px 1px;color:var(--lr-text-faint);font-size:10.5px;line-height:1.5}.lr-status[data-error="true"]{color:var(--lr-danger)}.lr-empty{padding:20px 8px;text-align:center;color:var(--lr-text-muted);font-size:11.5px}
    .lr-state{display:grid;place-items:center;padding:8px 10px;margin-bottom:6px;border:1px solid var(--lr-accent-line);border-radius:var(--lr-radius-sm);background:var(--lr-accent-soft);color:var(--lr-accent-text,var(--lr-accent));font:650 11.5px/1.3 var(--lr-font);text-align:center}.lr-state[data-state="blocked"]{border-color:var(--lr-danger);background:var(--lr-surface-sunken);color:var(--lr-danger)}.lr-state[data-state="needs-play"]{border-color:var(--lr-border);background:var(--lr-surface-sunken);color:var(--lr-text-muted)}
  `;
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "lr-chip";
  chip.setAttribute("aria-label", "LuckyRay 视频捕获");
  chip.setAttribute("aria-expanded", "false");
  const chipIcon = lrCollectorIconSvg("video");
  if (chipIcon) chip.append(chipIcon);
  const panel = document.createElement("section");
  panel.className = "lr-panel";
  panel.setAttribute("data-open", "false");
  const head = document.createElement("header");
  head.className = "lr-head";
  const brand = document.createElement("div");
  brand.className = "lr-brand";
  brand.innerHTML = '<span class="lr-mark">LUCKYRAY</span><span>视频捕获</span>';
  const close = document.createElement("button");
  close.type = "button";
  close.className = "lr-close";
  close.setAttribute("aria-label", "关闭");
  const closeIcon = lrCollectorIconSvg("close");
  if (closeIcon) close.append(closeIcon);
  const list = document.createElement("div");
  list.className = "lr-list";
  const status = document.createElement("div");
  status.className = "lr-status";
  head.append(brand, close);
  panel.append(head, list, status);
  shadow.append(style, chip, panel);
  document.documentElement.appendChild(host);
  const state = {
    target,
    host,
    chip,
    panel,
    list,
    status,
    sessionId: "",
    open: false,
    pointerInside: false,
    hideTimer: 0,
    transfers: new Map(),
  };
  const setOpen = (open) => {
    state.open = Boolean(open);
    chip.setAttribute("aria-expanded", String(state.open));
    panel.setAttribute("data-open", String(state.open));
  };
  const setStatus = (message, error = false) => {
    status.textContent = String(message || "");
    status.setAttribute("data-error", String(Boolean(error)));
  };
  const sendAction = async (action, candidateId = "") => {
    if (!state.sessionId) return;
    return await chrome.runtime.sendMessage({
      type: "luckyray-video-overlay-action",
      sessionId: state.sessionId,
      candidateId,
      action,
    }).catch(() => ["save-materials", "record-stop"].includes(action)
      ? { ok: false, code: "request-outcome-unknown",
          message: "保存结果暂时无法确认；请先在素材库核对，不要重复保存。" }
      : { ok: false, code: "app-unavailable", message: "LuckyRay 暂时无法处理这个视频。" });
  };
  const renderTransfer = (transfer, controls) => {
    if (!transfer || !controls) return;
    const progressView = LuckyRayExtensionProtocol.buildMediaTransferProgress(transfer);
    controls.save.textContent = progressView.label;
    controls.save.disabled = !["failed", "cancelled"].includes(transfer.state);
    controls.progress.dataset.visible = String(!progressView.terminal || transfer.state === "completed");
    controls.progress.dataset.indeterminate = String(progressView.indeterminate);
    controls.progress.setAttribute("aria-valuenow", progressView.percent == null ? "" : String(progressView.percent));
    controls.progressFill.style.width = `${progressView.percent || 0}%`;
    if (["queued", "running", "importing", "cancelling"].includes(transfer.state)) {
      controls.cancel.style.display = "";
      controls.cancel.disabled = transfer.state === "cancelling";
    } else {
      controls.cancel.style.display = "none";
    }
  };
  const pollTransfer = async (candidateId, controls, initial) => {
    const token = {};
    state.transfers.set(candidateId, token);
    let transfer = initial;
    let connectionFailures = 0;
    for (let attempt = 0; attempt < 2_400 && state.transfers.get(candidateId) === token; attempt += 1) {
      renderTransfer(transfer, controls);
      if (transfer?.state === "completed") {
        // EXT-R1-R1 P2-2: one duplicate-aware terminal projection shared with
        // the popup — a skipped-duplicate completion reads as "already exists",
        // never as a fresh save.
        setStatus(LuckyRayExtensionProtocol.formatTransferTerminalStatus(transfer));
        state.transfers.delete(candidateId);
        return;
      }
      if (transfer?.state === "cancelled") {
        setStatus(LuckyRayExtensionProtocol.formatTransferTerminalStatus(transfer), true);
        state.transfers.delete(candidateId);
        return;
      }
      if (transfer?.state === "failed") {
        const failureMessage = {
          "media-needs-recording": "该视频需要使用录制方式入库。",
          "media-resolver-unavailable": "视频解析组件当前不可用，可稍后重试或录制。",
          "media-resolver-unsupported": "当前站点尚未加入视频解析支持，可使用录制。",
          "media-resolver-failed": "没有解析到可下载的公开媒体；登录、地区限制或 DRM 内容可能不可用。",
          "media-hls-unsupported": "该播放流需要高级解析组件。",
          "media-hls-live-unsupported": "直播流暂不支持直接入库。",
          "media-format-unsupported": "该视频需要使用录制方式入库。",
          "media-container-invalid": "视频地址返回的不是可入库文件，可尝试录制。",
          "media-network-failed": "视频源拒绝下载，可尝试浏览器下载或录制。",
          "media-download-failed": "视频源下载失败，可稍后重试或录制。",
        }[transfer.errorCode] || "视频入库失败，请稍后重试。";
        setStatus(failureMessage, true);
        state.transfers.delete(candidateId);
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 750));
      const response = await sendAction("media-transfer-status", candidateId);
      if (!response?.ok || !response.transfer) {
        const transient = ["app-unavailable", "host-unavailable", "bootstrap-rejected", "verification-unavailable"]
          .includes(String(response?.code || ""));
        if (transient && connectionFailures < 6) {
          connectionFailures += 1;
          setStatus("与 LuckyRay 的连接正在恢复，入库任务仍在后台继续。", false);
          continue;
        }
        setStatus(transient
          ? "暂时无法确认入库结果；任务仍可能在后台继续，再次点击可继续查询。"
          : response?.message || "无法读取视频入库进度。", !transient);
        controls.save.disabled = false;
        controls.save.textContent = transient ? "继续查看" : "重试入库";
        controls.cancel.style.display = transient ? "" : "none";
        state.transfers.delete(candidateId);
        return;
      }
      connectionFailures = 0;
      transfer = response.transfer;
    }
    if (state.transfers.get(candidateId) === token) {
      await sendAction("media-transfer-cancel", candidateId);
      state.transfers.delete(candidateId);
      controls.save.disabled = false;
      controls.save.textContent = "重试入库";
      controls.cancel.style.display = "none";
      setStatus("视频入库已超过等待时间并请求取消。", true);
    }
  };
  const runAction = async (action, candidateId = "", controls = null) => {
    if (!state.sessionId) return;
    setStatus("正在处理…");
    const response = await sendAction(action, candidateId);
    if (!response?.ok) {
      setStatus(response?.message || "操作失败，请重试。", response?.code !== "request-outcome-unknown");
      return;
    }
    if (action === "save-materials" && response.transfer && controls) {
      if (response.sourcePageUnsupported) {
        setStatus("当前桌面版不支持保存作品页链接；视频仍会入库。", true);
      }
      void pollTransfer(candidateId, controls, response.transfer);
      return;
    }
    if (action === "probe-formats" && Array.isArray(response.items)) {
      render(response);
      setStatus("已读取可入库的清晰度，请选择一个版本。");
      return;
    }
    if (action === "record-start") {
      setStatus("正在录制当前标签页，再次点击即可停止并保存。");
      const record = panel.querySelector?.(".lr-record");
      if (record) {
        record.dataset.action = "record-stop";
        record.textContent = "停止并保存录制";
      }
    } else {
      setStatus("已保存到 LuckyRay 素材库。");
      if (action === "record-stop") setOpen(false);
    }
  };
  const render = (response) => {
    list.replaceChildren();
    state.sessionId = String(response?.sessionId || "");
    const items = Array.isArray(response?.items) ? response.items : [];
    // M1-S4 FIX-1 P1-2: EVERY render — empty AND non-empty candidates —
    // projects the same unified user-level state as the popup from the single
    // buildVideoCaptureView authority (over the existing menu + canRecord).
    // The banner carries the panel-level state; the row actions below are
    // untouched and stay the same save/probe/cancel affordances as before.
    const view = LuckyRayExtensionProtocol.buildVideoCaptureView({
      items,
      canRecord: response?.canRecord === true,
    });
    const banner = document.createElement("div");
    banner.className = "lr-state";
    banner.dataset.state = view.state;
    banner.textContent = view.label;
    banner.title = view.guidance;
    list.appendChild(banner);
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "lr-empty";
      // The banner already carries the state label; the empty block shows the
      // actionable guidance without duplicating it.
      empty.textContent = view.guidance || view.label;
      list.appendChild(empty);
    }
    for (const item of items) {
      const row = document.createElement("article");
      row.className = "lr-item";
      const copy = document.createElement("div");
      copy.className = "lr-copy";
      const quality = document.createElement("div");
      quality.className = "lr-quality";
      quality.textContent = String(item.label || "视频候选");
      const hostLabel = document.createElement("div");
      hostLabel.className = "lr-host";
      hostLabel.textContent = String(item.host || "网页视频");
      const progress = document.createElement("div");
      progress.className = "lr-progress";
      progress.setAttribute("role", "progressbar");
      progress.dataset.visible = "false";
      const progressFill = document.createElement("i");
      progress.appendChild(progressFill);
      copy.append(quality, hostLabel, progress);
      const actions = document.createElement("div");
      actions.className = "lr-actions";
      if (item.canSaveToMaterials) {
        const save = document.createElement("button");
        save.type = "button";
        save.className = "lr-action";
        save.dataset.primary = "true";
        const resolvesFormats = item.kind === "site-resolver";
        save.textContent = resolvesFormats ? "选择清晰度" : "入库";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "lr-cancel";
        cancel.textContent = "取消";
        cancel.style.display = "none";
        const controls = { save, cancel, progress, progressFill };
        save.addEventListener("click", () => void runAction(
          resolvesFormats ? "probe-formats" : "save-materials",
          item.candidateId,
          controls,
        ));
        cancel.addEventListener("click", async () => {
          cancel.disabled = true;
          const response = await sendAction("media-transfer-cancel", item.candidateId);
          if (!response?.ok || !response.transfer) {
            cancel.disabled = false;
            setStatus(response?.message || "无法取消视频入库。", true);
            return;
          }
          renderTransfer(response.transfer, controls);
        });
        actions.appendChild(save);
        actions.appendChild(cancel);
      }
      row.append(copy, actions);
      list.appendChild(row);
    }
    if (response?.canRecord || response?.recording) {
      const record = document.createElement("button");
      record.type = "button";
      record.className = "lr-record";
      record.dataset.action = response?.recording ? "record-stop" : "record-start";
      record.textContent = response?.recording ? "停止并保存录制" : "录制当前标签页";
      record.addEventListener("click", () => void runAction(record.dataset.action));
      list.appendChild(record);
    }
  };
  chip.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (state.open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (state.sessionId && state.transfers.size > 0) {
      // The background transfer is independent from panel visibility. Reuse
      // the existing controls so reopening shows the same live task instead of
      // creating another menu session or duplicate import.
      return;
    }
    setStatus("正在读取视频候选…");
    const rect = state.target?.getBoundingClientRect?.();
    const descriptor = lrCollectorDescriptorForVideo(state.target);
    const capturePageUrl = window.location.href;
    const sourcePage = lrCollectorVideoSourcePage(state.target);
    let resolverPageUrl = lrCollectorResolverPageForVideo(state.target);
    let candidateContext = {
      resolverPageUrl,
      playerCandidates: lrCollectorBoundVideoCandidates(state.target),
    };
    const pinterestIdentity = lrCollectorPinterestPageIdentity(resolverPageUrl);
    if (pinterestIdentity) {
      setStatus("正在读取该视频的最高画质…");
      const catalog = await lrCollectorRequestPinterestDetailCatalog(pinterestIdentity.pageUrl);
      candidateContext = lrCollectorUpgradePinterestDescriptor(candidateContext, catalog);
      resolverPageUrl = candidateContext.resolverPageUrl;
    }
    if (!state.target?.isConnected || window.location.href !== capturePageUrl
      || lrCollectorVideoSourcePage(state.target).sourcePageUrl !== sourcePage.sourcePageUrl) {
      setStatus("作品卡片已变化，请重新选择视频。", true);
      return;
    }
    const response = await lrCollectorSendRuntimeMessage({
      type: "luckyray-video-overlay-open",
      descriptor,
      pageUrl: capturePageUrl,
      ...sourcePage,
      resolverPageUrl,
      pageTitle: document.title || "",
      width: Number(state.target?.videoWidth || rect?.width || 0),
      height: Number(state.target?.videoHeight || rect?.height || 0),
      playerCandidates: candidateContext.playerCandidates,
      drmProtected: lrCollectorDrmVideos.has(state.target),
    });
    if (!response?.ok) {
      setStatus("暂时无法读取视频候选。", true);
      return;
    }
    render(response);
    setStatus("");
  });
  close.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
  });
  host.addEventListener("mouseenter", () => { state.pointerInside = true; });
  host.addEventListener("mouseleave", () => {
    state.pointerInside = false;
    if (!state.open) lrCollectorScheduleVideoOverlayHide(state);
  });
  state.setOpen = setOpen;
  lrCollectorVideoOverlayByTarget.set(target, state);
  lrCollectorVideoOverlays.add(state);
  lrCollectorCleanups.push(() => {
    if (state.hideTimer) window.clearTimeout(state.hideTimer);
    lrCollectorVideoOverlays.delete(state);
    host.remove();
  });
  return state;
}

function lrCollectorPositionVideoOverlay(overlay) {
  if (!lrCollectorVideoOverlaysEnabled) { if (overlay) overlay.host.style.display = "none"; return; }
  const target = overlay?.target;
  if (!overlay || !target?.isConnected || typeof target.getBoundingClientRect !== "function") {
    if (overlay) {
      overlay.host.style.display = "none";
      lrCollectorVideoOverlays.delete(overlay);
      lrCollectorVideoOverlayByTarget.delete(target);
      overlay.host.remove();
    }
    return;
  }
  const overlayRoot = document.fullscreenElement || document.documentElement;
  if (overlayRoot && overlay.host.parentNode !== overlayRoot) overlayRoot.appendChild(overlay.host);
  const placement = LuckyRayExtensionProtocol.placeVideoActionChip(target.getBoundingClientRect(), {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  if (!placement.visible) {
    overlay.host.style.display = "none";
    return;
  }
  overlay.host.style.display = "block";
  overlay.host.style.left = `${placement.left}px`;
  overlay.host.style.top = `${placement.top}px`;
  const viewportWidth = Math.max(0, Number(window.innerWidth) || 0);
  const viewportHeight = Math.max(0, Number(window.innerHeight) || 0);
  const panelWidth = Math.min(340, Math.max(0, viewportWidth - 24));
  const panelHeight = Math.min(440, Math.max(0, viewportHeight - 70));
  const openRight = placement.left < panelWidth + 12;
  overlay.panel.style.left = openRight ? "0px" : "auto";
  overlay.panel.style.right = openRight ? "auto" : "0px";
  const openUp = placement.top + 40 + panelHeight > viewportHeight - 12;
  overlay.panel.style.top = openUp ? "auto" : "40px";
  overlay.panel.style.bottom = openUp ? "40px" : "auto";
}

function lrCollectorPositionVideoOverlays() {
  for (const overlay of [...lrCollectorVideoOverlays]) lrCollectorPositionVideoOverlay(overlay);
}

function lrCollectorScheduleVideoOverlayHide(overlay) {
  if (!overlay || overlay.open || overlay.pointerInside) return;
  if (overlay.hideTimer) window.clearTimeout(overlay.hideTimer);
  overlay.hideTimer = window.setTimeout(() => {
    overlay.hideTimer = 0;
    if (!overlay.open && !overlay.pointerInside) overlay.host.style.display = "none";
  }, 220);
}

function lrCollectorTrackVideoOverlay(target) {
  const video = target instanceof HTMLVideoElement
    ? target
    : target instanceof HTMLSourceElement && typeof target.closest === "function" ? target.closest("video") : null;
  lrCollectorHoveredVideo = video;
  if (!lrCollectorVideoOverlaysEnabled) return;
  if (video?.isConnected) {
    const overlay = lrCollectorEnsureVideoOverlay(video);
    if (overlay) {
      if (overlay.hideTimer) window.clearTimeout(overlay.hideTimer);
      overlay.hideTimer = 0;
      lrCollectorPositionVideoOverlay(overlay);
    }
  }
  for (const overlay of lrCollectorVideoOverlays) {
    if (overlay.target !== video) lrCollectorScheduleVideoOverlayHide(overlay);
  }
}

if (typeof window.addEventListener === "function") {
  lrCollectorListen(window, "scroll", lrCollectorPositionVideoOverlays, true);
  lrCollectorListen(window, "resize", lrCollectorPositionVideoOverlays, true);
}
lrCollectorListen(document, "fullscreenchange", lrCollectorPositionVideoOverlays, true);
lrCollectorListen(document, "play", (event) => {
  if (event.target instanceof HTMLVideoElement) lrCollectorTrackVideoOverlay(event.target);
}, true);

// Native media drag collector. It complements the player chip: ordinary images
// and downloadable video sources can be dropped directly into LuckyRay, while
// complex/blob/DRM playback keeps using the explicit player controls.
let lrCollectorDragSurface = null;
let lrCollectorDragDescriptor = null;
let lrCollectorTemporaryDraggable = null;

function lrCollectorSafeHttpMediaUrl(value) {
  const raw = String(value || "");
  if (!raw || raw.length > 4_096 || /[\u0000-\u001f\u007f]/.test(raw)) return "";
  try {
    const parsed = new URL(raw, window.location.href);
    return /^https?:$/.test(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : "";
  } catch (_) {
    return "";
  }
}

function lrCollectorDragAnchorRect(element) {
  try {
    const rect = element?.getBoundingClientRect?.();
    const values = [rect?.left, rect?.top, rect?.right, rect?.bottom, rect?.width, rect?.height].map(Number);
    if (!values.every(Number.isFinite) || values[4] <= 0 || values[5] <= 0) return null;
    return {
      left: values[0], top: values[1], right: values[2], bottom: values[3],
      width: values[4], height: values[5],
    };
  } catch (_) {
    return null;
  }
}

function lrCollectorPinterestResolverDrag(video, directUrl, contentType) {
  let pageHost = "";
  try { pageHost = new URL(String(window.location.href || "")).hostname.toLowerCase(); } catch (_) {}
  if (!(pageHost === "pinterest.com" || pageHost.endsWith(".pinterest.com"))) return null;
  const targetVideo = video instanceof HTMLVideoElement ? video : null;
  if (!targetVideo && !directUrl) return null;
  const resolverPageUrl = targetVideo ? lrCollectorResolverPageForVideo(targetVideo) : "";
  if (resolverPageUrl) {
    try {
      const host = new URL(resolverPageUrl).hostname.toLowerCase();
      if (!(host === "pinterest.com" || host.endsWith(".pinterest.com"))) return null;
    } catch (_) {
      return null;
    }
  }
  const playerCandidates = targetVideo
    ? lrCollectorBoundVideoCandidates(targetVideo)
      .filter((candidate) => /^https?:\/\//i.test(candidate.url))
    : [];
  if (directUrl && !playerCandidates.some((candidate) => candidate.url === directUrl)) {
    playerCandidates.push({
      url: directUrl,
      contentType: String(contentType || targetVideo?.type || "").slice(0, 96),
      width: Number(targetVideo?.videoWidth || 0),
      height: Number(targetVideo?.videoHeight || 0),
      source: "drag-player",
    });
  }
  return {
    mediaType: "video",
    resolveVideo: true,
    resolverPageUrl,
    playerCandidates: playerCandidates.slice(0, 16),
    width: Number(targetVideo?.videoWidth || 0),
    height: Number(targetVideo?.videoHeight || 0),
    actionId: `drag:${lrCollectorDocumentToken}:${Date.now()}`,
    anchorRect: lrCollectorDragAnchorRect(targetVideo),
  };
}

function lrCollectorDragMediaAtEvent(event) {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
  const explicitVideo = path.find((node) => node instanceof HTMLVideoElement || node instanceof HTMLSourceElement);
  const eventVideo = explicitVideo instanceof HTMLVideoElement
    ? explicitVideo
    : explicitVideo instanceof HTMLSourceElement ? explicitVideo.closest?.("video")
      : lrCollectorVideoElementAtCoordinates(event.clientX, event.clientY, event.target);
  if (explicitVideo) {
    const capture = lrCollectorVideoCaptureAtCoordinates(event.clientX, event.clientY, explicitVideo, { allowPerformance: false });
    const url = lrCollectorSafeHttpMediaUrl(capture?.src);
    if (url && LuckyRayExtensionProtocol.isVideoUrlImportable(url, explicitVideo.type, window.location.href)) {
      const targetVideo = capture?.target instanceof HTMLVideoElement
        ? capture.target
        : explicitVideo instanceof HTMLVideoElement ? explicitVideo : explicitVideo.closest?.("video");
      const pinterest = lrCollectorPinterestResolverDrag(targetVideo, url, explicitVideo.type);
      if (pinterest) return pinterest;
      return {
        mediaType: "video",
        url,
        contentType: String(explicitVideo.type || "").slice(0, 96),
        actionId: `drag:${lrCollectorDocumentToken}:${Date.now()}`,
        anchorRect: lrCollectorDragAnchorRect(capture?.target || explicitVideo),
      };
    }
  }
  const pointedVideo = lrCollectorVideoCaptureAtCoordinates(event.clientX, event.clientY, event.target, { allowPerformance: false });
  const pointedVideoUrl = lrCollectorSafeHttpMediaUrl(pointedVideo?.src);
  const pointedVideoType = String(pointedVideo?.target?.type || "").slice(0, 96);
  if (pointedVideoUrl && LuckyRayExtensionProtocol.isVideoUrlImportable(pointedVideoUrl, pointedVideoType, window.location.href)) {
    const targetVideo = pointedVideo.target instanceof HTMLVideoElement
      ? pointedVideo.target
      : pointedVideo.target?.querySelector?.("video") || null;
    const pinterest = lrCollectorPinterestResolverDrag(targetVideo, pointedVideoUrl, pointedVideoType);
    if (pinterest) return pinterest;
    return {
      mediaType: "video",
      url: pointedVideoUrl,
      contentType: pointedVideoType,
      actionId: `drag:${lrCollectorDocumentToken}:${Date.now()}`,
      anchorRect: lrCollectorDragAnchorRect(pointedVideo?.target || event.target),
    };
  }
  if (eventVideo) {
    const pinterest = lrCollectorPinterestResolverDrag(eventVideo, "", "");
    if (pinterest) return pinterest;
    return {
      mediaType: "video",
      resolveVideo: true,
      resolverPageUrl: lrCollectorResolverPageForVideo(eventVideo),
      playerCandidates: lrCollectorBoundVideoCandidates(eventVideo)
        .filter((candidate) => /^https?:\/\//i.test(candidate.url)),
      width: Number(eventVideo.videoWidth || 0),
      height: Number(eventVideo.videoHeight || 0),
      actionId: `drag:${lrCollectorDocumentToken}:${Date.now()}`,
      anchorRect: lrCollectorDragAnchorRect(eventVideo),
    };
  }
  if (pointedVideo?.target) {
    const targetVideo = pointedVideo.target instanceof HTMLVideoElement
      ? pointedVideo.target
      : pointedVideo.target.querySelector?.("video") || null;
    const playerCandidates = targetVideo
      ? lrCollectorBoundVideoCandidates(targetVideo)
        .filter((candidate) => /^https?:\/\//i.test(candidate.url))
      : [];
    return {
      mediaType: "video",
      resolveVideo: true,
      resolverPageUrl: lrCollectorResolverPageForVideo(targetVideo || pointedVideo.target),
      playerCandidates,
      width: Number(targetVideo?.videoWidth || 0),
      height: Number(targetVideo?.videoHeight || 0),
      actionId: `drag:${lrCollectorDocumentToken}:${Date.now()}`,
      anchorRect: lrCollectorDragAnchorRect(targetVideo || pointedVideo.target || event.target),
    };
  }
  const image = lrCollectorImageCaptureAtCoordinates(event.clientX, event.clientY, event.target);
  const imageUrl = lrCollectorSafeHttpMediaUrl(image?.src);
  if (imageUrl) {
    const linkUrl = image?.target instanceof Element
      ? lrCollectorBoundImageWorkPage(image.target) : "";
    return {
      mediaType: "image",
      url: imageUrl,
      sourcePageUrl: linkUrl && linkUrl !== imageUrl ? linkUrl : window.location.href,
      sourcePageKind: linkUrl && linkUrl !== imageUrl ? "work-page" : "capture-page",
      targetElement: image?.target || null,
      contentType: "",
      actionId: `drag:${lrCollectorDocumentToken}:${Date.now()}`,
      anchorRect: lrCollectorDragAnchorRect(image?.target || event.target),
    };
  }
  return null;
}

function lrCollectorEnsureDragSurface() {
  if (lrCollectorDragSurface) return lrCollectorDragSurface;
  if (!lrCollectorIsTopFrame) return null;
  if (typeof document.createElement !== "function" || !document.documentElement) return null;
  const host = document.createElement("div");
  host.setAttribute("data-luckyray-drag-collector", "");
  host.style.cssText = "all:initial;position:fixed;right:24px;top:50%;transform:translateY(-50%);display:none;z-index:2147483647;pointer-events:auto;";
  if (globalThis.LuckyRayAppearance) lrCollectorCleanups.push(LuckyRayAppearance.bindSurface(host));
  const shadow = typeof host.attachShadow === "function" ? host.attachShadow({ mode: "closed" }) : host;
  const style = document.createElement("style");
  style.textContent = lrCollectorShadowThemeTokens + `
    *{box-sizing:border-box}
    .lr-drag-mark .lr-icon{width:24px;height:24px}
    .lr-drag-shell{width:min(620px,calc(100vw - 28px));padding:14px;border:1px solid var(--lr-border-strong);border-radius:var(--lr-radius-xl,18px);background:var(--lr-glass);box-shadow:var(--lr-shadow-lg);-webkit-backdrop-filter:var(--lr-glass-filter);backdrop-filter:var(--lr-glass-filter);font:12.5px/1.45 var(--lr-font);color:var(--lr-text);animation:lr-drag-in var(--lr-dur) var(--lr-ease)}
    @keyframes lr-drag-in{from{opacity:0;transform:translateX(14px) scale(.985)}to{opacity:1;transform:none}}
    .lr-drag-top{display:flex;align-items:center;justify-content:space-between;padding:2px 6px 12px;color:var(--lr-text-faint);font-family:var(--lr-font-label);font-size:10px;letter-spacing:.12em;text-transform:uppercase}
    .lr-drag-brand{color:var(--lr-accent-text,var(--lr-accent));font-weight:750;display:inline-flex;align-items:center;gap:6px}
    .lr-drag-kind{padding:2px 9px;border-radius:var(--lr-radius-pill);background:var(--lr-accent-soft);border:1px solid var(--lr-accent-line);color:var(--lr-accent-text,var(--lr-accent));font-weight:650;font-size:10px}
    .lr-drag-main{display:grid;grid-template-columns:240px minmax(300px,1fr);gap:12px;align-items:stretch}
    .lr-drag-dropzone{min-height:260px;border:1.5px dashed var(--lr-border-strong);border-radius:var(--lr-radius-lg,14px);background:radial-gradient(circle at 50% 22%,var(--lr-accent-soft),transparent 62%),var(--lr-surface-sunken);display:grid;place-items:center;text-align:center;padding:22px;transition:border-color var(--lr-dur) var(--lr-ease),background var(--lr-dur) var(--lr-ease),transform var(--lr-dur) var(--lr-ease),box-shadow var(--lr-dur) var(--lr-ease)}
    .lr-drag-dropzone[data-over="true"]{border-color:var(--lr-accent);border-style:solid;background:radial-gradient(circle at 50% 22%,color-mix(in srgb,var(--lr-accent) 22%,transparent),transparent 68%),var(--lr-surface-hover);box-shadow:0 0 0 3px var(--lr-accent-soft),inset 0 0 24px var(--lr-accent-soft);transform:scale(1.018)}
    .lr-drag-folders{min-width:0;height:260px;padding:12px;border:1px solid var(--lr-border);border-radius:var(--lr-radius-lg,14px);background:var(--lr-surface);display:flex;flex-direction:column;overflow:hidden}
    .lr-drag-folder-head{display:flex;align-items:center;justify-content:space-between;padding:0 4px 10px;color:var(--lr-text-faint);font-size:10.5px}
    .lr-drag-folder-head strong{color:var(--lr-text);font-size:12.5px;font-weight:650}
    .lr-drag-folder-list{display:flex;flex:1;min-height:0;flex-direction:column;gap:5px;overflow-x:hidden;overflow-y:auto;scrollbar-width:none;-ms-overflow-style:none}
    .lr-drag-folder-list::-webkit-scrollbar{width:0;height:0;display:none}
    .lr-drag-folder-item,.lr-drag-new-folder{all:unset;box-sizing:border-box;display:flex;align-items:center;flex:0 0 auto;width:100%;max-width:100%;min-height:36px;padding:8px 12px;border:1px solid var(--lr-border);border-radius:var(--lr-radius-sm,8px);background:var(--lr-surface-raised);color:var(--lr-text);font:600 12px/1.2 var(--lr-font);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;transition:border-color var(--lr-dur) var(--lr-ease),color var(--lr-dur) var(--lr-ease),background var(--lr-dur) var(--lr-ease),box-shadow var(--lr-dur-fast) var(--lr-ease)}
    .lr-drag-folder-item:hover{border-color:var(--lr-border-strong);background:var(--lr-surface-hover)}
    .lr-drag-folder-item[data-over="true"],.lr-drag-new-folder[data-over="true"]{border-color:var(--lr-accent);background:var(--lr-accent-soft);color:var(--lr-accent-text,var(--lr-accent));box-shadow:inset 0 0 0 1.5px var(--lr-accent),0 0 12px var(--lr-accent-soft)}
    .lr-drag-folder-empty{padding:12px 10px;color:var(--lr-text-faint);font-size:11.5px;text-align:center}
    .lr-drag-new-folder{margin-top:8px;justify-content:center;border-style:dashed;border-color:var(--lr-accent-line);background:var(--lr-accent-soft);color:var(--lr-accent-text,var(--lr-accent));text-align:center}
    .lr-drag-new-folder:hover{border-color:var(--lr-accent);background:color-mix(in srgb,var(--lr-accent) 24%,transparent)}
    .lr-drag-folder-form{display:none;margin-top:8px;grid-template-columns:1fr auto;gap:6px}
    .lr-drag-folder-form[data-open="true"]{display:grid}
    .lr-drag-folder-input{min-width:0;padding:8px 10px;border:1px solid var(--lr-accent-line);border-radius:var(--lr-radius-sm,8px);background:var(--lr-surface-sunken);color:var(--lr-text);font:12px var(--lr-font);outline:none}
    .lr-drag-folder-input:focus{box-shadow:0 0 0 2px var(--lr-accent-soft)}
    .lr-drag-folder-save{all:unset;padding:8px 14px;border-radius:var(--lr-radius-sm,8px);background:var(--lr-accent);color:var(--lr-accent-ink);font:700 12px var(--lr-font);cursor:pointer;transition:opacity var(--lr-dur) var(--lr-ease)}
    .lr-drag-folder-save:hover{opacity:.92}
    .lr-drag-mark{width:54px;height:54px;margin:0 auto 14px;border-radius:var(--lr-radius-md,12px);border:1px solid var(--lr-accent-line);background:var(--lr-accent-soft);color:var(--lr-accent-text,var(--lr-accent));display:grid;place-items:center;box-shadow:0 4px 16px color-mix(in srgb,var(--lr-accent) 18%,transparent);transition:transform var(--lr-dur) var(--lr-ease)}
    .lr-drag-dropzone[data-over="true"] .lr-drag-mark{transform:scale(1.08)}
    .lr-drag-title{font-size:15px;font-weight:700;letter-spacing:-.01em;color:var(--lr-text)}
    .lr-drag-copy{margin-top:6px;color:var(--lr-text-muted);font-size:11.5px;line-height:1.5}
    .lr-drag-status{min-height:20px;padding:10px 8px 2px;color:var(--lr-text-muted);font-size:11.5px;font-weight:600;text-align:center}
    .lr-drag-status[data-error="true"]{color:var(--lr-danger)}
    .lr-drag-status[data-success="true"]{color:var(--lr-success)}
    @media(max-width:600px){.lr-drag-main{grid-template-columns:1fr}.lr-drag-dropzone{min-height:160px}.lr-drag-folders{height:230px}}
  `;
  const shell = document.createElement("section");
  shell.className = "lr-drag-shell";
  const top = document.createElement("div");
  top.className = "lr-drag-top";
  const brand = document.createElement("span");
  brand.className = "lr-drag-brand";
  brand.textContent = "LUCKYRAY / COLLECT";
  const kind = document.createElement("span");
  kind.className = "lr-drag-kind";
  const dropZone = document.createElement("div");
  dropZone.className = "lr-drag-dropzone";
  const center = document.createElement("div");
  const mark = document.createElement("div");
  mark.className = "lr-drag-mark";
  const markIcon = lrCollectorIconSvg("add");
  if (markIcon) mark.append(markIcon);
  const title = document.createElement("div");
  title.className = "lr-drag-title";
  title.textContent = "松开保存到素材库";
  const copy = document.createElement("div");
  copy.className = "lr-drag-copy";
  copy.textContent = "保持原网页不变，素材会进入 LuckyRay 根目录";
  const status = document.createElement("div");
  status.className = "lr-drag-status";
  const folderPanel = document.createElement("div");
  folderPanel.className = "lr-drag-folders";
  const folderHead = document.createElement("div");
  folderHead.className = "lr-drag-folder-head";
  const folderHeadTitle = document.createElement("strong");
  folderHeadTitle.textContent = "保存到文件夹";
  const folderHeadHint = document.createElement("span");
  folderHeadHint.textContent = "拖到名称上";
  folderHead.append(folderHeadTitle, folderHeadHint);
  const folderList = document.createElement("div");
  folderList.className = "lr-drag-folder-list";
  const newFolderZone = document.createElement("button");
  newFolderZone.className = "lr-drag-new-folder";
  newFolderZone.type = "button";
  newFolderZone.textContent = "+ 新建文件夹";
  const folderForm = document.createElement("div");
  folderForm.className = "lr-drag-folder-form";
  const folderInput = document.createElement("input");
  folderInput.className = "lr-drag-folder-input";
  folderInput.maxLength = 160;
  folderInput.placeholder = "文件夹名称";
  const folderSave = document.createElement("button");
  folderSave.className = "lr-drag-folder-save";
  folderSave.type = "button";
  folderSave.textContent = "保存";
  folderForm.append(folderInput, folderSave);
  folderPanel.append(folderHead, folderList, newFolderZone, folderForm);
  const main = document.createElement("div");
  main.className = "lr-drag-main";
  main.append(dropZone, folderPanel);
  center.append(mark, title, copy);
  dropZone.append(center);
  top.append(brand, kind);
  shell.append(top, main, status);
  shadow.append(style, shell);
  document.documentElement.appendChild(host);

  const state = {
    host, dropZone, folderPanel, folderList, newFolderZone, folderForm, folderInput,
    kind, status, busy: false, editing: false, folderHover: false, dragActive: false, hideTimer: 0, folderLoad: 0, dragSession: 0,
    folderScrollDirection: 0, folderScrollHandle: 0, folderDragObservedAt: 0,
  };
  const setStatus = (text, mode = "") => {
    status.textContent = String(text || "");
    status.setAttribute("data-error", String(mode === "error"));
    status.setAttribute("data-success", String(mode === "success"));
  };
  const hide = (force = false) => {
    if ((state.busy || state.editing) && !force) return;
    // Invalidate only the dismissed UI session. Its accepted save continues,
    // but no old reply or timer may alter a subsequent interaction.
    state.dragSession += 1;
    state.folderLoad += 1;
    if (state.hideTimer) window.clearTimeout?.(state.hideTimer);
    state.hideTimer = 0;
    state.busy = false;
    // EXT-PINTEREST-DRAG-R2: every dismissal path ends the wheel-proxy
    // session unconditionally — a save still in flight (busy) must never
    // keep swallowing page wheel events.
    state.dragActive = false;
    state.folderHover = false;
    if (state.folderScrollHandle) {
      if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(state.folderScrollHandle);
      else window.clearTimeout?.(state.folderScrollHandle);
      state.folderScrollHandle = 0;
    }
    state.folderScrollDirection = 0;
    host.style.display = "none";
    dropZone.setAttribute("data-over", "false");
    newFolderZone.setAttribute("data-over", "false");
    folderForm.setAttribute("data-open", "false");
    state.editing = false;
    state.folderHover = false;
    setStatus("");
    lrCollectorDragDescriptor = null;
  };
  const loadFolders = async () => {
    const generation = ++state.folderLoad;
    state.libraryId = "";
    copy.textContent = "正在读取保存位置…";
    folderList.replaceChildren?.();
    const loading = document.createElement("div");
    loading.className = "lr-drag-folder-empty";
    loading.textContent = "正在读取文件夹…";
    folderList.append(loading);
    const response = await chrome.runtime.sendMessage({ type: "luckyray-drag-folders" })
      .catch(() => ({ ok: false }));
    if (generation !== state.folderLoad || host.style.display === "none") return;
    folderList.replaceChildren?.();
    state.libraryId = response?.ok ? response.libraryId || "" : "";
    copy.textContent = state.libraryId ? `保存到 ${response.libraryName || "所选素材库"} / 根目录` : "保存位置暂不可用，请在插件中重新选择素材库";
    const folders = response?.ok ? Array.from(response.folders || []).slice(0, 128) : [];
    if (!folders.length) {
      const empty = document.createElement("div");
      empty.className = "lr-drag-folder-empty";
      empty.textContent = response?.ok ? "暂无文件夹" : "暂时无法读取文件夹";
      folderList.append(empty);
      return;
    }
    for (const folder of folders) {
      const id = String(folder?.id || "");
      const name = String(folder?.name || "");
      if (!id || id.length > 160 || !name || name.length > 160 || /[\u0000-\u001f\u007f]/.test(id + name)) continue;
      const item = document.createElement("button");
      item.className = "lr-drag-folder-item";
      item.type = "button";
      item.textContent = `${folder.parentId ? "↳ " : ""}${name}`;
      item.setAttribute("data-folder-id", id);
      bindDropTarget(item, { targetFolderId: id });
      folderList.append(item);
    }
  };
  const show = (descriptor) => {
    // A new dragstart always takes over the panel, even while an earlier
    // save is still awaiting its runtime reply; that transfer keeps running
    // in the background and its late reply must not touch this session.
    if (state.hideTimer && typeof window.clearTimeout === "function") window.clearTimeout(state.hideTimer);
    state.dragSession += 1;
    state.busy = false;
    state.dragActive = true;
    lrCollectorDragDescriptor = descriptor;
    kind.textContent = descriptor.mediaType === "video" ? "视频" : "图片";
    dropZone.setAttribute("data-over", "false");
    newFolderZone.setAttribute("data-over", "false");
    folderForm.setAttribute("data-open", "false");
    state.editing = false;
    setStatus("拖到框内后松开");
    const viewportWidth = Number(window.innerWidth) || 0;
    const viewportHeight = Number(window.innerHeight) || 0;
    const rect = descriptor.anchorRect;
    if (rect && viewportWidth > 0 && viewportHeight > 0) {
      const panelWidth = Math.min(620, Math.max(292, viewportWidth - 24));
      const panelHeight = viewportWidth <= 600 ? 470 : 342;
      const gap = 16;
      const left = rect.right + gap + panelWidth <= viewportWidth - 12
        ? rect.right + gap
        : rect.left - gap - panelWidth >= 12
          ? rect.left - gap - panelWidth
          : Math.max(12, Math.min(viewportWidth - panelWidth - 12, rect.left));
      const top = Math.max(12, Math.min(viewportHeight - panelHeight - 12,
        rect.top + (rect.height - panelHeight) / 2));
      host.style.left = `${Math.round(left)}px`;
      host.style.top = `${Math.round(top)}px`;
      host.style.right = "auto";
      host.style.transform = "none";
    }
    host.style.display = "block";
    void loadFolders();
  };
  const submit = async (destination = {}) => {
    if (state.busy || !lrCollectorDragDescriptor) return;
    const session = state.dragSession;
    const libraryId = state.libraryId;
    if (!libraryId) {
      setStatus("保存位置尚未就绪，请等待读取完成后重新拖动", "error"); return;
    }
    // A drop ends the drag interaction even though the save keeps the panel
    // visible: stop proxying wheel immediately so the page stays usable.
    state.dragActive = false;
    state.folderHover = false;
    state.folderScrollDirection = 0;
    state.busy = true;
    dropZone.setAttribute("data-over", "false");
    newFolderZone.setAttribute("data-over", "false");
    setStatus(destination.targetFolderId || destination.newFolderName
      ? "正在保存到所选文件夹…" : "正在发送到 LuckyRay…");
    let descriptor = lrCollectorDragDescriptor;
    if (descriptor.capturePageUrl !== window.location.href) {
      state.busy = false;
      setStatus("页面已变化，请重新拖动目标", "error");
      return;
    }
    if (descriptor.mediaType === "image" && descriptor.sourcePageKind === "work-page" && descriptor.targetElement) {
      const current = descriptor.targetElement.isConnected
        ? LuckyRayExtensionProtocol.visualImageCandidate(descriptor.targetElement)?.url || "" : "";
      const link = lrCollectorBoundImageWorkPage(descriptor.targetElement);
      const expectedLink = descriptor.sourcePageKind === "work-page" ? descriptor.sourcePageUrl : "";
      if (current !== descriptor.url || link !== expectedLink) {
        state.busy = false;
        setStatus("作品卡片已变化，请重新拖动目标", "error");
        return;
      }
    }
    if (descriptor.mediaType === "video" && descriptor.resolveVideo === true) {
      const identity = lrCollectorPinterestPageIdentity(descriptor.resolverPageUrl);
      if (identity) {
        setStatus("正在读取该视频的最高画质…");
        const catalog = await lrCollectorRequestPinterestDetailCatalog(identity.pageUrl);
        descriptor = lrCollectorUpgradePinterestDescriptor(descriptor, catalog);
      }
    }
    // MV3 keeps this promise pending for as long as the background worker
    // holds the message port open. A wedged worker/native chain must never
    // lock the page: bound the UI wait (a transfer the worker already
    // accepted keeps running), and never let a late reply land on a newer
    // drag session.
    // Original-image download/import is a bounded 90-second operation, not
    // a short availability probe. Leave room for the original receipt check.
    const replyTimeoutMs = 120_000;
    const response = await new Promise((resolveReply) => {
      let settled = false;
      let timer = 0;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolveReply(value);
      };
      timer = window.setTimeout(
        () => finish({ ok: false, code: "request-outcome-unknown", message: "保存结果暂时无法确认；若已开始下载会继续执行，请先在素材库核对，不要重复保存。" }),
        replyTimeoutMs,
      );
      chrome.runtime.sendMessage({
        type: "luckyray-drag-collect",
        mediaType: descriptor.mediaType,
        url: descriptor.url,
        contentType: descriptor.contentType,
        resolveVideo: descriptor.resolveVideo === true,
        resolverPageUrl: descriptor.resolverPageUrl,
        capturePageUrl: descriptor.capturePageUrl,
        sourcePageUrl: descriptor.sourcePageUrl,
        sourcePageKind: descriptor.sourcePageKind,
        playerCandidates: descriptor.playerCandidates,
        width: descriptor.width,
        height: descriptor.height,
        actionId: descriptor.actionId,
        target: destination.targetFolderId ? "folder" : destination.newFolderName ? "new-folder" : "root",
        libraryId,
        targetFolderId: destination.targetFolderId,
        newFolderName: destination.newFolderName,
      }).then(finish, () => finish({ ok: false, code: "request-outcome-unknown",
        message: "保存结果暂时无法确认；请先在素材库核对，不要重复保存。" }));
    });
    if (session !== state.dragSession) return;
    state.busy = false;
    if (response?.ok) {
      const downloading = response.transfer && response.transfer.state !== "completed";
      setStatus(downloading
        ? "已提交下载，完成后会显示在素材库；现在可以继续浏览"
        : response.sourcePageUnsupported
          ? "素材已保存；当前桌面版不支持保存作品页链接"
          : "已保存到素材库", downloading ? "info" : "success");
    } else {
      setStatus(response?.message || "保存失败，请打开 LuckyRay 后重试", response?.code === "request-outcome-unknown" ? "info" : "error");
    }
    if (response?.code !== "request-outcome-unknown" && typeof window.setTimeout === "function") {
      state.hideTimer = window.setTimeout(() => {
        if (session === state.dragSession) hide(true);
      }, response?.ok ? 1_600 : 3_200);
    }
  };
  function bindDropTarget(element, destination) {
    element.addEventListener("dragenter", (event) => {
      event.preventDefault();
      element.setAttribute("data-over", "true");
    });
    element.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      element.setAttribute("data-over", "true");
    });
    element.addEventListener("dragleave", () => element.setAttribute("data-over", "false"));
    element.addEventListener("drop", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await submit(destination);
    });
  }
  bindDropTarget(dropZone, {});
  const openNewFolder = (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    state.editing = true;
    newFolderZone.setAttribute("data-over", "false");
    folderForm.setAttribute("data-open", "true");
    setStatus("输入新文件夹名称后保存");
    folderInput.focus?.();
  };
  newFolderZone.addEventListener("dragenter", (event) => { event.preventDefault(); newFolderZone.setAttribute("data-over", "true"); });
  newFolderZone.addEventListener("dragover", (event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"; });
  newFolderZone.addEventListener("dragleave", () => newFolderZone.setAttribute("data-over", "false"));
  newFolderZone.addEventListener("drop", openNewFolder);
  newFolderZone.addEventListener("click", openNewFolder);
  const saveNewFolder = async () => {
    const name = String(folderInput.value || "").trim();
    if (!name || name.length > 160 || /[\u0000-\u001f\u007f]/.test(name)) {
      setStatus("请输入有效的文件夹名称", "error");
      return;
    }
    state.editing = false;
    await submit({ newFolderName: name });
  };
  folderSave.addEventListener("click", saveNewFolder);
  folderPanel.addEventListener("dragenter", (event) => { event.preventDefault(); state.folderHover = true; });
  folderPanel.addEventListener("dragover", (event) => {
    event.preventDefault();
    state.folderHover = true;
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  // Native Edge drags frequently report a null relatedTarget while crossing
  // children inside a closed shadow root. Clearing on dragleave therefore
  // disables the wheel even though the pointer is still over this panel.
  // The document-level dragover coordinates below are the stable truth.
  folderPanel.addEventListener("dragleave", () => {});
  const scheduleFolderAutoScroll = () => {
    if (!state.folderScrollDirection || state.folderScrollHandle) return;
    const tick = () => {
      state.folderScrollHandle = 0;
      if (host.style.display === "none" || !state.folderHover || !state.folderScrollDirection
        || Date.now() - state.folderDragObservedAt > 250) {
        state.folderScrollDirection = 0;
        return;
      }
      folderList.scrollTop = (Number(folderList.scrollTop) || 0) + state.folderScrollDirection * 3;
      scheduleFolderAutoScroll();
    };
    state.folderScrollHandle = typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame(tick)
      : window.setTimeout(tick, 16);
  };
  lrCollectorListen(document, "dragover", (event) => {
    if (host.style.display === "none") return;
    const x = Number(event.clientX);
    const y = Number(event.clientY);
    const rect = folderPanel.getBoundingClientRect?.();
    if (!rect || !Number.isFinite(x) || !Number.isFinite(y)) return;
    state.folderHover = x >= Number(rect.left) && x <= Number(rect.right)
      && y >= Number(rect.top) && y <= Number(rect.bottom);
    state.folderScrollDirection = 0;
    if (state.folderHover) {
      const listRect = folderList.getBoundingClientRect?.();
      const listTop = Number(listRect?.top);
      const listBottom = Number(listRect?.bottom);
      if (Number.isFinite(listTop) && Number.isFinite(listBottom) && listBottom > listTop) {
        const edge = Math.min(44, Math.max(28, (listBottom - listTop) * 0.18));
        if (y >= listTop && y <= listTop + edge) state.folderScrollDirection = -1;
        else if (y <= listBottom && y >= listBottom - edge) state.folderScrollDirection = 1;
      }
    }
    state.folderDragObservedAt = Date.now();
    scheduleFolderAutoScroll();
  }, true);
  lrCollectorListen(document, "wheel", (event) => {
    if (!state.dragActive || !state.folderHover || host.style.display === "none") return;
    const delta = Number(event.deltaY) || 0;
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    folderList.scrollTop = (Number(folderList.scrollTop) || 0) + delta;
  }, { capture: true, passive: false });
  folderInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); void saveNewFolder(); }
    if (event.key === "Escape") hide(true);
  });
  const endDrag = () => {
    // Ends the wheel-proxy session even while a save keeps the panel mounted.
    state.dragActive = false;
    state.folderHover = false;
    state.folderScrollDirection = 0;
  };
  lrCollectorDragSurface = { ...state, show, hide, endDrag };
  lrCollectorCleanups.push(() => host.remove());
  return lrCollectorDragSurface;
}

function lrCollectorRestoreTemporaryDraggable() {
  const record = lrCollectorTemporaryDraggable;
  lrCollectorTemporaryDraggable = null;
  if (!record?.element) return;
  try {
    if (record.hadAttribute) record.element.setAttribute("draggable", record.value);
    else record.element.removeAttribute("draggable");
  } catch (_) {}
}

lrCollectorListen(document, "pointerdown", (event) => {
  if (event.button !== 0) return;
  const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
  const directVideo = path.find((node) => node instanceof HTMLVideoElement)
    || lrCollectorVideoElementAtCoordinates(event.clientX, event.clientY, event.target);
  const capture = directVideo
    ? { src: lrCollectorVideoSourceFromElement(directVideo), target: directVideo }
    : lrCollectorVideoCaptureAtCoordinates(event.clientX, event.clientY, event.target, { allowPerformance: false });
  if (!capture?.src && !directVideo) return;
  const dragSource = event.target instanceof Element ? event.target : capture?.target || directVideo;
  if (!dragSource || dragSource.draggable) return;
  lrCollectorRestoreTemporaryDraggable();
  lrCollectorTemporaryDraggable = {
    element: dragSource,
    hadAttribute: typeof dragSource.hasAttribute === "function" && dragSource.hasAttribute("draggable"),
    value: typeof dragSource.getAttribute === "function" ? dragSource.getAttribute("draggable") : "false",
  };
  try { dragSource.setAttribute("draggable", "true"); } catch (_) {}
}, true);

lrCollectorListen(document, "dragstart", (event) => {
  const descriptor = lrCollectorDragMediaAtEvent(event);
  if (!descriptor) return;
  const surface = lrCollectorEnsureDragSurface();
  if (!surface) return;
  try { if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy"; } catch (_) {}
  // Keep the browser's native drag preview. Removing the custom preview did
  // not resolve #125; no browser bug is asserted here without native evidence.
  const videoTarget = descriptor.mediaType === "video"
    ? lrCollectorVideoElementAtCoordinates(event.clientX, event.clientY, event.target) || event.target : null;
  surface.show({
    ...descriptor,
    ...(videoTarget ? lrCollectorVideoSourcePage(videoTarget) : {}),
    capturePageUrl: window.location.href,
  });
}, true);

lrCollectorListen(document, "dragend", () => {
  lrCollectorRestoreTemporaryDraggable();
  // The drag session ends here no matter what hide() decides about keeping
  // the panel mounted for a save in flight.
  lrCollectorDragSurface?.endDrag?.();
  lrCollectorDragSurface?.hide();
}, true);

lrCollectorListen(document, "pointerdown", (event) => {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
  if (lrCollectorDragSurface && lrCollectorDragSurface.host?.style?.display !== "none"
    && !path.includes(lrCollectorDragSurface.host)) {
    // Closing the surface never cancels a transfer already accepted by the
    // background worker; it only dismisses the page UI.
    lrCollectorDragSurface.hide(true);
  }
  for (const overlay of lrCollectorVideoOverlays) {
    if (overlay.open && !path.includes(overlay.host)) overlay.setOpen(false);
  }
}, true);

lrCollectorListen(document, "keydown", (event) => {
  if (event.key === "Escape") {
    lrCollectorRestoreTemporaryDraggable();
    lrCollectorDragSurface?.hide(true);
  }
}, true);

if (typeof window.addEventListener === "function") {
  lrCollectorListen(window, "pagehide", () => {
    lrCollectorRestoreTemporaryDraggable();
    lrCollectorDragSurface?.hide(true);
  }, true);
}

function lrCollectorCleanup() {
  if (lrCollectorDisposed) return;
  lrCollectorDisposed = true;
  lrCollectorRestoreTemporaryDraggable();
  lrCollectorDragSurface?.hide(true);
  while (lrCollectorCleanups.length > 0) {
    try { lrCollectorCleanups.pop()(); } catch (_) {}
  }
}

globalThis[lrCollectorInstallKey] = { cleanup: lrCollectorCleanup };
})();
