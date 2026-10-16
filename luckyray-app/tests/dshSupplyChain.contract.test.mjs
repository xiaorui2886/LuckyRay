import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  auditInstalledClosure,
  auditPortableInstalledClosure,
  projectPortableDshReleaseLayout,
  extractStrictPnpmTarGzip,
  extractVerifiedPnpmPackage,
  rebindResolverGraphAtFinalRoot,
  reconcileLockedClosure,
  validatePublishedDshRecords,
  validatePeX64Image,
  verifyDshSupplyInputs,
  verifyDetachedDshRuntime,
  verifyExtractedPnpmPackage,
  verifyStagedDshRuntime,
  validateAuthenticatedWorkspacePolicy,
  validateDshFrozenClosure,
  validateDshRuntimeAuthority,
} from "../scripts/dsh-supply-chain.mjs";
import {
  buildDshTestChildEnvironment,
  DSH_PRODUCTION_TEST_IDS,
  resolveProductionPrepareScript,
  runTestInventoryGate,
} from "../scripts/run-dsh-supply-chain-gate.mjs";

const authorityUrl = new URL("../dsh-host/runtime-authority.json", import.meta.url);
const hostPackageUrl = new URL("../dsh-host/package.json", import.meta.url);
const lockfileUrl = new URL("../dsh-host/pnpm-lock.yaml", import.meta.url);
const npmrcUrl = new URL("../dsh-host/.npmrc", import.meta.url);
const workspacePolicyUrl = new URL("../dsh-host/pnpm-workspace.yaml", import.meta.url);
const recordsUrl = new URL("../dsh-host/records/", import.meta.url);

