//! These exercise the product service and the product C worker on Darwin.
//! They are not the independent FSRef capability probe from the prior phase.
use super::*;
use crate::knowledge::{KnowledgeVaultRegistration, VAULT_SCHEMA_VERSION};
use std::fs;
use std::os::unix::fs::symlink;
use std::sync::{Arc, Mutex};

struct Fixture {
    _temporary: tempfile::TempDir,
    base: PathBuf,
    root: PathBuf,
    service: KnowledgeService,
    registration: KnowledgeVaultRegistration,
    epoch: u64,
}
fn fixture() -> Fixture {
    let temporary = tempfile::tempdir().unwrap();
    let base = temporary.path().canonicalize().unwrap();
    let root = base.join("vault");
    fs::create_dir_all(root.join(".luckyray")).unwrap();
    let registration = KnowledgeVaultRegistration {
        id: format!("synthetic-folder-{:032x}", rand::random::<u128>()), name: "Synthetic folders".into(),
        root_path: root.to_str().unwrap().into(), mode: "vault-bound".into(),
        created_at: "2026-11-04T00:00:00Z".into(), last_opened_at: "2026-11-04T00:00:00Z".into(),
        schema_version: VAULT_SCHEMA_VERSION, link_update_policy: Default::default(),
    };
    fs::write(root.join(".luckyray/vault.json"), serde_json::to_vec(&registration).unwrap()).unwrap();
    let service = KnowledgeService::initialize(base.join("app")).unwrap();
    service.register_current_vault(&registration).unwrap();
    let epoch = service.activate_ui_source(&registration.id).unwrap().source_epoch;
    Fixture { _temporary: temporary, base, root, service, registration, epoch }
}
fn mutate(f: &Fixture, path: &str, operation: &str, name: Option<&str>, parent: Option<&str>) -> FolderMutationResult {
    let selection = f.service.prepare_folder_from_ui(f.epoch, path).unwrap();
    f.service.mutate_folder_from_ui(f.epoch, path, &selection, operation, name, parent).unwrap()
}
fn inode(path: &Path) -> u64 { fs::symlink_metadata(path).unwrap().ino() }
fn tree(f: &Fixture) {
    fs::create_dir_all(f.root.join("Parent/Folder/Sub")).unwrap();
    fs::create_dir_all(f.root.join("Target")).unwrap();
    fs::write(f.root.join("Parent/Folder/Sub/Note.md"), b"# Synthetic note\n![asset](asset.bin)\n").unwrap();
    fs::write(f.root.join("Parent/Folder/Sub/asset.bin"), b"synthetic attachment").unwrap();
}

#[test]
fn macos_folder_product_rename_preserves_tree_and_refreshes_index() {
    let f = fixture(); tree(&f);
    let folder = inode(&f.root.join("Parent/Folder"));
    let note = inode(&f.root.join("Parent/Folder/Sub/Note.md"));
    let attachment = inode(&f.root.join("Parent/Folder/Sub/asset.bin"));
    assert!(f.service.list_documents().unwrap().iter().any(|d| d.relative_path == "Parent/Folder/Sub/Note.md"));
    let changes = Arc::new(Mutex::new(Vec::new()));
    let published = changes.clone();
    f.service.set_companion_committed_listener(move |change| { published.lock().unwrap().push(change); }).unwrap();
    let result = mutate(&f, "Parent/Folder", "rename", Some("Renamed"), None);
    assert_eq!(result.state, "completed");
    assert_eq!(result.new_relative_path.as_deref(), Some("Parent/Renamed"));
    assert!(!f.root.join("Parent/Folder").exists());
    assert_eq!(inode(&f.root.join("Parent/Renamed")), folder);
    assert_eq!(inode(&f.root.join("Parent/Renamed/Sub/Note.md")), note);
    assert_eq!(inode(&f.root.join("Parent/Renamed/Sub/asset.bin")), attachment);
    assert_eq!(fs::read(f.root.join("Parent/Renamed/Sub/asset.bin")).unwrap(), b"synthetic attachment");
    let documents = f.service.list_documents().unwrap();
    assert!(documents.iter().any(|d| d.relative_path == "Parent/Renamed/Sub/Note.md"));
    assert!(!documents.iter().any(|d| d.relative_path.starts_with("Parent/Folder/")));
    let changes = changes.lock().unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].vault_id, f.registration.id);
    assert_eq!(changes[0].relative_paths, vec!["Parent/Folder", "Parent/Renamed"]);
}

