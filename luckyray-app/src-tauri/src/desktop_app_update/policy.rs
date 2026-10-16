//! Deterministic native admission. No renderer-supplied payload can advance this machine.
//! Package ownership, network and lifecycle barriers are supplied by the native coordinator.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Phase {
    Disabled,
    Idle,
    Checking,
    Current,
    Available,
    Downloading,
    Verifying,
    Ready,
    Scheduled,
    Preparing,
    Installing,
    Cancelled,
    Error,
}
impl Phase {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Idle => "idle",
            Self::Checking => "checking",
            Self::Current => "current",
            Self::Available => "available",
            Self::Downloading => "downloading",
            Self::Verifying => "verifying",
            Self::Ready => "ready",
            Self::Preparing => "preparing",
            Self::Scheduled => "scheduled",
            Self::Installing => "installing",
            Self::Cancelled => "cancelled",
            Self::Error => "error",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Ticket(u64);

#[derive(Clone, Copy, Debug)]
pub(crate) struct RestartTicket {
    generation: u64,
    previous: Phase,
}

pub(crate) struct Machine {
    pub(crate) phase: Phase,
    pub(crate) revision: u64,
    generation: u64,
    pub(crate) downloaded: u64,
    pub(crate) total: Option<u64>,
    pub(crate) error: Option<&'static str>,
}
impl Machine {
    pub(crate) fn new(enabled: bool) -> Self {
        Self {
            phase: if enabled {
                Phase::Idle
            } else {
                Phase::Disabled
            },
            revision: 0,
            generation: 0,
            downloaded: 0,
            total: None,
            error: None,
        }
    }
    fn change(&mut self, phase: Phase) {
        self.phase = phase;
        self.revision += 1;
    }
    pub(crate) fn can_check(&self) -> bool {
        matches!(
            self.phase,
            Phase::Idle
                | Phase::Current
                | Phase::Available
                | Phase::Cancelled
                | Phase::Error
                | Phase::Ready
        )
    }
    pub(crate) fn can_cancel(&self) -> bool {
        matches!(
            self.phase,
            Phase::Checking
                | Phase::Downloading
                | Phase::Verifying
                | Phase::Ready
                | Phase::Scheduled
        )
    }
    fn begin(&mut self, phase: Phase) -> Ticket {
        self.generation += 1;
        self.error = None;
        self.downloaded = 0;
        self.total = None;
        self.change(phase);
        Ticket(self.generation)
    }
    pub(crate) fn check(&mut self) -> Result<Ticket, &'static str> {
        if !self.can_check() {
            return Err("update-action-unavailable");
        }
        Ok(self.begin(Phase::Checking))
    }
    pub(crate) fn current(&self, ticket: Ticket) -> bool {
        self.generation == ticket.0
    }
    pub(crate) fn checked(&mut self, ticket: Ticket, available: bool) -> bool {
        if !self.current(ticket) || self.phase != Phase::Checking {
            return false;
        }
        self.change(if available {
            Phase::Available
        } else {
            Phase::Current
        });
        true
    }
    pub(crate) fn download(&mut self) -> Result<Ticket, &'static str> {
        if self.phase != Phase::Available {
            return Err("update-action-unavailable");
        }
        Ok(self.begin(Phase::Downloading))
    }
    pub(crate) fn progress(
        &mut self,
        ticket: Ticket,
        chunk: u64,
        total: Option<u64>,
        limit: u64,
    ) -> Result<bool, &'static str> {
        if !self.current(ticket) || self.phase != Phase::Downloading {
            return Ok(false);
        }
        let bytes = self
            .downloaded
            .checked_add(chunk)
            .ok_or("update-download-too-large")?;
        if bytes > limit || total.is_some_and(|n| n > limit) {
            return Err("update-download-too-large");
        }
        if let (Some(previous), Some(next)) = (self.total, total) {
            if previous != next {
                return Err("update-download-length-mismatch");
            }
        }
        let expected = total.or(self.total);
        if expected.is_some_and(|n| bytes > n) {
            return Err("update-download-length-mismatch");
        }
        self.downloaded = bytes;
        self.total = expected;
        self.revision += 1;
        Ok(true)
    }
    pub(crate) fn verifying(&mut self, ticket: Ticket) -> Result<bool, &'static str> {
        if !self.current(ticket) || self.phase != Phase::Downloading {
            return Ok(false);
        }
        if self.downloaded == 0 || self.total.is_some_and(|n| n != self.downloaded) {
            return Err("update-download-length-mismatch");
        }
        self.change(Phase::Verifying);
        Ok(true)
    }
    /// Call only after official signature verification returns success.
    pub(crate) fn verified(&mut self, ticket: Ticket) -> bool {
        if !self.current(ticket) || self.phase != Phase::Verifying {
            return false;
        }
        self.change(Phase::Ready);
        true
    }
    /// Scheduling does not quit, flush, stop an agent, or admit installation.
    /// Call only after the verified package and intent have been persisted.
    pub(crate) fn schedule(&mut self) -> Result<(), &'static str> {
        if self.phase != Phase::Ready {
            return Err("update-not-verified");
        }
        self.change(Phase::Scheduled);
        Ok(())
    }
    /// Reserve a verified update while the existing save/quit barrier runs.
    /// No cancellation or second install may race the pre-exit handoff.
    pub(crate) fn requires_saved_lsh_exit(&self) -> bool {
        self.phase == Phase::Scheduled
    }
    pub(crate) fn scheduled_quit_blocked(&mut self, code: &'static str) -> bool {
        if !self.requires_saved_lsh_exit() { return false; }
        self.error = Some(code);
        self.change(Phase::Scheduled);
        true
    }
    pub(crate) fn prepare_restart(&mut self) -> Result<RestartTicket, &'static str> {
        if !matches!(self.phase, Phase::Ready | Phase::Scheduled) {
            return Err("update-not-verified");
        }
        self.generation += 1;
        let ticket = RestartTicket { generation: self.generation, previous: self.phase };
        self.error = None;
        self.change(Phase::Preparing);
        Ok(ticket)
    }
    /// A rejected save or active task leaves both the verified package and
    /// the application's existing work intact. A later click is a fresh round.
    pub(crate) fn restart_blocked(&mut self, ticket: RestartTicket, code: &'static str) -> bool {
        if self.generation != ticket.generation || self.phase != Phase::Preparing {
            return false;
        }
        self.error = Some(code);
        self.change(ticket.previous);
        true
    }
    pub(crate) fn restart_handoff(&mut self, ticket: RestartTicket, error: Option<&'static str>) -> bool {
        if self.generation != ticket.generation || self.phase != Phase::Preparing { return false; }
        self.error = error;
        self.change(if error.is_some() { Phase::Error } else { Phase::Installing });
        true
    }
    pub(crate) fn fail(&mut self, ticket: Ticket, code: &'static str) -> bool {
        if !self.current(ticket) || matches!(self.phase, Phase::Disabled | Phase::Cancelled) {
            return false;
        }
        self.error = Some(code);
        self.change(Phase::Error);
        true
    }
    pub(crate) fn cancel(&mut self) -> Result<(), &'static str> {
        if !self.can_cancel() {
            return Err("update-cancel-unavailable");
        }
        self.generation += 1;
        self.error = None;
        self.downloaded = 0;
        self.total = None;
        self.change(Phase::Cancelled);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn downloading() -> (Machine, Ticket) {
        let mut m = Machine::new(true);
        let c = m.check().unwrap();
        assert!(m.checked(c, true));
        let d = m.download().unwrap();
        (m, d)
    }
    fn ready() -> (Machine, Ticket) {
        let (mut m, d) = downloading();
        m.progress(d, 4, Some(4), 100).unwrap();
        m.verifying(d).unwrap();
        assert!(m.verified(d));
        (m, d)
    }
    #[test]
    fn failed_immediate_handoff_is_not_restored_as_a_scheduled_install() {
        let (mut m, _) = ready();
        m.schedule().unwrap();
        let ticket = m.prepare_restart().unwrap();
        assert!(m.restart_handoff(ticket, Some("update-install-failed")));
        assert_eq!(m.phase, Phase::Error);
        assert!(!m.restart_blocked(ticket, "late-save"));
        assert!(m.can_check());
        assert!(m.prepare_restart().is_err());
    }
    #[test]
    fn disabled_never_admits() {
        let mut m = Machine::new(false);
        assert!(m.check().is_err());
        assert!(m.schedule().is_err());
        assert!(m.download().is_err());
    }
    #[test]
    fn no_schedule_before_verification() {
        let (mut m, d) = downloading();
        assert!(m.schedule().is_err());
        m.progress(d, 4, None, 100).unwrap();
        m.verifying(d).unwrap();
        assert!(m.schedule().is_err());
    }
    #[test]
    fn cancellation_invalidates_all_late_results() {
        let (mut m, d) = downloading();
        m.cancel().unwrap();
        assert!(!m.verified(d));
        assert!(!m.fail(d, "late"));
        assert!(!m.progress(d, 3, None, 100).unwrap());
        assert_eq!(m.phase, Phase::Cancelled);
    }
    #[test]
    fn new_check_invalidates_old_candidate() {
        let (mut m, d) = ready();
        m.check().unwrap();
        assert!(!m.verified(d));
        assert!(m.schedule().is_err());
    }
    #[test]
    fn cancellation_after_verify_drops_admission() {
        let (mut m, _) = ready();
        m.cancel().unwrap();
        assert!(m.schedule().is_err());
    }
    #[test]
    fn duplicate_operations_rejected() {
        let (mut m, _) = downloading();
        assert!(m.download().is_err());
        assert!(m.check().is_err());
    }
    #[test]
    fn size_and_length_fail_closed() {
        let (mut m, d) = downloading();
        assert_eq!(
            m.progress(d, 2, Some(101), 100),
            Err("update-download-too-large")
        );
        m.progress(d, 2, Some(4), 100).unwrap();
        assert!(m.progress(d, 1, Some(5), 100).is_err());
        assert!(m.verifying(d).is_err());
    }
    #[test]
    fn scheduling_is_reversible_and_single_flight() {
        let (mut m, _) = ready();
        m.schedule().unwrap();
        assert_eq!(m.phase, Phase::Scheduled);
        assert!(m.schedule().is_err());
        assert!(m.check().is_err());
        m.cancel().unwrap();
        assert_eq!(m.phase, Phase::Cancelled);
    }
    #[test]
    fn scheduled_quit_requires_saved_lsh_exit_and_refusal_keeps_the_schedule_cancellable() {
        let (mut m, _) = ready();
        assert!(!m.requires_saved_lsh_exit());
        m.schedule().unwrap();
        assert!(m.requires_saved_lsh_exit());
        assert!(m.scheduled_quit_blocked("update-lsh-task-active"));
        assert_eq!(m.phase, Phase::Scheduled);
        assert_eq!(m.error, Some("update-lsh-task-active"));
        assert!(m.can_cancel());
        m.cancel().unwrap();
        assert!(!m.requires_saved_lsh_exit());
        assert!(!m.scheduled_quit_blocked("late-old-quit"));
    }

    #[test]
    fn immediate_restart_is_verified_single_flight_and_preserves_a_rejected_attempt() {
        let (mut unverified, _) = downloading();
        assert!(unverified.prepare_restart().is_err());
        let (mut m, _) = ready();
        let attempt = m.prepare_restart().unwrap();
        assert_eq!(m.phase, Phase::Preparing);
        assert!(!m.can_cancel());
        assert!(m.prepare_restart().is_err());
        assert!(m.restart_blocked(attempt, "update-work-active"));
        assert_eq!(m.phase, Phase::Ready);
        assert_eq!(m.error, Some("update-work-active"));
        m.schedule().unwrap();
        let retry = m.prepare_restart().unwrap();
        assert!(!m.restart_blocked(attempt, "stale"));
        assert!(m.restart_blocked(retry, "update-exit-not-safe"));
        assert_eq!(m.phase, Phase::Scheduled);
        m.cancel().unwrap();
        assert_eq!(m.phase, Phase::Cancelled);
    }
}
