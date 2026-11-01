//! Lexical path helpers only. They do not establish object identity or protect
//! against symlink replacement; callers must retain their existing guards.

fn encode_bytes(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 15) as usize] as char);
    }
    output
}

fn representable_relative(value: &str) -> bool {
    !value.is_empty()
        && value.trim() == value
        && !value.starts_with(['/', '~'])
        && !value.contains(['\\', ':', '\0'])
        && value.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && !part.eq_ignore_ascii_case(".luckyray")
        })
}

#[cfg(target_os = "macos")]
pub(super) fn path_key(path: &std::path::Path) -> String {
    use std::os::unix::ffi::OsStrExt;
    // Encoding rather than lossy Unicode conversion keeps distinct byte paths
    // distinct, including literal backslashes and invalid UTF-8.
    encode_bytes(path.as_os_str().as_bytes())
}

#[cfg(target_os = "macos")]
pub(super) fn is_within(path: &std::path::Path, root: &std::path::Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    use std::path::Component;
    path.is_absolute()
        && root.is_absolute()
        && !path.as_os_str().as_bytes().contains(&0)
        && !root.as_os_str().as_bytes().contains(&0)
        && !path.components().any(|part| part == Component::ParentDir)
        && !root.components().any(|part| part == Component::ParentDir)
        && path.starts_with(root)
}

#[cfg(target_os = "macos")]
pub(super) fn watched_relative(value: &str, root: &std::path::Path) -> Option<String> {
    use std::path::Path;
    let path = Path::new(value);
    let relative = if path.is_absolute() {
        if !is_within(path, root) {
            return None;
        }
        path.strip_prefix(root).ok()?.to_str()?
    } else {
        value
    };
    // Other Knowledge code still interprets backslash as a separator and
    // trims outer whitespace. Refuse those names until the entire path
    // pipeline is lossless; an uncertain event triggers full reconciliation.
    representable_relative(relative).then(|| relative.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byte_keys_do_not_collapse_backslashes_or_invalid_utf8() {
        assert_ne!(encode_bytes(b"/vault\\name"), encode_bytes(b"/vault/name"));
        assert_ne!(
            encode_bytes(b"/vault/\xff"),
            encode_bytes("/vault/\u{fffd}".as_bytes())
        );
        assert_ne!(encode_bytes(b"/vault/A"), encode_bytes(b"/vault/a"));
    }

    #[test]
    fn unsupported_relative_spellings_are_not_silently_reinterpreted() {
        assert!(representable_relative("素材/space name.png"));
        for value in [
            "",
            "../outside",
            "a\\b.png",
            " leading.png",
            "trailing.png ",
            "a//b",
            "a/.luckyray/b",
        ] {
            assert!(!representable_relative(value), "{value:?}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_components_reject_aliases_and_parent_traversal() {
        use std::path::Path;
        let root = Path::new("/Users/用户/Vault\\one");
        assert!(is_within(Path::new("/Users/用户/Vault\\one/笔记.md"), root));
        assert!(!is_within(Path::new("/Users/用户/Vault/one/笔记.md"), root));
        assert!(!is_within(
            Path::new("/Users/用户/Vault\\one/../outside"),
            root
        ));
        assert!(!is_within(Path::new("relative/path"), root));
        assert_eq!(
            watched_relative("/Users/用户/Vault\\one/素材/image.png", root).as_deref(),
            Some("素材/image.png")
        );
        assert!(watched_relative("/Users/用户/Vault/one/image.png", root).is_none());
        assert!(watched_relative("/Users/用户/Vault\\one/a\\b.png", root).is_none());
    }
}
