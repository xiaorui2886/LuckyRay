// Inspect pinned upstream source inputs; do not build, install, or create a
// media runtime. The license report is not a dependency-closure audit.
import { createHash } from "node:crypto";
import { constants, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export const SOURCES = Object.freeze({
  python: Object.freeze({
    version: "3.11.8",
    url: "https://www.python.org/ftp/python/3.11.8/Python-3.11.8.tar.xz",
    sha256: "9e06008c8901924395bc1da303eac567a729ae012baa182ab39269f650383bb3",
    licenses: ["Python-3.11.8/LICENSE"],
  }),
  ffmpeg: Object.freeze({
    version: "9.0.1",
    url: "https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz",
    sha256: "cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635",
    licenses: ["ffmpeg-9.0.1/LICENSE.md", "ffmpeg-9.0.1/COPYING.LGPLv2.1"],
  }),
});
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function verifySourceBytes(kind, bytes) {
  const source = SOURCES[kind];
  if (!source || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_ARCHIVE_BYTES || sha256(bytes) !== source.sha256) {
    throw new Error("macos-media-source-hash-invalid");
  }
}

export function validateSourceListing(kind, listing) {
  const source = SOURCES[kind];
  if (!source || typeof listing !== "string" || listing.length > 8 * 1024 * 1024 || listing.includes("\0")) {
    throw new Error("macos-media-source-list-invalid");
  }
  const lines = listing.split("\n").map(line => line.endsWith("\r") ? line.slice(0, -1) : line);
  if (source.licenses.some(member => lines.filter(line => line === member).length !== 1)) {
    throw new Error("macos-media-source-license-members-invalid");
  }
}

function readArchive(path) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || !constants.O_NOFOLLOW) throw new Error("macos-media-source-nofollow-unavailable");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_ARCHIVE_BYTES) throw new Error("macos-media-source-invalid");
    const bytes = Buffer.allocUnsafe(metadata.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) break;
      offset += count;
    }
    if (offset !== metadata.size) throw new Error("macos-media-source-changed");
    return bytes.subarray(0, offset);
  } finally { closeSync(fd); }
}

function tar(bytes, args, maxBuffer, encoding) {
  // Feed the verified bytes through stdin; selected members are emitted to
  // stdout, never extracted into a user or application directory.
  const result = spawnSync("/usr/bin/tar", args, {
    input: bytes, maxBuffer, timeout: 60_000, encoding, env: { LANG: "C", LC_ALL: "C" },
  });
  if (result.error || result.status !== 0) throw new Error("macos-media-source-extraction-failed");
  return result.stdout;
}

function inspect(kind, path) {
  const archive = readArchive(path);
  verifySourceBytes(kind, archive);
  validateSourceListing(kind, tar(archive, ["-tf", "-"], 8 * 1024 * 1024, "utf8"));
  const licenses = SOURCES[kind].licenses.map(member => {
    const bytes = tar(archive, ["-xOf", "-", member], 1024 * 1024, "buffer");
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error("macos-media-source-license-empty");
    return { member, bytes: bytes.length, sha256: sha256(bytes) };
  });
  return { version: SOURCES[kind].version, archiveSha256: SOURCES[kind].sha256, licenses };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("macos-arm64-native-inspection-required");
    if (process.argv.length !== 4) throw new Error("usage: node check-macos-media-sources.mjs <python-source.tar.xz> <ffmpeg-source.tar.xz>");
    console.log(JSON.stringify({ status: "source-input-only-not-qualified", nativeBuild: "not-run", licenseClosure: "not-audited",
      python: inspect("python", resolve(process.argv[2])), ffmpeg: inspect("ffmpeg", resolve(process.argv[3])) }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "macos-media-source-inspection-failed");
    process.exitCode = 1;
  }
}
