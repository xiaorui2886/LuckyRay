import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { internalPlan, diagnosticSummary, failureSummary, summarizeBuildResult, internalWorkerEnvironment, safeIntegrationFrontend, validationProfile, requireValidationCiContext, PUBLIC_VALIDATION_REF } from "../scripts/check-macos-internal.mjs";
import { isMacosValidationRepository } from "../scripts/macos-build-common.mjs";
import { INTEGRATION_FRONTEND_TEST_FILES } from "../scripts/macos-frontend-test-reporter.mjs";

test("native validation accepts only the explicit public project repository", () => {
  assert.equal(isMacosValidationRepository("xiaorui2886/LuckyRay"), true);
  for (const value of ["xiaorui2886/other", "other/LuckyRay", "xiaorui2886/luckyray", "xiaorui2886/LuckyRay/extra", "", undefined])
    assert.equal(isMacosValidationRepository(value), false);
});

test("public candidate workflow binds its exact source and prints only the projected summary", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/macos-product-candidate.yml", import.meta.url), "utf8");
  assert(workflow.includes("branches: [codex/mac-product-candidate-20261105]"));
  assert(workflow.includes("github.repository == 'xiaorui2886/LuckyRay'"));
  assert(workflow.includes("github.event.repository.private == false"));
  assert(workflow.includes(`github.ref == '${PUBLIC_VALIDATION_REF}'`));
  assert(workflow.includes("ref: ${{ github.sha }}"));
  assert(workflow.includes('git worktree add --detach "$RUNNER_TEMP/luckyray-macos-internal" "$GITHUB_SHA"'));
  assert(workflow.includes("contents: read"));
  assert(workflow.includes("persist-credentials: false"));
  assert(workflow.includes("MACOS_VALIDATION_SCOPE: full"));
  assert(workflow.includes("node scripts/fetch-macos-app-source.mjs"));
  assert(workflow.includes("node scripts/check-macos-internal.mjs > /dev/null 2>&1 || macos_validation_exit=$?"));
  assert(workflow.includes("node scripts/check-macos-internal.mjs --print-summary"));
  assert(workflow.includes('exit "$macos_validation_exit"'));
  assert(!workflow.includes("upload-artifact"));
});

test("internal LSH surface plan uses the full locked app and fixed own-window evidence", async () => {
  const plan = await internalPlan({});
  assert.deepEqual(plan.sidecars, ["luckyray-native-host", "luckyray-cli", "luckyray-mcp"]);
  assert.deepEqual(plan.evidenceFiles, ["report.json", "LuckyRay-note-flow.png", "LuckyRay-lsh-surface.png"]);
  assert.equal(plan.minimumSystemVersion, "15.0");
  assert.equal(plan.appBuild[plan.appBuild.indexOf("--bundles") + 1], "app");
  assert.deepEqual(JSON.parse(plan.appBuild[plan.appBuild.indexOf("--config") + 1]), { bundle: { createUpdaterArtifacts: false } });
  assert(plan.appBuild.includes("--locked"));
  assert(plan.appBuild.includes("browser-host-runtime"));
  assert(plan.appBuild.includes("macos-lsh-surface-flow"));
  assert(plan.appBuild.includes("macos-note-flow"));
  assert.equal(plan.notesUi.nativeFilePicker, "not-run");
  assert.equal(plan.notesUi.vaultCreationUi, "not-run");
  assert.equal(plan.phases.at(-2), "real-notes-ui-flow");
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
  assert.deepEqual(plan.frontendChecks.selection, INTEGRATION_FRONTEND_TEST_FILES);
  assert.equal(plan.frontendChecks.failureDoesNotSkipNativeOrApp, true);
  assert.equal(plan.scope, 'full');assert.equal(plan.noteData.exactTestIds.length, 32);
  assert.equal(plan.lshSurfaceFlow.execution, 'planned');
});

test("public validation retains the full native, notes and LSH scope and rejects partial selections", async () => {
  const env = { MACOS_VALIDATION_SCOPE: 'full', GITHUB_REPOSITORY: 'xiaorui2886/LuckyRay', GITHUB_REF: PUBLIC_VALIDATION_REF };
  const plan = await internalPlan(env);
  assert.equal(plan.scope, 'full');
  assert.equal(plan.noteData.exactTestIds.length, 32);
  assert(plan.noteData.exactTestIds.includes('folder-attachment-projection'));
  assert(plan.noteData.exactTestIds.includes('folder-attachment-replacement'));
  assert.equal(plan.lshSurfaceFlow.execution, 'planned');
  assert.deepEqual(plan.requiredPhases, plan.phases);
  assert.equal(plan.requiredPhases.at(-1), 'real-lsh-surface-flow');
  assert.deepEqual(plan.evidenceFiles, ['report.json', 'LuckyRay-note-flow.png', 'LuckyRay-lsh-surface.png']);
  assert.equal(validationProfile({}).runLsh, true);
  assert.deepEqual(internalWorkerEnvironment(env), env);
  for (const scope of ['partial', 'unchecked', '', 'constructor']) {
    const bad = { ...env, MACOS_VALIDATION_SCOPE: scope };
    assert.throws(() => validationProfile(bad), /scope-invalid/);
    assert.throws(() => internalWorkerEnvironment(bad), /scope-invalid/);
    await assert.rejects(() => internalPlan(bad), /scope-invalid/);
  }
});

test("public native execution requires the exact candidate branch and Actions context", async () => {
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'xiaorui2886/LuckyRay', GITHUB_REF: PUBLIC_VALIDATION_REF };
  assert.equal(requireValidationCiContext(env), 'xiaorui2886/LuckyRay');
  for (const change of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_REPOSITORY: 'example/other' },
    { GITHUB_REF: 'refs/heads/main' }, { GITHUB_REF: 'refs/tags/candidate' }, { GITHUB_REF: 'refs/pull/1/merge' }, { GITHUB_REF: undefined }])
    assert.throws(() => requireValidationCiContext({ ...env, ...change }), /ci-required/);
  for (const path of ['../src-tauri/src/macos_note_flow.rs', '../src-tauri/src/dsh_host/macos_surface_flow.rs']) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert(source.includes('std::env::var("GITHUB_REPOSITORY").as_deref() != Ok("xiaorui2886/LuckyRay")'));
  }
});

test("candidate frontend projection requires every selected file and preserves failures", () => {
  const rows = INTEGRATION_FRONTEND_TEST_FILES.map(file => ({ file, line: 1, column: 1, status: 'passed', errorCode: null, raw: 'must-not-leave-worker' }));
  const passed = safeIntegrationFrontend({ status: 'passed', cases: rows });
  assert.equal(passed.passedCount, rows.length);assert(!JSON.stringify(passed).includes('must-not-leave-worker'));
  assert.throws(() => safeIntegrationFrontend({ status: 'passed', cases: rows.slice(1) }), /result-invalid/);
  const failedRows = rows.map((row, i) => i === 0 ? { ...row, status: 'failed', errorCode: 'ERR_ASSERTION' } : row);
  assert.throws(() => safeIntegrationFrontend({ status: 'passed', cases: failedRows }), /result-invalid/);
  assert.equal(safeIntegrationFrontend({ status: 'failed', cases: failedRows }).failedCount, 1);
  assert.equal(safeIntegrationFrontend(null).status, 'not-run');
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
    env: { ...process.env, MACOS_VALIDATION_SCOPE: "full", GITHUB_ACTIONS: "false", GITHUB_REPOSITORY: "invalid/fixture" } });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), { code: process.platform === "darwin" && process.arch === "arm64"
    ? "macos-internal-ci-required" : "macos-arm64-build-required" });
});
