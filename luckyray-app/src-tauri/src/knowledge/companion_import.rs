//! Metadata-only path planning and one exact, ownership-checked full-body publish.
use super::*;
use std::{collections::HashSet, fs};
use unicode_normalization::UnicodeNormalization;

fn portable_segment(s: &str) -> bool {
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    !s.is_empty()
        && s == s.trim()
        && s.len() <= 240
        && !s.ends_with('.')
        && !s
            .chars()
            .any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
        && !matches!(s, "." | "..")
        && !s.eq_ignore_ascii_case(".luckyray")
        && !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !(stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}
pub(crate) fn companion_import_path_key(path: &str) -> Result<String, KnowledgeError> {
    if path.len() > 4096 || path.split('/').any(|s| !portable_segment(s)) {
        return Err(error(
            "knowledge-path-invalid",
            "Import path is not portable",
        ));
    }
    Ok(path.nfc().flat_map(char::to_uppercase).collect())
}
fn parent_guards(
    root: &Path,
    parent: &Path,
) -> Result<Vec<(PathBuf, FilesystemDirectoryIdentityGuard)>, KnowledgeError> {
    let mut guards = Vec::new();
    let mut path = root.to_owned();
    for part in parent.components() {
        path.push(part.as_os_str());
        let g =
            filesystem_directory_identity_guard(&path).map_err(map_filesystem_identity_error)?;
        g.verify_current_path(&path)
            .map_err(map_filesystem_identity_error)?;
        guards.push((path.clone(), g));
    }
    Ok(guards)
}
fn check_parents(
    guards: &[(PathBuf, FilesystemDirectoryIdentityGuard)],
) -> Result<(), KnowledgeError> {
    for (p, g) in guards {
        g.verify_current_path(p)
            .map_err(map_filesystem_identity_error)?;
    }
    Ok(())
}
impl KnowledgeService {
    /// Only names are chosen here. No note, directory or placeholder is created.
    pub(crate) fn companion_import_plan_paths(
        &self,
        expected: &KnowledgeTargetIdentity,
        items: &[(String, String)],
        reserved: &HashSet<String>,
    ) -> Result<Vec<String>, KnowledgeError> {
        let _lock = self
            .mutation_lock
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge unavailable"))?;
        let vault = self.current_vault_unlocked()?;
        let root_guard = self.capture_expected_target_unlocked(&vault, Some(expected))?;
        let mut occupied = reserved.clone();
        let mut result = Vec::new();
        for (title, parent_text) in items {
            let parent = safe_relative_directory(Some(parent_text))?;
            if !parent.as_os_str().is_empty() {
                companion_import_path_key(&relative_path_string(&parent))?;
            }
            // Preparation may reserve future queued folders, but it never creates
            // them. Every existing prefix is checked before examining children.
            let mut existing = PathBuf::new();
            let mut missing = false;
            for part in parent.components() {
                let segment = part.as_os_str().to_string_lossy();
                let key = segment
                    .nfc()
                    .flat_map(char::to_uppercase)
                    .collect::<String>();
                for sibling in fs::read_dir(vault.root.join(&existing))
                    .map_err(|_| error("knowledge-parent-missing", "Import parent unavailable"))?
                {
                    let sibling = sibling.map_err(|_| {
                        error("knowledge-parent-missing", "Import parent unavailable")
                    })?;
                    let name = sibling.file_name();
                    let name = name.to_string_lossy();
                    if name.nfc().flat_map(char::to_uppercase).collect::<String>() == key
                        && name != segment
                    {
                        return Err(error(
                            "knowledge-import-path-conflict",
                            "Import parent spelling is ambiguous",
                        ));
                    }
                }
                existing.push(part.as_os_str());
                match fs::symlink_metadata(vault.root.join(&existing)) {
                    Ok(_) => {
                        safe_existing_directory(&vault.root, &existing)?;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        missing = true;
                        existing.pop();
                        break;
                    }
                    Err(_) => {
                        return Err(error(
                            "knowledge-parent-missing",
                            "Import parent unavailable",
                        ))
                    }
                }
            }
            let guards = parent_guards(&vault.root, &existing)?;
            let directory = vault.root.join(&parent);
            let entries = if missing {
                Vec::new()
            } else {
                fs::read_dir(&directory)
                    .map_err(|_| error("knowledge-parent-missing", "Import parent unavailable"))?
                    .collect::<Vec<_>>()
            };
            for item in entries {
                let item = item
                    .map_err(|_| error("knowledge-parent-missing", "Import parent unavailable"))?;
                let p = relative_path_string(&parent.join(item.file_name()));
                // Unknown nonportable existing entries are still represented by a
                // conservative normalized collision key, never opened or overwritten.
                let mut key = p.nfc().flat_map(char::to_uppercase).collect::<String>();
                if item
                    .file_type()
                    .map_err(|_| error("knowledge-parent-missing", "Import parent unavailable"))?
                    .is_dir()
                {
                    key.push('/');
                }
                occupied.insert(key);
            }
            let name = safe_markdown_name(title)?;
            let stem = Path::new(&name)
                .file_stem()
                .and_then(OsStr::to_str)
                .ok_or_else(|| error("knowledge-path-invalid", "Import name invalid"))?;
            let mut chosen = None;
            for suffix in 0..1000 {
                let name = match suffix {
                    0 => name.clone(),
                    1 => format!("{stem}（副本）.md"),
                    _ => format!("{stem}（副本 {suffix}）.md"),
                };
                let relative = relative_path_string(&parent.join(name));
                let key = companion_import_path_key(&relative)?;
                if occupied.iter().any(|other| {
                    other == &key
                        || other.starts_with(&(key.clone() + "/"))
                        || (!other.ends_with('/') && key.starts_with(&(other.clone() + "/")))
                }) {
                    continue;
                }
                occupied.insert(key);
                chosen = Some(relative);
                break;
            }
            check_parents(&guards)?;
            result.push(chosen.ok_or_else(|| {
                error(
                    "knowledge-name-conflict",
                    "Import name reservation exhausted",
                )
            })?);
        }
        self.assert_expected_target_unlocked(&vault, Some(expected), root_guard.as_ref())?;
        Ok(result)
    }
    /// The prepare callback durably records staging basename and file object.
    /// A retry may only recover those exact owned bytes. Private staging evidence
    /// is intentionally retained on uncertainty; no suffix retry or body adoption.
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
        let parent = relative.parent().unwrap_or_else(|| Path::new(""));
        let _lock = self
            .mutation_lock
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge unavailable"))?;
        let vault = self.current_vault_unlocked()?;
        let root_guard = self.capture_expected_target_unlocked(&vault, Some(expected))?;
        let directory = safe_existing_directory(&vault.root, parent)?;
        let guards = parent_guards(&vault.root, parent)?;
        let destination = directory.join(
            relative
                .file_name()
                .ok_or_else(|| error("knowledge-path-invalid", "Import path invalid"))?,
        );
        let identity = |file: &File, p: &Path| {
            index::attachment_object_identity(file, p).map(|(a, b)| format!("{a:x}:{b:x}"))
        };
        let verify_bytes = |file: &mut File| -> Result<(), KnowledgeError> {
            file.seek(SeekFrom::Start(0))
                .map_err(|_| error("knowledge-import-uncertain", "Cannot read owned import"))?;
            let mut bytes = Vec::new();
            file.take(content.len() as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| error("knowledge-import-uncertain", "Cannot verify owned import"))?;
            if bytes != content.as_bytes() {
                return Err(error("knowledge-import-uncertain", "Owned import changed"));
            }
            Ok(())
        };
        let mut options = OpenOptions::new();
        options.read(true).write(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options
                .access_mode(0x80000000 | 0x40000000 | 0x00010000)
                .share_mode(1);
        }
        if fs::symlink_metadata(&destination).is_ok() {
            let Some((_, owned)) = prior else {
                return Err(error(
                    "knowledge-import-path-conflict",
                    "Reserved import path is occupied",
                ));
            };
            // Resolver guards reject reparse/symlink aliases; identity and bytes
            // must BOTH match the immutable prepare record.
            let checked = safe_existing_file(&vault.root, &relative)?;
            let mut file = options
                .open(&checked)
                .map_err(|_| error("knowledge-import-uncertain", "Published import unavailable"))?;
            if identity(&file, &checked).as_deref() != Some(owned) {
                return Err(error(
                    "knowledge-import-path-conflict",
                    "Reserved import path is foreign",
                ));
            }
            verify_bytes(&mut file)?;
            check_parents(&guards)?;
            self.assert_expected_target_unlocked(&vault, Some(expected), root_guard.as_ref())?;
            let document =
                snapshot_from_committed_bytes(&vault, &relative, &destination, content.as_bytes())?;
            return Ok(KnowledgeMutationResult {
                document,
                position: "created".into(),
                index_stale: false,
                index_warning: None,
            });
        }
        // Case/NFC equivalent late collisions are conflicts even on case-sensitive hosts.
        let key = companion_import_path_key(path)?;
        for entry in fs::read_dir(&directory)
            .map_err(|_| error("knowledge-parent-missing", "Import parent unavailable"))?
        {
            let entry = entry
                .map_err(|_| error("knowledge-parent-missing", "Import parent unavailable"))?;
            let other = relative_path_string(&parent.join(entry.file_name()))
                .nfc()
                .flat_map(char::to_uppercase)
                .collect::<String>();
            if other == key {
                return Err(error(
                    "knowledge-import-path-conflict",
                    "Reserved import path is occupied",
                ));
            }
        }
        let (staged, mut file) = if let Some((stage, owned)) = prior {
            if !stage.starts_with(".lrk-import-")
                || !stage.ends_with(".tmp")
                || stage.contains('/')
                || stage.contains('\\')
                || stage.len() > 100
            {
                return Err(error(
                    "knowledge-import-uncertain",
                    "Import staging record invalid",
                ));
            }
            let staged = directory.join(stage);
            let meta = fs::symlink_metadata(&staged).map_err(|_| {
                error(
                    "knowledge-import-uncertain",
                    "Import staging evidence unavailable",
                )
            })?;
            if !meta.is_file() || meta.file_type().is_symlink() {
                return Err(error(
                    "knowledge-import-uncertain",
                    "Import staging evidence unsafe",
                ));
            }
            let mut file = options
                .open(&staged)
                .map_err(|_| error("knowledge-import-uncertain", "Import staging unavailable"))?;
            if identity(&file, &staged).as_deref() != Some(owned) {
                return Err(error(
                    "knowledge-import-uncertain",
                    "Import staging identity changed",
                ));
            }
            verify_bytes(&mut file)?;
            (staged, file)
        } else {
            let staged = directory.join(format!(".lrk-import-{:032x}.tmp", rand::random::<u128>()));
            let mut file = options
                .create_new(true)
                .open(&staged)
                .map_err(|_| error("knowledge-write-failed", "Cannot stage import"))?;
            file.write_all(content.as_bytes())
                .and_then(|_| file.sync_all())
                .map_err(|_| error("knowledge-import-uncertain", "Cannot flush import"))?;
            let object = identity(&file, &staged)
                .ok_or_else(|| error("knowledge-import-uncertain", "Cannot identify import"))?;
            prepare(staged.file_name().and_then(OsStr::to_str).unwrap(), &object)?;
            (staged, file)
        };
        verify_bytes(&mut file)?;
        check_parents(&guards)?;
        self.assert_expected_target_unlocked(&vault, Some(expected), root_guard.as_ref())?;
        rename_open_file(&file, &destination).map_err(|_| {
            if destination.exists() {
                error(
                    "knowledge-import-path-conflict",
                    "Reserved import path became occupied",
                )
            } else {
                error(
                    "knowledge-import-uncertain",
                    "Import publication unavailable",
                )
            }
        })?;
        check_parents(&guards)?;
        self.assert_expected_target_unlocked(&vault, Some(expected), root_guard.as_ref())?;
        let document =
            snapshot_from_committed_bytes(&vault, &relative, &destination, content.as_bytes())
                .map_err(|_| error("knowledge-import-uncertain", "Import receipt unavailable"))?;
        let _ = staged; // Keep evidence on any ambiguous return; no unowned cleanup.
        Ok(KnowledgeMutationResult {
            document,
            position: "created".into(),
            index_stale: false,
            index_warning: None,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_paths_reject_nonportable_segments() {
        for p in [
            "../a.md",
            "x/CON.md",
            "x /a.md",
            "a\\b.md",
            ".luckyray/a.md",
        ] {
            assert!(companion_import_path_key(p).is_err());
        }
        assert_eq!(
            companion_import_path_key("café/A.md").unwrap(),
            companion_import_path_key("cafe\u{301}/a.md").unwrap()
        );
    }
}
