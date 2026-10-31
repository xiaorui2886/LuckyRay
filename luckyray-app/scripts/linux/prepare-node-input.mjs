// Stage an official Linux Node input. This does not create an LSH runtime seal.
// The checksum is published in Node.js' signed v22.19.0 release announcement.
import { createHash } from "node:crypto";
import { constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readSync, readdirSync, closeSync, chmodSync, copyFileSync, writeFileSync,
  unlinkSync, rmdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const NODE_VERSION = "22.19.0";
export const ARCHIVE_SHA256 = "d36e56998220085782c0ca965f9d51b7726335aed2f5fc7321c6c0ad233aa96d";
export const ARCHIVE_URL = "https://nodejs.org/dist/v22.19.0/node-v22.19.0-linux-x64.tar.gz";
const ROOT = "node-v22.19.0-linux-x64";
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_BINARY_BYTES = 256 * 1024 * 1024;
const MAX_LICENSE_BYTES = 4 * 1024 * 1024;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function verifyArchive(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_ARCHIVE_BYTES
      || sha256(bytes) !== ARCHIVE_SHA256) {
    throw new Error("linux-node-archive-hash-invalid");
  }
}

export function verifyElfHeader(bytes) {
  if (bytes.length < 20 || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      || bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1
      || ![2, 3].includes(bytes.readUInt16LE(16)) || bytes.readUInt16LE(18) !== 62) {
    throw new Error("linux-node-elf-invalid");
  }
}

function regularFile(file, limit) {
  const info = lstatSync(file);
  if (!info.isFile() || info.size === 0 || info.size > limit) {
    throw new Error("linux-node-stage-file-invalid");
  }
}

function readArchive(file) {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size === 0 || info.size > MAX_ARCHIVE_BYTES) {
      throw new Error("linux-node-archive-size-invalid");
    }
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error("linux-node-archive-read-failed");
      offset += count;
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function cleanupStage(stage) {
  for (const file of [path.join(stage, "bin", "node"), path.join(stage, "LICENSE")]) {
    try { unlinkSync(file); } catch {}
  }
  for (const directory of [path.join(stage, "bin"), stage]) {
    try { rmdirSync(directory); } catch {}
  }
}

export function prepareNodeInput(archive, output) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("linux-node-host-unsupported");
  }
  if (!path.isAbsolute(archive) || !path.isAbsolute(output)) {
    throw new Error("linux-node-path-not-absolute");
  }
  // Hash and extract the same in-memory bytes, so the archive cannot be swapped
  // between verification and extraction. Only these two fixed paths are read.
  const bytes = readArchive(archive);
  verifyArchive(bytes);
  const parent = path.dirname(output);
  const stage = mkdtempSync(path.join(parent, ".luckyray-node-input-"));
  try {
    const extracted = spawnSync("/usr/bin/tar", [
      "--extract", "--file=-", "--use-compress-program=/usr/bin/gzip",
      "--directory", stage, "--strip-components=1", "--no-same-owner",
      "--no-same-permissions", "--", ROOT + "/bin/node", ROOT + "/LICENSE",
    ], { input: bytes, encoding: "utf8", env: { LC_ALL: "C" }, timeout: 120000, maxBuffer: 1024 * 1024 });
    if (extracted.error || extracted.status !== 0) throw new Error("linux-node-extract-failed");
    const top = readdirSync(stage).sort();
    if (top.join("\0") !== ["LICENSE", "bin"].join("\0") || !lstatSync(path.join(stage, "bin")).isDirectory()
        || readdirSync(path.join(stage, "bin")).join("\0") !== "node") {
      throw new Error("linux-node-stage-layout-invalid");
    }
    const binary = path.join(stage, "bin", "node");
    const license = path.join(stage, "LICENSE");
    regularFile(binary, MAX_BINARY_BYTES);
    regularFile(license, MAX_LICENSE_BYTES);
    const descriptor = openSync(binary, "r");
    const header = Buffer.alloc(20);
    try {
      if (readSync(descriptor, header, 0, header.length, 0) !== header.length) {
        throw new Error("linux-node-elf-invalid");
      }
    } finally { closeSync(descriptor); }
    verifyElfHeader(header);
    const sourceBinaryHash = sha256(readFileSync(binary));
    const sourceLicenseHash = sha256(readFileSync(license));
    // Never overwrite an existing destination or use a PATH fallback.
    mkdirSync(output, { mode: 0o700 });
    const stagedNode = path.join(output, "node");
    const stagedLicense = path.join(output, "LICENSE");
    copyFileSync(binary, stagedNode, constants.COPYFILE_EXCL);
    copyFileSync(license, stagedLicense, constants.COPYFILE_EXCL);
    chmodSync(stagedNode, 0o755);
    chmodSync(stagedLicense, 0o644);
    if (sha256(readFileSync(stagedNode)) !== sourceBinaryHash
        || sha256(readFileSync(stagedLicense)) !== sourceLicenseHash) {
      throw new Error("linux-node-copy-hash-invalid");
    }
    const version = spawnSync(stagedNode, ["--version"], {
      encoding: "utf8", env: { LC_ALL: "C" }, timeout: 15000, maxBuffer: 4096,
    });
    if (version.error || version.status !== 0 || version.stdout.trim() !== "v" + NODE_VERSION) {
      throw new Error("linux-node-version-invalid");
    }
    const report = {
      kind: "verified-node-input-only",
      platform: "linux-x64-gnu",
      version: NODE_VERSION,
      archiveUrl: ARCHIVE_URL,
      archiveSha256: ARCHIVE_SHA256,
      binarySha256: sourceBinaryHash,
      licenseSha256: sourceLicenseHash,
      binaryBytes: lstatSync(stagedNode).size,
    };
    writeFileSync(path.join(output, "input-report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return report;
  } finally {
    cleanupStage(stage);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4) throw new Error("linux-node-arguments-invalid");
    console.log(JSON.stringify(prepareNodeInput(process.argv[2], process.argv[3])));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
