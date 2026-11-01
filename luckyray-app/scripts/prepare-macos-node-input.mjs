// Prepare only the official Darwin arm64 Node input for later qualification.
// This is not an LSH runtime, an identity record, or a release staging entry.
import { createHash } from "node:crypto";
import { constants, openSync, fstatSync, readSync, closeSync, mkdirSync, readFileSync, writeFileSync, fchmodSync, fsyncSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export const NODE_INPUT = Object.freeze({
  version: "22.19.0",
  archive: "node-v22.19.0-darwin-arm64.tar.gz",
  url: "https://nodejs.org/dist/v22.19.0/node-v22.19.0-darwin-arm64.tar.gz",
  sha256: "c59006db713c770d6ec63ae16cb3edc11f49ee093b5c415d667bb4f436c6526d",
  // LF bytes from the official v22.19.0 source tag; the Windows ZIP has CRLF.
  licenseSha256: "e991d81497a85bb24fc6bffae0a3637a6accd6c6bc5ce1f2c5698bd555cf9d49",
});

const ROOT = `node-v${NODE_INPUT.version}-darwin-arm64`;
const NODE_MEMBER = `${ROOT}/bin/node`;
const LICENSE_MEMBER = `${ROOT}/LICENSE`;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_NODE_BYTES = 160 * 1024 * 1024;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function verifyArchiveBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_ARCHIVE_BYTES ||
      sha256(bytes) !== NODE_INPUT.sha256) {
    throw new Error("macos-node-archive-hash-invalid");
  }
}

export function validateArchiveListing(listing) {
  if (typeof listing !== "string" || listing.length > 8 * 1024 * 1024 || listing.includes("\0")) {
    throw new Error("macos-node-archive-list-invalid");
  }
  const lines = listing.split("\n").map(line => line.endsWith("\r") ? line.slice(0, -1) : line);
  for (const member of [NODE_MEMBER, LICENSE_MEMBER]) {
    if (lines.filter(line => line === member).length !== 1) {
      throw new Error("macos-node-archive-members-invalid");
    }
  }
}

export function validateArm64Executable(bytes) {
  // Mach-O 64-bit little-endian, CPU_TYPE_ARM64, MH_EXECUTE. Reject fat,
  // Intel, DLL/dylib, truncated and Windows binaries; deeper load/signature
  // validation remains part of native package qualification.
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.length > MAX_NODE_BYTES ||
      bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x0100000c ||
      bytes.readUInt32LE(12) !== 2) {
    throw new Error("macos-node-architecture-invalid");
  }
}

function tar(bytes, args, limit, encoding) {
  // The verified archive bytes are passed on stdin, so replacing its original
  // file after hashing cannot change what the extractor reads. tar only writes
  // to stdout; it never receives an output directory or extracts arbitrary paths.
  const result = spawnSync("/usr/bin/tar", args, {
    input: bytes, maxBuffer: limit, timeout: 60_000, encoding,
    env: { LANG: "C", LC_ALL: "C" },
  });
  if (result.error || result.status !== 0) throw new Error("macos-node-extraction-failed");
  return result.stdout;
}

function readBoundedArchive(path) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
    throw new Error("macos-node-nofollow-unavailable");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_ARCHIVE_BYTES) {
      throw new Error("macos-node-archive-invalid");
    }
    // Read at most one byte beyond the observed size. A concurrent growth or
    // truncation is rejected, and the resulting immutable buffer is hashed
    // before it is ever passed to tar.
    const bytes = Buffer.allocUnsafe(metadata.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== metadata.size) throw new Error("macos-node-archive-changed");
    return bytes.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

function writeNewFile(path, bytes, mode) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    writeFileSync(fd, bytes);
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function prepare(archivePath) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("macos-arm64-native-preparation-required");
  }
  const archive = readBoundedArchive(archivePath);
  verifyArchiveBytes(archive);
  validateArchiveListing(tar(archive, ["-tzf", "-"], 8 * 1024 * 1024, "utf8"));
  const node = tar(archive, ["-xOzf", "-", NODE_MEMBER], MAX_NODE_BYTES, "buffer");
  const license = tar(archive, ["-xOzf", "-", LICENSE_MEMBER], 1024 * 1024, "buffer");
  validateArm64Executable(node);
  if (!Buffer.isBuffer(license) || sha256(license) !== NODE_INPUT.licenseSha256) {
    throw new Error("macos-node-license-invalid");
  }

  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const output = join(appRoot, "src-tauri", ".macos-node-input");
  // Refuse an existing path. Do not replace a developer's resources or use
  // the live LSH staging directory while the platform seal is unqualified.
  mkdirSync(output, { mode: 0o700 });
  const executable = join(output, "node");
  writeNewFile(executable, node, 0o755);
  writeNewFile(join(output, "LICENSE"), license, 0o644);
  if (sha256(readFileSync(executable)) !== sha256(node) ||
      sha256(readFileSync(join(output, "LICENSE"))) !== NODE_INPUT.licenseSha256) {
    throw new Error("macos-node-staged-bytes-invalid");
  }
  // A measured hash is useful for later review but is not an accepted runtime
  // authority and cannot make the LSH seal pass.
  return { status: "input-only-not-qualified", nativeProbe: "not-run", version: NODE_INPUT.version,
    archiveSha256: NODE_INPUT.sha256, nodeSha256: sha256(node), licenseSha256: sha256(license) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error("usage: node prepare-macos-node-input.mjs <official-archive>");
    console.log(JSON.stringify(prepare(resolve(process.argv[2]))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "macos-node-input-failed");
    process.exitCode = 1;
  }
}
