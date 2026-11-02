//! macOS attachment observations and new-name publication. These are optimistic
//! object/revision checks, not Windows mandatory writer exclusion. A conflict
//! preserves all named objects; this module never unlinks a staging or user file.
use crate::macos_fs::{require_empty_acl, Directory, Version};
use std::ffi::{OsStr, OsString};
use std::fs::{File, Metadata};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path};

fn conflict() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "attachment-object-changed")
}
fn stamp(meta: &Metadata) -> (u64, u64, u64, u32, u32, u32, i64, i64, i64, i64) {
    (
        meta.dev(),
        meta.ino(),
        meta.nlink(),
        meta.uid(),
        meta.gid(),
        meta.mode(),
        meta.mtime(),
        meta.mtime_nsec(),
        meta.ctime(),
        meta.ctime_nsec(),
    )
}

pub(super) struct Observation {
    root: Directory,
    directory: Directory,
    name: OsString,
    file: File,
    metadata: Metadata,
    version: Version,
    attachment: bool,
    pub(super) bytes: Vec<u8>,
}
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Checkpoint {
    pub(super) object: super::macos_data_policy::Object,
    attributes: (u64, u64, u64, u32, u32, u32, i64, i64, i64, i64),
    size: u64,
}
impl Checkpoint {
    pub(super) fn matches_metadata(&self, metadata: &Metadata) -> bool {
        self.attributes == stamp(metadata) && self.size == metadata.len()
    }
}
impl Observation {
    pub(super) fn read(path: &Path, attachment: bool) -> io::Result<Self> {
        let directory = Directory::open(path.parent().ok_or_else(conflict)?, false, false)?;
        let name = path.file_name().ok_or_else(conflict)?.to_owned();
        Self::read_from(directory.try_clone()?, directory, name, attachment, None)?
            .ok_or_else(conflict)
    }
    pub(super) fn read_at(root: &Directory, relative: &Path, attachment: bool) -> io::Result<Self> {
        Self::read_at_sized(root, relative, attachment, None)?.ok_or_else(conflict)
    }
    pub(super) fn read_matching_at(
        root: &Directory,
        relative: &Path,
        size: u64,
    ) -> io::Result<Option<Self>> {
        Self::read_at_sized(root, relative, true, Some(size))
    }
    fn read_at_sized(
        root: &Directory,
        relative: &Path,
        attachment: bool,
        expected_size: Option<u64>,
    ) -> io::Result<Option<Self>> {
        let (directory, name) = parent_at(root, relative, false)?;
        Self::read_from(
            root.try_clone()?,
            directory,
            name,
            attachment,
            expected_size,
        )
    }
    fn read_from(
        root: Directory,
        directory: Directory,
        name: OsString,
        attachment: bool,
        expected_size: Option<u64>,
    ) -> io::Result<Option<Self>> {
        root.current()?;
        let file = directory.open_regular(&name)?;
        let before = file.metadata()?;
        if expected_size.is_some_and(|size| size != before.len()) {
            return Ok(None);
        }
        if !before.is_file() || before.nlink() != 1 {
            return Err(conflict());
        }
        let limit = if attachment {
            crate::macos_fs::MAX_ATTACHMENT_BLOB
        } else {
            crate::macos_fs::MAX_RECORD
        };
        if before.len() > limit {
            return Err(io::ErrorKind::FileTooLarge.into());
        }
        let (bytes, version) = if attachment {
            directory.read_attachment(&name)?
        } else {
            directory.read(&name)?
        }
        .ok_or_else(conflict)?;
        let metadata = file.metadata()?;
        if stamp(&before) != stamp(&metadata) || !version.matches_metadata(&metadata) {
            return Err(conflict());
        }
        let result = Self {
            root,
            directory,
            name,
            file,
            metadata,
            version,
            attachment,
            bytes,
        };
        result.verify_object()?;
        Ok(Some(result))
    }
    fn verify_object(&self) -> io::Result<()> {
        self.root.current()?;
        self.directory.current()?;
        let held = self.file.metadata()?;
        let named = self.directory.open_metadata(&self.name)?.metadata()?;
        if !held.is_file()
            || held.nlink() != 1
            || stamp(&held) != stamp(&self.metadata)
            || stamp(&named) != stamp(&held)
            || !self.version.matches_metadata(&held)
        {
            return Err(conflict());
        }
        Ok(())
    }
    pub(super) fn verify(&self) -> io::Result<()> {
        self.verify_object()?;
        let current = if self.attachment {
            self.directory.read_attachment(&self.name)?
        } else {
            self.directory.read(&self.name)?
        }
        .ok_or_else(conflict)?;
        if current.1 != self.version {
            return Err(conflict());
        }
        self.verify_object()
    }
    pub(super) fn revision(&self) -> &str {
        &self.version.hash
    }
    pub(super) fn object(&self) -> super::macos_data_policy::Object {
        super::macos_data_policy::Object {
            device: self.version.device,
            inode: self.version.inode,
            hash: self.version.hash.clone(),
        }
    }
    pub(super) fn checkpoint(&self) -> Checkpoint {
        Checkpoint {
            object: self.object(),
            attributes: stamp(&self.metadata),
            size: self.metadata.len(),
        }
    }
    pub(super) fn retained_checkpoint(&self, name: &OsStr) -> io::Result<Checkpoint> {
        self.verify_retained(name)?;
        let checkpoint = checkpoint_held(&self.directory, name, &self.file, self.attachment)?;
        self.verify_retained(name)?;
        if !checkpoint.matches_metadata(&self.file.metadata()?) {
            return Err(conflict());
        }
        Ok(checkpoint)
    }
    pub(super) fn directory(&self) -> &Directory {
        &self.directory
    }
    pub(super) fn version(&self) -> &Version {
        &self.version
    }
    pub(super) fn name(&self) -> &OsStr {
        &self.name
    }
    pub(super) fn metadata(&self) -> &Metadata {
        &self.metadata
    }
    /// A successful same-directory rename preserves the original inode and
    /// its ACL. ctime may change because of our rename; bytes/mode/owner and
    /// the held/named object must still agree. Never grant permissions here.
    pub(super) fn verify_retained(&self, name: &OsStr) -> io::Result<()> {
        self.root.current()?;
        let held = self.file.metadata()?;
        let named = self.directory.open_metadata(name)?.metadata()?;
        if held.nlink() != 1
            || held.uid() != self.metadata.uid()
            || held.gid() != self.metadata.gid()
            || !self.version.matches_metadata(&held)
            || !self.version.matches_metadata(&named)
            || (held.uid(), held.gid(), held.nlink()) != (named.uid(), named.gid(), named.nlink())
        {
            return Err(conflict());
        }
        let current = if self.attachment {
            self.directory.read_attachment(name)?
        } else {
            self.directory.read(name)?
        }
        .ok_or_else(conflict)?;
        if current.1 != self.version {
            return Err(conflict());
        }
        self.root.current()
    }
    /// canonicalize supplies spelling only. It grants no new file authority:
    /// the canonical no-follow handle must still be this exact held object.
    pub(super) fn verify_alias(&self, canonical: &Path) -> io::Result<()> {
        let directory = Directory::open(canonical.parent().ok_or_else(conflict)?, false, false)?;
        let file = directory.open_regular(canonical.file_name().ok_or_else(conflict)?)?;
        if stamp(&file.metadata()?) != stamp(&self.metadata) {
            return Err(conflict());
        }
        directory.current()?;
        self.verify()
    }
    pub(super) fn into_guards(self) -> io::Result<(File, Vec<File>)> {
        self.verify()?;
        let parent = self.directory.identity_file()?;
        let root = self.root.identity_file()?;
        Ok((self.file, vec![parent, root]))
    }
}