function tarOctal(value, length) {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function tarHeader({
  name = "package/index.js",
  size = 0,
  type = "0",
  prefix = "",
  magic = "ustar\0",
  version = "00",
  linkName = "",
} = {}) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(tarOctal(size, 12), 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write(linkName, 157, 100, "utf8");
  header.write(magic, 257, 6, "binary");
  header.write(version, 263, 2, "ascii");
  header.write(prefix, 345, 155, "utf8");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function strictTarGzip(entries, { trailing = Buffer.alloc(0), endBlocks = 2 } = {}) {
  const chunks = [];
  for (const entry of entries) {
    const bytes = entry.bytes ?? Buffer.alloc(entry.size ?? 0);
    chunks.push(tarHeader({ ...entry, size: entry.size ?? bytes.length }), bytes);
    const padding = (512 - (bytes.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(512 * endBlocks), trailing);
  return gzipSync(Buffer.concat(chunks));
}

const productionFixture = process.env.DSH_NODE_ARCHIVE
  && process.env.DSH_PNPM_TARBALL
  && process.env.DSH_OFFLINE_STORE
  ? {
      nodeArchive: process.env.DSH_NODE_ARCHIVE,
      pnpmTarball: process.env.DSH_PNPM_TARBALL,
      offlineStore: process.env.DSH_OFFLINE_STORE,
    }
  : null;
const existingStageFixture = process.env.DSH_EXISTING_STAGE ?? null;
if (process.env.DSH_REQUIRE_PRODUCTION_FIXTURES === "1" && (!productionFixture || !existingStageFixture)) {
  throw new Error("dsh-production-fixtures-required");
}

function runPowerShell(script, argumentsList, environment = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("pwsh.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      ...argumentsList,
    ], {
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("exit", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

dshProductionTest(DSH_PRODUCTION_TEST_IDS.tarStrictDialect, "app-owned TAR dialect rejects unsupported semantics before writing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "luckyray-dsh-strict-tar-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let caseIndex = 0;
  const rejects = async (label, archive, code = "dsh-pnpm-tar-policy-invalid") => {
    const outputRoot = join(root, `case-${caseIndex += 1}`);
    await assert.rejects(
      extractStrictPnpmTarGzip({ archive, outputRoot }),
      { code },
      label,
    );
    await assert.rejects(readdir(outputRoot), { code: "ENOENT" }, `${label}: output must not exist`);
  };

  const validOutput = join(root, "valid");
  await extractStrictPnpmTarGzip({
    archive: strictTarGzip([{ name: "package/index.js", bytes: Buffer.from("export {};\n") }]),
    outputRoot: validOutput,
  });
  assert.equal(await readFile(join(validOutput, "package", "index.js"), "utf8"), "export {};\n");

  await rejects("USTAR prefix", strictTarGzip([{ prefix: "shadow" }]));
  await rejects("wrong magic", strictTarGzip([{ magic: "ustar " }]));
  await rejects("wrong version", strictTarGzip([{ version: "01" }]));
  await rejects("link name on regular file", strictTarGzip([{ linkName: "package/other" }]));

  for (const type of ["1", "2", "3", "4", "5", "6", "7", "x", "g", "L", "K", "S", "9"]) {
    await rejects(`unsupported TAR type ${type}`, strictTarGzip([{ type }]));
  }

  for (const name of [
    "/package/absolute",
    "C:/package/drive",
    "//server/share/file",
    "package\\mixed",
    "package/../escape",
    "package/./dot",
    "package/file:stream",
    "package/bad?.js",
    "package/bad*.js",
    "package/bad<.js",
    "package/bad>.js",
    "package/bad|.js",
    "package/bad\".js",
    "package/trailing.",
    "package/trailing ",
    "package/CON",
    "package/nul.txt",
    "package/COM1.js",
    "package/CLOCK$",
    "package/CONIN$",
    "package/CONOUT$",
    `package/${Array.from({ length: 34 }, () => "a").join("/")}`,
  ]) {
    await rejects(`unsafe Windows path ${JSON.stringify(name)}`, strictTarGzip([{ name }]));
  }
  await rejects("embedded NUL", strictTarGzip([{ name: "package/good\0hidden" }]));
  await rejects("case-fold collision", strictTarGzip([
    { name: "package/Readme.md" },
    { name: "package/README.md" },
  ]));
  await rejects("duplicate path", strictTarGzip([
    { name: "package/a" },
    { name: "package/a" },
  ]));
  await rejects("file-directory collision", strictTarGzip([
    { name: "package/a" },
    { name: "package/a/b" },
  ]));
  await rejects("directory-file collision", strictTarGzip([
    { name: "package/a/b" },
    { name: "package/a" },
  ]));

  const badChecksum = gunzipSync(strictTarGzip([{ name: "package/checksum" }]));
  badChecksum[0] ^= 1;
  await rejects("header checksum", gzipSync(badChecksum), "dsh-pnpm-extract-invalid");
  await rejects("truncated gzip", strictTarGzip([{ name: "package/truncated" }]).subarray(0, 20), "dsh-pnpm-extract-invalid");
  await rejects("missing second zero block", strictTarGzip([{ name: "package/end" }], { endBlocks: 1 }), "dsh-pnpm-extract-invalid");
  await rejects("trailing garbage", strictTarGzip([{ name: "package/end" }], { trailing: Buffer.from([1]) }), "dsh-pnpm-extract-invalid");
  await rejects("truncated file body", strictTarGzip([{ name: "package/body", size: 1024, bytes: Buffer.alloc(1) }]), "dsh-pnpm-extract-invalid");

  await rejects(
    "compressed byte limit",
    Buffer.alloc(32 * 1024 * 1024 + 1),
    "dsh-pnpm-tar-resource-limit",
  );
  await rejects(
    "uncompressed byte limit",
    gzipSync(Buffer.alloc(32 * 1024 * 1024 + 1)),
    "dsh-pnpm-tar-resource-limit",
  );
  await rejects(
    "entry count limit",
    strictTarGzip(Array.from({ length: 1025 }, (_, index) => ({ name: `package/f${index}` }))),
    "dsh-pnpm-tar-resource-limit",
  );
  await rejects(
    "single entry size limit",
    strictTarGzip([{ name: "package/large", size: 16 * 1024 * 1024 + 1 }]),
    "dsh-pnpm-tar-resource-limit",
  );
});

function runNode(script, argumentsList = [], environment = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [script, ...argumentsList], {
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("exit", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function runExecutable(executable, argumentsList = [], environment = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, argumentsList, {
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("exit", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function productionPrepareScript() {
  return resolveProductionPrepareScript(process.env);
}

function dshProductionTest(id, name, optionsOrHandler, maybeHandler) {
  return maybeHandler === undefined
    ? test(`[${id}] ${name}`, optionsOrHandler)
    : test(`[${id}] ${name}`, optionsOrHandler, maybeHandler);
}

async function hashRegularFileTree(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await hashRegularFileTree(root, absolute));
    } else if (entry.isFile()) {
      files.push({
        path: absolute.slice(root.length + 1).replaceAll("\\", "/"),
        sha256: createHash("sha256").update(await readFile(absolute)).digest("hex"),
      });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

dshProductionTest(DSH_PRODUCTION_TEST_IDS.prepareHermeticConfig, "production prepare ignores hostile inherited pnpmfile authority", {
  skip: !productionFixture,
  timeout: 300_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "luckyray-dsh-prepare-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sideEffect = join(root, "hostile-pnpmfile-ran.txt");
  const hostilePnpmfile = join(root, "hostile-pnpmfile.cjs");
  const hostileConfigHome = join(root, "hostile-config");
  const hostileBin = join(root, "hostile-bin");
  const outputRoot = join(root, "published-runtime");
  await mkdir(join(hostileConfigHome, "pnpm"), { recursive: true });
  await mkdir(hostileBin, { recursive: true });
  await copyFile(join(process.env.SystemRoot, "System32", "where.exe"), join(hostileBin, "tar.exe"));
  await writeFile(hostilePnpmfile, [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(sideEffect)}, 'executed');`,
    "module.exports = { hooks: { readPackage(pkg) { return pkg; } } };",
    "",
  ].join("\n"));
  await writeFile(join(hostileConfigHome, "pnpm", "config.yaml"), [
    `globalPnpmfile: '${hostilePnpmfile.replaceAll("\\", "/")}'`,
    "packageImportMethod: hardlink",
    "nodeLinker: hoisted",
    "",
  ].join("\n"));

  const result = await runPowerShell(
    productionPrepareScript(),
    [
      "-NodeArchive", productionFixture.nodeArchive,
      "-PnpmTarball", productionFixture.pnpmTarball,
      "-OfflineStore", productionFixture.offlineStore,
      "-OutputRoot", outputRoot,
    ],
    {
      pnpm_config_global_pnpmfile: hostilePnpmfile,
      XDG_CONFIG_HOME: hostileConfigHome,
      LOCALAPPDATA: hostileConfigHome,
      PATH: `${hostileBin};${process.env.PATH}`,
    },
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);
  await assert.rejects(readFile(sideEffect), { code: "ENOENT" });
});

dshProductionTest(DSH_PRODUCTION_TEST_IDS.prepareDetachedPublication, "production prepare publishes bytes detached from the approved offline store", {
  skip: !productionFixture,
  timeout: 300_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "luckyray-dsh-detached-publish-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputRoot = join(root, "published-runtime");
  const result = await runPowerShell(productionPrepareScript(), [
    "-NodeArchive", productionFixture.nodeArchive,
    "-PnpmTarball", productionFixture.pnpmTarball,
    "-OfflineStore", productionFixture.offlineStore,
    "-OutputRoot", outputRoot,
  ]);
  assert.equal(result.code, 0, result.stderr || result.stdout);

  const authorityPath = new URL("../dsh-host/runtime-authority.json", import.meta.url).pathname.slice(1);
  const recordsDirectory = new URL("../dsh-host/records/", import.meta.url).pathname.slice(1);
  const finalVerified = await verifyStagedDshRuntime({
    authorityPath,
    recordsDirectory,
    stageRoot: outputRoot,
  });
  assert.equal(finalVerified.packageCount, 516);
  const finalNative = await runExecutable(join(outputRoot, "node", "node.exe"), [
    new URL("../scripts/dsh-supply-chain.mjs", import.meta.url).pathname.slice(1),
    "native-probe",
    "--stage",
    outputRoot,
  ]);
  assert.equal(finalNative.code, 0, finalNative.stderr);
  assert.deepEqual(JSON.parse(finalNative.stdout).modules, [
    "koffi",
    "node-pty",
    "sharp",
    "node-addon-require-builtin",
  ]);
  const finalVersion = await runExecutable(join(outputRoot, "node", "node.exe"), [
    join(outputRoot, "host", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    "--version",
  ]);
  assert.equal(finalVersion.code, 0, finalVersion.stderr);
  assert.equal(finalVersion.stdout.trim(), "0.1.7-rc.2");

  const publishedPackage = join(
    outputRoot,
    "host",
    "node_modules",
    "@deepseek-ai",
    "dsh",
    "package.json",
  );
  const packageBytes = await readFile(publishedPackage);
  const storeDigest = createHash("sha512").update(packageBytes).digest("hex");
  const storeFile = join(
    productionFixture.offlineStore,
    "v11",
    "files",
    storeDigest.slice(0, 2),
    storeDigest.slice(2),
  );
  const storeBytes = await readFile(storeFile);
  const before = await hashRegularFileTree(outputRoot);
  try {
    const changedStoreBytes = Buffer.from(storeBytes);
    changedStoreBytes[0] ^= 1;
    await writeFile(storeFile, changedStoreBytes);
    const after = await hashRegularFileTree(outputRoot);
    assert.deepEqual(after, before);
  } finally {
    await writeFile(storeFile, storeBytes);
  }
});

dshProductionTest(DSH_PRODUCTION_TEST_IDS.prepareFinalResolverRebind, "production resolver publication rebinds Windows absolute junctions from canonical authority", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "luckyray-dsh-rename-junction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, "candidate");
  const published = join(root, "published");
  const candidateNodeModules = join(candidate, "node_modules");
  const candidatePackage = join(candidateNodeModules, ".pnpm", "alpha@1.0.0", "node_modules", "alpha");
  await mkdir(join(candidatePackage, "lib"), { recursive: true });
  await writeFile(join(candidatePackage, "package.json"), JSON.stringify({
    name: "alpha",
    version: "1.0.0",
    license: "MIT",
  }));
  await writeFile(join(candidatePackage, "lib", "bin.js"), "export {};\n");
  await symlink(candidatePackage, join(candidateNodeModules, "alpha"), "junction");

  const before = await auditInstalledClosure({
    nodeModulesRoot: candidateNodeModules,
    expectedPackageCount: 1,
    entryPoint: "alpha/lib/bin.js",
  });
  await rename(candidate, published);
  const publishedNodeModules = join(published, "node_modules");
  await assert.rejects(auditInstalledClosure({
    nodeModulesRoot: publishedNodeModules,
    expectedPackageCount: 1,
    entryPoint: "alpha/lib/bin.js",
  }));

  const rebound = await rebindResolverGraphAtFinalRoot({
    nodeModulesRoot: publishedNodeModules,
    resolverGraph: before.resolverGraph,
  });
  assert.equal(rebound.edgeCount, 1);
  const after = await auditInstalledClosure({
    nodeModulesRoot: publishedNodeModules,
    expectedPackageCount: 1,
    entryPoint: "alpha/lib/bin.js",
  });
  assert.deepEqual(after.resolverGraph, before.resolverGraph);
  assert.deepEqual(after.entryPoint, before.entryPoint);
});

dshProductionTest(DSH_PRODUCTION_TEST_IDS.pnpmExecutedTree, "app-owned pnpm extraction binds the complete executed code tree", {
  skip: !productionFixture,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "luckyray-dsh-pnpm-extract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extractedRoot = join(root, "pnpm");
  const authorityPath = new URL("../dsh-host/runtime-authority.json", import.meta.url).pathname.slice(1);

  const extracted = await extractVerifiedPnpmPackage({
    authorityPath,
    pnpmTarballPath: productionFixture.pnpmTarball,
    outputRoot: extractedRoot,
  });
  assert.equal(extracted.fileCount, 449);
  assert.equal(extracted.byteCount, 18_644_360);

  const entryPoint = join(extractedRoot, "package", "bin", "pnpm.mjs");
  const original = await readFile(entryPoint);
  try {
    const changed = Buffer.from(original);
    changed[0] ^= 1;
    await writeFile(entryPoint, changed);
    await assert.rejects(
      verifyExtractedPnpmPackage({ authorityPath, packageRoot: extractedRoot }),
      { code: "dsh-pnpm-extracted-tree-invalid" },
    );
  } finally {
    await writeFile(entryPoint, original);
  }
});

dshProductionTest(DSH_PRODUCTION_TEST_IDS.gateFixturesRequired, "canonical DSH production gate fails closed when fixtures are missing", async () => {
  const gate = new URL("../scripts/run-dsh-supply-chain-gate.mjs", import.meta.url).pathname.slice(1);
  const result = await runNode(gate, [], {
    DSH_NODE_ARCHIVE: "",
    DSH_PNPM_TARBALL: "",
    DSH_OFFLINE_STORE: "",
    DSH_EXISTING_STAGE: "",
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /dsh-production-fixtures-required/);
});

dshProductionTest(DSH_PRODUCTION_TEST_IDS.gateInventoryAuthority, "canonical DSH production gate rejects skipped tests, identity drift, and environment injection", async (t) => {
  const fixture = new URL("./fixtures/dshGateInventoryFixture.test.mjs", import.meta.url).pathname.slice(1);
  const expectedTestIds = ["dsh0.fixture.first", "dsh0.fixture.second"];
  const clean = runTestInventoryGate({
    nodeExe: process.execPath,
    testFile: fixture,
    expectedTests: 2,
    expectedTestIds,
    environment: process.env,
  });
  assert.deepEqual(clean, {
    tests: 2,
    pass: 2,
    fail: 0,
    cancelled: 0,
    skipped: 0,
  });
  assert.throws(
    () => runTestInventoryGate({
      nodeExe: process.execPath,
      testFile: fixture,
      expectedTests: 2,
      expectedTestIds,
      environment: { ...process.env, DSH_GATE_FORCE_SKIP: "1" },
    }),
    { code: "dsh-production-test-inventory-invalid" },
  );
  assert.throws(
    () => runTestInventoryGate({
      nodeExe: process.execPath,
      testFile: fixture,
      expectedTests: 3,
      expectedTestIds: [...expectedTestIds, "dsh0.fixture.third"],
      environment: process.env,
    }),
    { code: "dsh-production-test-inventory-invalid" },
  );
  assert.throws(
    () => runTestInventoryGate({
      nodeExe: process.execPath,
      testFile: fixture,
      expectedTests: 2,
      expectedTestIds,
      environment: { ...process.env, DSH_GATE_SUBSTITUTE_ID: "1" },
    }),
    { code: "dsh-production-test-inventory-invalid" },
  );
  assert.throws(
    () => runTestInventoryGate({
      nodeExe: process.execPath,
      testFile: fixture,
      expectedTests: 2,
      expectedTestIds,
      environment: { ...process.env, DSH_GATE_DUPLICATE_ID: "1" },
    }),
    { code: "dsh-production-test-inventory-invalid" },
  );
  assert.deepEqual(runTestInventoryGate({
    nodeExe: process.execPath,
    testFile: fixture,
    expectedTests: 2,
    expectedTestIds,
    environment: { ...process.env, DSH_GATE_FORGE_STDOUT: "1" },
  }), clean);

  const root = await mkdtemp(join(tmpdir(), "luckyray-dsh-gate-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const preloadSideEffect = join(root, "node-options-preload-ran.txt");
  const preload = join(root, "hostile-preload.cjs");
  await writeFile(preload, [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(preloadSideEffect)}, 'executed');`,
    "",
  ].join("\n"));
  runTestInventoryGate({
    nodeExe: process.execPath,
    testFile: fixture,
    expectedTests: 2,
    expectedTestIds,
    environment: { ...process.env, NODE_OPTIONS: `--require=${preload}` },
  });
  await assert.rejects(readFile(preloadSideEffect), { code: "ENOENT" });

  const hostilePrepare = join(root, "hostile-prepare.ps1");
  const isCanonicalProductionChild = process.env.DSH_REQUIRE_PRODUCTION_FIXTURES === "1";
  const productionChildEnvironment = isCanonicalProductionChild
    ? process.env
    : buildDshTestChildEnvironment({
        ...process.env,
        DSH_NODE_ARCHIVE: "node.zip",
        DSH_PNPM_TARBALL: "pnpm.tgz",
        DSH_OFFLINE_STORE: "store",
        DSH_EXISTING_STAGE: "stage",
        DSH_PREPARE_SCRIPT: hostilePrepare,
        NODE_OPTIONS: `--require=${preload}`,
        NODE_PATH: root,
        NODE_REPL_EXTERNAL_MODULE: preload,
        NODE_EXTRA_CA_CERTS: preload,
      }, { production: true });
  if (!isCanonicalProductionChild) {
    assert.deepEqual(Object.keys(productionChildEnvironment).sort(), [
      "COMSPEC",
      "ComSpec",
      "DSH_EXISTING_STAGE",
      "DSH_NODE_ARCHIVE",
      "DSH_OFFLINE_STORE",
      "DSH_PNPM_TARBALL",
      "DSH_REQUIRE_PRODUCTION_FIXTURES",
      "PATH",
      "SYSTEMROOT",
      "SystemRoot",
      "TEMP",
      "TMP",
      "WINDIR",
    ].sort());
  }
  for (const required of [
    "DSH_EXISTING_STAGE",
    "DSH_NODE_ARCHIVE",
    "DSH_OFFLINE_STORE",
    "DSH_PNPM_TARBALL",
    "DSH_REQUIRE_PRODUCTION_FIXTURES",
  ]) {
    assert.equal(typeof productionChildEnvironment[required], "string");
    assert.ok(productionChildEnvironment[required].length > 0);
  }
  for (const forbidden of [
    "DSH_PREPARE_SCRIPT",
    "NODE_EXTRA_CA_CERTS",
    "NODE_OPTIONS",
    "NODE_PATH",
    "NODE_REPL_EXTERNAL_MODULE",
  ]) {
    assert.equal(Object.hasOwn(productionChildEnvironment, forbidden), false);
  }

  const previousRequire = process.env.DSH_REQUIRE_PRODUCTION_FIXTURES;
  const previousPrepare = process.env.DSH_PREPARE_SCRIPT;
  try {
    process.env.DSH_REQUIRE_PRODUCTION_FIXTURES = "1";
    process.env.DSH_PREPARE_SCRIPT = hostilePrepare;
    assert.notEqual(productionPrepareScript(), hostilePrepare);
  } finally {
    if (previousRequire === undefined) delete process.env.DSH_REQUIRE_PRODUCTION_FIXTURES;
    else process.env.DSH_REQUIRE_PRODUCTION_FIXTURES = previousRequire;
    if (previousPrepare === undefined) delete process.env.DSH_PREPARE_SCRIPT;
    else process.env.DSH_PREPARE_SCRIPT = previousPrepare;
  }
});

dshProductionTest(DSH_PRODUCTION_TEST_IDS.authorityRc2, "DSH runtime authority pins rc.2 npm bytes and keeps the official tag audit-only", async () => {
  const authority = JSON.parse(await readFile(authorityUrl, "utf8"));
  const validated = validateDshRuntimeAuthority(authority);

  assert.equal(validated.runtimePackage.name, "@deepseek-ai/dsh");
  assert.equal(validated.runtimePackage.version, "0.1.7-rc.2");
  assert.equal(
    validated.runtimePackage.sha256,
    "5f2da7272d9485abc223e681075809a8d929697c5232ee445718e1b7e066bff8",
  );
  assert.equal(
    validated.sourceReference.commit,
    "477b4f420553e8a52c2fbccc464d7561b239c443",
  );
  assert.equal(validated.sourceReference.declaredVersion, "0.1.7-rc.2");
  assert.equal(validated.sourceReference.role, "audit-only");
  assert.equal(validated.sourceReference.provenanceBoundToRuntime, false);
  assert.deepEqual(validated.packageManager.installPolicy, {
    ignorePnpmfile: true,
    isolatedGlobalConfig: true,
    packageImportMethod: "copy",
    nodeLinker: "isolated",
    virtualStoreDir: "node_modules/.pnpm",
    installScripts: false,
    offline: true,
    frozenLockfile: true,
    minimumReleaseAge: 1440,
    minimumReleaseAgeStrict: true,
    minimumReleaseAgeIgnoreMissingTime: false,
    missingReleaseTimeBehavior: "reject",
    workspacePolicySha256: "460e2012bf651c0b13acdc433a98255ee144585461ba280a335211a1b0af56f7",
  });
  const workspacePolicy = await readFile(workspacePolicyUrl);
  assert.deepEqual(
    validateAuthenticatedWorkspacePolicy(workspacePolicy, validated.packageManager.installPolicy),
    {
      minimumReleaseAge: 1440,
      minimumReleaseAgeStrict: true,
      minimumReleaseAgeIgnoreMissingTime: false,
      missingReleaseTimeBehavior: "reject",
      exclusionCount: 0,
    },
  );
  for (const hostilePolicy of [
    workspacePolicy.toString("utf8").replace("minimumReleaseAge: 1440\n", ""),
    workspacePolicy.toString("utf8").replace("minimumReleaseAgeStrict: true", "minimumReleaseAgeStrict: false"),
    workspacePolicy.toString("utf8").replace(
      "minimumReleaseAgeIgnoreMissingTime: false",
      "minimumReleaseAgeIgnoreMissingTime: true",
    ),
    `${workspacePolicy.toString("utf8")}minimumReleaseAgeExclude:\n  - '@deepseek-ai/dsh@0.1.7-rc.2'\n`,
  ]) {
    assert.throws(
      () => validateAuthenticatedWorkspacePolicy(hostilePolicy, validated.packageManager.installPolicy),
      { code: "dsh-host-policy-invalid" },
    );
  }
  assert.deepEqual(validated.packageManager.extractedTree, {
    schemaVersion: 1,
    fileCount: 449,
    byteCount: 18_644_360,
    sha256: "ccb8af2ce09e65f728ab5689a1bc00df5b1f508bc23cfc9829d95d3dccc1340e",
    entryPoint: "package/bin/pnpm.mjs",
  });
  assert.deepEqual(validated.packageManager.archivePolicy, {
    schemaVersion: 1,
    format: "ustar",
    magicHex: "757374617200",
    version: "00",
    regularFilesOnly: true,
    requireEmptyPrefix: true,
    requireEmptyLinkName: true,
    windowsCanonicalPaths: true,
    compressedByteLimit: 33_554_432,
    uncompressedByteLimit: 33_554_432,
    entryCountLimit: 1024,
    entryByteLimit: 16_777_216,
    pathByteLimit: 100,
    pathDepthLimit: 32,
    pathSegmentByteLimit: 255,
    endZeroBlockCount: 2,
  });
  assert.match(validated.dependencyClosure.resolverGraphSha256, /^[a-f0-9]{64}$/);
  assert.match(validated.dependencyClosure.lockReconciliationSha256, /^[a-f0-9]{64}$/);
  assert.equal(validated.policy.upstreamPatchCount, 0);
});

dshProductionTest(DSH_PRODUCTION_TEST_IDS.auditLifecycleNative, "installed closure audit records disabled lifecycle scripts and native bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "luckyray-dsh-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, "node_modules", ".pnpm", "native-demo@1.2.3", "node_modules", "native-demo");
  await mkdir(join(packageRoot, "prebuilt"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "native-demo",
    version: "1.2.3",
    license: "MIT",
    scripts: { install: "node install.js" },
  }));
  await writeFile(join(packageRoot, "LICENSE"), "MIT fixture\n");
  await writeFile(join(packageRoot, "prebuilt", "demo.node"), "native fixture\n");

  const audit = await auditInstalledClosure({
    nodeModulesRoot: join(root, "node_modules"),
    expectedPackageCount: 1,
  });
  assert.equal(audit.packageCount, 1);
  assert.equal(audit.installScriptsExecuted, false);
  assert.deepEqual(audit.packages[0].lifecycleScripts, [
    { stage: "install", command: "node install.js" },
  ]);
  assert.equal(audit.packages[0].nativeArtifacts[0].path, "prebuilt/demo.node");
  assert.match(audit.packages[0].nativeArtifacts[0].sha256, /^[a-f0-9]{64}$/);

  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "native-demo", version: "1.2.3", license: "(MIT OR CC0-1.0)",
  }));
  await writeFile(join(packageRoot, "license-mit"), "MIT alternative fixture\n");
  await writeFile(join(packageRoot, "license-cc0"), "CC0 alternative fixture\n");
  const dualLicense = await auditInstalledClosure({
    nodeModulesRoot: join(root, "node_modules"), expectedPackageCount: 1,
  });
  assert.equal(dualLicense.packages[0].license, "(MIT OR CC0-1.0)");
  assert.ok(dualLicense.packages[0].licenseFiles.some((entry) => entry.path === "license-mit"));
  assert.ok(dualLicense.packages[0].licenseFiles.some((entry) => entry.path === "license-cc0"));
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "native-demo", version: "1.2.3", license: "MIT OR UNKNOWN-PROPRIETARY",
  }));
  await assert.rejects(auditInstalledClosure({
    nodeModulesRoot: join(root, "node_modules"), expectedPackageCount: 1,
  }), { code: "dsh-license-not-allowlisted" });

  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "native-demo",
    version: "1.2.3",
    license: "UNKNOWN-PROPRIETARY",
  }));
  await assert.rejects(
    auditInstalledClosure({
      nodeModulesRoot: join(root, "node_modules"),
      expectedPackageCount: 1,
    }),
    { code: "dsh-license-not-allowlisted" },
  );
});

