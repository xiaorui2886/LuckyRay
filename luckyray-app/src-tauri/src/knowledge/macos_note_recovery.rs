//! Recovery only reads validated records and actual named objects. Exporting a
//! version creates a new private file; it does not complete or erase an intent.
use super::macos_attachment_io::{self as io, Observation};
use super::macos_note_remove;
use super::macos_record_policy as layout;
use super::note_recovery_types::{RecoveryIssue, RecoveryItem, RecoverySnapshot, RecoveryVersion};
use crate::macos_fs::{digest, Directory, Version};
use std::ffi::OsStr;
use std::io as stdio;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

struct Inspected {
    item: RecoveryItem,
    record_version: Version,
    versions: Vec<(String, Observation)>,
}
fn conflict() -> stdio::Error {
    stdio::Error::new(stdio::ErrorKind::InvalidData, "note-recovery-conflict")
}
fn record_path(value: &str) -> stdio::Result<&Path> {
    let path = Path::new(value);
    let parent = path.parent().unwrap_or(Path::new(""));
    if !parent.as_os_str().is_empty() && !layout::data_path(parent.to_str().ok_or_else(conflict)?) {
        return Err(conflict());
    }
    let name = path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(conflict)?;
    if !((name.starts_with(".lrm-") && (name.ends_with(".journal") || name.ends_with(".history")))
        || (name.starts_with(".lrk-remove-")
            && (name.ends_with(".json") || name.ends_with(".history"))))
    {
        return Err(conflict());
    }
    Ok(path)
}
fn inspect(root: &Directory, relative: &str) -> stdio::Result<Inspected> {
    let path = record_path(relative)?;
    let parent = path.parent().unwrap_or(Path::new(""));
    let (directory, name) = io::parent_at(root, path, false)?;
    let name = name.to_str().ok_or_else(conflict)?;
    let pending = name.ends_with(".journal") || name.ends_with(".json");
    let mut versions = Vec::new();
    let mut unavailable = 0usize;
    let mut add = |slot: &str,
                   leaf: &str,
                   attachment: bool,
                   allowed: &[(String, Option<(u64, u64)>)],
                   strict: bool|
     -> stdio::Result<()> {
        match Observation::read_at(root, &parent.join(leaf), attachment) {
            Ok(observed) => {
                let object = observed.object();
                // Delayed writes at the known retained inode can be explicitly
                // copied to a new file. They never authorize normal completion
                // or restoring the original path against the recorded digest.
                if allowed.iter().any(|(hash, id)| match id {
                    Some(id) => *id == (object.device, object.inode),
                    None => hash == &object.hash,
                }) {
                    observed.verify()?;
                    versions.push((slot.to_owned(), observed));
                } else {
                    unavailable += 1;
                }
            }
            Err(error) if error.kind() == stdio::ErrorKind::NotFound => {}
            Err(error) => {
                if strict && error.kind() == stdio::ErrorKind::Interrupted {
                    return Err(error);
                }
                unavailable += 1;
            }
        }
        Ok(())
    };
    let (record_version, original, kind, can_restore, recorded_hashes) = if name
        .starts_with(".lrk-remove-")
    {
        let loaded = macos_note_remove::load(root, &directory, name)?;
        let record = &loaded.record;
        let expected = vec![(
            record.original.hash.clone(),
            Some((record.original.device, record.original.inode)),
        )];
        let backup = format!(".lrk-remove-{}.backup", record.nonce);
        add("retained", &backup, record.attachment, &expected, true)?;
        // A replacement at the old path is displayed as unavailable, never
        // silently chosen as the removed version.
        add(
            "current",
            &record.source,
            record.attachment,
            &expected,
            true,
        )?;
        let restore = super::macos_data_policy::restoration(
            &record.original,
            &macos_note_remove::seen(&directory, OsStr::new(&record.source), record.attachment)?,
            &macos_note_remove::seen(&directory, OsStr::new(&backup), record.attachment)?,
        ) == super::macos_data_policy::Restore::RestoreOriginal;
        (
            loaded.version,
            record.relative.clone(),
            "removal",
            restore,
            expected
                .into_iter()
                .map(|(hash, _)| hash)
                .collect::<Vec<_>>(),
        )
    } else {
        let record =
            super::macos_transactions::inspect_record(&directory, name).map_err(|_| conflict())?;
        let mut allowed = vec![(record.after.clone(), record.next_object)];
        if let Some(before) = &record.before {
            allowed.push((before.clone(), record.before_object));
        }
        add("current", &record.target, false, &allowed, false)?;
        add("retained", &record.backup, false, &allowed, false)?;
        (
            record.version,
            parent
                .join(&record.target)
                .to_str()
                .ok_or_else(conflict)?
                .to_owned(),
            "write",
            false,
            allowed
                .into_iter()
                .map(|(hash, _)| hash)
                .collect::<Vec<_>>(),
        )
    };
    let root_meta = root.identity_file()?.metadata()?;
    let parent_meta = directory.identity_file()?.metadata()?;
    let checkpoints = versions
        .iter()
        .map(|(slot, observed)| format!("{slot}:{:?}", observed.checkpoint()))
        .collect::<Vec<_>>();
    let token=digest(format!("macos-note-recovery-v1:{relative}:{}:{}:{}:{}:{record_version:?}:{checkpoints:?}:{can_restore}:{unavailable}",
        root_meta.dev(),root_meta.ino(),parent_meta.dev(),parent_meta.ino()).as_bytes());
    let public = versions
        .iter()
        .map(|(slot, observed)| RecoveryVersion {
            slot: slot.clone(),
            revision: observed.revision().into(),
            bytes: observed.bytes.len() as u64,
            changed_since_record: !recorded_hashes
                .iter()
                .any(|hash| hash == observed.revision()),
            preview: if original.to_ascii_lowercase().ends_with(".md") {
                std::str::from_utf8(&observed.bytes)
                    .ok()
                    .map(|value| value.chars().take(4096).collect())
            } else {
                None
            },
        })
        .collect();
    if directory
        .read_owned(OsStr::new(name))?
        .ok_or_else(conflict)?
        .1
        != record_version
    {
        return Err(conflict());
    }
    for (_, observed) in &versions {
        observed.verify()?;
    }
    root.current()?;
    Ok(Inspected {
        item: RecoveryItem {
            record_path: relative.into(),
            original_path: original,
            kind: kind.into(),
            pending,
            token,
            can_restore,
            versions: public,
            unavailable_versions: unavailable,
        },
        record_version,
        versions,
    })
}

