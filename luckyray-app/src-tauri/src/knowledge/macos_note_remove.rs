//! Remove a live path by retaining its actual inode beside a private intent.
//! No unlink or overwrite is performed. An interrupted/contested removal is
//! not success; its record and available objects remain for recovery.
use super::macos_attachment_io::Observation;
use super::macos_data_policy::{self as policy, Object, Remove, Seen};
use crate::macos_fs::{require_empty_acl, Directory, Version};
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Record {
    pub(super) version: u32,
    pub(super) nonce: String,
    pub(super) source: String,
    pub(super) relative: String,
    pub(super) root_object: (u64, u64),
    pub(super) parent_object: (u64, u64),
    pub(super) original: Object,
    pub(super) attachment: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) operation_id: Option<String>,
}
fn conflict() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "note-removal-needs-recovery")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Phase {
    BeforeIntent,
    IntentAttempted,
    PathMoved,
}
#[derive(Debug)]
pub(super) enum Failure {
    RevisionConflict,
    Io { phase: Phase, error: io::Error },
}

pub(super) fn seen(directory: &Directory, name: &OsStr, attachment: bool) -> io::Result<Seen> {
    directory.current()?;
    let read = if attachment {
        directory.read_attachment(name)
    } else {
        directory.read(name)
    };
    let result = match read {
        Ok(Some((_, version))) => Seen::Object(Object {
            device: version.device,
            inode: version.inode,
            hash: version.hash,
        }),
        Ok(None) => match directory.entry_info(name) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Seen::Missing,
            _ => Seen::Unavailable,
        },
        Err(_) => Seen::Unavailable,
    };
    directory.current()?;
    Ok(result)
}

pub(super) fn retain(
    root: &Directory,
    relative: &Path,
    expected_revision: &str,
    attachment: bool,
    operation_id: Option<&str>,
    expected_object: Option<&super::macos_attachment_io::Checkpoint>,
    mut validate: impl FnMut() -> io::Result<()>,
) -> Result<(), Failure> {
    let mut phase = Phase::BeforeIntent;
    let mut revision_conflict = false;
    let result = (|| -> io::Result<()> {
        if !super::macos_record_policy::data_path(relative.to_str().ok_or_else(conflict)?)
            || operation_id
                .is_some_and(|id| !super::macos_record_policy::record_name(&format!("{id}.json")))
        {
            return Err(conflict());
        }
        let observation = Observation::read_at(root, relative, attachment)?;
        if expected_object.is_some_and(|expected| expected != &observation.checkpoint()) {
            return Err(conflict());
        }
        if observation.revision() != expected_revision {
            revision_conflict = true;
            return Err(conflict());
        }
        let directory = observation.directory();
        let _lock = directory.lock(OsStr::new(".lrm-write.lock"))?;
        super::macos_transactions::recover_directory(directory).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "pending-write-needs-recovery")
        })?;
        observation.verify()?;
        let nonce = format!("{:032x}", rand::random::<u128>());
        let journal = format!(".lrk-remove-{nonce}.json");
        let backup = format!(".lrk-remove-{nonce}.backup");
        let parent_metadata = directory.identity_file()?.metadata()?;
        let root_metadata = root.identity_file()?.metadata()?;
        let record = Record {
            version: 1,
            nonce,
            source: observation.name().to_str().ok_or_else(conflict)?.into(),
            relative: relative.to_str().ok_or_else(conflict)?.into(),
            root_object: (root_metadata.dev(), root_metadata.ino()),
            parent_object: (parent_metadata.dev(), parent_metadata.ino()),
            original: observation.object(),
            attachment,
            operation_id: operation_id.map(str::to_owned),
        };
        let encoded = serde_json::to_vec(&record).map_err(|_| conflict())?;
        // A failed write can leave a partial intent; it still needs inspection.
        phase = Phase::IntentAttempted;
        let journal_file = directory.create(OsStr::new(&journal), &encoded)?;
        require_empty_acl(&journal_file)?;
        let (actual_record, journal_version) = directory
            .read_owned(OsStr::new(&journal))?
            .ok_or_else(conflict)?;
        if actual_record != encoded || !journal_version.matches_metadata(&journal_file.metadata()?)
        {
            return Err(conflict());
        }
        validate()?;
        root.current()?;
        observation.verify()?;
        let before = seen(directory, observation.name(), attachment)?;
        let retained = seen(directory, OsStr::new(&backup), attachment)?;
        if policy::removal(&record.original, &before, &retained) != Remove::RetainOriginal {
            return Err(conflict());
        }
        directory.rename(observation.name(), OsStr::new(&backup), false)?;
        phase = Phase::PathMoved;
        observation.verify_retained(OsStr::new(&backup))?;
        root.current()?;
        validate()?;
        let after = seen(directory, observation.name(), attachment)?;
        let retained = seen(directory, OsStr::new(&backup), attachment)?;
        if policy::removal(&record.original, &after, &retained) != Remove::Retained {
            return Err(conflict());
        }
        archive(directory, &journal, &journal_version)?;
        root.current()
    })();
    match result {
        Ok(()) => Ok(()),
        Err(_) if revision_conflict => Err(Failure::RevisionConflict),
        Err(error) => Err(Failure::Io { phase, error }),
    }
}

