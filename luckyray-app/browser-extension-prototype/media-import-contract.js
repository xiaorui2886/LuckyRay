(function (global) {
  "use strict";
  // Contract frozen by Desktop owner in #179 comment5953302110. This adapter
  // never turns an absent capability into a legacy write or invents a receipt.
  const version = 1;
  const validId = value => typeof value === "string" && /^[A-Za-z0-9_:-]{1,160}$/.test(value);
  const validRequestId = value => typeof value === "string" && /^[A-Za-z0-9_:-]{1,128}$/.test(value);
  const copy = value => JSON.parse(JSON.stringify(value));
  function utf8Length(value) { try { return encodeURIComponent(value).replace(/%[A-F\d]{2}|./gi, "x").length; } catch (_) { return Infinity; } }
  function filenameError(name) {
    if (typeof name !== "string" || !name.trim() || name !== name.trim() || /[<>:"/\\|?*\u0000-\u001f\u007f]/.test(name)
      || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) return "media-name-invalid";
    return utf8Length(name) > 240 ? "media-name-too-long" : null;
  }
  function capability(payload) {
    const entry = payload?.namespaces?.materials?.mediaImport;
    return entry?.version === version && entry.available === true;
  }
  function identity(kind, body) {
    // v1 receipt lookup names the endpoint "video". It serves the same generic
    // transfer queue for MP3/WAV; asset.kind below remains the actual media kind.
    return { libraryId: body.libraryId, requestId: body.requestId, operation: kind === "audio" ? "video" : kind };
  }
  function validateRequest(kind, body) {
    if (!["image", "video", "audio"].includes(kind) || !body || !validId(body.libraryId) || !validRequestId(body.requestId)) return { ok: false, code: "media-target-required" };
    try { const url = new URL(body.url); if (!/^https?:$/.test(url.protocol) || url.username || url.password || /[\u0000-\u001f]/.test(body.url)) return { ok: false, code: "media-input-invalid" }; } catch (_) { return { ok: false, code: "media-input-invalid" }; }
    const nameCode = filenameError(kind === "image" ? body.name : body.fileName);
    if (nameCode) return { ok: false, code: nameCode };
    if (kind === "image" && (body.mediaType !== "image" || !/\.[a-z0-9]{2,8}$/i.test(body.name))) return { ok: false, code: "media-format-unknown" };
    if (body.parentFolderId && !String(body.newFolderName || "").trim()) return { ok: false, code: "media-folder-invalid" };
    for (const field of ["targetFolderId", "parentFolderId"]) if (body[field] != null && !validId(body[field])) return { ok: false, code: "media-folder-invalid" };
    for (const field of ["tagIds", "tagNames"]) if (body[field] != null && (!Array.isArray(body[field]) || body[field].length > 100
      || body[field].some(value => field === "tagIds" ? !validId(value) : typeof value !== "string" || !value.trim() || /[\u0000-\u001f]/.test(value)))) return { ok: false, code: "media-tags-invalid" };
    return { ok: true, identity: identity(kind, body), request: copy(body) };
  }
  function receipt(value, expected) {
    const fail = code => ({ ok: false, code });
    if (!value || value.consumerVersion !== version || value.libraryId !== expected.libraryId || value.requestId !== expected.requestId) return fail("media-receipt-identity");
    if (!validId(value.assetId) || value.asset?.id !== value.assetId || typeof value.assetName !== "string" || !value.assetName
      || !["imported", "duplicate"].includes(value.disposition) || !["applied", "preserved", "partial"].includes(value.organization?.state)
      || (value.disposition === "duplicate" && value.organization.state !== "preserved") || value.atomic !== false) return fail("media-receipt-invalid");
    const asset = { id: value.assetId, name: value.assetName, ...(typeof value.asset.kind === "string" ? { kind: value.asset.kind } : {}),
      ...(validId(value.asset.folderId) ? { folderId: value.asset.folderId } : {}), ...(Array.isArray(value.asset.tagIds) ? { tagIds: value.asset.tagIds.filter(validId) } : {}) };
    const projected = { consumerVersion: 1, libraryId: value.libraryId, requestId: value.requestId, assetId: value.assetId,
      assetName: value.assetName, disposition: value.disposition, asset, organization: { state: value.organization.state }, atomic: false,
      view: { available: false }, ...(value.organization.state === "partial" ? { warning: { code: "consumer-organization-partial" } } : {}) };
    return { ok: true, receipt: projected, asset,
      disposition: value.disposition, organizationPartial: value.organization.state === "partial" };
  }
  function lookup(value, expected) {
    if (!value || value.receiptLookupVersion !== version || value.libraryId !== expected.libraryId || value.requestId !== expected.requestId
      || !["completed", "pending", "failed", "cancelled", "rejected", "unknown"].includes(value.state)) return { ok: false, code: "media-receipt-identity" };
    if (value.state === "completed") { const parsed = receipt(value.receipt, expected); return parsed.ok ? { ...parsed, state: "completed" } : parsed; }
    if (["pending", "failed", "cancelled"].includes(value.state) && expected.operation !== "video") return { ok: false, code: "media-receipt-invalid" };
    if (value.state === "rejected" && (!Number.isInteger(value.response?.status) || value.response.status < 400)) return { ok: false, code: "media-receipt-invalid" };
    return { ok: true, ...copy(value) };
  }
  function extension(bytes, contentType = "") {
    const b = new Uint8Array(bytes), ascii = (from, to) => String.fromCharCode(...b.slice(from, to));
    if (b.length >= 8 && [137,80,78,71,13,10,26,10].every((value, i) => b[i] === value)) return "png";
    if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "jpg";
    if (["GIF87a", "GIF89a"].includes(ascii(0,6))) return "gif";
    if (ascii(0,4) === "RIFF" && ascii(8,12) === "WEBP") return "webp";
    if (ascii(4,8) === "ftyp" && /(?:avif|avis)/.test(ascii(8,64))) return "avif";
    if (ascii(0,2) === "BM") return "bmp";
    if (ascii(0,4) === "II*\0" || ascii(0,4) === "MM\0*") return "tif";
    if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "ico";
    if (contentType.split(";")[0].trim().toLowerCase() === "image/svg+xml" && /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)?<svg[\s>]/i.test(new TextDecoder().decode(b))) return "svg";
    return null;
  }
  function filename({ typed = "", fallback = "网页图片", extension: ext }) {
    if (!/^(png|jpg|gif|webp|avif|bmp|tif|ico|svg)$/.test(ext || "")) return { ok: false, code: "media-format-unknown" };
    let base = typed || fallback;
    base = base.replace(/\.(png|jpe?g|gif|webp|avif|bmp|tiff?|ico|svg)$/i, "");
    if (!typed) {
      base = base.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, " ").replace(/[. ]+$/g, "").trim() || "网页图片";
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = `网页图片 ${base}`;
      while (utf8Length(`${base}.${ext}`) > 240) base = Array.from(base).slice(0, -1).join("");
    }
    const name = `${base}.${ext}`, code = filenameError(name);
    return code ? { ok: false, code } : { ok: true, name };
  }
  function organization(target, kind, name) {
    if (!target?.libraryId) return { ok: false, code: "media-target-required" };
    const fields = { libraryId: target.libraryId, ...(kind === "image" ? { name } : {}) };
    if (target.folderId) fields.targetFolderId = target.folderId;
    if (target.newFolderName) { fields.newFolderName = target.newFolderName; if (target.parentFolderId) fields.parentFolderId = target.parentFolderId; }
    if (target.tagIds?.length) fields.tagIds = [...target.tagIds];
    if (target.tagNames?.length) fields.tagNames = [...target.tagNames];
    return { ok: true, fields };
  }
  const messages = {
    "media-library-unavailable": "此桌面版本暂不支持所选素材库，请更新后继续，或选择按桌面默认库保存。",
    "media-target-required": "请重新选择素材库。", "media-name-invalid": "保存名称不能含路径、保留名称或特殊字符。",
    "media-name-too-long": "保存名称太长，请缩短后重试。", "media-format-unknown": "暂时无法确认原图格式，未开始保存。请在原网页重新选择图片。",
    "media-folder-invalid": "文件夹选择已失效，请重新选择。", "media-tags-invalid": "请检查所选标签。",
    "media-library-denied": "所选素材库暂不可用，请重新选择保存位置。", "media-organize-denied": "所选素材库暂不允许整理，请保存到根目录或选择其他素材库。",
    "media-note-library-unsupported": "此素材库暂不支持笔记联动，请选择桌面默认素材库。",
  };
  const api = { version, capability, validId, validRequestId, filenameError, utf8Length, validateRequest, identity, receipt, lookup, extension, filename, organization,
    message: code => messages[code] || "保存结果无法确认，请先在 LuckyRay 中核对。" };
  global.LuckyRayMediaImport = Object.freeze(api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
