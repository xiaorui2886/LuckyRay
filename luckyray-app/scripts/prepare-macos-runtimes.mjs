import { cpus } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, readdir, lstat } from "node:fs/promises";
import { APP, TAURI, BUILD, sha256, directory, stage, readRegular, writeNew, jsonNew,
  run, isolatedEnvironment, download, tarMember, tarListing, extractSource, inventory,
  publishDirectory, requireNative, requireMachO } from "./macos-build-common.mjs";
import { NODE_INPUT, verifyArchiveBytes, validateArchiveListing, validateArm64Executable } from "./prepare-macos-node-input.mjs";
import { DENO_INPUT, verifyDenoArchive, validateDenoListing } from "./prepare-macos-deno-input.mjs";
import { SOURCES } from "./check-macos-media-sources.mjs";
import { extractVerifiedPnpmPackage, validateDshFrozenClosure, projectPortableDshReleaseLayout,
  auditPortableInstalledClosure, reconcileLockedClosure } from "./dsh-supply-chain.mjs";
import { prepareDshDistribution, checkFrozenDshMinimum } from "./macos-dsh-distribution.mjs";
import { commandEvent, PYTHON_PROBE_IMPORTS } from "./macos-native-diagnostics.mjs";

// The archive digest is the upstream release asset digest, not a digest of its
// checksum text: https://github.com/openssl/openssl/releases/tag/openssl-3.5.9
export const OPENSSL = Object.freeze({ version: "3.5.9",
  url: "https://github.com/openssl/openssl/releases/download/openssl-3.5.9/openssl-3.5.9.tar.gz",
  sha256: "603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a" });
export const LIBLZMA = Object.freeze({ version: "5.8.4",
  url: "https://github.com/tukaani-project/xz/releases/download/v5.8.4/xz-5.8.4.tar.gz",
  sha256: "0014c7886930454fe8bd4228665b51af55eeae560ea135c9c4cd33f55b2591d9",
  license: "0BSD", licenses: Object.freeze({
    COPYING: "616a3ad264ce29b8f1cb97e53037b139d406899ca8d1f799651e17bfa09830b8",
    "COPYING.0BSD": "0b01625d853911cd0e2e088dcfb743261034a091bb379246cb25a14cc4c74bf1",
  }) });
export const INPUTS = Object.freeze({ platform: "darwin", architecture: "arm64", node: NODE_INPUT,
  deno: DENO_INPUT, python: SOURCES.python, ffmpeg: SOURCES.ffmpeg, openssl: OPENSSL, liblzma: LIBLZMA });
const JOBS = String(Math.max(1, Math.min(cpus().length, 6)));
const copy = async (from, to, mode = 0o644) => writeNew(to, await readRegular(from), mode);

// Build only the library needed by CPython's required lzma import. The native
// media builder verifies the archive architecture before linking it into Python.
export async function buildStaticLzma(scratch, env) {
  const archive = await download(LIBLZMA);
  const output = join(scratch, "xz-source"); await mkdir(output);
  // Keep verified release timestamps so Autotools uses its shipped generated files.
  await extractSource(archive, LIBLZMA.sha256, output, true);
  const source = join(output, `xz-${LIBLZMA.version}`); const prefix = join(scratch, "xz-static");
  for (const [file, expected] of Object.entries(LIBLZMA.licenses))
    if (sha256(await readRegular(join(source, file))) !== expected) throw new Error("macos-liblzma-license-invalid");
  const buildEnv = { ...env, CFLAGS: `-O2 -ffile-prefix-map=${scratch}=.`, LDFLAGS: "" };
  await run(join(source, "configure"), [`--prefix=${prefix}`, `--libdir=${join(prefix, "lib")}`,
    "--disable-shared", "--enable-static", "--with-pic", "--disable-doc", "--disable-nls"],
  { cwd: source, env: buildEnv, diagnosticStage: "liblzma-configure" });
  const target = join(source, "src/liblzma");
  await run("/usr/bin/make", [`-j${JOBS}`, "-C", target], { cwd: source, env: buildEnv, diagnosticStage: "liblzma-build" });
  await run("/usr/bin/make", ["-C", target, "install"], { cwd: source, env: buildEnv, diagnosticStage: "liblzma-install" });
  const library = join(prefix, "lib/liblzma.a");
  if (!(await readRegular(library)).subarray(0, 8).equals(Buffer.from("!<arch>\n"))) throw new Error("macos-liblzma-static-archive-invalid");
  return { archive, source, prefix, library };
}

