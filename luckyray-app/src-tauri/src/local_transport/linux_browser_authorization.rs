//! Linux extension connections require an observed request and a Main decision.
//! Registration is a separate operation and never creates a data-access grant.

use super::{canonical_extension_origin, is_strict_secret, random_hex, AuthState, LocalTransportHandle, PersistedAuth};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant};

const REQUEST_LIFETIME: Duration = Duration::from_secs(300);
const MAX_REQUESTS: usize = 16;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct OriginGrant {
    id: String,
    pub(super) nonce: String,
}

impl std::fmt::Debug for OriginGrant {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("OriginGrant").field("id", &self.id).finish_non_exhaustive()
    }
}

pub(super) fn bootstrap_failure(code: String) -> super::TransportFailure {
    let (status, code, message) = match code.as_str() {
        "extension-connection-approval-required" => (403, "extension-connection-approval-required", "Approve this extension in LuckyRay settings, then retry"),
        "extension-connection-denied" => (403, "extension-connection-denied", "Allow a new request in LuckyRay settings, then retry"),
        "extension-connection-revoked" => (403, "extension-connection-revoked", "Allow a new request in LuckyRay settings, then retry"),
        "extension-connection-requests-full" => (503, "extension-connection-requests-full", "Too many browser connection requests"),
        _ => (503, "auth-state-unavailable", "Authentication is unavailable"),
    };
    super::TransportFailure::new(status, code, message)
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Decision { Pending, Denied, Revoked }

struct Request {
    id: String,
    created: Instant,
    decision: Decision,
}

pub(super) struct RequestBook {
    session: String,
    revision: u64,
    records: BTreeMap<String, Request>,
}

impl Default for RequestBook {
    fn default() -> Self {
        Self { session: random_hex(16), revision: 0, records: BTreeMap::new() }
    }
}

impl RequestBook {
    fn expire(&mut self) {
        let count = self.records.len();
        self.records.retain(|_, request| request.decision != Decision::Pending
            || request.created.elapsed() < REQUEST_LIFETIME);
        if count != self.records.len() { self.revision += 1; }
    }

    pub(super) fn clear(&mut self) {
        self.records.clear();
        self.revision += 1;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    session: String,
    revision: u64,
    pub(crate) extensions: Vec<Extension>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Extension {
    pub(crate) origin: String,
    configured: bool,
    pub(crate) status: &'static str,
    pub(crate) request_id: Option<String>,
    pub(crate) grant_id: Option<String>,
    request_expires_in_seconds: Option<u64>,
}

pub(super) fn validate_grants(record: &PersistedAuth) -> Result<(), String> {
    for (origin, grant) in &record.linux_origin_grants {
        if canonical_extension_origin(origin).as_deref() != Some(origin)
            || !record.approved_origins.contains(origin)
            || !is_strict_secret(&grant.nonce) || grant.id.len() != 32
            || !grant.id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        { return Err("local transport consent record is invalid".into()); }
    }
    Ok(())
}

impl AuthState {
    pub(super) fn require_browser_authorization(&mut self, origin: &str) -> Result<(), String> {
        self.validate_current_credentials()?;
        if self.persisted.approved_origins.contains(origin)
            && self.persisted.linux_origin_grants.contains_key(origin) { return Ok(()); }
        self.browser_requests.expire();
        if !self.browser_requests.records.contains_key(origin) {
            if self.browser_requests.records.len() >= MAX_REQUESTS {
                return Err("extension-connection-requests-full".into());
            }
            self.browser_requests.records.insert(origin.into(), Request {
                id: random_hex(32), created: Instant::now(), decision: Decision::Pending,
            });
            self.browser_requests.revision += 1;
        }
        Err(match self.browser_requests.records[origin].decision {
            Decision::Pending => "extension-connection-approval-required",
            Decision::Denied => "extension-connection-denied",
            Decision::Revoked => "extension-connection-revoked",
        }.into())
    }

    pub(super) fn approve_origin(&mut self, origin: &str) -> Result<(), String> {
        self.validate_current_credentials()?;
        let previous = self.persisted.linux_origin_grants.insert(origin.into(),
            OriginGrant { id: random_hex(16), nonce: random_hex(32) });
        let inserted = self.persisted.approved_origins.insert(origin.into());
        if let Err(error) = self.persist() {
            self.persisted.linux_origin_grants.remove(origin);
            if let Some(previous) = previous { self.persisted.linux_origin_grants.insert(origin.into(), previous); }
            if inserted { self.persisted.approved_origins.remove(origin); }
            return Err(error);
        }
        self.browser_requests.records.remove(origin);
        self.browser_requests.revision += 1;
        Ok(())
    }

    pub(super) fn revoke_origin(&mut self, origin: &str) -> Result<(), String> {
        self.validate_current_credentials()?;
        let previous = self.persisted.linux_origin_grants.remove(origin);
        let removed = self.persisted.approved_origins.remove(origin);
        if previous.is_some() || removed {
            if let Err(error) = self.persist() {
                if let Some(previous) = previous { self.persisted.linux_origin_grants.insert(origin.into(), previous); }
                if removed { self.persisted.approved_origins.insert(origin.into()); }
                return Err(error);
            }
        }
        // A cached extension cannot create another prompt immediately after a
        // denial/revocation. Main must first permit a fresh, separately bound request.
        if self.browser_requests.records.len() < MAX_REQUESTS || self.browser_requests.records.contains_key(origin) {
            self.browser_requests.records.insert(origin.into(), Request {
                id: random_hex(32), created: Instant::now(), decision: Decision::Revoked,
            });
        }
        self.browser_requests.revision += 1;
        Ok(())
    }

    fn browser_snapshot(&mut self, configured: &BTreeSet<String>) -> Result<Snapshot, String> {
        self.validate_current_credentials()?;
        self.browser_requests.expire();
        let origins: BTreeSet<_> = configured.iter().chain(self.persisted.approved_origins.iter())
            .chain(self.browser_requests.records.keys()).cloned().collect();
        let extensions = origins.into_iter().map(|origin| {
            let grant = self.persisted.linux_origin_grants.get(&origin);
            let request = self.browser_requests.records.get(&origin);
            let status = if grant.is_some() { "approved" } else {
                match request.map(|request| request.decision) {
                    Some(Decision::Pending) => "pending", Some(Decision::Denied) => "denied",
                    Some(Decision::Revoked) => "revoked", None => "not-requested",
                }
            };
            Extension { configured: configured.contains(&origin), origin, status,
                request_id: request.map(|r| r.id.clone()), grant_id: grant.map(|g| g.id.clone()),
                request_expires_in_seconds: request.filter(|r| r.decision == Decision::Pending)
                    .map(|r| REQUEST_LIFETIME.saturating_sub(r.created.elapsed()).as_secs()) }
        }).collect();
        Ok(Snapshot { session: self.browser_requests.session.clone(), revision: self.browser_requests.revision, extensions })
    }

    fn decide_browser_request(&mut self, configured: &BTreeSet<String>, id: &str, decision: &str) -> Result<(), String> {
        self.validate_current_credentials()?;
        self.browser_requests.expire();
        let origin = self.browser_requests.records.iter()
            .find(|(_, request)| request.id == id).map(|(origin, _)| origin.clone())
            .ok_or("browser-connection-request-stale")?;
        let state = self.browser_requests.records[&origin].decision;
        match (decision, state) {
            ("approve", Decision::Pending) if configured.contains(&origin) => self.approve_origin(&origin),
            ("reject", Decision::Pending) => {
                self.browser_requests.records.get_mut(&origin).unwrap().decision = Decision::Denied;
                self.browser_requests.revision += 1;
                Ok(())
            }
            ("retry", Decision::Denied | Decision::Revoked) => {
                self.browser_requests.records.remove(&origin);
                self.browser_requests.revision += 1;
                Ok(())
            }
            _ => Err("browser-connection-request-stale".into()),
        }
    }
}

impl LocalTransportHandle {
    pub(crate) fn linux_browser_snapshot(&self) -> Result<Snapshot, String> {
        self.auth.lock().map_err(|_| "local transport credential lock failed")?
            .browser_snapshot(&self.browser_origins)
    }

    pub(crate) fn linux_decide_browser_request(&self, request_id: &str, decision: &str) -> Result<Snapshot, String> {
        let mut state = self.auth.lock().map_err(|_| "local transport credential lock failed")?;
        state.decide_browser_request(&self.browser_origins, request_id, decision)?;
        state.browser_snapshot(&self.browser_origins)
    }

    pub(crate) fn linux_revoke_browser_connection(&self, origin: &str, grant_id: &str) -> Result<Snapshot, String> {
        let mut state = self.auth.lock().map_err(|_| "local transport credential lock failed")?;
        if state.persisted.linux_origin_grants.get(origin).map(|grant| grant.id.as_str()) != Some(grant_id) {
            return Err("browser-connection-grant-stale".into());
        }
        state.revoke_origin(origin)?;
        state.browser_snapshot(&self.browser_origins)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_transport::EDGE_DEV_EXTENSION_ORIGIN as ORIGIN;
    use std::os::unix::fs::PermissionsExt;

    fn state() -> (tempfile::TempDir, AuthState, BTreeSet<String>) {
        let root = tempfile::tempdir().unwrap();
        let state = AuthState::load_or_create(&root.path().join("private")).unwrap();
        (root, state, [ORIGIN.into()].into_iter().collect())
    }

    fn request(state: &mut AuthState, configured: &BTreeSet<String>) -> String {
        assert_eq!(state.require_browser_authorization(ORIGIN).unwrap_err(), "extension-connection-approval-required");
        state.browser_snapshot(configured).unwrap().extensions[0].request_id.clone().unwrap()
    }

    #[test]
    fn linux_browser_consent_requires_a_current_request_and_explicit_decision() {
        let (_root, mut state, configured) = state();
        assert!(state.decide_browser_request(&configured, "invented", "approve").is_err());
        let first = request(&mut state, &configured);
        assert_eq!(request(&mut state, &configured), first);
        assert!(state.extension_credential(ORIGIN).is_err());
        state.decide_browser_request(&configured, &first, "reject").unwrap();
        assert!(state.decide_browser_request(&configured, &first, "approve").is_err());
        assert_eq!(state.require_browser_authorization(ORIGIN).unwrap_err(), "extension-connection-denied");
        state.decide_browser_request(&configured, &first, "retry").unwrap();
        let second = request(&mut state, &configured);
        assert_ne!(first, second);
        assert!(state.decide_browser_request(&configured, &first, "approve").is_err());
        state.decide_browser_request(&configured, &second, "approve").unwrap();
        assert!(state.extension_credential(ORIGIN).is_ok());
    }

    #[test]
    fn linux_browser_consent_expiry_and_restart_invalidate_request_ids() {
        let (root, mut state, configured) = state();
        let old = request(&mut state, &configured);
        state.browser_requests.records.get_mut(ORIGIN).unwrap().created -= REQUEST_LIFETIME;
        assert!(state.decide_browser_request(&configured, &old, "approve").is_err());
        let live = request(&mut state, &configured);
        let mut restarted = AuthState::load_or_create(&root.path().join("private")).unwrap();
        assert!(restarted.decide_browser_request(&configured, &live, "approve").is_err());
        state.decide_browser_request(&configured, &live, "approve").unwrap();
        let token = state.extension_credential(ORIGIN).unwrap();
        let restarted = AuthState::load_or_create(&root.path().join("private")).unwrap();
        assert_eq!(restarted.extension_credential(ORIGIN).unwrap(), token);
    }

    #[test]
    fn linux_browser_consent_reapproval_never_reactivates_old_credentials() {
        let (_root, mut state, configured) = state();
        let id = request(&mut state, &configured);
        state.decide_browser_request(&configured, &id, "approve").unwrap();
        let old = state.extension_credential(ORIGIN).unwrap();
        state.revoke_origin(ORIGIN).unwrap();
        assert!(state.extension_credential(ORIGIN).is_err());
        let revoked = state.browser_snapshot(&configured).unwrap().extensions[0].request_id.clone().unwrap();
        assert!(state.decide_browser_request(&configured, &revoked, "approve").is_err());
        assert_eq!(state.require_browser_authorization(ORIGIN).unwrap_err(), "extension-connection-revoked");
        state.decide_browser_request(&configured, &revoked, "retry").unwrap();
        let fresh = request(&mut state, &configured);
        state.decide_browser_request(&configured, &fresh, "approve").unwrap();
        assert_ne!(state.extension_credential(ORIGIN).unwrap(), old);
        assert_eq!(state.matching_extension_origin(&old).unwrap(), None);
    }

    #[test]
    fn linux_browser_consent_does_not_inherit_legacy_or_unconfigured_approval() {
        let (_root, mut state, configured) = state();
        state.persisted.approved_origins.insert(ORIGIN.into());
        state.persist().unwrap();
        assert!(state.extension_credential(ORIGIN).is_err());
        let id = request(&mut state, &configured);
        assert!(state.decide_browser_request(&BTreeSet::new(), &id, "approve").is_err());
        assert!(state.extension_credential(ORIGIN).is_err());
        state.decide_browser_request(&configured, &id, "approve").unwrap();
        let view = serde_json::to_string(&state.browser_snapshot(&configured).unwrap()).unwrap();
        assert!(!view.contains(&state.persisted.master_secret));
        assert!(!view.contains(&state.persisted.linux_origin_grants[ORIGIN].nonce));
        assert!(!view.contains(&state.extension_credential(ORIGIN).unwrap()));
    }

    #[test]
    fn linux_browser_consent_refuses_changed_credential_metadata_before_approval() {
        let (_root, mut state, configured) = state();
        let id = request(&mut state, &configured);
        let before = std::fs::read(&state.path).unwrap();
        std::fs::set_permissions(&state.path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(state.decide_browser_request(&configured, &id, "approve").is_err());
        assert_eq!(std::fs::read(&state.path).unwrap(), before);
        assert!(state.extension_credential(ORIGIN).is_err());
    }
}
