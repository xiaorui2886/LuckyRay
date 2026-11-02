//! The pure rule that decides whether an observed external move may still
//! authorize the plan in hand.
//!
//! Kept free of the knowledge service so the epoch, identity and TTL decisions
//! can be exercised on their own: the service owns the witnesses and the file
//! handles, this module owns only the arithmetic of "is this still valid".

use std::time::Duration;

/// The observation must have been captured for this exact source epoch and this
/// exact plan target. Anything else is a different session or a different Vault.
pub(crate) fn witness_scope_is_current(
    observed_epoch: u64,
    source_epoch: u64,
    observed_identity: &str,
    plan_identity: &str,
) -> bool {
    observed_epoch == source_epoch && observed_identity == plan_identity
}

/// A recorded observation is usable only while it is younger than the TTL.
/// `None` means nothing was recorded for that path, which is never usable.
pub(crate) fn witness_is_fresh(captured: Option<Duration>, ttl: Duration) -> bool {
    captured.is_some_and(|age| age < ttl)
}

/// A rollback re-reads nothing external, so neither an expired observation nor a
/// changed epoch may block an undo. A forward run always needs the witness.
pub(crate) fn witness_required(rollback: bool) -> bool {
    !rollback
}
