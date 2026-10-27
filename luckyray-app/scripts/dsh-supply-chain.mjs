import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";

export class DshSupplyChainError extends Error {
  constructor(code) {
    super(code);
    this.name = "DshSupplyChainError";
    this.code = code;
  }
}

// Whole-closure budget, not the unchanged per-npm-archive entry budget.
// The admitted Windows 0.2.1-rc.3 tree contains 35,192 files.
export const MAX_DSH_CLOSURE_FILE_COUNT = 40_000;
const EXPECTED_AUTHORITY = Object.freeze({
  "schemaVersion": 1,
  "runtimePackage": {
    "name": "@deepseek-ai/dsh",
    "version": "0.2.1-rc.3",
    "tarball": "https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.1-rc.3.tgz",
    "registryIntegrity": "sha512-H+E9HLnHf7fJqzen84Z9Bq8ggb5xbrcbyhZjXTJLE9NabHr3zteGvTRvdvGkxPl4ov80is4WLglFmSo+/olJjg==",
    "registrySha1": "ccc527065b9f736ea299a1f78150a21143d961aa",
    "sha256": "9a8f9493bfab8218215a8ca38ab8821e76dff63dc4fcb65841ef87c0aa277141",
    "size": 25130,
    "license": "MIT"
  },
  "sourceReference": {
    "repository": "https://github.com/deepseek-ai/deepseek-harness",
    "commit": "1f81c047fc48fa190a683e469daa699857e9afe8",
    "tree": "fe242286aaa4a399c91814de21e55f874ea34295",
    "declaredVersion": "0.2.1-rc.3",
    "role": "audit-only",
    "provenanceBoundToRuntime": false
  },
  "nodeRuntime": {
    "version": "22.19.0",
    "platform": "win32",
    "architecture": "x64",
    "archive": "https://nodejs.org/dist/v22.19.0/node-v22.19.0-win-x64.zip",
    "archiveSha256": "ea3fad0e67a991d8477d8c01344b56e69c676ccb733f065b22436994b1253f86",
    "nodeExeSha256": "995a3fb3cefad590cd3f4b321532a4b9582fb9c6575320ed2e3e894caac3e362",
    "licenseSha256": "339c50294da6a84322dcbe7285b57b248123bd4d9e37a2f72d68d5abf2574783",
    "stagedFiles": [
      "LICENSE",
      "node.exe"
    ]
  },
  "packageManager": {
    "name": "pnpm",
    "version": "11.7.0",
    "tarball": "https://registry.npmjs.org/pnpm/-/pnpm-11.7.0.tgz",
    "registryIntegrity": "sha512-GcyFLBIMcSV2DyRD7mvgyltA+fUFmN4aCaHxd1A+AQ5Xwjx3ZG4B52HeWb+HT7IqM5jDOrlpH8E+uUa28PTWIA==",
    "registrySha1": "bea54364524dadf0a42dae28dbfeeab25ff177e5",
    "sha256": "deafa7ec98a1218b6a047289b92fbe2395c1e22d3495bb711653013218ee15ee",
    "license": "MIT",
    "archivePolicy": {
      "schemaVersion": 1,
      "format": "ustar",
      "magicHex": "757374617200",
      "version": "00",
      "regularFilesOnly": true,
      "requireEmptyPrefix": true,
      "requireEmptyLinkName": true,
      "windowsCanonicalPaths": true,
      "compressedByteLimit": 33554432,
      "uncompressedByteLimit": 33554432,
      "entryCountLimit": 1024,
      "entryByteLimit": 16777216,
      "pathByteLimit": 100,
      "pathDepthLimit": 32,
      "pathSegmentByteLimit": 255,
      "endZeroBlockCount": 2
    },
    "extractedTree": {
      "schemaVersion": 1,
      "fileCount": 449,
      "byteCount": 18644360,
      "sha256": "ccb8af2ce09e65f728ab5689a1bc00df5b1f508bc23cfc9829d95d3dccc1340e",
      "entryPoint": "package/bin/pnpm.mjs"
    },
    "installPolicy": {
      "ignorePnpmfile": true,
      "isolatedGlobalConfig": true,
      "packageImportMethod": "copy",
      "nodeLinker": "isolated",
      "virtualStoreDir": "node_modules/.pnpm",
      "installScripts": false,
      "offline": true,
      "frozenLockfile": true,
      "minimumReleaseAge": 1440,
      "minimumReleaseAgeStrict": true,
      "minimumReleaseAgeIgnoreMissingTime": false,
      "missingReleaseTimeBehavior": "reject",
      "workspacePolicySha256": "460e2012bf651c0b13acdc433a98255ee144585461ba280a335211a1b0af56f7"
    }
  },
  "dependencyClosure": {
    "lockfile": "pnpm-lock.yaml",
    "lockfileVersion": "9.0",
    "sha256": "0faaa6a7163bf2248735883e69e6051825b45fafb253a42432b4b6ee5a3bbbea",
    "packageCount": 634,
    "stagedPackageCount": 562,
    "installedAuditSha256": "b361fd576b25e6cd37d4c1c4fe01203cf544da5b4cfd0506cdf83a8e17d46619",
    "resolverGraphSha256": "65eb2c38f0fe86830a22ef6fb41e821b8965b7b8b3f7680dd4f77b567784be40",
    "lockReconciliationSha256": "33bd8d500dc0403353f29060aa9c5f66d5f7f2a2b8f492efbc877276c83fa880",
    "releaseLayout": {
      "schemaVersion": 1,
      "nodeLinker": "hoisted",
      "packageImportMethod": "copy",
      "physicalPackageRootCount": 570,
      "resolverGraphEdgeCount": 0,
      "maxNodeModulesRelativePathLength": 161,
      "maxRelativePathLength": 179,
      "fileCount": 35192,
      "contentSha256": "c454ae927c4109ab33b5708c6258432ea0d5884d513c9e206a5df7aa62e04615",
      "normalizedShimCount": 13,
      "fixedEntryPoint": "host/node_modules/@deepseek-ai/dsh/lib/bin.js",
      "reparsePoints": 0
    },
    "nodeVersion": "22.19.0",
    "pnpmVersion": "11.7.0"
  },
  "policy": {
    "runtimeAuthority": "npm-tarball-and-frozen-closure",
    "upstreamPatchCount": 0,
    "allowSystemNodeFallback": false,
    "allowNetworkDuringOfflineStage": false,
    "allowInstallScripts": false
  }
});

// Only fixed qualification validation can create this in-memory identity. The
// native worker invokes it AFTER signed hash/size admission; the maintainer
// helper's pure validation is not an installation token. Raw JSON does not
// acquire this brand. The bundled
// build/seal path continues to require its exact compiled baseline.
const qualifiedAuthorities = new WeakSet();
function qualifiedClone(value) {
  const result = structuredClone(value);
  const freeze = object => {
    for (const child of Object.values(object)) if (child && typeof child === "object") freeze(child);
    Object.freeze(object);
  };
  freeze(result);
  qualifiedAuthorities.add(result);
  return result;
}
export function validateDshRuntimeAuthority(value) {
  if (qualifiedAuthorities.has(value)) return qualifiedClone(value);
  if (!isDeepStrictEqual(value, EXPECTED_AUTHORITY)) {
    throw new DshSupplyChainError("dsh-runtime-authority-invalid");
  }
  return structuredClone(EXPECTED_AUTHORITY);
}

export function validateQualifiedDshRuntimeAuthority(value) {
  const invalid = () => { throw new DshSupplyChainError("dsh-qualified-authority-invalid"); };
  const hex = (v, length = 64) => typeof v === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "u").test(v);
  const count = (v, max) => Number.isSafeInteger(v) && v > 0 && v <= max;
  const runtime = value?.runtimePackage, closure = value?.dependencyClosure, layout = closure?.releaseLayout;
  if (!runtime || !closure || !layout || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/u.test(runtime.version ?? "")
      || runtime.version.length > 128 || runtime.tarball !== `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${runtime.version}.tgz`
      || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(runtime.registryIntegrity ?? "")
      || !hex(runtime.registrySha1, 40) || !hex(runtime.sha256) || !count(runtime.size, 256 * 1024 * 1024)
      || !hex(value.sourceReference?.commit, 40) || !hex(value.sourceReference?.tree, 40)
      || value.sourceReference?.declaredVersion !== runtime.version
      || !count(closure.packageCount, 2048) || !count(closure.stagedPackageCount, closure.packageCount)
      || !["sha256", "installedAuditSha256", "resolverGraphSha256", "lockReconciliationSha256"].every(k => hex(closure[k]))
      || !count(layout.physicalPackageRootCount, 2048) || !count(layout.fileCount, MAX_DSH_CLOSURE_FILE_COUNT)
      || !count(layout.maxNodeModulesRelativePathLength, 220) || !count(layout.maxRelativePathLength, 240)
      || !count(layout.normalizedShimCount, 128) || !hex(layout.contentSha256)) invalid();
  // Substitute ONLY version-qualified data, then compare ALL policy, tool,
  // origin, layout/schema fields and keys against fixed host capabilities.
  const fixed = structuredClone(value), expected = EXPECTED_AUTHORITY;
  fixed.runtimePackage = { ...runtime, version: expected.runtimePackage.version,
    tarball: expected.runtimePackage.tarball, registryIntegrity: expected.runtimePackage.registryIntegrity,
    registrySha1: expected.runtimePackage.registrySha1, sha256: expected.runtimePackage.sha256, size: expected.runtimePackage.size };
  fixed.sourceReference = { ...fixed.sourceReference, commit: expected.sourceReference.commit,
    tree: expected.sourceReference.tree, declaredVersion: expected.sourceReference.declaredVersion };
  for (const key of ["sha256", "packageCount", "stagedPackageCount", "installedAuditSha256", "resolverGraphSha256", "lockReconciliationSha256"])
    fixed.dependencyClosure[key] = expected.dependencyClosure[key];
  for (const key of ["physicalPackageRootCount", "maxNodeModulesRelativePathLength", "maxRelativePathLength", "fileCount", "contentSha256", "normalizedShimCount"])
    fixed.dependencyClosure.releaseLayout[key] = expected.dependencyClosure.releaseLayout[key];
  if (!isDeepStrictEqual(fixed, expected)) invalid();
  return qualifiedClone(value);
}

export function frozenHostTemplate(version) {
  if (typeof version !== "string" || version.length > 128 || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/u.test(version))
    throw new DshSupplyChainError("dsh-host-package-invalid");
  return { ...structuredClone(EXPECTED_HOST_PACKAGE), dependencies: { ...EXPECTED_HOST_PACKAGE.dependencies, "@deepseek-ai/dsh": version } };
}

const EXPECTED_HOST_PACKAGE = Object.freeze({
  name: "@luckyray/dsh-runtime-closure",
  version: "0.0.0-private",
  private: true,
  type: "module",
  license: "UNLICENSED",
  packageManager: "pnpm@11.7.0",
  engines: { node: "=22.19.0" },
  dependencies: {
    "@deepseek-ai/dsh": "0.2.1-rc.3",
    react: "18.3.1",
    "react-dom": "18.3.1",
  },
});

