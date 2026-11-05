// The legacy folder commands operate on paths and cannot atomically bind the
// checked source and parent objects to the eventual rename or removal. On Mac
// a concurrent replacement could therefore move or remove the wrong object.
// Keep these entries closed until a source-bound operation is available.
pub(crate) fn require_safe_platform(is_macos: bool) -> Result<(), String> {
    if is_macos {
        return Err("knowledge-folder-mutation-unavailable: Folder rename, move, and deletion are temporarily unavailable on macOS because concurrent folder replacement is not yet safely handled".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::require_safe_platform;

    #[test]
    fn macos_folder_mutations_fail_closed() {
        let error = require_safe_platform(true).unwrap_err();
        assert!(error.starts_with("knowledge-folder-mutation-unavailable:"));
    }

    #[test]
    fn other_platforms_keep_their_existing_folder_commands() {
        assert!(require_safe_platform(false).is_ok());
    }
}
