// Offline build input only. The CLI and worker accept one fixed FFmpeg source;
// neither downloads, extracts nor executes supplied content.
import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { APP, BUILD, directory, sha256 } from "./macos-build-common.mjs";
import { SOURCES } from "./check-macos-media-sources.mjs";

export const FFMPEG_SOURCE_INPUT = Object.freeze({ ...SOURCES.ffmpeg,
  filename: "ffmpeg-9.0.1.tar.xz", bytes: 12_036_420 });
export const STAGED_FFMPEG_SOURCE = join(BUILD, "source-input", FFMPEG_SOURCE_INPUT.filename);
const fail = kind => new Error(`macos-source-import-${kind}`);
const owns = meta => meta.uid === BigInt(process.geteuid()) && !(meta.mode & 0o022n);
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const stable = (a, b) => same(a, b) && a.size === b.size && a.mode === b.mode
  && a.uid === b.uid && a.gid === b.gid && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const validDescriptor = input => Number.isSafeInteger(input?.bytes) && input.bytes > 0
  && input.bytes <= 128 * 1024 * 1024 && /^[a-f0-9]{64}$/.test(input.sha256);

async function pinDirectories(path) {
  const absolute = resolve(path);
  if (absolute !== APP && !absolute.startsWith(`${APP}${sep}`)) throw fail("outside-worktree");
  const pins = [];
  try {
    let current = APP;
    for (const part of ["", ...relative(APP, absolute).split(sep).filter(Boolean)]) {
      if (part) current = join(current, part);
      const fd = await open(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      pins.push({ path: current, fd, identity: await fd.stat({ bigint: true }) });
      const meta = pins.at(-1).identity;
      if (!meta.isDirectory() || !owns(meta)) throw fail("directory-unsafe");
    }
    await assertDirectories(pins);
    return pins;
  } catch (error) { await closeDirectories(pins); throw error; }
}
async function closeDirectories(pins) { for (const pin of pins.reverse()) await pin.fd.close(); }
async function assertDirectories(pins) {
  for (const pin of pins) {
    const held = await pin.fd.stat({ bigint: true }), named = await lstat(pin.path, { bigint: true });
    if (!held.isDirectory() || !named.isDirectory() || named.isSymbolicLink()
        || !owns(held) || !owns(named) || !same(pin.identity, held) || !same(held, named))
      throw fail("directory-changed");
  }
}
async function assertFile(fd, path, identity, size) {
  const held = await fd.stat({ bigint: true }), named = await lstat(path, { bigint: true });
  for (const meta of [held, named]) {
    if (!meta.isFile() || meta.isSymbolicLink() || meta.nlink !== 1n || !owns(meta)
        || !same(meta, identity) || meta.size !== BigInt(size)) throw fail("object-changed");
  }
  if (!stable(held, identity) || !stable(named, held)) throw fail("object-changed");
}
async function verifiedBytes(fd, path, input, identity) {
  if (!identity.isFile() || identity.nlink !== 1n || !owns(identity)
      || identity.size !== BigInt(input.bytes)) throw fail("file-unsafe");
  const bytes = Buffer.alloc(input.bytes + 1);
  let length = 0;
  while (length < bytes.length) {
    const read = await fd.read(bytes, length, bytes.length - length, length);
    if (!read.bytesRead) break;
    length += read.bytesRead;
  }
  await assertFile(fd, path, identity, input.bytes);
  if (length !== input.bytes || sha256(bytes.subarray(0, length)) !== input.sha256) throw fail("bytes-invalid");
  return bytes.subarray(0, length);
}

// Stage only already-verified in-memory bytes. No paths or descriptors reach
// this function from the production CLI; parameters support synthetic tests.
export async function stagePinnedSource(input, bytes, suppliedPath = STAGED_FFMPEG_SOURCE) {
  if (!validDescriptor(input)) throw fail("descriptor-invalid");
  if (!Buffer.isBuffer(bytes) || bytes.length !== input.bytes || sha256(bytes) !== input.sha256)
    throw fail("bytes-invalid");
  const target = resolve(suppliedPath);
  await directory(dirname(target));
  const parents = await pinDirectories(dirname(target));
  let outputFd;
  try {
    await assertDirectories(parents);
    outputFd = await open(target, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const created = await outputFd.stat({ bigint: true });
    if (!created.isFile() || created.nlink !== 1n || !owns(created) || (created.mode & 0o777n) !== 0o600n)
      throw fail("output-unsafe");
    await outputFd.writeFile(bytes); await outputFd.sync();
    const written = await outputFd.stat({ bigint: true });
    if (!same(created, written)) throw fail("object-changed");
    await verifiedBytes(outputFd, target, input, written);
    await assertDirectories(parents);
    return { status: "staged-exact-source", sourceSha256: input.sha256, bytes: input.bytes };
  } finally {
    // Keep partial/conflicting objects. An object at this name grants no
    // authority to overwrite, change permissions or unlink a replacement.
    if (outputFd) await outputFd.close();
    await closeDirectories(parents);
  }
}

// The descriptor is supplied by trusted build code, never by a CLI/env/JSON
// override. Synthetic descriptors let offline tests exercise this production IO.
export async function importPinnedSource(input, suppliedPath, cacheDirectory = join(BUILD, "cache")) {
  if (!validDescriptor(input)) throw fail("descriptor-invalid");
  const source = resolve(suppliedPath), cache = resolve(cacheDirectory);
  const sourceParents = await pinDirectories(dirname(source));
  let inputFd, cacheParents = [], outputFd;
  try {
    inputFd = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const original = await inputFd.stat({ bigint: true });
    const bytes = await verifiedBytes(inputFd, source, input, original);
    await assertDirectories(sourceParents);
    await directory(cache);
    cacheParents = await pinDirectories(cache);
    const destination = join(cache, input.sha256);
    try {
      outputFd = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const reused = Boolean(outputFd);
    if (!outputFd) {
      await assertDirectories(sourceParents); await assertDirectories(cacheParents);
      await assertFile(inputFd, source, original, input.bytes);
      outputFd = await open(destination, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const created = await outputFd.stat({ bigint: true });
      if (!created.isFile() || created.nlink !== 1n || !owns(created) || (created.mode & 0o077n)) throw fail("output-unsafe");
      await outputFd.writeFile(bytes); await outputFd.sync();
      const written = await outputFd.stat({ bigint: true });
      if (!same(created, written)) throw fail("object-changed");
    }
    const published = await outputFd.stat({ bigint: true });
    await verifiedBytes(outputFd, destination, input, published);
    await assertFile(inputFd, source, original, input.bytes);
    await assertDirectories(sourceParents); await assertDirectories(cacheParents);
    return { status: reused ? "verified-existing-source" : "imported-exact-source",
      sourceSha256: input.sha256, bytes: input.bytes, pgp: "not-verified-by-importer" };
  } finally {
    // Keep all partial/conflicting objects. Never unlink or adopt a replacement.
    if (outputFd) await outputFd.close();
    if (inputFd) await inputFd.close();
    await closeDirectories(cacheParents); await closeDirectories(sourceParents);
  }
}

export async function importStagedMacosSource() {
  // A missing optional staging directory leaves the existing source gate in
  // charge. Any existing unsafe/conflicting input remains a hard failure.
  try { await lstat(STAGED_FFMPEG_SOURCE); }
  catch (error) { if (error.code === "ENOENT") return { status: "not-staged" }; throw error; }
  return importPinnedSource(FFMPEG_SOURCE_INPUT, STAGED_FFMPEG_SOURCE);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw fail("arguments-invalid");
    const result = await importStagedMacosSource();
    if (result.status === "not-staged") throw fail("input-missing");
    console.log(JSON.stringify(result));
  } catch { console.error("macos-source-import-failed"); process.exitCode = 1; }
}