const EXPECTED_NPMRC = [
  "auto-install-peers=true",
  "engine-strict=true",
  "ignore-scripts=true",
  "link-workspace-packages=false",
  "save-exact=true",
  "strict-peer-dependencies=true",
  "",
].join("\n");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const STRICT_TAR_POLICY = Object.freeze(EXPECTED_AUTHORITY.packageManager.archivePolicy);
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function tarStringField(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  const bytes = terminator < 0 ? field : field.subarray(0, terminator);
  if (terminator >= 0 && field.subarray(terminator).some((byte) => byte !== 0)) {
    throw new DshSupplyChainError("dsh-pnpm-tar-policy-invalid");
  }
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new DshSupplyChainError("dsh-pnpm-tar-policy-invalid");
  }
}

function tarOctal(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  if (field.some((byte) => byte > 0x7f)) throw new DshSupplyChainError("dsh-pnpm-extract-invalid");
  const value = field.toString("ascii").replace(/[\0 ]+$/u, "").trimStart();
  if (!/^[0-7]+$/.test(value)) throw new DshSupplyChainError("dsh-pnpm-extract-invalid");
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DshSupplyChainError("dsh-pnpm-extract-invalid");
  }
  return parsed;
}

function validateTarHeader(header) {
  if (header.length !== 512) throw new DshSupplyChainError("dsh-pnpm-extract-invalid");
  if (
    header.subarray(257, 263).toString("hex") !== STRICT_TAR_POLICY.magicHex
    || header.subarray(263, 265).toString("ascii") !== STRICT_TAR_POLICY.version
    || header.subarray(345, 500).some((byte) => byte !== 0)
  ) {
    throw new DshSupplyChainError("dsh-pnpm-tar-policy-invalid");
  }
  const expected = tarOctal(header, 148, 8);
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) throw new DshSupplyChainError("dsh-pnpm-extract-invalid");
}

function validateTarPackagePath(value) {
  const bytes = Buffer.from(value, "utf8");
  const segments = value.split("/");
  if (
    typeof value !== "string"
    || !value.startsWith("package/")
    || value.normalize("NFC") !== value
    || bytes.length === 0
    || bytes.length > STRICT_TAR_POLICY.pathByteLimit
    || segments.length > STRICT_TAR_POLICY.pathDepthLimit
    || /[\u0000-\u001f\u007f]/u.test(value)
    || /[<>"|?*]/u.test(value)
    || value.includes("\\")
    || value.includes(":")
    || segments.some((segment) =>
      segment === ""
      || segment === "."
      || segment === ".."
      || /[. ]$/u.test(segment)
      || WINDOWS_RESERVED_NAME.test(segment)
      || Buffer.byteLength(segment, "utf8") > STRICT_TAR_POLICY.pathSegmentByteLimit)
  ) {
    throw new DshSupplyChainError("dsh-pnpm-tar-policy-invalid");
  }
  return {
    value,
    segments,
    windowsKey: segments.map((segment) => segment.toLocaleLowerCase("en-US")).join("/"),
  };
}

function parseStrictPnpmTar(archive) {
  if (!Buffer.isBuffer(archive) || archive.length > STRICT_TAR_POLICY.compressedByteLimit) {
    throw new DshSupplyChainError("dsh-pnpm-tar-resource-limit");
  }
  let tarball;
  try {
    tarball = gunzipSync(archive, { maxOutputLength: STRICT_TAR_POLICY.uncompressedByteLimit });
  } catch (error) {
    throw new DshSupplyChainError(
      error?.code === "ERR_BUFFER_TOO_LARGE"
        ? "dsh-pnpm-tar-resource-limit"
        : "dsh-pnpm-extract-invalid",
    );
  }
  const files = new Map();
  const directories = new Set();
  const entries = [];
  let offset = 0;
  let zeroBlocks = 0;
  while (offset + 512 <= tarball.length) {
    const header = tarball.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks >= STRICT_TAR_POLICY.endZeroBlockCount) break;
      continue;
    }
    if (zeroBlocks !== 0) throw new DshSupplyChainError("dsh-pnpm-extract-invalid");
    validateTarHeader(header);
    if (
      (header[156] !== 0 && header[156] !== 0x30)
      || header.subarray(157, 257).some((byte) => byte !== 0)
    ) {
      throw new DshSupplyChainError("dsh-pnpm-tar-policy-invalid");
    }
    const path = validateTarPackagePath(tarStringField(header, 0, 100));
    if (files.has(path.windowsKey) || directories.has(path.windowsKey)) {
      throw new DshSupplyChainError("dsh-pnpm-tar-policy-invalid");
    }
    let ancestor = "";
    for (const segment of path.segments.slice(0, -1)) {
      ancestor = ancestor === "" ? segment.toLocaleLowerCase("en-US") : `${ancestor}/${segment.toLocaleLowerCase("en-US")}`;
      if (files.has(ancestor)) throw new DshSupplyChainError("dsh-pnpm-tar-policy-invalid");
      directories.add(ancestor);
    }
    const size = tarOctal(header, 124, 12);
    if (size > STRICT_TAR_POLICY.entryByteLimit || entries.length >= STRICT_TAR_POLICY.entryCountLimit) {
      throw new DshSupplyChainError("dsh-pnpm-tar-resource-limit");
    }
    const paddedSize = Math.ceil(size / 512) * 512;
    if (offset + paddedSize > tarball.length) throw new DshSupplyChainError("dsh-pnpm-extract-invalid");
    files.set(path.windowsKey, path.value);
    entries.push({ path: path.value, bytes: tarball.subarray(offset, offset + size) });
    offset += paddedSize;
  }
  if (zeroBlocks < STRICT_TAR_POLICY.endZeroBlockCount || tarball.subarray(offset).some((byte) => byte !== 0)) {
    throw new DshSupplyChainError("dsh-pnpm-extract-invalid");
  }
  return entries;
}

export async function extractStrictPnpmTarGzip({ archive, outputRoot }) {
  const entries = parseStrictPnpmTar(archive);
  await mkdir(outputRoot, { recursive: false });
  for (const entry of entries) {
    const destination = join(outputRoot, ...entry.path.split("/"));
    await mkdir(resolve(destination, ".."), { recursive: true });
    await writeFile(destination, entry.bytes, { flag: "wx" });
  }
  return Object.freeze({ fileCount: entries.length });
}

async function regularFileTree(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new DshSupplyChainError("dsh-pnpm-extracted-tree-invalid");
    if (entry.isDirectory()) {
      files.push(...await regularFileTree(root, absolute));
    } else if (entry.isFile()) {
      const bytes = await readFile(absolute);
      files.push({
        path: portablePath(relative(root, absolute)),
        size: bytes.length,
        sha256: sha256(bytes),
      });
    } else {
      throw new DshSupplyChainError("dsh-pnpm-extracted-tree-invalid");
    }
  }
  return files;
}

function summarizeRegularFileTree(files) {
  const sorted = [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const contentHash = createHash("sha256");
  let byteCount = 0;
  for (const file of sorted) {
    byteCount += file.size;
    contentHash.update(file.path).update("\0").update(String(file.size)).update("\0").update(file.sha256).update("\n");
  }
  return Object.freeze({
    schemaVersion: 1,
    fileCount: sorted.length,
    byteCount,
    sha256: contentHash.digest("hex"),
  });
}

export async function verifyExtractedPnpmPackage({ authorityPath, packageRoot }) {
  const authority = validateDshRuntimeAuthority(JSON.parse(await readFile(authorityPath, "utf8")));
  const topLevel = await readdir(packageRoot);
  if (!isDeepStrictEqual(topLevel.sort(), ["package"])) {
    throw new DshSupplyChainError("dsh-pnpm-extracted-tree-invalid");
  }
  const summary = summarizeRegularFileTree(await regularFileTree(packageRoot));
  const expected = authority.packageManager.extractedTree;
  if (
    summary.fileCount !== expected.fileCount
    || summary.byteCount !== expected.byteCount
    || summary.sha256 !== expected.sha256
  ) {
    throw new DshSupplyChainError("dsh-pnpm-extracted-tree-invalid");
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(packageRoot, "package", "package.json"), "utf8"));
    await readFile(join(packageRoot, ...expected.entryPoint.split("/")));
  } catch {
    throw new DshSupplyChainError("dsh-pnpm-extracted-tree-invalid");
  }
  if (
    manifest.name !== authority.packageManager.name
    || manifest.version !== authority.packageManager.version
    || manifest.license !== authority.packageManager.license
  ) {
    throw new DshSupplyChainError("dsh-pnpm-extracted-tree-invalid");
  }
  return summary;
}

export async function extractVerifiedPnpmPackage({ authorityPath, pnpmTarballPath, outputRoot }) {
  const authority = validateDshRuntimeAuthority(JSON.parse(await readFile(authorityPath, "utf8")));
  const archive = await readFile(pnpmTarballPath);
  if (sha256(archive) !== authority.packageManager.sha256) {
    throw new DshSupplyChainError("dsh-pnpm-tarball-invalid");
  }
  await extractStrictPnpmTarGzip({ archive, outputRoot });
  return verifyExtractedPnpmPackage({ authorityPath, packageRoot: outputRoot });
}

export function validatePeX64Image(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 0x86 || bytes.toString("ascii", 0, 2) !== "MZ") {
    throw new DshSupplyChainError("dsh-native-architecture-invalid");
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (
    peOffset < 0x40
    || peOffset + 6 > bytes.length
    || bytes.toString("binary", peOffset, peOffset + 4) !== "PE\0\0"
    || bytes.readUInt16LE(peOffset + 4) !== 0x8664
  ) {
    throw new DshSupplyChainError("dsh-native-architecture-invalid");
  }
  return true;
}

const ALLOWED_LICENSES = new Set([
  "0BSD",
  "Unlicense",
  "Apache-2.0",
  "Apache-2.0 AND LGPL-3.0-or-later",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "(MIT OR CC0-1.0)",
  "MPL-2.0",
  "Python-2.0",
]);