pub(super) fn parent_at(
    root: &Directory,
    relative: &Path,
    create: bool,
) -> io::Result<(Directory, OsString)> {
    if relative
        .as_os_str()
        .as_bytes()
        .split(|b| *b == b'/')
        .any(|part| part.is_empty() || part == b"." || part == b"..")
    {
        return Err(conflict());
    }
    let mut directory = root.try_clone()?;
    let mut components = relative.components().peekable();
    let name = loop {
        let Some(Component::Normal(part)) = components.next() else {
            return Err(conflict());
        };
        if components.peek().is_none() {
            break part.to_owned();
        }
        directory = directory.child(part, create)?;
    };
    root.current()?;
    Ok((directory, name))
}

fn verify_created(
    dir: &Directory,
    name: &OsStr,
    file: &File,
    expected: &Version,
    gid: u32,
) -> io::Result<()> {
    dir.current()?;
    let held = file.metadata()?;
    let named = dir.entry_info(name)?;
    if !held.is_file()
        || held.nlink() != 1
        || held.uid() != unsafe { libc::geteuid() }
        || held.gid() != gid
        || held.mode() & 0o7777 != 0o600
        || !expected.matches_metadata(&held)
        || (named.device, named.inode, named.mode) != (held.dev(), held.ino(), held.mode())
    {
        return Err(conflict());
    }
    require_empty_acl(file)
}