dshProductionTest(DSH_PRODUCTION_TEST_IDS.auditPortableRelease, "portable release audit accepts regular copied packages and rejects resolver links", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "luckyray-dsh-portable-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nodeModulesRoot = join(root, "host", "node_modules");
  const packageRoot = join(nodeModulesRoot, "alpha");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "alpha",
    version: "1.0.0",
    license: "MIT",
  }));
  await writeFile(join(packageRoot, "index.js"), "export default 1;\n");

  const audit = await auditPortableInstalledClosure({
    nodeModulesRoot,
    expectedPackageCount: 1,
    entryPoint: "alpha/index.js",
  });
  assert.equal(audit.packageCount, 1);
  assert.equal(audit.physicalPackageRootCount, 1);
  assert.equal(audit.resolverGraph.edgeCount, 0);
  assert.equal(audit.treeFileCount, 2);
  assert.match(audit.treeContentSha256, /^[a-f0-9]{64}$/);
  assert.equal(audit.entryPoint.requestedPath, "alpha/index.js");
  assert.equal(audit.entryPoint.targetPath, "alpha/index.js");

  await writeFile(join(nodeModulesRoot, ".modules.yaml"), "layout: drift\n");
  const metadataDrift = await auditPortableInstalledClosure({ nodeModulesRoot, expectedPackageCount: 1 });
  assert.notEqual(metadataDrift.treeContentSha256, audit.treeContentSha256);
  await writeFile(join(nodeModulesRoot, ".pnpm-workspace-state-v1.json"), "{}\n");
  await mkdir(join(nodeModulesRoot, ".pnpm"));
  await writeFile(join(nodeModulesRoot, ".pnpm", "lock.yaml"), "lockfileVersion: '9.0'\n");
  await mkdir(join(nodeModulesRoot, ".bin"));
  await writeFile(join(nodeModulesRoot, ".bin", "alpha"), [
    "#!/bin/sh",
    "exec node ../alpha/index.js \"$@\"",
    `# cmd-shim-target=${join(root, "partial", "alpha", "index.js").replaceAll("\\", "/")}`,
    "",
  ].join("\n"));
  assert.deepEqual(await projectPortableDshReleaseLayout({ stageRoot: root, expectedShimCount: 1 }), {
    removed: [
      "host/node_modules/.modules.yaml",
      "host/node_modules/.pnpm-workspace-state-v1.json",
      "host/node_modules/.pnpm/lock.yaml",
    ],
    normalizedShims: ["host/node_modules/.bin/alpha"],
  });
  assert.equal(
    await readFile(join(nodeModulesRoot, ".bin", "alpha"), "utf8"),
    "#!/bin/sh\nexec node ../alpha/index.js \"$@\"\n",
  );

  const external = join(root, "external");
  await mkdir(external);
  await symlink(external, join(nodeModulesRoot, "linked"), "junction");
  await assert.rejects(
    auditPortableInstalledClosure({ nodeModulesRoot, expectedPackageCount: 1 }),
    { code: "dsh-portable-reparse-path" },
  );
});

