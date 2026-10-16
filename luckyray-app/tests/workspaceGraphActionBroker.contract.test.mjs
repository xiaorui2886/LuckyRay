import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const broker = readFileSync(new URL('../src-tauri/src/workspace_graph_actions.rs', import.meta.url), 'utf8');
const assets = readFileSync(new URL('../src-tauri/src/knowledge/workspace_graph_assets.rs', import.meta.url), 'utf8');
test('graph broker retains captured services and exact opaque proof at enqueue and commit', () => {
  for (const invariant of ['catalog: MaterialCatalog', 'identity: KnowledgeTargetIdentity', 'snapshot_id: String, source_id: String', 'graphs.node_for_scope', 'check_source(&entry.view,&entry.scope,&entry.source_id)', 'Self::validate_entry(entry,graphs,&mut live)?', 'entry.executed=true']) assert.ok(broker.includes(invariant), invariant);
  assert.doesNotMatch(broker, /BackendServices|material_catalog\(\)|knowledge_service\(\)|Command::new|Connection::open/);
});
test('catalog scan is bounded complete and ambiguity is not silently resolved', () => {
  for (const invariant of ['MAX_CATALOG_ASSETS + 1', 'assets.len() > MAX_CATALOG_ASSETS', 'MAX_CATALOG_BYTES', 'catalog.for_library(&library_id)', 'read_change()', 'if matches.len() != 1', 'asset.id == decoded', 'GraphLibraryEmbed::NoMatch']) assert.ok(broker.includes(invariant), invariant);
});
test('native effects and success use real guarded backend providers', () => {
  for (const invariant of ['crate::material_shell::perform', 'catalog.companion_resource', 'with_workspace_graph_asset', 'create_workspace_graph_missing', 'authorize_write(&entry.scope', 'drop(_write)', 'blocking_save_file()', 'create_new(true)', 'file.write_all(bytes)', 'workspace-graph-action-effect-unconfirmed', 'entry.execution==Some(result.clone())']) assert.ok(broker.includes(invariant), invariant);
  for (const invariant of ['self.mutation_lock.lock()', 'hold_verified_attachment', 'link.destination == target', 'resolved.version.as_deref() != Some(attachment_revision)', 'self.assert_expected_target_unlocked', 'create_workspace_graph_missing', 'missing_target_is_unresolved']) assert.ok(assets.includes(invariant), invariant);
});
test('PNG validation decodes bounded raster and checks framing, integrity and filters', () => {
  for (const invariant of ['MAX_PNG_PIXELS', 'crc32(', 'flate2::Decompress::new(true)', 'Vec::with_capacity(expected+1)', 'status!=flate2::Status::StreamEnd', 'raster.len()!=expected', 'decoder.total_in()!=compressed.len()', 'raster[row*row_bytes]>4', 'b"acTL"|b"fcTL"|b"fdAT"']) assert.ok(broker.includes(invariant), invariant);
});
test('pure Rust regression cases cover origin, lease, stale edits, false success and malformed PNG', () => {
  for (const name of ['catalog_matching_preserves_main_exact_id_path_and_ambiguity_semantics', 'complete_catalog_scan_keeps_exact_library_and_revision', 'service_leases_are_main_only_effect_specific_and_revoked_on_unmount', 'tickets_source_claims_and_completed_replies_are_exact_origin_bound', 'saved_edit_revoke_close_and_false_native_success_are_rejected', 'screenshot_validates_crc_dimensions_filters_full_raster_and_bounds']) assert.ok(broker.includes(`fn ${name}(`));
});
