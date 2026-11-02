//! Exit ownership after the irreversible stop boundary. A failed drain cannot
//! release participants or promote a later cleanup into a normal shutdown.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex, MutexGuard,
};

pub(crate) fn reserve_operation<'a>(
    operation: &'a Mutex<()>,
    admission: &'a Mutex<()>,
    closing: &AtomicBool,
) -> Result<(MutexGuard<'a, ()>, MutexGuard<'a, ()>), &'static str> {
    let operation = operation.try_lock().map_err(|_| "update-lsh-preparing")?;
    let admission = admission
        .lock()
        .map_err(|_| "update-lsh-state-unavailable")?;
    if closing.load(Ordering::Acquire) {
        return Err("update-lsh-not-quiescent");
    }
    Ok((operation, admission))
}

pub(crate) trait Participants {
    fn stop_saved_surface(&mut self) -> Result<(), &'static str>;
    /// Separate normal exit from confirmed recovery cleanup.
    fn drain(&mut self) -> (bool, bool);
}
pub(crate) fn acquire<R, H>(
    runs: impl FnOnce() -> Result<R, &'static str>,
    gateway: impl FnOnce() -> Result<(), &'static str>,
    host: impl FnOnce() -> Result<H, &'static str>,
) -> Result<(R, H), &'static str> {
    let runs = runs()?;
    gateway()?;
    Ok((runs, host()?))
}
pub(crate) enum Preparation<P> {
    Ready(P),
    Cancelled(&'static str),
    Retained(P),
}
pub(crate) fn prepare<P>(
    mut participants: P,
    save: impl FnOnce(&mut P) -> Result<(), &'static str>,
    rollback: impl FnOnce(&mut P) -> bool,
) -> Preparation<P> {
    match save(&mut participants) {
        Ok(()) => Preparation::Ready(participants),
        Err(code) if rollback(&mut participants) => Preparation::Cancelled(code),
        Err(_) => Preparation::Retained(participants),
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Completion {
    Normal,
    Recovered,
    Pending(&'static str),
}
pub(crate) struct Committed<P> {
    participants: P,
    pub(crate) restart: bool,
    stop: Option<Result<(), &'static str>>,
    failed: bool,
}
impl<P: Participants> Committed<P> {
    pub(crate) fn new(participants: P, restart: bool) -> Self {
        Self {
            participants,
            restart,
            stop: None,
            failed: false,
        }
    }
    pub(crate) fn advance(&mut self) -> Completion {
        // A stop timeout can mean that disposal already happened. Never send
        // another stop or restore working admission over that uncertain result.
        let stopped = *self
            .stop
            .get_or_insert_with(|| self.participants.stop_saved_surface());
        if stopped.is_err() {
            self.failed = true;
            return Completion::Pending("macos-quit-stop-unconfirmed");
        }
        let (normal, settled) = self.participants.drain();
        self.failed |= !normal || !settled;
        if !settled {
            Completion::Pending("macos-quit-cleanup-pending")
        } else if self.failed {
            Completion::Recovered
        } else {
            Completion::Normal
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;
    struct Services {
        stop: Result<(), &'static str>,
        drain: VecDeque<(bool, bool)>,
        stops: Arc<AtomicUsize>,
        drains: Arc<AtomicUsize>,
        held: Arc<AtomicBool>,
    }
    impl Participants for Services {
        fn stop_saved_surface(&mut self) -> Result<(), &'static str> {
            self.stops.fetch_add(1, Ordering::SeqCst);
            self.stop
        }
        fn drain(&mut self) -> (bool, bool) {
            self.drains.fetch_add(1, Ordering::SeqCst);
            self.drain.pop_front().unwrap()
        }
    }
    impl Drop for Services {
        fn drop(&mut self) {
            self.held.store(false, Ordering::SeqCst);
        }
    }
    fn services(stop: Result<(), &'static str>, drain: VecDeque<(bool, bool)>) -> Services {
        Services {
            stop,
            drain,
            stops: Arc::new(AtomicUsize::new(0)),
            drains: Arc::new(AtomicUsize::new(0)),
            held: Arc::new(AtomicBool::new(true)),
        }
    }
    #[test]
    fn admitted_surface_open_makes_reservation_busy_without_closing_admission() {
        let operation = Mutex::new(());
        let admission = Mutex::new(());
        let closing = AtomicBool::new(false);
        let already_opening = operation.lock().unwrap();
        assert_eq!(
            reserve_operation(&operation, &admission, &closing).err(),
            Some("update-lsh-preparing")
        );
        assert!(!closing.load(Ordering::Acquire));
        drop(already_opening);
        assert!(reserve_operation(&operation, &admission, &closing).is_ok());
    }
    #[test]
    fn new_open_cannot_pass_the_same_operation_and_reserved_admission() {
        let operation = Arc::new(Mutex::new(()));
        let admission = Mutex::new(());
        let closing = Arc::new(AtomicBool::new(false));
        let reserved = reserve_operation(&operation, &admission, &closing).unwrap();
        closing.store(true, Ordering::Release);
        let op = operation.clone();
        let gate = closing.clone();
        let opening = std::thread::spawn(move || {
            let _op = op.lock().unwrap();
            !gate.load(Ordering::Acquire)
        });
        drop(reserved);
        assert!(!opening.join().unwrap());
    }
    #[test]
    fn uncertain_official_stop_retains_ownership_and_never_retries_or_drains() {
        let services = services(Err("update-lsh-control-timeout"), VecDeque::new());
        let held = services.held.clone();
        let stops = services.stops.clone();
        let drains = services.drains.clone();
        let mut quit = Committed::new(services, false);
        for _ in 0..2 {
            assert_eq!(
                quit.advance(),
                Completion::Pending("macos-quit-stop-unconfirmed")
            );
        }
        assert_eq!(stops.load(Ordering::SeqCst), 1);
        assert_eq!(drains.load(Ordering::SeqCst), 0);
        assert!(held.load(Ordering::SeqCst));
    }
    #[test]
    fn retained_cleanup_can_finish_but_cannot_relabel_failure_as_normal() {
        let services = services(Ok(()), VecDeque::from([(false, false), (true, true)]));
        let held = services.held.clone();
        let stops = services.stops.clone();
        let mut quit = Committed::new(services, true);
        assert_eq!(
            quit.advance(),
            Completion::Pending("macos-quit-cleanup-pending")
        );
        assert!(held.load(Ordering::SeqCst));
        assert!(quit.restart);
        assert_eq!(quit.advance(), Completion::Recovered);
        assert!(held.load(Ordering::SeqCst));
        assert_eq!(stops.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn normal_requires_saved_stop_and_the_first_clean_settlement() {
        let mut quit = Committed::new(services(Ok(()), VecDeque::from([(true, true)])), false);
        assert_eq!(quit.advance(), Completion::Normal);
    }
    #[test]
    fn busy_run_ledger_gateway_or_inflight_open_cannot_reach_stop_or_close_services() {
        for failure in ["run", "ledger", "gateway", "host"] {
            let events = Mutex::new(Vec::new());
            let held = Arc::new(AtomicBool::new(false));
            struct Lease(Arc<AtomicBool>);
            impl Drop for Lease {
                fn drop(&mut self) {
                    self.0.store(false, Ordering::SeqCst);
                }
            }
            let result = acquire(
                || {
                    events.lock().unwrap().push("run-admission");
                    if failure == "run" {
                        return Err("update-generation-active");
                    }
                    held.store(true, Ordering::SeqCst);
                    let lease = Lease(held.clone());
                    if failure == "ledger" {
                        return Err("update-generation-active");
                    }
                    Ok(lease)
                },
                || {
                    events.lock().unwrap().push("gateway-preflight");
                    if failure == "gateway" {
                        Err("update-gateway-preparing")
                    } else {
                        Ok(())
                    }
                },
                || -> Result<(), &'static str> {
                    events.lock().unwrap().push("host-reserve");
                    Err("update-lsh-preparing")
                },
            );
            assert!(result.is_err());
            assert!(!held.load(Ordering::SeqCst));
            let expected = if matches!(failure, "run" | "ledger") {
                vec!["run-admission"]
            } else if failure == "gateway" {
                vec!["run-admission", "gateway-preflight"]
            } else {
                vec!["run-admission", "gateway-preflight", "host-reserve"]
            };
            assert_eq!(*events.lock().unwrap(), expected);
        }
    }
    #[test]
    fn real_save_rejection_releases_only_after_confirmed_rollback() {
        for confirmed in [true, false] {
            let services = services(Ok(()), VecDeque::new());
            let held = services.held.clone();
            let stops = services.stops.clone();
            let drains = services.drains.clone();
            let result = prepare(services, |_| Err("update-lsh-save-failed"), |_| confirmed);
            if confirmed {
                assert!(matches!(
                    result,
                    Preparation::Cancelled("update-lsh-save-failed")
                ));
                assert!(!held.load(Ordering::SeqCst));
            } else {
                assert!(matches!(result, Preparation::Retained(_)));
                assert!(held.load(Ordering::SeqCst));
            }
            assert_eq!(stops.load(Ordering::SeqCst), 0);
            assert_eq!(drains.load(Ordering::SeqCst), 0);
        }
    }
}
