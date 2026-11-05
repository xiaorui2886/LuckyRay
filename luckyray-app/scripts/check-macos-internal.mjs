// Disposable visible LSH lifecycle. Only the projected JSON and this app's own
// window image leave the runner. Previously accepted materials are not repeated.
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { APP, TAURI, BUILD, TARGET, SIDECARS, directory, readRegular, jsonNew,
  run, requireNative, isMacosValidationRepository } from "./macos-build-common.mjs";
import { appBuildArguments, buildMacosApp } from "./build-macos.mjs";
import { knownProofSignal } from "./check-macos-lsh-proof.mjs";
import { runLshSurfaceFlow, safeSurfaceExecution, SURFACE_TIMEOUT_MS, SURFACE_CLEANUP_MS } from "./check-macos-lsh-surface-flow.mjs";
import { DiagnosticCollector, diagnosticVocabulary, safeDiagnosticSummary } from "./macos-native-diagnostics.mjs";
import { INTEGRATION_NATIVE_CASES, NOTE_DATA_TIMEOUT_MS, runNativeNoteData, safeNoteDataExecution, requireCachedMacosAppSource } from "./check-macos-note-data.mjs";
import { importStagedMacosSource } from "./import-macos-app-source.mjs";
import { runNoteFlow, safeNoteFlow, emptyNoteFlow, NOTE_PHASES, NOTE_UI_FLAGS, NOTE_TIMEOUT_MS, NOTE_CLEANUP_MS } from "./check-macos-note-flow.mjs";
import { FRONTEND_TEST_PREFIX, INTEGRATION_FRONTEND_TEST_FILES, safeFrontendTestResult } from "./macos-frontend-test-reporter.mjs";

export const PHASES = Object.freeze(["install-frozen-frontend", "native-note-data", "require-existing-app-source", "compile-app", "verify-resources-and-runtimes", "ad-hoc-sign", "real-notes-ui-flow", "real-lsh-surface-flow"]);
export const EVIDENCE_FILES = Object.freeze(["report.json", "LuckyRay-note-flow.png", "LuckyRay-lsh-surface.png"]);
export const PUBLIC_VALIDATION_REF = "refs/heads/codex/mac-product-candidate-20261105";
const EVIDENCE = join(BUILD, "internal-validation-evidence");
const PROFILES = Object.freeze({
  full: Object.freeze({ nativeCases: INTEGRATION_NATIVE_CASES, runLsh: true, requiredPhaseCount: PHASES.length }),
});
export function validationProfile(env) {
  const scope = env.MACOS_VALIDATION_SCOPE ?? "full";
  if (!Object.hasOwn(PROFILES, scope)) throw new Error("macos-internal-scope-invalid");
  return { scope, ...PROFILES[scope] };
}
export function requireValidationCiContext(env) {
  if (env.GITHUB_ACTIONS !== "true" || !isMacosValidationRepository(env.GITHUB_REPOSITORY)
      || env.GITHUB_REF !== PUBLIC_VALIDATION_REF) throw new Error("macos-internal-ci-required");
  return env.GITHUB_REPOSITORY;
}
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const knownExit = value => typeof value === "string" && ((/^\d{1,3}$/.test(value) && Number(value) <= 255)
  || ["SIGABRT", "SIGBUS", "SIGFPE", "SIGHUP", "SIGILL", "SIGINT", "SIGKILL", "SIGPIPE", "SIGQUIT", "SIGSEGV", "SIGTERM", "SIGTRAP", "SIGXCPU", "SIGXFSZ"].includes(value));