pub(super) fn snapshot(root: &Directory) -> stdio::Result<RecoverySnapshot> {
    let mut result = RecoverySnapshot {
        supported: true,
        startup_blocked: false,
        records: Vec::new(),
        issues: Vec::new(),
        scan_incomplete: false,
    };
    // Keep paths, not one descriptor per sibling directory. Every visit opens
    // afresh relative to the retained root; actions independently revalidate.
    let mut pending = vec![PathBuf::new()];
    let mut visited = 0usize;
    while let Some(parent) = pending.pop() {
        visited += 1;
        if visited > 100_000 || result.records.len() + result.issues.len() >= 256 {
            result.scan_incomplete = true;
            break;
        }
        let directory = if parent.as_os_str().is_empty() {
            root.try_clone()?
        } else {
            io::parent_at(root, &parent.join("__recovery_scan__"), false)?.0
        };
        for name in directory.entries()? {
            let Some(leaf) = name.to_str() else {
                continue;
            };
            let relative = parent.join(leaf);
            let Some(value) = relative.to_str() else {
                continue;
            };
            if record_path(value).is_ok() {
                if result.records.len() + result.issues.len() >= 256 {
                    result.scan_incomplete = true;
                    break;
                }
                match inspect(root, value) {
                    Ok(item) => result.records.push(item.item),
                    Err(_) => result.issues.push(RecoveryIssue {
                        record_path: value.into(),
                        code: "record-or-version-unavailable".into(),
                    }),
                }
            } else if layout::data_path(value) {
                let info = match directory.entry_info(&name) {
                    Ok(info) => info,
                    Err(error) if error.kind() == stdio::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error),
                };
                if info.mode & u32::from(libc::S_IFMT) == u32::from(libc::S_IFDIR) {
                    pending.push(relative);
                }
            }
        }
        directory.current()?;
    }
    root.current()?;
    result
        .records
        .sort_by(|a, b| a.record_path.cmp(&b.record_path));
    Ok(result)
}