pub(super) fn publish(
    root: &Directory,
    names: impl IntoIterator<Item = OsString>,
    bytes: &[u8],
) -> io::Result<OsString> {
    publish_before_rename(root, names, bytes, |_, _| Ok(()))
}

fn publish_before_rename(
    root: &Directory,
    names: impl IntoIterator<Item = OsString>,
    bytes: &[u8],
    before: impl FnOnce(&Directory, &OsStr) -> io::Result<()>,
) -> io::Result<OsString> {
    let directory = root.child(OsStr::new("attachments"), true)?;
    publish_in(root, &directory, names, bytes, true, before).map(|published| published.name)
}

pub(super) fn create_at(
    root: &Directory,
    relative: &Path,
    bytes: &[u8],
    attachment: bool,
) -> io::Result<Checkpoint> {
    if !super::macos_record_policy::data_path(relative.to_str().ok_or_else(conflict)?) {
        return Err(conflict());
    }
    let (directory, name) = parent_at(root, relative, true)?;
    let _lock = directory.lock(OsStr::new(".lrm-write.lock"))?;
    super::macos_transactions::recover_directory(&directory).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "pending-write-needs-recovery",
        )
    })?;
    let published = publish_in(root, &directory, [name], bytes, attachment, |_, _| Ok(()))?;
    Ok(published.checkpoint)
}

/// Repair creates a separate new name only. Its caller must already have
/// verified the selected recovery record/version; pending originals remain
/// untouched and no permission is granted to an unreadable inode.
pub(super) fn copy_recovery_at(
    root: &Directory,
    relative: &Path,
    bytes: &[u8],
    attachment: bool,
    expected_parent: &Directory,
) -> io::Result<Checkpoint> {
    if !super::macos_record_policy::data_path(relative.to_str().ok_or_else(conflict)?) {
        return Err(conflict());
    }
    let (directory, name) = parent_at(root, relative, false)?;
    let expected = expected_parent.identity_file()?.metadata()?;
    let actual = directory.identity_file()?.metadata()?;
    expected_parent.current()?;
    if (expected.dev(), expected.ino()) != (actual.dev(), actual.ino()) {
        return Err(conflict());
    }
    let _lock = directory.lock(OsStr::new(".lrm-write.lock"))?;
    publish_in(root, &directory, [name], bytes, attachment, |_, _| Ok(()))
        .map(|published| published.checkpoint)
}