dshProductionTest(DSH_PRODUCTION_TEST_IDS.resolverExternalReject, "installed closure rejects resolver links that escape the staged node_modules root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "luckyray-dsh-resolver-external-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nodeModulesRoot = join(root, "host", "node_modules");
  const packageRoot = join(nodeModulesRoot, ".pnpm", "alpha@1.0.0", "node_modules", "alpha");
  const externalRoot = join(root, "external-beta");
  await mkdir(join(packageRoot, "node_modules"), { recursive: true });
  await mkdir(externalRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "alpha",
    version: "1.0.0",
    license: "MIT",
  }));
  await writeFile(join(externalRoot, "package.json"), JSON.stringify({
    name: "beta",
    version: "1.0.0",
    license: "MIT",
  }));
  await symlink(externalRoot, join(packageRoot, "node_modules", "beta"), "junction");

  await assert.rejects(
    auditInstalledClosure({ nodeModulesRoot, expectedPackageCount: 1 }),
    { code: "dsh-resolver-target-outside-stage" },
  );
});

dshProductionTest(DSH_PRODUCTION_TEST_IDS.resolverGraphBinding, "installed closure binds root and nested resolver edges to audited package content", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "luckyray-dsh-resolver-graph-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nodeModulesRoot = join(root, "node_modules");
  const alphaRoot = join(nodeModulesRoot, ".pnpm", "alpha@1.0.0", "node_modules", "alpha");
  const betaRoot = join(nodeModulesRoot, ".pnpm", "beta@1.0.0", "node_modules", "beta");
  await mkdir(join(alphaRoot, "node_modules"), { recursive: true });
  await mkdir(betaRoot, { recursive: true });
  await writeFile(join(alphaRoot, "package.json"), JSON.stringify({
    name: "alpha",
    version: "1.0.0",
    license: "MIT",
  }));
  await writeFile(join(betaRoot, "package.json"), JSON.stringify({
    name: "beta",
    version: "1.0.0",
    license: "MIT",
  }));
  await symlink(alphaRoot, join(nodeModulesRoot, "alpha"), "junction");
  await symlink(betaRoot, join(alphaRoot, "node_modules", "beta"), "junction");

  const audit = await auditInstalledClosure({ nodeModulesRoot, expectedPackageCount: 2 });
  assert.equal(audit.resolverGraph.edgeCount, 2);
  assert.deepEqual(
    audit.resolverGraph.edges.map(({ path, targetPackage }) => ({ path, targetPackage })),
    [
      {
        path: ".pnpm/alpha@1.0.0/node_modules/alpha/node_modules/beta",
        targetPackage: "beta@1.0.0",
      },
      { path: "alpha", targetPackage: "alpha@1.0.0" },
    ],
  );
  assert.ok(audit.resolverGraph.edges.every((edge) => /^[a-f0-9]{64}$/.test(edge.targetContentSha256)));
});

