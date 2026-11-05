//! Native Mac tests for the legacy desktop note creation bridge.
use super::*;
use std::path::PathBuf;

fn fixture() -> (tempfile::TempDir, knowledge::KnowledgeService, NotesVaultMetadata, PathBuf, u64) {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let root = base.join("vault");
    std::fs::create_dir_all(root.join(".luckyray")).unwrap();
    let registration = knowledge::KnowledgeVaultRegistration {
        id: "legacy-note-test".into(), name: "Synthetic".into(),
        root_path: root.to_string_lossy().into(), mode: "vault-bound".into(),
        created_at: "2026-11-03T00:00:00Z".into(), last_opened_at: "2026-11-03T00:00:00Z".into(),
        schema_version: NOTES_VAULT_SCHEMA_VERSION, link_update_policy: Default::default(),
    };
    std::fs::write(root.join(".luckyray/vault.json"), serde_json::to_vec(&registration).unwrap()).unwrap();
    let service = knowledge::KnowledgeService::initialize(base.join("app")).unwrap();
    service.register_current_vault(&registration).unwrap();
    let epoch = service.activate_ui_source(&registration.id).unwrap().source_epoch;
    let vault = NotesVaultMetadata { id: registration.id, name: registration.name,
        root_path: registration.root_path, mode: registration.mode, created_at: registration.created_at,
        last_opened_at: registration.last_opened_at, schema_version: registration.schema_version,
        link_update_policy: registration.link_update_policy };
    (temp, service, vault, root, epoch)
}

#[test]
fn macos_legacy_note_create_keeps_initial_content_and_creates_missing_parents() {
    let (_temp, service, vault, root, epoch) = fixture();
    let file = create_macos_legacy_vault_note(&service, &vault, epoch, "Folder/Nested", "中文.md").unwrap();
    assert_eq!(file.name, "中文.md");
    assert_eq!(file.relative_path, "Folder/Nested/中文.md");
    assert_eq!(file.absolute_path, root.join("Folder/Nested/中文.md").to_str().unwrap());
    assert_eq!(file.content_text, "# 中文\n");
    assert_eq!(file.size, "# 中文\n".len() as u64);
    assert_eq!(std::fs::read(root.join("Folder/Nested/中文.md")).unwrap(), "# 中文\n".as_bytes());
    let error = create_macos_legacy_vault_note(&service, &vault, epoch, "Folder/Nested", "中文.md").err().unwrap();
    assert!(error.starts_with("already-exists:"), "{error}");
    assert_eq!(std::fs::read(root.join("Folder/Nested/中文.md")).unwrap(), "# 中文\n".as_bytes());
}

#[test]
fn macos_legacy_note_create_rejects_retired_source_and_linked_parent() {
    let (_temp, service, vault, root, epoch) = fixture();
    std::fs::create_dir(root.join("Real")).unwrap();
    std::os::unix::fs::symlink(root.join("Real"), root.join("Alias")).unwrap();
    assert!(create_macos_legacy_vault_note(&service, &vault, epoch, "Alias", "Hidden.md").is_err());
    assert!(!root.join("Real/Hidden.md").exists());
    let next = service.activate_ui_source(&vault.id).unwrap().source_epoch;
    assert_ne!(epoch, next);
    assert!(create_macos_legacy_vault_note(&service, &vault, epoch, "", "Stale.md").is_err());
    assert!(!root.join("Stale.md").exists());
}

#[test]
fn macos_legacy_note_create_rejects_paused_source_without_creating_parents() {
    let (_temp, service, vault, root, epoch) = fixture();
    service.deactivate_ui_source().unwrap();
    let error = create_macos_legacy_vault_note(&service, &vault, epoch, "NotCreated/Nested", "Paused.md").err().unwrap();
    let failure: serde_json::Value = serde_json::from_str(&error).unwrap();
    assert_eq!(failure["code"], "knowledge-source-inactive");
    assert!(!root.join("NotCreated").exists());
}

#[test]
fn macos_legacy_note_create_reports_partial_parent_creation_on_invalid_later_name() {
    let (_temp, service, vault, root, epoch) = fixture();
    let error = create_macos_legacy_vault_note(&service, &vault, epoch, "New/CON", "Page.md").err().unwrap();
    assert!(error.starts_with("knowledge-create-unconfirmed:"), "{error}");
    assert!(root.join("New").is_dir());
    assert!(!root.join("New/CON").exists());
    assert!(!root.join("New/Page.md").exists());
}

#[test]
fn macos_legacy_note_create_preserves_a_late_name_collision() {
    let (_temp, service, vault, root, epoch) = fixture();
    let created_by_other = root.join("Race.md");
    crate::macos_fs::set_before_rename_call_hook(Some(Box::new(move |_, _| {
        std::fs::write(created_by_other, b"other content").unwrap();
    })));
    assert!(create_macos_legacy_vault_note(&service, &vault, epoch, "", "Race.md").is_err());
    assert_eq!(std::fs::read(root.join("Race.md")).unwrap(), b"other content");
}

#[test]
fn macos_legacy_note_create_reports_post_write_root_swap_as_unconfirmed() {
    let (_temp, service, vault, root, epoch) = fixture();
    let old = root.with_file_name("held-vault");
    let old_for_hook = old.clone(); let root_for_hook = root.clone();
    service.set_after_final_validation_hook(move || {
        std::fs::rename(&root_for_hook, &old_for_hook).unwrap();
        std::fs::create_dir_all(root_for_hook.join(".luckyray")).unwrap();
        std::fs::copy(old_for_hook.join(".luckyray/vault.json"), root_for_hook.join(".luckyray/vault.json")).unwrap();
    });
    let error = create_macos_legacy_vault_note(&service, &vault, epoch, "", "Moved.md").err().unwrap();
    assert!(error.starts_with("knowledge-create-unconfirmed:"), "{error}");
    assert_eq!(std::fs::read(old.join("Moved.md")).unwrap(), b"# Moved\n");
    assert!(!root.join("Moved.md").exists());
}

#[test]
fn macos_legacy_note_create_reports_unreadable_post_write_as_unconfirmed() {
    let (_temp, service, vault, root, epoch) = fixture();
    let original = root.join("Unconfirmed.md");
    let held = root.join("moved-externally.md");
    let held_for_hook = held.clone();
    service.set_after_final_validation_hook(move || {
        std::fs::rename(&original, &held_for_hook).unwrap();
    });
    let error = create_macos_legacy_vault_note(&service, &vault, epoch, "", "Unconfirmed.md").err().unwrap();
    assert!(error.starts_with("knowledge-create-unconfirmed:"), "{error}");
    assert_eq!(std::fs::read(held).unwrap(), b"# Unconfirmed\n");
    assert!(!root.join("Unconfirmed.md").exists());
}