export const SAFE_CODES = Object.freeze([
  "macos-note-flow-context-invalid", "macos-note-flow-result-invalid", "macos-note-flow-failed", "macos-note-flow-conflict-unconfirmed",
  "macos-note-data-worker-required", "macos-note-data-result-invalid", "macos-note-data-artifact-invalid", "macos-note-data-failed",
  "macos-note-data-source-input-missing", "macos-note-data-source-input-conflict", "macos-build-source-input-required",
  "macos-arm64-build-required", "macos-internal-ci-required", "macos-internal-temp-worktree-required",
  "macos-internal-source-identity-invalid", "macos-internal-unexpected-bundle-export", "macos-internal-package-manager-mismatch",
  "macos-internal-build-override-rejected",
  "macos-internal-frontend-checks-failed",
  "macos-internal-scope-invalid",
  "macos-lsh-surface-flow-context-invalid", "macos-lsh-surface-flow-result-invalid", "macos-lsh-surface-flow-spawn-failed",
  "macos-lsh-surface-flow-timeout", "macos-lsh-surface-flow-cancelled", "macos-lsh-surface-flow-forced-termination",
  "macos-lsh-surface-flow-exit-failed", "macos-lsh-surface-flow-scenario-failed", "macos-lsh-surface-flow-window-failed",
  "macos-lsh-surface-flow-quit-failed", "macos-lsh-surface-flow-driver-unavailable",
  "macos-lsh-proof-context-invalid", "macos-lsh-proof-result-invalid", "macos-lsh-proof-spawn-failed",
  "macos-lsh-proof-timeout", "macos-lsh-proof-cancelled", "macos-lsh-proof-forced-termination",
  "macos-lsh-proof-output-invalid", "macos-lsh-proof-exit-failed", "macos-lsh-proof-rejected",
  "macos-lsh-source-closure-mismatch", "macos-lsh-seal-directory-invalid", "macos-lsh-seal-file-invalid",
  "macos-lsh-seal-linked-entry", "macos-lsh-seal-path-invalid", "macos-lsh-seal-row-invalid", "macos-lsh-seal-capacity",
  "macos-app-version-mismatch", "macos-app-sidecar-bytes-changed", "macos-app-media-manifest-changed",
  "macos-app-media-bytes-changed", "macos-app-dsh-record-invalid", "macos-app-dsh-bytes-changed",
  "macos-app-distribution-index-changed", "macos-app-cli-contract-mismatch", "macos-app-node-version-invalid",
  "macos-app-dsh-version-invalid", "macos-dsh-distribution-materials-incomplete",
  "macos-dsh-corresponding-source-missing", "macos-dsh-corresponding-source-changed",
  "macos-dsh-distributed-license-changed", "macos-distribution-recipe-changed",
  "macos-real-app-exited-before-window", "macos-real-app-window-timeout", "macos-real-app-exited-before-capture",
  "macos-real-app-capture-invalid", "macos-window-observation-failed", "macos-build-cache-conflict",
  "macos-material-flow-context-invalid", "macos-material-flow-result-invalid", "macos-material-flow-launch-failed",
  "macos-material-flow-observation-timeout", "macos-material-flow-scenario-failed", "macos-material-flow-window-failed", "macos-material-flow-quit-failed",
  "macos-build-download-hash-invalid", "macos-build-linked-output", "macos-build-output-unsafe",
]);

