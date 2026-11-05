// One compiled product test binary, exact affected tests, synthetic data only.
// Compiler/test streams stay inside the existing worker's bounded projection.
import { join, dirname, basename } from "node:path";
import { lstat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { APP, TAURI, BUILD, TARGET, requireNative, readRegular, sha256, directory, isMacosValidationRepository } from "./macos-build-common.mjs";
import { commandEvent, safeExit } from "./macos-native-diagnostics.mjs";
import { SOURCES } from "./check-macos-media-sources.mjs";

const io = "knowledge::macos_attachment_io::tests::";
const remove = "knowledge::macos_note_remove::tests::";
const store = "knowledge::macos_operation_store::tests::";
const key = "knowledge::macos_recovery_key::tests::";
const recovery = "knowledge::macos_note_recovery::tests::";
const operation = "knowledge::macos_operation_recovery_tests::";
// Explicit fixed vocabulary: the parent projects only these codes, never a
// backend error message or temporary path from the child process.
export const FIXTURE_DIAGNOSTIC_CODES = Object.freeze([
  "macos-fixture-root-canonicalize", "macos-fixture-backend-app-data",
  "macos-fixture-backend-media-transfer", "macos-fixture-backend-knowledge",
  "macos-fixture-backend-tool", "macos-fixture-backend-storage",
  "macos-fixture-backend-other", "macos-fixture-linked-path-accepted",
  "macos-keychain-fixture-unavailable",
  "macos-lan-fixture-no-private-interface", "macos-lan-interface-changed", "macos-lan-bind-failed",
  "macos-lan-gateway-start-failed", "macos-lan-tls-connect-failed",
  "macos-keychain-profile-open-failed", "macos-keychain-profile-current-failed",
  "macos-keychain-default-failed", "macos-keychain-search-failed", "macos-keychain-read-failed", "macos-keychain-add-failed",
  "macos-keychain-empty-result", "macos-keychain-ambiguous-result", "macos-keychain-unexpected-result",
  "macos-keychain-record-select-failed", "macos-keychain-record-read-failed", "macos-keychain-record-invalid",
  "macos-keychain-status-param", "macos-keychain-status-unavailable", "macos-keychain-status-read-only",
  "macos-keychain-status-auth-failed", "macos-keychain-status-no-keychain", "macos-keychain-status-invalid-keychain",
  "macos-keychain-status-duplicate", "macos-keychain-status-not-found", "macos-keychain-status-no-default",
  "macos-keychain-status-interaction-not-allowed", "macos-keychain-status-interaction-required",
  "macos-keychain-status-missing-entitlement", "macos-keychain-status-other",
  "macos-keychain-swap-hook-entered", "macos-keychain-swap-deletion-confirmed",
  "macos-keychain-swap-replacement-stored", "macos-keychain-swap-returned-data",
  "macos-keychain-swap-returned-missing", "macos-keychain-swap-returned-error",
  "macos-keychain-swap-delete-unconfirmed", "macos-keychain-swap-hook-not-completed",
  "macos-keychain-record-child-opened", "macos-keychain-record-child-deleted",
  "macos-keychain-record-child-recreated", "macos-keychain-record-child-verified",
  "macos-keychain-record-child-renamed", "macos-keychain-record-renamed-selection-rebound",
  "macos-keychain-record-child-source-invalid", "macos-keychain-record-child-target-invalid",
  "macos-keychain-record-child-old-key-remained", "macos-keychain-record-child-rename-failed",
  "macos-keychain-record-child-renamed-source-invalid", "macos-keychain-record-child-keychain-delete-failed",
  "macos-keychain-record-child-keychain-not-new",
  "macos-keychain-record-child-keychain-source-path-mismatch", "macos-keychain-record-child-keychain-delete-unconfirmed",
  "macos-keychain-record-child-keychain-recreated-path-mismatch",
  "macos-keychain-record-recreated-returned-original", "macos-keychain-record-recreated-returned-different",
  "macos-keychain-record-recreated-returned-other", "macos-keychain-record-recreated-returned-missing",
  "macos-keychain-record-recreated-returned-error",
  "macos-keychain-record-child-timeout", "macos-keychain-record-child-failed",
  "macos-keychain-record-child-protocol-invalid", "macos-keychain-record-child-scope-invalid",
  "macos-keychain-record-child-spawn-failed", "macos-keychain-record-fixture-path-failed",
  "macos-keychain-record-replacement-was-adopted", "macos-keychain-record-recreated-keychain-was-adopted",
  "macos-keychain-record-replacement-fixture-invalid", "macos-keychain-record-reopen-changed-identity",
  "macos-keychain-guard-target-unsupported", "macos-keychain-guard-compiler-unavailable",
  "macos-keychain-guard-compile-failed", "macos-keychain-guard-archiver-unavailable", "macos-keychain-guard-archive-failed",
  "macos-keychain-identity-unavailable", "macos-keychain-identity-path-invalid",
  "macos-keychain-identity-database", "macos-keychain-identity-certificate", "macos-keychain-identity-serialization",
  "macos-keychain-identity-recovery", "macos-keychain-identity-other", "macos-keychain-identity-unexpected-success",
]);
export const NOTE_DATA_CASES = Object.freeze([
  ["fixture-canonical-path", "companion_gateway::content::notes::fixture_support::canonical_fixture_root_does_not_weaken_link_rejection"],
  ["folder-create-existing", "knowledge::companion_folders::macos_companion_folder_create::tests::macos_folder_create_rejects_existing_and_matches_standard_mode"],
  ["folder-create-parent-swap", "knowledge::companion_folders::macos_companion_folder_create::tests::macos_folder_create_uses_held_parent_after_a_temporary_swap"],
  ["folder-create-parent-displaced", "knowledge::companion_folders::macos_companion_folder_create::tests::macos_folder_create_preserves_a_displaced_parent_and_reports_uncertain"],
  ["folder-create-conflict-displaced", "knowledge::companion_folders::macos_companion_folder_create::tests::macos_folder_create_does_not_report_conflict_in_a_displaced_parent"],
  ["folder-create-route-and-import", "companion_gateway::content::notes::tests::unified_notes_plan_publishes_complete_cyclic_markdown_at_reserved_unicode_paths"],
  ["attachment-new-name", io + "macos_attachment_new_name_preserves_conflict_and_allows_normal_directory_mode"],
  ["attachment-source-identity", io + "macos_attachment_observation_detects_same_bytes_replacement_and_source_links"],
  ["attachment-staging-identity", io + "macos_attachment_replaced_staging_and_linked_directory_are_preserved"],
  ["attachment-root-identity", io + "macos_attachment_root_replacement_never_recreates_or_writes_a_new_vault"],
  ["attachment-capacity", io + "macos_attachment_blob_limit_does_not_raise_note_or_credential_limits"],
  ["remove-retained-inode", remove + "macos_note_remove_retains_the_original_inode_and_delayed_writer"],
  ["remove-source-replacement", remove + "macos_note_remove_source_replacement_never_moves_the_new_object"],
  ["remove-late-replacement", remove + "macos_note_remove_late_replacement_is_preserved_as_unconfirmed"],
  ["remove-unconfirmed", remove + "macos_note_remove_post_move_failure_remains_unconfirmed_with_both_evidence_objects"],
  ["operation-record-chunks", store + "macos_operation_record_chunks_large_payload_and_refuses_manifest_replacement"],
  ["operation-record-location", store + "macos_operation_store_refuses_linked_or_nonprivate_locations_without_chmod"],
  ["recovery-key-legacy", key + "macos_recovery_key_reuses_qualified_legacy_authority_without_moving_it"],
  ["recovery-key-permissions", key + "macos_recovery_key_is_private_stable_and_does_not_adopt_changed_permissions"],
  ["recovery-key-conflict", key + "macos_recovery_key_conflict_keeps_both_original_objects"],
  ["recovery-copy-restore", recovery + "macos_note_recovery_copies_without_clobbering_then_restores_the_original_inode"],
  ["recovery-copy-conflict", recovery + "macos_note_recovery_rejects_equal_bytes_at_a_replaced_inode_and_retains_pending_permissions"],
  ["recovery-create-history", recovery + "macos_recovery_omits_empty_creation_history_but_keeps_pending_or_unexpected_objects"],
  ["write-conflict-recovery", "knowledge::macos_transactions::tests::macos_platform_note_write_conflict_and_recovery"],
  ["write-late-replacement", "knowledge::macos_transactions::tests::macos_late_source_replacement_remains_unconfirmed_with_all_objects_preserved"],
  ["write-retain-cleanup", "knowledge::macos_transactions::tests::macos_failed_write_retains_objects_without_racing_cleanup_unlink"],
  ["write-retain-created-journal", "knowledge::macos_transactions::tests::macos_created_note_retains_journal_without_racing_cleanup_unlink"],
  ["write-archive-conflict", "knowledge::macos_transactions::tests::macos_write_archive_conflict_reports_recovery_and_preserves_every_object"],
  ["create-post-vault-replacement", "knowledge::tests::macos_post_create_vault_change_preserves_created_and_replacement_objects"],
  ["create-unique-supported", "knowledge::live_sync::tests::macos_unique_create_uses_a_new_name_and_records_owned_identity"],
  ["create-unique-resume", "knowledge::macos_companion_import::tests::macos_unique_create_resumes_stage_and_moves_to_an_unoccupied_suffix"],
  ["create-unique-stage-swap", "knowledge::macos_companion_import::tests::macos_unique_create_never_retries_a_replaced_stage_as_its_own"],
  ["create-unique-concurrent", "knowledge::live_sync::tests::concurrent_unique_creation_serializes_final_names_without_losing_content"],
  ["create-unique-late-conflict", "knowledge::live_sync::tests::unique_creation_chooses_final_name_and_never_overwrites_external_collision"],
  ["create-unique-route-replay", "companion_gateway::content::notes::tests::unique_create_preserves_caller_identity_and_empty_revision_payload_across_replay"],
  ["create-unique-route-swap", "companion_gateway::content::notes::tests::unique_create_uncertain_recovery_never_claims_same_content_third_party_file_or_creates_twice"],
  ["create-unique-old-intent", "companion_gateway::content::notes::tests::unique_unpublished_intent_does_not_reserve_an_external_notes_identity"],
  ["create-unique-route-resume", "companion_gateway::content::notes::tests::macos_unique_route_resumes_a_durably_recorded_stage_after_interruption"],
  ["create-unique-receipt-swap", "companion_gateway::content::notes::tests::macos_unique_route_refuses_a_replacement_before_receipt"],
  ["create-unique-bom-replay", "companion_gateway::content::notes::tests::macos_unique_route_replays_bom_document_without_changing_file_bytes"],
  ["create-unique-service-resume", "companion_gateway::services::knowledge::live_sync_tests::macos_authenticated_service_create_resumes_the_same_operation"],
  ["create-companion-uncertain", "companion_gateway::content::notes::tests::macos_unconfirmed_legacy_create_never_adopts_or_recreates_an_unidentified_object"],
  ["import-companion-resume", "knowledge::macos_companion_import::tests::macos_import_can_resume_a_journaled_stage_and_replay_a_published_object"],
  ["import-companion-conflict", "knowledge::macos_companion_import::tests::macos_import_rejects_existing_and_case_equivalent_targets_without_staging"],
  ["import-companion-missing-parent", "knowledge::macos_companion_import::tests::macos_import_missing_parent_never_creates_a_folder_or_stage"],
  ["import-companion-stage-swap", "knowledge::macos_companion_import::tests::macos_import_rejects_a_same_bytes_stage_replacement"],
  ["import-companion-late-swap", "knowledge::macos_companion_import::tests::macos_import_reports_late_stage_swap_without_deleting_either_object"],
  ["import-companion-replay-scan", "companion_gateway::content::notes::tests::macos_import_receipt_loss_survives_a_scan_and_replays_the_owned_note"],
  ["import-companion-replacement-scan", "companion_gateway::content::notes::tests::macos_import_scan_never_claims_same_content_replacement_for_pending_receipt"],
  ["import-companion-route-replay", "companion_gateway::content::notes::tests::unified_notes_replays_are_immutable_and_never_overwrite_later_native_edits"],
  ["import-companion-route-conflict", "companion_gateway::content::notes::tests::unified_notes_external_same_content_collision_is_not_adopted_or_renamed"],
  ["upload-companion-stage-guard", "companion_gateway::content::notes::tests::macos_companion_upload_refuses_unowned_staging_but_replays_a_receipt"],
  ["create-uncertain-tool", "tools::tests::uncertain_note_creation_keeps_the_code_and_retry_guidance"],
  ["create-uncertain-transport", "local_transport::tests::uncertain_note_creation_keeps_only_the_safe_code"],
  ["create-uncertain-client", "tool_client::tests::uncertain_note_creation_message_warns_before_retry"],
  ["create-uncertain-mcp", "tool_mcp::tests::uncertain_note_creation_failure_warns_before_retry"],
  ["operation-created-object", operation + "macos_recovery_never_adopts_a_same_bytes_replacement_of_a_created_note"],
  ["operation-rewrite-object", operation + "macos_recovery_completion_and_rewrite_undo_require_the_published_note_inode"],
  ["operation-removed-object", operation + "macos_recovery_of_a_removed_path_requires_the_retained_original_object"],
  ["operation-resume-rollback", operation + "macos_recovery_resumes_and_rolls_back_only_the_durably_bound_objects"],
  ["move-attachment-target", operation + "macos_note_move_fixture_preserves_the_attachment_target_and_source"],
  ["move-stale-or-occupied", operation + "macos_note_move_rejects_stale_or_replaced_source_and_occupied_target"],
  ["move-replaced-object", operation + "macos_move_note_rejects_replaced_file_object_with_same_path_and_content"],
  ["move-after-save", operation + "macos_move_note_succeeds_after_normal_save_with_updated_file_identity"],
  ["delete-retained-ui-source", operation + "macos_ui_delete_retains_the_observed_note_for_recovery"],
  ["delete-replaced-object", operation + "macos_ui_delete_rejects_a_same_bytes_replacement"],
  ["delete-retired-vault-epoch", operation + "macos_ui_delete_rejects_a_retired_vault_epoch"],
  ["mutation-ambiguous-path", operation + "macos_move_and_delete_refuse_ambiguous_path_aliases"],
  ["rename-preserve-and-guard", operation + "macos_ui_rename_preserves_bytes_and_rejects_replacement_or_occupied_target"],
  ["folder-mutation-closed", operation + "macos_folder_mutation_entry_gate_fails_closed"],
].map(([id, test]) => Object.freeze({ id, test })));
// This candidate exercises the changed folder path together with adjacent
// note, attachment and simulated-phone boundaries. The broader historical
// notes/focused selections remain intact; this is an explicit smaller suite.
const INTEGRATION_NOTE_IDS = ["recovery-copy-restore", "operation-resume-rollback", "move-attachment-target", "move-after-save", "rename-preserve-and-guard"];
export const INTEGRATION_NATIVE_CASES = Object.freeze([
  ...INTEGRATION_NOTE_IDS.map(id => {
    const selected = NOTE_DATA_CASES.find(item => item.id === id);
    if (!selected) throw new Error("macos-integration-selection-invalid");
    return selected;
  }),
  ...[
    ["folder-product-rename", "knowledge::macos_folder_mutations::tests::macos_folder_product_rename_preserves_tree_and_refreshes_index"],
    ["folder-product-move-undo", "knowledge::macos_folder_mutations::tests::macos_folder_product_move_and_undo_keep_original_objects"],
    ["folder-product-chain", "knowledge::macos_folder_mutations::tests::macos_folder_product_normal_rename_move_chain_is_not_pending_recovery"],
    ["folder-product-delete-restart", "knowledge::macos_folder_mutations::tests::macos_folder_product_empty_delete_restores_same_inode_after_restart"],
    ["folder-product-nonempty", "knowledge::macos_folder_mutations::tests::macos_folder_product_nonempty_delete_and_arriving_content_are_preserved"],
    ["folder-product-collision", "knowledge::macos_folder_mutations::tests::macos_folder_product_collisions_never_replace_existing_directories"],
    ["folder-product-restore-collision", "knowledge::macos_folder_mutations::tests::macos_folder_product_restore_refuses_new_object_at_original_name"],
    ["folder-product-retained", "knowledge::macos_folder_mutations::tests::macos_folder_product_retained_content_stays_reviewable_and_restorable"],
    ["folder-product-selection", "knowledge::macos_folder_mutations::tests::macos_folder_product_selection_cannot_adopt_replacement_during_confirmation"],
    ["folder-product-source-replaced", "knowledge::macos_folder_mutations::tests::macos_folder_product_source_and_ancestors_changed_after_ready_are_preserved"],
    ["folder-product-target-replaced", "knowledge::macos_folder_mutations::tests::macos_folder_product_target_and_vault_changed_after_ready_are_preserved"],
    ["folder-product-pre-interruption", "knowledge::macos_folder_mutations::tests::macos_folder_product_interruption_before_go_does_not_start_mutation"],
    ["folder-product-post-interruption", "knowledge::macos_folder_mutations::tests::macos_folder_product_interruption_after_operation_is_recovered_without_reexecution"],
    ["folder-product-recovery-auth", "knowledge::macos_folder_mutations::tests::macos_folder_product_recovery_rejects_replaced_retained_object_and_tampered_intent"],
    ["folder-product-dirty-epoch", "knowledge::macos_folder_mutations::tests::macos_folder_product_dirty_and_retired_sources_are_vetoed"],
    ["folder-product-links", "knowledge::macos_folder_mutations::tests::macos_folder_product_links_and_own_subtree_are_rejected"],
    ["folder-product-name-cases", "knowledge::macos_folder_mutations::tests::macos_folder_product_unicode_and_case_rename_use_real_directory_names"],
    ["folder-window-retirement", "workspace_windows::tests::main_path_retirement_vetoes_exact_child_document_and_folder_only"],
    ["folder-attachment-projection", "materials::catalog::note_attachments::tests::macos_folder_projection_keeps_attachment_identity_and_references_on_move_and_undo"],
    ["folder-attachment-replacement", "materials::catalog::note_attachments::tests::macos_folder_projection_rejects_replacement_and_keeps_previous_references"],
    ["upload-content-reclaim-64mib", "companion_gateway::content::notes::uploads::macos::macos_store::tests::completed_content_reclaims_64mib_without_unlinking_names_or_receipts"],
    ["upload-content-reclaim-restart", "companion_gateway::content::notes::uploads::macos::macos_store::tests::completed_content_restarts_after_durable_truncate_before_sqlite_retirement"],
    ["upload-service-reclaim-64mib", "companion_gateway::services::ingest::macos_store::tests::completed_service_chunks_release_64mib_after_receipt_commit"],
    ["upload-service-reclaim-restart", "companion_gateway::services::ingest::macos_store::tests::completed_service_chunks_restart_after_truncate_before_sqlite_retirement"],
    ["upload-service-reclaim-route", "companion_gateway::tests::macos_services_ingest_tests::macos_services_success_receipt_survives_pending_reclaim_and_recovery"],
    ["identity-keychain-restart", "companion_gateway::macos_identity::tests::macos_keychain_identity_restart_and_pairing_with_real_store"],
    ["identity-lan-tls", "companion_gateway::macos_identity::tests::macos_keychain_gateway_private_lan_tls_roundtrip"],
  ].map(([id, test]) => Object.freeze({ id, test })),
]);
export const FOLDER_FOLLOWUP_NATIVE_CASES = Object.freeze(INTEGRATION_NATIVE_CASES.filter(item =>
  ["folder-attachment-projection", "folder-attachment-replacement"].includes(item.id)));
if (FOLDER_FOLLOWUP_NATIVE_CASES.length !== 2) throw new Error("macos-integration-selection-invalid");
export const FOLDER_IDENTITY_FOLLOWUP_NATIVE_CASES = Object.freeze(FOLDER_FOLLOWUP_NATIVE_CASES.filter(item =>
  item.id === "folder-attachment-projection"));
if (FOLDER_IDENTITY_FOLLOWUP_NATIVE_CASES.length !== 1) throw new Error("macos-integration-selection-invalid");
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
export function nativeCaseDisposition(execution) {
  if (execution?.closed !== true || execution.spawnFailed !== false || execution.timedOut !== false
      || execution.terminationRequested !== false || execution.outputInvalid !== false) return "failed-stop";
  const { text, exit, signal } = execution;
  if (singleNativeTestPassed(text, exit, signal)) return "passed";
  // Only a fully drained, normally exited libtest run of exactly one failed
  // case may continue. Missing cases, ignored tests and malformed output stop.
  if (exit === 101 && signal == null && typeof text === "string" && text.length <= 8 * 1024 * 1024
      && [...text.matchAll(/^running \d+ tests?\r?$/gm)].length === 1
      && [...text.matchAll(/^test result:[^\r\n]*$/gm)].length === 1
      && /^running 1 test\r?$/m.test(text)
      && /^test result: FAILED\. 0 passed; 1 failed; 0 ignored; 0 measured; \d+ filtered out;[^\r\n]*$/m.test(text))
    return "failed-continue";
  return "failed-stop";
}
export function safeNoteDataExecution(input, selection = NOTE_DATA_CASES) {
  if (!input || !["passed", "failed"].includes(input.status) || typeof input.compiled !== "boolean"
      || !Array.isArray(input.cases) || input.cases.length !== selection.length
      || !["none", "compile-failed", "artifact-invalid", "test-failed"].includes(input.failure)) throw new Error("macos-note-data-result-invalid");
  const cases = input.cases.map((item, index) => {
    if (item?.id !== selection[index].id || !["passed", "failed", "not-run"].includes(item.status)
        || item.exit !== null && !safeExit(item.exit)
        || item.status === "passed" && item.exit !== 0
        || item.status === "not-run" && item.exit !== null) throw new Error("macos-note-data-result-invalid");
    return { id: item.id, status: item.status, exit: item.exit };
  });
  const passed = input.compiled && cases.every(item => item.status === "passed") && input.failure === "none";
  let stopped = false; let failed = 0;
  for (const item of cases) {
    if (stopped && item.status !== "not-run") throw new Error("macos-note-data-result-invalid");
    if (item.status === "not-run" || item.status === "failed" && item.exit !== 101) stopped = true;
    if (item.status === "failed") failed += 1;
  }
  if ((input.status === "passed") !== passed || input.status === "failed" && input.failure === "none"
      || !input.compiled && (cases.some(item => item.status !== "not-run") || !["compile-failed", "artifact-invalid"].includes(input.failure))
      || input.compiled && input.failure === "compile-failed" || input.failure === "test-failed" && failed < 1)
    throw new Error("macos-note-data-result-invalid");
  return { status: input.status, compiled: input.compiled, failure: input.failure, cases,
    passedCount: cases.filter(item => item.status === "passed").length, total: selection.length };
}
export async function nativeCommand(command, args, env, stage, timeout = undefined) {
  const started = Date.now(); const startedId = commandEvent("start", stage, command);
  return new Promise(resolveResult => {
    const child = spawn(command, args, { cwd: TAURI, env, stdio: ["ignore", "pipe", "pipe"] });
    let text = ""; let stderrText = ""; let oversized = false; let spawnFailed = false; let timedOut = false; let totalBytes = 0; let forceTimer;
    const terminate = () => {
      child.kill("SIGTERM");
      // These fixed IO cases do not launch descendants. A child that ignores
      // cancellation still must close before collection can return or advance.
      forceTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const timer = timeout === undefined ? undefined : setTimeout(() => { timedOut = true; terminate(); }, timeout);
    const observeOutput = bytes => {
      totalBytes += bytes.length;
      if (totalBytes > 8 * 1024 * 1024 && !oversized) { oversized = true; text = ""; stderrText = ""; terminate(); }
    };
    child.stdout.on("data", bytes => {
      // This function is permitted only inside check-macos-internal's worker.
      // The parent parses bounded typed diagnostics and never prints raw data.
      process.stdout.write(bytes);
      observeOutput(bytes);
      if (!oversized) text += bytes.toString();
    });
    child.stderr.on("data", bytes => {
      process.stderr.write(bytes); observeOutput(bytes);
      if (!oversized) stderrText += bytes.toString();
    });
    child.once("error", () => {
      spawnFailed = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      if (startedId) commandEvent("exit", stage, command, { startedId, exit: "SPAWN_ERROR", elapsedMs: Date.now() - started });
      resolveResult({ text: "", stderrText: "", exit: "SPAWN_ERROR", signal: null, closed: false, spawnFailed: true,
        timedOut, terminationRequested: child.killed, outputInvalid: oversized });
    });
    child.once("close", (exit, signal) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      if (spawnFailed) return;
      if (startedId) commandEvent("exit", stage, command, { startedId, exit: exit ?? signal, elapsedMs: Date.now() - started });
      resolveResult({ text: oversized ? "" : text, stderrText: oversized ? "" : stderrText, exit: exit ?? signal, signal, closed: true, spawnFailed: false,
        timedOut, terminationRequested: child.killed, outputInvalid: oversized });
    });
  });
}
export async function runNativeNoteData(env, selection = NOTE_DATA_CASES) {
  requireNative();
  if (!process.send || process.env.GITHUB_ACTIONS !== "true" || !isMacosValidationRepository(process.env.GITHUB_REPOSITORY))
    throw new Error("macos-note-data-worker-required");
  const result = { status: "failed", compiled: false, failure: "compile-failed",
    cases: selection.map(({ id }) => ({ id, status: "not-run", exit: null })) };
  // Cargo keeps executable artifact records on stdout and renders compiler
  // diagnostics on stderr for the existing bounded, public-source projection.
  const built = await nativeCommand("cargo", ["test", "--locked", "--target", TARGET, "--lib", "--no-default-features", "--features", "macos-note-flow", "--no-run", NOTE_DATA_MESSAGE_FORMAT], noteDataCompileEnvironment(env), "native-note-data-compile");
  if (built.exit !== 0 || built.signal != null || !built.closed || built.spawnFailed || built.timedOut
      || built.terminationRequested || built.outputInvalid) return safeNoteDataExecution(result, selection);
  const artifacts = built.text.split(/\r?\n/).flatMap(line => {
    try { const item = JSON.parse(line); return item.reason === "compiler-artifact" && item.target?.name === "luckyray_app_lib"
      && item.target.src_path === join(TAURI, "src", "lib.rs")
      && item.profile?.test === true && typeof item.executable === "string" ? [item.executable] : []; } catch { return []; }
  });
  const executables = [...new Set(artifacts)];
  const executable = executables[0];
  if (executables.length !== 1 || dirname(executable) !== join(TAURI, "target", TARGET, "debug", "deps")
      || !/^luckyray_app_lib-[a-f0-9]+$/.test(basename(executable))) { result.failure = "artifact-invalid"; return safeNoteDataExecution(result, selection); }
  await directory(dirname(executable));
  const identity = await lstat(executable);
  if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1 || identity.uid !== process.geteuid()
      || (identity.mode & 0o022) || !(identity.mode & 0o100)) throw new Error("macos-note-data-artifact-invalid");
  result.compiled = true; result.failure = "test-failed";
  for (let i = 0; i < selection.length; i++) {
    const current = await lstat(executable);
    if (current.dev !== identity.dev || current.ino !== identity.ino || current.size !== identity.size
        || current.ctimeMs !== identity.ctimeMs || current.mtimeMs !== identity.mtimeMs) throw new Error("macos-note-data-artifact-invalid");
    const execution = await nativeCommand(executable, [selection[i].test, "--exact", "--test-threads=1", "--quiet"], env,
      "native-note-data-test", NOTE_DATA_TIMEOUT_MS);
    const disposition = nativeCaseDisposition(execution);
    const passed = disposition === "passed";
    const after = await lstat(executable);
    if (after.dev !== identity.dev || after.ino !== identity.ino || after.size !== identity.size
        || after.ctimeMs !== identity.ctimeMs || after.mtimeMs !== identity.mtimeMs) {
      result.failure = "artifact-invalid";
      result.cases[i] = { id: selection[i].id, status: "failed", exit: execution.exit };
      return safeNoteDataExecution(result, selection);
    }
    result.cases[i] = { id: selection[i].id, status: passed ? "passed" : "failed", exit: execution.exit };
    if (disposition === "failed-stop") {
      commandEvent("issues", "native-note-data-test", executable, { issues: [{ class: "project-error", code:
        execution.outputInvalid ? "macos-note-data-output-invalid" : "macos-note-data-execution-abnormal" }] });
      return safeNoteDataExecution(result, selection);
    }
  }
  if (result.cases.some(item => item.status !== "passed")) return safeNoteDataExecution(result, selection);
  result.status = "passed"; result.failure = "none"; return safeNoteDataExecution(result, selection);
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