export const PYTHON_RUNTIME_PROBE = String.raw`import sys
results = []
failed = []
for name in ${JSON.stringify(PYTHON_PROBE_IMPORTS)}:
 try:
  __import__(name)
 except Exception:
  results.append('0')
  failed.append(name)
 else:
  results.append('1')
if sys.argv[2] == '1': print('MACOS_PYTHON_PROBE_IMPORTS:' + ''.join(results), file=sys.stderr)
checks = [(sys.version_info[:3] == (3,11,8), 'macos-python-version-probe'),
          (sys.prefix == sys.argv[1], 'macos-python-prefix-probe'),
          ('ssl' not in failed and sys.modules['ssl'].OPENSSL_VERSION.startswith('OpenSSL 3.5.9 '), 'macos-python-ssl-probe')]
for valid, code in checks:
 if not valid:
  failed.append(code)
  if sys.argv[2] == '1': print(code, file=sys.stderr)
if failed: raise SystemExit(1)
`;

export async function normalizeFfmpegCflags(value = "") {
  if (typeof value !== "string" || value.length > 65536 || value.includes("\0"))
    throw new Error("macos-ffmpeg-cflags-invalid");
  // Cargo/Perl consume shell-quoted flags. FFmpeg's test_cc expands $CFLAGS
  // directly; literal quoting would become part of the compiler arguments.
  // shlex parses words without executing substitutions or environment values.
  const words = JSON.parse(await run("python3", ["-I", "-B", "-c",
    "import json,shlex,sys; print(json.dumps(shlex.split(sys.argv[1], posix=True)))", value],
  { capture: true, diagnosticStage: "ffmpeg-flags" }));
  if (!Array.isArray(words) || words.length > 512 || words.some(word => typeof word !== "string" || !word || /\s|\0/.test(word)))
    throw new Error("macos-ffmpeg-cflags-unrepresentable");
  return words.join(" ");
}