dshProductionTest(DSH_PRODUCTION_TEST_IDS.closureFrozenZeroPatch, "DSH host closure is exact, frozen, independent, and patch-free", async () => {
  const [authority, hostPackage, lockfile, npmrc, workspacePolicy] = await Promise.all([
    readFile(authorityUrl, "utf8").then(JSON.parse),
    readFile(hostPackageUrl, "utf8").then(JSON.parse),
    readFile(lockfileUrl),
    readFile(npmrcUrl, "utf8"),
    readFile(workspacePolicyUrl),
  ]);

  const closure = validateDshFrozenClosure({ authority, hostPackage, lockfile, npmrc, workspacePolicy });
  assert.equal(closure.packageCount, 591);
  assert.equal(closure.lockfileVersion, "9.0");
  assert.equal(closure.upstreamPatchCount, 0);

  assert.throws(
    () => validateDshFrozenClosure({
      authority,
      hostPackage: { ...hostPackage, dependencies: { "@deepseek-ai/dsh": "^0.1.7-rc.2" } },
      lockfile,
      npmrc,
      workspacePolicy,
    }),
    { code: "dsh-host-package-invalid" },
  );

  const tamperedLockfile = Buffer.from(lockfile);
  tamperedLockfile[tamperedLockfile.length - 2] ^= 1;
  assert.throws(
    () => validateDshFrozenClosure({ authority, hostPackage, lockfile: tamperedLockfile, npmrc, workspacePolicy }),
    { code: "dsh-lockfile-invalid" },
  );
  assert.throws(
    () => validateDshFrozenClosure({
      authority,
      hostPackage,
      lockfile,
      npmrc: npmrc.replace("ignore-scripts=true", "ignore-scripts=false"),
      workspacePolicy,
    }),
    { code: "dsh-host-policy-invalid" },
  );
  assert.throws(
    () => validateDshFrozenClosure({
      authority,
      hostPackage,
      lockfile,
      npmrc,
      workspacePolicy: Buffer.from(`${workspacePolicy.toString("utf8")}# drift\n`),
    }),
    { code: "dsh-host-policy-invalid" },
  );
});

