import { createCanvasAgentService } from "./luckyray-dsh-canvas-agent.mjs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Agent, createServer, request as httpRequest } from "node:http";
import { closeSync, createReadStream, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import {
  createBuiltInProviderExportRegistry,
  projectProviderSync,
} from "./luckyray-dsh-provider-export.mjs";

const MAX_AUTHORITY_BYTES = 16 * 1024;
export const NATIVE_BROWSER_AUTH_COOKIE = "dsh-auth-luckyray-native";
export const TEXT_DRAFT_PATH = "/_luckyray/text-drafts";
const TEXT_DRAFT_FILE = "luckyray-text-drafts-v1.json";
const MAX_TEXT_DRAFT_BYTES = 2 * 1024 * 1024;
const realSessionId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/u.test(value)
  && !["__proto__", "constructor", "prototype"].includes(value);

// This is an origin adapter for the official synchronous client store, not a
// composer or session store. Only text and the official selected session ID
// cross the random-port boundary. In particular, no view, reference, attachment,
// credential or arbitrary localStorage field is serialized here.
export function textDraftChange(key, raw) {
  if (key === "dsh.sessions.current") {
    if (raw === null) return { key, value: null };
    const value = JSON.parse(raw);
    return { key, value: realSessionId(value?.sessionId) ? { sessionId: value.sessionId } : null };
  }
  const id = typeof key === "string" && key.startsWith("dsh.conversation.") ? key.slice(17) : null;
  if (!realSessionId(id)) return null;
  if (raw === null) return { key, value: null };
  const value = JSON.parse(raw);
  const text = typeof value?.draft === "string" ? value.draft : value?.draft?.text;
  if (typeof text !== "string") return null;
  if (Buffer.byteLength(text) > 256 * 1024) throw new Error("dsh-text-draft-too-large");
  return { key, value: text === "" ? null : text };
}

export function createTextDraftStore(profileRoot) {
  if (!isAbsolute(profileRoot)) throw new Error("dsh-text-draft-profile-invalid");
  const file = join(realpathSync(profileRoot), TEXT_DRAFT_FILE);
  let state = { schema: 1, selection: null, drafts: {} };
  let initialized = false;
  const checkFile = () => {
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TEXT_DRAFT_BYTES) throw new Error("dsh-text-draft-file-invalid");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  };
  checkFile();
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (saved.schema !== 1 || !saved.drafts || Array.isArray(saved.drafts)) throw new Error("dsh-text-draft-file-invalid");
    const drafts = {};
    for (const [id, text] of Object.entries(saved.drafts)) {
      if (!realSessionId(id) || typeof text !== "string" || Buffer.byteLength(text) > 256 * 1024) throw new Error("dsh-text-draft-file-invalid");
      if (text !== "") drafts[id] = text;
    }
    state = { schema: 1, selection: realSessionId(saved.selection?.sessionId) ? { sessionId: saved.selection.sessionId } : null, drafts };
    initialized = true;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  let lease;
  let sequence = 0;
  let lastWriteDigest;
  return Object.freeze({
    begin() {
      // A replacement document invalidates older pages. A delayed old writer
      // can never put text back after a newer page cleared it.
      lease = randomBytes(24).toString("base64url");
      sequence = 0;
      lastWriteDigest = undefined;
      return { lease, initialized, state: structuredClone(state) };
    },
    write(frame) {
      if (!lease || frame?.lease !== lease) throw new Error("dsh-text-draft-stale-write");
      const digest = createHash("sha256").update(JSON.stringify(frame)).digest("hex");
      // Only an exact replay of the last committed write may recover a lost
      // acknowledgement. Same sequence with different text is never accepted.
      if (frame.sequence === sequence && lastWriteDigest === digest) return { saved: true, sequence };
      if (frame.sequence !== sequence + 1) throw new Error("dsh-text-draft-stale-write");
      const next = structuredClone(state);
      if (frame.initialize !== undefined) {
        if (initialized || !frame.initialize || typeof frame.initialize !== "object"
          || !frame.initialize.drafts || typeof frame.initialize.drafts !== "object"
          || Array.isArray(frame.initialize.drafts)) throw new Error("dsh-text-draft-initialize-invalid");
        next.selection = realSessionId(frame.initialize.selection?.sessionId)
          ? { sessionId: frame.initialize.selection.sessionId } : null;
        next.drafts = {};
        for (const [id, text] of Object.entries(frame.initialize.drafts)) {
          if (!realSessionId(id) || typeof text !== "string") throw new Error("dsh-text-draft-initialize-invalid");
          const checked = textDraftChange(`dsh.conversation.${id}`, JSON.stringify({ draft: text }));
          if (checked.value !== null) next.drafts[id] = checked.value;
        }
      } else if (frame.clear === true) { next.selection = null; next.drafts = {}; }
      else {
        const change = frame.change;
        if (!change || typeof change.key !== "string") throw new Error("dsh-text-draft-change-invalid");
        const checked = textDraftChange(change.key, change.value === null ? null : JSON.stringify(
          change.key === "dsh.sessions.current" ? change.value : { draft: change.value }));
        if (!checked) throw new Error("dsh-text-draft-change-invalid");
        if (checked.key === "dsh.sessions.current") next.selection = checked.value;
        else {
          const id = checked.key.slice(17);
          if (checked.value === null) delete next.drafts[id];
          else next.drafts[id] = checked.value;
        }
      }
      const bytes = JSON.stringify(next);
      if (Buffer.byteLength(bytes) > MAX_TEXT_DRAFT_BYTES) throw new Error("dsh-text-draft-too-large");
      checkFile();
      const temporary = `${file}.${randomBytes(12).toString("hex")}.tmp`;
      let fd;
      try {
        fd = openSync(temporary, "wx", 0o600);
        writeFileSync(fd, bytes, "utf8");
        fsyncSync(fd);
        closeSync(fd); fd = undefined;
        renameSync(temporary, file);
      } finally {
        if (fd !== undefined) closeSync(fd);
        try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      state = next;
      initialized = true;
      sequence = frame.sequence;
      lastWriteDigest = digest;
      return { saved: true, sequence };
    },
  });
}

// Runs synchronously at the beginning of <head>, before any official module
// reads its store. No timers/unload scraping and no late async rehydration.
// Official setItem is synchronous too: each permitted write receives a durable
// acknowledgement before returning, including the last edit and clear/remove.
export function installTextDraftBridge() {
  if (location.hostname !== "127.0.0.1") return;
  const path = "/_luckyray/text-drafts";
  const request = (method, body) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, path, false);
    xhr.setRequestHeader("x-luckyray-text-drafts", "1");
    if (body !== undefined) xhr.setRequestHeader("content-type", "application/json");
    xhr.send(body === undefined ? null : JSON.stringify(body));
    if (xhr.status !== 200) throw new Error("dsh-text-draft-persistence-unavailable");
    return JSON.parse(xhr.responseText);
  };
  let snapshot;
  try { snapshot = request("GET"); } catch { console.error("dsh-text-draft-restore-unavailable"); return; }
  const storage = localStorage;
  const proto = Storage.prototype;
  const get = proto.getItem;
  const set = proto.setItem;
  const remove = proto.removeItem;
  const clear = proto.clear;
  const sessionId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value)
    && !["__proto__", "constructor", "prototype"].includes(value);
  const conversationId = key => key.startsWith("dsh.conversation.") && sessionId(key.slice(17)) ? key.slice(17) : null;
  let sequence = 0;
  let pending;
  const confirmPending = () => {
    let error;
    // One bounded retry of the SAME frame. Do not advance the sequence or
    // obtain a new lease when the outcome is unknown.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = request("POST", pending);
        if (result.saved !== true || result.sequence !== pending.sequence) throw new Error("dsh-text-draft-save-unconfirmed");
        sequence = pending.sequence;
        pending = undefined;
        return;
      } catch (cause) { error = cause; }
    }
    throw error;
  };
  const persist = frame => {
    // If both acknowledgements were lost, settle the earlier exact write
    // before accepting a later edit or clear. Never replay it after the clear.
    if (pending) confirmPending();
    pending = { lease: snapshot.lease, sequence: sequence + 1, ...frame };
    confirmPending();
  };
  if (snapshot.initialized === false) {
    // First use is different from a deliberately cleared, existing store.
    // Seed only the current origin's official text/selection, before touching
    // any local value. Never scan other origins or import arbitrary storage.
    const seed = { selection: null, drafts: {} };
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      const id = conversationId(key);
      if (!id && key !== "dsh.sessions.current") continue;
      try {
        const value = JSON.parse(get.call(storage, key));
        if (key === "dsh.sessions.current") {
          if (sessionId(value?.sessionId)) seed.selection = { sessionId: value.sessionId };
        } else {
          const text = typeof value?.draft === "string" ? value.draft : value?.draft?.text;
          if (typeof text === "string" && text !== "") seed.drafts[id] = text;
        }
      } catch { /* Invalid old entries remain local; they are not imported. */ }
    }
    try { persist({ initialize: seed }); }
    catch { console.error("dsh-text-draft-initialize-unconfirmed"); }
    // Preserve all existing local fields, including the original semantic
    // draft. If initialization is pending, the next official write retries it.
  } else {
    // A recycled port may contain text cleared at another port. An existing
    // durable store (even empty) remains authoritative; never import it again.
    const ids = new Set(Object.keys(snapshot.state.drafts));
    for (let i = 0; i < storage.length; i++) {
      const id = conversationId(storage.key(i));
      if (id) ids.add(id);
    }
    for (const id of ids) {
      const key = `dsh.conversation.${id}`;
      let value;
      try { value = JSON.parse(get.call(storage, key)); } catch {}
      if (!value || typeof value !== "object" || Array.isArray(value)) value = {};
      value.draft = snapshot.state.drafts[id] ?? "";
      set.call(storage, key, JSON.stringify(value));
    }
    if (snapshot.state.selection) set.call(storage, "dsh.sessions.current", JSON.stringify(snapshot.state.selection));
    else remove.call(storage, "dsh.sessions.current");
  }
  proto.setItem = function(key, raw) {
    key = String(key); raw = String(raw);
    if (this === storage) {
      let change;
      if (key === "dsh.sessions.current") {
        const value = JSON.parse(raw);
        change = { key, value: sessionId(value?.sessionId) ? { sessionId: value.sessionId } : null };
      } else if (conversationId(key)) {
        const value = JSON.parse(raw);
        const text = typeof value?.draft === "string" ? value.draft : value?.draft?.text;
        if (typeof text === "string") change = { key, value: text === "" ? null : text };
      }
      if (change) persist({ change });
    }
    return set.call(this, key, raw);
  };
  proto.removeItem = function(key) {
    key = String(key);
    if (this === storage && (key === "dsh.sessions.current" || conversationId(key))) persist({ change: { key, value: null } });
    return remove.call(this, key);
  };
  proto.clear = function() {
    if (this === storage) persist({ clear: true });
    return clear.call(this);
  };
}

