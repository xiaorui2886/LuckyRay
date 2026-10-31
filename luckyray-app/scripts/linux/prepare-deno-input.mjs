// Stage an official Linux Deno input, not a redistributable runtime or seal.
// Linux-specific third-party notices remain to be audited before packaging.
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  readSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyElfHeader } from "./prepare-node-input.mjs";

export const DENO_VERSION = "2.9.4";
export const ARCHIVE_BYTES = 43_834_754;
export const ARCHIVE_SHA256 = "c24f955d9fbfe0ea5ae2b501c8e71ae76e31e4c9782390a54a284b3364fda725";
export const ARCHIVE_URL = "https://github.com/denoland/deno/releases/download/v2.9.4/deno-x86_64-unknown-linux-gnu.zip";
export const LICENSE_SHA256 = "f62497fffecc0852960c8d3e6934b9db86d16396e9b604072e923892cae3a588";
export const LICENSE_URL = "https://github.com/denoland/deno/blob/v2.9.4/LICENSE.md";
const LICENSE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "deno-license-2.9.4.txt");
const MAX_BINARY_BYTES = 256 * 1024 * 1024;

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function verifyArchive(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== ARCHIVE_BYTES || sha256(bytes) !== ARCHIVE_SHA256) {
    throw new Error("linux-deno-archive-hash-invalid");
  }
}

export function verifyLicense(bytes) {
  if (!Buffer.isBuffer(bytes) || sha256(bytes) !== LICENSE_SHA256) {
    throw new Error("linux-deno-license-hash-invalid");
  }
}

function readArchive(file) {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size !== ARCHIVE_BYTES) throw new Error("linux-deno-archive-size-invalid");
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error("linux-deno-archive-read-failed");
      offset += count;
    }
    return bytes;
  } finally { closeSync(descriptor); }
}

// Python's standard library reads the already-verified in-memory archive.
// No archive pathname is extracted and no caller-provided executable is run.
const EXTRACT = String.raw`
import io, stat, sys, zipfile
limit = 256 * 1024 * 1024
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    entries = archive.infolist()
    if len(entries) != 1 or entries[0].filename != 'deno' or entries[0].is_dir():
        raise ValueError('unexpected archive layout')
    entry = entries[0]
    mode = entry.external_attr >> 16
    if stat.S_ISLNK(mode) or entry.file_size <= 0 or entry.file_size > limit:
        raise ValueError('invalid executable entry')
    with archive.open(entry) as source:
        binary = source.read(limit + 1)
    if len(binary) != entry.file_size:
        raise ValueError('invalid executable size')
    sys.stdout.buffer.write(binary)
`;

export function prepareDenoInput(archive, output) {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("linux-deno-host-unsupported");
  if (!path.isAbsolute(archive) || !path.isAbsolute(output)) throw new Error("linux-deno-path-not-absolute");
  const archiveBytes = readArchive(archive);
  verifyArchive(archiveBytes);
  const license = readFileSync(LICENSE_PATH);
  verifyLicense(license);
  const extracted = spawnSync("/usr/bin/python3", ["-I", "-c", EXTRACT], {
    input: archiveBytes, env: { LC_ALL: "C" }, timeout: 120000, maxBuffer: MAX_BINARY_BYTES + 1024 * 1024,
  });
  if (extracted.error || extracted.status !== 0 || !Buffer.isBuffer(extracted.stdout)
      || extracted.stdout.length === 0 || extracted.stdout.length > MAX_BINARY_BYTES) {
    throw new Error("linux-deno-extract-failed");
  }
  try { verifyElfHeader(extracted.stdout.subarray(0, 20)); }
  catch { throw new Error("linux-deno-elf-invalid"); }
  const binaryHash = sha256(extracted.stdout);
  // A fresh private directory and exclusive file creation prevent overwriting
  // existing files. On failure a partial input directory is left for inspection.
  mkdirSync(output, { mode: 0o700 });
  const binary = path.join(output, "deno");
  const licensePath = path.join(output, "LICENSE");
  writeFileSync(binary, extracted.stdout, { flag: "wx", mode: 0o700 });
  writeFileSync(licensePath, license, { flag: "wx", mode: 0o600 });
  chmodSync(binary, 0o755);
  chmodSync(licensePath, 0o644);
  if (!lstatSync(binary).isFile() || sha256(readFileSync(binary)) !== binaryHash
      || sha256(readFileSync(licensePath)) !== LICENSE_SHA256) {
    throw new Error("linux-deno-copy-hash-invalid");
  }
  const version = spawnSync(binary, ["--version"], {
    encoding: "utf8", env: { LC_ALL: "C" }, timeout: 15000, maxBuffer: 8192,
  });
  if (version.error || version.status !== 0 || !/^deno 2\.9\.4(?:\s|$)/.test(version.stdout)
      || !version.stdout.includes("x86_64-unknown-linux-gnu")) {
    throw new Error("linux-deno-version-invalid");
  }
  const report = {
    kind: "verified-deno-input-only-not-redistributable",
    platform: "linux-x64-gnu",
    version: DENO_VERSION,
    archiveUrl: ARCHIVE_URL,
    archiveSha256: ARCHIVE_SHA256,
    binarySha256: binaryHash,
    binaryBytes: extracted.stdout.length,
    licenseUrl: LICENSE_URL,
    licenseSha256: LICENSE_SHA256,
    thirdPartyNotices: "linux-inventory-not-yet-audited",
  };
  writeFileSync(path.join(output, "input-report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4) throw new Error("linux-deno-arguments-invalid");
    console.log(JSON.stringify(prepareDenoInput(process.argv[2], process.argv[3])));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