dshProductionTest(DSH_PRODUCTION_TEST_IDS.lockReconcileReal, "locked closure reconciles every identity as staged or pruned with a reason", async () => {
  const lockfile = await readFile(lockfileUrl);
  const dependencyAudit = JSON.parse(await readFile(new URL("dependency-audit.json", recordsUrl), "utf8"));
  const reconciliation = reconcileLockedClosure({
    lockfile,
    stagedPackages: dependencyAudit.packages,
  });
  assert.equal(reconciliation.lockedCount, 591);
  assert.equal(reconciliation.stagedCount, 516);
  assert.equal(reconciliation.prunedCount, 75);
  assert.equal(reconciliation.schemaVersion, 2);
  assert.equal(reconciliation.mandatoryReachableCount, 510);
  assert.equal(reconciliation.optionalOnlyReachableCount, 81);
  assert.equal(reconciliation.staged.length + reconciliation.pruned.length, 591);
  assert.equal(new Set([
    ...reconciliation.staged.map((entry) => entry.lockKey),
    ...reconciliation.pruned.map((entry) => entry.lockKey),
  ]).size, 591);
  assert.ok(reconciliation.pruned.every((entry) => [
    "platform-not-win32",
    "architecture-not-x64",
    "optional-transitive-not-selected",
  ].includes(entry.reason)));
});

dshProductionTest(DSH_PRODUCTION_TEST_IDS.lockMandatoryMissing, "lock reconciliation rejects a mandatory win-x64 dependency mislabeled as optional", () => {
  const mandatoryMissingLock = [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    "      root:",
    "        specifier: 1.0.0",
    "        version: 1.0.0",
    "",
    "packages:",
    "",
    "  mandatory@1.0.0:",
    "    resolution: {integrity: fixture}",
    "",
    "  optional@1.0.0:",
    "    resolution: {integrity: fixture}",
    "",
    "  root@1.0.0:",
    "    resolution: {integrity: fixture}",
    "",
    "snapshots:",
    "",
    "  mandatory@1.0.0: {}",
    "",
    "  optional@1.0.0: {}",
    "",
    "  root@1.0.0:",
    "    dependencies:",
    "      mandatory: 1.0.0",
    "    optionalDependencies:",
    "      optional: 1.0.0",
    "",
  ].join("\n");

  assert.throws(
    () => reconcileLockedClosure({
      lockfile: mandatoryMissingLock,
      stagedPackages: [{ name: "root", version: "1.0.0" }],
    }),
    { code: "dsh-mandatory-package-not-staged" },
  );

  const optionalPruned = reconcileLockedClosure({
    lockfile: mandatoryMissingLock,
    stagedPackages: [
      { name: "root", version: "1.0.0" },
      { name: "mandatory", version: "1.0.0" },
    ],
  });
  assert.deepEqual(optionalPruned.pruned, [{
    lockKey: "optional@1.0.0",
    packageIdentity: "optional@1.0.0",
    reachability: "optional-only",
    reason: "optional-transitive-not-selected",
  }]);
});

dshProductionTest(DSH_PRODUCTION_TEST_IDS.lockSyntheticMatrix, "lock graph handles mandatory precedence, cycles, peers, optional ancestry, duplicates, and target filters", () => {
  const graphMatrixLock = [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    "      root: 1.0.0",
    "",
    "packages:",
    "",
    ...["root", "shared", "cycle-a", "cycle-b", "peer-user", "peer", "opt-parent", "opt-child"]
      .flatMap((name) => [`  ${name}@1.0.0:`, "    resolution: {integrity: fixture}", ""]),
    "snapshots:",
    "",
    "  root@1.0.0:",
    "    dependencies:",
    "      shared: 1.0.0",
    "      cycle-a: 1.0.0",
    "      peer-user: 1.0.0(peer@1.0.0)",
    "      peer: 1.0.0",
    "    optionalDependencies:",
    "      shared: 1.0.0",
    "      opt-parent: 1.0.0",
    "",
    "  shared@1.0.0: {}",
    "",
    "  cycle-a@1.0.0:",
    "    dependencies:",
    "      cycle-b: 1.0.0",
    "",
    "  cycle-b@1.0.0:",
    "    dependencies:",
    "      cycle-a: 1.0.0",
    "",
    "  'peer-user@1.0.0(peer@1.0.0)': {}",
    "",
    "  peer@1.0.0: {}",
    "",
    "  opt-parent@1.0.0:",
    "    dependencies:",
    "      opt-child: 1.0.0",
    "",
    "  opt-child@1.0.0: {}",
    "",
  ].join("\n");
  const graphMatrix = reconcileLockedClosure({
    lockfile: graphMatrixLock,
    stagedPackages: ["root", "shared", "cycle-a", "cycle-b", "peer-user", "peer"]
      .map((name) => ({ name, version: "1.0.0" })),
  });
  assert.equal(graphMatrix.mandatoryReachableCount, 6);
  assert.equal(graphMatrix.optionalOnlyReachableCount, 2);
  assert.equal(
    graphMatrix.staged.find((entry) => entry.packageIdentity === "shared@1.0.0").reachability,
    "mandatory",
  );
  assert.deepEqual(
    graphMatrix.pruned
      .map((entry) => [entry.packageIdentity, entry.reachability, entry.reason])
      .sort(([left], [right]) => left.localeCompare(right)),
    [
      ["opt-child@1.0.0", "optional-only", "optional-transitive-not-selected"],
      ["opt-parent@1.0.0", "optional-only", "optional-transitive-not-selected"],
    ],
  );

  const duplicateSnapshot = graphMatrixLock.replace(
    "  shared@1.0.0: {}",
    "  shared@1.0.0: {}\n\n  shared@1.0.0: {}",
  );
  assert.throws(
    () => reconcileLockedClosure({
      lockfile: duplicateSnapshot,
      stagedPackages: ["root", "shared", "cycle-a", "cycle-b", "peer-user", "peer"]
        .map((name) => ({ name, version: "1.0.0" })),
    }),
    { code: "dsh-lock-graph-invalid" },
  );
  const duplicateIdentityVariant = graphMatrixLock.replace(
    "  peer-user@1.0.0:",
    "  peer-user@1.0.0(peer@1.0.0):\n    resolution: {integrity: fixture}\n\n  peer-user@1.0.0(peer@2.0.0):",
  );
  assert.throws(
    () => reconcileLockedClosure({ lockfile: duplicateIdentityVariant, stagedPackages: [] }),
    { code: "dsh-lock-graph-invalid" },
  );

  const targetMatrixLock = [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    "      root: 1.0.0",
    "",
    "packages:",
    "",
    "  root@1.0.0:",
    "    resolution: {integrity: fixture}",
    "",
    "  no-win@1.0.0:",
    "    resolution: {integrity: fixture}",
    "    os: ['!win32']",
    "",
    "  no-x64@1.0.0:",
    "    resolution: {integrity: fixture}",
    "    cpu: ['!x64']",
    "",
    "  darwin@1.0.0:",
    "    resolution: {integrity: fixture}",
    "    os: [darwin]",
    "",
    "  arm64@1.0.0:",
    "    resolution: {integrity: fixture}",
    "    cpu: [arm64]",
    "",
    "  win-x64@1.0.0:",
    "    resolution: {integrity: fixture}",
    "    os: [win32]",
    "    cpu: [x64]",
    "",
    "snapshots:",
    "",
    "  root@1.0.0:",
    "    dependencies:",
    "      no-win: 1.0.0",
    "      no-x64: 1.0.0",
    "      darwin: 1.0.0",
    "      arm64: 1.0.0",
    "      win-x64: 1.0.0",
    "",
    "  no-win@1.0.0: {}",
    "",
    "  no-x64@1.0.0: {}",
    "",
    "  darwin@1.0.0: {}",
    "",
    "  arm64@1.0.0: {}",
    "",
    "  win-x64@1.0.0: {}",
    "",
  ].join("\n");
  const targetMatrix = reconcileLockedClosure({
    lockfile: targetMatrixLock,
    stagedPackages: [
      { name: "root", version: "1.0.0" },
      { name: "win-x64", version: "1.0.0" },
    ],
  });
  assert.deepEqual(
    targetMatrix.pruned
      .map((entry) => [entry.packageIdentity, entry.reason])
      .sort(([left], [right]) => left.localeCompare(right)),
    [
      ["arm64@1.0.0", "architecture-not-x64"],
      ["darwin@1.0.0", "platform-not-win32"],
      ["no-win@1.0.0", "platform-not-win32"],
      ["no-x64@1.0.0", "architecture-not-x64"],
    ],
  );
});

