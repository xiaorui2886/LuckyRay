//! macOS companion import publication with a durable staged-object identity.
//!
//! The directory operations are optimistic against uncoordinated same-user
//! writers, not a mandatory lock. A late replacement may be moved by the
//! pathname rename; subsequent identity checks reject it and retain evidence.
//! Nothing here removes a staged, published, or competing object.
use super::*;
use crate::macos_fs::{require_empty_acl, Directory, Version};
use std::io;
use std::os::unix::fs::MetadataExt;
use unicode_normalization::UnicodeNormalization;

#[cfg(test)]
std::thread_local! {
    static FAIL_AFTER_PREPARE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
#[cfg(test)]
pub(crate) fn fail_once_after_prepare() {
    FAIL_AFTER_PREPARE.with(|value| value.set(true));
}

fn uncertain() -> KnowledgeError {
    error("knowledge-import-uncertain", "Import outcome needs inspection; all observed objects were retained")
}

fn conflict() -> KnowledgeError {
    error("knowledge-import-path-conflict", "Reserved import path is occupied")
}

fn stage_name(value: &str) -> bool {
    value.strip_prefix(".lrk-import-")
        .and_then(|s| s.strip_suffix(".tmp"))
        .is_some_and(|nonce| nonce.len() == 32 && nonce.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
}

fn object(file: &File, path: &Path) -> Result<String, KnowledgeError> {
    let metadata = file.metadata().map_err(|_| uncertain())?;
    if !metadata.is_file() || metadata.nlink() != 1
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o7777 != 0o600
    {
        return Err(uncertain());
    }
    require_empty_acl(file).map_err(|_| uncertain())?;
    let (device, inode) = index::attachment_object_identity(file, path).ok_or_else(uncertain)?;
    Ok(format!("{device:x}:{inode:x}"))
}

fn read_bound(dir: &Directory, directory_path: &Path, name: &OsStr, bytes: &[u8], owned: Option<&str>)
    -> Result<(File, Version, String), KnowledgeError>
{
    let file = dir.open_regular(name).map_err(|_| uncertain())?;
    let identity = object(&file, &directory_path.join(name))?;
    if owned.is_some_and(|value| value != identity) { return Err(uncertain()); }
    let (actual, version) = dir.read(name).map_err(|_| uncertain())?.ok_or_else(uncertain)?;
    let metadata = file.metadata().map_err(|_| uncertain())?;
    if actual != bytes || !version.matches_metadata(&metadata)
        || identity != object(&file, &directory_path.join(name))?
    {
        return Err(uncertain());
    }
    Ok((file, version, identity))
}

fn verify_bound(dir: &Directory, directory_path: &Path, name: &OsStr, file: &File,
    version: &Version, bytes: &[u8], expected: &str) -> Result<(), KnowledgeError>
{
    let (named, current, identity) = read_bound(dir, directory_path, name, bytes, Some(expected))?;
    let held = file.metadata().map_err(|_| uncertain())?;
    let actual = named.metadata().map_err(|_| uncertain())?;
    if &current != version || !version.matches_metadata(&held)
        || (held.dev(), held.ino()) != (actual.dev(), actual.ino()) || identity != expected
    {
        return Err(uncertain());
    }
    Ok(())
}

fn check_collision(dir: &Directory, name: &OsStr) -> Result<bool, KnowledgeError> {
    let expected = name.to_str().ok_or_else(uncertain)?.nfc().flat_map(char::to_uppercase).collect::<String>();
    let mut exact = false;
    for entry in dir.entries().map_err(|_| uncertain())? {
        if entry == name { exact = true; continue; }
        let candidate = entry.to_string_lossy().nfc().flat_map(char::to_uppercase).collect::<String>();
        if candidate == expected { return Err(conflict()); }
    }
    Ok(exact)
}

impl KnowledgeService {
    pub(crate) fn companion_import_publish(
        &self,
        expected: &KnowledgeTargetIdentity,
        path: &str,
        content: &str,
        prior: Option<(&str, &str)>,
        mut prepare: impl FnMut(&str, &str) -> Result<(), KnowledgeError>,
    ) -> Result<KnowledgeMutationResult, KnowledgeError> {
        companion_import_path_key(path)?;
        let relative = safe_markdown_relative_path(path)?;
        let _mutation = self.mutation_lock.lock().map_err(|_| uncertain())?;
        let vault = self.current_vault_unlocked()?;
        let guard = self.capture_expected_target_unlocked(&vault, Some(expected))?;
        if prior.is_some_and(|(stage, owned)| !stage_name(stage) || owned.is_empty()) {
            return Err(uncertain());
        }
        let root = Directory::open(&vault.root, false, false).map_err(|_| uncertain())?;
        let (directory, target_name) = macos_attachment_io::parent_at(&root, &relative, false)
            .map_err(|failure| if failure.kind() == io::ErrorKind::NotFound {
                error("knowledge-parent-missing", "Import parent unavailable")
            } else { uncertain() })?;
        let directory_path = vault.root.join(relative.parent().unwrap_or_else(|| Path::new("")));
        let _write_lock = directory.lock(OsStr::new(".lrm-write.lock")).map_err(|_| uncertain())?;
        macos_transactions::recover_directory(&directory)?;
        root.current().map_err(|_| uncertain())?;
        self.assert_expected_target_unlocked(&vault, Some(expected), guard.as_ref())?;
        let bytes = content.as_bytes();

        let staged_still_owned = |stage: &str, owned: &str| {
            read_bound(&directory, &directory_path, OsStr::new(stage), bytes, Some(owned)).is_ok()
        };
        let occupied = check_collision(&directory, &target_name).map_err(|failure| match prior {
            Some((stage, owned)) if !staged_still_owned(stage, owned) => uncertain(),
            _ => failure,
        })?;
        if occupied {
            let (stage, owned) = prior.ok_or_else(conflict)?;
            let (file, version, identity) = match read_bound(&directory, &directory_path, &target_name, bytes, Some(owned)) {
                Ok(value) => value,
                Err(_) if staged_still_owned(stage, owned) => return Err(conflict()),
                Err(_) => return Err(uncertain()),
            };
            let target = directory_path.join(&target_name);
            let document = snapshot_from_committed_bytes(&vault, &relative, &target, bytes).map_err(|_| uncertain())?;
            verify_bound(&directory, &directory_path, &target_name, &file, &version, bytes, &identity)?;
            root.current().map_err(|_| uncertain())?;
            self.assert_expected_target_unlocked(&vault, Some(expected), guard.as_ref())?;
            return Ok(KnowledgeMutationResult { document, position: "created".into(), index_stale: false, index_warning: None });
        }

        let (stage, file, version, identity) = if let Some((stage, owned)) = prior {
            let (file, version, identity) = read_bound(&directory, &directory_path, OsStr::new(stage), bytes, Some(owned))?;
            (stage.to_owned(), file, version, identity)
        } else {
            let stage = format!(".lrk-import-{:032x}.tmp", rand::random::<u128>());
            let file = directory.create(OsStr::new(&stage), bytes).map_err(|_| uncertain())?;
            let (named, version, identity) = read_bound(&directory, &directory_path, OsStr::new(&stage), bytes, None)?;
            let held = file.metadata().map_err(|_| uncertain())?;
            let named_meta = named.metadata().map_err(|_| uncertain())?;
            if (held.dev(), held.ino()) != (named_meta.dev(), named_meta.ino()) { return Err(uncertain()); }
            prepare(&stage, &identity)?;
            #[cfg(test)]
            if FAIL_AFTER_PREPARE.with(|value| value.replace(false)) { return Err(uncertain()); }
            (stage, file, version, identity)
        };

        root.current().map_err(|_| uncertain())?;
        self.assert_expected_target_unlocked(&vault, Some(expected), guard.as_ref())?;
        verify_bound(&directory, &directory_path, OsStr::new(&stage), &file, &version, bytes, &identity)?;
        if check_collision(&directory, &target_name)? { return Err(conflict()); }
        match directory.rename(OsStr::new(&stage), &target_name, false) {
            Ok(()) => {},
            Err(failure) if failure.kind() == io::ErrorKind::AlreadyExists => return Err(conflict()),
            Err(_) => return Err(uncertain()),
        }
        verify_bound(&directory, &directory_path, &target_name, &file, &version, bytes, &identity)?;
        if !check_collision(&directory, &target_name).map_err(|_| uncertain())? { return Err(uncertain()); }
        root.current().map_err(|_| uncertain())?;
        self.assert_expected_target_unlocked(&vault, Some(expected), guard.as_ref())?;
        let target = directory_path.join(&target_name);
        let document = snapshot_from_committed_bytes(&vault, &relative, &target, bytes).map_err(|_| uncertain())?;
        verify_bound(&directory, &directory_path, &target_name, &file, &version, bytes, &identity)?;
        root.current().map_err(|_| uncertain())?;
        self.assert_expected_target_unlocked(&vault, Some(expected), guard.as_ref())?;
        Ok(KnowledgeMutationResult { document, position: "created".into(), index_stale: false, index_warning: None })
    }

    /// The operation owner records (final path, inode, stage name) before a
    /// publication. A collision may choose another name only while the same
    /// journaled stage remains verifiable and its new path is journaled first.
    pub(crate) fn create_unique_document_for_target_resumable(
        &self,
        expected: &KnowledgeTargetIdentity,
        input: &KnowledgeCreateInput,
        prior: Option<(&str, &str, &str)>,
        mut prepare: impl FnMut(&str, &str, &str) -> Result<(), KnowledgeError>,
    ) -> Result<KnowledgeMutationResult, KnowledgeError> {
        fn unresolved() -> KnowledgeError {
            error("knowledge-unique-create-uncertain", "Unique note creation needs inspection; staged objects were retained")
        }
        let mut owned = prior.map(|(path, object, stage)| (path.to_owned(), object.to_owned(), stage.to_owned()));
        let plan = || self.companion_import_plan_paths(expected,
            &[(input.title.clone(), input.parent_relative_path.clone().unwrap_or_default())],
            &std::collections::HashSet::new()).and_then(|paths| paths.into_iter().next().ok_or_else(unresolved));
        for _ in 0..1000 {
            let path = match &owned {
                Some((path, _, _)) => path.clone(),
                None => plan()?,
            };
            let previous = owned.as_ref().map(|(_, object, stage)| (stage.as_str(), object.as_str()));
            let mut newly_prepared = None;
            let result = self.companion_import_publish(expected, &path, &input.content, previous, |stage, object| {
                newly_prepared = Some((path.clone(), object.to_owned(), stage.to_owned()));
                prepare(&path, object, stage)
            });
            if let Some(prepared) = newly_prepared { owned = Some(prepared); }
            match result {
                Ok(document) => return Ok(document),
                Err(failure) if failure.code == "knowledge-import-path-conflict" => {
                    if let Some((old_path, object, stage)) = owned.as_mut() {
                        let next = plan().map_err(|_| unresolved())?;
                        prepare(&next, object, stage).map_err(|_| unresolved())?;
                        *old_path = next;
                    }
                }
                Err(failure) => return Err(if owned.is_some() { unresolved() } else { failure }),
            }
        }
        Err(if owned.is_some() { unresolved() } else { error("knowledge-name-conflict", "No unique note name available") })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_import_can_resume_a_journaled_stage_and_replay_a_published_object() {
        let (service, root, _) = super::super::tests::registered_service("macos-import-resume");
        let target = service.current_target_identity().unwrap();
        let mut recorded: Option<(String, String)> = None;
        let first = service.companion_import_publish(&target, "Imported.md", "draft\n", None, |stage, object| {
            recorded = Some((stage.into(), object.into()));
            Err(uncertain())
        });
        assert_eq!(first.unwrap_err().code, "knowledge-import-uncertain");
        let (stage, object) = recorded.unwrap();
        assert_eq!(std::fs::read_to_string(root.join(&stage)).unwrap(), "draft\n");
        assert!(!root.join("Imported.md").exists());
        let published = service.companion_import_publish(&target, "Imported.md", "draft\n",
            Some((&stage, &object)), |_, _| panic!("a recorded stage must not be prepared again")).unwrap();
        assert_eq!(published.document.content, "draft\n");
        assert_eq!(std::fs::read_to_string(root.join("Imported.md")).unwrap(), "draft\n");
        let replay = service.companion_import_publish(&target, "Imported.md", "draft\n",
            Some((&stage, &object)), |_, _| panic!("a published object must not be prepared again")).unwrap();
        assert_eq!(published.document.revision, replay.document.revision);
    }

    #[test]
    fn macos_import_rejects_existing_and_case_equivalent_targets_without_staging() {
        let (service, root, _) = super::super::tests::registered_service("macos-import-conflict");
        let target = service.current_target_identity().unwrap();
        std::fs::write(root.join("Existing.md"), "other").unwrap();
        let mut prepared = false;
        for path in ["Existing.md", "eXiStInG.md"] {
            let result = service.companion_import_publish(&target, path, "draft", None, |_, _| {
                prepared = true;
                Ok(())
            });
            assert_eq!(result.unwrap_err().code, "knowledge-import-path-conflict");
        }
        assert!(!prepared);
        assert_eq!(std::fs::read_to_string(root.join("Existing.md")).unwrap(), "other");
    }

    #[test]
    fn macos_import_missing_parent_never_creates_a_folder_or_stage() {
        let (service, root, _) = super::super::tests::registered_service("macos-import-missing-parent");
        let target = service.current_target_identity().unwrap();
        let mut prepared = false;
        let result = service.companion_import_publish(&target, "Missing/Imported.md", "draft", None, |_, _| {
            prepared = true;
            Ok(())
        });
        assert_eq!(result.unwrap_err().code, "knowledge-parent-missing");
        assert!(!prepared);
        assert!(!root.join("Missing").exists());
    }

    #[test]
    fn macos_import_rejects_a_same_bytes_stage_replacement() {
        let (service, root, _) = super::super::tests::registered_service("macos-import-stage-swap");
        let target = service.current_target_identity().unwrap();
        let mut recorded: Option<(String, String)> = None;
        let _ = service.companion_import_publish(&target, "Imported.md", "draft", None, |stage, object| {
            recorded = Some((stage.into(), object.into()));
            Err(uncertain())
        });
        let (stage, object) = recorded.unwrap();
        let original = root.join("preserved-original");
        std::fs::rename(root.join(&stage), &original).unwrap();
        std::fs::write(root.join(&stage), "draft").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root.join(&stage), std::fs::Permissions::from_mode(0o600)).unwrap();
        let result = service.companion_import_publish(&target, "Imported.md", "draft",
            Some((&stage, &object)), |_, _| panic!("must not prepare another file"));
        assert_eq!(result.unwrap_err().code, "knowledge-import-uncertain");
        assert_eq!(std::fs::read_to_string(&original).unwrap(), "draft");
        assert_eq!(std::fs::read_to_string(root.join(&stage)).unwrap(), "draft");
        assert!(!root.join("Imported.md").exists());
    }

    #[test]
    fn macos_import_reports_late_stage_swap_without_deleting_either_object() {
        let (service, root, _) = super::super::tests::registered_service("macos-import-late-swap");
        let target = service.current_target_identity().unwrap();
        let fixture = root.clone();
        crate::macos_fs::set_before_rename_call_hook(Some(Box::new(move |from, _| {
            std::fs::rename(fixture.join(from), fixture.join("preserved-original")).unwrap();
            std::fs::write(fixture.join(from), "foreign").unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(fixture.join(from), std::fs::Permissions::from_mode(0o600)).unwrap();
        })));
        let mut recorded = None;
        let result = service.companion_import_publish(&target, "Imported.md", "draft", None, |stage, object| {
            recorded = Some((stage.to_owned(), object.to_owned()));
            Ok(())
        });
        assert_eq!(result.unwrap_err().code, "knowledge-import-uncertain");
        assert!(recorded.is_some());
        assert_eq!(std::fs::read_to_string(root.join("preserved-original")).unwrap(), "draft");
        assert_eq!(std::fs::read_to_string(root.join("Imported.md")).unwrap(), "foreign");
        let (stage, object) = recorded.unwrap();
        assert_eq!(service.companion_import_publish(&target, "Imported.md", "draft",
            Some((&stage, &object)), |_, _| panic!("must not prepare another file")).unwrap_err().code,
            "knowledge-import-uncertain");
    }

    #[test]
    fn macos_unique_create_resumes_stage_and_moves_to_an_unoccupied_suffix() {
        let (service, root, _) = super::super::tests::registered_service("macos-unique-resume");
        let target = service.current_target_identity().unwrap();
        let input = KnowledgeCreateInput { title: "Draft".into(), content: "owned body".into(), parent_relative_path: None };
        let mut recorded = None;
        let first = service.create_unique_document_for_target_resumable(&target, &input, None, |path, object, stage| {
            recorded = Some((path.to_owned(), object.to_owned(), stage.to_owned()));
            Err(uncertain())
        });
        assert_eq!(first.unwrap_err().code, "knowledge-unique-create-uncertain");
        let (old_path, object, stage) = recorded.unwrap();
        assert_eq!(std::fs::read_to_string(root.join(&stage)).unwrap(), "owned body");
        std::fs::write(root.join(&old_path), "external").unwrap();
        let mut updated = None;
        let created = service.create_unique_document_for_target_resumable(&target, &input,
            Some((&old_path, &object, &stage)), |path, object, stage| {
                updated = Some((path.to_owned(), object.to_owned(), stage.to_owned()));
                Ok(())
            }).unwrap();
        let (new_path, new_object, new_stage) = updated.unwrap();
        assert_eq!(new_path, "Draft（副本）.md");
        assert_eq!((new_object, new_stage), (object, stage));
        assert_eq!(created.document.summary.relative_path, new_path);
        assert_eq!(std::fs::read_to_string(root.join(old_path)).unwrap(), "external");
        assert_eq!(std::fs::read_to_string(root.join(new_path)).unwrap(), "owned body");
    }

    #[test]
    fn macos_unique_create_never_retries_a_replaced_stage_as_its_own() {
        use std::os::unix::fs::PermissionsExt;
        let (service, root, _) = super::super::tests::registered_service("macos-unique-stage-swap");
        let target = service.current_target_identity().unwrap();
        let input = KnowledgeCreateInput { title: "Draft".into(), content: "same body".into(), parent_relative_path: None };
        let mut recorded = None;
        let _ = service.create_unique_document_for_target_resumable(&target, &input, None, |path, object, stage| {
            recorded = Some((path.to_owned(), object.to_owned(), stage.to_owned()));
            Err(uncertain())
        });
        let (path, object, stage) = recorded.unwrap();
        let original = root.join("saved-original");
        std::fs::rename(root.join(&stage), &original).unwrap();
        std::fs::write(root.join(&stage), "same body").unwrap();
        std::fs::set_permissions(root.join(&stage), std::fs::Permissions::from_mode(0o600)).unwrap();
        let result = service.create_unique_document_for_target_resumable(&target, &input,
            Some((&path, &object, &stage)), |_, _, _| panic!("must not journal a replacement"));
        assert_eq!(result.unwrap_err().code, "knowledge-unique-create-uncertain");
        assert_eq!(std::fs::read_to_string(&original).unwrap(), "same body");
        assert_eq!(std::fs::read_to_string(root.join(&stage)).unwrap(), "same body");
        assert!(!root.join(path).exists());
    }
}
