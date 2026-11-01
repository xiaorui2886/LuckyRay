// Product notices and corresponding-source staging for the frozen Mac DSH.
// No package scripts or packaged runtime binaries are executed here.
import { join, relative, resolve, sep } from "node:path";
import { APP, directory, readRegular, writeNew, jsonNew, sha256, download } from "./macos-build-common.mjs";
import { NODE_INPUT } from "./prepare-macos-node-input.mjs";

const MATERIALS = join(APP, "third-party-notices/macos-dsh");
const validDigest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function machoMinimumVersion(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf
      || bytes.readUInt32LE(4) !== 0x0100000c) throw new Error("macos-runtime-macho-invalid");
  const count = bytes.readUInt32LE(16); const end = 32 + bytes.readUInt32LE(20);
  if (count > 8192 || end > bytes.length) throw new Error("macos-runtime-load-commands-invalid");
  let offset = 32; let version = null;
  for (let i = 0; i < count; i++) {
    if (offset + 8 > end) throw new Error("macos-runtime-load-commands-invalid");
    const command = bytes.readUInt32LE(offset); const size = bytes.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > end) throw new Error("macos-runtime-load-commands-invalid");
    if (command === 0x32 || command === 0x24) {
      if (size < (command === 0x32 ? 24 : 16) || version !== null
          || (command === 0x32 && bytes.readUInt32LE(offset + 8) !== 1))
        throw new Error("macos-runtime-platform-version-invalid");
      const encoded = bytes.readUInt32LE(offset + (command === 0x32 ? 12 : 8));
      version = [encoded >>> 16, (encoded >>> 8) & 255, encoded & 255];
    }
    offset += size;
  }
  if (offset !== end || version === null) throw new Error("macos-runtime-platform-version-missing");
  return version.join(".");
}

export async function checkFrozenDshMinimum({ packageRoots, appMinimum }) {
  if (typeof appMinimum !== "string" || !/^\d+\.\d+(?:\.\d+)?$/.test(appMinimum))
    throw new Error("macos-app-minimum-invalid");
  const allowed = appMinimum.split(".").map(Number); while (allowed.length < 3) allowed.push(0);
  const inputs = [
    { name: "node-addon-require-builtin-darwin-arm64", version: "0.1.9", path: "prebuilt/darwin-arm64-napi-v9.node",
      sha256: "93947abf5edc337b9b2b20267e1b99a26a3a5616dc857f1c2b67122d0057c752" },
    { name: "sherpa-onnx-darwin-arm64", version: "1.13.8", path: "sherpa-onnx.node",
      sha256: "e37e09b2b21e0b07abf0c37d7423884a8ff161fdba8c67407bc99bfe99af8a55" },
  ];
  const result = [];
  for (const input of inputs) {
    const roots = packageRoots.filter(item => item.name === input.name && item.version === input.version);
    if (roots.length !== 1) throw new Error("macos-runtime-minimum-input-ambiguous");
    const bytes = await readRegular(join(roots[0].path, input.path));
    if (sha256(bytes) !== input.sha256) throw new Error("macos-runtime-minimum-input-changed");
    const minimum = machoMinimumVersion(bytes); const wanted = minimum.split(".").map(Number);
    const difference = wanted.map((part, index) => part - allowed[index]).find(value => value !== 0) ?? 0;
    if (difference > 0) throw new Error(`macos-frozen-runtime-requires-${minimum}:${input.name}`);
    result.push({ ...input, minimum });
  }
  return { appMinimum, evidence: "actual frozen Mach-O load commands; no Runner version inference", modules: result };
}
function localPath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")
      || value.startsWith("/") || value.split("/").some(part => !part || part === "." || part === ".."))
    throw new Error("macos-distribution-path-invalid");
  return value;
}
async function originalBody(descriptor) {
  if (!validDigest(descriptor.sha256) || descriptor.path !== `bodies/${descriptor.sha256}.txt`
      || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1 || descriptor.bytes > 8 * 1024 * 1024)
    throw new Error("macos-distribution-body-descriptor-invalid");
  const bytes = await readRegular(join(MATERIALS, descriptor.path), 8 * 1024 * 1024);
  if (bytes.length !== descriptor.bytes || sha256(bytes) !== descriptor.sha256)
    throw new Error("macos-distribution-body-changed");
  return bytes;
}
function materialBodyDescriptors(input) {
  const result = new Map(); const queue = [input];
  for (let i = 0; i < queue.length; i++) {
    if (i > 100000) throw new Error("macos-distribution-input-budget");
    const value = queue[i];
    if (value === null || typeof value !== "object") continue;
    if (typeof value.path === "string" && value.path.startsWith("bodies/")) {
      if (!validDigest(value.sha256) || value.path !== `bodies/${value.sha256}.txt`)
        throw new Error("macos-distribution-body-descriptor-invalid");
      const previous = result.get(value.sha256);
      if (previous && previous.bytes !== value.bytes) throw new Error("macos-distribution-body-ambiguous");
      result.set(value.sha256, value);
    }
    queue.push(...Object.values(value));
  }
  return result;
}

