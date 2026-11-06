//! Authenticated per-device admission only; never a permission/proof cache.
//! Match raw method/path exactly, just like service dispatch. Unknown shapes
//! (including queries and encoded separators) retain the ordinary/write budget.
use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RequestClass {
    Ordinary,
    Content,
    Discovery,
}

impl RequestClass {
    pub(super) fn classify(method: &str, path: &str, content: bool) -> Self {
        // Preserve the existing content lane, including its existing methods.
        if content {
            return Self::Content;
        }
        if method != "GET" {
            return Self::Ordinary;
        }
        match path {
            "/v1/services" | "/v1/services/libraries" | "/v1/services/knowledge/vaults" => {},
            _ => {
                // A single asset's metadata, not a list, search or snapshot.
                let Some(id) = path.strip_prefix("/v1/services/materials/assets/") else {
                    return Self::Ordinary;
                };
                if matches!(id, "search" | "navigation" | "export") || id.is_empty() || id.len() > 160 || !id.bytes().all(|b|
                    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')) {
                    return Self::Ordinary;
                }
            }
        };
        Self::Discovery
    }
}

pub(super) struct AuthenticatedRequestWindow {
    pub(super) started_at: Instant,
    ordinary: usize,
    content: usize,
    discovery: usize,
}

#[derive(Default)]
pub(super) struct AuthenticatedRequestBudget {
    // One counter set per authenticated paired device, not per route or asset.
    // Pairing already caps active devices (default 16); revoke removes entries.
    // Expired windows are also pruned on admission, including inactive devices.
    pub(super) devices: HashMap<String, AuthenticatedRequestWindow>,
}

impl AuthenticatedRequestBudget {
    pub(super) fn admit(
        &mut self, device_id: &str, base_limit: usize, window: Duration,
        class: RequestClass,
    ) -> Result<(), Duration> {
        self.admit_at(device_id, base_limit, window, class, Instant::now())
    }

    fn admit_at(
        &mut self, device_id: &str, base_limit: usize, duration: Duration,
        class: RequestClass, now: Instant,
    ) -> Result<(), Duration> {
        self.devices.retain(|_, w| now.duration_since(w.started_at) < duration);
        let w = self.devices.entry(device_id.to_owned())
            .or_insert(AuthenticatedRequestWindow {
                started_at: now, ordinary: 0, content: 0, discovery: 0,
            });
        // Existing ordinary/content limits; one unweighted discovery limit.
        // The discovery limit is an initial policy, not measured server capacity.
        let (used, limit) = match class {
            RequestClass::Ordinary => (&mut w.ordinary, base_limit),
            RequestClass::Content => (&mut w.content, base_limit.saturating_mul(20)),
            RequestClass::Discovery => (&mut w.discovery, base_limit.saturating_mul(6)),
        };
        if *used >= limit {
            return Err(duration.saturating_sub(now.duration_since(w.started_at)));
        }
        *used += 1;
        Ok(())
    }

    pub(super) fn remove(&mut self, device_id: &str) {
        self.devices.remove(device_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const WINDOW: Duration = Duration::from_secs(60);
    fn class(method: &str, path: &str) -> RequestClass {
        RequestClass::classify(method, path, false)
    }
    fn admit(b: &mut AuthenticatedRequestBudget, c: RequestClass, now: Instant) -> Result<(), Duration> {
        b.admit_at("device-fixture", 60, WINDOW, c, now)
    }

    #[test]
    fn exact_read_allowlist_does_not_discount_mutations_or_expensive_work() {
        for path in ["/v1/services", "/v1/services/libraries", "/v1/services/knowledge/vaults",
            "/v1/services/materials/assets/asset_1-A"] {
            assert!(matches!(class("GET", path), RequestClass::Discovery));
            for method in ["POST", "PATCH", "DELETE", "PUT", "HEAD", "get"] {
                assert_eq!(class(method, path), RequestClass::Ordinary);
            }
            for suffix in ["?", "?method=GET", "/", "#x", "%2f"] {
                assert_eq!(class("GET", &format!("{path}{suffix}")), RequestClass::Ordinary);
            }
        }
        for path in ["/v1/services/search?q=x", "/v1/services/materials/changes",
            "/v1/services/knowledge/vaults/id/notes", "/v1/services/knowledge/notes/id",
            "/v1/services/ingest/jobs/id", "/v1/services/presentation/open",
            "/v1/services/materials/assets/", "/v1/services/materials/assets/a/b",
            "/v1/services/materials/assets/a%2Fb", "/v1/services/materials/assets/search",
            "/v1/services/materials/assets/navigation", "/v1/services/materials/assets/export", "/v1/services/%6cibraries",
            "/v1/services//libraries", "/v1/services/materials/assets/.."] {
            assert_eq!(class("GET", path), RequestClass::Ordinary, "{path}");
        }
        assert_eq!(class("GET", &format!("/v1/services/materials/assets/{}", "a".repeat(161))), RequestClass::Ordinary);
        assert_eq!(RequestClass::classify("POST", "/v1/content/notes", true), RequestClass::Content);
    }

    #[test]
    fn foreground_32_plus_background_52_with_fresh_probes_fits() {
        let mut b = AuthenticatedRequestBudget::default();
        let now = Instant::now();
        // Conservative synthetic workload, not a claim about measured traffic:
        // EACH independent read reprobes catalog AND libraries, metadata, body.
        // 84 * 3 = 252 discovery requests, plus 84 content requests.
        for _ in 0..84 {
            for path in ["/v1/services", "/v1/services/libraries", "/v1/services/materials/assets/a"] {
                admit(&mut b, class("GET", path), now).unwrap();
            }
            admit(&mut b, RequestClass::Content, now).unwrap();
        }
        for _ in 0..60 { admit(&mut b, RequestClass::Ordinary, now).unwrap(); }
        assert!(admit(&mut b, RequestClass::Ordinary, now).is_err());
        assert_eq!(b.devices.len(), 1);
    }

    #[test]
    fn independent_lane_limits_are_bounded_and_rejections_do_not_spend_other_lanes() {
        let mut b = AuthenticatedRequestBudget::default();
        let now = Instant::now();
        for (lane, max) in [(RequestClass::Discovery, 360),
            (RequestClass::Content, 1200), (RequestClass::Ordinary, 60)] {
            for _ in 0..max { admit(&mut b, lane, now).unwrap(); }
            for _ in 0..100 { assert!(admit(&mut b, lane, now).is_err()); }
        }
        // Each device has its own allowance. No aggregate or reservation needed.
        assert!(b.admit_at("device-other", 60, WINDOW, RequestClass::Ordinary, now).is_ok());
    }

    #[test]
    fn expired_windows_and_revoked_devices_are_removed_without_resetting_active_ones() {
        let mut b = AuthenticatedRequestBudget::default();
        let now = Instant::now();
        b.admit_at("expired", 1, WINDOW, RequestClass::Ordinary, now).unwrap();
        b.admit_at("active", 1, WINDOW, RequestClass::Ordinary, now + WINDOW / 2).unwrap();
        b.admit_at("new", 1, WINDOW, RequestClass::Ordinary, now + WINDOW).unwrap();
        assert!(!b.devices.contains_key("expired"));
        assert_eq!(b.devices.len(), 2);
        assert!(b.admit_at("active", 1, WINDOW, RequestClass::Ordinary, now + WINDOW).is_err());
        b.remove("active");
        assert_eq!(b.devices.len(), 1);
        b.admit_at("new", 1, WINDOW, RequestClass::Ordinary, now + WINDOW * 2).unwrap();
        assert_eq!(b.devices.len(), 1);
    }
}
