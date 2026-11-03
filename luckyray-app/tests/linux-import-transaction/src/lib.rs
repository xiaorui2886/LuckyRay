// Compile and exercise the actual production filesystem implementation without Tauri.
#![cfg(target_os = "linux")]
#![allow(dead_code)]
#[path = "../../../src-tauri/src/linux_attachment_store.rs"]
mod linux_attachment_store;
#[path = "../../../src-tauri/src/linux_fs.rs"]
mod linux_fs;
// The attachment store publishes replacements through the journalled note
// writer, so the same production file is compiled here rather than mocked.
#[path = "../../../src-tauri/src/linux_file_store.rs"]
mod linux_file_store;
#[path = "../../../src-tauri/src/linux_managed_record.rs"]
mod linux_managed_record;
// The witness rule is pure by design, so the TTL/epoch decisions can be
// exercised here without a running knowledge service.
#[path = "../../../src-tauri/src/knowledge/attachment_witness.rs"]
mod attachment_witness;
// The material file move primitive (step 3) only needs linux_fs and libc.
#[path = "../../../src-tauri/src/linux_material_move.rs"]
mod linux_material_move;

#[cfg(test)]
mod tests {
    use super::linux_attachment_store::{Dependency, ImportStore};
    use hmac::{Hmac, Mac};
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::io;
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
    use std::path::Path;
    const ID: &str = "0123456789abcdef0123456789abcdef";
    const KEY: [u8; 32] = [7; 32]; // Synthetic test authority, never a real key.
    fn temporary() -> tempfile::TempDir {
        // Use the owned checkout filesystem; a container's /tmp may not support
        // ACL probes. Capability failures stay hard failures, never a PASS/skip.
        tempfile::Builder::new()
            .prefix("linux-import-check-")
            .tempdir_in(std::env::current_dir().unwrap())
            .unwrap()
    }
    fn fixture() -> tempfile::TempDir {
        let root = temporary();
        fs::create_dir(root.path().join(".luckyray")).unwrap();
        root
    }
    fn transaction(root: &Path) -> ImportStore {
        let store = ImportStore::open(root, ID, true).unwrap();
        store.write_intent(b"synthetic sealed plan bytes").unwrap();
        store
    }
    #[test]
    fn actual_create_only_commit_retains_case_distinct_notes_and_image() {
        let root = fixture();
        let store = transaction(root.path());
        for (index, (name, content)) in [
            ("attachments/素材 图 #100%.png", b"synthetic png".as_slice()),
            ("Note.md", b"UPPER"),
            ("note (1).md", b"lower"),
        ]
        .iter()
        .enumerate()
        {
            store.require_vacant(name).unwrap();
            assert!(!store
                .install(index, name, content, &KEY, || Ok(()))
                .unwrap());
            assert_eq!(fs::read(root.path().join(name)).unwrap(), *content);
            store.verify_installed(index, name, content, &KEY).unwrap();
            assert_eq!(
                fs::metadata(root.path().join(name))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o7777,
                0o600
            );
        }
        store
            .append_result("abcdef0123456789abcdef0123456789", b"completed")
            .unwrap();
        assert!(root
            .path()
            .join(format!(".luckyray/attachment-operations/{ID}.json"))
            .is_file());
        drop(store);
        assert_eq!(ImportStore::list_ids(root.path()).unwrap(), vec![ID]);
    }
    #[test]
    fn existing_file_is_never_overwritten_even_when_bytes_match() {
        let root = fixture();
        let store = transaction(root.path());
        fs::write(root.path().join("Note.md"), b"UPPER").unwrap();
        fs::set_permissions(
            root.path().join("Note.md"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        assert!(store.require_vacant("Note.md").is_err());
        assert!(store
            .install(0, "Note.md", b"UPPER", &KEY, || Ok(()))
            .is_err());
        assert_eq!(fs::read(root.path().join("Note.md")).unwrap(), b"UPPER");
        drop(store);
        let root = fixture();
        let store = transaction(root.path());
        let intent = root
            .path()
            .join(format!(".luckyray/attachment-operations/{ID}.json"));
        fs::write(intent, b"changed durable intent").unwrap();
        assert!(store
            .install(0, "Note.md", b"UPPER", &KEY, || Ok(()))
            .is_err());
        assert!(!root.path().join("Note.md").exists());
    }
    #[test]
    fn interruption_before_publish_and_after_publish_before_result_can_resume() {
        let root = fixture();
        let store = transaction(root.path());
        let mut calls = 0;
        assert!(store
            .install(0, "Note.md", b"UPPER", &KEY, || {
                calls += 1;
                if calls == 2 {
                    Err(io::Error::from(io::ErrorKind::Interrupted))
                } else {
                    Ok(())
                }
            })
            .is_err());
        assert!(!root.path().join("Note.md").exists());
        drop(store);
        let store = ImportStore::open(root.path(), ID, false).unwrap();
        assert!(!store
            .install(0, "Note.md", b"UPPER", &KEY, || Ok(()))
            .unwrap());
        // Simulate loss of the process before its batch result is appended.
        drop(store);
        let store = ImportStore::open(root.path(), ID, false).unwrap();
        assert!(store
            .install(0, "Note.md", b"UPPER", &KEY, || Ok(()))
            .unwrap());
        assert!(!store
            .install(1, "note (1).md", b"lower", &KEY, || Ok(()))
            .unwrap());
        assert_eq!(fs::read(root.path().join("Note.md")).unwrap(), b"UPPER");
    }
    #[test]
    fn resumed_import_refuses_replaced_inode_or_changed_access_metadata() {
        for replace in [true, false] {
            let root = fixture();
            let store = transaction(root.path());
            store
                .install(0, "Note.md", b"UPPER", &KEY, || Ok(()))
                .unwrap();
            drop(store);
            if replace {
                fs::write(root.path().join("external"), b"UPPER").unwrap();
                fs::set_permissions(
                    root.path().join("external"),
                    fs::Permissions::from_mode(0o600),
                )
                .unwrap();
                fs::rename(root.path().join("external"), root.path().join("Note.md")).unwrap();
            } else {
                fs::set_permissions(
                    root.path().join("Note.md"),
                    fs::Permissions::from_mode(0o644),
                )
                .unwrap();
            }
            let store = ImportStore::open(root.path(), ID, false).unwrap();
            assert!(store
                .install(0, "Note.md", b"UPPER", &KEY, || Ok(()))
                .is_err());
            assert!(store
                .verify_installed(0, "Note.md", b"UPPER", &KEY)
                .is_err());
            assert_eq!(fs::read(root.path().join("Note.md")).unwrap(), b"UPPER");
        }
    }
    #[test]
    fn actual_source_dependency_rejects_edits_and_symlink_targets() {
        let root = fixture();
        let source = root.path().join("source.md");
        fs::write(&source, b"original").unwrap();
        let hash = format!("{:x}", Sha256::digest(b"original"));
        let dependency = Dependency::open(&source, &hash).unwrap();
        dependency.verify().unwrap();
        fs::write(&source, b"external edit").unwrap();
        assert!(dependency.verify().is_err());
        symlink(&source, root.path().join("linked.md")).unwrap();
        assert!(Dependency::open(&root.path().join("linked.md"), &hash).is_err());
    }
    #[test]
    fn held_root_and_parent_identity_refuse_symlink_or_replacement() {
        let root = fixture();
        let outside = temporary();
        let store = transaction(root.path());
        symlink(outside.path(), root.path().join("attachments")).unwrap();
        assert!(store
            .install(0, "attachments/x.png", b"data", &KEY, || Ok(()))
            .is_err());
        assert!(!outside.path().join("x.png").exists());
        drop(store);
        let parent = temporary();
        let path = parent.path().join("vault");
        fs::create_dir(&path).unwrap();
        fs::create_dir(path.join(".luckyray")).unwrap();
        let store = transaction(&path);
        fs::rename(&path, parent.path().join("old-vault")).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(store
            .install(0, "Note.md", b"data", &KEY, || Ok(()))
            .is_err());
        assert!(!path.join("Note.md").exists());
        assert!(!parent.path().join("old-vault/Note.md").exists());
    }
    #[test]
    fn unsafe_metadata_is_refused_before_private_payload_creation() {
        let root = fixture();
        let store = transaction(root.path());
        fs::create_dir(root.path().join("unsafe")).unwrap();
        fs::set_permissions(
            root.path().join("unsafe"),
            fs::Permissions::from_mode(0o2770),
        )
        .unwrap();
        assert!(store
            .install(0, "unsafe/secret.md", b"private payload", &KEY, || Ok(()))
            .is_err());
        assert_eq!(fs::read_dir(root.path().join("unsafe")).unwrap().count(), 0);
        let root = fixture();
        let path = std::ffi::CString::new(root.path().as_os_str().as_encoded_bytes()).unwrap();
        let ret = unsafe {
            libc::setxattr(
                path.as_ptr(),
                c"user.synthetic".as_ptr(),
                b"x".as_ptr().cast(),
                1,
                0,
            )
        };
        assert_eq!(
            ret,
            0,
            "xattr fixture unavailable: {}",
            io::Error::last_os_error()
        );
        assert!(ImportStore::open(root.path(), ID, true).is_err());
        assert!(!root.path().join(".luckyray/attachment-operations").exists());
    }
    #[test]
    fn default_acl_is_refused_before_any_new_payload() {
        let root = fixture();
        let mut acl = 2u32.to_le_bytes().to_vec();
        for (tag, permissions) in [(1u16, 7u16), (4, 5), (32, 0)] {
            acl.extend(tag.to_le_bytes());
            acl.extend(permissions.to_le_bytes());
            acl.extend(u32::MAX.to_le_bytes());
        }
        let path = std::ffi::CString::new(root.path().as_os_str().as_encoded_bytes()).unwrap();
        let ret = unsafe {
            libc::setxattr(
                path.as_ptr(),
                c"system.posix_acl_default".as_ptr(),
                acl.as_ptr().cast(),
                acl.len(),
                0,
            )
        };
        assert_eq!(
            ret,
            0,
            "default ACL fixture unavailable: {}",
            io::Error::last_os_error()
        );
        assert!(ImportStore::open(root.path(), ID, true).is_err());
        assert!(!root.path().join(".luckyray/attachment-operations").exists());
    }
    #[test]
    fn cooperating_writer_lock_and_sealed_step_evidence_are_enforced() {
        let root = fixture();
        let store = transaction(root.path());
        assert!(ImportStore::open(root.path(), "abcdef0123456789abcdef0123456789", true).is_err());
        store
            .install(0, "Note.md", b"UPPER", &KEY, || Ok(()))
            .unwrap();
        drop(store);
        let step = root
            .path()
            .join(format!(".luckyray/attachment-operations/{ID}-0.step.json"));
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&step).unwrap()).unwrap();
        value["inode"] = serde_json::json!(1);
        fs::write(&step, serde_json::to_vec(&value).unwrap()).unwrap();
        let store = ImportStore::open(root.path(), ID, false).unwrap();
        assert!(store
            .install(0, "Note.md", b"UPPER", &KEY, || Ok(()))
            .is_err());
        assert_eq!(fs::read(root.path().join("Note.md")).unwrap(), b"UPPER");
    }
    #[test]
    fn missing_intent_and_escaping_or_internal_targets_never_publish() {
        let root = fixture();
        let store = ImportStore::open(root.path(), ID, true).unwrap();
        assert!(store
            .install(0, "Note.md", b"data", &KEY, || Ok(()))
            .is_err());
        store.write_intent(b"synthetic plan").unwrap();
        for path in [
            "../escape.md",
            "/tmp/escape.md",
            ".luckyray/x",
            "a/../x",
            "a//x",
            "a/.git/x",
            ".lrk-x",
            "x\\y",
        ] {
            assert!(
                store.install(0, path, b"data", &KEY, || Ok(())).is_err(),
                "{path}"
            );
        }
        assert!(!root.path().join("Note.md").exists());
    }