#[test]
fn macos_folder_product_move_and_undo_keep_original_objects() {
    let f = fixture(); tree(&f);
    let folder = inode(&f.root.join("Parent/Folder"));
    let note = inode(&f.root.join("Parent/Folder/Sub/Note.md"));
    let moved = mutate(&f, "Parent/Folder", "move", None, Some("Target"));
    assert_eq!(moved.state, "completed");
    assert_eq!(inode(&f.root.join("Target/Folder")), folder);
    assert_eq!(inode(&f.root.join("Target/Folder/Sub/Note.md")), note);
    let recovery = f.service.list_folder_recoveries_from_ui(f.epoch).unwrap();
    assert!(recovery.iter().any(|r| r.result.operation_id == moved.operation_id && r.can_restore));
    let restored = f.service.restore_folder_from_ui(f.epoch, &moved.operation_id).unwrap();
    assert_eq!(restored.state, "completed");
    assert_eq!(restored.old_relative_path, "Target/Folder");
    assert_eq!(restored.new_relative_path.as_deref(), Some("Parent/Folder"));
    assert_eq!(inode(&f.root.join("Parent/Folder")), folder);
    assert_eq!(inode(&f.root.join("Parent/Folder/Sub/Note.md")), note);
    assert!(!f.root.join("Target/Folder").exists());
}

#[test]
fn macos_folder_product_normal_rename_move_chain_is_not_pending_recovery() {
    let f = fixture(); tree(&f);
    let renamed = mutate(&f, "Parent/Folder", "rename", Some("Renamed"), None);
    assert_eq!(renamed.state, "completed");
    let moved = mutate(&f, "Parent/Renamed", "move", None, Some("Target"));
    assert_eq!(moved.state, "completed");
    let records = f.service.list_folder_recoveries_from_ui(f.epoch).unwrap();
    assert!(records.iter().all(|record| record.result.state == "completed"));
    let older = records.iter().find(|record| record.result.operation_id == renamed.operation_id).unwrap();
    assert!(!older.can_restore); assert!(older.result.message.is_some());
    assert!(records.iter().find(|record| record.result.operation_id == moved.operation_id).unwrap().can_restore);
    assert!(f.root.join("Target/Renamed/Sub/Note.md").is_file());
}

#[test]
fn macos_folder_product_empty_delete_restores_same_inode_after_restart() {
    let f = fixture(); fs::create_dir(f.root.join("Empty")).unwrap();
    let original = inode(&f.root.join("Empty"));
    let deleted = mutate(&f, "Empty", "delete", None, None);
    assert_eq!(deleted.state, "completed"); assert!(deleted.new_relative_path.is_none());
    let retained = f.root.join(".luckyray/folder-retained").join(&deleted.operation_id).join("Empty");
    assert!(!f.root.join("Empty").exists()); assert_eq!(inode(&retained), original);
    let reopened = KnowledgeService::initialize(f.base.join("app")).unwrap();
    let epoch = reopened.activate_ui_source(&f.registration.id).unwrap().source_epoch;
    let records = reopened.list_folder_recoveries_from_ui(epoch).unwrap();
    assert!(records.iter().any(|r| r.result.operation_id == deleted.operation_id && r.can_restore && r.result.state == "completed"));
    let restored = reopened.restore_folder_from_ui(epoch, &deleted.operation_id).unwrap();
    assert_eq!(restored.state, "completed");
    assert_eq!(restored.new_relative_path.as_deref(), Some("Empty"));
    assert_eq!(inode(&f.root.join("Empty")), original); assert!(!retained.exists());
}

#[test]
fn macos_folder_product_nonempty_delete_and_arriving_content_are_preserved() {
    let f = fixture(); fs::create_dir(f.root.join("Folder")).unwrap();
    fs::write(f.root.join("Folder/keep"), b"keep").unwrap();
    let selection = f.service.prepare_folder_from_ui(f.epoch, "Folder").unwrap();
    let failure = f.service.mutate_folder_from_ui(f.epoch, "Folder", &selection, "delete", None, None).unwrap_err();
    assert_eq!(failure.code, "knowledge-folder-not-empty");
    assert_eq!(fs::read(f.root.join("Folder/keep")).unwrap(), b"keep");
    fs::create_dir(f.root.join("InitiallyEmpty")).unwrap();
    let path = f.root.join("InitiallyEmpty/new-child");
    AFTER_READY.with(|slot| *slot.borrow_mut() = Some(Box::new(move || { fs::write(path, b"arrived").unwrap(); })));
    let result = mutate(&f, "InitiallyEmpty", "delete", None, None);
    assert_eq!(result.state, "unchanged");
    assert_eq!(fs::read(f.root.join("InitiallyEmpty/new-child")).unwrap(), b"arrived");
}

