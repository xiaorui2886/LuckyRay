//! These exercise the real desktop admission and companion folder service on
//! Darwin. Linux simulations are not substitutes for these native tests.
use super::*;

fn fixture() -> (tempfile::TempDir, knowledge::KnowledgeService, std::path::PathBuf, String, u64) {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let root = base.join("vault");
    std::fs::create_dir_all(root.join(".luckyray")).unwrap();
    let registration = knowledge::KnowledgeVaultRegistration {
        id: "synthetic-desktop-folder".into(),
        name: "Synthetic desktop folder".into(),
        root_path: root.to_str().unwrap().into(),
        mode: "vault-bound".into(),
        created_at: "2026-11-03T00:00:00Z".into(),
        last_opened_at: "2026-11-03T00:00:00Z".into(),
        schema_version: NOTES_VAULT_SCHEMA_VERSION,
        link_update_policy: Default::default(),
    };
    std::fs::write(root.join(".luckyray/vault.json"), serde_json::to_vec(&registration).unwrap()).unwrap();
    let service = knowledge::KnowledgeService::initialize(base.join("app")).unwrap();
    service.register_current_vault(&registration).unwrap();
    let epoch = service.activate_ui_source(&registration.id).unwrap().source_epoch;
    (temp, service, root, registration.id, epoch)
}

#[test]
fn macos_desktop_folder_create_binds_source_and_scope() {
    let (_temp, service, root, vault_id, epoch) = fixture();
    std::fs::create_dir(root.join("Parent")).unwrap();
    let result = create_macos_notes_vault_folder(&service, &vault_id, epoch, "Parent", "Projects").unwrap();
    assert_eq!(result.kind, "folder");
    assert_eq!(result.name, "Projects");
    assert_eq!(result.relative_path, "Parent/Projects");
    assert_eq!(result.absolute_path, root.join("Parent/Projects").to_str().unwrap());
    assert!(result.children.is_empty());
    assert!(root.join("Parent/Projects").is_dir());
    std::fs::write(root.join("Parent/Projects/keep"), b"keep").unwrap();
    let conflict = create_macos_notes_vault_folder(&service, &vault_id, epoch, "Parent", "Projects").err().unwrap();
    assert!(conflict.contains("knowledge-name-conflict"), "{conflict}");
    assert_eq!(std::fs::read(root.join("Parent/Projects/keep")).unwrap(), b"keep");
    assert!(create_macos_notes_vault_folder(&service, &vault_id, epoch, "Missing", "Projects").is_err());
    assert!(!root.join("Missing").exists());
    assert!(create_macos_notes_vault_folder(&service, &vault_id, epoch, "Parent\\Alias", "Projects").is_err());
    assert!(create_macos_notes_vault_folder(&service, "different-vault", epoch, "Parent", "Wrong").is_err());
    assert!(!root.join("Parent/Wrong").exists());
}

#[test]
fn macos_desktop_folder_create_rejects_retired_epoch_and_link_parent() {
    let (_temp, service, root, vault_id, epoch) = fixture();
    std::fs::create_dir(root.join("Parent")).unwrap();
    let next = service.activate_ui_source(&vault_id).unwrap().source_epoch;
    assert_ne!(epoch, next);
    let stale = create_macos_notes_vault_folder(&service, &vault_id, epoch, "Parent", "Stale").err().unwrap();
    assert!(stale.contains("knowledge-source-inactive"), "{stale}");
    assert!(!root.join("Parent/Stale").exists());
    std::os::unix::fs::symlink(root.join("Parent"), root.join("Alias")).unwrap();
    assert!(create_macos_notes_vault_folder(&service, &vault_id, next, "Alias", "Linked").is_err());
    assert!(!root.join("Parent/Linked").exists());
}

#[test]
fn macos_desktop_folder_captured_scope_rejects_replaced_vault_root() {
    let (_temp, service, root, vault_id, epoch) = fixture();
    let _source = service.lock_active_ui_source(epoch, Some(&vault_id)).unwrap();
    let scope = service.capture_workspace_scope(&vault_id).unwrap();
    let target = scope.current_target_identity().unwrap();
    let held = root.with_file_name("held-vault");
    std::fs::rename(&root, &held).unwrap();
    std::fs::create_dir_all(root.join(".luckyray")).unwrap();
    std::fs::copy(held.join(".luckyray/vault.json"), root.join(".luckyray/vault.json")).unwrap();
    assert!(scope.companion_create_folder_for_target(&target, Some(""), "NotCreated").is_err());
    assert!(!root.join("NotCreated").exists());
    assert!(!held.join("NotCreated").exists());
}

#[test]
fn macos_desktop_folder_create_reports_uncertain_post_create_errors() {
    for code in ["knowledge-vault-unavailable", "knowledge-vault-changed",
        "knowledge-target-not-current", "knowledge-path-reparse-forbidden", "knowledge-operation-unavailable"] {
        let error = macos_desktop_folder_create_error(knowledge::KnowledgeError { code, message: "fixture".into() });
        assert!(error.starts_with("knowledge-create-unconfirmed:"), "{code}: {error}");
    }
    let conflict = macos_desktop_folder_create_error(knowledge::KnowledgeError {
        code: "knowledge-name-conflict", message: "fixture".into(),
    });
    assert!(conflict.contains("knowledge-name-conflict"));
    assert!(!conflict.contains("knowledge-create-unconfirmed"));
}