async function packageRoots(nodeModules, result = []) {
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("macos-dsh-package-path-invalid");
    const path = join(nodeModules, entry.name);
    if (entry.name.startsWith("@")) await packageRoots(path, result);
    else {
      const manifest = JSON.parse((await readRegular(join(path, "package.json"), 1024 * 1024)).toString());
      result.push({ path, name: manifest.name, version: manifest.version });
      try { if ((await lstat(join(path, "node_modules"))).isDirectory()) await packageRoots(join(path, "node_modules"), result); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  return result;
}

async function nodeInput(scratch) {
  const archive = await readRegular(await download(NODE_INPUT));
  verifyArchiveBytes(archive); validateArchiveListing(tarListing(archive));
  const root = `node-v${NODE_INPUT.version}-darwin-arm64`;
  const binary = tarMember(archive, `${root}/bin/node`);
  const license = tarMember(archive, `${root}/LICENSE`, 4 * 1024 * 1024);
  validateArm64Executable(binary);
  if (sha256(license) !== NODE_INPUT.licenseSha256) throw new Error("macos-node-license-invalid");
  const node = join(scratch, "node"); await mkdir(node, { mode: 0o700 });
  await writeNew(join(node, "node"), binary, 0o755); await writeNew(join(node, "LICENSE"), license);
  return join(node, "node");
}

async function prepareDsh(scratch, node, home) {
  const authorityPath = join(APP, "dsh-host/runtime-authority.json");
  const authority = JSON.parse((await readRegular(authorityPath, 1024 * 1024)).toString());
  const hostPackage = await readRegular(join(APP, "dsh-host/package.json"));
  const lockfile = await readRegular(join(APP, "dsh-host/pnpm-lock.yaml"));
  const npmrc = await readRegular(join(APP, "dsh-host/.npmrc"));
  const workspacePolicy = await readRegular(join(APP, "dsh-host/pnpm-workspace.yaml"));
  validateDshFrozenClosure({ authority, hostPackage: JSON.parse(hostPackage.toString()), lockfile, npmrc: npmrc.toString(), workspacePolicy });
  const pnpmArchive = await download({ url: authority.packageManager.tarball, sha256: authority.packageManager.sha256 });
  const bootstrap = join(scratch, "pnpm");
  await extractVerifiedPnpmPackage({ authorityPath, pnpmTarballPath: pnpmArchive, outputRoot: bootstrap });
  const pnpm = join(bootstrap, "package/bin/pnpm.mjs");
  const dsh = join(scratch, "dsh"); const host = join(dsh, "host");
  const fetchHost = join(scratch, "dsh-fetch");
  // Fetch creates an isolated virtual store in its cwd. Keep that store out
  // of the clean hoisted product tree, as the existing Windows builder does.
  for (const root of [host, fetchHost]) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeNew(join(root, "package.json"), hostPackage); await writeNew(join(root, "pnpm-lock.yaml"), lockfile);
    await writeNew(join(root, ".npmrc"), npmrc); await writeNew(join(root, "pnpm-workspace.yaml"), workspacePolicy);
  }
  const emptyConfig = join(home, "empty.npmrc"); await writeNew(emptyConfig, "");
  const env = isolatedEnvironment(home, { PATH: `${resolve(node, "..")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    NPM_CONFIG_USERCONFIG: emptyConfig, NPM_CONFIG_GLOBALCONFIG: emptyConfig,
    npm_config_userconfig: emptyConfig, npm_config_globalconfig: emptyConfig });
  const store = await directory(join(BUILD, "pnpm-store"));
  const flags = ["--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile", "--prod", "--strict-peer-dependencies=true", "--verify-store-integrity=true", "--store-dir", store];
  await run(node, [pnpm, "fetch", ...flags], { cwd: fetchHost, env, diagnosticStage: "dsh-fetch" });
  // pnpm otherwise prefers POSIX .bin symlinks. Request its normal portable
  // shims without absolute NODE_PATH; retain the strict no-link projection.
  await run(node, [pnpm, "install", ...flags, "--offline", "--node-linker=hoisted", "--package-import-method=copy",
    "--config.prefer-symlinked-executables=false", "--config.extend-node-path=false"], { cwd: host, env, diagnosticStage: "dsh-install" });
  // The existing projection removes only pinned development metadata and
  // generated install paths. It must succeed; there is no symlink fallback.
  commandEvent("checkpoint", "dsh-project", "node");
  await projectPortableDshReleaseLayout({ stageRoot: dsh });
  const roots = await packageRoots(join(host, "node_modules"));
  const count = new Set(roots.map(item => `${item.name}@${item.version}`)).size;
  commandEvent("checkpoint", "dsh-audit", "node");
  const audit = await auditPortableInstalledClosure({ nodeModulesRoot: join(host, "node_modules"), expectedPackageCount: count,
    entryPoint: "@deepseek-ai/dsh/lib/bin.js", platform: "darwin", architecture: "arm64" });
  const reconciliation = reconcileLockedClosure({ lockfile, stagedPackages: audit.packages, platform: "darwin", architecture: "arm64" });
  const macos = JSON.parse((await readRegular(join(TAURI, "tauri.macos.conf.json"))).toString());
  const minimumSystem = await checkFrozenDshMinimum({ packageRoots: roots, appMinimum: macos.bundle.macOS.minimumSystemVersion });
  const modules = ["koffi", "node-pty", "sharp", "node-addon-require-builtin"];
  const nativeRoots = modules.map(name => {
    const matches = roots.filter(item => item.name === name);
    if (matches.length !== 1) throw new Error("macos-dsh-native-module-ambiguous");
    return matches[0].path;
  });
  await run(node, ["--input-type=module", "-e",
    "import {createRequire} from 'node:module'; import {pathToFileURL} from 'node:url'; const names=JSON.parse(process.argv[1]); const trace=process.env.MACOS_INTERNAL_DIAGNOSTICS==='1'; for(const [i,p] of process.argv.slice(2).entries()){if(trace)console.error('MACOS_NATIVE_MODULE_START:'+names[i]); createRequire(pathToFileURL(p+'/package.json'))(p); if(trace)console.error('MACOS_NATIVE_MODULE_PASS:'+names[i]);}", JSON.stringify(modules), ...nativeRoots], { cwd: host, env, diagnosticStage: "dsh-native-load" });
  const version = (await run(node, [join(host, "node_modules/@deepseek-ai/dsh/lib/bin.js"), "--version"], { cwd: host, env, capture: true, diagnosticStage: "dsh-version" })).trim();
  if (version !== authority.runtimePackage.version) throw new Error("macos-dsh-version-invalid");
  await mkdir(join(dsh, "node")); await copy(node, join(dsh, "node/node"), 0o755);
  await copy(join(node, "../LICENSE"), join(dsh, "node/LICENSE"));
  commandEvent("checkpoint", "dsh-materials", "node");
  const distribution = await prepareDshDistribution({ dshRoot: dsh, audit, packageRoots: roots,
    nodeLicense: await readRegular(join(node, "../LICENSE")) });
  await jsonNew(join(dsh, "macos-build.json"), { schemaVersion: 1, platform: "darwin", architecture: "arm64",
    node: NODE_INPUT, runtimePackage: authority.runtimePackage, lockfileSha256: sha256(lockfile),
    nativeModuleLoadProbe: { status: "passed", modules }, versionProbe: version, audit, reconciliation, distribution, minimumSystem,
    files: await inventory(dsh) });
  return publishDirectory(dsh, "dsh");
}

async function prepareMedia(scratch, node, home) {
  const media = join(scratch, "media"); await mkdir(media, { mode: 0o700 });
  for (const name of ["licenses", "sources", "wheels", "deno", "ffmpeg", "python/bin", "python/lib/python3.11/lib-dynload"])
    await mkdir(join(media, name), { recursive: true, mode: 0o755 });
  const env = isolatedEnvironment(home, { PKG_CONFIG: "/usr/bin/false" });
  const archives = {};
  for (const [name, input] of Object.entries({ openssl: OPENSSL, python: SOURCES.python, ffmpeg: SOURCES.ffmpeg })) {
    const archive = await download(input); archives[name] = archive;
    const output = join(scratch, `${name}-source`); await mkdir(output);
    await extractSource(archive, input.sha256, output);
  }
  const ssl = join(scratch, "openssl-source", `openssl-${OPENSSL.version}`);
  const sslPrefix = join(scratch, "openssl-static");
  await run("/usr/bin/perl", [join(ssl, "Configure"), "darwin64-arm64-cc", "no-shared", "no-module", "no-tests", `--prefix=${sslPrefix}`, "--openssldir=/etc/ssl", "--libdir=lib"], { cwd: ssl, env, diagnosticStage: "openssl-configure" });
  await run("/usr/bin/make", [`-j${JOBS}`], { cwd: ssl, env, diagnosticStage: "openssl-build" });
  await run("/usr/bin/make", ["install_sw"], { cwd: ssl, env, diagnosticStage: "openssl-install" });
  await copy(join(ssl, "LICENSE.txt"), join(media, "licenses/OpenSSL-LICENSE.txt"));
  const liblzma = await buildStaticLzma(scratch, env);
  await run("/usr/bin/lipo", [liblzma.library, "-verify_arch", "arm64"], { diagnosticStage: "arm64-check" });
  for (const file of Object.keys(LIBLZMA.licenses)) await copy(join(liblzma.source, file), join(media, "licenses", `XZ-${file}`));
  await copy(liblzma.archive, join(media, "sources", `xz-${LIBLZMA.version}.tar.gz`));
  await jsonNew(join(media, "sources/liblzma-build.json"), { source: LIBLZMA, target: "src/liblzma",
    configure: ["--disable-shared", "--enable-static", "--with-pic", "--disable-doc", "--disable-nls"],
    pythonLink: "explicit static archive via LIBLZMA_LIBS", commandLineTools: "not-built-or-installed" });
  const python = join(scratch, "python-source", `Python-${SOURCES.python.version}`);
  const pythonInstall = join(scratch, "python-install");
  const pythonEnv = { ...env, CFLAGS: `-O2 -ffile-prefix-map=${scratch}=.`, LDFLAGS: "",
    LIBLZMA_CFLAGS: `-I${join(liblzma.prefix, "include")}`, LIBLZMA_LIBS: liblzma.library,
    ac_cv_header_readline_readline_h: "no" };
  await run(join(python, "configure"), [`--prefix=${pythonInstall}`, "--disable-shared", "--without-ensurepip", `--with-openssl=${sslPrefix}`, "--with-openssl-rpath=no"], { cwd: python, env: pythonEnv, diagnosticStage: "python-configure" });
  await run("/usr/bin/make", [`-j${JOBS}`], { cwd: python, env: pythonEnv, diagnosticStage: "python-build" });
  await run("/usr/bin/make", ["altinstall"], { cwd: python, env: pythonEnv, diagnosticStage: "python-install" });
  await run(join(pythonInstall, "bin/python3.11"), ["-I", "-B", "-c", PYTHON_RUNTIME_PROBE, pythonInstall,
    process.env.MACOS_INTERNAL_DIAGNOSTICS === "1" ? "1" : "0"], { env: pythonEnv, diagnosticStage: "python-install-probe" });
  await copy(join(pythonInstall, "bin/python3.11"), join(media, "python/bin/python3.11"), 0o755);
  await copy(join(pythonInstall, "lib/python3.11/os.py"), join(media, "python/lib/python3.11/os.py"));
  const dynamic = join(pythonInstall, "lib/python3.11/lib-dynload");
  for (const name of await readdir(dynamic)) if (name.endsWith(".so"))
    await copy(join(dynamic, name), join(media, "python/lib/python3.11/lib-dynload", name), 0o755);
  const zipCode = String.raw`import pathlib, sys, zipfile
source, target = map(pathlib.Path, sys.argv[1:])
with zipfile.ZipFile(target, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
 for path in sorted(source.rglob('*')):
  relative = path.relative_to(source)
  if any(part in ('__pycache__','lib-dynload','site-packages','test','tests','idlelib','turtledemo','ensurepip') for part in relative.parts): continue
  assert not path.is_symlink()
  if path.is_file() and path.suffix not in ('.pyc','.pyo','.a'): archive.write(path, relative.as_posix())
`;
  await run("python3", ["-I", "-B", "-c", zipCode, join(pythonInstall, "lib/python3.11"), join(media, "python/lib/python311.zip")], { env, diagnosticStage: "python-stdlib" });
  await copy(join(python, "LICENSE"), join(media, "licenses/Python-LICENSE.txt"));
  const ffmpeg = join(scratch, "ffmpeg-source", `ffmpeg-${SOURCES.ffmpeg.version}`);
  const ffmpegEnv = { ...env, CFLAGS: await normalizeFfmpegCflags(env.CFLAGS ?? "") };
  const ffmpegFlags = ["--disable-shared", "--enable-static", "--disable-gpl", "--disable-nonfree", "--disable-autodetect",
    "--disable-doc", "--disable-debug", "--disable-network", "--enable-small", "--enable-videotoolbox", "--cc=clang",
    `--extra-cflags=-ffile-prefix-map=${scratch}=.`];
  await run(join(ffmpeg, "configure"), ffmpegFlags, { cwd: ffmpeg, env: ffmpegEnv, diagnosticStage: "ffmpeg-configure" });
  await run("/usr/bin/make", [`-j${JOBS}`, "ffmpeg", "ffprobe"], { cwd: ffmpeg, env: ffmpegEnv, diagnosticStage: "ffmpeg-build" });
  for (const name of ["ffmpeg", "ffprobe"]) await copy(join(ffmpeg, name), join(media, "ffmpeg", name), 0o755);
  for (const name of ["LICENSE.md", "COPYING.LGPLv2.1"]) await copy(join(ffmpeg, name), join(media, "licenses", `FFmpeg-${name}`));
  await copy(archives.ffmpeg, join(media, "sources", "ffmpeg-9.0.1.tar.xz"));
  await jsonNew(join(media, "sources/ffmpeg-build.json"), { source: SOURCES.ffmpeg, configure: ffmpegFlags.map(flag => flag.startsWith("--extra-cflags=") ? "--extra-cflags=-ffile-prefix-map=<build-stage>=." : flag) });
  const denoArchive = await readRegular(await download(DENO_INPUT));
  verifyDenoArchive(denoArchive); validateDenoListing(tarListing(denoArchive));
  const deno = tarMember(denoArchive, "deno"); validateArm64Executable(deno);
  await writeNew(join(media, "deno/deno"), deno, 0o755);
  const denoLicense = await readRegular(join(APP, "third-party-notices/deno-2.9.4/bodies", `${DENO_INPUT.licenseSha256}.txt`));
  if (sha256(denoLicense) !== DENO_INPUT.licenseSha256) throw new Error("macos-deno-license-invalid");
  await writeNew(join(media, "licenses/Deno-LICENSE.md"), denoLicense);
  const sources = JSON.parse((await readRegular(join(APP, "third_party/media-engine/manifest.json"))).toString());
  for (const input of [sources.ytDlp, sources.ytDlpEjs]) await copy(await download(input), join(media, "wheels", input.fileName));
  await copy(join(APP, "third_party/media-engine/runner.py"), join(media, "runner.py"));
  for (const file of await inventory(media)) {
    const path = join(media, file.path);
    const bytes = await readRegular(path);
    if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0xfeedfacf) {
      await requireMachO(path);
      const dependencies = await run("/usr/bin/otool", ["-L", path], { capture: true });
      for (const line of dependencies.split("\n").slice(1).filter(line => line.trim())) {
        const dependency = line.trim().split(" (", 1)[0];
        if (!dependency.startsWith("/usr/lib/") && !dependency.startsWith("/System/Library/")) throw new Error("macos-media-external-dylib");
      }
      await run("/usr/bin/codesign", ["--force", "--sign", "-", path]);
    }
  }
  await jsonNew(join(media, "macos-build.json"), { schemaVersion: 1, ...INPUTS, installScriptsExecuted: false });
  const files = await inventory(media);
  if (files.length > 512) throw new Error("macos-media-file-count-limit");
  await jsonNew(join(media, "runtime-manifest.json"), { schemaVersion: 1, sourceManifestSha256: sha256(Buffer.from(JSON.stringify(INPUTS))),
    pythonVersion: SOURCES.python.version, python: "python/bin/python3.11", ytDlpVersion: sources.ytDlp.version,
    ytDlpWheel: `wheels/${sources.ytDlp.fileName}`, ytDlpEjsWheel: `wheels/${sources.ytDlpEjs.fileName}`,
    deno: "deno/deno", ffmpeg: "ffmpeg/ffmpeg", files });
  const result = await publishDirectory(media, "media-engine");
  await run(join(result, "python/bin/python3.11"), ["-I", "-B", "-c", PYTHON_RUNTIME_PROBE, join(result, "python"),
    process.env.MACOS_INTERNAL_DIAGNOSTICS === "1" ? "1" : "0"], { env, diagnosticStage: "python-probe" });
  await run(join(result, "deno/deno"), ["--version"], { env, diagnosticStage: "deno-probe" });
  await run(join(result, "ffmpeg/ffmpeg"), ["-hide_banner", "-version"], { env, diagnosticStage: "ffmpeg-probe" });
  return result;
}

export async function prepareRuntimes() {
  requireNative();
  await run("python3", ["-I", "-B", "-c", "import sys; assert sys.version_info >= (3,11)"]);
  const scratch = await stage("runtimes"); const home = join(scratch, "build-home"); await mkdir(home);
  const node = await nodeInput(scratch);
  if ((await run(node, ["--version"], { capture: true })).trim() !== `v${NODE_INPUT.version}`) throw new Error("macos-node-version-invalid");
  const dsh = await prepareDsh(scratch, node, home);
  const media = await prepareMedia(scratch, node, home);
  return { platform: "darwin", architecture: "arm64", media, dsh };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.slice(2).join(" ") === "--plan") console.log(JSON.stringify(INPUTS, null, 2));
    else if (process.argv.length === 2) console.log(JSON.stringify(await prepareRuntimes()));
    else throw new Error("usage: node prepare-macos-runtimes.mjs [--plan]");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