fn publish_in(
    parent: &Directory,
    directory: &Directory,
    names: impl IntoIterator<Item = OsString>,
    bytes: &[u8],
    attachment: bool,
    before: impl FnOnce(&Directory, &OsStr) -> io::Result<()>,
) -> io::Result<Published> {
    let temporary = OsString::from(format!(
        ".lrk-attachment-{:032x}.pending",
        rand::random::<u128>()
    ));
    let file = if attachment {
        directory.create_attachment(&temporary, bytes)?
    } else {
        directory.create(&temporary, bytes)?
    };
    let (staged, version) = if attachment {
        directory.read_attachment(&temporary)?
    } else {
        directory.read(&temporary)?
    }
    .ok_or_else(conflict)?;
    if staged != bytes {
        return Err(conflict());
    }
    drop(staged);
    let gid = file.metadata()?.gid();
    verify_created(&directory, &temporary, &file, &version, gid)?;
    before(&directory, &temporary)?;
    for name in names {
        parent.current()?;
        verify_created(&directory, &temporary, &file, &version, gid)?;
        match directory.rename(&temporary, &name, false) {
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            other => other?,
        }
        // rename may move a leaf link without following it. Never trust the
        // flag alone; the final name must be the original descriptor's inode.
        verify_created(&directory, &name, &file, &version, gid)?;
        let published = if attachment {
            directory.read_attachment(&name)?
        } else {
            directory.read(&name)?
        }
        .ok_or_else(conflict)?;
        if published.1 != version || published.0 != bytes {
            return Err(conflict());
        }
        parent.current()?;
        let checkpoint = checkpoint_held(directory, &name, &file, attachment)?;
        verify_created(directory, &name, &file, &version, gid)?;
        if !checkpoint.matches_metadata(&file.metadata()?) {
            return Err(conflict());
        }
        return Ok(Published { name, checkpoint });
    }
    Err(io::ErrorKind::AlreadyExists.into())
}

