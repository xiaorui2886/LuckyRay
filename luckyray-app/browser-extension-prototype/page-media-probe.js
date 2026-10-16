"use strict";

// Runs in Chrome's MAIN world. It observes only the narrow hand-off where a
// response ArrayBuffer is appended to a MediaSource. It never keeps media
// bytes, request headers, cookies, or bodies; the isolated extension layer and
// background worker still treat every emitted URL as an untrusted hint.
(() => {
  const installKey = "__LUCKYRAY_PAGE_MEDIA_PROBE_V1__";
  if (globalThis[installKey]) return;
  globalThis[installKey] = true;

  const EVENT_NAME = "__luckyray_page_media_probe_v1__";
  const PINTEREST_DETAIL_REQUEST_NAME = "__luckyray_pinterest_detail_request_v1__";
  const MAX_URL_BYTES = 4_096;
  const responseBufferUrls = new WeakMap();
  const responseBlobUrls = new WeakMap();
  const responseStreamUrls = new WeakMap();
  const responseReaderUrls = new WeakMap();
  const sourceBufferOwners = new WeakMap();
  const sourceBufferTypes = new WeakMap();
  const mediaSourceBlobUrls = new WeakMap();

  const safeHttpUrl = (value) => {
    const raw = String(value || "");
    if (!raw || raw.length > MAX_URL_BYTES || /[\u0000-\u001f\u007f]/.test(raw)) return "";
    try {
      const parsed = new URL(raw, globalThis.location?.href);
      return /^https?:$/.test(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : "";
    } catch (_) {
      return "";
    }
  };

  const emit = (detail) => {
    try {
      document.dispatchEvent(new CustomEvent(EVENT_NAME, {
        detail: Object.freeze({ version: 1, ...detail }),
      }));
    } catch (_) {}
  };

  const safeTrackUrl = (value, allowedSuffixes) => {
    const url = safeHttpUrl(value);
    if (!url) return "";
    try {
      const host = new URL(url).hostname.replace(/\.$/, "").toLowerCase();
      return allowedSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
        ? url
        : "";
    } catch (_) {
      return "";
    }
  };

  const finiteMetric = (value, max) => {
    const number = Number(value || 0);
    return Number.isFinite(number) && number > 0 ? Math.min(Math.trunc(number), max) : 0;
  };

  const bestTrack = (values, allowedSuffixes, score) => {
    let best = null;
    let bestScore = -1;
    for (const raw of Array.from(values || []).slice(0, 64)) {
      const url = safeTrackUrl(raw?.baseUrl || raw?.base_url || raw?.url, allowedSuffixes);
      if (!url) continue;
      const nextScore = score(raw);
      if (nextScore > bestScore) {
        best = { raw, url };
        bestScore = nextScore;
      }
    }
    return best;
  };

  let lastSiteTrackPairKey = "";
  const emitSiteTrackPair = (pair) => {
    const key = `${pair.pageUrl}\n${pair.videoUrl}\n${pair.audioUrl}`;
    if (key === lastSiteTrackPairKey) return;
    lastSiteTrackPairKey = key;
    emit({ kind: "site-track-pair", ...pair });
  };

  const publishBilibiliTrackPair = () => {
    try {
      const pageUrl = safeHttpUrl(globalThis.location?.href);
      const pageHost = pageUrl ? new URL(pageUrl).hostname.toLowerCase() : "";
      if (!(pageHost === "bilibili.com" || pageHost.endsWith(".bilibili.com"))) return;
      const dash = globalThis.__playinfo__?.data?.dash;
      if (!dash) return;
      const suffixes = ["bilivideo.com", "bilivideo.cn", "hdslb.com"];
      const video = bestTrack(dash.video, suffixes, (item) => (
        finiteMetric(item?.height, 16_384) * 1_000_000
        + finiteMetric(item?.bandwidth, 1_000_000_000)
      ));
      const audio = bestTrack(dash.audio, suffixes, (item) => finiteMetric(item?.bandwidth, 1_000_000_000));
      if (!video || !audio) return;
      emitSiteTrackPair({
        pageUrl,
        videoUrl: video.url,
        audioUrl: audio.url,
        contentType: "video/mp4",
        width: finiteMetric(video.raw?.width, 16_384),
        height: finiteMetric(video.raw?.height, 16_384),
        bitrate: finiteMetric(video.raw?.bandwidth, 1_000_000_000),
      });
    } catch (_) {}
  };

  const publishYouTubeTrackPair = () => {
    try {
      const pageUrl = safeHttpUrl(globalThis.location?.href);
      const pageHost = pageUrl ? new URL(pageUrl).hostname.toLowerCase() : "";
      if (!(pageHost === "youtube.com" || pageHost.endsWith(".youtube.com"))) return;
      const formats = Array.from(globalThis.ytInitialPlayerResponse?.streamingData?.adaptiveFormats || []).slice(0, 128);
      const suffixes = ["googlevideo.com"];
      const video = bestTrack(
        formats.filter((item) => String(item?.mimeType || "").toLowerCase().startsWith("video/")),
        suffixes,
        (item) => finiteMetric(item?.height, 16_384) * 1_000_000 + finiteMetric(item?.bitrate, 1_000_000_000),
      );
      const audio = bestTrack(
        formats.filter((item) => String(item?.mimeType || "").toLowerCase().startsWith("audio/")),
        suffixes,
        (item) => finiteMetric(item?.bitrate, 1_000_000_000),
      );
      if (!video || !audio) return;
      emitSiteTrackPair({
        pageUrl,
        videoUrl: video.url,
        audioUrl: audio.url,
        contentType: "video/mp4",
        width: finiteMetric(video.raw?.width, 16_384),
        height: finiteMetric(video.raw?.height, 16_384),
        bitrate: finiteMetric(video.raw?.bitrate, 1_000_000_000),
      });
    } catch (_) {}
  };

  let lastSiteVideoCandidateKey = "";
  const publishXVideoCandidate = (payload) => {
    try {
      const pageUrl = safeHttpUrl(globalThis.location?.href);
      const parsedPage = pageUrl ? new URL(pageUrl) : null;
      const pageHost = String(parsedPage?.hostname || "").toLowerCase();
      if (!(pageHost === "x.com" || pageHost.endsWith(".x.com")
        || pageHost === "twitter.com" || pageHost.endsWith(".twitter.com"))) return;
      const statusId = String(parsedPage?.pathname || "").match(/\/status\/(\d+)/i)?.[1] || "";
      if (!statusId || !payload || typeof payload !== "object") return;

      const stack = [payload];
      const visited = new WeakSet();
      let matched = null;
      for (let count = 0; stack.length > 0 && count < 4_096; count += 1) {
        const value = stack.pop();
        if (!value || typeof value !== "object" || visited.has(value)) continue;
        visited.add(value);
        const objectId = String(value.rest_id || value.id_str || value?.legacy?.id_str || "");
        if (objectId === statusId) {
          matched = value;
          break;
        }
        const children = Array.isArray(value) ? value : Object.values(value);
        for (const child of children.slice(0, 256)) {
          if (child && typeof child === "object") stack.push(child);
        }
      }
      if (!matched) return;

      const variants = [];
      const mediaStack = [matched];
      const mediaVisited = new WeakSet();
      for (let count = 0; mediaStack.length > 0 && count < 2_048; count += 1) {
        const value = mediaStack.pop();
        if (!value || typeof value !== "object" || mediaVisited.has(value)) continue;
        mediaVisited.add(value);
        if (Array.isArray(value.variants)) {
          for (const variant of value.variants.slice(0, 64)) {
            const contentType = String(variant?.content_type || variant?.contentType || "").toLowerCase();
            const url = safeTrackUrl(variant?.url, ["twimg.com"]);
            if (contentType === "video/mp4" && url) {
              variants.push({ url, bitrate: finiteMetric(variant?.bitrate, 1_000_000_000) });
            }
          }
        }
        const children = Array.isArray(value) ? value : Object.values(value);
        for (const child of children.slice(0, 256)) {
          if (child && typeof child === "object") mediaStack.push(child);
        }
      }
      variants.sort((left, right) => right.bitrate - left.bitrate);
      const best = variants[0];
      if (!best) return;
      const key = `${pageUrl}\n${best.url}`;
      if (key === lastSiteVideoCandidateKey) return;
      lastSiteVideoCandidateKey = key;
      emit({
        kind: "site-video-candidate",
        pageUrl,
        videoUrl: best.url,
        contentType: "video/mp4",
        bitrate: best.bitrate,
      });
    } catch (_) {}
  };

  const publishXVideoCandidateFromText = (responseUrl, value) => {
    try {
      const text = String(value || "");
      if (!text || text.length > 2 * 1024 * 1024) return;
      const parsed = new URL(String(responseUrl || ""));
      const host = parsed.hostname.toLowerCase();
      if (!(host === "x.com" || host.endsWith(".x.com")
        || host === "twitter.com" || host.endsWith(".twitter.com"))) return;
      if (!parsed.pathname.includes("/graphql/")) return;
      publishXVideoCandidate(JSON.parse(text));
    } catch (_) {}
  };

  const pinterestCatalogKeys = new Set();
  const publishPinterestVideoCatalog = (payload, responseUrl, request = null) => {
    try {
      const pageUrl = safeHttpUrl(globalThis.location?.href);
      const pageHost = pageUrl ? new URL(pageUrl).hostname.toLowerCase() : "";
      const responseHost = new URL(String(responseUrl || "")).hostname.toLowerCase();
      if (!(pageHost === "pinterest.com" || pageHost.endsWith(".pinterest.com"))) return;
      if (!(responseHost === "pinterest.com" || responseHost.endsWith(".pinterest.com"))) return;
      if (!payload || typeof payload !== "object") return;
      const requestedPinId = /^\d{6,32}$/.test(String(request?.pinId || ""))
        ? String(request.pinId) : "";
      const requestId = /^pdetail:[a-z0-9:._-]{1,160}$/i.test(String(request?.requestId || ""))
        ? String(request.requestId) : "";
      const stack = [payload];
      const visited = new WeakSet();
      let emittedCount = 0;
      for (let count = 0; stack.length > 0 && count < 4_096 && emittedCount < 32; count += 1) {
        const value = stack.pop();
        if (!value || typeof value !== "object" || visited.has(value)) continue;
        visited.add(value);
        const pinId = String(value.id || value.pin_id || value.pinId || "");
        const videoList = value?.videos?.video_list || value?.videos?.videoList || value?.video_list;
        if (/^\d{6,32}$/.test(pinId) && (!requestedPinId || pinId === requestedPinId)
          && videoList && typeof videoList === "object") {
          const variants = [];
          for (const raw of Object.values(videoList).slice(0, 64)) {
            const url = safeTrackUrl(raw?.url || raw?.src, ["pinimg.com"]);
            if (!url || variants.some((item) => item.url === url)) continue;
            variants.push({
              url,
              width: finiteMetric(raw?.width, 16_384),
              height: finiteMetric(raw?.height, 16_384),
            });
          }
          variants.sort((left, right) => right.height - left.height || right.width - left.width);
          if (variants.length) {
            const key = `${pinId}\n${variants[0].url}`;
            if (requestId || !pinterestCatalogKeys.has(key)) {
              pinterestCatalogKeys.add(key);
              while (pinterestCatalogKeys.size > 256) pinterestCatalogKeys.delete(pinterestCatalogKeys.values().next().value);
              emit({
                kind: "pinterest-video-catalog",
                pinId,
                pageUrl: `https://www.pinterest.com/pin/${pinId}/`,
                variants: variants.slice(0, 16),
                ...(requestId ? { requestId } : {}),
              });
              emittedCount += 1;
            }
          }
        }
        const children = Array.isArray(value) ? value : Object.values(value);
        for (const child of children.slice(0, 256)) {
          if (child && typeof child === "object") stack.push(child);
        }
      }
    } catch (_) {}
  };

  const publishPinterestVideoCatalogFromText = (responseUrl, value) => {
    try {
      const text = String(value || "");
      if (!text || text.length > 2 * 1024 * 1024) return;
      publishPinterestVideoCatalog(JSON.parse(text), responseUrl);
    } catch (_) {}
  };

  const pinterestDetailRequests = new Set();
  try {
    document.addEventListener(PINTEREST_DETAIL_REQUEST_NAME, async (event) => {
      const detail = event?.detail;
      const requestId = String(detail?.requestId || "");
      const pinId = String(detail?.pinId || "");
      if (detail?.version !== 1
        || !/^pdetail:[a-z0-9:._-]{1,160}$/i.test(requestId)
        || !/^\d{6,32}$/.test(pinId)
        || pinterestDetailRequests.has(requestId)
        || pinterestDetailRequests.size >= 4) return;
      try {
        const current = new URL(String(globalThis.location?.href || ""));
        const page = new URL(String(detail?.pageUrl || ""));
        const host = current.hostname.toLowerCase();
        if (!(host === "pinterest.com" || host.endsWith(".pinterest.com"))
          || page.origin !== current.origin
          || page.pathname !== `/pin/${pinId}/`
          || page.search || page.hash) return;
        pinterestDetailRequests.add(requestId);
        const controller = new AbortController();
        const timer = globalThis.setTimeout?.(() => controller.abort(), 5_000);
        try {
          const data = JSON.stringify({ options: { field_set_key: "unauth_react_main_pin", id: pinId } });
          const endpoint = `${current.origin}/resource/PinResource/get/?data=${encodeURIComponent(data)}`;
          const response = await globalThis.fetch(endpoint, {
            method: "GET",
            credentials: "include",
            redirect: "error",
            cache: "no-store",
            signal: controller.signal,
            headers: {
              Accept: "application/json",
              "X-Pinterest-PWS-Handler": "www/[username].js",
            },
          });
          if (!response?.ok) return;
          const payload = await response.json();
          publishPinterestVideoCatalog(payload, response.url || endpoint, { requestId, pinId });
        } finally {
          if (timer) globalThis.clearTimeout?.(timer);
          pinterestDetailRequests.delete(requestId);
        }
      } catch (_) {
        pinterestDetailRequests.delete(requestId);
      }
    }, true);
  } catch (_) {}

  const publishSiteTrackPair = () => {
    publishBilibiliTrackPair();
    publishYouTubeTrackPair();
  };
  publishSiteTrackPair();
  if (typeof globalThis.setInterval === "function") {
    globalThis.setInterval(publishSiteTrackPair, 1_000);
  }

  if (globalThis.URL && typeof URL.createObjectURL === "function" && globalThis.MediaSource) {
    const originalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = function luckyrayCreateObjectURL(value) {
      const result = Reflect.apply(originalCreateObjectURL, this, arguments);
      try {
        if (value instanceof MediaSource && String(result).startsWith("blob:")) {
          mediaSourceBlobUrls.set(value, String(result).slice(0, MAX_URL_BYTES));
        }
      } catch (_) {}
      return result;
    };
  }

  if (globalThis.MediaSource?.prototype && typeof MediaSource.prototype.addSourceBuffer === "function") {
    const originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function luckyrayAddSourceBuffer(type) {
      const buffer = Reflect.apply(originalAddSourceBuffer, this, arguments);
      try {
        sourceBufferOwners.set(buffer, this);
        sourceBufferTypes.set(buffer, String(type || "").slice(0, 96));
      } catch (_) {}
      return buffer;
    };
  }

  if (globalThis.Response?.prototype && typeof Response.prototype.arrayBuffer === "function") {
    const originalArrayBuffer = Response.prototype.arrayBuffer;
    Response.prototype.arrayBuffer = async function luckyrayResponseArrayBuffer() {
      const value = await Reflect.apply(originalArrayBuffer, this, arguments);
      const url = safeHttpUrl(this?.url);
      if (url && value instanceof ArrayBuffer) responseBufferUrls.set(value, url);
      return value;
    };
  }

  if (globalThis.Response?.prototype && typeof Response.prototype.json === "function") {
    const originalJson = Response.prototype.json;
    Response.prototype.json = async function luckyrayResponseJson() {
      const value = await Reflect.apply(originalJson, this, arguments);
      publishXVideoCandidate(value);
      publishPinterestVideoCatalog(value, this?.url);
      return value;
    };
  }

  if (globalThis.Response?.prototype && typeof Response.prototype.text === "function") {
    const originalText = Response.prototype.text;
    Response.prototype.text = async function luckyrayResponseText() {
      const value = await Reflect.apply(originalText, this, arguments);
      publishXVideoCandidateFromText(this?.url, value);
      publishPinterestVideoCatalogFromText(this?.url, value);
      return value;
    };
  }

  if (globalThis.Response?.prototype && typeof Response.prototype.blob === "function" && globalThis.Blob) {
    const originalBlob = Response.prototype.blob;
    Response.prototype.blob = async function luckyrayResponseBlob() {
      const value = await Reflect.apply(originalBlob, this, arguments);
      const url = safeHttpUrl(this?.url);
      if (url && value instanceof Blob) responseBlobUrls.set(value, url);
      return value;
    };
  }

  if (globalThis.Response?.prototype && globalThis.ReadableStream) {
    try {
      const bodyDescriptor = Object.getOwnPropertyDescriptor(Response.prototype, "body");
      if (typeof bodyDescriptor?.get === "function" && bodyDescriptor.configurable !== false) {
        Object.defineProperty(Response.prototype, "body", {
          ...bodyDescriptor,
          get() {
            const stream = Reflect.apply(bodyDescriptor.get, this, []);
            const url = safeHttpUrl(this?.url);
            if (url && stream instanceof ReadableStream) responseStreamUrls.set(stream, url);
            return stream;
          },
        });
      }
    } catch (_) {}
  }

  if (globalThis.ReadableStream?.prototype && typeof ReadableStream.prototype.getReader === "function") {
    const originalGetReader = ReadableStream.prototype.getReader;
    ReadableStream.prototype.getReader = function luckyrayGetReader() {
      const reader = Reflect.apply(originalGetReader, this, arguments);
      const url = responseStreamUrls.get(this);
      if (url && reader) responseReaderUrls.set(reader, url);
      return reader;
    };
  }

  if (globalThis.ReadableStreamDefaultReader?.prototype
    && typeof ReadableStreamDefaultReader.prototype.read === "function") {
    const originalRead = ReadableStreamDefaultReader.prototype.read;
    ReadableStreamDefaultReader.prototype.read = async function luckyrayReaderRead() {
      const result = await Reflect.apply(originalRead, this, arguments);
      const value = result?.value;
      const url = responseReaderUrls.get(this);
      const buffer = value instanceof ArrayBuffer
        ? value
        : ArrayBuffer.isView(value) ? value.buffer : null;
      if (url && buffer) responseBufferUrls.set(buffer, url);
      return result;
    };
  }

  if (globalThis.Blob?.prototype && typeof Blob.prototype.arrayBuffer === "function") {
    const originalBlobArrayBuffer = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = async function luckyrayBlobArrayBuffer() {
      const value = await Reflect.apply(originalBlobArrayBuffer, this, arguments);
      const url = responseBlobUrls.get(this);
      if (url && value instanceof ArrayBuffer) responseBufferUrls.set(value, url);
      return value;
    };
  }

  if (globalThis.XMLHttpRequest?.prototype && typeof XMLHttpRequest.prototype.send === "function") {
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function luckyrayXhrSend() {
      try {
        this.addEventListener("loadend", () => {
          const url = safeHttpUrl(this.responseURL);
          const value = this.response;
          if (url && value instanceof ArrayBuffer) responseBufferUrls.set(value, url);
          if (url && globalThis.Blob && value instanceof Blob) responseBlobUrls.set(value, url);
          if (url && value && typeof value === "object"
            && !(value instanceof ArrayBuffer)
            && !(globalThis.Blob && value instanceof Blob)) {
            publishPinterestVideoCatalog(value, url);
          } else if (url && (this.responseType === "" || this.responseType === "text")) {
            publishPinterestVideoCatalogFromText(url, this.responseText);
          }
        }, { once: true });
      } catch (_) {}
      return Reflect.apply(originalSend, this, arguments);
    };
  }

  if (globalThis.SourceBuffer?.prototype && typeof SourceBuffer.prototype.appendBuffer === "function") {
    const originalAppendBuffer = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function luckyrayAppendBuffer(value) {
      try {
        const rawBuffer = value instanceof ArrayBuffer
          ? value
          : ArrayBuffer.isView(value) ? value.buffer : null;
        const candidateUrl = rawBuffer ? responseBufferUrls.get(rawBuffer) : "";
        const owner = sourceBufferOwners.get(this);
        const blobUrl = owner ? mediaSourceBlobUrls.get(owner) : "";
        if (candidateUrl && blobUrl) {
          emit({
            kind: "mse-candidate",
            blobUrl,
            candidateUrl,
            contentType: sourceBufferTypes.get(this) || "",
          });
        }
      } catch (_) {}
      return Reflect.apply(originalAppendBuffer, this, arguments);
    };
  }

  try {
    document.addEventListener("encrypted", (event) => {
      const target = event?.target;
      const blobUrl = String(target?.currentSrc || target?.src || "");
      if (blobUrl.startsWith("blob:") && blobUrl.length <= MAX_URL_BYTES) {
        emit({ kind: "drm", blobUrl });
      }
    }, true);
  } catch (_) {}
})();