#[test]
fn macos_folder_product_collisions_never_replace_existing_directories() {
    let f = fixture(); tree(&f);
    fs::create_dir(f.root.join("Parent/Existing")).unwrap();
    fs::write(f.root.join("Parent/Existing/keep"), b"existing").unwrap();
    let existing = inode(&f.root.join("Parent/Existing"));
    let original = inode(&f.root.join("Parent/Folder"));
    assert_eq!(mutate(&f, "Parent/Folder", "rename", Some("Existing"), None).state, "unchanged");
    assert_eq!(inode(&f.root.join("Parent/Folder")), original);
    assert_eq!(inode(&f.root.join("Parent/Existing")), existing);
    assert_eq!(fs::read(f.root.join("Parent/Existing/keep")).unwrap(), b"existing");
    fs::create_dir(f.root.join("Target/Folder")).unwrap();
    let target = inode(&f.root.join("Target/Folder"));
    assert_eq!(mutate(&f, "Parent/Folder", "move", None, Some("Target")).state, "unchanged");
    assert_eq!(inode(&f.root.join("Target/Folder")), target);
    assert_eq!(inode(&f.root.join("Parent/Folder")), original);
}

#[test]
fn macos_folder_product_restore_refuses_new_object_at_original_name() {
    let f = fixture(); fs::create_dir(f.root.join("Empty")).unwrap();
    let original = inode(&f.root.join("Empty"));
    let deleted = mutate(&f, "Empty", "delete", None, None);
    assert_eq!(deleted.state, "completed");
    fs::create_dir(f.root.join("Empty")).unwrap(); fs::write(f.root.join("Empty/keep"), b"replacement").unwrap();
    let replacement = inode(&f.root.join("Empty"));
    let records = f.service.list_folder_recoveries_from_ui(f.epoch).unwrap();
    assert!(!records.iter().find(|r| r.result.operation_id == deleted.operation_id).unwrap().can_restore);
    assert_eq!(f.service.restore_folder_from_ui(f.epoch, &deleted.operation_id).unwrap_err().code, "knowledge-folder-restore-conflict");
    assert_eq!(inode(&f.root.join("Empty")), replacement);
    assert_eq!(fs::read(f.root.join("Empty/keep")).unwrap(), b"replacement");
    assert_eq!(inode(&f.root.join(".luckyray/folder-retained").join(deleted.operation_id).join("Empty")), original);
}

#[test]
fn macos_folder_product_retained_content_stays_reviewable_and_restorable() {
    let f = fixture(); fs::create_dir(f.root.join("Empty")).unwrap();
    let original = inode(&f.root.join("Empty"));
    let deleted = mutate(&f, "Empty", "delete", None, None); assert_eq!(deleted.state, "completed");
    let retained = f.root.join(".luckyray/folder-retained").join(&deleted.operation_id).join("Empty");
    fs::write(retained.join("arrived.md"), b"content added while the directory was retained").unwrap();
    let records = f.service.list_folder_recoveries_from_ui(f.epoch).unwrap();
    let record = records.iter().find(|record| record.result.operation_id == deleted.operation_id).unwrap();
    assert_eq!(record.result.state, "recovery-required"); assert!(record.can_restore);
    let restored = f.service.restore_folder_from_ui(f.epoch, &deleted.operation_id).unwrap();
    assert_eq!(restored.state, "completed"); assert_eq!(inode(&f.root.join("Empty")), original);
    assert_eq!(fs::read(f.root.join("Empty/arrived.md")).unwrap(), b"content added while the directory was retained");
}

#[test]
fn macos_folder_product_selection_cannot_adopt_replacement_during_confirmation() {
    let f = fixture(); tree(&f);
    let selection = f.service.prepare_folder_from_ui(f.epoch, "Parent/Folder").unwrap();
    fs::rename(f.root.join("Parent/Folder"), f.base.join("held")).unwrap();
    fs::create_dir(f.root.join("Parent/Folder")).unwrap();
    fs::write(f.root.join("Parent/Folder/keep"), b"replacement").unwrap();
    let replacement = inode(&f.root.join("Parent/Folder"));
    let failure = f.service.mutate_folder_from_ui(f.epoch, "Parent/Folder", &selection, "rename", Some("Renamed"), None).unwrap_err();
    assert_eq!(failure.code, "knowledge-folder-selection-changed");
    assert_eq!(inode(&f.root.join("Parent/Folder")), replacement);
    assert!(f.base.join("held/Sub/Note.md").is_file());
    assert!(!f.root.join("Parent/Renamed").exists());
}

