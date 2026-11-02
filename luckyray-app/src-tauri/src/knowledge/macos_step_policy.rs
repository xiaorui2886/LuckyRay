//! Attachment recovery may use only an admitted or durably completed binding.
//! Current equal bytes never establish a new target-object authority.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Done<T> {
    pub(super) object: Option<T>,
}
#[derive(Clone, Debug)]
pub(super) struct Progress<T> {
    pub(super) forward_intent: bool,
    pub(super) forward_done: Option<Done<T>>,
    pub(super) rollback_intent: bool,
    pub(super) rollback_done: Option<Done<T>>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Decision {
    Mutate,
    Unchanged,
    Complete,
    Conflict,
    Retired,
}
impl<T> Progress<T> {
    pub(super) fn unknown(&self) -> bool {
        self.forward_intent != self.forward_done.is_some()
            || self.rollback_intent != self.rollback_done.is_some()
            || (self.forward_done.is_some() && !self.forward_intent)
    }
    pub(super) fn expected<'a>(&'a self, initial: &'a Option<T>) -> &'a Option<T> {
        self.rollback_done
            .as_ref()
            .or(self.forward_done.as_ref())
            .map(|v| &v.object)
            .unwrap_or(initial)
    }
}
pub(super) fn decide<T: Eq>(
    initial: &Option<T>,
    current: &Option<T>,
    state: &Progress<T>,
    rollback: bool,
) -> Decision {
    if state.unknown() {
        return Decision::Conflict;
    }
    if !rollback && state.rollback_intent {
        return Decision::Retired;
    }
    if current != state.expected(initial) {
        return Decision::Conflict;
    }
    if rollback {
        if state.rollback_done.is_some() {
            Decision::Complete
        } else if state.forward_done.is_none() {
            Decision::Unchanged
        } else {
            Decision::Mutate
        }
    } else if state.forward_done.is_some() {
        Decision::Complete
    } else {
        Decision::Mutate
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Clone, Debug, PartialEq, Eq)]
    struct Object {
        inode: u64,
        hash: &'static str,
    }
    fn original() -> Object {
        Object {
            inode: 11,
            hash: "same bytes",
        }
    }
    fn fresh() -> Progress<Object> {
        Progress {
            forward_intent: false,
            forward_done: None,
            rollback_intent: false,
            rollback_done: None,
        }
    }
    #[test]
    fn completed_creation_never_authorizes_removing_a_same_bytes_replacement() {
        let initial = None;
        let created = original();
        let state = Progress {
            forward_intent: true,
            forward_done: Some(Done {
                object: Some(created.clone()),
            }),
            ..fresh()
        };
        assert_eq!(
            decide(&initial, &Some(created.clone()), &state, true),
            Decision::Mutate
        );
        let replacement = Object {
            inode: 12,
            ..created
        };
        assert_eq!(
            decide(&initial, &Some(replacement.clone()), &state, true),
            Decision::Conflict
        );
        assert_eq!(
            decide(&initial, &Some(replacement), &state, false),
            Decision::Conflict
        );
    }
    #[test]
    fn an_intent_without_completion_is_unknown_even_when_pre_or_post_bytes_match() {
        let initial = Some(original());
        let state = Progress {
            forward_intent: true,
            ..fresh()
        };
        for current in [
            initial.clone(),
            None,
            Some(Object {
                inode: 12,
                hash: "same bytes",
            }),
        ] {
            assert_eq!(
                decide(&initial, &current, &state, false),
                Decision::Conflict
            );
            assert_eq!(decide(&initial, &current, &state, true), Decision::Conflict);
        }
    }
    #[test]
    fn unstarted_rollback_is_only_a_noop_on_the_admitted_object() {
        let initial = Some(original());
        assert_eq!(
            decide(&initial, &initial, &fresh(), true),
            Decision::Unchanged
        );
        assert_eq!(
            decide(
                &initial,
                &Some(Object {
                    inode: 12,
                    hash: "same bytes"
                }),
                &fresh(),
                true
            ),
            Decision::Conflict
        );
    }
    #[test]
    fn a_rollback_completion_binds_its_actual_new_inode_and_retires_forward_replay() {
        let initial = Some(original());
        let restored = Some(Object {
            inode: 14,
            hash: "same bytes",
        });
        let state = Progress {
            forward_intent: true,
            forward_done: Some(Done { object: None }),
            rollback_intent: true,
            rollback_done: Some(Done {
                object: restored.clone(),
            }),
        };
        assert_eq!(
            decide(&initial, &restored, &state, true),
            Decision::Complete
        );
        assert_eq!(decide(&initial, &initial, &state, true), Decision::Conflict);
        assert_eq!(
            decide(&initial, &restored, &state, false),
            Decision::Retired
        );
    }
    #[test]
    fn missing_completion_or_inverted_receipts_never_become_a_new_admission() {
        let initial = Some(original());
        for state in [
            Progress {
                forward_done: Some(Done {
                    object: initial.clone(),
                }),
                ..fresh()
            },
            Progress {
                rollback_intent: true,
                ..fresh()
            },
        ] {
            assert_eq!(decide(&initial, &initial, &state, true), Decision::Conflict);
        }
    }
}
