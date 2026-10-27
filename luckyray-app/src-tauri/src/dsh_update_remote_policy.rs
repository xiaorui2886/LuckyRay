/// The host's remote-authority flag records a successful control-protocol ACK,
/// including ACKs which CLEAR the authority. It is not proof of a live remote
/// origin, session, or task. Keep real configured origins blocked, and require
/// a confirmed clear for a bound carrier before attempting the existing
/// authenticated idle/save/stop protocol.
pub(crate) fn permits_update_reservation(
    origin_configured: bool,
    carrier_bound: bool,
    authority_sync_acknowledged: bool,
) -> bool {
    !origin_configured && (!carrier_bound || authority_sync_acknowledged)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acknowledged_clear_is_not_an_active_remote_origin() {
        assert!(permits_update_reservation(false, true, true));
    }

    #[test]
    fn unknown_or_failed_carrier_clear_stays_blocked() {
        assert!(!permits_update_reservation(false, true, false));
    }

    #[test]
    fn configured_origin_stays_blocked_even_during_rekey_or_failed_push() {
        for bound in [false, true] {
            for ack in [false, true] {
                assert!(!permits_update_reservation(true, bound, ack));
            }
        }
    }

    #[test]
    fn never_bound_and_unconfigured_host_needs_no_carrier_ack() {
        for ack in [false, true] {
            assert!(permits_update_reservation(false, false, ack));
        }
    }
}