#[test]
fn macos_folder_product_source_and_ancestors_changed_after_ready_are_preserved() {
    for relative in ["Parent/Folder", "Parent"] {
        let f = fixture(); tree(&f);
        let original = inode(&f.root.join("Parent/Folder"));
        let shifted = f.root.join(relative); let held = f.base.join("held");
        let original_path = f.root.join("Parent/Folder");
        AFTER_READY.with(|slot| *slot.borrow_mut() = Some(Box::new(move || {
            fs::rename(shifted, held).unwrap(); fs::create_dir_all(&original_path).unwrap();
            fs::write(original_path.join("keep"), b"replacement").unwrap();
        })));
        let result = mutate(&f, "Parent/Folder", "move", None, Some("Target"));
        assert_eq!(result.state, "recovery-required", "{relative}");
        assert_eq!(fs::read(f.root.join("Parent/Folder/keep")).unwrap(), b"replacement");
        let held_folder = if relative == "Parent" { f.base.join("held/Folder") } else { f.base.join("held") };
        assert_eq!(inode(&held_folder), original); assert!(held_folder.join("Sub/Note.md").is_file());
        assert!(!f.root.join("Target/Folder").exists());
    }
}

#[test]
fn macos_folder_product_target_and_vault_changed_after_ready_are_preserved() {
    for shift_root in [false, true] {
        let f = fixture(); tree(&f);
        let folder = inode(&f.root.join("Parent/Folder"));
        let root = f.root.clone(); let held = f.base.join("held");
        AFTER_READY.with(|slot| *slot.borrow_mut() = Some(Box::new(move || {
            if shift_root {
                fs::rename(&root, &held).unwrap(); fs::create_dir(&root).unwrap(); fs::write(root.join("keep"), b"replacement-root").unwrap();
            } else {
                fs::rename(root.join("Target"), &held).unwrap(); fs::create_dir(root.join("Target")).unwrap();
                fs::write(root.join("Target/keep"), b"replacement-target").unwrap();
            }
        })));
        let result = mutate(&f, "Parent/Folder", "move", None, Some("Target"));
        assert_eq!(result.state, "recovery-required");
        if shift_root {
            assert_eq!(inode(&f.base.join("held/Parent/Folder")), folder);
            assert_eq!(fs::read(f.root.join("keep")).unwrap(), b"replacement-root");
            assert!(!f.base.join("held/Target/Folder").exists());
        } else {
            assert_eq!(inode(&f.root.join("Parent/Folder")), folder);
            assert_eq!(fs::read(f.root.join("Target/keep")).unwrap(), b"replacement-target");
            assert!(!f.base.join("held/Folder").exists());
        }
    }
}

#[test]
fn macos_folder_product_interruption_before_go_does_not_start_mutation() {
    let f = fixture(); tree(&f);
    INTERRUPT.with(|slot| slot.set(1));
    let result = mutate(&f, "Parent/Folder", "move", None, Some("Target"));
    assert_eq!(result.state, "recovery-required");
    assert!(f.root.join("Parent/Folder/Sub/Note.md").is_file());
    assert!(!f.root.join("Target/Folder").exists());
    let reopened = KnowledgeService::initialize(f.base.join("app")).unwrap();
    let epoch = reopened.activate_ui_source(&f.registration.id).unwrap().source_epoch;
    let records = reopened.list_folder_recoveries_from_ui(epoch).unwrap();
    let record = records.iter().find(|r| r.result.operation_id == result.operation_id).unwrap();
    assert_eq!(record.result.state, "unchanged"); assert!(!record.can_restore);
}

#[test]
fn macos_folder_product_interruption_after_operation_is_recovered_without_reexecution() {
    let f = fixture(); tree(&f);
    let folder = inode(&f.root.join("Parent/Folder"));
    INTERRUPT.with(|slot| slot.set(2));
    let result = mutate(&f, "Parent/Folder", "move", None, Some("Target"));
    assert_eq!(result.state, "recovery-required");
    assert_eq!(inode(&f.root.join("Target/Folder")), folder);
    let reopened = KnowledgeService::initialize(f.base.join("app")).unwrap();
    let epoch = reopened.activate_ui_source(&f.registration.id).unwrap().source_epoch;
    let records = reopened.list_folder_recoveries_from_ui(epoch).unwrap();
    let record = records.iter().find(|r| r.result.operation_id == result.operation_id).unwrap();
    assert_eq!(record.result.state, "completed"); assert!(record.can_restore);
    assert_eq!(reopened.restore_folder_from_ui(epoch, &result.operation_id).unwrap().state, "completed");
    assert_eq!(inode(&f.root.join("Parent/Folder")), folder);
}

