import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read = path => readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const native = read('src-tauri/src/knowledge/attachment_portability.rs');
const ui = read('src/features/notes/NotesPage.tsx');
test('note ZIP is wired through native active-source boundary, not browser filesystem reads', () => {
  assert.match(read('src-tauri/src/lib.rs'), /attachment_coordination::knowledge_export_note_archive/);
  assert.match(read('src-tauri/src/attachment_coordination.rs'), /pub\(super\) async fn knowledge_export_note_archive/);
  assert.match(read('src/core/services/vaultAttachments.ts'), /invoke<AttachmentExportResult>\("knowledge_export_note_archive"/);
  assert.match(ui, /t\("editor.notes.context.exportArchive"\)/);
  assert.match(ui, /await saveAffectedAttachmentNotes\(\[relativePath\]\)/);
});
test('ZIP collection reuses guarded portable exporter and selects exactly one document', () => {
  assert.match(native, /destination, approved, &\[document.clone\(\)\], true/);
  assert.match(native, /portability_notes\(&vault, &inventory, documents\)/);
  assert.match(native, /hold_verified_attachment/);
  assert.match(native, /check_export_capacity/);
  assert.match(native, /"remote-or-absolute" \| "self-reference"/);
});
test('archive output rejects overlap, preserves existing files and emits partial-export receipt', () => {
  const archive = native.slice(native.indexOf('fn write_note_archive('));
  assert.match(archive, /guard_existing_ancestors/);
  assert.match(archive, /target.starts_with\(source\)/);
  assert.match(archive, /create_new\(true\)/);
  assert.match(archive, /safe_relative_path/);
  assert.match(archive, /LuckyRay-export-receipt.json/);
  assert.match(archive, /sync_all/);
});
test('knowledge saves no longer direct users to nonexistent refresh menu', () => {
  assert.doesNotMatch(ui, /setStatus\(t\("editor.notes.status.diskRefreshRequired"\)\)/);
  assert.match(ui, /await realVaultSaveCompletionRef.current.get\(noteId\)/);
  assert.match(ui, /shouldPauseConflictAutosave/);
  assert.match(ui, /reloadConflict: reloadRealVaultConflictFromDisk, keepConflict: keepRealVaultConflictEdit/);
});

test('archive rejects non-main caller before reading knowledge or approved paths', () => {
  const command = read('src-tauri/src/attachment_coordination.rs').split('pub(super) async fn knowledge_export_note_archive(')[1];
  assert.match(command, /caller: tauri::Webview/);
  const guard = command.indexOf('require_main_caller(&caller)?;');
  assert.ok(guard >= 0);
  assert.ok(guard < command.indexOf('knowledge_service()?'));
  assert.ok(guard < command.indexOf('approved_documents'));
});
