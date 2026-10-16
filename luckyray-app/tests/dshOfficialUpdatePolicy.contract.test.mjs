import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const source = async path => readFile(new URL(`../src-tauri/src/${path}`, import.meta.url), "utf8");
const [update, transaction, host, seal, nativeTests] = await Promise.all([
  source("dsh_engine_update.rs"), source("dsh_engine_update/transaction.rs"),
  source("dsh_host.rs"), source("dsh_runtime_seal.rs"),
  source("dsh_engine_update/transaction/code_only_switch_tests.rs"),
]);
const between = (text, start, end) => {
  const a = text.indexOf(start);
  assert.notEqual(a, -1, start);
  const b = text.indexOf(end, a + start.length);
  assert.notEqual(b, -1, end);
  return text.slice(a, b);
};

test("ordinary installed selection calls signature verifier and bounded layout, no full scan", () => {
  const load = between(transaction, "fn load_active_with_verifier", "fn read_journal");
  assert.match(load, /verify\(&envelope\)/);
  assert.match(load, /verify_runtime_layout\(&candidate, &root\)/);
  assert.match(load, /pending_health_for/);
  assert.doesNotMatch(load, /verify_runtime_closure|read_dir|snapshot|backup_before_switch/);
  const layout = between(update, "fn verify_runtime_layout", "pub(crate) fn runtime_launch_identity");
  assert.doesNotMatch(layout, /read_dir|digest_file|scan_runtime_closure/);
  assert.match(layout, /verify_package_identity/);
});

test("host pins only critical runtime identity and fixed path chain", () => {
  const use = between(host, "fn acquire_use_lease(", "fn normalize_windows_verbatim_path");
  assert.match(use, /self\.runtime_identity\.revalidate\(control\)/);
  assert.doesNotMatch(use, /acquire_runtime_closure_lease|scan_runtime_closure|dynamic_closure/);
  const critical = between(seal, "pub(crate) fn acquire_identity(", "fn revalidate_inner");
  assert.match(critical, /lock_runtime_object\(&path, false, true, false\)/);
  assert.match(critical, /hash_file\(&node_path, control\)/);
  assert.match(critical, /hash_file\(&entry_path, control\)/);
  assert.match(critical, /value\["version"\]/);
  assert.doesNotMatch(critical, /fs::read_dir|scan_runtime_closure/);
  const service = between(host, "pub(crate) struct DshHostService {", "fn validate_action(");
  assert.ok(service.indexOf("descriptor: OnceLock") > service.indexOf("host: Mutex"));
  assert.ok(service.indexOf("descriptor: OnceLock") > service.indexOf("surface_lease: Mutex"));
});

test("full admission remains before atomic pointer; profile snapshot removed without deleting old backups", () => {
  const activate = between(transaction, "fn activate_after_quiescence_with_bundled(", "fn write_journal");
  assert.equal((activate.match(/verify_runtime_closure\(/g) ?? []).length, 1);
  assert.ok(activate.indexOf("verify_runtime_closure(") < activate.indexOf("write_prepared_journal"));
  assert.ok(activate.indexOf("write_code_only_receipt") < activate.indexOf("ACTIVE_FILE"));
  assert.match(activate, /data_compatibility != "no-migration"/);
  assert.match(transaction, /mode: "code-only-existing-profile"/);
  assert.match(transaction, /snapshot_created: false/);
  assert.match(transaction, /backup_receipt_sha256: receipt_sha256/);
  assert.doesNotMatch(transaction, /snapshot_profile|backup_before_switch|fs::remove_dir_all\([^\n]*backups/);
  assert.doesNotMatch(update, /mod snapshot;/);
});

test("scheduling and unarmed relaunch remain pre-activation and cancellable", () => {
  const schedule = between(transaction, "fn schedule_restart_switch_with_bundled_progress", "pub(crate) fn complete_pending_switch");
  assert.match(schedule, /verify_runtime_layout/);
  assert.doesNotMatch(schedule, /verify_runtime_closure|snapshot_profile/);
  const complete = between(transaction, "fn complete_pending_switch_with(", "fn activate_after_quiescence_with_bundled(");
  assert.ok(complete.indexOf("if !marker_path.exists()") < complete.indexOf("activate_after_quiescence_with_bundled"));
  const prepare = between(transaction, "pub(crate) fn prepare_from_archive_with_progress", "pub(crate) fn schedule_restart_switch");
  assert.match(prepare, /cancel\.load/);
  assert.match(prepare, /verify_runtime_closure_with_progress/);
});

test("native fixtures explicitly cover changed policy and unchanged data/recovery requirements", () => {
  for (const name of [
    "code_only_activation_preserves_original_paths_config_plugins_ai_and_legacy_backups",
    "ordinary_selection_intentionally_does_not_hash_or_inventory_dependencies",
    "missing_modified_or_extra_runtime_is_rejected_at_activation_without_profile_changes",
    "interrupted_receipt_before_pointer_can_retry_without_touching_user_state",
    "receipt_failure_is_pre_activation_and_legacy_journal_schema_still_round_trips",
    "critical_identity_pins_paths_checks_bytes_and_releases_on_cancel_and_drop",
    "critical_launch_rejects_root_and_internal_ancestor_junctions",
    "code_only_switch_does_not_traverse_or_change_unknown_user_junctions",
  ]) assert.ok(nativeTests.includes(`fn ${name}(`), name);
  assert.match(nativeTests, /profiles\/web\/node_modules\/user-plugin/);
  assert.match(nativeTests, /session\.v[34]\.jsonl\.zstd/);
});
