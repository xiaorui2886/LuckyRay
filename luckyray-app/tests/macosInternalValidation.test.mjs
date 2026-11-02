import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { internalPlan, diagnosticSummary, failureSummary, summarizeBuildResult, internalWorkerEnvironment } from "../scripts/check-macos-internal.mjs";

test("internal LSH surface plan uses the full locked app and fixed own-window evidence", async () => {
  const plan = await internalPlan();
  assert.deepEqual(plan.sidecars, ["luckyray-native-host", "luckyray-cli", "luckyray-mcp"]);
  assert.deepEqual(plan.evidenceFiles, ["report.json", "LuckyRay-lsh-surface.png"]);
  assert.equal(plan.minimumSystemVersion, "15.0");
  assert.equal(plan.appBuild[plan.appBuild.indexOf("--bundles") + 1], "app");
  assert.deepEqual(JSON.parse(plan.appBuild[plan.appBuild.indexOf("--config") + 1]), { bundle: { createUpdaterArtifacts: false } });
  assert(plan.appBuild.includes("--locked"));
  assert(plan.appBuild.includes("browser-host-runtime"));
  assert(plan.appBuild.includes("macos-lsh-surface-flow"));
  assert(!plan.appBuild.includes("macos-lsh-proof"));
  assert(!plan.appBuild.includes("macos-material-flow"));
  assert.equal(plan.phases.at(-1), "real-lsh-surface-flow");
  assert.equal(plan.lshSurfaceFlow.entry, "LuckyRay.app/Contents/MacOS/luckyray-app --macos-lsh-surface-flow <fixed-disposable-root>");
  assert.equal(plan.lshSurfaceFlow.timeoutMs, 1200000);
  assert.equal(plan.lshSurfaceFlow.cleanupGraceMs, 90000);
  assert.equal(plan.lshSurfaceFlow.materialFlow, "not-run");
  assert.equal(plan.lshSurfaceFlow.systemPointerInput, "not-run");
  assert.equal(plan.appBuild[plan.appBuild.indexOf("--bin") + 1], "luckyray-app");
  for (const key of ["binaryExport", "dmg", "applicationArchive", "binaryUpload", "release"]) assert.equal(plan[key], false);
  assert.equal(plan.nativeExecution, "not-run-by-plan");
});

test("diagnostics discard raw material, paths, credentials and unknown error messages", () => {
  const canary = "private_test_value_never_publish";
  const raw = `secret=${canary} /private/profile/${canary}\nmaterial body ${canary}\nerror[E0425]: ${canary}\nEACCES\nmacos-app-dsh-bytes-changed\nmacos-${canary}`;
  assert.deepEqual(diagnosticSummary(raw), { buildCodes: ["macos-app-dsh-bytes-changed"], rustErrorCodes: ["E0425"], ioCodes: ["EACCES"] });
  assert.deepEqual(failureSummary(new Error(raw)), { code: "native-validation-failed" });
  const projected = failureSummary(new Error(`macos-build-command-failed:/private/${canary}:1`));
  assert.deepEqual(projected, { code: "native-command-failed", exit: "1" });
  assert(!JSON.stringify(projected).includes(canary));
  assert.deepEqual(internalWorkerEnvironment({ HOME: "/runner", PATH: "/tools/bin", RUNNER_TEMP: "/runner/tmp",
    GITHUB_SHA: "a".repeat(40), ACTIONS_RUNTIME_TOKEN: canary, GH_TOKEN: canary, OPENAI_API_KEY: canary,
    NODE_OPTIONS: canary, DYLD_INSERT_LIBRARIES: canary }),
  { HOME: "/runner", PATH: "/tools/bin", GITHUB_SHA: "a".repeat(40), RUNNER_TEMP: "/runner/tmp" });
  assert.throws(() => internalWorkerEnvironment({ LUCKYRAY_DSH_UPDATE_FEED: canary }), /macos-internal-build-override-rejected/);
  assert.throws(() => internalWorkerEnvironment({ TAURI_CONFIG: canary }), /macos-internal-build-override-rejected/);
});

test("report projection retains incomplete distribution and rejects invented ready status", () => {
  const canary = "private_test_value_never_publish";
  const input = { version: "1.9.9", target: "aarch64-apple-darwin",
    sidecars: ["luckyray-native-host", "luckyray-cli", "luckyray-mcp"], mediaFiles: 12, dshFiles: 34,
    app: `/private/${canary}`, credential: canary, distribution: {
      sourceInputsSha256: "a".repeat(64), readyToPackage: false, providedSourceInputs: 25, providedSourceBytes: 493541525,
      missingRequirements: [{ id: "missing-source", reason: canary, url: canary }], rawMaterial: canary } };
  const summary = summarizeBuildResult(input);
  assert.equal(summary.distribution.readyToPackage, false);
  assert.deepEqual(summary.distribution.missingRequirementIds, ["missing-source"]);
  assert(!JSON.stringify(summary).includes(canary));
  assert.throws(() => summarizeBuildResult({ ...input, distribution: { ...input.distribution, readyToPackage: true } }), /macos-internal-result-invalid/);
  assert.throws(() => summarizeBuildResult({ ...input, dshFiles: Infinity }), /macos-internal-result-invalid/);
});

test("a real command refuses non-disposable execution without starting a build", () => {
  const command = fileURLToPath(new URL("../scripts/check-macos-internal.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [command], { encoding: "utf8", timeout: 10000,
    env: { ...process.env, GITHUB_ACTIONS: "false", GITHUB_REPOSITORY: "invalid/fixture" } });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), { code: process.platform === "darwin" && process.arch === "arm64"
    ? "macos-internal-ci-required" : "macos-arm64-build-required" });
});