// Match the official 0.2.1 webServer contract without accepting caller-supplied
// hosts or forwarded headers. This carrier binds HTTP exclusively to loopback.
export function carrierOrigin(port) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("dsh-native-carrier-origin-before-listen");
  }
  return `http://127.0.0.1:${port}`;
}

function officialBrowserCookieName(host) {
  return `dsh-auth-${createHash("sha256").update(host).digest("base64url")}`;
}

// Cookie stores do not isolate ports. Keep one browser slot, but present the
// original authority-specific name to the unmodified official verifier. Its
// signature, expiry and signed audience remain the authorization boundary.
export function nativeBrowserCookieHeader(raw, host) {
  if (typeof raw !== "string") return raw;
  const segments = raw.split(";").map(part => part.trim());
  const native = segments.filter(part => part.startsWith(`${NATIVE_BROWSER_AUTH_COOKIE}=`));
  if (native.length === 0) return raw;
  if (native.length !== 1) return null;
  const official = officialBrowserCookieName(host);
  return segments.filter(part => !part.startsWith(`${NATIVE_BROWSER_AUTH_COOKIE}=`)
    && !part.startsWith(`${official}=`))
    .concat(`${official}=${native[0].slice(NATIVE_BROWSER_AUTH_COOKIE.length + 1)}`).join("; ");
}

export function nativeBrowserSetCookie(value, host) {
  if (Array.isArray(value)) return value.map(item => nativeBrowserSetCookie(item, host));
  const prefix = `${officialBrowserCookieName(host)}=`;
  return typeof value === "string" && value.startsWith(prefix)
    ? `${NATIVE_BROWSER_AUTH_COOKIE}=${value.slice(prefix.length)}` : value;
}

// This is a response-header adapter, not a second authentication store. Remote
// responses use their existing cookie namespace and never enter this adapter.
export function bindNativeBrowserCookieResponse(response, host) {
  const setHeader = response.setHeader;
  const writeHead = response.writeHead;
  response.setHeader = function (name, value) {
    return setHeader.call(this, name, name.toLowerCase() === "set-cookie"
      ? nativeBrowserSetCookie(value, host) : value);
  };
  response.writeHead = function (...args) {
    const index = typeof args[1] === "string" ? 2 : 1;
    const headers = args[index];
    if (Array.isArray(headers)) {
      args[index] = headers.map((value, offset) => offset % 2 === 1
        && String(headers[offset - 1]).toLowerCase() === "set-cookie"
        ? nativeBrowserSetCookie(value, host) : value);
    } else if (headers && typeof headers === "object") {
      args[index] = Object.fromEntries(Object.entries(headers).map(([name, value]) => [
        name, name.toLowerCase() === "set-cookie" ? nativeBrowserSetCookie(value, host) : value,
      ]));
    }
    return writeHead.apply(this, args);
  };
}

const MAX_PATHS = 256;
const OPEN_INTENT_PATH = "/_luckyray/open-intent";
const OPEN_INTENT_RESOURCE_PREFIX = "/_luckyray/open-intent-resource";
const OPEN_INTENT_SOURCES = new Set(["materials", "notes", "collection", "graph", "search"]);
const OPEN_INTENT_LOCAL_RESOURCE_SOURCES = new Set(["materials", "notes", "collection"]);
const OPEN_INTENT_IMAGE_ATTACHMENT_SOURCES = new Set(["materials", "notes"]);
const MAX_OPEN_INTENT_BYTES = 280 * 1024;
const MAX_OPEN_INTENT_ENCODED_BYTES = 376 * 1024;
const MAX_OPEN_INTENT_LOCAL_RESOURCES = 64;
const MAX_OPEN_INTENT_LOCAL_PATH_BYTES = 4 * 1024;
const MAX_OPEN_INTENT_IMAGE_ATTACHMENTS = 20;
const MAX_OPEN_INTENT_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_OPEN_INTENT_FILE_BYTES = 200 * 1024 * 1024;
const OPEN_INTENT_TTL_MS = 30_000;
const OPEN_INTENT_RECEIPT_MS = 10 * 60_000;
const MAX_OPEN_INTENT_RECEIPTS = 256;
const MAX_CONTROL_FRAME_BYTES = 3 * 1024 * 1024;

// LSH remote surface (Desktop-owned): the companion gateway tunnels raw bytes
// for granted devices to THIS loopback server; the remote branch below re-checks
// every request against a dedicated remote authority (distinct host/origin and
// cookie namespace from the Desktop webview authority) and serves traffic via a
// Desktop-internal hop so the official launch token and both upstream auth
// cookies never reach remote JavaScript.
const REMOTE_BOOTSTRAP_PATH = "/_luckyray/remote/bootstrap";
const REMOTE_MAX_SESSIONS = 16;
const REMOTE_MAX_PENDING_REFS = 64;
const REMOTE_REF_TTL_MS = 120_000;
const REMOTE_MAX_BODY_BYTES = 32 * 1024 * 1024;
const REMOTE_IDLE_TIMEOUT_MS = 60_000;
// A private agent: the official composition may reconfigure the global HTTP
// agent (dsh-http-proxy), and remote surface traffic must NEVER be routed
// through anything but this process's own loopback.
const settleAgent = new Agent({ keepAlive: true, maxSockets: 64 });
const REMOTE_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

const OPEN_INTENT_IMAGE_MEDIA_TYPES = Object.freeze(new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]));

function absoluteLocalPath(value) {
  return /^[a-z]:[\\/]/iu.test(value)
    || /^\\\\(?:\?\\)?[^\\/]+[\\/][^\\/]+/u.test(value)
    || value.startsWith("/");
}

function decodeOpenIntentLocalResources(source, resources) {
  if (!Array.isArray(resources) || resources.length > MAX_OPEN_INTENT_LOCAL_RESOURCES
    || resources.length > 0 && !OPEN_INTENT_LOCAL_RESOURCE_SOURCES.has(source)) {
    throw new Error("dsh-open-intent-invalid");
  }
  const normalized = resources.map((resource) => {
    if (!resource || !["assetId,canonicalPath,delivery,kind", "assetId,canonicalPath,delivery,kind,libraryId"].includes(Object.keys(resource).sort().join(","))
      || resource.libraryId !== undefined && (typeof resource.libraryId !== "string" || !resource.libraryId || resource.libraryId.length > 256
        || resource.libraryId.trim() !== resource.libraryId || /[\u0000-\u001f\u007f]/u.test(resource.libraryId))
      || resource.kind !== "material"
      || !["image-attachment", "file-attachment", "path-reference"].includes(resource.delivery)
      || resource.delivery !== "path-reference" && !OPEN_INTENT_IMAGE_ATTACHMENT_SOURCES.has(source)
      || typeof resource.assetId !== "string" || resource.assetId.length === 0 || resource.assetId.length > 256
      || resource.assetId.trim() !== resource.assetId || /[\u0000-\u001f\u007f]/u.test(resource.assetId)
      || typeof resource.canonicalPath !== "string" || resource.canonicalPath.length === 0
      || resource.canonicalPath.trim() !== resource.canonicalPath
      || Buffer.byteLength(resource.canonicalPath, "utf8") > MAX_OPEN_INTENT_LOCAL_PATH_BYTES
      || /[\u0000-\u001f\u007f]/u.test(resource.canonicalPath)
      || !absoluteLocalPath(resource.canonicalPath)) {
      throw new Error("dsh-open-intent-invalid");
    }
    return Object.freeze({
      kind: "material",
      assetId: resource.assetId,
      ...(resource.libraryId === undefined ? {} : { libraryId: resource.libraryId }),
      canonicalPath: resource.canonicalPath,
      delivery: resource.delivery,
    });
  });
  if (normalized.filter((resource) => resource.delivery === "image-attachment").length
    > MAX_OPEN_INTENT_IMAGE_ATTACHMENTS) {
    throw new Error("dsh-open-intent-invalid");
  }
  return Object.freeze(normalized);
}

function decodeOpenIntent(encoded) {
  if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > MAX_OPEN_INTENT_ENCODED_BYTES
    || !/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new Error("dsh-open-intent-invalid");
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length === 0 || bytes.length > MAX_OPEN_INTENT_BYTES
    || bytes.toString("base64url") !== encoded) throw new Error("dsh-open-intent-invalid");
  const value = JSON.parse(bytes.toString("utf8"));
  const localResources = value && OPEN_INTENT_SOURCES.has(value.source)
    ? decodeOpenIntentLocalResources(value.source, value.localResources)
    : null;
  if (!value || Object.keys(value).sort().join(",") !== "intentId,localResources,source,text"
    || typeof value.intentId !== "string"
    || !/^intent-[0-9a-f]{8}-[0-9a-f-]{27}$/u.test(value.intentId)
    || value.intentId.length > 64
    || !OPEN_INTENT_SOURCES.has(value.source)
    || typeof value.text !== "string" || value.text.trim() !== value.text
    || value.text.length === 0 && localResources?.length === 0
    || Buffer.byteLength(value.text, "utf8") > 12 * 1024
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.text)
    || /file:\/\/\/|(?:^|[\s(（【：:])(?:[a-z]:[\\/]|\\\\)|(?:^|[\s(（【：:])\/(?:Users|home|var|tmp|etc|Volumes|mnt|opt|srv|root|workspace)\//imu.test(value.text)) {
    throw new Error("dsh-open-intent-invalid");
  }
  return Object.freeze({
    intentId: value.intentId,
    localResources,
    source: value.source,
    text: value.text,
  });
}

