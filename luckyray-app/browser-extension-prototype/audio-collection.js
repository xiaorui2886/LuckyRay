(function (global) {
  "use strict";
  // R7's generic transfer endpoint byte-identifies MP3/WAVE. Other containers
  // are deliberately not promoted to audio until Desktop can attest their kind.
  const formats = { mp3: "audio/mpeg", wav: "audio/wav" };
  const extensions = /\.(mp3|wav|m4a|aac|ogg|opus|flac|aiff?|wma)$/i;
  function classify(value, mime = "", base, audioElement = false) {
    const raw = String(value || "").trim();
    if (!raw || raw.length > 4096 || /[\u0000-\u001f\u007f]/.test(raw)) return null;
    let parsed;
    try { parsed = new URL(raw, base); } catch (_) { return null; }
    if (parsed.username || parsed.password || !["http:", "https:", "blob:"].includes(parsed.protocol)) return null;
    const type = String(mime || "").split(";")[0].trim().toLowerCase();
    if (type.startsWith("video/")) return null;
    const ext = parsed.pathname.match(extensions)?.[1]?.toLowerCase() || "";
    const stream = /\.(m3u8|mpd|m4s|ts)$/i.test(parsed.pathname) || /mpegurl|dash\+xml/.test(type);
    if (!audioElement && !ext && !type.startsWith("audio/") && !stream) return null;
    const format = type === "audio/mpeg" ? "mp3" : ["audio/wav", "audio/x-wav", "audio/wave"].includes(type) ? "wav"
      : !type || type === "application/octet-stream" ? ext : "";
    const resolverHosts = /(^|\.)(youtube\.com|youtu\.be|googlevideo\.com|bilibili\.com|b23\.tv|bilivideo\.com|bilivideo\.cn|hdslb\.com|x\.com|twitter\.com|twimg\.com|pinterest\.com|pinimg\.com)$/i;
    let sitePlayer = resolverHosts.test(parsed.hostname);
    try { sitePlayer ||= resolverHosts.test(new URL(base).hostname); } catch (_) {}
    const reason = parsed.protocol === "blob:" ? "blob" : stream ? "stream" : sitePlayer ? "site"
      : !formats[format] ? (ext || type.startsWith("audio/") ? "format" : "unconfirmed") : "";
    return { url: parsed.href, format: format || ext || "", contentType: formats[format] || type,
      kind: "audio", importable: !reason, reason };
  }
  function collect(document, pageUrl) {
    const found = new Map();
    const add = (url, mime, source, audioElement = false) => {
      if (found.size >= 64) return;
      const item = classify(url, mime, pageUrl, audioElement);
      if (!item) return;
      const old = found.get(item.url);
      if (!old || old.reason !== "protected" && !old.importable && item.importable) found.set(item.url, { ...item, source });
    };
    for (const audio of Array.from(document.querySelectorAll("audio")).slice(0, 64)) {
      // EME-protected media is never made downloadable, even if it has a URL.
      add(audio.currentSrc, audio.getAttribute("type"), "audio.currentSrc", true);
      add(audio.getAttribute("src"), audio.getAttribute("type"), "audio.src", true);
      for (const source of Array.from(audio.querySelectorAll("source[src]")).slice(0, 16))
        add(source.getAttribute("src"), source.getAttribute("type"), "audio.source", true);
      if (audio.mediaKeys) {
        const urls = [audio.currentSrc, audio.getAttribute("src"), ...Array.from(audio.querySelectorAll("source[src]")).map(source => source.getAttribute("src"))];
        for (const raw of urls) {
          const item = classify(raw, "", pageUrl, true);
          if (item && found.has(item.url)) found.set(item.url, { ...found.get(item.url), importable: false, reason: "protected" });
        }
      }
    }
    for (const link of Array.from(document.querySelectorAll("a[href]")).slice(0, 512)) add(link.href, link.getAttribute("type"), "link");
    add(pageUrl, document.contentType, "document");
    return [...found.values()];
  }
  function merge(items, pageUrl) {
    const unique = new Map();
    for (const input of items.slice(0, 128)) {
      const item = classify(input.url, input.contentType, pageUrl, input.source?.startsWith("audio.") || input.reason === "blob");
      if (!item) continue;
      if (input.reason === "protected") Object.assign(item, { importable: false, reason: "protected" });
      const old = unique.get(item.url);
      if (!old || item.reason === "protected" || old.reason !== "protected" && !old.importable && item.importable)
        unique.set(item.url, { ...item, source: String(input.source || "response").slice(0, 32) });
      if (unique.size >= 64) break;
    }
    return [...unique.values()];
  }
  const reasons = { blob: "暂不支持 blob 音频", stream: "暂不支持分段音频流", protected: "不采集受保护音频",
    format: "本批仅支持 MP3 / WAV", unconfirmed: "尚未确认可下载音频格式", site: "首批暂不支持流媒体站点音轨" };
  const api = { classify, collect, merge, formats, message: reason => reasons[reason] || "请重新选择音频" };
  global.LuckyRayAudioCollection = Object.freeze(api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
