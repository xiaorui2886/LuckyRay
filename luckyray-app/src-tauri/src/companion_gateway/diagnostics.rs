//! Request-local, opt-in response diagnostics. Never retain URLs, bodies,
//! credentials, device/scope identifiers, or arbitrary error messages.
//! The gateway serves one request synchronously per OS thread. The guard resets
//! this context on every exit (including unwinding); no authorization is cached.
use std::cell::RefCell;
use std::fmt::Write;
use std::time::{Duration, Instant};

#[derive(Clone, Copy)]
pub(super) enum Stage { Read, Authenticate, Scope, Execute, Commit }
impl Stage {
    fn label(self) -> &'static str {
        match self {
            Self::Read => "request-read", Self::Authenticate => "authenticate",
            Self::Scope => "scope-resolve", Self::Execute => "execute", Self::Commit => "response-commit",
        }
    }
}

#[derive(Clone, Copy)]
pub(super) enum Reason { RateWindow, ControlPending, TransitionBusy, TransitionUnavailable, DatabaseUnavailable, GenerationRetired, PermissionChanged }
impl Reason {
    fn label(self) -> &'static str {
        match self {
            Self::RateWindow => "rate-window", Self::ControlPending => "control-pending",
            Self::TransitionBusy => "transition-busy", Self::TransitionUnavailable => "transition-unavailable",
            Self::DatabaseUnavailable => "database-unavailable", Self::GenerationRetired => "generation-retired",
            Self::PermissionChanged => "permission-changed",
        }
    }
}

struct Context {
    started: Instant,
    enabled: bool,
    request_id: Option<String>,
    stage: Stage,
    reason: Option<Reason>,
    retry_after: Option<u64>,
    scoped_response: bool,
}
thread_local! { static CURRENT: RefCell<Option<Context>> = const { RefCell::new(None) }; }

pub(super) struct RequestGuard(Option<Context>);
pub(super) fn begin() -> RequestGuard {
    RequestGuard(CURRENT.with(|slot| slot.replace(Some(Context {
        started: Instant::now(), enabled: false, request_id: None,
        stage: Stage::Read, reason: None, retry_after: None, scoped_response: false,
    }))))
}
impl Drop for RequestGuard {
    fn drop(&mut self) { CURRENT.with(|slot| { slot.replace(self.0.take()); }); }
}

fn update(f: impl FnOnce(&mut Context)) {
    CURRENT.with(|slot| { if let Some(context) = slot.borrow_mut().as_mut() { f(context); } });
}
fn valid_request_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}
pub(super) fn enable(request_id: Option<&str>) {
    update(|context| {
        context.enabled = true;
        context.request_id = request_id.filter(|value| valid_request_id(value)).map(str::to_owned);
    });
}
pub(super) fn stage(stage: Stage) {
    update(|context| { context.stage = stage; context.reason = None; context.retry_after = None; context.scoped_response = false; });
}
// Set only after the caller's final authenticated scope/permission check. This
// is protocol negotiation evidence, never a replacement for authorization.
pub(super) fn scoped_response(validated: bool) { update(|context| context.scoped_response = validated); }
pub(super) fn reason(reason: Reason) { update(|context| context.reason = Some(reason)); }
pub(super) fn rate_limited(remaining: Duration) {
    // HTTP delta-seconds must round up, not invite a retry before the window ends.
    let seconds = remaining.as_secs().saturating_add(u64::from(remaining.subsec_nanos() != 0)).max(1);
    update(|context| { context.reason = Some(Reason::RateWindow); context.retry_after = Some(seconds); });
}

pub(super) fn response_headers(status: u16) -> String {
    CURRENT.with(|slot| {
        let slot = slot.borrow();
        let Some(context) = slot.as_ref().filter(|context| context.enabled) else { return String::new(); };
        let mut headers = String::with_capacity(256);
        // Opt-in keeps legacy responses stable; only a bounded opaque correlation
        // ID is echoed. Never echo a request URL, scope, body, or error message.
        if let Some(id) = context.request_id.as_ref() {
            let _ = write!(headers, "X-LuckyRay-Request-Id: {id}\r\nX-LuckyRay-Stage: {}\r\nServer-Timing: companion;dur={}\r\n",
                context.stage.label(), context.started.elapsed().as_millis().min(86_400_000));
            if status >= 400 {
                if let Some(reason) = context.reason { let _ = write!(headers, "X-LuckyRay-Reason: {}\r\n", reason.label()); }
            }
        }
        if context.scoped_response && ((200..300).contains(&status) || status == 304) {
            headers.push_str("X-LuckyRay-Scope-Protocol: 1\r\n");
        }
        if status == 429 {
            if let Some(seconds) = context.retry_after { let _ = write!(headers, "Retry-After: {seconds}\r\n"); }
        }
        headers
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_opaque_ids_only() {
        for value in ["", "a/b", "secret.value", "x\r\nInjected: yes", "中文", &"x".repeat(65)] {
            assert!(!valid_request_id(value));
        }
        assert!(valid_request_id("lr-123_ABC")); assert!(valid_request_id(&"x".repeat(64)));
    }
    #[test]
    fn context_is_bounded_and_restored_without_sensitive_payloads() {
        assert_eq!(response_headers(200), "");
        { let _request = begin(); enable(Some("lr-123")); stage(Stage::Commit); reason(Reason::PermissionChanged);
          let headers = response_headers(403);
          assert!(headers.contains("X-LuckyRay-Request-Id: lr-123\r\n"));
          assert!(headers.contains("X-LuckyRay-Stage: response-commit\r\n"));
          assert!(headers.contains("X-LuckyRay-Reason: permission-changed\r\n"));
          assert!(headers.len() < 512);
          assert!(!response_headers(200).contains("Reason:"));
          { let _nested = begin(); enable(Some("invalid/token")); assert_eq!(response_headers(200), ""); }
          assert!(response_headers(200).contains("lr-123"));
        }
        assert_eq!(response_headers(503), "");
    }
    #[test]
    fn rate_window_rounds_up_without_changing_budget() {
        let _request = begin(); enable(None); rate_limited(Duration::from_millis(1001));
        assert_eq!(response_headers(429), "Retry-After: 2\r\n");
        assert_eq!(response_headers(503), "");
        rate_limited(Duration::ZERO); assert_eq!(response_headers(429), "Retry-After: 1\r\n");
    }
    #[test]
    fn threads_do_not_share_request_context() {
        let _request = begin(); enable(Some("first"));
        std::thread::spawn(|| { assert_eq!(response_headers(200), ""); let _request = begin(); enable(Some("second"));
            assert!(response_headers(200).contains("second")); }).join().unwrap();
        assert!(response_headers(200).contains("first"));
    }
    #[test]
    fn scoped_marker_requires_validated_success_and_resets_at_boundary() {
        let _request = begin(); enable(None);
        assert_eq!(response_headers(200), "");
        scoped_response(true);
        for status in [200, 201, 206, 304] { assert_eq!(response_headers(status), "X-LuckyRay-Scope-Protocol: 1\r\n"); }
        for status in [400, 401, 403, 409, 429, 503] { assert_eq!(response_headers(status), ""); }
        stage(Stage::Commit); assert_eq!(response_headers(200), "");
    }
    #[test]
    fn unwind_clears_context() {
        let _ = std::panic::catch_unwind(|| { let _request = begin(); enable(Some("discarded")); panic!("synthetic"); });
        assert_eq!(response_headers(500), "");
    }
}