pub(super) fn copy_version(
    root: &Directory,
    record: &str,
    token: &str,
    slot: &str,
    destination: &str,
    mut validate: impl FnMut() -> stdio::Result<()>,
) -> stdio::Result<()> {
    if !layout::data_path(destination) || !layout::hash64(token) {
        return Err(conflict());
    }
    let inspected = inspect(root, record)?;
    if inspected.item.token != token {
        return Err(conflict());
    }
    if Path::new(destination).parent() != Path::new(&inspected.item.original_path).parent() {
        // Preserve the authored relative-attachment context. This endpoint is
        // a new-name recovery copy, not the note-move/link-rewrite operation.
        return Err(conflict());
    }
    let observed = &inspected
        .versions
        .iter()
        .find(|(name, _)| name == slot)
        .ok_or_else(conflict)?
        .1;
    if inspected
        .item
        .original_path
        .to_ascii_lowercase()
        .ends_with(".md")
        != destination.to_ascii_lowercase().ends_with(".md")
    {
        return Err(conflict());
    }
    validate()?;
    observed.verify()?;
    let (directory, name) = io::parent_at(root, record_path(record)?, false)?;
    if directory.read_owned(&name)?.ok_or_else(conflict)?.1 != inspected.record_version {
        return Err(conflict());
    }
    // New names only. Recovery never grants access to a mode-000 inode,
    // overwrites a current note, archives its intent, or deletes a copy.
    let published = io::copy_recovery_at(
        root,
        Path::new(destination),
        &observed.bytes,
        !destination.to_ascii_lowercase().ends_with(".md"),
        &directory,
    )?;
    validate()?;
    observed.verify()?;
    let copied = Observation::read_at(
        root,
        Path::new(destination),
        !destination.to_ascii_lowercase().ends_with(".md"),
    )?;
    if copied.checkpoint() != published
        || copied.revision() != observed.revision()
        || directory.read_owned(&name)?.ok_or_else(conflict)?.1 != inspected.record_version
    {
        return Err(conflict());
    }
    copied.verify()?;
    root.current()
}

