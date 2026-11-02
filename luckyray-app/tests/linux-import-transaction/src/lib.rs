// Compile and exercise the actual production filesystem implementation without Tauri.
#![cfg(target_os = "linux")]
#![allow(dead_code)]
#[path = "../../../src-tauri/src/linux_attachment_store.rs"]
mod linux_attachment_store;
#[path = "../../../src-tauri/src/linux_fs.rs"]
mod linux_fs;

#[cfg(test)]
mod tests {
    use super::linux_attachment_store::{Dependency, ImportStore};
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::io;
    use std::os::unix::fs::{symlink, PermissionsExt};
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
}
