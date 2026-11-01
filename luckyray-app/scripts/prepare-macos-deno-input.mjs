// Verify and stage the official Darwin arm64 Deno input for later review.
// It is not a qualified runtime, license closure, identity record, or bundle.
import { createHash } from "node:crypto";
import { constants, openSync, fstatSync, readSync, closeSync, mkdirSync, readFileSync, writeFileSync, fchmodSync, fsyncSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { validateArm64Executable } from "./prepare-macos-node-input.mjs";

export const DENO_INPUT = Object.freeze({
  version: "2.9.4",
  archive: "deno-aarch64-apple-darwin.zip",
  url: "https://github.com/denoland/deno/releases/download/v2.9.4/deno-aarch64-apple-darwin.zip",
  sha256: "6d17647fdbf9c587a581dba205054c4ccf732dae0a196cc1e9b44c07589db412",
  sourceCommit: "14eea3160ae5834476aa3b9d317b8d41d991b982",
  licenseSha256: "f62497fffecc0852960c8d3e6934b9db86d16396e9b604072e923892cae3a588",
});
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_DENO_BYTES = 160 * 1024 * 1024;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function verifyDenoArchive(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_ARCHIVE_BYTES || sha256(bytes) !== DENO_INPUT.sha256) {
    throw new Error("macos-deno-archive-hash-invalid");
  }
}

export function validateDenoListing(listing) {
  if (typeof listing !== "string" || listing.length > 4096 || listing.includes("\0")) throw new Error("macos-deno-list-invalid");
  const names = listing.split("\n").map(line => line.endsWith("\r") ? line.slice(0, -1) : line).filter(Boolean);
  if (names.length !== 1 || names[0] !== "deno") throw new Error("macos-deno-members-invalid");
}

function readArchive(path) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || !constants.O_NOFOLLOW) throw new Error("macos-deno-nofollow-unavailable");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_ARCHIVE_BYTES) throw new Error("macos-deno-archive-invalid");
    const bytes = Buffer.allocUnsafe(metadata.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) break;
      offset += count;
    }
    if (offset !== metadata.size) throw new Error("macos-deno-archive-changed");
    return bytes.subarray(0, offset);
  } finally { closeSync(fd); }
}

function extract(bytes, args, maxBuffer, encoding) {
  // bsdtar accepts ZIP on stdin and writes only a selected member to stdout;
  // it never extracts archive-controlled paths into a filesystem directory.
  const result = spawnSync("/usr/bin/tar", args, {
    input: bytes, maxBuffer, timeout: 60_000, encoding, env: { LANG: "C", LC_ALL: "C" },
  });
  if (result.error || result.status !== 0) throw new Error("macos-deno-extraction-failed");
  return result.stdout;
}

function writeNew(path, bytes, mode) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { writeFileSync(fd, bytes); fchmodSync(fd, mode); fsyncSync(fd); } finally { closeSync(fd); }
}

function prepare(archivePath) {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("macos-arm64-native-preparation-required");
  const archive = readArchive(archivePath);
  verifyDenoArchive(archive);
  validateDenoListing(extract(archive, ["-tf", "-"], 4096, "utf8"));
  const deno = extract(archive, ["-xOf", "-", "deno"], MAX_DENO_BYTES, "buffer");
  try { validateArm64Executable(deno); } catch { throw new Error("macos-deno-architecture-invalid"); }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  // The public repository already records this exact Deno upstream license.
  // Its Windows-target closure index is NOT a macOS closure or a license audit.
  const license = readFileSync(join(root, "third-party-notices", "deno-2.9.4", "bodies", `${DENO_INPUT.licenseSha256}.txt`));
  if (sha256(license) !== DENO_INPUT.licenseSha256) throw new Error("macos-deno-license-invalid");
  const output = join(root, "src-tauri", ".macos-deno-input");
  mkdirSync(output, { mode: 0o700 });
  const executable = join(output, "deno");
  writeNew(executable, deno, 0o755);
  writeNew(join(output, "LICENSE.md"), license, 0o644);
  if (sha256(readFileSync(executable)) !== sha256(deno) || sha256(readFileSync(join(output, "LICENSE.md"))) !== DENO_INPUT.licenseSha256) {
    throw new Error("macos-deno-staged-bytes-invalid");
  }
  return { status: "input-only-not-qualified", nativeProbe: "not-run", version: DENO_INPUT.version,
    archiveSha256: DENO_INPUT.sha256, denoSha256: sha256(deno), licenseSha256: DENO_INPUT.licenseSha256 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error("usage: node prepare-macos-deno-input.mjs <official-archive>");
    console.log(JSON.stringify(prepare(resolve(process.argv[2]))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "macos-deno-input-failed");
    process.exitCode = 1;
  }
}