const LIFECYCLE_SCRIPT_REVIEWS = Object.freeze([
  {
    name: "@deepseek-ai/dsh-subprocess-local",
    version: "0.2.1-rc.3",
    scripts: [{ stage: "postinstall", command: "node scripts/ensure-spawn-helper.mjs" }],
    windowsRuntimeEvidence: [],
    rationale: "The script only restores a POSIX executable bit on node-pty spawn-helper; Windows does not use that permission bit.",
  },
  {
    name: "@google/genai",
    version: "2.21.0",
    scripts: [{ stage: "preinstall", command: "echo 'preinstall: no-op'" }],
    windowsRuntimeEvidence: [],
    rationale: "The published preinstall command is explicitly a no-op.",
  },
  {
    name: "koffi",
    version: "3.1.1",
    scripts: [{ stage: "install", command: "node ./cnoke.cjs -P . -D src/koffi --prebuild --release" }],
    windowsRuntimeEvidence: [{
      package: "@koromix/koffi-win32-x64@3.1.1",
      path: "win32_x64/koffi.node",
    }],
    rationale: "The exact Windows x64 optional prebuild is present and hashed, so local compilation is neither required nor allowed.",
  },
  {
    name: "node-pty",
    version: "1.2.0-beta.15",
    scripts: [
      { stage: "install", command: "node scripts/prebuild.js || node-gyp rebuild" },
      { stage: "postinstall", command: "node scripts/post-install.js" },
    ],
    windowsRuntimeEvidence: [
      { package: "node-pty@1.2.0-beta.15", path: "prebuilds/win32-x64/conpty_console_list.node" },
      { package: "node-pty@1.2.0-beta.15", path: "prebuilds/win32-x64/conpty.node" },
      { package: "node-pty@1.2.0-beta.15", path: "prebuilds/win32-x64/conpty/conpty.dll" },
      { package: "node-pty@1.2.0-beta.15", path: "prebuilds/win32-x64/conpty/OpenConsole.exe" },
    ],
    rationale: "The published Windows x64 node-pty and ConPTY prebuilds are present and hashed; build and copy scripts remain disabled.",
  },
  {
    name: "protobufjs",
    version: "7.6.6",
    scripts: [{ stage: "postinstall", command: "node scripts/postinstall" }],
    windowsRuntimeEvidence: [],
    rationale: "The postinstall script only emits dependency-version compatibility warnings and does not create runtime bytes.",
  },
]);

const WINDOWS_X64_RUNTIME_EVIDENCE = Object.freeze([
  ...LIFECYCLE_SCRIPT_REVIEWS.flatMap((review) => review.windowsRuntimeEvidence),
  { package: "@img/sharp-win32-x64@0.35.5", path: "lib/libvips-42.dll" },
  { package: "@img/sharp-win32-x64@0.35.5", path: "lib/libvips-cpp-8.18.7.dll" },
  { package: "@img/sharp-win32-x64@0.35.5", path: "lib/sharp-win32-x64-0.35.5.node" },
  { package: "@vscode/ripgrep-win32-x64@1.18.0", path: "bin/rg.exe" },
  { package: "node-addon-require-builtin-win32-x64-msvc@0.1.9", path: "prebuilt/win32-x64-msvc-napi-v9.node" },
  { package: "@deepseek-ai/libreoffice-kit-win32-x64@0.1.5", path: "bin/libreoffice-kit.exe" },
]);

// Qualified closures still require reviewed, exact PE paths. Sharp 0.35.5
// updates both the addon and libvips filenames; the bundled closure is 0.35.5.
const QUALIFIED_SHARP_WINDOWS_PATHS = Object.freeze({
  "0.35.4": ["lib/libvips-42.dll", "lib/libvips-cpp-8.18.6.dll", "lib/sharp-win32-x64-0.35.4.node"],
  "0.35.5": ["lib/libvips-42.dll", "lib/libvips-cpp-8.18.7.dll", "lib/sharp-win32-x64-0.35.5.node"],
});

function portablePath(value) {
  return value.split(sep).join("/");
}