dshProductionTest(DSH_PRODUCTION_TEST_IDS.nativeWrongArch, "native compatibility gate rejects a non-x64 PE image", () => {
  const peImage = (machine) => {
    const bytes = Buffer.alloc(256);
    bytes.write("MZ", 0, "ascii");
    bytes.writeUInt32LE(128, 0x3c);
    bytes.write("PE\0\0", 128, "binary");
    bytes.writeUInt16LE(machine, 132);
    return bytes;
  };
  assert.equal(validatePeX64Image(peImage(0x8664)), true);
  assert.throws(
    () => validatePeX64Image(peImage(0x014c)),
    { code: "dsh-native-architecture-invalid" },
  );
});

dshProductionTest(DSH_PRODUCTION_TEST_IDS.inputWrongBytes, "production input verifier rejects wrong pinned archive bytes", {
  skip: !productionFixture,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "luckyray-dsh-input-verifier-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await verifyDshSupplyInputs({
    authorityPath: new URL("../dsh-host/runtime-authority.json", import.meta.url).pathname.slice(1),
    nodeArchivePath: productionFixture.nodeArchive,
    pnpmTarballPath: productionFixture.pnpmTarball,
  });
  const tamperedNodeArchive = join(root, "node-tampered.zip");
  await copyFile(productionFixture.nodeArchive, tamperedNodeArchive);
  const nodeBytes = await readFile(tamperedNodeArchive);
  nodeBytes[0] ^= 1;
  await writeFile(tamperedNodeArchive, nodeBytes);
  await assert.rejects(verifyDshSupplyInputs({
    authorityPath: new URL("../dsh-host/runtime-authority.json", import.meta.url).pathname.slice(1),
    nodeArchivePath: tamperedNodeArchive,
    pnpmTarballPath: productionFixture.pnpmTarball,
  }), { code: "dsh-supply-input-invalid" });
});

