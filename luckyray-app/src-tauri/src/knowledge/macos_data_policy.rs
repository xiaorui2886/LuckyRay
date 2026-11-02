//! Decisions shared by production removal and recovery. Missing is a verified
//! ENOENT, never an unreadable/unsafe entry. No decision grants filesystem access.
#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(target_os = "macos", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(target_os = "macos", serde(deny_unknown_fields))]
pub(super) struct Object {
    pub(super) device: u64,
    pub(super) inode: u64,
    pub(super) hash: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Seen {
    Missing,
    Object(Object),
    Unavailable,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Remove {
    RetainOriginal,
    Retained,
    Preserve,
}

pub(super) fn removal(expected: &Object, source: &Seen, backup: &Seen) -> Remove {
    match (source, backup) {
        (Seen::Object(source), Seen::Missing) if source == expected => Remove::RetainOriginal,
        (Seen::Missing, Seen::Object(backup)) if backup == expected => Remove::Retained,
        _ => Remove::Preserve,
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Restore {
    RestoreOriginal,
    Restored,
    Preserve,
}

pub(super) fn restoration(expected: &Object, source: &Seen, backup: &Seen) -> Restore {
    match (source, backup) {
        (Seen::Missing, Seen::Object(backup)) if backup == expected => Restore::RestoreOriginal,
        (Seen::Object(source), Seen::Missing) if source == expected => Restore::Restored,
        _ => Restore::Preserve,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn original() -> Object {
        Object {
            device: 4,
            inode: 27,
            hash: "a".repeat(64),
        }
    }
    #[test]
    fn deletion_requires_the_actual_source_and_an_absent_backup() {
        let object = original();
        assert_eq!(
            removal(&object, &Seen::Object(object.clone()), &Seen::Missing),
            Remove::RetainOriginal
        );
        assert_eq!(
            removal(&object, &Seen::Missing, &Seen::Object(object.clone())),
            Remove::Retained
        );
        assert_eq!(
            removal(&object, &Seen::Missing, &Seen::Missing),
            Remove::Preserve
        );
    }
    #[test]
    fn same_bytes_at_a_different_inode_or_device_never_authorize_removal() {
        let object = original();
        for changed in [
            Object {
                inode: 28,
                ..object.clone()
            },
            Object {
                device: 5,
                ..object.clone()
            },
        ] {
            assert_eq!(
                removal(&object, &Seen::Object(changed.clone()), &Seen::Missing),
                Remove::Preserve
            );
            assert_eq!(
                removal(&object, &Seen::Missing, &Seen::Object(changed)),
                Remove::Preserve
            );
        }
    }
    #[test]
    fn a_late_writer_or_a_conflicting_backup_is_preserved() {
        let object = original();
        let changed = Object {
            hash: "b".repeat(64),
            ..object.clone()
        };
        assert_eq!(
            removal(&object, &Seen::Object(changed.clone()), &Seen::Missing),
            Remove::Preserve
        );
        assert_eq!(
            removal(&object, &Seen::Missing, &Seen::Object(changed)),
            Remove::Preserve
        );
        assert_eq!(
            removal(
                &object,
                &Seen::Object(object.clone()),
                &Seen::Object(object.clone())
            ),
            Remove::Preserve
        );
    }
    #[test]
    fn permission_errors_or_unsafe_entries_never_become_absence() {
        let object = original();
        for (source, backup) in [
            (Seen::Unavailable, Seen::Missing),
            (Seen::Missing, Seen::Unavailable),
            (Seen::Object(object.clone()), Seen::Unavailable),
            (Seen::Unavailable, Seen::Object(object.clone())),
        ] {
            assert_eq!(removal(&object, &source, &backup), Remove::Preserve);
            assert_eq!(restoration(&object, &source, &backup), Restore::Preserve);
        }
    }
    #[test]
    fn restoration_never_overwrites_an_existing_or_replaced_name() {
        let object = original();
        let replacement = Object {
            inode: 98,
            ..object.clone()
        };
        assert_eq!(
            restoration(
                &object,
                &Seen::Object(replacement),
                &Seen::Object(object.clone())
            ),
            Restore::Preserve
        );
        assert_eq!(
            restoration(
                &object,
                &Seen::Object(object.clone()),
                &Seen::Object(object.clone())
            ),
            Restore::Preserve
        );
        assert_eq!(
            restoration(&object, &Seen::Missing, &Seen::Missing),
            Restore::Preserve
        );
    }
    #[test]
    fn a_verified_restore_is_idempotent_without_discarding_another_object() {
        let object = original();
        assert_eq!(
            restoration(&object, &Seen::Missing, &Seen::Object(object.clone())),
            Restore::RestoreOriginal
        );
        assert_eq!(
            restoration(&object, &Seen::Object(object.clone()), &Seen::Missing),
            Restore::Restored
        );
    }
}