export function createOpenIntentSlot() {
  let generation = 0;
  let pending = null;
  let deadline = 0;
  // A bounded, generation-bound receipt survives a caller losing the status
  // reply. A previously applied identity must never be staged for delivery a
  // second time, even after a later independent intent occupies the slot.
  const receipts = new Map();
  const prune = () => {
    const now = Date.now();
    for (const [id, receipt] of receipts) {
      if (receipt.expiresAt <= now) receipts.delete(id);
    }
    while (receipts.size > MAX_OPEN_INTENT_RECEIPTS) {
      receipts.delete(receipts.keys().next().value);
    }
  };
  const expire = () => {
    if (pending && Date.now() >= deadline) {
      const receipt = receipts.get(pending.intentId);
      if (receipt) receipt.state = "stale";
      pending = null;
    }
    prune();
  };
  const retirePending = () => {
    if (pending) {
      const receipt = receipts.get(pending.intentId);
      if (receipt) receipt.state = "stale";
      pending = null;
    }
  };
  return Object.freeze({
    bind(nextGeneration) {
      if (!Number.isSafeInteger(nextGeneration) || nextGeneration <= 0) throw new Error("dsh-open-intent-invalid");
      retirePending();
      generation = nextGeneration;
      prune();
    },
    revoke() {
      retirePending();
      generation = 0;
      prune();
    },
    stage(nextGeneration, encoded) {
      if (generation === 0 || nextGeneration !== generation) throw new Error("dsh-open-intent-invalid");
      const next = decodeOpenIntent(encoded);
      expire();
      const payload = JSON.stringify(next);
      const receipt = receipts.get(next.intentId);
      if (receipt) {
        if (receipt.payload !== payload) throw new Error("dsh-open-intent-conflict");
        if (receipt.generation !== generation || receipt.state === "stale") {
          throw new Error("dsh-open-intent-stale");
        }
        if (receipt.state === "applied" || pending?.intentId === next.intentId) {
          return next.intentId;
        }
        throw new Error("dsh-open-intent-stale");
      }
      if (pending) throw new Error("dsh-open-intent-busy");
      pending = next;
      deadline = Date.now() + OPEN_INTENT_TTL_MS;
      receipts.set(next.intentId, { payload, generation, state: "pending", expiresAt: Date.now() + OPEN_INTENT_RECEIPT_MS });
      prune();
      return pending.intentId;
    },
    read(nextGeneration) {
      expire();
      return nextGeneration === generation ? pending : null;
    },
    acknowledge(nextGeneration, intentId) {
      expire();
      if (nextGeneration !== generation || pending?.intentId !== intentId) return false;
      const receipt = receipts.get(intentId);
      if (!receipt || receipt.generation !== generation) return false;
      pending = null;
      receipt.state = "applied";
      receipt.expiresAt = Date.now() + OPEN_INTENT_RECEIPT_MS;
      return true;
    },
    status(nextGeneration, intentId) {
      expire();
      if (nextGeneration !== generation || typeof intentId !== "string") return "unavailable";
      if (pending?.intentId === intentId) return "pending";
      const receipt = receipts.get(intentId);
      return receipt?.generation === generation && receipt.state === "applied" ? "applied" : "unavailable";
    },
  });
}

export function resolveOpenIntentFileResource(slot, generation, intentId, index) {
  const intent = slot?.read?.(generation);
  if (!intent || intent.intentId !== intentId || !Number.isSafeInteger(index) || index < 0) {
    throw new Error("dsh-open-intent-image-unavailable");
  }
  const resource = intent.localResources[index];
  const mediaType = resource?.delivery === "image-attachment"
    ? OPEN_INTENT_IMAGE_MEDIA_TYPES.get(extname(resource.canonicalPath).toLowerCase())
    : resource?.delivery === "file-attachment" ? "application/octet-stream" : undefined;
  if (!mediaType) throw new Error("dsh-open-intent-image-unavailable");
  let canonicalPath;
  let stat;
  try {
    canonicalPath = realpathSync.native(resource.canonicalPath);
    stat = statSync(canonicalPath);
  } catch {
    throw new Error("dsh-open-intent-image-unavailable");
  }
  const comparablePath = (value) => {
    if (process.platform !== "win32") return value;
    const normalized = value.replaceAll("\\", "/");
    if (/^\/\/\?\/UNC\//iu.test(normalized)) return `//${normalized.slice(8)}`;
    return /^\/\/\?\//u.test(normalized) ? normalized.slice(4) : normalized;
  };
  const maxBytes = resource.delivery === "file-attachment" ? MAX_OPEN_INTENT_FILE_BYTES : MAX_OPEN_INTENT_IMAGE_BYTES;
  if (comparablePath(canonicalPath) !== comparablePath(resource.canonicalPath) || !stat.isFile()
    || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes
    || resource.delivery === "image-attachment" && stat.size === 0) {
    throw new Error("dsh-open-intent-image-unavailable");
  }
  return Object.freeze({ canonicalPath, mediaType, bytes: stat.size });
}

// Retain the exported legacy helper for existing image callers/tests.
export const resolveOpenIntentImageResource = resolveOpenIntentFileResource;

function reject(reason = "dsh-native-carrier-denied") {
  return Object.freeze({ accepted: false, reason });
}

function exactSecret(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = createHash("sha256").update(left, "utf8").digest();
  const b = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(a, b) && left.length === right.length;
}

function hashValue(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Remote authority host must be a hostname:port the companion gateway
 * actually advertises; loopback names would blur the Desktop/remote boundary
 * and are rejected outright. */
function validRemoteAuthority(host, origin) {
  if (typeof host !== "string" || typeof origin !== "string") return false;
  if (origin !== `https://${host}`) return false;
  const at = host.lastIndexOf(":");
  if (at <= 0 || at === host.length - 1) return false;
  const name = host.slice(0, at);
  const port = host.slice(at + 1);
  if (!/^\d{1,5}$/u.test(port) || Number(port) < 1 || Number(port) > 65535) return false;
  if (/^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])$/iu.test(name)) return false;
  if (name.length > 253) return false;
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/iu.test(name);
}

function validDeviceId(deviceId) {
  return typeof deviceId === "string" && /^device-[0-9a-f]{32}$/u.test(deviceId);
}

/** Headers a proxied remote request must present upstream so the official
 * loopback fences (Host / Origin / sec-fetch-site) accept it exactly as they
 * accept the Desktop webview — nothing upstream is relaxed. */
function upstreamRequestHeaders(request, carrierPort, sessionUpstreamCookie, remoteCookieName, desktopCookiePair) {
  const headers = { ...request.headers };
  headers.host = `127.0.0.1:${carrierPort}`;
  if (headers.origin !== undefined) headers.origin = `http://127.0.0.1:${carrierPort}`;
  headers["sec-fetch-site"] = "same-origin";
  const jar = [desktopCookiePair, sessionUpstreamCookie];
  const rawCookie = headers.cookie;
  if (typeof rawCookie === "string") {
    for (const part of rawCookie.split(";")) {
      const trimmed = part.trim();
      if (trimmed.length === 0) continue;
      const name = trimmed.slice(0, trimmed.indexOf("=") >= 0 ? trimmed.indexOf("=") : trimmed.length).trim();
      if (name === remoteCookieName || name.startsWith("dsh-auth-")) continue;
      jar.push(trimmed);
    }
  }
  headers.cookie = jar.join("; ");
  return headers;
}

/** Auth-bearing cookies must never be forwarded into a remote response. */
function stripAuthCookies(headerValues, desktopCookieName) {
  return (Array.isArray(headerValues) ? headerValues : typeof headerValues === "string" ? [headerValues] : [])
    .filter((value) => typeof value === "string")
    .filter((value) => !/^dsh-auth-[^=]*=/u.test(value))
    .filter((value) => !(desktopCookieName !== undefined && value.startsWith(`${desktopCookieName}=`)));
}

function validPath(path) {
  return typeof path === "string" && /^\/[\x21-\x7e]*$/u.test(path)
    && !path.includes("?") && !path.includes("#") && !path.includes("\\");
}

export function canonicalizeCarrierPath(rawPath) {
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.length > 4096
    || rawPath[0] !== "/" || /[\\\u0000-\u001f\u007f?#]/u.test(rawPath)
    || /%(?:2f|5c)/iu.test(rawPath)) {
    return reject("dsh-native-carrier-path-invalid");
  }
  let path;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return reject("dsh-native-carrier-path-invalid");
  }
  if (path.length === 0 || path.length > 4096 || path[0] !== "/"
    || /[\\\u0000-\u001f\u007f?#]/u.test(path)
    || /%[0-9a-f]{2}/iu.test(path)
    || path.split("/").some((part) => part === "." || part === "..")) {
    return reject("dsh-native-carrier-path-invalid");
  }
  const protectedPath = PROTECTED_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
  return Object.freeze({ accepted: true, path, protected: protectedPath });
}

function normalizePaths(paths) {
  if (!Array.isArray(paths) || paths.length > MAX_PATHS || paths.some((path) => !validPath(path))) {
    throw new Error("dsh-native-carrier-config-invalid");
  }
  const unique = [...new Set(paths)];
  if (unique.length !== paths.length) throw new Error("dsh-native-carrier-config-invalid");
  return Object.freeze(unique);
}

function header(request, name) {
  const headers = request?.headers;
  if (!headers || typeof headers !== "object") return undefined;
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(",") : value;
}

