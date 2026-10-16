(function installLuckyRayExtensionProtocol(global) {
  "use strict";

  const HOVER_TTL_MS = 8_000;
  const CONTEXT_TTL_MS = 10_000;
  const CAPTURE_PROTOCOL_VERSION = 2;
  const CAPTURE_SOURCES = new Set(["hover", "context-menu", "popup", "drag"]);
  const MAX_IMAGE_URL_BYTES = 4_096;
  const MAX_SRCSET_BYTES = 8_192;
  const MAX_SRCSET_CANDIDATES = 16;
  const MAX_PAGE_CONTENT_BYTES = 64 * 1_024;

  function opaqueActionId(prefix) {
    const suffix = global.crypto && typeof global.crypto.randomUUID === "function"
      ? global.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}:${suffix}`;
  }

  function normalizeCaptureSource(value) {
    const source = String(value || "").trim().toLowerCase();
    return CAPTURE_SOURCES.has(source) ? source : "";
  }

  function normalizeUrl(value, baseUrl) {
    try {
      const url = new URL(String(value || ""), baseUrl || undefined);
      return /^(https?:|blob:)$/.test(url.protocol) ? url.href : "";
    } catch (_) {
      return "";
    }
  }

  function normalizeSupportedVideoPageUrl(value) {
    try {
      const parsed = new URL(String(value || ""));
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) return "";
      const host = parsed.hostname.replace(/\.$/, "").toLowerCase();
      const isHost = (...suffixes) => suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
      parsed.hash = "";
      if (isHost("youtube.com") && parsed.pathname === "/watch") {
        const id = parsed.searchParams.get("v") || "";
        if (!/^[a-z0-9_-]{6,32}$/i.test(id)) return "";
        parsed.search = `?v=${id}`;
        return parsed.href;
      }
      if (isHost("youtube.com") && /^\/(?:shorts|embed)\/[a-z0-9_-]{6,32}\/?$/i.test(parsed.pathname)) {
        parsed.search = "";
        return parsed.href;
      }
      if (isHost("youtu.be") && /^\/[a-z0-9_-]{6,32}\/?$/i.test(parsed.pathname)) {
        parsed.search = "";
        return parsed.href;
      }
      if (isHost("bilibili.com") && /^\/video\/(?:BV[a-z0-9]+|av\d+)\/?$/i.test(parsed.pathname)) {
        parsed.search = "";
        return parsed.href;
      }
      if (isHost("b23.tv") && /^\/[a-z0-9_-]{2,64}\/?$/i.test(parsed.pathname)) {
        parsed.search = "";
        return parsed.href;
      }
      const xMatch = parsed.pathname.match(/^\/([^/]+)\/status\/(\d+)(?:\/video\/\d+)?\/?$/i);
      if (isHost("x.com", "twitter.com") && xMatch) {
        parsed.pathname = `/${xMatch[1]}/status/${xMatch[2]}`;
        parsed.search = "";
        return parsed.href;
      }
      const pinterestMatch = parsed.pathname.match(/^\/pin\/(?:[a-z0-9_-]+--)?(\d{6,32})\/?$/i);
      if (isHost("pinterest.com") && pinterestMatch) {
        parsed.pathname = `/pin/${pinterestMatch[1]}/`;
        parsed.search = "";
        return parsed.href;
      }
      return "";
    } catch (_) {
      return "";
    }
  }

  function sitePermissionDescriptor(value) {
    let host = "";
    try {
      const parsed = new URL(String(value || ""));
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
      host = parsed.hostname.replace(/\.$/, "").toLowerCase();
    } catch (_) {
      return null;
    }
    const matches = (suffix) => host === suffix || host.endsWith(`.${suffix}`);
    if (matches("youtube.com") || host === "youtu.be") {
      return Object.freeze({
        origins: Object.freeze(["https://*.youtube.com/*", "https://youtu.be/*"]),
        domains: Object.freeze(["youtube.com"]),
      });
    }
    if (matches("bilibili.com") || host === "b23.tv") {
      return Object.freeze({
        origins: Object.freeze(["https://*.bilibili.com/*", "https://b23.tv/*"]),
        domains: Object.freeze(["bilibili.com"]),
      });
    }
    if (matches("x.com") || matches("twitter.com")) {
      return Object.freeze({
        origins: Object.freeze(["https://*.x.com/*", "https://*.twitter.com/*"]),
        domains: Object.freeze(["x.com", "twitter.com"]),
      });
    }
    if (matches("pinterest.com")) {
      return Object.freeze({
        origins: Object.freeze(["https://*.pinterest.com/*"]),
        domains: Object.freeze(["pinterest.com"]),
      });
    }
    return null;
  }

  function chooseBoundVideoPageUrl(currentUrl, nearbyUrls) {
    for (const value of Array.from(nearbyUrls || []).slice(0, 64)) {
      const candidate = normalizeSupportedVideoPageUrl(value);
      if (candidate) return candidate;
    }
    const current = normalizeSupportedVideoPageUrl(currentUrl);
    if (!current) return "";
    try {
      const host = new URL(current).hostname.toLowerCase();
      if (host === "x.com" || host.endsWith(".x.com")
        || host === "twitter.com" || host.endsWith(".twitter.com")
        || host === "pinterest.com" || host.endsWith(".pinterest.com")) return "";
    } catch (_) {
      return "";
    }
    return current;
  }

  function normalizeImageCandidateUrl(value, baseUrl) {
    const raw = String(value || "").trim();
    if (!raw || raw.length > MAX_IMAGE_URL_BYTES || /[\u0000-\u001f\u007f\\]/.test(raw)) return "";
    try {
      const url = new URL(raw, baseUrl || undefined);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.href.length > MAX_IMAGE_URL_BYTES) return "";
      return url.href;
    } catch (_) {
      return "";
    }
  }

  function srcsetCandidates(value, baseUrl, baseScore, source) {
    const raw = String(value || "").trim();
    if (!raw || raw.length > MAX_SRCSET_BYTES) return [];
    return raw.split(",").slice(0, MAX_SRCSET_CANDIDATES).flatMap((part, index) => {
      const [candidate, descriptor = ""] = part.trim().split(/\s+/, 2);
      const url = normalizeImageCandidateUrl(candidate, baseUrl);
      if (!url) return [];
      const width = /^(\d{1,5})w$/i.exec(descriptor);
      const density = /^(\d+(?:\.\d{1,2})?)x$/i.exec(descriptor);
      const quality = width ? Math.min(Number(width[1]), 32_768)
        : density ? Math.min(Number(density[1]) * 1_000, 32_768)
          : 0;
      return [{ url, score: quality > 0 ? baseScore + quality : 80_000 - index, order: index, source: source || "srcset" }];
    });
  }

  function imageAttribute(element, name) {
    if (!element) return "";
    if (typeof element.getAttribute === "function") {
      const value = element.getAttribute(name);
      if (value) return value;
    }
    const property = name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    return element[property] || "";
  }

  function truncateUtf8(value, maxBytes) {
    let result = "";
    let used = 0;
    for (const character of String(value || "")) {
      const point = character.codePointAt(0);
      const bytes = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
      if (used + bytes > maxBytes) break;
      result += character;
      used += bytes;
    }
    return result;
  }

  function boundedText(value, maxBytes, multiline) {
    let text = String(value || "").replace(multiline
      ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
      : /[\u0000-\u001f\u007f]/g, "");
    if (multiline) {
      text = text.replace(/\r\n?/g, "\n")
        .replace(/[^\S\r\n]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n");
    } else {
      text = text.replace(/\s+/g, " ");
    }
    return truncateUtf8(text.trim(), maxBytes).trim();
  }

  function normalizePageUrl(value, baseUrl, requiredOrigin) {
    const raw = String(value || "").trim();
    if (!raw || raw.length > MAX_IMAGE_URL_BYTES || /[\u0000-\u001f\u007f\\]/.test(raw)) return "";
    try {
      const url = new URL(raw, baseUrl || undefined);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return "";
      if (requiredOrigin && url.origin !== requiredOrigin) return "";
      url.hash = "";
      return url.href.length <= MAX_IMAGE_URL_BYTES ? url.href : "";
    } catch (_) {
      return "";
    }
  }

  // Provenance is a navigation target, not a resolver/auth identity. Keep the
  // full work locator including query and SPA fragment.
  function normalizeSourcePageUrl(value, baseUrl) {
    const raw = String(value || "").trim();
    if (!raw || raw.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(raw)) return "";
    try {
      const url = new URL(raw, baseUrl || undefined);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return "";
      // A source is a public navigation target, never a signed media URL or
      // authentication-bearing page. Keep ordinary work locators intact.
      if (/\.(?:avif|gif|jpe?g|m3u8|mp4|mpd|png|webm|webp)$/i.test(url.pathname)) return "";
      const secretKey = (key) => /^(?:access_token|api_key|apikey|auth|authorization|bearer|cookie|secret|sig|signature|token|x-amz-[\w-]+)$/i.test(key);
      if ([...url.searchParams.keys()].some(secretKey)) return "";
      let fragment = url.hash.slice(1);
      for (let depth = 0; depth < 2; depth += 1) fragment = decodeURIComponent(fragment);
      if (fragment.split(/[?&;]/).some((part) => secretKey(part.split("=")[0]))) return "";
      return url.href.length <= 2048 ? url.href : "";
    } catch (_) { return ""; }
  }

  function normalizeBoundWorkPageUrl(value, baseUrl) {
    const page = normalizeSourcePageUrl(value, baseUrl);
    if (!page) return "";
    const url = new URL(page);
    const path = url.pathname.toLowerCase();
    if (/^\/(?:search|explore|discover|feed|home|user|users|profile|profiles|people|account|login|signup|ads?|advert|advertise|sponsor|sponsored|outbound|redirect|click)(?:\/|$)/.test(path)) return "";
    if (path === "/" && !["work", "item", "pin", "post", "artwork", "id"].some((key) => url.searchParams.has(key))
      && !/^#\/?(?:work|item|pin|post|artwork)\//i.test(url.hash)) return "";
    return page;
  }

  function createPageSnapshot(input) {
    const url = normalizePageUrl(input && input.url);
    if (!url) return null;
    const origin = new URL(url).origin;
    const canonicalUrl = normalizePageUrl(input && input.canonicalUrl, url, origin);
    const title = boundedText(input && input.title, 300, false);
    const description = boundedText(input && input.description, 1_000, false);
    const author = boundedText(input && input.author, 200, false);
    const publishedAt = boundedText(input && input.publishedAt, 100, false);
    const providedKind = ["selection", "article", "summary"].includes(input && input.contentKind)
      ? input.contentKind : "";
    const providedContent = boundedText(input && input.content, MAX_PAGE_CONTENT_BYTES, true);
    const selection = boundedText(input && input.selection, MAX_PAGE_CONTENT_BYTES, true)
      || (providedKind === "selection" ? providedContent : "");
    const articleText = boundedText(input && input.articleText, MAX_PAGE_CONTENT_BYTES, true)
      || (providedKind === "article" ? providedContent : "");
    const content = selection || articleText || (providedKind === "summary" ? providedContent : "") || description || title;
    const markdown = truncateUtf8(String(input?.markdown || ""), MAX_PAGE_CONTENT_BYTES).trim();
    const contentKind = selection ? "selection" : articleText ? "article" : "summary";
    return Object.freeze({
      title,
      url,
      canonicalUrl: canonicalUrl || "",
      sourceUrl: canonicalUrl || url,
      description,
      author,
      publishedAt,
      content,
      ...(markdown ? { markdown } : {}),
      contentKind,
      imageUrl: normalizeImageCandidateUrl(input && input.ogImage, url),
    });
  }

  function isPageSnapshotCurrent(snapshot, currentUrl) {
    if (!snapshot || !snapshot.url) return false;
    const expected = normalizePageUrl(snapshot.url);
    const current = normalizePageUrl(currentUrl);
    return Boolean(expected && current && expected === current);
  }

  function formatPageCaptureText(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return "";
    const content = typeof snapshot.markdown === "string" && snapshot.markdown && truncateUtf8(snapshot.markdown, MAX_PAGE_CONTENT_BYTES) === snapshot.markdown
      ? snapshot.markdown : boundedText(snapshot.content, MAX_PAGE_CONTENT_BYTES, true);
    const details = [];
    const description = boundedText(snapshot.description, 1_000, false);
    const author = boundedText(snapshot.author, 200, false);
    const publishedAt = boundedText(snapshot.publishedAt, 100, false);
    const sourceUrl = normalizePageUrl(snapshot.sourceUrl || snapshot.canonicalUrl || snapshot.url);
    if (description && description !== content) details.push(`摘要：${description}`);
    if (author) details.push(`作者：${author}`);
    if (publishedAt) details.push(`发布：${publishedAt}`);
    if (sourceUrl) details.push(`来源：${sourceUrl}`);
    return truncateUtf8([content, details.length ? "" : null, ...details]
      .filter((line) => line != null)
      .join("\n"), MAX_PAGE_CONTENT_BYTES + 2_048).trim();
  }

  function buildPagePreview(snapshot, captureType) {
    if (!snapshot || !["text", "link"].includes(captureType)) {
      return Object.freeze({ visible: false, kindLabel: "", title: "", metadata: "", snippet: "" });
    }
    const labels = { selection: "已选文字", article: "网页正文", summary: "网页摘要" };
    const metadata = [boundedText(snapshot.author, 200, false), boundedText(snapshot.publishedAt, 100, false)]
      .filter(Boolean)
      .join(" · ");
    const snippetSource = captureType === "link" ? snapshot.description || snapshot.title : snapshot.content;
    return Object.freeze({
      visible: true,
      kindLabel: captureType === "link" ? "网页链接" : labels[snapshot.contentKind] || "网页文字",
      title: boundedText(snapshot.title, 300, false),
      metadata,
      snippet: boundedText(snippetSource, 600, true),
    });
  }

  function pageCaptureReadiness(snapshot, captureType) {
    if (captureType !== "text") return Object.freeze({ ready: true, code: "ready" });
    if (snapshot?.captureProtocolVersion !== CAPTURE_PROTOCOL_VERSION) {
      return Object.freeze({ ready: false, code: "reload-required" });
    }
    const content = boundedText(snapshot?.content, MAX_PAGE_CONTENT_BYTES, true);
    const title = boundedText(snapshot?.title, 300, false);
    const description = boundedText(snapshot?.description, 1_000, false);
    if (!content || (snapshot?.contentKind === "summary" && content === title && !description)) {
      return Object.freeze({ ready: false, code: "no-readable-content" });
    }
    return Object.freeze({ ready: true, code: "ready" });
  }

  function noteWriteErrorCode(result) {
    const direct = result?.errorObject?.code;
    const nested = result?.errorObject?.error?.code;
    return typeof direct === "string" ? direct : typeof nested === "string" ? nested : "";
  }

  function conflictFreeNoteTitle(title, now) {
    const base = boundedText(title, 220, false) || "网页收集";
    const date = new Date(Number.isFinite(now) ? now : Date.now());
    const part = (value) => String(value).padStart(2, "0");
    const stamp = `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
    return `${base} · 网页收集 ${stamp}`;
  }

  async function createNoteWithConflictRecovery(writer, title, now = Date.now()) {
    if (typeof writer !== "function") return { ok: false, errorObject: { code: "note-writer-unavailable" } };
    const safeTitle = boundedText(title, 300, false) || "网页收集";
    const first = await writer(safeTitle);
    if (first?.ok || noteWriteErrorCode(first) !== "knowledge-name-conflict") return first;
    return await writer(conflictFreeNoteTitle(safeTitle, now));
  }

  function formatNoteWriteFailure(result) {
    const code = noteWriteErrorCode(result);
    if (code === "knowledge-name-conflict") return "同名笔记已存在，请修改标题后重试";
    if (code === "knowledge-not-found" || code === "knowledge-document-not-found") return "目标笔记已不存在，请重新选择";
    if (["knowledge-current-context-required", "knowledge-current-context-changed", "knowledge-current-context-conflict", "knowledge-target-not-current"].includes(code)) return "当前笔记已变化，请重新选择保存目标";
    if (["knowledge-source-inactive", "knowledge-vault-required", "knowledge-vault-changed", "knowledge-vault-mismatch", "knowledge-vault-not-current"].includes(code)) return "知识库已切换或关闭，请重新选择保存目标";
    if (code === "knowledge-revision-conflict") return "笔记内容已变化，请刷新后重新保存";
    if (code === "note-material-not-found") return "素材已不存在，请重新收集";
    if (code === "note-material-target-invalid") return "请选择有效的笔记目标";
    if (code === "note-material-title-invalid") return "笔记标题无效，请修改后重试";
    if (code === "note-material-source-invalid") return "网页来源地址无效，请重新采集";
    if (code === "capture-commit-uncertain") return "保存结果待核对，请先在桌面端检查笔记，避免重复保存";
    if (code === "capture-commit-partial") return "笔记写入未完成，请先在桌面端核对笔记和附件";
    if (code === "capture-receipt-unavailable") return "桌面端无法记录保存结果，请检查磁盘后重试";
    if (code === "request-id-conflict") return "保存请求与原目标不一致，请重新采集";
    if (code === "host-unavailable" || code === "app-unavailable") return "LuckyRay 当前未连接";
    return "笔记保存失败，请稍后重试";
  }

  function buildPopupPagePayload(pageInfo, media = {}) {
    const snapshot = createPageSnapshot(pageInfo);
    if (!snapshot) {
      return Object.freeze({
        captureProtocolVersion: 0,
        title: "",
        url: "",
        sourceUrl: "",
        selection: "",
        articleText: "",
        content: "",
        contentKind: "summary",
        description: "",
        author: "",
        publishedAt: "",
        imageUrl: "",
        videoUrl: "",
      });
    }
    const protocolVersion = pageInfo?.captureProtocolVersion === CAPTURE_PROTOCOL_VERSION
      ? CAPTURE_PROTOCOL_VERSION : 0;
    const contextImageUrl = normalizeImageCandidateUrl(media.imageUrl, snapshot.url);
    const imageUrl = contextImageUrl || snapshot.imageUrl;
    const videoUrl = normalizeVideoCandidateUrl(media.videoUrl, snapshot.url);
    return Object.freeze({
      ...snapshot,
      captureProtocolVersion: protocolVersion,
      selection: snapshot.contentKind === "selection" ? snapshot.content : "",
      articleText: snapshot.contentKind === "article" ? snapshot.content : "",
      imageUrl,
      contextImageUrl,
      videoUrl,
    });
  }

  function buildCaptureTargetPolicy(captureType, environment = {}) {
    const hasCurrentNote = environment.hasCurrentNote === true;
    const hasRecentNotes = environment.hasRecentNotes === true;
    const noteTargets = [
      ...(hasCurrentNote ? ["note:insertCurrent"] : []),
      ...(hasRecentNotes ? ["note:recent"] : []),
      "note:search",
      "note:new",
    ];
    const media = captureType === "image" || captureType === "video" || captureType === "audio";
    const allowedTargets = media
      ? ["asset:root", "asset:pick", "asset:newFolder", ...(captureType === "audio" ? [] : noteTargets)]
      : [...noteTargets, "collection:queue"];
    return Object.freeze({
      allowedTargets: Object.freeze(allowedTargets),
      defaultTarget: media ? "asset:root" : hasCurrentNote ? "note:insertCurrent" : "note:new",
      showRecording: captureType === "video",
      showCurrentNote: hasCurrentNote,
    });
  }

  // ---- M1-S2 Quick Collect view-model / label policy (Issue #18) -------------
  // Pure functions only: they never touch transport, chrome.storage, DOM or
  // any write authority. The popup only renders what these decide, and the
  // explicit commit gate derives from the existing target policy — there is no
  // second destination truth.

  const QUICK_COLLECT_TYPE_LABELS = Object.freeze({
    image: "图片",
    video: "视频",
    audio: "音频",
    text: "正文",
    link: "链接",
  });

  function quickCollectTypeLabel(captureType) {
    return QUICK_COLLECT_TYPE_LABELS[String(captureType || "")] || "";
  }

  const QUICK_COLLECT_TARGET_LABELS = Object.freeze({
    "asset:root": "素材库根目录",
    "asset:pick": "指定素材文件夹",
    "asset:newFolder": "新建素材文件夹",
    "note:insertCurrent": "当前笔记光标处",
    "note:recent": "指定最近笔记",
    "note:search": "搜索并追加到笔记",
    "note:new": "新建笔记",
    "collection:queue": "收集箱兜底",
  });

  function quickCollectTargetLabel(target) {
    return QUICK_COLLECT_TARGET_LABELS[String(target || "")] || "";
  }

  // Whether the selected target is fully specified (no extra user selection
  // pending). Incomplete targets must not be treated as one-click submittable.
  // note:search additionally requires the selection to be bound to the
  // current search query — a stale note id from another mode (or an older
  // query) must never authorize a write (BROWSER-EXT-CONTROLLER FIX-1 P1).
  function quickCollectTargetComplete(target, selection = {}) {
    const value = String(target || "");
    if (value === "asset:pick") return Boolean(selection.selectedFolderId);
    if (value === "note:recent") return Boolean(selection.selectedNoteId);
    if (value === "note:search") {
      return Boolean(selection.selectedNoteId) && selection.searchSelectionMatchesQuery === true;
    }
    return value === "asset:root"
      || value === "asset:newFolder"
      || value === "note:insertCurrent"
      || value === "note:new"
      || value === "collection:queue";
  }

  // Explicit commit gate: only a connected, ready, complete state may submit.
  // Popup open, render, preview refresh and advanced toggle never bypass this
  // gate — writes only ever follow an explicit user submit.
  function quickCollectSubmitGate(input = {}) {
    if (!input.port) return Object.freeze({ canSubmit: false, reason: "LuckyRay 未连接" });
    const readiness = input.readiness && typeof input.readiness === "object"
      ? input.readiness : { ready: false, code: "" };
    if (readiness.ready !== true) {
      const reason = readiness.code === "reload-required"
        ? "请先应用插件更新，再重新采集"
        : readiness.code === "no-readable-content"
          ? "当前页面没有可保存正文"
          : "当前内容不可采集";
      return Object.freeze({ canSubmit: false, reason });
    }
    if (!quickCollectTargetComplete(input.target, input.selection || {})) {
      return Object.freeze({ canSubmit: false, reason: "请展开更多选项，完成保存位置选择" });
    }
    // EXT-R1-R1 P2-1: the visible submit gate must equal the final write gate
    // — a video selection that requires an explicit re-pick blocks here too,
    // with the same visible reason the write path would give.
    // EXT-R1-REPAIR-2 (contract C): every allowed video destination shares
    // the visible selection gate — not only asset targets.
    if (input.videoSelection) {
      const videoSelection = input.videoSelection;
      if (videoSelection.requiresPick === true || videoSelection.hasValidSelection !== true) {
        return Object.freeze({
          canSubmit: false,
          reason: videoSelection.requiresPick === true
            ? "视频候选已变化，请重新选择要保存的视频"
            : "请先选择要保存的视频",
        });
      }
    }
    return Object.freeze({ canSubmit: true, reason: "" });
  }

  function quickCollectDefaultViewState() {
    return Object.freeze({ advancedCollapsed: true });
  }

  function buildContextMenuSpecification() {
    return [
      { id: "luckyray-page-append", kind: "page", title: "追加网页正文到指定笔记…" },
      { id: "luckyray-page-new", kind: "page", title: "保存网页正文为新笔记" },
      { id: "luckyray-selection-append", kind: "selection", title: "追加选中文字到指定笔记…" },
      { id: "luckyray-selection-new", kind: "selection", title: "保存选中文字为新笔记" },
      { id: "luckyray-link-append", kind: "link", title: "追加链接到指定笔记…" },
      { id: "luckyray-link-new", kind: "link", title: "保存链接为新笔记" },
      { id: "luckyray-image-root", kind: "image", title: "保存图片到素材库" },
      { id: "luckyray-image-pick", kind: "image", title: "保存图片到指定文件夹…" },
      { id: "luckyray-image-new-folder", kind: "image", title: "保存图片到新建文件夹…" },
      { id: "luckyray-video-root", kind: "video", title: "保存视频到素材库" },
      { id: "luckyray-video-pick", kind: "video", title: "保存视频到指定文件夹…" },
      { id: "luckyray-video-new-folder", kind: "video", title: "保存视频到新建文件夹…" },
    ].map((item) => Object.freeze({
      ...item,
      contexts: Object.freeze(["all"]),
      visible: item.kind === "page",
    }));
  }

  function resolveContextMenuKind(info = {}, captures = {}, now = Date.now()) {
    if (boundedText(info.selectionText, 4_096, true)) return "selection";
    const liveKind = ["page", "selection", "link", "image", "video"].includes(info.contextKind)
      ? info.contextKind : "";
    if (liveKind) return liveKind;
    if (info.mediaType === "video") return "video";
    if (info.mediaType === "image") return "image";
    const infoLink = normalizePageUrl(info.linkUrl);
    const infoSource = normalizeUrl(info.srcUrl);
    const matchesExactContext = (descriptor) => {
      if (!descriptor || descriptor.confidence !== "contextmenu") return false;
      const capturedAt = Number(descriptor.capturedAt);
      if (!Number.isFinite(capturedAt) || now - capturedAt < 0 || now - capturedAt > 1_500) return false;
      const descriptorLink = normalizePageUrl(descriptor.linkUrl);
      const descriptorSource = normalizeUrl(descriptor.browserUrl || descriptor.url);
      return Boolean((infoLink && descriptorLink === infoLink) || (infoSource && descriptorSource === infoSource));
    };
    if (matchesExactContext(captures.video)) return "video";
    if (matchesExactContext(captures.image)) return "image";
    return infoLink ? "link" : "page";
  }

  function contextMenuVisibility(specification, kind) {
    return Array.from(specification || []).map((item) => Object.freeze({
      id: item.id,
      visible: item.kind === kind,
    }));
  }

  function choosePopupCaptureType(snapshot) {
    if (boundedText(snapshot?.selection, MAX_PAGE_CONTENT_BYTES, true)) return "text";
    if (normalizeVideoCandidateUrl(snapshot?.videoUrl, snapshot?.url)) return "video";
    if (normalizeImageCandidateUrl(snapshot?.contextImageUrl, snapshot?.url)) return "image";
    return "text";
  }

  function normalizeVideoCandidateUrl(value, baseUrl) {
    const raw = String(value || "").trim();
    if (!raw || raw.length > MAX_IMAGE_URL_BYTES || /[\u0000-\u001f\u007f\\]/.test(raw)) return "";
    try {
      const url = new URL(raw, baseUrl || undefined);
      if (!/^(https?:|blob:)$/.test(url.protocol) || url.username || url.password || url.href.length > MAX_IMAGE_URL_BYTES) return "";
      return url.href;
    } catch (_) {
      return "";
    }
  }

  function videoTransferFileName(titleValue, urlValue, extensionValue) {
    const title = String(titleValue || "LuckyRay video")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "LuckyRay video";
    const allowed = new Set(["mp4", "webm", "mov", "m4v", "ogv", "ogg", "avi", "mkv", "ts"]);
    const selected = String(extensionValue || "").toLowerCase();
    let extension = allowed.has(selected) ? selected : "";
    if (!extension) {
      const normalized = normalizeVideoCandidateUrl(urlValue);
      if (normalized && !normalized.startsWith("blob:")) {
        const found = new URL(normalized).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
        if (found && allowed.has(found)) extension = found;
      }
    }
    return `${title}.${extension || "mp4"}`;
  }

  function classifyVideoCandidateUrl(value, contentType, baseUrl) {
    const url = normalizeVideoCandidateUrl(value, baseUrl);
    if (!url) return null;
    const lower = url.toLowerCase();
    const parsed = lower.startsWith("blob:") ? null : new URL(url);
    const path = parsed ? parsed.pathname.toLowerCase() : "";
    const type = String(contentType || "").trim().toLowerCase();
    const host = String(parsed?.hostname || "").toLowerCase();
    const pinterestCmfv = /\.cmfv$/.test(path)
      && (host === "pinimg.com" || host.endsWith(".pinimg.com"));
    const directPath = /\.(?:mp4|webm|mov|m4v|ogv|ogg|avi|mkv)$/.test(path) || pinterestCmfv;
    let kind = type === "application/x-luckyray-video-page"
      ? "site-resolver"
      : directPath || type.startsWith("video/") ? "direct-video" : "http-video";
    let importable = kind === "direct-video";
    if (lower.startsWith("blob:")) {
      kind = "blob";
      importable = false;
    } else if (/\.m3u8$/.test(path) || type.includes("mpegurl")) {
      kind = "hls";
      importable = false;
    } else if (/\.mpd$/.test(path) || type.includes("dash+xml")) {
      kind = "dash";
      importable = false;
    } else if (/\.(?:ts|m4s)$/.test(path)) {
      kind = "segment";
      importable = false;
    }
    return Object.freeze({ url, kind, importable });
  }

  function selectVideoCandidate(element, baseUrl) {
    if (!element) return null;
    const candidates = [];
    const add = (value, score, source, contentType, recognizedOnly = false) => {
      const classified = classifyVideoCandidateUrl(value, contentType, baseUrl);
      if (!classified || (recognizedOnly && classified.kind === "http-video")) return;
      const kindPriority = classified.importable ? 1_000_000
        : classified.kind === "hls" || classified.kind === "dash" ? 200_000
          : classified.kind === "segment" ? 100_000 : 0;
      candidates.push({ ...classified, source, score: kindPriority + score, order: candidates.length });
    };
    const tag = String(element.tagName || "").toUpperCase();
    if (tag === "VIDEO") {
      add(element.currentSrc, 100_000, "currentSrc", element.type);
      add(element.src, 90_000, "src", element.type);
      const sources = typeof element.querySelectorAll === "function"
        ? Array.from(element.querySelectorAll("source[src]")).slice(0, MAX_SRCSET_CANDIDATES)
        : [];
      for (let index = 0; index < sources.length; index += 1) {
        const source = sources[index];
        add(imageAttribute(source, "src"), 110_000 - index, "source", imageAttribute(source, "type"));
      }
      for (const [attribute, score, recognizedOnly] of [
        ["data-original", 120_000, true],
        ["data-video", 119_000, false],
        ["data-src", 118_000, false],
        ["data-url", 117_000, false],
      ]) {
        add(imageAttribute(element, attribute), score, attribute, "", recognizedOnly);
      }
    } else if (tag === "SOURCE") {
      add(imageAttribute(element, "src"), 110_000, "source", imageAttribute(element, "type"));
    } else if (tag === "A") {
      add(element.href || imageAttribute(element, "href"), 80_000, "link", "", true);
    }
    const selected = candidates.sort((left, right) => right.score - left.score || left.order - right.order)[0];
    return selected ? Object.freeze({
      url: selected.url,
      kind: selected.kind,
      importable: selected.importable,
      source: selected.source,
    }) : null;
  }

  function inferVideoDimensionsFromUrl(value) {
    try {
      const decodedPath = decodeURIComponent(new URL(value).pathname);
      const dimension = decodedPath.match(/(?:^|[-_.=/])(\d{2,5})[x×](\d{2,5})(?:[-_.=/]|$)/i);
      const quality = decodedPath.match(/(?:^|[-_.=/])(\d{3,4})p(?:[-_.=/]|$)/i);
      const sourceWidth = decodedPath.match(/(?:^|[-_.=/])(\d{3,4})w(?:[-_.=/]|$)/i);
      if (dimension) {
        return {
          width: Math.min(16_384, Number(dimension[1]) || 0),
          height: Math.min(16_384, Number(dimension[2]) || 0),
        };
      }
      if (quality) return { width: 0, height: Math.min(16_384, Number(quality[1]) || 0) };
      if (sourceWidth) return { width: Math.min(16_384, Number(sourceWidth[1]) || 0), height: 0 };
    } catch (_) {}
    return { width: 0, height: 0 };
  }

  function collectVideoElementCandidates(element, baseUrl) {
    if (!element) return Object.freeze([]);
    const video = String(element.tagName || "").toUpperCase() === "VIDEO"
      ? element
      : typeof element.closest === "function" ? element.closest("video") : null;
    if (!video) return Object.freeze([]);
    const duration = Number.isFinite(Number(video.duration)) && Number(video.duration) > 0
      ? Math.min(24 * 60 * 60, Number(video.duration)) : 0;
    const nativeWidth = Number.isFinite(Number(video.videoWidth)) ? Math.max(0, Math.trunc(Number(video.videoWidth))) : 0;
    const nativeHeight = Number.isFinite(Number(video.videoHeight)) ? Math.max(0, Math.trunc(Number(video.videoHeight))) : 0;
    const seen = new Set();
    const candidates = [];
    const add = (value, contentType, source, fallbackDimensions = false) => {
      const classified = classifyVideoCandidateUrl(value, contentType, baseUrl);
      if (!classified || seen.has(classified.url)) return;
      seen.add(classified.url);
      let { width, height } = inferVideoDimensionsFromUrl(classified.url);
      if (fallbackDimensions && !height) {
        width = nativeWidth;
        height = nativeHeight;
      }
      candidates.push(Object.freeze({
        url: classified.url,
        kind: classified.kind,
        importable: classified.importable,
        contentType: String(contentType || "").slice(0, 96),
        source,
        width,
        height,
        duration,
      }));
    };
    add(video.currentSrc, video.type, "currentSrc", true);
    add(video.src, video.type, "src", true);
    const sources = typeof video.querySelectorAll === "function"
      ? Array.from(video.querySelectorAll("source[src]")).slice(0, MAX_SRCSET_CANDIDATES)
      : [];
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index];
      add(imageAttribute(source, "src"), imageAttribute(source, "type"), `source-${index + 1}`);
    }
    return Object.freeze(candidates);
  }

  function isVideoUrlImportable(value, contentType, baseUrl) {
    return classifyVideoCandidateUrl(value, contentType, baseUrl)?.importable === true;
  }

  function buildVideoActionMenu(candidates, options = {}) {
    const maxItems = Math.max(1, Math.min(16, Number(options.maxItems) || 12));
    const seen = new Set();
    let canRecord = false;
    const items = [];
    const sourceCandidates = Array.from(candidates || []).slice(0, 64);
    for (let sourceIndex = 0; sourceIndex < sourceCandidates.length; sourceIndex += 1) {
      const input = sourceCandidates[sourceIndex];
      const classified = classifyVideoCandidateUrl(input?.url, input?.contentType, options.baseUrl);
      if (!classified) continue;
      const audioUrl = normalizeUrl(input?.audioUrl, options.baseUrl);
      const hasTrackPair = input?.binding === "site-track-pair"
        && /^https?:\/\//i.test(audioUrl)
        && audioUrl !== classified.url;
      const kind = hasTrackPair ? "track-pair" : classified.kind;
      if (kind === "blob") {
        canRecord = true;
        continue;
      }
      if (kind === "segment") continue;
      const supportedKind = kind === "direct-video" || kind === "http-video" || kind === "hls"
        || kind === "dash" || kind === "site-resolver" || kind === "track-pair";
      if (!supportedKind || seen.has(classified.url)) continue;
      if (kind === "hls" || kind === "dash" || kind === "http-video") canRecord = true;
      seen.add(classified.url);
      let height = Number.isFinite(Number(input?.height))
        ? Math.max(0, Math.min(16_384, Math.trunc(Number(input.height))))
        : 0;
      let width = Number.isFinite(Number(input?.width))
        ? Math.max(0, Math.min(16_384, Math.trunc(Number(input.width))))
        : 0;
      if (!height) {
        const inferred = inferVideoDimensionsFromUrl(classified.url);
        width ||= inferred.width;
        height = inferred.height;
      }
      const bitrate = Number.isFinite(Number(input?.bitrate))
        ? Math.max(0, Math.min(1_000_000_000, Math.trunc(Number(input.bitrate))))
        : 0;
      const size = Number.isFinite(Number(input?.size))
        ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(Number(input.size))))
        : 0;
      const parsed = new URL(classified.url);
      const extension = parsed.pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toUpperCase() || "";
      const format = kind === "site-resolver" ? "解析最佳版本" : kind === "track-pair" ? "音视频合并"
        : kind === "hls" ? "HLS" : kind === "dash" ? "DASH"
        : extension || String(input?.contentType || "").split("/")[1]?.split(";")[0]?.toUpperCase() || "VIDEO";
      const quality = kind === "site-resolver" ? "" : height ? `${height}p` : width ? `${width}w`
        : kind === "hls" ? "优先高分辨率" : "分辨率未知";
      const detail = size && (kind === "direct-video" || kind === "http-video")
        ? `${Math.max(0.1, Math.round((size / (1024 * 1024)) * 10) / 10).toLocaleString("en-US", { maximumFractionDigits: 1 })} MB`
        : bitrate ? `${Math.round(bitrate / 1000)} kbps` : "";
      items.push(Object.freeze({
        candidateId: `video-${items.length + 1}`,
        sourceIndex,
        host: parsed.hostname.toLowerCase(),
        kind,
        format,
        width,
        height,
        bitrate,
        sizeBytes: size,
        label: [quality, format, detail].filter(Boolean).join(" · "),
        canDownload: false,
        canSaveToMaterials: ["direct-video", "http-video", "hls", "dash", "site-resolver", "track-pair"].includes(kind),
      }));
      if (items.length >= maxItems) break;
    }
    const preferredAdaptiveHls = (item) => Number(item.kind === "hls" && !item.height && !item.width);
    items.sort((left, right) => preferredAdaptiveHls(right) - preferredAdaptiveHls(left)
      || right.height - left.height
      || right.width - left.width
      || right.bitrate - left.bitrate
      || Number(right.canDownload) - Number(left.canDownload));
    return Object.freeze({ items: Object.freeze(items), canRecord });
  }

  function placeVideoActionChip(rect, viewport) {
    const width = Number(rect?.width);
    const height = Number(rect?.height);
    const viewportWidth = Number(viewport?.width);
    const viewportHeight = Number(viewport?.height);
    const left = Number(rect?.left);
    const top = Number(rect?.top);
    const right = Number(rect?.right);
    const bottom = Number(rect?.bottom);
    const valid = [width, height, viewportWidth, viewportHeight, left, top, right, bottom]
      .every(Number.isFinite);
    if (!valid || width < 160 || height < 90 || right <= 0 || bottom <= 0
      || left >= viewportWidth || top >= viewportHeight) {
      return Object.freeze({ visible: false, left: 0, top: 0 });
    }
    const chipSize = 32;
    const inset = 12;
    return Object.freeze({
      visible: true,
      left: Math.max(8, Math.min(viewportWidth - chipSize - 8, Math.round(right - chipSize - inset))),
      top: Math.max(8, Math.min(viewportHeight - chipSize - 8, Math.round(top + inset))),
    });
  }

  function selectImageCandidate(element, baseUrl) {
    if (!element) return null;
    const candidates = [];
    const add = (value, score, source) => {
      const url = normalizeImageCandidateUrl(value, baseUrl);
      if (url) candidates.push({ url, score, source, order: candidates.length });
    };
    // M1-S3 (PRODUCT-DIRECTION): target identity first, best quality within
    // that SAME target. This resolver only ever reads this element's own
    // attributes and its explicit <picture> binding — no sibling/ancestor/
    // page scan — so the highest-scoring safe candidate below is always
    // same-target. srcset w/x tiers and the allowlisted same-element
    // original-image attributes may beat the currently displayed tier;
    // currentSrc stays the displayed-resource evidence and reliable
    // fallback, not a quality ceiling.
    add(element.currentSrc, 100_000, "currentSrc");
    add(element.src, 90_000, "src");
    candidates.push(...srcsetCandidates(element.srcset, baseUrl, 110_000, "srcset"));
    candidates.push(...srcsetCandidates(imageAttribute(element, "data-srcset"), baseUrl, 115_000, "data-srcset"));
    const picture = typeof element.closest === "function" ? element.closest("picture") : null;
    const sources = picture && typeof picture.querySelectorAll === "function"
      ? Array.from(picture.querySelectorAll("source[srcset]")).slice(0, 8)
      : [];
    const currentUrl = normalizeImageCandidateUrl(element.currentSrc, baseUrl);
    for (const source of sources) {
      const sourceCandidates = srcsetCandidates(imageAttribute(source, "srcset"), baseUrl, 120_000, "picture-source");
      if (currentUrl && sourceCandidates.some((candidate) => candidate.url === currentUrl)) {
        candidates.push(...sourceCandidates);
        break;
      }
    }
    // Allowlisted original-image attributes only — never arbitrary data-*.
    for (const [attribute, score] of [
      ["data-original", 220_000],
      ["data-full", 219_000],
      ["data-zoom-image", 218_000],
      ["data-hi-res", 217_000],
      ["data-src", 95_000],
    ]) {
      add(imageAttribute(element, attribute), score, attribute);
    }
    const bestByUrl = new Map();
    for (const candidate of candidates) {
      const previous = bestByUrl.get(candidate.url);
      if (!previous || candidate.score > previous.score) bestByUrl.set(candidate.url, candidate);
    }
    const selected = [...bestByUrl.values()].sort((left, right) => right.score - left.score || left.order - right.order)[0];
    if (!selected) return null;
    // Provenance: when the winning URL IS the currently displayed resource,
    // report it as currentSrc (target-identity evidence); otherwise report
    // the upgrade source (srcset / data-srcset / picture-source / data-*).
    const source = currentUrl && selected.url === currentUrl ? "currentSrc" : (selected.source || "srcset");
    return Object.freeze({ url: selected.url, source });
  }

  function rectFor(element) {
    if (element && element.rect) return element.rect;
    if (element && typeof element.getBoundingClientRect === "function") return element.getBoundingClientRect();
    return null;
  }

  function pointInRect(x, y, rect) {
    return !!rect && Number.isFinite(x) && Number.isFinite(y)
      && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  // M1-S3 FIX-2: ONE content-side visual-image resolver backed by the same
  // strict image-candidate policy, used consistently for capture fallback and
  // luckyray-get-hover-image revalidation. Covers IMG (same-target
  // best-quality HD/original policy), VIDEO poster, SVG <image> href/xlink,
  // SOURCE (bounded to its picture img, else strict first srcset entry), and
  // CSS background — every URL goes through normalizeImageCandidateUrl
  // (http(s) only, no credentials, bounded length, control-char rejection).
  function visualImageCandidate(element) {
    if (!element) return null;
    const tag = String(element.tagName || "").toUpperCase();
    const baseUrl = global.location && global.location.href;
    if (tag === "IMG") {
      const selected = selectImageCandidate(element, baseUrl);
      return selected ? { url: selected.url, source: selected.source, targetKind: "img" } : null;
    }
    if (tag === "IMAGE") {
      const href = imageAttribute(element, "href")
        || imageAttribute(element, "xlink:href")
        || (element.href && typeof element.href === "object" && element.href.baseVal
          ? String(element.href.baseVal) : "");
      const url = normalizeImageCandidateUrl(href, baseUrl);
      return url ? { url, source: "svg-href", targetKind: "svg-image" } : null;
    }
    if (tag === "VIDEO") {
      const url = normalizeImageCandidateUrl(imageAttribute(element, "poster"), baseUrl);
      return url ? { url, source: "poster", targetKind: "video-poster" } : null;
    }
    if (tag === "SOURCE") {
      const picture = typeof element.closest === "function" ? element.closest("picture") : null;
      const img = picture && typeof picture.querySelector === "function" ? picture.querySelector("img") : null;
      if (img) {
        const viaImg = visualImageCandidate(img);
        if (viaImg) return viaImg;
      }
      const url = normalizeImageCandidateUrl(
        String(element.srcset || "").split(",")[0]?.trim().split(/\s+/)[0] || "",
        baseUrl,
      );
      return url ? { url, source: "srcset", targetKind: "img" } : null;
    }
    // CSS background: same strict sanitizer — a URL rejected here (credentials,
    // javascript:, overlong, ...) can never be resurrected by a loose
    // content-side fallback (M1-S3 FIX-2).
    let background = "";
    if (element.backgroundUrl) {
      background = element.backgroundUrl;
    } else {
      try {
        const style = typeof global.getComputedStyle === "function" ? global.getComputedStyle(element) : null;
        const match = style && style.backgroundImage && style.backgroundImage !== "none"
          ? style.backgroundImage.match(/url\((['"]?)(.*?)\1\)/) : null;
        background = match ? match[2] : "";
      } catch (_) {
        background = "";
      }
    }
    const url = normalizeImageCandidateUrl(background, baseUrl);
    return url ? { url, source: "background", targetKind: "background" } : null;
  }

  function imageUrl(element) {
    return visualImageCandidate(element)?.url || "";
  }

  function videoUrl(element) {
    return selectVideoCandidate(element, global.location && global.location.href)?.url || "";
  }

  function selectPointMedia(type, x, y, elements) {
    for (const element of elements || []) {
      const rect = rectFor(element);
      if (!pointInRect(x, y, rect)) continue;
      const url = type === "video" ? videoUrl(element) : imageUrl(element);
      if (!url) continue;
      return type === "video" ? { url, importable: isVideoUrlImportable(url) } : { url, importable: true };
    }
    return null;
  }

  // EXT-R1-R1 P1-1: one type-aware URL boundary. Image descriptors go through
  // the strict image sanitizer; video keeps its own importability semantics.
  function descriptorUrlFor(type, value, baseUrl) {
    return type === "video"
      ? normalizeVideoCandidateUrl(value, baseUrl)
      : normalizeImageCandidateUrl(value, baseUrl);
  }

  function createCaptureDescriptor(input) {
    const type = input.type === "video" ? "video" : "image";
    const url = descriptorUrlFor(type, input && input.url, input && input.baseUrl);
    if (!url) return null;
    const browserUrl = descriptorUrlFor(type, input && input.browserUrl, input && input.baseUrl);
    return Object.freeze({
      type,
      url,
      browserUrl: browserUrl || null,
      linkUrl: normalizeBoundWorkPageUrl(input && input.linkUrl, input && input.baseUrl) || null,
      materialSourcePageUrl: type === "video"
        ? normalizeBoundWorkPageUrl(input && input.materialSourcePageUrl, input && input.baseUrl) || null : null,
      capturedAt: Number(input.capturedAt) || Date.now(),
      confidence: String(input.confidence || "hover-point"),
      tabId: Number.isInteger(input.tabId) ? input.tabId : null,
      frameId: Number.isInteger(input.frameId) ? input.frameId : null,
      documentId: input.documentId || null,
      documentToken: input.documentToken || null,
      clientX: Number.isFinite(input.clientX) ? input.clientX : null,
      clientY: Number.isFinite(input.clientY) ? input.clientY : null,
      scrollX: Number.isFinite(input.scrollX) ? input.scrollX : null,
      scrollY: Number.isFinite(input.scrollY) ? input.scrollY : null,
      targetToken: input.targetToken || null,
      actionId: input.actionId || null,
      source: input.source || null,
      targetKind: input.targetKind || null,
      importable: input.type !== "video" || isVideoUrlImportable(url),
    });
  }

  function sameIdentity(expected, actual) {
    return expected == null || expected === actual;
  }

  function isCaptureDescriptorUsable(descriptor, context) {
    if (!descriptor || !descriptor.url || !context) return false;
    const ttl = descriptor.confidence === "contextmenu" || descriptor.confidence === "browser-contextmenu"
      ? CONTEXT_TTL_MS : HOVER_TTL_MS;
    if (!Number.isFinite(context.now) || context.now - descriptor.capturedAt < 0 || context.now - descriptor.capturedAt > ttl) return false;
    if (!sameIdentity(descriptor.tabId, context.tabId)) return false;
    if (!sameIdentity(descriptor.frameId, context.frameId)) return false;
    if (!sameIdentity(descriptor.documentId, context.documentId)) return false;
    if (!sameIdentity(descriptor.documentToken, context.documentToken)) return false;
    if (descriptor.scrollX != null && descriptor.scrollX !== context.scrollX) return false;
    if (descriptor.scrollY != null && descriptor.scrollY !== context.scrollY) return false;
    if (!sameIdentity(descriptor.targetToken, context.targetToken)) return false;
    if (context.targetConnected === false) return false;
    if (context.targetUrl != null && normalizeUrl(context.targetUrl) !== descriptor.url) return false;
    return true;
  }

  function resolveCapturedDescriptor(descriptor, context) {
    return isCaptureDescriptorUsable(descriptor, context) ? descriptor : null;
  }

  // EXT-R1-REPAIR-2 (contract A): one explicit commit identity for an image
  // prefill. Both sides must prove the SAME current target: strict normalized
  // type+URL, tab/frame/document, document/target tokens, scroll binding and
  // capture freshness within the context TTL. URL equality alone is never
  // sufficient. The fresh side must itself be valid and current at Save time.
  function boundCaptureIdentity(descriptor, type, url, context = {}) {
    if (!descriptor || typeof descriptor !== "object" || !url) return null;
    const now = Number.isFinite(context.now) ? context.now : Date.now();
    const capturedAt = Number(descriptor.capturedAt) || 0;
    const age = now - capturedAt;
    if (!Number.isFinite(capturedAt) || age < 0 || age > (Number.isFinite(context.ttlMs) ? context.ttlMs : CONTEXT_TTL_MS)) return null;
    const boundedToken = (value) => {
      const token = String(value || "");
      return token && token.length <= 256 && !/[\u0000-\u001f\u007f]/.test(token) ? token : "";
    };
    const documentId = descriptor.documentId == null ? null : boundedToken(descriptor.documentId);
    if (!Number.isInteger(descriptor.tabId)
      || !Number.isInteger(descriptor.frameId)
      || (descriptor.documentId != null && !documentId)
      || !boundedToken(descriptor.documentToken)
      || !boundedToken(descriptor.targetToken)
      || !Number.isFinite(descriptor.scrollX)
      || !Number.isFinite(descriptor.scrollY)) {
      return null;
    }
    return JSON.stringify(canonicalIdentityJson({
      type,
      url,
      tabId: descriptor.tabId,
      frameId: descriptor.frameId,
      documentId,
      documentToken: boundedToken(descriptor.documentToken),
      targetToken: boundedToken(descriptor.targetToken),
      scrollX: descriptor.scrollX,
      scrollY: descriptor.scrollY,
    }));
  }

  function imagePrefillCommitIdentity(descriptor, context = {}) {
    if (!descriptor || typeof descriptor !== "object") return null;
    return boundCaptureIdentity(descriptor, "image", normalizeImageCandidateUrl(descriptor.url), context);
  }

  function sameImagePrefillIdentity(expected, fresh, context = {}) {
    const freshIdentity = imagePrefillCommitIdentity(fresh, context);
    if (!freshIdentity) return false;
    // The expected (prefill) side must carry the full binding set — an unbound
    // browser-contextmenu fallback can never match a bound fresh target.
    const expectedIdentity = imagePrefillCommitIdentity(expected, context);
    if (!expectedIdentity) return false;
    return expectedIdentity === freshIdentity;
  }

  // EXT-R1-REPAIR-3 (contract B): one TYPE-AWARE media prefill identity policy.
  // The actual expected/fresh descriptor types must both match the media type
  // under commit; image keeps the strict image URL policy, video keeps the
  // approved video URL policy (no image-only restrictions leak in). An unbound
  // descriptor never matches anything.
  function mediaPrefillIdentity(descriptor, mediaType, context = {}) {
    if (!descriptor || typeof descriptor !== "object") return null;
    const actualType = descriptor.type === "video" ? "video" : "image";
    if (actualType !== mediaType) return null;
    if (mediaType === "video") {
      return boundCaptureIdentity(descriptor, "video", normalizeVideoCandidateUrl(descriptor.url), context);
    }
    return imagePrefillCommitIdentity(descriptor, context);
  }

  function sameMediaPrefillIdentity(expected, fresh, mediaType, context = {}) {
    if (!expected || typeof expected !== "object") return false;
    const expectedType = expected.type === "video" ? "video" : "image";
    if (expectedType !== mediaType) return false;
    const freshIdentity = mediaPrefillIdentity(fresh, mediaType, context);
    if (!freshIdentity) return false;
    const expectedIdentity = mediaPrefillIdentity(expected, mediaType, context);
    if (!expectedIdentity) return false;
    return expectedIdentity === freshIdentity;
  }

  function chooseContextMenuMedia(input) {
    // EXT-R1-R1 P1-1: the browser-provided infoUrl must pass the SAME strict
    // type-aware boundary as any other capture URL — a URL rejected by the
    // image resolver can never be revived here through the looser normalizer.
    const type = input.type === "video" ? "video" : "image";
    const infoUrl = descriptorUrlFor(type, input && input.infoUrl);
    const descriptor = input && input.descriptor;
    const boundBrowserUrl = descriptorUrlFor(type, descriptor && descriptor.browserUrl);
    if (infoUrl
      && descriptor?.confidence === "contextmenu"
      && (type !== "video" || (descriptor.documentToken && descriptor.targetToken && descriptor.importable))
      && boundBrowserUrl === infoUrl) {
      return descriptor;
    }
    if (infoUrl) {
      const capturedAt = Date.now();
      return {
        type,
        url: infoUrl,
        capturedAt,
        confidence: "browser-contextmenu",
        importable: type !== "video" || isVideoUrlImportable(infoUrl),
        actionId: opaqueActionId("browser-contextmenu"),
      };
    }
    return descriptor || null;
  }

  function unwrapTransportEnvelope(payload) {
    let value = payload;
    for (let depth = 0; depth < 3; depth += 1) {
      if (!value || typeof value !== "object" || value.ok !== true || !value.data || typeof value.data !== "object") break;
      value = value.data;
    }
    return value;
  }

  function parseMaterialImportResponse(payload) {
    const value = unwrapTransportEnvelope(payload);
    if (!value || typeof value !== "object") return { ok: false, code: "canonical-result-missing" };
    const disposition = value.disposition;
    const asset = value.asset;
    if (disposition === "partial" || Number(value.failedCount || 0) > 0) {
      return { ok: false, code: "material-import-partial", disposition: "partial", asset: asset || null };
    }
    if ((disposition !== "imported" && disposition !== "duplicate") || !asset || typeof asset.id !== "string" || !asset.id) {
      return { ok: false, code: "canonical-result-missing" };
    }
    return { ok: true, disposition, asset };
  }

  // One receipt boundary for the coordinator, restored task UI and progress.
  // A download's completed flag or its byte count is never an import receipt.
  function parseCaptureImportReceipt(payload, task, media = global.LuckyRayMediaImport) {
    if (!task || !["image", "video", "audio"].includes(task.kind)) return { ok: false, code: "canonical-result-missing" };
    if (task.mediaIdentity && task.mediaIdentity.requestId !== task.id) return { ok: false, code: "media-receipt-identity" };
    const parsed = task.mediaIdentity ? media?.receipt(payload, task.mediaIdentity) : parseMaterialImportResponse(payload);
    if (!parsed?.ok) return parsed || { ok: false, code: "media-receipt-invalid" };
    if (!/^[A-Za-z0-9_:-]{1,160}$/.test(parsed.asset?.id || "") || task.kind === "audio" && parsed.asset?.kind !== "audio")
      return { ok: false, code: task.kind === "audio" ? "audio-receipt-kind-mismatch" : "canonical-result-missing" };
    return parsed;
  }

  function captureTaskImportReceipt(task, media = global.LuckyRayMediaImport) {
    if (!task) return { ok: false, code: "canonical-result-missing" };
    if (task.transfer && task.transfer.transferId !== task.transferId) return { ok: false, code: "media-transfer-identity" };
    return parseCaptureImportReceipt(task.mediaIdentity ? { ...task.receipt, asset: task.asset }
      : { disposition: task.disposition, asset: task.asset }, task, media);
  }

  function buildMaterialImportRequest(input) {
    const mediaType = input && input.mediaType === "video" ? "video" : "image";
    // EXT-R1-R1 P1-1: the import request re-applies the same type-aware
    // boundary so an upstream leak can never reach the transport.
    const url = descriptorUrlFor(mediaType, input && input.url);
    if (!url) return null;
    const request = { mediaType, url };
    if (input.targetFolderId) request.targetFolderId = String(input.targetFolderId);
    if (input.newFolderName) request.newFolderName = String(input.newFolderName);
    if (input.parentFolderId) request.parentFolderId = String(input.parentFolderId);
    if (input.requestId) request.requestId = String(input.requestId);
    const captureSource = normalizeCaptureSource(input.captureSource);
    if (captureSource) request.captureSource = captureSource;
    return request;
  }

  function projectMaterialImportFailure(payload) {
    const value = payload && typeof payload === "object" ? payload : {};
    const error = value.error && typeof value.error === "object" ? value.error : {};
    const details = error.details && typeof error.details === "object" ? error.details
      : value.details && typeof value.details === "object" ? value.details : value;
    return Object.freeze({
      code: /^[a-z0-9_-]{1,64}$/i.test(String(error.code || value.code || "")) ? error.code || value.code : "adapter-request-failed",
      reason: ["network", "http_error"].includes(details.reason) ? details.reason : "",
      category: ["timeout", "connect", "redirect", "request", "body", "other", "http-status"].includes(details.category) ? details.category : "",
      source: normalizeCaptureSource(details.source),
      fingerprint: /^[a-f0-9]{12}$/.test(String(details.fingerprint || "")) ? details.fingerprint : "",
      requestId: /^[a-zA-Z0-9_.:-]{1,96}$/.test(String(value.requestId || "")) ? value.requestId : "",
    });
  }

  function formatMaterialImportFailure(payload, mediaType) {
    const value = payload && typeof payload === "object" ? payload : {};
    const error = value.error && typeof value.error === "object" ? value.error : {};
    const details = error.details && typeof error.details === "object"
      ? error.details
      : value.details && typeof value.details === "object" ? value.details : value;
    const code = String(error.code || value.code || "");
    if (code === "request-outcome-unknown") return { code, handled: true,
      message: "保存已发出，但结果暂时无法确认；请先在素材库核对，不要重复保存。" };
    if (code === "capture-commit-uncertain" || code === "capture-commit-partial") return { code, message: formatNoteWriteFailure({ errorObject: { code } }) };
    const reason = String(details.reason || value.reason || "");
    const category = String(details.category || value.category || "");
    const source = normalizeCaptureSource(details.source || value.source);
    const fingerprint = /^[a-f0-9]{12}$/.test(String(details.fingerprint || value.fingerprint || ""))
      ? String(details.fingerprint || value.fingerprint)
      : "";
    const requestId = /^[a-zA-Z0-9_.:-]{1,96}$/.test(String(value.requestId || ""))
      ? String(value.requestId)
      : "";
    const label = mediaType === "audio" ? "音频" : mediaType === "video" ? "视频" : "图片";
    if (mediaType === "audio") {
      const message = {
        "media-authentication-required": "音频需要登录或站点授权，本批不代取登录会话，也不会绕过访问限制。",
        "site-auth-required": "音频需要登录或站点授权，本批不代取登录会话，也不会绕过访问限制。",
        "media-drm-protected": "该音频受 DRM 保护，LuckyRay 不会绕过保护。",
        "media-region-restricted": "该音频受地区限制，当前无法入库。",
        "media-site-blocked": "音频源拒绝了访问，当前无法入库。",
        "media-transfer-cancelled": "音频保存已取消，未取得入库回执。",
        "media-container-invalid": "地址未返回可确认的 MP3 / WAV 音频，不能确认入库。",
        "media-format-unsupported": "本批仅支持 MP3 / WAV 直链，暂不支持此音频格式。",
        "media-needs-recording": "本批暂不支持 blob 或分段音频流，不会使用视频录制兜底。",
      }[code];
      if (message) return { handled: true, message };
      if (["app-unavailable", "host-unavailable", "bootstrap-rejected", "verification-unavailable"].includes(code))
        return { handled: true, message: "与 LuckyRay 的连接暂时中断，请核对原音频任务；不会自动重新保存。" };
      return { handled: true, message: "音频保存未取得有效入库回执，请检查音频源及桌面端后重试。" };
    }
    const diagnostic = [source, fingerprint, requestId].filter(Boolean).join(" · ");
    const suffix = diagnostic ? ` · 诊断 ${diagnostic}` : "";
    const stage = {
      timeout: "超时阶段",
      connect: "连接阶段",
      redirect: "重定向阶段",
      request: "请求阶段",
      body: "读取阶段",
      other: "网络阶段",
      "http-status": "服务响应阶段",
    }[category];
    if (code === "adapter-request-failed" && (reason === "network" || reason === "http_error") && stage) {
      return {
        handled: true,
        message: `${label}下载失败（${stage}），可打开原图后重试${suffix}`,
      };
    }
    if (code === "media-needs-recording") {
      return { handled: true, message: "该视频需要录制后才能入库。" };
    }
    if (code === "media-youtube-token-required") {
      return { handled: true, message: "YouTube 当前要求站点会话与 PO Token；已授权后仍失败的视频暂不可直接入库。" };
    }
    if (code === "site-auth-required") {
      return {
        handled: true,
        message: "该视频需要登录站点会话；公开媒体无需授权，受限内容可在后续授权后重试。",
      };
    }
    const resolverMessage = {
      "media-authentication-required": "当前视频需要站点登录授权；请确认已登录并允许 LuckyRay 访问该站点。",
      "media-site-blocked": "视频网站拒绝了当前解析请求；请刷新页面或稍后重试。",
      "media-region-restricted": "该视频受地区限制，当前无法入库。",
      "media-drm-protected": "该视频受 DRM 保护，LuckyRay 不会绕过保护。",
      "media-no-formats": "站点没有提供可下载的视频格式；该内容可能已下架、受限或需要 PO Token。",
    }[code];
    if (resolverMessage) return { handled: true, message: resolverMessage };
    if (code === "media-container-invalid") {
      return { handled: true, message: "视频地址返回的不是可入库文件，请尝试播放器右上角的录制功能。" };
    }
    if (code === "media-format-unsupported") {
      return { handled: true, message: "该视频格式需要通过播放器右上角的录制功能入库。" };
    }
    if (code === "media-network-failed" || code === "media-download-failed") {
      return { handled: true, message: "视频源拒绝或中断了下载，请稍后重试，或改用浏览器下载/录制。" };
    }
    if (code === "media-http-unavailable") {
      return { handled: true, message: "视频源返回了不可用响应，请打开原视频检查后重试。" };
    }
    if (["app-unavailable", "host-unavailable", "bootstrap-rejected", "verification-unavailable"].includes(code)) {
      return { handled: true, message: "与 LuckyRay 的连接暂时中断，入库任务可能仍在后台继续。" };
    }
    return {
      handled: false,
      message: `${label}保存失败，请稍后重试${suffix}`,
    };
  }

  function createMaterialImportIntent(input) {
    const request = buildMaterialImportRequest(input);
    if (!request) return null;
    const actionId = String(input.actionId || input.requestId || "");
    const identity = JSON.stringify({
      mediaType: request.mediaType,
      kind: String(input.kind || request.mediaType),
      url: request.url,
      captureIdentity: String(input.captureIdentity || request.url),
      targetFolderId: request.targetFolderId || null,
      newFolderName: request.newFolderName ? request.newFolderName.trim() : null,
      parentFolderId: request.parentFolderId || null,
      storageMode: String(input.storageMode || "managed"),
      mode: String(input.mode || "asset:root"),
    });
    return Object.freeze({ actionId, identity, request });
  }

  function createActionGate(options = {}) {
    const actions = new Map();
    const now = typeof options.now === "function" ? options.now : Date.now;
    const maxInFlightAgeMs = Number(options.maxInFlightAgeMs) || 5 * 60_000;
    const maxEntries = Number(options.maxEntries) || 256;
    const retainSuccessMs = Math.max(0, Math.min(60_000, Number(options.retainSuccessMs) || 0));
    return {
      run(intent, operation) {
        const key = intent && typeof intent === "object"
          ? `${String(intent.actionId || "")}\u0000${String(intent.identity || "")}`
          : String(intent || "");
        if (!key) return Promise.resolve().then(operation);
        const currentTime = now();
        for (const [storedKey, entry] of actions) {
          if ((entry.expiresAt ?? entry.startedAt + maxInFlightAgeMs) <= currentTime) actions.delete(storedKey);
        }
        if (actions.has(key)) return actions.get(key).promise;
        if (actions.size >= maxEntries) return Promise.resolve().then(operation);
        let trackedPromise;
        trackedPromise = Promise.resolve()
          .then(operation)
          .then((result) => {
            const entry = actions.get(key);
            if (retainSuccessMs && result?.ok && entry?.promise === trackedPromise) entry.expiresAt = now() + retainSuccessMs;
            return result;
          })
          .finally(() => {
            const entry = actions.get(key);
            if (entry?.promise === trackedPromise && entry.expiresAt === undefined) actions.delete(key);
          });
        actions.set(key, { promise: trackedPromise, startedAt: currentTime });
        return trackedPromise;
      },
      forget(intent) {
        const key = intent && typeof intent === "object"
          ? `${String(intent.actionId || "")}\u0000${String(intent.identity || "")}`
          : String(intent || "");
        actions.delete(key);
      },
    };
  }

  function createRecordingBudget(options = {}) {
    const maxBytes = Math.max(1, Math.floor(Number(options.maxBytes) || 64 * 1024 * 1024));
    const maxDurationMs = Math.max(1, Math.floor(Number(options.maxDurationMs) || 20 * 60_000));
    const now = typeof options.now === "function" ? options.now : Date.now;
    const startedAt = now();
    let bytes = 0;

    const failure = (code) => Object.freeze({ ok: false, code, bytes });
    const checkTime = () => {
      const elapsed = Math.max(0, Number(now()) - Number(startedAt));
      return elapsed > maxDurationMs
        ? failure("recording-duration-limit")
        : Object.freeze({ ok: true, bytes });
    };

    return Object.freeze({
      addChunk(size) {
        const timeCheck = checkTime();
        if (!timeCheck.ok) return timeCheck;
        const chunkBytes = Number(size);
        if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 0) {
          return failure("recording-size-invalid");
        }
        if (chunkBytes > maxBytes - bytes) return failure("recording-size-limit");
        bytes += chunkBytes;
        return Object.freeze({ ok: true, bytes });
      },
      checkTime,
      snapshot() {
        return Object.freeze({ bytes, maxBytes, maxDurationMs });
      },
    });
  }

  function parseMediaTransferSnapshot(payload) {
    const value = unwrapTransportEnvelope(payload);
    const transferId = String(value?.transferId || "");
    const states = new Set(["queued", "running", "importing", "cancelling", "completed", "cancelled", "failed"]);
    const state = String(value?.state || "");
    const bytesReceived = Number(value?.bytesReceived);
    const totalBytes = value?.totalBytes == null ? null : Number(value.totalBytes);
    if (!/^media-[a-f0-9]+-[a-f0-9]{16}$/i.test(transferId)
      || !states.has(state)
      || !Number.isSafeInteger(bytesReceived)
      || bytesReceived < 0
      || (totalBytes !== null && (!Number.isSafeInteger(totalBytes) || totalBytes < 0))) {
      return Object.freeze({ ok: false, code: "media-transfer-invalid" });
    }
    const safeText = (input, maxLength) => String(input || "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .slice(0, maxLength);
    const errorCode = value?.errorCode == null
      ? null
      : (/^[a-z0-9_-]{1,64}$/i.test(String(value.errorCode)) ? String(value.errorCode) : "media-transfer-failed");
    const percent = totalBytes && totalBytes > 0
      ? Math.max(0, Math.min(100, Math.floor((bytesReceived / totalBytes) * 100)))
      : null;
    return Object.freeze({
      ok: true,
      transferId,
      state,
      bytesReceived,
      totalBytes,
      percent,
      fileName: safeText(value?.fileName, 180),
      mimeType: safeText(value?.mimeType, 96),
      assetId: value?.assetId == null ? null : safeText(value.assetId, 160),
      assetName: value?.assetName == null ? null : safeText(value.assetName, 180),
      assetKind: value?.assetKind == null ? null : safeText(value.assetKind, 32),
      skippedDuplicate: Boolean(value?.skippedDuplicate),
      errorCode,
    });
  }

  function parseMediaProbeSnapshot(payload) {
    const value = unwrapTransportEnvelope(payload);
    const probeId = String(value?.probeId || "");
    if (!/^probe-[a-f0-9]{32}$/i.test(probeId) || !Array.isArray(value?.formats)
      || value.formats.length < 1 || value.formats.length > 16) {
      return Object.freeze({ ok: false, code: "media-probe-invalid" });
    }
    const formats = [];
    const seen = new Set();
    for (const raw of value.formats) {
      const formatId = String(raw?.formatId || "");
      const label = String(raw?.label || "");
      const extension = String(raw?.extension || "").toLowerCase();
      const videoCodec = String(raw?.videoCodec || "");
      const audioCodec = String(raw?.audioCodec || "");
      const numbers = [raw?.width, raw?.height, raw?.fps, raw?.estimatedBytes, raw?.bitrate]
        .map(Number);
      if (!/^format-[a-f0-9]{32}$/i.test(formatId) || seen.has(formatId)
        || !label || label.length > 128 || /[\u0000-\u001f\u007f]/.test(label)
        || !/^[a-z0-9]{1,8}$/.test(extension)
        || !videoCodec || videoCodec.length > 48 || /[\u0000-\u001f\u007f]/.test(videoCodec)
        || !audioCodec || audioCodec.length > 48 || /[\u0000-\u001f\u007f]/.test(audioCodec)
        || numbers.some((number) => !Number.isSafeInteger(number) || number < 0)
        || numbers[1] < 1 || numbers[0] > 16_384 || numbers[1] > 16_384
        || numbers[2] > 1_000 || numbers[3] > 2_147_483_648
        || numbers[4] > 1_000_000_000) {
        return Object.freeze({ ok: false, code: "media-probe-invalid" });
      }
      seen.add(formatId);
      formats.push(Object.freeze({
        formatId,
        label,
        extension,
        videoCodec,
        audioCodec,
        width: numbers[0],
        height: numbers[1],
        fps: numbers[2],
        estimatedBytes: numbers[3],
        bitrate: numbers[4],
      }));
    }
    return Object.freeze({ ok: true, probeId, formats: Object.freeze(formats) });
  }

  function buildMediaTransferProgress(transfer, task) {
    const state = String(transfer?.state || "");
    const suppliedPercent = Number.isFinite(transfer?.percent)
      ? Math.max(0, Math.min(100, Math.floor(transfer.percent)))
      : null;
    let terminal = ["completed", "cancelled", "failed"].includes(state);
    let percent = state === "completed" || state === "importing"
      ? 100
      : state === "failed" || state === "cancelled" || state === "queued"
        ? 0
        : suppliedPercent;
    let indeterminate = state === "running" && percent === null;
    // M1-S4 §6: a completed transfer that was skipped as a duplicate must read
    // as "already exists", not as a fresh save.
    const duplicate = transfer?.skippedDuplicate === true;
    let label = {
      queued: "等待入库",
      running: indeterminate ? "正在解析并下载" : `正在下载 ${percent}%`,
      importing: "正在写入素材库",
      cancelling: "正在取消",
      completed: duplicate ? "已存在，无需重复保存" : "已入库",
      cancelled: "已取消",
      failed: "入库失败",
    }[state] || "正在处理";
    if (task) {
      const receipt = captureTaskImportReceipt(task);
      const bound = transfer?.transferId === task.transferId;
      if (!bound || task.stage === "uncertain") { label = "保存结果无法确认"; percent = null; indeterminate = false; terminal = true; }
      else if (task.stage === "failed") { label = state === "cancelled" ? "已取消" : "入库失败"; percent = 0; indeterminate = false; terminal = true; }
      else if (task.stage === "paused" || task.stage === "checking") {
        label = task.stage === "paused" ? "进度读取中断" : "正在核对原保存结果"; percent = null; indeterminate = false; terminal = false;
      } else if (["completed", "partial", "attaching"].includes(task.stage) && receipt.ok) {
        label = receipt.disposition === "duplicate" ? "已存在，无需重复保存" : "已入库"; percent = 100; indeterminate = false; terminal = true;
      } else if (state === "completed" || ["completed", "partial", "attaching"].includes(task.stage)) {
        label = "正在核对入库回执"; percent = null; indeterminate = false; terminal = false;
      }
    }
    return Object.freeze({ label, percent, indeterminate, terminal });
  }

  // EXT-R1-R1 P2-2: one duplicate-aware terminal status projection shared by
  // popup toasts, overlay rows and overlay status lines. A completed transfer
  // with skippedDuplicate=true reads as "already exists", never as a new save.
  function formatTransferTerminalStatus(transfer) {
    const state = String(transfer?.state || "");
    if (state === "completed") {
      return transfer?.skippedDuplicate === true
        ? "素材已存在，未重复保存。"
        : "视频已保存到 LuckyRay 素材库。";
    }
    if (state === "cancelled") return "视频入库已取消。";
    return "";
  }

  // EXT-R1-R1 P1-3: one canonical, deterministic, non-secret video candidate
  // identity for render selection, row click, refresh comparison, selected
  // lookup and transfer construction. It binds every transfer-affecting field;
  // authorization is represented only by a bounded opaque generation marker,
  // never by cookie/siteAuth secret material (secrets stay out of DOM keys,
  // logs and persistent storage).
  function canonicalIdentityJson(value) {
    if (Array.isArray(value)) return value.map(canonicalIdentityJson);
    if (value && typeof value === "object") {
      const result = {};
      for (const key of Object.keys(value).sort()) {
        if (value[key] === undefined) continue;
        result[key] = canonicalIdentityJson(value[key]);
      }
      return result;
    }
    return value;
  }

  const VIDEO_IDENTITY_FIELDS = Object.freeze([
    "url", "audioUrl", "kind", "binding", "probeId", "formatId",
    "sourcePageUrl", "frameId", "documentId", "extension", "contentType",
  ]);

  function buildVideoCandidateIdentity(candidate) {
    if (!candidate || typeof candidate !== "object") return "";
    const parts = {};
    for (const field of VIDEO_IDENTITY_FIELDS) {
      const value = candidate[field];
      if (value === undefined || value === null || value === "") continue;
      if (field === "audioUrl" && candidate.binding !== "site-track-pair") continue;
      parts[field] = canonicalIdentityJson(value);
    }
    // Bounded opaque authorization generation: any change to the site auth
    // material rotates the identity without ever exposing the secret itself.
    if (candidate.siteAuth) parts.authGeneration = "1";
    return JSON.stringify(canonicalIdentityJson(parts));
  }

  // ---- M1-S4: unified video capture state projection (Issue #25 §5/§6) ----
  // Pure user-level view over the existing authorities
  // (buildVideoActionMenu / buildMediaTransferProgress). Never a second
  // "can this be saved" truth: candidate classification, transfer state and
  // recording policy remain the authority. Popup and player overlay must
  // derive identical states from this single function.

  const VIDEO_CAPTURE_STATE_LABELS = Object.freeze({
    "ready-direct": "可直接保存",
    "choose-quality": "选择清晰度",
    "needs-resolve": "需要解析",
    "needs-play": "先播放几秒，再刷新",
    "record-fallback": "需要录制",
    blocked: "当前内容不支持直接保存",
  });

  function buildVideoCaptureView(input = {}) {
    const rawCandidates = Array.isArray(input.candidates) ? input.candidates : [];
    const menu = input.menu || buildVideoActionMenu(rawCandidates, {
      baseUrl: input.baseUrl,
      maxItems: input.maxItems,
    });
    const items = Array.isArray(input.items) ? input.items : menu.items;
    const canRecord = input.canRecord === true || menu.canRecord === true;
    const savable = items.filter((item) => item.canSaveToMaterials === true);

    const options = savable.map((item) => Object.freeze({
      candidateId: item.candidateId,
      sourceIndex: item.sourceIndex,
      kind: item.kind,
      format: item.format,
      label: item.label,
      height: item.height,
      width: item.width,
      bitrate: item.bitrate,
      sizeBytes: item.sizeBytes,
      canSaveToMaterials: true,
    }));

    const transfer = input.transfer ? buildMediaTransferProgress(input.transfer) : null;
    const transferState = String(input.transfer?.state || "");
    const duplicate = input.transfer?.skippedDuplicate === true;

    let state;
    let label;
    let primaryAction;
    let primaryDisabled = false;
    let guidance = "";

    if (["queued", "running", "importing", "cancelling"].includes(transferState)) {
      state = transferState;
      label = transfer.label;
      primaryAction = "none";
      primaryDisabled = true;
      guidance = transferState === "cancelling" ? "正在取消本次入库" : "入库进行中，可在面板取消";
    } else if (transferState === "completed") {
      state = duplicate ? "duplicate" : "completed";
      label = transfer.label;
      primaryAction = "none";
      primaryDisabled = true;
      guidance = duplicate ? "素材已存在，无需重复保存" : "视频已写入素材库";
    } else if (transferState === "cancelled") {
      state = "cancelled";
      label = transfer.label;
      primaryAction = "none";
      primaryDisabled = false;
      guidance = "已取消，可重新选择后保存";
    } else if (transferState === "failed") {
      state = "failed";
      label = transfer.label;
      primaryAction = "retry";
      primaryDisabled = false;
      guidance = "入库失败，可安全重试";
    } else if (!savable.length) {
      // No savable item: recording availability decides the user-level state.
      // (FIX-1 P1-1) A caller that positively knows recording is available
      // must get the immediately-usable record-fallback — never the
      // contradictory "play first, then refresh" — while unestablished
      // recording availability with no candidate at all keeps needs-play.
      const hasAnyCandidate = rawCandidates.length > 0 || items.length > 0;
      if (canRecord) {
        state = "record-fallback";
        label = VIDEO_CAPTURE_STATE_LABELS["record-fallback"];
        primaryAction = "record";
        primaryDisabled = false;
        guidance = "未找到可直链保存的媒体，可录制当前标签页";
      } else if (hasAnyCandidate) {
        state = "blocked";
        label = VIDEO_CAPTURE_STATE_LABELS["blocked"];
        primaryAction = null;
        primaryDisabled = true;
        guidance = "当前内容不支持直接保存";
      } else {
        state = "needs-play";
        label = VIDEO_CAPTURE_STATE_LABELS["needs-play"];
        primaryAction = "refresh";
        primaryDisabled = false;
        guidance = "先播放几秒视频，再点刷新";
      }
    } else if (savable.length === 1) {
      const only = savable[0];
      state = only.kind === "site-resolver" ? "needs-resolve" : "ready-direct";
      label = VIDEO_CAPTURE_STATE_LABELS[state];
      primaryAction = state === "needs-resolve" ? "resolve" : "save";
      primaryDisabled = false;
      guidance = state === "needs-resolve" ? "点击解析后可选择清晰度" : "点击保存即可入库";
    } else {
      state = "choose-quality";
      label = VIDEO_CAPTURE_STATE_LABELS["choose-quality"];
      primaryAction = "save";
      primaryDisabled = false;
      guidance = "请先选择一个清晰度版本";
    }

    return Object.freeze({
      state,
      label,
      primaryAction,
      primaryDisabled,
      canRecord,
      guidance,
      options: Object.freeze(options),
      transfer,
    });
  }

  function createContentReceiverBridge(chromeApi) {
    const install = async (tabId, frameId = 0) => {
      const target = { tabId, frameIds: [Number.isInteger(frameId) ? frameId : 0] };
      await chromeApi.scripting.executeScript({
        target,
        world: "MAIN",
        files: ["page-media-probe.js"],
        injectImmediately: true,
      });
      await chromeApi.scripting.executeScript({
        target,
        files: ["extension-protocol.js", "video-overlay-preference.js", "audio-collection.js", "appearance.js", "article-extractor.js", "page-capture.js", "image-collection.js", "content-script.js"],
        injectImmediately: true,
      });
    };

    return {
      install,
      async installOpenTabs() {
        const tabs = await chromeApi.tabs.query({ url: ["http://*/*", "https://*/*"] });
        await Promise.allSettled((tabs || [])
          .filter((tab) => Number.isInteger(tab && tab.id))
          .map((tab) => install(tab.id, 0)));
      },
      async request(tabId, message, options = { frameId: 0 }) {
        const requiredProtocolVersion = Number(options && options.requiredProtocolVersion) || 0;
        const sendOptions = { ...options };
        delete sendOptions.requiredProtocolVersion;
        const send = async () => await chromeApi.tabs.sendMessage(tabId, message, sendOptions);
        const valid = (response) => !requiredProtocolVersion
          || response?.captureProtocolVersion === requiredProtocolVersion;
        try {
          const response = await send();
          if (valid(response)) return response;
        } catch (_) {
          // Missing receivers and obsolete receivers both reinstall below.
        }
        await install(tabId, options && Number.isInteger(options.frameId) ? options.frameId : 0);
        const response = await send();
        if (!valid(response)) throw new Error("content-receiver-protocol-incompatible");
        return response;
      },
    };
  }

  function toPopupMediaPayload(type, descriptor) {
    // EXT-R1-REPAIR-2 (contract A/E): the image payload re-applies the strict
    // image sanitizer — a blob/credential/overlong descriptor URL can never be
    // projected into the popup; video keeps its own URL semantics.
    const descriptorType = descriptor?.type === "video" ? "video" : descriptor?.type === "image" ? "image" : "";
    const url = descriptorType === type && type === "video"
      ? normalizeVideoCandidateUrl(descriptor && (descriptor.url || descriptor.src))
      : descriptorType === type && type === "image"
        ? normalizeImageCandidateUrl(descriptor && (descriptor.url || descriptor.src))
        : "";
    const base = type === "video" ? { videoUrl: url } : { imageUrl: url };
    // EXT-R1-R1 P1-2: the popup needs the bounded revalidated descriptor —
    // not only the URL — to bind a commit identity at Save time. The payload
    // carries bounded capture-identity fields only: never page content,
    // credentials or unbounded values.
    if (url && descriptor && typeof descriptor === "object") {
      base.descriptor = {
        type: descriptor.type === "video" ? "video" : "image",
        url,
        capturedAt: Number(descriptor.capturedAt) || 0,
        confidence: String(descriptor.confidence || ""),
        tabId: Number.isInteger(descriptor.tabId) ? descriptor.tabId : null,
        frameId: Number.isInteger(descriptor.frameId) ? descriptor.frameId : null,
        documentId: descriptor.documentId || null,
        documentToken: descriptor.documentToken || null,
        targetToken: descriptor.targetToken || null,
        scrollX: Number.isFinite(descriptor.scrollX) ? descriptor.scrollX : null,
        scrollY: Number.isFinite(descriptor.scrollY) ? descriptor.scrollY : null,
        linkUrl: type === "image" ? normalizeBoundWorkPageUrl(descriptor.linkUrl) || null : null,
        materialSourcePageUrl: type === "video"
          ? normalizeBoundWorkPageUrl(descriptor.materialSourcePageUrl) || null : null,
      };
    }
    return base;
  }

  global.LuckyRayExtensionProtocol = Object.freeze({
    HOVER_TTL_MS,
    CONTEXT_TTL_MS,
    CAPTURE_PROTOCOL_VERSION,
    normalizeUrl,
    normalizeSourcePageUrl,
    normalizeBoundWorkPageUrl,
    normalizeSupportedVideoPageUrl,
    sitePermissionDescriptor,
    chooseBoundVideoPageUrl,
    createPageSnapshot,
    isPageSnapshotCurrent,
    formatPageCaptureText,
    buildPagePreview,
    pageCaptureReadiness,
    createNoteWithConflictRecovery,
    formatNoteWriteFailure,
    buildPopupPagePayload,
    buildCaptureTargetPolicy,
    quickCollectDefaultViewState,
    quickCollectTypeLabel,
    quickCollectTargetLabel,
    quickCollectTargetComplete,
    quickCollectSubmitGate,
    visualImageCandidate,
    buildVideoCaptureView,
    buildContextMenuSpecification,
    resolveContextMenuKind,
    contextMenuVisibility,
    choosePopupCaptureType,
    normalizeVideoCandidateUrl,
    videoTransferFileName,
    selectImageCandidate,
    selectVideoCandidate,
    collectVideoElementCandidates,
    isVideoUrlImportable,
    buildVideoActionMenu,
    placeVideoActionChip,
    selectPointMedia,
    createCaptureDescriptor,
    isCaptureDescriptorUsable,
    resolveCapturedDescriptor,
    chooseContextMenuMedia,
    unwrapTransportEnvelope,
    parseMaterialImportResponse,
    parseCaptureImportReceipt,
    captureTaskImportReceipt,
    buildMaterialImportRequest,
    formatMaterialImportFailure,
    projectMaterialImportFailure,
    createMaterialImportIntent,
    createActionGate,
    createRecordingBudget,
    parseMediaTransferSnapshot,
    parseMediaProbeSnapshot,
    buildMediaTransferProgress,
    formatTransferTerminalStatus,
    buildVideoCandidateIdentity,
    imagePrefillCommitIdentity,
    sameImagePrefillIdentity,
    mediaPrefillIdentity,
    sameMediaPrefillIdentity,
    createContentReceiverBridge,
    toPopupMediaPayload,
  });
})(globalThis);