pub(super) struct Loaded {
    pub(super) record: Record,
    pub(super) version: Version,
}
pub(super) fn load(root: &Directory, directory: &Directory, name: &str) -> io::Result<Loaded> {
    use super::macos_record_policy as layout;
    let data = directory
        .read_owned(OsStr::new(name))?
        .ok_or_else(conflict)?;
    let record: Record = serde_json::from_slice(&data.0).map_err(|_| conflict())?;
    if record.version != 1
        || !layout::record_name(&format!("{}.json", record.nonce))
        || ![
            format!(".lrk-remove-{}.json", record.nonce),
            format!(".lrk-remove-{}.history", record.nonce),
        ]
        .contains(&name.to_owned())
        || !layout::data_path(&record.relative)
        || !layout::hash64(&record.original.hash)
        || record
            .operation_id
            .as_ref()
            .is_some_and(|id| !layout::record_name(&format!("{id}.json")))
    {
        return Err(conflict());
    }
    let (parent, leaf) =
        super::macos_attachment_io::parent_at(root, Path::new(&record.relative), false)?;
    let a = directory.identity_file()?.metadata()?;
    let b = parent.identity_file()?.metadata()?;
    let r = root.identity_file()?.metadata()?;
    if record.source != leaf.to_str().ok_or_else(conflict)?
        || record.root_object != (r.dev(), r.ino())
        || record.parent_object != (a.dev(), a.ino())
        || (a.dev(), a.ino()) != (b.dev(), b.ino())
    {
        return Err(conflict());
    }
    root.current()?;
    Ok(Loaded {
        record,
        version: data.1,
    })
}
pub(super) fn verified_retained(
    root: &Directory,
    relative: &Path,
    expected: &str,
    operation_id: &str,
    expected_object: &Object,
) -> io::Result<bool> {
    let (directory, name) = super::macos_attachment_io::parent_at(root, relative, false)?;
    for entry in directory.entries()? {
        let Some(entry) = entry.to_str().filter(|name| {
            name.starts_with(".lrk-remove-")
                && (name.ends_with(".json") || name.ends_with(".history"))
        }) else {
            continue;
        };
        let loaded = load(root, &directory, entry)?;
        let record = &loaded.record;
        if record.relative != relative.to_str().ok_or_else(conflict)?
            || record.original.hash != expected
            || record.operation_id.as_deref() != Some(operation_id)
        {
            continue;
        }
        if &record.original != expected_object {
            return Err(conflict());
        }
        let backup = format!(".lrk-remove-{}.backup", record.nonce);
        let backup_relative = relative.parent().unwrap_or(Path::new("")).join(&backup);
        let observed = match Observation::read_at(root, &backup_relative, record.attachment) {
            Ok(value) => value,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        if observed.object() != record.original {
            return Err(conflict());
        }
        if policy::removal(
            &record.original,
            &seen(&directory, &name, record.attachment)?,
            &Seen::Object(observed.object()),
        ) != Remove::Retained
        {
            return Err(conflict());
        }
        observed.verify()?;
        let current = directory
            .read_owned(OsStr::new(entry))?
            .ok_or_else(conflict)?;
        if current.1 != loaded.version {
            return Err(conflict());
        }
        root.current()?;
        return Ok(true);
    }
    root.current()?;
    Ok(false)
}

pub(super) fn archive(directory: &Directory, journal: &str, expected: &Version) -> io::Result<()> {
    let history = journal
        .strip_suffix(".json")
        .ok_or_else(conflict)?
        .to_owned()
        + ".history";
    let current = directory
        .read_owned(OsStr::new(journal))?
        .ok_or_else(conflict)?;
    if &current.1 != expected {
        return Err(conflict());
    }
    directory.rename(OsStr::new(journal), OsStr::new(&history), false)?;
    let archived = directory
        .read_owned(OsStr::new(&history))?
        .ok_or_else(conflict)?;
    if &archived.1 != expected {
        return Err(conflict());
    }
    Ok(())
}

/// Rollback restores the retained inode, including its existing permissions and
/// ACL. A payload with equal bytes is not authority to replace another object.
pub(super) fn restore_operation(
    root: &Directory,
    relative: &Path,
    expected: &str,
    operation_id: &str,
    expected_object: &Object,
    validate: impl FnMut() -> io::Result<()>,
) -> io::Result<super::macos_attachment_io::Checkpoint> {
    let (directory, name) = super::macos_attachment_io::parent_at(root, relative, false)?;
    let _lock = directory.lock(OsStr::new(".lrm-write.lock"))?;
    super::macos_transactions::recover_directory(&directory).map_err(|_| conflict())?;
    let mut selected = None;
    for entry in directory.entries()? {
        let Some(entry) = entry.to_str().filter(|name| {
            name.starts_with(".lrk-remove-")
                && (name.ends_with(".json") || name.ends_with(".history"))
        }) else {
            continue;
        };
        let loaded = load(root, &directory, entry)?;
        if loaded.record.relative != relative.to_str().ok_or_else(conflict)?
            || loaded.record.original.hash != expected
            || loaded.record.operation_id.as_deref() != Some(operation_id)
        {
            continue;
        }
        if &loaded.record.original != expected_object {
            return Err(conflict());
        }
        let backup = format!(".lrk-remove-{}.backup", loaded.record.nonce);
        let state = policy::restoration(
            &loaded.record.original,
            &seen(&directory, &name, loaded.record.attachment)?,
            &seen(&directory, OsStr::new(&backup), loaded.record.attachment)?,
        );
        if state != policy::Restore::RestoreOriginal {
            continue;
        }
        if selected.is_some() {
            return Err(conflict());
        }
        selected = Some((entry.to_owned(), loaded, backup));
    }
    let (entry, loaded, backup) = selected.ok_or_else(conflict)?;
    restore_loaded(
        root, &directory, relative, &entry, &loaded, &backup, validate,
    )
}

pub(super) fn restore_selected(
    root: &Directory,
    record_path: &Path,
    expected: &Version,
    validate: impl FnMut() -> io::Result<()>,
) -> io::Result<super::macos_attachment_io::Checkpoint> {
    let (directory, name) = super::macos_attachment_io::parent_at(root, record_path, false)?;
    let entry = name.to_str().ok_or_else(conflict)?;
    let _lock = directory.lock(OsStr::new(".lrm-write.lock"))?;
    super::macos_transactions::recover_directory(&directory).map_err(|_| conflict())?;
    let loaded = load(root, &directory, entry)?;
    if &loaded.version != expected {
        return Err(conflict());
    }
    let backup = format!(".lrk-remove-{}.backup", loaded.record.nonce);
    restore_loaded(
        root,
        &directory,
        Path::new(&loaded.record.relative),
        entry,
        &loaded,
        &backup,
        validate,
    )
}

fn restore_loaded(
    root: &Directory,
    directory: &Directory,
    relative: &Path,
    entry: &str,
    loaded: &Loaded,
    backup: &str,
    mut validate: impl FnMut() -> io::Result<()>,
) -> io::Result<super::macos_attachment_io::Checkpoint> {
    let name = relative.file_name().ok_or_else(conflict)?;
    let backup_relative = relative.parent().unwrap_or(Path::new("")).join(&backup);
    let observed = Observation::read_at(root, &backup_relative, loaded.record.attachment)?;
    if observed.object() != loaded.record.original {
        return Err(conflict());
    }
    validate()?;
    observed.verify()?;
    if directory
        .read_owned(OsStr::new(&entry))?
        .ok_or_else(conflict)?
        .1
        != loaded.version
        || policy::restoration(
            &loaded.record.original,
            &seen(&directory, &name, loaded.record.attachment)?,
            &Seen::Object(observed.object()),
        ) != policy::Restore::RestoreOriginal
    {
        return Err(conflict());
    }
    directory.rename(OsStr::new(&backup), &name, false)?;
    observed.verify_retained(&name)?;
    validate()?;
    if policy::restoration(
        &loaded.record.original,
        &seen(&directory, &name, loaded.record.attachment)?,
        &seen(&directory, OsStr::new(&backup), loaded.record.attachment)?,
    ) != policy::Restore::Restored
    {
        return Err(conflict());
    }
    if entry.ends_with(".json") {
        archive(&directory, &entry, &loaded.version)?;
    }
    root.current()?;
    observed.retained_checkpoint(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::OpenOptions;
    use std::io::{Seek, SeekFrom, Write};
    fn fixture() -> (tempfile::TempDir, std::path::PathBuf, Directory) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let directory = Directory::open(&root, false, false).unwrap();
        (temp, root, directory)
    }
    fn revision(bytes: &[u8]) -> String {
        crate::macos_fs::digest(bytes)
    }
    #[test]
    fn macos_note_remove_retains_the_original_inode_and_delayed_writer() {
        let (_temp, root, directory) = fixture();
        let path = root.join("note.md");
        std::fs::write(&path, b"original").unwrap();
        let mut writer = OpenOptions::new().write(true).open(&path).unwrap();
        let inode = writer.metadata().unwrap().ino();
        retain(
            &directory,
            Path::new("note.md"),
            &revision(b"original"),
            false,
            None,
            None,
            || Ok(()),
        )
        .unwrap();
        assert!(!path.exists());
        let backup = std::fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p.extension().is_some_and(|e| e == "backup"))
            .unwrap();
        assert_eq!(std::fs::metadata(&backup).unwrap().ino(), inode);
        writer.seek(SeekFrom::Start(0)).unwrap();
        writer.write_all(b"late update").unwrap();
        writer.set_len(11).unwrap();
        writer.sync_all().unwrap();
        assert_eq!(std::fs::read(&backup).unwrap(), b"late update");
        assert!(std::fs::read_dir(&root).unwrap().any(|e| e
            .unwrap()
            .path()
            .extension()
            .is_some_and(|e| e == "history")));
    }
    #[test]
    fn macos_note_remove_source_replacement_never_moves_the_new_object() {
        let (_temp, root, directory) = fixture();
        let path = root.join("note.md");
        std::fs::write(&path, b"original").unwrap();
        let result = retain(
            &directory,
            Path::new("note.md"),
            &revision(b"original"),
            false,
            None,
            None,
            || {
                std::fs::rename(&path, root.join("external-retained.md"))?;
                std::fs::write(&path, b"replacement")
            },
        );
        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"replacement");
        assert_eq!(
            std::fs::read(root.join("external-retained.md")).unwrap(),
            b"original"
        );
    }
    #[test]
    fn macos_note_remove_late_replacement_is_preserved_as_unconfirmed() {
        let (_temp, root, directory) = fixture();
        let path = root.join("note.md");
        std::fs::write(&path, b"original").unwrap();
        let replaced_path = path.clone();
        let held_original = root.join("outside-retained.md");
        let held_for_hook = held_original.clone();
        crate::macos_fs::set_before_rename_call_hook(Some(Box::new(move |from, _| {
            assert_eq!(from, OsStr::new("note.md"));
            std::fs::rename(&replaced_path, &held_for_hook).unwrap();
            std::fs::write(&replaced_path, b"replacement object").unwrap();
        })));
        let result = retain(&directory, Path::new("note.md"), &revision(b"original"), false, None, None, || Ok(()));
        crate::macos_fs::set_before_rename_call_hook(None);
        assert!(matches!(result, Err(Failure::Io { phase: Phase::PathMoved, .. })));
        assert!(!path.exists());
        assert_eq!(std::fs::read(&held_original).unwrap(), b"original");
        let entries = directory.entries().unwrap();
        let backup = entries.iter().find(|name| name.to_string_lossy().starts_with(".lrk-remove-")
            && name.to_string_lossy().ends_with(".backup")).unwrap();
        assert_eq!(std::fs::read(root.join(backup)).unwrap(), b"replacement object");
        assert!(entries.iter().any(|name| name.to_string_lossy().starts_with(".lrk-remove-")
            && name.to_string_lossy().ends_with(".json")));
        let snapshot = super::super::macos_note_recovery::snapshot(&directory).unwrap();
        assert!(snapshot.records.iter().any(|item| item.original_path == "note.md"
            && item.pending && !item.can_restore && item.unavailable_versions > 0));
        assert_eq!(std::fs::read(root.join(backup)).unwrap(), b"replacement object");
    }
    #[test]
    fn macos_note_remove_post_move_failure_remains_unconfirmed_with_both_evidence_objects() {
        let (_temp, root, directory) = fixture();
        std::fs::write(root.join("note.md"), b"original").unwrap();
        let mut count = 0;
        let result = retain(
            &directory,
            Path::new("note.md"),
            &revision(b"original"),
            false,
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            None,
            || {
                count += 1;
                if count == 2 {
                    return Err(io::ErrorKind::Interrupted.into());
                }
                Ok(())
            },
        );
        assert!(result.is_err());
        assert!(!root.join("note.md").exists());
        let entries = std::fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect::<Vec<_>>();
        let record = entries
            .iter()
            .find(|p| p.extension().is_some_and(|e| e == "json"))
            .unwrap();
        let record: Record = serde_json::from_slice(&std::fs::read(record).unwrap()).unwrap();
        let backup = format!(".lrk-remove-{}.backup", record.nonce);
        assert_eq!(std::fs::read(root.join(&backup)).unwrap(), b"original");
        assert_eq!(
            policy::removal(
                &record.original,
                &seen(&directory, OsStr::new("note.md"), false).unwrap(),
                &seen(&directory, OsStr::new(&backup), false).unwrap()
            ),
            Remove::Retained
        );
        assert!(!entries
            .iter()
            .any(|p| p.extension().is_some_and(|e| e == "history")));
    }
}