export async function prepareDshDistribution({ dshRoot, audit, packageRoots, nodeLicense }) {
  if (audit.platform !== "darwin" || audit.architecture !== "arm64" || audit.packageCount !== 564
      || audit.installScriptsExecuted !== false || audit.packages.length !== audit.packageCount)
    throw new Error("macos-distribution-closure-invalid");
  if (sha256(nodeLicense) !== NODE_INPUT.licenseSha256) throw new Error("macos-distribution-node-license-invalid");
  const manifestBytes = await readRegular(join(MATERIALS, "INDEX.json"), 4 * 1024 * 1024);
  const input = JSON.parse(manifestBytes.toString());
  if (input.schemaVersion !== 1 || input.platform !== "darwin" || input.architecture !== "arm64"
      || input.packageCount !== audit.packageCount || input.runtimeVersion !== "0.2.1-rc.3")
    throw new Error("macos-distribution-input-invalid");
  const root = join(dshRoot, "distribution");
  await directory(root);
  for (const path of ["notices", "notices/bodies", "sources", "sources/archives", "sources/recipes", "sources/packaged"])
    await directory(join(root, path));
  const bodies = new Map();
  async function preserve(bytes) {
    const digest = sha256(bytes);
    if (!bodies.has(digest)) {
      await writeNew(join(root, "notices/bodies", `${digest}.txt`), bytes);
      bodies.set(digest, { path: `notices/bodies/${digest}.txt`, sha256: digest, bytes: bytes.length });
    }
    return bodies.get(digest);
  }
  for (const descriptor of materialBodyDescriptors(input).values()) await preserve(await originalBody(descriptor));
  const supplements = new Map(input.missingStandaloneNoticeGrants.map(item => [item.identity, item]));
  if (supplements.size !== 17 || supplements.size !== input.missingStandaloneNoticeGrants.length)
    throw new Error("macos-distribution-grant-set-invalid");
  const usedSupplements = new Set();
  const packages = [];
  const nm = resolve(dshRoot, "host/node_modules");
  for (const pkg of audit.packages) {
    const identity = `${pkg.name}@${pkg.version}`;
    const roots = packageRoots.filter(item => item.name === pkg.name && item.version === pkg.version);
    if (!roots.length) throw new Error("macos-distribution-package-missing");
    const documents = [];
    let manifest;
    for (const found of roots) {
      const path = resolve(found.path);
      if (!path.startsWith(`${nm}${sep}`)) throw new Error("macos-distribution-package-path-invalid");
      const bytes = await readRegular(join(path, "package.json"), 1024 * 1024);
      const item = JSON.parse(bytes.toString());
      if (item.name !== pkg.name || item.version !== pkg.version || item.license !== pkg.license)
        throw new Error("macos-distribution-package-identity-invalid");
      manifest = item;
      for (const file of pkg.licenseFiles) {
        const bytes = await readRegular(join(path, localPath(file.path)), 8 * 1024 * 1024);
        if (sha256(bytes) !== file.sha256 || bytes.length !== file.size)
          throw new Error("macos-distribution-original-notice-changed");
        documents.push({ ...await preserve(bytes), sourceKind: "original published file",
          originalPath: `host/node_modules/${relative(nm, path).split(sep).join("/")}/${file.path}` });
      }
      if (pkg.licenseFiles.length === 0) {
        const supplied = supplements.get(identity);
        if (!supplied || supplied.contentSha256 !== pkg.contentSha256 || supplied.license !== pkg.license
            || supplied.manifestSha256 !== sha256(bytes)) throw new Error("macos-distribution-unreviewed-grant");
        usedSupplements.add(identity);
        documents.push({ ...await preserve(bytes), sourceKind: "exact published manifest license grant and attribution" });
        const standard = input.standardTexts[supplied.standardLicense];
        if (!standard) throw new Error("macos-distribution-grant-text-missing");
        documents.push({ ...await preserve(await originalBody(standard)), ...standard,
          path: `notices/bodies/${standard.sha256}.txt` });
        for (const notice of supplied.additionalNotices) documents.push({ ...notice,
          ...await preserve(await originalBody(notice)) });
      }
    }
    packages.push({ identity, license: pkg.license, contentSha256: pkg.contentSha256,
      source: { installedLocations: roots.map(item => `host/node_modules/${relative(nm, item.path).split(sep).join("/")}`),
        publishedMetadataReference: `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`,
        repositoryAsPublished: manifest.repository ?? null,
        scope: "Published package files are retained. Native/copy-left preferred-source completeness is tracked separately; a repository reference is not supplied source." },
      originalAttribution: Object.fromEntries(["author", "contributors", "copyright", "repository", "homepage"]
        .filter(key => manifest[key] !== undefined).map(key => [key, manifest[key]])), documents });
  }
  if (usedSupplements.size !== supplements.size) throw new Error("macos-distribution-grant-set-changed");
  const standards = [];
  for (const [license, descriptor] of Object.entries(input.standardTexts))
    standards.push({ license, ...descriptor, ...await preserve(await originalBody(descriptor)) });
  const componentNotices = [];
  for (const component of input.components) {
    if (component.linkedPayload) {
      const split = component.binaryPackage.lastIndexOf("@");
      const name = component.binaryPackage.slice(0, split); const version = component.binaryPackage.slice(split + 1);
      const found = packageRoots.filter(item => item.name === name && item.version === version);
      if (split <= 0 || found.length !== 1 || !validDigest(component.linkedPayload.sha256)
          || sha256(await readRegular(join(found[0].path, localPath(component.linkedPayload.path)))) !== component.linkedPayload.sha256)
        throw new Error("macos-distribution-component-payload-changed");
    }
    const documents = [];
    for (const descriptor of component.noticeBodies) documents.push({ ...descriptor,
      ...await preserve(await originalBody(descriptor)) });
    componentNotices.push({ ...component, documents, noticeBodies: undefined });
  }
  const ortRoot = packageRoots.find(item => item.name === "sherpa-onnx-darwin-arm64" && item.version === "1.13.8");
  if (!ortRoot || sha256(await readRegular(join(ortRoot.path, "libonnxruntime.dylib"))) !== input.onnxRuntime.payloadDylibSha256)
    throw new Error("macos-distribution-onnx-payload-changed");
  const onnxDocuments = [];
  for (const descriptor of input.onnxRuntime.notices) onnxDocuments.push({ ...descriptor,
    ...await preserve(await originalBody(descriptor)) });
  await preserve(nodeLicense);
  // The engine package carries extra legal files with component-specific names
  // and preferred engine source. Retain and index them, in addition to the
  // original files already present in node_modules.
  const lo = packageRoots.find(item => item.name === "@deepseek-ai/libreoffice-kit-darwin-arm64" && item.version === "0.1.5");
  if (!lo) throw new Error("macos-distribution-office-missing");
  const prebuilds = JSON.parse((await readRegular(join(lo.path, "prebuilds.json"))).toString());
  const engineDocuments = [];
  for (const descriptor of prebuilds.licenses) {
    const path = localPath(descriptor.path);
    engineDocuments.push({ ...descriptor, originalPath: `host/node_modules/${relative(nm, lo.path).split(sep).join("/")}/${path}`,
      ...await preserve(await readRegular(join(lo.path, path), 8 * 1024 * 1024)) });
  }
  const packagedSources = [];
  for (const path of [...new Set(["sources/core.json", "sources/core-source.json", "sources/core-changes.patch", "sources/payload-shaping.json", ...prebuilds.source.files])]) {
    localPath(path);
    if (!path.startsWith("sources/")) throw new Error("macos-distribution-office-source-path-invalid");
    const bytes = await readRegular(join(lo.path, path), 16 * 1024 * 1024);
    const destination = `sources/packaged/${path.slice("sources/".length)}`;
    // Paths and bytes are from the exact audited npm package; no source script
    // is run and no external preferred-source completeness is inferred.
    await directory(join(root, ...destination.split("/").slice(0, -1)));
    await writeNew(join(root, destination), bytes);
    packagedSources.push({ path: destination, sha256: sha256(bytes), bytes: bytes.length });
  }
  const sources = []; const missing = [];
  const ids = new Set();
  for (const source of input.sourceInputs) {
    if (typeof source.id !== "string" || !/^[a-z0-9-]+$/.test(source.id) || ids.has(source.id))
      throw new Error("macos-distribution-source-identity-invalid");
    ids.add(source.id);
    if (source.sha256 === null) {
      if (source.required) missing.push({ id: source.id, reason: source.reason });
      sources.push({ ...source, provided: false }); continue;
    }
    if (!validDigest(source.sha256) || !/^https:\/\//.test(source.url) || !Number.isSafeInteger(source.bytes)
        || source.bytes < 1 || source.bytes > 512 * 1024 * 1024)
      throw new Error("macos-distribution-source-unpinned");
    const file = await download(source);
    const bytes = await readRegular(file);
    if (bytes.length !== source.bytes || sha256(bytes) !== source.sha256)
      throw new Error("macos-distribution-source-changed");
    const destination = `sources/archives/${source.id}-${source.sha256}.source`;
    await writeNew(join(root, destination), bytes);
    sources.push({ ...source, provided: true, path: destination, notices: undefined });
  }
  for (const recipe of input.recipes) {
    localPath(recipe.path);
    const bytes = await readRegular(join(MATERIALS, recipe.path), 1024 * 1024);
    if (sha256(bytes) !== recipe.sha256 || bytes.length !== recipe.bytes)
      throw new Error("macos-distribution-recipe-changed");
    const destination = `sources/${recipe.path}`;
    await directory(join(root, ...destination.split("/").slice(0, -1)));
    await writeNew(join(root, destination), bytes);
  }
  for (const requirement of input.additionalUnresolvedRequirements) if (requirement.required)
    missing.push({ id: requirement.id, reason: requirement.reason });
  const index = { schemaVersion: 1, platform: "darwin", architecture: "arm64", packageCount: packages.length,
    originalFilesUnmodified: true, node: { version: NODE_INPUT.version, licenseSha256: NODE_INPUT.licenseSha256 },
    packages, documentBodies: [...bodies.values()], standardTexts: standards, components: componentNotices, onnxRuntime: { ...input.onnxRuntime, notices: onnxDocuments },
    libreoffice: { documents: engineDocuments, packagedSources }, sources, recipes: input.recipes,
    sourceInputsSha256: sha256(manifestBytes), readyToPackage: missing.length === 0, missingRequirements: missing };
  await jsonNew(join(root, "index.json"), index);
  await writeNew(join(root, "REBUILDING.md"), await readRegular(join(MATERIALS, "REBUILDING.md")));
  const lines = ["# LuckyRay macOS DSH third party notices", "",
    "LuckyRay-owned code retains its MIT license. Every third-party component retains its original terms.",
    "Original notices remain in host/node_modules and node/LICENSE. Hash-addressed verbatim copies and exact grant attributions are indexed in distribution/index.json.",
    "Standard license text supplements explicitly identified published grants; no copyright holder or year has been invented.", "",
    "libvips and its LGPL libraries are used by sharp. Both LGPL and GPL full texts are in distribution/notices/bodies; their exact paths are in index.json.",
    "The frozen Sherpa C API also contains eSpeak NG under GPLv3. Its original license and source are indexed separately; the npm Apache declaration does not replace that component's terms.",
    "The AOM patent license and original upstream component selections are retained. No separate patent, warranty, source-hosting or support promise is added.", "",
    ...packages.map(pkg => `- ${pkg.identity}: ${pkg.license}`), "",
    "## Source and modification materials", "",
    "distribution/sources contains the provided source archives, upstream patches, recipes and packaged engine source; index.json maps them to components.",
    "See distribution/REBUILDING.md for build/relink and replacement instructions. A reference URL without provided verified bytes is marked missing, never counted as supplied source.",
    ...(missing.length ? ["", "This build stage is incomplete and cannot be packaged for distribution:", ...missing.map(item => `- ${item.id}: ${item.reason}`)] : []), ""];
  await writeNew(join(dshRoot, "THIRD-PARTY-NOTICES.md"), lines.join("\n"));
  return { schemaVersion: 1, packageCount: packages.length, sourceInputsSha256: index.sourceInputsSha256,
    readyToPackage: index.readyToPackage, missingRequirements: missing, index: "distribution/index.json" };
}