    // --- Replace / Remove / rollback -------------------------------------------------
    const INTENT: &[u8] = b"synthetic sealed plan bytes";

    fn digest(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    fn step_path(root: &Path, index: usize) -> std::path::PathBuf {
        root.join(format!(
            ".luckyray/attachment-operations/{ID}-{index}.step.json"
        ))
    }

    fn private_file(path: &Path, bytes: &[u8]) {
        fs::write(path, bytes).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }

    /// Interrupts the Nth admission callback, which is the only point where a
    /// step can be abandoned between durable evidence and publication.
    struct Fault {
        remaining: Option<usize>,
        calls: usize,
    }

    impl Fault {
        fn none() -> Self {
            Self {
                remaining: None,
                calls: 0,
            }
        }
        fn at(call: usize) -> Self {
            Self {
                remaining: Some(call),
                calls: 0,
            }
        }
        fn tick(&mut self) -> io::Result<()> {
            self.calls += 1;
            if self.remaining == Some(self.calls) {
                return Err(io::Error::from(io::ErrorKind::Interrupted));
            }
            Ok(())
        }
    }

    const OLD: &str = "attachments/旧 图 #100%.png";
    const NEW: &str = "attachments/新 图 #100%.png";

    fn seed_plan(root: &Path) {
        fs::create_dir_all(root.join("attachments")).unwrap();
        private_file(&root.join(OLD), b"old-png");
        fs::write(root.join("Note.md"), b"old link").unwrap();
        fs::set_permissions(root.join("Note.md"), fs::Permissions::from_mode(0o640)).unwrap();
    }

    /// A rename in miniature: publish the copy, rewrite the note, remove the
    /// original. Indices match the plan positions the runner uses.
    fn run_plan(store: &ImportStore, fault: &mut Fault) -> io::Result<()> {
        store.install(0, NEW, b"old-png", &KEY, || fault.tick())?;
        store.install_replace(1, "Note.md", b"old link", b"new link", &KEY, || fault.tick())?;
        store.install_remove(2, OLD, b"old-png", true, &KEY, || fault.tick())?;
        Ok(())
    }

    fn tombstone(root: &Path, index: usize) -> std::path::PathBuf {
        root.join(format!("attachments/.lrk-{ID}-{index}.removed"))
    }

    fn assert_forward_state(root: &Path, old_inode: u64) {
        assert_eq!(fs::read(root.join(NEW)).unwrap(), b"old-png");
        assert!(!root.join(OLD).exists());
        assert_eq!(fs::read(root.join("Note.md")).unwrap(), b"new link");
        let moved = fs::metadata(tombstone(root, 2)).unwrap();
        assert_eq!(moved.ino(), old_inode);
        assert_eq!(moved.permissions().mode() & 0o777, 0o600);
        let note = fs::metadata(root.join("Note.md")).unwrap();
        assert_eq!(note.permissions().mode() & 0o777, 0o640);
    }

    #[test]
    fn create_replace_remove_round_trip() {
        let root = fixture();
        seed_plan(root.path());
        let old_inode = fs::metadata(root.path().join(OLD)).unwrap().ino();
        let store = transaction(root.path());
        run_plan(&store, &mut Fault::none()).unwrap();
        assert_forward_state(root.path(), old_inode);
        store
            .verify_step(0, NEW, None, Some(&b"old-png"[..]), true, &KEY)
            .unwrap();
        store
            .verify_step(1, "Note.md", Some(&b"old link"[..]), Some(&b"new link"[..]), true, &KEY)
            .unwrap();
        store.verify_step(2, OLD, Some(&b"old-png"[..]), None, true, &KEY).unwrap();
        // The published copy and the tombstone are both private.
        assert_eq!(
            fs::metadata(root.path().join(NEW))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn resume_at_every_boundary() {
        // Seven admission points exist across the three steps; the eighth case
        // is "nothing was interrupted", which must also converge.
        for boundary in 1..=8 {
            let root = fixture();
            seed_plan(root.path());
            let old_inode = fs::metadata(root.path().join(OLD)).unwrap().ino();
            {
                let store = transaction(root.path());
                let mut fault = Fault::at(boundary);
                let _ = run_plan(&store, &mut fault);
            }
            let store = ImportStore::open(root.path(), ID, false).unwrap();
            run_plan(&store, &mut Fault::none()).unwrap();
            assert_forward_state(root.path(), old_inode);
            for index in 0..3 {
                let step = fs::read_to_string(step_path(root.path(), index)).unwrap();
                assert!(step.contains("\"verb\""), "boundary {boundary} step {index}");
            }
        }
    }

    #[test]
    fn rollback_keeps_created_and_restores_inode() {
        let root = fixture();
        seed_plan(root.path());
        let old_inode = fs::metadata(root.path().join(OLD)).unwrap().ino();
        let store = transaction(root.path());
        run_plan(&store, &mut Fault::none()).unwrap();
        // Reverse order of the plan.
        assert!(!store
            .restore_removed(2, OLD, b"old-png", true, &KEY, || Ok(()))
            .unwrap());
        assert!(!store
            .restore_replaced(1, "Note.md", b"old link", &KEY, || Ok(()))
            .unwrap());
        // The copy this operation created is retained, exactly as on Windows.
        assert_eq!(fs::read(root.path().join(NEW)).unwrap(), b"old-png");
        let restored = fs::metadata(root.path().join(OLD)).unwrap();
        assert_eq!(restored.ino(), old_inode);
        assert_eq!(restored.permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::read(root.path().join("Note.md")).unwrap(), b"old link");
        assert_eq!(
            fs::metadata(root.path().join("Note.md"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o640
        );
        assert!(!tombstone(root.path(), 2).exists());
        store
            .verify_before_state(2, OLD, b"old-png", true, &KEY)
            .unwrap();
        store
            .verify_before_state(1, "Note.md", b"old link", true, &KEY)
            .unwrap();
        // A repeated rollback is a no-op, not a second write.
        assert!(store
            .restore_removed(2, OLD, b"old-png", true, &KEY, || Ok(()))
            .unwrap());
        assert!(store
            .restore_replaced(1, "Note.md", b"old link", &KEY, || Ok(()))
            .unwrap());
    }

    #[test]
    fn rollback_refuses_occupied_original() {
        let root = fixture();
        seed_plan(root.path());
        let store = transaction(root.path());
        run_plan(&store, &mut Fault::none()).unwrap();
        let occupied = root.path().join(OLD);
        fs::write(&occupied, b"third party").unwrap();
        fs::set_permissions(&occupied, fs::Permissions::from_mode(0o644)).unwrap();
        let failure = store
            .restore_removed(2, OLD, b"old-png", true, &KEY, || Ok(()))
            .err()
            .expect("an occupied original name must not be overwritten");
        assert_eq!(failure.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&occupied).unwrap(), b"third party");
        assert!(tombstone(root.path(), 2).is_file());
        assert!(store
            .verify_before_state(2, OLD, b"old-png", true, &KEY)
            .is_err());
    }

    #[test]
    fn rollback_refuses_unprovable_state() {
        let root = fixture();
        seed_plan(root.path());
        let store = transaction(root.path());
        run_plan(&store, &mut Fault::none()).unwrap();
        fs::write(root.path().join("Note.md"), b"external edit").unwrap();
        let failure = store
            .restore_replaced(1, "Note.md", b"old link", &KEY, || Ok(()))
            .err()
            .expect("a third state must stop the rollback");
        assert_eq!(failure.kind(), io::ErrorKind::InvalidData);
        assert_eq!(
            fs::read(root.path().join("Note.md")).unwrap(),
            b"external edit"
        );
    }

    #[test]
    fn step_evidence_tamper_is_rejected() {
        let root = fixture();
        seed_plan(root.path());
        let store = transaction(root.path());
        run_plan(&store, &mut Fault::none()).unwrap();
        drop(store);
        let path = step_path(root.path(), 1);
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        value["digest"] = serde_json::json!("0".repeat(64));
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let store = ImportStore::open(root.path(), ID, false).unwrap();
        assert!(store
            .verify_step(1, "Note.md", Some(&b"old link"[..]), Some(&b"new link"[..]), true, &KEY)
            .is_err());
        assert!(store
            .restore_replaced(1, "Note.md", b"old link", &KEY, || Ok(()))
            .is_err());
        assert_eq!(fs::read(root.path().join("Note.md")).unwrap(), b"new link");
    }

    #[test]
    fn legacy_v1_step_still_verifies() {
        // A record written before the verb existed must keep verifying, or an
        // import that is in flight during an upgrade becomes unrecoverable.
        let root = fixture();
        let store = transaction(root.path());
        assert!(!store
            .install(0, "Note.md", b"UPPER", &KEY, || Ok(()))
            .unwrap());
        drop(store);
        let path = root.path().join("Note.md");
        let metadata = fs::metadata(&path).unwrap();
        let context = format!("{ID}:0:{}", digest(INTENT));
        let payload = format!(
            "{{\"version\":1,\"relative\":\"Note.md\",\"digest\":\"{}\",\"context\":\"{context}\",\"signature\":\"\",\"device\":{},\"inode\":{},\"uid\":{},\"gid\":{},\"mode\":{},\"modified\":[{},{}]}}",
            digest(b"UPPER"),
            metadata.dev(),
            metadata.ino(),
            metadata.uid(),
            metadata.gid(),
            metadata.mode(),
            metadata.mtime(),
            metadata.mtime_nsec()
        );
        let mut mac = Hmac::<Sha256>::new_from_slice(&KEY).unwrap();
        mac.update(b"luckyray-linux-import-step-v1\0");
        mac.update(payload.as_bytes());
        let signature = format!("{:x}", mac.finalize().into_bytes());
        let legacy = payload.replace(
            "\"signature\":\"\"",
            &format!("\"signature\":\"{signature}\""),
        );
        let step = step_path(root.path(), 0);
        fs::write(&step, legacy.as_bytes()).unwrap();
        assert_eq!(
            fs::metadata(&step).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let store = ImportStore::open(root.path(), ID, false).unwrap();
        store
            .verify_installed(0, "Note.md", b"UPPER", &KEY)
            .unwrap();
        assert!(store
            .install(0, "Note.md", b"UPPER", &KEY, || Ok(()))
            .unwrap());
    }

    #[test]
    fn symlink_and_hardlink_are_refused() {
        let root = fixture();
        seed_plan(root.path());
        let store = transaction(root.path());
        fs::hard_link(root.path().join(OLD), root.path().join("attachments/copy.png")).unwrap();
        assert!(store
            .install_remove(2, OLD, b"old-png", true, &KEY, || Ok(()))
            .is_err());
        assert_eq!(fs::read(root.path().join(OLD)).unwrap(), b"old-png");
        let outside = temporary();
        symlink(outside.path(), root.path().join("linked")).unwrap();
        assert!(store
            .install(0, "linked/x.png", b"png", &KEY, || Ok(()))
            .is_err());
        assert!(!outside.path().join("x.png").exists());
    }

    #[test]
    fn acl_on_target_refuses_replace() {
        let root = fixture();
        seed_plan(root.path());
        let store = transaction(root.path());
        let path = root.path().join("Note.md");
        let name = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
        let mut acl = 2u32.to_le_bytes().to_vec();
        for (tag, permission, id) in [
            (1u16, 6u16, u32::MAX),
            (2, 4, unsafe { libc::geteuid() }.saturating_add(1)),
            (4, 0, u32::MAX),
            (16, 4, u32::MAX),
            (32, 0, u32::MAX),
        ] {
            acl.extend_from_slice(&tag.to_le_bytes());
            acl.extend_from_slice(&permission.to_le_bytes());
            acl.extend_from_slice(&id.to_le_bytes());
        }
        assert_eq!(
            unsafe {
                libc::setxattr(
                    name.as_ptr(),
                    c"system.posix_acl_access".as_ptr(),
                    acl.as_ptr().cast(),
                    acl.len(),
                    0,
                )
            },
            0,
            "synthetic POSIX ACL fixture unavailable: {}",
            io::Error::last_os_error()
        );
        let failure = store
            .install_replace(1, "Note.md", b"old link", b"new link", &KEY, || Ok(()))
            .err()
            .expect("a target carrying an ACL must not be replaced");
        assert_eq!(failure.kind(), io::ErrorKind::Unsupported);
        assert_eq!(fs::read(&path).unwrap(), b"old link");
    }

    #[test]
    fn weird_names_survive() {
        let root = fixture();
        fs::create_dir_all(root.path().join("素材 目录 #1%")).unwrap();
        let store = transaction(root.path());
        let name = "素材 目录 #1%/图 片 #100%.png";
        assert!(!store.install(0, name, b"png", &KEY, || Ok(())).unwrap());
        assert_eq!(fs::read(root.path().join(name)).unwrap(), b"png");
        assert!(!store
            .install_remove(1, name, b"png", true, &KEY, || Ok(()))
            .unwrap());
        assert!(!root.path().join(name).exists());
        let moved = root
            .path()
            .join(format!("素材 目录 #1%/.lrk-{ID}-1.removed"));
        assert!(moved.is_file());
        assert!(!store
            .restore_removed(1, name, b"png", true, &KEY, || Ok(()))
            .unwrap());
        assert_eq!(fs::read(root.path().join(name)).unwrap(), b"png");
    }

    #[test]
    fn tombstone_name_collision_is_refused() {
        let root = fixture();
        seed_plan(root.path());
        let store = transaction(root.path());
        let occupied = tombstone(root.path(), 2);
        private_file(&occupied, b"someone else");
        let old_inode = fs::metadata(root.path().join(OLD)).unwrap().ino();
        assert!(store
            .install_remove(2, OLD, b"old-png", true, &KEY, || Ok(()))
            .is_err());
        assert_eq!(
            fs::metadata(root.path().join(OLD)).unwrap().ino(),
            old_inode
        );
        assert_eq!(fs::read(&occupied).unwrap(), b"someone else");
    }

    #[test]
    fn tombstone_is_invisible_to_inventory() {
        let root = fixture();
        seed_plan(root.path());
        let store = transaction(root.path());
        run_plan(&store, &mut Fault::none()).unwrap();
        let name = format!(".lrk-{ID}-2.removed");
        assert!(name.starts_with(".lrk-") && name.ends_with(".removed"));
        assert!(root.path().join("attachments").join(&name).is_file());
        // No plan may address the reserved family, so a tombstone can never be
        // read, rewritten or removed as if it were an attachment.
        assert!(store.require_vacant(&format!("attachments/{name}")).is_err());
        assert!(store
            .install(5, &format!("attachments/{name}"), b"x", &KEY, || Ok(()))
            .is_err());
        drop(store);
        assert_eq!(
            ImportStore::list_ids(root.path()).unwrap(),
            vec![ID.to_owned()]
        );
    }

    // --- Step 2 shapes: conversion, note move, external reference update ---------------

    #[test]
    fn note_removal_accepts_a_shared_markdown_file() {
        // A note move removes a Markdown document, not a private attachment. The
        // private rule must still be enforced for attachments, so the same call
        // is refused as private and accepted as shared.
        let root = fixture();
        let store = transaction(root.path());
        let note = root.path().join("Moved.md");
        fs::write(&note, b"body").unwrap();
        fs::set_permissions(&note, fs::Permissions::from_mode(0o644)).unwrap();
        let inode = fs::metadata(&note).unwrap().ino();
        assert!(store
            .install_remove(0, "Moved.md", b"body", true, &KEY, || Ok(()))
            .is_err());
        assert_eq!(fs::metadata(&note).unwrap().ino(), inode);
        assert!(!store
            .install_remove(0, "Moved.md", b"body", false, &KEY, || Ok(()))
            .unwrap());
        assert!(!note.exists());
        let moved = fs::metadata(root.path().join(format!(".lrk-{ID}-0.removed"))).unwrap();
        assert_eq!(moved.ino(), inode);
        assert_eq!(moved.permissions().mode() & 0o777, 0o644);
        store
            .verify_step(0, "Moved.md", Some(&b"body"[..]), None, false, &KEY)
            .unwrap();
        assert!(!store
            .restore_removed(0, "Moved.md", b"body", false, &KEY, || Ok(()))
            .unwrap());
        let restored = fs::metadata(&note).unwrap();
        assert_eq!(restored.ino(), inode);
        assert_eq!(restored.permissions().mode() & 0o777, 0o644);
        store
            .verify_before_state(0, "Moved.md", b"body", false, &KEY)
            .unwrap();
    }

    #[test]
    fn conversion_sequence_publishes_copies_then_rewrites_the_note() {
        let root = fixture();
        fs::create_dir_all(root.path().join("attachments")).unwrap();
        fs::write(root.path().join("Note.md"), b"old").unwrap();
        fs::set_permissions(
            root.path().join("Note.md"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        let store = transaction(root.path());
        // Copies first, then the rewrite that points at them.
        assert!(!store
            .install(0, "attachments/a.png", b"png-a", &KEY, || Ok(()))
            .unwrap());
        assert!(!store
            .install(1, "attachments/b.png", b"png-b", &KEY, || Ok(()))
            .unwrap());
        assert!(!store
            .install_replace(2, "Note.md", b"old", b"new", &KEY, || Ok(()))
            .unwrap());
        assert_eq!(fs::read(root.path().join("attachments/a.png")).unwrap(), b"png-a");
        assert_eq!(fs::read(root.path().join("attachments/b.png")).unwrap(), b"png-b");
        assert_eq!(fs::read(root.path().join("Note.md")).unwrap(), b"new");
        store
            .verify_step(2, "Note.md", Some(&b"old"[..]), Some(&b"new"[..]), false, &KEY)
            .unwrap();
        // Rolling back restores the note and keeps both copies.
        assert!(!store
            .restore_replaced(2, "Note.md", b"old", &KEY, || Ok(()))
            .unwrap());
        assert_eq!(fs::read(root.path().join("Note.md")).unwrap(), b"old");
        assert_eq!(fs::read(root.path().join("attachments/a.png")).unwrap(), b"png-a");
        assert_eq!(fs::read(root.path().join("attachments/b.png")).unwrap(), b"png-b");
    }

    #[test]
    fn interrupted_note_rewrite_rolls_back_without_touching_the_copies() {
        let root = fixture();
        fs::create_dir_all(root.path().join("attachments")).unwrap();
        fs::write(root.path().join("Note.md"), b"old").unwrap();
        fs::set_permissions(
            root.path().join("Note.md"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        let store = transaction(root.path());
        assert!(!store
            .install(0, "attachments/a.png", b"png-a", &KEY, || Ok(()))
            .unwrap());
        // Interrupt the rewrite on its first admission, after the evidence exists.
        let mut calls = 0;
        assert!(store
            .install_replace(1, "Note.md", b"old", b"new", &KEY, || {
                calls += 1;
                if calls == 1 {
                    Err(io::Error::from(io::ErrorKind::Interrupted))
                } else {
                    Ok(())
                }
            })
            .is_err());
        assert_eq!(fs::read(root.path().join("Note.md")).unwrap(), b"old");
        // The rollback finds the recorded before-state and changes nothing.
        assert!(store
            .restore_replaced(1, "Note.md", b"old", &KEY, || Ok(()))
            .unwrap());
        assert_eq!(fs::read(root.path().join("Note.md")).unwrap(), b"old");
        assert_eq!(
            fs::read(root.path().join("attachments/a.png")).unwrap(),
            b"png-a"
        );
    }

    #[test]
    fn unprovable_forward_state_writes_no_evidence() {
        // A note that matches neither the before nor the after bytes must stop
        // the step before any evidence or mutation exists.
        let root = fixture();
        fs::write(root.path().join("Note.md"), b"third state").unwrap();
        fs::set_permissions(
            root.path().join("Note.md"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        let store = transaction(root.path());
        let failure = store
            .install_replace(1, "Note.md", b"old", b"new", &KEY, || Ok(()))
            .err()
            .expect("a third state must not be rewritten");
        assert_eq!(failure.kind(), io::ErrorKind::InvalidData);
        assert_eq!(fs::read(root.path().join("Note.md")).unwrap(), b"third state");
        assert!(!step_path(root.path(), 1).exists());
    }

    // --- Witness rule (pure) ---------------------------------------------------------

    #[test]
    fn witness_expiry_epoch_and_identity_are_decided_by_the_pure_rule() {
        use super::attachment_witness::{witness_is_fresh, witness_required, witness_scope_is_current};
        let ttl = std::time::Duration::from_secs(600);
        // Fresh, same epoch, same plan: usable.
        assert!(witness_scope_is_current(7, 7, "vault-digest", "vault-digest"));
        assert!(witness_is_fresh(
            Some(std::time::Duration::from_secs(1)),
            ttl
        ));
        // Expired (including exactly at the boundary), or never recorded: refused.
        assert!(!witness_is_fresh(Some(ttl + std::time::Duration::from_secs(1)), ttl));
        assert!(!witness_is_fresh(Some(ttl), ttl));
        assert!(!witness_is_fresh(None, ttl));
        // Another source epoch or another plan identity: refused.
        assert!(!witness_scope_is_current(7, 8, "vault-digest", "vault-digest"));
        assert!(!witness_scope_is_current(7, 7, "vault-digest", "other-digest"));
        // A rollback never consults the witness, so an expired observation cannot
        // block an undo; a forward run always needs one.
        assert!(!witness_required(true));
        assert!(witness_required(false));
    }

    // --- Step 2: note move keeps the source mode -------------------------------------

    #[test]
    fn note_move_keeps_the_source_mode_and_rollback_restores_it() {
        let root = fixture();
        let store = transaction(root.path());
        let source = root.path().join("Old.md");
        fs::write(&source, b"body").unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o644)).unwrap();
        let inode = fs::metadata(&source).unwrap().ino();
        assert!(!store
            .install_copying_mode(0, "Old.md", "New.md", b"body", &KEY, || Ok(()))
            .unwrap());
        let published = fs::metadata(root.path().join("New.md")).unwrap();
        assert_eq!(published.permissions().mode() & 0o777, 0o644);
        store
            .verify_step(0, "New.md", None, Some(&b"body"[..]), false, &KEY)
            .unwrap();
        // The original is renamed aside, not copied, so its inode survives.
        assert!(!store
            .install_remove(1, "Old.md", b"body", false, &KEY, || Ok(()))
            .unwrap());
        assert!(!source.exists());
        assert!(!store
            .restore_removed(1, "Old.md", b"body", false, &KEY, || Ok(()))
            .unwrap());
        let restored = fs::metadata(&source).unwrap();
        assert_eq!(restored.ino(), inode);
        assert_eq!(restored.permissions().mode() & 0o777, 0o644);
        assert_eq!(
            fs::metadata(root.path().join("New.md"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o644
        );
    }

    #[test]
    fn note_move_refuses_a_source_with_an_extra_attribute() {
        // A source carrying an ACL (or any other extended attribute) cannot be
        // republished with the same access rules, so the move refuses before it
        // writes anything. The attribute is created here; when the filesystem
        // refuses the synthetic ACL the same gate is exercised with a user
        // attribute instead - the assertion itself never changes.
        let root = fixture();
        let store = transaction(root.path());
        let source = root.path().join("Old.md");
        fs::write(&source, b"body").unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o644)).unwrap();
        let name = std::ffi::CString::new(source.as_os_str().as_encoded_bytes()).unwrap();
        let mut acl = 2u32.to_le_bytes().to_vec();
        for (tag, permission) in [(1u16, 6u16), (4, 4), (16, 4), (32, 4)] {
            acl.extend_from_slice(&tag.to_le_bytes());
            acl.extend_from_slice(&permission.to_le_bytes());
            acl.extend_from_slice(&u32::MAX.to_le_bytes());
        }
        let acl_applied = unsafe {
            libc::setxattr(
                name.as_ptr(),
                c"system.posix_acl_access".as_ptr(),
                acl.as_ptr().cast(),
                acl.len(),
                0,
            )
        } == 0;
        if !acl_applied {
            assert_eq!(
                unsafe {
                    libc::setxattr(
                        name.as_ptr(),
                        c"user.synthetic".as_ptr(),
                        b"x".as_ptr().cast(),
                        1,
                        0,
                    )
                },
                0,
                "attribute fixture unavailable: {}",
                io::Error::last_os_error()
            );
        }
        let failure = store
            .install_copying_mode(0, "Old.md", "New.md", b"body", &KEY, || Ok(()))
            .err()
            .expect("a source with an extra attribute must not be republished");
        assert_eq!(failure.kind(), io::ErrorKind::Unsupported);
        assert!(!root.path().join("New.md").exists());
        assert!(!step_path(root.path(), 0).exists());
        assert!(!root
            .path()
            .join(format!(".lrk-import-{ID}-0.tmp"))
            .exists());
        assert_eq!(fs::read(&source).unwrap(), b"body");
    }

    #[test]
    fn occupied_destination_refuses_both_kinds_of_creation() {
        // A name taken between preview and execution must be refused with zero
        // writes, for a private attachment copy and for a moved note alike.
        let root = fixture();
        fs::create_dir_all(root.path().join("attachments")).unwrap();
        let store = transaction(root.path());
        for (target, source_name, shared) in [
            ("attachments/taken.png", None, false),
            ("Taken.md", Some("Old.md"), true),
        ] {
            let occupied = root.path().join(target);
            fs::write(&occupied, b"third party").unwrap();
            fs::set_permissions(&occupied, fs::Permissions::from_mode(0o644)).unwrap();
            if let Some(source_name) = source_name {
                fs::write(root.path().join(source_name), b"body").unwrap();
                fs::set_permissions(
                    root.path().join(source_name),
                    fs::Permissions::from_mode(0o644),
                )
                .unwrap();
            }
            let failure = match source_name {
                Some(source_name) => store
                    .install_copying_mode(0, source_name, target, b"body", &KEY, || Ok(()))
                    .err(),
                None => store
                    .install(0, target, b"body", &KEY, || Ok(()))
                    .err(),
            }
            .unwrap_or_else(|| panic!("{target} must not be overwritten"));
            assert_eq!(failure.kind(), io::ErrorKind::AlreadyExists, "{shared}");
            assert_eq!(fs::read(&occupied).unwrap(), b"third party");
            assert!(!step_path(root.path(), 0).exists());
            assert!(!root
                .path()
                .join(format!(".lrk-import-{ID}-0.tmp"))
                .exists());
        }
    }

    // ---- Material file move (素材详情 → 移动或重命名文件), step 3 ----
    use super::linux_material_move::{
        hold_parents, is_cross_device, move_held_no_replace, move_path_no_replace, PreparedMove,
    };

    fn material(root: &Path) -> (std::path::PathBuf, std::path::PathBuf) {
        let from = root.join("library").join("photos");
        let to = root.join("archive").join("2026");
        fs::create_dir_all(&from).unwrap();
        fs::create_dir_all(&to).unwrap();
        let source = from.join("synthetic-cover.png");
        fs::write(&source, b"synthetic material bytes").unwrap();
        (source, to.join("renamed-cover.png"))
    }

    #[test]
    fn material_move_on_one_filesystem_keeps_the_inode_and_bytes() {
        let root = temporary();
        let (source, destination) = material(root.path());
        let before = fs::metadata(&source).unwrap();
        let held = fs::File::open(&source).unwrap();
        move_held_no_replace(&held, &source, &destination).unwrap();
        assert!(!source.exists());
        let after = fs::metadata(&destination).unwrap();
        assert_eq!((before.dev(), before.ino()), (after.dev(), after.ino()));
        assert_eq!(after.mode(), before.mode());
        assert_eq!(fs::read(&destination).unwrap(), b"synthetic material bytes");
        // A pure rename inside one directory is the same primitive.
        let renamed = destination.with_file_name("cover-final.png");
        let held = fs::File::open(&destination).unwrap();
        move_held_no_replace(&held, &destination, &renamed).unwrap();
        assert_eq!(fs::metadata(&renamed).unwrap().ino(), before.ino());
    }

    #[test]
    fn material_move_never_replaces_an_existing_destination() {
        let root = temporary();
        let (source, destination) = material(root.path());
        fs::write(&destination, b"someone else's file").unwrap();
        let held = fs::File::open(&source).unwrap();
        let error = move_held_no_replace(&held, &source, &destination).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&source).unwrap(), b"synthetic material bytes");
        assert_eq!(fs::read(&destination).unwrap(), b"someone else's file");
        // A name that appears after the checks is still not replaced: the
        // kernel's RENAME_NOREPLACE refuses it.
        let late = destination.with_file_name("late.png");
        let prepared = PreparedMove::prepare(&held, &source, &late).unwrap();
        fs::write(&late, b"created concurrently").unwrap();
        let error = prepared.commit().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&source).unwrap(), b"synthetic material bytes");
        assert_eq!(fs::read(&late).unwrap(), b"created concurrently");
    }

    #[test]
    fn material_move_to_another_filesystem_is_refused_without_a_copy() {
        let root = temporary();
        let (source, _) = material(root.path());
        let inode = fs::metadata(&source).unwrap().ino();
        // /proc is always another filesystem and nothing can be created in it,
        // so even a broken refusal could not leave a copy behind.
        let other = Path::new("/proc").join("luckyray-synthetic-move.png");
        assert_ne!(fs::metadata("/proc").unwrap().dev(), fs::metadata(&source).unwrap().dev());
        let held = fs::File::open(&source).unwrap();
        let error = move_held_no_replace(&held, &source, &other).unwrap_err();
        assert!(is_cross_device(&error), "{error:?}");
        assert_eq!(error.to_string(), "attachment-move-cross-device");
        assert_eq!(fs::metadata(&source).unwrap().ino(), inode);
        assert_eq!(fs::read(&source).unwrap(), b"synthetic material bytes");
        assert!(!other.exists());
        // A kernel EXDEV (two mounts of one filesystem) is read the same way.
        assert!(is_cross_device(&io::Error::from_raw_os_error(libc::EXDEV)));
        assert!(!is_cross_device(&io::Error::from_raw_os_error(libc::EEXIST)));
    }

    #[test]
    fn failed_catalog_commit_moves_the_same_file_back() {
        // rename_asset_file_internal keeps `renamed_paths` and calls the path
        // form in the other direction when the SQLite update/commit fails.
        let root = temporary();
        let (source, destination) = material(root.path());
        let inode = fs::metadata(&source).unwrap().ino();
        let held = fs::File::open(&source).unwrap();
        move_held_no_replace(&held, &source, &destination).unwrap();
        move_path_no_replace(&destination, &source).unwrap();
        assert!(!destination.exists());
        assert_eq!(fs::metadata(&source).unwrap().ino(), inode);
        assert_eq!(fs::read(&source).unwrap(), b"synthetic material bytes");
        // If the original name was taken meanwhile, recovery refuses and keeps
        // both files; nothing is deleted to make room.
        move_held_no_replace(&held, &source, &destination).unwrap();
        fs::write(&source, b"new file at the old name").unwrap();
        let error = move_path_no_replace(&destination, &source).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&destination).unwrap(), b"synthetic material bytes");
        assert_eq!(fs::read(&source).unwrap(), b"new file at the old name");
    }

    #[test]
    fn replaced_or_linked_ancestor_is_refused_and_nothing_moves() {
        let root = temporary();
        let (source, destination) = material(root.path());
        let library = root.path().join("library");
        let held = fs::File::open(&source).unwrap();
        let prepared = PreparedMove::prepare(&held, &source, &destination).unwrap();
        // Swap an ancestor of the source for a look-alike after the checks.
        let aside = root.path().join("library-aside");
        fs::rename(&library, &aside).unwrap();
        fs::create_dir_all(library.join("photos")).unwrap();
        fs::write(&source, b"look-alike").unwrap();
        let error = prepared.commit().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(
            fs::read(aside.join("photos").join("synthetic-cover.png")).unwrap(),
            b"synthetic material bytes"
        );
        assert_eq!(fs::read(&source).unwrap(), b"look-alike");
        assert!(!destination.exists());
        // The same for the destination's ancestor.
        let moved = aside.join("photos").join("synthetic-cover.png");
        let held = fs::File::open(&moved).unwrap();
        let prepared = PreparedMove::prepare(&held, &moved, &destination).unwrap();
        let archive = root.path().join("archive");
        fs::rename(&archive, root.path().join("archive-aside")).unwrap();
        fs::create_dir_all(archive.join("2026")).unwrap();
        assert_eq!(prepared.commit().unwrap_err().kind(), io::ErrorKind::InvalidData);
        assert_eq!(fs::read(&moved).unwrap(), b"synthetic material bytes");
        assert!(!destination.exists());
        assert!(!root.path().join("archive-aside").join("2026").join("renamed-cover.png").exists());
        // A symlinked ancestor or a symlinked leaf is refused before anything.
        symlink(root.path().join("archive"), root.path().join("linked")).unwrap();
        let through_link = root.path().join("linked").join("2026").join("x.png");
        assert!(hold_parents(&moved, &through_link).is_err());
        assert!(move_held_no_replace(&held, &moved, &through_link).is_err());
        let leaf_link = aside.join("photos").join("leaf-link.png");
        symlink(&moved, &leaf_link).unwrap();
        assert!(move_held_no_replace(&held, &leaf_link, &destination).is_err());
        assert!(move_path_no_replace(&leaf_link, &destination).is_err());
        assert_eq!(fs::read(&moved).unwrap(), b"synthetic material bytes");
        assert!(!destination.exists());
    }

    #[test]
    fn a_held_source_must_still_be_the_named_object() {
        let root = temporary();
        let (source, destination) = material(root.path());
        let held = fs::File::open(&source).unwrap();
        // The name now denotes another inode: refuse, move nothing.
        fs::rename(&source, source.with_file_name("old.png")).unwrap();
        fs::write(&source, b"replacement").unwrap();
        assert_eq!(
            move_held_no_replace(&held, &source, &destination).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        // Access metadata changed after the checks: refuse at commit.
        let held = fs::File::open(&source).unwrap();
        let prepared = PreparedMove::prepare(&held, &source, &destination).unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(prepared.commit().unwrap_err().kind(), io::ErrorKind::InvalidData);
        assert_eq!(fs::read(&source).unwrap(), b"replacement");
        assert!(!destination.exists());
    }
}
