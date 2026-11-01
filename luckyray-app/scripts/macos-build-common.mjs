// macOS build-time utilities. Generated inputs stay in this public worktree;
// no installer, system service or account authorization is invoked.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, mkdir, lstat, readdir, realpath, rename } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { commandEvent, DiagnosticCollector, safeDiagnosticSummary } from "./macos-native-diagnostics.mjs";

export const APP = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
export const TAURI = join(APP, "src-tauri");
export const BUILD = join(TAURI, ".macos-build");
export const TARGET = "aarch64-apple-darwin";
export const SIDECARS = Object.freeze(["luckyray-native-host", "luckyray-cli", "luckyray-mcp"]);
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function requireNative() {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("macos-arm64-build-required");
}
export async function directory(path) {
  const absolute = resolve(path);
  if (absolute !== APP && !absolute.startsWith(`${APP}${sep}`)) throw new Error("macos-build-output-outside-worktree");
  let current = APP;
  for (const part of relative(APP, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const meta = await lstat(current);
    if (!meta.isDirectory() || meta.isSymbolicLink() || meta.uid !== process.geteuid() || (meta.mode & 0o022)) {
      throw new Error("macos-build-directory-unsafe");
    }
  }
  return absolute;
}
export async function readRegular(path, limit = 512 * 1024 * 1024) {
  const absolute = resolve(path);
  if (!absolute.startsWith(`${APP}${sep}`)) throw new Error("macos-build-input-outside-worktree");
  const parents = [];
  let current = APP;
  for (const part of relative(APP, dirname(absolute)).split(sep).filter(Boolean)) {
    current = join(current, part);
    const meta = await lstat(current);
    if (!meta.isDirectory() || meta.isSymbolicLink()) throw new Error("macos-build-linked-input-parent");
    parents.push({ path: current, dev: meta.dev, ino: meta.ino });
  }
  const fd = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw new Error("macos-build-input-invalid");
    const bytes = await fd.readFile();
    const after = await fd.stat();
    if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs) throw new Error("macos-build-input-changed");
    const named = await lstat(absolute);
    if (!named.isFile() || named.isSymbolicLink() || named.dev !== after.dev || named.ino !== after.ino)
      throw new Error("macos-build-input-object-changed");
    for (const parent of parents) {
      const meta = await lstat(parent.path);
      if (!meta.isDirectory() || meta.isSymbolicLink() || meta.dev !== parent.dev || meta.ino !== parent.ino)
        throw new Error("macos-build-input-parent-changed");
    }
    return bytes;
  } finally { await fd.close(); }
}
export async function writeNew(path, bytes, mode = 0o644) {
  const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await fd.writeFile(bytes); await fd.chmod(mode); await fd.sync(); } finally { await fd.close(); }
}
export async function jsonNew(path, value) { await writeNew(path, `${JSON.stringify(value, null, 2)}\n`); }
export async function stage(label) {
  await directory(BUILD);
  const path = join(BUILD, `${label}-${randomUUID()}`);
  await mkdir(path, { mode: 0o700 });
  return path;
}
export function isolatedEnvironment(home, extra = {}) {
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"), LANG: "C", LC_ALL: "C", ...extra };
  for (const name of ["NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONHOME", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH"])
    delete env[name];
  return env;
}
export function releaseEnvironment(extra = {}) {
  const userRoot = process.env.HOME;
  const fixed = [`--remap-path-prefix=${APP}=.`];
  if (userRoot && userRoot !== "/") fixed.push(`--remap-path-prefix=${userRoot}=.`);
  const raw = process.env.CARGO_ENCODED_RUSTFLAGS?.split("\x1f") ?? [];
  const flags = [];
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] === "-C" && raw[index + 1]?.startsWith("strip=")) { index++; continue; }
    if (raw[index].startsWith("-Cstrip=") || fixed.includes(raw[index])) continue;
    flags.push(raw[index]);
  }
  flags.push("-C", "strip=symbols", ...fixed);
  const cQuote = value => `'${value.replaceAll("'", "'\"'\"'")}'`;
  const hygiene = `-DNDEBUG ${cQuote(`-ffile-prefix-map=${APP}=.`)}${userRoot && userRoot !== "/" ? ` ${cQuote(`-ffile-prefix-map=${userRoot}=.`)}` : ""}`;
  const priorCflags = (process.env.CFLAGS ?? "").trimEnd();
  return { ...process.env, CARGO_TARGET_DIR: join(TAURI, "target"),
    CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f"),
    CFLAGS: priorCflags.endsWith(hygiene) ? priorCflags : `${priorCflags} ${hygiene}`.trimStart(),
    ...extra };
}
export async function run(command, args, options = {}) {
  const { capture = false, diagnosticStage = "command", diagnosticInput, ...rest } = options;
  const started = Date.now();
  const startedId = commandEvent("start", diagnosticStage, command,
    typeof diagnosticInput === "string" && /^[a-f0-9]{64}$/.test(diagnosticInput) ? { inputSha256: diagnosticInput } : {});
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: APP, stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", ...rest });
    let text = "";
    let spawnFailed = false;
    if (capture) child.stdout.on("data", chunk => {
      text += chunk;
      if (text.length > 8 * 1024 * 1024) child.kill("SIGTERM");
    });
    child.once("error", error => {
      spawnFailed = true;
      if (startedId) commandEvent("exit", diagnosticStage, command, { startedId, exit: "SPAWN_ERROR", ioCode: error.code, elapsedMs: Date.now() - started });
      reject(error);
    });
    child.once("close", async (code, signal) => {
      if (spawnFailed) return;
      if (startedId && code !== 0 && ["python-configure", "ffmpeg-configure", "openssl-configure"].includes(diagnosticStage)) {
        try {
          const name = diagnosticStage === "ffmpeg-configure" ? "ffbuild/config.log" : "config.log";
          const bytes = await readRegular(join(rest.cwd ?? APP, name), 2 * 1024 * 1024);
          const details = new DiagnosticCollector(new Set(), new Set(), "configure-probe-log"); details.feed("stderr", bytes);
          commandEvent("issues", diagnosticStage, command, { issues: safeDiagnosticSummary(details.summary()).issues });
        } catch {
          commandEvent("issues", diagnosticStage, command, { issues: [{ class: "configure-log-unavailable" }] });
        }
      }
      if (startedId) commandEvent("exit", diagnosticStage, command, { startedId, exit: code ?? signal, elapsedMs: Date.now() - started });
      code === 0 ? resolveRun(text) : reject(new Error(`macos-build-command-failed:${command}:${code ?? signal}`));
    });
  });
}
export async function download(input) {
  await directory(join(BUILD, "cache"));
  if (!/^https:\/\//.test(input.url) || !/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error("macos-build-source-unpinned");
  const output = join(BUILD, "cache", input.sha256);
  try {
    const cached = await readRegular(output);
    if (sha256(cached) !== input.sha256) throw new Error("macos-build-cache-conflict");
    return output;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = `${output}.${randomUUID()}.download`;
  const fd = await open(temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let verifiedBytes;
  try {
    const original = await fd.stat();
    // Curl writes the already-owned descriptor, never reopens an output path.
    const httpDiagnostic = process.env.MACOS_INTERNAL_DIAGNOSTICS === "1"
      ? ["--write-out", "%{stderr}MACOS_HTTP_STATUS:%{http_code}\n"] : [];
    await run("/usr/bin/curl", ["--fail", "--location", "--silent", "--show-error", "--proto", "=https", "--tlsv1.2", "--max-filesize", "536870912", ...httpDiagnostic, input.url],
      { stdio: ["ignore", fd.fd, "inherit"], diagnosticStage: "source-download", diagnosticInput: input.sha256 });
    await fd.sync();
    const named = await lstat(temporary);
    if (!named.isFile() || named.dev !== original.dev || named.ino !== original.ino || named.nlink !== 1)
      throw new Error("macos-build-download-object-changed");
    const bytes = await readRegular(temporary);
    if (sha256(bytes) !== input.sha256) throw new Error("macos-build-download-hash-invalid");
    verifiedBytes = bytes;
  } finally { await fd.close(); }
  // O_EXCL publishes only verified bytes without a check/rename overwrite
  // window. Preserve the temporary version rather than unlink an unknown path.
  await writeNew(output, verifiedBytes, 0o600);
  return output;
}
export function tarMember(archiveBytes, member, limit = 192 * 1024 * 1024) {
  const result = spawnSync("/usr/bin/tar", ["-xOf", "-", member], { input: archiveBytes, maxBuffer: limit, timeout: 60_000 });
  if (result.error || result.status !== 0) throw new Error("macos-build-archive-member-invalid");
  return result.stdout;
}
export function tarListing(archiveBytes) {
  const result = spawnSync("/usr/bin/tar", ["-tf", "-"], { input: archiveBytes, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", timeout: 60_000 });
  if (result.error || result.status !== 0) throw new Error("macos-build-archive-list-invalid");
  return result.stdout;
}
export async function extractSource(archive, expectedSha, destination) {
  // Extract regular source files ourselves. No archive-controlled links,
  // device nodes, duplicate files or parent traversal reach the build stage.
  const code = String.raw`import hashlib, os, pathlib, sys, tarfile
src, digest, output = sys.argv[1:]
fd = os.open(src, os.O_RDONLY | os.O_NOFOLLOW)
with os.fdopen(fd, 'rb') as source:
 before = os.fstat(source.fileno())
 assert hashlib.file_digest(source, 'sha256').hexdigest() == digest
 source.seek(0)
 with tarfile.open(fileobj=source, mode='r:*') as archive:
  for member in archive:
   path = pathlib.PurePosixPath(member.name)
   assert not path.is_absolute() and '..' not in path.parts
   target = pathlib.Path(output).joinpath(*path.parts)
   if member.isdir():
    target.mkdir(parents=True, exist_ok=True)
   else:
    assert member.isfile()
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open('xb') as created, archive.extractfile(member) as data:
     while block := data.read(65536): created.write(block)
    target.chmod(0o755 if member.mode & 0o111 else 0o644)
 source.seek(0)
 assert hashlib.file_digest(source, 'sha256').hexdigest() == digest
 after = os.fstat(source.fileno())
 assert (before.st_size, before.st_mtime_ns, before.st_ctime_ns) == (after.st_size, after.st_mtime_ns, after.st_ctime_ns)
`;
  await run("python3", ["-I", "-B", "-c", code, archive, expectedSha, destination], { diagnosticStage: "source-extract", diagnosticInput: expectedSha });
}
export async function inventory(root) {
  const files = [];
  async function walk(path) {
    for (const name of (await readdir(path)).sort()) {
      const absolute = join(path, name); const meta = await lstat(absolute);
      if (meta.isSymbolicLink()) throw new Error("macos-build-linked-output");
      if (meta.isDirectory()) await walk(absolute);
      else {
        if (!meta.isFile() || meta.nlink !== 1 || (meta.mode & 0o022)) throw new Error("macos-build-output-unsafe");
        files.push({ path: relative(root, absolute).split(sep).join("/"), size: meta.size, sha256: sha256(await readRegular(absolute)) });
        if (files.length > 40_000) throw new Error("macos-build-output-capacity");
      }
    }
  }
  await walk(root); return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export async function publishDirectory(source, name) {
  if (!["dsh", "media-engine"].includes(name)) throw new Error("macos-build-output-invalid");
  await inventory(source);
  const destination = join(TAURI, name);
  let existing = false;
  try {
    const meta = await lstat(destination);
    if (!meta.isDirectory() || meta.isSymbolicLink() || meta.uid !== process.geteuid() || (meta.mode & 0o022))
      throw new Error("macos-build-existing-output-unsafe");
    existing = true;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing) {
    const prior = JSON.parse((await readRegular(join(destination, "macos-build.json"), 1024 * 1024)).toString());
    if (prior.platform !== "darwin" || prior.architecture !== "arm64") throw new Error("macos-build-existing-platform-conflict");
    await rename(destination, `${destination}.macos-backup-${randomUUID()}`);
  }
  await rename(source, destination);
  return destination;
}
export async function requireMachO(path) {
  const bytes = await readRegular(path);
  if (bytes.length < 32 || ![0xfeedfacf, 0xbebafeca, 0xcafebabe].includes(bytes.readUInt32LE(0))) throw new Error("macos-build-not-macho");
  await run("/usr/bin/lipo", [path, "-verify_arch", "arm64"], { diagnosticStage: "arm64-check" });
}
