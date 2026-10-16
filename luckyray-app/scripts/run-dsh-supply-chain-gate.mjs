import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const authority = JSON.parse(readFileSync(join(repoRoot, "dsh-host", "runtime-authority.json"), "utf8"));
export const DSH_PRODUCTION_TEST_IDS = Object.freeze({
  tarStrictDialect: "dsh0.tar.strict-dialect",
  prepareHermeticConfig: "dsh0.prepare.hermetic-config",
  prepareDetachedPublication: "dsh0.prepare.detached-publication",
  prepareFinalResolverRebind: "dsh0.prepare.final-resolver-rebind",
  pnpmExecutedTree: "dsh0.pnpm.executed-tree",
  gateFixturesRequired: "dsh0.gate.fixtures-required",
  gateInventoryAuthority: "dsh0.gate.inventory-authority",
  authorityRc2: "dsh0.authority.rc2",
  auditLifecycleNative: "dsh0.audit.lifecycle-native",
  auditPortableRelease: "dsh0.audit.portable-release",
  resolverExternalReject: "dsh0.resolver.external-reject",
  resolverGraphBinding: "dsh0.resolver.graph-binding",
  closureFrozenZeroPatch: "dsh0.closure.frozen-zero-patch",
  lockReconcileReal: "dsh0.lock.reconcile-real",
  lockMandatoryMissing: "dsh0.lock.mandatory-missing",
  lockSyntheticMatrix: "dsh0.lock.synthetic-matrix",
  nativeWrongArch: "dsh0.native.wrong-arch",
  inputWrongBytes: "dsh0.input.wrong-bytes",
  stageDriftMatrix: "dsh0.stage.drift-matrix",
  recordsDeterministicInert: "dsh0.records.deterministic-inert",
});
export const DSH_PRODUCTION_TEST_INVENTORY = Object.freeze(Object.values(DSH_PRODUCTION_TEST_IDS));
const testReporter = join(repoRoot, "scripts", "dsh-production-test-reporter.mjs");
const trackedPrepareScript = join(repoRoot, "scripts", "prepare-dsh-runtime.ps1");
const requiredFixtures = [
  ["DSH_NODE_ARCHIVE", "file"],
  ["DSH_PNPM_TARBALL", "file"],
  ["DSH_OFFLINE_STORE", "directory"],
  ["DSH_EXISTING_STAGE", "directory"],
];

export class DshProductionGateError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "DshProductionGateError";
    this.code = code;
    Object.assign(this, details);
  }
}

function parseStableTestId(name) {
  if (typeof name !== "string") return null;
  return /^\[([a-z0-9][a-z0-9.-]{2,95})\](?:\s|$)/u.exec(name)?.[1] ?? null;
}

function parseTestReport(stdout) {
  const records = [];
  for (const line of stdout.split(/\r?\n/u).filter(Boolean)) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new DshProductionGateError("dsh-production-test-report-invalid");
    }
    if (record?.schemaVersion !== 1 || !["test-result", "summary"].includes(record.kind)) {
      throw new DshProductionGateError("dsh-production-test-report-invalid");
    }
    records.push(record);
  }
  const summaries = records.filter((record) => record.kind === "summary");
  if (summaries.length !== 1) throw new DshProductionGateError("dsh-production-test-report-invalid");
  const testResults = records.filter((record) => record.kind === "test-result");
  const testIds = testResults.map((record) => parseStableTestId(record.name));
  if (
    testIds.some((id) => id === null)
    || new Set(testIds).size !== testIds.length
    || testResults.some((record) => !["passed", "failed", "skipped", "todo"].includes(record.status))
  ) {
    throw new DshProductionGateError("dsh-production-test-inventory-invalid");
  }
  const summaryRecord = summaries[0];
  for (const key of ["tests", "pass", "fail", "cancelled", "skipped"]) {
    if (!Number.isSafeInteger(summaryRecord[key]) || summaryRecord[key] < 0) {
      throw new DshProductionGateError("dsh-production-test-report-invalid");
    }
  }
  const summary = Object.fromEntries(
    ["tests", "pass", "fail", "cancelled", "skipped"].map((key) => [key, summaryRecord[key]]),
  );
  return { summary, testIds };
}

function readEnvironment(environment, name) {
  const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : environment[key];
}

function requiredEnvironment(environment, name, code = "dsh-production-environment-invalid") {
  const value = readEnvironment(environment, name);
  if (typeof value !== "string" || value.length === 0) throw new DshProductionGateError(code);
  return value;
}

function trustedWindowsPath(environment, { includePowerShellAlias }) {
  const systemRoot = requiredEnvironment(environment, "SystemRoot");
  const paths = [
    join(systemRoot, "System32"),
    systemRoot,
    join(systemRoot, "System32", "Wbem"),
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
  ];
  if (includePowerShellAlias) {
    const localAppData = requiredEnvironment(environment, "LOCALAPPDATA");
    const appAliasDirectory = join(localAppData, "Microsoft", "WindowsApps");
    try {
      if (!statSync(appAliasDirectory).isDirectory()) throw new Error("not-directory");
    } catch {
      throw new DshProductionGateError("dsh-production-environment-invalid");
    }
    paths.unshift(appAliasDirectory);
  }
  return paths.join(";");
}