struct Published {
    name: OsString,
    checkpoint: Checkpoint,
}
/// Return a binding from the primitive's retained descriptor, never from a
/// newly observed equal-content file at the destination pathname.
pub(super) fn checkpoint_held(
    directory: &Directory,
    name: &OsStr,
    file: &File,
    attachment: bool,
) -> io::Result<Checkpoint> {
    directory.current()?;
    let before = file.metadata()?;
    let (_, version) = if attachment {
        directory.read_attachment(name)?
    } else {
        directory.read(name)?
    }
    .ok_or_else(conflict)?;
    let after = file.metadata()?;
    if !after.is_file()
        || after.nlink() != 1
        || stamp(&before) != stamp(&after)
        || !version.matches_metadata(&after)
    {
        return Err(conflict());
    }
    directory.current()?;
    Ok(Checkpoint {
        object: super::macos_data_policy::Object {
            device: version.device,
            inode: version.inode,
            hash: version.hash,
        },
        attributes: stamp(&after),
        size: after.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        (temp, root)
    }
    #[test]
    fn macos_attachment_new_name_preserves_conflict_and_allows_normal_directory_mode() {
        let (_temp, root) = fixture();
        std::fs::create_dir(root.join("attachments")).unwrap();
        std::fs::set_permissions(
            root.join("attachments"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        std::fs::write(root.join("attachments/image.png"), b"external original").unwrap();
        let directory = Directory::open(&root, false, false).unwrap();
        let name = publish(
            &directory,
            ["image.png".into(), "image (2).png".into()],
            b"actual attachment",
        )
        .unwrap();
        assert_eq!(name, OsStr::new("image (2).png"));
        assert_eq!(
            std::fs::read(root.join("attachments/image.png")).unwrap(),
            b"external original"
        );
        assert_eq!(
            std::fs::read(root.join("attachments").join(name)).unwrap(),
            b"actual attachment"
        );
        assert_eq!(
            std::fs::metadata(root.join("attachments")).unwrap().mode() & 0o777,
            0o755
        );
        assert_eq!(
            std::fs::metadata(root.join("attachments/image (2).png"))
                .unwrap()
                .mode()
                & 0o777,
            0o600
        );
    }
    #[test]
    fn macos_attachment_observation_detects_same_bytes_replacement_and_source_links() {
        let (_temp, root) = fixture();
        let path = root.join("note.md");
        std::fs::write(&path, b"unchanged bytes").unwrap();
        let observed = Observation::read(&path, false).unwrap();
        std::fs::rename(&path, root.join("retained.md")).unwrap();
        std::fs::write(&path, b"unchanged bytes").unwrap();
        assert!(observed.verify().is_err());
        symlink(root.join("retained.md"), root.join("linked.md")).unwrap();
        assert!(Observation::read(&root.join("linked.md"), false).is_err());
        std::fs::hard_link(&path, root.join("alias.md")).unwrap();
        assert!(Observation::read(&path, false).is_err());
    }
    #[test]
    fn macos_attachment_replaced_staging_and_linked_directory_are_preserved() {
        for kind in ["replacement", "symlink", "hardlink"] {
            let (_temp, root) = fixture();
            let mut staging = None;
            let directory = Directory::open(&root, false, false).unwrap();
            let result =
                publish_before_rename(&directory, ["new.png".into()], b"new bytes", |_, name| {
                    let path = root.join("attachments").join(name);
                    staging = Some(path.clone());
                    if kind == "hardlink" {
                        std::fs::hard_link(&path, path.with_extension("retained"))?;
                    } else {
                        std::fs::rename(&path, path.with_extension("retained"))?;
                        if kind == "symlink" {
                            symlink(path.with_extension("retained"), &path)?;
                        } else {
                            std::fs::write(&path, b"replacement")?;
                        }
                    }
                    Ok(())
                });
            assert!(result.is_err(), "{kind}");
            assert!(!root.join("attachments/new.png").exists());
            let staging = staging.unwrap();
            if kind == "replacement" {
                assert_eq!(std::fs::read(&staging).unwrap(), b"replacement");
            } else if kind == "symlink" {
                assert!(std::fs::symlink_metadata(&staging)
                    .unwrap()
                    .file_type()
                    .is_symlink());
            } else {
                assert_eq!(std::fs::metadata(&staging).unwrap().nlink(), 2);
            }
            assert_eq!(
                std::fs::read(staging.with_extension("retained")).unwrap(),
                b"new bytes"
            );
        }
        let (_temp, root) = fixture();
        std::fs::create_dir(root.join("attachments")).unwrap();
        let (_temp2, root2) = fixture();
        symlink(root.join("attachments"), root2.join("attachments")).unwrap();
        let directory2 = Directory::open(&root2, false, false).unwrap();
        assert!(publish(&directory2, ["linked.png".into()], b"blocked").is_err());
        assert!(!root.join("attachments/linked.png").exists());
    }

    #[test]
    fn macos_attachment_root_replacement_never_recreates_or_writes_a_new_vault() {
        let (_temp, root) = fixture();
        let vault = root.join("vault");
        std::fs::create_dir(&vault).unwrap();
        let directory = Directory::open(&vault, false, false).unwrap();
        std::fs::rename(&vault, root.join("retained-vault")).unwrap();
        std::fs::create_dir(&vault).unwrap();
        assert!(publish(&directory, ["new.png".into()], b"blocked").is_err());
        assert!(!vault.join("attachments").exists());
        assert!(!root.join("retained-vault/attachments").exists());
    }

    #[test]
    fn macos_attachment_blob_limit_does_not_raise_note_or_credential_limits() {
        let (_temp, root) = fixture();
        let directory = Directory::open(&root, false, false).unwrap();
        let data = vec![42; crate::macos_fs::MAX_RECORD as usize + 1];
        directory
            .create_attachment(OsStr::new("large.bin"), &data)
            .unwrap();
        assert_eq!(
            directory
                .read_attachment(OsStr::new("large.bin"))
                .unwrap()
                .unwrap()
                .0,
            data
        );
        assert!(directory.read(OsStr::new("large.bin")).is_err());
        assert!(directory.create(OsStr::new("record"), &data).is_err());
        let private = Directory::open(&root, false, true).unwrap();
        assert!(private.read_attachment(OsStr::new("large.bin")).is_err());
        assert!(
            Observation::read_matching_at(&directory, Path::new("large.bin"), 1)
                .unwrap()
                .is_none()
        );
    }
}