pub(super) fn restore(
    root: &Directory,
    record: &str,
    token: &str,
    validate: impl FnMut() -> stdio::Result<()>,
) -> stdio::Result<String> {
    let inspected = inspect(root, record)?;
    if inspected.item.token != token
        || !inspected.item.can_restore
        || inspected.item.kind != "removal"
    {
        return Err(conflict());
    }
    macos_note_remove::restore_selected(
        root,
        record_path(record)?,
        &inspected.record_version,
        validate,
    )?;
    Ok(inspected.item.original_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    fn fixture() -> (tempfile::TempDir, PathBuf, Directory) {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().canonicalize().unwrap();
        let root = Directory::open(&path, false, false).unwrap();
        (temp, path, root)
    }
    #[test]
    fn macos_note_recovery_copies_without_clobbering_then_restores_the_original_inode() {
        let (_temp, path, root) = fixture();
        std::fs::write(path.join("note.md"), b"retained note").unwrap();
        let before = std::fs::metadata(path.join("note.md")).unwrap().ino();
        macos_note_remove::retain(
            &root,
            Path::new("note.md"),
            &digest(b"retained note"),
            false,
            None,
            None,
            || Ok(()),
        )
        .unwrap();
        let item = snapshot(&root).unwrap().records.remove(0);
        assert!(item.can_restore);
        assert!(!item.pending);
        root.child(OsStr::new("other"), true).unwrap();
        assert!(copy_version(
            &root,
            &item.record_path,
            &item.token,
            "retained",
            "other/Copy.md",
            || Ok(())
        )
        .is_err());
        assert!(!path.join("other/Copy.md").exists());
        std::fs::write(path.join("occupied.md"), b"user content").unwrap();
        assert!(copy_version(
            &root,
            &item.record_path,
            &item.token,
            "retained",
            "occupied.md",
            || Ok(())
        )
        .is_err());
        assert_eq!(
            std::fs::read(path.join("occupied.md")).unwrap(),
            b"user content"
        );
        copy_version(
            &root,
            &item.record_path,
            &item.token,
            "retained",
            "recovered.md",
            || Ok(()),
        )
        .unwrap();
        assert_eq!(
            std::fs::read(path.join("recovered.md")).unwrap(),
            b"retained note"
        );
        assert!(path.join(&item.record_path).is_file());
        assert!(!path.join("note.md").exists());
        restore(&root, &item.record_path, &item.token, || Ok(())).unwrap();
        assert_eq!(
            std::fs::metadata(path.join("note.md")).unwrap().ino(),
            before
        );
        assert_eq!(
            std::fs::read(path.join("note.md")).unwrap(),
            b"retained note"
        );
        assert!(restore(&root, &item.record_path, &item.token, || Ok(())).is_err());
        // An editor's later write to the retained original must remain usable
        // for explicit copying, while normal restore stays digest-bound.
        macos_note_remove::retain(
            &root,
            Path::new("note.md"),
            &digest(b"retained note"),
            false,
            None,
            None,
            || Ok(()),
        )
        .unwrap();
        let updated = snapshot(&root)
            .unwrap()
            .records
            .into_iter()
            .find(|item| item.can_restore)
            .unwrap();
        let loaded = macos_note_remove::load(
            &root,
            &root,
            Path::new(&updated.record_path)
                .file_name()
                .unwrap()
                .to_str()
                .unwrap(),
        )
        .unwrap();
        std::fs::write(
            path.join(format!(".lrk-remove-{}.backup", loaded.record.nonce)),
            b"late content",
        )
        .unwrap();
        let late = snapshot(&root)
            .unwrap()
            .records
            .into_iter()
            .find(|item| {
                item.versions
                    .iter()
                    .any(|version| version.revision == digest(b"late content"))
            })
            .unwrap();
        assert!(!late.can_restore);
        assert!(late
            .versions
            .iter()
            .any(|version| version.changed_since_record));
        copy_version(
            &root,
            &late.record_path,
            &late.token,
            "retained",
            "Late.md",
            || Ok(()),
        )
        .unwrap();
        assert_eq!(
            std::fs::read(path.join("Late.md")).unwrap(),
            b"late content"
        );
    }
    #[test]
    fn macos_note_recovery_rejects_equal_bytes_at_a_replaced_inode_and_retains_pending_permissions()
    {
        let (_temp, path, root) = fixture();
        std::fs::write(path.join("note.md"), b"original").unwrap();
        let original = std::fs::metadata(path.join("note.md")).unwrap();
        let nonce = "d".repeat(32);
        let backup = format!(".lrm-{nonce}.backup");
        let journal = format!(".lrm-{nonce}.journal");
        std::fs::rename(path.join("note.md"), path.join(&backup)).unwrap();
        std::fs::write(path.join("note.md"), b"next").unwrap();
        let next = std::fs::metadata(path.join("note.md")).unwrap();
        let encoded=serde_json::to_vec(&serde_json::json!({"version":1,"nonce":nonce,"target":"note.md",
            "before":digest(b"original"),"after":digest(b"next"),"before_object":[original.dev(),original.ino()],"next_object":[next.dev(),next.ino()]})).unwrap();
        root.create(OsStr::new(&journal), &encoded).unwrap();
        std::fs::set_permissions(path.join("note.md"), std::fs::Permissions::from_mode(0)).unwrap();
        let item = snapshot(&root).unwrap().records.remove(0);
        assert!(item.pending);
        assert!(!item.can_restore);
        copy_version(
            &root,
            &item.record_path,
            &item.token,
            "retained",
            "copy.md",
            || Ok(()),
        )
        .unwrap();
        assert_eq!(std::fs::read(path.join("copy.md")).unwrap(), b"original");
        assert_eq!(
            std::fs::metadata(path.join("note.md")).unwrap().mode() & 0o777,
            0
        );
        assert!(path.join(&journal).is_file());
        assert!(path.join(&backup).is_file());
        let retained_metadata = std::fs::metadata(path.join(&backup)).unwrap();
        std::fs::rename(path.join(&backup), path.join("original-held")).unwrap();
        let mut replacement = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(retained_metadata.mode() & 0o777)
            .open(path.join(&backup))
            .unwrap();
        replacement.write_all(b"original").unwrap();
        replacement.sync_all().unwrap();
        let replacement_metadata = replacement.metadata().unwrap();
        assert_eq!(replacement_metadata.mode() & 0o777, retained_metadata.mode() & 0o777);
        assert_eq!(replacement_metadata.nlink(), 1);
        assert_ne!((replacement_metadata.dev(), replacement_metadata.ino()),
            (retained_metadata.dev(), retained_metadata.ino()));
        assert!(copy_version(
            &root,
            &item.record_path,
            &item.token,
            "retained",
            "unexpected.md",
            || Ok(())
        )
        .is_err());
        assert!(!path.join("unexpected.md").exists());
        assert!(path.join("original-held").is_file());
        // Restore fixture access only after all production assertions.
        std::fs::set_permissions(path.join("note.md"), std::fs::Permissions::from_mode(0o600))
            .unwrap();
    }
}
