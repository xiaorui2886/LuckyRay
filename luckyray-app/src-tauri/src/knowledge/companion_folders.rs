//! Scoped create-only directory authority for the mobile file-vault outbox.
use super::*;
use std::fs;

fn folder_name(name: &str) -> Result<&str, KnowledgeError> {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    if name.is_empty() || name != name.trim() || name.len() > 240 || name.ends_with('.')
        || name.chars().any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
        || matches!(name, "." | "..") || name.eq_ignore_ascii_case(".luckyray") || reserved {
        return Err(error("knowledge-path-invalid", "Folder name is invalid"));
    }
    Ok(name)
}
impl KnowledgeService {
    /// Never adopts or replaces an existing entry. A crash after mkdir but before
    /// the caller's receipt is deliberately uncertain, not inferred success.
    pub(crate) fn companion_create_folder_for_target(
        &self, expected: &KnowledgeTargetIdentity, parent: Option<&str>, name: &str,
    ) -> Result<String, KnowledgeError> {
        let name = folder_name(name)?;
        let _guard = self.mutation_lock.lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge service lock failed"))?;
        let vault = self.current_vault_unlocked()?;
        let root_guard = self.capture_expected_target_unlocked(&vault, Some(expected))?;
        let relative_parent = safe_relative_directory(parent)?;
        let parent_path = safe_existing_directory(&vault.root, &relative_parent)?;
        let parent_guard = filesystem_directory_identity_guard(&parent_path)
            .map_err(map_filesystem_identity_error)?;
        // Avoid collisions accepted on Linux but ambiguous on Windows.
        for entry in fs::read_dir(&parent_path).map_err(|_| error("knowledge-parent-missing", "Folder unavailable"))? {
            let entry = entry.map_err(|_| error("knowledge-parent-missing", "Folder unavailable"))?;
            if entry.file_name().to_string_lossy().to_uppercase() == name.to_uppercase() {
                return Err(error("knowledge-name-conflict", "A folder or file with this name exists"));
            }
        }
        self.assert_expected_target_unlocked(&vault, Some(expected), root_guard.as_ref())?;
        parent_guard.verify_current_path(&parent_path).map_err(map_filesystem_identity_error)?;
        let path = parent_path.join(name);
        fs::create_dir(&path).map_err(|_| error("knowledge-name-conflict", "Folder could not be created without replacement"))?;
        // Do not remove anything on a post-create failure; its ownership may have changed.
        parent_guard.verify_current_path(&parent_path).map_err(map_filesystem_identity_error)?;
        self.assert_expected_target_unlocked(&vault, Some(expected), root_guard.as_ref())?;
        #[cfg(unix)]
        File::open(&parent_path).and_then(|f| f.sync_all())
            .map_err(|_| error("knowledge-operation-unavailable", "Folder durability is uncertain"))?;
        Ok(relative_parent.join(name).to_string_lossy().replace('\\', "/"))
    }
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn only_portable_single_names_are_allowed() {
        for bad in ["", ".", "..", "x/y", "x\\y", " x", "x ", "x.", "a:b", "CON", "com1.txt", "LPT9", "\n"] {
            assert!(folder_name(bad).is_err(), "{bad:?}");
        }
        for good in ["笔记", "Projects", "my folder", "COM10", "v1.2"] { assert!(folder_name(good).is_ok()); }
    }
}