dshProductionTest(DSH_PRODUCTION_TEST_IDS.stageDriftMatrix, "production stage verifier rejects content, native, layout, and resolver graph drift", {
  skip: !existingStageFixture,
  timeout: 600_000,
}, async (t) => {
  const authorityPath = new URL("../dsh-host/runtime-authority.json", import.meta.url).pathname.slice(1);
  const recordsDirectory = new URL("../dsh-host/records/", import.meta.url).pathname.slice(1);
  const verify = () => verifyStagedDshRuntime({
    authorityPath,
    recordsDirectory,
    stageRoot: existingStageFixture,
  });
  const restoreFile = async (path, mutation, expectedCode) => {
    const original = await readFile(path);
    try {
      const changed = Buffer.from(original);
      mutation(changed);
      await writeFile(path, changed);
      await assert.rejects(verify(), expectedCode ? { code: expectedCode } : undefined);
    } finally {
      await writeFile(path, original);
    }
  };
  const replaceJunction = async (path, target, assertion) => {
    const originalTarget = await readlink(path);
    try {
      await unlink(path);
      await symlink(target, path, "junction");
      await assertion();
    } finally {
      await unlink(path).catch(() => {});
      await symlink(originalTarget, path, "junction");
    }
  };

  const detached = await verifyDetachedDshRuntime({ stageRoot: existingStageFixture });
  assert.equal(detached.sharedWritableFiles, 0);
  assert.ok(detached.fileCount > 0);
  await verify();
  await restoreFile(join(existingStageFixture, "node", "node.exe"), (bytes) => { bytes[0] ^= 1; }, "dsh-staged-node-invalid");
  await restoreFile(join(existingStageFixture, "host", "pnpm-lock.yaml"), (bytes) => { bytes[bytes.length - 2] ^= 1; }, "dsh-lockfile-invalid");

  const records = JSON.parse(await readFile(new URL("dependency-audit.json", recordsUrl), "utf8"));
  const koffiEdge = records.resolverGraph.edges.find(
    (edge) => edge.targetPackage === "@koromix/koffi-win32-x64@3.3.1",
  );
  assert.ok(koffiEdge);
  const koffiNative = join(
    existingStageFixture,
    "host",
    "node_modules",
    ...koffiEdge.targetPath.split("/"),
    "win32_x64",
    "koffi.node",
  );
  await restoreFile(koffiNative, (bytes) => {
    const peOffset = bytes.readUInt32LE(0x3c);
    bytes.writeUInt16LE(0x014c, peOffset + 4);
  }, "dsh-native-architecture-invalid");

  const rootLink = join(existingStageFixture, "host", "node_modules", "@deepseek-ai", "dsh");
  const replacementEdge = records.resolverGraph.edges.find(
    (edge) => edge.targetPackage !== "@deepseek-ai/dsh@0.1.7-rc.2",
  );
  const replacementTarget = join(
    existingStageFixture,
    "host",
    "node_modules",
    ...replacementEdge.targetPath.split("/"),
  );
  const replacementManifest = join(replacementTarget, "package.json");
  const originalReplacementManifest = await readFile(replacementManifest);
  try {
    const manifest = JSON.parse(originalReplacementManifest.toString("utf8"));
    manifest.license = "UNKNOWN-PROPRIETARY";
    await writeFile(replacementManifest, JSON.stringify(manifest));
    await assert.rejects(verify(), { code: "dsh-license-not-allowlisted" });
  } finally {
    await writeFile(replacementManifest, originalReplacementManifest);
  }
  try {
    const manifest = JSON.parse(originalReplacementManifest.toString("utf8"));
    manifest.scripts = { ...(manifest.scripts ?? {}), postinstall: "node unknown-install.js" };
    await writeFile(replacementManifest, JSON.stringify(manifest));
    await assert.rejects(verify(), { code: "dsh-staged-closure-invalid" });
  } finally {
    await writeFile(replacementManifest, originalReplacementManifest);
  }
  await replaceJunction(rootLink, replacementTarget, async () => {
    await assert.rejects(verify());
  });
  const originalRootTarget = await readlink(rootLink);
  try {
    await unlink(rootLink);
    await assert.rejects(verify());
  } finally {
    await symlink(originalRootTarget, rootLink, "junction");
  }

  const nestedEdge = records.resolverGraph.edges.find((edge) => edge.path.startsWith(".pnpm/"));
  const nestedReplacementEdge = records.resolverGraph.edges.find(
    (edge) => edge.targetPackage !== nestedEdge.targetPackage,
  );
  const nestedReplacementTarget = join(
    existingStageFixture,
    "host",
    "node_modules",
    ...nestedReplacementEdge.targetPath.split("/"),
  );
  const nestedLink = join(
    existingStageFixture,
    "host",
    "node_modules",
    ...nestedEdge.path.split("/"),
  );
  await replaceJunction(nestedLink, nestedReplacementTarget, async () => {
    await assert.rejects(verify(), { code: "dsh-staged-closure-invalid" });
  });

  const externalRoot = await mkdtemp(join(tmpdir(), "luckyray-dsh-external-resolver-"));
  t.after(() => rm(externalRoot, { recursive: true, force: true }));
  await writeFile(join(externalRoot, "package.json"), JSON.stringify({
    name: "external",
    version: "1.0.0",
    license: "MIT",
  }));
  const externalLink = join(existingStageFixture, "host", "node_modules", "external-fixture");
  try {
    await symlink(externalRoot, externalLink, "junction");
    await assert.rejects(verify(), { code: "dsh-resolver-target-outside-stage" });
  } finally {
    await unlink(externalLink).catch(() => {});
  }

  const extraLink = join(existingStageFixture, "host", "node_modules", "extra-audited-fixture");
  try {
    await symlink(replacementTarget, extraLink, "junction");
    await assert.rejects(verify(), { code: "dsh-staged-closure-invalid" });
  } finally {
    await unlink(extraLink).catch(() => {});
  }

  const extraStageEntry = join(existingStageFixture, "unexpected-stage-entry.txt");
  try {
    await writeFile(extraStageEntry, "unexpected");
    await assert.rejects(verify(), { code: "dsh-stage-layout-invalid" });
  } finally {
    await rm(extraStageEntry, { force: true });
  }
  const nodeLicense = join(existingStageFixture, "node", "LICENSE");
  const nodeLicenseBytes = await readFile(nodeLicense);
  try {
    await rm(nodeLicense, { force: true });
    await assert.rejects(verify());
  } finally {
    await writeFile(nodeLicense, nodeLicenseBytes);
  }
});

dshProductionTest(DSH_PRODUCTION_TEST_IDS.recordsDeterministicInert, "published DSH records are deterministic, tamper-evident, and DSH-1 inert", async () => {
  const authority = JSON.parse(await readFile(authorityUrl, "utf8"));
  const records = {
    dependencyAudit: JSON.parse(await readFile(new URL("dependency-audit.json", recordsUrl), "utf8")),
    sbom: JSON.parse(await readFile(new URL("sbom.cdx.json", recordsUrl), "utf8")),
    launchManifest: JSON.parse(await readFile(new URL("launch-manifest.json", recordsUrl), "utf8")),
    runtimeManifest: JSON.parse(await readFile(new URL("runtime-manifest.json", recordsUrl), "utf8")),
    notice: await readFile(new URL("THIRD-PARTY-NOTICES.txt", recordsUrl), "utf8"),
  };

  const validated = validatePublishedDshRecords({ authority, records });
  assert.equal(validated.packageCount, 516);
  assert.equal(validated.nativeArtifactCount, 28);
  assert.equal(validated.installScriptsExecuted, false);
  assert.equal(records.runtimeManifest.closure.lifecycleScriptReviews.length, 5);
  assert.equal(records.dependencyAudit.resolverGraph.edgeCount, 2706);
  assert.equal(records.dependencyAudit.lockReconciliation.lockedCount, 591);
  assert.equal(records.dependencyAudit.lockReconciliation.stagedCount, 516);
  assert.equal(records.dependencyAudit.lockReconciliation.prunedCount, 75);
  assert.equal(records.dependencyAudit.lockReconciliation.schemaVersion, 2);
  assert.equal(records.dependencyAudit.lockReconciliation.mandatoryReachableCount, 510);
  assert.equal(records.dependencyAudit.lockReconciliation.optionalOnlyReachableCount, 81);
  const stagedIdentities = records.dependencyAudit.lockReconciliation.staged
    .map((entry) => entry.packageIdentity)
    .sort();
  const auditedIdentities = records.dependencyAudit.packages
    .map((entry) => `${entry.name}@${entry.version}`)
    .sort();
  const sbomIdentities = records.sbom.components
    .filter((entry) => entry.type === "library")
    .map((entry) => `${entry.name}@${entry.version}`)
    .sort();
  assert.deepEqual(stagedIdentities, auditedIdentities);
  assert.deepEqual(sbomIdentities, auditedIdentities);
  assert.ok(auditedIdentities.every((identity) => records.notice.includes(`${identity} | `)));
  assert.equal(records.runtimeManifest.closure.resolverGraphEdgeCount, 2706);
  assert.equal(records.runtimeManifest.closure.lockReconciliation.mandatoryReachableCount, 510);
  assert.equal(records.runtimeManifest.closure.lockReconciliation.optionalOnlyReachableCount, 81);
  assert.equal(records.runtimeManifest.closure.nativeCompatibility.staticEvidenceCount, 11);
  assert.equal(
    records.runtimeManifest.packageManager.extractedTree.sha256,
    "ccb8af2ce09e65f728ab5689a1bc00df5b1f508bc23cfc9829d95d3dccc1340e",
  );
  assert.deepEqual(records.runtimeManifest.closure.nativeCompatibility.loadProbeModules, [
    "koffi",
    "node-pty",
    "sharp",
    "node-addon-require-builtin",
  ]);
  assert.equal(records.launchManifest.entryPointAuthority.targetPackage, "@deepseek-ai/dsh@0.1.7-rc.2");
  assert.ok(records.runtimeManifest.closure.lifecycleScriptReviews.every(
    (review) => review.decision === "disabled-for-app-owned-stage" && review.executed === false,
  ));
  assert.equal(records.launchManifest.integrationState, "dsh-1-blocked");
  assert.equal(records.launchManifest.processSupervisor, null);
  assert.equal(records.launchManifest.transport, null);

  const tampered = structuredClone(records);
  tampered.dependencyAudit.packages[0].version = "tampered";
  assert.throws(
    () => validatePublishedDshRecords({ authority, records: tampered }),
    { code: "dsh-published-records-invalid" },
  );
});