export function buildDshTestChildEnvironment(environment, { production }) {
  const systemRoot = requiredEnvironment(environment, "SystemRoot");
  const comSpec = requiredEnvironment(environment, "ComSpec");
  const temp = requiredEnvironment(environment, "TEMP");
  const child = {
    SystemRoot: systemRoot,
    SYSTEMROOT: systemRoot,
    WINDIR: systemRoot,
    ComSpec: comSpec,
    COMSPEC: comSpec,
    TEMP: temp,
    TMP: readEnvironment(environment, "TMP") ?? temp,
    PATH: trustedWindowsPath(environment, { includePowerShellAlias: production }),
  };
  if (production) {
    for (const [name] of requiredFixtures) child[name] = requiredEnvironment(environment, name, "dsh-production-fixtures-required");
    child.DSH_REQUIRE_PRODUCTION_FIXTURES = "1";
  } else {
    for (const name of [
      "DSH_GATE_DUPLICATE_ID",
      "DSH_GATE_FORCE_SKIP",
      "DSH_GATE_FORGE_STDOUT",
      "DSH_GATE_SUBSTITUTE_ID",
    ]) {
      const value = readEnvironment(environment, name);
      if (value !== undefined) child[name] = value;
    }
  }
  return child;
}

export function resolveProductionPrepareScript(environment = process.env) {
  if (readEnvironment(environment, "DSH_REQUIRE_PRODUCTION_FIXTURES") !== "1") {
    return readEnvironment(environment, "DSH_PREPARE_SCRIPT") ?? trackedPrepareScript;
  }
  let metadata;
  let canonical;
  try {
    metadata = lstatSync(trackedPrepareScript);
    canonical = realpathSync.native(trackedPrepareScript);
  } catch {
    throw new DshProductionGateError("dsh-production-prepare-script-invalid");
  }
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || canonical.toLowerCase() !== resolve(trackedPrepareScript).toLowerCase()
  ) {
    throw new DshProductionGateError("dsh-production-prepare-script-invalid");
  }
  return canonical;
}

export function runTestInventoryGate({
  nodeExe,
  testFile,
  expectedTests,
  expectedTestIds,
  environment,
  productionEnvironment = false,
  emitOutput = false,
}) {
  if (
    !Array.isArray(expectedTestIds)
    || expectedTestIds.length !== expectedTests
    || new Set(expectedTestIds).size !== expectedTestIds.length
  ) {
    throw new DshProductionGateError("dsh-production-test-inventory-invalid");
  }
  const childEnvironment = buildDshTestChildEnvironment(environment, { production: productionEnvironment });
  const child = spawnSync(nodeExe, [
    "--test",
    `--test-reporter=${pathToFileURL(testReporter).href}`,
    "--test-concurrency=1",
    testFile,
  ], {
    cwd: repoRoot,
    env: childEnvironment,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (emitOutput) {
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
  }
  if (child.error || child.status !== 0) {
    throw new DshProductionGateError("dsh-production-tests-failed", {
      childStatus: child.status,
      childError: child.error,
      stdout: child.stdout,
      stderr: child.stderr,
    });
  }
  const { summary, testIds } = parseTestReport(child.stdout ?? "");
  if (
    summary.tests !== expectedTests
    || summary.pass !== expectedTests
    || summary.fail !== 0
    || summary.cancelled !== 0
    || summary.skipped !== 0
    || testIds.some((id, index) => id !== expectedTestIds[index])
  ) {
    throw new DshProductionGateError("dsh-production-test-inventory-invalid", {
      summary,
      testIds,
      stdout: child.stdout,
      stderr: child.stderr,
    });
  }
  return Object.freeze(summary);
}

function requireProductionFixtures(environment) {
  for (const [name, kind] of requiredFixtures) {
    const value = environment[name];
    if (!value) throw new DshProductionGateError("dsh-production-fixtures-required");
    try {
      const metadata = statSync(value);
      if ((kind === "file" && !metadata.isFile()) || (kind === "directory" && !metadata.isDirectory())) {
        throw new DshProductionGateError("dsh-production-fixtures-required");
      }
    } catch (error) {
      if (error instanceof DshProductionGateError) throw error;
      throw new DshProductionGateError("dsh-production-fixtures-required");
    }
  }
}

function extractExactAppNode(environment, gateRoot) {
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT;
  if (!systemRoot) throw new DshProductionGateError("dsh-production-node-required");
  const windowsPowerShell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const extraction = spawnSync(windowsPowerShell, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "& { param($archive, $destination) Expand-Archive -LiteralPath $archive -DestinationPath $destination }",
    resolve(environment.DSH_NODE_ARCHIVE),
    gateRoot,
  ], { encoding: "utf8", windowsHide: true });
  if (extraction.error || extraction.status !== 0) {
    throw new DshProductionGateError("dsh-production-node-required");
  }
  const appNode = join(gateRoot, `node-v${authority.nodeRuntime.version}-win-x64`, "node.exe");
  let nodeBytes;
  try {
    nodeBytes = readFileSync(appNode);
  } catch {
    throw new DshProductionGateError("dsh-production-node-required");
  }
  if (createHash("sha256").update(nodeBytes).digest("hex") !== authority.nodeRuntime.nodeExeSha256) {
    throw new DshProductionGateError("dsh-production-node-required");
  }
  return appNode;
}

function main() {
  const gateRoot = mkdtempSync(join(tmpdir(), "luckyray-dsh-gate-node-"));
  try {
    requireProductionFixtures(process.env);
    const appNode = extractExactAppNode(process.env, gateRoot);
    runTestInventoryGate({
      nodeExe: appNode,
      testFile: join(repoRoot, "tests", "dshSupplyChain.contract.test.mjs"),
      expectedTests: DSH_PRODUCTION_TEST_INVENTORY.length,
      expectedTestIds: DSH_PRODUCTION_TEST_INVENTORY,
      environment: process.env,
      productionEnvironment: true,
      emitOutput: true,
    });
  } finally {
    rmSync(gateRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    if (error?.stdout) process.stdout.write(error.stdout);
    if (error?.stderr) process.stderr.write(error.stderr);
    process.stderr.write(`${error?.code ?? "dsh-production-gate-failed"}\n`);
    process.exitCode = 1;
  }
}
