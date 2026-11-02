// One compiled product test binary, exact affected tests, synthetic data only.
// Compiler/test streams stay inside the existing worker's bounded projection.
import { join, dirname, basename } from "node:path";
import { lstat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { APP, TAURI, BUILD, TARGET, requireNative, readRegular, sha256, directory } from "./macos-build-common.mjs";
import { commandEvent, safeExit } from "./macos-native-diagnostics.mjs";
import { SOURCES } from "./check-macos-media-sources.mjs";

const io = "knowledge::macos_attachment_io::tests::";
const remove = "knowledge::macos_note_remove::tests::";
const store = "knowledge::macos_operation_store::tests::";
const key = "knowledge::macos_recovery_key::tests::";
const recovery = "knowledge::macos_note_recovery::tests::";
const operation = "knowledge::macos_operation_recovery_tests::";
export const NOTE_DATA_CASES = Object.freeze([
  ["attachment-new-name", io + "macos_attachment_new_name_preserves_conflict_and_allows_normal_directory_mode"],
  ["attachment-source-identity", io + "macos_attachment_observation_detects_same_bytes_replacement_and_source_links"],
  ["attachment-staging-identity", io + "macos_attachment_replaced_staging_and_linked_directory_are_preserved"],
  ["attachment-root-identity", io + "macos_attachment_root_replacement_never_recreates_or_writes_a_new_vault"],
  ["attachment-capacity", io + "macos_attachment_blob_limit_does_not_raise_note_or_credential_limits"],
  ["remove-retained-inode", remove + "macos_note_remove_retains_the_original_inode_and_delayed_writer"],
  ["remove-source-replacement", remove + "macos_note_remove_source_replacement_never_moves_the_new_object"],
  ["remove-unconfirmed", remove + "macos_note_remove_post_move_failure_remains_unconfirmed_with_both_evidence_objects"],
  ["operation-record-chunks", store + "macos_operation_record_chunks_large_payload_and_refuses_manifest_replacement"],
  ["operation-record-location", store + "macos_operation_store_refuses_linked_or_nonprivate_locations_without_chmod"],
  ["recovery-key-legacy", key + "macos_recovery_key_reuses_qualified_legacy_authority_without_moving_it"],
  ["recovery-key-permissions", key + "macos_recovery_key_is_private_stable_and_does_not_adopt_changed_permissions"],
  ["recovery-key-conflict", key + "macos_recovery_key_conflict_keeps_both_original_objects"],
  ["recovery-copy-restore", recovery + "macos_note_recovery_copies_without_clobbering_then_restores_the_original_inode"],
  ["recovery-copy-conflict", recovery + "macos_note_recovery_rejects_equal_bytes_at_a_replaced_inode_and_retains_pending_permissions"],
  ["write-conflict-recovery", "knowledge::macos_transactions::tests::macos_platform_note_write_conflict_and_recovery"],
  ["operation-created-object", operation + "macos_recovery_never_adopts_a_same_bytes_replacement_of_a_created_note"],
  ["operation-rewrite-object", operation + "macos_recovery_completion_and_rewrite_undo_require_the_published_note_inode"],
  ["operation-removed-object", operation + "macos_recovery_of_a_removed_path_requires_the_retained_original_object"],
  ["operation-resume-rollback", operation + "macos_recovery_resumes_and_rolls_back_only_the_durably_bound_objects"],
].map(([id, test]) => Object.freeze({ id, test })));
export const NOTE_DATA_TIMEOUT_MS = 120000;
export const NOTE_DATA_MESSAGE_FORMAT = "--message-format=json-render-diagnostics";
export function noteDataCompileEnvironment(env) {
  if (Object.hasOwn(env, "TAURI_CONFIG")) throw new Error("macos-note-data-config-override-rejected");
  // Library tests run before runtime/sidecar preparation. This fixed child-only
  // override does not enter the later complete app build or its resource gate.
  return { ...env, TAURI_CONFIG: JSON.stringify({ bundle: { externalBin: [], resources: [] } }) };
}
export function singleNativeTestPassed(text, exit, signal) {
  return exit === 0 && signal == null && typeof text === "string" && text.length <= 8 * 1024 * 1024
    && [...text.matchAll(/^running \d+ tests?\r?$/gm)].length === 1
    && [...text.matchAll(/^test result:[^\r\n]*$/gm)].length === 1
    && /^running 1 test\r?$/m.test(text)
    && /^test result: ok\. 1 passed; 0 failed; 0 ignored; 0 measured; \d+ filtered out;[^\r\n]*$/m.test(text);
}
export function safeNoteDataExecution(input) {
  if (!input || !["passed", "failed"].includes(input.status) || typeof input.compiled !== "boolean"
      || !Array.isArray(input.cases) || input.cases.length !== NOTE_DATA_CASES.length
      || !["none", "compile-failed", "artifact-invalid", "test-failed"].includes(input.failure)) throw new Error("macos-note-data-result-invalid");
  const cases = input.cases.map((item, index) => {
    if (item?.id !== NOTE_DATA_CASES[index].id || !["passed", "failed", "not-run"].includes(item.status)
        || item.exit !== null && !safeExit(item.exit)
        || item.status === "passed" && item.exit !== 0
        || item.status === "not-run" && item.exit !== null) throw new Error("macos-note-data-result-invalid");
    return { id: item.id, status: item.status, exit: item.exit };
  });
  const passed = input.compiled && cases.every(item => item.status === "passed") && input.failure === "none";
  let stopped = false; let failed = 0;
  for (const item of cases) {
    if (stopped && item.status !== "not-run") throw new Error("macos-note-data-result-invalid");
    if (item.status !== "passed") stopped = true;
    if (item.status === "failed") failed += 1;
  }
  if ((input.status === "passed") !== passed || input.status === "failed" && input.failure === "none"
      || !input.compiled && (cases.some(item => item.status !== "not-run") || !["compile-failed", "artifact-invalid"].includes(input.failure))
      || input.compiled && input.failure === "compile-failed" || input.failure === "test-failed" && failed !== 1)
    throw new Error("macos-note-data-result-invalid");
  return { status: input.status, compiled: input.compiled, failure: input.failure, cases,
    passedCount: cases.filter(item => item.status === "passed").length, total: NOTE_DATA_CASES.length };
}
async function nativeCommand(command, args, env, stage, timeout = undefined) {
  const started = Date.now(); const startedId = commandEvent("start", stage, command);
  return new Promise(resolveResult => {
    const child = spawn(command, args, { cwd: TAURI, env, stdio: ["ignore", "pipe", "pipe"], timeout });
  let text = ""; let oversized = false; let spawnFailed = false;
    child.stdout.on("data", bytes => {
      // This function is permitted only inside check-macos-internal's worker.
      // The parent parses bounded typed diagnostics and never prints raw data.
      process.stdout.write(bytes);
      text += bytes.toString();
      if (text.length > 8 * 1024 * 1024) { oversized = true; text = ""; child.kill("SIGTERM"); }
    });
    child.stderr.on("data", bytes => process.stderr.write(bytes));
    child.once("error", () => {
      spawnFailed = true;
      if (startedId) commandEvent("exit", stage, command, { startedId, exit: "SPAWN_ERROR", elapsedMs: Date.now() - started });
      resolveResult({ text: "", exit: "SPAWN_ERROR", signal: null });
    });
    child.once("close", (exit, signal) => {
      if (spawnFailed) return;
      if (startedId) commandEvent("exit", stage, command, { startedId, exit: exit ?? signal, elapsedMs: Date.now() - started });
      resolveResult({ text: oversized ? "" : text, exit: exit ?? signal, signal });
    });
  });
}
export async function runNativeNoteData(env) {
  requireNative();
  if (!process.send || process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== "xiaorui2886/LuckyRay")
    throw new Error("macos-note-data-worker-required");
  const result = { status: "failed", compiled: false, failure: "compile-failed",
    cases: NOTE_DATA_CASES.map(({ id }) => ({ id, status: "not-run", exit: null })) };
  // Cargo keeps executable artifact records on stdout and renders compiler
  // diagnostics on stderr for the existing bounded, public-source projection.
  const built = await nativeCommand("cargo", ["test", "--locked", "--target", TARGET, "--lib", "--no-default-features", "--features", "macos-note-flow", "--no-run", NOTE_DATA_MESSAGE_FORMAT], noteDataCompileEnvironment(env), "native-note-data-compile");
  if (built.exit !== 0 || built.signal != null) return safeNoteDataExecution(result);
  const artifacts = built.text.split(/\r?\n/).flatMap(line => {
    try { const item = JSON.parse(line); return item.reason === "compiler-artifact" && item.target?.name === "luckyray_app_lib"
      && item.target.src_path === join(TAURI, "src", "lib.rs")
      && item.profile?.test === true && typeof item.executable === "string" ? [item.executable] : []; } catch { return []; }
  });
  const executables = [...new Set(artifacts)];
  const executable = executables[0];
  if (executables.length !== 1 || dirname(executable) !== join(TAURI, "target", TARGET, "debug", "deps")
      || !/^luckyray_app_lib-[a-f0-9]+$/.test(basename(executable))) { result.failure = "artifact-invalid"; return safeNoteDataExecution(result); }
  await directory(dirname(executable));
  const identity = await lstat(executable);
  if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1 || identity.uid !== process.geteuid()
      || (identity.mode & 0o022) || !(identity.mode & 0o100)) throw new Error("macos-note-data-artifact-invalid");
  result.compiled = true; result.failure = "test-failed";
  for (let i = 0; i < NOTE_DATA_CASES.length; i++) {
    const current = await lstat(executable);
    if (current.dev !== identity.dev || current.ino !== identity.ino || current.size !== identity.size
        || current.ctimeMs !== identity.ctimeMs || current.mtimeMs !== identity.mtimeMs) throw new Error("macos-note-data-artifact-invalid");
    const execution = await nativeCommand(executable, [NOTE_DATA_CASES[i].test, "--exact", "--test-threads=1", "--quiet"], env,
      "native-note-data-test", NOTE_DATA_TIMEOUT_MS);
    const passed = singleNativeTestPassed(execution.text, execution.exit, execution.signal);
    const after = await lstat(executable);
    if (after.dev !== identity.dev || after.ino !== identity.ino || after.size !== identity.size
        || after.ctimeMs !== identity.ctimeMs || after.mtimeMs !== identity.mtimeMs) {
      result.failure = "artifact-invalid";
      result.cases[i] = { id: NOTE_DATA_CASES[i].id, status: "failed", exit: execution.exit };
      return safeNoteDataExecution(result);
    }
    result.cases[i] = { id: NOTE_DATA_CASES[i].id, status: passed ? "passed" : "failed", exit: execution.exit };
    if (!passed) return safeNoteDataExecution(result);
  }
  result.status = "passed"; result.failure = "none"; return safeNoteDataExecution(result);
}

// No network or fallback source. Absence blocks the full app phase after the
// service tests, rather than silently repeating the known unavailable fetch.
export async function requireCachedMacosAppSource() {
  const path = join(BUILD, "cache", SOURCES.ffmpeg.sha256);
  let bytes;
  try { bytes = await readRegular(path, 128 * 1024 * 1024); }
  catch (error) {
    if (error.code === "ENOENT") throw new Error("macos-note-data-source-input-missing");
    throw new Error("macos-note-data-source-input-conflict");
  }
  const meta = await lstat(path);
  if (sha256(bytes) !== SOURCES.ffmpeg.sha256 || meta.uid !== process.geteuid() || (meta.mode & 0o022))
    throw new Error("macos-note-data-source-input-conflict");
  return { sourceSha256: SOURCES.ffmpeg.sha256, status: "verified-existing-source" };
}