#[test]
fn macos_folder_product_recovery_rejects_replaced_retained_object_and_tampered_intent() {
    let f = fixture(); fs::create_dir(f.root.join("Empty")).unwrap();
    let deleted = mutate(&f, "Empty", "delete", None, None); assert_eq!(deleted.state, "completed");
    let retained = f.root.join(".luckyray/folder-retained").join(&deleted.operation_id).join("Empty");
    fs::rename(&retained, f.base.join("held-original")).unwrap(); fs::create_dir(&retained).unwrap();
    let replacement = inode(&retained);
    let records = f.service.list_folder_recoveries_from_ui(f.epoch).unwrap();
    let item = records.iter().find(|r| r.result.operation_id == deleted.operation_id).unwrap();
    assert_eq!(item.result.state, "recovery-required"); assert!(!item.can_restore);
    assert!(f.service.restore_folder_from_ui(f.epoch, &deleted.operation_id).is_err());
    assert_eq!(inode(&retained), replacement); assert!(!f.root.join("Empty").exists());
    let journal = f.root.join(".luckyray/folder-operations").join(format!("{}.json", deleted.operation_id));
    let mut content: serde_json::Value = serde_json::from_slice(&fs::read(&journal).unwrap()).unwrap();
    content["intent"]["object"]["inode"] = replacement.into();
    fs::write(&journal, serde_json::to_vec(&content).unwrap()).unwrap();
    assert!(f.service.list_folder_recoveries_from_ui(f.epoch).is_err());
    assert!(f.service.restore_folder_from_ui(f.epoch, &deleted.operation_id).is_err());
    assert_eq!(inode(&retained), replacement);
}

#[test]
fn macos_folder_product_dirty_and_retired_sources_are_vetoed() {
    let f = fixture(); tree(&f);
    let selection = f.service.prepare_folder_from_ui(f.epoch, "Parent/Folder").unwrap();
    f.service.companion_set_desktop_drafts(f.epoch, 1, vec!["Parent/Folder/Sub/Note.md".into()]).unwrap();
    assert_eq!(f.service.mutate_folder_from_ui(f.epoch, "Parent/Folder", &selection, "rename", Some("Renamed"), None).unwrap_err().code,
        "knowledge-desktop-draft-busy");
    let next = f.service.activate_ui_source(&f.registration.id).unwrap().source_epoch;
    assert_ne!(next, f.epoch);
    assert_eq!(f.service.mutate_folder_from_ui(f.epoch, "Parent/Folder", &selection, "rename", Some("Renamed"), None).unwrap_err().code,
        "knowledge-source-inactive");
    assert!(f.root.join("Parent/Folder/Sub/Note.md").is_file()); assert!(!f.root.join("Parent/Renamed").exists());
}

#[test]
fn macos_folder_product_links_and_own_subtree_are_rejected() {
    let f = fixture(); tree(&f);
    symlink(f.root.join("Parent/Folder"), f.root.join("Alias")).unwrap();
    assert!(f.service.prepare_folder_from_ui(f.epoch, "Alias").is_err());
    let selection = f.service.prepare_folder_from_ui(f.epoch, "Parent/Folder").unwrap();
    assert_eq!(f.service.mutate_folder_from_ui(f.epoch, "Parent/Folder", &selection, "move", None, Some("Parent/Folder/Sub"))
        .unwrap_err().code, "knowledge-folder-own-subtree");
    assert!(f.root.join("Parent/Folder/Sub/Note.md").is_file());
}

#[test]
fn macos_folder_product_unicode_and_case_rename_use_real_directory_names() {
    let f = fixture(); fs::create_dir(f.root.join("Folder")).unwrap();
    let original = inode(&f.root.join("Folder"));
    let first = mutate(&f, "Folder", "rename", Some("folder"), None);
    assert_eq!(first.state, "completed");
    assert_eq!(inode(&f.root.join("folder")), original);
    assert_eq!(f.service.restore_folder_from_ui(f.epoch, &first.operation_id).unwrap().state, "completed");
    let again = mutate(&f, "Folder", "rename", Some("folder"), None);
    assert_eq!(again.state, "completed");
    let second = mutate(&f, "folder", "rename", Some("资料-é"), None);
    assert_eq!(second.state, "completed");
    assert_eq!(inode(&f.root.join("资料-é")), original);
}