// Internal native validation may inspect an incomplete source set. It still
// verifies every supplied byte and derives the missing set from reviewed input;
// an edited ready flag or an omitted requirement never grants export approval.
export async function inspectDshDistribution(dshRoot) {
  const record = JSON.parse((await readRegular(join(dshRoot, "distribution/index.json"), 8 * 1024 * 1024)).toString());
  const inputBytes = await readRegular(join(MATERIALS, "INDEX.json"), 4 * 1024 * 1024);
  const input = JSON.parse(inputBytes.toString());
  const missing = input.sourceInputs.filter(item => item.required && item.sha256 === null)
    .map(item => ({ id: item.id, reason: item.reason }));
  for (const item of input.additionalUnresolvedRequirements) if (item.required)
    missing.push({ id: item.id, reason: item.reason });
  const ready = missing.length === 0;
  if (record.schemaVersion !== 1 || record.platform !== "darwin" || record.architecture !== "arm64"
      || record.readyToPackage !== ready || JSON.stringify(record.missingRequirements) !== JSON.stringify(missing)
      || record.sourceInputsSha256 !== sha256(inputBytes)
      || !Array.isArray(record.sources) || record.sources.length !== input.sourceInputs.length)
    throw new Error("macos-dsh-distribution-materials-incomplete");
  let providedSourceInputs = 0; let providedSourceBytes = 0;
  for (const source of input.sourceInputs) {
    if (!/^[a-z0-9-]+$/.test(source.id)) throw new Error("macos-distribution-source-identity-invalid");
    const supplied = record.sources.filter(item => item.id === source.id);
    if (supplied.length !== 1 || supplied[0].sha256 !== source.sha256 || supplied[0].bytes !== source.bytes
        || supplied[0].url !== source.url || supplied[0].required !== source.required)
      throw new Error("macos-dsh-corresponding-source-missing");
    if (source.sha256 === null) {
      if (supplied[0].provided !== false || supplied[0].path !== undefined)
        throw new Error("macos-dsh-corresponding-source-missing");
      continue;
    }
    if (!validDigest(source.sha256)) throw new Error("macos-distribution-source-unpinned");
    const expected = `sources/archives/${source.id}-${source.sha256}.source`;
    if (supplied[0].provided !== true || supplied[0].path !== expected)
      throw new Error("macos-dsh-corresponding-source-missing");
    const bytes = await readRegular(join(dshRoot, "distribution", expected));
    if (bytes.length !== source.bytes || sha256(bytes) !== source.sha256)
      throw new Error("macos-dsh-corresponding-source-changed");
    providedSourceInputs++; providedSourceBytes += bytes.length;
  }
  for (const recipe of input.recipes) {
    const bytes = await readRegular(join(dshRoot, "distribution/sources", localPath(recipe.path)), 1024 * 1024);
    if (bytes.length !== recipe.bytes || sha256(bytes) !== recipe.sha256)
      throw new Error("macos-distribution-recipe-changed");
  }
  for (const descriptor of materialBodyDescriptors(input).values()) {
    const bytes = await readRegular(join(dshRoot, "distribution/notices/bodies", `${descriptor.sha256}.txt`), 8 * 1024 * 1024);
    if (bytes.length !== descriptor.bytes || sha256(bytes) !== descriptor.sha256)
      throw new Error("macos-dsh-distributed-license-changed");
  }
  return { sourceInputsSha256: record.sourceInputsSha256, readyToPackage: ready,
    missingRequirements: missing, providedSourceInputs, providedSourceBytes };
}

export async function assertDshDistributionReady(dshRoot) {
  const result = await inspectDshDistribution(dshRoot);
  if (!result.readyToPackage) throw new Error("macos-dsh-distribution-materials-incomplete");
  return result.sourceInputsSha256;
}
