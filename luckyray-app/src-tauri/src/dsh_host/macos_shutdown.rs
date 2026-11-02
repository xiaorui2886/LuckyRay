//! Fixed facts from one owned Host shutdown, retained without process handles.
//! A forced sweep may confirm cleanup but never a normal Host shutdown.
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct ShutdownFacts {
    pub write_completed: bool,
    pub acknowledged: bool,
    pub root_exited_before_cleanup: bool,
    pub root_succeeded: bool,
    pub group_settled_before_cleanup: bool,
    pub forced_cleanup: bool,
    pub group_settled_after_cleanup: bool,
    pub root_exited_after_cleanup: bool,
    pub stdout_closed: bool,
    pub stderr_closed: bool,
    pub group_state: &'static str,
}
impl ShutdownFacts {
    pub fn normal(&self) -> bool {
        self.write_completed && self.acknowledged && self.root_exited_before_cleanup
            && self.root_succeeded && self.group_settled_before_cleanup && !self.forced_cleanup
            && self.settled()
    }
    pub fn settled(&self) -> bool {
        self.group_settled_after_cleanup && self.root_exited_after_cleanup
            && self.stdout_closed && self.stderr_closed && self.group_state == "settled"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normal_shutdown_requires_all_facts_and_no_forced_sweep() {
        let clean = ShutdownFacts {
            write_completed: true, acknowledged: true, root_exited_before_cleanup: true,
            root_succeeded: true, group_settled_before_cleanup: true, forced_cleanup: false,
            group_settled_after_cleanup: true, root_exited_after_cleanup: true,
            stdout_closed: true, stderr_closed: true, group_state: "settled",
        };
        assert!(clean.normal());
        let forced = ShutdownFacts { forced_cleanup: true, ..clean };
        assert!(forced.settled());
        assert!(!forced.normal());
        for failure in [
            ShutdownFacts { write_completed: false, ..clean },
            ShutdownFacts { acknowledged: false, ..clean },
            ShutdownFacts { root_exited_before_cleanup: false, ..clean },
            ShutdownFacts { root_succeeded: false, ..clean },
            ShutdownFacts { group_settled_before_cleanup: false, ..clean },
            ShutdownFacts { group_settled_after_cleanup: false, ..clean },
            ShutdownFacts { root_exited_after_cleanup: false, ..clean },
            ShutdownFacts { stdout_closed: false, ..clean },
            ShutdownFacts { stderr_closed: false, ..clean },
            ShutdownFacts { group_state: "member-unavailable", ..clean },
        ] { assert!(!failure.normal()); }
    }
}
