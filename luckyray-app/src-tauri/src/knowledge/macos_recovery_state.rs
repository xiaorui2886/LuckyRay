//! Recovery decisions depend on verified file hashes, never journal claims alone.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Recovery {
    Retain,
    Archive,
    Restore,
    Preserve,
}

pub(super) fn decide(
    before: Option<&str>,
    after: &str,
    target: Option<&str>,
    backup: Option<&str>,
) -> Recovery {
    if before.is_some() && target == Some(after) {
        if backup == before {
            Recovery::Retain
        } else {
            Recovery::Preserve
        }
    } else if (before.is_none() && target == Some(after) && backup.is_none())
        || (target == before && (backup == Some(after) || backup.is_none()))
    {
        Recovery::Archive
    } else if target.is_none() && before.is_some() && backup == before {
        Recovery::Restore
    } else {
        Recovery::Preserve
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recognized_versions_choose_archive_or_retain() {
        assert_eq!(
            decide(Some("old"), "new", Some("new"), Some("old")),
            Recovery::Retain
        );
        assert_eq!(
            decide(Some("old"), "new", Some("old"), Some("new")),
            Recovery::Archive
        );
        assert_eq!(decide(None, "new", None, Some("new")), Recovery::Archive);
        assert_eq!(decide(None, "new", Some("new"), None), Recovery::Archive);
        assert_eq!(
            decide(Some("same"), "same", Some("same"), Some("same")),
            Recovery::Retain
        );
        assert_eq!(
            decide(Some("same"), "same", Some("same"), None),
            Recovery::Preserve
        );
        assert_eq!(
            decide(Some("old"), "new", Some("old"), None),
            Recovery::Archive
        );
    }
    #[test]
    fn missing_target_restores_only_verified_original() {
        assert_eq!(
            decide(Some("old"), "new", None, Some("old")),
            Recovery::Restore
        );
        assert_eq!(
            decide(Some("old"), "new", None, Some("other")),
            Recovery::Preserve
        );
        assert_eq!(decide(Some("old"), "new", None, None), Recovery::Preserve);
    }
    #[test]
    fn concurrent_versions_are_preserved_without_automatic_overwrite() {
        for (target, backup) in [
            (Some("other"), Some("old")),
            (Some("new"), Some("other")),
            (Some("old"), Some("other")),
            (None, Some("new")),
        ] {
            assert_eq!(
                decide(Some("old"), "new", target, backup),
                Recovery::Preserve
            );
        }
    }
}