// Never return raw command output, exception messages, filenames or env values.
export function diagnosticSummary(output) {
  return { buildCodes: SAFE_CODES.filter(code => output.includes(code)),
    rustErrorCodes: [...new Set([...output.matchAll(/\berror\[(E\d{4})\]/g)].map(match => match[1]))].sort(),
    ioCodes: ["ENOENT", "EACCES", "EPERM", "ENOSPC", "EIO", "ETIMEDOUT"].filter(code => new RegExp(`\\b${code}\\b`).test(output)) };
}
export function failureSummary(error) {
  if (SAFE_CODES.includes(error?.message)) return { code: error.message };
  const exit = /^macos-build-command-failed:[^\n]+:(\d{1,3}|SIG[A-Z]+)$/.exec(error?.message ?? "");
  if (exit) return { code: "native-command-failed", ...(knownExit(exit[1]) ? { exit: exit[1] } : {}) };
  return { code: "native-validation-failed" };
}
export function internalWorkerEnvironment(input) {
  // Reject product trust/resource overrides before filtering credentials; do
  // not turn an existing reject-on-conflict contract into silent acceptance.
  if (Object.keys(input).some(name => name.startsWith("LUCKYRAY_") || name === "TAURI_CONFIG"))
    throw new Error("macos-internal-build-override-rejected");
  validationProfile(input);
  const env = {};
  for (const name of ["HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL", "CI",
    "GITHUB_ACTIONS", "GITHUB_REPOSITORY", "GITHUB_REF", "GITHUB_SHA", "RUNNER_TEMP", "MACOS_VALIDATION_SCOPE",
    "CARGO_HOME", "RUSTUP_HOME", "RUSTUP_TOOLCHAIN", "CARGO_BUILD_JOBS", "CARGO_ENCODED_RUSTFLAGS",
    "SDKROOT", "DEVELOPER_DIR", "MACOSX_DEPLOYMENT_TARGET", "CFLAGS", "CXXFLAGS", "LDFLAGS",
    "__CF_USER_TEXT_ENCODING", "XPC_FLAGS", "XPC_SERVICE_NAME", "SECURITYSESSIONID"])
    if (typeof input[name] === "string") env[name] = input[name];
  return env;
}
export function summarizeBuildResult(result) {
  const d = result?.distribution;
  if (result?.target !== TARGET || JSON.stringify(result.sidecars) !== JSON.stringify(SIDECARS)
      || typeof result.version !== "string" || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]{1,40})?$/.test(result.version)
      || !count(result.mediaFiles) || !count(result.dshFiles) || !digest(d?.sourceInputsSha256)
      || typeof d.readyToPackage !== "boolean" || !count(d.providedSourceInputs) || !count(d.providedSourceBytes)
      || !Array.isArray(d.missingRequirements) || d.missingRequirements.length > 128
      || d.missingRequirements.some(item => typeof item.id !== "string" || !/^[a-z0-9-]{1,96}$/.test(item.id))
      || d.readyToPackage !== (d.missingRequirements.length === 0))
    throw new Error("macos-internal-result-invalid");
  return { version: result.version, target: TARGET, sidecars: SIDECARS, mediaFiles: result.mediaFiles, dshFiles: result.dshFiles,
    distribution: { readyToPackage: d.readyToPackage, sourceInputsSha256: d.sourceInputsSha256,
      providedSourceInputs: d.providedSourceInputs, providedSourceBytes: d.providedSourceBytes,
      missingRequirementIds: d.missingRequirements.map(item => item.id) } };
}
export function safeIntegrationFrontend(input) {
  if (input == null) return { status: "not-run", cases: [], total: 0, passedCount: 0, failedCount: 0, skippedCount: 0 };
  if (!["not-run", "passed", "failed"].includes(input.status) || !Array.isArray(input.cases) || input.cases.length > 256)
    throw new Error("macos-internal-result-invalid");
  const cases = input.cases.map(value => {
    const row = safeFrontendTestResult(value);
    if (!row || !INTEGRATION_FRONTEND_TEST_FILES.includes(row.file)) throw new Error("macos-internal-result-invalid");
    return row;
  });
  if (input.status === "not-run" && cases.length || input.status === "passed" && (cases.some(row => row.status === "failed" || row.status === "todo")
      || INTEGRATION_FRONTEND_TEST_FILES.some(file => !cases.some(row => row.file === file)))) throw new Error("macos-internal-result-invalid");
  return { status: input.status, cases, total: cases.length, passedCount: cases.filter(row => row.status === "passed").length,
    failedCount: cases.filter(row => row.status === "failed").length, skippedCount: cases.filter(row => row.status === "skipped").length };
}
export async function internalPlan(env = process.env) {
  const profile = validationProfile(env);
  const config = JSON.parse((await readRegular(join(TAURI, "tauri.macos.conf.json"), 64 * 1024)).toString());
  if (config.bundle.macOS.minimumSystemVersion !== "15.0") throw new Error("macos-internal-minimum-profile-invalid");
  return { mode: "internal-native-validation", scope: profile.scope, target: TARGET, minimumSystemVersion: config.bundle.macOS.minimumSystemVersion,
    sourceWorktree: "$RUNNER_TEMP/luckyray-macos-internal", appBuild: ["pnpm", ...appBuildArguments(true)],
    updaterArtifacts: false, sidecars: SIDECARS, phases: PHASES, requiredPhases: PHASES.slice(0, profile.requiredPhaseCount),
    evidenceFiles: profile.runLsh ? EVIDENCE_FILES : EVIDENCE_FILES.slice(0, 2),
    distributionGate: "incomplete source remains ineligible for distribution; supplied bytes remain verified",
    binaryExport: false, dmg: false, applicationArchive: false, binaryUpload: false, release: false,
    rawOutput: "streamed into bounded typed command/error summaries, then discarded", nativeExecution: "not-run-by-plan",
    frontendChecks: { selection: INTEGRATION_FRONTEND_TEST_FILES, typecheck: "complete-app-before-build", failureDoesNotSkipNativeOrApp: true },
    noteData: { compiledFromFrozenProductLock: true, compileFeature: "macos-note-flow", selection: "folder-candidate-adjacent-integration",
      exactTestIds: profile.nativeCases.map(item => item.id), perCaseTimeoutMs: NOTE_DATA_TIMEOUT_MS,
      guiInteraction: "not-run", sourceGate: "existing exact FFmpeg archive required; no internal FFmpeg network fallback" },
    notesUi: { buildFeature: "macos-note-flow", entry: "LuckyRay.app/Contents/MacOS/luckyray-app --macos-note-flow <exercise|reopen> <fixed-disposable-root>",
      phases: NOTE_PHASES, flags: NOTE_UI_FLAGS, perPhaseTimeoutMs: NOTE_TIMEOUT_MS, cleanupGraceMs: NOTE_CLEANUP_MS,
      moveIncludesRenameRoundtrip: true,
      folders: ["dirty-draft-veto", "rename-original-folder", "move-and-update-open-note-path", "retain-empty-directory", "restore-original-directory", "same-profile-reopen"],
      graph: "real-vault-canvas-and-new-folder-path-search-before-and-after-reopen",
      interaction: "application-dom-automation", systemPointerInput: "not-run", nativeFilePicker: "not-run", vaultCreationUi: "not-run",
      missingExactSource: "NOT_RUN; native-note-data remains independently reportable" },
    lshSurfaceFlow: { buildFeature: "macos-lsh-surface-flow", entry: "LuckyRay.app/Contents/MacOS/luckyray-app --macos-lsh-surface-flow <fixed-disposable-root>",
      execution: profile.runLsh ? "planned" : "not-run-in-selected-scope",
      timeoutMs: SURFACE_TIMEOUT_MS, cleanupGraceMs: SURFACE_CLEANUP_MS,
      stages: ["real-surface-attach", "hide-and-show-same-binding", "official-saved-stop", "normal-shutdown"],
      provider: "real-official-dsh-with-no-model-account", materialFlow: "not-run", guiInteraction: "application-dom-automation",
      systemPointerInput: "not-run", screenshotVisualReview: "required" } };
}
export async function requireInternalContext() {
  requireNative();
  const repository = requireValidationCiContext(process.env);
  internalWorkerEnvironment(process.env);
  const temp = await realpath(process.env.RUNNER_TEMP ?? "/missing-runner-temp");
  if (APP !== join(temp, "luckyray-macos-internal/luckyray-app"))
    throw new Error("macos-internal-temp-worktree-required");
  const quiet = { capture: true, stdio: ["ignore", "pipe", "ignore"] };
  const commit = (await run("git", ["rev-parse", "HEAD"], quiet)).trim();
  const tree = (await run("git", ["rev-parse", "HEAD^{tree}"], quiet)).trim();
  const origin = (await run("git", ["remote", "get-url", "origin"], quiet)).trim();
  const changed = (await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], quiet)).trim();
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(tree) || commit !== process.env.GITHUB_SHA
      || changed !== ""
      || ![`https://github.com/${repository}`, `https://github.com/${repository}.git`].includes(origin))
    throw new Error("macos-internal-source-identity-invalid");
  return { repository, commit, tree, cleanBeforeBuild: true };
}
export async function diagnosticContext() {
  const vocabulary = await diagnosticVocabulary(file => readRegular(join(APP, "scripts", file), 4 * 1024 * 1024));
  // Source positions are allowed only for tracked app source paths.
  const tracked = await run("git", ["ls-files", "-z", "--", "src-tauri/src", "src-tauri/build.rs", "src-tauri/build", "src"],
    { capture: true, stdio: ["ignore", "pipe", "ignore"] });
  const files = new Set(tracked.split("\0").filter(file => file.startsWith("src-tauri/") && /\.(?:rs|c|h)$/.test(file)
    || file.startsWith("src/") && /\.(?:ts|tsx)$/.test(file)).map(file => file.startsWith("src-tauri/") ? file.slice("src-tauri/".length) : file));
  return { vocabulary, files };
}
async function worker() {
  if (!process.send) throw new Error("macos-internal-ci-required");
  try {
    await requireInternalContext();
    const profile = validationProfile(process.env);
    process.env.MACOS_INTERNAL_DIAGNOSTICS = "1";
    process.send({ type: "phase", phase: "install-frozen-frontend" });
    if ((await run("pnpm", ["--version"], { capture: true, diagnosticStage: "package-manager-version" })).trim() !== "11.25.0")
      throw new Error("macos-internal-package-manager-mismatch");
    await run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts", "--reporter=silent"], { diagnosticStage: "frontend-install" });
    process.send({ type: "frontend-checks-started" });
    let frontendPassed = true;
    try {
      await run(process.execPath, ["--experimental-strip-types", "--import", "./tests/ts-extension-loader.mjs", "--test",
        "--test-reporter=./scripts/macos-frontend-test-reporter.mjs", ...INTEGRATION_FRONTEND_TEST_FILES], { diagnosticStage: "frontend-build" });
    } catch { frontendPassed = false; }
    process.send({ type: "frontend-checks", passed: frontendPassed });
    process.send({ type: "phase", phase: "native-note-data" });
    const noteData = await runNativeNoteData(internalWorkerEnvironment(process.env), profile.nativeCases);
    process.send({ type: "note-data", execution: noteData });
    // A normal test failure remains failed, while the independent complete app
    // build and UI phases can still supply their own evidence for this SHA.
    process.send({ type: "phase", phase: "require-existing-app-source" });
    try { await importStagedMacosSource(); }
    catch { throw new Error("macos-note-data-source-input-conflict"); }
    await requireCachedMacosAppSource();
    const result = await buildMacosApp({ internalValidation: true,
      onStage: phase => process.send({ type: "phase", phase }) });
    process.send({ type: "built", result });
    process.send({ type: "phase", phase: "real-notes-ui-flow" });
    const notes = await runNoteFlow(result.app, internalWorkerEnvironment(process.env), EVIDENCE);
    process.send({ type: "notes-ui", execution: notes });
    let execution = null;
    if (profile.runLsh) {
      process.send({ type: "phase", phase: "real-lsh-surface-flow" });
      execution = await runLshSurfaceFlow(result.app, internalWorkerEnvironment(process.env), EVIDENCE);
      process.send({ type: "lsh-surface-flow", execution });
    }
    if (!frontendPassed || noteData.status !== "passed" || notes.status !== "passed" || profile.runLsh && execution?.status !== "passed")
      process.exitCode = execution?.exitCode || 1;
  } catch (error) {
    process.send({ type: "failed", failure: failureSummary(error) });
    process.exitCode = 1;
  } finally { process.disconnect(); }
}
export async function validateInternal() {
  const profile = validationProfile(process.env);
  const source = await requireInternalContext();
  const plan = await internalPlan();
  await directory(BUILD);
  // No stale evidence is reused or overwritten, even after an interrupted run.
  await mkdir(EVIDENCE, { mode: 0o700 }); await directory(EVIDENCE);
  const { vocabulary, files } = await diagnosticContext();
  const diagnostics = new DiagnosticCollector(vocabulary, files);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker"],
    { cwd: APP, env: internalWorkerEnvironment(process.env), stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let build; let lsh; let noteData; let notesUi; let failure; let protocolInvalid = false;
  let frontendStatus = "not-run"; let frontendFinished = false; let frontendBuffer = ""; const frontendCases = [];
  const phases = [];
  child.stdout.on("data", bytes => {
    diagnostics.feed("stdout", bytes);
    const lines = (frontendBuffer + bytes.toString()).split(/\r?\n/); frontendBuffer = lines.pop().slice(-8192);
    for (const line of lines) if (line.startsWith(FRONTEND_TEST_PREFIX)) {
      try {
        const row = line.length <= 8192 && safeFrontendTestResult(JSON.parse(line.slice(FRONTEND_TEST_PREFIX.length)));
        if (!row || !INTEGRATION_FRONTEND_TEST_FILES.includes(row.file) || frontendCases.length >= 256) throw new Error();
        frontendCases.push(row);
      } catch { protocolInvalid = true; child.kill("SIGTERM"); }
    }
  });
  child.stderr.on("data", bytes => diagnostics.feed("stderr", bytes));
  child.on("message", message => {
    try {
      if (message?.type === "phase" && message.phase === PHASES[phases.length]) {
        phases.push(message.phase);
        console.log(`macos-internal-phase:${message.phase}`);
      } else if (message?.type === "frontend-checks-started" && phases.length === 1 && frontendStatus === "not-run") {
        frontendStatus = "failed";
      } else if (message?.type === "frontend-checks" && phases.length === 1 && frontendStatus === "failed" && !frontendFinished && typeof message.passed === "boolean") {
        frontendStatus = message.passed ? "passed" : "failed"; frontendFinished = true;
      } else if (message?.type === "note-data" && phases.length === 2 && !noteData) {
        noteData = safeNoteDataExecution(message.execution, profile.nativeCases);
      } else if (message?.type === "built" && phases.length === 6 && !build) {
        build = summarizeBuildResult(message.result);
      } else if (message?.type === "notes-ui" && phases.length === 7 && build && !notesUi) {
        notesUi = safeNoteFlow(message.execution);
      } else if (message?.type === "lsh-surface-flow" && profile.runLsh && phases.length === PHASES.length && build && !lsh) {
        lsh = safeSurfaceExecution(message.execution);
      } else if (message?.type === "failed" && !failure) {
        const f = message.failure;
        if (!SAFE_CODES.includes(f?.code) && !["native-command-failed", "native-validation-failed"].includes(f?.code))
          throw new Error("invalid-failure-code");
        failure = { code: f.code };
        if (f.code === "native-command-failed" && knownExit(f.exit)) failure.exit = f.exit;
      } else throw new Error("invalid-worker-message");
    } catch {
      // During the proof the worker turns this signal into private-pipe
      // cancellation, allowing Rust's retained handles to perform cleanup.
      protocolInvalid = true; child.kill("SIGTERM");
    }
  });
  const exited = await new Promise(resolveExit => {
    child.once("error", () => resolveExit({ code: null, signal: null }));
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  const frontendChecks = safeIntegrationFrontend({ status: frontendStatus, cases: frontendCases });
  const success = exited.code === 0 && !protocolInvalid && !failure && frontendChecks.status === "passed" && !!build && noteData?.status === "passed" && notesUi?.status === "passed"
    && (!profile.runLsh || lsh?.status === "passed") && phases.length === profile.requiredPhaseCount;
  const report = { schemaVersion: 1, mode: "internal-native-validation", scope: profile.scope, source,
    status: success ? "passed" : "failed", minimumSystemVersion: plan.minimumSystemVersion, binaryExport: false,
    distributionReady: build?.distribution.readyToPackage ?? false, distributionAssessment: build ? "verified" : "not-reached",
    phases: PHASES.map((phase, index) => ({ phase,
      status: index >= profile.requiredPhaseCount ? "not-run" : index === 1 && noteData ? noteData.status : index === 6 && notesUi ? notesUi.status : index === 7 && lsh ? lsh.status
        : success || index < phases.length - 1 ? "passed" : index < phases.length ? "failed" : "not-run" })),
    build: build ?? null, lsh: lsh ?? null, noteData: noteData ?? null, notesUi: notesUi ?? emptyNoteFlow(), frontendChecks,
    failure: success ? null : failure ?? { code: protocolInvalid ? "invalid-worker-protocol"
      : frontendChecks.status === "failed" ? "macos-internal-frontend-checks-failed"
      : noteData?.status === "failed" ? "macos-note-data-failed" : notesUi?.status === "failed" ? "macos-note-flow-failed"
      : lsh?.failure ?? "native-worker-failed" },
    workerExit: exited.code, workerSignal: exited.signal,
    diagnostics: safeDiagnosticSummary(diagnostics.summary(), vocabulary, files), rawOutput: "discarded-not-retained",
    artifacts: plan.evidenceFiles,
    limitations: { frontendInteraction: lsh?.ui || notesUi?.exercise.flags.some(Boolean) || notesUi?.reopen.flags.some(Boolean) ? "application-dom-automation" : "not-run", materialFlow: "not-run",
      guiInteraction: lsh?.ui || notesUi?.exercise.flags.some(Boolean) || notesUi?.reopen.flags.some(Boolean) ? "application-dom-automation" : "not-run", modelAccount: "not-configured",
      lshConnection: !profile.runLsh ? "not-run" : lsh?.status === "passed" ? "real-surface-hide-show-saved-stop-and-normal-shutdown" : "not-completed",
      notesRecovery: notesUi?.status === "passed" ? "real-ui-copy-with-foreign-path-preserved" : "not-completed",
      nativeHostBrowserSession: "not-run", mcpSession: "not-run", installIntoApplications: "not-run",
      notarization: "not-requested", release: "not-published" } };
  // Save the same strict projection that the workflow can publish. No raw
  // build result, path, exception, bootstrap challenge or environment is saved.
  await jsonNew(join(EVIDENCE, EVIDENCE_FILES[0]), publishableReport(report, vocabulary, files));
  if (!success) process.exitCode = exited.code || 1;
  return report;
}
export function publishableReport(record, vocabulary = new Set(), files = new Set()) {
  const scope = record?.scope ?? "full";
  if (!Object.hasOwn(PROFILES, scope)) throw new Error("macos-internal-result-invalid");
  const profile = PROFILES[scope];
  if (record?.schemaVersion !== 1 || record.mode !== "internal-native-validation" || record.binaryExport !== false
      || !["passed", "failed"].includes(record.status) || !isMacosValidationRepository(record.source?.repository)
      || !/^[a-f0-9]{40}$/.test(record.source.commit) || !/^[a-f0-9]{40}$/.test(record.source.tree)
      || !Array.isArray(record.phases) || record.phases.length !== PHASES.length
      || record.phases.some((item, i) => item.phase !== PHASES[i] || !["passed", "failed", "not-run"].includes(item.status))
      || record.status === "passed" && (record.workerExit !== 0 || record.workerSignal != null
        || record.phases.some((item, index) => item.status !== (index < profile.requiredPhaseCount ? "passed" : "not-run"))))
    throw new Error("macos-internal-result-invalid");
  const lsh = record.lsh == null ? null : safeSurfaceExecution(record.lsh);
  const build = record.build == null ? null : summarizeStoredBuild(record.build);
  const noteData = record.noteData == null ? null : safeNoteDataExecution(record.noteData, profile.nativeCases);
  const notesUi = safeNoteFlow(record.notesUi ?? emptyNoteFlow());
  const frontendChecks = safeIntegrationFrontend(record.frontendChecks);
  if (record.phases[6].status !== "not-run" && !build
      || record.phases[6].status === "passed" && notesUi.status !== "passed"
      || notesUi.status !== "not-run" && record.phases[6].status !== notesUi.status) throw new Error("macos-internal-result-invalid");
  if (record.phases[1].status === "passed" && noteData?.status !== "passed") throw new Error("macos-internal-result-invalid");
  if (record.distributionReady !== (build?.distribution.readyToPackage ?? false)
      || !profile.runLsh && (lsh != null || record.phases[7].status !== "not-run")
      || record.status === "passed" && (!build || frontendChecks.status !== "passed" || profile.runLsh && lsh?.status !== "passed" || noteData?.status !== "passed" || notesUi.status !== "passed" || record.failure != null))
    throw new Error("macos-internal-result-invalid");
  const failureCodes = [...SAFE_CODES, "native-command-failed", "native-validation-failed", "native-worker-failed", "invalid-worker-protocol"];
  const failure = failureCodes.includes(record.failure?.code) ? { code: record.failure.code } : null;
  if (failure && knownExit(record.failure.exit)) failure.exit = record.failure.exit;
  return { schemaVersion: 1, mode: "internal-native-validation", scope, status: record.status,
    source: { repository: record.source.repository, commit: record.source.commit, tree: record.source.tree },
    phases: record.phases.map(item => ({ phase: item.phase, status: item.status })), failure,
    workerExit: Number.isInteger(record.workerExit) && record.workerExit >= 0 && record.workerExit <= 255 ? record.workerExit : null,
    workerSignal: knownProofSignal(record.workerSignal) ? record.workerSignal : null,
    build,
    diagnostics: safeDiagnosticSummary(record.diagnostics, vocabulary, files), lsh, noteData, notesUi, frontendChecks, binaryExport: false,
    distributionReady: record.distributionReady === true, rawOutput: "not-published",
    knownRemaining: { keychainDatabaseRecreation: { status: "unresolved", currentCandidate: "not-run",
      knownFailure: "returned-original-instead-of-error", strictAssertion: "retained" } },
    coverage: { lsh: !profile.runLsh ? "not-run" : lsh?.status === "passed" ? "real-official-dsh-surface-hide-show-saved-stop-and-normal-shutdown" : "not-completed",
      materialFlow: "not-run", guiInteraction: lsh?.ui || notesUi.exercise.flags.some(Boolean) || notesUi.reopen.flags.some(Boolean) ? "application-dom-automation" : "not-run", modelAccount: "not-configured",
      notesData: noteData?.status === "passed" ? "native-production-io" : "not-completed", notesRecoveryUi: notesUi.status === "passed" ? "dom-import-preview-save-move-delete-conflict-copy-normal-quit-and-reopen" : record.phases[6].status === "not-run" ? "not-run" : "not-completed",
      folderUi: notesUi.exercise.flags.slice(7, 12).every(Boolean) && notesUi.exercise.flags[14] && notesUi.reopen.flags[3] && notesUi.reopen.flags[4]
        ? "dom-dirty-veto-rename-move-delete-original-directory-restore-and-reopen" : notesUi.status === "not-run" ? "not-run" : "not-completed",
      graphUi: notesUi.exercise.flags[12] && notesUi.exercise.flags[13] && notesUi.reopen.flags[5]
        ? "real-vault-canvas-and-moved-note-path-search-before-and-after-reopen" : notesUi.status === "not-run" ? "not-run" : "not-completed",
      phoneSimulation: { pairingAndIdentityRestart: noteData?.cases.find(item => item.id === "identity-keychain-restart")?.status ?? "not-run",
        sameHostPrivateInterfaceTlsHello: noteData?.cases.find(item => item.id === "identity-lan-tls")?.status ?? "not-run",
        physicalPhone: "not-run", crossDeviceWifi: "not-run", defaultUserKeychainConsent: "not-run" },
      attachmentReclaim: profile.runLsh ? noteData?.cases.filter(item => item.id.includes("reclaim")).every(item => item.status === "passed")
        ? "5-selected-native-cases-passed" : "not-completed" : "not-run",
      systemPointerInput: "not-run", screenshotVisualReview: lsh?.screenshotCaptured || notesUi.reopen.screenshotCaptured ? "required" : "not-captured" } };
}
function summarizeStoredBuild(value) {
  const ids = value?.distribution?.missingRequirementIds;
  if (!Array.isArray(ids) || ids.length > 128) throw new Error("macos-internal-result-invalid");
  return summarizeBuildResult({ ...value, distribution: { ...value.distribution,
    missingRequirements: ids.map(id => ({ id })) } });
}
async function printReportSummary() {
  // Generated output is ignored by Git. Keep the same clean-source and exact
  // CI location/origin/HEAD requirements when publishing the typed report.
  const source = await requireInternalContext();
  const record = JSON.parse((await readRegular(join(EVIDENCE, EVIDENCE_FILES[0]), 64 * 1024)).toString());
  if (record.source?.commit !== source.commit || record.source?.tree !== source.tree)
    throw new Error("macos-internal-source-identity-invalid");
  if ((record.scope ?? "full") !== validationProfile(process.env).scope) throw new Error("macos-internal-scope-invalid");
  const { vocabulary, files } = await diagnosticContext();
  console.log(`MACOS_NATIVE_REPORT ${JSON.stringify(publishableReport(record, vocabulary, files))}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length === 3 && process.argv[2] === "--plan") console.log(JSON.stringify(await internalPlan(), null, 2));
    else if (process.argv.length === 3 && process.argv[2] === "--print-summary") await printReportSummary();
    else if (process.argv.length === 3 && process.argv[2] === "--worker") await worker();
    else if (process.argv.length === 2) await validateInternal();
    else throw new Error("macos-internal-arguments-invalid");
  } catch (error) { console.error(JSON.stringify(failureSummary(error))); process.exitCode = 1; }
}