function cookieValue(request, name) {
  const raw = header(request, "cookie");
  if (typeof raw !== "string") return undefined;
  for (const part of raw.split(";")) {
    const at = part.indexOf("=");
    if (at < 1) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

function routeKind(authority, path) {
  if (authority.exactPaths.includes(path)) return "exact";
  let best;
  for (const prefix of authority.prefixPaths) {
    if (prefix === "/" || path === prefix || path.startsWith(`${prefix}/`)) {
      if (best === undefined || prefix.length > best.length) best = prefix;
    }
  }
  return best === undefined ? undefined : "prefix";
}

const PROTECTED_PREFIXES = Object.freeze(["/_luckyray", "/api", "/plugins"]);

export function isProtectedCarrierNamespace(path) {
  const canonical = canonicalizeCarrierPath(path);
  return canonical.accepted === true && canonical.protected;
}

function identityAccepted(authority, request, requireOrigin) {
  if (authority.active !== true || header(request, "host") !== authority.host) return false;
  if (header(request, "sec-fetch-site") === "cross-site") return false;
  const origin = header(request, "origin");
  if (requireOrigin ? origin !== authority.origin : origin !== undefined && origin !== authority.origin) return false;
  return exactSecret(cookieValue(request, authority.cookieName), authority.cookieValue);
}

export function createCarrierAuthorization(input) {
  if (!input || !Number.isSafeInteger(input.generation) || input.generation <= 0
    || typeof input.host !== "string" || !/^127\.0\.0\.1:\d{1,5}$/u.test(input.host)
    || input.origin !== `http://${input.host}`
    || typeof input.cookieName !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(input.cookieName)
    || typeof input.cookieValue !== "string" || input.cookieValue.length < 32 || input.cookieValue.length > 128
    || typeof input.bootstrapRef !== "string" || input.bootstrapRef.length < 32 || input.bootstrapRef.length > 128) {
    throw new Error("dsh-native-carrier-config-invalid");
  }
  let bootstrapAvailable = true;
  const authority = {
    active: true,
    generation: input.generation,
    host: input.host,
    origin: input.origin,
    cookieName: input.cookieName,
    cookieValue: input.cookieValue,
    exactPaths: normalizePaths(input.exactPaths),
    prefixPaths: normalizePaths(input.prefixPaths),
    upgradePaths: normalizePaths(input.upgradePaths),
    consumeBootstrap(request) {
      if (!bootstrapAvailable || request?.host !== input.host
        || request?.secFetchSite === "cross-site"
        || request?.origin !== undefined && request.origin !== input.origin
        || !exactSecret(request?.ref, input.bootstrapRef)) return reject();
      bootstrapAvailable = false;
      return Object.freeze({ accepted: true });
    },
  };
  return Object.freeze(authority);
}

export function consumeCarrierBootstrap(authority, request) {
  return authority?.active === true ? authority.consumeBootstrap(request) : reject();
}

// The official account platform registers this exact route only while a PKCE
// attempt is live. Its handler, not this carrier, owns constant-time state
// verification, expiry, single use and code exchange. The external system
// browser cannot carry the embedded WebView's private carrier cookie.
export function acceptsOfficialOAuthCallback(authority, request, route) {
  if (authority?.active !== true || request?.method !== "GET"
    || header(request, "host") !== authority.host
    || route?.kind !== "exact" || route.path !== "/oauth/callback"
    || typeof route.handler !== "function"
    || typeof request.url !== "string" || request.url.length > 8192
    || !request.url.startsWith("/oauth/callback?")) return false;
  const origin = header(request, "origin");
  if (origin !== undefined && origin !== authority.origin) return false;
  const mode = header(request, "sec-fetch-mode");
  const dest = header(request, "sec-fetch-dest");
  if (mode !== undefined && mode !== "navigate"
    || dest !== undefined && dest !== "document") return false;
  const url = new URL(request.url, authority.origin);
  return url.pathname === "/oauth/callback"
    && url.searchParams.getAll("state").length === 1
    && url.searchParams.getAll("code").length === 1
    && Boolean(url.searchParams.get("state"))
    && Boolean(url.searchParams.get("code"));
}

export function evaluateHttpAuthorization(authority, request) {
  if (!identityAccepted(authority, request, false)
    || typeof request?.path !== "string"
    || request.path[0] !== "/"
    || /[\\\u0000-\u001f\u007f?#]/u.test(request.path)) return reject();
  const kind = routeKind(authority, request.path);
  return kind === undefined ? reject() : Object.freeze({ accepted: true, routeKind: kind });
}

export function evaluateWebSocketAuthorization(authority, request) {
  if (!identityAccepted(authority, request, true) || !validPath(request?.path)
    || !authority.upgradePaths.includes(request.path)) return reject();
  return Object.freeze({ accepted: true, routeKind: "upgrade" });
}

function readAuthority(fd) {
  const bytes = readFileSync(fd);
  if (bytes.length === 0 || bytes.length > MAX_AUTHORITY_BYTES) throw new Error("dsh-native-carrier-config-invalid");
  const value = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || value.protocol !== 1) throw new Error("dsh-native-carrier-config-invalid");
  return value;
}

function sendDenied(response) {
  response.writeHead(403, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
  response.end("Forbidden");
}

function escapeHtmlAttribute(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderIndexRow(row) {
  switch (row.kind) {
    case "global": return {
      placement: "head",
      markup: `<script>globalThis[${JSON.stringify(row.name).replaceAll("<", "\\u003c")}] = ${row.value === undefined ? "undefined" : JSON.stringify(row.value).replaceAll("<", "\\u003c")}</script>`,
    };
    case "script": return { placement: row.placement, markup: `<script>${row.text}</script>` };
    // 0.1.5 client-modules emits application bundle batches as preload hints
    // ahead of the bootstrap scripts; unknown kinds still fail loudly below.
    case "script-preload": return {
      placement: "head",
      markup: `<link rel="preload" as="script" href="${escapeHtmlAttribute(row.src)}">`,
    };
    case "script-src": return {
      placement: row.placement,
      markup: `<script src="${escapeHtmlAttribute(row.src)}"></script>`,
    };
    case "style": return { placement: "head", markup: `<style>${row.text}</style>` };
    case "html": return { placement: row.placement, markup: row.html };
    default: throw new Error("dsh-native-carrier-index-injection-invalid");
  }
}

export function renderIndexInjections(html, rows) {
  let head = "";
  let body = "";
  for (const row of rows) {
    const rendered = renderIndexRow(row);
    if (rendered.placement === "head") head += rendered.markup;
    else body += rendered.markup;
  }
  let output = html;
  if (head !== "") {
    const open = /<head(?:\s[^>]*)?>/iu.exec(output);
    output = open === null
      ? `${head}${output}`
      : `${output.slice(0, open.index + open[0].length)}${head}${output.slice(open.index + open[0].length)}`;
  }
  if (body !== "") {
    const open = /<body(?:\s[^>]*)?>/iu.exec(output);
    output = open === null
      ? `${output}${body}`
      : `${output.slice(0, open.index + open[0].length)}${body}${output.slice(open.index + open[0].length)}`;
  }
  return output;
}

// A short, reversible hold over the existing official Agent/Session owners.
// No shadow session store: every decision and flush reads those live services.
export function createDesktopUpdateLifecycle(ctx, browser, { timeoutMs = 8_000 } = {}) {
  let round = null;
  const fail = code => { throw new Error(code); };
  // Cordis traces service/entity references through caller-context proxies.
  // Compare its public original identity, but keep calling the traced owners.
  const original = value => value?.[Symbol.for("cordis.original")] ?? value;
  const bounded = async (r, operation, code) => {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
        timer = setTimeout(() => { r.cancelled = true; reject(new Error(code)); }, timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  };
  const services = () => {
    const result = Object.fromEntries(["agents", "sessions", "sessionPersistence", "jobs", "schedule"]
      .map(key => [key, ctx.get(key)]));
    if (result.schedule === undefined) {
      // Frozen rc.2 ships schedules explicitly disabled. Absence alone is not
      // idle evidence: require that exact disabled official Loader entry.
      const loader = ctx.get("loader");
      const entries = typeof loader?.entries === "function" ? [...loader.entries()]
        .filter(entry => entry.options?.name === "@deepseek-ai/dsh-schedule") : [];
      if (entries.length !== 1 || entries[0].options.disabled !== true) fail("update-lsh-state-unavailable");
      result.disabledScheduleEntry = entries[0];
      result.schedule = null;
    }
    if (typeof result.agents?.list !== "function" || typeof result.sessions?.list !== "function"
      || typeof result.sessions?.flush !== "function" || typeof result.sessionPersistence?.flush !== "function"
      || typeof result.jobs?.list !== "function"
      || result.schedule !== null && typeof result.schedule?.catalog !== "function") {
      fail("update-lsh-state-unavailable");
    }
    return result;
  };
  const release = async r => {
    r.removeCreated?.();
    for (const resume of r.releases.splice(0)) resume();
    await Promise.allSettled(r.holds);
  };
  const check = async r => {
    if (round !== r || r.cancelled) fail("update-lsh-round-invalid");
    const live = services();
    if (Object.keys(live).some(key => original(live[key]) !== original(r.services[key]))) fail("update-lsh-identity-changed");
    const agents = live.agents.list();
    const sessions = live.sessions.list();
    if (agents.length !== r.agents.length || agents.some((agent, i) => original(agent) !== original(r.agents[i]))
      || sessions.length !== r.sessions.length || sessions.some((session, i) => original(session) !== original(r.sessions[i]))) {
      fail("update-lsh-identity-changed");
    }
    for (const agent of agents) {
      if (agent.status !== "idle" || agent.inbox?.hasPending !== false) fail("update-lsh-task-active");
    }
    for (const owner of [undefined, ...sessions.map(session => session.id)]) {
      const jobs = live.jobs.list(owner);
      if (!Array.isArray(jobs)) fail("update-lsh-state-unavailable");
      if (jobs.some(job => !["completed", "failed", "killed"].includes(job.status))) fail("update-lsh-task-active");
    }
    const schedules = live.schedule === null ? [] : await live.schedule.catalog();
    if (!Array.isArray(schedules)) fail("update-lsh-state-unavailable");
    if (schedules.some(item => item.status === "active")) fail("update-lsh-schedule-active");
    for (const session of sessions) {
      const activity = await ctx.waterfall("workspace/session-activity", { sessionId: session.id }, async () => []);
      if (!Array.isArray(activity)) fail("update-lsh-state-unavailable");
      if (activity.length !== 0) fail("update-lsh-task-active");
    }
    if (round !== r || r.cancelled) fail("update-lsh-round-invalid");
  };
  return Object.freeze({
    async prepare(id) {
      if (round || typeof id !== "string" || id.length === 0) fail("update-lsh-preparing");
      const r = { id, releases: [], holds: [], saved: false, cancelled: false, committing: false };
      round = r;
      browser.setPaused(true);
      try {
        r.services = services();
        r.agents = r.services.agents.list();
        r.sessions = r.services.sessions.list();
        // Serial official creation notifications roll back publication on a
        // rejection; do not patch Agent methods or silently drop queued input.
        r.removeCreated = ctx.on("agent/created", () => fail("update-lsh-preparing"));
        await bounded(r, () => check(r), "update-lsh-state-timeout");
        for (const agent of r.agents) {
          const held = agent.runMaintenance(async signal => {
            if (signal.aborted) fail("update-lsh-task-active");
            await new Promise(resolve => r.releases.push(resolve));
          });
          held.catch(() => { r.cancelled = true; });
          r.holds.push(held);
        }
        const client = await bounded(r, () => browser.checkClient(id), "update-lsh-client-timeout");
        if (client?.ready !== true) fail(client?.reason ?? "update-lsh-client-unavailable");
        await bounded(r, () => check(r), "update-lsh-state-timeout");
        const revisions = r.sessions.map(session => session.seq);
        try {
          for (const session of r.sessions) {
            if (await bounded(r, () => r.services.sessions.flush(session), "update-lsh-save-timeout") !== true) fail("update-lsh-save-failed");
          }
          await bounded(r, () => r.services.sessionPersistence.flush(), "update-lsh-save-timeout");
        } catch (error) {
          fail(error?.message === "update-lsh-save-timeout" ? "update-lsh-save-timeout" : "update-lsh-save-failed");
        }
        await bounded(r, () => check(r), "update-lsh-state-timeout");
        if (r.sessions.some((session, i) => session.seq !== revisions[i])) fail("update-lsh-content-changed");
        r.savedRevisions = revisions;
        r.saved = true;
        return { ready: true, saved: true, sessionCount: r.sessions.length };
      } catch (error) {
        await release(r);
        if (round === r) round = null;
        browser.setPaused(false);
        throw error;
      }
    },
    async cancel(id) {
      const r = round;
      if (!r || r.id !== id || r.committing) fail("update-lsh-round-invalid");
      r.cancelled = true;
      await release(r);
      if (round === r) round = null;
      browser.setPaused(false);
      return { cancelled: true };
    },
    async commit(id) {
      const r = round;
      if (!r || r.id !== id || r.saved !== true || r.cancelled) fail("update-lsh-round-invalid");
      await bounded(r, () => check(r), "update-lsh-state-timeout");
      if (r.sessions.some((session, i) => session.seq !== r.savedRevisions[i])) fail("update-lsh-content-changed");
      r.committing = true;
      // A paused, retained browser connection can keep the official Session
      // disposer waiting for its client lifetime. Retire only those transports
      // using this carrier's existing cleanup, AFTER durability and the final
      // activity check, while idle Agents are still held. Never kill a process
      // or disconnect a busy/unconfirmed session to make the gate pass.
      browser.retireConnections();
      // Start the existing official whole-application disposer before waking
      // idle Agents; no input or timer can enter between check and teardown.
      console.error("dsh-update-exit: official-dispose-start");
      const disposed = ctx.root.fiber.dispose();
      await release(r);
      console.error("dsh-update-exit: idle-holds-released");
      await bounded(r, () => disposed, "update-lsh-exit-timeout");
      console.error("dsh-update-exit: official-dispose-complete");
      return { stopped: true, saved: true };
    },
  });
}

export async function apply(ctx, config = {}) {
  // 0.1.5's official Connection gates the index behind its process-token
  // exchange; cache its token URL once the service activates so the carrier
  // bootstrap can hand the WebView a one-shot authenticated root instead of
  // a bare "/" (which the official index fence would answer 401).
  // 0.1.5's official Connection gates the index behind its process-token
  // exchange. The outer host relays the official launch URL (parsed from the
  // official Host stdout) over a launch-url control frame; the bootstrap
  // redirect uses it so the WebView mints the official session cookie.
  let officialLaunchUrl = null;
  let resolveOfficialLaunch;
  const officialLaunchReady = new Promise(resolve => { resolveOfficialLaunch = resolve; });
  let launchUrlSeq = 0;
  const validLaunchUrl = (value) => typeof value === "string"
    && /^http:\/\/127\.0\.0\.1:\d{1,5}\/\?token=[A-Za-z0-9_-]{16,240}$/u.test(value);
  const launchUrl = () => officialLaunchUrl ?? "/";
  const authorityFd = Number.isSafeInteger(config.authorityFd) ? config.authorityFd : 3;
  const readyFd = Number.isSafeInteger(config.readyFd) ? config.readyFd : 4;
  const controlFd = Number.isSafeInteger(config.controlFd) ? config.controlFd : 5;
  const controlLineFd = Number.isSafeInteger(config.controlLineFd) ? config.controlLineFd : 6;
  const privateConfig = readAuthority(authorityFd);
  // The existing owner passes the verified surface home as DSH_HOME through
  // its minimal child environment (outer-host variables are not inherited).
  const textDraftStore = createTextDraftStore(process.env.DSH_HOME ?? "");
  // Native-only control channel. No HTTP route and no credential exposed to a renderer.
  let canvasAgentService;
  const canvasAgent = () => {
    const home = process.env.DSH_HOME;
    if (!home || !isAbsolute(home)) throw new Error("canvas-agent-storage-unavailable");
    return canvasAgentService ??= createCanvasAgentService(ctx, {stateDirectory: join(home, "luckyray-canvas-agent-v1")});
  };
  const exact = new Map();
  const prefixes = new Map();
  const upgrades = new Map();
  const sockets = new Set();
  const httpSockets = new Set();
  const retireConnections = (includeHttp = false) => {
    for (const socket of sockets) socket.destroy();
    if (includeHttp) for (const socket of httpSockets) socket.destroy();
  };
  const indexTaps = [];
  let fallback;
  let listenedPort = 0;
  let authority;
  let controlSeq = 0;
  const updatePath = "/_luckyray/desktop-update";
  let updatePaused = false;
  let updateClientTicket = null;
  const updateLifecycle = createDesktopUpdateLifecycle(ctx, {
    // Confirmed update commit also retires HTTP streams/long polls. Ordinary
    // carrier disposal retains its existing graceful HTTP drain behavior.
    retireConnections: () => retireConnections(true),
    setPaused(value) {
      updatePaused = value;
      if (!value) {
        updateClientTicket = null;
        for (const socket of sockets) socket.resume();
      }
    },
    checkClient(id) {
      return new Promise((resolveClient, rejectClient) => {
        const timeout = setTimeout(() => {
          updateClientTicket = null;
          rejectClient(new Error("update-lsh-client-timeout"));
        }, 4_000);
        updateClientTicket = { id, generation: authority.generation, resolve(result) {
          clearTimeout(timeout);
          if (result.ready === true) for (const socket of sockets) socket.pause();
          resolveClient(result);
        } };
      });
    },
  });
  const openIntentSlot = createOpenIntentSlot();
  const providerExport = createBuiltInProviderExportRegistry();
  ctx.provide("luckyrayProviderExport", providerExport);

  // --- LSH remote surface state (Desktop-owned; see header comment) ---
  let remoteAuthority = null;
  const remoteSessions = new Map();
  const remoteRefs = new Map();
  const remoteCookieName = () => `luckyray_dsh_remote_g${authority?.generation ?? 0}`;
  const dropRemoteSessionsFor = (deviceId) => {
    let dropped = 0;
    for (const [key, session] of remoteSessions) {
      if (session.deviceId !== deviceId) continue;
      dropped += 1;
      for (const socket of session.sockets) socket.destroy();
      remoteSessions.delete(key);
    }
    for (const [key, ref] of remoteRefs) {
      if (ref.deviceId === deviceId) remoteRefs.delete(key);
    }
    return dropped;
  };
  const clearRemoteState = () => {
    for (const session of remoteSessions.values()) {
      for (const socket of session.sockets) socket.destroy();
    }
    remoteSessions.clear();
    remoteRefs.clear();
  };
  const settleUpstreamSession = () => new Promise((resolveSettle) => {
    // The official token→cookie exchange happens HERE, on the Desktop, against
    // this same loopback origin. The token URL never leaves the process and the
    // dsh-auth cookie is kept in the device's server-side jar only.
    if (typeof officialLaunchUrl !== "string" || !validLaunchUrl(officialLaunchUrl)) {
      resolveSettle(null);
      return;
    }
    // The carrier's own fence wraps every route, so the Desktop-internal
    // settlement presents the Desktop carrier cookie (memory-only) exactly as
    // the WebView's post-bootstrap redirect would.
    const upstream = httpRequest(officialLaunchUrl, {
      host: "127.0.0.1",
      port: listenedPort,
      agent: settleAgent,
      headers: { cookie: `${authority.cookieName}=${authority.cookieValue}` },
    });
    upstream.setTimeout(10_000, () => upstream.destroy(new Error("dsh-remote-settle-timeout")));
    upstream.once("response", (response) => {
      response.resume();
      if (response.statusCode !== 303) {
        resolveSettle(null);
        return;
      }
      const rawCookies = Array.isArray(response.headers["set-cookie"])
        ? response.headers["set-cookie"]
        : response.headers["set-cookie"] !== undefined
          ? [response.headers["set-cookie"]]
          : [];
      const officialCookies = rawCookies.filter((value) => /^dsh-auth-[^=]*=[^=]/u.test(value));
      resolveSettle(officialCookies.length === 1 ? officialCookies[0].split(";", 1)[0] : null);
    });
    upstream.once("error", () => resolveSettle(null));
    upstream.end();
  });
  const handleRemoteBootstrap = (request, response, url) => {
    if (request.method !== "GET") return sendDenied(response);
    const rawRef = url.searchParams.get("ref");
    if (typeof rawRef !== "string" || !/^[0-9a-f]{64}$/u.test(rawRef)) return sendDenied(response);
    const key = hashValue(rawRef);
    const entry = remoteRefs.get(key);
    const now = Date.now();
    // Single use, and only while the minting carrier generation still rules.
    // A failed upstream settlement releases the in-flight marker so the client
    // can retry the SAME ref until its TTL; success consumes it for good.
    if (!entry || entry.expiresAt <= now || entry.settling === true) {
      if (entry && entry.expiresAt <= now) remoteRefs.delete(key);
      return sendDenied(response);
    }
    if (authority?.active !== true || entry.carrierGeneration !== authority.generation) {
      return sendDenied(response);
    }
    entry.settling = true;
    if (remoteSessions.size >= REMOTE_MAX_SESSIONS) {
      let oldestKey;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [sessionKey, session] of remoteSessions) {
        if (session.createdAt < oldestAt) {
          oldestAt = session.createdAt;
          oldestKey = sessionKey;
        }
      }
      if (oldestKey !== undefined) {
        for (const socket of remoteSessions.get(oldestKey).sockets) socket.destroy();
        remoteSessions.delete(oldestKey);
      }
    }
    // Settle the official session server-side, then hand the remote client
    // ONLY its own HttpOnly remote cookie (Secure: the remote origin is https).
    void settleUpstreamSession().then((upstreamCookie) => {
      // FINAL COMMIT re-check: drop/rotate/clear may have removed the ref or
      // changed the generations while the settlement was in flight — such an
      // in-flight callback must not conjure a session.
      if (remoteRefs.get(key) !== entry || authority?.active !== true
        || entry.carrierGeneration !== authority.generation
        || remoteAuthority === null
        || remoteAuthority.gatewayGeneration !== entry.gatewayGeneration) {
        response.writeHead(403, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
        response.end("Forbidden");
        return;
      }
      if (!upstreamCookie) {
        // Settlement failed (official loader not settled yet or upstream
        // unavailable): the ref stays retryable until its TTL.
        entry.settling = false;
        response.writeHead(503, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
        response.end("dsh-remote-unavailable");
        return;
      }
      remoteRefs.delete(key);
      const cookieValue = randomBytes(32).toString("hex");
      remoteSessions.set(hashValue(cookieValue), {
        deviceId: entry.deviceId,
        gatewayGeneration: entry.gatewayGeneration,
        carrierGeneration: authority.generation,
        upstreamCookie,
        cookieValue,
        createdAt: now,
        lastSeen: now,
        sockets: new Set(),
      });
      response.writeHead(302, {
        "cache-control": "no-store",
        location: "/",
        "set-cookie": `${remoteCookieName()}=${cookieValue}; HttpOnly; Secure; SameSite=Strict; Path=/`,
        "referrer-policy": "no-referrer",
      });
      response.end();
    });
  };
  const proxyRemoteRequest = (request, response, session) => {
    const requestTarget = request.url ?? "/";
    const headers = upstreamRequestHeaders(request, listenedPort, session.upstreamCookie, remoteCookieName(), `${authority.cookieName}=${authority.cookieValue}`);
    let upstream;
    try {
      upstream = httpRequest({
        host: "127.0.0.1",
        port: listenedPort,
        method: request.method,
        path: requestTarget,
        headers,
        agent: settleAgent,
      });
    } catch {
      // A target/header combination that survives llhttp but is rejected by
      // ClientRequest must not become an unhandled rejection in the carrier.
      return sendDenied(response);
    }
    upstream.setTimeout(REMOTE_IDLE_TIMEOUT_MS, () => {
      upstream.destroy(new Error("dsh-remote-upstream-idle"));
      response.destroy();
    });
    let sent = 0;
    request.on("data", (chunk) => {
      sent += chunk.length;
      if (sent > REMOTE_MAX_BODY_BYTES) {
        request.destroy();
        upstream.destroy();
        response.destroy();
      }
    });
    request.pipe(upstream);
    upstream.once("response", (upstreamResponse) => {
      const headersOut = {};
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (REMOTE_HOP_HEADERS.has(name)) continue;
        if (name === "set-cookie") {
          const kept = stripAuthCookies(value, authority?.cookieName);
          if (kept.length > 0) headersOut[name] = kept;
          continue;
        }
        headersOut[name] = value;
      }
      headersOut["cache-control"] = headersOut["cache-control"] ?? "no-store";
      response.writeHead(upstreamResponse.statusCode ?? 502, headersOut);
      upstreamResponse.pipe(response);
      upstreamResponse.once("error", () => response.destroy());
    });
    upstream.once("error", () => {
      if (!response.headersSent) {
        response.writeHead(502, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
        response.end("dsh-remote-upstream-unavailable");
      } else {
        response.destroy();
      }
    });
  };
  const proxyRemoteUpgrade = (request, socket, head, session) => {
    const headers = upstreamRequestHeaders(request, listenedPort, session.upstreamCookie, remoteCookieName(), `${authority.cookieName}=${authority.cookieValue}`);
    headers.connection = "Upgrade";
    headers.upgrade = header(request, "upgrade");
    let upstream;
    try {
      upstream = httpRequest({
        host: "127.0.0.1",
        port: listenedPort,
        method: request.method,
        path: request.url ?? "/",
        headers,
        agent: settleAgent,
      });
    } catch {
      return socket.destroy();
    }
    upstream.setTimeout(REMOTE_IDLE_TIMEOUT_MS, () => {
      upstream.destroy();
      socket.destroy();
    });
    session.sockets.add(socket);
    socket.once("close", () => session.sockets.delete(socket));
    upstream.once("upgrade", (upstreamResponse, upgradeSocket, upgradeHead) => {
      if (upstreamResponse.statusCode !== 101) {
        upgradeSocket.destroy();
        socket.destroy();
        return;
      }
      const lines = [`HTTP/1.1 101 Switching Protocols`];
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        // hop-by-hop headers are dropped EXCEPT the two a valid upgrade
        // response must carry: a standard WebSocket client requires BOTH
        // Upgrade and Connection: Upgrade in the 101.
        if (REMOTE_HOP_HEADERS.has(name) && name !== "upgrade" && name !== "connection") continue;
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
      }
      if (!lines.some((line) => line.toLowerCase().startsWith("connection:"))) {
        lines.push(`connection: Upgrade`);
      }
      socket.write(lines.join("\r\n") + `\r\n\r\n`);
      if (upgradeHead.length > 0) socket.write(upgradeHead);
      upgradeSocket.pipe(socket);
      socket.pipe(upgradeSocket);
      const tear = () => {
        upgradeSocket.destroy();
        socket.destroy();
      };
      socket.once("error", tear);
      upgradeSocket.once("error", tear);
    });
    upstream.once("response", (upstreamResponse) => {
      // Rejected handshake: the rejection body must not leak upstream detail.
      upstreamResponse.resume();
      socket.destroy();
    });
    upstream.once("error", () => socket.destroy());
    upstream.end(head.length > 0 ? head : undefined);
  };

  const service = {
    get port() { return listenedPort; },
    get host() { return "127.0.0.1"; },
    get protocol() { return "http:"; },
    getOrigin() { return carrierOrigin(listenedPort); },
    register(route) {
      const table = route?.kind === "exact" ? exact : route?.kind === "prefix" ? prefixes : null;
      if (!table || !validPath(route.path) || table.has(route.path) || typeof route.handler !== "function") {
        throw new Error("dsh-native-carrier-route-invalid");
      }
      table.set(route.path, route);
      return () => table.delete(route.path);
    },
    registerUpgrade(route) {
      if (!validPath(route?.path) || upgrades.has(route.path) || typeof route.handler !== "function") {
        throw new Error("dsh-native-carrier-route-invalid");
      }
      upgrades.set(route.path, route);
      return () => upgrades.delete(route.path);
    },
    registerFallback(handler) {
      if (fallback || typeof handler !== "function") throw new Error("dsh-native-carrier-route-invalid");
      fallback = handler;
      return () => { fallback = undefined; };
    },
    tapIndex(transform) {
      if (typeof transform !== "function") throw new Error("dsh-native-carrier-route-invalid");
      indexTaps.push(transform);
      return () => { const at = indexTaps.indexOf(transform); if (at >= 0) indexTaps.splice(at, 1); };
    },
    applyIndexTaps(html) { return indexTaps.reduce((value, tap) => tap(value), html); },
    collectIndexInjections() {
      const table = [];
      ctx.emit("webserver/index-inject", table);
      return table;
    },
    renderIndex(html) {
      const early = textDraftStore ? [{ kind: "script", placement: "head", text: `(${installTextDraftBridge.toString()})();` }] : [];
      return service.applyIndexTaps(renderIndexInjections(html, [...early, ...service.collectIndexInjections()]));
    },
  };

  service.register({ kind: "exact", path: TEXT_DRAFT_PATH, async handler(request, response) {
    if (!textDraftStore || request.headers["x-luckyray-text-drafts"] !== "1") return sendDenied(response);
    let result;
    if (request.method === "GET") result = textDraftStore.begin();
    else if (request.method === "POST") {
      const chunks = [];
      let bytes = 0;
      request.setTimeout(4_000, () => request.destroy());
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > MAX_TEXT_DRAFT_BYTES + 16 * 1024) throw new Error("dsh-text-draft-too-large");
        chunks.push(chunk);
      }
      result = textDraftStore.write(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } else return sendDenied(response);
    response.writeHead(200, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(result));
  } });

  const writePrivateFrame = (frame) => writeFileSync(
    controlLineFd,
    `${JSON.stringify(frame)}\n`,
    { encoding: "utf8" },
  );
  service.register({ kind: "exact", path: updatePath, async handler(request, response) {
    const ticket = updateClientTicket;
    if (!ticket || !updatePaused) { response.writeHead(204); response.end(); return; }
    if (request.method === "GET") {
      response.writeHead(200, { "cache-control": "no-store", "content-type": "application/json" });
      response.end(JSON.stringify({ id: ticket.id, generation: ticket.generation }));
      return;
    }
    if (request.method !== "POST") return sendDenied(response);
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 1024) throw new Error("update-lsh-client-invalid");
        chunks.push(chunk);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (Object.keys(value).sort().join(",") !== "generation,id,ready,reason"
        || updateClientTicket !== ticket || value.id !== ticket.id || value.generation !== ticket.generation
        || typeof value.ready !== "boolean" || value.ready && value.reason !== null
        || !value.ready && !/^update-lsh-[a-z-]+$/.test(value.reason ?? "")) return sendDenied(response);
      ticket.resolve(value);
      response.writeHead(204); response.end();
    } catch { sendDenied(response); }
  } });
  const reportSurfaceState = (state) => {
    if (authority?.active !== true
      || !state || typeof state !== "object" || state.clientReady !== true
      || state.sessionOpen !== null && (typeof state.sessionOpen !== "string"
        || state.sessionOpen.length === 0 || state.sessionOpen.length > 128)) {
      return false;
    }
    writePrivateFrame({
      type: "surface-state",
      carrierGeneration: authority.generation,
      clientReady: true,
      sessionOpen: state.sessionOpen,
    });
    return true;
  };
  service.register({
    kind: "exact",
    path: "/_luckyray/surface-state",
    async handler(request, response) {
      if (request.method !== "POST"
        || !String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return sendDenied(response);
      }
      try {
        const chunks = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 16 * 1024) throw new Error("dsh-native-surface-state-invalid");
          chunks.push(chunk);
        }
        if (length === 0) throw new Error("dsh-native-surface-state-invalid");
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!body || Object.keys(body).length !== 2 || !reportSurfaceState(body)) {
          return sendDenied(response);
        }
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
      } catch {
        sendDenied(response);
      }
    },
  });
  service.register({
    kind: "exact",
    path: OPEN_INTENT_PATH,
    async handler(request, response) {
      if (request.method === "GET") {
        const intent = openIntentSlot.read(authority?.active === true ? authority.generation : 0);
        if (!intent) {
          response.writeHead(204, { "cache-control": "no-store" });
          response.end();
          return;
        }
        const body = Buffer.from(JSON.stringify(intent), "utf8");
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "content-length": body.length,
        });
        response.end(body);
        return;
      }
      if (request.method !== "POST"
        || !String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return sendDenied(response);
      }
      try {
        const chunks = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 512) throw new Error("dsh-open-intent-invalid");
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!body || Object.keys(body).join(",") !== "intentId"
          || typeof body.intentId !== "string"
          || !openIntentSlot.acknowledge(
            authority?.active === true ? authority.generation : 0,
            body.intentId,
          )) return sendDenied(response);
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
      } catch {
        sendDenied(response);
      }
    },
  });
  service.register({
    kind: "prefix",
    path: OPEN_INTENT_RESOURCE_PREFIX,
    handler(request, response) {
      if (request.method !== "GET") return sendDenied(response);
      const pathname = String(request.url || "").split("?", 1)[0];
      const match = /^\/_luckyray\/open-intent-resource\/(intent-[0-9a-f-]{36,57})\/(\d{1,2})$/u.exec(pathname);
      if (!match) return sendDenied(response);
      try {
        const resource = resolveOpenIntentFileResource(
          openIntentSlot,
          authority?.active === true ? authority.generation : 0,
          match[1],
          Number(match[2]),
        );
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": resource.mediaType,
          "content-length": resource.bytes,
          "x-content-type-options": "nosniff",
        });
        const stream = createReadStream(resource.canonicalPath);
        stream.once("error", () => response.destroy());
        stream.pipe(response);
      } catch {
        sendDenied(response);
      }
    },
  });

  const match = (pathname) => {
    if (exact.has(pathname)) return exact.get(pathname);
    let best;
    for (const [prefix, route] of prefixes) {
      if ((pathname === prefix || pathname.startsWith(`${prefix}/`))
        && (best === undefined || prefix.length > best.path.length)) best = route;
    }
    return best;
  };

  const server = createServer(async (request, response) => {
    if (authority?.active === true && request.headers.host === authority.host) {
      const translated = nativeBrowserCookieHeader(request.headers.cookie, authority.host);
      if (translated === null) return sendDenied(response);
      if (translated !== undefined) request.headers.cookie = translated;
      bindNativeBrowserCookieResponse(response, authority.host);
    }
    const requestTarget = request.url ?? "/";
    const rawPath = requestTarget.split("?", 1)[0];
    if (updatePaused && rawPath !== updatePath) {
      response.writeHead(503, { "cache-control": "no-store" });
      response.end("update-lsh-preparing");
      return;
    }
    const canonical = canonicalizeCarrierPath(rawPath);
    let url;
    try {
      url = new URL(requestTarget, `http://${request.headers.host ?? "invalid"}`);
    } catch {
      return sendDenied(response);
    }
    if (!canonical.accepted) return sendDenied(response);
    // LSH remote surface branch: the companion gateway tunnels raw bytes for
    // granted devices here with the ADVERTISED remote host; every request is
    // re-fenced against the dedicated remote authority below. The Desktop
    // authority (127.0.0.1) is untouched and never accepts remote cookies.
    if (remoteAuthority !== null && request.headers.host === remoteAuthority.host) {
      // Desktop draft text is never forwarded through the companion proxy.
      if (canonical.path === TEXT_DRAFT_PATH) return sendDenied(response);
      if (authority?.active !== true || request.headers["sec-fetch-site"] === "cross-site") {
        return sendDenied(response);
      }
      // R5 entry validation: the browser's own Origin must be the advertised
      // remote origin whenever present, and MUST be present (and exact) for
      // any non-safe method. Only after this does the proxy construct the
      // internal trusted hop — a mismatched/wrong-port/same-site-different-
      // origin request never reaches it.
      const entryOrigin = request.headers.origin;
      const safeMethod = request.method === "GET" || request.method === "HEAD";
      if (entryOrigin !== undefined && entryOrigin !== remoteAuthority.origin) {
        return sendDenied(response);
      }
      if (!safeMethod && entryOrigin === undefined) {
        return sendDenied(response);
      }
      if (canonical.path === REMOTE_BOOTSTRAP_PATH) {
        return void handleRemoteBootstrap(request, response, url);
      }
      const remoteCookie = cookieValue(request, remoteCookieName());
      if (typeof remoteCookie !== "string") return sendDenied(response);
      const sessionKey = hashValue(remoteCookie);
      const session = remoteSessions.get(sessionKey);
      if (!session || session.carrierGeneration !== authority.generation
        || remoteAuthority.gatewayGeneration !== session.gatewayGeneration
        || !exactSecret(remoteCookie, session.cookieValue)) {
        return sendDenied(response);
      }
      session.lastSeen = Date.now();
      return void proxyRemoteRequest(request, response, session);
    }
    if (canonical.path === privateConfig.bootstrapPath) {
      // Do not consume the one-shot capability or redirect to an unauthenticated
      // root while the official launch relay is still in flight.
      if (officialLaunchUrl === null) {
        response.writeHead(503, { "cache-control": "no-store" });
        response.end("dsh-native-launch-not-ready");
        return;
      }
      const result = consumeCarrierBootstrap(authority, {
        host: request.headers.host,
        origin: request.headers.origin,
        secFetchSite: request.headers["sec-fetch-site"],
        ref: url.searchParams.get("ref"),
      });
      if (!result.accepted) return sendDenied(response);
      response.writeHead(302, {
        "cache-control": "no-store",
        "set-cookie": `${authority.cookieName}=${authority.cookieValue}; HttpOnly; SameSite=Strict; Path=/`,
        location: launchUrl(),
      });
      response.end();
      return;
    }
    const route = match(canonical.path);
    const liveAuthority = {
      ...authority,
      exactPaths: [...exact.keys()],
      prefixPaths: fallback === undefined ? [...prefixes.keys()] : ["/", ...prefixes.keys()],
    };
    const accepted = evaluateHttpAuthorization(liveAuthority, {
      path: canonical.path,
      method: request.method,
      headers: request.headers,
    });
    const officialCallback = acceptsOfficialOAuthCallback(authority, request, route);
    if ((!accepted.accepted && !officialCallback)
      || route === undefined && (fallback === undefined || canonical.protected)) {
      return sendDenied(response);
    }
    // A failing route (official or LuckyRay) must end its response with a
    // bounded, sanitized error instead of leaving the browser request hanging
    // on an unreadable socket; the server itself stays fully alive.
    try {
      await (route?.handler ?? fallback)(request, response);
    } catch {
      console.error("dsh-carrier-route-error");
      if (response.writableEnded || response.destroyed) return;
      // Once headers/body have started, a 500 body could corrupt the declared
      // response (including Content-Length). Abort that response instead.
      if (response.headersSent) return response.destroy();
      response.writeHead(500, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
      response.end("dsh-carrier-route-error");
    }
  });
  server.on("connection", socket => {
    httpSockets.add(socket);
    socket.once("close", () => httpSockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    if (updatePaused) return socket.destroy();
    if (authority?.active === true && request.headers.host === authority.host) {
      const translated = nativeBrowserCookieHeader(request.headers.cookie, authority.host);
      if (translated === null) return socket.destroy();
      if (translated !== undefined) request.headers.cookie = translated;
    }
    const rawPath = (request.url ?? "/").split("?", 1)[0];
    const canonical = canonicalizeCarrierPath(rawPath);
    if (!canonical.accepted) return socket.destroy();
    if (remoteAuthority !== null && request.headers.host === remoteAuthority.host) {
      if (authority?.active !== true || request.headers["sec-fetch-site"] === "cross-site"
        || request.headers.origin !== remoteAuthority.origin) {
        return socket.destroy();
      }
      const remoteCookie = cookieValue(request, remoteCookieName());
      if (typeof remoteCookie !== "string") return socket.destroy();
      const session = remoteSessions.get(hashValue(remoteCookie));
      if (!session || session.carrierGeneration !== authority.generation
        || remoteAuthority.gatewayGeneration !== session.gatewayGeneration
        || !exactSecret(remoteCookie, session.cookieValue)
        || !upgrades.has(canonical.path)) {
        return socket.destroy();
      }
      session.lastSeen = Date.now();
      return void proxyRemoteUpgrade(request, socket, head, session);
    }
    const accepted = evaluateWebSocketAuthorization({
      ...authority,
      upgradePaths: [...upgrades.keys()],
    }, { path: canonical.path, headers: request.headers });
    const route = upgrades.get(canonical.path);
    if (!accepted.accepted || !route) return socket.destroy();
    httpSockets.delete(socket);
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    Promise.resolve(route.handler(request, socket, head)).catch(() => socket.destroy());
  });

  await new Promise((resolve, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      const address = server.address();
      if (!address || typeof address === "string") return rejectListen(new Error("dsh-native-carrier-bind-failed"));
      listenedPort = address.port;
      resolve();
    });
  });
  const host = `127.0.0.1:${listenedPort}`;
  authority = Object.freeze({ ...createCarrierAuthorization({
    ...privateConfig,
    host,
    origin: `http://${host}`,
    exactPaths: [...exact.keys()],
    prefixPaths: [...prefixes.keys()],
    upgradePaths: [...upgrades.keys()],
  }), active: true });
  openIntentSlot.bind(authority.generation);
  ctx.provide("webServer", service);
  ctx.effect(() => async () => {
    await canvasAgentService?.dispose();
    retireConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }, "luckyrayDshCarrier.listen");
  const controlInput = createReadStream(null, { fd: controlFd, autoClose: false });
  const controlLines = createInterface({
    input: controlInput,
    crlfDelay: Infinity,
  });
  void (async () => {
    for await (const line of controlLines) {
      if (Buffer.byteLength(line, "utf8") > MAX_CONTROL_FRAME_BYTES) throw new Error("dsh-native-carrier-control-invalid");
      const frame = JSON.parse(line);
      if (!frame || !Number.isSafeInteger(frame.seq)
        || !["binding-open", "binding-close", "model-sync", "open-intent", "open-intent-status", "launch-url",
          "remote-authority", "remote-session-mint", "remote-session-drop",
          "update-prepare", "update-cancel", "update-stop", "canvas-agent"].includes(frame.type)) {
        throw new Error("dsh-native-carrier-control-invalid");
      }
      if (frame.type === "launch-url") {
        // The launch relay streams beside the binding channel with its own
        // monotonic sequence, so it never collides with binding seq space.
        if (Object.keys(frame).sort().join(",") !== "launchUrl,seq,type"
          || frame.seq !== launchUrlSeq + 1 || !validLaunchUrl(frame.launchUrl)) {
          throw new Error("dsh-native-carrier-control-invalid");
        }
        launchUrlSeq = frame.seq;
        officialLaunchUrl = frame.launchUrl;
        resolveOfficialLaunch();
        // One-way notification: the fd6 control channel's pending table only
        // tracks command acks, so a launch-url ack here would be judged
        // invalid by the outer host and kill the official Host.
        continue;
      }
      if (frame.seq !== controlSeq + 1) {
        throw new Error("dsh-native-carrier-control-invalid");
      }
      controlSeq = frame.seq;
      if (frame.type === "canvas-agent") {
        if (Object.keys(frame).sort().join(",") !== "payload,seq,type") throw new Error("dsh-native-carrier-control-invalid");
        let result;
        try {
          if (typeof frame.payload !== "string" || frame.payload.length > Math.ceil(2 * 1024 * 1024 / 3) * 4
            || !/^[A-Za-z0-9_-]+$/.test(frame.payload)) throw new Error("canvas-agent-invalid-request");
          const bytes = Buffer.from(frame.payload,"base64url");
          if (bytes.length > 2 * 1024 * 1024 || bytes.toString("base64url") !== frame.payload) throw new Error("canvas-agent-invalid-request");
          const request = JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(bytes));
          if (["start", "newConversation", "resumeConversation"].includes(request?.op) && (updatePaused || authority?.active !== true)) throw new Error("canvas-agent-host-paused");
          result = await canvasAgent().dispatch(request);
          if (Buffer.byteLength(JSON.stringify(result),"utf8") > 2 * 1024 * 1024) throw new Error("canvas-agent-response-too-large");
        } catch (error) {
          result = {error: /^canvas-agent-[a-z-]+$/.test(error?.message ?? "") ? error.message : "canvas-agent-request-failed"};
        }
        writePrivateFrame({type:"canvas-agent-result",seq:frame.seq,outcome:"accepted",payload:Buffer.from(JSON.stringify(result)).toString("base64url")});
        continue;
      }
      if (frame.type.startsWith("update-")) {
        if (Object.keys(frame).sort().join(",") !== "id,seq,type"
          || typeof frame.id !== "string" || frame.id.length === 0 || frame.id.length > 160) {
          throw new Error("dsh-native-carrier-control-invalid");
        }
        let result;
        try {
          result = frame.type === "update-prepare" ? (canvasAgentService?.hasActiveRuns() ? {ready:false,reason:"update-lsh-busy"} : await updateLifecycle.prepare(frame.id))
            : frame.type === "update-cancel" ? await updateLifecycle.cancel(frame.id)
              : await updateLifecycle.commit(frame.id);
        } catch (error) {
          result = { ready: false, reason: /^update-lsh-[a-z-]+$/.test(error?.message ?? "")
            ? error.message : "update-lsh-exit-failed" };
        }
        writePrivateFrame({ type: `${frame.type}-result`, seq: frame.seq, outcome: "accepted",
          payload: Buffer.from(JSON.stringify(result)).toString("base64url") });
        if (result.stopped === true && result.saved === true) {
          // The full official tree has already disposed and all writes were
          // acknowledged. The CLI's process-level pipes/signal handlers outlive
          // that tree; complete this owned, already-drained CLI with exit0.
          // This is never used on a busy/save-failed/timed-out runtime.
          console.error("dsh-update-exit: stop-ack-written");
          controlLines.close();
          console.error("dsh-update-exit: control-lines-closed");
          controlInput.destroy();
          console.error("dsh-update-exit: normal-cli-exit");
          process.exit(0);
        }
        continue;
      }
      if (frame.type === "open-intent") {
        if (Object.keys(frame).sort().join(",") !== "payload,seq,type") {
          throw new Error("dsh-native-carrier-control-invalid");
        }
        openIntentSlot.stage(authority?.active === true ? authority.generation : 0, frame.payload);
        writePrivateFrame({ type: "open-intent-result", seq: frame.seq, outcome: "accepted" });
        continue;
      }
      if (frame.type === "open-intent-status") {
        if (Object.keys(frame).sort().join(",") !== "intentId,seq,type"
          || typeof frame.intentId !== "string"
          || !/^intent-[0-9a-f]{8}-[0-9a-f-]{27}$/u.test(frame.intentId)) {
          throw new Error("dsh-native-carrier-control-invalid");
        }
        writePrivateFrame({ type: "open-intent-status-result", seq: frame.seq,
          outcome: "accepted", payload: openIntentSlot.status(
            authority?.active === true ? authority.generation : 0, frame.intentId,
          ) });
        continue;
      }
      if (frame.type === "model-sync") {
        let result;
        try {
          result = await projectProviderSync({
            registry: providerExport,
            settings: ctx.settings,
            credentials: ctx.credentials,
            agentDefaultModel: ctx.get?.("agentDefaultModel"),
            launchEnvironment: ctx.get?.("launchEnvironment") ?? ctx.launchEnvironment,
            llm: ctx.llm,
          });
        } catch {
          result = Object.freeze({ outcome: "unavailable" });
        }
        writePrivateFrame({
          type: "model-sync-result",
          seq: frame.seq,
          outcome: "accepted",
          payload: (() => {
            let body = Buffer.from(JSON.stringify(result), "utf8");
            if (body.length > 256 * 1024) {
              body = Buffer.from(JSON.stringify({ outcome: "unavailable" }), "utf8");
            }
            return body.toString("base64url");
          })(),
        });
        continue;
      }
      if (frame.type === "remote-authority") {
        // The companion gateway advertises exactly one remote origin bound to
        // ITS generation: set = host+origin+gatewayGeneration, clear =
        // gatewayGeneration (or a bare seq/type frame). Either way every live
        // remote session goes away; sessions are re-validated against the
        // CURRENT gateway generation on every request.
        const fields = Object.keys(frame).sort().join(",");
        const host = frame.host ?? null;
        if (fields === "seq,type" || fields === "gatewayGeneration,seq,type") {
          remoteAuthority = null;
          clearRemoteState();
          writePrivateFrame({ type: "remote-authority-ack", seq: frame.seq, outcome: "accepted" });
          continue;
        }
        if (fields !== "gatewayGeneration,host,origin,seq,type"
          || host === null || !Number.isSafeInteger(frame.gatewayGeneration)
          || frame.gatewayGeneration <= 0
          || !validRemoteAuthority(host, frame.origin)) {
          throw new Error("dsh-native-carrier-control-invalid");
        }
        remoteAuthority = Object.freeze({
          host, origin: frame.origin, gatewayGeneration: frame.gatewayGeneration,
        });
        clearRemoteState();
        writePrivateFrame({ type: "remote-authority-ack", seq: frame.seq, outcome: "accepted" });
        continue;
      }
      if (frame.type === "remote-session-mint") {
        const fields = Object.keys(frame).sort().join(",");
        if (fields !== "deviceId,gatewayGeneration,seq,type"
          || !validDeviceId(frame.deviceId) || !Number.isSafeInteger(frame.gatewayGeneration)
          || frame.gatewayGeneration <= 0) {
          throw new Error("dsh-native-carrier-control-invalid");
        }
        if (authority?.active !== true || remoteAuthority === null
          || remoteAuthority.gatewayGeneration !== frame.gatewayGeneration
          || typeof officialLaunchUrl !== "string"
          || remoteRefs.size >= REMOTE_MAX_PENDING_REFS) {
          // A mint from a retired gateway generation must NOT become a
          // usable ref: the gateway generation is validated HERE, not merely
          // stored.
          writePrivateFrame({ type: "remote-session-mint-result", seq: frame.seq, outcome: "rejected" });
          continue;
        }
        for (const [key, ref] of remoteRefs) {
          if (ref.expiresAt <= Date.now()) remoteRefs.delete(key);
        }
        const ref = randomBytes(32).toString("hex");
        const expiresAtMs = Date.now() + REMOTE_REF_TTL_MS;
        remoteRefs.set(hashValue(ref), {
          deviceId: frame.deviceId,
          gatewayGeneration: frame.gatewayGeneration,
          carrierGeneration: authority.generation,
          expiresAt: expiresAtMs,
          settling: false,
        });
        writePrivateFrame({
          type: "remote-session-mint-result",
          seq: frame.seq,
          outcome: "accepted",
          payload: Buffer.from(JSON.stringify({
            ref,
            expiresAtMs,
            bootstrapPath: REMOTE_BOOTSTRAP_PATH,
          }), "utf8").toString("base64url"),
        });
        continue;
      }
      if (frame.type === "remote-session-drop") {
        const fields = Object.keys(frame).sort().join(",");
        if (fields !== "deviceId,seq,type" || !validDeviceId(frame.deviceId)) {
          throw new Error("dsh-native-carrier-control-invalid");
        }
        const dropped = dropRemoteSessionsFor(frame.deviceId);
        writePrivateFrame({
          type: "remote-session-drop-ack",
          seq: frame.seq,
          outcome: "accepted",
        });
        void dropped;
        continue;
      }
      for (const socket of sockets) socket.destroy();
      if (frame.type === "binding-close") {
        authority = Object.freeze({ ...authority, active: false });
        openIntentSlot.revoke();
        clearRemoteState();
      } else {
        authority = Object.freeze({ ...createCarrierAuthorization({
          ...frame.authority,
          host,
          origin: `http://${host}`,
          exactPaths: [...exact.keys()],
          prefixPaths: [...prefixes.keys()],
          upgradePaths: [...upgrades.keys()],
        }), active: true });
        openIntentSlot.bind(authority.generation);
        // binding-open may carry the wrapper's current remote authority; its
        // shape is validated by the same fence as the standalone frame.
        const carried = frame.authority?.remoteAuthority ?? null;
        if (carried === null) {
          remoteAuthority = null;
          clearRemoteState();
        } else if (typeof carried === "object"
          && validRemoteAuthority(carried.host, carried.origin)) {
          remoteAuthority = Object.freeze({ host: carried.host, origin: carried.origin });
          clearRemoteState();
        }
      }
      writePrivateFrame({ type: `${frame.type}-ack`, seq: frame.seq, outcome: "accepted" });
    }
  })().catch(() => { console.error("dsh-carrier-control-error"); server.close(); });
  const announceReady = () => writeFileSync(readyFd, `${JSON.stringify({
      type: "carrier-ready",
      protocol: 1,
      generation: authority.generation,
      port: listenedPort,
      bootstrapPath: privateConfig.bootstrapPath,
      bootstrapRef: privateConfig.bootstrapRef,
    })}\n`, { encoding: "utf8" });
  queueMicrotask(() => {
    const settled = ctx.get("loader")?.await();
    // The loader can settle before the CLI prints its official token URL.
    // Ready must bind both facts; the outer host's existing deadline remains
    // authoritative when either the loader or launch relay never arrives.
    Promise.all([settled, officialLaunchReady]).then(announceReady, () => {});
  });
}

export default { apply };