function relativeInside(root, target, errorCode) {
  const relativePath = relative(root, target);
  if (relativePath === "" || (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`))) {
    return portablePath(relativePath);
  }
  throw new DshSupplyChainError(errorCode);
}

async function resolverLinksInside(nodeModulesRoot, current = nodeModulesRoot) {
  const links = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await realpath(absolute);
      links.push({
        path: portablePath(relative(nodeModulesRoot, absolute)),
        targetPath: relativeInside(nodeModulesRoot, target, "dsh-resolver-target-outside-stage"),
      });
    } else if (entry.isDirectory()) {
      links.push(...await resolverLinksInside(nodeModulesRoot, absolute));
    }
  }
  return links;
}

async function resolverLinkPaths(nodeModulesRoot, current = nodeModulesRoot) {
  const paths = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      paths.push(portablePath(relative(nodeModulesRoot, absolute)));
    } else if (entry.isDirectory()) {
      paths.push(...await resolverLinkPaths(nodeModulesRoot, absolute));
    }
  }
  return paths;
}

function canonicalResolverPath(value) {
  if (
    typeof value !== "string"
    || value === ""
    || value.startsWith("/")
    || value.includes("\\")
    || value.includes(":")
    || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new DshSupplyChainError("dsh-resolver-graph-invalid");
  }
  return value;
}

export async function rebindResolverGraphAtFinalRoot({ nodeModulesRoot, resolverGraph }) {
  if (process.platform !== "win32") {
    throw new DshSupplyChainError("dsh-resolver-platform-invalid");
  }
  if (
    resolverGraph?.schemaVersion !== 1
    || !Number.isSafeInteger(resolverGraph.edgeCount)
    || resolverGraph.edgeCount < 0
    || !Array.isArray(resolverGraph.edges)
    || resolverGraph.edgeCount !== resolverGraph.edges.length
  ) {
    throw new DshSupplyChainError("dsh-resolver-graph-invalid");
  }
  const canonicalNodeModulesRoot = await realpath(nodeModulesRoot);
  const expected = resolverGraph.edges.map((edge) => {
    const path = canonicalResolverPath(edge?.path);
    const targetPath = canonicalResolverPath(edge?.targetPath);
    if (
      typeof edge.targetPackage !== "string"
      || !/^[a-f0-9]{64}$/.test(edge.targetContentSha256 ?? "")
    ) {
      throw new DshSupplyChainError("dsh-resolver-graph-invalid");
    }
    return { path, targetPath };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (expected.some((edge, index) => index > 0 && edge.path === expected[index - 1].path)) {
    throw new DshSupplyChainError("dsh-resolver-graph-invalid");
  }
  const actualPaths = (await resolverLinkPaths(canonicalNodeModulesRoot))
    .sort((left, right) => left.localeCompare(right));
  if (!isDeepStrictEqual(actualPaths, expected.map((edge) => edge.path))) {
    throw new DshSupplyChainError("dsh-resolver-link-set-invalid");
  }
  for (const edge of expected) {
    const target = resolve(canonicalNodeModulesRoot, ...edge.targetPath.split("/"));
    const canonicalTarget = await realpath(target);
    if (
      relativeInside(canonicalNodeModulesRoot, canonicalTarget, "dsh-resolver-target-outside-stage") !== edge.targetPath
      || !(await lstat(canonicalTarget)).isDirectory()
    ) {
      throw new DshSupplyChainError("dsh-resolver-target-not-audited-package");
    }
  }
  for (const edge of expected) {
    await unlink(resolve(canonicalNodeModulesRoot, ...edge.path.split("/")));
  }
  for (const edge of expected) {
    const link = resolve(canonicalNodeModulesRoot, ...edge.path.split("/"));
    const target = resolve(canonicalNodeModulesRoot, ...edge.targetPath.split("/"));
    await symlink(target, link, "junction");
  }
  const rebound = (await resolverLinksInside(canonicalNodeModulesRoot))
    .map(({ path, targetPath }) => ({ path, targetPath }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (!isDeepStrictEqual(rebound, expected)) {
    throw new DshSupplyChainError("dsh-resolver-rebind-invalid");
  }
  return Object.freeze({ edgeCount: rebound.length });
}

async function existingPackageRoots(nodeModulesRoot) {
  const virtualStore = join(nodeModulesRoot, ".pnpm");
  const virtualStoreReal = await realpath(virtualStore);
  const roots = new Map();
  for (const entry of await readdir(virtualStore, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nestedNodeModules = join(virtualStore, entry.name, "node_modules");
    let candidates;
    try {
      candidates = await readdir(nestedNodeModules, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const candidate of candidates) {
      if (!candidate.isDirectory() && !candidate.isSymbolicLink()) continue;
      if (candidate.name.startsWith("@")) {
        const scopeRoot = join(nestedNodeModules, candidate.name);
        for (const scoped of await readdir(scopeRoot, { withFileTypes: true })) {
          if (!scoped.isDirectory() && !scoped.isSymbolicLink()) continue;
          const packageRoot = join(scopeRoot, scoped.name);
          const resolved = await realpath(packageRoot);
          if (resolved.startsWith(`${virtualStoreReal}${sep}`)) roots.set(resolved, packageRoot);
        }
      } else {
        const packageRoot = join(nestedNodeModules, candidate.name);
        const resolved = await realpath(packageRoot);
        if (resolved.startsWith(`${virtualStoreReal}${sep}`)) roots.set(resolved, packageRoot);
      }
    }
  }
  return [...roots.keys()];
}

async function portablePackageRoots(nodeModulesRoot) {
  const roots = [];
  const seen = new Set();
  async function scan(currentNodeModules) {
    let entries;
    try {
      entries = await readdir(currentNodeModules, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name === ".bin" || entry.name.startsWith(".")) continue;
      const candidate = join(currentNodeModules, entry.name);
      if (entry.isSymbolicLink()) throw new DshSupplyChainError("dsh-portable-reparse-path");
      if (!entry.isDirectory()) continue;
      const packageCandidates = [];
      if (entry.name.startsWith("@")) {
        for (const scoped of await readdir(candidate, { withFileTypes: true })) {
          if (scoped.isSymbolicLink()) throw new DshSupplyChainError("dsh-portable-reparse-path");
          if (scoped.isDirectory()) packageCandidates.push(join(candidate, scoped.name));
        }
      } else {
        packageCandidates.push(candidate);
      }
      for (const packageRoot of packageCandidates) {
        const canonical = await realpath(packageRoot);
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        roots.push(packageRoot);
        await scan(join(packageRoot, "node_modules"));
      }
    }
  }
  await scan(nodeModulesRoot);
  return roots;
}

async function packageRootsForLayout(nodeModulesRoot) {
  try {
    const virtualStore = await lstat(join(nodeModulesRoot, ".pnpm"));
    if (virtualStore.isDirectory() && !virtualStore.isSymbolicLink()) {
      const virtualEntries = await readdir(join(nodeModulesRoot, ".pnpm"), { withFileTypes: true });
      if (virtualEntries.some((entry) => entry.isDirectory())) return existingPackageRoots(nodeModulesRoot);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return portablePackageRoots(nodeModulesRoot);
}

// Upstream coverage-service configuration is development-only, not runtime input.
// Pin the exact upstream bytes: never classify/probe its value or remove a new file
// just because its name happens to match. Both layouts use this same projection.
export async function projectDshDistributionMetadata({ nodeModulesRoot }) {
  const canonicalRoot = await realpath(nodeModulesRoot);
  const removals = [];
  for (const packageRoot of await packageRootsForLayout(nodeModulesRoot)) {
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    if (manifest.name !== "debug" || manifest.version !== "2.6.9") continue;
    const target = join(packageRoot, ".coveralls.yml");
    let metadata;
    try {
      metadata = await lstat(target, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n
      || !(await realpath(target)).startsWith(`${canonicalRoot}${sep}`)) {
      throw new DshSupplyChainError("dsh-distribution-metadata-path-invalid");
    }
    const digest = sha256(await readFile(target));
    if (digest !== "64e6b64f19837a76c30865579aabdde1a825729ae0204ba73ba6de77296ce18e") {
      throw new DshSupplyChainError("dsh-distribution-metadata-hash-invalid");
    }
    removals.push({ target, name: manifest.name, version: manifest.version,
      path: portablePath(relative(nodeModulesRoot, target)), sha256: digest });
  }
  // Validate the complete plan before mutating even this disposable build stage.
  for (const removal of removals) await unlink(removal.target);
  return Object.freeze({ schemaVersion: 1,
    removed: removals.map(({ target: _target, ...receipt }) => receipt) });
}

async function collectPortableTree(root, current, result) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new DshSupplyChainError("dsh-portable-reparse-path");
    result.maxRelativePathLength = Math.max(result.maxRelativePathLength, portablePath(relative(root, absolute)).length);
    if (entry.isDirectory()) {
      await collectPortableTree(root, absolute, result);
    } else if (entry.isFile()) {
      const metadata = await stat(absolute, { bigint: true });
      if (metadata.nlink !== 1n) throw new DshSupplyChainError("dsh-staged-file-not-detached");
      result.files.push(absolute);
    }
  }
}

export async function auditPortableTree(root) {
  const result = { files: [], maxRelativePathLength: 0 };
  await collectPortableTree(root, root, result);
  result.files.sort((left, right) => left.localeCompare(right));
  const contentHash = createHash("sha256");
  for (const absolute of result.files) {
    const path = portablePath(relative(root, absolute));
    contentHash.update(path).update("\0").update(sha256(await readFile(absolute))).update("\n");
  }
  return Object.freeze({
    fileCount: result.files.length,
    maxRelativePathLength: result.maxRelativePathLength,
    contentSha256: contentHash.digest("hex"),
    reparsePointCount: 0,
    sharedWritableFiles: 0,
  });
}

export async function projectPortableDshReleaseLayout({ stageRoot, expectedShimCount = null }) {
  const nodeModulesRoot = join(stageRoot, "host", "node_modules");
  const metadataFiles = [
    ".modules.yaml",
    ".pnpm-workspace-state-v1.json",
  ];
  for (const path of metadataFiles) {
    const metadata = await lstat(join(nodeModulesRoot, path), { bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
      throw new DshSupplyChainError("dsh-portable-install-metadata-invalid");
    }
  }
  const pnpmRoot = join(nodeModulesRoot, ".pnpm");
  const pnpmMetadata = await lstat(pnpmRoot);
  if (!pnpmMetadata.isDirectory() || pnpmMetadata.isSymbolicLink()) {
    throw new DshSupplyChainError("dsh-portable-install-metadata-invalid");
  }
  const pnpmEntries = await readdir(pnpmRoot, { withFileTypes: true });
  if (
    pnpmEntries.length !== 1
    || pnpmEntries[0].name !== "lock.yaml"
    || !pnpmEntries[0].isFile()
    || pnpmEntries[0].isSymbolicLink()
  ) {
    throw new DshSupplyChainError("dsh-portable-install-metadata-invalid");
  }
  const lockMetadata = await lstat(join(pnpmRoot, "lock.yaml"), { bigint: true });
  if (lockMetadata.nlink !== 1n) throw new DshSupplyChainError("dsh-portable-install-metadata-invalid");
  const binRoot = join(nodeModulesRoot, ".bin");
  const binEntries = await readdir(binRoot, { withFileTypes: true });
  const shims = binEntries
    .filter((entry) => !entry.name.includes("."))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (expectedShimCount !== null && shims.length !== expectedShimCount) {
    throw new DshSupplyChainError("dsh-portable-shim-set-invalid");
  }
  const normalizedShims = [];
  for (const entry of shims) {
    const absolute = join(binRoot, entry.name);
    const metadata = await lstat(absolute, { bigint: true });
    if (!entry.isFile() || entry.isSymbolicLink() || metadata.nlink !== 1n) {
      throw new DshSupplyChainError("dsh-portable-shim-invalid");
    }
    const source = await readFile(absolute, "utf8");
    const normalized = source.replace(/\r?\n# cmd-shim-target=[^\r\n]+\r?\n?$/u, "\n");
    if (normalized === source) throw new DshSupplyChainError("dsh-portable-shim-invalid");
    await writeFile(absolute, normalized);
    normalizedShims.push(`host/node_modules/.bin/${entry.name}`);
  }
  await projectDshDistributionMetadata({ nodeModulesRoot });
  for (const path of metadataFiles) await rm(join(nodeModulesRoot, path));
  await rm(pnpmRoot, { recursive: true });
  return Object.freeze({
    removed: [
      "host/node_modules/.modules.yaml",
      "host/node_modules/.pnpm-workspace-state-v1.json",
      "host/node_modules/.pnpm/lock.yaml",
    ],
    normalizedShims,
  });
}

async function packageFiles(packageRoot, current = packageRoot) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (current === packageRoot && entry.name === "node_modules") continue;
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new DshSupplyChainError("dsh-package-symlink-unsupported");
    }
    if (entry.isDirectory()) {
      files.push(...await packageFiles(packageRoot, absolute));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

export async function verifyDetachedDshRuntime({ stageRoot, current = stageRoot }) {
  let fileCount = 0;
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      fileCount += (await verifyDetachedDshRuntime({ stageRoot, current: absolute })).fileCount;
    } else if (entry.isFile()) {
      const metadata = await stat(absolute, { bigint: true });
      if (metadata.nlink !== 1n) {
        throw new DshSupplyChainError("dsh-staged-file-not-detached");
      }
      fileCount += 1;
    }
  }
  return Object.freeze({ fileCount, sharedWritableFiles: 0 });
}

async function auditPackage(packageRoot) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  } catch {
    throw new DshSupplyChainError("dsh-package-manifest-invalid");
  }
  if (
    typeof manifest.name !== "string"
    || typeof manifest.version !== "string"
    || typeof manifest.license !== "string"
  ) {
    throw new DshSupplyChainError("dsh-package-manifest-invalid");
  }
  if (!ALLOWED_LICENSES.has(manifest.license)) {
    throw new DshSupplyChainError("dsh-license-not-allowlisted");
  }

  const files = (await packageFiles(packageRoot)).sort((left, right) => left.localeCompare(right));
  const contentHash = createHash("sha256");
  const nativeArtifacts = [];
  const licenseFiles = [];
  let byteCount = 0;
  for (const absolute of files) {
    const bytes = await readFile(absolute);
    const path = portablePath(relative(packageRoot, absolute));
    const fileHash = sha256(bytes);
    byteCount += bytes.length;
    contentHash.update(path).update("\0").update(fileHash).update("\n");
    if (/\.(?:node|dll|exe)$/i.test(path)) {
      nativeArtifacts.push({ path, sha256: fileHash, size: bytes.length });
    }
    if (/^(?:licen[cs]e|copying|notice)(?:\..*)?$/i.test(basename(path))
        || (manifest.license === "(MIT OR CC0-1.0)" && /^license-(?:mit|cc0)$/i.test(basename(path)))) {
      licenseFiles.push({ path, sha256: fileHash, size: bytes.length });
    }
  }

  const lifecycleScripts = ["preinstall", "install", "postinstall"]
    .filter((stage) => typeof manifest.scripts?.[stage] === "string")
    .map((stage) => ({ stage, command: manifest.scripts[stage] }));

  return {
    name: manifest.name,
    version: manifest.version,
    license: manifest.license,
    contentSha256: contentHash.digest("hex"),
    fileCount: files.length,
    byteCount,
    lifecycleScripts,
    licenseFiles,
    nativeArtifacts,
  };
}

export async function auditInstalledClosure({ nodeModulesRoot, expectedPackageCount, entryPoint = null }) {
  const canonicalNodeModulesRoot = await realpath(nodeModulesRoot);
  const resolverLinks = await resolverLinksInside(canonicalNodeModulesRoot);
  const byIdentity = new Map();
  const byPackageRoot = new Map();
  for (const packageRoot of await existingPackageRoots(canonicalNodeModulesRoot)) {
    const audited = await auditPackage(packageRoot);
    const identity = `${audited.name}@${audited.version}`;
    const existing = byIdentity.get(identity);
    if (existing && existing.contentSha256 !== audited.contentSha256) {
      throw new DshSupplyChainError("dsh-package-content-ambiguous");
    }
    byIdentity.set(identity, audited);
    byPackageRoot.set(await realpath(packageRoot), {
      identity,
      contentSha256: audited.contentSha256,
    });
  }
  const packages = [...byIdentity.values()].sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
  if (packages.length !== expectedPackageCount) {
    throw new DshSupplyChainError("dsh-installed-package-count-invalid");
  }
  const resolverEdges = resolverLinks.map((edge) => {
    const target = resolve(canonicalNodeModulesRoot, edge.targetPath);
    const targetPackage = byPackageRoot.get(target);
    if (!targetPackage) {
      throw new DshSupplyChainError("dsh-resolver-target-not-audited-package");
    }
    return {
      ...edge,
      targetPackage: targetPackage.identity,
      targetContentSha256: targetPackage.contentSha256,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  let entryPointRecord = null;
  if (entryPoint !== null) {
    if (typeof entryPoint !== "string" || entryPoint === "" || isAbsolute(entryPoint) || entryPoint.split(/[\\/]/).includes("..")) {
      throw new DshSupplyChainError("dsh-entrypoint-invalid");
    }
    const requestedPath = portablePath(entryPoint);
    const requestedAbsolute = join(canonicalNodeModulesRoot, ...requestedPath.split("/"));
    let target;
    try {
      target = await realpath(requestedAbsolute);
    } catch {
      throw new DshSupplyChainError("dsh-entrypoint-invalid");
    }
    const targetPath = relativeInside(canonicalNodeModulesRoot, target, "dsh-entrypoint-outside-stage");
    const packageOwner = [...byPackageRoot.entries()]
      .filter(([root]) => target === root || target.startsWith(`${root}${sep}`))
      .sort(([left], [right]) => right.length - left.length)[0];
    if (!packageOwner) throw new DshSupplyChainError("dsh-entrypoint-package-invalid");
    entryPointRecord = {
      requestedPath,
      targetPath,
      targetPackage: packageOwner[1].identity,
      targetContentSha256: packageOwner[1].contentSha256,
      fileSha256: sha256(await readFile(target)),
    };
  }
  return {
    schemaVersion: 1,
    platform: "win32",
    architecture: "x64",
    packageCount: packages.length,
    installScriptsExecuted: false,
    packages,
    resolverGraph: {
      schemaVersion: 1,
      edgeCount: resolverEdges.length,
      edges: resolverEdges,
    },
    entryPoint: entryPointRecord,
  };
}

export async function auditPortableInstalledClosure({ nodeModulesRoot, expectedPackageCount, entryPoint = null }) {
  const canonicalNodeModulesRoot = await realpath(nodeModulesRoot);
  const tree = await auditPortableTree(canonicalNodeModulesRoot);
  const packageRoots = await portablePackageRoots(canonicalNodeModulesRoot);
  const byIdentity = new Map();
  const byPackageRoot = new Map();
  for (const packageRoot of packageRoots) {
    const audited = await auditPackage(packageRoot);
    const identity = `${audited.name}@${audited.version}`;
    const existing = byIdentity.get(identity);
    if (existing && existing.contentSha256 !== audited.contentSha256) {
      throw new DshSupplyChainError("dsh-package-content-ambiguous");
    }
    byIdentity.set(identity, audited);
    byPackageRoot.set(await realpath(packageRoot), { identity, contentSha256: audited.contentSha256 });
  }
  const packages = [...byIdentity.values()].sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
  if (packages.length !== expectedPackageCount) {
    throw new DshSupplyChainError("dsh-installed-package-count-invalid");
  }
  let entryPointRecord = null;
  if (entryPoint !== null) {
    if (typeof entryPoint !== "string" || entryPoint === "" || isAbsolute(entryPoint) || entryPoint.split(/[\\/]/).includes("..")) {
      throw new DshSupplyChainError("dsh-entrypoint-invalid");
    }
    const requestedPath = portablePath(entryPoint);
    const requestedAbsolute = join(canonicalNodeModulesRoot, ...requestedPath.split("/"));
    const metadata = await lstat(requestedAbsolute, { bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
      throw new DshSupplyChainError("dsh-entrypoint-invalid");
    }
    const target = await realpath(requestedAbsolute);
    const packageOwner = [...byPackageRoot.entries()]
      .filter(([root]) => target === root || target.startsWith(`${root}${sep}`))
      .sort(([left], [right]) => right.length - left.length)[0];
    if (!packageOwner) throw new DshSupplyChainError("dsh-entrypoint-package-invalid");
    entryPointRecord = {
      requestedPath,
      targetPath: portablePath(relative(canonicalNodeModulesRoot, target)),
      targetPackage: packageOwner[1].identity,
      targetContentSha256: packageOwner[1].contentSha256,
      fileSha256: sha256(await readFile(target)),
    };
  }
  return {
    schemaVersion: 1,
    platform: "win32",
    architecture: "x64",
    packageCount: packages.length,
    physicalPackageRootCount: packageRoots.length,
    installScriptsExecuted: false,
    maxRelativePathLength: tree.maxRelativePathLength,
    treeFileCount: tree.fileCount,
    treeContentSha256: tree.contentSha256,
    packages,
    resolverGraph: { schemaVersion: 1, edgeCount: 0, edges: [] },
    entryPoint: entryPointRecord,
  };
}

function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(value));
}

function packagePurl(name, version) {
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function validateLifecycleScriptReviews(dependencyAudit, qualified = false) {
  const actual = dependencyAudit.packages
    .filter((entry) => entry.lifecycleScripts.length > 0)
    .map((entry) => ({ name: entry.name, version: entry.version, scripts: entry.lifecycleScripts }));
  const reviews = LIFECYCLE_SCRIPT_REVIEWS.map(review => {
    if (!qualified) return review;
    const target = dependencyAudit.packages.find(pkg => pkg.name === review.name);
    if (!target) throw new DshSupplyChainError("dsh-lifecycle-script-review-invalid");
    return { ...review, version: target.version, windowsRuntimeEvidence: review.windowsRuntimeEvidence.map(evidence => {
      const name = evidence.package.slice(0, evidence.package.lastIndexOf("@"));
      const native = dependencyAudit.packages.find(pkg => pkg.name === name);
      if (!native || (review.name === "koffi" && native.version !== target.version))
        throw new DshSupplyChainError("dsh-native-prebuild-evidence-missing");
      return { ...evidence, package: `${name}@${native.version}` };
    }) };
  });
  const expected = reviews.map(({ name, version, scripts }) => ({ name, version, scripts }));
  if (!isDeepStrictEqual(actual, expected)) {
    throw new DshSupplyChainError("dsh-lifecycle-script-review-invalid");
  }
  const packages = new Map(dependencyAudit.packages.map((entry) => [`${entry.name}@${entry.version}`, entry]));
  for (const review of reviews) {
    for (const evidence of review.windowsRuntimeEvidence) {
      const target = packages.get(evidence.package);
      if (!target?.nativeArtifacts.some((artifact) => artifact.path === evidence.path)) {
        throw new DshSupplyChainError("dsh-native-prebuild-evidence-missing");
      }
    }
  }
  return reviews.map((review) => ({
    ...review,
    decision: "disabled-for-app-owned-stage",
    executed: false,
  }));
}

async function validateWindowsX64NativeEvidence(nodeModulesRoot, qualified = false) {
  const roots = await packageRootsForLayout(nodeModulesRoot);
  const packageRoots = new Map();
  for (const root of roots) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    } catch {
      throw new DshSupplyChainError("dsh-package-manifest-invalid");
    }
    packageRoots.set(`${manifest.name}@${manifest.version}`, root);
  }
  let checked = 0;
  for (const evidence of WINDOWS_X64_RUNTIME_EVIDENCE) {
    const name = evidence.package.slice(0, evidence.package.lastIndexOf("@"));
    const matches = [...packageRoots].filter(([identity]) => identity.slice(0, identity.lastIndexOf("@")) === name);
    // This module is absent in earlier supported official closures. If present,
    // its PE evidence is mandatory, never an optional failure bypass.
    if (qualified && name === "@deepseek-ai/libreoffice-kit-win32-x64" && matches.length === 0) continue;
    const root = qualified ? (matches.length === 1 ? matches[0][1] : undefined) : packageRoots.get(evidence.package);
    if (!root) throw new DshSupplyChainError("dsh-native-prebuild-evidence-missing");
    let evidencePath = evidence.path;
    if (qualified && name === "@img/sharp-win32-x64") {
      const version = matches[0][0].slice(matches[0][0].lastIndexOf("@") + 1);
      const paths = QUALIFIED_SHARP_WINDOWS_PATHS[version];
      const index = QUALIFIED_SHARP_WINDOWS_PATHS["0.35.5"].indexOf(evidence.path);
      if (!paths || index < 0) throw new DshSupplyChainError("dsh-native-prebuild-evidence-missing");
      evidencePath = paths[index];
    }
    validatePeX64Image(await readFile(join(root, ...evidencePath.split("/"))));
    checked += 1;
  }
  return checked;
}

export async function probeDshNativeModules({ stageRoot, expectedNodeVersion = "22.19.0", qualified = false }) {
  if (process.version !== `v${expectedNodeVersion}` || process.platform !== "win32" || process.arch !== "x64") {
    throw new DshSupplyChainError("dsh-native-probe-runtime-invalid");
  }
  try {
    const roots = await packageRootsForLayout(join(stageRoot, "host", "node_modules"));
    const byIdentity = new Map();
    for (const root of roots) {
      const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      byIdentity.set(`${manifest.name}@${manifest.version}`, root);
    }
    for (const identity of [
      "koffi@3.1.1",
      "node-pty@1.2.0-beta.15",
      "sharp@0.35.5",
      "node-addon-require-builtin@0.1.9",
    ]) {
      const name = identity.slice(0, identity.lastIndexOf("@"));
      const matches = [...byIdentity].filter(([key]) => key.slice(0, key.lastIndexOf("@")) === name);
      const packageRoot = qualified ? (matches.length === 1 ? matches[0][1] : undefined) : byIdentity.get(identity);
      if (!packageRoot) throw new Error("native-package-missing");
      createRequire(pathToFileURL(join(packageRoot, "package.json")))(packageRoot);
    }
  } catch {
    throw new DshSupplyChainError("dsh-native-load-probe-failed");
  }
  return Object.freeze({
    nodeVersion: expectedNodeVersion,
    platform: "win32",
    architecture: "x64",
    modules: ["koffi", "node-pty", "sharp", "node-addon-require-builtin"],
    startsSupervisor: false,
    opensTransport: false,
  });
}

export function buildPublishedDshRecords({ authority, dependencyAudit }) {
  const validatedAuthority = validateDshRuntimeAuthority(authority);
  const closure = validatedAuthority.dependencyClosure;
  if (
    dependencyAudit?.schemaVersion !== 1
    || dependencyAudit.platform !== validatedAuthority.nodeRuntime.platform
    || dependencyAudit.architecture !== validatedAuthority.nodeRuntime.architecture
    || dependencyAudit.packageCount !== closure.stagedPackageCount
    || dependencyAudit.installScriptsExecuted !== false
    || dependencyAudit.resolverGraph?.schemaVersion !== 1
    || dependencyAudit.entryPoint?.requestedPath !== "@deepseek-ai/dsh/lib/bin.js"
    || dependencyAudit.lockReconciliation?.schemaVersion !== 2
    || dependencyAudit.lockReconciliation?.lockedCount !== closure.packageCount
    || dependencyAudit.lockReconciliation?.stagedCount !== closure.stagedPackageCount
    || (qualifiedAuthorities.has(validatedAuthority)
      ? dependencyAudit.lockReconciliation?.mandatoryReachableCount + dependencyAudit.lockReconciliation?.optionalOnlyReachableCount !== closure.packageCount
      : dependencyAudit.lockReconciliation?.mandatoryReachableCount !== 556 || dependencyAudit.lockReconciliation?.optionalOnlyReachableCount !== 78)
    || sha256(canonicalBytes(dependencyAudit.resolverGraph)) !== closure.resolverGraphSha256
    || sha256(canonicalBytes(dependencyAudit.lockReconciliation)) !== closure.lockReconciliationSha256
    || sha256(canonicalBytes(dependencyAudit)) !== closure.installedAuditSha256
  ) {
    throw new DshSupplyChainError("dsh-installed-audit-invalid");
  }

  const nativeArtifactCount = dependencyAudit.packages.reduce(
    (total, entry) => total + entry.nativeArtifacts.length,
    0,
  );
  const resolverGraphSha256 = sha256(canonicalBytes(dependencyAudit.resolverGraph));
  const lifecycleScriptReviews = validateLifecycleScriptReviews(dependencyAudit, qualifiedAuthorities.has(validatedAuthority));
  const lifecycleScriptPackages = dependencyAudit.packages
    .filter((entry) => entry.lifecycleScripts.length > 0)
    .map((entry) => ({
      name: entry.name,
      version: entry.version,
      scripts: entry.lifecycleScripts,
      executed: false,
    }));

  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        type: "application",
        name: "LuckyRay app-owned DSH runtime closure",
        version: validatedAuthority.runtimePackage.version,
      },
      tools: {
        components: [{
          type: "application",
          name: "pnpm",
          version: validatedAuthority.packageManager.version,
          hashes: [{ alg: "SHA-256", content: validatedAuthority.packageManager.sha256 }],
        }],
      },
    },
    components: [
      {
        type: "application",
        name: "Node.js",
        version: validatedAuthority.nodeRuntime.version,
        purl: `pkg:generic/node@${validatedAuthority.nodeRuntime.version}?os=windows&arch=x64`,
        hashes: [{ alg: "SHA-256", content: validatedAuthority.nodeRuntime.nodeExeSha256 }],
        licenses: [{ expression: "MIT" }],
      },
      ...dependencyAudit.packages.map((entry) => ({
        type: "library",
        name: entry.name,
        version: entry.version,
        purl: packagePurl(entry.name, entry.version),
        hashes: [{ alg: "SHA-256", content: entry.contentSha256 }],
        licenses: [{ expression: entry.license }],
        properties: [
          { name: "luckyray:file-count", value: String(entry.fileCount) },
          { name: "luckyray:byte-count", value: String(entry.byteCount) },
          { name: "luckyray:lifecycle-script-count", value: String(entry.lifecycleScripts.length) },
          { name: "luckyray:native-artifact-count", value: String(entry.nativeArtifacts.length) },
        ],
      })),
    ],
  };

  const launchManifest = {
    schemaVersion: 1,
    integrationState: "dsh-1-blocked",
    runtimeAuthority: "npm-tarball-and-frozen-closure",
    platform: "win32",
    architecture: "x64",
    executable: "node/node.exe",
    nodeLicense: "node/LICENSE",
    hostRoot: "host",
    entryPoint: "host/node_modules/@deepseek-ai/dsh/lib/bin.js",
    systemNodeFallback: false,
    capabilityProbe: {
      arguments: ["--version"],
      expectedStdout: validatedAuthority.runtimePackage.version,
      startsSupervisor: false,
      opensTransport: false,
    },
    entryPointAuthority: dependencyAudit.entryPoint,
    processSupervisor: null,
    transport: null,
    readiness: null,
    shutdown: null,
  };

  const runtimeManifest = {
    schemaVersion: 1,
    integrationState: "supply-chain-only",
    runtimePackage: {
      name: validatedAuthority.runtimePackage.name,
      version: validatedAuthority.runtimePackage.version,
      tarballSha256: validatedAuthority.runtimePackage.sha256,
    },
    sourceReference: validatedAuthority.sourceReference,
    nodeRuntime: validatedAuthority.nodeRuntime,
    packageManager: validatedAuthority.packageManager,
    closure: {
      lockfileSha256: closure.sha256,
      lockedPackageCount: closure.packageCount,
      stagedPackageCount: closure.stagedPackageCount,
      installedAuditSha256: closure.installedAuditSha256,
      installScriptsExecuted: false,
      lifecycleScriptPackageCount: lifecycleScriptPackages.length,
      lifecycleScriptReviews,
      nativeArtifactCount,
      resolverGraphEdgeCount: dependencyAudit.resolverGraph.edgeCount,
      resolverGraphSha256,
      lockReconciliation: {
        lockedCount: dependencyAudit.lockReconciliation.lockedCount,
        stagedCount: dependencyAudit.lockReconciliation.stagedCount,
        prunedCount: dependencyAudit.lockReconciliation.prunedCount,
        mandatoryReachableCount: dependencyAudit.lockReconciliation.mandatoryReachableCount,
        optionalOnlyReachableCount: dependencyAudit.lockReconciliation.optionalOnlyReachableCount,
      },
      nativeCompatibility: {
        nodeVersion: validatedAuthority.nodeRuntime.version,
        platform: "win32",
        architecture: "x64",
        requiredPeMachine: "IMAGE_FILE_MACHINE_AMD64",
        staticEvidenceCount: WINDOWS_X64_RUNTIME_EVIDENCE.length,
        loadProbeModules: ["koffi", "node-pty", "sharp", "node-addon-require-builtin"],
        requiredBeforePublish: true,
        startsSupervisor: false,
        opensTransport: false,
      },
      upstreamPatchCount: 0,
      networkRequiredDuringStage: false,
    },
    layout: {
      node: ["node/LICENSE", "node/node.exe"],
      host: ["host/.npmrc", "host/package.json", "host/pnpm-lock.yaml", "host/pnpm-workspace.yaml", "host/node_modules"],
    },
  };

  const noticeLines = [
    "LuckyRay app-owned DSH runtime third-party notices",
    "",
    `Node.js ${validatedAuthority.nodeRuntime.version} — MIT — staged LICENSE SHA-256 ${validatedAuthority.nodeRuntime.licenseSha256}`,
    `pnpm ${validatedAuthority.packageManager.version} — MIT — build-only package manager SHA-256 ${validatedAuthority.packageManager.sha256}`,
    "",
    "Runtime package closure (install scripts were disabled):",
    ...dependencyAudit.packages.map((entry) => {
      const licenseFiles = entry.licenseFiles.length > 0
        ? entry.licenseFiles.map((file) => `${file.path}:${file.sha256}`).join(", ")
        : "metadata-only";
      return `${entry.name}@${entry.version} | ${entry.license} | ${licenseFiles}`;
    }),
    "",
    "The rc.2 source tag is retained as a separate audit identity and is not asserted as byte provenance for the rc.2 npm runtime tarball.",
    "",
  ];

  return {
    dependencyAudit,
    sbom,
    launchManifest,
    runtimeManifest,
    notice: noticeLines.join("\n"),
  };
}

export function validatePublishedDshRecords({ authority, records }) {
  let expected;
  try {
    expected = buildPublishedDshRecords({
      authority,
      dependencyAudit: records.dependencyAudit,
    });
  } catch {
    throw new DshSupplyChainError("dsh-published-records-invalid");
  }
  if (!isDeepStrictEqual(records, expected)) {
    throw new DshSupplyChainError("dsh-published-records-invalid");
  }
  return Object.freeze({
    packageCount: records.dependencyAudit.packageCount,
    nativeArtifactCount: records.runtimeManifest.closure.nativeArtifactCount,
    installScriptsExecuted: records.dependencyAudit.installScriptsExecuted,
  });
}

export async function writePublishedDshRecords({ authorityPath, nodeModulesRoot, outputDirectory }) {
  const authority = JSON.parse(await readFile(authorityPath, "utf8"));
  const validated = validateDshRuntimeAuthority(authority);
  const hostRoot = resolve(nodeModulesRoot, "..");
  const [hostPackage, lockfile, npmrc, workspacePolicy] = await Promise.all([
    readFile(join(hostRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(join(hostRoot, "pnpm-lock.yaml")),
    readFile(join(hostRoot, ".npmrc"), "utf8"),
    readFile(join(hostRoot, "pnpm-workspace.yaml")),
  ]);
  validateDshFrozenClosure({ authority: validated, hostPackage, lockfile, npmrc, workspacePolicy });
  const installedAudit = await auditInstalledClosure({
    nodeModulesRoot,
    expectedPackageCount: validated.dependencyClosure.stagedPackageCount,
    entryPoint: "@deepseek-ai/dsh/lib/bin.js",
  });
  const dependencyAudit = {
    ...installedAudit,
    lockReconciliation: reconcileLockedClosure({
      lockfile,
      stagedPackages: installedAudit.packages,
    }),
  };
  const records = buildPublishedDshRecords({ authority: validated, dependencyAudit });
  await mkdir(outputDirectory, { recursive: true });
  const jsonRecords = [
    ["dependency-audit.json", records.dependencyAudit],
    ["sbom.cdx.json", records.sbom],
    ["launch-manifest.json", records.launchManifest],
    ["runtime-manifest.json", records.runtimeManifest],
  ];
  for (const [filename, value] of jsonRecords) {
    await writeFile(join(outputDirectory, filename), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
  await writeFile(join(outputDirectory, "THIRD-PARTY-NOTICES.txt"), records.notice, "utf8");
  return validatePublishedDshRecords({ authority: validated, records });
}

async function readPublishedRecords(recordsDirectory) {
  return {
    dependencyAudit: JSON.parse(await readFile(join(recordsDirectory, "dependency-audit.json"), "utf8")),
    sbom: JSON.parse(await readFile(join(recordsDirectory, "sbom.cdx.json"), "utf8")),
    launchManifest: JSON.parse(await readFile(join(recordsDirectory, "launch-manifest.json"), "utf8")),
    runtimeManifest: JSON.parse(await readFile(join(recordsDirectory, "runtime-manifest.json"), "utf8")),
    notice: await readFile(join(recordsDirectory, "THIRD-PARTY-NOTICES.txt"), "utf8"),
  };
}

export async function rebindPublishedDshResolverGraph({ authorityPath, recordsDirectory, stageRoot }) {
  const authority = validateDshRuntimeAuthority(JSON.parse(await readFile(authorityPath, "utf8")));
  const records = await readPublishedRecords(recordsDirectory);
  validatePublishedDshRecords({ authority, records });
  return rebindResolverGraphAtFinalRoot({
    nodeModulesRoot: join(stageRoot, "host", "node_modules"),
    resolverGraph: records.dependencyAudit.resolverGraph,
  });
}

export async function verifyDshSupplyInputs({ authorityPath, nodeArchivePath, pnpmTarballPath }) {
  const authority = validateDshRuntimeAuthority(JSON.parse(await readFile(authorityPath, "utf8")));
  const [nodeArchive, pnpmTarball] = await Promise.all([
    readFile(nodeArchivePath),
    readFile(pnpmTarballPath),
  ]);
  if (
    sha256(nodeArchive) !== authority.nodeRuntime.archiveSha256
    || sha256(pnpmTarball) !== authority.packageManager.sha256
  ) {
    throw new DshSupplyChainError("dsh-supply-input-invalid");
  }
  return Object.freeze({
    nodeArchiveSha256: authority.nodeRuntime.archiveSha256,
    pnpmTarballSha256: authority.packageManager.sha256,
  });
}

export async function verifyStagedDshRuntime({ authorityPath, recordsDirectory, stageRoot }) {
  const authority = validateDshRuntimeAuthority(JSON.parse(await readFile(authorityPath, "utf8")));
  const records = await readPublishedRecords(recordsDirectory);
  validatePublishedDshRecords({ authority, records });

  const nodeExe = await readFile(join(stageRoot, "node", "node.exe"));
  const nodeLicense = await readFile(join(stageRoot, "node", "LICENSE"));
  if (
    sha256(nodeExe) !== authority.nodeRuntime.nodeExeSha256
    || sha256(nodeLicense) !== authority.nodeRuntime.licenseSha256
  ) {
    throw new DshSupplyChainError("dsh-staged-node-invalid");
  }

  const hostPackage = JSON.parse(await readFile(join(stageRoot, "host", "package.json"), "utf8"));
  const lockfile = await readFile(join(stageRoot, "host", "pnpm-lock.yaml"));
  const npmrc = await readFile(join(stageRoot, "host", ".npmrc"), "utf8");
  const workspacePolicy = await readFile(join(stageRoot, "host", "pnpm-workspace.yaml"));
  validateDshFrozenClosure({ authority, hostPackage, lockfile, npmrc, workspacePolicy });
  const nativePeImageCount = await validateWindowsX64NativeEvidence(
    join(stageRoot, "host", "node_modules"),
  );
  const stagedAudit = await auditInstalledClosure({
    nodeModulesRoot: join(stageRoot, "host", "node_modules"),
    expectedPackageCount: authority.dependencyClosure.stagedPackageCount,
    entryPoint: "@deepseek-ai/dsh/lib/bin.js",
  });
  const stagedDependencyAudit = {
    ...stagedAudit,
    lockReconciliation: reconcileLockedClosure({
      lockfile,
      stagedPackages: stagedAudit.packages,
    }),
  };
  if (!isDeepStrictEqual(stagedDependencyAudit, records.dependencyAudit)) {
    throw new DshSupplyChainError("dsh-staged-closure-invalid");
  }
  const topLevel = (await readdir(stageRoot)).sort();
  if (!isDeepStrictEqual(topLevel, ["host", "node"])) {
    throw new DshSupplyChainError("dsh-stage-layout-invalid");
  }
  return Object.freeze({
    packageCount: stagedAudit.packageCount,
    nativeArtifactCount: records.runtimeManifest.closure.nativeArtifactCount,
    nativePeImageCount,
    networkRequiredDuringStage: false,
    installScriptsExecuted: false,
  });
}

export async function verifyPortableStagedDshRuntime({ authorityPath, recordsDirectory, stageRoot, qualifiedAuthority, qualifiedRecords }) {
  const authority = validateDshRuntimeAuthority(qualifiedAuthority ?? JSON.parse(await readFile(authorityPath, "utf8")));
  const records = qualifiedRecords ?? await readPublishedRecords(recordsDirectory);
  validatePublishedDshRecords({ authority, records });
  const releaseLayout = authority.dependencyClosure.releaseLayout;

  const nodeExe = await readFile(join(stageRoot, "node", "node.exe"));
  const nodeLicense = await readFile(join(stageRoot, "node", "LICENSE"));
  if (sha256(nodeExe) !== authority.nodeRuntime.nodeExeSha256 || sha256(nodeLicense) !== authority.nodeRuntime.licenseSha256) {
    throw new DshSupplyChainError("dsh-staged-node-invalid");
  }
  const hostPackage = JSON.parse(await readFile(join(stageRoot, "host", "package.json"), "utf8"));
  const lockfile = await readFile(join(stageRoot, "host", "pnpm-lock.yaml"));
  const npmrc = await readFile(join(stageRoot, "host", ".npmrc"), "utf8");
  const workspacePolicy = await readFile(join(stageRoot, "host", "pnpm-workspace.yaml"));
  validateDshFrozenClosure({ authority, hostPackage, lockfile, npmrc, workspacePolicy });
  const portableTree = await auditPortableTree(stageRoot);
  const nativePeImageCount = await validateWindowsX64NativeEvidence(join(stageRoot, "host", "node_modules"), qualifiedAuthorities.has(authority));
  const stagedAudit = await auditPortableInstalledClosure({
    nodeModulesRoot: join(stageRoot, "host", "node_modules"),
    expectedPackageCount: authority.dependencyClosure.stagedPackageCount,
    entryPoint: "@deepseek-ai/dsh/lib/bin.js",
  });
  const expectedEntry = records.dependencyAudit.entryPoint;
  if (
    stagedAudit.physicalPackageRootCount !== releaseLayout.physicalPackageRootCount
    || stagedAudit.resolverGraph.edgeCount !== releaseLayout.resolverGraphEdgeCount
    || stagedAudit.maxRelativePathLength !== releaseLayout.maxNodeModulesRelativePathLength
    || !isDeepStrictEqual(stagedAudit.packages, records.dependencyAudit.packages)
    || stagedAudit.entryPoint.requestedPath !== expectedEntry.requestedPath
    || stagedAudit.entryPoint.targetPath !== expectedEntry.requestedPath
    || stagedAudit.entryPoint.targetPackage !== expectedEntry.targetPackage
    || stagedAudit.entryPoint.targetContentSha256 !== expectedEntry.targetContentSha256
    || stagedAudit.entryPoint.fileSha256 !== expectedEntry.fileSha256
    || portableTree.maxRelativePathLength !== releaseLayout.maxRelativePathLength
    || portableTree.fileCount !== releaseLayout.fileCount
    || portableTree.contentSha256 !== releaseLayout.contentSha256
  ) {
    throw new DshSupplyChainError("dsh-portable-closure-invalid");
  }
  const reconciliation = reconcileLockedClosure({ lockfile, stagedPackages: stagedAudit.packages });
  if (!isDeepStrictEqual(reconciliation, records.dependencyAudit.lockReconciliation)) {
    throw new DshSupplyChainError("dsh-portable-lock-reconciliation-invalid");
  }
  const topLevel = (await readdir(stageRoot)).sort();
  if (!isDeepStrictEqual(topLevel, ["host", "node"])) throw new DshSupplyChainError("dsh-stage-layout-invalid");
  return Object.freeze({
    packageCount: stagedAudit.packageCount,
    physicalPackageRootCount: stagedAudit.physicalPackageRootCount,
    nativeArtifactCount: records.runtimeManifest.closure.nativeArtifactCount,
    nativePeImageCount,
    reparsePointCount: 0,
    maxRelativePathLength: stagedAudit.maxRelativePathLength,
    networkRequiredDuringStage: false,
    installScriptsExecuted: false,
  });
}

async function runCli() {
  const [command, ...argumentsList] = process.argv.slice(2);
  const option = (name) => {
    const index = argumentsList.indexOf(name);
    if (index < 0 || index + 1 >= argumentsList.length) {
      throw new DshSupplyChainError("dsh-cli-arguments-invalid");
    }
    return resolve(argumentsList[index + 1]);
  };
  if (command === "generate-records") {
    const result = await writePublishedDshRecords({
      authorityPath: option("--authority"),
      nodeModulesRoot: option("--node-modules"),
      outputDirectory: option("--output"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "verify-inputs") {
    const result = await verifyDshSupplyInputs({
      authorityPath: option("--authority"),
      nodeArchivePath: option("--node-archive"),
      pnpmTarballPath: option("--pnpm-tarball"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "extract-pnpm") {
    const result = await extractVerifiedPnpmPackage({
      authorityPath: option("--authority"),
      pnpmTarballPath: option("--pnpm-tarball"),
      outputRoot: option("--output"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "verify-pnpm") {
    const result = await verifyExtractedPnpmPackage({
      authorityPath: option("--authority"),
      packageRoot: option("--pnpm-root"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "run-pnpm") {
    const separator = argumentsList.indexOf("--");
    if (separator < 0) throw new DshSupplyChainError("dsh-cli-arguments-invalid");
    const packageRoot = option("--pnpm-root");
    const authorityPath = option("--authority");
    const authority = validateDshRuntimeAuthority(JSON.parse(await readFile(authorityPath, "utf8")));
    await verifyExtractedPnpmPackage({ authorityPath, packageRoot });
    const entryPoint = join(packageRoot, ...authority.packageManager.extractedTree.entryPoint.split("/"));
    process.argv = [process.execPath, entryPoint, ...argumentsList.slice(separator + 1)];
    await import(pathToFileURL(entryPoint).href);
    return;
  }
  if (command === "verify-stage") {
    const result = await verifyStagedDshRuntime({
      authorityPath: option("--authority"),
      recordsDirectory: option("--records"),
      stageRoot: option("--stage"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "verify-release-stage") {
    const result = await verifyPortableStagedDshRuntime({
      authorityPath: option("--authority"),
      recordsDirectory: option("--records"),
      stageRoot: option("--stage"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "project-release-stage") {
    const result = await projectPortableDshReleaseLayout({
      stageRoot: option("--stage"),
      expectedShimCount: EXPECTED_AUTHORITY.dependencyClosure.releaseLayout.normalizedShimCount,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "project-distribution-metadata") {
    const result = await projectDshDistributionMetadata({
      nodeModulesRoot: join(option("--stage"), "host", "node_modules"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "rebind-resolvers") {
    const result = await rebindPublishedDshResolverGraph({
      authorityPath: option("--authority"),
      recordsDirectory: option("--records"),
      stageRoot: option("--stage"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "verify-detached") {
    const result = await verifyDetachedDshRuntime({ stageRoot: option("--stage") });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "native-probe") {
    const result = await probeDshNativeModules({ stageRoot: option("--stage") });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new DshSupplyChainError("dsh-cli-command-invalid");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    process.stderr.write(`${error?.code ?? "dsh-supply-chain-failed"}\n`);
    process.exitCode = 1;
  });
}

function countLockedPackages(lockfileText) {
  const packagesStart = lockfileText.indexOf("\npackages:\n");
  const snapshotsStart = lockfileText.indexOf("\nsnapshots:\n");
  if (packagesStart < 0 || snapshotsStart <= packagesStart) {
    throw new DshSupplyChainError("dsh-lockfile-invalid");
  }
  return lockfileText
    .slice(packagesStart + "\npackages:\n".length, snapshotsStart)
    .split("\n")
    .filter((line) => /^  \S.*:$/.test(line)).length;
}

function lockedPackageEntries(lockfileText) {
  const packagesStart = lockfileText.indexOf("\npackages:\n");
  const snapshotsStart = lockfileText.indexOf("\nsnapshots:\n");
  if (packagesStart < 0 || snapshotsStart <= packagesStart) {
    throw new DshSupplyChainError("dsh-lockfile-invalid");
  }
  const lines = lockfileText
    .slice(packagesStart + "\npackages:\n".length, snapshotsStart)
    .split("\n");
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^  (\S.*):$/.exec(lines[index]);
    if (!match) continue;
    const lockKey = match[1].replace(/^'(.*)'$/, "$1");
    const packageIdentity = lockKey.split("(", 1)[0];
    const metadata = [];
    for (let cursor = index + 1; cursor < lines.length && !/^  \S.*:$/.test(lines[cursor]); cursor += 1) {
      metadata.push(lines[cursor]);
    }
    const inlineList = (name) => {
      const line = metadata.find((candidate) => new RegExp(`^    ${name}: \\[[^\\]]*\\]$`).test(candidate));
      if (!line) return [];
      return line.slice(line.indexOf("[") + 1, line.lastIndexOf("]"))
        .split(",")
        .map((value) => value.trim().replace(/^'(.*)'$/, "$1"))
        .filter(Boolean);
    };
    entries.push({
      lockKey,
      packageIdentity,
      os: inlineList("os"),
      cpu: inlineList("cpu"),
    });
  }
  return entries;
}

function unquoteLockScalar(value) {
  const trimmed = String(value).trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new DshSupplyChainError("dsh-lock-graph-invalid");
    }
  }
  return trimmed;
}

function lockSectionLines(lockfileText, name) {
  const lines = lockfileText.split("\n");
  const start = lines.findIndex((line) => line === `${name}:`);
  if (start < 0) throw new DshSupplyChainError("dsh-lock-graph-invalid");
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\S/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

function mappingEntry(line, indent) {
  const match = new RegExp(`^ {${indent}}([^\\s?:](?:[^:]*\\S)?):(?: (.*))?$`).exec(line);
  if (!match) return null;
  return { key: unquoteLockScalar(match[1]), value: match[2] === undefined ? null : unquoteLockScalar(match[2]) };
}

function parseSnapshotGraph(lockfileText) {
  const graph = new Map();
  let current = null;
  let dependencyKind = null;
  let explicitKey = null;
  for (const line of lockSectionLines(lockfileText, "snapshots")) {
    const explicitStart = /^  \? (.+)$/.exec(line);
    if (explicitStart) {
      explicitKey = unquoteLockScalar(explicitStart[1]);
      current = null;
      dependencyKind = null;
      continue;
    }
    const explicitValue = /^  :(?: (.*))?$/.exec(line);
    if (explicitValue && explicitKey) {
      current = explicitKey;
      explicitKey = null;
      if (graph.has(current)) throw new DshSupplyChainError("dsh-lock-graph-invalid");
      graph.set(current, { dependencies: [], optionalDependencies: [] });
      dependencyKind = explicitValue[1] === "dependencies:"
        ? "dependencies"
        : explicitValue[1] === "optionalDependencies:"
          ? "optionalDependencies"
          : null;
      continue;
    }
    const snapshot = mappingEntry(line, 2);
    if (snapshot) {
      current = snapshot.key;
      dependencyKind = null;
      if (graph.has(current)) throw new DshSupplyChainError("dsh-lock-graph-invalid");
      graph.set(current, { dependencies: [], optionalDependencies: [] });
      continue;
    }
    if (!current) {
      if (line.trim() !== "") throw new DshSupplyChainError("dsh-lock-graph-invalid");
      continue;
    }
    const property = mappingEntry(line, 4);
    if (property) {
      dependencyKind = property.key === "dependencies" || property.key === "optionalDependencies"
        ? property.key
        : null;
      continue;
    }
    const dependency = mappingEntry(line, 6);
    if (dependency && dependencyKind) {
      if (!dependency.value) throw new DshSupplyChainError("dsh-lock-graph-invalid");
      graph.get(current)[dependencyKind].push({ name: dependency.key, reference: dependency.value });
    }
  }
  if (graph.size === 0 || explicitKey) throw new DshSupplyChainError("dsh-lock-graph-invalid");
  return graph;
}

function parseImporterRoots(lockfileText) {
  const lines = lockSectionLines(lockfileText, "importers");
  let importer = null;
  let dependencyKind = null;
  let pending = null;
  const roots = [];
  for (const line of lines) {
    const importerEntry = mappingEntry(line, 2);
    if (importerEntry) {
      importer = importerEntry.key;
      dependencyKind = null;
      pending = null;
      continue;
    }
    if (importer !== ".") continue;
    const property = mappingEntry(line, 4);
    if (property) {
      dependencyKind = property.key === "dependencies" || property.key === "optionalDependencies"
        ? property.key
        : null;
      pending = null;
      continue;
    }
    const dependency = mappingEntry(line, 6);
    if (dependency && dependencyKind) {
      if (dependency.value) {
        roots.push({ name: dependency.key, reference: dependency.value, optional: dependencyKind === "optionalDependencies" });
        pending = null;
      } else {
        pending = { name: dependency.key, optional: dependencyKind === "optionalDependencies" };
      }
      continue;
    }
    const detail = mappingEntry(line, 8);
    if (detail?.key === "version" && detail.value && pending) {
      roots.push({ ...pending, reference: detail.value });
      pending = null;
    }
  }
  if (roots.length === 0 || pending) throw new DshSupplyChainError("dsh-lock-graph-invalid");
  return roots;
}

function dependencySnapshotKey(graph, name, reference) {
  let normalized = reference;
  if (normalized.startsWith("npm:")) normalized = normalized.slice(4);
  const candidates = [normalized, `${name}@${normalized}`];
  const match = candidates.find((candidate) => graph.has(candidate));
  if (!match) throw new DshSupplyChainError("dsh-lock-graph-invalid");
  return match;
}

function packageIdentityFromLockKey(lockKey) {
  return lockKey.split("(", 1)[0];
}

function deriveLockReachability(lockfileText, lockedEntries) {
  const graph = parseSnapshotGraph(lockfileText);
  const states = new Map();
  const queue = parseImporterRoots(lockfileText).map((root) => ({
    key: dependencySnapshotKey(graph, root.name, root.reference),
    optional: root.optional,
  }));
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const item = queue[cursor];
    const existing = states.get(item.key);
    if (existing === "mandatory" || (existing === "optional-only" && item.optional)) continue;
    states.set(item.key, item.optional ? "optional-only" : "mandatory");
    const node = graph.get(item.key);
    if (!node) throw new DshSupplyChainError("dsh-lock-graph-invalid");
    for (const dependency of node.dependencies) {
      queue.push({
        key: dependencySnapshotKey(graph, dependency.name, dependency.reference),
        optional: item.optional,
      });
    }
    for (const dependency of node.optionalDependencies) {
      queue.push({
        key: dependencySnapshotKey(graph, dependency.name, dependency.reference),
        optional: true,
      });
    }
  }
  const byIdentity = new Map();
  for (const [key, state] of states) {
    const identity = packageIdentityFromLockKey(key);
    if (byIdentity.get(identity) !== "mandatory") byIdentity.set(identity, state);
  }
  const lockedIdentities = new Set(lockedEntries.map((entry) => entry.packageIdentity));
  if (
    lockedIdentities.size !== lockedEntries.length
    || [...graph].some(([key]) => !lockedIdentities.has(packageIdentityFromLockKey(key)))
    || [...lockedIdentities].some((identity) => !byIdentity.has(identity))
  ) {
    throw new DshSupplyChainError("dsh-lock-graph-invalid");
  }
  return byIdentity;
}

function targetMatches(values, target) {
  if (values.includes(`!${target}`)) return false;
  const positive = values.filter((value) => !value.startsWith("!"));
  return positive.length === 0 || positive.includes(target);
}

export function reconcileLockedClosure({ lockfile, stagedPackages }) {
  const lockfileText = Buffer.isBuffer(lockfile) ? lockfile.toString("utf8") : String(lockfile);
  const locked = lockedPackageEntries(lockfileText);
  const reachability = deriveLockReachability(lockfileText, locked);
  const stagedIdentities = new Set(stagedPackages.map((entry) => `${entry.name}@${entry.version}`));
  const staged = [];
  const pruned = [];
  for (const entry of locked) {
    const packageReachability = reachability.get(entry.packageIdentity);
    const record = {
      lockKey: entry.lockKey,
      packageIdentity: entry.packageIdentity,
      reachability: packageReachability,
    };
    if (stagedIdentities.has(entry.packageIdentity)) {
      if (!targetMatches(entry.os, "win32") || !targetMatches(entry.cpu, "x64")) {
        throw new DshSupplyChainError("dsh-lock-reconciliation-invalid");
      }
      staged.push(record);
      continue;
    }
    const reason = !targetMatches(entry.os, "win32")
      ? "platform-not-win32"
      : !targetMatches(entry.cpu, "x64")
        ? "architecture-not-x64"
        : packageReachability === "optional-only"
          ? "optional-transitive-not-selected"
          : null;
    if (reason === null) throw new DshSupplyChainError("dsh-mandatory-package-not-staged");
    pruned.push({ ...record, reason });
  }
  if (
    locked.length !== staged.length + pruned.length
    || staged.length !== stagedIdentities.size
    || staged.some((entry, index) => staged.findIndex((candidate) => candidate.packageIdentity === entry.packageIdentity) !== index)
  ) {
    throw new DshSupplyChainError("dsh-lock-reconciliation-invalid");
  }
  return {
    schemaVersion: 2,
    platform: "win32",
    architecture: "x64",
    lockedCount: locked.length,
    stagedCount: staged.length,
    prunedCount: pruned.length,
    mandatoryReachableCount: [...reachability.values()].filter((value) => value === "mandatory").length,
    optionalOnlyReachableCount: [...reachability.values()].filter((value) => value === "optional-only").length,
    staged,
    pruned,
  };
}

export function validateAuthenticatedWorkspacePolicy(workspacePolicy, installPolicy) {
  const workspacePolicyBytes = Buffer.isBuffer(workspacePolicy)
    ? workspacePolicy
    : Buffer.from(workspacePolicy ?? "");
  const workspacePolicyText = workspacePolicyBytes.toString("utf8");
  if (
    !Buffer.from(workspacePolicyText, "utf8").equals(workspacePolicyBytes)
    || workspacePolicyText.includes("\r")
    || workspacePolicyText.startsWith("\uFEFF")
  ) {
    throw new DshSupplyChainError("dsh-host-policy-invalid");
  }

  const lines = workspacePolicyText.endsWith("\n")
    ? workspacePolicyText.slice(0, -1).split("\n")
    : [];
  const requiredHeader = [
    "packages: []",
    "minimumReleaseAge: 1440",
    "minimumReleaseAgeStrict: true",
    "minimumReleaseAgeIgnoreMissingTime: false",
  ];
  if (
    lines.length !== requiredHeader.length
    || !requiredHeader.every((line, index) => lines[index] === line)
    || installPolicy?.minimumReleaseAge !== 1440
    || installPolicy?.minimumReleaseAgeStrict !== true
    || installPolicy?.minimumReleaseAgeIgnoreMissingTime !== false
    || installPolicy?.missingReleaseTimeBehavior !== "reject"
  ) {
    throw new DshSupplyChainError("dsh-host-policy-invalid");
  }

  return Object.freeze({
    minimumReleaseAge: 1440,
    minimumReleaseAgeStrict: true,
    minimumReleaseAgeIgnoreMissingTime: false,
    missingReleaseTimeBehavior: "reject",
    exclusionCount: 0,
  });
}

export function validateDshFrozenClosure({ authority, hostPackage, lockfile, npmrc, workspacePolicy }) {
  const validatedAuthority = validateDshRuntimeAuthority(authority);
  const expectedHost = qualifiedAuthorities.has(validatedAuthority) ? frozenHostTemplate(validatedAuthority.runtimePackage.version) : EXPECTED_HOST_PACKAGE;
  if (!isDeepStrictEqual(hostPackage, expectedHost)) {
    throw new DshSupplyChainError("dsh-host-package-invalid");
  }
  if (typeof npmrc !== "string" || npmrc.replaceAll("\r\n", "\n") !== EXPECTED_NPMRC) {
    throw new DshSupplyChainError("dsh-host-policy-invalid");
  }
  const workspacePolicyBytes = Buffer.isBuffer(workspacePolicy)
    ? workspacePolicy
    : Buffer.from(workspacePolicy ?? "");
  validateAuthenticatedWorkspacePolicy(
    workspacePolicyBytes,
    validatedAuthority.packageManager.installPolicy,
  );
  if (sha256(workspacePolicyBytes) !== validatedAuthority.packageManager.installPolicy.workspacePolicySha256) {
    throw new DshSupplyChainError("dsh-host-policy-invalid");
  }

  const lockfileBytes = Buffer.isBuffer(lockfile) ? lockfile : Buffer.from(lockfile);
  const lockfileText = lockfileBytes.toString("utf8");
  const closure = validatedAuthority.dependencyClosure;
  const runtime = validatedAuthority.runtimePackage;
  const requiredRuntimeEntry = `  '${runtime.name}@${runtime.version}':\n    resolution: {integrity: ${runtime.registryIntegrity}}`;
  const packageCount = countLockedPackages(lockfileText);
  const invalidReference = /(?:patchedDependencies:|\b(?:link|file|workspace|git\+|github:|https?:):)/;

  if (
    sha256(lockfileBytes) !== closure.sha256
    || !lockfileText.startsWith(`lockfileVersion: '${closure.lockfileVersion}'\n`)
    || !lockfileText.includes(requiredRuntimeEntry)
    || invalidReference.test(lockfileText)
    || packageCount !== closure.packageCount
  ) {
    throw new DshSupplyChainError("dsh-lockfile-invalid");
  }

  return Object.freeze({
    lockfileVersion: closure.lockfileVersion,
    packageCount,
    upstreamPatchCount: validatedAuthority.policy.upstreamPatchCount,
  });
}
