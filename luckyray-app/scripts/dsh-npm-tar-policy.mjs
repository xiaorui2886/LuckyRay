// Preflight only. pnpm remains the extractor/package manager; this gate rejects
// unsafe or over-budget npm archives BEFORE pnpm is allowed to consume them.
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
const decoder = new TextDecoder("utf-8", { fatal: true });
const reserved = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const fail = () => { throw new Error("npm-tar-policy-invalid"); };
function field(bytes) {
  const end = bytes.indexOf(0);
  if (end >= 0 && bytes.subarray(end).some((b) => b !== 0)) fail();
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function octal(bytes) {
  const text = bytes.toString("ascii").replace(/[\0 ]+$/u, "").trimStart();
  if (!/^[0-7]+$/u.test(text)) fail();
  const value = parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail();
  return value;
}
function pathKey(path, directory, root) {
  if (directory) path = path.replace(/\/$/u, "");
  const parts = path.split("/").filter((part, index) => index === 0 || part !== ".");
  if (parts[0] !== root || (!directory && parts.length < 2) || parts.length > 32 || Buffer.byteLength(path) > 1024
    || /[\u0000-\u001f\u007f<>:"|?*\\]/u.test(path) || path.normalize("NFC") !== path
    || parts.some((part) => !part || part === "." || part === ".." || /[. ]$/u.test(part) || reserved.test(part))) fail();
  return { key: parts.map((p) => p.toLowerCase()).join("/"), canonical: parts.join("/") };
}
// The pinned pnpm tar-stream reader consumes only path/linkpath/size; it
// exposes all other PAX values as inert metadata. Reject linkpath and admit
// only the bounded legacy npm-builder fields actually present in this closure.
const inertPaxKeys = new Set([
  "mtime", "atime", "ctime", "uid", "gid", "uname", "gname",
  "NODETAR.depth", "NODETAR.ignoreFiles.0", "NODETAR.ignoreFiles.1", "NODETAR.ignoreFiles.2",
  "NODETAR.package.name", "NODETAR.package.version", "NODETAR.package.description",
  "NODETAR.package.main", "NODETAR.package.scripts.test", "NODETAR.package.repository",
  "NODETAR.package.keywords.0", "NODETAR.package.keywords.1", "NODETAR.package.keywords.2", "NODETAR.package.keywords.3",
  "NODETAR.package.author", "NODETAR.package.license", "NODETAR.package.devDependencies.mocha",
  "SCHILY.dev", "SCHILY.ino", "NODETAR.blksize", "NODETAR.blocks",
]);
function paxFields(bytes) {
  let offset = 0;
  const result = { path: null, size: null, type: null };
  const seen = new Set();
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < offset || space - offset > 10) fail();
    const lengthText = bytes.subarray(offset, space).toString("ascii");
    if (!/^[1-9]\d*$/u.test(lengthText)) fail();
    const length = Number(lengthText), end = offset + length;
    if (end > bytes.length || end <= space + 1 || bytes[end - 1] !== 10) fail();
    const item = decoder.decode(bytes.subarray(space + 1, end - 1));
    const equals = item.indexOf("=");
    const key = item.slice(0, equals), value = item.slice(equals + 1);
    if (equals < 1 || seen.has(key)) fail();
    seen.add(key);
    if (key === "path") { if (!value) fail(); result.path = value; }
    else if (key === "size") {
      if (!/^(?:0|[1-9]\d*)$/u.test(value) || !Number.isSafeInteger(Number(value))) fail();
      result.size = Number(value);
    } else if (key === "NODETAR.type") {
      if (!["File", "Directory"].includes(value)) fail();
      result.type = value;
    } else if (key === "NODETAR.follow") { if (value !== "false") fail(); }
    else if (key === "SCHILY.nlink") { if (value !== "1") fail(); }
    else if (!inertPaxKeys.has(key)) fail();
    offset = end;
  }
  return result;
}

export function auditNpmTarball(archive, { maxBytes = 256 * 1024 * 1024, maxFiles = 30_000 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 256 * 1024 * 1024
      || !Number.isSafeInteger(maxFiles) || maxFiles <= 0 || maxFiles > 30_000) fail();
  if (!Buffer.isBuffer(archive) || archive.length === 0 || archive.length > 256 * 1024 * 1024) fail();
  const bytes = gunzipSync(archive, { maxOutputLength: maxBytes + maxFiles * 2048 + 1024 });
  const files = new Map(), directories = new Set();
  let offset = 0, zero = 0, fileBytes = 0, pendingPax = null, paxCount = 0, root = null, identicalAliases = 0, entries = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512); offset += 512;
    if (header.every((b) => b === 0)) { if (++zero >= 2) break; continue; }
    if (zero !== 0) fail();
    if (++entries > maxFiles * 2) fail();
    const magic = header.subarray(257, 263).toString("ascii");
    if (!["ustar\0", "ustar "].includes(magic)) fail();
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== octal(header.subarray(148, 156))) fail();
    const size = octal(header.subarray(124, 136));
    const end = offset + size, padded = offset + Math.ceil(size / 512) * 512;
    if (padded > bytes.length || size > maxBytes || bytes.subarray(end, padded).some((b) => b !== 0)) fail();
    const type = header[156];
    if (type === 120) { // bounded per-entry PAX path extension, never links/global
      if (pendingPax !== null || ++paxCount > maxFiles || size > 4096) fail();
      pendingPax = paxFields(bytes.subarray(offset, end)); offset = padded; continue;
    }
    if (![0, 48, 53].includes(type) || header.subarray(157, 257).some((b) => b !== 0)) fail();
    // Legacy BSD ustar uses a 130-byte prefix followed by atime/ctime.
    // The pinned pnpm tar-stream decoder reads a null-terminated prefix. Admit
    // only valid octal timestamp fields in that otherwise ignored tail.
    let prefix;
    if (header[475] === 0 && header.subarray(476, 500).some((b) => b !== 0)) {
      prefix = field(header.subarray(345, 475));
      octal(header.subarray(476, 488)); octal(header.subarray(488, 500));
    } else { prefix = field(header.subarray(345, 500)); }
    const rawPath = field(header.subarray(0, 100));
    const directory = type === 53;
    if (pendingPax?.size !== null && pendingPax?.size !== undefined && pendingPax.size !== size) fail();
    if (pendingPax?.type && pendingPax.type !== (directory ? "Directory" : "File")) fail();
    const path = pendingPax?.path ?? (prefix ? `${prefix}/${rawPath}` : rawPath);
    pendingPax = null;
    root ??= path.split("/")[0]; // npm also publishes legacy @types roots, e.g. node/.
    const { key, canonical } = pathKey(path, directory, root);
    if (directory) {
      if (size !== 0 || files.has(key)) fail();
      directories.add(key);
    } else {
      if (directories.has(key)) fail();
      const digest = createHash("sha256").update(bytes.subarray(offset, end)).digest("hex");
      const mode = octal(header.subarray(100, 108));
      const previous = files.get(key);
      if (previous) {
        // agent-base 7.1.4 publishes package/./dist/index.js followed by the
        // identical package/dist/index.js. Only exact same-case/same-mode/
        // same-byte aliases are harmless; differing overwrites are rejected.
        if (previous.canonical !== canonical || previous.digest !== digest || previous.mode !== mode) fail();
        identicalAliases++;
      }
      const parts = key.split("/");
      for (let i = 1; i < parts.length; i++) {
        const ancestor = parts.slice(0, i).join("/");
        if (files.has(ancestor)) fail();
        directories.add(ancestor);
      }
      files.set(key, { canonical, digest, mode }); fileBytes += size;
      if (files.size > maxFiles || fileBytes > maxBytes) fail();
    }
    offset = padded;
  }
  if (zero < 2 || pendingPax !== null || bytes.subarray(offset).some((b) => b !== 0) || files.size === 0) fail();
  return { fileCount: files.size, fileBytes, paxCount, identicalAliases };
}
